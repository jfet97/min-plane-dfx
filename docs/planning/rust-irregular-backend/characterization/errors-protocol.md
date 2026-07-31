# Characterization: errors-protocol

Stage 0 characterization for the Rust irregular-nesting port (Compact / Compact
Short Side). Cluster scope: the external `AppErrorCode` protocol contract, the
internal typed (`Data.TaggedError`) irregular error hierarchy, and the single
worker-boundary function that maps the latter into the former.

Files read completely for this document:

- `src/shared/protocol/errors.ts`
- `src/workers/nesting.worker.ts`
- `src/shared/protocol/worker.ts`
- `src/workers/irregular/services.ts`

Every irregular error class definition (`Data.TaggedError`) was located by
`grep` and read in full at its declaration site, then traced to every
construction site and every consuming `.pipe(Effect.mapError(...))` /
`Effect.catchTags` / `Effect.matchEffect` boundary between it and either (a)
`toIrregularWorkerFailure` in `nesting.worker.ts`, or (b) a local
trace/status field that absorbs it before it can reach (a). The 17 classes
are listed in full in Section 1.

Files read in relevant part (not the primary specification surface of this
cluster, but load-bearing for tracing liveness, mapping, and reachability):

- `src/workers/algorithm/irregular/computeIrregularNesting.ts` (read in full
  across two passes — this is the sole call site of every external-facing
  error constructor plus the coordinator that decides which internal errors
  can reach the worker boundary at all)
- `src/main/services/WorkerSupervisor.ts` (full)
- `src/main/ipc/handlers.ts` (relevant part: `fromSupervisorError`,
  `fromCsvError`, supervisor wiring)
- `src/shared/utils/result.ts` (full)
- `src/shared/irregular/executionMode.ts` (full)
- `src/shared/irregular/defaults.ts` (relevant part: production defaults)
- `src/renderer/utils/irregularSettingsUi.ts` (full)
- `src/workers/algorithm/irregular/intrinsicSharedArchivePortfolio.ts`
  (relevant part: error union, direct-role construction)
- `src/workers/algorithm/irregular/intrinsicCapacityPreflight.ts`,
  `intrinsicCapacityMode.ts`, `intrinsicCapacitySearch.ts` (relevant parts)
- `src/workers/algorithm/irregular/intrinsicReconstructionPortfolio.ts`
  (relevant part)
- `src/workers/algorithm/irregular/intrinsicStrictDecoder.ts` (relevant part:
  internal deadline checkpoint)
- `src/workers/algorithm/irregular/intrinsicShortSideContactStrip.ts`,
  `intrinsicShortSidePairFoldObserver.ts` (relevant parts)
- `src/workers/algorithm/irregular/portfolioSearch.ts` (relevant parts: legacy
  GA/windowed-beam error mapping)
- `src/workers/irregular/nfpIfpService.ts` (relevant part:
  `computeIfpBoundsCached` vs. the live candidate-generation resolver)
- `src/workers/irregular/geometryKernel.ts`, `collisionGeometryBuilder.ts`
  (relevant part: `.Live` vs. `.Unimplemented` layer split)
- `src/workers/algorithm/irregular/irregularLayoutScorer.ts`,
  `irregularPlacementScorer.ts` (relevant part: `failScoring` call sites)
- `src/workers/algorithm/irregular/windowedBeam.ts`,
  `intrinsicExactProjection.ts`, `intrinsicGlobalSqueezePortfolio.ts`,
  `intrinsicQueueBeamDiscriminator.ts`, `intrinsicSqueezeDisruptSeparate.ts`,
  `intrinsicV7SeedArchive.ts`, `intrinsicTransformSeparator.ts`,
  `intrinsicPeriodicFamilyPortfolio.ts` (declaration sites and importer
  traces only, to establish liveness)
- Tests: `tests/unit/workerProtocol.test.ts`,
  `tests/unit/irregularWorkerCompute.test.ts` (read in full or relevant
  part); import/usage `grep` across all of `tests/unit` for every error
  class and for `AppErrorCode`

---

## 1. Purpose and role in Compact / Compact Short Side execution

This cluster has two layers:

**(a) The external contract.** `src/shared/protocol/errors.ts:6-26` defines
`AppErrorCode`, a flat, frozen array of 19 string literals shared by the
entire app (DXF import, project I/O, export, worker lifecycle, and irregular
nesting). `SerializedAppError` (`errors.ts:29-34`) is the wire shape
`{ code, message, context? }` used at every IPC/worker boundary. Only 8 of
the 19 codes are ever produced by the irregular nesting worker:
`irregular_source_geometry_missing`, `irregular_geometry_invalid`,
`irregular_scoring_error`, `irregular_no_valid_result`, `not_implemented`,
`worker_cancelled`, `worker_timeout`, and the generic `unknown_error`
catch-all. `worker_protocol_error` is declared (`errors.ts:19`) but **has no
production constructor anywhere in the current source** — grep-confirmed
zero non-declaration occurrences repo-wide. It exists today only as a
reserved slot, presumably anticipating the future native/N-API boundary this
migration will build. `SerializedAppError.is` (`errors.ts:36-42`) is also
dead code: grep-confirmed zero call sites anywhere in `src/` or `tests/`.

**(b) The internal typed hierarchy.** 17 classes across 13 files extend
`Data.TaggedError` under `src/workers/`. Exactly 8 of them compose the
exhaustive union `IrregularComputeErrorType`
(`computeIrregularNesting.ts:354-362`), which is the error channel of
`computeIrregularNesting` — the single function `nesting.worker.ts` calls for
the `irregular-convex-v2` (`IRREGULAR_WORKER_MODE`,
`src/shared/irregular/defaults.ts:14`) worker mode. Those 8, and only those
8, are switched over exhaustively (TS `strict: true`,
`tsconfig.node.json:8`, enforces this — the function has no `default` case
and returns `WorkerResponseFailureError` unconditionally) by
`toIrregularWorkerFailure` (`nesting.worker.ts:403-453`), which is the *only*
place in the whole codebase that converts an irregular algorithm error into
an `AppErrorCode`. The remaining 9 classes are internal-only: either (i)
absorbed into a trace/status field before ever reaching
`IrregularComputeErrorType`, or (ii) confined entirely to algorithm
sub-clusters that are not imported, directly or transitively, by
`computeIrregularNesting.ts` and are therefore not on the production
Compact / Compact Short Side path at all. Full per-class liveness is below.

### 1.1 Production defaults establish which coordinator branch runs

The renderer only ever constructs `IrregularOptimizerSettings` via
`makeCompactQualityIrregularOptimizerSettings()` ("Compact") or
`makeCompactShortSideIrregularOptimizerSettings()` ("Compact Short Side")
(`src/renderer/utils/irregularSettingsUi.ts:53-70`, wired from
`applyCompactQualityPreset`/`applyCompactShortSidePreset`). Both factories set
`intrinsicSharedArchiveEnabled: true`, `gaEnabled: false`, `baselineOnly:
true`, `placementPolicyId: 'edge-contact-then-balanced-compactness'`
(`src/shared/irregular/defaults.ts:149-165`, `168-175`). Feeding these into
`intrinsicSharedArchiveEligibility` (`src/shared/irregular/executionMode.ts:16-30`)
always yields `{ eligible: true }` for both profiles, so
`isIntrinsicSharedArchiveEligible` (`computeIrregularNesting.ts:1695-1697`)
is `true` and `coordinateIntrinsicSharedArchive`
(`computeIrregularNesting.ts:474...`) always takes its `archiveEnabled`
branch (`computeIrregularNesting.ts:504`) for any job created through the
current UI. The `else` branch at `computeIrregularNesting.ts:1065-1069`
(`runSingleSheetPortfolio` → the legacy genetic-algorithm / windowed-beam
search, `portfolioSearch.ts`/`windowedBeam.ts`) is **not** dead code in an
absolute sense — `irregularSettingsUi.ts:15-49` documents a
`'legacy-requires-migration'` UI mode for settings persisted before the
shared archive existed (`intrinsicSharedArchiveEnabled: false` or GA still
active) — but it is unreachable from any job created with current defaults
and is out of scope for what "the production Compact / Compact Short Side
path" means going forward. Every liveness claim below is qualified against
this split: "live (shared-archive path)" means reachable for any job created
today; "live only via legacy settings" means reachable only for pre-existing
persisted jobs that predate the shared archive.

