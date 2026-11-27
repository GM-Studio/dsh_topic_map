/**
 * ADR-0005 三元触发来源模型端到端测试：
 * 折叠异步续跑轮，彻底排除子代理与自动化会话。
 *
 * 严格遵循端到端真实验证纪律：
 * - 真实临时 DSH_HOME + 模拟宿主 ctx，通过 `apply(ctx)` 挂载完整 Host HTTP 路由与事件流；
 * - 零 mock 内部业务函数（`buildTurnRows`、`syncSessionIndexFor`、`attachWorkspaceChanges`、
 *   `filterHumanWorkspaceSessionIds`、`readSessionOutline`、`searchWorkspaceIndex`、
 *   `findAcrossSessions`、`readWorkspaceStats`、`buildSessionIndexes`、`warmupWorkspace`、
 *   `readWorkspaceWorksView`、`incrementalSyncSession`、`isAutomatedSession` 全部走真实实现）。
 *
 * Run: node tests/trigger-sources.mjs
 */

import { strict as assert } from 'node:assert'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  apply,
  filterHumanWorkspaceSessionIds,
  flushIndexSyncs,
  isSubagentOrAutomatedHeader,
  syncSessionIndexFor,
} from '../lib/index.js'

import {
  INDEX_SCHEMA,
  buildTurnRows,
  defaultSessionsDir,
  indexFilePath,
  readIndexFile,
} from '../lib/turn-index.js'

import { isAutomatedSession } from '../lib/segment.js'

import {
  flushIncrementalSyncs,
  incrementalSyncSession,
  readWorkStore,
} from '../lib/work-store.js'

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const WS_PATH = 'E:\trigger-sources-workspace'

let passed = 0
const failures = []

async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`  FAIL ${name}\n       ${error?.stack || error?.message || error}`)
  }
}

async function withTempHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'trigger-sources-'))
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

async function fileExists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/**
 * 构造贴近真实 DSH 宿主事件流的会话事件数组。
 *
 * 支持显式指定 `sourceKind`（默认 'user'）、`source` 对象、`omitUserMessage`、
 * `usage`、`steps`、`toolCalls`、`hasChanges`、`endReason` 等字段。
 */
