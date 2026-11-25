/**
 * `/turn-digest` 与摘要后台预生成测试。
 *
 * 锁：提示词约束、缓存形状/命中、revision 失效、force、模型失败降级，
 * 以及 `/turn-detail` 成功后只入队、不等待模型（gate 卡住模型验证）。
 *
 * Run: node tests/turn-digest.mjs
 */

import { strict as assert } from 'node:assert'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  flushIndexSyncs,
  flushTurnDigests,
  generateTurnDigest,
  getDigestDiagnostics,
  readTurnDetail,
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
const SESSION = 'session-4c42ff36-aaaa-4bbb-8ccc-000000000001'
const SESSION_GATE = 'session-4c42ff37-aaaa-4bbb-8ccc-000000000002'
const SESSION_FAIL = 'session-4c42ff38-aaaa-4bbb-8ccc-000000000003'

function makeEvents(specs) {
  let seq = 0
  const events = []
  const push = (type, data, time) => events.push({ type, seq: seq++, time, data })
  specs.forEach((spec, index) => {
    const start = BASE_TIME + index * 60_000
    const turn = spec.turn ?? index
    push('turn/start', { turn }, start)
    push('user/message', {
      content: [{ type: 'text', text: spec.prompt ?? `第 ${turn} 轮问题` }],
      source: { kind: 'user' },
    }, start + 100)
    for (const command of spec.commands ?? []) {
      push('tool/call', { name: 'ops_bash', arguments: JSON.stringify({ command }) }, start + 200)
    }
    push('assistant/message', {
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: spec.response ?? `第 ${turn} 轮回答` }],
        source: { kind: 'model', provider: 'agent2api', model: 'DeepSeek-Flash' },
      },
    }, start + 1000)
    push('turn/end', { turn, reason: { kind: spec.endReason ?? 'completed' } }, start + 5000)
  })
  return events
}

/** 假模型：记录 system/user/调用次数；可 gate；可失败。 */
function makeFakeLlm(options = {}) {
  const state = { calls: 0, systems: [], users: [] }
  return {
    get calls() {
      return state.calls
    },
    get systems() {
      return state.systems
    },
    get users() {
      return state.users
    },
    async prepareCall(call) {
      state.calls += 1
      state.systems.push(String(call.system ?? ''))
      state.users.push(String(call.messages?.[0]?.content?.[0]?.text ?? ''))
      return {
        config: { ...call, provider: 'fake', model: 'fake-1' },
        async *stream() {
          if (options.gate !== undefined) await options.gate.promise
          if (options.fail === true) throw new Error('model down')
          yield { type: 'text-delta', text: options.text ?? '摘要：结论是跳转逻辑已修复。' }
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
    },
    sessionPersistence: {
      async stat(id) {
        if (typeof options.stat === 'function') return options.stat(id)
        return { revision: revisions[id] ?? 'rev-1' }
      },
    },
    llm,
  }
}

async function withTempHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'turn-digest-'))
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

function digestPath(home, sessionId, turn) {
  return join(home, 'topic-map', 'digests', `${sessionId}#${turn}.json`)
}

async function waitFor(check, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return true
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  return false
}

console.log('\nturn-digest')

await test('提示词包含 ≤400 字/保留结论命令文件/不要复述过程', async () => {
  await withTempHome(async () => {
    const llm = makeFakeLlm()
    const ctx = makeCtx({
      events: {
        [SESSION]: makeEvents([{
          prompt: '把跳转修好',
          response: '定位逻辑改好了。',
          commands: ['npm test'],
        }]),
      },
      llm,
    })
    const result = await generateTurnDigest(ctx, { sessionId: SESSION, turn: 0 })
    assert.equal(result.ok, true, result.error)
    assert.equal(result.value.cached, false)
    assert.ok(result.value.chars <= 400)
    assert.equal(result.value.chars, result.value.summary.length)
    assert.equal(result.value.revision, 'rev-1')

    assert.equal(llm.calls, 1)
    const system = llm.systems[0]
    const user = llm.users[0]
    for (const wording of ['400', '结论', '关键决定', '命令', '文件', '不要复述过程']) {
      assert.ok(`${system}\n${user}`.includes(wording), `提示词缺少约束：${wording}`)
    }
    assert.ok(user.includes('提问：') && user.includes('回答：'), '提示词应带上提问/回答')
    assert.ok(user.includes('npm test'), '提示词应带上命令')
  })
})

await test('缓存命中：第二次不调模型；revision 变化重算；force 重算', async () => {
  await withTempHome(async () => {
    const revisions = { [SESSION]: 'rev-1' }
    const llm = makeFakeLlm()
    const ctx = makeCtx({
      events: { [SESSION]: makeEvents([{ prompt: '甲', response: '乙' }]) },
      revisions,
      llm,
    })

    const first = await generateTurnDigest(ctx, { sessionId: SESSION, turn: 0 })
    assert.equal(first.ok, true, first.error)
    assert.equal(first.value.cached, false)
    assert.equal(llm.calls, 1)

    const second = await generateTurnDigest(ctx, { sessionId: SESSION, turn: 0 })
    assert.equal(second.ok, true)
    assert.equal(second.value.cached, true)
    assert.equal(second.value.summary, first.value.summary)
    assert.equal(llm.calls, 1, '缓存命中不应再调模型')

    revisions[SESSION] = 'rev-2'
    const changed = await generateTurnDigest(ctx, { sessionId: SESSION, turn: 0 })
    assert.equal(changed.ok, true, changed.error)
    assert.equal(changed.value.cached, false)
    assert.equal(changed.value.revision, 'rev-2')
    assert.equal(llm.calls, 2, 'revision 变了必须重算')

    const forced = await generateTurnDigest(ctx, { sessionId: SESSION, turn: 0, force: true })
    assert.equal(forced.ok, true, forced.error)
    assert.equal(forced.value.cached, false)
    assert.equal(llm.calls, 3, 'force 必须重算')
  })
})

