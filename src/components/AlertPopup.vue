<script setup>
import { computed, onBeforeUnmount, watch } from 'vue'
import { fmtMoney, fmtPct, fmtPrice, pctTone } from '../lib/format'

const props = defineProps({
  alert: { type: Object, default: null },
  queued: { type: Number, default: 0 }
})

const emit = defineEmits(['close', 'center', 'view', 'catalyst'])

let timer = null

const isSummary = computed(() => !!(props.alert && props.alert.summary))
const isTail = computed(() => !!(props.alert && props.alert.tailSummary))
const actionable = computed(() => !!(props.alert && props.alert.actionable))
const isIntraday = computed(
  () => !!(props.alert && (props.alert.intraday || props.alert.alertMode === 'intraday'))
)
const duration = computed(() => (isSummary.value ? 24000 : 16000))

const kickerText = computed(() => {
  if (!props.alert) return ''
  if (isTail.value) return '尾盘超预期 · 明日观察'
  const mode = isIntraday.value ? '盘中' : '竞价'
  if (isSummary.value) return `${mode}预警 · 本轮汇总`
  if (actionable.value) return `${mode}预警 · ${isIntraday.value ? '可执行' : '可挂单'}`
  return `${mode}预警 · 观察`
})

watch(
  () => (props.alert ? props.alert.id : ''),
  (id) => {
    clearTimeout(timer)
    if (!id) return
    timer = setTimeout(() => emit('close'), duration.value)
  },
  { immediate: true }
)

onBeforeUnmount(() => clearTimeout(timer))

const gapText = computed(() => {
  const a = props.alert
  if (!a) return ''
  if (a.sealed) return '已封板'
  if (a.gapToLimit != null) return fmtPct(a.gapToLimit, { sign: false })
  if (a.limitUp != null) return `涨停 ${fmtPrice(a.limitUp)}`
  return '--'
})

const windowLine = computed(() => {
  const a = props.alert
  if (!a) return ''
  if (a.sealed) return '已封板，无法挂单'
  if (isIntraday.value) {
    return '未封板，盘中仍可挂单；封板、炸板不回封或冲高回落按失效处理'
  }
  if (a.windowKey === 'final') return '竞价已定稿，9:30 后看开盘承接；挂单不保证成交'
  return '未封板，竞价窗口可挂单；成交以 9:25 撮合为准'
})

const footNote = computed(() => {
  const a = props.alert
  if (!a || isSummary.value) return ''
  if (a.test) return '弹窗自检：不对应真实股票，不构成买入信号。'
  if (a.actionable) return '催化已核验且板块三关通过，仍需自行确认信源。'
  if (!a.sectorReady) return '板块三关未过：只观察，不解除观察，不构成买入信号。'
  return '催化尚未核验：只观察，不解除观察，不构成买入信号。'
})

function onView() {
  if (!props.alert) return
  emit('view', props.alert)
}

function onCatalyst() {
  if (!props.alert) return
  emit('catalyst', props.alert)
}
</script>

