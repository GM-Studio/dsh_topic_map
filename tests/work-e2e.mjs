/**
 * 「段 → 事 → 交接 → Wire 展开 → 沉降唤醒 → 历史轨目录」全链路端到端集成测试。
 *
 * 严格走真实临时 DSH_HOME + 模拟宿主 ctx，通过 `apply(ctx)` 注册的真实
 * HTTP 路由与宿主事件（`agent/inbox/claimed`、`system-prompt/assemble`、
 * `agent/end` / `session/close`）把整条生产主链路打穿验证：
 *
 * 1. 完整生命周期主链路：
 *    - 3 个工作区会话（长混合会话含「工作 A → 1 轮短追问 → 工作 A → 纯闲聊」、
 *      引用会话 1 句柄的延续会话、子代理噪音会话）；
 *    - `POST /works` 冷启动盘点：子代理过滤、纯闲聊不进未收束清单、引用句柄跨会话合并为 1 件事；
 *    - `POST /session-outline` 同步返回 `segments` 供历史轨「段 → 轮次」目录消费；
 * 2. 人工确认与双表不覆盖：
 *    - `POST /work-confirm` 确认状态、自定义 `nextStep`、写入 2 条决策（第 2 条取代第 1 条）；
 *    - `POST /works-scan { force: true }` 强重扫后，已确认字段、决策与取代关系 100% 保留不被覆盖；
 * 3. 三层防失真交接与 Wire 自动展开：
 *    - `POST /work-handoff { mode: 'same-session' }` 验证串台检测（末尾纯闲聊 → `drifted: true` 且草稿含 `〔work:<id>〕`）；
 *    - `POST /work-handoff { mode: 'new-session' }` → `POST /work-handoff-bind` 写入 L1 交接血缘，
 *      再经增量同步验证无重叠文件的新会话凭 L1 血缘挂回同一件事；
 *    - `agent/inbox/claimed` + `system-prompt/assemble` 真实触发 `〔work:<id>〕` 自动展开：
 *      验证注入块含现行决策、已否决方案、程序直取硬事实与 `history_turn` 提示，
 *      且二次触发严格幂等不重复注入；
 * 4. 防污染红线、沉降唤醒与配置开关：
 *    - 已确认 `done` 老事在新会话写入同文件增量同步时保持 `done` 不被篡改，并产出 `reopenSuggestion`；
 *    - `POST /config` 修改 `dormantDays`（7 / 0）与 `inflectionNotice` 生效并影响沉降判定、轻提示与重聊唤醒；
 *    - `POST /work-promote`（话题段转事）与 `POST /work-dismiss`（误立事退回话题且重扫不复生）。
 *
 * Run: node tests/work-e2e.mjs
 */

import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  apply,
  flushIndexSyncs,
  syncSessionIndexFor,
} from '../lib/index.js'

import {
  WORK_CONTEXT_NAME,
  flushIncrementalSyncs,
  incrementalSyncSession,
  readWorkStore,
} from '../lib/work-store.js'

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

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const WS_ID = 'ws-e2e-main'
const WS_PATH = 'E:\\e2e-workspace'

// 固定 8hex 前缀，方便跨会话引用句柄精准指向会话 1 第 0 轮
const SESS_LONG = 'session-aa11bb22-1111-4aaa-8bbb-000000000001'
const SESS_CONT = 'session-cc33dd44-2222-4aaa-8bbb-000000000002'
const SESS_SUB = 'session-ee55ff66-3333-4aaa-8bbb-000000000003'
const SESS_HANDOFF = 'session-11223344-4444-4aaa-8bbb-000000000004'
const SESS_REOPEN = 'session-55667788-5555-4aaa-8bbb-000000000005'
const SESS_STALE = 'session-9900aabb-6666-4aaa-8bbb-000000000006'
const SESS_WAKE = 'session-ccddeeff-7777-4aaa-8bbb-000000000007'
const SESS_EXTRA = 'session-13572468-8888-4aaa-8bbb-000000000008'

async function withTempHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'work-e2e-'))
  const saved = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    return await fn(home)
  } finally {
    await flushIncrementalSyncs()
    await flushIndexSyncs()
    if (saved === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = saved
    await rm(home, { recursive: true, force: true })
  }
}

