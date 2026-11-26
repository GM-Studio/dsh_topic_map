/**
 * 「分类全自动」Host 侧测试。
 *
 * 锁住产品定稿的几条硬约束：
 *   - 队列：60 秒防抖、并发 1、同 sessionId 在途去重、失败隔离；
 *   - 只归未归类；人工锁定（lockedSessions）优先于一切模型写入；
 *   - 新分类必须 ≥3 个会话支持才创建，不足时保持未归类；
 *   - 启动扫描：遍历所有工作区、按 lastActive 倒序、单次上限 60、
 *     模型未配置/开关关闭时跳过；
 *   - 每日维护：本地自然日一次，仅当未归类 >3 或候选主题 ≥3 时触发；
 *     不覆盖 source:'user'；
 *   - /category-override：source:'user' + 锁定、幂等、null 取消；
 *   - 旧 ui/workspace-category-<ws>.json 首次导入、改名 .imported、只做一次；
 *   - /categorize 保留但带 deprecated:true 并记日志。
 *
 * Run: node tests/category-auto.mjs
 */

import { strict as assert } from 'node:assert'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import {
  apply,
  applyCategorySuggestions,
  autoClassifySession,
  clearAutoClassifyDiagnostics,
  flushAutoClassify,
  getAutoClassifyDiagnostics,
  mergeConfigPatch,
  overrideCategoryAssignment,
  readCategoryIndex,
  runStartupCategoryScan,
  saveCategory,
  startCategoryAuto,
  statusCategoryAuto,
} from '../lib/index.js'
import {
  AUTO_START_MAX_SESSIONS,
  STARTUP_SCAN_LIMIT,
  STARTUP_SCAN_WORKSPACE_QUOTA,
  addAutoProcessedSessions,
  applyAutoClassification,
  applyMaintenanceSteps,
  buildMaintenancePrompt,
  configureAutoClassify,
  createAutoClassifyQueue,
  createAutoStartThrottle,
  createDailyMaintenanceGate,
  createDiagnosticsLog,
  createNewCategorySupport,
  flushAutoClassifyQueue,
  isSessionLocked,
  isSessionUnclassified,
  listCategoryPaths,
  lockSession,
  normalizeAutoClassifyState,
  normalizeLockedSessions,
  normalizeMaintenanceOps,
  planAutoSuggestion,
  planStartupScan,
  planWorkspaceFairScan,
  resolveCategoryPath,
  runStartupScan,
  shouldTriggerDailyMaintenance,
} from '../lib/category-auto.js'

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

const WS = 'ws-auto-1'
const BASE_TIME = 1_700_000_000_000

/**
 * 多工作区假 ctx：`workspaces = { 'ws-a': ['s1'], 'ws-b': [...] }`。
 *
 * 启动扫描的公平分配与游标都按工作区维度工作，需要这个形状。
 */
function makeMultiCtx(workspaces = {}, options = {}) {
  const events = options.events ?? {}
  const titles = options.titles ?? {}
  const allSessions = Object.values(workspaces).flat()
  return {
    get(name) {
      if (name === 'workspaceRegistry') {
        return {
          list: () => Object.entries(workspaces).map(([id, sessionIds]) => ({
            id,
            path: `E:\\${id}`,
            title: id,
            sessionIds,
          })),
        }
      }
      if (name === 'llm') return options.llm
      return undefined
    },
    sessionQuery: {
      async listSessions() {
        return allSessions.map(id => ({
          header: { id, createdAt: BASE_TIME, origin: 'main', delegationDepth: 0 },
        }))
      },
      async readTitleSnapshots(ids) {
        return ids.map(id => ({
          status: 'fulfilled',
          sessionId: id,
          value: { title: { title: titles[id] ?? id } },
        }))
      },
      async readSession(id) {
        return { events: events[id] ?? [] }
      },
    },
    sessionPersistence: {
      async stat() {
        return { revision: 'rev-auto-multi' }
      },
    },
  }
}

function makeCtx(options = {}) {
  const sessions = options.sessions ?? []
  const workspaceId = options.workspaceId ?? WS
  return makeMultiCtx({ [workspaceId]: sessions }, options)
}

/** 一轮完整事件（request/header 供 resolveRoute 用）。 */
function makeEvents(prompt = '分类全自动测试') {
  let seq = 0
  const push = (type, data) => ({ type, seq: seq++, time: BASE_TIME, data })
  return [
    push('request/header', { header: { config: { provider: 'agent2api', model: 'DeepSeek-Flash' } } }),
    push('turn/start', { turn: 0 }),
    push('user/message', { content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }),
    push('assistant/message', {
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '回答' }],
        source: { kind: 'model', provider: 'agent2api', model: 'DeepSeek-Flash' },
      },
    }),
    push('turn/end', { turn: 0, reason: { kind: 'completed' } }),
  ]
}

/** 假模型：记录调用；返回固定的归类 JSON。 */
function makeFakeLlm(reply) {
  const state = { calls: 0, users: [] }
  return {
    get calls() { return state.calls },
    get users() { return state.users },
    async prepareCall(call) {
      state.calls += 1
      state.users.push(String(call.messages?.[0]?.content?.[0]?.text ?? ''))
      return {
        config: { ...call },
        async *stream() {
          yield { type: 'text-delta', text: typeof reply === 'function' ? reply(call) : reply }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }
    },
    listProviders() {
      return [{ id: 'fake' }]
    },
  }
}

async function withTempHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'category-auto-'))
  const saved = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    return await fn(home)
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = saved
    await rm(home, { recursive: true, force: true })
  }
}

function storePath(home, workspaceId = WS) {
  return join(home, 'topic-map', 'categories', `${workspaceId}.json`)
}

function legacyPath(home, workspaceId = WS) {
  return join(home, 'topic-map', 'ui', `workspace-category-${workspaceId}.json`)
}

function autoStatePath(home) {
  return join(home, 'topic-map', 'auto-classify-state.json')
}

async function writeConfig(home, config) {
  await mkdir(join(home, 'topic-map'), { recursive: true })
  await writeFile(join(home, 'topic-map', 'config.json'), JSON.stringify(config, null, 2), 'utf8')
}

async function readAutoState(home) {
  return JSON.parse(await readFile(autoStatePath(home), 'utf8'))
}

async function writeRawStore(home, store, workspaceId = WS) {
  await mkdir(join(home, 'topic-map', 'categories'), { recursive: true })
  await writeFile(storePath(home, workspaceId), JSON.stringify(store, null, 2), 'utf8')
}

async function readRawStore(home, workspaceId = WS) {
  return JSON.parse(await readFile(storePath(home, workspaceId), 'utf8'))
}

function findNode(nodes, id) {
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (node.id === id) return node
    const found = findNode(node.children, id)
    if (found !== null) return found
  }
  return null
}

function baseStore(extra = {}) {
  return { version: 1, categories: [], assignments: {}, ...extra }
}

console.log('\ncategory-auto')

// ── 队列 ──────────────────────────────────────────────────────────

