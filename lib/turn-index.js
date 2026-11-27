/**
 * 轮次索引：把一次会话的事件流折叠成"一轮一行"的事实层，落到 JSONL 文件。
 *
 * 为什么另起一份而不是复用 `turn-model` 的文本：那边按设计只留 80/160 字
 * 预览，索引要的是能检索的全文。这里只复用它的用量累加（`addUsage`）与
 * 事件折叠的判断口径（以 `turn/start` 为锚、系统注入不算提问、忽略未知
 * 事件），文本抽取独立、不截预览；单轮另有 32000 字符的硬上限，超限置
 * `truncated` 标志，防止一条超大消息把索引撑到不可用。
 *
 * 纯函数与 I/O 分开：`buildTurnRows` / `serializeIndex` / `parseIndexText` /
 * `parseMetaLine` 不碰文件，可以直接用事件数组测；`readIndexFile` /
 * `writeIndexFile` / `syncSessionIndex` 只负责 tmp+rename、revision 比对与
 * 损坏自愈。
 *
 * 文件布局（F-1/F-2）：
 *   ~/.dsh/topic-map/index/sessions/<sessionId>.jsonl
 *   首行 {kind:'meta', schema, revision, turnCount}，其后一行一轮。
 *
 * @module dsh-topic-map/turn-index
 */

import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { addUsage, emptyUsage } from './turn-model.js'

/**
 * 索引行的结构版本。
 *
 * 与 `ENGINE_VERSION` 解耦：索引行里的字段增删要自增这个数字，读到旧
 * schema 的文件一律重建，而不是猜字段。设计 §11。
 *
 * schema 2：轮次行新增 `commands`（从 tool/call 参数提取的命令文本）。
 * schema 3：`code` 参数不再整段当命令——`run_code` 里常包着一层
 *   `tools.ops_bash({command:"…"})`，要解包出真正的命令行；旧索引必须
 *   整体重建，否则会继续显示 JS 包装。
 * schema 4：轮次行新增 `endSeq`（该轮 `turn/end` 事件的 seq）。轮次一旦
 *   终结内容不再变化，摘要缓存用它做键；旧索引没有 `endSeq`，必须重建，
 *   否则摘要无法判断缓存是否仍然有效。
 * schema 5：轮次行的 `changes.files[]` 新增 `hash`（该轮变更后文件内容的
 *   sha256）与可选的 `hashSkipped`（missing / too-large / unreadable /
 *   limited）。hash 只在 F-7 落盘当时读取；旧索引（schema ≤4）整体重建时
 *   无法还原"变更刚发生时"的磁盘内容，重建出的历史轮次 hash 只能是 null
 *   （字段保留、无 hashSkipped），这是已知且可接受的历史局限——只有
 *   schema 5 之后新写入的轮次才保证有 hash。
 * schema 6：落地 ADR-0005「三元触发来源模型 + 异步续跑轮折叠」：
 *   - 新增 `trigger`（'human' | 'automated' | 'continuation' | 'unknown'）
 *     与可选 `foldedTurns`（被折叠吸收的原始续跑轮号数组）；
 *   - 紧随人类轮之后的异步续跑轮（subagent-settled / agent-message /
 *     team-message / goal / tool-jobs，及历史无 source 的空提问回调轮）
 *     折叠吸收回发起它的人类轮，去除中间纯进度心跳噪音并保留全部硬事实
 *     与最终收口结论；旧索引（schema ≤5）自动触发重建。
 */
export const INDEX_SCHEMA = 6

/** 人类发起触发源（一等逻辑轮次锚点，ADR-0005）。 */
export const HUMAN_SOURCE_KINDS = new Set(['user', 'retry'])

/** 异步续跑回调触发源（折叠吸收回前一个人类轮，ADR-0005）。 */
export const CONTINUATION_SOURCE_KINDS = new Set([
  'subagent-settled',
  'agent-message',
  'team-message',
  'goal',
  'tool-jobs',
])

/** 定时/系统自动化触发源（不折叠进人类轮，会话级由自动化边界排除，ADR-0005）。 */
export const AUTOMATED_SOURCE_KINDS = new Set(['schedule'])

/**
 * 单轮文本上限（`prompt` + `response` 合计字符数，F-1 的 32k）。
 *
 * 按"单轮"而不是"单字段"算：一行轮次的可检索文本总量是有界的，界面和
 * 体积预算才好估。超限时先保提问，剩下的额度给回答。
 */
export const MAX_TURN_TEXT = 32000

/** 单轮工具名上限（与 turn-model 同口径，避免后续按工具 join 时平方爆炸）。 */
const MAX_TOOLS = 16

/** 单轮文件清单上限（与 turn-model 同口径）。 */
const MAX_FILES = 24

/** 单轮命令条数上限（界面复制"命令块"用，不需要无限存）。 */
const MAX_COMMANDS = 8

/** 单条命令的字符上限（超长只截断，不加省略号）。 */
const MAX_COMMAND_CHARS = 500

/** 直接就是命令的参数键，按优先级排列（`code` 不再是命令本身，需解包）。 */
const COMMAND_KEYS = ['command', 'cmd', 'script']

/** 嵌套在 `arguments.args` 下的命令键（部分宿主会包一层）。 */
const NESTED_COMMAND_KEYS = ['command', 'cmd']

/** shell 类工具：`code`/`script` 本身就是命令，不需要解包 JS 包装。 */
const SHELL_TOOL_NAMES = new Set(['shell', 'bash', 'terminal', 'exec', 'powershell', 'cmd'])

