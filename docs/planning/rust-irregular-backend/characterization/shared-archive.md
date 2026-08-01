# Characterization: shared-archive cluster

Cluster files (read completely, line by line):

- `src/workers/algorithm/irregular/intrinsicSharedArchivePortfolio.ts` (725 lines)
- `src/workers/algorithm/irregular/intrinsicAnytimeArchive.ts` (62 lines)

This document is written for a Rust implementer who will not re-read the TypeScript, and
for a parity reviewer who must verify a Rust port against it. Every nontrivial claim below
carries a `file:line` reference. Dependencies that live in other files are cited but not
exhaustively re-specified — those belong to their own cluster's characterization doc
(noted inline where relevant: `intrinsicStrictDecoder.ts` for the ranking/Pareto machinery,
`intrinsicCapacityMode.ts` for the capacity/partial archive, `irregularBeamState.ts` for
geometry-state transforms, `canonicalLayoutGeometry.ts` for canonical identity/legality).

Supporting context read: `docs/history/prompts/fable5-rust-irregular-nesting-implementation.md`
(§2, §8, §9, §13, §14), `docs/research/intrinsic-anytime-portfolio.md`,
`docs/architecture/compact-architecture-explained.md`.

---

## 1. Purpose and role in Compact / Compact Short Side execution

`intrinsicSharedArchivePortfolio.ts` implements the **complete-cohort exact archive**: it
runs the three "direct" sheetless constructors (`canonical-grid`,
`legacy-absolute-envelope`, `open-pocket-first`) plus the periodic-family continuation
portfolio, deduplicates their completed layouts by canonical geometry hash, ranks the
survivors, and selects one intrinsic winner. `intrinsicAnytimeArchive.ts` is the generic,
namespace-agnostic storage/dedup/rank primitive that both this file and
`intrinsicCapacityMode.ts` build on.

**Both files are live on the production Compact and Compact Short Side path.** Trace:

- `computeIrregularNesting.ts:474` `coordinateIntrinsicSharedArchive` — doc comment: "Runs
  the intrinsic archive as the compact production path." It is invoked from the top-level
  irregular search coordinator whenever `isIntrinsicSharedArchiveEligible(input.settings)`
  is true (`computeIrregularNesting.ts:483`, `:1695-1697`).
- Eligibility (`src/shared/irregular/executionMode.ts:16-35`,
  `intrinsicSharedArchiveEligibility`): eligible iff
  `optimizer.intrinsicSharedArchiveEnabled === true` AND
  `optimizer.placementPolicyId !== 'short-side-fill'` AND GA is disabled
  (`gaEnabled===false || baselineOnly===true || gaTimeBudgetMs===0 || gaGenerationBudget===0
  || gaEvaluationBudget===0`).
- **Production defaults satisfy this.** `DEFAULT_IRREGULAR_OPTIMIZER_SETTINGS =
  makeCompactQualityIrregularOptimizerSettings()` (`src/shared/irregular/defaults.ts:177-178`)
  sets `intrinsicSharedArchiveEnabled: true`, `gaEnabled: false`, `baselineOnly: true`,
  `placementPolicyId: 'edge-contact-then-balanced-compactness'`
  (`defaults.ts:149-165`). `makeCompactShortSideIrregularOptimizerSettings` is the *same*
  settings with only `intrinsicObjectiveProfileId: 'short-side'` added
  (`defaults.ts:168-175`) — it does **not** touch `placementPolicyId` or
  `intrinsicSharedArchiveEnabled`, so Compact Short Side is equally eligible.
  `placementPolicyId: 'short-side-fill'` is a distinct, separate (legacy/experimental)
  setting from `intrinsicObjectiveProfileId: 'short-side'`; only the former disables the
  archive.
- Inside `coordinateIntrinsicSharedArchive`, `shortSideProfileRequested` is computed from
  `intrinsicObjectiveProfileId === 'short-side'` (`computeIrregularNesting.ts:484-486`) and
  is consulted only *after* the shared archive has run (`computeIrregularNesting.ts:1073,
  1077, 1125, 1171, 1194`) to decide whether to additionally run the directional Short Side
  observer against `settledCompleteArchiveForShortSideObserver`, which is populated directly
  from this cluster's `sheetlessArchive`/`retainRankedSharedArchive` output
  (`computeIrregularNesting.ts:496-499, 934-938`). This matches
  `docs/architecture/compact-architecture-explained.md:458-464`: Short Side runs the *same*
  protected Compact/capacity coordinator first, then constructs new directional geometry for
  the Compact-selected placed IDs only.
- `retainIntrinsicAnytimeArchiveNamespace` (`intrinsicAnytimeArchive.ts:33-48`) is used by
  **both** production call sites: `retainRankedSharedArchive` in this cluster
  (`intrinsicSharedArchivePortfolio.ts:355-380`, namespace `'complete'`) and the capacity
  mode's partial-archive dedup in `intrinsicCapacityMode.ts:1303-1313` and `:1322-1336`
  (namespace `'partial'`, called twice: once for the base candidate set, again — only when a
  strict placed-count improvement is present — after merging in the quality-warm-prefix
  endpoint).

**One function in this cluster is dead in production**:
`selectIntrinsicAnytimeSettledEndpoint` (`intrinsicAnytimeArchive.ts:55-62`). It is exported,
fully implemented, and documented as applying "the terminal dominance contract after both
namespaces have settled" (complete beats partial unless complete is empty), but
`grep -rn "selectIntrinsicAnytimeSettledEndpoint"` across `src/` finds **zero** call sites
besides its own definition. The only place that exercises it is
`tests/unit/intrinsicAnytimeArchive.test.ts:37-49`. Production instead re-implements the
identical dominance rule by hand: `computeIrregularNesting.ts:959`
(`if (winner === undefined) { …run capacity… } else { …use winner… }`), where `winner` comes
from this cluster's `selectIntrinsicSharedArchiveWinner(selectFittingSharedArchive(...))`
and the capacity branch's result is the pre-existing "partial namespace" winner computed
inside `intrinsicCapacityMode.ts`. See §15 for why this duplication matters for the port.

`runIntrinsicSharedArchiveDirectPortfolio` (`intrinsicSharedArchivePortfolio.ts:241-352`) is
exported and used by production (as a sub-step of `runIntrinsicSharedArchivePortfolio`,
called at `intrinsicSharedArchivePortfolio.ts:166`) and is also exercised standalone by the
provenance script `scripts/irregular-intrinsic-shared-archive.ts:27` (not a CI gate; see
§14).

## 2. Entry points, callers, callees

### Public entry points (both exported, both called from `computeIrregularNesting.ts`)

- `runIntrinsicSharedArchivePortfolio(sheet, pieces, options)` —
  `intrinsicSharedArchivePortfolio.ts:155-238`. Sole production caller:
  `computeIrregularNesting.ts:641-738`.
- `runIntrinsicSharedArchiveDirectPortfolio(sheet, pieces, options)` —
  `intrinsicSharedArchivePortfolio.ts:241-352`. Called only from
  `runIntrinsicSharedArchivePortfolio:166-189` in production; also called directly by
  `scripts/irregular-intrinsic-shared-archive.ts` and by
  `tests/unit/intrinsicSharedArchivePortfolio.test.ts` indirectly via
  `normalizeIntrinsicSharedArchiveConstructedRun`.

### Other exported functions and their production callers

| Function | Defined at | Production caller(s) |
|---|---|---|
| `retainRankedSharedArchive` | `:355-380` | `runIntrinsicSharedArchivePortfolio:212`; `computeIrregularNesting.ts:801-803, 934-937` (called again on already-deduped input, see §4) |
| `selectFittingSharedArchive` | `:383-389` | `runIntrinsicSharedArchivePortfolio:213`; `computeIrregularNesting.ts:806-808, 939-941` |
| `selectIntrinsicSharedArchiveWinner` | `:392-405` | `runIntrinsicSharedArchivePortfolio:214`; `computeIrregularNesting.ts:804-808, 939-941` |
| `intrinsicSharedPeriodicSelectionValid` | `:476-494` | `runIntrinsicSharedArchivePortfolio:215-222` (feeds `periodicSelectionValid`, itself read by `intrinsicSharedArchiveProductionValid`) |
| `intrinsicSharedArchiveExperimentValid` | `:497-519` | Computed into `experimentValid` at `runIntrinsicSharedArchivePortfolio:231-235` but **not read** by `computeIrregularNesting.ts` (verified: `grep -n "\.experimentValid" computeIrregularNesting.ts` → no hits). Test-only consumer otherwise. |
| `intrinsicSharedArchiveProductionValid` | `:522-539` | `computeIrregularNesting.ts:739` — gates the entire nesting job (see §11) |
| `intrinsicSharedPeriodicCatalogCoverageValid` | `:542-552` | Called from `intrinsicSharedArchiveProductionValid:530` |
| `normalizeIntrinsicSharedArchiveConstructedRun` | `:560-609` | `runIntrinsicSharedArchiveDirectPortfolio:340-348`; `normalizePeriodicRun:645-651` |
| `makeIntrinsicSharedArchiveEndpoint` | `:612-637` | `normalizeIntrinsicSharedArchiveConstructedRun:580-586`; also called directly by `computeIrregularNesting.ts:890-910` for the focused-reconstruction endpoint |
| `retainIntrinsicAnytimeArchiveNamespace` | `intrinsicAnytimeArchive.ts:33-48` | `retainRankedSharedArchive:359-378`; `intrinsicCapacityMode.ts:1303, 1322` |
| `selectIntrinsicAnytimeSettledEndpoint` | `intrinsicAnytimeArchive.ts:55-62` | **None in production** (see §1) |

