# Characterization: capacity-search cluster

Cluster files (read completely, line-by-line, for this document):

- `src/workers/algorithm/irregular/intrinsicCapacitySearch.ts` (2273 lines)
- `src/workers/algorithm/irregular/intrinsicCapacityPrefixes.ts` (159 lines)
- `src/workers/algorithm/irregular/intrinsicCapacityTelemetry.ts` (159 lines)

Supporting files read partially (not exhaustively) to trace callers, types, and
cross-file invariants that this cluster depends on or feeds. Their line
numbers are cited only for the specific facts used; they are **not** fully
characterized here and remain open work for their own cluster passes:
`src/workers/algorithm/irregular/intrinsicCapacityMode.ts`,
`src/workers/algorithm/irregular/computeIrregularNesting.ts`,
`src/workers/algorithm/irregular/intrinsicCapacityEndpoint.ts`,
`src/workers/algorithm/irregular/intrinsicCapacityMaterial.ts`,
`src/workers/algorithm/irregular/irregularBeamState.ts`,
`src/workers/algorithm/irregular/intrinsicStrictDecoder.ts`,
`src/workers/algorithm/irregular/intrinsicSharedArchivePortfolio.ts`,
`src/workers/algorithm/irregular/intrinsicAnytimeArchive.ts`,
`src/workers/algorithm/irregular/irregularPlacementScorer.ts`,
`src/workers/irregular/clipper2OffsetPolicy.ts`,
`src/workers/irregular/canonicalLayoutGeometry.ts`,
`src/workers/irregular/services.ts`,
`src/shared/irregular/domain.ts`.

All line numbers below refer to the current checkout at the time of writing
(branch `main`, no local modifications; verify against `git rev-parse HEAD`
before relying on exact numbers if the files have changed).

---

## 1. Purpose and role in Compact / Compact Short Side execution

This cluster implements **`intrinsic-capacity-v1`**, the empty-start
depth-synchronized beam search that produces the best-known exact **partial**
(subset) placement when the requested sheet cannot hold every prepared piece.
It is the "capacity" side of the archive-only Compact production authority
described in the migration prompt (`docs/prompts/fable5-rust-irregular-nesting-implementation.md`
§10-§11).

- `intrinsicCapacitySearch.ts` — the search engine itself
  (`runIntrinsicCapacityColdSearch`), its checkpoint encode/validate/hash
  machinery, and the endpoint-comparator support functions it privately uses
  (`compareCapacityBeamEntries` family, `retainCapacityBeamEntries` /
  `retainCapacityCohesionFrontier`).
- `intrinsicCapacityPrefixes.ts` — captures up to 9 zero-evaluation
  "warm prefix" descriptors from the **complete** (legacy) direct
  constructors' committed lineages and terminalizes the fitting ones into
  zero-search incumbent endpoints and warm-lane seeds.
- `intrinsicCapacityTelemetry.ts` — a strictly observer-only, non-authoritative
  shadow probe (`measureIntrinsicCapacityShadowTelemetry`) that runs a
  4-depth-bounded cold search purely to report pressure/no-skip-frontier
  diagnostics; explicitly documented as having `routingInfluence: 'none'`
  (`intrinsicCapacityTelemetry.ts:37`, `:120`, `:157`).

### Liveness on the production path (traced, not assumed)

`coordinateIntrinsicSharedArchive` in `computeIrregularNesting.ts:474` is
explicitly commented **"Runs the intrinsic archive as the compact production
path."** (`computeIrregularNesting.ts:473`). It is reached from
`computeIrregularNesting` for every Compact/Compact-Short-Side request when
`isIntrinsicSharedArchiveEligible(settings)` is true
(`computeIrregularNesting.ts:483`, gate function at `:1695-1697`). Inside it:

- If exact preflight proves impossibility
  (`preflight.kind === 'proven_impossible'`, `:570`), it calls
  `runIntrinsicCapacityMode({ routing: 'preflight-proven-impossible', ... })`
  directly (`:585-594`), which is a thin wrapper (`intrinsicCapacityMode.ts:1143-1411`)
  around this cluster: it calls `captureIntrinsicCapacityPrefixDescriptors`
  (`intrinsicCapacityMode.ts:1168`, this cluster) and
  `terminalizeIntrinsicCapacityPrefixEndpoints` (`:1172`, this cluster), then
  `runIntrinsicCapacityColdSearch` (`:1200`, this cluster) once, unbounded.
- Otherwise (inconclusive preflight), a **scheduler cold quantum**
  (`runIntrinsicCapacitySchedulerColdQuantum`, `intrinsicCapacityMode.ts:386-431`,
  itself a thin wrapper around `runIntrinsicCapacityColdSearch` bounded to
  `maximumDepthBoundaries = min(4, pieceCount)`) is started **before** the
  legacy complete archive even begins (`computeIrregularNesting.ts:605-614`),
  interleaved with the complete archive's own checkpoint callback
  (`onCanonicalGridCheckpointed`, `:650-703`) — this is the "anytime scheduler"
  chronology. If the complete archive ends with **no fitting winner**
  (`winner === undefined`, `:959`), `runIntrinsicCapacityMode` is invoked again
  with `routing: 'bounded-complete-archive-miss'`, this time with
  `coordinateProtectedLanes: true`, `scheduledColdStart`,
  `captureWarmPrefixTelemetry: true`, `admitWarmPrefixEndpoints: true`
  (`:959-978`). This drives `runProtectedCapacityLaneCoordinator`
  (`intrinsicCapacityMode.ts:467-999`), which repeatedly calls
  `runIntrinsicCapacityColdSearch` (this cluster) for the cold lane, every
  warm-prefix lane (one per fitting prefix descriptor from this cluster's
  `intrinsicCapacityPrefixes.ts`), and the quality-warm-prefix lane.

**All three files in this cluster are live on the production Compact /
Compact Short Side path** whenever a request lands on a constrained sheet
(no fitting complete endpoint) or preflight proves impossibility outright.
`intrinsicCapacityTelemetry.ts` is live only in the sense that it is wired
into `computeIrregularNesting.ts:539-545` behind the
`options?.captureCapacityShadowTelemetry === true` flag; its output never
reaches selection, ranking, or the returned layout — confirmed by the
`routingInfluence: 'none'` field it always returns.

**Production values verified directly from source** (compare against the
migration prompt §11 summary — all confirmed *except* for the retention-mode
nuance flagged in §15):

| Bound | Source | Value |
| --- | --- | --- |
| Cold beam width | `INTRINSIC_CAPACITY_V1_BOUNDS.coldBeamWidth`, `intrinsicCapacitySearch.ts:55` | `16` |
| Legal-placement fanout | `INTRINSIC_CAPACITY_V1_BOUNDS.localLegalPlacementFanout`, `:56` | `3` |
| Minimum total evaluation cap | `INTRINSIC_CAPACITY_V1_BOUNDS.minimumPlacementEvaluationCap`, `:57` | `50_000` |
| Per-depth evaluation quota | `INTRINSIC_CAPACITY_V1_BOUNDS.placementEvaluationQuotaPerDepth`, `:58` | `4_096` |
| Total evaluation cap formula | `:352-355` | `max(50_000, pieceCount * 4_096)` |
| Permanent-skip successor | reserved for **every** retained beam entry before spending the depth's placement quota | `:549-580`, confirmed |
| Checkpoint version | `INTRINSIC_ANYTIME_CHECKPOINT_VERSION`, `:61` | `'intrinsic-anytime-checkpoint-v3'` |
| Max captured prefix descriptors | `INTRINSIC_CAPACITY_MAXIMUM_PREFIX_DESCRIPTORS`, `intrinsicCapacityPrefixes.ts:16` | `9` (3 direct roles × 3 depths) |
| No-skip probe depth (telemetry only) | `INTRINSIC_CAPACITY_NO_SKIP_PROBE_DEPTH`, `intrinsicCapacityTelemetry.ts:14` | `4` |
| Scheduler cold quantum depths | `INTRINSIC_ANYTIME_SCHEDULER_COLD_QUANTUM_DEPTHS`, `intrinsicCapacityMode.ts:383` | `4` |
| Warm pilot depth boundaries | `INTRINSIC_CAPACITY_WARM_PILOT_DEPTH_BOUNDARIES`, `intrinsicCapacityMode.ts:459` | `1` |
| Quality-lane minimum piece count | `INTRINSIC_CAPACITY_QUALITY_MINIMUM_PIECE_COUNT = coldBeamWidth * 2`, `intrinsicCapacityMode.ts:460-461` | `32` |

**Critical undocumented-by-the-prompt nuance (see §15 for full detail):** in
production the beam-retention comparator is **not** the plain objective
comparator implied by "beam width 16, fanout 3". The default production
`retentionMode` is `'cohesion-frontier'`
(`computeIrregularNesting.ts:533-538`, defaulted whenever
`options?.intrinsicCapacityRetentionShadow` is not `'area-first'`/`'axis-buckets'`),
which (a) adds a 4th "contact" successor beyond the 3-wide compactness fanout
at every (beam entry × piece) depth transition
(`intrinsicCapacitySearch.ts:762-783`), and (b) retains the 16-wide beam via a
5-bucket topology-stratified reservation (`retainCapacityCohesionFrontier`,
`:1881-1964`), not a single top-16-by-objective sort.

---

## 2. Entry points, callers, callees (traced)

### Exported entry points in this cluster

`intrinsicCapacitySearch.ts`:
- `runIntrinsicCapacityColdSearch(input)` — `:329-1003`. The search engine.
- `materializeIntrinsicCapacityCheckpointEndpoints(input)` — `:1010-1048`.
  Converts a paused checkpoint's frontier into ranked endpoints without
  resuming the search (used to report "best known so far" from a censored
  lane).
- `INTRINSIC_CAPACITY_V1_BOUNDS`, `INTRINSIC_ANYTIME_CHECKPOINT_VERSION`,
  `compareIntrinsicCapacityEnvelopeAreas` (`:1817-1825`, also exported and
  unit-tested directly) — public constants/helpers.

`intrinsicCapacityPrefixes.ts`:
- `intrinsicCapacityPrefixDepths(pieceCount)` — `:34-41`.
- `captureIntrinsicCapacityPrefixDescriptors(input)` — `:49-83`.
- `terminalizeIntrinsicCapacityPrefixEndpoints(input)` — `:121-158`.
- `INTRINSIC_CAPACITY_MAXIMUM_PREFIX_DESCRIPTORS`.

`intrinsicCapacityTelemetry.ts`:
- `measureIntrinsicCapacityShadowTelemetry(input)` — `:40-135`.
- `INTRINSIC_CAPACITY_NO_SKIP_PROBE_DEPTH`.

