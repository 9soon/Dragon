<script setup>
import { computed } from 'vue'
import ScoreRing from './ScoreRing.vue'
import { fmtPct } from '../lib/format'

const props = defineProps({
  sentiment: { type: Object, required: true }
})

const s = computed(() => props.sentiment)
const phaseTone = computed(() => (s.value.phase && s.value.phase.tone) || 'neutral')
const promotion = computed(() => s.value.promotion && s.value.promotion.overall)
const promotionCore = computed(() => s.value.promotionCore || null)
const premiumText = computed(() => {
  if (s.value.premium && s.value.premium.skip) return '待更新'
  return fmtPct(s.value.premium ? s.value.premium.avg : null)
})
const premiumClass = computed(() => {
  const v = s.value.premium ? s.value.premium.avg : null
  if (v == null) return 'is-flat'
  return v > 0 ? 'is-up' : v < 0 ? 'is-down' : 'is-flat'
})
</script>

<template>
  <section class="panel mood">
    <div class="mood-top">
      <ScoreRing :value="s.score" :size="64" :stroke="4.5" unit="分" tone="auto" />
      <div class="mood-copy">
        <div class="mood-phase" :class="`tone-${phaseTone}`">
          {{ s.phase ? s.phase.label : '情绪读取中' }}
          <span class="chip" :class="s.score >= 55 ? 'chip--gold' : 'chip--dim'">
            {{ s.score >= 72 ? '主升' : s.score >= 55 ? '修复' : s.score >= 40 ? '分歧' : '退潮' }}
          </span>
          <span
            v-if="s.signal"
            class="chip"
            :class="s.signal.attack ? 'chip--red' : s.signal.defense ? 'chip--green' : 'chip--dim'"
          >{{ s.signal.label }}</span>
        </div>
        <p class="mood-desc">{{ s.phase ? s.phase.desc : '正在计算涨停高度、封板质量与赚钱效应。' }}</p>
      </div>
    </div>

    <div class="mood-metrics">
      <div class="mood-metric">
        <small>涨停</small>
        <b class="is-up">{{ s.limitUp }}</b>
      </div>
      <div class="mood-metric">
        <small>炸板率</small>
        <b :class="s.blowRate >= 45 ? 'is-down' : s.blowRate >= 30 ? 'is-flat' : 'is-up'">{{ s.blowRate }}%</b>
      </div>
      <div class="mood-metric">
        <small>最高板</small>
        <b class="is-up">{{ s.maxBoard }}<span class="unit">板</span></b>
      </div>
      <div class="mood-metric">
        <small>昨涨停溢价</small>
        <b :class="premiumClass">{{ premiumText }}</b>
      </div>
    </div>

    <div class="mood-breakdown">
      <div v-for="row in s.breakdown" :key="row.key" class="breakdown-row">
        <span>{{ row.label }} <em class="dim">{{ row.weight }}%</em></span>
        <div class="breakdown-track">
          <div class="breakdown-fill" :style="{ width: `${row.value}%` }"></div>
        </div>
        <b>{{ row.value }}</b>
      </div>
    </div>

    <div class="mood-foot">
      <span v-if="s.signal && s.signal.note" class="dim">{{ s.signal.note }}</span>
      <span v-if="promotionCore && promotionCore.rate != null">
        主板晋级率 <b class="mono">{{ promotionCore.rate }}%</b>
        <span class="dim">（{{ promotionCore.promoted }}/{{ promotionCore.total }}）</span>
      </span>
      <span v-if="promotion && promotion.rate != null">
        <span class="dim">{{ promotionCore ? '全市场' : '整体' }}晋级率</span>
        <b class="mono">{{ promotion.rate }}%</b>
        <span class="dim">（{{ promotion.promoted }}/{{ promotion.total }}）</span>
      </span>
      <span v-else class="dim">晋级率待昨日池更新</span>
      <span v-if="s.premium && s.premium.skip" class="dim">· 昨日表现待今日收盘确认</span>
      <span v-if="s.blown != null" class="dim">· 炸板 {{ s.blown }} 家</span>
    </div>
  </section>
</template>

<style scoped>
.mood-phase.tone-hot {
  color: #ffb1b6;
}

.mood-phase.tone-warm {
  color: #ffe0a6;
}

.mood-phase.tone-neutral {
  color: #c9d6e8;
}

.mood-phase.tone-cold {
  color: #95e5c7;
}

.unit {
  font-size: 11px;
  color: var(--dim);
  margin-left: 1px;
}

.breakdown-row em {
  font-style: normal;
  font-size: 10px;
  margin-left: 2px;
}
</style>