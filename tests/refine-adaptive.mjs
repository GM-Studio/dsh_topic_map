/**
 * 语义提炼的自适应降级测试（ADR-0010 补充）。
 *
 * 真机现象：3 个工作区 refineStatus.reason='timeout'，1 个 'invalid_json'。
 * 根因有二：
 *   1. COLD_START_MODEL_MAX_TOKENS=4096 正是 llm-call.js 注释里点名的病态值
 *      （带推理的模型先花掉一大截预算，正文一个字没有 → 截断 → invalid_json）；
 *   2. 单批 40 簇 + 25s 上限，一批超时整批作废，没有降级路径。
 *
 * 本测试锁住修法：超时的批**对半拆开重试**，而不是整批丢弃。
 * Run: node tests/refine-adaptive.mjs
 */
import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { scanWorkspaceWorks } from '../lib/work-store.js'

let passed = 0
const failures = []
async function test(name, fn) {
  try { await fn(); passed += 1; console.log('  ok   ' + name) }
  catch (e) { failures.push({ name, e }); console.log('  FAIL ' + name + '\n       ' + e.message) }
}

const BASE_TIME = 1_700_000_000_000
const WS = 'ws-adaptive-1'

async function withTempHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'refine-adaptive-'))
  const saved = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try { return await fn(home) }
  finally {
    if (saved === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = saved
    await rm(home, { recursive: true, force: true })
  }
}

