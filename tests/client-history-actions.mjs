/**
 * 历史结果动作条：文字始终存在，窄时换行，只有 <220px 才降级图标。
 *
 * 用 `measureWidth` 注入动作条容器宽度，验证 320 / 280 / 200 三档；
 * 生产代码走 ResizeObserver，只在跨阈值时切 data-icon-only。
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
} from './client-harness.mjs'

const src = readClient()
const SOURCE = [
  extractFunction(src, 'historyActionsIconOnly'),
  extractFunction(src, 'HistoryActionBar'),
].join('\n')
const { test, finish } = makeRunner('client-history-actions')

const ACTIONS = [
  {
    key: 'locate', className: 'dsh_tm_histbtn dsh_tm_histbtn_primary',
    title: '定位到第 2 轮', ariaLabel: '定位到第 2 轮',
    icon: '⌖', label: '定位', onClick: function () {},
  },
  {
    key: 'detail', className: 'dsh_tm_histbtn dsh_tm_histbtn_outline',
    title: '查看该轮详情', ariaLabel: '查看该轮详情',
    icon: 'ⓘ', label: '详情', onClick: function () {},
  },
  {
    key: 'quote', className: 'dsh_tm_histbtn dsh_tm_histbtn_outline',
    title: '插入轮次引用【…】', ariaLabel: '插入轮次引用',
    icon: '❝', label: '引用', onClick: function () {},
  },
  {
    key: 'menu', className: 'dsh_tm_histbtn dsh_tm_histbtn_icon',
    title: '更多动作', ariaLabel: '更多动作',
    icon: '⋯', label: '', onClick: function () {},
  },
]

async function mount(width) {
  return renderComponent(
    SOURCE,
    'HistoryActionBar',
    ['HISTORY_ACTION_ICON_WIDTH'],
    [220],
    { actions: ACTIONS, actionKey: 'k', measureWidth: width },
  )
}

function rowOf(tree) {
  return byClass(tree, 'dsh_tm_histactionrow')[0]
}

await test('320px / 280px：按钮文字都显示，按钮不换行、不被压缩', async () => {
  for (const width of [320, 280]) {
    const runtime = await mount(width)
    const row = rowOf(runtime.tree)
    assert.equal(row.props['data-icon-only'], '0')
    assert.equal(row.props.style.flexWrap, 'wrap')
    const buttons = byClass(runtime.tree, 'dsh_tm_histbtn')
    assert.equal(buttons.length, 4)
    for (const button of buttons) {
      assert.equal(button.props.style.flexShrink, 0)
      assert.equal(button.props.style.whiteSpace, 'nowrap')
      assert.equal(button.props.style.minWidth, 'max-content')
      assert.ok(String(button.props.style.flex).includes('0 0 auto'))
      assert.ok(button.props.title !== undefined && button.props.title !== '')
    }
    assert.deepEqual(byClass(runtime.tree, 'dsh_tm_histbtnlabel').map(textOf), ['定位', '详情', '引用'])
    assert.equal(byClass(runtime.tree, 'dsh_tm_histbtnicon').length, 4)
  }
})

await test('200px：才降级为纯图标，标题/aria-label 仍完整，按钮数仍为 4', async () => {
  const runtime = await mount(200)
  const row = rowOf(runtime.tree)
  assert.equal(row.props['data-icon-only'], '1')
  const buttons = byClass(runtime.tree, 'dsh_tm_histbtn')
  assert.equal(buttons.length, 4)
  for (const button of buttons) {
    assert.ok(button.props.title !== undefined && button.props.title !== '')
    assert.ok(button.props['aria-label'] !== undefined && button.props['aria-label'] !== '')
  }
  assert.equal(byClass(runtime.tree, 'dsh_tm_histbtnlabel').length, 3, '文字节点仍在 DOM，由 CSS 在 <220px 隐藏')
})

await test('阈值只在 <220px 触发，220px 仍显示文字', async () => {
  const fn = new Function('HISTORY_ACTION_ICON_WIDTH',
    `${extractFunction(src, 'historyActionsIconOnly')};return historyActionsIconOnly`)(220)
  assert.equal(fn(220), false)
  assert.equal(fn(219), true)
  assert.equal(fn(0), false, '量不到宽度时不要误降级')
})

finish()
