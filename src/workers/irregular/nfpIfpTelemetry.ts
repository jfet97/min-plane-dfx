/**
 * Opt-in counters for the NFP/IFP cache path.
 *
 * Every recorded quantity is an integer count and no recorder reads a clock.
 * Enabled counters still add work inside deadline-sensitive loops, so parity
 * with an uninstrumented run must be verified empirically. Timing is excluded
 * because an inner-loop timer would add substantially more disturbance.
 *
 * When telemetry is disabled — which is always, in production — every recorder
 * is a single `undefined` comparison against a module-level binding and
 * allocates nothing.
 *
 * This module intentionally has no imports. It is written to be safe to call
 * from the innermost loops of the geometry layer.
 */

/** Per-namespace tallies for one `GeometryCache` backing store. */
export interface NfpIfpCacheNamespaceCounters {
  /** Lookups issued. */
  readonly getCalls: number
  /** Lookups that returned a defined value, valid or stale. */
  readonly getPresent: number
  /** Stores issued, one per lookup that produced a fresh value. */
  readonly setCalls: number
  /** Removals issued. Only stale entries are removed, so this is the stale count. */
  readonly removeCalls: number
}

/** Legal-candidate memo tallies. */
export interface NfpIfpMemoCounters {
  /** Calls that skipped the memo because the caller supplied no scope. */
  readonly bypasses: number
  /** Calls that consulted the memo. */
  readonly requests: number
  /** Consultations served from the memo. */
  readonly hits: number
  /** Consultations that found no entry at all. */
  readonly misses: number
  /** Consultations that found an entry but re-computed because provenance was wanted. */
  readonly provenanceMisses: number
  /** Memo hits that rebuilt candidate objects. */
  readonly restoreCalls: number
  /** Candidate objects rebuilt across every memo hit. */
  readonly restoredCandidates: number
}

/** Cancellation checkpoint tallies. */
export interface NfpIfpCheckpointCounters {
  /** Checkpoints reached, by phase. */
  readonly byPhase: Readonly<Record<string, number>>
  /** Checkpoints that had a control to poll. */
  readonly live: number
  /** Checkpoints that had no control and were therefore inert. */
  readonly inert: number
  /** Live controls that returned the shared `Effect.void` value directly. */
  readonly directVoid: number
  /** Live controls that returned another effect, including composed checks. */
  readonly composed: number
}

export interface NfpIfpTelemetrySnapshot {
  /** `GeometryCache` backing stores created while telemetry was enabled. */
  readonly cacheInstances: number
  readonly namespaces: Readonly<Record<string, NfpIfpCacheNamespaceCounters>>
  readonly memo: NfpIfpMemoCounters
  readonly checkpoints: NfpIfpCheckpointCounters
}

interface MutableNamespaceCounters {
  getCalls: number
  getPresent: number
  setCalls: number
  removeCalls: number
}

interface MutableState {
  cacheInstances: number
  readonly namespaces: Map<string, MutableNamespaceCounters>
  readonly memo: {
    bypasses: number
    requests: number
    hits: number
    misses: number
    provenanceMisses: number
    restoreCalls: number
    restoredCandidates: number
  }
  readonly checkpointsByPhase: Map<string, number>
  checkpointsLive: number
  checkpointsInert: number
  checkpointsDirectVoid: number
  checkpointsComposed: number
}

let state: MutableState | undefined

function makeState(): MutableState {
  return {
    cacheInstances: 0,
    namespaces: new Map(),
    memo: {
      bypasses: 0,
      requests: 0,
      hits: 0,
      misses: 0,
      provenanceMisses: 0,
      restoreCalls: 0,
      restoredCandidates: 0
    },
    checkpointsByPhase: new Map(),
    checkpointsLive: 0,
    checkpointsInert: 0,
    checkpointsDirectVoid: 0,
    checkpointsComposed: 0
  }
}

