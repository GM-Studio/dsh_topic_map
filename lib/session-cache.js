/**
 * In-memory session cache with a bounded, revision-keyed store.
 *
 * Three things must line up for a cached payload to be reusable: the session,
 * the log revision, and the engine version. Any of the three moving invalidates
 * it, which is what keeps a heuristic change from silently serving stale lanes.
 *
 * Capacity is small on purpose. A payload holds every turn's previews; keeping
 * dozens would cost far more memory than it saves in re-reads, and the user
 * only ever looks at one session at a time.
 *
 * @module dsh-topic-map/session-cache
 */

/** Maximum sessions retained. */
const CAPACITY = 8

export class SessionCache {
  /** @type {Map<string, {revision: string, engineVersion: number, payload: object}>} */
  #entries = new Map()

  /** @type {Map<string, object[]>} */
  #overrides = new Map()

  /**
   * Read a cached payload.
   *
   * @param sessionId - session key.
   * @param revision - current log revision.
   * @param engineVersion - current engine version.
   * @returns the payload, or undefined on any mismatch.
   */
  get(sessionId, revision, engineVersion) {
    const entry = this.#entries.get(sessionId)
    if (entry === undefined) return undefined
    if (entry.revision !== revision || entry.engineVersion !== engineVersion) {
      this.#entries.delete(sessionId)
      return undefined
    }
    // Refresh recency: Map preserves insertion order, so re-inserting at the
    // end makes the front of the map the least recently used entry.
    this.#entries.delete(sessionId)
    this.#entries.set(sessionId, entry)
    return entry.payload
  }

  /**
   * Read a cached payload without touching recency.
   * @param sessionId - session key.
   * @returns the payload when one is present, else undefined.
   */
  peek(sessionId) {
    return this.#entries.get(sessionId)?.payload
  }

  /**
   * Store a payload, evicting the least recently used entry.
   * @param sessionId - session key.
   * @param revision - log revision the payload was built from.
   * @param engineVersion - engine version the payload was built with.
   * @param payload - the payload.
   */
  set(sessionId, revision, engineVersion, payload) {
    this.#entries.delete(sessionId)
    this.#entries.set(sessionId, { revision, engineVersion, payload })
    while (this.#entries.size > CAPACITY) {
      const oldest = this.#entries.keys().next()
      if (oldest.done === true) break
      this.#entries.delete(oldest.value)
    }
  }

  /**
   * Human overrides recorded for a session.
   * @param sessionId - session key.
   * @returns the override list, empty when none were recorded.
   */
  overridesOf(sessionId) {
    return this.#overrides.get(sessionId) ?? []
  }

  /**
   * Append one human override.
   *
   * Overrides are append-only: the engine replays them in order, so a later
   * edit wins without needing to rewrite an earlier record. Dropping the cached
   * payload forces the next read to re-apply them.
   *
   * @param sessionId - session key.
   * @param override - the edit to record.
   */
  addOverride(sessionId, override) {
    const list = this.#overrides.get(sessionId)
    if (list === undefined) this.#overrides.set(sessionId, [override])
    else list.push(override)
    this.#entries.delete(sessionId)
  }
}
