# Worker Coordination — Characterization

Cluster: `worker-coordination`. This document characterizes the coarse-grained
coordination boundary that a future N-API call must reproduce: the worker
protocol shell, the irregular compute coordinator, and the worker-facing
result/history adapter.

Files read completely for this document:

- `src/workers/nesting.worker.ts` (492 lines)
- `src/workers/algorithm/irregular/computeIrregularNesting.ts` (1921 lines)
- `src/workers/algorithm/irregular/irregularWorkerOutput.ts` (236 lines)
- `src/shared/protocol/worker.ts` (188 lines)
- `src/shared/protocol/errors.ts` (43 lines)

Files read partially/for context (owned by other clusters; cited only where
this cluster directly touches them): `src/shared/domain/nesting.ts`,
`src/shared/irregular/domain.ts`, `src/shared/irregular/defaults.ts`,
`src/shared/irregular/executionMode.ts`, `src/shared/domain/ids.ts`,
`src/workers/algorithm/sortPiecesForNesting.ts`,
`src/workers/decisionTraceNdjson.ts`,
`src/workers/algorithm/irregular/decisionTrace.ts` (signatures only),
`src/workers/irregular/services.ts` (signatures only),
`src/workers/irregular/geometryKernel.ts` (signatures only),
`src/main/services/WorkerSupervisor.ts`, `src/main/ipc/handlers.ts`,
`src/shared/schemas/nestingSchemas.ts`, `src/shared/protocol/ipc.ts`,
`src/renderer/utils/irregularSettingsUi.ts`,
`docs/operations/irregular-production-gates.md`.

**Note on the migration prompt's knowledge map.** `docs/prompts/fable5-rust-irregular-nesting-implementation.md`
section 5 directs the implementer to start from `knowledge/INDEX.md` and a
list of `knowledge/*.md` pages. **No `knowledge/` directory exists in this
checkout** (`find` from repo root confirms it). The equivalent living
documentation is under `docs/architecture/` (see `docs/architecture/index.md`
as the real index), `docs/research/` (e.g.
`docs/research/compact-short-side-observer.md`, which is the file the prompt
calls `knowledge/compact-short-side-observer.md`), `docs/artifacts/`, and
`docs/operations/irregular-production-gates.md`. Every subsequent Stage-0
document produced for this migration should cite `docs/architecture/`,
`docs/research/`, `docs/artifacts/`, and `docs/operations/` instead of
`knowledge/`. This is reported prominently in section 15 and in the
structured `openQuestions`.

---

## 1. Purpose and role in Compact / Compact Short Side execution

This cluster is the **coarse coordination shell**: it is the seam the
migration prompt calls out as the future N-API boundary. Concretely:

- `src/workers/nesting.worker.ts` is the Node `worker_thread` entry point
  (an Effect RPC server, `RunNesting` is its only registered RPC,
  `worker.ts:176-182`). It receives an already schema-validated
  `NestingRequest`, chooses rectangular vs. irregular algorithm by
  `payload.options.workerMode` (`nesting.worker.ts:240`, `:348`), wires the
  Effect service layers the irregular pipeline needs
  (`nesting.worker.ts:391-398`), and translates the algorithm's typed error
  channel and progress/history callbacks into the wire protocol
  (`WorkerResponse` union, `worker.ts:162-169`).
- `src/workers/algorithm/irregular/computeIrregularNesting.ts` is the
  **irregular algorithm coordinator**. `computeIrregularNesting` (line 364)
  prepares pieces, then delegates to `coordinateIntrinsicSharedArchive`
  (line 474), which is the actual Compact/Compact-Short-Side orchestrator:
  archive-eligibility gate, preflight, scheduler cold-start, the shared
  archive run, capacity fallback, focused reconstruction, and — only when
  the Short Side profile is requested — the short-side observer and
  pair-fold construction. It does **not** implement NFP/IFP/candidate
  generation/beam search itself; those live in sibling files this document
  treats as callees (see section 2).
- `src/workers/algorithm/irregular/irregularWorkerOutput.ts` adapts one
  completed `IrregularComputeResult` into the shared `NestingResult` /
  `IrregularHistoryFrame` schemas that cross the RPC boundary and later get
  persisted (`makeIrregularWorkerOutput`, line 88).
- `src/shared/protocol/worker.ts` / `src/shared/protocol/errors.ts` define
  the wire schema (`WorkerRequest`, `WorkerResponse`, `AppErrorCode`) that
  both the worker and `WorkerSupervisor` decode against.

**Liveness on the production Compact / Compact Short Side path (traced, not
guessed):**

- `computeIrregularNesting` has exactly one non-test caller in the whole
  repository: `nesting.worker.ts:377`
  (`grep -rn "computeIrregularNesting\b" src` outside `tests/`/`scripts/`
  confirms this). `nesting.worker.ts` itself is spawned only by
  `WorkerSupervisor.makeWorkerThread` (`src/main/services/WorkerSupervisor.ts:200-224`,
  `workerPath` resolved at `WorkerSupervisor.ts:346` /
  `src/main/ipc/handlers.ts:154-160`). This is the sole production entry
  point. — **Live.**
- Inside `coordinateIntrinsicSharedArchive`, the `archiveEnabled` branch
  (`computeIrregularNesting.ts:483`, `504-1064`) is the Compact/Short-Side
  path. `archiveEnabled = isIntrinsicSharedArchiveEligible(input.settings)`
  (line 483) calls `intrinsicSharedArchiveEligibility`
  (`src/shared/irregular/executionMode.ts:16-32`), which is `true` only when
  `optimizer.intrinsicSharedArchiveEnabled === true`, the placement policy is
  not `short-side-fill`, and GA is disabled. The production default settings
  (`GeometrySettings.Make = DEFAULT_IRREGULAR_NESTING_SETTINGS`,
  `src/workers/irregular/geometryKernel.ts:38`, built from
  `makeCompactQualityIrregularOptimizerSettings` at
  `src/shared/irregular/defaults.ts:149-165,177-183`) always set
  `intrinsicSharedArchiveEnabled: true`, `baselineOnly: true`, `gaEnabled: false` —
  so **Compact is the production default**, and `archiveEnabled` is true for
  every request that does not override `irregularSettings` with something
  outside the two shipped presets. The renderer only exposes the two archive
  presets (`applyCompactQualityPreset` / `applyCompactShortSidePreset`,
  `src/renderer/utils/irregularSettingsUi.ts:53-68`). — **The archive branch
  is Live for both target profiles.**
- The `else` branch of that same `if` (`computeIrregularNesting.ts:1065-1069`,
  `runSingleSheetPortfolio` / `materializeProductionResult` /
  `reconstructPlacedGeometry`) is the legacy windowed-beam/GA path. It is
  reachable only when a request explicitly disables the shared archive or
  selects `short-side-fill`/GA — none of which the Compact or Compact Short
  Side profiles do. **Not exercised by Compact or Compact Short Side
  production traffic**, though it is exercised by other, non-migrated
  worker-mode configurations and by many unit tests. Do not port this branch
  as part of "Compact"; it is a distinct algorithm shape kept in TypeScript
  per the migration prompt's scope (rectangular stays TS; this legacy
  irregular beam path is not named in the prompt's Rust scope either, and its
  liveness for any *other* production workerMode should be confirmed by the
  orchestrator before deciding whether to port it at all).
- The Short-Side-specific block (`computeIrregularNesting.ts:1071-1203`,
  `observeIntrinsicShortSideOrientations`,
  `observeIntrinsicShortSidePairFold`,
  `materializeIntrinsicShortSideProfileResult`) runs only when
  `settledCompleteArchiveForShortSideObserver !== undefined` (i.e., the
  archive branch ran) **and** (`shortSideProfileRequested` **or** a
  benchmark-only observer option is set). For a plain "Compact" request
  (`intrinsicObjectiveProfileId: 'compact'`, the default,
  `src/shared/irregular/defaults.ts:47-48`) with no observer options, this
  entire block is skipped and `computeIrregularNesting` returns immediately
  with the archive/capacity winner. — **Live only for Compact Short Side**
  (`intrinsicObjectiveProfileId: 'short-side'`, set by
  `makeCompactShortSideIrregularOptimizerSettings`,
  `src/shared/irregular/defaults.ts:168-175`).
- `irregularWorkerOutput.ts`'s two exported functions
  (`makeIrregularHistoryFrame`, `makeIrregularWorkerOutput`) have exactly one
  production caller each, both in `nesting.worker.ts` (lines 358, 380) —
  confirmed by grep. — **Live.**

**Not live / decorative for this migration's two profiles, verified by
tracing, not assumed:**

- `IrregularDecisionTraceBatcher` / decision-trace NDJSON emission
  (`nesting.worker.ts:130-154, 205-260`, `decisionTraceNdjson.ts`,
  `decisionTrace.ts`) is wired into `ComputeIrregularNestingOptions.emitDecisionTrace`
  and forwarded, but `computeIrregularNesting.ts` only ever spreads
  `emitDecisionTrace` into a callee at **one** site: inside
  `runSingleSheetPortfolio` (line 1428-1431), which is the legacy
  windowed-beam/GA branch documented as dead above. `grep -n
  "emitDecisionTrace" computeIrregularNesting.ts` shows exactly two hits: the
  field declaration (line 119) and that one forwarding site. **For Compact
  and Compact Short Side, `emitDecisionTrace` is accepted but never invoked.**
  The decision-trace NDJSON file is still created (empty, just a truncate/
  append of `''`) whenever `historyMode !== 'off'` and `workerMode ===
  'irregular-convex-v2'` (`nesting.worker.ts:205-208`,
  `prepareDecisionTraceFile`), and `decisionTraceEventCount` in the returned
  `NestingHistorySummary` will always be `0` for these two profiles. See
  section 15 — this directly affects how much of `decisionTrace.ts` and
  `decisionTraceNdjson.ts` need Rust parity for Stage 2.
