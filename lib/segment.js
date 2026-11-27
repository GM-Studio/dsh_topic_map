/**
 * 「段（Segment）」核心域纯模块。
 *
 * 定义（GLOSSARY.md）：
 *   同一会话内、时间连续、围绕同一主题的一串轮次，是机器可切的最小连续体。
 *   对工作是拼成「事」的积木，对日常交流本身就是会话内的话题目录项。
 *
 * 约束：
 *   - 100% 纯函数、无副作用、不读文件系统/DOM/系统时钟；
 *   - 兼容 Node.js ESM 与未来客户端打包/嵌入；
 *   - 切段结果严格保证：时间连续、不重叠、覆盖会话内全部轮次。
 *
 * @module dsh-topic-map/segment
 */

import { PRODUCING_TOOLS, isDeliverablePath } from './deliverables.js'
import { jaccard, tokenize } from './lane-engine.js'
import { extractJsonArray, extractJsonField } from './model-output.js'
import { outlinePromptHead } from './outline.js'
import { looksAutomated } from './session-category.js'

/** 默认相邻轮次强制切段的时间间隔阈值（45 分钟）。 */
export const DEFAULT_TIME_GAP_MS = 45 * 60 * 1000

/** 默认词面 + 实体综合相似度切段阈值（经真实工作区干跑校准）。 */
export const DEFAULT_SIMILARITY_THRESHOLD = 0.12

/** 默认最小段轮数（非硬边界切出的 1 轮碎片会被合理吸附）。 */
const DEFAULT_MIN_SEGMENT_TURNS = 2

/** 段标题字符上限。 */
const MAX_TITLE_CHARS = 36

/** 段摘要字符上限。 */
const MAX_SUMMARY_CHARS = 120

/** 模型精化提示词里的单轮文本预算。 */
const REFINE_PROMPT_BUDGET = 160
const REFINE_REPLY_BUDGET = 140

/** 轮次引用句柄正则：`〔8 位十六进制#轮号〕`。 */
const QUOTE_HANDLE_RE = /〔([0-9a-fA-F]{8})#(\d+)〕/g

/** 提问开头中可剥离的引用指针包装。 */
const QUOTE_WRAPPER_RE = /【@第\d+轮对话〔[0-9a-fA-F]{8}#\d+〕】/g

/** 触发 errorTurns 的异常结束原因。 */
const ERROR_END_REASONS = new Set([
  'error',
  'failed',
  'interrupted',
  'max-tokens',
  'blocked',
])

/** 会修改或产出工作区文件的工具名（小写）。 */
const MUTATING_TOOLS = new Set([
  ...PRODUCING_TOOLS.map(t => t.toLowerCase()),
  'apply_patch',
  'edit_file',
  'write_file',
  'create_file',
  'delete_file',
  'multi_edit',
  'notebook_edit',
  'replace_file_content',
  'str_replace',
  'str_replace_editor',
])

/** 典型工程 / 任务执行类工具名（小写）。 */
const ENGINEERING_TOOLS = new Set([
  ...MUTATING_TOOLS,
  'read',
  'grep',
  'glob',
  'pwsh',
  'bash',
  'shell',
  'terminal',
  'exec',
  'run_code',
  'ops_bash',
  'office_convert',
  'office_recalculate',
  'office_render',
])

/** 明确表达工程 / 任务意图的动词与短语。 */
const WORK_INTENT_RE = /(修复|修一下|排查|实现|重构|优化|编写|开发|部署|发布|单测|单元测试|集成测试|回归测试|跑.*测试|测试|调试|升级|迁移|架构|设计方案|写设计|接口|脚本|模块|组件|构建|编译|报错|异常|故障|回滚|建票|代码审查|review|refactor|implement|debug|\bfix\b|\bbug\b|deploy|\bbuild\b|unit test|vitest|jest|pytest|\bpnpm\b|\bnpm\b|\bgit\b)/i

/** 明显临时/依赖目录及根目录临时脚本噪音路径（用于 changedFiles 过滤）。 */
const TEMP_NOISE_RE = /(^|[\\/])(Temp|temp|tmp|spill|node_modules|\.git|dist|build|coverage|\.cache|\.npm|\.pnpm-store|target|\.next|\.nuxt|out|vendor|__pycache__|\.venv|venv)([\\/]|$)|(^|[\\/])\.tmp[-_.][^\\/]+$|\.bak$/i

/** 自动化 / 定时 / 子代理的平台 origin/kind/source 标识。 */
const AUTOMATED_ORIGINS = new Set([
  'subagent',
  'scheduled',
  'schedule',
  'cron',
  'automation',
  'automated',
  'system',
  'bot',
  'worker',
  'background',
])

/** 自动化 / 定时任务标题或首轮文本前缀特征。 */
const AUTOMATED_TEXT_RE = /^\s*\[(scheduled|schedule|cron|auto|automated|automation|subagent|worker|bot|system)\b[^\]]*\]/i

/** 常见顶层目录名，不作为判断“同一模块”的目录信号。 */
const GENERIC_DIRS = new Set([
  'src', 'lib', 'app', 'apps', 'packages', 'package', 'modules', 'module',
  'tests', 'test', 'spec', 'specs', 'docs', 'doc', 'scripts', 'script',
  'utils', 'util', 'common', 'shared', 'core', 'internal', 'cmd', 'pkg',
])

// ── 基础工具 ────────────────────────────────────────────────────────

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function clipText(text, max) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  const chars = Array.from(s)
  if (chars.length <= max) return s
  return `${chars.slice(0, Math.max(1, max - 1)).join('').trimEnd()}…`
}

function normalizePathKey(path) {
  return String(path ?? '').trim().replace(/\\/g, '/').toLowerCase()
}

function pushUniqueString(list, seen, raw) {
  if (typeof raw !== 'string') return
  const text = raw.trim()
  if (text === '' || seen.has(text)) return
  seen.add(text)
  list.push(text)
}

function pushUniquePath(list, seen, raw) {
  if (typeof raw !== 'string') return
  const text = raw.trim()
  if (text === '') return
  const key = normalizePathKey(text)
  if (seen.has(key)) return
  seen.add(key)
  list.push(text)
}

/** 取会话 ID 的确定性 8 位前缀（与引用句柄口径一致）。 */
function sessionPrefix8(sessionId) {
  const raw = typeof sessionId === 'string' ? sessionId.trim() : ''
  if (raw === '') return 'local'
  const stripped = raw.replace(/^session[-_:]/i, '')
  const cleaned = stripped.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()
  const prefix = cleaned.slice(0, 8)
  return prefix === '' ? 'local' : prefix
}

/** 生成确定性段 ID：`seg:<sessionPrefix8>:<startTurn>-<endTurn>`。 */
function makeSegmentId(sessionId, startTurn, endTurn) {
  return `seg:${sessionPrefix8(sessionId)}:${startTurn}-${endTurn}`
}

/** 提取文件路径的归一化词干（用于识别 `lib/foo.js` 与 `tests/foo.mjs` 属于同一对象）。 */
function fileStemOf(path) {
  const normalized = normalizePathKey(path)
  const slash = normalized.lastIndexOf('/')
  const base = slash < 0 ? normalized : normalized.slice(slash + 1)
  const stripped = base
    .replace(/\.(test|spec)\.[a-z0-9]+$/i, '')
    .replace(/\.[a-z0-9]+$/i, '')
  if (stripped === '' || stripped === 'index' || stripped === 'main' || stripped === 'mod') {
    return ''
  }
  return stripped
}

