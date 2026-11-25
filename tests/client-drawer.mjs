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
  extractFunction(src, 'drawerClampWidth'),
  extractFunction(src, 'drawerRead'),
  src.slice(src.indexOf('    var DRAWER = (function () {'), src.indexOf('\n    })()', src.indexOf('    var DRAWER = (function () {')) + '\n    })()'.length),
  extractFunction(src, 'drawerColumn'),
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
  const intervals = []
  globalThis.setInterval = function (fn) { intervals.push(fn); return intervals.length }
  globalThis.clearInterval = function () {}

  const railCalls = []
  const runtime = await renderComponent(
    SOURCE,
    'TopicMapDrawer',
    ['RIGHT_TABS', 'HISTORY_KIND', 'STATS_KIND', 'SETTINGS_KIND',
      'DRAWER_DEFAULT_WIDTH', 'DRAWER_MIN_WIDTH', 'DRAWER_MAX_WIDTH', 'DRAWER_COLLAPSED_WIDTH',
      'DRAWER_OPEN_KEY', 'DRAWER_WIDTH_KEY', 'DRAWER_COLLAPSED_KEY', 'DRAWER_PUSH_CHECK_MS',
      'HistoryTabBody', 'StatsTabBody', 'SettingsTabBody',
      'RAILTAKE', 'useTopicMapTheme'],
    [
      RIGHT_TABS, 'topic-map-history', 'topic-map-stats', 'topic-map-settings',
      420, 320, 720, 48,
      'dsh.tm.drawer.open', 'dsh.tm.drawer.width', 'dsh.tm.drawer.collapsed', 700,
      BODIES.HistoryTabBody, BODIES.StatsTabBody, BODIES.SettingsTabBody,
      { setDockObscured(value) { railCalls.push(value) } },
      function () {},
    ],
    { sessionId: 's1' },
  )
  function cleanup() {
    runtime.unmount()
    globalThis.document = previous.document
    globalThis.window = previous.window
    globalThis.getComputedStyle = previous.getComputedStyle
    globalThis.localStorage = previous.localStorage
    globalThis.setInterval = previous.setInterval
    globalThis.clearInterval = previous.clearInterval
  }
  return { runtime, tree: runtime.tree, column: dom.column, intervals, railCalls, memory, cleanup }
}

await test('默认打开：420px，对话列 margin-right = 420px', async () => {
  const mounted = await mount()
  const drawer = byClass(mounted.tree, 'dsh_tm_drawer')[0]
  assert.ok(drawer !== undefined)
  assert.equal(drawer.props.style.width, '420px')
  assert.equal(mounted.column.style.marginRight, '420px')
  assert.ok(byClass(mounted.tree, 'dsh_tm_drawertab').length === 3)
  mounted.cleanup()
  assert.equal(mounted.column.style.marginRight, '', '卸载必须恢复 margin')
})

await test('宽度三档：720 / 420 / 320 都按当前宽度写 style 与 margin', async () => {
  for (const width of [720, 420, 320]) {
    const mounted = await mount()
    // 直接调用状态 setter，再 settle。
    const start = src.indexOf('    var DRAWER = (function () {')
    const end = src.indexOf('\n    })()', start)
    const body = src.slice(start, end + '\n    })()'.length)
    // 组件已经 mount；这里通过重新 mount 前写 storage 较绕，改用全局 DRAWER 不可见，
    // 因此用 storage 预置宽度 + 重新 mount。
    mounted.cleanup()
    const seeded = await mount({ storage: [['dsh.tm.drawer.width', String(width)]] })
    const drawer = byClass(seeded.tree, 'dsh_tm_drawer')[0]
    assert.equal(drawer.props.style.width, width + 'px')
    assert.equal(seeded.column.style.marginRight, width + 'px')
    seeded.cleanup()
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
  assert.equal(pill.props.title, '话题地图（Ctrl+Shift+H）')
  assert.equal(textOf(pill), '⋮⋮')
  click(pill)
  await mounted.runtime.settle()
  assert.ok(byClass(mounted.runtime.tree, 'dsh_tm_drawer')[0] !== undefined)
  mounted.cleanup()
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

await test('布局断点写在 CSS：560 并排 / 420–560 顶部行 / <420 单列与设置纵排', async () => {
  assert.ok(src.includes('container-name:tm-drawer'))
  assert.ok(src.includes('@container tm-drawer (max-width:559px)'))
  assert.ok(src.includes('@container tm-drawer (min-width:560px)'))
  assert.ok(src.includes('@container tm-drawer (max-width:419px)'))
  assert.ok(src.includes('grid-template-columns:1fr'))
  assert.ok(src.includes('dsh_tm_histcatbar'))
  assert.ok(src.includes('dsh_tm_histcatpop'))
})

finish()
