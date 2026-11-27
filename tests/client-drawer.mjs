/**
 * 右侧停靠抽屉：宽度三档、折叠、药丸入口、margin 让位与降级、轨道避让。
 *
 * 组件原样取自 lib/client.js；宿主 DOM/窗口用假对象，React 用 harness。
 */

import { strict as assert } from 'node:assert'
import {
  readClient,
  extractFunction,
  renderComponent,
  makeRunner,
  byClass,
  findAll,
  textOf,
  click,
} from './client-harness.mjs'

const src = readClient()
const { test, finish } = makeRunner('client-drawer')

const SOURCE = [
  extractFunction(src, 'drawerViewportWidth'),
  extractFunction(src, 'drawerMaxWidth'),
  extractFunction(src, 'drawerDefaultWidth'),
  extractFunction(src, 'drawerClampWidth'),
  extractFunction(src, 'drawerRead'),
  src.slice(src.indexOf('    var DRAWER = (function () {'), src.indexOf('\n    })()', src.indexOf('    var DRAWER = (function () {')) + '\n    })()'.length),
  extractFunction(src, 'drawerColumn'),
  extractFunction(src, 'workspaceDisplayName'),
  extractFunction(src, 'shouldFollowOwnWorkspace'),
  extractFunction(src, 'shouldFollowSessionSwitch'),
  extractFunction(src, 'workPickSuffix'),
  extractFunction(src, 'requestTopicMap'),
  extractFunction(src, 'TopicMapDrawerSurface'),
  extractFunction(src, 'TopicMapDrawer'),
].join('\n')

const RIGHT_TABS = [
  { kind: 'topic-map-history', title: '历史' },
  { kind: 'topic-map-stats', title: '统计' },
  { kind: 'topic-map-settings', title: '设置' },
]
const BODIES = {
  HistoryTabBody: function HistoryTabBody() { return { type: 'div', props: { className: 'fake-history' }, children: [] } },
  StatsTabBody: function StatsTabBody() { return { type: 'div', props: { className: 'fake-stats' }, children: [] } },
  SettingsTabBody: function SettingsTabBody() { return { type: 'div', props: { className: 'fake-settings' }, children: [] } },
}

function makeStyle() {
  const values = new Map()
  return {
    get marginRight() { return values.get('margin-right') || '' },
    set marginRight(value) { values.set('margin-right', value) },
    getPropertyValue(name) { return values.get(name) || '' },
    getPropertyPriority() { return '' },
    setProperty(name, value) { values.set(name, value) },
    removeProperty(name) { values.delete(name) },
  }
}

function setupDom() {
  const column = {
    isConnected: true,
    style: makeStyle(),
    getBoundingClientRect() { return { width: 1000, height: 800, top: 50, bottom: 850, left: 0, right: 1000 } },
  }
  const body = { tagName: 'BODY', parentElement: null }
  column.parentElement = body
  const document = {
    body,
    querySelector(selector) {
      if (selector === '[data-dsh-center-col]') return column
      return null
    },
  }
  const window = {
    innerHeight: 900,
    innerWidth: 1400,
    addEventListener() {},
    removeEventListener() {},
    getComputedStyle(el) {
      return { display: 'block', marginRight: el.style.marginRight || '0px', visibility: 'visible' }
    },
  }
  return { column, document, window }
}

