/**
 * 「事（Work）」核心域模型、状态机、决策、沉降、拐点与双表分离的测试。
 *
 * 遵循 GLOSSARY.md 与 ADR 0001 / 0002 / 0003：
 * - 纯函数、无 I/O、不读时钟、不改入参；
 * - 双态可信度（inferred / confirmed）与锁定不可覆盖铁律；
 * - 决策一等但按需累积，支持 supersede 演化；
 * - 话题 ↔ 事 互转与防重提（dismissedSegments）；
 * - 合并 / 拆段后锁定归属；
 * - 沉降仅影响推测态未收束且未置顶的事，重聊自动浮回；
 * - 三类自然拐点识别；
 * - 360px 窄抽屉 4 行卡片投影。
 *
 * Run: node tests/work-model.mjs
 */

import { strict as assert } from 'node:assert'
import {
  WORK_STATES,
  UNRESOLVED_STATES,
  WORK_CONFIDENCE,
  DEFAULT_DORMANT_DAYS,
  emptyWorkStore,
  createWork,
  addDecision,
  supersedeDecision,
  activeDecisions,
  supersededDecisions,
  applyUserConfirm,
  applyInferredUpdate,
  convertChatSegmentToWork,
  dismissWorkAsChat,
  mergeWorks,
  splitSegmentFromWork,
  applyDormancySettlement,
  wakeWorkOnActivity,
  detectInflection,
  projectResumeCards,
} from '../lib/work-model.js'

let passed = 0
const failures = []
function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (e) {
    failures.push({ name, error: e })
    console.log(`  FAIL ${name}\n       ${String(e.message).split('\n').join('\n       ')}`)
  }
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value)) deepFreeze(value[key])
  }
  return value
}

const DAY = 24 * 60 * 60 * 1000
const HOUR = 60 * 60 * 1000
const T0 = Date.UTC(2026, 10, 1, 10, 0, 0)

function sampleSegment(overrides = {}) {
  return {
    id: 'seg-1',
    sessionId: 'session-a1b2c3d4-0001',
    title: '修复登录鉴权超时',
    summary: '排查 token 刷新竞态并补单测',
    turnRange: [1, 6],
    files: ['src/auth.js', 'tests/auth.mjs'],
    changedFiles: ['src/auth.js'],
    evidenceHandles: ['〔a1b2c3d4#1〕', '〔a1b2c3d4#6〕'],
    startedAt: T0,
    endedAt: T0 + 15 * 60 * 1000,
    lastActivityAt: T0 + 15 * 60 * 1000,
    ...overrides,
  }
}

function makeStoreWithWorks(works, segments = {}, extra = {}) {
  return {
    ...emptyWorkStore('ws-1'),
    works,
    segments,
    ...extra,
  }
}

console.log('\nwork-model')

// ── 常量与空 store ──────────────────────────────────────────────────

test('状态与可信度枚举符合 GLOSSARY 与 ADR-0003', () => {
  assert.deepEqual(WORK_STATES, ['active', 'blocked', 'done', 'shelved'])
  assert.deepEqual(UNRESOLVED_STATES, ['active', 'blocked'])
  assert.deepEqual(WORK_CONFIDENCE, ['inferred', 'confirmed'])
  assert.equal(DEFAULT_DORMANT_DAYS, 14)
})

test('emptyWorkStore 返回标准结构且每次返回全新对象', () => {
  const a = emptyWorkStore('ws-alpha')
  const b = emptyWorkStore('ws-alpha')
  assert.deepEqual(a, {
    version: 1,
    workspaceId: 'ws-alpha',
    initializedAt: null,
    works: [],
    segments: {},
    dismissedSegments: {},
    lockedWorkIds: [],
    updatedAt: 0,
  })
  assert.notEqual(a.works, b.works)
  assert.notEqual(a.segments, b.segments)
  assert.notEqual(a.dismissedSegments, b.dismissedSegments)
  assert.notEqual(a.lockedWorkIds, b.lockedWorkIds)
})

