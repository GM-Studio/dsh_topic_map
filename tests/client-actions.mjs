/**
 * 历史动作：分叉 / 重试 / 生成简报。
 *
 * 动作请求体是纯函数，直接 eval client.js 里的实现；失败路径用假 Host
 * 返回 409 / 503 / 404 的中文 error，断言客户端原样带出而不是吞掉。
 */

import { strict as assert } from 'node:assert'
import {
  readClient,
  extractFunction,
  makeFetch,
  makeRunner,
} from './client-harness.mjs'

const src = readClient()
const { test, finish } = makeRunner('client-actions')

const CONFIRM_TEXT = (src.match(/var HISTORY_RETRY_CONFIRM_TEXT = '([^']*)'/) || [])[1]
const ACTION_SOURCE = [
  extractFunction(src, 'requestTopicMap'),
  extractFunction(src, 'historyActionRequest'),
  extractFunction(src, 'historyActionNeedsConfirm'),
  extractFunction(src, 'runHistoryAction'),
  extractFunction(src, 'historyActionSuccessText'),
  extractFunction(src, 'historyActionErrorText'),
].join('\n')

function buildActions(handler) {
  const fake = makeFetch(handler)
  const api = new Function(
    'fetch', 'errorText',
    `${ACTION_SOURCE};return {
      requestTopicMap: requestTopicMap,
      historyActionRequest: historyActionRequest,
      historyActionNeedsConfirm: historyActionNeedsConfirm,
      runHistoryAction: runHistoryAction,
      historyActionSuccessText: historyActionSuccessText,
      historyActionErrorText: historyActionErrorText,
    }`,
  )(fake.fetch, error => String(error && error.message ? error.message : error))
  return { api: api, calls: fake.calls }
}

const HIT = { sessionId: 's1', turn: 3 }

await test('三个动作的请求参数：分叉/重试 {sessionId,turn}，简报 {sessionId,turns:[turn]}', async () => {
  const { api, calls } = buildActions(({ action }) => {
    if (action === 'fork') return { value: { sessionId: 'new-1', atSeq: 41, turn: 3 } }
    if (action === 'retry') return { value: { sessionId: 'new-2', prompt: '问题' } }
    if (action === 'brief') return { value: { path: 'C:/tmp/brief.md', bytes: 100, turns: 1 } }
    return { ok: false, error: 'unexpected ' + action }
  })

  const fork = await api.runHistoryAction('fork', HIT)
  const retry = await api.runHistoryAction('retry', HIT)
  const brief = await api.runHistoryAction('brief', HIT)

  assert.equal(fork.ok, true)
  assert.equal(retry.ok, true)
  assert.equal(brief.ok, true)
  assert.deepEqual(calls.map(call => call.action), ['fork', 'retry', 'brief'])
  assert.deepEqual(calls[0].body, { sessionId: 's1', turn: 3 })
  assert.deepEqual(calls[1].body, { sessionId: 's1', turn: 3 })
  assert.deepEqual(calls[2].body, { sessionId: 's1', turns: [3] }, '简报按轮次号数组选轮')
  assert.equal(calls.every(call => call.method === 'POST'), true)
})

await test('缺少会话或轮次：不发请求，直接返回可读错误', async () => {
  const { api, calls } = buildActions(() => ({ value: {} }))
  const result = await api.runHistoryAction('fork', { turn: 3 })
  assert.equal(result.ok, false)
  assert.equal(result.error, '缺少会话或轮次信息')
  assert.equal(calls.length, 0)
  assert.equal(api.historyActionRequest('fork', { sessionId: '', turn: 3 }), null)
  assert.equal(api.historyActionRequest('retry', { sessionId: 's1', turn: -1 }), null)
})

await test('成功文案：分叉带轮号，重试带新会话 id，简报带文件路径', async () => {
  const { api } = buildActions(() => ({ value: {} }))
  assert.equal(api.historyActionSuccessText('fork', HIT, { sessionId: 'new-1' }), '已从第 3 轮之前分叉')
  assert.equal(
    api.historyActionSuccessText('retry', HIT, { sessionId: 'new-2' }),
    '已重试：新会话 new-2',
  )
  assert.equal(
    api.historyActionSuccessText('brief', HIT, { path: 'C:/tmp/brief.md' }),
    '简报已生成：C:/tmp/brief.md',
  )
})

await test('失败：409 运行中 / 503 服务不可用 / 404 不存在都原样展示 Host 中文错误', async () => {
  const cases = [
    { status: 409, error: '会话正在运行，等这一轮结束后再分叉' },
    { status: 503, error: '当前宿主未提供分叉服务，无法分叉' },
    { status: 404, error: '会话里没有第 3 轮' },
  ]
  for (const entry of cases) {
    const { api } = buildActions(() => ({ status: entry.status, ok: false, error: entry.error }))
    const result = await api.runHistoryAction('fork', HIT)
    assert.equal(result.ok, false)
    assert.equal(result.status, entry.status, 'HTTP 状态要保留，便于区分失败类型')
    assert.equal(result.error, entry.error, 'Host 的中文错误不能被改写成"未知错误"')
    assert.equal(
      api.historyActionErrorText('fork', result.error),
      '分叉失败：' + entry.error,
    )
  }
})

await test('重试必须二次确认，分叉/简报不弹确认；不用原生 alert/confirm', async () => {
  assert.equal(apiNeeds('retry'), true)
  assert.equal(apiNeeds('fork'), false)
  assert.equal(apiNeeds('brief'), false)
  assert.equal(CONFIRM_TEXT, '将新建会话并重新提交该轮提问，继续？')
  assert.ok(src.includes('setConfirmAction(entry)'), '重试入口必须进入确认态')
  assert.ok(src.includes('HISTORY_RETRY_CONFIRM_TEXT'), '确认浮层要复用固定文案')
  assert.equal(/window\.(confirm|alert)\(/.test(src), false, '不允许原生弹窗')
})

function apiNeeds(kind) {
  const api = new Function(`${extractFunction(src, 'historyActionNeedsConfirm')};return historyActionNeedsConfirm`)()
  return api(kind)
}

finish()
