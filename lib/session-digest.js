/**
 * 会话提炼：把一个会话压缩成"一句话主题 + 关键词"。
 *
 * 这是跨会话归类的**第一步**。
 *
 * 为什么要有这一步：
 *   直接让模型"给 32 个会话分类"，它要同时做两件事——理解每个会话
 *   在讲什么，以及把它们分组。两件事挤在一次判断里，模型容易被
 *   表面词汇带偏（"都提到插件"就归一类，其实一个是开发一个是调研）。
 *
 *   先提炼成一句话，第二步只看这 32 句话来分类。信息密度高、噪声少，
 *   分类质量明显更稳。
 *
 * 副产品：这句话本身就是很好的列表摘要与搜索素材——比原始的
 * "首轮提问前 90 字"可读得多。
 *
 * @module dsh-topic-map/session-digest
 */

/** 每个会话在提示词里的正文预算。 */
export const DIGEST_BUDGET = 100

/** 长会话的采样上限：超过这个轮数就均匀采样。 */
export const SAMPLE_LIMIT = 10

/** 超过多少轮算"长会话"。 */
export const LONG_SESSION = 20

function clip(text, budget) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  return s.length <= budget ? s : `${s.slice(0, budget - 1)}…`
}

/**
 * 从轮次里挑出要展示给模型的样本。
 *
 * 为什么要采样而不是全给：轮次差别极大（1 轮到 51 轮）。一个 51 轮的
 * 会话全给会吃掉几千 token，挤占其他会话的预算，而"它在讲什么"
 * 其实前中后各看几轮就够判断了。
 *
 * 采样策略：首 3 轮 + 中间均匀取 + 尾 2 轮。首尾都保留是因为
 * 开场定主题、结尾往往有结论。
 *
 * @param turns - 轮次事实数组（已按时间排序）。
 * @param limit - 最多取几轮。
 * @returns 采样后的轮次数组。
 */
export function sampleTurns(turns, limit = SAMPLE_LIMIT) {
  const list = Array.isArray(turns) ? turns : []
  const n = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : SAMPLE_LIMIT
  if (list.length <= n) return list.slice()

  const head = list.slice(0, 3)
  const tail = list.slice(-2)
  const middleCount = n - head.length - tail.length
  if (middleCount <= 0) return [...head, ...tail].slice(0, n)

  const middle = []
  const start = 3
  const end = list.length - 2
  const span = end - start
  for (let i = 0; i < middleCount; i += 1) {
    const at = start + Math.round((span * (i + 0.5)) / middleCount)
    if (at >= start && at < end) middle.push(list[at])
  }
  return [...head, ...middle, ...tail]
}

/**
 * 为一个会话准备提炼输入。
 *
 * @param session - `{ sessionId, title, turns }`，turns 是轮次事实。
 * @returns `{ id, name, turns, samples }`。
 */
export function prepareDigestInput(session) {
  const facts = Array.isArray(session?.turns) ? session.turns : []
  const count = facts.length
  // 短会话全给；长会话采样
  const picked = count > LONG_SESSION ? sampleTurns(facts, SAMPLE_LIMIT) : facts

  const samples = picked.map(t => {
    const p = clip(t.prompt ?? '', DIGEST_BUDGET)
    const r = clip(t.response ?? '', Math.floor(DIGEST_BUDGET * 0.6))
    return r === '' ? p : `${p}（答：${r}）`
  }).filter(s => s !== '')

  return {
    id: String(session?.sessionId ?? ''),
    name: clip(session?.title ?? '', 60),
    turns: count,
    samples,
  }
}

/**
 * 构造提炼提示词。
 *
 * 要求输出严格的结构化结果：一句话 + 关键词。刻意不让模型同时分类——
 * 那是第二步的事，混在一起会降低两边的质量。
 *
 * @param items - `prepareDigestInput` 的输出数组。
 * @returns `{ system, user }`。
 */
export function buildDigestPrompt(items) {
  const list = Array.isArray(items) ? items : []

  const system = [
    '你在帮助把多段对话各自压缩成一句话主题。',
    '要求：',
    '- 一句话说清"这段对话在解决什么问题"，不超过 30 字；',
    '- 不要写"讨论了…"，直接写做的事，例如"修复话题地图跳转定位不准"；',
    '- 再给 2-4 个关键词，用于后续归类；',
    '- 如果对话明显是同一个任务的多个阶段，主题要体现最终目标而不是中间过程。',
    '只输出 JSON 数组，长度与会话数一致，元素：{"topic":"一句话","keywords":["词1","词2"]}。',
    '不要任何解释。',
  ].join('\n')

  const body = list.map((it, i) => {
    const head = `${i + 1}. ${it.name}（${it.turns} 轮）`
    if (it.samples.length === 0) return head
    return `${head}\n${it.samples.map(s => `   · ${s}`).join('\n')}`
  }).join('\n\n')

  return {
    system,
    user: `以下是 ${list.length} 段对话：\n\n${body}\n\n请输出长度 ${list.length} 的 JSON 数组。`,
  }
}

/**
 * 解析提炼结果。
 *
 * 长度必须严格一致：错位会把"一句话主题"安到别的会话上，
 * 后续分类就全错了。
 *
 * @param text - 模型输出。
 * @param expected - 期望条数。
 * @returns `[{ topic, keywords }]` 或 null。
 */
export function parseDigest(text, expected) {
  const raw = String(text ?? '').replace(/```[a-zA-Z]*\n?/g, '')
  const from = raw.indexOf('[')
  const to = raw.lastIndexOf(']')
  if (from < 0 || to <= from) return null

  let parsed
  try {
    parsed = JSON.parse(raw.slice(from, to + 1))
  } catch {
    return null
  }
  if (!Array.isArray(parsed) || parsed.length !== expected) return null

  const out = []
  for (const item of parsed) {
    if (item === null || typeof item !== 'object') return null
    const topic = typeof item.topic === 'string' ? item.topic.trim() : ''
    if (topic === '') return null
    const keywords = Array.isArray(item.keywords)
      ? item.keywords.filter(k => typeof k === 'string' && k.trim() !== '').map(k => k.trim().slice(0, 16)).slice(0, 4)
      : []
    out.push({ topic: topic.slice(0, 60), keywords })
  }
  return out
}

/**
 * 把提炼结果合回会话列表。
 *
 * @param items - `prepareDigestInput` 的输出（含 id/name/turns）。
 * @param digests - `parseDigest` 的结果。
 * @returns 带 topic/keywords 的会话数组；长度不符返回 null。
 */
export function applyDigest(items, digests) {
  if (!Array.isArray(items) || !Array.isArray(digests)) return null
  if (items.length !== digests.length) return null
  return items.map((it, i) => ({
    ...it,
    topic: digests[i].topic,
    keywords: digests[i].keywords,
  }))
}

/**
 * 把提炼结果转成"给分类步骤看的描述"。
 *
 * 分类时不再需要原始对话内容：一句话主题 + 关键词已经是高质量摘要。
 * 这正是两阶段方案省 token 又更准的原因。
 *
 * @param digested - `applyDigest` 的输出。
 * @returns `[{ id, name, sample, turns }]`，可直接喂给 buildCategoryPrompt。
 */
export function toCategoryInput(digested) {
  const list = Array.isArray(digested) ? digested : []
  return list.map(it => ({
    id: it.id,
    name: it.name,
    // sample 是分类步骤唯一能看到的"内容"，用主题 + 关键词拼成
    sample: it.keywords.length > 0
      ? `${it.topic}（${it.keywords.join('、')}）`
      : it.topic,
    turns: it.turns,
  }))
}