function namespaceCounters(current: MutableState, namespace: string): MutableNamespaceCounters {
  const existing = current.namespaces.get(namespace)
  if (existing !== undefined) return existing
  const created: MutableNamespaceCounters = {
    getCalls: 0,
    getPresent: 0,
    setCalls: 0,
    removeCalls: 0
  }
  current.namespaces.set(namespace, created)
  return created
}

/** Starts counting from zero. Safe to call repeatedly; each call resets. */
export function enableNfpIfpTelemetry(): void {
  state = makeState()
}

/** Stops counting and discards the tallies. */
export function disableNfpIfpTelemetry(): void {
  state = undefined
}

/** Returns the tallies so far, or `undefined` when telemetry is disabled. */
export function nfpIfpTelemetrySnapshot(): NfpIfpTelemetrySnapshot | undefined {
  const current = state
  if (current === undefined) return undefined
  const namespaces: Record<string, NfpIfpCacheNamespaceCounters> = {}
  for (const [namespace, counters] of [...current.namespaces].toSorted(([first], [second]) =>
    first < second ? -1 : first > second ? 1 : 0
  )) {
    namespaces[namespace] = { ...counters }
  }
  const byPhase: Record<string, number> = {}
  for (const [phase, count] of [...current.checkpointsByPhase].toSorted(([first], [second]) =>
    first < second ? -1 : first > second ? 1 : 0
  )) {
    byPhase[phase] = count
  }
  return {
    cacheInstances: current.cacheInstances,
    namespaces,
    memo: { ...current.memo },
    checkpoints: {
      byPhase,
      live: current.checkpointsLive,
      inert: current.checkpointsInert,
      directVoid: current.checkpointsDirectVoid,
      composed: current.checkpointsComposed
    }
  }
}

/** Records one `GeometryCache` backing store being created. */
export function recordCacheInstance(): void {
  if (state === undefined) return
  state.cacheInstances += 1
}

/** Records one cache lookup and whether it found an entry. */
export function recordCacheGet(namespace: string, present: boolean): void {
  if (state === undefined) return
  const counters = namespaceCounters(state, namespace)
  counters.getCalls += 1
  if (present) counters.getPresent += 1
}

/** Records one cache store. */
export function recordCacheSet(namespace: string): void {
  if (state === undefined) return
  namespaceCounters(state, namespace).setCalls += 1
}

/** Records one stale-entry removal. */
export function recordCacheRemove(namespace: string): void {
  if (state === undefined) return
  namespaceCounters(state, namespace).removeCalls += 1
}

/** Records one candidate-generation call that skipped the memo entirely. */
export function recordMemoBypass(): void {
  if (state === undefined) return
  state.memo.bypasses += 1
}

/**
 * Records one memo consultation. A consultation that found an entry but still
 * recomputed because the caller wanted provenance counts as a provenance miss,
 * which is otherwise indistinguishable from a plain miss.
 */
export function recordMemoRequest(outcome: 'hit' | 'miss' | 'provenance-miss'): void {
  if (state === undefined) return
  state.memo.requests += 1
  if (outcome === 'hit') state.memo.hits += 1
  else if (outcome === 'miss') state.memo.misses += 1
  else state.memo.provenanceMisses += 1
}

/** Records one memo hit rebuilding `count` candidate objects. */
export function recordMemoRestore(count: number): void {
  if (state === undefined) return
  state.memo.restoreCalls += 1
  state.memo.restoredCandidates += count
}

/** Records one cancellation checkpoint and the shape returned by its control. */
export function recordCheckpoint(
  phase: string,
  outcome: 'inert' | 'direct-void' | 'composed'
): void {
  if (state === undefined) return
  state.checkpointsByPhase.set(phase, (state.checkpointsByPhase.get(phase) ?? 0) + 1)
  if (outcome === 'inert') {
    state.checkpointsInert += 1
    return
  }
  state.checkpointsLive += 1
  if (outcome === 'direct-void') state.checkpointsDirectVoid += 1
  else state.checkpointsComposed += 1
}
