/**
 * 统计 tab：用假 fetch + 微型 hooks 运行时渲染真实组件。
 *
 * 覆盖验收要求：头条四卡、用量拆分、Top 会话 bar、空态文案、失败显示
 * Host 中文错误并可重试、workspaceId 反查得到才带、拿不到就不带。
 */

import { strict as assert } from 'node:assert'
import * as STATSFMT from '../lib/stats-format.js'
import {
  readClient,
  extractFunction,
  extractAssignment,
  renderComponent,
  makeFetch,
  makeRunner,
  byClass,
  findAll,
  textOf,
  click,
  h,
  React,
  Fragment,
} from './client-harness.mjs'

const src = readClient()
const RIGHT_TABS = new Function(
  'HISTORY_ID', 'HISTORY_KIND', 'HISTORY_TITLE',
  'STATS_ID', 'STATS_KIND', 'STATS_TITLE',
  'SETTINGS_ID', 'SETTINGS_KIND', 'SETTINGS_TITLE',
  `var RIGHT_TABS = ${extractAssignment(src, 'RIGHT_TABS')};return RIGHT_TABS`,
)(
  'dsh-topic-map:history', 'topic-map-history', '历史',
  'dsh-topic-map:stats', 'topic-map-stats', '统计',
  'dsh-topic-map:settings', 'topic-map-settings', '设置',
)
const { test, finish } = makeRunner('client-stats')

const NOW = Date.now()
const STATS_VALUE = {
  sessions: 3,
  turns: 12,
  activeDays: 2,
  topSessions: [
    // Host 的真实字段是 lastActive；客户端必须归一，否则相对时间恒为「未知」。
    { title: '会话 A', turns: 4, lastActive: NOW - 60 * 60 * 1000 },
    { title: '会话 B', turns: 2, lastActivity: NOW - 2 * 60 * 60 * 1000 },
  ],
  usage: { input: 1500, output: 500, total: 2000 },
}

const COMPONENT_SOURCE = [
  extractFunction(src, 'statsPageModel'),
  extractFunction(src, 'statsPageNodes'),
  extractFunction(src, 'resolveWorkspaceIdForSession'),
  extractFunction(src, 'requestTopicMap'),
  extractFunction(src, 'loadStatsForSession'),
  extractFunction(src, 'RightTabStrip'),
  extractFunction(src, 'StatsTabBody'),
].join('\n')

async function mountStats(handler, sessionId) {
  const fake = makeFetch(handler)
  const runtime = await renderComponent(
    COMPONENT_SOURCE,
    'StatsTabBody',
    ['STATSFMT', 'RIGHT_TABS', 'STATS_KIND', 'STATS_TITLE', 'fetch', 'errorText', 'useTopicMapTheme'],
    [
      STATSFMT,
      RIGHT_TABS,
      'topic-map-stats',
      '统计',
      fake.fetch,
      error => String(error && error.message ? error.message : error),
      function () {},
    ],
    { sessionId: sessionId === undefined ? 's1' : sessionId, openTab: function () {} },
  )
  return { runtime: runtime, tree: runtime.tree, calls: fake.calls }
}

function statsCalls(calls) {
  return calls.filter(call => call.action === 'stats')
}

