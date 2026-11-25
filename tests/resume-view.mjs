/**
 * 断点续接视图模型测试（V-8 / design.md §4）。
 *
 * 纯函数：now 必须由参数传入，不读系统时钟、不碰 DOM。
 *
 * Run: node tests/resume-view.mjs
 */

import { strict as assert } from 'node:assert'
import { toResumeCards } from '../lib/resume-view.js'

let passed = 0
const failures = []
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok   ${name}`) }
  catch (e) { failures.push({ name, error: e }); console.log(`  FAIL ${name}\n       ${e.message}`) }
}

/** 固定"现在"：2026-11-25 10:00（本地时区）。 */
const NOW = new Date(2026, 10, 25, 10, 0, 0).getTime()
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
/** n 天前的 09:00（本地时区）。 */
const daysAgo = n => new Date(2026, 10, 25 - n, 9, 0, 0).getTime()

/** 一条会话输入的默认形状。 */
function sessionOf(patch = {}) {
  return {
    sessionId: 's1',
    title: '会话一',
    topicPath: ['插件开发', '话题地图'],
    turnCount: 10,
    lastTurn: 10,
    lastActivity: daysAgo(3),
    endReason: 'completed',
    interrupted: false,
    laneTitle: '对话跳转修复',
    hasChanges: false,
    ...patch,
  }
}

/** 摊平所有卡片。 */
const cardsOf = result => result.groups.flatMap(group => group.cards)
/** 空的期望结构。 */
const EMPTY = {
  groups: [
    { key: 'followUp', title: '待跟进', cards: [] },
    { key: 'unfinished', title: '未完成', cards: [] },
    { key: 'recent', title: '近期', cards: [] },
  ],
  total: 0,
  shown: 0,
  hasMore: false,
}

console.log('\nresume-view')

// ── 三组归位 ────────────────────────────────────────────────────────
test('三组归位：待跟进 / 未完成 / 近期', () => {
  const sessions = [
    sessionOf({ sessionId: 's-follow', turnCount: 78, lastTurn: 78, lastActivity: daysAgo(2), endReason: 'error' }),
    sessionOf({ sessionId: 's-error', lastActivity: daysAgo(1), endReason: 'max-tokens' }),
    sessionOf({ sessionId: 's-interrupt', lastActivity: daysAgo(4), interrupted: true }),
    sessionOf({ sessionId: 's-solved', lastActivity: daysAgo(3), endReason: 'error' }),
    sessionOf({ sessionId: 's-recent', lastActivity: daysAgo(6), endReason: 'completed' }),
  ]
  const labels = {
    's-follow#78': { followUp: true },
    's-solved#10': { solved: true },
  }
  const result = toResumeCards({ sessions, labels, now: NOW })
  assert.deepEqual(result.groups.map(group => group.key), ['followUp', 'unfinished', 'recent'])
  assert.deepEqual(result.groups.map(group => group.title), ['待跟进', '未完成', '近期'])
  assert.deepEqual(result.groups[0].cards.map(card => card.sessionId), ['s-follow'])
  // 组内按 lastActivity 倒序：error 1 天前在 interrupt 4 天前之前
  assert.deepEqual(result.groups[1].cards.map(card => card.sessionId), ['s-error', 's-interrupt'])
  // solved 把会话从"未完成"捞出，落到近期
  assert.deepEqual(result.groups[2].cards.map(card => card.sessionId), ['s-solved', 's-recent'])
  assert.equal(result.total, 5)
  assert.equal(result.shown, 5)
  assert.equal(result.hasMore, false)
})

test('solved 与 followUp 同时为真：落近期（solved 优先）', () => {
  const sessions = [sessionOf({ sessionId: 's-both', turnCount: 7, lastTurn: 7, endReason: 'error', lastActivity: daysAgo(2) })]
  const labels = { 's-both#7': { solved: true, followUp: true } }
  const result = toResumeCards({ sessions, labels, now: NOW })
  assert.deepEqual(result.groups[0].cards, []) // 不进待跟进
  assert.deepEqual(result.groups[1].cards, []) // 也不进未完成
  assert.deepEqual(result.groups[2].cards.map(card => card.sessionId), ['s-both'])
  const card = result.groups[2].cards[0]
  assert.equal(card.reason, '已标记完成')
  assert.equal(card.primaryAction, 'locate')
  assert.equal(card.tone, 'muted')
  assert.deepEqual(card.badges, ['已标记'])
})

test('组内按 lastActivity 倒序', () => {
  const sessions = [
    sessionOf({ sessionId: 'a', lastActivity: daysAgo(5) }),
    sessionOf({ sessionId: 'b', lastActivity: daysAgo(1) }),
    sessionOf({ sessionId: 'c', lastActivity: daysAgo(3) }),
  ]
  const result = toResumeCards({ sessions, now: NOW })
  assert.deepEqual(result.groups[2].cards.map(card => card.sessionId), ['b', 'c', 'a'])
})

// ── 上限与截断 ──────────────────────────────────────────────────────
test('近期组最多 5 条，total 仍按全部候选算', () => {
  const sessions = Array.from({ length: 12 }, (_, index) => sessionOf({
    sessionId: `r${index}`,
    lastActivity: daysAgo(index + 1),
  }))
  const result = toResumeCards({ sessions, now: NOW, limit: 10 })
  assert.equal(result.total, 12)
  assert.equal(result.shown, 5)
  assert.equal(result.hasMore, true)
  assert.deepEqual(result.groups[2].cards.map(card => card.sessionId), ['r0', 'r1', 'r2', 'r3', 'r4'])
})

test('总上限按组顺序分配：先待跟进，再未完成', () => {
  const sessions = [
    sessionOf({ sessionId: 'f1', lastActivity: daysAgo(2) }),
    sessionOf({ sessionId: 'f2', lastActivity: daysAgo(3) }),
    sessionOf({ sessionId: 'f3', lastActivity: daysAgo(4) }),
    sessionOf({ sessionId: 'e1', endReason: 'error', lastActivity: daysAgo(1) }),
    sessionOf({ sessionId: 'e2', endReason: 'failed', lastActivity: daysAgo(5) }),
    sessionOf({ sessionId: 'e3', endReason: 'blocked', lastActivity: daysAgo(6) }),
  ]
  const labels = {
    'f1#10': { followUp: true },
    'f2#10': { followUp: true },
    'f3#10': { followUp: true },
  }
  const result = toResumeCards({ sessions, labels, now: NOW, limit: 4 })
  assert.deepEqual(result.groups.map(group => group.cards.length), [3, 1, 0])
  assert.deepEqual(result.groups[1].cards.map(card => card.sessionId), ['e1'])
  assert.equal(result.shown, 4)
  assert.equal(result.total, 6)
  assert.equal(result.hasMore, true)
})

test('limit 默认 10', () => {
  const sessions = Array.from({ length: 12 }, (_, index) => sessionOf({
    sessionId: `f${index}`,
    lastActivity: daysAgo(index + 1),
  }))
  const labels = Object.fromEntries(sessions.map(session => [`${session.sessionId}#10`, { followUp: true }]))
  const result = toResumeCards({ sessions, labels, now: NOW })
  assert.equal(result.groups[0].cards.length, 10)
  assert.equal(result.shown, 10)
  assert.equal(result.total, 12)
  assert.equal(result.hasMore, true)
})