/** 提取有辨识度的直接父目录名（排除 src/lib/modules/tests 等泛目录）。 */
function moduleDirOf(path) {
  const parts = normalizePathKey(path).split('/').filter(Boolean)
  if (parts.length < 2) return ''
  const dir = parts[parts.length - 2]
  if (dir === '' || dir.endsWith(':') || GENERIC_DIRS.has(dir)) return ''
  return dir
}

function isMutatingTool(name) {
  if (typeof name !== 'string') return false
  const lower = name.trim().toLowerCase()
  if (MUTATING_TOOLS.has(lower)) return true
  return /(^|_)(write|edit|patch|create|delete|replace)($|_)/.test(lower)
}

function isEngineeringTool(name) {
  if (typeof name !== 'string') return false
  const lower = name.trim().toLowerCase()
  if (ENGINEERING_TOOLS.has(lower)) return true
  if (lower.startsWith('deck_') || lower.startsWith('team_task_') || lower.startsWith('git_')) return true
  return isMutatingTool(lower)
}

function isErrorTurn(turn) {
  if (!isPlainObject(turn)) return false
  if (turn.interrupted === true) return true
  const reason = typeof turn.endReason === 'string' ? turn.endReason.trim().toLowerCase() : ''
  return ERROR_END_REASONS.has(reason)
}

/** 从一轮的 `changes.files` 或修改类工具提取变更文件（不混入纯读路径）。 */
function extractTurnChangedFiles(turn) {
  const out = []
  const seen = new Set()

  // ① 权威源：`changes.files`
  const changeFiles = Array.isArray(turn?.changes?.files) ? turn.changes.files : null
  if (changeFiles !== null && changeFiles.length > 0) {
    for (const item of changeFiles) {
      const raw = typeof item === 'string' ? item : item?.path
      if (typeof raw !== 'string') continue
      const trimmed = raw.trim()
      if (trimmed === '' || TEMP_NOISE_RE.test(trimmed)) continue
      pushUniquePath(out, seen, trimmed)
    }
    return out
  }

  // ② 兼容兜底：无 changes 明细但调用了修改/产出类工具时，按 deliverables 规则过滤
  // 若 changes 明确存在且 files 为空数组（该轮经宿主确认无文件落盘变更），不退回 files 误抓读路径
  if (turn?.changes?.lost === true) return out
  if (changeFiles !== null && changeFiles.length === 0) return out
  const tools = Array.isArray(turn?.tools) ? turn.tools : []
  const hasMutating = tools.some(name => isMutatingTool(name))
  if (!hasMutating) return out

  for (const raw of (Array.isArray(turn?.files) ? turn.files : [])) {
    if (!isDeliverablePath(raw)) continue
    pushUniquePath(out, seen, raw)
  }
  return out
}

/** 归一单条轮次行，兼容 turn-index 与 turn-model 两种字段命名。 */
function normalizeTurn(raw) {
  if (!isPlainObject(raw)) return null
  const turn = Number(raw.turn)
  if (!Number.isInteger(turn) || turn < 0) return null
  const start = validNumber(raw.start) ?? validNumber(raw.startTime)
  const end = validNumber(raw.end) ?? validNumber(raw.endTime)
  return {
    turn,
    seq: validNumber(raw.seq) ?? validNumber(raw.startSeq),
    endSeq: validNumber(raw.endSeq),
    start,
    end,
    prompt: typeof raw.prompt === 'string' ? raw.prompt : '',
    response: typeof raw.response === 'string' ? raw.response : '',
    tools: Array.isArray(raw.tools) ? raw.tools.filter(t => typeof t === 'string' && t.trim() !== '') : [],
    files: Array.isArray(raw.files) ? raw.files.filter(f => typeof f === 'string' && f.trim() !== '') : [],
    commands: Array.isArray(raw.commands) ? raw.commands.filter(c => typeof c === 'string' && c.trim() !== '') : [],
    endReason: typeof raw.endReason === 'string' && raw.endReason !== '' ? raw.endReason : 'completed',
    interrupted: raw.interrupted === true,
    changes: isPlainObject(raw.changes) ? raw.changes : undefined,
    afterCompaction: raw.afterCompaction === true,
  }
}

// ── 引用句柄提取 ────────────────────────────────────────────────────

/**
 * 从文本里提取所有 `〔8hex#N〕` 轮次引用句柄（小写归一、去重、保序）。
 *
 * @param {string} text - 用户提问文本。
 * @returns {string[]} 句柄列表，如 `['4c42ff36#3']`。
 */
export function extractQuoteHandles(text) {
  if (typeof text !== 'string' || text === '') return []
  const out = []
  const seen = new Set()
  QUOTE_HANDLE_RE.lastIndex = 0
  let match
  while ((match = QUOTE_HANDLE_RE.exec(text)) !== null) {
    const handle = `${match[1].toLowerCase()}#${Number(match[2])}`
    if (!seen.has(handle)) {
      seen.add(handle)
      out.push(handle)
    }
  }
  return out
}

// ── TF-IDF 词面向量与文件集合信号 ────────────────────────────────────

