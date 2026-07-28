# Characterization: Reconstruction cluster

Scope: `src/workers/algorithm/irregular/intrinsicReconstructionPortfolio.ts` (604 lines) and
`src/workers/algorithm/irregular/intrinsicPlaceDeferCompleteShadow.ts` (465 lines).

This document is a byte-for-byte behavioral specification of both files as they exist on `main`
at the time of writing (commit `f282f0a`). It is written for a Rust implementer who will not
re-read the TypeScript, and for a parity reviewer verifying a port against it. All claims carry
`file:line` references into the two target files unless explicitly marked as a pointer into an
adjacent file for context.

Both files depend heavily on `intrinsicStrictDecoder.ts` (`constructIntrinsicStrictState`,
`measureIntrinsicSheetlessCompletedLayout`, `selectIntrinsicStrictCompletedParetoFront`,
`rankIntrinsicStrictCompletedLayouts`) and on `intrinsicSharedArchivePortfolio.ts`
(`makeIntrinsicSharedArchiveEndpoint`, `retainRankedSharedArchive`,
`selectIntrinsicSharedArchiveWinner`). Those modules are characterized by other Stage-0 clusters;
here they are cited only where needed to make the two target files' contracts precise, and are
flagged as "external" so this document is not mistaken for their specification.

---

## 1. Purpose and role in Compact / Compact Short Side execution

### 1.1 `intrinsicReconstructionPortfolio.ts` — purpose

Exports `runIntrinsicReconstructionPortfolio` (`intrinsicReconstructionPortfolio.ts:124-298`), a
bounded, deterministic re-decode harness. Given one "winning" sheetless endpoint (the *protected*
complete archive winner) plus the full prepared-piece set, it derives a small, fixed catalog of
alternative deterministic piece orders (`buildIntrinsicReconstructionSpecs`,
`intrinsicReconstructionPortfolio.ts:301-339`) — reversed priority, four q0/q90 traversal orders
keyed off the winning endpoint's bounding-box centroid, and gap-contained ("open-pocket-first")
variants of all of the above — and re-runs the strict sheetless constructor
(`constructIntrinsicStrictState`, external) once per surviving order, subject to per-decode and
total runtime/evaluation caps. It reports every attempt (`runs`), and separately exposes an
internal deduplicated Pareto-ranked `archive` and `winner` (`intrinsicReconstructionPortfolio.ts:427-473`).

**Production liveness — important nuance.** The only production caller is
`coordinateIntrinsicSharedArchive` in `computeIrregularNesting.ts` (see §2). It calls
`runIntrinsicReconstructionPortfolio` with `roleFamily: 'endpoint-q90-right-to-left'`
(`computeIrregularNesting.ts:843`), which via `intrinsicReconstructionSpecMatchesFamily`
(`intrinsicReconstructionPortfolio.ts:342-352`) admits **exactly one** non-seed spec — the role
literally named `'endpoint-q90-right-to-left'`. The caller then reads the result by scanning
`reconstruction.runs` for that one role (`computeIrregularNesting.ts:882-884`); it **never reads
`reconstruction.archive` or `reconstruction.winner`**. So on the production path exactly one
seed run (`'settled-protected'`) and at most one decoded run (`'endpoint-q90-right-to-left'`) are
ever produced and only the second is consulted. The internal 8-slot Pareto archive
(`retainIntrinsicReconstructionArchive`, `INTRINSIC_RECONSTRUCTION_ARCHIVE_CAPACITY = 8`,
`intrinsicReconstructionPortfolio.ts:26,427-473`) is fully computed on every call (wasted but
harmless work) and is otherwise **dead on the production path** — it is exercised only by
`tests/unit/intrinsicReconstructionPortfolio.test.ts` and by two non-gated dev CLI scripts
(`scripts/irregular-intrinsic-shared-archive.ts:296`,
`scripts/irregular-intrinsic-v7-seed-archive.ts:220`). A Rust port must still reproduce
`retainIntrinsicReconstructionArchive` exactly (it is public, unit-tested, and the migration
prompt treats existing tests as immutable — §3 of the governing prompt), but its output has zero
observable effect on Compact/Compact Short Side nesting results today.

The re-decode itself, restricted to the single `'endpoint-q90-right-to-left'` role, **is live and
outcome-affecting**: `tests/unit/irregularSeventeenShapesCompactGolden.test.ts:118-126` is a
golden test in which the focused reconstruction genuinely wins
(`outputInfluence: 'selected'`, `consumedCandidateEvaluations: 8_035` against the 12,000 cap) and
its resulting canonical hash becomes the job's final selected layout hash
(`EXPECTED_CANONICAL_HASH`, asserted against `computed.placedCollisionGeometries` at
lines 110-114). `tests/unit/intrinsicCapacityIntegration.test.ts:165-234` is a second golden path
in which the reconstruction attempt is rejected as `'duplicate-order'` and the protected endpoint
is kept unchanged (`outputInfluence: 'protected-fallback'`). Both are Compact-profile tests
(sheetless complete archive, not capacity/Short-Side-specific), but the code path this cluster
implements is shared unconditionally by Compact and Compact Short Side — `shortSideProfileRequested`
(`computeIrregularNesting.ts:484-485`) only gates a *later*, unrelated Short Side observer stage
and does not affect whether focused reconstruction runs.

Exported helper `intrinsicPreparedPieceClassKey` (`intrinsicReconstructionPortfolio.ts:551-582`,
used internally for order-key deduplication) is also imported by
`intrinsicQueueBeamDiscriminator.ts:51`. That importing file, however, has **zero production
importers of its own** (only a test file imports it —
`grep` confirms no `src/**/*.ts` imports `intrinsicQueueBeamDiscriminator.ts`), so this second
consumer does not establish additional production liveness; `intrinsicPreparedPieceClassKey`'s
only live production consumer is `intrinsicReconstructionPortfolio.ts` itself.

### 1.2 `intrinsicPlaceDeferCompleteShadow.ts` — purpose

Exports `runIntrinsicPlaceDeferCompleteShadow` (`intrinsicPlaceDeferCompleteShadow.ts:131-232`)
and `observeIntrinsicPlaceDeferCompleteShadow` (`intrinsicPlaceDeferCompleteShadow.ts:238-280`).
This is an **experimental, explicitly non-authoritative** producer: it defers the first prepared
piece to the end of the pending order, re-decodes once (bounded by a fixed 19,862-evaluation /
35,000 ms cap), and reports whether a complete skip-free endpoint results. Every field named
`outputInfluence` in its trace type is typed and asserted as the literal `'none'`
(`intrinsicPlaceDeferCompleteShadow.ts:101`, and see `IntrinsicPlaceDeferTrace` docstring at
`intrinsicPlaceDeferCompleteShadow.ts:77-102` and `intrinsicFocusedCompleteReconstructionTrace`-
adjacent code comments in the caller). This module never writes into any archive, never
influences `selectIntrinsicSharedArchiveWinner`, and the only thing the caller does with its
result is forward it into a diagnostic trace field
(`experimentalPlaceDeferTrace`) and an optional benchmark callback
(`input.options.onExperimentalPlaceDeferCompleteEndpoint?.(experimental.endpoint)`,
`computeIrregularNesting.ts:784`).

**Production liveness.** The module only runs when the caller explicitly sets
`options.captureExperimentalPlaceDeferCompleteShadow === true`
(`computeIrregularNesting.ts:777`). That flag is never set anywhere in `src/` outside the option's
own declaration; the only place it is ever set `true` is in test code
(`tests/unit/intrinsicCapacityIntegration.test.ts:391,632`). **This module is dead on every
default/normal production request** — it is an opt-in diagnostic/benchmark lane, not part of the
Compact or Compact Short Side execution the migration prompt's "Included" scope names (the
migration prompt does not list this module under §4.1 "Included" either). It must still be ported
faithfully if the orchestrator decides to keep the diagnostic surface (it is unit-tested — see §14),
but it carries **no risk to selected layouts** if it is deprioritized or stubbed relative to the
authoritative Compact/Compact Short Side path, provided the opt-in flag remains wired to a
no-op-equivalent code path when absent.

---

## 2. Entry points, callers, callees (traced)

### 2.1 `intrinsicReconstructionPortfolio.ts` exports and their callers

| Export | Definition | Callers (traced via grep) |
|---|---|---|
| `runIntrinsicReconstructionPortfolio` | `:124-298` | `computeIrregularNesting.ts:840` (production, single call site); `tests/unit/intrinsicReconstructionPortfolio.test.ts:307-365`; `scripts/irregular-intrinsic-shared-archive.ts:296`; `scripts/irregular-intrinsic-v7-seed-archive.ts:220` (both non-gated dev CLIs) |
| `buildIntrinsicReconstructionSpecs` | `:301-339` | Internal (`:159`); directly unit-tested (`tests/unit/intrinsicReconstructionPortfolio.test.ts:191,218`) |
| `intrinsicReconstructionSpecMatchesFamily` | `:342-352` | Internal (`:162`); directly unit-tested |
| `buildCanonicalEndpointOrders` | `:355-424` | Internal (`:305`); directly unit-tested |
| `retainIntrinsicReconstructionArchive` | `:427-473` | Internal (`:288`); directly unit-tested — **not read by the production caller** (see §1.1) |
| `intrinsicReconstructionEffectiveOrderKey` | `:545-549` | Internal (`:167,173,490,520`); directly unit-tested |
| `intrinsicPreparedPieceClassKey` | `:551-582` | Internal (via `intrinsicReconstructionEffectiveOrderKey`, `:548`); `intrinsicQueueBeamDiscriminator.ts:51` (itself unused in production — see §1.1) |
| `INTRINSIC_RECONSTRUCTION_ARCHIVE_CAPACITY` (`= 8`) | `:26` | Default parameter of `retainIntrinsicReconstructionArchive` (`:429`); test-only override to `3` (`tests/unit/intrinsicReconstructionPortfolio.test.ts:281`) |
| `INTRINSIC_RECONSTRUCTION_ROLES` (14-entry tuple) | `:28-43` | Type source for `IntrinsicReconstructionRole`; asserted `toHaveLength(14)` in tests (`tests/unit/intrinsicReconstructionPortfolio.test.ts:207`) |
| `IntrinsicReconstructionPortfolioError` | `:99-104` | Constructed once, at `:153` (`operation: 'seed'`) — the `'order'` and `'archive'` operation variants declared in the type are **never constructed anywhere in this file** (dead enum members; must still be modeled in Rust for type completeness but are unreachable) |

