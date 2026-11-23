<script setup>
import { computed, ref } from 'vue'
import GateBanner from '../components/GateBanner.vue'
import MarketIndex from '../components/MarketIndex.vue'
import MarketMood from '../components/MarketMood.vue'
import SectorCard from '../components/SectorCard.vue'
import { useCatalysts } from '../lib/catalysts'

const props = defineProps({
  dashboard: { type: Object, required: true },
  indexQuote: { type: Object, default: null }
})

const sectors = computed(() => props.dashboard.sectors || {})
const marketIndex = computed(
  () => props.indexQuote || (props.dashboard.indices && props.dashboard.indices[0]) || null
)
const mainCandidates = computed(() => sectors.value.mainCandidates || [])
const newThemes = computed(() => sectors.value.newThemes || [])
const fading = computed(() => sectors.value.fading || [])
const counts = computed(() => sectors.value.counts || {})
const { verifiedCount } = useCatalysts()

const showRest = ref(false)
const showThemes = ref(false)

function strengthOf(sector) {
  if (sector.gatesPassed != null) return sector.gatesPassed
  return (sector.checks || []).filter((c) => c.pass && !c.proxy).length
}

function byStrength(a, b) {
  return (
    strengthOf(b) - strengthOf(a) ||
    Number(b.dataReady) - Number(a.dataReady) ||
    (b.heat || 0) - (a.heat || 0) ||
    (b.maxBoard || 0) - (a.maxBoard || 0) ||
    (b.todayCount || 0) - (a.todayCount || 0)
  )
}

const rankedCandidates = computed(() => mainCandidates.value.slice().sort(byStrength))
const leadCandidate = computed(() => rankedCandidates.value[0] || null)
const restCandidates = computed(() => rankedCandidates.value.slice(1))
const rankedThemes = computed(() =>
  newThemes.value
    .slice()
    .sort((a, b) => (b.heat || 0) - (a.heat || 0) || (b.todayCount || 0) - (a.todayCount || 0))
)
</script>

<template>
  <div class="view">
    <GateBanner :gate="dashboard.gate" :sentiment="dashboard.sentiment" />

    <MarketIndex
      :quote="marketIndex"
      :live="!!(dashboard.market && dashboard.market.live)"
    />

    <MarketMood :sentiment="dashboard.sentiment" />

    <section class="section">
      <header class="section-head">
        <span class="section-title">主线候选</span>
        <span class="section-count">{{ rankedCandidates.length }} 个 · 按强度排序</span>
        <span v-if="verifiedCount" class="chip chip--green" style="margin-left: auto">已核验催化 {{ verifiedCount }}</span>
      </header>
      <p class="section-note">
        排序依次看：三关通过数 → 热度 → 连板高度。强度第一的单独置顶，其余方向收起；三关未全过只做观察。
      </p>

      <div v-if="!rankedCandidates.length" class="empty-view">
        <div class="glyph">空</div>
        <b>没有板块通过连续性门槛</b>
        <p>今天只有孤立热点，没有形成“昨天在、今天还在”的板块效应。按口诀：无主线，空仓等待。</p>
      </div>

      <SectorCard
        v-if="leadCandidate"
        :sector="leadCandidate"
        :display-rank="1"
        strongest
      />

      <div v-if="restCandidates.length" class="panel more-panel">
        <div
          v-for="(sector, i) in restCandidates"
          :key="sector.key"
          class="more-row"
        >
          <span class="more-rank">{{ String(i + 2).padStart(2, '0') }}</span>
          <div class="more-main">
            <div class="more-title">
              <b>{{ sector.name }}</b>
              <span class="chip chip--dim">过 {{ strengthOf(sector) }}/3 关</span>
            </div>
            <div class="more-meta">
              今 {{ sector.todayCount }} 家 · 昨 {{ sector.prevCount }} 家 · 最高 {{ sector.maxBoard }} 板
              <template v-if="sector.missing && sector.missing.length">
                · 差 {{ sector.missing.slice(0, 2).join('、') }}{{ sector.missing.length > 2 ? '等' : '' }}
              </template>
            </div>
          </div>
          <div class="more-heat">
            <b>{{ sector.heat }}</b>
            <small>热度</small>
          </div>
        </div>
        <button class="more-toggle" @click="showRest = !showRest">
          {{ showRest ? '收起完整卡片' : `展开其余 ${restCandidates.length} 个完整卡片` }}
        </button>
      </div>

      <div v-if="showRest" class="more-cards">
        <SectorCard
          v-for="(sector, i) in restCandidates"
          :key="sector.key"
          :sector="sector"
          :display-rank="i + 2"
        />
      </div>
    </section>

    <section v-if="newThemes.length" class="section">
      <header class="section-head">
        <span class="section-title">新起题材</span>
        <span class="section-count">{{ rankedThemes.length }} 个 · 仅观察</span>
      </header>
      <p class="section-note">
        今日首次形成 2 家以上涨停，但昨日没有板块基础。先记录，等第二个交易日确认持续性，不参与第一天的一致。
      </p>

      <div class="panel more-panel">
        <div
          v-for="(sector, i) in rankedThemes"
          :key="sector.key"
          class="more-row"
        >
          <span class="more-rank">{{ String(i + 1).padStart(2, '0') }}</span>
          <div class="more-main">
            <div class="more-title">
              <b>{{ sector.name }}</b>
              <span class="chip chip--blue">首日</span>
            </div>
            <div class="more-meta">
              今 {{ sector.todayCount }} 家 · 最高 {{ sector.maxBoard }} 板 · 昨 {{ sector.prevCount }} 家
            </div>
          </div>
          <div class="more-heat">
            <b>{{ sector.heat }}</b>
            <small>热度</small>
          </div>
        </div>
        <button class="more-toggle" @click="showThemes = !showThemes">
          {{ showThemes ? '收起完整卡片' : `展开 ${rankedThemes.length} 个完整卡片` }}
        </button>
      </div>

      <div v-if="showThemes" class="more-cards">
        <SectorCard
          v-for="sector in rankedThemes"
          :key="sector.key"
          :sector="sector"
          :show-rank="false"
        />
      </div>
    </section>

    <section v-if="fading.length" class="section">
      <header class="section-head">
        <span class="section-title">退潮 / 掉队</span>
        <span class="section-count">{{ fading.length }} 个方向</span>
      </header>
      <div class="panel panel-pad fading-list">
        <div v-for="item in fading" :key="item.name" class="fading-row">
          <div class="fading-name">
            <b>{{ item.name }}</b>
            <span class="dim">龙头 {{ item.leader || '--' }}</span>
          </div>
          <div class="fading-count">
            <span class="mono">{{ item.prevCount }}</span>
            <span class="dim">→</span>
            <span class="mono" :class="item.todayCount ? 'is-up' : 'is-down'">{{ item.todayCount }}</span>
            <small>家</small>
          </div>
          <span class="chip chip--dim">昨日 {{ item.maxBoardPrev }} 板</span>
        </div>
      </div>
    </section>

    <section class="section">
      <header class="section-head">
        <span class="section-title">三关口径</span>
        <span class="section-count">任一不过 · 不构成主线</span>
      </header>
      <div class="panel panel-pad criteria">
        <div class="criterion">
          <span class="no">01</span>
          <div>
            <b>连续性</b>
            <p>今日与昨日涨停家数均 ≥ 2，且家数排名进入前列。冷门一日游在这里被过滤。</p>
          </div>
        </div>
        <div class="criterion">
          <span class="no">02</span>
          <div>
            <b>梯队完整</b>
            <p>同时存在高位连板、中位二板、低位首板。只有一只票孤零零上涨，不算板块效应。</p>
          </div>
        </div>
        <div class="criterion">
          <span class="no">03</span>
          <div>
            <b>资金连续</b>
            <p>板块连续 2 个交易日主力净流入。只有当日脉冲、次日集体低开的热点直接排除。</p>
          </div>
        </div>
        <div class="criteria-foot">
          当前共扫描 {{ counts.sectors || 0 }} 个涨停板块，三关通过
          {{ counts.dataReady || 0 }} 个。数据口径与限制见「战法」页。
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.more-panel {
  padding: 4px 12px 10px;
}

