/**
 * 三层防失真续接与交接协议（ADR-0004）行为测试。
 *
 * 覆盖：
 * 1. 事级句柄 WORK_HANDLE_RE / formatWorkHandle / extractWorkHandles（与轮次句柄共存）
 * 2. 原会话串台检测 detectSessionDrift
 * 3. 输入框草稿生成 buildSameSessionDraft（未串台 vs 已串台）/ buildNewSessionHandoffDraft
 * 4. 程序直取硬事实 extractWorkHardFacts（变更文件、最近命令、失败信号、关键证据句柄）
 * 5. Wire 层渲染 renderWorkContextForAgent（四块结构、已否决方案、预算裁剪优先级与保底）
 *
 * Run: node tests/handoff.mjs
 */

import { strict as assert } from 'node:assert'
import {
  WORK_HANDLE_RE,
  DEFAULT_WIRE_MAX_CHARS,
  formatWorkHandle,
  formatTurnHandle,
  extractWorkHandles,
  detectSessionDrift,
  buildSameSessionDraft,
  buildNewSessionHandoffDraft,
  extractWorkHardFacts,
  renderWorkContextForAgent,
} from '../lib/handoff.js'

let passed = 0
const failures = []
function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`  FAIL ${name}\n       ${error.message}`)
  }
}

const SESSION_A = 'session-4c42ff36-aaaa-4bbb-8ccc-000000000001'
const SESSION_B = 'session-deadbeef-1111-4aaa-8bbb-000000000002'

console.log('\nhandoff')

// ── 切片 1：事级句柄正则、格式化与扫描去重 ──────────────────────────
test('WORK_HANDLE_RE 与轮次句柄清晰区分且可共存', () => {
  const sample = '请继续 〔work:wk_auth-01〕，顺便看下 〔4c42ff36#12〕 和 〔work:wk-2026.a〕'
  const matches = [...sample.matchAll(new RegExp(WORK_HANDLE_RE.source, 'g'))].map(m => m[1])
  assert.deepEqual(matches, ['wk_auth-01', 'wk-2026.a'])
  assert.equal(formatWorkHandle('wk_auth-01'), '〔work:wk_auth-01〕')
  assert.equal(formatTurnHandle(SESSION_A, 12), '〔4c42ff36#12〕')
})

test('extractWorkHandles 从多条文本按序去重、忽略轮次句柄、遵守 maxCount', () => {
  const ids = extractWorkHandles([
    '先接 〔work:alpha〕，参考 〔4c42ff36#3〕 和重复的 〔work:alpha〕',
    '再附带 〔work:beta〕 与 〔work:gamma〕',
  ], { maxCount: 2 })
  assert.deepEqual(ids, ['alpha', 'beta'])

  // 单字符串也可接受；非法输入不报错
  assert.deepEqual(extractWorkHandles('只有 〔work:solo-1〕'), ['solo-1'])
  assert.deepEqual(extractWorkHandles([null, undefined, '〔4c42ff36#9〕', '〔work:〕']), [])
})


// ── 切片 2：原会话串台检测 detectSessionDrift ───────────────────────
test('detectSessionDrift：最后一段属于本事时返回 drifted:false', () => {
  const work = { id: 'wk-auth', segmentIds: ['seg-1', 'seg-2'] }
  const segments = [
    { id: 'seg-1', workId: 'wk-auth', title: '梳理 OAuth 回调', turnRange: [0, 3] },
    { id: 'seg-2', workId: 'wk-auth', title: '修复 state 校验', turnRange: [4, 7] },
  ]
  const res = detectSessionDrift(work, segments)
  assert.deepEqual(res, { drifted: false, lastSegmentTitle: '修复 state 校验', turnsSinceWork: 0 })
})

test('detectSessionDrift：最后一段已聊别的事时返回 drifted:true 并计算跨过轮数', () => {
  const work = { id: 'wk-auth', segmentIds: ['seg-1'] }
  const segments = [
    { id: 'seg-1', workId: 'wk-auth', title: '修复 state 校验', turnRange: [0, 4] },
    { id: 'seg-2', workId: 'wk-css', title: '调整按钮圆角', turnRange: [5, 7] },
    { id: 'seg-3', workId: null, title: '中午吃什么', turnRange: [8, 10] },
  ]
  const res = detectSessionDrift(work, segments)
  assert.equal(res.drifted, true)
  assert.equal(res.lastSegmentTitle, '中午吃什么')
  assert.equal(res.turnsSinceWork, 6)
})

