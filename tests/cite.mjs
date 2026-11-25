/**
 * 引用块构造与反解测试（A-4 / design.md §6）。
 *
 * 纯函数：不读 DOM、不读系统时钟。时间用固定 epoch + 显式 timeZone，
 * 因此任意机器时区下结果一致。
 *
 * Run: node tests/cite.mjs
 */

import { strict as assert } from 'node:assert'
import {
  buildCite,
  citeBudgetOf,
  estimateTokens,
  parseCite,
  stripBody,
} from '../lib/cite.js'

let passed = 0
const failures = []
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok   ${name}`) }
  catch (e) { failures.push({ name, error: e }); console.log(`  FAIL ${name}\n       ${e.message}`) }
}

/** 2026-11-24 14:20 +08:00 的绝对时间戳（用 UTC 构造，换机器时区也一致）。 */
const SHANGHAI_TIME = Date.UTC(2026, 10, 24, 6, 20)
const HEADER = '〔引用〕插件开发 › 话题地图 · 第 37 轮 · 2026-11-24 14:20'

const BASE = {
  title: '话题地图',
  topic: '插件开发',
  turn: 37,
  time: SHANGHAI_TIME,
  timeZone: 'Asia/Shanghai',
  intent: '把左栏改成三级树',
  points: [
    '用 data-owner 与 data-scope 分离两种高亮',
    '缓存判定改为"会话都还在"',
    '保留原有筛选条',
  ],
  sessionId: 'session-abc123',
}

const BASE_TEXT = [
  HEADER,
  '意图：把左栏改成三级树',
  '结论：',
  '- 用 data-owner 与 data-scope 分离两种高亮',
  '- 缓存判定改为"会话都还在"',
  '- 保留原有筛选条',
  '出处：session/session-abc123#37',
].join('\n')

/** 取首行。 */
const firstLine = text => String(text).split('\n')[0]

console.log('\ncite')

// ── 块格式 ──────────────────────────────────────────────────────────
test('buildCite：默认只带指针 + 摘要', () => {
  const built = buildCite(BASE)
  assert.equal(built.text, BASE_TEXT)
  assert.equal(built.tokens, estimateTokens(BASE_TEXT))
  assert.deepEqual(built.layers, ['pointer', 'summary'])
  assert.equal(built.trimmed, false)
})

test('buildCite：原文插在出处前', () => {
  const built = buildCite({ ...BASE, body: '第一段原文\n第二段原文' })
  assert.deepEqual(built.layers, ['pointer', 'summary', 'body'])
  assert.ok(built.text.includes('\n原文：\n第一段原文\n第二段原文\n出处：'))
  assert.ok(built.text.endsWith('出处：session/session-abc123#37'))
})

test('buildCite：没有摘要内容时只剩指针层', () => {
  const built = buildCite({ ...BASE, intent: '', points: [] })
  assert.deepEqual(built.layers, ['pointer'])
  assert.equal(built.text, `${HEADER}\n出处：session/session-abc123#37`)
})

// ── 时间格式化 ──────────────────────────────────────────────────────
test('时间：时间戳按指定时区格式化为 YYYY-MM-DD HH:mm', () => {
  assert.equal(firstLine(buildCite({ ...BASE, timeZone: 'UTC' }).text), '〔引用〕插件开发 › 话题地图 · 第 37 轮 · 2026-11-24 06:20')
  assert.equal(firstLine(buildCite({ ...BASE, time: new Date(SHANGHAI_TIME) }).text), HEADER)
  assert.equal(firstLine(buildCite({ ...BASE, time: '2026-11-24 14:20' }).text), HEADER)
})

test('时间：缺失时不出空尾巴', () => {
  assert.equal(
    firstLine(buildCite({ ...BASE, time: undefined }).text),
    '〔引用〕插件开发 › 话题地图 · 第 37 轮',
  )
})

test('标题 / 话题缺省时不留多余分隔符', () => {
  assert.equal(
    firstLine(buildCite({ ...BASE, title: '' }).text),
    '〔引用〕插件开发 · 第 37 轮 · 2026-11-24 14:20',
  )
  assert.equal(
    firstLine(buildCite({ ...BASE, topic: '' }).text),
    '〔引用〕话题地图 · 第 37 轮 · 2026-11-24 14:20',
  )
})

// ── token 估算 ──────────────────────────────────────────────────────
test('estimateTokens：中日韩 1 token/字，其余约 3.6 字符/token，向上取整', () => {
  assert.equal(estimateTokens(''), 0)
  assert.equal(estimateTokens(null), 0)
  assert.equal(estimateTokens('中文'), 2)
  assert.equal(estimateTokens('こんにちは'), 5)
  assert.equal(estimateTokens('안녕하세요'), 5)
  assert.equal(estimateTokens('。'), 1) // 中文标点按 1 字算
  assert.equal(estimateTokens('abc'), 1) // ceil(3/3.6)
  assert.equal(estimateTokens('abcd'), 2) // ceil(1.11)
  assert.equal(estimateTokens('a'.repeat(36)), 10)
  assert.equal(estimateTokens('a'.repeat(37)), 11)
  assert.equal(estimateTokens('中a'), 2)
})

test('estimateTokens：中英混排与 emoji', () => {
  // 2 个中文 + 4 个其他字符（空格 abc）→ 2 + ceil(4/3.6)=2 → 4
  assert.equal(estimateTokens('中文 abc'), 4)
  assert.equal(estimateTokens('😀'), 1) // 代理对按 1 个字符算
  assert.equal(estimateTokens('hello world'), 4) // ceil(11/3.6)
  assert.ok(estimateTokens(BASE_TEXT) > 0)
})

