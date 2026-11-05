/**
 * Lane engine: group a session's turns into topical swim lanes.
 *
 * The output is a set of "lanes" — one per topic — where each lane owns a
 * non-contiguous list of turns. That non-contiguity is the whole point: when a
 * session returns to an earlier subject after forty unrelated turns, those
 * turns belong to the same lane, drawn as a long connector in the panel.
 *
 * Everything is pure and deterministic: same input, same lanes. Autos are
 * advisory — the caller applies human overrides afterwards, unconditionally.
 *
 * @module dsh-topic-map/lane-engine
 */

/** Bump when the fold changes shape, so caches keyed on it must refetch. */
export const ENGINE_VERSION = 4

/**
 * Coarse threshold: a boundary here starts a new TOPIC.
 *
 * Deliberately loose. A topic is "what this stretch of work is about", not "the
 * particular point under discussion" — three turns of designing the same panel
 * belong to one topic even though each turn raises a different question. Cutting
 * at this level first is what makes the map read as a small number of projects
 * rather than a spray of discussion points.
 */
export const DEFAULT_THRESHOLD = 0.2

/**
 * Fine threshold: a boundary inside a topic starts a SUBTOPIC.
 *
 * Applied only within a topic's turn range, so a subtopic can never cross a
 * topic boundary. Higher than the coarse bar because the turns inside one topic
 * are already related — inside that context, a split has to be sharper to be
 * worth drawing.
 */
export const DEFAULT_SUBTOPIC_THRESHOLD = 0.35

/** Minimum turns on each side of a boundary. */
const MIN_SEGMENT = 2

/**
 * Term overlap needed to treat a turn as returning to an existing lane.
 *
 * High on purpose. Two unrelated subjects that mention the same repository
 * still share a handful of nouns, so a low bar would collapse the whole map
 * into one lane. A genuine return shares most of its vocabulary.
 */
const RESUME_OVERLAP = 0.55

/**
 * Overlap at which a short run is considered the same thing as its predecessor.
 *
 * High, and applied to whole-run term sets rather than windows: this is a
 * near-duplicate test, not a similarity test. See `absorbShortRuns`.
 */
const NEAR_DUPLICATE = 0.8

/**
 * Overlap at which an earlier topic is a better parent than the previous one.
 *
 * Used only to upgrade the default parent (the topic that just ended) to a more
 * informative one. It does not gate whether a fork exists at all — see
 * `pickParent`.
 */
const RELATED_OVERLAP = 0.3

/** Back-reference cues that suggest a return to an earlier topic. */
const BACKREF = [
  /回到(刚才|上面|前面)/,
  /接(着|回)(上面|前面|刚才)/,
  /继续(前面|上面|第\s*\d+\s*点)/,
  /还是(那个|刚才那个)/,
  /之前(那个|说的)/,
  /\bback to\b/i,
  /\bas we discussed\b/i,
  /\bcontinuing from\b/i,
  /\bthe previous\b/i,
]

/** Words carrying no topical signal; kept deliberately short. */
const STOP = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'has', 'was', 'were',
  'are', 'you', 'your', 'can', 'will', 'would', 'should', 'could', 'but', 'not',
  '的', '了', '是', '在', '我', '你', '他', '它', '这', '那', '和', '与', '就',
  '也', '都', '要', '会', '把', '被', '给', '让', '吗', '呢', '吧', '啊',
])

/**
 * Tokenize mixed Chinese/English text into topical terms.
 *
 * Chinese has no spaces, so character bigrams stand in for words; Latin runs
 * become lowercase words. Crude, but it is what makes the similarity test work
 * on the same text a user actually types.
 *
 * @param text - any prose.
 * @returns distinct terms.
 */
export function tokenize(text) {
  if (typeof text !== 'string' || text === '') return []
  const terms = new Set()
  for (const word of text.toLowerCase().match(/[a-z][a-z0-9_-]{1,}/g) ?? []) {
    if (!STOP.has(word) && word.length >= 2) terms.add(word)
  }
  const han = text.match(/[\u4e00-\u9fff]+/g) ?? []
  for (const run of han) {
    if (run.length === 1) {
      if (!STOP.has(run)) terms.add(run)
      continue
    }
    for (let i = 0; i + 1 < run.length; i += 1) {
      const bigram = run.slice(i, i + 2)
      if (!STOP.has(bigram)) terms.add(bigram)
    }
  }
  return [...terms]
}