test('createWork 构造包含全部契约字段且允许 decisions 为空数组', () => {
  const w = createWork({
    id: 'w-auth',
    workspaceId: 'ws-1',
    title: '修复鉴权刷新',
    goal: '消除多标签并发刷新 401',
    statusSummary: '已定位并发锁问题',
    nextStep: '补充并发单元测试',
    segmentIds: ['seg-1'],
    sessionIds: ['session-a1b2c3d4'],
    files: ['src/auth.js'],
    evidenceHandles: ['〔a1b2c3d4#1〕'],
  }, T0)

  assert.equal(w.id, 'w-auth')
  assert.equal(w.workspaceId, 'ws-1')
  assert.equal(w.state, 'active')
  assert.equal(w.stateSource, 'inferred')
  assert.equal(w.pinned, false)
  assert.equal(w.nextStepSource, 'inferred')
  assert.deepEqual(w.decisions, [])
  assert.equal(w.reviewStatus, 'pending')
  assert.equal(w.dismissedAsChat, false)
  assert.equal(w.reopenedFromId, null)
  assert.equal(w.createdAt, T0)
  assert.equal(w.updatedAt, T0)
  assert.equal(w.lastActivityAt, T0)
  assert.equal(w.lastInflectionAt, null)
})

// ── 决策：一等但按需累积 + supersede ───────────────────────────────

test('addDecision / supersedeDecision / activeDecisions / supersededDecisions 完整演化', () => {
  const base = deepFreeze(createWork({
    id: 'w-1',
    workspaceId: 'ws-1',
    title: '缓存方案',
    goal: '降低冷启动延迟',
  }, T0))

  assert.deepEqual(activeDecisions(base), [])
  assert.deepEqual(supersededDecisions(base), [])

  const w1 = addDecision(base, {
    id: 'd-1',
    summary: '采用内存 LRU 缓存',
    rationale: '实现简单、零外部依赖',
    evidenceHandle: '〔a1b2c3d4#3〕',
    source: 'inferred',
    at: T0 + 1000,
  })
  assert.equal(base.decisions.length, 0, '不修改入参')
  assert.equal(w1.decisions.length, 1)
  assert.equal(w1.decisions[0].status, 'active')
  assert.equal(w1.decisions[0].supersededBy, null)
  assert.equal(activeDecisions(w1).length, 1)
  assert.equal(supersededDecisions(w1).length, 0)

  const w2 = supersedeDecision(deepFreeze(w1), 'd-1', {
    id: 'd-2',
    summary: '改为落盘 JSONL 快照',
    rationale: '重启后仍需首帧秒出',
    evidenceHandle: '〔a1b2c3d4#9〕',
    source: 'confirmed',
    at: T0 + 2000,
  })
  assert.equal(w2.decisions.length, 2)
  const oldDec = w2.decisions.find(d => d.id === 'd-1')
  const newDec = w2.decisions.find(d => d.id === 'd-2')
  assert.equal(oldDec.status, 'superseded')
  assert.equal(oldDec.supersededBy, 'd-2')
  assert.equal(newDec.status, 'active')
  assert.equal(newDec.supersededBy, null)
  assert.deepEqual(activeDecisions(w2).map(d => d.id), ['d-2'])
  assert.deepEqual(supersededDecisions(w2).map(d => d.id), ['d-1'])
  assert.ok(w2.evidenceHandles.includes('〔a1b2c3d4#9〕'), '新决策证据同步汇总进 evidenceHandles')
})

test('supersedeDecision 找不到 oldId 时保持原状不崩', () => {
  const w = createWork({ id: 'w-1', workspaceId: 'ws-1', title: '事' }, T0)
  const next = supersedeDecision(w, 'not-exist', { summary: '新方案', at: T0 + 1000 })
  assert.deepEqual(next.decisions, [])
})

// ── 双表与不可覆盖铁律 ──────────────────────────────────────────────

