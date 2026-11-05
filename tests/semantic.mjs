/**
 * 语义分段的纯逻辑测试。
 *
 * 架构要点：模型输出的是**逐轮话题标签**，不是"在哪切"。
 * 因为切点表达不了"第 14 轮回到第 9 轮那个话题"，而那正是长会话里
 * 最需要被画出来的结构。
 *
 * Run: node tests/semantic.mjs
 */

import { strict as assert } from 'node:assert'
import {
  DEFAULT_TURN_LIMIT,
  analysisWindowStart,
  buildAssignmentPrompt,
  parseAssignment,
} from '../lib/semantic.js'
import { lanesFromAssignment } from '../lib/lane-engine.js'

let passed = 0
const failures = []
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok   ${name}`) }
  catch (e) { failures.push({ name, error: e }); console.log(`  FAIL ${name}\n       ${e.message}`) }
}

/** 造轮次事实。 */
function makeTurns(plan) {
  return plan.map((label, i) => ({
    turn: i + 1,
    startSeq: i * 10,
    endSeq: i * 10 + 5,
    prompt: `${label} 的第 ${i + 1} 段内容`,
    response: 'ok',
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    steps: 1, toolCalls: 0, steering: 0, durationMs: 10,
    endReason: 'completed', interrupted: false,
    files: [], tools: [], commands: [], model: null,
  }))
}

console.log('\nsemantic')

// ── 解析模型输出 ────────────────────────────────────────────────────
test('解析标准 JSON 标签数组', () => {
  const got = parseAssignment('["甲","甲","乙"]', 3)
  assert.deepEqual(got, ['甲', '甲', '乙'])
})

test('容忍代码围栏与前后解释', () => {
  const text = '好的，结果是：\n```json\n["A","B"]\n```\n以上。'
  assert.deepEqual(parseAssignment(text, 2), ['A', 'B'])
})

test('长度不符时整批作废（错位比没有更糟）', () => {
  assert.equal(parseAssignment('["A","B"]', 3), null)
  assert.equal(parseAssignment('["A","B","C"]', 2), null)
})

test('非字符串或空标签作废', () => {
  assert.equal(parseAssignment('[1,2]', 2), null)
  assert.equal(parseAssignment('["A",""]', 2), null)
  assert.equal(parseAssignment('["A",null]', 2), null)
})

test('完全无法解析时返回 null', () => {
  assert.equal(parseAssignment('我不知道', 2), null)
  assert.equal(parseAssignment('', 2), null)
  assert.equal(parseAssignment('{"a":1}', 2), null)
})

test('标签顺序严格对应轮次（不能打乱）', () => {
  const got = parseAssignment('["X","Y","X","Z"]', 4)
  assert.deepEqual(got, ['X', 'Y', 'X', 'Z'])
})

// ── 提示词 ──────────────────────────────────────────────────────────
test('提示词要求复用旧标签（回游的关键）', () => {
  const turns = makeTurns(['甲', '乙'])
  const { system, user } = buildAssignmentPrompt(turns)
  assert.ok(system.includes('复用'), '必须要求模型复用旧标签')
  assert.ok(user.includes('第 1 轮'))
  assert.ok(user.includes('第 2 轮'))
  assert.ok(user.includes('长度 2'))
})

test('提示词会给出已有话题名，减少同义造词', () => {
  const turns = makeTurns(['甲'])
  const { user } = buildAssignmentPrompt(turns, ['插件设计', '数据库索引'])
  assert.ok(user.includes('插件设计'))
  assert.ok(user.includes('数据库索引'))
})

test('超长轮次内容被截断，控制请求大小', () => {
  const long = 'x'.repeat(5000)
  const turns = [
    { turn: 1, prompt: long, response: '' },
    { turn: 2, prompt: long, response: '' },
  ]
  const { user } = buildAssignmentPrompt(turns)
  assert.ok(user.length < 1200, `提示词过长：${user.length}`)
})

// ── 窗口截断 ────────────────────────────────────────────────────────
test('短会话全量分析', () => {
  assert.equal(analysisWindowStart({ length: 10 }, 60), 0)
})

test('长会话只分析最近的部分', () => {
  assert.equal(analysisWindowStart({ length: 100 }, 60), 40)
})

test('上限非法时退回默认 60', () => {
  assert.equal(analysisWindowStart({ length: 100 }, NaN), 40)
  assert.equal(analysisWindowStart({ length: 100 }, -5), 40)
  assert.equal(DEFAULT_TURN_LIMIT, 60)
})

// ── 由归属构建泳道（核心）──────────────────────────────────────────
test('同标签的轮次归入同一条泳道', () => {
  const turns = makeTurns(['a', 'a', 'b', 'b'])
  const lanes = lanesFromAssignment({ turns, sessionId: 's' }, ['甲', '甲', '乙', '乙'])
  assert.equal(lanes.length, 2)
  assert.deepEqual(lanes[0].turns, [1, 2])
  assert.deepEqual(lanes[1].turns, [3, 4])
})

test('回到旧话题的轮次接回原泳道，形成 resumed 区段（关键）', () => {
  // 甲 甲 / 乙 / 甲 —— 第 4 轮回到第 1 轮那个话题
  const turns = makeTurns(['a', 'a', 'b', 'a'])
  const lanes = lanesFromAssignment({ turns, sessionId: 's' }, ['甲', '甲', '乙', '甲'])
  assert.equal(lanes.length, 2, '应只有两条泳道')
  const first = lanes.find(l => l.turns.includes(1))
  assert.deepEqual(first.turns, [1, 2, 4], '第 4 轮必须回到第一条线')
  assert.equal(first.segments.length, 2, '应有两个区段')
  assert.equal(first.segments[0].kind, 'contiguous')
  assert.equal(first.segments[1].kind, 'resumed')
})

test('你给的 15 轮模式：三条主干正确归并', () => {
  // a a1 a2 / b b1 b2 b3 / a3 / c c1 c2 / b4 b5 / c2 a3 / a4+b6
  // 期望：所有 a* 同一条线，所有 b* 同一条线，所有 c* 同一条线。
  const plan = ['a', 'a1', 'a2', 'b', 'b1', 'b2', 'b3', 'a3', 'c', 'c1', 'c2', 'b4', 'b5', 'c2', 'a3', 'a4+b6']
  const turns = makeTurns(plan)
  // 每一轮的标签取它的主干字母（a4+b6 -> a，因为主归属是 a）。
  const stemOf = p => p.replace(/[0-9]/g, '').split('+')[0]
  const labels = plan.map(stemOf)

  const lanes = lanesFromAssignment({ turns, sessionId: 's' }, labels)

  assert.equal(lanes.length, 3, `应恰好三条主干，实际 ${lanes.length}`)

  // 每个主干的轮次必须全在同一泳道。
  // 注意 `a4+b6` 这种"一轮属于两个话题"的轮次，本函数按**主归属**（第一个
  // 标签）放置——副归属需要另一条通路（见 sharedTurns），这里只验证主归属。
  const byStem = new Map()
  plan.forEach((p, i) => {
    const primary = stemOf(p)
    const lane = lanes.find(l => l.turns.includes(i + 1))
    if (!byStem.has(primary)) byStem.set(primary, new Set())
    if (lane) byStem.get(primary).add(lane.row)
  })
  for (const [stem, rows] of byStem) {
    assert.equal(rows.size, 1, `主干 ${stem} 应只在一条泳道，实际 L${[...rows].join(',L')}`)
  }

  // 三轮 a 型内容（1-3、8、15、16）必须都在同一条线上，且形成多个区段
  const aLane = lanes.find(l => l.turns.includes(1))
  assert.deepEqual(aLane.turns, [1, 2, 3, 8, 15, 16], `a 线轮次不对：${aLane.turns}`)
  assert.ok(aLane.segments.length >= 3, 'a 线应当有多个不连续区段')
})

test('多段回游产生多个区段', () => {
  // 甲 乙 甲 乙 甲
  const turns = makeTurns(['a', 'b', 'a', 'b', 'a'])
  const lanes = lanesFromAssignment({ turns, sessionId: 's' }, ['甲', '乙', '甲', '乙', '甲'])
  const a = lanes.find(l => l.turns.includes(1))
  assert.deepEqual(a.turns, [1, 3, 5])
  assert.equal(a.segments.length, 3, '三个不连续区段')
})

test('归属数组长度不匹配时返回空（不猜）', () => {
  const turns = makeTurns(['a', 'b'])
  assert.deepEqual(lanesFromAssignment({ turns, sessionId: 's' }, ['甲']), [])
})

test('空标签的轮次被跳过而不是归到空话题', () => {
  const turns = makeTurns(['a', 'b'])
  const lanes = lanesFromAssignment({ turns, sessionId: 's' }, ['甲', ''])
  assert.equal(lanes.length, 1)
  assert.deepEqual(lanes[0].turns, [1])
})

test('泳道顺序按话题首次出现', () => {
  const turns = makeTurns(['a', 'b', 'c'])
  const lanes = lanesFromAssignment({ turns, sessionId: 's' }, ['乙', '甲', '丙'])
  assert.deepEqual(lanes.map(l => l.turns[0]), [1, 2, 3])
  assert.equal(lanes[0].title.length > 0, true)
})

test('首条泳道作为其余泳道的父（构图需要）', () => {
  const turns = makeTurns(['a', 'b', 'c'])
  const lanes = lanesFromAssignment({ turns, sessionId: 's' }, ['甲', '乙', '丙'])
  assert.equal(lanes[0].parentLaneId, null)
  assert.equal(lanes[1].parentLaneId, lanes[0].laneId)
  assert.equal(lanes[2].parentLaneId, lanes[0].laneId)
})

test('单话题会话得到一条泳道', () => {
  const turns = makeTurns(['a', 'a', 'a'])
  const lanes = lanesFromAssignment({ turns, sessionId: 's' }, ['甲', '甲', '甲'])
  assert.equal(lanes.length, 1)
  assert.deepEqual(lanes[0].turns, [1, 2, 3])
  assert.equal(lanes[0].segments.length, 1)
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const f of failures) console.error(`\n${f.name}\n${f.error.stack}`)
  process.exit(1)
}
