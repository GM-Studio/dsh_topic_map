/**
 * 线索 tab：/search 参数、时间线聚类、delta 徽标、统计、空态与失败态。
 *
 * 组件原样取自 lib/client.js；buildClue 用嵌入前的那份纯模块（同一实现），
 * 假 fetch 只回 /search 的信封。
 */

import { strict as assert } from 'node:assert'
import * as CLUEVIEW from '../lib/clue-view.js'
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
  change,
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

const CLUE_EMPTY_TEXT = (src.match(/var CLUE_EMPTY_TEXT = '([^']*)'/) || [])[1]
const { test, finish } = makeRunner('client-clue')

const NOW = Date.now()
const DAY = 24 * 60 * 60 * 1000
/** 某个本地自然日的 09:00，保证"同一天"不受运行时刻影响。 */
function dayAt(offsetDays, hour) {
  const date = new Date(NOW - offsetDays * DAY)
  date.setHours(hour, 0, 0, 0)
  return date.getTime()
}
const HITS = [
  // 故意乱序：组件必须先按时间升序再交给 buildClue。
  { sessionId: 's2', title: '会话 B', turn: 9, time: dayAt(2, 9), promptHead: '另一个会话也在查索引' },
  { sessionId: 's1', title: '会话 A', turn: 2, time: dayAt(3, 9), promptHead: '第一次讨论索引' },
  { sessionId: 's1', title: '会话 A', turn: 11, time: dayAt(1, 9), promptHead: '索引终于跑通了' },
  { sessionId: 's1', title: '会话 A', turn: 5, time: dayAt(3, 13), promptHead: '同一天又补了一版索引' },
]

const COMPONENT_SOURCE = [
  extractFunction(src, 'unrefTimer'),
  extractFunction(src, 'categoryErrorText'),
  extractFunction(src, 'clueRowNode'),
  extractFunction(src, 'clueRowsOfHits'),
  extractFunction(src, 'clueStatsText'),
  extractFunction(src, 'requestTopicMap'),
  extractFunction(src, 'RightTabStrip'),
  extractFunction(src, 'ClueTabBody'),
].join('\n')

const TIMELINE_SOURCE = [
  extractFunction(src, 'clueRowNode'),
  extractFunction(src, 'clueRowsOfHits'),
  extractFunction(src, 'clueStatsText'),
  extractFunction(src, 'HistoryClueTimeline'),
].join('\n')

const ERROR_TEXT = error => String(error && error.message ? error.message : error)

async function mountClue(handler) {
  const fake = makeFetch(handler)
  const located = []
  const runtime = await renderComponent(
    COMPONENT_SOURCE,
    'ClueTabBody',
    [
      'CLUEVIEW', 'RIGHT_TABS', 'CLUE_KIND', 'CLUE_TITLE', 'CLUE_EMPTY_TEXT',
      'CLUE_SEARCH_PLACEHOLDER', 'fetch', 'errorText', 'useTopicMapTheme', 'locateHistoryTurn',
    ],
    [
      CLUEVIEW, RIGHT_TABS, 'topic-map-clue', '线索', CLUE_EMPTY_TEXT,
      '关键词，空格分隔', fake.fetch, ERROR_TEXT, function () {},
      function (sessionId, turn, seq, currentSessionId) {
        located.push({ sessionId: sessionId, turn: turn, seq: seq, currentSessionId: currentSessionId })
        return Promise.resolve({ ok: true })
      },
    ],
    { sessionId: 's1', openTab: function () {} },
  )
  return { runtime: runtime, tree: runtime.tree, calls: fake.calls, located: located }
}

function searches(calls) {
  return calls.filter(call => call.action === 'search')
}

async function searchFor(runtime, text) {
  const input = byClass(runtime.tree, 'dsh_tm_clueinput')[0]
  change(input, text)
  await runtime.settle()
  const button = byClass(runtime.tree, 'dsh_tm_cluesubmit')[0]
  click(button)
  await runtime.settle()
}