/** Jaccard similarity of two sets; 0 when either is empty. */
export function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  for (const value of small) if (large.has(value)) shared += 1
  return shared / (a.size + b.size - shared)
}

/** Cosine similarity of two sparse weight maps. */
function cosine(a, b) {
  let dot = 0
  let na = 0
  let nb = 0
  for (const [term, weight] of a) {
    na += weight * weight
    const other = b.get(term)
    if (other !== undefined) dot += weight * other
  }
  for (const weight of b.values()) nb += weight * weight
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/**
 * Build TF-IDF vectors for every turn.
 * @param turns - turn facts carrying `prompt` and `response`.
 * @returns one vector per turn, plus the raw term sets.
 */
function vectorize(turns) {
  const docs = turns.map(t => tokenize(`${t.prompt} ${t.response}`))
  const df = new Map()
  for (const doc of docs) {
    for (const term of new Set(doc)) df.set(term, (df.get(term) ?? 0) + 1)
  }
  const n = Math.max(1, docs.length)
  const vectors = docs.map(doc => {
    const tf = new Map()
    for (const term of doc) tf.set(term, (tf.get(term) ?? 0) + 1)
    const vec = new Map()
    for (const [term, count] of tf) {
      const idf = Math.log((n + 1) / ((df.get(term) ?? 1) + 1)) + 1
      vec.set(term, (1 + Math.log(count)) * idf)
    }
    return vec
  })
  return { vectors, termSets: docs.map(doc => new Set(doc)) }
}

/** Entity set for a turn, used as the second similarity signal. */
function entitySet(turn) {
  return new Set([
    ...(turn.files ?? []).map(p => p.toLowerCase()),
    ...(turn.tools ?? []).map(t => `tool:${t}`),
    ...(turn.commands ?? []).map(c => `cmd:${c}`),
  ])
}

/** Composite similarity between two turn windows. */
function windowSimilarity(left, right, vectors, entitySets) {
  const a = aggregate(left, vectors)
  const b = aggregate(right, vectors)
  const textSim = cosine(a, b)

  const ea = new Set()
  const eb = new Set()
  for (const i of left) for (const v of entitySets[i]) ea.add(v)
  for (const i of right) for (const v of entitySets[i]) eb.add(v)

  // The entity signal only carries information when at least one side has any.
  // Weighting it unconditionally would cap the composite score at the text
  // weight whenever a stretch of plain conversation mentions no file, tool, or
  // command — and a cap sitting at the threshold means every such boundary is
  // declared a topic change. Weight is therefore redistributed when absent.
  if (ea.size === 0 && eb.size === 0) return textSim
  return 0.55 * textSim + 0.45 * jaccard(ea, eb)
}

function aggregate(indexes, vectors) {
  const sum = new Map()
  for (const i of indexes) {
    for (const [term, weight] of vectors[i]) sum.set(term, (sum.get(term) ?? 0) + weight)
  }
  return sum
}

/** Top terms of a window, ordered by weight. */
function topTerms(indexes, vectors, limit = 12) {
  const sum = aggregate(indexes, vectors)
  return [...sum.entries()]
    .sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))
    .slice(0, limit)
    .map(([term]) => term)
}

/** Structural anchors that force a boundary regardless of similarity. */
function forcedBoundary(turn, prev) {
  if (prev === null) return false
  // A compaction rewrites the model's context, so continuity across it is not
  // trustworthy; start fresh rather than bridging unrelated halves.
  if (turn.afterCompaction === true) return true
  const prevCmd = prev.commands[0] ?? null
  const curCmd = turn.commands[0] ?? null
  if (prevCmd !== null && curCmd !== null && prevCmd !== curCmd) return true
  return false
}

/**
 * Decide whether a turn starts a new topic or resumes an existing one.
 *
 * Resume needs real term overlap with an existing lane — the content must
 * genuinely be about the same thing. A back-reference cue ("回到刚才", "as we
 * discussed") makes the case stronger, but is NOT required: people returning to
 * a subject usually just… continue it, without announcing the return. Demanding
 * the cue would mean the map only recognises returns the user was polite enough
 * to label, which is precisely the case that needs no help.
 *
 * The overlap bar is therefore the load-bearing test, and it is set high
 * (0.55) so that merely sharing repository nouns is not enough.
 *
 * @param turn - the turn that may resume an earlier topic.
 * @param termSet - its top-term set.
 * @param entityTerms - its entity terms.
 * @param lanes - lanes built so far.
 * @returns the lane to resume and the score, or null for a new lane.
 */
