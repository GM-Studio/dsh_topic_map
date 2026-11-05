/**
 * Turn model: fold a session's raw event log into one fact record per turn.
 *
 * A "turn" is one complete user input through to the agent finishing or being
 * stopped. `turn/start` is the anchor (not the prompt `user/message`): its seq
 * is what a history window pages back through, so a jump target built from it
 * lands on a complete turn.
 *
 * Everything here is pure: no I/O, no ctx, no clock beyond event times. That
 * makes the whole fold unit-testable against a fixture array.
 *
 * @module dsh-topic-map/turn-model
 */

/** Prompt preview budget, in characters after whitespace collapse. */
export const PROMPT_PREVIEW_LIMIT = 80

/** Response preview budget, in characters after whitespace collapse. */
export const RESPONSE_PREVIEW_LIMIT = 160

/**
 * Collapse whitespace and clip to a budget.
 *
 * Only `text` blocks contribute. Tool calls, reasoning, and image blocks are
 * deliberately skipped: a preview is there to help someone recognise a turn,
 * and a base64 image or a four-kilobyte tool argument does not do that.
 *
 * @param content - message content blocks, possibly absent.
 * @param limit - maximum characters in the result.
 * @returns the preview, or an empty string when nothing readable is present.
 */
export function previewText(content, limit) {
  if (!Array.isArray(content)) return ''
  const parts = []
  let seen = 0
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type !== 'text' || typeof block.text !== 'string') continue
    // Bound per block: one multi-megabyte message must not be concatenated
    // whole just to produce a 160-character preview.
    const slice = block.text.length > limit * 2 ? block.text.slice(0, limit * 2) : block.text
    parts.push(slice)
    seen += slice.length
    if (seen >= limit * 2) break
  }
  const text = parts.join(' ').replace(/\s+/g, ' ').trim()
  if (text.length <= limit) return text
  return `${text.slice(0, limit - 1).trimEnd()}…`
}

/**
 * Add one usage sample into a running total.
 *
 * The five buckets are mutually exclusive: `inputTokens` is the cache-MISS
 * portion, `cacheReadTokens` and `cacheWriteTokens` are separate buckets, and
 * `outputTokens` covers generation. They are therefore summed, never
 * de-duplicated. (Cross-checked against how dsh-cost-meter prices a turn: it
 * maps input→cacheMiss and charges each bucket at its own rate, and it sums
 * the three input-side buckets when testing a long-context threshold.)
 *
 * @param total - accumulator, mutated in place.
 * @param usage - one `assistant/message` usage payload, possibly absent.
 */
export function addUsage(total, usage) {
  if (!usage || typeof usage !== 'object') return
  total.input += num(usage.inputTokens)
  total.output += num(usage.outputTokens)
  total.cacheRead += num(usage.cacheReadTokens)
  total.cacheWrite += num(usage.cacheWriteTokens)
  total.reasoning += num(usage.reasoningTokens)
}

function num(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** A fresh zeroed usage accumulator. */
export function emptyUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
}

/** A fresh turn record. */
function newTurn(turn, startSeq, startTime) {
  return {
    turn,
    startSeq,
    endSeq: null,
    startTime,
    endTime: null,
    durationMs: null,
    prompt: '',
    response: '',
    usage: emptyUsage(),
    steps: 0,
    toolCalls: 0,
    steering: 0,
    interrupted: false,
    endReason: 'open',
    model: null,
    files: [],
    tools: [],
    commands: [],
  }
}

/**
 * Fold a session event log into per-turn facts.
 *
 * Events must be in ascending seq order. Unknown event types are ignored, so a
 * log written by a newer harness still folds.
 *
 * @param events - raw session events from `sessionQuery.listEvents`.
 * @returns the turn facts plus session-wide totals.
 */
