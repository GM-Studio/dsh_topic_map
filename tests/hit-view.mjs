/**
 * 列表视图模型测试（V-1 / A-2 / A-14）。
 *
 * 固定 now、固定时间戳：纯函数、不碰 DOM、不读系统时钟，结果可复现。
 *
 * Run: node tests/hit-view.mjs
 */

import { strict as assert } from 'node:assert'
import {
  copySummary,
  formatRelativeTime,
  groupHeader,
  scoreParts,
  toRow,
  toThreeLine,
  toTwoLine,
} from '../lib/hit-view.js'

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
/** n 毫秒前。 */
const ago = ms => NOW - ms

/** 一条接近 searchTurns 输出的命中。 */
function hitOf(patch = {}) {
  return {
    sessionId: 'session-abcdef123456',
    turn: 7,
    seq: 812,
    time: NOW - 2 * HOUR,
    snippet: '把跳转做到准确',
    matchedIn: 'prompt',
    matchCount: 2,
    endReason: 'completed',
    interrupted: false,
    ...patch,
  }
}

console.log('\nhit-view')

// ── 相对时间 ────────────────────────────────────────────────────────
test('刚刚 / 分钟 / 小时的边界', () => {
  assert.equal(formatRelativeTime(ago(0), NOW), '刚刚')
  assert.equal(formatRelativeTime(ago(59_999), NOW), '刚刚')
  assert.equal(formatRelativeTime(ago(60_000), NOW), '1 分钟前')
  assert.equal(formatRelativeTime(ago(59 * MINUTE), NOW), '59 分钟前')
  assert.equal(formatRelativeTime(ago(60 * MINUTE), NOW), '1 小时前')
  assert.equal(formatRelativeTime(ago(23 * HOUR), NOW), '23 小时前')
})

test('24 小时边界：满一天改说昨天 / N 天前', () => {
  assert.equal(formatRelativeTime(ago(24 * HOUR), NOW), '昨天')
  assert.equal(formatRelativeTime(ago(25 * HOUR), NOW), '昨天')
  assert.equal(formatRelativeTime(ago(47 * HOUR), NOW), '2 天前')
})

test('6 天 / 7 天边界：满 7 天改绝对日期', () => {
  assert.equal(formatRelativeTime(ago(6 * DAY), NOW), '6 天前')
  assert.equal(formatRelativeTime(ago(7 * DAY), NOW), '2026-11-18')
  assert.equal(formatRelativeTime(ago(40 * DAY), NOW), '2026-10-16')
})

test('跨年用绝对日期（即使不满 7 天）', () => {
  const jan2 = new Date(2027, 0, 2, 10, 0, 0).getTime()
  assert.equal(formatRelativeTime(new Date(2026, 11, 30, 10, 0, 0).getTime(), jan2), '2026-12-30')
  // 恰好 24h、日期差 1 天，但跨年 —— 仍用绝对日期
  const jan1 = new Date(2027, 0, 1, 10, 0, 0).getTime()
  assert.equal(formatRelativeTime(new Date(2026, 11, 31, 10, 0, 0).getTime(), jan1), '2026-12-31')
})

test('未来时间（时钟偏差）同日显示今天', () => {
  assert.equal(formatRelativeTime(NOW + 30 * MINUTE, NOW), '今天')
  assert.equal(formatRelativeTime(NOW + 2 * DAY, NOW), '2026-11-27')
})

test('时间缺失或非法返回空串，不读系统时钟', () => {
  assert.equal(formatRelativeTime(undefined, NOW), '')
  assert.equal(formatRelativeTime('x', NOW), '')
  assert.equal(formatRelativeTime(NOW, undefined), '')
  assert.equal(formatRelativeTime(new Date(ago(24 * HOUR)), NOW), '昨天') // 认 Date
})

// ── 行模型 ──────────────────────────────────────────────────────────
test('toRow：基本字段', () => {
  const row = toRow(hitOf({ title: '话题地图' }), { now: NOW })
  assert.equal(row.turnLabel, '第 7 轮')
  assert.equal(row.title, '话题地图')
  assert.equal(row.timeLabel, '2 小时前')
  assert.equal(row.snippet, '把跳转做到准确')
  assert.equal(row.matchLabel, '提问命中')
  assert.deepEqual(row.badges, [])
  assert.equal(row.highlight, null)
  assert.equal(row.laneLabel, '')
  assert.equal(row.statusLabel, '')
  // 行模型保留身份字段，供点击定位复用
  assert.equal(row.sessionId, 'session-abcdef123456')
  assert.equal(row.turn, 7)
  assert.equal(row.seq, 812)
})

test('toRow：空标题回退会话短 id', () => {
  assert.equal(toRow(hitOf(), { now: NOW }).title, 'abcdef12')
  assert.equal(toRow(hitOf({ title: '   ' }), { now: NOW }).title, 'abcdef12')
  assert.equal(toRow(hitOf({ title: undefined, sessionId: undefined }), { now: NOW }).title, '未命名会话')
})