/** 在 JS 包装里定位命令键：`command:` / `cmd:` / `"command":`。 */
const CODE_COMMAND_KEY_RE = /(?:\b(?:command|cmd)\s*:|["'](?:command|cmd)["']\s*:)\s*/g

/** tool/call 参数里被视为"文件"的键名（小写比较）。 */
const FILE_KEYS = new Set([
  'path',
  'file',
  'filepath',
  'file_path',
  'filename',
  'file_name',
  'files',
  'paths',
  'target',
  'target_file',
  'target_path',
  'old_path',
  'new_path',
  'notebook_path',
])

/**
 * 无 JSON 可解析时，从参数原文里兜底找绝对路径（与 turn-model 的
 * `PATH_RE` 同口径）。相对路径只能从键名里拿，不做全量正则猜。
 */
const ABS_PATH_RE = /(?:[A-Za-z]:[\\/]|\/)[\w.\-/\\]{2,}\.[A-Za-z0-9]{1,8}\b/g

// ── 文本抽取（纯函数） ──────────────────────────────────────────────

/**
 * 取一条消息里所有 `text` 块的全文。
 *
 * 工具调用、推理、图片块一律跳过；块与块之间用换行拼接，块内空白原样
 * 保留——索引要能"与日志原文一致"，不能像预览那样折叠空白。
 *
 * @param content - 消息的 content 块数组，可能缺失。
 * @returns 全文；没有可读文本时返回空串。
 */
export function messageText(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type !== 'text' || typeof block.text !== 'string') continue
    parts.push(block.text)
  }
  return parts.join('\n')
}

/**
 * 按单轮总预算截断提问与回答（纯函数）。
 *
 * 规则固定且可复现：先保提问；提问自己就超限时只留提问、回答置空；否则
 * 回答占用剩余额度。`truncated` 只在真的砍掉内容时为 true，恰好等于上限
 * 不算截断。截断不追加省略号：长度即预算，界面自己用标志位表达"还有"。
 *
 * 传 `keepTail: true` 时（折叠多轮异步续跑场景），回答超额优先保留末尾
 * 最终收口内容，避免早期过渡文本挤掉最终结论。
 *
 * @param prompt - 提问全文。
 * @param response - 回答全文。
 * @param limit - 单轮字符上限，默认 {@link MAX_TURN_TEXT}。
 * @param options - 可选 `{ keepTail?: boolean }`。
 * @returns `{prompt, response, truncated}`。
 */
export function capTurnText(prompt, response, limit = MAX_TURN_TEXT, options = {}) {
  const question = typeof prompt === 'string' ? prompt : ''
  const answer = typeof response === 'string' ? response : ''
  const budget = Number.isFinite(limit) && limit >= 0 ? limit : MAX_TURN_TEXT
  if (question.length + answer.length <= budget) {
    return { prompt: question, response: answer, truncated: false }
  }
  if (question.length >= budget) {
    return { prompt: question.slice(0, budget), response: '', truncated: true }
  }
  const remain = budget - question.length
  const keepTail = options && options.keepTail === true
  return {
    prompt: question,
    response: keepTail ? answer.slice(answer.length - remain) : answer.slice(0, remain),
    truncated: true,
  }
}

/**
 * 按 ADR-0005 三元模型判定单轮的触发来源。
 *
 * 优先级：
 *   1. 含 `user` 或 `retry` → `'human'`；
 *   2. 否则含 `schedule` → `'automated'`；
 *   3. 否则含五类异步续跑源之一 → `'continuation'`；
 *   4. 否则（无有效唤醒源，如仅 system 注入或历史缺 source）：若调用方告知
 *      紧跟在人类轮后（`options.hasPrecedingHuman === true`）→ `'continuation'`，
 *      否则 → `'unknown'`。
 *
 * @param sourceKinds - 单轮内收集到的 `user/message.data.source.kind` 集合或数组。
 * @param options - 可选 `{ hasPrecedingHuman?: boolean }`。
 * @returns `'human' | 'automated' | 'continuation' | 'unknown'`。
 */
export function classifyTurnTrigger(sourceKinds, options = {}) {
  let hasHuman = false
  let hasAutomated = false
  let hasContinuation = false

  if (sourceKinds && typeof sourceKinds[Symbol.iterator] === 'function' && typeof sourceKinds !== 'string') {
    for (const raw of sourceKinds) {
      if (typeof raw !== 'string' || raw === '') continue
      if (HUMAN_SOURCE_KINDS.has(raw)) hasHuman = true
      else if (AUTOMATED_SOURCE_KINDS.has(raw)) hasAutomated = true
      else if (CONTINUATION_SOURCE_KINDS.has(raw)) hasContinuation = true
    }
  } else if (typeof sourceKinds === 'string' && sourceKinds !== '') {
    if (HUMAN_SOURCE_KINDS.has(sourceKinds)) hasHuman = true
    else if (AUTOMATED_SOURCE_KINDS.has(sourceKinds)) hasAutomated = true
    else if (CONTINUATION_SOURCE_KINDS.has(sourceKinds)) hasContinuation = true
  }

  if (hasHuman) return 'human'
  if (hasAutomated) return 'automated'
  if (hasContinuation) return 'continuation'
  if (options && options.hasPrecedingHuman === true) return 'continuation'
  return 'unknown'
}

/**
 * 合并两份轮次 `changes` 对象（纯函数，供折叠轮与 `attachWorkspaceChanges` 复用）。
 *
 * 规则：
 *   - 任一方为 null/undefined 时返回另一方的规范浅拷贝；均为空返回 null；
 *   - 一方 `lost:true` 而另一方有明细（`lost !== true`）时保留有效明细（`lost:false`）；
 *   - 双方均为 `lost:true` 时保留 `lost:true`；
 *   - 双方均有效时按文件路径（NTFS 口径大小写/斜杠不敏感）去重，同路径以
 *     `nextChanges` 的 `path/added/deleted/hash/hashSkipped` 为准（最新快照），
 *     重新汇总 `total / added / deleted`。
 *
 * @param baseChanges - 较早轮次的 changes 对象。
 * @param nextChanges - 较晚轮次的 changes 对象。
 * @returns 合并后的新 changes 对象，或 null。
 */
