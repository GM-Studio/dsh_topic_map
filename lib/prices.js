/**
 * Bundled price table lookup.
 *
 * The harness exposes no per-token pricing (`llm` only prices images), so any
 * amount shown anywhere must come from a table shipped with the plugin. This
 * module is that table plus a tolerant lookup: an unknown model yields
 * `undefined`, which the caller turns into "tokens only, no money" rather than
 * guessing.
 *
 * @module dsh-topic-map/prices
 */

/**
 * Rates are USD per million tokens. `cacheMiss` and `output` are required;
 * `cacheHit`/`cacheWrite` fall back to `cacheMiss`/`cacheHit` when absent,
 * matching how vendors without a cache discount publish a single input rate.
 */
const BUILTIN = {
  // DeepSeek direct
  'deepseek/deepseek-chat': { cacheMiss: 0.27, cacheHit: 0.07, output: 1.1 },
  'deepseek/deepseek-reasoner': { cacheMiss: 0.55, cacheHit: 0.14, output: 2.19 },
  'deepseek/deepseek-v4-flash': { cacheMiss: 0.14, cacheHit: 0.028, output: 0.28 },
  'deepseek/deepseek-v4-pro': { cacheMiss: 3, cacheHit: 0.025, output: 6 },
  // The profile routes through a local gateway with its own model ids.
  'agent2api/DeepSeek-Flash': { cacheMiss: 0.14, cacheHit: 0.028, output: 0.28 },
  'agent2api/DeepSeek-V4-Pro': { cacheMiss: 3, cacheHit: 0.025, output: 6 },
  'agent2api/GLM-5.3': { cacheMiss: 0.511, cacheHit: 0.154, output: 2.045 },
  'agent2api/GLM-5.3-Flash': { cacheMiss: 0.1, cacheHit: 0.018, output: 0.35 },
  'agent2api/Kimi-K3.1-Pro': { cacheMiss: 3, cacheHit: 0.3, output: 15 },
  'agent2api/Kimi-K2.8-Preview': { cacheMiss: 0.95, cacheHit: 0.16, output: 4 },
  'agent2api/MiniMax-M3.1-Flash': { cacheMiss: 0.304, cacheHit: 0.076, output: 1.219 },
  'agent2api/Qwen3.8-Max': { cacheMiss: 0.668, cacheHit: 0, output: 4.01 },
}

/** Lookup result memo, keyed by provider/model. */
const memo = new Map()

/**
 * Resolve prices for a set of turns.
 *
 * @param turns - turn facts carrying `model`.
 * @returns a table keyed `${provider}/${model}`, containing only known routes.
 */
export async function lookupPrices(turns) {
  const table = {}
  for (const turn of Array.isArray(turns) ? turns : []) {
    const model = turn?.model
    if (model === null || model === undefined) continue
    const key = `${model.provider}/${model.model}`
    if (key in table) continue
    const price = resolvePrice(key)
    if (price !== undefined) table[key] = price
  }
  return table
}

/** One route lookup, memoized. */
function resolvePrice(key) {
  if (memo.has(key)) return memo.get(key)
  const exact = BUILTIN[key]
  const price = exact ?? fuzzy(key)
  memo.set(key, price)
  return price
}

/**
 * Match a route whose provider differs but whose model id is known.
 *
 * A gateway model id like `agent2api/DeepSeek-Flash` should still price when
 * only `deepseek/deepseek-v4-flash` is listed, but only on an exact model-id
 * match — a substring guess would silently misprice a different tier.
 */
function fuzzy(key) {
  const slash = key.lastIndexOf('/')
  if (slash < 0) return undefined
  const modelId = key.slice(slash + 1).toLowerCase()
  for (const [candidate, price] of Object.entries(BUILTIN)) {
    const candidateModel = candidate.slice(candidate.lastIndexOf('/') + 1).toLowerCase()
    if (candidateModel === modelId) return price
  }
  return undefined
}

/** The raw table, exposed for diagnostics and tests. */
export const PRICE_TABLE = BUILTIN
