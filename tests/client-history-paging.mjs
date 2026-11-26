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

const ALL_PLAN = { idle: false, keywords: '', categoryId: '', prefix: { active: false, candidates: [] } }
const OLD_CATEGORY = {
  status: 'ready', query: '索引', categoryId: 'c-reader',
  hits: [{ sessionId: 's1', turn: 3 }], total: 1,
}

await test('闪烁守卫：结果模式与计划不一致时立即引导，不画旧行', () => {
  assert.equal(idleGuide(OLD_CATEGORY, ALL_PLAN), true)
  assert.equal(idleGuide({ status: 'idle' }, ALL_PLAN), true)
})

await test('全部/分类的新结果与计划一致后不再引导', () => {
  assert.equal(idleGuide({ status: 'loading', query: '', categoryId: '' }, ALL_PLAN), false)
  assert.equal(idleGuide({ status: 'ready', query: '', categoryId: '' }, ALL_PLAN), false)
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

await test('请求：全部/分类都是空关键词 /search，offset/limit 与检索一致', () => {
  assert.ok(src.includes('offset: page * pageSize'))
  assert.ok(src.includes('limit: pageSize'))
  assert.ok(src.includes("if (filter !== '') body.categoryId = filter"))
  assert.equal(src.includes('body.sessionIds = boundSessionId'), false)
  assert.equal(src.includes("body.sort = 'time'"), false)
  assert.equal(src.includes('当前会话最近轮次'), false)
})

await test('分支顺序：idle → error → 时间线（开关关闭不可达）→ 检索行', () => {
  const start = src.indexOf('var bodyChildren = []')
  const end = src.indexOf('// 底部状态条', start)
  const body = src.slice(start, end)
  const idle = body.indexOf('historyIdleGuide')
  const error = body.indexOf("result.status === 'error'")
  const timeline = body.indexOf('HISTORY_TIMELINE_ENABLED && viewMode === HISTORY_TIMELINE_VIEW')
  const rows = body.indexOf('} else if (rows.length > 0)')
  assert.ok(idle >= 0 && error > idle && timeline > error && rows > timeline)
  assert.ok(src.includes('HISTORY_TIMELINE_ENABLED = false'))
  assert.equal(body.includes('categoryBrowse'), false)
  assert.equal(body.includes('histcatsession'), false)
})

await test('底部固定栏：列表与底栏兄弟节点，容器/结果区/底栏三段 flex 高度链', () => {
  assert.ok(src.includes("h('div', { className: 'dsh_tm_histbody'"))
  assert.ok(src.includes("h('div', { className: 'dsh_tm_histfoot', 'data-footer': 'pager' }"))
  assert.ok(src.includes('.dsh_tm_history{position:relative;display:flex;flex-direction:column;height:100%;min-height:0'))
  assert.ok(src.includes('.dsh_tm_histmain{flex:1 1 auto;min-height:0;display:flex;min-width:0}'))
  assert.ok(src.includes('.dsh_tm_histpane{flex:1 1 auto;min-width:0;min-height:0;display:flex;flex-direction:column}'))
  assert.ok(src.includes('.dsh_tm_histbody{flex:1 1 auto;min-height:0;overflow-y:auto}'))
  assert.ok(src.includes('.dsh_tm_histfoot{position:sticky;bottom:0;z-index:3;flex:0 0 auto'))
  assert.ok(src.includes('.dsh_tm_drawerbody .dsh_tm_history{height:100%;min-height:0}'))
  assert.ok(src.includes('.dsh_tm_drawerbody .dsh_tm_histbody{overflow-y:auto;flex:1 1 auto;min-height:0}'))
  assert.ok(src.includes("'data-action': 'page-prev'"))
  assert.ok(src.includes("'data-action': 'page-next'"))
  assert.ok(src.includes("'第 ' + (page + 1) + ' / ' + pageCount + ' 页'"))
  assert.ok(src.includes("'共 ' + pageTotal + ' 条"))
})

await test('切关键词/分类/清空都会回第 1 页并清选中', () => {
  const input = src.slice(src.indexOf("className: 'dsh_tm_history_search'"), src.indexOf("className: 'dsh_tm_history_search'") + 1200)
  assert.ok(input.includes('setPage(0)'))
  assert.ok(input.includes('setSelected(-1)'))
  assert.ok(src.includes("event.key === 'Escape'"))
  const choose = src.slice(src.indexOf('function chooseHistoryCategory'), src.indexOf('function chooseHistoryCategory') + 450)
  assert.ok(choose.includes('setPage(0)'))
  assert.ok(choose.includes('setSelected(-1)'))
  assert.equal(src.includes('switchHistoryView'), false, '时间线关闭后不再有视图切换')
})

await test('store 未就绪不重置分类；只有 store 已加载且确实缺失才回「全部」', () => {
  assert.ok(src.includes("categoryData.status !== undefined && categoryData.status !== 'ready'"))
  assert.ok(src.includes('!Array.isArray(categoryData.store.categories)'))
  const effect = src.slice(src.indexOf("// 分类被删除 / 改名后"), src.indexOf("// 分类被删除 / 改名后") + 700)
  assert.ok(effect.indexOf("status !== 'ready'") < effect.indexOf('categoryNameOf'))
})

await test('工作区名兜底：title → path 最后一段 → 空', () => {
  const name = new Function(`${extractFunction(src, 'workspaceDisplayName')};return workspaceDisplayName`)()
  assert.equal(name({ id: 'w', title: 'demo', path: '/x/other' }), 'demo')
  assert.equal(name({ id: 'w', path: '/a/b/demo' }), 'demo')
  assert.equal(name({ id: 'w' }), '')
  assert.equal(name(null), '')
})

await test('覆盖会话为 0 且有分类：专用空态文案', () => {
  const emptyText = new Function(
    'HISTORY_EMPTY_TEXT',
    `${extractFunction(src, 'historyEmptyText')};return historyEmptyText`,
  )('没有匹配的轮次')
  assert.equal(emptyText({ coverage: { sessions: 0 } }, 'c-reader'), '该分类下没有可检索的会话')
  assert.equal(emptyText({ coverage: { sessions: 2 } }, 'c-reader'), '没有匹配的轮次')
  assert.equal(emptyText({ coverage: { sessions: 0 } }, ''), '没有匹配的轮次')
})

await test('分页后不再出现「还有 N 条未显示」旧文案', () => {
  assert.equal(src.includes('条未显示'), false)
  assert.ok(src.includes("'共 ' + pageTotal + ' 条"))
})

await test('工作区缓存/预热/取消接口存在', () => {
  assert.ok(src.includes('var HISTORY_CACHE = new Map()'))
  assert.ok(src.includes('var HISTORY_CACHE_TTL_MS = 5 * 60 * 1000'))
  assert.ok(src.includes('requestTopicMap(\'workspace-warmup\''))
  assert.ok(src.includes('requestTopicMap(\'categories\', body, { signal: signal })'))
  assert.ok(src.includes('dsh_tm_histskel'))
})

await test('定位跳转：同会话不重置，跨会话保存选中/滚动并 rAF 恢复', () => {
  assert.ok(src.includes('var sameSession = String(hit.sessionId'))
  assert.ok(src.includes('HISTORY_JUMP_RESTORE = {'))
  assert.ok(src.includes("targetSession: hit.sessionId"))
  assert.ok(src.includes('selectedKey: savedKey'))
  assert.ok(src.includes('scrollTop: savedScroll'))
  assert.ok(src.includes('requestAnimationFrame(apply)'))
  assert.ok(src.includes('body.scrollTop = top'))
})

finish()
