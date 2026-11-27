/**
 * 「段（Segment）」核心域纯模块行为测试。
 *
 * 覆盖：
 *   1. 单主题会话保持整段、确定性 ID、连续/不重叠/全覆盖不变量；
 *   2. 长会话混杂工作与闲聊切出多段，且准确初判 work / chat 及 kindReasons；
 *   3. 长时间间隔（默认 ≥ 45 分钟）与上下文压缩（afterCompaction）强制切段；
 *   4. 文件集合切换信号切分不同模块工作；
 *   5. 提取引用句柄（〔8hex#N〕）、变更文件（不混入纯读路径）、异常轮次 errorTurns；
 *   6. 子代理、自动化、定时任务、0 轮空会话识别（isAutomatedSession）；
 *   7. 模型精化提示词与健壮解析（改标题/合并过碎段/精化 kind 与 summary / 损坏输出降级）；
 *   8. 历史轨「段 → 轮次」两级目录生成（toRailOutlineWithSegments）。
 *
 * Run: node tests/segment.mjs
 */

import { strict as assert } from 'node:assert'
import {
  DEFAULT_TIME_GAP_MS,
  buildSegmentRefinePrompt,
  extractQuoteHandles,
  isAutomatedSession,
  parseSegmentRefineResult,
  sliceSessionSegments,
  toRailOutlineWithSegments,
} from '../lib/segment.js'

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

const MIN = 60 * 1000
const BASE = 1_700_000_000_000
const SESSION_ID = 'session-4c42ff36-aaaa-4bbb-8ccc-000000000001'

/** 构造兼容 turn-index 格式的轮次行。 */
function makeTurn(turn, overrides = {}) {
  const start = overrides.start ?? (BASE + turn * 2 * MIN)
  const end = overrides.end ?? (start + 30_000)
  return {
    turn,
    seq: overrides.seq ?? turn * 4,
    endSeq: overrides.endSeq ?? turn * 4 + 3,
    start,
    end,
    prompt: overrides.prompt ?? `第 ${turn} 轮提问`,
    response: overrides.response ?? `第 ${turn} 轮回答`,
    tools: overrides.tools ?? [],
    files: overrides.files ?? [],
    commands: overrides.commands ?? [],
    endReason: overrides.endReason ?? 'completed',
    interrupted: overrides.interrupted ?? false,
    changes: overrides.changes,
    afterCompaction: overrides.afterCompaction ?? false,
  }
}

/** 校验段的三大结构不变量：连续、不重叠、覆盖全部轮次。 */
function assertSegmentInvariants(turns, segments) {
  const sorted = [...turns].sort((a, b) => a.turn - b.turn)
  if (sorted.length === 0) {
    assert.deepEqual(segments, [])
    return
  }
  assert.ok(segments.length >= 1, '非空轮次至少切出 1 段')
  assert.equal(segments[0].startTurn, sorted[0].turn, '首段起点必须对齐首轮')
  assert.equal(
    segments[segments.length - 1].endTurn,
    sorted[sorted.length - 1].turn,
    '末段终点必须对齐末轮',
  )

  let cursor = 0
  let totalCount = 0
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i]
    assert.ok(seg.startTurn <= seg.endTurn, 'startTurn <= endTurn')
    assert.ok(seg.turnCount >= 1, '每段至少包含 1 轮')
    assert.equal(seg.startTurn, sorted[cursor].turn, `段 ${i} 起点衔接前一段`)
    const slice = sorted.slice(cursor, cursor + seg.turnCount)
    assert.equal(slice.length, seg.turnCount, '段轮数与覆盖区间一致')
    assert.equal(seg.endTurn, slice[slice.length - 1].turn, `段 ${i} 终点与覆盖区间一致`)
    if (i > 0) {
      assert.ok(segments[i - 1].endTurn < seg.startTurn, '相邻段不可重叠')
    }
    assert.ok(seg.confidence >= 0 && seg.confidence <= 1, 'confidence 在 [0, 1]')
    assert.ok(seg.kindCandidate === 'work' || seg.kindCandidate === 'chat', 'kindCandidate 只能是 work 或 chat')
    assert.ok(Array.isArray(seg.kindReasons) && seg.kindReasons.length > 0, '必须附带 kindReasons')
    cursor += seg.turnCount
    totalCount += seg.turnCount
  }
  assert.equal(totalCount, sorted.length, '所有段轮数之和等于总轮数')
}

console.log('\nsegment')

// ── 1. 空输入与单主题会话 ───────────────────────────────────────────

test('空轮次或非法输入返回空数组', () => {
  assert.deepEqual(sliceSessionSegments([]), [])
  assert.deepEqual(sliceSessionSegments(null), [])
  assert.deepEqual(sliceSessionSegments(undefined), [])
})