async function mount(options) {
  const settings = options || {}
  const dom = setupDom()
  if (settings.viewportWidth !== undefined) dom.window.innerWidth = settings.viewportWidth
  const previous = {
    document: globalThis.document,
    window: globalThis.window,
    getComputedStyle: globalThis.getComputedStyle,
    localStorage: globalThis.localStorage,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
  }
  const memory = new Map(settings.storage || [])
  globalThis.document = dom.document
  globalThis.window = dom.window
  globalThis.getComputedStyle = dom.window.getComputedStyle
  globalThis.localStorage = {
    getItem(key) { return memory.has(key) ? memory.get(key) : null },
    setItem(key, value) { memory.set(key, String(value)) },
  }
  const previousFetch = globalThis.fetch
  const wsPayload = Array.isArray(settings.workspaces) ? settings.workspaces : []
  globalThis.fetch = function () {
    return Promise.resolve({ status: 200, json: () => Promise.resolve({ ok: true, value: wsPayload }) })
  }
  const intervals = []
  globalThis.setInterval = function (fn) { intervals.push(fn); return intervals.length }
  globalThis.clearInterval = function () {}

  const railCalls = []
  const runtime = await renderComponent(
    SOURCE,
    'TopicMapDrawer',
    ['RIGHT_TABS', 'HISTORY_KIND', 'STATS_KIND', 'SETTINGS_KIND',
      'DRAWER_MIN_WIDTH', 'DRAWER_MAX_WIDTH', 'DRAWER_NARROW_MAX_WIDTH',
      'DRAWER_NARROW_BREAKPOINT', 'DRAWER_SMALL_BREAKPOINT', 'DRAWER_COLLAPSED_WIDTH',
      'DRAWER_OPEN_KEY', 'DRAWER_WIDTH_KEY', 'DRAWER_COLLAPSED_KEY', 'DRAWER_PUSH_CHECK_MS',
      'HistoryTabBody', 'StatsTabBody', 'SettingsTabBody',
      'RAILTAKE', 'useTopicMapTheme'],
    [
      RIGHT_TABS, 'topic-map-history', 'topic-map-stats', 'topic-map-settings',
      300, 560, 420, 1100, 760, 48,
      'dsh.tm.drawer.open', 'dsh.tm.drawer.width', 'dsh.tm.drawer.collapsed', 700,
      BODIES.HistoryTabBody, BODIES.StatsTabBody, BODIES.SettingsTabBody,
      { setDockObscured(value) { railCalls.push(value) } },
      function () {},
    ],
    { sessionId: settings.sessionId === undefined ? 's1' : settings.sessionId },
  )
  function cleanup() {
    runtime.unmount()
    globalThis.document = previous.document
    globalThis.window = previous.window
    globalThis.getComputedStyle = previous.getComputedStyle
    globalThis.localStorage = previous.localStorage
    globalThis.setInterval = previous.setInterval
    globalThis.clearInterval = previous.clearInterval
    globalThis.fetch = previousFetch
  }
  return { runtime, tree: runtime.tree, column: dom.column, intervals, railCalls, memory, cleanup }
}

await test('默认打开：视口 1400px 时 30% = 420px，并推挤对话列', async () => {
  const mounted = await mount()
  const drawer = byClass(mounted.tree, 'dsh_tm_drawer')[0]
  assert.ok(drawer !== undefined)
  assert.equal(drawer.props.style.width, '420px')
  assert.equal(mounted.column.style.marginRight, '420px')
  assert.ok(byClass(mounted.tree, 'dsh_tm_drawertab').length === 3)
  mounted.cleanup()
  assert.equal(mounted.column.style.marginRight, '', '卸载必须恢复 margin')
})

await test('宽度自适应：560 / 420 / 300 都按当前宽度写 style 与 margin', async () => {
  for (const width of [560, 420, 300]) {
    const seeded = await mount({ storage: [['dsh.tm.drawer.width', String(width)]] })
    const drawer = byClass(seeded.tree, 'dsh_tm_drawer')[0]
    assert.equal(drawer.props.style.width, width + 'px')
    assert.equal(seeded.column.style.marginRight, width + 'px')
    seeded.cleanup()
  }
})

await test('视口公式：1920→560、1000→300（上限 420）、1280→384', async () => {
  for (const [viewport, expected] of [[1280, 384], [1920, 560], [2560, 560], [3840, 560], [1000, 300]]) {
    const mounted = await mount({ viewportWidth: viewport })
    const drawer = byClass(mounted.tree, 'dsh_tm_drawer')[0]
    assert.equal(drawer.props.style.width, expected + 'px', viewport + 'px 视口')
    mounted.cleanup()
  }
})

