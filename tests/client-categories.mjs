/**
 * 分类 tab：树渲染与计数、归类请求参数、整理后的撤销、失败显示 Host 中文错误。
 *
 * 用 tests/client-harness.mjs 的微型 hooks 运行时**原样渲染** lib/client.js 里的
 * CategoriesTabBody；所有请求走假 fetch，验证发出去的 body 与真实端点契约一致。
 */

import { strict as assert } from 'node:assert'
import * as HITVIEW from '../lib/hit-view.js'
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

function constant(name, quote = "'") {
  const escaped = quote === "'" ? "([^']*)" : '([^"]*)'
  const found = src.match(new RegExp(`var ${name} = ${quote}${escaped}${quote}`))
  if (found === null) throw new Error(`client.js 里找不到常量 ${name}`)
  return found[1]
}

const ROOT_ID = constant('CATEGORY_ROOT_ID')
const ROOT_NAME = constant('CATEGORY_ROOT_NAME')
const UNDO_MS = Number((src.match(/var CATEGORY_UNDO_MS = (\d+)/) || [])[1] || 3000)

const { test, finish } = makeRunner('client-categories')

const NOW = Date.now()
const SESSIONS = [
  { sessionId: 's1', title: '会话 A', turns: 4, lastActive: NOW - 60 * 60 * 1000 },
  { sessionId: 's2', title: '会话 B', turns: 2, lastActive: NOW - 2 * 60 * 60 * 1000 },
  { sessionId: 's3', title: '会话 C', turns: 7, lastActive: NOW - 3 * 60 * 60 * 1000 },
  { sessionId: 's4', title: '会话 D', turns: 1, createdAt: NOW - 24 * 60 * 60 * 1000 },
  { sessionId: 's5', title: '会话 E', turns: 3, lastActive: NOW - 30 * 60 * 1000 },
]

function fixtureStore() {
  return {
    version: 1,
    categories: [
      { id: 'c-a', name: '插件开发', parentId: null, source: 'user' },
      { id: 'c-b', name: '界面', parentId: 'c-a', source: 'user' },
      { id: 'c-c', name: '测试', parentId: null, source: 'user' },
    ],
    assignments: {
      s1: { categoryId: 'c-a', source: 'user' },
      s2: { categoryId: 'c-b', source: 'user' },
      s3: { categoryId: 'c-a', source: 'user' },
      s4: { categoryId: 'c-c', source: 'user' },
    },
  }
}

const COMPONENT_SOURCE = [
  extractFunction(src, 'unrefTimer'),
  extractFunction(src, 'categoryStoreOf'),
  extractFunction(src, 'categoryIdOfAssignment'),
  extractFunction(src, 'categoryAssignmentsOf'),
  extractFunction(src, 'categoryNameOf'),
  extractFunction(src, 'categoryTreeNodes'),
  extractFunction(src, 'categoryFlatOptions'),
  extractFunction(src, 'sessionTimeInfoOf'),
  extractFunction(src, 'categorySessionMetaText'),
  extractFunction(src, 'categorySessionRows'),
  extractFunction(src, 'categoryBodyOf'),
  extractFunction(src, 'categorySaveBody'),
  extractFunction(src, 'categoryAssignBody'),
  extractFunction(src, 'categoryOrganizeBody'),
  extractFunction(src, 'categoryUndoBody'),
  extractFunction(src, 'categoryMergeOp'),
  extractFunction(src, 'categoryErrorText'),
  extractFunction(src, 'requestTopicMap'),
  extractFunction(src, 'resolveWorkspaceIdForSession'),
  extractFunction(src, 'currentWorkspaceId'),
  extractFunction(src, 'RightTabStrip'),
  extractFunction(src, 'CategoriesTabBody'),
].join('\n')

const ERROR_TEXT = error => String(error && error.message ? error.message : error)