test('单主题工作会话保持为单段且字段齐全、ID 确定性', () => {
  const turns = [
    makeTurn(0, {
      prompt: '帮我修复登录模块 JWT 过期刷新的 bug，看看 lib/auth.js',
      response: '我读取了 lib/auth.js，发现 refreshToken 未更新过期时间。',
      tools: ['read'],
      files: ['lib/auth.js'],
    }),
    makeTurn(1, {
      prompt: '直接改 lib/auth.js 并补一下单测',
      response: '已修改 lib/auth.js 与 tests/auth.mjs，运行测试全部通过。',
      tools: ['edit', 'pwsh'],
      files: ['lib/auth.js', 'tests/auth.mjs'],
      commands: ['node tests/auth.mjs'],
      changes: { files: [{ path: 'lib/auth.js', added: 18, deleted: 4 }, { path: 'tests/auth.mjs', added: 30, deleted: 0 }] },
    }),
    makeTurn(2, {
      prompt: '顺便把登录刷新超时的边界条件也测一下',
      response: '已补充超时边界用例，测试通过。',
      tools: ['edit', 'pwsh'],
      files: ['tests/auth.mjs'],
      commands: ['node tests/auth.mjs'],
      changes: { files: [{ path: 'tests/auth.mjs', added: 12, deleted: 1 }] },
    }),
  ]

  const segs1 = sliceSessionSegments(turns, { sessionId: SESSION_ID, forkParent: 'session-parent-0001' })
  const segs2 = sliceSessionSegments(turns, { sessionId: SESSION_ID, forkParent: 'session-parent-0001' })

  assert.deepEqual(segs1, segs2, '纯函数同输入同输出')
  assertSegmentInvariants(turns, segs1)
  assert.equal(segs1.length, 1, '单主题 3 轮不应被误切碎')

  const seg = segs1[0]
  assert.equal(seg.id, 'seg:4c42ff36:0-2')
  assert.equal(seg.sessionId, SESSION_ID)
  assert.equal(seg.startTurn, 0)
  assert.equal(seg.endTurn, 2)
  assert.equal(seg.turnCount, 3)
  assert.equal(seg.startTime, turns[0].start)
  assert.equal(seg.endTime, turns[2].end)
  assert.equal(seg.kindCandidate, 'work')
  assert.equal(seg.forkParent, 'session-parent-0001')
  assert.ok(seg.title.length > 0 && seg.title.length <= 36)
  assert.ok(seg.summary.length > 0)
  assert.deepEqual(seg.changedFiles, ['lib/auth.js', 'tests/auth.mjs'])
  assert.deepEqual(seg.commands, ['node tests/auth.mjs'])
  assert.deepEqual(seg.errorTurns, [])
})

test('纯日常闲聊单主题会话判为 chat', () => {
  const turns = [
    makeTurn(0, {
      prompt: '周末打算去杭州玩两天，有什么不赶路的路线推荐吗？',
      response: '第一天可以逛西湖苏堤和龙井村，第二天去西溪湿地和法喜寺。',
    }),
    makeTurn(1, {
      prompt: '龙井村附近有什么好吃的本帮菜或杭帮菜？',
      response: '可以试试茶人村或者绿茶餐厅总店，龙井虾仁和东坡肉都不错。',
    }),
    makeTurn(2, {
      prompt: '那边天气大概多少度，需要带厚外套吗？',
      response: '早晚温差大，建议带一件防风薄外套。',
      tools: ['weather'],
    }),
  ]

  const segs = sliceSessionSegments(turns, { sessionId: SESSION_ID })
  assertSegmentInvariants(turns, segs)
  assert.equal(segs.length, 1)
  assert.equal(segs[0].kindCandidate, 'chat')
  assert.deepEqual(segs[0].changedFiles, [])
  assert.deepEqual(segs[0].commands, [])
})

// ── 2. 长会话混杂工作 + 闲聊切出多段 ────────────────────────────────

