/**
 * 容错与边界测试套件（Resilience & Edge Suite）。
 *
 * 专门轰炸异常、边界、失败、降级、并发竞争与兜底场景，全走真实模块与临时 DSH_HOME：
 *  1. 磁盘与文件损坏容错（坏 JSON / 顶层数组 / null 原文件零覆盖；索引损坏回退 readSession；readSession 抛错单会话跳过）
 *  2. 模型不可用 / 超时 / 乱输出 / 断网降级（无 LLM / resolveRoute=null / 502 / 超时 / 空串 / 截断 JSON / 幻觉 workId / 越界 clusterId / 非法 state）
 *  3. 极端输入参数与 HTTP 边界校验（10 个 work 端点全矩阵：空 body / 数组 / 字符串 / 缺 workspaceId / 不存在 workspaceId / 不存在 workId / 非法 mode / 自合并 / 拆唯一一段 / 空 segment）
 *  4. 极端规模与超长文本预算边界（32KB 单轮 / 500 字标题与下一步 / 200 文件 / 50 命令 / 20 报错 / 15 决策 / 250 字极紧预算 / Emoji 代理对不拆断）
 *  5. 并发竞争与串行锁压力测试（Promise.all 并发 confirmWork + incrementalSyncSession + dismissInflection 无写花、无 tmp 残留、人工确认零丢失）
 *  6. 空工作区 / 0 轮会话 / 全子代理工作区 / 乱序与负时间戳轮次 / 非连续轮号（#2, #7, #15）
 *  7. Wire 展开极端容错（不存在 workId / 跨工作区 workId / 10 个重复句柄 / 账本文件损坏 / {{ 模板花括号 / interpolate: false）
 *  8. 配置项极端边界（dormantDays: -5/0/9999/'abc'/NaN/null；inflectionNotice: 'yes'/1/'false'/{}）
 *
 * Run: node tests/resilience-edge.mjs
 */

import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  apply,
  flushIndexSyncs,
  mergeConfigPatch,
} from '../lib/index.js'

import {
  isAutomatedSession,
  parseSegmentRefineResult,
  sliceSessionSegments,
  toRailOutlineWithSegments,
} from '../lib/segment.js'

import {
  applyDormancySettlement,
  applyUserConfirm,
  createWork,
  emptyWorkStore,
  projectResumeCards,
  splitSegmentFromWork,
} from '../lib/work-model.js'

import {
  matchSegmentIncremental,
  parseColdStartSemanticResult,
  parseIncrementalMatchResult,
  planColdStartWorks,
} from '../lib/work-merge.js'

import {
  buildNewSessionHandoffDraft,
  extractWorkHandles,
  extractWorkHardFacts,
  renderWorkContextForAgent,
} from '../lib/handoff.js'

import {
  WORK_CONTEXT_NAME,
  confirmWork,
  dismissInflection,
  expandWorkHandlesForAgent,
  flushIncrementalSyncs,
  incrementalSyncSession,
  prepareHandoff,
  readWorkStore,
  readWorkspaceWorksView,
  scanWorkspaceWorks,
  splitWorkspaceWork,
  workStorePath,
  writeWorkStore,
} from '../lib/work-store.js'

import {
  formatWorkCard,
  workBoardModel,
} from '../lib/work-view.js'

import {
  rowsOf,
  segmentGroupsOf,
} from '../lib/rail-view.js'

import {
  applySetting,
  settingsModel,
} from '../lib/settings-view.js'

import {
  indexFilePath,
  defaultSessionsDir,
} from '../lib/turn-index.js'

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

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const BASE_TIME = Date.UTC(2026, 10, 20, 10, 0, 0)

async function withTempHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'resilience-edge-'))
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

function makeEvents(specs, baseTime = BASE_TIME) {
  let seq = 0
  const events = []
  const push = (type, data, time) => events.push({ type, seq: seq++, time, data })
  specs.forEach((spec, index) => {
    const start = spec.start ?? (baseTime + index * MINUTE)
    const end = spec.end ?? (start + 5_000)
    const turn = spec.turn ?? index
    push('turn/start', { turn }, start)
    push('user/message', {
      content: [{ type: 'text', text: spec.prompt ?? `提问 ${turn}` }],
      source: { kind: 'user' },
    }, start + 100)
    if (Array.isArray(spec.toolCalls)) {
      for (const tc of spec.toolCalls) {
        push('tool/call', { name: tc.name, arguments: tc.arguments ?? {} }, start + 500)
      }
    }
    push('assistant/message', {
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: spec.response ?? `回复 ${turn}` }],
        source: { kind: 'model', provider: 'fake', model: 'fake-model' },
      },
    }, start + 1000)
    if (spec.hasChanges === true) {
      push('workspace/changes', { turn }, start + 1500)
    }
    push('turn/end', { turn, reason: { kind: spec.endReason ?? 'completed' } }, end)
  })
  return events
}

