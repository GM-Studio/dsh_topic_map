/**
 * 检索内核测试（S-1 ~ S-4、S-6、S-8）。
 *
 * 语料固定、时间固定：所有用例只依赖纯函数，不读文件、不调模型。
 * 关键词口径按 spec：中文子串、多词 AND、大小写不敏感、输入按字面处理。
 *
 * Run: node tests/search-index.mjs
 */

import { strict as assert } from 'node:assert'
import { searchTurns } from '../lib/search-index.js'

let passed = 0
const failures = []
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok   ${name}`) }
  catch (e) { failures.push({ name, error: e }); console.log(`  FAIL ${name}\n       ${e.message}`) }
}

/** 固定"现在"：2026-11-25 10:00（本地时区）。 */
const NOW = new Date(2026, 10, 25, 10, 0, 0).getTime()
/** 同一天内的时刻（本地时区）。 */
const T = (h, m = 0) => new Date(2026, 10, 25, h, m, 0).getTime()

/** 造一条最小可用的轮次记录。 */
function turnOf(patch = {}) {
  return {
    sessionId: 's', turn: 1, start: T(9, 0), end: T(9, 0), ms: 60000,
    prompt: '', response: '', tools: [], files: [],
    usage: {}, model: 'deepseek-v4', endReason: 'completed', interrupted: false, steps: 1,
    ...patch,
  }
}

/** 固定语料：6 轮、3 个会话，字段刻意覆盖每类过滤条件。 */
const TURNS = [
  {
    sessionId: 's1', turn: 1, start: T(9, 0), end: T(9, 1), ms: 60000,
    prompt: '把跳转做到准确，跳转不要跑偏',
    response: '好，先看导航流程。',
    tools: ['read', 'edit'], files: ['lib/client.js'],
    usage: {}, model: 'deepseek-v4', endReason: 'completed', interrupted: false, steps: 3,
  },
  {
    sessionId: 's1', turn: 2, start: T(9, 10), end: T(9, 11), ms: 60000,
    prompt: '定位要准',
    response: '定位逻辑改好了，定位按钮也改。',
    tools: ['edit'], files: ['lib/client.js'],
    usage: {}, model: 'deepseek-v4', endReason: 'completed', interrupted: false, steps: 2,
  },
  {
    sessionId: 's2', turn: 1, start: T(9, 20), end: T(9, 21), ms: 60000,
    prompt: '跳转和定位都要准',
    response: '一起修。',
    tools: ['read'], files: ['lib/jump.js'],
    usage: {}, model: 'deepseek-v4', endReason: 'error', interrupted: false, steps: 1,
  },
  {
    sessionId: 's2', turn: 2, start: T(9, 30), end: T(9, 31), ms: 60000,
    prompt: 'API Key 配置',
    response: 'Key 放在 env 里，别写死。',
    tools: ['read'], files: ['README.md'],
    usage: {}, model: 'deepseek-v4', endReason: 'max-tokens', interrupted: false, steps: 1,
  },
  {
    sessionId: 's3', turn: 1, start: T(9, 40), end: T(9, 41), ms: 60000,
    prompt: '字面量 a.b 与 (x)',
    response: '正则元字符按字面处理。',
    tools: [], files: [],
    usage: {}, model: 'deepseek-v4', endReason: 'completed', interrupted: false, steps: 1,
  },
  {
    sessionId: 's3', turn: 2, start: T(9, 50), end: T(9, 51), ms: 60000,
    prompt: 'axb 不是同一串',
    response: '别把字面量当表达式。',
    tools: [], files: [],
    usage: {}, model: 'deepseek-v4', endReason: 'completed', interrupted: false, steps: 1,
  },
]

/** 状态标签（键 = sessionId#turn，与 design §4 一致）。 */
const LABELS = {
  's1#1': { starred: true },
  's1#2': { solved: true, note: '已修' },
  's2#1': ['followUp'],
}

/** 取命中键，方便断言。 */
const keyOf = hit => `${hit.sessionId}#${hit.turn}`
const keysOf = result => result.hits.map(keyOf)

