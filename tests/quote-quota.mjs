/**
 * 引用幂等 ledger / 双配额 / 进行中与归档拒绝测试。
 *
 * Run: node tests/quote-quota.mjs
 */

import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  expandQuoteHandlesForAgent,
  flushIndexSyncs,
  flushTurnDigests,
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
const SELF = 'session-9999aaaa-1111-4aaa-8bbb-000000000001'
const OTHER = 'session-4c42ff36-aaaa-4bbb-8ccc-000000000001'
const OTHER_OPEN = 'session-4c42ff37-aaaa-4bbb-8ccc-000000000002'

function makeEvents(specs, options = {}) {
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
    if (spec.end !== false && options.complete !== false) {
      push('turn/end', { turn, reason: { kind: 'completed' } }, start + 5000)
    }
  })
  return events
}

function makeFakeLlm(options = {}) {
  const state = { calls: 0 }
  return {
    get calls() {
      return state.calls
    },
    async prepareCall(call) {
      state.calls += 1
      return {
        config: { ...call },
        async *stream() {
          if (options.fail === true) throw new Error('model down')
          yield { type: 'text-delta', text: options.text ?? '摘要：测试结论。' }
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
        return { revision: `rev-${id}` }
      },
    },
    llm,
  }
}

function makeAgent(options = {}) {
  const messages = (options.texts ?? []).map((text, index) => ({
    id: `msg-${index}`,
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text }],
  }))
  return {
    id: options.id ?? SELF,
    session: {
      header: { cwd: 'E:\\\\ws' },
      deriveMessages: () => messages,
      snapshotEvents: () => options.events ?? [],
    },
  }
}

async function withTempHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'quote-quota-'))
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

async function writeConfig(home, config) {
  await mkdir(join(home, 'topic-map'), { recursive: true })
  await writeFile(join(home, 'topic-map', 'config.json'), JSON.stringify(config), 'utf8')
}

