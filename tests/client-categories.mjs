/**
 * 分类胶囊：只读过滤、最多 5 个 + 更多、排序、选中过滤、人工 override。
 *
 * 旧的分类树编辑 UI 已删除；这里不再测试任何新建/改名/合并/整理/撤销。
 */

import { strict as assert } from 'node:assert'
import {
  readClient,
  extractFunction,
  renderComponent,
  makeFetch,
  makeRunner,
  byClass,
  findAll,
  textOf,
  click,
} from './client-harness.mjs'

const src = readClient()
const { test, finish } = makeRunner('client-categories')

function constant(name) {
  const found = src.match(new RegExp(`var ${name} = '([^']*)'`))
  if (found === null) throw new Error(`client.js 里找不到常量 ${name}`)
  return found[1]
}
const ALL_ID = constant('CATEGORY_ALL_ID')
const ALL_NAME = constant('CATEGORY_ALL_NAME')
const ROOT_ID = constant('CATEGORY_ROOT_ID')
const ROOT_NAME = constant('CATEGORY_ROOT_NAME')

const SESSIONS = [
  { sessionId: 's1', title: 'A', turns: 1, lastActive: 700000 },
  { sessionId: 's2', title: 'B', turns: 2, lastActive: 1500000 },
  { sessionId: 's3', title: 'C', turns: 2, lastActive: 1500000 },
  { sessionId: 's4', title: 'D', turns: 3, lastActive: 1500000 },
  { sessionId: 's5', title: 'E', turns: 2, lastActive: 2200000 },
  { sessionId: 's6', title: 'F', turns: 1, lastActive: 500000 },
  { sessionId: 's7', title: 'G', turns: 1, lastActive: 400000 },
  { sessionId: 's8', title: 'H', turns: 1, lastActive: 300000 },
  { sessionId: 's9', title: 'I', turns: 1, lastActive: 900000 },
]

function fixtureStore(options = {}) {
  const categories = [
    { id: 'c-zhaobiao', name: '招标', parentId: null },
    { id: 'c-reader', name: '阅读器', parentId: null },
    { id: 'c-map', name: '话题地图', parentId: null },
    { id: 'c-plugin', name: '插件', parentId: null },
    { id: 'c-test', name: '测试', parentId: null },
    { id: 'c-other', name: '其它', parentId: null },
    { id: 'c-reader-child', name: '阅读器子类', parentId: 'c-reader' },
  ]
  const assignments = {
    s1: { categoryId: 'c-zhaobiao', source: 'model' },
    s2: { categoryId: 'c-reader', source: 'user' },
    s3: { categoryId: 'c-reader', source: 'user' },
    s4: { categoryId: 'c-reader-child', source: 'model' },
    s5: { categoryId: 'c-map', source: 'model' },
    s6: { categoryId: 'c-plugin', source: 'model' },
    s7: { categoryId: 'c-test', source: 'model' },
    s8: { categoryId: 'c-other', source: 'model' },
  }
  if (options.noUnclassified === true) assignments.s9 = { categoryId: 'c-other', source: 'model' }
  return { version: 1, categories, assignments }
}

const COMPONENT_SOURCE = [
  extractFunction(src, 'categoryBodyOf'),
  extractFunction(src, 'categoryStoreOf'),
  extractFunction(src, 'categoryIdOfAssignment'),
  extractFunction(src, 'categoryAssignmentsOf'),
  extractFunction(src, 'categoryNameOf'),
  extractFunction(src, 'categoryTreeNodes'),
  extractFunction(src, 'categoryCapsuleModel'),
  extractFunction(src, 'categorySessionLocked'),
  extractFunction(src, 'categorySessionLockedBy'),
  extractFunction(src, 'categoryOverrideBody'),
  extractFunction(src, 'categoryErrorText'),
  extractFunction(src, 'categoryAutoText'),
  extractFunction(src, 'categoryAutoNoModel'),
  extractFunction(src, 'categoryAutoUnclassified'),
  extractFunction(src, 'historyCacheGet'),
  extractFunction(src, 'historyCacheEnsure'),
  extractFunction(src, 'historyCachePutCategories'),
  extractFunction(src, 'historyWarmup'),
  extractFunction(src, 'CategoryAutoStatus'),
  extractFunction(src, 'sessionTimeInfoOf'),
  extractFunction(src, 'requestTopicMap'),
  extractFunction(src, 'resolveWorkspaceIdForSession'),
  extractFunction(src, 'currentWorkspaceId'),
  extractFunction(src, 'CategoriesTabBody'),
].join('\n')

