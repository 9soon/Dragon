<script setup>
import { computed } from 'vue'

const props = defineProps({
  gate: { type: Object, required: true },
  sentiment: { type: Object, default: null }
})

const mark = computed(() => {
  if (props.gate.key === 'ready') return '待'
  if (props.gate.key === 'defend') return '缓'
  return '空'
})

const dataReady = computed(() => (props.sentiment && props.sentiment.dataGate
  ? props.sentiment.dataGate.readyCount
  : 0))
const candidates = computed(() => (props.sentiment && props.sentiment.dataGate
  ? props.sentiment.dataGate.candidateCount
  : 0))
const score = computed(() => (props.sentiment ? props.sentiment.score : '--'))
</script>

<template>
  <section class="gate" :class="`gate--${gate.key}`" :data-mark="mark">
    <div class="gate-top">
      <div class="gate-main">
        <div class="eyebrow">今日决策 · GATE</div>
        <div class="gate-label">
          {{ gate.label }}
          <small>{{ gate.key === 'ready' ? 'DATA READY' : gate.key === 'defend' ? 'DEFEND' : 'NO MAINLINE' }}</small>
        </div>
        <p class="gate-detail">{{ gate.detail }}</p>
      </div>
      <div class="gate-side">
        <div class="gate-seal">{{ mark }}</div>
        <small>三关定去留</small>
      </div>
    </div>

    <div class="gate-stats">
      <span class="gate-stat">三关通过 <b>{{ dataReady }}</b> 板块</span>
      <span class="gate-stat">主线候选 <b>{{ candidates }}</b></span>
      <span class="gate-stat">情绪 <b>{{ score }}</b></span>
    </div>

    <div v-if="sentiment" class="gate-note">
      情绪分只代表环境温度，不等于主线确认；三关通过 {{ dataReady }} 个，所以今日结论是「{{ gate.label }}」。
    </div>

    <div class="gate-mantra">先定主线，再选个股；无主线，空仓等待。</div>
  </section>
</template>