function cosine(a, b) {
  let dot = 0
  let na = 0
  let nb = 0
  for (const [term, weight] of a) {
    na += weight * weight
    const other = b.get(term)
    if (other !== undefined) dot += weight * other
  }
  for (const weight of b.values()) nb += weight * weight
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

function vectorizeTurns(turns) {
  const docs = turns.map(t => tokenize(`${t.prompt} ${t.response}`))
  const df = new Map()
  for (const doc of docs) {
    for (const term of new Set(doc)) df.set(term, (df.get(term) ?? 0) + 1)
  }
  const n = Math.max(1, docs.length)
  return docs.map(doc => {
    const tf = new Map()
    for (const term of doc) tf.set(term, (tf.get(term) ?? 0) + 1)
    const vec = new Map()
    for (const [term, count] of tf) {
      const idf = Math.log((n + 1) / ((df.get(term) ?? 1) + 1)) + 1
      vec.set(term, (1 + Math.log(count)) * idf)
    }
    return vec
  })
}

function aggregateVectors(indexes, vectors) {
  const sum = new Map()
  for (const i of indexes) {
    for (const [term, weight] of vectors[i]) {
      sum.set(term, (sum.get(term) ?? 0) + weight)
    }
  }
  return sum
}

/** 构造一轮的语义对象集合：有意义文件、文件词干、模块目录、命令词、引用句柄。 */
function turnSignalsOf(turn) {
  const files = new Set()
  const stems = new Set()
  const dirs = new Set()
  const changed = extractTurnChangedFiles(turn)

  const candidatePaths = [...changed, ...turn.files]
  for (const raw of candidatePaths) {
    const trimmed = String(raw).trim()
    if (trimmed === '' || TEMP_NOISE_RE.test(trimmed)) continue
    files.add(normalizePathKey(trimmed))
    const stem = fileStemOf(trimmed)
    if (stem !== '') stems.add(stem)
    const dir = moduleDirOf(trimmed)
    if (dir !== '') dirs.add(dir)
  }

  const cmdEntities = new Set()
  for (const cmd of turn.commands) {
    cmdEntities.add(`cmd:${cmd.trim().toLowerCase()}`)
  }

  const handles = new Set(extractQuoteHandles(turn.prompt))
  const hasChanged = changed.length > 0
  const hasWorkSignal =
    hasChanged ||
    turn.commands.length > 0 ||
    isErrorTurn(turn) ||
    turn.tools.some(isEngineeringTool) ||
    WORK_INTENT_RE.test(turn.prompt)

  return { files, stems, dirs, cmdEntities, handles, hasChanged, hasWorkSignal }
}

function mergeSignals(indexes, signals) {
  const files = new Set()
  const stems = new Set()
  const dirs = new Set()
  const cmdEntities = new Set()
  const handles = new Set()
  let hasChanged = false

  for (const i of indexes) {
    const s = signals[i]
    for (const v of s.files) files.add(v)
    for (const v of s.stems) stems.add(v)
    for (const v of s.dirs) dirs.add(v)
    for (const v of s.cmdEntities) cmdEntities.add(v)
    for (const v of s.handles) handles.add(v)
    if (s.hasChanged) hasChanged = true
  }
  return { files, stems, dirs, cmdEntities, handles, hasChanged }
}

function hasIntersection(a, b) {
  if (a.size === 0 || b.size === 0) return false
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  for (const v of small) if (large.has(v)) return true
  return false
}

/** 计算两个窗口的综合相似度与文件集合切换信号。 */
function boundaryScore(leftIdx, rightIdx, vectors, signals) {
  const leftVec = aggregateVectors(leftIdx, vectors)
  const rightVec = aggregateVectors(rightIdx, vectors)
  const textSim = cosine(leftVec, rightVec)

  const leftSig = mergeSignals(leftIdx, signals)
  const rightSig = mergeSignals(rightIdx, signals)

  // 共享用户引用句柄：显式延续同一话题
  if (hasIntersection(leftSig.handles, rightSig.handles)) {
    return { similarity: Math.max(textSim, 0.8), fileSwitch: false }
  }

  const bothHaveFiles = leftSig.files.size > 0 && rightSig.files.size > 0
  const sharedFile = hasIntersection(leftSig.files, rightSig.files)
  const sharedStem = hasIntersection(leftSig.stems, rightSig.stems)
  const sharedDir = hasIntersection(leftSig.dirs, rightSig.dirs)

  // 文件集合强切换：两侧均操作具体文件，且路径、词干、模块目录完全无交集
  const fileSwitch =
    bothHaveFiles &&
    !sharedFile &&
    !sharedStem &&
    !sharedDir &&
    ((leftSig.hasChanged && rightSig.hasChanged) || (leftIdx.length >= 2 && rightIdx.length >= 2))

  // 构造用于相似度计算的实体集合（不含 read/edit/pwsh 这类泛工具名）
  const leftEntities = new Set([...leftSig.files, ...leftSig.stems.values(), ...leftSig.cmdEntities])
  const rightEntities = new Set([...rightSig.files, ...rightSig.stems.values(), ...rightSig.cmdEntities])

  if (leftEntities.size === 0 && rightEntities.size === 0) {
    return { similarity: textSim, fileSwitch: false }
  }

  const entitySim = jaccard(leftEntities, rightEntities)
  const composite = 0.55 * textSim + 0.45 * entitySim
  return { similarity: composite, fileSwitch }
}

/** 检查相邻两轮之间是否存在强制硬断点（时间间隔 ≥ timeGapMs 或上下文压缩）。 */
function hardBoundaryReason(prev, cur, timeGapMs) {
  if (cur.afterCompaction === true) return 'compaction'
  const prevTime = prev.end ?? prev.start
  const curTime = cur.start ?? cur.end
  if (prevTime !== null && curTime !== null && curTime - prevTime >= timeGapMs) {
    return 'time-gap'
  }
  return null
}

/**
 * 人类显式转折的判据（ADR-0007 的「显式轮次」硬信号）。
 *
 * 只在人类**明确宣布换一件事**时才切主线，例如「另外，帮我看下部署脚本」。
 * 刻意保持保守：宁可少切（把一件事留在一条主线里），也不要把同一件事剁碎。
 *
 * 反例（必须**不**切）：「另外 3 个用例也失败了」——这是同一件事的继续，
 * 所以「另外」后面紧跟数字时不算转折。
 */
const PIVOT_PATTERNS = [
  // 注意：裸「另外」**不算转折**。中文里它绝大多数时候是「此外／还有」，
  // 是在同一件事上补充，而不是另起一件事（真机实测：把裸「另外」当转折
  // 会让一个 6 会话的工作区炸出 16 条碎事）。必须是「另外一件事/另一个问题」这种
  // 明确声明才切。
  /另(?:外|有)(?:一|1)?(?:个|件|项)?(?:新)?(?:的)?(?:任务|需求|问题|事情|话题)/,
  /换个?话题/,
  /新的(?:任务|需求|事项)/,
  /(?:接下来|下面)(?:我们)?(?:来看|来看下|处理|做)(?:另|新)/,
  /另(?:起|开)(?:一个)?(?:任务|话题|需求)/,
]

/**
 * 这一轮人类是否明确宣布「开始另一件事」。
 *
 * @param {object} turn - 已 normalize 的轮次。
 * @returns {boolean} 是否为显式转折轮。
 */
function isExplicitPivot(turn) {
  if (!isPlainObject(turn)) return false
  const text = typeof turn.prompt === 'string' ? turn.prompt.trim() : ''
  if (text === '') return false
  for (const re of PIVOT_PATTERNS) {
    if (re.test(text)) return true
  }
  return false
}

/** 预判一段连续轮次的 kindCandidate 与依据。 */
function classifyKind(slice, changedFiles, commands, errorTurns) {
  const reasons = []
  if (changedFiles.length > 0) reasons.push('changed-files')
  if (commands.length > 0) reasons.push('commands')
  if (errorTurns.length > 0) reasons.push('error-turns')

  const hasMutatingTool = slice.some(t => t.tools.some(isMutatingTool))
  if (hasMutatingTool) reasons.push('mutating-tools')

  const hasEngTool = slice.some(t => t.tools.some(isEngineeringTool))
  const hasFiles = slice.some(t => t.files.some(f => !TEMP_NOISE_RE.test(f)))
  if (hasEngTool && (hasFiles || slice.some(t => WORK_INTENT_RE.test(t.prompt)))) {
    reasons.push('engineering-tools')
  }

  const hasWorkIntent = slice.some(t => WORK_INTENT_RE.test(t.prompt))
  if (hasWorkIntent) reasons.push('work-intent')

  if (reasons.length > 0) {
    return { kindCandidate: 'work', kindReasons: reasons }
  }
  return { kindCandidate: 'chat', kindReasons: ['no-work-evidence'] }
}

/** 为一段生成简洁人类可读标题（零模型调用）。 */
function buildLocalTitle(slice, changedFiles) {
  for (const turn of slice) {
    const cleaned = turn.prompt
      .replace(QUOTE_WRAPPER_RE, '')
      .replace(QUOTE_HANDLE_RE, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (cleaned !== '') return clipText(cleaned, MAX_TITLE_CHARS)
  }
  if (changedFiles.length > 0) {
    const first = changedFiles[0].replace(/\\/g, '/')
    const base = first.slice(first.lastIndexOf('/') + 1)
    return clipText(`修改 ${base}`, MAX_TITLE_CHARS)
  }
  const firstTurn = slice[0].turn
  const lastTurn = slice[slice.length - 1].turn
  return firstTurn === lastTurn ? `第 ${firstTurn} 轮` : `第 ${firstTurn}–${lastTurn} 轮`
}

/** 为一段生成一句话本地摘要。 */
function buildLocalSummary(slice, changedFiles, errorTurns) {
  const prompts = slice
    .map(t => t.prompt.replace(/\s+/g, ' ').trim())
    .filter(Boolean)

  let base = ''
  if (prompts.length === 1) {
    base = clipText(prompts[0], 88)
  } else if (prompts.length > 1) {
    base = `${clipText(prompts[0], 46)} → ${clipText(prompts[prompts.length - 1], 40)}`
  } else {
    const first = slice[0].turn
    const last = slice[slice.length - 1].turn
    base = `第 ${first}–${last} 轮对话`
  }

  const tags = []
  if (changedFiles.length > 0) tags.push(`变更 ${changedFiles.length} 个文件`)
  if (errorTurns.length > 0) tags.push(`${errorTurns.length} 轮异常`)
  if (tags.length === 0) return clipText(base, MAX_SUMMARY_CHARS)
  return clipText(`${base}（${tags.join('，')}）`, MAX_SUMMARY_CHARS)
}

/** 构造标准 Segment 对象。 */
function buildSegmentRecord(slice, options, hardCutBefore) {
  const sessionId = typeof options.sessionId === 'string' ? options.sessionId : ''
  const forkParent =
    typeof options.forkParent === 'string' && options.forkParent.trim() !== ''
      ? options.forkParent.trim()
      : null

  const startTurn = slice[0].turn
  const endTurn = slice[slice.length - 1].turn
  const turnCount = slice.length

  let startTime = null
  let endTime = null
  for (const t of slice) {
    const st = t.start ?? t.end
    const et = t.end ?? t.start
    if (st !== null && (startTime === null || st < startTime)) startTime = st
    if (et !== null && (endTime === null || et > endTime)) endTime = et
  }

  const files = []
  const fileSeen = new Set()
  const changedFiles = []
  const changedSeen = new Set()
  const commands = []
  const cmdSeen = new Set()
  const errorTurns = []
  const quoteHandles = []
  const handleSeen = new Set()

  for (const t of slice) {
    for (const f of t.files) pushUniquePath(files, fileSeen, f)
    for (const cf of extractTurnChangedFiles(t)) {
      pushUniquePath(changedFiles, changedSeen, cf)
      pushUniquePath(files, fileSeen, cf)
    }
    for (const c of t.commands) pushUniqueString(commands, cmdSeen, c)
    if (isErrorTurn(t)) errorTurns.push(t.turn)
    for (const h of extractQuoteHandles(t.prompt)) pushUniqueString(quoteHandles, handleSeen, h)
  }

  const { kindCandidate, kindReasons } = classifyKind(slice, changedFiles, commands, errorTurns)

  let confidence = 0.65
  if (changedFiles.length > 0 || commands.length > 0 || errorTurns.length > 0) confidence += 0.15
  if (turnCount >= 2) confidence += 0.1
  else if (hardCutBefore) confidence += 0.05
  if (files.length > 0 || quoteHandles.length > 0) confidence += 0.05
  confidence = Math.round(Math.min(0.98, Math.max(0.4, confidence)) * 100) / 100

  return {
    id: makeSegmentId(sessionId, startTurn, endTurn),
    sessionId,
    startTurn,
    endTurn,
    turnCount,
    startTime,
    endTime,
    title: buildLocalTitle(slice, changedFiles),
    summary: buildLocalSummary(slice, changedFiles, errorTurns),
    kindCandidate,
    kindReasons,
    files,
    changedFiles,
    commands,
    errorTurns,
    quoteHandles,
    forkParent,
    confidence,
  }
}

function runKindOf(run, turns) {
  const slice = turns.slice(run.from, run.to + 1)
  const changed = []
  const changedSeen = new Set()
  const commands = []
  const cmdSeen = new Set()
  const errors = []
  for (const t of slice) {
    for (const cf of extractTurnChangedFiles(t)) pushUniquePath(changed, changedSeen, cf)
    for (const c of t.commands) pushUniqueString(commands, cmdSeen, c)
    if (isErrorTurn(t)) errors.push(t.turn)
  }
  return classifyKind(slice, changed, commands, errors).kindCandidate
}

/**
 * 吸附非硬边界切出的过短碎片（默认 1 轮），同时保护：
 *   1. 硬边界（时间间隔 / 上下文压缩）永不被跨过合并；
 *   2. 优先并入同类型（work↔work / chat↔chat）相邻段；
 *   3. 跨 work↔chat 边界时，仅在碎片为极短承接句（如"继续"/"取消这一轮"）且无文件工具时吸附。
 */
function absorbFragmentRuns(runs, turns, minSize) {
  const list = runs.map(r => ({ ...r, locked: false }))
  if (list.length <= 1 || minSize <= 1) return list

  for (let guard = 0; guard < list.length * 2 + 4; guard += 1) {
    let idx = -1
    for (let i = 0; i < list.length; i += 1) {
      if (!list[i].locked && list[i].to - list[i].from + 1 < minSize) {
        idx = i
        break
      }
    }
    if (idx < 0 || list.length <= 1) break

    const cur = list[idx]
    const prev = idx > 0 && !cur.hardCutBefore ? list[idx - 1] : null
    const next = idx < list.length - 1 && !list[idx + 1].hardCutBefore ? list[idx + 1] : null

    if (prev === null && next === null) {
      cur.locked = true
      continue
    }

    const curKind = runKindOf(cur, turns)
    const prevKind = prev !== null ? runKindOf(prev, turns) : null
    const nextKind = next !== null ? runKindOf(next, turns) : null

    const prevSame = prev !== null && prevKind === curKind
    const nextSame = next !== null && nextKind === curKind

    let target = null
    if (prevSame && nextSame) {
      const prevLen = prev.to - prev.from + 1
      const nextLen = next.to - next.from + 1
      target = prevLen >= nextLen ? 'prev' : 'next'
    } else if (prevSame) {
      target = 'prev'
    } else if (nextSame) {
      target = 'next'
    } else {
      const single = turns[cur.from]
      const promptLen = single.prompt.replace(/\s+/g, ' ').trim().length
      const isSinglePureText =
        cur.from === cur.to &&
        single.files.length === 0 &&
        single.commands.length === 0 &&
        !single.tools.some(isEngineeringTool)
      const trivial = isSinglePureText && promptLen <= 12
      // 真实干跑常见「work → 1 轮短追问/确认(chat) → work」三明治：
      // 两侧同为 work 且时间间隔 < 15 分钟、单轮追问 ≤ 80 字无独立文件时并入前段，避免把连续工作砍碎。
      const sandwich =
        isSinglePureText &&
        curKind === 'chat' &&
        prevKind === 'work' &&
        nextKind === 'work' &&
        promptLen <= 80 &&
        prev !== null &&
        next !== null &&
        single.start !== null &&
        single.end !== null &&
        turns[prev.to].end !== null &&
        turns[next.from].start !== null &&
        Math.abs(single.start - turns[prev.to].end) < 15 * 60 * 1000 &&
        Math.abs(turns[next.from].start - single.end) < 15 * 60 * 1000
      if (trivial || sandwich) {
        target = prev !== null ? 'prev' : 'next'
      }
    }

    if (target === 'prev' && prev !== null) {
      prev.to = cur.to
      list.splice(idx, 1)
    } else if (target === 'next' && next !== null) {
      next.from = cur.from
      next.hardCutBefore = cur.hardCutBefore
      list.splice(idx, 1)
    } else {
      cur.locked = true
    }
  }

  return list
}

function indexRange(from, toExclusive) {
  const out = []
  for (let i = from; i < toExclusive; i += 1) out.push(i)
  return out
}

// ── 待确认（AI 停在等人回复）判定 ───────────────────────────────────

/** 「待确认」摘要的最大字符数。 */
const AWAITING_SUMMARY_MAX = 80

/**
 * 等人类验证/复现的动作词。
 */
const AWAIT_VERIFY_RE =
  /你[^。！？!?；;，,]{0,6}(强刷|刷新|重启|重新加载|重新进|跑一下|跑一遍|试一下|试试看|测一下|测试一下|自测一下|验证一下|复现一下|确认一下|核对一下)/

/** 等拍板：AI 末段明确罗列候选方案。 */
const AWAIT_DECISION_RE =
  /(方案\s*[ABab一二两123]|选项\s*[ABab一二两123]|二选一|选哪个|挑一个|还是用|还是选|(?:A|甲)\s*还是\s*(?:B|乙)|两个方案|三种方案)/

/** 一般反问：等一句确认/答复。 */
const AWAIT_QUESTION_RE =
  /(请确认|帮我确认|要不要|是否要|是否可以|能不能|可不可以|可以吗|行吗|好吗|对吗|是不是|你觉得|你要不要|需要我)/

/** 汉英问号结尾。 */
const AWAIT_TAIL_QUESTION_RE = /[?？]\s*$/

/** 取末句（按中英句末标点切分，保序、去空白）。 */
function lastSentenceOf(text) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (flat === '') return ''
  const parts = flat.split(/(?<=[。！？!?；;])/).map(s => s.trim()).filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1] : flat
}