function findResumeTarget(turn, termSet, entityTerms, lanes) {
  const own = new Set([...termSet, ...entityTerms])
  if (own.size === 0) return null
  const cue = BACKREF.some(re => re.test(turn.prompt))
  const bar = cue ? 0.35 : RESUME_OVERLAP

  let best = null
  let bestScore = 0
  for (const lane of lanes) {
    if (lane.turnIndexes.length < MIN_SEGMENT) continue
    const laneTerms = new Set([...lane.terms, ...lane.entityTerms])
    const score = jaccard(own, laneTerms)
    if (score >= bar && score > bestScore) {
      best = lane
      bestScore = score
    }
  }
  return best === null ? null : { lane: best, score: bestScore, cue }
}

/**
 * Pick the topic a new one forks from.
 *
 * In a git graph a branch always forks from *somewhere*: the branch that was
 * checked out at that moment. A topic tree is the same — a new subject starts
 * where the previous one was, even when the two share no vocabulary at all
 * ("stop working on rendering, let's fix the database"). Vocabulary overlap is
 * therefore only used to pick a BETTER parent when one genuinely exists; the
 * previous topic is the fallback, never nothing.
 *
 * Returning null here would leave the fork undrawn and strand the topic on
 * whatever column it landed in, which is exactly the flat-lines failure the
 * panel is supposed to avoid.
 *
 * @param own - the new topic's combined term set.
 * @param lanes - topics built so far, in order.
 * @returns the parent topic (always defined once any topic exists).
 */
function pickParent(own, lanes) {
  if (lanes.length === 0) return null

  let best = null
  let bestScore = 0
  for (const lane of lanes) {
    const laneTerms = new Set([...lane.terms, ...lane.entityTerms])
    const score = jaccard(own, laneTerms)
    if (score > bestScore) {
      best = lane
      bestScore = score
    }
  }
  // A clearly related earlier topic makes the more informative parent.
  if (best !== null && bestScore >= RELATED_OVERLAP) {
    return { lane: best, score: bestScore, byRelatedness: true }
  }
  // Otherwise fork from the topic that just ended: that is where the work
  // actually stood when this one began.
  const previous = lanes[lanes.length - 1]
  return { lane: previous, score: bestScore, byRelatedness: false }
}

/** Human-readable title, zero model calls. */
function titleOf(turn, terms) {
  const firstLine = turn.prompt.replace(/\s+/g, ' ').trim()
  if (firstLine !== '') return firstLine.length > 24 ? `${firstLine.slice(0, 23)}…` : firstLine
  if (terms.length > 0) return terms.slice(0, 3).join('·')
  return `第 ${turn.turn} 轮`
}

/**
 * Cut a turn range into runs at a given similarity threshold.
 *
 * Shared by both levels: the coarse pass runs it over the whole log, the fine
 * pass runs it over one topic's slice. Structural anchors always cut, because a
 * compaction or a working-directory change is a real discontinuity no similarity
 * score should be allowed to smooth over.
 *
 * @param from - first turn index of the range (inclusive).
 * @param to - last turn index of the range (inclusive).
 * @param threshold - similarity below which a boundary is declared.
 * @param turns - all turn facts.
 * @param vectors - TF-IDF vectors, indexed like `turns`.
 * @param entitySets - entity sets, indexed like `turns`.
 * @returns contiguous runs as inclusive index pairs.
 */
function cutRuns(from, to, threshold, turns, vectors, entitySets) {
  const runs = []
  let start = from
  for (let i = from + 1; i <= to; i += 1) {
    const leftIdx = range(Math.max(from, i - MIN_SEGMENT), i)
    const rightIdx = range(i, Math.min(to + 1, i + MIN_SEGMENT))
    if (leftIdx.length < MIN_SEGMENT || rightIdx.length < MIN_SEGMENT) continue
    if (forcedBoundary(turns[i], turns[i - 1])) {
      runs.push({ from: start, to: i - 1 })
      start = i
      continue
    }
    if (windowSimilarity(leftIdx, rightIdx, vectors, entitySets) < threshold) {
      runs.push({ from: start, to: i - 1 })
      start = i
    }
  }
  runs.push({ from: start, to })
  return runs
}

