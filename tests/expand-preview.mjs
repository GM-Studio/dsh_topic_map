/**
 * `/expand-preview` 诊断接口测试。
 *
 * 与真实展开同源：同一扫描/解析/摘要获取，只是不注入。
 * 锁 reason 分支、同会话不在 workspace registry 的命中、跨会话命中、
 * 摘要来源 cache/generated/fallback。
 *
 * Run: node tests/expand-preview.mjs
 */

import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  flushIndexSyncs,
  flushTurnDigests,
  previewExpansion,
  syncSessionIndexFor,
} from '../lib/index.js'

let passed = 0
const failures = []
async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`  FAIL ${name}\n       ${error.message}`)
  }
}

const BASE_TIME = 1_700_000_000_000
const CALLER = 'session-9999aaaa-1111-4aaa-8bbb-000000000001'
const TARGET = 'session-4c42ff36-aaaa-4bbb-8ccc-000000000001'
const AMBIG_A = 'session-abcd1234-1111-4aaa-8bbb-000000000001'
const AMBIG_B = 'session-abcd1234-2222-4aaa-8bbb-000000000002'
let ctxCounter = 0

function makeEvents(specs) {
  let seq = 0
  const events = []
  const push = (type, data, time) => events.push({ type, seq: seq++, time, data })
  specs.forEach((spec, index) => {
    const start = BASE_TIME + index * 60_000
    const turn = spec.turn ?? index
    push('turn/start', { turn }, start)
    push('user/message', {
      content: [{ type: 'text', text: spec.prompt ?? `问题 ${turn}` }],
      source: { kind: 'user' },
    }, start + 100)
    push('assistant/message', {
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: spec.response ?? `回答 ${turn}` }],
        source: { kind: 'model', provider: 'agent2api', model: 'DeepSeek-Flash' },
      },
    }, start + 1000)
    push('turn/end', { turn, reason: { kind: 'completed' } }, start + 5000)
  })
  return events
}

function makeFakeLlm(options = {}) {
  return {
    async prepareCall(call) {
      return {
        config: { ...call },
        async *stream() {
          if (options.fail === true) throw new Error('model down')
          yield { type: 'text-delta', text: options.text ?? '摘要：预览命中。' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }
    },
    listProviders() {
      return [{ id: 'fake' }]
    },
  }
}

function makeCtx(options = {}) {
  const events = options.events ?? {}
  const llm = options.llm === undefined ? makeFakeLlm(options.llmOptions) : options.llm
  const revision = options.revision ?? `rev-${++ctxCounter}`
  const workspaces = options.workspaces ?? [{
    id: 'ws-1',
    path: 'E:\\\\ws',
    title: '工作区 A',
    sessionIds: options.sessions ?? Object.keys(events),
  }]
  return {
    get(name) {
      if (name === 'workspaceRegistry') return { list: () => workspaces }
      if (name === 'llm') return llm
      return undefined
    },
    sessionQuery: {
      async readSession(id) {
        if (typeof options.readSession === 'function') return options.readSession(id)
        return { events: events[id] ?? [] }
      },
      async listSessions() {
        return Object.keys(events).map(id => ({ header: { id } }))
      },
    },
    sessionPersistence: {
      async stat(id) {
        if (typeof options.stat === 'function') return options.stat(id)
        return { revision }
      },
    },
    llm,
  }
}

async function withTempHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'expand-preview-'))
  const saved = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    return await fn(home)
  } finally {
    await flushIndexSyncs()
    await flushTurnDigests()
    if (saved === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = saved
    await rm(home, { recursive: true, force: true })
  }
}

console.log('\nexpand-preview')

await test('没有句柄：reason 明确，handles/blocks 为空', async () => {
  await withTempHome(async () => {
    const ctx = makeCtx({ events: { [CALLER]: makeEvents([{ prompt: '普通消息' }]) } })
    const result = await previewExpansion(ctx, { sessionId: CALLER, text: '这条消息没有引用' })
    assert.equal(result.ok, true)
    assert.deepEqual(result.value, { handles: [], blocks: [], reason: '没有句柄', alreadyInjected: false })
  })
})