test('applyUserConfirm 锁定用户确认字段，applyInferredUpdate 永不覆盖已确认字段', () => {
  const w = createWork({
    id: 'w-1',
    workspaceId: 'ws-1',
    title: '旧推测标题',
    goal: '旧目标',
    state: 'active',
    stateSource: 'inferred',
    statusSummary: '推测现状',
    nextStep: '推测下一步',
    nextStepSource: 'inferred',
  }, T0)
  const store0 = deepFreeze(makeStoreWithWorks([w]))

  // 用户确认了 state 和 pinned，但没有确认 nextStep
  const store1 = applyUserConfirm(store0, 'w-1', {
    state: 'blocked',
    pinned: true,
  }, T0 + 1000)

  const confirmed = store1.works[0]
  assert.equal(confirmed.state, 'blocked')
  assert.equal(confirmed.stateSource, 'confirmed')
  assert.equal(confirmed.pinned, true)
  assert.equal(confirmed.nextStepSource, 'inferred')
  assert.equal(confirmed.reviewStatus, 'reviewed')
  assert.ok(store1.lockedWorkIds.includes('w-1'))

  // 后台推断试图覆盖 state 与 nextStep
  const store2 = applyInferredUpdate(deepFreeze(store1), 'w-1', {
    state: 'active',
    nextStep: '后台刷新后的下一步',
    statusSummary: '后台补充的最新进展',
  }, T0 + 2000)

  const afterInfer = store2.works[0]
  assert.equal(afterInfer.state, 'blocked', '已确认的 state 绝不被后台推断改回 active')
  assert.equal(afterInfer.stateSource, 'confirmed')
  assert.equal(afterInfer.nextStep, '后台刷新后的下一步', '仍是 inferred 的字段可继续更新')
  assert.equal(afterInfer.nextStepSource, 'inferred')
})

test('applyUserConfirm 确认 title/nextStep/decisions 后，后台推断不得覆盖它们', () => {
  const w = createWork({
    id: 'w-2',
    workspaceId: 'ws-1',
    title: '推测标题',
    nextStep: '推测步骤',
  }, T0)
  let store = makeStoreWithWorks([w])
  store = applyUserConfirm(store, 'w-2', {
    title: '人工定名标题',
    nextStep: '先跑回归再发版',
    decisions: [{ id: 'd-u1', summary: '保留双表设计', rationale: '防重建丢数据', evidenceHandle: '〔11223344#2〕', at: T0 + 500 }],
  }, T0 + 1000)

  assert.equal(store.works[0].title, '人工定名标题')
  assert.equal(store.works[0].nextStep, '先跑回归再发版')
  assert.equal(store.works[0].nextStepSource, 'confirmed')
  assert.equal(store.works[0].decisions[0].source, 'confirmed')

  const next = applyInferredUpdate(store, 'w-2', {
    title: '模型想改标题',
    nextStep: '模型想改下一步',
    decisions: [{ id: 'd-m1', summary: '模型想清空人工决策', at: T0 + 2000 }],
  }, T0 + 2000)

  assert.equal(next.works[0].title, '人工定名标题', '人工确认的标题不被覆盖')
  assert.equal(next.works[0].nextStep, '先跑回归再发版', '已确认的 nextStep 不被覆盖')
  assert.ok(next.works[0].decisions.some(d => d.id === 'd-u1' && d.source === 'confirmed'), '已确认决策不得丢失')
})

test('已确认为 done 或 shelved 的事完全拒绝后台推断更新', () => {
  for (const terminalState of ['done', 'shelved']) {
    const w = createWork({
      id: 'w-term',
      workspaceId: 'ws-1',
      title: '老事',
      state: 'active',
      nextStep: '旧下一步',
      statusSummary: '旧现状',
    }, T0)
    let store = makeStoreWithWorks([w])
    store = applyUserConfirm(store, 'w-term', { state: terminalState }, T0 + 1000)

    const after = applyInferredUpdate(deepFreeze(store), 'w-term', {
      state: 'active',
      title: '被模型篡改',
      statusSummary: '被模型篡改现状',
      nextStep: '被模型篡改下一步',
      files: ['hack.js'],
      segmentIds: ['seg-new'],
    }, T0 + 2000)

    assert.equal(after.works[0].state, terminalState)
    assert.equal(after.works[0].title, '老事')
    assert.equal(after.works[0].statusSummary, '旧现状')
    assert.equal(after.works[0].nextStep, '旧下一步')
    assert.deepEqual(after.works[0].segmentIds, [])
  }
})

