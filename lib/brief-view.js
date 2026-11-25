/**
 * 简报视图模型（A-8）：把一轮轮摘要与指针拼成可落盘、可再编辑的 Markdown。
 *
 * 纯函数约定：不 import、不碰 DOM、不读系统时钟——`now` 一律由调用方传入；
 * 本文件稍后会由 `build-theme` 原样嵌进客户端 bundle（`strip()` 只删 import 行、
 * 不解析依赖），所以连小工具都自带一份。日期格式化只用传入的毫秒数做本地时区
 * 换算，绝不读取系统当前时间。
 *
 * 输出结构固定为五段，空内容也保留骨架，便于下游稳定解析：
 * 标题 → 生成时间与范围说明 → `## 时间线` → 逐轮 `###` 小节 → `## 相关命令`。
 *
 * @module dsh-topic-map/brief-view
 */

/** 简报总长度默认上限（码点数）。 */
const DEFAULT_LIMIT = 200000

/** 单轮渲染上限（码点数，含截断标注）。 */
const TURN_LIMIT = 1200

/** 单轮提问头保留的码点数；超出加省略号，避免长提问吃掉整轮预算。 */
const PROMPT_HEAD_LIMIT = 200

/** 单轮「变更文件」最多逐个列出的数量。 */
const FILE_LIST_LIMIT = 10

/** 单轮截断标注。 */
const TURN_TRUNCATED = '\n\n…（已截断）'

/** 总长度截断标注。 */
const TOTAL_TRUNCATED = '\n\n…（简报超出长度上限，已截断）'

/** 空时间线 / 空命令汇总的固定文案。 */
const EMPTY_TIMELINE = '（没有可列出的轮次）'
const EMPTY_COMMANDS = '（没有可汇总的命令）'

/** 空标题兜底。 */
const DEFAULT_TITLE = '话题地图简报'

/** 是否普通对象（排除 null / 数组）。 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 统一成可显示文本；对象 / null 返回空串。 */
function textOf(value) {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

/** 压缩连续空白（含换行），用于标题与单行提示。 */
function compress(value) {
  return textOf(value).replace(/\s+/g, ' ').trim()
}

/** 把时间统一成 epoch ms；认 Date 与数字，其余返回 NaN。 */
function toMs(value) {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return NaN
}

/** 轮号：认数字与数字字符串；空白 / 非法返回 null（不能悄悄当 0）。 */
function toTurn(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const number = Number(value)
    return Number.isFinite(number) ? number : null
  }
  return null
}

/** 非负整数；缺失 / 负数 / NaN 一律记 0。 */
function toCount(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return 0
  return Math.trunc(number)
}

/** 零填充两位。 */
function pad2(value) {
  return String(value).padStart(2, '0')
}

/** 码点长度：中文、emoji 都按"一个字"算，避免按 UTF-16 单元误判。 */
function charLength(text) {
  return Array.from(text).length
}

/** 按码点截取前 n 个字符，绝不切出半个代理对。 */
function sliceChars(text, limit) {
  if (limit <= 0) return ''
  return Array.from(text).slice(0, limit).join('')
}

/**
 * 本地时间 `YYYY-MM-DD HH:mm`（24 小时制）。
 *
 * 非法时间返回空串，由调用方省略对应片段；**不读系统时钟**。
 *
 * @param {number|Date} ms - 时间戳。
 * @returns {string} 格式化结果或空串。
 */