async function mount(options = {}) {
  const store = options.store === undefined ? fixtureStore() : options.store
  const fake = makeFetch(({ action }) => {
    if (action === 'workspaces') return { value: [{ id: 'ws-1', sessionIds: SESSIONS.map(s => s.sessionId) }] }
    if (action === 'categories') return { value: { store, tree: [], lockedSessions: options.lockedSessions || {} } }
    if (action === 'sessions') return { value: { workspace: { id: 'ws-1' }, sessions: SESSIONS, total: SESSIONS.length } }
    if (action === 'category-auto-start') return { value: { unclassified: SESSIONS.length } }
    if (action === 'category-auto-status') {
      if (options.autoStatus === 'no-model') return { value: { status: 'no-model' } }
      return { value: { unclassified: options.autoUnclassified === undefined ? 12 : options.autoUnclassified } }
    }
    return { ok: false, error: 'unexpected ' + action }
  })
  const selected = []
  const data = []
  const runtime = await renderComponent(
    COMPONENT_SOURCE,
    'CategoriesTabBody',
    [
      'CATEGORY_ALL_ID', 'CATEGORY_ALL_NAME', 'CATEGORY_ROOT_ID', 'CATEGORY_ROOT_NAME',
      'CATEGORY_AUTO_POLL_MS', 'CATEGORY_AUTO_POLL_MAX',
      'HISTORY_CACHE', 'HISTORY_CACHE_TTL_MS', 'HISTORY_WARMED',
      'fetch', 'errorText', 'useTopicMapTheme', 'currentWorkspaceId',
    ],
    [
      ALL_ID, ALL_NAME, ROOT_ID, ROOT_NAME,
      30000, 4,
      new Map(), 300000, {},
      fake.fetch, error => String(error && error.message ? error.message : error),
      function () {}, () => Promise.resolve('ws-1'),
    ],
    {
      embedded: true,
      sessionId: 's1',
      selectedCategory: options.selectedCategory === undefined ? '' : options.selectedCategory,
      onSelect: value => selected.push(value),
      onData: value => data.push(value),
    },
  )
  return { runtime, tree: runtime.tree, fake, selected, data }
}

const pillNodes = tree => byClass(tree, 'dsh_tm_histcatpill')
  .filter(node => !String(node.props.className || '').includes('_more'))
const pillTexts = tree => pillNodes(tree).map(textOf)

await test('胶囊最多 5 个 + 更多；全部最左，未归类第二，按会话数×最近活动排序', async () => {
  const { runtime, tree } = await mount()
  await runtime.settle()
  assert.deepEqual(pillTexts(runtime.tree), [ALL_NAME, ROOT_NAME, '阅读器', '话题地图', '招标'])
  assert.equal(pillNodes(runtime.tree).length, 5)
  const more = byClass(runtime.tree, 'dsh_tm_histcatpill').find(node => textOf(node).includes('更多'))
  assert.ok(more !== undefined, '第 6 项起必须有「更多」')
  assert.ok(pillTexts(runtime.tree).length + 1 <= 6, '5 个胶囊 + 更多，共 6 个')
  click(more)
  await runtime.settle()
  const rest = byClass(runtime.tree, 'dsh_tm_histcatmoreitem').map(textOf)
  assert.deepEqual(rest, ['插件1', '测试1', '其它1'])
  runtime.unmount()
})