### 2.2 `intrinsicPlaceDeferCompleteShadow.ts` exports and their callers

| Export | Definition | Callers |
|---|---|---|
| `runIntrinsicPlaceDeferCompleteShadow` | `:131-232` | `observeIntrinsicPlaceDeferCompleteShadow` (`:245`, internal wrapper); `tests/unit/intrinsicCapacityMode.test.ts:1142,1148,1168,1188,1199` (direct, unwrapped — exercises checkpoint pause/resume/validation) |
| `observeIntrinsicPlaceDeferCompleteShadow` | `:238-280` | `computeIrregularNesting.ts:778` (production, opt-in only — see §1.2); `tests/unit/intrinsicCapacityMode.test.ts:1224,1245` |
| `makePlaceDeferCheckpoint` | `:282-333` | Internal only (`:140`) |
| `validatePlaceDeferCheckpoint` | `:335-438` | Internal only (`:142`) |
| `intrinsicPlaceDeferFingerprint` | `:440-453` | Internal only (`:139`) |
| `intrinsicPlaceDeferPendingOrder` | `:455-464` | Internal only (`:250`, used by the censoring fallback in `observeIntrinsicPlaceDeferCompleteShadow`) |
| `INTRINSIC_PLACE_DEFER_CHECKPOINT_VERSION` (`'intrinsic-place-defer-checkpoint-v1'`) | `:26-27` | Checkpoint/trace `version` field stamp and validation gate (`:142,158,215,265,301,356`) |
| `INTRINSIC_PLACE_DEFER_EVALUATION_CAP` (`= 19_862`) | `:28` | `:185,323,423` |
| `INTRINSIC_PLACE_DEFER_RUNTIME_CAP_MS` (`= 35_000`) | `:29` | `:186` |

### 2.3 Callees (external, traced)

Both files call into `constructIntrinsicStrictState`
(`intrinsicStrictDecoder.ts:401`, `import` at `intrinsicReconstructionPortfolio.ts:16` and
`intrinsicPlaceDeferCompleteShadow.ts:21`) — the shared strict sheetless constructor. Its
per-candidate evaluation-cap check is inside the piece/transform/candidate loop at
`intrinsicStrictDecoder.ts:620-631` (`if (maximumCandidateEvaluationCount !== undefined &&
candidateEvaluationCount >= maximumCandidateEvaluationCount) { truncationReason =
'maximum-candidate-evaluations'; break pieceLoop }`), and its runtime-deadline check is at
`intrinsicStrictDecoder.ts:475-483` (cooperative `control.checkpoint(phase)` plus an elapsed-time
comparison against `maximumRuntimeMs`). This is the single mechanism underlying both files'
`'evaluation-cap'` / `'deadline'` statuses; it is characterized in full by the strict-decoder
cluster, not here.

`intrinsicReconstructionPortfolio.ts` additionally calls (all external, `intrinsicStrictDecoder.ts`):
`measureIntrinsicSheetlessCompletedLayout` (`:1823-1852`, called at `:266-269`),
`rankIntrinsicStrictCompletedLayouts` (`:2284-2288`, called at `:506`),
`selectIntrinsicStrictCompletedParetoFront` (`:2271-2281`, called at `:445-447`).
It also calls `placedCollisionWorldGridPath` (`canonicalLayoutGeometry.ts:92-110`, called at
`:368`) and `toGridMm` (`clipper2OffsetPolicy.ts:44-53`, called at `:553-554,563-564`).

`intrinsicPlaceDeferCompleteShadow.ts` additionally calls (all external):
`intrinsicCapacityPreparedPieceId` (`intrinsicCapacityMaterial.ts:9-11`),
`makeIntrinsicSharedArchiveEndpoint` (`intrinsicSharedArchivePortfolio.ts:612-637`, called at
`:195-202`), and `IrregularBeamState.empty` / `.canonicalOccupiedGeometryKey`
(`irregularBeamState.ts:139-146,92,127`).

### 2.4 The reconstruction admission/comparison rule itself lives in the caller, not in these files

The special-focus admission rule ("focused reconstruction may replace the protected leader only
under the current admission and comparison rules") is **not implemented inside either target
file**. `runIntrinsicReconstructionPortfolio` only produces candidate endpoints; the actual
admission decision happens in `computeIrregularNesting.ts:880-937`:

1. The caller extracts exactly one named run: `reconstruction.runs.find(({ role }) => role ===
   'endpoint-q90-right-to-left')` (`:882-884`).
2. If that run's `status !== 'completed'` or `metrics === undefined`,
   `focusedReconstructionEndpoints = []` (`:886-888`) — the attempt is discarded outright.
3. Otherwise it is wrapped into an `IntrinsicSharedArchiveEndpoint` via
   `makeIntrinsicSharedArchiveEndpoint` (`:890-913`, external) with role
   `` `reconstruction-${focusedRun.role}` ``.
4. The wrapped endpoint (0 or 1 element) is concatenated onto the *already-ranked* protected
   archive and the combined list is re-deduplicated/re-ranked by `retainRankedSharedArchive`
   (`:934-937`, external, in `intrinsicSharedArchivePortfolio.ts:355-380`), which internally calls
   `rankIntrinsicStrictCompletedLayouts` — the same total-order Pareto-then-lexicographic ranking
   used everywhere else in the shared archive. There is no special-casing that privileges the
   reconstruction endpoint by origin; it wins or loses purely by canonical-geometry rank, exactly
   like any other archive endpoint.
5. `winner = selectIntrinsicSharedArchiveWinner(selectFittingSharedArchive(sheetlessArchive))`
   (`:939-941`, external) is recomputed from the combined archive.
6. `outputInfluence` is derived by hash membership test against the *new* combined-archive winner
   (`:947-957`): `'selected'` if the winner's hash matches one of `focusedReconstructionEndpoints`;
   `'protected-fallback'` otherwise (including when `focusedReconstructionEndpoints` is empty, or
   when the reconstruction endpoint loses the re-ranking to the original protected winner, or is a
   dominated/duplicate hash that `retainRankedSharedArchive` discarded).

Any failure of the reconstruction Effect (any tag except cancellation) is caught by
`Effect.matchEffect`'s `onFailure` at `computeIrregularNesting.ts:850-858` and converted to
`{ kind: 'failed', error }`, which produces trace status `'failed-protected-fallback'`
(`:867-879`) and leaves `focusedReconstructionEndpoints = []` (the `let` binding's initial value at
`:809-810` is never reassigned on this branch) — i.e. the protected endpoint is provably
untouched by any reconstruction error. Explicit user cancellation
(`IrregularNfpIfpControlAbortError` with `reason === 'cancelled'`) is re-raised and aborts the
whole job (`:851-854`), matching the "only explicit cancellation aborts" rule stated in this
file's own docstring for the shadow module (`intrinsicPlaceDeferCompleteShadow.ts:234-237`) and
implemented identically for reconstruction.

A Rust port must place this admission logic at the same layer (the orchestrator/caller), not
inside a ported `intrinsicReconstructionPortfolio` module, or it will duplicate/diverge from the
shared-archive ranking authority.

---

## 3. Data in/out: exact types/shapes, optional-field presence/omission semantics

### 3.1 `runIntrinsicReconstructionPortfolio` input (`intrinsicReconstructionPortfolio.ts:124-137`)

```ts
{
  allPreparedPieces: ReadonlyArray<IrregularPreparedPiece>
  baselineSeeds: ReadonlyArray<IntrinsicReconstructionSeed>
  maximumRuntimeMsPerDecode?: number          // default 120_000 (:140)
  maximumTotalRuntimeMs?: number              // default 300_000 (:141)
  roleFamily?: IntrinsicReconstructionRoleFamily // default 'all' (:142)
  maximumCandidateEvaluationsPerDecode?: number  // default undefined = no per-decode cap (:143-144)
  maximumTotalCandidateEvaluations?: number      // default undefined = no total cap (:145-146)
  control?: IrregularNfpIfpControl
}
```

Production call values (`computeIrregularNesting.ts:840-849`): `roleFamily:
'endpoint-q90-right-to-left'`, `maximumRuntimeMsPerDecode: 15_000`, `maximumTotalRuntimeMs:
15_000`, `maximumCandidateEvaluationsPerDecode: 12_000`, `maximumTotalCandidateEvaluations:
12_000`. **These numbers are not defaults inside the target module** — the module has no built-in
"12000" constant; the cap is entirely a caller-supplied parameter. A Rust port must define this
constant at the orchestrator call site (mirroring `computeIrregularNesting.ts`), not inside a
ported reconstruction-portfolio module, or the two will drift silently.

`IntrinsicReconstructionSeed` (`:53-62`) fields: `role: 'canonical-grid' |
'legacy-absolute-envelope' | 'settled-protected'`, `canonicalGeometryHash: string`,
`placedCollisionGeometries: ReadonlyArray<IrregularPlacedPiece>`, `stepTrace`,
`metrics: IntrinsicStrictCompletedMetrics`. Production supplies exactly one seed with `role:
'settled-protected'` (`computeIrregularNesting.ts:830-838`).

`control` is spread conditionally: `...(input.control === undefined ? {} : { control: input.control
})` (`:229`) — i.e. when absent, the `control` key is **omitted from the object literal**, not set
to `undefined`. This is semantically identical to explicit `undefined` for the callee
(`constructIntrinsicStrictState` only checks `input.control !== undefined`,
`intrinsicStrictDecoder.ts:475`), so a Rust `Option<Control>` with `None` ports this faithfully;
there is no divergent "has the key vs. value is null" behavior to preserve here.

### 3.2 `runIntrinsicReconstructionPortfolio` output (`IntrinsicReconstructionPortfolioResult`, `:86-97`)

```ts
{
  runs: ReadonlyArray<IntrinsicReconstructionRun>            // every attempt, seed-first then spec order
  archive: ReadonlyArray<IntrinsicReconstructionRun & { metrics: ... }>  // dead on prod path, see §1.1
  winner: (IntrinsicReconstructionRun & { metrics: ... }) | undefined    // archive[0]; dead on prod path
  runtimeMs: number
  consumedCandidateEvaluations: number
  candidateEvaluationAccountingComplete: boolean
}
```

`IntrinsicReconstructionRun` (`:64-84`) — every field is always present (no optional fields on
this type); values are placeholders (`0`, `[]`, `undefined`) rather than omitted keys when not
applicable (e.g. a `'deadline'` run always has `metrics: undefined`,
`placedCollisionGeometries: []`, never a missing key — see `deadlineRun`, `:511-531`).
`duplicateOf: IntrinsicReconstructionRole | undefined` is the owning role when
`status === 'duplicate-order'`, else `undefined`.

**Non-obvious field:** `candidateEvaluationAccountingComplete` is **only** set `false` on the
`'deadline'` branches (`:198,245`) — the `'evaluation-cap'` branch (`:258-264`) leaves it at its
prior value (`true` unless a prior spec in the same call already hit a deadline). Confirmed by
`tests/unit/intrinsicReconstructionPortfolio.test.ts:343-344`: a run that hits the evaluation cap
still reports `candidateEvaluationAccountingComplete === true`. This is intentional-looking but
counter-intuitive naming; **preserve exactly, do not "fix"** per the governing prompt's semantic
freeze rule (§2 of `docs/prompts/fable5-rust-irregular-nesting-implementation.md`).

### 3.3 `runIntrinsicPlaceDeferCompleteShadow` input (`RunIntrinsicPlaceDeferInput`, `:111-117`)

```ts
{
  sheet: SheetSpec
  preparedPieces: ReadonlyArray<IrregularPreparedPiece>
  control?: IrregularNfpIfpControl
  checkpoint?: IntrinsicPlaceDeferCheckpoint
  maximumDecisionBoundaries?: 1     // the only legal non-undefined value is the literal 1
}
```

`maximumDecisionBoundaries` is typed as the literal `1`, not `number` — there is no "run N
boundaries" generalization; the only two states are "no boundary limit" (`undefined`, run straight
through) or "pause after exactly one boundary" (`1`). The pause path is taken **only** when
`input.checkpoint === undefined && input.maximumDecisionBoundaries === 1` (`:152`) — supplying
`maximumDecisionBoundaries: 1` alongside an existing `checkpoint` does **not** re-pause; resumption
always runs the decode to completion (or cap/deadline) regardless of that flag (`:152` guards the
early return; once a checkpoint is present control falls through unconditionally to `:173-230`).

