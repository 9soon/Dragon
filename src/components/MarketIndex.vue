<script setup>
import { computed, ref, watch, onMounted, onBeforeUnmount } from 'vue'
import Sparkline from './Sparkline.vue'
import VolumeBars from './VolumeBars.vue'
import { getTrend } from '../lib/api'
import { fmtMoney, fmtPct, fmtPrice, pctTone } from '../lib/format'

const INDEX_SECID = '1.000001'

const props = defineProps({
  quote: { type: Object, default: null },
  live: { type: Boolean, default: false }
})

const q = computed(() => props.quote || null)
const tone = computed(() => (q.value ? pctTone(q.value.pct) : 'is-flat'))

const priceText = computed(() => (q.value ? fmtPrice(q.value.price) : '--'))
const changeText = computed(() => {
  const v = q.value && q.value.change
  if (v == null || !Number.isFinite(Number(v))) return '--'
  const n = Number(v)
  return `${n > 0 ? '+' : ''}${n.toFixed(2)}`
})
const pctText = computed(() => (q.value ? fmtPct(q.value.pct) : '--'))
const amountText = computed(() =>
  q.value ? fmtMoney(q.value.amount, { sign: false }) : '--'
)

const timeText = computed(() => {
  const at = q.value && q.value.at
  if (!at) return ''
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return ''
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).format(d)
  } catch (e) {
    return ''
  }
})

const breadth = computed(() => {
  const b = trend.value && trend.value.breadth
  let up = b ? Number(b.up) : NaN
  let down = b ? Number(b.down) : NaN
  let flat = b ? Number(b.flat) : NaN
  let scope = '两市'
  if (!Number.isFinite(up) || !Number.isFinite(down) || up + down <= 0) {
    up = q.value ? Number(q.value.upCount) : NaN
    down = q.value ? Number(q.value.downCount) : NaN
    flat = NaN
    scope = '沪市'
  }
  if (!Number.isFinite(up) || !Number.isFinite(down) || up + down <= 0) return null
  const total = up + down
  const flatText = Number.isFinite(flat) ? `、平 ${flat}` : ''
  return {
    up,
    down,
    flat: Number.isFinite(flat) ? flat : null,
    scope,
    title: `${scope === '两市' ? '沪深两市' : '沪市'}涨跌家数：涨 ${up}、跌 ${down}${flatText}`,
    upWidth: Math.min(100, Math.max(0, (up / total) * 100)),
    upShare: Math.round((up / total) * 100)
  }
})

/* ---------- 指数分时 ---------- */
const trend = ref(null)
const trendLoading = ref(false)
const trendError = ref('')
let trendTimer = null
let trendBusy = false
let destroyed = false

const preClose = computed(() => {
  if (trend.value && Number.isFinite(Number(trend.value.preClose))) {
    return Number(trend.value.preClose)
  }
  if (q.value && Number.isFinite(Number(q.value.prevClose))) {
    return Number(q.value.prevClose)
  }
  return null
})

const trendPoints = computed(() => {
  const points = trend.value && trend.value.points
  return Array.isArray(points) ? points.map((p) => p.p) : []
})

const trendVolumes = computed(() => {
  const points = trend.value && trend.value.points
  if (!Array.isArray(points)) return []
  return points.map((p) => ({
    v: p.v,
    up: p.o == null || p.p == null ? true : Number(p.p) >= Number(p.o)
  }))
})

const CHART_WIDTH = 300
const CHART_PAD = 3

const trendAxisTicks = computed(() => {
  const points = trend.value && trend.value.points
  if (!Array.isArray(points) || !points.length) return []
  const n = points.length
  const start = points[0].t || ''
  const end = points[n - 1].t || ''
  const step = (CHART_WIDTH - CHART_PAD * 2) / Math.max(1, n - 1)
  const ticks = []
  if (start) {
    ticks.push({ key: `start:${start}`, t: start, left: 0, align: 'start' })
  }
  /* 午后首分钟可能是 13:01，同样把 13:00 标在午后起点 */
  const noonIndex = points.findIndex((p) => p.t >= '13:00')
  if (noonIndex > 0 && noonIndex < n - 1) {
    const left = ((CHART_PAD + step * noonIndex) / CHART_WIDTH) * 100
    ticks.push({
      key: 'noon',
      t: '13:00',
      left: Math.min(100, Math.max(0, left)),
      align: 'noon'
    })
  }
  if (end && end !== start) {
    ticks.push({ key: `end:${end}`, t: end, left: 100, align: 'end' })
  }
  return ticks
})