/** 取一条轮次的 AI 回复文本（优先权威字段 `response`，再兼容轻量别名）。 */
function assistantTextOf(raw, row) {
  const rawObj = isPlainObject(raw) ? raw : {}
  const chain = [
    typeof rawObj.response === 'string' ? rawObj.response : '',
    row !== null && typeof row.response === 'string' ? row.response : '',
    typeof rawObj.assistantTail === 'string' ? rawObj.assistantTail : '',
    typeof rawObj.aiText === 'string' ? rawObj.aiText : '',
    typeof rawObj.assistantText === 'string' ? rawObj.assistantText : '',
    typeof rawObj.reply === 'string' ? rawObj.reply : '',
  ]
  for (const text of chain) {
    if (text.trim() !== '') return text
  }
  return ''
}

/**
 * 判断一组轮次是否停在「AI 发出、等人类回复」的悬念上（契约 §4）。
 *
 * 判据自上而下，命中即停（第一个命中项就是 `reason`）：
 *   1. `question` —— 宿主/上游显式标注待确认：`awaitingHuman` / `awaiting` /
 *      `pendingQuestion` / `assistantAsked`；
 *   2. `verify`   —— AI 末段出现「你 + 验证类动作」（请你强刷 / 麻烦你测试一下）；
 *   3. `decision` —— AI 末段罗列候选方案等拍板（方案 A / 选项一 / 二选一 / 选哪个）；
 *   4. `question` —— AI 末段以问号收尾，或含「要不要 / 请确认 / 可以吗 / 是不是」等反问；
 *   5. `open`     —— 无 AI 文本但末轮仍未收尾（`endReason === 'open'`）；
 *   6. 都不命中 → `{ active: false, summary: '', turn: null, reason: '' }`。
 *
 * `summary` 取 AI 末句（无 AI 文本时退回该轮人类提问），按 emoji 安全的方式截断。
 * 纯函数：不读时钟、不写文件、不改入参。
 */