test('候选不超上限时 hasMore 为 false', () => {
  const result = toResumeCards({
    sessions: [sessionOf({ sessionId: 'a' }), sessionOf({ sessionId: 'b' })],
    now: NOW,
  })
  assert.equal(result.total, 2)
  assert.equal(result.shown, 2)
  assert.equal(result.hasMore, false)
})

// ── 主按钮 / 语气 / 理由 ────────────────────────────────────────────
test('primaryAction 四种分支', () => {
  const sessions = [
    sessionOf({ sessionId: 'follow', lastActivity: daysAgo(2) }),
    sessionOf({ sessionId: 'fail', endReason: 'error', lastActivity: daysAgo(1) }),
    sessionOf({ sessionId: 'interrupt', interrupted: true, lastActivity: daysAgo(3) }),
    sessionOf({ sessionId: 'changes', hasChanges: true, lastActivity: daysAgo(4) }),
    sessionOf({ sessionId: 'plain', lastActivity: daysAgo(5) }),
  ]
  const labels = { 'follow#10': { followUp: true } }
  const cards = cardsOf(toResumeCards({ sessions, labels, now: NOW }))
  const actionOf = id => cards.find(card => card.sessionId === id).primaryAction
  assert.equal(actionOf('follow'), 'continue')
  assert.equal(actionOf('fail'), 'retry')
  assert.equal(actionOf('interrupt'), 'retry')
  assert.equal(actionOf('changes'), 'changes')
  assert.equal(actionOf('plain'), 'locate')
})