await test('子孙会话计入顶层胶囊；未归类只在有未归类会话时出现', async () => {
  const withRoot = await mount()
  await withRoot.runtime.settle()
  const reader = pillNodes(withRoot.runtime.tree).find(node => textOf(node) === '阅读器')
  assert.ok(String(reader.props.title).includes('3 个会话'), '阅读器含子类会话，共 3 个')
  const root = pillNodes(withRoot.runtime.tree).find(node => textOf(node) === ROOT_NAME)
  assert.ok(String(root.props.title).includes('1 个会话'))
  withRoot.runtime.unmount()

  const noRoot = await mount({ store: fixtureStore({ noUnclassified: true }) })
  await noRoot.runtime.settle()
  assert.equal(pillTexts(noRoot.runtime.tree).includes(ROOT_NAME), false)
  noRoot.runtime.unmount()
})

await test('未归类且全部锁定：不显示「未归类」', async () => {
  const store = { version: 1, categories: [], assignments: {} }
  const lockedSessions = {}
  for (const session of SESSIONS) lockedSessions[session.sessionId] = { at: 1, by: 'user' }
  const locked = await mount({ store, lockedSessions })
  await locked.runtime.settle()
  assert.equal(pillTexts(locked.runtime.tree).includes(ROOT_NAME), false)
  locked.runtime.unmount()
})

await test('子类会话数为 0 的分类不进入胶囊（含更多）', async () => {
  const store = fixtureStore()
  store.categories.push({ id: 'c-empty', name: '空分类', parentId: null })
  const scene = await mount({ store })
  await scene.runtime.settle()
  assert.equal(pillTexts(scene.runtime.tree).includes('空分类'), false)
  const more = byClass(scene.runtime.tree, 'dsh_tm_histcatpill').find(node => textOf(node).includes('更多'))
  if (more !== undefined) {
    click(more)
    await scene.runtime.settle()
    assert.equal(byClass(scene.runtime.tree, 'dsh_tm_histcatmoreitem').map(textOf).includes('空分类'), false)
  }
  scene.runtime.unmount()
})

await test('lockedSessions 随 /categories 原样带给历史行', async () => {
  const locked = await mount({ lockedSessions: { s9: { at: 1, by: 'user' } } })
  await locked.runtime.settle()
  const last = locked.data[locked.data.length - 1]
  assert.deepEqual(last.lockedSessions, { s9: { at: 1, by: 'user' } })
  locked.runtime.unmount()
})

await test('选中态与过滤参数：全部 → ""，未归类 → __none__，分类 → 分类 id', async () => {
  const selected = await mount({ selectedCategory: 'c-reader' })
  await selected.runtime.settle()
  const reader = pillNodes(selected.runtime.tree).find(node => node.props['data-cat-id'] === 'c-reader')
  assert.equal(reader.props['aria-pressed'], 'true')
  assert.equal(reader.props.className.includes('dsh_tm_histcatpill_on'), true)

  click(pillNodes(selected.runtime.tree)[0])
  click(pillNodes(selected.runtime.tree)[1])
  click(reader)
  await selected.runtime.settle()
  assert.deepEqual(selected.selected, ['', '__none__', 'c-reader'])
  selected.runtime.unmount()
})

await test('进入工作区触发一次 workspace-warmup', async () => {
  const { runtime, fake } = await mount()
  await runtime.settle()
  const warmups = fake.calls.filter(call => call.action === 'workspace-warmup')
  assert.equal(warmups.length, 1)
  assert.deepEqual(warmups[0].body, { workspaceId: 'ws-1' })
  runtime.unmount()
})


await test('分类为 0 且有会话：触发 category-auto-start，并显示状态灰字', async () => {
  const { runtime, fake } = await mount({ store: { version: 1, categories: [], assignments: {} } })
  await runtime.settle()
  const starts = fake.calls.filter(call => call.action === 'category-auto-start')
  assert.equal(starts.length, 1, '只启动一次')
  assert.deepEqual(starts[0].body, { workspaceId: 'ws-1' })
  const auto = byClass(runtime.tree, 'dsh_tm_histcatauto')
  assert.equal(auto.length, 1)
  assert.equal(textOf(auto[0]), '正在归类 12 个会话…')
  runtime.unmount()
})

await test('有分类时不触发自动归类', async () => {
  const { runtime, fake } = await mount()
  await runtime.settle()
  assert.equal(fake.calls.filter(call => call.action === 'category-auto-start').length, 0)
  assert.equal(byClass(runtime.tree, 'dsh_tm_histcatauto').length, 0)
  runtime.unmount()
})