export function detectAwaitingHuman(turns, options = {}) {
  void options
  const rows = []
  for (const item of Array.isArray(turns) ? turns : []) {
    const row = normalizeTurn(item)
    if (row !== null) rows.push({ row, raw: isPlainObject(item) ? item : {} })
  }
  if (rows.length === 0) return { active: false, summary: '', turn: null, reason: '' }
  rows.sort((a, b) => a.row.turn - b.row.turn)

  const last = rows[rows.length - 1]
  const flat = assistantTextOf(last.raw, last.row).replace(/\s+/g, ' ').trim()

  const explicit =
    last.raw.awaitingHuman === true ||
    last.raw.awaiting === true ||
    last.raw.pendingQuestion === true ||
    last.raw.assistantAsked === true

  let reason = ''
  if (explicit) {
    reason = 'question'
  } else if (flat !== '' && AWAIT_VERIFY_RE.test(flat)) {
    reason = 'verify'
  } else if (flat !== '' && AWAIT_DECISION_RE.test(flat)) {
    reason = 'decision'
  } else if (flat !== '' && (AWAIT_TAIL_QUESTION_RE.test(flat) || AWAIT_QUESTION_RE.test(flat))) {
    reason = 'question'
  } else if (last.row.endReason === 'open' || last.raw.open === true || last.raw.pending === true) {
    reason = 'open'
  }

  if (reason === '') return { active: false, summary: '', turn: null, reason: '' }

  const base = flat !== '' ? lastSentenceOf(flat) : last.row.prompt
  return {
    active: true,
    summary: clipText(base, AWAITING_SUMMARY_MAX),
    turn: last.row.turn,
    reason,
  }
}

// ── 主切段函数 ──────────────────────────────────────────────────────

/**
 * `strategy: 'boundary'` 的切段实现（历史默认行为）。
 *
 * 逐相邻轮判定：硬断点（长间隔 / 压缩重置）优先；否则看文件集合是否强切换、
 * 以及窗口相似度是否低于阈值。返回值是 `{ from, to, hardCutBefore }` 的原始区间，
 * 后续统一交给 `absorbFragmentRuns` 吸收碎段。
 */
function buildBoundaryRuns(turns, context) {
  const { timeGapMs, threshold, vectors, signals } = context
  const runs = []
  let start = 0
  let startHardCut = false

  for (let i = 1; i < turns.length; i += 1) {
    const hardReason = hardBoundaryReason(turns[i - 1], turns[i], timeGapMs)
    if (hardReason !== null) {
      runs.push({ from: start, to: i - 1, hardCutBefore: startHardCut })
      start = i
      startHardCut = true
      continue
    }

    const leftIdx = indexRange(Math.max(start, i - 2), i)
    const rightIdx = indexRange(i, Math.min(turns.length, i + 2))
    const { similarity, fileSwitch } = boundaryScore(leftIdx, rightIdx, vectors, signals)

    // 紧邻两轮如果直接高度相似或共享文件词干，不因远端窗口混入别的话题而误切；
    // 若紧邻两轮发生文件强切换但词面高度重合，以文件集合切换优先。
    const pairScore = boundaryScore([i - 1], [i], vectors, signals)
    const effectiveSim = Math.max(similarity, pairScore.similarity)
    const switched = fileSwitch || pairScore.fileSwitch

    if (switched || effectiveSim < threshold) {
      runs.push({ from: start, to: i - 1, hardCutBefore: startHardCut })
      start = i
      startHardCut = false
    }
  }
  runs.push({ from: start, to: turns.length - 1, hardCutBefore: startHardCut })
  return runs
}

/**
 * `strategy: 'mainline'` 的切段实现（ADR-0007）。
 *
 * 以会话主线为单位：只在「硬断点」与「人类显式转折」两处切，词面相似度降级为
 * 不参与切分——连续推进的一件工作不再因为相似度波动被剁成碎段。
 * ③ 步骤前先与 `boundary` 同行为，保证开关本身不改变任何既有输出。
 */
