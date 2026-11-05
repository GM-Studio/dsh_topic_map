/**
 * 状态复核的测试。
 *
 * Run: node tests/status-review.mjs
 */

import { strict as assert } from 'node:assert'
import {
  REVIEW_LIMIT,
  buildReviewPrompt,
  mergeReview,
  parseReview,
  pickSuspects,
} from '../lib/status-review.js'

let passed = 0
const failures = []
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok   ${name}`) }
  catch (e) { failures.push({ name, error: e }); console.log(`  FAIL ${name}\n       ${e.message}`) }
}

const ENTRIES = [
  { laneId: 'A', title: '甲任务', suspect: true, turns: [1], evidence: { turnCount: 1, toolCalls: 5, hasOutput: true, hasError: false } },
  { laneId: 'B', title: '乙任务', suspect: false, turns: [2], evidence: { turnCount: 1, toolCalls: 2, hasOutput: true, hasError: false } },
  { laneId: 'C', title: '丙任务', suspect: true, turns: [3, 4, 5], evidence: { turnCount: 3, toolCalls: 40, hasOutput: false, hasError: true, errorTurns: [5] } },
]

const FACT = {
  1: { prompt: '做甲', response: '甲已完成，文件已写入' },
  2: { prompt: '做乙', response: '乙也好了' },
  3: { prompt: '做丙', response: '试了一下' },
  4: { prompt: '还是不行', response: '再试' },
  5: { prompt: '怎么办', response: '报错了' },
}
const factOf = t => FACT[t]

console.log('\nstatus-review')

// ── 挑选可疑 ────────────────────────────────────────────────────────
test('只挑 suspect=true 的', () => {
  const picked = pickSuspects(ENTRIES)
  assert.equal(picked.length, 2)
  assert.deepEqual(picked.map(e => e.laneId).sort(), ['A', 'C'])
})

test('超限时按可疑程度排序（报错+轮次多+工具多优先）', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({
    laneId: 'L' + i,
    title: 'T' + i,
    suspect: true,
    turns: [i],
    evidence: { turnCount: 1 + i, toolCalls: i * 2, hasError: i % 5 === 0 },
  }))
  const picked = pickSuspects(many, 5)
  assert.equal(picked.length, 5)
  // 有报错的应该优先进入
  assert.ok(picked.some(e => e.evidence.hasError), '报错的应被优先选中')
})

test('没有可疑项时返回空', () => {
  assert.deepEqual(pickSuspects(ENTRIES.map(e => ({ ...e, suspect: false }))), [])
})

test('空输入不崩', () => {
  assert.deepEqual(pickSuspects([]), [])
  assert.deepEqual(pickSuspects(null), [])
})

test('默认上限合理', () => {
  assert.ok(REVIEW_LIMIT > 0 && REVIEW_LIMIT <= 20)
})

// ── 提示词 ──────────────────────────────────────────────────────────
test('提示词包含标题、信号与对话摘要', () => {
  const { system, user } = buildReviewPrompt([ENTRIES[0]], factOf)
  assert.ok(system.includes('done') && system.includes('blocked'))
  assert.ok(user.includes('甲任务'))
  assert.ok(user.includes('轮次 1'))
  assert.ok(user.includes('有写操作'))
  assert.ok(user.includes('甲已完成'), '必须带上回复内容')
})

test('提示词要求按回复判断，而不是用户提没提', () => {
  const { system } = buildReviewPrompt([ENTRIES[0]], factOf)
  assert.ok(system.includes('实际做了什么'))
  assert.ok(system.includes('失败'), '应提示"反复失败要判 blocked"')
})

test('超长对话被截断', () => {
  const long = { laneId: 'X', title: '长', turns: [1], evidence: { turnCount: 1, toolCalls: 0 } }
  const f = { 1: { prompt: 'x'.repeat(3000), response: 'y'.repeat(3000) } }
  const { user } = buildReviewPrompt([long], t => f[t])
  assert.ok(user.length < 1200, `提示词过长：${user.length}`)
})

test('每项最多带 4 轮对话（控制大小）', () => {
  const many = { laneId: 'M', title: '多', turns: [1, 2, 3, 4, 5, 6, 7], evidence: { turnCount: 7, toolCalls: 9 } }
  const { user } = buildReviewPrompt([many], factOf)
  // 只应出现 T1..T4，T5 之后不出现
  assert.ok(user.includes('T4'))
  assert.ok(!user.includes('T5 提问'), '超过 4 轮的应被裁掉')
})

// ── 解析 ────────────────────────────────────────────────────────────
test('解析标准结果', () => {
  const got = parseReview('[{"state":"done","reason":"做完了"},{"state":"blocked","reason":"报错"}]', 2)
  assert.equal(got.length, 2)
  assert.equal(got[0].state, 'done')
  assert.equal(got[1].reason, '报错')
})

test('大小写与空白被归一', () => {
  const got = parseReview('[{"state":" DONE ","reason":" ok "}]', 1)
  assert.equal(got[0].state, 'done')
  assert.equal(got[0].reason, 'ok')
})

test('长度不符整批作废', () => {
  assert.equal(parseReview('[{"state":"done","reason":"x"}]', 2), null)
  assert.equal(parseReview('[{"state":"done","reason":"x"},{"state":"done","reason":"y"}]', 1), null)
})

test('非法状态值作废', () => {
  assert.equal(parseReview('[{"state":"finished","reason":"x"}]', 1), null)
  assert.equal(parseReview('[{"state":"","reason":"x"}]', 1), null)
  assert.equal(parseReview('[{"reason":"x"}]', 1), null)
})

test('元素不是对象时作废', () => {
  assert.equal(parseReview('["done"]', 1), null)
  assert.equal(parseReview('[null]', 1), null)
})

test('容忍代码围栏与解释', () => {
  const text = '结果如下：\n```json\n[{"state":"active","reason":"进行中"}]\n```\n完毕'
  const got = parseReview(text, 1)
  assert.equal(got[0].state, 'active')
})

test('无法解析返回 null', () => {
  assert.equal(parseReview('我不知道', 1), null)
  assert.equal(parseReview('', 1), null)
})

test('理由超长被截断', () => {
  const got = parseReview(`[{"state":"done","reason":"${'x'.repeat(200)}"}]`, 1)
  assert.ok(got[0].reason.length <= 40)
})

// ── 合并 ────────────────────────────────────────────────────────────
test('合并后带上模型结论', () => {
  const merged = mergeReview(ENTRIES.slice(0, 2), [
    { state: 'blocked', reason: '其实没成' },
    { state: 'done', reason: '做完了' },
  ])
  assert.equal(merged[0].review.state, 'blocked')
  assert.equal(merged[1].review.reason, '做完了')
})

test('长度不匹配时不套用（避免错位）', () => {
  const merged = mergeReview(ENTRIES, [{ state: 'done', reason: 'x' }])
  assert.equal(merged.length, ENTRIES.length)
  assert.ok(merged.every(e => e.review === null), '长度不符时全部标为无结论')
})

test('没有结论时保持 null 而不是伪造', () => {
  const merged = mergeReview(ENTRIES, null)
  assert.ok(merged.every(e => e.review === null))
})

test('合并不修改原数组', () => {
  const original = [{ laneId: 'Z', title: 'z', suspect: true }]
  const merged = mergeReview(original, [{ state: 'done', reason: 'ok' }])
  assert.equal(original[0].review, undefined, '不应污染入参')
  assert.equal(merged[0].review.state, 'done')
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const f of failures) console.error(`\n${f.name}\n${f.error.stack}`)
  process.exit(1)
}
