/**
 * 会话归类：把一个工作区里的多个会话，按主题归成「大类 → 子类」两层。
 *
 * 为什么需要它：一个工作区里可能有上百个会话（实测某工作区 108 个），
 * 平铺列表没法看。人想知道的是"我在这个工作区里都在忙哪几件事"。
 *
 * 与话题分层的区别：
 *   - 话题分层（hierarchy.js）处理**一个会话内部**的轮次
 *   - 本模块处理**一个工作区内部**的会话
 *   两者都是"归并"，但输入规模与语义完全不同，所以不共用提示词。
 *
 * 与话题合并（topic-merge.js）的区别：
 *   - 合并是"判断两条是不是同一件事"（二分类）
 *   - 归类是"把 N 个会话分成 M 组"（多分类）
 *
 * @module dsh-topic-map/session-category
 */

import { extractJsonArray, extractJsonArrayOfLength, extractJsonField } from './model-output.js'

/** 大类数量建议区间。 */
export const CATEGORY_RANGE = [3, 6]

/** 每个大类下的子类数量上限。 */
export const SUBCATEGORY_LIMIT = 4

/** 一次最多归类多少会话（再多就先截断，避免上下文爆炸）。 */
export const SESSION_LIMIT = 200

/** 每个会话在提示词里的描述预算。 */
const DESC_BUDGET = 90

function clip(text, budget) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  return s.length <= budget ? s : `${s.slice(0, budget - 1)}…`
}

/**
 * 判断一个会话是不是子代理/机器人产生的。
 *
 * 为什么需要：实测某工作区 108 个会话里 86 个是子代理单轮会话
 * （日志开头是 `[dsh-mnemon:delegated review]`），它们不是人真正在推进的事。
 * 全都平铺会淹没真实对话。
 *
 * @param session - `{ title, firstPrompt }`。
 * @returns 是否像子代理会话。
 */
export function looksAutomated(session) {
  // ① 平台权威标记优先。
  //
  // 实测：当前 DSH 版本（session v4）里 `origin` 与 `delegationDepth`
  // 虽然写在类型定义中，实际日志里并不填充（是 undefined / 0）。
  // 所以这层必须保留，但不能只靠它——拿不到时要能退回正则。
  const origin = session?.origin
  if (origin === 'subagent') return true
  if (Number.isFinite(session?.delegationDepth) && session.delegationDepth > 0) return true

  // ② 正则兜底：子代理的提示词是模板化的角色设定
  const text = `${session?.title ?? ''} ${session?.firstPrompt ?? ''}`.toLowerCase()
  if (text.trim() === '') return false
  if (text.includes('dsh-mnemon')) return true
  if (text.includes('delegated review')) return true
  if (/^\s*\[[^\]]{1,40}\]\s*bounded/.test(text)) return true
  // 系统类消息：审批策略变更等
  if (/the approval policy changed from/.test(text)) return true
  if (/^the working directory is /.test(text)) return true
  return false
}

/**
 * 为归类准备会话描述。
 *
 * 只发标题 + 首轮提问的截断，不发全文——归类看的是"这件事是关于什么"，
 * 几轮对话就足够判断，发全文既贵又容易让模型纠结细节。
 *
 * @param sessions - `[{ sessionId, title, firstPrompt, turns }]`。
 * @param limit - 上限。
 * @returns `[{ id, name, sample, turns }]`。
 */
export function prepareSessions(sessions, limit = SESSION_LIMIT) {
  const list = Array.isArray(sessions) ? sessions : []
  return list.slice(0, limit).map(s => ({
    id: String(s.sessionId ?? ''),
    name: clip(s.title ?? s.sessionId ?? '', 60),
    sample: clip(s.firstPrompt ?? '', DESC_BUDGET),
    turns: Number(s.turns) || 0,
    automated: looksAutomated(s),
  }))
}

/**
 * 构造归类提示词。
 *
 * 让模型一次输出两层的扁平结果（大类 + 子类），而不是嵌套结构：
 * 嵌套容易编错括号与长度，扁平数组可以用长度校验兜住。
 *
 * @param items - `prepareSessions` 的输出。
 * @returns `{ system, user }`。
 */
export function buildCategoryPrompt(items) {
  const system = [
    '你在帮助把一个工作区里的多次对话，按主题归成「大类 → 子类」两层。',
    `大类代表一个大方向（例如"插件开发""技术调研""环境排障"），${CATEGORY_RANGE[0]}-${CATEGORY_RANGE[1]} 个为宜。`,
    `子类是某个大类下的具体分支（例如大类"插件开发"下有"话题地图""会话归档"），每个大类 1-${SUBCATEGORY_LIMIT} 个。`,
    '规则：',
    '- 按"这些对话在解决什么问题"归并，不要按时间或字数；',
    '- 子类名要能概括组内所有会话，用 2-8 个字；',
    '- 标了 [自动] 的是机器人/子代理产生的会话，可以单独归到一个"自动化任务"大类下；',
    '- 不要每一条都单独立成一个子类。',
    '只输出 JSON 数组，长度与会话数一致，元素是对象：{"category":"大类名","sub":"子类名"}。不要任何解释。',
  ].join('\n')

  const body = items.map((it, i) => {
    const flags = []
    if (it.automated) flags.push('自动')
    if (it.turns > 0) flags.push(`${it.turns} 轮`)
    const flag = flags.length > 0 ? ` [${flags.join(' · ')}]` : ''
    const sample = it.sample === '' ? '' : `\n   内容：${it.sample}`
    return `${i + 1}. ${it.name}${flag}${sample}`
  }).join('\n')

  return {
    system,
    user: `以下是 ${items.length} 个会话：\n\n${body}\n\n请输出长度 ${items.length} 的 JSON 数组，每个元素含 category 与 sub。`,
  }
}