/**
 * Absorb runs too short to stand alone.
 *
 * A one-turn run is sometimes a genuine tangent inside a larger topic ("wait,
 * what about X?"), and promoting every such aside to its own lane sprays the
 * map with single dots. But a one-turn run is also how a short, complete topic
 * looks — "now go implement it" is one turn and a whole phase.
 *
 * The discriminator is therefore near-duplication, not family resemblance: a
 * single turn is folded into its predecessor only when the two are almost the
 * same text. Using a low bar here would silently undo the boundaries the coarse
 * pass just found, because turns inside one project always share vocabulary
 * even when they discuss different things.
 *
 * @param runs - contiguous runs.
 * @param termSets - term sets, indexed like the turns.
 * @returns runs with near-duplicate short ones absorbed.
 */
function absorbShortRuns(runs, termSets) {
  const merged = []
  for (const run of runs) {
    const length = run.to - run.from + 1
    const prev = merged[merged.length - 1]
    if (prev === undefined || length >= MIN_SEGMENT) {
      merged.push({ ...run })
      continue
    }
    const prevIdx = range(prev.from, prev.to + 1)
    const curIdx = range(run.from, run.to + 1)
    if (jaccard(termSetOf(prevIdx, termSets), termSetOf(curIdx, termSets)) >= NEAR_DUPLICATE) {
      prev.to = run.to
      continue
    }
    merged.push({ ...run })
  }
  return merged
}

/**
 * Build the two-level lane tree for one session.
 *
 * Level 1 (lanes) groups turns into topics at the coarse threshold.
 * Level 2 (each lane's `subtopics`) cuts the same turns again at the fine
 * threshold, strictly inside that lane's range so a subtopic can never span two
 * topics.
 *
 * The two levels describe different questions and both are kept: the topic is
 * "which project was this", the subtopic is "which part of it". Collapsing them
 * into one level forces a choice between a map that is too fragmented and one
 * that hides real work.
 *
 * @param model - result of `buildTurnModel`.
 * @param options - threshold overrides, plus an optional `cuts` set of turn
 *   indexes at which a topic boundary is forced or cancelled (semantic pass).
 * @returns lanes in first-appearance order, each with subtopics and segments.
 */