function buildMainlineRuns(turns, context) {
  const { timeGapMs, threshold, vectors, signals } = context
  const runs = []
  let start = 0
  let startHardCut = false

  const cut = () => {
    runs.push({ from: start, to: start === 0 ? start : start - 1 + 0, hardCutBefore: startHardCut })
  }

  for (let i = 1; i < turns.length; i += 1) {
    // 压缩重置是客观断点：上下文被重置过，前后不是同一次连续推理，必须切。
    if (turns[i].afterCompaction === true) {
      runs.push({ from: start, to: i - 1, hardCutBefore: startHardCut })
      start = i
      startHardCut = true
      continue
    }

    // 时间间隔**单独不足以**切开一条主线（ADR-0007）。
    //
    // 真机上人经常隔几小时回来接着干同一件事，若见到 45 分钟就切，
    // 一个 6 会话的工作区会被切成十几条「碎卡」——这正是改造前的老毛病。
    // 只有「间隔够久」**且**「话题确实漂移（或文件集合强切换）」时才切。
    if (hardBoundaryReason(turns[i - 1], turns[i], timeGapMs) === 'time-gap') {
      const pairScore = boundaryScore([i - 1], [i], vectors, signals)
      const drifted = pairScore.fileSwitch || pairScore.similarity < threshold
      if (drifted) {
        runs.push({ from: start, to: i - 1, hardCutBefore: startHardCut })
        start = i
        startHardCut = true
        continue
      }
      // 同一件事隔了点时间继续做：留在同一条主线里，不切。
    }

    // 人类显式转折：「另外，帮我看下部署脚本」这种明确的换事声明才切。
    // 单纯的词面相似度波动**不参与**——它正是把连续工作剁碎的元凶。
    if (isExplicitPivot(turns[i])) {
      runs.push({ from: start, to: i - 1, hardCutBefore: startHardCut })
      start = i
      startHardCut = false
    }
  }
  runs.push({ from: start, to: turns.length - 1, hardCutBefore: startHardCut })
  return runs
}

/**
 * 把一个会话的轮次数组切成时间连续、不重叠、覆盖全轮次的「段（Segment）」数组。
 *
 * 切分信号（按优先级）：
 *   1. 硬断点：相邻轮间隔 ≥ timeGapMs（默认 45 分钟），或 `afterCompaction === true`；
 *   2. 文件集合切换：两侧均操作具体文件，且路径、词干、模块目录完全无交集；
 *   3. 词面 + 实体相似度低于阈值（复用 `lane-engine.js` 的 `tokenize`/`jaccard`）。
 *
 * @param {Array<object>} turns - 会话轮次数组（兼容 turn-index 行格式）。
 * @param {object} [options] - 可选配置。
 * @param {string} [options.sessionId] - 会话 ID，用于生成确定性段 ID。
 * @param {string|null} [options.forkParent] - 分叉父会话 ID（可选）。
 * @param {number} [options.timeGapMs] - 强切时间间隔阈值（默认 45 分钟）。
 * @param {number} [options.similarityThreshold] - 词面+实体相似度切段阈值（默认 0.18）。
 * @param {number} [options.minSegmentTurns] - 非硬断点最小段轮数（默认 2）。
 * @returns {Array<object>} 连续、不重叠、全覆盖的段数组。
 */
export function sliceSessionSegments(turns, options = {}) {
  if (!Array.isArray(turns) || turns.length === 0) return []
  const settings = isPlainObject(options) ? options : {}
  const timeGapMs =
    Number.isFinite(settings.timeGapMs) && settings.timeGapMs > 0
      ? settings.timeGapMs
      : DEFAULT_TIME_GAP_MS
  const threshold =
    Number.isFinite(settings.similarityThreshold) && settings.similarityThreshold >= 0
      ? settings.similarityThreshold
      : DEFAULT_SIMILARITY_THRESHOLD
  const minSegmentTurns =
    Number.isInteger(settings.minSegmentTurns) && settings.minSegmentTurns >= 1
      ? settings.minSegmentTurns
      : DEFAULT_MIN_SEGMENT_TURNS
  // 缺省 'boundary'：保持既有切段行为（旧测试与现有调用方不受影响）；
  // 'mainline' 为 ADR-0007 的会话主线切分，只在长间隔 / 显式转折处切。
  const strategy = settings.strategy === 'mainline' ? 'mainline' : 'boundary'

  const normalized = []
  for (const item of turns) {
    const row = normalizeTurn(item)
    if (row !== null) normalized.push(row)
  }
  if (normalized.length === 0) return []
  normalized.sort((a, b) => a.turn - b.turn)

  if (normalized.length === 1) {
    return [buildSegmentRecord(normalized, settings, false)]
  }

  const vectors = vectorizeTurns(normalized)
  const signals = normalized.map(turnSignalsOf)

  const context = { timeGapMs, threshold, vectors, signals }
  const rawRuns =
    strategy === 'mainline'
      ? buildMainlineRuns(normalized, context)
      : buildBoundaryRuns(normalized, context)

  // 'mainline' 不做碎片吸附：它本来就只在硬断点/显式转折处切，
  // 再把短段吸回去会把刚切开的转折抹平，等于白切。
  const finalRuns = strategy === 'mainline'
    ? rawRuns
    : absorbFragmentRuns(rawRuns, normalized, minSegmentTurns)
  return finalRuns.map(run =>
    buildSegmentRecord(normalized.slice(run.from, run.to + 1), settings, run.hardCutBefore === true),
  )
}

// ── 自动化 / 子代理 / 定时 / 空会话识别 ─────────────────────────────

/**
 * 判断一个会话是否属于子代理、自动化、定时任务或 0 轮空会话（应排除在自动立「事」之外）。
 *
 * 封装并增强 `session-category.js` 的 `looksAutomated`。
 *
 * @param {object|null|undefined} session - 会话元数据对象。
 * @returns {boolean} 是否为自动化/非人工推进会话。
 */
export function isAutomatedSession(session) {
  if (!isPlainObject(session)) return true

  // 1. 0 轮空会话直接排除
  if (Array.isArray(session.turns) && session.turns.length === 0) return true
  if (typeof session.turns === 'number' && Number.isFinite(session.turns) && session.turns <= 0) return true
  if (typeof session.turnCount === 'number' && Number.isFinite(session.turnCount) && session.turnCount <= 0) return true

  // 2. 复用基础 looksAutomated（origin=subagent / delegationDepth>0 / dsh-mnemon / 系统策略消息）
  if (looksAutomated(session)) return true

  // 3. 平台显式布尔与元数据标记
  if (
    session.isSubagent === true ||
    session.subagent === true ||
    session.automated === true ||
    session.isAutomated === true ||
    session.scheduled === true
  ) {
    return true
  }

  const originCandidates = [
    session.origin,
    session.kind,
    session.trigger,
    typeof session.source === 'string' ? session.source : session.source?.kind,
  ]
  for (const val of originCandidates) {
    if (typeof val === 'string' && AUTOMATED_ORIGINS.has(val.trim().toLowerCase())) {
      return true
    }
  }

  for (const key of ['scheduleId', 'scheduledTaskId', 'automationId', 'parentAgentId']) {
    if (typeof session[key] === 'string' && session[key].trim() !== '') return true
  }

  // 3.5 全部轮次均为定时/自动化触发（ADR-0005：无任何人工发起轮次）
  if (Array.isArray(session.turns) && session.turns.length > 0) {
    const allAutomatedTurns = session.turns.every(turn => {
      if (!isPlainObject(turn)) return false
      const trig = typeof turn.trigger === 'string' ? turn.trigger.trim().toLowerCase() : ''
      const src = typeof turn.source === 'string'
        ? turn.source.trim().toLowerCase()
        : (typeof turn.source?.kind === 'string' ? turn.source.kind.trim().toLowerCase() : '')
      return (
        (trig !== '' && AUTOMATED_ORIGINS.has(trig)) ||
        (src !== '' && AUTOMATED_ORIGINS.has(src))
      )
    })
    if (allAutomatedTurns) return true
  }

  // 4. 文本特征兜底（定时任务/自动化前缀）
  const title = typeof session.title === 'string' ? session.title.trim() : ''
  const firstPrompt = typeof session.firstPrompt === 'string' ? session.firstPrompt.trim() : ''
  if (AUTOMATED_TEXT_RE.test(title) || AUTOMATED_TEXT_RE.test(firstPrompt)) return true

  // 5. 无标题且无首轮内容，且没有正轮次数 → 空会话
  const hasPositiveTurns =
    (typeof session.turns === 'number' && session.turns > 0) ||
    (typeof session.turnCount === 'number' && session.turnCount > 0) ||
    (Array.isArray(session.turns) && session.turns.length > 0)
  if (title === '' && firstPrompt === '' && !hasPositiveTurns) return true

  return false
}

