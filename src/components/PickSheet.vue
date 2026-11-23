<script setup>
import { ref, watch, computed } from 'vue'
import BottomSheet from './BottomSheet.vue'
import ScoreRing from './ScoreRing.vue'
import Sparkline from './Sparkline.vue'
import LivePrice from './LivePrice.vue'
import { fmtCap, fmtMoney } from '../lib/format'
import { sealState } from '../lib/seal'
import { getTrend } from '../lib/api'
import { closePick } from '../lib/ui'
import { useCatalysts, catalystType, isCatalystValid } from '../lib/catalysts'

const props = defineProps({
  pick: { type: Object, default: null },
  quote: { type: Object, default: null }
})

const trend = ref(null)
const loading = ref(false)
let token = 0

watch(
  () => props.pick,
  async (pick) => {
    token++
    const mine = token
    trend.value = null
    if (!pick) return
    loading.value = true
    try {
      const res = await getTrend(pick.secid)
      if (mine === token) trend.value = res.data
    } catch (err) {
      if (mine === token) trend.value = { points: [], preClose: null, failed: true }
    } finally {
      if (mine === token) loading.value = false
    }
  },
  { immediate: true }
)

const ROLE_TEXT = {
  dragon:
    '板块的情绪核心。不是涨幅最大，而是封板最早、封单最硬、连板高度最高，能带动同板块跟风。看高度、封板质量与分歧后的承接。',
  mid:
    '板块的趋势中军。大市值、成交额充足，负责稳定板块重心。看 5 日趋势、主力净流入与回踩承接，不追求连板。',
  catchup:
    '主线确认后的低位补涨。通常在龙头打出高度后，资金寻找同题材低位首板。看早盘封板、良性换手与板块联动。',
  vanguard:
    '首板先锋。板块刚启动时的第一梯队，只有次日二板确认才可能升级为主线核心，否则按一日游处理。'
}

const EXECUTION = {
  dragon: [
    '次日看竞价：高开不追，等分歧回踩后的承接。',
    '封单快速撤单、炸板不回封，情绪核心地位失效。',
    '高位爆量（换手 > 25% 且连板 ≥ 4）按口诀“要收工”。'
  ],
  mid: [
    '沿 5 日线观察趋势，回踩缩量企稳才是健康形态。',
    '放量滞涨或跌破趋势线，先退出再观察。',
    '不接一致加速段，等分歧。'
  ],
  catchup: [
    '首板次日必须验证：低开无承接、板块无跟随则放弃。',
    '补涨空间受龙头高度压制，龙头分歧时补涨先退。',
    '换手 3%–20% 且封板早，才算良性。'
  ],
  vanguard: [
    '首板只做观察，二板才是确认信号。',
    '次日低开翻绿、板块无第二只跟风，按一日游处理。',
    '不做“看起来像龙头”的孤立首板。'
  ]
}

const live = computed(() => {
  const p = props.pick
  const q = props.quote
  if (!p) return {}
  return {
    price: q && q.price != null ? q.price : p.price,
    pct: q && q.pct != null ? q.pct : p.pct,
    turnover: q && q.turnover != null ? q.turnover : p.turnover,
    time: q ? q.quoteTime : '',
    mainInflow: q && q.mainInflow != null ? q.mainInflow : p.mainInflow
  }
})

const points = computed(() => (trend.value && trend.value.points ? trend.value.points.map((x) => x.p) : []))
const roleText = computed(() => (props.pick ? ROLE_TEXT[props.pick.role] : ''))
const execution = computed(() => (props.pick ? EXECUTION[props.pick.role] || [] : []))
const sealInfo = computed(() => sealState(props.pick, props.quote))
const sealRatio = computed(() => {
  if (sealInfo.value) return sealInfo.value.sealed ? sealInfo.value.ratio : null
  return props.pick ? props.pick.sealRatio || 0 : 0
})

const { items } = useCatalysts()
const cat = computed(() => (props.pick ? items[props.pick.sectorKey] || null : null))
const catInfo = computed(() => (cat.value ? catalystType(cat.value.type) : null))
const catValid = computed(() => isCatalystValid(cat.value))
const observation = computed(() => !!props.pick && (props.pick.observation || !catValid.value))
const subtitle = computed(() => {
  if (!props.pick) return ''
  if (props.pick.observation) return `${props.pick.sector} · 观察池（未过三关）`
  if (!catValid.value) return `${props.pick.sector} · 观察池（催化未核验）`
  return `${props.pick.sector} · 三关通过`
})
</script>