// ── 话题 ↔ 事 一键互转与防重提 ─────────────────────────────────────

test('convertChatSegmentToWork 把话题段转为已确认的事，并清除 dismissed 标记', () => {
  const seg = sampleSegment({ id: 'seg-chat-1', title: '重构路由中间件' })
  let store = makeStoreWithWorks([], { 'seg-chat-1': seg }, {
    dismissedSegments: { 'seg-chat-1': { at: T0 - 5000, reason: 'previously-dismissed' } },
  })

  const res = convertChatSegmentToWork(deepFreeze(store), seg, T0 + 1000)
  const nextStore = res.store
  const created = res.work

  assert.ok(created && created.id)
  assert.equal(created.state, 'active')
  assert.equal(created.stateSource, 'confirmed', '人工主动转事即已确认态')
  assert.equal(created.reviewStatus, 'reviewed')
  assert.equal(created.dismissedAsChat, false)
  assert.deepEqual(created.segmentIds, ['seg-chat-1'])
  assert.deepEqual(created.sessionIds, ['session-a1b2c3d4-0001'])
  assert.deepEqual(created.files, ['src/auth.js', 'tests/auth.mjs'])
  assert.ok(nextStore.lockedWorkIds.includes(created.id))
  assert.equal(nextStore.dismissedSegments['seg-chat-1'], undefined, '人主动升格为事时解除忽略')
  assert.equal(nextStore.segments['seg-chat-1'].workId, created.id)
})

test('dismissWorkAsChat 把误立的事退回话题并记入 dismissedSegments 防止重提', () => {
  const seg1 = sampleSegment({ id: 'seg-a' })
  const seg2 = sampleSegment({ id: 'seg-b', turnRange: [7, 9] })
  const w = createWork({
    id: 'w-chat',
    workspaceId: 'ws-1',
    title: '闲聊咖啡豆',
    segmentIds: ['seg-a', 'seg-b'],
    sessionIds: ['session-a1b2c3d4-0001'],
  }, T0)
  const store0 = deepFreeze(makeStoreWithWorks([w], { 'seg-a': seg1, 'seg-b': seg2 }))

  const store1 = dismissWorkAsChat(store0, 'w-chat', T0 + 1000)
  const dismissed = store1.works.find(item => item.id === 'w-chat')
  assert.equal(dismissed.dismissedAsChat, true)
  assert.equal(dismissed.reviewStatus, 'reviewed')
  assert.ok(store1.dismissedSegments['seg-a'], '关联段全部记入 dismissedSegments')
  assert.ok(store1.dismissedSegments['seg-b'])
  assert.equal(store1.segments['seg-a'].workId, null)

  // 退回话题后不再出现在续接屏卡片里
  const view = projectResumeCards(store1, { now: T0 + 2000 })
  assert.equal(view.unresolved.length, 0)
  assert.equal(view.settled.length, 0)
})

// ── 合并与拆段 ──────────────────────────────────────────────────────