### Callees (imported, out of this cluster)

- `assertCanonicalGridLegalLayout`, `canonicalCollisionLayoutIdentity` —
  `src/workers/irregular/canonicalLayoutGeometry.ts:343-386, :139-150` — canonical-grid
  legality and rotation/translation-invariant identity.
- `runIntrinsicPeriodicFamilyPortfolio` and its result/option types —
  `intrinsicPeriodicFamilyPortfolio.ts:227` and interfaces at `:57-218`.
- `retainIntrinsicAnytimeArchiveNamespace` — intra-cluster (`intrinsicAnytimeArchive.ts`).
- `constructIntrinsicStrictState`, `evaluateIntrinsicStrictCertificate`,
  `measureIntrinsicSheetlessCompletedLayout`, `rankIntrinsicStrictCompletedLayouts`,
  `selectIntrinsicStrictCompletedParetoFront`, and their types — all from
  `intrinsicStrictDecoder.ts` (functions at `:401`, `:1956`, `:1823`, `:2284`, `:2271`).
- `IrregularBeamState` — `irregularBeamState.ts:78` (class), specifically
  `withQuarterTurnBottomLeft` (`:379-465`) and (transitively via
  `measureIntrinsicSheetlessCompletedLayout`) `withBottomLeftAnchored` (`:287-351`).
- `IntrinsicCapacityError` — `intrinsicCapacityPreflight.ts:19-22` (imported for the error
  union type only; see §11 for why it is unreachable from this cluster in practice).
- Error/control types `IrregularGeometryInputError`, `IrregularNfpIfpControl`,
  `IrregularNestingNotImplementedError`, `IrregularNfpIfpControlAbortError`,
  `NfpIfpService` — `src/workers/irregular/services.ts:34-89`.
- `createHash` from `node:crypto`, `performance` from `node:perf_hooks`, `Effect` from
  `effect`.

## 3. Data in/out: exact types/shapes, optional-field presence/omission semantics

### Inputs

`runIntrinsicSharedArchivePortfolio(sheet: SheetSpec, pieces: ReadonlyArray<IrregularPreparedPiece>, options)`
— `intrinsicSharedArchivePortfolio.ts:155-158`. `options` fields
(`IntrinsicSharedArchivePortfolioOptions`, `:113-152`), all optional:

- `directCandidateEvaluationCaps?: Partial<Record<IntrinsicSharedArchiveDirectRole, number>>`
  — per-role evaluation cap. **Never set by production** (`computeIrregularNesting.ts:641-725`
  passes no such field), so `requestedCandidateEvaluations` is always `undefined` for all
  three direct roles in real runs (`:263`).
- `maximumDirectRuntimeMs?: number` — defaults to `600_000` inside
  `runIntrinsicSharedArchiveDirectPortfolio:259` if omitted, but **production always passes
  `35_000`** explicitly (`computeIrregularNesting.ts:645`). This is the per-role wall-clock
  cap threaded unchanged into every resume call of `constructIntrinsicStrictState` (see §4).
- `canonicalGridCompletedPieceQuantum?: number` — production sets this to `1`
  (`computeIrregularNesting.ts:649`) whenever the (currently hard-coded-`true`)
  `schedulerEnabled` flag is on (`computeIrregularNesting.ts:604`), i.e. **always** in the
  current build. This is what makes `canonical-grid` pause after every single completed
  piece (see §4).
- `onCanonicalGridCheckpointed?`, `control?`, `onPhaseCompleted?`, `onDirectConstructed?`,
  `includeSourceAuditWitnesses?` (defaults `true` at `:165`; production also passes `true`
  explicitly at `computeIrregularNesting.ts:646`), `periodic?` (an `Omit<...>` of
  `IntrinsicPeriodicFamilyPortfolioOptions` that specifically *forbids* the caller from
  overriding `maximumContinuationCandidateEvaluations`, `maximumContinuationCount`,
  `captureSourceSurvivalAudit`, `admitSourceAuditWitnesses` — `:145-151` — because this
  cluster fixes those four to its own constants, see below).

All optional-option threading in this file uses the `...(x === undefined ? {} : {x})` spread
idiom (e.g. `:167-188`, `:285-296`) — the *key* is omitted from the object literal when the
option is `undefined`, not set to an explicit `undefined` value. This only matters if a
downstream callee distinguishes `'key' in obj` from `obj.key === undefined`; ordinary
property reads (`input.checkpoint`, etc.) see identical `undefined` either way, so this is a
non-hazard for plain field access, but a Rust port using `serde(skip_serializing_if)` /
`Option` should not assume it is safe to special-case key presence anywhere downstream
without checking (out of this cluster's scope — flagged for the checkpoint/encoding cluster).

Module-level constants (`:41-47`) are contractual production values:
```
INTRINSIC_SHARED_ARCHIVE_DIRECT_ROLES = ['canonical-grid', 'legacy-absolute-envelope', 'open-pocket-first']
INTRINSIC_SHARED_ARCHIVE_PERIODIC_CONTINUATION_COUNT = 8
INTRINSIC_SHARED_ARCHIVE_PERIODIC_EVALUATION_CAP = 19_862
```
These are unconditionally forced onto the periodic sub-call
(`:196-203`: `maximumContinuationCandidateEvaluations:
INTRINSIC_SHARED_ARCHIVE_PERIODIC_EVALUATION_CAP`, `maximumContinuationCount:
INTRINSIC_SHARED_ARCHIVE_PERIODIC_CONTINUATION_COUNT`) — the caller-supplied `options.periodic`
cannot change them (enforced at the type level by the `Omit`, `:145-151`). These are
**not** the capacity-mode constants (beam width 16, fanout 3, per-depth quota 4,096, total
cap) named in the migration prompt §11 — those live in `intrinsicCapacityMode.ts`, a
different cluster; no contradiction found here, this cluster simply has its own, disjoint set
of production constants.

### Outputs

`IntrinsicSharedArchivePortfolioResult` (`:95-104`) — every field always present (plain
object, not conditionally spread):

```
directRuns, periodicRuns: ReadonlyArray<IntrinsicSharedArchiveRun>
periodicPortfolio: IntrinsicPeriodicFamilyPortfolioResult
sheetlessArchive, archive: ReadonlyArray<IntrinsicSharedArchiveEndpoint>
winner: IntrinsicSharedArchiveEndpoint | undefined
periodicSelectionValid, experimentValid: boolean
```

Of these, `computeIrregularNesting.ts` reads only `directRuns`, `periodicRuns`,
`periodicPortfolio`, `sheetlessArchive`, and `periodicSelectionValid` (via
`intrinsicSharedArchiveProductionValid` and diagnostic string-building, §1/§11). **`archive`,
`winner`, and `experimentValid` are computed but never consumed by the production
coordinator** — it recomputes `retainRankedSharedArchive`/`selectFittingSharedArchive`/
`selectIntrinsicSharedArchiveWinner` itself from `sheetlessArchive` instead of trusting the
already-computed `archive`/`winner` fields (`computeIrregularNesting.ts:801-808`). A Rust
port's top-level struct must still compute these fields byte-identically (they are part of
the public, unit-tested return shape — `tests/unit/intrinsicSharedArchivePortfolio.test.ts`
does not directly assert on them, but the type contract is public), even though the
production control-flow path ignores them.

`IntrinsicSharedArchiveEndpoint` (`:73-82`) — every field always present:
```
role: string
sourceId: string | undefined
sheetlessCanonicalGeometryIdentity: string
sheetlessCanonicalGeometryHash: string
placedCollisionGeometries: ReadonlyArray<IrregularPlacedPiece>
metrics: IntrinsicStrictCompletedMetrics
certificate: IntrinsicStrictCertificate
requestedSheetFit: IntrinsicSharedArchiveSheetFit
```

`IntrinsicSharedArchiveRun` (`:84-93`) — every field always present, `reason`/`endpoint`
explicit `undefined` on the non-applicable branch (never omitted):
```
role: string
sourceId: string | undefined
status: IntrinsicSharedArchiveRunStatus  ('completed'|'evaluation-cap'|'deadline'|'global-deadline'|'invalid'|'incomplete')
requestedCandidateEvaluations, consumedCandidateEvaluations: number | undefined
reason: string | undefined
endpoint: IntrinsicSharedArchiveEndpoint | undefined
runtimeMs: number
```

