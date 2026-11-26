async function request(path, { timeout = 22000 } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const res = await fetch(path, {
      signal: controller.signal,
      headers: { Accept: 'application/json' }
    })
    if (res.status === 404) {
      const port =
        typeof window !== 'undefined' && window.location ? window.location.port : ''
      const host =
        (typeof window !== 'undefined' && window.location && window.location.hostname) ||
        '127.0.0.1'
      if (port === '8787' || port === '8788') {
        throw new Error(
          `接口不存在（404）：当前 ${port} 端口是旧后端，缺少该接口。请改用 http://${host}:8795/ 打开。`
        )
      }
      throw new Error('接口不存在（404）：当前后端是旧版本，请关闭旧服务后重启。')
    }
    let data = null
    try {
      data = await res.json()
    } catch (e) {
      throw new Error(`数据解析失败 (${res.status})`)
    }
    if (!res.ok || data.ok === false) {
      throw new Error((data && data.error) || `请求失败 (${res.status})`)
    }
    return data
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('请求超时，数据源可能繁忙')
    throw err
  } finally {
    clearTimeout(timer)
  }
}

export function getDashboard({ force = false } = {}) {
  return request(`/api/dashboard${force ? '?refresh=1' : ''}`, { timeout: 30000 })
}

export function getQuotes(secids, { seal = false } = {}) {
  if (!secids || !secids.length) return Promise.resolve({ ok: true, quotes: [] })
  return request(
    `/api/quotes?secids=${encodeURIComponent(secids.join(','))}${seal ? '&seal=1' : ''}`,
    { timeout: 8000 }
  )
}

export function getTrend(secid, { compare = false } = {}) {
  return request(
    `/api/trend?secid=${encodeURIComponent(secid)}${compare ? '&compare=1' : ''}`,
    { timeout: 8000 }
  )
}

export function getAuction() {
  return request('/api/auction', { timeout: 18000 })
}

export function getAlerts() {
  return request('/api/alerts', { timeout: 12000 })
}

/* 只读服务端留痕，不触发重新扫描；用于午间 / 收盘后回答“为什么没弹” */
export function getAlertDiagnostics() {
  return request('/api/alert-diagnostics', { timeout: 6000 })
}

export function getRecAudit({ days = 10, force = false } = {}) {
  return request(
    `/api/rec-audit?days=${encodeURIComponent(days)}${force ? '&refresh=1' : ''}`,
    { timeout: 20000 }
  )
}

export function getOvernight() {
  return request('/api/overnight', { timeout: 18000 })
}

export function getDragonProfile({ force = false, days = 30 } = {}) {
  return request(
    `/api/dragon-profile?days=${encodeURIComponent(days)}${force ? '&refresh=1' : ''}`,
    { timeout: 20000 }
  )
}