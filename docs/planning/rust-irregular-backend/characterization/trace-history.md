# Characterization: trace-history cluster

Cluster files (read completely, line by line):

- `src/workers/algorithm/irregular/decisionTrace.ts` (693 lines)
- `src/workers/decisionTraceNdjson.ts` (37 lines)
- `src/renderer/utils/sharedArchiveHistory.ts` (36 lines)
- `src/main/services/RunHistoryArchiveService.ts` (77 lines)

This document is written for a Rust implementer who will not re-read the TypeScript, and
for a parity reviewer who must verify a Rust port against it. Every nontrivial claim below
carries a `file:line` reference.

The special focus assigned to this cluster — decision-trace event ordering, NDJSON encoding
bytes, trace caps/statuses, selected-layout reveal frames, and replay semantics — required
tracing well beyond the four files above, because none of the four files *produces* the
data they encode/consume; the producers live in other clusters' files
(`computeIrregularNesting.ts`, `irregularWorkerOutput.ts`, `nesting.worker.ts`,
`windowedBeam.ts`, `portfolioSearch.ts`). Those files are cited precisely where needed but
not exhaustively re-specified — `windowedBeam.ts`/`portfolioSearch.ts` belong primarily to
the search/scoring cluster (`search-scoring.md`), and `computeIrregularNesting.ts`/
`irregularWorkerOutput.ts`/`nesting.worker.ts` belong primarily to the worker-coordination
cluster (`worker-coordination.md`), which already documents the queue/fiber/NDJSON-wrapper
mechanics from the worker's point of view. This document resolves an open question that
`search-scoring.md` explicitly deferred to this cluster (§15 below) and extends
`worker-coordination.md`'s findings with a previously-undocumented dead-computation fact
(§1, §15).

Supporting context read: `docs/prompts/fable5-rust-irregular-nesting-implementation.md`
(§2, §8, §9, §13, §14), and the sibling docs `worker-coordination.md` and `search-scoring.md`
for cross-reference (both consulted, neither modified).

---

## 1. Purpose and role in Compact / Compact Short Side execution

This cluster covers two structurally unrelated concerns that happen to be grouped under
"trace and replay" in the migration prompt's file map (§5):

**A. Decision-trace event stream** (`decisionTrace.ts`, `decisionTraceNdjson.ts`): a set of
typed, per-search-step diagnostic event classes (15 event kinds) plus a batching/NDJSON
serialization utility. This is a **step-by-step beam-search instrumentation stream**
(`decode_started`, `beam_step_started`, `local_candidate_scored`, `beam_selection`,
`decode_winner`, etc. — full enumeration in §3).

**B. Selected-layout reveal / persisted-history lifecycle**
(`sharedArchiveHistory.ts`, `RunHistoryArchiveService.ts`): renderer- and main-process-side
helpers that consume/manage the **coarse, already-complete-layout history frames**
(`IrregularHistoryFrame`, titled `shared-archive-selected-layout-reveal` /
`shared-archive-final-selected`) that Compact and Compact Short Side actually emit today.

These two concerns are **not the same producer**, and only B is live for Compact and
Compact Short Side in production. This is the single most important fact in this document
and is verified by tracing, not assumed:

### 1.1 Decision-trace event stream (A) is dead for Compact/Compact Short Side production defaults

- `decisionTrace.ts` itself contains **zero emission call sites** — it is pure data
  (event-payload classes + three id registries, `decisionTrace.ts:1-693`). Every
  `new IrregularDecisionTrace*Event(...)` construction site in the repository is inside
  `src/workers/algorithm/irregular/windowedBeam.ts` (verified:
  `grep -rn "new IrregularDecisionTrace" src/` → all hits in `windowedBeam.ts`, plus
  registry construction in `portfolioSearch.ts:201` and `windowedBeam.ts:2712-2713`).
- `windowedBeam.ts`'s decode function (`runWindowedIrregularBeamCore`,
  `windowedBeam.ts:340-...`) is reached only through `decodeChromosome` →
  `runPortfolio` in `portfolioSearch.ts`, which is reached only through
  `runSingleSheetPortfolio` in `computeIrregularNesting.ts:1378-1441`.
- `runSingleSheetPortfolio` has exactly **one** call site,
  `computeIrregularNesting.ts:1066`, inside the `else` branch of
  `if (archiveEnabled) { ... } else { ... }` (`computeIrregularNesting.ts:504`, closing
  `else` at `:1065-1069`), where `archiveEnabled =
  isIntrinsicSharedArchiveEligible(input.settings)` is computed once at the top of
  `coordinateIntrinsicSharedArchive` (`computeIrregularNesting.ts:483`). It only runs when
  the intrinsic shared archive is **not** eligible.
- `isIntrinsicSharedArchiveEligible` (`computeIrregularNesting.ts:1695-1697`) delegates to
  `intrinsicSharedArchiveEligibility` (`src/shared/irregular/executionMode.ts:16-35`), which
  requires `optimizer.intrinsicSharedArchiveEnabled === true` (else ineligible, reason
  `'archive-disabled'`, `executionMode.ts:19-21`), `placementPolicyId !== 'short-side-fill'`
  (else `'short-side-fill'`, `:22-24`), and GA disabled (`gaEnabled===false ||
  baselineOnly===true || gaTimeBudgetMs===0 || (gaGenerationBudget ?? 4)===0 ||
  (gaEvaluationBudget ?? 128)===0`, else `'ga-active'`, `:26-32`).
- **Production defaults satisfy every eligibility condition for both target profiles.**
  `makeCompactQualityIrregularOptimizerSettings()` (`src/shared/irregular/defaults.ts:148-165`)
  sets `intrinsicSharedArchiveEnabled: true`, `baselineOnly: true`, `gaEnabled: false`,
  `placementPolicyId: 'edge-contact-then-balanced-compactness'` — all three eligibility
  conditions hold. `DEFAULT_IRREGULAR_OPTIMIZER_SETTINGS = makeCompactQualityIrregularOptimizerSettings()`
  (`defaults.ts:177-178`). `makeCompactShortSideIrregularOptimizerSettings()`
  (`defaults.ts:168-175`) is the *same* settings plus only
  `intrinsicObjectiveProfileId: 'short-side'` — it does not touch
  `intrinsicSharedArchiveEnabled` or `placementPolicyId`, so Compact Short Side is equally
  eligible. Therefore `runSingleSheetPortfolio`, and everything downstream of it including
  every `decisionTrace.ts` event constructor, **never executes for production-shaped Compact
  or Compact Short Side requests.**
- Independent confirmation directly in source: the renderer's own settings-UI derivation
  (`src/renderer/utils/irregularSettingsUi.ts:16-46`) labels the *ineligible* branch's UI
  mode `'legacy-requires-migration'` (`:41`) — the source code itself already treats the
  windowedBeam/decisionTrace-emitting path as a legacy path pending removal, not as a
  currently-supported Compact/Compact Short Side execution mode.
- **What *is* live for Compact/Compact Short Side**: the empty-file-creation and
  zero-event-flush machinery. Whenever `payload.options.workerMode === IRREGULAR_WORKER_MODE`
  and `historyMode !== 'off'`, `nesting.worker.ts:205-208` calls `prepareDecisionTraceFile`
  (`:112-128`), which truncates/creates `{jobId}.decision-trace.ndjson` with empty content
  (`:125`, `flag: mode === 'append' ? 'a' : 'w'` where the byte content written is `''`).
  `emitDecisionTrace` is then constructed and forwarded into
  `computeIrregularNesting`'s options (`nesting.worker.ts:256-260,373`), but because the
  legacy branch never runs, `IrregularDecisionTraceBatcher.add()` is **never called**
  (`decisionTraceNdjson.ts:19-22`), so the batcher never reaches its `maximumEvents` (`256`)
  threshold and its only flush is the unconditional one at job end
  (`nesting.worker.ts:275`, `Effect.sync(() => decisionTraceBatcher?.flush())`), which is a
  no-op because `pendingEvents.length === 0` short-circuits (`decisionTraceNdjson.ts:25`).
  `decisionTraceEventCount` in the returned `NestingHistorySummary` is therefore **always
  `0`** for Compact/Compact Short Side (`nesting.worker.ts:211,225,307-309`), and the
  `.decision-trace.ndjson` file on disk is always zero bytes.
  This restates and is fully consistent with `worker-coordination.md`'s independent finding
  (`worker-coordination.md:141-158, 455-462, 566-570, 697-710`); this document adds the
  *why* (the eligibility gate) with full provenance and confirms it by direct grep of every
  `new IrregularDecisionTrace*` call site, not just the `emitDecisionTrace` plumbing.
- **This resolves an explicit open question left by `search-scoring.md`.**
  `search-scoring.md:363, 1900-1906` flags that `IrregularLayoutScore.collisionBoundsBottomMm`/
  `collisionBoundsLeftMm` (and by extension `IrregularPlacementScore.candidateBottomMm`/
  `candidateLeftMm`) are read only by "a different cluster's trace record type whose
  producer needs separate verification." Verified here:
  `decisionTraceLocalScore` (`windowedBeam.ts:2728-2741`) copies
  `score.candidateBottomMm`/`score.candidateLeftMm` directly from the live
  `IrregularPlacementScore`, and `decisionTraceLayoutScore` (`windowedBeam.ts:2743-2765`)
  copies `score.collisionBoundsBottomMm`/`score.collisionBoundsLeftMm` directly from the
  live `IrregularLayoutScore` — both are called only from within `windowedBeam.ts`'s decode
  loop, i.e. only from the same dead-for-production branch documented above. **These two
  score-object consumers, like the rest of `decisionTrace.ts`'s producer path, are dead for
  Compact/Compact Short Side production defaults.**