test('长会话混杂「工作 A → 日常闲聊 → 工作 B」切出多段且各自 kindCandidate 准确', () => {
  const turns = [
    // 段 1：工作 A（认证模块重构）
    makeTurn(0, {
      prompt: '排查 src/auth/jwt.ts 里 token 签名校验失败的原因',
      response: '检查 src/auth/jwt.ts 发现 secret 编码使用了 utf8 而非 base64。',
      tools: ['read'],
      files: ['src/auth/jwt.ts'],
    }),
    makeTurn(1, {
      prompt: '修复 src/auth/jwt.ts 并跑一下 auth 单测',
      response: '已修复 src/auth/jwt.ts，执行 vitest 通过。',
      tools: ['edit', 'pwsh'],
      files: ['src/auth/jwt.ts'],
      commands: ['pnpm test auth'],
      changes: { files: [{ path: 'src/auth/jwt.ts', added: 8, deleted: 3 }] },
    }),
    makeTurn(2, {
      prompt: '给 src/auth/jwt.ts 补一个非法签名用例',
      response: '已补充测试并验证通过。',
      tools: ['edit', 'pwsh'],
      files: ['src/auth/jwt.ts', 'tests/auth.test.ts'],
      commands: ['pnpm test auth'],
      changes: { files: [{ path: 'tests/auth.test.ts', added: 15, deleted: 0 }] },
    }),

    // 段 2：日常闲聊（完全无关的做饭话题）
    makeTurn(3, {
      prompt: '歇一会儿顺便问下，番茄炒蛋怎么炒才能嫩滑不出太多水？',
      response: '鸡蛋加少许温水和料酒打散，热锅凉油滑熟盛出，番茄去皮大火快炒再合炒。',
    }),
    makeTurn(4, {
      prompt: '那糖和盐大概什么时候放比较好，要不要勾芡？',
      response: '番茄炒软出沙时放少许白糖提鲜，最后出锅前再放盐，一般不用勾芡。',
    }),

    // 段 3：工作 B（账单导出功能）
    makeTurn(5, {
      prompt: '回到工作，帮我实现 src/billing/csv-export.ts 的月度账单导出功能',
      response: '我先查看 src/billing/invoice.ts 的数据结构，然后编写 csv-export.ts。',
      tools: ['read', 'write'],
      files: ['src/billing/invoice.ts', 'src/billing/csv-export.ts'],
      changes: { files: [{ path: 'src/billing/csv-export.ts', added: 64, deleted: 0 }] },
    }),
    makeTurn(6, {
      prompt: '运行 billing 导出测试并确认 CSV 转义正确',
      response: '执行测试时发现逗号转义报错，已修复并重跑通过。',
      tools: ['edit', 'pwsh'],
      files: ['src/billing/csv-export.ts'],
      commands: ['pnpm test billing'],
      changes: { files: [{ path: 'src/billing/csv-export.ts', added: 5, deleted: 2 }] },
    }),
  ]

  const segs = sliceSessionSegments(turns, { sessionId: SESSION_ID })
  assertSegmentInvariants(turns, segs)
  assert.equal(segs.length, 3, `期望切出 3 段，实际 ${segs.length} 段: ${segs.map(s => s.id).join(', ')}`)

  assert.equal(segs[0].startTurn, 0)
  assert.equal(segs[0].endTurn, 2)
  assert.equal(segs[0].kindCandidate, 'work')

  assert.equal(segs[1].startTurn, 3)
  assert.equal(segs[1].endTurn, 4)
  assert.equal(segs[1].kindCandidate, 'chat')

  assert.equal(segs[2].startTurn, 5)
  assert.equal(segs[2].endTurn, 6)
  assert.equal(segs[2].kindCandidate, 'work')
})

// ── 3. 长时间间隔与上下文压缩强制切段 ───────────────────────────────

test('相邻轮次间隔超过默认 45 分钟时强制切段（即便话题词汇相近）', () => {
  assert.equal(DEFAULT_TIME_GAP_MS, 45 * 60 * 1000)
  const turns = [
    makeTurn(0, {
      start: BASE,
      end: BASE + 1 * MIN,
      prompt: '查看 lib/segment.js 的切段逻辑',
      response: '已查看 lib/segment.js 的切段逻辑。',
      files: ['lib/segment.js'],
    }),
    makeTurn(1, {
      start: BASE + 2 * MIN,
      end: BASE + 3 * MIN,
      prompt: '继续调整 lib/segment.js 的切段阈值',
      response: '已调整 lib/segment.js 的切段阈值。',
      files: ['lib/segment.js'],
    }),
    // 隔了 60 分钟，即便仍在聊同一个文件，也必须强切新段（单轮也不应被合并回去）
    makeTurn(2, {
      start: BASE + 63 * MIN,
      end: BASE + 64 * MIN,
      prompt: '继续调整 lib/segment.js 的切段阈值',
      response: '再次微调 lib/segment.js。',
      files: ['lib/segment.js'],
    }),
  ]

  const segs = sliceSessionSegments(turns, { sessionId: SESSION_ID })
  assertSegmentInvariants(turns, segs)
  assert.equal(segs.length, 2, '超过 45 分钟必须强切出 2 段')
  assert.equal(segs[0].startTurn, 0)
  assert.equal(segs[0].endTurn, 1)
  assert.equal(segs[1].startTurn, 2)
  assert.equal(segs[1].endTurn, 2)
})

test('支持自定义 timeGapMs 阈值与 afterCompaction 强制切段', () => {
  const turns = [
    makeTurn(0, { start: BASE, end: BASE + MIN, prompt: '写设计方案', response: '第一部分' }),
    makeTurn(1, { start: BASE + 20 * MIN, end: BASE + 21 * MIN, prompt: '写设计方案第二部分', response: '第二部分' }),
    makeTurn(2, { start: BASE + 22 * MIN, end: BASE + 23 * MIN, prompt: '写设计方案第三部分', response: '第三部分', afterCompaction: true }),
  ]

  const segs = sliceSessionSegments(turns, { sessionId: SESSION_ID, timeGapMs: 15 * MIN })
  assertSegmentInvariants(turns, segs)
  assert.equal(segs.length, 3, '15 分钟间隔 + afterCompaction 应切出 3 段')
})