### Callers (grepped, all in `intrinsicCapacityMode.ts` and
`computeIrregularNesting.ts`; verified with
`grep -rn "runIntrinsicCapacityColdSearch\|materializeIntrinsicCapacityCheckpointEndpoints\|captureIntrinsicCapacityPrefixDescriptors\|terminalizeIntrinsicCapacityPrefixEndpoints\|measureIntrinsicCapacityShadowTelemetry"`)

`runIntrinsicCapacityColdSearch` call sites, all in `intrinsicCapacityMode.ts`
unless noted:
1. `:409` — `runIntrinsicCapacitySchedulerColdQuantum`, unbounded-role
   wrapper used by the anytime scheduler's cold quantum (bounded to 4
   depths, or 1 on resume).
2. `:519` — cold lane initial bounded run inside
   `runProtectedCapacityLaneCoordinator`.
3. `:570` — cold lane checkpoint resume (unbounded resume of the paused cold
   checkpoint) inside the same coordinator.
4. `:619` — one bounded (`maximumDepthBoundaries: 1`) pilot run per fitting
   prefix descriptor (warm-prefix lanes).
5. `:683` — resume of the single best-paused warm-prefix lane, looped while
   aggregate budget allows.
6. `:771` — quality-warm-prefix lane initial bounded (1 depth) run.
7. `:806` — quality-warm-prefix lane resume loop (1 depth per iteration).
8. `:1093` — `runIntrinsicCapacityCohesionShadow`, a **separate, explicitly
   shadow-only** observer lane (`retentionMode: 'cohesion-frontier-shadow'`),
   gated by `input.captureCohesionShadow === true`; its endpoint never enters
   selection (`intrinsicCapacityMode.ts:1104-1128`, consumed only via
   `onCohesionShadowLane` callback).
9. `:1200` — `runIntrinsicCapacityMode`'s own direct fallback call when no
   lane coordinator ran and no scheduled cold start was settled.
10. `:1248` — legacy (non-coordinated) warm-prefix telemetry loop, used only
    when `input.captureWarmPrefixTelemetry === true` **and**
    `coordinated === undefined` (i.e. `coordinateProtectedLanes` was not
    requested) — a dead branch in the current default production call
    pattern from `computeIrregularNesting.ts`, since production always sets
    `coordinateProtectedLanes: true` together with
    `captureWarmPrefixTelemetry: true` (`computeIrregularNesting.ts:969-976`);
    this loop remains reachable from test harnesses / `scripts/irregular-capacity-gate.ts`'s
    paired arms.
11. `intrinsicCapacityTelemetry.ts:89` — the shadow no-skip probe, bounded to
    `min(4, pieceCount - 1)` depths, gated behind
    `options?.captureCapacityShadowTelemetry === true`.

`materializeIntrinsicCapacityCheckpointEndpoints` call site:
`intrinsicCapacityMode.ts:1023` inside `makeProtectedCapacityLane`, used
whenever a lane's `result.status !== 'settled'` (i.e. it paused) to report its
best-known endpoints from the frontier without resuming.

`captureIntrinsicCapacityPrefixDescriptors` / `terminalizeIntrinsicCapacityPrefixEndpoints`
call sites: both only at `intrinsicCapacityMode.ts:1168` and `:1172`,
sequentially, inside `runIntrinsicCapacityMode`.

`measureIntrinsicCapacityShadowTelemetry` call site: only
`computeIrregularNesting.ts:540`.

### Callees (traced from imports at the top of each file)

`intrinsicCapacitySearch.ts` imports and calls, in the hot loop:
- `toGridMm` (`clipper2OffsetPolicy.ts:44`) — float-mm → canonical-grid-int
  conversion (§7).
- `measureCanonicalLayoutTopologyExact` (`canonicalLayoutGeometry.ts:160`) —
  **only** when `captureTopologyRetention` is true; drives
  `retainCapacityCohesionFrontier`'s topology metrics. Out of this cluster's
  scope but directly participates in production beam retention (see §15).
- `GeometryKernel.transformCollisionGeometry`, `NfpIfpService.generatePlacementCandidates`
  (`services.ts`) — geometry preparation and legal-candidate generation; both
  are `Effect` services injected via the `GeometryKernel | GeometrySettings |
  NfpIfpService` requirement.
- `originAnchorCandidates`, `transformCandidateOrder`, `INTRINSIC_COORDINATE_DOMAIN`
  (`intrinsicStrictDecoder.ts:1742-1756`, `:53-58`, `:47-51`).
- `IrregularPlacementScorer.Make.scoreCandidate` (`irregularPlacementScorer.ts`)
  — only when `captureTopologyRetention` is true, for the "contact" successor
  role's `sharedCollisionBoundaryLengthMm`.
- `IrregularBeamState` (`irregularBeamState.ts`) — the actual placement state
  machine (`.empty`, `.withPlacement`, `.withUnplacedPiece`,
  `.canonicalOccupiedGeometryKey`, `.bottomLeftAnchoredCanonicalOccupiedGeometryKey()`,
  `.continuationMetadataIdentity()`, `.canonicalEntryContinuationIdentity()`,
  `.placedCollisionIndex`, `.translatedCollisionBounds`).
- `intrinsicCapacityEndpoint.ts`'s `compareIntrinsicCapacityEndpoints`,
  `intrinsicCapacitySpanFitsSheet`, `intrinsicCapacityStateGridSpan`,
  `materializeIntrinsicCapacityEndpoint`, `measureIntrinsicCapacityCavities`.
- `intrinsicCapacityMaterial.ts`'s `intrinsicCapacityPreparedPieceId`.
- `intrinsicCapacityPreflight.ts`'s `IntrinsicCapacityError` (the tagged
  error class this whole cluster raises).

`intrinsicCapacityPrefixes.ts` imports: `intrinsicCapacityEndpoint.ts`
(`compareIntrinsicCapacityEndpoints`, `materializeIntrinsicCapacityEndpoint`),
`intrinsicCapacityMaterial.ts` (`intrinsicCapacityPreparedPieceId`),
`intrinsicSharedArchivePortfolio.ts` (`INTRINSIC_SHARED_ARCHIVE_DIRECT_ROLES`
= `['canonical-grid', 'legacy-absolute-envelope', 'open-pocket-first']`,
`intrinsicSharedArchivePortfolio.ts:41-45`).

`intrinsicCapacityTelemetry.ts` imports: `intrinsicCapacityMaterial.ts`'s
`intrinsicCapacityMaterialAreas`, `intrinsicCapacityPreflight.ts`'s
`IntrinsicCapacityPreflightOutcome` type, and this cluster's own
`runIntrinsicCapacityColdSearch` / `INTRINSIC_ANYTIME_CHECKPOINT_VERSION`.

---

## 3. Data in/out: exact types/shapes, optional-field presence/omission semantics

### `RunIntrinsicCapacityColdSearchInput` (`intrinsicCapacitySearch.ts:259-278`)

Required: `sheet: SheetSpec`, `preparedPieces: ReadonlyArray<IrregularPreparedPiece>`,
`materialAreasByPieceId: ReadonlyMap<PieceId, bigint>`, `cavityCache: IntrinsicCapacityCavityCache`.

Optional (all genuinely absent-vs-present, not merely nullable):
- `incumbent?: IntrinsicCapacityEndpoint` — enables attainable-count/material
  pruning (`:791-810`) only when present.
- `control?: IrregularNfpIfpControl` — enables the single cancellation
  checkpoint call (`:599`) and is threaded into `generatePlacementCandidates`
  (`:615`) only when present (`...(input.control === undefined ? {} : { control: input.control })`).
- `capturePhaseTimings?: boolean` — gates all `performance.now()` phase
  bucketing; `phaseTimings` in the result is `undefined` unless `=== true`.
- `checkpoint?: IntrinsicAnytimeCheckpoint` — resume mode; triggers full
  checkpoint validation (§9) before any search work.
- `maximumDepthBoundaries?: number` — bounds this invocation to pause after N
  completed depth boundaries; combined with `checkpoint !== undefined`
  toggles `checkpointEnabled` (`:415`).
- `warmPrefixSeed?: IntrinsicCapacityWarmPrefixSeed` — an exact skip-free
  prefix state to seed a single-entry beam at a non-zero depth.
- `schedulerDeficit?: number` — pure pass-through bookkeeping into the
  checkpoint; defaults to `0` wherever read (`:433`, `:1592`).
- `retentionMode?: IntrinsicCapacityRetentionMode` — defaults internally to
  `'objective'` (`:833`) only when the caller omits it; production always
  passes it explicitly (see §1).

### `IntrinsicCapacitySearchResult` (`:250-257`)

`status: 'paused' | 'settled'`. `endpoints` is empty (`[]`) on `'paused'`
(never partially populated — `:919`). `trace` is always present.
`phaseTimings: undefined` unless `capturePhaseTimings === true`.
`checkpoint: undefined` on `'settled'` (`:1000`), always present on `'paused'`.

### `IntrinsicAnytimeCheckpoint` (`:154-172`)

All fields are structurally required in the TS type, but two are
semantically optional-content:
- `incumbentBinding: IntrinsicAnytimeIncumbentBinding | undefined` — `undefined`
  when no `input.incumbent` was supplied; this is a real value-level
  `undefined`, not a missing key, and it is explicitly **omitted** from the
  canonical JSON used for hashing (`canonicalJson` filters `fieldValue !==
  undefined`, `:1631`) — so "no incumbent" and "incumbent explicitly absent"
  hash identically to a JSON object that never had the key.
- `topologyRetentionDepths: ReadonlyArray<...>` — always an array (never
  `undefined`) in the checkpoint; contrast with the search **trace**'s
  `topologyRetentionDepths`, which is presence/omission-encoded: `undefined`
  when the accumulated array has length `0`, otherwise the array itself
  (`makeIntrinsicCapacitySearchTrace`, `:1077-1080`). This is an
  intentional divergence between the checkpoint type (always-array) and the
  trace type (omit-when-empty) that a Rust port must reproduce field-by-field.

### `IntrinsicAnytimeDecisionState` (frontier entry, `:93-111`)

`continuationMetadataIdentity: string` is a **cached, recomputed-on-validate**
string (not derived lazily); `deferredPreparedIds` is always `[]` in the cold
search's checkpoints (no defer concept exists in this cluster — validation
rejects any non-empty value, `:1426`). `pass` is always `0`, `deferralCounts`
is always `{}` (`:1220-1221`) — these fields exist in the type only because
the checkpoint shape is shared conceptually with other anytime producers that
do use deferral; this cluster never populates them.

### `IntrinsicCapacityEndpoint` (from `intrinsicCapacityEndpoint.ts:40-54`,
consumed/produced throughout this cluster)

`sourceRole: string | undefined`, `prefixDepth: number | undefined` are
genuinely optional and are set from `input.warmPrefixSeed`'s presence
(`intrinsicCapacitySearch.ts:951-956`) or from a prefix descriptor's role/depth
(`intrinsicCapacityPrefixes.ts:135-137`); absent otherwise (both fields
default via spread-omission, `materializeIntrinsicCapacityEndpoint` input
type marks them optional at `intrinsicCapacityEndpoint.ts:149-150`).