export function assignLanes(model, options = {}) {
  const coarse = Number.isFinite(options.threshold) ? options.threshold : DEFAULT_THRESHOLD
  const fine = Number.isFinite(options.subtopicThreshold)
    ? options.subtopicThreshold
    : DEFAULT_SUBTOPIC_THRESHOLD
  const turns = Array.isArray(model?.turns) ? model.turns : []
  if (turns.length === 0) return []

  const { vectors, termSets } = vectorize(turns)
  const entitySets = turns.map(entitySet)

  /**
   * 外部给定的切断集合（来自模型判定）。
   *
   * 语义分段要能**增加**也能**取消**切口，所以传进来的是完整边界集合，
   * 而不是"额外加几刀"。其余计算（归属、子话题、共享轮次）全部复用本地
   * 逻辑——两套流程走同一段代码，才不会画出两种不同结构的图。
   */
  const forcedCuts = options.cuts instanceof Set ? options.cuts : null

  // ── Level 1: topics ──────────────────────────────────────────────
  let topicRuns
  if (forcedCuts !== null) {
    // 用给定边界直接切连续段，不再按相似度判断。
    topicRuns = runsFromCuts(forcedCuts, turns.length)
  } else {
    topicRuns = absorbShortRuns(
      cutRuns(0, turns.length - 1, coarse, turns, vectors, entitySets),
      termSets,
    )
  }

  const lanes = []
  for (const run of topicRuns) {
    const idxs = range(run.from, run.to + 1)
    const terms = topTerms(idxs, vectors)
    const entityTerms = [...new Set(idxs.flatMap(i => [...entitySets[i]]))].slice(0, 24)
    const head = turns[run.from]
    const own = termSetOf(idxs, termSets)
    const ownPlusEntities = new Set([...own, ...entityTerms])

    // 外部切断是权威判定：调用方（语义分段）已经决定这里要分开，
    // 就不能再被"回游"启发式合回去，否则用户看到的还是旧结构。
    const resume = forcedCuts === null
      ? findResumeTarget(head, own, entityTerms, lanes)
      : null
    if (resume !== null) {
      resume.lane.segments.push({
        startSeq: head.startSeq,
        endSeq: turns[run.to].endSeq ?? turns[run.to].startSeq,
        kind: 'resumed',
      })
      resume.lane.turnIndexes.push(...idxs)
      resume.lane.terms = topTerms(resume.lane.turnIndexes, vectors)
      resume.lane.entityTerms = [
        ...new Set([...resume.lane.entityTerms, ...entityTerms]),
      ].slice(0, 24)
      continue
    }
    const parent = pickParent(ownPlusEntities, lanes)
    lanes.push({
      laneId: `${model.sessionId ?? 'session'}:L${head.startSeq}`,
      title: titleOf(head, terms),
      titleSource: 'keywords',
      parentLaneId: parent === null ? null : parent.lane.laneId,
      origin: 'heuristic',
      locked: false,
      confidence: parent === null ? 1 : Math.max(0.4, 1 - parent.score),
      terms,
      entityTerms,
      turnIndexes: [...idxs],
      segments: [
        {
          startSeq: head.startSeq,
          endSeq: turns[run.to].endSeq ?? turns[run.to].startSeq,
          kind: 'contiguous',
        },
      ],
      relatedLaneId: parent === null || !parent.byRelatedness ? null : parent.lane.laneId,
    })
  }

  // ── 共享轮次：一轮同时讲了两件事 ──────────────────────────────────
  // A turn can belong to two topics at once ("add search to the panel, and
  // change the DB index while you're there"). The run cut can only place it in
  // one, so the second membership is recovered here: if a turn's own terms
  // overlap a DIFFERENT topic strongly, that topic also claims the turn.
  //
  // Membership is recorded separately from `turnIndexes` so the primary owner
  // stays unambiguous — the graph draws the turn on both tracks, but anything
  // that needs "which topic is this turn mainly about" still has one answer.
  const SHARE_OVERLAP = 0.6
  for (const lane of lanes) {
    lane.sharedTurns = []
  }
  for (let i = 0; i < turns.length; i += 1) {
    const owner = lanes.find(l => l.turnIndexes.includes(i))
    if (owner === undefined) continue
    const own = termSetOf([i], termSets)
    const ownEntities = new Set([...own, ...entitySets[i]])
    if (ownEntities.size === 0) continue

    for (const other of lanes) {
      if (other === owner) continue
      if (other.turnIndexes.includes(i)) continue
      // A topic must exist on both sides of the turn to be a genuine
      // co-membership rather than an accidental vocabulary echo.
      const before = other.turnIndexes.some(j => j < i)
      const after = other.turnIndexes.some(j => j > i)
      if (!before && !after) continue
      const score = jaccard(ownEntities, new Set([...other.terms, ...other.entityTerms]))
      if (score >= SHARE_OVERLAP) other.sharedTurns.push(turns[i].turn)
    }
  }

  // ── Level 2: subtopics inside each topic ─────────────────────────
  // Runs over the lane's own index list rather than raw turn numbers, so a lane
  // whose turns are non-contiguous (a resumed topic) still cuts sensibly within
  // each stretch.
  for (const lane of lanes) {
    lane.subtopics = buildSubtopics(lane.turnIndexes, fine, turns, vectors, entitySets, termSets)
  }

  return lanes.map((lane, index) => ({
    laneId: lane.laneId,
    title: lane.title,
    titleSource: lane.titleSource,
    parentLaneId: lane.parentLaneId,
    origin: lane.origin,
    locked: lane.locked,
    confidence: lane.confidence,
    keywords: lane.terms,
    relatedLaneId: lane.relatedLaneId,
    segments: lane.segments,
    subtopics: lane.subtopics,
    turns: lane.turnIndexes.map(i => turns[i].turn),
    sharedTurns: lane.sharedTurns ?? [],
    row: index,
  }))
}

/**
 * Cut one lane's turns into subtopics.
 *
 * A lane with no marked boundary yields a single subtopic, so callers never have
 * to special-case "no subtopics" versus "one subtopic".
 *
 * @param turnIndexes - the lane's turn indexes, ascending.
 * @param threshold - subtopic boundary threshold.
 * @param turns - all turn facts.
 * @param vectors - TF-IDF vectors.
 * @param entitySets - entity sets.
 * @param termSets - term sets.
 * @returns subtopic records with title, turns, and confidence.
 */