- The `decisionTrace.ts` machinery **is** exercised by unit tests, but only by constructing
  `IrregularOptimizerSettings` directly (not via `makeCompactQualityIrregularOptimizerSettings`),
  which leaves `intrinsicSharedArchiveEnabled` at its schema default of `false`
  (`src/shared/irregular/domain.ts:319-323`) — i.e. the tests deliberately select the legacy
  branch. See `tests/unit/irregularWorkerCompute.test.ts:206-227` (`'emits decision traces
  only when history is enabled'`) and all of `tests/unit/decisionTraceNdjson.test.ts`
  (§14). A standalone diagnostics script, `scripts/irregular-sheet-trace-dump.ts`, exists to
  dump decision traces for the persisted Mixed-61 fixture, but its own docstring is
  **stale/misleading**: the fixture it loads
  (`tests/fixtures/irregularSheetInvariance/mixed61-request.json`) has
  `intrinsicSharedArchiveEnabled: true`, `gaEnabled: false`, `baselineOnly: true`,
  `placementPolicyId: 'edge-contact-then-balanced-compactness'` — i.e. production-eligible
  settings — so running this script against the Mixed-61 corpus today produces `events.length
  === 0` and a one-newline-byte `.decision-trace.ndjson` output for every sheet, contrary to
  what the comment at `scripts/irregular-sheet-trace-dump.ts:22-29` implies. This is not
  wired into any `package.json` script or CI workflow (verified:
  `grep -rn "irregular-sheet-trace-dump" .github/` → no hits), so it is not a production or
  gate concern, but it is a real, verifiable, source-level inconsistency worth flagging per
  §15.

### 1.2 Selected-layout reveal / persisted-history lifecycle (B) — the live path

- Compact and Compact Short Side both call `selectedLayoutRevealSnapshots`
  (`computeIrregularNesting.ts:1659-1692`) from all three of their terminal materialization
  functions: `materializeIntrinsicCapacityResult` (`:1274-1281`, capacity-mode endpoint),
  `materializeSharedArchiveResult` (`:1544-1547`, complete-archive endpoint), and
  `materializeIntrinsicShortSideProfileResult` (`:1612-1619`, Short Side terminal
  construction) — gated on `input.request.options.historyMode !== 'off'` in every case
  (else `stateSnapshots = []`). This produces `placedCollisionGeometries.length + 1`
  synthetic `IrregularStateSnapshot`s, one per placement-count prefix from `0` (nothing
  placed) through `N` (everything placed) — see §3 for the exact shape and §5 for exact
  ordering.
- The coordinator then feeds every one of these snapshots, in array order, to
  `input.options?.emitStateSnapshot?.(snapshot, beamWidth)`
  (`computeIrregularNesting.ts:1204-1206`), **after** `selected` (the terminal winner) is
  fully materialized — i.e. this is a synchronous batch emission at the very end of a
  successful coordinator run, not an incremental stream during search. See §10 for the
  cancellation implication.
- `nesting.worker.ts:356-369` wires `emitStateSnapshot` to a closure that calls
  `makeIrregularHistoryFrame` (`irregularWorkerOutput.ts:42-82`) with a **fresh**
  `createdAt: new Date().toISOString()` per call, and pushes the resulting
  `IrregularHistoryFrame` onto `frameQueue` via `Queue.offerUnsafe`
  (`nesting.worker.ts:357-368`; note the closure literally calls `new Date().toISOString()`
  once per invocation — this is `nesting.worker.ts:366`, executed once per emitted frame,
  not once per job). This is what actually gets appended to the per-job `.ndjson` history
  file (`appendFrame`, `nesting.worker.ts:103-110`) and, when `historyMode === 'stream'`,
  sent to the renderer as `WorkerHistoryFrameResponse` (`:175-186`).
- `makeIrregularHistoryFrame` (`irregularWorkerOutput.ts:42-82`) is this cluster's
  contractual title producer (see §3): for a shared-archive-sourced snapshot
  (`snapshot.source === 'shared-archive'`, always true for Compact/Compact Short Side per
  `selectedLayoutRevealSnapshots:1681`), the title is `'shared-archive-final-selected'`
  when `snapshot.state.remainingPreparedPieces.length === 0` (the last, fully-placed
  snapshot) and `'shared-archive-selected-layout-reveal'` otherwise
  (`irregularWorkerOutput.ts:64-70`). **Every** intermediate snapshot in the N+1 sequence is
  therefore already individually emitted and persisted with the correct per-step title —
  production output is *never* a single terminal-only frame for a fresh run.
- **`sharedArchiveHistory.ts`'s `expandSharedArchiveSelectedLayoutReveal` is a
  compatibility/replay-time synthesis shim, not part of the live production-emission path.**
  It exists to reconstruct the same N+1-step reveal sequence *after the fact*, from a single
  terminal `shared-archive-final-selected` frame, for **legacy** persisted history that
  predates per-step reveal frames (or any other source that only records one terminal frame
  per shared-archive run). It has two renderer-side callers, both of which operate on
  already-persisted/streamed frame arrays, never on live algorithm state:
  - `useHistoryStore.ts:278-295` (`pushFrame`) — applies it **only to the first frame
    received for a run** (`existing.length === 0 ? expandSharedArchiveSelectedLayoutReveal(frame)
    : [frame]`, `:283`). For a live Compact/Compact Short Side run under
    `historyMode === 'stream'`, the first frame received is stepIndex 0 with
    `placements.length === 0`, so the function's own guard
    (`sharedArchiveHistory.ts:8-14`, `frame.placements.length === 0` → return `[frame]`
    unchanged) makes this a no-op for fresh runs; it only actually expands something when
    the very first frame streamed for a run is already the fully-placed terminal frame
    (the legacy shape).
  - `runHistoryGif.ts:26-61` (`selectFirstBeamSequence`) — applies it via
    `frames.flatMap(expandSharedArchiveSelectedLayoutReveal)` (`:30`) to **every** frame in
    an already-loaded full run history (used for GIF export, `runHistoryGif.ts:1-30`), not
    just the first. See §12 for the resulting (non-crashing but redundant) behavior on
    modern multi-frame runs, and §15 for why this is unverified-by-test.
- **`makeIrregularWorkerOutput`'s own `historyFrames` field is computed but discarded in
  production.** `makeIrregularWorkerOutput` (`irregularWorkerOutput.ts:88-187`) builds
  `historyFrames` a **second time** from `input.computed.stateSnapshots`
  (`irregularWorkerOutput.ts:122-130`, again via `makeIrregularHistoryFrame`, but with a
  single shared `createdAt: input.algorithmBenchmark.endedAt` for every frame instead of a
  fresh timestamp per frame). The one production call site,
  `nesting.worker.ts:378-390`, destructures only `output.result` from the returned
  `IrregularWorkerOutput` and never reads `output.historyFrames`
  (verified: `grep -rn "\.historyFrames\b" src/` → **zero** hits anywhere under `src/` —
  the field is defined (`irregularWorkerOutput.ts:26,122,185`, via a local `const
  historyFrames` and object-shorthand property, never a dot-access) but never read back via
  property access by any production code; every dot-access of `.historyFrames` in the
  repository is inside `tests/`). This
  redundant computation is exercised and asserted on directly by four test files that call
  `makeIrregularWorkerOutput` themselves (§14), so it is *not* dead code from a test-coverage
  standpoint, but it is genuinely unobservable production output — the persisted/streamed
  history a real user sees always comes from the live `emitStateSnapshot` path (previous
  bullet), never from this field. This extends `worker-coordination.md:134-137`'s "exactly
  one production caller each, — **Live**" finding with the more precise fact that one of
  `makeIrregularWorkerOutput`'s two return fields is call-site-dead. See §15 for the Rust
  port implication.
