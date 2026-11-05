import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildSessionPayload } from '../lib/index.js'
import { SessionCache } from '../lib/session-cache.js'
import { SegmentStore } from '../lib/llm-call.js'

function events(count) {
  return Array.from({ length: count }, (_, i) => [
    { type: 'turn/start', seq: i * 3, time: i, data: { turn: i + 1 } },
    { type: 'user/message', seq: i * 3 + 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: `新增轮次${i + 1}` }] } },
    { type: 'turn/end', seq: i * 3 + 2, data: { turn: i + 1, reason: { kind: 'completed' } } },
  ]).flat()
}
async function payload(count) {
  const store = new SegmentStore()
  store.setPending('test', { lanes: [{ laneId: 'stable', title: '已确认话题', stageName: '实现', workflowName: '后端', turns: [1, 2] }], stages: [] })
  store.applyPending('test', null)
  const ctx = { sessionQuery: { readSession: async () => ({ events: events(count) }) }, sessionPersistence: { stat: async () => ({ revision: count }) } }
  return buildSessionPayload(ctx, new SessionCache(), 'test', true, store)
}
test('已采纳分类后新增轮次有明确归属，原分类不漂移', async () => {
  const p = await payload(3)
  assert.deepEqual(p.lanes.find(l => l.laneId === 'stable').turns, [1, 2])
  assert.equal(p.lanes.find(l => l.turns.includes(3))?.stageName, '待归类')
  assert.deepEqual([...new Set(p.graph.nodes.map(n => n.turn))], [1, 2, 3])
  assert.ok(p.stages.some(s => s.turns.includes(3)))
})
test('历史截断后不保留不存在的轮次', async () => {
  const p = await payload(1)
  assert.deepEqual(p.lanes.flatMap(l => l.turns), [1])
  assert.deepEqual(p.stages.flatMap(s => s.turns), [1])
})