test('mergeWorks 合并两件事并去重段/会话/文件/决策/证据，操作后锁定目标事', () => {
  const target = createWork({
    id: 'w-target',
    workspaceId: 'ws-1',
    title: '登录超时修复',
    goal: '消除 401',
    segmentIds: ['seg-1'],
    sessionIds: ['s-1'],
    files: ['src/auth.js'],
    evidenceHandles: ['〔11111111#1〕'],
    decisions: [{ id: 'd-1', summary: '加刷新锁', rationale: '防并发', status: 'active', supersededBy: null, evidenceHandle: '〔11111111#2〕', source: 'confirmed', at: T0 }],
    lastActivityAt: T0 + 1000,
  }, T0)
  const source = createWork({
    id: 'w-source',
    workspaceId: 'ws-1',
    title: '登录刷新单测',
    goal: '补单测',
    segmentIds: ['seg-2', 'seg-1'],
    sessionIds: ['s-2', 's-1'],
    files: ['tests/auth.mjs', 'src/auth.js'],
    evidenceHandles: ['〔22222222#4〕', '〔11111111#1〕'],
    decisions: [{ id: 'd-2', summary: '使用假时钟', rationale: '稳定复现', status: 'active', supersededBy: null, evidenceHandle: '〔22222222#5〕', source: 'inferred', at: T0 + 3000 }],
    pinned: true,
    lastActivityAt: T0 + 5000,
  }, T0 + 500)
  const store0 = deepFreeze(makeStoreWithWorks([target, source], {
    'seg-1': sampleSegment({ id: 'seg-1', sessionId: 's-1', workId: 'w-target' }),
    'seg-2': sampleSegment({ id: 'seg-2', sessionId: 's-2', workId: 'w-source' }),
  }))

  const store1 = mergeWorks(store0, 'w-target', 'w-source', T0 + 6000)
  assert.equal(store1.works.length, 1)
  const merged = store1.works[0]
  assert.equal(merged.id, 'w-target')
  assert.deepEqual(merged.segmentIds, ['seg-1', 'seg-2'])
  assert.deepEqual(merged.sessionIds, ['s-1', 's-2'])
  assert.deepEqual(merged.files, ['src/auth.js', 'tests/auth.mjs'])
  assert.deepEqual(merged.evidenceHandles, ['〔11111111#1〕', '〔11111111#2〕', '〔22222222#4〕', '〔22222222#5〕'])
  assert.equal(merged.decisions.length, 2)
  assert.equal(merged.pinned, true, '任一置顶合并后保留置顶')
  assert.equal(merged.lastActivityAt, T0 + 5000)
  assert.equal(merged.reviewStatus, 'reviewed')
  assert.ok(store1.lockedWorkIds.includes('w-target'))
  assert.equal(store1.segments['seg-2'].workId, 'w-target')
  assert.equal(store1.segments['seg-2'].locked, true)
})

test('splitSegmentFromWork 拆出挂错的段成为独立新事并锁定两端归属', () => {
  const seg1 = sampleSegment({ id: 'seg-1', sessionId: 's-1', title: '修鉴权', files: ['src/auth.js'] })
  const seg2 = sampleSegment({ id: 'seg-2', sessionId: 's-2', title: '改配色', files: ['src/theme.js'], changedFiles: ['src/theme.js'], evidenceHandles: ['〔33333333#2〕'], lastActivityAt: T0 + 4000 })
  const w = createWork({
    id: 'w-mix',
    workspaceId: 'ws-1',
    title: '修鉴权',
    segmentIds: ['seg-1', 'seg-2'],
    sessionIds: ['s-1', 's-2'],
    files: ['src/auth.js', 'src/theme.js'],
  }, T0)
  const store0 = deepFreeze(makeStoreWithWorks([w], { 'seg-1': seg1, 'seg-2': seg2 }))

  const res = splitSegmentFromWork(store0, 'w-mix', 'seg-2', T0 + 5000)
  const nextStore = res.store
  const newWork = res.work

  assert.equal(nextStore.works.length, 2)
  const remain = nextStore.works.find(item => item.id === 'w-mix')
  assert.deepEqual(remain.segmentIds, ['seg-1'])
  assert.deepEqual(remain.sessionIds, ['s-1'])
  assert.deepEqual(remain.files, ['src/auth.js'])
  assert.ok(nextStore.lockedWorkIds.includes('w-mix'))

  assert.ok(newWork && newWork.id !== 'w-mix')
  assert.equal(newWork.title, '改配色')
  assert.deepEqual(newWork.segmentIds, ['seg-2'])
  assert.deepEqual(newWork.sessionIds, ['s-2'])
  assert.deepEqual(newWork.files, ['src/theme.js'])
  assert.equal(newWork.stateSource, 'confirmed')
  assert.ok(nextStore.lockedWorkIds.includes(newWork.id))
  assert.equal(nextStore.segments['seg-2'].workId, newWork.id)
  assert.equal(nextStore.segments['seg-2'].locked, true)
})

// ── 沉降与重聊浮回 ──────────────────────────────────────────────────

