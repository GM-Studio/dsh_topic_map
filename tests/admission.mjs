/**
 * 准入判定（ADR-0006 三条红线：有意图 / 未收尾 / 人类主导）行为测试。
 *
 * 覆盖：
 *   1. 三红线必须同时满足才 admitted；未准入时 reasons 至少一项；
 *   2. 有意图：工程动作算有意图，纯概念咨询 / 纯解释 / 纯闲聊 / 单次查询算 no_intent；
 *   3. 未收尾：末尾未解报错 / 待验证步骤 / 未完成清单 / 「下次接着做」→ 未收尾；
 *      末尾「测试通过 + 提交/验收 + 人明确收口」→ already_closed；
 *   4. 人类主导：子代理 / 自动化 / 空会话 / trigger==='automated' → not_human；
 *   5. 人的确认高于红线：stateSource==='confirmed' 一律 admitted:true, reasons:[]；
 *   6. kind 区分 'work' / 'chat'；confidence 区分 high / low；
 *   7. 确定性：同输入同输出（深比较）；不改入参；纯函数无 IO。
 *
 * 语料全部为合成文本，不含任何真实会话正文。
 *
 * Run: node tests/admission.mjs
 */

import { strict as assert } from 'node:assert'
import { ADMISSION_REASONS, judgeAdmission } from '../lib/admission.js'

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

/** 合成轮次：默认是「有产出的工程轮」。 */
function turn(overrides = {}) {
  return {
    turn: 1,
    seq: 1,
    prompt: '修复登录鉴权报错',
    start: 1_700_000_000_000,
    end: 1_700_000_030_000,
    files: [],
    commands: [],
    ok: true,
    ...overrides,
  }
}

function turnsOf(prompts, base = {}) {
  return prompts.map((prompt, i) => turn({ turn: i + 1, seq: i * 2 + 1, prompt, ...base }))
}

/** 语料：一次连续排障，末尾停在 AI 反问（未收尾 + 有意图）。 */
function troubleshooting() {
  const list = turnsOf([
    '帮我看下这个插件加载报错',
    '还是报错，我贴一下完整日志',
    '试试换成动态 import',
    '现在不报错了，但是界面白屏',
    '修一下导出清单',
    '跑一下全量测试看看',
    '还有 3 个用例失败了',
    '这个改动要不要一起提交？',
  ])
  list[0].commands = ['node scripts/test.mjs']
  list[5].files = ['lib/client.js', 'lib/work-view.js']
  list[5].commands = ['node scripts/test.mjs']
  list[7].files = ['lib/admission.js']
  return list
}

/** 语料：纯概念咨询（无产出意图）。 */
function consulting() {
  return turnsOf(['什么是 CQRS？', '那和事件溯源有什么区别？', '明白了，谢谢'])
}

/** 语料：3 轮小修，末尾测试通过 + 提交 + 人明确收口。 */
function closedFix() {
  const list = turnsOf(['把 README 里的旧图删掉', '删除并提交', '好了，可以了，这个结束'])
  list[1].files = ['README.md']
  list[1].commands = ['git commit -m "docs: 删除旧图"']
  list[1].commandResults = [{ command: 'git commit -m "docs: 删除旧图"', ok: true, exitCode: 0 }]
  list[2].commands = ['node scripts/test.mjs']
  list[2].commandResults = [{ command: 'node scripts/test.mjs', ok: true, exitCode: 0 }]
  return list
}

console.log('\nadmission')

// ── 常量 ────────────────────────────────────────────────────────────

test('ADMISSION_REASONS 冻结且四值齐全', () => {
  assert.equal(Object.isFrozen(ADMISSION_REASONS), true)
  assert.deepEqual(ADMISSION_REASONS, {
    ADMITTED: 'admitted',
    NO_INTENT: 'no_intent',
    ALREADY_CLOSED: 'already_closed',
    NOT_HUMAN: 'not_human',
  })
})

// ── 三红线同时满足 ──────────────────────────────────────────────────

test('三红线同时满足 → admitted:true 且 reasons 为空', () => {
  const res = judgeAdmission({
    turns: troubleshooting(),
    title: '修复插件加载报错',
    sessionCount: 1,
    turnCount: 8,
  })
  assert.equal(res.admitted, true)
  assert.deepEqual(res.reasons, [])
  assert.equal(res.kind, 'work')
  assert.equal(typeof res.signals, 'object')
  assert.ok(res.signals !== null)
})