export function mergeChangesList(baseChanges, nextChanges) {
  const base = normalizeChangesObject(baseChanges)
  const next = normalizeChangesObject(nextChanges)
  if (base === null && next === null) return null
  if (base === null) return next
  if (next === null) return base
  if (base.lost && next.lost) {
    return { files: [], total: 0, added: 0, deleted: 0, lost: true }
  }
  if (base.lost) return next
  if (next.lost) return base

  const byKey = new Map()
  const order = []
  for (const source of [base, next]) {
    for (const file of source.files) {
      const key = changePathKey(file.path)
      if (!byKey.has(key)) order.push(key)
      byKey.set(key, cloneChangeFile(file))
    }
  }

  const files = order.map(key => byKey.get(key))
  let added = 0
  let deleted = 0
  for (const file of files) {
    added += file.added
    deleted += file.deleted
  }
  return {
    files,
    total: files.length,
    added,
    deleted,
    lost: false,
  }
}

function changePathKey(path) {
  return String(path).trim().replace(/\\/g, '/').toLowerCase()
}

function nonNegativeInt(value, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

function cloneChangeFile(raw) {
  const entry = {
    path: String(raw.path),
    added: nonNegativeInt(raw.added),
    deleted: nonNegativeInt(raw.deleted),
  }
  if ('hash' in raw) entry.hash = raw.hash ?? null
  if (typeof raw.hashSkipped === 'string' && raw.hashSkipped !== '') {
    entry.hashSkipped = raw.hashSkipped
  }
  return entry
}

function normalizeChangesObject(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (raw.lost === true) {
    return { files: [], total: 0, added: 0, deleted: 0, lost: true }
  }
  const files = []
  if (Array.isArray(raw.files)) {
    for (const item of raw.files) {
      if (!item || typeof item !== 'object') continue
      if (typeof item.path !== 'string' || item.path === '') continue
      files.push(cloneChangeFile(item))
    }
  }
  const addedSum = files.reduce((sum, item) => sum + item.added, 0)
  const deletedSum = files.reduce((sum, item) => sum + item.deleted, 0)
  return {
    files,
    total: files.length > 0 ? files.length : nonNegativeInt(raw.total, 0),
    added: files.length > 0 ? addedSum : nonNegativeInt(raw.added, 0),
    deleted: files.length > 0 ? deletedSum : nonNegativeInt(raw.deleted, 0),
    lost: false,
  }
}

// ── 事件折叠（纯函数） ──────────────────────────────────────────────

/** 一条新轮次行，键序即落盘键序（重建必须逐字节可复现）。 */
function newRow(turn, seq, time) {
  return {
    turn,
    seq,
    start: typeof time === 'number' ? time : null,
    end: null,
    // 该轮 `turn/end` 事件的 seq。null 表示仍在进行中；摘要缓存只对已终结
    // 的轮次生效（轮次内容在 turn/end 后不再变化）。
    endSeq: null,
    ms: null,
    prompt: '',
    response: '',
    tools: [],
    files: [],
    commands: [],
    usage: emptyUsage(),
    model: null,
    endReason: 'open',
    interrupted: false,
    steps: 0,
    truncated: false,
    trigger: 'unknown',
  }
}

/**
 * 判断一条续跑中间回复是否属于纯进度心跳过渡句（无实质交付结论）。
 *
 * 仅对非最后一个续跑轮起去噪作用：最后一个续跑轮作为最终收口永远保留。
 */
const HEARTBEAT_RESPONSE_RE = /^(?:进度(?:同步|更新|汇报)|状态(?:同步|更新)|阶段(?:同步|汇报)|progress(?:\s+update)?|status(?:\s+update)?)\s*[:：]|(?:^\s*(?:收到|已收到|继续|等待|尚有|还有|目前|当前).{0,60}(?:完成|执行中|运行中|处理中|推进中|等待|继续))/i
const HEARTBEAT_RATIO_RE = /\b\d+\s*\/\s*\d+\b/

function isPureHeartbeatResponse(text) {
  const trimmed = typeof text === 'string' ? text.trim() : ''
  if (trimmed === '') return true
  if (trimmed.length > 240) return false
  if (HEARTBEAT_RESPONSE_RE.test(trimmed)) return true
  if (trimmed.length <= 100 && HEARTBEAT_RATIO_RE.test(trimmed) && /(?:完成|进行中|继续|等待|子代理|任务|done|complete|pending)/i.test(trimmed)) {
    return true
  }
  return false
}

/** 把用量对象累加到目标（两个均是 normalized usage 形状）。 */
function mergeUsage(target, extra) {
  if (!target || !extra) return
  target.input += nonNegativeInt(extra.input)
  target.output += nonNegativeInt(extra.output)
  target.cacheRead += nonNegativeInt(extra.cacheRead)
  target.cacheWrite += nonNegativeInt(extra.cacheWrite)
  target.reasoning += nonNegativeInt(extra.reasoning)
}

/**
 * 把一个或多个异步续跑子轮折叠吸收进目标宿主轮（原地修改 host）。
 *
 * 宿主轮保留定位锚点（turn / seq / start / prompt / trigger），吸收子轮的
 * 终结边界（end / endSeq / ms / endReason / interrupted）、用量、步数、
 * 工具/文件/命令、以及去心跳噪音后的回复文本，并在 host.foldedTurns 记录
 * 被吸收的原始轮号供 workspace/changes 跨轮归并。
 */
function foldChildrenIntoHost(host, children) {
  if (!Array.isArray(children) || children.length === 0) return

  const foldedTurns = []
  const responseParts = []
  if (host.response !== '') responseParts.push(host.response)

  for (let index = 0; index < children.length; index += 1) {
    const child = children[index]
    const isLast = index === children.length - 1
    foldedTurns.push(child.turn)

    if (typeof child.end === 'number') {
      host.end = child.end
      if (typeof host.start === 'number') {
        host.ms = Math.max(0, child.end - host.start)
      }
    }
    if (child.endSeq !== null) host.endSeq = child.endSeq
    host.endReason = child.endReason
    if (child.interrupted === true) host.interrupted = true
    if (host.model === null && child.model !== null) host.model = child.model

    mergeUsage(host.usage, child.usage)
    host.steps += child.steps

    for (const tool of child.tools) {
      if (host.tools.length >= MAX_TOOLS) break
      pushUnique(host.tools, tool)
    }
    for (const file of child.files) {
      if (host.files.length >= MAX_FILES) break
      pushFile(host.files, file)
    }
    for (const command of child.commands) {
      if (host.commands.length >= MAX_COMMANDS) break
      pushCommand(host.commands, command)
    }

    if (child.response !== '') {
      // 最终收口轮永远保留；中间轮跳过明显纯进度心跳过渡句。
      if (isLast || !isPureHeartbeatResponse(child.response)) {
        responseParts.push(child.response)
      }
    }
  }

  host.response = responseParts.join('\n\n')
  host.foldedTurns = foldedTurns
}

/**
 * 把会话事件流折叠成一轮一条的索引行（全文，含 ADR-0005 续跑折叠）。
 *
 * 事件必须按 seq 升序（宿主 `listEvents` 的保证）。两阶段折叠：
 *   1. 按 `turn/start` 聚合每条原始轮次，记录该轮见过的 `user/message.source.kind`
 *      集合；人类输入认 `HUMAN_SOURCE_KINDS`（`user` / `retry`）；
 *   2. 依据 `classifyTurnTrigger` 把异步续跑轮（显式 `CONTINUATION_SOURCE_KINDS`，
 *      或紧跟在带提问的人类轮之后、无人类输入且非 `schedule` 的历史空提问回调轮）
 *      折叠吸收进前一个保留轮，并在宿主行记录 `foldedTurns`。
 *
 * 向后兼容：若整场合成测试夹具完全没有 `user/message`（前轮 `prompt === ''`），
 * 不会误将轮次全部折叠消失。
 *
 * @param events - 宿主的原始会话事件数组。
 * @returns 轮次行数组（键序固定，可直接序列化）。
 */
export function buildTurnRows(events) {
  const rawEntries = []
  let curEntry = null

  for (const ev of Array.isArray(events) ? events : []) {
    if (!ev || typeof ev !== 'object') continue
    const data = ev.data && typeof ev.data === 'object' ? ev.data : {}

    switch (ev.type) {
      case 'turn/start': {
        const turn = Number(data.turn)
        if (!Number.isFinite(turn) || turn < 0) break
        // 重试边界的 turn/start 不前进时保留已有记录，轮次号保持严格递增。
        if (curEntry !== null && turn <= curEntry.row.turn) {
          curEntry = rawEntries[rawEntries.length - 1] ?? null
          break
        }
        curEntry = { row: newRow(turn, ev.seq, ev.time), sourceKinds: new Set() }
        rawEntries.push(curEntry)
        break
      }

      case 'turn/end': {
        const turn = Number(data.turn)
        if (curEntry === null || (Number.isFinite(turn) && turn !== curEntry.row.turn)) break
        const row = curEntry.row
        row.end = typeof ev.time === 'number' ? ev.time : null
        row.endSeq = typeof ev.seq === 'number' && Number.isFinite(ev.seq) ? ev.seq : null
        row.ms = typeof ev.time === 'number' && typeof row.start === 'number'
          ? Math.max(0, ev.time - row.start)
          : null
        row.endReason = endReasonOf(data.reason)
        break
      }

      case 'user/message': {
        if (curEntry === null) break
        const source = data.source
        const kind = source && typeof source.kind === 'string' ? source.kind : ''
        if (kind !== '') curEntry.sourceKinds.add(kind)
        // 系统提示注入与回调通知也走 user/message，只有人类发起源才进 prompt。
        if (!HUMAN_SOURCE_KINDS.has(kind)) break
        const text = messageText(data.content)
        if (text === '') break
        // 同轮多句人类输入（steering）也属于这一轮的提问上下文。
        const row = curEntry.row
        row.prompt = row.prompt === '' ? text : `${row.prompt}\n\n${text}`
        break
      }

      case 'assistant/message': {
        if (curEntry === null) break
        const row = curEntry.row
        addUsage(row.usage, data.usage)
        if (data.interrupted === true) row.interrupted = true
        const text = messageText(data.message?.content)
        if (text !== '') {
          row.response = row.response === '' ? text : `${row.response}\n\n${text}`
        }
        if (row.model === null) {
          const source = data.message?.source
          if (source && source.kind === 'model' && typeof source.model === 'string' && source.model !== '') {
            row.model = source.model
          }
        }
        break
      }

      case 'step/start': {
        if (curEntry !== null) curEntry.row.steps += 1
        break
      }

      case 'tool/call': {
        if (curEntry === null) break
        const row = curEntry.row
        pushUnique(row.tools, data.name)
        for (const path of filesOf(data.arguments)) pushFile(row.files, path)
        pushCommand(row.commands, commandOf(data.arguments, data.name))
        break
      }

      default:
        break
    }

    // 与预览模型同口径：单轮实体列表有界，一次批量编辑可能提上千个路径。
    if (curEntry !== null) {
      const row = curEntry.row
      if (row.tools.length > MAX_TOOLS) row.tools.length = MAX_TOOLS
      if (row.files.length > MAX_FILES) row.files.length = MAX_FILES
      if (row.commands.length > MAX_COMMANDS) row.commands.length = MAX_COMMANDS
    }
  }

  // 阶段二：按 ADR-0005 判定触发来源并折叠异步续跑轮。
  const groups = []
  for (const entry of rawEntries) {
    const baseTrigger = classifyTurnTrigger(entry.sourceKinds)
    const prevGroup = groups[groups.length - 1] ?? null

    if (baseTrigger === 'continuation') {
      if (prevGroup !== null) {
        prevGroup.children.push(entry.row)
        continue
      }
      entry.row.trigger = 'continuation'
      groups.push({ host: entry.row, children: [] })
      continue
    }

    // 历史日志兼容：紧跟在带人类提问的 human 轮之后、无人类输入且非 schedule 的空提问回调轮。
    if (
      baseTrigger === 'unknown' &&
      entry.row.prompt === '' &&
      prevGroup !== null &&
      prevGroup.host.trigger === 'human' &&
      prevGroup.host.prompt !== ''
    ) {
      prevGroup.children.push(entry.row)
      continue
    }

    entry.row.trigger = baseTrigger
    groups.push({ host: entry.row, children: [] })
  }

  const rows = []
  for (const group of groups) {
    const { host, children } = group
    const folded = children.length > 0
    if (folded) foldChildrenIntoHost(host, children)

    // 文本截断放在折叠之后：只有整轮拼完才知道总长度；
    // 折叠多轮超 32k 时优先保留末尾收口结论。
    const capped = capTurnText(host.prompt, host.response, MAX_TURN_TEXT, { keepTail: folded })
    host.prompt = capped.prompt
    host.response = capped.response
    host.truncated = capped.truncated
    rows.push(host)
  }

  return rows
}

/** 把 `turn/end` 的 reason 映射成扁平判别值（与 turn-model 同表）。 */
function endReasonOf(reason) {
  if (!reason || typeof reason !== 'object') return 'completed'
  const kind = reason.kind
  if (
    kind === 'completed' ||
    kind === 'aborted' ||
    kind === 'blocked' ||
    kind === 'error' ||
    kind === 'max-tokens' ||
    kind === 'interrupted' ||
    kind === 'forked'
  ) {
    return kind
  }
  return 'completed'
}

function pushUnique(list, value) {
  if (typeof value !== 'string' || value === '') return
  if (!list.includes(value)) list.push(value)
}

/** shell 类工具名（大小写不敏感；也认 `run_shell` / `shell_exec` 这类分词）。 */
function isShellToolName(name) {
  if (typeof name !== 'string') return false
  const lower = name.trim().toLowerCase()
  if (SHELL_TOOL_NAMES.has(lower)) return true
  return lower.split(/[^a-z]+/).some(token => SHELL_TOOL_NAMES.has(token))
}

/**
 * 解析 JS 源码里紧随的一个字符串字面量。
 *
 * 支持双引号、单引号、反引号；把 `\n` 等转义还原成真实字符（命令里的
 * 换行要保留，界面按 nowrap 展示）。普通引号里出现裸换行、或直到结尾
 * 都没有闭合引号时返回 null。
 *
 * @param text - JS 源码片段。
 * @param start - 引号所在下标。
 * @returns 字符串内容，或 null。
 */
function parseStringLiteralAt(text, start) {
  const quote = text[start]
  if (quote !== '"' && quote !== "'" && quote !== '`') return null
  let out = ''
  for (let index = start + 1; index < text.length; index += 1) {
    const ch = text[index]
    if (ch === '\\') {
      const next = text[index + 1]
      if (next === undefined) return null
      // 行继续：反斜杠 + 换行不产生字符。
      if (next === '\n') {
        index += 1
        continue
      }
      if (next === '\r') {
        index += text[index + 2] === '\n' ? 2 : 1
        continue
      }
      const simple = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' }[next]
      if (simple !== undefined) {
        out += simple
        index += 1
        continue
      }
      if (next === 'x') {
        const hex = text.slice(index + 2, index + 4)
        if (/^[0-9a-fA-F]{2}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16))
          index += 3
          continue
        }
      }
      if (next === 'u') {
        const hex = text.slice(index + 2, index + 6)
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16))
          index += 5
          continue
        }
      }
      // 未知转义：JS 语义是丢掉反斜杠（如 \" \' \\ \`）。
      out += next
      index += 1
      continue
    }
    if (ch === quote) return out
    // JS 的普通字符串字面量里不能有裸换行；反引号可以。
    if (quote !== '`' && (ch === '\n' || ch === '\r')) return null
    out += ch
  }
  return null
}

