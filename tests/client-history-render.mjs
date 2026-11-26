/**
 * 真实 HistoryTabBody 挂载：默认最近轮次、分类会话列表、闪烁一帧与分页。
 *
 * 直接执行 client.js 的模块 factory（只注入最小浏览器/React/网络替身），
 * 组件代码不复制、不改写。
 */

import { strict as assert } from 'node:assert'
import {
  HookRuntime,
  Fragment,
  h,
  readClient,
  makeFetch,
  makeRunner,
  byClass,
  byData,
  findAll,
  textOf,
  click,
  change,
} from './client-harness.mjs'

const src = readClient()
const { test, finish } = makeRunner('client-history-render')

/* ── 从模块 factory 里取出真实组件 ─────────────────────────────── */
function loadModule() {
  const marker = 'factory: (require) => {'
  const at = src.indexOf(marker)
  assert.ok(at >= 0)
  let depth = 0
  let end = -1
  for (let i = src.indexOf('{', at); i < src.length; i += 1) {
    if (src[i] === '{') depth += 1
    if (src[i] === '}' && --depth === 0) { end = i; break }
  }
  assert.ok(end > at)
  const body = src.slice(src.indexOf('{', at) + 1, end)
  const patched = body.replace(/return module\.exports\s*$/,
    'module.exports.__historyTabBody = HistoryTabBody; module.exports.__historyDiag = function () { return HISTORY_DIAG }; return module.exports')
  const params = ['require', 'window', 'document', 'localStorage', 'sessionStorage', 'fetch',
    'AbortController', 'setTimeout', 'clearTimeout', 'navigator']
  return new Function(...params, patched)
}

const CATEGORY_STORE = {
  categories: [
    { id: 'c-reader', name: '阅读器', parentId: null },
    { id: 'c-child', name: '子类', parentId: 'c-reader' },
    { id: 'c-grand', name: '孙类', parentId: 'c-child' },
  ],
  assignments: { s1: { categoryId: 'c-grand', source: 'user' } },
}
const SESSIONS = Array.from({ length: 25 }, (_, i) => ({
  sessionId: 's' + (i + 1),
  title: '会话 ' + (i + 1),
  turns: 25 - i,
  lastActive: 1700000000000 - i * 1000,
}))

function hit(turn) {
  return {
    sessionId: 's1', turn: turn, title: '会话 A', promptHead: '第 ' + turn + ' 轮摘要',
    time: 1700000000000 - turn * 1000, matchedIn: 'prompt', score: 1,
  }
}

function setupRuntime(options) {
  const opts = options === undefined ? {} : options
  const memory = new Map(Object.entries(opts.memory || {}))
  const localStorage = {
    getItem(key) { return memory.has(key) ? memory.get(key) : null },
    setItem(key, value) { memory.set(key, String(value)) },
    removeItem(key) { memory.delete(key) },
  }
  const docListeners = {}
  const document = {
    visibilityState: 'visible',
    documentElement: { setAttribute() {} },
    querySelector() { return null },
    querySelectorAll() { return [] },
    body: { appendChild() {} },
    addEventListener(type, fn) { (docListeners[type] = docListeners[type] || []).push(fn) },
    removeEventListener(type, fn) {
      const list = docListeners[type] || []
      const at = list.indexOf(fn)
      if (at >= 0) list.splice(at, 1)
    },
  }
  const window = {
    innerWidth: 1400, innerHeight: 900,
    addEventListener() {}, removeEventListener() {},
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: id => clearTimeout(id),
  }
  const fake = makeFetch(({ action, body }) => {
    if (action === 'workspaces') {
      return {
        value: [
          opts.workspace || { id: 'ws-1', title: 'demo', path: '/tmp/demo', sessionIds: ['s1'] },
          { id: 'ws-2', title: 'two', path: '/tmp/two', sessionIds: ['s2'] },
        ],
      }
    }
    if (action === 'categories') {
      return { value: { store: CATEGORY_STORE, tree: [], lockedSessions: {} } }
    }
    if (action === 'sessions') {
      return { value: { workspace: { id: 'ws-1' }, sessions: SESSIONS, total: SESSIONS.length } }
    }
    if (action === 'search') {
      const offset = Number(body.offset) || 0
      const limit = Number(body.limit) || 10
      const total = body.categoryId === 'c-reader' ? 1 : 25
      const hits = []
      for (let i = offset; i < Math.min(total, offset + limit); i += 1) hits.push(hit(i + 1))
      return {
        value: {
          hits, total, offset, hasMore: offset + hits.length < total,
          truncated: offset + hits.length < total, elapsedMs: 1,
          workspace: opts.searchWorkspace || { id: 'ws-1', title: 'demo' }, indexed: { ready: 1, missing: 0 },
          coverage: { sessions: 1, indexed: 1, scannedFromLog: 0, indexing: 0 },
        },
      }
    }
    return { ok: false, error: 'unexpected ' + action }
  })

  const runtime = new HookRuntime()
  const React = {
    Fragment,
    createElement: h,
    useState: value => runtime.useState(value),
    useRef: value => runtime.useRef(value),
    useEffect: (fn, deps) => runtime.useEffect(fn, deps),
    useMemo: (fn, deps) => runtime.useMemo(fn, deps),
  }
  const factory = loadModule()
  const exported = factory(() => React, window, document, localStorage, null, fake.fetch,
    globalThis.AbortController, setTimeout, clearTimeout, null)
  runtime.component = exported.__historyTabBody
  runtime.props = { sessionId: 's1', hideTabStrip: true }
  return { runtime, fake, memory, doc: document, docListeners, diag: () => exported.__historyDiag() }
}