test('threeReds 信号如实回报三条红线的判定结果', () => {
  const res = judgeAdmission({ turns: troubleshooting(), title: '修复加载报错' })
  const three = res.signals.threeReds
  assert.ok(three && typeof three === 'object', 'signals.threeReds 必须存在')
  assert.equal(three.intent, true)
  assert.equal(three.unfinished, true)
  assert.equal(three.humanLed, true)
  assert.equal(res.signals.kind, 'work')
})

// ── 既有集成测试里的四类语料（回归锚点） ────────────────────────────

test('连续排障会话准入（集成语料）', () => {
  const res = judgeAdmission({ turns: troubleshooting(), title: '修复插件加载报错', sessionCount: 1 })
  assert.equal(res.admitted, true)
  assert.deepEqual(res.reasons, [])
})

test('纯架构咨询 → no_intent', () => {
  const res = judgeAdmission({ turns: consulting(), title: '咨询 CQRS', sessionCount: 1 })
  assert.equal(res.admitted, false)
  assert.ok(res.reasons.includes(ADMISSION_REASONS.NO_INTENT), JSON.stringify(res.reasons))
  assert.equal(res.kind, 'chat')
})

test('已验收收口的小修 → already_closed', () => {
  const turns = closedFix()
  const byTurns = judgeAdmission({ turns, title: '删除旧图', sessionCount: 1, turnCount: turns.length })
  assert.equal(byTurns.admitted, false)
  assert.ok(byTurns.reasons.includes(ADMISSION_REASONS.ALREADY_CLOSED), JSON.stringify(byTurns.reasons))

  // state === 'done' 单独也判已收尾
  const byState = judgeAdmission({ turns, title: '删除旧图', state: 'done' })
  assert.equal(byState.admitted, false)
  assert.ok(byState.reasons.includes(ADMISSION_REASONS.ALREADY_CLOSED))
})

test('automated 触发 → not_human', () => {
  const res = judgeAdmission({ turns: troubleshooting(), trigger: 'automated', sessionCount: 1 })
  assert.equal(res.admitted, false)
  assert.ok(res.reasons.includes(ADMISSION_REASONS.NOT_HUMAN), JSON.stringify(res.reasons))
})

test('人的确认高于红线：stateSource==="confirmed" 一律准入', () => {
  const res = judgeAdmission({ turns: consulting(), title: '咨询', stateSource: 'confirmed' })
  assert.equal(res.admitted, true)
  assert.deepEqual(res.reasons, [])
  assert.equal(res.signals.confirmed, true)
  assert.equal(res.signals.stateSource, 'confirmed')
})

// ── 红线 1：有意图 ──────────────────────────────────────────────────

test('红线 1 反例：纯解释 / 纯闲聊 / 单次查询都判 no_intent', () => {
  const cases = [
    ['什么是 DI 的控制反转？', '解释一下这个报错是什么意思', '明白了'],
    ['今天午饭吃什么好呢', '哈哈那就算了', '下次聊'],
  ]
  for (const prompts of cases) {
    const res = judgeAdmission({ turns: turnsOf(prompts), title: prompts[0], sessionCount: 1 })
    assert.equal(res.admitted, false, prompts.join(' / '))
    assert.ok(res.reasons.includes(ADMISSION_REASONS.NO_INTENT), prompts[0] + ' → ' + JSON.stringify(res.reasons))
    assert.equal(res.signals.threeReds.intent, false)
  }
})

test('红线 1 正例：有文件改动 / 工程动词 / 产出意图都算有意图', () => {
  const byFiles = judgeAdmission({
    turns: [turn({ prompt: '看看这个', files: ['lib/admission.js'] })],
    title: '看代码',
  })
  assert.equal(byFiles.signals.threeReds.intent, true)

  const byVerb = judgeAdmission({ turns: turnsOf(['帮我重构一下这个模块']), title: '重构' })
  assert.equal(byVerb.signals.threeReds.intent, true)

  const byGoal = judgeAdmission({ turns: [turn({ prompt: '随便看看' })], goal: '消除并发刷新 401' })
  assert.equal(byGoal.signals.threeReds.intent, true)
})

test('红线 1：纯问答即使轮数多也不算有意图（不得只靠轮数）', () => {
  const prompts = []
  for (let i = 0; i < 30; i += 1) prompts.push('那这个概念呢 ' + i)
  const res = judgeAdmission({ turns: turnsOf(prompts), title: '聊架构原理' })
  assert.equal(res.admitted, false)
  assert.ok(res.reasons.includes(ADMISSION_REASONS.NO_INTENT))
})

