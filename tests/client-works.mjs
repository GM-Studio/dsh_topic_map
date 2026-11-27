/**
 * 「续接」首页客户端测试：
 * - WORKVIEW 嵌入段真实可用性；
 * - 4 页签清单（［续接］［历史］［统计］［设置］）与默认首开续接；
 * - WorksTabBody 辅助函数（normalizeWorksPayload / parseWorkEvidenceHandle / buildPromoteSegmentPayload）；
 * - WorksTabBody 渲染与交互：首帧快照、待核对/重开/拐点轻确认、4 行窄卡片、展开详情、
 *   回到现场（定位 + 预填草稿不发送）、新会话交接（startSession + work-handoff-bind）、
 *   ✓ 已完成、退回话题、已收束折叠区重开、空态跳历史；
 * - 历史轨「段 → 轮次」两级目录渲染、点段头跳首轮与最小化细轨保持纯刻度。
 *
 * Run: node tests/client-works.mjs
 */

import { strict as assert } from 'node:assert'
import * as WORKVIEW_SRC from '../lib/work-view.js'
import * as RAILVIEW_SRC from '../lib/rail-view.js'
import {
  readClient,
  extractFunction,
  extractAssignment,
  renderComponent,
  makeFetch,
  makeRunner,
  byClass,
  byData,
  textOf,
  click,
  change,
} from './client-harness.mjs'

const src = readClient()
const { test, finish } = makeRunner('client-works')

function evalEmbedded(name) {
  const re = new RegExp(`var ${name} = \\(function \\(\\)[\\s\\S]*?\\n    \\}\\)\\(\\)`)
  const m = src.match(re)
  assert.ok(m !== null, `client.js 里找不到 ${name} 嵌入段`)
  const mod = { exports: {} }
  new Function('module', 'exports', `${m[0]}\n;module.exports = ${name};`) (mod, mod.exports)
  return mod.exports
}

const WORKVIEW = evalEmbedded('WORKVIEW')
const RAILVIEW = evalEmbedded('RAILVIEW')

const RIGHT_TABS = new Function(
  'WORKS_ID', 'WORKS_KIND', 'WORKS_TITLE',
  'HISTORY_ID', 'HISTORY_KIND', 'HISTORY_TITLE',
  'STATS_ID', 'STATS_KIND', 'STATS_TITLE',
  'SETTINGS_ID', 'SETTINGS_KIND', 'SETTINGS_TITLE',
  `var RIGHT_TABS = ${extractAssignment(src, 'RIGHT_TABS')};return RIGHT_TABS`,
)(
  'dsh-topic-map:works', 'topic-map-works', '续接',
  'dsh-topic-map:history', 'topic-map-history', '历史检索',
  'dsh-topic-map:stats', 'topic-map-stats', '统计',
  'dsh-topic-map:settings', 'topic-map-settings', '设置',
)

const WORKS_HELPERS_SOURCE = [
  extractFunction(src, 'normalizeWorksPayload'),
  extractFunction(src, 'parseWorkEvidenceHandle'),
  extractFunction(src, 'resolveWorkEvidenceSession'),
  extractFunction(src, 'buildPromoteSegmentPayload'),
  extractFunction(src, 'extractStartedSessionId'),
].join('\n')

const WORKS_HELPERS = new Function(
  `${WORKS_HELPERS_SOURCE};return {
    normalizeWorksPayload,
    parseWorkEvidenceHandle,
    resolveWorkEvidenceSession,
    buildPromoteSegmentPayload,
    extractStartedSessionId,
  }`,
)()

const WORKS_COMPONENT_SOURCE = [
  extractFunction(src, 'requestTopicMap'),
  extractFunction(src, 'RightTabStrip'),
  extractFunction(src, 'normalizeWorksPayload'),
  extractFunction(src, 'parseWorkEvidenceHandle'),
  extractFunction(src, 'resolveWorkEvidenceSession'),
  extractFunction(src, 'extractStartedSessionId'),
  extractFunction(src, 'WorksTabBody'),
].join('\n')

const NOW = Date.now()

function sampleWorksResponse() {
  return {
    workspaceId: 'ws-1',
    initialized: true,
    refining: false,
    pendingReviewCount: 1,
    latestInflection: {
      kind: 'likely_settled_or_blocked',
      workId: 'w-1',
      title: '重构客户端抽屉',
      suggestedState: 'done',
    },
    reopenSuggestion: {
      relatedDoneWorkId: 'w-old',
      relatedDoneWorkTitle: '修复索引锁死',
      reason: 'files',
      sharedFiles: ['lib/client.js'],
    },
    cards: {
      unresolved: [
        {
          id: 'w-1',
          title: '重构客户端抽屉',
          state: 'active',
          confidence: 'inferred',
          pinned: false,
          reviewStatus: 'pending',
          statusLine: '已接入 WORKVIEW，正在写续接页组件',
          nextStep: '补齐 client-works 行为单测',
          lastActivityAt: NOW - 5 * 60 * 1000,
        },
        {
          id: 'w-2',
          title: '排查历史轨虚拟窗口错位',
          state: 'blocked',
          confidence: 'confirmed',
          pinned: true,
          reviewStatus: 'reviewed',
          statusLine: '卡在虚拟滚动回退时段头重复闪烁',
          nextStep: '检查 rowsDataSignature 签名稳定性',
          lastActivityAt: NOW - 30 * 60 * 1000,
        },
      ],
      settled: [
        {
          id: 'w-old',
          title: '修复索引锁死',
          state: 'done',
          confidence: 'confirmed',
          pinned: false,
          reviewStatus: 'reviewed',
          statusLine: '已改成按工作区串行写盘',
          nextStep: '',
          lastActivityAt: NOW - 2 * 24 * 60 * 60 * 1000,
        },
      ],
      pendingReviewCount: 1,
    },
    works: [
      {
        id: 'w-1',
        title: '重构客户端抽屉',
        state: 'active',
        stateSource: 'inferred',
        sessionIds: ['session-abcdef12', 'session-99998888'],
        segmentIds: ['seg-a'],
        files: ['lib/client.js', 'scripts/build-theme.mjs'],
        decisions: [
          { id: 'd-1', summary: '采用 4 行窄卡片', rationale: '360px 抽屉首屏高信噪比', status: 'active', evidenceHandle: '〔abcdef12#3〕', at: NOW - 10 * 60 * 1000 },
          { id: 'd-0', summary: '旧版双模式开关', rationale: '心智负担高', status: 'superseded', evidenceHandle: '〔abcdef12#1〕', at: NOW - 20 * 60 * 1000 },
        ],
      },
      {
        id: 'w-2',
        title: '排查历史轨虚拟窗口错位',
        state: 'blocked',
        stateSource: 'confirmed',
        sessionIds: ['session-22223333'],
        files: ['lib/rail-view.js'],
        decisions: [],
      },
      {
        id: 'w-old',
        title: '修复索引锁死',
        state: 'done',
        stateSource: 'confirmed',
        sessionIds: ['session-old00001'],
        files: ['lib/client.js'],
        decisions: [],
      },
    ],
  }
}

