import { detectAwaitingHuman } from './segment.js'

/**
 * 下一步建议（ADR-0009：「下一步绝不留白」）与末轮特征提取。
 *
 * 续接首页每张卡片的第 3 行必须有一句**可执行**的下一步。规则（不依赖模型）按固定优先级兜底：
 *   1. `awaiting` —— 末轮停在 AI 反问，引导人回复那个确认项（ADR-0008 的「待确认」信号）；
 *   2. `error`    —— 末轮失败，指向具体命令或报错首行；
 *   3. `files`    —— 有文件改动但没验证过，指向文件名并提示跑测试；
 *   4. `resume`   —— 都不成立时的兜底，指向轮号与该轮目标摘要。
 *
 * 不变量：
 *   - **永不返回空串**，也永不出现「待补充 / 待定」这类占位空话；
 *   - 每条建议都带一个具体对象（报错首行 / 命令 / 文件名 / 轮号 / 目标摘要）以及 `turn`；
 *   - 所有摘要按 Unicode 码位裁剪到 ≤ 60 字符，**绝不切断 UTF-16 代理对**（Emoji）；
 *   - 确定性：同输入必得同输出，不读时钟、不读随机源、不改入参，不 import 任何 IO。
 *
 * 「待确认」的判据**只有一份**：权威实现在 `lib/segment.js` 的 `detectAwaitingHuman(turns, options)`
 * （返回 `{ active, summary, turn, reason }`）。本模块直接复用它并对外 re-export，
 * 不再自带第二份判据，避免两处长期漂移。
 *
 * @module dsh-topic-map/next-step
 */

export { detectAwaitingHuman }

/** 下一步建议的四种来源（ADR-0009）。 */
const NEXT_STEP_KINDS = Object.freeze(['awaiting', 'error', 'files', 'resume'])

/** 摘要统一裁剪上限（字符数，按码位计）。 */
export const NEXT_STEP_TEXT_MAX = 60

// ── 线索正则（与 admission.js 同口径，各自独立以免相互耦合） ────────

/** 硬报错特征：必须真的像报错，不能因为提到「错误」二字就误判。 */
const HARD_ERROR_RE = /(exit code\s*[:：]?\s*[1-9]|\b(?:TypeError|ReferenceError|SyntaxError|AssertionError|RangeError|Error)\b\s*[:：]|is not a function|is not defined|Cannot find module|Cannot read propert|ENOENT|EACCES|ELIFECYCLE|Command failed|npm ERR!|FAIL\b)/i

/** 通用失败线索（仅在轮次已被标记失败时用于挑首行）。 */
const ERROR_LINE_RE = /(报错|失败|异常|错误|超时|无法|不能|failed|failure|error|exception|timeout|exit code)/i

/** 测试/校验通过的证据。 */
const VERIFIED_RE = /(测试(?:全部)?(?:都)?通过|全部通过|全绿|(?<!不)通过了|all tests pass|tests? pass|\bpassed\b|\d+\s*passed|校验通过|构建通过|验收通过)/i

/** 提交 / 发布的证据。 */
const COMMIT_RE = /(^|\s)(?:git\s+(?:commit|tag|merge)|npm publish|pnpm publish|gh pr create)/i

/** 人明确收口的说法。 */
const USER_CLOSED_RE = /(好了|可以了|搞定了|收工|结束了?|完成了?|没问题了|不用了|这个结束|就这样|done|all good)/i

/** 人明确说下次接着做 → 反而不能算收尾。 */
const DEFER_RE = /(下次(?:再|接着|继续)|回头(?:再|接着)|先放(?:着|一放)|稍后(?:再|接着))/i

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

/**
 * 按 Unicode 码位裁剪文本，绝不切断 UTF-16 代理对（Emoji）。
 * 与 `lib/segment.js` 的 `clipText` 同一口径。
 */
export function clipText(text, max = NEXT_STEP_TEXT_MAX) {
  const s = compress(text)
  const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : NEXT_STEP_TEXT_MAX
  const chars = Array.from(s)
  if (chars.length <= limit) return s
  return `${chars.slice(0, Math.max(1, limit - 1)).join('').trimEnd()}…`
}

function toTurnList(turns) {
  return Array.isArray(turns) ? turns.filter(isPlainObject) : []
}

function turnNumber(turn, fallback = null) {
  if (!isPlainObject(turn)) return fallback
  if (Number.isFinite(turn.turn) && turn.turn > 0) return Math.floor(turn.turn)
  if (Number.isFinite(turn.index) && turn.index > 0) return Math.floor(turn.index)
  return fallback
}

/** 轮次里出现过的命令（字符串数组 / `{ command }` / commandResults 结构）。 */
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

