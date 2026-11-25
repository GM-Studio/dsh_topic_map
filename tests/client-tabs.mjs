/**
 * 右栏三个 tab 的注册与切换（零 React DOM harness）。
 *
 * 锁三件事：
 *   1. 历史 / 统计 / 设置 都注册成同一个右栏的 tab（三个 definition + 三个正文 key）；
 *   2. 正文顶部的切换条能把点击变成 openTab(kind)；
 *   3. 左栏 ⚙ 的「历史导航轨」区块和 settings.section 都不再存在。
 */

import { strict as assert } from 'node:assert'
import {
  readClient,
  extractAssignment,
  extractFunction,
  h,
  findAll,
  textOf,
  click,
  makeRunner,
} from './client-harness.mjs'

const src = readClient()
const RIGHT_TABS = new Function(
  'HISTORY_ID', 'HISTORY_KIND', 'HISTORY_TITLE',
  'STATS_ID', 'STATS_KIND', 'STATS_TITLE',
  'SETTINGS_ID', 'SETTINGS_KIND', 'SETTINGS_TITLE',
  `var RIGHT_TABS = ${extractAssignment(src, 'RIGHT_TABS')};return RIGHT_TABS`,
)(
  'dsh-topic-map:history', 'topic-map-history', '历史',
  'dsh-topic-map:stats', 'topic-map-stats', '统计',
  'dsh-topic-map:settings', 'topic-map-settings', '设置',
)
const { test, finish } = makeRunner('client-tabs')

// ── 1. 三个 tab 注册 ────────────────────────────────────────────────
function setupRegistration() {
  const defs = []
  const slots = []
  const opens = []
  const effects = []
  const stubs = {
    HistoryTabBody: function HistoryTabBody() {},
    StatsTabBody: function StatsTabBody() {},
    SettingsTabBody: function SettingsTabBody() {},
    HistoryHeaderButton: function HistoryHeaderButton() {},
    openHistoryTab: function openHistoryTab() { return true },
  }
  const scope = {
    effect(fn) {
      const disposer = fn()
      effects.push(disposer)
      return disposer
    },
    slots: {
      inject(name, fn) { fn() },
      register(definition, component) {
        slots.push({ name: definition.name, definition: definition, component: component })
        return function () {}
      },
    },
    sidebarRightTabs: {
      register(definition) {
        defs.push(definition)
        return function () {}
      },
    },
    sidebarRight: {
      mounted: { getSnapshot: function () { return 's1' } },
      openTab(kind, options) { opens.push({ kind: kind, options: options }) },
    },
  }
  const source = [
    extractFunction(src, 'openRightTab'),
    extractFunction(src, 'registerHistorySurface'),
  ].join('\n')
  const built = new Function(
    'RIGHT_TABS', 'HISTORY_ID', 'HISTORY_TITLE', 'HISTORY_KIND',
    'STATS_KIND', 'SETTINGS_KIND',
    'HistoryTabBody', 'StatsTabBody', 'SettingsTabBody',
    'HistoryHeaderButton', 'openHistoryTab',
    'historyDiag', 'errorText',
    `${source};return { registerHistorySurface: registerHistorySurface, openRightTab: openRightTab }`,
  )(
    RIGHT_TABS, 'dsh-topic-map:history', '历史', 'topic-map-history',
    'topic-map-stats', 'topic-map-settings',
    stubs.HistoryTabBody, stubs.StatsTabBody, stubs.SettingsTabBody,
    stubs.HistoryHeaderButton, stubs.openHistoryTab,
    function () {}, function (error) { return String(error && error.message ? error.message : error) },
  )
  built.registerHistorySurface(scope)
  return { defs, slots, opens, effects, stubs, scope, openRightTab: built.openRightTab }
}

await test('三个 tab 注册为同一右栏的三种 kind（含各自 guide 条目）', async () => {
  const setup = setupRegistration()
  assert.equal(setup.defs.length, 3, '必须注册历史 / 统计 / 设置三个 definition')
  assert.deepEqual(setup.defs.map(def => def.kind), [
    'topic-map-history', 'topic-map-stats', 'topic-map-settings',
  ])
  assert.deepEqual(setup.defs.map(def => def.id), [
    'dsh-topic-map:history', 'dsh-topic-map:stats', 'dsh-topic-map:settings',
  ])
  assert.deepEqual(setup.defs.map(def => def.title()), ['历史', '统计', '设置'])
  for (const def of setup.defs) {
    assert.equal(def.guide.length, 1, `${def.id} 应有一张 guide 卡片`)
    assert.equal(def.keepMounted, true)
  }
  // key 必须等于 definition.id，否则正文永远分不到这个 tab。
  const paneSlots = setup.slots.filter(slot => slot.name === 'sidebar.right.pane.tab')
  assert.equal(paneSlots.length, 3)
  assert.deepEqual(paneSlots.map(slot => slot.definition.key), setup.defs.map(def => def.id))
  assert.deepEqual(paneSlots.map(slot => slot.definition.name), [
    'sidebar.right.pane.tab', 'sidebar.right.pane.tab', 'sidebar.right.pane.tab',
  ])
  assert.deepEqual(paneSlots.map(slot => slot.component), [
    setup.stubs.HistoryTabBody, setup.stubs.StatsTabBody, setup.stubs.SettingsTabBody,
  ])
  assert.equal(src.includes("kind: 'topic-map-categories'"), false, '分类不再注册成独立 tab')
  assert.equal(src.includes("kind: 'topic-map-clue'"), false, '线索不再注册成独立 tab')
  const header = setup.slots.find(slot => slot.name === 'conversation.session.header.utilities')
  assert.ok(header !== undefined, '历史入口图标仍应注册')
})

