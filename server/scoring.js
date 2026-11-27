'use strict'

const { clamp, round, stripLevel, num, is20cmCode } = require('./util')

const ROLE_LABELS = {
  dragon: '情绪连板龙',
  vanguard: '首板先锋',
  catchup: '补涨龙',
  mid: '趋势中军'
}

const PHASES = {
  ice: {
    label: '冰点退潮',
    tone: 'cold',
    desc: '高度、赚钱效应同时走弱。按口诀：退潮空仓莫强攻。'
  },
  ebb: {
    label: '分歧退潮',
    tone: 'cold',
    desc: '炸板率偏高、连板空间被压缩。只记录，不追高，等修复。'
  },
  mixed: {
    label: '混沌分歧',
    tone: 'neutral',
    desc: '有局部热度但没有绝对主线。无主线，空仓等待。'
  },
  repair: {
    label: '修复发酵',
    tone: 'warm',
    desc: '赚钱效应回升，聚焦数据与催化同时过关的主线核心。'
  },
  feast: {
    label: '主升发酵',
    tone: 'hot',
    desc: '情绪主升也要防一致。分歧买入一致卖，高位爆量要收工。'
  }
}

function sealTimeLabel(v) {
  if (!v) return '--:--'
  const s = String(v).padStart(6, '0')
  return `${s.slice(0, 2)}:${s.slice(2, 4)}`
}

function sealMinutesFromOpen(v) {
  if (!v) return 240
  const s = String(v).padStart(6, '0')
  const h = Number(s.slice(0, 2))
  const m = Number(s.slice(2, 4))
  let mins = h * 60 + m - (9 * 60 + 30)
  if (mins < 0) mins = 0
  if (h >= 13) mins = Math.max(0, mins - 90)
  return clamp(mins, 0, 330)
}

function matchBoard(hybk, boards) {
  if (!hybk) return null
  const n = stripLevel(hybk)
  if (!n) return null
  const rank = (arr) =>
    arr
      .slice()
      .sort((a, b) => {
        const an = stripLevel(a.name)
        const bn = stripLevel(b.name)
        /* 行业名常被截断（计算机设 → 计算机设备），优先选“更长、以它开头”的板块，
         * 避免目录刷新后跳到更宽的“计算机”把资金映射换掉 */
        const aExt = an.startsWith(n) ? 0 : 1
        const bExt = bn.startsWith(n) ? 0 : 1
        const aLevel2 = a.name.includes('Ⅱ') ? 0 : 1
        const bLevel2 = b.name.includes('Ⅱ') ? 0 : 1
        const aDiff = Math.abs(an.length - n.length)
        const bDiff = Math.abs(bn.length - n.length)
        return (
          aExt - bExt ||
          aDiff - bDiff ||
          bn.length - an.length ||
          aLevel2 - bLevel2 ||
          (b.upCount || 0) + (b.downCount || 0) - ((a.upCount || 0) + (a.downCount || 0))
        )
      })[0]
  const exact = boards.filter((b) => stripLevel(b.name) === n)
  if (exact.length) return rank(exact)
  const candidates = boards.filter((b) => {
    const bn = stripLevel(b.name)
    return bn.startsWith(n) || n.startsWith(bn)
  })
  if (!candidates.length) return null
  return rank(candidates)
}

function groupPools(pool) {
  const map = new Map()
  for (const s of pool) {
    const key = s.sector || '未分类'
    if (!map.has(key)) map.set(key, [])
    map.get(key).push(s)
  }
  return map
}

