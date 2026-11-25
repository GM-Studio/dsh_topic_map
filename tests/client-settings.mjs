/**
 * 设置 tab：四组渲染、就地校验、只提交 diff、恢复默认、轨道设置与 localStorage 同步。
 *
 * 用微型 hooks 运行时渲染真实 SettingsTabBody；RAILTAKE 用一份共享 store
 * 的假实现，验证"设置页写 localStorage / rail 菜单改值后设置页跟着变"。
 */

import { strict as assert } from 'node:assert'
import * as SETTINGVIEW from '../lib/settings-view.js'
import * as RAILVIEW from '../lib/rail-view.js'
import {
  readClient,
  extractFunction,
  extractAssignment,
  renderComponent,
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
const { test, finish } = makeRunner('client-settings')

const CONFIG = {
  provider: 'deepseek',
  model: 'chat',
  apiKey: 'sk-secret-never-render',
  turnLimit: 80,
  digestLevel: 'standard',
  quoteMaxCount: 5,
  quoteMaxChars: 2400,
}

function makeRailFake() {
  const store = new Map([
    ['dsh.tm.rail.native', '0'],
    ['dsh.tm.rail.autohide', '1'],
  ])
  let width = 200
  const listeners = []
  function emit() {
    for (const listener of listeners.slice()) listener()
  }
  return {
    store: store,
    nativePreferred() { return store.get('dsh.tm.rail.native') === '1' },
    setNativePreferred(value) {
      store.set('dsh.tm.rail.native', value === true ? '1' : '0')
      emit()
    },
    autoHideEnabled() { return store.get('dsh.tm.rail.autohide') !== '0' },
    setAutoHide(value) {
      store.set('dsh.tm.rail.autohide', value === true ? '1' : '0')
      emit()
    },
    widthOf() { return width },
    setWidth(value) { width = value; emit() },
    subscribe(listener) {
      listeners.push(listener)
      return function () {
        const at = listeners.indexOf(listener)
        if (at >= 0) listeners.splice(at, 1)
      }
    },
  }
}

const SETTINGS_SOURCE = [
  extractFunction(src, 'railTierText'),
  extractFunction(src, 'settingsDefaultValues'),
  extractFunction(src, 'railPrefsSnapshot'),
  extractFunction(src, 'formatIndexBytes'),
  extractFunction(src, 'indexStatsText'),
  extractFunction(src, 'indexStatsTitle'),
  extractFunction(src, 'requestTopicMap'),
  extractFunction(src, 'RightTabStrip'),
  extractFunction(src, 'SettingsTabBody'),
].join('\n')

async function mountSettings(options) {
  const opts = options === undefined ? {} : options
  const fake = makeFetch(({ action, method, body }) => {
    if (action === 'config' && method === 'GET') return { value: opts.config === undefined ? CONFIG : opts.config }
    if (action === 'config' && method === 'POST') {
      return { value: Object.assign({}, opts.config === undefined ? CONFIG : opts.config, body) }
    }
    if (action === 'workspace-reindex') return { value: { queued: 2 } }
    if (action === 'index-stats') {
      if (opts.indexStatsError !== undefined) return { status: 503, ok: false, error: opts.indexStatsError }
      return {
        value: opts.indexStats === undefined
          ? { sessions: 12, turns: 34, bytes: 3355443, digests: 30, digestBytes: 400000 }
          : opts.indexStats,
      }
    }
    return { ok: false, error: 'unexpected ' + action + ' ' + method }
  })
  const rail = makeRailFake()
  const runtime = await renderComponent(
    SETTINGS_SOURCE,
    'SettingsTabBody',
    [
      'SETTINGVIEW', 'RAILVIEW', 'RAILTAKE', 'RAIL_DEFAULT_WIDTH', 'RIGHT_TABS',
      'SETTINGS_KIND', 'SETTINGS_TITLE', 'fetch', 'errorText', 'useTopicMapTheme',
      'currentWorkspaceId',
    ],
    [
      SETTINGVIEW,
      RAILVIEW,
      rail,
      200,
      RIGHT_TABS,
      'topic-map-settings',
      '设置',
      fake.fetch,
      error => String(error && error.message ? error.message : error),
      function () {},
      () => Promise.resolve('ws-1'),
    ],
    { sessionId: 's1', openTab: function () {} },
  )
  return { runtime: runtime, tree: runtime.tree, calls: fake.calls, rail: rail }
}

function groupTitles(tree) {
  return byClass(tree, 'dsh_tm_setgrouptitle').map(textOf)
}

function saveButton(tree) {
  return byData(tree, 'data-action', 'save')[0]
}

function posts(calls) {
  return calls.filter(call => call.action === 'config' && call.method === 'POST')
}

await test('四组渲染：引用 / 索引 / 界面 / 模型，字段齐全且密钥不回显', async () => {
  const { tree } = await mountSettings()
  assert.deepEqual(groupTitles(tree), ['引用', '索引', '界面', '模型'])

  const segments = byClass(tree, 'dsh_tm_setsegbtn')
  assert.deepEqual(segments.map(textOf), ['精简（200 字）', '标准（400 字）', '详尽（800 字）'])
  assert.equal(segments.find(btn => btn.props['data-value'] === 'standard').props['aria-pressed'], 'true')
  assert.ok(textOf(tree).includes('超过配额的部分不会展开，并在注入块末尾注明'))

  assert.equal(byData(tree, 'data-setting', 'quoteMaxCount').length, 1)
  assert.equal(byData(tree, 'data-setting', 'quoteMaxChars').length, 1)
  assert.equal(byData(tree, 'data-setting-range', 'quoteMaxCount').length, 1)
  assert.equal(byData(tree, 'data-setting', 'turnLimit').length, 1)
  assert.equal(byData(tree, 'data-action', 'rebuild').length, 1)
  const indexRow = byClass(tree, 'dsh_tm_setindexrow')[0]
  assert.ok(indexRow !== undefined, '索引体积与重建按钮必须在同一行')
  assert.ok(textOf(indexRow).includes('重建当前工作区索引'))
  assert.ok(textOf(indexRow).includes('12 个会话 · 3.2 MB'), '索引体积文案：12 个会话 · 3.2 MB')
  assert.equal(byData(tree, 'data-setting', 'indexStats')[0].props.title,
    '会话 12 · 轮次 34 · 摘要 30 · 索引 3.2 MB · 摘要体积 390.6 KB')

  assert.equal(byData(tree, 'data-setting', 'railNative')[0].props.checked, false)
  assert.equal(byData(tree, 'data-setting', 'railAutoHide')[0].props.checked, true)
  assert.ok(textOf(tree).includes('normal（200px）'))
  assert.ok(textOf(tree).includes('恢复原生导航轨'))
  assert.ok(textOf(tree).includes('自动隐藏导航轨'))
  assert.ok(textOf(tree).includes('当前轨道宽度'))

  assert.ok(textOf(tree).includes('deepseek'))
  assert.ok(textOf(tree).includes('chat'))
  assert.ok(textOf(tree).includes('已设置'))
  assert.equal(textOf(tree).includes('sk-secret-never-render'), false, 'apiKey 明文绝不能进 DOM')
})

await test('保存只提交 diffConfig 的变化项（railNative 永不进 Host 配置）', async () => {
  const { runtime, tree, calls } = await mountSettings()
  const rich = byData(runtime.tree, 'data-value', 'rich')[0]
  click(rich)
  await runtime.settle()
  const updated = byData(runtime.tree, 'data-setting', 'digestLevel')
    .find(node => node.props['data-value'] === 'rich')
  assert.equal(updated.props['aria-pressed'], 'true', '分段控件应切到 rich')

  click(saveButton(runtime.tree))
  await runtime.settle()
  const sent = posts(calls)
  assert.equal(sent.length, 1)
  assert.deepEqual(sent[0].body, { digestLevel: 'rich' }, '只发变化项，不带整份配置')
  assert.equal('railNative' in sent[0].body, false)
})

await test('校验错误就地显示在字段下方，且阻止保存', async () => {
  const { runtime, calls } = await mountSettings()
  const input = byData(runtime.tree, 'data-setting', 'quoteMaxCount')[0]
  change(input, '99')
  await runtime.settle()

  const errors = byClass(runtime.tree, 'dsh_tm_seterr')
  assert.equal(errors.length, 1, '错误必须显示在字段区，而不是全局弹窗')
  assert.ok(textOf(errors[0]).includes('引用条数需在 1–20 之间'))
  assert.equal(byData(runtime.tree, 'data-setting', 'quoteMaxCount')[0].props.value, '99', '非法输入应保留，方便用户修改')

  click(saveButton(runtime.tree))
  await runtime.settle()
  assert.equal(posts(calls).length, 0, '有校验错误时不能提交')
  assert.ok(textOf(byClass(runtime.tree, 'dsh_tm_setnotice')[0]).includes('有字段未通过校验'))

  change(byData(runtime.tree, 'data-setting', 'quoteMaxCount')[0], '8')
  await runtime.settle()
  assert.equal(byClass(runtime.tree, 'dsh_tm_seterr').length, 0, '改回合法值后错误消失')
  click(saveButton(runtime.tree))
  await runtime.settle()
  assert.deepEqual(posts(calls)[0].body, { quoteMaxCount: 8 })
})

await test('恢复默认：表单回到 50 / standard / 5 / 2400，轨道偏好回默认', async () => {
  const { runtime, rail } = await mountSettings()
  const input = byData(runtime.tree, 'data-setting', 'turnLimit')[0]
  change(input, '120')
  await runtime.settle()
  rail.setAutoHide(false)
  rail.setWidth(320)
  await runtime.settle()

  click(byData(runtime.tree, 'data-action', 'default')[0])
  await runtime.settle()

  assert.equal(byData(runtime.tree, 'data-setting', 'turnLimit')[0].props.value, 50)
  const selected = byData(runtime.tree, 'data-value', 'standard').find(node => node.props['data-setting'] === 'digestLevel')
  assert.equal(selected.props['aria-pressed'], 'true')
  assert.equal(byData(runtime.tree, 'data-setting', 'quoteMaxCount')[0].props.value, 5)
  assert.equal(byData(runtime.tree, 'data-setting', 'quoteMaxChars')[0].props.value, 2400)
  assert.equal(rail.store.get('dsh.tm.rail.autohide'), '1', '恢复默认同时打开自动隐藏')
  assert.equal(rail.store.get('dsh.tm.rail.native'), '0')
  assert.equal(rail.widthOf(), 200)
  assert.ok(textOf(byClass(runtime.tree, 'dsh_tm_setnotice')[0]).includes('已恢复默认值'))
})

await test('rail 设置：设置页写的值进 localStorage，外部改值设置页跟着变', async () => {
  const { runtime, rail } = await mountSettings()
  const autoHide = byData(runtime.tree, 'data-setting', 'railAutoHide')[0]
  change(autoHide, false)
  await runtime.settle()
  assert.equal(rail.store.get('dsh.tm.rail.autohide'), '0', '复选框写共享键')
  assert.equal(byData(runtime.tree, 'data-setting', 'railAutoHide')[0].props.checked, false)

  rail.setAutoHide(true)
  await runtime.settle()
  assert.equal(byData(runtime.tree, 'data-setting', 'railAutoHide')[0].props.checked, true, '外部改动要同步回设置页')

  change(byData(runtime.tree, 'data-setting', 'railNative')[0], true)
  await runtime.settle()
  assert.equal(rail.store.get('dsh.tm.rail.native'), '1')
  rail.setNativePreferred(false)
  await runtime.settle()
  assert.equal(byData(runtime.tree, 'data-setting', 'railNative')[0].props.checked, false)

  rail.setWidth(320)
  await runtime.settle()
  assert.ok(textOf(runtime.tree).includes('wide（320px）'))
})

await test('索引体积失败：显示 —，title 写 Host 原因', async () => {
  const { tree } = await mountSettings({ indexStatsError: '读不到索引目录' })
  const node = byData(tree, 'data-setting', 'indexStats')[0]
  assert.equal(textOf(node), '—')
  assert.ok(String(node.props.title).includes('读不到索引目录'), 'title 要能解释为什么没有数字')
})

await test('重建索引：POST /workspace-reindex，显示排队结果', async () => {
  const { runtime, calls } = await mountSettings()
  click(byData(runtime.tree, 'data-action', 'rebuild')[0])
  await runtime.settle()
  const rebuild = calls.filter(call => call.action === 'workspace-reindex')
  assert.equal(rebuild.length, 1)
  assert.deepEqual(rebuild[0].body, { workspaceId: 'ws-1' })
  assert.ok(textOf(runtime.tree).includes('已排队 2 个会话'))
})

finish()
