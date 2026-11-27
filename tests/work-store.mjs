/**
 * Host 侧「段 + 事 + 交接」存储、冷启动盘点、增量同步、动作编排与 Wire 展开测试。
 *
 * 覆盖：
 * 1. 持久化（tmp+rename 原子写、串行队列、损坏 JSON 不覆盖且返回明确错误）；
 * 2. 存量冷启动盘点（过滤自动化/子代理会话、fork/引用句柄/文件重叠聚类、可选模型精化与失败降级、沉降、双表分离不覆盖已确认字段）；
 * 3. 日常增量同步（L1 交接血缘/fork/句柄 → L2 文件重叠 → L3 模型匹配、命中已确认 done 老事不篡改并写 reopenSuggestion、拐点检测）；
 * 4. 动作编排（confirm/dismiss/promote/merge/split + 拐点忽略）；
 * 5. 三层交接（原会话未串台 vs 已串台、新会话交接包 + bindHandoffSession 写入 L1 血缘）；
 * 6. Wire 层展开（〔work:<workId>〕 与 〔8hex#N〕 共存、幂等防重复、注入 topic-map:事续接现场 interpolate:false）；
 * 7. HTTP 端点契约（/works /works-scan /work-confirm /work-dismiss /work-promote /work-merge /work-split /work-handoff /work-handoff-bind /work-inflection-dismiss）
 *    以及 /session-outline 扩展 segments、配置项 dormantDays + inflectionNotice。
 *
 * Run: node tests/work-store.mjs
 */

import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  WORK_CONTEXT_NAME,
  bindHandoffSession,
  confirmWork,
  dismissInflection,
  dismissWork,
  expandWorkHandlesForAgent,
  incrementalSyncSession,
  mergeWorkspaceWorks,
  prepareHandoff,
  promoteSegmentToWork,
  readWorkStore,
  scanWorkspaceWorks,
  splitWorkspaceWork,
  workStorePath,
  writeWorkStore,
} from '../lib/work-store.js'

import {
  apply,
  flushIndexSyncs,
  mergeConfigPatch,
  readSessionOutline,
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

const DAY = 24 * 60 * 60 * 1000
const BASE_TIME = 1_700_000_000_000
const WS = 'ws-work-1'

const SESS_A = 'session-aaaa1111-1111-4aaa-8bbb-000000000001'
const SESS_B = 'session-bbbb2222-2222-4aaa-8bbb-000000000002'
const SESS_C = 'session-cccc3333-3333-4aaa-8bbb-000000000003'
const SESS_SUB = 'session-dddd4444-4444-4aaa-8bbb-000000000004'
const SESS_CHAT = 'session-eeee5555-5555-4aaa-8bbb-000000000005'
const SESS_NEW = 'session-ffff6666-6666-4aaa-8bbb-000000000006'

async function withTempHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'work-store-'))
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

function makeEvents(specs, baseTime = BASE_TIME) {
  let seq = 0
  const events = []
  const push = (type, data, time) => events.push({ type, seq: seq++, time, data })
  specs.forEach((spec, index) => {
    const start = spec.start ?? (baseTime + index * 60_000)
    const end = spec.end ?? (start + 5_000)
    const turn = spec.turn ?? index
    push('turn/start', { turn }, start)
    push('user/message', {
      content: [{ type: 'text', text: spec.prompt ?? `问题 ${turn}` }],
      source: { kind: 'user' },
    }, start + 100)
    if (Array.isArray(spec.toolCalls)) {
      for (const tc of spec.toolCalls) {
        push('tool/call', {
          name: tc.name,
          arguments: tc.arguments ?? {},
        }, start + 500)
      }
    }
    push('assistant/message', {
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: spec.response ?? `回答 ${turn}` }],
        source: { kind: 'model', provider: 'fake', model: 'fake-1' },
      },
    }, start + 1000)
    if (spec.hasChanges === true) {
      push('workspace/changes', { turn }, start + 1500)
    }
    if (spec.open !== true) {
      push('turn/end', { turn, reason: { kind: spec.endReason ?? 'completed' } }, end)
    }
  })
  return events
}

