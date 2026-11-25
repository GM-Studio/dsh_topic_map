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
 */
export const INDEX_SCHEMA = 1

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
 * @param prompt - 提问全文。
 * @param response - 回答全文。
 * @param limit - 单轮字符上限，默认 {@link MAX_TURN_TEXT}。
 * @returns `{prompt, response, truncated}`。
 */
export function capTurnText(prompt, response, limit = MAX_TURN_TEXT) {
  const question = typeof prompt === 'string' ? prompt : ''
  const answer = typeof response === 'string' ? response : ''
  const budget = Number.isFinite(limit) && limit >= 0 ? limit : MAX_TURN_TEXT
  if (question.length + answer.length <= budget) {
    return { prompt: question, response: answer, truncated: false }
  }
  if (question.length >= budget) {
    return { prompt: question.slice(0, budget), response: '', truncated: true }
  }
  return {
    prompt: question,
    response: answer.slice(0, budget - question.length),
    truncated: true,
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
    ms: null,
    prompt: '',
    response: '',
    tools: [],
    files: [],
    usage: emptyUsage(),
    model: null,
    endReason: 'open',
    interrupted: false,
    steps: 0,
    truncated: false,
  }
}

/**
 * 把会话事件流折叠成一轮一条的索引行（全文）。
 *
 * 事件必须按 seq 升序（宿主 `listEvents` 的保证）。折叠口径与
 * `buildTurnModel` 一致：`turn/start` 是锚；重试但不前进的 `turn/start`
 * 保留前一条；`user/message` 只认 `source.kind === 'user'`；`assistant/message`
 * 累加用量、记录中断与首个模型名；`tool/call` 收集工具与文件。
 *
 * 与预览版的差异只有文本：提问与回答都存全文，同轮多段用空行拼接——
 * 中途被中断的多段回答也算这一轮的内容，不丢。
 *
 * @param events - 宿主的原始会话事件数组。
 * @returns 轮次行数组（键序固定，可直接序列化）。
 */
export function buildTurnRows(events) {
  const rows = []
  let cur = null

  for (const ev of Array.isArray(events) ? events : []) {
    if (!ev || typeof ev !== 'object') continue
    const data = ev.data && typeof ev.data === 'object' ? ev.data : {}

    switch (ev.type) {
      case 'turn/start': {
        const turn = Number(data.turn)
        if (!Number.isFinite(turn) || turn < 0) break
        // 重试边界的 turn/start 不前进时保留已有记录，轮次号保持严格递增。
        if (cur !== null && turn <= cur.turn) {
          cur = rows[rows.length - 1] ?? null
          break
        }
        cur = newRow(turn, ev.seq, ev.time)
        rows.push(cur)
        break
      }

      case 'turn/end': {
        const turn = Number(data.turn)
        if (cur === null || (Number.isFinite(turn) && turn !== cur.turn)) break
        cur.end = typeof ev.time === 'number' ? ev.time : null
        cur.ms = typeof ev.time === 'number' && typeof cur.start === 'number'
          ? Math.max(0, ev.time - cur.start)
          : null
        cur.endReason = endReasonOf(data.reason)
        break
      }

      case 'user/message': {
        if (cur === null) break
        // 系统提示注入也走 user/message，只有人说的话才进 prompt。
        const source = data.source
        if (!source || source.kind !== 'user') break
        const text = messageText(data.content)
        if (text === '') break
        // 同轮多句人类输入（steering）也属于这一轮的提问上下文。
        cur.prompt = cur.prompt === '' ? text : `${cur.prompt}\n\n${text}`
        break
      }

      case 'assistant/message': {
        if (cur === null) break
        addUsage(cur.usage, data.usage)
        if (data.interrupted === true) cur.interrupted = true
        const text = messageText(data.message?.content)
        if (text !== '') {
          cur.response = cur.response === '' ? text : `${cur.response}\n\n${text}`
        }
        if (cur.model === null) {
          const source = data.message?.source
          if (source && source.kind === 'model' && typeof source.model === 'string' && source.model !== '') {
            cur.model = source.model
          }
        }
        break
      }

      case 'step/start': {
        if (cur !== null) cur.steps += 1
        break
      }

      case 'tool/call': {
        if (cur === null) break
        pushUnique(cur.tools, data.name)
        for (const path of filesOf(data.arguments)) pushFile(cur.files, path)
        break
      }

      default:
        break
    }

    // 与预览模型同口径：单轮实体列表有界，一次批量编辑可能提上千个路径。
    if (cur !== null) {
      if (cur.tools.length > MAX_TOOLS) cur.tools.length = MAX_TOOLS
      if (cur.files.length > MAX_FILES) cur.files.length = MAX_FILES
    }
  }

  // 文本截断放在折叠之后：只有整轮拼完才知道总长度。
  for (const row of rows) {
    const capped = capTurnText(row.prompt, row.response)
    row.prompt = capped.prompt
    row.response = capped.response
    row.truncated = capped.truncated
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
 *   `{turns, events, previous, sessionId, revision}`——用于补依赖 Host context
 *   的字段（F-7 的 `changes`）；不传就完全不做额外 I/O，纯函数边界不变。
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
    await enrich({
      turns,
      events,
      previous: existing.ok ? existing.turns : [],
      sessionId,
      revision: key,
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