await test('队列：60 秒防抖默认值，重复入队重置定时器且只执行一次', async () => {
  const timers = []
  let nextId = 0
  const schedule = (fn, ms) => {
    const timer = { id: (nextId += 1), fn, ms, canceled: false }
    timers.push(timer)
    return timer
  }
  const cancel = timer => { if (timer !== null && timer !== undefined) timer.canceled = true }
  const runs = []
  const queue = createAutoClassifyQueue({
    execute: async (ctx, sessionId) => { runs.push(sessionId) },
    schedule,
    cancel,
  })
  assert.equal(queue.stats().debounceMs, 60_000, '默认防抖必须是 60 秒')

  assert.equal(queue.enqueue({}, 'sess-debounce'), true)
  assert.equal(timers.length, 1)
  assert.equal(timers[0].ms, 60_000)
  assert.equal(queue.enqueue({}, 'sess-debounce'), true)
  assert.equal(timers[0].canceled, true, '第二次入队必须取消旧定时器')
  assert.equal(timers.length, 2, '必须重新定时')
  assert.equal(queue.pendingCount(), 1, '同一会话只保留一个待执行项')

  timers[1].fn()
  await queue.flush()
  assert.deepEqual(runs, ['sess-debounce'])
})

await test('队列：并发 1（三个会话依次跑，绝不交叉）', async () => {
  let active = 0
  let maxActive = 0
  const order = []
  const queue = createAutoClassifyQueue({
    debounceMs: 0,
    execute: async (ctx, sessionId) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise(resolve => setTimeout(resolve, 5))
      order.push(sessionId)
      active -= 1
    },
  })
  for (const sessionId of ['s1', 's2', 's3']) queue.enqueue({}, sessionId)
  await queue.drain()
  assert.equal(maxActive, 1, '同一时刻只允许一个 execute 在跑')
  assert.deepEqual(order, ['s1', 's2', 's3'])
})

await test('队列：同 sessionId 在途去重（执行中再次入队直接丢弃）', async () => {
  let release = null
  const gate = new Promise(resolve => { release = resolve })
  const runs = []
  const queue = createAutoClassifyQueue({
    debounceMs: 0,
    execute: async (ctx, sessionId) => {
      runs.push(sessionId)
      await gate
    },
  })
  queue.enqueue({}, 'sess-inflight')
  const draining = queue.drain()
  await new Promise(resolve => setTimeout(resolve, 0))
  const again = queue.enqueue({}, 'sess-inflight')
  assert.equal(again, false, '在途时再次入队应返回 false')
  assert.ok(queue.stats().deduped >= 1)
  release()
  await draining
  assert.deepEqual(runs, ['sess-inflight'], '同 sessionId 在途只跑一次')
})

await test('队列：单个失败只记日志，不重试、不影响后面的会话', async () => {
  const errors = []
  const runs = []
  const queue = createAutoClassifyQueue({
    debounceMs: 0,
    execute: async (ctx, sessionId) => {
      runs.push(sessionId)
      if (sessionId === 's-bad') throw new Error('模型调用失败')
    },
    onError: (error, ctx, sessionId) => errors.push({ sessionId, message: error.message }),
  })
  queue.enqueue({}, 's-bad')
  queue.enqueue({}, 's-good')
  await queue.drain()
  assert.deepEqual(runs, ['s-bad', 's-good'], '失败不影响队列继续')
  assert.deepEqual(errors, [{ sessionId: 's-bad', message: '模型调用失败' }])
  assert.equal(queue.stats().failed, 1)
  assert.equal(queue.stats().runs, 2, '成功任务计入 runs；失败不重试')
})

// ── 只归未归类 / 锁定优先 / 新分类阈值 ────────────────────────────

await test('判定：已归类、已锁定、路径非法都跳过', () => {
  const store = baseStore({
    categories: [{ id: 'c-x', name: '已有', parentId: null, source: 'model' }],
    assignments: { 's-ok': { categoryId: 'c-x', source: 'model' } },
    lockedSessions: { 's-lock': { at: 1, by: 'user' } },
  })
  assert.equal(isSessionUnclassified(store, 's-new'), true)
  assert.equal(isSessionUnclassified(store, 's-ok'), false)
  assert.equal(planAutoSuggestion(store, 's-ok', { categoryPath: ['已有'] }).reason, 'classified')
  assert.equal(planAutoSuggestion(store, 's-lock', { categoryPath: ['已有'] }).reason, 'locked')
  assert.equal(planAutoSuggestion(store, 's-new', { categoryPath: [] }).reason, 'invalid-path')
  assert.deepEqual(planAutoSuggestion(store, 's-new', { categoryPath: ['已有'] }), {
    action: 'assign',
    categoryId: 'c-x',
    path: ['已有'],
  })
  const fresh = planAutoSuggestion(store, 's-new', { categoryPath: ['新大类', '子类'] })
  assert.equal(fresh.action, 'new')
  assert.deepEqual(fresh.missing, ['新大类', '子类'])
})

await test('新分类阈值：前 2 个会话只记账，第 3 个才创建并一起归入', () => {
  const support = createNewCategorySupport()
  let store = baseStore()
  const first = applyAutoClassification(store, 's1', { categoryPath: ['新主题', '子类'] }, support)
  assert.equal(first.action, 'pending-new')
  assert.equal(first.count, 1)
  assert.equal(first.threshold, 3)
  assert.deepEqual(first.store.categories, [])
  assert.deepEqual(first.store.assignments, {})

  store = first.store
  const second = applyAutoClassification(store, 's2', { categoryPath: ['新主题', '子类'] }, support)
  assert.equal(second.action, 'pending-new')
  assert.equal(second.count, 2)
  assert.deepEqual(second.store.categories, [])

  store = second.store
  const third = applyAutoClassification(store, 's3', { categoryPath: ['新主题', '子类'] }, support)
  assert.equal(third.action, 'created')
  assert.deepEqual(third.assigned.sort(), ['s1', 's2', 's3'])
  assert.deepEqual(third.store.categories.map(item => item.name).sort(), ['子类', '新主题'])
  for (const category of third.store.categories) assert.equal(category.source, 'model')
  for (const sessionId of ['s1', 's2', 's3']) {
    assert.equal(third.store.assignments[sessionId].source, 'model')
  }
  // 新大类 → 子类的父子关系必须正确（最多 3 级）。
  const parent = third.store.categories.find(item => item.name === '新主题')
  const child = third.store.categories.find(item => item.name === '子类')
  assert.equal(child.parentId, parent.id)
  assert.equal(support.entries().length, 0, '落地后计数必须清掉')
})

await test('新分类阈值：同一会话重复提案只算一次支持', () => {
  const support = createNewCategorySupport()
  const store = baseStore()
  const first = applyAutoClassification(store, 's1', { categoryPath: ['重复主题'] }, support)
  const again = applyAutoClassification(store, 's1', { categoryPath: ['重复主题'] }, support)
  assert.equal(first.count, 1)
  assert.equal(again.count, 1, '同 sessionId 不能把支持度刷到 2')
  assert.equal(again.action, 'pending-new')
})