async function mountHistory(options) {
  const scene = setupRuntime(options)
  await scene.runtime.settle()
  return scene
}

function searchCalls(scene) {
  return scene.fake.calls.filter(call => call.action === 'search')
}

await test('初始「全部」：/search 空关键词、无 categoryId，渲染轮次行', async () => {
  const scene = await mountHistory()
  assert.equal(byClass(scene.runtime.tree, 'dsh_tm_histrecenthead').length, 0)
  assert.equal(textOf(scene.runtime.tree).includes('当前会话最近轮次'), false)
  const rows = byClass(scene.runtime.tree, 'dsh_tm_histrow')
  assert.equal(rows.length, 10, '默认每页 10 条')
  assert.equal(textOf(byClass(scene.runtime.tree, 'dsh_tm_histtitle')[0]), '历史检索 · demo')
  assert.equal(byClass(scene.runtime.tree, 'dsh_tm_histcatsession').length, 0, '不再渲染会话清单')
  assert.ok(textOf(scene.runtime.tree).includes('共 25 条'))
  const request = searchCalls(scene)[0]
  assert.equal(request.body.keywords, '')
  assert.equal(Object.prototype.hasOwnProperty.call(request.body, 'categoryId'), false)
  assert.equal(request.body.workspaceId, 'ws-1', '必须与 /categories 同一 workspaceId')
  assert.deepEqual({ offset: request.body.offset, limit: request.body.limit }, { offset: 0, limit: 10 })
  const diag = scene.diag()
  assert.equal(diag.branch, 'rows')
  assert.equal(diag.plan.idle, false)
  assert.equal(diag.result.total, 25)
  scene.runtime.unmount()
})

await test('无工作区名时标题只显示「历史检索」', async () => {
  const scene = await mountHistory({
    workspace: { id: 'ws-1', sessionIds: ['s1'] },
    searchWorkspace: { id: 'ws-1' },
  })
  assert.equal(textOf(byClass(scene.runtime.tree, 'dsh_tm_histtitle')[0]), '历史检索')
  scene.runtime.unmount()
})