.more-row {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 9px 0;
  border-bottom: 1px dashed rgba(255, 255, 255, 0.055);
}

.more-rank {
  flex: 0 0 auto;
  width: 22px;
  height: 22px;
  display: grid;
  place-items: center;
  border-radius: 6px;
  border: 1px solid var(--line);
  background: rgba(255, 255, 255, 0.03);
  font-family: var(--mono);
  font-size: 11px;
  color: var(--muted);
}

.more-main {
  min-width: 0;
  flex: 1;
}

.more-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13.5px;
  line-height: 1.4;
}

.more-title b {
  font-weight: 600;
  letter-spacing: 0.03em;
}

.more-meta {
  margin-top: 2px;
  font-size: 11px;
  line-height: 1.5;
  color: var(--dim);
}

.more-heat {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  font-family: var(--mono);
}

.more-heat b {
  font-size: 14.5px;
  font-weight: 600;
  color: var(--text-soft);
}

.more-heat small {
  font-size: 9.5px;
  letter-spacing: 0.1em;
  color: var(--dim);
}

.more-toggle {
  width: 100%;
  height: 31px;
  margin-top: 8px;
  border-radius: 8px;
  border: 1px dashed rgba(255, 255, 255, 0.11);
  background: rgba(255, 255, 255, 0.02);
  color: var(--muted);
  font-size: 12px;
  letter-spacing: 0.05em;
  cursor: pointer;
  transition: 0.2s ease;
}

.more-toggle:hover {
  color: var(--text-soft);
  border-color: var(--gold-line);
}

.more-cards {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 10px;
}

.fading-list {
  padding: 8px 12px;
}

.fading-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 0;
  border-bottom: 1px dashed rgba(255, 255, 255, 0.055);
}

.fading-row:last-child {
  border-bottom: 0;
}

.fading-name {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.fading-name b {
  font-size: 13.5px;
  font-weight: 600;
}

.fading-name span {
  font-size: 11px;
}

.fading-count {
  display: flex;
  align-items: baseline;
  gap: 3px;
  font-family: var(--mono);
  font-size: 13.5px;
}

.fading-count small {
  font-size: 10px;
  color: var(--dim);
}

.criteria {
  display: flex;
  flex-direction: column;
  gap: 11px;
}

.criterion {
  display: flex;
  gap: 10px;
  align-items: flex-start;
}

.criterion .no {
  flex: 0 0 auto;
  width: 24px;
  height: 24px;
  display: grid;
  place-items: center;
  border-radius: 7px;
  border: 1px solid var(--gold-line);
  background: var(--gold-soft);
  color: var(--gold);
  font-family: var(--mono);
  font-size: 11px;
}

.criterion b {
  font-size: 13.5px;
  font-weight: 600;
  letter-spacing: 0.03em;
}

.criterion p {
  margin: 2px 0 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--muted);
}

.criteria-foot {
  padding-top: 9px;
  border-top: 1px dashed rgba(255, 255, 255, 0.07);
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--dim);
}
</style>