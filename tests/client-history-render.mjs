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
  const document = {
    documentElement: { setAttribute() {} },
    querySelector() { return null },
    querySelectorAll() { return [] },
    body: { appendChild() {} },
    addEventListener() {},
    removeEventListener() {},
  }
  const window = {
    innerWidth: 1400, innerHeight: 900,
    addEventListener() {}, removeEventListener() {},
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: id => clearTimeout(id),
  }
  const fake = makeFetch(({ action, body }) => {
    if (action === 'workspaces') return { value: [{ id: 'ws-1', title: '工作区', sessionIds: ['s1'] }] }
    if (action === 'categories') {
      return { value: { store: CATEGORY_STORE, tree: [], lockedSessions: {} } }
    }
    if (action === 'sessions') {
      return { value: { workspace: { id: 'ws-1' }, sessions: SESSIONS, total: SESSIONS.length } }
    }
    if (action === 'search') {
      const offset = Number(body.offset) || 0
      const limit = Number(body.limit) || 10
      const total = 25
      const hits = []
      for (let i = offset; i < Math.min(total, offset + limit); i += 1) hits.push(hit(i + 1))
      return {
        value: {
          hits, total, offset, hasMore: offset + hits.length < total,
          truncated: offset + hits.length < total, elapsedMs: 1,
          workspace: { id: 'ws-1', title: '工作区' }, indexed: { ready: 1, missing: 0 },
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
  return { runtime, fake, memory, diag: () => exported.__historyDiag() }
}

async function mountHistory(options) {
  const scene = setupRuntime(options)
  await scene.runtime.settle()
  return scene
}

function searchCalls(scene) {
  return scene.fake.calls.filter(call => call.action === 'search')
}

await test('初始「全部」：所有会话列表，不出现最近轮次，也不请求 /search', async () => {
  const scene = await mountHistory()
  assert.equal(byClass(scene.runtime.tree, 'dsh_tm_histrecenthead').length, 0)
  assert.equal(textOf(scene.runtime.tree).includes('当前会话最近轮次'), false)
  const rows = byClass(scene.runtime.tree, 'dsh_tm_histcatsession')
  assert.equal(rows.length, 10, '默认每页 10 条')
  assert.ok(textOf(scene.runtime.tree).includes('共 25 个会话'))
  assert.equal(searchCalls(scene).length, 0, '全部模式不该请求 /search')
  const diag = scene.diag()
  assert.equal(diag.branch, 'category-browse')
  assert.equal(diag.plan.idle, true)
  assert.equal(diag.browse.total, 25)
  scene.runtime.unmount()
})

await test('顶级胶囊包含孙类会话；「全部」恢复所有会话', async () => {
  const scene = await mountHistory()
  const pill = byClass(scene.runtime.tree, 'dsh_tm_histcatpill')
    .find(node => node.props['data-cat-id'] === 'c-reader')
  click(pill)
  await scene.runtime.settle()
  const one = byClass(scene.runtime.tree, 'dsh_tm_histcatsession')
  assert.equal(one.length, 1, '挂在孙类 c-grand 的会话要算到顶级 c-reader')
  assert.ok(textOf(one[0]).includes('会话 1'))
  const all = byClass(scene.runtime.tree, 'dsh_tm_histcatpill')
    .find(node => node.props['data-cat-id'] === '__all__')
  click(all)
  await scene.runtime.settle()
  assert.equal(byClass(scene.runtime.tree, 'dsh_tm_histcatsession').length, 10)
  assert.equal(scene.diag().browse.total, 25)
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
  assert.ok(byClass(scene.runtime.tree, 'dsh_tm_histcatsession').length > 0, '直接进入全部会话列表')
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
  assert.ok(byClass(scene.runtime.tree, 'dsh_tm_histcatsession').length > 0)
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
  assert.ok(byClass(scene.runtime.tree, 'dsh_tm_histcatsession').length > 0)
  scene.runtime.unmount()
})

await test('分类会话列表在时间线视图下仍可达，分页重置', async () => {
  const scene = await mountHistory()
  const pill = byClass(scene.runtime.tree, 'dsh_tm_histcatpill')
    .find(node => node.props['data-cat-id'] === 'c-reader')
  click(pill)
  await scene.runtime.settle()
  click(byData(scene.runtime.tree, 'data-view', 'timeline')[0])
  await scene.runtime.settle()
  assert.ok(byClass(scene.runtime.tree, 'dsh_tm_histcatsession').length > 0, '分类会话列表必须可见')
  assert.ok(textOf(scene.runtime.tree).includes('该分类 1 个会话'))
  assert.equal(scene.diag().branch, 'category-browse')
  assert.equal(scene.diag().browse.total, 1)
  scene.runtime.unmount()
})

await test('pageSize 按工作区读取：15 条/页即时改变行数与页数', async () => {
  const scene = await mountHistory({ memory: { 'dsh.tm.history.pageSize.ws-1': '15' } })
  assert.equal(byClass(scene.runtime.tree, 'dsh_tm_histcatsession').length, 15)
  assert.equal(textOf(byClass(scene.runtime.tree, 'dsh_tm_histpagenum')[0]), '第 1 / 2 页')
  scene.runtime.unmount()
})

await test('分页：第 1/2/3 页、最后一页禁用下一页，全部会话客户端分页', async () => {
  const scene = await mountHistory()
  const pageLabel = () => textOf(byClass(scene.runtime.tree, 'dsh_tm_histpagenum')[0])
  assert.equal(pageLabel(), '第 1 / 3 页')
  const next = () => byData(scene.runtime.tree, 'data-action', 'page-next')[0]
  click(next())
  await scene.runtime.settle()
  assert.equal(pageLabel(), '第 2 / 3 页')
  const secondPage = byClass(scene.runtime.tree, 'dsh_tm_histcatsession')
  assert.equal(secondPage.length, 10)
  assert.ok(textOf(secondPage[0]).includes('会话 11'), '第 2 页从第 11 条开始')
  assert.equal(searchCalls(scene).length, 0, '全部模式切换页码不请求 /search')
  click(next())
  await scene.runtime.settle()
  assert.equal(pageLabel(), '第 3 / 3 页')
  assert.equal(byClass(scene.runtime.tree, 'dsh_tm_histcatsession').length, 5)
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

finish()
