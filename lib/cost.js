/**
 * Cost: turn token buckets into one session-level dollar figure.
 *
 * Deliberately narrow. The panel shows tokens per turn and ONE amount for the
 * whole session — there is no per-turn money, no peak/off-peak discount, and no
 * currency conversion. Every one of those would need a maintained rule that
 * silently drifts from the vendor's real billing; a single number computed from
 * one bundled price table is something a reader can check.
 *
 * The buckets are mutually exclusive (input is the cache-MISS portion), so they
 * are priced separately and summed. That is the same convention the harness's
 * own cost plugin uses when it prices a turn.
 *
 * @module dsh-topic-map/cost
 */

/** Smallest amount worth rendering; below this the panel shows "<$0.0001". */
const DISPLAY_FLOOR = 0.0001

/**
 * Price one turn in USD.
 *
 * @param usage - turn usage buckets.
 * @param price - per-million-token rates; `cacheMiss`/`output` required.
 * @returns the amount in USD, or null when the price is unusable.
 */
export function turnCostUsd(usage, price) {
  if (!usage || !price || !Number.isFinite(price.cacheMiss) || !Number.isFinite(price.output)) {
    return null
  }
  const cacheMiss = price.cacheMiss
  const cacheHit = Number.isFinite(price.cacheHit) ? price.cacheHit : cacheMiss
  const cacheWrite = Number.isFinite(price.cacheWrite) ? price.cacheWrite : cacheHit
  return (
    (usage.input / 1e6) * cacheMiss +
    (usage.cacheRead / 1e6) * cacheHit +
    (usage.cacheWrite / 1e6) * cacheWrite +
    (usage.output / 1e6) * price.output
  )
}

/**
 * Total a session's turns, tolerating unknown models.
 *
 * Never returns a confidently wrong number: a session priced only in part is
 * reported with `unpricedTurns` so the panel can append "+" instead of
 * presenting the partial sum as the bill.
 *
 * @param turns - turn facts, each carrying `usage` and `model`.
 * @param prices - price table keyed by `${provider}/${model}`.
 * @returns the partial total and how many turns could not be priced.
 */
export function sessionCost(turns, prices) {
  let amount = 0
  let unpricedTurns = 0
  let pricedTurns = 0

  for (const turn of Array.isArray(turns) ? turns : []) {
    const key = turn?.model === null || turn?.model === undefined
      ? ''
      : `${turn.model.provider}/${turn.model.model}`
    const price = key === '' ? undefined : prices?.[key]
    const cost = turnCostUsd(turn.usage, price)
    if (cost === null) {
      unpricedTurns += 1
      continue
    }
    amount += cost
    pricedTurns += 1
  }

  return {
    amount: pricedTurns === 0 ? null : amount,
    pricedTurns,
    unpricedTurns,
    partial: unpricedTurns > 0,
  }
}

/**
 * Render an amount for the panel header.
 *
 * @param result - output of `sessionCost`.
 * @returns the label, or null when nothing should be shown.
 */
export function formatCost(result) {
  if (result === null || result.amount === null) return null
  const negative = result.amount < 0
  const value = Math.abs(result.amount)
  let text
  if (value < DISPLAY_FLOOR) {
    text = '<$0.0001'
  } else if (value >= 0.1) {
    // Cents and above: two decimals is what a reader actually compares.
    text = `$${value.toFixed(2)}`
  } else {
    // Below a dime the cents are all zero, so show four decimals instead of a
    // row of $0.00xx values that all look identical.
    text = `$${value.toFixed(4)}`
  }
  return `${negative ? '-' : ''}${text}${result.partial ? ' +' : ''}`
}

/**
 * Render a token count compactly (12.4k, 1.2M).
 * @param n - token count.
 * @returns the compact label.
 */
export function formatTokens(n) {
  const value = Number(n)
  if (!Number.isFinite(value) || value <= 0) return '0'
  if (value < 1000) return String(Math.round(value))
  if (value < 1e6) return `${(value / 1e3).toFixed(1).replace(/\.0$/, '')}k`
  return `${(value / 1e6).toFixed(2).replace(/\.?0+$/, '')}M`
}

/**
 * Render a duration (1m23s, 12s, 1h4m).
 * @param ms - elapsed milliseconds, or null.
 * @returns the label, or an em dash when unknown.
 */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const total = Math.round(ms / 1000)
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  if (minutes < 60) return seconds === 0 ? `${minutes}m` : `${minutes}m${seconds}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h${minutes % 60}m`
}