function createHostEnv(options = {}) {
  const events = options.events ?? {}
  const headers = options.headers ?? {}
  const titles = options.titles ?? {}
  const revisions = options.revisions ?? {}
  const changesBySession = options.changes ?? {}
  const brokenSessions = new Set(options.brokenSessions ?? [])
  const llm = options.llm
  const wsId = options.wsId ?? 'ws-edge'
  const sessionIds = options.sessionIds ?? Object.keys(events)
  const workspaces = options.workspaces ?? [{
    id: wsId,
    path: 'E:\\edge-workspace',
    title: '边界测试工作区',
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
          effect(fn) { return fn() },
        })
      }
      if (names.includes('systemPrompt')) {
        callback({
          ...ctx,
          on(eventName, fn) { return ctx.on(eventName, fn) },
          effect(fn) { return fn() },
        })
      }
    },
    sessionQuery: {
      async readSession(id) {
        if (brokenSessions.has(id)) throw new Error(`simulated readSession failure for ${id}`)
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
          value: { title: { title: titles[sessionId] ?? `会话 ${sessionId}` } },
        }))
      },
    },
    sessionPersistence: {
      async stat(id) {
        if (brokenSessions.has(id)) throw new Error('simulated stat failure')
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
  const handler = routes[0].handler

  async function requestRaw(method, action, rawPayload) {
    const payload = rawPayload === undefined ? [] : [Buffer.from(rawPayload, 'utf8')]
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

  async function request(method, action, body) {
    return requestRaw(method, action, body === undefined ? undefined : JSON.stringify(body))
  }

  function emit(eventName, payload) {
    for (const fn of listeners.get(eventName) ?? []) fn(payload)
  }

  async function runSystemPromptAssemble(agent, initialAssembly = null) {
    const base = initialAssembly ?? { sections: [], contexts: [], tools: [], variables: {} }
    const fns = listeners.get('system-prompt/assemble') ?? []
    let chain = async () => base
    for (let i = fns.length - 1; i >= 0; i -= 1) {
      const fn = fns[i]
      const next = chain
      chain = () => fn(base, { agent }, next)
    }
    return chain()
  }

  return { ctx, workspaces, request, requestRaw, emit, runSystemPromptAssemble }
}

/** 检测字符串中是否存在孤立的高/低 UTF-16 代理项（说明拆断了 Emoji/增补平面字符）。 */
function hasLoneSurrogate(str) {
  for (let i = 0; i < str.length; i += 1) {
    const code = str.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < str.length ? str.charCodeAt(i + 1) : 0
      if (next < 0xdc00 || next > 0xdfff) return true
      i += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true
    }
  }
  return false
}

// ============================================================================
// 1. 磁盘与文件损坏容错
// ============================================================================
console.log('\n1. 磁盘与文件损坏容错')

await test('1.1 works/<workspaceId>.json 为非法损坏 JSON / 顶层数组 / null 时报明确中文错且原文件零覆盖', async () => {
  const corruptedPayloads = [
    { label: 'broken-json', raw: '{broken json :: not valid', expectMsg: 'JSON 解析失败' },
    { label: 'top-level-array', raw: '[{"id":"w-1"}]', expectMsg: '顶层不是对象' },
    { label: 'top-level-null', raw: 'null', expectMsg: '顶层不是对象' },
  ]

  for (const item of corruptedPayloads) {
    await withTempHome(async () => {
      const wsId = `ws-corrupt-${item.label}`
      const storeFile = workStorePath(wsId)
      await mkdir(dirname(storeFile), { recursive: true })
      await writeFile(storeFile, item.raw, 'utf8')

      // 1) readWorkStore
      const r1 = await readWorkStore(wsId)
      assert.equal(r1.ok, false, `${item.label}: readWorkStore 应返回 ok:false`)
      assert.ok(r1.error.includes(item.expectMsg), `${item.label}: 应含中文错误 "${item.expectMsg}"，实际: ${r1.error}`)

      // 2) POST /works 与 POST /work-confirm
      const host = createHostEnv({ wsId, events: {} })
      const rWorks = await host.request('POST', 'works', { workspaceId: wsId })
      assert.equal(rWorks.body.ok, false, `${item.label}: POST /works 应返回 ok:false`)
      assert.ok(rWorks.body.error.includes(item.expectMsg), `${item.label}: POST /works 错误文案应含 "${item.expectMsg}"`)

      const rConfirm = await host.request('POST', 'work-confirm', {
        workspaceId: wsId,
        workId: 'w-any',
        patch: { state: 'done' },
      })
      assert.equal(rConfirm.body.ok, false, `${item.label}: POST /work-confirm 应返回 ok:false`)
      assert.ok(rConfirm.body.error.includes(item.expectMsg), `${item.label}: POST /work-confirm 错误文案应含 "${item.expectMsg}"`)

      // 3) 校验磁盘上原文件一字节未被修改或清空
      const afterRaw = await readFile(storeFile, 'utf8')
      assert.equal(afterRaw, item.raw, `${item.label}: 原损坏文件绝不能被覆盖或清空`)
    })
  }
})

await test('1.2 索引缺失或损坏时降级读 readSession；readSession 抛错时单会话跳过不拖垮整个工作区盘点', async () => {
  await withTempHome(async () => {
    const wsId = 'ws-idx-fallback'
    const sessCorruptIdx = 'session-aa11bb22-corrupt-idx'
    const sessMissingIdx = 'session-cc33dd44-missing-idx'
    const sessThrowRead = 'session-ee55ff66-throw-read'

    // 写入一个内容完全损坏的索引文件给 sessCorruptIdx
    const sessionsDir = defaultSessionsDir()
    const badIdxPath = indexFilePath(sessionsDir, sessCorruptIdx)
    await mkdir(dirname(badIdxPath), { recursive: true })
    await writeFile(badIdxPath, '{{{ NOT A VALID JSONL INDEX FILE\nBROKEN_LINE', 'utf8')

    const host = createHostEnv({
      wsId,
      brokenSessions: [sessThrowRead],
      sessionIds: [sessCorruptIdx, sessMissingIdx, sessThrowRead],
      events: {
        [sessCorruptIdx]: makeEvents([
          {
            turn: 0,
            prompt: '修复订单服务支付回调校验',
            response: '已修改 src/payment/callback.js',
            toolCalls: [{ name: 'edit', arguments: { file_path: 'src/payment/callback.js' } }],
          },
          {
            turn: 1,
            prompt: '运行单元测试验证 callback.js',
            response: '全部通过',
            toolCalls: [{ name: 'pwsh', arguments: { command: 'node --test src/payment/callback.test.js' } }],
          },
        ], BASE_TIME),
        [sessMissingIdx]: makeEvents([
          {
            turn: 0,
            prompt: '实现用户导出 CSV 功能',
            response: '已新增 src/export/csv.js',
            toolCalls: [{ name: 'write', arguments: { file_path: 'src/export/csv.js' } }],
          },
          {
            turn: 1,
            prompt: '补充导出边界单测',
            response: '完成',
            toolCalls: [{ name: 'edit', arguments: { file_path: 'src/export/csv.js' } }],
          },
        ], BASE_TIME + 2 * HOUR),
        [sessThrowRead]: [],
      },
    })

    // 直接走 work-store 默认读路径（不注入自定义 loadSessionTurns，验证 defaultLoadSessionTurns 降级）
    const res = await scanWorkspaceWorks(host.ctx, wsId, {
      force: true,
      useModel: false,
      now: BASE_TIME + 3 * HOUR,
    })
    assert.equal(res.ok, true, '单个会话 readSession 抛错不应拖垮整个工作区盘点')
    assert.equal(res.scanned, true)
    assert.ok(res.store.works.length >= 2, `两个正常会话（含坏索引与缺索引）都应成功降级盘点，实际 works=${res.store.works.length}`)
    const allSessionIds = new Set(res.store.works.flatMap(w => w.sessionIds))
    assert.ok(allSessionIds.has(sessCorruptIdx), '索引损坏的会话应成功降级从 readSession 读取')
    assert.ok(allSessionIds.has(sessMissingIdx), '索引缺失的会话应成功降级从 readSession 读取')
    assert.ok(!allSessionIds.has(sessThrowRead), 'readSession 抛错的会话应被跳过')
  })
})

// ============================================================================
// 2. 模型不可用 / 超时 / 乱输出 / 断网降级
// ============================================================================
console.log('\n2. 模型不可用 / 超时 / 乱输出 / 断网降级')

await test('2.1 纯解析器：空串 / 截断非法 JSON / 幻觉 workId / 越界 clusterId / 非法 state 全部安全降级不丢段', async () => {
  const localSegments = sliceSessionSegments([
    {
      turn: 0,
      start: BASE_TIME,
      end: BASE_TIME + 5000,
      prompt: '修复 auth/login.js token 过期问题',
      response: '已修改 auth/login.js',
      tools: ['edit'],
      files: ['src/auth/login.js'],
      changes: { files: [{ path: 'src/auth/login.js', added: 10, deleted: 2 }] },
    },
    {
      turn: 1,
      start: BASE_TIME + 2 * HOUR,
      end: BASE_TIME + 2 * HOUR + 5000,
      prompt: '优化 billing/invoice.js PDF 渲染',
      response: '已修改 billing/invoice.js',
      tools: ['edit'],
      files: ['src/billing/invoice.js'],
      changes: { files: [{ path: 'src/billing/invoice.js', added: 20, deleted: 5 }] },
    },
  ], { sessionId: 'session-11223344-refine' })
  assert.equal(localSegments.length, 2)

  // 切段精化解析：空串 / 截断 JSON / 缺口 / 重叠 / 非法类型
  for (const badOutput of [
    '',
    '   ',
    '[{"startTurn":0,"endTurn":0,"title":"截断...',
    '[{"startTurn":0,"endTurn":0}]', // 漏掉第 2 段
    '[{"startTurn":0,"endTurn":99}]', // 越界
    '{"not":"an array"}',
  ]) {
    const refined = parseSegmentRefineResult(badOutput, localSegments)
    assert.equal(refined.length, 2, `切段精化遇到坏输出应回退原 2 段: ${badOutput}`)
    assert.equal(refined[0].startTurn, 0)
    assert.equal(refined[1].endTurn, 1)
  }

  // 冷启动盘点语义精化解析：空串 / 截断 JSON / 幻觉 clusterId / 非法 state
  const plan = planColdStartWorks(localSegments.map(s => ({
    ...s,
    workspaceId: 'ws-m',
    lastActivityAt: s.endTime,
  })), { workspaceId: 'ws-m', now: BASE_TIME + 3 * HOUR })
  assert.equal(plan.clusters.length, 2)

  const badEmpty = parseColdStartSemanticResult('', plan.clusters)
  assert.equal(badEmpty.fallback, true)
  assert.equal(badEmpty.works.length, 2)

  const badTrunc = parseColdStartSemanticResult('{"works":[{"clusterIds":["cl-1"],"title":"坏', plan.clusters)
  assert.equal(badTrunc.fallback, true)
  assert.equal(badTrunc.works.length, 2)

  // 幻觉 clusterId（全不存在）→ 必须整体 fallback，绝不丢簇
  const badHallucinated = parseColdStartSemanticResult(JSON.stringify({
    works: [{ clusterIds: ['cl-999', 'cl-ghost'], title: '幻觉事', state: 'BOGUS_STATE' }],
    chatClusterIds: ['cl-888'],
  }), plan.clusters)
  assert.equal(badHallucinated.fallback, true, '全幻觉 clusterId 应触发 fallback')
  assert.equal(badHallucinated.works.length, 2, 'fallback 必须保留全部本地簇')

  // 混合：合法 clusterId + 非法 state + 漏掉另一个 clusterId → 非法 state 纠偏，漏掉的簇自动补回不丢段
  const partialBad = parseColdStartSemanticResult(JSON.stringify({
    works: [{ clusterIds: ['cl-1', 'cl-999'], title: '登录修复', state: 'INVALID_STATE' }],
    chatClusterIds: [],
  }), plan.clusters)
  assert.equal(partialBad.fallback, false)
  assert.equal(partialBad.works.length, 2, '未被模型认领的 cl-2 必须补回，不能丢簇')
  assert.ok(['active', 'blocked', 'done', 'shelved'].includes(partialBad.works[0].state), '非法 state 应回退合法四态')

  // L3 增量语义匹配解析：幻觉 workId / 非法 action / 截断 JSON → 返回 null 安全降级
  const candidates = plan.works
  assert.equal(parseIncrementalMatchResult('', candidates), null)
  assert.equal(parseIncrementalMatchResult('{broken', candidates), null)
  assert.equal(parseIncrementalMatchResult(JSON.stringify({ action: 'attach', workId: 'w-hallucinated-999', reason: '猜的' }), candidates), null)
  assert.equal(parseIncrementalMatchResult(JSON.stringify({ action: 'delete_all', workId: candidates[0].id }), candidates), null)
})

await test('2.2 端到端模型故障降级：无 LLM / resolveRoute=null / 502 / 超时 / 乱输出在冷启动与增量 L3 均不抛错不丢段', async () => {
  const failureModes = [
    { name: 'no-llm', llm: undefined, deps: {} },
    {
      name: 'resolveRoute-null-no-providers',
      llm: { listProviders: () => [], prepareCall: async () => { throw new Error('should not call') } },
      deps: { resolveRoute: async () => null },
    },
    {
      name: 'model-502',
      llm: undefined,
      deps: { askModel: async () => { const e = new Error('HTTP 502 Bad Gateway'); e.status = 502; throw e } },
    },
    {
      name: 'model-timeout',
      llm: undefined,
      deps: { askModel: async () => { const e = new Error('Request timed out'); e.code = 'ETIMEDOUT'; throw e } },
    },
    {
      name: 'model-empty-string',
      llm: undefined,
      deps: { askModel: async () => '' },
    },
    {
      name: 'model-garbage-json',
      llm: undefined,
      deps: { askModel: async () => '{"works":[{"clusterIds":["cl-999"], broken' },
    },
    {
      name: 'model-hallucinated-l3',
      llm: undefined,
      deps: { askModel: async () => JSON.stringify({ action: 'attach', workId: 'w-nonexistent-ghost', reason: '幻觉' }) },
    },
  ]

  for (const mode of failureModes) {
    await withTempHome(async () => {
      const wsId = `ws-llm-${mode.name}`
      const sess1 = 'session-aa110001-base'
      const sess2 = 'session-bb220002-inc'
      const host = createHostEnv({
        wsId,
        llm: mode.llm,
        sessionIds: [sess1, sess2],
        events: {
          [sess1]: makeEvents([
            {
              turn: 0,
              prompt: '重构 src/cache/lru.js 淘汰策略',
              response: '已修改 src/cache/lru.js',
              toolCalls: [{ name: 'edit', arguments: { file_path: 'src/cache/lru.js' } }],
            },
            {
              turn: 1,
              prompt: '补充 lru 并发单测',
              response: '单测通过',
              toolCalls: [{ name: 'pwsh', arguments: { command: 'node --test lru.test.js' } }],
            },
          ], BASE_TIME),
          [sess2]: makeEvents([
            {
              turn: 0,
              prompt: '排查定时任务调度延迟问题',
              response: '先检查调度器源码',
              toolCalls: [{ name: 'read', arguments: { file_path: 'src/scheduler/cron.js' } }],
            },
            {
              turn: 1,
              prompt: '定位到 timer 漂移并写修复方案',
              response: '建议改为单调时钟',
              toolCalls: [{ name: 'grep', arguments: { pattern: 'setInterval' } }],
            },
          ], BASE_TIME + HOUR),
        },
      })

      // 冷启动盘点：开启 useModel: true
      const scanRes = await scanWorkspaceWorks(host.ctx, wsId, {
        force: true,
        useModel: true,
        now: BASE_TIME + 2 * HOUR,
        deps: mode.deps,
      })
      assert.equal(scanRes.ok, true, `${mode.name}: 冷启动盘点应安全降级返回 ok:true`)
      assert.equal(scanRes.semanticUsed, false, `${mode.name}: 异常模型不应标记 semanticUsed=true`)
      assert.ok(scanRes.store.works.length >= 1, `${mode.name}: 降级后不应丢工作`)

      // 增量 L3 匹配：新会话无重叠文件、无 fork/句柄，必走 L3 need_semantic → 模型失败/幻觉安全降级
      const sess3 = 'session-cc330003-l3'
      host.workspaces[0].sessionIds.push(sess3)
      const origRead = host.ctx.sessionQuery.readSession
      host.ctx.sessionQuery.readSession = async id => {
        if (id === sess3) {
          return {
            header: { id: sess3 },
            events: makeEvents([
              {
                turn: 0,
                prompt: '实现全新的数据导入导出模块',
                response: '已规划接口',
                toolCalls: [{ name: 'read', arguments: { file_path: 'src/import/plan.js' } }],
              },
              {
                turn: 1,
                prompt: '编写导入模块校验逻辑',
                response: '完成校验',
                toolCalls: [{ name: 'edit', arguments: { file_path: 'src/import/validator.js' } }],
              },
            ], BASE_TIME + 3 * HOUR),
          }
        }
        return origRead(id)
      }

      const incRes = await incrementalSyncSession(host.ctx, sess3, {
        workspaceId: wsId,
        useModel: true,
        now: BASE_TIME + 4 * HOUR,
        deps: mode.deps,
      })
      assert.equal(incRes.ok, true, `${mode.name}: 增量同步 L3 故障应安全降级返回 ok:true`)
      assert.equal(incRes.match.action, 'new_work', `${mode.name}: L3 模型不可用/幻觉时工作段应降级建新事而不丢段`)
      assert.ok(Object.values(incRes.store.segments).some(s => s.sessionId === sess3), `${mode.name}: 新段应已落盘`)
    })
  }
})

// ============================================================================
// 3. 极端输入参数与 HTTP 边界校验
// ============================================================================
console.log('\n3. 极端输入参数与 HTTP 边界校验')

await test('3.1 全部 10 个 work HTTP 端点在非对象 body / 不存在 workspaceId / 缺失字段时返回 4xx 中文错误，绝不 500', async () => {
  await withTempHome(async () => {
    const wsId = 'ws-http-edge'
    const host = createHostEnv({ wsId, events: {} })

    const allEndpoints = [
      'works',
      'works-scan',
      'work-confirm',
      'work-dismiss',
      'work-promote',
      'work-merge',
      'work-split',
      'work-handoff',
      'work-handoff-bind',
      'work-inflection-dismiss',
    ]

    for (const ep of allEndpoints) {
      // 非对象 body：数组
      const rArr = await host.request('POST', ep, [1, 2, 3])
      assert.ok(rArr.status >= 400 && rArr.status < 500, `/${ep} 数组 body 应返回 4xx，实际 ${rArr.status}`)
      assert.equal(rArr.body.ok, false)
      assert.ok(typeof rArr.body.error === 'string' && rArr.body.error.length > 0)

      // 非对象 body：字符串
      const rStr = await host.request('POST', ep, 'not-an-object')
      assert.ok(rStr.status >= 400 && rStr.status < 500, `/${ep} 字符串 body 应返回 4xx，实际 ${rStr.status}`)
      assert.equal(rStr.body.ok, false)

      // 非对象 body：数字
      const rNum = await host.request('POST', ep, 42)
      assert.ok(rNum.status >= 400 && rNum.status < 500, `/${ep} 数字 body 应返回 4xx，实际 ${rNum.status}`)

      // 不存在的 workspaceId → 404
      const rNoWs = await host.request('POST', ep, { workspaceId: 'ws-definitely-not-exist' })
      assert.equal(rNoWs.status, 404, `/${ep} 不存在的 workspaceId 应返回 404，实际 ${rNoWs.status}`)
      assert.equal(rNoWs.body.ok, false)
      assert.ok(rNoWs.body.error.includes('工作区'), `/${ep} 404 应含中文提示，实际: ${rNoWs.body.error}`)

      // 非法类型 workspaceId（数字）→ 400
      const rBadWsType = await host.request('POST', ep, { workspaceId: 12345 })
      assert.equal(rBadWsType.status, 400, `/${ep} 非字符串 workspaceId 应返回 400，实际 ${rBadWsType.status}`)
      assert.equal(rBadWsType.body.ok, false)
    }

    // 当注册表为空时，空 body（缺失 workspaceId）→ 全部 10 个端点必须返回 404，绝不 500
    const emptyHost = createHostEnv({ workspaces: [], events: {} })
    for (const ep of allEndpoints) {
      const rEmpty = await emptyHost.requestRaw('POST', ep, undefined)
      assert.ok(rEmpty.status >= 400 && rEmpty.status < 500, `无工作区时 /${ep} 空 body 应返回 4xx，实际 ${rEmpty.status}`)
      assert.equal(rEmpty.body.ok, false)
    }
  })
})

await test('3.2 各端点业务边界：不存在 workId / 非法 mode / 自合并 / 空 segment / 拆不存在段与拆唯一一段', async () => {
  await withTempHome(async () => {
    const wsId = 'ws-biz-edge'
    const host = createHostEnv({ wsId, events: {} })

    // 预置一个仅有 1 段的 work
    const baseStore = emptyWorkStore(wsId)
    const soloWork = createWork({
      id: 'w-solo',
      workspaceId: wsId,
      title: '单段工作',
      state: 'active',
      segmentIds: ['seg:aaaa1111:0-1'],
      sessionIds: ['session-aaaa1111'],
    }, BASE_TIME)
    baseStore.works.push(soloWork)
    baseStore.segments['seg:aaaa1111:0-1'] = {
      id: 'seg:aaaa1111:0-1',
      sessionId: 'session-aaaa1111',
      startTurn: 0,
      endTurn: 1,
      title: '唯一段',
      workId: 'w-solo',
    }
    baseStore.initializedAt = BASE_TIME
    await writeWorkStore(wsId, baseStore)

    // 1) work-confirm：缺 workId → 400；不存在 workId → 404
    const cMissing = await host.request('POST', 'work-confirm', { workspaceId: wsId })
    assert.equal(cMissing.status, 400)
    const cNoWork = await host.request('POST', 'work-confirm', { workspaceId: wsId, workId: 'w-missing', state: 'done' })
    assert.equal(cNoWork.status, 404)
    assert.ok(cNoWork.body.error.includes('不存在'))

    // 2) work-dismiss：缺 workId → 400；不存在 workId → 404
    assert.equal((await host.request('POST', 'work-dismiss', { workspaceId: wsId })).status, 400)
    assert.equal((await host.request('POST', 'work-dismiss', { workspaceId: wsId, workId: 'w-missing' })).status, 404)

    // 3) work-promote：缺失 / null / 非对象 segment → 400
    assert.equal((await host.request('POST', 'work-promote', { workspaceId: wsId })).status, 400)
    assert.equal((await host.request('POST', 'work-promote', { workspaceId: wsId, segment: null })).status, 400)
    assert.equal((await host.request('POST', 'work-promote', { workspaceId: wsId, segment: 'bad' })).status, 400)
    assert.equal((await host.request('POST', 'work-promote', { workspaceId: wsId, segment: [] })).status, 400)

    // 4) work-merge：自合并 → 400；缺参 → 400；不存在 → 404
    const mSelf = await host.request('POST', 'work-merge', {
      workspaceId: wsId,
      targetWorkId: 'w-solo',
      sourceWorkId: 'w-solo',
    })
    assert.equal(mSelf.status, 400, '自合并必须返回 400')
    assert.ok(mSelf.body.error.includes('不同'))
    assert.equal((await host.request('POST', 'work-merge', { workspaceId: wsId, targetWorkId: 'w-solo' })).status, 400)
    assert.equal((await host.request('POST', 'work-merge', {
      workspaceId: wsId,
      targetWorkId: 'w-solo',
      sourceWorkId: 'w-missing',
    })).status, 404)

    // 5) work-handoff：非法 mode → 400；缺 workId → 400；不存在 workId → 404
    const hBadMode = await host.request('POST', 'work-handoff', {
      workspaceId: wsId,
      workId: 'w-solo',
      mode: 'teleport-mode',
    })
    assert.equal(hBadMode.status, 400, '非法 mode 必须返回 400')
    assert.ok(hBadMode.body.error.includes('same-session'))
    assert.equal((await host.request('POST', 'work-handoff', { workspaceId: wsId })).status, 400)
    assert.equal((await host.request('POST', 'work-handoff', { workspaceId: wsId, workId: 'w-missing' })).status, 404)

    // 6) work-handoff-bind：缺 workId / sessionId → 400；不存在 workId → 404
    assert.equal((await host.request('POST', 'work-handoff-bind', { workspaceId: wsId, workId: 'w-solo' })).status, 400)
    assert.equal((await host.request('POST', 'work-handoff-bind', { workspaceId: wsId, sessionId: 's-1' })).status, 400)
    assert.equal((await host.request('POST', 'work-handoff-bind', {
      workspaceId: wsId,
      workId: 'w-missing',
      sessionId: 's-1',
    })).status, 404)

    // 7) work-split：缺参 → 400；不存在 workId → 404；不属于该事的段 → 400
    assert.equal((await host.request('POST', 'work-split', { workspaceId: wsId, workId: 'w-solo' })).status, 400)
    assert.equal((await host.request('POST', 'work-split', { workspaceId: wsId, workId: 'w-missing', segmentId: 'seg:1' })).status, 404)
    assert.equal((await host.request('POST', 'work-split', {
      workspaceId: wsId,
      workId: 'w-solo',
      segmentId: 'seg:other:0-0',
    })).status, 400)

    // 8) work-split 拆唯一一段：必须明确返回 400 拒绝，不能留下 0 段空壳事
    const sOnly = await host.request('POST', 'work-split', {
      workspaceId: wsId,
      workId: 'w-solo',
      segmentId: 'seg:aaaa1111:0-1',
    })
    assert.equal(sOnly.status, 400, '拆唯一一段必须返回 400')
    assert.equal(sOnly.body.ok, false)

    // 9) 非法 JSON 请求体必须返回 400 而非 500
    const badJsonRes = await host.requestRaw('POST', 'works', '{broken json')
    assert.equal(badJsonRes.status, 400, '非法 JSON 应返回 400')
    assert.equal(badJsonRes.body.ok, false)
  })
})

await test('3.3 补充边界：空对象 segment、多字段缺失与只传非法补丁不污染 store', async () => {
  await withTempHome(async () => {
    const wsId = 'ws-extra-edge'
    const host = createHostEnv({ wsId, events: {} })

    const baseStore = emptyWorkStore(wsId)
    baseStore.initializedAt = BASE_TIME
    baseStore.works.push(createWork({
      id: 'w-keep',
      workspaceId: wsId,
      title: '原始标题',
      state: 'active',
      stateSource: 'inferred',
      segmentIds: ['seg:1111aaaa:0-0', 'seg:1111aaaa:1-1'],
      sessionIds: ['session-1111aaaa'],
    }, BASE_TIME))
    baseStore.segments['seg:1111aaaa:0-0'] = { id: 'seg:1111aaaa:0-0', sessionId: 'session-1111aaaa', startTurn: 0, endTurn: 0, title: '段1', workId: 'w-keep' }
    baseStore.segments['seg:1111aaaa:1-1'] = { id: 'seg:1111aaaa:1-1', sessionId: 'session-1111aaaa', startTurn: 1, endTurn: 1, title: '段2', workId: 'w-keep' }
    await writeWorkStore(wsId, baseStore)

    // 传非法 state 给 work-confirm：忽略非法 state，保持原合法状态，不崩溃
    const rBadState = await host.request('POST', 'work-confirm', {
      workspaceId: wsId,
      workId: 'w-keep',
      patch: { state: 'UNKNOWN_STATE' },
    })
    assert.equal(rBadState.status, 200)
    assert.equal(rBadState.body.value.work.state, 'active', '非法 state 不得写入 store')

    // 正常拆 2 段事的其中 1 段：原事保留 1 段、新事 1 段，两段皆锁定
    const rSplitOk = await host.request('POST', 'work-split', {
      workspaceId: wsId,
      workId: 'w-keep',
      segmentId: 'seg:1111aaaa:1-1',
    })
    assert.equal(rSplitOk.status, 200)
    assert.equal(rSplitOk.body.ok, true)
    assert.equal(rSplitOk.body.value.work.segmentIds.length, 1)
    const after = await readWorkStore(wsId)
    const origin = after.store.works.find(w => w.id === 'w-keep')
    assert.deepEqual(origin.segmentIds, ['seg:1111aaaa:0-0'])
  })
})

// ============================================================================
// 4. 极端规模与超长文本预算边界
// ============================================================================
console.log('\n4. 极端规模与超长文本预算边界')

await test('4.1 32KB 单轮 / 200 文件 / 50 命令 / 20 报错 / 15 决策：extractWorkHardFacts 严守上限，renderWorkContextForAgent 严守预算与极紧 250 字保底', async () => {
  const hugePrompt = '修复核心渲染引擎并发死锁问题：' + 'A'.repeat(32 * 1024)
  const hugeResponse = '已定位根因在互斥锁重入：' + 'B'.repeat(32 * 1024)
  const manyFiles = Array.from({ length: 200 }, (_, i) => ({
    path: `src/modules/mod-${String(i).padStart(3, '0')}/handler.js`,
    added: i + 1,
    deleted: i % 7,
  }))
  const manyCommands = Array.from({ length: 50 }, (_, i) => `pnpm test --filter pkg-${i} --reporter verbose`)

  const turns = [
    {
      turn: 0,
      sessionId: 'session-1234abcd-scale',
      start: BASE_TIME,
      end: BASE_TIME + 5000,
      prompt: hugePrompt,
      response: hugeResponse,
      commands: manyCommands,
      changes: { files: manyFiles },
      endReason: 'completed',
    },
    ...Array.from({ length: 20 }, (_, i) => ({
      turn: i + 1,
      sessionId: 'session-1234abcd-scale',
      start: BASE_TIME + (i + 1) * MINUTE,
      end: BASE_TIME + (i + 1) * MINUTE + 3000,
      prompt: `第 ${i + 1} 次压力测试复现报错`,
      response: `Error: ETIMEDOUT at worker #${i + 1} ${'X'.repeat(500)}`,
      commands: [`node scripts/stress.mjs --round ${i + 1}`],
      endReason: 'error',
    })),
  ]

  // 切段也必须平稳消化 32KB 单轮与 200 文件
  const segs = sliceSessionSegments(turns, { sessionId: 'session-1234abcd-scale' })
  assert.ok(segs.length >= 1)
  assert.ok(segs[0].title.length <= 36, `段标题应受 36 字限制，实际 ${segs[0].title.length}`)
  assert.ok(segs[0].summary.length <= 120, `段摘要应受 120 字限制，实际 ${segs[0].summary.length}`)

  // extractWorkHardFacts 严守默认上限（12 文件 / 6 命令 / 3 失败 / 8 证据）
  const facts = extractWorkHardFacts(turns, {
    decisionEvidence: ['〔1234abcd#0〕'],
  })
  assert.equal(facts.changedFiles.length, 12, 'changedFiles 必须严守默认上限 12')
  assert.equal(facts.recentCommands.length, 6, 'recentCommands 必须严守默认上限 6')
  assert.equal(facts.failedSignals.length, 3, 'failedSignals 必须严守默认上限 3')
  assert.ok(facts.keyEvidenceHandles.length <= 8, 'keyEvidenceHandles 必须严守默认上限 8')
  for (const sig of facts.failedSignals) {
    assert.ok(Array.from(sig.hint).length <= 120, '失败信号 hint 必须截断到 ≤120 码点')
  }
  for (const ev of facts.keyEvidenceHandles) {
    assert.ok(Array.from(ev.head).length <= 30, '证据头必须截断到 ≤30 码点')
  }

  // 15 条决策（含现行 + 已否决）+ 500 字标题/下一步
  const longTitle = '重构分布式缓存一致性协议与故障切换流程'.repeat(30) // >500 字
  const longNextStep = '先补齐写前日志崩溃恢复的边界集成测试并核对全量压测指标'.repeat(20) // >500 字
  const decisions = [
    { id: 'd-1', summary: '采用 Raft 同步元数据', rationale: '强一致', status: 'active', handle: '〔1234abcd#0〕' },
    ...Array.from({ length: 14 }, (_, i) => ({
      id: `d-rej-${i + 2}`,
      summary: `备选方案 ${i + 2}：轮询补偿队列`,
      rationale: '延迟过高且易丢序',
      status: 'superseded',
      supersededBy: 'd-1',
    })),
  ]

  // 新会话草稿截断稳定
  const draft = buildNewSessionHandoffDraft({
    id: 'w-scale',
    title: longTitle,
    goal: 'G'.repeat(500),
    blocker: 'K'.repeat(500),
    nextStep: longNextStep,
  }, facts)
  assert.ok(draft.includes('等 12 个文件'), '新会话草稿应预览前 3 个文件并标明总数')

  // 正常预算（1200 字）：严守预算，保留核心三要素，写清省略计数
  const compactWork = {
    id: 'w-budget',
    title: '缓存一致性重构',
    goal: '消除节点切换期的脏读窗口',
    status: 'blocked',
    confirmed: true,
    nextStep: '修复 worker 锁超时并重跑压测',
    decisions,
  }
  const rendered1200 = renderWorkContextForAgent(compactWork, facts, { maxChars: 1200 })
  assert.ok(rendered1200.length <= 1200, `1200 预算应严格 <=1200，实际 ${rendered1200.length}`)
  assert.ok(rendered1200.includes('消除节点切换期的脏读窗口'), '目标永不丢')
  assert.ok(rendered1200.includes('修复 worker 锁超时并重跑压测'), '下一步永不丢')
  assert.ok(rendered1200.includes('采用 Raft 同步元数据'), '现行决策永不丢')
  assert.ok(rendered1200.includes('已省略'), '超预算裁剪必须显式写清省略计数')

  // 极紧预算（250 字）：仍保底保留目标 / 下一步 / 现行决策，且把全部可裁项裁剪完毕并显式写出省略计数
  const rendered250 = renderWorkContextForAgent(compactWork, facts, { maxChars: 250 })
  assert.ok(rendered250.includes('消除节点切换期的脏读窗口'), '极紧 250 预算下目标仍必须保底保留')
  assert.ok(rendered250.includes('修复 worker 锁超时并重跑压测'), '极紧 250 预算下下一步仍必须保底保留')
  assert.ok(rendered250.includes('采用 Raft 同步元数据'), '极紧 250 预算下现行决策仍必须保底保留')
  assert.ok(rendered250.includes('已省略 14 条已否决方案'), '极紧预算应明确标出已否决方案省略数')
  assert.ok(rendered250.includes('已省略 12 个变更文件'), '极紧预算应明确标出变更文件省略数')
  assert.ok(rendered250.includes('已省略 6 条命令'), '极紧预算应明确标出命令省略数')
  assert.ok(rendered250.includes('已省略 3 条失败信号'), '极紧预算应明确标出失败信号省略数')
})

await test('4.2 formatWorkCard 严守 60 码点截断且绝不拆断 Emoji / UTF-16 代理对', async () => {
  // 构造恰好在 59~61 码点处放置 4 字节 Emoji（Rocket 🚀 / 家庭 / 麻将 🀇）的超长现状
  const emojiStatus = '正在排查构建管线'.repeat(7) + '🚀🔥🎉✨🧪🛠️🚧🎯' + '后续补充说明'.repeat(20)
  const card = formatWorkCard({
    id: 'w-emoji',
    title: '🚀'.repeat(200),
    state: 'active',
    stateSource: 'confirmed',
    statusSummary: emojiStatus,
    nextStep: '🎉'.repeat(200),
    lastActivityAt: BASE_TIME,
  }, BASE_TIME + 5 * MINUTE)

  const codePoints = Array.from(card.statusLine)
  assert.ok(codePoints.length <= 60, `statusLine 码点数应 ≤ 60，实际 ${codePoints.length}`)
  assert.equal(codePoints[codePoints.length - 1], '…', '超长 statusLine 应以省略号结尾')
  assert.equal(hasLoneSurrogate(card.statusLine), false, 'statusLine 绝不能出现拆断的 UTF-16 孤立代理项')

  // 边界测试：连续 58 个普通字 + 10 个 Emoji（截断正好落在第 59 个码点即第 1 个 Emoji 之后）
  const edgeEmoji = 'a'.repeat(58) + '🚀🔥🎉✨🧪'
  const card2 = formatWorkCard({
    id: 'w-emoji-2',
    title: 'Emoji 边界',
    state: 'blocked',
    statusSummary: edgeEmoji,
    lastActivityAt: BASE_TIME,
  }, BASE_TIME)
  assert.equal(Array.from(card2.statusLine).length, 60)
  assert.equal(card2.statusLine.endsWith('🚀…'), true, '第 59 个码点应保留完整 🚀 而非半个代理项')
  assert.equal(hasLoneSurrogate(card2.statusLine), false)
})

// ============================================================================
// 5. 并发竞争与串行锁压力测试
// ============================================================================
console.log('\n5. 并发竞争与串行锁压力测试')

await test('5.1 Promise.all 并发 10 次 confirmWork + incrementalSyncSession + dismissInflection 无写花、无 tmp 残留、人工确认零丢失', async () => {
  await withTempHome(async () => {
    const wsId = 'ws-concurrency'
    const sessBase = 'session-11aa22bb-base'
    const sessInc1 = 'session-33cc44dd-inc1'
    const sessInc2 = 'session-55ee66ff-inc2'

    const host = createHostEnv({
      wsId,
      sessionIds: [sessBase, sessInc1, sessInc2],
      events: {
        [sessBase]: makeEvents([
          {
            turn: 0,
            prompt: '优化搜索索引写入性能',
            response: '已改造 src/search/writer.js',
            toolCalls: [{ name: 'edit', arguments: { file_path: 'src/search/writer.js' } }],
          },
          {
            turn: 1,
            prompt: '运行基准测试',
            response: '耗时减半',
            toolCalls: [{ name: 'pwsh', arguments: { command: 'node bench/search.mjs' } }],
          },
        ], BASE_TIME),
        [sessInc1]: makeEvents([
          {
            turn: 0,
            prompt: '继续调优 src/search/writer.js 批处理大小',
            response: '调整为 64 条每批',
            toolCalls: [{ name: 'edit', arguments: { file_path: 'src/search/writer.js' } }],
          },
        ], BASE_TIME + HOUR),
        [sessInc2]: makeEvents([
          {
            turn: 0,
            prompt: '排查 src/search/writer.js 落盘重试',
            response: '出现临时错误，待重试',
            toolCalls: [{ name: 'edit', arguments: { file_path: 'src/search/writer.js' } }],
            endReason: 'error',
          },
        ], BASE_TIME + 2 * HOUR),
      },
    })

    // 先冷启动生成初始事
    const init = await scanWorkspaceWorks(host.ctx, wsId, {
      force: true,
      useModel: false,
      now: BASE_TIME + 2 * HOUR,
    })
    assert.equal(init.ok, true)
    const targetWorkId = init.store.works[0].id

    // 10 个并发写操作同时轰炸同一个 workspaceId
    const ops = [
      confirmWork(wsId, targetWorkId, { state: 'active', pinned: true }, { now: BASE_TIME + 3 * HOUR + 1 }),
      incrementalSyncSession(host.ctx, sessInc1, { workspaceId: wsId, useModel: false, now: BASE_TIME + 3 * HOUR + 2 }),
      confirmWork(wsId, targetWorkId, { nextStep: '锁定的最终下一步' }, { now: BASE_TIME + 3 * HOUR + 3 }),
      dismissInflection(wsId, { now: BASE_TIME + 3 * HOUR + 4 }),
      confirmWork(wsId, targetWorkId, { title: '人工确认的最终标题' }, { now: BASE_TIME + 3 * HOUR + 5 }),
      incrementalSyncSession(host.ctx, sessInc2, { workspaceId: wsId, useModel: false, now: BASE_TIME + 3 * HOUR + 6 }),
      confirmWork(wsId, targetWorkId, { goal: '人工锁定的目标' }, { now: BASE_TIME + 3 * HOUR + 7 }),
      confirmWork(wsId, targetWorkId, {
        addDecision: { id: 'd-lock-1', summary: '强制采用 fsync 原子写', rationale: '防掉电写花' },
      }, { now: BASE_TIME + 3 * HOUR + 8 }),
      dismissInflection(wsId, { now: BASE_TIME + 3 * HOUR + 9 }),
      confirmWork(wsId, targetWorkId, { statusSummary: '人工核对过的现状' }, { now: BASE_TIME + 3 * HOUR + 10 }),
    ]

    const results = await Promise.all(ops)
    for (let i = 0; i < results.length; i += 1) {
      assert.equal(results[i].ok, true, `并发操作 #${i} 应成功，实际: ${JSON.stringify(results[i])}`)
    }

    // 1) 磁盘 JSON 可完整解析且无损坏
    const storeFile = workStorePath(wsId)
    const diskText = await readFile(storeFile, 'utf8')
    const diskJson = JSON.parse(diskText)
    assert.equal(diskJson.workspaceId, wsId)

    // 2) 目录内零 .tmp 残留
    const dirEntries = await readdir(dirname(storeFile))
    const tmpFiles = dirEntries.filter(f => f.endsWith('.tmp'))
    assert.equal(tmpFiles.length, 0, `并发写结束后绝不能有 .tmp 残留，发现: ${tmpFiles.join(', ')}`)

    // 3) 所有人工确认字段零丢失（不会被穿插其中的 incrementalSyncSession 覆盖）
    const finalWork = diskJson.works.find(w => w.id === targetWorkId)
    assert.ok(finalWork, '目标事应存在')
    assert.equal(finalWork.state, 'active')
    assert.equal(finalWork.stateSource, 'confirmed')
    assert.equal(finalWork.pinned, true)
    assert.equal(finalWork.nextStep, '锁定的最终下一步')
    assert.equal(finalWork.nextStepSource, 'confirmed')
    assert.equal(finalWork.title, '人工确认的最终标题')
    assert.equal(finalWork.goal, '人工锁定的目标')
    assert.equal(finalWork.statusSummary, '人工核对过的现状')
    assert.ok(finalWork.decisions.some(d => d.id === 'd-lock-1' && d.source === 'confirmed'), '人工确认决策零丢失')
  })
})

// ============================================================================
// 6. 空工作区 / 0 轮会话 / 全子代理工作区 / 乱序与负时间戳轮次
// ============================================================================
console.log('\n6. 空工作区 / 0 轮会话 / 全子代理工作区 / 乱序与负时间戳轮次')

await test('6.1 空工作区 / 全 0 轮会话 / 全子代理工作区：盘点、投影、workBoardModel 空态全部稳定', async () => {
  await withTempHome(async () => {
    // 1) 空工作区（0 会话）
    const hostEmpty = createHostEnv({ wsId: 'ws-zero', sessionIds: [], events: {} })
    const rEmpty = await readWorkspaceWorksView(hostEmpty.ctx, 'ws-zero', { useModel: false, now: BASE_TIME })
    assert.equal(rEmpty.ok, true)
    assert.deepEqual(rEmpty.cards.unresolved, [])
    assert.deepEqual(rEmpty.cards.settled, [])
    assert.equal(rEmpty.pendingReviewCount, 0)
    const boardEmpty = workBoardModel(rEmpty.cards, { now: BASE_TIME })
    assert.equal(boardEmpty.cards.length, 0)
    assert.equal(boardEmpty.empty.kind, 'no_unresolved')

    // 2) 全 0 轮会话 + 全子代理会话
    const sZero1 = 'session-00000001-zero'
    const sSub1 = 'session-00000002-sub'
    const sSched = 'session-00000003-sched'
    const hostNoisy = createHostEnv({
      wsId: 'ws-noisy-only',
      sessionIds: [sZero1, sSub1, sSched],
      headers: {
        [sSub1]: { origin: 'subagent', delegationDepth: 1 },
        [sSched]: { origin: 'scheduled', scheduleId: 'cron-1' },
      },
      events: {
        [sZero1]: [],
        [sSub1]: makeEvents([
          { turn: 0, prompt: '子代理执行代码改动', response: '已改', toolCalls: [{ name: 'edit', arguments: { file_path: 'src/a.js' } }] },
        ], BASE_TIME),
        [sSched]: makeEvents([
          { turn: 0, prompt: '[scheduled] 巡检脚本', response: 'ok', toolCalls: [{ name: 'pwsh', arguments: { command: 'echo ok' } }] },
        ], BASE_TIME),
      },
    })
    assert.equal(isAutomatedSession({ turns: [] }), true)
    assert.equal(isAutomatedSession({ origin: 'subagent', turns: [{ turn: 0 }] }), true)

    const rNoisy = await scanWorkspaceWorks(hostNoisy.ctx, 'ws-noisy-only', {
      force: true,
      useModel: false,
      now: BASE_TIME + HOUR,
    })
    assert.equal(rNoisy.ok, true)
    assert.equal(rNoisy.store.works.length, 0, '全 0 轮与全子代理/定时工作区不应自动立任何事')
    assert.equal(rNoisy.pendingReviewCount, 0)
  })
})

await test('6.2 轮次时间戳缺失 / 为 0 / 负值 / 倒挂 + 非连续轮号（#2, #7, #15）：切段、盘点、投影与 segmentGroupsOf 无 NaN 无 undefined', async () => {
  const messyTurns = [
    // 乱序传入（15, 2, 7），且时间戳分别为缺失、0、负值、倒挂（end < start）
    {
      turn: 15,
      start: -5000,
      end: -10000,
      prompt: '修复 src/net/retry.js 重试退避',
      response: '已修复',
      tools: ['edit'],
      files: ['src/net/retry.js'],
      changes: { files: [{ path: 'src/net/retry.js', added: 4, deleted: 1 }] },
    },
    {
      turn: 2,
      start: undefined,
      end: null,
      prompt: '检查 src/net/retry.js 超时配置',
      response: '发现超时过短',
      tools: ['read'],
      files: ['src/net/retry.js'],
    },
    {
      turn: 7,
      start: 0,
      end: 0,
      prompt: '补充 src/net/retry.js 单元测试',
      response: '测试通过',
      tools: ['edit', 'pwsh'],
      files: ['src/net/retry.js'],
      commands: ['node --test retry.test.js'],
    },
  ]

  const segs = sliceSessionSegments(messyTurns, { sessionId: 'session-aabbccdd-messy' })
  assert.ok(segs.length >= 1, '乱序非连续轮号也应正常切段')
  assert.equal(segs[0].startTurn, 2, '应按轮号升序排列，首轮为 2')
  assert.equal(segs[segs.length - 1].endTurn, 15, '末轮应为 15')
  for (const seg of segs) {
    assert.ok(!Number.isNaN(seg.confidence), 'confidence 不得为 NaN')
    assert.ok(seg.startTime === null || Number.isFinite(seg.startTime), 'startTime 必须为 null 或有限数')
    assert.ok(seg.endTime === null || Number.isFinite(seg.endTime), 'endTime 必须为 null 或有限数')
    assert.ok(typeof seg.title === 'string' && seg.title !== '' && !seg.title.includes('undefined'))
    assert.ok(typeof seg.summary === 'string' && !seg.summary.includes('undefined'))
  }

  // toRailOutlineWithSegments 与 rail-view.segmentGroupsOf
  const railOutline = toRailOutlineWithSegments(messyTurns, segs)
  assert.equal(railOutline.length, segs.length)
  const totalTurnsInOutline = railOutline.reduce((acc, g) => acc + g.turns.length, 0)
  assert.equal(totalTurnsInOutline, 3, '非连续轮号 #2, #7, #15 必须全部进入两级目录不丢失')

  const rows = rowsOf([
    { turn: 2, promptHead: '检查超时配置', time: undefined },
    { turn: 7, promptHead: '补充单元测试', time: 0 },
    { turn: 15, promptHead: '修复重试退避', time: -5000 },
  ])
  const groups = segmentGroupsOf(rows, railOutline)
  assert.ok(groups.length >= 1)
  const serialized = JSON.stringify(groups)
  assert.ok(!serialized.includes('NaN'), 'segmentGroupsOf 输出不得含 NaN')
  assert.equal(groups.reduce((acc, g) => acc + g.rows.length, 0), 3, '所有非连续行应完整保留')

  // 盘点 + 投影 + formatWorkCard
  const plan = planColdStartWorks(segs.map(s => ({ ...s, workspaceId: 'ws-messy' })), {
    workspaceId: 'ws-messy',
    now: BASE_TIME,
  })
  assert.ok(plan.works.length >= 1)
  const store = { ...emptyWorkStore('ws-messy'), works: plan.works }
  const projected = projectResumeCards(store, { now: BASE_TIME })
  const board = workBoardModel(projected, { now: BASE_TIME })
  const boardJson = JSON.stringify(board)
  assert.ok(!boardJson.includes('NaN'), 'workBoardModel 投影不得含 NaN')
  assert.ok(!boardJson.includes('undefined'), 'workBoardModel 投影不得含 undefined 字样')
})

// ============================================================================
// 7. Wire 展开极端容错
// ============================================================================
console.log('\n7. Wire 展开极端容错')

await test('7.1 不存在 workId / 跨工作区 workId / 10 个重复句柄 / 账本文件损坏 / {{ 模板花括号与 interpolate: false', async () => {
  await withTempHome(async home => {
    const wsA = 'ws-wire-A'
    const wsB = 'ws-wire-B'
    const sessA = 'session-aa111111-wsa'
    const sessB = 'session-bb222222-wsb'

    // 工作区 A 与 B 各有一件事（含 {{template}} 敏感模板花括号）
    const storeA = emptyWorkStore(wsA)
    storeA.initializedAt = BASE_TIME
    storeA.works.push(createWork({
      id: 'w-a1',
      workspaceId: wsA,
      title: '工作区 A 模板测试 {{SECRET_VAR}}',
      goal: '保持 {{user.token}} 与 {{}} 原样不插值',
      state: 'active',
      stateSource: 'confirmed',
      nextStep: '验证 {{handlebars}} 不会被误替换',
      segmentIds: ['seg:aa111111:0-0'],
      sessionIds: [sessA],
    }, BASE_TIME))
    storeA.works.push(createWork({
      id: 'w-a2',
      workspaceId: wsA,
      title: '工作区 A 第二件事',
      goal: '测试 maxCount 上限',
      state: 'active',
      sessionIds: [sessA],
    }, BASE_TIME))
    storeA.works.push(createWork({
      id: 'w-a3',
      workspaceId: wsA,
      title: '工作区 A 第三件事（应被 maxCount=2 截住）',
      goal: '不应在第 1 条消息中被展开',
      state: 'active',
      sessionIds: [sessA],
    }, BASE_TIME))
    await writeWorkStore(wsA, storeA)

    const storeB = emptyWorkStore(wsB)
    storeB.initializedAt = BASE_TIME
    storeB.works.push(createWork({
      id: 'w-b-secret',
      workspaceId: wsB,
      title: '工作区 B 机密项目 TOP_SECRET_B',
      goal: '绝不能泄露给工作区 A',
      state: 'active',
      sessionIds: [sessB],
    }, BASE_TIME))
    await writeWorkStore(wsB, storeB)

    // 故意写坏会话的 work-ledger 账本文件
    const activeSessionId = 'session-cc333333-active'
    const ledgerFile = join(home, 'topic-map', 'work-ledger', `${activeSessionId}.json`)
    await mkdir(dirname(ledgerFile), { recursive: true })
    await writeFile(ledgerFile, '{corrupted ledger json!!!', 'utf8')

    // 1) extractWorkHandles：10 个重复句柄 + 3 个不同句柄遵守默认 maxCount=2
    const repeatedText = Array.from({ length: 10 }, () => '〔work:w-a1〕').join(' ')
      + ' 〔work:w-a2〕 〔work:w-a3〕'
    const extracted = extractWorkHandles(repeatedText)
    assert.deepEqual(extracted, ['w-a1', 'w-a2'], '10 个重复句柄去重后应严格遵守默认 maxCount=2')

    // 2) 不存在 workId 与跨工作区 workId 绝不泄露、绝不抛错
    const host = createHostEnv({
      workspaces: [
        { id: wsA, path: 'E:\\wsA', title: 'A', sessionIds: [sessA, activeSessionId] },
        { id: wsB, path: 'E:\\wsB', title: 'B', sessionIds: [sessB] },
      ],
      events: {
        [sessA]: makeEvents([{ turn: 0, prompt: '处理 {{env.KEY}}', response: 'ok' }], BASE_TIME),
        [sessB]: makeEvents([{ turn: 0, prompt: 'B secret', response: 'secret' }], BASE_TIME),
        [activeSessionId]: [],
      },
    })

    const leakCheck = await expandWorkHandlesForAgent(
      host.ctx,
      wsA,
      '尝试引用 〔work:w-does-not-exist〕 和跨区 〔work:w-b-secret〕',
      activeSessionId,
    )
    assert.equal(leakCheck, '', '不存在 workId 与跨工作区 workId 必须返回空串且绝不泄露 B 区内容')

    // 3) 账本损坏 + 10 个重复句柄 + 含 {{ 模板花括号 → 通过真实 system-prompt/assemble 钩子验证
    const agent = {
      id: activeSessionId,
      session: {
        id: activeSessionId,
        deriveMessages() {
          return [{
            role: 'user',
            source: { kind: 'user' },
            content: [{
              type: 'text',
              text: `继续处理 {{raw.template}} ${repeatedText} 〔work:w-b-secret〕`,
            }],
          }]
        },
      },
    }

    const assembled = await host.runSystemPromptAssemble(agent)
    const workCtx = assembled.contexts.find(c => c.name === WORK_CONTEXT_NAME)
    assert.ok(workCtx, '账本文件损坏时应优雅退回空账本并成功展开合法句柄')
    assert.equal(workCtx.interpolate, false, 'system-prompt/assemble 注入块必须严格设置 interpolate: false')
    assert.ok(workCtx.text.includes('{{SECRET_VAR}}'), '模板花括号内容应原样保留')
    assert.ok(workCtx.text.includes('工作区 A 第二件事'), '第 2 个不同句柄应展开')
    assert.ok(!workCtx.text.includes('工作区 A 第三件事'), '第 3 个句柄应受 maxCount=2 限制不展开')
    assert.ok(!workCtx.text.includes('TOP_SECRET_B'), '绝不能泄露跨工作区内容')

    // 4) works 文件损坏时，Wire 展开也绝不抛错阻断会话
    const wsBroken = 'ws-wire-broken'
    const brokenPath = workStorePath(wsBroken)
    await mkdir(dirname(brokenPath), { recursive: true })
    await writeFile(brokenPath, '{broken works json', 'utf8')
    const brokenWire = await expandWorkHandlesForAgent(host.ctx, wsBroken, '〔work:w-any〕', 'session-dd444444')
    assert.equal(brokenWire, '', 'works 文件损坏时 Wire 展开应静默返回空串，绝不阻断发送消息')
  })
})

// ============================================================================
// 8. 配置项极端边界
// ============================================================================
console.log('\n8. 配置项极端边界')

await test('8.1 dormantDays 与 inflectionNotice 极端边界在 settingsModel / applySetting / mergeConfigPatch 口径一致且不污染配置', async () => {
  // 辅助：提取 settingsModel 中的单项值
  const valueOf = (cfg, key) => {
    const m = settingsModel(cfg)
    for (const g of m.groups) {
      const found = g.items.find(i => i.key === key)
      if (found) return found.value
    }
    return undefined
  }

  // A. settingsModel：容错夹紧（越界夹到 [0, 365]，非法回默认 14 / true）
  assert.equal(valueOf({ dormantDays: -5 }, 'dormantDays'), 0, 'dormantDays=-5 夹紧到 0')
  assert.equal(valueOf({ dormantDays: 0 }, 'dormantDays'), 0, 'dormantDays=0 保留 0（从不自动沉降）')
  assert.equal(valueOf({ dormantDays: 9999 }, 'dormantDays'), 365, 'dormantDays=9999 夹紧到 365')
  assert.equal(valueOf({ dormantDays: 'abc' }, 'dormantDays'), 14, 'dormantDays="abc" 回默认 14')
  assert.equal(valueOf({ dormantDays: Number.NaN }, 'dormantDays'), 14, 'dormantDays=NaN 回默认 14')
  assert.equal(valueOf({ dormantDays: null }, 'dormantDays'), 14, 'dormantDays=null 回默认 14')

  assert.equal(valueOf({ inflectionNotice: 'yes' }, 'inflectionNotice'), true, 'inflectionNotice="yes" 非法回默认 true')
  assert.equal(valueOf({ inflectionNotice: 1 }, 'inflectionNotice'), true, 'inflectionNotice=1 解析为 true')
  assert.equal(valueOf({ inflectionNotice: 'false' }, 'inflectionNotice'), false, 'inflectionNotice="false" 解析为 false')
  assert.equal(valueOf({ inflectionNotice: {} }, 'inflectionNotice'), true, 'inflectionNotice={} 非法回默认 true')

  // B. applySetting：非法输入必须返回中文错误且原配置保持不变
  const baseCfg = { dormantDays: 14, inflectionNotice: true, turnLimit: 50 }
  for (const badDays of [-5, 9999, 'abc', Number.NaN, null]) {
    const r = applySetting(baseCfg, 'dormantDays', badDays)
    assert.ok(typeof r.error === 'string' && r.error.length > 0, `applySetting(dormantDays=${String(badDays)}) 必须报错`)
    assert.equal(r.config.dormantDays, 14, '报错时不得污染原配置')
    assert.notEqual(r.config, baseCfg, '应返回新副本不改入参')
  }
  const okZero = applySetting(baseCfg, 'dormantDays', 0)
  assert.equal(okZero.error, undefined)
  assert.equal(okZero.config.dormantDays, 0)

  for (const badNotice of ['yes', {}]) {
    const r = applySetting(baseCfg, 'inflectionNotice', badNotice)
    assert.ok(typeof r.error === 'string' && r.error.length > 0, `applySetting(inflectionNotice=${String(badNotice)}) 必须报错`)
    assert.equal(r.config.inflectionNotice, true, '报错时不得污染原配置')
  }
  assert.equal(applySetting(baseCfg, 'inflectionNotice', 1).config.inflectionNotice, true)
  assert.equal(applySetting(baseCfg, 'inflectionNotice', 'false').config.inflectionNotice, false)

  // C. mergeConfigPatch：非法值回落当前值而非污染配置
  const cur = { dormantDays: 30, inflectionNotice: true }
  assert.equal(mergeConfigPatch(cur, { dormantDays: -5 }).dormantDays, 30, 'mergeConfigPatch(-5) 应保持当前值 30')
  assert.equal(mergeConfigPatch(cur, { dormantDays: 0 }).dormantDays, 0, 'mergeConfigPatch(0) 合法并生效')
  assert.equal(mergeConfigPatch(cur, { dormantDays: 9999 }).dormantDays, 30, 'mergeConfigPatch(9999) 越界应保持当前值 30')
  assert.equal(mergeConfigPatch(cur, { dormantDays: 'abc' }).dormantDays, 30, 'mergeConfigPatch("abc") 应保持当前值 30')
  assert.equal(mergeConfigPatch(cur, { dormantDays: Number.NaN }).dormantDays, 30, 'mergeConfigPatch(NaN) 应保持当前值 30')
  assert.equal(mergeConfigPatch(cur, { dormantDays: null }).dormantDays, 30, 'null 不得静默变 0')
  assert.equal(mergeConfigPatch(cur, { dormantDays: '' }).dormantDays, 30, '空串不得静默变 0')
  assert.equal(mergeConfigPatch(cur, { dormantDays: false }).dormantDays, 30, 'false 不得静默变 0')
  assert.equal(mergeConfigPatch(cur, { dormantDays: true }).dormantDays, 30, 'true 不得静默变 1')
  assert.equal(mergeConfigPatch({ dormantDays: 30, inflectionNotice: false }, { inflectionNotice: false }).inflectionNotice, false)
  assert.equal(mergeConfigPatch({ dormantDays: 30, inflectionNotice: true }, { inflectionNotice: 'false' }).inflectionNotice, false, '字符串 false 与前端同口径')
  assert.equal(mergeConfigPatch({ dormantDays: 30, inflectionNotice: false }, { inflectionNotice: 'yes' }).inflectionNotice, false, '非法 yes 不得翻转 false')
  assert.equal(mergeConfigPatch({ dormantDays: 30, inflectionNotice: false }, { inflectionNotice: {} }).inflectionNotice, false, '非法 {} 不得翻转 false')
  assert.equal(mergeConfigPatch(cur, { inflectionNotice: 1 }).inflectionNotice, true)

  // D. 回归锁：segment clipText 不拆断 Emoji 代理对 + 无时间戳三明治不误吸附 + Wire 幽灵句柄不占配额
  const emojiTurns = [
    { turn: 1, seq: 1, endSeq: 2, start: BASE_TIME, end: BASE_TIME + 1000, prompt: 'a'.repeat(34) + '🚀🔥🎉✨', response: 'ok', tools: ['edit'], files: ['lib/a.js'], commands: [], endReason: 'completed' },
  ]
  const emojiSegs = sliceSessionSegments(emojiTurns, { sessionId: 'ee112233-aaaa' })
  assert.equal(hasLoneSurrogate(emojiSegs[0].title), false, 'segment 标题截断不得拆断 Emoji 代理对')

  const noTsTurns = [
    { turn: 1, seq: 1, endSeq: 2, start: null, end: null, prompt: '修复 auth.js 登录超时', response: '改好了', tools: ['edit'], files: ['lib/auth.js'], commands: ['node test.js'], endReason: 'completed' },
    { turn: 2, seq: 3, endSeq: 4, start: null, end: null, prompt: '补充 auth.js 单测', response: '通过', tools: ['edit'], files: ['lib/auth.js'], commands: ['node test.js'], endReason: 'completed' },
    { turn: 3, seq: 5, endSeq: 6, start: null, end: null, prompt: '中午去哪里吃面比较好呢推荐一下附近的馆子', response: '可以去楼下兰州拉面', tools: [], files: [], commands: [], endReason: 'completed' },
    { turn: 4, seq: 7, endSeq: 8, start: null, end: null, prompt: '排查 billing.js 账单结算金额精度', response: '已改', tools: ['edit'], files: ['lib/billing.js'], commands: ['node bill.js'], endReason: 'completed' },
    { turn: 5, seq: 9, endSeq: 10, start: null, end: null, prompt: '验证 billing.js 账单对账测试', response: '绿了', tools: ['edit'], files: ['lib/billing.js'], commands: ['node bill.js'], endReason: 'completed' },
  ]
  const noTsSegs = sliceSessionSegments(noTsTurns, { sessionId: 'ff112233-aaaa' })
  assert.ok(noTsSegs.some(s => s.kindCandidate === 'chat' && s.startTurn === 3 && s.endTurn === 3), '缺失时间戳的纯闲聊单轮不应被三明治强行并入工作段')

  await withTempHome(async () => {
    const wsId = 'ws-ghost-quota'
    const st = emptyWorkStore(wsId)
    st.initializedAt = BASE_TIME
    st.works.push(createWork({
      id: 'w-real-after-ghosts',
      workspaceId: wsId,
      title: '幽灵之后的真实事',
      goal: '验证幽灵句柄不占 maxCount 配额',
      state: 'active',
      nextStep: '继续验证',
      sessionIds: ['s-real-1'],
      segmentIds: ['seg:sreal:0-0'],
    }, BASE_TIME))
    await writeWorkStore(wsId, st)
    const expanded = await expandWorkHandlesForAgent(
      { sessionQuery: { readSession: async () => ({ events: [] }) } },
      wsId,
      ['先查 〔work:w-ghost1〕 再查 〔work:w-ghost2〕 最后续接 〔work:w-real-after-ghosts〕'],
      's-new-session',
      { maxCount: 2 },
    )
    assert.ok(expanded.includes('幽灵之后的真实事'), '无效幽灵句柄不得占满 maxCount 配额导致真实事无法展开')
  })
})

// ============================================================================
// 汇总输出
// ============================================================================
console.log(`\nresilience-edge: ${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const f of failures) {
    console.error(`\n--- FAILURE: ${f.name} ---\n${f.error.stack || f.error.message}`)
  }
  process.exitCode = 1
}