// ── 4. 文件集合切换信号 ─────────────────────────────────────────────

test('不同文件集合切换时即使句式相近也应切分新段', () => {
  const turns = [
    makeTurn(0, {
      prompt: '请修复一下这个模块里的逻辑问题并运行测试',
      response: '我修改了 modules/payment/checkout.js 并运行了测试。',
      tools: ['edit', 'pwsh'],
      files: ['modules/payment/checkout.js'],
      changes: { files: [{ path: 'modules/payment/checkout.js', added: 6, deleted: 2 }] },
    }),
    makeTurn(1, {
      prompt: '请再优化一下这个模块里的边界处理并运行测试',
      response: '我继续更新了 modules/payment/checkout.js 并通过测试。',
      tools: ['edit', 'pwsh'],
      files: ['modules/payment/checkout.js'],
      changes: { files: [{ path: 'modules/payment/checkout.js', added: 4, deleted: 1 }] },
    }),
    makeTurn(2, {
      prompt: '请修复一下这个模块里的逻辑问题并运行测试',
      response: '我修改了 modules/search/indexer.js 并运行了测试。',
      tools: ['edit', 'pwsh'],
      files: ['modules/search/indexer.js'],
      changes: { files: [{ path: 'modules/search/indexer.js', added: 10, deleted: 3 }] },
    }),
    makeTurn(3, {
      prompt: '请再优化一下这个模块里的边界处理并运行测试',
      response: '我继续更新了 modules/search/indexer.js 并通过测试。',
      tools: ['edit', 'pwsh'],
      files: ['modules/search/indexer.js'],
      changes: { files: [{ path: 'modules/search/indexer.js', added: 5, deleted: 1 }] },
    }),
  ]

  const segs = sliceSessionSegments(turns, { sessionId: SESSION_ID })
  assertSegmentInvariants(turns, segs)
  assert.equal(segs.length, 2, '文件集合从 payment 切换到 search 应切为 2 段')
  assert.deepEqual(segs[0].changedFiles, ['modules/payment/checkout.js'])
  assert.deepEqual(segs[1].changedFiles, ['modules/search/indexer.js'])
})

// ── 5. 提取引用句柄、变更文件（排除纯读）、异常轮次 ──────────────────

test('extractQuoteHandles 与段内 quoteHandles 只从用户提问提取并去重', () => {
  assert.deepEqual(
    extractQuoteHandles('参考【@第3轮对话〔4C42FF36#3〕】和〔deadbeef#12〕，再提一次〔4c42ff36#3〕'),
    ['4c42ff36#3', 'deadbeef#12'],
  )
  assert.deepEqual(extractQuoteHandles('非法句柄〔123#1〕〔zzzzzzzz#2〕〔4c42ff36#a〕'), [])

  const turns = [
    makeTurn(0, {
      prompt: '接着上次【@第10轮对话〔a1b2c3d4#10〕】继续改配置解析器',
      response: '好的，顺便提到回答里的〔ffffffff#99〕不应被当成用户引用。',
      tools: ['edit'],
      changes: { files: [{ path: 'lib/config.js', added: 5, deleted: 1 }] },
    }),
    makeTurn(1, {
      prompt: '顺便对照〔A1B2C3D4#10〕和〔1234abcd#4〕补一个兼容测试',
      response: '已补充。',
      tools: ['edit'],
      changes: { files: [{ path: 'tests/config.mjs', added: 20, deleted: 0 }] },
    }),
  ]

  const segs = sliceSessionSegments(turns, { sessionId: SESSION_ID })
  assert.equal(segs.length, 1)
  assert.deepEqual(segs[0].quoteHandles, ['a1b2c3d4#10', '1234abcd#4'])
})

test('changedFiles 只收变更文件与修改类工具产物，不混入纯读路径与临时噪音', () => {
  const turns = [
    // 纯读轮：read + grep，不应进入 changedFiles
    makeTurn(0, {
      prompt: '先读一下 lib/index.js 和 node_modules/foo/index.js',
      response: '已读完。',
      tools: ['read', 'grep'],
      files: ['lib/index.js', 'node_modules/foo/index.js', 'docs/spec.md'],
    }),
    // 有明确 changes.files 的轮：即使同轮也读了别的参考文件，只收 changes.files
    makeTurn(1, {
      prompt: '改一下 lib/segment.js',
      response: '已修改 lib/segment.js。',
      tools: ['read', 'edit'],
      files: ['lib/lane-engine.js', 'lib/segment.js'],
      changes: { files: [{ path: 'lib/segment.js', added: 50, deleted: 2 }] },
    }),
    // 无 changes 字段但有 write 工具的兼容轮：过滤 Temp/node_modules 等噪音
    makeTurn(2, {
      prompt: '顺便新建测试文件 tests/segment.mjs',
      response: '已写入。',
      tools: ['write'],
      files: ['tests/segment.mjs', 'C:\\Users\\a\\AppData\\Local\\Temp\\scratch.js', 'node_modules/x/a.js'],
    }),
  ]

  const segs = sliceSessionSegments(turns, { sessionId: SESSION_ID })
  assert.equal(segs.length, 1)
  assert.deepEqual(segs[0].changedFiles, ['lib/segment.js', 'tests/segment.mjs'])
  assert.ok(segs[0].files.includes('lib/index.js'), 'segment.files 仍保留所有接触过的文件')
})

