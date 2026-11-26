<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import BottomSheet from './BottomSheet.vue'
import AlertRecommendations from './AlertRecommendations.vue'
import { fmtNum, fmtPct, pctTone } from '../lib/format'
import { openCatalyst, toast } from '../lib/ui'
import {
  alertState,
  alertStatusText,
  clearAlertHistory,
  closeAlertCenter,
  desktopPermission,
  desktopSupported,
  refreshAlertDiagnostics,
  requestDesktopPermission,
  testAlert,
  updateAlertSettings
} from '../lib/alerts'

const props = defineProps({
  open: { type: Boolean, default: false }
})

const emit = defineEmits(['close'])

const clearArmed = ref(false)
let clearTimer = null

const history = computed(() => alertState.history || [])

const stampFmt = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false
})

function stampText(value) {
  if (!value) return ''
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  return stampFmt.format(d)
}

const lastCheckText = computed(() =>
  alertState.lastCheckAt ? stampText(alertState.lastCheckAt) : ''
)

/* 页面没轮询时用服务端留痕补位：午间冻结 / 收盘后仍能解释为什么没弹 */
const savedDiag = computed(() => {
  const d = alertState.diagnostics
  return d && d.funnel ? d : null
})
const savedTime = computed(() => stampText(savedDiag.value && savedDiag.value.updatedAt))
const savedDate = computed(() => {
  const raw = String((savedDiag.value && savedDiag.value.tradeDate) || '')
  return raw.length === 8 ? `${raw.slice(4, 6)}-${raw.slice(6, 8)}` : ''
})
const savedPolls = computed(() => {
  const p = savedDiag.value && savedDiag.value.polls
  if (!p || !p.count) return ''
  return `页面轮询 ${p.count} 次，最近 ${stampText(p.lastAt)}`
})

/* 收盘后优先读当天尾盘留痕；盘中仍以轮询到的实时尾盘榜为准 */
const tailBoard = computed(() => {
  const saved = alertState.diagnosticsTail
  if (saved && saved.mode === 'closed' && saved.status !== 'live') return saved
  return alertState.tail || saved || null
})
const tailVisible = computed(() => {
  const t = tailBoard.value
  if (!t) return false
  return !['before', 'live'].includes(t.status)
})
const tailItems = computed(() => (tailBoard.value && tailBoard.value.items) || [])

watch(
  () => props.open,
  (open) => {
    if (open) refreshAlertDiagnostics()
  },
  { immediate: true }
)

const desktopLabel = computed(() => {
  if (!desktopSupported()) return '浏览器不支持'
  if (desktopPermission() !== 'granted') return '点击授权'
  return alertState.desktop ? '已开启' : '已关闭'
})

function toggle(key) {
  updateAlertSettings({ [key]: !alertState[key] })
}

async function toggleDesktop() {
  if (!desktopSupported()) {
    toast('当前浏览器不支持桌面通知，弹窗仍会在页面内提示', 'warn')
    return
  }
  if (desktopPermission() === 'granted') {
    updateAlertSettings({ desktop: !alertState.desktop })
    return
  }
  const result = await requestDesktopPermission()
  if (result === 'granted') toast('桌面通知已授权，后台标签页也能尽量提醒', 'success')
  else toast('未获得桌面通知授权，仅保留页面内弹窗', 'warn')
}

function runTest() {
  closeAlertCenter()
  testAlert()
}

function armClear() {
  if (!clearArmed.value) {
    clearArmed.value = true
    clearTimeout(clearTimer)
    clearTimer = setTimeout(() => {
      clearArmed.value = false
    }, 4000)
    return
  }
  clearTimeout(clearTimer)
  clearArmed.value = false
  clearAlertHistory()
  toast('预警与推荐记录已清空')
}

onBeforeUnmount(() => clearTimeout(clearTimer))

function verify(item) {
  if (!item || !item.sectorKey) return
  closeAlertCenter()
  setTimeout(() => {
    openCatalyst({
      key: item.sectorKey,
      name: item.sector || item.sectorKey,
      heat: item.sectorHeat != null ? item.sectorHeat : '--',
      todayCount: item.sectorTodayCount != null ? item.sectorTodayCount : '--'
    })
  }, 180)
}
</script>