await test('同会话引用：当前会话不在 workspace registry 也能命中', async () => {
  await withTempHome(async () => {
    const ctx = makeCtx({
      events: { [CALLER]: makeEvents([{ prompt: '自己的问题', response: '自己的回答' }]) },
      workspaces: [], // 模拟 /workspaces 里没有 E:\dsh_plugin
      llmOptions: { text: '摘要：同会话预览命中。' },
    })
    const result = await previewExpansion(ctx, {
      sessionId: CALLER,
      text: '回看 〔9999aaaa#0〕',
    })
    assert.equal(result.ok, true, result.error)
    assert.deepEqual(result.value.handles, [{
      handle: '9999aaaa#0',
      matchedSessionId: CALLER,
      turn: 0,
      alreadyInjected: false,
      wouldInject: true,
    }])
    assert.equal(result.value.reason, null)
    assert.equal(result.value.blocks.length, 1)
    assert.equal(result.value.blocks[0].name, 'topic-map:引用摘要')
    assert.equal(result.value.blocks[0].source, 'generated')
    assert.equal(result.value.blocks[0].chars, '摘要：同会话预览命中。'.length)
  })
})

await test('跨会话引用：同工作区内目标会话命中', async () => {
  await withTempHome(async () => {
    const ctx = makeCtx({
      events: {
        [CALLER]: makeEvents([{ prompt: '当前会话' }]),
        [TARGET]: makeEvents([{ prompt: '目标会话轮次', response: '目标回答' }]),
      },
      sessions: [CALLER, TARGET],
      llmOptions: { text: '摘要：跨会话预览命中。' },
    })
    await syncSessionIndexFor(ctx, TARGET)

    const result = await previewExpansion(ctx, {
      sessionId: CALLER,
      text: '看这个 〔4c42ff36#0〕',
    })
    assert.equal(result.value.reason, null, result.value.reason)
    assert.equal(result.value.handles[0].matchedSessionId, TARGET)
    assert.equal(result.value.blocks[0].source, 'generated')
  })
})

await test('前缀无匹配：reason 为「没有匹配该前缀」', async () => {
  await withTempHome(async () => {
    const ctx = makeCtx({
      events: { [CALLER]: makeEvents([{ prompt: '当前' }]) },
      workspaces: [],
    })
    const result = await previewExpansion(ctx, { sessionId: CALLER, text: '〔deadbeef#0〕' })
    assert.equal(result.value.reason, '没有匹配该前缀')
    assert.equal(result.value.handles[0].matchedSessionId, null)
    assert.deepEqual(result.value.blocks, [])
  })
})

await test('前缀歧义：reason 为「前缀歧义」', async () => {
  await withTempHome(async () => {
    const ctx = makeCtx({
      events: {
        [CALLER]: makeEvents([{ prompt: '当前' }]),
        [AMBIG_A]: makeEvents([{ prompt: '甲' }]),
        [AMBIG_B]: makeEvents([{ prompt: '乙' }]),
      },
      sessions: [CALLER, AMBIG_A, AMBIG_B],
    })
    const result = await previewExpansion(ctx, { sessionId: CALLER, text: '〔abcd1234#0〕' })
    assert.equal(result.value.reason, '前缀歧义')
    assert.equal(result.value.handles[0].matchedSessionId, null)
  })
})

await test('轮次不存在：reason 为「轮次不存在」', async () => {
  await withTempHome(async () => {
    const ctx = makeCtx({
      events: { [CALLER]: makeEvents([{ prompt: '唯一一轮' }]) },
      workspaces: [{ id: 'ws-1', path: 'E:\\\\ws', title: 'A', sessionIds: [CALLER] }],
    })
    const result = await previewExpansion(ctx, { sessionId: CALLER, text: '〔9999aaaa#99〕' })
    assert.equal(result.value.reason, '轮次不存在')
    assert.equal(result.value.handles[0].matchedSessionId, CALLER)
    assert.deepEqual(result.value.blocks, [])
  })
})