function buildSubtopics(turnIndexes, threshold, turns, vectors, entitySets, termSets) {
  if (turnIndexes.length === 0) return []

  // Group the lane's indexes into contiguous stretches first: a resumed lane
  // has gaps, and a "run" spanning a gap would be meaningless.
  const stretches = []
  let start = 0
  for (let i = 1; i < turnIndexes.length; i += 1) {
    if (turnIndexes[i] !== turnIndexes[i - 1] + 1) {
      stretches.push([start, i - 1])
      start = i
    }
  }
  stretches.push([start, turnIndexes.length - 1])

  const out = []
  for (const [a, b] of stretches) {
    // Map back to global turn indexes so the shared cut helpers apply.
    const globalFrom = turnIndexes[a]
    const globalTo = turnIndexes[b]
    const runs = absorbShortRuns(
      cutRuns(globalFrom, globalTo, threshold, turns, vectors, entitySets),
      termSets,
    )
    for (const run of runs) {
      const idxs = range(run.from, run.to + 1)
      const terms = topTerms(idxs, vectors, 8)
      out.push({
        title: titleOf(turns[run.from], terms),
        turns: idxs.map(i => turns[i].turn),
        startSeq: turns[run.from].startSeq,
        endSeq: turns[run.to].endSeq ?? turns[run.to].startSeq,
        keywords: terms,
      })
    }
  }
  return out
}

function range(from, toExclusive) {
  const out = []
  for (let i = from; i < toExclusive; i += 1) out.push(i)
  return out
}

/**
 * 由"每一轮属于哪个话题"直接构建泳道。
 *
 * 这是语义分段的正确入口。切断点只能表达"在这里分开"，表达不了"这一轮
 * 回到三节前那条线"——而后者正是长会话里最常见、也最需要被画出来的形态。
 *
 * 因此模型给出的归属是一张**逐轮标签表**，本函数据此聚合：
 * 同一标签的所有轮次归入同一条泳道，不论它们在时间上是否连续；不连续的
 * 就是 `resumed` 区段，图上会画成长连线。
 *
 * @param model - 轮次模型（`{ turns, sessionId }`）。
 * @param assignment - 数组，长度与 turns 相同，值是该轮的话题键（字符串）。
 * @param meta - 可选：`{ titles: Map<key, string> }` 自定义标题。
 * @returns 泳道列表，格式与 `assignLanes` 一致。
 */
export function lanesFromAssignment(model, assignment, meta = {}) {
  const turns = Array.isArray(model?.turns) ? model.turns : []
  if (turns.length === 0) return []
  if (!Array.isArray(assignment) || assignment.length !== turns.length) return []

  const { vectors, termSets } = vectorize(turns)
  const entitySets = turns.map(entitySet)

  // 按首次出现顺序收集每个话题的轮次下标。
  const order = []
  const groups = new Map()
  for (let i = 0; i < assignment.length; i += 1) {
    const key = String(assignment[i] ?? '')
    if (key === '') continue
    if (!groups.has(key)) {
      groups.set(key, [])
      order.push(key)
    }
    groups.get(key).push(i)
  }

  const lanes = []
  order.forEach((key, laneIndex) => {
    const idxs = groups.get(key)
    if (idxs.length === 0) return
    const terms = topTerms(idxs, vectors)
    const entityTerms = [...new Set(idxs.flatMap(i => [...entitySets[i]]))].slice(0, 24)
    const head = turns[idxs[0]]

    // 区段：把连续的轮次合成一段，断开的地方就是 resumed。
    const segments = []
    let segStart = 0
    for (let k = 1; k <= idxs.length; k += 1) {
      const broken = k === idxs.length || idxs[k] !== idxs[k - 1] + 1
      if (!broken) continue
      const from = turns[idxs[segStart]]
      const to = turns[idxs[k - 1]]
      segments.push({
        startSeq: from.startSeq,
        endSeq: to.endSeq ?? to.startSeq,
        kind: segStart === 0 ? 'contiguous' : 'resumed',
      })
      segStart = k
    }

    const custom = meta.titles instanceof Map ? meta.titles.get(key) : undefined
    lanes.push({
      laneId: `${model.sessionId ?? 'session'}:S${head.startSeq}`,
      title: typeof custom === 'string' && custom !== '' ? custom : titleOf(head, terms),
      titleSource: typeof custom === 'string' && custom !== '' ? 'semantic' : 'keywords',
      parentLaneId: laneIndex === 0 ? null : lanes[0].laneId,
      origin: 'semantic',
      locked: false,
      confidence: 1,
      terms,
      entityTerms,
      turnIndexes: [...idxs],
      segments,
      subtopics: [],
      sharedTurns: [],
      nodeKey: key,
    })
  })

  // 子话题：在每个话题内部再按语义阈切成段（复用同一套细阈值）。
  for (const lane of lanes) {
    lane.subtopics = buildSubtopics(lane.turnIndexes, DEFAULT_SUBTOPIC_THRESHOLD, turns, vectors, entitySets, termSets)
  }

  return lanes.map((lane, index) => ({
    laneId: lane.laneId,
    title: lane.title,
    titleSource: lane.titleSource,
    parentLaneId: lane.parentLaneId,
    origin: lane.origin,
    locked: lane.locked,
    confidence: lane.confidence,
    keywords: lane.terms,
    relatedLaneId: null,
    segments: lane.segments,
    subtopics: lane.subtopics,
    turns: lane.turnIndexes.map(i => turns[i].turn),
    sharedTurns: lane.sharedTurns,
    nodeKey: lane.nodeKey,
    row: index,
  }))
}