test('detectSessionDrift：支持 startTurn/endTurn 与仅靠 segment.id 归属匹配', () => {
  const work = { id: 'wk-sync', segments: [{ id: 's-a' }] }
  const segments = [
    { id: 's-a', title: '增量同步设计', startTurn: 1, endTurn: 3 },
    { id: 's-b', title: '顺便查个依赖版本', startTurn: 4, endTurn: 5 },
  ]
  const res = detectSessionDrift(work, segments)
  assert.equal(res.drifted, true)
  assert.equal(res.lastSegmentTitle, '顺便查个依赖版本')
  assert.equal(res.turnsSinceWork, 2)
})

test('detectSessionDrift：空段列表或目标会话无该事任何段时的稳健边界', () => {
  assert.deepEqual(detectSessionDrift({ id: 'wk-1' }, []), {
    drifted: false,
    lastSegmentTitle: '',
    turnsSinceWork: 0,
  })
  const res = detectSessionDrift({ id: 'wk-1' }, [
    { id: 'other-1', workId: 'wk-2', title: '完全不相关的话题', turnRange: [0, 2] },
  ])
  assert.equal(res.drifted, true)
  assert.equal(res.lastSegmentTitle, '完全不相关的话题')
  assert.equal(res.turnsSinceWork, 3)
})


// ── 切片 3：输入框草稿 buildSameSessionDraft / buildNewSessionHandoffDraft ──
const SAMPLE_WORK = {
  id: 'wk-handoff-01',
  title: '修复 Windows 路径转义回归',
  goal: '让所有跨会话跳转与引用句柄在 Windows 盘符路径下保持一致',
  status: 'blocked',
  confirmed: true,
  blocker: '反斜杠在 JSONL 重建时被二次转义导致路径去重失败',
  nextStep: '为 lib/turn-index.js 的路径归一补充单测并修复转义逻辑',
  decisions: [
    {
      id: 'dec-1',
      summary: '改用统一正斜杠作为索引内部比较键，不改动展示原文',
      status: 'active',
      evidence: { sessionId: SESSION_A, turn: 5 },
    },
    {
      id: 'dec-0',
      summary: '用全局 replace 改写原路径字段',
      status: 'superseded',
      supersededBy: 'dec-1',
      reason: '会破坏 Windows 复制粘贴后的原生路径展示',
      evidence: { sessionId: SESSION_A, turn: 2 },
    },
  ],
}

test('buildSameSessionDraft：未串台时简洁直接带入下一步，不灌水也不带事级句柄', () => {
  const draft = buildSameSessionDraft(SAMPLE_WORK, { drifted: false })
  assert.ok(draft.includes('为 lib/turn-index.js 的路径归一补充单测并修复转义逻辑'))
  assert.ok(!draft.includes('〔work:wk-handoff-01〕'), '未串台不应塞入事级句柄')
  assert.ok(draft.length < 120, '未串台草稿应极短、不灌水')
})

test('buildSameSessionDraft：已串台时附带【续接「标题」〔work:<id>〕】与下一步，触发 wire 纠偏', () => {
  const draft = buildSameSessionDraft(SAMPLE_WORK, { drifted: true })
  assert.ok(draft.includes('【续接「修复 Windows 路径转义回归」〔work:wk-handoff-01〕】'))
  assert.ok(draft.includes('为 lib/turn-index.js 的路径归一补充单测并修复转义逻辑'))
  assert.deepEqual(extractWorkHandles(draft), ['wk-handoff-01'])
})

test('buildSameSessionDraft：缺少 nextStep 时有合理兜底，不会出现 undefined 或空串', () => {
  const noNext = { id: 'wk-empty', title: '梳理发布清单' }
  const clean = buildSameSessionDraft(noNext, { drifted: false })
  const drifted = buildSameSessionDraft(noNext, { drifted: true })
  assert.ok(clean.length > 0 && !clean.includes('undefined'))
  assert.ok(drifted.includes('【续接「梳理发布清单」〔work:wk-empty〕】'))
  assert.ok(!drifted.includes('undefined'))
})