### `IrregularPlacement.pieceId` omission pattern used by this cluster

`makeCapacityPlacement` (`intrinsicCapacitySearch.ts:2239-2256`) explicitly
branches on `piece.pieceId === undefined` to choose between constructing
`IrregularPlacement` **without** a `pieceId` key at all versus **with** it:

```ts
return piece.pieceId === undefined
  ? new IrregularPlacement(input)
  : new IrregularPlacement({ ...input, pieceId: piece.pieceId })
```

`IrregularPlacement`'s constructor (`src/shared/irregular/domain.ts:694-711`)
uses `Object.prototype.hasOwnProperty.call(fields, 'pieceId')` to decide
whether to assign `this.pieceId` at all — so a caller that passes
`pieceId: undefined` explicitly produces a different own-property-enumeration
shape than a caller that omits the key, even though both read back as
`undefined`. This is exactly the "preserve omitted versus present optional
fields" hazard called out in the migration prompt §9/§8.2 — a Rust `Option<T>`
with `#[serde(skip_serializing_if = "Option::is_none")]` (or equivalent) must
be driven by the **same boolean condition** (`piece.pieceId === undefined`),
not by whatever representation is easiest in Rust.

### `IrregularBeamState` (dependency, not in this cluster) fields consumed here

`remainingPreparedPieces`, `placedCollisionGeometries`, `unplacedPieceIds`,
`placementOrder`, `parent`, `canonicalOccupiedGeometryKey`,
`translatedCollisionBounds`, `placedCollisionIndex`,
`.continuationMetadataIdentity()`, `.canonicalEntryContinuationIdentity()`,
`.bottomLeftAnchoredCanonicalOccupiedGeometryKey()`,
`.withQuarterTurnBottomLeft(rotationDeg)` (used by
`intrinsicCapacityEndpoint.ts`'s `materializeIntrinsicCapacityEndpoint`, not
directly by this cluster's files but on the same object type this cluster
threads through).

---

## 4. Algorithm state and every mutation point

### Per-invocation local state (`runIntrinsicCapacityColdSearch`)

All of the following are `let`-mutable locals scoped to one call of
`runIntrinsicCapacityColdSearch`, seeded from `input.checkpoint` when
resuming, and are the **entire** mutable state of the search besides `beam`
itself:

- `consumedPlacementEvaluations` (`:460-461`) — incremented once per
  candidate actually evaluated (`:636`), never decremented.
- `prunedByAttainableCount`, `prunedByAttainableMaterial`,
  `deduplicatedSuccessors`, `fitRejectedCandidates`, `invalidCandidates`,
  `endpointFitRejections`, `completedDepths`, `depthQuotaExhaustions`
  (`:462-469`) — monotonic counters, each incremented at exactly one call
  site (traced individually in §6/§10 tables below).
- `settlement: IntrinsicCapacitySettlement` (`:470`) — starts `'exhausted'`,
  set to `'evaluation-cap'` the moment any depth's evaluation quota or the
  global cap is hit (`:628`), **never reset back**. Note: the early-pause
  return path (`:916-933`) constructs its trace with the **literal**
  `settlement: 'paused'` (`:928`), bypassing this variable entirely — so a
  search that hits `'evaluation-cap'` at depth D and *also* reaches its
  requested pause boundary at that same depth reports `'paused'`, not
  `'evaluation-cap'`, in the returned trace (pause precedence wins).
- `perDepthBudgetLedgers` (`:471-477`) — appended to once per completed depth
  **only when `checkpointEnabled` is true** (`:857-865`); for a full
  unbounded run with no checkpoint/pause request this bookkeeping array is
  never extended past its (possibly resumed) initial value.
- `noSkipFrontier` (`:478-482`) — updated once per completed depth, same
  `checkpointEnabled` gate (`:866-872`); `firstLossDepth` is set (once, via
  `??`) the first depth at which no beam entry has zero permanently-skipped
  pieces.
- `completedDepthBoundariesThisInvocation` (`:484`) — counts depths completed
  *within this call only* (reset to 0 on each fresh invocation, unaffected by
  resumed counters), used solely for the `maximumDepthBoundaries` pause test.
- `topologyRetentionDepths` (`:485-487`) — appended to once per depth, only
  when `captureTopologyRetention` is true (`:836-854`).
- `beam: ReadonlyArray<CapacityBeamEntry>` (`:489`) — **fully replaced** at
  the end of every depth iteration by `retainCapacityBeamEntries(...)`
  (`:830-835`); never mutated in place. Initial value is one of three
  disjoint cases (§1/§9): checkpoint frontier, single warm-prefix seed
  entry, or the single empty-state entry.

### Per-depth local state (inside the `for (let depth = ...)` loop, `:522-935`)

- `successors: CapacityBeamEntry[]` and `successorKeys: Set<string>`
  (`:537-538`) — accumulate across **all** beam entries for this depth (both
  skip successors, `:550-580`, and placement successors from every entry's
  `buildReference`, `:692-757`/`:772-783`). `successorKeys` is the
  depth-global dedup set keyed by `intrinsicCapacitySuccessorIdentity`
  (`:1664-1669` = `anchoredOccupiedKey + sorted(placementOrder)` as JSON).
- `contactSuccessorIdentities: Set<string>` (`:539`) — tracks which
  successor identities came from the "contact" proposal role, consumed only
  by the topology-retention trace (`:844-850`).
- `contactFanoutTrace` (`:540-547`) — mutable accumulator object for the
  observer-only contact-fanout trace, updated at 6 distinct sites
  (`:618`, `:668-674`, `:752`, `:775`, `:846-850`).
- Per beam-entry, per-transform: `scored: EvaluatedCandidateReference[]`
  (`:586`) — fresh per beam entry, filled by `evaluateCandidate` results that
  pass the exact q0/q90 span pre-check (`:642-650`), then **sorted in place**
  with `Array.prototype.sort` (mutating, stable) using
  `compareScoredCandidateReferences` (`:689`).
- `consumedAtDepth`, `depthQuotaExhausted` (`:582-583`) — per-depth quota
  bookkeeping; `depthQuotaExhausted` set `true` the instant either the
  per-depth quota (`4096`) or the global cap is hit (`:625-633`), and this
  short-circuits the **outer** `for (const entry of beam)` loop too
  (`if (depthQuotaExhausted) break`, `:585`) — once exhausted mid-depth, no
  further beam entries are even attempted at that depth.
- `builtCount`, `builtCandidateKeys` (`:690-691`) — per beam-entry; caps the
  compactness-role successors at `localLegalPlacementFanout` (`3`, `:759`)
  and records which specific candidate (by `capacityCandidateReferenceIdentity`,
  transform-index:gridX:gridY) has already been built, so the subsequent
  contact-role pass (`:762-783`) skips candidates already selected by the
  compactness pass.

### Mutation ordering within one depth (exact sequence, all file:line)

1. Reserve one skip successor per current beam entry — `:550-580`.
2. For each current beam entry, for each transform (sorted by
   `transformCandidateOrder`), generate legal candidates and score them —
   `:584-686`.
3. Sort `scored` (stable) and build up to 3 compactness successors, then
   (topology-retention modes only) up to 1 contact successor — `:688-784`.
4. Increment `depthQuotaExhaustions` if this depth exhausted its quota —
   `:786`.
5. Prune `successors` by strict attainable-count/attainable-material against
   `input.incumbent` (only if provided) — `:791-810`.
6. Measure exact cavities for every surviving non-empty-placement successor,
   dropping any whose cavity measurement fails — `:812-826`.
7. Retain the depth's next beam via `retainCapacityBeamEntries` — `:827-835`.
8. Append the topology-retention depth trace, if capturing — `:836-854`.
9. Advance `completedDepths`, `completedDepthBoundariesThisInvocation`;
   conditionally extend `perDepthBudgetLedgers`/`noSkipFrontier` — `:855-873`.
10. Break the whole search if `beam.length === 0` — `:875`.
11. If a requested pause boundary was reached, build and return a checkpoint
    (early return, terminates the function) — `:876-934`.

### Terminal materialization (after the depth loop exits normally, `:937-1001`)

For each surviving beam entry, materialize an endpoint
(`materializeIntrinsicCapacityEndpoint`), skip it (incrementing
`endpointFitRejections`) if it fails final canonical-grid legality/orientation
fit, and deduplicate by `canonicalGeometryHash` into a `Map` keeping the
better of any two colliding endpoints per `compareIntrinsicCapacityEndpoints`
(`:964-967`) — then sort the deduplicated map's values with `.toSorted(compareIntrinsicCapacityEndpoints)`
(`:969`) to produce the final `endpoints` array.

---

## 5. Ordering sources: sorts, Map/Set insertion order, iteration order

### Stable sorts (all rely on ECMA-262 guaranteed-stable `Array.prototype.sort`/`toSorted` since ES2019)

| Site | Comparator | Purpose |
| --- | --- | --- |
| `:587-589` | `transformCandidateOrder` (`intrinsicStrictDecoder.ts:53-58`, an `Effect Order.combineAll` chain on `index, rotationDeg, mirrored, reason`) | Per-piece transform evaluation order |
| `:689` | `compareScoredCandidateReferences` (`:1731-1743`) | Ranks scored candidates before the top-3 compactness cut |
| `:771` | `compareContactCandidateReferences` (`:1745-1754`), via `.toSorted(...)[0]` | Picks the single best positive-contact candidate not already built |
| `:969` | `compareIntrinsicCapacityEndpoints` | Final endpoint ranking |
| `:1047` | same, in `materializeIntrinsicCapacityCheckpointEndpoints` | Checkpoint-frontier endpoint ranking |
| `:1834` | `compareCapacityBeamEntries` | `'objective'` retention mode |
| `:1837` | `compareCapacityBeamEntriesAreaFirst` | `'area-first-shadow'` retention mode |
| `:1874-1877` | `compareCapacityBeamEntries` / Width-first / Height-first (×2 more) | `'axis-buckets-shadow'` retention mode (the un-labelled `else` branch, reachable only for this one mode — see §15) |
| `:1942-1962` | objective / isolated / largest-component / component-count+hull-waste / objective again | `retainCapacityCohesionFrontier`, 5-step bucketed reservation (the **production default** path — see §1/§6) |
| `:2022` | `compareCapacityBeamEntries` | topology trace "best accounting stratum" computation |
| `:2083` | per-representative-role comparator | topology trace representative selection |
| `intrinsicCapacityMode.ts:497` | `second.depth - first.depth` | picks the deepest `'canonical-grid'` fitting descriptor for the quality lane |