/**
 * 由显式切断集合生成连续段。
 *
 * `cuts` 里放的是"该轮开启新话题"的轮次下标。0 与越界值会被忽略——
 * 第一轮必然是新话题的开头，不需要也不允许在此切。
 *
 * @param cuts - 切断下标集合。
 * @param turnCount - 总轮次。
 * @returns 连续段列表（含首尾）。
 */
export function runsFromCuts(cuts, turnCount) {
  const points = [...cuts]
    .filter(i => Number.isInteger(i) && i > 0 && i < turnCount)
    .sort((a, b) => a - b)
  const runs = []
  let start = 0
  for (const point of points) {
    runs.push({ from: start, to: point - 1 })
    start = point
  }
  runs.push({ from: start, to: turnCount - 1 })
  return runs
}

/**
 * 由连续段反推切断集合，供"本地结果"交给模型作起点。
 * @param runs - 连续段。
 * @returns 切断下标集合。
 */
export function cutsFromRuns(runs) {
  const cuts = new Set()
  for (const run of Array.isArray(runs) ? runs : []) {
    if (run.from > 0) cuts.add(run.from)
  }
  return cuts
}

function termSetOf(indexes, termSets) {
  const out = new Set()
  for (const i of indexes) for (const term of termSets[i]) out.add(term)
  return out
}

/**
 * Apply human overrides on top of autos.
 *
 * Autos never win: a locked lane keeps its turns, a renamed lane keeps its
 * title, and an explicit assignment moves a turn regardless of what the
 * heuristic decided.
 *
 * @param lanes - engine output.
 * @param overrides - persisted human edits.
 * @returns new lanes with overrides applied.
 */
export function applyOverrides(lanes, overrides) {
  if (!Array.isArray(overrides) || overrides.length === 0) return lanes
  let next = lanes.map(lane => ({ ...lane, segments: [...lane.segments], turns: [...lane.turns] }))

  for (const override of overrides) {
    if (!override || typeof override !== 'object') continue
    const lane = next.find(l => l.laneId === override.laneId)

    if (override.kind === 'rename' && lane !== undefined) {
      lane.title = String(override.title ?? lane.title)
      lane.titleSource = 'user'
      continue
    }
    if (override.kind === 'lock' && lane !== undefined) {
      lane.locked = override.locked === true
      continue
    }
    if (override.kind === 'move' && lane !== undefined && Number.isFinite(override.turn)) {
      for (const other of next) {
        if (other === lane) continue
        const at = other.turns.indexOf(override.turn)
        if (at >= 0) {
          other.turns.splice(at, 1)
          if (other.turns.length === 0) other.hidden = true
        }
      }
      if (!lane.turns.includes(override.turn)) {
        lane.turns.push(override.turn)
        lane.turns.sort((a, b) => a - b)
      }
      continue
    }
  }

  next = next.filter(lane => lane.hidden !== true)
  return next.map((lane, index) => ({ ...lane, row: index }))
}