function rankCounts(groups) {
  const sorted = Array.from(groups.entries())
    .map(([name, arr]) => ({ name, count: arr.length }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh'))
  const map = new Map()
  let lastCount = null
  let lastRank = 0
  sorted.forEach((row, idx) => {
    if (row.count !== lastCount) {
      lastRank = idx + 1
      lastCount = row.count
    }
    map.set(row.name, lastRank)
  })
  return { map, sorted }
}

function turnoverScore(t) {
  if (!Number.isFinite(t)) return 55
  if (t < 1) return 72
  if (t < 3) return 82
  if (t <= 20) return 100
  if (t <= 30) return 60
  return 20
}

function sealScore(ratio) {
  return clamp((ratio / 2.5) * 100, 0, 100)
}

function earlyScore(firstSeal) {
  return clamp(100 - sealMinutesFromOpen(firstSeal) * 0.42, 0, 100)
}

function compactStock(s, weak = null) {
  const sealRatio = s.floatCap > 0 ? (s.sealFund / s.floatCap) * 100 : 0
  return {
    code: s.code,
    secid: s.secid,
    market: s.market,
    name: s.name,
    price: round(s.price, 2),
    pct: round(s.pct, 2),
    lbc: s.lbc,
    turnover: round(s.turnover, 2),
    amount: s.amount,
    floatCap: s.floatCap,
    sealFund: s.sealFund,
    sealRatio: round(sealRatio, 2),
    firstSeal: s.firstSeal,
    firstSealLabel: sealTimeLabel(s.firstSeal),
    blowCount: s.blowCount,
    ztDays: s.ztDays,
    ztCount: s.ztCount,
    weak: weak || null
  }
}

/* ------------------------------------------------------------------ *
 * 资金承接 v2：四项证据，至少 3 项成立；资金流只是其中一项
 *  - 主力资金：今 / 昨两日真实净流入（缺失时记 unknown，不硬判通过）
 *  - 量能：板块涨停股成交额相对昨日同股（至少 2 只重叠）
 *  - 封单：涨停股封单总额 / 流通市值合计
 *  - 溢价 / 晋级：昨日涨停股今日平均溢价 + 板块晋级率
 * ------------------------------------------------------------------ */

function moneyEvidence({ sector, quotesByCode, prevPool }) {
  const stats = sector.moneyStats || {}
  const evidence = []

  let fundState = 'unknown'
  let fundText
  if (stats.today != null && stats.yesterday != null) {
    if (stats.today > 0 && stats.yesterday > 0) {
      fundState = 'pass'
      fundText = `今 ${flowText(stats.today)} · 昨 ${flowText(stats.yesterday)}`
    } else {
      fundState = 'fail'
      fundText = `今 ${flowText(stats.today)} · 昨 ${flowText(stats.yesterday)}`
    }
  } else if (stats.today != null) {
    fundText = `今 ${flowText(stats.today)} · 昨缺失`
  } else if (stats.yesterday != null) {
    fundText = `昨 ${flowText(stats.yesterday)} · 今缺失`
  } else {
    fundText = '主力资金明细缺失'
  }
  evidence.push({ key: 'fund', label: '主力资金', state: fundState, text: fundText })

  let amountState = 'unknown'
  let amountText = '重叠样本不足，量能待确认'
  if (stats.amountRatio != null) {
    amountState = stats.amountRatio >= 75 ? 'pass' : 'fail'
    amountText = `涨停股成交额环比 ${round(stats.amountRatio, 0)}%`
  }
  evidence.push({ key: 'amount', label: '量能', state: amountState, text: amountText })

  let sealState = 'unknown'
  let sealText = '封单数据缺失'
  if (stats.sealRatioAgg != null && stats.sealRatioAgg > 0) {
    sealState = stats.sealRatioAgg >= 0.5 ? 'pass' : 'fail'
    sealText = `封单占流通合计 ${round(stats.sealRatioAgg, 2)}%`
  }
  evidence.push({ key: 'seal', label: '封单', state: sealState, text: sealText })

  let premiumState = 'unknown'
  let premiumText = '昨日涨停溢价待行情确认'
  let premium = null
  if (quotesByCode && prevPool && prevPool.length) {
    const group = prevPool.filter((s) => (s.sector || '未分类') === sector.name)
    const quoted = group
      .map((s) => quotesByCode.get(s.code))
      .filter((q) => q && q.pct != null)
    if (quoted.length >= 2) {
      premium = quoted.reduce((sum, q) => sum + q.pct, 0) / quoted.length
      const promotion = stats.promotionRate
      const premiumOk = premium > 0
      const promotionOk = promotion != null && promotion >= 30
      premiumState = premiumOk && promotionOk ? 'pass' : 'fail'
      premiumText =
        `昨日涨停今日 ${round(premium, 2)}%` +
        (promotion == null ? ' · 晋级率待确认' : ` · 晋级 ${round(promotion, 0)}%`)
      if (promotion == null && premiumOk) premiumState = 'unknown'
    }
  }
  evidence.push({ key: 'premium', label: '溢价/晋级', state: premiumState, text: premiumText })

  const known = evidence.filter((e) => e.state !== 'unknown').length
  const passes = evidence.filter((e) => e.state === 'pass').length
  const fundHardFail = fundState === 'fail'
  const premiumHardFail = premium != null && premium <= -2
  const pass = known >= 3 && passes >= 3 && !fundHardFail && !premiumHardFail
  const icons = evidence
    .map((e) => `${e.label}${e.state === 'pass' ? '✓' : e.state === 'fail' ? '✗' : '–'}`)
    .join(' ')

  return {
    pass,
    proxy: !!stats.proxy,
    twoDay: !!stats.twoDay,
    evidence,
    known,
    passes,
    premium,
    detail: `${icons}`,
    fullDetail: evidence.map((e) => `${e.label} ${e.text}`).join('；')
  }
}

function buildSectors({ pool, prevPool, boards, flowMap, tradeDate, weakMap = null }) {
  const groups = groupPools(pool)
  const prevGroups = groupPools(prevPool)
  const { map: todayRanks, sorted: todaySorted } = rankCounts(groups)
  const { map: prevRanks, sorted: prevSorted } = rankCounts(prevGroups)
  const maxToday = Math.max(1, ...Array.from(groups.values()).map((a) => a.length))
  const maxPrev = Math.max(1, ...Array.from(prevGroups.values()).map((a) => a.length))
  const prevByCode = new Map((prevPool || []).map((s) => [s.code, s]))
  const todayCodes = new Set((pool || []).map((s) => s.code))

  const all = []
  for (const [name, stocks] of groups) {
    const sortedStocks = stocks
      .slice()
      .sort(
        (a, b) =>
          b.lbc - a.lbc ||
          (a.firstSeal || 999999) - (b.firstSeal || 999999) ||
          b.sealFund - a.sealFund
      )
    const todayCount = stocks.length
    const prevCount = (prevGroups.get(name) || []).length
    const high = stocks.filter((s) => s.lbc >= 3).length
    const mid = stocks.filter((s) => s.lbc === 2).length
    const first = stocks.filter((s) => s.lbc === 1).length
    const complete = high > 0 && mid > 0 && first > 0
    const maxBoard = Math.max(...stocks.map((s) => s.lbc), 1)
    const board = matchBoard(name, boards)
    const flow = board ? flowMap.get(board.code) : null
    const todayFlow =
      flow && flow.todayFlow != null
        ? flow.todayFlow
        : board && board.todayFlow != null
          ? board.todayFlow
          : null
    const yesterdayFlow = flow && flow.yesterday ? flow.yesterday.main : null
    const moneyTwoDay = todayFlow != null && todayFlow > 0 && yesterdayFlow != null && yesterdayFlow > 0
    const moneyProxy =
      yesterdayFlow == null &&
      !!board &&
      board.flow5d != null &&
      todayFlow != null &&
      todayFlow > 0 &&
      board.flow5d > 0
    /* 资金承接口径：两日净流入只是证据之一，量能 / 封单 / 溢价晋级同样计入 */
    const prevStocks = prevGroups.get(name) || []
    const promoted = prevStocks.filter((s) => todayCodes.has(s.code)).length
    const promotionRate = prevStocks.length ? (promoted / prevStocks.length) * 100 : null
    let amountToday = 0
    let amountPrev = 0
    let amountOverlap = 0
    for (const s of stocks) {
      const prev = prevByCode.get(s.code)
      if (!prev) continue
      if (s.amount > 0 && prev.amount > 0) {
        amountToday += s.amount
        amountPrev += prev.amount
        amountOverlap++
      }
    }
    const amountRatio =
      amountOverlap >= 2 && amountPrev > 0 ? (amountToday / amountPrev) * 100 : null
    const sealFundSum = stocks.reduce((sum, s) => sum + (s.sealFund || 0), 0)
    const capSum = stocks.reduce((sum, s) => sum + (s.floatCap || 0), 0)
    const sealRatioAgg = capSum > 0 ? (sealFundSum / capSum) * 100 : null
    const moneyStats = {
      today: todayFlow,
      yesterday: yesterdayFlow,
      twoDay: moneyTwoDay,
      proxy: moneyProxy,
      prevCount: prevStocks.length,
      promoted,
      promotionRate,
      amountRatio,
      sealRatioAgg
    }
    const moneyCheck = moneyEvidence({ sector: { name, moneyStats }, quotesByCode: null, prevPool })
    const moneyPass = moneyCheck.pass
    const rankToday = todayRanks.get(name) || 99
    const rankPrev = prevCount ? prevRanks.get(name) || 99 : 99

    const countScore = clamp((todayCount / maxToday) * 100, 0, 100)
    const contScore = clamp(
      (prevCount / maxPrev) * 70 + (todayCount >= 3 ? 15 : 0) + (prevCount >= 2 ? 15 : 0),
      0,
      100
    )
    const ladderScore = (high ? 34 : 0) + (mid ? 33 : 0) + (first ? 33 : 0)
    let moneyScore = clamp(30 + moneyCheck.passes * 17 - (moneyCheck.known < 4 ? 5 : 0), 0, 100)
    if (moneyCheck.evidence.some((e) => e.key === 'fund' && e.state === 'fail')) {
      moneyScore = Math.min(moneyScore, 28)
    }
    if (moneyPass) moneyScore = Math.max(moneyScore, 68)
    const leader = sortedStocks[0]
    const heightScore = clamp(
      (maxBoard / 5) * 100 +
        (leader && leader.firstSeal && leader.firstSeal <= 100000 ? 8 : 0) +
        (leader && leader.blowCount === 0 ? 4 : 0),
      0,
      100
    )
    const heat = Math.round(
      0.32 * countScore +
        0.22 * contScore +
        0.24 * ladderScore +
        0.14 * moneyScore +
        0.08 * heightScore
    )

    const continuityPass = todayCount >= 2 && prevCount >= 2 && rankToday <= 8 && rankPrev <= 10
    const checks = [
      {
        key: 'continuity',
        label: '连续2日靠前',
        pass: continuityPass,
        detail: `今${todayCount}家 #${rankToday} · 昨${prevCount}家 #${rankPrev}`
      },
      {
        key: 'ladder',
        label: '梯队完整',
        pass: complete,
        detail: `高${high} · 二${mid} · 首${first}`
      },
      {
        key: 'money',
        label: '资金承接（4项）',
        pass: moneyPass,
        proxy: moneyProxy,
        evidence: moneyCheck.evidence,
        detail: moneyCheck.detail
      }
    ]
    const missing = checks.filter((c) => !c.pass).map((c) => c.label)
    if (moneyProxy) missing.push('资金两日确认')
    if (!board) missing.push('板块资金映射')
    const dataReady = continuityPass && complete && moneyPass && !!board
    const gatesPassed = checks.filter((c) => c.pass && !c.proxy).length

    const group = prevCount >= 2 && todayCount >= 2 ? 'main' : todayCount >= 2 ? 'new' : 'other'

    all.push({
      key: name,
      name,
      heat,
      group,
      todayCount,
      prevCount,
      rankToday,
      rankPrev,
      ladder: { high, mid, first, complete, score: ladderScore },
      maxBoard,
      continuityPass,
      dataReady,
      gatesPassed,
      checks,
      missing,
      board: board
        ? {
            code: board.code,
            name: board.name,
            pct: board.pct,
            flowPct: board.flowPct,
            upCount: board.upCount,
            downCount: board.downCount,
            leadName: board.leadName || (leader ? leader.name : ''),
            leadCode: board.leadCode || (leader ? leader.code : ''),
            leadPct: board.leadPct != null ? board.leadPct : leader ? round(leader.pct, 2) : null
          }
        : null,
      money: {
        today: todayFlow,
        yesterday: yesterdayFlow,
        fiveDay: board ? board.flow5d : null,
        twoDay: moneyTwoDay,
        proxy: moneyProxy,
        pass: moneyPass,
        evidence: moneyCheck.evidence,
        premium: moneyCheck.premium,
        stats: moneyStats
      },
      leader: compactStock(leader, weakMap ? weakMap.get(leader.code) : null),
      stocks: sortedStocks.map((s) => compactStock(s, weakMap ? weakMap.get(s.code) : null)),
      scoreParts: {
        count: Math.round(countScore),
        continuity: Math.round(contScore),
        ladder: Math.round(ladderScore),
        money: Math.round(moneyScore),
        height: Math.round(heightScore)
      },
      boardPct: board ? board.pct : null
    })
  }

  all.sort((a, b) => b.heat - a.heat || b.todayCount - a.todayCount)

  /* 强度排序：先看三关通过数，再看热度 / 高度 / 家数；最强的排最前 */
  const strengthCmp = (a, b) =>
    b.gatesPassed - a.gatesPassed ||
    Number(b.dataReady) - Number(a.dataReady) ||
    b.heat - a.heat ||
    b.maxBoard - a.maxBoard ||
    b.todayCount - a.todayCount
  const mainCandidates = all
    .filter((s) => s.group === 'main')
    .slice()
    .sort(strengthCmp)
    .slice(0, 5)
  /* 新起题材只做观察，按热度排序，不参与强度排序 */
  const newThemes = all.filter((s) => s.group === 'new').slice(0, 5)

  const todayNames = new Set(groups.keys())
  const fading = Array.from(prevGroups.entries())
    .filter(([name, arr]) => arr.length >= 2 && (!todayNames.has(name) || (groups.get(name) || []).length < 2))
    .map(([name, arr]) => {
      const todayStocks = groups.get(name) || []
      const board = matchBoard(name, boards)
      return {
        name,
        prevCount: arr.length,
        todayCount: todayStocks.length,
        maxBoardPrev: Math.max(...arr.map((s) => s.lbc), 1),
        leader: arr.slice().sort((a, b) => b.lbc - a.lbc)[0]?.name || '',
        boardPct: board ? board.pct : null
      }
    })
    .sort((a, b) => b.prevCount - a.prevCount)
    .slice(0, 6)

  return {
    all,
    mainCandidates,
    newThemes,
    fading,
    counts: {
      sectors: all.length,
      mainCandidates: mainCandidates.length,
      dataReady: all.filter((s) => s.dataReady).length,
      newThemes: newThemes.length,
      fading: fading.length
    },
    maxToday,
    maxPrev,
    prevSorted,
    todaySorted
  }
}

/**
 * 行情到位后补上“昨日涨停溢价”证据，并重算资金承接关、热度与排序。
 * 必须在批量行情之后调用一次，否则资金承接只有 3 项证据。
 */
function applySectorEvidence(sectorData, { quotesByCode, prevPool }) {
  if (!sectorData || !Array.isArray(sectorData.all)) return sectorData
  for (const sector of sectorData.all) {
    const money = sector.money || {}
    const moneyStats = {
      ...(money.stats || {}),
      today: money.today != null ? money.today : null,
      yesterday: money.yesterday != null ? money.yesterday : null,
      twoDay: !!money.twoDay,
      proxy: !!money.proxy
    }
    const check = moneyEvidence({
      sector: { ...sector, moneyStats },
      quotesByCode,
      prevPool
    })
    sector.money.pass = check.pass
    sector.money.evidence = check.evidence
    sector.money.premium = check.premium
    const moneyCheck = (sector.checks || []).find((c) => c.key === 'money')
    if (moneyCheck) {
      moneyCheck.pass = check.pass
      moneyCheck.proxy = check.proxy
      moneyCheck.evidence = check.evidence
      moneyCheck.detail = check.detail
    }
    let moneyScore = clamp(30 + check.passes * 17 - (check.known < 4 ? 5 : 0), 0, 100)
    if (check.evidence.some((e) => e.key === 'fund' && e.state === 'fail')) {
      moneyScore = Math.min(moneyScore, 28)
    }
    if (check.pass) moneyScore = Math.max(moneyScore, 68)
    sector.scoreParts.money = Math.round(moneyScore)
    sector.heat = Math.round(
      0.32 * sector.scoreParts.count +
        0.22 * sector.scoreParts.continuity +
        0.24 * sector.scoreParts.ladder +
        0.14 * sector.scoreParts.money +
        0.08 * sector.scoreParts.height
    )
    sector.dataReady =
      sector.continuityPass && sector.ladder.complete && check.pass && !!sector.board
    sector.gatesPassed = (sector.checks || []).filter((c) => c.pass && !c.proxy).length
    const missing = (sector.checks || []).filter((c) => !c.pass).map((c) => c.label)
    if (check.proxy) missing.push('资金两日确认')
    if (!sector.board) missing.push('板块资金映射')
    sector.missing = missing
  }
  sectorData.all.sort((a, b) => b.heat - a.heat || b.todayCount - a.todayCount)
  const strengthCmp = (a, b) =>
    b.gatesPassed - a.gatesPassed ||
    Number(b.dataReady) - Number(a.dataReady) ||
    b.heat - a.heat ||
    b.maxBoard - a.maxBoard ||
    b.todayCount - a.todayCount
  sectorData.mainCandidates = sectorData.all
    .filter((s) => s.group === 'main')
    .slice()
    .sort(strengthCmp)
    .slice(0, 5)
  sectorData.newThemes = sectorData.all
    .filter((s) => s.group === 'new')
    .slice(0, 5)
  sectorData.counts = {
    sectors: sectorData.all.length,
    mainCandidates: sectorData.mainCandidates.length,
    dataReady: sectorData.all.filter((s) => s.dataReady).length,
    newThemes: sectorData.newThemes.length,
    fading: (sectorData.fading || []).length
  }
  return sectorData
}

function summarizeTier(list) {
  const count = list.length
  if (!count) return { count: 0, avg: null, winRate: null }
  const avg = list.reduce((sum, x) => sum + x.pct, 0) / count
  const win = list.filter((x) => x.pct > 0).length
  return {
    count,
    avg: round(avg, 2),
    winRate: round((win / count) * 100, 0)
  }
}

function buildPrevPerformance(prevPool, quotesByCode, todayPool) {
  const todaySet = new Set(todayPool.map((s) => s.code))
  const quoted = []
  let missing = 0
  for (const s of prevPool) {
    const q = quotesByCode.get(s.code)
    if (!q || q.pct == null) {
      missing++
      continue
    }
    quoted.push({
      code: s.code,
      name: s.name,
      lbc: s.lbc,
      sector: s.sector,
      pct: round(q.pct, 2),
      price: q.price,
      limitToday: todaySet.has(s.code)
    })
  }
  const byTier = [
    {
      key: 'first',
      label: '昨日首板',
      ...summarizeTier(quoted.filter((x) => x.lbc === 1))
    },
    {
      key: 'mid',
      label: '昨日二板',
      ...summarizeTier(quoted.filter((x) => x.lbc === 2))
    },
    {
      key: 'high',
      label: '昨日高位',
      ...summarizeTier(quoted.filter((x) => x.lbc >= 3))
    }
  ]
  return {
    ...summarizeTier(quoted),
    quoted: quoted.length,
    total: prevPool.length,
    missing,
    byTier,
    stocks: quoted.sort((a, b) => b.pct - a.pct)
  }
}

function buildPromotion(prevPool, todayPool) {
  const todayMap = new Map(todayPool.map((s) => [s.code, s]))
  const prevFirst = prevPool.filter((s) => s.lbc === 1)
  const prevCont = prevPool.filter((s) => s.lbc >= 2)
  const firstPromoted = prevFirst.filter((s) => {
    const t = todayMap.get(s.code)
    return t && t.lbc >= 2
  })
  const contPromoted = prevCont.filter((s) => todayMap.has(s.code))
  /* 主板口径：与选股 / 推荐一致，剔除双创 20cm 与 ST。
   * 防守信号不能拿系统根本不交易的票来判，否则会被 20cm 的低晋级率拖进空仓。 */
  const corePrev = prevPool.filter(
    (s) => !is20cmCode(s.code) && !/ST/i.test(s.name || '')
  )
  const corePromoted = corePrev.filter((s) => todayMap.has(s.code))
  return {
    first: {
      total: prevFirst.length,
      promoted: firstPromoted.length,
      rate: prevFirst.length ? round((firstPromoted.length / prevFirst.length) * 100, 0) : null
    },
    continuation: {
      total: prevCont.length,
      promoted: contPromoted.length,
      rate: prevCont.length ? round((contPromoted.length / prevCont.length) * 100, 0) : null
    },
    overall: {
      total: prevFirst.length + prevCont.length,
      promoted: firstPromoted.length + contPromoted.length,
      rate:
        prevFirst.length + prevCont.length
          ? round(
              ((firstPromoted.length + contPromoted.length) /
                (prevFirst.length + prevCont.length)) *
                100,
              0
            )
          : null
    },
    core: {
      total: corePrev.length,
      promoted: corePromoted.length,
      rate: corePrev.length ? round((corePromoted.length / corePrev.length) * 100, 0) : null
    }
  }
}

function buildSentiment({
  pool,
  blowPool,
  downPool,
  prevPool,
  quotesByCode,
  skipPremium = false
}) {
  const limitUp = pool.length
  const blown = blowPool.length
  const limitDown = downPool.length
  const blowRate = limitUp + blown > 0 ? round((blown / (limitUp + blown)) * 100, 0) : 0
  const maxBoard = pool.length ? Math.max(...pool.map((s) => s.lbc)) : 0
  const propagation = buildPromotion(prevPool, pool)
  const prevPerformance = skipPremium
    ? {
        count: 0,
        avg: null,
        winRate: null,
        quoted: 0,
        total: prevPool.length,
        missing: prevPool.length,
        byTier: [],
        stocks: []
      }
    : buildPrevPerformance(prevPool, quotesByCode, pool)

  const premiumAvg = prevPerformance.avg
  const limitUpScore = clamp((limitUp / 80) * 100)
  const heightScore = clamp((maxBoard / 6) * 100)
  const premiumScore = premiumAvg == null ? 50 : clamp(((premiumAvg + 3) / 9) * 100)
  const blowScore = clamp(100 - blowRate * 1.35)
  /* 晋级率统一用主板口径（00/60，剔除 ST / 双创 20cm），与选股范围一致；
   * 样本太小时退回全市场，并明确标注口径。 */
  const corePromotion = propagation.core
  const coreReady = !!(corePromotion && corePromotion.total >= 10)
  const promoteRate = coreReady ? corePromotion.rate : propagation.overall.rate
  const promoteBasis = coreReady ? 'core' : 'overall'
  const promoteScore = promoteRate == null ? 50 : clamp(promoteRate * 3.2)
  const score = Math.round(
    0.2 * limitUpScore +
      0.2 * heightScore +
      0.25 * premiumScore +
      0.2 * blowScore +
      0.15 * promoteScore
  )

  let phaseKey = 'mixed'
  if (score < 30) phaseKey = 'ice'
  else if (blowRate >= 45 || (maxBoard <= 2 && (premiumAvg == null || premiumAvg < 0))) phaseKey = 'ebb'
  else if (score >= 72 && blowRate < 24) phaseKey = 'feast'
  else if (score >= 55) phaseKey = 'repair'

  const tierCounts = {
    first: pool.filter((s) => s.lbc === 1).length,
    mid: pool.filter((s) => s.lbc === 2).length,
    high: pool.filter((s) => s.lbc >= 3).length
  }

  /* 进攻 / 防守信号：给“能不能打板”一个独立于主线的环境判断 */
  const attack =
    promoteRate != null &&
    promoteRate >= 35 &&
    blowRate < 35 &&
    premiumAvg != null &&
    premiumAvg >= 0 &&
    maxBoard >= 3 &&
    tierCounts.first > 0 &&
    tierCounts.mid > 0
  const defense =
    blowRate >= 45 ||
    (promoteRate != null && promoteRate < 25) ||
    (premiumAvg != null && premiumAvg < 0 && blowRate >= 30)
  const promoText = coreReady
    ? `主板晋级率 ${promoteRate}%（${corePromotion.promoted}/${corePromotion.total}），全市场 ${propagation.overall.rate}%`
    : `晋级率 ${promoteRate == null ? '--' : promoteRate + '%'}`
  const attackGaps = []
  if (promoteRate == null || promoteRate < 35) attackGaps.push('主板晋级率 <35%')
  if (blowRate >= 35) attackGaps.push('炸板率 ≥35%')
  if (premiumAvg == null || premiumAvg < 0) attackGaps.push('溢价 <0')
  if (maxBoard < 3) attackGaps.push('最高板 <3')
  if (!tierCounts.first) attackGaps.push('无首板')
  if (!tierCounts.mid) attackGaps.push('无二板')
  const signal = {
    attack,
    defense,
    label: attack ? '进攻窗口' : defense ? '防守窗口' : '观察窗口',
    rate: promoteRate,
    overallRate: propagation.overall.rate,
    basis: promoteBasis,
    note: attack
      ? `${promoText}，溢价 ${premiumAvg}%，炸板率 ${blowRate}%，可只在最强核心上试错。`
      : defense
        ? `炸板率 ${blowRate}%，${promoText}，溢价 ${premiumAvg == null ? '--' : premiumAvg + '%'}，优先降频与控制回撤。`
        : `${promoText}，炸板率 ${blowRate}%，${
            attackGaps.length ? `进攻条件还差：${attackGaps.join('、')}。` : '等最强核心确认。'
          }`
  }

  return {
    score,
    phaseKey,
    phase: PHASES[phaseKey],
    signal,
    limitUp,
    limitDown,
    blown,
    blowRate,
    maxBoard,
    tierCounts,
    premium: {
      avg: prevPerformance.avg,
      winRate: prevPerformance.winRate,
      quoted: prevPerformance.quoted,
      total: prevPerformance.total,
      missing: prevPerformance.missing,
      skip: skipPremium
    },
    promotion: propagation,
    promotionCore: coreReady ? corePromotion : null,
    promotionBasis: promoteBasis,
    prevPerformance,
    breakdown: [
      { key: 'premium', label: '昨日涨停溢价', value: Math.round(premiumScore), weight: 25 },
      { key: 'limitUp', label: '涨停家数', value: Math.round(limitUpScore), weight: 20 },
      { key: 'height', label: '连板高度', value: Math.round(heightScore), weight: 20 },
      { key: 'blow', label: '封板质量', value: Math.round(blowScore), weight: 20 },
      { key: 'promote', label: coreReady ? '主板晋级率' : '晋级率', value: Math.round(promoteScore), weight: 15 }
    ]
  }
}

function makePoolPick(stock, role, sector, quote) {
  const price = quote && quote.price != null ? quote.price : stock.price
  const pct = quote && quote.pct != null ? quote.pct : stock.pct
  const turnover = quote && quote.turnover != null ? quote.turnover : stock.turnover
  const mainInflow = quote ? quote.mainInflow : null
  const mainPct = quote ? quote.mainPct : null
  const ratio = stock.sealRatio
  const sBoard = clamp((stock.lbc / 5) * 100, 15, 100)
  const sSeal = sealScore(ratio)
  const sEarly = earlyScore(stock.firstSeal)
  const sTurn = turnoverScore(turnover)
  const capFit = clamp(100 - Math.max(0, stock.floatCap / 1e8 - 240) / 3.2, 35, 100)
  const penalties =
    stock.blowCount * 7 +
    (stock.firstSeal >= 140000 ? 10 : 0) +
    (stock.lbc >= 4 && turnover >= 25 ? 18 : 0) +
    (ratio < 0.4 ? 7 : 0)

  const livePct = quote && quote.pct != null ? quote.pct : stock.pct
  const midCapFit = clamp(100 - Math.abs(stock.floatCap / 1e8 - 220) / 2.4, 25, 100)
  let roleScore = 0
  if (role === 'dragon') {
    roleScore = 0.42 * sBoard + 0.26 * sSeal + 0.2 * sEarly + 0.12 * sTurn - penalties
  } else if (role === 'catchup') {
    roleScore = 0.36 * sEarly + 0.28 * sSeal + 0.22 * sTurn + 0.14 * capFit - penalties
  } else if (role === 'mid') {
    roleScore =
      0.4 * clamp(((livePct + 1) / 8) * 100) +
      0.3 * sTurn +
      0.3 * midCapFit -
      penalties * 0.4
  } else {
    roleScore = 0.34 * sEarly + 0.26 * sSeal + 0.24 * sTurn + 0.16 * capFit - penalties
  }

  const passed = sector.checks.filter((c) => c.pass).length
  const readiness = sector.dataReady ? 100 : Math.round((passed / 3) * 55)
  const roleBonus = role === 'dragon' ? 4 : role === 'mid' ? 2 : role === 'vanguard' ? -1 : 0
  let score = 0.54 * clamp(roleScore) + 0.3 * sector.heat + 0.16 * readiness + roleBonus
  if (!sector.dataReady) score = Math.min(score, 68)
  if (sector.group === 'new') score = Math.min(score, 60)
  score = Math.round(clamp(score, 0, 99))

  const observation = !sector.dataReady
  const reasons = [
    `「${sector.name}」热度 ${sector.heat}`,
    `2日涨停 ${sector.todayCount}+${sector.prevCount} 家`,
    `梯队 高${sector.ladder.high}·二${sector.ladder.mid}·首${sector.ladder.first}`,
    `${stock.lbc}板 · ${stock.firstSealLabel}封板 · 封单占流通 ${ratio.toFixed(1)}%`
  ]
  if (sector.money.twoDay) reasons.push('板块资金连续2日净流入')
  if (mainInflow != null && mainInflow > 0) reasons.push(`个股主力净流入 ${flowText(mainInflow)}`)

  const risks = []
  if (stock.blowCount > 0) risks.push(`炸板 ${stock.blowCount} 次，封板稳定性待确认`)
  if (ratio < 0.5) risks.push(`封单偏薄（${ratio.toFixed(2)}% 流通盘）`)
  if (turnover > 30) risks.push(`换手 ${turnover.toFixed(1)}% 过热`)
  if (stock.lbc >= 4 && turnover >= 25) risks.push('高位爆量，按口诀“要收工”')
  if (stock.firstSeal >= 140000) risks.push('14:00 后封板，主动性不足')
  if (sector.group === 'new') risks.push('新起题材仅 1 日，需第二日确认持续性')
  if (!sector.dataReady) risks.push(`数据闸门未过：${sector.missing.join('、')}`)
  if (stock.lbc >= 4) risks.push('高位加速，分歧时波动放大')

  const tags = []
  if (stock.firstSeal && stock.firstSeal <= 100000) tags.push('早盘封板')
  if (ratio >= 2) tags.push('封单强')
  if (turnover >= 3 && turnover <= 20) tags.push('良性换手')
  if (stock.lbc >= 3) tags.push('高位连板')
  if (stock.floatCap >= 150e8) tags.push('大市值')
  if (mainPct != null && mainPct >= 5) tags.push('资金抢筹')

  return {
    code: stock.code,
    secid: stock.secid,
    name: stock.name,
    role,
    roleLabel: ROLE_LABELS[role],
    sector: sector.name,
    sectorKey: sector.key,
    observation,
    score,
    price: round(price, 2),
    pct: round(pct, 2),
    lbc: stock.lbc,
    turnover: round(turnover, 2),
    amount: stock.amount,
    floatCap: stock.floatCap,
    mainInflow,
    mainPct,
    sealFund: stock.sealFund,
    sealRatio: round(ratio, 2),
    firstSeal: stock.firstSeal,
    firstSealLabel: stock.firstSealLabel,
    blowCount: stock.blowCount,
    tags,
    reasons: reasons.slice(0, 5),
    risks: risks.slice(0, 4),
    weak: stock.weak || null,
    source: 'pool'
  }
}

function makeMidPick(q, sector) {
  const cap = q.floatCap || 0
  const pctScore = clamp(((q.pct + 1) / 8) * 100)
  const flowScore = clamp(50 + (q.mainPct || 0) * 4 + (q.mainInflow || 0) / 1e9 * 1.5)
  const mcapFit = clamp(100 - Math.abs(cap / 1e8 - 220) / 2.4, 25, 100)
  const roleScore = 0.4 * pctScore + 0.35 * flowScore + 0.25 * mcapFit
  const passed = sector.checks.filter((c) => c.pass).length
  const readiness = sector.dataReady ? 100 : Math.round((passed / 3) * 55)
  let score = 0.54 * clamp(roleScore) + 0.3 * sector.heat + 0.16 * readiness
  if (!sector.dataReady) score = Math.min(score, 64)
  if (sector.group === 'new') score = Math.min(score, 58)
  score = Math.round(clamp(score, 0, 99))
  const risks = []
  if (!sector.dataReady) risks.push(`数据闸门未过：${sector.missing.join('、')}`)
  if (q.pct < 3) risks.push('中军涨幅偏弱，尚未形成带动')
  if (q.mainInflow != null && q.mainInflow < 0) risks.push('大单资金净流出')
  return {
    code: q.code,
    secid: q.secid || `${/^6/.test(q.code) ? 1 : 0}.${q.code}`,
    name: q.name,
    role: 'mid',
    roleLabel: ROLE_LABELS.mid,
    sector: sector.name,
    sectorKey: sector.key,
    observation: !sector.dataReady,
    score,
    price: round(q.price, 2),
    pct: round(q.pct, 2),
    lbc: 0,
    turnover: round(q.turnover, 2),
    amount: q.amount,
    floatCap: cap,
    mainInflow: q.mainInflow,
    mainPct: q.mainPct,
    sealFund: 0,
    sealRatio: 0,
    firstSeal: 0,
    firstSealLabel: '--:--',
    blowCount: 0,
    tags: ['大市值', q.pct >= 5 ? '趋势加速' : '趋势中军', q.mainPct >= 5 ? '资金抢筹' : ''].filter(Boolean),
    reasons: [
      `「${sector.name}」热度 ${sector.heat}`,
      `${round(q.floatCap / 1e8, 0)}亿流通市值，板块中军`,
      `实时涨幅 ${round(q.pct, 2)}%`,
      q.mainInflow != null ? `个股主力净流入 ${flowText(q.mainInflow)}` : '资金数据读取中'
    ],
    risks: risks.slice(0, 3),
    source: 'constituent'
  }
}

function buildPicks({ sectors, quotesByCode }) {
  const candidates = []
  const seen = new Set()
  const sectorsForPicks = sectors
    .filter((s) => s.group === 'main' || s.group === 'new')
    .sort((a, b) => b.heat - a.heat)
    .slice(0, 6)

  for (const sector of sectorsForPicks) {
    const stocks = sector.stocks
      .filter((s) => !/ST/i.test(s.name))
      .slice()
      .sort(
        (a, b) =>
          b.lbc - a.lbc ||
          (a.firstSeal || 999999) - (b.firstSeal || 999999) ||
          b.sealFund - a.sealFund
      )
    if (!stocks.length) continue
    const leader = stocks[0]
    const leaderRole = sector.maxBoard >= 2 ? 'dragon' : 'vanguard'
    const add = (stock, role) => {
      if (!stock || seen.has(stock.code) || /ST/i.test(stock.name)) return
      /* 20cm（科创板 688/689、创业板 300/301）不进入选股推荐 */
      if (is20cmCode(stock.code)) return
      const quote = quotesByCode.get(stock.code)
      const pick = makePoolPick(stock, role, sector, quote)
      seen.add(stock.code)
      candidates.push(pick)
    }
    add(leader, leaderRole)
    if (sector.maxBoard >= 2) {
      const catchups = stocks.filter((s) => s.lbc === 1).slice(0, 2)
      catchups.forEach((s) => add(s, 'catchup'))
    } else {
      const second = stocks.find((s) => s.code !== leader.code)
      if (second) add(second, 'vanguard')
    }

    const leadCode = sector.board ? sector.board.leadCode : null
    const mid = leadCode ? quotesByCode.get(leadCode) : null
    if (
      mid &&
      !seen.has(mid.code) &&
      !is20cmCode(mid.code) &&
      !/ST/i.test(mid.name || '') &&
      (mid.floatCap || 0) >= 8e9 &&
      mid.pct != null &&
      mid.pct >= 1
    ) {
      seen.add(mid.code)
      candidates.push(makeMidPick(mid, sector))
    } else {
      const fallbackMid = stocks
        .filter((s) => s.floatCap >= 8e9 && !seen.has(s.code) && !is20cmCode(s.code))
        .sort((a, b) => b.floatCap - a.floatCap)[0]
      if (fallbackMid) add(fallbackMid, 'mid')
    }
  }

  return candidates.sort((a, b) => b.score - a.score).slice(0, 12)
}

function buildLadder(pool) {
  const buckets = new Map()
  for (const s of pool) {
    const k = Math.min(s.lbc, 7)
    if (!buckets.has(k)) buckets.set(k, [])
    buckets.get(k).push(s)
  }
  return Array.from(buckets.entries())
    .sort((a, b) => b[0] - a[0])
    .map(([lbc, list]) => ({
      lbc,
      /* 7 层以上合并展示时必须标 +，否则 8 板会被误读成 7 板 */
      capped: list.some((s) => s.lbc > 7),
      count: list.length,
      stocks: list
        .slice()
        .sort((a, b) => (a.firstSeal || 999999) - (b.firstSeal || 999999))
        .slice(0, 8)
        .map((s) => ({
          code: s.code,
          name: s.name,
          sector: s.sector,
          firstSealLabel: sealTimeLabel(s.firstSeal),
          pct: round(s.pct, 2)
        }))
    }))
}

/**
 * 昨日连板天梯的今日去向。
 * 晋级 = 今日仍在涨停池且高度提升；淘汰 = 今日不在涨停池；
 * 炸板 / 跌停 / 未封 只是当前快照状态，盘中回封会自动回到天梯。
 */
function buildLadderFlow(prevPool = [], pool = [], blowPool = [], downPool = [], quotesByCode = new Map()) {
  const todayMap = new Map((pool || []).map((s) => [s.code, s]))
  const blowSet = new Set((blowPool || []).map((s) => s.code))
  const downSet = new Set((downPool || []).map((s) => s.code))
  const buckets = new Map()
  const eliminatedStocks = []
  let promoted = 0
  let retained = 0
  let blown = 0

  for (const s of prevPool || []) {
    const today = todayMap.get(s.code)
    const advanced = !!(today && today.lbc > s.lbc)
    const stillSealed = !!(today && !advanced)
    const key = Math.min(s.lbc, 7)
    if (!buckets.has(key)) {
      buckets.set(key, {
        lbc: key,
        total: 0,
        promoted: 0,
        retained: 0,
        eliminated: 0,
        blown: 0,
        capped: false
      })
    }
    const bucket = buckets.get(key)
    if (s.lbc > 7) bucket.capped = true
    bucket.total++
    if (advanced) {
      bucket.promoted++
      promoted++
      continue
    }
    if (stillSealed) {
      /* 仍在涨停池但高度没有提升，属于数据异常，不算晋级也不算淘汰 */
      bucket.retained++
      retained++
      continue
    }
    bucket.eliminated++
    const isBlown = blowSet.has(s.code)
    if (isBlown) {
      bucket.blown++
      blown++
    }
    if (s.lbc < 2) continue
    const q = quotesByCode ? quotesByCode.get(s.code) : null
    let status = 'unsealed'
    let statusLabel = '未封'
    if (isBlown) {
      status = 'blown'
      statusLabel = '炸板'
    } else if (downSet.has(s.code)) {
      status = 'limitDown'
      statusLabel = '跌停'
    } else if (!q || q.pct == null) {
      status = 'noQuote'
      statusLabel = '待报价'
    }
    eliminatedStocks.push({
      code: s.code,
      name: s.name,
      sector: s.sector,
      secid: s.secid,
      lbc: s.lbc,
      pct: q && q.pct != null ? round(q.pct, 2) : null,
      status,
      statusLabel
    })
  }

  const rows = Array.from(buckets.values())
    .sort((a, b) => b.lbc - a.lbc)
    .map((row) => ({
      ...row,
      label: row.lbc === 1 ? '首板' : `${row.lbc}板${row.capped ? '+' : ''}`,
      rate: row.total ? round((row.promoted / row.total) * 100, 0) : null
    }))

  eliminatedStocks.sort(
    (a, b) =>
      b.lbc - a.lbc ||
      (b.pct == null ? -999 : b.pct) - (a.pct == null ? -999 : a.pct) ||
      a.name.localeCompare(b.name, 'zh')
  )

  return {
    prevReady: (prevPool || []).length > 0,
    total: (prevPool || []).length,
    promoted,
    retained,
    eliminated: Math.max(0, (prevPool || []).length - promoted - retained),
    blown,
    rows,
    stocks: eliminatedStocks
  }
}

function buildReview({ sentiment, pool, blowPool, downPool, sectors, prevPool, quotesByCode }) {
  const quoteMap = quotesByCode || new Map()
  const blownTop = blowPool
    .slice()
    .sort((a, b) => b.ztCount - a.ztCount || b.blowCount - a.blowCount)
    .slice(0, 6)
    .map((s) => {
      const q = quoteMap.get(s.code)
      const turnover = q && q.turnover != null ? round(q.turnover, 2) : null
      const mainInflow = q && q.mainInflow != null ? q.mainInflow : null
      const heavy = turnover != null && turnover >= 15
      const outflow = mainInflow != null && mainInflow < 0
      const riskLabel = heavy && outflow
        ? '放量炸板 · 主力净流出'
        : heavy
          ? '放量炸板'
          : outflow
            ? '炸板 · 主力净流出'
            : '炸板'
      return {
        code: s.code,
        name: s.name,
        sector: s.sector,
        pct: round(s.pct, 2),
        ztDays: s.ztDays,
        ztCount: s.ztCount,
        blowCount: s.blowCount,
        turnover,
        mainInflow,
        riskLabel
      }
    })
  const downTop = downPool.slice(0, 5).map((s) => ({
    code: s.code,
    name: s.name,
    sector: s.sector,
    pct: round(s.pct, 2)
  }))
  const distribution = sectors
    .slice()
    .sort((a, b) => b.todayCount - a.todayCount || b.heat - a.heat)
    .slice(0, 10)
    .map((s) => ({
      name: s.name,
      todayCount: s.todayCount,
      prevCount: s.prevCount,
      heat: s.heat,
      maxBoard: s.maxBoard,
      moneyToday: s.money.today,
      dataReady: s.dataReady
    }))
  return {
    ladder: buildLadder(pool),
    ladderFlow: buildLadderFlow(prevPool, pool, blowPool, downPool, quoteMap),
    blownTop,
    downTop,
    distribution,
    prevPremium: sentiment.prevPerformance,
    promotion: sentiment.promotion
  }
}

function flowText(v) {
  if (v == null || !Number.isFinite(v)) return '--'
  const abs = Math.abs(v)
  if (abs >= 1e8) return `${v < 0 ? '-' : ''}${round(abs / 1e8, 2)}亿`
  if (abs >= 1e4) return `${v < 0 ? '-' : ''}${round(abs / 1e4, 0)}万`
  return `${round(v, 0)}`
}

module.exports = {
  buildSectors,
  applySectorEvidence,
  buildSentiment,
  buildPicks,
  buildReview,
  buildLadder,
  buildLadderFlow,
  matchBoard,
  sealTimeLabel,
  sealMinutesFromOpen,
  ROLE_LABELS,
  PHASES,
  flowText
}