- `RunHistoryArchiveService.ts` (`removeRunHistoryFiles`/`deleteRunHistoryFiles`) is a
  main-process **artifact-lifecycle** service with **no algorithmic role at all** — it only
  deletes the two files (`{jobId}.ndjson`, `{jobId}.decision-trace.ndjson`) that the worker
  wrote for a saved run, on explicit user action (`nesting:delete-run-histories` IPC handler,
  `src/main/ipc/handlers.ts:734-765`, invoked from `StrategyRunsPanel.vue:90-124`'s "delete
  saved run(s)" UI). It is "live" only in the sense that it is exercised whenever a user
  deletes a saved Compact/Compact Short Side run record; it touches zero geometry, zero
  search state, and is explicitly outside Rust-port scope (Electron main-process service,
  migration prompt §4.2).

**Net assessment for the Rust port**: of the four cluster files, `decisionTrace.ts` and
`decisionTraceNdjson.ts` are effectively dead weight for Compact/Compact Short Side today —
their event *types* still need to exist somewhere for the legacy/GA path to keep compiling
and their tests to keep passing, but **no Rust equivalent is required for Compact/Compact
Short Side parity** unless the orchestrator decides the differential/legacy backend must
also reproduce them (open question, §15). `sharedArchiveHistory.ts` and
`RunHistoryArchiveService.ts` are pure TypeScript UI/main-process code, permanently outside
Rust's scope; Rust's only obligation toward this half of the cluster is to return, across
the N-API boundary, data equivalent to `IrregularComputeResult.stateSnapshots` (the
per-placement-count-prefix sequence built by `selectedLayoutRevealSnapshots`) so that the
**unmodified** TypeScript `nesting.worker.ts` / `irregularWorkerOutput.ts` frame-emission
code can keep doing exactly what it does today. This matches the migration prompt's own
scope list verbatim: "selected-layout reveal data needed by TypeScript history persistence"
(§4.1) — the prompt already anticipated that this is a *data-shape* contract for Rust, not
an *algorithm* to reimplement.

---

## 2. Entry points, callers, callees (traced, not guessed)

### `decisionTrace.ts`

No entry points of its own; it is a pure types/DTO module. Exports consumed by:

| Export | Consumers |
|---|---|
| `IrregularDecisionTraceIdentity` | `decisionTrace.ts` internal (`EventInput<Payload>`), `windowedBeam.ts` (`ActiveDecisionTrace` shape), `portfolioSearch.ts` |
| `IrregularDecisionTraceStateIdRegistry` | `windowedBeam.ts:2712` |
| `IrregularDecisionTraceCandidateIdRegistry` | `windowedBeam.ts:2713` |
| `IrregularDecisionTraceChromosomeIdRegistry` | `portfolioSearch.ts:201` |
| `IrregularDecisionTraceEventBase` (abstract) | base class for all 15 event classes, this file only |
| 15 concrete event classes + 9 value classes (`Point`, `Transform`, `TransformPreference`, `State`, `LocalScore`, `LayoutScore`, `Sheet`, `SearchSettings`, `LocalCandidateDecisionCounts`) | constructed exclusively in `windowedBeam.ts` (§1.1) |
| `IrregularDecisionTraceEvent` (union of the 15 event classes) | `decisionTraceNdjson.ts`, `nesting.worker.ts`, `computeIrregularNesting.ts` (`emitDecisionTrace` option type), `portfolioSearch.ts`, `windowedBeam.ts`, `scripts/irregular-sheet-trace-dump.ts`, `tests/unit/decisionTraceNdjson.test.ts`, `tests/unit/irregularWorkerCompute.test.ts` |
| `EmitIrregularDecisionTrace` (`(event) => void`) | same call sites as above; this is the exact callback type threaded through `ComputeIrregularNestingOptions.emitDecisionTrace` (`computeIrregularNesting.ts:119`) |

### `decisionTraceNdjson.ts`

| Export | Callers |
|---|---|
| `DECISION_TRACE_BATCH_EVENT_LIMIT` (`= 256`) | `IrregularDecisionTraceBatcher`'s own default (`:16`); `tests/unit/decisionTraceNdjson.test.ts` does not import it directly but exercises the default implicitly (uses an explicit `maximumEvents: 2` override instead) |
| `IrregularDecisionTraceBatcher` | Constructed once per job in `nesting.worker.ts:231-238` (only when `decisionTracePath !== null`); its `.add()` is called from the `emitDecisionTrace` closure passed into `computeIrregularWorkerResult` (`nesting.worker.ts:256-260`), which as shown in §1.1 is never actually invoked for Compact/Compact Short Side. `.flush()` is called unconditionally at job end (`nesting.worker.ts:275`) |
| `serializeIrregularDecisionTraceBatch` | `appendDecisionTraceBatch` (`nesting.worker.ts:130-140`, called from `makeDecisionTraceEmitter`'s returned closure, `:149-153`); also directly by `scripts/irregular-sheet-trace-dump.ts:143` and by both test files |

### `sharedArchiveHistory.ts`

| Export | Callers |
|---|---|
| `expandSharedArchiveSelectedLayoutReveal` | `useHistoryStore.ts:283` (`pushFrame`, live-frame ingestion, guarded to first-frame-of-run only); `runHistoryGif.ts:30` (`selectFirstBeamSequence`, applied to every loaded frame). No caller in `src/main/` or `src/workers/` — purely renderer-side. |

### `RunHistoryArchiveService.ts`

| Export | Callers |
|---|---|
| `RunHistoryArchiveError` (class) | thrown/caught within this file; caught and remapped in `src/main/ipc/handlers.ts:754-762` |
| `removeRunHistoryFiles` (Effect-returning) | `deleteRunHistoryFiles` (`:76`, same file) |
| `deleteRunHistoryFiles` (Promise-returning, runs via `appRuntime.runPromise`) | `src/main/ipc/handlers.ts:750`, inside the `nesting:delete-run-histories` IPC handler (`:734-765`) |

### Cross-cluster producer chain for the live path (traced, §1.2)

```
computeIrregularNesting.ts:1659 selectedLayoutRevealSnapshots
  -> computeIrregularNesting.ts:1274,1544,1612 (three materialize* call sites)
  -> computeIrregularNesting.ts:1204-1206 (emitStateSnapshot loop, post-selection)
  -> nesting.worker.ts:356-369 (emitFrame closure -> makeIrregularHistoryFrame)
  -> irregularWorkerOutput.ts:42-82 makeIrregularHistoryFrame (title tagging)
  -> nesting.worker.ts:246 Queue.offerUnsafe(frameQueue, frame)
  -> nesting.worker.ts:220-223 frameConsumer fiber -> makeFrameEmitter
  -> nesting.worker.ts:103-110 appendFrame (persisted .ndjson)
     and/or nesting.worker.ts:175-186 WorkerHistoryFrameResponse (streamed)
  -> [renderer] useHistoryStore.ts:278-295 pushFrame
     -> sharedArchiveHistory.ts:5-36 expandSharedArchiveSelectedLayoutReveal (no-op for fresh runs, see §1.2)
  -> [main, on replay] ExportService.ts:353-371 loadHistoryReplayFromFile (reads the .ndjson file back)
  -> [renderer, GIF export] runHistoryGif.ts:26-61 selectFirstBeamSequence
     -> sharedArchiveHistory.ts:5-36 expandSharedArchiveSelectedLayoutReveal (applied to every frame)
```

---

## 3. Data in/out: exact types/shapes, optional-field presence/omission semantics

### 3.1 Decision-trace event identity (shared by all 15 events)

`IrregularDecisionTraceIdentity` (`decisionTrace.ts:1-5`): `decodeId: string`,
`chromosomeId: string`, `decodeSource: 'baseline' | 'ga' | 'direct'`. All three fields are
**required, never optional**, and are copied verbatim by `IrregularDecisionTraceEventBase`'s
constructor (`decisionTrace.ts:52-56`) into every event instance.

Values actually assigned (traced in `windowedBeam.ts`/`portfolioSearch.ts`, §1.1, dead path):

- `decodeSource: 'baseline'` with `decodeId: 'baseline-0'` for the one deterministic
  full-beam decode (`portfolioSearch.ts:274-279`).
- `decodeSource: 'ga'` with `decodeId: `ga-${generation}-${evaluationsCompleted}`` for each
  GA-evaluated chromosome (`portfolioSearch.ts:378-386`); GA is disabled by default
  (`gaEnabled: false` in `makeCompactQualityIrregularOptimizerSettings`), so this value is
  unreachable under default settings even on the legacy branch.
- `decodeSource: 'direct'` with `decodeId: 'direct-0'` and `chromosomeId: 'direct'` as the
  fallback when no `decisionTraceIdentity` is supplied at all
  (`windowedBeam.ts:2702-2715`, `makeActiveDecisionTrace`).
- `decodeId` may be prefixed by an outer decode role via
  `prefixedDecisionTraceDecodeId(prefix, decodeId)` (`portfolioSearch.ts:494-499`, simple
  string concatenation `${prefix}${decodeId}`, no separator inserted — the prefix itself
  already ends in `:`, e.g. `${decodeRole}:` from `computeIrregularNesting.ts:1432`).
- `chromosomeId` for GA/baseline decodes comes from
  `decisionTraceChromosomeIds.idFor(chromosomeKey(chromosome))`
  (`portfolioSearch.ts:261`), where `chromosomeKey` (`portfolioSearch.ts:1074-1080`) builds
  a composite string key `${priorityOrder.join('|')}::${sortedTransformPreferences}::${policyId}`
  — this is a different-cluster comparator detail, noted here only because it feeds this
  cluster's `chromosomeId` field; see §12 for its `localeCompare` hazard.

### 3.2 Id registries (`decisionTrace.ts:9-45`)

`IrregularDecisionTraceIdRegistry` (private base, not exported) maps an arbitrary
"canonical key" string to a short id `${prefix}${counter.toString(36)}`, assigning ids in
**strict first-seen call order**: the internal `Map<string,string>` (`idsByCanonicalKey`) is
used purely for `.get`/`.set` lookup (never iterated), and `nextId` increments by exactly 1
per genuinely new key (`decisionTrace.ts:15-23`). Three subclasses fix the prefix:
`IrregularDecisionTraceStateIdRegistry` → `'s'` (state ids: `s0`, `s1`, ..., `sa` at 10,
`sz` at 35, `s10` at 36 — base-36 lowercase-digit encoding via `Number.prototype.toString(36)`);
`IrregularDecisionTraceCandidateIdRegistry` → `'k'`; `IrregularDecisionTraceChromosomeIdRegistry`
→ `'c'`. Each registry instance is scoped to one decode call
(`windowedBeam.ts:2712-2713` constructs a fresh state/candidate registry per
`makeActiveDecisionTrace` call; `portfolioSearch.ts:198-201` constructs one chromosome
registry per `runPortfolio` call, shared across all chromosomes in that portfolio run).

### 3.3 The 15 event kinds — exact field order (this is the JSON key order, see §8)

Every event's JSON object begins with the four identity/tag fields in this order:
`decodeId`, `chromosomeId`, `decodeSource`, `kind` (`kind` is a `readonly kind = '...' as
const` literal field declared first in every subclass, immediately after the
`decodeId`/`chromosomeId`/`decodeSource` triple inherited from
`IrregularDecisionTraceEventBase`). All fields are **required** — no event class has an
optional field, and no constructor performs `undefined`-omission (contrast with §3.5's
`IrregularHistoryFrame`, which does have true optionals).

| `kind` | Class (`decisionTrace.ts` lines) | Fields after `decodeId, chromosomeId, decodeSource, kind` in declared order |
|---|---|---|
| `decode_started` | `IrregularDecisionTraceDecodeStarted` (246-267) | `sheet: {widthMm, heightMm}`, `settings: {orderWindow, beamWidth, localCandidateFanout, localRepairBudget, policyId}`, `priorityOrder: string[]`, `transformPreferences: {pieceId, transformIndex}[]` |
| `beam_step_started` | `IrregularDecisionTraceBeamStepStarted` (269-279) | `stepIndex`, `parentCount` |
| `parent_state` | `IrregularDecisionTraceParentState` (281-302) | `stepIndex`, `parentRank`, `incumbent`, `state: {stateId, placementOrder, remainingPieceIds, unplacedPieceIds}` |
| `eligible_pieces` | `IrregularDecisionTraceEligiblePieces` (304-322) | `stepIndex`, `parentStateId`, `pieceIds: string[]` |
| `transform_candidates_generated` | `IrregularDecisionTraceTransformCandidatesGenerated` (324-349) | `stepIndex`, `parentStateId`, `pieceId`, `transform: {index, rotationDeg, mirrored, reason}`, `legalCandidateCount` |
| `local_candidate_scored` | `IrregularDecisionTraceLocalCandidateScored` (351-385) | `stepIndex`, `parentStateId`, `pieceId`, `candidateId`, `point: {x, y}`, `transform: {...}`, `policyId`, `score: {usedClusterMaxSideMm, worstNormalizedSheetConsumption, normalizedSheetSpanSum, usedClusterAreaMm2, usedClusterSpanMm, shortSideFill, longSideFill, sharedCollisionBoundaryLengthMm, candidateBottomMm, candidateLeftMm}` |
| `local_candidate_selection` | `IrregularDecisionTraceLocalCandidateSelection` (396-427) | `stepIndex`, `parentStateId`, `pieceId`, `candidateId`, `rank`, `decision: 'selected'\|'rejected'`, `reason` (7-value union, `:387-394`) |
| `local_candidate_summary` | `IrregularDecisionTraceLocalCandidateSummary` (457-491) | `stepIndex`, `parentStateId`, `pieceId`, `generatedCandidateCount`, `uniqueGeometryCandidateCount`, `selectedCandidateCount`, `detailedCandidateCount`, `decisionCounts: {withinLocalCandidateFanout, compactnessAlternativeReserved, displacedByCompactnessReservation, intrinsicContactTierReserved, paretoFrontierReserved, duplicateLocalGeometry, outsideLocalCandidateFanout}` |
| `successor_deduplication` | `IrregularDecisionTraceSuccessorDeduplication` (493-518) | `stepIndex`, `successorStateId`, `decision: 'kept'\|'dropped'`, `reason` (3-value union) |
| `successor_layout_scored` | `IrregularDecisionTraceSuccessorLayoutScored` (520-539) | `stepIndex`, `state: {...}`, `score: {unplacedCount, sharedCollisionBoundaryLengthMm, sharedCollisionBoundaryContactUnits, sharedCollisionBoundaryContactBand, nearCompleteStructuralContactCount, dominantNearCompleteStructuralContactCount, occupiedHullWasteRatio, collisionBoundsWorstNormalizedSheetConsumption, collisionBoundsNormalizedSpanSum, collisionBoundsAreaMm2, collisionBoundsSpanMm, largestNetFreeMaterialRegionAreaMm2, freeMaterialRegionCount, freeMaterialHoleCount, freeMaterialSliverMetric, collisionBoundsBottomMm, collisionBoundsLeftMm}` |
| `beam_selection` | `IrregularDecisionTraceBeamSelection` (541-583) | `stepIndex`, `stateId`, `rank`, `decision: 'retained'\|'pruned'`, `reason` (9-value union, `:547-556`) |
| `beam_step_completed` | `IrregularDecisionTraceBeamStepCompleted` (585-606) | `stepIndex`, `generatedCandidateCount`, `uniqueSuccessorCount`, `retainedStateCount` |
| `local_repair_accepted` | `IrregularDecisionTraceLocalRepairAccepted` (608-630) | `iterationIndex`, `pieceId`, `state: {...}`, `score` (layout-score shape, same as `successor_layout_scored`) |
| `terminal_orientation_scored` | `IrregularDecisionTraceTerminalOrientationScored` (632-657) | `rotationDeg`, `cornerGapMm`, `state: {...}`, `score` (layout-score shape), `decision: 'selected'\|'rejected'` |
| `decode_winner` | `IrregularDecisionTraceDecodeWinner` (659-674) | `state: {...}`, `score` (layout-score shape) |

Every array-typed field on every value/event class is a **defensive shallow copy** made with
spread syntax at construction time (e.g. `this.placementOrder = [...input.placementOrder]`,
`decisionTrace.ts:111-113`; `this.priorityOrder = [...input.priorityOrder]`,
`:264`; `this.transformPreferences = [...input.transformPreferences]`, `:265`) — mutating the
caller's original array after passing it in cannot retroactively change an already-
constructed event.

### 3.4 `IrregularDecisionTraceEvent` union (`decisionTrace.ts:676-691`)

A 15-member discriminated union over the `kind` literal field, in declaration order matching
the table above exactly.

### 3.5 `IrregularHistoryFrame` (the live selected-layout-reveal payload, schema-defined in
`src/shared/irregular/domain.ts:999-1034`, NOT in this cluster's four files but required
context for §1.2/§5)

Fields, in schema declaration order: `kind: 'irregular'` (literal), `frameId: string`,
`jobId`, `strategyRunId`, `strategyLabel`, `stepIndex: NonNegativeFiniteInteger`,
`title: Schema.String` (**unconstrained free-form string** — the specific values
`'shared-archive-final-selected'` / `'shared-archive-selected-layout-reveal'` /
`'initial-beam'` / `'beam-state-selected'` are a producer-side convention enforced only by
`makeIrregularHistoryFrame` (`irregularWorkerOutput.ts:64-70`), not by the schema),
`placements: IrregularPlacementSchema[]`, `collisionPolygons: IrregularCollisionPolygons`
(optional key with constructor **and** decoding default `[]` —
`src/shared/irregular/domain.ts:204-213`; a schema-decoded frame's `collisionPolygons` is
therefore never literally `undefined` at runtime, only ever `[]` or a real array — see §12
for why `sharedArchiveHistory.ts:28-30`'s `=== undefined` check is effectively unreachable
through normal schema-decoded channels), `remainingPieceIds: PieceId[]`,
`unplacedPieceIds: PieceId[]`, `beamRank`, `beamWidth`, then four genuinely optional fields
(`Schema.optional`, no default — true presence/omission, not default-filled):
`candidateCount`, `selectedCandidateId`, `selectedPieceId`, `selectedTransform`, and finally
`createdAt: string`. A `.check()` filter (`domain.ts:1018-1028`) enforces
`collisionPolygons.length === 0 || collisionPolygons.length === placements.length`.

For Compact/Compact Short Side, `makeIrregularHistoryFrame` always sets
`candidateCount: snapshot.candidateCount` (always `1` for shared-archive snapshots, per
`selectedLayoutRevealSnapshots:1680`) and never sets `selectedCandidateId`/
`selectedPieceId`/`selectedTransform` (absent from the constructor call,
`irregularWorkerOutput.ts:57-81`) — these three remain **omitted**, not `null`/`undefined`-
valued, in the constructed instance and therefore omitted from `JSON.stringify` output.

### 3.6 `NestingHistorySummary` (`src/shared/domain/nesting.ts:256-268`)

`frameCount`, `strategyRunCount`, `retainedFrameCount`, `truncated: boolean` (**hardcoded
`false`** at the one construction site regardless of actual frame count,
`nesting.worker.ts:303` — no truncation logic exists on the irregular path; a Rust port must
not add `maxHistoryEvents`-driven truncation, since `maxHistoryEvents` is decoded but never
read anywhere under `src/workers/` or `src/main/`), `scope: HistoryScope` (hardcoded literal
`'winning_path'` at the construction site, `nesting.worker.ts:304`), `strategyRunIds: string[]`,
then three genuinely optional (`Schema.optional`, no default) fields: `ndjsonPath`,
`decisionTracePath`, `decisionTraceEventCount`. `decisionTracePath`/`decisionTraceEventCount`
are only present together, both gated on `decisionTracePath !== null`
(`nesting.worker.ts:307-309`); for Compact/Compact Short Side this pair is present (the file
is always created) but `decisionTraceEventCount` is always `0` (§1.1).

### 3.7 `RunHistoryArchiveService.ts` data shapes

`ownedHistoryPaths(historyDirectory, jobIds, path)` (`:9-35`) takes a directory string and a
`ReadonlyArray<JobId>`, returns a flat `string[]` of exactly `2 * uniqueJobIds.length`
resolved paths (one `.ndjson` + one `.decision-trace.ndjson` per unique job id, in that
fixed per-job order, `:23`). `deleteRunHistoryFiles`/`removeRunHistoryFiles` return
`void`/`Promise<void>` — no data out beyond success/failure. `DeleteRunHistoriesPayload`
(`src/shared/protocol/ipc.ts:30-34`) requires `jobIds: JobId[]` to be **non-empty**
(`Schema.check(Schema.isNonEmpty())`).

---

## 4. Algorithm state and every mutation point

This cluster owns **no search/beam state** — that lives entirely in `windowedBeam.ts`'s
`IrregularBeamState`/portfolio machinery (out of scope here; the search-scoring cluster owns
it). Within these four files, mutable state is limited to:

- **`IrregularDecisionTraceIdRegistry.nextId`** (`decisionTrace.ts:11`) and
  **`idsByCanonicalKey`** (`decisionTrace.ts:10`, a `Map`): mutated only by `idFor()`
  (`:15-23`), which either returns an existing mapping unchanged or inserts one new entry and
  increments the counter by exactly 1. No other mutation path exists. Dead for
  Compact/Compact Short Side (§1.1).
- **`IrregularDecisionTraceBatcher.pendingEvents`** (`decisionTraceNdjson.ts:7`): appended by
  `.add()` (`:19-22`), cleared and handed off atomically by `.flush()` (`:24-29`, `const
  batch = this.pendingEvents; this.pendingEvents = []` — the array is *replaced*, not
  emptied in place, so a batch handed to `emitBatch` is never mutated afterward even if
  `.add()` is called again immediately). For Compact/Compact Short Side, `.add()` is never
  called (§1.1), so this state never leaves its initial empty array except via the one
  guaranteed-no-op `.flush()` at job end.
- **`RunHistoryArchiveService.ts`**: no persistent in-memory state; each call to
  `ownedHistoryPaths`/`removeRunHistoryFiles` is a fresh, stateless validation-then-delete
  pass. Mutation is entirely external (the filesystem): `ownedHistoryPaths` first
  **validates every job id and builds the complete path list before any deletion is
  attempted** (`:16-34`, the `for` loop that can `throw` runs to completion or fails before
  `removeRunHistoryFiles`'s `Effect.forEach` ever calls `fs.remove`, `:44-53` vs `:54-68`) —
  this means an invalid id anywhere in the batch aborts the **entire** delete with **zero**
  files removed, not a partial delete. Verified by
  `tests/unit/runHistoryArchiveService.test.ts:44-52` (job-1's valid `.ndjson` file survives
  when a second, invalid id is present in the same call). Deletion itself proceeds
  sequentially (`Effect.forEach(paths, ..., { concurrency: 1, discard: true })`,
  `RunHistoryArchiveService.ts:54-68`) in the fixed per-job `[.ndjson, .decision-trace.ndjson]`
  order established by `ownedHistoryPaths`. `[...new Set(jobIds)]` (`:15`) deduplicates
  requested job ids by JS `Set` equality (reference/primitive equality on the branded string
  `JobId`), preserving first-seen order — order is inert here since deletion order has no
  observable effect beyond "all managed files for all valid unique ids are gone or the whole
  call throws."
- **`sharedArchiveHistory.ts`**: no mutable state; `expandSharedArchiveSelectedLayoutReveal`
  is a pure function from one frame to an array of frames.

---

## 5. Ordering sources: sorts, Map/Set insertion order, iteration order reaching output

- **`IrregularDecisionTraceIdRegistry`'s `Map`** (`decisionTrace.ts:10`): used exclusively
  via `.get()`/`.set()`, **never iterated** — the *order* that matters is the **call order**
  of `idFor()` (first-seen order determines which key gets `0`, `1`, `2`, ... — this is a
  real ordering contract, but it is a counter-increment contract, not a Map-iteration
  contract).
- **`selectedLayoutRevealSnapshots`'s `Map`** (`computeIrregularNesting.ts:1664-1666`,
  `preparedById`): built once via `new Map(preparedPieces.map(...))`, used only via `.get()`
  inside a `.flatMap` (`:1672-1675`) — not iterated, insertion order irrelevant to output.
  (This duplicates a finding already made independently in `worker-coordination.md:551-554`
  for the same line; cited here because it is load-bearing for this cluster's §1.2 producer.)
- **`selectedLayoutRevealSnapshots`'s output array order** (`computeIrregularNesting.ts:1668`,
  `Array.from({length: placedCollisionGeometries.length + 1}, (_, stepIndex) => ...)`): a
  **plain ascending integer sequence** `0..N` — stepIndex `i`'s snapshot always has
  `placed = placedCollisionGeometries.slice(0, i)`. This is the authoritative ordering
  source for the entire "selected-layout reveal" frame sequence: it is **not** re-sorted,
  re-ranked, or reshuffled anywhere downstream. The order in which pieces "appear placed" as
  stepIndex increases is exactly `placedCollisionGeometries`'s own order — i.e. whatever
  order the upstream archive/capacity/Short Side winner constructed its placement list in
  (a different cluster's contract; not re-derived here).
- **Frame emission order into `frameQueue`**: the `for (const snapshot of selected.stateSnapshots)`
  loop (`computeIrregularNesting.ts:1204-1206`) iterates the array above in index order,
  calling `emitStateSnapshot` synchronously once per snapshot — so `Queue.offerUnsafe` calls
  happen in stepIndex order (`0, 1, ..., N`).
- **`frameQueue`/`decisionTraceQueue` FIFO delivery**: Effect's `Queue` is an ordered
  channel (not a `Map`/`Set`); `Stream.fromQueue(...).pipe(Stream.runForEach(...))`
  (`nesting.worker.ts:220-223, 227-230`) is a single consumer fiber per queue, so enqueue
  order is preserved into both the appended `.ndjson` file and the streamed
  `WorkerHistoryFrameResponse` sequence. (Independently confirmed by
  `worker-coordination.md:566-570`.) A Rust port's equivalent channel back to TypeScript
  (however the N-API boundary structures the "return `stateSnapshots`-equivalent data" call,
  §1.2) must preserve this same strict FIFO/index order — TypeScript's existing consumer
  code has no way to re-sort out-of-order frames.
- **`expandSharedArchiveSelectedLayoutReveal`'s output order**
  (`sharedArchiveHistory.ts:19`, `Array.from({length: frame.placements.length + 1}, (_,
  stepIndex) => ...)`): identical ascending-integer-sequence pattern to
  `selectedLayoutRevealSnapshots`, applied to one already-terminal frame's `placements`
  array instead of to `placedCollisionGeometries` — by construction it reproduces the same
  stepIndex/placements-prefix relationship as the live producer, which is what makes it a
  faithful "legacy expansion" (see §12 for why this can also produce **duplicate**
  entries when misapplied to an already-expanded frame array).
- **`runHistoryGif.ts:26-61` (`selectFirstBeamSequence`)**: not part of this cluster's four
  files, but its ordering consumes this cluster's output — `flatMap` then
  `Map<number, frame>` keyed by `stepIndex` (`:31-46`, last write per key wins because later
  array entries overwrite earlier `.set()` calls for the same key — a genuine "last insertion
  wins per key" Map-as-lookup-table pattern, not an iteration-order hazard, since the final
  `[...selectedByStep.values()]` is explicitly re-sorted by `stepIndex`, `:47`).
- **`RunHistoryArchiveService.ts`**: `[...new Set(jobIds)]` (`:15`) preserves first-seen
  order (inert, §4); `ownedHistoryPaths`'s per-job `[ndjson, decision-trace]` file-name
  order (`:23`) is fixed and always the same two-element order.
- **No `localeCompare`, no `Array.prototype.sort`/`toSorted`, and no stable-sort reliance
  exists inside any of this cluster's four files.** (The `localeCompare` sorts that feed
  `decodeId`/`chromosomeId` values live in `windowedBeam.ts`/`portfolioSearch.ts` — see §12
  for why they are documented here anyway.)

---

## 6. Comparators and tie rules: exact comparison chains, signs, tie-breakers

**None** exist inside this cluster's four files — no file performs a numeric or geometric
comparison, ranking, or tie-break of any kind. `expandSharedArchiveSelectedLayoutReveal`'s
only conditional logic is three independent boolean guards (`isIrregularHistoryFrame`, exact
string equality against `'shared-archive-final-selected'`, `placements.length === 0`) — none
of these is a comparator in the ranking/ordering sense.

The two `localeCompare`-based sorts that construct values *consumed* by this cluster
(`decodeId`/`chromosomeId`/`transformPreferences` ordering inside `decode_started` events)
belong to `windowedBeam.ts`/`portfolioSearch.ts` and are noted for completeness in §12, not
re-specified as this cluster's own comparators.

---

## 7. Numeric semantics: BigInt, Number arithmetic, Math.*, rounding, signed zero, NaN/Infinity, float-to-grid

- **No `BigInt` usage anywhere in this cluster's four files.**
- **No canonical-grid, exact-integer, or Clipper2 geometry arithmetic** — this cluster only
  ever copies already-computed `number` fields (mm-scale floats, counts, ratios) from other
  clusters' score/state objects into DTOs (`decisionTraceLocalScore`/`decisionTraceLayoutScore`,
  `windowedBeam.ts:2728-2765`, out-of-cluster but worth noting: it performs **no arithmetic
  at all**, purely field-for-field copies).