- `intrinsicAnytimeSchedulerMode`, `intrinsicCapacityRetentionShadow`,
  `captureCapacity*Telemetry`, `captureExperimentalPlaceDeferCompleteShadow`,
  `focusedCompleteReconstructionControlArm`, `captureIntrinsicShortSideObserver`,
  `onIntrinsicShortSideObserver*`, `onPreparedPieces`,
  `onCapacityCohesionShadowLane`, `onCapacityWarmPrefixLane`,
  `capacityControlArm`, and the `on*Metrics`/`onPortfolioPhase` benchmark
  hooks on `ComputeIrregularNestingOptions` (lines 122-182) are **never set
  by `nesting.worker.ts`** — `computeIrregularWorkerResult`
  (`nesting.worker.ts:340-401`) constructs `options` from exactly
  `emitStateSnapshot` / `emitPortfolioProgress` / `emitDecisionTrace` and
  nothing else (lines 348-374). All of the shadow/observer/benchmark options
  are test- and script-only surfaces (`scripts/irregular-*.ts`,
  `tests/unit/*`). Their existence must not be read as production behavior.

---

## 2. Entry points, callers, callees (traced, not guessed)

**Inbound (how a request reaches this cluster):**

1. `src/main/ipc/handlers.ts:587-597` and `:832-842` decode untrusted IPC
   payloads with `Schema.decodeUnknownExit(NestingRequestStrict)` (schema at
   `src/shared/schemas/nestingSchemas.ts:77+`), then
   `Schema.decodeUnknownSync(NestingRequest)` to build the trusted domain
   object. This is the "trusted request conversion after TypeScript schema
   validation" boundary the migration prompt names in section 4.1/7 — the
   future Rust native call receives the *already-decoded* `NestingRequest`
   shape, not raw JSON.
2. `WorkerSupervisor.runNesting` (`WorkerSupervisor.ts:99-176`) spawns a
   worker thread (`makeWorkerThread`, `:200-224`), builds an Effect RPC
   client over it (`RpcClient.make(NestingWorkerRpcs)`, `:164`), and issues
   exactly one `client.RunNesting({ requestId, request })` call (`:167`),
   streaming the response.
3. `nesting.worker.ts`'s `NestingWorkerRpcs.toLayer` handler
   (`:455-474`) is the sole registered RPC (`RunNesting`); it opens an
   unbounded `Queue<WorkerResponse>`, forks `handleRunNesting` into that
   queue, and returns the queue as the response stream.
4. `handleRunNesting` (`:190-338`) is the top-level coordinator for one job:
   it emits lifecycle progress, prepares history/decision-trace files,
   dispatches to `computeIrregularWorkerResult` (irregular) or
   `computeNesting` (rectangular, out of scope), and turns the result into
   `WorkerHistoryCompleteResponse` + `WorkerSuccessResponse`, or a
   `WorkerFailureResponse` on error.

**Direct callees of `computeIrregularWorkerResult`
(`nesting.worker.ts:340-401`), i.e., the Effect layers a Rust job would need
to reproduce the *effect* of:**

- `CollisionGeometryBuilder.Live` (`:391`)
- `TransformGeneratorLive` (`:392`)
- `NfpIfpServiceLive` (`:393`)
- `FreeMaterialServiceLive` (`:394`)
- `IrregularPlacementScorer.Layer` (`:395`) — **note:** this is `.Layer`, not
  `.Live`. `.Live = .Layer.pipe(Layer.provide(GeometrySettings.Live))`
  (`irregularPlacementScorer.ts:196`) would bind its own *default*
  `GeometrySettings`, ignoring the request's actual settings. Production
  code deliberately uses the bare `.Layer` so the placement scorer picks up
  the same request-derived `GeometrySettings` supplied at `:398`. A Rust
  port must thread the *request's* geometry/optimizer settings into every
  subsystem that reads them, not a hardcoded default — this specific
  `.Layer` vs `.Live` choice is the concrete evidence of that requirement.
- `IrregularLayoutScorer.Live` (`:396`)
- `GeometryKernel.Live` (`:397`)
- `Layer.succeed(GeometrySettings, geometrySettings)` (`:398`), where
  `geometrySettings = request.options.irregularSettings ?? GeometrySettings.Make`
  (`:375`), and `GeometrySettings.Make = DEFAULT_IRREGULAR_NESTING_SETTINGS`
  (`geometryKernel.ts:38`, built by `makeCompactQualityIrregularOptimizerSettings`,
  `defaults.ts:149-183`).

**Direct callees of `computeIrregularNesting` /
`coordinateIntrinsicSharedArchive` (the algorithm coordinator itself, all in
`computeIrregularNesting.ts`):**

- `sortPiecesForNesting` (`sortPiecesForNesting.ts`, imported `:30`, called
  `:380`) — produces prepared-piece order.
- `findSourcePiece` (local, `:1906-1920`) — resolves each prepared piece's
  imported source geometry, with a `-copy-\d+$` suffix-stripping fallback.
- `geometryBuilder.buildPiece`, `transformGenerator.generateTransforms`
  (`:401-414`) — geometry/transform preparation (owned by the
  "Geometry and caches" cluster).
- `IrregularNestingPortfolio` service, constructed in-place from
  `IrregularNestingPortfolioLive.pipe(Layer.provideMerge(PriorityOrderServiceLive))`
  (`:434-438`) — only actually invoked (`.run(...)`) inside
  `runSingleSheetPortfolio` (`:1438`), i.e., only on the non-archive (dead
  for this migration) path.
- `preflightIntrinsicCompleteCapacity` (`:527-531`), `runIntrinsicCapacityMode`
  (`:585-594`, `:960-978`), `runIntrinsicCapacitySchedulerColdQuantum`
  (`:606-614`, `:673-684`), `measureIntrinsicCapacityShadowTelemetry`
  (`:540-544`, benchmark-only) — Capacity cluster.
- `runIntrinsicSharedArchivePortfolio` (`:641-725`) — the actual
  direct/periodic Compact construction; `IrregularPortfolioError` mapped
  from its `IntrinsicStrictDecoderError`/`IntrinsicCapacityError` failures
  (`:727-737`).
- `retainRankedSharedArchive`, `selectIntrinsicSharedArchiveWinner`,
  `selectFittingSharedArchive`, `makeIntrinsicSharedArchiveEndpoint` — archive
  ranking/dedup/selection (Complete-Compact cluster).
- `runIntrinsicReconstructionPortfolio` (`:840-849`) — focused reconstruction.
- `observeIntrinsicPlaceDeferCompleteShadow` (`:778-782`) — observer-only,
  gated by a benchmark option never set in production.
- `observeIntrinsicShortSideOrientations` (`:1085-1090`),
  `observeIntrinsicShortSidePairFold` (`:1149-1165`),
  `withMeasuredIntrinsicShortSidePairFoldTrace` (`:1181-1184`) — Short Side
  cluster.
- `IrregularBeamState` (constructed directly, not called as a service) — used
  throughout as the plain-old-data state carrier for scoring/history.
- `input.layoutScorer.scoreState` (`IrregularLayoutScorer` service) — final
  score computation for whichever geometry was selected.
- `input.geometryKernel.transformCollisionGeometry` (via
  `reconstructPlacedGeometry`, `:1801-1857`) — used only on the legacy
  non-archive path (dead for this migration).

**Outbound (what leaves this cluster):**

- `WorkerResponse` union (`worker.ts:162-169`) sent over the RPC stream to
  `WorkerSupervisor`, which republishes as `NestingHistoryEvent`
  (`ipc.ts:42-47`, a strict subset: progress/history_frame/history_complete
  only — success/failure are consumed by the `runNesting` promise itself,
  `WorkerSupervisor.ts:226-284`) to IPC listeners, and resolves/rejects the
  `runNesting()` promise with a `NestingResult` or `SupervisorError`.
- NDJSON files under the durable history directory:
  `${jobId}.ndjson` (history frames, `nesting.worker.ts:85-101,103-110`) and
  `${jobId}.decision-trace.ndjson` (decision trace, `:112-140`) — both
  written directly to disk from inside the worker thread, independent of
  what is streamed back over RPC.

---

## 3. Data in/out: exact types/shapes, optional-field presence/omission semantics

### 3.1 Request (`NestingRequest`, `src/shared/domain/nesting.ts:143-152`)

Fields relevant to this cluster: `version` (literal `1`), `jobId` (branded
string, `JobId.withDefault` — auto-generated via `crypto.randomUUID()` if
omitted when *constructing* the class directly, but required when
*decoding* an IPC payload — see `src/shared/domain/ids.ts:26-48`), `sheet`
(`SheetSpec`), `padding`, `pieces: PreparedPiece[]`, `sourcePieces?:
ImportedPiece[]` (optional — `findSourcePiece` treats a missing/empty
`sourcePieces` as "no source found" for every piece, producing
`IrregularComputeError`, `:390-399`), `options: NestingOptions`,
`strategyRunId?: string` (optional — when present, overrides the derived
`${jobId}-${strategyId}` id in `irregularStrategyRunId`, `irregularWorkerOutput.ts:30-39`,
**and** switches `historyFileMode` from `'truncate'` to `'append'`,
`nesting.worker.ts:203`).