async function readLedger(home, sessionId) {
  const path = join(home, 'topic-map', 'quote-ledger', `${sessionId}.json`)
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

function countBlocks(text) {
  return (text.match(/〔引用摘要 /g) ?? []).length
}

console.log('\nquote-quota')

await test('strict ledger：首次注入、同句柄再引不再注入；ledger 形状正确', async () => {
  await withTempHome(async home => {
    const events = makeEvents([{ prompt: '历史问题', response: '历史回答' }])
    const ctx = makeCtx({ events: { [SELF]: events } })
    const agent = makeAgent({ texts: ['看 〔9999aaaa#0〕'], events })

    const first = await expandQuoteHandlesForAgent(ctx, agent)
    assert.equal(countBlocks(first), 1)
    const ledger = await readLedger(home, SELF)
    assert.ok(ledger['9999aaaa#0'])
    assert.ok(Number.isFinite(ledger['9999aaaa#0'].at))
    assert.ok(Number.isFinite(ledger['9999aaaa#0'].chars))
    assert.equal(ledger['9999aaaa#0'].source, 'generated')

    const second = await expandQuoteHandlesForAgent(ctx, makeAgent({ texts: ['再看 〔9999aaaa#0〕'], events }))
    assert.equal(second, '', '同会话同句柄必须不再注入')
  })
})

await test('新会话引用同句柄：独立 ledger，正常注入', async () => {
  await withTempHome(async home => {
    const targetEvents = makeEvents([{ prompt: '目标', response: '回答' }])
    const ctx = makeCtx({ events: { [OTHER]: targetEvents }, sessions: [OTHER] })

    const a = makeAgent({ id: SELF, texts: ['〔4c42ff36#0〕'], events: [] })
    const b = makeAgent({ id: 'session-aaaa1111-0000-4000-8000-000000000001', texts: ['〔4c42ff36#0〕'], events: [] })
    assert.equal(countBlocks(await expandQuoteHandlesForAgent(ctx, a)), 1)
    assert.equal(countBlocks(await expandQuoteHandlesForAgent(ctx, b)), 1)
    assert.ok(await readLedger(home, SELF))
    assert.ok(await readLedger(home, 'session-aaaa1111-0000-4000-8000-000000000001'))
  })
})

await test('同一消息同一句柄出现 3 次只算 1 个', async () => {
  await withTempHome(async () => {
    const events = makeEvents([{ prompt: '问题', response: '回答' }])
    const ctx = makeCtx({ events: { [SELF]: events } })
    const agent = makeAgent({
      texts: ['〔9999aaaa#0〕 和 〔9999aaaa#0〕 再 〔9999aaaa#0〕'],
      events,
    })
    const text = await expandQuoteHandlesForAgent(ctx, agent)
    assert.equal(countBlocks(text), 1)
  })
})

await test('默认配额：6 个句柄只展开 5 个，第 6 个不记账，末尾提示', async () => {
  await withTempHome(async home => {
    const events = makeEvents(Array.from({ length: 6 }, (_, turn) => ({
      turn,
      prompt: `问题 ${turn}`,
      response: `回答 ${turn}`,
    })))
    const ctx = makeCtx({
      events: { [SELF]: events },
      llmOptions: { text: '摘要：短结论。' },
    })
    const handles = Array.from({ length: 6 }, (_, turn) => `〔9999aaaa#${turn}〕`).join(' ')
    const text = await expandQuoteHandlesForAgent(ctx, makeAgent({ texts: [handles], events }))

    assert.equal(countBlocks(text), 5, '默认 quoteMaxCount=5')
    assert.ok(text.includes('（另有 1 条引用未展开：超出单条消息引用配额）'), text)
    const ledger = await readLedger(home, SELF)
    assert.equal(Object.keys(ledger).length, 5)
    assert.equal(ledger['9999aaaa#5'], undefined, '被配额跳过的第 6 个不能记账')
  })
})

await test('rich 档 3 个句柄触到 2400 字配额，按实际字数只展开部分', async () => {
  await withTempHome(async home => {
    const events = makeEvents(Array.from({ length: 3 }, (_, turn) => ({
      turn,
      prompt: `问题 ${turn}`,
      response: `回答 ${turn}`,
    })))
    const ctx = makeCtx({
      events: { [SELF]: events },
      llmOptions: { text: '要'.repeat(800) },
    })
    await writeConfig(home, { digestLevel: 'rich' })
    const text = await expandQuoteHandlesForAgent(ctx, makeAgent({
      texts: ['〔9999aaaa#0〕 〔9999aaaa#1〕 〔9999aaaa#2〕'],
      events,
    }))
    const blocks = countBlocks(text)
    assert.ok(blocks < 3, `rich 3 条应在 2400 字配额内被截断，实际 ${blocks}`)
    assert.ok(text.includes(`（另有 ${3 - blocks} 条引用未展开：超出单条消息引用配额）`), text)
    const ledger = await readLedger(home, SELF)
    assert.equal(Object.keys(ledger).length, blocks)
  })
})

await test('已注入句柄不占配额：1 个老 + 5 个新，5 个新全展开', async () => {
  await withTempHome(async home => {
    const events = makeEvents(Array.from({ length: 6 }, (_, turn) => ({
      turn,
      prompt: `问题 ${turn}`,
      response: `回答 ${turn}`,
    })))
    const ctx = makeCtx({ events: { [SELF]: events }, llmOptions: { text: '摘要：短。' } })

    assert.equal(countBlocks(await expandQuoteHandlesForAgent(ctx, makeAgent({
      texts: ['〔9999aaaa#0〕'],
      events,
    }))), 1)
    const text = await expandQuoteHandlesForAgent(ctx, makeAgent({
      texts: ['〔9999aaaa#0〕 〔9999aaaa#1〕 〔9999aaaa#2〕 〔9999aaaa#3〕 〔9999aaaa#4〕 〔9999aaaa#5〕'],
      events,
    }))
    assert.equal(countBlocks(text), 5, '已注入的 #0 不占配额')
    assert.equal(text.includes('另有'), false)
  })
})

await test('进行中轮次：当前会话拒绝、不记账；历史会话未结束仍可注入', async () => {
  await withTempHome(async home => {
    const openEvents = makeEvents([{ prompt: '进行中', response: '还没完' }], { complete: false })
    const ctx = makeCtx({
      events: { [SELF]: openEvents, [OTHER_OPEN]: openEvents },
      sessions: [SELF, OTHER_OPEN],
      llmOptions: { text: '摘要：历史未结束也能读。' },
    })

    const current = await expandQuoteHandlesForAgent(ctx, makeAgent({
      texts: ['〔9999aaaa#0〕'],
      events: openEvents,
    }))
    assert.ok(current.includes('这一轮还没结束，结束后再引用'), current)
    assert.equal(await readLedger(home, SELF), null, '进行中轮次不能记账')

    const historical = await expandQuoteHandlesForAgent(ctx, makeAgent({
      id: 'session-bbbb2222-0000-4000-8000-000000000002',
      texts: ['〔4c42ff37#0〕'],
      events: [],
    }))
    assert.ok(historical.includes('〔引用摘要 4c42ff37#0〕'), historical)
    assert.ok(await readLedger(home, 'session-bbbb2222-0000-4000-8000-000000000002'))
  })
})

await test('归档/不可读：拒绝且不记账', async () => {
  await withTempHome(async home => {
    const ctx = makeCtx({
      events: {},
      sessions: [OTHER],
      readSession: async () => {
        throw new Error('archived')
      },
      stat: async () => {
        throw new Error('archived')
      },
    })
    const text = await expandQuoteHandlesForAgent(ctx, makeAgent({
      texts: ['〔4c42ff36#0〕'],
      events: [],
    }))
    assert.ok(text.includes('这个会话已归档，内容读不到'), text)
    assert.equal(await readLedger(home, SELF), null)
  })
})

await test('摘要失败：fallback 注入并记账，第二次不再调模型', async () => {
  await withTempHome(async home => {
    const events = makeEvents([{ prompt: '问题', response: '答'.repeat(500) }])
    const llm = makeFakeLlm({ fail: true })
    const ctx = makeCtx({ events: { [SELF]: events }, llm })

    const first = await expandQuoteHandlesForAgent(ctx, makeAgent({ texts: ['〔9999aaaa#0〕'], events }))
    assert.ok(first.includes('（摘要生成失败，以下是回答开头）'), first)
    const ledger = await readLedger(home, SELF)
    assert.equal(ledger['9999aaaa#0'].source, 'fallback')

    const second = await expandQuoteHandlesForAgent(ctx, makeAgent({ texts: ['再看 〔9999aaaa#0〕'], events }))
    assert.equal(second, '')
    assert.equal(llm.calls, 1, 'fallback 已记账，不应重复调模型')
  })
})

await test('轮次不存在 / 前缀无匹配：不记账，下次可重试', async () => {
  await withTempHome(async home => {
    const events = makeEvents([{ prompt: '唯一一轮' }])
    const ctx = makeCtx({ events: { [SELF]: events }, workspaces: [] })

    const noTurn = await expandQuoteHandlesForAgent(ctx, makeAgent({ texts: ['〔9999aaaa#99〕'], events }))
    assert.ok(noTurn.includes('没有第 99 轮'), noTurn)
    assert.equal(await readLedger(home, SELF), null)

    const noMatch = await expandQuoteHandlesForAgent(ctx, makeAgent({ texts: ['〔deadbeef#0〕'], events }))
    assert.ok(noMatch.includes('没有匹配该前缀'), noMatch)
    assert.equal(await readLedger(home, SELF), null)
  })
})

await test('ledger 单文件上限：超过 200 条按 at 裁到最近 200', async () => {
  await withTempHome(async home => {
    const dir = join(home, 'topic-map', 'quote-ledger')
    await mkdir(dir, { recursive: true })
    const entries = {}
    for (let index = 0; index < 201; index += 1) {
      entries[`aaaa0000#${index}`] = { at: index + 1, chars: 1, source: 'cache' }
    }
    await writeFile(join(dir, `${SELF}.json`), JSON.stringify(entries), 'utf8')

    const events = makeEvents([{ prompt: '问题', response: '回答' }])
    const ctx = makeCtx({ events: { [SELF]: events } })
    const text = await expandQuoteHandlesForAgent(ctx, makeAgent({ texts: ['〔9999aaaa#0〕'], events }))
    assert.equal(countBlocks(text), 1)

    const ledger = await readLedger(home, SELF)
    assert.equal(Object.keys(ledger).length, 200)
    assert.ok(ledger['9999aaaa#0'], '新注入应保留')
    assert.equal(ledger['aaaa0000#0'], undefined, '最旧一条应被裁掉')
    assert.equal(ledger['aaaa0000#1'], undefined, '第二条也应被裁掉')
    assert.ok(ledger['aaaa0000#2'], '剩余最旧一条应保留')
  })
})

await test('插件重载语义：预置 ledger 文件后同句柄不再注入', async () => {
  await withTempHome(async home => {
    const dir = join(home, 'topic-map', 'quote-ledger')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, `${SELF}.json`), JSON.stringify({
      '9999aaaa#0': { at: Date.now(), chars: 10, source: 'cache' },
    }), 'utf8')

    const events = makeEvents([{ prompt: '问题', response: '回答' }])
    const ctx = makeCtx({ events: { [SELF]: events } })
    const text = await expandQuoteHandlesForAgent(ctx, makeAgent({ texts: ['〔9999aaaa#0〕'], events }))
    assert.equal(text, '', 'ledger 文件已存在时不能重复注入')
  })
})

