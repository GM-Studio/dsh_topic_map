/**
 * 统计展示格式化测试。
 *
 * 纯函数：`now` 一律由参数传入，不读系统时钟、不碰 DOM。
 * 固定时间戳与本地构造的日期，结果可复现；风格与 tests/stats-view.mjs 一致。
 *
 * Run: node tests/stats-format.mjs
 */

import { strict as assert } from 'node:assert'
import {
  formatRelative,
  statsHeadline,
  statsRows,
  usageSplit,
} from '../lib/stats-format.js'

let passed = 0
const failures = []
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok   ${name}`) }
  catch (e) { failures.push({ name, error: e }); console.log(`  FAIL ${name}\n       ${e.message}`) }
}

/** 固定"现在"：2026-11-25 14:30（本地时区）。 */
const NOW = new Date(2026, 10, 25, 14, 30, 0).getTime()
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

console.log('\nstats-format')

// ── statsHeadline ───────────────────────────────────────────────────
test('statsHeadline：四项、标签顺序与千分位', () => {
  const rows = statsHeadline({
    sessions: 38,
    turns: 1234,
    activeDays: 5,
    tokens: { input: 1200, output: 300 },
    cost: 0.75,
  })
  assert.deepEqual(rows.map(row => row.label), ['会话数', '轮次数', '活跃天数', '总用量'])
  assert.equal(rows[0].value, '38')
  assert.equal(rows[1].value, '1,234')
  assert.equal(rows[2].value, '5 天')
  assert.equal(rows[3].value, '1.5k tokens')
  assert.ok(rows[3].hint.includes('输入 1.2k'))
  assert.ok(rows[3].hint.includes('输出 300'))
  assert.ok(rows[3].hint.includes('$0.75'))
})

test('statsHeadline：兼容 { totals } 形状', () => {
  const direct = statsHeadline({ sessions: 7, turns: 12, activeDays: 2 })
  const wrapped = statsHeadline({ totals: { sessions: 7, turns: 12, activeDays: 2 }, categories: [] })
  assert.deepEqual(direct, wrapped)
  assert.equal(direct[0].value, '7')
  assert.equal(direct[1].value, '12')
})

test('statsHeadline：0 值全部安全显示', () => {
  const rows = statsHeadline({
    sessions: 0,
    turns: 0,
    activeDays: 0,
    tokens: { input: 0, output: 0, total: 0 },
    cost: 0,
  })
  assert.deepEqual(rows.map(row => row.value), ['0', '0', '0 天', '0 tokens'])
  assert.ok(rows[3].hint.includes('输入 0'))
  assert.ok(rows[3].hint.includes('输出 0'))
  assert.ok(!rows[3].hint.includes('$'))
})

test('statsHeadline：空 / 非法输入不抛错', () => {
  for (const input of [null, undefined, 'bad', []]) {
    const rows = statsHeadline(input)
    assert.equal(rows.length, 4)
    assert.deepEqual(rows.map(row => row.value), ['0', '0', '0 天', '0 tokens'])
  }
  const declared = statsHeadline({ tokens: { total: 5000 } })
  assert.equal(declared[3].value, '5k tokens')
  assert.ok(declared[3].hint.includes('输入 0 · 输出 0'))
})

test('statsHeadline：大数用千分位，小数不缺项', () => {
  const rows = statsHeadline({ sessions: 123456, turns: 999, activeDays: 0 })
  assert.equal(rows[0].value, '123,456')
  assert.equal(rows[1].value, '999')
  assert.equal(rows[2].value, '0 天')
})

test('statsHeadline：费用按 formatCost 口径进提示', () => {
  const cheap = statsHeadline({ tokens: { input: 10, output: 0 }, cost: 0.001 })
  assert.ok(cheap[3].hint.includes('<$0.01'))
  const costly = statsHeadline({ tokens: { input: 10, output: 0 }, cost: 12.3 })
  assert.ok(costly[3].hint.includes('$12.3'))
})

// ── statsRows ───────────────────────────────────────────────────────
test('statsRows：截断、相对时间与相对最大值 bar', () => {
  const rows = statsRows([
    { title: '甲', turnCount: 100, lastActivity: NOW - 30_000 },
    { title: '乙', turnCount: 50, lastActivity: NOW - 5 * MINUTE },
    { title: '丙', turnCount: 0, lastActivity: NOW - 3 * HOUR },
  ], { now: NOW, limit: 2 })
  assert.deepEqual(rows, [
    { title: '甲', turns: '100', lastActiveText: '刚刚', barPercent: 100 },
    { title: '乙', turns: '50', lastActiveText: '5 分钟前', barPercent: 50 },
  ])
})

test('statsRows：limit 默认 10，0 返回空数组', () => {
  const many = Array.from({ length: 15 }, (_, index) => ({
    title: `会话${index}`,
    turnCount: index + 1,
    lastActivity: NOW - index * MINUTE,
  }))
  assert.equal(statsRows(many, { now: NOW }).length, 10)
  assert.equal(statsRows(many, { now: NOW, limit: 3 }).length, 3)
  assert.deepEqual(statsRows(many, { now: NOW, limit: 0 }), [])
  assert.deepEqual(statsRows([], { now: NOW, limit: 10 }), [])
  assert.deepEqual(statsRows(null, { now: NOW }), [])
})

test('statsRows：bar 相对完整列表的最大值，而不是截断后的最大值', () => {
  const rows = statsRows([
    { title: '小的', turnCount: 25, lastActivity: NOW },
    { title: '大的', turnCount: 100, lastActivity: NOW },
  ], { now: NOW, limit: 1 })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].barPercent, 25)
})

test('statsRows：标题兜底、空白压缩与非法轮次', () => {
  const rows = statsRows([
    { title: '  多  空白  ', turnCount: '7', lastActivity: NOW - 2 * DAY },
    { title: '', turnCount: -5, lastActivity: undefined },
    { title: '大数', turnCount: 1234, lastActivity: NOW },
  ], { now: NOW, limit: 10 })
  assert.equal(rows[0].title, '多 空白')
  assert.equal(rows[0].turns, '7')
  assert.equal(rows[0].lastActiveText, '2 天前')
  assert.equal(rows[1].title, '未命名会话')
  assert.equal(rows[1].turns, '0')
  assert.equal(rows[1].barPercent, 0)
  assert.equal(rows[1].lastActiveText, '未知')
  assert.equal(rows[2].turns, '1,234')
  assert.equal(rows[2].barPercent, 100)
})

test('statsRows：now 非法时相对时间统一为未知', () => {
  const rows = statsRows([{ title: '甲', turnCount: 1, lastActivity: NOW }], { now: undefined })
  assert.equal(rows[0].lastActiveText, '未知')
})

// ── usageSplit ──────────────────────────────────────────────────────
test('usageSplit：拆分文本、总量与输出占比', () => {
  const split = usageSplit({ input: 1200, output: 300 })
  assert.deepEqual(split, {
    inputText: '1.2k',
    outputText: '300',
    totalText: '1.5k',
    ratio: 0.2,
  })
  const third = usageSplit({ input: 1000, output: 2000 })
  assert.equal(third.totalText, '3k')
  assert.equal(third.ratio, 0.67)
})

test('usageSplit：只有 total 也能显示，0 / 负数安全', () => {
  assert.deepEqual(usageSplit({ total: 5000 }), {
    inputText: '0',
    outputText: '0',
    totalText: '5k',
    ratio: 0,
  })
  assert.deepEqual(usageSplit({ input: 0, output: 0 }), {
    inputText: '0',
    outputText: '0',
    totalText: '0',
    ratio: 0,
  })
  assert.deepEqual(usageSplit({ input: -10, output: -20, total: 100 }), {
    inputText: '0',
    outputText: '0',
    totalText: '100',
    ratio: 0,
  })
  assert.deepEqual(usageSplit(null), {
    inputText: '0',
    outputText: '0',
    totalText: '0',
    ratio: 0,
  })
})

test('usageSplit：input/output 都在时不信声明 total', () => {
  const split = usageSplit({ input: 100, output: 50, total: 9999 })
  assert.equal(split.totalText, '150')
  assert.equal(split.ratio, 0.33)
})

// ── formatRelative ──────────────────────────────────────────────────
test('formatRelative：分档边界', () => {
  assert.equal(formatRelative(NOW - 30_000, NOW), '刚刚')
  assert.equal(formatRelative(NOW - MINUTE, NOW), '1 分钟前')
  assert.equal(formatRelative(NOW - 59 * MINUTE, NOW), '59 分钟前')
  assert.equal(formatRelative(NOW - HOUR, NOW), '1 小时前')
  assert.equal(formatRelative(NOW - 23 * HOUR - 59 * MINUTE, NOW), '23 小时前')
  assert.equal(formatRelative(NOW - DAY, NOW), '1 天前')
  assert.equal(formatRelative(NOW - 5 * DAY, NOW), '5 天前')
  assert.equal(formatRelative(NOW - 30 * DAY, NOW), '30 天前')
  assert.equal(formatRelative(NOW - 31 * DAY, NOW), '更早')
})

test('formatRelative：未来 / 非法时间 / Date 入参', () => {
  assert.equal(formatRelative(NOW + MINUTE, NOW), '刚刚')
  assert.equal(formatRelative(undefined, NOW), '未知')
  assert.equal(formatRelative(NOW, undefined), '未知')
  assert.equal(formatRelative(new Date(NOW - DAY), new Date(NOW)), '1 天前')
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const failure of failures) console.log(`\n${failure.name}\n${failure.error.stack}`)
  process.exit(1)
}
