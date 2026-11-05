/**
 * 状态复核：把"可疑"的任务交给模型判断，其余用本地硬证据。
 *
 * 为什么不全交模型：一条会话几十个任务，全问一遍既慢又贵，而大部分任务
 * 用硬证据（改过文件 + 之后转向别的话题）就能判得比较稳。
 *
 * 为什么不能只靠硬证据：工具信号看不见**内容**。一个任务"改了 5 次文件"
 * 可能是做成了，也可能是反复改都没对。这种事只有读到对话才知道。
 *
 * 所以：本地出初判 → 挑出可疑的 → 只问这几条。
 *
 * @module dsh-topic-map/status-review
 */

/** 一次最多复核多少条。太多了不如直接全问。 */
export const REVIEW_LIMIT = 12

/** 每条任务的提问预算。 */
const PROMPT_BUDGET = 150

/** 每条任务的回复预算。 */
const REPLY_BUDGET = 250

/** 截断。 */
function clip(text, budget) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  return s.length <= budget ? s : `${s.slice(0, budget - 1)}…`
}

/**
 * 挑出需要复核的任务。
 *
 * @param entries - `[{ laneId, title, state, basis, suspect, turns, evidence }]`。
 * @param limit - 上限。
 * @returns 被挑中的条目（不超过 limit）。
 */
export function pickSuspects(entries, limit = REVIEW_LIMIT) {
  const list = Array.isArray(entries) ? entries : []
  const suspects = list.filter(e => e !== null && e !== undefined && e.suspect === true)
  if (suspects.length <= limit) return suspects
  // 超限时优先"最可疑"的：有报错的、轮次多的、工具调用多的
  const score = e => {
    let s = 0
    if (e.evidence !== undefined && e.evidence.hasError) s += 100
    s += (e.evidence !== undefined ? e.evidence.turnCount : 0) * 2
    s += (e.evidence !== undefined ? Math.min(50, e.evidence.toolCalls) : 0)
    return s
  }
  return [...suspects].sort((a, b) => score(b) - score(a)).slice(0, limit)
}

/**
 * 构造复核提示词。
 *
 * 让模型只回答"完成/进行中/阻塞/待办 + 一句理由"，而不是自由描述：
 * 结构固定才能可靠解析，也便于和本地初判对齐比较。
 *
 * @param entries - 待复核条目（含 turns 与 evidence）。
 * @param turnFactOf - `(turn) => fact`，取提问与回复。
 * @returns `{ system, user }`。
 */
export function buildReviewPrompt(entries, turnFactOf) {
  const system = [
    '你在帮助判断一段开发对话里，每一项工作做到什么程度。',
    '给你若干项工作，每项包含：标题、它的对话内容摘要、以及客观信号（是否改过文件、轮次数、工具调用数）。',
    '为每一项判断状态，只能是这四个之一：',
    '- done：这件事做完了，要求已满足',
    '- active：正在做，有明显进展但还没收尾',
    '- blocked：卡住了、失败了、或被中断，需要处理',
    '- todo：还没真正开始',
    '判断要看**回复里实际做了什么**，而不是看用户提没提这件事。',
    '改了很多次但每次都失败，应该判 blocked 而不是 done。',
    '只输出 JSON 数组，长度与项数一致，元素是对象：{"state":"done","reason":"不超过 20 字"}。不要任何解释。',
  ].join('\n')

  const body = entries.map((e, i) => {
    const turns = Array.isArray(e.turns) ? e.turns : []
    const lines = turns.slice(0, 4).map(t => {
      const fact = typeof turnFactOf === 'function' ? turnFactOf(t) : undefined
      if (fact === undefined || fact === null) return ''
      const q = clip(fact.prompt, PROMPT_BUDGET)
      const a = clip(fact.response, REPLY_BUDGET)
      return `  T${t} 提问：${q}\n  T${t} 回复：${a}`
    }).filter(s => s !== '')
    const ev = e.evidence ?? {}
    const signals = [
      `轮次 ${ev.turnCount ?? turns.length}`,
      `工具 ${ev.toolCalls ?? 0} 次`,
      ev.hasOutput ? '有写操作' : '无写操作',
      ev.hasError ? `有报错（T${(ev.errorTurns ?? []).join('、')}）` : '无报错',
    ].join('，')
    return `${i + 1}. ${e.title}\n   信号：${signals}\n${lines.join('\n')}`
  }).join('\n\n')

  return {
    system,
    user: `以下是 ${entries.length} 项工作：\n\n${body}\n\n请输出长度 ${entries.length} 的 JSON 数组。`,
  }
}

/**
 * 解析复核结果。
 *
 * 严格校验长度并逐个检查状态值：错位的判断比没有判断更糟——它会把
 * 一个明明阻塞的任务显示成完成。
 *
 * @param text - 模型输出。
 * @param expected - 期望条数。
 * @returns `[{ state, reason }]` 或 null。
 */
export function parseReview(text, expected) {
  const raw = String(text ?? '')
  const start = raw.indexOf('[')
  const end = raw.lastIndexOf(']')
  if (start < 0 || end <= start) return null

  let parsed
  try {
    parsed = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return null
  }
  if (!Array.isArray(parsed) || parsed.length !== expected) return null

  const VALID = ['done', 'active', 'blocked', 'todo']
  const out = []
  for (const item of parsed) {
    if (item === null || typeof item !== 'object') return null
    const state = typeof item.state === 'string' ? item.state.trim().toLowerCase() : ''
    if (!VALID.includes(state)) return null
    const reason = typeof item.reason === 'string' ? item.reason.trim().slice(0, 40) : ''
    out.push({ state, reason })
  }
  return out
}

/**
 * 把复核结果合并回条目。
 *
 * 模型给出的状态优先，但保留本地初判作为对照——界面上要能回答
 * "这个结论是谁给的"。
 *
 * @param entries - 原始条目。
 * @param verdicts - `parseReview` 的结果。
 * @returns 新的条目列表（带 `review` 字段）。
 */
export function mergeReview(entries, verdicts) {
  const list = Array.isArray(entries) ? entries : []
  if (!Array.isArray(verdicts) || verdicts.length !== list.length) {
    return list.map(e => ({ ...e, review: null }))
  }
  return list.map((e, i) => ({
    ...e,
    review: {
      state: verdicts[i].state,
      reason: verdicts[i].reason,
    },
  }))
}
