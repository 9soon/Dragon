import { reactive, computed } from 'vue'

export const CATALYST_TYPES = [
  {
    key: 'policy',
    label: '政策级',
    short: '政策',
    desc: '部委 / 地方政府文件、产业规划、税收与补贴落地'
  },
  {
    key: 'industry',
    label: '产业级',
    short: '产业',
    desc: '订单、涨价、技术突破、产能落地、供需格局变化'
  },
  {
    key: 'event',
    label: '事件级',
    short: '事件',
    desc: '并购重组、重要会议、突发事件、海外映射'
  },
  {
    key: 'rumor',
    label: '纯传闻',
    short: '传闻',
    desc: '只有聊天记录 / 小作文 / 无信源脉冲，按口诀直接排除'
  },
  {
    key: 'none',
    label: '暂无催化',
    short: '暂无',
    desc: '还没找到可核实的信息，先放观察池'
  }
]

const STORAGE_KEY = 'longmai.catalysts.v1'

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch (e) {
    return {}
  }
}

const items = reactive(load())

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items))
  } catch (e) {
    /* localStorage 不可用时仅保留本次会话 */
  }
}

export function setCatalyst(sectorKey, payload) {
  if (!sectorKey) return
  items[sectorKey] = {
    type: payload.type,
    note: payload.note || '',
    at: Date.now()
  }
  persist()
}

export function removeCatalyst(sectorKey) {
  delete items[sectorKey]
  persist()
}

export function getCatalyst(sectorKey) {
  return items[sectorKey] || null
}

export function isCatalystValid(entry) {
  return !!entry && ['policy', 'industry', 'event'].includes(entry.type)
}

export function catalystType(key) {
  return CATALYST_TYPES.find((t) => t.key === key) || null
}

export function useCatalysts() {
  const verifiedCount = computed(
    () => Object.values(items).filter((x) => isCatalystValid(x)).length
  )
  return { items, verifiedCount, setCatalyst, removeCatalyst, getCatalyst, isCatalystValid }
}