test('红线 1：modelHint 只能补充判断，缺模型也照样工作（不得依赖模型）', () => {
  // 无 modelHint：启发式独立可用
  const without = judgeAdmission({ turns: turnsOf(['帮我修复这个报错']), title: '修复报错' })
  assert.equal(without.signals.threeReds.intent, true)
  assert.equal(without.signals.modelHint, null)

  // modelHint.intent === false 时可由模型收窄
  const narrowed = judgeAdmission({
    turns: turnsOf(['帮我看看这个']),
    title: '随便看看',
    files: ['lib/x.js'],
  }, { modelHint: { intent: false, kind: 'chat' } })
  assert.equal(narrowed.signals.threeReds.intent, false)
  assert.equal(narrowed.kind, 'chat')

  // 反过来：启发式判 no_intent，但 modelHint 说有意图 → 采纳模型（模型只说「更好」，不成为唯一路径）
  const widened = judgeAdmission({ turns: turnsOf(['解释一下这个模块']), title: '解释' }, { modelHint: { intent: true, kind: 'work' } })
  assert.equal(widened.signals.threeReds.intent, true)
  assert.equal(widened.kind, 'work')
})

// ── 红线 2：未收尾 ──────────────────────────────────────────────────

test('红线 2 正例：末尾未解报错判为未收尾', () => {
  const turns = turnsOf(['修一下构建脚本', '还是失败'])
  turns[1].ok = false
  turns[1].endReason = 'error'
  turns[1].commands = ['node scripts/build-theme.mjs']
  const res = judgeAdmission({ turns, title: '修构建脚本' })
  assert.equal(res.admitted, true)
  assert.equal(res.signals.threeReds.unfinished, true)
  assert.equal(res.signals.closed.verified, false)
})

test('红线 2 正例：末尾未完成清单 / 待验证步骤判为未收尾', () => {
  const checklist = turnsOf(['实现导出清单', '剩下三件事没做：补测试、写文档、跑校验'])
  const res1 = judgeAdmission({ turns: checklist, title: '实现导出清单' })
  assert.equal(res1.signals.threeReds.unfinished, true)

  const verify = turnsOf(['改完了，等你验证'])
  const res2 = judgeAdmission({ turns: verify, title: '改完了' })
  assert.equal(res2.signals.threeReds.unfinished, true)
})

test('红线 2 正例：人明确说「下次接着做 / 先这样」判为未收尾（优先于已收尾证据）', () => {
  const turns = closedFix()
  turns[2].prompt = '先这样，下次接着做'
  const res = judgeAdmission({ turns, title: '删除旧图' })
  assert.equal(res.admitted, true)
  assert.equal(res.signals.userClosed, false)
  assert.equal(res.signals.deferred, true)
  assert.equal(res.signals.threeReds.unfinished, true)
})

test('红线 2 反例：测试通过 + 提交 + 人明确收口 → already_closed', () => {
  const turns = closedFix()
  const res = judgeAdmission({ turns, title: '删除旧图' })
  assert.equal(res.admitted, false)
  assert.ok(res.reasons.includes(ADMISSION_REASONS.ALREADY_CLOSED))
  assert.equal(res.signals.closed.verified, true)
  assert.equal(res.signals.closed.committed, true)
  assert.equal(res.signals.closed.userClosed, true)
})

test('红线 2 边界：只有「测试通过」没有提交/收口，不算已收尾', () => {
  const turns = turnsOf(['修一下', '跑测试', '测试全过了'])
  turns[2].commands = ['node scripts/test.mjs']
  turns[2].commandResults = [{ command: 'node scripts/test.mjs', ok: true, exitCode: 0 }]
  const res = judgeAdmission({ turns, title: '修一下' })
  assert.equal(res.signals.closed.verified, true)
  assert.equal(res.signals.closed.committed, false)
  assert.equal(res.signals.closed.userClosed, false)
  assert.equal(res.admitted, true, '未收尾（还差验收/收口）应保持准入')
})

