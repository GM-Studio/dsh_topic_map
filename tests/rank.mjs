/**
 * 相关度排序（S-5）测试。
 *
 * 全部手算对照：固定 now、固定本地时间戳，期望分数写死在用例里。
 * 时间用本地构造器生成，保证任意时区下"今天 / 2 天前 / 更早"的分层一致。
 *
 * Run: node tests/rank.mjs
 */

import { strict as assert } from 'node:assert'
import { DEFAULT_WEIGHTS, recencyOf, rankHits } from '../lib/rank.js'

let passed = 0
const failures = []
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok   ${name}`) }
  catch (e) { failures.push({ name, error: e }); console.log(`  FAIL ${name}\n       ${e.message}`) }
}

/** 固定"现在"：2026-11-25 10:00（本地时区），所有用例都以它为准。 */
const NOW = new Date(2026, 10, 25, 10, 0, 0).getTime()
/** n 天前的 09:00（本地时区）。 */
const daysAgo = n => new Date(2026, 10, 25 - n, 9, 0, 0).getTime()

console.log('\nrank')

// ── S-5 手算 ────────────────────────────────────────────────────────
test('S-5 手算：7.8 / 3.4 / 3.0 的顺序', () => {
  const hits = [
    // 今天、命中提问、出现 4 次、重要：3 + 0.2×4 + 2×1.0 + 2 = 7.8
    { sessionId: 's1', turn: 3, time: daysAgo(0), matchedIn: 'prompt', matchCount: 4 },
    // 2 天前、命中回答、出现 3 次：1 + 0.2×3 + 2×0.7 = 3.0
    { sessionId: 's1', turn: 9, time: daysAgo(2), matchedIn: 'response', matchCount: 3 },
    // 45 天前、命中回答、出现 12 次（封顶 10）：1 + 0.2×10 + 2×0.2 = 3.4
    { sessionId: 's2', turn: 1, time: daysAgo(45), matchedIn: 'response', matchCount: 12 },
  ]
  const ranked = rankHits(hits, { now: NOW, labels: { 's1#3': { starred: true } } })
  assert.deepEqual(ranked.map(h => h.turn), [3, 1, 9])
  assert.equal(ranked[0].score, 7.8)
  assert.equal(ranked[1].score, 3.4)
  assert.equal(ranked[2].score, 3.0)
})

test('分项拆解可直接显示（提问×3 · 出现4次×0.8 …）', () => {
  const ranked = rankHits([
    { sessionId: 's1', turn: 3, time: daysAgo(0), matchedIn: 'prompt', matchCount: 4 },
    { sessionId: 's1', turn: 9, time: daysAgo(2), matchedIn: 'response', matchCount: 3 },
  ], { now: NOW, labels: { 's1#3': { starred: true } } })
  const top = ranked.find(h => h.turn === 3)
  assert.equal(top.breakdown.inPrompt, 3)
  assert.equal(top.breakdown.inResponse, 0)
  assert.equal(top.breakdown.match, 0.8)
  assert.equal(top.breakdown.recency, 2)
  assert.equal(top.breakdown.status, 2)
  assert.equal(top.breakdown.total, 7.8)
  assert.equal(top.breakdown.matchCount, 4)
  assert.equal(top.breakdown.recencyTier, 1)
  assert.equal(top.breakdown.recencyDays, 0)
  assert.deepEqual(top.breakdown.statuses, ['starred'])
  assert.deepEqual(top.breakdown.parts.map(p => p.text), ['提问×3', '出现4次×0.8', '今天×2', '重要+2'])

  const older = ranked.find(h => h.turn === 9)
  assert.ok(older.breakdown.parts.some(p => p.text === '2天前×1.4'))
  assert.ok(older.breakdown.parts.every(p => typeof p.key === 'string' && typeof p.value === 'number'))
})

test('命中提问和回答时两项都加', () => {
  const [hit] = rankHits([
    { sessionId: 's', turn: 1, time: daysAgo(0), matchedIn: 'prompt', matchCount: 1, inPrompt: true, inResponse: true },
  ], { now: NOW })
  assert.equal(hit.score, 6.2) // 3 + 1 + 0.2×1 + 2×1.0
})

test('该轮命中次数封顶 10', () => {
  const [hit] = rankHits([
    { sessionId: 's', turn: 1, time: daysAgo(0), matchedIn: 'response', matchCount: 25 },
  ], { now: NOW })
  assert.equal(hit.breakdown.match, 2)
  assert.equal(hit.score, 5) // 1 + 2 + 2
})

// ── 稳定排序 ────────────────────────────────────────────────────────
test('同分按 turn 升序', () => {
  const hits = [
    { sessionId: 's', turn: 9, time: daysAgo(2), matchedIn: 'response', matchCount: 1 },
    { sessionId: 's', turn: 3, time: daysAgo(2), matchedIn: 'response', matchCount: 1 },
  ]
  assert.deepEqual(rankHits(hits, { now: NOW }).map(h => h.turn), [3, 9])
})

test('同分同轮保持输入顺序（稳定）', () => {
  const hits = [
    { sessionId: 's', turn: 5, time: daysAgo(2), matchedIn: 'response', matchCount: 1, tag: 'first' },
    { sessionId: 's', turn: 2, time: daysAgo(2), matchedIn: 'response', matchCount: 1, tag: 'other' },
    { sessionId: 's', turn: 5, time: daysAgo(2), matchedIn: 'response', matchCount: 1, tag: 'second' },
  ]
  const ranked = rankHits(hits, { now: NOW })
  assert.deepEqual(ranked.map(h => h.turn), [2, 5, 5])
  assert.deepEqual(ranked.map(h => h.tag), ['other', 'first', 'second'])
})

// ── 权重覆盖（C-2）──────────────────────────────────────────────────
test('五个权重都可覆盖', () => {
  const [hit] = rankHits([
    { sessionId: 's', turn: 1, time: daysAgo(0), matchedIn: 'prompt', matchCount: 5, inPrompt: true, inResponse: true },
  ], {
    now: NOW,
    weights: { inPrompt: 10, inResponse: 5, match: 1, recency: 0, status: { starred: 0 } },
  })
  assert.equal(hit.score, 20) // 10 + 5 + 1×5 + 0 + 0
  assert.equal(hit.breakdown.recency, 0)
  // 默认权重不能被人物的覆盖改掉
  assert.equal(DEFAULT_WEIGHTS.inPrompt, 3)
  assert.equal(DEFAULT_WEIGHTS.status.starred, 2)
})

test('状态权重可单独覆盖为 0', () => {
  const [hit] = rankHits([
    { sessionId: 's', turn: 1, time: daysAgo(0), matchedIn: 'response', matchCount: 0 },
  ], { now: NOW, labels: { 's#1': { starred: true } }, weights: { status: { starred: 0 } } })
  assert.equal(hit.breakdown.status, 0)
  assert.equal(hit.score, 3) // 命中回答 1 + 今天 2
})

// ── 状态 ────────────────────────────────────────────────────────────
test('三个状态默认叠用相加（重要 +2 / 已解决 +1 / 待跟进 +0.5）', () => {
  const [hit] = rankHits([
    { sessionId: 's', turn: 1, time: daysAgo(0), matchedIn: 'prompt', matchCount: 0 },
  ], { now: NOW, labels: { 's#1': { starred: true, solved: true, followUp: true } } })
  assert.equal(hit.breakdown.status, 3.5)
  assert.deepEqual(hit.breakdown.statuses, ['starred', 'solved', 'followUp'])
  const texts = hit.breakdown.parts.map(p => p.text)
  assert.ok(texts.includes('重要+2'))
  assert.ok(texts.includes('已解决+1'))
  assert.ok(texts.includes('待跟进+0.5'))
})

test('statusMode=max 只取最高的一项', () => {
  const [hit] = rankHits([
    { sessionId: 's', turn: 1, time: daysAgo(0), matchedIn: 'prompt', matchCount: 0 },
  ], { now: NOW, statusMode: 'max', labels: { 's#1': { starred: true, solved: true, followUp: true } } })
  assert.equal(hit.breakdown.status, 2)
  assert.equal(hit.breakdown.parts.filter(p => p.key === 'status').length, 1)
})

test('无标签不报错，状态加分为 0', () => {
  const [hit] = rankHits([
    { sessionId: 's', turn: 1, time: daysAgo(0), matchedIn: 'response', matchCount: 0 },
  ], { now: NOW })
  assert.equal(hit.breakdown.status, 0)
  assert.equal(hit.score, 3) // 命中回答 1 + 今天 2
})

test('标签来源：对象 / Map / 函数 / 命中自带的 label', () => {
  const base = { sessionId: 's9', turn: 4, time: daysAgo(0), matchedIn: 'prompt', matchCount: 0 }
  const expected = 3 + 2 + 2 // 提问 3 + 今天 2 + 重要 2
  const sources = [
    { labels: { 's9#4': { starred: true } }, hit: base },
    { labels: new Map([['s9#4', { starred: true }]]), hit: base },
    { labels: () => ({ starred: true }), hit: base },
    { labels: undefined, hit: { ...base, label: { starred: true } } },
    { labels: new Map(), hit: { ...base, label: ['starred'] } },
  ]
  for (const { labels, hit } of sources) {
    const options = { now: NOW }
    if (labels !== undefined) options.labels = labels
    assert.equal(rankHits([hit], options)[0].score, expected)
  }
})

test('未知状态与未知标签形状被忽略', () => {
  const [hit] = rankHits([
    { sessionId: 's', turn: 1, time: daysAgo(0), matchedIn: 'prompt', matchCount: 0 },
  ], { now: NOW, labels: { 's#1': { starred: false, priority: true, note: '备注' } } })
  assert.equal(hit.breakdown.status, 0)
})

// ── 时间新鲜度分层 ──────────────────────────────────────────────────
test('recency 四档边界：今天 1.0 / 本周 0.7 / 本月 0.4 / 更早 0.2', () => {
  assert.deepEqual(recencyOf(daysAgo(0), NOW), { days: 0, tier: 1, label: '今天' })
  assert.equal(recencyOf(daysAgo(1), NOW).tier, 0.7)
  assert.equal(recencyOf(daysAgo(6), NOW).tier, 0.7)
  assert.equal(recencyOf(daysAgo(7), NOW).tier, 0.4)
  assert.equal(recencyOf(daysAgo(29), NOW).tier, 0.4)
  assert.equal(recencyOf(daysAgo(30), NOW).tier, 0.2)
  assert.equal(recencyOf(daysAgo(365), NOW).tier, 0.2)
  assert.equal(recencyOf(daysAgo(2), NOW).label, '2天前')
})

test('未来时间按今天算', () => {
  assert.equal(recencyOf(NOW + 3 * 3600 * 1000, NOW).tier, 1)
  assert.equal(recencyOf(NOW + 3 * 3600 * 1000, NOW).days, 0)
})

test('时间缺失按更早算，不崩', () => {
  const [hit] = rankHits([{ sessionId: 'x', turn: 1 }], { now: NOW })
  assert.equal(hit.score, 0.4) // 2×0.2
  assert.equal(hit.breakdown.recencyTier, 0.2)
  assert.equal(recencyOf(undefined, NOW).tier, 0.2)
})

// ── 边界 ────────────────────────────────────────────────────────────
test('空输入返回空数组', () => {
  assert.deepEqual(rankHits(null, { now: NOW }), [])
  assert.deepEqual(rankHits(undefined), [])
  assert.deepEqual(rankHits([], { now: NOW }), [])
})

test('不修改入参，返回新对象', () => {
  const input = [{ sessionId: 's', turn: 1, time: daysAgo(0), matchedIn: 'prompt', matchCount: 2 }]
  const out = rankHits(input, { now: NOW })
  assert.equal(input[0].score, undefined)
  assert.equal(input[0].breakdown, undefined)
  assert.notEqual(out[0], input[0])
})

test('默认权重就是 S-5 的五个数值', () => {
  assert.equal(DEFAULT_WEIGHTS.inPrompt, 3)
  assert.equal(DEFAULT_WEIGHTS.inResponse, 1)
  assert.equal(DEFAULT_WEIGHTS.match, 0.2)
  assert.equal(DEFAULT_WEIGHTS.matchCap, 10)
  assert.equal(DEFAULT_WEIGHTS.recency, 2)
  assert.deepEqual({ ...DEFAULT_WEIGHTS.status }, { starred: 2, solved: 1, followUp: 0.5 })
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const f of failures) console.error(`\n${f.name}\n${f.error.stack}`)
  process.exit(1)
}