await test('状态 no-model：灰字提示未配置模型，不弹错误', async () => {
  const { runtime } = await mount({
    store: { version: 1, categories: [], assignments: {} },
    autoStatus: 'no-model',
  })
  await runtime.settle()
  const auto = byClass(runtime.tree, 'dsh_tm_histcatauto')
  assert.equal(textOf(auto[0]), '未配置模型，无法自动归类')
  assert.equal(byClass(runtime.tree, 'dsh_tm_histcaterr').length, 0)
  runtime.unmount()
})

await test('自动归类轮询：最多 4 次，切工作区清理定时器', async () => {
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  const timers = []
  let nextId = 1
  globalThis.setTimeout = (fn, ms) => {
    const timer = { id: nextId++, fn, ms, cancelled: false }
    timers.push(timer)
    return timer.id
  }
  globalThis.clearTimeout = id => {
    const timer = timers.find(item => item.id === id)
    if (timer !== undefined) timer.cancelled = true
  }
  try {
    const { runtime, fake } = await mount({ store: { version: 1, categories: [], assignments: {} } })
    await runtime.settle()
    assert.equal(fake.calls.filter(call => call.action === 'category-auto-status').length, 1)
    for (let i = 0; i < 3; i += 1) {
      const timer = timers.find(item => item.cancelled !== true)
      assert.ok(timer !== undefined, '第 ' + (i + 1) + ' 次轮询定时器应存在')
      assert.equal(timer.ms, 30000)
      timer.cancelled = true
      timer.fn()
      for (let k = 0; k < 12; k += 1) await Promise.resolve()
      await runtime.settle()
    }
    assert.equal(fake.calls.filter(call => call.action === 'category-auto-status').length, 4, '最多 4 次')
    assert.equal(timers.find(item => item.cancelled !== true), undefined, '第 4 次后不再排定时器')
    runtime.unmount()

    const second = await mount({ store: { version: 1, categories: [], assignments: {} } })
    await second.runtime.settle()
    const oldTimer = timers.find(item => item.cancelled !== true)
    assert.ok(oldTimer !== undefined, '新工作区应先有轮询定时器')
    second.runtime.props.sessionId = 's2'
    second.runtime.renderOnce()
    await second.runtime.runEffects()
    await second.runtime.settle()
    assert.equal(oldTimer.cancelled, true, '切工作区清掉旧定时器')
    second.runtime.unmount()
  } finally {
    globalThis.setTimeout = realSetTimeout
    globalThis.clearTimeout = realClearTimeout
  }
})

await test('页面隐藏时跳过轮询，恢复可见后继续', async () => {
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  const previousDocument = globalThis.document
  const timers = []
  let nextId = 1
  globalThis.setTimeout = (fn, ms) => {
    const timer = { id: nextId++, fn, ms, cancelled: false }
    timers.push(timer)
    return timer.id
  }
  globalThis.clearTimeout = id => {
    const timer = timers.find(item => item.id === id)
    if (timer !== undefined) timer.cancelled = true
  }
  globalThis.document = { visibilityState: 'hidden' }
  try {
    const { runtime, fake } = await mount({ store: { version: 1, categories: [], assignments: {} } })
    await runtime.settle()
    assert.equal(fake.calls.filter(call => call.action === 'category-auto-status').length, 0)
    const hiddenTimer = timers.find(item => item.cancelled !== true)
    hiddenTimer.cancelled = true
    hiddenTimer.fn()
    for (let k = 0; k < 12; k += 1) await Promise.resolve()
    await runtime.settle()
    assert.equal(fake.calls.filter(call => call.action === 'category-auto-status').length, 0, '隐藏时跳过状态请求')
    const visibleTimer = timers.find(item => item.cancelled !== true)
    assert.ok(visibleTimer !== undefined, '隐藏期间仍保留下一次定时')
    globalThis.document.visibilityState = 'visible'
    visibleTimer.cancelled = true
    visibleTimer.fn()
    for (let k = 0; k < 12; k += 1) await Promise.resolve()
    await runtime.settle()
    assert.equal(fake.calls.filter(call => call.action === 'category-auto-status').length, 1, '恢复可见后继续')
    runtime.unmount()
  } finally {
    globalThis.setTimeout = realSetTimeout
    globalThis.clearTimeout = realClearTimeout
    if (previousDocument === undefined) delete globalThis.document
    else globalThis.document = previousDocument
  }
})

