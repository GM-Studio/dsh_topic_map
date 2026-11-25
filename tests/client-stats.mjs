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
  'CATEGORIES_ID', 'CATEGORIES_KIND', 'CATEGORIES_TITLE',
  'CLUE_ID', 'CLUE_KIND', 'CLUE_TITLE',
  'STATS_ID', 'STATS_KIND', 'STATS_TITLE',
  'SETTINGS_ID', 'SETTINGS_KIND', 'SETTINGS_TITLE',
  `var RIGHT_TABS = ${extractAssignment(src, 'RIGHT_TABS')};return RIGHT_TABS`,
)(
  'dsh-topic-map:history', 'topic-map-history', '历史',
  'dsh-topic-map:categories', 'topic-map-categories', '分类',
  'dsh-topic-map:clue', 'topic-map-clue', '线索',
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
  extractFunction(src, 'statsSortKey'),
  extractFunction(src, 'readStatsSort'),
  extractFunction(src, 'saveStatsSort'),
  extractFunction(src, 'statsCompactNumber'),
  extractFunction(src, 'statsThousands'),
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
    ['STATSFMT', 'RIGHT_TABS', 'STATS_KIND', 'STATS_TITLE',
      'STATS_SORT_PREFIX', 'STATS_SORT_TURNS', 'STATS_SORT_TOKENS',
      'fetch', 'errorText', 'useTopicMapTheme'],
    [
      STATSFMT,
      RIGHT_TABS,
      'topic-map-stats',
      '统计',
      'dsh.tm.stats.sort.',
      'turns',
      'tokens',
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

await test('Top 会话排序：默认轮数倒序，切 Token 不重新请求，bar 按当前依据', async () => {
  const sortedValue = {
    sessions: 3,
    turns: 20,
    activeDays: 2,
    topSessions: [
      { title: '会话 A', turns: 5, tokens: 100, lastActive: NOW - 60 * 60 * 1000 },
      { title: '会话 B', turns: 10, tokens: 50, lastActive: NOW - 2 * 60 * 60 * 1000 },
      { title: '会话 C', turns: 5, tokens: 800, lastActive: NOW - 3 * 60 * 60 * 1000 },
    ],
    usage: { input: 1000, output: 500 },
  }
  const { runtime, tree, calls } = await mountStats(({ action }) => {
    if (action === 'workspaces') return { value: [{ id: 'ws-1', sessionIds: ['s1'] }] }
    if (action === 'stats') return { value: sortedValue }
    return { ok: false, error: 'unexpected ' + action }
  })
  const titles = () => byClass(runtime.tree, 'dsh_tm_statsrowtitle').map(textOf)
  assert.deepEqual(titles(), ['会话 B', '会话 A', '会话 C'], '轮数倒序；同轮数按 lastActive 倒序')
  assert.deepEqual(byClass(runtime.tree, 'dsh_tm_statsrowturns').map(textOf), ['10 轮', '5 轮', '5 轮'])

  const statsBefore = statsCalls(calls).length
  const tokenButton = findAll(runtime.tree, node => node.props['data-sort'] === 'tokens')[0]
  assert.equal(tokenButton.props.disabled, false)
  click(tokenButton)
  await runtime.settle()

  assert.equal(statsCalls(calls).length, statsBefore, '切换排序不重新请求 /stats')
  assert.deepEqual(titles(), ['会话 C', '会话 A', '会话 B'], 'Token 倒序')
  assert.deepEqual(byClass(runtime.tree, 'dsh_tm_statsrowturns').map(textOf), ['800', '100', '50'])
  assert.deepEqual(byClass(runtime.tree, 'dsh_tm_statsbar').map(bar => bar.props.style.width), ['100%', '13%', '6%'])
})

await test('Top 会话排序：按工作区记忆；tokens 缺失时禁用 Token 并给 title', async () => {
  const memory = new Map()
  const previous = globalThis.localStorage
  globalThis.localStorage = {
    getItem(key) { return memory.has(key) ? memory.get(key) : null },
    setItem(key, value) { memory.set(key, String(value)) },
  }
  try {
    const sortedValue = {
      sessions: 2,
      turns: 15,
      topSessions: [
        { title: '会话 A', turns: 5, tokens: 100, lastActive: NOW - 1000 },
        { title: '会话 B', turns: 10, tokens: 50, lastActive: NOW - 2000 },
      ],
      usage: { input: 10, output: 20 },
    }
    const first = await mountStats(({ action }) => {
      if (action === 'workspaces') return { value: [{ id: 'ws-1', sessionIds: ['s1'] }] }
      if (action === 'stats') return { value: sortedValue }
      return { ok: false, error: 'unexpected ' + action }
    })
    click(findAll(first.runtime.tree, node => node.props['data-sort'] === 'tokens')[0])
    await first.runtime.settle()
    assert.equal(memory.get('dsh.tm.stats.sort.ws-1'), 'tokens')

    const second = await mountStats(({ action }) => {
      if (action === 'workspaces') return { value: [{ id: 'ws-1', sessionIds: ['s1'] }] }
      if (action === 'stats') return { value: sortedValue }
      return { ok: false, error: 'unexpected ' + action }
    })
    assert.equal(byClass(second.runtime.tree, 'dsh_tm_statsrowtitle').map(textOf)[0], '会话 A', '恢复 token 排序')

    const missing = await mountStats(({ action }) => {
      if (action === 'workspaces') return { value: [{ id: 'ws-2', sessionIds: ['s1'] }] }
      if (action === 'stats') {
        return {
          value: {
            sessions: 1,
            turns: 5,
            topSessions: [{ title: '无 token', turns: 5, lastActive: NOW }],
            usage: { input: 0, output: 0 },
          },
        }
      }
      return { ok: false, error: 'unexpected ' + action }
    })
    const disabled = findAll(missing.runtime.tree, node => node.props['data-sort'] === 'tokens')[0]
    assert.equal(disabled.props.disabled, true)
    assert.equal(disabled.props.title, '统计接口未提供 token 数据')
  } finally {
    if (previous === undefined) delete globalThis.localStorage
    else globalThis.localStorage = previous
  }
})

finish()