test('红线 2：末尾文件名不该被当成「报错里提到 test」而误判，实测取真实失败', () => {
  const turns = turnsOf(['跑一下测试', 'ok 12 passed'])
  turns[1].files = ['tests/admission.mjs']
  turns[1].commands = ['node tests/admission.mjs']
  turns[1].ok = true
  turns[1].commandResults = [{ command: 'node tests/admission.mjs', ok: true, exitCode: 0 }]
  const res = judgeAdmission({ turns, title: '补测试' })
  assert.equal(res.signals.closed.verified, true)
})

test('红线 2：awaiting 信号是未收尾的强证据（契约 input.awaiting）', () => {
  const res = judgeAdmission({
    turns: turnsOf(['改一下设置项', '好']),
    title: '改设置项',
    awaiting: { active: true, summary: '这个改动要不要一起提交？', turn: 2 },
  })
  assert.equal(res.admitted, true)
  assert.equal(res.signals.threeReds.unfinished, true)
})

// ── 红线 3：人类主导 ────────────────────────────────────────────────

test('红线 3 反例：子代理 / 自动化 / 空会话 / 0 轮 → not_human', () => {
  const cases = [
    { turns: troubleshooting(), origin: 'subagent' },
    { turns: troubleshooting(), isSubagent: true },
    { turns: troubleshooting(), automated: true },
    { turns: troubleshooting(), trace: { origin: 'subagent' } },
    { turns: troubleshooting(), trigger: 'automated' },
    { turns: [] },
    { turns: [], turnCount: 0 },
    // 「空会话」只有在**确实没有轮次**（turns 是空数组）时才判 not_human；
    // 丢掉 turns 后同一份元数据只算「证据未知」，见下方 fail-open 用例
    { turns: [], sessionCount: 0, title: '空会话' },
  ]
  for (const input of cases) {
    const res = judgeAdmission({ title: '某会话', ...input })
    assert.equal(res.admitted, false, JSON.stringify(Object.keys(input)))
    assert.ok(res.reasons.includes(ADMISSION_REASONS.NOT_HUMAN), JSON.stringify(input) + ' → ' + JSON.stringify(res.reasons))
  }
})

test('红线 3 正例：人类发起的真实工作会话不算自动化', () => {
  const res = judgeAdmission({ turns: troubleshooting(), trigger: 'human', title: '修复加载报错' })
  assert.equal(res.signals.threeReds.humanLed, true)
  assert.equal(res.admitted, true)
})

test('红线 3：segments / sessionIds / state 等既有字段不影响人类主导判定', () => {
  const res = judgeAdmission({
    turns: troubleshooting(),
    segments: [{ id: 'seg-1', kindCandidate: 'work' }],
    sessionIds: ['session-aaaa'],
    sessionCount: 1,
    state: 'active',
  })
  assert.equal(res.signals.threeReds.humanLed, true)
  assert.equal(res.admitted, true)
})

// ── 红线 3 的三态证据：已证明 / 未知 / 确实为空（防止静默清空面板） ──

test('渲染期调用（无 turns）不得因红线 3 挡掉任何已有事', () => {
  const workLike = {
    title: '修复插件加载报错',
    goal: '让插件正常加载',
    state: 'active',
    stateSource: 'inferred',
    files: ['lib/client.js'],
    sessionCount: 1,
    trigger: 'user',
  }
  const res = judgeAdmission({ ...workLike, turnCount: 5 }, {})
  assert.equal(res.admitted, true, '无 turns 时必须 fail-open，不得挡下')
  assert.deepEqual(res.reasons, [])
  assert.ok(!res.reasons.includes(ADMISSION_REASONS.NOT_HUMAN))
  assert.equal(res.signals.threeReds.humanLed, true)
  assert.equal(res.signals.humanReason, 'unknown')
  assert.equal(res.signals.humanEvidenceUnknown, true)
  assert.equal(res.confidence, 'low', '证据未知时不得报 high')
})

test('不变式：去掉 turns 前后，准入结论不得由「准入」翻转成「挡下」', () => {
  const turns = troubleshooting()
  const withTurns = judgeAdmission({ turns, title: '修复插件加载报错', turnCount: turns.length }, {})
  const withoutTurns = judgeAdmission({
    title: '修复插件加载报错',
    state: 'active',
    files: ['lib/client.js'],
    sessionCount: 1,
    turnCount: turns.length,
  }, {})
  assert.equal(withTurns.admitted, true)
  assert.equal(withoutTurns.admitted, true, '渲染期（无 turns）不得把准入翻成挡下')
  assert.ok(!withoutTurns.reasons.includes(ADMISSION_REASONS.NOT_HUMAN))
})

