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
  const lanes = applyOverrides(auto, overrides)

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