await test('分类选中：/search 带 categoryId + 空关键词，行与关键词检索同 class', async () => {
  const scene = await mountHistory()
  const pill = byClass(scene.runtime.tree, 'dsh_tm_histcatpill')
    .find(node => node.props['data-cat-id'] === 'c-reader')
  click(pill)
  await scene.runtime.settle()
  const request = searchCalls(scene).at(-1)
  assert.equal(request.body.keywords, '', '分类浏览是空关键词')
  assert.equal(request.body.categoryId, 'c-reader')
  assert.equal(request.body.workspaceId, 'ws-1', '分类 id 与 workspaceId 必须同源')
  assert.equal(byClass(scene.runtime.tree, 'dsh_tm_histrow').length, 1)
  assert.equal(byClass(scene.runtime.tree, 'dsh_tm_histcatsession').length, 0)
  assert.ok(textOf(scene.runtime.tree).includes('共 1 条'))
  const all = byClass(scene.runtime.tree, 'dsh_tm_histcatpill')
    .find(node => node.props['data-cat-id'] === '__all__')
  click(all)
  await scene.runtime.settle()
  const allRequest = searchCalls(scene).at(-1)
  assert.equal(Object.prototype.hasOwnProperty.call(allRequest.body, 'categoryId'), false)
  assert.equal(byClass(scene.runtime.tree, 'dsh_tm_histrow').length, 10)
  scene.runtime.unmount()
})

await test('闪烁：分类结果 → 点全部，在 effect 前 renderOnce 已无旧行', async () => {
  const scene = await mountHistory()
  const searchInput = byClass(scene.runtime.tree, 'dsh_tm_history_search')[0]
  change(searchInput, '分类:阅读器 索引')
  searchInput.props.onKeyDown({ key: 'Enter', preventDefault() {} })
  await scene.runtime.settle()
  await new Promise(resolve => setTimeout(resolve, 20))
  await scene.runtime.settle()
  assert.ok(byClass(scene.runtime.tree, 'dsh_tm_histrow').length > 0, '分类结果应先有行')

  change(byClass(scene.runtime.tree, 'dsh_tm_history_search')[0], '分类:阅读器')
  scene.runtime.renderOnce() // 只更新查询，不跑 effect：result 仍是旧分类结果
  const all = byClass(scene.runtime.tree, 'dsh_tm_histcatpill')
    .find(node => node.props['data-cat-id'] === '__all__')
  click(all)
  scene.runtime.renderOnce()
  assert.equal(byClass(scene.runtime.tree, 'dsh_tm_histrow').length, 0, '不能画一帧旧检索行')
  assert.equal(byClass(scene.runtime.tree, 'dsh_tm_histcatsession').length, 0, '不能再走会话清单')
  assert.ok(textOf(scene.runtime.tree).includes('输入关键词检索，或从左侧选择分类'))
  scene.runtime.unmount()
})

await test('清空输入：effect 前这一帧直接回全部会话', async () => {
  const scene = await mountHistory()
  const input = byClass(scene.runtime.tree, 'dsh_tm_history_search')[0]
  change(input, '索引')
  input.props.onKeyDown({ key: 'Enter', preventDefault() {} })
  await scene.runtime.settle()
  await new Promise(resolve => setTimeout(resolve, 20))
  await scene.runtime.settle()
  assert.ok(byClass(scene.runtime.tree, 'dsh_tm_histrow').length > 0)
  change(byClass(scene.runtime.tree, 'dsh_tm_history_search')[0], '')
  scene.runtime.renderOnce()
  assert.equal(byClass(scene.runtime.tree, 'dsh_tm_histrow').length, 0)
  assert.equal(byClass(scene.runtime.tree, 'dsh_tm_histcatsession').length, 0)
  await scene.runtime.runEffects()
  await scene.runtime.settle()
  assert.ok(byClass(scene.runtime.tree, 'dsh_tm_histrow').length > 0, '清空后应重新检索全部轮次')
  scene.runtime.unmount()
})

await test('Esc 清空：effect 前这一帧直接回全部会话', async () => {
  const scene = await mountHistory()
  const input = byClass(scene.runtime.tree, 'dsh_tm_history_search')[0]
  change(input, '索引')
  input.props.onKeyDown({ key: 'Enter', preventDefault() {} })
  await scene.runtime.settle()
  await new Promise(resolve => setTimeout(resolve, 20))
  await scene.runtime.settle()
  assert.ok(byClass(scene.runtime.tree, 'dsh_tm_histrow').length > 0)
  byClass(scene.runtime.tree, 'dsh_tm_history_search')[0]
    .props.onKeyDown({ key: 'Escape', preventDefault() {} })
  scene.runtime.renderOnce()
  assert.equal(byClass(scene.runtime.tree, 'dsh_tm_histrow').length, 0)
  assert.equal(byClass(scene.runtime.tree, 'dsh_tm_histcatsession').length, 0)
  await scene.runtime.runEffects()
  await scene.runtime.settle()
  assert.ok(byClass(scene.runtime.tree, 'dsh_tm_histrow').length > 0, 'Esc 后应重新检索全部轮次')
  scene.runtime.unmount()
})

