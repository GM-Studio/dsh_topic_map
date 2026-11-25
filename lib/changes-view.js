/**
 * 变更可视化模型（P3-1 / A-7）：把一轮的 `changes` 变成可分组、可排序的清单。
 *
 * A-7 要三层——文件清单 + ±行 → hunk → 文件演化史。本模块只负责第一层：
 * 归一文件、算总计、按扩展名分组、按路径或改动量排序。hunk 与演化史要读
 * `workspaceChanges.diff` / 索引，属于 Host 侧，不放进这个纯函数模块。
 *
 * 口径：
 * - `added / deleted` 是非负整数；负数、`NaN`、`Infinity`、空值都记 0，
 *   超过 32 位的有限大数原样保留（不截断）。
 * - `lost:true` 表示"曾发生变更但明细已不可读"：此时 `files:[]`、固定文案、
 *   `totals` 归零，绝不伪装成"0 个文件"或拿旧字段凑数。
 * - `totals` 从归一后的文件清单求和；`changes.total` 不参与（它可能与明细
 *   列表不一致，清单本身才可逐条核对）。
 * - 分组固定顺序 code → doc → config → other，只返回非空组；组内保持输入顺序。
 * - `size` 排序按 `added + deleted` 降序（改动量），同量按 `path` 升序。
 *
 * 纯函数约定：不 import、不碰 DOM、不读系统时钟；入参只读，返回新对象。
 *
 * @module dsh-topic-map/changes-view
 */

/** 扩展名 → kind。只认契约列出的这些；其余一律 other。 */
const EXT_KIND = new Map([
  ['js', 'code'], ['ts', 'code'], ['mjs', 'code'], ['py', 'code'],
  ['go', 'code'], ['rs', 'code'], ['java', 'code'], ['c', 'code'], ['h', 'code'],
  ['md', 'doc'], ['txt', 'doc'],
  ['json', 'config'], ['yml', 'config'], ['yaml', 'config'],
  ['toml', 'config'], ['ini', 'config'],
])

/** 固定分组顺序。 */
const KIND_ORDER = Object.freeze(['code', 'doc', 'config', 'other'])

/** 分组中文名。 */
const KIND_LABEL = Object.freeze({
  code: '代码',
  doc: '文档',
  config: '配置',
  other: '其他',
})

/** 明细不可读时的固定文案。 */
const LOST_SUMMARY = '该轮变更明细已不可读'

/** 没有变更时的固定文案。 */
const EMPTY_SUMMARY = '该轮没有文件变更'

/** 是否普通对象（排除 null / 数组）。 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 非负整数：接受数字与数字字符串；负数 / 非有限 / 空值一律 0。 */
function toCount(value) {
  if (value === null || value === undefined || value === '') return 0
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return 0
  return Math.floor(number)
}

/**
 * 一条变更文件归一成 `{path, added, deleted}`。
 *
 * 兼容两种输入：契约里的对象，以及只给路径字符串的旧形状（按 ±0 处理）。
 * 路径去首尾空白但保留中间空格；空路径、非对象、非字符串一律丢弃。
 *
 * @param {*} value - 原始条目。
 * @returns {{path: string, added: number, deleted: number}|null} 归一结果。
 */
function normalizeFile(value) {
  if (typeof value === 'string') {
    const path = value.trim()
    return path === '' ? null : { path, added: 0, deleted: 0 }
  }
  if (!isPlainObject(value)) return null
  const path = typeof value.path === 'string' ? value.path.trim() : ''
  if (path === '') return null
  return {
    path,
    added: toCount(value.added),
    deleted: toCount(value.deleted),
  }
}

/** 归一一个文件数组；非数组返回空数组。 */
function normalizeFiles(files) {
  if (!Array.isArray(files)) return []
  const out = []
  for (const file of files) {
    const normalized = normalizeFile(file)
    if (normalized !== null) out.push(normalized)
  }
  return out
}

/** 空总计的新对象。 */
function emptyTotals() {
  return { files: 0, added: 0, deleted: 0 }
}

/** 按扩展名判 kind；点号在文件名开头（如 `.gitignore`）不算扩展名。 */
function kindOfPath(path) {
  const slashed = path.replace(/\\/g, '/')
  const base = slashed.slice(slashed.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return 'other'
  return EXT_KIND.get(base.slice(dot + 1).toLowerCase()) || 'other'
}

/** 路径比较：先按小写（NTFS 不区分大小写），再按原串，保证稳定确定。 */
function comparePath(a, b) {
  const lowerA = a.path.toLowerCase()
  const lowerB = b.path.toLowerCase()
  if (lowerA < lowerB) return -1
  if (lowerA > lowerB) return 1
  if (a.path < b.path) return -1
  if (a.path > b.path) return 1
  return 0
}

/** 改动量：added + deleted；溢出成 Infinity 时按最大有限值参与排序。 */
function churnOf(file) {
  const sum = file.added + file.deleted
  return Number.isFinite(sum) ? sum : Number.MAX_VALUE
}

/** size 排序比较器：改动量降序，同量按路径升序。 */
function compareSize(a, b) {
  const diff = churnOf(b) - churnOf(a)
  if (diff !== 0) return diff
  return comparePath(a, b)
}

/**
 * 一轮 → 变更清单模型。
 *
 * @param {object} turn - 轮次行；读 `turn.changes = {files, lost}`。
 * @returns {{files: Array<object>, lost: boolean, summary: string, totals: object}} 视图模型。
 */
export function buildChanges(turn) {
  const source = isPlainObject(turn) ? turn : {}
  const changes = source.changes
  const lost = isPlainObject(changes) && changes.lost === true

  if (lost) {
    return {
      files: [],
      lost: true,
      summary: LOST_SUMMARY,
      totals: emptyTotals(),
    }
  }

  const rawFiles = Array.isArray(changes)
    ? changes
    : (isPlainObject(changes) && Array.isArray(changes.files) ? changes.files : [])
  const files = normalizeFiles(rawFiles)

  const totals = { files: files.length, added: 0, deleted: 0 }
  for (const file of files) {
    totals.added += file.added
    totals.deleted += file.deleted
  }

  const summary = files.length === 0
    ? EMPTY_SUMMARY
    : `该轮改了 ${files.length} 个文件，+${totals.added} -${totals.deleted} 行`

  return { files, lost: false, summary, totals }
}

/**
 * 按扩展名分组（固定顺序，只返回非空组）。
 *
 * @param {Array<object>} files - `buildChanges` 的文件清单（也接受原始形状）。
 * @returns {Array<{kind: string, label: string, files: Array<object>}>} 分组。
 */
export function groupByKind(files) {
  const buckets = new Map(KIND_ORDER.map(kind => [kind, []]))
  for (const file of normalizeFiles(files)) {
    buckets.get(kindOfPath(file.path)).push(file)
  }
  const groups = []
  for (const kind of KIND_ORDER) {
    const bucket = buckets.get(kind)
    if (bucket.length > 0) {
      groups.push({ kind, label: KIND_LABEL[kind], files: bucket })
    }
  }
  return groups
}

/**
 * 排序变更文件；返回新数组，不改入参。
 *
 * @param {Array<object>} files - 文件清单。
 * @param {'path'|'size'} [mode='path'] - `path` 按路径；`size` 按 added+deleted 降序。
 * @returns {Array<object>} 排序后的新清单。
 */
export function sortChanges(files, mode) {
  const normalized = normalizeFiles(files)
  if (mode === 'size') normalized.sort(compareSize)
  else normalized.sort(comparePath)
  return normalized
}
