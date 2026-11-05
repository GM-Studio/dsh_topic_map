/**
 * 话题图：把"话题"当成分支，算出分叉、合并、主线、相关性。
 *
 * 这是这个插件真正的核心——不是统计，而是**关系**。
 *
 * 与 git 的对应关系：
 *
 *   git                   话题图
 *   ───────────────────────────────────────────
 *   commit                一轮对话
 *   branch                一个话题（泳道）
 *   fork / 新分支          从某话题斜出新线
 *   merge commit          两条线汇成一条
 *   空提交（同时属于）     一轮同时属于两个话题 → 双点
 *   master / main         主线（本实现：**第一个话题**）
 *   feature branch        支线
 *
 * 关键区别：git 的分支是并行的，话题的分支是**串行**的（人在同一时间只聊一件事）。
 * 所以图的横轴仍是时间，分支只是在时间线上"斜出"和"汇回"。
 *
 * @module dsh-topic-map/topic-graph
 */

/**
 * 话题之间的关系类型。
 */
export const RELATION = {
  /** A 在某轮之后斜出新线 B（B 从 A 分出）。 */
  fork: 'fork',
  /** A 与 B 在某一轮汇成一条（此后不再分开）。 */
  merge: 'merge',
  /** A 的内容与 B 相似，但时间上不相邻——"这两个有关"。 */
  related: 'related',
  /** 同一轮同时属于 A 与 B（双点）。 */
  shared: 'shared',
}

/**
 * 找主线：第一个话题（你选的规则）。
 *
 * 为什么是"第一个"而不是"最长"：会话总是从某件事开始，那件事就是原始目标；
 * 后面所有话题都是从它延伸出去的。用"最长"会把中途插入的杂事当主线，反而失真。
 *
 * @param lanes - 泳道数组（按首次出现排序）。
 * @returns 主线的 laneId，或 null。
 */
export function findTrunk(lanes) {
  const list = Array.isArray(lanes) ? lanes : []
  for (const lane of list) {
    if (Array.isArray(lane.turns) && lane.turns.length > 0) return lane.laneId
  }
  return null
}

/**
 * 标记每条泳道是主线还是支线。
 *
 * @param lanes - 泳道数组。
 * @returns Map<laneId, 'trunk' | 'branch'>。
 */
export function classifyBranches(lanes) {
  const trunk = findTrunk(lanes)
  const out = new Map()
  for (const lane of Array.isArray(lanes) ? lanes : []) {
    out.set(lane.laneId, lane.laneId === trunk ? 'trunk' : 'branch')
  }
  return out
}

/**
 * 找合并点：两条线在某一轮之后不再分开。
 *
 * 判定依据是**同一轮归属多个话题**，且此后两者都只出现在这一组里。
 * 也就是：从某个 turn 起，A 和 B 的轮次集合完全重合。
 *
 * 为什么不用"名字相同"：合并是结构事实，应该从轮次归属推出来，
 * 而不是靠模型改个名字——名字是展示，归属是数据。
 *
 * @param lanes - 泳道数组。
 * @returns `[{ keep, absorb, atTurn }]`：absorb 并入 keep，汇合点是 atTurn。
 */
export function findMerges(lanes) {
  const list = (Array.isArray(lanes) ? lanes : []).filter(
    l => Array.isArray(l.turns) && l.turns.length > 0,
  )
  const out = []
  const absorbed = new Set()

  for (let i = 0; i < list.length; i += 1) {
    const a = list[i]
    if (absorbed.has(a.laneId)) continue
    const aTurns = new Set(a.turns.map(Number))

    for (let j = i + 1; j < list.length; j += 1) {
      const b = list[j]
      if (absorbed.has(b.laneId)) continue
      const bTurns = b.turns.map(Number)

      // 找出 a 中同时出现在 b 里的轮次（共享点）
      const shared = bTurns.filter(t => aTurns.has(t)).sort((x, y) => x - y)
      if (shared.length === 0) continue

      const atTurn = shared[0]
      // 共享点之后，b 的每个轮次是否都还在 a 里？不是则不算"汇合"。
      const bAfter = bTurns.filter(t => t >= atTurn)
      const allSharedAfter = bAfter.every(t => aTurns.has(t))
      if (!allSharedAfter) continue

      // a 在 atTurn 之后若还有独有轮次，说明 a 仍在单独延续——那是"共享"不是"合并"
      const aAfter = [...aTurns].filter(t => t > atTurn)
      const aAfterShared = aAfter.filter(t => bTurns.includes(t))
      if (aAfter.length > 0 && aAfterShared.length < aAfter.length) continue

      out.push({ keep: a.laneId, absorb: b.laneId, atTurn })
      absorbed.add(b.laneId)
      break
    }
  }
  return out
}

/**
 * 应用合并：把被吸收的线并进保留的那条。
 *
 * 合并后的名字两个都显示（你选的），用「A / B」形式。
 *
 * @param lanes - 泳道数组。
 * @param merges - `findMerges` 的结果。
 * @returns 新的泳道数组（不修改入参）。
 */
export function applyMerges(lanes, merges) {
  const list = Array.isArray(lanes) ? lanes : []
  const byId = new Map(merges.map(m => [m.absorb, m]))
  const out = []

  for (const lane of list) {
    const hit = byId.get(lane.laneId)
    if (hit !== undefined) continue   // 被吸收的线不再单独存在

    const mine = merges.filter(m => m.keep === lane.laneId)
    if (mine.length === 0) {
      out.push({ ...lane })
      continue
    }

    // 合并名字与轮次
    const names = [lane.title]
    const turns = new Set((lane.turns ?? []).map(Number))
    for (const m of mine) {
      const other = list.find(l => l.laneId === m.absorb)
      if (other !== undefined) {
        names.push(other.title)
        for (const t of (other.turns ?? [])) turns.add(Number(t))
      }
    }
    out.push({
      ...lane,
      title: names.join(' / '),
      mergedFrom: mine.map(m => m.absorb),
      mergedAt: mine.map(m => m.atTurn),
      turns: [...turns].sort((a, b) => a - b),
    })
  }
  return out
}

