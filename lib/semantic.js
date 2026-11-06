/**
 * 语义分段：让模型确认"这两轮是不是同一件事"。
 *
 * 为什么不把整个会话丢给模型让它输出分支结构：
 *
 * - 结构生成容易编错轮号，一个错位整张图就乱了；
 * - 长会话会超出上下文；
 * - 出错时无法定位是哪一步错的。
 *
 * 所以这里采用**只判边界**的做法：本地规则先切，只把"可疑的切口"交给模型
 * 做二分类。一次判定只有"是/否"两种结果，模型不容易错，出错也容易发现；
 * 而且调用次数与边界数成正比（通常 3–8 次），与会话长度不成正比。
 *
 * @module dsh-topic-map/semantic
 */

import { extractJsonArray, extractJsonArrayOfLength, extractJsonField } from './model-output.js'

/**
 * 默认的分析轮次上限；更早的轮次沿用本地规则。
 *
 * 50 而不是 60：大会话里模型调用是主要耗时来源，收紧这个窗口能明显
 * 缩短"分析中"的等待。更早的轮次本来也大多由本地规则判得够稳，
 * 把它们也送去模型换来的精度提升有限。
 */
export const DEFAULT_TURN_LIMIT = 50

/** 每轮发给模型的正文预算（字符）。 */
const PROMPT_BUDGET = 220
const REPLY_BUDGET = 200

/**
 * 相邻两轮"是否同一话题"的判定区间。
 *
 * 相似度落在这个区间里，说明本地规则没有把握——这才是值得问模型的地方。
 * 明显相同（> high）或明显不同（< low）的边界，本地判断已经够稳，
 * 花 token 去问只会拖慢并增加噪声。
 */
const AMBIGUOUS_LOW = 0.15
const AMBIGUOUS_HIGH = 0.62

/** 一次批量判定最多包含多少个边界，避免单次请求过大。 */
const BATCH_LIMIT = 24

/**
 * 由本地相似度找出"值得问模型"的边界。
 *
 * @param turns - 轮次事实。
 * @param similarityAt - (i) => 第 i 与 i-1 轮之间的相似度。
 * @returns 候选边界的轮次下标（该轮的 turn/start 处切）。
 */
export function pickAmbiguousBoundaries(turns, similarityAt) {
  const out = []
  for (let i = 1; i < turns.length; i += 1) {
    const s = similarityAt(i)
    if (s > AMBIGUOUS_LOW && s < AMBIGUOUS_HIGH) out.push(i)
  }
  if (out.length <= BATCH_LIMIT) return out
  // 边界太多时取"最没把握"的那些：离两端越近越模糊。
  const scored = out.map(i => ({ i, doubt: 1 - Math.abs(similarityAt(i) - (AMBIGUOUS_LOW + AMBIGUOUS_HIGH) / 2) }))
  scored.sort((a, b) => b.doubt - a.doubt)
  return scored.slice(0, BATCH_LIMIT).map(x => x.i).sort((a, b) => a - b)
}

/** 截断正文，按字符预算，保留开头。 */
function clip(text, budget) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (s.length <= budget) return s
  return `${s.slice(0, budget - 1)}…`
}

/**
 * 构造一次边界判定的提示词。
 *
 * 刻意要求"只回答 yes 或 no"：这是二分类，回答空间越小越不容易跑偏。
 * 同时给出两轮的正文，让模型能判断"是不是在接着讲同一件事"。
 *
 * @param prevTurn - 前一轮。
 * @param nextTurn - 后一轮。
 * @returns 系统提示与用户消息。
 */
export function buildBoundaryPrompt(prevTurn, nextTurn) {
  const system = [
    '你在帮助判断一段连续对话里的话题边界。',
    '给定相邻的两轮对话，判断后一轮是否开启了与前一**不同**的新话题。',
    '判定要看是否在讲同一件事，而不是看用词是否相似：',
    '- 继续、补充、追问同一件事 → 同一话题；',
    '- 换到另一个主题、另一个子任务 → 新话题。',
    '只输出一个词：SAME 或 NEW。不要解释。',
  ].join('\n')

  const body = [
    `【第 ${prevTurn.turn} 轮】`,
    clip(prevTurn.prompt, PROMPT_BUDGET),
    prevTurn.response ? `（回复摘要）${clip(prevTurn.response, REPLY_BUDGET)}` : '',
    '',
    `【第 ${nextTurn.turn} 轮】`,
    clip(nextTurn.prompt, PROMPT_BUDGET),
    nextTurn.response ? `（回复摘要）${clip(nextTurn.response, REPLY_BUDGET)}` : '',
    '',
    '第 ' + nextTurn.turn + ' 轮是否开启了新话题？只答 SAME 或 NEW。',
  ].filter(line => line !== '').join('\n')

  return { system, user: body }
}

/**
 * 解析模型的回答。
 *
 * 宽容处理：只找 SAME / NEW 这两个词，忽略大小写、标点与多余解释。
 * 无法判断时返回 null——调用方据此保留本地结论，而不是猜。
 *
 * @param text - 模型输出。
 * @returns 'same' | 'new' | null。
 */
