/**
 * 引用块构造与反解（A-4 / design.md §6）。
 *
 * 块分三层：
 * - 指针：首行 `〔引用〕话题 › 会话 · 第 N 轮 · 时间` + 末行 `出处：session/<id>#N`；
 * - 摘要：`意图：…` + `结论：` 若干条；
 * - 原文：可选，插在出处前，默认不带。
 *
 * 为什么要独立成模块：A-4 要求"插入前估算 token、超预算二次确认、可折叠回指针"，
 * 这些都可以用纯函数验证。块是**结构化文本**而不是拼接散文——指针永远保留，
 * 否则用户之后再想回跳就只能靠记忆。
 *
 * 三条约束：
 * - 不 import、不读 DOM、不读系统时钟（时间戳由调用方给）；
 * - token 估算只是**启发式**，真实值以宿主的 `tokenMeter` 为准；
 * - 预算永远先砍原文、再砍结论，指针不砍。
 *
 * @module dsh-topic-map/cite
 */

/** C-1 默认引用预算。 */
const DEFAULT_CITE_BUDGET = 5000

/** 非中日韩字符的折算比例：约 3.6 字符 / token。 */
const NON_CJK_PER_TOKEN = 3.6

/** 是否普通对象（排除 null / 数组）。 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 统一成字符串；null / undefined → ''。 */
function toText(value) {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  return String(value)
}

/** 压缩连续空白（块内多行字段只留一行）。 */
function compress(text) {
  return toText(text).replace(/\s+/g, ' ').trim()
}

/** 转整数；非法返回 null。 */
function toInteger(value) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? Math.trunc(number) : null
}

/** 正整数（预算 / 次数）；非法返回 null。 */
function toPositiveInteger(value) {
  let number = NaN
  if (typeof value === 'number') number = value
  else if (typeof value === 'string' && value.trim() !== '') number = Number(value)
  if (Number.isFinite(number) && number > 0) return Math.floor(number)
  return null
}

/** 预算归一：非正整数回落 5000（C-1）。 */
function normalizeBudget(value) {
  const positive = toPositiveInteger(value)
  return positive === null ? DEFAULT_CITE_BUDGET : positive
}

/** 结论条目归一：数组 / 单条字符串都认，去空、压缩空白。 */
function normalizePoints(points) {
  const list = Array.isArray(points)
    ? points
    : (points === null || points === undefined || points === '' ? [] : [points])
  return list.map(point => compress(point)).filter(point => point !== '')
}

/** 代码点是否属于中日韩文字（含假名、谚文、CJK 标点与扩展区）。 */
function isCjkCodePoint(codePoint) {
  return (
    (codePoint >= 0x2E80 && codePoint <= 0x2EFF) ||   // CJK 部首补充
    (codePoint >= 0x2F00 && codePoint <= 0x2FDF) ||   // 康熙部首
    (codePoint >= 0x3000 && codePoint <= 0x303F) ||   // CJK 标点
    (codePoint >= 0x3040 && codePoint <= 0x30FF) ||   // 平假名 / 片假名
    (codePoint >= 0x3100 && codePoint <= 0x312F) ||   // 注音
    (codePoint >= 0x31A0 && codePoint <= 0x31BF) ||
    (codePoint >= 0x31F0 && codePoint <= 0x31FF) ||
    (codePoint >= 0x3400 && codePoint <= 0x4DBF) ||   // 扩展 A
    (codePoint >= 0x4E00 && codePoint <= 0x9FFF) ||   // 基本区
    (codePoint >= 0xA960 && codePoint <= 0xA97F) ||   // 谚文字母扩展 A
    (codePoint >= 0xAC00 && codePoint <= 0xD7AF) ||   // 谚文音节
    (codePoint >= 0xD7B0 && codePoint <= 0xD7FF) ||   // 谚文字母扩展 B
    (codePoint >= 0xF900 && codePoint <= 0xFAFF) ||   // 兼容表意文字
    (codePoint >= 0xFE10 && codePoint <= 0xFE1F) ||   // 竖排标点
    (codePoint >= 0xFE30 && codePoint <= 0xFE4F) ||   // 兼容形式
    (codePoint >= 0xFF00 && codePoint <= 0xFFEF) ||   // 全角 / 半角形式
    (codePoint >= 0x20000 && codePoint <= 0x2FA1F) || // 扩展 B ~ F
    (codePoint >= 0x30000 && codePoint <= 0x3134F)    // 扩展 G / H
  )
}

/**
 * 估算文本的 token 数（A-4 的"约 +N tokens"）。
 *
 * 口径：中日韩字符按 1 token/字，其余字符按约 3.6 字符/token 折算后向上取整。
 * 示例：`中文 abc` → 2 + ceil(4/3.6) = 4。
 *
 * **这是估算，不是真实 token 数**：真实值以宿主 `tokenMeter` 为准。偏差主要来自
 * BPE 对代码、URL、标点与 emoji 的切分，以及"1 个汉字 = 1 token"的简化假设。
 * 预算判定建议留出余量；超预算时走 A-4 的二次确认，而不是相信这里的绝对值。
 *
 * @param {string} text - 文本。
 * @returns {number} 估算 token 数；空文本为 0。
 */
