/**
 * 会话大纲（历史轨）纯模型。
 *
 * 给 `/session-outline` 用：把轮次行投影成"每轮一行"的轻量大纲，只带
 * 提问开头，不夹带提问/回答全文。浏览器半边的历史轨要能一次拉完整个
 * 会话而不被正文体积拖慢，所以字段必须保持窄。
 *
 * 纯函数：不读时钟、不读文件、不认 ctx；输入数组只读，返回新对象。
 *
 * @module dsh-topic-map/outline
 */

/** 大纲里提问开头的默认字数上限（产品口径：60 字）。 */
export const OUTLINE_PROMPT_HEAD_MAX = 60

/**
 * 提问 → 单行开头。
 *
 * 规则：连续空白（含换行）压成一个空格；按 Unicode 码点截断，避免把
 * 表情符号的代理对切一半；超长时不做省略号（大纲宽度由界面控制）。
 *
 * @param text - 原始提问。
 * @param max - 字数上限，非法值回默认 60。
 * @returns 单行开头，可能为空串。
 */
export function outlinePromptHead(text, max = OUTLINE_PROMPT_HEAD_MAX) {
  const normalized = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (normalized === '') return ''
  const budget = Number.isFinite(max) && max > 0 ? Math.floor(max) : OUTLINE_PROMPT_HEAD_MAX
  return Array.from(normalized).slice(0, budget).join('')
}

/**
 * 轮次行 → 大纲行。
 *
 * 时间取 `turn/end` 优先（一轮的完成时间更有信息量），未终结才退回
 * `turn/start`；两者都没有就是 null，不用 0 冒充。
 *
 * @param row - 索引行或 `buildTurnRows` 的行。
 * @returns 大纲行（键序固定）。
 */
export function outlineRowOf(row) {
  const end = Number.isFinite(row?.end) ? row.end : null
  const start = Number.isFinite(row?.start) ? row.start : null
  return {
    turn: row.turn,
    promptHead: outlinePromptHead(row.prompt),
    time: end ?? start,
    endReason: typeof row.endReason === 'string' && row.endReason !== '' ? row.endReason : 'open',
    endSeq: Number.isInteger(row?.endSeq) && row.endSeq >= 0 ? row.endSeq : null,
  }
}

/**
 * 轮次行数组 → `{turns}`。
 *
 * 按轮号升序输出（索引本身有序，这里再兜一次底），非法行直接跳过；
 * 不截断会话——大纲体积由每行的窄字段保证。
 *
 * @param rows - 轮次行数组。
 * @returns `{turns: object[]}`。
 */
export function buildSessionOutline(rows) {
  const turns = []
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row === null || typeof row !== 'object') continue
    if (!Number.isInteger(row.turn) || row.turn < 0) continue
    turns.push(outlineRowOf(row))
  }
  turns.sort((left, right) => left.turn - right.turn)
  return { turns }
}