### 3.4 `runIntrinsicPlaceDeferCompleteShadow` output (`IntrinsicPlaceDeferResult`, `:104-109`)

```ts
{
  status: 'paused' | 'settled'
  checkpoint: IntrinsicPlaceDeferCheckpoint | undefined   // defined iff status === 'paused'
  endpoint: IntrinsicSharedArchiveEndpoint | undefined    // defined iff a complete skip-free layout resulted
  trace: IntrinsicPlaceDeferTrace                          // always present
}
```

`IntrinsicPlaceDeferCheckpoint` (`:31-75`) is a large, fully-typed record with no optional fields;
every accounting field the checkpoint tracks (`fitMask`, `budgetLedgers`, `noSkipFrontier`, etc.)
is present with a fixed initial value on the fresh checkpoint (`makePlaceDeferCheckpoint`,
`:282-333`) — the module never actually advances the checkpoint's `cursor`, `pass`,
`budgetLedgers.totalConsumedPlacementEvaluations`, etc. past their initial zero/empty values,
because there is only ever one decision boundary in this module (see §9). Every field the
checkpoint declares that would only make sense for multi-boundary resumption is present but
frozen at its "boundary 0" value; `validatePlaceDeferCheckpoint` (`:335-438`) explicitly rejects
any checkpoint where these frozen fields differ from their expected initial values
(`:394-406,418-436`), so no caller can smuggle in a "further along" checkpoint. This is a real
architectural constraint to preserve, not an oversight: the exported checkpoint type is shaped
like a general resumable checkpoint but this module's producer only ever emits the single
"boundary 0" instance.

`IntrinsicPlaceDeferTrace.outputInfluence` is typed as the single literal `'none'` (`:101`) — not
a union; the type system itself guarantees it can never carry any other value. Preserve this as a
unit type / fixed-value field in Rust, not a general enum, so a future accidental widening is
caught by the type checker rather than only by tests.

---

## 4. Algorithm state and every mutation point

### 4.1 `runIntrinsicReconstructionPortfolio` (`:124-298`)

Local mutable state, all function-scoped (no module-level mutable state in either file):

- `consumedCandidateEvaluations: number` — initialized `0` (`:147`), incremented once per
  processed (non-duplicate, non-pre-deadline, non-pre-cap) spec by
  `outcome.constructed.candidateEvaluationCount ?? 0` (`:252-253`). Never decremented.
- `candidateEvaluationAccountingComplete: boolean` — initialized `true` (`:148`), set `false` only
  on the two deadline branches (`:198`, `:245`); never set back to `true`.
- `runs: IntrinsicReconstructionRun[]` — initialized to a copy of `seedRuns` (`:163`), then
  `.push`-ed exactly once per spec, in spec-array order (`:176-191, 197, 209, 246-250, 258-264,
  270-285`). Never reordered, never spliced.
- `orderOwners: Map<string, IntrinsicReconstructionRole>` — see §5.2 for exact semantics; mutated
  by `.set` at `:166-169` (seed registration loop, runs to completion before the spec loop starts)
  and `:194` (spec loop, conditional on non-duplicate).

Mutation order within the main spec loop (`:172-286`), per spec, strictly sequential:
1. Compute `orderKey` (`:173`).
2. Look up `duplicateOf` (`:174`); if found, push a `'duplicate-order'` run and `continue` —
   **no** `orderOwners.set` on this branch (the earlier owner keeps ownership).
3. `orderOwners.set` (register this spec as the owner of its key) (`:194`) — happens **before**
   any deadline/cap/decode work, so a spec that is about to be deadline'd or cap'd still "claims"
   its order key for any later spec in the same call.
4. Compute `remainingTotalMs`; if `<= 0`, push a `'deadline'` run, set
   `candidateEvaluationAccountingComplete = false`, `continue` (`:195-200`).
5. Compute `remainingCandidateEvaluations`; if defined and `<= 0`, push an `'evaluation-cap'` run,
   `continue` (`:201-211`) — note this branch does **not** touch
   `candidateEvaluationAccountingComplete`.
6. Compute `requestedCandidateEvaluations` (min of per-decode cap and remaining total cap, or
   whichever is defined) (`:212-220`).
7. Call `constructIntrinsicStrictState` (`:222-243`), catching `IrregularNfpIfpControlAbortError`:
   re-raise if `reason === 'cancelled'`, else convert to `{ status: 'deadline', constructed:
   undefined }`.
8. If `outcome.constructed === undefined` (i.e. the caught internal deadline), set
   `candidateEvaluationAccountingComplete = false`, push a `'deadline'` run carrying the actual
   elapsed `runtimeMs`, `continue` (`:244-250`).
9. Accumulate `consumedCandidateEvaluations` (`:252-253`).
10. If `outcome.constructed.truncationReason === 'maximum-candidate-evaluations'`, push an
    `'evaluation-cap'` run (again, no accounting-complete flag touched), `continue`
    (`:254-265`).
11. Otherwise measure the completed layout (`measureIntrinsicSheetlessCompletedLayout`) and push a
    `'completed'` or `'incomplete'` run depending on whether measurement succeeded
    (`:266-285`).

This 11-step sequence is the exact chronology a Rust port must reproduce per spec, in this order,
with no reordering (e.g. do not check the evaluation cap before the deadline, and do not register
`orderOwners` after the deadline/cap checks).

### 4.2 `retainIntrinsicReconstructionArchive` (`:427-473`) — pure, no external mutation

Local state: `unique: Map<string, Run>` built by iterating `complete` runs in their `runs`-array
order and `.set`-ing only on first occurrence per `canonicalGeometryHash` (`:439-443`, "first
wins" — the map is never overwritten once a key exists, unlike `orderOwners` above which is
"unconditional set unless already checked as duplicate"). Then `selected: Run[]` is built by a
local `append` closure (`:460-467`) that enforces both a capacity bound and hash-uniqueness, called
in this fixed order: frontier leader first (`:469`), then all `protectedSeeds` in their
`uniqueRuns`-derived order (`:470`), then all `rankedRuns` in ranked order (`:471`). See §6.4 for
the important `protectedSeeds` role-matching subtlety.

### 4.3 `runIntrinsicPlaceDeferCompleteShadow` (`:131-232`) — no loop, no accumulator

This function has no loop and no mutable accumulator; it is a straight-line sequence: build/accept
checkpoint → validate → (maybe early-return "paused") → build `reordered` piece list → one
`constructIntrinsicStrictState` call → derive `complete`/`endpoint`/`status` → return. The only
"mutation" is object construction, not variable reassignment.

### 4.4 `observeIntrinsicPlaceDeferCompleteShadow` (`:238-280`) — error-to-trace conversion, no state