function filesOf(turn) {
  if (!isPlainObject(turn)) return []
  return (Array.isArray(turn.files) ? turn.files : []).map(compress).filter(t => t !== '')
}

/** 轮次以异常结束（多来源口径：ok / endReason / interrupted / 命令结果）。 */
function turnFailed(turn) {
  if (!isPlainObject(turn)) return false
  if (turn.ok === false || turn.error === true) return true
  const reason = compress(turn.endReason).toLowerCase()
  if (reason !== '' && /(error|failed|failure|interrupted|aborted|blocked|timeout|max-tokens|max-turns)/.test(reason)) return true
  if (turn.interrupted === true) return true
  const results = Array.isArray(turn.commandResults) ? turn.commandResults : []
  return results.some(item => isPlainObject(item) && (item.ok === false || (Number.isFinite(item.exitCode) && item.exitCode !== 0)))
}

/** 轮次里可用的「AI 末句 / 末段输出」文本。 */
function assistantTailOf(turn) {
  if (!isPlainObject(turn)) return ''
  for (const key of ['assistantTail', 'assistantSummary', 'responseTail', 'response', 'summary', 'text']) {
    const value = compress(turn[key])
    if (value !== '') return value
  }
  return ''
}

/** 轮次里人说过的话。 */
function promptOf(turn) {
  if (!isPlainObject(turn)) return ''
  return compress(turn.prompt) || compress(turn.firstPrompt) || ''
}

/** 取一段文本里最有信息量的首行（跳过堆栈缩进行与空行）。 */
function firstMeaningfulLine(text) {
  const raw = toText(text)
  for (const line of raw.split(/\r?\n/)) {
    const t = compress(line)
    if (t === '') continue
    if (/^at\s/.test(t)) continue
    return t
  }
  return compress(raw)
}

/** 组装建议文本：拼接后统一压到 ≤ 60 字符，保持代理对完整。 */
function composeText(parts) {
  const joined = parts.map(p => compress(p)).filter(p => p !== '').join('')
  return clipText(joined, NEXT_STEP_TEXT_MAX)
}

// ── 待确认判定（委托 lib/segment.js 的权威实现） ───────────────────

/** 权威实现在 segment.js：`detectAwaitingHuman(turns, options)`。此处只做本模块口径的归一。 */
const EMPTY_AWAITING = Object.freeze({ active: false, summary: '', turn: null, reason: '' })

/**
 * 用 `segment.js` 的权威判据检查**末轮**是否停在等人类回话。
 *
 * @param {Array<object>} turns - 轮次数组（内部只喂末轮，保持「末轮特征」语义）。
 * @param {object} [options] - 透传给 `segment.js` 的 `detectAwaitingHuman`。
 * @returns {{ active: boolean, summary: string, turn: number|null, reason: string }} 判定结果。
 */
function detectTailAwaiting(turns, options = {}) {
  const list = toTurnList(turns)
  if (list.length === 0) return { ...EMPTY_AWAITING }
  // segment.js 的 normalizeTurn 会丢弃没有数字 turn 的行；这里补一个保守轮号，
  // 避免「有 AI 反问但轮号缺失」被静默丢成「无待确认」（只补轮号，不改判据）
  const last = list[list.length - 1]
  const probe = Number.isFinite(last.turn) ? last : { ...last, turn: list.length }
  const result = detectAwaitingHuman([probe], options)
  if (!isPlainObject(result) || result.active !== true) return { ...EMPTY_AWAITING }
  return {
    active: true,
    // 判据归 segment.js，长度归本模块：契约要求本模块摘要 ≤ 60 字符，
    // 而 segment.js 的 AWAITING_SUMMARY_MAX 是 80，所以在这里按本模块口径再裁一次
    // （只裁长度、不改判据，裁剪方式同样是码位安全，不会切断代理对）
    summary: clipText(result.summary, NEXT_STEP_TEXT_MAX),
    turn: Number.isFinite(result.turn) ? Math.floor(result.turn) : null,
    reason: compress(result.reason),
  }
}

// ── 末轮特征 ────────────────────────────────────────────────────────

/**
 * 提取**末轮**特征：报错、命令、改动文件、是否停在等人回话、目标摘要与收尾证据。
 *
 * @param {Array<object>} turns - 轮次数组（脏数据会安全过滤）。
 * @param {object} [options] - `{ sessionId, goal, statusSummary, nextStep }`。
 * @returns {{
 *   lastTurn: number|null, hasError: boolean, errorHead: string, errorTurn: number|null,
 *   lastCommand: string, changedFiles: string[], filesTurn: number|null,
 *   awaitingHuman: boolean, awaitingSummary: string, awaitingTurn: number|null,
 *   awaitingReason: string (segment.js 的命中判据：question / verify / decision / open),
 *   goalSummary: string, closedSignals: { verified: boolean, committed: boolean, userClosed: boolean }
 * }}
 */
