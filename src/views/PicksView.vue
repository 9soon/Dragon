<script setup>
import { computed, ref } from 'vue'
import PickCard from '../components/PickCard.vue'
import { timeLabel } from '../lib/format'
import { useCatalysts, isCatalystValid } from '../lib/catalysts'

const props = defineProps({
  dashboard: { type: Object, required: true },
  quotes: { type: Object, default: () => ({}) },
  quoteAt: { type: Number, default: 0 },
  polling: { type: Boolean, default: false }
})

const filter = ref('all')

const { items } = useCatalysts()

const rumorPicks = computed(() =>
  (props.dashboard.picks || []).filter((p) => items[p.sectorKey] && items[p.sectorKey].type === 'rumor')
)
const picks = computed(() =>
  (props.dashboard.picks || []).filter((p) => !items[p.sectorKey] || items[p.sectorKey].type !== 'rumor')
)
const pendingPicks = computed(() => picks.value.filter((p) => !isCatalystValid(items[p.sectorKey])))
const roles = computed(() => [
  { key: 'all', label: '全部', count: picks.value.length },
  { key: 'dragon', label: '连板龙', count: picks.value.filter((p) => p.role === 'dragon').length },
  { key: 'mid', label: '中军', count: picks.value.filter((p) => p.role === 'mid').length },
  { key: 'catchup', label: '补涨', count: picks.value.filter((p) => p.role === 'catchup').length },
  { key: 'vanguard', label: '首板', count: picks.value.filter((p) => p.role === 'vanguard').length }
])

const list = computed(() => {
  if (filter.value === 'all') return picks.value
  return picks.value.filter((p) => p.role === filter.value)
})

const quoteClock = computed(() => (props.quoteAt ? timeLabel(new Date(props.quoteAt)) : '--:--:--'))
const live = computed(() => !!(props.dashboard.market && props.dashboard.market.live))
const gateEmpty = computed(() => props.dashboard.gate && props.dashboard.gate.key === 'empty')
</script>

<template>
  <div class="view">
    <section class="pick-head-panel">
      <div class="pick-head-top">
        <div>
          <div class="eyebrow">个股池 · WATCHLIST</div>
          <h2>先主线，后个股</h2>
        </div>
        <div class="live-box">
          <span class="live-line">
            <i class="dot" :class="live ? 'dot--live' : 'dot--gold'"></i>
            {{ live ? '价格 1s' : '非交易时段' }}
          </span>
          <span class="mono dim">{{ quoteClock }}</span>
        </div>
      </div>
      <p class="pick-head-desc">
        角色不同，买点不同：连板龙看分歧承接，中军看趋势回踩，补涨看首板强度。
        分数只做横向比较，不替代位置与催化判断。
      </p>
      <div v-if="gateEmpty" class="no-mainline">
        <span class="chip chip--red">无主线</span>
        {{ dashboard.gate.detail }}
      </div>
      <div v-else class="no-mainline no-mainline--ok">
        <span class="chip chip--gold">{{ dashboard.gate.label }}</span>
        {{ dashboard.gate.detail }}
      </div>
      <div v-if="rumorPicks.length" class="catalyst-strip">
        <span class="chip chip--red">传闻排除</span>
        <span>{{ rumorPicks.map((p) => p.name).join('、') }} 所属方向被标记为纯传闻，已从执行清单剔除。</span>
      </div>
      <div v-if="pendingPicks.length" class="catalyst-strip">
        <span class="chip chip--warn">待核验催化</span>
        <span>{{ pendingPicks.length }} 只尚未核验政策 / 产业 / 事件催化，统一按观察分展示。</span>
      </div>
    </section>

    <div class="filter-row">
      <button
        v-for="role in roles"
        :key="role.key"
        class="filter-chip"
        :class="{ 'is-active': filter === role.key }"
        @click="filter = role.key"
      >
        {{ role.label }}
        <span>{{ role.count }}</span>
      </button>
    </div>

    <div v-if="!list.length" class="empty-view">
      <div class="glyph">候</div>
      <b>当前分类下没有符合条件的标的</b>
      <p>没有梯队、没有承接、没有催化时，最好的操作往往是不操作。</p>
    </div>

    <PickCard
      v-for="(pick, idx) in list"
      :key="pick.code"
      :pick="pick"
      :quote="quotes[pick.code]"
      :rank="idx + 1"
    />

    <section class="panel panel-pad scoring-note">
      <h4>观察分怎么来的</h4>
      <p>
        初筛分 = 54% 角色分 + 30% 板块热度 + 16% 板块就绪度，最终分 = 72% 初筛 + 28% 龙头基因。
        角色分由连板高度、封板时间、封单占流通、换手健康度与流通市值适配度加权；基因分包含情绪环境、
        板块地位、弱转强、封板质量、筹码结构与历史画像。炸板、尾盘封板、高位爆量会扣分。
      </p>
      <p>
        未通过三关的板块，个股分数封顶 68；新起题材封顶 60。也就是说：
        <b>没有主线时，再高的分也只是观察分。</b>
      </p>
      <p>
        催化属于本机人工核验：未核验的标的一律按观察分展示；标记为纯传闻的方向会直接从本页剔除。
      </p>
      <p class="dim">
        价格来自腾讯公开行情，1 秒轮询；封单金额由腾讯实时买一队列计算，只在涨停封板时显示，开板即提示；未拿到实时队列时退回涨停池快照并标注。榜单每 10 秒重建、资金约 20 秒刷新一次。接口异常时会保留上一份有效快照并明确标注。
      </p>
    </section>
  </div>
