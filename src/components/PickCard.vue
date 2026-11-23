<script setup>
import { computed } from 'vue'
import ScoreRing from './ScoreRing.vue'
import LivePrice from './LivePrice.vue'
import { fmtMoney } from '../lib/format'
import { sealState } from '../lib/seal'
import { openPick } from '../lib/ui'
import { useCatalysts, catalystType, isCatalystValid } from '../lib/catalysts'

const props = defineProps({
  pick: { type: Object, required: true },
  quote: { type: Object, default: null },
  rank: { type: Number, default: 0 }
})

const ROLE_HINT = {
  dragon: '板块情绪核心 · 高度与封板质量优先',
  mid: '大市值趋势核心 · 看承接与主力',
  catchup: '低位补涨 · 看早封与良性换手',
  vanguard: '首板先锋 · 等二板确认强度'
}

const live = computed(() => {
  const p = props.pick
  const q = props.quote
  return {
    price: q && q.price != null ? q.price : p.price,
    pct: q && q.pct != null ? q.pct : p.pct,
    turnover: q && q.turnover != null ? q.turnover : p.turnover,
    time: q ? q.quoteTime : '',
    mainInflow: q && q.mainInflow != null ? q.mainInflow : p.mainInflow,
    mainPct: q && q.mainPct != null ? q.mainPct : p.mainPct
  }
})

const roleHint = computed(() => ROLE_HINT[props.pick.role] || '')
const tags = computed(() => (props.pick.tags || []).slice(0, 5))
const reasons = computed(() => (props.pick.reasons || []).slice(0, 3))
const risks = computed(() => (props.pick.risks || []).slice(0, 2))
const seal = computed(() => sealState(props.pick, props.quote))
const sealRatio = computed(() => {
  if (seal.value) return seal.value.sealed ? seal.value.ratio : null
  return props.pick.sealRatio || 0
})

const { items } = useCatalysts()
const cat = computed(() => items[props.pick.sectorKey] || null)
const catInfo = computed(() => (cat.value ? catalystType(cat.value.type) : null))
const catValid = computed(() => isCatalystValid(cat.value))
const observation = computed(() => props.pick.observation || !catValid.value)
const footHint = computed(() => {
  if (props.pick.observation) return '未过三关 · 只做跟踪验证，不构成参与依据'
  if (!catValid.value) return '催化待核验 · 先记录逻辑，再谈参与'
  return '三关通过 · 催化已核验 · 仍需自行判断位置与风险'
})
</script>

<template>
  <article
    class="card pick"
    :class="`pick--${pick.role}`"
    @click="openPick(pick)"
  >
    <div class="pick-head">
      <div class="pick-main">
        <div class="pick-badges">
          <span class="role-badge" :class="`role-badge--${pick.role}`">
            {{ pick.roleLabel }}
          </span>
          <span v-if="observation" class="observation-badge">仅观察</span>
          <span v-if="rank === 1" class="chip chip--gold" style="height: 18px">榜首</span>
          <span
            class="chip"
            :class="catValid ? 'chip--green' : cat && cat.type === 'rumor' ? 'chip--red' : 'chip--warn'"
            style="height: 18px"
          >
            {{ catValid ? `催化·${catInfo.short}` : cat && cat.type === 'rumor' ? '传闻排除' : '待催化' }}
          </span>
        </div>
        <div class="pick-name-row">
          <span class="pick-name">{{ pick.name }}</span>
          <span class="pick-code">{{ pick.code }}</span>
        </div>
        <div class="pick-sector">
          {{ pick.sector }} · {{ roleHint }}
        </div>
      </div>
      <div class="pick-score">
        <ScoreRing
          :value="pick.score"
          :size="52"
          :stroke="3.5"
          :tone="observation ? 'gold' : 'auto'"
        />
        <small>{{ observation ? '观察分' : '综合分' }}</small>
      </div>
    </div>

    <div class="pick-quote">
      <LivePrice :price="live.price" :pct="live.pct" :time="live.time" size="lg" />
      <span class="chip chip--dim" style="margin-left: auto">
        {{ pick.lbc > 0 ? `${pick.lbc} 板` : '趋势' }}
      </span>
    </div>

    <div
      v-if="seal"
      class="pick-seal"
      :class="seal.sealed ? 'is-sealed' : 'is-open'"
    >
      <span class="pick-seal-label">{{ seal.sealed ? '涨停封单' : '封单状态' }}</span>
      <b v-if="seal.sealed">{{ fmtMoney(seal.fund, { sign: false }) }}</b>
      <b v-else class="is-down">已开板</b>
      <span v-if="seal.sealed" class="pick-seal-meta">
        占流通 {{ seal.ratio != null ? `${seal.ratio}%` : '--' }} ·
        {{ seal.live ? '实时买一' : '池快照' }}
      </span>
      <span v-else class="pick-seal-meta">实时买一队列已消失</span>
    </div>

    <div v-if="tags.length" class="chip-row pick-tags">
      <span
        v-for="tag in tags"
        :key="tag"
        class="tag"
        :class="tag === '资金抢筹' ? 'tag--hot' : ''"
      >
        {{ tag }}
      </span>
    </div>

    <div v-if="reasons.length" class="pick-reasons">
      <div v-for="(reason, idx) in reasons" :key="idx" class="pick-reason">{{ reason }}</div>
    </div>

    <div v-if="risks.length" class="pick-risks">
      <div v-for="(risk, idx) in risks" :key="idx" class="pick-risk">{{ risk }}</div>
    </div>

    <div class="pick-stats">
      <div class="pick-stat">
        <small>封单 / 流通</small>
        <b>{{ sealRatio ? `${sealRatio}%` : '--' }}</b>
      </div>
      <div class="pick-stat">
        <small>换手</small>
        <b>{{ live.turnover != null ? live.turnover + '%' : '--' }}</b>
      </div>
      <div class="pick-stat">
        <small>主力净流入</small>
        <b :class="live.mainInflow > 0 ? 'is-up' : live.mainInflow < 0 ? 'is-down' : ''">
          {{ fmtMoney(live.mainInflow) }}
        </b>
      </div>
      <div class="pick-stat">
        <small>首封</small>
        <b>{{ pick.firstSealLabel || '--:--' }}</b>
      </div>
    </div>

    <div class="pick-foot">
      <span class="hint">
        {{ footHint }}
      </span>
      <button class="btn btn--sm" @click.stop="openPick(pick)">逻辑与风险 →</button>
    </div>
  </article>
</template>

<style scoped>
.tag--hot {
  border-color: rgba(255, 84, 96, 0.3);
  background: rgba(255, 84, 96, 0.08);
  color: #ffb0b5;
}

.pick-seal {
  display: flex;
  align-items: baseline;
  gap: 7px;
  margin-top: 7px;
  padding: 7px 9px;
  border-radius: 8px;
  border: 1px solid rgba(255, 84, 96, 0.2);
  background: rgba(255, 84, 96, 0.055);
  font-size: 9px;
  color: var(--muted);
}

.pick-seal b {
  font-family: var(--mono);
  font-size: 12.5px;
  font-weight: 600;
  color: var(--up);
  font-variant-numeric: tabular-nums;
}

.pick-seal.is-open {
  border-color: rgba(43, 211, 154, 0.22);
  background: rgba(43, 211, 154, 0.055);
}

.pick-seal.is-open b {
  color: var(--down);
}

.pick-seal-label {
  flex: 0 0 auto;
  letter-spacing: 0.04em;
}

.pick-seal-meta {
  margin-left: auto;
  font-family: var(--mono);
  font-size: 8.5px;
  color: var(--dim);
  white-space: nowrap;
}
</style>