/** 构造贴近真实宿主事件流的会话事件数组（带 tool/call、workspace/changes、turn/end）。 */
function makeEvents(specs, baseTime) {
  let seq = 0
  const events = []
  const push = (type, data, time) => events.push({ type, seq: seq++, time, data })
  specs.forEach((spec, index) => {
    const start = spec.start ?? (baseTime + index * 60_000)
    const end = spec.end ?? (start + 5_000)
    const turn = spec.turn ?? index
    push('turn/start', { turn }, start)
    push('user/message', {
      content: [{ type: 'text', text: spec.prompt ?? `提问 ${turn}` }],
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
        content: [{ type: 'text', text: spec.response ?? `回复 ${turn}` }],
        source: { kind: 'model', provider: 'fake', model: 'fake-e2e' },
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

/**
 * 模拟宿主 Host 环境（支持 webServer、systemPrompt、workspaceRegistry、
 * sessionQuery、sessionPersistence、workspaceChanges、以及完整事件分发）。
 */
function createHostEnv(options = {}) {
  const events = options.events ?? {}
  const headers = options.headers ?? {}
  const titles = options.titles ?? {}
  const revisions = options.revisions ?? {}
  const changesBySession = options.changes ?? {}
  const llm = options.llm
  const sessionIds = options.sessionIds ?? Object.keys(events)
  const workspaces = options.workspaces ?? [{
    id: WS_ID,
    path: WS_PATH,
    title: '端到端集成工作区',
    sessionIds,
  }]

  const routes = []
  const listeners = new Map()

  const ctx = {
    _routes: routes,
    _listeners: listeners,
    get(name) {
      if (name === 'workspaceRegistry') return { list: () => workspaces }
      if (name === 'llm') return llm
      return undefined
    },
    on(eventName, fn) {
      if (!listeners.has(eventName)) listeners.set(eventName, [])
      listeners.get(eventName).push(fn)
      return () => {
        const list = listeners.get(eventName)
        if (!list) return
        const idx = list.indexOf(fn)
        if (idx >= 0) list.splice(idx, 1)
      }
    },
    effect(fn) {
      return fn()
    },
    inject(names, callback) {
      if (names.includes('webServer')) {
        callback({
          get(name) {
            if (name !== 'webServer') return undefined
            return {
              register(config) {
                routes.push(config)
                return () => {}
              },
            }
          },
          effect(fn) {
            return fn()
          },
        })
      }
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
        if (!(id in events)) return null
        return { header: { id, ...(headers[id] ?? {}) }, events: events[id] }
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

  apply(ctx)
  assert.equal(routes.length, 1, 'apply(ctx) 应注册唯一前缀路由 /api/topic-map')
  const handler = routes[0].handler

  async function request(method, action, body) {
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

  function emit(eventName, payload) {
    for (const fn of listeners.get(eventName) ?? []) {
      fn(payload)
    }
  }

  async function runSystemPromptAssemble(agent, initialAssembly = null) {
    const base = initialAssembly ?? { sections: [], contexts: [], tools: [], variables: {} }
    const fns = listeners.get('system-prompt/assemble') ?? []
    assert.ok(fns.length >= 1, 'system-prompt/assemble 钩子应已通过 apply(ctx) 注册')
    let chain = async () => base
    for (let i = fns.length - 1; i >= 0; i -= 1) {
      const fn = fns[i]
      const next = chain
      chain = () => fn(base, { agent }, next)
    }
    return chain()
  }

  function addSession(sessionId, sessionEvents, opts = {}) {
    events[sessionId] = sessionEvents
    if (opts.header) headers[sessionId] = opts.header
    if (opts.title) titles[sessionId] = opts.title
    if (opts.revision) revisions[sessionId] = opts.revision
    if (opts.changes) changesBySession[sessionId] = opts.changes
    if (!workspaces[0].sessionIds.includes(sessionId)) {
      workspaces[0].sessionIds.push(sessionId)
    }
  }

  return {
    ctx,
    events,
    headers,
    titles,
    revisions,
    changesBySession,
    workspaces,
    request,
    emit,
    runSystemPromptAssemble,
    addSession,
  }
}

/** 构造 3 个典型工作区会话的基础夹具（时间戳位于当前时间近 4 小时内，避免意外触发沉降）。 */
function buildCoreSessions(now) {
  const t0 = now - 3 * HOUR
  const tCont = now - 2 * HOUR
  const tSub = now - 1 * HOUR

  const events = {
    // 会话 1：长混合会话 = 工作 A（轮 0） → 1 轮短追问（轮 1） → 工作 A（轮 2） → 隔 2 小时纯闲聊（轮 3）
    // 期望切段：轮 0-2 吸附为 1 段工作 A（三明治保护不被砍碎），轮 3 独立为 1 段纯闲聊（同时制造末尾串台）
    [SESS_LONG]: makeEvents([
      {
        turn: 0,
        prompt: '修复 lib/billing-calc.js 优惠券分摊精度丢失问题',
        response: '定位到浮点数累乘误差，已改用分单位整数分摊逻辑。',
        toolCalls: [
          { name: 'edit', arguments: { file_path: 'lib/billing-calc.js' } },
          { name: 'pwsh', arguments: { command: 'node tests/billing-calc.mjs' } },
        ],
        hasChanges: true,
        endReason: 'error',
        start: t0,
        end: t0 + 30_000,
      },
      {
        turn: 1,
        prompt: '那满减叠加折扣的顺序呢？',
        response: '按先满减后比例折扣处理，避免出现负分摊。',
        start: t0 + 120_000,
        end: t0 + 140_000,
      },
      {
        turn: 2,
        prompt: '好的，继续把 lib/billing-calc.js 的边界用例补进 tests/billing-calc.mjs 并复跑测试',
        response: '已补充边界测试，仍有 1 条跨币种四舍五入用例失败待排查。',
        toolCalls: [
          { name: 'edit', arguments: { file_path: 'tests/billing-calc.mjs' } },
          { name: 'pwsh', arguments: { command: 'node tests/billing-calc.mjs --grep currency' } },
        ],
        hasChanges: true,
        endReason: 'error',
        start: t0 + 240_000,
        end: t0 + 270_000,
      },
      {
        turn: 3,
        prompt: '顺便问下周末去苏州园林一日游，拙政园和狮子林怎么安排路线不绕路？',
        response: '建议上午早进拙政园，步行去苏州博物馆，下午逛狮子林和平江路。',
        start: t0 + 2 * HOUR,
        end: t0 + 2 * HOUR + 20_000,
      },
    ]),

    // 会话 2：延续会话，显式引用会话 1 第 0 轮句柄 〔aa11bb22#0〕，但不重复修改同一文件
    // 期望通过引用句柄与会话 1 的工作 A 跨会话合并为 1 件「事」
    [SESS_CONT]: makeEvents([
      {
        turn: 0,
        prompt: '接着 【@第0轮对话〔aa11bb22#0〕】 的优惠券分摊继续排查跨币种汇率表读取',
        response: '已定位到 lib/fx-rates.js 缺少 JPY 零小数位配置，待补充单测验证。',
        toolCalls: [
          { name: 'edit', arguments: { file_path: 'lib/fx-rates.js' } },
          { name: 'pwsh', arguments: { command: 'node tests/fx-rates.mjs' } },
        ],
        hasChanges: true,
        start: tCont,
        end: tCont + 25_000,
      },
    ]),

    // 会话 3：子代理噪音会话（即使改了文件、有报错，也必须被完全过滤）
    [SESS_SUB]: makeEvents([
      {
        turn: 0,
        prompt: '子代理后台巡检临时脚本 lib/subagent-noise.js',
        response: '巡检报错退出',
        toolCalls: [{ name: 'edit', arguments: { file_path: 'lib/subagent-noise.js' } }],
        hasChanges: true,
        endReason: 'error',
        start: tSub,
        end: tSub + 15_000,
      },
    ]),
  }

  const headers = {
    [SESS_LONG]: { id: SESS_LONG, cwd: WS_PATH },
    [SESS_CONT]: { id: SESS_CONT, cwd: WS_PATH },
    [SESS_SUB]: { id: SESS_SUB, cwd: WS_PATH, origin: 'subagent', delegationDepth: 1 },
  }

  const changes = {
    [SESS_LONG]: {
      default: { files: [{ path: 'lib/billing-calc.js', added: 28, deleted: 9 }] },
    },
    [SESS_CONT]: {
      default: { files: [{ path: 'lib/fx-rates.js', added: 15, deleted: 2 }] },
    },
    [SESS_SUB]: {
      default: { files: [{ path: 'lib/subagent-noise.js', added: 5, deleted: 0 }] },
    },
  }

  return { events, headers, changes }
}

console.log('\nwork-e2e')

// ── 场景 1：完整生命周期主链路（切段 → 冷启动盘点 → 历史轨段目录） ────

await test('1. 完整生命周期主链路：冷启动盘点过滤子代理与纯闲聊、句柄跨会话合并，/session-outline 返回段目录', async () => {
  await withTempHome(async () => {
    const now = Date.now()
    const fixture = buildCoreSessions(now)
    const env = createHostEnv(fixture)

    // 先落盘轮次索引（贴近生产：含 workspaceChanges 写入的 changes.files 硬事实）
    await syncSessionIndexFor(env.ctx, SESS_LONG)
    await syncSessionIndexFor(env.ctx, SESS_CONT)
    await syncSessionIndexFor(env.ctx, SESS_SUB)

    // 1) POST /works 触发首次冷启动盘点
    const worksRes = await env.request('POST', 'works', { workspaceId: WS_ID })
    assert.equal(worksRes.status, 200)
    assert.equal(worksRes.body.ok, true)
    assert.equal(worksRes.body.value.initialized, true)

    const { cards, works } = worksRes.body.value
    // 子代理被过滤、纯闲聊不进未收束清单、会话 1 工作 A 与会话 2 通过句柄合并为 1 件「事」
    assert.equal(cards.unresolved.length, 1, `应仅有 1 件未收束事，实际：${JSON.stringify(cards.unresolved)}`)
    assert.equal(works.length, 1, `纯闲聊与子代理不应立事，实际 works=${works.length}`)

    const mergedWork = works[0]
    assert.equal(mergedWork.sessionIds.includes(SESS_LONG), true, '合并事应包含长混合会话')
    assert.equal(mergedWork.sessionIds.includes(SESS_CONT), true, '合并事应通过 〔aa11bb22#0〕 吸纳延续会话')
    assert.equal(mergedWork.sessionIds.includes(SESS_SUB), false, '子代理会话必须被彻底过滤')
    assert.equal(
      mergedWork.segmentIds.includes('seg:aa11bb22:0-2'),
      true,
      `工作 A + 1 轮短追问 + 工作 A 应吸附为连续段 seg:aa11bb22:0-2，实际：${JSON.stringify(mergedWork.segmentIds)}`,
    )
    assert.equal(
      mergedWork.segmentIds.includes('seg:aa11bb22:3-3'),
      false,
      '纯闲聊段 seg:aa11bb22:3-3 不应混入工作事',
    )
    assert.equal(
      mergedWork.segmentIds.includes('seg:cc33dd44:0-0'),
      true,
      '延续会话段 seg:cc33dd44:0-0 应合并到同一件事',
    )
    assert.equal(mergedWork.files.some(f => f.includes('subagent-noise')), false)
    assert.equal(cards.unresolved[0].sessionCount, 2)
    assert.equal(cards.unresolved[0].segmentCount, 2)

    // 验证持久化 store 中闲聊段仍在段表里且 kindCandidate=chat、未挂到任何事
    const persisted = await readWorkStore(WS_ID)
    assert.equal(persisted.ok, true)
    assert.equal(persisted.store.segments['seg:aa11bb22:3-3']?.kindCandidate, 'chat')
    assert.equal(persisted.store.segments['seg:aa11bb22:3-3']?.workId ?? null, null)

    // 2) POST /session-outline 同步返回 segments 供历史轨「段 → 轮次」目录消费
    const outlineRes = await env.request('POST', 'session-outline', { sessionId: SESS_LONG })
    assert.equal(outlineRes.status, 200)
    assert.equal(outlineRes.body.ok, true)
    assert.equal(outlineRes.body.value.turns.length, 4, '原有 turns 字段保持全量 4 轮兼容')
    assert.ok(Array.isArray(outlineRes.body.value.segments), '应同步返回 segments 数组')
    assert.equal(outlineRes.body.value.segments.length, 2, '长混合会话应切成 2 段（工作 A 三明治段 + 末尾纯闲聊段）')

    const [workSeg, chatSeg] = outlineRes.body.value.segments
    assert.equal(workSeg.id, 'seg:aa11bb22:0-2')
    assert.equal(workSeg.kindCandidate, 'work')
    assert.deepEqual(workSeg.turns.map(t => t.turn), [0, 1, 2])
    assert.equal(chatSeg.id, 'seg:aa11bb22:3-3')
    assert.equal(chatSeg.kindCandidate, 'chat')
    assert.deepEqual(chatSeg.turns.map(t => t.turn), [3])
  })
})

// ── 场景 2：人工确认锁定与双表不覆盖 ────────────────────────────────

await test('2. 人工确认与双表不覆盖：/work-confirm 写决策与取代关系后，/works-scan force:true 100% 保留', async () => {
  await withTempHome(async () => {
    const now = Date.now()
    const fixture = buildCoreSessions(now)
    const env = createHostEnv(fixture)

    await syncSessionIndexFor(env.ctx, SESS_LONG)
    await syncSessionIndexFor(env.ctx, SESS_CONT)
    await syncSessionIndexFor(env.ctx, SESS_SUB)

    const initial = await env.request('POST', 'works', { workspaceId: WS_ID })
    assert.equal(initial.status, 200)
    const workId = initial.body.value.works[0].id

    // 第 1 次确认：锁定状态、标题、目标、自定义 nextStep、pinned，并写入第 1 条决策
    const c1 = await env.request('POST', 'work-confirm', {
      workspaceId: WS_ID,
      workId,
      patch: {
        title: '优惠券分摊与跨币种精度修复',
        goal: '消除多币种优惠券分摊的浮点舍入误差',
        state: 'blocked',
        nextStep: '先补齐 JPY/KRW 零小数位汇率配置再重跑 tests/billing-calc.mjs',
        pinned: true,
        addDecision: {
          summary: '方案一：保留浮点运算并在最终展示层做 toFixed(2)',
          rationale: '改动量最小',
          evidenceHandle: '〔aa11bb22#0〕',
        },
      },
    })
    assert.equal(c1.status, 200)
    assert.equal(c1.body.ok, true)
    assert.equal(c1.body.value.work.decisions.length, 1)
    const firstDecId = c1.body.value.work.decisions[0].id

    // 第 2 次确认：写入第 2 条决策并取代第 1 条
    const c2 = await env.request('POST', 'work-confirm', {
      workspaceId: WS_ID,
      workId,
      patch: {
        supersedeDecision: {
          oldId: firstDecId,
          decision: {
            summary: '方案二：按币种最小货币单位整数分摊，余数按最大权重项归集',
            rationale: '彻底消除累乘浮点漂移并兼容 JPY 零小数位',
            evidenceHandle: '〔cc33dd44#0〕',
          },
        },
      },
    })
    assert.equal(c2.status, 200)
    assert.equal(c2.body.ok, true)
    assert.equal(c2.body.value.work.decisions.length, 2)
    const decOldBefore = c2.body.value.work.decisions.find(d => d.id === firstDecId)
    const decNewBefore = c2.body.value.work.decisions.find(d => d.id !== firstDecId)
    assert.equal(decOldBefore.status, 'superseded')
    assert.equal(decOldBefore.supersededBy, decNewBefore.id)
    assert.equal(decNewBefore.status, 'active')

    // 强制触发后台全量重扫（即使底层会话里没有人工决策与自定义 nextStep）
    const rescan = await env.request('POST', 'works-scan', {
      workspaceId: WS_ID,
      force: true,
      useModel: false,
    })
    assert.equal(rescan.status, 200)
    assert.equal(rescan.body.ok, true)
    assert.equal(rescan.body.value.scanned, true)

    // 读回核验：所有已确认字段、决策列表与取代链 100% 原样保留
    const after = await env.request('POST', 'works', { workspaceId: WS_ID })
    assert.equal(after.status, 200)
    const kept = after.body.value.works.find(w => w.id === workId)
    assert.ok(kept, '重扫后原已确认事 ID 不得漂移或丢失')
    assert.equal(kept.title, '优惠券分摊与跨币种精度修复')
    assert.equal(kept.goal, '消除多币种优惠券分摊的浮点舍入误差')
    assert.equal(kept.state, 'blocked')
    assert.equal(kept.stateSource, 'confirmed')
    assert.equal(kept.nextStep, '先补齐 JPY/KRW 零小数位汇率配置再重跑 tests/billing-calc.mjs')
    assert.equal(kept.nextStepSource, 'confirmed')
    assert.equal(kept.pinned, true)
    assert.equal(kept.reviewStatus, 'reviewed')

    assert.equal(kept.decisions.length, 2)
    const decOldAfter = kept.decisions.find(d => d.id === firstDecId)
    const decNewAfter = kept.decisions.find(d => d.id === decNewBefore.id)
    assert.ok(decOldAfter && decNewAfter)
    assert.equal(decOldAfter.status, 'superseded')
    assert.equal(decOldAfter.supersededBy, decNewAfter.id)
    assert.equal(decOldAfter.source, 'confirmed')
    assert.equal(decNewAfter.status, 'active')
    assert.equal(decNewAfter.source, 'confirmed')
    assert.equal(decNewAfter.summary, decNewBefore.summary)
  })
})

// ── 场景 3：三层防失真交接 + L1 血缘绑定 + Wire 自动展开与幂等 ───────

await test('3. 三层防失真交接与 Wire 自动展开：串台检测、L1 交接血缘、system-prompt/assemble 展开及严格幂等', async () => {
  await withTempHome(async () => {
    const now = Date.now()
    const fixture = buildCoreSessions(now)
    // 让 SESS_LONG 的最后工作轮（turn 2）晚于 SESS_CONT，确保 same-session 默认落回已串台的 SESS_LONG
    const tLongLatest = now - 30 * 60 * 1000
    fixture.events[SESS_LONG] = makeEvents([
      {
        turn: 0,
        prompt: '修复 lib/billing-calc.js 优惠券分摊精度丢失问题',
        response: '已改为分单位整数分摊。',
        toolCalls: [
          { name: 'edit', arguments: { file_path: 'lib/billing-calc.js' } },
          { name: 'pwsh', arguments: { command: 'node tests/billing-calc.mjs' } },
        ],
        hasChanges: true,
        endReason: 'error',
        start: tLongLatest - 3 * HOUR,
        end: tLongLatest - 3 * HOUR + 20_000,
      },
      {
        turn: 1,
        prompt: '那满减顺序呢？',
        response: '先满减后折扣。',
        start: tLongLatest - 3 * HOUR + 60_000,
        end: tLongLatest - 3 * HOUR + 80_000,
      },
      {
        turn: 2,
        prompt: '继续修 lib/billing-calc.js 并复跑测试',
        response: '跨币种 JPY 舍入用例仍报错 AssertionError。',
        toolCalls: [
          { name: 'edit', arguments: { file_path: 'lib/billing-calc.js' } },
          { name: 'pwsh', arguments: { command: 'node tests/billing-calc.mjs --grep jpy' } },
        ],
        hasChanges: true,
        endReason: 'error',
        start: tLongLatest - 2 * HOUR,
        end: tLongLatest - 2 * HOUR + 20_000,
      },
      {
        turn: 3,
        prompt: '顺便问下周末去苏州园林一日游，拙政园和狮子林怎么安排？',
        response: '建议上午拙政园，下午狮子林。',
        start: tLongLatest,
        end: tLongLatest + 15_000,
      },
    ])
    // SESS_CONT 时间早于 SESS_LONG 的工作轮，仍通过句柄合并进同一件事
    fixture.events[SESS_CONT] = makeEvents([
      {
        turn: 0,
        prompt: '接着 【@第0轮对话〔aa11bb22#0〕】 核对 lib/fx-rates.js 汇率表',
        response: '已补充 USD/EUR 精度，JPY 待确认。',
        toolCalls: [{ name: 'edit', arguments: { file_path: 'lib/fx-rates.js' } }],
        hasChanges: true,
        start: tLongLatest - 2.5 * HOUR,
        end: tLongLatest - 2.5 * HOUR + 20_000,
      },
    ])

    const env = createHostEnv(fixture)
    await syncSessionIndexFor(env.ctx, SESS_LONG)
    await syncSessionIndexFor(env.ctx, SESS_CONT)
    await syncSessionIndexFor(env.ctx, SESS_SUB)

    const worksRes = await env.request('POST', 'works', { workspaceId: WS_ID })
    assert.equal(worksRes.status, 200)
    const workId = worksRes.body.value.works[0].id

    // 写入明确目标、下一步以及「现行决策 + 已否决方案」
    const c1 = await env.request('POST', 'work-confirm', {
      workspaceId: WS_ID,
      workId,
      patch: {
        title: '优惠券跨币种分摊修复',
        goal: '全币种分摊误差归零',
        state: 'blocked',
        nextStep: '补齐 JPY 零小数位配置并跑通 billing-calc 测试',
        addDecision: {
          summary: '否决方案：在前端展示层四舍五入兜底',
          rationale: '账单落库金额仍然对不平',
          evidenceHandle: '〔aa11bb22#0〕',
        },
      },
    })
    const oldDecId = c1.body.value.work.decisions[0].id
    await env.request('POST', 'work-confirm', {
      workspaceId: WS_ID,
      workId,
      patch: {
        supersedeDecision: {
          oldId: oldDecId,
          decision: {
            summary: '现行方案：统一按最小货币单位整数分摊',
            rationale: '前后端与对账单绝对一致',
            evidenceHandle: '〔cc33dd44#0〕',
          },
        },
      },
    })

    // 1) same-session 串台检测：目标会话 SESS_LONG 末尾是苏州园林闲聊 → drifted: true + 草稿含 〔work:<id>〕
    const sameRes = await env.request('POST', 'work-handoff', {
      workspaceId: WS_ID,
      workId,
      mode: 'same-session',
    })
    assert.equal(sameRes.status, 200)
    assert.equal(sameRes.body.ok, true)
    assert.equal(sameRes.body.value.targetSessionId, SESS_LONG)
    assert.equal(sameRes.body.value.drifted, true, '原会话末尾聊了苏州园林闲聊应检出串台')
    assert.ok(sameRes.body.value.turnsSinceWork >= 1)
    assert.ok(
      sameRes.body.value.draft.includes(`〔work:${workId}〕`),
      `串台草稿必须携带 〔work:${workId}〕，实际：${sameRes.body.value.draft}`,
    )
    assert.ok(sameRes.body.value.draft.includes('补齐 JPY 零小数位配置'))

    // 2) new-session 交接包 + POST /work-handoff-bind 写入 L1 交接血缘
    const newRes = await env.request('POST', 'work-handoff', {
      workspaceId: WS_ID,
      workId,
      mode: 'new-session',
    })
    assert.equal(newRes.status, 200)
    assert.equal(newRes.body.ok, true)
    assert.equal(newRes.body.value.workHandle, `〔work:${workId}〕`)
    assert.ok(newRes.body.value.draft.includes(`〔work:${workId}〕`))
    assert.ok(newRes.body.value.hardFacts.changedFiles.some(f => f.path === 'lib/billing-calc.js'))
    assert.ok(newRes.body.value.hardFacts.recentCommands.some(c => c.includes('billing-calc.mjs')))
    assert.ok(newRes.body.value.hardFacts.failedSignals.length >= 1)

    const bindRes = await env.request('POST', 'work-handoff-bind', {
      workspaceId: WS_ID,
      workId,
      sessionId: SESS_HANDOFF,
    })
    assert.equal(bindRes.status, 200)
    assert.equal(bindRes.body.ok, true)
    assert.deepEqual(bindRes.body.value.bound, { sessionId: SESS_HANDOFF, workId })

    const storeAfterBind = await readWorkStore(WS_ID)
    assert.equal(storeAfterBind.store.handoffLinks[SESS_HANDOFF], workId)

    // 3) 通过真实宿主钩子 agent/inbox/claimed + system-prompt/assemble 触发 〔work:<id>〕 自动展开
    const agent = {
      id: SESS_HANDOFF,
      session: {
        id: SESS_HANDOFF,
        header: { id: SESS_HANDOFF, cwd: WS_PATH },
        deriveMessages: () => [],
        snapshotEvents: () => [],
      },
    }

    env.emit('agent/inbox/claimed', {
      agent,
      message: {
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: newRes.body.value.draft }],
      },
    })

    const assembled1 = await env.runSystemPromptAssemble(agent)
    const workCtx1 = assembled1.contexts.find(c => c.name === WORK_CONTEXT_NAME)
    assert.ok(workCtx1, 'system-prompt/assemble 必须注入 topic-map:事续接现场')
    assert.equal(workCtx1.interpolate, false, '事续接现场必须关闭模板插值避免误解析花括号')

    const text = workCtx1.text
    assert.ok(text.includes(`〔work:${workId}〕`), '注入块应标注事句柄')
    assert.ok(text.includes('全币种分摊误差归零'), '注入块应含目标')
    assert.ok(text.includes('补齐 JPY 零小数位配置并跑通 billing-calc 测试'), '注入块应含唯一行动')
    assert.ok(text.includes('现行方案：统一按最小货币单位整数分摊'), '注入块应含现行决策')
    assert.ok(text.includes('[已否决] 否决方案：在前端展示层四舍五入兜底'), '注入块应含已否决方案')
    assert.ok(text.includes('lib/billing-calc.js'), '注入块应含程序直取变更文件硬事实')
    assert.ok(text.includes('node tests/billing-calc.mjs'), '注入块应含程序直取最近命令硬事实')
    assert.ok(text.includes('history_turn'), '注入块应含按句柄拉取原文的 history_turn 提示')

    // 二次触发同会话、同一 〔work:<id>〕（模拟第二轮用户再次提及该句柄）：严格幂等不重复注入
    env.emit('agent/inbox/claimed', {
      agent,
      message: {
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: `再次核对 〔work:${workId}〕 的下一步` }],
      },
    })
    const assembled2 = await env.runSystemPromptAssemble(agent)
    const workCtx2 = assembled2.contexts.find(c => c.name === WORK_CONTEXT_NAME)
    assert.equal(workCtx2, undefined, '同一会话同一 workId 二次触发必须严格幂等，不再重复注入')

    // 4) 验证新会话即便完全不改重叠文件，增量同步也凭 L1 handoff 血缘准确挂回原事
    env.addSession(
      SESS_HANDOFF,
      makeEvents([
        {
          turn: 0,
          prompt: newRes.body.value.draft,
          response: '已核对汇率配置，准备补齐测试断言。',
          start: now - 5 * 60 * 1000,
          end: now - 4 * 60 * 1000,
        },
      ]),
      { header: { id: SESS_HANDOFF, cwd: WS_PATH } },
    )
    const l1Sync = await incrementalSyncSession(env.ctx, SESS_HANDOFF, { now, useModel: false })
    assert.equal(l1Sync.ok, true)
    assert.equal(l1Sync.match.action, 'attach')
    assert.equal(l1Sync.match.level, 'L1')
    assert.equal(l1Sync.match.reason, 'handoff')
    assert.equal(l1Sync.match.workId, workId)
  })
})

// ── 场景 4：防污染红线、沉降唤醒配置、promote / dismiss 闭环 ─────────

await test('4. 防污染红线与沉降配置：done 老事不篡改并产出 reopenSuggestion、dormantDays/inflectionNotice、promote/dismiss', async () => {
  await withTempHome(async () => {
    const now = Date.now()

    // 初始包含：
    // - SESS_LONG（刚活动过，用于测试 done 防污染红线）
    // - SESS_STALE（10 天前活动过，用于测试 dormantDays=14 不沉降 → 改 7 沉降 → 改 0 不沉降 + 重聊唤醒）
    // - SESS_EXTRA（单段工作，用于测试 /work-dismiss 后重扫不复生）
    const env = createHostEnv({
      events: {
        [SESS_LONG]: makeEvents([
          {
            turn: 0,
            prompt: '重构 lib/invoice-pdf.js 发票渲染管线',
            response: '已完成 lib/invoice-pdf.js 重构并通过全部测试',
            toolCalls: [{ name: 'edit', arguments: { file_path: 'lib/invoice-pdf.js' } }],
            hasChanges: true,
            start: now - 2 * HOUR,
            end: now - 2 * HOUR + 20_000,
          },
        ]),
        [SESS_STALE]: makeEvents([
          {
            turn: 0,
            prompt: '优化 lib/report-cache.js 缓存失效策略',
            response: '先加了局部锁，还需要压测观察',
            toolCalls: [{ name: 'edit', arguments: { file_path: 'lib/report-cache.js' } }],
            hasChanges: true,
            start: now - 10 * DAY,
            end: now - 10 * DAY + 20_000,
          },
        ]),
        [SESS_EXTRA]: makeEvents([
          {
            turn: 0,
            prompt: '临时排查一下 lib/oneoff-check.js 的日志格式',
            response: '只是确认下字段名，不需要后续跟进',
            toolCalls: [{ name: 'edit', arguments: { file_path: 'lib/oneoff-check.js' } }],
            hasChanges: true,
            start: now - 1 * HOUR,
            end: now - 1 * HOUR + 10_000,
          },
        ]),
      },
      headers: {
        [SESS_LONG]: { id: SESS_LONG, cwd: WS_PATH },
        [SESS_STALE]: { id: SESS_STALE, cwd: WS_PATH },
        [SESS_EXTRA]: { id: SESS_EXTRA, cwd: WS_PATH },
      },
      changes: {
        [SESS_LONG]: { default: { files: [{ path: 'lib/invoice-pdf.js', added: 40, deleted: 12 }] } },
        [SESS_STALE]: { default: { files: [{ path: 'lib/report-cache.js', added: 18, deleted: 4 }] } },
        [SESS_EXTRA]: { default: { files: [{ path: 'lib/oneoff-check.js', added: 2, deleted: 1 }] } },
      },
    })

    await syncSessionIndexFor(env.ctx, SESS_LONG)
    await syncSessionIndexFor(env.ctx, SESS_STALE)
    await syncSessionIndexFor(env.ctx, SESS_EXTRA)

    // 冷启动盘点：默认 dormantDays = 14，因此 10 天前的 report-cache 仍为 active 未沉降
    const initRes = await env.request('POST', 'works', { workspaceId: WS_ID })
    assert.equal(initRes.status, 200)
    const invoiceWork = initRes.body.value.works.find(w => w.sessionIds.includes(SESS_LONG))
    const staleWork = initRes.body.value.works.find(w => w.sessionIds.includes(SESS_STALE))
    const extraWork = initRes.body.value.works.find(w => w.sessionIds.includes(SESS_EXTRA))
    assert.ok(invoiceWork && staleWork && extraWork)
    assert.equal(staleWork.state, 'active', '默认 dormantDays=14 时，10 天前的事不应沉降')

    // ── A. 防污染红线：将 invoiceWork 标为已确认 done，新会话改同文件触发增量同步 ──
    const doneRes = await env.request('POST', 'work-confirm', {
      workspaceId: WS_ID,
      workId: invoiceWork.id,
      patch: { state: 'done', statusSummary: '已验收上线' },
    })
    assert.equal(doneRes.status, 200)
    assert.equal(doneRes.body.value.work.state, 'done')
    assert.equal(doneRes.body.value.work.stateSource, 'confirmed')

    env.addSession(
      SESS_REOPEN,
      makeEvents([
        {
          turn: 0,
          prompt: '排查 lib/invoice-pdf.js 新出现的中文页脚截断问题',
          response: '已在 lib/invoice-pdf.js 复现并修改页脚宽度',
          toolCalls: [{ name: 'edit', arguments: { file_path: 'lib/invoice-pdf.js' } }],
          hasChanges: true,
          start: now - 5 * 60 * 1000,
          end: now - 4 * 60 * 1000,
        },
      ]),
      {
        header: { id: SESS_REOPEN, cwd: WS_PATH },
        changes: { default: { files: [{ path: 'lib/invoice-pdf.js', added: 6, deleted: 2 }] } },
      },
    )
    await syncSessionIndexFor(env.ctx, SESS_REOPEN)

    const reopenSync = await incrementalSyncSession(env.ctx, SESS_REOPEN, { now, useModel: false })
    assert.equal(reopenSync.ok, true)
    assert.equal(reopenSync.match.action, 'suggest_reopen', '撞上已确认 done 老事应返回 suggest_reopen')
    assert.equal(reopenSync.match.level, 'L2')
    assert.equal(reopenSync.match.relatedDoneWorkId, invoiceWork.id)

    // 通过 POST /works 验证旧事纹丝不动保持 done，且接口透出 reopenSuggestion
    const afterReopen = await env.request('POST', 'works', { workspaceId: WS_ID })
    assert.equal(afterReopen.status, 200)
    const doneKept = afterReopen.body.value.works.find(w => w.id === invoiceWork.id)
    assert.equal(doneKept.state, 'done', '已确认 done 老事绝不能被静默改回 active')
    assert.equal(doneKept.stateSource, 'confirmed')
    assert.equal(doneKept.sessionIds.includes(SESS_REOPEN), false, '旧事不应被静默挂载新会话')
    assert.ok(afterReopen.body.value.reopenSuggestion, '应产出 reopenSuggestion 轻提示')
    assert.equal(afterReopen.body.value.reopenSuggestion.relatedDoneWorkId, invoiceWork.id)
    assert.equal(afterReopen.body.value.reopenSuggestion.sessionId, SESS_REOPEN)

    // ── B. POST /config 修改 dormantDays（7 / 0）与 inflectionNotice 生效 ──
    // 1) dormantDays 改为 7：10 天前未确认的 staleWork 立即沉降进 settled（shelved）
    const cfg7 = await env.request('POST', 'config', { dormantDays: 7, inflectionNotice: true })
    assert.equal(cfg7.status, 200)
    assert.equal(cfg7.body.value.dormantDays, 7)
    assert.equal(cfg7.body.value.inflectionNotice, true)

    const view7 = await env.request('POST', 'works', { workspaceId: WS_ID })
    assert.equal(view7.status, 200)
    assert.equal(
      view7.body.value.cards.settled.some(c => c.id === staleWork.id && c.state === 'shelved'),
      true,
      'dormantDays=7 时，10 天前的推测态事应沉降为 shelved',
    )
    assert.equal(view7.body.value.cards.unresolved.some(c => c.id === staleWork.id), false)

    // 2) dormantDays 改为 0（关闭自动沉降）：未落盘覆盖前读视图立刻恢复 active（不自动沉降）
    const cfg0 = await env.request('POST', 'config', { dormantDays: 0 })
    assert.equal(cfg0.status, 200)
    assert.equal(cfg0.body.value.dormantDays, 0)

    const view0 = await env.request('POST', 'works', { workspaceId: WS_ID })
    assert.equal(view0.status, 200)
    assert.equal(
      view0.body.value.cards.unresolved.some(c => c.id === staleWork.id && c.state === 'active'),
      true,
      'dormantDays=0 时应关闭自动沉降，staleWork 保持在 unresolved',
    )

    // 3) 切回 dormantDays=7 并强制重扫把 shelved 落盘，随后新会话改同文件自动唤醒并触发拐点轻提示
    await env.request('POST', 'config', { dormantDays: 7, inflectionNotice: true })
    const scanSettled = await env.request('POST', 'works-scan', {
      workspaceId: WS_ID,
      force: true,
      useModel: false,
    })
    assert.equal(scanSettled.status, 200)
    const shelvedWork = scanSettled.body.value.works.find(w => w.sessionIds.includes(SESS_STALE))
    assert.ok(shelvedWork)
    assert.equal(shelvedWork.state, 'shelved', '强制重扫落盘后 staleWork 应为 shelved')

    // 3b) 对已沉降的 shelvedWork 发起交接绑定 + 新活动增量同步 → 验证 shelved 自动唤醒回 active 并触发报错拐点
    const wakeBind = await env.request('POST', 'work-handoff-bind', {
      workspaceId: WS_ID,
      workId: shelvedWork.id,
      sessionId: SESS_WAKE,
    })
    assert.equal(wakeBind.status, 200)

    env.addSession(
      SESS_WAKE,
      makeEvents([
        {
          turn: 0,
          prompt: '继续处理 lib/report-cache.js 缓存击穿告警',
          response: '压测复现了超时异常 Error: cache lock timeout',
          toolCalls: [{ name: 'edit', arguments: { file_path: 'lib/report-cache.js' } }],
          hasChanges: true,
          endReason: 'error',
          start: now - 2 * 60 * 1000,
          end: now - 1 * 60 * 1000,
        },
      ]),
      {
        header: { id: SESS_WAKE, cwd: WS_PATH },
        changes: { default: { files: [{ path: 'lib/report-cache.js', added: 9, deleted: 1 }] } },
      },
    )
    await syncSessionIndexFor(env.ctx, SESS_WAKE)

    const wakeSync = await incrementalSyncSession(env.ctx, SESS_WAKE, {
      now,
      useModel: false,
      dormantDays: 7,
      config: { dormantDays: 7, inflectionNotice: true },
    })
    assert.equal(wakeSync.ok, true)
    assert.equal(wakeSync.match.action, 'attach')
    assert.equal(wakeSync.match.level, 'L1')
    assert.equal(wakeSync.match.workId, shelvedWork.id)
    const wokenWork = wakeSync.store.works.find(w => w.id === shelvedWork.id)
    assert.equal(wokenWork.state, 'active', '已沉降（shelved）的事在新活动挂载后应自动唤醒为 active')
    assert.ok(wakeSync.inflection, '报错轮次应检出自然拐点')

    // 验证增量三级挂载完整闭环：L1（上方交接唤醒）→ L2（同业务文件重叠）→ L3（模型语义匹配）
    const SESS_L2 = 'session-24681357-9999-4aaa-8bbb-000000000009'
    env.addSession(
      SESS_L2,
      makeEvents([
        {
          turn: 0,
          prompt: '再给 lib/report-cache.js 加一层防并发击穿的 singleflight 缓存合并',
          response: '已补充 singleflight 逻辑',
          toolCalls: [{ name: 'edit', arguments: { file_path: 'lib/report-cache.js' } }],
          hasChanges: true,
          start: now - 60_000,
          end: now - 30_000,
        },
      ]),
      {
        header: { id: SESS_L2, cwd: WS_PATH },
        changes: { default: { files: [{ path: 'lib/report-cache.js', added: 11, deleted: 0 }] } },
      },
    )
    await syncSessionIndexFor(env.ctx, SESS_L2)
    const l2Sync = await incrementalSyncSession(env.ctx, SESS_L2, { now, useModel: false })
    assert.equal(l2Sync.ok, true)
    assert.equal(l2Sync.match.action, 'attach')
    assert.equal(l2Sync.match.level, 'L2', '同业务文件修改应经 L2 自动挂回已唤醒的未收束事')
    assert.equal(l2Sync.match.workId, shelvedWork.id)

    // L3 语义匹配：无硬血缘、无重叠文件，经注入模型精确挂回 shelvedWork
    const SESS_L3 = 'session-97531246-aaaa-4aaa-8bbb-000000000010'
    env.addSession(
      SESS_L3,
      makeEvents([
        {
          turn: 0,
          prompt: '梳理一下报表缓存失效与热点 Key 预热的压测观察指标',
          response: '已记录命中率与 P99 耗时基线，准备对比观察',
          start: now - 20_000,
          end: now - 10_000,
        },
      ]),
      { header: { id: SESS_L3, cwd: WS_PATH } },
    )
    await syncSessionIndexFor(env.ctx, SESS_L3)
    const l3Sync = await incrementalSyncSession(env.ctx, SESS_L3, {
      now,
      useModel: true,
      deps: {
        askModel: async () => JSON.stringify({
          action: 'attach',
          workId: shelvedWork.id,
          reason: '继续观察同一报表缓存失效压测',
        }),
      },
    })
    assert.equal(l3Sync.ok, true)
    assert.equal(l3Sync.match.action, 'attach')
    assert.equal(l3Sync.match.level, 'L3', '无硬血缘无文件重叠但同目标的段应经 L3 语义挂载')
    assert.equal(l3Sync.match.workId, shelvedWork.id)

    // 验证 inflectionNotice=true 时 POST /works 返回 latestInflection；设为 false 时立即屏蔽
    const viewWithInf = await env.request('POST', 'works', { workspaceId: WS_ID })
    assert.ok(viewWithInf.body.value.latestInflection, 'inflectionNotice=true 时应返回 latestInflection')

    const cfgInfOff = await env.request('POST', 'config', { inflectionNotice: false })
    assert.equal(cfgInfOff.status, 200)
    assert.equal(cfgInfOff.body.value.inflectionNotice, false)

    const viewNoInf = await env.request('POST', 'works', { workspaceId: WS_ID })
    assert.equal(viewNoInf.body.value.latestInflection, null, 'inflectionNotice=false 时应隐藏 latestInflection')

    // ── C. POST /work-promote（话题段转事）与 POST /work-dismiss（退回话题且重扫不复生） ──
    const promoteRes = await env.request('POST', 'work-promote', {
      workspaceId: WS_ID,
      segment: {
        id: 'seg:chat-topic:0-1',
        sessionId: SESS_LONG,
        title: '苏州出差报销规范整理',
        summary: '从闲聊段一键转为正式待办事项',
        files: [],
        lastActivityAt: now,
      },
    })
    assert.equal(promoteRes.status, 200)
    assert.equal(promoteRes.body.ok, true)
    const promoted = promoteRes.body.value.work
    assert.equal(promoted.state, 'active')
    assert.equal(promoted.stateSource, 'confirmed', '话题段升格成的事应为已确认态')
    assert.equal(
      promoteRes.body.value.cards.unresolved.some(c => c.id === promoted.id),
      true,
      '升格后的事应出现在未收束清单中',
    )

    // 将误立的 extraWork 退回话题，再强制重扫，验证不再复生
    const currentView = await env.request('POST', 'works', { workspaceId: WS_ID })
    const dismissTarget = currentView.body.value.works.find(w => w.sessionIds.includes(SESS_EXTRA))
    assert.ok(dismissTarget, '退回前应存在 extraWork')

    const dismissRes = await env.request('POST', 'work-dismiss', {
      workspaceId: WS_ID,
      workId: dismissTarget.id,
    })
    assert.equal(dismissRes.status, 200)
    assert.equal(dismissRes.body.ok, true)
    assert.equal(dismissRes.body.value.cards.unresolved.some(c => c.id === dismissTarget.id), false)

    // 强制重扫：被退回的段在 dismissedSegments 中，重扫后绝不能复生
    const rescanAfterDismiss = await env.request('POST', 'works-scan', {
      workspaceId: WS_ID,
      force: true,
      useModel: false,
    })
    assert.equal(rescanAfterDismiss.status, 200)
    assert.equal(
      rescanAfterDismiss.body.value.works.some(w => w.sessionIds.includes(SESS_EXTRA)),
      false,
      '已退回话题的误立事在 force 重扫后绝不可复生',
    )
    assert.equal(
      rescanAfterDismiss.body.value.works.some(w => w.id === promoted.id),
      true,
      '人工 promote 升格的事在重扫后必须保留',
    )
  })
})

console.log(`\n${passed} passed, ${failures.length} failures`)
if (failures.length > 0) {
  for (const failure of failures) console.error(`\n${failure.name}\n${failure.error.stack}`)
  process.exit(1)
}