// ── 预算砍法 ────────────────────────────────────────────────────────
test('预算：先砍原文，摘要保持完整', () => {
  const body = '一大段原文'.repeat(20)
  const layerOnly = buildCite(BASE)
  const budget = estimateTokens(layerOnly.text)
  const trimmed = buildCite({ ...BASE, body, budget })
  assert.equal(trimmed.trimmed, true)
  assert.deepEqual(trimmed.layers, ['pointer', 'summary'])
  assert.equal(trimmed.text, layerOnly.text)
  assert.equal(trimmed.tokens, budget)
})

test('预算：再砍结论条数，从末尾开始', () => {
  const twoPoints = buildCite({ ...BASE, points: BASE.points.slice(0, 2) })
  const trimmed = buildCite({ ...BASE, budget: twoPoints.tokens })
  assert.equal(trimmed.trimmed, true)
  assert.deepEqual(trimmed.layers, ['pointer', 'summary'])
  assert.equal(trimmed.text, twoPoints.text)
  assert.equal((trimmed.text.match(/^- /gm) || []).length, 2)

  const onePoint = buildCite({ ...BASE, points: BASE.points.slice(0, 1) })
  const stricter = buildCite({ ...BASE, budget: onePoint.tokens })
  assert.equal(stricter.text, onePoint.text)
  assert.equal((stricter.text.match(/^- /gm) || []).length, 1)
})

test('预算：连结论都放不下时，指针与意图永不被砍', () => {
  const trimmed = buildCite({ ...BASE, budget: 1 })
  assert.equal(trimmed.trimmed, true)
  assert.deepEqual(trimmed.layers, ['pointer', 'summary'])
  assert.ok(trimmed.text.includes('意图：把左栏改成三级树'))
  assert.ok(!trimmed.text.includes('结论：'))
  assert.ok(trimmed.text.startsWith(HEADER))
  assert.ok(trimmed.text.endsWith('出处：session/session-abc123#37'))
  // 指针 + 意图本身超过预算时，宁可超预算也不砍——由调用方二次确认（A-4）
  assert.ok(trimmed.tokens > 1)
})

test('预算：默认 5000，超长原文会被自动砍掉', () => {
  const huge = buildCite({ ...BASE, body: 'a'.repeat(20000) })
  assert.equal(huge.trimmed, true)
  assert.deepEqual(huge.layers, ['pointer', 'summary'])
})

// ── 出处反解 ────────────────────────────────────────────────────────
test('parseCite：round-trip 还原 sessionId / turn / header', () => {
  for (const input of [BASE, { ...BASE, body: '原文内容' }, { ...BASE, budget: 1 }]) {
    const parsed = parseCite(buildCite(input).text)
    assert.equal(parsed.sessionId, 'session-abc123')
    assert.equal(parsed.turn, 37)
    assert.equal(parsed.header, HEADER)
  }
})

test('parseCite：缺字段 / 脏文本返回 null', () => {
  assert.equal(parseCite(''), null)
  assert.equal(parseCite(null), null)
  assert.equal(parseCite(123), null)
  assert.equal(parseCite('这里没有任何出处'), null)
  assert.equal(parseCite('出处：session/abc#'), null)
  assert.equal(parseCite('出处：session/#37'), null)
  assert.equal(parseCite('出处：abc#37'), null)
  assert.equal(parseCite('出处：session/abc#37x'), null)
  assert.equal(parseCite('出处：session/abc#0'), null)
})

test('parseCite：出处前后有杂音也能读出指针（header 可缺）', () => {
  const parsed = parseCite('一段说明\n出处：session/x-1#5\n更多说明')
  assert.deepEqual(parsed, { sessionId: 'x-1', turn: 5, header: '' })
})

// ── 折叠成指针 + 摘要 ───────────────────────────────────────────────
test('stripBody：带原文的块还原成默认两层', () => {
  const withBody = buildCite({ ...BASE, body: '第一段\n第二段' })
  assert.equal(stripBody(withBody.text), buildCite(BASE).text)
  // 本来没有原文 → 原样返回
  assert.equal(stripBody(buildCite(BASE).text), buildCite(BASE).text)
  assert.equal(stripBody(''), '')
  assert.equal(stripBody(null), '')
})

test('stripBody：原文里混入假的出处行也不会误删真指针', () => {
  const built = buildCite({ ...BASE, body: '正文\n出处：session/fake#9\n正文续' })
  const stripped = stripBody(built.text)
  assert.ok(stripped.endsWith('出处：session/session-abc123#37'))
  assert.ok(!stripped.includes('session/fake#9'))
  assert.equal(parseCite(stripped).turn, 37)
})

// ── 配置 ────────────────────────────────────────────────────────────
test('citeBudgetOf：合法值取配置，非法/缺失回落（默认 5000）', () => {
  assert.equal(citeBudgetOf({ citeTokenBudget: 1234 }), 1234)
  assert.equal(citeBudgetOf({ citeTokenBudget: '2000' }), 2000)
  assert.equal(citeBudgetOf({ citeTokenBudget: 1234 }, 800), 1234)
  assert.equal(citeBudgetOf({}, 800), 800)
})

test('citeBudgetOf：非法配置回落默认值', () => {
  assert.equal(citeBudgetOf({}), 5000)
  assert.equal(citeBudgetOf(null), 5000)
  assert.equal(citeBudgetOf(undefined), 5000)
  assert.equal(citeBudgetOf({ citeTokenBudget: 0 }), 5000)
  assert.equal(citeBudgetOf({ citeTokenBudget: -3 }), 5000)
  assert.equal(citeBudgetOf({ citeTokenBudget: 'x' }), 5000)
  assert.equal(citeBudgetOf({ citeTokenBudget: null }, 800), 800)
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const f of failures) console.error(`\n${f.name}\n${f.error.stack}`)
  process.exit(1)
}
