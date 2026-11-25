/**
 * 引用自动展开测试（显示指针、wire 摘要）。
 *
 * 引用只有摘要档：`〔xxxxxxxx#N〕`。自动展开挂在异步
 * `system-prompt/assemble` waterfall 上，注入 `topic-map:引用摘要`：
 * 有摘要缓存用缓存，没有就现算；失败降级为回答前 400 字并标注。
 *
 * Run: node tests/quote-expansion.mjs
 */

import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  expandQuoteHandlesForAgent,
  flushIndexSyncs,
  registerQuoteExpansion,
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
const TARGET_DEDUPE = 'session-4c42ff37-aaaa-4bbb-8ccc-000000000002'
const TARGET_LOG = 'session-4c42ff38-aaaa-4bbb-8ccc-000000000003'
const TARGET_MISS = 'session-4c42ff39-aaaa-4bbb-8ccc-000000000004'
const TARGET_LIMIT = 'session-4c42ff3a-aaaa-4bbb-8ccc-000000000005'
const TARGET_WIRE = 'session-4c42ff3b-aaaa-4bbb-8ccc-000000000006'
const TARGET_FALLBACK = 'session-4c42ff3c-aaaa-4bbb-8ccc-000000000007'
const OTHER = 'session-deadbeef-1111-4aaa-8bbb-000000000002'

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
    push('turn/end', { turn, reason: { kind: spec.endReason ?? 'completed' } }, start + 5000)
  })
  return events
}

/** 假模型：记录调用次数；可 gate 卡住；可失败。 */
function makeFakeLlm(options = {}) {
  const state = { calls: 0 }
  return {
    get calls() {
      return state.calls
    },
    async prepareCall(call) {
      state.calls += 1
      return {
        config: { ...call, provider: 'fake', model: 'fake-1' },
        async *stream() {
          if (options.gate !== undefined) await options.gate.promise
          if (options.fail === true) throw new Error('model down')
          yield { type: 'text-delta', text: options.text ?? '摘要：跳转问题定位并修复。' }
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
  const revisions = options.revisions ?? {}
  const llm = options.llm === undefined ? makeFakeLlm(options.llmOptions) : options.llm
  const workspaces = options.workspaces ?? [{
    id: 'ws-1',
    path: 'E:\\\\ws',
    title: '工作区 A',
    sessionIds: options.sessions ?? Object.keys(events),
  }]
  const ctx = {
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
    },
    sessionPersistence: {
      async stat(id) {
        if (typeof options.stat === 'function') return options.stat(id)
        return { revision: revisions[id] ?? 'rev-1' }
      },
    },
    llm,
  }
  return ctx
}

/** 构造 Agent：deriveMessages 返回人写消息，snapshotEvents 给当前会话的日志。 */
function makeAgent(options = {}) {
  const messages = (options.texts ?? []).map((text, index) => ({
    id: `msg-${index}`,
    role: options.role ?? 'user',
    source: { kind: options.sourceKind ?? 'user' },
    content: [{ type: 'text', text }],
  }))
  return {
    id: options.id ?? CALLER,
    session: {
      header: { cwd: options.cwd ?? 'E:\\\\ws' },
      deriveMessages: () => messages,
      snapshotEvents: () => options.events ?? [],
    },
  }
}

async function withTempHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'quote-expansion-'))
  const saved = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    return await fn(home)
  } finally {
    await flushIndexSyncs()
    if (saved === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = saved
    await rm(home, { recursive: true, force: true })
  }
}

function countBlocks(text) {
  return (text.match(/〔引用摘要 /g) ?? []).length
}

console.log('\nquote-expansion')

// ── 摘要档展开 ──────────────────────────────────────────────────────

