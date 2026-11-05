/**
 * Graph topology: place topics on reusable tracks and emit drawable geometry.
 *
 * This is the git-graph model, not a swim-lane model. The difference that
 * matters is column RECYCLING: a topic occupies a track only while it is alive,
 * and a later topic may take that track over. Without recycling a long session
 * ends up with one full-width empty row per topic, which is exactly the failure
 * this module exists to avoid.
 *
 * Coordinates are emitted in TURN INDEX / COLUMN units, not pixels. The browser
 * half owns the pixels because only it knows the viewport width and zoom level;
 * this half owns the topology because that is the part with rules worth testing.
 *
 * @module dsh-topic-map/graph-layout
 */

/**
 * 为每条话题分配一行。
 *
 * 早先这里是"轨道回收"：时间不重叠的话题复用同一列，以减少纵向占用。
 * 实测证明那是错的——10 条话题里有 9 条被判"不重叠"，全挤到 col1，
 * 于是所有标签落在同一个 y 上互相覆盖，图也看不出层次。
 *
 * 现在**一话题一行**：纵向占用等于话题数，换来的是每个话题有独立的
 * 水平线、独立的标签位置。话题数通常 3-15，纵向完全放得下；
 * 真正需要压缩时靠缩放解决，而不是把不同话题叠在同一行。
 *
 * @param lanes - 话题，按显示顺序（阶段顺序在这里已经排好）。
 * @returns map from laneId to row。
 */
export function allocateColumns(lanes, indexOf) {
  const rowOf = new Map()
  let row = 0
  for (const lane of Array.isArray(lanes) ? lanes : []) {
    const idxs = laneTurns(lane).map(t => indexOf.get(t)).filter(n => n !== undefined)
    if (idxs.length === 0) continue
    rowOf.set(lane.laneId, row)
    row += 1
  }
  return rowOf
}

/** Every turn a topic touches: its own plus the ones it shares. */
function laneTurns(lane) {
  const own = Array.isArray(lane.turns) ? lane.turns : []
  const shared = Array.isArray(lane.sharedTurns) ? lane.sharedTurns : []
  if (shared.length === 0) return own
  return [...new Set([...own, ...shared])].sort((a, b) => a - b)
}

/**
 * Build the full topology for one session.
 *
 * @param turns - turn facts in order.
 * @param lanes - topics carrying `turns`, `sharedTurns`, `parentLaneId`, `title`.
 * @returns topology: nodes and edges in index/column units, plus track labels.
 */