test('applyDormancySettlement 仅沉降超时且推测态、未置顶的未收束事', () => {
  const now = T0 + 20 * DAY
  const works = [
    createWork({ id: 'w-stale-inferred', workspaceId: 'ws-1', title: '超时推测', state: 'active', stateSource: 'inferred', lastActivityAt: T0 }, T0),
    createWork({ id: 'w-stale-blocked', workspaceId: 'ws-1', title: '超时卡住推测', state: 'blocked', stateSource: 'inferred', lastActivityAt: T0 }, T0),
    createWork({ id: 'w-stale-confirmed', workspaceId: 'ws-1', title: '超时但已确认', state: 'active', stateSource: 'confirmed', lastActivityAt: T0 }, T0),
    createWork({ id: 'w-stale-pinned', workspaceId: 'ws-1', title: '超时但置顶', state: 'active', stateSource: 'inferred', pinned: true, lastActivityAt: T0 }, T0),
    createWork({ id: 'w-fresh-inferred', workspaceId: 'ws-1', title: '近期活跃', state: 'active', stateSource: 'inferred', lastActivityAt: now - 3 * DAY }, T0),
    createWork({ id: 'w-done', workspaceId: 'ws-1', title: '已完成', state: 'done', stateSource: 'inferred', lastActivityAt: T0 }, T0),
  ]
  const store0 = deepFreeze(makeStoreWithWorks(works))

  const settled = applyDormancySettlement(store0, { now, dormantDays: 14 })
  const byId = Object.fromEntries(settled.works.map(w => [w.id, w]))

  assert.equal(byId['w-stale-inferred'].state, 'shelved')
  assert.equal(byId['w-stale-blocked'].state, 'shelved')
  assert.equal(byId['w-stale-confirmed'].state, 'active', '已确认态不自动沉降')
  assert.equal(byId['w-stale-pinned'].state, 'active', '置顶不自动沉降')
  assert.equal(byId['w-fresh-inferred'].state, 'active', '未超期不沉降')
  assert.equal(byId['w-done'].state, 'done', '已完成不被改成 shelved')
})

test('applyDormancySettlement 当 dormantDays <= 0 时永不自动沉降', () => {
  const now = T0 + 100 * DAY
  const w = createWork({ id: 'w-old', workspaceId: 'ws-1', title: '很久以前', state: 'active', stateSource: 'inferred', lastActivityAt: T0 }, T0)
  const store0 = deepFreeze(makeStoreWithWorks([w]))

  assert.equal(applyDormancySettlement(store0, { now, dormantDays: 0 }).works[0].state, 'active')
  assert.equal(applyDormancySettlement(store0, { now, dormantDays: -1 }).works[0].state, 'active')
})

test('wakeWorkOnActivity 重聊时把已搁置的事浮回 active 并刷新 lastActivityAt', () => {
  const now = T0 + 25 * DAY
  const w = createWork({ id: 'w-sleep', workspaceId: 'ws-1', title: '沉睡的事', state: 'shelved', stateSource: 'inferred', lastActivityAt: T0 }, T0)
  const store0 = deepFreeze(makeStoreWithWorks([w]))

  const woke = wakeWorkOnActivity(store0, 'w-sleep', now)
  assert.equal(woke.works[0].state, 'active')
  assert.equal(woke.works[0].lastActivityAt, now)
  assert.equal(woke.works[0].updatedAt, now)
})

test('wakeWorkOnActivity 不篡改已确认为 done 的老事状态', () => {
  const now = T0 + 25 * DAY
  const w = createWork({ id: 'w-done', workspaceId: 'ws-1', title: '已完成确认', state: 'done', stateSource: 'confirmed', lastActivityAt: T0 }, T0)
  const store0 = deepFreeze(makeStoreWithWorks([w]))

  const res = wakeWorkOnActivity(store0, 'w-done', now)
  assert.equal(res.works[0].state, 'done')
})

// ── 三类自然拐点识别 ────────────────────────────────────────────────

