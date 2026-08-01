# Characterization: checkpoint-encoding cluster

This document is a specification extracted from the current TypeScript source,
not a design proposal. Per the governing migration prompt
(`docs/history/prompts/fable5-rust-irregular-nesting-implementation.md`, sections 2, 8,
9, 13, 14), the TypeScript behavior below — including anything that looks
unusual, redundant, or historically ordered — IS the contract for the Rust
port.

## Scope and why this cluster has no single "file"

There is no dedicated checkpoint-encoding module. "Checkpoint encoding" is a
capability duplicated, with small but load-bearing differences, inside three
independent producer files. This document was built by grepping
`src/workers` for `checkpoint`, `canonicalJson`, `stringify`, `integrity`,
`fingerprint`, `sha256`, `activeRuntimeMs`, `timingNow` (full grep transcript
reproduced in spirit below) and then reading every match's surrounding
function completely. The three genuine resumable-checkpoint producers are:

1. `src/workers/algorithm/irregular/intrinsicCapacitySearch.ts` (2,272 lines
   total; every checkpoint-relevant function read in full for this document —
   `IntrinsicAnytimeCheckpoint`, version `'intrinsic-anytime-checkpoint-v3'`,
   defined `:154-172`, constant at `:61`). This file is also the primary
   subject of the sibling `capacity-search.md` cluster document, which
   independently derived and exhaustively enumerated every field of this same
   checkpoint's per-branch validation walk (`capacity-search.md` §9,
   "Checkpoint pause boundary"). This document does not re-derive that
   branch-by-branch walk; it cross-references it and instead focuses on the
   byte-level encoding contract, the cross-file comparison, and the
   timing-seam gap that `capacity-search.md` also flags but does not treat as
   its primary subject.
2. `src/workers/algorithm/irregular/intrinsicStrictDecoder.ts` (2,363 lines
   total; every checkpoint-relevant function read in full for this document —
   `IntrinsicStrictDirectCheckpoint`, version
   `'intrinsic-strict-direct-checkpoint-v1'`, defined `:185-197`, constant at
   `:182-183`). Also the primary subject of the sibling
   `strict-decoder-gap-family.md` cluster document (its §3.6, §9-§10 already
   walk this checkpoint's construction, validation, and lineage-recomputation
   branches in full). Cross-referenced, not re-derived, for those branches.
3. `src/workers/algorithm/irregular/intrinsicPlaceDeferCompleteShadow.ts` (464
   lines, read completely for this document — not a primary file of any
   sibling cluster document; this is new ground). `IntrinsicPlaceDeferCheckpoint`,
   version `'intrinsic-place-defer-checkpoint-v1'`, defined `:31-75`, constant
   at `:26-27`. This is a **non-authoritative shadow producer** (see §1).

A fourth, closely related but **not a checkpoint**, encoder exists in
`src/workers/algorithm/irregular/intrinsicPeriodicFamilyPortfolio.ts:1285-1293`
(`canonicalJson`, used only for source-audit replay-envelope digests — no
`version`/`integrityHash`/resumable-state fields at all). It is the primary
subject of the sibling `periodic.md` document (§5 item 17, §8). It is included
here **only** as a fourth data point in the cross-encoder comparison (§8),
because it shares the "`canonicalJson`-shaped hash-preimage builder" pattern
and because its divergence from the other three is itself evidence that no
single shared "canonical JSON encoder" exists in this codebase (see §15).

Two more files are read partially, to establish orchestration chronology and
a terminology hazard, and are cross-referenced rather than characterized in
full (they are primary subjects of other clusters):

- `src/workers/algorithm/irregular/computeIrregularNesting.ts` — the
  coordinator that owns checkpoint pause/resume chronology across producers
  (§1, §13). Primary subject of `capacity-core.md`.
- `src/workers/algorithm/irregular/intrinsicSharedArchivePortfolio.ts` — owns
  the production `while(true)` resume loop that drives
  `IntrinsicStrictDirectCheckpoint` in production (§1, §2). Not a primary
  file of any sibling document at the time of writing; the relevant loop
  (`:261-333`) is read completely here.
- `src/workers/algorithm/irregular/irregularBeamState.ts` — every checkpoint's
  `state` field holds a live instance of this class by reference (§3, §12).
  Its public surface used by this cluster is documented in `capacity-core.md`
  §2; this document adds only the `timingNow` seam fact (§10).
- `src/workers/irregular/services.ts:77-89` — defines
  `IrregularNfpIfpControl.checkpoint(phase)`, a **same-named, unrelated**
  cooperative-cancellation observation point (§1 terminology note, §10).

---

## 1. Purpose and role in Compact / Compact Short Side execution

### 1.1 Two unrelated meanings of "checkpoint" in this codebase — read this first

The word "checkpoint" is heavily overloaded in this codebase and a Rust
implementer must not conflate the two meanings:

- **Resumable-state checkpoint** (this document's subject): an object shaped
  like `{ version, requestFingerprint, integrityHash?, ...frontier/state
  fields }` that lets a long search be paused and later resumed with a
  byte-identical continuation. There are three of these (§0 list).
- **Cooperative-cancellation checkpoint**: `IrregularNfpIfpControl.checkpoint(phase:
  IrregularNfpIfpCheckpointPhase)` (`services.ts:77-89`), a zero-argument-per-call
  polling point that returns `Effect.fail(IrregularNfpIfpControlAbortError)`
  when cancelled/deadline-exceeded, or `Effect.void` otherwise. This is a
  **call**, not a serializable object, and it has no encoding. It is invoked
  pervasively (every checkpoint producer in this document calls it at least
  once — see §10) and its per-phase counters are tallied, diagnostics-only,
  by `NfpIfpCheckpointCounters` (`src/workers/irregular/nfpIfpTelemetry.ts:47-56`).
  This mechanism belongs to other clusters (`nfp-ifp.md`, `worker-coordination.md`);
  it is mentioned here only to disambiguate the name and because every
  resumable-checkpoint producer also calls it internally.

### 1.2 What the resumable checkpoint mechanism is for

All three resumable checkpoints exist to let an anytime/depth-first search be
interrupted at a specific, exact "decision boundary" (a completed depth for
capacity search, a committed piece for the strict decoder, a single deferred
piece for the place-defer shadow) and later resumed with **exactly** the same
continuation the uninterrupted run would have produced — same evaluation
counts, same trace, same endpoint. This is not primarily an I/O/persistence
feature: as established in §3 and §12, no checkpoint is ever actually
serialized to a JSON string or written anywhere in production; the encoding
exists to compute a **tamper/consistency-evidence hash**, not a wire format.

### 1.3 Liveness on the production Compact / Compact Short Side path (traced, not assumed)

**`IntrinsicAnytimeCheckpoint` (capacity search) — live, authoritative.**
`runIntrinsicCapacitySchedulerColdQuantum` is called
(`schedulerEnabled = true`, `computeIrregularNesting.ts:604`) inside
`coordinateIntrinsicSharedArchive`, specifically in the `else` branch of `if
(preflight.kind === 'proven_impossible')` (`computeIrregularNesting.ts:569,
603`) — i.e. whenever `archiveEnabled` (`:483,504`) **and** preflight is
inconclusive (when preflight already proves impossibility, capacity mode is
invoked directly with `routing: 'preflight-proven-impossible'`,
`:583-593`, and this scheduler cold-quantum path is skipped entirely). This
inconclusive-preflight branch is a **cold-search checkpoint
pause after a fixed depth quantum**
(`INTRINSIC_ANYTIME_SCHEDULER_COLD_QUANTUM_DEPTHS = 4`, defined in
`intrinsicCapacityMode.ts:383` and imported into `computeIrregularNesting.ts`
for trace display at `:620`). The resulting
`scheduledColdStart.checkpoint` is then interleaved with the complete/
sheetless archive's own per-completed-piece checkpoint callback
(`onCanonicalGridCheckpointed`, `computeIrregularNesting.ts:650-703`): each
time the canonical-grid direct role reaches a completed-piece boundary, the
callback resumes the paused capacity checkpoint for exactly one more depth
boundary (`maximumDepthBoundaries: 1`, `computeIrregularNesting.ts:678`) via
`runIntrinsicCapacitySchedulerColdQuantum({ checkpoint, maximumDepthBoundaries: 1,
... })`. If capacity mode is later actually invoked (preflight-proven-impossible
or complete-archive-miss routing), the final `scheduledColdStart` — checkpoint
and all — is passed through as `scheduledColdStart` input
(`computeIrregularNesting.ts:969-976`, cited in `capacity-core.md`). This
checkpoint therefore genuinely crosses function-call boundaries **during
production execution of every archive-eligible request**, not merely in
tests.

**`IntrinsicStrictDirectCheckpoint` (strict/E1 decoder, `'canonical-grid'`
role only) — live, authoritative.** `runIntrinsicSharedArchivePortfolio`'s
per-direct-role loop (`intrinsicSharedArchivePortfolio.ts:261-333`, read
completely for this document) runs a `while (true)` loop for each of the
three `INTRINSIC_SHARED_ARCHIVE_DIRECT_ROLES` (`:41-44`:
`'canonical-grid'`, `'legacy-absolute-envelope'`, `'open-pocket-first'`).
Only for `role === 'canonical-grid'` **and** when
`options.canonicalGridCompletedPieceQuantum !== undefined` does the call pass
`maximumCompletedPieceBoundaries: options.canonicalGridCompletedPieceQuantum`
(`:288-296`). The production coordinator always supplies
`canonicalGridCompletedPieceQuantum: 1` (`computeIrregularNesting.ts:649`),
so in production this loop pauses the canonical-grid role's `constructIntrinsicStrictState`
call after **every single committed piece**, receives back
`outcome.constructed.checkpoint`, invokes
`options.onCanonicalGridCheckpointed?.(checkpoint)` (`:311`) — which is
exactly the callback wired to the capacity-cold-quantum resume above — and
then re-enters the loop passing that same `checkpoint` object back into
`constructIntrinsicStrictState` as `input.checkpoint` (`:288`) to continue.
The loop terminates when `outcome.constructed.checkpoint === undefined`
(construction settled with no pause pending, `:304-306`). The other two
direct roles (`'legacy-absolute-envelope'`, `'open-pocket-first'`) never
receive `maximumCompletedPieceBoundaries`, so `constructIntrinsicStrictState`
for those runs to completion in one call and their `IntrinsicStrictDirectCheckpoint`
machinery is dead code for those two roles specifically (checkpoint-producing
branches inside `constructIntrinsicStrictState` are still generic/shared code
across all producer roles — see §2 — so "dead" here means "the pause
condition is never satisfied for these two roles in production," not "a
separate code path").

**`IntrinsicPlaceDeferCheckpoint` — not live in production; test-only shadow.**
`runIntrinsicPlaceDeferCompleteShadow`/`observeIntrinsicPlaceDeferCompleteShadow`
are reached from `computeIrregularNesting.ts` **only** when
`input.options?.captureExperimentalPlaceDeferCompleteShadow === true`
(`computeIrregularNesting.ts:777`). Grepping the entire repository for this
flag finds exactly two production-code definition sites (the option's type
declaration at `computeIrregularNesting.ts:157` and its single read at
`:777`) and two **test** call sites
(`tests/unit/intrinsicCapacityIntegration.test.ts:391,632`) — no production
preset, CLI flag, or default ever sets it. Its own type (`IntrinsicPlaceDeferTrace.outputInfluence:
'none'`, `intrinsicPlaceDeferCompleteShadow.ts:101`) self-documents this: even
when captured, its only effects are an optional diagnostic callback
(`onExperimentalPlaceDeferCompleteEndpoint`) and one extra `'experimental-complete'`
scheduler-trace quanta entry (`computeIrregularNesting.ts:786-798`); it never
enters `retainIntrinsicAnytimeArchiveNamespace` (`intrinsicAnytimeArchive.ts`,
per `capacity-core.md` §1) or otherwise influences `selected`. It is included
in this document because the task explicitly requires characterizing "every
producer/consumer of resumable checkpoint state," and because its checkpoint
shape deliberately mirrors (with small, telling differences — §3, §8) the
live capacity checkpoint's shape, which is useful evidence for what is/is not
essential to the encoding contract.

---

## 2. Entry points, callers, callees (traced, not guessed)

### `intrinsicCapacitySearch.ts`

- `runIntrinsicCapacityColdSearch(input)` (exported, primary entry point;
  `intrinsicCapacitySearch.ts:335` region per `capacity-search.md` — not
  re-cited exhaustively here). Accepts `input.checkpoint?: IntrinsicAnytimeCheckpoint`
  to resume (`:262` field), and `input.maximumDepthBoundaries?: number` to
  request a future pause. Returns `IntrinsicCapacitySearchResult` whose
  `checkpoint: IntrinsicAnytimeCheckpoint | undefined` field is present iff
  `status === 'paused'` (`:1000` sets `checkpoint: undefined` on `'settled'`;
  paused branch at `:922-931` always includes a defined `checkpoint`).
  Callers: `computeIrregularNesting.ts` via
  `runIntrinsicCapacitySchedulerColdQuantum` (a thin renaming wrapper —
  confirmed by import at `computeIrregularNesting.ts:606` binding the name
  `runIntrinsicCapacitySchedulerColdQuantum` — see `capacity-core.md` for the
  wrapper's own file), and `runIntrinsicCapacityMode`
  (`intrinsicCapacityMode.ts:400`, per `capacity-core.md` §2), and
  test/gate code (`tests/unit/intrinsicCapacityMode.test.ts`,
  `scripts/irregular-capacity-gate.ts`).
- `materializeIntrinsicCapacityCheckpointEndpoints(input)`
  (`intrinsicCapacitySearch.ts:1010-1048`, read completely for this
  document): a **read-only** consumer — converts a checkpoint's `frontier`
  into ranked `IntrinsicCapacityEndpoint`s, for reporting "best known so far"
  without resuming. Does not mutate or validate the checkpoint (no
  `validateIntrinsicCapacityCheckpoint` call in this function). Caller:
  `intrinsicCapacityMode.ts` (per `capacity-core.md` §2, used for the paused
  protected-lane "best-known" endpoint materialization; the doc comment at
  `intrinsicCapacitySearch.ts:1008-1009` — "the checkpoint itself remains
  resumable and unchanged" — makes this read-only contract explicit).
- Internal (not exported) checkpoint machinery, all read completely for this
  document: `makeIntrinsicCapacityCheckpoint` (`:1173-1252`),
  `validateIntrinsicCapacityCheckpoint` (`:1254-1501`),
  `intrinsicCapacityCheckpointIntegrityHash` (`:1503-1569`),
  `intrinsicCapacityRequestFingerprint` (`:1571-1610`),
  `intrinsicCapacityIncumbentBinding` (`:1612-1624`), `canonicalJson`
  (`:1626-1635`), `compareStrings` (`:2233-2237`).

### `intrinsicStrictDecoder.ts`

- `constructIntrinsicStrictState(input)` (exported,
  `intrinsicStrictDecoder.ts:401-866`, read completely for this document).
  Accepts `input.checkpoint?: IntrinsicStrictDirectCheckpoint` (`:284`) and
  `input.maximumCompletedPieceBoundaries?: number` (`:285`) and
  `input.timingNow?: () => number` (`:282`, see §10). Returns
  `IntrinsicStrictConstructResult` whose `checkpoint` field is present only
  when spread in at `:855` (`pauseReason === 'completed-piece-boundary' &&
  requestFingerprint !== undefined`); note this is a **true optional-key
  omission via conditional spread**, not an `undefined`-valued key — the key
  itself is absent from the returned object when not paused (see §3).
  Callers: `intrinsicSharedArchivePortfolio.ts:277` (production, 3 direct
  roles, §1), `intrinsicReconstructionPortfolio.ts:222`,
  `intrinsicPeriodicFamilyPortfolio.ts:317` (per `strict-decoder-gap-family.md`
  §1.2), `intrinsicPlaceDeferCompleteShadow.ts:180-189` (non-authoritative
  shadow, always with `candidateMode: 'pure-growth'`, no
  `maximumCompletedPieceBoundaries`/`checkpoint` — so this specific call site
  never itself produces or consumes an `IntrinsicStrictDirectCheckpoint`; the
  place-defer shadow has its own, structurally unrelated checkpoint type,
  §1, §3).
- `decodeIntrinsicStrictPriorityOrder` / `finalizeIntrinsicStrictState`
  (`:331-398`) — the non-checkpointed, single-call, run-to-completion entry
  points; irrelevant to this cluster except as evidence that checkpointing is
  strictly opt-in per call (`checkpointingEnabled` gate, `:431-432`, true iff
  `maximumCompletedPieceBoundaries !== undefined || input.checkpoint !==
  undefined`).
- Internal checkpoint machinery, read completely: `makeIntrinsicStrictDirectCheckpoint`
  (`:868-905`), `validateIntrinsicStrictDirectCheckpoint` (`:907-1019`),
  `intrinsicStrictDirectRequestFingerprint` (`:1021-1056`),
  `intrinsicStrictDirectCheckpointIntegrityHash` (`:1058-1078`),
  `collectIntrinsicStrictDirectStateLineage` (`:1080-1110`),
  `validateIntrinsicStrictDirectCheckpointLineage` (`:1113-1181`),
  `validateIntrinsicStrictDirectState` (`:1183-1224`),
  `intrinsicStrictDirectPhaseLedgerValid` (`:1225-1233`),
  `samePieceIds`/`samePieceIdSet` (`:1236-1256`), `intrinsicStrictCanonicalJson`
  (`:1257-1277`), `preparedPieceId`/`placedPieceId` (`:1386-1393`, per grep;
  small pure ID-projection helpers).

### `intrinsicPlaceDeferCompleteShadow.ts` (read completely for this document)

- `runIntrinsicPlaceDeferCompleteShadow(input)` (`:131-232`) — sole
  low-level entry point; accepts `input.checkpoint?: IntrinsicPlaceDeferCheckpoint`
  (`:115`) and `input.maximumDecisionBoundaries?: 1` (a **literal-`1`-only**
  type, `:116` — there is exactly one possible pause point in this
  producer's whole lifecycle: immediately after computing the deferred-piece
  partition, before any placement work begins).
- `observeIntrinsicPlaceDeferCompleteShadow(input)` (`:238-280`) — the only
  caller reachable from `computeIrregularNesting.ts:778`; wraps the above in
  an `Effect.catch` that converts every non-cancellation failure into a
  `status: 'censored'` trace with `outputInfluence: 'none'`, never resuming
  or re-checkpointing after a failure (§11).
- Internal machinery, read completely: `makePlaceDeferCheckpoint` (`:282-333`),
  `validatePlaceDeferCheckpoint` (`:335-438`), `intrinsicPlaceDeferFingerprint`
  (`:440-453`), `intrinsicPlaceDeferPendingOrder` (`:455-464`). Notably **no**
  `canonicalJson`-family function and **no** `integrityHash` field exist in
  this file at all (§3, §8) — its only hash is the raw-`JSON.stringify`-based
  `requestFingerprint`.

### Shared external callee (all three producers)

- `createHash('sha256')` from `node:crypto`, `.update(string).digest('hex')`
  — lower-case hex SHA-256 over the UTF-8 encoding of the canonical-JSON (or,
  for the place-defer shadow, raw `JSON.stringify`) string. Node's
  `Hash.update(string)` defaults to UTF-8 encoding of the JS string (no
  explicit encoding argument is ever passed at any of the call sites in this
  cluster) — this is a UTF-16-to-UTF-8 transcode identical in kind to the one
  `periodic.md` §8 already flags for its own `sha256`/`canonicalJson` pair;
  the same lone-surrogate edge-case caveat applies here.
- `IrregularBeamState` (`irregularBeamState.ts`) — every checkpoint's `state`
  field is a **live class instance held by direct object reference**, never
  a plain-data reconstruction. `.parent`, `.remainingPreparedPieces`,
  `.placedCollisionGeometries`, `.unplacedPieceIds`, `.placementOrder`,
  `.canonicalOccupiedGeometryKey`, `.translatedCollisionBounds`,
  `.sharedCollisionBoundaryLengthMm`, `.sharedCollisionBoundaryContactUnits`,
  `.nearCompleteStructuralContactCount`,
  `.dominantNearCompleteStructuralContactCount`,
  `.continuationMetadataIdentity()`, `.canonicalEntryContinuationIdentity()`,
  `.placedCollisionIndex` (a `PlacedCollisionSpatialIndex` with its own
  `.continuationIdentity()`/`.matches(...)`), `.bottomLeftAnchoredCanonicalOccupiedGeometryKey()`,
  and `.withBottomLeftAnchored()` are all read by this cluster's checkpoint
  code (`irregularBeamState.ts:78-357` region). See §12 for the port
  consequence of "checkpoint holds a live object graph, not serialized data."
- `IntrinsicCapacityError` (`intrinsicCapacityPreflight.ts:19-22`) and
  `IntrinsicStrictDecoderError` (`intrinsicStrictDecoder.ts:67-70`) — the
  typed error classes every checkpoint-validation failure is raised as
  (§11).

---

## 3. Data in/out: exact types/shapes, optional-field presence/omission semantics

### 3.1 `IntrinsicAnytimeCheckpoint` (`intrinsicCapacitySearch.ts:154-172`)

```
version: 'intrinsic-anytime-checkpoint-v3'
requestFingerprint: string
producerRole: IntrinsicAnytimeProducerRole   // 7-way union, :70-77
archiveCohort: IntrinsicAnytimeArchiveCohort  // 'complete' | 'partial' | 'experimental-complete'
searchBounds: typeof INTRINSIC_CAPACITY_V1_BOUNDS   // structurally always the same 4-field object literal
incumbentBinding: IntrinsicAnytimeIncumbentBinding | undefined   // present-as-undefined key, NOT omitted (no `?:`)
frontier: ReadonlyArray<IntrinsicAnytimeDecisionState>   // :92-108, one entry per surviving beam member
nextDepth: number
depthBoundaryResumePosition: number   // always === nextDepth for this producer (:1230, :1318 validation)
budgetLedgers: IntrinsicAnytimeBudgetLedgers
schedulerDeficit: number
settlement: 'active'    // literal-only; other checkpoint-shaped consumers (endpoint materialization) use other IntrinsicCapacitySettlement values, but a *checkpoint itself* is always 'active'
censoring: 'none'        // literal-only, always 'none' for this producer
noSkipFrontier: IntrinsicAnytimeNoSkipFrontierState
counters: IntrinsicCapacitySearchCounters   // 8 non-negative-safe-integer fields
topologyRetentionDepths: ReadonlyArray<IntrinsicCapacityTopologyRetentionDepthTrace>   // observer-only, still integrity-hashed (§8)
integrityHash: string
```

`IntrinsicAnytimeProducerRole` (`:70-77`) is a 7-member union:
`'capacity-cold' | 'capacity-cohesion-shadow' | 'capacity-quality-warm-prefix' |
'capacity-warm-prefix' | 'legacy-complete' | 'experimental-place-defer-complete'`
— note the last two members (`'legacy-complete'`, `'experimental-place-defer-complete'`)
are **not** producible by this file's own `makeIntrinsicCapacityCheckpoint`
(which only ever assigns one of the first 4 — its own parameter type is
narrowed to those 4, `:1185-1189`); they exist in the shared union type only
because other checkpoint-shaped structures in the codebase (place-defer
shadow, scheduler trace quanta) reuse the same producer-role vocabulary for
their own, differently-encoded objects. A Rust port's enum for this field
should still include all 7 variants for type-level compatibility with
cross-file comparisons, but the capacity checkpoint's own constructor may
only ever populate 4 of them.

`incumbentBinding: IntrinsicAnytimeIncumbentBinding | undefined` (`:161`) has
no `?:` — the key is **always structurally present**, holding `undefined`
when there is no pruning incumbent. This is unlike `IrregularPreparedPiece`'s
own conditional-property-assignment pattern (documented in `capacity-core.md`
§3, `periodic.md` §3) — here it is a plain TypeScript interface field with a
union type that includes `undefined`, assigned unconditionally by the object
literal at `:1201` (`incumbentBinding: input.incumbentBinding`). Because
`canonicalJson`'s object-handling filters `fieldValue !== undefined` (§8),
this field is **omitted from the hash preimage** whenever it holds
`undefined`, even though the TS object itself always carries the key. A Rust
port must model this as `Option<IntrinsicAnytimeIncumbentBinding>` and have
its own encoder skip the key when `None`, not serialize `null`.

`IntrinsicAnytimeDecisionState` (`:92-108`, one array element per `frontier`
entry): `state: IrregularBeamState` (live object, §2), `continuationMetadataIdentity: string`,
`eligibility: 'completeEligible' | 'subsetOnly'`, four `PieceId` arrays
(`placedPreparedIds`, `pendingPreparedIds`, `deferredPreparedIds` — **always
empty `[]`** for this producer, `:1216`/validated `=== 0` at `:1426` —,
`permanentlySkippedPreparedIds`), `pendingOrder: ReadonlyArray<PieceId>`
(duplicate of `pendingPreparedIds` by construction, `:1218`/`:1215`),
`cursor: number` (always `=== nextDepth`, `:1219`), `pass: number` (always
`0`, `:1220`), `deferralCounts: Readonly<Record<string, number>>` (always
`{}`, `:1221`), `placedDoubledMaterialAreaGrid2: bigint`,
`cavities: IntrinsicCapacityCavityMetrics`, `anchoredOccupiedKey: string`,
`gridSpan: IntrinsicCapacityGridSpan`, `fitMask: IntrinsicAnytimeFitMask`
(`{ q0: boolean; q90: boolean }`).

`budgetLedgers.perCohort` is `Readonly<{ complete: number; partial: number;
experimentalComplete: number }>` — for this producer `complete` and
`experimentalComplete` are always `0` (validated at `:1354-1355`); only
`partial` ever holds a nonzero value, and it is validated `=== consumedFromDepths`
(`:1353`), a value independently re-derived by summing `perDepth` (`:1347-1350`).
This triple redundancy (`totalConsumedPlacementEvaluations`,
`perDepth[].consumedPlacementEvaluations` summed, and `perCohort.partial`)
must all three be reproduced and independently checked in a Rust port — a
port that "simplified" this to a single counter would silently drop a
corruption-detection capability that exists in the current spec.

### 3.2 `IntrinsicStrictDirectCheckpoint` (`intrinsicStrictDecoder.ts:185-197`)

```
version: 'intrinsic-strict-direct-checkpoint-v1'
producerRole: string          // NOT a closed union — free-form string (see below)
requestFingerprint: string
integrityHash: string
state: IrregularBeamState
nextPieceIndex: number
stepTrace: ReadonlyArray<IntrinsicStrictStepTrace>
gapFillEvidence: ReadonlyArray<IntrinsicStrictGapFillEvidence>
candidateEvaluationCount: number
activeRuntimeMs: number
phaseLedger: IntrinsicStrictDirectPhaseLedger | undefined
```

`producerRole: string` (not a union) is populated from
`input.producerRole ?? 'intrinsic-strict'` (`:440`) — production call sites
supply one of the 3 direct-role string literals (`'canonical-grid'`,
`'legacy-absolute-envelope'`, `'open-pocket-first'`, from
`INTRINSIC_SHARED_ARCHIVE_DIRECT_ROLES`), but the type itself places no
compile-time constraint on this beyond "some string" — a Rust port must
either keep this as an owned `String` (matching TS's open-endedness exactly,
per the "preserve current string comparison semantics" instruction in
migration-prompt §9) or, if narrowing to an enum, prove every historical/test
caller's role string is covered (see `strict-decoder-gap-family.md`, which
found `intrinsicReconstructionPortfolio.ts` and `intrinsicPeriodicFamilyPortfolio.ts`
also call `constructIntrinsicStrictState` — a Rust enum narrowing this field
must audit those call sites' role strings too, not just the 3 shared-archive
ones).

`phaseLedger: IntrinsicStrictDirectPhaseLedger | undefined` (`:196`, no `?:`
— same "always-present-key, possibly-undefined-value" pattern as
`incumbentBinding` above) is present iff `capturePhaseTimings === true` at
checkpoint-construction time (`:833-839`), and `validateIntrinsicStrictDirectCheckpoint`
requires `(checkpoint.phaseLedger !== undefined) === input.capturePhaseTimings`
on resume (`:1012`) — i.e. the phase-timing-capture policy itself is part of
the checkpoint's validated contract, not a free-floating diagnostic flag (see
§10 for why this matters for the `timingNow` seam).

`activeRuntimeMs: number` (`:195`) is the **only** field, across all three
checkpoint types, that stores a wall-clock-derived elapsed-time quantity
inside the checkpoint's own hashed contract (contrast: `IntrinsicAnytimeCheckpoint`
has no timing field at all, and `IntrinsicPlaceDeferCheckpoint` has none
either — see §3.3, §10). It accumulates across resumes:
`previousActiveRuntimeMs + Math.max(0, timingNow() - startedAt)` (`:818-819`),
so a resumed checkpoint's `activeRuntimeMs` reflects the **sum of active
wall-clock time across every prior pause/resume segment**, not just the most
recent segment.

`stepTrace: ReadonlyArray<IntrinsicStrictStepTrace>` — length is validated
`=== checkpoint.nextPieceIndex` (`:933`), i.e. exactly one trace entry per
committed piece boundary consumed so far (per `strict-decoder-gap-family.md`
§3, one entry per **committed** piece; not pushed if the evaluation cap
breaks mid-piece).

### 3.3 `IntrinsicPlaceDeferCheckpoint` (`intrinsicPlaceDeferCompleteShadow.ts:31-75`)

```
version: 'intrinsic-place-defer-checkpoint-v1'
requestFingerprint: string
producerRole: 'experimental-place-defer-complete'   // single-literal union, not open string
archiveCohort: 'experimental-complete'               // single-literal union
eligibility: 'completeEligible'                      // single-literal union — always true by construction (:36 comment context)
state: IrregularBeamState
placedPreparedIds / pendingPreparedIds / deferredPreparedIds / permanentlySkippedPreparedIds: ReadonlyArray<PieceId>
pendingOrder: ReadonlyArray<PieceId>
cursor: number            // always 0 (only one pause point exists, :312/:419)
pass: number              // always 0 (:313/:420)
deferralCounts: Readonly<Record<string, number>>   // 0 or 1 entries, value always 1 (:314-315/:407-417)
depthBoundaryResumePosition: number   // always 0 (:316/:421)
placedDoubledMaterialAreaGrid2: bigint   // always 0n at the (only) checkpoint boundary (:317/:396)
enclosedCavityCount: number              // always 0 (:318/:397)
totalEnclosedCavityAreaMm2: number       // always 0 (:319/:398)
anchoredOccupiedIdentity: string
fitMask: { q0: boolean; q90: boolean }   // always {true, true} at the checkpoint boundary (:321/:402-403)
budgetLedgers: { ...same shape as IntrinsicAnytimeCheckpoint's, all zero at this boundary... }
schedulerDeficit: number                 // always 1 (:328/:429)
settlement: 'active'
censoring: 'none'
noSkipFrontier: { present: true; firstLossDepth: undefined }   // present is a literal `true` type, not `boolean`
```

**Notably absent: no `integrityHash` field at all.** Unlike the other two
checkpoint types, this interface has no self-consistency hash; §8 shows its
`validatePlaceDeferCheckpoint` instead re-derives every field independently
from `input.preparedPieces` and rejects on any single mismatch (a
field-by-field re-derivation, not a single-hash comparison). This is a
genuine, deliberate structural asymmetry between this producer and the other
two — not an oversight to "fix" in a port (per migration-prompt §2, "The
existing TypeScript behavior is the specification").

Because `maximumDecisionBoundaries` is typed as literal `1` only (§2), this
checkpoint's every numeric "resume position" field (`cursor`, `pass`,
`depthBoundaryResumePosition`) is a **constant** at the only boundary that
can ever exist — there is no generalized multi-boundary resume capability
here at all, unlike the other two producers.

### 3.4 Cross-checkpoint field-name overlap is deliberate, not automatic

All three checkpoint interfaces share a large common vocabulary — `version`,
`requestFingerprint`, `producerRole`, `archiveCohort`, `state`,
`placedPreparedIds`/`pendingPreparedIds`/`deferredPreparedIds`/`permanentlySkippedPreparedIds`,
`pendingOrder`, `cursor`, `pass`, `deferralCounts`, `budgetLedgers`,
`schedulerDeficit`, `settlement`, `censoring`, `noSkipFrontier` — strongly
suggesting a shared conceptual "anytime checkpoint" family (and the migration
prompt's §11 bullet list of fields to preserve — "prepared order," "ordered
frontier," "cursor and depth," "placed, pending, deferred, and skipped
identities," "occupied identity," "fit masks," "material accounting," "work
ledgers," "scheduler deficit," "no-skip frontier," "counters," "producer
role," "archive cohort," "settlement and censoring state" — matches this
vocabulary field-for-field). **However, these are three independently
declared TypeScript interfaces with no shared base type, no shared encoder
function, and (per §8) no shared canonical-JSON key-sort or bigint-handling
behavior.** A Rust port must not unify them into one generic `struct
AnytimeCheckpoint<Role>` unless it can prove byte-identical encoding for all
three (it cannot — §8 shows the encoders genuinely differ). Preserve them as
three separate types with three separate (byte-verified) encoders, exactly
mirroring the TypeScript file boundaries.

---

## 4. Algorithm state and every mutation point

Checkpoint objects themselves are **immutable once constructed** in all three
producers — every "checkpoint mutation" in the corruption tests (§14) is a
JS object-spread producing a **new** object with one field changed, never an
in-place field write. The only genuine "mutation points" relevant to this
cluster are:

1. **Checkpoint construction** (one call each): `makeIntrinsicCapacityCheckpoint`
   (`intrinsicCapacitySearch.ts:1173-1252`), `makeIntrinsicStrictDirectCheckpoint`
   (`intrinsicStrictDecoder.ts:868-905`), `makePlaceDeferCheckpoint`
   (`intrinsicPlaceDeferCompleteShadow.ts:282-333`). Each builds a `...WithoutIntegrity`
   object first (where applicable), computes the hash over it, then spreads
   it plus the hash into the final returned object (§8).
2. **Checkpoint validation** (one call each, at the top of every
   checkpoint-accepting entry point, before any search work begins):
   `validateIntrinsicCapacityCheckpoint` (`:1254-1501`, called from
   `runIntrinsicCapacityColdSearch`'s setup, per `capacity-search.md` §9),
   `validateIntrinsicStrictDirectCheckpoint` (`:907-1019`, called from
   `constructIntrinsicStrictState` setup at `:454-461`),
   `validatePlaceDeferCheckpoint` (`:335-438`, called from
   `runIntrinsicPlaceDeferCompleteShadow` setup at `:142`). All three are
   pure functions returning `string | undefined` (error message or
   success) — no side effects, no partial acceptance.
3. **Frontier/state re-derivation during validation** — both
   `validateIntrinsicCapacityCheckpoint` and `validateIntrinsicStrictDirectCheckpoint`
   **reconstruct** `IrregularBeamState` instances from the checkpointed
   state's own fields (`new IrregularBeamState({ remainingPreparedPieces:
   entry.state.remainingPreparedPieces, ... })`,
   `intrinsicCapacitySearch.ts:1398-1404`;
   `intrinsicStrictDecoder.ts:1189-1196`) purely to re-derive
   `canonicalEntryContinuationIdentity()`/`placedCollisionIndex.continuationIdentity()`
   and compare against the checkpointed values — this is **recomputation for
   comparison**, not mutation of the checkpoint, but it does construct
   genuinely new `IrregularBeamState`/spatial-index objects as scratch work
   during validation (relevant for Rust allocation-cost modeling, not for
   semantics).
4. **Never a partial/best-effort accept.** Every validator returns on the
   *first* failing condition (`return '...'`) — there is no "accept with
   warnings" path anywhere in this cluster.

---

## 5. Ordering sources: sorts, Map/Set insertion order, iteration order

- **`canonicalJson`/`intrinsicStrictCanonicalJson` object-key sort** — the
  single most important ordering source in this cluster. See §8 for the
  exact comparator used by each of the four encoder variants (they differ:
  ordinal vs. `localeCompare`).
- **`Object.entries(value)` enumeration order before sorting** — irrelevant
  to the final hash bytes (keys are always explicitly sorted afterward in
  three of the four encoders), but relevant to `intrinsicPlaceDeferCompleteShadow.ts`'s
  raw `JSON.stringify` fingerprint (§8), which has **no** explicit sort and
  therefore depends on native property-insertion order — which for the
  domain classes involved is fixed by their constructors (declared-field
  order), not by call-site variation, so it is still deterministic, just not
  alphabetically canonical.
- **`checkpoint.frontier` array order** (capacity checkpoint) — never
  reordered by `canonicalJson` (arrays are order-preserving in all four
  encoder variants, §8) and is itself the **beam order** at the pause
  boundary — i.e., it inherits whatever ordering `runIntrinsicCapacityColdSearch`'s
  live beam-selection/dedup logic produced (out of scope for this cluster;
  see `capacity-search.md` for the beam's own comparator chain). The
  checkpoint-encoding contract's job is only to preserve that order exactly
  through the pause/hash/validate/resume cycle — and it does, since neither
  `makeIntrinsicCapacityCheckpoint` nor `intrinsicCapacityCheckpointIntegrityHash`
  ever sorts `frontier` (`intrinsicCapacitySearch.ts:1202`,
  `:1515` both `.map(...)`, never `.toSorted(...)`).
- **`Map` construction order in `validationCavityCache`/`piecesById`** — both
  `validateIntrinsicCapacityCheckpoint`'s `validationCavityCache: IntrinsicCapacityCavityCache
  = new Map()` (`:1384`) and `intrinsicPlaceDeferCompleteShadow.ts`'s
  `piecesById = new Map(...)` (`:173-175`) are **lookup-only** maps (never
  iterated for output) — safe to port as `HashMap` per migration-prompt §9's
  "use maps only for lookup" rule.
- **`Set` construction for partition-disjointness checks** — `new
  Set(partition).size !== partition.length` (`intrinsicCapacitySearch.ts:1440`;
  identical idiom `intrinsicPlaceDeferCompleteShadow.ts:370`) — used only for
  a cardinality check (`.size`), never iterated for output order; safe as
  `HashSet` in Rust.
- **`Object.values(checkpoint.counters).every(isNonNegativeSafeInteger)`**
  (`intrinsicCapacitySearch.ts:1368`) and
  **`Object.values(ledger.candidateState)`** (`intrinsicStrictDecoder.ts:1229`)
  — `Object.values` iterates in the same well-defined key order as
  `Object.entries`/`Object.keys` (insertion order for string keys, per the JS
  spec), but since this is only used to check "every value satisfies
  predicate P," the iteration order is unobservable in the result (a boolean).
  Safe in Rust as any field-by-field check in a fixed struct-field order.

---

## 6. Comparators and tie rules: exact comparison chains, signs, tie-breakers

- **`compareStrings(first, second)`** (`intrinsicCapacitySearch.ts:2233-2237`):
  ```ts
  function compareStrings(first: string, second: string): number {
    if (first < second) return -1
    if (first > second) return 1
    return 0
  }
  ```
  Plain JS `<`/`>` on strings is **UTF-16 code-unit-wise ordinal comparison**
  (NOT `localeCompare`). Used to sort `canonicalJson`'s object keys (`:1632`)
  and, separately, to sort `material` entries by `pieceId` before hashing in
  `intrinsicCapacityRequestFingerprint` (`:1582`), and inside
  `intrinsicCapacitySuccessorIdentity` to sort a placement-order snapshot
  before `JSON.stringify` (`:1665`, out of this cluster's core scope but
  worth noting the same ordinal comparator is reused there).
- **`localeCompare` key sort** — used by `intrinsicStrictCanonicalJson`
  (`intrinsicStrictDecoder.ts:1271`, `firstKey.localeCompare(secondKey)`) and
  by the unrelated `intrinsicPeriodicFamilyPortfolio.ts` `canonicalJson`
  (`:1291`, per `periodic.md` §5 item 17). Locale-aware string comparison
  depends on the ICU collation rules of the running Node/V8 build's default
  locale (typically root/`en-US`-like ordering that is **not** pure code-point
  order — e.g. this doc's own verification: `'a'.localeCompare('B') === -1`
  while plain `'a' < 'B'` is `false`, confirmed by direct execution — see
  §7). **A checkpoint whose `producerRole` is a free-form string (§3.2) and
  whose integrity hash is computed via `intrinsicStrictCanonicalJson` is
  therefore sensitive to locale-aware key sorting for every nested object's
  keys** — although note this sorts *object keys* (fixed, ASCII, hand-written
  field names like `"pendingIds"`, `"placedIds"`), not arbitrary
  user-controlled piece-ID strings, so the practical risk is lower than it
  sounds; but a Rust port using pure ordinal `str::cmp` for
  `intrinsicStrictCanonicalJson`'s port would only be safe if it independently
  proves every possible key string sorts identically under both orderings —
  do not assume this; implement the actual `localeCompare`-equivalent
  collation (e.g. via a Unicode collation crate configured to match Node's
  default ICU locale, or prove empirically that the fixed, closed set of key
  names used never differs in ordering between the two algorithms and pin
  that proof with a test).
- **`Map` entries sort inside `intrinsicStrictCanonicalJson`**
  (`intrinsicStrictDecoder.ts:1264-1266`):
  `[...value.entries()].toSorted(([first], [second]) => String(first).localeCompare(String(second)))`
  — sorts by the **string-coerced key**, `localeCompare`d, regardless of the
  Map's original key type. No production checkpoint object in this cluster
  is known to contain a raw `Map` value reaching this branch (none of the
  fields listed in §3 are `Map`-typed) — this branch exists for
  `intrinsicStrictCanonicalJson`'s general-purpose use elsewhere in
  `intrinsicStrictDecoder.ts` (candidate memoization, outside this cluster's
  scope) but must still be ported for the function's own correctness if any
  future field ever becomes Map-typed, since the checkpoint hash function and
  the general-purpose function are the textually same function
  (`intrinsicStrictCanonicalJson`, not a checkpoint-only copy).
- **No tie-breaking within checkpoint-encoding itself** — nothing in this
  cluster ranks or selects between multiple checkpoints; each producer holds
  at most one live checkpoint per in-flight search. Ranking/tie-breaking of
  the *endpoints* a checkpoint's frontier eventually produces belongs to
  `capacity-core.md`/`capacity-search.md`'s comparator documentation
  (`compareIntrinsicCapacityEndpoints`), out of this cluster's scope.

---

## 7. Numeric semantics: BigInt, Number arithmetic, Math.*, rounding, signed zero

- **`bigint` fields**: `placedDoubledMaterialAreaGrid2` (all three checkpoint
  types). Two of the four encoders special-case bigint
  (`intrinsicCapacitySearch.ts:1627`, `intrinsicStrictDecoder.ts:1258`, both
  `if (typeof value === 'bigint') return JSON.stringify(value.toString())`
  — i.e. the decimal string representation, itself then JSON-string-quoted,
  e.g. bigint `1234n` → the 6-character JSON token `"1234"`, matching
  migration-prompt §9's "BigInt values encoded as quoted base-10 strings").
  The third (`intrinsicPeriodicFamilyPortfolio.ts`'s `canonicalJson`) has
  **no** bigint branch and would throw on one (§8, confirmed by direct
  `node -e` execution: `JSON.stringify(5n)` throws `TypeError: Do not know
  how to serialize a BigInt`) — not reachable in that file's own inputs
  today (per `periodic.md` §7) but a landmine if ever extended. The fourth
  (`intrinsicPlaceDeferCompleteShadow.ts`'s raw `JSON.stringify` fingerprint,
  `:443-450`) uses a **replacer function**: `(_key, value) => typeof value
  === 'bigint' ? value.toString() : value` — this converts the bigint to a
  plain JS string *before* `JSON.stringify`'s own serialization step runs on
  it, so the net encoded token is identical in shape to the other two
  (a quoted decimal string) despite the different mechanism.
- **Confirmed via direct execution** (`node -e`, this document's own
  verification, not inherited from another cluster doc):
  - `JSON.stringify(-0) === "0"` and `JSON.stringify(0) === "0"` — signed
    zero is **not** distinguishable in the JSON-encoded byte stream; both
    render as the single ASCII byte `0`. A Rust port's float-to-JSON encoder
    must replicate this (do not emit `-0`).
  - `JSON.stringify(NaN)`, `JSON.stringify(Infinity)`, `JSON.stringify(-Infinity)`
    all evaluate to the string `"null"` — i.e. **non-finite numbers silently
    become JSON `null`**, indistinguishable from a genuinely-`null`/omitted
    value at the byte level. No field in any of the three checkpoint types is
    ever supposed to hold a non-finite value at the point it is hashed
    (`Number.isSafeInteger`/`Number.isFinite` are checked pervasively during
    *validation*, e.g. `intrinsicCapacitySearch.ts:1315,1336,1360`;
    `intrinsicStrictDecoder.ts:1003,1006`), but **the hash-computation
    functions themselves (`makeIntrinsicCapacityCheckpoint`,
    `makeIntrinsicStrictDirectCheckpoint`) do not themselves validate
    finiteness before hashing** — they hash whatever numeric value the live
    search state currently holds. If a Rust port's equivalent encoder used a
    numeric type that panics or errors on NaN/Infinity where the TS encoder
    would have silently encoded `null`, that is an observable divergence
    only reachable via an upstream bug elsewhere in the search (which should
    itself be impossible per the invariants those other clusters document) —
    still, exact-parity differential testing (per migration-prompt §18.3)
    should include an adversarial non-finite-value probe of the encoder
    itself, not just of the search that feeds it.
  - `JSON.stringify({a: undefined, b: 1}) === '{"b":1}'` — **native**
    `JSON.stringify` already omits `undefined`-valued keys on its own,
    independent of any custom filter. This means `intrinsicPlaceDeferCompleteShadow.ts`'s
    fingerprint (raw `JSON.stringify`, no explicit undefined-filter) still
    gets undefined-omission "for free" from V8's built-in behavior, while the
    other three encoders implement it explicitly via `.filter(([, v]) => v
    !== undefined)` before their own manual key-join — both mechanisms must
    independently produce the same result (field omitted from the byte
    stream) in a Rust port's serializer, which does not get this behavior "for
    free" from any standard `serde_json` default (an `Option::None` field
    with `#[serde(skip_serializing_if = "Option::is_none")]` must be applied
    explicitly, or a custom serializer used, matching migration-prompt §9's
    warning that "ordinary Serde output is insufficient unless differential
    byte tests prove it matches exactly").
  - Default `Array.prototype.toSorted()` (no comparator) on an array of
    strings produces the same ordering as ordinal `compareStrings` (confirmed:
    `['b','a','c'].toSorted() === ['a','b','c']`) — used by
    `samePieceIdSet`'s `.toSorted()` calls (`intrinsicStrictDecoder.ts:1249-1250`)
    and `validatePlaceDeferCheckpoint`'s `partition.toSorted()`/`preparedIds.toSorted()`
    (`:371`) — both **without** an explicit comparator, relying on this
    default. A Rust port must use plain byte/codepoint `Ord` for these, not
    a locale-aware sort, to match.