test('toRow：命中侧文案', () => {
  assert.equal(toRow(hitOf({ matchedIn: 'response' }), { now: NOW }).matchLabel, '回答命中')
  assert.equal(toRow(hitOf({ matchedIn: undefined }), { now: NOW }).matchLabel, '')
})

test('toRow：高亮只给位置，不拼 HTML', () => {
  assert.deepEqual(
    toRow(hitOf({ snippet: '把跳转做到准确' }), { now: NOW, keywords: '跳转' }).highlight,
    { start: 1, len: 2 },
  )
  assert.deepEqual(
    toRow(hitOf({ snippet: 'API Key 配置' }), { now: NOW, keywords: 'key' }).highlight,
    { start: 4, len: 3 },
  )
  // 多个关键词取片段里最早出现的那个
  assert.deepEqual(
    toRow(hitOf({ snippet: '定位与跳转' }), { now: NOW, keywords: ['跳转', '定位'] }).highlight,
    { start: 0, len: 2 },
  )
  assert.equal(toRow(hitOf({ snippet: '没有命中' }), { now: NOW, keywords: '跳转' }).highlight, null)
  // 片段是纯文本：不做转义、不生成 HTML
  const raw = '<img onerror=x>'
  assert.equal(toRow(hitOf({ snippet: raw }), { now: NOW }).snippet, raw)
})

test('toRow：命中自带的 highlight 透传（拷贝）', () => {
  const given = { start: 5, len: 1 }
  const row = toRow(hitOf({ highlight: given }), { now: NOW })
  assert.deepEqual(row.highlight, given)
  assert.notEqual(row.highlight, given)
})

test('toRow：失败 / 中断徽标', () => {
  assert.deepEqual(toRow(hitOf({ endReason: 'error' }), { now: NOW }).badges, ['失败'])
  assert.deepEqual(toRow(hitOf({ endReason: 'max-tokens' }), { now: NOW }).badges, ['失败'])
  assert.deepEqual(toRow(hitOf({ endReason: 'interrupted' }), { now: NOW }).badges, ['中断'])
  assert.deepEqual(toRow(hitOf({ endReason: 'aborted' }), { now: NOW }).badges, ['中断'])
  assert.deepEqual(toRow(hitOf({ interrupted: true }), { now: NOW }).badges, ['中断'])
})

test('toRow：有变更徽标', () => {
  assert.deepEqual(
    toRow(hitOf({ changes: { files: [{ path: 'lib/client.js' }], lost: false } }), { now: NOW }).badges,
    ['有变更'],
  )
  assert.deepEqual(toRow(hitOf({ changes: { files: [], lost: true } }), { now: NOW }).badges, ['有变更'])
  assert.deepEqual(toRow(hitOf({ changes: { files: [], lost: false } }), { now: NOW }).badges, [])
  assert.deepEqual(toRow(hitOf({ changes: [] }), { now: NOW }).badges, [])
})

test('toRow：已标记与状态文案（对象 / Map / 函数 / 数组标签）', () => {
  assert.deepEqual(toRow(hitOf({ label: { starred: true } }), { now: NOW }).badges, ['已标记'])
  assert.equal(
    toRow(hitOf({ label: { starred: true, followUp: true } }), { now: NOW }).statusLabel,
    '重要 · 待跟进',
  )
  const map = new Map([['s1#3', { solved: true }]])
  const row = toRow(hitOf({ sessionId: 's1', turn: 3 }), { now: NOW, labels: map })
  assert.deepEqual(row.badges, ['已标记'])
  assert.equal(row.statusLabel, '已解决')
  assert.equal(
    toRow(hitOf(), { now: NOW, labels: () => ({ followUp: true }) }).statusLabel,
    '待跟进',
  )
  assert.equal(toRow(hitOf({ label: ['solved'] }), { now: NOW }).statusLabel, '已解决')
})

test('toRow：四类徽标按固定顺序组合', () => {
  const row = toRow(hitOf({
    endReason: 'error',
    interrupted: true,
    changes: { files: [{ path: 'a' }], lost: false },
    label: { solved: true },
  }), { now: NOW })
  assert.deepEqual(row.badges, ['失败', '中断', '有变更', '已标记'])
})

test('toRow：话题段名，缺失时用 laneId 兜底', () => {
  assert.equal(toRow(hitOf({ laneTitle: '对话跳转修复' }), { now: NOW }).laneLabel, '对话跳转修复')
  assert.equal(toRow(hitOf({ laneId: 'L3' }), { now: NOW }).laneLabel, 'L3')
  assert.equal(toRow(hitOf({ lane: { title: '面板空白' } }), { now: NOW }).laneLabel, '面板空白')
})

