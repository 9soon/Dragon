<script setup>
import { computed } from 'vue'

const props = defineProps({
  value: { type: Number, default: 0 },
  size: { type: Number, default: 54 },
  stroke: { type: Number, default: 4 },
  tone: { type: String, default: 'auto' },
  unit: { type: String, default: '' },
  caption: { type: String, default: '' }
})

const safe = computed(() => Math.max(0, Math.min(100, Number(props.value) || 0)))
const radius = computed(() => (props.size - props.stroke) / 2)
const circumference = computed(() => 2 * Math.PI * radius.value)
const dash = computed(() => `${(safe.value / 100) * circumference.value} ${circumference.value}`)

const color = computed(() => {
  if (props.tone === 'gold') return '#f3c777'
  if (props.tone === 'hot') return '#ff6a5e'
  if (props.tone === 'cool') return '#66a9ff'
  if (safe.value >= 78) return '#ff6a5e'
  if (safe.value >= 58) return '#f3c777'
  if (safe.value >= 38) return '#66a9ff'
  return '#6b7688'
})
</script>

<template>
  <div class="score-ring" :style="{ width: size + 'px', height: size + 'px' }">
    <svg :width="size" :height="size" :viewBox="`0 0 ${size} ${size}`" aria-hidden="true">
      <circle
        :cx="size / 2"
        :cy="size / 2"
        :r="radius"
        fill="none"
        stroke="rgba(255,255,255,.075)"
        :stroke-width="stroke"
      />
      <circle
        :cx="size / 2"
        :cy="size / 2"
        :r="radius"
        fill="none"
        :stroke="color"
        :stroke-width="stroke"
        stroke-linecap="round"
        :stroke-dasharray="dash"
        :transform="`rotate(-90 ${size / 2} ${size / 2})`"
        :style="{ filter: `drop-shadow(0 0 5px ${color}55)` }"
      />
    </svg>
    <div class="score-ring__inner">
      <b :style="{ color }">{{ Math.round(safe) }}</b>
      <small v-if="unit">{{ unit }}</small>
    </div>
    <span v-if="caption" class="score-ring__caption">{{ caption }}</span>
  </div>
</template>

<style scoped>
.score-ring {
  position: relative;
  display: inline-grid;
  place-items: center;
  flex: 0 0 auto;
}

.score-ring svg {
  position: absolute;
  inset: 0;
}

.score-ring__inner {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: baseline;
  gap: 1px;
}

.score-ring__inner b {
  font-family: var(--mono);
  font-size: 16.5px;
  font-weight: 650;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}

.score-ring__inner small {
  font-size: 9px;
  color: var(--dim);
}

.score-ring__caption {
  position: absolute;
  bottom: -12px;
  font-size: 10px;
  letter-spacing: 0.08em;
  color: var(--dim);
  white-space: nowrap;
}
</style>