await test('历史会话：句柄展开成摘要块，不再注入全文', async () => {
  await withTempHome(async () => {
    const events = {
      [TARGET]: makeEvents([
        { prompt: '第一轮问题', response: '第一轮回答' },
        { prompt: '第二轮：把跳转修好', response: '定位逻辑改好了。' },
      ]),
    }
    const llm = makeFakeLlm({ text: '摘要：第二轮定位跳转问题并修复。' })
    const ctx = makeCtx({ events, llm })
    await syncSessionIndexFor(ctx, TARGET)
    const agent = makeAgent({ texts: ['继续看这个 〔4c42ff36#1〕 的结论'] })

    const text = await expandQuoteHandlesForAgent(ctx, agent)
    assert.ok(text.includes('〔引用摘要 4c42ff36#1〕'), text)
    assert.ok(text.includes('摘要：第二轮定位跳转问题并修复。'), text)
    assert.equal(text.includes('第二轮：把跳转修好'), false, '不应把全文提问塞进去')
    assert.equal(text.includes('定位逻辑改好了。'), false, '不应把全文回答塞进去')
    assert.equal(countBlocks(text), 1)
    assert.equal(llm.calls, 1)

    const sample = text.slice(0, 160)
    console.log(`       样例（${text.length} 字，约 ${Math.ceil(text.length / 1.5)} tokens）：${sample.replace(/\n/g, ' / ')}…`)
  })
})

await test('只认无后缀句柄：带 ·全文 的旧形态不展开', async () => {
  await withTempHome(async () => {
    const llm = makeFakeLlm()
    const ctx = makeCtx({ events: { [TARGET]: makeEvents([{ prompt: '甲' }]) }, llm })
    await syncSessionIndexFor(ctx, TARGET)

    assert.equal(await expandQuoteHandlesForAgent(ctx, makeAgent({ texts: ['〔4c42ff36#0·全文〕'] })), '')
    assert.equal(llm.calls, 0, '后缀句柄不该触发模型调用')

    const mixed = await expandQuoteHandlesForAgent(
      ctx,
      makeAgent({ texts: ['旧写法 〔4c42ff36#0·全文〕，新写法 〔4c42ff36#0〕'] }),
    )
    assert.equal(countBlocks(mixed), 1, '同一轮只展开一次')
  })
})

await test('没有句柄 / 非人类消息：不注入', async () => {
  await withTempHome(async () => {
    const ctx = makeCtx({ events: { [TARGET]: makeEvents([{ prompt: '甲' }]) } })
    await syncSessionIndexFor(ctx, TARGET)

    assert.equal(await expandQuoteHandlesForAgent(ctx, makeAgent({ texts: ['普通消息，没有引用'] })), '')
    const injected = makeAgent({
      texts: ['〔4c42ff36#0〕'],
      sourceKind: 'agent-message',
    })
    assert.equal(await expandQuoteHandlesForAgent(ctx, injected), '')
    const assistant = makeAgent({ texts: ['〔4c42ff36#0〕'], role: 'assistant' })
    assert.equal(await expandQuoteHandlesForAgent(ctx, assistant), '')
  })
})

await test('同一句柄去重；多个句柄按出现顺序展开', async () => {
  await withTempHome(async () => {
    const ctx = makeCtx({
      events: { [TARGET_DEDUPE]: makeEvents([{ prompt: '甲' }, { prompt: '乙' }]) },
    })
    await syncSessionIndexFor(ctx, TARGET_DEDUPE)
    const agent = makeAgent({
      texts: ['看 〔4c42ff37#1〕 和 〔4c42ff37#0〕，再看一次 〔4c42ff37#1〕'],
    })
    const text = await expandQuoteHandlesForAgent(ctx, agent)
    assert.equal(countBlocks(text), 2)
    assert.ok(text.indexOf('4c42ff37#1') < text.indexOf('4c42ff37#0'), '应按出现顺序')
  })
})

await test('当前会话：直接读内存日志并生成摘要，不依赖索引', async () => {
  await withTempHome(async () => {
    const sameSessionEvents = makeEvents([{ prompt: '自己的问题', response: '自己的回答' }])
    const ctx = makeCtx({ events: { [CALLER]: sameSessionEvents } })
    // 故意不建索引。
    const agent = makeAgent({
      id: CALLER,
      texts: ['回看 〔9999aaaa#0〕'],
      events: sameSessionEvents,
    })
    const text = await expandQuoteHandlesForAgent(ctx, agent)
    assert.ok(text.includes('〔引用摘要 9999aaaa#0〕'), text)
    assert.ok(text.includes('摘要：'), text)
  })
})