console.log('\nsearch-index')

// ── S-1 关键词 ──────────────────────────────────────────────────────
test('中文子串：跳转命中两轮', () => {
  const r = searchTurns(TURNS, { keywords: '跳转', now: NOW })
  assert.equal(r.total, 2)
  assert.deepEqual(keysOf(r), ['s1#1', 's2#1'])
  assert.ok(r.hits.every(h => h.snippet.includes('跳转')))
})

test('多词默认 AND：只命中同时含两词的轮次', () => {
  // s1#1 只有"跳转"，s1#2 只有"定位"，都不该进结果
  const r = searchTurns(TURNS, { keywords: '跳转 定位', now: NOW })
  assert.equal(r.total, 1)
  assert.equal(keyOf(r.hits[0]), 's2#1')
  assert.equal(searchTurns(TURNS, { keywords: '跳转', now: NOW }).total, 2)
  assert.equal(searchTurns(TURNS, { keywords: '定位', now: NOW }).total, 2)
})

test('一个词只在提问、一个只在回答，也算命中', () => {
  // "跳转"在 s1#1 提问里，"导航"只在同轮回答里
  const r = searchTurns(TURNS, { keywords: '跳转 导航', now: NOW })
  assert.equal(r.total, 1)
  assert.equal(keyOf(r.hits[0]), 's1#1')
})

test('大小写不敏感', () => {
  for (const keywords of ['API', 'api', 'Key', 'KEY', 'api key']) {
    const r = searchTurns(TURNS, { keywords, now: NOW })
    assert.equal(r.total, 1, `${keywords} 应只命中 API Key 那一轮`)
    assert.equal(keyOf(r.hits[0]), 's2#2')
  }
})

test('用户输入按字面处理，不当正则', () => {
  assert.equal(searchTurns(TURNS, { keywords: 'a.b', now: NOW }).total, 1)   // 只命中字面 a.b
  assert.equal(searchTurns(TURNS, { keywords: 'axb', now: NOW }).total, 1)   // 另一轮
  assert.equal(searchTurns(TURNS, { keywords: 'a|b', now: NOW }).total, 0)   // 不是"或"
  assert.equal(searchTurns(TURNS, { keywords: '(x)', now: NOW }).total, 1)   // 括号不分组
})

test('重复关键词不重复计数', () => {
  const r = searchTurns(TURNS, { keywords: ['跳转', '跳转', '跳转'], now: NOW })
  assert.equal(r.total, 2)
  const hit = r.hits.find(h => keyOf(h) === 's1#1')
  assert.equal(hit.matchCount, 2) // 该轮提问里出现两次，不是六次
})

test('命中字段、次数与匹配片段', () => {
  const r = searchTurns(TURNS, { keywords: '定位', now: NOW })
  const hit = r.hits.find(h => keyOf(h) === 's1#2')
  assert.equal(hit.matchedIn, 'response')
  assert.equal(hit.matchCount, 3)      // 提问 1 次 + 回答 2 次
  assert.equal(hit.promptMatches, 1)
  assert.equal(hit.responseMatches, 2)
  assert.equal(hit.inPrompt, true)
  assert.equal(hit.inResponse, true)
  assert.ok(hit.snippet.includes('定位'))
  assert.equal(hit.time, T(9, 11))
  assert.equal(hit.start, T(9, 10))
  assert.equal(hit.endReason, 'completed')
})

test('只回片段与元信息，不回全文', () => {
  const hit = searchTurns(TURNS, { keywords: '跳转', now: NOW }).hits[0]
  assert.equal(hit.prompt, undefined)
  assert.equal(hit.response, undefined)
  assert.ok(hit.snippet.length <= 200)
})