function makeFakeLlm(responder) {
  const state = { calls: 0, prompts: [] }
  return {
    get calls() {
      return state.calls
    },
    get prompts() {
      return state.prompts
    },
    async prepareCall(call) {
      state.calls += 1
      const userText = call.messages?.[0]?.content?.[0]?.text ?? ''
      state.prompts.push({ system: call.system ?? '', user: userText })
      return {
        config: { ...call, provider: 'fake', model: 'fake-1' },
        async *stream() {
          const out = typeof responder === 'function' ? await responder(call, state.calls) : responder
          if (out instanceof Error) throw out
          yield { type: 'text-delta', text: String(out ?? '') }
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
  const headers = options.headers ?? {}
  const titles = options.titles ?? {}
  const revisions = options.revisions ?? {}
  const changesBySession = options.changes ?? {}
  const llm = options.llm
  const sessionIds = options.sessionIds ?? Object.keys(events)
  const workspaces = options.workspaces ?? [{
    id: WS,
    path: 'E:\\work-ws',
    title: '事测试工作区',
    sessionIds,
  }]

  const registeredRoutes = []
  const eventListeners = new Map()

  const webScope = {
    get(name) {
      if (name !== 'webServer') return undefined
      return {
        register(config) {
          registeredRoutes.push(config)
          return () => {}
        },
      }
    },
    effect(fn) {
      return fn()
    },
  }

  const ctx = {
    _routes: registeredRoutes,
    _listeners: eventListeners,
    get(name) {
      if (name === 'workspaceRegistry') return { list: () => workspaces }
      if (name === 'llm') return llm
      return undefined
    },
    on(eventName, fn) {
      if (!eventListeners.has(eventName)) eventListeners.set(eventName, [])
      eventListeners.get(eventName).push(fn)
      return () => {}
    },
    effect(fn) {
      return fn()
    },
    inject(names, callback) {
      if (names.includes('webServer')) callback(webScope)
      if (names.includes('systemPrompt')) {
        callback({
          ...ctx,
          on(eventName, fn) {
            return ctx.on(eventName, fn)
          },
          effect(fn) {
            return fn()
          },
        })
      }
    },
    sessionQuery: {
      async readSession(id) {
        if (typeof options.readSession === 'function') return options.readSession(id)
        if (!(id in events)) return null
        return { header: headers[id] ?? { id }, events: events[id] }
      },
      async listSessions() {
        return Object.keys(events).map(id => ({
          header: { id, ...(headers[id] ?? {}) },
        }))
      },
      async readTitleSnapshots(ids) {
        return ids.map(sessionId => ({
          sessionId,
          status: 'fulfilled',
          value: { title: { title: titles[sessionId] ?? `会话 ${sessionId.slice(0, 12)}` } },
        }))
      },
    },
    sessionPersistence: {
      async stat(id) {
        return { revision: revisions[id] ?? 'rev-1' }
      },
    },
    workspaceChanges: {
      async summary(id, seq) {
        const map = changesBySession[id]
        if (!map) return undefined
        return map[seq] ?? map.default
      },
    },
    llm,
  }
  return ctx
}

async function callRoute(handler, method, action, body) {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  const req = Readable.from(payload)
  req.url = `/api/topic-map/${action}`
  req.method = method
  let status = 0
  let text = ''
  const res = {
    writeHead(code) {
      status = code
    },
    end(value) {
      text = value
    },
  }
  await handler(req, res)
  return { status, body: text === '' ? null : JSON.parse(text) }
}

console.log('\nwork-store')

// ── 1. 持久化与损坏保护 ──────────────────────────────────────────────

await test('readWorkStore / writeWorkStore：缺省返回空 store，原子写入并持久化到 works/<safe>.json', async () => {
  await withTempHome(async home => {
    const emptyRes = await readWorkStore(WS)
    assert.equal(emptyRes.ok, true)
    assert.equal(emptyRes.exists, false)
    assert.equal(emptyRes.store.workspaceId, WS)
    assert.deepEqual(emptyRes.store.works, [])

    const path = workStorePath('ws/with:weird\\chars')
    assert.ok(path.startsWith(join(home, 'topic-map', 'works')))
    assert.equal(path.endsWith('.json'), true)

    const saved = await writeWorkStore(WS, {
      ...emptyRes.store,
      initializedAt: BASE_TIME,
      works: [{ id: 'w-1', workspaceId: WS, title: '持久化测试', state: 'active' }],
    })
    assert.equal(saved.ok, true)

    const loaded = await readWorkStore(WS)
    assert.equal(loaded.ok, true)
    assert.equal(loaded.exists, true)
    assert.equal(loaded.store.works.length, 1)
    assert.equal(loaded.store.works[0].title, '持久化测试')
  })
})

await test('readWorkStore：损坏 JSON 返回明确错误且绝不覆盖原文件', async () => {
  await withTempHome(async () => {
    const path = workStorePath(WS)
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, '{broken json', 'utf8')

    const read = await readWorkStore(WS)
    assert.equal(read.ok, false)
    assert.match(read.error, /损坏/)

    // 确认文件内容未被覆盖
    const raw = await readFile(path, 'utf8')
    assert.equal(raw, '{broken json')

    // 确认 confirmWork 在损坏文件上也会报错而非覆盖
    const confirmed = await confirmWork(WS, 'w-1', { state: 'done' })
    assert.equal(confirmed.ok, false)
    assert.equal(await readFile(path, 'utf8'), '{broken json')
  })
})

await test('writeWorkStore：同工作区并发写串行化，不互相丢数据', async () => {
  await withTempHome(async () => {
    const base = (await readWorkStore(WS)).store
    const writes = []
    for (let i = 0; i < 6; i += 1) {
      writes.push(writeWorkStore(WS, {
        ...base,
        updatedAt: BASE_TIME + i,
        works: [{ id: `w-${i}`, workspaceId: WS, title: `事 ${i}`, state: 'active' }],
      }))
    }
    const results = await Promise.all(writes)
    assert.ok(results.every(r => r.ok === true))
    const finalRead = await readWorkStore(WS)
    assert.equal(finalRead.ok, true)
    assert.equal(finalRead.store.works[0].id, 'w-5')
  })
})

// ── 2. 存量冷启动盘点 + 防污染 + 双表不覆盖 ──────────────────────────

await test('scanWorkspaceWorks：过滤子代理会话、硬信号聚类、沉降、以及可选模型语义精化与降级', async () => {
  await withTempHome(async () => {
    const events = {
      [SESS_A]: makeEvents([
        {
          prompt: '修复 lib/auth-token.js 里的过期判断 bug',
          response: '已定位并修改 lib/auth-token.js',
          toolCalls: [{ name: 'edit', arguments: { file_path: 'lib/auth-token.js' } }],
        },
        {
          prompt: '跑一下单测验证 auth-token',
          response: '单测报错 TypeError',
          toolCalls: [{ name: 'pwsh', arguments: { command: 'node tests/auth-token.mjs' } }],
          endReason: 'error',
        },
      ], BASE_TIME),
      [SESS_B]: makeEvents([
        {
          prompt: '继续处理 〔aaaa1111#1〕 提到的 auth-token 问题',
          response: '补了边界校验并更新 lib/auth-token.js',
          toolCalls: [{ name: 'edit', arguments: { file_path: 'lib/auth-token.js' } }],
        },
      ], BASE_TIME + 3600_000),
      // 20 天前的老工作，用于验证自动沉降
      [SESS_C]: makeEvents([
        {
          prompt: '重构 lib/legacy-export.js',
          response: '先起了一个草案',
          toolCalls: [{ name: 'edit', arguments: { file_path: 'lib/legacy-export.js' } }],
        },
      ], BASE_TIME - 20 * DAY),
      // 子代理会话：必须被排除
      [SESS_SUB]: makeEvents([
        {
          prompt: '执行子代理审计任务，改 lib/subagent-only.js',
          response: '完成子代理审计',
          toolCalls: [{ name: 'edit', arguments: { file_path: 'lib/subagent-only.js' } }],
        },
      ], BASE_TIME),
      // 日常闲聊：不立为事
      [SESS_CHAT]: makeEvents([
        {
          prompt: '今天晚上吃什么比较好？',
          response: '可以试试番茄炒蛋配米饭。',
        },
      ], BASE_TIME),
    }

    const ctx = makeCtx({
      events,
      headers: {
        [SESS_SUB]: { id: SESS_SUB, origin: 'subagent', delegationDepth: 1 },
      },
      // 模型失败应安全降级回硬信号，不阻塞冷启动
      llm: makeFakeLlm(new Error('llm offline')),
    })

    const res = await scanWorkspaceWorks(ctx, WS, {
      now: BASE_TIME + 2 * 3600_000,
      dormantDays: 14,
    })
    assert.equal(res.ok, true, res.error)
    // SESS_A + SESS_B 通过引用句柄+共同业务文件聚成同一件事
    const authWork = res.store.works.find(w => w.sessionIds.includes(SESS_A))
    assert.ok(authWork, '应识别出 auth-token 工作')
    assert.ok(authWork.sessionIds.includes(SESS_B), 'SESS_A 与 SESS_B 应通过硬信号聚成同一件事')
    // SESS_SUB 必须被过滤
    assert.equal(res.store.works.some(w => w.sessionIds.includes(SESS_SUB)), false, '子代理会话绝不自动立事')
    // SESS_C 超过 14 天应沉降为 shelved
    const oldWork = res.store.works.find(w => w.sessionIds.includes(SESS_C))
    assert.ok(oldWork, '20 天前的老工作仍被保留')
    assert.equal(oldWork.state, 'shelved', '超过 dormantDays 的推测态事应自动沉降')
    // SESS_CHAT 不立为事
    assert.equal(res.store.works.some(w => w.sessionIds.includes(SESS_CHAT)), false, '纯闲聊不应立为事')
    // 投影卡片结构正确
    assert.ok(res.cards.unresolved.some(c => c.id === authWork.id))
    assert.ok(res.cards.settled.some(c => c.id === oldWork.id))
    assert.equal(res.cards.settledCollapsedByDefault, true)
  })
})

await test('scanWorkspaceWorks：模型精化成功时写入目标/下一步/决策，且重扫绝不覆盖已确认锁定的字段', async () => {
  await withTempHome(async () => {
    const events = {
      [SESS_A]: makeEvents([
        {
          prompt: '实现 lib/billing.js 计费校验',
          response: '完成了基础校验',
          toolCalls: [{ name: 'edit', arguments: { file_path: 'lib/billing.js' } }],
        },
      ], BASE_TIME),
    }

    const llm = makeFakeLlm(call => {
      const m = call.messages[0].content[0].text.match(/\[(cl-\d+)\]/)
      const cid = m ? m[1] : 'cl-1'
      return JSON.stringify({
        works: [{
          clusterIds: [cid],
          title: '计费校验改造',
          goal: '补齐账单金额与税率校验',
          state: 'active',
          statusSummary: '已完成基础校验逻辑',
          nextStep: '补齐负数金额单测',
          decisions: [{
            summary: '统一使用整型分存储金额',
            rationale: '避免浮点精度误差',
            evidenceHandle: '〔aaaa1111#0〕',
          }],
        }],
        chatClusterIds: [],
      })
    })

    const ctx = makeCtx({ events, llm })
    const first = await scanWorkspaceWorks(ctx, WS, { now: BASE_TIME + 10_000 })
    assert.equal(first.ok, true)
    assert.equal(first.store.works.length, 1)
    const w = first.store.works[0]
    assert.equal(w.title, '计费校验改造')
    assert.equal(w.nextStep, '补齐负数金额单测')
    assert.equal(w.decisions.length, 1)

    // 人工确认并锁定状态、标题与下一步
    const confirmed = await confirmWork(WS, w.id, {
      title: '人工锁定标题',
      state: 'blocked',
      nextStep: '等财务确认税率表',
      pinned: true,
    }, { now: BASE_TIME + 20_000 })
    assert.equal(confirmed.ok, true)
    assert.equal(confirmed.work.stateSource, 'confirmed')
    assert.equal(confirmed.work.nextStepSource, 'confirmed')

    // 再次强制重扫（即使模型给出不同结论），绝不能覆盖人工锁定字段！
    const rescan = await scanWorkspaceWorks(ctx, WS, {
      force: true,
      now: BASE_TIME + 30_000,
    })
    assert.equal(rescan.ok, true)
    const after = rescan.store.works.find(item => item.id === w.id)
    assert.ok(after, '重扫后已确认的事必须保留且 id 稳定')
    assert.equal(after.title, '人工锁定标题')
    assert.equal(after.state, 'blocked')
    assert.equal(after.stateSource, 'confirmed')
    assert.equal(after.nextStep, '等财务确认税率表')
    assert.equal(after.nextStepSource, 'confirmed')
    assert.equal(after.pinned, true)
  })
})

// ── 3. 增量同步：L1/L2/L3 + 防污染 done + 拐点检测 ──────────────────

await test('incrementalSyncSession：L2 文件重叠挂载到已有未收束事，并检测异常卡住拐点', async () => {
  await withTempHome(async () => {
    const events = {
      [SESS_A]: makeEvents([
        {
          prompt: '实现 lib/search-rank.js 的权重打分',
          response: '初步写入 lib/search-rank.js',
          toolCalls: [{ name: 'edit', arguments: { file_path: 'lib/search-rank.js' } }],
        },
      ], BASE_TIME),
    }
    const ctx = makeCtx({ events })
    const scan = await scanWorkspaceWorks(ctx, WS, { now: BASE_TIME + 10_000, useModel: false })
    assert.equal(scan.ok, true)
    const workId = scan.store.works[0].id

    // 新会话改动了同一业务文件 lib/search-rank.js 且末轮失败
    events[SESS_B] = makeEvents([
      {
        prompt: '排查 lib/search-rank.js 打分异常',
        response: '运行报错 TypeError: cannot read score',
        toolCalls: [{ name: 'edit', arguments: { file_path: 'lib/search-rank.js' } }],
        endReason: 'error',
      },
    ], BASE_TIME + 60_000)
    ctx.get('workspaceRegistry').list()[0].sessionIds.push(SESS_B)

    const sync = await incrementalSyncSession(ctx, SESS_B, { now: BASE_TIME + 70_000, useModel: false })
    assert.equal(sync.ok, true, sync.error)
    assert.equal(sync.match.action, 'attach')
    assert.equal(sync.match.level, 'L2')
    assert.equal(sync.match.workId, workId)
    assert.ok(sync.store.works.find(w => w.id === workId).sessionIds.includes(SESS_B))
    assert.ok(sync.inflection, '末轮失败应产出自然拐点')
    assert.equal(sync.inflection.kind, 'likely_settled_or_blocked')
    assert.equal(sync.inflection.suggestedState, 'blocked')
  })
})

await test('incrementalSyncSession：命中已确认 done 老事绝不篡改老事，只写 reopenSuggestion', async () => {
  await withTempHome(async () => {
    const events = {
      [SESS_A]: makeEvents([
        {
          prompt: '修复 lib/cache-lock.js 死锁',
          response: '已修完 lib/cache-lock.js',
          toolCalls: [{ name: 'edit', arguments: { file_path: 'lib/cache-lock.js' } }],
        },
      ], BASE_TIME),
    }
    const ctx = makeCtx({ events })
    const scan = await scanWorkspaceWorks(ctx, WS, { now: BASE_TIME + 10_000, useModel: false })
    const doneWorkId = scan.store.works[0].id

    // 用户确认该事已完成
    const doneRes = await confirmWork(WS, doneWorkId, { state: 'done' }, { now: BASE_TIME + 20_000 })
    assert.equal(doneRes.ok, true)

    // 之后又有新会话改动同一文件 lib/cache-lock.js
    events[SESS_B] = makeEvents([
      {
        prompt: 'lib/cache-lock.js 在高并发下又出现超时',
        response: '先加日志定位 lib/cache-lock.js',
        toolCalls: [{ name: 'edit', arguments: { file_path: 'lib/cache-lock.js' } }],
      },
    ], BASE_TIME + 120_000)
    ctx.get('workspaceRegistry').list()[0].sessionIds.push(SESS_B)

    const sync = await incrementalSyncSession(ctx, SESS_B, { now: BASE_TIME + 130_000, useModel: false })
    assert.equal(sync.ok, true)
    assert.equal(sync.match.action, 'suggest_reopen')

    // 老事保持 done/confirmed 且 sessionIds 未被污染
    const oldWork = sync.store.works.find(w => w.id === doneWorkId)
    assert.equal(oldWork.state, 'done')
    assert.equal(oldWork.stateSource, 'confirmed')
    assert.equal(oldWork.sessionIds.includes(SESS_B), false)

    // store 上写入 reopenSuggestion 供轻提示消费
    assert.ok(sync.store.reopenSuggestion, '应写入 reopenSuggestion')
    assert.equal(sync.store.reopenSuggestion.relatedDoneWorkId, doneWorkId)
    assert.equal(sync.store.reopenSuggestion.sessionId, SESS_B)
  })
})

await test('incrementalSyncSession：L3 可选模型匹配未收束事', async () => {
  await withTempHome(async () => {
    const events = {
      [SESS_A]: makeEvents([
        {
          prompt: '设计用户登录 OAuth 回调流程',
          response: '拟定回调状态校验方案',
          toolCalls: [{ name: 'edit', arguments: { file_path: 'lib/oauth-flow.js' } }],
        },
      ], BASE_TIME),
    }
    const llm = makeFakeLlm(call => {
      const m = call.messages[0].content[0].text.match(/\[(w-[^\]]+)\]/)
      const targetId = m ? m[1] : ''
      return JSON.stringify({ action: 'attach', workId: targetId, reason: '同属 OAuth 登录改造' })
    })
    const ctx = makeCtx({ events, llm })
    const scan = await scanWorkspaceWorks(ctx, WS, { now: BASE_TIME + 10_000, useModel: false })
    const workId = scan.store.works[0].id

    // 新会话不共享文件、无硬血缘，走 L3 语义匹配
    events[SESS_B] = makeEvents([
      {
        prompt: '排查 OAuth 登录回跳参数丢失问题',
        response: '检查了 state 编码，待修改测试',
      },
    ], BASE_TIME + 60_000)
    ctx.get('workspaceRegistry').list()[0].sessionIds.push(SESS_B)

    const sync = await incrementalSyncSession(ctx, SESS_B, { now: BASE_TIME + 70_000, useModel: true })
    assert.equal(sync.ok, true)
    assert.equal(sync.match.action, 'attach')
    assert.equal(sync.match.level, 'L3')
    assert.equal(sync.match.workId, workId)
    assert.ok(sync.store.works.find(w => w.id === workId).sessionIds.includes(SESS_B))
  })
})

// ── 4. 动作编排：dismiss / promote / merge / split ───────────────────

await test('动作编排：dismissWork / promoteSegmentToWork / mergeWorkspaceWorks / splitWorkspaceWork', async () => {
  await withTempHome(async () => {
    const seg1 = {
      id: 'seg:aaaa1111:0-1',
      sessionId: SESS_A,
      startTurn: 0,
      endTurn: 1,
      title: '支付对账脚本',
      summary: '核对对账单差异',
      files: ['lib/reconcile.js'],
      changedFiles: ['lib/reconcile.js'],
      endTime: BASE_TIME + 1000,
    }
    const seg2 = {
      id: 'seg:bbbb2222:0-0',
      sessionId: SESS_B,
      startTurn: 0,
      endTurn: 0,
      title: '补充对账单测',
      summary: '添加异常账单用例',
      files: ['tests/reconcile.mjs'],
      changedFiles: ['tests/reconcile.mjs'],
      endTime: BASE_TIME + 2000,
    }

    // 1) promote 两个段
    const p1 = await promoteSegmentToWork(WS, seg1, { now: BASE_TIME + 3000 })
    const p2 = await promoteSegmentToWork(WS, seg2, { now: BASE_TIME + 4000 })
    assert.equal(p1.ok, true)
    assert.equal(p2.ok, true)
    assert.ok(p1.work.id !== p2.work.id)

    // 2) merge 两件事
    const merged = await mergeWorkspaceWorks(WS, p1.work.id, p2.work.id, { now: BASE_TIME + 5000 })
    assert.equal(merged.ok, true)
    assert.equal(merged.store.works.length, 1)
    assert.deepEqual(merged.work.segmentIds.sort(), [seg1.id, seg2.id].sort())

    // 3) split 拆出 seg2
    const split = await splitWorkspaceWork(WS, p1.work.id, seg2.id, { now: BASE_TIME + 6000 })
    assert.equal(split.ok, true)
    assert.equal(split.store.works.length, 2)
    assert.deepEqual(split.work.segmentIds, [seg2.id])

    // 4) dismiss 退回话题，段写入 dismissedSegments
    const dismissed = await dismissWork(WS, split.work.id, { now: BASE_TIME + 7000 })
    assert.equal(dismissed.ok, true)
    assert.ok(dismissed.store.dismissedSegments[seg2.id], '退回话题后段应进入 dismissedSegments 防重提')
    assert.equal(dismissed.cards.unresolved.some(c => c.id === split.work.id), false)

    // 5) confirmWork 支持新增与取代决策
    const addDec = await confirmWork(WS, p1.work.id, {
      addDecision: { summary: '方案 A：逐行比对', rationale: '实现简单', evidenceHandle: '〔aaaa1111#0〕' },
    }, { now: BASE_TIME + 8000 })
    assert.equal(addDec.ok, true)
    assert.equal(addDec.work.decisions.length, 1)
    const oldDecId = addDec.work.decisions[0].id

    const supDec = await confirmWork(WS, p1.work.id, {
      supersedeDecision: {
        oldId: oldDecId,
        decision: { summary: '方案 B：按哈希分桶比对', rationale: '百万行性能提升 10 倍', evidenceHandle: '〔aaaa1111#1〕' },
      },
    }, { now: BASE_TIME + 9000 })
    assert.equal(supDec.ok, true)
    assert.equal(supDec.work.decisions.length, 2)
    assert.equal(supDec.work.decisions.find(d => d.id === oldDecId).status, 'superseded')
  })
})

// ── 5. 三层交接 + bindHandoffSession 写入 L1 血缘 ────────────────────

await test('prepareHandoff：same-session 区分未串台与已串台；new-session 输出硬事实且 bindHandoffSession 写 L1 血缘', async () => {
  await withTempHome(async () => {
    const events = {
      // SESS_A：第 0 轮做登录修复，间隔 2 小时后第 1 轮切到无关闲聊（制造串台）
      [SESS_A]: makeEvents([
        {
          prompt: '修复 lib/login.js 验证码过期逻辑',
          response: '改好了 lib/login.js，单测报错待查',
          toolCalls: [
            { name: 'edit', arguments: { file_path: 'lib/login.js' } },
            { name: 'pwsh', arguments: { command: 'node tests/login.mjs' } },
          ],
          hasChanges: true,
          endReason: 'error',
          start: BASE_TIME,
          end: BASE_TIME + 5_000,
        },
        {
          prompt: '顺便问一下周末去杭州有什么推荐的徒步路线？',
          response: '推荐九溪十八涧和十里琅珰。',
          start: BASE_TIME + 2 * 3600_000,
          end: BASE_TIME + 2 * 3600_000 + 5_000,
        },
      ]),
    }

    const ctx = makeCtx({
      events,
      changes: {
        [SESS_A]: {
          default: { files: [{ path: 'lib/login.js', added: 14, deleted: 3 }] },
        },
      },
    })
    await syncSessionIndexFor(ctx, SESS_A)
    const scan = await scanWorkspaceWorks(ctx, WS, { now: BASE_TIME + 3 * 3600_000, useModel: false })
    const loginWork = scan.store.works.find(w => w.sessionIds.includes(SESS_A))
    assert.ok(loginWork)
    await confirmWork(WS, loginWork.id, {
      title: '登录验证码修复',
      nextStep: '复现并修好 tests/login.mjs 的报错',
    })

    // same-session：因为末段已串台到杭州徒步，drifted 应为 true 且草稿带 〔work:<id>〕
    const same = await prepareHandoff(ctx, WS, loginWork.id, 'same-session')
    assert.equal(same.ok, true, same.error)
    assert.equal(same.value.targetSessionId, SESS_A)
    assert.equal(same.value.targetTurn, 0)
    assert.equal(same.value.drifted, true)
    assert.ok(same.value.draft.includes(`〔work:${loginWork.id}〕`), same.value.draft)
    assert.ok(same.value.hardFacts.changedFiles.some(f => f.path === 'lib/login.js'))
    assert.ok(same.value.hardFacts.failedSignals.length >= 1)

    // new-session：返回工作区、可编辑草稿、workHandle、硬事实
    const nextSess = await prepareHandoff(ctx, WS, loginWork.id, 'new-session')
    assert.equal(nextSess.ok, true)
    assert.equal(nextSess.value.workspaceId, WS)
    assert.equal(nextSess.value.workHandle, `〔work:${loginWork.id}〕`)
    assert.ok(nextSess.value.draft.includes(`〔work:${loginWork.id}〕`))
    assert.ok(nextSess.value.draft.includes('lib/login.js'))

    // 绑定新会话的 L1 交接血缘
    const bound = await bindHandoffSession(WS, loginWork.id, SESS_NEW)
    assert.equal(bound.ok, true)
    assert.equal(bound.store.handoffLinks[SESS_NEW], loginWork.id)

    // 新会话即便没有任何重叠文件，增量同步也必须靠 L1 handoff 血缘准确挂回该事！
    events[SESS_NEW] = makeEvents([
      {
        prompt: '按照交接现场继续检查验证码测试',
        response: '已经复现，准备补断言',
      },
    ], BASE_TIME + 4 * 3600_000)
    ctx.get('workspaceRegistry').list()[0].sessionIds.push(SESS_NEW)

    const sync = await incrementalSyncSession(ctx, SESS_NEW, { now: BASE_TIME + 4 * 3600_000 + 10_000, useModel: false })
    assert.equal(sync.ok, true)
    assert.equal(sync.match.action, 'attach')
    assert.equal(sync.match.level, 'L1')
    assert.equal(sync.match.reason, 'handoff')
    assert.equal(sync.match.workId, loginWork.id)
  })
})

// ── 6. Wire 层展开：〔work:<workId>〕 与 〔8hex#N〕 共存 + 幂等 ────────

await test('expandWorkHandlesForAgent & registerQuoteExpansion：事级与轮次句柄共存、幂等防重复、interpolate:false', async () => {
  await withTempHome(async () => {
    const events = {
      [SESS_A]: makeEvents([
        {
          prompt: '修复 lib/parser.js 边界条件',
          response: '已修改 lib/parser.js 并补充日志',
          toolCalls: [{ name: 'edit', arguments: { file_path: 'lib/parser.js' } }],
        },
      ], BASE_TIME),
    }
    const llm = makeFakeLlm('摘要：parser 边界修复完成。')
    const ctx = makeCtx({ events, llm })
    await syncSessionIndexFor(ctx, SESS_A)
    const scan = await scanWorkspaceWorks(ctx, WS, { now: BASE_TIME + 10_000, useModel: false })
    const workId = scan.store.works[0].id
    await confirmWork(WS, workId, {
      title: 'Parser 边界修复',
      goal: '消除空输入导致的解析崩溃',
      nextStep: '补齐空串与超长输入测试',
    })

    // 1) 直接测 expandWorkHandlesForAgent + 幂等
    const firstExpand = await expandWorkHandlesForAgent(
      ctx,
      WS,
      [`【交接「Parser 边界修复」〔work:${workId}〕】 继续`],
      SESS_NEW,
    )
    assert.ok(firstExpand.includes(`〔work:${workId}〕`), firstExpand)
    assert.ok(firstExpand.includes('消除空输入导致的解析崩溃'), firstExpand)
    assert.ok(firstExpand.includes('补齐空串与超长输入测试'), firstExpand)

    // 同会话再次展开同一 workId：幂等跳过
    const secondExpand = await expandWorkHandlesForAgent(
      ctx,
      WS,
      [`再提一次 〔work:${workId}〕`],
      SESS_NEW,
    )
    assert.equal(secondExpand, '', '同会话同一 workId 应幂等防重复注入')

    // 2) 通过 registerQuoteExpansion 同时展开轮次句柄与事级句柄
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
    registerQuoteExpansion({ inject(names, cb) { if (names.includes('systemPrompt')) cb(scope) } })
    assert.equal(typeof assembleHandler, 'function')

    const callerId = 'session-99990000-1111-4aaa-8bbb-000000000099'
    const agent = {
      id: callerId,
      session: {
        header: { cwd: 'E:\\work-ws' },
        deriveMessages: () => [],
        snapshotEvents: () => [],
      },
    }
    claimedHandler({
      agent,
      message: {
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: `同时带轮次 〔aaaa1111#0〕 和事 〔work:${workId}〕` }],
      },
    })

    const assembly = { sections: [], contexts: [], tools: [], variables: {} }
    const out = await assembleHandler(assembly, { agent }, async () => assembly)
    const quoteCtx = out.contexts.find(c => c.name === 'topic-map:引用摘要')
    const workCtx = out.contexts.find(c => c.name === WORK_CONTEXT_NAME)
    assert.ok(quoteCtx, '轮次句柄应照常注入 topic-map:引用摘要')
    assert.ok(workCtx, '事级句柄应注入 topic-map:事续接现场')
    assert.equal(workCtx.interpolate, false)
    assert.ok(workCtx.text.includes('消除空输入导致的解析崩溃'))
  })
})