/**
 * 从 `run_code` 之类的 JS 包装里解包真正的命令行。
 *
 * 找 `command:` / `cmd:` / `"command":` 之后第一个能解析的字符串字面量；
 * 一个都解析不出来就返回空——**绝不回退成整段 JS**。只取第一条（一次
 * tool/call 对应一条命令）。
 *
 * @param code - `code` 参数原文。
 * @returns 命令文本（已截到 500 字），或空串。
 */
function unwrapCommandFromCode(code) {
  CODE_COMMAND_KEY_RE.lastIndex = 0
  let match
  while ((match = CODE_COMMAND_KEY_RE.exec(code)) !== null) {
    const at = match.index + match[0].length
    const literal = parseStringLiteralAt(code, at)
    if (literal !== null && literal.trim() !== '') return literal.slice(0, MAX_COMMAND_CHARS)
  }
  return ''
}

/**
 * 从 tool/call 参数里取命令文本。
 *
 * 顺序：
 *   1. 参数对象直接有 `command` / `cmd` / `script` → 就是命令；
 *   2. 嵌套 `args.command` / `args.cmd`（部分宿主会包一层）；
 *   3. `code`：shell 类工具直接当命令；其它工具（如 `run_code`）解包
 *      JS 包装里的 `command:"…"`，解不出就空，不把整段代码当命令。
 *
 * @param args - 原始参数（JSON 字符串或已解析对象）。
 * @param toolName - tool/call 的工具名（判断 shell 类工具用）。
 * @returns 命令文本（已截到 500 字），或空串。
 */