export function extractTailFeatures(turns, options = {}) {
  const opts = isPlainObject(options) ? options : {}
  const list = toTurnList(turns)

  const emptySignals = { verified: false, committed: false, userClosed: false }
  if (list.length === 0) {
    return {
      lastTurn: null,
      hasError: false,
      errorHead: '',
      errorTurn: null,
      lastCommand: '',
      changedFiles: [],
      filesTurn: null,
      awaitingHuman: false,
      awaitingSummary: '',
      awaitingTurn: null,
      goalSummary: clipText(opts.goal, NEXT_STEP_TEXT_MAX),
      closedSignals: { ...emptySignals },
    }
  }

  const last = list[list.length - 1]
  const lastNum = turnNumber(last, null)

  // 报错：只看末轮（ADR-0009「末轮失败」口径），结果或文本任一命中即可
  const lastResponse = toText(last.responseTail) || toText(last.response) || ''
  const lastTail = assistantTailOf(last)
  const failed = turnFailed(last)
  const hardErrorText = HARD_ERROR_RE.test(lastResponse) || HARD_ERROR_RE.test(lastTail)
  const errorLineSource = failed && !hardErrorText
    ? lastResponse.split(/\r?\n/).map(compress).find(line => line !== '' && ERROR_LINE_RE.test(line)) || ''
    : ''
  const hasError = failed || hardErrorText
  let errorHead = ''
  if (hasError) {
    errorHead = firstMeaningfulLine(hardErrorText ? (HARD_ERROR_RE.test(lastResponse) ? lastResponse : lastTail) : (errorLineSource || lastTail || lastResponse))
    if (errorHead === '') errorHead = '末轮执行未成功'
    errorHead = clipText(errorHead, NEXT_STEP_TEXT_MAX)
  }

  const commands = commandsOf(last)
  const lastCommand = commands.length > 0 ? commands[commands.length - 1] : ''

  // 改动文件：末尾数轮并集（去重保序），轮号取**最近**一个有文件改动的轮次
  const changedFiles = []
  let filesTurn = null
  for (const turn of list.slice(-3)) {
    const files = filesOf(turn)
    if (files.length === 0) continue
    filesTurn = turnNumber(turn, filesTurn)
    for (const file of files) if (!changedFiles.includes(file)) changedFiles.push(file)
  }

  // 委托 segment.js 的权威判据；摘要与轮号一并采用它的结论（只在缺失时才回退到末轮号）
  const tailAwaiting = detectTailAwaiting(list)
  const awaitingHuman = tailAwaiting.active
  const awaitingSummary = tailAwaiting.summary
  const awaitingTurn = awaitingHuman ? (tailAwaiting.turn ?? lastNum) : null

  const goalSummary = clipText(opts.goal, NEXT_STEP_TEXT_MAX)
    || clipText(promptOf(last), NEXT_STEP_TEXT_MAX)

  const verified = list.some(turn => {
    if (turnFailed(turn)) return false
    const results = (Array.isArray(turn.commandResults) ? turn.commandResults : []).filter(isPlainObject)
    const resultsOk = results.length > 0 && results.every(r => r.ok !== false && (!Number.isFinite(r.exitCode) || r.exitCode === 0))
    if (resultsOk) return true
    return VERIFIED_RE.test(assistantTailOf(turn)) || VERIFIED_RE.test(toText(turn.responseTail))
  })
  const committed = list.some(turn => commandsOf(turn).some(cmd => COMMIT_RE.test(cmd)))
  const userText = list.map(promptOf).filter(t => t !== '').join(' \n ')
  const userClosed = USER_CLOSED_RE.test(userText) && !DEFER_RE.test(userText)

  return {
    lastTurn: lastNum,
    hasError,
    errorHead,
    errorTurn: hasError ? lastNum : null,
    lastCommand,
    changedFiles,
    filesTurn,
    awaitingHuman,
    awaitingSummary,
    awaitingTurn,
    awaitingReason: tailAwaiting.reason,
    goalSummary,
    closedSignals: { verified, committed, userClosed },
  }
}

// ── 下一步建议 ──────────────────────────────────────────────────────

/**
 * 给出一条**永不为空**的下一步建议（ADR-0009）。
 *
 * @param {object} input - `{ turns, title, goal, statusSummary, nextStep, awaiting, files, tailFeatures }`。
 * @param {object} [options] - `{ sessionId, sessionIds, modelText }`；
 *   传了非空的 `modelText` 时视为模型精化结果（`source: 'model'`），否则一律走规则（`source: 'rule'`）。
 * @returns {{ text: string, source: 'rule'|'model', kind: 'error'|'awaiting'|'files'|'resume', turn: number|null, evidenceHandle: string }}
 */