const trendLabel = computed(() => {
  const date = trend.value && trend.value.date
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) return `${date.slice(5)} 分时`
  return '当日分时'
})

const volumeCompare = computed(() => {
  const c = trend.value && trend.value.marketCompare
  const ratio = c ? Number(c.ratio) : NaN
  if (!c || !Number.isFinite(ratio)) return null
  const prevAmount = Number(c.prevAmount)
  const todayAmount = Number(c.todayAmount)
  const delta = todayAmount - prevAmount
  return {
    tag: c.tag || (ratio >= 0.05 ? '放量' : ratio <= -0.05 ? '缩量' : '量平'),
    tone: c.tone === 'up' || c.tone === 'down' ? c.tone : ratio >= 0.05 ? 'up' : ratio <= -0.05 ? 'down' : 'flat',
    pct: `${ratio > 0 ? '+' : ''}${(ratio * 100).toFixed(1)}%`,
    todayAmountText: Number.isFinite(todayAmount) ? fmtMoney(todayAmount, { sign: false }) : '--',
    deltaText: Number.isFinite(delta) ? fmtMoney(delta) : '--',
    prevAmountText: Number.isFinite(prevAmount) ? fmtMoney(prevAmount, { sign: false }) : '--',
    prevDate: c.prevDate || '',
    time: c.time || ''
  }
})

const compareTone = computed(() => {
  const tone = volumeCompare.value && volumeCompare.value.tone
  return tone === 'up' ? 'is-up' : tone === 'down' ? 'is-down' : ''
})

const compareTitle = computed(() => {
  const c = trend.value && trend.value.marketCompare
  if (!c) return ''
  const today = fmtMoney(c.todayAmount, { sign: false })
  const prev = fmtMoney(c.prevAmount, { sign: false })
  const delta = fmtMoney(Number(c.todayAmount) - Number(c.prevAmount))
  return `沪深两市今日累计成交额 ${today}，昨日同一时点 ${prev}，差额 ${delta}；±5% 判定放量 / 缩量`
})

const trendTone = computed(() => {
  const pct = q.value ? Number(q.value.pct) : NaN
  if (Number.isFinite(pct)) return pct >= 0 ? 'up' : 'down'
  const last = trend.value && trend.value.last
  if (last != null && preClose.value != null) {
    return Number(last) >= preClose.value ? 'up' : 'down'
  }
  return 'auto'
})

async function loadTrend() {
  if (trendBusy) return
  trendBusy = true
  if (!trendPoints.value.length) trendLoading.value = true
  try {
    const res = await getTrend(INDEX_SECID, { compare: true })
    trend.value = res.data || null
    trendError.value = ''
  } catch (err) {
    trendError.value = err.message || '分时读取失败'
  } finally {
    trendLoading.value = false
    trendBusy = false
  }
}

function scheduleTrend() {
  clearTimeout(trendTimer)
  if (destroyed || document.hidden) return
  trendTimer = setTimeout(() => {
    if (!document.hidden) loadTrend()
    scheduleTrend()
  }, props.live ? 3000 : 30000)
}

function handleVisibility() {
  if (document.hidden) {
    clearTimeout(trendTimer)
    return
  }
  loadTrend()
  scheduleTrend()
}

watch(
  () => props.live,
  () => scheduleTrend()
)

onMounted(() => {
  document.addEventListener('visibilitychange', handleVisibility)
  loadTrend()
  scheduleTrend()
})

onBeforeUnmount(() => {
  destroyed = true
  clearTimeout(trendTimer)
  document.removeEventListener('visibilitychange', handleVisibility)
})
</script>