function commandOf(args, toolName) {
  if (args === null || args === undefined) return ''
  let parsed = args
  if (typeof args === 'string') {
    try {
      parsed = JSON.parse(args)
    } catch {
      return ''
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return ''
  for (const key of COMMAND_KEYS) {
    const value = parsed[key]
    if (typeof value === 'string' && value.trim() !== '') {
      return value.slice(0, MAX_COMMAND_CHARS)
    }
  }
  const nested = parsed.args
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    for (const key of NESTED_COMMAND_KEYS) {
      const value = nested[key]
      if (typeof value === 'string' && value.trim() !== '') {
        return value.slice(0, MAX_COMMAND_CHARS)
      }
    }
  }
  const code = typeof parsed.code === 'string' ? parsed.code : ''
  if (code.trim() === '') return ''
  if (isShellToolName(toolName)) return code.slice(0, MAX_COMMAND_CHARS)
  return unwrapCommandFromCode(code)
}

/** 追加命令：按出现顺序去重、每轮封顶 8 条。 */
function pushCommand(list, command) {
  if (command === '' || list.length >= MAX_COMMANDS) return
  if (!list.includes(command)) list.push(command)
}

/** 提取 tool/call 参数里的文件路径；解析不了 JSON 时退回绝对路径正则。 */
function filesOf(args) {
  if (args === null || args === undefined) return []
  let parsed = args
  if (typeof args === 'string') {
    try {
      parsed = JSON.parse(args)
    } catch {
      return pathsFromText(args)
    }
  }
  const out = []
  collectFileValues(parsed, out, 0)
  return out
}

/** 递归收集已知键名下的路径值，最多两层（args → 数组 → 对象）。 */
function collectFileValues(value, out, depth) {
  if (depth > 2 || value === null || value === undefined) return
  if (typeof value === 'string') {
    if (looksLikePath(value)) pushFile(out, value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectFileValues(item, out, depth + 1)
    return
  }
  if (typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    if (FILE_KEYS.has(key.toLowerCase())) collectFileValues(child, out, depth + 1)
  }
}

/** 参数原文兜底：只认绝对路径，相对路径不猜（避免把散文里的词当文件）。 */
function pathsFromText(text) {
  const out = []
  const found = text.match(ABS_PATH_RE)
  if (found === null) return out
  for (const raw of found) pushFile(out, raw.replace(/\\{2,}/g, '\\'))
  return out
}

/** 像不像一个文件路径：URL、带换行的散文、纯单词都不算。 */
function looksLikePath(value) {
  const text = String(value).trim()
  if (text === '' || text.length > 512) return false
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return false
  if (/[\r\n\t]/.test(text)) return false
  if (/^[A-Za-z]:[\\/]/.test(text) || /^[\\/]/.test(text)) return true
  if (/[\\/]/.test(text)) return true
  return /\.[A-Za-z0-9]{1,8}$/.test(text)
}

/** 去重（NTFS 口径大小写不敏感）并封顶。 */
function pushFile(list, value) {
  if (list.length >= MAX_FILES) return
  const text = String(value).trim()
  if (!looksLikePath(text)) return
  const key = text.replace(/\\/g, '/').toLowerCase()
  for (const existing of list) {
    if (existing.replace(/\\/g, '/').toLowerCase() === key) return
  }
  list.push(text)
}

// ── JSONL 序列化 / 反序列化（纯函数） ──────────────────────────────

/**
 * 构造首行 meta。
 *
 * @param revision - 会话日志的 revision，作为增量比对的键。
 * @param turnCount - 轮次行数。
 * @returns meta 对象（键序固定）。
 */
export function makeMeta(revision, turnCount) {
  return {
    kind: 'meta',
    schema: INDEX_SCHEMA,
    revision: String(revision ?? ''),
    turnCount: Number.isFinite(turnCount) ? turnCount : 0,
  }
}

/**
 * 序列化整个索引文件：首行 meta，其后一行一轮，行尾换行。
 *
 * 纯函数，产出可复现——同样的输入两次调用必须得到逐字节相同的结果，
 * 这是 F-3 "重建与增量等价" 的前提。
 *
 * @param options - `{revision, turns}`。
 * @returns JSONL 文本。
 */
export function serializeIndex({ revision, turns } = {}) {
  const rows = Array.isArray(turns) ? turns : []
  const lines = [JSON.stringify(makeMeta(revision, rows.length))]
  for (const row of rows) lines.push(JSON.stringify(row))
  return `${lines.join('\n')}\n`
}

/**
 * 解析首行 meta。
 *
 * schema 不认识、形状不对、revision 缺失都算坏行——返回 null 让调用方
 * 走重建，不做兼容猜测。
 *
 * @param line - 一行文本。
 * @returns meta 对象，或 null。
 */
export function parseMetaLine(line) {
  if (typeof line !== 'string') return null
  const text = line.trim()
  if (text === '') return null
  let value
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  if (value.kind !== 'meta' || value.schema !== INDEX_SCHEMA) return null
  const turnCount = Number(value.turnCount)
  if (!Number.isFinite(turnCount) || turnCount < 0) return null
  return {
    kind: 'meta',
    schema: INDEX_SCHEMA,
    revision: String(value.revision ?? ''),
    turnCount,
  }
}

/**
 * 反序列化索引文件，并做结构校验。
 *
 * 校验项：首行 meta、每行是可解析的轮次行、`turn` 与 `seq` 严格递增、
 * 行数与 `turnCount` 一致。任何一项不满足都返回 `ok:false` 和具体原因，
 * 调用方据此整体重建——不修补半截文件。
 *
 * @param text - JSONL 全文。
 * @returns `{ok:true, meta, turns}` 或 `{ok:false, reason, meta, turns:[]}`。
 */
export function parseIndexText(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    return { ok: false, reason: 'empty', meta: null, turns: [] }
  }
  const lines = text.split(/\r?\n/)
  const meta = parseMetaLine(lines[0])
  if (meta === null) return { ok: false, reason: 'meta', meta: null, turns: [] }

  const turns = []
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() === '') continue
    let row
    try {
      row = JSON.parse(line)
    } catch {
      return { ok: false, reason: 'json', line: index, meta, turns: [] }
    }
    if (!isTurnRow(row)) {
      return { ok: false, reason: 'row', line: index, meta, turns: [] }
    }
    const previous = turns[turns.length - 1]
    if (previous !== undefined && (row.turn <= previous.turn || row.seq <= previous.seq)) {
      return { ok: false, reason: 'order', line: index, meta, turns: [] }
    }
    turns.push(row)
  }

  if (turns.length !== meta.turnCount) {
    return { ok: false, reason: 'turn-count', meta, turns: [] }
  }
  return { ok: true, meta, turns }
}