export function suggestNextStep(input, options = {}) {
  const src = isPlainObject(input) ? input : {}
  const opts = isPlainObject(options) ? options : {}
  const turns = toTurnList(src.turns)

  const features = isPlainObject(src.tailFeatures)
    ? src.tailFeatures
    : extractTailFeatures(turns, {
      goal: opts.goal ?? src.goal,
      sessionId: opts.sessionId ?? src.sessionId,
    })

  // input.awaiting 是显式的「待确认」信号，比末轮启发式更强
  const explicitAwaiting = isPlainObject(src.awaiting) && src.awaiting.active === true
  const awaitingSummary = explicitAwaiting
    ? clipText(src.awaiting.summary, NEXT_STEP_TEXT_MAX) || features.awaitingSummary
    : features.awaitingSummary
  const awaitingTurn = explicitAwaiting
    ? (Number.isFinite(src.awaiting.turn) ? Math.floor(src.awaiting.turn) : features.awaitingTurn)
    : features.awaitingTurn

  const turn = features.lastTurn
  const goalSummary = features.goalSummary
  let kind = 'resume'
  let text = ''

  // 规则 1：末轮停在 AI 反问 → 引导人回复确认项（优先级最高）
  if (explicitAwaiting || features.awaitingHuman) {
    kind = 'awaiting'
    const n = awaitingTurn ?? turn
    text = composeText([
      n === null ? '回复 AI 的确认项：' : `回复 AI 在第 ${n} 轮的确认项：`,
      awaitingSummary || '先确认这一步要怎么走',
    ])
  }

  // 规则 2：末轮失败 → 指向具体命令或报错首行
  if (kind === 'resume' && features.hasError) {
    kind = 'error'
    const n = features.errorTurn ?? turn
    const target = features.lastCommand || features.errorHead || '失败原因'
    text = composeText([
      n === null ? '排查末轮的 ' : `排查第 ${n} 轮的 `,
      target,
    ])
  }

  // 规则 3：有改动未验证 → 指向文件名并提示跑测试
  if (kind === 'resume' && features.changedFiles.length > 0) {
    kind = 'files'
    const file = features.changedFiles[features.changedFiles.length - 1]
    const n = features.filesTurn ?? turn
    text = composeText([
      n === null ? '' : `第 ${n} 轮改动 `,
      file,
      ' 的改动并运行测试',
    ])
    // 保证一定出现「核对」，便于人扫读
    if (text.indexOf('核对') === -1) text = composeText([`核对 ${file} 的改动并运行测试`])
  }

  // 规则 4：兜底 → 回到最近一轮，说明该轮目标
  if (kind === 'resume') {
    const summary = goalSummary || clipText(promptOf(turns[turns.length - 1]), NEXT_STEP_TEXT_MAX)
    text = composeText([
      turn === null ? '回到最近一轮继续：' : `回到第 ${turn} 轮继续：`,
      summary || '先确认这一步的目标',
    ])
  }

  // 兜底保底：任何路径都不得留白
  if (text === '') text = '回到最近一轮继续：先确认这一步的目标'

  const modelText = compress(opts.modelText)
  const source = modelText !== '' ? 'model' : 'rule'
  const finalText = source === 'model' ? clipText(modelText, NEXT_STEP_TEXT_MAX) : text

  const sessionIds = []
  if (typeof opts.sessionId === 'string' && opts.sessionId !== '') sessionIds.push(opts.sessionId)
  if (typeof src.sessionId === 'string' && src.sessionId !== '') sessionIds.push(src.sessionId)
  for (const id of Array.isArray(opts.sessionIds) ? opts.sessionIds : []) if (typeof id === 'string' && id !== '') sessionIds.push(id)
  for (const id of Array.isArray(src.sessionIds) ? src.sessionIds : []) if (typeof id === 'string' && id !== '') sessionIds.push(id)

  const evidenceTurn = kind === 'awaiting' ? (awaitingTurn ?? turn)
    : kind === 'error' ? (features.errorTurn ?? turn)
      : kind === 'files' ? (features.filesTurn ?? turn)
        : turn
  const evidenceHandle = (sessionIds.length > 0 && evidenceTurn !== null)
    ? `${sessionIds[0].slice(0, 8).toLowerCase()}#${evidenceTurn}`
    : ''

  return {
    text: finalText,
    source,
    kind,
    turn: evidenceTurn,
    evidenceHandle,
  }
}
