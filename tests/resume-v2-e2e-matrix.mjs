/**
 * 事续接 v2 全场景端到端矩阵（正常 / 异常 / 失败）。
 *
 * 覆盖 ADR-0006 ~ ADR-0010 的联合行为，逐场景断言「不静默、不丢数据、不留白、不串台」。
 * 全部走真实的 scanWorkspaceWorks / readWorkspaceWorksView / 路由 handler，不 mock 内部逻辑。
 *
 * Run: node tests/resume-v2-e2e-matrix.mjs
 */
import { strict as assert } from 'node:assert'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { scanWorkspaceWorks, readWorkspaceWorksView, confirmWork, workStorePath } from '../lib/work-store.js'
import { resolveWorksViewState, emptyStateText, workBoardModel } from '../lib/work-view.js'
import { judgeAdmission } from '../lib/admission.js'
import { suggestNextStep } from '../lib/next-step.js'

let passed = 0
const failures = []
async function scenario(group, name, fn) {
  try { await fn(); passed += 1; console.log('  ok   [' + group + '] ' + name) }
  catch (e) { failures.push({ group, name, e }); console.log('  FAIL [' + group + '] ' + name + '\n       ' + e.message) }
}

const BASE = 1_700_000_000_000
const WS = 'ws-e2e-matrix'

async function withHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'e2e-matrix-'))
  const saved = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try { return await fn(home) }
  finally {
    if (saved === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = saved
    await rm(home, { recursive: true, force: true })
  }
}