/** 一行轮次最小的可检索形状。字段以后可加，但 turn/seq/文本不能缺。 */
function isTurnRow(row) {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return false
  if (typeof row.turn !== 'number' || !Number.isFinite(row.turn)) return false
  if (typeof row.seq !== 'number' || !Number.isFinite(row.seq)) return false
  if (typeof row.prompt !== 'string' || typeof row.response !== 'string') return false
  if (row.endSeq !== null && (typeof row.endSeq !== 'number' || !Number.isFinite(row.endSeq))) return false
  return true
}

// ── 路径（纯函数） ──────────────────────────────────────────────────

/**
 * DSH home。
 *
 * 与 `lib/index.js` 的 `dshHome` 同口径：DSH_HOME → USERPROFILE → HOME。
 * 索引是独立模块，先自己解析；等 Host 接线时可以改成注入。
 *
 * @returns 绝对路径，或 ''（无法确定）。
 */
function dshHome() {
  if (process.env.DSH_HOME) return process.env.DSH_HOME
  if (process.env.USERPROFILE) return join(process.env.USERPROFILE, '.dsh')
  if (process.env.HOME) return join(process.env.HOME, '.dsh')
  return ''
}

/**
 * 默认索引目录：`<DSH_HOME>/topic-map/index/sessions`。
 *
 * @returns 绝对路径，或 ''（无法确定 home）。
 */