await test('目标会话没有索引：退回日志读取后再生成摘要', async () => {
  await withTempHome(async () => {
    const longResponse = `${'铺'.repeat(400)}兜底尾巴`
    const ctx = makeCtx({
      events: { [TARGET_LOG]: makeEvents([{ prompt: '目标问题', response: longResponse }]) },
    })
    const agent = makeAgent({ texts: ['〔4c42ff38#0〕'] })
    const text = await expandQuoteHandlesForAgent(ctx, agent)
    assert.ok(text.includes('摘要：'), text)
    assert.equal(text.includes('铺铺铺'), false, '摘要档不应回退成全文')
  })
})

await test('轮次不存在 / 读取失败：给出可读说明而不是抛错', async () => {
  await withTempHome(async () => {
    const missEvents = makeEvents([{ prompt: '甲' }])
    const readable = makeCtx({
      events: { [TARGET_MISS]: missEvents },
      sessions: [TARGET_MISS],
    })
    const noTurn = await expandQuoteHandlesForAgent(readable, makeAgent({ texts: ['〔4c42ff39#99〕'] }))
    assert.ok(noTurn.includes('没有第 99 轮'), noTurn)

    const broken = makeCtx({
      events: {},
      sessions: [TARGET_MISS],
      readSession: async () => {
        throw new Error('read failed')
      },
      stat: async () => {
        throw new Error('stat failed')
      },
    })
    const unreadable = await expandQuoteHandlesForAgent(broken, makeAgent({ texts: ['〔4c42ff39#0〕'] }))
    assert.ok(unreadable.includes('这个会话已归档，内容读不到'), unreadable)
  })
})

await test('前缀无匹配 / 跨工作区不泄露', async () => {
  await withTempHome(async () => {
    const ctx = makeCtx({
      events: {
        [OTHER]: makeEvents([{ prompt: '别的工区机密', response: '不该出现' }]),
      },
      sessions: [CALLER],
      workspaces: [
        { id: 'ws-1', path: 'E:\\\\ws', title: '工作区 A', sessionIds: [CALLER] },
        { id: 'ws-2', path: 'E:\\\\other', title: '工作区 B', sessionIds: [OTHER] },
      ],
    })
    const agent = makeAgent({ texts: ['〔deadbeef#0〕'] })
    const text = await expandQuoteHandlesForAgent(ctx, agent)
    assert.ok(text.includes('没有匹配该前缀') || text.includes('歧义'), text)
    assert.equal(text.includes('别的工区机密'), false)
  })
})

await test('摘要生成失败：降级为回答前 400 字并标注，插入不受影响', async () => {
  await withTempHome(async () => {
    const answer = '答'.repeat(1000)
    const ctx = makeCtx({
      events: { [TARGET_FALLBACK]: makeEvents([{ prompt: '问题', response: answer }]) },
      sessions: [TARGET_FALLBACK],
      llm: makeFakeLlm({ fail: true }),
    })
    const text = await expandQuoteHandlesForAgent(ctx, makeAgent({ texts: ['〔4c42ff3c#0〕'] }))
    assert.ok(text.includes('（摘要生成失败，以下是回答开头）'), text)
    assert.ok(text.includes('答'.repeat(400)), `应保留回答前 400 字；实际：${JSON.stringify(text.slice(0, 800))}`)
    assert.equal(text.includes('答'.repeat(401)), false, '不应超过 400 字')
    assert.ok(text.startsWith('〔引用摘要 4c42ff3c#0〕'), text)
  })
})

await test('摘要 ≤400 字、四个句柄都展开（默认配额内）', async () => {
  await withTempHome(async () => {
    const long = '答'.repeat(20000)
    const ctx = makeCtx({
      events: {
        [TARGET_LIMIT]: makeEvents([
          { prompt: '一', response: long },
          { prompt: '二', response: long },
          { prompt: '三', response: long },
          { prompt: '四', response: long },
        ]),
      },
      sessions: [TARGET_LIMIT],
      llmOptions: { text: '要'.repeat(600) },
    })
    await syncSessionIndexFor(ctx, TARGET_LIMIT)
    const agent = makeAgent({
      texts: ['〔4c42ff3a#0〕 〔4c42ff3a#1〕 〔4c42ff3a#2〕 〔4c42ff3a#3〕'],
    })
    const text = await expandQuoteHandlesForAgent(ctx, agent)
    assert.equal(countBlocks(text), 4, '默认配额 5 条，四个句柄都应展开')
    assert.equal(text.includes('要'.repeat(401)), false, '摘要应封顶 400 字')
    assert.ok(text.length < 3000, `摘要总量不应回到全文量级：${text.length}`)
  })
})