### 1.2 Per-class inventory

| # | Class | Declared at | Fields | External code | Liveness on shared-archive path |
|---|---|---|---|---|---|
| 1 | `IrregularComputeError` | `computeIrregularNesting.ts:95-99` | `preparedPieceId`, `sourcePieceId`, `message` | `irregular_source_geometry_missing` | **Live.** 2 sites: `computeIrregularNesting.ts:392-398` (no imported source for a prepared piece) and `:1822-1829` (`reconstructPlacedGeometry`, legacy-path-only reconstruction step used by `materializeProductionResult`, itself only invoked from `runSingleSheetPortfolio`) |
| 2 | `IrregularGeometryInputError` | `services.ts:42-45` | `operation`, `message` | `irregular_geometry_invalid` | **Live.** 15 construction sites (Section 11.1) spread across geometry kernel, transform generator, NFP/IFP service, placement validation, clipper2 adapter, collision geometry builder, free-material service, windowed beam, targeted exact LNS, overlap relaxation, periodic family portfolio, and `computeIrregularNesting.ts:1838` |
| 3 | `IrregularGeometryInfeasibleError` | `services.ts:47-52` | `operation`, `message` | — | **Dead.** Only constructed at `nfpIfpService.ts:242-247`, inside `computeIfpBoundsCached` — the `Effect`-wrapped implementation bound to the public `NfpIfpService.computeIfpBounds` method. Grep-confirmed **zero** production callers of `.computeIfpBounds(` anywhere under `src/workers/algorithm`. The live candidate-generation path (`generatePlacementCandidatesUncached`, `nfpIfpService.ts:267-306`) calls the lower-level `resolveIfpBoundsFromServiceStore` directly and, on an `'infeasible'` result, treats it as "no legal IFP bounds → zero candidates for this piece/transform" (`nfpIfpService.ts:293-306`), **not** an error. Not a member of `IrregularComputeErrorType`, `SharedArchiveError` (`intrinsicSharedArchivePortfolio.ts:106-111`), reconstruction's `PortfolioError` (`intrinsicReconstructionPortfolio.ts:106-111`), or `IntrinsicCapacityModeError` (`intrinsicCapacityMode.ts:1131-1135`). Exercised only by direct unit-test calls to `service.computeIfpBounds(...)` |
| 4 | `IrregularPortfolioError` | `services.ts:55-59` | `operation`, `category: 'geometry'\|'scoring'\|'search'`, `message` | `irregular_geometry_invalid` (category `geometry`) or `irregular_scoring_error` (category `scoring`/`search`) | **Live, but category is always `'search'`** on the shared-archive path. All 3 construction sites reachable from `coordinateIntrinsicSharedArchive` (`computeIrregularNesting.ts:729`, `:742`, `:1246`) use the literal `category: 'search'`. Category `'geometry'`/`'scoring'` only arise via `toPortfolioError`/`failPortfolio` in the legacy GA path (`portfolioSearch.ts:1086-1111`), which is reachable only for legacy-migrated settings (Section 1.1) |
| 5 | `IrregularNoValidResultError` | `services.ts:62-67` | `operation`, `message` | `irregular_no_valid_result` | **Live, Compact-Short-Side-only.** Single construction site: `computeIrregularNesting.ts:1194-1200`, fired only when `shortSideProfileRequested` is true and the bounded pair-fold/observer machinery did not accept a terminal Short Side construction |
| 6 | `IrregularNfpIfpControlAbortError` | `services.ts:70-75` | `reason: 'deadline'\|'cancelled'`, `message` | `cancelled`→`worker_cancelled`; `deadline`→`worker_timeout` | **Split liveness — see Section 11.2.** `reason: 'deadline'` from `intrinsicStrictDecoder.ts:480-485` is live and reaches the top. `reason: 'cancelled'` from the coordinator's own control object (`computeIrregularNesting.ts:512-525`) is gated behind `input.options?.isCancelled`, which `nesting.worker.ts` never sets in production (Section 11.2) — practically dead |
| 7 | `IrregularNestingNotImplementedError` | `services.ts:34-40` | `service`, `operation`, `message` | `not_implemented` | **Dead.** Constructed only inside the `.Unimplemented` stub `Layer`s of `GeometryKernel` (`geometryKernel.ts:200-209`), `CollisionGeometryBuilder` (`collisionGeometryBuilder.ts:111-117`), and the generic service stubs in `services.ts:419-433`. `nesting.worker.ts:391-397` wires exclusively the `.Live` variants. This means **`not_implemented` is currently unreachable from any real user job** — it is a test-only negative-path guard |
| 8 | `IrregularPlacementScoringError` | `irregularPlacementScorer.ts:28-31` | `operation` (always `'scoreCandidate'`), `message` | `irregular_scoring_error` | **Live.** One `failScoring` helper (`irregularPlacementScorer.ts:444-451`), 5 call sites for non-finite-arithmetic invariant guards (`:202`, `:206`, `:210`, `:231`, `:264`) |
| 9 | `IrregularLayoutScoringError` | `irregularLayoutScorer.ts:22-25` | `operation` (always `'scoreState'`), `message` | `irregular_scoring_error` | **Live.** One `failScoring` helper (`irregularLayoutScorer.ts:578-585`), 4 call sites (`:230`, `:235`, `:248`, `:304`) |
| 10 | `IrregularWindowedBeamAbortedError` | `windowedBeam.ts:121-126` | `reason: 'deadline'\|'cancelled'`, `message` | — (not a member of `IrregularComputeErrorType`) | **Dead on the shared-archive path; conditionally live only via legacy settings.** Confined to `windowedBeam.ts`/`targetedExactLns.ts`/`portfolioSearch.ts`. `IrregularNestingPortfolio.run`'s declared type (`services.ts:366-371`) is `IrregularNestingNotImplementedError \| IrregularPortfolioError`; `runPortfolio` (`portfolioSearch.ts:187-190`) must locally absorb this tag (via `toPortfolioError`, `:1086-1103`) before returning |
| 11 | `IntrinsicCapacityError` | `intrinsicCapacityPreflight.ts:19-22` | `operation`, `message` | `irregular_scoring_error` (via `IrregularPortfolioError`) | **Live** — the dominant production error class whenever the complete/shared-archive endpoint does not fit the requested sheet. 23 construction sites across `intrinsicCapacityPreflight.ts`, `intrinsicCapacityMode.ts`, `intrinsicCapacitySearch.ts`, `intrinsicPlaceDeferCompleteShadow.ts`. Always converted to `IrregularPortfolioError({ category: 'search' })` via `mapIntrinsicCapacityError` (`computeIrregularNesting.ts:1242-1251`) |
| 12 | `IntrinsicStrictDecoderError` | `intrinsicStrictDecoder.ts:67-70` | `operation`, `message` | `irregular_scoring_error` (via `IrregularPortfolioError`) | **Live.** Converted to `IrregularPortfolioError({ category: 'search' })` at `computeIrregularNesting.ts:727-733`, only within the archive-eligible branch's `.pipe(Effect.mapError(...))` around `runIntrinsicSharedArchivePortfolio` |
| 13 | `IntrinsicReconstructionPortfolioError` | `intrinsicReconstructionPortfolio.ts:99-104` | `operation: 'seed'\|'order'\|'archive'`, `message` | — (absorbed) | **Constructed on the live path but never externally visible.** `runIntrinsicReconstructionPortfolio` is called from `computeIrregularNesting.ts:839-849` ("focused complete reconstruction", enabled by default). Its entire error channel — this tag, `IntrinsicStrictDecoderError`, `IrregularNestingNotImplementedError`, `IrregularGeometryInputError`, and `IrregularNfpIfpControlAbortError` **except** `reason: 'cancelled'** — is caught by `Effect.matchEffect` (`:850-858`) and converted into a `{ kind: 'failed', error }` *success* value, recorded only as `focusedCompleteReconstructionTrace.status = 'failed-protected-fallback'` (an internal trace field). See Section 11.3 |
| 14 | `IntrinsicExactProjectionError` | `intrinsicExactProjection.ts:81-92` | `operation` (4-literal union), `category: 'invalid-input'\|'exact-analysis'\|'projection-exhausted'`, `message`, optional `failedPieceId`, `attempts` | — | **Dead on the production path.** Used only by `intrinsicTransformSeparator.ts`, `intrinsicGlobalSqueezePortfolio.ts`, `intrinsicSqueezeDisruptSeparate.ts`, `intrinsicV7SeedArchive.ts` — none imported, directly or transitively, by `computeIrregularNesting.ts` |
| 15 | `IntrinsicGlobalPortfolioError` | `intrinsicGlobalSqueezePortfolio.ts:136-142` | `operation` (5-literal union), `message` | — | **Dead.** `intrinsicGlobalSqueezePortfolio.ts` has zero non-test importers repo-wide (grep-confirmed) |
| 16 | `IntrinsicQueueBeamDiscriminatorError` | `intrinsicQueueBeamDiscriminator.ts:587-592` | `operation: 'input'\|'measurement'`, `message` | — | **Dead.** `intrinsicQueueBeamDiscriminator.ts` has zero non-test importers repo-wide |
| 17 | `IntrinsicGlobalSearchError` | `intrinsicSqueezeDisruptSeparate.ts:739-742` | `operation` (4-literal union), `message` | — | **Dead.** `intrinsicSqueezeDisruptSeparate.ts` is imported only by `intrinsicGlobalSqueezePortfolio.ts`, itself dead |
| — | `IntrinsicV7SeedArchiveError` | `intrinsicV7SeedArchive.ts:210-216` | `operation` (4-literal union), `message` | — | **Dead.** `intrinsicV7SeedArchive.ts` has zero non-test importers repo-wide |

Classes 14–17 (plus `IntrinsicV7SeedArchiveError`) each have a dedicated unit
test file (`tests/unit/intrinsicExactProjection.test.ts`,
`tests/unit/intrinsicGlobalSqueezePortfolio.test.ts`,
`tests/unit/intrinsicStrictDecoder.test.ts` for the discriminator,
`tests/unit/intrinsicSqueezeDisruptSeparate.test.ts`,
`tests/unit/intrinsicV7SeedArchive.test.ts`) and CLI probe scripts
(`scripts/irregular-intrinsic-global-squeeze-e4.ts`,
`scripts/irregular-intrinsic-v7-seed-archive.ts`,
`scripts/irregular-intrinsic-global-triangle-diagnostic.ts`). They are real,
tested, self-contained experimental algorithm variants — not vestigial
garbage — but they are **not part of the Compact / Compact Short Side
production computation graph** and therefore out of scope for this port
unless the orchestrator explicitly decides otherwise (see Section 15).

**Conclusion for Section 1:** of the 8 tags actually switched over by
`toIrregularWorkerFailure`, only 6 external codes are practically reachable
from a job created under current UI defaults:
`irregular_source_geometry_missing`, `irregular_geometry_invalid`,
`irregular_scoring_error` (always via category `'search'` when routed
through `IrregularPortfolioError`), `irregular_no_valid_result`,
`worker_timeout` (via `reason: 'deadline'` only), and — transitively, from
outside this cluster's error hierarchy entirely — `worker_cancelled` and
`worker_crashed`/`worker_timeout` from `WorkerSupervisor.ts`. `not_implemented`
and the `IrregularNfpIfpControlAbortError('cancelled')`-flavored
`worker_cancelled` are both currently dead. See Section 11 for the exact
supporting trace.

## 2. Entry points, callers, callees (traced, not guessed)

**External entry point (renderer → main → worker):**
`src/main/ipc/handlers.ts:844` calls `getSupervisor().runNesting(request,
listener)`. `WorkerSupervisor.runNesting` (`WorkerSupervisor.ts:99-176`)
spawns/reuses a `node:worker_threads` `Worker` running the compiled
`nesting.worker.mjs`, opens an Effect RPC client
(`RpcClient.make(NestingWorkerRpcs)`, `WorkerSupervisor.ts:164`), and streams
`WorkerResponse` messages through `handleWorkerMessage`
(`WorkerSupervisor.ts:226-285`).

**Worker-side entry point:** `NestingWorkerHandlers`
(`nesting.worker.ts:455-474`) implements the single `RunNesting` RPC
(`NestingWorkerRpcs`, `worker.ts:176-182`) by forking `handleRunNesting`
(`nesting.worker.ts:190-338`) into a scoped fiber. `CancelWorkerRequest`
(`worker.ts:40-46`) is part of the `WorkerRequest` schema union
(`worker.ts:48-49`) but **`NestingWorkerRpcs` registers only `RunNesting`**
(`worker.ts:176-182`) — there is no `Cancel` RPC operation. Grep-confirmed
zero construction sites of `new CancelWorkerRequest(` anywhere in `src/`.
Cancellation is not signalled into the worker at all; see Section 11.2.

**Algorithm entry point:** `handleRunNesting` calls
`computeIrregularWorkerResult` (`nesting.worker.ts:340-401`) for
`workerMode === IRREGULAR_WORKER_MODE`, which calls `computeIrregularNesting`
(`computeIrregularNesting.ts:364-451`) with 5 required service layers
(`CollisionGeometryBuilder.Live`, `TransformGeneratorLive`,
`NfpIfpServiceLive`, `FreeMaterialServiceLive`,
`IrregularPlacementScorer.Layer`, `IrregularLayoutScorer.Live`,
`GeometryKernel.Live`, `nesting.worker.ts:391-397`) and error-maps the result
through `toIrregularWorkerFailure` (`nesting.worker.ts:399`).

**Error-boundary caller graph, root to leaf:**

```
handleRunNesting (nesting.worker.ts:190)
  └─ computeIrregularWorkerResult (nesting.worker.ts:340)
       └─ computeIrregularNesting (computeIrregularNesting.ts:364)
            .pipe(Effect.mapError(toIrregularWorkerFailure))   [nesting.worker.ts:399]
       └─ coordinateIntrinsicSharedArchive (computeIrregularNesting.ts:474)
            ├─ preflightIntrinsicCompleteCapacity (intrinsicCapacityPreflight.ts:65)
            │    .pipe(Effect.mapError(mapIntrinsicCapacityError))  [computeIrregularNesting.ts:531]
            ├─ runIntrinsicCapacityMode / runIntrinsicCapacitySchedulerColdQuantum
            │    (intrinsicCapacityMode.ts:1143, :386)
            │    .pipe(Effect.mapError(mapIntrinsicCapacityError))  [multiple sites]
            ├─ runIntrinsicSharedArchivePortfolio (intrinsicSharedArchivePortfolio.ts:155)
            │    .pipe(Effect.mapError(...))  [computeIrregularNesting.ts:726-738]
            │      → IntrinsicStrictDecoderError → IrregularPortfolioError(category:'search')
            │      → IntrinsicCapacityError → mapIntrinsicCapacityError
            │      → (IrregularNestingNotImplementedError | IrregularGeometryInputError |
            │         IrregularNfpIfpControlAbortError) pass through unchanged
            ├─ runIntrinsicReconstructionPortfolio (intrinsicReconstructionPortfolio.ts:124)
            │    .pipe(Effect.matchEffect(...))  [computeIrregularNesting.ts:839-865]
            │      → absorbed into a trace field UNLESS reason === 'cancelled'
            ├─ observeIntrinsicShortSidePairFold (intrinsicShortSidePairFoldObserver.ts:240)
            │      → returns Effect<_, never, _> — fully absorbs everything internally
            │        via Effect.catchTags (intrinsicShortSidePairFoldObserver.ts:275)
            └─ materializeIntrinsicCapacityResult / materializeSharedArchiveResult /
               materializeIntrinsicShortSideProfileResult / reconstructPlacedGeometry
                  → IrregularComputeError | IrregularGeometryInputError |
                    IrregularNestingNotImplementedError (layout scoring, geometry
                    reconstruction)
```

**Downstream of the worker:** `WorkerSupervisor.handleWorkerMessage`
(`WorkerSupervisor.ts:226-285`) reads `parsed.error.code` on a `'failure'`
message and calls `this.failCurrent(code, message, parsed.error.context)`
(`:282`), which constructs `SupervisorError` (`WorkerSupervisor.ts:46-55`)
and rejects the `runNesting` promise. `src/main/ipc/handlers.ts:163-175`
(`fromSupervisorError`) converts any `SupervisorError` back into
`SerializedAppError` for the renderer, or falls back to `unknown_error` for
any non-`SupervisorError` throw. `WorkerSupervisor` itself independently
produces `worker_crashed` (thread-error / RPC-channel throw,
`WorkerSupervisor.ts:301-311`), `worker_timeout` (a **separate**,
main-process-side `setTimeout`, `:126-149`, see Section 11.2), and
`worker_cancelled` (`cancelJob`, `:178-191`) — none of these three ever pass
through `toIrregularWorkerFailure`; they are constructed directly in
`WorkerSupervisor.ts` on the main-process side, independent of anything the
worker emits.

## 3. Data in/out: exact types/shapes, optional-field presence/omission semantics

`SerializedAppError` (`errors.ts:29-34`): `{ code: AppErrorCode; message:
string; context?: Readonly<Record<string, unknown>> }`. The `context` key is
**omitted entirely when absent**, never present with value `undefined`:
- `result.ts:5-13` (`err`): `context === undefined ? { code, message } : {
  code, message, context }` — explicit ternary, no key emitted for the
  `undefined` branch.
- `worker.ts:154-158` (`WorkerFailureResponse.unknown`): constructs
  `WorkerResponseFailureError` with only `{ code: 'unknown_error', message }`
  — no `context` key at all, ever, for this factory.
- `WorkerSupervisor.ts:320` (`failCurrent`): `context:
  Readonly<Record<string,unknown>> = {}` default parameter — this path
  *always* attaches at least `{ jobId }`, so `context` is never omitted for
  supervisor-originated failures (contrast with worker-originated ones,
  where every one of the 8 mapped tags supplies a non-empty context object
  explicitly — see the per-row table below).

`WorkerResponseFailureError` schema (`worker.ts:51-57`): `code:
Schema.Literals([...AppErrorCode])`, `message: Schema.String`, `context:
Schema.optional(Schema.Record(Schema.String, Schema.Unknown))`.
`WorkerFailureResponse` (`worker.ts:136-160`) wraps it with `requestId:
string`, `jobId: Schema.optional(JobId)` — `jobId` actually is always
present when `toIrregularWorkerFailure` fires, because `handleRunNesting`
always has a concrete `jobId` in scope (`nesting.worker.ts:195`,
`:286-291`); the schema's optionality exists for the generic
`WorkerFailureResponse.unknown` factory, which accepts `jobId?: JobId`
(`worker.ts:146-159`) but in the one call site that uses it
(`nesting.worker.ts:328-336`, the outer `Effect.catchCause`) `jobId` is
always supplied too.

**Exact context shape per external code, as constructed by
`toIrregularWorkerFailure` (`nesting.worker.ts:403-453`):**

| Code | Context fields | Value types |
|---|---|---|
| `irregular_source_geometry_missing` | `preparedPieceId`, `sourcePieceId` | both `PieceId` (branded `string`, `src/shared/domain/ids.ts:7,50-55`) |
| `irregular_geometry_invalid` | `operation` | `string` |
| `not_implemented` | `service`, `operation` | both `string` |
| `irregular_scoring_error` (from `IrregularPlacementScoringError`/`IrregularLayoutScoringError`) | `operation` | `string` (fixed literal `'scoreCandidate'` or `'scoreState'`) |
| `irregular_geometry_invalid` or `irregular_scoring_error` (from `IrregularPortfolioError`) | `operation`, `category` | `string`, `'geometry'\|'scoring'\|'search'` |
| `irregular_no_valid_result` | `operation` | `string` (fixed literal `'intrinsicShortSide'`) |
| `worker_cancelled` / `worker_timeout` (from `IrregularNfpIfpControlAbortError`) | `reason` | `'cancelled'\|'deadline'` |

All context values across the entire live surface are plain strings or a
branded string subtype — no numbers, booleans, nested objects, or `BigInt`
appear in any error `context` produced by `toIrregularWorkerFailure`. This
is a meaningful simplification for the Rust port's error-context
marshaling: an `HashMap<&'static str, String>`-shaped payload (or an enum
with named `String` fields) is sufficient; no numeric/BigInt encoding
concerns apply to this cluster specifically (contrast with canonical-key or
checkpoint serialization elsewhere in the codebase, which does use `BigInt`).

