<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import AppHeader from './components/AppHeader.vue'
import TabBar from './components/TabBar.vue'
import WarningBar from './components/WarningBar.vue'
import SkeletonView from './components/SkeletonView.vue'
import CatalystSheet from './components/CatalystSheet.vue'
import PickSheet from './components/PickSheet.vue'
import MainlineView from './views/MainlineView.vue'
import PicksView from './views/PicksView.vue'
import EdgeView from './views/EdgeView.vue'
import ReviewView from './views/ReviewView.vue'
import StrategyView from './views/StrategyView.vue'
import { getDashboard, getQuotes } from './lib/api'
import { ui, closeCatalyst, closePick, toast } from './lib/ui'

const TAB_KEY = 'longmai.tab.v1'
const TAB_LIST = ['mainline', 'picks', 'edge', 'review', 'strategy']
const INDEX_SECID = '1.000001'
const savedTab = (() => {
  try {
    return localStorage.getItem(TAB_KEY)
  } catch (e) {
    return null
  }
})()

const active = ref(TAB_LIST.includes(savedTab) ? savedTab : 'mainline')
const dashboard = ref(null)
const loading = ref(true)
const refreshing = ref(false)
const error = ref('')
const quotes = ref({})
const indexQuote = ref(null)
const quoteAt = ref(0)
const polling = ref(false)
const now = ref(new Date())

let dashTimer = null
let quoteTimer = null
let clockTimer = null
let quoteBusy = false
let dashBusy = false
let toastOnError = false

const clock = computed(() =>
  new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(now.value)
)

const isLive = computed(() => !!(dashboard.value && dashboard.value.market && dashboard.value.market.live))
const warnings = computed(() => (dashboard.value && dashboard.value.warnings) || [])
const staleBackend = computed(() => {
  const d = dashboard.value
  return !!(d && !Array.isArray(d.indices))
})
const currentUrl = computed(() => {
  if (typeof window === 'undefined') return 'http://127.0.0.1:8795/'
  return `${window.location.protocol}//${window.location.hostname || '127.0.0.1'}:8795/`
})

const quoteSecids = computed(() => {
  const d = dashboard.value
  if (!d) return []
  const set = new Set([INDEX_SECID])
  for (const pick of d.picks || []) {
    if (pick.secid) set.add(pick.secid)
  }
  for (const secid of d.watchSecids || []) {
    if (/^\d{1,2}\.\d{6}$/.test(String(secid))) set.add(secid)
  }
  if (ui.pick && ui.pick.secid) set.add(ui.pick.secid)
  return Array.from(set)
})

async function loadDashboard({ force = false, silent = false } = {}) {
  if (dashBusy) return
  dashBusy = true
  if (!silent) refreshing.value = true
  try {
    const data = await getDashboard({ force })
    dashboard.value = data
    error.value = ''
    toastOnError = false
    if (!silent && force) toast(`已刷新 · ${data.serverTime || clock.value}`)
  } catch (err) {
    error.value = err.message || '数据读取失败'
    if (!dashboard.value) {
      // 首屏失败保留错误态，交给重试按钮
    } else if (!silent || !toastOnError) {
      toastOnError = true
      toast('刷新失败，保留上一份有效快照', 'warn')
    }
  } finally {
    loading.value = false
    refreshing.value = false
    dashBusy = false
  }
}

async function pollQuotes() {
  if (document.hidden || quoteBusy || !quoteSecids.value.length) return
  quoteBusy = true
  polling.value = true
  try {
    const res = await getQuotes(quoteSecids.value, {
      seal: active.value === 'picks' || !!ui.pick
    })
    if (res && res.quotes && res.quotes.length) {
      const at = res.at || Date.now()
      const next = { ...quotes.value }
      let nextIndex = null
      for (const q of res.quotes) {
        if (!q) continue
        /* 指数代码 000001 与平安银行同码，必须按 secid 单独存放 */
        if (q.secid === INDEX_SECID) {
          nextIndex = { ...q, at }
          continue
        }
        if (q.code) next[q.code] = q
      }
      quotes.value = next
      if (nextIndex) indexQuote.value = nextIndex
      quoteAt.value = at
    }
  } catch (e) {
    /* 单次行情失败静默，保留上一帧 */
  } finally {
    quoteBusy = false
    polling.value = false
  }
}

function scheduleQuotes() {
  clearTimeout(quoteTimer)
  /* 固定节拍：不把请求耗时叠加到下一次等待里 */
  quoteTimer = setTimeout(() => {
    pollQuotes()
    scheduleQuotes()
  }, isLive.value ? 1000 : 15000)
}