test('tone：待跟进 warn / 失败 danger / 中断 warn / 其余 muted', () => {
  const sessions = [
    sessionOf({ sessionId: 'follow', lastActivity: daysAgo(2) }),
    sessionOf({ sessionId: 'fail', endReason: 'error', lastActivity: daysAgo(1) }),
    sessionOf({ sessionId: 'interrupt', interrupted: true, lastActivity: daysAgo(3) }),
    sessionOf({ sessionId: 'plain', lastActivity: daysAgo(4) }),
  ]
  const labels = { 'follow#10': { followUp: true } }
  const cards = cardsOf(toResumeCards({ sessions, labels, now: NOW }))
  const toneOf = id => cards.find(card => card.sessionId === id).tone
  assert.equal(toneOf('follow'), 'warn')
  assert.equal(toneOf('fail'), 'danger')
  assert.equal(toneOf('interrupt'), 'warn')
  assert.equal(toneOf('plain'), 'muted')
})

test('reason：待跟进 / 失败 / 中断 / 静止 N 天 / 已标记完成', () => {
  const follow = cardsOf(toResumeCards({
    sessions: [sessionOf({ sessionId: 'follow', lastActivity: daysAgo(2) })],
    labels: { 'follow#10': { followUp: true } },
    now: NOW,
  }))[0]
  assert.equal(follow.reason, '标记待跟进')

  const fail = cardsOf(toResumeCards({
    sessions: [sessionOf({ sessionId: 'fail', endReason: 'error', lastActivity: daysAgo(1) })],
    now: NOW,
  }))[0]
  assert.equal(fail.reason, '失败：error')

  const interrupt = cardsOf(toResumeCards({
    sessions: [sessionOf({ sessionId: 'interrupt', interrupted: true, lastActivity: daysAgo(1) })],
    now: NOW,
  }))[0]
  assert.equal(interrupt.reason, '中断')

  const quiet = cardsOf(toResumeCards({
    sessions: [sessionOf({ sessionId: 'quiet', lastActivity: daysAgo(3) })],
    now: NOW,
  }))[0]
  assert.equal(quiet.reason, '静止 3 天')

  const today = cardsOf(toResumeCards({
    sessions: [sessionOf({ sessionId: 'today', lastActivity: NOW - 3 * HOUR })],
    now: NOW,
  }))[0]
  assert.equal(today.reason, '今天活跃')

  const solved = cardsOf(toResumeCards({
    sessions: [sessionOf({ sessionId: 'solved', endReason: 'error', lastActivity: daysAgo(2) })],
    labels: { 'solved#10': { solved: true } },
    now: NOW,
  }))[0]
  assert.equal(solved.reason, '已标记完成')
})

test('badges：有变更 / 已标记（子集与顺序）', () => {
  const sessions = [
    sessionOf({ sessionId: 'both', hasChanges: true }),
    sessionOf({ sessionId: 'plain' }),
  ]
  const labels = { 'both#10': { starred: true } }
  const cards = cardsOf(toResumeCards({ sessions, labels, now: NOW }))
  const both = cards.find(card => card.sessionId === 'both')
  const plain = cards.find(card => card.sessionId === 'plain')
  assert.deepEqual(both.badges, ['有变更', '已标记'])
  assert.deepEqual(plain.badges, [])
})

// ── 标签来源 ────────────────────────────────────────────────────────
test('labels 支持对象 / Map / 函数 / 数组标签', () => {
  const session = sessionOf({ sessionId: 's1' })
  const viaMap = toResumeCards({
    sessions: [session],
    labels: new Map([['s1#10', { followUp: true }]]),
    now: NOW,
  })
  assert.equal(viaMap.groups[0].cards.length, 1)

  const viaFunction = toResumeCards({
    sessions: [session],
    labels: () => ({ solved: true }),
    now: NOW,
  })
  assert.equal(viaFunction.groups[2].cards[0].reason, '已标记完成')

  const viaArray = toResumeCards({
    sessions: [session],
    labels: { 's1#10': ['followUp'] },
    now: NOW,
  })
  assert.equal(viaArray.groups[0].cards.length, 1)
})