// ── 7. HTTP 端点契约 + /session-outline segments + 新配置项 ──────────

await test('HTTP 端点全链路：/works /works-scan /work-confirm /work-handoff /work-handoff-bind /work-inflection-dismiss /work-promote /work-merge /work-split /work-dismiss', async () => {
  await withTempHome(async () => {
    const recentTime = Date.now() - 60_000
    const events = {
      [SESS_A]: makeEvents([
        {
          prompt: '开发 lib/export-csv.js 导出功能',
          response: '初步完成 CSV 转义',
          toolCalls: [{ name: 'edit', arguments: { file_path: 'lib/export-csv.js' } }],
          endReason: 'error',
        },
      ], recentTime),
    }
    const ctx = makeCtx({ events })
    apply(ctx)
    assert.equal(ctx._routes.length, 1)
    const handler = ctx._routes[0].handler

    // 1) POST /works：首次未初始化快速返回 L0 结果，绝不卡白屏
    const worksRes = await callRoute(handler, 'POST', 'works', { workspaceId: WS })
    assert.equal(worksRes.status, 200)
    assert.equal(worksRes.body.ok, true)
    assert.ok(Array.isArray(worksRes.body.value.cards.unresolved))
    assert.equal(worksRes.body.value.cards.unresolved.length, 1)
    const workId = worksRes.body.value.cards.unresolved[0].id

    // 2) POST /works-scan（手动强制重扫）
    const scanRes = await callRoute(handler, 'POST', 'works-scan', { workspaceId: WS, force: true, useModel: false })
    assert.equal(scanRes.status, 200)
    assert.equal(scanRes.body.ok, true)

    // 3) POST /work-confirm
    const confirmRes = await callRoute(handler, 'POST', 'work-confirm', {
      workspaceId: WS,
      workId,
      patch: { state: 'active', nextStep: '补齐 UTF-8 BOM 测试', pinned: true },
    })
    assert.equal(confirmRes.status, 200)
    assert.equal(confirmRes.body.ok, true)
    assert.equal(confirmRes.body.value.work.pinned, true)
    assert.equal(confirmRes.body.value.work.nextStep, '补齐 UTF-8 BOM 测试')

    // 4) POST /work-handoff + /work-handoff-bind
    const handoffRes = await callRoute(handler, 'POST', 'work-handoff', {
      workspaceId: WS,
      workId,
      mode: 'new-session',
    })
    assert.equal(handoffRes.status, 200)
    assert.equal(handoffRes.body.ok, true)
    assert.equal(handoffRes.body.value.workHandle, `〔work:${workId}〕`)

    const bindRes = await callRoute(handler, 'POST', 'work-handoff-bind', {
      workspaceId: WS,
      workId,
      sessionId: SESS_NEW,
    })
    assert.equal(bindRes.status, 200)
    assert.equal(bindRes.body.ok, true)

    // 5) POST /work-promote /work-merge /work-split /work-dismiss
    const promoteRes = await callRoute(handler, 'POST', 'work-promote', {
      workspaceId: WS,
      segment: {
        id: 'seg:extra:0-0',
        sessionId: SESS_B,
        title: '临时排查任务',
        files: ['lib/extra.js'],
      },
    })
    assert.equal(promoteRes.status, 200)
    const promotedId = promoteRes.body.value.work.id

    const mergeRes = await callRoute(handler, 'POST', 'work-merge', {
      workspaceId: WS,
      targetWorkId: workId,
      sourceWorkId: promotedId,
    })
    assert.equal(mergeRes.status, 200)

    const splitRes = await callRoute(handler, 'POST', 'work-split', {
      workspaceId: WS,
      workId,
      segmentId: 'seg:extra:0-0',
    })
    assert.equal(splitRes.status, 200)
    const splitId = splitRes.body.value.work.id

    const dismissRes = await callRoute(handler, 'POST', 'work-dismiss', {
      workspaceId: WS,
      workId: splitId,
    })
    assert.equal(dismissRes.status, 200)

    // 6) POST /work-inflection-dismiss
    const infRes = await callRoute(handler, 'POST', 'work-inflection-dismiss', {
      workspaceId: WS,
    })
    assert.equal(infRes.status, 200)
    assert.equal(infRes.body.ok, true)

    // 7) 坏参数返回 400
    const badHandoff = await callRoute(handler, 'POST', 'work-handoff', {
      workspaceId: WS,
      workId,
      mode: 'invalid-mode',
    })
    assert.equal(badHandoff.status, 400)
    assert.equal(badHandoff.body.ok, false)

    // 8) GET/POST /config 支持 dormantDays + inflectionNotice
    const cfg0 = await callRoute(handler, 'GET', 'config')
    assert.equal(cfg0.status, 200)
    assert.equal(cfg0.body.value.dormantDays, 14)
    assert.equal(cfg0.body.value.inflectionNotice, true)

    const cfg1 = await callRoute(handler, 'POST', 'config', {
      dormantDays: 0,
      inflectionNotice: false,
    })
    assert.equal(cfg1.status, 200)
    assert.equal(cfg1.body.value.dormantDays, 0)
    assert.equal(cfg1.body.value.inflectionNotice, false)

    // 超界 dormantDays 回落当前值，不越界
    const cfg2 = await callRoute(handler, 'POST', 'config', { dormantDays: 999 })
    assert.equal(cfg2.body.value.dormantDays, 0)
  })
})