<template>
  <BottomSheet
    :open="props.open"
    title="实时预警中心"
    :subtitle="alertStatusText"
    @close="emit('close')"
  >
    <div class="ac-status">
      <span class="chip" :class="alertState.enabled ? 'chip--gold' : 'chip--dim'">
        <i class="ac-dot" :class="{ 'is-live': alertState.enabled }"></i>
        {{ alertState.enabled ? '预警开启' : '预警关闭' }}
      </span>
      <span class="ac-status-text">
        竞价 9:20–9:30 与盘中 9:30–15:00 检查；盘中只提醒未封板、还买得进的票。
      </span>
    </div>

    <div v-if="alertState.lastError" class="ac-error">
      最近一次检查失败：{{ alertState.lastError }}
    </div>

    <section class="ac-settings" aria-label="预警设置">
      <button
        class="ac-switch-row"
        role="switch"
        :aria-checked="alertState.enabled"
        @click="toggle('enabled')"
      >
        <span class="switch-copy">
          <b>实时预警</b>
          <small>竞价 9:20–9:30 与盘中 9:30–15:00 出现未封板强势票时弹窗（预警分 ≥70，每轮最多 1 只）</small>
        </span>
        <span class="switch" :class="{ 'is-on': alertState.enabled }"><i></i></span>
      </button>

      <button
        class="ac-switch-row"
        role="switch"
        :aria-checked="alertState.includePending"
        @click="toggle('includePending')"
      >
        <span class="switch-copy">
          <b>未核验催化也提醒</b>
          <small>开启时只标“观察预警”；关闭后只提醒催化已核验的票，板块三关未过仍只观察</small>
        </span>
        <span class="switch" :class="{ 'is-on': alertState.includePending }"><i></i></span>
      </button>

      <button
        class="ac-switch-row"
        role="switch"
        :aria-checked="alertState.desktop"
        @click="toggleDesktop"
      >
        <span class="switch-copy">
          <b>桌面通知</b>
          <small>{{ desktopLabel }} · 页面在后台时尽量提醒，不保证送达</small>
        </span>
        <span class="switch" :class="{ 'is-on': alertState.desktop }"><i></i></span>
      </button>

      <button
        class="ac-switch-row"
        role="switch"
        :aria-checked="alertState.sound"
        @click="toggle('sound')"
      >
        <span class="switch-copy">
          <b>提示音</b>
          <small>新预警到达时响两短声；首次汇总不响</small>
        </span>
        <span class="switch" :class="{ 'is-on': alertState.sound }"><i></i></span>
      </button>
    </section>

    <div class="ac-actions">
      <button class="btn btn--sm" @click="runTest">测试弹窗</button>
      <button class="btn btn--sm" :class="{ 'btn--danger': clearArmed }" @click="armClear">
        {{ clearArmed ? '确认清空？' : '清空记录' }}
      </button>
    </div>

    <AlertRecommendations compact :live="alertState.windowOpen" />

    <section v-if="tailVisible" class="ac-tail">
      <div class="ac-tail-head">
        <span class="section-title">尾盘预期 · 明日观察</span>
        <span class="chip chip--gold">{{ tailBoard.statusLabel }}</span>
        <span class="ac-count">
          {{ tailBoard.window }}
          <template v-if="tailBoard.updatedAt"> · {{ stampText(tailBoard.updatedAt) }}</template>
        </span>
      </div>

      <div v-if="tailItems.length" class="ac-tail-list">
        <article v-for="(t, idx) in tailItems" :key="t.code" class="ac-tail-row">
          <div class="ac-tail-line">
            <b>{{ t.rank || idx + 1 }}. {{ t.name }}</b>
            <span class="mono">{{ t.code }}</span>
            <span class="chip chip--gold">{{ t.score }} 预期分</span>
            <span v-if="t.recommendTime" class="ae-time mono">推荐 {{ t.recommendTime }}</span>
          </div>
          <div class="ac-tail-meta">
            <span class="mono" :class="pctTone(t.pct)">{{ fmtPct(t.pct) }}</span>
            <span>距涨停 {{ fmtPct(t.gapToLimit, { sign: false }) }}</span>
            <span>收盘位置 {{ t.closeStrength == null ? '--' : t.closeStrength + '%' }}</span>
            <span>基因 {{ t.geneScore }}</span>
            <span v-if="t.volRatio != null">量比 {{ fmtNum(t.volRatio, 2) }}</span>
          </div>
          <p class="ac-tail-why">
            {{ t.sector }}<template v-if="t.reasons && t.reasons.length"> · {{ t.reasons[0] }}</template>
          </p>
          <p v-if="t.risks && t.risks.length" class="ac-tail-risk">! {{ t.risks[0] }}</p>
          <p class="ac-tail-plan">
            观察：{{ (t.plan && t.plan[0]) || '竞价不及预期直接放弃' }}
          </p>
        </article>
      </div>

      <div v-else class="ac-funnel-empty">{{ tailBoard.reason }}</div>

      <div
        v-if="!tailItems.length && tailBoard.counts && tailBoard.counts.length"
        class="ac-funnel-counts"
      >
        <span v-for="c in tailBoard.counts" :key="c.reason">{{ c.reason }} {{ c.count }}</span>
      </div>

      <div
        v-if="!tailItems.length && tailBoard.nearMiss && tailBoard.nearMiss.length"
        class="ac-funnel-near"
      >
        <div v-for="n in tailBoard.nearMiss" :key="n.code" class="ac-funnel-row">
          <b>{{ n.name }}</b>
          <span v-if="n.pct != null" class="mono">{{ n.pct > 0 ? '+' : '' }}{{ n.pct }}%</span>
          <span class="mono">预期分 {{ n.score }}</span>
          <em>{{ n.reason }}</em>
        </div>
      </div>

      <p class="ac-tail-note">
        尾盘预期只在 14:30–15:00 计算，最多 3 只；只作明日观察，不是隔夜三强，不进入条件单草稿。
        没有同时满足条件的票就空着，不为凑数放宽。
      </p>
    </section>

    <div
      v-if="alertState.funnel && (alertState.funnel.candidates || alertState.windowOpen)"
      class="ac-funnel"
    >
      <div class="ac-funnel-head">
        <span>
          本轮 {{ alertState.funnel.candidates }} 只强势候选 / 扫描 {{ alertState.funnel.universe }} 只
          <small v-if="lastCheckText">· {{ lastCheckText }}</small>
        </span>
        <span :class="{ 'is-none': !alertState.funnel.board }">
          {{ alertState.funnel.board ? `达标 ${alertState.funnel.board} 只` : '本轮 0 只达标' }}
        </span>
      </div>
      <div v-if="alertState.funnel.counts && alertState.funnel.counts.length" class="ac-funnel-counts">
        <span v-for="c in alertState.funnel.counts" :key="c.reason">
          {{ c.reason }} {{ c.count }}
        </span>
      </div>
      <div v-if="!alertState.funnel.candidates" class="ac-funnel-empty">
        本轮没有进入强势候选的票：可能是涨幅 / 成交不够，或数据源未返回；不会为了凑数放宽条件。
      </div>
      <div
        v-else-if="alertState.funnel.nearMiss && alertState.funnel.nearMiss.length"
        class="ac-funnel-near"
      >
        <div v-for="n in alertState.funnel.nearMiss" :key="n.code" class="ac-funnel-row">
          <b>{{ n.name }}</b>
          <span v-if="n.pct != null" class="mono">{{ n.pct > 0 ? '+' : '' }}{{ n.pct }}%</span>
          <span class="mono">预警分 {{ n.alertScore }}</span>
          <em>{{ n.reason }}</em>
        </div>
      </div>
      <p class="ac-funnel-note">
        漏斗按未封板、距涨停 &gt;0.3 点、涨幅 +2% ~ +8%、基因 ≥65、板块共振、成交额与预警分
        ≥70 逐关检查；空榜也是有效结果。
      </p>
    </div>

    <div v-else-if="savedDiag" class="ac-funnel ac-funnel--saved">
      <div class="ac-funnel-head">
        <span>
          服务端留痕 {{ savedDate }} {{ savedTime }} · {{ savedDiag.funnel.candidates }} 只强势候选
        </span>
        <span :class="{ 'is-none': !savedDiag.funnel.board }">
          {{ savedDiag.funnel.board ? `达标 ${savedDiag.funnel.board} 只` : '0 只达标' }}
        </span>
      </div>
      <div v-if="savedDiag.funnel.counts && savedDiag.funnel.counts.length" class="ac-funnel-counts">
        <span v-for="c in savedDiag.funnel.counts" :key="c.reason">
          {{ c.reason }} {{ c.count }}
        </span>
      </div>
      <div v-if="!savedDiag.funnel.candidates" class="ac-funnel-empty">
        留痕时没有进入强势候选的票：可能是涨幅 / 成交不够，或数据源未返回；不会为了凑数放宽条件。
      </div>
      <div
        v-else-if="savedDiag.funnel.nearMiss && savedDiag.funnel.nearMiss.length"
        class="ac-funnel-near"
      >
        <div v-for="n in savedDiag.funnel.nearMiss" :key="n.code" class="ac-funnel-row">
          <b>{{ n.name }}</b>
          <span v-if="n.pct != null" class="mono">{{ n.pct > 0 ? '+' : '' }}{{ n.pct }}%</span>
          <span class="mono">预警分 {{ n.alertScore }}</span>
          <em>{{ n.reason }}</em>
        </div>
      </div>
      <p class="ac-funnel-note">
        页面当前没有实时轮询（午间冻结、休市或页面未打开），这里展示服务端最后一次留痕。
        <template v-if="savedPolls">{{ savedPolls }}。</template>
        留痕只解释筛选过程，不代表当前价格；下一轮轮询后以实时榜单为准。
      </p>
    </div>

    <header class="ac-list-head">
      <span class="section-title">触发记录</span>
      <span class="ac-count">{{ history.length }} 条 · 最新在前</span>
    </header>

    <div v-if="!history.length" class="ac-empty">
      <b>还没有预警记录</b>
      <p>
        当候选在竞价 9:20–9:30 或盘中 9:30–15:00 满足「未封板」「涨幅 +2% ~ +8%」
        「基因 ≥65」「板块三关通过或板块涨停 ≥5 家」「预警分 ≥70」，且不属于
        「三板组 / 核按钮」高风险时才会记录并弹窗。
        没有合格票就不弹，空仓也是有效决策。
      </p>
    </div>

    <article
      v-for="item in history"
      :key="item.id"
      class="ac-entry"
      :class="{
        'is-actionable': item.actionable,
        'is-test': item.test
      }"
    >
      <div class="ae-top">
        <span class="ae-time mono">{{ item.dateLabel }} {{ item.time }}</span>
        <span
          v-if="item.recommendTime && item.recommendTime !== item.time"
          class="ae-time mono"
        >推荐 {{ item.recommendTime }}</span>
        <span class="chip" :class="item.test ? 'chip--blue' : item.actionable ? 'chip--red' : 'chip--warn'">
          {{ item.test ? '弹窗自检' : item.actionable ? '可执行预警' : '观察预警' }}
        </span>
        <span v-if="item.statusLabel" class="chip chip--dim">{{ item.statusLabel }}</span>
      </div>

      <div class="ae-main">
        <div class="ae-id">
          <div class="ae-name">
            <b>{{ item.name }}</b>
            <span class="mono">{{ item.code }}</span>
          </div>
          <div class="ae-sub">
            <span>{{ item.sector }}</span>
            <i v-if="item.lbc">· 昨 {{ item.lbc }} 板</i>
            <i v-if="item.nodeLabel">· {{ item.nodeLabel }}</i>
          </div>
        </div>
        <div class="ae-score">
          <b>{{ item.score }}</b>
          <small>预警分</small>
        </div>
      </div>

      <div class="ae-meta">
        <span v-if="item.catalyst" class="chip" :class="item.actionable ? 'chip--gold' : 'chip--warn'">
          {{ item.catalyst.label }}
        </span>
        <span v-if="item.pct != null" class="mono" :class="pctTone(item.pct)">
          {{ fmtPct(item.pct) }}
        </span>
        <span v-if="item.gapToLimit != null && !item.sealed" class="mono">
          距涨停 {{ fmtPct(item.gapToLimit, { sign: false }) }}
        </span>
        <span v-if="item.sealRatio != null" class="mono">
          {{ item.windowKey ? '昨封单' : '封单' }} {{ fmtNum(item.sealRatio, 2) }}%
        </span>
        <span v-if="item.firstSealLabel" class="mono">
          {{ item.windowKey ? '昨首封' : '首封' }} {{ item.firstSealLabel }}
        </span>
        <span v-if="item.geneScore != null" class="mono">基因 {{ item.geneScore }}</span>
      </div>

      <div v-if="item.reasons && item.reasons.length" class="ae-lines">
        <p v-for="line in item.reasons.slice(0, 2)" :key="line"><span>·</span>{{ line }}</p>
      </div>
      <div v-if="item.risks && item.risks.length" class="ae-risks">
        <p>! {{ item.risks[0] }}</p>
      </div>

      <div v-if="item.sectorKey && !item.test" class="ae-actions">
        <button class="btn btn--sm btn--ghost" @click="verify(item)">去核验 {{ item.sector }}</button>
      </div>
    </article>

    <section class="ac-rules">
      <h4>触发与去重规则</h4>
      <ul>
        <li>竞价 9:20–9:25（不可撤单）、9:25–9:30（定稿）与盘中 9:30–15:00 检查；已封板、贴涨停、20cm 都不弹。</li>
        <li>只提醒未封板、距涨停 &gt;0.3 个点、涨幅 +2% ~ +8% 的候选；封死买不进或只剩最后一档的直接排除。</li>
        <li>同时要求基因 ≥65、板块三关通过或板块涨停 ≥5 家、预警分 ≥70；竞价还要求竞价额 ≥2000 万且 ≥昨日成交 2%，盘中有量比数据时要求 ≥1.0。</li>
        <li>三板组核按钮高风险直接不提醒：小盘冷门票一字 / T 字缩量加速到 3–4 板、封单极大、无板块主线，常在竞价撤单砸盘；缩量加速的中风险票会降权并标注“防核按钮”。</li>
        <li>推荐榜按预警分从强到弱最多 3 只；每轮最多弹预警分最高的 1 只，不批量轰炸。</li>
        <li>竞价预警分 = 基因 50% + 竞价强度 30% + 板块 12% + 昨日涨停池 8%；盘中预警分 = 基因 45% + 近板强度 25% + 量比 15% + 板块 10% + 昨日涨停池 5%，都与榜单综合分不是同一口径。</li>
        <li>尾盘预期只在 14:30–15:00 计算：今天没涨停、距涨停 &gt;0.5 点、收盘位置 ≥60%、基因 ≥68、板块共振，最多 3 只；只作明日观察，不进入隔夜三强或条件单草稿，每天最多弹一次汇总。</li>
        <li>推荐与预警时间保存在浏览器本地，刷新页面不会清空；清空记录会同时删除当日推荐历史，需要二次确认。</li>
        <li>同一代码每天最多弹一次；首次连接只汇总一次，之后新达标逐只弹窗。9:15–9:20 试撮不触发。</li>
        <li>纯传闻不提醒；催化未核验或板块三关未过只算观察预警，不解除观察。预警不是买入指令，封板后只排队观察。</li>
        <li>页面需保持打开；浏览器后台节流、网络延迟和接口限流会导致漏报，桌面通知只是尽力送达，不是服务器推送。</li>
      </ul>
    </section>
  </BottomSheet>