test('buildNewSessionHandoffDraft：带事级句柄、目标、下一步，并包含人类可读的关键提示且精炼可编辑', () => {
  const hardFacts = {
    changedFiles: [
      { path: 'lib/turn-index.js', added: 18, deleted: 4 },
      { path: 'tests/turn-index.mjs', added: 32, deleted: 0 },
    ],
    recentCommands: ['node tests/turn-index.mjs'],
    failedSignals: [{ handle: '〔4c42ff36#6〕', turn: 6, endReason: 'error', summary: 'AssertionError: E:\\foo !== E:/foo' }],
    keyEvidenceHandles: [{ handle: '〔4c42ff36#5〕', turn: 5, head: '统一用正斜杠做比较键' }],
  }
  const draft = buildNewSessionHandoffDraft(SAMPLE_WORK, hardFacts)
  assert.ok(draft.includes('〔work:wk-handoff-01〕'), '必须包含事级句柄以触发 wire 层展开')
  assert.ok(draft.includes('修复 Windows 路径转义回归'))
  assert.ok(draft.includes(SAMPLE_WORK.goal))
  assert.ok(draft.includes(SAMPLE_WORK.nextStep))
  assert.ok(draft.includes(SAMPLE_WORK.blocker), '有卡点时应在交接草稿中一眼可见')
  assert.ok(draft.length <= 600, '输入框交接草稿应保持精炼可读，细节留给 wire 层')
  assert.deepEqual(extractWorkHandles(draft), ['wk-handoff-01'])
})

test('buildNewSessionHandoffDraft：支持无卡点、无硬事实的小事，保持干净无空段', () => {
  const smallWork = {
    id: 'wk-small',
    title: '补充 README 徽章',
    goal: '在 README 顶部加上测试与版本徽章',
    status: 'in_progress',
    nextStep: '检查 package.json 版本并写入 README.md',
  }
  const draft = buildNewSessionHandoffDraft(smallWork)
  assert.ok(draft.includes('〔work:wk-small〕'))
  assert.ok(draft.includes('目标：在 README 顶部加上测试与版本徽章'))
  assert.ok(draft.includes('下一步：检查 package.json 版本并写入 README.md'))
  assert.ok(!draft.includes('卡点：'), '无卡点时不输出空卡点行')
})


// ── 切片 4：程序直取硬事实 extractWorkHardFacts ─────────────────────
const BASE_MS = 1_700_000_000_000

function makeTurn(spec) {
  return {
    sessionId: spec.sessionId ?? SESSION_A,
    turn: spec.turn,
    start: spec.start ?? (BASE_MS + spec.turn * 60_000),
    end: spec.end ?? (BASE_MS + spec.turn * 60_000 + 5_000),
    prompt: spec.prompt ?? `第 ${spec.turn} 轮提问`,
    response: spec.response ?? `第 ${spec.turn} 轮回答`,
    commands: spec.commands ?? [],
    files: spec.files ?? [],
    changes: spec.changes,
    endReason: spec.endReason ?? 'completed',
    interrupted: spec.interrupted ?? false,
    segmentId: spec.segmentId,
  }
}

test('extractWorkHardFacts：变更文件去重并取最近一次改动的 ±行数，遵守 maxFiles', () => {
  const turns = [
    makeTurn({
      turn: 1,
      changes: {
        lost: false,
        files: [
          { path: 'lib/a.js', added: 10, deleted: 2 },
          { path: 'lib/b.js', added: 5, deleted: 1 },
        ],
      },
    }),
    makeTurn({
      turn: 3,
      changes: {
        lost: false,
        files: [
          { path: 'lib/a.js', added: 3, deleted: 7 }, // 同文件更新的改动，覆盖 ± 行
          { path: 'lib/c.js', added: 20, deleted: 0 },
        ],
      },
    }),
    makeTurn({
      turn: 4,
      changes: { lost: true, files: [] }, // lost:true 不应把之前真实变更清零
    }),
  ]

  const facts = extractWorkHardFacts(turns)
  assert.equal(facts.changedFiles.length, 3)
  const fileA = facts.changedFiles.find(f => f.path === 'lib/a.js')
  assert.deepEqual(
    { path: fileA.path, added: fileA.added, deleted: fileA.deleted },
    { path: 'lib/a.js', added: 3, deleted: 7 },
  )
  // 最近改动的排在前面
  assert.equal(facts.changedFiles[0].path, 'lib/a.js')
  assert.equal(facts.changedFiles[1].path, 'lib/c.js')
  assert.equal(facts.changedFiles[2].path, 'lib/b.js')

  // maxFiles 上限生效
  const limited = extractWorkHardFacts(turns, { maxFiles: 2 })
  assert.equal(limited.changedFiles.length, 2)
})