async function mountWorks(options) {
  const opts = options || {}
  const located = []
  const composed = []
  const copied = []
  const started = []
  const openedTabs = []
  let currentPayload = opts.payload !== undefined ? opts.payload : sampleWorksResponse()

  const fake = makeFetch(({ action, body }) => {
    if (typeof opts.onFetch === 'function') {
      const custom = opts.onFetch(action, body)
      if (custom !== undefined) return custom
    }
    if (action === 'works') return { value: currentPayload }
    if (action === 'works-scan') return { value: currentPayload }
    if (action === 'work-confirm') {
      if (currentPayload && currentPayload.cards) {
        currentPayload = Object.assign({}, currentPayload, { latestInflection: null })
      }
      return { value: { work: { id: body.workId }, cards: currentPayload.cards } }
    }
    if (action === 'work-dismiss') return { value: { cards: currentPayload.cards } }
    if (action === 'work-review-all') {
      if (currentPayload && currentPayload.cards) {
        const nextUnresolved = currentPayload.cards.unresolved.map(c => Object.assign({}, c, { reviewStatus: 'reviewed', confidence: 'confirmed' }))
        currentPayload = Object.assign({}, currentPayload, {
          pendingReviewCount: 0,
          cards: Object.assign({}, currentPayload.cards, { unresolved: nextUnresolved, pendingReviewCount: 0 }),
        })
      }
      return { value: { confirmedCount: 1, cards: currentPayload.cards } }
    }
    if (action === 'work-inflection-dismiss') return { value: { dismissed: true } }
    if (action === 'work-handoff') {
      if (body.mode === 'same-session') {
        return {
          value: {
            mode: 'same-session',
            targetSessionId: 'session-abcdef12',
            targetTurn: 3,
            targetSeq: 19,
            drifted: true,
            draft: '〔work:w-1〕继续推进：补齐 client-works 行为单测',
          },
        }
      }
      return {
        value: {
          mode: 'new-session',
          workspaceId: 'ws-1',
          workHandle: '〔work:w-1〕',
          draft: '【交接】重构客户端抽屉\n下一步：补齐 client-works 行为单测',
        },
      }
    }
    if (action === 'work-handoff-bind') return { value: { bound: { sessionId: body.sessionId, workId: body.workId } } }
    return { ok: false, error: 'unexpected ' + action }
  })

  const uiWorkspace = opts.uiWorkspace !== undefined
    ? opts.uiWorkspace
    : {
        startSession(wsId, startOpts) {
          started.push({ wsId, startOpts })
          return Promise.resolve({ sessionId: 'session-new-handoff-1' })
        },
      }

  const runtime = await renderComponent(
    WORKS_COMPONENT_SOURCE,
    'WorksTabBody',
    [
      'WORKVIEW', 'RIGHT_TABS', 'WORKS_KIND', 'WORKS_TITLE', 'HISTORY_KIND',
      'fetch', 'errorText', 'useTopicMapTheme', 'currentWorkspaceId',
      'locateHistoryTurn', 'historyWriteToComposer', 'historyCopyText',
      'UI_WORKSPACE_SERVICE', 'drawerCurrentSessionId',
    ],
    [
      WORKVIEW,
      RIGHT_TABS,
      'topic-map-works',
      '续接',
      'topic-map-history',
      fake.fetch,
      err => String(err && err.message ? err.message : err),
      function () {},
      () => Promise.resolve('ws-1'),
      (sid, turn, seq, cur) => {
        located.push({ sid, turn, seq, cur })
        return Promise.resolve({ ok: true })
      },
      (text, writeOpts) => {
        composed.push({ text, writeOpts })
        return Promise.resolve({ ok: true, method: 'dom' })
      },
      text => {
        copied.push(text)
        return Promise.resolve(true)
      },
      uiWorkspace,
      () => 'session-abcdef12',
    ],
    {
      sessionId: 'session-abcdef12',
      openTab: kind => { openedTabs.push(kind) },
      readonly: opts.readonly === true,
    },
  )

  return { runtime, calls: fake.calls, located, composed, copied, started, openedTabs }
}