function scheduleDashboard() {
  clearTimeout(dashTimer)
  dashTimer = setTimeout(() => {
    if (!document.hidden) loadDashboard({ silent: true })
    scheduleDashboard()
  }, isLive.value ? 10000 : 60000)
}

async function manualRefresh() {
  await loadDashboard({ force: true })
  await pollQuotes()
}

function handleVisibility() {
  if (document.hidden) {
    clearTimeout(dashTimer)
    clearTimeout(quoteTimer)
    return
  }
  loadDashboard({ silent: true })
  pollQuotes()
  scheduleDashboard()
  scheduleQuotes()
}

watch(active, (tab) => {
  try {
    localStorage.setItem(TAB_KEY, tab)
  } catch (e) {
    /* ignore */
  }
  window.scrollTo({ top: 0, behavior: 'smooth' })
})

watch(
  () => quoteSecids.value.join(','),
  () => {
    if (!document.hidden) pollQuotes()
  }
)

onMounted(() => {
  clockTimer = setInterval(() => {
    now.value = new Date()
  }, 1000)
  document.addEventListener('visibilitychange', handleVisibility)
  loadDashboard({ silent: false }).then(() => {
    pollQuotes()
    scheduleQuotes()
    scheduleDashboard()
  })
})

onBeforeUnmount(() => {
  clearTimeout(dashTimer)
  clearTimeout(quoteTimer)
  clearInterval(clockTimer)
  document.removeEventListener('visibilitychange', handleVisibility)
})
</script>

<template>
  <div class="app-shell">
    <AppHeader
      :dashboard="dashboard"
      :clock="clock"
      :refreshing="refreshing"
      @refresh="manualRefresh"
    />

    <div v-if="staleBackend" class="stale-bar">
      <span class="stale-ico">!</span>
      <span class="stale-txt">
        当前连接的是旧后端，缺少上证指数、竞价、隔夜等新接口，页面结果不可信。请改用
        <a :href="currentUrl">{{ currentUrl }}</a> 打开。
      </span>
    </div>

    <WarningBar :items="warnings" />

    <main class="app-main">
      <SkeletonView v-if="loading && !dashboard" />

      <div v-else-if="error && !dashboard" class="view">
        <div class="error-box">
          <div class="glyph">断</div>
          <h3>数据源暂时没有接通</h3>
          <p>
            {{ error }}<br />
            请确认 API 服务已启动（npm run server），或稍后重试。
          </p>
          <button class="btn btn--gold" @click="manualRefresh">重新接入</button>
        </div>
      </div>

      <template v-else-if="dashboard">
        <MainlineView
          v-if="active === 'mainline'"
          :dashboard="dashboard"
          :index-quote="indexQuote"
        />

        <PicksView
          v-else-if="active === 'picks'"
          :dashboard="dashboard"
          :quotes="quotes"
          :quote-at="quoteAt"
          :polling="polling"
        />

        <EdgeView v-else-if="active === 'edge'" :dashboard="dashboard" />

        <ReviewView v-else-if="active === 'review'" :dashboard="dashboard" />

        <StrategyView v-else :dashboard="dashboard" />
      </template>
    </main>

    <TabBar v-model="active" />

    <CatalystSheet :sector="ui.catalystSector" />
    <PickSheet :pick="ui.pick" :quote="ui.pick ? quotes[ui.pick.code] : null" />

    <Transition name="toast">
      <div
        v-if="ui.toast"
        class="toast"
        :class="ui.toast.tone === 'success' ? 'toast--success' : ui.toast.tone === 'warn' ? 'toast--warn' : ''"
      >
        {{ ui.toast.message }}
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.stale-bar {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  margin: 10px 14px 0;
  padding: 9px 10px;
  border-radius: 11px;
  border: 1px solid rgba(255, 111, 97, 0.32);
  background: rgba(255, 111, 97, 0.08);
  color: #ffc9c1;
  font-size: 10.5px;
  line-height: 1.65;
}

.stale-ico {
  flex: 0 0 auto;
  width: 14px;
  height: 14px;
  margin-top: 1px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  border: 1px solid rgba(255, 111, 97, 0.4);
  color: #ff9d90;
  font-family: var(--mono);
  font-size: 8px;
}

.stale-txt {
  min-width: 0;
}

.stale-txt a {
  color: var(--gold);
  text-decoration: underline;
  text-underline-offset: 2px;
  word-break: break-all;
}
</style>