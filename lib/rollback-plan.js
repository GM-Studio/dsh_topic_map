/**
 * 回滚预演模型（P3-2 / A-12）：只读地判断"每个文件能不能安全回滚"。
 *
 * 输入是**已落盘**的变更快照（`files[].hash` / `sha256` / `afterHash` /
 * `postHash` = 变更后内容的 sha256；`beforeHash` / `baseHash` / `prevHash` =
 * 可选的回滚目标哈希）与调用方现算的磁盘哈希（`currentHashes`）。本模块不读
 * 磁盘、不写文件、不读时钟，只产出逐文件 state、计数与一句中文摘要，供确认
 * 弹窗 / 简报 / 剪贴板用。
 *
 * 四种 state 的判定（按顺序，先命中先生效）：
 *
 * | state    | 条件 |
 * |----------|------|
 * | missing  | 当前哈希为 null / 缺键 / 空串 / 非字符串 → 磁盘上已不存在 |
 * | same     | 当前文件存在，且记录的回滚目标哈希（`beforeHash`）等于当前哈希，或 `added === 0 && deleted === 0` → 无需回滚 |
 * | modified | 有内容变化，记录了变更后哈希（`hash`），且当前 hash 与它不一致 → 需人工确认 |
 * | apply    | 文件存在；没有命中回滚目标哈希，也没有"变更后哈希不一致"的证据（含未记录 hash）→ 可执行 |
 *
 * 为什么"无 hash"归 apply 而不是 modified：`modified` 的语义是"磁盘已被改"，
 * 而这需要记录过变更后哈希才能下结论。没记录就不能谎称被改；预演只是说明
 * "计划可执行"，真正写入仍必须经过用户确认与执行层的哈希校验。
 *
 * 路径按 NTFS 口径查找：大小写不敏感，`/` 与 `\` 等价，忽略 `./` 前缀；
 * 输出始终保留调用方传入的路径写法（只去首尾空白）。
 *
 * 纯函数约定：不 import、不碰 DOM、不读系统时钟；入参只读，返回新对象。
 *
 * @module dsh-topic-map/rollback-plan
 */

/** state 的固定顺序与中文标签（formatPlan 用）。 */
const STATE_TEXT = Object.freeze({
  apply: '✓ 可回滚',
  same: '≡ 无需回滚',
  modified: '⚠ 已被修改',
  missing: '✗ 已不存在',
})

/** formatPlan 里非 apply 状态的短注。 */
const STATE_NOTE = Object.freeze({
  apply: '',
  same: '',
  modified: '（需人工确认）',
  missing: '（文件已不存在）',
})

/** state 的固定顺序（counts / summary / formatPlan 共用）。 */
const STATE_ORDER = Object.freeze(['apply', 'same', 'modified', 'missing'])

/** 变更后（快照时）内容哈希的字段名，`hash` 是契约名，其余为兼容别名。 */
const AFTER_HASH_KEYS = Object.freeze(['hash', 'sha256', 'afterHash', 'postHash'])

/** 回滚目标（变更前）内容哈希的字段名；用于精确判 same。 */
const BEFORE_HASH_KEYS = Object.freeze(['beforeHash', 'baseHash', 'prevHash'])

/** 空计划的固定文案。 */
const EMPTY_SUMMARY = '没有可回滚的文件'

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

/** sha256 归一：字符串去空白、转小写；其它类型视为"没有哈希"。 */
function normalizeHash(value) {
  if (typeof value !== 'string') return null
  const hash = value.trim().toLowerCase()
  return hash === '' ? null : hash
}

/** 路径查找键：大小写不敏感，斜杠方向等价，忽略 `./` 前缀。 */
function pathKey(path) {
  return path
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\.\//, '')
    .toLowerCase()
}

/** 从记录的若干别名字段里取第一个可用哈希。 */
function recordedHashOf(file, keys) {
  for (const key of keys) {
    const hash = normalizeHash(file[key])
    if (hash !== null) return hash
  }
  return null
}

/** 一条待回滚文件归一；坏条目返回 null。 */
function normalizeFile(value) {
  if (!isPlainObject(value)) return null
  const path = typeof value.path === 'string' ? value.path.trim() : ''
  if (path === '') return null
  return {
    path,
    added: toCount(value.added),
    deleted: toCount(value.deleted),
    hash: recordedHashOf(value, AFTER_HASH_KEYS),
    beforeHash: recordedHashOf(value, BEFORE_HASH_KEYS),
  }
}

/** 当前哈希表 → `[key, hash]`；支持普通对象与 Map。 */
function currentEntries(currentHashes) {
  if (currentHashes instanceof Map) return Array.from(currentHashes.entries())
  if (isPlainObject(currentHashes)) return Object.entries(currentHashes)
  return []
}

