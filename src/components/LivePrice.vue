<script setup>
import { ref, watch, onBeforeUnmount } from 'vue'
import { fmtPct, fmtPrice, pctTone } from '../lib/format'

const props = defineProps({
  price: { type: [Number, String], default: null },
  pct: { type: [Number, String], default: null },
  time: { type: String, default: '' },
  size: { type: String, default: 'md' }
})

const flash = ref('')
let timer = null

watch(
  () => props.price,
  (next, prev) => {
    const a = Number(next)
    const b = Number(prev)
    if (!Number.isFinite(a) || !Number.isFinite(b) || a === b) return
    flash.value = a > b ? 'up' : 'down'
    clearTimeout(timer)
    timer = setTimeout(() => {
      flash.value = ''
    }, 720)
  }
)

onBeforeUnmount(() => clearTimeout(timer))
</script>

<template>
  <div
    class="live-price"
    :class="[`live-price--${size}`, flash && `flash-${flash}`]"
  >
    <span class="live-price__val" :class="pctTone(pct)">{{ fmtPrice(price) }}</span>
    <span class="live-price__pct" :class="pctTone(pct)">{{ fmtPct(pct) }}</span>
    <span v-if="time" class="live-price__time">{{ time }}</span>
  </div>
</template>

<style scoped>
.live-price--lg .live-price__val {
  font-size: 32px;
}

.live-price--sm .live-price__val {
  font-size: 18px;
}

.live-price--sm .live-price__pct {
  font-size: 12px;
}
</style>