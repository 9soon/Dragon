<script setup>
import { computed } from 'vue'

const props = defineProps({
  points: { type: Array, default: () => [] },
  height: { type: Number, default: 42 },
  width: { type: Number, default: 300 },
  tone: { type: String, default: 'auto' },
  baseline: { type: Number, default: null },
  showBaseline: { type: Boolean, default: false },
  anchorBaseline: { type: Boolean, default: false }
})

const gradId = `spark-${Math.random().toString(36).slice(2, 9)}`

const raw = computed(() => {
  return (props.points || [])
    .map((item) => {
      if (item && typeof item === 'object') return Number(item.p ?? item.close)
      return Number(item)
    })
    .filter((n) => Number.isFinite(n))
})

const geometry = computed(() => {
  const list = raw.value
  const w = props.width
  const h = props.height
  const pad = 3
  if (list.length < 2) return null
  const base = props.baseline != null && Number.isFinite(Number(props.baseline))
    ? Number(props.baseline)
    : null
  /* anchorBaseline：把昨收纳入纵轴范围，避免全天在昨收一侧时线条失真 */
  const scale = props.anchorBaseline && base != null ? list.concat(base) : list
  const min = Math.min(...scale)
  const max = Math.max(...scale)
  const span = Math.max(max - min, max * 0.0025, 0.01)
  const pts = list.map((v, i) => ({
    x: (i / (list.length - 1)) * (w - pad * 2) + pad,
    y: h - pad - ((v - min) / span) * (h - pad * 2 - 4) - 2
  }))
  let line = `M ${pts[0].x.toFixed(2)} ${pts[0].y.toFixed(2)}`
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i]
    const p1 = pts[i]
    const p2 = pts[i + 1]
    const p3 = pts[i + 2] || p2
    const c1x = p1.x + (p2.x - p0.x) / 6
    const c1y = p1.y + (p2.y - p0.y) / 6
    const c2x = p2.x - (p3.x - p1.x) / 6
    const c2y = p2.y - (p3.y - p1.y) / 6
    line += ` C ${c1x.toFixed(2)} ${c1y.toFixed(2)}, ${c2x.toFixed(2)} ${c2y.toFixed(
      2
    )}, ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`
  }
  const area = `${line} L ${pts[pts.length - 1].x.toFixed(2)} ${h} L ${pts[0].x.toFixed(
    2
  )} ${h} Z`
  let baselineY = null
  if (base != null) {
    const clamped = Math.max(min, Math.min(max, base))
    baselineY = h - pad - ((clamped - min) / span) * (h - pad * 2 - 4) - 2
  }
  const first = list[0]
  const last = list[list.length - 1]
  return {
    line,
    area,
    baselineY,
    rising: last >= first,
    lastPoint: pts[pts.length - 1]
  }
})

const color = computed(() => {
  if (props.tone === 'gold') return '#f3c777'
  if (props.tone === 'blue') return '#66a9ff'
  if (props.tone === 'up') return '#ff5460'
  if (props.tone === 'down') return '#2bd39a'
  if (!geometry.value) return '#5d6778'
  return geometry.value.rising ? '#ff5460' : '#2bd39a'
})
</script>

<template>
  <div class="spark" :style="{ height: height + 'px' }">
    <svg
      v-if="geometry"
      :viewBox="`0 0 ${width} ${height}`"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient :id="gradId" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" :stop-color="color" stop-opacity="0.24" />
          <stop offset="100%" :stop-color="color" stop-opacity="0" />
        </linearGradient>
      </defs>
      <line
        v-if="showBaseline && geometry.baselineY != null"
        x1="0"
        :y1="geometry.baselineY"
        :x2="width"
        :y2="geometry.baselineY"
        stroke="rgba(255,255,255,.12)"
        stroke-width="1"
        stroke-dasharray="3 4"
      />
      <path :d="geometry.area" :fill="`url(#${gradId})`" />
      <path
        :d="geometry.line"
        fill="none"
        :stroke="color"
        stroke-width="1.5"
        stroke-linecap="round"
        vector-effect="non-scaling-stroke"
      />
      <circle
        :cx="geometry.lastPoint.x"
        :cy="geometry.lastPoint.y"
        r="2.2"
        :fill="color"
      />
    </svg>
    <div v-else class="spark-empty">
      <span></span><span></span><span></span>
    </div>
  </div>
</template>

<style scoped>
.spark {
  width: 100%;
  position: relative;
}

.spark svg {
  display: block;
  width: 100%;
  height: 100%;
  overflow: visible;
}

.spark-empty {
  height: 100%;
  display: flex;
  align-items: center;
  gap: 3px;
  opacity: 0.3;
}

.spark-empty span {
  height: 1px;
  flex: 1;
  background: var(--line-strong);
}
</style>