export function defaultSessionsDir() {
  const home = dshHome()
  return home === '' ? '' : join(home, 'topic-map', 'index', 'sessions')
}

/**
 * 单个会话的索引文件路径。
 *
 * sessionId 里的路径分隔符与控制字符会被替换成下划线，防止会话 id 把
 * 写入带出索引目录。
 *
 * @param dir - 索引目录。
 * @param sessionId - 宿主的会话 id。
 * @returns 绝对路径。
 * @throws 目录为空或 sessionId 无效时抛错。
 */
export function indexFilePath(dir, sessionId) {
  if (typeof dir !== 'string' || dir === '') throw new Error('索引目录为空')
  const stem = sessionFileStem(sessionId)
  return join(dir, `${stem}.jsonl`)
}

function sessionFileStem(sessionId) {
  const raw = String(sessionId ?? '').trim()
  const safe = raw.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
  if (safe === '' || safe === '.' || safe === '..') {
    throw new Error(`无效的 sessionId：${raw}`)
  }
  return safe
}

// ── 文件读写（薄包装） ──────────────────────────────────────────────

/**
 * 读取并校验一个会话的索引文件。
 *
 * 只读，不会重建；`ok:false` 时带上原因（missing / unreadable / meta /
 * json / row / order / turn-count / empty），调用方决定下一步。
 *
 * @param dir - 索引目录。
 * @param sessionId - 会话 id。
 * @returns `{ok, reason?, path, meta, turns}`。
 */
export async function readIndexFile(dir, sessionId) {
  const path = indexFilePath(dir, sessionId)
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    const reason = error && error.code === 'ENOENT' ? 'missing' : 'unreadable'
    return { ok: false, reason, path, meta: null, turns: [] }
  }
  const parsed = parseIndexText(text)
  return { ...parsed, path }
}

/**
 * 只读首行 meta，不解析其后轮次（/session 快速守卫用）。
 *
 * 打开会话时先在几百字节里判断 `revision` 是否一致：一致就不必把整份
 * 索引（可能几十 MB）读进内存。文件缺失、首行不完整、不是合法 meta 都
 * 返回 null，调用方按"需要同步"处理。
 *
 * @param dir - 索引目录。
 * @param sessionId - 会话 id。
 * @returns meta 对象，或 null。
 */
