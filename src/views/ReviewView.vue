<script setup>
import { computed, ref } from 'vue'
import MarketMood from '../components/MarketMood.vue'
import { fmtMoney, fmtPct } from '../lib/format'

const props = defineProps({
  dashboard: { type: Object, required: true }
})

const review = computed(() => props.dashboard.review || {})
const sentiment = computed(() => props.dashboard.sentiment)
const tiers = computed(() => (review.value.prevPremium && review.value.prevPremium.byTier) || [])
const promotion = computed(() => review.value.promotion || sentiment.value.promotion || {})
const ladder = computed(() => review.value.ladder || [])
const ladderFlow = computed(() => review.value.ladderFlow || {})
const flowRows = computed(() => ladderFlow.value.rows || [])
const flowReady = computed(() => !!ladderFlow.value.prevReady)
const eliminated = computed(() => ladderFlow.value.stocks || [])
const firstTierEliminated = computed(() => {
  const row = flowRows.value.find((x) => x.lbc === 1)
  return row ? row.eliminated : 0
})
const showAllElim = ref(false)
const eliminatedShown = computed(() =>
  showAllElim.value ? eliminated.value : eliminated.value.slice(0, 6)
)
const distribution = computed(() => review.value.distribution || [])
const maxDist = computed(() => Math.max(1, ...distribution.value.map((x) => x.todayCount)))
const blown = computed(() => review.value.blownTop || [])
const down = computed(() => review.value.downTop || [])
const live = computed(() => props.dashboard.dataMode === 'live')
const snapshotLabel = computed(() => {
  const d = props.dashboard
  const m = d.market || {}
  if (d.dataMode === 'live') return '盘中实时'
  if (!d.isTodayData) {
    return ['preopen', 'auction', 'waiting'].includes(m.key) ? '盘前快照' : '最近交易日'
  }
  if (m.key === 'lunch') return '午间快照'
  return '收盘快照'
})

const promotionOverall = computed(() => promotion.value.overall || {})
const premium = computed(() => sentiment.value.premium || {})

function elimChip(item) {
  if (item.status === 'blown') return 'chip--red'
  if (item.status === 'limitDown') return 'chip--green'
  if (item.status === 'noQuote') return 'chip--dim'
  return 'chip--warn'
}

const conclusion = computed(() => {
  const s = sentiment.value
  const gate = props.dashboard.gate || {}
  const parts = []
  parts.push(
    `今日涨停 ${s.limitUp} 家，最高 ${s.maxBoard} 板，炸板率 ${s.blowRate}%，昨日涨停溢价 ${
      premium.value.skip ? '待更新' : fmtPct(premium.value.avg)
    }。`
  )
  if (promotionOverall.value.rate != null) {
    parts.push(`整体晋级率 ${promotionOverall.value.rate}%（${promotionOverall.value.promoted}/${promotionOverall.value.total}）。`)
  }
  if (gate.key === 'empty') {
    parts.push('没有板块同时通过连续性、梯队与资金三关，情绪再好也缺少主线载体。按口诀：无主线，空仓等待。')
  } else if (gate.key === 'defend') {
    parts.push('虽有板块数据达标，但情绪处于退潮/冰点区间。降低频率，只跟踪最强核心，不参与一致加速。')
  } else {
    parts.push('已有板块通过数据三关。下一步只做人工催化核验，围绕最强核心制定分歧买点，不做跟风补涨的临时起意。')
  }
  parts.push('复盘写在收盘后，执行放在计划里；不把盘中冲动带进明天的交易。')
  return parts.join('')
})

function tierTone(v) {
  if (v == null) return 'is-flat'
  return v > 0 ? 'is-up' : v < 0 ? 'is-down' : 'is-flat'
}
</script>