await test('mergeConfigPatch：dormantDays(0..365, 默认 14) 与 inflectionNotice(默认 true) 兼容旧配置对象', () => {
  const legacy = {
    provider: 'opencode',
    model: 'gpt-5',
    baseUrl: '',
    apiKey: '',
    modelName: '',
    turnLimit: 50,
    categoryBatch: 100,
    categoryLimit: 1000,
    digestLevel: 'standard',
    quoteMaxCount: 5,
    quoteMaxChars: 2400,
  }
  // 空 patch 不向旧对象凭空加键（保持 config-save.mjs 契约）
  assert.deepEqual(mergeConfigPatch(legacy, {}), legacy)
  // 显式提交时按规则归一化
  const patched = mergeConfigPatch(legacy, { dormantDays: 30, inflectionNotice: false })
  assert.equal(patched.dormantDays, 30)
  assert.equal(patched.inflectionNotice, false)
  // 0 表示不自动沉降
  const zero = mergeConfigPatch(patched, { dormantDays: 0 })
  assert.equal(zero.dormantDays, 0)
  // 非法值回落当前值
  const invalid = mergeConfigPatch(patched, { dormantDays: 500 })
  assert.equal(invalid.dormantDays, 30)
})

await test('readSessionOutline：向后兼容原有 turns 字段，同时返回 segments 两级目录', async () => {
  const events = {
    [SESS_A]: makeEvents([
      {
        prompt: '修 lib/a.js 的空指针问题',
        response: '已修 lib/a.js',
        toolCalls: [{ name: 'edit', arguments: { file_path: 'lib/a.js' } }],
        start: BASE_TIME,
        end: BASE_TIME + 5_000,
      },
      {
        prompt: '间隔 2 小时后换个话题聊聊午饭',
        response: '推荐面条',
        start: BASE_TIME + 2 * 3600_000,
        end: BASE_TIME + 2 * 3600_000 + 5_000,
      },
    ]),
  }
  const ctx = makeCtx({ events })
  const res = await readSessionOutline(ctx, { sessionId: SESS_A })
  assert.equal(res.ok, true)
  assert.equal(res.value.turns.length, 2)
  assert.ok(Array.isArray(res.value.segments))
  assert.equal(res.value.segments.length, 2)
  assert.equal(res.value.segments[0].turns[0].turn, 0)
  assert.equal(res.value.segments[1].turns[0].turn, 1)

  // 空会话也保持完全向后兼容（{ turns: [] }）
  const emptyCtx = makeCtx({ events: { [SESS_B]: [] } })
  const emptyRes = await readSessionOutline(emptyCtx, { sessionId: SESS_B })
  assert.equal(emptyRes.ok, true)
  assert.deepEqual(emptyRes.value, { turns: [] })
})