await test('缓存文件形状：{revision,summary,model,at}', async () => {
  await withTempHome(async home => {
    const ctx = makeCtx({
      events: { [SESSION]: makeEvents([{ prompt: '甲', response: '乙' }]) },
    })
    const result = await generateTurnDigest(ctx, { sessionId: SESSION, turn: 0 })
    assert.equal(result.ok, true, result.error)

    const raw = JSON.parse(await readFile(digestPath(home, SESSION, 0), 'utf8'))
    assert.equal(raw.revision, 'rev-1')
    assert.equal(raw.summary, result.value.summary)
    assert.equal(raw.model, 'DeepSeek-Flash')
    assert.ok(Number.isFinite(raw.at) && raw.at > 0)
    assert.deepEqual(Object.keys(raw).sort(), ['at', 'model', 'revision', 'summary'])
  })
})

await test('模型失败/不可用：返回人话错误，不写缓存', async () => {
  await withTempHome(async home => {
    const failed = makeCtx({
      events: { [SESSION]: makeEvents([{ prompt: '甲', response: '乙' }]) },
      llm: makeFakeLlm({ fail: true }),
    })
    const result = await generateTurnDigest(failed, { sessionId: SESSION, turn: 0 })
    assert.equal(result.ok, false)
    assert.equal(result.httpStatus, 502)
    assert.ok(result.error.includes('生成摘要失败'), result.error)
    await assert.rejects(readFile(digestPath(home, SESSION, 0), 'utf8'))

    const unavailable = makeCtx({
      events: { [SESSION]: makeEvents([{ prompt: '甲', response: '乙' }]) },
      llm: null,
    })
    const noModel = await generateTurnDigest(unavailable, { sessionId: SESSION, turn: 0 })
    assert.equal(noModel.ok, false)
    assert.equal(noModel.httpStatus, 503)
    assert.ok(noModel.error.includes('模型不可用'), noModel.error)
  })
})

await test('参数校验：缺 sessionId / 非法 turn / 轮次不存在', async () => {
  await withTempHome(async () => {
    const ctx = makeCtx({ events: { [SESSION]: makeEvents([{ prompt: '甲' }]) } })
    assert.equal((await generateTurnDigest(ctx, { turn: 0 })).httpStatus, 400)
    assert.equal((await generateTurnDigest(ctx, { sessionId: SESSION, turn: -1 })).httpStatus, 400)
    const missing = await generateTurnDigest(ctx, { sessionId: SESSION, turn: 99 })
    assert.equal(missing.ok, false)
    assert.equal(missing.httpStatus, 404)
    assert.ok(missing.error.includes('99'), missing.error)
  })
})

// ── 后台预生成 ──────────────────────────────────────────────────────

await test('/turn-detail 不等待摘要：gate 卡住模型仍立即返回，完成后缓存可命中', async () => {
  await withTempHome(async home => {
    let release
    const gate = { promise: new Promise(resolve => { release = resolve }) }
    const llm = makeFakeLlm({ gate, text: '摘要：详情触发后台生成。' })
    const ctx = makeCtx({
      events: { [SESSION_GATE]: makeEvents([{ prompt: '甲', response: '乙' }]) },
      llm,
    })

    // gate 不释放时若 readTurnDetail 等待摘要，这里会超时失败。
    const detail = await Promise.race([
      readTurnDetail(ctx, { sessionId: SESSION_GATE, turn: 0 }),
      new Promise(resolve => setTimeout(() => resolve({ ok: false, timeout: true }), 500)),
    ])
    assert.equal(detail.ok, true, detail.error ?? 'readTurnDetail 被摘要生成拖住了')

    const started = await waitFor(() => llm.calls > 0)
    assert.equal(started, true, '后台任务没有启动')
    assert.equal(llm.calls, 1)

    release()
    await flushTurnDigests()
    const raw = JSON.parse(await readFile(digestPath(home, SESSION_GATE, 0), 'utf8'))
    assert.equal(raw.summary, '摘要：详情触发后台生成。')

    const second = await generateTurnDigest(ctx, { sessionId: SESSION_GATE, turn: 0 })
    assert.equal(second.ok, true, second.error)
    assert.equal(second.value.cached, true, '后台完成后引用应命中缓存')
    assert.equal(llm.calls, 1, '第二次不应再调模型')
  })
})

await test('后台失败：静默记录一条诊断，不影响 /turn-detail', async () => {
  await withTempHome(async () => {
    const ctx = makeCtx({
      events: { [SESSION_FAIL]: makeEvents([{ prompt: '甲', response: '乙' }]) },
      llm: makeFakeLlm({ fail: true }),
    })
    const before = getDigestDiagnostics().length
    const detail = await readTurnDetail(ctx, { sessionId: SESSION_FAIL, turn: 0 })
    assert.equal(detail.ok, true)
    await flushTurnDigests()
    const diagnostics = getDigestDiagnostics()
    assert.equal(diagnostics.length, before + 1, '后台失败应只记一条诊断')
    assert.ok(diagnostics.at(-1).error.includes('生成摘要失败'), diagnostics.at(-1).error)
  })
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const failure of failures) console.error(`\n${failure.name}\n${failure.error.stack}`)
  process.exit(1)
}