// ── 卡片字段 ────────────────────────────────────────────────────────
test('卡片字段：path / lane / 轮次 / 标题兜底', () => {
  const rows = cardsOf(toResumeCards({
    sessions: [sessionOf({
      sessionId: 'session-abcdef123456',
      title: '',
      topicPath: ['插件开发', '话题地图'],
      laneTitle: '',
    })],
    now: NOW,
  }))
  const card = rows[0]
  assert.equal(card.sessionId, 'session-abcdef123456')
  assert.equal(card.title, 'abcdef12')
  assert.equal(card.path, '插件开发 › 话题地图')
  assert.equal(card.lastTurnLabel, '第 10 轮')
  assert.equal(card.laneLabel, '')
  assert.equal(card.turn, 10)

  // topicPath 字符串原样用；完全无名时给占位
  const stringPath = cardsOf(toResumeCards({
    sessions: [sessionOf({ sessionId: 's2', topicPath: '插件开发 / 话题地图' })],
    now: NOW,
  }))[0]
  assert.equal(stringPath.path, '插件开发 / 话题地图')

  const nameless = cardsOf(toResumeCards({
    sessions: [{ sessionId: null, turnCount: 2, lastTurn: 2, lastActivity: daysAgo(1) }],
    now: NOW,
  }))[0]
  assert.equal(nameless.title, '未命名会话')
  assert.equal(nameless.path, '')
  assert.equal(nameless.lastTurnLabel, '第 2 轮')
})

// ── 时间 ────────────────────────────────────────────────────────────
test('lastActivityLabel 与 hit-view 同一分档', () => {
  const sessions = [
    sessionOf({ sessionId: 't3h', lastActivity: NOW - 3 * HOUR }),
    sessionOf({ sessionId: 't1d', lastActivity: daysAgo(1) }),
    sessionOf({ sessionId: 't6d', lastActivity: daysAgo(6) }),
    sessionOf({ sessionId: 't8d', lastActivity: daysAgo(8) }),
    sessionOf({ sessionId: 'tj', lastActivity: NOW - 30 * 1000 }),
  ]
  const cards = cardsOf(toResumeCards({ sessions, now: NOW }))
  const labelOf = id => cards.find(card => card.sessionId === id).lastActivityLabel
  assert.equal(labelOf('t3h'), '3 小时前')
  assert.equal(labelOf('t1d'), '昨天') // 25 小时前
  assert.equal(labelOf('t6d'), '6 天前')
  assert.equal(labelOf('t8d'), '2026-11-17')
  assert.equal(labelOf('tj'), '刚刚')
})

test('非法时间安全降级，不抛', () => {
  const result = toResumeCards({
    sessions: [
      sessionOf({ sessionId: 'old', lastActivity: daysAgo(9) }),
      sessionOf({ sessionId: 'bad', lastActivity: 'not-a-time' }),
    ],
    now: NOW,
  })
  const cards = cardsOf(result)
  const bad = cards.find(card => card.sessionId === 'bad')
  assert.equal(bad.lastActivityLabel, '')
  assert.equal(bad.reason, '活跃时间未知')
  // 时间无效的排最后
  assert.deepEqual(result.groups[2].cards.map(card => card.sessionId), ['old', 'bad'])

  // 连 now 都没传：不崩，标签为空
  const noNow = cardsOf(toResumeCards({ sessions: [sessionOf({ sessionId: 'only' })] }))[0]
  assert.equal(noNow.lastActivityLabel, '')
  assert.equal(noNow.reason, '活跃时间未知')
})

// ── 边界 ────────────────────────────────────────────────────────────
test('空输入 / 缺字段不崩', () => {
  assert.deepEqual(toResumeCards({ now: NOW }), EMPTY)
  assert.deepEqual(toResumeCards(null), EMPTY)
  assert.deepEqual(toResumeCards({ sessions: [], now: NOW }), EMPTY)
  // 非对象与 0 轮会话被跳过
  assert.equal(toResumeCards({ sessions: [null, 'x', 3], now: NOW }).total, 0)
  assert.equal(toResumeCards({
    sessions: [sessionOf({ turnCount: 0, lastTurn: null })],
    now: NOW,
  }).total, 0)
  // 缺字段的会话仍能生成卡片
  const minimal = cardsOf(toResumeCards({
    sessions: [{ sessionId: 'x', lastActivity: daysAgo(1) }],
    now: NOW,
  }))[0]
  assert.equal(minimal.sessionId, 'x')
  assert.equal(minimal.lastTurnLabel, '')
  assert.equal(minimal.turn, null)
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const f of failures) console.error(`\n${f.name}\n${f.error.stack}`)
  process.exit(1)
}