export function estimateTokens(text) {
  const source = typeof text === 'string' ? text : toText(text)
  if (source === '') return 0
  let cjk = 0
  let other = 0
  for (const char of source) {
    if (isCjkCodePoint(char.codePointAt(0))) cjk += 1
    else other += 1
  }
  return cjk + Math.ceil(other / NON_CJK_PER_TOKEN)
}

/** 两位补零。 */
function pad2(value) {
  return String(value).padStart(2, '0')
}

/**
 * 本地时区（或指定时区）格式化 `YYYY-MM-DD HH:mm`。
 *
 * @param {number} ms - epoch ms。
 * @param {string} [timeZone] - IANA 时区；不传则用运行环境默认时区。
 * @returns {string} 格式化结果；失败为空串。
 */
function formatStamp(ms, timeZone) {
  const base = {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }
  const render = options => {
    const parts = new Intl.DateTimeFormat('en-US', options).formatToParts(new Date(ms))
    const pick = type => {
      const part = parts.find(item => item.type === type)
      return part === undefined ? '' : part.value
    }
    return `${pick('year')}-${pad2(pick('month'))}-${pad2(pick('day'))} ${pad2(pick('hour'))}:${pad2(pick('minute'))}`
  }
  const zone = typeof timeZone === 'string' ? timeZone.trim() : ''
  try {
    return render(zone === '' ? base : { ...base, timeZone: zone })
  } catch {
    // 时区名非法时退回运行环境默认时区，避免整条引用没有时间。
    try {
      return render(base)
    } catch {
      return ''
    }
  }
}

/**
 * 块里的时间：字符串原样用；数字 / Date 按本地时区格式化。
 *
 * @param {number|Date|string} value - 时间戳或已格式化文本。
 * @param {string} [timeZone] - IANA 时区覆盖（便于测试）。
 * @returns {string} 展示用时间；非法为空串。
 */
function formatCiteTime(value, timeZone) {
  // 已格式化的文本也压缩成一行，避免调用方传进来的换行把块结构撑坏。
  if (typeof value === 'string') return compress(value)
  const ms = value instanceof Date
    ? value.getTime()
    : (typeof value === 'number' && Number.isFinite(value) ? value : NaN)
  if (!Number.isFinite(ms)) return ''
  return formatStamp(ms, timeZone)
}

/** 首行：`〔引用〕话题 › 会话 · 第 N 轮 · 时间`。 */
function makeHeader(topic, title, turn, timeLabel) {
  const head = [topic, title].filter(text => text !== '').join(' › ')
  const turnText = turn === null ? '' : `第 ${turn} 轮`
  const meta = [head, turnText, timeLabel].filter(text => text !== '').join(' · ')
  return meta === '' ? '〔引用〕' : `〔引用〕${meta}`
}

/** 按开关拼块；body / 点数为空时整段省略（不留空标题）。 */
function composeCite({ header, intent, points, body, pointer }) {
  const lines = [header]
  if (intent !== '') lines.push(`意图：${intent}`)
  if (points.length > 0) {
    lines.push('结论：')
    for (const point of points) lines.push(`- ${point}`)
  }
  if (body !== '') {
    lines.push('原文：')
    lines.push(body)
  }
  lines.push(pointer)
  return lines.join('\n')
}

/** 按实际内容算层：指针恒有；摘要与原文看是否留下内容。 */
function layersOf(intent, points, body) {
  const layers = ['pointer']
  if (intent !== '' || points.length > 0) layers.push('summary')
  if (body !== '') layers.push('body')
  return layers
}

/**
 * 构造引用块。
 *
 * 预算策略（A-4）：
 * 1. 先砍原文（整段）；
 * 2. 再从末尾逐条砍结论；
 * 3. 结论砍光仍超预算时，保留「指针 + 意图」——指针与意图是摘要的最小语义单位，
 *    若它们本身就超预算，返回的 `tokens` 会大于 `budget`，交由调用方二次确认，
 *    绝不为了预算删掉出处。
 *
 * @param {object} input - 引用原料。
 * @param {string} [input.topic] - 话题名。
 * @param {string} [input.title] - 会话 / 对话标题。
 * @param {number|string} [input.turn] - 轮号（1-based）。
 * @param {number|Date|string} [input.time] - 时间戳或已格式化的时间文本。
 * @param {string} [input.timeZone] - IANA 时区（不传用运行环境默认时区）。
 * @param {string} [input.intent] - 意图一句。
 * @param {string[]|string} [input.points] - 结论条目。
 * @param {string} [input.body] - 原文（可选，默认不带）。
 * @param {string} [input.sessionId] - 会话 id（出处指针用）。
 * @param {number|string} [input.budget] - 预算（默认 5000，C-1）。
 * @returns {{text: string, tokens: number, layers: string[], trimmed: boolean}} 引用块。
 */