</template>

<style scoped>
.ac-status {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
  font-size: 11.5px;
}

.ac-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--dim);
  display: inline-block;
  margin-right: 2px;
}

.ac-dot.is-live {
  background: var(--gold);
  box-shadow: 0 0 8px rgba(243, 199, 119, 0.65);
}

.ac-status-text {
  color: var(--dim);
  line-height: 1.5;
}

.ac-error {
  margin-bottom: 10px;
  padding: 7px 9px;
  border-radius: 9px;
  border: 1px solid rgba(255, 111, 97, 0.26);
  background: rgba(255, 111, 97, 0.08);
  color: #ffb4ac;
  font-size: 11.5px;
  line-height: 1.5;
}

.ac-settings {
  display: grid;
  gap: 6px;
}

.ac-switch-row {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 9px 10px;
  border-radius: 11px;
  border: 1px solid var(--line);
  background: rgba(255, 255, 255, 0.025);
  text-align: left;
  transition: 0.18s ease;
}

.ac-switch-row:hover {
  border-color: var(--line-strong);
  background: rgba(255, 255, 255, 0.04);
}

.switch-copy {
  flex: 1;
  min-width: 0;
  display: grid;
  gap: 2px;
}

.switch-copy b {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-soft);
}

.switch-copy small {
  font-size: 10.5px;
  line-height: 1.5;
  color: var(--dim);
}