`message: string` is a free-text, human-readable sentence assembled per call
site (see Section 11 for the message templates). No test in the existing
suite asserts an exact `message` string for any of these 8 mapped errors
(grep-confirmed: no `.message` assertion in `tests/unit/irregularWorkerCompute.test.ts`,
and no dedicated `nesting.worker.ts`/`WorkerSupervisor.ts` test file exists
at all — see Section 14). Message text is therefore *not* currently
contract-tested, only `code` and (indirectly) presence/shape of `context`
via schema round-trip tests in `tests/unit/workerProtocol.test.ts`. The
migration prompt's "error codes or error provenance" invariant (Section 2 of
the prompt) should, on this evidence, be read as covering `code` +
`context` field *presence and shape*, not the literal `message` string —
but this is an interpretive judgment call the orchestrator should confirm
explicitly (see Section 15).

## 4. Algorithm state and every mutation point

Not applicable to error *construction* itself (each `Data.TaggedError`
instance is immutable data, and `toIrregularWorkerFailure` is a pure
function with no closure state). The state that matters here is **which
branch of the coordinator is active when a failure occurs**, since that
determines which of the 17 classes can be in flight:

- `computeIrregularNesting.ts:489` `let selected: MaterializedDecode` — the
  coordinator's single mutable "current best materialized decode" variable.
  It is not yet assigned when errors from `preflightIntrinsicCompleteCapacity`,
  `runIntrinsicSharedArchivePortfolio`, or the capacity/scheduler calls
  occur (all of these run before the first assignment to `selected` at
  `:595`, `:1008`, or `:1039`). Any failure before the first assignment
  short-circuits the whole `Effect.gen` block via `yield*
  Effect.fail(...)`/propagation — there is no partial-`selected` state that
  could leak into a later success.