Wraps 4.3 in `Effect.catch`; on any non-cancellation error it rebuilds a pending order from
`input.preparedPieces` directly (`intrinsicPlaceDeferPendingOrder`, `:455-464`) — **not** from
whatever partial state the failed attempt may have reached — and reports `placedCount: 0`,
`unplacedCount: input.preparedPieces.length` unconditionally (`:270-274`). This means a censored
trace's `placedCount`/`unplacedCount` are *not* a report of how far the failed decode actually got;
they are always the "as if nothing was placed" values. Preserve this exactly — do not "improve"
it to report real partial progress.

---

## 5. Ordering sources

### 5.1 Sorts

| Site | Comparator | Stable-sort reliance |
|---|---|---|
| `buildCanonicalEndpointOrders` order() (`:386-417`) | `[...pieces].sort(...)` — primary axis value (signed by role) then `doubledY` then `doubledX` then `localeCompare` on piece id (`:411-416`) | JS `Array.prototype.sort` is stable (ES2019+); relied upon implicitly because the four numeric tie-breakers are exact-equality comparisons on the same `positions` map values for congruent/duplicate pieces, and the final `localeCompare` on distinct piece ids is the true total-order tie-breaker, so ties should not reach the engine's stability guarantee in well-formed inputs — but degenerate inputs (two prepared pieces sharing one `PieceId`, which the type system does not forbid) would silently depend on stable sort. Preserve stability regardless. |
| `intrinsicPreparedPieceClassKey` transforms sort (`:568-575`) | `index` then `rotationDeg` then `Number(mirrored)` then `reason.localeCompare` | Same caveat; `transforms` on a given piece are expected to have distinct `index` values in practice, making this a total order without needing stability, but a Rust port should still use a stable sort primitive to match exactly. |
| `canonicalPointRing` (`:584-595`) | `.toSorted()` with **no comparator** — default JS string sort (UTF-16 code-unit order), not `localeCompare` | Default `Array.prototype.toSorted` without a comparator is stable and lexicographic by UTF-16 code unit. The strings sorted are `"x,y;x,y;..."` built from grid integers and separators (`,`, `;`, `-`), all ASCII, so UTF-16 code-unit order coincides with byte-wise UTF-8 order — a Rust `Vec::sort()` / `sort_unstable()` on `&str` ports this exactly for this specific alphabet. **Do not swap in a `localeCompare`-based ordering; this call site intentionally does not use it (contrast with the `localeCompare` calls in §5.1 above and §6).** |
| `validatePlaceDeferCheckpoint` (`intrinsicPlaceDeferCompleteShadow.ts:371`) | `partition.toSorted()` / `preparedIds.toSorted()` — default sort, no comparator, on `PieceId` (branded `string`) values | Used only for a set-equality check (are the two sorted arrays elementwise equal), so tie-breaking/stability is irrelevant here — but the sort *order itself* (default UTF-16 code-unit, not locale-aware) still matters for correctness if any `PieceId` values are non-ASCII; must match exactly or the equality check can diverge. |
| External (cited for context): `orderIntrinsicStrictParetoFront` (`intrinsicStrictDecoder.ts:2321-2343`) and `rankIntrinsicStrictParetoPartition` (`intrinsicStrictDecoder.ts:2290-2318`) | `.toSorted(objective.compare \|\| canonicalGeometryHash.localeCompare(...))` | Uses `localeCompare` on hex SHA-256 hash strings as the final tie-breaker. Hex digests contain only `0-9a-f`, so default-locale collation should coincide with code-unit order in practice, but this is a genuine `localeCompare` call (locale-and-ICU-version-dependent in principle) feeding a comparator that both `selectReconstructionEndpoint` (`:506`) and `retainIntrinsicReconstructionArchive` (`:445`) depend on transitively. See §12. |

### 5.2 Maps whose insertion/overwrite order is observable

`orderOwners: Map<string, IntrinsicReconstructionRole>` (`:164`) is used **only** via `.get`/`.set`
keyed lookup — it is never iterated for output, so JS `Map` insertion-order iteration semantics do
not themselves leak into any result. What *does* matter and must be replicated exactly is the
**last-write-wins overwrite order** on key collision:

- Seed registration loop (`:165-170`) iterates `seedRuns` in `baselineSeeds` input order and
  `.set`s the **same fixed key** — `` `${candidateModeKey(run.candidateMode)}:${intrinsicReconstructionEffectiveOrderKey(input.allPreparedPieces)}` `` — for every seed, because
  `intrinsicReconstructionEffectiveOrderKey(input.allPreparedPieces)` does not depend on the loop
  variable at all (it always reads the *original, caller-supplied, unsorted* prepared-piece order,
  not the seed's own `placedCollisionGeometries` order). If two seeds shared the same
  `candidateModeKey` (not the case in production, which supplies exactly one seed), the **last**
  one in `baselineSeeds` array order would silently overwrite the earlier seed's `orderOwners`
  registration. A Rust port using a `HashMap`/`BTreeMap` with `.insert()` in the same `Vec`
  iteration order reproduces this correctly; the risk is only if a Rust port parallelizes or
  reorders the seed-registration loop.
- Spec loop (`:172-194`): registration only happens when the current spec's key was **not** found
  (`:174-175,194`), so among specs the earliest spec in `specs` array order to introduce a given
  key "owns" it, and every later spec with the same key is marked `duplicateOf` that earlier
  spec's role — **even if the earlier spec itself later resulted in `'deadline'`,
  `'evaluation-cap'`, or `'incomplete'`**, because registration happens unconditionally before the
  deadline/cap/decode checks (see §4.1 step 3). This is a genuine "first attempt claims the slot
  regardless of its own outcome" rule and must be preserved exactly.

`unique: Map<string, Run>` inside `retainIntrinsicReconstructionArchive` (`:435-443`) is
first-write-wins (only `.set` when `!unique.has(...)`), iterated afterward via `[...unique.values()]`
(`:444`) in insertion order, then immediately fed to `selectIntrinsicStrictCompletedParetoFront`
which re-sorts it — so the `Map`'s own iteration order does not leak past that point except as the
input list order to a function that produces a new order.

`piecesById: Map<PieceId, IrregularPreparedPiece>`
(`intrinsicPlaceDeferCompleteShadow.ts:173-175`) is a pure lookup table (`.get` only, via
`.flatMap`), never iterated for order.

### 5.3 Iteration orders that reach output

- `buildIntrinsicReconstructionSpecs`'s return array order (`:312-338`) is the **canonical spec
  processing order** and therefore the order runs are pushed onto `runs` (modulo seeds, which
  precede all specs) — reproduced verbatim: `reversed-priority`, the four `endpointOrders` (q0-ltr,
  q0-rtl, q90-ltr, q90-rtl), `open-pocket-first`, `reversed-priority-open-pocket-first`, then the
  four `gapContainedEndpointOrders` in the same q0/q90 order. Confirmed by
  `tests/unit/intrinsicReconstructionPortfolio.test.ts:194-206`.
- `INTRINSIC_RECONSTRUCTION_ROLES` (`:28-43`) fixes the canonical 14-role vocabulary order; nothing
  iterates this array for output today (`toHaveLength` assertion only), but it is the authoritative
  role-name list a Rust port's role enum must match verbatim (string values, not just count).

---

## 6. Comparators and tie rules

### 6.1 `buildCanonicalEndpointOrders`'s four traversal comparators (`:386-417`)

For role `r ∈ {q0-ltr, q0-rtl, q90-ltr, q90-rtl}`, each piece's position is
`{ doubledX, doubledY }` — the sum of `min` and `max` grid coordinates of its placed collision
polygon's world-grid path (i.e. `2 × centroid-of-bbox`, computed as an exact sum of two grid
integers, not a division — see §7). Missing position (piece not found in the `positions` map,
e.g. `placedCollisionWorldGridPath` returned `undefined` because the path had fewer than 3 points
or a non-finite/non-safe-integer coordinate) falls back to `preparedPieceId(first).localeCompare(preparedPieceId(second))`
(`:392-394`) for **either or both** pieces missing a position (`||`-style: `if (firstPosition ===
undefined || secondPosition === undefined)`). Given both positions present, the comparator is:

```
sign(primary) × primary   // primary = doubledX (q0-ltr), -doubledX (q0-rtl), -doubledY (q90-ltr), doubledY (q90-rtl)
  || doubledY(first) - doubledY(second)
  || doubledX(first) - doubledX(second)
  || preparedPieceId(first).localeCompare(preparedPieceId(second))
```
(`:411-416`, primary axis computed per-role at `:395-410`). The comparator is a strict total order
(assuming distinct `PieceId`s) with `localeCompare` as the ultimate tie-breaker — this is the same
`localeCompare` hazard noted in §5.1/§12.

### 6.2 `intrinsicReconstructionSpecMatchesFamily` (`:342-352`)

Not a comparator but a filter predicate; documented here because it is the sole gate controlling
which specs are decoded. `'all'` → always true. `'endpoint-q90-right-to-left'` → exact string
equality on `spec.role`. Otherwise (`'pure-growth'` / `'gap-contained'`) → `typeof
spec.candidateMode === 'object'` distinguishes gap-contained (`{ kind: 'gap-contained' }`) from
string-valued modes (`'pure-growth'`); `family === 'gap-contained' ? isGapContained :
!isGapContained`.

### 6.3 `intrinsicPreparedPieceClassKey`'s transform-order comparator (`:568-575`)

`index - index || rotationDeg - rotationDeg || Number(mirrored) - Number(mirrored) ||
reason.localeCompare(reason)` — numeric subtraction on the first three keys (all small integers /
booleans-as-0-or-1), `localeCompare` only as the last resort.

### 6.4 `retainIntrinsicReconstructionArchive`'s protected-seed subtlety (`:454-456`)

```ts
const protectedSeeds = uniqueRuns.filter(
  ({ role }) => role === 'canonical-grid' || role === 'legacy-absolute-envelope'
)
```