await test('WORKVIEW 与 RAILVIEW.segmentGroupsOf 嵌入段可用且导出完整', async () => {
  for (const name of ['formatWorkCard', 'workBoardModel', 'formatInflectionBanner', 'formatReopenBanner', 'formatRelativeTime']) {
    assert.equal(typeof WORKVIEW[name], 'function', 'WORKVIEW.' + name)
    assert.equal(typeof WORKVIEW_SRC[name], 'function')
  }
  assert.equal(typeof RAILVIEW.segmentGroupsOf, 'function', 'RAILVIEW.segmentGroupsOf 必须导出')
  assert.equal(typeof RAILVIEW_SRC.segmentGroupsOf, 'function')
})

await test('RIGHT_TABS 4 页签顺序：［续接］［历史］［统计］［设置］', async () => {
  assert.deepEqual(
    RIGHT_TABS.map(tab => [tab.id, tab.kind, tab.title]),
    [
      ['dsh-topic-map:works', 'topic-map-works', '续接'],
      ['dsh-topic-map:history', 'topic-map-history', '历史'],
      ['dsh-topic-map:stats', 'topic-map-stats', '统计'],
      ['dsh-topic-map:settings', 'topic-map-settings', '设置'],
    ],
  )
  assert.ok(src.includes('dsh-topic-map:works'))
  assert.ok(src.includes("menuItem('promote-work', '★', '转为事'"), '历史页 ⋯ 菜单应有「转为事」入口')
})

await test('WorksTabBody 辅助函数：载荷归一、证据句柄解析与转为事段构造', async () => {
  const norm = WORKS_HELPERS.normalizeWorksPayload(sampleWorksResponse())
  assert.equal(norm.unresolved.length, 2)
  assert.equal(norm.settled.length, 1)
  assert.equal(norm.pendingReviewCount, 1)
  assert.equal(norm.reopenSuggestions.length, 1)
  assert.equal(norm.inflection.workId, 'w-1')
  assert.equal(norm.unresolved[0].decisions.length, 2, '应把 works 里的决策合并进卡片')
  assert.deepEqual(norm.unresolved[0].files, ['lib/client.js', 'scripts/build-theme.mjs'])

  assert.deepEqual(WORKS_HELPERS.parseWorkEvidenceHandle('〔abcdef12#7〕'), { prefix: 'abcdef12', turn: 7 })
  assert.equal(WORKS_HELPERS.parseWorkEvidenceHandle('无效'), null)
  assert.equal(
    WORKS_HELPERS.resolveWorkEvidenceSession('abcdef12', { segments: [{ sessionId: 'session-abcdef12' }] }),
    'session-abcdef12',
  )

  const seg = WORKS_HELPERS.buildPromoteSegmentPayload({
    sessionId: 'session-12345678',
    turn: 5,
    promptHead: '优化索引重建性能',
    time: 1700000000000,
  })
  assert.equal(seg.sessionId, 'session-12345678')
  assert.equal(seg.startTurn, 5)
  assert.equal(seg.endTurn, 5)
  assert.equal(seg.title, '优化索引重建性能')
  assert.deepEqual(seg.evidenceHandles, ['〔12345678#5〕'])

  assert.equal(WORKS_HELPERS.extractStartedSessionId('s-direct'), 's-direct')
  assert.equal(WORKS_HELPERS.extractStartedSessionId({ sessionId: 's-obj' }), 's-obj')
  assert.equal(WORKS_HELPERS.extractStartedSessionId({ session: { id: 's-nested' } }), 's-nested')
})

await test('WorksTabBody 首帧渲染：横幅、4 行卡片排序（置顶+卡住优先）与已收束折叠区', async () => {
  const { runtime, calls } = await mountWorks()
  assert.ok(calls.some(c => c.action === 'works'), '打开时立即调 /works')
  assert.equal(byData(runtime.tree, 'data-banner', 'pending-review').length, 1)
  assert.equal(byData(runtime.tree, 'data-banner', 'reopen').length, 1)
  assert.equal(byData(runtime.tree, 'data-banner', 'inflection').length, 1)

  const cards = byClass(runtime.tree, 'dsh_tm_workcard')
  assert.equal(cards.length, 2, '只展示未收束的事，已收束默认折叠')
  assert.equal(cards[0].props['data-work-id'], 'w-2', '置顶 + blocked 排第一')
  assert.equal(cards[0].props['data-confidence'], 'confirmed')
  assert.equal(cards[1].props['data-work-id'], 'w-1')
  assert.equal(cards[1].props['data-confidence'], 'inferred')

  const settledToggle = byData(runtime.tree, 'data-action', 'toggle-settled')[0]
  assert.ok(textOf(settledToggle).includes('已收束（1）'))
  click(settledToggle)
  await runtime.settle()
  assert.equal(byClass(runtime.tree, 'dsh_tm_workcard').length, 3, '展开后可见已收束的事')
})

await test('拐点轻确认动作：确认已完成调 /work-confirm，忽略调 /work-inflection-dismiss', async () => {
  const { runtime, calls } = await mountWorks()
  const ignoreBtn = byData(runtime.tree, 'data-inflection-action', 'ignore')[0]
  click(ignoreBtn)
  await runtime.settle()
  assert.ok(calls.some(c => c.action === 'work-inflection-dismiss'))
  assert.equal(byData(runtime.tree, 'data-banner', 'inflection').length, 0, '忽略后轻条消失')

  const m2 = await mountWorks()
  const confirmDoneBtn = byData(m2.runtime.tree, 'data-inflection-action', 'confirm_done')[0]
  click(confirmDoneBtn)
  await m2.runtime.settle()
  const confirmCall = m2.calls.find(c => c.action === 'work-confirm')
  assert.ok(confirmCall !== undefined)
  // requesterSessionId 是 ADR-0011 加的：后端据此判断是否跨区写。
  assert.deepEqual(confirmCall.body, {
    workspaceId: 'ws-1',
    workId: 'w-1',
    patch: { state: 'done', reviewStatus: 'reviewed' },
    requesterSessionId: 'session-abcdef12',
  })
})

