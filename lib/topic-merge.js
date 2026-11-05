/**
 * 话题合并判断：这两条线是不是同一件事？
 *
 * 为什么需要模型：本地相似度只能比词面。"跳转定位"和"落点偏差"字面几乎不重合，
 * 但显然是同一件事的两个阶段；而"面板空白"和"面板配色"字面高度重合，
 * 却是两件不同的事。词面在这里系统性地失效。
 *
 * 与分段/归并的区别：那两个是"从无到有地建立结构"，这个是"检查已有结构是否重复"。
 * 所以提示词只给话题名 + 轮次摘要，要求回答"是否同一件事"，而不是重新划分。
 *
 * @module dsh-topic-map/topic-merge
 */

/** 一次最多比较多少对。太多了不如不分。 */
export const PAIR_LIMIT = 14

/** 摘要预算。 */
const SAMPLE_BUDGET = 100

function clip(text, budget) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  return s.length <= budget ? s : `${s.slice(0, budget - 1)}…`
}

/**
 * 从一组泳道里挑出"可能重复"的候选对。
 *
 * 不打全部组合（n² 会爆炸），而是用两个廉价信号先筛：
 *   1. 标题有字符交集（避免把毫不相干的配在一起）
 *   2. 时间上不完全隔离（相隔太远的多半是不同的事）
 *
 * @param lanes - 泳道数组（需 laneId/title/turns）。
 * @param limit - 上限。
 * @returns `[[laneA, laneB]]`。
 */
export function pickMergeCandidates(lanes, limit = PAIR_LIMIT) {
  const list = (Array.isArray(lanes) ? lanes : []).filter(
    l => Array.isArray(l.turns) && l.turns.length > 0 && typeof l.title === 'string',
  )

  const pairs = []
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const a = list[i]
      const b = list[j]

      // 时间隔离度：两段之间隔了多少轮
      const aMax = Math.max(...a.turns)
      const aMin = Math.min(...a.turns)
      const bMax = Math.max(...b.turns)
      const bMin = Math.min(...b.turns)
      const gap = Math.max(0, Math.max(aMin, bMin) - Math.min(aMax, bMax))

      // 标题字符重合（中文字符级，不用分词）
      const setA = new Set(a.title)
      let overlap = 0
      for (const ch of b.title) if (setA.has(ch)) overlap += 1
      const ratio = overlap / Math.max(1, Math.min(a.title.length, b.title.length))

      // 有明显字符重合、或时间上相邻/交错，才值得问模型
      const adjacent = gap <= 2
      if (ratio < 0.2 && !adjacent) continue

      pairs.push({ a, b, gap, ratio })
    }
  }

  // 优先问"最像"的：字符重合高或紧邻
  pairs.sort((x, y) => (y.ratio - x.ratio) || (x.gap - y.gap))
  return pairs.slice(0, limit).map(p => [p.a, p.b])
}

/**
 * 构造合并判断的提示词。
 *
 * 要求模型只回答"是同一件事吗"，并给出理由。刻意不要求它重新命名或重组——
 * 那是另一层的事，混在一起会让输出不稳定。
 *
 * @param pairs - `[[laneA, laneB]]`。
 * @param factOf - `(turn) => fact`，用于取摘要。
 * @returns `{ system, user }`。
 */
export function buildMergePrompt(pairs, factOf) {
  const system = [
    '你在帮助判断一段对话里，两段讨论是不是**同一件事**。',
    '判断标准是"用户想达成什么"，不是用词是否相似：',
    '- 同一件事的不同阶段（如"定位不到"和"定位准了"）→ 是同一件事',
    '- 同一领域的两件不同工作（如"画布局"和"调配色"）→ 不是同一件事',
    '- 后来回头继续做前面没做完的 → 是同一件事',
    '只输出 JSON 数组，长度与对数一致，元素是对象：{"same":true/false,"reason":"不超过 16 字"}。',
    '不要任何解释。',
  ].join('\n')

  const body = pairs.map((pair, i) => {
    const [a, b] = pair
    const desc = l => {
      const turns = Array.isArray(l.turns) ? l.turns : []
      const samples = turns.slice(0, 3)
        .map(t => {
          const f = typeof factOf === 'function' ? factOf(t) : undefined
          return f === undefined || f === null ? '' : clip(f.prompt, SAMPLE_BUDGET)
        })
        .filter(s => s !== '')
      const range = turns.length === 0 ? '' : `（T${turns[0]}–T${turns[turns.length - 1]}，${turns.length} 轮）`
      return `「${l.title}」${range}\n    内容：${samples.join(' / ') || '（无）'}`
    }
    return `${i + 1}.\n  A: ${desc(a)}\n  B: ${desc(b)}`
  }).join('\n\n')

  return {
    system,
    user: `以下是 ${pairs.length} 对话题，请逐一判断每对是否同一件事：\n\n${body}\n\n请输出长度 ${pairs.length} 的 JSON 数组。`,
  }
}

/**
 * 解析合并判断。
 *
 * 严格校验长度与字段：错位的判断会把两条不相干的话题并成一条，
 * 那比"没合并"糟得多。
 *
 * @param text - 模型输出。
 * @param expected - 期望对数。
 * @returns `[{ same, reason }]` 或 null。
 */
export function parseMergeVerdict(text, expected) {
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

  const out = []
  for (const item of parsed) {
    if (item === null || typeof item !== 'object') return null
    if (typeof item.same !== 'boolean') return null
    const reason = typeof item.reason === 'string' ? item.reason.trim().slice(0, 32) : ''
    out.push({ same: item.same, reason })
  }
  return out
}

/**
 * 把判定结果转成合并指令。
 *
 * @param pairs - `[[laneA, laneB]]`。
 * @param verdicts - `parseMergeVerdict` 的结果。
 * @returns `[{ keep, absorb, reason }]`：保留先出现的，吸收后出现的。
 */
export function toMergeInstructions(pairs, verdicts) {
  if (!Array.isArray(pairs) || !Array.isArray(verdicts) || pairs.length !== verdicts.length) {
    return []
  }
  const out = []
  const absorbed = new Set()
  for (let i = 0; i < pairs.length; i += 1) {
    if (verdicts[i].same !== true) continue
    const [a, b] = pairs[i]
    if (absorbed.has(a.laneId) || absorbed.has(b.laneId)) continue
    out.push({ keep: a.laneId, absorb: b.laneId, reason: verdicts[i].reason })
    absorbed.add(b.laneId)
  }
  return out
}