// ── 模型异步精化提示词与健壮解析 ────────────────────────────────────

/**
 * 构造可选的段精化提示词：让模型修正段标题、合并过碎相邻段、精化 work/chat 与一句话 summary。
 *
 * @param {Array<object>} turns - 会话轮次数组。
 * @param {Array<object>} localSegments - 本地切段结果。
 * @returns {{ system: string, user: string }} 提示词对。
 */
export function buildSegmentRefinePrompt(turns, localSegments) {
  const turnList = Array.isArray(turns) ? turns : []
  const segList = Array.isArray(localSegments) ? localSegments : []

  const system = [
    '你在帮助精化一个对话会话的「段（Segment）」划分。',
    '段是同一会话内、时间连续、围绕同一主题的一串轮次。',
    '你可以做的事：',
    '1. 修正每段的 title（简洁明确，4–24 字，概括核心主题）；',
    '2. 若相邻的两个或多个本地段其实在做同一件事，可以将它们合并为一个段（只允许沿本地段边界合并，不能留缺口、不能重叠、必须覆盖全部分段范围）；',
    '3. 精化每段的 kindCandidate：只能是 "work"（有明确工程/任务推进目标或代码/文档/命令产出）或 "chat"（日常闲聊、生活问答、无任务状态）；',
    '4. 为每段写一句不超过 60 字的 summary。',
    '只输出一个 JSON 数组，元素结构严格为：',
    '{"startTurn":0,"endTurn":2,"title":"段标题","kindCandidate":"work","summary":"一句话摘要"}',
    '不要输出任何解释文字。',
  ].join('\n')

  const segLines = segList.map((seg, i) => {
    const meta = [
      `轮次 ${seg.startTurn}–${seg.endTurn}`,
      `初判:${seg.kindCandidate}`,
    ]
    if (Array.isArray(seg.changedFiles) && seg.changedFiles.length > 0) {
      meta.push(`变更:${seg.changedFiles.slice(0, 4).join(',')}`)
    }
    if (Array.isArray(seg.commands) && seg.commands.length > 0) {
      meta.push(`命令:${seg.commands.length}条`)
    }
    if (Array.isArray(seg.errorTurns) && seg.errorTurns.length > 0) {
      meta.push(`异常轮:${seg.errorTurns.join(',')}`)
    }
    return `[段 ${i + 1}] (${meta.join(' | ')}) 标题：${seg.title}`
  })

  const turnLines = turnList.map(raw => {
    const t = normalizeTurn(raw)
    if (t === null) return ''
    const parts = [`【第 ${t.turn} 轮】提问：${clipText(t.prompt, REFINE_PROMPT_BUDGET)}`]
    if (t.response !== '') parts.push(`回复：${clipText(t.response, REFINE_REPLY_BUDGET)}`)
    const extras = []
    if (t.tools.length > 0) extras.push(`工具=${t.tools.slice(0, 5).join(',')}`)
    if (t.files.length > 0) extras.push(`文件=${t.files.slice(0, 4).join(',')}`)
    if (t.endReason !== 'completed') extras.push(`结束=${t.endReason}`)
    if (extras.length > 0) parts.push(`（${extras.join('；')}）`)
    return parts.join('\n')
  }).filter(Boolean)

  const user = [
    `当前本地切段（共 ${segList.length} 段）：`,
    segLines.join('\n'),
    '',
    `会话轮次摘录（共 ${turnLines.length} 轮）：`,
    turnLines.join('\n\n'),
    '',
    '请输出精化后的 JSON 数组。',
  ].join('\n')

  return { system, user }
}

function cloneSegment(seg) {
  return {
    ...seg,
    kindReasons: Array.isArray(seg.kindReasons) ? [...seg.kindReasons] : [],
    files: Array.isArray(seg.files) ? [...seg.files] : [],
    changedFiles: Array.isArray(seg.changedFiles) ? [...seg.changedFiles] : [],
    commands: Array.isArray(seg.commands) ? [...seg.commands] : [],
    errorTurns: Array.isArray(seg.errorTurns) ? [...seg.errorTurns] : [],
    quoteHandles: Array.isArray(seg.quoteHandles) ? [...seg.quoteHandles] : [],
  }
}

function cloneSegments(list) {
  return Array.isArray(list) ? list.map(cloneSegment) : []
}

/** 合并相邻本地段并套用模型精化后的标题、分类与摘要。 */
function mergeLocalSliceWithRefinement(slice, refined) {
  const first = slice[0]
  const last = slice[slice.length - 1]
  const sessionId = typeof first.sessionId === 'string' ? first.sessionId : ''
  const startTurn = first.startTurn
  const endTurn = last.endTurn

  let turnCount = 0
  let startTime = null
  let endTime = null
  let forkParent = null
  let confSum = 0

  const files = []
  const fileSeen = new Set()
  const changedFiles = []
  const changedSeen = new Set()
  const commands = []
  const cmdSeen = new Set()
  const errorSet = new Set()
  const quoteHandles = []
  const handleSeen = new Set()
  const reasons = []
  const reasonSeen = new Set()

  for (const seg of slice) {
    turnCount += Number.isFinite(seg.turnCount) ? seg.turnCount : 0
    if (validNumber(seg.startTime) !== null && (startTime === null || seg.startTime < startTime)) {
      startTime = seg.startTime
    }
    if (validNumber(seg.endTime) !== null && (endTime === null || seg.endTime > endTime)) {
      endTime = seg.endTime
    }
    if (forkParent === null && typeof seg.forkParent === 'string' && seg.forkParent !== '') {
      forkParent = seg.forkParent
    }
    confSum += Number.isFinite(seg.confidence) ? seg.confidence : 0.7

    for (const f of (Array.isArray(seg.files) ? seg.files : [])) pushUniquePath(files, fileSeen, f)
    for (const cf of (Array.isArray(seg.changedFiles) ? seg.changedFiles : [])) pushUniquePath(changedFiles, changedSeen, cf)
    for (const c of (Array.isArray(seg.commands) ? seg.commands : [])) pushUniqueString(commands, cmdSeen, c)
    for (const e of (Array.isArray(seg.errorTurns) ? seg.errorTurns : [])) {
      if (Number.isInteger(e)) errorSet.add(e)
    }
    for (const h of (Array.isArray(seg.quoteHandles) ? seg.quoteHandles : [])) pushUniqueString(quoteHandles, handleSeen, h)
    for (const r of (Array.isArray(seg.kindReasons) ? seg.kindReasons : [])) pushUniqueString(reasons, reasonSeen, r)
  }

  const kindRaw = typeof refined.kindCandidate === 'string' ? refined.kindCandidate.trim().toLowerCase() : ''
  const fallbackKind = slice.some(s => s.kindCandidate === 'work') ? 'work' : 'chat'
  const kindCandidate = kindRaw === 'work' || kindRaw === 'chat' ? kindRaw : fallbackKind
  pushUniqueString(reasons, reasonSeen, 'model-refined')

  const titleRaw = typeof refined.title === 'string' ? refined.title.replace(/\s+/g, ' ').trim() : ''
  const summaryRaw = typeof refined.summary === 'string' ? refined.summary.replace(/\s+/g, ' ').trim() : ''
  const title = titleRaw !== '' ? clipText(titleRaw, MAX_TITLE_CHARS) : first.title
  const summary = summaryRaw !== '' ? clipText(summaryRaw, MAX_SUMMARY_CHARS) : first.summary

  const avgConf = confSum / slice.length
  const confidence = Math.round(Math.min(0.99, Math.max(avgConf, 0.85)) * 100) / 100

  return {
    id: makeSegmentId(sessionId, startTurn, endTurn),
    sessionId,
    startTurn,
    endTurn,
    turnCount,
    startTime,
    endTime,
    title,
    summary,
    kindCandidate,
    kindReasons: reasons,
    files,
    changedFiles,
    commands,
    errorTurns: [...errorSet].sort((a, b) => a - b),
    quoteHandles,
    forkParent,
    confidence,
  }
}