<template>
  <Teleport to="body">
    <Transition name="alert-pop">
      <section
        v-if="alert"
        class="alert-pop"
        :class="{
          'is-actionable': !isSummary && actionable,
          'is-watch': !isSummary && !actionable,
          'is-summary': isSummary,
          'is-tail': isTail
        }"
        role="status"
        aria-live="polite"
        :aria-label="isSummary ? kickerText : `${isIntraday ? '盘中' : '竞价'}预警 ${alert.name || ''}`"
      >
        <div class="alert-glow" aria-hidden="true"></div>

        <header class="alert-head">
          <span class="alert-kicker">
            <i class="alert-dot"></i>
            {{ kickerText }}
          </span>
          <span class="alert-head-right">
            <span v-if="queued" class="alert-queued">还有 {{ queued }} 条</span>
            <span class="alert-time mono">{{ alert.time }}</span>
            <button class="alert-close" aria-label="关闭预警" @click="emit('close')">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1">
                <path d="M6 6l12 12M18 6L6 18" stroke-linecap="round" />
              </svg>
            </button>
          </span>
        </header>

        <template v-if="isSummary">
          <div class="alert-summary">
            <div class="alert-summary-main">
              <b v-if="isTail">尾盘超预期 {{ alert.names.length }} 只 · 今日均未涨停</b>
              <b v-else>本轮{{ isIntraday ? '盘中' : '竞价' }}预警 {{ alert.names.length }} 只</b>
              <p v-if="isTail">
                14:30 后只筛中低位、今日没涨停、收盘走强且板块有涨停核心的票，最多 3 只；只作明日观察，不是隔夜三强，也不是买入指令。
              </p>
              <p v-else>
                均未{{ isIntraday ? '封板' : '涨停' }}；首次连接只汇总一次，避免一开页就被逐只弹窗淹没，之后新达标的票逐只提醒。
              </p>
            </div>
            <div v-if="isTail" class="alert-summary-count">
              <span class="sum sum--watch">明日观察 {{ alert.pendingCount }}</span>
            </div>
            <div v-else class="alert-summary-count">
              <span class="sum sum--go">可执行 {{ alert.actionableCount }}</span>
              <span class="sum sum--watch">待核验 {{ alert.pendingCount }}</span>
            </div>
          </div>
          <div class="alert-names">
            <span v-for="name in alert.names" :key="name" class="alert-name">{{ name }}</span>
          </div>
          <p v-if="isTail" class="alert-foot-note">
            明日竞价高开 +1% ~ +4%，且同板块至少 1 只涨停核心同步高开，才进入观察；高开 &gt;5% 或低开 &lt;-2% 直接放弃。
            尾盘强不等于明天必高开，也不是隔夜条件单。
          </p>
          <p v-else class="alert-foot-note">
            预警只是条件触发，不是买入指令。均未{{ isIntraday ? '封板' : '涨停' }}；催化未核验或板块三关未过继续按观察处理。
          </p>
          <div class="alert-actions">
            <button class="btn btn--sm btn--gold" @click="emit('center')">打开预警中心</button>
            <button class="btn btn--sm btn--ghost" @click="emit('close')">稍后处理</button>
          </div>
        </template>

        <template v-else>
          <div class="alert-main">
            <div class="alert-id">
              <div class="alert-name-row">
                <b>{{ alert.name }}</b>
                <span class="mono">{{ alert.code }}</span>
                <span class="chip" :class="actionable ? 'chip--red' : 'chip--warn'">
                  {{ alert.statusLabel }}
                </span>
              </div>
              <div class="alert-sub">
                <span>{{ alert.sector }}</span>
                <i v-if="alert.lbc">· 昨 {{ alert.lbc }} 板</i>
                <i v-if="alert.nodeLabel">· {{ alert.nodeLabel }}</i>
                <i v-if="alert.stageLabel">· {{ alert.stageLabel }}</i>
              </div>
            </div>
            <div class="alert-score">
              <b>{{ alert.score }}</b>
              <small>{{ alert.scoreLabel || '预警分' }}</small>
            </div>
          </div>

          <div class="chip-row alert-chips">
            <span v-if="alert.catalyst" class="chip" :class="actionable ? 'chip--gold' : 'chip--warn'">
              {{ alert.catalyst.label }}
            </span>
            <span v-if="alert.geneScore != null" class="chip chip--blue">基因 {{ alert.geneScore }}</span>
            <span v-for="tag in alert.tags" :key="tag" class="tag">{{ tag }}</span>
          </div>

          <div class="alert-quote">
            <div class="aq">
              <small>现价</small>
              <b class="mono">{{ fmtPrice(alert.price) }}</b>
            </div>
            <div class="aq">
              <small>涨幅</small>
              <b class="mono" :class="pctTone(alert.pct)">{{ fmtPct(alert.pct) }}</b>
            </div>
            <div class="aq">
              <small>距涨停</small>
              <b class="mono">{{ gapText }}</b>
            </div>
            <div class="aq">
              <small>{{ isIntraday ? '成交额' : '竞价额' }}</small>
              <b class="mono">{{ fmtMoney(alert.amount, { sign: false }) }}</b>
            </div>
          </div>

          <div class="alert-lines">
            <p v-for="line in alert.reasons.slice(0, 2)" :key="line"><span>·</span>{{ line }}</p>
          </div>
          <div v-if="alert.risks && alert.risks.length" class="alert-risks">
            <p>! {{ alert.risks[0] }}</p>
          </div>
          <p class="alert-gap">
            {{ windowLine }}
            <template v-if="alert.limitUp != null"> · 涨停价 {{ fmtPrice(alert.limitUp) }}</template>
          </p>
          <p class="alert-rec-time mono">
            推荐 {{ alert.recommendTime || alert.time }} · 本次触发 {{ alert.time }}
          </p>

          <p class="alert-foot-note">{{ footNote }}</p>

          <div class="alert-actions">
            <button class="btn btn--sm btn--gold" @click="onView">查看盘面</button>
            <button v-if="alert.sectorKey" class="btn btn--sm" @click="onCatalyst">去核验</button>
            <button class="btn btn--sm btn--ghost" @click="emit('close')">知道了</button>
          </div>
        </template>

        <div
          :key="alert.id"
          class="alert-progress"
          :style="{ animationDuration: `${duration}ms` }"
          aria-hidden="true"
        ></div>
      </section>
    </Transition>
  </Teleport>