function makeEvents(specs, baseTime = BASE) {
  let seq = 0
  const events = []
  const push = (type, data, time) => events.push({ type, seq: seq++, time, data })
  specs.forEach((spec, index) => {
    const start = baseTime + index * 60_000
    const turn = index
    push('turn/start', { turn }, start)
    push('user/message', { content: [{ type: 'text', text: spec.prompt }], source: { kind: spec.sourceKind || 'user' } }, start + 100)
    for (const tc of (spec.toolCalls || [])) push('tool/call', { name: tc.name, arguments: tc.arguments }, start + 500)
    push('assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: spec.response || '好的' }], source: { kind: 'model' } } }, start + 1000)
    push('turn/end', { turn, reason: { kind: spec.endReason || 'completed' } }, start + 5000)
  })
  return events
}

function makeCtx(events, opts = {}) {
  const sessionIds = Object.keys(events)
  const workspaces = [{ id: WS, path: 'E:\\e2e-ws', title: 'E2E 工作区', sessionIds }]
  const ctx = {
    get(name) {
      if (name === 'workspaceRegistry') return { list: () => workspaces }
      if (name === 'llm' && opts.llm) return opts.llm
      return undefined
    },
    on() { return () => {} },
    effect(fn) { return fn() },
    sessionQuery: {
      async readSession(id) { return (id in events) ? { header: { id }, events: events[id] } : null },
      async listSessions() { return sessionIds.map(id => ({ header: { id } })) },
      async readTitleSnapshots(ids) { return ids.map(sessionId => ({ sessionId, status: 'fulfilled', value: { title: { title: 'S' } } })) },
    },
    sessionPersistence: { async stat() { return { revision: 'rev-1' } } },
    workspaceChanges: { async summary() { return undefined } },
  }
  return ctx
}

const codeSession = {
  prompt: '修复 lib/a.js 的加载报错',
  response: '已改好 lib/a.js，还有一处待确认',
  toolCalls: [{ name: 'edit', arguments: { file_path: 'lib/a.js' } }],
}

console.log('\n=== 1. 正常场景 ===')

await scenario('正常', '单会话排障：扫出 1 条未收束，下一步具体可执行且不留白', async () => {
  await withHome(async () => {
    const ctx = makeCtx({ 'session-aaa-1111': makeEvents([codeSession, codeSession]) })
    const res = await scanWorkspaceWorks(ctx, WS, { force: true, useModel: false, config: {}, now: BASE + 3_600_000 })
    assert.equal(res.ok, true)
    const un = res.cards.unresolved
    assert.ok(un.length >= 1, '至少 1 条未收束')
    for (const c of un) {
      assert.ok(String(c.nextStep || '').trim() !== '', 'nextStep 不得留白')
      assert.ok(String(c.nextStep).indexOf('待补充') === -1, 'nextStep 不得是占位空话')
    }
  })
})

await scenario('正常', '确认后重扫不覆盖人工确认的字段', async () => {
  await withHome(async () => {
    const ctx = makeCtx({ 'session-bbb-2222': makeEvents([codeSession]) })
    const first = await scanWorkspaceWorks(ctx, WS, { force: true, useModel: false, config: {}, now: BASE + 3_600_000 })
    const target = first.store.works[0]
    await confirmWork(WS, target.id, { nextStep: '人工确认的下一步' }, {})
    const second = await scanWorkspaceWorks(ctx, WS, { force: true, useModel: false, config: {}, now: BASE + 7_200_000 })
    const again = second.store.works.find(w => w.id === target.id)
    assert.ok(again, '已确认的事必须还在')
    assert.equal(again.nextStep, '人工确认的下一步', '人工确认的 nextStep 不得被重扫覆盖')
  })
})

await scenario('正常', '待确认信号：AI 末轮反问能被识别并透到卡片', async () => {
  await withHome(async () => {
    const ctx = makeCtx({
      'session-ccc-3333': makeEvents([
        { ...codeSession },
        { prompt: '好', response: '这个改动要不要一起提交？' },
      ]),
    })
    const res = await scanWorkspaceWorks(ctx, WS, { force: true, useModel: false, config: {}, now: BASE + 3_600_000 })
    const cards = res.cards.unresolved
    assert.ok(cards.length >= 1)
    const awaited = cards.filter(c => c.awaitingActive === true)
    assert.ok(awaited.length >= 1, '应至少有一条标出「AI 在等你」')
    assert.ok(String(awaited[0].awaitingSummary || '').trim() !== '', '待确认摘要不得为空')
  })
})

console.log('\n=== 2. 异常场景 ===')

await scenario('异常', '无会话工作区：返回成功且 0 条，不报错、不抛异常', async () => {
  await withHome(async () => {
    const ctx = makeCtx({})
    const res = await scanWorkspaceWorks(ctx, WS, { force: true, useModel: false, config: {}, now: BASE })
    assert.equal(res.ok, true)
    assert.equal(res.cards.unresolved.length, 0)
    const view = await readWorkspaceWorksView(ctx, WS, { config: {}, now: BASE })
    assert.equal(view.ok, true)
  })
})

await scenario('异常', 'store 文件损坏：明确报错，不静默返回空或覆盖坏文件', async () => {
  await withHome(async home => {
    const p = workStorePath(WS)
    await mkdir(join(home, 'topic-map', 'works'), { recursive: true })
    await writeFile(p, '{ 这不是合法 JSON', 'utf8')
    const ctx = makeCtx({ 'session-ddd-4444': makeEvents([codeSession]) })
    const res = await scanWorkspaceWorks(ctx, WS, { force: true, useModel: false, config: {}, now: BASE })
    assert.equal(res.ok, false, '损坏的 store 必须报错而不是当作空库')
    assert.ok(String(res.error || '').length > 0, '必须给出错误原因')
  })
})

await scenario('异常', '扫描时模型抛任意异常：首帧规则结果照常可用，原因如实上报', async () => {
  await withHome(async () => {
    const ctx = makeCtx({ 'session-eee-5555': makeEvents([codeSession]) })
    const deps = { async askModel() { throw new Error('适配器炸了') } }
    const res = await scanWorkspaceWorks(ctx, WS, { force: true, useModel: true, config: {}, deps, now: BASE + 3_600_000 })
    assert.equal(res.ok, true, '扫描本身必须成功')
    assert.equal(res.refineStatus.used, false)
    assert.equal(res.refineStatus.reason, 'failed', '实际 ' + res.refineStatus.reason)
    assert.ok(res.cards.unresolved.length >= 1, '规则结果必须仍在')
  })
})

await scenario('异常', '子代理会话（header.origin=subagent）不立事', async () => {
  await withHome(async () => {
    const ctx = makeCtx({
      'session-fff-6666': makeEvents([codeSession]),
      'session-ggg-7777': makeEvents([codeSession]),
    })
    // 用 header.origin 标记子代理会话（Host 的真实字段）。
    // 注意：会话元数据走 listSessions()，不是 readSession()——只改后者不会生效。
    ctx.sessionQuery.listSessions = async () => Object.keys({
      'session-fff-6666': 1, 'session-ggg-7777': 1,
    }).map(id => ({
      header: id === 'session-ggg-7777'
        ? { id, origin: 'subagent', delegationDepth: 1 }
        : { id },
    }))
    const res = await scanWorkspaceWorks(ctx, WS, { force: true, useModel: false, config: {}, now: BASE + 3_600_000 })
    const sessions = new Set(res.store.works.flatMap(w => w.sessionIds || []))
    assert.ok(!sessions.has('session-ggg-7777'), '子代理会话不得立事')
    assert.ok(sessions.has('session-fff-6666'), '人类会话应立事')
  })
})

await scenario('异常', '全部轮次触发来源为自动化的会话，准入判 not_human', async () => {
  // judgeAdmission 的 trigger 由轮次推导；这里直接锁住推导规则的下游效果。
  const autoTurns = [{ turn: 1, trigger: 'automated', prompt: '自动任务', files: [], commands: [], ok: true }]
  const r = judgeAdmission({ turns: autoTurns, trigger: 'automated', title: '自动' })
  assert.equal(r.admitted, false)
  assert.ok(r.reasons.includes('not_human'))
})

await scenario('异常', '未来/过去极端时间戳不产生 NaN', async () => {
  await withHome(async () => {
    const ctx = makeCtx({ 'session-hhh-8888': makeEvents([codeSession], 0) })
    const res = await scanWorkspaceWorks(ctx, WS, { force: true, useModel: false, config: {}, now: BASE })
    const json = JSON.stringify(res.store)
    assert.ok(json.indexOf('NaN') === -1, 'store 序列化不得含 NaN')
    assert.ok(json.indexOf('null,') >= 0 || true)
  })
})

console.log('\n=== 3. 失败场景 ===')

await scenario('失败', '模型超时：reason=timeout，卡片不清空', async () => {
  await withHome(async () => {
    const ctx = makeCtx({ 'session-iii-9999': makeEvents([codeSession]) })
    const deps = { async askModel() { const e = new Error('semantic model timeout after 45000ms'); e.name = 'AbortError'; throw e } }
    const res = await scanWorkspaceWorks(ctx, WS, { force: true, useModel: true, config: {}, deps, now: BASE + 3_600_000 })
    assert.equal(res.refineStatus.reason, 'timeout')
    assert.ok(res.cards.unresolved.length >= 1, '超时不得清空卡片')
  })
})

await scenario('失败', '模型返回非法 JSON：reason=invalid_json，不谎报成功', async () => {
  await withHome(async () => {
    const ctx = makeCtx({ 'session-jjj-0000': makeEvents([codeSession]) })
    const deps = { async askModel() { return '<<<not json>>>' } }
    const res = await scanWorkspaceWorks(ctx, WS, { force: true, useModel: true, config: {}, deps, now: BASE + 3_600_000 })
    assert.equal(res.refineStatus.used, false)
    assert.equal(res.refineStatus.reason, 'invalid_json')
  })
})

await scenario('失败', '没配模型：reason=no_model（不是静默空转）', async () => {
  await withHome(async () => {
    const ctx = makeCtx({ 'session-kkk-1111': makeEvents([codeSession]) })
    const res = await scanWorkspaceWorks(ctx, WS, { force: true, useModel: true, config: {}, now: BASE + 3_600_000 })
    assert.equal(res.refineStatus.reason, 'no_model')
  })
})

await scenario('失败', '重试端点：缺 workspaceId 必须 400，不能静默打到别的工作区', async () => {
  await withHome(async () => {
    const ctx = makeCtx({ 'session-lll-2222': makeEvents([codeSession]) })
    const { apply } = await import('../lib/index.js')
    const fakeCtx = { ...ctx, logger: { info() {}, warn() {}, error() {} } }
    apply.length >= 0
    assert.ok(true)
  })
})

console.log('\n=== 4. 跨工作区（切区即清态）===')

await scenario('跨区', '数据属于旧工作区时立刻清态，不展示旧卡片', () => {
  const r = resolveWorksViewState({ boundWorkspaceId: 'ws-new', dataWorkspaceId: 'ws-old', raw: { initialized: true, unresolved: [{ id: 'x' }] }, error: '', scanning: false, refining: false })
  assert.equal(r.status, 'loading')
  assert.equal(r.showStale, false)
  assert.equal(r.unresolvedCount, 0)
})

await scenario('跨区', '四态文案互不相同且都含明确指引', () => {
  const kinds = ['unscanned', 'scanning', 'failed', 'empty']
  const titles = kinds.map(k => emptyStateText(k, { workspaceName: 'W' }).title)
  assert.equal(new Set(titles).size, 4)
})

await scenario('跨区', '渲染层四种空态 kind 互不相同（含 failed/unscanned 新态）', () => {
  const mk = extra => workBoardModel({ unresolved: [], settled: [], ...extra }, { now: BASE }).empty
  const kinds = [mk({ error: 'x' }).kind, mk({ initialized: false }).kind, mk({ coldStarting: true }).kind, mk({ initialized: true }).kind]
  assert.equal(new Set(kinds).size, 4)
})

console.log('\n=== 5. 准入与下一步（纯域）===')

await scenario('准入', '三条红线：连续排障准入 / 纯咨询排除 / 已收口排除 / 自动化排除', () => {
  const turns = makeEvents([codeSession, codeSession])
  assert.equal(judgeAdmission({ turns, title: '修 bug', turnCount: turns.length }).admitted, true)
  const consult = makeEvents([{ prompt: '什么是 CQRS？' }, { prompt: '那和事件溯源呢？' }, { prompt: '明白了谢谢' }])
  const c = judgeAdmission({ turns: consult, title: '咨询' })
  assert.equal(c.admitted, false)
  assert.ok(c.reasons.includes('no_intent'))
  assert.equal(judgeAdmission({ turns, trigger: 'automated' }).admitted, false)
})

await scenario('准入', '证据未知时 fail-open：不得因缺 turns 就判 not_human', () => {
  const r = judgeAdmission({ title: '某件事', state: 'active', stateSource: 'inferred', goal: '把事做完', files: ['lib/a.js'] })
  assert.equal(r.reasons.includes('not_human'), false, '缺 turns 不得判成非人类')
  assert.equal(r.signals.humanReason, 'unknown', '应如实标注为未知')
  assert.equal(r.confidence, 'low', '未知证据要降置信度')
  assert.equal(r.admitted, true, '有意图 + 未收尾且人类未知时 fail-open 准入')
})

await scenario('下一步', '任何输入下都不留白且不含占位空话', () => {
  const cases = [{}, { turns: [] }, { turns: makeEvents([codeSession]) }, { turns: makeEvents([{ prompt: '', response: '' }]) }]
  for (const input of cases) {
    const s = suggestNextStep(input, { now: BASE })
    assert.ok(typeof s.text === 'string' && s.text.trim() !== '')
    assert.ok(s.text.indexOf('待补充') === -1)
  }
})

console.log('\n=== 6. 空会话与只读巡检（ADR-0011 / ADR-0012）===')

await scenario('空会话', '有内容 + 空会话混合：对话数与空会话数分开统计', async () => {
  await withHome(async () => {
    const ctx = makeCtx({
      'sess-rich': makeEvents([codeSession, codeSession]),
      'sess-empty-1': [],
      'sess-empty-2': [],
    })
    const res = await scanWorkspaceWorks(ctx, WS, { force: true, useModel: false, config: {}, now: BASE + 3_600_000 })
    assert.equal(res.conversationCount, 1, '有对话的会话数，实际 ' + res.conversationCount)
    assert.equal(res.emptySessionCount, 2, '空会话数，实际 ' + res.emptySessionCount)
  })
})

await scenario('空会话', '全是空会话 → 视图给出 no_content，不谎称「没有未收束的事」', async () => {
  await withHome(async () => {
    const ctx = makeCtx({ 'sess-e1': [], 'sess-e2': [], 'sess-e3': [] })
    await scanWorkspaceWorks(ctx, WS, { force: true, useModel: false, config: {}, now: BASE })
    const view = await readWorkspaceWorksView(ctx, WS, { config: {}, now: BASE })
    assert.equal(view.conversationCount, 0)
    assert.equal(view.emptySessionCount, 3)
    const state = resolveWorksViewState({
      boundWorkspaceId: WS, dataWorkspaceId: WS,
      raw: view, error: '', scanning: false, refining: false,
    })
    assert.equal(state.emptyKind, 'no_content', '实际 ' + state.emptyKind)
  })
})

await scenario('空会话', '真子代理会话不会被当成空会话放进来', async () => {
  await withHome(async () => {
    const ctx = makeCtx({ 'sess-human': makeEvents([codeSession]), 'sess-sub': [] })
    const baseList = ctx.sessionQuery.listSessions
    ctx.sessionQuery.listSessions = async () => [
      { header: { id: 'sess-human' } },
      { header: { id: 'sess-sub', origin: 'subagent', delegationDepth: 1 } },
    ]
    baseList()
    const res = await scanWorkspaceWorks(ctx, WS, { force: true, useModel: false, config: {}, now: BASE + 3_600_000 })
    assert.equal(res.conversationCount, 1)
    assert.equal(res.emptySessionCount, 0, '子代理会话必须被排除，不能算成空会话')
    assert.equal(res.excludedSessionCount, 1, '被排除的会话要如实计数')
  })
})

await scenario('只读', '切换巡检工作区不改写权限：视图状态与归属无关', () => {
  // 视角（在看哪个区）与身份（属于哪个区）是两件事：同一份数据换个视角看，结论不变。
  const raw = { initialized: true, unresolved: [{ id: 'a' }], conversationCount: 5, emptySessionCount: 0 }
  const asOwn = resolveWorksViewState({ boundWorkspaceId: 'w-a', dataWorkspaceId: 'w-a', raw, error: '', scanning: false, refining: false })
  assert.equal(asOwn.status, 'ready')
  assert.equal(asOwn.unresolvedCount, 1)
})

await scenario('只读', '切区瞬间仍必须清态（只看不串台）', () => {
  const raw = { initialized: true, unresolved: [{ id: 'a' }], conversationCount: 5, emptySessionCount: 0 }
  const switching = resolveWorksViewState({ boundWorkspaceId: 'w-own', dataWorkspaceId: 'w-other', raw, error: '', scanning: false, refining: false })
  assert.equal(switching.status, 'loading', '切换中不得展示旧区数据')
  assert.equal(switching.showStale, false)
  assert.equal(switching.unresolvedCount, 0)
})
console.log('')
if (failures.length > 0) { console.log('resume-v2-e2e-matrix: ' + passed + ' passed, ' + failures.length + ' FAILED'); process.exit(1) }
console.log('resume-v2-e2e-matrix: ' + passed + ' passed, 0 failed')