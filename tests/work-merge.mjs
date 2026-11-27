/**
 * 存量冷启动盘点 + 增量三级匹配引擎（ADR-0003）的测试。
 *
 * 覆盖：
 * - 冷启动第一步（零模型硬信号预聚类）：
 *   1. fork 血缘直连；
 *   2. 段内引用句柄 〔8hex#N〕 互指直连；
 *   3. 时间窗内 changedFiles 高重叠直连，且排除通用配置文件（package.json/README.md 等）误连；
 *   4. 子代理/自动化会话默认不自动立事；
 *   5. 忽略 dismissedSegments；
 * - 冷启动第二步（初分未收束候选事 / 已收尾历史事 / 纯话题，全部 inferred + pending）；
 * - 冷启动语义精化 prompt 构造与结果解析 + 失败安全降级；
 * - 增量三级匹配：
 *   - L1 硬血缘（handoffWorkId / fork 父会话 / 引用句柄）；
 *   - L2 文件显著重叠（排除通用文件）；
 *   - L3 语义候选（同工作区未收束事，最多 10 件）prompt 与解析；
 * - 防污染红线：命中已确认 done 的老事绝不静默改写，返回 suggest_reopen。
 *
 * Run: node tests/work-merge.mjs
 */

import { strict as assert } from 'node:assert'
import {
  GENERIC_CONFIG_FILES,
  MAX_SEMANTIC_CANDIDATES,
  extractTurnHandlesFromSegment,
  planColdStartWorks,
  buildColdStartSemanticPrompt,
  parseColdStartSemanticResult,
  matchSegmentIncremental,
  buildIncrementalMatchPrompt,
  parseIncrementalMatchResult,
} from '../lib/work-merge.js'
import {
  emptyWorkStore,
  createWork,
  applyUserConfirm,
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

const DAY = 24 * 60 * 60 * 1000
const T0 = Date.UTC(2026, 10, 1, 9, 0, 0)

function seg(overrides = {}) {
  return {
    id: 'seg-1',
    workspaceId: 'ws-1',
    sessionId: 'session-11111111-aaaa',
    title: '实现工作模型',
    summary: '编写状态机与单测',
    kindCandidate: 'work',
    turnRange: [1, 5],
    files: ['lib/work-model.js'],
    changedFiles: ['lib/work-model.js'],
    evidenceHandles: ['〔11111111#1〕'],
    startedAt: T0,
    endedAt: T0 + 10 * 60 * 1000,
    lastActivityAt: T0 + 10 * 60 * 1000,
    ...overrides,
  }
}

console.log('\nwork-merge')

// ── 句柄提取 ────────────────────────────────────────────────────────

test('extractTurnHandlesFromSegment 识别段文本与字段中的 〔8hex#N〕 句柄', () => {
  const handles = extractTurnHandlesFromSegment({
    summary: '续接前面 〔4c42ff36#12〕 和 〔a0b1c2d3#4〕 的讨论',
    referencedHandles: ['〔4c42ff36#12〕', '99887766#7'],
    turns: [{ prompt: '参考 〔deadbeef#0〕 排查' }],
  })
  assert.deepEqual(
    handles.map(h => h.handle),
    ['4c42ff36#12', 'a0b1c2d3#4', '99887766#7', 'deadbeef#0'],
  )
  assert.equal(handles[0].sessionPrefix, '4c42ff36')
  assert.equal(handles[0].turn, 12)
})

// ── 冷启动第一步：零模型硬信号预聚类 ────────────────────────────────

test('冷启动：fork 血缘将父子会话的段直接聚为同一候选簇', () => {
  const s1 = seg({ id: 'seg-parent', sessionId: 'session-aaaa1111-0001', title: '排查内存泄漏', changedFiles: ['src/cache.js'] })
  const s2 = seg({ id: 'seg-child', sessionId: 'session-bbbb2222-0002', title: '验证修复效果', changedFiles: ['tests/cache.mjs'], lastActivityAt: T0 + DAY })

  const plan = planColdStartWorks([s1, s2], {
    workspaceId: 'ws-1',
    now: T0 + 2 * DAY,
    forkEdges: [{ childSessionId: 'session-bbbb2222-0002', parentSessionId: 'session-aaaa1111-0001' }],
  })

  assert.equal(plan.works.length, 1)
  assert.deepEqual(plan.works[0].segmentIds.sort(), ['seg-child', 'seg-parent'])
  assert.equal(plan.works[0].stateSource, 'inferred')
  assert.equal(plan.works[0].reviewStatus, 'pending')
  assert.ok(plan.clusters[0].reasons.includes('fork'))
})

test('冷启动：段内引用句柄 〔8hex#N〕 互指的段直接聚类', () => {
  const s1 = seg({
    id: 'seg-origin',
    sessionId: 'session-4c42ff36-0001',
    title: '设计交接协议',
    turnRange: [1, 8],
    changedFiles: ['docs/adr/0004.md'],
  })
  const s2 = seg({
    id: 'seg-followup',
    sessionId: 'session-99aa88bb-0002',
    title: '落地 wire 注入',
    summary: '按 〔4c42ff36#5〕 的结构实现',
    changedFiles: ['lib/handoff.js'],
    lastActivityAt: T0 + 2 * DAY,
  })

  const plan = planColdStartWorks([s1, s2], { workspaceId: 'ws-1', now: T0 + 3 * DAY })
  assert.equal(plan.works.length, 1)
  assert.deepEqual(plan.works[0].segmentIds.sort(), ['seg-followup', 'seg-origin'])
  assert.ok(plan.clusters[0].reasons.includes('handle'))
})

test('冷启动：14 天内高重叠业务文件聚类，但纯通用配置文件不误连', () => {
  assert.ok(GENERIC_CONFIG_FILES.has('package.json'))
  assert.ok(GENERIC_CONFIG_FILES.has('readme.md'))

  const sAuth1 = seg({ id: 'seg-auth-1', sessionId: 's-1', title: '修鉴权', changedFiles: ['src/auth.js', 'src/token.js'], lastActivityAt: T0 })
  const sAuth2 = seg({ id: 'seg-auth-2', sessionId: 's-2', title: '补鉴权测试', changedFiles: ['src/auth.js', 'src/token.js'], lastActivityAt: T0 + 5 * DAY })
  // 这两段只共同碰了 package.json / README.md，绝不能聚成同一件事
  const sPkg1 = seg({ id: 'seg-pkg-1', sessionId: 's-3', title: '升级依赖', changedFiles: ['package.json', 'README.md'], lastActivityAt: T0 + 1 * DAY })
  const sPkg2 = seg({ id: 'seg-pkg-2', sessionId: 's-4', title: '补发版脚本', changedFiles: ['package.json', 'README.md'], lastActivityAt: T0 + 2 * DAY })
  // 超出 14 天时间窗也不靠文件硬连
  const sAuthOld = seg({ id: 'seg-auth-old', sessionId: 's-5', title: '上个月鉴权改版', changedFiles: ['src/auth.js', 'src/token.js'], lastActivityAt: T0 + 25 * DAY })

  const plan = planColdStartWorks([sAuth1, sAuth2, sPkg1, sPkg2, sAuthOld], {
    workspaceId: 'ws-1',
    now: T0 + 26 * DAY,
  })

  const authCluster = plan.clusters.find(c => c.segmentIds.includes('seg-auth-1'))
  assert.ok(authCluster.segmentIds.includes('seg-auth-2'), '窗口内业务文件高重叠应聚类')
  assert.ok(!authCluster.segmentIds.includes('seg-auth-old'), '超过 14 天时间窗不直接硬连')

  const pkg1Cluster = plan.clusters.find(c => c.segmentIds.includes('seg-pkg-1'))
  assert.ok(!pkg1Cluster.segmentIds.includes('seg-pkg-2'), '仅共享 package.json/README.md 不得误连')
})

test('冷启动：按 kindCandidate 与硬证据区分未收束事 / 已收尾历史事 / 纯话题，且排除子代理', () => {
  const now = T0 + 20 * DAY
  const sActive = seg({ id: 'seg-active', sessionId: 's-1', title: '开发中功能', kindCandidate: 'work', changedFiles: ['src/feat-a.js'], files: ['src/feat-a.js'], lastActivityAt: now - 1 * DAY })
  const sBlocked = seg({ id: 'seg-blocked', sessionId: 's-2', title: '报错中断', kindCandidate: 'work', changedFiles: ['src/feat-b.js'], files: ['src/feat-b.js'], endReason: 'error', hasError: true, lastActivityAt: now - 2 * DAY })
  const sStale = seg({ id: 'seg-stale', sessionId: 's-3', title: '很久之前的历史任务', kindCandidate: 'work', changedFiles: ['src/old.js'], files: ['src/old.js'], lastActivityAt: T0 })
  const sDone = seg({ id: 'seg-done', sessionId: 's-4', title: '已收尾的发布', kindCandidate: 'work', changedFiles: ['src/release.js'], files: ['src/release.js'], settled: true, lastActivityAt: now - 3 * DAY })
  const sChat = seg({ id: 'seg-chat', sessionId: 's-5', title: '闲聊概念解释', kindCandidate: 'chat', changedFiles: [], files: [], lastActivityAt: now - 1 * DAY })
  const sSubagent = seg({ id: 'seg-sub', sessionId: 's-sub', title: '子代理跑任务', isSubagent: true, kindCandidate: 'work', lastActivityAt: now - 1 * DAY })

  const plan = planColdStartWorks([sActive, sBlocked, sStale, sDone, sChat, sSubagent], {
    workspaceId: 'ws-1',
    now,
    dormantDays: 14,
  })

  const activeWork = plan.works.find(w => w.segmentIds.includes('seg-active'))
  const blockedWork = plan.works.find(w => w.segmentIds.includes('seg-blocked'))
  const staleWork = plan.works.find(w => w.segmentIds.includes('seg-stale'))
  const doneWork = plan.works.find(w => w.segmentIds.includes('seg-done'))

  assert.equal(activeWork.state, 'active')
  assert.equal(blockedWork.state, 'blocked')
  assert.equal(staleWork.state, 'shelved', '超过沉降天数的历史事自动标 shelved')
  assert.equal(doneWork.state, 'done')
  assert.ok(plan.works.every(w => w.stateSource === 'inferred' && w.reviewStatus === 'pending'))

  assert.ok(plan.unresolvedWorks.some(w => w.id === activeWork.id))
  assert.ok(plan.unresolvedWorks.some(w => w.id === blockedWork.id))
  assert.ok(plan.settledWorks.some(w => w.id === staleWork.id))
  assert.ok(plan.settledWorks.some(w => w.id === doneWork.id))

  assert.deepEqual(plan.chatTopics.map(t => t.segmentIds[0]), ['seg-chat'])
  assert.ok(!plan.works.some(w => w.segmentIds.includes('seg-sub')), '子代理会话默认不立为独立事')
  assert.ok(plan.ignoredSegments.includes('seg-sub'))
})

// ── 冷启动语义精化 Prompt 与降级解析 ────────────────────────────────

test('buildColdStartSemanticPrompt 与 parseColdStartSemanticResult 正常工作并在异常输出时安全降级', () => {
  const s1 = seg({ id: 'seg-1', sessionId: 's-1', title: '修跳转', changedFiles: ['src/jump.js'] })
  const s2 = seg({ id: 'seg-2', sessionId: 's-2', title: '修落点偏差', changedFiles: ['src/scroll.js'], lastActivityAt: T0 + DAY })
  const plan = planColdStartWorks([s1, s2], { workspaceId: 'ws-1', now: T0 + 2 * DAY })

  const prompt = buildColdStartSemanticPrompt(plan.clusters, [s1, s2])
  assert.ok(typeof prompt.system === 'string' && prompt.system.length > 0)
  assert.ok(prompt.user.includes('修跳转') && prompt.user.includes('修落点偏差'))

  const cIds = plan.clusters.map(c => c.clusterId)
  const modelJson = JSON.stringify({
    works: [
      {
        clusterIds: cIds,
        title: '修复跳转与落点偏差',
        goal: '点击目录后准确滚到目标轮次',
        state: 'active',
        statusSummary: '已修定位偏移，待验证长会话',
        nextStep: '在 200 轮会话里实测落点',
        decisions: [
          { summary: '改用精确 seq 锚点', rationale: '避免虚拟列表高度抖动', evidenceHandle: '〔11111111#1〕' },
        ],
      },
    ],
    chatClusterIds: [],
  })

  const refined = parseColdStartSemanticResult(`好的，整理如下：\n\`\`\`json\n${modelJson}\n\`\`\``, plan.clusters)
  assert.equal(refined.fallback, false)
  assert.equal(refined.works.length, 1)
  assert.equal(refined.works[0].title, '修复跳转与落点偏差')
  assert.equal(refined.works[0].nextStep, '在 200 轮会话里实测落点')
  assert.equal(refined.works[0].decisions.length, 1)
  assert.deepEqual(refined.works[0].clusterIds, cIds)

  // 模型输出乱码/空字符串 → 安全降级回硬信号聚类结果
  const degraded = parseColdStartSemanticResult('我无法判断这件事', plan.clusters)
  assert.equal(degraded.fallback, true)
  assert.equal(degraded.works.length, plan.clusters.length)
})

// ── 增量三级匹配：L1 / L2 / L3 ──────────────────────────────────────

test('增量 L1：handoffWorkId 100% 确定命中目标未收束事', () => {
  const w = createWork({ id: 'w-handoff', workspaceId: 'ws-1', title: '新抽屉改造', state: 'active' }, T0)
  const store = { ...emptyWorkStore('ws-1'), works: [w] }
  const incoming = seg({ id: 'seg-new', sessionId: 's-new', title: '继续推进', handoffWorkId: 'w-handoff', changedFiles: [] })

  const match = matchSegmentIncremental(store, incoming)
  assert.equal(match.action, 'attach')
  assert.equal(match.level, 'L1')
  assert.equal(match.workId, 'w-handoff')
  assert.equal(match.reason, 'handoff')
  assert.equal(match.confidence, 1)
})

test('增量 L1：fork 父会话与引用句柄直接命中未收束事', () => {
  const w1 = createWork({
    id: 'w-fork',
    workspaceId: 'ws-1',
    title: '索引加速',
    state: 'active',
    sessionIds: ['session-aaaa1111-0001'],
  }, T0)
  const w2 = createWork({
    id: 'w-handle',
    workspaceId: 'ws-1',
    title: '交接包格式',
    state: 'blocked',
    sessionIds: ['session-bbbb2222-0002'],
  }, T0)
  const store = { ...emptyWorkStore('ws-1'), works: [w1, w2] }

  const viaFork = matchSegmentIncremental(
    store,
    seg({ id: 'seg-f', sessionId: 'session-cccc3333', changedFiles: [] }),
    { forkParentSessionId: 'session-aaaa1111-0001' },
  )
  assert.equal(viaFork.action, 'attach')
  assert.equal(viaFork.level, 'L1')
  assert.equal(viaFork.workId, 'w-fork')
  assert.equal(viaFork.reason, 'fork')

  const viaHandle = matchSegmentIncremental(
    store,
    seg({ id: 'seg-h', sessionId: 'session-dddd4444', summary: '接上 〔bbbb2222#4〕 排查', changedFiles: [] }),
  )
  assert.equal(viaHandle.action, 'attach')
  assert.equal(viaHandle.level, 'L1')
  assert.equal(viaHandle.workId, 'w-handle')
  assert.equal(viaHandle.reason, 'handle')
})

test('增量 L2：与同工作区未收束事的业务文件显著重叠时自动挂载，排除通用配置文件', () => {
  const wAuth = createWork({
    id: 'w-auth',
    workspaceId: 'ws-1',
    title: '鉴权修复',
    state: 'active',
    files: ['src/auth.js', 'src/session-guard.js'],
  }, T0)
  const wPkg = createWork({
    id: 'w-pkg',
    workspaceId: 'ws-1',
    title: '依赖升级',
    state: 'active',
    files: ['package.json', 'README.md'],
  }, T0)
  const store = { ...emptyWorkStore('ws-1'), works: [wAuth, wPkg] }

  const hit = matchSegmentIncremental(
    store,
    seg({ id: 'seg-auth-next', sessionId: 's-x', changedFiles: ['src/auth.js', 'src/session-guard.js'] }),
  )
  assert.equal(hit.action, 'attach')
  assert.equal(hit.level, 'L2')
  assert.equal(hit.workId, 'w-auth')

  const genericOnly = matchSegmentIncremental(
    store,
    seg({ id: 'seg-generic', sessionId: 's-y', changedFiles: ['package.json', 'README.md'] }),
  )
  assert.notEqual(genericOnly.level, 'L2', '仅通用配置文件重叠不得触发 L2 挂载')
})

test('增量 L3：未命中 L1/L2 时最多筛选 10 件同工作区未收束事构造最小提示词并解析', () => {
  assert.equal(MAX_SEMANTIC_CANDIDATES, 10)
  const works = Array.from({ length: 14 }, (_, i) =>
    createWork({
      id: `w-${i + 1}`,
      workspaceId: 'ws-1',
      title: `任务 ${i + 1}`,
      goal: `目标 ${i + 1}`,
      state: i === 13 ? 'done' : 'active',
      lastActivityAt: T0 + i * 1000,
    }, T0),
  )
  const store = { ...emptyWorkStore('ws-1'), works }
  const incoming = seg({ id: 'seg-new', sessionId: 's-z', title: '继续做任务 12 的收尾', changedFiles: ['src/brand-new.js'] })

  const match = matchSegmentIncremental(store, incoming)
  assert.equal(match.action, 'need_semantic')
  assert.equal(match.level, 'L3')
  assert.equal(match.candidates.length, 10, '最多挑 10 件未收束事')
  assert.ok(match.candidates.every(w => w.state !== 'done'), 'done 不进 L3 语义挂载候选')

  const prompt = buildIncrementalMatchPrompt(incoming, match.candidates)
  assert.ok(prompt.system.includes('同一件事') || prompt.system.includes('匹配'))
  assert.ok(prompt.user.includes('继续做任务 12 的收尾'))

  const parsedMatch = parseIncrementalMatchResult('{"action":"attach","workId":"w-12","reason":"同一收尾工作"}', match.candidates)
  assert.equal(parsedMatch.action, 'attach')
  assert.equal(parsedMatch.workId, 'w-12')

  const parsedNew = parseIncrementalMatchResult('{"action":"new_work","reason":"全新功能"}', match.candidates)
  assert.equal(parsedNew.action, 'new_work')

  // 模型乱编不存在的 workId 时必须安全拒绝
  const parsedHallucination = parseIncrementalMatchResult('{"action":"attach","workId":"w-999","reason":"编造"}', match.candidates)
  assert.equal(parsedHallucination, null)
})

// ── 防污染红线：已确认 done 的老事绝不静默改写 ──────────────────────

test('防污染红线：L1 或 L2 命中已确认 done 的老事时返回 suggest_reopen 而非 attach', () => {
  const baseDone = createWork({
    id: 'w-done-confirmed',
    workspaceId: 'ws-1',
    title: '已完成支付对接',
    state: 'active',
    sessionIds: ['session-77778888-0001'],
    files: ['src/pay.js', 'src/webhook.js'],
  }, T0)
  let store = { ...emptyWorkStore('ws-1'), works: [baseDone] }
  store = applyUserConfirm(store, 'w-done-confirmed', { state: 'done' }, T0 + 1000)

  // L1 句柄命中已确认 done 老事
  const viaHandle = matchSegmentIncremental(
    store,
    seg({ id: 'seg-re', sessionId: 'session-99990000', summary: '针对 〔77778888#3〕 发现线上回调异常', changedFiles: [] }),
  )
  assert.equal(viaHandle.action, 'suggest_reopen')
  assert.equal(viaHandle.relatedDoneWorkId, 'w-done-confirmed')

  // L2 文件重叠命中已确认 done 老事
  const viaFiles = matchSegmentIncremental(
    store,
    seg({ id: 'seg-re-file', sessionId: 'session-99991111', changedFiles: ['src/pay.js', 'src/webhook.js'] }),
  )
  assert.equal(viaFiles.action, 'suggest_reopen')
  assert.equal(viaFiles.relatedDoneWorkId, 'w-done-confirmed')
})

test('增量防污染：子代理/自动化会话与已忽略段默认忽略', () => {
  const w = createWork({ id: 'w-1', workspaceId: 'ws-1', title: '主任务', files: ['src/a.js'] }, T0)
  const store = {
    ...emptyWorkStore('ws-1'),
    works: [w],
    dismissedSegments: { 'seg-dismissed': { at: T0 } },
  }

  const subRes = matchSegmentIncremental(store, seg({ id: 'seg-sub', isSubagent: true, changedFiles: ['src/a.js'] }))
  assert.equal(subRes.action, 'ignore')

  const dismissedRes = matchSegmentIncremental(store, seg({ id: 'seg-dismissed', changedFiles: ['src/a.js'] }))
  assert.equal(dismissedRes.action, 'ignore')
})

test('冷启动：忽略 dismissedSegments 且不合并不同文件的独立工作', () => {
  const s1 = seg({ id: 'seg-keep', sessionId: 's-1', title: '工作 A', changedFiles: ['src/a.js'] })
  const s2 = seg({ id: 'seg-dismissed', sessionId: 's-2', title: '被退回的话题', changedFiles: ['src/b.js'] })
  const plan = planColdStartWorks([s1, s2], {
    workspaceId: 'ws-1',
    now: T0 + DAY,
    dismissedSegments: { 'seg-dismissed': { at: T0 } },
  })
  assert.equal(plan.works.length, 1)
  assert.deepEqual(plan.works[0].segmentIds, ['seg-keep'])
  assert.ok(plan.ignoredSegments.includes('seg-dismissed'))
})

test('冷启动语义解析：模型漏掉某个合法簇时自动按硬信号补齐，不丢数据', () => {
  const s1 = seg({ id: 'seg-1', sessionId: 's-1', title: '任务一', changedFiles: ['src/one.js'] })
  const s2 = seg({ id: 'seg-2', sessionId: 's-2', title: '任务二', changedFiles: ['src/two.js'] })
  const plan = planColdStartWorks([s1, s2], { workspaceId: 'ws-1', now: T0 + DAY })
  assert.equal(plan.clusters.length, 2)

  // 模型只返回了 cl-1，漏了 cl-2
  const partial = JSON.stringify({
    works: [{ clusterIds: [plan.clusters[0].clusterId], title: '精化任务一', goal: '目标一', state: 'active', statusSummary: '进展', nextStep: '下一步' }],
    chatClusterIds: [],
  })
  const parsed = parseColdStartSemanticResult(partial, plan.clusters)
  assert.equal(parsed.fallback, false)
  assert.equal(parsed.works.length, 2, '漏掉的簇应按硬信号补齐')
})

test('增量 L1：handoffWorkId 指向已确认 done 老事时同样触发 suggest_reopen', () => {
  const w = createWork({ id: 'w-done', workspaceId: 'ws-1', title: '老需求', state: 'active' }, T0)
  let store = { ...emptyWorkStore('ws-1'), works: [w] }
  store = applyUserConfirm(store, 'w-done', { state: 'done' }, T0 + 1000)

  const match = matchSegmentIncremental(store, seg({ id: 'seg-x', handoffWorkId: 'w-done', changedFiles: [] }))
  assert.equal(match.action, 'suggest_reopen')
  assert.equal(match.relatedDoneWorkId, 'w-done')
})

test('增量匹配隔离不同 workspaceId，避免跨工作区串单', () => {
  const wOther = createWork({ id: 'w-other', workspaceId: 'ws-other', title: '别的工作区', state: 'active', files: ['src/auth.js'] }, T0)
  const store = { ...emptyWorkStore('ws-1'), works: [wOther] }
  const match = matchSegmentIncremental(store, seg({ id: 'seg-local', workspaceId: 'ws-1', changedFiles: ['src/auth.js'] }))
  assert.equal(match.action, 'new_work', '不同 workspaceId 的事不得被匹配')
})

console.log(`\n  ${passed} passed, ${failures.length} failed\n`)
if (failures.length > 0) process.exitCode = 1