.switch {
  flex: 0 0 auto;
  width: 36px;
  height: 21px;
  padding: 2px;
  border-radius: 99px;
  border: 1px solid var(--line-strong);
  background: rgba(255, 255, 255, 0.05);
  transition: 0.18s ease;
}

.switch i {
  display: block;
  width: 15px;
  height: 15px;
  border-radius: 50%;
  background: var(--dim);
  transition: 0.18s ease;
}

.switch.is-on {
  border-color: rgba(243, 199, 119, 0.48);
  background: rgba(243, 199, 119, 0.16);
}

.switch.is-on i {
  transform: translateX(15px);
  background: var(--gold);
  box-shadow: 0 0 8px rgba(243, 199, 119, 0.5);
}

.ac-actions {
  display: flex;
  gap: 7px;
  margin: 10px 0 13px;
}

.ac-actions .btn {
  flex: 1;
}

.ac-funnel {
  margin: 10px 0 12px;
  padding: 10px 11px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.025);
}

.ac-funnel-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  font-size: 11px;
  color: var(--muted);
}

.ac-funnel-head .is-none {
  color: var(--warn);
}

.ac-funnel-head small {
  font-size: 9.5px;
  color: var(--dim);
}

.ac-funnel--saved {
  border-style: dashed;
  background: rgba(255, 255, 255, 0.015);
}