test('extractWorkHardFacts：默认变更文件上限 12，超过时只留最近 12 个', () => {
  const manyFiles = Array.from({ length: 16 }, (_, i) => ({
    path: `lib/mod-${i}.js`,
    added: i + 1,
    deleted: 0,
  }))
  const turns = [makeTurn({ turn: 1, changes: { lost: false, files: manyFiles } })]
  const facts = extractWorkHardFacts(turns)
  assert.equal(facts.changedFiles.length, 12)
})

test('extractWorkHardFacts：最近命令按时间倒序去重，默认上限 6 条', () => {
  const turns = [
    makeTurn({ turn: 1, commands: ['npm test', 'git status'] }),
    makeTurn({ turn: 2, commands: ['node tests/a.mjs', 'npm test'] }), // npm test 较新
    makeTurn({ turn: 3, commands: ['node tests/b.mjs', 'node tests/c.mjs', 'node tests/d.mjs', 'node tests/e.mjs', 'node tests/f.mjs'] }),
  ]
  const facts = extractWorkHardFacts(turns)
  assert.equal(facts.recentCommands.length, 6)
  // 倒序且最新优先
  assert.equal(facts.recentCommands[0], 'node tests/f.mjs')
  assert.equal(facts.recentCommands[4], 'node tests/b.mjs')
  assert.equal(facts.recentCommands[5], 'npm test')
  // 去重确认
  assert.equal(new Set(facts.recentCommands).size, facts.recentCommands.length)
})

test('extractWorkHardFacts：提取失败/中断轮次的错误信号，附句柄、endReason、命令/首行提示，默认上限 3 条', () => {
  const turns = [
    makeTurn({ turn: 1, endReason: 'completed', response: '一切正常' }),
    makeTurn({
      turn: 2,
      endReason: 'error',
      commands: ['node tests/handoff.mjs'],
      response: 'Error: ENOENT no such file\n详细堆栈第二行',
    }),
    makeTurn({
      turn: 3,
      endReason: 'aborted',
      commands: ['pnpm build'],
      response: '用户手动中断了构建',
    }),
    makeTurn({
      turn: 4,
      endReason: 'completed',
      interrupted: true,
      response: '流式输出中途被切断',
    }),
    makeTurn({
      turn: 5,
      endReason: 'blocked',
      commands: ['git push'],
      response: 'Permission denied (publickey)\nmore info',
    }),
  ]

  const facts = extractWorkHardFacts(turns)
  assert.equal(facts.failedSignals.length, 3, '默认上限 3 条')
  // 按时间倒序取最近 3 条失败/中断：turn 5, 4, 3
  assert.deepEqual(facts.failedSignals.map(s => s.turn), [5, 4, 3])
  assert.equal(facts.failedSignals[0].handle, '〔4c42ff36#5〕')
  assert.equal(facts.failedSignals[0].endReason, 'blocked')
  assert.equal(facts.failedSignals[0].command, 'git push')
  assert.ok(facts.failedSignals[0].hint.includes('Permission denied (publickey)'))
  assert.ok(!facts.failedSignals[0].hint.includes('more info'), '提示只取首行')
  assert.equal(facts.failedSignals[1].endReason, 'interrupted')
})