await test('新分类阈值：已有分类直接归入，不走进支持度', () => {
  const store = baseStore({
    categories: [{ id: 'c-exist', name: '已有分类', parentId: null, source: 'model' }],
  })
  const result = applyAutoClassification(store, 's1', { categoryPath: ['已有分类'] }, createNewCategorySupport())
  assert.equal(result.action, 'assigned')
  assert.deepEqual(result.store.assignments.s1, { categoryId: 'c-exist', source: 'model' })
  assert.equal(result.store.categories.length, 1)
})

await test('新分类阈值：锁定会话即使凑满 3 个也不被模型写入', () => {
  const support = createNewCategorySupport()
  let store = baseStore()
  store = lockSession(store, 's-lock').store
  store = applyAutoClassification(store, 's1', { categoryPath: ['锁定主题'] }, support).store
  store = applyAutoClassification(store, 's2', { categoryPath: ['锁定主题'] }, support).store
  store = applyAutoClassification(store, 's-lock', { categoryPath: ['锁定主题'] }, support).store
  const result = applyAutoClassification(store, 's3', { categoryPath: ['锁定主题'] }, support)
  assert.equal(result.action, 'created')
  assert.deepEqual(result.assigned.sort(), ['s1', 's2', 's3'])
  assert.equal(result.store.assignments['s-lock'], undefined, '锁定会话必须保持未归类')
})

await test('路径解析：逐级复用已有父分类，只补缺的那一级', () => {
  const store = baseStore({
    categories: [{ id: 'c-parent', name: '插件开发', parentId: null, source: 'model' }],
  })
  const resolved = resolveCategoryPath(store, ['插件开发', '调试'])
  assert.equal(resolved.full, false)
  assert.equal(resolved.parentId, 'c-parent')
  assert.deepEqual(resolved.missing, ['调试'])
  assert.deepEqual(listCategoryPaths(store).map(item => item.pathText), ['插件开发'])
})

// ── 宿主自动归类执行体 ────────────────────────────────────────────

await test('执行体：已归类会话直接跳过，模型一次都不调', async () => {
  await withTempHome(async home => {
    await writeRawStore(home, baseStore({
      categories: [{ id: 'c-x', name: '已有', parentId: null, source: 'model' }],
      assignments: { 'sess-done': { categoryId: 'c-x', source: 'model' } },
    }))
    const llm = makeFakeLlm('[]')
    const ctx = makeCtx({ sessions: ['sess-done'], llm })
    const result = await autoClassifySession(ctx, 'sess-done')
    assert.equal(result.status, 'skipped')
    assert.equal(result.reason, 'classified')
    assert.equal(llm.calls, 0, '已归类会话不该浪费模型调用')
  })
})

await test('执行体：锁定会话跳过；无模型时跳过并记诊断', async () => {
  await withTempHome(async home => {
    await writeRawStore(home, baseStore({
      lockedSessions: { 'sess-lock': { at: 1, by: 'user' } },
    }))
    clearAutoClassifyDiagnostics()
    const llm = makeFakeLlm('[]')
    const locked = await autoClassifySession(makeCtx({ sessions: ['sess-lock'], llm }), 'sess-lock')
    assert.equal(locked.reason, 'locked')
    assert.equal(llm.calls, 0)

    const noModel = await autoClassifySession(makeCtx({ sessions: ['sess-nomodel'] }), 'sess-nomodel')
    assert.equal(noModel.reason, 'no-model')
    const entries = getAutoClassifyDiagnostics(20)
    const hit = entries.find(entry => entry.kind === 'auto-classify-skipped' && entry.reason === 'no-model')
    assert.ok(hit, '模型未配置必须留下诊断，而不是报错')
  })
})

await test('执行体：模型从已有分类里选 → 归类 source:model，提示词带已有路径', async () => {
  await withTempHome(async home => {
    await writeRawStore(home, baseStore({
      categories: [{ id: 'c-exist', name: '已有分类', parentId: null, source: 'model' }],
    }))
    const llm = makeFakeLlm('[{"sessionId":"sess-auto","path":["已有分类"]}]')
    const ctx = makeCtx({
      sessions: ['sess-auto'],
      events: { 'sess-auto': makeEvents('把这段会话归入已有分类') },
      llm,
    })
    const result = await autoClassifySession(ctx, 'sess-auto')
    assert.equal(result.status, 'assigned', JSON.stringify(result))
    const raw = await readRawStore(home)
    assert.deepEqual(raw.assignments['sess-auto'], { categoryId: 'c-exist', source: 'model' })
    assert.ok(llm.users[0].includes('已有分类'), '自动归类提示词必须带上现有分类路径')
  })
})

// ── 启动扫描 ──────────────────────────────────────────────────────

await test('启动扫描：按 lastActive 倒序、上限 60、剩余写进日志', async () => {
  const candidates = Array.from({ length: 70 }, (_, index) => ({
    sessionId: `s-${String(index).padStart(2, '0')}`,
    workspaceId: 'ws-scan',
    lastActive: BASE_TIME + index * 1000,
  }))
  const planned = planStartupScan(candidates)
  assert.equal(planned.selected.length, STARTUP_SCAN_LIMIT)
  assert.equal(planned.overflow, 10)
  assert.equal(planned.selected[0].sessionId, 's-69', '最新的必须排最前')
  assert.equal(planned.selected.some(item => item.sessionId === 's-09'), false, '最旧的应留给下次')
  assert.equal(planned.selected.some(item => item.sessionId === 's-10'), true)

  const enqueued = []
  const logs = []
  const result = await runStartupScan({
    enabled: true,
    isModelConfigured: () => true,
    listWorkspaces: () => [{ id: 'ws-scan' }],
    collectSessions: () => candidates,
    readStore: () => baseStore(),
    enqueue: sessionId => enqueued.push(sessionId),
    log: (message, detail) => logs.push({ message, detail }),
  })
  assert.equal(result.queued, 60)
  assert.equal(result.overflow, 10)
  assert.equal(enqueued.length, 60)
  const overflowLog = logs.find(item => item.message.includes('剩余 10 个下次启动继续'))
  assert.ok(overflowLog, '必须明确说明剩余多少、下次继续')
})

await test('启动扫描：模型未配置 → 跳过并记日志，不读取会话', async () => {
  let collected = 0
  const logs = []
  const result = await runStartupScan({
    enabled: true,
    isModelConfigured: () => false,
    listWorkspaces: () => [{ id: 'ws-scan' }],
    collectSessions: () => { collected += 1; return [] },
    readStore: () => baseStore(),
    enqueue: () => { throw new Error('不应入队') },
    log: (message, detail) => logs.push({ message, detail }),
  })
  assert.equal(result.queued, 0)
  assert.equal(result.skipped, 'no-model')
  assert.equal(collected, 0)
  assert.ok(logs.some(item => item.message.includes('模型未配置')))
})