await test('折叠：48px 图标条，三个 tab 图标都在，点击可展开', async () => {
  const mounted = await mount({ storage: [['dsh.tm.drawer.collapsed', '1']] })
  const drawer = byClass(mounted.tree, 'dsh_tm_drawer')[0]
  assert.equal(drawer.props.style.width, '48px')
  assert.equal(drawer.props['data-collapsed'], '1')
  const icons = byClass(mounted.tree, 'dsh_tm_drawericon')
  assert.ok(icons.length >= 4)
  click(icons[icons.length - 1])
  await mounted.runtime.settle()
  const expanded = byClass(mounted.runtime.tree, 'dsh_tm_drawer')[0]
  assert.equal(expanded.props['data-collapsed'], '0')
  mounted.cleanup()
})

await test('关闭：只渲染右缘药丸，点击打开抽屉', async () => {
  const mounted = await mount({ storage: [['dsh.tm.drawer.open', '0']] })
  const pill = byClass(mounted.tree, 'dsh_tm_drawerpill')[0]
  assert.ok(pill !== undefined)
  assert.equal(pill.props.title, '历史检索')
  assert.equal(pill.props['aria-label'], '历史检索')
  assert.equal(textOf(pill), '⋮⋮')
  click(pill)
  await mounted.runtime.settle()
  const drawer = byClass(mounted.runtime.tree, 'dsh_tm_drawer')[0]
  assert.ok(drawer !== undefined)
  assert.equal(drawer.props['aria-label'], '历史检索')
  assert.equal(textOf(byClass(mounted.runtime.tree, 'dsh_tm_drawertitle')[0]), '历史检索')
  const folds = byClass(mounted.runtime.tree, 'dsh_tm_drawerfold')
  const close = folds[folds.length - 1]
  assert.equal(close.props.title, '关闭历史检索（Ctrl+Shift+H）')
  assert.equal(close.props['aria-label'], '关闭历史检索')
  mounted.cleanup()
})

await test('用户可见文案统一为「历史检索」：源码非注释行无「话题地图」', () => {
  const codeLines = src.split('\n').filter(line => {
    const text = line.trim()
    return !text.startsWith('//') && !text.startsWith('*') && !text.startsWith('/*')
  })
  assert.equal(codeLines.join('\n').includes('话题地图'), false)
  assert.ok(src.includes("var HISTORY_TITLE = '历史检索'"))
})

await test('margin 连续 3 次被冲掉：降级覆盖模式、灰字说明、历史轨隐藏', async () => {
  const mounted = await mount()
  assert.equal(mounted.column.style.marginRight, '420px')
  assert.ok(mounted.intervals.length > 0)
  const verify = mounted.intervals[0]
  for (let i = 0; i < 3; i += 1) {
    mounted.column.style.marginRight = '0px'
    verify()
  }
  await mounted.runtime.settle()
  const drawer = byClass(mounted.runtime.tree, 'dsh_tm_drawer')[0]
  assert.equal(drawer.props['data-overlay'], '1')
  assert.equal(mounted.column.style.marginRight, '', '降级后恢复 margin，改为覆盖')
  assert.ok(textOf(byClass(mounted.runtime.tree, 'dsh_tm_drawerwarn')[0]).includes('已切换覆盖模式'))
  assert.ok(mounted.railCalls.includes(true), '覆盖模式下历史轨要自动隐藏，避免重叠')
  mounted.cleanup()
  assert.ok(mounted.railCalls.includes(false), '卸载恢复轨道')
})

await test('视口 < 760 默认关闭；打开后强制覆盖，不推挤对话列', async () => {
  const mounted = await mount({ viewportWidth: 700 })
  const pill = byClass(mounted.tree, 'dsh_tm_drawerpill')[0]
  assert.ok(pill !== undefined, '小屏默认关闭只给药丸')
  click(pill)
  await mounted.runtime.settle()
  const drawer = byClass(mounted.runtime.tree, 'dsh_tm_drawer')[0]
  assert.equal(drawer.props['data-overlay'], '1')
  assert.equal(mounted.column.style.marginRight, '', '覆盖模式不能推挤')
  mounted.cleanup()
})