</template>

<style scoped>
.alert-pop {
  position: fixed;
  z-index: 85;
  top: calc(env(safe-area-inset-top, 0px) + 10px);
  left: 10px;
  right: 10px;
  max-width: 430px;
  margin: 0 auto;
  padding: 12px 13px 10px;
  border-radius: 16px;
  border: 1px solid rgba(243, 199, 119, 0.4);
  background:
    radial-gradient(120% 130% at 100% 0%, rgba(243, 199, 119, 0.14), transparent 55%),
    linear-gradient(155deg, rgba(25, 22, 17, 0.98), rgba(10, 12, 18, 0.98));
  box-shadow:
    0 22px 54px rgba(0, 0, 0, 0.6),
    0 0 0 1px rgba(243, 199, 119, 0.05) inset;
  overflow: hidden;
}

.alert-pop.is-actionable {
  border-color: rgba(255, 84, 96, 0.55);
  background:
    radial-gradient(120% 130% at 100% 0%, rgba(255, 84, 96, 0.2), transparent 58%),
    linear-gradient(155deg, rgba(32, 18, 22, 0.98), rgba(10, 12, 18, 0.98));
  box-shadow:
    0 22px 54px rgba(0, 0, 0, 0.62),
    0 0 26px rgba(255, 84, 96, 0.16);
}

.alert-pop.is-summary {
  border-color: rgba(102, 169, 255, 0.42);
  background:
    radial-gradient(120% 130% at 100% 0%, rgba(102, 169, 255, 0.16), transparent 58%),
    linear-gradient(155deg, rgba(17, 22, 32, 0.98), rgba(10, 12, 18, 0.98));
}

.alert-pop.is-tail {
  border-color: rgba(243, 199, 119, 0.5);
  background:
    radial-gradient(120% 130% at 100% 0%, rgba(243, 199, 119, 0.16), transparent 58%),
    linear-gradient(155deg, rgba(26, 22, 15, 0.98), rgba(10, 12, 18, 0.98));
}

.alert-glow {
  position: absolute;
  top: -34px;
  right: -24px;
  width: 120px;
  height: 120px;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(243, 199, 119, 0.18), transparent 66%);
  pointer-events: none;
}

.is-actionable .alert-glow {
  background: radial-gradient(circle, rgba(255, 84, 96, 0.24), transparent 66%);
}

.is-summary .alert-glow {
  background: radial-gradient(circle, rgba(102, 169, 255, 0.22), transparent 66%);
}

.alert-head {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 11.5px;
  letter-spacing: 0.08em;
  color: var(--muted);
}

.alert-kicker {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-weight: 650;
  color: #ffe2a9;
}

.is-actionable .alert-kicker {
  color: #ffb3b8;
}

.is-summary .alert-kicker {
  color: #a8ccff;
}

.is-summary.is-tail .alert-kicker {
  color: #ffe2a9;
}

.alert-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--gold);
  box-shadow: 0 0 0 0 rgba(243, 199, 119, 0.5);
  animation: alertPulse 1.4s infinite;
}

