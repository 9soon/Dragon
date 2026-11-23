'use strict'

const { clamp, round, stripLevel, num } = require('./util')

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
        const aLevel2 = a.name.includes('Ⅱ') ? 0 : 1
        const bLevel2 = b.name.includes('Ⅱ') ? 0 : 1
        const aDiff = Math.abs(stripLevel(a.name).length - n.length)
        const bDiff = Math.abs(stripLevel(b.name).length - n.length)
        return aDiff - bDiff || aLevel2 - bLevel2 || b.upCount + b.downCount - (a.upCount + a.downCount)
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

function compactStock(s) {
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
    ztCount: s.ztCount
  }
}

function buildSectors({ pool, prevPool, boards, flowMap, tradeDate }) {
  const groups = groupPools(pool)
  const prevGroups = groupPools(prevPool)
  const { map: todayRanks, sorted: todaySorted } = rankCounts(groups)
  const { map: prevRanks, sorted: prevSorted } = rankCounts(prevGroups)
  const maxToday = Math.max(1, ...Array.from(groups.values()).map((a) => a.length))
  const maxPrev = Math.max(1, ...Array.from(prevGroups.values()).map((a) => a.length))

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
    /* 近似口径只做参考，不解除资金关；资金关只认两日真实净流入 */
    const moneyPass = moneyTwoDay
    const rankToday = todayRanks.get(name) || 99
    const rankPrev = prevCount ? prevRanks.get(name) || 99 : 99

    const countScore = clamp((todayCount / maxToday) * 100, 0, 100)
    const contScore = clamp(
      (prevCount / maxPrev) * 70 + (todayCount >= 3 ? 15 : 0) + (prevCount >= 2 ? 15 : 0),
      0,
      100
    )
    const ladderScore = (high ? 34 : 0) + (mid ? 33 : 0) + (first ? 33 : 0)
    let moneyScore = 30
    if (todayFlow != null) {
      moneyScore = clamp(
        42 +
          todayFlow / 1e8 * 1.1 +
          (yesterdayFlow != null ? yesterdayFlow / 1e8 * 0.7 : 0) +
          (board && Number.isFinite(board.flowPct) ? board.flowPct * 2.5 : 0),
        0,
        100
      )
      if (moneyPass) moneyScore = Math.max(moneyScore, 62)
      if (todayFlow < 0 && yesterdayFlow != null && yesterdayFlow < 0) moneyScore = Math.min(moneyScore, 28)
    }
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
        label: '资金连续流入',
        pass: moneyPass,
        proxy: moneyProxy,
        detail:
          todayFlow == null
            ? '板块资金映射缺失'
            : moneyTwoDay
              ? `今${flowText(todayFlow)} · 昨${flowText(yesterdayFlow)}`
              : moneyProxy
                ? `今${flowText(todayFlow)} · 5日${flowText(board.flow5d)}（近似）`
                : `今${flowText(todayFlow)} · 昨${yesterdayFlow == null ? '--' : flowText(yesterdayFlow)}`
      }
    ]
    const missing = checks.filter((c) => !c.pass).map((c) => c.label)
    if (moneyProxy) missing.push('资金两日确认')
    if (!board) missing.push('板块资金映射')
    const dataReady = continuityPass && complete && moneyTwoDay && !!board
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
        pass: moneyPass
      },
      leader: compactStock(leader),
      stocks: sortedStocks.map(compactStock),
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
  const promoteScore = propagation.overall.rate == null ? 50 : clamp(propagation.overall.rate * 3.2)
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

  return {
    score,
    phaseKey,
    phase: PHASES[phaseKey],
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
    prevPerformance,
    breakdown: [
      { key: 'premium', label: '昨日涨停溢价', value: Math.round(premiumScore), weight: 25 },
      { key: 'limitUp', label: '涨停家数', value: Math.round(limitUpScore), weight: 20 },
      { key: 'height', label: '连板高度', value: Math.round(heightScore), weight: 20 },
      { key: 'blow', label: '封板质量', value: Math.round(blowScore), weight: 20 },
      { key: 'promote', label: '晋级率', value: Math.round(promoteScore), weight: 15 }
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
      !/ST/i.test(mid.name || '') &&
      (mid.floatCap || 0) >= 8e9 &&
      mid.pct != null &&
      mid.pct >= 1
    ) {
      seen.add(mid.code)
      candidates.push(makeMidPick(mid, sector))
    } else {
      const fallbackMid = stocks
        .filter((s) => s.floatCap >= 8e9 && !seen.has(s.code))
        .sort((a, b) => b.floatCap - a.floatCap)[0]
      if (fallbackMid) add(fallbackMid, 'mid')
    }
  }

  return candidates.sort((a, b) => b.score - a.score).slice(0, 8)
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

function buildReview({ sentiment, pool, blowPool, downPool, sectors, prevPool }) {
  const blownTop = blowPool
    .slice()
    .sort((a, b) => b.ztCount - a.ztCount || b.blowCount - a.blowCount)
    .slice(0, 6)
    .map((s) => ({
      code: s.code,
      name: s.name,
      sector: s.sector,
      pct: round(s.pct, 2),
      ztDays: s.ztDays,
      ztCount: s.ztCount,
      blowCount: s.blowCount
    }))
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
  buildSentiment,
  buildPicks,
  buildReview,
  buildLadder,
  matchBoard,
  sealTimeLabel,
  sealMinutesFromOpen,
  ROLE_LABELS,
  PHASES,
  flowText
}