/**
 * 解析模型精化输出并应用到本地段数组；任何格式损坏、越界、缺口或重叠均安全降级回本地结果。
 *
 * @param {string} text - 模型原始回复文本。
 * @param {Array<object>} localSegments - 本地切段结果。
 * @returns {Array<object>} 精化后的新段数组（或本地结果的深拷贝）。
 */
export function parseSegmentRefineResult(text, localSegments) {
  if (!Array.isArray(localSegments) || localSegments.length === 0) return []
  if (typeof text !== 'string' || text.trim() === '') return cloneSegments(localSegments)

  const parsed =
    extractJsonField(text, ['segments', 'result', 'items']) ??
    extractJsonArray(text)
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return cloneSegments(localSegments)
  }

  // 验证并按本地段边界严格对齐（支持合并相邻本地段，不允许缺口/重叠/越界）
  const out = []
  let cursor = 0

  for (const item of parsed) {
    if (!isPlainObject(item)) return cloneSegments(localSegments)
    const startTurn = Number(item.startTurn)
    const endTurn = Number(item.endTurn)
    if (!Number.isInteger(startTurn) || !Number.isInteger(endTurn) || startTurn > endTurn) {
      return cloneSegments(localSegments)
    }
    if (cursor >= localSegments.length) return cloneSegments(localSegments)
    if (localSegments[cursor].startTurn !== startTurn) {
      return cloneSegments(localSegments)
    }

    let endIdx = -1
    for (let j = cursor; j < localSegments.length; j += 1) {
      if (localSegments[j].endTurn === endTurn) {
        endIdx = j
        break
      }
      if (localSegments[j].endTurn > endTurn) break
    }
    if (endIdx < cursor) return cloneSegments(localSegments)

    const slice = localSegments.slice(cursor, endIdx + 1)
    out.push(mergeLocalSliceWithRefinement(slice, item))
    cursor = endIdx + 1
  }

  // 必须完整覆盖全部本地段
  if (cursor !== localSegments.length) {
    return cloneSegments(localSegments)
  }

  return out
}

// ── 历史轨「段 → 轮次」两级目录 ─────────────────────────────────────

function projectRailTurn(raw, segErrorSet) {
  const turn = Number(raw?.turn)
  if (!Number.isInteger(turn) || turn < 0) return null
  const promptHead =
    typeof raw.promptHead === 'string' && raw.promptHead.trim() !== ''
      ? outlinePromptHead(raw.promptHead)
      : outlinePromptHead(raw.prompt)
  const start = validNumber(raw.start) ?? validNumber(raw.startTime)
  const end = validNumber(raw.end) ?? validNumber(raw.endTime)
  const time = end ?? validNumber(raw.time) ?? start
  const endReason =
    typeof raw.endReason === 'string' && raw.endReason !== '' ? raw.endReason : 'completed'
  const endSeq = Number.isInteger(raw.endSeq) && raw.endSeq >= 0 ? raw.endSeq : null
  const hasError = isErrorTurn(raw) || segErrorSet.has(turn)

  return {
    turn,
    promptHead,
    time,
    start,
    endReason,
    endSeq,
    hasError,
  }
}

/**
 * 把「段」与轮次列表（支持 turn-index 完整行或 session-outline 轻量行）
 * 组装成历史轨「段 → 轮次」两级目录结构。
 *
 * @param {Array<object>} turns - 轮次数组或大纲行数组。
 * @param {Array<object>} segments - 段数组。
 * @returns {Array<object>} 两级目录数组，每项含段头元数据与 `turns` 子数组。
 */
export function toRailOutlineWithSegments(turns, segments) {
  const segList = Array.isArray(segments) ? segments : []
  if (segList.length === 0) return []

  const turnList = Array.isArray(turns) ? turns : []
  const validTurns = turnList
    .filter(row => isPlainObject(row) && Number.isInteger(Number(row.turn)) && Number(row.turn) >= 0)
    .sort((a, b) => Number(a.turn) - Number(b.turn))

  const out = []
  for (const seg of segList) {
    if (!isPlainObject(seg)) continue
    const startTurn = Number(seg.startTurn)
    const endTurn = Number(seg.endTurn)
    if (!Number.isInteger(startTurn) || !Number.isInteger(endTurn)) continue

    const segErrorSet = new Set(
      Array.isArray(seg.errorTurns) ? seg.errorTurns.filter(Number.isInteger) : [],
    )

    const matched = []
    for (const row of validTurns) {
      const t = Number(row.turn)
      if (t < startTurn || t > endTurn) continue
      const projected = projectRailTurn(row, segErrorSet)
      if (projected !== null) matched.push(projected)
    }

    const turnCount = matched.length > 0
      ? matched.length
      : (Number.isInteger(seg.turnCount) && seg.turnCount >= 0 ? seg.turnCount : 0)
    const hasError = segErrorSet.size > 0 || matched.some(item => item.hasError)
    const startTime =
      validNumber(seg.startTime) ??
      (matched.length > 0 ? (matched[0].start ?? matched[0].time) : null)
    const endTime =
      validNumber(seg.endTime) ??
      (matched.length > 0 ? (matched[matched.length - 1].time ?? matched[matched.length - 1].start) : null)

    out.push({
      id: typeof seg.id === 'string' && seg.id !== '' ? seg.id : makeSegmentId(seg.sessionId, startTurn, endTurn),
      title: typeof seg.title === 'string' ? seg.title : `第 ${startTurn}–${endTurn} 轮`,
      summary: typeof seg.summary === 'string' ? seg.summary : '',
      startTurn,
      endTurn,
      turnCount,
      startTime,
      endTime,
      kindCandidate: seg.kindCandidate === 'work' ? 'work' : 'chat',
      hasError,
      turns: matched,
    })
  }

  return out
}