test('errorTurns 捕获 error/failed/interrupted/max-tokens/blocked 及 interrupted=true', () => {
  const turns = [
    makeTurn(0, { prompt: '排查构建失败原因', response: '分析中', endReason: 'completed' }),
    makeTurn(1, { prompt: '再跑一次构建', response: '报错退出', endReason: 'error' }),
    makeTurn(2, { prompt: '继续修构建', response: '失败', endReason: 'failed' }),
    makeTurn(3, { prompt: '继续修构建脚本', response: '被中断', endReason: 'interrupted' }),
    makeTurn(4, { prompt: '输出完整构建日志', response: '截断', endReason: 'max-tokens' }),
    makeTurn(5, { prompt: '执行权限受限命令', response: '阻塞', endReason: 'blocked' }),
    makeTurn(6, { prompt: '收尾验证构建', response: '中途打断', endReason: 'completed', interrupted: true }),
    makeTurn(7, { prompt: '取消这一轮', response: '', endReason: 'aborted', interrupted: false }),
  ]

  const segs = sliceSessionSegments(turns, { sessionId: SESSION_ID })
  assertSegmentInvariants(turns, segs)
  const allErrors = segs.flatMap(s => s.errorTurns).sort((a, b) => a - b)
  assert.deepEqual(allErrors, [1, 2, 3, 4, 5, 6])
  assert.equal(allErrors.includes(0), false)
  assert.equal(allErrors.includes(7), false)
  assert.ok(segs.every(s => s.kindCandidate === 'work'))
})

// ── 6. 自动化 / 子代理 / 定时 / 空会话识别 ─────────────────────────

test('isAutomatedSession 识别子代理、定时任务、自动化、0 轮空会话，放行真实会话', () => {
  // 真实会话
  assert.equal(isAutomatedSession({ sessionId: 's1', title: '重构切段模块', firstPrompt: '实现 lib/segment.js', turns: 5 }), false)
  assert.equal(isAutomatedSession({ sessionId: 's2', title: '周末旅游攻略', firstPrompt: '杭州两天怎么玩', turnCount: 2 }), false)
  assert.equal(isAutomatedSession({ sessionId: 's3', title: '普通讨论', firstPrompt: '聊聊架构' }), false)

  // 子代理（平台字段 + 文本特征）
  assert.equal(isAutomatedSession({ sessionId: 'a1', origin: 'subagent', title: '审查', firstPrompt: '检查代码', turns: 2 }), true)
  assert.equal(isAutomatedSession({ sessionId: 'a2', delegationDepth: 1, title: '子任务', firstPrompt: '写测试', turns: 3 }), true)
  assert.equal(isAutomatedSession({ sessionId: 'a3', title: '[dsh-mnemon:delegated review]', firstPrompt: 'Bounded check', turns: 1 }), true)
  assert.equal(isAutomatedSession({ sessionId: 'a4', isSubagent: true, title: 'worker', firstPrompt: 'run', turns: 1 }), true)

  // 定时任务 / 自动化
  assert.equal(isAutomatedSession({ sessionId: 'c1', origin: 'scheduled', title: '每日构建', firstPrompt: '跑测试', turns: 1 }), true)
  assert.equal(isAutomatedSession({ sessionId: 'c2', scheduleId: 'sched-001', title: '日报汇总', firstPrompt: '汇总进展', turns: 1 }), true)
  assert.equal(isAutomatedSession({ sessionId: 'c3', title: '[scheduled] 巡检', firstPrompt: '检查磁盘', turns: 1 }), true)
  assert.equal(isAutomatedSession({ sessionId: 'c4', origin: 'automation', title: 'CI 触发', firstPrompt: '校验', turns: 1 }), true)
  assert.equal(isAutomatedSession({ sessionId: 'c5', title: '', firstPrompt: 'The approval policy changed from "ask" to "never"', turns: 1 }), true)

  // 0 轮空会话与非法入参
  assert.equal(isAutomatedSession({ sessionId: 'e1', title: '新会话', firstPrompt: '', turns: 0 }), true)
  assert.equal(isAutomatedSession({ sessionId: 'e2', title: '空会话', firstPrompt: '', turnCount: 0 }), true)
  assert.equal(isAutomatedSession({ sessionId: 'e3', title: '空数组', turns: [] }), true)
  assert.equal(isAutomatedSession({ sessionId: 'e4', title: '', firstPrompt: '' }), true)
  assert.equal(isAutomatedSession(null), true)
  assert.equal(isAutomatedSession(undefined), true)
})

// ── 7. 模型精化提示词与健壮解析 ─────────────────────────────────────

