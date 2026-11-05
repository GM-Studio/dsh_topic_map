import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildSessionPayload } from '../lib/index.js'
import { reconcileClassification } from '../lib/classification.js'
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
  assert.equal(p.lanes.find(l => l.turns.includes(3))?.stageName, '新增未归类')
  assert.deepEqual([...new Set(p.graph.nodes.map(n => n.turn))], [1, 2, 3])
  assert.ok(p.stages.some(s => s.turns.includes(3)))
})
test('历史截断后不保留不存在的轮次', async () => {
  const p = await payload(1)
  assert.deepEqual(p.lanes.flatMap(l => l.turns), [1])
  assert.deepEqual(p.stages.flatMap(s => s.turns), [1])
})

test('未归类阶段：三层名字不同，且标记 isUnclassified', () => {
  const turns = [{ turn: 1 }, { turn: 2 }, { turn: 3 }]
  const saved = [{ laneId: 's:L1', title: '已归类话题', taskName: '已归类话题', stageName: '阶段A', workflowName: '工作流A', turns: [1, 2] }]
  const r = reconcileClassification(turns, saved, 's')
  const unl = r.lanes.find(l => l.origin === 'unassigned')
  assert.ok(unl, '应有未归类泳道')
  // 三层名字必须不同：之前全是"待归类"，折平后看起来像空的
  assert.notEqual(unl.stageName, unl.workflowName)
  assert.notEqual(unl.workflowName, unl.taskName)
  assert.ok(unl.title.includes('第 3 轮') || unl.title.includes('3'), '标题应带上轮次范围')
})

test('未归类阶段排在最后', () => {
  const turns = [{ turn: 1 }, { turn: 2 }, { turn: 3 }]
  const saved = [{ laneId: 's:L1', title: 'A', taskName: 'A', stageName: '阶段A', workflowName: 'WA', turns: [1, 2] }]
  const r = reconcileClassification(turns, saved, 's')
  assert.equal(r.stages[r.stages.length - 1].isUnclassified, true, '未归类应在最后')
})

test('没有新轮次时不产生未归类阶段', () => {
  const turns = [{ turn: 1 }, { turn: 2 }]
  const saved = [{ laneId: 's:L1', title: 'A', taskName: 'A', stageName: '阶段A', workflowName: 'WA', turns: [1, 2] }]
  const r = reconcileClassification(turns, saved, 's')
  assert.equal(r.lanes.length, 1)
  assert.equal(r.stages.some(s => s.isUnclassified), false)
})