.ac-funnel-counts {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: 7px;
}

.ac-funnel-counts span {
  padding: 2px 6px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.045);
  font-size: 10px;
  color: var(--dim);
}

.ac-funnel-near {
  margin-top: 7px;
  border-top: 1px dashed rgba(255, 255, 255, 0.07);
}

.ac-funnel-row {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 5px;
  padding: 6px 0;
  border-top: 1px dashed rgba(255, 255, 255, 0.05);
  font-size: 10.5px;
  color: var(--dim);
}

.ac-funnel-row:first-child {
  border-top: 0;
}

.ac-funnel-row b {
  font-size: 11.5px;
  color: var(--text-soft);
}

.ac-funnel-row em {
  margin-left: auto;
  font-style: normal;
  color: var(--warn);
  text-align: right;
}

.ac-funnel-empty {
  margin-top: 7px;
  font-size: 10.5px;
  line-height: 1.6;
  color: var(--warn);
}

.ac-funnel-note {
  margin: 7px 0 0;
  font-size: 10px;
  line-height: 1.55;
  color: var(--dim);
}

.ac-tail {
  margin: 10px 0 12px;
  padding: 10px 11px;
  border: 1px solid rgba(243, 199, 119, 0.22);
  border-radius: 12px;
  background:
    radial-gradient(100% 120% at 100% 0%, rgba(243, 199, 119, 0.07), transparent 62%),
    rgba(255, 255, 255, 0.022);
}