test('extractWorkHardFacts：关键原文证据句柄按优先级（决策证据 > 报错 > 有变更 > 段首尾）去重取前 8 条，提问头 ≤30 字', () => {
  const longPrompt = '这是一个超过三十个字的非常长的提问标题用来验证提问头是否被正确裁剪到三十字以内不撑爆上下文'
  const turns = [
    makeTurn({ turn: 1, segmentId: 's1', prompt: longPrompt }), // 段首
    makeTurn({ turn: 2, segmentId: 's1', prompt: '普通讨论 2' }),
    makeTurn({ turn: 3, segmentId: 's1', prompt: '拍板决定采用方案 B' }), // 决策证据
    makeTurn({ turn: 4, segmentId: 's1', prompt: '修改核心文件', changes: { lost: false, files: [{ path: 'lib/x.js', added: 5, deleted: 1 }] } }),
    makeTurn({ turn: 5, segmentId: 's1', prompt: '运行单测报错', endReason: 'error', response: 'TypeError: boom' }),
    makeTurn({ turn: 6, segmentId: 's1', prompt: '段尾总结' }), // 段尾
    makeTurn({ sessionId: SESSION_B, turn: 1, segmentId: 's2', start: BASE_MS + 900_000, prompt: '跨会话新段首轮' }),
    makeTurn({ sessionId: SESSION_B, turn: 2, segmentId: 's2', start: BASE_MS + 960_000, prompt: '跨会话变更 2', changes: { lost: false, files: [{ path: 'lib/y.js', added: 2, deleted: 0 }] } }),
    makeTurn({ sessionId: SESSION_B, turn: 3, segmentId: 's2', start: BASE_MS + 1_020_000, prompt: '跨会话变更 3', changes: { lost: false, files: [{ path: 'lib/z.js', added: 4, deleted: 0 }] } }),
    makeTurn({ sessionId: SESSION_B, turn: 4, segmentId: 's2', start: BASE_MS + 1_080_000, prompt: '跨会话变更 4', changes: { lost: false, files: [{ path: 'lib/w.js', added: 1, deleted: 0 }] } }),
    makeTurn({ sessionId: SESSION_B, turn: 5, segmentId: 's2', start: BASE_MS + 1_140_000, prompt: '跨会话段尾' }),
  ]

  const facts = extractWorkHardFacts(turns, {
    decisionEvidence: [{ sessionId: SESSION_A, turn: 3 }],
  })
  assert.equal(facts.keyEvidenceHandles.length, 8, '默认上限 8 条')
  const handleStrings = facts.keyEvidenceHandles.map(item => item.handle)
  assert.equal(new Set(handleStrings).size, 8, '句柄必须去重')
  // 决策证据轮（#3）和报错轮（#5）必须在高优先级前列
  assert.equal(handleStrings[0], '〔4c42ff36#3〕')
  assert.equal(handleStrings[1], '〔4c42ff36#5〕')
  // 所有提问头 <= 30 字（不含省略号或含省略号总长 <= 31；要求 ≤30 字则严格按码点 <= 30）
  for (const item of facts.keyEvidenceHandles) {
    assert.ok(Array.from(item.head).length <= 30, `提问头超 30 字: ${item.head}`)
  }
})


// ── 切片 5：Wire 层渲染 renderWorkContextForAgent ───────────────────
const RICH_HARD_FACTS = {
  changedFiles: [
    { path: 'lib/turn-index.js', added: 28, deleted: 6 },
    { path: 'lib/index.js', added: 14, deleted: 2 },
    { path: 'tests/turn-index.mjs', added: 45, deleted: 0 },
    { path: 'lib/handoff.js', added: 180, deleted: 0 },
    { path: 'lib/work-store.js', added: 95, deleted: 12 },
  ],
  recentCommands: [
    'node tests/turn-index.mjs',
    'node scripts/test.mjs',
    'git diff --stat lib/turn-index.js',
    'node scripts/verify-bundle.mjs',
  ],
  failedSignals: [
    {
      turn: 6,
      sessionId: SESSION_A,
      handle: '〔4c42ff36#6〕',
      endReason: 'error',
      command: 'node tests/turn-index.mjs',
      hint: 'AssertionError: E:\\repo\\a.js !== E:/repo/a.js',
    },
    {
      turn: 4,
      sessionId: SESSION_A,
      handle: '〔4c42ff36#4〕',
      endReason: 'aborted',
      command: 'pnpm test',
      hint: '用户中断了全量测试运行',
    },
  ],
  keyEvidenceHandles: [
    { handle: '〔4c42ff36#5〕', turn: 5, head: '拍板：正斜杠作为比较键，不改展示原文' },
    { handle: '〔4c42ff36#6〕', turn: 6, head: '单测暴露 Windows 反斜杠二次转义问题' },
    { handle: '〔4c42ff36#2〕', turn: 2, head: '讨论全局 replace 方案并确认会破坏原生路径' },
    { handle: '〔4c42ff36#1〕', turn: 1, head: '复现跨会话跳转在 Windows 下的路径不匹配' },
    { handle: '〔deadbeef#1〕', turn: 1, head: '在新会话核对索引落盘与重建一致性' },
    { handle: '〔deadbeef#3〕', turn: 3, head: '补充边界用例覆盖混合斜杠路径' },
  ],
}