function makeHandler(options = {}) {
  let store = fixtureStore()
  const handler = ({ action, body }) => {
    if (action === 'workspaces') {
      return { value: [{ id: 'ws-1', title: '工作区', sessionIds: ['s1', 's2', 's3', 's4', 's5'] }] }
    }
    if (action === 'categories') {
      if (options.categoriesError !== undefined) {
        return { status: 502, ok: false, error: options.categoriesError }
      }
      return { value: { store: store, tree: [] } }
    }
    if (action === 'sessions') {
      if (options.sessionsError !== undefined) {
        return { status: 502, ok: false, error: options.sessionsError }
      }
      return { value: { workspace: { id: 'ws-1' }, sessions: SESSIONS, total: SESSIONS.length, hidden: 0 } }
    }
    if (action === 'category-save') {
      if (options.saveError !== undefined) {
        return { status: 400, ok: false, error: options.saveError }
      }
      if (typeof body.id === 'string' && body.id !== '') {
        store.categories = store.categories.map(category => category.id === body.id
          ? Object.assign({}, category, { name: body.name })
          : category)
      } else {
        store.categories.push({
          id: 'c-new-' + (store.categories.length + 1),
          name: body.name,
          parentId: body.parentId === undefined ? null : body.parentId,
          source: 'user',
        })
      }
      return { value: { store: store, tree: [], id: 'c-new' } }
    }
    if (action === 'category-assign') {
      store.assignments = Object.assign({}, store.assignments)
      if (body.categoryId === null) delete store.assignments[body.sessionId]
      else store.assignments[body.sessionId] = { categoryId: body.categoryId, source: 'user' }
      return { value: { store: store, tree: [] } }
    }
    if (action === 'category-organize') {
      return {
        value: {
          store: store,
          undo: { kind: 'plan', action: body.op && body.op.kind, summary: '合并 插件开发、测试 → 测试' },
        },
      }
    }
    if (action === 'category-undo') {
      return { value: { store: store, tree: [] } }
    }
    return { ok: false, error: 'unexpected ' + action }
  }
  return handler
}

async function mountCategories(handler) {
  const fake = makeFetch(handler)
  const opened = []
  const runtime = await renderComponent(
    COMPONENT_SOURCE,
    'CategoriesTabBody',
    [
      'HITVIEW', 'RIGHT_TABS', 'CATEGORIES_KIND', 'CATEGORIES_TITLE',
      'CATEGORY_ROOT_ID', 'CATEGORY_ROOT_NAME', 'CATEGORY_UNDO_MS',
      'fetch', 'errorText', 'useTopicMapTheme', 'openWorkspaceSession',
    ],
    [
      HITVIEW, RIGHT_TABS, 'topic-map-categories', '分类',
      ROOT_ID, ROOT_NAME, UNDO_MS,
      fake.fetch, ERROR_TEXT,
      function () {},
      function (sessionId) { opened.push(sessionId); return { ok: true } },
    ],
    { sessionId: 's1', openTab: function () {} },
  )
  return { runtime: runtime, tree: runtime.tree, calls: fake.calls, opened: opened }
}

function nodeRow(tree, catId) {
  return findAll(tree, node =>
    String(node.props.className || '').split(/\s+/).includes('dsh_tm_catnode')
    && node.props['data-cat-id'] === catId)[0]
}

function nodeCount(tree, catId) {
  const row = nodeRow(tree, catId)
  if (row === undefined) return ''
  return textOf(byClass(row, 'dsh_tm_catnodecount')[0])
}

function dialogOf(tree) {
  return byClass(tree, 'dsh_tm_catdialog')[0]
}

function inDialog(tree, predicate) {
  const dialog = dialogOf(tree)
  return dialog === undefined ? undefined : findAll(dialog, predicate)[0]
}

await test('树渲染：根「未归类」+ 大类/子类，节点显示名称与会话数', async () => {
  const { tree } = await mountCategories(makeHandler())
  assert.equal(byClass(tree, 'dsh_tm_catnode').length, 4, '根 + 3 个分类节点')
  assert.equal(nodeRow(tree, ROOT_ID).props['data-depth'], '0')
  assert.ok(textOf(nodeRow(tree, ROOT_ID)).includes(ROOT_NAME))
  assert.equal(nodeCount(tree, ROOT_ID), '1', 's5 未归类')
  assert.equal(nodeCount(tree, 'c-a'), '2', 's1/s3 直接归到大类')
  assert.equal(nodeCount(tree, 'c-b'), '1', 's2 归到子类')
  assert.equal(nodeCount(tree, 'c-c'), '1')
  assert.equal(nodeRow(tree, 'c-b').props['data-depth'], '1', '子类缩进/深度为 1')
  assert.equal(byClass(tree, 'dsh_tm_catnode_on').length, 1)
  assert.ok(textOf(byClass(tree, 'dsh_tm_catlisthead')[0]).includes(ROOT_NAME))
})

await test('点节点 → 右侧列表：标题 / 轮数 / 最后活动；未归类只列未归类会话', async () => {
  const { runtime, tree } = await mountCategories(makeHandler())
  click(nodeRow(tree, 'c-a'))
  await runtime.settle()
  const rows = byClass(runtime.tree, 'dsh_tm_catrow')
  assert.deepEqual(byClass(runtime.tree, 'dsh_tm_catrowtitle').map(textOf), ['会话 A', '会话 C'])
  assert.equal(rows.length, 2)
  const meta = byClass(runtime.tree, 'dsh_tm_catrowmeta').map(textOf)
  assert.equal(meta[0], '4 轮 · 最后活动 1 小时前')
  assert.equal(meta[1], '7 轮 · 最后活动 3 小时前')

  click(nodeRow(runtime.tree, ROOT_ID))
  await runtime.settle()
  assert.deepEqual(byClass(runtime.tree, 'dsh_tm_catrowtitle').map(textOf), ['会话 E'])
  assert.equal(textOf(byClass(runtime.tree, 'dsh_tm_catrowmeta')[0]), '3 轮 · 最后活动 30 分钟前')
})