test('buildSegmentRefinePrompt 生成包含轮次与本地段信息的 {system, user}', () => {
  const turns = [
    makeTurn(0, { prompt: '设计段模块接口', response: '列出 5 个导出函数', files: ['lib/segment.js'] }),
    makeTurn(1, { prompt: '补充测试用例', response: '写出 20 个断言', files: ['tests/segment.mjs'] }),
    makeTurn(2, { prompt: '顺便问下咖啡豆怎么选', response: '看烘焙度与产地' }),
  ]
  const local = [
    ...sliceSessionSegments(turns.slice(0, 1), { sessionId: SESSION_ID }),
    ...sliceSessionSegments(turns.slice(1, 2), { sessionId: SESSION_ID }),
    ...sliceSessionSegments(turns.slice(2, 3), { sessionId: SESSION_ID }),
  ]
  const prompt = buildSegmentRefinePrompt(turns, local)
  assert.equal(typeof prompt.system, 'string')
  assert.equal(typeof prompt.user, 'string')
  assert.ok(prompt.system.includes('kindCandidate'))
  assert.ok(prompt.system.includes('work') && prompt.system.includes('chat'))
  assert.ok(prompt.user.includes('设计段模块接口'))
  assert.ok(prompt.user.includes('咖啡豆怎么选'))
  assert.ok(prompt.user.includes('0'))
  assert.ok(prompt.user.includes('2'))
})

test('parseSegmentRefineResult 支持修正标题、合并过碎相邻段、精化 kindCandidate 与 summary', () => {
  const turns = [
    makeTurn(0, {
      prompt: '设计段模块接口',
      response: '列出导出函数',
      tools: ['edit'],
      files: ['lib/segment.js'],
      changes: { files: [{ path: 'lib/segment.js', added: 40, deleted: 0 }] },
    }),
    makeTurn(1, {
      prompt: '补充段模块单测',
      response: '测试通过',
      tools: ['edit', 'pwsh'],
      files: ['tests/segment.mjs'],
      commands: ['node tests/segment.mjs'],
      changes: { files: [{ path: 'tests/segment.mjs', added: 80, deleted: 0 }] },
    }),
    makeTurn(2, {
      prompt: '顺便问下咖啡豆怎么选',
      response: '浅烘偏果酸，深烘偏焦苦。',
    }),
  ]
  // 模拟本地切得偏碎：3 个 1 轮段
  const local = [
    sliceSessionSegments([turns[0]], { sessionId: SESSION_ID })[0],
    sliceSessionSegments([turns[1]], { sessionId: SESSION_ID })[0],
    sliceSessionSegments([turns[2]], { sessionId: SESSION_ID })[0],
  ]

  const modelText = `好的，精化结果如下：
\`\`\`json
[
  {
    "startTurn": 0,
    "endTurn": 1,
    "title": "实现并测试段模块",
    "kindCandidate": "work",
    "summary": "完成 lib/segment.js 核心实现并补齐单元测试"
  },
  {
    "startTurn": 2,
    "endTurn": 2,
    "title": "咖啡豆选购闲聊",
    "kindCandidate": "chat",
    "summary": "讨论浅烘与深烘咖啡豆的风味差异"
  }
]
\`\`\`
以上。`

  const refined = parseSegmentRefineResult(modelText, local)
  assert.equal(refined.length, 2, '前两段应被合并为 1 段')
  assert.equal(refined[0].id, 'seg:4c42ff36:0-1')
  assert.equal(refined[0].startTurn, 0)
  assert.equal(refined[0].endTurn, 1)
  assert.equal(refined[0].turnCount, 2)
  assert.equal(refined[0].title, '实现并测试段模块')
  assert.equal(refined[0].kindCandidate, 'work')
  assert.equal(refined[0].summary, '完成 lib/segment.js 核心实现并补齐单元测试')
  assert.deepEqual(refined[0].changedFiles, ['lib/segment.js', 'tests/segment.mjs'])
  assert.deepEqual(refined[0].commands, ['node tests/segment.mjs'])

  assert.equal(refined[1].id, 'seg:4c42ff36:2-2')
  assert.equal(refined[1].title, '咖啡豆选购闲聊')
  assert.equal(refined[1].kindCandidate, 'chat')
  assert.equal(refined[1].summary, '讨论浅烘与深烘咖啡豆的风味差异')
})

test('parseSegmentRefineResult 兼容对象包裹格式 {"segments": [...]}', () => {
  const turns = [makeTurn(0, { prompt: '看看天气', response: '晴天' })]
  const local = sliceSessionSegments(turns, { sessionId: SESSION_ID })
  const wrapped = JSON.stringify({
    segments: [
      { startTurn: 0, endTurn: 0, title: '查询天气', kindCandidate: 'chat', summary: '询问今日天气情况' },
    ],
  })
  const refined = parseSegmentRefineResult(wrapped, local)
  assert.equal(refined.length, 1)
  assert.equal(refined[0].title, '查询天气')
  assert.equal(refined[0].summary, '询问今日天气情况')
})