await test('切会话/工作区：categoryId 重置为「全部」，新请求不再带旧分类', async () => {
  const scene = await mountHistory()
  const pill = byClass(scene.runtime.tree, 'dsh_tm_histcatpill')
    .find(node => node.props['data-cat-id'] === 'c-reader')
  click(pill)
  await scene.runtime.settle()
  assert.equal(searchCalls(scene).at(-1).body.categoryId, 'c-reader')

  scene.runtime.props.sessionId = 's2'
  scene.runtime.renderOnce()
  await scene.runtime.runEffects()
  await scene.runtime.settle()
  const last = searchCalls(scene).at(-1)
  assert.equal(Object.prototype.hasOwnProperty.call(last.body, 'categoryId'), false, '旧分类不能带进新会话')
  const all = byClass(scene.runtime.tree, 'dsh_tm_histcatpill')
    .find(node => node.props['data-cat-id'] === '__all__')
  assert.equal(all.props['aria-pressed'], 'true')
  scene.runtime.unmount()
})

await test('时间线关闭：无切换控件、无 clue 节点；旧 localStorage timeline 仍走列表', async () => {
  assert.ok(src.includes('HISTORY_TIMELINE_ENABLED = false'))
  const scene = await mountHistory({ memory: { 'dsh.tm.history.view.ws-1': 'timeline' } })
  assert.equal(byData(scene.runtime.tree, 'data-view', 'timeline').length, 0)
  assert.equal(byData(scene.runtime.tree, 'data-view', 'list').length, 0)
  assert.equal(byClass(scene.runtime.tree, 'dsh_tm_cluerow').length, 0)
  assert.ok(byClass(scene.runtime.tree, 'dsh_tm_histrow').length > 0, '仍按列表渲染')
  scene.runtime.unmount()
})

await test('pageSize 按工作区读取：15 条/页即时改变行数与页数', async () => {
  const scene = await mountHistory({ memory: { 'dsh.tm.history.pageSize.ws-1': '15' } })
  assert.equal(byClass(scene.runtime.tree, 'dsh_tm_histrow').length, 15)
  assert.equal(textOf(byClass(scene.runtime.tree, 'dsh_tm_histpagenum')[0]), '第 1 / 2 页')
  scene.runtime.unmount()
})

await test('分页：第 1/2/3 页、最后一页禁用下一页，offset 正确', async () => {
  const scene = await mountHistory()
  const pageLabel = () => textOf(byClass(scene.runtime.tree, 'dsh_tm_histpagenum')[0])
  assert.equal(pageLabel(), '第 1 / 3 页')
  const next = () => byData(scene.runtime.tree, 'data-action', 'page-next')[0]
  click(next())
  await scene.runtime.settle()
  assert.equal(pageLabel(), '第 2 / 3 页')
  assert.equal(searchCalls(scene).at(-1).body.offset, 10)
  assert.equal(byClass(scene.runtime.tree, 'dsh_tm_histrow').length, 10)
  click(next())
  await scene.runtime.settle()
  assert.equal(pageLabel(), '第 3 / 3 页')
  assert.equal(searchCalls(scene).at(-1).body.offset, 20)
  assert.equal(byClass(scene.runtime.tree, 'dsh_tm_histrow').length, 5)
  assert.equal(next().props.disabled, true, '最后一页禁用下一页')
  scene.runtime.unmount()
})