**Insertion order that a stable sort must preserve, precisely traced for the
main successor pipeline:** within one depth, `successors` accumulates in this
order: (a) all skip successors, in `beam` array order (which is the
**previous** depth's retention output order, itself topology-bucket-ordered
in production — not simply objective-sorted); then (b) for each beam entry in
that same order, its compactness successors in `scored`-sorted order (up to
3), then (c) its single contact successor if any. Any tie in a downstream
retention comparator (e.g. two beam entries with byte-identical
`anchoredOccupiedKey` from different placed-ID sets — see §6) resolves by
this exact insertion order under a stable sort. **A Rust port must reproduce
this insertion order exactly (e.g. by attaching an explicit ordinal and using
a stable sort or an ordinal tiebreaker), not just "a" plausible order.**

### `Map`/`Set` whose insertion or iteration order is observable

- `successorKeys: Set<string>` (`:538`) — membership-only use (`.has`/`.add`),
  never iterated; **not** an ordering hazard by itself, but its *presence*
  gates which successors reach the ordered `successors` array.
- `builtCandidateKeys: Set<string>` (`:691`) — same, membership-only.
- `contactSuccessorIdentities: Set<string>` (`:539`) — membership-only,
  consumed via `.has()` inside a `.filter()` (`:846-849`), so only its
  content (not iteration order) matters.
- `endpointsByHash: Map<string, IntrinsicCapacityEndpoint>` (`:938`, `:1019`)
  — insertion order is **not** observable because the final result is always
  re-sorted via `[...endpointsByHash.values()].toSorted(...)` (`:969`,
  `:1047`); safe to port to any hash map as long as the final sort is
  preserved.
- `topologyByIdentity: Map<string, ...>` inside `makeCapacityTopologyMeasurements`
  (`:1977-2001`) — pure memo cache keyed by `intrinsicCapacitySuccessorIdentity`,
  never iterated; safe.
- `statesByProcessedCount: Map<number, IrregularBeamState>` inside
  `captureIntrinsicCapacityPrefixDescriptors` (`intrinsicCapacityPrefixes.ts:61`)
  — keyed by integer depth, only `.get`/`.has` used; safe.
- `endpointsByHash: Map<string, IntrinsicCapacityEndpoint>` inside
  `terminalizeIntrinsicCapacityPrefixEndpoints` (`intrinsicCapacityPrefixes.ts:127`)
  — same pattern, re-sorted at `:149`; safe.

### Iteration orders that reach output/traces

- `INTRINSIC_SHARED_ARCHIVE_DIRECT_ROLES` iteration order
  (`captureIntrinsicCapacityPrefixDescriptors`, `intrinsicCapacityPrefixes.ts:58`)
  = `['canonical-grid', 'legacy-absolute-envelope', 'open-pocket-first']`,
  fixed array literal order — determines descriptor push order and thus
  which 9 (role, depth) pairs are kept when more than 9 exist (`.slice(0,
  9)`, `:83`) — **this is a real truncation hazard**: if more than 9 valid
  descriptors exist, the kept set depends on role-array order first, then
  depth-array order within each role (`intrinsicCapacityPrefixDepths`
  returns `[quarter, half, three-quarter]` in that fixed order, `:35-39`,
  deduplicated via `[...new Set(depths)]` which for a `Set` of numbers
  preserves first-insertion order — i.e. ascending numeric order here since
  the three values are computed in ascending-producing order for `pieceCount
  >= 4`... but note `Set` dedup happens **before** any sort, so if two of the
  three quotient values collide (e.g. very small piece counts), the
  surviving depths keep the order of first occurrence among
  `[quarter, half, three-quarter]`, which is already ascending by
  construction here).
- `preparedIds` (== `input.preparedPieces.map(intrinsicCapacityPreparedPieceId)`,
  `:367`) fixes the depth-synchronized processing order for the entire
  search; this order is the immutable "prepared order" from upstream sorting
  (`sortPiecesForNesting.ts`, outside this cluster) and this cluster **never
  reorders it**.

---

## 6. Comparators and tie rules: exact chains, signs, tie-breakers

All comparators below return `< 0` meaning "first sorts before second"
(ascending unless noted). All are pure functions with no side effects.

### `compareScoredCandidateReferences` (`:1731-1743`)

