<script setup>
import { computed, onBeforeUnmount, ref } from 'vue'
import BottomSheet from './BottomSheet.vue'
import { fmtNum, fmtPct, pctTone } from '../lib/format'
import { openCatalyst, toast } from '../lib/ui'
import {
  alertState,
  alertStatusText,
  clearAlertHistory,
  closeAlertCenter,
  desktopPermission,
  desktopSupported,
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
  toast('预警记录已清空')
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
        只在竞价 9:20–9:30 检查，3 秒一轮；盘中 / 休市不弹。
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
          <small>竞价 9:20–9:30 出现未涨停强势票时弹窗（预警分 ≥70）</small>
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

    <header class="ac-list-head">
      <span class="section-title">触发记录</span>
      <span class="ac-count">{{ history.length }} 条 · 最新在前</span>
    </header>

    <div v-if="!history.length" class="ac-empty">
      <b>还没有竞价预警</b>
      <p>
        当候选在竞价 9:20–9:30 满足「未涨停」「涨幅 +2% ~ +8%」「基因 ≥65」
        「板块三关通过或板块昨日涨停 ≥5 家」「预警分 ≥70」时才会记录并弹窗。
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
        <li>只在竞价 9:20–9:25（不可撤单）和 9:25–9:30（定稿）检查；盘中封板、已经涨停的票不弹。</li>
        <li>只提醒未涨停、涨幅 +2% ~ +8% 的候选；贴涨停或封死买不进的直接排除。</li>
        <li>同时要求基因 ≥65、板块三关通过或板块昨日涨停 ≥5 家、竞价预警分 ≥70；有成交额数据时还要求 ≥2000 万且 ≥昨日成交 2%。</li>
        <li>预警分 = 基因 50% + 竞价强度 30% + 板块 12% + 昨日涨停池 8%，与竞价榜综合分不是同一口径。</li>
        <li>同一代码每天最多提醒一次；首次连接只汇总一次，之后新达标逐只弹窗。9:15–9:20 试撮不触发。</li>
        <li>纯传闻不提醒；催化未核验或板块三关未过只算观察预警，不解除观察。</li>
        <li>预警不是买入指令；9:25 后看开盘承接，不保证成交。页面需保持打开，桌面通知只是尽力送达。</li>
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