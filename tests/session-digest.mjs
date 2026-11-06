/**
 * 会话提炼测试。
 *
 * 这是跨会话归类的第一步：先把每个会话压成一句话，再分类。
 * 重点测两件事：
 *   1. 长会话采样（1 轮到 51 轮差别极大，不能一个会话吃掉全部预算）
 *   2. 严格长度校验（错位会把主题安到别的会话上）
 *
 * Run: node tests/session-digest.mjs
 */

import { strict as assert } from 'node:assert'
import {
  applyDigest,
  buildDigestPrompt,
  parseDigest,
  prepareDigestInput,
  sampleTurns,
  toCategoryInput,
} from '../lib/session-digest.js'

let passed = 0
const failures = []
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok   ${name}`) }
  catch (e) { failures.push({ name, error: e }); console.log(`  FAIL ${name}\n       ${e.message}`) }
}

/** 造 n 轮事实。 */
function turnsOf(n) {
  return Array.from({ length: n }, (_, i) => ({
    turn: i + 1,
    prompt: `第${i + 1}轮提问内容`,
    response: `第${i + 1}轮回复`,
  }))
}

console.log('\nsession-digest')

// ── 采样 ────────────────────────────────────────────────────────────
test('短会话全部保留（不采样）', () => {
  const t = turnsOf(5)
  assert.equal(sampleTurns(t, 10).length, 5)
})

test('长会话采样到上限', () => {
  const t = turnsOf(51)
  assert.equal(sampleTurns(t, 10).length, 10)
})

test('采样保留首 3 轮与尾 2 轮（开场定主题、结尾有结论）', () => {
  const t = turnsOf(51)
  const got = sampleTurns(t, 10)
  assert.deepEqual([got[0].turn, got[1].turn, got[2].turn], [1, 2, 3], '应含首 3 轮')
  assert.deepEqual([got[got.length - 2].turn, got[got.length - 1].turn], [50, 51], '应含尾 2 轮')
})

test('采样结果不重复', () => {
  const got = sampleTurns(turnsOf(51), 10)
  const set = new Set(got.map(t => t.turn))
  assert.equal(set.size, got.length, '不应有重复轮次')
})

test('采样结果保持时间顺序', () => {
  const got = sampleTurns(turnsOf(51), 10)
  const sorted = [...got].sort((a, b) => a.turn - b.turn)
  assert.deepEqual(got.map(t => t.turn), sorted.map(t => t.turn), '应按时间升序')
})

test('采样不修改入参', () => {
  const t = turnsOf(51)
  const before = t.length
  sampleTurns(t, 10)
  assert.equal(t.length, before)
})

test('空输入与非法上限不崩', () => {
  assert.equal(sampleTurns([], 10).length, 0)
  assert.equal(sampleTurns(null).length, 0)
  assert.equal(sampleTurns(turnsOf(5), 0).length, 5, '非法上限退回默认')
})

// ── 准备输入 ────────────────────────────────────────────────────────
test('短会话全量给模型', () => {
  const it = prepareDigestInput({ sessionId: 's1', title: '话题地图', turns: turnsOf(8) })
  assert.equal(it.id, 's1')
  assert.equal(it.turns, 8)
  assert.equal(it.samples.length, 8)
})

test('长会话只给采样后的', () => {
  const it = prepareDigestInput({ sessionId: 's2', title: '长会话', turns: turnsOf(51) })
  assert.equal(it.turns, 51, '轮数仍报真实值')
  assert.equal(it.samples.length, 10, '但只给 10 条样本')
})

test('样本里带提问与回复摘要', () => {
  const it = prepareDigestInput({ sessionId: 's', title: 't', turns: turnsOf(2) })
  assert.ok(it.samples[0].includes('第1轮提问内容'), '应含提问')
  assert.ok(it.samples[0].includes('答：'), '应含回复摘要')
})

test('超长文本被截断', () => {
  const it = prepareDigestInput({
    sessionId: 's', title: 't',
    turns: [{ turn: 1, prompt: 'x'.repeat(2000), response: 'y'.repeat(2000) }],
  })
  assert.ok(it.samples[0].length < 300, `样本应被截断，实际 ${it.samples[0].length}`)
})

test('空会话不崩', () => {
  const it = prepareDigestInput({ sessionId: 's', title: 't', turns: [] })
  assert.equal(it.turns, 0)
  assert.equal(it.samples.length, 0)
})

// ── 提示词 ──────────────────────────────────────────────────────────
test('提示词要求一句话 + 关键词', () => {
  const p = buildDigestPrompt([prepareDigestInput({ sessionId: 's', title: 'X', turns: turnsOf(3) })])
  assert.ok(p.system.includes('一句话'), '应要求一句话主题')
  assert.ok(p.system.includes('keywords'), '应要求关键词')
  assert.ok(p.system.includes('不要写'), '应禁止"讨论了…"这种空话')
})

test('提示词带上会话名与轮数', () => {
  const p = buildDigestPrompt([prepareDigestInput({ sessionId: 's', title: '话题地图', turns: turnsOf(5) })])
  assert.ok(p.user.includes('话题地图'))
  assert.ok(p.user.includes('5 轮'))
})

test('提示词长度对得上条数', () => {
  const items = [
    prepareDigestInput({ sessionId: 'a', title: 'A', turns: turnsOf(2) }),
    prepareDigestInput({ sessionId: 'b', title: 'B', turns: turnsOf(3) }),
  ]
  const p = buildDigestPrompt(items)
  assert.ok(p.user.includes('长度 2'))
})

// ── 解析 ────────────────────────────────────────────────────────────
test('解析标准输出', () => {
  const got = parseDigest('[{"topic":"修复跳转","keywords":["跳转","修复"]}]', 1)
  assert.equal(got.length, 1)
  assert.equal(got[0].topic, '修复跳转')
  assert.deepEqual(got[0].keywords, ['跳转', '修复'])
})

test('长度不符整批作废（错位会把主题安到别的会话）', () => {
  assert.equal(parseDigest('[{"topic":"a","keywords":[]}]', 2), null)
})

test('缺 topic 作废', () => {
  assert.equal(parseDigest('[{"keywords":["a"]}]', 1), null)
  assert.equal(parseDigest('[{"topic":"","keywords":[]}]', 1), null)
})

test('关键词缺失时退回空数组', () => {
  const got = parseDigest('[{"topic":"修复跳转"}]', 1)
  assert.deepEqual(got[0].keywords, [])
})

test('关键词数量与长度受限', () => {
  const got = parseDigest('[{"topic":"t","keywords":["a","b","c","d","e","f"]}]', 1)
  assert.ok(got[0].keywords.length <= 4, '最多 4 个关键词')
})

test('容忍代码围栏', () => {
  const got = parseDigest('```json\n[{"topic":"x","keywords":[]}]\n```', 1)
  assert.equal(got[0].topic, 'x')
})

test('无法解析返回 null', () => {
  assert.equal(parseDigest('不知道', 1), null)
  assert.equal(parseDigest('', 1), null)
})

// ── 合并与转换 ──────────────────────────────────────────────────────
test('把提炼结果合回会话', () => {
  const items = [prepareDigestInput({ sessionId: 's1', title: 'A', turns: turnsOf(2) })]
  const out = applyDigest(items, [{ topic: '修复跳转', keywords: ['跳转'] }])
  assert.equal(out[0].topic, '修复跳转')
  assert.deepEqual(out[0].keywords, ['跳转'])
})

test('长度不符时不合并', () => {
  const items = [prepareDigestInput({ sessionId: 's1', title: 'A', turns: turnsOf(2) })]
  assert.equal(applyDigest(items, []), null)
})

test('转成分类输入：用主题+关键词，不用原始对话', () => {
  const digested = [{
    id: 's1', name: '会话A', turns: 8,
    topic: '修复话题地图跳转', keywords: ['跳转', '定位'],
  }]
  const out = toCategoryInput(digested)
  assert.equal(out[0].sample, '修复话题地图跳转（跳转、定位）')
  assert.equal(out[0].id, 's1')
  assert.equal(out[0].turns, 8)
})

test('没有关键词时只用主题', () => {
  const out = toCategoryInput([{ id: 's', name: 'n', turns: 1, topic: '做某事', keywords: [] }])
  assert.equal(out[0].sample, '做某事')
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const f of failures) console.error(`\n${f.name}\n${f.error.stack}`)
  process.exit(1)
}
