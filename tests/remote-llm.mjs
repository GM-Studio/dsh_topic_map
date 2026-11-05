/**
 * 自定义端点测试。
 *
 * 重点在"失败必须抛错"：静默返回空字符串会让上层以为模型说了空，
 * 于是既不报错也不回退，用户看到一张空图却不知道为什么。
 *
 * Run: node tests/remote-llm.mjs
 */

import { strict as assert } from 'node:assert'
import {
  buildRequestBody,
  callRemote,
  completionUrl,
  extractText,
  hasCustomEndpoint,
} from '../lib/remote-llm.js'

let passed = 0
const failures = []
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok   ${name}`) }
  catch (e) { failures.push({ name, error: e }); console.log(`  FAIL ${name}\n       ${e.message}`) }
}
async function atest(name, fn) {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`) }
  catch (e) { failures.push({ name, error: e }); console.log(`  FAIL ${name}\n       ${e.message}`) }
}

/** 造一个 fetch 桩。 */
function stubFetch(handler) {
  return async (url, init) => handler(url, init)
}

/** 造一个成功响应。 */
function okJson(payload) {
  return {
    ok: true,
    status: 200,
    async json() { return payload },
    async text() { return JSON.stringify(payload) },
  }
}

console.log('\nremote-llm')

// ── 是否启用 ────────────────────────────────────────────────────────
test('base_url 与 model_name 都填了才算启用', () => {
  assert.equal(hasCustomEndpoint({ baseUrl: 'https://x', modelName: 'm' }), true)
  assert.equal(hasCustomEndpoint({ baseUrl: 'https://x', modelName: '' }), false)
  assert.equal(hasCustomEndpoint({ baseUrl: '', modelName: 'm' }), false)
  assert.equal(hasCustomEndpoint({ baseUrl: '   ', modelName: 'm' }), false)
  assert.equal(hasCustomEndpoint(null), false)
  assert.equal(hasCustomEndpoint(undefined), false)
})

// ── URL 拼接 ────────────────────────────────────────────────────────
test('裸域名补 /v1/chat/completions', () => {
  assert.equal(completionUrl('https://api.x.com'), 'https://api.x.com/v1/chat/completions')
  assert.equal(completionUrl('https://api.x.com/'), 'https://api.x.com/v1/chat/completions')
})

test('已带版本段就只补路径', () => {
  assert.equal(completionUrl('https://api.x.com/v1'), 'https://api.x.com/v1/chat/completions')
  assert.equal(completionUrl('https://api.x.com/api/v1'), 'https://api.x.com/api/v1/chat/completions')
})

test('已经是完整地址就原样用', () => {
  const full = 'https://api.x.com/v1/chat/completions'
  assert.equal(completionUrl(full), full)
})

test('空地址抛错', () => {
  assert.throws(() => completionUrl(''), /baseUrl/)
  assert.throws(() => completionUrl('   '), /baseUrl/)
})

// ── 请求体 ──────────────────────────────────────────────────────────
test('temperature 固定 0（分类任务要可复现）', () => {
  const body = buildRequestBody({ modelName: 'm' }, 'sys', 'usr', 100)
  assert.equal(body.temperature, 0)
  assert.equal(body.model, 'm')
})

test('消息顺序：system 在前', () => {
  const body = buildRequestBody({ modelName: 'm' }, '系统提示', '用户内容', 50)
  assert.equal(body.messages.length, 2)
  assert.equal(body.messages[0].role, 'system')
  assert.equal(body.messages[1].role, 'user')
  assert.equal(body.messages[1].content, '用户内容')
})

test('没有 system 时只发一条 user', () => {
  const body = buildRequestBody({ modelName: 'm' }, '', '内容', 50)
  assert.equal(body.messages.length, 1)
})

test('max_tokens 走我们的预算', () => {
  assert.equal(buildRequestBody({ modelName: 'm' }, '', 'x', 777).max_tokens, 777)
  // 不合法就落在默认值
  assert.equal(buildRequestBody({ modelName: 'm' }, '', 'x', 0).max_tokens, 1024)
})

test('非流式', () => {
  assert.equal(buildRequestBody({ modelName: 'm' }, '', 'x', 10).stream, false)
})

