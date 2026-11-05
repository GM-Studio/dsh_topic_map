/**
 * 筛选逻辑测试。
 *
 * Run: node tests/filter.mjs
 */

import { strict as assert } from 'node:assert'
import {
  STATE_BUCKETS,
  applyFilter,
  collectStages,
  emptyFilter,
  highlightParts,
  isFilterEmpty,
  laneHaystack,
  matchLane,
  stateBucketOf,
} from '../lib/filter.js'

let passed = 0
const failures = []
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok   ${name}`) }
  catch (e) { failures.push({ name, error: e }); console.log(`  FAIL ${name}\n       ${e.message}`) }
}

const LANES = [
  { laneId: 'L1', title: '会话历史太长', stageName: '话题地图设计', workflowName: '形态与交互', turns: [1], turnTexts: ['会话历史越来越长找不回来'] },
  { laneId: 'L2', title: '面板空白', stageName: '话题地图设计', workflowName: '形态与交互', turns: [7, 8, 9], turnTexts: ['打开什么都是没有'] },
  { laneId: 'L3', title: '跳转定位', stageName: '对话跳转修复', workflowName: '定位缺陷', turns: [11, 12, 13, 14, 15], turnTexts: ['跳转到真实对话没实现好'] },
  { laneId: 'L4', title: '端到端检查', stageName: '实施推进与验收', workflowName: '分阶段实施', turns: [20], turnTexts: ['检查一下是否都做完了'] },
]

const FACTS = {
  1: { endReason: 'completed' },
  7: { endReason: 'error' },
  11: { endReason: 'open' },
  20: { endReason: 'max-tokens' },
}
const factOf = t => FACTS[t]

console.log('\nfilter')

// ── 空条件 ──────────────────────────────────────────────────────────
test('空条件默认全通过', () => {
  const f = emptyFilter()
  assert.equal(isFilterEmpty(f), true)
  for (const lane of LANES) assert.equal(matchLane(lane, f, factOf).match, true)
})

test('空白关键字不算条件', () => {
  assert.equal(isFilterEmpty({ ...emptyFilter(), query: '   ' }), true)
})

// ── 关键字 ──────────────────────────────────────────────────────────
test('按标题搜索', () => {
  const f = { ...emptyFilter(), query: '跳转' }
  const r = applyFilter(LANES, f, factOf)
  assert.equal(r.counts.visible, 1)
  assert.equal(r.visible[0].laneId, 'L3')
})

test('按阶段名搜索', () => {
  const f = { ...emptyFilter(), query: '话题地图' }
  assert.equal(applyFilter(LANES, f, factOf).counts.visible, 2)
})

test('按对话内容搜索（标题里没有这个词）', () => {
  const f = { ...emptyFilter(), query: '找不回来' }
  const r = applyFilter(LANES, f, factOf)
  assert.equal(r.counts.visible, 1)
  assert.equal(r.visible[0].laneId, 'L1')
})

test('搜索大小写不敏感', () => {
  const lanes = [{ laneId: 'X', title: 'API Key 配置', turns: [1] }]
  assert.equal(matchLane(lanes[0], { ...emptyFilter(), query: 'api key' }, factOf).match, true)
  assert.equal(matchLane(lanes[0], { ...emptyFilter(), query: 'API KEY' }, factOf).match, true)
})

test('搜不到就隐藏', () => {
  const f = { ...emptyFilter(), query: '不存在的词xyz' }
  const r = applyFilter(LANES, f, factOf)
  assert.equal(r.counts.visible, 0)
  assert.equal(r.counts.hidden, 4)
})

// ── 阶段 ────────────────────────────────────────────────────────────
test('勾一个阶段', () => {
  const f = { ...emptyFilter(), stages: ['对话跳转修复'] }
  assert.equal(applyFilter(LANES, f, factOf).counts.visible, 1)
})

test('勾多个阶段是"或"关系', () => {
  const f = { ...emptyFilter(), stages: ['对话跳转修复', '实施推进与验收'] }
  assert.equal(applyFilter(LANES, f, factOf).counts.visible, 2)
})

test('收集阶段并去重保序', () => {
  assert.deepEqual(collectStages(LANES), ['话题地图设计', '对话跳转修复', '实施推进与验收'])
})

// ── 状态 ────────────────────────────────────────────────────────────
test('结束原因归入状态桶', () => {
  assert.equal(stateBucketOf({ endReason: 'completed' }), '完成')
  assert.equal(stateBucketOf({ endReason: 'open' }), '进行中')
  assert.equal(stateBucketOf({ endReason: 'error' }), '出错')
  assert.equal(stateBucketOf({ endReason: 'max-tokens' }), '超长')
  assert.equal(stateBucketOf({ endReason: 'aborted' }), '中断')
  assert.equal(stateBucketOf(undefined), '未知')
})

test('按状态筛选', () => {
  const f = { ...emptyFilter(), states: ['出错'] }
  const r = applyFilter(LANES, f, factOf)
  assert.equal(r.counts.visible, 1)
  assert.equal(r.visible[0].laneId, 'L2')
})

test('状态多选是"或"', () => {
  const f = { ...emptyFilter(), states: ['出错', '进行中'] }
  assert.equal(applyFilter(LANES, f, factOf).counts.visible, 2)
})

test('状态桶列表覆盖所有可能值', () => {
  for (const s of ['completed', 'open', 'error', 'max-tokens', 'aborted', 'interrupted', 'blocked']) {
    assert.ok(STATE_BUCKETS.includes(stateBucketOf({ endReason: s })), `${s} 应归入已知桶`)
  }
})

// ── 轮次数 ──────────────────────────────────────────────────────────
test('轮次数下限', () => {
  const f = { ...emptyFilter(), minTurns: 5 }
  const r = applyFilter(LANES, f, factOf)
  assert.equal(r.counts.visible, 1)
  assert.equal(r.visible[0].laneId, 'L3')
})

test('轮次数上限', () => {
  const f = { ...emptyFilter(), maxTurns: 1 }
  assert.equal(applyFilter(LANES, f, factOf).counts.visible, 2)
})

test('轮次数区间', () => {
  const f = { ...emptyFilter(), minTurns: 2, maxTurns: 4 }
  assert.equal(applyFilter(LANES, f, factOf).counts.visible, 1)
})

// ── 组合（与关系）──────────────────────────────────────────────────
test('关键字 + 阶段：两者都要满足', () => {
  const f = { ...emptyFilter(), query: '跳转', stages: ['话题地图设计'] }
  // "跳转"命中 L3，但 L3 属于"对话跳转修复"，不是"话题地图设计" -> 0
  assert.equal(applyFilter(LANES, f, factOf).counts.visible, 0)
})

test('关键字 + 阶段：能同时满足时命中', () => {
  const f = { ...emptyFilter(), query: '面板', stages: ['话题地图设计'] }
  assert.equal(applyFilter(LANES, f, factOf).counts.visible, 1)
})

test('三个条件叠加', () => {
  const f = { ...emptyFilter(), query: '面板', stages: ['话题地图设计'], minTurns: 2 }
  const r = applyFilter(LANES, f, factOf)
  assert.equal(r.counts.visible, 1)
  assert.equal(r.visible[0].laneId, 'L2')
})

// ── 边界 ────────────────────────────────────────────────────────────
test('空泳道列表不崩', () => {
  const r = applyFilter([], emptyFilter(), factOf)
  assert.deepEqual(r.counts, { total: 0, visible: 0, hidden: 0 })
})

test('非法输入不崩', () => {
  assert.deepEqual(applyFilter(null, null, factOf).counts.total, 0)
  assert.equal(matchLane(null, emptyFilter(), factOf).match, false)
  assert.equal(laneHaystack(null), '')
})

test('没有 turnTexts 也能搜索', () => {
  const lane = { laneId: 'X', title: '只有标题', turns: [1] }
  assert.equal(matchLane(lane, { ...emptyFilter(), query: '只有标题' }, factOf).match, true)
})

test('applyFilter 划分出的 visible+hidden 等于总数', () => {
  const f = { ...emptyFilter(), query: '话题' }
  const r = applyFilter(LANES, f, factOf)
  assert.equal(r.counts.visible + r.counts.hidden, LANES.length)
})

// ── 高亮 ────────────────────────────────────────────────────────────
test('高亮切分出命中片段', () => {
  const parts = highlightParts('跳转到真实对话', '跳转')
  assert.deepEqual(parts, [{ text: '跳转', hit: true }, { text: '到真实对话', hit: false }])
})

test('多处命中都能标出', () => {
  const parts = highlightParts('a-b-a', 'a')
  assert.equal(parts.filter(p => p.hit).length, 2)
})

test('没有关键字时原样返回一段', () => {
  assert.deepEqual(highlightParts('文本', ''), [{ text: '文本', hit: false }])
})

test('不把用户输入拼成 HTML（防注入）', () => {
  const parts = highlightParts('<img onerror=x>', 'img')
  // 返回的是数据结构，没有 HTML 字符串
  assert.ok(Array.isArray(parts))
  assert.ok(parts.every(p => typeof p.text === 'string' && typeof p.hit === 'boolean'))
})

test('高亮结果拼回去等于原文', () => {
  const src = '跳转到真实对话，跳转要准'
  const parts = highlightParts(src, '跳转')
  assert.equal(parts.map(p => p.text).join(''), src)
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const f of failures) console.error(`\n${f.name}\n${f.error.stack}`)
  process.exit(1)
}