.ac-tail-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}

.ac-tail-head .section-title {
  font-size: 12.5px;
}

.ac-tail-head .ac-count {
  margin-left: auto;
}

.ac-tail-list {
  margin-top: 7px;
  display: grid;
  gap: 6px;
}

.ac-tail-row {
  padding: 7px 8px;
  border-radius: 9px;
  border: 1px solid var(--line);
  background: rgba(255, 255, 255, 0.025);
}

.ac-tail-line {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px;
}

.ac-tail-line b {
  font-size: 12.5px;
  color: var(--text-soft);
}

.ac-tail-line .mono {
  font-size: 10.5px;
  color: var(--dim);
}

.ac-tail-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 5px 9px;
  margin-top: 4px;
  font-size: 10.5px;
  color: var(--muted);
}

.ac-tail-why {
  margin: 4px 0 0;
  font-size: 10.5px;
  line-height: 1.5;
  color: var(--dim);
}

.ac-tail-risk {
  margin: 3px 0 0;
  padding: 3px 6px;
  border-radius: 6px;
  border: 1px solid rgba(255, 111, 97, 0.18);
  background: rgba(255, 111, 97, 0.05);
  font-size: 10px;
  line-height: 1.5;
  color: #ffb4ac;
}

.ac-tail-plan {
  margin: 4px 0 0;
  font-size: 10.5px;
  line-height: 1.55;
  color: var(--gold);
}

.ac-tail-note {
  margin: 7px 0 0;
  font-size: 10px;
  line-height: 1.55;
  color: var(--dim);
}