// ── S-2 时间 ────────────────────────────────────────────────────────
test('时间区间含头含尾', () => {
  const r = searchTurns(TURNS, { now: NOW, timeRange: { from: T(9, 11), to: T(9, 21) } })
  assert.equal(r.total, 2)
  assert.deepEqual(keysOf(r).sort(), ['s1#2', 's2#1'])
  // 端点各减/加 1ms 就能把边界那一轮排除
  assert.deepEqual(keysOf(searchTurns(TURNS, { now: NOW, timeRange: { from: T(9, 11) + 1, to: T(9, 21) } })), ['s2#1'])
  assert.deepEqual(keysOf(searchTurns(TURNS, { now: NOW, timeRange: { from: T(9, 11), to: T(9, 21) - 1 } })), ['s1#2'])
})

test('时间筛选与关键词组合', () => {
  const r = searchTurns(TURNS, { keywords: '跳转', now: NOW, timeRange: { from: T(9, 10), to: T(9, 30) } })
  assert.equal(r.total, 1)
  assert.equal(keyOf(r.hits[0]), 's2#1')
})

test('timeRange 也认 Date，直接比时间戳', () => {
  const r = searchTurns(TURNS, { now: NOW, timeRange: { from: new Date(T(9, 10)), to: new Date(T(9, 30)) } })
  assert.equal(r.total, 2)
})

test('没有时间的轮次在时间筛选下被排除', () => {
  const r = searchTurns([turnOf({ start: undefined, end: undefined })], { now: NOW, timeRange: { from: 0, to: NOW } })
  assert.equal(r.total, 0)
})

// ── S-3 结构过滤 ────────────────────────────────────────────────────
test('会话过滤（数组 / Set）', () => {
  assert.equal(searchTurns(TURNS, { now: NOW, filters: { sessionIds: ['s3'] } }).total, 2)
  assert.equal(searchTurns(TURNS, { now: NOW, filters: { sessionIds: new Set(['s2']) } }).total, 2)
})

test('工具名过滤，大小写不敏感', () => {
  assert.deepEqual(searchTurns(TURNS, { now: NOW, filters: { tools: ['edit'] } }).hits.map(h => h.turn).sort(), [1, 2])
  assert.equal(searchTurns(TURNS, { now: NOW, filters: { tools: ['EDIT'] } }).total, 2)
  assert.equal(searchTurns(TURNS, { now: NOW, filters: { tools: ['no-such-tool'] } }).total, 0)
})

test('文件路径子串过滤，大小写不敏感', () => {
  assert.equal(searchTurns(TURNS, { now: NOW, filters: { files: ['client.js'] } }).total, 2)
  assert.equal(searchTurns(TURNS, { now: NOW, filters: { files: ['CLIENT.JS'] } }).total, 2)
  assert.equal(searchTurns(TURNS, { now: NOW, filters: { files: ['lib/jump'] } }).total, 1)
})

test('endReason 过滤（单值 / 多值或）', () => {
  assert.equal(searchTurns(TURNS, { now: NOW, filters: { endReason: 'max-tokens' } }).total, 1)
  assert.equal(searchTurns(TURNS, { now: NOW, filters: { endReason: ['error', 'max-tokens'] } }).total, 2)
})

test('状态过滤：三开关任一，标签来源多样', () => {
  assert.equal(searchTurns(TURNS, { now: NOW, labels: LABELS, filters: { statuses: ['solved'] } }).total, 1)
  assert.equal(searchTurns(TURNS, { now: NOW, labels: LABELS, filters: { statuses: ['starred', 'followUp'] } }).total, 2)
  // Map 来源 + 小写状态名
  const map = new Map([['s2#1', { followUp: true }]])
  assert.equal(searchTurns(TURNS, { now: NOW, labels: map, filters: { statuses: ['followup'] } }).total, 1)
  // 没有标签时状态过滤不命中
  assert.equal(searchTurns(TURNS, { now: NOW, filters: { statuses: ['starred'] } }).total, 0)
})