await test('旧编辑按钮/调用全部不存在', async () => {
  const { runtime, tree } = await mount()
  await runtime.settle()
  for (const action of ['new-root', 'auto-categorize', 'node-menu', 'row-menu', 'undo', 'dialog-ok']) {
    const found = findAll(tree, node => node.props !== undefined
      && node.props['data-action'] === action)
    assert.equal(found.length, 0, action + ' 不应存在')
  }
  for (const marker of [
    'category-save', 'category-organize', 'category-undo',
    'category-apply-suggestions', 'data-category-edit',
    '＋ 新建大类',
  ]) {
    assert.equal(src.includes(marker), false, marker + ' 不应再调用/渲染')
  }
  assert.ok(src.includes("requestTopicMap('category-auto-start'"))
  assert.ok(src.includes("requestTopicMap('category-auto-status'"))
  assert.ok(src.includes("requestTopicMap('categories'"))
  assert.ok(src.includes("requestTopicMap('sessions'"))
  runtime.unmount()
})

await test('归错了：只列已有分类 + 未归类；override 请求参数正确；user 来源视为锁定', async () => {
  assert.ok(src.includes("requestTopicMap('category-override'"))
  assert.equal(src.includes("requestTopicMap('category-assign'"), false)
  const start = src.indexOf('function renderOverrideDialog')
  const component = src.slice(start, src.indexOf('// ── 正文', start))
  assert.equal(component.includes('<input'), false, '选择器不允许输入新名字')
  assert.ok(component.includes('选择已有分类（不能新建）'))

  const lockedFn = new Function(
    `${extractFunction(src, 'categoryStoreOf')};${extractFunction(src, 'categorySessionLocked')};return categorySessionLocked`,
  )()
  const lockedByFn = new Function(
    `${extractFunction(src, 'categoryStoreOf')};${extractFunction(src, 'categorySessionLocked')};${extractFunction(src, 'categorySessionLockedBy')};return categorySessionLockedBy`,
  )()
  const bodyFn = new Function(
    `${extractFunction(src, 'categoryBodyOf')};${extractFunction(src, 'categoryOverrideBody')};return categoryOverrideBody`,
  )()
  const store = fixtureStore()
  assert.equal(lockedFn(store, 's2'), true, 'source=user 必须显示锁')
  assert.equal(lockedFn(store, 's1'), false)
  assert.equal(lockedByFn(store, { s1: { at: 1, by: 'user' } }, 's1'), true, 'lockedSessions 存在即锁')
  assert.equal(lockedByFn(store, {}, 's2'), true, 'source=user 也锁')
  assert.equal(lockedByFn(store, {}, 's4'), false, '两者都没有不显示锁')
  assert.equal(lockedByFn(store, { s2: { at: 1 } }, 's2'), true, 'lockedSessions 优先于模型 assignment')
  assert.deepEqual(bodyFn('ws-1', 's1', null), { workspaceId: 'ws-1', sessionId: 's1', categoryId: null })
  assert.deepEqual(bodyFn('ws-1', 's1', 'c-reader'), { workspaceId: 'ws-1', sessionId: 's1', categoryId: 'c-reader' })

  assert.ok(src.includes("'dsh_tm_histlock'"))
  assert.ok(src.includes('已人工指定，模型不会覆盖'))
  assert.ok(src.includes('lockedSessionById(row.sessionId)'), '未归类列表也要走同一锁定判定')
  assert.ok(src.includes('categorySessionLockedBy(categoryData.store, categoryData.lockedSessions'))
  assert.ok(src.includes('lockedSessions[key] === true'), 'override 成功后的本地锁立即生效')
  assert.ok(src.includes("'归错了…'"))
  assert.ok(src.includes("'override-category'"))
  assert.ok(src.includes('已改为「'))
  assert.ok(src.includes('模型不会再动这个会话'))
})

finish()