export async function readIndexMeta(dir, sessionId) {
  const path = indexFilePath(dir, sessionId)
  let handle
  try {
    handle = await open(path, 'r')
    const chunks = []
    let position = 0
    const buffer = Buffer.alloc(4096)
    // meta 行是定长小对象；最多读 64KB，超过还没换行只可能是文件坏了。
    while (position < 64 * 1024) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
      if (bytesRead === 0) break
      const piece = buffer.subarray(0, bytesRead)
      const newline = piece.indexOf(0x0a)
      if (newline !== -1) {
        chunks.push(piece.subarray(0, newline))
        return parseMetaLine(Buffer.concat(chunks).toString('utf8'))
      }
      // Buffer 会被下一次 read 覆盖，这里必须复制。
      chunks.push(Buffer.from(piece))
      position += bytesRead
    }
    if (chunks.length === 0) return null
    // 没有换行：文件可能只有 meta 一行（末尾无换行）。
    return parseMetaLine(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return null
  } finally {
    if (handle !== undefined) {
      try {
        await handle.close()
      } catch {
        // 关不上不影响已经读到的结果。
      }
    }
  }
}

/**
 * 原子写一个会话的索引文件：先写 `<file>.tmp`，再 rename 覆盖。
 *
 * rename 在 NTFS 上是替换语义；写失败时清掉 tmp，避免半个文件被下次
 * 读取当成有效索引。
 *
 * @param dir - 索引目录。
 * @param sessionId - 会话 id。
 * @param text - `serializeIndex` 的产物。
 * @returns 落盘路径。
 */
export async function writeIndexFile(dir, sessionId, text) {
  const path = indexFilePath(dir, sessionId)
  const tmp = `${path}.tmp`
  await mkdir(dirname(path), { recursive: true })
  try {
    await writeFile(tmp, text, 'utf8')
    await rename(tmp, path)
  } catch (error) {
    try {
      await unlink(tmp)
    } catch {
      // tmp 可能根本没写出来；原错误更重要。
    }
    throw error
  }
  return path
}

/**
 * 删除一个会话的索引文件。
 *
 * @param dir - 索引目录。
 * @param sessionId - 会话 id。
 * @returns 删掉了返回 true，本来就不存在返回 false。
 */
export async function removeIndexFile(dir, sessionId) {
  try {
    await unlink(indexFilePath(dir, sessionId))
    return true
  } catch (error) {
    if (error && error.code === 'ENOENT') return false
    throw error
  }
}

// ── 增量同步 ────────────────────────────────────────────────────────

/**
 * 增量同步一个会话的索引。
 *
 * 流程（F-2/F-3/F-6）：
 *   1. 读现有索引并做结构校验；
 *   2. `revision` 与首行 meta 一致且文件完好 → `{skipped:true}`，**不读事件流**；
 *   3. 否则读事件流、整文件重建（tmp + rename），重建路径不做任何增量猜测。
 *
 * 同 revision 也做结构校验（代价是一次索引文件解析）：这样被截断、被手改
 * 坏的文件不必等到下一次会话变动才自愈；F-2 的验收口径是"不读事件流"，
 * 这一步不违反。
 *
 * @param options - `{dir, sessionId, revision, loadEvents, enrich}`。
 *   `dir` 缺省走 {@link defaultSessionsDir}；`loadEvents` 是返回事件数组
 *   的函数（可为 async），只有需要重建时才调用。
 *   `enrich` 是可选的异步钩子，在序列化前调用一次，参数为
 *   `{turns, events, previous, sessionId, revision, legacy}`——用于补依赖
 *   Host context 的字段（F-7 的 `changes`）；不传就完全不做额外 I/O，纯函数
 *   边界不变。`legacy:true` 表示这次重建是在修复一份**已存在但结构过旧/损坏**
 *   的索引，调用方不应把"当前磁盘内容"当成当时变更的快照去补 hash；首次
 *   建索引（文件缺失）时 `legacy` 为 false。
 * @returns `{skipped, reason?, path, meta, turns}`。
 *   `reason`：`revision` 表示版本变了；其余为文件状态
 *   （missing / unreadable / meta / json / row / order / turn-count / empty）。
 * @throws revision 缺失、无法确定索引目录、重建时缺 `loadEvents`、
 *   `loadEvents`/`enrich` 本身抛错时抛出。
 */
export async function syncSessionIndex(options = {}) {
  const { sessionId, revision, loadEvents, enrich } = options
  if (revision === undefined || revision === null) {
    throw new Error('syncSessionIndex 需要 revision')
  }
  const dir = typeof options.dir === 'string' && options.dir !== ''
    ? options.dir
    : defaultSessionsDir()
  if (dir === '') throw new Error('无法确定 DSH home；请显式传入 dir')

  const key = String(revision)
  const existing = await readIndexFile(dir, sessionId)
  if (existing.ok && existing.meta.revision === key) {
    return {
      skipped: true,
      reason: 'revision',
      path: existing.path,
      meta: existing.meta,
      turns: existing.turns,
    }
  }

  if (typeof loadEvents !== 'function') {
    // 重建必须拿得到事件流；否则会静默写出一份空索引，把已有历史抹掉。
    throw new Error('syncSessionIndex 重建需要 loadEvents')
  }
  const events = await loadEvents()
  const turns = buildTurnRows(events)
  if (typeof enrich === 'function') {
    // 依赖 Host context 的字段（F-7 的 changes）在这里补：本模块仍只处理
    // 纯数据，不认 ctx；previous 是上一版索引行，供钩子复用已落盘结果。
    // legacy：旧结构/损坏索引的重建，历史轮次无法还原"当时"的磁盘快照。
    await enrich({
      turns,
      events,
      previous: existing.ok ? existing.turns : [],
      sessionId,
      revision: key,
      legacy: !existing.ok && existing.reason !== 'missing',
    })
  }
  const text = serializeIndex({ revision: key, turns })
  const path = await writeIndexFile(dir, sessionId, text)
  return {
    skipped: false,
    reason: existing.ok ? 'revision' : existing.reason,
    path,
    meta: makeMeta(key, turns.length),
    turns,
  }
}
