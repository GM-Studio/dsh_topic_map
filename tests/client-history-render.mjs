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
  categories: [{ id: 'c-reader', name: '阅读器', parentId: null }],
  assignments: { s1: { categoryId: 'c-reader', source: 'user' } },
}
const SESSIONS = [{ sessionId: 's1', title: '会话 A', turns: 25, lastActive: 1700000000000 }]

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

await test('默认视图 = 当前会话最近轮次（空关键词 + sessionIds + sort=time）', async () => {
  const scene = await mountHistory()
  const head = byClass(scene.runtime.tree, 'dsh_tm_histrecenthead')
  assert.equal(textOf(head[0]), '当前会话最近轮次')
  const rows = byClass(scene.runtime.tree, 'dsh_tm_histrow')
  assert.equal(rows.length, 10, '默认每页 10 条')
  const request = searchCalls(scene)[0]
  assert.deepEqual(request.body.sessionIds, ['s1'])
  assert.equal(request.body.sort, 'time')
  assert.equal(request.body.keywords, '')
  const diag = scene.diag()
  assert.equal(diag.branch, 'default-recent')
  assert.equal(diag.plan.idle, true)
  assert.equal(diag.result.hits, 10)
  assert.equal(diag.result.total, 25)
  scene.runtime.unmount()
})

await test('闪烁：分类结果 → 点全部，在 effect 前 renderOnce 已无旧行', async () => {
  const scene = await mountHistory()
  // 先得到分类结果；再把输入改成纯前缀但不跑 effect，模拟“点全部”前的旧结果。
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
  // 关键：不 settle、不跑 effect，手动 commit 这一帧。
  scene.runtime.renderOnce()
  assert.equal(byClass(scene.runtime.tree, 'dsh_tm_histrow').length, 0, '不能画一帧旧分类行')
  assert.ok(textOf(scene.runtime.tree).includes('输入关键词检索，或从左侧选择分类'))
  scene.runtime.unmount()
})

await test('清空输入：effect 前这一帧也不画旧结果', async () => {
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
  assert.ok(textOf(scene.runtime.tree).includes('输入关键词检索，或从左侧选择分类'))
  scene.runtime.unmount()
})

await test('Esc 清空：effect 前这一帧也不画旧结果', async () => {
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
  assert.ok(textOf(scene.runtime.tree).includes('输入关键词检索，或从左侧选择分类'))
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
  assert.equal(byClass(scene.runtime.tree, 'dsh_tm_histrow').length, 15)
  assert.equal(textOf(byClass(scene.runtime.tree, 'dsh_tm_histpagenum')[0]), '第 1 / 2 页')
  scene.runtime.unmount()
})

await test('分页：第 1/2 页、最后一页禁用下一页，请求 offset 正确', async () => {
  const scene = await mountHistory()
  const pageLabel = () => textOf(byClass(scene.runtime.tree, 'dsh_tm_histpagenum')[0])
  assert.equal(pageLabel(), '第 1 / 3 页')
  const next = () => byData(scene.runtime.tree, 'data-action', 'page-next')[0]
  click(next())
  await scene.runtime.settle()
  assert.equal(pageLabel(), '第 2 / 3 页')
  assert.equal(searchCalls(scene).at(-1).body.offset, 10)
  click(next())
  await scene.runtime.settle()
  assert.equal(pageLabel(), '第 3 / 3 页')
  assert.equal(searchCalls(scene).at(-1).body.offset, 20)
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