- **`IrregularDecisionTraceIdRegistry`'s only numeric operation** is `this.nextId.toString(36)`
  (`decisionTrace.ts:19`) — JavaScript's `Number.prototype.toString(radix)` for base-36,
  lowercase alphanumeric digits `0-9a-z`. `nextId` starts at `0` and increments by exactly
  `1` per new key (`:20`); it is a plain JS safe integer counter with no overflow concern at
  any realistic event volume (would need `2^53` distinct canonical keys to lose precision —
  categorically unreachable). A Rust port reproducing this (only needed if the dead legacy
  path is ever ported, §15) must replicate exact lowercase base-36 digit encoding, not
  uppercase or a different alphabet.
- **`stepIndex` arithmetic**: `selectedLayoutRevealSnapshots` and
  `expandSharedArchiveSelectedLayoutReveal` both use `Array.from({length: n+1}, (_, i) => ...)`
  — plain non-negative integer indices, no float involved, `n` bounded by piece count
  (never large enough to be a precision concern).
- **`beamRank: 0, beamWidth: 1, candidateCount: 1`** are literal integer constants for every
  synthetic shared-archive-sourced snapshot/expanded-frame (`computeIrregularNesting.ts:1679-1680`,
  `sharedArchiveHistory.ts:32-34`) — not derived from any search-time beam width; these are
  placeholder values asserting "this frame is not a real multi-candidate beam step."
