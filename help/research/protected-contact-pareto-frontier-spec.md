# Candidate spec: protected Pareto frontier lane (hypothesis 1)

Branch: `protected-contact-pareto-frontier`, base `89e34dc438f50c3aebbea73b0f7af8d72e32a03b`.
Worktree: `/Users/andreasimonecosta/Documents/Work/min-plane-dfx-worktrees/protected-contact-pareto-frontier`.

## Causal evidence (why this mechanism)

First four-sheet divergence on current main (full diagnosis:
`/private/tmp/min-plane-provenance/protected-contact-pareto-frontier/analysis/first-divergence-diagnosis.md`):

- Beam step 0, zero-contact tier. Pieces `28f5a1d1-...-copy-1..3` (164 x 114 padded)
  and `c5135087-...-copy-1` (150 x 110 padded).
- rot-0 and rot-90 candidates have IDENTICAL intrinsic compactness
  (maxSide 164.504, area 18,836.366016, span 279.008) and identical contact (0).
- Production local rank is decided only by `worstNormalizedSheetConsumption` then
  `normalizedSheetSpanSum`: rot 0 wins fanout on 2000 x 1700, rot 90 wins on the
  other three sheets; the losing family falls to rank 17, outside fanout 4, and
  never becomes a successor anywhere in the tree.
- The intrinsic contact lane cannot seed (it requires a POSITIVE duplicated
  contact tier; step 0 is zero-contact). A single intrinsic-order winner would
  also collapse the tie to rot 0 (transform index), which is already in
  production fanout on 2000 x 1700, so it adds nothing there. Only a bounded
  NON-DOMINATED set keeps both tied orientation families.

## Mechanism (one committed change)

Add a fourth retention source: a protected Pareto frontier lane, next to the
existing production beam, width-one incumbent, boundary-anchor lane (width 8),
and intrinsic contact lane (width 1). It never consumes production slots, never
replaces or reorders production fanout, and is sheet-independent in every
branch-removing decision.

### A. Local Pareto seed (behind production fanout)

In `selectLocalCandidates` (windowedBeam.ts:1130-1339), after the existing
intrinsic-contact seed:

- New `selectProtectedParetoFrontierCandidates(state, selected, rankedCandidates)`:
  - Group `selected` and `rankedCandidates` by exact
    `score.sharedCollisionBoundaryLengthMm` (reuse `groupLocalCandidatesByContactLength`).
  - Eligible tiers: `contactLength >= 0` (ZERO TIER INCLUDED: required by the
    step-0 evidence) whose production `selected` set already contains >= 2
    members of that tier. Tiers visited in descending contact length.
  - Within a tier, a candidate is non-dominated iff no other tier candidate has
    `usedClusterMaxSideMm`, `usedClusterAreaMm2`, `usedClusterSpanMm` all <= and
    at least one strictly < (exact ties never dominate).
  - Walk tiers in descending contact order; collect non-dominated candidates in
    intrinsic order (`compareIntrinsicCompactnessPlacementScores`, then
    `intrinsicLocalCandidateGeometryKey(state, candidate)`), skipping candidates
    already in `selected` (production) and skipping duplicates by
    `intrinsicLocalCandidateGeometryKey` (translation-normalized combined
    geometry, so corner twins count once), until
    `PROTECTED_PARETO_FRONTIER_LOCAL_SEED_LIMIT = 2` picks.
- Activation gate: same as intrinsic seed (`protectedDiversityEnabled` &&
  `maximumCount >= 3` && policy `edge-contact-then-balanced-compactness`).
- The picks never enter `selected` (production); they are returned as a new
  `protectedPareto: ReadonlyArray<LocalCandidate>` field of
  `LocalCandidateSelection` and pushed as protected-only successors
  (`eligibleForProductionLane: false, eligibleForProtectedLane: false,
  eligibleForProtectedIntrinsicLane: false, eligibleForProtectedParetoFrontierLane: true`),
  mirroring the intrinsic-only successor push at windowedBeam.ts:368-385.
  Production successors of the same parent OR the new tag when their candidate
  is a Pareto pick (same pattern as line 364-365).

### B. Lane retention (state level)

- Thread a new parent set `paretoFrontierStates` exactly like
  `intrinsicContactStates` (windowedBeam.ts:274-276, 290-291, 296-299, 444-446).
- New `rankParetoFrontierSuccessors(scored)`:
  - Filter `eligibleForProtectedParetoFrontierLane`.
  - Group by exact contact-strength tier key `(unplacedCount,
    dominantNearCompleteStructuralContactCount, tierCount)` where `tierCount` is
    `nearCompleteStructuralContactCount` when `placementOrder.length <=
    STRICT_STRUCTURAL_CONTACT_PLACEMENT_LIMIT`, else
    `Math.floor(nearCompleteStructuralContactCount / STRUCTURAL_CONTACT_COUNT_BAND_WIDTH)`.
  - Within a tier, non-dominated over FOUR cached objectives:
    `intrinsicMaxSideMm`, `score.collisionBoundsAreaMm2`,
    `score.collisionBoundsSpanMm`, `score.freeMaterialHoleCount`
    (all cached on ScoredState; no recomputation).
  - Concatenate tiers ordered by contact strength (unplacedCount asc, dominant
    desc, tierCount desc); within tier order by
    `protectedParetoFrontierLaneStateOrder`: `intrinsicMaxSideMm`,
    `collisionBoundsAreaMm2`, `collisionBoundsSpanMm`, `freeMaterialHoleCount`,
    `rawOccupiedHullWasteRatio`, `placementOrder`, `unplacedSourcePieceIds`,
    `intrinsicGeometryKey`. NO sheet-normalized fields, NO bottom/left sheet
    coordinates, NO other free-material metrics.
  - Slice to `PROTECTED_PARETO_FRONTIER_LANE_WIDTH = 2`.