test('renderWorkContextForAgent：完整四块输出、标注已确认/推测态、显式区分现行决策与已否决方案及 history_turn 提示', () => {
  const text = renderWorkContextForAgent(SAMPLE_WORK, RICH_HARD_FACTS)
  assert.equal(typeof text, 'string')
  assert.ok(text.length <= DEFAULT_WIRE_MAX_CHARS)

  // 四块标题齐全且按序出现
  const idx1 = text.indexOf('【目标与当前态势】')
  const idx2 = text.indexOf('【已生效决策 / 已否决方案】')
  const idx3 = text.indexOf('【硬事实（程序直取）】')
  const idx4 = text.indexOf('【下一步与原文证据索引】')
  assert.ok(idx1 >= 0 && idx2 > idx1 && idx3 > idx2 && idx4 > idx3, '四块标题必须齐全且按既定顺序排列')

  // 第一块：目标、状态、已确认标识、当前卡点
  assert.ok(text.includes(SAMPLE_WORK.goal))
  assert.ok(text.includes('卡住'))
  assert.ok(text.includes('已确认'))
  assert.ok(text.includes(SAMPLE_WORK.blocker))

  // 第二块：区分现行决策与已否决方案，带原文轮次句柄与否决原因
  assert.ok(text.includes('已生效决策'))
  assert.ok(text.includes('改用统一正斜杠作为索引内部比较键'))
  assert.ok(text.includes('〔4c42ff36#5〕'))
  assert.ok(text.includes('已否决'))
  assert.ok(text.includes('用全局 replace 改写原路径字段'))
  assert.ok(text.includes('会破坏 Windows 复制粘贴后的原生路径展示'))
  assert.ok(text.includes('〔4c42ff36#2〕'))

  // 第三块：硬事实（变更文件 ±行、最近命令、失败信号）
  assert.ok(text.includes('lib/turn-index.js'))
  assert.ok(text.includes('+28/-6'))
  assert.ok(text.includes('node tests/turn-index.mjs'))
  assert.ok(text.includes('AssertionError'))

  // 第四块：唯一行动 + 句柄表 + history_turn 工具调用提示与禁止猜测指令
  assert.ok(text.includes(SAMPLE_WORK.nextStep))
  assert.ok(text.includes('history_turn'))
  assert.ok(text.includes('禁止猜测'))
  assert.ok(text.includes('〔deadbeef#1〕'))
})

test('renderWorkContextForAgent：推测态事明确标注「推测态」，无决策时也不捏造伪决策', () => {
  const inferredWork = {
    id: 'wk-inferred',
    title: '排查导出按钮无响应',
    goal: '找出点击导出简报后未触发下载的原因',
    status: 'in_progress',
    confirmed: false,
    nextStep: '检查 client.js 的导出事件绑定',
    decisions: [],
  }
  const text = renderWorkContextForAgent(inferredWork, {
    changedFiles: [],
    recentCommands: [],
    failedSignals: [],
    keyEvidenceHandles: [],
  })
  assert.ok(text.includes('推测态'))
  assert.ok(text.includes('进行中'))
  assert.ok(text.includes('暂无记录'))
  assert.ok(text.includes('检查 client.js 的导出事件绑定'))
})