- **No floating-point arithmetic occurs inside the checkpoint-encoding
  functions themselves** (`canonicalJson`/`intrinsicStrictCanonicalJson`/hash
  functions/validators) beyond passing through already-computed `number`
  values for JSON rendering — no `Math.*` calls appear in any function listed
  in §2's "internal checkpoint machinery" lists (confirmed by direct
  reading). The float→grid conversions, contact/area computations that
  *produce* the values these functions later hash are owned by other
  clusters (`validation-spatial.md`, `capacity-core.md`, `nfp-ifp.md`).
- **`Number.isSafeInteger`/`isNonNegativeSafeInteger` gates** are used
  extensively during *validation* (not encoding) in both
  `validateIntrinsicCapacityCheckpoint` and `validateIntrinsicStrictDirectCheckpoint`
  (§9) — a Rust port's equivalent should use `i64`/`u32`-range-checked
  arithmetic consistent with JS's `2^53-1` safe-integer ceiling wherever a
  checkpoint field crosses this exact boundary check, per migration-prompt
  §8.2.

---

## 8. Serialization and hashing: the four independent encoders (this section is the cluster's special focus)

### 8.0 The single most important finding: checkpoints are never actually serialized to bytes in production

A repository-wide search for `JSON.stringify(checkpoint`, `JSON.parse(...checkpoint`,
and any disk/IPC/worker-message path that touches a `Checkpoint`-typed value
(`grep -rln "checkpoint" src --include="*.ts" | grep -v
"workers/algorithm/irregular\|workers/irregular"` — **zero results**, run
directly for this document) confirms: **no checkpoint object of any of the
three types is ever written to disk, sent over Node worker `postMessage` IPC,
or otherwise crosses a process boundary in production.** Checkpoints are
pure, in-process JS object references passed as ordinary function arguments
and return values within a single `computeIrregularNesting` execution (§1.3
traces this exactly). The `tests/unit/*.test.ts` corruption tests (§14) also
never round-trip through actual JSON text — they mutate a live checkpoint
object via `{ ...checkpoint, counters: { ...checkpoint.counters,
deduplicatedSuccessors: -1 } }` object-spread (confirmed by direct reading,
`tests/unit/intrinsicCapacityMode.test.ts:634-680`) and pass the resulting
object straight back into the resume call — never `JSON.stringify`+`JSON.parse`.