</template>

<style scoped>
.pick-head-panel {
  padding: 15px;
  border-radius: 18px;
  border: 1px solid var(--line);
  background:
    radial-gradient(120% 130% at 100% -20%, rgba(243, 199, 119, 0.1), transparent 55%),
    linear-gradient(150deg, rgba(20, 27, 40, 0.94), rgba(9, 12, 19, 0.96));
}

.pick-head-top {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}

.pick-head-top h2 {
  margin: 3px 0 0;
  font-size: 21px;
  font-weight: 700;
  letter-spacing: 0.04em;
}

.live-box {
  margin-left: auto;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
  font-size: 11px;
}

.live-line {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--muted);
  white-space: nowrap;
}

.pick-head-desc {
  margin: 9px 0 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--muted);
}

.no-mainline {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  margin-top: 11px;
  padding: 8px 9px;
  border-radius: 9px;
  border: 1px dashed rgba(255, 84, 96, 0.24);
  background: rgba(255, 84, 96, 0.05);
  font-size: 12px;
  line-height: 1.6;
  color: #d9a0a4;
}

.no-mainline--ok {
  border-color: rgba(243, 199, 119, 0.24);
  background: rgba(243, 199, 119, 0.05);
  color: #dcc194;
}

.no-mainline .chip {
  flex: 0 0 auto;
  margin-top: 1px;
}

.catalyst-strip {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  margin-top: 7px;
  padding: 8px 9px;
  border-radius: 9px;
  border: 1px solid rgba(255, 255, 255, 0.06);
  background: rgba(255, 255, 255, 0.025);
  font-size: 12px;
  line-height: 1.6;
  color: var(--muted);
}

.catalyst-strip .chip {
  flex: 0 0 auto;
  margin-top: 1px;
}

.filter-row {
  display: flex;
  gap: 6px;
  overflow-x: auto;
  padding: 1px 1px 2px;
  scrollbar-width: none;
}

.filter-row::-webkit-scrollbar {
  display: none;
}

.filter-chip {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 30px;
  padding: 0 11px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: rgba(255, 255, 255, 0.025);
  color: var(--muted);
  font-size: 12px;
  letter-spacing: 0.04em;
  transition: 0.18s ease;
}

.filter-chip span {
  font-family: var(--mono);
  font-size: 10.5px;
  color: var(--dim);
}

.filter-chip.is-active {
  border-color: var(--gold-line);
  background: var(--gold-soft);
  color: var(--gold);
}

.filter-chip.is-active span {
  color: rgba(243, 199, 119, 0.65);
}

.scoring-note h4 {
  margin: 0 0 7px;
  font-size: 12.5px;
  font-weight: 600;
  letter-spacing: 0.08em;
  color: var(--gold);
}

.scoring-note p {
  margin: 0 0 6px;
  font-size: 12px;
  line-height: 1.75;
  color: var(--muted);
}

.scoring-note p:last-child {
  margin-bottom: 0;
  padding-top: 7px;
  border-top: 1px dashed rgba(255, 255, 255, 0.06);
}

.scoring-note b {
  color: var(--text-soft);
}
</style>