// ── S-4 组合 ────────────────────────────────────────────────────────
test('五类过滤同时 AND', () => {
  const base = {
    keywords: '跳转',
    now: NOW,
    labels: LABELS,
    filters: {
      sessionIds: ['s1'],
      tools: ['edit'],
      files: ['client.js'],
      endReason: 'completed',
      statuses: ['starred'],
    },
  }
  const r = searchTurns(TURNS, base)
  assert.equal(r.total, 1)
  assert.equal(keyOf(r.hits[0]), 's1#1')
  // 任一条件不满足 -> 0（这里把状态换掉）
  assert.equal(searchTurns(TURNS, { ...base, filters: { ...base.filters, statuses: ['solved'] } }).total, 0)
  assert.equal(searchTurns(TURNS, { ...base, filters: { ...base.filters, sessionIds: ['s2'] } }).total, 0)
})

// ── S-6 分组 ────────────────────────────────────────────────────────
test('按会话折叠：count / lanes / 组内命中', () => {
  const r = searchTurns(TURNS, { now: NOW, sort: 'time', groupBy: 'session' })
  assert.equal(r.total, 6)
  assert.equal(r.hits.length, 3)
  assert.deepEqual(r.hits.map(g => g.sessionId), ['s3', 's2', 's1'])
  assert.deepEqual(r.hits.map(g => g.count), [2, 2, 2])
  assert.deepEqual(r.hits.map(g => g.lanes), [1, 1, 1]) // lanes 是话题段数量占位
  assert.deepEqual(r.hits[0].hits.map(h => h.turn), [2, 1])
  assert.equal(r.hits[0].latest, T(9, 51))
  assert.equal(r.hits.reduce((n, g) => n + g.hits.length, 0), 6)
  assert.equal(r.truncated, false)
})

test('分组时 limit 作用于组，截断标志仍看命中总数', () => {
  const r = searchTurns(TURNS, { now: NOW, sort: 'time', groupBy: 'session', limit: 1 })
  assert.equal(r.hits.length, 1)
  assert.equal(r.hits[0].sessionId, 's3')
  assert.equal(r.total, 6)
  assert.equal(r.truncated, true)
})

test('groupBy:none 平铺', () => {
  const r = searchTurns(TURNS, { now: NOW, groupBy: 'none', sort: 'time' })
  assert.equal(r.hits.length, 6)
  assert.equal(r.hits[0].count, undefined)
  assert.ok(r.hits[0].matchedIn)
})

// ── S-8 截断 ────────────────────────────────────────────────────────
test('limit 小于总数时 truncated 为真', () => {
  const r = searchTurns(TURNS, { now: NOW, limit: 2 })
  assert.equal(r.total, 6)
  assert.equal(r.hits.length, 2)
  assert.equal(r.truncated, true)
})

test('limit 足够大时不截断，默认 limit 也够用', () => {
  const all = searchTurns(TURNS, { now: NOW, limit: 100 })
  assert.equal(all.hits.length, 6)
  assert.equal(all.truncated, false)
  const dflt = searchTurns(TURNS, { now: NOW })
  assert.equal(dflt.hits.length, 6)
  assert.equal(dflt.truncated, false)
})

// ── 排序 ────────────────────────────────────────────────────────────
test('默认相关度排序，每条带分数拆解', () => {
  const r = searchTurns(TURNS, { keywords: '跳转', now: NOW })
  assert.equal(r.hits[0].score, 5.4) // 3 + 0.2×2 + 2×1.0
  assert.equal(r.hits[1].score, 5.2) // 3 + 0.2×1 + 2×1.0
  assert.ok(r.hits[0].breakdown.parts.some(p => p.text === '提问×3'))
  assert.ok(r.hits[0].breakdown.parts.some(p => p.text === '今天×2'))
})

test('状态加权影响默认顺序', () => {
  const r = searchTurns(TURNS, { now: NOW, labels: { 's2#1': { starred: true } } })
  assert.equal(keyOf(r.hits[0]), 's2#1')
  assert.equal(r.hits[0].breakdown.status, 2)
})

test('sort:time 按结束时间倒序，且仍保留分数', () => {
  const r = searchTurns(TURNS, { now: NOW, sort: 'time' })
  assert.deepEqual(keysOf(r), ['s3#2', 's3#1', 's2#2', 's2#1', 's1#2', 's1#1'])
  const kw = searchTurns(TURNS, { keywords: '跳转', now: NOW, sort: 'time' })
  assert.deepEqual(keysOf(kw), ['s2#1', 's1#1'])
  assert.ok(kw.hits[0].score > 0)
  assert.ok(Array.isArray(kw.hits[0].breakdown.parts))
})