test('turnCount / sessionCount > 0 是人类主导的弱证据，不否决（仅影响 confidence）', () => {
  const base = { title: '修复插件加载报错', goal: '让插件正常加载', files: ['lib/client.js'] }

  const byTurnCount = judgeAdmission({ ...base, turnCount: 5 }, {})
  assert.equal(byTurnCount.admitted, true, JSON.stringify(byTurnCount.reasons))
  assert.equal(byTurnCount.signals.humanReason, 'unknown')
  assert.equal(byTurnCount.confidence, 'low', '未知证据即便有弱证据也不得报 high')

  const bySessionCount = judgeAdmission({ ...base, sessionCount: 2 }, {})
  assert.equal(bySessionCount.admitted, true, JSON.stringify(bySessionCount.reasons))
  assert.equal(bySessionCount.signals.humanReason, 'unknown')
  assert.equal(bySessionCount.confidence, 'low')
})

test('证据未知时即使别的红线也不过，reasons 里也绝不出现 not_human', () => {
  // 无目标 / 无文件 → 意图这条红线本就不过，但红线 3 处于未知，不许被顶成 not_human
  const res = judgeAdmission({ title: '某事', turnCount: 5 }, {})
  assert.ok(!res.reasons.includes(ADMISSION_REASONS.NOT_HUMAN), JSON.stringify(res.reasons))
  assert.equal(res.signals.humanReason, 'unknown')
  // 其余红线该失败的照常失败：fail-open 只针对「未知」，不针对「已知不合规」
  assert.equal(res.admitted, false)
  assert.ok(res.reasons.includes(ADMISSION_REASONS.NO_INTENT))
})

test('sessionCount<=0 单独不构成非人类的正面证据（未知仍 fail-open）', () => {
  const res = judgeAdmission({ title: '空会话', sessionCount: 0, turnCount: 3 }, {})
  assert.equal(res.signals.humanReason, 'unknown')
  assert.ok(!res.reasons.includes(ADMISSION_REASONS.NOT_HUMAN))
})

test('turns 缺失时如实回报声明的轮数，不谎报 0', () => {
  const res = judgeAdmission({ title: '某事', turnCount: 7 }, {})
  assert.equal(res.signals.turnsKnown, false)
  assert.equal(res.signals.turnCount, 7)
  assert.equal(res.signals.declaredTurnCount, 7)
})

test('turns 是数组且为空 + turnCount:0 → 仍判 not_human（0 轮不该立事）', () => {
  const res = judgeAdmission({ turns: [], turnCount: 0, title: '空会话' }, {})
  assert.equal(res.admitted, false)
  assert.ok(res.reasons.includes(ADMISSION_REASONS.NOT_HUMAN))
  assert.equal(res.signals.humanReason, 'no_turns')
  assert.equal(res.signals.humanEvidenceUnknown, false)
  assert.equal(res.signals.turnsKnown, true)
})

test('有正面自动化证据时即使 turns 很多也判 not_human，且 confidence 为 high', () => {
  const cases = [
    { trigger: 'automated', reason: 'trigger:automated' },
    { origin: 'subagent', reason: 'origin:subagent' },
    { delegationDepth: 1, reason: 'delegationDepth' },
    { isSubagent: true, reason: 'flag' },
    { trace: { origin: 'subagent' }, reason: 'trace:subagent' },
  ]
  for (const c of cases) {
    const res = judgeAdmission({
      turns: troubleshooting(),
      title: '修复插件加载报错',
      turnCount: 8,
      ...c,
    }, {})
    assert.equal(res.admitted, false, JSON.stringify(c))
    assert.ok(res.reasons.includes(ADMISSION_REASONS.NOT_HUMAN), JSON.stringify(c))
    assert.equal(res.signals.humanReason, c.reason)
    assert.equal(res.signals.humanEvidenceUnknown, false)
    assert.equal(res.confidence, 'high', JSON.stringify(c) + ' 已证明非人类 → 硬信号')
  }
})

test('正面证据与 turns 缺失组合：自动化证据仍然成立（不因未知而放行）', () => {
  const res = judgeAdmission({ title: '某事', trigger: 'automated', turnCount: 4 }, {})
  assert.equal(res.admitted, false)
  assert.ok(res.reasons.includes(ADMISSION_REASONS.NOT_HUMAN))
  assert.equal(res.signals.humanReason, 'trigger:automated')
  assert.equal(res.signals.humanEvidenceUnknown, false)
})