- **`createdAt` timestamps**: `new Date().toISOString()` (per-frame, live path,
  `nesting.worker.ts:366`) vs. a single shared `algorithmBenchmark.endedAt` (discarded path,
  `irregularWorkerOutput.ts:128`) — both are wall-clock-derived ISO-8601 strings, explicitly
  a non-semantic/diagnostic field per the migration prompt's timing-field guidance (§11); no
  differential byte-exactness is expected or required for this field.
- **No `Math.*` calls** anywhere in this cluster's four files.
- **No signed-zero, NaN, Infinity, or safe-integer guard logic** anywhere in this cluster's
  four files — every numeric field this cluster touches is a pass-through copy or a small
  non-negative integer counter/index.

---

## 8. Serialization and hashing

- **Decision-trace NDJSON** (`decisionTraceNdjson.ts:33-37`,
  `serializeIrregularDecisionTraceBatch`): `${events.map((event) =>
  JSON.stringify(event)).join('\n')}\n` — one `JSON.stringify` call per event, joined with a
  bare `'\n'` between events, plus exactly one **trailing** `'\n'` after the whole batch
  (present even for a single-event batch; note an **empty** `events` array still produces
  the string `'\n'`, i.e. one bare newline — relevant because §1.1 established that this is
  exactly what happens if the dead path were ever mistakenly flushed with an empty array,
  though in practice `.flush()` short-circuits before calling this function at all when
  `pendingEvents.length === 0`, `decisionTraceNdjson.ts:25`, so the batch-file
  code path never actually emits a bare `'\n'`; the standalone script
  `scripts/irregular-sheet-trace-dump.ts:143` has its own inline equivalent,
  `events.map(...).join('\n') + '\n'`, which **is** reached unconditionally and **does**
  write a lone `'\n'` for a zero-event run, per §1.1's mixed-61 finding).
- **JSON key order for every decision-trace event is exactly the class's field-declaration
  order** (§3.3's table), not alphabetical and not JS-`Map`-derived. This follows from
  `useDefineForClassFields: true` (`tsconfig.node.json:19`, target `ES2022`,
  `tsconfig.node.json:3`): every declared class field — even ones without an initializer —
  is defined as an own enumerable property, **in declaration order**, at construction time,
  immediately after `super()` returns and before the rest of the constructor body executes.
  Concretely, for e.g. `IrregularDecisionTraceBeamStepStarted`
  (`decisionTrace.ts:269-279`): `super(input)` first defines+assigns `decodeId`,
  `chromosomeId`, `decodeSource` (base class field order, `:48-50`, assigned in its own
  constructor `:53-55`); then the subclass's own field section defines `kind` (with its
  literal initializer), `stepIndex`, `parentCount` (no initializers, defined as `undefined`
  at this point) in that declaration order; only then does the subclass constructor body run
  `this.stepIndex = input.stepIndex; this.parentCount = input.parentCount` — these are value
  updates to already-existing keys, which **do not** change their position in
  `JSON.stringify`'s enumeration order (JS own-property key order is fixed at first
  definition, not at last write). Net key order:
  **`decodeId, chromosomeId, decodeSource, kind, stepIndex, parentCount`** — matching the
  `local_candidate_summary` example verified byte-for-byte by
  `tests/unit/decisionTraceNdjson.test.ts:89-135`. A Rust `serde_json` struct with fields
  declared in the same order (default derive, no `#[serde(rename_all)]`/reordering) will
  reproduce this key order exactly, since `serde_json` serializes named-struct fields in
  their Rust declaration order by default.
