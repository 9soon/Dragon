<script setup>
import { computed } from 'vue'

const props = defineProps({
  dashboard: { type: Object, default: null },
  clock: { type: String, default: '--:--:--' },
  refreshing: { type: Boolean, default: false },
  unreadAlerts: { type: Number, default: 0 },
  alertEnabled: { type: Boolean, default: true }
})

defineEmits(['refresh', 'open-alerts'])

const market = computed(() => (props.dashboard && props.dashboard.market) || null)
const live = computed(() => !!(market.value && market.value.live))

const mode = computed(() => {
  const d = props.dashboard
  if (!d) return { key: 'loading', label: '接入中' }
  if (d.dataMode === 'stale') return { key: 'stale', label: '缓存' }
  if (d.dataMode === 'review') return { key: 'review', label: '复盘' }
  return { key: 'live', label: '实时' }
})

const metaLabel = computed(() => {
  const d = props.dashboard
  if (!d) return '正在读取涨停池与板块梯队'
  return `${d.tradeDateLabel || ''}${d.awaitingToday ? ' · 今日待更新' : ''}`
})
</script>

<template>
  <header class="app-header">
    <div class="header-top">
      <div class="brand">
        <div class="brand-mark" aria-hidden="true">
          <svg viewBox="0 0 48 48">
            <circle cx="24" cy="24" r="19.5" fill="none" stroke="#f3c777" stroke-opacity=".26" />
            <circle cx="24" cy="24" r="13" fill="none" stroke="#ff5460" stroke-opacity=".42" />
            <path
              d="M9 30c5.4-1.6 7.8-8.2 14.2-8.2 6.1 0 8.1 5.6 15.8 3.4"
              fill="none"
              stroke="#ff5460"
              stroke-width="1.4"
              stroke-linecap="round"
            />
            <circle cx="24" cy="24" r="3.1" fill="#ff5460" />
            <path
              d="M24 4v6.2M24 37.8V44M4 24h6.2M37.8 24H44"
              stroke="#f3c777"
              stroke-width="2"
              stroke-linecap="round"
              opacity=".8"
            />
          </svg>
        </div>
        <div class="brand-copy">
          <div class="brand-name">龙脉 <em>LONGMAI</em></div>
          <div class="brand-sub">先定主线 · 再选龙头</div>
        </div>
      </div>

      <div class="header-side">
        <span class="market-pill" :class="{ 'market-pill--live': live }">
          <i class="dot" :class="live ? 'dot--live' : 'dot--gold'"></i>
          {{ market ? (live ? market.label : market.snapshotLabel || market.label) : '接入中' }}
        </span>
        <button
          class="icon-btn alert-btn"
          :class="{ 'has-unread': unreadAlerts > 0, 'is-off': !alertEnabled }"
          aria-label="打开实时预警中心"
          @click="$emit('open-alerts')"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
            <path
              d="M18 8.6a6 6 0 1 0-12 0c0 4.2-1.6 5.7-1.6 5.7h15.2S18 12.8 18 8.6Z"
              stroke-linejoin="round"
            />
            <path d="M9.6 18.4a2.4 2.4 0 0 0 4.8 0" stroke-linecap="round" />
          </svg>
          <span v-if="unreadAlerts > 0" class="alert-badge">
            {{ unreadAlerts > 9 ? '9+' : unreadAlerts }}
          </span>
          <i v-else-if="!alertEnabled" class="alert-off-dot" aria-hidden="true"></i>
        </button>
        <button
          class="icon-btn"
          :class="{ 'is-spinning': refreshing }"
          aria-label="刷新数据"
          :disabled="refreshing"
          @click="$emit('refresh')"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
            <path d="M20 11a8 8 0 1 0-2.3 6.3" stroke-linecap="round" />
            <path d="M20 5v6h-6" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
      </div>
    </div>

    <div class="header-meta">
      <span class="mode-tag" :class="`mode-tag--${mode.key}`">
        <i class="dot" :class="mode.key === 'live' ? 'dot--live' : 'dot--gold'"></i>
        {{ mode.label }}
      </span>
      <strong>{{ metaLabel }}</strong>
      <span class="sep"></span>
      <span>价格 1s · 榜单 10s</span>
      <span v-if="dashboard && dashboard.cacheAge != null" class="sep"></span>
      <span v-if="dashboard && dashboard.cacheAge != null">缓存 {{ dashboard.cacheAge }}s</span>
      <span class="clock mono">{{ clock }}</span>
    </div>
  </header>
</template>

<style scoped>
.alert-btn {
  position: relative;
}

.alert-btn.has-unread {
  color: #ffd7da;
  border-color: rgba(255, 84, 96, 0.42);
  background: rgba(255, 84, 96, 0.12);
}

.alert-btn.is-off {
  color: var(--dim);
}

.alert-badge {
  position: absolute;
  top: -5px;
  right: -5px;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  display: grid;
  place-items: center;
  border-radius: 99px;
  border: 1px solid rgba(10, 12, 18, 0.9);
  background: var(--up);
  color: #fff;
  font-family: var(--mono);
  font-size: 9.5px;
  font-weight: 700;
  line-height: 1;
  letter-spacing: 0;
  box-shadow: 0 2px 9px rgba(255, 84, 96, 0.45);
}

.alert-off-dot {
  position: absolute;
  top: 6px;
  right: 6px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--dim);
  border: 1px solid rgba(10, 12, 18, 0.9);
}

@media (max-width: 430px) {
  .brand-sub {
    display: none;
  }
}
</style>