await test('启动扫描：autoClassify:false → 直接跳过；只入队未归类且未锁定的会话', async () => {
  const disabledLogs = []
  const disabled = await runStartupScan({
    enabled: false,
    listWorkspaces: () => [{ id: 'ws-scan' }],
    log: (message, detail) => disabledLogs.push({ message, detail }),
  })
  assert.equal(disabled.queued, 0)
  assert.equal(disabled.skipped, 'disabled')
  assert.ok(disabledLogs.some(item => item.message.includes('autoClassify:false')))

  const sessions = ['s0', 's1', 's2', 's3', 's4']
  const enqueued = []
  const result = await runStartupScan({
    enabled: true,
    isModelConfigured: () => true,
    listWorkspaces: () => [{ id: 'ws-scan' }],
    collectSessions: () => sessions.map(sessionId => ({ sessionId, lastActive: BASE_TIME })),
    readStore: () => baseStore({
      categories: [{ id: 'c-x', name: '已有', parentId: null, source: 'model' }],
      assignments: { s1: { categoryId: 'c-x', source: 'model' } },
      lockedSessions: { s2: { at: 1, by: 'user' } },
    }),
    enqueue: sessionId => enqueued.push(sessionId),
    log: () => {},
  })
  assert.deepEqual(enqueued.sort(), ['s0', 's3', 's4'])
  assert.equal(result.queued, 3)
})

await test('启动扫描（Host 接线）：无模型 → 返回 no-model 并记诊断', async () => {
  await withTempHome(async () => {
    clearAutoClassifyDiagnostics()
    const result = await runStartupCategoryScan(makeCtx({ sessions: [] }))
    assert.equal(result.queued, 0)
    assert.equal(result.skipped, 'no-model')
    const entries = getAutoClassifyDiagnostics(20)
    assert.ok(entries.some(entry => entry.kind === 'startup-scan' && entry.skipped === 'no-model'))
  })
})

// ── 启动扫描：工作区公平分配 / 游标 ──────────────────────────────

/** 造一个工作区分组：`count` 个会话，lastActive 依次递增。 */
function makeScanGroup(workspaceId, count, base = BASE_TIME) {
  return {
    workspaceId,
    sessions: Array.from({ length: count }, (_, index) => ({
      sessionId: `${workspaceId}-s${String(index).padStart(2, '0')}`,
      lastActive: base + index * 1000,
    })),
  }
}

await test('公平分配：4 个工作区各 4 个会话、上限 10 → 每区都拿到名额', () => {
  const groups = ['ws-a', 'ws-b', 'ws-c', 'ws-d'].map(id => makeScanGroup(id, 4))
  const planned = planWorkspaceFairScan(groups, { limit: 10, workspaceQuota: STARTUP_SCAN_WORKSPACE_QUOTA })
  assert.equal(planned.selected.length, 10)
  assert.equal(planned.total, 16)
  assert.equal(planned.overflow, 6)
  const counts = Object.fromEntries(planned.allocation.map(item => [item.workspaceId, item.count]))
  assert.deepEqual(counts, { 'ws-a': 3, 'ws-b': 3, 'ws-c': 2, 'ws-d': 2 })
  for (const item of planned.allocation) {
    assert.ok(item.count > 0, `工作区 ${item.workspaceId} 不应被饿死`)
  }
  // 区内仍按 lastActive 倒序（最新在前）。
  const aSelected = planned.selected.filter(item => item.workspaceId === 'ws-a').map(item => item.sessionId)
  assert.deepEqual(aSelected, ['ws-a-s03', 'ws-a-s02', 'ws-a-s01'])
})

await test('公平分配：大工作区 44 个也吃不光名额，小工作区全部轮到', () => {
  const groups = [
    makeScanGroup('ws-big', 44, BASE_TIME + 1_000_000),
    makeScanGroup('ws-small-1', 4),
    makeScanGroup('ws-small-2', 6),
    makeScanGroup('ws-small-3', 7),
    makeScanGroup('ws-small-4', 3),
  ]
  const planned = planWorkspaceFairScan(groups, { limit: 60, workspaceQuota: 10 })
  assert.equal(planned.selected.length, 60)
  assert.equal(planned.overflow, 4)
  const byWorkspace = new Map()
  for (const item of planned.selected) {
    byWorkspace.set(item.workspaceId, (byWorkspace.get(item.workspaceId) ?? 0) + 1)
  }
  // 4 个小工作区（共 20 个）必须一个不少地进入本轮。
  assert.equal(byWorkspace.get('ws-small-1'), 4)
  assert.equal(byWorkspace.get('ws-small-2'), 6)
  assert.equal(byWorkspace.get('ws-small-3'), 7)
  assert.equal(byWorkspace.get('ws-small-4'), 3)
  assert.equal(byWorkspace.get('ws-big'), 40)
})

await test('启动扫描游标：已处理的跳过，新会话优先', async () => {
  const sessions = {
    wa: ['wa-p1', 'wa-p2', 'wa-n1', 'wa-n2'],
    wb: ['wb-p1', 'wb-n1'],
  }
  /** p1/p2 是上次已处理；n* 是从没处理过的（其中 n 的 lastActive 更旧）。 */
  const processed = new Set(['wa-p1', 'wa-p2', 'wb-p1'])
  const enqueued = []
  const deps = {
    enabled: true,
    isModelConfigured: () => true,
    listWorkspaces: () => [{ id: 'wa' }, { id: 'wb' }],
    collectSessions: workspaceId => sessions[workspaceId].map((sessionId, index) => ({
      sessionId,
      lastActive: BASE_TIME - index * 1000,
    })),
    readStore: () => baseStore(),
    isProcessed: sessionId => processed.has(sessionId),
    enqueue: sessionId => { enqueued.push(sessionId) },
    log: () => {},
    limit: 60,
  }
  const first = await runStartupScan(deps)
  assert.deepEqual(enqueued.sort(), ['wa-n1', 'wa-n2', 'wb-n1'])
  assert.equal(first.queued, 3)
  assert.equal(enqueued.includes('wa-p1'), false, '已处理的会话不能再入队')
  for (const sessionId of enqueued) processed.add(sessionId)

  // 第二次启动：旧会话全部跳过；新增一个会话仍能被扫到。
  sessions.wa.push('wa-n3')
  enqueued.length = 0
  const second = await runStartupScan(deps)
  assert.deepEqual(enqueued, ['wa-n3'])
  assert.equal(second.queued, 1)
  enqueued.forEach(sessionId => processed.add(sessionId))

  enqueued.length = 0
  const third = await runStartupScan(deps)
  assert.equal(third.queued, 0, '全部处理过之后本轮应收敛为 0')
})

await test('游标状态：形状固定、坏条目丢弃、按时间裁剪', () => {
  assert.deepEqual(normalizeAutoClassifyState(null), { lastRunAt: null, processed: {} })
  assert.deepEqual(normalizeAutoClassifyState({ lastRunAt: 5, processed: { a: 1, b: 'x', '': 2 } }), {
    lastRunAt: 5,
    processed: { a: 1 },
  })
  const next = addAutoProcessedSessions(
    { lastRunAt: 1, processed: { old: 1 } },
    ['a', 'b', { sessionId: 'c' }, { sessionId: '' }, ''],
    { at: 100, max: 2 },
  )
  assert.equal(next.lastRunAt, 100)
  assert.deepEqual(Object.keys(next.processed).sort(), ['a', 'b'])
  assert.equal(next.processed.old, undefined, '超过上限时最旧的应被裁掉')
  for (const value of Object.values(next.processed)) assert.equal(value, 100)
})