This filter recognizes **only two of the three possible baseline-seed roles**
(`IntrinsicReconstructionSeed.role` allows `'canonical-grid' | 'legacy-absolute-envelope' |
'settled-protected'`, `:54-57`). The role production actually uses,
`'settled-protected'`, is **not** in this protected set. The function's docstring
("Keeps the baseline seeds plus exact Pareto representatives", `:426`) reads as if it protects any
baseline seed, but the code only privileges two specific role literals ahead of the generic
frontier/ranked truncation. Since production never reads `.archive`/`.winner` (§1.1), this has no
observable production effect today, but **a Rust port must copy the two-literal check verbatim**
and must not "fix" it to also include `'settled-protected'`, because the existing unit tests
(`tests/unit/intrinsicReconstructionPortfolio.test.ts:274-289`) only exercise
`'canonical-grid'`/`'legacy-absolute-envelope'` and the migration prompt forbids behavior changes.
Flagged again in §15 as an open question for the orchestrator to acknowledge explicitly.

### 6.5 `retainIntrinsicReconstructionArchive`'s `append` admission order (`:460-471`)

`append` enforces, in this exact order: capacity bound (`selected.length < boundedCapacity`) **and**
hash-uniqueness (`!selected.some(hash === run.hash)`) — both must hold or the run is silently
dropped (not error). Call order: frontier leader (rank-0 of the Pareto-ranked unique set,
`rankedRuns[0]`, `:468-469`) is attempted first, then each of `protectedSeeds` in their
`uniqueRuns` (= `complete` runs, = `runs` array) order (`:470`), then every `rankedRuns` entry in
rank order (`:471`). Because `append` checks uniqueness, a `protectedSeeds` entry that happens to
equal the already-appended frontier leader's hash is silently skipped rather than duplicated, and
similarly for `rankedRuns` entries that duplicate an already-appended protected seed. Net effect:
the returned array is frontier-leader-first, then protected seeds (in seed input order) filling
remaining capacity, then general rank order filling any capacity left after that — capped at
`INTRINSIC_RECONSTRUCTION_ARCHIVE_CAPACITY` (or the caller-supplied override). Confirmed by
`tests/unit/intrinsicReconstructionPortfolio.test.ts:274-289` (`capacity=3` →
`['frontier-leader', 'canonical-seed', 'legacy-seed']`, dropping the frontier's own Pareto-rank
position since it was already appended by name).

### 6.6 No comparators inside `intrinsicPlaceDeferCompleteShadow.ts`

This file contains no `.sort`/`.toSorted` calls of its own (the only sort-adjacent calls are the
two `.toSorted()` uses inside `validatePlaceDeferCheckpoint`, already covered in §5.1) and no
custom comparator functions. All ranking/selection for its output endpoint is delegated entirely
to `makeIntrinsicSharedArchiveEndpoint` → `measureIntrinsicSheetlessCompletedLayout` (external).

---

## 7. Numeric semantics

### 7.1 Grid conversion and signed-zero handling

`toGridMm` (external, `clipper2OffsetPolicy.ts:44-53`, called from
`intrinsicPreparedPieceClassKey` at `:553-554,563-564`): `Math.abs(valueMm) *
CLIPPER2_OFFSET_POLICY.scale` (scale = `1000`, i.e. micron grid,
`clipper2OffsetPolicy.ts:11-12`), `Math.floor(scaled + 0.5)` (round-half-up on the absolute value —
i.e. "ties away from zero" per the policy's own `rounding` documentation string,
`clipper2OffsetPolicy.ts:13`), then `Math.sign(valueMm) * rounded`, rejected (`undefined`) unless
`Number.isSafeInteger`. **Signed-zero note:** `Math.sign(-0) === -0` in JavaScript, and `-0 *
0 === -0`; a Rust `f64::signum()`/equivalent must be checked for exact ties-away-from-zero and
signed-zero parity if any downstream comparison distinguishes `-0` from `0` (canonical string
rendering of `-0` vs `0` differs — `` `${-0}` === '0'`` in JS template-literal coercion, so this
specific risk is defused for the string-key use sites in this cluster, but must still be audited
generically per the migration prompt §8.1).

`placedCollisionWorldGridPath` (external, `canonicalLayoutGeometry.ts:92-110`, called at `:368`)
explicitly normalizes grid `-0` to `0` before use: `x === 0 ? 0 : x` (`canonicalLayoutGeometry.ts:100-101`)
— `-0 === 0` is `true` in JS, so this branch fires for both `+0` and `-0` and always substitutes
the literal `0`. This normalization feeds directly into `buildCanonicalEndpointOrders`'s
`doubledX`/`doubledY` position sums (`:376-384`), which are then used in the live production
`'endpoint-q90-right-to-left'` comparator (§6.1). A Rust port must apply the equivalent
normalization (e.g. `if x == 0.0 { 0.0 } else { x }`, which in IEEE-754 also unifies `-0.0` and
`0.0` under `==`) at the same point, not rely on downstream arithmetic to coincidentally cancel
signed zero.

### 7.2 Envelope/position arithmetic order

`buildCanonicalEndpointOrders` computes `minX/minY/maxX/maxY` via a plain sequential fold over
`path.slice(1)` seeded with `path[0]` (`:371-380`) — `Math.min`/`Math.max` pairwise, not a
reduction library call; order of evaluation is the array's natural left-to-right order, which for
binary64 min/max (NaN-free, since `placedCollisionWorldGridPath` already screened out
non-finite/unsafe-integer values) is commutative and associative in practice (no reassociation
hazard for min/max specifically, unlike sums). `doubledX = minX + maxX` and `doubledY = minY +
maxY` (`:381-384`) are simple two-term binary64 additions — order-independent (single operation),
no reassociation risk.

### 7.3 `intrinsicPreparedPieceClassKey`'s normalization arithmetic (`:551-582`)

`minimumX = Math.min(...gridPoints.map(({x}) => x))`, `minimumY` likewise (`:560-561`) — spread
into `Math.min`/`Math.max` (variadic), which in V8 is evaluated left-to-right over the array; for
integer-valued grid coordinates (already rounded by `toGridMm`) this has no floating-point
reassociation hazard since all values are exact `f64`-representable integers within
`Number.isSafeInteger` bounds. `normalized = gridPoints.map(({x,y}) => ({x: x - minimumX, y: y -
minimumY}))` (`:562`) — exact integer subtraction (both operands are grid integers). `referenceX -
minimumX`, `referenceY - minimumY` (`:581`) — same. No `BigInt` is used anywhere in either target
file; all arithmetic here is plain `Number` on values that are established to be safe integers by
`toGridMm`'s own guard (`Number.isSafeInteger(gridValue)`, `clipper2OffsetPolicy.ts:52`) before
they ever reach this file. A Rust port can use `i64` (or `i32` if bounds are proven tighter —
verify against `CLIPPER2_OFFSET_POLICY.maxScaledCoordinate = 1_000_000_000`,
`clipper2OffsetPolicy.ts:21`) for these grid-integer computations with checked arithmetic, matching
the migration prompt's §8.2 requirement, rather than `f64`.

### 7.4 No `BigInt`, no `Math.round`/`Math.abs` combinatorics beyond `toGridMm`, no NaN/Infinity handling of its own

Neither target file performs its own NaN/Infinity screening; both rely entirely on upstream
functions (`toGridMm`, `placedCollisionWorldGridPath`) having already rejected non-finite or
unsafe-integer inputs by returning `undefined`, which both files then treat as "skip this point /
fall back to id ordering" (`:370` `if (path === undefined || first === undefined) continue`;
`:556-558,565-567` `piece:${preparedPieceId(piece)}` fallback string). Preserve this "upstream
already validated, treat undefined as an opaque skip signal" contract; do not add redundant
NaN/Infinity checks inside a Rust port of these two files themselves (that would be new,
unspecified behavior), but do make sure the Rust port of the upstream functions performs the
equivalent screening before these files' logic runs.

### 7.5 `IntrinsicReconstructionRun` numeric accounting fields

`consumedCandidateEvaluations`, `requestedCandidateEvaluations`, `consumedCandidateEvaluations`
(portfolio-level) are all plain `number` (JS safe integers in practice — evaluation counts are
small), incremented by `+=` (`:253`) or set directly; no overflow risk at realistic scales
(`INTRINSIC_PLACE_DEFER_EVALUATION_CAP = 19_862`, production reconstruction cap `12_000`), but a
Rust port should still use checked/`u32`+ arithmetic per the migration prompt's general integer
overflow rule (§8.2) rather than assume magnitude safety implicitly.

---

## 8. Serialization and hashing

### 8.1 `intrinsicReconstructionEffectiveOrderKey` (`:545-549`)

```ts
pieces.map(intrinsicPreparedPieceClassKey).join('|')
```

Pipe-separated (`'|'`) concatenation of per-piece class keys. This is **not** fed to SHA-256
directly within this file — it is used purely as an in-memory `Map` key for duplicate-order
detection (§5.2). It is *not* a canonical checkpoint/hash artifact in the sense of migration
prompt §9 (no `JSON.stringify`, no `createHash` call in this function). Note the **separator
character differs** from the unrelated reuse of `intrinsicPreparedPieceClassKey` inside
`intrinsicQueueBeamDiscriminator.ts:2382,2437`, which joins with `' '` instead — the two
join strategies are independent and must each be preserved with their own exact separator; do not
unify them under a shared constant during the port, since that would be an unrequested behavior
change to a dead-but-tested file.

### 8.2 `intrinsicPreparedPieceClassKey` itself (`:551-582`)

Builds a string of the form:
```
{canonicalPointRing(normalized)}@{referenceX - minimumX},{referenceY - minimumY}:{Number(allowMirror)}:{transformsJoined}
```
where `transformsJoined` is `` `${index}:${rotationDeg}:${Number(mirrored)}:${reason}` `` entries
joined by `,` (`:576-579`), and the whole falls back to `` `piece:${preparedPieceId(piece)}` `` if
any grid coordinate or the placement reference fails `toGridMm` (`:556-558,565-567`). All numeric
interpolations use JS's default `Number`-to-`String` coercion (`${x}` on a safe integer produces
the shortest round-trippable decimal — for integers this is simply the decimal digits, no
scientific notation risk since `toGridMm` bounds values under `Number.isSafeInteger`). A Rust port
must render these as `format!("{}", n)` for the equivalent integer type — plain decimal, no
locale/thousands separators, matching JS default coercion for integers.