await test('重开老事轻提示条：点击 [关联重开] 调 /work-confirm(active)', async () => {
  const { runtime, calls } = await mountWorks()
  const reopenBtn = byData(runtime.tree, 'data-reopen-action', 'reopen_link')[0]
  click(reopenBtn)
  await runtime.settle()
  const call = calls.find(c => c.action === 'work-confirm' && c.body.workId === 'w-old')
  assert.ok(call !== undefined)
  assert.equal(call.body.patch.state, 'active')
  assert.equal(byData(runtime.tree, 'data-banner', 'reopen').length, 0)
})

await test('三层交接动作：回到现场（定位+raw草稿不发送）与新会话交接（startSession+bind）', async () => {
  const { runtime, calls, located, composed, started } = await mountWorks()
  const cards = byClass(runtime.tree, 'dsh_tm_workcard')
  const w1Card = cards.find(c => c.props['data-work-id'] === 'w-1')

  // 回到现场
  const resumeBtn = byData(w1Card, 'data-action', 'resume')[0]
  click(resumeBtn)
  await runtime.settle()
  const sameCall = calls.find(c => c.action === 'work-handoff' && c.body.mode === 'same-session')
  assert.ok(sameCall !== undefined)
  assert.equal(located.length, 1)
  assert.equal(located[0].sid, 'session-abcdef12')
  assert.equal(located[0].turn, 3)
  assert.equal(located[0].seq, 19)
  assert.equal(composed.length, 1)
  assert.equal(composed[0].writeOpts.raw, true, '草稿直填输入框不额外套【】')
  assert.ok(composed[0].text.includes('〔work:w-1〕'))

  // 新会话交接
  const handoffBtn = byData(w1Card, 'data-action', 'handoff')[0]
  click(handoffBtn)
  await runtime.settle()
  const newCall = calls.find(c => c.action === 'work-handoff' && c.body.mode === 'new-session')
  assert.ok(newCall !== undefined)
  assert.equal(started.length, 1)
  assert.equal(started[0].wsId, 'ws-1')
  assert.equal(started[0].startOpts.whenDraftExists, 'replace')
  assert.ok(started[0].startOpts.prompt.includes('重构客户端抽屉'))
  const bindCall = calls.find(c => c.action === 'work-handoff-bind')
  assert.ok(bindCall !== undefined, '拿到新 sessionId 后应立即调用 work-handoff-bind')
  assert.deepEqual(bindCall.body, { workspaceId: 'ws-1', workId: 'w-1', sessionId: 'session-new-handoff-1' })
})

await test('新会话交接降级：无 startSession 时写入剪贴板', async () => {
  const { runtime, copied } = await mountWorks({ uiWorkspace: null })
  const w1Card = byClass(runtime.tree, 'dsh_tm_workcard').find(c => c.props['data-work-id'] === 'w-1')
  click(byData(w1Card, 'data-action', 'handoff')[0])
  await runtime.settle()
  assert.equal(copied.length, 1)
  assert.ok(copied[0].includes('重构客户端抽屉'))
})

await test('卡片详情展开：决策序列（现行/已否决+证据跳转）、行内改下一步、退回话题', async () => {
  const { runtime, calls, located } = await mountWorks()
  const w1Card = byClass(runtime.tree, 'dsh_tm_workcard').find(c => c.props['data-work-id'] === 'w-1')
  click(byData(w1Card, 'data-action', 'expand')[0])
  await runtime.settle()

  const detail = byData(runtime.tree, 'data-work-detail', 'w-1')[0]
  assert.ok(detail !== undefined)
  assert.ok(textOf(detail).includes('采用 4 行窄卡片'))
  assert.ok(textOf(detail).includes('旧版双模式开关'))
  assert.ok(textOf(detail).includes('lib/client.js'))

  // 点击证据句柄跳转
  const handleBtn = byClass(detail, 'dsh_tm_workhandle')[0]
  click(handleBtn)
  await runtime.settle()
  assert.equal(located.length, 1)
  assert.equal(located[0].sid, 'session-abcdef12')
  assert.equal(located[0].turn, 3)

  // 行内修改下一步
  const input = byData(detail, 'data-work-nextstep', 'w-1')[0]
  change(input, '运行全套校验脚本')
  await runtime.settle()
  click(byData(runtime.tree, 'data-action', 'save-nextstep')[0])
  await runtime.settle()
  const saveCall = calls.find(c => c.action === 'work-confirm' && c.body.patch.nextStep === '运行全套校验脚本')
  assert.ok(saveCall !== undefined)

  // 退回话题
  click(byData(runtime.tree, 'data-action', 'dismiss-work')[0])
  await runtime.settle()
  assert.ok(calls.some(c => c.action === 'work-dismiss' && c.body.workId === 'w-1'))
})

await test('空态与一键跳历史：区分冷启动整理中与暂无未收束的事', async () => {
  const cold = await mountWorks({
    payload: { workspaceId: 'ws-1', initialized: false, refining: true, cards: { unresolved: [], settled: [], pendingReviewCount: 0 } },
  })
  assert.equal(byData(cold.runtime.tree, 'data-empty-kind', 'cold_start').length, 1)

  const idle = await mountWorks({
    payload: { workspaceId: 'ws-1', initialized: true, refining: false, cards: { unresolved: [], settled: [], pendingReviewCount: 0 } },
  })
  assert.equal(byData(idle.runtime.tree, 'data-empty-kind', 'no_unresolved').length, 1)
  click(byData(idle.runtime.tree, 'data-action', 'open-history')[0])
  assert.deepEqual(idle.openedTabs, ['topic-map-history'])
})