export function buildTurnModel(events) {
  const turns = []
  let cur = null

  for (const ev of Array.isArray(events) ? events : []) {
    if (!ev || typeof ev !== 'object') continue
    const data = ev.data && typeof ev.data === 'object' ? ev.data : {}

    switch (ev.type) {
      case 'turn/start': {
        const n = Number(data.turn)
        if (!Number.isFinite(n) || n < 0) break
        // A retried boundary that does not advance keeps the earlier record:
        // the outline stays strictly increasing and the turn keeps its anchor.
        if (cur !== null && n <= cur.turn) {
          cur = turns[turns.length - 1] ?? null
          break
        }
        cur = newTurn(n, ev.seq, ev.time)
        turns.push(cur)
        break
      }

      case 'turn/end': {
        const n = Number(data.turn)
        if (cur === null || (Number.isFinite(n) && n !== cur.turn)) break
        cur.endSeq = ev.seq
        cur.endTime = ev.time
        cur.durationMs =
          typeof ev.time === 'number' && typeof cur.startTime === 'number'
            ? Math.max(0, ev.time - cur.startTime)
            : null
        cur.endReason = endReasonOf(data.reason)
        break
      }

      case 'user/message': {
        if (cur === null) break
        // System-prompt injections also arrive as user/message; only a human
        // message opens the turn or counts as steering.
        const source = data.source
        if (!source || source.kind !== 'user') break
        if (cur.prompt === '') cur.prompt = previewText(data.content, PROMPT_PREVIEW_LIMIT)
        else cur.steering += 1
        break
      }

      case 'assistant/message': {
        if (cur === null) break
        addUsage(cur.usage, data.usage)
        if (data.interrupted === true) cur.interrupted = true
        const text = previewText(data.message?.content, RESPONSE_PREVIEW_LIMIT)
        if (text !== '') cur.response = text
        if (cur.model === null) {
          const source = data.message?.source
          if (source && source.kind === 'model' && typeof source.provider === 'string') {
            cur.model = { provider: source.provider, model: String(source.model ?? '') }
          }
        }
        break
      }

      case 'step/start': {
        if (cur !== null) cur.steps += 1
        break
      }

      case 'tool/call': {
        if (cur === null) break
        cur.toolCalls += 1
        pushUnique(cur.tools, data.name)
        pushUnique(cur.commands, commandOf(data.arguments))
        for (const path of pathsOf(data.arguments)) pushUnique(cur.files, path)
        break
      }

      default:
        break
    }

    // Per-turn entity lists are bounded: one bulk edit can mention thousands of
    // paths, and an unbounded set makes the later similarity join quadratic.
    if (cur !== null) {
      if (cur.files.length > 24) cur.files.length = 24
      if (cur.tools.length > 16) cur.tools.length = 16
      if (cur.commands.length > 16) cur.commands.length = 16
    }
  }

  return { turns, totals: sumTotals(turns) }
}

/** Map a `turn/end` reason object onto a flat discriminator. */
function endReasonOf(reason) {
  if (!reason || typeof reason !== 'object') return 'completed'
  const kind = reason.kind
  if (
    kind === 'completed' ||
    kind === 'aborted' ||
    kind === 'blocked' ||
    kind === 'error' ||
    kind === 'max-tokens' ||
    kind === 'interrupted' ||
    kind === 'forked'
  ) {
    return kind
  }
  return 'completed'
}

function pushUnique(list, value) {
  if (typeof value !== 'string' || value === '') return
  if (!list.includes(value)) list.push(value)
}

/** Extract a `/command` token from a shell-style argument string. */
function commandOf(args) {
  if (typeof args !== 'string') return null
  let parsed
  try {
    parsed = JSON.parse(args)
  } catch {
    return null
  }
  const command = parsed?.command ?? parsed?.cmd
  if (typeof command !== 'string') return null
  const match = /(?:^|[;&|]\s*)(\/[a-z][\w-]*)/i.exec(command)
  return match ? match[1] : null
}

/** Extract plausible file paths from a tool argument string. */
const PATH_RE = /(?:[A-Za-z]:[\\/]|\/)[\w.\-/\\]{2,}\.[A-Za-z0-9]{1,8}\b/g

function pathsOf(args) {
  if (typeof args !== 'string') return []
  const found = args.match(PATH_RE)
  if (found === null) return []
  const out = []
  for (const raw of found) {
    const normalized = raw.replace(/\\\\/g, '\\')
    if (!out.includes(normalized)) out.push(normalized)
    if (out.length >= 8) break
  }
  return out
}

/** Session-wide totals across every turn. */
export function sumTotals(turns) {
  const usage = emptyUsage()
  let toolCalls = 0
  let durationMs = 0
  for (const t of turns) {
    usage.input += t.usage.input
    usage.output += t.usage.output
    usage.cacheRead += t.usage.cacheRead
    usage.cacheWrite += t.usage.cacheWrite
    usage.reasoning += t.usage.reasoning
    toolCalls += t.toolCalls
    durationMs += t.durationMs ?? 0
  }
  return { ...usage, turns: turns.length, toolCalls, durationMs }
}

/**
 * Running totals at each turn, for the hover card's "up to this turn" line.
 *
 * @param turns - turn facts in order.
 * @returns one cumulative usage record per turn, same length and order.
 */
export function cumulativeUsage(turns) {
  const out = []
  const running = emptyUsage()
  for (const t of turns) {
    running.input += t.usage.input
    running.output += t.usage.output
    running.cacheRead += t.usage.cacheRead
    running.cacheWrite += t.usage.cacheWrite
    running.reasoning += t.usage.reasoning
    out.push({ ...running })
  }
  return out
}