**Consequence for the encoders documented below**: `canonicalJson` /
`intrinsicStrictCanonicalJson` / the place-defer shadow's raw
`JSON.stringify` exist **solely as deterministic hash-preimage builders**
for `integrityHash`/`requestFingerprint` computation — they are never used to
actually reconstruct a checkpoint from bytes. The migration prompt's §9
phrasing ("Canonical checkpoint JSON must match the current custom encoding
... Ordinary Serde output is insufficient unless differential byte tests
prove it matches exactly") is still the correct requirement — a Rust port
must reproduce these exact byte sequences, because they feed SHA-256 hashes
that are themselves part of the validated, chronology-affecting contract
(§9) — but a Rust port does **not** need round-trip `serde`
Serialize+Deserialize parity for the full checkpoint struct, only (a) an
exact reproduction of each hash-preimage string builder, and (b) ordinary
Rust ownership/move semantics for passing the live equivalent-of-`IrregularBeamState`
object between pause and resume (no serialization needed at all, since Rust
has no process-boundary crossing here either — this is a same-process,
same-thread-or-Rayon-task hand-off). This is flagged prominently in §15 as a
clarification of migration-prompt §9's framing, not a contradiction requiring
behavior change.

### 8.1 Encoder A — `intrinsicCapacitySearch.ts:1626-1635`, `canonicalJson`

```ts
function canonicalJson(value: unknown): string {
  if (typeof value === 'bigint') return JSON.stringify(value.toString())
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const fields = Object.entries(value)
    .filter(([, fieldValue]) => fieldValue !== undefined)
    .toSorted(([firstKey], [secondKey]) => compareStrings(firstKey, secondKey))
    .map(([key, fieldValue]) => `${JSON.stringify(key)}:${canonicalJson(fieldValue)}`)
  return `{${fields.join(',')}}`
}
```

- bigint → quoted base-10 string. ✓ (§7)
- Non-object/null (`number`, `string`, `boolean`, `null`, `undefined` when
  reached directly rather than as an object field) → native `JSON.stringify`
  — inherits all of native JSON's number-formatting (shortest-round-trip
  double-to-string, per ECMA-262 `Number::toString`), string-escaping
  (`"`, `\`, control chars U+0000-U+001F escaped, everything else — including
  non-ASCII — passed through literally, i.e. **not** `\uXXXX`-escaped for
  ordinary Unicode text), and the NaN/Infinity→`null`, -0→`"0"` behaviors
  documented in §7.
- Array → `[` + comma-joined recursive results + `]`, **array order always
  preserved**, never sorted.
- Object → filter `undefined`-valued fields, sort remaining keys via
  **ordinal `compareStrings`** (plain `<`/`>`, not `localeCompare`), each
  entry rendered `"key":value`, joined by `,`, wrapped in `{}`.
- **Fully dense — zero incidental whitespace** anywhere (no space after `:`
  or `,`), matching migration-prompt §9's "no incidental whitespace
  differences in bytes that feed SHA-256."
- **No `Map` special-casing** — a raw `Map` value would fall into the
  "object" branch, and `Object.entries(someMap)` returns `[]` (Maps do not
  expose their entries as own-enumerable string-keyed properties), silently
  encoding as `{}` regardless of contents. No field reaching this encoder in
  `intrinsicCapacitySearch.ts` is `Map`-typed (verified: every field listed
  in §3.1/§8.3's hash-preimage projection is a primitive, array, bigint, or
  plain object), so this is currently unreachable — but a Rust port's
  equivalent function must not silently accept a `HashMap`/`BTreeMap` input
  either; it should be typed to reject at compile time (no generic "any
  value" entry point) or explicitly panic, matching the *intent* of never
  silently mis-encoding, even though the *literal* JS behavior here (silent
  `{}`) is technically the "spec" if ever exercised — this exact case is
  flagged as unreachable-in-practice in `periodic.md` §7 for a sibling
  encoder and the same reasoning applies here.

### 8.2 Encoder B — `intrinsicStrictDecoder.ts:1257-1277`, `intrinsicStrictCanonicalJson`

Same bigint/null/array handling as Encoder A, but:
- **Object key sort uses `localeCompare`**, not ordinal comparison (§6).
- **Explicit `Map` handling**: `value instanceof Map` → sort entries by
  `String(key).localeCompare(String(otherKey))`, then recurse into the
  sorted `[key, value]` pair array (§6). No field in `IntrinsicStrictDirectCheckpoint`'s
  hash preimage (§8.4) is `Map`-typed either, so this branch is also
  currently unreachable for checkpoint hashing specifically, but (unlike
  Encoder A) the function *does* handle it correctly if it ever were reached
  — because this same function is reused for other, non-checkpoint hashing
  in this file (candidate-provenance memoization, out of scope here).

**Encoders A and B are textually near-identical but produce different bytes
for any input containing keys that sort differently under ordinal vs. locale
comparison, or containing a `Map`.** A Rust port must implement these as two
genuinely separate functions (or one parameterized-by-comparator function
used with two different comparator arguments, carefully proven equivalent to
each call site) — never share one Rust "canonical JSON" implementation
between the capacity checkpoint and the strict-direct checkpoint without a
byte-level differential test proving they don't diverge for the
specific field-name sets each one actually encodes (§15 flags this as an
open verification item: field names used are a small, fixed, hand-written,
all-ASCII, all-single-case-word-boundary set like `"pendingIds"`,
`"placedIds"`, `"cavities"`, `"anchoredOccupiedKey"` — practically these are
extremely unlikely to sort differently under ordinal vs. locale comparison,
but "extremely unlikely" is not a proof, and the migration prompt explicitly
forbids relying on coincidental similarity).

### 8.3 Encoder C — `intrinsicPeriodicFamilyPortfolio.ts:1285-1293`, `canonicalJson` (not a checkpoint encoder; cited for contrast only)

Same as Encoder A except **no bigint branch at all** (§7) and
**`localeCompare`** key sort (like Encoder B, unlike Encoder A). Not part of
this cluster's live checkpoint contract; fully characterized in `periodic.md`.
Cited here only as the fourth data point proving there is no single "the
canonical JSON encoder" in this codebase — three textually-similar-but-behaviorally-distinct
local functions exist, plus a fourth structurally different one (§8.5).

### 8.4 What Encoder A/B actually hash (the "derived view," not the raw stored object)

**Critical, easy-to-miss detail**: neither `intrinsicCapacityCheckpointIntegrityHash`
nor `intrinsicStrictDirectCheckpointIntegrityHash` hashes `canonicalJson(checkpoint)`
directly. Each builds a **curated projection object** first:

- Capacity (`intrinsicCapacitySearch.ts:1503-1569`): for each `frontier`
  entry, the hash input's nested `state: {...}` sub-object is built from 10
  **named accessor reads on the live `IrregularBeamState` instance**
  (`entry.state.remainingPreparedPieces.map(intrinsicCapacityPreparedPieceId)`,
  `entry.state.placedCollisionGeometries.map(({placement}) => placement.pieceId
  ?? placement.sourcePieceId)`, `.unplacedPieceIds`, `.placementOrder`,
  `.canonicalOccupiedGeometryKey`, `.translatedCollisionBounds`,
  `.sharedCollisionBoundaryLengthMm`, `.sharedCollisionBoundaryContactUnits`,
  `.nearCompleteStructuralContactCount`,
  `.dominantNearCompleteStructuralContactCount`,
  `.continuationMetadataIdentity()`) — **not** `canonicalJson(entry.state)`
  applied to the whole live object (which would also try to walk
  `.placedCollisionIndex`, `.parent`, and every other property the class
  exposes, and would almost certainly diverge from what is actually hashed).
  Sibling to this `state` sub-object, the same mapped entry **also** includes
  the checkpoint's own **stored** top-level frontier-entry fields
  (`entry.continuationMetadataIdentity`, `entry.eligibility`,
  `entry.placedPreparedIds`, `entry.pendingPreparedIds`, etc. — the literal
  values already present on the `IntrinsicAnytimeDecisionState`, not
  re-derived). So the hash input for one frontier entry is a **mix**: 10
  fields freshly re-derived from the live state object, plus roughly a dozen
  more fields read directly from the already-stored checkpoint entry. A Rust
  port must reproduce this exact mixed projection — implementing it as "hash
  the stored struct" (all-stored) or "hash a full re-derivation" (all-derived)
  will both diverge from the real bytes.
- Strict-direct (`intrinsicStrictDecoder.ts:1058-1078`): hashes `stateLineage`
  (a `ReadonlyArray<Record<string, unknown>>`), **not** `checkpoint.state`
  directly. `stateLineage` is produced by `collectIntrinsicStrictDirectStateLineage`
  (`:1080-1110`), which walks `state.parent` back exactly `expectedStateCount`
  times (`nextPieceIndex + 1` ancestors, `:881`), pushing one projection
  record per ancestor (`pendingIds`, `placedIds`, `unplacedIds`,
  `placementOrder`, `canonicalGeometryIdentity`, `canonicalOccupiedGeometryKey`,
  `translatedCollisionBounds`, `sharedCollisionBoundaryLengthMm`,
  `sharedCollisionBoundaryContactUnits`, `nearCompleteStructuralContactCount`,
  `dominantNearCompleteStructuralContactCount`, `continuationMetadataIdentity()`
  — 12 fields per ancestor, one array entry per ancestor). This means the
  strict-direct integrity hash is sensitive to the **entire ancestor chain**
  back to the frozen seed, not merely the current state — a materially larger
  and chronologically deeper hash input than the capacity checkpoint's
  single-current-state-per-frontier-entry projection. `collectIntrinsicStrictDirectStateLineage`
  also detects cycles (`visited: Set<IrregularBeamState>`, returns `undefined`
  on a repeat, `:1086-1088`) and length mismatches — if either occurs during
  *construction* (`makeIntrinsicStrictDirectCheckpoint`), the function
  **throws a plain JS `Error`** (`:884`, not a typed `Effect` failure), which
  `strict-decoder-gap-family.md` §11 already documents in depth as the one
  place in this file that signals via throw/defect rather than a typed error
  channel — cross-referenced here because it is directly triggered by
  checkpoint-encoding logic.

Both `requestFingerprint` functions (§8.6) similarly hash **curated
projections**, not raw request objects, with their own field lists (see
below) — always re-derive the exact field list from source; never assume
"the fingerprint hashes the whole input."

### 8.5 Encoder D — `intrinsicPlaceDeferCompleteShadow.ts:440-453`, raw `JSON.stringify` (fundamentally different mechanism)

```ts
function intrinsicPlaceDeferFingerprint(input: RunIntrinsicPlaceDeferInput): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        {
          version: INTRINSIC_PLACE_DEFER_CHECKPOINT_VERSION,
          sheet: { width: input.sheet.width, height: input.sheet.height },
          preparedPieces: input.preparedPieces
        },
        (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value)
      )
    )
    .digest('hex')
}
```

- **No explicit key sorting at all** — relies entirely on native
  `JSON.stringify`'s own property-enumeration order (insertion order for
  string keys), which is deterministic per-object but is **not** alphabetical
  and is **not** the same order Encoders A/B would choose for the same
  logical fields.
- **`input.preparedPieces` is hashed as a whole, unprojected array of full
  domain-class instances** (not a curated field-subset like §8.4's
  projections) — `JSON.stringify` walks every own-enumerable property of
  each `IrregularPreparedPiece` (including nested `collisionGeometry`,
  `transforms`, etc., subject to the "declare + conditional-assign" true
  property-omission pattern documented in `capacity-core.md` §3 /
  `periodic.md` §3). This is the **most expensive and most exposure-prone**
  fingerprint in this cluster — any unrelated, semantically-inert field added
  to `IrregularPreparedPiece` or its nested classes in the future would
  silently change this hash, whereas Encoders A/B/C's curated projections are
  insulated from unrelated domain-class changes.
- **No `integrityHash` counterpart at all** (§3.3) — this file computes only
  a `requestFingerprint`; there is no second, separately-computed
  self-consistency hash over the checkpoint's own retained state. Corruption
  detection for this checkpoint type relies entirely on
  `validatePlaceDeferCheckpoint`'s ~15 explicit field-equality checks (§9),
  not on hash comparison.
- This function's own bigint handling (a `JSON.stringify` replacer) produces
  byte-identical output to Encoders A/B's bigint branch for any given bigint
  value (both ultimately emit the quoted decimal string), despite the
  different code path — worth a differential unit test in the Rust port
  confirming this equivalence rather than assuming it.

### 8.6 Request-fingerprint field lists (exact, for port reproduction)

- **Capacity** (`intrinsicCapacityRequestFingerprint`,
  `intrinsicCapacitySearch.ts:1571-1610`): `version` (the checkpoint version
  constant, reused as a fingerprint-versioning field too — same string,
  dual-purpose), `searchBounds` (the whole `INTRINSIC_CAPACITY_V1_BOUNDS`
  object), `sheet` (whole `SheetSpec`), `preparedPieces` (whole array,
  unprojected — same "walks full domain classes" exposure as Encoder D, but
  through Encoder A's sorted/bigint-safe path), `material` (a **freshly
  sorted** `[pieceId, area][]` derived from `materialAreasByPieceId`, sorted
  by `compareStrings` on `pieceId` — **this is a case where the fingerprint
  function itself imposes a canonical order on a `Map`'s contents before
  hashing**, i.e. exactly the "re-sort with the exact legacy comparator"
  pattern migration-prompt §9 requires), `incumbent` (via
  `intrinsicCapacityIncumbentBinding`, `undefined` if none), `schedulerDeficit`
  (defaulted `?? 0`), `retentionMode` (defaulted `?? 'objective'`),
  `warmPrefix` (`undefined` if none, else a 4-field projection including
  `anchoredOccupiedKey` computed by calling
  `.bottomLeftAnchoredCanonicalOccupiedGeometryKey()` **at fingerprint time**
  — a live-state method call embedded inside fingerprint computation, not a
  stored value).
- **Strict-direct** (`intrinsicStrictDirectRequestFingerprint`,
  `intrinsicStrictDecoder.ts:1021-1056`): `version`, `producerRole`,
  `candidateMode`, `settings` (whole `IrregularNestingSettings`), `settlement`
  (a 3-field object: `maximumRuntimeMs`, `maximumCandidateEvaluationCount`,
  `capturePhaseTimings` — bundling the *policy*, not just the request data,
  into the fingerprint, so changing any of these three between pause and
  resume is a fingerprint mismatch, not merely a validation-field mismatch),
  `allPreparedPieces` (a **curated** projection: `pieceId`, `collisionGeometry`,
  `transforms` only — narrower than the capacity fingerprint's "whole array"
  approach), `remainingPreparedIds` (ID-only), `frozenPlacementOrder`
  (ID-only), `frozenGeometryIdentity` (`canonicalCollisionLayoutIdentity(...) ?? ''`
  — note the `?? ''` fallback: an `undefined` identity becomes the **empty
  string**, not an omitted field or `null`; a Rust port must use `.unwrap_or_default()`-style
  empty-string coercion here, not `Option`-skip semantics, since this is
  inside a field that is always present, just possibly empty).
- **Place-defer** (`intrinsicPlaceDeferFingerprint`, §8.5): `version`,
  `sheet` (only `width`/`height`, not the whole `SheetSpec` — narrower than
  both other fingerprints, which hash the whole sheet), `preparedPieces`
  (whole array, widest of the three).

**No two of the three fingerprint functions hash the same field set, the
same encoder, or even the same subset of `SheetSpec`.** A Rust port must
implement three independent fingerprint functions with these exact field
lists; there is no shared "make a request fingerprint" utility to write
once.

---

## 9. Caches touched and the exact historical access sequence

This cluster's own functions touch no long-lived, cross-call cache. The one
cache-shaped object created is `validationCavityCache: IntrinsicCapacityCavityCache
= new Map()` (`intrinsicCapacitySearch.ts:1384`), allocated fresh at the top
of every `validateIntrinsicCapacityCheckpoint` call and discarded at return —
per `capacity-search.md` §9 ("this cache is discarded after validation and is
never [shared] across cold/warm/quality lanes or across checkpoint
resumes — each [validation call gets its own]"). This document confirms that
characterization directly (read `:1254-1501` in full) and adds: this is the
**only** allocation-shaped state inside checkpoint validation across all
three producers — `validateIntrinsicStrictDirectCheckpoint` and
`validatePlaceDeferCheckpoint` allocate no cache at all, doing all
recomputation with plain local variables and fresh `IrregularBeamState`
constructions (§4 item 3). A Rust port's checkpoint-validation functions
should likewise use a function-local cache (or none), never a
job-shared/thread-shared cache, for this specific recomputation work.

---

## 10. Cancellation / deadline / budget / evaluation-cap observation points; the `timingNow` seam

### 10.1 Cooperative-cancellation checkpoint calls inside each producer

- **Capacity** (`intrinsicCapacitySearch.ts`): exactly **one**
  `control.checkpoint('candidate-points')` call in the entire cold-search
  loop (`:599`, confirmed by direct grep — `capacity-search.md` §9 also
  documents this as the search's sole cancellation observation point). No
  deadline/wall-clock check exists inside the checkpoint-encoding functions
  themselves; the search's own pause boundary (§1.3) is purely
  **depth-count-based** (`maximumDepthBoundaries`), not time-based.
- **Strict-direct**: `control.checkpoint(phase)` is invoked once per
  (piece, transform) inside candidate generation
  (`strict-decoder-gap-family.md` §9 documents this exhaustively — 28 call
  sites across the cluster's files) — cross-referenced, not re-derived here.
  Additionally, and specific to *this* cluster's concern (timing), the
  wrapped `control` object passed down through `constructIntrinsicStrictState`
  (`:472-486`, read in full) itself enforces the wall-clock deadline: `if
  (previousActiveRuntimeMs + timingNow() - startedAt >= maximumRuntimeMs)`
  fails with `IrregularNfpIfpControlAbortError({reason: 'deadline', ...})`
  **inside the same closure that also forwards the caller's own cancellation
  check** (`if (input.control !== undefined) yield* input.control.checkpoint(phase)`,
  `:475`, executed *before* the deadline check on the same call). This is the
  **only** producer in this cluster whose deadline enforcement is itself
  routed through the injectable `timingNow` seam (§10.2) — i.e., in a
  deterministic-clock differential test, both the strict-direct producer's
  deadline decisions *and* its checkpoint's `activeRuntimeMs` byte value are
  reproducible; the capacity producer's are not (§10.2).
- **Place-defer**: `runIntrinsicStrictState`'s own internal checkpoint calls
  apply (delegated), plus the wrapping `observeIntrinsicPlaceDeferCompleteShadow`
  catches `IrregularNfpIfpControlAbortError` with `reason === 'deadline'`
  and converts it to `censoringReason: 'deadline'`, `status: 'censored'`
  (`:252-259`) rather than propagating (§11) — but this producer has its own
  fixed runtime cap constant, `INTRINSIC_PLACE_DEFER_RUNTIME_CAP_MS = 35_000`
  (`:29`), passed as `maximumRuntimeMs` into the delegated
  `constructIntrinsicStrictState` call (`:186`), so its deadline behavior
  ultimately reduces to the strict-direct producer's own `timingNow`-seamed
  logic above.

### 10.2 The `timingNow` seam — present in two producers, absent in one (the special-focus finding)

- **`intrinsicStrictDecoder.ts`** has an explicit, documented injectable
  clock seam: `readonly timingNow?: () => number` (`:282`, doc comment
  `:281` "Test-only monotonic source for deterministic runtime and phase
  accounting"), defaulted `input.timingNow ?? performance.now.bind(performance)`
  (`:412`). Every elapsed-time computation in this file's construction loop —
  including the one that ultimately becomes the checkpoint's own
  `activeRuntimeMs` field (`:818-819`, `:832`) — flows through this seam.
  `irregularBeamState.ts:177-240` (a collaborator, not itself a checkpoint
  producer) has an **independent, separately-declared** `timingNow?: () =>
  number` parameter of its own (`:177`), used only for its own internal
  `onPhaseTimings` diagnostic callback, defaulted the same way
  (`input.timingNow ?? performance.now.bind(performance)`, `:179`) — this is
  a **second, unrelated seam instance** with the same name and default, not
  a shared threading of the strict-decoder's seam into the beam-state
  constructor; `constructIntrinsicStrictState` does pass its own `timingNow`
  down explicitly at one call site (`intrinsicStrictDecoder.ts:644`,
  `timingNow` field in an object literal) — confirm at port time whether
  every `IrregularBeamState`-constructing call site inside the strict decoder
  forwards the same seam or some construct their own default clock (this is
  flagged as an open question in §15, since a partial forward would produce
  a checkpoint whose `activeRuntimeMs` is deterministic but whose
  `IrregularBeamState`-internal phase-timing diagnostics are not, or
  vice versa).
- **`intrinsicCapacitySearch.ts` has NO injectable clock seam at all.** Every
  elapsed-time measurement in this file calls the global `performance.now()`
  directly and unconditionally (20 call sites confirmed by direct grep:
  `:337,598,620,622,631,652,671,685,688,784,788,812,826,874,916,937,971,974,1988,1996`
  — no `timingNow` parameter exists anywhere in `RunIntrinsicCapacityColdSearchInput`
  or any other exported input type in this file). This is exactly the gap
  the task's special-focus section asked to be found: **the checkpoint
  producer whose encoding contract explicitly excludes any timing field at
  all** (`IntrinsicAnytimeCheckpoint` has no `activeRuntimeMs`-equivalent —
  confirmed absent from its 17-field shape in §3.1) is also the one producer
  with no deterministic-clock seam. These two facts are consistent with each
  other (there is no timing field in the *hashed* checkpoint contract for
  this producer, so a missing clock seam cannot desynchronize checkpoint
  bytes across runs) — but `IntrinsicCapacitySearchPhaseTimings` (`:240-247`,
  a **separate**, non-checkpoint, `capturePhaseTimings`-gated diagnostic
  return value) **does** depend on wall-clock `performance.now()` calls with
  no seam, so byte-level differential testing of `phaseTimings` output
  (distinct from the checkpoint itself) cannot be made deterministic for
  this producer without adding a seam — matching migration-prompt §11's
  instruction: "trace every other checkpoint producer and add an equivalent
  test-only clock seam where needed." **This file needs one; it does not
  have one today.** A Rust port intending byte-level differential parity for
  `IntrinsicCapacitySearchPhaseTimings` (not the checkpoint hash itself,
  which has no timing field) must add an injectable clock, either as a new
  TypeScript seam mirrored 1:1 (preferred, per migration-prompt §11's "Add or
  reuse an injected deterministic clock in both backends") or as a
  Rust-only test seam whose behavior is proven equivalent by a separate
  differential harness against the un-seamed TS `performance.now()` under
  production (non-deterministic-timing) comparison rules (§11's "compare
  timing fields as non-semantic measurements" carve-out).
- **`intrinsicPlaceDeferCompleteShadow.ts` has no timing calls at all**
  (confirmed: zero `performance.now`/`timingNow`/`Date.now`/elapsed-tracking
  occurrences in the file, by direct grep) — its own checkpoint type has no
  timing field (§3.3), and its runtime cap
  (`INTRINSIC_PLACE_DEFER_RUNTIME_CAP_MS`) is enforced entirely by the
  delegated `constructIntrinsicStrictState` call's own (seamed) clock. No
  gap here; nothing to add.

### 10.3 Evaluation-cap observation points feeding checkpoint fields

- Capacity: `consumedPlacementEvaluations` vs.
  `INTRINSIC_CAPACITY_V1_BOUNDS.minimumPlacementEvaluationCap`-derived total
  cap and `.placementEvaluationQuotaPerDepth` per-depth cap — accounting
  fields carried into `budgetLedgers` (§3.1), validated for internal
  consistency (§9) but the cap-breach decision itself belongs to
  `capacity-search.md`.
- Strict-direct: `candidateEvaluationCount` vs.
  `maximumCandidateEvaluationCount` — the checkpoint's own
  `candidateEvaluationCount` field is cross-checked against
  `stepTrace.reduce((sum, trace) => sum + trace.candidateCount, 0)` on
  resume (`:998-1001`) — i.e. the checkpoint's aggregate counter must exactly
  equal the sum of its own per-step trace, a redundancy check specific to
  this producer.
- Place-defer: `INTRINSIC_PLACE_DEFER_EVALUATION_CAP = 19_862` (`:28`) —
  passed through to the delegated strict-decoder call
  (`maximumCandidateEvaluationCount: INTRINSIC_PLACE_DEFER_EVALUATION_CAP`,
  `:185`); the place-defer checkpoint's own `budgetLedgers.totalPlacementEvaluationCap`
  is validated `=== INTRINSIC_PLACE_DEFER_EVALUATION_CAP` exactly (`:422-423`).

---

## 11. Error paths: tagged error classes, categories, context fields, propagation

- **Capacity checkpoint failures** raise `IntrinsicCapacityError({ operation:
  'coldSearchCheckpoint', message })` at 4 distinct sites within
  `runIntrinsicCapacityColdSearch`'s setup (`:409-413` invalid
  `maximumDepthBoundaries`; `:423-427` fingerprinting-not-enabled-for-resume;
  `:443-446` checkpoint-validation failure, `message` is the validator's own
  returned string, i.e. **one of ~20 distinct human-readable reasons** listed
  across `validateIntrinsicCapacityCheckpoint`'s ~1250-line body, each a
  distinct literal string, e.g. `'checkpoint integrity hash does not match
  its retained frontier.'`, `'checkpoint request/prepared-order fingerprint
  does not match the current request.'`, etc. — §9 of `capacity-search.md`
  enumerates these in full; a Rust port's error enum must carry an
  equivalent, distinguishable reason per branch, not collapse them into one
  generic "checkpoint invalid" variant, since migration-prompt §16 requires
  "typed Rust error enums for precise internal provenance"); `:882-887`
  fingerprint-unavailable-at-a-requested-pause-boundary). Per
  `errors-protocol.md` §Live table, `IntrinsicCapacityError` is converted to
  `IrregularPortfolioError({ category: 'search' })` via
  `mapIntrinsicCapacityError` (`computeIrregularNesting.ts:1242-1251`), which
  externally surfaces as `AppErrorCode` `irregular_scoring_error` — i.e., a
  **checkpoint-corruption failure and an ordinary search-scoring failure are
  externally indistinguishable at the `AppErrorCode` level**; the only
  distinguishing signal for a caller/log is the internal `operation` string
  (`'coldSearchCheckpoint'`) and `message` text, both preserved through
  `IrregularPortfolioError`'s own fields (`errors-protocol.md` §"Context
  fields" table).