// ── waterfall 接线 / 全局性 / 当前消息 ─────────────────────────────

await test('注册在 system-prompt/assemble waterfall：追加摘要 context，且同一 assembly 不重复注入', async () => {
  await withTempHome(async () => {
    const ctx = makeCtx({
      events: { [TARGET_WIRE]: makeEvents([{ prompt: '引用问题', response: '引用回答' }]) },
      sessions: [TARGET_WIRE],
      llm: makeFakeLlm({ text: '摘要：引用回答的结论。' }),
    })
    await syncSessionIndexFor(ctx, TARGET_WIRE)

    let assembleHandler = null
    let claimedHandler = null
    const scope = {
      ...ctx,
      on(name, fn) {
        if (name === 'system-prompt/assemble') assembleHandler = fn
        else if (name === 'agent/inbox/claimed') claimedHandler = fn
        else throw new Error(`unexpected event ${name}`)
        return () => {}
      },
      effect(fn) {
        return fn()
      },
    }
    const fake = {
      inject(names, callback) {
        assert.deepEqual(names, ['systemPrompt'])
        callback(scope)
      },
    }
    registerQuoteExpansion(fake)
    assert.equal(typeof assembleHandler, 'function')
    assert.equal(typeof claimedHandler, 'function', '应监听 claimed 消息')

    const assembly = { sections: [], contexts: [{ name: 'existing', text: '原有' }], tools: [], variables: {} }
    const agent = makeAgent({ texts: ['〔4c42ff3b#0〕'] })
    const result = await assembleHandler(assembly, { agent, scope: agent }, async () => assembly)
    assert.equal(result.contexts.length, 2)
    assert.equal(result.contexts[1].name, 'topic-map:引用摘要')
    assert.equal(result.contexts[1].interpolate, false)
    assert.ok(result.contexts[1].text.includes('摘要：引用回答的结论。'))

    // 同一个 assembly 第二次进入：不应再追加一层。
    const again = await assembleHandler(assembly, { agent, scope: agent }, async () => assembly)
    assert.equal(again.contexts.length, 1, '同一 assembly 只处理一次')

    const untouched = await assembleHandler(
      { ...assembly },
      {},
      async () => ({ ...assembly }),
    )
    assert.equal(untouched.contexts.length, 1, '没有 agent 时不应注入')
  })
})

await test('全局注册：两个不同会话的 assembly 都能注入', async () => {
  await withTempHome(async () => {
    const sessions = [TARGET_WIRE, TARGET_DEDUPE]
    const ctx = makeCtx({
      events: {
        [TARGET_WIRE]: makeEvents([{ prompt: '甲', response: '回答甲' }]),
        [TARGET_DEDUPE]: makeEvents([{ prompt: '乙', response: '回答乙' }]),
      },
      sessions,
      llm: makeFakeLlm({ text: '摘要：跨会话也注入。' }),
    })
    await syncSessionIndexFor(ctx, TARGET_WIRE)
    await syncSessionIndexFor(ctx, TARGET_DEDUPE)

    let assembleHandler = null
    const scope = {
      ...ctx,
      on(name, fn) {
        if (name === 'system-prompt/assemble') assembleHandler = fn
        return () => {}
      },
      effect(fn) {
        return fn()
      },
    }
    registerQuoteExpansion({ inject(names, callback) { callback(scope) } })

    const agentA = makeAgent({ id: 'session-aaaa1111-0000-4000-8000-000000000001', texts: ['〔4c42ff3b#0〕'] })
    const agentB = makeAgent({ id: 'session-bbbb2222-0000-4000-8000-000000000002', texts: ['〔4c42ff37#0〕'] })
    const assemblyA = { sections: [], contexts: [], tools: [], variables: {} }
    const assemblyB = { sections: [], contexts: [], tools: [], variables: {} }
    const resultA = await assembleHandler(assemblyA, { agent: agentA }, async () => assemblyA)
    const resultB = await assembleHandler(assemblyB, { agent: agentB }, async () => assemblyB)
    assert.equal(resultA.contexts.length, 1)
    assert.equal(resultB.contexts.length, 1)
    assert.ok(resultA.contexts[0].text.includes('摘要：跨会话也注入。'))
    assert.ok(resultB.contexts[0].text.includes('摘要：跨会话也注入。'))
    assert.equal(resultA.contexts[0].name, 'topic-map:引用摘要')
  })
})