// ── 片段 ────────────────────────────────────────────────────────────
test('snippet 取命中位置前后各 40 字', () => {
  const filler = '长'.repeat(100)
  const r = searchTurns([turnOf({ prompt: filler + '跳转' + filler })], { keywords: '跳转', now: NOW })
  const sn = r.hits[0].snippet
  assert.equal(sn.length, 82)
  assert.equal(sn, '长'.repeat(40) + '跳转' + '长'.repeat(40))
})

test('snippet 压缩空白', () => {
  const prompt = '前'.repeat(60) + '\n\n   跳转\t\t到真实对话   ' + '后'.repeat(60)
  const r = searchTurns([turnOf({ prompt })], { keywords: '跳转', now: NOW })
  const sn = r.hits[0].snippet
  assert.ok(!/[\n\t]/.test(sn))
  assert.ok(!/\s{2,}/.test(sn))
  assert.ok(sn.includes('跳转'))
  assert.ok(sn.length <= 200)
  assert.ok(!sn.startsWith(' ') && !sn.endsWith(' '))
})

test('snippet 最长 200 字', () => {
  const r = searchTurns([turnOf({ prompt: 'a'.repeat(500) })], { keywords: 'a'.repeat(400), now: NOW })
  assert.equal(r.hits[0].snippet.length, 200)
})

test('空关键词只走过滤，片段取提问开头', () => {
  const r = searchTurns(TURNS, { now: NOW, filters: { sessionIds: ['s3'] } })
  assert.equal(r.total, 2)
  const hit = r.hits.find(h => keyOf(h) === 's3#1')
  assert.equal(hit.matchCount, 0)
  assert.equal(hit.matchedIn, 'prompt')
  assert.equal(hit.inPrompt, false)
  assert.ok(hit.snippet.includes('字面量'))
})

test('每条命中带 L0 摘要原料：提问首句 ≤40 字', () => {
  const r = searchTurns([turnOf({ prompt: '第一句要短。后面还有很长的内容，不该进首句。' })], { now: NOW })
  assert.equal(r.hits[0].promptHead, '第一句要短')
  assert.ok(r.hits[0].promptHead.length <= 40)
  const noStop = searchTurns([turnOf({ prompt: '一'.repeat(100) })], { now: NOW })
  assert.equal(noStop.hits[0].promptHead.length, 40)
  assert.equal(noStop.hits[0].promptHead, '一'.repeat(40))
  // 首句足够短，不调模型也能显示（V-11 L0）
  const short = searchTurns([turnOf({ prompt: '  短 提问  ' })], { now: NOW })
  assert.equal(short.hits[0].promptHead, '短 提问')
})

test('命中带定位所需的 seq 与文本截断标志（F-1）', () => {
  const r = searchTurns([turnOf({ turn: 7, seq: 812, truncated: true })], { now: NOW })
  assert.equal(r.hits[0].seq, 812)
  assert.equal(r.hits[0].truncated, true)
  const open = searchTurns([turnOf({ turn: 1, start: T(9, 0), end: null })], { now: NOW })
  assert.equal(open.hits[0].truncated, false)
  assert.equal(open.hits[0].time, T(9, 0)) // 未结束的轮次用 start 当时间
})

// ── 边界 ────────────────────────────────────────────────────────────
test('非法输入不崩', () => {
  assert.deepEqual(searchTurns(null, null), { hits: [], total: 0, truncated: false })
  const r = searchTurns([{ sessionId: 'x', turn: 1 }], {})
  assert.equal(r.total, 1)
  assert.equal(r.hits[0].time, null)
  assert.equal(r.hits[0].snippet, '')
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const f of failures) console.error(`\n${f.name}\n${f.error.stack}`)
  process.exit(1)
}