await test('按需触发节流：同工作区 10 分钟一次，不同工作区互不影响', () => {
  let now = 1_000_000
  const throttle = createAutoStartThrottle({ windowMs: 10 * 60 * 1000, now: () => now })
  assert.deepEqual(throttle.claim('ws-1'), { allowed: true })
  const blocked = throttle.claim('ws-1')
  assert.equal(blocked.allowed, false)
  assert.equal(blocked.retryAfterMs, 10 * 60 * 1000)
  assert.deepEqual(throttle.claim('ws-2'), { allowed: true }, '另一个工作区不受影响')
  now += 9 * 60 * 1000
  assert.equal(throttle.claim('ws-1').allowed, false)
  now += 1 * 60 * 1000
  assert.deepEqual(throttle.claim('ws-1'), { allowed: true })
})

await test('队列 enqueueNow：跳过 60 秒防抖立即执行；pending 项被提升', async () => {
  const timers = []
  const runs = []
  let nextId = 0
  const schedule = (fn, ms) => {
    const timer = { id: (nextId += 1), fn, ms, canceled: false }
    timers.push(timer)
    return timer
  }
  const cancel = timer => { if (timer !== null && timer !== undefined) timer.canceled = true }
  const queue = createAutoClassifyQueue({
    debounceMs: 60_000,
    schedule,
    cancel,
    execute: async (ctx, sessionId) => { runs.push(sessionId) },
  })
  queue.enqueue({}, 's-promote')
  assert.equal(queue.pendingCount(), 1)
  assert.equal(queue.enqueueNow({}, 's-promote'), true)
  assert.equal(timers[0].canceled, true, '提升时必须取消原防抖定时器')
  await queue.flush()
  assert.deepEqual(runs, ['s-promote'])
  assert.equal(queue.stats().promoted, 1)

  queue.enqueueNow({}, 's-now')
  await queue.flush()
  assert.deepEqual(runs, ['s-promote', 's-now'], '新会话不需要等定时器')
})

await test('启动扫描游标落盘：写 auto-classify-state.json，下次启动跳过', async () => {
  await withTempHome(async home => {
    const workspaceId = 'ws-auto-state'
    const sessionIds = ['state-1', 'state-2', 'state-3']
    const events = Object.fromEntries(sessionIds.map(id => [id, makeEvents()]))
    const ctx = makeMultiCtx({ [workspaceId]: sessionIds }, { events })
    await writeConfig(home, { provider: 'agent2api', model: 'DeepSeek-Flash' })
    const queue = configureAutoClassify({ execute: async () => {}, debounceMs: 60_000 })
    try {
      const first = await runStartupCategoryScan(ctx)
      assert.equal(first.queued, 3, JSON.stringify(first))
      const state = await readAutoState(home)
      assert.deepEqual(Object.keys(state).sort(), ['lastRunAt', 'processed'])
      assert.ok(Number.isFinite(state.lastRunAt) && state.lastRunAt > 0)
      assert.deepEqual(Object.keys(state.processed).sort(), sessionIds)

      const second = await runStartupCategoryScan(ctx)
      assert.equal(second.queued, 0, '已写进游标的会话不能再入队')
      const after = await readAutoState(home)
      assert.deepEqual(Object.keys(after.processed).sort(), sessionIds)
    } finally {
      queue.dispose()
    }
  })
})


await test('每日维护触发：未归类 >3 或候选主题 ≥3', () => {
  assert.equal(shouldTriggerDailyMaintenance({ unclassifiedCount: 0, themeSizes: [] }), false)
  assert.equal(shouldTriggerDailyMaintenance({ unclassifiedCount: 3, themeSizes: [] }), false)
  assert.equal(shouldTriggerDailyMaintenance({ unclassifiedCount: 4, themeSizes: [] }), true)
  assert.equal(shouldTriggerDailyMaintenance({ unclassifiedCount: 0, themeSizes: [2] }), false)
  assert.equal(shouldTriggerDailyMaintenance({ unclassifiedCount: 0, themeSizes: [2, 3] }), true)
  assert.equal(shouldTriggerDailyMaintenance({}), false)
})

await test('每日维护闸门：同一自然日只跑一次，跨天恢复', () => {
  let now = new Date(2026, 0, 5, 9, 0, 0).getTime()
  const gate = createDailyMaintenanceGate({ now: () => now })
  const input = { unclassifiedCount: 5, themeSizes: [] }
  assert.deepEqual(gate.claim(WS, input).run, true)
  assert.deepEqual(gate.claim(WS, input), {
    run: false,
    day: '2026-01-05',
    reason: 'already-ran',
  })
  now = new Date(2026, 0, 6, 0, 5, 0).getTime()
  assert.deepEqual(gate.claim(WS, input).run, true)
})

await test('每日维护闸门：条件不足不占当天名额，条件满足仍可触发', () => {
  const now = new Date(2026, 1, 1, 12, 0, 0).getTime()
  const gate = createDailyMaintenanceGate({ now: () => now })
  const idle = gate.claim(WS, { unclassifiedCount: 1, themeSizes: [1] })
  assert.equal(idle.run, false)
  assert.equal(idle.reason, 'below-threshold')
  assert.equal(gate.claim(WS, { unclassifiedCount: 4, themeSizes: [] }).run, true)
})

await test('每日维护：不覆盖 source:user，锁定会话不参与拆分', () => {
  const store = baseStore({
    categories: [
      { id: 'c-a', name: '模型甲', parentId: null, source: 'model' },
      { id: 'c-b', name: '模型乙', parentId: null, source: 'model' },
      { id: 'c-user', name: '人工分类', parentId: null, source: 'user' },
    ],
    assignments: {
      s1: { categoryId: 'c-a', source: 'model' },
      s2: { categoryId: 'c-a', source: 'model' },
      s3: { categoryId: 'c-a', source: 'user' },
      s4: { categoryId: 'c-a', source: 'model' },
    },
    lockedSessions: { s4: { at: 1, by: 'user' } },
  })
  const normalized = normalizeMaintenanceOps(store, {
    merge: [
      { ids: ['c-a', 'c-b'], name: '合并名' },
      { ids: ['c-a', 'c-user'], name: '不该合并' },
      { ids: ['c-a'], name: '不够两个' },
    ],
    rename: [
      { id: 'c-user', name: '不该改名' },
      { id: 'c-b', name: '模型乙新名' },
    ],
    split: [
      { id: 'c-a', name: '子类甲', sessions: ['s1', 's2', 's3', 's4'] },
      { id: 'c-user', name: '不该拆分', sessions: ['s1'] },
    ],
  })
  assert.deepEqual(normalized.steps.map(step => step.kind), ['merge', 'rename', 'split-new'])
  assert.deepEqual(normalized.steps[0].ids, ['c-a', 'c-b'])
  assert.deepEqual(normalized.steps[2].sessions, ['s1', 's2'], 'user 归类与锁定会话都不能被拆走')
  assert.ok(normalized.skipped.some(item => item.reason === '人工分类不参与合并'))
  assert.ok(normalized.skipped.some(item => item.reason === '人工分类不改名'))
  assert.ok(normalized.skipped.some(item => item.reason === '人工分类不拆分'))
})