test('detectInflection 识别 topic_switch（从 A 事切到 B 事）', () => {
  const prevSegment = sampleSegment({ id: 'seg-a', workId: 'w-a', title: '修鉴权' })
  const currSegment = sampleSegment({ id: 'seg-b', workId: 'w-b', title: '改主题色' })
  const workA = createWork({ id: 'w-a', workspaceId: 'ws-1', title: '修鉴权', state: 'active', stateSource: 'inferred' }, T0)

  const hint = detectInflection({ prevSegment, currSegment, work: workA })
  assert.ok(hint)
  assert.equal(hint.kind, 'topic_switch')
  assert.equal(hint.workId, 'w-a')
  assert.ok(Array.isArray(hint.actions) && hint.actions.length >= 2)
})

test('detectInflection 识别 likely_settled_or_blocked（报错/中断卡住 或 疑似收尾）', () => {
  const work = createWork({ id: 'w-b', workspaceId: 'ws-1', title: '迁数据库', state: 'active', stateSource: 'inferred' }, T0)

  const blockedHint = detectInflection({
    work,
    currSegment: sampleSegment({ id: 'seg-1', workId: 'w-b' }),
    lastTurn: { turn: 8, endReason: 'error', error: 'ECONNREFUSED' },
  })
  assert.ok(blockedHint)
  assert.equal(blockedHint.kind, 'likely_settled_or_blocked')
  assert.equal(blockedHint.suggestedState, 'blocked')

  const doneHint = detectInflection({
    work,
    currSegment: sampleSegment({ id: 'seg-1', workId: 'w-b', changedFiles: ['src/db.js'] }),
    lastTurn: { turn: 9, endReason: 'stop', prompt: '好了，全部测试通过，提交吧', response: '全部 18 项测试通过，已完成迁移。' },
  })
  assert.ok(doneHint)
  assert.equal(doneHint.kind, 'likely_settled_or_blocked')
  assert.equal(doneHint.suggestedState, 'done')
})

test('detectInflection 识别 revisit_unresolved（隔了一段时间重返未收束会话）', () => {
  const work = createWork({ id: 'w-r', workspaceId: 'ws-1', title: '实现冷启动', state: 'active', stateSource: 'inferred' }, T0)
  const hint = detectInflection({
    work,
    currSegment: sampleSegment({ id: 'seg-r', workId: 'w-r' }),
    gapMs: 6 * HOUR,
  })
  assert.ok(hint)
  assert.equal(hint.kind, 'revisit_unresolved')
  assert.equal(hint.workId, 'w-r')
})

test('detectInflection 对已确认收束或无拐点返回 null', () => {
  const doneWork = createWork({ id: 'w-done', workspaceId: 'ws-1', title: '已做完', state: 'done', stateSource: 'confirmed' }, T0)
  assert.equal(detectInflection({ work: doneWork, gapMs: 12 * HOUR }), null)

  const activeWork = createWork({ id: 'w-ok', workspaceId: 'ws-1', title: '正常进行', state: 'active', stateSource: 'inferred' }, T0)
  assert.equal(detectInflection({
    work: activeWork,
    prevSegment: sampleSegment({ id: 's1', workId: 'w-ok' }),
    currSegment: sampleSegment({ id: 's2', workId: 'w-ok' }),
    lastTurn: { turn: 3, endReason: 'stop', prompt: '继续看下一个文件', response: '好的，我来看。' },
    gapMs: 5 * 60 * 1000,
  }), null)
})

// ── 360px 窄抽屉 4 行卡片投影 ───────────────────────────────────────

