/**
 * 历史页：默认最近轮次、分类会话列表、分页、固定底栏与 idle 闪烁守卫。
 *
 * HistoryTabBody 依赖过多，完整挂载放在客户端集成测试里；这里直接执行
 * 从真实组件抽出的判定函数，并锁住分页/分支/底栏源码结构。
 */

import { strict as assert } from 'node:assert'
import {
  readClient,
  extractFunction,
  makeRunner,
} from './client-harness.mjs'

const src = readClient()
const { test, finish } = makeRunner('client-history-paging')

const idleGuide = new Function(
  `${extractFunction(src, 'historyIdleGuide')};return historyIdleGuide`,
)()
const pageCount = new Function(
  `${extractFunction(src, 'historyPageCount')};return historyPageCount`,
)()
const readPageSize = new Function(
  'HISTORY_PAGE_SIZE_DEFAULT', 'HISTORY_PAGE_SIZE_OPTIONS', 'HISTORY_PAGE_SIZE_PREFIX', 'localStorage',
  `${extractFunction(src, 'historyPageSizeKey')};${extractFunction(src, 'readHistoryPageSize')};return readHistoryPageSize`,
)
const savePageSize = new Function(
  'HISTORY_PAGE_SIZE_DEFAULT', 'HISTORY_PAGE_SIZE_OPTIONS', 'HISTORY_PAGE_SIZE_PREFIX', 'localStorage',
  `${extractFunction(src, 'historyPageSizeKey')};${extractFunction(src, 'saveHistoryPageSize')};return saveHistoryPageSize`,
)

const IDLE_PLAN = { idle: true, keywords: '', categoryId: '', prefix: { active: false, candidates: [] } }
const OLD_READY = { status: 'ready', recent: false, hits: [{ sessionId: 's1', turn: 3 }], total: 1 }

await test('闪烁守卫：plan.idle + 旧分类结果 → 立即引导，不画旧行', () => {
  assert.equal(idleGuide(OLD_READY, IDLE_PLAN, false), true)
  assert.equal(idleGuide({ status: 'idle' }, IDLE_PLAN, false), true)
})

await test('默认最近轮次 / 分类浏览不被 idle 守卫误伤', () => {
  assert.equal(idleGuide({ status: 'ready', recent: true, hits: [] }, IDLE_PLAN, false), false)
  assert.equal(idleGuide({ status: 'idle' }, { idle: false }, true), false, '分类浏览有自己的列表')
})

await test('分页页数：0 条也至少 1 页，137/10 = 14 页', () => {
  assert.equal(pageCount(0, 10), 1)
  assert.equal(pageCount(10, 10), 1)
  assert.equal(pageCount(11, 10), 2)
  assert.equal(pageCount(137, 10), 14)
  assert.equal(pageCount(137, 15), 10)
  assert.equal(pageCount(137, 20), 7)
})

await test('pageSize 按工作区记忆：只接受 10/15/20，坏值回 10', () => {
  const memory = new Map()
  const storage = {
    getItem(key) { return memory.has(key) ? memory.get(key) : null },
    setItem(key, value) { memory.set(key, String(value)) },
  }
  const read = readPageSize(10, [10, 15, 20], 'dsh.tm.history.pageSize.', storage)
  const save = savePageSize(10, [10, 15, 20], 'dsh.tm.history.pageSize.', storage)
  assert.equal(read('ws-1'), 10)
  assert.equal(save('ws-1', 15), 15)
  assert.equal(read('ws-1'), 15)
  assert.equal(read('ws-2'), 10, '按工作区隔离')
  assert.equal(save('ws-2', 99), 10, '非法值回落默认')
})

await test('请求：列表模式带 offset/limit；默认视图带 sessionIds + sort=time', () => {
  assert.ok(src.includes('offset: page * pageSize'))
  assert.ok(src.includes('limit: pageSize'))
  assert.ok(src.includes("body.sort = 'time'"))
  assert.ok(src.includes('body.sessionIds = boundSessionId'))
  assert.ok(src.includes("startHistorySearch(plan, { recent: true, clear: true })"))
  assert.ok(src.includes("当前会话最近轮次"))
})

await test('分支顺序：idle → error → 分类会话列表 → 时间线 → 检索行', () => {
  const start = src.indexOf('var bodyChildren = []')
  const end = src.indexOf('// 底部状态条', start)
  const body = src.slice(start, end)
  const idle = body.indexOf('historyIdleGuide')
  const error = body.indexOf("result.status === 'error'")
  const category = body.indexOf('} else if (categoryBrowse)')
  const timeline = body.indexOf('viewMode === HISTORY_TIMELINE_VIEW')
  const rows = body.indexOf('} else if (rows.length > 0)')
  assert.ok(idle >= 0 && error > idle && category > error && timeline > category && rows > timeline)
})

await test('底部固定栏：列表与底栏兄弟节点，底栏 sticky + flex:none，分页在右侧', () => {
  assert.ok(src.includes("h('div', { className: 'dsh_tm_histbody'"))
  assert.ok(src.includes("h('div', { className: 'dsh_tm_histfoot', 'data-footer': 'pager' }"))
  assert.ok(src.includes('position:sticky;bottom:0'))
  assert.ok(src.includes('.dsh_tm_histbody{flex:1 1 auto;min-height:0;overflow:auto}'))
  assert.ok(src.includes("'data-action': 'page-prev'"))
  assert.ok(src.includes("'data-action': 'page-next'"))
  assert.ok(src.includes("'第 ' + (page + 1) + ' / ' + pageCount + ' 页'"))
  assert.ok(src.includes("'该分类 ' + pageTotal + ' 个会话'"))
  assert.ok(src.includes("'共 ' + pageTotal + ' 条"))
})

await test('切关键词/分类/视图/清空都会回第 1 页', () => {
  assert.ok(src.includes("setPage(0)\n                      setQuery(next)"))
  assert.ok(src.includes("event.key === 'Escape'"))
  const esc = src.slice(src.indexOf("event.key === 'Escape'"), src.indexOf("event.key === 'Escape'") + 180)
  assert.ok(esc.includes('setPage(0)'))
  const choose = src.slice(src.indexOf('function chooseHistoryCategory'), src.indexOf('function chooseHistoryCategory') + 400)
  assert.ok(choose.includes('setPage(0)'))
  const view = src.slice(src.indexOf('function switchHistoryView'), src.indexOf('function switchHistoryView') + 300)
  assert.ok(view.includes('setPage(0)'))
})

finish()