test('turns 非数组（对象 / 字符串 / null）一律按证据未知处理，不误判', () => {
  for (const bad of [{}, 'nope', null, 42, undefined]) {
    const res = judgeAdmission({ title: '某事', turns: bad, turnCount: 3 }, {})
    assert.equal(res.signals.humanReason, 'unknown', JSON.stringify(bad))
    assert.equal(res.signals.threeReds.humanLed, true, JSON.stringify(bad))
    assert.ok(!res.reasons.includes(ADMISSION_REASONS.NOT_HUMAN), JSON.stringify(bad))
  }
})

// ── 未准入时 reasons 至少一项 / 多红线可同时未过 ────────────────────

test('多条红线同时不过时 reasons 逐条列出（去重、无 admitted 项）', () => {
  const res = judgeAdmission({ turns: [], trigger: 'automated', title: '' })
  assert.equal(res.admitted, false)
  assert.ok(res.reasons.length >= 1)
  assert.ok(!res.reasons.includes(ADMISSION_REASONS.ADMITTED))
  assert.equal(new Set(res.reasons).size, res.reasons.length, 'reasons 必须去重')
})

test('admitted===true ⟺ reasons 为空数组（双向不变量）', () => {
  const inputs = [
    { turns: troubleshooting(), title: '排障' },
    { turns: consulting(), title: '咨询' },
    { turns: [], title: '' },
    { turns: troubleshooting(), stateSource: 'confirmed' },
    { turns: closedFix(), title: '小修' },
  ]
  for (const input of inputs) {
    const res = judgeAdmission(input)
    if (res.admitted) assert.deepEqual(res.reasons, [], JSON.stringify(input.title))
    else assert.ok(res.reasons.length >= 1, JSON.stringify(input.title))
  }
})

// ── confidence ──────────────────────────────────────────────────────

test('confidence：硬信号充分为 high，全靠启发式为 low', () => {
  const strong = judgeAdmission({ turns: troubleshooting(), title: '修复加载报错', state: 'active' })
  assert.equal(strong.confidence, 'high')

  const weak = judgeAdmission({ turns: turnsOf(['帮我看看']), title: '看看' })
  assert.equal(weak.confidence, 'low')
})

// ── kind ────────────────────────────────────────────────────────────

test('kind：有产出意图判 work，纯概念咨询判 chat', () => {
  assert.equal(judgeAdmission({ turns: troubleshooting(), title: '排障' }).kind, 'work')
  assert.equal(judgeAdmission({ turns: consulting(), title: '咨询' }).kind, 'chat')
  assert.equal(judgeAdmission({ turns: [], title: '' }).kind, 'chat')
})

test('kind 可由 options.modelHint.kind 收窄，但取值只能是 work / chat', () => {
  const res = judgeAdmission({ turns: troubleshooting(), title: '排障' }, { modelHint: { kind: 'bogus' } })
  assert.ok(res.kind === 'work' || res.kind === 'chat')
  assert.equal(res.kind, 'work')
})

// ── 确定性 / 纯净性 ─────────────────────────────────────────────────

test('确定性：同输入同输出（深比较），且不修改入参', () => {
  const input = deepFreeze({ turns: deepFreeze(troubleshooting()), title: '修复加载报错', sessionCount: 1 })
  const first = judgeAdmission(input)
  const second = judgeAdmission(input)
  assert.deepEqual(first, second)
  assert.equal(JSON.stringify(input.turns.length), '8', '入参不得被修改')
})

test('健壮性：null / undefined / 非对象输入一律安全返回，不抛异常', () => {
  for (const bad of [null, undefined, 42, 'x', [], true]) {
    const res = judgeAdmission(bad)
    assert.equal(typeof res.admitted, 'boolean')
    assert.ok(Array.isArray(res.reasons))
    assert.ok(res.kind === 'work' || res.kind === 'chat')
    assert.ok(res.confidence === 'high' || res.confidence === 'low')
  }
})

test('健壮性：options 为 null / 异常值时使用默认值，不抛异常', () => {
  const res = judgeAdmission({ turns: troubleshooting(), title: '排障' }, null)
  assert.equal(res.admitted, true)
  assert.equal(judgeAdmission({ turns: troubleshooting(), title: '排障' }, 'nope').admitted, true)
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) process.exitCode = 1