function makeEvents(specs, baseTime = BASE_TIME) {
  let seq = 0
  const events = []
  const push = (type, data, time) => events.push({ type, seq: seq++, time, data })
  specs.forEach((spec, index) => {
    const start = baseTime + index * 60_000
    const turn = index
    push('turn/start', { turn }, start)
    push('user/message', { content: [{ type: 'text', text: spec.prompt }], source: { kind: 'user' } }, start + 100)
    for (const tc of (spec.toolCalls || [])) push('tool/call', { name: tc.name, arguments: tc.arguments }, start + 500)
    push('assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: spec.response }], source: { kind: 'model', provider: 'fake', model: 'fake-1' } } }, start + 1000)
    push('turn/end', { turn, reason: { kind: 'completed' } }, start + 5000)
  })
  return events
}

function makeIndependentSessions(count) {
  const events = {}
  const sessionIds = []
  for (let i = 0; i < count; i += 1) {
    const sessionId = 'session-' + String(i).padStart(4, '0') + 'aaaa-1111-4aaa-8bbb-' + String(i).padStart(12, '0')
    sessionIds.push(sessionId)
    events[sessionId] = makeEvents([{
      prompt: '处理模块 mod-' + i + ' 的独立任务，改动 lib/mod-' + i + '.js',
      response: '完成 mod-' + i,
      toolCalls: [{ name: 'edit', arguments: { file_path: 'lib/mod-' + i + '.js' } }],
    }], BASE_TIME + i * 60_000)
  }
  return { events, sessionIds }
}

function makeCtx(events) {
  const sessionIds = Object.keys(events)
  const workspaces = [{ id: WS, path: 'E:\\adaptive-ws', title: '自适应测试', sessionIds }]
  return {
    get(name) { if (name === 'workspaceRegistry') return { list: () => workspaces }; return undefined },
    on() { return () => {} },
    effect(fn) { return fn() },
    sessionQuery: {
      async readSession(id) { return (id in events) ? { header: { id }, events: events[id] } : null },
      async listSessions() { return sessionIds.map(id => ({ header: { id } })) },
      async readTitleSnapshots(ids) { return ids.map(sessionId => ({ sessionId, status: 'fulfilled', value: { title: { title: 'S ' + sessionId.slice(0, 8) } } })) },
    },
    sessionPersistence: { async stat() { return { revision: 'rev-1' } } },
    workspaceChanges: { async summary() { return undefined } },
  }
}

function clusterIdsIn(prompt) {
  const ids = []
  const re = /\[(cl-\d+)\]/g
  let m = re.exec(prompt.user || '')
  while (m !== null) { ids.push(m[1]); m = re.exec(prompt.user || '') }
  return ids
}

function replyFor(ids) {
  return JSON.stringify({
    works: [{ clusterIds: ids, title: '提炼 ' + ids.join('+'), goal: 'g', state: 'active', statusSummary: 's', nextStep: 'n', decisions: [] }],
    chatClusterIds: [],
  })
}

function timeoutError() {
  const e = new Error('semantic model timeout after 45000ms')
  e.name = 'AbortError'
  return e
}

await test('超时批对半拆开重试：大工作区不再因一批超时整批作废', async () => {
  await withTempHome(async () => {
    const { events } = makeIndependentSessions(8)
    const ctx = makeCtx(events)
    let calls = 0
    const seenSizes = []
    const deps = {
      async askModel(_ctx, prompt) {
        calls += 1
        const ids = clusterIdsIn(prompt)
        seenSizes.push(ids.length)
        // 模拟真机：一次给太多簇就超时；给小批就能成。
        if (ids.length > 2) throw timeoutError()
        return replyFor(ids)
      },
    }
    const res = await scanWorkspaceWorks(ctx, WS, {
      force: true, useModel: true, config: {}, deps, now: BASE_TIME + 3_600_000,
    })
    assert.equal(res.ok, true, '扫描本身必须成功（首帧规则结果照常返回）')
    assert.ok(calls > 1, '必须发生多次调用（说明确实拆批重试了），实际 ' + calls)
    assert.equal(res.refineStatus.used, true, '拆分后应最终提炼成功')
    assert.equal(res.refineStatus.reason, 'ok', 'reason 应为 ok，实际 ' + res.refineStatus.reason)
    const refinedTitles = (res.store.works || []).filter(w => String(w.title).indexOf('提炼 ') === 0)
    assert.ok(refinedTitles.length >= 4, '拆分后应覆盖多批结果，实际 ' + refinedTitles.length)
  })
})

await test('即使全部超时也不静默：reason=timeout 且首帧规则结果仍在', async () => {
  await withTempHome(async () => {
    const { events } = makeIndependentSessions(4)
    const ctx = makeCtx(events)
    const deps = { async askModel() { throw timeoutError() } }
    const res = await scanWorkspaceWorks(ctx, WS, { force: true, useModel: true, config: {}, deps, now: BASE_TIME + 3_600_000 })
    assert.equal(res.ok, true, '扫描不能失败')
    assert.equal(res.refineStatus.used, false)
    assert.equal(res.refineStatus.reason, 'timeout', '应如实记为 timeout')
    assert.ok(res.store.works.length > 0, '规则兜底的事必须还在')
    assert.ok(res.cards.unresolved.length > 0, '卡片必须仍有内容，不能因为提炼失败就清空')
  })
})

await test('模型返回非法 JSON 时如实记 invalid_json，不谎报成功', async () => {
  await withTempHome(async () => {
    const { events } = makeIndependentSessions(3)
    const ctx = makeCtx(events)
    const deps = { async askModel() { return '这不是 JSON' } }
    const res = await scanWorkspaceWorks(ctx, WS, { force: true, useModel: true, config: {}, deps, now: BASE_TIME + 3_600_000 })
    assert.equal(res.refineStatus.used, false)
    assert.equal(res.refineStatus.reason, 'invalid_json')
  })
})

await test('没配模型时记 no_model，而不是假装跑过', async () => {
  await withTempHome(async () => {
    const { events } = makeIndependentSessions(2)
    const ctx = makeCtx(events)
    const res = await scanWorkspaceWorks(ctx, WS, { force: true, useModel: true, config: {}, now: BASE_TIME + 3_600_000 })
    assert.equal(res.refineStatus.used, false)
    assert.equal(res.refineStatus.reason, 'no_model', '实际 ' + res.refineStatus.reason)
  })
})

await test('maxTokens 不得是 4096 这个病态值（推理模型会截断成空正文）', async () => {
  await withTempHome(async () => {
    const { events } = makeIndependentSessions(2)
    const ctx = makeCtx(events)
    let seenMaxTokens = null
    const deps = {
      async askModel(_ctx, prompt, options) {
        if (seenMaxTokens === null) seenMaxTokens = options && options.maxTokens
        return replyFor(clusterIdsIn(prompt))
      },
    }
    await scanWorkspaceWorks(ctx, WS, { force: true, useModel: true, config: {}, deps, now: BASE_TIME + 3_600_000 })
    assert.ok(Number(seenMaxTokens) >= 8192, 'maxTokens 应 >= 8192（推理预算），实际 ' + seenMaxTokens)
  })
})

await test('适配器已缺失的历史路由：不再硬失败，改走可用适配器', async () => {
  await withTempHome(async () => {
    const { events } = makeIndependentSessions(2)
    const ctx = makeCtx(events)
    // 模拟宿主：只有一个可用 provider，且必须带具体 model 才接受。
    const llm = {
      listProviders() { return [{ id: 'good-provider', models: ['good-model'] }] },
      prepareCall(call) {
        if (call.provider !== 'good-provider' || call.model !== 'good-model') {
          throw new Error('no adapter registered for provider "' + call.provider + '"')
        }
        return { config: call, stream: async function* () {
          yield { type: 'text-delta', text: replyFor(clusterIdsIn({ user: String(call.messages[0].content[0].text) })) }
          yield { type: 'finish', reason: { kind: 'stop' } }
        } }
      },
    }
    ctx.get = name => (name === 'llm' ? llm : (name === 'workspaceRegistry' ? { list: () => [{ id: WS, path: 'E:\\w', title: 'W', sessionIds: Object.keys(events) }] } : undefined))
    const res = await scanWorkspaceWorks(ctx, WS, { force: true, useModel: true, config: {}, now: BASE_TIME + 3_600_000 })
    assert.equal(res.refineStatus.used, true, '应降级到可用适配器并成功，实际 ' + JSON.stringify(res.refineStatus))
    assert.equal(res.refineStatus.reason, 'ok')
  })
})

await test('账户余额不足：如实归类为 failed 并带出原文，不谎报成功', async () => {
  await withTempHome(async () => {
    const { events } = makeIndependentSessions(2)
    const ctx = makeCtx(events)
    const deps = { async askModel() { throw new Error('Insufficient Balance (request_id: abc)') } }
    const res = await scanWorkspaceWorks(ctx, WS, { force: true, useModel: true, config: {}, deps, now: BASE_TIME + 3_600_000 })
    assert.equal(res.refineStatus.used, false)
    assert.equal(res.refineStatus.reason, 'failed')
    assert.ok(String(res.refineStatus.detail).indexOf('Insufficient Balance') >= 0, '必须带出具体原因，实际 ' + res.refineStatus.detail)
  })
})

await test('失败原因要具体可见：detail 不得为空', async () => {
  await withTempHome(async () => {
    const { events } = makeIndependentSessions(2)
    const ctx = makeCtx(events)
    const deps = { async askModel() { throw new Error('boom 具体原因') } }
    const res = await scanWorkspaceWorks(ctx, WS, { force: true, useModel: true, config: {}, deps, now: BASE_TIME + 3_600_000 })
    assert.ok(String(res.refineStatus.detail || '').trim() !== '', 'detail 必须非空')
    assert.ok(String(res.refineStatus.detail).indexOf('boom') >= 0)
  })
})

await test('适配器缺失归类为 no_model（不是 failed）', async () => {
  await withTempHome(async () => {
    const { events } = makeIndependentSessions(2)
    const ctx = makeCtx(events)
    const deps = { async askModel() { throw new Error('no adapter registered for provider "gone"') } }
    const res = await scanWorkspaceWorks(ctx, WS, { force: true, useModel: true, config: {}, deps, now: BASE_TIME + 3_600_000 })
    assert.equal(res.refineStatus.reason, 'no_model', '实际 ' + res.refineStatus.reason)
  })
})
console.log('')
console.log('refine-adaptive: ' + passed + ' passed, ' + failures.length + ' failed')
if (failures.length > 0) process.exit(1)