`NestingOptions` fields this cluster reads: `workerMode` (selects irregular
vs rectangular, `:240,348`), `historyMode` (`'stream'|'final'|'off'`, gates
history-frame/decision-trace file creation and streaming, see section 5/9),
`irregularSettings?: IrregularNestingSettings` (optional; defaults to
`GeometrySettings.Make` when absent, `:375`), `timeoutMs` (read by
`WorkerSupervisor`, not by this cluster's files directly). **`maxHistoryEvents?:
number`** (`nesting.ts:115`) is decoded and persisted but **never read
anywhere under `src/workers/` or `src/main/`** (verified by
`grep -rn "maxHistoryEvents" src/workers src/main`, zero hits). The
`NestingHistorySummary.truncated` field this cluster emits is **hardcoded
`false`** (`nesting.worker.ts:303`) regardless of frame count — there is no
history truncation logic in this cluster or anywhere on the irregular path.
A Rust port must not implement `maxHistoryEvents`-driven truncation; doing
so would be an observable behavior change.

### 3.2 `ComputeIrregularNestingOptions` (`computeIrregularNesting.ts:117-182`)

All fields optional. Production (`nesting.worker.ts:348-374`) sets at most
three: `emitStateSnapshot` (present iff `historyMode !== 'off'`),
`emitPortfolioProgress` (always present), `emitDecisionTrace` (present iff
`decisionTracePath !== null`, i.e., `historyMode !== 'off'` **and**
`workerMode === 'irregular-convex-v2'`). If none of the three apply, `options`
itself is `undefined` (`:349-352`), not an object with `undefined` members —
this distinction matters because `computeIrregularNesting`'s internal checks
are all `input.options?.field` (optional chaining), so the two shapes are
behaviorally identical to the algorithm, but a byte-for-byte replay of
constructor arguments would differ.

### 3.3 `IrregularComputeResult` (`computeIrregularNesting.ts:329-352`)

Required fields: `placedCollisionGeometries`, `score`, `unplacedPieceIds`,
`diagnostics`, `sortedPieceIds`, `stateSnapshots`, `beamWidth`, `portfolio`.
Optional fields, each present only under specific conditions, all assembled
via conditional object-spread at `:1221-1237` (`{} `vs `{ field }` pattern —
**omission, not `undefined`-valued keys**, matters for JSON serialization
downstream):

| field | present when |
|---|---|
| `capacityTrace` | a capacity-mode result materialized this run (`preflight.kind === 'proven_impossible'` branch, or archive-miss branch) |
| `capacityShadowTelemetry` | `options.captureCapacityShadowTelemetry === true` (never true in production) |
| `intrinsicAnytimeSchedulerTrace` | the scheduler cold-start ran (`schedulerEnabled` is a hardcoded `true` local at `:604`, so this is present on every archive-branch run that reaches the non-`proven_impossible` preflight outcome) |
| `experimentalPlaceDeferTrace` | `options.captureExperimentalPlaceDeferCompleteShadow === true` (never true in production) |
| `focusedCompleteReconstructionTrace` | `focusedCompleteReconstructionEnabled` (`options?.focusedCompleteReconstructionControlArm !== 'disable'`, i.e. true unless explicitly disabled — production never disables it) |
| `intrinsicShortSideObserverTrace` | the short-side observer block ran (section 1) |
| `intrinsicShortSidePairFoldTrace` | the pair-fold observer ran inside that block |

### 3.4 `NestingResult` / `NestingStrategyResult` (worker output,
`irregularWorkerOutput.ts:88-187`, schema at `nesting.ts:298-394`)

`makeIrregularWorkerOutput` always produces **exactly one**
`NestingStrategyResult` in `strategyResults` (`nesting.ts:174`) and always
sets `runSummary` with **exactly one** `NestingSubRun` (`irregularWorkerOutput.ts:149-169`).
`placements` at both the `NestingResult` and `NestingStrategyResult` level
are always the empty array (`irregularWorkerOutput.ts:142,177`) — irregular
placements live exclusively inside `layout.placements`
(`IrregularLayout`, a tagged union member of `NestingLayout`,
`nesting.ts:174-178`); this is enforced by the schema-level
`validateIrregularLayoutEnvelope` check (`nesting.ts:180-204`, attached at
`:218` and `:296` and `:352`) which *rejects* a decode where the legacy
`placements` array is non-empty alongside an irregular layout, or where the
envelope's `unplacedPieceIds` disagrees with `layout.unplacedPieceIds`.

`status` fields: `NestingStrategyResult.status` is one of
`'completed'|'partial'|'failed'|'cancelled'`
(`nesting.ts:249-254`), but `NestingStrategyResult.fromAlgorithm`
(`nesting.ts:301-333`) only ever assigns `'completed'` or `'partial'`
(`unplacedPieceIds.length === 0 ? 'completed' : 'partial'`, `:321`) —
`'failed'`/`'cancelled'` are declared in the schema's domain but
**unreachable from this cluster's success path**; a real failure never
reaches `NestingStrategyResult` construction at all (the coordinator's
`Effect` fails before `makeIrregularWorkerOutput` runs), and cancellation
kills the worker thread outright. Likewise `NestingResult.status` is one of
`'ok'|'partial'|'failed'` (`nesting.ts:155`) but `NestingResult.fromAlgorithm`
(`:357-393`) only ever assigns `'ok'` or `'partial'` (`:374`) — `'failed'`
is never produced by this cluster.

`strategyDescription` (optional string, `nesting.ts:286`) — for the archive
source (`portfolio.source === 'shared-archive'`), is one of two hardcoded
literal strings chosen by `shortSideProfileRequested(request)`
(`irregularWorkerOutput.ts:135-140`):

- Short Side requested: **`'Protected Compact construction followed by one
  bounded, exact, single-worker Short Side terminal selector with an
  explicit Compact fallback.'`** (`irregularWorkerOutput.ts:138`) — this is
  the **stale prose** the task calls out. Section 15 documents why it is
  false and what the source-of-truth behavior actually is.
- Otherwise: `'Deterministic sheet-independent direct and periodic
  constructors selected through one exact topology archive.'` (`:139`)

No test asserts this exact string (`grep -rn "strategyDescription" tests/`
shows only rectangular-path assertions in `tests/unit/algorithm.test.ts`),
so it is not a differential-parity byte constraint today, but it **is**
serialized into every persisted `NestingResult`/history artifact and would
need byte-identical reproduction (or an explicitly-excluded field) in any
strict differential test per migration-prompt section 18.3.

`score` (`IrregularLayoutScoreSummary`, `scoreSummary` at
`irregularWorkerOutput.ts:212-236`) is a strict subset of the internal
`IrregularLayoutScore` fields — notably **`occupiedHullWasteRatio` is
computed and set on the internal score object**
(`preserveSharedArchiveExactMetrics`, `computeIrregularNesting.ts:1786-1798`,
field set at `:1797`) but is **not** part of `IrregularLayoutScoreSummary`
(`src/shared/irregular/domain.ts:901-925`) and is dropped by both
`layoutScoreSummaryFields` (`computeIrregularNesting.ts:1709-1727`) and
`scoreSummary` (`irregularWorkerOutput.ts:212-236`). It is a real,
internally-consumed ranking field elsewhere in the codebase (used as a
comparator criterion in `irregularLayoutScorer.ts:522,535`) but never
crosses the worker-coordination output boundary. A Rust port's boundary DTO
for the final result must not include it unless the summary schema changes.

`canonicalEnclosedCavityCount` (optional on `IrregularLayoutScoreSummary`,
`domain.ts:919`) is present only when the archive/capacity path supplies it
(`layoutScoreSummary(score, endpoint.metrics.enclosedCavityCount)`,
`:1288`, or `preserveSharedArchiveExactMetrics`'s
`endpoint.metrics.enclosedCavityCount` via `layoutScoreSummary` call at
`:1554`); the Short-Side-profile materialization path
(`materializeIntrinsicShortSideProfileResult`) calls
`layoutScoreSummary(score)` with **no second argument** (`:1630`), so
`canonicalEnclosedCavityCount` is **omitted** (not merely absent-valued) on
the final Short Side result's `portfolio.score`, even though the same field
was present on the Compact winner earlier in the same run. This is an exact,
observable optional-field-presence divergence between the Compact and
Compact Short Side output shapes that a Rust boundary DTO must reproduce.

### 3.5 History frame (`IrregularHistoryFrame`, `irregularWorkerOutput.ts:42-82`,
schema `domain.ts:999-1034`)

`beamWidth` on every shared-archive-sourced frame (i.e., every frame Compact
or Compact Short Side ever produce) is **hardcoded to `1`**
(`sharedArchive ? 1 : input.beamWidth`, `irregularWorkerOutput.ts:78`) —
**not** `input.settings.optimizer.beamWidth` (which defaults to `8` for the
Compact preset, `defaults.ts:154`). `title` is one of
`'shared-archive-final-selected'` (last frame, zero remaining prepared
pieces) or `'shared-archive-selected-layout-reveal'` (every earlier frame)
for the archive source (`:64-70`), matching
`docs/operations/irregular-production-gates.md:158-161` exactly.
`strategyLabel` is chosen per-snapshot by
`sharedArchive && shortSideProfileRequested(request)` (`:51-56`) — a
request-level check, not a "was Short Side actually selected" check, but
since frames are only ever emitted for the final `selected` result (see
section 5), this is always consistent with what actually shipped.

---

## 4. Algorithm state and every mutation point

This cluster does not own the search's mutable state (that is
`IrregularBeamState`/portfolio-search territory, out of scope here). Within
these three files, the mutable state is limited to per-request coordinator
bookkeeping:

- `nesting.worker.ts:210-211`: `let frameCount = 0`, `let
  decisionTraceEventCount = 0` — incremented by closures inside
  `makeFrameEmitter` (`:171`, once per emitted history frame; no-op when
  `historyMode === 'off'`, `:166-168`) and `makeDecisionTraceEmitter`
  (`:151`, incremented by `events.length` per flushed batch; no-op when
  `decisionTracePath === null`, `:148`). These feed directly into
  `NestingHistorySummary.frameCount` / `.retainedFrameCount` /
  `.decisionTraceEventCount` (`:299-310`).
- `IrregularDecisionTraceBatcher` (`decisionTraceNdjson.ts:6-30`) has one
  mutable field, `pendingEvents: IrregularDecisionTraceEvent[]`, appended by
  `.add()` and flushed at `>= maximumEvents` (`256`, `DECISION_TRACE_BATCH_EVENT_LIMIT`,
  `:3`) or explicitly via `.flush()`. For Compact/Compact Short Side this is
  allocated (`nesting.worker.ts:231-238`) but `.add()` is **never called**
  (section 1), so it only ever flushes zero pending events at end-of-job
  (`:275`, a no-op since `pendingEvents.length === 0` short-circuits,
  `decisionTraceNdjson.ts:25`).