await test('每日维护提示词：过大会话组会带上具体 sessionId，小分类不列', () => {
  const store = baseStore({
    categories: [
      { id: 'c-big', name: '大组', parentId: null, source: 'model' },
      { id: 'c-small', name: '小组', parentId: null, source: 'model' },
    ],
    assignments: {},
  })
  for (let index = 0; index < 7; index += 1) {
    store.assignments[`big-${index}`] = { categoryId: 'c-big', source: 'model' }
  }
  store.assignments['small-0'] = { categoryId: 'c-small', source: 'model' }
  const prompt = buildMaintenancePrompt(store, [{ sessionId: 'un-1', title: '未归类' }])
  assert.ok(prompt.user.includes('big-0'), '过大会话组必须列出会话 id，模型才拆得动')
  assert.ok(prompt.user.includes('未归类'))
  assert.equal(prompt.user.includes('small-0'), false, '小分类不必占用提示词预算')
  assert.ok(prompt.system.includes('sessions'), '系统提示要说明 split.sessions 的规则')
})

await test('每日维护执行：合并 + 拆分只走 plan/apply，人工分类原地不动', () => {
  const store = baseStore({
    categories: [
      { id: 'c-a', name: '近义甲', parentId: null, source: 'model' },
      { id: 'c-b', name: '近义乙', parentId: null, source: 'model' },
      { id: 'c-user', name: '人工分类', parentId: null, source: 'user' },
    ],
    assignments: {
      s1: { categoryId: 'c-a', source: 'model' },
      s2: { categoryId: 'c-a', source: 'model' },
      s3: { categoryId: 'c-b', source: 'model' },
      s4: { categoryId: 'c-user', source: 'user' },
    },
  })
  const applied = applyMaintenanceSteps(store, [
    { kind: 'merge', ids: ['c-a', 'c-b'], name: '近义合并' },
    { kind: 'rename', id: 'c-user', name: '人工改名' },
    { kind: 'split-new', id: 'c-a', name: '子类新', sessions: ['s1', 's2'] },
  ])
  assert.equal(applied.applied.length, 2, '合并与拆分成功；人工分类改名被跳过')
  assert.equal(applied.skipped.length, 1)
  const user = applied.store.categories.find(item => item.id === 'c-user')
  assert.equal(user.name, '人工分类', '人工分类名不能被改')
  const merged = applied.store.categories.find(item => item.id === 'c-a')
  assert.equal(merged.name, '近义合并')
  const child = applied.store.categories.find(item => item.name === '子类新')
  assert.ok(child, '拆分应创建新子类')
  assert.equal(child.parentId, 'c-a')
  assert.equal(child.source, 'model')
  assert.equal(applied.store.assignments.s1.categoryId, child.id)
  assert.equal(applied.store.assignments.s2.categoryId, child.id)
  assert.equal(applied.store.assignments.s4.categoryId, 'c-user')
})

// ── 纠错接口 ──────────────────────────────────────────────────────

await test('/category-override：写 source:user + lockedSessions，幂等', async () => {
  await withTempHome(async () => {
    const ctx = makeCtx({ sessions: ['sess-1'] })
    const category = await saveCategory(ctx, { workspaceId: WS, name: '目标分类' })
    const first = await overrideCategoryAssignment(ctx, {
      workspaceId: WS,
      sessionId: 'sess-1',
      categoryId: category.value.id,
    })
    assert.equal(first.ok, true, first.error)
    assert.equal(first.value.locked, true)
    assert.deepEqual(first.value.store.assignments['sess-1'], {
      categoryId: category.value.id,
      source: 'user',
    })
    const lock = first.value.store.lockedSessions['sess-1']
    assert.equal(lock.by, 'user')
    assert.ok(Number.isFinite(lock.at))
    assert.equal(findNode(first.value.tree, category.value.id).count, 1)

    const second = await overrideCategoryAssignment(ctx, {
      workspaceId: WS,
      sessionId: 'sess-1',
      categoryId: category.value.id,
    })
    assert.equal(second.ok, true, second.error)
    assert.deepEqual(second.value.store, first.value.store, '重复调用必须得到完全相同的结果')
    assert.deepEqual(second.value.tree, first.value.tree)
  })
})

await test('/category-override：categoryId:null 取消归类但保持锁定；参数错误 400', async () => {
  await withTempHome(async home => {
    const ctx = makeCtx({ sessions: ['sess-2'] })
    const category = await saveCategory(ctx, { workspaceId: WS, name: '先归类' })
    await overrideCategoryAssignment(ctx, { workspaceId: WS, sessionId: 'sess-2', categoryId: category.value.id })
    const cleared = await overrideCategoryAssignment(ctx, {
      workspaceId: WS,
      sessionId: 'sess-2',
      categoryId: null,
    })
    assert.equal(cleared.ok, true, cleared.error)
    assert.equal(cleared.value.store.assignments['sess-2'], undefined)
    assert.equal(cleared.value.store.lockedSessions['sess-2'].by, 'user')

    const raw = await readRawStore(home)
    assert.equal(raw.lockedSessions['sess-2'].by, 'user', '锁定表必须落盘')

    const missingSession = await overrideCategoryAssignment(ctx, { workspaceId: WS, categoryId: null })
    assert.equal(missingSession.ok, false)
    assert.equal(missingSession.httpStatus, 400)
    const missingCategory = await overrideCategoryAssignment(ctx, { workspaceId: WS, sessionId: 'sess-2' })
    assert.equal(missingCategory.ok, false)
    assert.equal(missingCategory.httpStatus, 400)
    const badCategory = await overrideCategoryAssignment(ctx, {
      workspaceId: WS,
      sessionId: 'sess-2',
      categoryId: 'c-missing',
    })
    assert.equal(badCategory.ok, false)
    assert.equal(badCategory.httpStatus, 400)
  })
})

await test('锁定会话：模型建议应用直接跳过，手动保存分类不丢 lockedSessions', async () => {
  await withTempHome(async () => {
    const ctx = makeCtx({ sessions: ['sess-lock'] })
    const category = await saveCategory(ctx, { workspaceId: WS, name: '目标' })
    await overrideCategoryAssignment(ctx, {
      workspaceId: WS,
      sessionId: 'sess-lock',
      categoryId: category.value.id,
    })
    await overrideCategoryAssignment(ctx, {
      workspaceId: WS,
      sessionId: 'sess-lock',
      categoryId: null,
    })

    const applied = await applyCategorySuggestions(ctx, {
      workspaceId: WS,
      suggestions: [{ sessionId: 'sess-lock', categoryPath: ['模型想归类'] }],
    })
    assert.equal(applied.ok, true, applied.error)
    assert.equal(applied.value.applied, 0)
    assert.equal(applied.value.skipped, 1)
    assert.equal(applied.value.store.assignments['sess-lock'], undefined, '锁定会话保持未归类')

    // 再走一次人工保存，锁定表不能被 category-store 的归一化吞掉。
    const saved = await saveCategory(ctx, { workspaceId: WS, name: '后来新建' })
    assert.equal(saved.ok, true, saved.error)
    assert.equal(saved.value.lockedSessions['sess-lock'].by, 'user')
  })
})