<template>
  <div class="view">
    <section class="review-head">
      <div class="eyebrow">盘后复盘 · REVIEW</div>
      <div class="review-title-row">
        <h2>{{ dashboard.tradeDateLabel }} 复盘</h2>
        <span class="chip chip--dim">上一交易日 {{ dashboard.prevTradeDateLabel || '--' }}</span>
      </div>
      <p class="review-desc">
        先看情绪温度，再看昨日涨停的赚钱效应，最后看连板天梯与资金分布。复盘不是总结涨了多少，而是判断明天该不该出手。
      </p>
    </section>

    <div v-if="live" class="review-banner">
      <span>●</span>
      <div><b>盘中快照：</b>数据会随封板与炸板变化，收盘后再次打开复盘会更完整。</div>
    </div>

    <MarketMood :sentiment="dashboard.sentiment" />

    <section class="section">
      <header class="section-head">
        <span class="section-title">昨日涨停 · 今日表现</span>
        <span class="section-count">{{ review.prevPremium ? `${review.prevPremium.quoted}/${review.prevPremium.total} 已报价` : '' }}</span>
      </header>
      <div v-if="tiers.length && !premium.skip" class="tier-grid">
        <div v-for="tier in tiers" :key="tier.key" class="tier-card">
          <small>{{ tier.label }}</small>
          <b :class="tierTone(tier.avg)">{{ tier.avg != null ? fmtPct(tier.avg) : '--' }}</b>
          <span>胜率 {{ tier.winRate != null ? tier.winRate + '%' : '--' }} · {{ tier.count }} 只</span>
        </div>
      </div>
      <div v-else class="empty-mini panel panel-pad">
        昨日池报价尚未就绪（多为盘前或接口波动）。开盘后此表会自动补齐。
      </div>
      <p class="section-note">
        昨日涨停今天平均溢价，是赚钱效应最直接的体温计。首板溢价代表低吸容错，高位溢价代表接力意愿。
      </p>
    </section>

    <section v-if="promotion.first" class="section">
      <header class="section-head">
        <span class="section-title">晋级率</span>
        <span class="section-count">昨日 → 今日</span>
      </header>
      <div class="promote-grid">
        <div class="promote-card">
          <div class="label">昨日首板 → 今日二板</div>
          <div class="rate" :class="promotion.first.rate >= 25 ? 'is-up' : 'is-flat'">
            {{ promotion.first.rate != null ? promotion.first.rate + '%' : '--' }}
          </div>
          <div class="sub">{{ promotion.first.promoted }} / {{ promotion.first.total }} 成功晋级</div>
        </div>
        <div class="promote-card">
          <div class="label">昨日连板 → 今日继续</div>
          <div class="rate" :class="promotion.continuation.rate >= 50 ? 'is-up' : 'is-flat'">
            {{ promotion.continuation.rate != null ? promotion.continuation.rate + '%' : '--' }}
          </div>
          <div class="sub">{{ promotion.continuation.promoted }} / {{ promotion.continuation.total }} 继续封板</div>
        </div>
      </div>
      <p class="section-note">
        首板晋级率低于 20% 说明接力亏钱，连板晋级率骤降说明高位开始分歧。两者同时走弱，直接进入防守。
      </p>
    </section>

    <section class="section">
      <header class="section-head">
        <span class="section-title">连板天梯</span>
        <span class="section-count">{{ ladder.length }} 个高度层</span>
      </header>

      <div class="ladder-livebar">
        <span class="ladder-live" :class="live ? 'is-live' : 'is-snapshot'">
          <i></i>{{ snapshotLabel }}
        </span>
        <template v-if="flowReady">
          <span class="ladder-stat"><small>晋级</small><b class="is-up">{{ ladderFlow.promoted }}</b></span>
          <span class="ladder-stat"><small>淘汰</small><b class="is-down">{{ ladderFlow.eliminated }}</b></span>
          <span v-if="ladderFlow.blown" class="ladder-stat"><small>炸板</small><b>{{ ladderFlow.blown }}</b></span>
        </template>
        <span v-else class="ladder-hint">昨日池未就绪</span>
      </div>

      <div v-if="ladder.length" class="panel ladder-board">
        <div v-for="row in ladder" :key="row.lbc" class="ladder-row">
          <div class="ladder-level">
            <b>{{ row.lbc === 1 ? '首' : row.lbc }}{{ row.lbc !== 1 && row.capped ? '+' : '' }}</b>
            <small>{{ row.lbc === 1 ? '板' : '连板' }} · {{ row.count }}</small>
          </div>
          <div class="ladder-stocks">
            <span v-for="stock in row.stocks" :key="stock.code" class="ladder-stock">
              {{ stock.name }}
              <em>{{ stock.firstSealLabel }}</em>
            </span>
          </div>
        </div>
      </div>
      <div v-else class="empty-mini panel panel-pad">今日暂无涨停天梯数据。</div>
      <p class="section-note">
        高度层随涨停池约 10 秒刷新；7 层以上合并展示并标 +。晋级 / 淘汰按昨日梯队整体统计，见下方流转表。
      </p>
    </section>

    <section v-if="flowReady" class="section">
      <header class="section-head">
        <span class="section-title">梯队流转 · 昨日 → 今日</span>
        <span class="section-count">{{ ladderFlow.total }} 家 · 晋级 {{ ladderFlow.promoted }}</span>
      </header>

      <div v-if="flowRows.length" class="panel flow-board">
        <div v-for="row in flowRows" :key="row.lbc" class="flow-row">
          <div class="flow-level">
            <b>{{ row.label }}</b>
            <small>昨 {{ row.total }} 家</small>
          </div>
          <div class="flow-mid">
            <div class="flow-track">
              <i
                class="flow-fill is-promoted"
                :style="{ width: `${row.total ? (row.promoted / row.total) * 100 : 0}%` }"
              ></i>
              <i
                class="flow-fill is-eliminated"
                :style="{ width: `${row.total ? (row.eliminated / row.total) * 100 : 0}%` }"
              ></i>
            </div>
            <div class="flow-copy">
              <span class="is-up">晋级 {{ row.promoted }}</span>
              <span class="is-down">淘汰 {{ row.eliminated }}</span>
              <span v-if="row.retained" class="dim">数据存疑 {{ row.retained }}</span>
            </div>
          </div>
          <div class="flow-rate" :class="{ 'is-gold': row.rate >= 30 }">
            {{ row.rate }}<small>%</small>
          </div>
        </div>
      </div>

      <div class="panel elim-board">
        <div class="elim-head">
          <span>连板淘汰 · 今日未回封</span>
          <span class="dim">{{ eliminated.length }} 家</span>
        </div>
        <div v-if="eliminated.length" class="elim-list">
          <div v-for="item in eliminatedShown" :key="item.code" class="elim-row">
            <span class="elim-level">{{ item.lbc }}板</span>
            <div class="elim-main">
              <b>{{ item.name }}</b>
              <small>{{ item.sector }}</small>
            </div>
            <span class="chip" :class="elimChip(item)" style="height: 18px">{{ item.statusLabel }}</span>
            <span class="elim-pct mono" :class="tierTone(item.pct)">{{ fmtPct(item.pct) }}</span>
          </div>
          <button
            v-if="eliminated.length > 6"
            class="elim-toggle"
            @click="showAllElim = !showAllElim"
          >
            {{ showAllElim ? '收起' : `展开其余 ${eliminated.length - 6} 家` }}
          </button>
        </div>
        <div v-else class="elim-empty">
          昨日 2 板及以上全部仍封在涨停{{ firstTierEliminated ? `；首板淘汰 ${firstTierEliminated} 家，见上方流转表` : '' }}。
        </div>
      </div>

      <p class="section-note">
        晋级 = 昨日涨停、今日继续封板且高度提升；淘汰 = 今日未出现在涨停池，含首板。下方名单只列昨日 ≥2 连板的淘汰股。
        {{ live ? '盘中回封会自动移回天梯，炸板 / 跌停 / 未封只是当前快照。' : '收盘后为当日定稿。' }}
      </p>
    </section>

    <section class="section">
      <header class="section-head">
        <span class="section-title">涨停板块分布</span>
        <span class="section-count">按家数排序</span>
      </header>
      <div class="panel dist-list">
        <div v-for="item in distribution" :key="item.name" class="dist-row">
          <div class="dist-name">
            {{ item.name }}
            <em v-if="item.todayCount > 1">×{{ item.todayCount }}</em>
          </div>
          <div class="dist-track">
            <div
              class="dist-fill"
              :class="{ 'is-gold': item.dataReady }"
              :style="{ width: `${Math.max(6, (item.todayCount / maxDist) * 100)}%` }"
            ></div>
          </div>
          <div class="dist-num" :class="item.moneyToday > 0 ? 'is-up' : item.moneyToday < 0 ? 'is-down' : ''">
            {{ fmtMoney(item.moneyToday) }}
          </div>
        </div>
        <div v-if="!distribution.length" class="empty-mini">暂无板块分布数据。</div>
      </div>
      <p class="section-note">
        金色条代表三关通过；右侧为板块当日主力净流入。家数多不等于主线，必须结合连续性与梯队。
      </p>
    </section>

    <section class="two-col">
      <div class="panel list-panel">
        <h4>炸板压力</h4>
        <div v-if="!blown.length" class="empty-mini">今日没有重点炸板股。</div>
        <div v-for="item in blown" :key="item.code" class="list-row">
          <span class="nm">{{ item.name }}</span>
          <span class="sub">{{ item.sector }}</span>
          <span class="pct is-down">{{ fmtPct(item.pct) }}</span>
        </div>
      </div>
      <div class="panel list-panel">
        <h4>跌停 / 弱势</h4>
        <div v-if="!down.length" class="empty-mini">今日没有跌停股。</div>
        <div v-for="item in down" :key="item.code" class="list-row">
          <span class="nm">{{ item.name }}</span>
          <span class="sub">{{ item.sector }}</span>
          <span class="pct is-down">{{ fmtPct(item.pct) }}</span>
        </div>
      </div>
    </section>

    <section class="conclusion">
      <h4>复盘结论</h4>
      <p>{{ conclusion }}</p>
    </section>

    <div class="disclaimer">
      <b>口径：</b>炸板率 = 炸板家数 /（涨停 + 炸板）；昨日涨停溢价按昨日连板层级分组统计今日涨跌幅；
      晋级率按“昨日首板今日二板 / 昨日连板今日继续涨停”计算。数据来自公开行情，存在延迟与缺失可能。
    </div>
  </div>
</template>

<style scoped>
.review-head {
  padding: 2px 2px 0;
}

.review-title-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-top: 4px;
}

.review-title-row h2 {
  margin: 0;
  font-size: 22px;
  font-weight: 700;
  letter-spacing: 0.03em;
}

.review-desc {
  margin: 7px 0 0;
  font-size: 10.5px;
  line-height: 1.75;
  color: var(--muted);
}
</style>