await test('当前会话不在 workspace registry：同会话引用靠内存快照命中', async () => {
  await withTempHome(async () => {
    const selfSession = 'session-9999aaaa-1111-4aaa-8bbb-000000000001'
    const selfEvents = makeEvents([
      { prompt: '自己之前的轮次', response: '已修复。' },
    ])
    const ctx = makeCtx({
      events: { [selfSession]: selfEvents },
      workspaces: [], // 故意模拟 /workspaces 里没有 E:\dsh_plugin
      llm: makeFakeLlm({ text: '摘要：同会话引用命中。' }),
    })
    // 当前会话不进索引/工作区，也要能命中。
    const agent = makeAgent({ id: selfSession, texts: ['回看 〔9999aaaa#0〕'], events: selfEvents })
    const text = await expandQuoteHandlesForAgent(ctx, agent)
    assert.ok(text.includes('〔引用摘要 9999aaaa#0〕'), text)
    assert.ok(text.includes('摘要：同会话引用命中。'), text)
  })
})

await test('工作区元数据缺失：用会话目录/索引目录兜底匹配跨会话引用', async () => {
  await withTempHome(async () => {
    const ctx = makeCtx({
      events: { [TARGET_LOG]: makeEvents([{ prompt: '目标轮', response: '目标回答' }]) },
      workspaces: [],
      llm: makeFakeLlm({ text: '摘要：会话目录兜底命中。' }),
    })
    await syncSessionIndexFor(ctx, TARGET_LOG)

    const agent = makeAgent({ id: 'session-cccc3333-0000-4000-8000-000000000003', texts: ['〔4c42ff38#0〕'] })
    const text = await expandQuoteHandlesForAgent(ctx, agent)
    assert.ok(text.includes('〔引用摘要 4c42ff38#0〕'), text)
    assert.ok(text.includes('摘要：会话目录兜底命中。'))
  })
})

await test('当前正在发送的消息：assembly 时从 claimed 缓存取到并注入', async () => {
  await withTempHome(async () => {
    const selfSession = 'session-9999aaaa-1111-4aaa-8bbb-000000000001'
    const selfEvents = makeEvents([{ prompt: '历史问题', response: '历史回答' }])
    const ctx = makeCtx({
      events: { [selfSession]: selfEvents },
      workspaces: [],
      llm: makeFakeLlm({ text: '摘要：当前消息也能命中。' }),
    })

    let assembleHandler = null
    let claimedHandler = null
    const scope = {
      ...ctx,
      on(name, fn) {
        if (name === 'system-prompt/assemble') assembleHandler = fn
        else if (name === 'agent/inbox/claimed') claimedHandler = fn
        return () => {}
      },
      effect(fn) {
        return fn()
      },
    }
    registerQuoteExpansion({ inject(names, callback) { callback(scope) } })

    const agent = makeAgent({ id: selfSession, texts: [], events: selfEvents })
    const message = {
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text: '看这个 〔9999aaaa#0〕' }],
    }
    claimedHandler({ agent, message, turn: 1 })

    const assembly = { sections: [], contexts: [], tools: [], variables: {} }
    const result = await assembleHandler(assembly, { agent }, async () => assembly)
    assert.equal(result.contexts.length, 1, '当前未落库的消息也必须展开')
    assert.ok(result.contexts[0].text.includes('〔引用摘要 9999aaaa#0〕'))

    // pending 只消费一次；历史里仍没有句柄，下一次不应重复注入。
    const next = { sections: [], contexts: [], tools: [], variables: {} }
    const after = await assembleHandler(next, { agent }, async () => next)
    assert.equal(after.contexts.length, 0)
  })
})

await test('宿主没有 systemPrompt 服务：注册不崩', () => {
  assert.doesNotThrow(() => registerQuoteExpansion({ inject() {} }))
  assert.doesNotThrow(() => registerQuoteExpansion({}))
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const failure of failures) console.error(`\n${failure.name}\n${failure.error.stack}`)
  process.exit(1)
}