- `computeIrregularNesting.ts:490-502` (`capacityShadowTelemetry`,
  `intrinsicAnytimeSchedulerTrace`, `experimentalPlaceDeferTrace`,
  `focusedCompleteReconstructionTrace`,
  `settledCompleteArchiveForShortSideObserver`,
  `intrinsicShortSideObserverTrace`, `intrinsicShortSidePairFoldTrace`) — all
  `let`-bound, all optional/observer-only trace accumulators. None of them
  feed into any error's `context`; they are attached to the *successful*
  `IrregularComputeResult` only (`:1204-1238`) and are irrelevant to a
  failure path once one of the 8 external-facing errors is raised (failure
  short-circuits the generator before the final object literal is built).

## 5. Ordering sources: sorts, Map/Set, iteration order reaching output/errors

No error class in this cluster involves a sort, a `Map`/`Set` iteration, or a
tie-break. The one ordering-adjacent fact worth recording: the `switch`
statement in `toIrregularWorkerFailure` (`nesting.worker.ts:404-452`) has an
arbitrary case order (it matches `computeIrregularErrorType`'s declaration
order at `computeIrregularNesting.ts:354-362`) that has **zero behavioral
effect** — each `_tag` maps to exactly one branch regardless of source
order, and TypeScript's exhaustiveness check does not depend on case
ordering either. A Rust `match` arm order is equally irrelevant for the same
reason; this is a non-issue for the port, noted only to close the loop
explicitly per the task's "every sort/iteration order" instruction.

The one place ordering *is* observable near this cluster: diagnostics
concatenation for a **successful** result, `computeIrregularNesting.ts:1212-1216`
— `diagnostics: [...input.diagnostics, ...selected.score.freeMaterialSnapshot.diagnostics,
...archiveDiagnostics]`. This is output ordering for informational
`CollisionGeometryDiagnostic` entries, not error ordering, and is out of
scope for this cluster (belongs to whichever cluster owns
`CollisionGeometryDiagnostic`/scoring output).

## 6. Comparators and tie rules: exact comparison chains, signs, tie-breakers

The only branch-selection logic in this cluster is the category ternary at
`nesting.worker.ts:435-437`:

```ts
code: error.category === 'geometry' ? 'irregular_geometry_invalid' : 'irregular_scoring_error',
```

