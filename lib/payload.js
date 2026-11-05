/**
 * Payload assembly: raw events in, renderable session payload out.
 *
 * Kept separate from the Host entry so the whole pipeline — fold, segment,
 * lay out, price — can be exercised in Node without a running harness. The Host
 * half then owns only I/O: read the log, call this, cache the result.
 *
 * @module dsh-topic-map/payload
 */

import { buildTurnModel, cumulativeUsage } from './turn-model.js'
import { assignLanes, applyOverrides, ENGINE_VERSION } from './lane-engine.js'
import { buildGraph } from './graph-layout.js'
import { sessionCost, formatCost } from './cost.js'
import { lookupPrices } from './prices.js'

/**
 * 给每条泳道附上它包含轮次的提问摘要。
 *
 * 为什么要下发：面板左栏的搜索框号称能搜"对话内容"（filter.js 里
 * `if (Array.isArray(lane.turnTexts)) parts.push(...)`），但 Host 从来
 * 没有下发过这个字段——那个分支永远不执行，等于空头承诺。
 *
 * 预算控制：每条泳道最多 8 轮、每轮 80 字。整条泳道最多 640 字，
 * 十几条泳道也就几 KB，不影响传输。太多会撑大 payload 且对搜索帮助不大
 * （搜到的位置越靠后越可能是噪音）。
 *
 * @param lanes - 泳道数组。
 * @param turns - 轮次事实数组。
 * @returns 新泳道数组（不修改入参）。
 */
function attachTurnTexts(lanes, turns) {
  const list = Array.isArray(lanes) ? lanes : []
  const facts = Array.isArray(turns) ? turns : []
  const byTurn = new Map()
  for (const t of facts) byTurn.set(Number(t.turn), t)

  const TURN_LIMIT = 8
  const TEXT_BUDGET = 80

  return list.map(lane => {
    const own = Array.isArray(lane.turns) ? lane.turns : []
    const texts = []
    for (const turnNo of own.slice(0, TURN_LIMIT)) {
      const fact = byTurn.get(Number(turnNo))
      if (fact === undefined) continue
      const raw = String(fact.prompt ?? '').replace(/\s+/g, ' ').trim()
      if (raw === '') continue
      texts.push(raw.length <= TEXT_BUDGET ? raw : raw.slice(0, TEXT_BUDGET - 1) + '…')
    }
    return texts.length === 0 ? lane : { ...lane, turnTexts: texts }
  })
}

/**
 * Build every derived value the panel draws.
 *
 * @param events - complete session event log, ascending seq.
 * @param sessionId - session identity.
 * @param overrides - persisted human edits to apply over the heuristic.
 * @returns the payload served to the browser half.
 */
export async function buildSessionPayloadParts(events, sessionId, overrides = []) {
  const model = buildTurnModel(events)
  const auto = assignLanes({ ...model, sessionId })
  const lanes = attachTurnTexts(applyOverrides(auto, overrides), model.turns)

  const prices = await lookupPrices(model.turns)
  const cost = sessionCost(model.turns, prices)

  // Topology is computed here, in index/column units, because the rules
  // (track recycling, fork attachment) are worth testing without a browser.
  // The Client turns these into pixels: only it knows the viewport and zoom.
  const graph = buildGraph(model.turns, lanes)

  return {
    sessionId,
    engineVersion: ENGINE_VERSION,
    turns: model.turns,
    cumulative: cumulativeUsage(model.turns),
    lanes,
    graph,
    totals: model.totals,
    cost: { ...cost, label: formatCost(cost) },
    generatedAt: Date.now(),
  }
}