test('renderWorkContextForAgent：超预算时按严格优先级裁剪（先裁证据句柄 → 再裁命令/文件/报错 → 再裁已否决方案），且永不丢目标、下一步与现行决策，并明确注明裁剪数量', () => {
  // 构造一个带大量证据、命令、文件、已否决方案的重型工作
  const heavyWork = {
    ...SAMPLE_WORK,
    decisions: [
      {
        id: 'dec-active-1',
        summary: '现行方案：使用正斜杠做内部比较键，保留原始展示路径',
        status: 'active',
        evidence: { sessionId: SESSION_A, turn: 5 },
      },
      ...Array.from({ length: 5 }, (_, i) => ({
        id: `dec-rej-${i}`,
        summary: `被否决的旧方案 ${i + 1}：尝试用正则在落盘前重写所有路径字段但引发回归`,
        status: 'superseded',
        reason: `否决原因 ${i + 1}：会破坏 Windows 原始路径展示并导致回滚失败`,
        evidence: { sessionId: SESSION_A, turn: i + 1 },
      })),
    ],
  }
  const heavyFacts = {
    changedFiles: Array.from({ length: 12 }, (_, i) => ({
      path: `lib/very/nested/module-component-${i + 1}.js`,
      added: 100 + i,
      deleted: 10 + i,
    })),
    recentCommands: Array.from({ length: 6 }, (_, i) => `node tests/integration-suite-case-${i + 1}.mjs --verbose --strict`),
    failedSignals: Array.from({ length: 3 }, (_, i) => ({
      turn: 10 + i,
      sessionId: SESSION_A,
      handle: `〔4c42ff36#${10 + i}〕`,
      endReason: 'error',
      command: `node tests/fail-${i + 1}.mjs`,
      hint: `AssertionError: 期望路径归一一致但实际收到未转义路径 case-${i + 1}`,
    })),
    keyEvidenceHandles: Array.from({ length: 8 }, (_, i) => ({
      handle: `〔4c42ff36#${20 + i}〕`,
      turn: 20 + i,
      head: `第 ${i + 1} 条关键原文证据的简短提问头描述`,
    })),
  }

  // 1) 中等紧张预算（1350 字符）：应优先裁剪证据句柄与部分硬事实，但保留已否决方案与核心三要素
  const medium = renderWorkContextForAgent(heavyWork, heavyFacts, { maxChars: 1350 })
  assert.ok(medium.length <= 1350, `超出预算：${medium.length} > 1350`)
  assert.ok(medium.includes(heavyWork.goal), '中等预算下目标不可丢')
  assert.ok(medium.includes(heavyWork.nextStep), '中等预算下下一步不可丢')
  assert.ok(medium.includes('现行方案：使用正斜杠做内部比较键'), '中等预算下现行决策不可丢')
  assert.ok(medium.includes('被否决的旧方案 1'), '中等预算下已否决方案应比证据/硬事实更靠后裁剪')
  assert.ok(/已省略\s*\d+/.test(medium), '超预算时必须明确注明裁剪数量')

  // 2) 极紧预算（750 字符）：证据、硬事实与已否决方案均可裁剪，但目标/下一步/现行决策永不丢
  const tight = renderWorkContextForAgent(heavyWork, heavyFacts, { maxChars: 750 })
  assert.ok(tight.includes(heavyWork.goal), '极紧预算下目标永不丢')
  assert.ok(tight.includes(heavyWork.nextStep), '极紧预算下下一步永不丢')
  assert.ok(tight.includes('现行方案：使用正斜杠做内部比较键'), '极紧预算下现行决策永不丢')
  assert.ok(/已省略\s*\d+/.test(tight), '极紧预算下仍需注明裁剪数量')
  assert.ok(tight.length <= 750, `极紧预算下应控制在预算内（当前 ${tight.length}）`)
})

test('renderWorkContextForAgent：支持通过 decision.superseded === true 或 status === "rejected" 识别已否决方案', () => {
  const work = {
    id: 'wk-dec-variants',
    title: '选型缓存介质',
    goal: '决定索引缓存存储格式',
    status: 'in_progress',
    nextStep: '实现 JSONL 写入器',
    decisions: [
      { summary: '采用 JSONL 逐行落盘', status: 'active', handle: '〔4c42ff36#9〕' },
      { summary: '使用 SQLite 单文件', superseded: true, reason: '避免引入原生编译依赖', handle: '〔4c42ff36#3〕' },
      { summary: '全量存进单个 JSON', status: 'rejected', reason: '大工作区单次写入太慢', evidence: { sessionId: SESSION_B, turn: 2 } },
    ],
  }
  const text = renderWorkContextForAgent(work, null)
  assert.ok(text.includes('采用 JSONL 逐行落盘'))
  assert.ok(text.includes('〔4c42ff36#9〕'))
  assert.ok(text.includes('使用 SQLite 单文件'))
  assert.ok(text.includes('避免引入原生编译依赖'))
  assert.ok(text.includes('全量存进单个 JSON'))
  assert.ok(text.includes('〔deadbeef#2〕'))
})