Truth table: `category === 'geometry'` → `irregular_geometry_invalid`;
`category === 'scoring'` **or** `category === 'search'` → both fall into the
same `irregular_scoring_error` branch. This is exactly the "unusual current
mapping" the migration prompt's Section 16 table calls out for the `search`
case ("preserve this unusual current mapping exactly") — confirmed correct
against source: `IrregularPortfolioError.category` is a 3-way union but the
external code space collapses it to 2 values, with `'search'` and
`'scoring'` indistinguishable externally. On the shared-archive production
path this is moot in practice, since `category` is always the literal
`'search'` there (Section 1.2, row 4) — the `'scoring'` branch of this
ternary is only exercised by legacy-path `IrregularPortfolioError`
instances built through `toPortfolioError` (`portfolioSearch.ts:1086-1103`).

There are no numeric comparisons, no stable-sort reliance, and no
locale-sensitive string comparisons anywhere in the error-construction or
error-mapping code in this cluster.

## 7. Numeric semantics

Essentially not applicable — no error's `code`, `message`, or `context`
value is computed via floating-point arithmetic, `BigInt`, or grid
conversion. The only numeric quantities anywhere near this cluster are wall
clocks that gate whether a `deadline`-reasoned abort or timeout fires at
all, not values encoded in any error payload:

- `WorkerSupervisor.ts:116-119`: `timeoutMs = request.options.timeoutMs &&
  request.options.timeoutMs > 0 ? request.options.timeoutMs :
  this.options.defaultTimeoutMs`. For irregular jobs this is raised via
  `workerTimeoutForMode` (`src/shared/irregular/defaults.ts:19-26`) to at
  least `DEFAULT_IRREGULAR_WORKER_TIMEOUT_MS = 390_000` ms
  (`defaults.ts:16`) — but note `workerTimeoutForMode` is a pure helper; grep
  shows it is **not actually called from `WorkerSupervisor.ts`** in the
  traced code (the supervisor uses its own `defaultTimeoutMs` constructor
  option, `createDefaultSupervisor`, `WorkerSupervisor.ts:342-352`, hardcodes
  `60_000`). This is worth flagging: `workerTimeoutForMode` exists and is
  exported but its only non-test caller could not be found in the traced
  files — see Section 15 open question about where (if anywhere) the
  390-second floor is actually applied to a real supervisor timeout.
- `intrinsicStrictDecoder.ts:476-479`: `previousActiveRuntimeMs +
  timingNow() - startedAt >= maximumRuntimeMs` — an exact `>=` comparison on
  `performance.now()`-derived milliseconds (binary64), gating the live
  `reason: 'deadline'` construction (`:480-485`). This is **inherently
  wall-clock/non-deterministic**: the exact prepared-piece or transform index
  a decode was evaluating when a 35-second (or 30/240-second periodic)
  budget expires depends on host CPU speed, GC pauses, and OS scheduling. A
  Rust port cannot and should not attempt byte-identical reproduction of
  *which* input triggers a deadline abort — only that the class of check
  (wall-clock threshold, same units, same comparison operator) is preserved.
  Contrast with `IntrinsicCapacityError`'s evaluation-cap violations (exact
  integer counters, e.g. `INTRINSIC_SHARED_ARCHIVE_PERIODIC_EVALUATION_CAP =
  19_862`, `intrinsicSharedArchivePortfolio.ts:47`), which **are**
  deterministic and must reproduce byte-identically. See Section 15/port
  risks.
- `nesting.worker.ts:386`: `elapsedMs: Math.max(0, Date.now() -
  startedAtMs)` — a non-negative clamp on the benchmark field of a
  **successful** result, unrelated to any error payload.

No signed-zero, NaN, infinity, or safe-integer check appears in any error
construction path in this cluster (those checks exist upstream, inside the
scorers, and are exactly what *triggers* `IrregularPlacementScoringError`/
`IrregularLayoutScoringError` — see Section 11.1 — but the error objects
themselves carry only strings).

## 8. Serialization and hashing

No `JSON.stringify`, custom canonical encoder, or SHA-256 input touches this
cluster. `context: Record<string, unknown>` crosses two independent wire
boundaries with two independent, non-JSON encodings:

1. **Worker thread → main process:** the Effect RPC layer
   (`RpcServer.layer`/`RpcClient.make`, `nesting.worker.ts:478-483`,
   `WorkerSupervisor.ts:122-125,164`) running over
   `NodeWorkerRunner`/`NodeWorker` — i.e. `node:worker_threads`
   `postMessage`, which uses the HTML structured-clone algorithm, not JSON.
   The exact wire encoding is internal to the `effect`/`@effect/platform-node`
   npm packages and was not traced further; it is out of scope for a Rust
   port that replaces the *algorithm* layer, not the Node worker-thread RPC
   transport (see Section 15).
2. **Main process → renderer:** `fromSupervisorError`
   (`src/main/ipc/handlers.ts:163-175`) builds a plain `IpcResult` object
   sent via Electron's `ipcMain`/`ipcRenderer`, which also uses structured
   clone, not JSON, by default.

Neither boundary is part of the Rust N-API surface this migration will
introduce (the Rust port replaces `computeIrregularNesting` and its callees,
not the worker RPC transport). The only requirement that carries forward is
**structural**: the Rust boundary function (the eventual analogue of
`toIrregularWorkerFailure`) must produce a plain `{ code: string, message:
string, context?: object }`-shaped JS value (via whatever N-API/napi-rs
struct-to-JS conversion is chosen) that `WorkerResponseFailureError`'s Effect
Schema decoder (`worker.ts:51-57`) accepts unchanged. Byte-level wire parity
claims do not apply across this specific transport change; only
value/structural parity does.

`GeometryCacheLive` (`services.ts:436-448`) is documented as "Deterministic
per-worker cache with no failure entries" (`services.ts:435`) — i.e. none of
the 17 error classes, nor any partial/invalid intermediate value, is ever
written to the geometry cache. This is a relevant negative fact for the
cache-architecture cluster's boundary with this one: errors never pollute
cache state.

## 9. Caches touched and the exact historical access sequence

None. No cache lookup, validation, staleness check, or publication occurs
inside any error-construction or error-mapping code path in this cluster.
(The geometry/NFP/IFP caches themselves are the subject of the
`geometry-caches` characterization cluster; the only fact relevant here is
the "no failure entries" guarantee noted in Section 8.)

## 10. Cancellation / deadline / budget / evaluation-cap observation points

This is the most consequential section for this cluster. Three distinct,
non-interchangeable mechanisms currently produce what a user experiences as
"my job stopped due to a timeout or cancellation," and they are **not**
unified:

**(a) Main-process hard timeout — `WorkerSupervisor.ts:126-149`.** A plain
`setTimeout(timeoutMs)` set when `runNesting` starts. On fire, it calls
`this.teardownWorker(current.dispose, 'timeout')` (`:140`) — which disposes
the `ManagedRuntime`, tearing down the underlying `NodeThreadWorker` — and
rejects with `SupervisorError('worker_timeout', ..., { requestId, jobId,
timeoutMs })` (`:141-147`). This **terminates the worker thread outright**
and never involves any of the 17 `Data.TaggedError` classes in this
cluster; it fires regardless of what the algorithm was doing at the moment
of expiry, with no cooperative signal into the worker at all. Its `context`
shape (`{ requestId, jobId, timeoutMs }`) differs from the worker-emitted
`worker_timeout`'s `context` (`{ reason: 'deadline' }`,
`nesting.worker.ts:450`) — **the same `AppErrorCode` value is produced by
two structurally different code paths with two different context shapes**,
depending entirely on whether the external wall clock or the internal
per-decode wall clock expired first.

**(b) Main-process explicit cancellation — `WorkerSupervisor.cancelJob`
(`WorkerSupervisor.ts:178-191`).** Identical teardown pattern
(`teardownWorker(current.dispose, 'cancel')`), rejects with
`SupervisorError('worker_cancelled', ...)`. No RPC message is sent into the
worker (`CancelWorkerRequest` is unused, Section 2). This is also a hard
thread-kill with no cooperative signal.