await test('核对模式交互：核对说明条、卡片专属核对动作、单条核对递减清零与一键全部确认无误', async () => {
  const base = sampleWorksResponse()
  // 两张 pending 卡片便于测试递减
  base.pendingReviewCount = 2
  base.cards.pendingReviewCount = 2
  base.cards.unresolved[1].reviewStatus = 'pending'
  base.cards.unresolved[1].confidence = 'inferred'

  let livePayload = JSON.parse(JSON.stringify(base))
  const { runtime, calls } = await mountWorks({
    payload: livePayload,
    onFetch(action, body) {
      if (action === 'works') return { value: livePayload }
      if (action === 'work-confirm') {
        livePayload = JSON.parse(JSON.stringify(livePayload))
        const target = livePayload.cards.unresolved.find(c => c.id === body.workId)
        if (target) {
          if (body.patch && body.patch.state) target.state = body.patch.state
          target.reviewStatus = 'reviewed'
          target.confidence = 'confirmed'
        }
        const remaining = livePayload.cards.unresolved.filter(c => (c.state === 'active' || c.state === 'blocked') && c.reviewStatus === 'pending')
        livePayload.cards.unresolved = livePayload.cards.unresolved.filter(c => c.state === 'active' || c.state === 'blocked')
        livePayload.pendingReviewCount = remaining.length
        livePayload.cards.pendingReviewCount = remaining.length
        return { value: { work: target || { id: body.workId }, cards: livePayload.cards } }
      }
      if (action === 'work-review-all') {
        livePayload = JSON.parse(JSON.stringify(livePayload))
        let count = 0
        for (const c of livePayload.cards.unresolved) {
          if (c.reviewStatus === 'pending') {
            c.reviewStatus = 'reviewed'
            c.confidence = 'confirmed'
            count += 1
          }
        }
        livePayload.pendingReviewCount = 0
        livePayload.cards.pendingReviewCount = 0
        return { value: { confirmedCount: count, cards: livePayload.cards } }
      }
      return undefined
    },
  })

  // 横幅应含「开始逐条核对」与「全部确认无误」
  const openReviewBtn = byData(runtime.tree, 'data-action', 'open-review')[0]
  assert.ok(openReviewBtn !== undefined)
  assert.ok(textOf(openReviewBtn).includes('开始逐条核对'))
  assert.ok(typeof openReviewBtn.props.title === 'string' && openReviewBtn.props.title.length > 0, '核对按钮应有 tooltip')
  const scanBtn = byData(runtime.tree, 'data-action', 'works-scan')[0]
  assert.ok(typeof scanBtn.props.title === 'string' && scanBtn.props.title.length > 0, '重新盘点按钮应有 tooltip')

  // 进入核对模式
  click(openReviewBtn)
  await runtime.settle()
  assert.equal(byData(runtime.tree, 'data-review-guide', '1').length, 1, '开启核对模式后应显示核对说明条')
  assert.equal(byData(runtime.tree, 'data-action', 'confirm-all-review').length, 1, '应提供全部确认无误按钮')
  assert.ok(textOf(byData(runtime.tree, 'data-action', 'open-review')[0]).includes('退出核对'))

  // 卡片进入核对态：高亮属性 + 专属动作 [✓ 确认还在做] [✓ 已完成] [不算事]
  const reviewCards = byClass(runtime.tree, 'dsh_tm_workcard')
  assert.equal(reviewCards.length, 2)
  assert.equal(reviewCards[0].props['data-reviewing'], '1')
  assert.equal(byData(reviewCards[0], 'data-action', 'review-keep').length, 1)
  assert.equal(byData(reviewCards[0], 'data-action', 'review-done').length, 1)
  assert.equal(byData(reviewCards[0], 'data-action', 'review-dismiss').length, 1)

  // 点击第一张「✓ 确认还在做」，立即从待核对列表消失、数字递减到 1
  click(byData(reviewCards[0], 'data-action', 'review-keep')[0])
  await runtime.settle()
  const keepCall = calls.find(c => c.action === 'work-confirm' && c.body.workId === reviewCards[0].props['data-work-id'])
  assert.ok(keepCall !== undefined)
  assert.equal(keepCall.body.patch.reviewStatus, 'reviewed')
  assert.equal(byClass(runtime.tree, 'dsh_tm_workcard').length, 1, '核对完一张应立即从待核对列表消失')

  // 点击「全部确认无误」，清零并退出核对模式、提示全部核对完成
  click(byData(runtime.tree, 'data-action', 'confirm-all-review')[0])
  await runtime.settle()
  assert.ok(calls.some(c => c.action === 'work-review-all'))
  assert.equal(byData(runtime.tree, 'data-banner', 'pending-review').length, 0)
  const notices = byClass(runtime.tree, 'dsh_tm_worksnotice')
  assert.ok(notices.length > 0 && textOf(notices[0]).includes('核对完成'))
})

