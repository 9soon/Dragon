<script setup>
import { computed, ref } from 'vue'
import ScoreRing from './ScoreRing.vue'
import { fmtMoney, fmtPct, heatTone } from '../lib/format'
import { openCatalyst } from '../lib/ui'
import { useCatalysts, catalystType, isCatalystValid } from '../lib/catalysts'

const props = defineProps({
  sector: { type: Object, required: true },
  showRank: { type: Boolean, default: true },
  displayRank: { type: Number, default: null },
  strongest: { type: Boolean, default: false }
})

const expanded = ref(false)
const { items } = useCatalysts()

const cat = computed(() => items[props.sector.key] || null)
const catInfo = computed(() => (cat.value ? catalystType(cat.value.type) : null))
const catValid = computed(() => isCatalystValid(cat.value))
const catRumor = computed(() => cat.value && cat.value.type === 'rumor')

const groupLabel = computed(() => {
  if (props.sector.dataReady) return '三关通过'
  if (props.sector.group === 'main') return '主线候选'
  if (props.sector.group === 'new') return '新起题材'
  return '相关度低'
})

const stampClass = computed(() => {
  if (props.sector.dataReady) return 'stamp--ready'
  if (props.sector.group === 'main') return 'stamp--wait'
  return ''
})

const moneyClass = (v) => {
  if (v == null) return 'is-flat'
  return v > 0 ? 'is-up' : v < 0 ? 'is-down' : 'is-flat'
}

const ladder = computed(() => props.sector.ladder || { high: 0, mid: 0, first: 0 })
const leader = computed(() => props.sector.leader || null)

const passedCount = computed(() => {
  if (props.sector.gatesPassed != null) return props.sector.gatesPassed
  return (props.sector.checks || []).filter((c) => c.pass && !c.proxy).length
})
const rankValue = computed(() =>
  props.displayRank != null ? props.displayRank : props.sector.rankToday
)
const rankText = computed(() => (rankValue.value === 1 ? '01' : rankValue.value))

function openVerify() {
  openCatalyst(props.sector)
}
</script>