await test('初始空态：输入关键词，看看这个话题在这些会话里怎么演变的；不发请求', async () => {
  const { tree, calls } = await mountClue(() => ({ value: { hits: [], total: 0 } }))
  const empty = byClass(tree, 'dsh_tm_clueempty')[0]
  assert.equal(textOf(empty), '输入关键词，看看这个话题在这些会话里怎么演变的')
  assert.equal(searches(calls).length, 0, '空输入不检索')
  assert.equal(byClass(tree, 'dsh_tm_cluestats').length, 0)
})

await test('搜索：POST /search {sessionId, keywords}；统计 / 时间线聚类 / delta 徽标', async () => {
  const { runtime, calls } = await mountClue(({ action }) => {
    if (action === 'search') return { value: { hits: HITS, total: HITS.length, truncated: false } }
    return { ok: false, error: 'unexpected ' + action }
  })
  await searchFor(runtime, '  索引  ')

  const sent = searches(calls)
  assert.equal(sent.length, 1)
  assert.deepEqual(sent[0].body, { sessionId: 's1', keywords: '索引' })
  assert.equal(sent[0].method, 'POST')

  assert.equal(byClass(runtime.tree, 'dsh_tm_cluestats').length, 1)
  assert.equal(textOf(byClass(runtime.tree, 'dsh_tm_cluestats')[0]), '2 个会话 / 4 轮 / 跨度 2 天')

  const rows = byClass(runtime.tree, 'dsh_tm_cluerow')
  assert.equal(rows.length, 3, '相邻同会话同日合并成一个时间点')
  assert.deepEqual(byClass(runtime.tree, 'dsh_tm_clueturn').map(textOf), ['第 2 轮', '第 9 轮', '第 11 轮'])
  assert.deepEqual(byClass(runtime.tree, 'dsh_tm_cluedelta').map(textOf), ['首次提及', '首次提及', '第 3 次'])
  assert.deepEqual(byClass(runtime.tree, 'dsh_tm_clueat').map(textOf), ['会话 A', '会话 B', '会话 A'])
  assert.equal(textOf(byClass(runtime.tree, 'dsh_tm_cluetime')[0]), '3 天前')
  assert.equal(textOf(byClass(runtime.tree, 'dsh_tm_clueheadtext')[0]), '第一次讨论索引')
  assert.equal(textOf(byClass(runtime.tree, 'dsh_tm_cluesub')[0]), '同日合并 2 次')
  assert.equal(byClass(runtime.tree, 'dsh_tm_clueempty').length, 0)
})

await test('点时间线行 → 定位到该会话该轮', async () => {
  const { runtime, located } = await mountClue(({ action }) => {
    if (action === 'search') return { value: { hits: HITS, total: HITS.length } }
    return { ok: false, error: 'unexpected ' + action }
  })
  await searchFor(runtime, '索引')
  click(byClass(runtime.tree, 'dsh_tm_cluerow')[0])
  await runtime.settle()
  assert.deepEqual(located, [{ sessionId: 's1', turn: 2, seq: null, currentSessionId: 's1' }])
  assert.ok(textOf(byClass(runtime.tree, 'dsh_tm_cluenotice')[0]).includes('已定位到第 2 轮'))
})

await test('空结果：没有找到与关键词相关的轮次，不显示统计', async () => {
  const { runtime } = await mountClue(({ action }) => {
    if (action === 'search') return { value: { hits: [], total: 0, truncated: false } }
    return { ok: false, error: 'unexpected ' + action }
  })
  await searchFor(runtime, '不存在的词')
  assert.equal(textOf(byClass(runtime.tree, 'dsh_tm_clueempty')[0]),
    '没有找到与「不存在的词」相关的轮次')
  assert.equal(byClass(runtime.tree, 'dsh_tm_cluestats').length, 0)
})