**(c) In-algorithm cooperative abort — `IrregularNfpIfpControl.checkpoint`
(`services.ts:70-89`).** This is the mechanism the migration prompt's
Section 15 language ("current TypeScript control checks are often lazy and
placed at specific cooperative boundaries") appears to assume matters most.
It is real, typed, and threaded through `generatePlacementCandidates`'s
`control` parameter — but **only two of its many call sites are reachable in
production for jobs created under current defaults**:

- `intrinsicStrictDecoder.ts:472-487` — the direct-role decoder used inside
  `runIntrinsicSharedArchivePortfolio` (live, Section 1.2 row 12) builds its
  **own** `control` object that (i) delegates to `input.control?.checkpoint`
  if one was supplied, and (ii) independently checks its own
  `maximumRuntimeMs` wall-clock budget on every checkpoint call,
  **regardless of whether an external `control` was ever supplied**. This is
  the live source of `reason: 'deadline'`.
- `computeIrregularNesting.ts:512-525` — the coordinator's own top-level
  `control` object, constructed **only when** `input.options?.isCancelled
  !== undefined` (`:513`). **`nesting.worker.ts`'s `computeIrregularWorkerResult`
  (`:340-401`) never sets `isCancelled` on the options object it passes to
  `computeIrregularNesting`** (grep-confirmed: `isCancelled` appears nowhere
  in `nesting.worker.ts`). Therefore `control` is `undefined` for every real
  production job, `checkpoint` is never invoked in a way that can produce
  `reason: 'cancelled'` from this site, and **the only construction site of
  `IrregularNfpIfpControlAbortError` reachable from the top of the live
  coordinator can never fire in production.** This is confirmed exhaustively:
  `isCancelled` is threaded down into `runSingleSheetPortfolio`
  (`computeIrregularNesting.ts:1433-1435`, legacy path only) and
  `portfolioSearch.ts:215,278,337,384,447` (legacy path internals), all
  gated the same way, all `undefined` in production. Tests
  (`tests/unit/irregularPortfolio.test.ts`,
  `tests/unit/irregularWindowedBeam.test.ts`) exercise `isCancelled` by
  calling `computeIrregularNesting`/lower-level functions directly with an
  explicit callback — the production entry point never does.

Other `IrregularNfpIfpControlAbortError` construction sites that *are* on
the live path are locally absorbed and never reach `toIrregularWorkerFailure`:

- `intrinsicShortSideContactStrip.ts:279-298` — live for Compact Short Side
  (invoked via `observeIntrinsicShortSidePairFold`, itself invoked whenever
  `shortSideProfileRequested`, `computeIrregularNesting.ts:1071-1076`,
  `:1124-1140`). Its `control.checkpoint` callback maps `boundedStatus(runtime)`
  (`intrinsicShortSideContactStrip.ts:801`, returns `'deadline' \|
  'memory-cap' \| undefined`) into `reason: bounded === 'deadline' ?
  'deadline' : 'cancelled'` (`:292`). **Because `boundedStatus` never
  actually returns anything but `'deadline'`, `'memory-cap'`, or
  `undefined`, the only way to reach the `'cancelled'` branch of that
  ternary is when an internal `'memory-cap'` bound is hit** — i.e. this code
  path can construct a `reason: 'cancelled'` abort for what is actually a
  deterministic internal memory/complexity cap, not a user cancellation.
  This is a genuine, source-verified oddity — but it is **not externally
  observable**: `observeIntrinsicShortSidePairFold`'s declared return type
  is `Effect.Effect<IntrinsicShortSidePairFoldOutcome, never, ...>`
  (`intrinsicShortSidePairFoldObserver.ts:251`) — every failure, including
  both `IrregularNfpIfpControlAbortError` reasons, is caught by
  `Effect.catchTags` (`:275-...`) and converted into a `failed-protected-fallback`
  trace-status success value. Document this as source-truth ("the
  specification"), not as a bug to fix, per the migration prompt's Section 2
  — but it must **not** be treated as a live `worker_cancelled` producer.
- `computeIrregularNesting.ts:839-865` (focused reconstruction) — see
  Section 11.3: absorbs everything except `reason: 'cancelled'` locally, and
  since `reason: 'cancelled'` can never actually be produced here either
  (its `control` comes from the same always-undefined top-level `control`),
  this call site produces no externally visible failure at all in
  production.
- `windowedBeam.ts:1406`, `intrinsicSqueezeDisruptSeparate.ts:5587`,
  `intrinsicGlobalSqueezePortfolio.ts:764`,
  `intrinsicQueueBeamDiscriminator.ts:680,1093,1179,1440` — all confined to
  the legacy GA path or the dead experimental cluster (Section 1.2).

**Net conclusion:** in current production, for a Compact or Compact Short
Side job created under UI defaults, the *only* way to observe
`worker_timeout` from inside the algorithm (as opposed to the supervisor's
external kill) is the `intrinsicStrictDecoder.ts` internal per-decode
wall-clock budget; `worker_cancelled` is **never** produced by the
algorithm layer at all — every real cancellation a user triggers today goes
through `WorkerSupervisor.cancelJob`'s hard thread-kill, which the algorithm
never observes or gets a chance to unwind gracefully from. There is no
"partial result" path and no evidence of one being needed, consistent with
the migration prompt's "existing no-partial-result rule."

Deterministic evaluation caps (`IntrinsicCapacityError`,
`INTRINSIC_SHARED_ARCHIVE_PERIODIC_EVALUATION_CAP = 19_862`) are
comparison-checked inline within the relevant search loops (outside this
cluster's file set) and surface through the ordinary error-mapping path
(`mapIntrinsicCapacityError` → `IrregularPortfolioError` → `irregular_scoring_error`)
rather than through the cancellation/deadline machinery — consistent with
the migration prompt's instruction that caps "must remain statuses" /
mapped errors, not conflated with cancellation.

## 11. Error paths: tagged error classes, categories, context fields, propagation

### 11.1 `IrregularGeometryInputError` construction sites (all `operation: string, message: string`)

Representative, non-exhaustive sample of the 15 grep-confirmed sites (all
map uniformly to `irregular_geometry_invalid`):

- `src/workers/irregular/geometryKernel.ts:264`
- `src/workers/irregular/transformGenerator.ts:439`
- `src/workers/irregular/nfpIfpService.ts:1298`
- `src/workers/irregular/placementValidation.ts:158,429`
- `src/workers/irregular/collisionGeometryBuilder.ts:244`
- `src/workers/irregular/freeMaterialService.ts:500`
- `src/workers/irregular/clipper2OffsetAdapter.ts:228`
- `src/workers/irregular/convexPolygonOffset.ts:59`
- `src/workers/irregular/transformCollisionGeometry.ts:52`
- `src/workers/algorithm/irregular/windowedBeam.ts:304` (legacy path)
- `src/workers/algorithm/irregular/overlapRelaxationV1.ts:187`
- `src/workers/algorithm/irregular/targetedExactLns.ts:761`
- `src/workers/algorithm/irregular/intrinsicPeriodicFamilyPortfolio.ts:1427`
- `src/workers/algorithm/irregular/computeIrregularNesting.ts:1838`
  (`reconstructPlacedGeometry`, legacy path only — see Section 11.4)

### 11.2 `IrregularNfpIfpControlAbortError` — full construction-site inventory

10 sites total (`grep -rn "new IrregularNfpIfpControlAbortError("`):

| File:line | Reason value(s) | Live? | Reaches external boundary? |
|---|---|---|---|
| `computeIrregularNesting.ts:519` | `'cancelled'` only | Gated behind `isCancelled`, never wired from `nesting.worker.ts` | No (dead in production) |
| `intrinsicStrictDecoder.ts:481` | `'deadline'` only | Live (own internal timer) | **Yes** |
| `intrinsicShortSideContactStrip.ts:291` | `'deadline'` or `'cancelled'` (latter really means internal `'memory-cap'`, Section 10) | Live (Compact Short Side) | No — absorbed by `observeIntrinsicShortSidePairFold`'s `Effect<_, never, _>` boundary |
| `intrinsicSqueezeDisruptSeparate.ts:5587` | — | Dead cluster | No |
| `intrinsicGlobalSqueezePortfolio.ts:764` | — | Dead cluster | No |
| `intrinsicQueueBeamDiscriminator.ts:680,1093,1179,1440` (4 sites) | — | Dead cluster | No |
| `windowedBeam.ts:1406` | — | Legacy path only | No externally (absorbed by `runPortfolio`'s `IrregularPortfolioError`-only return type) |

### 11.3 Focused-reconstruction absorption (`computeIrregularNesting.ts:839-865`)

```ts
Effect.matchEffect(
  runIntrinsicReconstructionPortfolio({ ... }),
  {
    onFailure: (error) =>
      error._tag === 'IrregularNfpIfpControlAbortError' && error.reason === 'cancelled'
        ? Effect.fail(error)
        : Effect.succeed({ kind: 'failed' as const, error }),
    onSuccess: (reconstruction) => Effect.succeed({ kind: 'completed' as const, reconstruction })
  }
)
```

Only `reason: 'cancelled'` re-fails (and, per Section 11.2, that reason can
never actually be produced from this call in production, since the `control`
it would need is the same always-undefined top-level one). Every other
error — `IntrinsicReconstructionPortfolioError`, `IntrinsicStrictDecoderError`,
`IrregularNestingNotImplementedError`, `IrregularGeometryInputError`, and
`IrregularNfpIfpControlAbortError` with `reason: 'deadline'` — is converted
into a `{ kind: 'failed', error }` **success** value and surfaces only as
`focusedCompleteReconstructionTrace.status = 'failed-protected-fallback'` /
`.failureReason = \`${tag}: ${message}\`` (`computeIrregularNesting.ts:866-879`).
Computation continues using the "protected fallback" endpoint rather than
failing the job. This means: **a genuine internal deadline/decoder/geometry
failure inside the focused-reconstruction sub-search never surfaces as an
external error at all** — it is silently downgraded to a successful result
with a degraded trace field. This is a real, source-verified behavior that
must be preserved exactly (per the migration prompt's Section 2, "decision-trace
ordering" and "error codes or error provenance" are both in the
do-not-change list) — a Rust port that instead propagated this failure as a
job-level error would be an observable behavior change.

### 11.4 `IrregularComputeError` — both construction sites

1. `computeIrregularNesting.ts:392-398` — inside the per-piece prepare loop
   (`for (const prepared of sortedPieces) { ... }`), when
   `findSourcePiece(prepared.sourcePieceId, prepared.id, sourcePieces)`
   (`:1906...`) returns `undefined`. Message: `` `No imported source
   geometry was found for prepared piece ${prepared.id}.` ``.
2. `computeIrregularNesting.ts:1822-1829` — inside `reconstructPlacedGeometry`
   (legacy-path-only helper used by `materializeProductionResult`), when a
   portfolio placement has no matching prepared piece. Message: `` `Portfolio
   placement ${placement.sourcePieceId} has no prepared piece.` ``.

Both map to the same external code and context shape
(`{ preparedPieceId, sourcePieceId }`) despite different message text and
different (live vs. legacy-only) call sites — confirming message text is not
part of the stable contract (Section 3).

### 11.5 Category assembly for `IrregularPortfolioError` in the legacy path

`portfolioSearch.ts:1086-1103` (`toPortfolioError`): maps any tagged error's
`_tag` into a category — `'IrregularGeometryInputError'` or
`'IrregularGeometryInfeasibleError'` → `'geometry'`;
`'IrregularPlacementScoringError'` or `'IrregularLayoutScoringError'` →
`'scoring'`; anything else (including `'IrregularWindowedBeamAbortedError'`,
`'IrregularNestingNotImplementedError'`) → `'search'`. Note the
`'IrregularGeometryInfeasibleError'` branch is itself dead (Section 1.2, row
3) since nothing in the legacy path constructs that tag either — defensive
code with no live trigger.

## 12. JS-specific semantics hazards for a Rust port

- **Exhaustiveness is TS-strict-mode-enforced, not structurally
  guaranteed.** `toIrregularWorkerFailure`'s exhaustiveness depends on
  `tsconfig.node.json:8`'s `"strict": true` plus the absence of a `default`
  case; a Rust `match` over an enum gives a strictly stronger, compiler-level
  guarantee. This is a straightforward, low-risk improvement in
  *robustness* only — the mapping itself (which tag → which code/context)
  must still be reproduced exactly per the table in Section 1.2.
- **`Cause.pretty(cause)` (`nesting.worker.ts:333`) is an `effect`-npm-package-specific
  defect formatter**, used as the `message` for the generic `unknown_error`
  catch-all (`WorkerFailureResponse.unknown`, `:328-335`). Its exact string
  content (stack traces, fiber IDs, nested-cause rendering) is tied to the
  installed `effect` package version and is not something a Rust panic/defect
  message could ever reproduce byte-for-byte. Per the migration prompt's own
  guidance (Section 16: "do not expose raw panic payloads or a native
  backtrace by default"), this is very likely a case where only `code ===
  'unknown_error'` should be parity-gated, not `message` text — but this
  needs an explicit orchestrator ruling since the current TS `unknown_error`
  path does **not** sanitize its message (it embeds the full `Cause.pretty`
  output, which can include stack traces) — the current *TypeScript*
  behavior for this one code is actually less sanitized than what the
  migration prompt prescribes for Rust's own defect boundary. See Section 15.
- **`unknown_error` also swallows history/decision-trace file I/O
  failures.** `handleRunNesting`'s declared type is `Effect.Effect<void,
  never, FileSystem.FileSystem | Path.Path>` (`nesting.worker.ts:194`) — any
  unhandled `PlatformError.PlatformError` from `prepareHistoryFile`,
  `appendFrame`, `prepareDecisionTraceFile`, or `appendDecisionTraceBatch`
  (all of which can fail on disk-full/permission errors) is caught by the
  same outer `Effect.catchCause` (`:327-337`) and reported as a generic
  `unknown_error`, indistinguishable from a genuine algorithm defect. This
  is source-verified, not an assumption — worth flagging since it means
  `unknown_error` is not purely "unclassified native defect" in current
  behavior; it is also the catch-all for a class of ordinary, classifiable
  I/O failures.
- **`_tag` discriminant vs. Rust enum variant names.** `Data.TaggedError`
  auto-derives a `readonly _tag: 'ClassName'` field used for narrowing
  (`error._tag === 'IrregularComputeError'`, etc., throughout). This is
  purely a TS-runtime discrimination mechanism with no external visibility
  (never serialized into `SerializedAppError`) — safe to drop entirely in
  favor of a native Rust enum discriminant.
- **No string ordering, no UTF-16 concerns, no locale sensitivity, no
  `Map`/`Set` iteration order** appears anywhere in this cluster (Section 5).
- **Two structurally different serialization boundaries carry the same
  logical payload** (Section 8) — worker-thread structured clone vs.
  Electron IPC structured clone — neither of which is JSON, and neither of
  which the Rust port needs to reproduce byte-for-byte; only the JS-visible
  object shape at the `WorkerResponseFailureError` schema boundary matters.

## 13. Parallelism assessment

`toIrregularWorkerFailure` itself is a pure, O(1), side-effect-free function
of one error value — trivially safe under any concurrency model and not a
meaningful target for parallelization (it runs at most once per job, at job
end).

The load-bearing observation for the orchestrator is about **error
provenance under future Rayon parallelization of the phases that can raise
these errors** (NFP/IFP candidate generation, transform preparation, scoring
— all outside this cluster's file set but feeding into it). Today, because
`computeIrregularNesting` and everything it calls is built from sequential
`Effect.gen` generators, **at most one of the 17 error classes is ever "in
flight" at a time**, and error provenance is inherently "first
sequentially-encountered failure in program order" (`Effect.fail` short-circuits
the generator at the `yield*` point). If the orchestrator parallelizes, say,
per-transform candidate legality evaluation with Rayon, and two transforms
in the same batch would both independently raise
`IrregularGeometryInputError` with different `operation`/`message` values,
the *chosen* winner's `operation` string and `message` text becomes part of
the observable error contract (Section 3 established no test currently
pins `message` text, but `operation` values are effectively enumerable and
could plausibly be asserted by a future differential test). Per the
migration prompt's Section 14.3 deterministic parallel pattern, any such
parallel batch must preserve "first ordinal, not first thread to finish" as
the winning failure — this cluster's evidence (single-error-in-flight,
sequential generator semantics) is the concrete justification for why that
constraint exists and must be enforced explicitly rather than left to
`Result`/`Either`-style "any error wins" reduction.

No cache, ledger, checkpoint, or trace-append operation occurs inside error
construction (Sections 4, 9), so there is no additional serialization
constraint imposed by *this* cluster on a Rayon boundary elsewhere — the
constraint is purely about which single error, chosen deterministically,
ultimately reaches `toIrregularWorkerFailure`.

## 14. Tests and gates covering this cluster

- `tests/unit/workerProtocol.test.ts` — schema round-trip only. Validates
  that `WorkerRequest`/`WorkerResponse` decode/encode correctly, including
  one `'failure'` response with code `irregular_source_geometry_missing`
  and its `context` shape (`:224-240`). **Does not exercise
  `toIrregularWorkerFailure` itself** (it is a private, unexported function
  in `nesting.worker.ts`; grep-confirmed no `export` keyword at
  `nesting.worker.ts:403`).
- `tests/unit/irregularWorkerCompute.test.ts` — calls `computeIrregularNesting`
  directly (not through the worker RPC boundary) and asserts, for the
  "fails with a typed error when source geometry is missing" case
  (`:175-188`), that the failure `instanceof IrregularComputeError` and
  `._tag === 'IrregularComputeError'` (`:185-186`) — i.e. it tests the
  *internal* typed error, not the external `AppErrorCode` mapping.
- **No dedicated test file exists for `src/workers/nesting.worker.ts` or
  `src/main/services/WorkerSupervisor.ts`** — grep-confirmed via
  `find . -iname "*WorkerSupervisor*" -o -iname "*nesting.worker*"` across
  the whole repo excluding `node_modules`, returning only the two source
  files themselves. This means **the exact mapping table this document's
  SPECIAL FOCUS was asked to verify (Section 16 of the migration prompt) is
  not directly unit-tested anywhere in the existing suite** — it is only
  indirectly covered by the schema-shape test above and the one internal-tag
  assertion. This is a material testing gap the orchestrator should close
  with new (additive, not replacing) tests before or during the Rust port,
  per the migration prompt's Section 18 TDD requirement.
- No `scripts/*.ts` gate script references `AppErrorCode`,
  `WorkerResponseFailureError`, or `toIrregularWorkerFailure`
  (grep-confirmed against `scripts/`). The irregular benchmark/probe scripts
  (`scripts/irregular-benchmark.ts`, `scripts/irregular-capacity-gate.ts`,
  etc.) use plain `throw new Error(...)` for their own CLI assertion
  failures, unrelated to this protocol.
- Indirect coverage of the *internal* tag hierarchy exists broadly (every
  file listed in Section 1.2's construction-site columns has some unit-test
  coverage of its own error-raising conditions — e.g.
  `tests/unit/nfpIfpService.test.ts:1412,1429` exercises
  `IrregularGeometryInfeasibleError` directly via `service.computeIfpBounds`,
  confirming the class works correctly even though it is dead on the
  production path). This document does not re-enumerate all such tests
  individually since they belong to their owning clusters (geometry,
  scoring, capacity, etc.), not to errors-protocol.

## 15. Open questions and ambiguities

1. **`worker_protocol_error` has zero current producers.** The migration
   prompt's Section 16 table assigns it to "malformed native response or
   N-API protocol-version mismatch detected by the worker boundary" — this
   is correct as forward-looking guidance for the Rust port's own N-API
   boundary, but the orchestrator should confirm there is no missed current
   TS producer before implementation (grep-confirmed zero non-declaration
   occurrences repo-wide as of this snapshot).
2. **`not_implemented` is entirely dead in production** (Section 1.2, row
   7) — only test-only `.Unimplemented` stub layers construct it. The
   migration prompt's table includes it as a real mapping row; this
   document confirms the *mapping* is correct (verified against source) but
   the *external code* is currently unreachable from any real job. The
   orchestrator should decide whether the Rust port needs to preserve a
   reachable `not_implemented` path at all (e.g. for a partially-implemented
   Rust rollout where some sub-feature is intentionally stubbed), since
   nothing in current TS production exercises this contract end-to-end.
3. **`worker_cancelled` is never produced by the algorithm layer in
   production** (Section 10). Every real user-triggered cancellation today
   is a main-process hard kill of the worker thread
   (`WorkerSupervisor.cancelJob`), never a cooperative in-algorithm abort.
   `IrregularNfpIfpControlAbortError('cancelled')`'s one live-reachable
   top-level construction site (`computeIrregularNesting.ts:519`) requires
   `isCancelled` to be wired from `nesting.worker.ts`, which it currently is
   not. **This is a material discrepancy with the migration prompt's
   Section 15 framing**, which discusses "current TypeScript control checks
   ... placed at specific cooperative boundaries" as if they are load-bearing
   in production today. The orchestrator must decide: (a) preserve this
   exactly — the Rust port's worker entry point must also never wire
   cooperative cancellation into the algorithm, keeping all real
   cancellation as a hard native-side kill (matching current behavior
   precisely, including the "no partial result" guarantee falling out of a
   full abort rather than a graceful one); or (b) treat this as a bug the
   orchestrator has separately decided to fix (which would be an observable
   behavior change requiring an explicit user ruling per the migration
   prompt's Section 2/3, not something this Stage-0 characterization is
   authorized to recommend).
4. **`workerTimeoutForMode` (`src/shared/irregular/defaults.ts:19-26`)
   appears to have no live caller.** It computes a 390-second floor for
   irregular jobs, but `WorkerSupervisor`'s only traced timeout source is
   its own `defaultTimeoutMs` constructor parameter, hardcoded to `60_000`
   in `createDefaultSupervisor` (`WorkerSupervisor.ts:342-352`) and passed
   again as `60_000` in `src/main/ipc/handlers.ts:141-146`
   (`createSupervisor`). If no caller actually applies
   `workerTimeoutForMode`, then in practice the supervisor's external
   `worker_timeout` fires at 60 seconds for irregular jobs too, not 390 —
   which would very plausibly be shorter than a legitimate Compact Short
   Side shared-archive decode. **This needs empirical confirmation (grep
   alone cannot rule out a caller in a file outside the files read for this
   document) before the orchestrator treats either the 60s or 390s figure as
   the production constant** — flagging this prominently per the task's
   instruction to surface any discrepancy with the migration prompt's
   assumed constants.
5. **Is `message` text part of the frozen contract?** Section 3/12
   established that no existing test pins exact `message` strings for the 8
   mapped external errors, and the `unknown_error` catch-all's message is
   demonstrably unsanitized `Cause.pretty` output today. The orchestrator
   should rule explicitly on whether the Rust port's differential-parity
   gates compare `message` text byte-for-byte (matching the migration
   prompt's general "preserve current TypeScript behavior exactly" stance)
   or only `code` + `context` shape (which the absence of any current test
   coverage would suggest is the *de facto*, if not documented, contract).
6. **The legacy GA/windowed-beam path's exact current reachability.**
   Section 1.1 establishes it is unreachable from any job created under the
   *current* UI, but is reachable for pre-existing persisted project files
   with older settings. The orchestrator should confirm with the user
   whether persisted legacy settings of this shape are expected to remain
   loadable/runnable against the Rust backend during/after this migration,
   since that determines whether `IrregularWindowedBeamAbortedError`,
   `IrregularGeometryInfeasibleError`'s legacy-path branch, and
   `IrregularPortfolioError` categories `'geometry'`/`'scoring'` need to be
   ported at all for Stage 0/1, or can be deferred.
7. **Should the 4 fully-dead experimental modules (`intrinsicGlobalSqueezePortfolio.ts`,
   `intrinsicQueueBeamDiscriminator.ts`, `intrinsicV7SeedArchive.ts`,
   `intrinsicSqueezeDisruptSeparate.ts`, plus `intrinsicExactProjection.ts`
   and `intrinsicTransformSeparator.ts` which only they use) be ported at
   all?** They have real unit-test coverage and CLI probe scripts but zero
   production callers. The migration prompt's Section 4 scope boundaries
   were not read in full for this document (out of the requested skim list)
   — the orchestrator should confirm these are correctly excluded from
   Stage-0/1 scope rather than silently dropped, since "the existing test
   suite... remains authoritative" (migration prompt Section 3) could be
   read as requiring their tests to keep passing even if the Rust port never
   implements the underlying dead-code algorithms (i.e. those specific
   tests may need to stay TypeScript-only, exempted from the Rust
   differential gate, rather than becoming failing gates).