<template>
  <article
    class="card sector"
    :class="{ 'card--ready': sector.dataReady, 'sector--excluded': catRumor, 'sector--strongest': strongest }"
  >
    <div class="sector-head">
      <div
        v-if="showRank"
        class="sector-rank"
        :class="{ 'sector-rank--top': rankValue === 1, 'sector-rank--strongest': strongest }"
      >
        {{ rankText }}
      </div>
      <div class="sector-names">
        <div class="sector-name">
          {{ sector.name }}
          <span v-if="strongest" class="chip chip--gold strongest-chip">强度第一</span>
          <span class="chip" :class="groupLabel === '三关通过' ? 'chip--gold' : sector.group === 'new' ? 'chip--blue' : 'chip--dim'">
            {{ groupLabel }}
          </span>
        </div>
        <div class="sector-meta">
          <span>今 <b>{{ sector.todayCount }}</b> 家</span>
          <span>·</span>
          <span>昨 <b>{{ sector.prevCount }}</b> 家</span>
          <span>·</span>
          <span>最高 <b>{{ sector.maxBoard }}</b> 板</span>
          <span v-if="sector.boardPct != null" class="dim">· 板块 {{ fmtPct(sector.boardPct) }}</span>
        </div>
        <div class="sector-status">
          <span class="stamp" :class="stampClass">{{ groupLabel }}</span>
          <span class="gate-count" :class="{ 'gate-count--all': passedCount === 3 }">过 {{ passedCount }}/3 关</span>
          <span v-if="sector.rankToday" class="dim">涨停家数 #{{ sector.rankToday }}</span>
          <span v-if="sector.rankPrev < 90" class="dim">/ 昨日 #{{ sector.rankPrev }}</span>
          <button
            class="chip sector-cat"
            :class="catValid ? 'chip--green' : catRumor ? 'chip--red' : cat ? 'chip--warn' : 'chip--dim'"
            @click="openVerify"
          >
            {{ catValid ? `催化·${catInfo.short}` : catRumor ? '传闻排除' : cat ? '暂无催化' : '催化核验' }}
          </button>
        </div>
      </div>
      <div class="sector-heat">
        <ScoreRing
          :value="sector.heat"
          :size="50"
          :stroke="3.5"
          :tone="heatTone(sector.heat) === 'hot' ? 'hot' : 'gold'"
        />
        <small>热度 {{ sector.heat }}</small>
      </div>
    </div>

    <div class="ladder">
      <div class="ladder-seg" :class="{ 'is-on': ladder.high > 0, 'is-zero': !ladder.high }">
        <small>高位</small>
        <b>{{ ladder.high }}</b>
      </div>
      <div class="ladder-seg" :class="{ 'is-on': ladder.mid > 0, 'is-zero': !ladder.mid }">
        <small>二板</small>
        <b>{{ ladder.mid }}</b>
      </div>
      <div class="ladder-seg" :class="{ 'is-on': ladder.first > 0, 'is-zero': !ladder.first }">
        <small>首板</small>
        <b>{{ ladder.first }}</b>
      </div>
    </div>

    <div class="checks">
      <div
        v-for="check in sector.checks"
        :key="check.key"
        class="check"
        :class="{ 'is-pass': check.pass && !check.proxy, 'is-proxy': check.pass && check.proxy }"
      >
        <span class="check-ico">{{ check.pass ? (check.proxy ? '≈' : '✓') : '✕' }}</span>
        <b>{{ check.label }}</b>
        <span v-if="check.proxy" class="chip chip--gold" style="height: 15px; font-size: 10px; padding: 0 4px">近似</span>
        <span class="detail">{{ check.detail }}</span>
      </div>
    </div>

    <div class="money-row">
      <span class="money-item">
        今日 <b :class="moneyClass(sector.money.today)">{{ fmtMoney(sector.money.today) }}</b>
      </span>
      <span class="money-item">
        昨日 <b :class="moneyClass(sector.money.yesterday)">{{ fmtMoney(sector.money.yesterday) }}</b>
      </span>
      <span v-if="sector.money.proxy" class="money-item">
        5日 <b :class="moneyClass(sector.money.fiveDay)">{{ fmtMoney(sector.money.fiveDay) }}</b>
      </span>
      <span v-if="sector.money.proxy" class="money-proxy">两日历史受限 · 近似口径</span>
      <span v-else-if="sector.money.today == null" class="money-proxy">资金接口待恢复</span>
    </div>

    <div v-if="leader" class="leader-row">
      <span class="leader-badge">领涨</span>
      <span class="leader-name">{{ leader.name }}</span>
      <span class="chip chip--red">{{ leader.lbc }}板</span>
      <div class="leader-stats">
        <span>{{ leader.firstSealLabel }} 封</span>
        <span>换手 {{ leader.turnover }}%</span>
        <span>封单 {{ leader.sealRatio }}%</span>
      </div>
    </div>

    <div class="sector-actions">
      <button class="btn btn--sm" :class="catValid ? 'btn--gold' : ''" @click="openVerify">
        {{ catValid ? '已核验催化' : '核验题材催化' }}
      </button>
      <button class="btn btn--sm btn--ghost expand" @click="expanded = !expanded">
        梯队 {{ sector.stocks.length }} 只
        <span :style="{ transform: expanded ? 'rotate(180deg)' : 'none', transition: '.2s' }">▾</span>
      </button>
    </div>

    <div v-if="expanded" class="stock-list">
      <div v-for="stock in sector.stocks" :key="stock.code" class="stock-row">
        <span class="lb" :class="{ 'lb--hot': stock.lbc >= 3 }">{{ stock.lbc }}板</span>
        <span class="nm">{{ stock.name }}</span>
        <span class="cd">{{ stock.code }}</span>
        <span class="st">{{ stock.firstSealLabel }} · {{ stock.turnover }}%</span>
      </div>
      <div class="score-parts dim">
        热度构成 · 家数 {{ sector.scoreParts.count }} / 连续 {{ sector.scoreParts.continuity }} / 梯队
        {{ sector.scoreParts.ladder }} / 资金 {{ sector.scoreParts.money }} / 高度 {{ sector.scoreParts.height }}
      </div>
    </div>

    <div v-if="catRumor" class="sector-excluded-line">
      纯传闻 / 无信源：按口诀直接排除，不进入执行清单
    </div>

    <div v-if="sector.missing.length && !sector.dataReady" class="missing-line">
      未过：{{ sector.missing.join(' · ') }}
    </div>
  </article>
</template>

<style scoped>
.sector--strongest {
  border-color: rgba(243, 199, 119, 0.32);
  background:
    radial-gradient(120% 100% at 100% 0, rgba(243, 199, 119, 0.075), transparent 55%),
    linear-gradient(160deg, rgba(19, 26, 39, 0.92), rgba(9, 13, 20, 0.95));
}

.sector-rank--strongest {
  border-color: var(--gold-line);
  background: var(--gold-soft);
  color: var(--gold);
}

.strongest-chip {
  letter-spacing: 0.08em;
}

.sector-status {
  flex-wrap: wrap;
}

.gate-count {
  flex: 0 0 auto;
  padding: 2px 6px;
  border-radius: 5px;
  border: 1px solid rgba(255, 255, 255, 0.09);
  background: rgba(255, 255, 255, 0.03);
  font-family: var(--mono);
  font-size: 11px;
  color: var(--muted);
}

.gate-count--all {
  border-color: var(--gold-line);
  background: var(--gold-soft);
  color: var(--gold);
}

.missing-line {
  margin-top: 8px;
  padding-top: 7px;
  border-top: 1px dashed rgba(255, 255, 255, 0.06);
  font-size: 11px;
  letter-spacing: 0.03em;
  color: var(--dim);
}

.sector--excluded {
  border-color: rgba(255, 84, 96, 0.18);
}

.sector-excluded-line {
  margin-top: 8px;
  padding: 6px 8px;
  border-radius: 7px;
  border: 1px solid rgba(255, 84, 96, 0.22);
  background: rgba(255, 84, 96, 0.06);
  font-size: 11px;
  line-height: 1.5;
  color: #e0a0a4;
}

.score-parts {
  margin-top: 4px;
  padding: 6px 4px 2px;
  border-top: 1px dashed rgba(255, 255, 255, 0.05);
  font-size: 10.5px;
  line-height: 1.5;
}
</style>