- `coordinateIntrinsicSharedArchive` (`computeIrregularNesting.ts:474-1240`)
  uses a large set of `let` locals reassigned exactly once each along one of
  several mutually-exclusive branches: `selected: MaterializedDecode`
  (assigned at exactly one of `:595`, `:1008`, `:1039`, `:1066`, then
  possibly reassigned once more at `:1175` if Short Side is selected — this
  is the **only** variable in this cluster that can be assigned twice in one
  run), `capacityShadowTelemetry`, `intrinsicAnytimeSchedulerTrace` (mutated
  by repeated object-spread reassignment as scheduler quanta accumulate —
  `:618-637`, `:652-665`, `:686-703`, `:763-776`, `:785-799`, `:979-1007`,
  `:1017-1038` — each reassignment appends to `.quanta` via spread, never
  mutates the array in place), `experimentalPlaceDeferTrace`,
  `focusedCompleteReconstructionTrace` (reassigned up to twice: once when
  the reconstruction outcome is known, `:816-931`, and again after the
  winner is chosen to set `outputInfluence`/`selectedCanonicalGeometryHash`,
  `:942-958`), `settledCompleteArchiveForShortSideObserver`,
  `intrinsicShortSideObserverTrace`, `intrinsicShortSidePairFoldTrace`,
  `shortSideSelected: boolean` (starts `false`, `:1123`, set `true` only at
  `:1191` after a successful Short Side materialization — read at the
  fail-fast check `:1194`).
- `scheduledColdStart` / `scheduledColdCheckpointReused` (`:605-616`,
  reassigned at `:673-685`) — cold-quantum checkpoint resumption
  bookkeeping, mutated exactly once if a checkpoint-triggered resume occurs
  inside the `onCanonicalGridCheckpointed` callback (`:650-704`).
- `prefixSources: IntrinsicCapacityPrefixSource[]` (`:639`), appended to by
  the `onDirectConstructed` callback (`:707-709`) each time the archive
  runner constructs a direct role — an accumulator, order = call order of
  the callback (see section 5).
- `archiveDiagnostics: CollisionGeometryDiagnostic[]` (`:488`), appended to
  (never reordered) at eight call sites across the function; final order is
  push order, which is fixed by the mutually-exclusive branch structure
  (i.e., deterministic per branch taken, not a merge of multiple branches).

None of this cluster's mutable state is shared across requests or threads —
every `let`/array is a local of one `Effect.gen` invocation for one job.

---

## 5. Ordering sources: sorts, Map/Set, iteration order reaching output

- **The** ordering source that reaches output identity: `sortPiecesForNesting`
  (`sortPiecesForNesting.ts:13-17`) calls `pieces.toSorted(order)`.
  `Array.prototype.toSorted` is specified as a stable sort (ES2023, same
  guarantee as `Array.prototype.sort` in current V8/Node). `order` is
  `Order.combineAll([longestEdge desc, area desc, imbalance desc])`
  (`:6-11`) — see section 6 for the exact comparator. This order becomes
  `preparedPieces` (`computeIrregularNesting.ts:389`, iterated with a plain
  `for...of` — insertion order preserved) and `sortedPieceIds`
  (`:444`, `sortedPieces.map(piece => piece.id)`), which is emitted verbatim
  into `IrregularComputeResult.sortedPieceIds` and thence
  `NestingStrategyResult.sortedPieceIds` / `NestingResult.sortedPieceIds`.
  **Ties are broken by original array order** (stability), which in turn is
  whatever order `request.pieces` arrived in over the wire — this is a
  cross-language hazard (section 12).
- `Effect.forEach(portfolio.placements, ..., { concurrency: 1 })`
  (`reconstructPlacedGeometry`, `:1809-1856`) is an explicit sequential
  map that preserves `portfolio.placements` order into the returned
  `placedCollisionGeometries` array — only exercised on the legacy
  non-archive path (dead for this migration, section 1), but the pattern
  ("stable index-preserving sequential map over one already-ordered
  input") is exactly the shape the migration prompt wants for any future
  Rayon-parallelized version of the analogous archive-path reconstruction.
- `resolvePortfolioPlacementTransform` (`:1868-1892`): builds
  `sameMirrorTransforms` via `.filter(...).toSorted((a,b) => a.index -
  b.index)` (stable, ascending by `index`), then `.find(...)` for an exact
  rotation match; if none, `.find(...)` again for the first (lowest-index)
  quarter-turn-equivalent candidate. **First-match-in-index-order wins** —
  see section 6 for the epsilon comparison.
- `findSourcePiece` (`:1906-1920`): `sourcePieces.find(...)` — first match
  in `sourcePieces` array order (the order `request.sourcePieces` arrived
  in), tried first by exact id, then by id with `-copy-\d+$` suffix
  stripped from both sides.
- `reconstructPlacedGeometry`'s inner lookup
  (`pieces.find(piece => ...)`, `:1817-1821`) — first match in
  `preparedPieces` order (i.e., the stable-sorted order above).
- `focusedRun = reconstruction.runs.find(({role}) => role ===
  'endpoint-q90-right-to-left')` (`:882-884`) — first match by role string
  in whatever order the reconstruction portfolio returned `.runs`
  (owned by `intrinsicReconstructionPortfolio.ts`, out of scope, but the
  consumption here is order-dependent on that array).
- `focusedReconstructionEndpoints.some(...)` (`:950-954`) to determine
  `outputInfluence: 'selected' | 'protected-fallback'` — membership test
  by exact hash equality, order-independent (correct either way since it's
  `.some`, not first-match-sensitive for behavior, only for which endpoint
  object is referenced — there is at most one).
- **Map usage** (`computeIrregularNesting.ts:1664`,
  `selectedLayoutRevealSnapshots`): `new Map(preparedPieces.map(p => [p.pieceId
  ?? p.source.id, p]))`, used only via `.get()` for lookup inside a
  `.flatMap`. Not iterated — insertion order is irrelevant to output.
- **Set usage** (`:1141`, `:1590`): both `new Set(...)` instances are used
  only via `.has()` for membership filtering, never iterated — insertion
  order is irrelevant to output. **No Map or Set in this cluster is ever
  iterated to produce output order** — the one real ordering hazard is the
  stable sort in `sortPiecesForNesting`, plus the several `.find()`
  first-match patterns above.
- **Progress/history emission order** (worker-visible, protocol-contractual
  per migration-prompt section 15): see section 9/10 for the exact event
  sequence; it is fixed by the linear structure of `handleRunNesting` and
  `coordinateIntrinsicSharedArchive`'s mutually-exclusive branches, not by
  any concurrent/racing source. `Queue.offerUnsafe` on `frameQueue` /
  `decisionTraceQueue` (`nesting.worker.ts:246`, `:236`) preserves FIFO
  order into the `Stream.fromQueue(...).pipe(Stream.runForEach(...))`
  consumers (`:220-223`, `:227-230`) — Effect's `Queue` is an ordered
  channel, not a JS `Map`/`Set`, so this is not itself a hazard, but a Rust
  port's equivalent channel must also be strictly FIFO.

---

## 6. Comparators and tie rules: exact comparison chains, signs, tie-breakers

- **Prepared-piece priority order** (`sortPiecesForNesting.ts:6-11`):
  ```
  Order.combineAll([
    Order.mapInput(Order.flip(Order.Number), p => p.paddedBounds.longestEdge),
    Order.mapInput(Order.flip(Order.Number), p => p.paddedBounds.area),
    Order.mapInput(Order.flip(Order.Number), p => p.paddedBounds.imbalance)
  ])
  ```
  Semantics: descending `longestEdge`, then descending `area`, then
  descending `imbalance`; `Order.combineAll` short-circuits at the first
  non-zero comparison (standard lexicographic composition). Any remaining
  tie is broken by `toSorted`'s stability — i.e., by original `pieces` array
  index. `Order.Number` is plain `Number` comparison (`a < b ? -1 : a > b ?
  1 : 0`, effectively IEEE-754 total order for finite non-NaN inputs — see
  section 7 for NaN handling, which is not checked here).
- **Terminal transform resolution**
  (`resolvePortfolioPlacementTransform`, `:1868-1892`): within the subset of
  `transforms` whose `mirrored` flag exactly matches the placement's
  `mirrored`, sorted ascending by `index` (numeric, `first.index -
  second.index`, ascending — the *opposite* direction from the priority
  order above): (1) prefer an exact `rotationDeg` match (`===`, exact float
  equality, no tolerance); (2) else take the **first** (lowest-index)
  candidate whose rotation is quarter-turn-equivalent via
  `isQuarterTurnEquivalent` (`:1894-1899`):
  `normalizedDifference = normalizeRotationDegrees(second - first)` where
  `normalizeRotationDegrees` (`:1901-1904`) is `((deg % 360) + 360) % 360`
  reimplemented by hand (`remainder < 0 ? remainder + 360 : remainder`,
  **not** using `%` twice — a single `%` then a conditional add, which
  matters for the sign of `-0` inputs, see section 7), and the candidate
  qualifies if `Math.abs(normalizedDifference - quarterTurnDeg) <= 1e-9` for
  any `quarterTurnDeg` in `[0, 90, 180, 270]` (`:1896-1898`). This `1e-9`
  degree tolerance is a pre-existing epsilon in the TS baseline (not a new
  one introduced by porting) — it must be reproduced exactly, including the
  fact that it composes with `normalizeRotationDegrees`'s own float
  arithmetic (a single `%` and a conditional branch, not `Math.abs`-based).
- **Error switch exhaustiveness** (`toIrregularWorkerFailure`,
  `nesting.worker.ts:403-453`): a `switch` on `error._tag` with **no
  `default` case** — TypeScript's exhaustiveness checking guarantees every
  member of `IrregularComputeErrorType` (`computeIrregularNesting.ts:354-362`)
  is handled; a Rust `match` over the equivalent enum must likewise be
  total (no silent fallthrough), and adding a new TS-side error tag without
  adding a match arm here is a compile error today — the Rust port should
  preserve that exhaustiveness guarantee at the type level.

No numeric ranking/scoring comparator (candidate scoring, archive ranking,
capacity comparator) lives in this cluster's three files — those are owned
by `irregularLayoutScorer.ts`, `intrinsicSharedArchivePortfolio.ts`,
`intrinsicCapacitySearch.ts`, etc., and must be characterized by their own
clusters. This cluster only *consumes* their already-decided winners.

---

## 7. Numeric semantics

- **Elapsed-time computation**, two distinct clock sources, both clamped:
  - `Date.now()` (wall clock, can jump backward under NTP adjustment):
    `elapsedMs: Math.max(0, Date.now() - startedAtMs)`
    (`nesting.worker.ts:386`), `startedAtMs = Date.now()` (`:347`).
    `startedAt`/`endedAt` timestamps use `new Date().toISOString()`
    (`:346`, `:379`).
  - `performance.now()` (monotonic, imported from `node:perf_hooks`,
    `computeIrregularNesting.ts:2`): every internal phase-runtime
    measurement in the coordinator uses this and is wrapped in
    `Math.max(0, performance.now() - startedAt)` — e.g. `preflightRuntimeMs`
    (`:532`), `completeArchiveRuntimeMs` (`:967`), `emitSharedArchiveProgress`'s
    `elapsedMs` (`:1454`, `Math.max(0, elapsedMs)` again at the call site).
    The `Math.max(0, ...)` clamp exists defensively even though
    `performance.now()` is monotonic within a process — it is cheap
    insurance, not evidence of an actual observed negative value. **All of
    these values are diagnostic/telemetry only** — they do not feed
    canonical geometry, keys, or hashes; they are not gated by any existing
    test's exact-value assertion (only generous ceilings, e.g.
    `--maximum-elapsed-ms 330000` in `gate:mixed61-compact`,
    `package.json:32`). A Rust port may use its own clock for these without
    breaking parity, consistent with migration-prompt section 8.1's
    guidance to reproduce numeric semantics only where they are
    observable/contractual.