export function formatTime(ms) {
  const time = toMs(ms)
  if (!Number.isFinite(time)) return ''
  const date = new Date(time)
  return `${String(date.getFullYear()).padStart(4, '0')}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

/** 文件名时间戳 `YYYY-MM-DD-HHmm`（本地）；非法返回空串。 */
function fileStamp(ms) {
  const time = toMs(ms)
  if (!Number.isFinite(time)) return ''
  const date = new Date(time)
  return `${String(date.getFullYear()).padStart(4, '0')}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}-${pad2(date.getHours())}${pad2(date.getMinutes())}`
}

/**
 * 把 scope 里的工区 / 会话字段摊平成一行可读文本。
 *
 * @param {*} value - 字符串、数字或数组。
 * @returns {string} 用「、」连接的文本。
 */
function listText(value) {
  if (Array.isArray(value)) {
    const parts = []
    for (const entry of value) {
      const text = isPlainObject(entry)
        ? compress(entry.title ?? entry.name ?? entry.path ?? entry.sessionId)
        : compress(entry)
      if (text !== '' && !parts.includes(text)) parts.push(text)
    }
    return parts.join('、')
  }
  if (isPlainObject(value)) {
    return compress(value.title ?? value.name ?? value.path ?? value.sessionId)
  }
  return compress(value)
}

/**
 * 范围说明行：工区 / 会话 / 时间窗，缺项自动省略。
 *
 * `scope` 给字符串时原样作为范围；给对象时认
 * `{workspace|workspaceName|workspaces, session|sessionTitle|sessions, from|start, to|end, window, label}`。
 *
 * @param {string|object} scope - 范围描述。
 * @returns {string} 以 `> 范围：` 开头的 Markdown 引用行。
 */
function scopeLine(scope) {
  if (typeof scope === 'string') {
    const text = compress(scope)
    return `> 范围：${text === '' ? '未指定' : text}`
  }
  if (!isPlainObject(scope)) return '> 范围：未指定'
  const label = compress(scope.label ?? scope.text)
  if (label !== '') return `> 范围：${label}`

  const parts = []
  const workspace = listText(scope.workspace ?? scope.workspaceName ?? scope.workspaces)
  if (workspace !== '') parts.push(`工区 ${workspace}`)
  const session = listText(scope.session ?? scope.sessionTitle ?? scope.sessions)
  if (session !== '') parts.push(`会话 ${session}`)

  const from = formatTime(scope.from ?? scope.start)
  const to = formatTime(scope.to ?? scope.end)
  let window = ''
  if (from !== '' && to !== '') window = `${from} – ${to}`
  else if (from !== '') window = `自 ${from}`
  else if (to !== '') window = `截至 ${to}`
  else window = compress(scope.window)
  if (window !== '') parts.push(`时间窗 ${window}`)

  return parts.length === 0 ? '> 范围：未指定' : `> 范围：${parts.join(' ｜ ')}`
}

/**
 * 归一「变更文件」：数组、数字、`{count}` 都认。
 *
 * @param {*} value - `changedFiles` 原值。
 * @returns {{total: number, names: string[]}} 去重后的总数与可列出文件名。
 */
function filesOf(value) {
  if (Array.isArray(value)) {
    const names = []
    for (const entry of value) {
      const name = compress(isPlainObject(entry)
        ? (entry.path ?? entry.file ?? entry.name)
        : entry)
      if (name !== '' && !names.includes(name)) names.push(name)
    }
    return { total: names.length, names }
  }
  if (isPlainObject(value)) {
    const total = toCount(value.count ?? value.total)
    if (total > 0 && !Array.isArray(value.files)) return { total, names: [] }
    const nested = filesOf(value.files)
    return { total: Math.max(total, nested.total), names: nested.names }
  }
  const total = toCount(value)
  return { total, names: [] }
}

/** 渲染「变更文件」一行的值部分；没有文件返回空串。 */
function renderFiles(files) {
  if (files.total <= 0) return ''
  if (files.names.length === 0) return `${files.total} 个文件`
  const shown = files.names.slice(0, FILE_LIST_LIMIT).map(name => `\`${name}\``)
  if (files.names.length > FILE_LIST_LIMIT) shown.push(`等 ${files.names.length} 个文件`)
  return shown.join('、')
}

/** 提问头超长截断：保留前 199 字并加省略号。 */
function truncatePrompt(text) {
  if (charLength(text) <= PROMPT_HEAD_LIMIT) return text
  return sliceChars(text, PROMPT_HEAD_LIMIT - 1) + '…'
}

/** 单轮超长截断：总长含标注不超过 1200 码点。 */
function truncateTurn(block) {
  if (charLength(block) <= TURN_LIMIT) return block
  const markerLength = charLength(TURN_TRUNCATED)
  return sliceChars(block, TURN_LIMIT - markerLength) + TURN_TRUNCATED
}

/**
 * 归一 `turns`：过滤坏数据、按轮号升序稳定排序（无轮号排最后）。
 *
 * @param {*} turns - 输入轮次数组。
 * @returns {object[]} 内部轮次条目。
 */
function normalizeTurns(turns) {
  const list = Array.isArray(turns) ? turns : []
  const items = []
  for (const raw of list) {
    if (!isPlainObject(raw)) continue
    const commandCount = raw.commandCount === undefined && Array.isArray(raw.commands)
      ? raw.commands.length
      : raw.commandCount
    items.push({
      turn: toTurn(raw.turn),
      time: toMs(raw.time),
      promptHead: compress(raw.promptHead ?? raw.prompt),
      digest: typeof raw.digest === 'string'
        ? raw.digest.replace(/\r\n?/g, '\n').trim()
        : textOf(raw.digest).trim(),
      commandCount: toCount(commandCount),
      files: filesOf(raw.changedFiles),
    })
  }
  return items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => {
      if (left.item.turn === null && right.item.turn === null) return left.index - right.index
      if (left.item.turn === null) return 1
      if (right.item.turn === null) return -1
      return left.item.turn - right.item.turn || left.index - right.index
    })
    .map(entry => entry.item)
}

/** 单轮标题：`### 第 N 轮 · 时间`；缺项自动省略。 */
function turnHeading(item) {
  const turn = item.turn === null ? '轮次未知' : `第 ${item.turn} 轮`
  const time = formatTime(item.time)
  return time === '' ? `### ${turn}` : `### ${turn} · ${time}`
}