await test('prepareHandoff：same-session 未串台时草稿不塞冗余句柄；apply 订阅 agent/end 与 session/close 钩子', async () => {
  await withTempHome(async () => {
    const recentTime = Date.now() - 60_000
    const events = {
      [SESS_A]: makeEvents([
        {
          prompt: '实现 lib/clean-same.js',
          response: '完成初版 lib/clean-same.js',
          toolCalls: [{ name: 'edit', arguments: { file_path: 'lib/clean-same.js' } }],
          start: recentTime,
          end: recentTime + 5_000,
        },
      ]),
    }
    const ctx = makeCtx({ events })
    apply(ctx)
    assert.ok((ctx._listeners.get('agent/end') ?? []).length >= 1, 'apply 应注册 agent/end 钩子')
    assert.ok((ctx._listeners.get('session/close') ?? []).length >= 1, 'apply 应注册 session/close 钩子')

    const scan = await scanWorkspaceWorks(ctx, WS, { now: recentTime + 10_000, useModel: false })
    const w = scan.store.works[0]
    await confirmWork(WS, w.id, { nextStep: '补充边界测试' })

    const same = await prepareHandoff(ctx, WS, w.id, 'same-session')
    assert.equal(same.ok, true)
    assert.equal(same.value.drifted, false)
    assert.equal(same.value.draft.includes('〔work:'), false, '未串台时草稿不应塞冗余句柄')
    assert.ok(same.value.draft.includes('补充边界测试'))
  })
})