.ac-list-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding-top: 11px;
  border-top: 1px solid var(--line);
}

.ac-list-head .section-title {
  font-size: 13px;
}

.ac-count {
  margin-left: auto;
  font-size: 10.5px;
  color: var(--dim);
}

.ac-empty {
  margin-top: 10px;
  padding: 14px 12px;
  border-radius: 12px;
  border: 1px dashed var(--line-strong);
  background: rgba(255, 255, 255, 0.02);
  text-align: center;
}

.ac-empty b {
  font-size: 13px;
  color: var(--text-soft);
}

.ac-empty p {
  margin: 5px auto 0;
  max-width: 300px;
  font-size: 11px;
  line-height: 1.65;
  color: var(--dim);
}

.ac-entry {
  margin-top: 9px;
  padding: 9px 10px;
  border-radius: 12px;
  border: 1px solid var(--line);
  background: rgba(255, 255, 255, 0.022);
}

.ac-entry.is-actionable {
  border-color: rgba(255, 84, 96, 0.28);
  background:
    radial-gradient(100% 100% at 100% 0%, rgba(255, 84, 96, 0.08), transparent 60%),
    rgba(255, 255, 255, 0.022);
}

.ac-entry.is-test {
  border-style: dashed;
  border-color: rgba(102, 169, 255, 0.32);
}

.ae-top {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px;
}

.ae-time {
  font-size: 10.5px;
  color: var(--dim);
  letter-spacing: 0.04em;
}

.ae-main {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-top: 5px;
}

.ae-id {
  flex: 1;
  min-width: 0;
}

.ae-name {
  display: flex;
  align-items: baseline;
  gap: 6px;
  flex-wrap: wrap;
}

.ae-name b {
  font-size: 15.5px;
  color: var(--text);
}

.ae-name .mono {
  font-size: 10.5px;
  color: var(--dim);
}

.ae-sub {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 1px;
  font-size: 10.5px;
  color: var(--muted);
}

.ae-sub i {
  font-style: normal;
  color: var(--dim);
}

.ae-score {
  flex: 0 0 auto;
  display: flex;
  align-items: baseline;
  gap: 2px;
  padding: 1px 7px;
  border-radius: 8px;
  border: 1px solid var(--line-strong);
  background: rgba(255, 255, 255, 0.035);
}

.is-actionable .ae-score {
  border-color: rgba(255, 84, 96, 0.3);
  background: rgba(255, 84, 96, 0.09);
}

.ae-score b {
  font-family: var(--mono);
  font-size: 17px;
  color: #ffd79c;
}

.is-actionable .ae-score b {
  color: #ffb3b8;
}

.ae-score small {
  font-size: 9.5px;
  color: var(--dim);
}

.ae-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 5px 8px;
  margin-top: 6px;
  font-size: 10.5px;
  color: var(--muted);
}

.ae-lines {
  display: grid;
  gap: 1px;
  margin-top: 5px;
}

.ae-lines p {
  display: flex;
  gap: 4px;
  margin: 0;
  font-size: 11px;
  line-height: 1.55;
  color: var(--text-soft);
}

.ae-lines p span {
  color: var(--gold);
}

.ae-risks {
  margin-top: 4px;
  padding: 4px 6px;
  border-radius: 7px;
  border: 1px solid rgba(255, 111, 97, 0.2);
  background: rgba(255, 111, 97, 0.06);
}

.ae-risks p {
  margin: 0;
  font-size: 10.5px;
  line-height: 1.5;
  color: #ffb4ac;
}

.ae-actions {
  margin-top: 6px;
  display: flex;
  justify-content: flex-end;
}

.ac-rules {
  margin-top: 14px;
  padding: 11px 12px;
  border-radius: 12px;
  border: 1px solid var(--line);
  background: rgba(255, 255, 255, 0.02);
}

.ac-rules h4 {
  margin: 0 0 6px;
  font-size: 12.5px;
  letter-spacing: 0.06em;
  color: var(--gold);
}

.ac-rules ul {
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 4px;
}

.ac-rules li {
  position: relative;
  padding-left: 11px;
  font-size: 10.8px;
  line-height: 1.6;
  color: var(--muted);
}

.ac-rules li::before {
  content: "·";
  position: absolute;
  left: 2px;
  color: var(--gold);
}
</style>