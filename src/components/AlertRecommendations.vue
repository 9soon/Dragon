<script setup>
import { computed, ref } from 'vue'
import { fmtMoney, fmtNum, fmtPct, fmtPrice, pctTone } from '../lib/format'
import {
  alertState,
  currentRecommendations,
  pastRecommendations,
  recommendationUpdatedAt
} from '../lib/alerts'

defineProps({
  compact: { type: Boolean, default: false },
  live: { type: Boolean, default: true }
})

const dateLabel = computed(() => alertState.recommendationDateLabel || '今日')
const activeCount = computed(() => currentRecommendations.value.length)
const pastCount = computed(() => pastRecommendations.value.length)
const historyOpen = ref(false)
const HISTORY_PREVIEW = 4
const visiblePast = computed(() =>
  historyOpen.value
    ? pastRecommendations.value
    : pastRecommendations.value.slice(0, HISTORY_PREVIEW)
)

function isHotScore(score) {
  return Number(score) >= 80
}
</script>

<template>
  <section class="rec-block" :class="{ 'is-compact': compact }" aria-label="预警推荐">
    <header class="rec-head">
      <span class="rec-title">{{ dateLabel }} 预警推荐</span>
      <span class="rec-sub">
        {{ live ? `按预警分从强到弱 · 当前 ${activeCount} 只在榜` : `按预警分从强到弱 · 当日 ${activeCount + pastCount} 条记录（休市不更新）` }}
      </span>
      <span v-if="recommendationUpdatedAt" class="rec-stamp mono">
        更新 {{ recommendationUpdatedAt }}
      </span>
    </header>

    <div v-if="activeCount" class="rec-list">
      <article
        v-for="(r, idx) in currentRecommendations"
        :key="r.key"
        class="rec-row"
        :class="{ 'is-hot': isHotScore(r.alertScore) }"
      >
        <span class="rec-rank">{{ idx + 1 }}</span>
        <div class="rec-body">
          <div class="rec-name">
            <b>{{ r.name }}</b>
            <span class="mono">{{ r.code }}</span>
            <span class="chip chip--gold">{{ r.statusLabel }}</span>
            <span v-if="r.nuclearLevel === 'mid'" class="chip chip--warn">
              防核按钮 {{ r.nuclearScore }}
            </span>
          </div>
          <div class="rec-line">
            <span>{{ r.sector }}</span>
            <span class="mono rec-time">推荐 {{ r.recommendTime }}</span>
            <span
              v-if="r.lastSeenTime && r.lastSeenTime !== r.recommendTime"
              class="mono rec-time"
            >最近 {{ r.lastSeenTime }}</span>
          </div>
          <div class="rec-meta">
            <span>现价 {{ fmtPrice(r.price) }}</span>
            <span :class="pctTone(r.pct)">{{ fmtPct(r.pct) }}</span>
            <span>距涨停 {{ fmtPct(r.gapToLimit, { sign: false }) }}</span>
            <span v-if="r.volRatio != null">量比 {{ fmtNum(r.volRatio, 2) }}</span>
            <span v-else-if="r.amount != null">成交 {{ fmtMoney(r.amount, { sign: false }) }}</span>
            <span v-if="r.geneScore != null">基因 {{ r.geneScore }}</span>
          </div>
        </div>
        <div class="rec-score">
          <b>{{ r.alertScore }}</b>
          <small>预警分</small>
        </div>
      </article>
    </div>

    <p v-else class="rec-empty">
      当前没有未封板且达标的预警推荐。已封板只排队观察，不弹“买不进”的票；空仓等待也是有效决策。
    </p>

    <div v-if="pastCount" class="rec-history">
      <div class="rec-history-head">
        <span>{{ dateLabel }} 出榜推荐 {{ pastCount }} 只</span>
        <i>推荐时间保留，刷新不清空</i>
      </div>
      <div class="rec-history-list">
        <div v-for="r in visiblePast" :key="r.key" class="rec-history-row">
          <span class="mono rec-time">{{ r.recommendTime }}</span>
          <b>{{ r.name }}</b>
          <span class="mono dim">{{ r.code }}</span>
          <span class="mono">{{ r.alertScore }} 分</span>
          <span class="mono dim">现 {{ fmtPct(r.pct) }}</span>
          <span class="rec-out">{{ r.inactiveLabel || '已移出当前推荐榜' }}</span>
        </div>
      </div>
      <button
        v-if="pastCount > HISTORY_PREVIEW"
        class="rec-history-toggle"
        type="button"
        @click="historyOpen = !historyOpen"
      >
        {{ historyOpen ? '收起' : `展开全部 ${pastCount} 只` }}
      </button>
    </div>
  </section>
</template>

<style scoped>
.rec-block {
  margin-top: 10px;
  padding: 10px 11px;
  border-radius: 13px;
  border: 1px solid rgba(243, 199, 119, 0.24);
  background:
    radial-gradient(120% 120% at 100% 0%, rgba(243, 199, 119, 0.08), transparent 58%),
    rgba(255, 255, 255, 0.022);
}