await test('重新盘点与后台精化轮询：传 asyncRefine:true、展示统计反馈与 refining 状态条并自动刷新', async () => {
  let pollCount = 0
  const base = sampleWorksResponse()
  const scanFastPayload = Object.assign({}, JSON.parse(JSON.stringify(base)), {
    refining: true,
    stats: { sessionsScanned: 12, segmentsCount: 18, unresolvedCount: 2, settledCount: 1, semanticUsed: false },
    lastScanSummary: { sessionsScanned: 12, segmentsCount: 18, unresolvedCount: 2, settledCount: 1, semanticUsed: false, at: NOW },
  })
  const refinedPayload = JSON.parse(JSON.stringify(base))
  refinedPayload.refining = false
  refinedPayload.cards.unresolved[0].title = '深度提炼后的标题'
  refinedPayload.lastScanSummary = { sessionsScanned: 12, segmentsCount: 18, unresolvedCount: 2, settledCount: 1, semanticUsed: true, at: NOW + 3000 }

  let mode = 'initial'
  const { runtime, calls } = await mountWorks({
    payload: base,
    onFetch(action) {
      if (action === 'works-scan') {
        mode = 'refining'
        return { value: scanFastPayload }
      }
      if (action === 'works') {
        if (mode === 'initial') return { value: base }
        pollCount += 1
        return { value: refinedPayload }
      }
      return undefined
    },
  })

  // 点击重新盘点
  click(byData(runtime.tree, 'data-action', 'works-scan')[0])
  await runtime.settle()

  const scanCall = calls.find(c => c.action === 'works-scan')
  assert.ok(scanCall !== undefined)
  assert.equal(scanCall.body.force, true)
  assert.equal(scanCall.body.asyncRefine, true, '客户端重新盘点必须传 asyncRefine:true')

  // 立即展示规则盘点统计反馈与 refining 状态条
  const notices = byClass(runtime.tree, 'dsh_tm_worksnotice')
  assert.ok(notices.length > 0, '应展示盘点统计反馈条')
  assert.ok(textOf(notices[0]).includes('12'), '提示应包含扫描会话数')
  assert.ok(textOf(notices[0]).includes('2'), '提示应包含未收束件数')
  assert.equal(byData(runtime.tree, 'data-banner', 'refining').length, 1, 'refining:true 时应显示正在深度提炼状态条')

  // 等待一次轮询（测试环境可覆盖轮询间隔或等真实 2.5s；这里等 2.65s 校验真实轮询）
  await new Promise(r => setTimeout(r, 2650))
  await runtime.settle()
  assert.ok(pollCount >= 1, 'refining:true 时应自动轮询 POST /works')
  assert.equal(byData(runtime.tree, 'data-banner', 'refining').length, 0, '精化完成后应隐藏 refining 状态条')
  assert.ok(textOf(runtime.tree).includes('深度提炼后的标题'), '精化完成后卡片应自动无闪烁刷新')
  const doneNotices = byClass(runtime.tree, 'dsh_tm_worksnotice')
  assert.ok(doneNotices.length > 0 && textOf(doneNotices[0]).includes('深度提炼已完成'))
})