export function buildGraph(turns, lanes) {
  const list = Array.isArray(turns) ? turns : []
  const topics = Array.isArray(lanes) ? lanes : []
  const indexOf = new Map()
  list.forEach((t, i) => indexOf.set(t.turn, i))

  const colOf = allocateColumns(topics, indexOf)
  let maxCol = -1
  for (const col of colOf.values()) if (col > maxCol) maxCol = col

  const nodes = []
  const seen = new Map()

  for (const lane of topics) {
    const col = colOf.get(lane.laneId)
    if (col === undefined) continue
    const own = new Set(Array.isArray(lane.turns) ? lane.turns : [])
    for (const turnNo of laneTurns(lane)) {
      const index = indexOf.get(turnNo)
      if (index === undefined) continue
      const key = `${index}:${col}`
      if (seen.has(key)) continue
      const node = {
        turn: turnNo,
        index,
        col,
        laneId: lane.laneId,
        primary: own.has(turnNo),
      }
      seen.set(key, node)
      nodes.push(node)
    }
  }

  // Reading order: by turn, then by track.
  nodes.sort((a, b) => a.index - b.index || a.col - b.col)

  const edges = []

  // 1. Within-topic continuity: one segment per adjacent pair.
  for (const lane of topics) {
    const col = colOf.get(lane.laneId)
    if (col === undefined) continue
    const idxs = laneTurns(lane).map(t => indexOf.get(t)).filter(n => n !== undefined)
    for (let k = 1; k < idxs.length; k += 1) {
      edges.push({
        kind: 'lane',
        laneId: lane.laneId,
        col,
        from: idxs[k - 1],
        to: idxs[k],
        // A jump means the topic was left and picked up again, so the renderer
        // can draw a resumed stretch differently from an unbroken one.
        gap: idxs[k] - idxs[k - 1] > 1,
      })
    }
  }

  // 2. Forks: from the parent's last turn before the child begins.
  for (const lane of topics) {
    if (!lane.parentLaneId) continue
    const childCol = colOf.get(lane.laneId)
    const parentCol = colOf.get(lane.parentLaneId)
    if (childCol === undefined || parentCol === undefined) continue
    const parent = topics.find(l => l.laneId === lane.parentLaneId)
    if (parent === undefined) continue

    const own = laneTurns(lane).map(t => indexOf.get(t)).filter(n => n !== undefined)
    if (own.length === 0) continue
    const childFrom = Math.min(...own)

    const parentIdxs = laneTurns(parent)
      .map(t => indexOf.get(t))
      .filter(n => n !== undefined && n < childFrom)
    if (parentIdxs.length === 0) continue
    const parentFrom = Math.max(...parentIdxs)

    edges.push({
      kind: 'fork',
      laneId: lane.laneId,
      parentLaneId: lane.parentLaneId,
      from: parentFrom,
      fromCol: parentCol,
      to: childFrom,
      toCol: childCol,
    })
  }

  // 3. Shared turns: a turn in two topics gets a node on each track, joined by
  //    a short tie so the double membership is visible rather than implied.
  const byIndex = new Map()
  for (const node of nodes) {
    const bucket = byIndex.get(node.index)
    if (bucket === undefined) byIndex.set(node.index, [node])
    else bucket.push(node)
  }
  for (const [, bucket] of byIndex) {
    if (bucket.length < 2) continue
    bucket.sort((a, b) => a.col - b.col)
    for (let k = 1; k < bucket.length; k += 1) {
      edges.push({
        kind: 'share',
        index: bucket[k - 1].index,
        fromCol: bucket[k - 1].col,
        toCol: bucket[k].col,
      })
    }
  }

  // 4. Track labels sit at each topic's final turn.
  const labels = []
  // 主线：第一个话题。它要画得比支线粗一点，一眼区分主次。
  let trunkLaneId = null
  for (const lane of topics) {
    if (laneTurns(lane).length > 0) { trunkLaneId = lane.laneId; break }
  }

  for (const lane of topics) {
    const col = colOf.get(lane.laneId)
    if (col === undefined) continue
    const idxs = laneTurns(lane).map(t => indexOf.get(t)).filter(n => n !== undefined)
    if (idxs.length === 0) continue
    labels.push({
      laneId: lane.laneId,
      col,
      index: Math.max(...idxs),
      text: lane.title,
      locked: lane.locked === true,
      turns: idxs.length,
      // 层级信息随标签一起下发：客户端在轨道左端画出「阶段 · 工作流」。
      category: typeof lane.category === 'string' ? lane.category : null,
      categoryIndex: Number.isInteger(lane.categoryIndex) ? lane.categoryIndex : -1,
      stageName: typeof lane.stageName === 'string' ? lane.stageName : null,
      workflowName: typeof lane.workflowName === 'string' ? lane.workflowName : null,
      // 主线/支线：客户端据此决定线宽与标签粗细
      role: lane.laneId === trunkLaneId ? 'trunk' : 'branch',
      // 合并来源（若有）：界面可显示"这条线由 A 和 B 合并而来"
      mergedFrom: Array.isArray(lane.mergedFrom) ? lane.mergedFrom : [],
    })
  }

  // 3. 合并：两条线在某一轮起不再分开时，从被吸收那条的最后一轮
  //    斜连到保留那条的对应轮。与 fork 方向相反，视觉上就是"汇回来"。
  for (const lane of topics) {
    if (!Array.isArray(lane.mergedFrom) || lane.mergedFrom.length === 0) continue
    const keepCol = colOf.get(lane.laneId)
    if (keepCol === undefined) continue
    const atTurns = Array.isArray(lane.mergedAt) ? lane.mergedAt : []
    for (let m = 0; m < lane.mergedFrom.length; m += 1) {
      const absorbed = topics.find(l => l.laneId === lane.mergedFrom[m])
      if (absorbed === undefined) continue
      const absorbedCol = colOf.get(absorbed.laneId)
      if (absorbedCol === undefined) continue
      const atTurn = Number.isFinite(atTurns[m]) ? atTurns[m] : null
      const atIndex = atTurn === null ? indexOf.get(Math.min(...laneTurns(absorbed))) : indexOf.get(atTurn)
      if (atIndex === undefined) continue
      edges.push({
        kind: 'merge',
        laneId: lane.laneId,
        absorbedLaneId: absorbed.laneId,
        from: atIndex,
        fromCol: absorbedCol,
        to: atIndex,
        toCol: keepCol,
      })
    }
  }

  return {
    turnCount: list.length,
    columnCount: maxCol + 1,
    columns: [...colOf].map(([laneId, col]) => ({ laneId, col })),
    nodes,
    edges,
    labels,
    // 主线 laneId：客户端用来决定哪条线画粗
    trunkLaneId,
  }
}
