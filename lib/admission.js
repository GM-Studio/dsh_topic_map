/**
 * 准入判定（ADR-0006「续接准入三条红线」）。
 *
 * 三条红线必须**同时**满足，一条推测态记录才允许进入续接首页的未收束清单：
 *   1. 有意图 —— 存在未兑现的目标或产出意图；纯概念咨询 / 纯解释 / 纯闲聊 / 单次查询不算；
 *   2. 未收尾 —— 末尾仍留有未解报错、待验证步骤、未完成清单，或人明确说过「下次接着做 / 先这样」；
 *   3. 人类主导 —— 沿用 ADR-0005 三元触发来源模型，子代理独立会话、定时 / 自动化会话、
 *      0 轮空会话一律排除。
 *
 * 两条附加约定：
 *   - **人的确认永远高于红线**：传 `options.stateSource === 'confirmed'` 时一律准入（ADR-0003 / ADR-0006）；
 *   - **可解释**：每条记录都留下准入与否、以及未准入的具体原因，结果由纯启发式得出，
 *     模型（`options.modelHint`）只是可选补充，绝不可用时行为依然确定可回归。
 *
 * 纯函数模块：不 import 任何 IO / 网络 / 时钟 / 随机源，只依赖语义常量；
 * 同输入必得同输出，且不修改入参。
 *
 * @module dsh-topic-map/admission
 */

/** 准入原因枚举：admitted 之外每个值对应一条未通过的红线。 */
export const ADMISSION_REASONS = Object.freeze({
  ADMITTED: 'admitted',
  NO_INTENT: 'no_intent',          // 没有未兑现的目标或产出意图
  ALREADY_CLOSED: 'already_closed',// 末尾已收敛：测试通过 + 提交/验收 + 明确收口
  NOT_HUMAN: 'not_human',          // 子代理/自动化/空会话
})

/** 判定结果的可信度：硬信号充分为 high，仅靠启发式为 low。 */
export const ADMISSION_CONFIDENCE = Object.freeze(['high', 'low'])

/** 未收尾的后缀上限（信号里只带特征，不带正文）。 */
const SIGNAL_TEXT_MAX = 60

// ── 语义常量 ────────────────────────────────────────────────────────

/** 产出 / 工程意图：目标词、产出动词、工程动作（沿用 segment.js 口径并补充产出词）。 */
const INTENT_RE = /(修|改|加|删|补|写|实现|开发|重构|优化|排查|调试|部署|发布|上线|迁移|升级|接入|支持|新增|修复|回滚|建票|交付|产出|整理|清理|拆分|合并|接入|统一|抽出|补齐|跑|验证|测试|提交|生成|构建|编译|脚本|模块|组件|接口|文档|设计|方案|配置|报错|异常|故障|性能|bug|fix|fixing|implement|refactor|debug|deploy|migrate|upgrade|build|add|remove|delete|update|create|write|test|verify|ship|release|migrate)/i