<template>
  <section class="panel index-strip">
    <div class="index-head">
      <span class="index-seal">沪</span>
      <div class="index-title">
        <b>{{ (q && q.name) || '上证指数' }}</b>
        <small class="index-code">000001.SH</small>
      </div>
      <div class="index-live" :class="{ 'is-idle': !q }">
        <i class="index-dot"></i>
        <span>{{ timeText || '等待行情' }}</span>
      </div>
    </div>

    <div class="index-hero">
      <b class="index-price mono" :class="tone">{{ priceText }}</b>
      <div class="index-change mono" :class="tone">
        <span>{{ changeText }}</span>
        <span>{{ pctText }}</span>
      </div>
      <span class="index-tag">沪市</span>
    </div>

    <div class="index-chart">
      <div class="index-chart-head">
        <span>{{ trendLabel }}</span>
        <span v-if="preClose != null" class="mono">昨收 {{ fmtPrice(preClose) }}</span>
      </div>
      <template v-if="trendPoints.length > 1">
        <Sparkline
          :points="trendPoints"
          :height="58"
          :baseline="preClose"
          :tone="trendTone"
          anchor-baseline
          show-baseline
        />
        <VolumeBars :volumes="trendVolumes" :height="30" class="index-volume" />
      </template>
      <div v-else class="index-chart-empty">
        {{ trendError ? '分时接口暂不可用' : trendLoading ? '分时读取中…' : '暂无分时数据' }}
      </div>
      <div class="index-chart-axis">
        <span
          v-for="tick in trendAxisTicks"
          :key="tick.key"
          class="index-chart-tick"
          :class="`is-${tick.align}`"
          :style="{ left: `${tick.left}%` }"
        >{{ tick.t }}</span>
      </div>
    </div>

    <div class="index-metrics">
      <div class="index-metric">
        <small>今开</small>
        <b>{{ q ? fmtPrice(q.open) : '--' }}</b>
      </div>
      <div class="index-metric">
        <small>最高</small>
        <b class="is-up">{{ q ? fmtPrice(q.high) : '--' }}</b>
      </div>
      <div class="index-metric">
        <small>最低</small>
        <b class="is-down">{{ q ? fmtPrice(q.low) : '--' }}</b>
      </div>
      <div class="index-metric">
        <small>沪成交</small>
        <b>{{ amountText }}</b>
      </div>
    </div>

    <div v-if="volumeCompare" class="index-cmp" :title="compareTitle">
      <div class="index-cmp-main">
        <span class="index-cmp-label">两市成交</span>
        <b>{{ volumeCompare.todayAmountText }}</b>
        <span class="index-cmp-delta" :class="compareTone">
          {{ volumeCompare.tag }} {{ volumeCompare.deltaText }}
        </span>
        <span class="index-cmp-pct">({{ volumeCompare.pct }})</span>
      </div>
      <div class="index-cmp-sub">昨日同期 {{ volumeCompare.prevAmountText }} · 沪深合计</div>
    </div>
    <div v-else-if="trendPoints.length > 1" class="index-cmp index-cmp--empty">
      <div class="index-cmp-main">
        <span class="index-cmp-label">两市成交</span>
        <span class="dim">较昨同期待回传</span>
      </div>
    </div>

    <div v-if="breadth" class="index-breadth" :title="breadth.title">
      <span class="index-breadth-scope">{{ breadth.scope }}</span>
      <span class="is-up">涨 {{ breadth.up }}</span>
      <span class="is-down">跌 {{ breadth.down }}</span>
      <div class="index-bar">
        <i :style="{ width: `${breadth.upWidth}%` }"></i>
      </div>
      <span class="dim">上涨 {{ breadth.upShare }}%</span>
    </div>
    <div v-else class="index-breadth index-breadth--empty">
      <span class="dim">涨跌家数待行情回传</span>
    </div>
  </section>
</template>

<style scoped>
.index-strip {
  padding: 11px 14px 10px;
}

.index-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.index-seal {
  flex: 0 0 auto;
  width: 22px;
  height: 22px;
  display: grid;
  place-items: center;
  border-radius: 7px;
  border: 1px solid var(--gold-line);
  background: var(--gold-soft);
  color: var(--gold);
  font-family: var(--mono);
  font-size: 12px;
  letter-spacing: 0;
}

.index-title {
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 6px;
}

.index-title b {
  font-size: 14px;
  font-weight: 650;
  letter-spacing: 0.04em;
}

.index-code {
  font-family: var(--mono);
  font-size: 10.5px;
  color: var(--dim);
  letter-spacing: 0.06em;
}

.index-live {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 5px;
  font-family: var(--mono);
  font-size: 11px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}

.index-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--up);
  box-shadow: 0 0 7px rgba(255, 84, 96, 0.7);
  animation: indexPulse 1.8s ease-in-out infinite;
}

