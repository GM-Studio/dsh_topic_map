/**
 * 对话位置 ↔ 轨道 ↔ 历史列表 的联动约束。
 *
 * 轨道侧的行为在 rail-takeover 里用假 DOM 覆盖；这里锁单一事实源的
 * 会话过滤与源码接线，防止历史列表自己再算一套 active。
 */

import { strict as assert } from 'node:assert'
import { readClient, extractFunction, makeRunner } from './client-harness.mjs'

const src = readClient()
const { test, finish } = makeRunner('client-active-link')

const historyCurrent = new Function(
  `${extractFunction(src, 'historyEntryIsCurrent')};return historyEntryIsCurrent`,
)()
const resolveActive = new Function(
  `${extractFunction(src, 'resolveActiveTurn')};return resolveActiveTurn`,
)()

await test('历史行高亮：只标当前打开会话的当前轮，跨会话不加', async () => {
  const same = { hit: { sessionId: 's1', turn: 7 } }
  const other = { hit: { sessionId: 's2', turn: 7 } }
  assert.equal(historyCurrent(same, 's1', 7), true)
  assert.equal(historyCurrent(same, 's1', 6), false)
  assert.equal(historyCurrent(other, 's1', 7), false, '跨会话行不能标 current')
  assert.equal(historyCurrent(null, 's1', 7), false)
  assert.equal(historyCurrent(same, 's1', null), false)
})

await test('接线：轨道解析后广播，列表/详情只读同一份当前轮', async () => {
  assert.ok(src.includes('resolveActiveTurn(scroller)'))
  assert.ok(src.includes('TOPIC_ACTIVE.set(sessionId, turn)'))
  assert.ok(src.includes("'data-current': isCurrent ? '1' : undefined"))
  assert.ok(src.includes("var activeTurn = useTopicActiveTurn(boundSessionId)"))
  assert.ok(src.includes("h('span', { className: 'dsh_tm_histdcurrent' }, '当前轮')"))
  assert.ok(src.includes('var delays = [150, 300, 450]'))
})

await test('resolveActiveTurn：顶部 +24px 第一个完整可见轮；没有 data-chat-turn 时退回 aria-label', async () => {
  const rows = [
    { top: 100, bottom: 180, turn: 1 },
    { top: 300, bottom: 380, turn: 2 },
  ]
  const scroller = {
    getBoundingClientRect() { return { top: 0, bottom: 720 } },
    querySelectorAll(selector) {
      if (selector !== '[data-chat-turn]') return []
      return rows.map(row => ({
        getAttribute() { return String(row.turn) },
        getBoundingClientRect() { return { top: row.top, bottom: row.bottom } },
      }))
    },
    querySelector() { return null },
  }
  assert.equal(resolveActive(scroller), 1)
  rows[0].top = -100
  rows[0].bottom = -20
  rows[1].top = 50
  rows[1].bottom = 130
  assert.equal(resolveActive(scroller), 2)

  const fallback = {
    getBoundingClientRect() { return { top: 0, bottom: 720 } },
    querySelectorAll() { return [] },
    querySelector(selector) {
      if (selector.includes('button')) {
        return { getAttribute(name) { return name === 'aria-label' ? '跳转到第 9 轮' : null } }
      }
      return null
    },
  }
  assert.equal(resolveActive(fallback), 9)
})

finish()