/** 纯概念咨询 / 解释 / 闲聊 / 单次查询：这些即使问很多轮也不构成产出意图。 */
const CONSULT_RE = /(什么是|啥是|是什么意思|是什么|的区别|有什么区别|为什么|原理|解释|讲讲|科普|吗\s*[?？]|how does|what is|what's the difference|explain|concept|为什么叫)/i

/** 产出动词（比 INTENT_RE 更严）：出现即明确有「要交付的结果」。 */
const PRODUCE_VERB_RE = /(写|实现|开发|重构|优化|修复|补齐|新增|改造|拆分|合并|生成|构建|编译|部署|发布|升级|迁移|提交|交付|产出|建票|跑测试|补单测|补测试|改一下|改改|修一下|refactor|implement|build|deploy|migrate)/i

/** 收尾线索：测试通过 / 全部通过 / 可以提交 / 搞定。 */
const VERIFIED_RE = /(测试(?:全部)?(?:都)?通过|全部通过|全绿|(?<!不)通过了|all tests pass|tests? pass|passing|\bpassed\b|校验通过|构建通过|验收通过|跑了.*通过|(\d+)\s*passed)/i

/** 明确提交 / 收口的线索（人说的）。 */
const USER_CLOSED_RE = /(好了|可以了|搞定了|收工|结束了?|完成了?|没问题了|先这样|就这样|不用了|可以提交|可以了|这个结束|done|that's it|all good)/i

/** 人明确说「下次接着做 / 先这样」→ 反而判为未收尾（ADR-0006 明确列为未收尾证据）。 */
const DEFER_RE = /(下次(?:再|接着|继续)|稍后(?:再|接着)|明天(?:再|接着)|回头(?:再|接着)|先这样(?:吧)?[，,。！!\s]*$|先放(?:着|一放)|继续(?:做|干)?下去)/i

/** 未完成清单 / 待验证步骤的线索。 */
const CHECKLIST_RE = /(待(?:验证|确认|测试|补|办|做|定|续)|还剩|剩下|剩下几|还没(?:做|跑|写|补|验证)|未完成|没做完|未收尾|剩下的事|下一步(?:要|需要|该)|然后(?:要|需要)|TODO|todo|待办)/i

/** 报错 / 失败线索（近末轮）。 */
const ERROR_RE = /(报错|失败|异常|错误|超时|无法|不能|崩|挂了|不通过|未通过|failed|failure|error|exception|timeout|ENOENT|EACCES|EADDRINUSE|ECONNREFUSED|TypeError|ReferenceError|SyntaxError|exit code)/i

/** 空会话判定：无轮次内容。 */
const EMPTY_TEXT_RE = /^[\s\u3000]*$/

// ── 基础工具（纯函数） ──────────────────────────────────────────────

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toText(value) {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

function compress(value) {
  return toText(value).replace(/\s+/g, ' ').trim()
}

/** 按 Unicode 码位裁剪，绝不切断 UTF-16 代理对（Emoji）。 */
function clipText(text, max = SIGNAL_TEXT_MAX) {
  const s = compress(text)
  const chars = Array.from(s)
  if (chars.length <= max) return s
  return `${chars.slice(0, Math.max(1, max - 1)).join('').trimEnd()}…`
}

function toTurnList(turns) {
  return Array.isArray(turns) ? turns.filter(isPlainObject) : []
}

/** 一个轮次是否以异常结束（多来源口径：ok / endReason / interrupted / error）。 */
function turnFailed(turn) {
  if (!isPlainObject(turn)) return false
  if (turn.ok === false) return true
  if (turn.error === true) return true
  const reason = compress(turn.endReason).toLowerCase()
  if (reason !== '' && /(error|failed|failure|interrupted|aborted|blocked|max-tokens|max-turns|timeout)/.test(reason)) return true
  if (turn.interrupted === true) return true
  const results = Array.isArray(turn.commandResults) ? turn.commandResults : []
  return results.some(item => isPlainObject(item) && (item.ok === false || (Number.isFinite(item.exitCode) && item.exitCode !== 0)))
}

/** 轮次里出现过的命令（字符串数组或 { command } 结构）。 */
function commandsOf(turn) {
  if (!isPlainObject(turn)) return []
  const out = []
  for (const item of Array.isArray(turn.commands) ? turn.commands : []) {
    if (typeof item === 'string') out.push(compress(item))
    else if (isPlainObject(item)) out.push(compress(item.command))
  }
  for (const item of Array.isArray(turn.commandResults) ? turn.commandResults : []) {
    if (isPlainObject(item)) out.push(compress(item.command))
  }
  return out.filter(t => t !== '')
}

/** 轮次里出现过的文件路径。 */
function filesOf(turn) {
  if (!isPlainObject(turn)) return []
  return (Array.isArray(turn.files) ? turn.files : []).map(compress).filter(t => t !== '')
}

/** 轮次里可用的自然语言（prompt / 标题 / AI 末句 / 摘要）。 */
function textsOf(turn) {
  if (!isPlainObject(turn)) return []
  return [
    turn.prompt,
    turn.firstPrompt,
    turn.title,
    turn.assistantTail,
    turn.assistantSummary,
    turn.responseTail,
    turn.summary,
    turn.response,
  ].map(compress).filter(t => t !== '')
}

/** 拼接每个轮次的全部自然语言，用于意图 / 收尾线索扫描。 */
function scanTextOf(turns, limit = 6) {
  const list = turns.slice(-limit)
  return list.map(t => textsOf(t).join(' \n ')).join(' \n ').toLowerCase()
}

// ── 红线判定 ────────────────────────────────────────────────────────

/** 被「证明」为非人类的触发来源；出现在 trigger/origin 等元数据字段上。 */
const AUTOMATED_SOURCE_SET = new Set(['automated', 'subagent', 'system', 'scheduled'])

/**
 * 只读元数据里的**正面证据**：证明这个会话不是人类发起。
 * 返回原因字符串，`''` 表示「没被证明」（注意：未证明 ≠ 已证明不是）。
 */
function proveAutomatedByMeta(input) {
  const trigger = compress(input.trigger).toLowerCase()
  if (AUTOMATED_SOURCE_SET.has(trigger)) return `trigger:${trigger}`

  const origin = compress(input.origin ?? input.source ?? input.originKind).toLowerCase()
  if (AUTOMATED_SOURCE_SET.has(origin)) return `origin:${origin}`

  if (input.isSubagent === true || input.automated === true || input.isAutomated === true || input.scheduled === true) {
    return 'flag'
  }
  if (compress(input.trace?.origin).toLowerCase() === 'subagent') return 'trace:subagent'

  // 委派深度 ≥ 1 即处于子代理上下文，属于结构性证明
  if (Number.isFinite(input.delegationDepth) && input.delegationDepth > 0) return 'delegationDepth'

  return ''
}

/** 只读元数据里的**正面证据**：证明这个会话由人类发起（continuation 也算人类链条）。 */
function proveHumanByMeta(input) {
  const trigger = compress(input.trigger).toLowerCase()
  return trigger === 'human' || trigger === 'continuation'
}

/**
 * 红线 3：人类主导。
 *
 * 判定分三态，**绝不把「不知道」报成「已证明不是」**：
 *   ① 元数据上有正面证据 → 按证据判定（人类 / 非人类）；
 *   ② `turns` 不是数组（**证据未知**，例如渲染期只拿到 store 字段）→ **fail-open**：
 *      不因这条红线否决，`reason: 'unknown'`，由调用方按 `confidence: 'low'` 如实标注；
 *   ③ `turns` 是数组但为空 / 全为自动化触发 / 会话元数据自证无人类发起 → 判定为非人类。
 *
 * @param {object} input - 判定输入。
 * @returns {{ humanLed: boolean, reason: string, unknown: boolean }} 判定结果与原因。
 */
function judgeHumanLed(input) {
  const rawTurns = input.turns
  const turnsKnown = Array.isArray(rawTurns)
  const turns = toTurnList(rawTurns)

  // ① 元数据正面证据优先（与轮次明细是否可用无关）
  const automatedReason = proveAutomatedByMeta(input)
  if (automatedReason !== '') return { humanLed: false, reason: automatedReason, unknown: false }
  if (proveHumanByMeta(input)) return { humanLed: true, reason: '', unknown: false }

  // ② 轮次明细缺失：证据未知 → fail-open，不否决、不谎报
  if (!turnsKnown) return { humanLed: true, reason: 'unknown', unknown: true }

  // ③ 明确给了空数组：确实没有任何轮次，0 轮会话不该立事
  if (turns.length === 0) return { humanLed: false, reason: 'no_turns', unknown: false }

  // ④ 轮次层面的自动化证据：全部轮次都是自动化触发
  const allAutomated = turns.every(t => {
    const t2 = compress(t.trigger ?? t.source ?? t.sourceKind).toLowerCase()
    return AUTOMATED_SOURCE_SET.has(t2)
  })
  if (allAutomated) return { humanLed: false, reason: 'all_turns_automated', unknown: false }

  // ⑤ 会话元数据：没有标题、也没有人类发起的轮次
  const title = compress(input.title)
  const hasHumanTurn = turns.some(t => {
    const tg = compress(t.trigger ?? t.source ?? t.sourceKind).toLowerCase()
    return tg === '' || tg === 'human' || tg === 'user' || tg === 'retry'
  })
  if (title === '' && !hasHumanTurn) return { humanLed: false, reason: 'no_human_turn', unknown: false }

  const sessionCount = Number(input.sessionCount)
  if (Number.isFinite(sessionCount) && sessionCount <= 0 && title === '') {
    return { humanLed: false, reason: 'no_session', unknown: false }
  }

  return { humanLed: true, reason: '', unknown: false }
}

/** 红线 1：有意图。 */
function judgeIntent(input, turns, modelHint) {
  const title = compress(input.title)
  const goal = compress(input.goal)
  const statusSummary = compress(input.statusSummary)

  const changedFiles = []
  for (const turn of turns) changedFiles.push(...filesOf(turn))
  if (Array.isArray(input.files)) changedFiles.push(...input.files.map(compress))

  const tailTexts = scanTextOf(turns, 6)
  const headTexts = turns.slice(0, 2).map(t => textsOf(t).join(' \n ')).join(' \n ').toLowerCase()
  const allTexts = `${title} \n ${goal} \n ${statusSummary} \n ${headTexts} \n ${tailTexts}`.toLowerCase()

  // ① 明确的产出成果（文件改动 / 文件清单）是硬证据
  const filesSignal = changedFiles.filter(t => t !== '').length > 0
  // ② 目标 / 现状字段有实质内容
  const goalSignal = goal !== '' && !CONSULT_RE.test(goal)
  // ③ 产出动词
  const verbSignal = PRODUCE_VERB_RE.test(allTexts)
  // ④ 工程动作词
  const workSignal = INTENT_RE.test(allTexts)
  // ⑤ 纯咨询 / 解释 / 闲聊
  const consultSignal = CONSULT_RE.test(allTexts)

  let intent = false
  if (filesSignal || goalSignal) intent = true
  else if (verbSignal) intent = true
  else if (workSignal && !consultSignal) intent = true
  else if (workSignal && consultSignal) intent = true // 工程动作词优先级高于咨询词（「修复报错」里的「为什么」不算咨询）

  // ⑥ 全篇都是纯咨询 / 解释 / 闲聊且无任何产出痕迹 → 无意图
  if (consultSignal && !filesSignal && !verbSignal && !goalSignal) intent = false
  if (consultSignal && !filesSignal && !goalSignal && !PRODUCE_VERB_RE.test(tailTexts + headTexts)) intent = false

  // ⑦ 单次查询（1 轮、无文件、无产出动词、无目标）→ 无意图
  if (turns.length <= 1 && !filesSignal && !goalSignal && !verbSignal) intent = false

  // 模型提示只做补充（可用时「更好」，不可用时规则独立达标）
  if (modelHint !== null) {
    if (modelHint.intent === true) return { intent: true, source: 'model' }
    if (modelHint.intent === false) return { intent: false, source: 'model' }
  }
  return { intent, source: intent ? 'rule' : 'consult' }
}

/** 红线 2：未收尾（含已收尾判定）。 */
function judgeUnfinished(input, turns) {
  const tail = turns.slice(-3)
  const tailText = scanTextOf(turns, 3)
  const userTail = compress(tail.length > 0 ? tail[tail.length - 1].prompt : '')
  const userText = tail.map(t => compress(t.prompt)).filter(t => t !== '').join(' \n ')
  const allUserText = turns.map(t => compress(t.prompt)).filter(t => t !== '').join(' \n ')

  // 收尾三证据（人明确收口 > 提交 > 测试通过）
  const committed = turns.some(t => commandsOf(t).some(cmd => /^git\s+(commit|tag|merge)|\bcommit\b|npm publish|pnpm publish/i.test(cmd)))
  const verified = turns.some(t => {
    if (turnFailed(t)) return false
    const hasCommand = commandsOf(t).length > 0
    const results = Array.isArray(t.commandResults) ? t.commandResults.filter(isPlainObject) : []
    const resultOk = results.length > 0 && results.every(r => r.ok !== false && (!Number.isFinite(r.exitCode) || r.exitCode === 0))
    const text = textsOf(t).join(' \n ')
    if (VERIFIED_RE.test(text)) return true
    return hasCommand && resultOk
  }) || VERIFIED_RE.test(tailText)
  // 未收尾证据
  const deferred = DEFER_RE.test(allUserText)
  // 「下次接着做」是明确的延期信号，即使同时出现「先这样 / 好了」也不判收口
  const userClosed = !deferred && USER_CLOSED_RE.test(userText) && !/[?？]\s*$/.test(userTail)
  const lastFailed = tail.length > 0 && turnFailed(tail[tail.length - 1])
  const errorText = ERROR_RE.test(tailText) && !verified
  const checklist = CHECKLIST_RE.test(tailText) || CHECKLIST_RE.test(userText)
  const awaitingActive = isPlainObject(input.awaiting) && input.awaiting.active === true
  const state = compress(input.state).toLowerCase()
  const stateOpen = state === 'active' || state === 'blocked'
  const stateClosed = state === 'done' || state === 'shelved'

  // 契约 input.nextStep 有内容 → 还有未走完的一步
  const hasNextStep = compress(input.nextStep) !== ''

  let unfinished
  if (deferred) unfinished = true
  else if (lastFailed || (errorText && !userClosed)) unfinished = true
  else if (checklist) unfinished = true
  else if (awaitingActive) unfinished = true
  else if (verified && committed && userClosed) unfinished = false
  else if (stateClosed) unfinished = false
  else if (hasNextStep) unfinished = true
  else unfinished = true // 默认按未收尾处理；有明确收尾三证据时才判已完结

  return {
    unfinished,
    closedSignals: { verified, committed, userClosed },
    deferred,
    awaitingActive: awaitingActive || checklist,
    settled: verified && committed && userClosed,
  }
}

// ── 主入口 ──────────────────────────────────────────────────────────

/**
 * 判定一条（推测态）记录是否准入续接首页。
 *
 * @param {object} input - 全部字段可选，缺失即视为未知：
 *   `{ turns, segments, title, goal, statusSummary, nextStep, state, stateSource, files,
 *      sessionIds, awaiting, trigger, sessionCount, turnCount, tailFeatures }`。
 * @param {object} [options] - `{ stateSource?, modelHint? }`；
 *   `stateSource==='confirmed'` 时人的确认高于红线，一律准入；
 *   `modelHint`（`{ intent?, kind? }`）只作可选补充，缺失时规则独立工作。
 * @returns {{ admitted: boolean, kind: 'work'|'chat', reasons: string[], confidence: 'high'|'low', signals: object }}
 */
export function judgeAdmission(input, options = {}) {
  const src = isPlainObject(input) ? input : {}
  const opts = isPlainObject(options) ? options : {}
  const turns = toTurnList(src.turns)

  const modelHint = isPlainObject(opts.modelHint)
    ? {
      intent: typeof opts.modelHint.intent === 'boolean' ? opts.modelHint.intent : null,
      kind: opts.modelHint.kind === 'work' || opts.modelHint.kind === 'chat' ? opts.modelHint.kind : null,
    }
    : null

  const stateSource = compress(src.stateSource ?? opts.stateSource) || 'inferred'
  const human = judgeHumanLed(src)
  const intent = judgeIntent(src, turns, modelHint)
  const closed = judgeUnfinished(src, turns)

  // 轮次明细缺失（证据未知）时的**弱证据**：明确的轮数 / 会话数说明确实有人在用，
  // 只用来抬高 confidence，绝不参与「是否人类主导」的红线判定
  const turnsKnown = Array.isArray(src.turns)
  const declaredTurnCount = Number.isFinite(Number(src.turnCount)) ? Number(src.turnCount) : null
  const sessionCount = Number.isFinite(Number(src.sessionCount)) ? Number(src.sessionCount) : null
  const weakHumanEvidence = !turnsKnown && ((declaredTurnCount ?? 0) > 0 || (sessionCount ?? 0) > 0)

  const threeReds = {
    intent: intent.intent,
    unfinished: closed.unfinished,
    humanLed: human.humanLed,
  }

  const signals = {
    threeReds,
    kind: intent.intent ? 'work' : 'chat',
    intentSource: intent.source,
    intentEvidence: {
      files: (Array.isArray(src.files) ? src.files.map(compress) : []).filter(t => t !== '').slice(0, 3),
      hasGoal: compress(src.goal) !== '',
      hasProduceVerb: intent.source !== 'consult',
    },
    closed: closed.closedSignals,
    deferred: closed.deferred,
    awaiting: closed.awaitingActive,
    userClosed: closed.closedSignals.userClosed,
    state: compress(src.state) || '',
    stateSource,
    humanLed: human.humanLed,
    humanReason: human.reason,
    // 证据未知（渲染期只拿到 store 字段）时如实标注，便于排查「为什么没被挡」
    humanEvidenceUnknown: human.unknown === true,
    turnsKnown,
    // 缺失 turns 时如实回报调用方声明的轮数，而不是谎报 0
    turnCount: turnsKnown ? turns.length : declaredTurnCount,
    declaredTurnCount,
    delegationDepth: Number.isFinite(Number(src.delegationDepth)) ? Number(src.delegationDepth) : null,
    modelHint,
    confirmed: stateSource === 'confirmed',
  }

  // 人的确认高于红线（ADR-0003 / ADR-0006）
  if (stateSource === 'confirmed') {
    return {
      admitted: true,
      kind: intent.intent ? 'work' : 'chat',
      reasons: [],
      confidence: 'high',
      signals,
    }
  }

  const reasons = []
  if (!human.humanLed) reasons.push(ADMISSION_REASONS.NOT_HUMAN)
  if (!intent.intent) reasons.push(ADMISSION_REASONS.NO_INTENT)
  if (!closed.unfinished) reasons.push(ADMISSION_REASONS.ALREADY_CLOSED)

  const admitted = reasons.length === 0

  // confidence：硬信号（文件改动 / 明确收尾证据 / 明确自动化 / 多轮）充分为 high
  const hardSignals = signals.intentEvidence.files.length > 0
    || closed.closedSignals.verified
    || closed.closedSignals.committed
    || closed.closedSignals.userClosed
    || human.humanLed === false
  const enoughTurns = turnsKnown ? turns.length >= 3 : weakHumanEvidence
  // 「人类主导」这一票处于未知（不否决）时，无论别处多硬都不许报 high：
  // 这种情况下的准入结论本身就必须被人复核
  const confidence = (human.unknown !== true && (hardSignals || enoughTurns)) ? 'high' : 'low'

  return {
    admitted,
    kind: intent.intent ? 'work' : 'chat',
    reasons,
    confidence,
    signals,
  }
}