await test('正文注入的 openTab 能把切换落到右栏（revealIfOpened）', async () => {
  const setup = setupRegistration()
  const statsSlot = setup.slots.find(slot => slot.definition.key === 'dsh-topic-map:stats')
  const injected = statsSlot.definition.inject()
  assert.equal(typeof injected.openTab, 'function')
  assert.equal(injected.openTab('topic-map-settings'), true)
  assert.deepEqual(setup.opens, [{
    kind: 'topic-map-settings',
    options: { revealIfOpened: true },
  }])
})

await test('没有 mounted 会话时 openTab 不开、也不抛错', async () => {
  const setup = setupRegistration()
  setup.scope.sidebarRight.mounted.getSnapshot = function () { return undefined }
  assert.equal(setup.openRightTab(setup.scope, 'topic-map-stats'), false)
  assert.deepEqual(setup.opens, [])
})

// ── 2. 顶部切换条 ──────────────────────────────────────────────────
function renderTabStrip(active, onOpen) {
  const source = extractFunction(src, 'RightTabStrip')
  const component = new Function('h', 'RIGHT_TABS', `${source};return RightTabStrip`)(h, RIGHT_TABS)
  return component({ active: active, open: onOpen })
}

await test('切换条渲染三个 tab，当前 tab 标 on，点击调用 openTab', async () => {
  const opens = []
  const tree = renderTabStrip('topic-map-stats', kind => opens.push(kind))
  const tabs = findAll(tree, node => String(node.props.className || '').split(/\s+/).includes('dsh_tm_righttab'))
  assert.deepEqual(tabs.map(tab => textOf(tab)), ['历史', '统计', '设置'])
  assert.equal(tabs[0].props['data-kind'], 'topic-map-history')
  assert.equal(tabs[1].props.className.includes('dsh_tm_righttab_on'), true, '统计应为当前 tab')
  click(tabs[2])
  assert.deepEqual(opens, ['topic-map-settings'])
})

// ── 3. 旧入口已删 ──────────────────────────────────────────────────
await test('左栏 ⚙ 旧的「历史导航轨」区块已删除', async () => {
  assert.equal(src.includes('区块三：历史导航轨'), false, '旧区块注释不应残留')
  assert.equal(src.includes('历史导航轨'), false, '旧区块标题不应残留')
})

await test('不再注册 settings.section（统一进右栏设置 tab）', async () => {
  assert.equal(src.includes('settings.section'), false, '不应再注册独立设置页分区')
})

await test('历史页拆分布局：左分类树 / 右搜索+视图切换，输入 400ms 防抖且变更会取消', async () => {
  const debounceMatch = src.match(/var HISTORY_DEBOUNCE_MS = (\d+)/)
  assert.ok(debounceMatch !== null, '找不到 HISTORY_DEBOUNCE_MS')
  assert.equal(Number(debounceMatch[1]), 400)
  for (const marker of [
    'dsh_tm_histmain',
    'dsh_tm_histside',
    'dsh_tm_histpane',
    'dsh_tm_histviewtabs',
    'dsh_tm_histspin',
    'embedded: true',
    'selectedCategory: historyPlan.categoryId',
    'onSelect: chooseHistoryCategory',
    'onData: setCategoryData',
    '分类:名称 关键词',
  ]) {
    assert.ok(src.includes(marker), `历史页缺少 ${marker}`)
  }
  assert.ok(src.includes('cancelHistorySearch()'), '新查询/卸载必须取消上一次请求')
  assert.ok(src.includes("className: 'dsh_tm_histprefixlist'"), '多候选分类前缀要有下拉')
  assert.equal(src.includes("'输入关键词检索，或从左侧选择分类'"), true)
  assert.equal(src.includes("'没有匹配的轮次'"), true)
})

finish()