export function buildCite(input = {}) {
  const source = isPlainObject(input) ? input : {}
  const sessionId = toText(source.sessionId).trim()
  const turn = toInteger(source.turn)
  const topic = compress(source.topic)
  const title = compress(source.title)
  const intent = compress(source.intent)
  const points = normalizePoints(source.points)
  const body = toText(source.body).trim()
  const header = makeHeader(topic, title, turn, formatCiteTime(source.time, source.timeZone))
  const pointer = `出处：session/${sessionId}#${turn === null ? '' : turn}`
  const budget = normalizeBudget(source.budget)

  const fullText = composeCite({ header, intent, points, body, pointer })
  const fullTokens = estimateTokens(fullText)
  if (fullTokens <= budget) {
    return { text: fullText, tokens: fullTokens, layers: layersOf(intent, points, body), trimmed: false }
  }

  // 1) 先砍原文：摘要一个字不动。
  if (body !== '') {
    const withoutBody = composeCite({ header, intent, points, body: '', pointer })
    const tokens = estimateTokens(withoutBody)
    if (tokens <= budget) {
      return { text: withoutBody, tokens, layers: layersOf(intent, points, ''), trimmed: true }
    }
  }

  // 2) 再从末尾砍结论：保留前缀，绝不从中间挑。
  for (let keep = points.length - 1; keep >= 0; keep -= 1) {
    const kept = points.slice(0, keep)
    const text = composeCite({ header, intent, points: kept, body: '', pointer })
    const tokens = estimateTokens(text)
    if (tokens <= budget) {
      return { text, tokens, layers: layersOf(intent, kept, ''), trimmed: true }
    }
  }

  // 3) 结论全砍，指针与意图仍保留（可能超预算，交调用方二次确认）。
  const minimal = composeCite({ header, intent, points: [], body: '', pointer })
  return {
    text: minimal,
    tokens: estimateTokens(minimal),
    layers: layersOf(intent, [], ''),
    trimmed: true,
  }
}

/**
 * 从块里反解出处指针（round-trip 的另一半）。
 *
 * 只认 `出处：session/<id>#<turn>` 这一行；行首的 `〔引用〕…` 作为 `header`
 * 一并带回（块被裁剪过、或用户只贴了指针时 `header` 可能为空串）。
 *
 * @param {string} text - 引用块文本。
 * @returns {{sessionId: string, turn: number, header: string}|null} 指针；脏文本为 null。
 */
export function parseCite(text) {
  if (typeof text !== 'string' || text === '') return null
  const pointer = text.match(/^出处[：:]\s*session\/(.+)#(\d+)\s*$/m)
  if (pointer === null) return null
  const sessionId = pointer[1].trim()
  const turn = Number(pointer[2])
  if (sessionId === '' || !Number.isInteger(turn) || turn <= 0) return null
  const header = text.match(/^〔引用〕.*$/m)
  return {
    sessionId,
    turn,
    header: header === null ? '' : header[0].trim(),
  }
}

/**
 * 配置里的引用预算（C-1）。
 *
 * @param {object} [config] - 配置对象；读取 `citeTokenBudget`。
 * @param {number} [fallback] - 配置缺失 / 非法时的回落值（默认 5000）。
 * @returns {number} 正整数预算。
 */
export function citeBudgetOf(config, fallback = DEFAULT_CITE_BUDGET) {
  const options = isPlainObject(config) ? config : {}
  const configured = toPositiveInteger(options.citeTokenBudget)
  if (configured !== null) return configured
  return normalizeBudget(fallback)
}

/**
 * 把带原文的引用块折叠回「指针 + 摘要」。
 *
 * 原文段 = `原文：` 行到**最后一个** `出处：` 行之间；保留其它行。
 * 没有原文段时原样返回，输入非字符串返回空串。
 *
 * @param {string} text - 引用块文本。
 * @returns {string} 折叠后的块。
 */
export function stripBody(text) {
  if (typeof text !== 'string') return ''
  if (text === '') return ''
  const lines = text.split(/\r?\n/)
  const bodyAt = lines.findIndex(line => /^原文[：:]/.test(line))
  if (bodyAt === -1) return text
  let pointerAt = -1
  for (let i = lines.length - 1; i > bodyAt; i -= 1) {
    if (/^出处[：:]/.test(lines[i])) {
      pointerAt = i
      break
    }
  }
  const kept = lines.slice(0, bodyAt)
  if (pointerAt !== -1) kept.push(...lines.slice(pointerAt))
  return kept.join('\n')
}