.is-actionable .alert-dot {
  background: var(--up);
  box-shadow: 0 0 0 0 rgba(255, 84, 96, 0.55);
  animation: alertPulseRed 1.2s infinite;
}

.is-summary .alert-dot {
  background: var(--blue);
  box-shadow: 0 0 0 0 rgba(102, 169, 255, 0.5);
}

.is-summary.is-tail .alert-dot {
  background: var(--gold);
  box-shadow: 0 0 0 0 rgba(243, 199, 119, 0.5);
}

@keyframes alertPulse {
  0% {
    box-shadow: 0 0 0 0 rgba(243, 199, 119, 0.45);
  }
  70% {
    box-shadow: 0 0 0 6px rgba(243, 199, 119, 0);
  }
  100% {
    box-shadow: 0 0 0 0 rgba(243, 199, 119, 0);
  }
}

@keyframes alertPulseRed {
  0% {
    box-shadow: 0 0 0 0 rgba(255, 84, 96, 0.5);
  }
  70% {
    box-shadow: 0 0 0 6px rgba(255, 84, 96, 0);
  }
  100% {
    box-shadow: 0 0 0 0 rgba(255, 84, 96, 0);
  }
}

.alert-head-right {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  flex: 0 0 auto;
}

.alert-queued {
  padding: 0 6px;
  border-radius: 99px;
  border: 1px solid var(--line-strong);
  background: rgba(255, 255, 255, 0.05);
  font-size: 10.5px;
  line-height: 16px;
  color: var(--text-soft);
  letter-spacing: 0.02em;
}

.alert-time {
  font-size: 11px;
  color: var(--dim);
  letter-spacing: 0.04em;
}

.alert-close {
  width: 22px;
  height: 22px;
  display: grid;
  place-items: center;
  border-radius: 7px;
  color: var(--muted);
  border: 1px solid transparent;
  transition: 0.18s ease;
}

.alert-close:hover {
  color: var(--text);
  border-color: var(--line-strong);
  background: rgba(255, 255, 255, 0.05);
}

.alert-main {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin-top: 7px;
}

.alert-id {
  min-width: 0;
  flex: 1;
}

.alert-name-row {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
}

.alert-name-row b {
  font-size: 19px;
  line-height: 1.25;
  letter-spacing: 0.02em;
  color: var(--text);
}

.alert-name-row .mono {
  font-size: 11.5px;
  color: var(--dim);
  letter-spacing: 0.04em;
}

.alert-sub {
  margin-top: 3px;
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  font-size: 11.5px;
  color: var(--muted);
}

.alert-sub i {
  font-style: normal;
  color: var(--dim);
}

.alert-score {
  flex: 0 0 auto;
  display: grid;
  justify-items: center;
  min-width: 54px;
  padding: 3px 8px 4px;
  border-radius: 11px;
  border: 1px solid rgba(243, 199, 119, 0.3);
  background: rgba(243, 199, 119, 0.08);
}

.is-actionable .alert-score {
  border-color: rgba(255, 84, 96, 0.36);
  background: rgba(255, 84, 96, 0.11);
}

.alert-score b {
  font-family: var(--mono);
  font-size: 24px;
  line-height: 1.1;
  color: #ffe2a9;
  font-variant-numeric: tabular-nums;
}

.is-actionable .alert-score b {
  color: #ffb3b8;
}

.alert-score small {
  font-size: 10px;
  letter-spacing: 0.1em;
  color: var(--muted);
}

.alert-chips {
  position: relative;
  z-index: 1;
  margin-top: 8px;
  gap: 5px;
}

.alert-quote {
  position: relative;
  z-index: 1;
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 6px;
  margin-top: 9px;
  padding: 7px 8px;
  border-radius: 10px;
  border: 1px solid var(--line);
  background: rgba(255, 255, 255, 0.025);
}

.aq {
  min-width: 0;
  display: grid;
  gap: 1px;
}

.aq small {
  font-size: 10px;
  letter-spacing: 0.05em;
  color: var(--dim);
  white-space: nowrap;
}