await test('点会话 → uiWorkspace.openSession；成功后给可见提示', async () => {
  const { runtime, opened } = await mountCategories(makeHandler())
  click(nodeRow(runtime.tree, 'c-a'))
  await runtime.settle()
  const main = findAll(runtime.tree, node =>
    String(node.props.className || '').split(/\s+/).includes('dsh_tm_catrowmain')
    && node.props['data-session-id'] === 's1')[0]
  click(main)
  await runtime.settle()
  assert.deepEqual(opened, ['s1'])
  assert.ok(textOf(byClass(runtime.tree, 'dsh_tm_catnotice')[0]).includes('已打开会话'))
})

await test('新建大类：POST /category-save {workspaceId, name}', async () => {
  const { runtime, tree, calls } = await mountCategories(makeHandler())
  click(findAll(tree, node => node.props['data-action'] === 'new-root')[0])
  await runtime.settle()
  const input = inDialog(runtime.tree, node => node.type === 'input')
  assert.ok(input !== undefined, '必须出现名称输入框')
  change(input, '  新分类  ')
  await runtime.settle()
  click(inDialog(runtime.tree, node => node.props['data-action'] === 'dialog-ok'))
  await runtime.settle()
  const saved = calls.filter(call => call.action === 'category-save')
  assert.equal(saved.length, 1)
  assert.deepEqual(saved[0].body, { workspaceId: 'ws-1', name: '新分类' })
  assert.equal(dialogOf(runtime.tree), undefined, '成功后对话框收起')
  assert.ok(textOf(byClass(runtime.tree, 'dsh_tm_catnotice')[0]).includes('已新建大类'))
})

await test('重命名与新建子类：id / parentId 参数正确', async () => {
  const { runtime, calls } = await mountCategories(makeHandler())
  click(findAll(runtime.tree, node => node.props['data-action'] === 'node-menu'
    && node.props['data-cat-id'] === 'c-a')[0])
  await runtime.settle()
  click(findAll(runtime.tree, node => node.props['data-action'] === 'rename')[0])
  await runtime.settle()
  change(inDialog(runtime.tree, node => node.type === 'input'), '插件开发 2')
  await runtime.settle()
  click(inDialog(runtime.tree, node => node.props['data-action'] === 'dialog-ok'))
  await runtime.settle()
  let saves = calls.filter(call => call.action === 'category-save')
  assert.deepEqual(saves[saves.length - 1].body, { workspaceId: 'ws-1', id: 'c-a', name: '插件开发 2' })

  click(findAll(runtime.tree, node => node.props['data-action'] === 'node-menu'
    && node.props['data-cat-id'] === 'c-a')[0])
  await runtime.settle()
  click(findAll(runtime.tree, node => node.props['data-action'] === 'new-child')[0])
  await runtime.settle()
  change(inDialog(runtime.tree, node => node.type === 'input'), '子类')
  await runtime.settle()
  click(inDialog(runtime.tree, node => node.props['data-action'] === 'dialog-ok'))
  await runtime.settle()
  saves = calls.filter(call => call.action === 'category-save')
  assert.deepEqual(saves[saves.length - 1].body,
    { workspaceId: 'ws-1', name: '子类', parentId: 'c-a' })
})

await test('会话行「移到分类…」：POST /category-assign {workspaceId, sessionId, categoryId}', async () => {
  const { runtime, calls } = await mountCategories(makeHandler())
  click(nodeRow(runtime.tree, 'c-a'))
  await runtime.settle()
  click(findAll(runtime.tree, node => node.props['data-action'] === 'row-menu'
    && node.props['data-session-id'] === 's1')[0])
  await runtime.settle()
  click(findAll(runtime.tree, node => node.props['data-action'] === 'move-session')[0])
  await runtime.settle()
  const picker = inDialog(runtime.tree, node =>
    String(node.props.className || '').split(/\s+/).includes('dsh_tm_catpick')
    && node.props['data-cat-id'] === 'c-b')
  assert.ok(picker !== undefined, '分类选择器必须列出可选分类')
  click(picker)
  await runtime.settle()
  const assigned = calls.filter(call => call.action === 'category-assign')
  assert.equal(assigned.length, 1)
  assert.deepEqual(assigned[0].body, { workspaceId: 'ws-1', sessionId: 's1', categoryId: 'c-b' })
})