```
maximumSideGrid (asc, plain Number subtraction)
  || envelopeAreaGrid2 (asc, exact BigInt compare via compareBigintsAscending)
  || envelopeSpanGrid (asc, Number subtraction)
  || transformOrdinal (asc, Number subtraction — stable index into the
      already-sorted transform list)
  || gridX (asc, Number subtraction)
  || gridY (asc, Number subtraction)
```
No final tiebreaker beyond `gridY` — if two candidates from the **same**
transform land at the exact same integer grid point (impossible for a single
transform's own candidate set, since each has a unique `(gridX, gridY)`) this
would tie completely and fall back to sort stability. Ties across
**different** transforms with identical grid point and all prior fields equal
are theoretically possible and rely on stable-sort insertion order
(transform-sorted-order, then within-transform candidate-generation order).

### `compareContactCandidateReferences` (`:1745-1754`)

```
sharedBoundaryLengthMm (DESCENDING: second - first, larger contact first;
    `?? 0` if absent)
  || compareScoredCandidateReferences(first, second)
```

### `compareCapacityBeamEntries` — the plain `'objective'` retention comparator (`:1767-1788`)

```
placementOrder.length (DESCENDING: secondCount - firstCount, more placed wins)
  || placedDoubledMaterialAreaGrid2 (DESCENDING, exact BigInt compare
      via explicit `>`/ternary, not compareBigintsAscending)
  || cavities.count (asc, Number subtraction, fewer cavities wins)
  || cavities.totalDoubledAreaGrid2 (asc, exact BigInt compare via
      compareBigintsAscending, parsed with `BigInt(string)`)
  || max(gridSpan.widthGrid, gridSpan.heightGrid) (asc, Number subtraction —
      "intrinsic maximum side")
  || compareIntrinsicCapacityEnvelopeAreas(gridSpan, gridSpan)
      (asc, exact BigInt product compare: width*height)
  || gridSpan.widthGrid + gridSpan.heightGrid (asc, Number subtraction —
      "intrinsic span")
  || compareStrings(anchoredOccupiedKey, anchoredOccupiedKey)
      (asc, plain `<`/`>` on JS strings — see §12 for UTF-16 hazard)
```
This chain **never looks at which pieces are placed**, only geometry-derived
metrics plus the final geometry-identity string tiebreaker. Two beam entries
with the same placed-piece **count**, material sum, cavities, and geometry
*shape* but genuinely different placed-piece **identity sets** (e.g.
interchangeable/duplicate-shaped pieces) can therefore tie completely on this
comparator (`anchoredOccupiedKey` depends only on geometry, not piece IDs) —
resolved by stable-sort insertion order (§5). Such states are **not**
deduplicated against each other by `intrinsicCapacitySuccessorIdentity`,
because that identity includes the sorted placed-ID set (`:1666-1668`), so
both survive as distinct successors into this comparator.

### `compareCapacityBeamEntriesAreaFirst` (`:1790-1814`)

Same as above but swaps the order of the "max side" and "envelope area"
terms (envelope area compared before max side); used only by
`'area-first-shadow'`.

### `compareCapacityBeamEntryAccounting` (`:2209-2226`)

The **prefix** of `compareCapacityBeamEntries` (count, material, cavity
count, cavity area) with **no geometry/identity suffix** — used as the
accounting-equality gate before any topology tiebreak in the cohesion-frontier
path (`retainCapacityCohesionFrontier`'s inner `compareTopology`, `:1899`;
also the module-level `compareTopologyMetric`, `:2139`; also the topology
trace's "best accounting stratum" filter, `:2029-2031`).

### `retainCapacityCohesionFrontier` — the **production-default** retention algorithm (`:1881-1964`)

Not a single sort; a 5-step bucketed reservation with `retainedKeys`
dedup-by-`intrinsicCapacitySuccessorIdentity` across steps:

1. `objectiveBucketWidth` entries by plain `compareCapacityBeamEntries`.
2. `topologyBucketWidth` entries by
   `compareCapacityBeamEntryAccounting || (isolatedPieceCount asc)
    || compareCapacityBeamEntries` (`compareTopology(..., 'isolated')`).
3. `topologyBucketWidth` entries by
   `compareCapacityBeamEntryAccounting ||
    (largestPositiveContactComponentSize DESCENDING) || compareCapacityBeamEntries`.
4. up to `beamWidth` entries by
   `compareCapacityBeamEntryAccounting ||
    (positiveContactComponentCount asc) ||
    compareCapacityBeamEntryAccounting ||
    compareExactHullWaste(...) ||
    compareCapacityBeamEntries`
   — the compound comparator `compareTopology(...,'component-count') ||
   compareTopology(...,'hull-waste')` (`:1955-1959`) re-runs the accounting
   prefix **twice** (once inside each `compareTopology` call) before falling
   to hull-waste, which is itself only reached when the accounting prefix
   ties both times (harmless but redundant — not a bug to "fix" per the
   absolute-preservation rule, just a fact to reproduce exactly if bit-exact
   comparator call counts ever matter, e.g. under `captureTopologyRetention`
   perf counters).
5. up to `beamWidth` entries by plain `compareCapacityBeamEntries` (fills any
   remainder).

For the default (non-quality) `'cohesion-frontier'`/`'cohesion-frontier-shadow'`
modes, `objectiveBucketWidth = topologyBucketWidth = max(1, floor(16/4)) = 4`
(`:1937-1941`, no `allocation` argument passed). For `'quality-frontier'`,
`objectiveBucketWidth = max(1, 16-4) = 12`, `topologyBucketWidth = 1`
(`intrinsicCapacitySearch.ts:1849-1853`).

`compareExactHullWaste` (`:2163-2183`): if either side's
`exactHullDoubledAreaGrid2 === '0'` (degenerate/absent hull), compares
`exactHullGapDoubledAreaGrid2` directly (ascending BigInt); otherwise compares
the **cross-multiplied ratio** `gapA * hullB` vs `gapB * hullA` (avoids BigInt
division) — exact, no floating point.

### `compareIntrinsicCapacityEndpoints` / `compareIntrinsicCapacityObjectives` (`intrinsicCapacityEndpoint.ts:289-347`, dependency, not in this cluster but the terminal ranking this cluster relies on and calls directly at `:969`, `:1047`)

```
placedCount (DESC)
  || placedDoubledMaterialAreaGrid2 (DESC, BigInt)
  || enclosedCavityCount (ASC)
  || totalEnclosedCavityDoubledAreaGrid2 (ASC, BigInt)
  || envelopeMaximumSideGrid (ASC)
  || envelopeAreaGrid2 (ASC, BigInt)
  || envelopeSpanGrid (ASC)
  || canonicalGeometryHash.localeCompare(...)  <-- LOCALE-SENSITIVE, see §12
  || intrinsicCapacityOriginRank(origin) (ASC: cold-search=0, else=1)
  || prefixDepth ?? -1 (ASC)
  || (sourceRole ?? '').localeCompare(...)     <-- LOCALE-SENSITIVE, see §12
```
Note this is the **only** comparator this cluster calls that uses
`localeCompare` instead of the plain `<`/`>` `compareStrings` used everywhere
else inside `intrinsicCapacitySearch.ts` (`:2233-2237`). This inconsistency
is itself the specification and must be reproduced exactly (see §12).

---

## 7. Numeric semantics

### `toGridMm` (`clipper2OffsetPolicy.ts:44-53`, dependency, called throughout this cluster)

```ts
const scaledAbsoluteValue = Math.abs(valueMm) * 1000 // scale = 1000, i.e. 0.001mm grid
const roundedAbsoluteValue = Math.floor(scaledAbsoluteValue + 0.5) // round-half-up on magnitude
const gridValue = Math.sign(valueMm) * roundedAbsoluteValue
return Number.isSafeInteger(gridValue) ? gridValue : undefined
```
- Round-half-away-from-zero on the **magnitude**, sign reapplied afterward
  (not simple `Math.round`, which rounds half-towards-`+Infinity`; the two
  differ for negative half-integers, e.g. `-2.5` → `Math.round` gives `-2`,
  this function gives `-3`).
- **Signed-zero hazard**: for `valueMm = -0`, `Math.sign(-0) === -0`, and
  `-0 * 0 === -0` — so `toGridMm(-0)` returns `-0`, not `0`.
  `Number.isSafeInteger(-0)` is `true` (since `-0 === 0`), so this is not
  rejected. Any downstream consumer that stringifies this value directly
  (e.g. `capacityCandidateReferenceIdentity`, `:1756-1760`, via template
  literal) gets `"0"` (JS `String(-0) === '0'`), so the string-key hazard is
  masked there, but a Rust port using `f64` semantics or that special-cases
  `-0.0` differently in formatting must confirm it collapses `-0` to `"0"`
  identically.
- Non-finite (`NaN`/`±Infinity`) input returns `undefined` immediately
  (`:45`); overflow of the safe-integer range after scaling also returns
  `undefined`.
- Scale factor `1000` (`CLIPPER2_OFFSET_POLICY.scale`,
  `clipper2OffsetPolicy.ts:11`) — canonical grid is 0.001 mm.

### BigInt usage in this cluster

- `envelopeAreaGrid2: BigInt(widthGrid) * BigInt(heightGrid)`
  (`evaluateCandidate`, `:1721`) — exact product of two `Number.isSafeInteger`-bounded
  grid integers (each `< 2^53` in magnitude); the product can exceed `2^53`
  (up to roughly `2^106`) and **must** use an arbitrary-precision or `i128`+
  type in Rust, not `i64`, to avoid silent truncation. JS `BigInt` has no
  overflow ceiling.
- `placedDoubledMaterialAreaGrid2: bigint` — accumulated by plain `+`
  (`:727-728`, `:1136`, `:1453-1456`), always non-negative in valid data.
- `compareBigintsAscending` (`:2228-2231`) / the inline descending compare in
  `compareCapacityBeamEntries` (`:1771-1773`) — exact `<`/`>`/`===` on
  `bigint`, no precision loss possible; a Rust port using `i128` (bounded, if
  provably within range) or an arbitrary-precision type must replicate exact
  equality/ordering.
- `cavities.totalDoubledAreaGrid2: string` — bigint values are carried as
  **decimal strings** in several structures (`IntrinsicCapacityCavityMetrics`,
  checkpoint fields) and re-parsed with `BigInt(string)` at comparison time
  (`:1777-1778`, `:2222-2223`) rather than staying `bigint` end-to-end — this
  round-trip (bigint → `.toString()` upstream in `canonicalLayoutGeometry.ts`
  → `BigInt(...)` here) must be preserved exactly if a Rust `i128`/`BigInt`
  equivalent is serialized as a decimal string anywhere in the boundary
  layer, per migration-prompt §9's "BigInt values encoded as quoted base-10
  strings" rule.

### `Math.*` calls in this cluster

- `Math.max(0, performance.now() - X)` — used pervasively for elapsed-time
  clamping (`:916`, `:974`, and throughout phase timing); **not**
  semantically authoritative (timing only), per migration-prompt §11's
  guidance on `activeRuntimeMs`-style fields.
- `Math.max(minimumPlacementEvaluationCap, pieceCount * quotaPerDepth)`
  (`:352-355`) — exact integer arithmetic (both operands are safe integers in
  practice; `pieceCount * 4096` cannot overflow `Number.MAX_SAFE_INTEGER` for
  any realistic piece count).
- `Math.min(x, y)`, `Math.max(x, y)` for grid-span combination in
  `evaluateCandidate` (`:1695-1698`) — plain `Number` min/max on
  already-finite float millimeter bounds, **before** grid conversion (the
  grid conversion `toGridMm` happens after, at `:1699-1702`).
- `Math.floor(pieceCount / 4)` etc. (`intrinsicCapacityPrefixes.ts:36-38`) —
  plain integer-quotient truncation toward zero for non-negative inputs
  (`pieceCount` is always `>= 0`).
- `Math.max(1, beamWidth - 4)`, `Math.max(1, Math.floor(beamWidth / 4))`
  (`intrinsicCapacitySearch.ts:1850`, `:1939`) — bucket-width floor with a
  minimum of 1.

### Rounding/truncation and safe-integer checks

Every grid coordinate that participates in comparators or keys passes through
`toGridMm`'s `Number.isSafeInteger` gate (`clipper2OffsetPolicy.ts:52`) or
`Number.isSafeInteger`/`isNonNegativeSafeInteger` checks in checkpoint
validation (`intrinsicCapacitySearch.ts:1644-1646`, used at `:406`, `:1315`,
`:1336`, `:1360`, `:1376`). No place in this cluster performs floating-point
arithmetic on grid-space values that could reintroduce non-integer error —
all grid arithmetic (`widthGrid = maxXGrid - minXGrid`, envelope products,
span sums) is plain `Number` integer arithmetic on values already known to be
safe integers, matching JS's exact-integer guarantee for magnitudes below
`2^53`.

### NaN/Infinity

`toGridMm` rejects non-finite inputs outright (`Number.isFinite` check,
`clipper2OffsetPolicy.ts:45`). Nothing in this cluster performs arithmetic
that could produce `NaN` from finite safe-integer inputs (no division except
BigInt cross-multiplication in `compareExactHullWaste`, which is
division-free by construction).

---

## 8. Serialization and hashing

This cluster uses **three structurally distinct canonical encodings**, each
for a different purpose. A Rust port needs byte-exact parity for each
independently.

### (a) `canonicalJson` — checkpoint integrity hash and request fingerprint (`intrinsicCapacitySearch.ts:1626-1635`)

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
- `bigint` → `JSON.stringify(value.toString())` = a quoted decimal string
  (matches migration-prompt §9's BigInt rule exactly).
- Object key order: sorted by `compareStrings` (plain `<`/`>`, **not**
  `localeCompare` — contrast with §6's endpoint comparator).
- `undefined`-valued fields are **omitted entirely** (not `null`), matching
  §9's "undefined fields omitted" rule.
- Arrays: order preserved, **not** resorted.
- Recurses through `Object.entries(value)` — for class instances (e.g.
  `IrregularPreparedPiece`, `SheetSpec`), this enumerates only **own**
  enumerable properties; fields declared with TS `declare` and never assigned
  (e.g. an omitted `pieceId`) do not appear as keys at all (see §3's
  `IrregularPlacement.pieceId` discussion — the same mechanism applies to
  every domain class this fingerprint touches). **This is an open risk for
  the Rust port**: the exact set of enumerable keys on `IrregularPreparedPiece`
  and its nested fields depends on JS class-field/constructor semantics that
  must be independently verified per class (flagged in §15).
- Consumers: `intrinsicCapacityCheckpointIntegrityHash` (`:1503-1569`, feeds
  `createHash('sha256').update(canonicalJson({...})).digest('hex')`) and
  `intrinsicCapacityRequestFingerprint` (`:1571-1610`, same SHA-256 pattern).
  Both hash a curated field subset (not the whole checkpoint/input objects
  verbatim) — the exact field lists are at `:1508-1566` (integrity hash) and
  `:1585-1607` (fingerprint); reproduce these lists exactly, in this order
  (order does not matter for `canonicalJson`'s own object handling since keys
  are re-sorted, but it **does** matter for arrays like `frontier.map(...)`
  which preserve source order).
- `intrinsicCapacityIncumbentBinding` (`:1612-1624`) projects an
  `IntrinsicCapacityEndpoint` down to 5 fields before hashing — this
  projection, not the full endpoint, is what participates in fingerprint/
  integrity comparisons.

### (b) Length-prefixed token canonical keys — `anchoredOccupiedKey` / `canonicalOccupiedGeometryKey` (dependency: `irregularBeamState.ts:744-888`, not in this cluster but produced/compared by it throughout)

`canonicalToken(v) = "${v.length}:${v}"`, records are `canonicalToken(name) +
canonicalToken(value)` concatenated with no separators between fields
(`irregularBeamState.ts:829-838`), rings are canonicalized independently of
start-vertex and winding (`canonicalRingKey`, `:765-818`), numbers are
rendered via `String(value)` after signed-zero/NaN/Infinity normalization
(`canonicalNumber`, `:844-850`). This cluster **consumes** these keys as
opaque strings (`compareStrings` ordering only, `:1786`) and **compares
equality on the identity string** for dedup
(`intrinsicCapacitySuccessorIdentity`, `:1664-1669`) but never re-derives or
re-parses them — a Rust port only needs byte-exact production of these keys
from the `irregularBeamState` cluster, and byte-exact equality/`<`/`>`
comparison here.

### (c) `intrinsicCapacitySuccessorIdentity` (`:1664-1669`)

```ts
`${anchoredOccupiedKey}|placed=${JSON.stringify([...placementOrder].toSorted(compareStrings))}`
```
Plain `JSON.stringify` of a sorted string array (standard JSON array-of-quoted-strings
syntax, comma-separated, no whitespace) concatenated after a literal `|placed=`
separator following the opaque geometry key. Used for **both** in-loop
successor dedup (`pushSuccessor`, `:1648-1662`) and as the dedup/lookup key
throughout `retainCapacityBeamEntries`/`retainCapacityCohesionFrontier`'s
`retainedKeys` sets and `makeCapacityTopologyMeasurements`'s memo map.

### (d) `capacityCandidateReferenceIdentity` (`:1756-1760`)

```ts
`${transform.index}:${gridX}:${gridY}`
```
Plain template-literal `Number`-to-string coercion of three already-verified
safe integers (transform index, grid X, grid Y) — no `JSON.stringify`
involved. Used only for the compactness/contact-role "already built" check
within one beam-entry's successor construction (`:696`, `:767-769`).

### What is **not** re-hashed by this cluster

`canonicalGeometryHash`/`canonicalGeometryIdentity` (SHA-256 of a
canonical-layout identity string) is produced entirely by
`materializeIntrinsicCapacityEndpoint` (`intrinsicCapacityEndpoint.ts:161-231`,
dependency, not this cluster) — this cluster only **compares** and **stores**
that hash (as the `Map` dedup key at `:938`/`:1019`/`intrinsicCapacityPrefixes.ts:127`),
never recomputes it.

---

## 9. Caches touched and the exact historical access sequence

### `IntrinsicCapacityCavityCache` (`Map<string, IntrinsicCapacityCavityMetrics>`, dependency type from `intrinsicCapacityEndpoint.ts:82`)

Access sequence, exactly as implemented in `measureIntrinsicCapacityCavities`
(`intrinsicCapacityEndpoint.ts:89-109`, dependency but the sole consumer path
in this cluster):
1. If `state.placedCollisionGeometries.length === 0`, return the constant
   zero metrics **without touching the cache at all** — this cluster
   short-circuits identically at `:815-818` before ever calling the
   function, for the same reason.
2. Compute `state.bottomLeftAnchoredCanonicalOccupiedGeometryKey()`; if
   `undefined`, fail (no cache interaction).
3. `cache.get(occupiedKey)` — on hit, return immediately (no recomputation,
   no re-validation of the cached value's shape).
4. On miss, `measureCanonicalEnclosedCavities(...)` (out of cluster scope);
   on `undefined`, fail without publishing anything.
5. On success, `cache.set(occupiedKey, metrics)` **then** return.

**Cache lifetime in this cluster**: every call site in this cluster passes
`cavityCache: new Map()` as a **fresh, call-local** cache
(`intrinsicCapacityMode.ts` passes `new Map()` at essentially every
`runIntrinsicCapacityColdSearch` call site — `:413`, `:523`, `:574`, `:623`,
`:687`, `:775`, `:810`, `:1027`, `:1097`, `:1204`, `:1252`, and
`intrinsicCapacityTelemetry.ts:93`) **except** the top-level
`runIntrinsicCapacityMode` entry (`intrinsicCapacityMode.ts:1162`), which
creates **one** `cavityCache` shared across the prefix terminalization
(`terminalizeIntrinsicCapacityPrefixEndpoints`) and the single
non-coordinated cold-search fallback path (`:1204`) — but **not** shared with
the coordinated lane paths, which each get their own fresh map. **This means
production capacity search (the `coordinateProtectedLanes: true` path) never
reuses cavity measurements across the cold lane, any warm-prefix lane, or the
quality-warm-prefix lane** — each lane recomputes cavities for any occupied
geometry it independently reaches, even if another lane already measured the
identical geometry. This is a real, currently-accepted duplicate-computation
cost (not a bug) that a Rust port's cache design (migration-prompt §13) must
either preserve (job-local-per-lane caches) or deliberately widen only after
proving output-identical behavior under the new sharing policy — widening
changes nothing observable here since cavity measurement is a pure function
of `occupiedKey`, but the migration prompt requires this to be proven, not
assumed.

Separately, `validateIntrinsicCapacityCheckpoint` allocates **its own**
fresh `validationCavityCache: new Map()` (`:1384`) purely for re-deriving
and cross-checking each frontier entry's recorded cavity metrics during
checkpoint validation — this cache is discarded after validation and is never
shared with the subsequent search's own `input.cavityCache`.

### `IrregularNfpIfpCandidateMemoScope` (`services.ts:194-196`, dependency)

A fresh instance is constructed once per `runIntrinsicCapacityColdSearch`
invocation (`:450`) and passed to every `generatePlacementCandidates` call
within that invocation (`:614`) — this is an **opaque identity token** whose
actual memo storage lives inside `NfpIfpService`'s implementation (out of
this cluster's scope). Because it is instantiated fresh per call to
`runIntrinsicCapacityColdSearch`, **candidate memoization is not shared
across cold/warm/quality lanes or across checkpoint resumes** — each
`runIntrinsicCapacityColdSearch` invocation (including each bounded
1-depth resume step of a warm or quality lane) gets a brand-new,
empty scope. This is a strong signal about the intended cache granularity
for a Rust port: candidate-generation memoization in this cluster is
explicitly **per-search-invocation**, not per-job or per-lane-lifetime, and
this must be verified against `NfpIfpService`'s own characterization (out of
scope here) rather than assumed to be a job-wide cache.

### Underlying geometry caches (NFP/IFP/transform) touched via `geometryKernel.transformCollisionGeometry` and `nfpIfpService.generatePlacementCandidates`

Out of this cluster's file scope entirely (owned by
`src/workers/irregular/geometryCacheStore.ts` / `nfpIfpService.ts` /
`transformGenerator.ts`). This cluster's only observable interaction is: (1)
it always requests candidates through the shared `NfpIfpService`/`GeometryKernel`
Effect services (never bypasses them), and (2) it never generates
speculative work ahead of the depth-synchronized loop — no prefetching, no
pipelining across depths. **This cluster's own caches (cavity, candidate
memo, and topology memo) are exhaustively covered above; the deeper NFP/IFP
cache stack requires its own separate characterization pass.**

### `makeCapacityTopologyMeasurements` memo (`:1976-2001`)

A fresh `Map<string, CanonicalLayoutTopologyExact | undefined>` is created
**once per depth**, only when `captureTopologyRetention` is true
(`:828-829`), and is used both by `retainCapacityBeamEntries`'s topology
buckets (passed in, `:834`) and by the topology-retention trace builder
(`:838`). Its `.get`/`.has` pattern at `:1987` (`cached !== undefined ||
topologyByIdentity.has(identity)`) correctly distinguishes "cached
`undefined`" (empty-placement entries, which legitimately have no topology)
from "not yet measured" — a real memoization cache with negative caching,
scoped to exactly one depth's retention/trace work and discarded afterward.

---

## 10. Cancellation / deadline / budget / evaluation-cap observation points

### Cancellation/deadline (`IrregularNfpIfpControl`)

There is **exactly one** cooperative cancellation checkpoint call in the
entire search: `yield* input.control.checkpoint('candidate-points')`
(`:599`), positioned immediately before `geometryKernel.transformCollisionGeometry`,
i.e. **once per (beam entry × transform) pair**, only when `input.control !==
undefined`. It is **not** checked per candidate, per successor construction,
per retention step, per cavity measurement, or per endpoint materialization.
`control` is additionally threaded into `nfpIfpService.generatePlacementCandidates`
(`:615`), which may perform its own (out-of-cluster) checkpoint calls inside
candidate generation. A cancellation or deadline abort propagates as an
`IrregularNfpIfpControlAbortError` through the `Effect` error channel,
unrewrapped by this cluster (part of `CapacitySearchError`, `:311-316`) — no
catch/recovery anywhere in `intrinsicCapacitySearch.ts`.

### Per-depth evaluation quota (`:623-634`)

Checked at the **start of the innermost candidate loop**, before evaluating
each individual candidate:
```
if (consumedAtDepth >= placementEvaluationQuotaPerDepth ||
    consumedPlacementEvaluations >= placementEvaluationCap) {
  settlement = 'evaluation-cap'
  depthQuotaExhausted = true
  break
}
```
This breaks the innermost `for (const candidate of legalCandidates)` loop,
which then falls through the transform loop's own `if (depthQuotaExhausted)
break` (`:595`) and the outer beam-entry loop's `if (depthQuotaExhausted)
break` (`:585`) — a three-level cascading short-circuit. Note the candidate
that triggered the check is **never evaluated** (the check happens before
`consumedAtDepth += 1` / `evaluateCandidate(...)`, `:635-637`) — the
already-generated `legalCandidates` array for the transform in progress is
simply abandoned mid-iteration; no partial state from it is retained.

### Checkpoint pause boundary (`:876-934`)

Checked **once per completed depth**, strictly after that depth's retention
and bookkeeping are fully committed (`:876-879`):
```
maximumDepthBoundaries !== undefined
  && completedDepthBoundariesThisInvocation >= maximumDepthBoundaries
  && depth + 1 < input.preparedPieces.length
```
This is a **post-depth** boundary only — it never interrupts mid-depth (a
depth that is in progress always runs to full completion of its beam/quota
work before a pause is possible). Combined with the evaluation-cap check
above, a single depth can both exhaust its quota *and* trigger the pause
boundary; per §4, the pause return's literal `settlement: 'paused'`
(`:928`) always wins over whatever the `settlement` variable held.

### Total evaluation cap

Enforced by the same `:623-634` check (the `consumedPlacementEvaluations >=
placementEvaluationCap` half of the `||`), not a separate observation point —
there is no independent "check the total cap at depth boundaries" pass.

### No memory cap or trace cap observation point in this cluster

Nothing in `intrinsicCapacitySearch.ts`, `intrinsicCapacityPrefixes.ts`, or
`intrinsicCapacityTelemetry.ts` observes a memory budget or a trace-size cap
directly; `topologyRetentionDepths` grows unboundedly with depth count when
capturing (bounded only by piece count, which is itself bounded upstream).

---

## 11. Error paths

All errors raised **directly** by this cluster are `IntrinsicCapacityError`
(`Data.TaggedError('IntrinsicCapacityError')<{ operation: string; message:
string }>`, defined in `intrinsicCapacityPreflight.ts:19-22`, dependency but
the sole error type this cluster constructs). Every `operation` string
literal used by this cluster's own `new IntrinsicCapacityError({...})` call
sites:

| `operation` | Site | Condition |
| --- | --- | --- |
| `'coldSearchSheet'` | `:361` | requested sheet has no exact grid representation |
| `'coldSearchMaterial'` | `:371`, `:531` | suffix material accounting incomplete / a piece has no material area |
| `'warmPrefixSeed'` | `:389` | `validateWarmPrefixSeed` returned `kind: 'invalid'` |
| `'coldSearchCheckpoint'` | `:409`, `:423`, `:443`, `:884` | maximumDepthBoundaries not a positive safe integer / fingerprinting disabled on resume / checkpoint validation failed / fingerprint unavailable at a requested pause |
| `'coldSearchEmptyState'` | `:498` | the empty capacity state has no finite occupied bounds |

`CapacitySearchError` (`:311-316`) is a union of `IntrinsicCapacityError |
IrregularGeometryInputError | IrregularNestingNotImplementedError |
IrregularNfpIfpControlAbortError` — the latter three originate from the
injected `GeometryKernel`/`NfpIfpService` and are **propagated unchanged**
(never caught, wrapped, or reclassified anywhere in this cluster).

Downstream mapping (traced at `computeIrregularNesting.ts:1242-1252`,
dependency): `IntrinsicCapacityError` → `IrregularPortfolioError({ operation,
category: 'search', message })`, which the migration prompt's own error table
(§16) confirms maps externally to `irregular_scoring_error` — "preserve this
unusual current mapping exactly." This cluster's errors therefore reach the
external protocol exactly as the migration prompt already documents; no
contradiction found.

`intrinsicCapacityTelemetry.ts`'s `measureIntrinsicCapacityShadowTelemetry`
**never propagates** an error from its internal cold-search call —
`Effect.catch((error) => Effect.succeed(unavailableTelemetry(..., error.message,
...)))` (`:123-132`) converts any failure into a `status: 'unavailable'`
telemetry record with `error.message` copied verbatim into
`unavailableReason`. This is deliberate (the shadow probe must never fail the
production request) but means a Rust port's equivalent must swallow **all**
error variants here, including cancellation, without distinguishing them —
worth flagging since it is the one place in this cluster where a
cancellation-classified error is deliberately absorbed rather than
propagated (contrast with §10).

`intrinsicCapacityPrefixes.ts` raises **no errors** — both exported functions
are pure, total (return `[]`/empty-result structures on empty input) and
never throw or return an `Effect` failure channel.

---

## 12. JS-specific semantics hazards for a Rust port

1. **`localeCompare` vs plain `<`/`>` inconsistency.** This cluster's own
   `compareStrings` (`:2233-2237`) is plain UTF-16 code-unit comparison, used
   for `anchoredOccupiedKey` ordering, `canonicalJson` key sorting, and
   partition/array-equality checks throughout checkpoint validation. But the
   **terminal endpoint ranking** this cluster depends on and directly calls
   (`compareIntrinsicCapacityEndpoints`, `intrinsicCapacityEndpoint.ts:342`,
   `:345`) uses `String.prototype.localeCompare` for
   `canonicalGeometryHash`/`sourceRole` — locale-and-ICU-version-dependent
   ordering (though both are effectively ASCII hex/identifier strings in
   practice, so in the common case `localeCompare` and codepoint order
   coincide; this must be **proven**, not assumed, for the specific alphabets
   these strings can contain — hex digests and role literals are ASCII-only
   by construction here, so a Rust byte-wise comparison is very likely
   equivalent, but this equivalence should be an explicit differential test,
   not an assumption).
2. **Stable sort reliance with real, reachable ties.** §5/§6 document exact
   ties reachable when the objective comparator chain exhausts to equal
   values but the underlying placed-piece-ID sets differ (duplicate/
   interchangeable piece shapes). Rust's `sort_unstable`/`sort_unstable_by`
   must **not** be used for any of the comparator call sites in §5's table;
   `Vec::sort_by`/`sort_by_key` (stable) is required, and insertion order
   into the vector being sorted must exactly match the JS insertion order
   traced in §5.
3. **`Object.entries`/own-enumerable-property semantics driving `canonicalJson`.**
   §8(a) — the request-fingerprint hash walks whole domain-class instances
   (`IrregularPreparedPiece`, `SheetSpec`) via `Object.entries`, whose result
   set depends on JS class-field declaration mechanics (`declare` fields that
   were never assigned do not appear). A Rust struct's `Serialize`
   implementation must reproduce the *same conditional key presence*, not a
   fixed schema — this needs its own verification pass per domain class (see
   §15, open question).
4. **Signed zero.** `toGridMm(-0) === -0` (§7); masked in this cluster's own
   string interpolation (`String(-0) === '0'`) but must be re-verified for
   any Rust formatting path that treats `-0.0_f64` differently from `0.0_f64`
   in `to_string()`/`format!`.
5. **`JSON.stringify` for the successor-identity placed-ID array**
   (`intrinsicCapacitySuccessorIdentity`, `:1667-1668`) — standard JSON array
   syntax for an array of already-validated plain ASCII piece-ID strings; no
   escaping edge cases expected given piece IDs are internally generated, but
   a Rust port must reproduce JSON string-escaping rules exactly if piece IDs
   can ever contain characters requiring escaping (unverified in this
   cluster; piece-ID format is defined elsewhere).
6. **`Set` used only for dedup, never as an ordering source, in this
   cluster** — confirmed safe to port to any Rust hash-set type (§5); the one
   place a `Set` *could* look like an ordering source
   (`[...new Set(depths)]` in `intrinsicCapacityPrefixDepths`, `:40`) relies
   on `Set`'s JS-specified insertion-order iteration, which **is** observable
   here (determines truncation order downstream) — a Rust port must use an
   explicit ordered/dedup-preserving-first-occurrence structure (e.g. an
   `IndexSet` or manual `Vec` + `HashSet` membership check), not a plain
   `HashSet`.
7. **`Array.prototype.toSorted` (ES2023, non-mutating) vs `Array.prototype.sort`
   (mutating)** are both used in this cluster (`:689` uses `.sort`, most
   other sites use `.toSorted`) — both are stable; the choice between them
   has no semantic effect here (the mutated array is never read in its
   pre-sort form afterward at `:689`), but is noted for completeness since
   the migration prompt calls out "stable sort reliance" broadly.
8. **`Number.isSafeInteger`/`Number.isFinite` gates** throughout checkpoint
   validation (§7) are JS-`Number`-specific (`2^53` boundary); a Rust port
   using `i64`/`i32` for grid coordinates has a *wider* safe range and must
   explicitly re-impose the JS `2^53` ceiling wherever this cluster checks
   it, rather than relying on the wider Rust integer type's own overflow
   behavior to coincidentally match.

---

## 13. Parallelism assessment

### Safe Rayon candidates (pure, independent, indexable)

- **Per-transform candidate generation and scoring within one beam entry**
  (`:590-686`): for a fixed beam entry and fixed piece, each transform's
  `geometryKernel.transformCollisionGeometry` +
  `nfpIfpService.generatePlacementCandidates` + per-candidate `evaluateCandidate`
  work is a pure function of `(entry, piece, transform)` — **conditional on**
  preserving the per-depth/global evaluation-quota short-circuit (§10)
  exactly, which currently depends on **sequential** consumption order across
  transforms and candidates (`consumedAtDepth`/`consumedPlacementEvaluations`
  are checked and incremented per-candidate, in transform-sorted,
  candidate-generation order). A parallel version would need to either (a)
  pre-reserve a stable evaluation budget per transform deterministically
  before dispatch (matching the exact sequential consumption count each
  transform would have used) or (b) run the full unbounded candidate
  evaluation in parallel and re-impose the cap via a deterministic serial
  reduction pass afterward — either approach must reproduce the exact same
  `evaluated`/`invalidCandidates`/`fitRejectedCandidates` counts and exact
  same **set** of evaluated candidates as the current sequential early-exit,
  which is a nontrivial re-derivation, not a free parallelization.
- **`compareTopology`'s `topologyMeasurements.measure(entry)` calls for
  distinct beam entries** (`makeCapacityTopologyMeasurements`, `:1976-2001`):
  once the `measuredSurvivors` set for a depth is fixed, computing
  `measureCanonicalLayoutTopologyExact` for each distinct entry is
  embarrassingly parallel (pure function of one entry's placed geometries,
  memoized by identity) — a safe Rayon candidate **after** replacing the
  `Map`-based memo with a pre-sized, stable-index-keyed parallel-safe cache,
  since `retainCapacityCohesionFrontier` calls `topologyMeasurements.measure`
  from within five separate serial sort comparators that must all observe
  the same memoized values; parallelizing the *population* of the memo ahead
  of the five sorts (over the fixed `measuredSurvivors` vector, by stable
  index) is safe, but the five sorts themselves must remain serial/ordered
  reductions per §14.3 of the migration prompt.
- **Independent evaluation of `evaluateCandidate` for already-generated
  candidates within one transform's `legalCandidates` array**, once the
  quota-slice for that transform is deterministically fixed — pure,
  stateless, indexable by candidate ordinal.

### Chronology-bound, must stay logically serial

- **The outer depth loop itself** (`:522-935`) — each depth's beam is a
  function of the *previous* depth's retained beam; no parallelism across
  depths is possible without violating the depth-synchronized invariant the
  file's own doc comment asserts ("states from different piece depths never
  compete", `:325-326`).
- **The per-depth evaluation-quota consumption order** (§10, §13 above) — the
  exact sequential order in which candidates are evaluated determines which
  candidates get evaluated at all once the cap is hit mid-depth; this is not
  "just" a chronology-preservation nicety, it changes the **set** of
  candidates considered, hence the **set** of successors, hence the
  algorithm's output. This must remain effectively serial (or be
  deterministically pre-computed to reproduce the identical candidate subset)
  before any parallelism touches it.
- **The skip-successor-then-placement-successor ordering within a depth**
  (§4/§5) — insertion order into `successors` feeds the stable-sort tie
  resolution in retention; must remain deterministic and ordinal-indexed if
  parallelized, per migration-prompt §14.3's "assign every input a stable
  ordinal" pattern.
- **The lane coordinator's cold/warm/quality lane sequencing**
  (`intrinsicCapacityMode.ts`, out of this cluster but directly gates when
  this cluster's functions run) — explicitly listed in the migration
  prompt §14.2 as a high-risk boundary ("cold versus warm lane races",
  "direct producer roles whose chronology affects scheduler traces"); this
  cluster's functions are called strictly sequentially by that coordinator
  today (cold lane fully resolved before warm lanes start, warm lanes
  iterated in fixed array order, quality lane last) and that sequencing must
  not become a race.
- **`consumedPlacementEvaluations`/`consumedAtDepth`/counters** — all shared
  mutable accounting state across the depth loop; any parallel work inside a
  depth must fold its contribution back through a deterministic serial
  reduction (per migration-prompt §14.3 step 6), never mutate these counters
  concurrently.
- **Cancellation checkpoint (§10)** — the single `control.checkpoint(...)`
  call site's position (once per beam-entry×transform pair, before geometry
  transform work) is itself a chronology fact; moving it earlier/later or
  making it advisory-only under parallelism would change which work happens
  before an abort, which the migration prompt explicitly forbids (§15)
  unless proven behaviorally invisible.

---

## 14. Tests and gates covering this cluster

### Direct unit tests (grepped for exact symbol imports from this cluster; only one file imports these symbols directly)

`tests/unit/intrinsicCapacityMode.test.ts` (1368 lines) imports
`runIntrinsicCapacityColdSearch`, `INTRINSIC_CAPACITY_V1_BOUNDS`,
`compareIntrinsicCapacityEnvelopeAreas` from `intrinsicCapacitySearch.ts`,
and (per the `describe('intrinsic capacity prefixes', ...)` block, `:796-1132`)
also exercises `intrinsicCapacityPrefixes.ts` through
`captureIntrinsicCapacityPrefixDescriptors`/`terminalizeIntrinsicCapacityPrefixEndpoints`
via `intrinsicCapacityMode.ts`'s `runIntrinsicCapacityMode`. Relevant
`describe`/`it` blocks (exact titles):
- `describe('intrinsic capacity search', ...)` (`:327-795`): envelope-area
  ordering near the coordinate limit (`:328`), exact best-subset partition
  with a single fitting piece (`:337`), skip-successor preference for
  several smaller pieces over one larger piece (`:361`), material-area
  tiebreak (`:377`), **"does not deduplicate equal collision geometry with
  different material accounting"** (`:389` — directly validates the §6/§9
  successor-identity analysis in this document), equal-attainable-count/
  material search plus incumbent-beating (`:404`), rigid q90 selection
  (`:449`), cancellation failure (`:464`), deadline-censoring failure
  (`:494`), deterministic replay with identical descriptors/pruning/endpoint/
  trace (`:519`), depth-boundary resume with uninterrupted-trace equivalence
  (`:549`), and **"rejects corrupted checkpoint accounting and a changed
  pruning incumbent"** (`:634` — exercises counters corruption, per-depth
  quota-ledger corruption, frontier-cavity corruption, three distinct
  private-state corruptions (`canonicalEntryKeys`,
  `nearCompleteStructuralContactSignatureCounts`, `placedCollisionIndex`) via
  direct property overwrite, and incumbent-changed fingerprint mismatch — a
  precise map of §9's validation-order claims).
- `describe('intrinsic capacity prefixes', ...)` (`:796-1132`): captures at
  most nine skip-free original-order prefixes (`:797`), rejects lineages
  that skipped a piece before the capture depth (`:830`), terminalizes
  fitting prefixes into incumbents without placement evaluations (`:856`),
  resumes an exact warm prefix with the uninterrupted trace/endpoint
  (`:895`), matches cold-only output exactly when no descriptor is captured
  (`:1071`), never ranks prefix-enabled output below cold-only output
  (`:1100`).
- `describe('capacity prefix capture isolation', ...)` (`:1266-1367`): does
  not change direct construction/evaluations/endpoint hashes (`:1267`),
  keeps the complete portfolio identical through canonical-grid checkpoints
  (`:1301`).
- `describe('intrinsic capacity quality admission', ...)` (`:70-245`) and
  `describe('intrinsic capacity preflight', ...)` (`:246-326`) exercise
  adjacent modules (`intrinsicCapacityMode.ts` admission logic,
  `intrinsicCapacityPreflight.ts`) that call into this cluster indirectly.

`intrinsicCapacityTelemetry.ts`'s `measureIntrinsicCapacityShadowTelemetry`
has **no direct unit test file** matched by symbol-name grep across
`tests/`; it is exercised indirectly through
`tests/unit/intrinsicCapacityIntegration.test.ts`'s
`'captures pressure and a bounded no-skip probe without changing routing or
output'` test (`:236-270`), which drives it through the full
`computeIrregularNesting` worker path with
`captureCapacityShadowTelemetry: true`.

### Integration tests

`tests/unit/intrinsicCapacityIntegration.test.ts` (678 lines) — exercises
this cluster only through `computeIrregularNesting`/`intrinsicCapacityMode.ts`
(imports `intrinsicCapacityLaneCoordinatorTraceValid` from
`intrinsicCapacityMode.ts:19`, not from this cluster directly). Key `it()`
titles: `'runs the Short Side profile through the existing worker result and
history path'` (`:112`), `'runs focused complete reconstruction by default
and preserves the protected duplicate fallback'` (`:165`), `'captures
pressure and a bounded no-skip probe without changing routing or output'`
(`:236`), `'bypasses complete construction for an area-proven impossible
sheet and reports the honest partial result'` (`:271` — exercises this
cluster's `routing: 'preflight-proven-impossible'` path), `'enters capacity
mode honestly after an inconclusive preflight and bounded complete archive
miss'` (`:367` — exercises the `'bounded-complete-archive-miss'` /
`coordinateProtectedLanes: true` path), `'keeps the complete path unchanged
when the archive fits, with capacity trace vocabulary only in diagnostics'`
(`:618`).

### Production gate scripts (grepped `scripts/` for direct imports; documented cross-reference in `docs/operations/irregular-production-gates.md`)

`scripts/irregular-capacity-gate.ts` (1281 lines, `pnpm gate:capacity` /
`pnpm gate:capacity:production`) imports only
`intrinsicCapacityLaneCoordinatorTraceValid`/`IntrinsicCapacityTrace` from
`intrinsicCapacityMode.ts` (`:37-40`), driving this cluster end-to-end through
the full worker/coordinator path rather than calling
`runIntrinsicCapacityColdSearch` directly. Per
`docs/operations/irregular-production-gates.md:74-100`: runs constrained
capacity fixtures through the full production coordinator in paired
production and cold-only arms; pins Triangle-20 `300 x 300` at 17 pieces,
Mixed-61 `700 x 500` at 50, Mixed-61 `700 x 560` at 59, including canonical
output hashes and "the causal capacity-quality producer, prefix depth, and
endpoint identity" — i.e. it specifically asserts on facts this cluster
produces (which lane won, at what prefix depth). `pnpm gate:capacity:production
--quiet` runs in PR CI.

`pnpm gate:mixed61-compact` / `pnpm gate:compact-nine-baselines` also
exercise this cluster on the constrained-sheet fixtures (`600 x 400`,
`300 x 300`) per `docs/operations/irregular-production-gates.md:9-19`,
`:42-49` — the roomy-sheet fixtures do not reach this cluster (complete
archive always fits there).

### Focused correctness gate command (documented, `docs/operations/irregular-production-gates.md:31-44`)

```
tests/unit/intrinsicSharedArchiveAdmission.test.ts
tests/unit/intrinsicSharedArchivePortfolio.test.ts
tests/unit/intrinsicCapacityMode.test.ts
tests/unit/intrinsicCapacityIntegration.test.ts
tests/unit/intrinsicReconstructionPortfolio.test.ts
tests/unit/irregularTriangleCompactGolden.test.ts
tests/unit/irregularSeventeenShapesCompactGolden.test.ts
```
plus `pnpm gate:mixed61-compact` and `pnpm gate:compact-nine-baselines`.

---

## 15. Open questions and ambiguities

1. **[Prominent — verify before Rust implementation] Production retention
   mode is `'cohesion-frontier'`, not a plain top-K objective sort, and adds
   a 4th "contact" successor per depth transition beyond the stated fanout
   of 3.** The migration prompt's §11 summary ("beam width 16, fanout 3...")
   reads as if retention is simply "keep the top 16 by the objective
   comparator." Source shows the **default production** `retentionMode`
   (`computeIrregularNesting.ts:533-538`, applied to the cold lane, every
   warm-prefix lane, and — with a hardcoded override — the quality-warm-prefix
   lane) is `'cohesion-frontier'`, which (a) triggers `captureTopologyRetention
   = true` (`intrinsicCapacitySearch.ts:339-342`), causing a 4th "contact-role"
   successor to be constructed at every (beam entry × piece) depth transition
   whenever a positive-contact candidate exists and was not already selected
   by the top-3 compactness pass (`:762-783`), and (b) replaces the naive
   top-16 objective sort with `retainCapacityCohesionFrontier`'s 5-step
   topology-bucketed reservation (`:1881-1964`), which depends on
   `measureCanonicalLayoutTopologyExact` (`canonicalLayoutGeometry.ts`, out of
   this cluster's scope). **This is not a contradiction of the prompt's
   *numeric bounds* (`16`/`3`/`4096`/`50000` are all confirmed exact) but is a
   contradiction of the prompt's implied *retention algorithm*.** The
   orchestrator must either (a) treat `measureCanonicalLayoutTopologyExact`
   and `retainCapacityCohesionFrontier` as in-scope for the capacity-search
   Rust port (they are load-bearing for every production capacity result,
   not a shadow-only mode), or (b) explicitly re-scope and document that a
   separate characterization pass for `canonicalLayoutGeometry.ts` is
   required before Stage 2 parity can be claimed for capacity search.
2. **`Object.entries`-based `canonicalJson` traversal of full domain-class
   instances** (§8(a), §12.3) for the request fingerprint hashes whichever
   own-enumerable keys `IrregularPreparedPiece`/`SheetSpec`/nested types
   happen to expose, which depends on JS class-field/constructor mechanics
   (`declare` fields, conditional `hasOwnProperty`-gated assignment as seen
   in `IrregularPlacement`, §3). A full enumeration of which fields on which
   classes are conditionally-present needs its own pass across
   `src/shared/irregular/domain.ts` before the Rust request-fingerprint
   encoder can be considered exact.
3. **`auxiliaryPlacementEvaluations` is a compile-time constant `0`** in
   every trace this cluster produces (`:1073`), despite being a named,
   documented field ("Prefix terminalization must never consume placement
   evaluations", `:180-181`) with its own semantic meaning. Is this field
   ever set to a nonzero value by a different producer role sharing the same
   `IntrinsicCapacitySearchTrace` type, or is it permanently vestigial for
   this cluster? Needs source confirmation outside this cluster (likely
   `intrinsicCapacityMode.ts` or another anytime producer) before a Rust
   port can safely hardcode it to zero.
4. **Cavity-cache and candidate-memo-scope non-sharing across lanes** (§9) is
   documented here as observed fact, but whether this is an intentional
   design choice or an accidental performance gap is not stated anywhere in
   this cluster's comments. The migration prompt's cache-architecture
   principles (§13) require this exact non-sharing to be preserved for
   Stage 2 (byte-identical single-thread parity) and only *considered* for
   widening in a later, separately-justified stage — flagging so the
   orchestrator does not "fix" this as an obvious inefficiency during the
   port.
5. **True comparator ties across differently-identified, geometrically
   identical successors** (§6, §12.2) are structurally possible but this
   document did not find or construct a concrete production fixture that
   exercises this exact tie (the closest test,
   `'does not deduplicate equal collision geometry with different material
   accounting'`, `intrinsicCapacityMode.test.ts:389`, uses *different*
   material accounting, which breaks the tie before reaching the
   geometry-identity suffix). The orchestrator should confirm whether any
   existing fixture actually reaches a full comparator tie, or whether a new
   targeted differential/property test is needed to pin the exact
   stable-sort tie-break behavior before Rust promotion.
6. **`retainCapacityBeamEntries`'s un-labelled `else` branch** (`:1857-1879`)
   is reachable only for `retentionMode === 'axis-buckets-shadow'`, itself
   reachable only via the non-default `options?.intrinsicCapacityRetentionShadow
   === 'axis-buckets'` benchmarking override. Confirm this is genuinely
   never exercised by any default production request path (this document's
   trace supports that conclusion but did not find an explicit test
   asserting the option is never enabled in production) before deciding
   whether the Rust port must implement it as a fully load-bearing production
   path or as an optional benchmarking-parity feature.
7. **Piece-ID string content and JSON-escaping** (§12.5): this cluster
   assumes piece IDs never require JSON escaping when embedded via
   `JSON.stringify` in `intrinsicCapacitySuccessorIdentity`; the actual
   `PieceId` format/generation is defined outside this cluster and was not
   verified here.