- **No `undefined`-omission logic exists in `decisionTrace.ts`** — every field is required,
  so there is nothing to omit. Contrast with `IrregularHistoryFrame`'s real
  `Schema.optional` fields (§3.5), where TypeScript's spread-conditional pattern
  (`...(x !== undefined ? {field: x} : {})`) is used **elsewhere** (`irregularWorkerOutput.ts`
  does not need this pattern for `candidateCount`/etc. because it simply never passes those
  keys to the constructor at all, which is equivalent).
- **History-frame NDJSON** (`nesting.worker.ts:103-110`, `appendFrame`, not this cluster's
  own file but the sink for this cluster's live-path output): `` `${JSON.stringify(frame)}\n` ``
  — one frame per line, one trailing newline per **append call** (not per batch — each
  `emitFrame` invocation does its own `fs.writeFileString(path, ..., {flag: 'a'})`), so the
  file accumulates one JSON object per physical line, in emission order (§5).
  `IrregularHistoryFrame`'s JSON key order is **schema field declaration order** (§3.5),
  which for a `Schema.Class` follows the `Schema.Struct` field declaration order in
  `domain.ts:999-1017`, not JS class-field order (this is Effect Schema serialization, a
  different mechanism from the plain-class `JSON.stringify` used by decision-trace events —
  Schema encoding is not verified byte-for-byte in this document since `IrregularHistoryFrame`
  belongs primarily to another cluster's schema surface; flagged as an open question in §15
  only insofar as it affects `.ndjson` replay-file byte reproduction).
- **`RunHistoryArchiveService.ts` has no serialization or hashing of its own** — it only
  computes file *paths* (via `Path.resolve`/`Path.basename`/`Path.relative`), never file
  contents.
- **Nothing in this cluster feeds a SHA-256 hash or a cache/state key.** Decision-trace and
  history-frame NDJSON are terminal, human/tooling-facing diagnostic artifacts, not inputs to
  any canonical identity, cache key, or checkpoint hash computed elsewhere in the algorithm.
  (Contrast explicitly with the migration prompt's "canonical JSON bytes used by hashes" —
  none of this cluster's bytes are that.)

---

## 9. Caches touched and the exact historical access sequence

**None.** No file in this cluster reads from or writes to any geometry cache, NFP/IFP cache,
canonical-key cache, or checkpoint store. The only "storage" this cluster performs is (a) an
in-memory event/frame buffer pending flush (`IrregularDecisionTraceBatcher.pendingEvents`,
§4) and (b) append-only writes to two flat NDJSON files per job on the local filesystem
(owned by `nesting.worker.ts`, not this cluster's files) and their eventual deletion
(`RunHistoryArchiveService.ts`).

---

## 10. Cancellation / deadline / budget / evaluation-cap observation points

- **Decision-trace event emission** (dead path, §1.1) has **no cancellation-aware logic of
  its own** in `decisionTrace.ts`/`decisionTraceNdjson.ts` — any cancellation/deadline
  handling that would gate whether a `decisionTrace?.emit(...)` call happens at all lives
  entirely in `windowedBeam.ts`'s decode loop (a different cluster's concern).
- **Selected-layout reveal emission is entirely post-decision.** The
  `for (const snapshot of selected.stateSnapshots) input.options?.emitStateSnapshot?.(...)`
  loop (`computeIrregularNesting.ts:1204-1206`) only runs **after** `selected` (the fully
  materialized winning decode) exists — i.e. after every cancellation/deadline/evaluation-cap
  check upstream in the coordinator has already resolved to "success." There is **no**
  partial-run frame emission: if the coordinator fails, is cancelled, or times out before
  `selected` is computed, this loop never executes and **zero** history frames are emitted
  for that run, consistent with the migration prompt's "no partial result" rule (§2/§15
  there). The loop itself is a plain synchronous JS `for` loop over an already-fully-known,
  in-memory array — it does not re-check cancellation/deadline mid-loop, and cannot be
  interrupted once started (matches "Current TypeScript control checks are often lazy and
  placed at specific cooperative boundaries" — this is exactly such a boundary, positioned
  *after* the decision, not during it).
- **`IrregularDecisionTraceBatcher`/`decisionTraceNdjson.ts` have no cancellation logic** —
  `.add()`/`.flush()` are unconditional synchronous operations. The one place cancellation
  interacts with this machinery is `nesting.worker.ts:274-279`'s `Effect.ensuring(...)` block,
  which calls `decisionTraceBatcher?.flush()` and closes both queues **regardless of whether
  the computation succeeded, failed, or was cancelled** — this is `nesting.worker.ts`'s
  contract, not this cluster's, but it is the reason a cancelled/failed job still produces a
  syntactically-valid (possibly empty) `.decision-trace.ndjson` file rather than a truncated
  one.
- **`RunHistoryArchiveService.ts` has no cancellation/deadline/budget semantics** — file
  deletion is a short, synchronous-per-file sequential operation with no cooperative
  cancellation points; a mid-batch process kill could leave a partial set of files deleted
  (this is an accepted risk of the underlying `fs.remove` calls, not a documented
  algorithmic cancellation boundary).
- **No evaluation cap, trace cap, or memory cap of any kind is implemented anywhere in this
  cluster.** The only numeric bound present is `DECISION_TRACE_BATCH_EVENT_LIMIT = 256`
  (`decisionTraceNdjson.ts:3`), which is a **batch-flush granularity**, not a total-event
  cap — an unboundedly long decision-trace run (on the legacy branch) would flush every 256
  events indefinitely and grow the `.decision-trace.ndjson` file without limit. There is no
  code anywhere in this cluster (or, per `worker-coordination.md:311-313`'s independently
  confirmed finding, anywhere on the irregular worker path) that caps total frame count or
  total trace-event count; `maxHistoryEvents` is decoded from the request but never read.

---

## 11. Error paths: tagged error classes, categories, context fields, propagation

- **`RunHistoryArchiveError extends Error`** (`RunHistoryArchiveService.ts:7`) — the only
  typed error class in this cluster. Thrown in exactly two places:
  1. `ownedHistoryPaths` (`:20`): `Invalid saved-run job id: ${jobId}` when
     `!SAFE_JOB_ID.test(jobId) || path.basename(jobId) !== jobId` — `SAFE_JOB_ID =
     /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/` (`:5`), and the `path.basename(jobId) !== jobId` check
     additionally rejects any id containing a path separator that the regex alone might miss
     on some platforms.
  2. `ownedHistoryPaths` (`:26-28`): `History path is outside the managed directory:
     ${fileName}` when `path.relative(root, candidate) !== fileName` — a defense-in-depth
     check against path traversal even after the id-format check.
  `removeRunHistoryFiles` wraps the synchronous `ownedHistoryPaths` call in
  `Effect.try({try, catch})` (`:44-52`), remapping any **non**-`RunHistoryArchiveError`
  thrown value into a fresh `RunHistoryArchiveError` with a fallback message (`error
  instanceof Error ? error.message : 'Invalid saved-run history path.'`), and remaps every
  per-file `fs.remove` failure into `Could not delete saved-run history ${ownedPath}:
  ${String(error)}` (`:56-64`).
  Propagation: `deleteRunHistoryFiles` runs the whole Effect via `appRuntime.runPromise`
  (`:76`), so a thrown `RunHistoryArchiveError` surfaces as a rejected `Promise`. The IPC
  handler (`src/main/ipc/handlers.ts:734-765`, not this cluster's file) catches it and maps
  to `{ ok: false, error: { code: 'file_write_error', message: ... } }`, special-casing
  `error instanceof RunHistoryArchiveError` to use its message directly.
- **`decisionTrace.ts`/`decisionTraceNdjson.ts` define no error types and throw nothing of
  their own.** Any I/O failure while writing the decision-trace/history NDJSON files
  surfaces as a generic `PlatformError.PlatformError` from the Effect `FileSystem` service
  (`nesting.worker.ts:112-154`'s return-type signatures), which propagates up through
  `handleRunNesting`'s outer `Effect.catchCause` (`nesting.worker.ts:327-337`) into a
  `WorkerFailureResponse.unknown(...)` — this is `nesting.worker.ts`'s error contract, not a
  distinct one owned by this cluster.
- **`sharedArchiveHistory.ts` throws nothing** — `expandSharedArchiveSelectedLayoutReveal`
  is a total function over its `NestingHistoryFramePayload` input type; every branch returns
  an array, never throws.

---

## 12. JS-specific semantics hazards for a Rust port

1. **Class-field declaration order determines JSON key order** (§8) — this is the single
   most important hazard in this cluster if the legacy decision-trace path is ever ported.
   A naive Rust struct with fields in a "logical" or alphabetized order, or a `#[serde(flatten)]`/
   `HashMap`-based approach, would silently produce different byte output. The exact
   per-event field order is tabulated in §3.3 specifically to make this unnecessary to
   re-derive.
2. **`Number.prototype.toString(36)` id encoding** (§7) — Rust has no built-in equivalent;
   must hand-roll base-36 lowercase-alphanumeric encoding (`0-9` then `a-z`) to match `s0,
   ..., s9, sa, ..., sz, s10, ...` exactly, not e.g. uppercase or a different digit order.
3. **`localeCompare`-sorted values feeding this cluster's `decodeId`/event payloads** (owned
   by `windowedBeam.ts`/`portfolioSearch.ts`, a different cluster, but the resulting strings
   land inside this cluster's event objects): `windowedBeam.ts:387-388`
   (`[...transformPreferences.entries()].toSorted(([first],[second]) =>
   first.localeCompare(second))`, feeding `decode_started.transformPreferences`) and
   `portfolioSearch.ts:1075-1076` (`.sort(([first],[second]) =>
   first.localeCompare(second))`, feeding `chromosomeKey` → `chromosomeId`). JavaScript's
   `String.prototype.localeCompare` without explicit locale/options arguments uses the
   **host's default locale collation**, which is not guaranteed to equal simple UTF-16
   code-unit ordering (e.g. case-folding, accent-insensitivity can vary by ICU
   configuration/Node build). Piece ids in this codebase are typically ASCII-only in
   practice, which makes this low-risk in practice, but it is not proven ASCII-only by
   schema — a Rust port that ever needs to reproduce this exact ordering (only relevant if
   the dead legacy/GA path is ported, §15) must either replicate host-locale collation via a
   real ICU binding or prove the input domain is always plain ASCII so ordinal comparison is
   provably equivalent.
4. **`expandSharedArchiveSelectedLayoutReveal` is idempotent-by-construction only under an
   unstated assumption, and re-expanding an already-expanded frame array is untested.**
   `runHistoryGif.ts:30` applies `expandSharedArchiveSelectedLayoutReveal` unconditionally to
   **every** frame in an already-loaded run (`frames.flatMap(...)`), not just a legacy
   single-frame run. For a **modern** multi-frame run (the only kind Compact/Compact Short
   Side ever produces today, per §1.2), this means: the `N` intermediate
   `'shared-archive-selected-layout-reveal'` frames pass through the guard unchanged (title
   mismatch, `sharedArchiveHistory.ts:10`), but the **terminal**
   `'shared-archive-final-selected'` frame (the last array element) gets **re-expanded** into
   a fresh `N+1`-element sequence with different `frameId`s
   (`${frame.frameId}:selected-layout-reveal:${stepIndex}`, `sharedArchiveHistory.ts:21`).
   The subsequent `Map<number, frame>` keyed by `stepIndex`
   (`runHistoryGif.ts:31-46`) then has its steps `0..N-1` **overwritten** by the freshly
   re-expanded values (later array position wins on `.set()`), and step `N` populated only
   from the re-expansion (the original unexpanded terminal frame object itself never survives
   into `expandedFrames`, since `flatMap` replaces it entirely). Because both the "natural"
   per-step frames and the "re-expanded" ones are ultimately derived from the *same*
   `placedCollisionGeometries` order (traced in §5), their `placements`/`remainingPieceIds`/
   `collisionPolygons` content should be equal at each shared `stepIndex` — but this
   equivalence is an inference from tracing the producer code, **not verified by any
   existing test**: `tests/renderer/runHistoryGif.test.ts:85-102`
   (`'expands a legacy terminal-only shared archive replay for GIF export'`) exercises
   `expandSharedArchiveSelectedLayoutReveal` only against a **single**-frame array (the
   explicitly-legacy shape), never against a full modern multi-frame array. This is entirely
   TypeScript renderer code (permanently out of Rust's scope, migration prompt §4.2), so it
   has **no direct Rust-port implication**, but it is a genuine, previously-undocumented gap
   in test coverage of production-adjacent replay behavior worth flagging (§15).
5. **`sharedArchiveHistory.ts:28`'s `frame.collisionPolygons === undefined` check is likely
   unreachable through the schema-decoded `NestingHistoryFramePayload` type** (§3.5) — Effect
   Schema's `Schema.withConstructorDefault`/`Schema.withDecodingDefaultKey` on
   `IrregularCollisionPolygons` (`domain.ts:209-213`) means both direct construction and
   schema decoding fill in `[]` when the key is absent, so a real `IrregularHistoryFrame`
   instance should never expose `collisionPolygons === undefined` at runtime. This is
   defensive code, not evidence of a genuine optional/omitted-field production case — a Rust
   implementer should not read this as proof that `collisionPolygons` can be truly absent on
   the wire.
6. **`useDefineForClassFields`/ES2022 semantics are load-bearing, not incidental** — this
   repository's `tsconfig.node.json:3,19` pins `target: ES2022`,
   `useDefineForClassFields: true`. If this ever changed (e.g. a build-tooling upgrade
   flipping the default), the class-field-definition-order guarantee in §8 could silently
   change to "constructor-body-assignment order" instead, which happens to coincide with
   declaration order in every event class in this file today (verified by inspection of all
   15+9 classes) but is not guaranteed to stay coincident if a future class ever assigns
   fields out of declaration order in its constructor body.

---

## 13. Parallelism assessment: pure/independent vs chronology-bound

This cluster is **entirely chronology-bound / sequential-emission by nature**, and none of
it is a candidate for Rayon parallelism, for a simple reason: **almost none of it runs at
all for Compact/Compact Short Side** (§1.1), and the part that does run
(`selectedLayoutRevealSnapshots` + the `emitStateSnapshot` loop) is diagnostic/history
construction that happens strictly **after** the authoritative search/selection decision has
already been made and is order-sensitive only insofar as it must preserve stepIndex order
into an append-only file and an ordered IPC stream that TypeScript's existing single-threaded
consumer code expects.

- **`selectedLayoutRevealSnapshots`** (`computeIrregularNesting.ts:1659-1692`): each
  snapshot at index `i` is a pure function of `placedCollisionGeometries.slice(0, i)` and
  `preparedById` (read-only lookup) — the **individual snapshot constructions are mutually
  independent** and could in principle be computed in parallel by stable index. However,
  this loop is O(N) small-object construction over a piece count that is never large enough
  (bounded by sheet capacity, typically tens to low hundreds of pieces) to justify Rayon
  overhead, and the entire array must still be handed back to TypeScript in stepIndex order
  regardless — there is no realistic performance benefit to parallelizing this, and doing so
  would need a full serial re-assembly step immediately after (migration prompt §14.3's
  pattern) for zero measured gain. **Recommendation: keep serial.**
- **The `emitStateSnapshot` for-loop / frame emission chain**
  (`computeIrregularNesting.ts:1204-1206` through `nesting.worker.ts`'s queues): this is a
  **chronology-bound, ordered side-effect stream** by explicit contract (migration prompt
  §15: "Preserve the exact logical event count, phase sequence, ordering... Do not drop,
  merge, coalesce, or reorder logical progress events"). It must remain strictly serial and
  index-ordered. **Must stay serial — this is exactly the kind of "global trace append
  operations" and "protocol-visible progress" the migration prompt explicitly forbids
  parallelizing (§14.2).**
- **Decision-trace event emission** (dead path, §1.1): even if a future change reactivated
  this path for Compact/Compact Short Side, `windowedBeam.ts`'s trace calls are interleaved
  with the beam search's own sequential state mutations (parent/successor construction,
  incumbent tracking) — this is unambiguously chronology-bound and explicitly named in the
  migration prompt's high-risk list ("global trace append operations from Rayon workers,"
  §14.2). **Must stay serial**, and in any case is out of this migration's scope today since
  it never executes for the two target profiles.
- **`RunHistoryArchiveService.ts`**: file deletion is already explicitly serialized
  (`{ concurrency: 1, discard: true }`, `RunHistoryArchiveService.ts:67`) by the existing
  TypeScript implementation itself, and this file is permanently outside Rust's scope
  regardless (main-process service, migration prompt §4.2) — not a parallelism question for
  this migration.
- **`sharedArchiveHistory.ts`**: pure, side-effect-free, renderer-only, never touches the
  Rust boundary — not a parallelism question for this migration.

**Summary: nothing in this cluster is a Rayon candidate.** The live portion is either too
small to matter (`selectedLayoutRevealSnapshots`'s per-snapshot construction) or explicitly
required to stay serial by the migration prompt's own rules (ordered frame/trace emission).

---

## 14. Tests and gates covering this cluster

Exact files, verified by grep (`grep -rln` over `tests/` for each cluster concern):

- **`tests/unit/decisionTraceNdjson.test.ts`** (full file read, §1.1) — exercises
  `IrregularDecisionTraceBatcher` batching-threshold behavior and
  `serializeIrregularDecisionTraceBatch`'s exact NDJSON bytes/key-order, using
  hand-constructed event instances (does not exercise the dead production emission path;
  tests the encoding module in isolation).
- **`tests/unit/irregularWorkerCompute.test.ts:206-227`** (`'emits decision traces only when
  history is enabled'`) — the only test that exercises `decisionTrace.ts` events end-to-end
  through `computeIrregularNesting`, and only by constructing `IrregularOptimizerSettings`
  directly (not via `makeCompactQualityIrregularOptimizerSettings`), which leaves
  `intrinsicSharedArchiveEnabled` at its schema-default `false` — i.e. this test
  deliberately targets the legacy/non-Compact branch, consistent with §1.1.
  `tests/unit/irregularWorkerCompute.test.ts:229-280` (`'keeps real transform placements and
  tagged beam history at the worker boundary'`) exercises `makeIrregularWorkerOutput`'s
  (call-site-discarded-in-production, §1.2) `historyFrames` field directly, including the
  assertion `expect(emittedStepIndexes).toEqual(output.historyFrames.map((frame) =>
  frame.stepIndex))` (`:280`) that proves the live `emitStateSnapshot` sequence and the
  discarded `historyFrames` field agree on stepIndex ordering.
- **`tests/unit/irregularTriangleCompactGolden.test.ts:190-200`** and
  **`tests/unit/intrinsicCapacityIntegration.test.ts:320-361`** — production-shaped golden/
  integration tests that call `makeIrregularWorkerOutput` and assert the full
  `'shared-archive-selected-layout-reveal'` → `'shared-archive-final-selected'` title
  sequence and frame count (`TRIANGLE_COUNT + 1`, `2` respectively) for real Compact
  archive/capacity runs — these are the tests that actually pin down §1.2's live-path
  contract (title values, frame count, empty-then-full placements progression).
- **`tests/unit/workerProtocol.test.ts:112-133`** (`'accepts optional decision-trace
  metadata without requiring it for older summaries'`) — schema round-trip test proving
  `NestingHistorySummary.decisionTracePath`/`decisionTraceEventCount` are true optionals
  (both must validate present and both absent; no partial-presence case tested, consistent
  with §3.6's "always present together" contract).
- **`tests/unit/runHistoryArchiveService.test.ts`** (full file read, §4/§11) — three tests:
  deletes both managed files and leaves unrelated files untouched; treats already-missing
  files as successful deletion; validates every job id before deleting any file (proves the
  "validate-all-then-delete-all" atomicity claim in §4).
- **`tests/renderer/runHistoryGif.test.ts:85-102`** (`'expands a legacy terminal-only shared
  archive replay for GIF export'`) — the only direct test of
  `expandSharedArchiveSelectedLayoutReveal`'s expansion behavior, and only against the
  single-frame legacy shape (see §12 point 4 for the untested modern-multi-frame case).
  `tests/renderer/runHistoryGif.test.ts:66-83` additionally tests
  `selectFirstBeamSequence`'s meaningful-frame-collapsing logic on non-shared-archive
  (plain-title) frames, unrelated to the expansion shim.
- **`tests/renderer/useHistoryStore.test.ts`** — exercises `pushFrame`
  deduplication/replay-frame-return behavior generally; does **not** specifically test the
  `expandSharedArchiveSelectedLayoutReveal` branch inside `pushFrame`
  (`useHistoryStore.ts:283`) with a `'shared-archive-final-selected'`-titled first frame —
  another coverage gap noted for completeness, not exercised anywhere in `tests/`.
- **`tests/unit/ipcChannels.test.ts:10`** and **`tests/unit/appApiContract.test.ts:23,61`** —
  channel-name/contract-shape presence tests for `nesting:delete-run-histories`/
  `deleteRunHistories`; do not exercise behavior (covered instead by
  `runHistoryArchiveService.test.ts`).
- **Not a gate**: `scripts/irregular-sheet-trace-dump.ts` is a standalone diagnostics script
  (§1.1), not referenced by `package.json` `scripts` or any `.github/` workflow — verified by
  `grep -rn "irregular-sheet-trace-dump" .github/` (no hits) and inspection of
  `package.json`.
- **No dedicated test file exists for `sharedArchiveHistory.ts` itself** (verified: no
  `tests/**/sharedArchiveHistory*.test.ts`); its behavior is only exercised indirectly
  through `runHistoryGif.test.ts` and (partially, per above) `useHistoryStore.test.ts`.

---

## 15. Open questions and ambiguities

1. **Does the Rust port need to reproduce `decisionTrace.ts`/`decisionTraceNdjson.ts` at
   all?** Per §1.1, this entire event stream is dead for Compact/Compact Short Side
   production defaults — it is only reachable via the legacy, `'legacy-requires-migration'`-
   labeled, non-archive-eligible branch (`windowedBeam.ts`/`portfolioSearch.ts`), which the
   migration prompt's non-negotiable objective (§1 there) scopes to exactly two profiles
   (Compact, Compact Short Side), neither of which reaches this branch under production
   defaults. If the orchestrator's differential/parity harness (migration prompt §18) ever
   needs to run the *legacy* branch through Rust too (e.g. as an oracle for GA-mode
   regression tests that are not part of this migration's two target profiles), then this
   cluster's event types and exact NDJSON byte contract (§3.3, §8) would need a Rust
   equivalent. Otherwise, the only Rust-port obligation for this half of the cluster is
   arguably **none** — TypeScript can keep creating the (always-empty, for Compact/CSS)
   `.decision-trace.ndjson` file exactly as it does today, entirely outside the Rust
   boundary, with zero behavior change. **Recommend the orchestrator explicitly rule on
   this** rather than default to porting 693 lines of dead-for-target-profile DTOs.
2. **`scripts/irregular-sheet-trace-dump.ts`'s docstring is stale/misleading against current
   production defaults** (§1.1): it claims to capture real decision-trace data for the
   Mixed-61 corpus, but the corpus's settings are production-eligible (archive-enabled),
   so it captures zero events today. This mirrors the exact kind of "stale prose" caveat the
   migration prompt calls out for `irregularWorkerOutput.ts`'s Short Side fallback comment
   (§12 there) — worth an identical "correct the comment without touching behavior or
   contract" fix, but that is a documentation cleanup outside this Stage 0 characterization
   task's mandate (no source changes were made here).
3. **`makeIrregularWorkerOutput`'s `historyFrames` field is computed but discarded at its one
   production call site** (§1.2). This raises a genuine design question for the Rust
   boundary: should Rust's equivalent of "materialize the final result" avoid computing an
   equivalent `historyFrames`-shaped structure at all (since production never reads it,
   this would be a legitimate "only accepted production improvement is execution time"
   optimization per migration prompt §2), while still returning the `stateSnapshots`-
   equivalent data that the **live** `emitStateSnapshot` path needs? This document recommends
   yes — Rust should only need to produce the `IrregularStateSnapshot`-equivalent sequence
   once (feeding the live per-frame emission path via whatever N-API shape is chosen), not
   twice. This is a design recommendation, not a requirement verified against source, since
   the actual N-API surface does not exist yet.
4. **`expandSharedArchiveSelectedLayoutReveal` applied to an already-fully-expanded modern
   frame array is untested and not fully proven equivalent by this document** (§12 point 4).
   This is pure TypeScript renderer code with no Rust-port implication, but a parity
   reviewer or future maintainer should know this gap exists before assuming
   `runHistoryGif.ts`'s GIF-export output for a *current* Compact/Compact Short Side run is
   provably free of subtle frame-content duplication/overwrite artifacts. Recommend a
   follow-up renderer-side test (not a Rust-port blocker) asserting
   `expandSharedArchiveSelectedLayoutReveal`'s re-expansion of a terminal frame taken from a
   full modern multi-frame array produces content-identical (mod `frameId`) results to the
   original per-step frames at each shared `stepIndex`.
5. **`IrregularHistoryFrame`'s Effect-Schema JSON encoding key order was not independently
   byte-verified in this document** (§8) — this document verified `decisionTrace.ts`'s plain-
   class `JSON.stringify` key order exhaustively (§3.3, §8), because that mechanism is fully
   owned by this cluster's files. `IrregularHistoryFrame`'s persisted `.ndjson` bytes use
   Effect Schema's own serialization path (`domain.ts:999-1034`, a different cluster's
   schema surface), and this document did not re-verify that Schema-class JSON encoding
   follows the same "struct declaration order" rule as plain classes (it very likely does,
   since Effect's `Schema.Class` also produces a real JS class with fields assigned in
   declaration order, but this was not independently confirmed by test inspection the way
   §8's decision-trace claim was). Flagged for whichever cluster document owns
   `src/shared/irregular/domain.ts`/`src/shared/domain/nesting.ts` schema serialization to
   confirm or correct.
6. **No total decision-trace-event or history-frame cap exists anywhere in current source**
   (§10) — only a 256-event *batch-flush granularity*. If the orchestrator expected a
   documented "trace cap" per the task's special focus, the source-level truth is: **there
   isn't one.** `maxHistoryEvents` is decoded from the request schema but never read by any
   consumer under `src/workers/` or `src/main/` (confirmed independently in
   `worker-coordination.md:311-313` and re-confirmed here). This is the reportable "SOURCE
   truth" the task instructions ask to surface prominently when it contradicts an assumed
   summary: **there is no trace-cap or frame-cap enforcement to preserve**, only the
   batch-flush size, which is a pure I/O-chunking implementation detail with no observable
   effect on trace *content*.