await test('POST /works：未初始化且有模型时先立刻返回 L0 硬信号，后台异步精化完成后更新物化快照', async () => {
  await withTempHome(async () => {
    const recentTime = Date.now() - 60_000
    const events = {
      [SESS_A]: makeEvents([
        {
          prompt: '修复 lib/async-refine.js 的内存泄漏',
          response: '已清理事件监听',
          toolCalls: [{ name: 'edit', arguments: { file_path: 'lib/async-refine.js' } }],
        },
      ], recentTime),
    }
    let resolveGate
    const gate = new Promise(r => { resolveGate = r })
    const llm = makeFakeLlm(async call => {
      await gate
      const m = call.messages[0].content[0].text.match(/\[(cl-\d+)\]/)
      const cid = m ? m[1] : 'cl-1'
      return JSON.stringify({
        works: [{
          clusterIds: [cid],
          title: '异步精化后的标题',
          goal: '彻底消除监听器泄漏',
          state: 'active',
          statusSummary: '已清理监听器',
          nextStep: '做压测回归',
          decisions: [],
        }],
        chatClusterIds: [],
      })
    })
    const ctx = makeCtx({ events, llm })
    apply(ctx)
    const handler = ctx._routes[0].handler

    // 首次 POST /works 在模型 gate 尚未释放前就立刻返回 L0 硬信号
    const first = await callRoute(handler, 'POST', 'works', { workspaceId: WS })
    assert.equal(first.status, 200)
    assert.equal(first.body.ok, true)
    assert.equal(first.body.value.refining, true)
    assert.equal(first.body.value.cards.unresolved.length, 1)

    // 释放模型 gate，等待后台精化落盘
    resolveGate()
    await new Promise(r => setTimeout(r, 60))

    const second = await callRoute(handler, 'POST', 'works', { workspaceId: WS })
    assert.equal(second.status, 200)
    assert.equal(second.body.value.cards.unresolved[0].title, '异步精化后的标题')
    assert.equal(second.body.value.cards.unresolved[0].nextStep, '做压测回归')
  })
})

console.log(`\n${passed} passed, ${failures.length} failures`)
if (failures.length > 0) {
  for (const failure of failures) console.error(`\n${failure.name}\n${failure.error.stack}`)
  process.exit(1)
}