await test('切分类重置页码到 1，底栏与结果区是兄弟结构', async () => {
  const scene = await mountHistory()
  click(byData(scene.runtime.tree, 'data-action', 'page-next')[0])
  await scene.runtime.settle()
  const pill = byClass(scene.runtime.tree, 'dsh_tm_histcatpill')
    .find(node => node.props['data-cat-id'] === 'c-reader')
  click(pill)
  await scene.runtime.settle()
  assert.equal(textOf(byClass(scene.runtime.tree, 'dsh_tm_histpagenum')[0]), '第 1 / 1 页')
  const footer = byData(scene.runtime.tree, 'data-footer', 'pager')[0]
  assert.ok(footer !== undefined)
  assert.ok(src.includes("h('div', { className: 'dsh_tm_histbody'"))
  assert.ok(src.includes("h('div', { className: 'dsh_tm_histfoot', 'data-footer': 'pager' }"))
  scene.runtime.unmount()
})

function fireDoc(scene, type, event) {
  const list = scene.docListeners[type] || []
  for (const fn of list) fn({ preventDefault() {}, stopPropagation() {}, ...event })
}

await test('点击行选中：同一时刻只一行，外部点击/Esc/翻页清空', async () => {
  const scene = await mountHistory()
  const rows = () => byClass(scene.runtime.tree, 'dsh_tm_histrow')
  click(rows()[0])
  await scene.runtime.settle()
  assert.equal(rows()[0].props['data-selected'], '1')
  assert.ok(String(rows()[0].props.className).includes('dsh_tm_histrow_selected'))
  click(rows()[1])
  await scene.runtime.settle()
  assert.equal(rows()[0].props['data-selected'], undefined)
  assert.equal(rows()[1].props['data-selected'], '1')

  fireDoc(scene, 'pointerdown', { target: { closest: () => null } })
  await scene.runtime.settle()
  assert.equal(rows().filter(row => row.props['data-selected'] === '1').length, 0)

  click(rows()[0])
  await scene.runtime.settle()
  fireDoc(scene, 'pointerdown', { target: { closest: selector => selector === '.dsh_tm_histrowwrap' ? {} : null } })
  await scene.runtime.settle()
  assert.equal(rows()[0].props['data-selected'], '1', '行内按钮不取消选中')

  fireDoc(scene, 'keydown', { key: 'Escape' })
  await scene.runtime.settle()
  assert.equal(rows().filter(row => row.props['data-selected'] === '1').length, 0)

  click(rows()[0])
  await scene.runtime.settle()
  click(byData(scene.runtime.tree, 'data-action', 'page-next')[0])
  await scene.runtime.settle()
  assert.equal(byClass(scene.runtime.tree, 'dsh_tm_histrow').filter(row => row.props['data-selected'] === '1').length, 0)
  scene.runtime.unmount()
})

await test('Tab 聚焦行即选中；Esc 清选中不清搜索词', async () => {
  const scene = await mountHistory()
  const input = byClass(scene.runtime.tree, 'dsh_tm_history_search')[0]
  change(input, '索引')
  input.props.onKeyDown({ key: 'Enter', preventDefault() {} })
  await scene.runtime.settle()
  await new Promise(resolve => setTimeout(resolve, 20))
  await scene.runtime.settle()
  const row = byClass(scene.runtime.tree, 'dsh_tm_histrow')[0]
  row.props.onFocus({})
  await scene.runtime.settle()
  assert.equal(byClass(scene.runtime.tree, 'dsh_tm_histrow')[0].props['data-selected'], '1')
  const inputAfterFocus = byClass(scene.runtime.tree, 'dsh_tm_history_search')[0]
  inputAfterFocus.props.onKeyDown({ key: 'ArrowDown', preventDefault() {} })
  await scene.runtime.settle()
  assert.equal(byClass(scene.runtime.tree, 'dsh_tm_histrow')[1].props['data-selected'], '1', '方向键移动选中')
  fireDoc(scene, 'keydown', { key: 'Escape' })
  await scene.runtime.settle()
  assert.equal(byClass(scene.runtime.tree, 'dsh_tm_histrow').filter(row => row.props['data-selected'] === '1').length, 0)
  assert.equal(byClass(scene.runtime.tree, 'dsh_tm_history_search')[0].props.value, '索引', 'Esc 只清选中')
  scene.runtime.unmount()
})

finish()