- **Rotation normalization epsilon**: see section 6 (`1e-9` degrees,
  `resolvePortfolioPlacementTransform`/`isQuarterTurnEquivalent`,
  `:1894-1899`). This is the only floating-point tolerance in this
  cluster's own code (as opposed to callees).
- **No BigInt, no canonical-grid integer arithmetic, no cross-products, no
  Clipper2 calls occur in these three files.** All exact-integer/canonical-grid
  numeric authority lives downstream (geometry/canonical-key clusters); this
  cluster only forwards already-computed hashes/areas/counts as opaque
  strings/numbers (e.g. `endpoint.canonicalGeometryHash`,
  `endpoint.metrics.enclosedCavityCount`) without arithmetic on them.
- `Math.floor(endpoint.metrics.contactUnits)` (`:1794`,
  `preserveSharedArchiveExactMetrics`, computing
  `sharedCollisionBoundaryContactBand`) — the one non-trivial arithmetic
  operation on a scored value in this cluster. `Math.floor` on a
  non-negative finite float truncates toward `-Infinity` (== toward zero for
  non-negative inputs); Rust's `f64::floor()` has identical IEEE-754
  semantics, so this is a safe direct port, but note it is the **only**
  place in this cluster where a *displayed/summary* numeric field is
  derived by computation rather than passed through verbatim — worth an
  explicit unit test in Rust.
- **Piece-count-derived defaults / caps referenced but not computed here**:
  `INTRINSIC_ANYTIME_SCHEDULER_COLD_QUANTUM_DEPTHS = 4`
  (`intrinsicCapacityMode.ts:383`, consumed at
  `computeIrregularNesting.ts:620`) and the archive-run constants
  `maximumDirectRuntimeMs: 35_000` (`:645`), periodic
  `maximumCatalogRuntimeMs/maximumContinuationRuntimeMs: 30_000`,
  `maximumTotalRuntimeMs: 240_000`, `maximumCellsPerFamilyRole: 16`,
  `maximumCropsPerCell: 4` (`:718-723`), reconstruction
  `maximumRuntimeMsPerDecode/maximumTotalRuntimeMs: 15_000`,
  `maximumCandidateEvaluationsPerDecode/maximumTotalCandidateEvaluations:
  12_000` (`:844-847`), and cold-resume `maximumDepthBoundaries: 1`
  (`:678`). These are **budgets passed to callees**, not computed values —
  but the `12_000` figure is the exact number the migration prompt cites in
  its Mixed-61 gate summary ("focused evaluations `12000`", prompt section
  18.6), confirming the prompt's number against source at this call site.
  `canonicalGridCompletedPieceQuantum: 1` (`:649`) is likewise a pass-through
  literal.

---

## 8. Serialization and hashing

- **Decision-trace NDJSON** (`decisionTraceNdjson.ts:33-37`,
  `serializeIrregularDecisionTraceBatch`): each event is
  `JSON.stringify(event)`, joined with `'\n'`, with a **trailing** `'\n'`
  after the whole batch (`` `${events.map(...).join('\n')}\n` ``). Object
  key order in the emitted JSON follows each `IrregularDecisionTraceEvent`
  class's own field declaration/insertion order (JS engines preserve
  string-key insertion order for `JSON.stringify` on plain/class instances)
  — this is owned by `decisionTrace.ts`, out of scope for deep
  characterization here, but the **wrapping** format (newline join, trailing
  newline, one JSON object per line, batched in groups of up to
  `DECISION_TRACE_BATCH_EVENT_LIMIT = 256`) is this cluster's contract and
  must be reproduced exactly if a Rust job re-emits this stream — though per
  section 1, this stream is empty for Compact/Compact Short Side today, so
  there is nothing to differentially test today beyond "the file exists and
  is empty."
- **History-frame NDJSON** (`nesting.worker.ts:103-110`, `appendFrame`):
  `` `${JSON.stringify(frame)}\n` ``, one `IrregularHistoryFrame` (or
  legacy `NestingHistoryFrame`) per line, appended (`flag: 'a'`) — same
  shape contract as above, one object per call (not batched).
- **No canonical-key construction, no SHA-256 hashing, and no
  custom canonical encoder exists in these three files.** Every hash this
  cluster handles (`canonicalGeometryHash`, `sheetlessCanonicalGeometryHash`,
  `sourceCanonicalGeometryHash`, etc.) is an **opaque string produced
  upstream** and only ever read, compared by `===`/`.find`, or embedded
  verbatim into diagnostic message strings (e.g.
  `` `hash ${endpoint.canonicalGeometryHash}` ``, `:1297`, `:1371`) or trace
  fields. This cluster performs zero hashing itself.
- **Diagnostic message strings** (`CollisionGeometryDiagnostic.message`,
  many call sites, e.g. `:1290-1299`, `:1332-1343`, `:1360-1373`) are built
  with template literals and `.join('; ')` / `.join(',')` over arrays —
  human-readable, not contractual JSON, but their exact text is part of
  `IrregularComputeResult.diagnostics` → `NestingResult.layout.diagnostics`,
  which is schema-typed as `Schema.String` (`domain.ts:501-505`) and thus
  part of the serialized result. No test asserts these strings verbatim
  (spot-checked; not exhaustively re-verified for every diagnostic in this
  pass), but they are observable output and should be reproduced exactly
  for strict differential parity, or explicitly excluded as
  non-authoritative free text.
- `Schema.decodeUnknownExit` / `Schema.encodeUnknownExit` /
  `Schema.decodeUnknownSync` (Effect Schema, used at the IPC and RPC
  boundaries, `handlers.ts:587-597,832-842`, tested in
  `tests/unit/workerProtocol.test.ts`) are the wire (de)serialization layer
  for `WorkerRequest`/`WorkerResponse`/`RunNestingPayload`. This is
  Effect's own JSON-oriented schema codec, not a hand-rolled canonical
  encoder — ordinary JSON semantics apply (no BigInt fields anywhere in this
  cluster's schemas; `undefined`-valued optional keys are omitted by
  Effect's decode/encode conventions, consistent with every `?? {}`/spread
  pattern observed in the TS source).

---

## 9. Caches touched and the exact historical access sequence

**This cluster touches no geometry/NFP/IFP cache directly.** All caching
(NFP cache, geometry cache, transform cache) lives in
`src/workers/irregular/` service implementations this cluster merely wires
as Effect layers (`nesting.worker.ts:391-398`) — see the "Geometry and
caches" cluster for the actual access-sequence characterization
(`nfpIfpService.ts`, `geometryCacheStore.ts`, etc., per migration-prompt
section 5).

The closest thing to a "cache" owned by this cluster is the **capacity
prefix-source accumulator** (`prefixSources`, `computeIrregularNesting.ts:639`,
appended by `onDirectConstructed` at `:707-709`) — this is not a lookup
cache, it is an ordered list of already-computed direct roles collected for
later reuse by `runIntrinsicCapacityMode` (`:960-978`), consumed in append
order. Its ordering is deterministic (append order = the order the archive
runner calls `onDirectConstructed`, itself deterministic per the archive
cluster's own chronology), and it is entirely job-local (a fresh `[]` per
`coordinateIntrinsicSharedArchive` invocation, never persisted or shared
across jobs).

---

## 10. Cancellation / deadline / budget / evaluation-cap observation points

**This is the most important finding in this cluster.** Production
cancellation and timeout do **not** flow through this cluster's cooperative
checkpoint mechanism at all:

- `ComputeIrregularNestingOptions.isCancelled?: () => boolean`
  (`computeIrregularNesting.ts:121`) is read at exactly one place inside the
  coordinator: building a `control` object
  (`:512-525`) passed to `preflightIntrinsicCompleteCapacity`,
  `runIntrinsicCapacityMode`, `runIntrinsicSharedArchivePortfolio`,
  `runIntrinsicReconstructionPortfolio`, and
  `observeIntrinsicPlaceDeferCompleteShadow`. When `input.options?.isCancelled
  === undefined`, `control` itself is `undefined` (`:513-514`), and every
  downstream `...(control === undefined ? {} : { control })` spread
  (`:593`, `:706`, `:781`, `:848`, `:977`) simply omits the `control` field —
  the callees' own default (uncontrolled) behavior applies.
- `grep -rn "isCancelled" src/workers/nesting.worker.ts` returns **zero
  matches**. `computeIrregularWorkerResult` (`nesting.worker.ts:340-401`)
  never constructs or passes an `isCancelled` function to
  `computeIrregularNesting`. **Therefore `control` is always `undefined` in
  production**, and the entire internal `IrregularNfpIfpControlAbortError`
  / checkpoint-phase mechanism (`services.ts:69-89`, explicitly commented
  `"internal NFP-only abort signal; this is not the worker supervisor
  contract"`, `services.ts:69`) is **inert dead code from the worker's
  perspective** for both Compact and Compact Short Side. It exists and is
  exercised only by test harnesses and gate scripts
  (`tests/unit/*`, `scripts/irregular-*-gate.ts`) that construct
  `ComputeIrregularNestingOptions` directly and pass their own
  `isCancelled`.