`IntrinsicSharedArchiveSheetFit` (`:60-66`) / `IntrinsicSharedArchiveOrientationFit`
(`:68-71`): `q0`/`q90` each `{fits: boolean, canonicalGeometryHash: string | undefined}`;
`selectedRotationDeg: 0 | 90 | undefined`; `selectedCanonicalGeometryHash: string |
undefined`; `selectedPlacedCollisionGeometries: ReadonlyArray<IrregularPlacedPiece>` (`[]`
when nothing is selected, never `undefined` — see `requestedSheetFit:718-724`).

`IntrinsicStrictCompletedMetrics.exact?` (`intrinsicStrictDecoder.ts:128-139`) is the one
genuinely optional field this cluster's comparators branch on (see §6/§7). In production it
is **always** populated: `completedMetrics` (`intrinsicStrictDecoder.ts:1854-1934`)
unconditionally constructs the `exact: {...}` sub-object in its literal (no conditional
spread) and only returns `undefined` for the *whole* metrics object if any field including
`exact` fails a finiteness/non-empty-string check (`:1925-1933`); it never returns a metrics
object with `exact` selectively absent. `measureIntrinsicSheetlessCompletedLayout` — the only
producer of `IntrinsicStrictCompletedMetrics` reachable from this cluster's endpoints
(`:1823-1852`, called at `intrinsicSharedArchivePortfolio.ts:625`) — always goes through
`completedMetrics`. **Consequence:** in production, every `IntrinsicSharedArchiveEndpoint.metrics.exact`
is defined, and the float-fallback branches of `compareCertificateDeficit`,
`compareLargestHullGap`, `compareEnvelope` (§6) are unreachable from real runs. They are
reachable only from unit-test-constructed metrics (§14) — a coverage gap to carry into the
Rust differential harness (see §15).

## 4. Algorithm state and every mutation point

Neither file holds module-level mutable state. All mutation is local to one call.

### `intrinsicAnytimeArchive.ts` — pure, no mutation across calls

`retainIntrinsicAnytimeArchiveNamespace` (`:33-48`) builds one local `Map<string, Endpoint>`
named `unique`, mutated only inside its own `for` loop (`.set` at `:42-45`), then discarded
after `[...unique.values()]` is passed to `policy.rank(...)` (`:47`). No state survives the
call. `selectIntrinsicAnytimeSettledEndpoint` has no mutable state at all (`:55-62`).

### `intrinsicSharedArchivePortfolio.ts`

**`runIntrinsicSharedArchiveDirectPortfolio` (`:241-352`) — the primary state machine.**
Per role (`for (const role of INTRINSIC_SHARED_ARCHIVE_DIRECT_ROLES)`, `:261`):
- `startedAt = performance.now()` (`:262`) — captured **once per role**, before any resume.
- `checkpoint: IntrinsicStrictDirectCheckpoint | undefined` (`:264`) — freshly `undefined`
  per role (no leakage across roles).
- `outcome` (`:265-274`) — reassigned each loop iteration.
- `while (true)` loop (`:275-312`):
  1. Calls `constructIntrinsicStrictState` with `checkpoint` merged in only if defined
     (`:289`), and with `maximumCompletedPieceBoundaries: quantum` only for
     `role === 'canonical-grid'` when a quantum option is present (`:290-296`) — this is the
     **only** role that can ever produce a mid-construction checkpoint; the other two roles
     always run to full completion/failure/deadline in one call.
  2. `Effect.matchEffect` (`:276-303`) converts the callee's typed failure/success into a
     local `{kind:'failure', error}` / `{kind:'success', constructed}` union — no exception
     is thrown.
  3. Break condition (`:304-309`): loop exits when the call failed, **or** when it succeeded
     but produced no checkpoint (i.e. either the role fully settled, or it hit its evaluation
     cap / deadline in one shot without ever reaching the piece-boundary pause point).
  4. Otherwise (`:310-311`): `checkpoint = outcome.constructed.checkpoint`; the
     `onCanonicalGridCheckpointed` callback is awaited (this is the exact point where
     `computeIrregularNesting.ts:650-703` interleaves one capacity-cold scheduler quantum
     between successive canonical-grid piece-boundary checkpoints — see the deterministic
     interleaving contract in `docs/research/intrinsic-anytime-portfolio.md` Stage 4C). The
     loop then re-invokes `constructIntrinsicStrictState` with the new checkpoint, resuming
     from where it paused.
  - `maximumRuntimeMs: maximumDirectRuntimeMs` (`:283`) is passed **identically** on every
    resume call; this file does not itself decrement or track remaining budget across
    resumes — cumulative-budget accounting is entirely the callee's (checkpoint-carried)
    responsibility (`intrinsicStrictDecoder.ts`, out of this cluster).
- After the loop, on failure (`:313-332`):
  - If the error is `IrregularNfpIfpControlAbortError` with `reason === 'cancelled'`
    (`:315-317`), the **entire** direct-role `for` loop is aborted by re-raising the same
    error object via `Effect.fail` (`:318`) — remaining, not-yet-attempted direct roles never
    run.
  - Otherwise (deadline-abort or any other typed failure), a run record is pushed
    (`:320-330`) with `status: 'deadline'` (any `IrregularNfpIfpControlAbortError` that is
    not `'cancelled'`, i.e. a deadline abort) or `'invalid'` (any other error tag), and the
    `for` loop `continue`s to the next role. `runtimeMs` here is wall-clock
    `Math.max(0, performance.now() - startedAt)` spanning the *whole* per-role resume
    sequence, not the constructor's own cumulative active-runtime ledger.
- On success (`:333-348`): if the state is exactly-complete with zero truncation
  (`truncationReason === undefined && remainingPreparedPieces.length===0 &&
  unplacedPieceIds.length===0`, `:333-337`), `options.onDirectConstructed?.(role, state)`
  fires — production wires this to `prefixSources.push({role, state})`
  (`computeIrregularNesting.ts:707-709`), feeding capacity mode's warm-prefix lanes. Then
  `normalizeIntrinsicSharedArchiveConstructedRun` builds the final run record
  (`:340-348`), using `outcome.constructed.runtimeMs` (the constructor's own measurement,
  **not** `performance.now() - startedAt`) — an asymmetry with the failure branch above.

**`retainRankedSharedArchive` (`:355-380`)** — local `rankedByHash = new Map()` (`:358`),
cleared and repopulated exactly once inside the `rank` callback passed to
`retainIntrinsicAnytimeArchiveNamespace` (`:367-370`). Because `retainIntrinsicAnytimeArchiveNamespace`
calls `policy.rank(...)` exactly once (`intrinsicAnytimeArchive.ts:47`), the `.clear()` call
at `:367` is defensive and never actually clears a non-empty map in this call graph — it is
dead-but-harmless. `rankedByHash` is a pure lookup aid (keyed by
`sheetlessCanonicalGeometryHash`, looked up by `metrics.canonicalGeometryHash` — safe only
because `validate` at `:363-364` already enforced `sheetlessCanonicalGeometryHash ===
metrics.canonicalGeometryHash` for every surviving endpoint); its own Map iteration order is
never consumed (final order comes from `rankIntrinsicStrictCompletedLayouts`, see §5).

**Repeated invocation of `retainRankedSharedArchive` on already-deduplicated input.**
Production calls this function up to **three times** in sequence with accumulating input:
1. `runIntrinsicSharedArchivePortfolio:212` — first pass over
   `[...directRuns, ...periodicRuns]` endpoints (`:209-211`), producing `sheetlessArchive`.
2. `computeIrregularNesting.ts:801-803` — `retainRankedSharedArchive(archive.sheetlessArchive)`,
   re-running dedup+rank over an array whose hashes are already unique. This is a no-op for
   deduplication (each hash occurs once) and should be idempotent for ranking (deterministic
   function of the same input set), but it is a real second invocation, not a cached read —
   any Rust port that memoizes rank output across these two call sites would diverge from the
   literal two-call chronology unless proven behaviorally identical.
3. `computeIrregularNesting.ts:934-937` — `retainRankedSharedArchive([...protectedSheetlessArchive,
   ...focusedReconstructionEndpoints])`, this time genuinely merging in 0 or 1 additional
   endpoints from the optional focused-reconstruction producer
   (`computeIrregularNesting.ts:809-932`, gated by `focusedCompleteReconstructionEnabled`).

**`requestedSheetFit` (`:672-725`)** — pure function of `(sheet, state)`, no persisted state.
Computes `fit(0)` and `fit(90)` **unconditionally, both, always** (`:704-705`, no
short-circuit even if `q0` already fits). Each `fit(rotationDeg)` call:
1. `state.withQuarterTurnBottomLeft(rotationDeg)` (`irregularBeamState.ts:379-465`) — for
   `rotationDeg===0` this delegates to `withBottomLeftAnchored()` (`:382`, operating on the
   original un-rotated `state`); for `90` it rotates every placed piece's world points by 90°
   and re-derives bounds directly from the *original* `state` (not from the `q0` result) —
   the two orientations are independently derived from the same source state, not chained.
