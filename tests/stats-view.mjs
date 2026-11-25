/**
 * 统计视图模型测试（V-5）：聚合、活跃天数、排序与格式化。
 *
 * 纯函数：now 必须由参数传入，不读系统时钟、不碰 DOM；固定时间戳，
 * 结果可复现。风格与 tests/hit-view.mjs、tests/resume-view.mjs 一致。
 *
 * Run: node tests/stats-view.mjs
 */

import { strict as assert } from 'node:assert'
import {
  activeDaysOf,
  buildStats,
  formatCompact,
  formatCost,
  formatDuration,
  sortCategories,
} from '../lib/stats-view.js'

let passed = 0
const failures = []
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok   ${name}`) }
  catch (e) { failures.push({ name, error: e }); console.log(`  FAIL ${name}\n       ${e.message}`) }
}

/** 固定"现在"：2026-11-25 10:00（本地时区）。 */
const NOW = new Date(2026, 10, 25, 10, 0, 0).getTime()
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
/** n 天前的 09:00（本地时区）。 */
const daysAgo = n => new Date(2026, 10, 25 - n, 9, 0, 0).getTime()

/** 一条会话输入的默认形状（接近 Host 侧统计条目的字段）。 */
function sessionOf(patch = {}) {
  return {
    sessionId: 's1',
    title: '会话一',
    topicPath: '插件开发 › 话题地图',
    turnCount: 10,
    tokens: { input: 1000, output: 200, cacheRead: 50, cacheWrite: 10 },
    cost: 0.5,
    durationMs: HOUR,
    lastActivity: daysAgo(3),
    openLaneCount: 1,
    solved: false,
    followUp: false,
    starred: false,
    ...patch,
  }
}

/** 按名字取大类。 */
const categoryOf = (result, name) => result.categories.find(category => category.name === name)
/** 按名字取子类。 */
const subOf = (category, name) => category.subcategories.find(sub => sub.name === name)

console.log('\nstats-view')

// ── 聚合正确性 ──────────────────────────────────────────────────────
test('按 topicPath 聚合：大类 / 子类 / 指标', () => {
  const sessions = [
    sessionOf({ sessionId: 'a', turnCount: 10, lastActivity: daysAgo(3), starred: true }),
    sessionOf({
      sessionId: 'b',
      turnCount: 2,
      tokens: { input: 500, output: 100 },
      cost: 0.25,
      durationMs: 30 * MINUTE,
      lastActivity: daysAgo(1),
      openLaneCount: 2,
      solved: true,
    }),
    sessionOf({
      sessionId: 'c',
      topicPath: '插件开发 › 左栏',
      turnCount: 5,
      tokens: undefined,
      cost: undefined,
      durationMs: undefined,
      lastActivity: daysAgo(5),
      openLaneCount: 0,
    }),
  ]
  const result = buildStats(sessions, { now: NOW })
  assert.deepEqual(result.categories.map(category => category.name), ['插件开发'])
  const category = categoryOf(result, '插件开发')
  assert.deepEqual(category.subcategories.map(sub => sub.name), ['话题地图', '左栏'])

  assert.deepEqual(category.metrics, {
    sessions: 3,
    turns: 17,
    tokens: { input: 1500, output: 300, total: 1800 },
    cost: 0.75,
    durationMs: HOUR + 30 * MINUTE,
    lastActivity: daysAgo(1),
    activeDays: 3,
    openLanes: 3,
    solved: 1,
    unsolved: 2,
    starred: 1,
  })
  assert.equal(category.sessions.length, 3)
  assert.equal(subOf(category, '话题地图').metrics.sessions, 2)
  assert.equal(subOf(category, '话题地图').metrics.turns, 12)
  assert.equal(subOf(category, '左栏').metrics.tokens.total, 0)
  assert.equal(subOf(category, '左栏').metrics.cost, 0)
  assert.equal(subOf(category, '左栏').metrics.durationMs, 0)

  assert.equal(result.totals.sessions, 3)
  assert.equal(result.totals.turns, 17)
  assert.equal(result.totals.tokens.total, 1800)
  assert.equal(result.totals.cost, 0.75)
  assert.equal(result.totals.activeDays, 3)
  assert.equal(result.totals.categories, 1)
  assert.equal(result.totals.uncategorized, 0)
  assert.deepEqual(result.health.emptyCategories, [])
  assert.deepEqual(result.health.staleCategories, [])
})

test('树给结构：顺序与空类都保留', () => {
  const tree = [
    { name: '插件开发', subcategories: [{ name: '话题地图' }, { name: '左栏' }] },
    { name: '测试', subcategories: [{ name: '合并测试' }] },
    { name: '空白', subcategories: [{ name: '空一' }] },
  ]
  const sessions = [
    sessionOf({ sessionId: 'a', topicPath: '插件开发 › 左栏', lastActivity: daysAgo(1) }),
    sessionOf({ sessionId: 'b', topicPath: '插件开发 › 话题地图', lastActivity: daysAgo(2) }),
  ]
  const result = buildStats(sessions, { now: NOW, tree })
  assert.deepEqual(result.categories.map(category => category.name), ['插件开发', '测试', '空白'])
  const plugin = categoryOf(result, '插件开发')
  assert.deepEqual(plugin.subcategories.map(sub => sub.name), ['话题地图', '左栏'])
  assert.equal(categoryOf(result, '测试').metrics.sessions, 0)
  assert.equal(categoryOf(result, '空白').metrics.sessions, 0)
  assert.equal(categoryOf(result, '测试').metrics.lastActivity, null)
  assert.equal(result.totals.categories, 3)
  assert.deepEqual(result.health.emptyCategories, ['测试', '空白'])
  // key 在同一份结果里唯一
  const keys = result.categories.flatMap(category => [category.key, ...category.subcategories.map(sub => sub.key)])
  assert.equal(new Set(keys).size, keys.length)
})

test('树里没有的子类按需补，不丢会话', () => {
  const tree = [{ name: '插件开发', subcategories: [{ name: '话题地图' }] }]
  const sessions = [
    sessionOf({ sessionId: 'known', topicPath: '插件开发 › 话题地图' }),
    sessionOf({ sessionId: 'loose', topicPath: '插件开发 › 新子类' }),
  ]
  const category = categoryOf(buildStats(sessions, { now: NOW, tree }), '插件开发')
  assert.deepEqual(category.subcategories.map(sub => sub.name), ['话题地图', '新子类'])
  assert.deepEqual(subOf(category, '新子类').sessions.map(row => row.sessionId), ['loose'])
  assert.equal(category.metrics.sessions, 2)
})

test('树自带成员关系优先于 topicPath', () => {
  const tree = [
    {
      name: '甲',
      subcategories: [
        { name: '甲一', sessions: ['s-mail', { id: 's-obj' }] },
        { name: '甲二' },
      ],
    },
    { name: '乙', subcategories: [{ name: '乙一' }] },
  ]
  const sessions = [
    sessionOf({ sessionId: 's-mail', topicPath: '乙 › 乙一', lastActivity: daysAgo(3) }),
    sessionOf({ sessionId: 's-path', topicPath: '乙 › 乙一', lastActivity: daysAgo(2) }),
    { id: 's-obj', topicPath: undefined, lastActivity: daysAgo(1) },
  ]
  const result = buildStats(sessions, { now: NOW, tree })
  const first = categoryOf(result, '甲')
  assert.deepEqual(subOf(first, '甲一').sessions.map(row => row.sessionId), ['s-obj', 's-mail'])
  assert.equal(subOf(first, '甲二').metrics.sessions, 0)
  assert.deepEqual(subOf(categoryOf(result, '乙'), '乙一').sessions.map(row => row.sessionId), ['s-path'])
  assert.equal(result.health.uncategorized, 0)
})

test('同一批会话：tree 顺序覆盖自动聚合顺序', () => {
  const sessions = [
    sessionOf({ sessionId: 'b', topicPath: '乙 › 二' }),
    sessionOf({ sessionId: 'a', topicPath: '甲 › 一' }),
  ]
  const auto = buildStats(sessions, { now: NOW })
  assert.deepEqual(auto.categories.map(category => category.name), ['乙', '甲'])
  assert.deepEqual(auto.categories[1].subcategories.map(sub => sub.name), ['一'])
  const tree = [
    { name: '甲', subcategories: [{ name: '一' }] },
    { name: '乙', subcategories: [{ name: '二' }] },
  ]
  const structured = buildStats(sessions, { now: NOW, tree })
  assert.deepEqual(structured.categories.map(category => category.name), ['甲', '乙'])
})

test('树不可用（空 / 全是非法项）退回自动聚合', () => {
  for (const tree of [[], [null, 'x', { name: '  ' }]]) {
    const result = buildStats([sessionOf({ sessionId: 'a' })], { now: NOW, tree })
    assert.deepEqual(result.categories.map(category => category.name), ['插件开发'])
    assert.equal(result.categories[0].metrics.sessions, 1)
    assert.equal(result.health.uncategorized, 0)
  }
})

test('未归类：空 / 缺 / 「未归类」/ 非对象条目都安全', () => {
  const sessions = [
    { sessionId: 'u1' },
    { sessionId: 'u2', topicPath: '', cost: null, tokens: null },
    { sessionId: 'u3', topicPath: '未归类' },
    { sessionId: 'u4', topicPath: ['', '  '] },
    null,
    'x',
    3,
  ]
  const result = buildStats(sessions, { now: NOW })
  assert.equal(result.categories.length, 1)
  const fallback = result.categories[0]
  assert.equal(fallback.name, '未归类')
  assert.deepEqual(fallback.subcategories, [])
  assert.deepEqual(fallback.sessions.map(row => row.sessionId), ['u1', 'u2', 'u3', 'u4'])
  assert.deepEqual(fallback.metrics, {
    sessions: 4,
    turns: 0,
    tokens: { input: 0, output: 0, total: 0 },
    cost: 0,
    durationMs: 0,
    lastActivity: null,
    activeDays: 0,
    openLanes: 0,
    solved: 0,
    unsolved: 4,
    starred: 0,
  })
  assert.equal(result.totals.sessions, 4)
  assert.equal(result.totals.categories, 0)
  assert.equal(result.totals.uncategorized, 4)
  assert.equal(result.health.uncategorized, 4)
  assert.equal(result.health.unsolved, 4)
})

test('单段 topicPath：算归类，子类名为空', () => {
  const result = buildStats([sessionOf({ sessionId: 'only', topicPath: '插件开发' })], { now: NOW })
  const category = result.categories[0]
  assert.equal(category.name, '插件开发')
  assert.deepEqual(category.subcategories.map(sub => sub.name), [''])
  assert.equal(category.metrics.sessions, 1)
  assert.equal(category.sessions[0].subcategory, '')
  assert.equal(result.health.uncategorized, 0)
  assert.equal(result.totals.categories, 1)
})

test('topicPath 字符串 / 数组 / 多余层级同口径', () => {
  const result = buildStats([
    sessionOf({ sessionId: 's1', topicPath: '插件开发 › 话题地图' }),
    sessionOf({ sessionId: 's2', topicPath: ['插件开发', '话题地图', '三级'] }),
    sessionOf({ sessionId: 's3', topicPath: '甲>乙' }),
  ], { now: NOW })
  assert.deepEqual(result.categories.map(category => category.name), ['插件开发', '甲'])
  assert.deepEqual(categoryOf(result, '插件开发').subcategories.map(sub => sub.name), ['话题地图'])
  assert.deepEqual(categoryOf(result, '甲').subcategories.map(sub => sub.name), ['乙'])
  assert.equal(categoryOf(result, '插件开发').metrics.sessions, 2)
})

test('tokens：input/output 优先，缓存不重复计数；只有 total 时兜底', () => {
  const result = buildStats([
    sessionOf({
      sessionId: 'a',
      tokens: { input: 100, output: 50, cacheRead: 900, cacheWrite: 100, total: 999 },
    }),
    sessionOf({ sessionId: 'b', tokens: { total: 40 } }),
  ], { now: NOW })
  const metrics = categoryOf(result, '插件开发').metrics
  assert.deepEqual(metrics.tokens, { input: 100, output: 50, total: 190 })
  assert.equal(result.totals.tokens.total, 190)
})

test('会话行：字段齐全、按活动倒序、无时间排最后', () => {
  const result = buildStats([
    sessionOf({ sessionId: 'old', title: '旧的', lastActivity: daysAgo(2) }),
    sessionOf({ sessionId: 'none', title: '没时间', lastActivity: 'not-a-time' }),
    sessionOf({ sessionId: 'new', title: '新的', lastActivity: daysAgo(1), solved: true, starred: true }),
  ], { now: NOW })
  const rows = categoryOf(result, '插件开发').sessions
  assert.deepEqual(rows.map(row => row.sessionId), ['new', 'old', 'none'])
  assert.deepEqual(rows[0], {
    sessionId: 'new',
    title: '新的',
    turnCount: 10,
    tokens: { input: 1000, output: 200, total: 1200 },
    cost: 0.5,
    durationMs: HOUR,
    lastActivity: daysAgo(1),
    openLaneCount: 1,
    solved: true,
    followUp: false,
    starred: true,
    subcategory: '话题地图',
  })
  assert.equal(rows[2].lastActivity, null)
})

test('spec 约定：category / metrics / totals / health 的键集合', () => {
  const result = buildStats([sessionOf()], { now: NOW })
  const keys = value => Object.keys(value).sort()
  assert.deepEqual(keys(result.categories[0]), ['key', 'metrics', 'name', 'sessions', 'subcategories'])
  assert.deepEqual(keys(result.categories[0].metrics), [
    'activeDays', 'cost', 'durationMs', 'lastActivity', 'openLanes',
    'sessions', 'solved', 'starred', 'tokens', 'turns', 'unsolved',
  ])
  assert.deepEqual(keys(result.categories[0].metrics.tokens), ['input', 'output', 'total'])
  assert.deepEqual(keys(result.totals), [
    'activeDays', 'categories', 'cost', 'durationMs', 'lastActivity', 'openLanes',
    'sessions', 'solved', 'starred', 'tokens', 'turns', 'uncategorized', 'unsolved',
  ])
  assert.deepEqual(keys(result.health), ['emptyCategories', 'staleCategories', 'uncategorized', 'unsolved'])
})

test('空输入 / 缺 options 不崩', () => {
  for (const input of [null, undefined, [], 'x', 3]) {
    const result = buildStats(input)
    assert.deepEqual(result.categories, [])
    assert.equal(result.totals.sessions, 0)
    assert.equal(result.totals.categories, 0)
    assert.equal(result.health.uncategorized, 0)
    assert.deepEqual(result.health.staleCategories, [])
  }
  assert.equal(buildStats(null, null).totals.sessions, 0)
})

test('不修改输入（冻结后仍可聚合与排序）', () => {
  const sessions = Object.freeze([
    Object.freeze({
      sessionId: 'a',
      topicPath: '甲 › 一',
      tokens: Object.freeze({ input: 1 }),
      lastActivity: daysAgo(1),
    }),
  ])
  const tree = Object.freeze([
    Object.freeze({
      name: '甲',
      subcategories: Object.freeze([Object.freeze({ name: '一' })]),
    }),
  ])
  const result = buildStats(sessions, { now: NOW, tree })
  assert.equal(result.totals.sessions, 1)
  const categories = Object.freeze([
    Object.freeze({ key: 'a', name: '甲', metrics: Object.freeze({ sessions: 1, lastActivity: daysAgo(1) }) }),
    Object.freeze({ key: 'b', name: '乙', metrics: Object.freeze({ sessions: 2, lastActivity: daysAgo(2) }) }),
  ])
  const sorted = sortCategories(categories)
  assert.deepEqual(sorted.map(category => category.name), ['甲', '乙'])
  assert.deepEqual(categories.map(category => category.name), ['甲', '乙'])
})

// ── 活跃天数 ────────────────────────────────────────────────────────
test('activeDaysOf：同一天多次活动只算一天', () => {
  const sessions = [
    { lastActivity: daysAgo(0) },
    { lastActivity: new Date(2026, 10, 25, 8, 0, 0).getTime() },
    { lastActivity: new Date(2026, 10, 25, 23, 59, 0).getTime() },
    { lastActivity: 'not-a-time' },
    { lastActivity: undefined },
  ]
  assert.equal(activeDaysOf(sessions, { now: NOW }), 1)
})

test('activeDaysOf：30 天窗口边界（含今天、含第 29 天前，不含第 30 天前）', () => {
  const sessions = [
    { lastActivity: daysAgo(0) },
    { lastActivity: daysAgo(1) },
    { lastActivity: daysAgo(29) },
    { lastActivity: daysAgo(30) },
    { lastActivity: daysAgo(31) },
  ]
  assert.equal(activeDaysOf(sessions, { now: NOW }), 3)
  assert.equal(activeDaysOf(sessions, { now: NOW, windowDays: 30 }), 3)
  assert.equal(activeDaysOf(sessions, { now: NOW, windowDays: 7 }), 2)
  assert.equal(activeDaysOf(sessions, { now: NOW, windowDays: 1 }), 1)
  assert.equal(activeDaysOf(sessions, { now: NOW, windowDays: 0 }), 0)
})

test('activeDaysOf：无 now 返回 0，不读系统时钟', () => {
  const sessions = [{ lastActivity: daysAgo(0) }]
  assert.equal(activeDaysOf(sessions), 0)
  assert.equal(activeDaysOf(sessions, { now: null }), 0)
  assert.equal(activeDaysOf(sessions, { now: 'bad' }), 0)
  const result = buildStats(sessions)
  assert.equal(result.totals.activeDays, 0)
  assert.equal(result.categories[0].metrics.activeDays, 0)
  assert.deepEqual(result.health.staleCategories, [])
})

test('activeDaysOf：未来时间戳与非法窗口不计入', () => {
  assert.equal(activeDaysOf([
    { lastActivity: NOW + DAY },
    { lastActivity: daysAgo(1) },
  ], { now: NOW }), 1)
  assert.equal(activeDaysOf([{ lastActivity: daysAgo(1) }], { now: NOW, windowDays: 'x' }), 1)
})

// ── 排序 ────────────────────────────────────────────────────────────
test('sortCategories：默认按活跃度，四种口径各自生效', () => {
  const categories = [
    { key: 'a', name: '甲', metrics: { sessions: 10, turns: 100, cost: 5, lastActivity: daysAgo(5) } },
    { key: 'b', name: '乙', metrics: { sessions: 2, turns: 20, cost: 3, lastActivity: daysAgo(1) } },
    { key: 'c', name: '丙', metrics: { sessions: 5, turns: 50, cost: 2, lastActivity: daysAgo(3) } },
    { key: 'd', name: '无名', metrics: { sessions: 1, turns: 1, cost: 0, lastActivity: null } },
  ]
  const names = list => list.map(category => category.name)
  assert.deepEqual(names(sortCategories(categories)), ['乙', '丙', '甲', '无名'])
  assert.deepEqual(names(sortCategories(categories, 'activity')), ['乙', '丙', '甲', '无名'])
  assert.deepEqual(names(sortCategories(categories, 'turns')), ['甲', '丙', '乙', '无名'])
  assert.deepEqual(names(sortCategories(categories, 'cost')), ['甲', '乙', '丙', '无名'])
  assert.deepEqual(names(sortCategories(categories, 'sessions')), ['甲', '丙', '乙', '无名'])
  assert.deepEqual(names(sortCategories(categories, 'unknown')), ['乙', '丙', '甲', '无名'])
  // 入参顺序不变
  assert.deepEqual(names(categories), ['甲', '乙', '丙', '无名'])
})

test('sortCategories：同分用会话数 / 时间兜底，无时间排最后', () => {
  const categories = [
    { key: 'small', name: '小', metrics: { sessions: 1, turns: 50, cost: 1, lastActivity: daysAgo(1) } },
    { key: 'big', name: '大', metrics: { sessions: 99, turns: 10, cost: 1, lastActivity: daysAgo(1) } },
    { key: 'none', name: '空', metrics: { sessions: 500, turns: 50, cost: 1, lastActivity: null } },
  ]
  const names = list => list.map(category => category.name)
  // 活跃度同分（都是 1 天前）时，会话数大的在前；无时间的永远最后
  assert.deepEqual(names(sortCategories(categories)), ['大', '小', '空'])
  // 用量同分（都是 50 轮）时，有时间的在前
  assert.deepEqual(names(sortCategories(categories, 'turns')), ['小', '空', '大'])
  // 按会话数排序时，时间只在同分时兜底
  assert.deepEqual(names(sortCategories(categories, 'sessions')), ['空', '大', '小'])
})

test('sortCategories：非数组 / 缺 metrics 安全降级', () => {
  assert.deepEqual(sortCategories(null), [])
  assert.deepEqual(sortCategories(undefined, 'cost'), [])
  const sorted = sortCategories([{ name: 'zeta' }, { name: 'alpha' }])
  assert.deepEqual(sorted.map(category => category.name), ['alpha', 'zeta'])
})

// ── 结构健康 ────────────────────────────────────────────────────────
test('health：未归类 / 未收尾 / 空类 / 停滞类四项', () => {
  const tree = [
    { name: '新类', subcategories: [{ name: '一' }] },
    { name: '临界', subcategories: [{ name: '一' }] },
    { name: '旧类', subcategories: [{ name: '一' }] },
    { name: '空类', subcategories: [{ name: '一' }] },
  ]
  const sessions = [
    sessionOf({ sessionId: 'new', topicPath: '新类 › 一', lastActivity: daysAgo(29) }),
    sessionOf({ sessionId: 'edge', topicPath: '临界 › 一', lastActivity: NOW - 30 * DAY }),
    sessionOf({ sessionId: 'old', topicPath: '旧类 › 一', lastActivity: NOW - 31 * DAY, solved: true }),
    { sessionId: 'un', lastActivity: daysAgo(1) },
  ]
  const result = buildStats(sessions, { now: NOW, tree })
  assert.equal(result.health.uncategorized, 1)
  assert.equal(result.health.unsolved, 3)
  assert.deepEqual(result.health.emptyCategories, ['空类'])
  assert.deepEqual(result.health.staleCategories, ['旧类'])
  assert.equal(result.totals.categories, 4)
  assert.equal(result.totals.uncategorized, 1)
  // 30 天整不算停滞，31 天才算
  assert.equal(result.categories.some(category => category.name === '临界' && category.metrics.lastActivity === NOW - 30 * DAY), true)
  // 未给 now：停滞判定整项跳过
  assert.deepEqual(buildStats(sessions, { tree }).health.staleCategories, [])
})

test('totals 与 categories 口径一致', () => {
  const sessions = [
    sessionOf({ sessionId: 'a', topicPath: '甲 › 一', turnCount: 3, cost: 0.1, durationMs: 1000, openLaneCount: 1 }),
    sessionOf({ sessionId: 'b', topicPath: '甲 › 二', turnCount: 4, cost: 0.2, durationMs: 2000, openLaneCount: 2 }),
    sessionOf({ sessionId: 'c', topicPath: '乙 › 一', turnCount: 5, cost: 0.3, durationMs: 3000, openLaneCount: 3 }),
    { sessionId: 'd', turnCount: 1, cost: 0.4, durationMs: 4000, openLaneCount: 4 },
  ]
  const result = buildStats(sessions, { now: NOW })
  const live = result.categories.filter(category => category.name !== '未归类')
  assert.equal(result.totals.sessions, 4)
  assert.equal(result.totals.turns, 13)
  assert.equal(result.totals.openLanes, 10)
  assert.equal(result.totals.durationMs, 10000)
  assert.equal(result.totals.cost, 1)
  assert.equal(result.totals.categories, 2)
  assert.equal(result.totals.uncategorized, 1)
  assert.equal(result.categories.reduce((sum, category) => sum + category.metrics.sessions, 0), 4)
  assert.equal(live.length, 2)
  // 活跃天数取并集，不是各类相加
  assert.equal(result.totals.activeDays, activeDaysOf(sessions, { now: NOW }))
})

// ── 格式化 ──────────────────────────────────────────────────────────
test('formatCompact：0 / 999 / 999.95 / 万 / 百万', () => {
  assert.equal(formatCompact(0), '0')
  assert.equal(formatCompact(999), '999')
  assert.equal(formatCompact(999.4), '999')
  assert.equal(formatCompact(999.95), '1k')
  assert.equal(formatCompact(1000), '1k')
  assert.equal(formatCompact(1200), '1.2k')
  assert.equal(formatCompact(12300), '12.3k')
  assert.equal(formatCompact(999500), '999.5k')
  assert.equal(formatCompact(999950), '1M')
  assert.equal(formatCompact(999999), '1M')
  assert.equal(formatCompact(1000000), '1M')
  assert.equal(formatCompact(1200000), '1.2M')
  assert.equal(formatCompact(-1234), '-1.2k')
  assert.equal(formatCompact('bad'), '0')
})

test('formatDuration：秒 / 分 / 小时 / 天与进位边界', () => {
  assert.equal(formatDuration(0), '0 秒')
  assert.equal(formatDuration(-5), '0 秒')
  assert.equal(formatDuration(45000), '45 秒')
  assert.equal(formatDuration(59600), '1 分')
  assert.equal(formatDuration(720000), '12 分')
  assert.equal(formatDuration(12600000), '3.5 小时')
  assert.equal(formatDuration(3 * HOUR), '3 小时')
  assert.equal(formatDuration(181440000), '2.1 天')
  assert.equal(formatDuration(4 * DAY), '4 天')
  assert.equal(formatDuration('bad'), '0 秒')
})

test('formatCost：0 / 0.004 / 0.01 / 个位 / 十位', () => {
  assert.equal(formatCost(0), '$0.00')
  assert.equal(formatCost(0.004), '<$0.01')
  assert.equal(formatCost(0.01), '$0.01')
  assert.equal(formatCost(0.1), '$0.10')
  assert.equal(formatCost(1.23), '$1.23')
  assert.equal(formatCost(9.999), '$10.0')
  assert.equal(formatCost(12), '$12.0')
  assert.equal(formatCost(12.34), '$12.3')
  assert.equal(formatCost(100), '$100.0')
  assert.equal(formatCost('bad'), '$0.00')
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const f of failures) console.error(`\n${f.name}\n${f.error.stack}`)
  process.exit(1)
}