await test('布局：分类胶囊横向滚动，<420 单列与设置纵排', async () => {
  assert.ok(src.includes('container-name:tm-drawer'))
  assert.ok(src.includes('@container tm-drawer (max-width:419px)'))
  assert.ok(src.includes('grid-template-columns:1fr'))
  assert.ok(src.includes('.dsh_tm_histcatpills'))
  assert.ok(src.includes('overflow-x:auto'))
  assert.ok(src.includes('white-space:nowrap'))
  assert.equal(src.includes('dsh_tm_histcatbar'), false, '旧分类栏已删除')
  assert.equal(src.includes('dsh_tm_histcatpop'), false, '旧分类浮层已删除')
})

await test('工作区下拉：未统计的对话数不得显示成「0 对话」', async () => {
  const m = await mount({
    workspaces: [
      { id: 'ws-own', title: '本区', sessionCount: 3, conversationCount: 5, emptySessionCount: 0 },
      { id: 'ws-known', title: '有数字', sessionCount: 2, conversationCount: 7, emptySessionCount: 0 },
      { id: 'ws-null', title: '没统计过', sessionCount: 4, conversationCount: null, emptySessionCount: null },
    ],
  })
  await m.runtime.settle()
  const options = findAll(m.runtime.tree, n => n && n.type === 'option')
  const texts = options.map(o => textOf(o))
  const nullOne = texts.find(t => t.indexOf('没统计过') >= 0)
  assert.ok(nullOne !== undefined, '应有「没统计过」这个选项，实际 ' + JSON.stringify(texts))
  assert.ok(nullOne.indexOf('0 对话') === -1, '未知不能显示成 0 对话：' + nullOne)
  const knownOne = texts.find(t => t.indexOf('有数字') >= 0)
  assert.ok(knownOne !== undefined && knownOne.indexOf('7 对话') >= 0, '已统计的要显示真实数字：' + knownOne)
  m.cleanup()
})

await test('联动规则：主对话换工作区要跟回去，同区轮询不得冲掉手动选择', async () => {
  // 纯函数直接提取求值：不依赖组件挂载，测的就是这条规则本身。
  const followSrc = extractFunction(src, 'shouldFollowOwnWorkspace')
  const follow = new Function(followSrc + '\nreturn shouldFollowOwnWorkspace')()
  assert.equal(follow('ws-a', 'ws-b'), true, '归属变了 → 跟回去')
  assert.equal(follow('ws-a', 'ws-a'), false, '归属没变 → 不动用户的选择')
  assert.equal(follow('', 'ws-b'), false, '首次确定归属不算「变更」')
  assert.equal(follow('ws-a', ''), false, '归属未知时不瞎动')
})

await test('下拉后缀：有对话/只有空会话/未统计 三种情况说三句不同的话', async () => {
  const suffixSrc = extractFunction(src, 'workPickSuffix')
  const suffix = new Function(suffixSrc + '\nreturn workPickSuffix')()
  assert.equal(suffix({ conversationCount: 7, emptySessionCount: 0 }), '（7 对话）')
  assert.equal(suffix({ conversationCount: 0, emptySessionCount: 3 }), '（只有 3 个空会话）', '空会话要说明白，不能只说 0 对话')
  assert.equal(suffix({ conversationCount: 0, emptySessionCount: 0 }), '（无对话）')
  assert.equal(suffix({ conversationCount: null, emptySessionCount: null }), '', '未统计不得显示 0')
})

await test('联动规则：主对话换会话要跟回本区，同一会话轮询不得冲掉选择', async () => {
  const switchSrc = extractFunction(src, 'shouldFollowSessionSwitch')
  const follow = new Function(switchSrc + '\nreturn shouldFollowSessionSwitch')()
  assert.equal(follow('sess-1', 'sess-2'), true, '换会话 → 跟回本区')
  assert.equal(follow('sess-1', 'sess-1'), false, '同一会话轮询 → 不动用户的选择')
  assert.equal(follow(null, 'sess-1'), false, '首次确定会话不算切换')
  assert.equal(follow('sess-1', ''), false, '读不到会话时不瞎动')
})
finish()