function makeEvents(specs, baseTime = Date.now() - 2 * HOUR) {
  let seq = 0
  const events = []
  const push = (type, data, time) => events.push({ type, seq: seq++, time, data })

  specs.forEach((spec, index) => {
    const start = spec.start ?? (baseTime + index * 2 * MINUTE)
    const end = spec.end ?? (start + 15_000)
    const turn = spec.turn ?? index
    push('turn/start', { turn }, start)

    if (spec.omitUserMessage !== true) {
      const source = spec.source !== undefined
        ? spec.source
        : { kind: spec.sourceKind ?? 'user' }
      const promptText = spec.prompt !== undefined ? spec.prompt : (source?.kind === 'user' || source?.kind === 'retry' ? `提问 ${turn}` : '')
      push('user/message', {
        content: promptText === '' ? [] : [{ type: 'text', text: promptText }],
        source,
      }, start + 100)
    }

    const steps = Number.isFinite(spec.steps) ? spec.steps : 1
    for (let s = 0; s < steps; s += 1) {
      push('step/start', { turn, step: s }, start + 200 + s * 50)
    }

    if (Array.isArray(spec.toolCalls)) {
      spec.toolCalls.forEach((tc, tcIdx) => {
        push('tool/call', {
          name: tc.name,
          arguments: tc.arguments ?? {},
        }, start + 400 + tcIdx * 50)
      })
    }

    if (spec.omitAssistantMessage !== true) {
      const u = spec.usage ?? {}
      push('assistant/message', {
        usage: {
          inputTokens: u.inputTokens ?? u.input ?? 100,
          outputTokens: u.outputTokens ?? u.output ?? 50,
          cacheReadTokens: u.cacheReadTokens ?? u.cacheRead ?? 0,
          cacheWriteTokens: u.cacheWriteTokens ?? u.cacheWrite ?? 0,
          reasoningTokens: u.reasoningTokens ?? u.reasoning ?? 0,
        },
        interrupted: spec.interrupted === true,
        message: {
          role: 'assistant',
          content: spec.response === '' ? [] : [{ type: 'text', text: spec.response ?? `回复 ${turn}` }],
          source: { kind: 'model', provider: 'fake', model: spec.model ?? 'fake-adr0005' },
        },
      }, start + 1000)
    }

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
 * 创建真实 Host 插件运行环境（通过 apply(ctx) 注册完整 HTTP 路由与事件监听）。
 */
function createHostEnv(options = {}) {
  const workspaceId = options.workspaceId ?? `ws-adr0005-${Math.random().toString(36).slice(2, 8)}`
  const events = { ...(options.events ?? {}) }
  const headers = { ...(options.headers ?? {}) }
  const titles = { ...(options.titles ?? {}) }
  const revisions = { ...(options.revisions ?? {}) }
  const changesBySession = { ...(options.changes ?? {}) }
  const sessionIds = options.sessionIds ? [...options.sessionIds] : Object.keys(events)
  const workspaces = options.workspaces ?? [{
    id: workspaceId,
    path: WS_PATH,
    title: 'ADR-0005 质量验证工作区',
    sessionIds,
  }]

  const routes = []
  const listeners = new Map()
  const readSessionCalls = []

  const sessionQuery = {
    async readSession(id) {
      readSessionCalls.push(id)
      if (!(id in events)) return null
      return { header: { id, ...(headers[id] ?? {}) }, events: events[id] }
    },
    async readTitleSnapshots(ids) {
      return ids.map(sessionId => ({
        sessionId,
        status: 'fulfilled',
        value: { title: { title: titles[sessionId] ?? `会话 ${sessionId.slice(0, 12)}` } },
      }))
    },
  }

  if (options.omitListSessions !== true) {
    sessionQuery.listSessions = async () => {
      if (options.listSessionsError) throw options.listSessionsError
      return Object.keys(events).map(id => ({
        header: { id, ...(headers[id] ?? {}) },
      }))
    }
  }

  const ctx = {
    _routes: routes,
    _listeners: listeners,
    get(name) {
      if (name === 'workspaceRegistry') return { list: () => workspaces }
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
    sessionQuery,
    sessionPersistence: {
      async stat(id) {
        return { revision: revisions[id] ?? 'rev-1' }
      },
    },
    workspaceChanges: {
      async summary(id, seq) {
        const map = changesBySession[id]
        if (!map) return undefined
        if (seq in map) return map[seq]
        if (map.byTurn && Array.isArray(events[id])) {
          const ev = events[id].find(e => e.seq === seq && e.type === 'workspace/changes')
          if (ev && ev.data?.turn in map.byTurn) return map.byTurn[ev.data.turn]
        }
        return map.default
      },
    },
  }

  apply(ctx)
  assert.equal(routes.length, 1, 'apply(ctx) 必须注册 /api/topic-map 路由')
  const handler = routes[0].handler

  async function request(method, action, body) {
    const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
    const req = Readable.from(payload)
    req.url = `/api/topic-map/${action}`
    req.method = method
    let status = 0
    let text = ''
    const res = {
      writeHead(code) { status = code },
      end(value) { text = value },
    }
    await handler(req, res)
    return { status, body: text === '' ? null : JSON.parse(text) }
  }

  return {
    workspaceId,
    ctx,
    events,
    headers,
    titles,
    revisions,
    changesBySession,
    workspaces,
    readSessionCalls,
    request,
  }
}

console.log('\ntrigger-sources (ADR-0005 end-to-end verification)')

// ═══════════════════════════════════════════════════════════════════════
// 1. 父会话并行子代理完整交付折叠
// ═══════════════════════════════════════════════════════════════════════
await test('1. 父会话并行子代理完整交付折叠：4 轮折叠为 1 条逻辑轮次，过滤纯心跳、归并变更与硬事实，outline/search/works 全链路干净', async () => {
  await withTempHome(async () => {
    const now = Date.now()
    const t0 = now - 2 * HOUR
    const SESS_PARENT = 'session-adr5-1001-4000-8000-000000000001'

    const env = createHostEnv({
      events: {
        [SESS_PARENT]: makeEvents([
          {
            turn: 0,
            sourceKind: 'user',
            prompt: '开启 3 个并行子代理重构 auth.js',
            response: '已派发 3 个子代理',
            toolCalls: [
              { name: 'subagent', arguments: { description: '重构令牌模块', prompt: '请重构 lib/auth.js 令牌签发逻辑' } },
              { name: 'subagent', arguments: { description: '重构鉴权中间件', prompt: '请重构 lib/auth.js 鉴权逻辑' } },
              { name: 'subagent', arguments: { description: '补齐认证测试', prompt: '请完善 tests/auth.mjs 回归测试' } },
            ],
            usage: { input: 200, output: 80, cacheRead: 10, cacheWrite: 0, reasoning: 20 },
            steps: 1,
            start: t0,
            end: t0 + 10_000,
          },
          {
            turn: 1,
            sourceKind: 'subagent-settled',
            prompt: 'subagent 1 settled payload',
            response: '进度同步：1/3 完成，其余仍在运行中',
            usage: { input: 120, output: 30, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
            steps: 1,
            start: t0 + 1 * MINUTE,
            end: t0 + 1 * MINUTE + 5_000,
          },
          {
            turn: 2,
            sourceKind: 'agent-message',
            prompt: 'agent-message payload',
            response: '已整合子代理 2 的鉴权改动并同步调整 lib/auth.js 接口。',
            toolCalls: [
              { name: 'edit', arguments: { file_path: 'lib/auth.js' } },
            ],
            hasChanges: true,
            usage: { input: 300, output: 110, cacheRead: 20, cacheWrite: 5, reasoning: 15 },
            steps: 2,
            start: t0 + 2 * MINUTE,
            end: t0 + 2 * MINUTE + 20_000,
          },
          {
            turn: 3,
            sourceKind: 'subagent-settled',
            prompt: 'subagent 3 settled payload',
            response: '全部重构并验证通过',
            toolCalls: [
              { name: 'edit', arguments: { file_path: 'tests/auth.mjs' } },
              { name: 'pwsh', arguments: { command: 'node tests/auth.mjs' } },
            ],
            hasChanges: true,
            usage: { input: 400, output: 150, cacheRead: 30, cacheWrite: 0, reasoning: 25 },
            steps: 2,
            start: t0 + 3 * MINUTE,
            end: t0 + 3 * MINUTE + 25_000,
          },
        ], t0),
      },
      headers: { [SESS_PARENT]: { id: SESS_PARENT, cwd: WS_PATH } },
      titles: { [SESS_PARENT]: '并行子代理重构 auth.js' },
      changes: {
        [SESS_PARENT]: {
          byTurn: {
            2: { files: [{ path: 'lib/auth.js', added: 42, deleted: 18 }] },
            3: { files: [{ path: 'tests/auth.mjs', added: 65, deleted: 7 }] },
          },
        },
      },
    })

    // 1) syncSessionIndexFor 落盘 schema 6 索引
    const syncRes = await syncSessionIndexFor(env.ctx, SESS_PARENT)
    assert.equal(syncRes.skipped, false)
    assert.equal(syncRes.meta.schema, INDEX_SCHEMA)
    assert.equal(INDEX_SCHEMA, 6)
    assert.equal(syncRes.meta.turnCount, 1, '4 个原始轮次必须折叠为 1 条逻辑轮次')

    const onDisk = await readIndexFile(defaultSessionsDir(), SESS_PARENT)
    assert.equal(onDisk.ok, true)
    assert.equal(onDisk.meta.schema, 6)
    assert.equal(onDisk.turns.length, 1)

    const row = onDisk.turns[0]
    assert.equal(row.turn, 0)
    assert.deepEqual(row.foldedTurns, [1, 2, 3])
    assert.equal(row.trigger, 'human')
    assert.equal(row.prompt, '开启 3 个并行子代理重构 auth.js')
    assert.equal(row.end, t0 + 3 * MINUTE + 25_000, '结束时间应推进至最后一个收口轮')
    assert.equal(row.ms, (t0 + 3 * MINUTE + 25_000) - t0)
    assert.equal(row.steps, 6, '总步数应累加 1+1+2+2=6')
    assert.equal(row.usage.input, 1020)
    assert.equal(row.usage.output, 370)
    assert.equal(row.endReason, 'completed')

    // 2) response 过滤纯进度心跳，保留最终收口结论
    assert.equal(
      row.response.includes('进度同步：1/3 完成，其余仍在运行中'),
      false,
      '中间纯进度心跳必须被过滤',
    )
    assert.ok(row.response.includes('全部重构并验证通过'), '必须保留最终收口结论')

    // 3) 工具/文件/命令与 changes 跨回调轮归并
    assert.ok(row.tools.includes('edit'))
    assert.ok(row.tools.includes('pwsh'))
    assert.ok(row.files.includes('lib/auth.js'))
    assert.ok(row.files.includes('tests/auth.mjs'))
    assert.ok(row.commands.includes('node tests/auth.mjs'))

    assert.ok(row.changes && row.changes.lost === false, '必须合并得到有效 changes 快照')
    assert.equal(row.changes.total, 2)
    assert.equal(row.changes.added, 42 + 65)
    assert.equal(row.changes.deleted, 18 + 7)
    const changePaths = row.changes.files.map(f => f.path).sort()
    assert.deepEqual(changePaths, ['lib/auth.js', 'tests/auth.mjs'])

    // 4) POST /session-outline 历史轨只看到 1 个轮次（不刷屏 4 个刻度）
    const outlineRes = await env.request('POST', 'session-outline', { sessionId: SESS_PARENT })
    assert.equal(outlineRes.status, 200)
    assert.equal(outlineRes.body.ok, true)
    assert.equal(outlineRes.body.value.turns.length, 1, '历史轨只应有 1 个轮次刻度')
    assert.equal(outlineRes.body.value.turns[0].turn, 0)
    assert.equal(outlineRes.body.value.segments.length, 1)

    // 5) POST /search 搜「全部重构并验证通过」精确命中 turn=0，无空提问孤儿轮
    const searchRes = await env.request('POST', 'search', {
      workspaceId: env.workspaceId,
      keywords: '全部重构并验证通过',
    })
    assert.equal(searchRes.status, 200)
    assert.equal(searchRes.body.ok, true)
    assert.equal(searchRes.body.value.total, 1)
    assert.equal(searchRes.body.value.hits.length, 1)
    assert.equal(searchRes.body.value.hits[0].sessionId, SESS_PARENT)
    assert.equal(searchRes.body.value.hits[0].turn, 0)
    assert.ok(
      searchRes.body.value.hits[0].promptHead && searchRes.body.value.hits[0].promptHead.length > 0,
      '命中轮次必须有对应人类提问，不得出现空提问孤儿轮',
    )

    // 6) POST /works 切段成干净 1 件「事」，包含完整硬事实，不把 4 轮砍碎
    const worksRes = await env.request('POST', 'works', { workspaceId: env.workspaceId })
    assert.equal(worksRes.status, 200)
    assert.equal(worksRes.body.ok, true)
    const { works } = worksRes.body.value
    assert.equal(works.length, 1, `应产出干净 1 件事，实际 ${works.length}`)
    assert.equal(works[0].segmentIds.length, 1, '不得把折叠后的 4 轮砍碎成多段')
    assert.ok(works[0].files.includes('lib/auth.js'), '事的硬事实必须包含 lib/auth.js')
    assert.ok(works[0].files.includes('tests/auth.mjs'), '事的硬事实必须包含 tests/auth.mjs')

    const stored = await readWorkStore(env.workspaceId)
    assert.equal(stored.ok, true)
    const segs = Object.values(stored.store.segments)
    assert.equal(segs.length, 1)
    assert.equal(segs[0].startTurn, 0)
    assert.equal(segs[0].endTurn, 0)
    assert.ok(segs[0].commands.includes('node tests/auth.mjs'))
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 2. Goal 自动续跑与后台任务唤醒（goal / tool-jobs）折叠 + 收口报错透传 blocked
// ═══════════════════════════════════════════════════════════════════════
await test('2. Goal 自动续跑与后台任务唤醒（goal / tool-jobs）折叠进前一个 human 轮，收口轮报错使主轮 endReason=error 并触发 blocked', async () => {
  await withTempHome(async () => {
    const now = Date.now()
    const t0 = now - 90 * MINUTE
    const SESS_GOAL = 'session-adr5-2001-4000-8000-000000000001'

    const env = createHostEnv({
      events: {
        [SESS_GOAL]: makeEvents([
          {
            turn: 0,
            sourceKind: 'user',
            prompt: '后台执行数据库迁移并验证 lib/db-migrate.js 全部用例',
            response: '已启动后台迁移任务并开启 Goal 持续推进。',
            toolCalls: [
              { name: 'pwsh', arguments: { command: 'node scripts/migrate.mjs --background' } },
            ],
            start: t0,
            end: t0 + 10_000,
          },
          {
            turn: 1,
            sourceKind: 'tool-jobs',
            prompt: 'background job completed notification',
            response: '后台迁移脚本已完成第一批表结构更新，继续校验索引一致性。',
            toolCalls: [
              { name: 'edit', arguments: { file_path: 'lib/db-migrate.js' } },
            ],
            hasChanges: true,
            start: t0 + 1 * MINUTE,
            end: t0 + 1 * MINUTE + 15_000,
          },
          {
            turn: 2,
            sourceKind: 'goal',
            prompt: 'goal continuation prompt',
            response: '执行回归校验失败：AssertionError: foreign key constraint mismatch on orders_v2',
            toolCalls: [
              { name: 'pwsh', arguments: { command: 'node tests/db-migrate.mjs' } },
            ],
            endReason: 'error',
            start: t0 + 2 * MINUTE,
            end: t0 + 2 * MINUTE + 20_000,
          },
        ], t0),
      },
      headers: { [SESS_GOAL]: { id: SESS_GOAL, cwd: WS_PATH } },
      titles: { [SESS_GOAL]: '数据库迁移自动续跑' },
      changes: {
        [SESS_GOAL]: {
          byTurn: {
            1: { files: [{ path: 'lib/db-migrate.js', added: 31, deleted: 6 }] },
          },
        },
      },
    })

    const syncRes = await syncSessionIndexFor(env.ctx, SESS_GOAL)
    assert.equal(syncRes.turns.length, 1, 'goal 与 tool-jobs 均应折叠进前一个 human 轮')
    const row = syncRes.turns[0]
    assert.equal(row.turn, 0)
    assert.equal(row.trigger, 'human')
    assert.deepEqual(row.foldedTurns, [1, 2])
    assert.equal(row.endReason, 'error', '收口轮出错时主轮 endReason 必须反映为 error')
    assert.ok(row.files.includes('lib/db-migrate.js'))
    assert.ok(row.commands.includes('node tests/db-migrate.mjs'))
    assert.equal(row.changes.total, 1)
    assert.equal(row.changes.added, 31)
    assert.equal(row.changes.deleted, 6)

    // 验证历史轨也标记异常并合并为 1 轮
    const outlineRes = await env.request('POST', 'session-outline', { sessionId: SESS_GOAL })
    assert.equal(outlineRes.status, 200)
    assert.equal(outlineRes.body.value.turns.length, 1)
    assert.equal(outlineRes.body.value.segments[0].hasError, true)

    // 验证 POST /works 自动识别为 blocked 状态
    const worksRes = await env.request('POST', 'works', { workspaceId: env.workspaceId })
    assert.equal(worksRes.status, 200)
    assert.equal(worksRes.body.value.works.length, 1)
    assert.equal(worksRes.body.value.works[0].state, 'blocked', '收口轮 error 折叠到主轮后应触发 blocked 状态')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 3. 子代理独立会话与定时会话全链路 7 大入口彻底排除（Q2=B）
// ═══════════════════════════════════════════════════════════════════════
await test('3. 子代理（origin=subagent / delegationDepth=2）与定时会话（origin=scheduled）在 7 大入口全部彻底排除', async () => {
  await withTempHome(async () => {
    const now = Date.now()
    const t0 = now - 3 * HOUR

    const SESS_HUMAN = 'session-adr5-3001-human-000000000001'
    const SESS_SUB_ORIGIN = 'session-adr5-3002-sub1-000000000002'
    const SESS_SUB_DEPTH2 = 'session-adr5-3003-sub2-000000000003'
    const SESS_SCHEDULED = 'session-adr5-3004-cron-000000000004'

    const TOKEN_SUB_ORIGIN = 'SUBAGENT_ORIGIN_SECRET_XYZ901'
    const TOKEN_SUB_DEPTH2 = 'DELEGATION_DEPTH2_SECRET_XYZ902'
    const TOKEN_SCHEDULED = 'SCHEDULED_PATROL_SECRET_XYZ903'

    const env = createHostEnv({
      events: {
        [SESS_HUMAN]: makeEvents([
          {
            turn: 0,
            sourceKind: 'user',
            prompt: '优化 lib/billing.js 结算流水幂等键生成逻辑',
            response: '已完成 lib/billing.js 幂等键改造并通过单测 HUMAN_MARKER_OK',
            toolCalls: [
              { name: 'edit', arguments: { file_path: 'lib/billing.js' } },
              { name: 'pwsh', arguments: { command: 'node tests/billing.mjs' } },
            ],
            hasChanges: true,
            usage: { input: 500, output: 200, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
            start: t0,
            end: t0 + 20_000,
          },
        ], t0),
        [SESS_SUB_ORIGIN]: makeEvents([
          {
            turn: 0,
            sourceKind: 'user',
            prompt: `子代理独立会话任务 ${TOKEN_SUB_ORIGIN}`,
            response: `子代理排查结论 ${TOKEN_SUB_ORIGIN}`,
            toolCalls: [{ name: 'edit', arguments: { file_path: 'lib/sub-origin.js' } }],
            hasChanges: true,
            usage: { input: 9000, output: 3000, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
            start: t0 + 10 * MINUTE,
            end: t0 + 10 * MINUTE + 15_000,
          },
        ], t0),
        [SESS_SUB_DEPTH2]: makeEvents([
          {
            turn: 0,
            sourceKind: 'user',
            prompt: `二级嵌套子代理任务 ${TOKEN_SUB_DEPTH2}`,
            response: `二级嵌套子代理输出 ${TOKEN_SUB_DEPTH2}`,
            toolCalls: [{ name: 'edit', arguments: { file_path: 'lib/sub-depth2.js' } }],
            hasChanges: true,
            usage: { input: 8000, output: 2500, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
            start: t0 + 20 * MINUTE,
            end: t0 + 20 * MINUTE + 15_000,
          },
        ], t0),
        [SESS_SCHEDULED]: makeEvents([
          {
            turn: 0,
            sourceKind: 'schedule',
            prompt: '',
            response: `每日定时巡检报告 ${TOKEN_SCHEDULED}`,
            toolCalls: [{ name: 'pwsh', arguments: { command: 'node scripts/patrol.mjs' } }],
            usage: { input: 7000, output: 2000, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
            start: t0 + 30 * MINUTE,
            end: t0 + 30 * MINUTE + 15_000,
          },
        ], t0),
      },
      headers: {
        [SESS_HUMAN]: { id: SESS_HUMAN, cwd: WS_PATH },
        [SESS_SUB_ORIGIN]: { id: SESS_SUB_ORIGIN, cwd: WS_PATH, origin: 'subagent', delegationDepth: 1 },
        [SESS_SUB_DEPTH2]: { id: SESS_SUB_DEPTH2, cwd: WS_PATH, delegationDepth: 2 },
        [SESS_SCHEDULED]: { id: SESS_SCHEDULED, cwd: WS_PATH, origin: 'scheduled' },
      },
      titles: {
        [SESS_HUMAN]: '结算幂等键优化',
        [SESS_SUB_ORIGIN]: `子代理 ${TOKEN_SUB_ORIGIN}`,
        [SESS_SUB_DEPTH2]: `子代理二级 ${TOKEN_SUB_DEPTH2}`,
        [SESS_SCHEDULED]: `定时巡检 ${TOKEN_SCHEDULED}`,
      },
      changes: {
        [SESS_HUMAN]: { default: { files: [{ path: 'lib/billing.js', added: 15, deleted: 3 }] } },
        [SESS_SUB_ORIGIN]: { default: { files: [{ path: 'lib/sub-origin.js', added: 5, deleted: 0 }] } },
        [SESS_SUB_DEPTH2]: { default: { files: [{ path: 'lib/sub-depth2.js', added: 5, deleted: 0 }] } },
      },
    })

    // 入口 6：POST /workspace-warmup（先于 index-build 跑，测试后台预热只排队人工会话）
    const warmupRes = await env.request('POST', 'workspace-warmup', { workspaceId: env.workspaceId })
    assert.equal(warmupRes.status, 200)
    assert.equal(warmupRes.body.ok, true)
    assert.equal(warmupRes.body.value.throttled, false)
    assert.equal(warmupRes.body.value.queued, 1, 'workspace-warmup 只能给 1 个人类会话排队，不得给子代理/定时会话排队')
    await flushIndexSyncs()

    const indexDir = defaultSessionsDir()
    assert.equal(await fileExists(indexFilePath(indexDir, SESS_HUMAN)), true, '人类会话应已通过预热建索引')
    assert.equal(await fileExists(indexFilePath(indexDir, SESS_SUB_ORIGIN)), false, 'origin=subagent 不得建索引')
    assert.equal(await fileExists(indexFilePath(indexDir, SESS_SUB_DEPTH2)), false, 'delegationDepth=2 不得建索引')
    assert.equal(await fileExists(indexFilePath(indexDir, SESS_SCHEDULED)), false, 'origin=scheduled 不得建索引')

    // 入口 5：POST /index-build（不给子代理/定时会话落索引文件）
    const buildRes = await env.request('POST', 'index-build', { workspaceId: env.workspaceId })
    assert.equal(buildRes.status, 200)
    assert.equal(buildRes.body.ok, true)
    assert.deepEqual(
      buildRes.body.value.sessions.map(s => s.sessionId),
      [SESS_HUMAN],
      'index-build 目标集合必须仅包含人类会话',
    )
    assert.equal(await fileExists(indexFilePath(indexDir, SESS_SUB_ORIGIN)), false)
    assert.equal(await fileExists(indexFilePath(indexDir, SESS_SUB_DEPTH2)), false)
    assert.equal(await fileExists(indexFilePath(indexDir, SESS_SCHEDULED)), false)

    // 入口 1：POST /sessions（只返回 1 个人类会话，其余 3 个计入 hidden）
    const sessionsRes = await env.request('POST', 'sessions', { workspaceId: env.workspaceId })
    assert.equal(sessionsRes.status, 200)
    assert.equal(sessionsRes.body.ok, true)
    assert.equal(sessionsRes.body.value.sessions.length, 1)
    assert.equal(sessionsRes.body.value.sessions[0].sessionId, SESS_HUMAN)
    assert.equal(sessionsRes.body.value.total, 4)
    assert.equal(sessionsRes.body.value.hidden, 3, '3 个非人工会话必须全部计入 hidden')

    // 入口 2：POST /search（搜子代理与定时会话独有关键词全部返回 0 条）
    for (const secret of [TOKEN_SUB_ORIGIN, TOKEN_SUB_DEPTH2, TOKEN_SCHEDULED]) {
      const sRes = await env.request('POST', 'search', {
        workspaceId: env.workspaceId,
        keywords: secret,
      })
      assert.equal(sRes.status, 200)
      assert.equal(sRes.body.ok, true)
      assert.equal(sRes.body.value.total, 0, `POST /search 搜 ${secret} 必须返回 0 条`)
      assert.equal(sRes.body.value.hits.length, 0)
      assert.equal(sRes.body.value.scanned, 1, 'POST /search 仅应扫描 1 个人类会话')
    }
    const humanSearch = await env.request('POST', 'search', {
      workspaceId: env.workspaceId,
      keywords: 'HUMAN_MARKER_OK',
    })
    assert.equal(humanSearch.body.value.total, 1)
    assert.equal(humanSearch.body.value.hits[0].sessionId, SESS_HUMAN)

    // 入口 3：POST /find（搜子代理与定时会话独有关键词全部返回 0 条）
    for (const secret of [TOKEN_SUB_ORIGIN, TOKEN_SUB_DEPTH2, TOKEN_SCHEDULED]) {
      const fRes = await env.request('POST', 'find', {
        workspaceId: env.workspaceId,
        query: secret,
      })
      assert.equal(fRes.status, 200)
      assert.equal(fRes.body.ok, true)
      assert.equal(fRes.body.value.hits.length, 0, `POST /find 搜 ${secret} 必须返回 0 条`)
    }
    const humanFind = await env.request('POST', 'find', {
      workspaceId: env.workspaceId,
      query: 'HUMAN_MARKER_OK',
    })
    assert.equal(humanFind.body.value.hits.length, 1)
    assert.equal(humanFind.body.value.hits[0].sessionId, SESS_HUMAN)

    // 入口 4：POST /stats（会话数=1，轮次=1，用量不含 3 个非人工会话）
    const statsRes = await env.request('POST', 'stats', { workspaceId: env.workspaceId })
    assert.equal(statsRes.status, 200)
    assert.equal(statsRes.body.ok, true)
    assert.equal(statsRes.body.value.sessions, 1)
    assert.equal(statsRes.body.value.turns, 1)
    assert.equal(statsRes.body.value.usage.input, 500)
    assert.equal(statsRes.body.value.usage.output, 200)
    assert.deepEqual(statsRes.body.value.topSessions.map(s => s.sessionId), [SESS_HUMAN])

    // 入口 7a：POST /works（只对人类会话立事建段，子代理与定时会话彻底不入库）
    const worksRes = await env.request('POST', 'works', { workspaceId: env.workspaceId })
    assert.equal(worksRes.status, 200)
    assert.equal(worksRes.body.ok, true)
    assert.equal(worksRes.body.value.works.length, 1)
    assert.deepEqual(worksRes.body.value.works[0].sessionIds, [SESS_HUMAN])

    const stored = await readWorkStore(env.workspaceId)
    const segSessionIds = Object.values(stored.store.segments).map(s => s.sessionId)
    assert.deepEqual(segSessionIds, [SESS_HUMAN])

    // 入口 7b：incrementalSyncSession 对 3 个非人工会话均直接跳过返回 { ok: true, skipped: true, reason: 'automated' }
    for (const autoSid of [SESS_SUB_ORIGIN, SESS_SUB_DEPTH2, SESS_SCHEDULED]) {
      const incRes = await incrementalSyncSession(env.ctx, autoSid, { workspaceId: env.workspaceId, useModel: false })
      assert.deepEqual(
        incRes,
        { ok: true, skipped: true, reason: 'automated' },
        `incrementalSyncSession(${autoSid}) 必须跳过并标记 reason=automated`,
      )
    }

    // 再次确认磁盘上仍不存在 3 个非人工会话的索引文件
    assert.equal(await fileExists(indexFilePath(indexDir, SESS_SUB_ORIGIN)), false)
    assert.equal(await fileExists(indexFilePath(indexDir, SESS_SUB_DEPTH2)), false)
    assert.equal(await fileExists(indexFilePath(indexDir, SESS_SCHEDULED)), false)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 4. 父发给子的原始派工指令不倒灌正文
// ═══════════════════════════════════════════════════════════════════════
await test('4. 父发给子的原始派工指令不倒灌正文：tool/call（subagent / run_code）里的超长派工 prompt 与暗号词绝不污染 prompt/response/search', async () => {
  await withTempHome(async () => {
    const now = Date.now()
    const t0 = now - 60 * MINUTE
    const SESS_DISPATCH = 'session-adr5-4001-4000-8000-000000000001'
    const SECRET_DIRECT = 'INTERNAL_SUBAGENT_DISPATCH_CIPHER_ALPHA77'
    const SECRET_RUNCODE = 'INTERNAL_RUNCODE_DISPATCH_CIPHER_BETA88'

    const longDirectPrompt = `你是代码审计专家，请仔细阅读全部文件并输出详细报告。${'重复派工上下文段落。'.repeat(60)}暗号：${SECRET_DIRECT}`
    const longRunCodeScript = `
      await tools.subagent({
        description: "深度安全审计",
        prompt: "请按照内部清单逐行审查 auth 模块。${'内部审计细则。'.repeat(50)}暗号：${SECRET_RUNCODE}",
      });
    `

    const env = createHostEnv({
      events: {
        [SESS_DISPATCH]: makeEvents([
          {
            turn: 0,
            sourceKind: 'user',
            prompt: '派子代理检查 lib/session.js 是否存在越权风险',
            response: '已委派安全审计子代理并行核查。',
            toolCalls: [
              {
                name: 'subagent',
                arguments: {
                  description: '审计越权风险',
                  prompt: longDirectPrompt,
                },
              },
              {
                name: 'run_code',
                arguments: {
                  description: 'Invoke delegated security review subagent',
                  code: longRunCodeScript,
                },
              },
            ],
            start: t0,
            end: t0 + 12_000,
          },
          {
            turn: 1,
            sourceKind: 'subagent-settled',
            prompt: `subagent returned with raw dispatch echo ${SECRET_DIRECT}`,
            response: '审计完成：lib/session.js 权限校验完整，无越权风险。',
            start: t0 + 2 * MINUTE,
            end: t0 + 2 * MINUTE + 10_000,
          },
        ], t0),
      },
      headers: { [SESS_DISPATCH]: { id: SESS_DISPATCH, cwd: WS_PATH } },
      titles: { [SESS_DISPATCH]: 'session.js 越权审计' },
    })

    const syncRes = await syncSessionIndexFor(env.ctx, SESS_DISPATCH)
    assert.equal(syncRes.turns.length, 1)
    const row = syncRes.turns[0]

    assert.equal(row.prompt.includes(SECRET_DIRECT), false, 'subagent 派工暗号不得倒灌进 prompt')
    assert.equal(row.prompt.includes(SECRET_RUNCODE), false, 'run_code 派工暗号不得倒灌进 prompt')
    assert.equal(row.response.includes(SECRET_DIRECT), false, 'subagent 派工暗号不得倒灌进 response')
    assert.equal(row.response.includes(SECRET_RUNCODE), false, 'run_code 派工暗号不得倒灌进 response')
    assert.equal(
      row.commands.some(cmd => cmd.includes(SECRET_DIRECT) || cmd.includes(SECRET_RUNCODE)),
      false,
      '派工长 prompt 也不应泄漏进 commands 列表',
    )
    assert.ok(row.response.includes('无越权风险'), '面向用户的最终总结应完整保留')

    // 验证 POST /search 搜两个内部派工暗号词均返回 0 条
    for (const cipher of [SECRET_DIRECT, SECRET_RUNCODE]) {
      const res = await env.request('POST', 'search', {
        workspaceId: env.workspaceId,
        keywords: cipher,
      })
      assert.equal(res.status, 200)
      assert.equal(res.body.ok, true)
      assert.equal(res.body.value.total, 0, `POST /search 搜派工暗号 ${cipher} 必须返回 0 条`)
      assert.equal(res.body.value.hits.length, 0)
    }

    // 正向验证：搜面向用户的结论能正常命中 turn=0
    const positiveRes = await env.request('POST', 'search', {
      workspaceId: env.workspaceId,
      keywords: '无越权风险',
    })
    assert.equal(positiveRes.body.value.total, 1)
    assert.equal(positiveRes.body.value.hits[0].turn, 0)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 5. 容错降级边界
// ═══════════════════════════════════════════════════════════════════════
await test('5. 容错降级边界：listSessions 缺失或抛错时安全降级不崩溃；首轮 schedule 标为 automated 且不无头折叠', async () => {
  await withTempHome(async () => {
    const now = Date.now()
    const t0 = now - 45 * MINUTE
    const SESS_A = 'session-adr5-5001-4000-8000-000000000001'
    const SESS_B = 'session-adr5-5002-4000-8000-000000000002'
    const SESS_SCHED_ONLY = 'session-adr5-5003-4000-8000-000000000003'

    // 5a. listSessions 缺失时 filterHumanWorkspaceSessionIds 安全退回原列表
    const envNoList = createHostEnv({
      omitListSessions: true,
      events: {
        [SESS_A]: makeEvents([{ turn: 0, prompt: '修复样式错位', response: '已修复' }], t0),
        [SESS_B]: makeEvents([{ turn: 0, prompt: '补充文档', response: '已补充' }], t0),
      },
      headers: {
        [SESS_A]: { id: SESS_A, cwd: WS_PATH },
        [SESS_B]: { id: SESS_B, cwd: WS_PATH, origin: 'subagent' },
      },
    })
    const idsNoList = await filterHumanWorkspaceSessionIds(envNoList.ctx, [SESS_A, SESS_B])
    assert.deepEqual(idsNoList, [SESS_A, SESS_B], 'listSessions 缺失时应安全退回原 ids')

    const sessionsNoList = await envNoList.request('POST', 'sessions', { workspaceId: envNoList.workspaceId })
    assert.equal(sessionsNoList.status, 200)
    assert.equal(sessionsNoList.body.ok, true)
    assert.equal(sessionsNoList.body.value.sessions.length, 2)

    // 5b. listSessions 抛错时安全降级不崩溃
    const envThrow = createHostEnv({
      listSessionsError: new Error('EIO: simulated sessionQuery failure'),
      events: {
        [SESS_A]: makeEvents([{ turn: 0, prompt: '排查超时', response: '已定位' }], t0),
        [SESS_B]: makeEvents([{ turn: 0, prompt: '核对配置', response: '正常' }], t0),
      },
      headers: {
        [SESS_A]: { id: SESS_A, cwd: WS_PATH },
        [SESS_B]: { id: SESS_B, cwd: WS_PATH, origin: 'subagent' },
      },
    })
    const idsOnThrow = await filterHumanWorkspaceSessionIds(envThrow.ctx, [SESS_A, SESS_B])
    assert.deepEqual(idsOnThrow, [SESS_A, SESS_B], 'listSessions 抛错时应安全退回原 ids 而不抛出')

    const searchOnThrow = await envThrow.request('POST', 'search', {
      workspaceId: envThrow.workspaceId,
      keywords: '排查超时',
    })
    assert.equal(searchOnThrow.status, 200)
    assert.equal(searchOnThrow.body.ok, true)
    assert.equal(searchOnThrow.body.value.total, 1)

    // header 判定函数单测边界确认
    assert.equal(isSubagentOrAutomatedHeader(null), false)
    assert.equal(isSubagentOrAutomatedHeader({ origin: 'user', delegationDepth: 0 }), false)
    assert.equal(isSubagentOrAutomatedHeader({ origin: 'subagent' }), true)
    assert.equal(isSubagentOrAutomatedHeader({ delegationDepth: 1 }), true)
    assert.equal(isSubagentOrAutomatedHeader({ origin: 'scheduled' }), true)

    // 5c. 会话首轮就是 schedule（无前置人类轮、且 header 未标 origin）→ trigger='automated'、不强行无头折叠，且 isAutomatedSession 准确识别
    const schedEvents = makeEvents([
      {
        turn: 0,
        sourceKind: 'schedule',
        prompt: '',
        response: '定时检查完成：服务健康度 100%',
        toolCalls: [{ name: 'pwsh', arguments: { command: 'node scripts/health.mjs' } }],
        start: t0,
        end: t0 + 8_000,
      },
      {
        turn: 1,
        sourceKind: 'schedule',
        prompt: '',
        response: '二次定时巡检完成：无告警',
        start: t0 + 5 * MINUTE,
        end: t0 + 5 * MINUTE + 8_000,
      },
    ], t0)

    const schedRows = buildTurnRows(schedEvents)
    assert.equal(schedRows.length, 2, '纯 schedule 轮次不得强行无头互相折叠')
    assert.equal(schedRows[0].trigger, 'automated')
    assert.equal(schedRows[1].trigger, 'automated')
    assert.equal(schedRows[0].foldedTurns, undefined)
    assert.equal(schedRows[1].foldedTurns, undefined)
    assert.equal(
      isAutomatedSession({ sessionId: SESS_SCHED_ONLY, turns: schedRows, firstPrompt: schedRows[0].prompt }),
      true,
      '全 schedule 轮会话必须被 isAutomatedSession 准确识别',
    )

    // 端到端验证：即使 header 没标 origin='scheduled'，仅凭全 schedule 轮，POST /works 与 incrementalSyncSession 也彻底排除
    const envSchedNoHeader = createHostEnv({
      events: {
        [SESS_SCHED_ONLY]: schedEvents,
      },
      headers: {
        [SESS_SCHED_ONLY]: { id: SESS_SCHED_ONLY, cwd: WS_PATH },
      },
      titles: {
        [SESS_SCHED_ONLY]: '服务健康检查',
      },
    })
    await syncSessionIndexFor(envSchedNoHeader.ctx, SESS_SCHED_ONLY)

    const worksRes = await envSchedNoHeader.request('POST', 'works', { workspaceId: envSchedNoHeader.workspaceId })
    assert.equal(worksRes.status, 200)
    assert.equal(worksRes.body.ok, true)
    assert.equal(worksRes.body.value.works.length, 0, '首轮即全 schedule 轮的会话不得立事')

    const incRes = await incrementalSyncSession(envSchedNoHeader.ctx, SESS_SCHED_ONLY, {
      workspaceId: envSchedNoHeader.workspaceId,
      useModel: false,
    })
    assert.deepEqual(incRes, { ok: true, skipped: true, reason: 'automated' })
  })
})

console.log(`\ntrigger-sources: ${passed} passed, ${failures.length} failed`)
if (failures.length > 0) process.exit(1)