test('renderWorkContextForAgent：已串台选项可附加串台纠偏提示，且不破坏四块结构', () => {
  const text = renderWorkContextForAgent(SAMPLE_WORK, RICH_HARD_FACTS, {
    drift: { drifted: true, lastSegmentTitle: '中午吃什么', turnsSinceWork: 6 },
  })
  assert.ok(text.includes('串台'))
  assert.ok(text.includes('中午吃什么'))
  assert.ok(text.includes('【目标与当前态势】'))
  assert.ok(text.includes('【下一步与原文证据索引】'))
})


// ── 切片 6：边界与深化验证 ───────────────────────────────────────────
test('extractWorkHardFacts：turns 乱序传入时仍按时间顺序确定性抽取，且不修改原数组', () => {
  const t1 = makeTurn({
    turn: 1,
    start: BASE_MS + 10_000,
    end: BASE_MS + 12_000,
    commands: ['old-cmd'],
    changes: { lost: false, files: [{ path: 'lib/core.js', added: 50, deleted: 1 }] },
  })
  const t2 = makeTurn({
    turn: 2,
    start: BASE_MS + 20_000,
    end: BASE_MS + 22_000,
    commands: ['new-cmd'],
    changes: { lost: false, files: [{ path: 'lib/core.js', added: 2, deleted: 3 }] },
  })
  const input = [t2, t1]
  const facts = extractWorkHardFacts(input)
  assert.equal(input[0].turn, 2, '不得原地修改输入 turns 数组')
  assert.equal(facts.recentCommands[0], 'new-cmd')
  assert.equal(facts.changedFiles[0].added, 2)
  assert.equal(facts.changedFiles[0].deleted, 3)
})

test('extractWorkHardFacts：无 changes.files 仅有 turn.files 时不会编造 ±行，且空输入安全返回空结构', () => {
  const empty = extractWorkHardFacts([])
  assert.deepEqual(empty, {
    changedFiles: [],
    recentCommands: [],
    failedSignals: [],
    keyEvidenceHandles: [],
  })
  const onlyRead = extractWorkHardFacts([makeTurn({ turn: 1, files: ['lib/read-only.js'] })])
  assert.deepEqual(onlyRead.changedFiles, [], '未发生真实写变更（changes 缺失）不误报为变更文件')
})

test('renderWorkContextForAgent：预算极小时仍保底保留目标、下一步与现行决策（宁超小预算也不丢核心三要素）', () => {
  const text = renderWorkContextForAgent(SAMPLE_WORK, RICH_HARD_FACTS, { maxChars: 200 })
  assert.ok(text.includes(SAMPLE_WORK.goal), '核心目标永不丢')
  assert.ok(text.includes(SAMPLE_WORK.nextStep), '核心下一步永不丢')
  assert.ok(text.includes('改用统一正斜杠作为索引内部比较键'), '现行决策永不丢')
  assert.ok(!text.includes('〔deadbeef#3〕'), '低优先级证据已被裁剪')
  assert.ok(!text.includes('lib/work-store.js'), '低优先级变更文件已被裁剪')
})

test('extractWorkHandles：同一句里混合大小写或重复事级句柄与轮次句柄时精确区分', () => {
  const text = '对比 〔4c42ff36#1〕 与 〔work:Task_01〕、〔work:Task_01〕、〔deadbeef#99〕 和 〔work:sub:2〕'
  assert.deepEqual(extractWorkHandles(text, { maxCount: 5 }), ['Task_01', 'sub:2'])
  // 与 lib/index.js 的 QUOTE_HANDLE_RE 正则互不误匹配
  const quoteRe = /〔([0-9a-fA-F]{8})#(\d+)〕/g
  const quoteMatches = [...text.matchAll(quoteRe)].map(m => `${m[1]}#${m[2]}`)
  assert.deepEqual(quoteMatches, ['4c42ff36#1', 'deadbeef#99'])
})

console.log(`\n${passed} passed, ${failures.length} failed\n`)
if (failures.length > 0) process.exitCode = 1