// ── 旧系统下线 ────────────────────────────────────────────────────

await test('旧分类导入：同名合并、source:model、只填空、改名 .imported、只做一次', async () => {
  await withTempHome(async home => {
    // 独立工作区：导入标记是进程级"首次访问"语义，不能复用别的用例碰过的 id。
    const ws = 'ws-auto-legacy'
    const legacy = {
      sessionIds: ['sess-import', 'sess-manual', 'sess-locked'],
      tree: [{
        name: '旧大类',
        count: 3,
        subcategories: [{
          name: '旧子类',
          sessions: [
            { sessionId: 'sess-import' },
            { sessionId: 'sess-manual' },
            { sessionId: 'sess-locked' },
          ],
        }],
      }],
    }
    await mkdir(join(home, 'topic-map', 'ui'), { recursive: true })
    await writeFile(legacyPath(home, ws), JSON.stringify(legacy, null, 2), 'utf8')
    await writeRawStore(home, baseStore({
      categories: [{ id: 'c-manual', name: '人工类', parentId: null, source: 'user' }],
      assignments: { 'sess-manual': { categoryId: 'c-manual', source: 'user' } },
      lockedSessions: { 'sess-locked': { at: 123, by: 'user' } },
    }), ws)

    const ctx = makeCtx({ sessions: [], workspaceId: ws })
    const read = await readCategoryIndex(ctx, { workspaceId: ws })
    assert.equal(read.ok, true, read.error)
    const names = read.value.categories.map(item => item.name).sort()
    assert.deepEqual(names, ['人工类', '旧大类', '旧子类'])
    for (const category of read.value.categories) {
      if (category.name === '人工类') continue
      assert.equal(category.source, 'model', '导入的分类必须是 model 来源')
    }
    const parent = read.value.categories.find(item => item.name === '旧大类')
    const child = read.value.categories.find(item => item.name === '旧子类')
    assert.equal(child.parentId, parent.id)
    assert.deepEqual(read.value.assignments['sess-import'], { categoryId: child.id, source: 'model' })
    assert.deepEqual(read.value.assignments['sess-manual'], { categoryId: 'c-manual', source: 'user' })
    assert.equal(read.value.assignments['sess-locked'], undefined, '锁定会话不能被导入覆盖')
    assert.equal(read.value.lockedSessions['sess-locked'].at, 123, '锁定表必须保留')

    assert.equal(existsSync(legacyPath(home, ws)), false, '导入后旧文件必须被改名')
    assert.equal(existsSync(`${legacyPath(home, ws)}.imported`), true)

    // 旧文件被重新放回来也不该再导一次（.imported 是只做一次的标记）。
    await writeFile(legacyPath(home, ws), JSON.stringify({
      tree: [{ name: '第二次导入', subcategories: [] }],
    }), 'utf8')
    const again = await readCategoryIndex(ctx, { workspaceId: ws })
    assert.equal(again.value.categories.length, 3, '不能重复导入')
    assert.equal(again.value.categories.some(item => item.name === '第二次导入'), false)
  })
})

await test('旧分类导入：文件损坏只记日志，不阻断 /categories', async () => {
  await withTempHome(async home => {
    const ws = 'ws-auto-legacy-bad'
    await mkdir(join(home, 'topic-map', 'ui'), { recursive: true })
    await writeFile(legacyPath(home, ws), '{broken', 'utf8')
    clearAutoClassifyDiagnostics()
    const read = await readCategoryIndex(makeCtx({ sessions: [], workspaceId: ws }), { workspaceId: ws })
    assert.equal(read.ok, true, read.error)
    assert.deepEqual(read.value.categories, [])
    const entries = getAutoClassifyDiagnostics(20)
    assert.ok(entries.some(entry => entry.kind === 'legacy-import-failed'))
  })
})

// ── HTTP 接线：override 与 deprecated ─────────────────────────────

function registerHandler(workspaces = { [WS]: [] }, options = {}) {
  const registered = []
  const webScope = {
    get(name) {
      if (name !== 'webServer') return undefined
      return {
        register(config) {
          registered.push(config)
          return () => {}
        },
      }
    },
    effect(fn) { fn() },
  }
  const base = makeMultiCtx(workspaces, options)
  const ctx = {
    ...base,
    inject(names, callback) {
      if (names.includes('webServer')) callback(webScope)
    },
    effect(fn) { fn() },
  }
  apply(ctx)
  assert.equal(registered.length, 1, 'apply 应注册一个前缀路由')
  return registered[0].handler
}

async function callRoute(handler, action, body) {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  const req = Readable.from(payload)
  req.url = `/api/topic-map/${action}`
  req.method = 'POST'
  let status = 0
  let text = ''
  const res = {
    writeHead(code) { status = code },
    end(value) { text = value },
  }
  await handler(req, res)
  return { status, body: text === '' ? null : JSON.parse(text) }
}

await test('/category-override 已接线：200 + {store,tree,locked:true}', async () => {
  await withTempHome(async () => {
    const handler = registerHandler()
    const category = await callRoute(handler, 'category-save', { workspaceId: WS, name: '路由目标' })
    assert.equal(category.status, 200)
    const result = await callRoute(handler, 'category-override', {
      workspaceId: WS,
      sessionId: 'sess-route',
      categoryId: category.body.value.id,
    })
    assert.equal(result.status, 200)
    assert.equal(result.body.ok, true)
    assert.equal(result.body.value.locked, true)
    assert.equal(result.body.value.store.lockedSessions['sess-route'].by, 'user')
    assert.equal(findNode(result.body.value.tree, category.body.value.id).count, 1)

    const bad = await callRoute(handler, 'category-override', { workspaceId: WS, sessionId: 42 })
    assert.equal(bad.status, 400)
  })
})

await test('/categorize：保留但带 deprecated:true，并记一条诊断日志', async () => {
  await withTempHome(async () => {
    clearAutoClassifyDiagnostics()
    const handler = registerHandler()
    const result = await callRoute(handler, 'categorize', { workspaceId: WS })
    assert.equal(result.status, 200)
    assert.equal(result.body.ok, true)
    assert.equal(result.body.value.deprecated, true, '旧端点必须显式标 deprecated')
    const entries = getAutoClassifyDiagnostics(20)
    assert.ok(entries.some(entry => entry.kind === 'deprecated-endpoint'))
  })
})

// ── 按需触发 / 状态端点 ──────────────────────────────────────────