await test('可配置 quoteMaxCount：改成 2 时第 3 个被配额拦下', async () => {
  await withTempHome(async home => {
    await writeConfig(home, { quoteMaxCount: 2 })
    const events = makeEvents(Array.from({ length: 3 }, (_, turn) => ({
      turn,
      prompt: `问题 ${turn}`,
      response: `回答 ${turn}`,
    })))
    const ctx = makeCtx({ events: { [SELF]: events }, llmOptions: { text: '摘要：短。' } })
    const text = await expandQuoteHandlesForAgent(ctx, makeAgent({
      texts: ['〔9999aaaa#0〕 〔9999aaaa#1〕 〔9999aaaa#2〕'],
      events,
    }))
    assert.equal(countBlocks(text), 2)
    assert.ok(text.includes('（另有 1 条引用未展开：超出单条消息引用配额）'), text)
    assert.equal(Object.keys(await readLedger(home, SELF)).length, 2)
  })
})

await test('句柄格式错误：按没有句柄处理，不记账', async () => {
  await withTempHome(async home => {
    const events = makeEvents([{ prompt: '问题', response: '回答' }])
    const ctx = makeCtx({ events: { [SELF]: events } })
    const text = await expandQuoteHandlesForAgent(ctx, makeAgent({ texts: ['〔abc#1〕'], events }))
    assert.equal(text, '')
    assert.equal(await readLedger(home, SELF), null)
  })
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const failure of failures) console.error(`\n${failure.name}\n${failure.error.stack}`)
  process.exit(1)
}