- **Strict-direct checkpoint failures** raise `IntrinsicStrictDecoderError({
  operation: 'directCheckpoint', message })` (`:462-468`), where `message` is
  one of `validateIntrinsicStrictDirectCheckpoint`'s ~10 distinct returned
  reason strings (§3.2/§8.4; full enumeration in
  `strict-decoder-gap-family.md` §9-10). Converted to
  `IrregularPortfolioError({ category: 'search' })` at
  `computeIrregularNesting.ts:727-733` — same external `irregular_scoring_error`
  code, same indistinguishability caveat as above.
- **The one throw/defect exception** (§8.4): `makeIntrinsicStrictDirectCheckpoint`'s
  `throw new Error('committed direct checkpoint lineage is invalid.')`
  (`:884`) is a genuine synchronous JS `throw` inside an `Effect.gen` body —
  Effect captures this as a **defect** (`Cause.Die`), not as a value in the
  declared, typed error channel. `strict-decoder-gap-family.md` §11 already
  documents this in depth (including that it is distinct from the
  *validation*-side corrupted-checkpoint rejection tests, which exercise a
  different function). This document adds only the checkpoint-encoding-specific
  framing: this is the single place across all three checkpoint producers
  where "the checkpoint I am about to construct would be self-contradictory"
  is signaled by panic-equivalent unwind rather than a typed `Result`/`Effect`
  failure — the Rust port's equivalent must be a genuine `panic!`/process-abort-class
  invariant violation (per migration-prompt §16's framing of Effect defects),
  never a normal recoverable `Result::Err` a caller is expected to handle.
- **Place-defer checkpoint failures** raise `IntrinsicCapacityError({
  operation: 'placeDeferCheckpoint', message })` (`:144-149`), where
  `message` is one of `validatePlaceDeferCheckpoint`'s ~6 distinct returned
  reason strings (§3.3). Because `runIntrinsicPlaceDeferCompleteShadow` is
  only ever reached through `observeIntrinsicPlaceDeferCompleteShadow`
  (§1.3), and that wrapper's `Effect.catch` converts **every** non-`'cancelled'`
  failure — including this exact `IntrinsicCapacityError`, tag-matched via
  `error._tag === 'IntrinsicCapacityError'` → `censoringReason: 'capacity-error'`
  (`:255-256`) — into a `status: 'censored'` trace rather than propagating an
  error, **a place-defer checkpoint-corruption failure never reaches
  `AppErrorCode` at all in production**; it is fully absorbed as
  observer-only censoring. This is the only one of the three checkpoint
  types whose validation failures are structurally guaranteed
  non-externally-visible (given its non-authoritative gating, §1.3).

---

## 12. JS-specific semantics hazards for a Rust port

1. **Checkpoints hold live object-graph references (`IrregularBeamState`
   instances with methods, cached identity strings, and an owned spatial
   index), not plain data (§2, §8.0).** A Rust port's equivalent checkpoint
   type must own (or `Arc`-share, if proven safe under the migration
   prompt's Rayon-parallelism rules — §13) the equivalent live state object
   directly, not a serialized snapshot. Do not design the Rust checkpoint
   type "as if" it were a wire-format `struct` with `#[derive(Serialize,
   Deserialize)]` as its primary purpose — its primary purpose in the TS
   source is in-process pause/resume; serialization (§8) exists only to
   produce a hash.
2. **Three field-name-overlapping but behaviorally distinct checkpoint types
   and four distinct `canonicalJson`-family encoders exist; none may be
   unified without a byte-level differential proof (§3.4, §8.1-8.3).**
3. **`Object.entries`/own-enumerable-property semantics drive every encoder.**
   All four encoders walk `Object.entries(value)` (or, for the place-defer
   fingerprint, `JSON.stringify`'s own internal equivalent) — this is
   sensitive to whatever the `IrregularPreparedPiece`/`IrregularPlacedPiece`/etc.
   domain classes' own conditional-property-assignment constructors
   (`capacity-core.md` §3) chose to assign as *own* properties, in
   constructor-declaration order for `intrinsicPlaceDeferCompleteShadow.ts`'s
   unsorted encoder, or alphabetically thereafter for the other three. A Rust
   `struct` with `#[derive(Serialize)]` walks fields in **declaration order**
   by default, matching neither "insertion order of a dynamically-conditionally-built
   JS object" nor "alphabetical" automatically — the port's encoder must
   explicitly sort (for Encoders A/B/C) or explicitly declare struct fields in
   the exact same order the JS constructor would have assigned them (for
   Encoder D), never rely on `derive(Serialize)`'s default field order
   coinciding with either.
4. **`-0`/`NaN`/`Infinity` all silently collapse under `JSON.stringify`**
   (§7) — a Rust `f64`-based encoder that instead errors, panics, or renders
   `-0.0`/`NaN`/`inf` literally on these inputs will diverge from the JS
   byte stream. Since no field is expected to legitimately hold such a value
   in a valid checkpoint (§7), the practical exposure is limited to
   adversarial/corrupted-input differential tests, which should be written
   deliberately (§15).
5. **`bigint` handling is present in 3 of 4 encoders and absent (and
   throwing) in the 4th** (§7, §8.1-8.3) — a single shared Rust "canonical
   JSON" helper used across all four ported call sites must be parameterized
   per call site to match, not given one universal bigint policy.
6. **`localeCompare` vs. ordinal `<`/`>` genuinely diverge for mixed-case
   ASCII and for any non-ASCII content** (§6, confirmed by direct `node -e`
   execution in this document). Two of the four encoders use each. A Rust
   port must not assume `str::cmp` (ordinal) is a safe universal substitute
   for `localeCompare`-based encoders, even though the currently-observed
   key sets are small closed hand-written ASCII identifiers where the two
   orderings are believed (not proven) to coincide.
7. **Effect's defect/die channel vs. typed error channel** (§11) — the one
   `throw` inside checkpoint construction must map to a genuinely different
   Rust failure mode (panic-class) than every other typed validation
   rejection (recoverable `Result::Err`-class).
8. **UTF-16-to-UTF-8 transcoding inside `createHash(...).update(string)`**
   (§2, "Shared external callee") — Rust `String`s are always valid UTF-8
   internally and cannot hold lone surrogates the way a JS string
   (UTF-16-code-unit sequence) can; if any piece ID, label, or other
   string-typed field ever reaches this cluster's hash functions containing
   an unpaired surrogate (e.g. from malformed import data upstream), Node's
   UTF-8 encoding step substitutes the Unicode replacement character
   (U+FFFD) for it — a Rust port must reproduce this exact substitution
   behavior (e.g. via `String::from_utf16_lossy`-equivalent handling upstream
   of the point where such a string is first constructed, or explicit
   replacement-character substitution at the hash-input boundary) rather
   than erroring on invalid UTF-16, to keep hash bytes identical for this
   edge case. (Same caveat independently raised for a different encoder in
   `periodic.md` §8 — recorded here as confirmed applicable to this
   cluster's encoders too, not re-derived independently.)

---

## 13. Parallelism assessment: pure/independent vs. chronology-bound

**This entire cluster is chronology-bound and must remain serial. There is
no safe Rayon candidate anywhere in checkpoint construction, validation, or
resume.** Reasoning:

1. **Checkpoint pause/resume order is itself part of the observable,
   parity-gated contract** (migration-prompt §2: "checkpoint chronology" is
   explicitly listed as something that must not change). §1.3 traces a
   concrete production interleaving: the capacity-cold-quantum checkpoint and
   the canonical-grid strict-direct checkpoint are woven together by a single
   serial `onCanonicalGridCheckpointed` callback inside
   `intrinsicSharedArchivePortfolio.ts`'s `while (true)` loop
   (`:261-333`) — the *order* in which these two independent producers'
   pause/resume cycles interleave is itself production behavior a Rust port
   must reproduce exactly (matching migration-prompt §14.2's explicit
   high-risk-boundary listing: "checkpoint publication by completion order").
   Running the capacity cold quantum and the canonical-grid direct
   construction concurrently on separate Rayon tasks — even if each
   individually produces the correct checkpoint bytes — would change *when*
   each pause boundary is reached relative to the other, which changes the
   scheduler trace's `quanta` ordinal sequence
   (`computeIrregularNesting.ts:619-635,650-706`, a parity-gated trace field
   per other clusters) and could change which producer "wins" a shared
   incumbent-binding race if one were ever introduced.
2. **Validation recomputation is small, cheap, and per-checkpoint — not a
   batch of independent work items.** Each `validateIntrinsic*Checkpoint`
   call processes one checkpoint's `frontier`/lineage in a single pass with
   early-return-on-first-failure (§4 item 4); there is no independent,
   embarrassingly-parallel inner loop here worth a Rayon indexed-parallel-iterator
   (contrast with, e.g., independent per-piece candidate legality evaluation
   in other clusters, which migration-prompt §14.1 does list as a good
   candidate). The frontier loop inside `validateIntrinsicCapacityCheckpoint`
   (`:1386-1493`) *could* in principle be evaluated per-entry in parallel
   (each entry's recomputation is self-contained, reading only that entry's
   own `state`), **except** that it shares the mutable
   `validationCavityCache` `Map` across iterations (§9) as a genuine
   cross-iteration memoization structure (`measureIntrinsicCapacityCavities(entry.state,
   validationCavityCache)`, `:1485`) — parallelizing this loop naively would
   require either sharding the cache per-thread (changing which entries
   recompute vs. hit, though not changing *correctness* since cache hits and
   recomputation are proven equal per migration-prompt §13.1) or a
   concurrent-safe single-flight cache (migration-prompt §13.3 item 3) — this
   is exactly the class of "prove it, don't assume it" work item the
   migration prompt's Stage 3/4 requires evaluating with targeted
   measurements before enabling; **do not parallelize this loop in Stage 2**
   (single-thread parity), and treat it as an explicit, measured evaluation
   candidate no earlier than Stage 3.
3. **Hash computation itself (SHA-256 over one already-built string) is
   cheap relative to the geometry work that produces its input** — there is
   no meaningful performance upside to parallelizing the hash call itself,
   only (possibly) the string-building walk, which for checkpoint sizes
   observed in practice (bounded beam width 16, bounded frontier size) is not
   large enough to amortize thread-dispatch overhead. Not a parallelization
   target.
4. **The `while (true)` resume loop in `intrinsicSharedArchivePortfolio.ts`
   is definitionally sequential** — each iteration's `checkpoint` input is
   the *previous* iteration's output; there is no independent work here to
   parallelize, by construction.

**Summary for the Definition-of-Done checklist (migration-prompt §25):** this
cluster's Rust port work is "make it correct and byte-identical," not "make
it fast via Rayon." Any performance work applicable to this cluster belongs
to the *search* clusters that produce the values these functions hash
(`capacity-search.md`, `strict-decoder-gap-family.md`'s own parallelism
sections), not to checkpoint-encoding itself.

---

## 14. Tests and gates covering this cluster

- `tests/unit/intrinsicCapacityMode.test.ts`:
  - `'resumes at depth boundaries with the uninterrupted trace and endpoint'`
    (`:549`) — round-trips a real pause/resume cycle and asserts
    trace/endpoint equality against an uninterrupted run.
  - `'rejects corrupted checkpoint accounting and a changed pruning
    incumbent'` (`:634-...`, read in full for this document, excerpted in
    §8.0) — the primary corruption-handling test: object-spread-mutates
    `counters.deduplicatedSuccessors` to `-1` and a `budgetLedgers.perDepth[0].quotaExhausted`
    flag, asserting `IntrinsicCapacityError` with `operation ===
    'coldSearchCheckpoint'` for each.
  - `'resumes an exact warm prefix with the uninterrupted trace and
    endpoint'` (`:895`).
  - `'keeps the complete portfolio identical through canonical-grid
    checkpoints'` (`:1301`) — exercises the production interleaving path
    (§13 item 1) end-to-end.
  - Under `describe('experimental place/defer complete shadow', ...)`
    (`:1132`): `'resumes the defer boundary with the uninterrupted trace and
    endpoint'` (`:1134-1177`, read in full for this document — pauses at the
    single defer boundary, asserts the checkpoint's `placedPreparedIds` /
    `pendingPreparedIds` / `deferredPreparedIds` / `pendingOrder` exactly,
    then resumes and asserts `resumed.trace`/`resumed.endpoint` equal an
    uninterrupted run's) and `'rejects a checkpoint whose future defer
    decision state changed'` (`:1181-1211`, read in full — object-spreads a
    swapped `pendingPreparedIds`/`deferredPreparedIds`/`pendingOrder`/
    `deferralCounts` into a valid checkpoint and asserts rejection with
    `IntrinsicCapacityError`, `operation: 'placeDeferCheckpoint'`). **Both of
    these place-defer-shadow checkpoint tests live in
    `intrinsicCapacityMode.test.ts`, not in a file named for the shadow
    module itself** — worth knowing when searching for them.
- `tests/unit/intrinsicCapacityIntegration.test.ts` — separately exercises
  `captureExperimentalPlaceDeferCompleteShadow: true` as one flag among
  several in two broader integration assertions (`:391,632`), the only
  production-code (non-`intrinsicCapacityMode.test.ts`) paths that ever
  activate the place-defer shadow producer (§1.3); these do not add
  checkpoint-encoding-specific assertions beyond what the two tests above
  already cover.
- `tests/unit/intrinsicStrictDecoder.test.ts`:
  - `'reproduces uninterrupted canonical construction through every-piece
    resume'` (`:197`).
  - `'rejects corrupted direct state lineage and changed settlement policy'`
    (`:285`).
- `scripts/irregular-capacity-gate.ts` — does not itself construct, mutate,
  or validate a checkpoint object directly (confirmed by grep: the file's
  only `checkpoint`-adjacent reference is an unrelated `tmpdir()` path
  literal at `:970`); its `intrinsicCapacityLaneCoordinatorTraceValid` gate
  (referenced at `:1132` per `capacity-core.md`) validates *trace*
  self-consistency, not checkpoint-encoding bytes. **No dedicated
  checkpoint-encoding gate script exists in `scripts/`** — checkpoint
  correctness is covered exclusively by the unit tests listed above. This is
  worth flagging for Stage 0/18 test-inventory purposes: a Rust port's new
  differential checkpoint-byte tests (migration-prompt §18.3) will be
  genuinely new coverage, not a port of an existing gate.

---

## 15. Open questions and ambiguities

1. **Migration-prompt §9's singular framing ("Canonical checkpoint JSON must
   match the current custom encoding") does not match the source, which has
   four independent, behaviorally-distinct local encoders feeding three
   structurally-distinct checkpoint types plus one non-checkpoint digest
   builder (§3.4, §8).** This is not a contradiction requiring behavior
   change — the *individual* encoding rules the prompt lists (object keys
   sorted, arrays order-preserved, `undefined` omitted, BigInt-as-quoted-string,
   no incidental whitespace) do hold for three of the four encoders
   (Encoders A/B/C; Encoder D achieves the same *emergent* undefined-omission
   and bigint-quoting behavior through different mechanisms and has no
   explicit key sort at all) — but the prompt's implied singularity ("the
   current custom encoding," singular) is source-inaccurate and a Rust
   implementer who builds one shared "canonical JSON" module and points all
   checkpoint/fingerprint call sites at it **will produce wrong bytes** for
   at least the ordinal-vs-`localeCompare` divergence (§6, §8.1-8.2) even if
   no test case has yet been observed to exercise the divergence. **Reported
   here prominently per this task's instruction to surface source truth that
   contradicts the migration prompt's summary.**
2. **§10.2's open item**: does every `IrregularBeamState`-constructing call
   site inside `constructIntrinsicStrictState` forward the function's own
   `timingNow` seam into `IrregularBeamState`'s constructor options, or do
   some rely on `IrregularBeamState`'s own independent default
   (`performance.now.bind(performance)`)? One forwarding call site is
   confirmed (`intrinsicStrictDecoder.ts:644`); a full audit of every
   `new IrregularBeamState(...)`/state-transition call inside this file
   (there are several, per `strict-decoder-gap-family.md`'s own broader
   reading) was not performed as part of *this* document's narrower
   checkpoint-encoding focus. This matters because `IrregularBeamState`'s
   own `onPhaseTimings` diagnostic (not itself a checkpoint field, but a
   sibling diagnostic path) could be non-deterministic under a seamed
   top-level clock if an inner construction call silently reverts to the
   real clock. Recommend a full-file grep-and-trace pass during Stage 1/2
   implementation, not assumption.
3. **Whether `intrinsicCapacitySearch.ts` should receive a new `timingNow`
   seam mirrored into TypeScript (as migration-prompt §11 explicitly
   requests: "add an equivalent test-only clock seam where needed")** is a
   product decision outside this characterization document's authority (per
   this task's framing: "Never propose behavior changes; document what IS").
   Flagging the gap (§10.2) is this document's job; deciding whether to close
   it via a new TS seam (matching prompt §11) or a Rust-only seam validated
   against production non-deterministic timing is a Stage 1 implementation
   decision for the parent workflow.
4. **`localeCompare`'s exact behavior is locale/ICU-build-dependent** (§6) —
   this document confirmed one example divergence (`'a'.localeCompare('B')
   === -1` vs. plain `'a' < 'B' === false`) under the Node version installed
   in this repository's dev environment at the time of writing, but did not
   enumerate every key string that could ever reach Encoder B/C's sort
   comparator, nor pin the exact ICU/Node version this behavior depends on.
   A byte-level differential test suite (migration-prompt §18.3) should pin
   this explicitly rather than relying on this document's spot-check.
5. **Whether any historical/legacy checkpoint bytes are persisted anywhere
   outside this repository** (e.g. in a support ticket, a saved job file, an
   Electron user-data directory from a previous release) that a Rust port
   might need to remain compatible with, is unknown from source alone — §8.0
   establishes that the *current* production code path never persists
   checkpoints, but migration-prompt §11's "If cross-language checkpoint
   persistence is currently externally supported, preserve compatibility"
   framing implies the possibility was considered. This document's source
   tracing found no evidence of externally-supported persistence; this is
   recorded as an open question for the parent workflow to confirm with the
   product owner, not resolved unilaterally here.
6. **`IntrinsicAnytimeProducerRole`'s two checkpoint-shape-incompatible
   members** (`'legacy-complete'`, `'experimental-place-defer-complete'`,
   §3.1) suggest a broader "anytime checkpoint" type family was planned or
   partially refactored away — worth a direct question to the TS codebase's
   maintainers (or a git-blame/history check, not performed as part of this
   document) about whether a future TS refactor might unify these before the
   Rust port stabilizes its own type boundaries, since porting three
   separate structs today and later needing to re-unify them if TS unifies
   first would be wasted work. Flagged, not resolved.

---

## Cross-reference index (for a Rust implementer navigating this cluster)

| Concern | Primary source in this document | Deeper detail lives in |
|---|---|---|
| Capacity checkpoint's full per-branch validation walk | §3.1, §8.4 | `capacity-search.md` §9 |
| Capacity checkpoint's production scheduling role | §1.3, §13 item 1 | `capacity-core.md` §1 |
| Strict-direct checkpoint's full per-branch validation walk | §3.2, §8.4 | `strict-decoder-gap-family.md` §3.6, §9-11 |
| Strict-direct checkpoint's throw/defect construction failure | §8.4, §11 | `strict-decoder-gap-family.md` §11 |
| `IrregularPreparedPiece` conditional-property-omission pattern | §3.1, §12 item 3 | `capacity-core.md` §3, `periodic.md` §3 |
| Non-checkpoint sibling `canonicalJson` (source-audit digests) | §0, §8.3 | `periodic.md` §5 item 17, §7-8 |
| Cooperative-cancellation `control.checkpoint(phase)` homonym | §1.1, §10.1 | `nfp-ifp.md`, `worker-coordination.md` |
| `AppErrorCode` external mapping for checkpoint failures | §11 | `errors-protocol.md` |
| `IrregularBeamState` full public surface | §2, §12 item 1 | `capacity-core.md` §2 |
