/**
 * 「续接」纯函数视图模型测试（lib/work-view.js）。
 *
 * 纯函数约束：零 import、无 DOM、不读系统时钟（now 一律入参传入）。
 *
 * Run: node tests/work-view.mjs
 */

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  formatInflectionBanner,
  formatRelativeTime,
  formatReopenBanner,
  formatWorkCard,
  workBoardModel,
} from '../lib/work-view.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

let passed = 0
const failures = []
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok   ${name}`) }
  catch (e) { failures.push({ name, error: e }); console.log(`  FAIL ${name}\n       ${e.message}`) }
}

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
// 固定基准时间：2026-11-27 15:00:00 本地时间
const NOW = new Date(2026, 10, 27, 15, 0, 0, 0).getTime()

console.log('\nwork-view')

// ── 零 import 与可嵌入约束 ──────────────────────────────────────────
test('模块纯净性：lib/work-view.js 零 import、不调用 Date.now / DOM', () => {
  const src = readFileSync(join(root, 'lib', 'work-view.js'), 'utf8')
  assert.equal(/^import\s+/m.test(src), false, '不得包含 import 语句')
  assert.equal(/\bDate\.now\b/.test(src), false, '不得调用 Date.now()')
  assert.equal(/\bdocument\b|\bwindow\b/.test(src), false, '不得直接访问 DOM')
  // 按 build-theme 相同规则剥离后应可作为 IIFE 直接编译执行
  const stripped = src
    .replace(/^\/\*\*[\s\S]*?\*\/\s*/m, '')
    .replace(/^export const /gm, 'var ')
    .replace(/^export function /gm, 'function ')
    .replace(/^import .*$/gm, '')
  const built = new Function(`${stripped}\nreturn { formatWorkCard, workBoardModel, formatInflectionBanner, formatReopenBanner, formatRelativeTime }`)()
  assert.equal(typeof built.formatWorkCard, 'function')
  assert.equal(typeof built.workBoardModel, 'function')
  assert.equal(typeof built.formatInflectionBanner, 'function')
  assert.equal(typeof built.formatReopenBanner, 'function')
})

// ── 相对时间格式化 ──────────────────────────────────────────────────
test('formatRelativeTime：刚刚 / N 分钟前 / 今天 / 昨天 / N 天前 / YYYY-MM-DD', () => {
  assert.equal(formatRelativeTime(NOW - 20 * 1000, NOW), '刚刚')
  assert.equal(formatRelativeTime(NOW - 15 * MINUTE, NOW), '15 分钟前')
  assert.equal(formatRelativeTime(NOW - 3 * HOUR, NOW), '今天')
  assert.equal(formatRelativeTime(new Date(2026, 10, 26, 18, 0, 0, 0).getTime(), NOW), '昨天')
  assert.equal(formatRelativeTime(new Date(2026, 10, 24, 10, 0, 0, 0).getTime(), NOW), '3 天前')
  assert.equal(formatRelativeTime(new Date(2026, 10, 10, 10, 0, 0, 0).getTime(), NOW), '2026-11-10')
  assert.equal(formatRelativeTime(new Date(2025, 11, 31, 10, 0, 0, 0).getTime(), NOW), '2025-12-31')
  assert.equal(formatRelativeTime(null, NOW), '')
  assert.equal(formatRelativeTime(NOW, undefined), '')
})

// ── formatWorkCard ──────────────────────────────────────────────────
test('formatWorkCard：4 行窄卡片核心结构与徽章风格（推测虚线 vs 已确认实线）', () => {
  const inferred = formatWorkCard({
    id: 'w-1',
    title: '迁移续接视图层',
    state: 'blocked',
    confidence: 'inferred',
    pinned: true,
    statusLine: '单测卡在 settings-view 与 client-settings 兼容校验，需要核对分组渲染逻辑',
    nextStep: '补充 dormantDays 与 inflectionNotice 校验',
    lastActivityAt: NOW - 12 * MINUTE,
    sessionCount: 2,
    segmentCount: 3,
    decisionCount: 2,
  }, NOW)

  assert.equal(inferred.id, 'w-1')
  assert.equal(inferred.title, '迁移续接视图层')
  assert.equal(inferred.state, 'blocked')
  assert.equal(inferred.stateBadge.label, '卡住')
  assert.equal(inferred.stateBadge.state, 'blocked')
  assert.equal(inferred.confidenceBadge.label, '推测')
  assert.equal(inferred.confidenceBadge.style, 'dashed')
  assert.equal(inferred.confidenceBadge.confirmed, false)
  assert.equal(inferred.timeLabel, '12 分钟前')
  assert.equal(inferred.pinned, true)

  // 第 2 行：现状/卡点，超长截断至 60 字以内（含省略号）
  assert.equal(Array.from(inferred.statusLine).length <= 60, true)
  assert.equal(inferred.statusLine.endsWith('…'), false, '不足 60 字不截断')

  // 第 3 行：下一步带箭头前缀
  assert.equal(inferred.nextStepLine, '→ 下一步：补充 dormantDays 与 inflectionNotice 校验')
  assert.equal(inferred.hasNextStep, true)

  // 第 4 行：动作条（主动作 + 更多动作）
  const primaryIds = inferred.actions.map(a => a.id)
  assert.deepEqual(primaryIds, ['resume', 'handoff', 'confirm_done', 'more'])
  assert.deepEqual(
    inferred.actions.map(a => a.label),
    ['回到现场', '新会话交接', '已完成', '更多'],
  )
  const moreAction = inferred.actions.find(a => a.id === 'more')
  assert.deepEqual(
    moreAction.items.map(i => i.id),
    ['inspect', 'merge', 'split', 'dismiss'],
  )
  assert.deepEqual(
    moreAction.items.map(i => i.label),
    ['看决策与证据', '合并', '拆段', '不算事'],
  )

  // 已确认态为实线风格
  const confirmed = formatWorkCard({
    id: 'w-2',
    title: '完成历史轨分组',
    state: 'active',
    stateSource: 'confirmed',
    statusSummary: '正在补 segmentGroupsOf',
    nextStep: '',
    lastActivityAt: NOW - 2 * HOUR,
  }, NOW)
  assert.equal(confirmed.stateBadge.label, '进行中')
  assert.equal(confirmed.confidenceBadge.label, '已确认')
  assert.equal(confirmed.confidenceBadge.style, 'solid')
  assert.equal(confirmed.confidenceBadge.confirmed, true)
  assert.equal(confirmed.timeLabel, '今天')
  assert.equal(confirmed.hasNextStep, false)
  assert.ok(confirmed.nextStepLine.startsWith('→ 下一步：'), '空下一步也要有清晰占位提示')
  assert.ok(confirmed.nextStepLine.includes('待补充'))
})

test('formatWorkCard：第 2 行 statusLine 超过 60 字时按码点截断并加省略号', () => {
  const longStatus = '一二三四五六七八九十'.repeat(8) // 80 字
  const card = formatWorkCard({
    id: 'w-long',
    title: '长状态测试',
    state: 'active',
    statusSummary: longStatus,
    nextStep: '下一步',
    lastActivityAt: NOW,
  }, NOW)
  assert.equal(Array.from(card.statusLine).length, 60)
  assert.ok(card.statusLine.endsWith('…'))
  assert.equal(card.statusFull, longStatus)
})

test('formatWorkCard：已收束卡片（done / shelved）徽章与动作正确', () => {
  const done = formatWorkCard({
    id: 'w-done',
    title: '已完结任务',
    state: 'done',
    confidence: 'confirmed',
    statusLine: '已验收通过',
    lastActivityAt: NOW - DAY,
  }, NOW)
  assert.equal(done.stateBadge.label, '已完成')
  assert.equal(done.timeLabel, '昨天')
  assert.equal(done.resolved, true)
  assert.ok(done.actions.some(a => a.id === 'reopen'))

  const shelved = formatWorkCard({
    id: 'w-shelved',
    title: '搁置任务',
    state: 'shelved',
    confidence: 'inferred',
    lastActivityAt: NOW - 20 * DAY,
  }, NOW)
  assert.equal(shelved.stateBadge.label, '已搁置')
  assert.equal(shelved.resolved, true)
  assert.ok(shelved.actions.some(a => a.id === 'reopen'))
})

test('formatWorkCard：展开详情正确格式化 decisions（现行/已否决+证据句柄）、files 与跨会话 segments', () => {
  const card = formatWorkCard({
    id: 'w-detail',
    title: '三层防失真交接',
    state: 'active',
    confidence: 'confirmed',
    decisions: [
      {
        id: 'd-1',
        summary: '改用程序直取硬事实',
        rationale: '避免自由散文丢失报错',
        status: 'active',
        evidenceHandle: '〔a1b2c3d4#5〕',
        at: NOW - 2 * HOUR,
      },
      {
        id: 'd-0',
        summary: '直接粘贴全文历史',
        rationale: '会撑爆上下文窗口',
        status: 'superseded',
        supersededBy: 'd-1',
        evidenceHandle: '〔a1b2c3d4#2〕',
        at: NOW - 3 * HOUR,
      },
    ],
    files: ['lib/handoff.js', 'tests/handoff.mjs', 'lib/handoff.js'],
    segments: [
      {
        id: 'seg-1',
        sessionId: 'session-a1b2c3d4ef99',
        sessionTitle: '协议设计',
        title: '确定三层边界',
        startTurn: 1,
        endTurn: 12,
      },
      {
        id: 'seg-2',
        sessionId: '99887766aabbccdd',
        title: '补齐单测',
        turnRange: [4, 4],
      },
    ],
    lastActivityAt: NOW - 5 * MINUTE,
  }, NOW)

  // 现行决策排在前面或明确标注 statusLabel
  assert.equal(card.decisions.length, 2)
  const activeDec = card.decisions.find(d => d.id === 'd-1')
  const superDec = card.decisions.find(d => d.id === 'd-0')
  assert.equal(activeDec.status, 'active')
  assert.equal(activeDec.statusLabel, '现行')
  assert.equal(activeDec.evidenceHandle, '〔a1b2c3d4#5〕')
  assert.equal(superDec.status, 'superseded')
  assert.equal(superDec.statusLabel, '已否决')
  assert.equal(superDec.supersededBy, 'd-1')
  assert.equal(superDec.evidenceHandle, '〔a1b2c3d4#2〕')

  // files 去重
  assert.deepEqual(card.files, ['lib/handoff.js', 'tests/handoff.mjs'])

  // 跨会话段清单：短会话 id 与轮次区间 #1–#12 / #4
  assert.equal(card.segments.length, 2)
  assert.equal(card.segments[0].shortSessionId, 'a1b2c3d4')
  assert.equal(card.segments[0].turnRangeLabel, '#1–#12')
  assert.equal(card.segments[0].title, '确定三层边界')
  assert.equal(card.segments[1].shortSessionId, '99887766')
  assert.equal(card.segments[1].turnRangeLabel, '#4')
})

// ── formatInflectionBanner ──────────────────────────────────────────
test('formatInflectionBanner：三类拐点产出非阻塞轻条文案与 1 秒一键动作', () => {
  const sw = formatInflectionBanner({
    kind: 'topic_switch',
    workId: 'w-1',
    title: '重构索引层',
    suggestedState: 'done',
  })
  assert.equal(sw.kind, 'topic_switch')
  assert.equal(sw.workId, 'w-1')
  assert.ok(sw.message.includes('重构索引层'))
  assert.ok(sw.actions.some(a => a.id === 'confirm_done' && a.state === 'done'))
  assert.ok(sw.actions.some(a => a.id === 'keep_active' && a.state === 'active'))
  assert.ok(sw.actions.some(a => a.id === 'ignore'))

  const settled = formatInflectionBanner({
    kind: 'likely_settled_or_blocked',
    workId: 'w-2',
    title: '修复构建脚本',
    suggestedState: 'done',
  })
  assert.equal(settled.kind, 'likely_settled_or_blocked')
  assert.ok(settled.message.includes('修复构建脚本'))
  assert.ok(settled.actions.some(a => a.id === 'confirm_done'))
  assert.ok(settled.actions.some(a => a.id === 'ignore'))

  const blocked = formatInflectionBanner({
    kind: 'likely_settled_or_blocked',
    workId: 'w-3',
    title: '排查超时故障',
    suggestedState: 'blocked',
  })
  assert.ok(blocked.message.includes('排查超时故障'))
  assert.ok(blocked.actions.some(a => a.id === 'confirm_blocked' && a.state === 'blocked'))
  assert.ok(blocked.actions.some(a => a.id === 'ignore'))

  const revisit = formatInflectionBanner({
    kind: 'revisit_unresolved',
    workId: 'w-4',
    title: '补齐端到端验证',
    suggestedState: 'active',
  })
  assert.equal(revisit.kind, 'revisit_unresolved')
  assert.ok(revisit.message.includes('补齐端到端验证'))
  assert.ok(revisit.actions.some(a => a.id === 'confirm_continue' || a.id === 'keep_active'))
  assert.ok(revisit.actions.some(a => a.id === 'confirm_done'))
  assert.ok(revisit.actions.some(a => a.id === 'ignore'))

  // 空值与未知类型安全返回 null
  assert.equal(formatInflectionBanner(null), null)
  assert.equal(formatInflectionBanner({ kind: 'unknown' }), null)
})

// ── formatReopenBanner ──────────────────────────────────────────────
test('formatReopenBanner：撞上已确认完成老事时的轻提示与 [关联重开]/[保持独立]', () => {
  const banner = formatReopenBanner({
    relatedDoneWorkId: 'w-old',
    relatedDoneWorkTitle: '首版检索优化',
    level: 'L2',
    reason: 'files',
    sharedFiles: ['lib/rank.js'],
  })
  assert.equal(banner.workId, 'w-old')
  assert.equal(banner.title, '首版检索优化')
  assert.ok(banner.message.includes('首版检索优化'))
  assert.deepEqual(
    banner.actions.map(a => ({ id: a.id, label: a.label })),
    [
      { id: 'reopen_link', label: '关联重开' },
      { id: 'keep_separate', label: '保持独立' },
    ],
  )
  assert.equal(formatReopenBanner(null), null)
  assert.equal(formatReopenBanner({}), null)
})

// ── workBoardModel ──────────────────────────────────────────────────
test('workBoardModel：顶部状态条、未收束排序（置顶 > blocked > active > 新近）与底部折叠区', () => {
  const payload = {
    pendingReviewCount: 3,
    reopenSuggestions: [
      { relatedDoneWorkId: 'w-old', relatedDoneWorkTitle: '旧搜索改造', reason: 'files' },
    ],
    inflection: {
      kind: 'likely_settled_or_blocked',
      workId: 'w-a',
      title: '任务 A',
      suggestedState: 'done',
    },
    unresolved: [
      { id: 'w-active-old', title: '普通旧任务', state: 'active', pinned: false, lastActivityAt: NOW - 2 * DAY },
      { id: 'w-blocked', title: '卡住任务', state: 'blocked', pinned: false, lastActivityAt: NOW - 3 * DAY },
      { id: 'w-active-new', title: '普通新任务', state: 'active', pinned: false, lastActivityAt: NOW - MINUTE },
      { id: 'w-pin', title: '置顶任务', state: 'active', pinned: true, lastActivityAt: NOW - 5 * DAY },
      { id: 'w-pin-blocked', title: '置顶卡住', state: 'blocked', pinned: true, lastActivityAt: NOW - 6 * DAY },
    ],
    settled: [
      { id: 'w-done', title: '已完成任务', state: 'done', confidence: 'confirmed', lastActivityAt: NOW - DAY },
      { id: 'w-shelved', title: '已沉降任务', state: 'shelved', confidence: 'inferred', lastActivityAt: NOW - 15 * DAY },
    ],
  }

  const collapsed = workBoardModel(payload, { now: NOW, showSettled: false })
  // 顶部状态条
  assert.equal(collapsed.pendingReviewBanner.count, 3)
  assert.equal(collapsed.pendingReviewBanner.message, '系统自动整理出 3 件待确认的事 — 确认哪些还在推进，改完即锁定不再被覆盖')
  assert.deepEqual(collapsed.pendingReviewBanner.action, { id: 'open_review', label: '开始逐条核对' })
  assert.deepEqual(collapsed.pendingReviewBanner.exitAction, { id: 'exit_review', label: '退出核对' })
  assert.deepEqual(collapsed.pendingReviewBanner.confirmAllAction, { id: 'confirm_all', label: '全部确认无误' })
  assert.equal(collapsed.reopenBanners.length, 1)
  assert.equal(collapsed.reopenBanners[0].workId, 'w-old')
  assert.equal(collapsed.inflectionBanner.workId, 'w-a')

  // 主列表排序：置顶且 blocked > 置顶 active > 非置顶 blocked > 非置顶 active（按时间新到旧）
  assert.deepEqual(
    collapsed.cards.map(c => c.id),
    ['w-pin-blocked', 'w-pin', 'w-blocked', 'w-active-new', 'w-active-old'],
  )

  // 底部折叠区默认收起
  assert.equal(collapsed.settledSection.count, 2)
  assert.equal(collapsed.settledSection.expanded, false)
  assert.deepEqual(collapsed.settledSection.visibleCards, [])
  assert.equal(collapsed.settledSection.cards.length, 2)
  assert.equal(collapsed.empty, null)

  // showSettled: true 时展开已收束卡片
  const expanded = workBoardModel(payload, { now: NOW, showSettled: true })
  assert.equal(expanded.settledSection.expanded, true)
  assert.deepEqual(expanded.settledSection.visibleCards.map(c => c.id), ['w-done', 'w-shelved'])
})

test('workBoardModel：空态区分冷启动整理中与暂无未收束的事', () => {
  const warming = workBoardModel({ coldStartStatus: 'scanning', unresolved: [], settled: [] }, { now: NOW })
  assert.equal(warming.empty.kind, 'cold_start')
  assert.ok(warming.empty.title.includes('整理中'))
  assert.equal(warming.pendingReviewBanner, null)

  const idle = workBoardModel({ unresolved: [], settled: [] }, { now: NOW })
  assert.equal(idle.empty.kind, 'no_unresolved')
  assert.ok(idle.empty.title.includes('暂无未收束的事'))
  assert.ok(idle.empty.description.includes('历史'))
  assert.equal(idle.empty.action.id, 'open_history')

  // 仅有已收束事时，主列表空态仍提示暂无未收束的事，同时底部保留已收束计数
  const onlySettled = workBoardModel({
    unresolved: [],
    settled: [{ id: 'w-done', title: '完成项', state: 'done', lastActivityAt: NOW - DAY }],
  }, { now: NOW })
  assert.equal(onlySettled.empty.kind, 'no_unresolved')
  assert.equal(onlySettled.settledSection.count, 1)
})

test('workBoardModel：极端空输入安全降级不抛错且不改入参', () => {
  const input = { unresolved: [{ id: 'w-1', title: 'A', state: 'active', lastActivityAt: NOW }] }
  const snapshot = JSON.stringify(input)
  const model = workBoardModel(input, { now: NOW })
  assert.equal(JSON.stringify(input), snapshot)
  assert.equal(model.cards.length, 1)

  const nil = workBoardModel(null, { now: NOW })
  assert.equal(nil.cards.length, 0)
  assert.equal(nil.empty.kind, 'no_unresolved')
})

// ── 汇总 ────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const failure of failures) console.log(`\n${failure.name}\n${failure.error.stack}`)
  process.exit(1)
}