test('parseSegmentRefineResult 遇到损坏/非法/越界/缺口输出时安全降级回本地结果', () => {
  const turns = [
    makeTurn(0, { prompt: '修 bug', response: 'ok', tools: ['edit'], changes: { files: [{ path: 'a.js', added: 1, deleted: 0 }] } }),
    makeTurn(1, { prompt: '再测一次', response: 'ok', tools: ['pwsh'], commands: ['npm test'] }),
    makeTurn(2, { start: BASE + 120 * MIN, end: BASE + 121 * MIN, prompt: '晚饭吃什么', response: '面条' }),
  ]
  const local = sliceSessionSegments(turns, { sessionId: SESSION_ID })
  assert.equal(local.length, 2)

  // 1. 垃圾文本 / 空串
  assert.deepEqual(parseSegmentRefineResult('完全不是 JSON', local), local)
  assert.deepEqual(parseSegmentRefineResult('', local), local)
  assert.deepEqual(parseSegmentRefineResult(null, local), local)

  // 2. 边界存在缺口（漏掉第 1 轮）
  const gapOut = JSON.stringify([
    { startTurn: 0, endTurn: 0, title: 'A', kindCandidate: 'work', summary: 'a' },
    { startTurn: 2, endTurn: 2, title: 'B', kindCandidate: 'chat', summary: 'b' },
  ])
  assert.deepEqual(parseSegmentRefineResult(gapOut, local), local)

  // 3. 边界重叠
  const overlapOut = JSON.stringify([
    { startTurn: 0, endTurn: 1, title: 'A', kindCandidate: 'work', summary: 'a' },
    { startTurn: 1, endTurn: 2, title: 'B', kindCandidate: 'chat', summary: 'b' },
  ])
  assert.deepEqual(parseSegmentRefineResult(overlapOut, local), local)

  // 4. 越界轮号
  const oobOut = JSON.stringify([
    { startTurn: 0, endTurn: 5, title: 'A', kindCandidate: 'work', summary: 'a' },
  ])
  assert.deepEqual(parseSegmentRefineResult(oobOut, local), local)

  // 5. 降级结果是新拷贝，不与入参共享引用
  const fallback = parseSegmentRefineResult('broken', local)
  assert.notEqual(fallback, local)
  assert.notEqual(fallback[0], local[0])
})

// ── 8. 历史轨「段 → 轮次」两级目录 ──────────────────────────────────

test('toRailOutlineWithSegments 组装两级目录，段头含 title/范围/kindCandidate/hasError/turnCount', () => {
  const turns = [
    makeTurn(0, {
      prompt: '排查登录错误\n附带堆栈信息',
      response: '找到原因',
      tools: ['read'],
      files: ['lib/auth.js'],
      endReason: 'completed',
    }),
    makeTurn(1, {
      prompt: '修复 lib/auth.js 并执行单测',
      response: '测试报错',
      tools: ['edit', 'pwsh'],
      files: ['lib/auth.js'],
      commands: ['node tests/auth.mjs'],
      changes: { files: [{ path: 'lib/auth.js', added: 5, deleted: 1 }] },
      endReason: 'error',
    }),
    makeTurn(2, {
      start: BASE + 90 * MIN,
      end: BASE + 91 * MIN,
      prompt: '晚上吃什么比较好？',
      response: '可以吃火锅。',
      endReason: 'completed',
    }),
  ]

  const segs = sliceSessionSegments(turns, { sessionId: SESSION_ID })
  const rail = toRailOutlineWithSegments(turns, segs)

  assert.equal(rail.length, 2)

  assert.equal(rail[0].id, segs[0].id)
  assert.equal(rail[0].title, segs[0].title)
  assert.equal(rail[0].startTurn, 0)
  assert.equal(rail[0].endTurn, 1)
  assert.equal(rail[0].kindCandidate, 'work')
  assert.equal(rail[0].hasError, true)
  assert.equal(rail[0].turnCount, 2)
  assert.equal(rail[0].turns.length, 2)
  assert.equal(rail[0].turns[0].turn, 0)
  assert.equal(rail[0].turns[0].promptHead, '排查登录错误 附带堆栈信息')
  assert.equal(rail[0].turns[0].hasError, false)
  assert.equal(rail[0].turns[1].turn, 1)
  assert.equal(rail[0].turns[1].hasError, true)

  assert.equal(rail[1].startTurn, 2)
  assert.equal(rail[1].endTurn, 2)
  assert.equal(rail[1].kindCandidate, 'chat')
  assert.equal(rail[1].hasError, false)
  assert.equal(rail[1].turnCount, 1)
  assert.equal(rail[1].turns.length, 1)
  assert.equal(rail[1].turns[0].turn, 2)
})