2. Legality check via `assertCanonicalGridLegalLayout(sheet, oriented.placedCollisionGeometries)`
   (`:685`); on failure, returns `{fits:false, canonicalGeometryHash:undefined,
   placedCollisionGeometries:[]}`.
3. On success, `canonicalCollisionLayoutIdentity` (`canonicalLayoutGeometry.ts:139-150`) and
   `sha256(...).digest('hex')` (`:699`).
Both `q0`/`q90` full placed-geometry arrays are always materialized even though only the
*selected* one survives in the returned `IntrinsicSharedArchiveSheetFit` — the losing
orientation's `placedCollisionGeometries` are computed then discarded (`:718-724`).

## 5. Ordering sources

1. `INTRINSIC_SHARED_ARCHIVE_DIRECT_ROLES` (`:41-45`) — fixed array literal
   `['canonical-grid', 'legacy-absolute-envelope', 'open-pocket-first']`, iterated in that
   order at `:261`. This order determines (a) which role's checkpoint the scheduler
   interleaves with, and (b) "first producer ownership" in duplicate resolution below.
2. `[...directRuns, ...periodicRuns].flatMap(...)` (`:209-211`) — direct-role endpoints
   always precede periodic-continuation endpoints in the array fed to
   `retainRankedSharedArchive`. Within `periodicRuns`, order is
   `periodicPortfolio.runs.map(...)` (`:206-208`), i.e. whatever order
   `runIntrinsicPeriodicFamilyPortfolio` returns its `runs` array in
   (`intrinsicPeriodicFamilyPortfolio.ts:146`) — external to this cluster.
3. **`unique = new Map<string, Endpoint>()`** in `retainIntrinsicAnytimeArchiveNamespace`
   (`intrinsicAnytimeArchive.ts:33-48`) — insertion order is **first-occurrence order** in
   the input `policy.endpoints` array (`:37`, `for (const endpoint of policy.endpoints)`).
   Critically, `Map.set` on an **already-present key** updates the value in place without
   moving its position in iteration order (this is JS `Map` semantics, not an assumption) —
   so `[...unique.values()]` (`:47`) yields values ordered by *first* occurrence of each
   identity, regardless of how many times that identity's value was later replaced by
   `selectDuplicate`. **Port hazard:** a Rust `HashMap`/`IndexMap` port must replicate
   "insert-or-update-value-without-moving-position"; `indexmap::IndexMap::insert` on an
   existing key does preserve position (matches), but a naive `remove`+`insert` pattern would
   not.
4. **"First producer ownership" duplicate resolution.** `retainRankedSharedArchive`'s
   `selectDuplicate: (first) => first` (`:365`) means that when two endpoints share the same
   `sheetlessCanonicalGeometryHash`, the one encountered **earlier** in the combined
   `endpoints` array (per items 1-2 above) is retained verbatim (including its `role`,
   `sourceId`, `runtimeMs`). Since geometry-derived fields (`metrics`, `certificate`,
   `requestedSheetFit`) are identical for identical-hash endpoints, this only changes
   *diagnostic* fields (`role` in particular appears in the final selection message,
   `computeIrregularNesting.ts:1043`) — not selected geometry. This matches the research
   doc's Stage 5 description of "first-producer ownership"
   (`docs/research/intrinsic-anytime-portfolio.md:613`).
5. `[...unique.values()]` is then passed to `rankIntrinsicStrictCompletedLayouts`
   (`intrinsicSharedArchivePortfolio.ts:371`, defined `intrinsicStrictDecoder.ts:2284-2288`
   → `rankIntrinsicStrictParetoPartition:2290-2319`), whose output order is what actually
   determines `sheetlessArchive`'s final order (mapped back through `rankedByHash`,
   `:372-376`). This is a repeated Pareto-front-peel-and-order algorithm
   (`intrinsicStrictDecoder.ts:2290-2343`): each round computes the current non-dominated
   frontier (dominance test = `intrinsicStrictGeometricObjectives` = [compactness,
   void-topology] only, `:2230-2233, 2254-2261`), orders that frontier via
   `orderIntrinsicStrictParetoFront` (`:2321-2343`, a three-objective **round-robin** pick:
   repeatedly take-best-by-compactness, remove, take-best-by-void-topology-among-remainder,
   remove, take-best-by-contact-among-remainder, remove, repeat until the frontier is
   exhausted — objectives at `:2235-2239`, tie-break always
   `canonicalGeometryHash.localeCompare` at `:2332`), appends it, removes those members, and
   repeats on the remaining non-frontier layouts; if ever no frontier exists (defensive/
   should not happen for a finite antisymmetric partial order) the remainder is appended
   sorted purely by `canonicalGeometryHash.localeCompare` (`:2306-2309`). This machinery is
   **out of this cluster** (belongs to the `intrinsic-strict-decoder` characterization) but
   is load-bearing for `sheetlessArchive`/`archive` order; the Rust port must reproduce it
   exactly since it is a genuine, non-trivial ordering algorithm, not a simple sort.
6. `.toSorted(compareIntrinsicSharedArchiveWinner)` (`:404`) — `Array.prototype.toSorted`
   (ES2023, confirmed available: `tsconfig.node.json` targets `lib: ["ES2023"]`, `package.json`
   requires Node `>=24.11.0`). Per spec, `Array.prototype.sort`/`toSorted` has been
   **required stable** since ES2019; take `[0]` as winner.
7. `.toSorted((first,second) => hash.localeCompare(...) || rotationDeg - rotationDeg)`
   (`requestedSheetFit:713-717`) — also stable, take `[0]`.
8. `selectFittingSharedArchive` (`:383-389`) — plain `.filter`, preserves incoming order
   exactly (no reordering).
9. `geometricFrontHashes = new Set(...)` (`:395-399`) in `selectIntrinsicSharedArchiveWinner`
   — used **only** for `.has()` membership testing at `:402`; its iteration order is never
   read. This is *not* an ordering hazard despite being a `Set`.
10. `canonicalCollisionLayoutIdentity` (`canonicalLayoutGeometry.ts:139-150`) internally uses
    plain `.toSorted()` with **no comparator** (`:149`) — default JS sort converts elements to
    strings and compares by UTF-16 code unit, which is a **different comparison mechanism**
    from `.localeCompare()` used everywhere in this cluster's own comparators (item 6, 7, and
    `orderIntrinsicStrictParetoFront`'s tie-break). For the lowercase-hex-ASCII strings
    actually compared in both places, code-unit order and default-locale `localeCompare` order
    coincide, but they are not the same operation and must both be reproduced faithfully (see
    §12).

## 6. Comparators and tie rules

All comparators in `intrinsicSharedArchivePortfolio.ts` are **ascending / ties by falling
through**, i.e. `sort(...)` puts the *smallest* (least waste) endpoint first and `[0]` is
taken as the winner. There is no "descending" comparator in this file (unlike some
comparators in `intrinsicStrictDecoder.ts`, which are not part of this cluster).

### `compareIntrinsicSharedArchiveWinner(first, second)` — `:407-418`

```
compareCertificateDeficit(first, second)
  || (first.metrics.enclosedCavityCount - second.metrics.enclosedCavityCount)
  || compareLargestHullGap(first, second)
  || compareEnvelope(first, second)
  || first.sheetlessCanonicalGeometryHash.localeCompare(second.sheetlessCanonicalGeometryHash)
```

Precedence, in order: certificate deficit → cavity count → largest hull-gap ratio →
envelope (area, then max side, then span) → hash string as final deterministic tie-break.
Used only inside `selectIntrinsicSharedArchiveWinner`, and only among endpoints already
restricted to the geometric Pareto front (see below) — it is never applied to the *whole*
archive.

### `compareBigIntAscending(first, second)` — `:420-422`

`first === second ? 0 : first < second ? -1 : 1` — trivial 3-way BigInt comparator, reused by
all three comparators below.

### `compareCertificateDeficit(first, second)` — `:424-441`