await test('失败：显示 Host 中文错误并可重试', async () => {
  let attempt = 0
  const { runtime, calls } = await mountClue(({ action }) => {
    if (action === 'search') {
      attempt += 1
      if (attempt === 1) return { status: 503, ok: false, error: '检索服务不可用' }
      return { value: { hits: HITS, total: HITS.length } }
    }
    return { ok: false, error: 'unexpected ' + action }
  })
  await searchFor(runtime, '索引')
  const errorBox = byClass(runtime.tree, 'dsh_tm_clueerr')[0]
  assert.ok(errorBox !== undefined)
  assert.ok(textOf(errorBox).includes('检索失败：检索服务不可用'), 'Host 中文错误原样展示')
  const retry = byClass(runtime.tree, 'dsh_tm_clueretry')[0]
  assert.ok(retry !== undefined)
  click(retry)
  await runtime.settle()
  assert.equal(searches(calls).length, 2)
  assert.equal(byClass(runtime.tree, 'dsh_tm_cluerow').length, 3, '重试成功后恢复时间线')
  assert.equal(byClass(runtime.tree, 'dsh_tm_clueerr').length, 0)
})

await test('清空关键词再搜索：回到空态且不发请求', async () => {
  const { runtime, calls } = await mountClue(({ action }) => {
    if (action === 'search') return { value: { hits: HITS, total: HITS.length } }
    return { ok: false, error: 'unexpected ' + action }
  })
  await searchFor(runtime, '索引')
  assert.equal(searches(calls).length, 1)
  await searchFor(runtime, '   ')
  assert.equal(searches(calls).length, 1, '空关键词不应再发请求')
  assert.equal(textOf(byClass(runtime.tree, 'dsh_tm_clueempty')[0]), CLUE_EMPTY_TEXT)
})

await test('截断可见：命中 N 轮时写明只展示前 M 条', async () => {
  const { runtime } = await mountClue(({ action }) => {
    if (action === 'search') return { value: { hits: HITS, total: 99, truncated: true } }
    return { ok: false, error: 'unexpected ' + action }
  })
  await searchFor(runtime, '索引')
  const note = byClass(runtime.tree, 'dsh_tm_cluetruncated')[0]
  assert.ok(note !== undefined)
  assert.equal(textOf(note), '命中 99 轮，只展示前 4 条')
})

await test('历史页时间线：同一份 hits 走 CLUEVIEW，统计/轮次/跳转都在', async () => {
  const jumped = []
  const runtime = await renderComponent(
    TIMELINE_SOURCE,
    'HistoryClueTimeline',
    ['CLUEVIEW', 'HISTORY_EMPTY_TEXT'],
    [CLUEVIEW, '没有匹配的轮次'],
    {
      hits: HITS,
      keywords: '索引',
      onJump: function (item) { jumped.push(item) },
    },
  )
  assert.equal(textOf(byClass(runtime.tree, 'dsh_tm_cluestats')[0]), '2 个会话 / 4 轮 / 跨度 2 天')
  assert.equal(byClass(runtime.tree, 'dsh_tm_cluerow').length, 3)
  click(byClass(runtime.tree, 'dsh_tm_cluerow')[0])
  assert.equal(jumped.length, 1)
  assert.equal(jumped[0].sessionId, 's1')
  assert.equal(jumped[0].turn, 2)
})

await test('历史页时间线：空命中显示「没有匹配的轮次」', async () => {
  const runtime = await renderComponent(
    TIMELINE_SOURCE,
    'HistoryClueTimeline',
    ['CLUEVIEW', 'HISTORY_EMPTY_TEXT'],
    [CLUEVIEW, '没有匹配的轮次'],
    { hits: [], keywords: '索引', onJump: function () {} },
  )
  assert.equal(textOf(byClass(runtime.tree, 'dsh_tm_history_empty')[0]), '没有匹配的轮次')
})