/**
 * 解析归类结果。
 *
 * 严格校验长度：错位的归类会把会话放到错误的组里，那比"没归类"糟得多——
 * 用户会以为自己找错地方了。
 *
 * @param text - 模型输出。
 * @param expected - 期望条数。
 * @returns `[{ category, sub }]` 或 null。
 */
export function parseCategories(text, expected) {
  // 共享抽取器已校验长度，这里不再重复
  const parsed = extractJsonArrayOfLength(text, expected)
  if (parsed === null) return null

  const out = []
  for (const item of parsed) {
    if (item === null || typeof item !== 'object') return null
    const category = typeof item.category === 'string' ? item.category.trim() : ''
    const sub = typeof item.sub === 'string' ? item.sub.trim() : ''
    if (category === '' || sub === '') return null
    out.push({ category: category.slice(0, 24), sub: sub.slice(0, 24) })
  }
  return out
}

/**
 * 把归类结果组装成两层树。
 *
 * 保持首次出现顺序：大类的顺序由它第一个会话的位置决定，子类同理。
 * 这样列表的排列与时间线一致，用户扫一眼能对上"先做的在上面"。
 *
 * @param items - `prepareSessions` 的输出（含 id/name/turns/automated）。
 * @param labels - `parseCategories` 的结果。
 * @returns `[{ name, count, subcategories: [{ name, sessions: [...] }] }]`。
 */
export function buildCategoryTree(items, labels) {
  if (!Array.isArray(items) || !Array.isArray(labels) || items.length !== labels.length) {
    return []
  }

  const order = []
  const byCategory = new Map()

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i]
    const { category, sub } = labels[i]

    if (!byCategory.has(category)) {
      byCategory.set(category, { name: category, count: 0, subOrder: [], subs: new Map() })
      order.push(category)
    }
    const cat = byCategory.get(category)
    cat.count += 1

    if (!cat.subs.has(sub)) {
      cat.subs.set(sub, { name: sub, sessions: [] })
      cat.subOrder.push(sub)
    }
    cat.subs.get(sub).sessions.push({
      sessionId: item.id,
      title: item.name,
      turns: item.turns,
      automated: item.automated === true,
    })
  }

  return order.map(name => {
    const cat = byCategory.get(name)
    return {
      name: cat.name,
      count: cat.count,
      subcategories: cat.subOrder.map(s => cat.subs.get(s)),
    }
  })
}

/**
 * 不可用时的兜底：按"是否自动会话"粗分两组。
 *
 * 模型不可用时不该让整个列表不可用——至少让用户能区分真实对话与机器人噪音。
 *
 * @param items - `prepareSessions` 的输出。
 * @returns 两层树。
 */
export function fallbackTree(items) {
  const list = Array.isArray(items) ? items : []
  const human = { name: '真实对话', sessions: [] }
  const auto = { name: '自动化任务', sessions: [] }
  for (const it of list) {
    const target = it.automated ? auto : human
    target.sessions.push({
      sessionId: it.id,
      title: it.name,
      turns: it.turns,
      automated: it.automated === true,
    })
  }
  const out = []
  if (human.sessions.length > 0) {
    out.push({ name: '未归类', count: human.sessions.length, subcategories: [human] })
  }
  if (auto.sessions.length > 0) {
    out.push({ name: '自动化任务', count: auto.sessions.length, subcategories: [auto] })
  }
  return out
}

/**
 * 在树里按关键字过滤。
 *
 * 匹配范围：大类名、子类名、会话标题。正文匹配由 Host 侧的全文检索负责，
 * 这里只管已经拿到手的结构化数据。
 *
 * @param tree - `buildCategoryTree` 的输出。
 * @param query - 关键字（空则原样返回）。
 * @returns 过滤后的树（只保留有命中的分支）。
 */
export function filterTree(tree, query) {
  const q = String(query ?? '').trim().toLowerCase()
  if (q === '') return tree
  const out = []
  for (const cat of Array.isArray(tree) ? tree : []) {
    const catHit = cat.name.toLowerCase().includes(q)
    const subs = []
    let count = 0
    for (const sub of cat.subcategories ?? []) {
      const subHit = sub.name.toLowerCase().includes(q)
      const sessions = (sub.sessions ?? []).filter(s =>
        catHit || subHit || String(s.title).toLowerCase().includes(q))
      if (sessions.length > 0) {
        subs.push({ ...sub, sessions })
        count += sessions.length
      }
    }
    if (subs.length > 0) out.push({ ...cat, count, subcategories: subs })
  }
  return out
}