await test('统计渲染：4 个头条 + 用量拆分 + Top 会话 bar', async () => {
  const { tree, calls } = await mountStats(({ action }) => {
    if (action === 'workspaces') {
      return { value: [{ id: 'ws-1', title: '工作区', sessionIds: ['s1', 's2'] }] }
    }
    if (action === 'stats') return { value: STATS_VALUE }
    return { ok: false, error: 'unexpected ' + action }
  })

  const workspaceCalls = calls.filter(call => call.action === 'workspaces')
  assert.equal(workspaceCalls.length, 1, '应先反查当前会话所属工作区')
  const stats = statsCalls(calls)
  assert.equal(stats.length, 1)
  assert.deepEqual(stats[0].body, { workspaceId: 'ws-1' }, '反查到工作区就带 workspaceId')

  const cards = byClass(tree, 'dsh_tm_statscard')
  assert.equal(cards.length, 4, '页头必须 4 个指标')
  assert.deepEqual(byClass(tree, 'dsh_tm_statscardlabel').map(textOf), ['会话数', '轮次数', '活跃天数', '总用量'])
  assert.deepEqual(byClass(tree, 'dsh_tm_statscardvalue').map(textOf), ['3', '12', '2 天', '2k tokens'])

  const fill = byClass(tree, 'dsh_tm_statsusagefill')
  assert.equal(fill.length, 1)
  assert.equal(fill[0].props.style.width, '25%', '输出占比 500/2000 = 25%')
  assert.ok(textOf(byClass(tree, 'dsh_tm_statsusagelegend')[0]).includes('输入 1.5k'))

  const rows = byClass(tree, 'dsh_tm_statsrow')
  assert.equal(rows.length, 2)
  const bars = byClass(tree, 'dsh_tm_statsbar')
  assert.deepEqual(bars.map(bar => bar.props.style.width), ['100%', '50%'], 'bar 以本页最大轮数为分母')
  assert.equal(byClass(tree, 'dsh_tm_statsrow')[0].props['data-percent'], '100')
  const times = byClass(tree, 'dsh_tm_statsrowtime').map(textOf)
  assert.deepEqual(times, ['1 小时前', '2 小时前'], 'Host 的 lastActive 与行模型的 lastActivity 必须归一')
})

await test('空态：这个工作区还没有可统计的会话', async () => {
  const { tree } = await mountStats(({ action }) => {
    if (action === 'workspaces') return { value: [] }
    if (action === 'stats') {
      return { value: { sessions: 0, turns: 0, activeDays: 0, topSessions: [], usage: { input: 0, output: 0 } } }
    }
    return { ok: false, error: 'unexpected ' + action }
  })
  const empty = byClass(tree, 'dsh_tm_statsempty')
  assert.equal(empty.length, 1)
  assert.equal(textOf(empty[0]), '这个工作区还没有可统计的会话')
  assert.equal(byClass(tree, 'dsh_tm_statshero').length, 0, '空态不画空卡片')
})

await test('反查不到工作区：请求体不带 workspaceId', async () => {
  const { calls } = await mountStats(({ action }) => {
    if (action === 'workspaces') return { value: [{ id: 'ws-2', sessionIds: ['other'] }] }
    if (action === 'stats') return { value: STATS_VALUE }
    return { ok: false, error: 'unexpected ' + action }
  })
  const stats = statsCalls(calls)
  assert.equal(stats.length, 1)
  assert.deepEqual(stats[0].body, {}, '拿不到所属工作区就不猜第一个，交给 Host 兜底')
})

await test('失败：展示 Host 中文错误，重试按钮重新请求并恢复渲染', async () => {
  let attempt = 0
  const { runtime, tree, calls } = await mountStats(({ action }) => {
    if (action === 'workspaces') return { value: [] }
    if (action === 'stats') {
      attempt += 1
      if (attempt === 1) return { status: 404, ok: false, error: '工作区不存在' }
      return { value: STATS_VALUE }
    }
    return { ok: false, error: 'unexpected ' + action }
  })

  const errorBox = byClass(tree, 'dsh_tm_statserr')
  assert.equal(errorBox.length, 1)
  assert.ok(textOf(errorBox[0]).includes('统计失败：工作区不存在'), 'Host 的中文错误必须原样展示')
  const retry = byClass(tree, 'dsh_tm_statsretry')[0]
  assert.ok(retry !== undefined, '失败态必须有重试按钮')

  click(retry)
  await runtime.settle()
  assert.equal(statsCalls(calls).length, 2, '重试应重新请求 /stats')
  assert.equal(byClass(runtime.tree, 'dsh_tm_statscard').length, 4, '成功后恢复头条')
  assert.equal(byClass(runtime.tree, 'dsh_tm_statserr').length, 0)
  assert.ok(attempt >= 2)
})

await test('就绪后刷新按钮可用（加载中才禁用）', async () => {
  const { tree } = await mountStats(({ action }) => {
    if (action === 'workspaces') return { value: [{ id: 'ws-1', sessionIds: ['s1'] }] }
    if (action === 'stats') return { value: STATS_VALUE }
    return { ok: false, error: 'unexpected ' + action }
  })
  const refresh = byClass(tree, 'dsh_tm_statsrefresh')[0]
  assert.equal(refresh.props.disabled, false)
})

finish()
