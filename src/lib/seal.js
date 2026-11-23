/**
 * 涨停封单状态：优先使用 1 秒行情里的腾讯买一队列（仅封板时有效），
 * 行情尚未回传或未请求封单时退回涨停池快照，并明确标记来源。
 */
export function sealState(pick, quote) {
  if (!pick) return null
  const poolFund = Number(pick.sealFund)
  const hasPoolFund = Number.isFinite(poolFund) && poolFund > 0
  const hadSeal = hasPoolFund || (Number(pick.lbc) || 0) > 0

  if (quote && quote.sealed === true && Number(quote.sealFund) > 0) {
    const fund = Number(quote.sealFund)
    const cap = Number(pick.floatCap)
    const ratio =
      Number.isFinite(cap) && cap > 0 ? Math.round((fund / cap) * 10000) / 100 : null
    return { sealed: true, live: true, fund, ratio }
  }

  /* 池内原本封板、实时买一已离开涨停价：按开板提示，不沿用旧封单；
     收盘后买一队列会被清空但价格仍停在涨停，此时退回池快照而不是误报开板 */
  if (quote && quote.sealed === false && hadSeal) {
    const atLimit =
      quote.limitUp != null &&
      quote.price != null &&
      Math.abs(Number(quote.price) - Number(quote.limitUp)) < 0.005
    if (atLimit && hasPoolFund) {
      return {
        sealed: true,
        live: false,
        fund: poolFund,
        ratio: Number.isFinite(Number(pick.sealRatio)) ? Number(pick.sealRatio) : null
      }
    }
    return { sealed: false, live: true, fund: null, ratio: null }
  }

  if (hasPoolFund) {
    return {
      sealed: true,
      live: false,
      fund: poolFund,
      ratio: Number.isFinite(Number(pick.sealRatio)) ? Number(pick.sealRatio) : null
    }
  }
  return null
}