<template>
  <BottomSheet
    :open="!!pick"
    :title="pick ? `${pick.name} · ${pick.roleLabel}` : '标的详情'"
    :subtitle="subtitle"
    @close="closePick"
  >
    <template v-if="pick">
      <div class="detail-hero">
        <div class="detail-hero-copy">
          <div class="detail-name">
            <b>{{ pick.name }}</b>
            <span>{{ pick.code }}</span>
          </div>
          <div class="detail-sub">
            <span class="role-badge" :class="`role-badge--${pick.role}`">{{ pick.roleLabel }}</span>
            <span v-if="observation" class="observation-badge">仅观察</span>
            <span
              class="chip"
              :class="catValid ? 'chip--green' : cat && cat.type === 'rumor' ? 'chip--red' : 'chip--warn'"
              style="height: 18px"
            >
              {{ catValid ? `催化·${catInfo.short}` : cat && cat.type === 'rumor' ? '传闻排除' : '待催化' }}
            </span>
            <span>{{ pick.lbc > 0 ? `${pick.lbc} 板` : '趋势标的' }}</span>
          </div>
          <div class="detail-price">
            <LivePrice :price="live.price" :pct="live.pct" :time="live.time" size="lg" />
          </div>
        </div>
        <ScoreRing
          :value="pick.score"
          :size="66"
          :stroke="4.5"
          :tone="observation ? 'gold' : 'auto'"
          :caption="observation ? '观察分' : '综合分'"
        />
      </div>

      <div class="detail-section">
        <h4>分时结构</h4>
        <div class="chart-box">
          <Sparkline
            v-if="points.length > 1"
            :points="points"
            :baseline="trend ? trend.preClose : null"
            :height="84"
            show-baseline
          />
          <div v-else class="chart-empty">
            {{ loading ? '正在读取分时…' : trend && trend.failed ? '分时接口暂不可用' : '暂无分时数据' }}
          </div>
        </div>
      </div>

      <div class="detail-section">
        <h4>关键数据</h4>
        <div class="detail-grid">
          <div class="detail-cell"><small>换手</small><b>{{ live.turnover != null ? live.turnover + '%' : '--' }}</b></div>
          <div class="detail-cell"><small>封单 / 流通</small><b>{{ sealRatio ? sealRatio + '%' : '--' }}</b></div>
          <div class="detail-cell"><small>首封时间</small><b>{{ pick.firstSealLabel || '--:--' }}</b></div>
          <div class="detail-cell"><small>炸板次数</small><b>{{ pick.blowCount || 0 }}</b></div>
          <div class="detail-cell"><small>主力净流入</small><b :class="live.mainInflow > 0 ? 'is-up' : live.mainInflow < 0 ? 'is-down' : ''">{{ fmtMoney(live.mainInflow) }}</b></div>
          <div class="detail-cell"><small>流通市值</small><b>{{ fmtCap(pick.floatCap) }}</b></div>
          <div class="detail-cell">
            <small>封单金额{{ sealInfo && sealInfo.live ? ' · 实时' : sealInfo ? ' · 快照' : '' }}</small>
            <b v-if="sealInfo && sealInfo.sealed" class="is-up">{{ fmtMoney(sealInfo.fund, { sign: false }) }}</b>
            <b v-else-if="sealInfo" class="is-down">已开板</b>
            <b v-else>--</b>
          </div>
          <div class="detail-cell"><small>成交额</small><b>{{ fmtMoney(pick.amount) }}</b></div>
        </div>
        <p v-if="pick.lbc > 0 || pick.sealFund > 0" class="seal-note dim">
          封单金额 = 实时买一价 × 买一量，仅在涨停封板时有效；实时买一队列消失即按开板显示。
        </p>
      </div>

      <div class="detail-section">
        <h4>角色定位</h4>
        <p class="role-explain">{{ roleText }}</p>
      </div>

      <div class="detail-section">
        <h4>数据证据</h4>
        <ul class="detail-list">
          <li v-for="(reason, idx) in pick.reasons" :key="idx">{{ reason }}</li>
        </ul>
      </div>

      <div class="detail-section">
        <h4>风险与瑕疵</h4>
        <ul v-if="pick.risks && pick.risks.length" class="detail-list">
          <li v-for="(risk, idx) in pick.risks" :key="idx" class="risk">{{ risk }}</li>
        </ul>
        <p v-else class="dim small-note">当前未触发硬性风险项，但仍需盘中动态确认。</p>
      </div>

      <div class="detail-section">
        <h4>执行纪律</h4>
        <ul class="detail-list">
          <li v-for="(line, idx) in execution" :key="idx">{{ line }}</li>
        </ul>
        <p class="discipline-line">分歧买入一致卖，高位爆量要收工；破位止损不扛单，退潮空仓莫强攻。</p>
      </div>

      <div class="disclaimer">
        <b>说明：</b>以上为公开行情推导出的观察结论与纪律框架，不含任何收益承诺，也不构成投资建议。
        分数只用于横向比较，未过三关的标的即使分数高，也只做观察。
      </div>
    </template>
  </BottomSheet>
</template>

<style scoped>
.role-explain {
  margin: 0;
  font-size: 10.5px;
  line-height: 1.8;
  color: var(--text-soft);
  padding: 11px;
  border-radius: 10px;
  border: 1px solid var(--line);
  background: rgba(255, 255, 255, 0.022);
}

.small-note {
  font-size: 10px;
  line-height: 1.7;
}

.seal-note {
  margin: 8px 0 0;
  font-size: 9px;
  line-height: 1.65;
}

.discipline-line {
  margin: 9px 0 0;
  padding: 8px 10px;
  border-left: 2px solid var(--gold-line);
  border-radius: 0 7px 7px 0;
  background: rgba(243, 199, 119, 0.05);
  font-family: "STKaiti", "KaiTi", serif;
  font-size: 11.5px;
  letter-spacing: 0.08em;
  line-height: 1.7;
  color: #e8d3a8;
}
</style>