.aq b {
  font-size: 12.5px;
  font-weight: 600;
  line-height: 1.35;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.alert-lines {
  position: relative;
  z-index: 1;
  margin-top: 8px;
  display: grid;
  gap: 2px;
}

.alert-lines p {
  display: flex;
  gap: 5px;
  margin: 0;
  font-size: 12px;
  line-height: 1.55;
  color: var(--text-soft);
}

.alert-lines p span {
  color: var(--gold);
  flex: 0 0 auto;
}

.alert-risks {
  position: relative;
  z-index: 1;
  margin-top: 5px;
  padding: 5px 7px;
  border-radius: 8px;
  border: 1px solid rgba(255, 111, 97, 0.22);
  background: rgba(255, 111, 97, 0.07);
}

.alert-risks p {
  margin: 0;
  font-size: 11.5px;
  line-height: 1.5;
  color: #ffb4ac;
}

.alert-gap {
  position: relative;
  z-index: 1;
  margin: 6px 0 0;
  font-size: 11px;
  color: var(--dim);
  letter-spacing: 0.03em;
}

.alert-rec-time {
  position: relative;
  z-index: 1;
  margin: 3px 0 0;
  font-size: 10px;
  color: var(--muted);
  letter-spacing: 0.03em;
}

.alert-foot-note {
  position: relative;
  z-index: 1;
  margin: 7px 0 0;
  font-size: 10.5px;
  line-height: 1.5;
  color: var(--dim);
}

.alert-actions {
  position: relative;
  z-index: 1;
  display: flex;
  gap: 7px;
  margin-top: 9px;
  padding-bottom: 2px;
}

.alert-actions .btn {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
}

.alert-summary {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin-top: 8px;
}

.alert-summary-main {
  flex: 1;
  min-width: 0;
}

.alert-summary-main b {
  font-size: 16px;
  line-height: 1.4;
  color: var(--text);
}

.alert-summary-main p {
  margin: 3px 0 0;
  font-size: 11.5px;
  line-height: 1.55;
  color: var(--muted);
}

.alert-summary-count {
  flex: 0 0 auto;
  display: grid;
  gap: 4px;
}

.sum {
  padding: 2px 7px;
  border-radius: 99px;
  font-size: 10.5px;
  letter-spacing: 0.03em;
  text-align: center;
  border: 1px solid var(--line-strong);
  white-space: nowrap;
}

.sum--go {
  color: #ffc2c6;
  border-color: rgba(255, 84, 96, 0.3);
  background: rgba(255, 84, 96, 0.1);
}

.sum--watch {
  color: #ffd79c;
  border-color: rgba(243, 199, 119, 0.3);
  background: rgba(243, 199, 119, 0.08);
}

.alert-names {
  position: relative;
  z-index: 1;
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: 8px;
}

.alert-name {
  padding: 1px 7px;
  border-radius: 7px;
  border: 1px solid var(--line);
  background: rgba(255, 255, 255, 0.035);
  font-size: 11.5px;
  color: var(--text-soft);
}

.alert-progress {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 2px;
  transform-origin: left center;
  background: linear-gradient(90deg, rgba(243, 199, 119, 0.75), rgba(255, 84, 96, 0.7));
  animation: alertProgress linear forwards;
}

.is-summary .alert-progress {
  background: linear-gradient(90deg, rgba(102, 169, 255, 0.8), rgba(102, 169, 255, 0.35));
}

@keyframes alertProgress {
  from {
    transform: scaleX(1);
  }
  to {
    transform: scaleX(0);
  }
}

.alert-pop-enter-active,
.alert-pop-leave-active {
  transition:
    opacity 0.22s ease,
    transform 0.26s cubic-bezier(0.2, 0.9, 0.3, 1.1);
}

.alert-pop-enter-from,
.alert-pop-leave-to {
  opacity: 0;
  transform: translateY(-16px) scale(0.985);
}

@media (max-width: 360px) {
  .alert-name-row b {
    font-size: 17.5px;
  }

  .alert-quote {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    row-gap: 5px;
  }

  .alert-actions .btn {
    padding: 0 8px;
    font-size: 12px;
  }
}
</style>