test('toRailOutlineWithSegments 兼容轻量大纲行格式与空输入', () => {
  assert.deepEqual(toRailOutlineWithSegments([], []), [])

  const outlineRows = [
    { turn: 0, promptHead: '修一下导出脚本', time: BASE + 1000, start: BASE, endReason: 'completed', endSeq: 3 },
    { turn: 1, promptHead: '补个单测验证', time: BASE + 61000, start: BASE + 60000, endReason: 'blocked', endSeq: 7 },
  ]
  const segs = [
    {
      id: 'seg:abcd1234:0-1',
      title: '修复导出脚本',
      startTurn: 0,
      endTurn: 1,
      turnCount: 2,
      kindCandidate: 'work',
      errorTurns: [1],
      startTime: BASE,
      endTime: BASE + 61000,
      summary: '修复导出脚本并补单测',
    },
  ]
  const rail = toRailOutlineWithSegments(outlineRows, segs)
  assert.equal(rail.length, 1)
  assert.equal(rail[0].hasError, true)
  assert.equal(rail[0].turns[0].promptHead, '修一下导出脚本')
  assert.equal(rail[0].turns[1].endReason, 'blocked')
  assert.equal(rail[0].turns[1].hasError, true)
})

// ── 9. 额外边界场景（乱序输入、不修改入参、非连续轮号、空 changes） ──

test('乱序轮次与非连续轮号仍保持连续不重叠全覆盖，且不修改入参', () => {
  const turns = [
    makeTurn(5, { start: BASE + 5 * MIN, end: BASE + 6 * MIN, prompt: '继续优化支付接口重试策略', response: '已调整重试退避', files: ['lib/pay.js'] }),
    makeTurn(2, { start: BASE + 2 * MIN, end: BASE + 3 * MIN, prompt: '排查支付接口超时并优化重试策略', response: '分析 lib/pay.js 超时原因', files: ['lib/pay.js'] }),
    makeTurn(8, { start: BASE + 100 * MIN, end: BASE + 101 * MIN, prompt: '周末去看什么电影好？', response: '可以看看新上映的科幻片。' }),
  ]
  const snapshot = JSON.stringify(turns)
  const segs = sliceSessionSegments(turns, { sessionId: SESSION_ID })
  assert.equal(JSON.stringify(turns), snapshot, '绝不修改入参数组及元素')
  assertSegmentInvariants(turns, segs)
  assert.equal(segs.length, 2)
  assert.equal(segs[0].startTurn, 2)
  assert.equal(segs[0].endTurn, 5)
  assert.equal(segs[0].turnCount, 2)
  assert.equal(segs[0].id, 'seg:4c42ff36:2-5')
  assert.equal(segs[1].startTurn, 8)
  assert.equal(segs[1].endTurn, 8)
  assert.equal(segs[1].kindCandidate, 'chat')
})

test('宿主明确给出 changes.files=[] 时不从 files 误抓读路径', () => {
  const turns = [
    makeTurn(0, {
      prompt: '尝试修改 lib/demo.js 但取消了写入',
      response: '未修改文件。',
      tools: ['read', 'edit'],
      files: ['lib/demo.js', 'docs/guide.md'],
      changes: { files: [] },
    }),
  ]
  const segs = sliceSessionSegments(turns, { sessionId: SESSION_ID })
  assert.equal(segs.length, 1)
  assert.deepEqual(segs[0].changedFiles, [])
  assert.equal(segs[0].kindCandidate, 'work')
})

test('parseSegmentRefineResult 遇到仅包含局部覆盖或非法 kindCandidate 时的处理', () => {
  const turns = [
    makeTurn(0, { prompt: '写一个排序脚本', response: '已写', tools: ['write'], files: ['scripts/sort.mjs'], changes: { files: [{ path: 'scripts/sort.mjs', added: 20, deleted: 0 }] } }),
    makeTurn(1, { start: BASE + 120 * MIN, end: BASE + 121 * MIN, prompt: '下午喝什么茶', response: '乌龙茶不错' }),
  ]
  const local = sliceSessionSegments(turns, { sessionId: SESSION_ID })
  assert.equal(local.length, 2)

  // 只覆盖了第 1 段、漏掉第 2 段 → 降级回本地
  const partial = JSON.stringify([
    { startTurn: 0, endTurn: 0, title: '排序脚本', kindCandidate: 'work', summary: '编写排序脚本' },
  ])
  assert.deepEqual(parseSegmentRefineResult(partial, local), local)

  // 边界合法但 kindCandidate 非法 → 回落到本地初判，标题与摘要仍可采纳
  const badKind = JSON.stringify([
    { startTurn: 0, endTurn: 0, title: '编写排序脚本', kindCandidate: 'unknown', summary: '实现数组排序脚本' },
    { startTurn: 1, endTurn: 1, title: '下午茶闲聊', kindCandidate: 'chat', summary: '聊乌龙茶推荐' },
  ])
  const refined = parseSegmentRefineResult(badKind, local)
  assert.equal(refined.length, 2)
  assert.equal(refined[0].kindCandidate, 'work')
  assert.equal(refined[0].title, '编写排序脚本')
  assert.equal(refined[1].kindCandidate, 'chat')
  assert.equal(refined[1].title, '下午茶闲聊')
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) process.exitCode = 1