.rec-block.is-compact {
  margin-top: 0;
  padding: 9px 10px;
}

.rec-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 8px;
}

.rec-title {
  font-size: 13px;
  font-weight: 650;
  letter-spacing: 0.04em;
  color: var(--gold);
}

.rec-sub {
  font-size: 10.5px;
  color: var(--muted);
}

.rec-stamp {
  margin-left: auto;
  font-size: 10px;
  color: var(--dim);
  letter-spacing: 0.03em;
}

.rec-list {
  display: grid;
  gap: 6px;
  margin-top: 8px;
}

.rec-row {
  display: grid;
  grid-template-columns: 20px minmax(0, 1fr) auto;
  align-items: flex-start;
  gap: 7px;
  padding: 7px 8px;
  border-radius: 10px;
  border: 1px solid var(--line);
  background: rgba(255, 255, 255, 0.028);
}

.rec-row.is-hot {
  border-color: rgba(255, 84, 96, 0.28);
  background:
    radial-gradient(100% 100% at 100% 0%, rgba(255, 84, 96, 0.09), transparent 62%),
    rgba(255, 255, 255, 0.028);
}

.rec-rank {
  width: 20px;
  height: 20px;
  display: grid;
  place-items: center;
  border-radius: 6px;
  border: 1px solid rgba(243, 199, 119, 0.3);
  background: rgba(243, 199, 119, 0.1);
  color: #ffe2a9;
  font-family: var(--mono);
  font-size: 11px;
}

.is-hot .rec-rank {
  border-color: rgba(255, 84, 96, 0.34);
  background: rgba(255, 84, 96, 0.12);
  color: #ffb3b8;
}

.rec-body {
  min-width: 0;
}

.rec-name {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 4px 6px;
}

.rec-name b {
  font-size: 14px;
  line-height: 1.3;
  color: var(--text);
}

.rec-name .mono {
  font-size: 10px;
  color: var(--dim);
}

.rec-name .chip {
  font-size: 9.5px;
  line-height: 16px;
  padding: 0 5px;
}

.rec-line {
  display: flex;
  flex-wrap: wrap;
  gap: 3px 7px;
  margin-top: 1px;
  font-size: 10.5px;
  color: var(--muted);
}

.rec-time {
  color: var(--dim);
  letter-spacing: 0.02em;
}

.rec-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 3px 8px;
  margin-top: 3px;
  font-size: 10.5px;
  color: var(--text-soft);
}

.rec-score {
  flex: 0 0 auto;
  display: grid;
  justify-items: center;
  min-width: 42px;
  padding: 2px 5px 3px;
  border-radius: 8px;
  border: 1px solid var(--line-strong);
  background: rgba(255, 255, 255, 0.035);
}

.is-hot .rec-score {
  border-color: rgba(255, 84, 96, 0.3);
  background: rgba(255, 84, 96, 0.09);
}

.rec-score b {
  font-family: var(--mono);
  font-size: 17px;
  line-height: 1.15;
  color: #ffd79c;
}

.is-hot .rec-score b {
  color: #ffb3b8;
}

.rec-score small {
  font-size: 9px;
  letter-spacing: 0.05em;
  color: var(--dim);
  white-space: nowrap;
}

.rec-empty {
  margin: 7px 0 0;
  padding: 7px 8px;
  border-radius: 9px;
  border: 1px dashed var(--line-strong);
  font-size: 10.8px;
  line-height: 1.6;
  color: var(--muted);
}

.rec-history {
  margin-top: 8px;
  border-top: 1px dashed var(--line-strong);
  padding-top: 7px;
}

.rec-history-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 3px 8px;
  font-size: 10.5px;
  font-weight: 600;
  line-height: 1.5;
  color: var(--text-soft);
}

.rec-history-head i {
  font-style: normal;
  font-weight: 400;
  font-size: 9.5px;
  color: var(--dim);
}

.rec-history-list {
  display: grid;
  gap: 4px;
  margin-top: 6px;
}

.rec-history-row {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 3px 7px;
  padding: 4px 6px;
  border-radius: 7px;
  border: 1px solid var(--line);
  background: rgba(255, 255, 255, 0.018);
  font-size: 10.5px;
  color: var(--text-soft);
}

.rec-history-row b {
  font-weight: 600;
}

.rec-out {
  flex-basis: 100%;
  font-size: 9.5px;
  line-height: 1.45;
  color: var(--dim);
}

.rec-history-toggle {
  margin-top: 5px;
  padding: 2px 7px;
  border-radius: 6px;
  border: 1px solid var(--line);
  background: rgba(255, 255, 255, 0.03);
  font-size: 10px;
  color: var(--muted);
}

.rec-history-toggle:active {
  color: var(--gold);
  border-color: rgba(243, 199, 119, 0.3);
}

.dim {
  color: var(--dim);
}

@media (max-width: 360px) {
  .rec-block {
    padding: 9px;
  }

  .rec-name b {
    font-size: 13.5px;
  }

  .rec-score b {
    font-size: 16px;
  }
}
</style>