// ── 响应解析 ────────────────────────────────────────────────────────
test('取 choices[0].message.content', () => {
  assert.equal(extractText({ choices: [{ message: { content: 'hello' } }] }), 'hello')
})

test('content 是分段数组也能拼', () => {
  const json = { choices: [{ message: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } }] }
  assert.equal(extractText(json), 'ab')
})

test('老式 text 字段兼容', () => {
  assert.equal(extractText({ choices: [{ text: 'legacy' }] }), 'legacy')
})

test('没有 choices 时抛错（不能静默返回空）', () => {
  assert.throws(() => extractText({}), /choices/)
  assert.throws(() => extractText({ choices: [] }), /choices/)
  assert.throws(() => extractText(null), /choices/)
})

test('有 choices 但没有文本时抛错', () => {
  assert.throws(() => extractText({ choices: [{ message: {} }] }), /文本/)
})

// ── 实际调用 ────────────────────────────────────────────────────────
await atest('成功的调用返回文本', async () => {
  let seenUrl = null
  let seenInit = null
  const io = {
    fetch: stubFetch((url, init) => {
      seenUrl = url
      seenInit = init
      return okJson({ choices: [{ message: { content: '["甲","乙"]' } }] })
    }),
  }
  const text = await callRemote(io, { baseUrl: 'https://api.x.com', apiKey: 'sk-1', modelName: 'm' }, 'sys', 'usr')
  assert.equal(text, '["甲","乙"]')
  assert.equal(seenUrl, 'https://api.x.com/v1/chat/completions')
  assert.equal(seenInit.headers.authorization, 'Bearer sk-1')
  assert.equal(seenInit.method, 'POST')
})

test('没有 api_key 时不发 Authorization 头', async () => {
  let headers = null
  const io = {
    fetch: stubFetch((url, init) => {
      headers = init.headers
      return okJson({ choices: [{ message: { content: 'x' } }] })
    }),
  }
  await callRemote(io, { baseUrl: 'https://api.x.com', apiKey: '', modelName: 'm' }, '', 'u')
  assert.equal(headers.authorization, undefined)
})

await atest('HTTP 错误要抛出并带上状态码', async () => {
  const io = {
    fetch: stubFetch(() => ({
      ok: false,
      status: 401,
      async text() { return 'invalid api key' },
      async json() { return {} },
    })),
  }
  await assert.rejects(
    () => callRemote(io, { baseUrl: 'https://api.x.com', modelName: 'm' }, '', 'u'),
    /401/,
  )
})

await atest('404 与 401 能区分（便于诊断）', async () => {
  const mk = status => () => ({ ok: false, status, async text() { return '' }, async json() { return {} } })
  await assert.rejects(() => callRemote({ fetch: stubFetch(mk(404)) }, { baseUrl: 'https://x', modelName: 'm' }, '', 'u'), /404/)
  await assert.rejects(() => callRemote({ fetch: stubFetch(mk(500)) }, { baseUrl: 'https://x', modelName: 'm' }, '', 'u'), /500/)
})

await atest('网络异常向上抛', async () => {
  const io = { fetch: async () => { throw new Error('ECONNREFUSED') } }
  await assert.rejects(
    () => callRemote(io, { baseUrl: 'https://x', modelName: 'm' }, '', 'u'),
    /ECONNREFUSED/,
  )
})

await atest('外部 signal 已取消时不再发请求', async () => {
  let called = false
  const io = {
    fetch: async (url, init) => {
      called = true
      // 模拟被立即取消
      assert.equal(init.signal.aborted, true, 'signal 应已 abort')
      throw new Error('aborted')
    },
  }
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    () => callRemote(io, { baseUrl: 'https://x', modelName: 'm' }, '', 'u', { signal: controller.signal }),
  )
  assert.equal(called, true)
})

await atest('超时会中止请求', async () => {
  let aborted = false
  const io = {
    fetch: (url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        aborted = true
        reject(new Error('timeout'))
      })
    }),
  }
  await assert.rejects(
    () => callRemote(io, { baseUrl: 'https://x', modelName: 'm' }, '', 'u', { timeoutMs: 30 }),
  )
  assert.equal(aborted, true, '超时后应 abort')
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const f of failures) console.error(`\n${f.name}\n${f.error.stack}`)
  process.exit(1)
}