### 8.3 `canonicalPointRing` (`:584-595`)

For a point sequence, builds **both** the forward sequence and its reversal
(`[points, [...points].reverse()]`), and for each of those two orientations, every cyclic rotation
(`offset` from `0` to `length-1`), rendering each rotation as `"x,y;x,y;...;x,y"` (`:588-592`), then
returns the lexicographically-smallest string across **all** `2 × length` variants
(`.toSorted()[0]`, default JS string sort — see §5.1) — or `''` if `points` is empty
(`variants.toSorted()[0] ?? ''`, `:594`, only reachable if `points` itself is empty, since a
non-empty `points` array always yields at least one non-empty variant string). This is the
winding/ring-origin normalization referenced generically in the migration prompt §9
("preserve ring-origin normalization", "preserve winding normalization") — this file's concrete
implementation of that rule for the piece-class-key use case specifically (not to be confused with
the canonical collision-geometry ring normalization used elsewhere in the codebase for actual
Clipper2 polygon canonicalization, which is a different, external function).

### 8.4 `intrinsicPlaceDeferFingerprint` (`:440-453`) — the one true SHA-256 / `JSON.stringify` site in this cluster

```ts
createHash('sha256').update(
  JSON.stringify(
    { version, sheet: { width, height }, preparedPieces: input.preparedPieces },
    (_key, value) => (typeof value === 'bigint' ? value.toString() : value)
  )
).digest('hex')
```

This is a **default `JSON.stringify`**, not a custom canonical encoder — object key order in the
output is JS's own property-enumeration order for each object being stringified (insertion order
for string keys, which for `input.preparedPieces`' nested `Effect`/Schema class instances is
whatever order their class fields were declared/assigned in), array order is preserved verbatim,
`undefined`-valued object properties are omitted by `JSON.stringify` itself (native behavior, not
custom logic in this file), and the only custom behavior is the replacer function converting any
`bigint` leaf to its `toString()` (unquoted decimal digits become a JSON string, e.g. `123n` →
`"123"`) — matching the migration prompt's "BigInt values encoded as quoted base-10 strings" rule
(§9) but via the generic replacer pattern rather than a bespoke encoder. **This is the fingerprint
used only to validate that a resumed checkpoint matches the same `(sheet, preparedPieces)` request**
(`:139-142,356-359`) — it is not part of any cross-run canonical artifact, cache key, or archive
identity; it only prevents resuming a stale/mismatched checkpoint within one job. Because it
depends on default `JSON.stringify` object-key enumeration order over Effect Schema class
instances (which are ordinary JS objects with their fields assigned in constructor-declaration
order — see `IrregularPreparedPiece`'s constructor, `domain.ts:653-671` referenced in §3), **a
Rust port reproducing this exact byte sequence must mirror the exact field assignment order of
every class reachable from `preparedPieces`**, not just the `sheet`/`version` fields explicit in
this function. Because this hash is checkpoint-validation-only (never compared across processes,
never persisted, never part of a golden/parity gate), an implementer has more latitude here than
elsewhere — but must still be **exactly self-consistent** between the produce and validate sides
of one Rust process, which is automatically satisfied by construction as long as both sides use
the same serializer.

### 8.5 No other hashing/serialization in either file

`intrinsicReconstructionPortfolio.ts` does not call `createHash` or `JSON.stringify` anywhere.
Canonical-geometry hashing (`canonicalGeometryHash` fields throughout) is always produced
upstream by `measureIntrinsicSheetlessCompletedLayout`/`makeIntrinsicSharedArchiveEndpoint`
(external) and merely threaded through this cluster's data structures unchanged.

---

## 9. Caches touched and the exact historical access sequence

**Neither target file owns, reads, or writes any cache.** Both are pure orchestration/composition
layers over `constructIntrinsicStrictState`, which is where NFP/IFP/transformed-geometry caching
happens (external, characterized by other Stage-0 clusters). There is no cache-key construction,
lookup, staleness check, or publication logic anywhere in
`intrinsicReconstructionPortfolio.ts` or `intrinsicPlaceDeferCompleteShadow.ts`. The only
"cache-like" structures in this cluster are the two in-memory `Map`s already covered in §4/§5
(`orderOwners`, `unique`), both of which are per-call, function-scoped, and never persisted or
shared across calls — they are deduplication/lookup structures, not caches in the migration
prompt's §13 sense (no reuse across invocations, no staleness, no telemetry).

---

## 10. Cancellation / deadline / budget / evaluation-cap observation points

### 10.1 `runIntrinsicReconstructionPortfolio` — two independent deadline mechanisms

1. **Pre-decode wall-clock check**, once per spec, before starting that spec's decode:
   `remainingTotalMs = maximumTotalRuntimeMs - (performance.now() - startedAt); if
   (remainingTotalMs <= 0) { push deadline; continue }` (`:195-200`). This only catches an
   *already-exhausted* total budget between specs — it cannot interrupt a spec mid-decode.
2. **In-decode cooperative cancellation/deadline**, delegated entirely to
   `constructIntrinsicStrictState` via `maximumRuntimeMs: Math.min(maximumRuntimeMsPerDecode,
   remainingTotalMs)` (`:227`) and the optional `control` (`:229`). The portfolio function itself
   never polls `control.checkpoint` directly — all cooperative-cancellation points are inside the
   external decoder (`intrinsicStrictDecoder.ts:475-483,584`, see §2.3). The portfolio only
   distinguishes the *result* via `Effect.catchTag('IrregularNfpIfpControlAbortError', ...)`
   (`:235-242`): `reason === 'cancelled'` propagates as a hard failure (aborts the whole
   `Effect.gen`, and transitively the whole job per §2.4); any other reason (i.e. `'deadline'`) is
   downgraded to a normal `{ status: 'deadline' }` outcome that continues the `for` loop to the
   next spec.
3. **Evaluation-cap check**, once per spec, computed *before* the decode call:
   `remainingCandidateEvaluations = maximumTotalCandidateEvaluations === undefined ? undefined :
   maximumTotalCandidateEvaluations - consumedCandidateEvaluations; if (remainingCandidateEvaluations
   !== undefined && remainingCandidateEvaluations <= 0) { push evaluation-cap; continue }`
   (`:201-211`) — this is the *pre-flight* cap check (total budget already exhausted by a prior
   spec in this same call). The *in-decode* cap check happens inside
   `constructIntrinsicStrictState`'s own loop (`intrinsicStrictDecoder.ts:620-631`, per candidate,
   see §2.3) and is surfaced back to the portfolio via
   `outcome.constructed.truncationReason === 'maximum-candidate-evaluations'` (`:254-257`).

Both the total-runtime and total-evaluation "remaining budget" quantities are recomputed **fresh
at the top of every spec iteration** from `startedAt`/`consumedCandidateEvaluations` — they are
not decremented incrementally in a way that could drift; a Rust port using a simple subtraction at
loop-top each iteration reproduces this exactly.

### 10.2 `runIntrinsicPlaceDeferCompleteShadow` — single fixed-budget decode, no per-call remaining-budget bookkeeping

Because this function always performs at most one `constructIntrinsicStrictState` call (no loop
over specs), it passes the two module constants directly and unconditionally:
`maximumCandidateEvaluationCount: INTRINSIC_PLACE_DEFER_EVALUATION_CAP` (`19_862`),
`maximumRuntimeMs: INTRINSIC_PLACE_DEFER_RUNTIME_CAP_MS` (`35_000`) (`:185-186`). There is no
"remaining budget across multiple attempts" concept here, unlike §10.1. `input.control` is spread
conditionally as in §3.1 (`:188`) — all actual cooperative-checkpoint calls happen inside the
external decoder, not in this file.

### 10.3 `observeIntrinsicPlaceDeferCompleteShadow` — the sole cancellation-vs-censoring boundary

```ts
runIntrinsicPlaceDeferCompleteShadow(input).pipe(
  Effect.catch((error) => {
    if (error._tag === 'IrregularNfpIfpControlAbortError' && error.reason === 'cancelled') {
      return Effect.fail(error)   // re-raise, aborts the parent job
    }
    // ... build a 'censored' settled result for every other error shape
  })
)
```
(`:245-279`). This is the exact rule the module's own docstring states (`:234-237`): "Explicit
user cancellation remains the sole failure that may abort the parent job." All four other
`censoringReason` values (`'deadline' | 'capacity-error' | 'strict-decoder-error' |
'geometry-error'`, `:87-92`) are derived purely from `error._tag` matching
(`:253-259`): `IrregularNfpIfpControlAbortError` (non-cancelled, i.e. `reason === 'deadline'`) →
`'deadline'`; `IntrinsicCapacityError` → `'capacity-error'`; `IntrinsicStrictDecoderError` →
`'strict-decoder-error'`; anything else (i.e. `IrregularGeometryInputError` or
`IrregularNestingNotImplementedError`, the only other members of `IntrinsicPlaceDeferError`) →
`'geometry-error'`. This four-way tag dispatch order (`:255-259`) must be reproduced exactly if
the Rust error taxonomy differs in shape from the TS tagged-union.

---

## 11. Error paths

### 11.1 `intrinsicReconstructionPortfolio.ts`