/**
 * 计算话题之间的相关性（用于画虚连线）。
 *
 * 与"合并"的区别：
 *   - 合并：结构上就是同一条线（轮次重合）
 *   - 相关：内容相似，但各自独立成线
 *
 * 这里只做**结构层**的筛选：谁和谁在时间上不重叠、但词面/实体有交集。
 * 具体相似度由调用方传入（复用 lane-engine 的算法），避免重复实现。
 *
 * @param lanes - 泳道数组。
 * @param similarityOf - `(a, b) => number`，0..1。
 * @param threshold - 判定为相关的阈值。
 * @returns `[{ a, b, score }]`，按分数降序，每对只出现一次。
 */
export function findRelated(lanes, similarityOf, threshold = 0.28) {
  const list = (Array.isArray(lanes) ? lanes : []).filter(
    l => Array.isArray(l.turns) && l.turns.length > 0,
  )
  if (typeof similarityOf !== 'function') return []

  const out = []
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const a = list[i]
      const b = list[j]
      const score = Number(similarityOf(a, b))
      if (!Number.isFinite(score) || score < threshold) continue
      out.push({ a: a.laneId, b: b.laneId, score })
    }
  }
  // 分数高的先画，界面可以只取前 N 条避免糊成一片
  out.sort((x, y) => y.score - x.score)
  return out
}

/**
 * 按"相对阈值"从候选里挑出相关性提示。
 *
 * 为什么不用绝对阈值：中文标题是长短不一的长句，Jaccard 绝对值普遍偏低
 * （实测某 22 话题的会话里最高只有 0.139）。写死 0.3 这样的门槛，在有的
 * 数据上一条都选不出来，在另一些数据上又会选出一堆噪音。
 *
 * 相对阈值的做法：先取最高分，再要求达到它的一个比例。这样"这份数据里
 * 相对最像的那几条"总能被选出来，跨数据规模与语言都稳定。
 *
 * @param pairs - `findRelated(..., 0)` 的结果（已按分数降序）。
 * @param options - `{ floor, ratio, limit }`。
 * @returns 过滤后的候选。
 */
export function pickTopRelated(pairs, options = {}) {
  const list = Array.isArray(pairs) ? pairs : []
  if (list.length === 0) return []

  const floor = Number.isFinite(options.floor) ? options.floor : 0.08
  const ratio = Number.isFinite(options.ratio) ? options.ratio : 0.45
  const limit = Number.isFinite(options.limit) ? options.limit : 12

  const top = list[0].score
  if (!Number.isFinite(top) || top <= 0) return []

  const cutoff = Math.max(floor, top * ratio)
  return list.filter(p => Number.isFinite(p.score) && p.score >= cutoff).slice(0, limit)
}

/**
 * 找出"一轮属于多个话题"的双点。
 *
 * 与 merge 的区别：merge 是**此后并成一条**；shared 只是**这一轮两个话题都在讲**，
 * 之后仍各走各的。图上画成"同一位置两个点 + 短连线"。
 *
 * @param lanes - 泳道数组。
 * @returns Map<turn, laneId[]>，只含出现 2 次以上的轮次。
 */
export function findSharedTurns(lanes) {
  const byTurn = new Map()
  for (const lane of Array.isArray(lanes) ? lanes : []) {
    for (const t of (Array.isArray(lane.turns) ? lane.turns : [])) {
      const key = Number(t)
      const arr = byTurn.get(key) ?? []
      arr.push(lane.laneId)
      byTurn.set(key, arr)
    }
  }
  const out = new Map()
  for (const [turn, laneIds] of byTurn) {
    if (laneIds.length > 1) out.set(turn, laneIds)
  }
  return out
}

/**
 * 从某话题分出的支线（fork 关系）。
 *
 * 判定：B 的第一轮紧接在 A 的某个轮次之后，且 B 的 parentLaneId 指向 A（若有），
 * 或 B 首轮之前最近的是 A 的轮次。
 *
 * @param lanes - 泳道数组。
 * @returns `[{ parent, child, atTurn }]`。
 */
export function findForks(lanes) {
  const list = (Array.isArray(lanes) ? lanes : []).filter(
    l => Array.isArray(l.turns) && l.turns.length > 0,
  )
  // 轮次 → 泳道
  const owner = new Map()
  for (const lane of list) {
    for (const t of lane.turns) owner.set(Number(t), lane.laneId)
  }

  const out = []
  for (const lane of list) {
    const first = Math.min(...lane.turns.map(Number))
    // 显式父级优先
    if (typeof lane.parentLaneId === 'string' && lane.parentLaneId !== '') {
      const parent = list.find(l => l.laneId === lane.parentLaneId)
      if (parent !== undefined && Number.isFinite(first - 1)) {
        out.push({ parent: parent.laneId, child: lane.laneId, atTurn: first - 1 })
        continue
      }
    }
    // 否则看它首轮的前一轮属于谁
    const prevOwner = owner.get(first - 1)
    if (prevOwner !== undefined && prevOwner !== lane.laneId) {
      out.push({ parent: prevOwner, child: lane.laneId, atTurn: first - 1 })
    }
  }
  return out
}