If **both** endpoints have `certificate.exactRelativeDeficitNumerator` and
`...Denominator` defined (decimal-string-encoded BigInt fractions from
`evaluateIntrinsicStrictCertificate`, `intrinsicStrictDecoder.ts:2006-2016`), compares exactly
via cross-multiplication:
`compareBigIntAscending(BigInt(firstNum)*BigInt(secondDen), BigInt(secondNum)*BigInt(firstDen))`
(`:436-439`). Denominators are always `>= 1` by construction of `normalizedFraction`/`cappedDeficit`
(`intrinsicStrictDecoder.ts:2036-2057`), so cross-multiplication ordering is valid (no sign
flip needed). **Fallback** (either side's exact fraction is `undefined`): plain float
subtraction `first.certificate.relativeDeficitSum - second.certificate.relativeDeficitSum`
(`:440`). Per §3/§7, the exact branch is what production always takes.

### `compareLargestHullGap(first, second)` — `:443-456`

If both `metrics.exact` are defined: cross-multiplied ratio comparison of
`largestOccupiedHullGapDoubledAreaGrid2 / occupiedHullDoubledAreaGrid2` (ascending — smaller
gap ratio wins), all four terms `BigInt(...)` from grid-area strings (`:448-453`). Fallback:
`first.metrics.largestOccupiedHullGapRatio - second.metrics.largestOccupiedHullGapRatio`
(float, `:454-455`).

### `compareEnvelope(first, second)` — `:458-473`

If both `metrics.exact` are defined (`:462`):
```
compareBigIntAscending(BigInt(envelopeAreaGrid2_a), BigInt(envelopeAreaGrid2_b))
  || (envelopeMaximumSideGrid_a - envelopeMaximumSideGrid_b)   // plain number subtraction
  || (envelopeSpanGrid_a - envelopeSpanGrid_b)                  // plain number subtraction
```
(`:463-469`). Note the **mixed representation**: area is BigInt (string-encoded, since grid²
areas can approach/exceed safe-integer range on large sheets), while the two linear grid
measurements (`envelopeMaximumSideGrid`, `envelopeSpanGrid`, both plain `number` per
`intrinsicStrictDecoder.ts:129,131`) are compared with ordinary JS number subtraction because
they are integer grid lengths that stay well inside `Number.MAX_SAFE_INTEGER` even for large
sheets. Fallback (float mm fields): same three-term chain using `envelopeAreaMm2`,
`envelopeMaximumSideMm`, `envelopeSpanMm` (`:470-472`).

### Pareto-front gating before the above comparator applies — `selectIntrinsicSharedArchiveWinner` (`:392-405`)

```
geometricFrontHashes = Set(selectIntrinsicStrictCompletedParetoFront(archive metrics).map(hash))
archive.filter(e => geometricFrontHashes.has(e.sheetlessCanonicalGeometryHash))
       .toSorted(compareIntrinsicSharedArchiveWinner)[0]
```
The doc comment at `:391` states the intent precisely: "Selects one cohesive winner without
allowing contact to veto geometric dominance." `selectIntrinsicStrictCompletedParetoFront`
(`intrinsicStrictDecoder.ts:2271-2281`) filters to layouts not dominated by any other on the
**two**-objective dominance test (compactness, void-topology — contact is explicitly excluded
from the dominance/filter step, only used for within-front *ordering* which this caller
discards since it only needs the resulting hash set). This means: an endpoint can never win
if some other archived endpoint strictly dominates it on both envelope-compactness and
cavity/hull-gap/waste axes simultaneously, **regardless of certificate/contact quality** —
confirmed by `tests/unit/intrinsicSharedArchivePortfolio.test.ts:149-173` ("does not let a
cohesion certificate rescue geometrically dominated geometry").

### `requestedSheetFit`'s q0/q90 selection tie-break — `:713-717`

```
[q0, q90].filter(fits && hash !== undefined)
          .toSorted((a,b) => a.canonicalGeometryHash.localeCompare(b.canonicalGeometryHash)
                             || a.rotationDeg - b.rotationDeg)[0]
```
Literal precedence is **hash first, rotation second**. However, by construction of
`canonicalCollisionLayoutIdentity` (`canonicalLayoutGeometry.ts:139-150`,
`identityAtQuarterTurn:592-611`), the identity of a layout is invariant under both whole
90°-multiple rotation and translation: `identityAtQuarterTurn` re-derives `minX`/`minY` from
the rotated point set itself (`:600-608`), so it does not matter what absolute translation
the caller's points started at, and `canonicalCollisionLayoutIdentity` takes the **minimum**
identity string over all four rotations {0°,90°,180°,270°} of whatever polygon set it is
given (`:144-149`). Since `q90`'s placed geometry is exactly `q0`'s placed geometry rotated
rigidly by one further 90° (both are independently derived from the *same* source `state` —
see §4 — but the rotation composition is associative on exact integer grid quarter-turns), the
four-rotation identity **sets** compared for `q0` and `q90` are the same four strings (cyclic
relabeling), so their minimum — and therefore `canonicalGeometryHash` — is **provably always
equal whenever both orientations fit**. The practical, derived rule is therefore "prefer
`rotationDeg 0` whenever it legally fits; fall back to `90` only when `0` does not fit." The
code as written still performs the hash comparison first; **a Rust port must implement the
literal two-key comparator, not the simplified derived rule**, both because behavioral
equivalence here rests on an unverified cross-file invariant (see §15) and because the
migration prompt (§2) forbids behavior simplification without differential proof.

### `orderIntrinsicStrictParetoFront`'s internal tie-breaks (dependency, not owned by this cluster)

Every sort inside `intrinsicStrictDecoder.ts`'s ranking machinery that this cluster calls
(`rankIntrinsicStrictCompletedLayouts`, `selectIntrinsicStrictCompletedParetoFront`) ultimately
breaks ties via `canonicalGeometryHash.localeCompare` (`intrinsicStrictDecoder.ts:2307,
2332`). Same `.localeCompare` hazard as noted in §5/§12.

## 7. Numeric semantics

### `intrinsicAnytimeArchive.ts`

None. No `Math.*`, `Number.*`, `BigInt`, or arithmetic of any kind — the file is pure
generic Map/array plumbing over caller-supplied comparator/validator closures.

### `intrinsicSharedArchivePortfolio.ts`

- **`Math.max`**: exactly one call, `Math.max(0, performance.now() - startedAt)` (`:329`) —
  clamps a wall-clock delta to non-negative (defensive against clock anomalies), used only on
  the direct-role failure branch (see §4's runtime-measurement asymmetry).
- **`performance.now()`**: `:262` (per-role start) and `:329` (failure-branch elapsed). Both
  are non-deterministic wall-clock reads; per the migration prompt §11, these must be
  reproduced via an injectable deterministic clock seam for differential byte tests, and
  compared only as measurements (not parity fields) against real clocks.
- **BigInt usage** — exactly four call sites, all inside the three winner comparators
  (§6): `compareBigIntAscending` (`:420-422`), and its use in `compareCertificateDeficit`
  (`:436-439`), `compareLargestHullGap` (`:448-453`), `compareEnvelope` (`:463-465`). All
  BigInt inputs are `BigInt(stringValue)` conversions from decimal-string-encoded exact grid
  quantities (`envelopeAreaGrid2: string`, `largestOccupiedHullGapDoubledAreaGrid2: string`,
  `occupiedHullDoubledAreaGrid2: string`, `exactRelativeDeficitNumerator/Denominator:
  string`) — never raw `number`→BigInt conversion, so there is no floating-point-to-BigInt
  precision loss at these call sites. All BigInt comparisons are cross-multiplication of two
  non-negative fractions (denominators always `>=1`) — sign is never negative on either side
  by construction, so the ascending compare is a plain magnitude comparison with no special
  negative-zero or sign handling required.
- **Plain `number` subtraction used as an integer comparator** in three places, all relying
  on the operands being exact, safely-bounded integers even though typed `number`:
  `enclosedCavityCount - enclosedCavityCount` (`:413`, small integer piece/cavity count),
  `envelopeMaximumSideGrid - envelopeMaximumSideGrid` and `envelopeSpanGrid - envelopeSpanGrid`
  (`:467-469`, integer grid-length units — bounded by sheet size in 0.001 mm grid units, e.g.
  a 10 m sheet is 10,000,000 grid units, far under `2^53`). A Rust port should use a checked
  or sufficiently wide signed integer type (`i64`) for these subtractions, matching "exact
  integer authority" (migration prompt §8.2) even though the TS source uses `number` — the
  actual *values* are always integers.
- **No `NaN`/`Infinity`/safe-integer guard exists in this file directly.** Finiteness is
  enforced upstream, once, in `completedMetrics`'s validation pass
  (`intrinsicStrictDecoder.ts:1925-1933`, `Number.isFinite` / non-empty-string checks) before
  a metrics object ever reaches this cluster. This cluster trusts that invariant and performs
  no redundant checks — a Rust port may choose to assert it defensively at the boundary but
  must not change control flow if the assertion is absent from the TS source.
- **No signed-zero handling** appears in this cluster (no code path here constructs or
  normalizes `-0`); ring/translation signed-zero normalization is owned by
  `canonicalLayoutGeometry.ts`/`irregularBeamState.ts` (out of scope here, e.g.
  `placedCollisionWorldGridPath`'s `x === 0 ? 0 : x` normalization at
  `canonicalLayoutGeometry.ts:100-101`, which this cluster depends on transitively through
  `canonicalCollisionLayoutIdentity`).
- **`toGridMm`, grid conversion**: not called directly in either target file; consumed
  transitively via `assertCanonicalGridLegalLayout`/`canonicalCollisionLayoutIdentity`
  (out of scope, `canonicalLayoutGeometry.ts`).

## 8. Serialization and hashing

- **One hash site in the entire cluster**: `createHash('sha256').update(identity).digest('hex')`
  at `:699` inside `requestedSheetFit`, hashing the `identity: string` returned by
  `canonicalCollisionLayoutIdentity`. `crypto.Hash.update(string)` with no explicit encoding
  argument uses Node's default `'utf8'` encoding — the identity string (built from
  ASCII digit/comma/semicolon-separated grid coordinates per
  `canonicalLayoutGeometry.ts:606-630`) round-trips through UTF-8 byte-identically to ASCII,
  but a Rust port must hash the *exact same UTF-8 bytes* of the *exact same identity string*,
  not merely "an equivalent hash of equivalent data" — the identity string's exact character
  content (separators, digit rendering) is itself owned by `canonicalLayoutGeometry.ts` (out
  of this cluster) and must be reproduced byte-for-byte first.
- `sheetlessCanonicalGeometryHash`/`canonicalGeometryHash` on `IntrinsicSharedArchiveEndpoint`/
  `IntrinsicStrictCompletedMetrics` are **not** computed in this cluster — they arrive
  pre-computed from `measureIntrinsicSheetlessCompletedLayout`
  (`intrinsicStrictDecoder.ts:1842`), also `createHash('sha256').update(identity).digest('hex')`,
  same pattern.
- `.digest('hex')` always yields a **lowercase** hex string — relevant to §6/§12's
  `.localeCompare` discussion (no case-folding concerns).
- **No `JSON.stringify` anywhere in either target file** (verified by grep). No custom
  canonical encoder, no BigInt-to-string encoding, no checkpoint byte assembly happens in
  this cluster — all of that is owned by `intrinsicStrictDecoder.ts`'s checkpoint
  machinery and `canonicalLayoutGeometry.ts`'s identity builder, both out of scope here.
  This cluster only *consumes* already-encoded decimal-string BigInt fields
  (`envelopeAreaGrid2`, `exactRelativeDeficitNumerator`, etc.) via `BigInt(stringValue)`.

## 9. Caches touched and the exact historical access sequence

This cluster owns **no** NFP/IFP/geometry cache and no persistent, cross-call, TTL/eviction
cache. Its only Map-based structures are request-scoped, single-use dedup/lookup tables that
are built and discarded within one function call:

- `unique: Map<string, Endpoint>` in `retainIntrinsicAnytimeArchiveNamespace`
  (`intrinsicAnytimeArchive.ts:36`) — populated once by iterating the input array in order,
  read once via `[...unique.values()]`, then goes out of scope. No stale-eviction, no
  invalidation, no cross-call reuse. This is a deduplication accumulator, not a cache in the
  migration prompt §13 sense.
- `rankedByHash: Map<string, IntrinsicSharedArchiveEndpoint>`
  (`intrinsicSharedArchivePortfolio.ts:358`) — same lifecycle, purely a lookup aid within one
  `retainRankedSharedArchive` call (§4).
- `geometricFrontHashes: Set<string>` (`:395`) — same lifecycle, membership-only, within one
  `selectIntrinsicSharedArchiveWinner` call.

The "historical access sequence" the migration prompt §13.2 asks to preserve (NFP validation
→ key → lookup → stale-eviction → recompute → publish) belongs to the NFP/IFP service cluster,
not this one. This cluster's own "access sequence" is simpler and fully described in §4: build
`unique` in input order → validate/identity/dedup inline during the same pass → rank once →
return. There is no read-then-write race window inside this cluster because everything here
runs single-threaded, synchronously, within one `Effect.gen` step per call.

## 10. Cancellation / deadline / budget / evaluation-cap observation points

Neither file directly calls `control.checkpoint(...)`, reads a deadline clock, or checks a
cancellation flag. Both files are **purely reactive** to typed failures propagated from
callees:

- `intrinsicSharedArchivePortfolio.ts:276-303` (`Effect.matchEffect` around
  `constructIntrinsicStrictState`) — the only place a cancellation/deadline signal is
  observed, and only *after* the callee's own internal checkpoint call has already fired and
  failed. This file cannot pre-empt a callee mid-computation; it can only react once the
  callee returns.
- The single cancellation check that has cluster-visible control-flow effect is the tag/reason
  test at `:315-317` (abort the whole direct-role loop on `reason === 'cancelled'`, continue
  to the next role on `reason === 'deadline'` or any other typed error) — see §4 for full
  detail.
- `maximumDirectRuntimeMs` (a *budget*, not an active check) is passed unchanged into every
  resume call (`:283`) — this file performs no budget arithmetic itself.
- `INTRINSIC_SHARED_ARCHIVE_PERIODIC_EVALUATION_CAP`/`_CONTINUATION_COUNT` (`:46-47`) are
  forwarded as fixed options into `runIntrinsicPeriodicFamilyPortfolio` (`:197-199`) — again,
  this cluster does not itself enforce or check these caps; it only sets the ceiling and later
  interprets the callee's resulting status (`'evaluation-cap'`, `normalizePeriodicRun:661-662`).
- No cancellation/deadline check exists inside `retainIntrinsicAnytimeArchiveNamespace`,
  `retainRankedSharedArchive`, `selectFittingSharedArchive`, or `selectIntrinsicSharedArchiveWinner`
  — these are pure, unbounded-only-by-input-size synchronous functions with no loop that
  could run long enough to need one (bounded by archive size, which is itself bounded by the
  small, fixed set of direct + periodic runs).

## 11. Error paths

Neither file **constructs** a new tagged error class instance. Both only **propagate**
errors raised by callees, or **convert** a propagated failure into a non-throwing
`IntrinsicSharedArchiveRun` record with a `status` field.

- `SharedArchiveError` union (`:106-112`): `IntrinsicStrictDecoderError | IntrinsicCapacityError
  | IrregularNestingNotImplementedError | IrregularGeometryInputError |
  IrregularNfpIfpControlAbortError`. **`IntrinsicCapacityError` appears to be structurally
  unreachable from this cluster's actual call graph**: `constructIntrinsicStrictState`'s
  declared error channel is `IntrinsicStrictDecoderError | IrregularNestingNotImplementedError
  | IrregularGeometryInputError | IrregularNfpIfpControlAbortError`
  (`intrinsicStrictDecoder.ts:401-410`, no `IntrinsicCapacityError`), and
  `runIntrinsicPeriodicFamilyPortfolio`'s `PortfolioError` union
  (`intrinsicPeriodicFamilyPortfolio.ts:220-224`) likewise omits it. `IntrinsicCapacityError`
  is imported (`:39`) and named in the union purely for type-signature breadth; nothing in
  this cluster or its direct callees can actually produce one. `computeIrregularNesting.ts`'s
  `.pipe(Effect.mapError(...))` around the call (`:726-738`) still defensively handles the tag
  (mapping it via `mapIntrinsicCapacityError`), but that branch is dead code for calls
  originating from this cluster specifically (it is legitimately reachable from other,
  unrelated call sites of the same shared `mapIntrinsicCapacityError` helper).
- The **only** re-raise in this cluster: `return yield* Effect.fail(outcome.error)`
  (`:318`), forwarding the exact same `IrregularNfpIfpControlAbortError` object on
  `reason === 'cancelled'` — no wrapping, no message rewriting, no new context fields added.
- Every other failure is converted, never re-thrown, into a run record: `status: 'deadline'`
  or `'invalid'` (direct roles, `:320-330`); `status: 'evaluation-cap'`
  (`normalizeIntrinsicSharedArchiveConstructedRun:568-579`, when
  `truncationReason === 'maximum-candidate-evaluations'`); `status: 'incomplete'`
  (`:587-598`, when `makeIntrinsicSharedArchiveEndpoint` returns `undefined` — i.e. the
  constructed state still has unplaced pieces or remaining prepared pieces, `:618-624`, or
  measurement itself failed, `:625-626`); and for periodic runs, the four-way status mapping
  in `normalizePeriodicRun:653-669` (`'global-deadline'` / `'deadline'` / `'evaluation-cap'`
  pass through verbatim from `run.status`; anything else, including the legitimate decode
  statuses `'completed'|'incomplete'|'infeasible-final-sheet'` when `run.constructed` is
  `undefined`, collapses to `'invalid'`).
- **Production job-failing gate**: `intrinsicSharedArchiveProductionValid`
  (`:522-539`) is called at `computeIrregularNesting.ts:739`. If it returns `false`, the
  **entire** Compact/Compact-Short-Side nesting request fails with a newly constructed
  `IrregularPortfolioError({operation:'intrinsicSharedArchive', category:'search', message:
  [...]})` (`computeIrregularNesting.ts:741-761`) — this error class/construction is owned by
  `computeIrregularNesting.ts`, not this cluster, but the *gating predicate* is this
  cluster's. The predicate requires **all three** direct roles to be `status==='completed'`
  with a defined `endpoint` (`:525-527`) — i.e. if the fixed `35_000` ms per-role budget
  (§3) is exceeded by even one role across however many checkpoint/resume round-trips the
  scheduler drove it through, that role's status becomes `'deadline'`, `directValid` becomes
  `false`, and the whole nesting job fails rather than degrading. It additionally requires
  `intrinsicSharedPeriodicCatalogCoverageValid(catalog)` (`:530`, `catalog.runtimeCoverageComplete`
  and either no families or `familyCoverageComplete`, and every family's
  `cellCoverageComplete || sourceAuditCells !== undefined`, `:542-552`), and — only when
  `catalog.families.length > 0` — `periodicSelectionValid` (`:534`, itself requiring
  `catalogRuntimeCoverageComplete`, `selectedContinuationCount <=
  INTRINSIC_SHARED_ARCHIVE_PERIODIC_CONTINUATION_COUNT` (8), `runCount ===
  selectedContinuationCount`, `(continuationCoverageComplete ||
  selectedContinuationCount === 8)`, and `budgetSettlementComplete`, `:476-494`), and every
  periodic run status is `'completed'` or `'evaluation-cap'` (`:535-537`; a periodic
  `'deadline'`/`'global-deadline'`/`'invalid'` run also fails the whole job).
- `intrinsicSharedArchiveExperimentValid` (`:497-519`) is a **stricter** predicate (requires
  every direct role's `requestedCandidateEvaluations === consumedCandidateEvaluations`, which
  is never true in production since `requestedCandidateEvaluations` is always `undefined`
  there — see §3) computed into `experimentValid` but, per §1/§3, never consulted by
  production control flow. It exists purely for the `runIntrinsicSharedArchivePortfolio`
  standalone/test contract.

## 12. JS-specific semantics hazards for a Rust port

1. **`.localeCompare()` vs default `.toSorted()` (code-unit) string ordering.** This
   cluster's own comparators (`:404, 416, 713-717`) use `.localeCompare()`; the identity
   builder this cluster depends on (`canonicalLayoutGeometry.ts:149, 609, 627`) uses default
   `.toSorted()`/`<` (code-unit) comparison. Both operate exclusively on lowercase hex SHA-256
   digests or ASCII `"x,y"`/`"x,y;x,y;..."` coordinate strings in practice, where code-unit
   and default-locale collation coincide — but this must be **verified**, not assumed, per
   migration prompt §9 ("do not assume Rust byte ordering matches JavaScript UTF-16 or
   `localeCompare`"). A Rust port should use plain byte/ASCII ordering for both, and add a
   differential test asserting the two TS mechanisms never actually diverge on the string
   domains this cluster feeds them.
2. **Map insertion-order-preserving update semantics** (§5 item 3) — `retainIntrinsicAnytimeArchiveNamespace`'s
   dedup Map relies on JS's "update value, keep original position" behavior. Must use an
   order-preserving map (e.g. `indexmap::IndexMap`) with matching semantics, not a
   remove-then-reinsert pattern.
3. **Stable sort reliance.** `.toSorted()` (ES2023) inherits `Array.prototype.sort`'s
   ES2019+ stability guarantee; every comparator chain in this cluster that ends in `|| 0`
   implicitly (i.e. any two endpoints that compare fully equal on every explicit key) relies
   on stability to preserve prior array order as the final tie-break. In practice, this
   cluster's own comparators always end in an explicit hash-string tie-break (`:416, 715`) so
   true stability-dependent ties should be geometrically near-impossible (distinct hashes) —
   but `orderIntrinsicStrictParetoFront`'s per-round re-sorts (dependency, §5 item 5) are
   worth an explicit stability audit in that cluster's own doc.
4. **BigInt string round-tripping.** All exact BigInt comparisons here consume
   decimal-string fields (`envelopeAreaGrid2: string`, etc.) that were produced elsewhere via
   `bigint.toString()`. A Rust port must parse these with an arbitrary-precision or
   sufficiently wide integer type and must not silently truncate; the migration prompt §8.2
   requires proved overflow safety. This cluster performs only multiplication of two such
   BigInts per comparison (`:437-439, 449-452, 464-465`) — bound the products by the known
   grid-coordinate/area magnitude before choosing `i128` vs arbitrary precision in Rust.
5. **`Object.prototype.hasOwnProperty`-gated optional-field construction is *not* used by
   this cluster's own output types** (§3) — all of `IntrinsicSharedArchiveEndpoint`,
   `IntrinsicSharedArchiveRun`, `IntrinsicSharedArchivePortfolioResult` are always
   fully-populated plain object literals with explicit `undefined` values, never
   conditionally-omitted keys. This is a relief, not a hazard, for this cluster specifically
   — but the domain types it carries opaquely (`IrregularPlacement`, etc., `domain.ts:694-715`)
   *do* use the `hasOwnProperty`-gated pattern, which matters to whichever cluster owns their
   JSON/canonical encoding.
6. **`crypto.createHash(...).update(string)` default `'utf8'` encoding** (§8) — must be
   replicated exactly (UTF-8 byte encoding of the exact identity string) in Rust's SHA-256
   call.
7. **Closure-captured mutable state inside a single `rank` callback** (`:358-378`,
   `rankedByHash.clear()`/`.set()`) — harmless here (single-invocation, per §4) but is exactly
   the kind of pattern that would be a real hazard if `retainIntrinsicAnytimeArchiveNamespace`'s
   contract ever changed to call `rank` more than once; a Rust port choosing a closure/`FnMut`
   translation should preserve the "exactly once" invariant explicitly (e.g. via a comment or
   assertion) rather than relying on incidental single-call behavior.

## 13. Parallelism assessment

**Safe, pure, independent candidates for Rayon (subject to reduction back into the exact
serial order before any downstream comparison/selection):**

- `requestedSheetFit`'s `fit(0)` and `fit(90)` computations (`:704-705`) are fully independent
  pure reads of the same immutable `state` snapshot — no shared mutable state, no cache
  writes, no cancellation checks inside `fit`. Both are already computed unconditionally and
  serially today; running them concurrently and joining before the two-key sort at `:713-717`
  would not change the result, provided the final comparator is still applied deterministically
  to the two ordinals (`q0`, `q90`) in a fixed order, matching the migration prompt §14.3
  pattern.
- The three direct roles (`canonical-grid`, `legacy-absolute-envelope`, `open-pocket-first`)
  are tempting to parallelize but are **not** an uncontrolled-cohort-safe candidate as
  written: (a) `canonical-grid`'s per-piece-boundary checkpoint drives the interleaved
  capacity scheduler quantum via `onCanonicalGridCheckpointed`
  (`computeIrregularNesting.ts:650-703`) — a chronology-bound side effect that must remain
  logically serial relative to the capacity lane (migration prompt §14.2, "direct producer
  roles whose chronology affects scheduler traces"); (b) cancellation aborts the *entire*
  remaining role loop on `reason==='cancelled'` (`:315-318`), which is a sequential
  short-circuit that a naive parallel-then-join would not reproduce without extra
  coordination; (c) `requestedCandidateEvaluations` is always `undefined` in production so
  there is no per-role work-stealing benefit being left on the table by the current serial
  loop, but the *checkpoint interleaving* is a genuine, intentional, single-worker
  chronology contract (`docs/architecture/compact-architecture-explained.md:5-15`, "HARD
  CONSTRAINT: COMPACT IS SINGLE-PROCESS"). Any parallelization of the three direct roles
  would need to preserve the canonical-grid↔capacity-scheduler interleaving exactly, which is
  architecturally mandated to stay single-threaded per that document — do not parallelize
  this loop without an explicit new user instruction lifting that constraint.
- `retainRankedSharedArchive`'s per-endpoint `validate`/`identity` closures (`:363-364, :362`)
  are pure per-element and could be computed in parallel *before* the strictly-serial Map
  insertion pass (which must stay serial to preserve first-occurrence order, §5/§12 item 2) —
  i.e. a map-then-serially-insert pattern, matching migration prompt §14.3's deterministic
  parallel pattern (assign stable ordinals, evaluate in parallel, then insert/reduce serially
  in original order).

**Chronology-bound, must stay logically serial:**

- The `while (true)` checkpoint/resume loop in `runIntrinsicSharedArchiveDirectPortfolio`
  (`:275-312`) — each iteration depends on the previous iteration's `checkpoint`, and the
  `onCanonicalGridCheckpointed` side effect is itself a scheduler-chronology trigger.
- The `for (const role of ...)` loop's early-abort-on-cancellation (`:261, 315-318`) and its
  sequential fallback-continue-on-deadline (`:320-331`) — order-dependent control flow, not a
  reduction.
- `retainIntrinsicAnytimeArchiveNamespace`'s Map insertion pass (`:37-46`) — must stay serial
  in input order because both "first occurrence wins position" and "`selectDuplicate`'s
  `retained` vs `candidate` argument order" (`:44`) depend on encounter order.
- The three sequential `retainRankedSharedArchive` invocations across
  `runIntrinsicSharedArchivePortfolio`/`computeIrregularNesting.ts` (§4) are themselves
  ordered relative to the focused-reconstruction producer's completion — not parallelizable
  across each other without proving the merge is associative/order-independent (it likely is,
  since final rank is a pure function of the endpoint *set*, but this was not proven here and
  should be a differential-test target rather than an assumed-safe Rust optimization).
- Archive admission / winner selection itself, per migration prompt §14.2 ("archive admission
  as tasks finish", "survivor selection as candidates finish") — this cluster's dedup/rank/
  select functions must be run only after their full input array is fully assembled in the
  exact serial order described in §5, never incrementally as direct/periodic runs complete.

## 14. Tests and gates covering this cluster

Direct unit tests (found via `grep -rl` over `tests/`):

- `tests/unit/intrinsicSharedArchivePortfolio.test.ts` (393 lines) — exercises
  `retainRankedSharedArchive` (dedup-by-hash-keeps-role-of-first-encounter, `:63-76`;
  sheetless rank independent of sheet fit, `:78-96`), `selectIntrinsicSharedArchiveWinner`
  (Pareto-front-first-then-certificate-deficit selection, `:98-147`; dominance not rescued by
  certificate, `:149-173`), `normalizeIntrinsicSharedArchiveConstructedRun`
  (evaluation-cap and incomplete-endpoint exclusion, `:175-220`),
  `intrinsicSharedPeriodicSelectionValid` (six cases, `:222-276`),
  `intrinsicSharedArchiveExperimentValid` (three cases, `:278-336`),
  `intrinsicSharedPeriodicCatalogCoverageValid` (two cases, `:338-392`).
  **Coverage gap**: every synthetic `metrics(...)` object built by this test file's own
  helper (`:17-38`) omits the `exact` field entirely, so this file's comparator tests
  exercise **only the float-fallback branches** of `compareCertificateDeficit`,
  `compareLargestHullGap`, `compareEnvelope` (§3/§6/§7) — the BigInt-exact branches, which are
  the branches production actually always takes, have **no direct unit coverage** in this
  file. They are presumably exercised indirectly by the full-pipeline gates below (real
  geometry always populates `exact`), but there is no unit-level differential guarantee. A
  Rust port's differential harness should add explicit BigInt-path unit fixtures for these
  three comparators that this TS suite currently lacks.
- `tests/unit/intrinsicAnytimeArchive.test.ts` (50 lines) — exercises
  `retainIntrinsicAnytimeArchiveNamespace` (dedup + invalid-rejection + custom rank, `:15-35`)
  and `selectIntrinsicAnytimeSettledEndpoint` (complete-over-partial dominance,
  partial-when-complete-empty, `:37-49`) — the **only** place `selectIntrinsicAnytimeSettledEndpoint`
  is exercised at all (§1).
- `tests/unit/intrinsicSharedArchiveAdmission.test.ts` (52 lines) — exercises eligibility
  gating (`isIntrinsicSharedArchiveEligible`) and `portfolioProgressForDecodeRole`, both
  defined in `computeIrregularNesting.ts` (not this cluster), but directly establishes the
  production-eligibility facts cited in §1.
- `tests/unit/intrinsicCapacityMode.test.ts:56` imports from
  `intrinsicSharedArchivePortfolio.ts` (type-only import of `IntrinsicSharedArchiveEndpoint`
  per file content around that import) — capacity-mode tests share this cluster's endpoint
  type but do not exercise this cluster's functions directly.
- `tests/unit/intrinsicShortSideObserver.test.ts:21` also imports
  `IntrinsicSharedArchiveEndpoint` type-only.

Non-test coverage:

- `scripts/irregular-intrinsic-shared-archive.ts` — a standalone provenance/measurement CLI
  script (imports `INTRINSIC_SHARED_ARCHIVE_DIRECT_ROLES`, `makeIntrinsicSharedArchiveEndpoint`,
  `normalizeIntrinsicSharedArchiveConstructedRun`, `retainRankedSharedArchive`,
  `runIntrinsicSharedArchiveDirectPortfolio`, `runIntrinsicSharedArchivePortfolio`,
  `selectFittingSharedArchive`, `selectIntrinsicSharedArchiveWinner` directly, `:24-33`),
  producing immutable SVG/hash/manifest reports referenced throughout
  `docs/research/intrinsic-anytime-portfolio.md`. **Not wired into `package.json` scripts**
  (verified: no `"gate:...intrinsic-shared-archive..."` entry exists) — it is a manual
  research tool, not an automated CI gate.
- End-to-end production gates that exercise this cluster **indirectly**, by running the whole
  Compact pipeline through `computeIrregularNesting.ts` (`package.json:32-35`):
  `gate:mixed61-compact` (fixed expected canonical SHA-256, area, cavity, and elapsed-time
  ceiling), `gate:compact-nine-baselines` (`scripts/irregular-compact-nine-baselines.ts`),
  `gate:capacity` / `gate:capacity:production` (`scripts/irregular-capacity-gate.ts`, strict
  paired). None of these are cluster-scoped unit tests, but any Rust-port regression in this
  cluster's dedup/rank/winner-selection logic would very likely be caught by these gates
  since they assert exact canonical hashes end-to-end.

## 15. Open questions and ambiguities

1. **`selectIntrinsicAnytimeSettledEndpoint` vs. the hand-rolled dominance check in
   `computeIrregularNesting.ts:959`.** `intrinsicAnytimeArchive.ts` ships a generic helper
   whose entire purpose (per its own docstring, `:50-54`) is to express "complete beats
   partial unless complete is empty" — the exact rule the migration prompt calls
   "complete-over-capacity authority." Production never calls it; it re-implements the same
   rule ad hoc (`if (winner === undefined) { …capacity… } else { …winner… }`). **Before
   porting**, the orchestrator should decide and record: (a) is this duplication intentional
   (e.g. the generic helper is aspirational/for a future generic namespace merge, and the
   concrete coordinator intentionally special-cases it for reasons not visible in this
   cluster, such as needing side-channel diagnostics unavailable to the generic form), or (b)
   is it accidental drift that the Rust port should still faithfully reproduce as two
   independently-written call sites (safest, least risk of silently changing behavior) rather
   than consolidating into one call to a generic dominance function. Given migration prompt
   §2's "do not change... complete-over-capacity authority" and the instruction to treat
   TypeScript as the spec including its oddities, the safe default is **(b)**: port both call
   sites as literally separate implementations, and only unify them in Rust if a differential
   proof of equivalence is produced and explicitly accepted.
2. **`requestedSheetFit`'s q0/q90 hash-tie invariant (§6).** This document derives, from
   `canonicalCollisionLayoutIdentity`'s rotation/translation-invariance, that `q0` and `q90`
   always share the same `canonicalGeometryHash` whenever both fit, making the literal
   hash-first comparator degenerate to "prefer rotationDeg 0." This should be confirmed with
   a targeted property/differential test (construct a layout that fits both `q0` and `q90`
   and assert the two hashes are equal) before the Rust port relies on it for anything beyond
   defensive assertions — and even then, the literal two-key comparator must still be what
   ships, not the derived shortcut.
3. **`IntrinsicCapacityError` in `SharedArchiveError` (§11).** Confirmed unreachable from
   this cluster's actual callees given their current type signatures. Should the Rust port's
   error enum for this module include an unreachable variant for API-shape parity, or should
   it be dropped with an explicit note that it was vestigial? This is a documentation/type
   hygiene question, not a behavior question — flag for the orchestrator's ruling per
   migration prompt §2's "error codes or error provenance" preservation clause.
4. **Repeated `retainRankedSharedArchive` invocations (§4) — is the third pass's merge
   provably order/associativity-safe?** The three sequential calls (`runIntrinsicSharedArchivePortfolio:212`,
   `computeIrregularNesting.ts:801`, `computeIrregularNesting.ts:934`) were not proven here to
   be equivalent to a single combined pass; they are simply what the source code literally
   does, three times, with accumulating input. The Rust port must call the equivalent
   function three times in the same places with the same accumulating inputs, not "optimize"
   to one call, unless a differential test proves the collapse is behavior-preserving (per
   migration prompt §2, cache-hit-vs-recompute must return the same canonical value, but this
   is not a cache — it is a literal triple invocation in the source and should be preserved
   as such absent explicit approval to consolidate).
5. **Direct-role wall-clock budget failure mode (§11).** `intrinsicSharedArchiveProductionValid`
   fails the *entire* nesting job if any one of the three direct roles cannot complete within
   its (currently `35_000` ms) budget across however many scheduler-interleaved resumes it
   takes. This is existing, intentional TS behavior (not a bug to fix), but it is a
   consequential fact for Rust port performance-regression risk: if the Rust port's
   canonical-grid/legacy-absolute-envelope/open-pocket-first constructors are *slower* than
   TS for any input class, previously-passing requests could newly fail this hard gate. This
   should be an explicit item in the Rust performance-parity test matrix, not just a general
   "should be at least as fast" goal.