test('toRow：缺失轮次 / 时间时不编造', () => {
  const row = toRow(hitOf({ turn: null, time: null }), { now: NOW })
  assert.equal(row.turnLabel, '')
  assert.equal(row.turn, null)
  assert.equal(row.timeLabel, '')
  assert.equal(row.time, null)
  // 没传 now 就不显示时间，不回退系统时钟
  assert.equal(toRow(hitOf({ time: NOW - HOUR })).timeLabel, '')
})

test('toRow 不修改入参', () => {
  const hit = hitOf({ title: '话题地图' })
  toRow(hit, { now: NOW })
  assert.equal(hit.turnLabel, undefined)
  assert.equal(hit.title, '话题地图')
})

// ── 两行 / 三行切片 ─────────────────────────────────────────────────
test('两行 / 三行切片', () => {
  const row = toRow(hitOf({
    title: '话题地图',
    laneTitle: '对话跳转修复',
    label: { starred: true },
  }), { now: NOW })
  assert.deepEqual(toTwoLine(row), ['话题地图 · 第 7 轮 · 2 小时前', '把跳转做到准确'])
  assert.deepEqual(toThreeLine(row), ['话题地图 · 第 7 轮 · 2 小时前', '把跳转做到准确', '对话跳转修复 · 重要'])
  // 缺一项时不留多余分隔符
  assert.deepEqual(toThreeLine({ ...row, laneLabel: '' }), [
    '话题地图 · 第 7 轮 · 2 小时前', '把跳转做到准确', '重要',
  ])
  assert.deepEqual(toThreeLine({ ...row, laneLabel: '', statusLabel: '' }), [
    '话题地图 · 第 7 轮 · 2 小时前', '把跳转做到准确', '',
  ])
})

test('切片对残缺行 / 空输入不崩', () => {
  assert.deepEqual(toTwoLine({ title: '会话', snippet: '片段' }), ['会话', '片段'])
  assert.deepEqual(toTwoLine(null), ['', ''])
  assert.deepEqual(toThreeLine(undefined), ['', '', ''])
})

// ── 分数来源 ────────────────────────────────────────────────────────
test('scoreParts：拼成一句分数来源（A-14）', () => {
  const hit = hitOf({
    breakdown: {
      parts: [
        { text: '提问×3' },
        { text: '出现4次×0.8' },
        { text: '2天前×1.4' },
        { text: '重要+2' },
      ],
    },
  })
  assert.equal(scoreParts(hit), '提问×3 · 出现4次×0.8 · 2天前×1.4 · 重要+2')
  assert.equal(scoreParts(hitOf({})), '')
  assert.equal(scoreParts(hitOf({ breakdown: { parts: [] } })), '')
  assert.equal(scoreParts(null), '')
})

// ── 分组头 ──────────────────────────────────────────────────────────
test('groupHeader：提过 N 次 · M 段 · 最近 …', () => {
  assert.equal(
    groupHeader({ count: 3, lanes: 2, latest: ago(2 * DAY) }, { now: NOW }),
    '提过 3 次 · 2 段 · 最近 2 天前',
  )
  assert.equal(groupHeader({ count: 3, lanes: 2 }, { now: NOW }), '提过 3 次 · 2 段')
  assert.equal(
    groupHeader({ count: 0, lanes: 1, latest: ago(HOUR) }, { now: NOW }),
    '提过 0 次 · 1 段 · 最近 1 小时前',
  )
})

// ── 复制反馈 ────────────────────────────────────────────────────────
test('copySummary：0 / 1 / 多条含失败', () => {
  assert.equal(copySummary([]), '没有可复制的命令')
  assert.equal(copySummary({ commands: [] }), '没有可复制的命令')
  assert.equal(copySummary([{ ok: true }]), '已复制 1 条命令')
  assert.equal(copySummary([{ ok: false }]), '已复制 1 条命令（含 1 条失败）')
  assert.equal(
    copySummary({ commands: [{ ok: true }, { ok: true }, { ok: false }] }),
    '已复制 3 条命令（含 1 条失败）',
  )
  assert.equal(
    copySummary({ commands: [{ exitCode: 0 }, { exitCode: 2 }] }),
    '已复制 2 条命令（含 1 条失败）',
  )
  assert.equal(copySummary(['git status']), '已复制 1 条命令')
  assert.equal(copySummary({ count: 3, failed: 1 }), '已复制 3 条命令（含 1 条失败）')
})

test('copySummary：复制的是结论时的文案', () => {
  assert.equal(copySummary({ text: '结论正文' }), '已复制结论')
  assert.equal(copySummary({ kind: 'conclusion' }), '已复制结论')
  assert.equal(copySummary(null), '没有可复制的命令')
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const f of failures) console.error(`\n${f.name}\n${f.error.stack}`)
  process.exit(1)
}
