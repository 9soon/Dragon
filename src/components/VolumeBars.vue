<script setup>
import { computed } from 'vue'

const props = defineProps({
  volumes: { type: Array, default: () => [] },
  height: { type: Number, default: 16 },
  width: { type: Number, default: 300 }
})

const bars = computed(() => {
  const list = (props.volumes || []).map((item) => ({
    v: Number(item && item.v),
    up: !!(item && item.up)
  }))
  if (list.length < 2) return []
  const positives = list.map((item) => item.v).filter((v) => Number.isFinite(v) && v > 0)
  if (!positives.length) return []
  const max = Math.max(...positives)
  if (!Number.isFinite(max) || max <= 0) return []
  const pad = 3
  const span = list.length - 1
  const step = (props.width - pad * 2) / span
  /* 分钟点密集时让柱子几乎占满时间槽，避免 1px 细线看不清 */
  const barW = Math.max(0.55, Math.min(3.4, step * 0.96))
  const top = 1
  /* 开盘首分钟量常是平峰的 5~10 倍，线性缩放会把盘中量压成一条线；开方压缩保留大小顺序并让中段可见 */
  const rootMax = Math.sqrt(max)
  const out = []
  list.forEach((item, i) => {
    if (!Number.isFinite(item.v) || item.v <= 0) return
    const h = Math.max(0.8, (Math.sqrt(item.v) / rootMax) * (props.height - top))
    out.push({
      x: pad + step * i - barW / 2,
      y: props.height - h,
      w: barW,
      h,
      up: item.up
    })
  })
  return out
})
</script>

<template>
  <div class="vol" :style="{ height: height + 'px' }">
    <svg
      v-if="bars.length"
      :viewBox="`0 0 ${width} ${height}`"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <rect
        v-for="(bar, i) in bars"
        :key="i"
        :x="bar.x"
        :y="bar.y"
        :width="bar.w"
        :height="bar.h"
        :fill="bar.up ? '#ff5460' : '#2bd39a'"
        :opacity="bar.up ? 0.9 : 0.86"
      />
    </svg>
  </div>
</template>

<style scoped>
.vol {
  width: 100%;
  position: relative;
}

.vol svg {
  display: block;
  width: 100%;
  height: 100%;
  overflow: visible;
}
</style>