/**
 * 把会话切成若干批。
 *
 * 为什么要分批：一次让模型归 500 个会话，输出几百条 JSON 极易错位
 * （本实现严格校验长度，错位就整批作废）。分批后每批独立成败，
 * 某批失败不影响其他批。
 *
 * @param items - `prepareSessions` 的输出。
 * @param size - 每批条数。
 * @returns 二维数组。
 */
export function splitIntoBatches(items, size = 100) {
  const list = Array.isArray(items) ? items : []
  const n = Number.isFinite(size) && size > 0 ? Math.floor(size) : 100
  const out = []
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n))
  return out
}

/**
 * 合并多批归类结果为一棵树。
 *
 * 问题：各批独立归类时，同一件事可能被不同批起了不同名字
 * （第一批叫"插件开发"，第二批叫"插件研发"），直接拼起来会很乱。
 *
 * 做法：调用方先用模型把各批的**大类名**归并成一张映射表，再传进来。
 * 没有映射表时原样保留（至少不会丢会话）。
 *
 * @param batchTrees - 每批的 `buildCategoryTree` 结果。
 * @param renameMap - 旧名 → 新名。
 * @returns 合并后的树。
 */
export function mergeBatchTrees(batchTrees, renameMap = null) {
  const trees = Array.isArray(batchTrees) ? batchTrees : []
  const rename = renameMap instanceof Map ? renameMap : new Map()

  const order = []
  const byCategory = new Map()

  for (const tree of trees) {
    for (const cat of Array.isArray(tree) ? tree : []) {
      const name = rename.get(cat.name) ?? cat.name

      if (!byCategory.has(name)) {
        byCategory.set(name, { name, count: 0, subOrder: [], subs: new Map() })
        order.push(name)
      }
      const target = byCategory.get(name)
      target.count += cat.count ?? 0

      for (const sub of cat.subcategories ?? []) {
        // 子类名也做同样的归一（各批可能给同一小组起了不同名字）
        const subName = rename.get(sub.name) ?? sub.name
        if (!target.subs.has(subName)) {
          target.subs.set(subName, { name: subName, sessions: [] })
          target.subOrder.push(subName)
        }
        target.subs.get(subName).sessions.push(...(sub.sessions ?? []))
      }
    }
  }

  return order.map(name => {
    const c = byCategory.get(name)
    return {
      name: c.name,
      count: c.count,
      subcategories: c.subOrder.map(s => c.subs.get(s)),
    }
  })
}

/**
 * 收集一批树里所有的大类 / 子类名（用于让模型做名称归一）。
 *
 * @param batchTrees - 各批的树。
 * @returns `{ categories, subs }` 去重后的名字数组。
 */
export function collectNames(batchTrees) {
  const categories = new Set()
  const subs = new Set()
  for (const tree of Array.isArray(batchTrees) ? batchTrees : []) {
    for (const cat of Array.isArray(tree) ? tree : []) {
      categories.add(cat.name)
      for (const sub of cat.subcategories ?? []) subs.add(sub.name)
    }
  }
  return { categories: [...categories], subs: [...subs] }
}

/**
 * 构造"名称归一"的提示词。
 *
 * 只让模型做一件事：把意思相同的名字合成一个。不要求它重新归类。
 *
 * @param names - 名字数组。
 * @param level - 'category' | 'sub'。
 * @returns `{ system, user }`。
 */
export function buildRenamePrompt(names, level) {
  const list = Array.isArray(names) ? names : []
  const what = level === 'sub' ? '子类名' : '大类名'
  const system = [
    `你在帮助合并${what}里的重复项。`,
    '有些名字意思相同但用词不同（例如"插件开发"与"插件研发"、"环境排障"与"环境与部署"）。',
    `请把每个名字映射到一个规范名。规范名要短（2-8 个字），并尽量复用已有名字。`,
    `只输出 JSON 数组，长度 ${list.length}，每个元素是字符串（该位置对应的规范名）。`,
    '不要解释。',
  ].join('\n')
  const body = list.map((n, i) => `${i + 1}. ${n}`).join('\n')
  return { system, user: `以下是 ${list.length} 个${what}：\n\n${body}\n\n请输出长度 ${list.length} 的字符串数组。` }
}

/**
 * 解析名称归一结果。
 *
 * @param text - 模型输出。
 * @param expected - 期望长度。
 * @returns Map<旧名, 新名> 或 null。
 */
export function parseRenameMap(text, expected, names) {
  const parsed = extractJsonArrayOfLength(text, expected)
  if (parsed === null) return null
  const list = Array.isArray(names) ? names : []
  if (list.length !== expected) return null

  const map = new Map()
  for (let i = 0; i < parsed.length; i += 1) {
    const next = typeof parsed[i] === 'string' ? parsed[i].trim() : ''
    if (next === '') return null
    map.set(list[i], next.slice(0, 24))
  }
  return map
}