`IntrinsicReconstructionPortfolioError` (`:99-104`, `Data.TaggedError`) — fields `operation: 'seed'
| 'order' | 'archive'`, `message: string`. Only ever constructed with `operation: 'seed'`
(`:152-157`), when `selectReconstructionEndpoint(input.baselineSeeds)` returns `undefined` — which
itself only happens if `rankIntrinsicStrictCompletedLayouts(seeds.map(m => m.metrics))[0]` is
`undefined`, i.e. `baselineSeeds` is empty (not reachable in production, which always supplies
exactly one seed at `computeIrregularNesting.ts:830-838`). The `'order'`/`'archive'` operation
variants are declared but **dead** (§2.1). `PortfolioError` (`:106-112`) is a union additionally
including `IntrinsicStrictDecoderError`, `IrregularNestingNotImplementedError`,
`IrregularGeometryInputError`, `IrregularNfpIfpControlAbortError` — all of these simply propagate
unmodified out of the `Effect.gen` (no local `catchTag`/`catchAll` except the one cancellation
vs. deadline distinction already covered in §10.1 item 2). The caller
(`computeIrregularNesting.ts:850-865`) is the actual place all of these get normalized into either
a hard job failure (cancellation) or a soft `'failed-protected-fallback'` trace (everything else),
per §2.4.

### 11.2 `intrinsicPlaceDeferCompleteShadow.ts`

`IntrinsicCapacityError` (external, `intrinsicCapacityPreflight.ts:19-22`, imported at `:15`) is
constructed exactly once in this file: `operation: 'placeDeferCheckpoint'` when
`validatePlaceDeferCheckpoint` returns a non-`undefined` message (`:142-150`). `IntrinsicPlaceDeferError`
(`:119-124`) is a union of `IntrinsicCapacityError | IntrinsicStrictDecoderError |
IrregularNestingNotImplementedError | IrregularGeometryInputError |
IrregularNfpIfpControlAbortError` — same "propagate unmodified" pattern as §11.1;
`runIntrinsicPlaceDeferCompleteShadow` itself does no internal `catchTag`. All of that union is
absorbed by `observeIntrinsicPlaceDeferCompleteShadow`'s catch-all except cancellation (§10.3).

`validatePlaceDeferCheckpoint` (`:335-438`) returns `string | undefined` (a message or no error) —
**not** a thrown exception — and encodes seven independent groups of invariants, each returning a
different fixed message on the first-failing check within that group (checked in this file order,
short-circuited by early `return`):
1. version/fingerprint mismatch (`:355-360`)
2. producer/cohort/eligibility mismatch (`:361-367`)
3. partition completeness/uniqueness (`:368-374`, uses the `.toSorted()` set-equality check from
   §5.1)
4. pending/deferred/order/state-remaining exact-sequence match against the deterministic
   from-scratch transition (`:375-393`)
5. zero-state accounting (placed count, doubled area, cavity counts, occupied-identity match,
   fit-mask) (`:394-406`)
6. deferral-counter shape (`:407-417`)
7. resume-position/ledger/settlement fields all at their frozen initial values (`:418-436`)