- **Actual production cancellation and timeout** are implemented entirely
  in `WorkerSupervisor` (outside this cluster's three files, but essential
  context): `cancelJob` (`WorkerSupervisor.ts:178-191`) and the `setTimeout`
  handler (`:126-149`) both call `teardownWorker` (`:193-198`), which just
  `dispose()`s the `ManagedRuntime` wrapping the RPC client — this tears
  down the Node `worker_thread` (via `NodeWorker.layer`'s disposal),
  terminating the entire process running `nesting.worker.ts`, mid-computation,
  with no cooperative signal sent into the algorithm first. This is a
  **whole-process kill**, not a graceful in-band cancellation. The renderer
  never learns any partial result (`current.reject(new
  SupervisorError('worker_cancelled', ...))`, `:187-189`, or
  `'worker_timeout'`, `:141-147`) — consistent with the migration prompt's
  "no partial result" rule, but the *mechanism* is OS-level thread
  termination, not algorithm-level checkpoint interruption.
- Implication for the Rust port: an N-API job's cancellation contract must
  match **this actual production mechanism** — an externally triggered hard
  abort of the whole native job — not a cooperative checkpoint loop, unless
  the orchestrator deliberately decides to *introduce* a real
  `isCancelled` wiring from `nesting.worker.ts` as a documented, tested,
  behavior-preserving addition (which would be a new capability, not a
  port of existing behavior, and must not be conflated with "semantics
  preservation"). See section 15, open question.
- **Deadline** (`IrregularNfpIfpControlAbortError` reason `'deadline'`):
  same inert-in-production status as `'cancelled'` — no code path in this
  cluster ever constructs a deadline-triggering `control`. The wall-clock
  deadline that *does* apply in production is `WorkerSupervisor`'s
  `timeoutMs` (default `60_000`, raised to a floor of `390_000` for
  irregular jobs via `workerTimeoutForMode`,
  `src/shared/irregular/defaults.ts:19-26`, applied in the renderer before
  the request is sent — `src/renderer/utils/workerTimeoutEdit.ts:10`), which
  is the same whole-thread-kill mechanism as cancellation, not a
  cooperative deadline check.
- **Evaluation caps observed in this cluster** are simple pass-through
  budget parameters handed to callees (section 7's constants list) — this
  cluster does not itself loop or decrement any evaluation counter; all cap
  *enforcement* happens in callees.
- `Effect.matchEffect` around `runIntrinsicReconstructionPortfolio`
  (`:839-865`) is the one place in this cluster that explicitly
  distinguishes a cancellation failure from an ordinary failure: `onFailure:
  (error) => error._tag === 'IrregularNfpIfpControlAbortError' && error.reason
  === 'cancelled' ? Effect.fail(error) : Effect.succeed({kind: 'failed', error})`
  (`:851-858`) — i.e., a genuine cancellation is **re-thrown** (propagates up
  and fails the whole coordinator), while every *other* reconstruction
  failure (including a `'deadline'`-reason abort!) is **caught and
  downgraded** to a `focusedCompleteReconstructionTrace.status:
  'failed-protected-fallback'` (`:867-879`), letting the Compact archive
  winner stand as the result. Since `control` is always `undefined` in
  production (per above), neither branch of this distinction is ever
  actually exercised in production today — but the distinction itself
  (cancelled = fatal, everything else = degrade-and-continue) is exact
  source-level behavior that must be preserved if/when `isCancelled` is
  ever wired up.

---

## 11. Error paths: tagged error classes, categories, context fields, propagation

`IrregularComputeErrorType` (`computeIrregularNesting.ts:354-362`) is a
closed union of 8 tags: `IrregularComputeError`,
`IrregularGeometryInputError`, `IrregularNfpIfpControlAbortError`,
`IrregularNoValidResultError`, `IrregularNestingNotImplementedError`,
`IrregularPortfolioError`, `IrregularPlacementScoringError`,
`IrregularLayoutScoringError`. Every tag is handled exhaustively (no `default`) by `toIrregularWorkerFailure`
(`nesting.worker.ts:403-453`), which maps each to a
`WorkerResponseFailureError { code, message, context }`
(`worker.ts:51-57`) exactly as follows — **this table matches the migration
prompt's section 16 table exactly, verified against current source**:

| TS tag | external `AppErrorCode` | context fields |
|---|---|---|
| `IrregularComputeError` | `irregular_source_geometry_missing` | `preparedPieceId`, `sourcePieceId` (`:406-413`) |
| `IrregularGeometryInputError` | `irregular_geometry_invalid` | `operation` (`:414-419`) |
| `IrregularNestingNotImplementedError` | `not_implemented` | `service`, `operation` (`:420-425`) |
| `IrregularPlacementScoringError` | `irregular_scoring_error` | `operation` (`:426-432`) |
| `IrregularLayoutScoringError` | `irregular_scoring_error` | `operation` (`:426-432`, same arm) |
| `IrregularPortfolioError`, category `'geometry'` | `irregular_geometry_invalid` | `operation`, `category` (`:433-439`) |
| `IrregularPortfolioError`, category `'scoring'` or `'search'` | `irregular_scoring_error` | `operation`, `category` (`:433-439`, same arm — confirms the prompt's "unusual mapping" for `'search'` is real source behavior, not a documentation error) |
| `IrregularNoValidResultError` | `irregular_no_valid_result` | `operation` (`:440-445`) |
| `IrregularNfpIfpControlAbortError`, reason `'cancelled'` | `worker_cancelled` | `reason: 'cancelled'` (`:446-451`) |
| `IrregularNfpIfpControlAbortError`, reason `'deadline'` | `worker_timeout` | `reason: 'deadline'` (`:446-451`, ternary on `error.reason === 'cancelled'`) |

`unknown_error` is produced **only** by the outer `Effect.catchCause`
wrapping the entire `handleRunNesting` gen block (`nesting.worker.ts:327-336`),
via `WorkerFailureResponse.unknown({ requestId, jobId, message:
Cause.pretty(cause) })` (`:329-335`, helper at `worker.ts:146-159`) — this
fires for Effect *defects* (uncaught exceptions, unexpected fiber
interruption causes), not for any of the 8 typed tags above, which are
already fully converted to `WorkerResponseFailureError` before this catch
would ever see them. `WorkerResponseFailureError.code` is typed as
`Schema.Literals([...AppErrorCode])` (`worker.ts:54`), so an invalid code
string cannot even construct — the mapping table above is closed and total
by construction on the TS side.

`IrregularGeometryInfeasibleError` (`services.ts:47-52`) exists in the
broader codebase but is **not** a member of `IrregularComputeErrorType` —
it is caught/remapped inside `portfolioSearch.ts:1092` before it could ever
reach this cluster's error union; not directly relevant to this cluster's
boundary but noted so a future reader does not assume it is missing from
the table above by omission error.

Propagation shape: `computeIrregularWorkerResult` pipes
`computeIrregularNesting(...).pipe(..., Effect.mapError(toIrregularWorkerFailure))`
(`:377-399`) so the returned `Effect<NestingResult,
WorkerResponseFailureError>` already carries the externally-stable error by
the time `handleRunNesting` sees it. `handleRunNesting` converts that into
`{type: 'failure', error}` via `Effect.match` (`:270-273`) and sends a
`WorkerFailureResponse` (`:284-292`) with **no further transformation** —
`error.code`/`.message`/`.context` are forwarded verbatim.

---

## 12. JS-specific semantics hazards for a Rust port

- **Stable sort reliance**: `sortPiecesForNesting`'s `Array.prototype.toSorted`
  (section 5/6) — Rust's `slice::sort_by`/`sort_by_key` are stable by
  default (`Vec::sort` family), so this is a safe direct match *if* the
  comparator is reproduced with identical descending-then-descending
  tie-break order and identical tie-break-by-original-index fallback. A
  Rust port must not use an unstable sort here.
- **`Array.prototype.find`/`.some` first-match-in-array-order semantics**
  (section 5): straightforward to reproduce with `Iterator::find`
  (also first-match, short-circuiting, order-preserving over a `Vec`/slice)
  — no hazard *if* the underlying collection order is preserved (see next
  point).
- **JS object/array key order is not the hazard here** — this cluster
  contains zero `for...in`/`Object.keys` iteration and zero Map/Set
  iteration reaching output (section 5 confirmed this explicitly). The
  hazard is entirely in *which ordered collection* (`Vec`/slice) feeds each
  `.find`, and that any Rust re-implementation of `sortPiecesForNesting`'s
  input array must come from the *same* upstream order as
  `request.pieces` — i.e., array order arriving over the (schema-validated)
  request, which is itself whatever order the caller (renderer/CSV import)
  produced. This is an external-input-order dependency, not a JS-runtime
  quirk, but it means a differential test must fix `request.pieces` order
  identically across TS and Rust runs (trivially satisfiable since both
  read the same serialized request).
- **String equality/regex**: `findSourcePiece`'s `-copy-\d+$` suffix strip
  (`:1916-1917`) uses a JS regex (`.replace(/-copy-\d+$/, '')`) and `===`
  equality on branded strings. Piece IDs are either UUIDs (`crypto.randomUUID()`,
  `ids.ts:26-32`) or renderer/CSV-supplied strings; nothing here depends on
  UTF-16 code-unit ordering (`===` is used, not `<`/`>` or `localeCompare`),
  so Rust `String::ends_with`/regex + `==` on UTF-8 strings is a safe direct
  port *as long as* the accepted alphabet for piece IDs never requires
  UTF-16-vs-UTF-8 surrogate-pair-sensitive matching — worth a quick
  confirmation from whichever cluster owns ID generation, but nothing in
  this cluster's own logic depends on code-unit vs. code-point distinctions.
- **`Date.now()` vs `performance.now()`** (section 7): a Rust port using
  `std::time::Instant` (monotonic) for internal phase timings and any
  wall-clock source for `startedAt`/`endedAt` ISO timestamps is fine, since
  none of these are gated by exact-value tests — but the port must still
  decide a canonical *format* for `startedAt`/`endedAt` if those fields
  remain part of a differential-comparable `AlgorithmBenchmark` (they are
  schema-typed as `Schema.String`, `nesting.ts:270-274`, so any ISO-8601
  string round-trips through the schema, but exact byte format
  (millisecond precision, `Z` suffix) should match `Date.prototype.toISOString()`'s
  format if any consumer parses it strictly — not verified here, out of
  this cluster's direct scope but worth flagging).
- **Effect's typed error channel vs. Rust's `Result`/enum**: the
  exhaustiveness guarantee in `toIrregularWorkerFailure`'s `switch`
  (section 6) is a TypeScript compiler guarantee, not a runtime one; a Rust
  `match` on an equivalent closed enum gets the same guarantee for free via
  `#[non_exhaustive]`-free enums and compiler exhaustiveness checking — this
  is actually an easier invariant to enforce in Rust than to lose track of.
- **Nullish coalescing (`??`) vs. falsy fallback**: every `pieceId ??
  sourcePieceId` / `x ?? default` pattern in this cluster (pervasive —
  e.g. `placement.pieceId ?? placement.sourcePieceId` throughout) triggers
  only on `null`/`undefined`, never on empty string, `0`, or `false`. A
  naive Rust port using `Option::unwrap_or` on an already-`Option<String>`
  is a direct match; the hazard is only if a Rust field is modeled as a
  non-`Option` `String` with `""` as a sentinel, which would silently
  diverge from `??`'s semantics if any piece ID could legitimately be
  empty (unlikely given `Schema.NonEmptyString`/branded-string
  construction elsewhere, but not verified in this cluster).
- **Effect `Queue`/`Stream` FIFO ordering** (section 5): this is Effect's
  own concurrency primitive, not a raw JS `Map`/`Set` — it is explicitly
  ordered by design and not itself a hazard, but a Rust N-API equivalent
  (e.g., an `mpsc` channel or an ordered callback aggregation point) must
  preserve the same "one progress/history event per logical step, delivered
  in emission order" contract per migration-prompt section 15.

---

## 13. Parallelism assessment

This cluster's own code is **overwhelmingly sequential orchestration
logic** with very little pure, independent, parallelizable work of its own
— nearly everything embarrassingly parallel in the wider Compact pipeline
(NFP computation, transform generation, candidate scoring) is owned by
callee clusters. Within these three files specifically:

**Safe/pure candidates found in this cluster:**

- `for (const prepared of sortedPieces) { ... }` piece-preparation loop
  (`computeIrregularNesting.ts:389-431`) builds `preparedPieces` and
  `diagnostics` by iterating the already-stably-sorted piece list, calling
  `geometryBuilder.buildPiece` and `transformGenerator.generateTransforms`
  per piece. Each iteration's *inputs* are fully independent (piece `i`'s
  geometry prep does not depend on piece `j`'s), matching the migration
  prompt's "independent collision-geometry preparation by stable piece
  index" (section 14.1) candidate almost exactly. **However**, both
  `diagnostics.push(...)` (`:430`) and the array-append to `preparedPieces`
  (`:415`) must be reassembled in the *original stable-sorted order*
  afterward if this loop is parallelized — a naive `push` inside a
  parallel iterator would reorder `preparedPieces` (and hence
  `sortedPieceIds`-adjacent identity and every downstream index-based
  lookup) nondeterministically. Any Rust parallelization here must collect
  into stable per-index slots and reassemble serially, exactly as
  migration-prompt section 14.3 prescribes. Also note: `geometryBuilder`
  and `transformGenerator` are Effect *services* that may hold internal
  caches (owned by the Geometry cluster) — parallelizing this loop requires
  those caches to be verified safe for concurrent access first (migration
  prompt section 13), which is out of this cluster's scope to certify.
- `reconstructPlacedGeometry`'s `Effect.forEach(..., {concurrency: 1})`
  (`:1809-1856`) is explicitly serial today and only exercised on the dead
  (for this migration) legacy path — no action needed for Compact/Short
  Side, but if the analogous archive-path reconstruction is ever
  parallelized, the same "stable index, serial reduction" pattern applies.

**Must stay logically serial (chronology-bound), found in this cluster:**

- The entire `coordinateIntrinsicSharedArchive` control flow
  (preflight → scheduler cold-start → archive run → capacity fallback →
  focused reconstruction → Short Side observer/pair-fold) is a strict
  sequential dependency chain: each stage's *input* is the *previous
  stage's decided output* (e.g., `preflight.kind` gates which of two
  entirely different sub-pipelines runs; `winner === undefined` gates
  whether capacity mode runs at all; `protectedSheetlessWinner`/`protectedFittingWinner`
  gate whether reconstruction runs). This is precisely the
  "direct producer roles whose chronology affects scheduler traces" /
  "complete versus capacity producer races" hazard the migration prompt
  calls out in section 14.2 — **do not** race these stages; they are not
  independent computations, they are sequential decisions.
- `intrinsicAnytimeSchedulerTrace`'s accumulating `quanta` array
  (section 4) is chronology itself — it exists specifically to record the
  *order* in which producer roles ran, checkpointed, and settled. Any
  parallel execution that changed this order would corrupt the very data
  structure whose job is to prove the order was correct. This is the
  clearest example in this cluster of "cache/trace ordering is part of the
  contract, not an implementation detail."
- `emitSharedArchiveProgress` call sites (section 10) are strictly ordered
  progress-protocol emissions (migration prompt section 15: "preserve the
  exact logical event count, phase sequence, ordering"); they must remain
  on the same logical serial timeline as today even if the *work* between
  them is internally parallelized by a callee.
- The Short Side observer/pair-fold block (`:1071-1203`) is explicitly
  "first success has defined authority" territory per migration-prompt
  section 14.2 ("Short Side portfolio branches where first success
  currently has defined authority") — though within *this* cluster's code
  there is only one candidate construction attempted (`observeIntrinsicShortSidePairFold`),
  not a race; the "first success" framing applies inside that callee's own
  portfolio (protected depth-first / capped contact-first / bounded
  reverse-depth lanes), out of this cluster's direct scope.

**Net assessment**: this cluster is the wrong place to look for Rayon wins.
Its job in a Rust port is to be a thin, deterministic, single-threaded
orchestrator that calls into (properly parallelized) callees and assembles
their already-decided, already-ordered results — mirroring migration
prompt section 14.3's "construct ordered input → parallelize pure work →
reassemble in order → apply validation/comparison/archive/trace in the same
logical order as TypeScript" pattern, where this cluster owns exactly the
"reassemble and apply in the same logical order" half.

---

## 14. Tests and gates covering this cluster

Direct unit-test coverage of these three files (verified by `grep -rln` for
their exported symbols across `tests/` and `scripts/`, excluding hits that
only touch unrelated exports):

- `tests/unit/irregularWorkerCompute.test.ts` (307 lines, read in full) —
  the primary direct test of `computeIrregularNesting` and
  `makeIrregularWorkerOutput`. Covers: `resolvePortfolioPlacementTransform`
  quarter-turn resolution and rejection cases (`:128-164`); real collision
  geometry construction end-to-end (`:166-173`); `IrregularComputeError`
  on missing source geometry (`:175-187`); `-copy-N` id fallback and
  state-snapshot progression (`:189-204`); **decision-trace emission gated
  by history mode** (`:206-227` — this test uses the *legacy windowed-beam*
  settings, `geometrySettings` at `:33-51` does **not** set
  `intrinsicSharedArchiveEnabled`, so it exercises the non-archive path
  where `emitDecisionTrace` *is* wired — this test does **not** cover the
  archive/Compact path's decision-trace no-op behavior documented in
  section 1); transform/history-frame shape at the worker boundary
  (`:229-281`); history-mode-off suppression (`:283-306`).
- `tests/unit/irregularBenchmark.test.ts`,
  `tests/unit/irregularSeventeenShapesCompactGolden.test.ts`,
  `tests/unit/irregularTriangleCompactGolden.test.ts`,
  `tests/unit/intrinsicSharedArchiveAdmission.test.ts`,
  `tests/unit/intrinsicCapacityIntegration.test.ts`,
  `tests/unit/irregularPortfolio.test.ts` all import `computeIrregularNesting`
  and/or `makeIrregularWorkerOutput` directly and exercise the archive path
  with Compact-shaped settings — these are the tests that actually cover
  the Compact production branch of this cluster's coordinator, though most
  of their assertions target downstream geometry/archive correctness rather
  than this cluster's own coordination logic per se.
- `tests/unit/workerProtocol.test.ts` (251 lines, read in full) — schema
  round-trip tests for `WorkerRequest`/`WorkerResponse`/`RunNestingPayload`/
  `NestingHistorySummary` (`src/shared/protocol/worker.ts`). Does not
  exercise `nesting.worker.ts` itself (no worker-thread spawn in this
  suite) — it tests the wire schema this cluster serializes into/out of.
- `tests/unit/algorithm.test.ts` includes a direct unit test of
  `sortPiecesForNesting` (`describe('sortPiecesForNesting', ...)`,
  `:107-118`) — the ordering source characterized in section 5/6. (Most of
  this file is rectangular-algorithm coverage, out of scope.)
- **No test in `tests/` spawns the actual `nesting.worker.ts` worker thread
  or drives it through `WorkerSupervisor`** (`grep -rln
  "WorkerSupervisor|nesting.worker.mjs|runNesting("  tests/` returns only
  `tests/unit/algorithm.test.ts`, which defines its own local `runNesting`
  helper unrelated to `WorkerSupervisor`). The RPC-server wiring in
  `nesting.worker.ts` itself (`NestingWorkerHandlers`, `WorkerLive`,
  `Effect.runPromise(Layer.launch(WorkerLive))`, `:455-489`) — including the
  exact progress-event sequence characterized in section 10 — is therefore
  **not directly unit-tested**; it is only exercised end-to-end by
  packaged-app manual use, per this repository's current test inventory. A
  Rust port's differential-parity test plan should add explicit coverage
  here (spawning the real worker thread, or an equivalent integration
  harness) rather than assuming the existing suite already pins this
  behavior.
- **Production gates** (`package.json` scripts) that transitively exercise
  this cluster by calling `computeIrregularNesting`/`makeIrregularWorkerOutput`
  from scripts rather than through the worker thread:
  `scripts/irregular-compact-baseline.ts`, `scripts/irregular-capacity-gate.ts`
  (backs `gate:capacity`/`gate:capacity:production`),
  `scripts/irregular-sheet-invariance.ts` (backs `corpus:sheet-invariance`,
  used by `gate:mixed61-compact`), `scripts/irregular-sheet-trace-dump.ts`,
  `scripts/irregular-overlap-relaxation*.ts`,
  `scripts/irregular-targeted-exact-lns-probe.ts`. `gate:compact-nine-baselines`
  runs `scripts/irregular-compact-nine-baselines.ts` (not directly grepped
  for `computeIrregularNesting` in this pass, but named in
  `docs/operations/irregular-production-gates.md:23` as the source of the
  nine-baseline hashes/areas cited there).
- `docs/operations/irregular-production-gates.md` (read in full) is the
  authoritative *behavioral* description of this cluster's externally
  observable contract for cancellation/progress/history
  (`:150-166`, matches section 10 of this document exactly) and is the
  document to keep in sync if this cluster's behavior is ever intentionally
  changed (it should not be, per the migration prompt).

---

## 15. Open questions and ambiguities

1. **`knowledge/` directory does not exist in this checkout.** The
   migration prompt's authoritative-map section (section 5) is written
   against a `knowledge/INDEX.md` + `knowledge/*.md` layout that has since
   been reorganized into `docs/architecture/`, `docs/research/`,
   `docs/artifacts/`, and `docs/operations/`. Every specific page the
   prompt names (e.g. `knowledge/compact-short-side-observer.md`,
   `knowledge/archive-only-compact-production.md`) needs a source-verified
   mapping to its current location before Stage 0's other characterization
   documents cite it. This document used `docs/research/compact-short-side-observer.md`
   and `docs/operations/irregular-production-gates.md` as the closest living
   equivalents for the claims this cluster needed, but did not attempt to
   map the entire `knowledge/*` list — that should be a deliverable of
   Stage 0's synthesis pass, not duplicated per-cluster.
2. **Stale prose confirmed and located precisely.**
   `irregularWorkerOutput.ts:138` states the Short Side strategy performs
   "...with an explicit Compact fallback." Source-of-truth behavior,
   verified in this cluster's own file: `computeIrregularNesting.ts:1194-1201`
   returns `IrregularNoValidResultError` (not the Compact-selected
   `selected` object) whenever `shortSideProfileRequested && !shortSideSelected`.
   There is **no code path in `coordinateIntrinsicSharedArchive`** where a
   Short-Side-requested run can return Compact's `placedCollisionGeometries`
   as the final result — `selected` is only ever returned as-is (still
   pointing at the Compact winner) when the short-side observer block is
   never entered at all, which happens only when `shortSideProfileRequested`
   is `false` in the first place (i.e., a plain Compact request, not a
   Short-Side request that "fell back"). No existing test asserts the
   `strategyDescription` string's exact content (section 3.4), so per the
   migration prompt's own instruction ("correct stale descriptive text only
   if doing so does not alter any stable serialized output or existing test
   expectation"), fixing this string appears safe — but this document does
   not modify source, and the orchestrator should decide whether/when to
   fix it, since it is technically still an observable field in every
   persisted Short-Side `NestingResult`.
3. **Is the `IrregularNfpIfpControlAbortError`/`isCancelled` cooperative
   mechanism intended to ever be wired into production, or is it
   permanently test/script-only?** Section 10 establishes it is 100% inert
   today for the worker path. The migration prompt (sections 15, "Preserve
   distinctions among explicit cancellation, wall-clock deadline...") reads
   as if this mechanism is a load-bearing part of production semantics; per
   source, it is not — production cancellation/timeout is exclusively a
   whole-`worker_thread`-kill performed by `WorkerSupervisor`. The
   orchestrator must decide: should the Rust N-API job's cancellation
   contract (a) match today's *actual* production mechanism (hard external
   abort of the whole native job, no partial result, no in-band checkpoint)
   and treat `isCancelled`/`control` porting as scoped only to
   test/script-harness parity, or (b) treat this as an opportunity to
   *newly* wire cooperative cancellation into the production worker path —
   which the migration prompt's "absolute semantic preservation" framing
   would otherwise forbid as a behavior change, but which might be
   reasonable to do explicitly and separately, outside the "preserve exact
   semantics" umbrella, since faster failure/cancellation is arguably a
   pure performance/UX improvement that doesn't change *accepted results*.
   This document takes no position; it only establishes the current, true
   state.
4. **Decision-trace machinery is dead for the two migration-target
   profiles.** Section 1/10 establish `emitDecisionTrace` is never invoked
   on the Compact/Compact-Short-Side (archive) path. Should Stage 1/2 of
   the Rust port implement decision-trace emission at all for these two
   profiles (since it is currently always empty and untested for them), or
   explicitly scope it out and note that `decisionTraceEventCount` must
   remain `0` and the NDJSON file must remain present-but-empty whenever
   `historyMode !== 'off'`? This should be an explicit Stage-0 decision
   recorded in the parity matrix, not left implicit.
5. **`maxHistoryEvents` is a fully decoded, persisted, UI-editable request
   field with zero effect on irregular worker behavior.** Confirm with the
   orchestrator whether this is a known, accepted gap (e.g., truncation is
   planned but not yet implemented) or a genuine dead field that the Rust
   port should simply also ignore. Either way, per the absolute
   preservation rule, **the Rust port must not implement truncation** even
   though the field name implies it should — implementing it would be an
   unauthorized behavior change.
6. **`occupiedHullWasteRatio` is computed on the internal score but dropped
   before the worker-output boundary** (section 3.4). Confirm this is
   intentional (a summary-schema omission) rather than an accidental
   regression, since it *is* an actively-used ranking criterion elsewhere
   in the codebase (`irregularLayoutScorer.ts:522,535`) — if a future
   schema change ever adds it to `IrregularLayoutScoreSummary`, this
   cluster's `scoreSummary`/`layoutScoreSummaryFields` functions would need
   a matching update, and a Rust port started *before* that schema change
   must not pre-emptively include the field (that would itself be an
   unauthorized behavior change relative to the current TS baseline).
7. **`canonicalEnclosedCavityCount` optional-field presence differs between
   Compact and Compact Short Side outputs** (section 3.4: present on the
   Compact winner's `portfolio.score`, always omitted on the Short-Side
   materialized result's `portfolio.score`). Confirm this asymmetry is
   intentional (Short Side's terminal geometry may not have a directly
   comparable canonical-cavity measurement available at that call site) so
   the Rust boundary DTO encodes it as a genuinely profile-dependent
   optional field rather than "always present" or "always absent."
8. **No test directly drives the real `nesting.worker.ts` RPC server or
   `WorkerSupervisor` end-to-end** (section 14). The exact progress-event
   sequence documented in sections 5/9/10 of this file was derived by
   reading `nesting.worker.ts` and `computeIrregularNesting.ts` line by
   line, not confirmed against an existing passing test that pins the
   sequence. Before relying on this document as a parity oracle for
   protocol-visible progress (migration prompt section 15/18.3), the
   orchestrator should add (or confirm the absence of) an integration test
   that actually captures the live event sequence for a real Compact and a
   real Compact Short Side run, so Stage 2's differential harness has a
   ground truth beyond static reading.
9. **Legacy non-archive (windowed-beam/GA) path's production liveness for
   *other* workerModes is unresolved by this document.** This cluster
   confirms it is dead for Compact/Compact Short Side specifically, but
   does not determine whether any *other* shipped `irregularSettings`
   configuration (reachable through a path this document did not trace,
   e.g. a saved project file authored before the archive became the
   default) still exercises it in the field. If so, that path is out of
   this migration's stated scope (only Compact and Compact Short Side are
   named in the prompt) but its coordination-layer plumbing
   (`runSingleSheetPortfolio`, `materializeProductionResult`,
   `reconstructPlacedGeometry`, `portfolioProgressForDecodeRole`) still
   physically lives inside `computeIrregularNesting.ts` and would need an
   explicit "TypeScript-only, not ported" decision recorded somewhere.