test('projectResumeCards 按未收束优先、置顶、blocked 优先于 active、lastActivityAt 倒序排列并折叠已收束', () => {
  const now = T0 + 5 * DAY
  const works = [
    createWork({ id: 'w-active-old', workspaceId: 'ws-1', title: '较旧进行中', state: 'active', lastActivityAt: now - 3 * DAY, reviewStatus: 'pending' }, T0),
    createWork({ id: 'w-active-new', workspaceId: 'ws-1', title: '最新进行中', state: 'active', lastActivityAt: now - 1 * HOUR, reviewStatus: 'reviewed' }, T0),
    createWork({ id: 'w-blocked', workspaceId: 'ws-1', title: '卡住的事', state: 'blocked', statusSummary: '单测超时', nextStep: '排查死锁', lastActivityAt: now - 2 * DAY, reviewStatus: 'pending' }, T0),
    createWork({ id: 'w-pinned', workspaceId: 'ws-1', title: '置顶进行中', state: 'active', pinned: true, lastActivityAt: now - 4 * DAY, reviewStatus: 'reviewed' }, T0),
    createWork({ id: 'w-done', workspaceId: 'ws-1', title: '已完成', state: 'done', lastActivityAt: now - 2 * HOUR, reviewStatus: 'reviewed' }, T0),
    createWork({ id: 'w-shelved', workspaceId: 'ws-1', title: '已搁置', state: 'shelved', lastActivityAt: now - 15 * DAY, reviewStatus: 'pending' }, T0),
    createWork({ id: 'w-chat', workspaceId: 'ws-1', title: '已退回闲聊', state: 'active', dismissedAsChat: true, lastActivityAt: now, reviewStatus: 'reviewed' }, T0),
  ]
  const store = deepFreeze(makeStoreWithWorks(works))

  const view = projectResumeCards(store, { now })
  assert.deepEqual(
    view.unresolved.map(c => c.id),
    ['w-pinned', 'w-blocked', 'w-active-new', 'w-active-old'],
    '置顶最前，其次 blocked，其次 active 按最近活动倒序',
  )
  assert.deepEqual(
    view.settled.map(c => c.id),
    ['w-done', 'w-shelved'],
    'done 与 shelved 折叠到底部 settled 组',
  )
  assert.equal(view.settledCollapsedByDefault, true)
  assert.equal(view.pendingReviewCount, 3)

  // 验证 4 行窄卡片结构
  const blockedCard = view.unresolved.find(c => c.id === 'w-blocked')
  assert.equal(blockedCard.title, '卡住的事')
  assert.equal(blockedCard.state, 'blocked')
  assert.equal(blockedCard.confidence, 'inferred')
  assert.equal(blockedCard.statusLine, '单测超时')
  assert.equal(blockedCard.nextStep, '排查死锁')
  assert.ok(typeof blockedCard.relativeTime === 'string' && blockedCard.relativeTime.length > 0)
  assert.ok(Array.isArray(blockedCard.actions) && blockedCard.actions.length > 0)
})

test('同一件事允许挂载多个并行活跃会话并保持去重', () => {
  const w = createWork({
    id: 'w-multi',
    workspaceId: 'ws-1',
    title: '并行开发前后端',
    sessionIds: ['s-frontend'],
    segmentIds: ['seg-1'],
  }, T0)
  const store0 = deepFreeze(makeStoreWithWorks([w]))
  const store1 = applyInferredUpdate(store0, 'w-multi', {
    sessionIds: ['s-backend', 's-frontend'],
    segmentIds: ['seg-2'],
    lastActivityAt: T0 + 3000,
  }, T0 + 3000)

  assert.deepEqual(store1.works[0].sessionIds, ['s-frontend', 's-backend'])
  assert.deepEqual(store1.works[0].segmentIds, ['seg-1', 'seg-2'])
  assert.equal(store1.works[0].lastActivityAt, T0 + 3000)
})

test('异常/空输入边界不抛错（mergeWorks 自合并、不存在 id、空 store 投影）', () => {
  const empty = emptyWorkStore('ws-empty')
  assert.deepEqual(mergeWorks(empty, 'w-1', 'w-1', T0), empty)
  assert.deepEqual(mergeWorks(empty, 'w-1', 'w-2', T0), empty)
  assert.equal(splitSegmentFromWork(empty, 'w-1', 'seg-1', T0).work, null)
  assert.equal(convertChatSegmentToWork(empty, null, T0).work, null)
  assert.deepEqual(projectResumeCards(null, { now: T0 }), {
    unresolved: [],
    settled: [],
    settledCollapsedByDefault: true,
    pendingReviewCount: 0,
  })
})

console.log(`\n  ${passed} passed, ${failures.length} failed\n`)
if (failures.length > 0) process.exitCode = 1