export function parseBoundaryAnswer(text) {
  const s = String(text ?? '').toUpperCase()
  if (s.trim() === '') return null
  // 否定式必须先判："not SAME" 语义上是新话题，若先匹配 SAME 就会判反。
  // 只认完整的否定短语，避免把 "notable"、"north" 这类词当成否定。
  if (/\bNOT\b[^.]{0,12}\bSAME\b/.test(s)) return 'new'
  if (/\bNO\b\s*[,.!]?$/.test(s.trim())) return 'new'
  if (/\bNEW\b/.test(s)) return 'new'
  if (/\bSAME\b/.test(s)) return 'same'
  return null
}

/**
 * 构造"逐轮归属"的提示词：让模型直接给每一轮打话题标签。
 *
 * 为什么不用"相邻两轮是否同题"：那种二分类只能决定"在哪切"，无法表达
 * "第 14 轮回到了第 9 轮那个话题"。而后者才是长会话里最需要画出来的结构。
 * 一次给出全部标签虽然要求模型做更多事，但结果是可直接用于聚类的映射，
 * 不经过"切点 → 连续段"这层会丢信息的中转。
 *
 * @param turns - 轮次事实（按时间序）。
 * @param existingKeys - 已有的本地话题键，供模型复用（可选）。
 * @returns `{ system, user }`。
 */
export function buildAssignmentPrompt(turns, existingKeys = []) {
  const system = [
    '你在帮助把一段连续对话按话题分组。',
    '给你按时间排列的若干轮对话，为每一轮分配一个话题标签。',
    '规则：',
    '- 讲同一件事的轮次用**同一个**标签（原样重复那个标签）；',
    '- 换到另一件事时用新标签；',
    '- 之后又回到之前的某件事时，**必须复用**当初那个标签，不要新建；',
    '- 判断依据是这一轮实际在做什么，提问和回复都要看；',
    '- 标签用 2-6 个字的短词概括该话题，例如「插件设计」「数据库索引」「打包体积」。',
    '只输出一个 JSON 数组，长度与轮数一致，元素是标签字符串，不要任何解释。',
  ].join('\n')

  const body = turns.map((t, i) => {
    const label = `【第 ${i + 1} 轮 · 会话内第 ${t.turn} 轮】`
    const prompt = clip(t.prompt, PROMPT_BUDGET)
    // 带上回复摘要：只看提问，模型不知道这一轮到底做了什么。长会话里
    // 提问常是「继续」「就这样吧」，没有回复就完全无法判断话题。
    const reply = clip(t.response, REPLY_BUDGET)
    return reply === ''
      ? `${label}\n提问：${prompt}`
      : `${label}\n提问：${prompt}\n回复：${reply}`
  }).join('\n\n')

  const tail = existingKeys.length > 0
    ? `\n\n参考：本次已识别出这些话题，若某轮属于其中之一，请原样使用该标签：${existingKeys.join('、')}`
    : ''

  return {
    system,
    user: `${body}${tail}\n\n请输出长度 ${turns.length} 的 JSON 字符串数组。`,
  }
}

/**
 * 从一组轮次里提取"这一组在做什么"的摘要，供上层归并使用。
 *
 * 上层（工作流、阶段）拿到的必须是内容而不是标题：短标题没有上下文，
 * 模型只能凭字面猜，这正是上一版大类分不准的原因。
 *
 * @param turns - 该组的轮次事实。
 * @param budget - 总字符预算。
 * @returns 一段拼接的用户提问摘要。
 */
export function summarizeTurns(turns, budget = 120) {
  if (!Array.isArray(turns) || turns.length === 0) return ''
  const parts = []
  let used = 0
  for (const t of turns) {
    const text = String(t.prompt ?? '').replace(/\s+/g, ' ').trim()
    if (text === '') continue
    const room = budget - used
    if (room <= 4) break
    const piece = text.length <= room ? text : `${text.slice(0, room - 1)}…`
    parts.push(piece)
    used += piece.length + 1
  }
  return parts.join(' / ')
}

/**
 * 解析逐轮归属结果。
 *
 * 宽容处理常见偏差：代码围栏、前后解释文字、长度不符。
 * 长度不符时**整批作废**而不是截断——错位的标签会把整张图弄乱，
 * 那比"没有结果"糟得多。
 *
 * @param text - 模型输出。
 * @param expected - 期望的轮数。
 * @returns 标签数组，或 null（无法安全使用）。
 */
export function parseAssignment(text, expected) {
  // 用共享抽取器：能容忍"先说思路带方括号、再给答案"这类输出。
  const parsed = extractJsonArrayOfLength(text, expected)
  if (parsed === null) return null
  const out = []
  for (const item of parsed) {
    if (typeof item !== 'string' || item.trim() === '') return null
    out.push(item.trim())
  }
  return out
}

/**
 * 只保留最近 N 轮参与语义分析。
 *
 * 更早的轮次沿用本地规则——它们通常已经被本地正确地归并，而把整段历史
 * 都发给模型既贵又容易超出上下文。
 *
 * @param turns - 全部轮次。
 * @param limit - 上限。
 * @returns 参与分析的下标起点；0 表示全部参与。
 */
export function analysisWindowStart(turns, limit) {
  const n = Array.isArray(turns) ? turns.length : (typeof turns?.length === 'number' ? turns.length : 0)
  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_TURN_LIMIT
  if (n <= cap) return 0
  return n - cap
}