await test('摘要失败：block.source=fallback，reason=摘要失败', async () => {
  await withTempHome(async () => {
    const answer = '答'.repeat(500)
    const ctx = makeCtx({
      events: { [CALLER]: makeEvents([{ prompt: '问题', response: answer }]) },
      workspaces: [],
      llm: makeFakeLlm({ fail: true }),
    })
    const result = await previewExpansion(ctx, { sessionId: CALLER, text: '〔9999aaaa#0〕' })
    assert.equal(result.value.reason, '摘要失败')
    assert.deepEqual(result.value.blocks, [{
      name: 'topic-map:引用摘要',
      chars: 400,
      source: 'fallback',
    }])
  })
})

await test('来源：第二次预览命中缓存', async () => {
  await withTempHome(async () => {
    const ctx = makeCtx({
      events: { [CALLER]: makeEvents([{ prompt: '问题', response: '回答' }]) },
      workspaces: [],
      llmOptions: { text: '摘要：缓存来源。' },
    })
    const first = await previewExpansion(ctx, { sessionId: CALLER, text: '〔9999aaaa#0〕' })
    assert.equal(first.value.blocks[0].source, 'generated')
    const second = await previewExpansion(ctx, { sessionId: CALLER, text: '〔9999aaaa#0〕' })
    assert.equal(second.value.blocks[0].source, 'cache')
    assert.equal(second.value.blocks[0].chars, first.value.blocks[0].chars)
  })
})

await test('已注入过：alreadyInjected 标记、blocks 空、reason 幂等跳过', async () => {
  await withTempHome(async home => {
    const ctx = makeCtx({
      events: { [CALLER]: makeEvents([{ prompt: '问题', response: '回答' }]) },
      workspaces: [],
    })
    const dir = join(home, 'topic-map', 'quote-ledger')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, `${CALLER}.json`), JSON.stringify({
      '9999aaaa#0': { at: Date.now(), chars: 12, source: 'cache' },
    }), 'utf8')

    const result = await previewExpansion(ctx, { sessionId: CALLER, text: '再看 〔9999aaaa#0〕' })
    assert.equal(result.value.alreadyInjected, true)
    assert.deepEqual(result.value.handles, [{
      handle: '9999aaaa#0',
      matchedSessionId: CALLER,
      turn: 0,
      alreadyInjected: true,
      wouldInject: false,
    }])
    assert.deepEqual(result.value.blocks, [])
    assert.equal(result.value.reason, '已注入过（幂等跳过）')
  })
})

await test('进行中轮次：reason 为「该轮仍在进行中」，不注入', async () => {
  await withTempHome(async () => {
    const events = makeEvents([{ prompt: '进行中', response: '还没完' }])
      .filter(event => event.type !== 'turn/end')
    const ctx = makeCtx({ events: { [CALLER]: events }, workspaces: [] })
    const result = await previewExpansion(ctx, { sessionId: CALLER, text: '〔9999aaaa#0〕' })
    assert.equal(result.value.reason, '该轮仍在进行中')
    assert.deepEqual(result.value.blocks, [])
  })
})

await test('归档不可读：reason 为「该会话已归档或不可读」', async () => {
  await withTempHome(async () => {
    const ctx = makeCtx({
      events: {},
      sessions: [CALLER, TARGET],
      readSession: async () => {
        throw new Error('archived')
      },
      stat: async () => {
        throw new Error('archived')
      },
    })
    const result = await previewExpansion(ctx, { sessionId: CALLER, text: '〔4c42ff36#0〕' })
    assert.equal(result.value.reason, '该会话已归档或不可读')
    assert.deepEqual(result.value.blocks, [])
  })
})

await test('sessionId 缺失：400', async () => {
  await withTempHome(async () => {
    const ctx = makeCtx({})
    const result = await previewExpansion(ctx, { text: '〔9999aaaa#0〕' })
    assert.equal(result.ok, false)
    assert.equal(result.httpStatus, 400)
  })
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const failure of failures) console.error(`\n${failure.name}\n${failure.error.stack}`)
  process.exit(1)
}