await test('历史轨两级目录：标准/宽档渲染段头且点段头跳首轮，细轨隐藏段头', async () => {
  const start = src.indexOf('    var RAIL_NATIVE_KEY')
  const moduleStart = src.indexOf('    var RAILTAKE = (function () {', start)
  const tail = src.indexOf('\n    })()', moduleStart)
  const helperStart = src.indexOf('    function resolveActiveTurn')
  const helperEnd = src.indexOf('    var HISTORY_CATEGORY_EMPTY_TEXT', helperStart)
  const code = src.slice(helperStart, helperEnd) + '\n' + src.slice(start, tail + '\n    })()'.length)

  function matches(node, selector) {
    return selector.split(',').some(raw => {
      const s = raw.trim()
      if (s === '.dsh_tm_railrow') return String(node.className || '').split(/\s+/).includes('dsh_tm_railrow')
      if (s === '.dsh_tm_railseg') return String(node.className || '').split(/\s+/).includes('dsh_tm_railseg')
      if (s === '.dsh_tm_rail') return String(node.className || '').split(/\s+/).includes('dsh_tm_rail')
      if (s === 'button[data-index]') return node.tagName === 'BUTTON' && node.getAttribute('data-index') !== null
      if (s === 'button[aria-current="true"]') return node.tagName === 'BUTTON' && node.getAttribute('aria-current') === 'true'
      if (s === '[data-conversation-session]') return node.getAttribute('data-conversation-session') !== null
      if (s === '[data-conversation-scroll]') return node.getAttribute('data-conversation-scroll') !== null
      if (s === '[data-conversation-scroll] nav[aria-label="轮次导航"]') {
        return node.tagName === 'NAV' && node.getAttribute('aria-label') === '轮次导航'
      }
      return false
    })
  }
  function collect(nodes, sel, out = []) {
    for (const n of nodes) {
      if (matches(n, sel)) out.push(n)
      if (n.children) collect(n.children, sel, out)
    }
    return out
  }
  class El {
    constructor(tag) {
      this.tagName = tag.toUpperCase()
      this.children = []
      this.attrs = new Map()
      this.style = { setProperty(k, v) { this[k] = v }, removeProperty(k) { delete this[k] } }
      this.className = ''
      this.textContent = ''
      this.parentElement = null
      this.listeners = new Map()
      this.title = ''
      this.type = ''
      this.scrollTop = 0
      this.clientHeight = 240
      this.offsetTop = 0
      this.offsetHeight = 20
    }
    get firstChild() { return this.children[0] || null }
    get isConnected() { return true }
    appendChild(c) { return this.insertBefore(c, null) }
    insertBefore(c, ref) {
      if (c.parentElement) c.parentElement.removeChild(c)
      const i = ref ? this.children.indexOf(ref) : -1
      if (i >= 0) this.children.splice(i, 0, c)
      else this.children.push(c)
      c.parentElement = this
      return c
    }
    removeChild(c) {
      const i = this.children.indexOf(c)
      if (i >= 0) this.children.splice(i, 1)
      c.parentElement = null
      return c
    }
    setAttribute(k, v) { this.attrs.set(k, String(v)) }
    getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null }
    removeAttribute(k) { this.attrs.delete(k) }
    hasAttribute(k) { return this.attrs.has(k) }
    addEventListener(t, fn) { const l = this.listeners.get(t) || []; l.push(fn); this.listeners.set(t, l) }
    removeEventListener(t, fn) { const l = this.listeners.get(t) || []; const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1) }
    dispatchEvent(e) {
      let cur = this
      while (cur) {
        const l = cur.listeners.get(e.type) || []
        for (const fn of l) fn({ ...e, target: this, currentTarget: cur, stopPropagation() {}, preventDefault() {} })
        cur = cur.parentElement
      }
    }
    querySelectorAll(sel) { return collect(this.children, sel) }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null }
    closest(sel) { let n = this; while (n) { if (matches(n, sel)) return n; n = n.parentElement } return null }
    getBoundingClientRect() { return { width: 1000, height: 700, top: 0, bottom: 700, left: 0, right: 1000 } }
  }

  const body = new El('body')
  const root = new El('div')
  root.setAttribute('data-conversation-session', 'sess-seg')
  const scroller = new El('div')
  scroller.setAttribute('data-conversation-scroll', '1')
  const slot = new El('div')
  const nav = new El('nav')
  nav.setAttribute('aria-label', '轮次导航')
  for (let i = 0; i < 4; i += 1) {
    const btn = new El('button')
    btn.setAttribute('data-index', String(i))
    btn.setAttribute('aria-label', '跳转到第 ' + (i + 1) + ' 轮')
    if (i === 2) btn.setAttribute('aria-current', 'true')
    nav.appendChild(btn)
  }
  slot.appendChild(nav)
  scroller.appendChild(slot)
  root.appendChild(scroller)
  body.appendChild(root)

  const doc = {
    body,
    head: new El('head'),
    createElement: tag => new El(tag),
    querySelectorAll: sel => collect([body], sel),
    querySelector: sel => collect([body], sel)[0] || null,
    getElementById: () => null,
    addEventListener() {},
    removeEventListener() {},
  }
  const timers = new Map()
  let nextTimerId = 1
  const win = {
    innerWidth: 1280,
    innerHeight: 720,
    setTimeout(fn) {
      const id = nextTimerId++
      timers.set(id, fn)
      return id
    },
    clearTimeout(id) { timers.delete(id) },
    runTimers() {
      const batch = [...timers.entries()]
      timers.clear()
      for (const [, fn] of batch) fn()
    },
    addEventListener() {},
    removeEventListener() {},
    getComputedStyle: () => ({ right: '12px', top: '50%', visibility: 'hidden' }),
  }
  const jumps = []
  const RAILTAKE = new Function('window', 'document', 'RAILVIEW', 'TOPIC_ACTIVE', `${code};return RAILTAKE`)(
    win, doc, RAILVIEW, { set() {}, subscribe: () => () => {} },
  )
  const dispose = RAILTAKE.start({
    document: doc,
    window: win,
    view: RAILVIEW,
    loadOutline: () => Promise.resolve({
      available: true,
      turns: [
        { turn: 1, promptHead: '讨论方案', time: NOW - 4000, endSeq: 10 },
        { turn: 2, promptHead: '确定接口', time: NOW - 3000, endSeq: 20 },
        { turn: 3, promptHead: '修复单测', time: NOW - 2000, endSeq: 30 },
        { turn: 4, promptHead: '验证构建', time: NOW - 1000, endSeq: 40 },
      ],
      segments: [
        { id: 'seg-1', title: '方案设计', startTurn: 1, endTurn: 2, kindCandidate: 'chat' },
        { id: 'seg-2', title: '单测与构建', startTurn: 3, endTurn: 4, kindCandidate: 'work', errorTurns: [3] },
      ],
    }),
    jump: payload => { jumps.push(payload); return Promise.resolve({ ok: true }) },
  })
  await new Promise(resolve => setTimeout(resolve, 10))

  // 标准档渲染 2 个段头 + 4 个轮次行
  const segHeaders = doc.querySelectorAll('.dsh_tm_railseg')
  assert.equal(segHeaders.length, 2, '标准档应渲染 2 个段头分隔行')
  assert.equal(segHeaders[0].getAttribute('data-kind'), 'chat')
  assert.equal(segHeaders[1].getAttribute('data-kind'), 'work')
  assert.equal(segHeaders[1].getAttribute('data-error'), '1')
  assert.ok(segHeaders[0].textContent === '' && segHeaders[0].children.map(c => c.textContent).join(' ').includes('#1–#2'))
  assert.ok(segHeaders[1].children.map(c => c.textContent).join(' ').includes('#3–#4'))
  assert.equal(doc.querySelectorAll('.dsh_tm_railrow').length, 4)

  // 点击段头跳到该段首轮
  segHeaders[1].dispatchEvent({ type: 'click' })
  assert.equal(jumps.length, 1)
  assert.equal(jumps[0].turn, 3, '点第二段头应直接跳转到第 3 轮')
  assert.equal(jumps[0].seq, 30)

  // 切到 min 细轨：不渲染段头，只保留 4 个紧凑刻度行
  RAILTAKE.setTier('min')
  assert.equal(doc.querySelectorAll('.dsh_tm_railseg').length, 0, 'min 细轨不渲染段头')
  assert.equal(doc.querySelectorAll('.dsh_tm_railrow').length, 4)

  // 切回 max 宽档：段头重新出现
  RAILTAKE.setTier('max')
  assert.equal(doc.querySelectorAll('.dsh_tm_railseg').length, 2, 'max 宽档恢复段头')

  dispose()
})