await test('/category-auto-start：立即入队未归类会话（≤20），10 分钟内再触发被节流', async () => {
  await withTempHome(async () => {
    const workspaceId = 'ws-auto-start'
    const sessions = Array.from({ length: 25 }, (_, index) => `start-${index}`)
    const events = Object.fromEntries(sessions.map(id => [id, makeEvents()]))
    const ctx = makeMultiCtx({ [workspaceId]: sessions }, { events })
    const queue = configureAutoClassify({ execute: async () => {}, debounceMs: 60_000 })
    try {
      const first = await startCategoryAuto(ctx, { workspaceId })
      assert.equal(first.ok, true, first.error)
      assert.equal(first.value.queued, AUTO_START_MAX_SESSIONS, '单次最多入队 20 个')
      const second = await startCategoryAuto(ctx, { workspaceId })
      assert.equal(second.ok, true, second.error)
      assert.equal(second.value.throttled, true)
      assert.equal(second.value.queued, 0)
      assert.ok(second.value.retryAfterMs > 0 && second.value.retryAfterMs <= 10 * 60 * 1000)
    } finally {
      queue.dispose()
    }
  })
})

await test('/category-auto-status：categories / unclassified / running / lastRunAt / no-model', async () => {
  await withTempHome(async home => {
    const workspaceId = 'ws-auto-status'
    const sessions = Array.from({ length: 25 }, (_, index) => `status-${index}`)
    const events = Object.fromEntries(sessions.map(id => [id, makeEvents()]))
    const ctx = makeMultiCtx({ [workspaceId]: sessions }, { events })
    await writeRawStore(home, {
      version: 1,
      categories: [
        { id: 'c-1', name: '甲', parentId: null, source: 'model' },
        { id: 'c-2', name: '乙', parentId: null, source: 'model' },
      ],
      assignments: Object.fromEntries(sessions.slice(0, 20).map((sessionId, index) => [
        sessionId,
        { categoryId: index % 2 === 0 ? 'c-1' : 'c-2', source: 'model' },
      ])),
    }, workspaceId)
    await mkdir(join(home, 'topic-map'), { recursive: true })
    await writeFile(autoStatePath(home), JSON.stringify({
      lastRunAt: 123456789,
      processed: { 'status-0': 111 },
    }), 'utf8')

    const idle = await statusCategoryAuto(ctx, { workspaceId })
    assert.equal(idle.ok, true, idle.error)
    assert.deepEqual(idle.value, {
      categories: 2,
      unclassified: 5,
      running: false,
      queued: 0,
      lastRunAt: 123456789,
      model: 'no-model',
    })

    // 配好模型后状态应变成 ready。
    await writeConfig(home, { provider: 'agent2api', model: 'DeepSeek-Flash' })
    const ready = await statusCategoryAuto(ctx, { workspaceId })
    assert.equal(ready.value.model, 'ready')

    // 用一个阻塞队列验证「正在归类」状态。
    let released = false
    const waiters = []
    const queue = configureAutoClassify({
      debounceMs: 60_000,
      execute: () => (released
        ? Promise.resolve()
        : new Promise(resolve => { waiters.push(resolve) })),
    })
    try {
      const started = await startCategoryAuto(ctx, { workspaceId })
      assert.equal(started.ok, true, started.error)
      assert.equal(started.value.queued, 5)
      const running = await statusCategoryAuto(ctx, { workspaceId })
      assert.equal(running.value.running, true)
      assert.equal(running.value.queued, 5)
      assert.equal(running.value.lastRunAt, 123456789, '按需触发不写启动扫描游标')
    } finally {
      released = true
      for (const resolve of waiters.splice(0)) resolve()
      await flushAutoClassifyQueue()
      queue.dispose()
    }
  })
})

await test('/category-auto-start 与 /category-auto-status 已接线', async () => {
  await withTempHome(async () => {
    const workspaceId = 'ws-auto-route'
    const sessions = ['route-auto-1', 'route-auto-2']
    const events = Object.fromEntries(sessions.map(id => [id, makeEvents()]))
    const handler = registerHandler({ [workspaceId]: sessions }, { events })

    const statusBefore = await callRoute(handler, 'category-auto-status', { workspaceId })
    assert.equal(statusBefore.status, 200, JSON.stringify(statusBefore.body))
    assert.equal(statusBefore.body.ok, true)
    assert.equal(statusBefore.body.value.unclassified, 2)
    assert.equal(statusBefore.body.value.model, 'no-model')
    assert.equal(statusBefore.body.value.running, false)

    const started = await callRoute(handler, 'category-auto-start', { workspaceId })
    assert.equal(started.status, 200, JSON.stringify(started.body))
    assert.equal(started.body.ok, true)
    assert.equal(started.body.value.queued, 2)

    const statusAfter = await callRoute(handler, 'category-auto-status', { workspaceId })
    assert.equal(statusAfter.status, 200)
    assert.equal(typeof statusAfter.body.value.queued, 'number')
    await flushAutoClassify()
  })
})

// ── 纯工具 ────────────────────────────────────────────────────────

await test('锁定表归一：旧 store 没字段 → {}；形状固定 {at,by:"user"}', () => {
  assert.deepEqual(normalizeLockedSessions(undefined), {})
  assert.deepEqual(normalizeLockedSessions({ a: { at: 5, by: 'model' }, '': {} }), {
    a: { at: 5, by: 'user' },
  })
  const store = lockSession(baseStore(), 's1', { at: 42 }).store
  assert.deepEqual(store.lockedSessions, { s1: { at: 42, by: 'user' } })
  assert.equal(isSessionLocked(store, 's1'), true)
  assert.equal(isSessionLocked(store, 's2'), false)
  const again = lockSession(store, 's1', { at: 999 }).store
  assert.equal(again.lockedSessions.s1.at, 42, '已锁定必须保留原 at（幂等）')
})

await test('配置：autoClassify:false 关闭自动归类，旧配置不凭空多键', () => {
  const oldConfig = { provider: 'p', model: 'm' }
  const merged = mergeConfigPatch(oldConfig, {})
  assert.equal('autoClassify' in merged, false, '旧配置里没这键时不应凭空新增')
  assert.equal(merged.provider, 'p')
  assert.equal(mergeConfigPatch(oldConfig, { autoClassify: false }).autoClassify, false)
  assert.equal(mergeConfigPatch({ ...oldConfig, autoClassify: true }, { digestLevel: 'rich' }).autoClassify, true)
  assert.equal(mergeConfigPatch({ ...oldConfig, autoClassify: true }, { autoClassify: 'yes' }).autoClassify, true,
    '非法布尔值回落当前值，而不是悄悄打开/关闭')
})

await test('诊断日志：有界、最新在前、可清空', () => {
  const log = createDiagnosticsLog({ limit: 3 })
  for (let index = 0; index < 5; index += 1) log.record({ kind: 'k', index })
  const entries = log.list(10)
  assert.equal(entries.length, 3)
  assert.equal(entries[0].index, 4)
  assert.equal(entries[2].index, 2)
  log.clear()
  assert.deepEqual(log.list(10), [])
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const failure of failures) console.error(`\n${failure.name}\n${failure.error.stack}`)
  process.exit(1)
}