A Rust port must preserve this exact seven-group check order and exact per-group message text if
any test or diagnostic ever asserts on the message string (none of the read test files assert on
the message text itself, only on `_tag`/`operation`, per §11.3 — but preserve message text anyway
per the migration prompt's "error provenance" freeze rule, §2).

### 11.3 Test-observed error shapes

`tests/unit/intrinsicCapacityMode.test.ts:1211-1214` asserts
`{ _tag: 'IntrinsicCapacityError', operation: 'placeDeferCheckpoint' }` on a mutated checkpoint.
`tests/unit/intrinsicReconstructionPortfolio.test.ts:361-364` and
`tests/unit/intrinsicCapacityMode.test.ts:1259-1262` both assert `{ _tag:
'IrregularNfpIfpControlAbortError', reason: 'cancelled' }` propagates through to the caller
unmodified — confirming cancellation is never caught/converted by either target file.

---

## 12. JS-specific semantics hazards for a Rust port

1. **Mixed use of `localeCompare` vs. default array sort within the same cluster.** Piece-id tie
   breaks use `.localeCompare` (`:393,415,574`, and externally
   `intrinsicStrictDecoder.ts:2307,2332` on hash strings); ring-canonicalization and checkpoint
   partition-equality use plain `.toSorted()`/default comparator (`:594`,
   `intrinsicPlaceDeferCompleteShadow.ts:371`). These are **not interchangeable** — `localeCompare`
   is locale/ICU-dependent (Node's ICU build, default locale) while default sort is UTF-16
   code-unit order. `PieceId` values in this codebase are typically DXF-import-derived or
   test-literal ASCII strings, so the two orders coincide in practice today, but a Rust port must
   pick the *matching* strategy per call site (`str::cmp` for the default-sort sites; an
   ICU-equivalent or a proven-equivalent-for-the-actual-alphabet ordering for the
   `localeCompare` sites) rather than uniformly using Rust's default `Ord for str` everywhere.
2. **`Array.prototype.sort`/`toSorted` stability.** Relied upon implicitly wherever a comparator
   chain can produce a `0` result for non-identical elements (theoretically possible for
   `buildCanonicalEndpointOrders`'s comparator if two distinct pieces somehow shared a `PieceId`,
   and for the transforms-sort in `intrinsicPreparedPieceClassKey` if two transform candidates
   shared identical `index`). Rust's `sort()`/`sort_by()` is stable by default (`sort_unstable`
   is not) — use the stable variant throughout this cluster.
3. **Signed-zero folding via `x === 0 ? 0 : x`** (`canonicalLayoutGeometry.ts:100-101`, external
   but directly consumed at `:368`). `-0 === 0` is `true` in JS; the ternary's `0` branch
   literal always substitutes positive zero. In Rust, `if x == 0.0 { 0.0 } else { x }` produces
   the same fold under IEEE-754 `==` semantics — verify this exact pattern is used, not a `.abs()`
   or `.signum()`-based reconstruction that could diverge for `-0.0` vs `+0.0` display/hash
   purposes elsewhere.
4. **Default `JSON.stringify` object-key order dependency in `intrinsicPlaceDeferFingerprint`**
   (§8.4) — depends on the field-declaration order of every Effect Schema class reachable from
   `preparedPieces`, not just this file's own object literal. A naive Rust `serde_json`
   `Serialize` derive on a `struct` with different field order (or a `HashMap`-typed sub-field)
   would silently produce a different byte sequence and therefore a different fingerprint hash —
   harmless for this specific use (checkpoint self-consistency only, §8.4), but the same pattern
   recurs elsewhere in the codebase for artifacts that *are* parity-gated, so treat this as a
   worked example of the general hazard, not just a local concern.
5. **`Number` safe-integer bounding as the sole guard against float/precision hazards** in this
   cluster (`toGridMm`'s `Number.isSafeInteger` check, §7.1/7.3) — every downstream arithmetic
   operation on grid coordinates in `intrinsicPreparedPieceClassKey`/`buildCanonicalEndpointOrders`
   implicitly trusts that guard already ran. A Rust port must apply an equivalent bounds check
   (`i64`/`i32` fits, or an explicit safe-integer-equivalent check before any `f64`-to-int cast) at
   the exact same upstream point, not re-derive it locally in this cluster's files.
6. **`Object.entries` on `Record<string, number>` (`deferralCounts`)** — general JS hazard (integer-
   like string keys iterate in ascending numeric order ahead of insertion-ordered string keys) is
   present in the type (`intrinsicPlaceDeferCompleteShadow.ts:45`) but **not currently
   exploitable** within this file: `makePlaceDeferCheckpoint` only ever constructs a 0- or 1-entry
   record (`:314-315`), and `validatePlaceDeferCheckpoint`'s checks on `Object.entries(...)`
   (`:407-417`) reject anything with more than one entry regardless of order. Flagged for
   completeness; not a live hazard in this cluster today, but do not assume that remains true if
   this checkpoint type is ever reused with multi-entry deferral counters elsewhere.
7. **No `Map`/`Set` iteration ever reaches output in either file** (§5.2) — both `Map`s in this
   cluster are keyed-lookup-only. This is a *reassurance*, not a hazard: a Rust `HashMap` is safe
   to use for `orderOwners` and `unique` (no need for `BTreeMap`/insertion-order-preserving maps)
   as long as the last-write-wins/first-write-wins overwrite semantics documented in §5.2/§4.2 are
   reproduced through the *loop order*, not through map iteration.

---

## 13. Parallelism assessment

### 13.1 Safe/independent subcomputations

- **Per-spec `intrinsicPreparedPieceClassKey` computation** (used inside
  `intrinsicReconstructionEffectiveOrderKey`, `:548`) is pure and depends only on one piece's own
  fields — computing all pieces' class keys for a given spec's piece list in parallel and then
  joining serially in original order is safe and observably identical, *provided* the join step
  remains strictly ordered by the original array index (do not let a parallel map reorder the
  pieces array itself).
- **`buildCanonicalEndpointOrders`'s four `order(role)` calls** (`:418-423`) are independent pure
  functions of the same `positions` map and `pieces` array — safe to compute the four orders in
  parallel (e.g. via Rayon) and then assemble the returned array in the fixed
  `[q0-ltr, q0-rtl, q90-ltr, q90-rtl]` order serially, since each call only reads shared immutable
  data and produces its own independent `Vec`.
- **`buildIntrinsicReconstructionSpecs`'s spec-list construction** (`:301-339`) is pure and
  side-effect-free; safe to construct off the hot path or in parallel with other setup work, as
  long as the final concatenation order (`:312-338`) is preserved exactly for the serial spec loop
  that follows.

### 13.2 Chronology-bound, must stay logically serial

- **The main spec-processing `for` loop in `runIntrinsicReconstructionPortfolio`** (`:172-286`)
  is **not** parallelizable as an uncontrolled cohort: each iteration (a) reads and conditionally
  mutates the shared `orderOwners` map (duplicate detection depends on *prior* iterations' writes
  within the same call, §4.1/§5.2), (b) reads and mutates the shared running totals
  `consumedCandidateEvaluations`/`candidateEvaluationAccountingComplete` which gate later
  iterations' cap checks (§10.1 items 1/3), and (c) the total-runtime remaining-budget check
  (`:195`) is a function of wall-clock elapsed time since `startedAt`, which is inherently
  order/timing-sensitive. This matches the migration prompt's explicit high-risk-boundary
  category "depth transitions before all required ordered results exist" / budget-consuming loops
  (§14.2 of the governing prompt). The *expensive* pure work inside one iteration
  (`constructIntrinsicStrictState`) could in principle be internally Rayon-parallelized (a
  decision for the strict-decoder cluster, out of scope here) while the outer spec loop itself
  remains serial.
- **`retainIntrinsicReconstructionArchive`'s three-phase `unique` → `rankedMetrics` → `append`
  pipeline** (`:427-473`) has a hard serial dependency: `append`'s capacity/uniqueness bound
  (`:461-464`) depends on the exact prior sequence of `append` calls (frontier leader, then
  protected seeds in order, then ranked runs in order) — parallelizing the `append` calls would
  change which runs get admitted when the archive is at capacity. This function is dead on the
  production path (§1.1) but is unit-tested and must not silently change behavior if ever
  parallelized.
- **`runIntrinsicPlaceDeferCompleteShadow`** has no internal loop to parallelize; its single
  `constructIntrinsicStrictState` call is the only expensive step, and any parallelism there is
  the strict-decoder cluster's concern, not this file's.
- **Cross-file:** the reconstruction portfolio call and the place-defer shadow call are both
  invoked from `computeIrregularNesting.ts` at points where the shadow call's result feeds only a
  diagnostic callback (§1.2) — they have no data dependency on each other and, if both are enabled
  simultaneously (extremely rare given the shadow module's opt-in-only production status), could
  in principle run concurrently. However, the migration prompt's high-risk list explicitly warns
  against "complete versus capacity producer races" and "direct producer roles whose chronology
  affects scheduler traces" (§14.2) — both calls contribute to
  `intrinsicAnytimeSchedulerTrace.quanta`, an append-ordered list
  (`computeIrregularNesting.ts:785-799` for the shadow call), so running them concurrently would
  require deterministically reordering that trace append afterward rather than naively racing the
  two `Effect`s. Treat this as **not currently a target for parallelization** absent a specific
  redesign of the trace-append mechanism.

---

## 14. Tests and gates covering this cluster

### 14.1 Direct unit tests

- `tests/unit/intrinsicReconstructionPortfolio.test.ts` (367 lines) — exercises
  `buildCanonicalEndpointOrders`, `buildIntrinsicReconstructionSpecs`,
  `intrinsicReconstructionSpecMatchesFamily`, `intrinsicReconstructionEffectiveOrderKey`,
  `retainIntrinsicReconstructionArchive` (including the capacity-override and protected-seed
  cases), and `runIntrinsicReconstructionPortfolio` end-to-end for deadline, evaluation-cap, and
  cancellation-propagation behavior (`:291-365`).
- `tests/unit/intrinsicCapacityMode.test.ts`, `describe('experimental place/defer complete
  shadow', ...)` block (`:1133-1264`) — exercises `runIntrinsicPlaceDeferCompleteShadow` pause/
  resume/checkpoint-rejection and `observeIntrinsicPlaceDeferCompleteShadow` censoring/
  cancellation-propagation directly (bypassing `computeIrregularNesting.ts`).

### 14.2 Integration/golden tests that exercise this cluster through `computeIrregularNesting.ts`

- `tests/unit/intrinsicCapacityIntegration.test.ts:165-234` — `'runs focused complete
  reconstruction by default and preserves the protected duplicate fallback'`: the single
  production golden path proving `'duplicate-order'` → `outputInfluence: 'protected-fallback'`
  is reachable and that `focusedCompleteReconstructionControlArm: 'disable'` fully suppresses the
  trace (`disabled.focusedCompleteReconstructionTrace` is `undefined`).
- `tests/unit/intrinsicCapacityIntegration.test.ts:370-413` — asserts
  `'skipped-no-fitting-protected-endpoint'` when the complete archive misses.
- `tests/unit/intrinsicCapacityIntegration.test.ts:271-320` — asserts
  `'skipped-preflight-proven-impossible'`.
- `tests/unit/intrinsicCapacityIntegration.test.ts:618-666` — exercises
  `captureExperimentalPlaceDeferCompleteShadow: true` end-to-end and asserts
  `experimentalPlaceDeferTrace?.outputInfluence === 'none'` and that placed/unplaced geometry is
  byte-identical to the non-shadow run.
- `tests/unit/irregularSeventeenShapesCompactGolden.test.ts:36-129` — **the one golden test where
  focused reconstruction actually wins** (`outputInfluence: 'selected'`,
  `consumedCandidateEvaluations: 8_035`, sourced from a fixed 17-DXF-file fixture directory,
  asserting an exact SHA-256 `EXPECTED_CANONICAL_HASH` on the final selected layout). This is the
  highest-value differential/golden test for a Rust port of this cluster's live code path — any
  Rust divergence in `buildCanonicalEndpointOrders`, the duplicate-order key, or the
  evaluation-cap/deadline bookkeeping that changes which candidate the reconstruction decode
  reaches at evaluation 8,035 will change this hash.

### 14.3 Non-gated dev tooling (not run in CI, not a correctness gate)

- `scripts/irregular-intrinsic-shared-archive.ts:291-306` and
  `scripts/irregular-intrinsic-v7-seed-archive.ts:214-230` both call
  `runIntrinsicReconstructionPortfolio` directly for offline benchmarking/seed-archive generation.
  Neither script appears in `package.json`'s `scripts` block (confirmed by grep), so neither is a
  CI/production gate; still useful as manual differential-testing harnesses during the Rust port.

### 14.4 What is *not* covered

No test directly asserts on `retainIntrinsicReconstructionArchive`'s output byte-for-byte against
a golden hash — only structural (`role`/`canonicalGeometryHash` list) assertions. No test exercises
`buildIntrinsicReconstructionSpecs`/`runIntrinsicReconstructionPortfolio` with `roleFamily:
'pure-growth'` or `'gap-contained'` through the production caller (only through direct unit tests
and dev scripts) — those two family values are effectively untested against real production
request shapes.

---

## 15. Open questions and ambiguities

1. **The "12000 focused-evaluation cap" is not a constant inside either characterized file.** It
   is a parameter supplied by the sole production caller
   (`computeIrregularNesting.ts:846-847`, `maximumCandidateEvaluationsPerDecode: 12_000,
   maximumTotalCandidateEvaluations: 12_000`). The migration prompt's own summary of "production
   values" (§11 of `docs/prompts/fable5-rust-irregular-nesting-implementation.md`) lists capacity
   constants (beam width 16, quota 4,096, etc.) but does not mention this reconstruction cap at
   all — **the orchestrator should confirm where this constant is intended to live in the Rust
   port** (co-located with the orchestrator call site, as in TS, versus promoted into the
   reconstruction-portfolio module itself as a named default). This document recommends mirroring
   the TS structure exactly (caller-supplied, no module default) to avoid introducing a behavior
   difference if the caller and the module ever need independently-tunable values again.
2. **`retainIntrinsicReconstructionArchive`'s `.archive`/`.winner` fields are dead on the
   production path today** (§1.1, §2.1). The orchestrator should explicitly decide whether the
   Rust port (a) still implements this function bit-for-bit (required if the existing unit tests
   remain gating, per the migration prompt's test-immutability rule) but need not wire it into any
   hot path, or (b) treats it as lower priority for the parallelism/perf work in Stages 3-4 since
   it currently contributes zero production value. Recommendation: implement for parity/test
   purposes, but do not spend Rayon-parallelization effort on it without a fresh instruction, since
   the migration prompt only asks for performance improvement on the *production* path.
3. **`retainIntrinsicReconstructionArchive`'s protected-seed role check omits `'settled-protected'`**
   (§6.4) — confirm this is intentional TS behavior to preserve verbatim (per this document's
   analysis, yes: it is exercised by existing tests with only the other two roles, and changing it
   would be an unrequested behavior change), not a latent bug the orchestrator wants fixed as an
   explicit, separately-ruled-on exception to the semantic-freeze rule.
4. **`intrinsicPlaceDeferCompleteShadow.ts` is entirely opt-in/diagnostic and not part of the
   migration prompt's §4.1 "Included" scope list.** Confirm with the orchestrator whether Stage 1/2
   should port it at all in the first cut, or defer it (it has no effect on selected layouts, so
   deferring carries no correctness risk to Compact/Compact Short Side, only to the diagnostic
   surface's availability if `captureExperimentalPlaceDeferCompleteShadow` is ever flipped on in a
   real request).
5. **`localeCompare` call sites (§5.1, §6.1, §6.3, and externally in `intrinsicStrictDecoder.ts`)
   are a genuine Node-ICU-version dependency.** Recommend the orchestrator pin/record the exact
   Node ICU build used to produce the existing golden hashes (including
   `EXPECTED_CANONICAL_HASH`/`EXPECTED_PROTECTED_SOURCE_HASH` in
   `irregularSeventeenShapesCompactGolden.test.ts:30-33`) as part of Stage 0's evidence capture, and
   verify empirically (not just by inspection) that the Rust equivalent produces byte-identical
   ordering for every `PieceId`/hash-string alphabet actually seen in the golden fixtures, since
   `localeCompare`'s default-locale behavior is not literally specified by ECMA-402 to be
   byte-stable across Node versions.
6. **`intrinsicQueueBeamDiscriminator.ts` (4,812 lines) has zero production importers** despite
   importing this cluster's `intrinsicPreparedPieceClassKey` and looking, by name and content, like
   a capacity-search discriminator. This is outside this cluster's assigned scope, but is flagged
   here because it was discovered while tracing callers of this cluster's exports, and the
   orchestrator should confirm whether it is genuinely dead code (candidate for exclusion from the
   Rust port entirely) or a staged/half-landed feature the migration should still account for.