await test('删除走 /category-organize {kind:delete,id}（不使用原生 confirm）', async () => {
  const { runtime, tree, calls } = await mountCategories(makeHandler())
  click(findAll(tree, node => node.props['data-action'] === 'node-menu'
    && node.props['data-cat-id'] === 'c-c')[0])
  await runtime.settle()
  click(findAll(runtime.tree, node => node.props['data-action'] === 'delete')[0])
  await runtime.settle()
  assert.ok(textOf(dialogOf(runtime.tree)).includes('删除「测试」后'))
  click(inDialog(runtime.tree, node => node.props['data-action'] === 'dialog-ok'))
  await runtime.settle()
  const organized = calls.filter(call => call.action === 'category-organize')
  assert.equal(organized.length, 1)
  assert.deepEqual(organized[0].body, { workspaceId: 'ws-1', op: { kind: 'delete', id: 'c-c' } })
  assert.equal(/window\.(confirm|alert)\(/.test(src), false, '不允许原生弹窗')
})

await test('合并：目标在前（Host targetId=ids[0]），成功后出现撤销按钮并可撤销', async () => {
  const { runtime, calls } = await mountCategories(makeHandler())
  click(findAll(runtime.tree, node => node.props['data-action'] === 'node-menu'
    && node.props['data-cat-id'] === 'c-a')[0])
  await runtime.settle()
  click(findAll(runtime.tree, node => node.props['data-action'] === 'merge')[0])
  await runtime.settle()
  const target = inDialog(runtime.tree, node =>
    String(node.props.className || '').split(/\s+/).includes('dsh_tm_catpick')
    && node.props['data-cat-id'] === 'c-c')
  assert.ok(target !== undefined)
  click(target)
  await runtime.settle()
  const organized = calls.filter(call => call.action === 'category-organize')
  assert.equal(organized.length, 1)
  assert.deepEqual(organized[0].body, {
    workspaceId: 'ws-1',
    op: { kind: 'merge', ids: ['c-c', 'c-a'], name: '测试' },
  })
  const undoButton = findAll(runtime.tree, node => node.props['data-action'] === 'undo')[0]
  assert.ok(undoButton !== undefined, '每次整理后 3 秒内要有撤销按钮')
  assert.ok(textOf(byClass(runtime.tree, 'dsh_tm_catundo')[0]).includes('合并'))

  click(undoButton)
  await runtime.settle()
  const undone = calls.filter(call => call.action === 'category-undo')
  assert.equal(undone.length, 1)
  assert.deepEqual(undone[0].body, {
    workspaceId: 'ws-1',
    undo: { kind: 'plan', action: 'merge', summary: '合并 插件开发、测试 → 测试' },
  })
  assert.equal(findAll(runtime.tree, node => node.props['data-action'] === 'undo').length, 0,
    '撤销成功后按钮消失')
  assert.ok(textOf(byClass(runtime.tree, 'dsh_tm_catnotice')[0]).includes('已撤销整理'))
})

await test('失败：显示 Host 中文错误，对话框保留供修正', async () => {
  const { runtime, tree } = await mountCategories(makeHandler({ saveError: '分类文件损坏' }))
  click(findAll(tree, node => node.props['data-action'] === 'new-root')[0])
  await runtime.settle()
  change(inDialog(runtime.tree, node => node.type === 'input'), '新分类')
  await runtime.settle()
  click(inDialog(runtime.tree, node => node.props['data-action'] === 'dialog-ok'))
  await runtime.settle()
  const notice = byClass(runtime.tree, 'dsh_tm_catnotice')[0]
  assert.ok(notice !== undefined)
  assert.equal(textOf(notice), '保存分类失败：分类文件损坏')
  assert.ok(dialogOf(runtime.tree) !== undefined, '失败时不能把用户输入关掉')
})

await test('读分类失败：可读错误 + 重试，不白屏', async () => {
  const { runtime, tree } = await mountCategories(makeHandler({ categoriesError: '分类数据格式无法识别' }))
  const errorBox = byClass(tree, 'dsh_tm_caterr')[0]
  assert.ok(errorBox !== undefined)
  assert.ok(textOf(errorBox).includes('读取分类失败：分类数据格式无法识别'))
  const retry = findAll(tree, node =>
    String(node.props.className || '').split(/\s+/).includes('dsh_tm_catretry'))[0]
  assert.ok(retry !== undefined)
  click(retry)
  await runtime.settle()
  assert.ok(byClass(runtime.tree, 'dsh_tm_caterr').length >= 1, '持续失败仍显示同一错误')
})

finish()