.index-live.is-idle .index-dot {
  background: var(--dim);
  box-shadow: none;
  animation: none;
}

@keyframes indexPulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.35;
  }
}

.index-hero {
  display: flex;
  align-items: baseline;
  gap: 9px;
  margin-top: 7px;
}

.index-price {
  font-size: 34px;
  font-weight: 600;
  line-height: 1.05;
  letter-spacing: -0.015em;
  color: var(--text);
}

.index-change {
  display: flex;
  align-items: baseline;
  gap: 7px;
  font-size: 13.5px;
  font-weight: 600;
}

.index-tag {
  margin-left: auto;
  align-self: center;
  padding: 2px 6px;
  border-radius: 5px;
  border: 1px solid var(--line);
  background: rgba(255, 255, 255, 0.03);
  color: var(--dim);
  font-size: 10px;
  letter-spacing: 0.08em;
}

.index-chart {
  margin-top: 7px;
}

.index-chart-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 1px;
  font-size: 10.5px;
  letter-spacing: 0.05em;
  color: var(--dim);
}

.index-chart-head .mono {
  font-size: 10.5px;
  color: var(--muted);
}

.index-chart-empty {
  height: 89px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  border: 1px dashed rgba(255, 255, 255, 0.07);
  background: rgba(255, 255, 255, 0.015);
  color: var(--dim);
  font-size: 11px;
  letter-spacing: 0.04em;
}

.index-volume {
  margin-top: 1px;
}

.index-chart-axis {
  position: relative;
  height: 12px;
  margin-top: 1px;
  font-family: var(--mono);
  font-size: 9.5px;
  line-height: 1.1;
  color: var(--dim);
  font-variant-numeric: tabular-nums;
}

.index-chart-tick {
  position: absolute;
  top: 0;
  white-space: nowrap;
}

.index-chart-tick.is-noon {
  transform: translateX(-50%);
  color: var(--muted);
}

.index-chart-tick.is-end {
  transform: translateX(-100%);
}

.index-metrics {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 4px 8px;
  margin-top: 8px;
  padding-top: 7px;
  border-top: 1px dashed rgba(255, 255, 255, 0.06);
}

.index-metric {
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1px;
}

.index-metric small {
  flex: 0 0 auto;
  font-size: 10.5px;
  color: var(--dim);
  letter-spacing: 0.04em;
}

.index-metric b {
  min-width: 0;
  font-family: var(--mono);
  font-size: 12px;
  font-weight: 550;
  color: var(--text-soft);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.index-cmp {
  margin-top: 5px;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.index-cmp-main {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
  white-space: nowrap;
}

.index-cmp-label {
  flex: 0 0 auto;
  color: var(--dim);
  letter-spacing: 0.04em;
}

.index-cmp b {
  font-family: var(--mono);
  font-size: 12px;
  font-weight: 600;
  color: var(--text-soft);
}

.index-cmp-delta {
  font-family: var(--mono);
  font-size: 11.5px;
  font-weight: 600;
  color: var(--muted);
  white-space: nowrap;
}

.index-cmp-pct {
  font-family: var(--mono);
  font-size: 10.5px;
  color: var(--dim);
  white-space: nowrap;
}

.index-cmp-sub {
  margin-top: 1px;
  font-family: var(--mono);
  font-size: 10.5px;
  color: var(--dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.index-cmp--empty {
  font-family: var(--font);
}

.index-breadth {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
  font-family: var(--mono);
  font-size: 11px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}

.index-breadth--empty {
  font-family: var(--font);
}

.index-breadth-scope {
  flex: 0 0 auto;
  padding: 0 3px;
  border: 1px solid rgba(255, 255, 255, 0.09);
  border-radius: 3px;
  font-family: var(--font);
  font-size: 10px;
  line-height: 1.5;
  color: var(--dim);
}

.index-bar {
  flex: 1;
  min-width: 30px;
  height: 3px;
  border-radius: 2px;
  background: rgba(43, 211, 154, 0.34);
  overflow: hidden;
}

.index-bar i {
  display: block;
  height: 100%;
  border-radius: 2px 0 0 2px;
  background: linear-gradient(90deg, rgba(255, 84, 96, 0.8), var(--up));
  transition: width 0.4s ease;
}
</style>