- `pruneScoredStates`: new `protectedParetoFrontier` + `rankedParetoFrontierSuccessors`
  params; survivors appended to `retained` after intrinsic survivors with the
  same "not already retained by an earlier lane" filters; new
  `paretoFrontierSurvivors` return field threaded to the next step's parent set.

### C. Cross-lane dedup and tags

- Add `eligibleForProtectedParetoFrontierLane: boolean` to `TaggedSuccessor`,
  `KeyedState`, `ScoredState` (windowedBeam.ts:149-177) and thread it through
  EVERY construction site: successor pushes (357-385), unplaced-marker push
  (388-395), terminal fallback `scoreStates` map (461-478), repair
  `scoredState` (887-900), `selectTerminalOrientation` variants (707-723),
  `dedupeRawSuccessors` (1605-1674: representative preference unchanged,
  production first; OR all four eligibility flags like 1641-1650).

### D. Terminal arbitration

- `paretoFrontierProtectedRanked = rankScoredStates(terminalStates.filter(...))`
  next to lines 484-493; extend the `protectedRanked` union filter (494-500)
  with the new tag; extend `protectedTerminalBases` (571-577) with the first
  pareto-ranked state distinct from `initialBest` (still only when
  `localRepairBudget === 0`). Orientation and the strict dual gate
  (`selectParetoSafeProtectedWinner`) are unchanged: a protected winner must be
  strictly better under the production layout comparator AND strictly smaller
  in collision-envelope area.

### E. Traces (truthful, bounded)

- `decisionTrace.ts`: add `'pareto_frontier_reserved'` to
  `IrregularDecisionTraceLocalCandidateSelectionReason`; add
  `paretoFrontierReserved` to `IrregularDecisionTraceLocalCandidateDecisionCounts`
  (constructor + field, keep field order: append after
  `intrinsicContactTierReserved`); add `'protected_pareto_frontier_survivor'`
  to the beam-selection reason union (find the union near
  `IrregularDecisionTraceBeamSelection`).
- `windowedBeam.ts`: emit the new local reason exactly like
  `intrinsic_contact_tier_reserved` (detailed decision + summary count);
  beam-selection emission gains a pareto rank map and reason, with rank
  attribution following the lane that caused retention (extend the
  `retainedOnlyBy...` chain at 1946-1968: pareto AFTER intrinsic).
- `src/workers/decisionTraceNdjson.ts`: extend the decode schema(s) for the new
  reason and count field so NDJSON replay round-trips. Check how existing
  reasons are decoded and mirror it.

### F. Invariants (do not violate)

- Production fanout, production beam retention, incumbent, boundary lane, and
  intrinsic lane byte-equivalent behavior when the new lane finds nothing.
- Both lanes remain disabled whenever `localRepairBudget > 0` or a chromosome
  transform preference is active (same gate). Repair-8 triangle golden path is
  unreachable for the new lane.
- Cooperative cancellation/deadline checkpoints unchanged.
- No new score recomputation: the frontier consumes only cached `ScoredState`
  fields and already-computed local `IrregularPlacementScore` fields.
- No `as any`/non-null assertions; match existing code style (Effect Order
  combinators, readonly interfaces, single-purpose functions).
- Trace rank must follow the lane that caused retention, including converged
  states eligible for multiple lanes.

### G. Unit tests (tests/unit/irregularWindowedBeam.test.ts, follow existing
stub-NfpIfpService patterns; also decisionTraceNdjson.test.ts if it enumerates
reasons)

1. Zero-tier seeding: parent with >= 2 production zero-contact selections seeds
   the tied non-dominated orientation family that production evicted; the seed
   never replaces production candidates and emits `pareto_frontier_reserved`.
2. Positive duplicated tier: non-dominated picks respect the 2-pick cap and
   translation-normalized dedup (corner twins seed once).
3. Lane retention: a pareto-eligible state outside production/boundary/intrinsic
   retention survives with `protected_pareto_frontier_survivor` and pareto rank;
   converged states report the rank of the lane that caused retention.
4. Frontier domination: a strictly worse-in-all-four-objectives state loses to
   the non-dominated one within the same contact tier; different tiers do not
   dominate across tiers.
5. Gating: disabled when `localRepairBudget > 0`; disabled under chromosome
   transform preferences; fanout < 3 disables the seed.
6. Convergence: when a pareto lineage converges with production, the production
   representative is kept and terminal output is identical to a production-only
   run (mirror the existing convergence test at tests lines 599-647).
7. Terminal gate: a pareto terminal candidate wins only when strictly better
   under the production comparator AND strictly smaller in area.
8. Trace silence when no callback; new reason strings round-trip through
   decisionTraceNdjson.

### H. Validation the agent must run in the worktree

```sh
pnpm lint:fix
pnpm typecheck
ELECTRON_RUN_AS_NODE=1 pnpm exec electron ./node_modules/vitest/vitest.mjs run \
  tests/unit/irregularWindowedBeam.test.ts \
  tests/unit/decisionTraceNdjson.test.ts \
  tests/unit/irregularSchemaContracts.test.ts
```

Do NOT commit; report the diff summary and all command outputs.