/**
 * 渲染单轮小节（不含段间空行）。
 *
 * @param {object} item - 归一后的轮次。
 * @returns {string} Markdown 小节。
 */
function renderTurn(item) {
  const parts = [turnHeading(item)]
  if (item.promptHead !== '') parts.push(`**提问**：${truncatePrompt(item.promptHead)}`)
  if (item.digest !== '') parts.push(item.digest)

  const meta = []
  if (item.commandCount > 0) meta.push(`- 命令：${item.commandCount} 条`)
  const files = renderFiles(item.files)
  if (files !== '') meta.push(`- 变更文件：${files}`)
  if (meta.length > 0) parts.push(meta.join('\n'))

  if (parts.length === 1) parts.push('（本轮没有摘要）')
  return truncateTurn(parts.join('\n\n'))
}

/** 相关性命令汇总：逐轮条数 + 总计。 */
function commandSummary(items) {
  const withCommands = items.filter(item => item.commandCount > 0)
  if (withCommands.length === 0) return EMPTY_COMMANDS
  const lines = withCommands.map(item => {
    const turn = item.turn === null ? '轮次未知' : `第 ${item.turn} 轮`
    return `- ${turn}：${item.commandCount} 条命令`
  })
  const total = withCommands.reduce((sum, item) => sum + item.commandCount, 0)
  return `${lines.join('\n')}\n\n共 ${total} 条命令，来自 ${withCommands.length} 轮。`
}

/** 总长度上限归一：非法 / 非正数回默认，绝不因坏参数产出空文件。 */
function normalizeLimit(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_LIMIT
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return DEFAULT_LIMIT
  return Math.floor(number)
}

/** 总长度截断：保留头部并在末尾标注，保证结果 ≤ limit。 */
function applyTotalLimit(doc, limit) {
  const max = normalizeLimit(limit)
  if (charLength(doc) <= max) return doc
  const markerLength = charLength(TOTAL_TRUNCATED)
  if (max <= markerLength) return sliceChars(doc, max)
  return sliceChars(doc, max - markerLength).replace(/\s+$/, '') + TOTAL_TRUNCATED
}

/**
 * 生成一份简报 Markdown。
 *
 * 结构：标题 → 生成时间 / 范围 → `## 时间线`（逐轮 `###` 小节）→ `## 相关命令`。
 * 单轮渲染超 1200 码点截断并标注；整份超 `limit` 码点再整体截断并标注。
 * 空 `turns` 也保留完整骨架，方便下游稳定解析。
 *
 * @param {object} input - 输入。
 * @param {string} [input.title] - 简报标题，默认「话题地图简报」。
 * @param {string|object} [input.scope] - 范围（工区 / 会话 / 时间窗）；字符串原样展示。
 * @param {object[]} [input.turns] - `[{turn, time, promptHead, digest, commandCount, changedFiles}]`。
 * @param {number|Date} [input.now] - 生成时间（epoch ms），只用于展示，不读时钟。
 * @param {number} [input.limit=200000] - 总长度上限（码点数）。
 * @returns {string} Markdown 简报。
 */
export function buildBrief(input) {
  const opts = isPlainObject(input) ? input : {}
  const title = compress(opts.title) || DEFAULT_TITLE
  const items = normalizeTurns(opts.turns)
  const nowText = formatTime(opts.now)

  const meta = []
  if (nowText !== '') meta.push(`> 生成时间：${nowText}`)
  meta.push(scopeLine(opts.scope))

  const timeline = items.length === 0
    ? EMPTY_TIMELINE
    : items.map(renderTurn).join('\n\n')

  const parts = [
    `# ${title}`,
    meta.join('\n'),
    '## 时间线',
    timeline,
    '## 相关命令',
    commandSummary(items),
  ]
  return applyTotalLimit(parts.join('\n\n'), opts.limit)
}

/**
 * 简报文件名：`YYYY-MM-DD-HHmm-<slug>.md`。
 *
 * slug 取标题里的安全字符（字母 / 数字 / 汉字 / `_` / `-`），其它字符压成
 * `-`，最多 20 个码点；标题没有可用字符时回 `brief`。`now` 非法时前缀回
 * `undated`（不读时钟补当前时间）。
 *
 * @param {string} title - 简报标题。
 * @param {number|Date} now - 生成时间（epoch ms）。
 * @returns {string} 文件名。
 */
export function briefFileName(title, now) {
  const stamp = fileStamp(now)
  let slug = compress(title)
  if (slug !== '') {
    slug = slug
      .replace(/[^\p{L}\p{N}_-]+/gu, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^-+|-+$/g, '')
  }
  slug = sliceChars(slug, 20).replace(/-+$/, '')
  if (slug === '') slug = 'brief'
  return stamp === '' ? `undated-${slug}.md` : `${stamp}-${slug}.md`
}