/** 比对快照与当前内容，判 state（顺序见模块注释）。 */
function stateOf(file, currentHash) {
  if (currentHash === null) return 'missing'
  if (file.beforeHash !== null && file.beforeHash === currentHash) return 'same'
  if (file.added === 0 && file.deleted === 0) return 'same'
  if (file.hash !== null && file.hash !== currentHash) return 'modified'
  return 'apply'
}

/** 每个 state 给一句可读原因（apply 区分"无哈希"与"有哈希一致"）。 */
function reasonOf(state, file, currentHash) {
  if (state === 'apply') {
    return file.hash === null
      ? '文件存在但未记录快照哈希，可执行回滚（无法校验）'
      : '文件内容与快照一致，可安全回滚'
  }
  if (state === 'same') {
    return file.beforeHash !== null && file.beforeHash === currentHash
      ? '当前内容已是回滚目标，无需回滚'
      : '内容未变，无需回滚'
  }
  if (state === 'missing') return '文件已不存在'
  return '文件在变更后已被修改，需人工确认'
}

/** 每种 state 的中文摘要片段。 */
const SUMMARY_PARTS = Object.freeze([
  ['apply', count => `${count} 个可回滚`],
  ['same', count => `${count} 个无需回滚`],
  ['modified', count => `${count} 个已被修改`],
  ['missing', count => `${count} 个已不存在`],
])

/** 按固定顺序拼摘要；全是 0 时给空态文案。 */
function summarize(counts) {
  const parts = []
  for (const [state, render] of SUMMARY_PARTS) {
    if (counts[state] > 0) parts.push(render(counts[state]))
  }
  return parts.length === 0 ? EMPTY_SUMMARY : parts.join('，')
}

/**
 * 预演一批文件的回滚。
 *
 * @param {Array<{path: string, added: number, deleted: number, hash?: string, beforeHash?: string}>} files - 变更快照。
 * @param {object|Map<string, string|null>} currentHashes - 当前磁盘内容哈希；null 表示文件不存在。
 * @returns {{plan: Array<object>, summary: string, counts: object}} 预演结果。
 */
export function planRollback(files, currentHashes) {
  // 先建精确键与归一键两套索引：精确键优先，避免两个只差大小写的路径互相覆盖。
  const exact = new Map()
  const normalized = new Map()
  for (const [key, raw] of currentEntries(currentHashes)) {
    if (typeof key !== 'string') continue
    const hash = normalizeHash(raw)
    exact.set(key, hash)
    const lookup = pathKey(key)
    if (!normalized.has(lookup)) normalized.set(lookup, hash)
  }

  const plan = []
  const counts = {}
  for (const state of STATE_ORDER) counts[state] = 0
  const source = Array.isArray(files) ? files : []

  for (const value of source) {
    const file = normalizeFile(value)
    if (file === null) continue

    let currentHash
    if (exact.has(file.path)) {
      currentHash = exact.get(file.path)
    } else {
      const lookup = pathKey(file.path)
      currentHash = normalized.has(lookup) ? normalized.get(lookup) : null
    }

    const state = stateOf(file, currentHash)
    counts[state] += 1
    plan.push({
      path: file.path,
      added: file.added,
      deleted: file.deleted,
      hash: file.hash,
      currentHash,
      state,
      reason: reasonOf(state, file, currentHash),
    })
  }

  return { plan, summary: summarize(counts), counts }
}

/**
 * 把预演结果渲染成多行文本（简报 / 剪贴板）。
 *
 * 接受 `planRollback` 返回的 `plan` 数组，也接受完整结果对象 `{plan}`。
 * 每行格式：`<state 标签>  <路径>  +<added> -<deleted>`，modified / missing
 * 追加一句短注。空计划返回单行文案，不返回空串。
 *
 * @param {Array<object>|{plan: Array<object>}} plan - 预演计划。
 * @returns {string} 多行文本（无结尾换行）。
 */
export function formatPlan(plan) {
  const list = Array.isArray(plan)
    ? plan
    : (isPlainObject(plan) && Array.isArray(plan.plan) ? plan.plan : [])
  if (list.length === 0) return EMPTY_SUMMARY

  const lines = []
  for (const item of list) {
    if (!isPlainObject(item)) continue
    const state = typeof item.state === 'string' ? item.state : ''
    const label = STATE_TEXT[state] || '? 未知状态'
    const path = typeof item.path === 'string' ? item.path : ''
    const added = toCount(item.added)
    const deleted = toCount(item.deleted)
    const note = STATE_NOTE[state] || ''
    lines.push(`${label}  ${path}  +${added} -${deleted}${note}`)
  }
  return lines.length === 0 ? EMPTY_SUMMARY : lines.join('\n')
}