await test('历史视图记忆：按工作区读写，坏值回列表', async () => {
  const memory = new Map()
  const previous = globalThis.localStorage
  globalThis.localStorage = {
    getItem(key) { return memory.has(key) ? memory.get(key) : null },
    setItem(key, value) { memory.set(key, String(value)) },
  }
  try {
    const built = new Function(
      'HISTORY_VIEW_PREFIX', 'HISTORY_LIST_VIEW', 'HISTORY_TIMELINE_VIEW',
      `${extractFunction(src, 'historyViewKey')}
       ${extractFunction(src, 'readHistoryView')}
       ${extractFunction(src, 'saveHistoryView')}
       return { key: historyViewKey, read: readHistoryView, save: saveHistoryView }`,
    )('dsh.tm.history.view.', 'list', 'timeline')
    assert.equal(built.key('ws-1'), 'dsh.tm.history.view.ws-1')
    assert.equal(built.read('ws-1'), 'list', '未写过默认列表')
    built.save('ws-1', 'timeline')
    assert.equal(memory.get('dsh.tm.history.view.ws-1'), 'timeline')
    assert.equal(built.read('ws-1'), 'timeline')
    memory.set('dsh.tm.history.view.ws-2', 'garbage')
    assert.equal(built.read('ws-2'), 'list', '坏值不信任')
  } finally {
    if (previous === undefined) delete globalThis.localStorage
    else globalThis.localStorage = previous
  }
})

await test('分类:名称 前缀：唯一命中 / 多候选 / 无候选 / 尾随关键词', async () => {
  const parse = new Function(`${extractFunction(src, 'parseCategoryPrefix')};return parseCategoryPrefix`)()
  const options = [
    { id: 'c1', name: '插件开发', path: '技术 › 插件开发' },
    { id: 'c2', name: '插件测试', path: '技术 › 插件测试' },
    { id: 'c3', name: '测试', path: '测试' },
  ]
  const one = parse('分类:测试 索引', options)
  assert.equal(one.active, true)
  assert.equal(one.matched.id, 'c3')
  assert.equal(one.keywords, '索引')

  const many = parse('分类:插件 ', options)
  assert.equal(many.matched, null)
  assert.deepEqual(many.candidates.map(item => item.id), ['c1', 'c2'])

  const none = parse('分类:不存在 索引', options)
  assert.deepEqual(none.candidates, [])
  assert.equal(none.keywords, '索引')

  assert.equal(parse('普通关键词', options).active, false)
})

await test('历史 /search：全部不带 categoryId；分类浏览带空关键词 + categoryId', async () => {
  const fake = makeFetch(() => ({ value: { hits: [], total: 0 } }))
  const state = { seq: 0 }
  const seqRef = {
    get current() { return state.seq },
    set current(value) { state.seq = value },
  }
  const abortRef = { current: null }
  const requestHistory = new Function(
    'boundSessionId', 'HISTORY_SEARCH_LIMIT', 'page', 'pageSize', 'categoryData', 'fetch', 'seqRef', 'abortRef', 'cancelHistorySearch',
    `${extractFunction(src, 'requestHistory')};return requestHistory`,
  )('s1', 30, 0, 10, { workspaceId: 'ws-1' }, fake.fetch, seqRef, abortRef, function () { state.seq += 1; abortRef.current = null })

  await requestHistory({ keywords: '索引', categoryId: '' })
  await requestHistory({ keywords: '', categoryId: '__none__' })
  await requestHistory({ keywords: '索引', categoryId: 'c1' })
  await requestHistory({ keywords: '', categoryId: '' })

  assert.equal(fake.calls.length, 4)
  assert.equal(Object.prototype.hasOwnProperty.call(fake.calls[0].body, 'categoryId'), false, '全部不带 categoryId')
  assert.deepEqual(fake.calls[0].body, { sessionId: 's1', keywords: '索引', offset: 0, limit: 10, workspaceId: 'ws-1' })
  assert.equal(fake.calls[1].body.keywords, '', '分类浏览允许空关键词')
  assert.equal(fake.calls[1].body.categoryId, '__none__')
  assert.equal(fake.calls[1].body.workspaceId, 'ws-1')
  assert.equal(fake.calls[2].body.categoryId, 'c1')
  assert.equal(fake.calls[2].body.workspaceId, 'ws-1')
  assert.deepEqual(fake.calls[3].body, { sessionId: 's1', keywords: '', offset: 0, limit: 10, workspaceId: 'ws-1' }, '全部：空关键词且不带分类')
})

finish()