function mergeSplitPayload() {
  return {
    workspaceId: 'ws-1',
    initialized: true,
    refining: false,
    cards: {
      unresolved: [
        { id: 'w-a', title: '事 A', state: 'active', confidence: 'inferred', pinned: false, reviewStatus: 'reviewed',
          statusLine: 's', nextStep: 'n', lastActivityAt: NOW - 1000, segmentCount: 2,
          segments: [{ id: 'seg-a1', title: '段一' }, { id: 'seg-a2', title: '段二' }] },
        { id: 'w-b', title: '事 B', state: 'active', confidence: 'inferred', pinned: false, reviewStatus: 'reviewed',
          statusLine: 's', nextStep: 'n', lastActivityAt: NOW - 2000, segmentCount: 1 },
      ],
      settled: [],
      pendingReviewCount: 0,
    },
    works: [],
  }
}

await test('合并：点「合并」出现目标选择器，选谁就把本卡并进谁', async () => {
  const calls = []
  const { runtime } = await mountWorks({
    payload: mergeSplitPayload(),
    onFetch: (action, body) => {
      if (action === 'work-merge') { calls.push(body); return { value: { work: { id: 'w-b', title: '事 B' } } } }
      return undefined
    },
  })
  await runtime.settle()
  const mergeBtn = byData(runtime.tree, 'data-action', 'merge-work')[0]
  assert.ok(mergeBtn !== undefined, '应有「合并」按钮')
  click(mergeBtn)
  await runtime.settle()
  const picker = byData(runtime.tree, 'data-pick', 'merge')[0]
  assert.ok(picker !== undefined, '点合并后应出现目标选择器')
  const targets = byData(runtime.tree, 'data-action', 'merge-target')
  assert.ok(targets.length >= 1, '选择器里应列出其它事')
  click(targets[0])
  await runtime.settle()
  assert.equal(calls.length, 1, '应调用一次 work-merge')
  assert.equal(calls[0].sourceWorkId, 'w-a', 'source 是本卡')
  assert.equal(calls[0].targetWorkId, 'w-b', 'target 是被选中的那件')
  runtime.unmount()
})

await test('拆段：点「拆段」出现段选择器，选谁就拆谁', async () => {
  const calls = []
  const { runtime } = await mountWorks({
    payload: mergeSplitPayload(),
    onFetch: (action, body) => {
      if (action === 'work-split') { calls.push(body); return { value: { work: { id: 'w-new' } } } }
      return undefined
    },
  })
  await runtime.settle()
  const splitBtn = byData(runtime.tree, 'data-action', 'split-work')[0]
  assert.ok(splitBtn !== undefined, '多段的事应有「拆段」按钮')
  click(splitBtn)
  await runtime.settle()
  const segs = byData(runtime.tree, 'data-action', 'split-segment')
  assert.equal(segs.length, 2, '两段就应列出两个可拆目标')
  click(segs[1])
  await runtime.settle()
  assert.equal(calls.length, 1, '应调用一次 work-split')
  assert.equal(calls[0].workId, 'w-a')
  assert.equal(calls[0].segmentId, 'seg-a2')
  runtime.unmount()
})

await test('只读巡检：合并与拆段按钮同样禁用', async () => {
  const { runtime } = await mountWorks({ payload: mergeSplitPayload(), readonly: true })
  await runtime.settle()
  for (const action of ['merge-work', 'split-work']) {
    const nodes = byData(runtime.tree, 'data-action', action)
    assert.ok(nodes.length > 0, '只读区也应渲染 ' + action + '（要能看见它为什么不能点）')
    for (const node of nodes) {
      assert.equal(node.props.disabled, true, '只读区 ' + action + ' 必须禁用')
    }
  }
  runtime.unmount()
})
await test('只读巡检：卡片上的写按钮全部禁用，交接两个保持可用，并给出说明条', async () => {
  const { runtime } = await mountWorks({ readonly: true })
  await runtime.settle()

  // 说明条必须就近出现在卡片区，否则整片灰按钮会让人以为功能坏了。
  assert.equal(byData(runtime.tree, 'data-banner', 'readonly').length, 1, '只读说明条必须出现')

  const WRITE = ['save-nextstep', 'toggle-pin', 'mark-blocked', 'dismiss-work', 'reopen',
    'review-keep', 'review-done', 'review-dismiss', 'confirm-done', 'open-review', 'confirm-all-review']
  for (const action of WRITE) {
    for (const node of byData(runtime.tree, 'data-action', action)) {
      assert.equal(node.props.disabled, true, '只读区 ' + action + ' 必须禁用')
    }
  }

  // 交接的两种形态是 ADR-0011 的唯一例外，必须仍可点。
  for (const action of ['resume', 'handoff']) {
    const nodes = byData(runtime.tree, 'data-action', action)
    assert.ok(nodes.length > 0, '应存在 ' + action + ' 按钮')
    for (const node of nodes) {
      assert.notEqual(node.props.disabled, true, '只读区 ' + action + ' 必须保持可用（交接是唯一例外）')
    }
  }

  runtime.unmount()
})

await test('只读巡检：读操作不受影响（详情仍可展开）', async () => {
  const { runtime } = await mountWorks({ readonly: true })
  await runtime.settle()
  const expandNodes = byData(runtime.tree, 'data-action', 'expand')
  assert.ok(expandNodes.length > 0, '详情按钮必须存在')
  for (const node of expandNodes) {
    assert.notEqual(node.props.disabled, true, '只读区的「详情」是读操作，不得禁用')
  }
  runtime.unmount()
})

await test('非只读区不出现只读说明条，写按钮照常可用', async () => {
  const { runtime } = await mountWorks()
  await runtime.settle()
  assert.equal(byData(runtime.tree, 'data-banner', 'readonly').length, 0, '本区不该有只读条')
  for (const node of byData(runtime.tree, 'data-action', 'confirm-done')) {
    assert.notEqual(node.props.disabled, true, '本区写按钮必须可用')
  }
  runtime.unmount()
})

finish()
