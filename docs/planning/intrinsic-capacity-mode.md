# Intrinsic Capacity Mode

This document specifies the Compact behavior when the requested sheet cannot
contain every prepared piece.

## Implementation Status

The first production version, `intrinsic-capacity-v1`, is implemented:

- Stage 0 proof-only preflight:
  `src/workers/algorithm/irregular/intrinsicCapacityPreflight.ts`;
- Stage 1 routing inside the Compact coordinator:
  `src/workers/algorithm/irregular/computeIrregularNesting.ts`;
- Stage 2 prefix capture and Stage 3 incumbent terminalization:
  `src/workers/algorithm/irregular/intrinsicCapacityPrefixes.ts`;
- Stage 4 empty-start cold subset search:
  `src/workers/algorithm/irregular/intrinsicCapacitySearch.ts`;
- exact endpoint, accounting, and comparator:
  `src/workers/algorithm/irregular/intrinsicCapacityEndpoint.ts`;
- orchestration and trace:
  `src/workers/algorithm/irregular/intrinsicCapacityMode.ts`;
- durable evidence gate: `pnpm gate:capacity`
  (`scripts/irregular-capacity-gate.ts`).

Documented implementation decisions within this contract:

- the singleton proof is reported before the area proof when both hold
  (deterministic priority; both route identically);
- the cold fanout ranks a state's legal candidates by exact intrinsic envelope
  metrics derived from incrementally maintained occupied bounds (maximum side,
  envelope area, span, then deterministic transform/point order); no contact
  measurement, placement object, beam state, or anchored rebuild is constructed
  for candidates that are not selected, because the capacity objective contains
  no contact criterion;
- the in-loop partial q0/q90 fit check is the exact canonical-grid span test;
  the authoritative full canonical legality and identity run at endpoint
  materialization, which re-runs `assertCanonicalGridLegalLayout` per
  orientation;
- successor deduplication uses both the bottom-left anchored canonical
  occupied-union identity and the exact set of placed prepared IDs, so two
  geometrically identical partial layouts with different future material
  accounting remain distinct; the cavity cache itself still keys only on
  occupied geometry;
- each piece depth receives a deterministic evaluation quota; all skip
  successors are reserved before placement work, and exhausting one depth's
  quota advances to the next piece rather than terminating the search;
- when neither the cold beam nor a prefix produces a legal endpoint, the
  honest all-unplaced empty endpoint is returned;
- the trace vocabulary is realized as additive result diagnostics codes plus
  the structured `capacityTrace` on the compute result, and the portfolio
  termination reason `capacity_subset_settled`.

The serial v1 implementation remains the production baseline. It is not the
accepted end-state. The forward direction is the stratified anytime portfolio
specified below; identical-sheet continuation remains separate and deferred.

The remainder of this document is the reviewed contract that the
implementation satisfies.

The design preserves the existing rule for roomy sheets:

```text
same pieces and settings
    + every winning complete motif still fits
    = same sheetless Compact result
```

Sheet dimensions must not influence complete-layout construction or intrinsic
ranking. They enter only at exact final fit, or inside the separate capacity
search after complete placement has been proved impossible or the bounded
complete archive has produced no fitting endpoint.

## Required User Behavior

Compact has two outcomes:

1. When all pieces fit, return the best complete sheet-independent motif.
2. When all pieces cannot be placed on the requested sheet, return the best
   exact partial layout and report every remaining piece as unplaced.

The capacity result is ranked by:

```text
more placed pieces
    → more placed unpadded material area
    → fewer exact enclosed cavities
    → less exact enclosed-cavity area
    → smaller intrinsic maximum side
    → smaller intrinsic envelope area
    → smaller intrinsic span
    → deterministic prepared order and geometry identity
```

This is an internal production policy. It does not introduce customer-visible
weights or sheet-relative compactness scoring.

## Accepted Forward Architecture

“Unified” means one deterministic scheduler, checkpoint protocol, exact
geometry authority, and endpoint/archive service. It does not mean one flat
beam or one comparator.

The portfolio protects three distinct cohorts:

- the legacy complete cohort keeps its current sheetless constructors, budget,
  retention, and intrinsic comparator unchanged;
- subset lanes may permanently skip pieces and keep independent slots and
  budgets;
- later place/defer complete-capable experiments remain shadow producers until
  they reproduce the established complete winners.

Complete and partial states never consume each other's survivor slots. Complete
dominance applies only after exact endpoint materialization and requested-sheet
q0/q90 fit. A fitting endpoint from a settled protected complete cohort
dominates every partial endpoint. A deadline result is explicitly
`deadline_censored_best_known` and carries a resumable checkpoint; it is not a
settled capacity result and cannot claim infeasibility.

The ordered implementation stages are:

1. depth-boundary checkpoint/resume for the unchanged cold capacity beam;
2. scale-free pressure and no-skip-frontier telemetry in shadow;
3. protected warm-prefix continuation lanes alongside the unchanged cold lane;
4. deterministic interleaving of protected complete and capacity work;
5. shared exact endpoint/archive mechanics with separate complete and partial
   namespaces;
6. an experimental place/defer complete-capable shadow producer.

No later stage may be promoted from an ambiguous or failed earlier
measurement.

Stages 1 through 3 are now implemented behind behavior-preserving seams. Cold
capacity execution can pause and resume only at completed depths, and an
opt-in benchmark observer reports exact parts-per-million pressure plus a
four-depth no-permanent-skip probe. Verified fitting prefixes may also seed
independent resumable warm shadow lanes with protected budgets. Both observers
are disabled in production and have no routing, ranking, or selection consumer.
The cold checkpoint format is now `intrinsic-anytime-checkpoint-v2`; its
integrity hash binds every frontier decision plus the private canonical,
incremental-contact, and spatial-index continuation identity. Resume also
rebuilds canonical-entry and spatial-index structure from exact placed
geometry, and corruption of any private cache is rejected.
The opt-in Stage 4 scheduler starts the cold lane with one four-depth quantum,
then alternates one committed `canonical-grid` piece with one resumed cold
depth until either lane settles. The remaining protected complete producers
retain their unchanged order. A fitting complete endpoint cancels any still
paused capacity checkpoint; a complete miss hands the existing settled or
paused cold state to the protected capacity coordinator without restarting it.
One base-cap entitlement preserves the exact cold lane through settlement.
Every fitting warm prefix receives one depth-boundary pilot under a second
base-cap entitlement. The deepest fitting
`canonical-grid` lane is then pinned across depth-boundary resumes until it
settles or exhausts that entitlement; `open-pocket-first` and then
`legacy-absolute-envelope` are deterministic fallbacks only when the preferred
producer is unavailable. Exact best-known endpoints can be materialized from
paused frontiers without consuming or mutating them. The coordinator records
every pilot and resume with exact depth and evaluation deltas, and a validator
reconciles them with aggregate and per-lane ledgers. It does not change
complete construction, use terminal compactness as a scheduling signal, or
allow warm and cold states to share survivor slots.

The next complete-side seam is now isolated but not scheduled: the strict
sheetless constructor has an opt-in, versioned checkpoint at fully committed
piece boundaries. Resume retains its exact parent lineage and cumulative
active-work/evaluation ledgers. Mid-piece evaluation caps remain terminal
truncation, never checkpoints. Ordinary strict construction does not compute a
checkpoint fingerprint, and complete archive retention/ranking is unchanged.
Resume rejects a missing consumed piece, altered placed/unplaced decision,
placement-order or trace mismatch, broken parent chain, inconsistent derived
occupied identity, changed settlement bounds, phase-capture toggle, or invalid
cumulative phase ledger. The scheduler quantum alone is deliberately absent
from the request fingerprint. Cyclic or overlong ancestry is rejected before
hashing, and the integrity digest includes a class-owned identity for all
continuation-relevant private geometry caches.
The canonical direct producer is advanced opt-in through one-piece portfolio
quanta. An equivalence gate compares direct and periodic run order,
coverage, evaluations, endpoint hashes, constructed-prefix identities,
sheetless/fitting archive order, and the final winner against uninterrupted
execution before the capacity scheduler consumes this seam.
The deterministic scheduler now consumes it: complete and cold states own
separate protected checkpoints and alternate without sharing survivors or
comparators. This proves intertwined chronology and no-restart reuse, not a
parallel wall-time improvement.

Stage 5 shares only archive mechanics: exact admission validation, canonical
deduplication, namespace storage, and terminal complete dominance. Complete and
partial namespaces still provide different duplicate ownership and ranking
policies, so neither cohort can consume the other's survivor slots or alter its
comparator.

Stage 6 now has one bounded shadow producer. It defers the first prepared piece
to a second pass and checkpoints the exact future-decision partition before
continuation. It may report only a skip-free complete exact endpoint in the
experimental namespace and has no output influence. The protected legacy
archive settles first; the observer then runs under its own `19,862`-evaluation
and `35 s` bounds. Non-cancellation failures become censored telemetry, while
explicit user cancellation remains authoritative. Promotion depends on the full
roomy/constrained baseline matrix; a mismatch remains useful rejected evidence,
not permission to displace the legacy winner.

## Checkpoint Contract

`IrregularBeamState` remains the exact geometry payload. A versioned
`IntrinsicAnytimeCheckpoint` wraps the retained frontier and records:

- the algorithm version and request/prepared-order fingerprint;
- producer role, archive cohort, and `completeEligible`/`subsetOnly` status;
- a disjoint placed, pending, deferred, and permanently skipped partition;
- pending order, decision cursor, pass and deferral counters, and the next
  depth boundary;
- exact material, cavity metrics, anchored identity, and q0/q90 fit mask;
- total, per-depth, and per-cohort budget ledgers plus scheduler deficit;
- active/settled/censored state and no-skip-frontier state.

Resume initially occurs only between completed depths. Successor identity in a
future place/defer producer must include the full future-decision state;
geometry plus currently placed IDs is sufficient only for the synchronized v1
cold depth.

## Stage 0: Proof-Only Capacity Preflight

Run `preflightIntrinsicCompleteCapacity` before coordinating the complete
archive. Its result is only:

```text
proven_impossible(reason)
inconclusive
```

It must never claim that complete packing is possible.

### Exact area proof

For every prepared piece:

1. enumerate its finite allowed transform set;
2. construct the canonical-grid collision polygon for each valid transform;
3. measure doubled polygon area with exact integer shoelace arithmetic;
4. retain the minimum valid doubled area for that piece.

Sum the minima with `bigint`. Complete packing is proved impossible only when
the sum exceeds twice the canonical requested-sheet area.

This is a necessary-condition proof. It does not estimate holes or imperfect
utilization. In particular, it must not add a waste percentage, density factor,
bounding-box heuristic, or safety allowance.

### Exact singleton-fit proof

For every piece, test whether at least one allowed transformed canonical
collision polygon can fit the requested sheet at q0 or as one rigid q90
orientation. If one piece cannot fit by itself in any allowed transform,
complete packing is proved impossible.

Invalid geometry, failed transformation, unrepresentable arithmetic, or
incomplete transform accounting are errors. They are not capacity proofs.

### Routing

```text
preflight proven impossible
    → bypass complete construction
    → run intrinsic-capacity-v1 from an empty state

preflight inconclusive
    → run the unchanged sheetless complete archive
```

The preflight avoids the complete run only for mathematically certain cases.
An inconclusive result is expected for many physically impossible packings
because exact two-dimensional packing feasibility is much harder than area and
singleton bounds.

## Stage 1: Preserve the Complete Compact Path

The current complete constructors and archive remain sheetless:

- no requested-sheet width or height in candidate generation;
- no requested-sheet normalization in local or terminal ranking;
- no requested-sheet fit in constructor retention;
- complete endpoints remain immutable;
- q0/q90 fit remains after intrinsic archive ranking.

If a complete endpoint fits, return it immediately. The capacity search must
not run. Existing roomy-sheet hashes, archive order, source selection,
evaluation counts, and renders are regression evidence for this boundary.

If preflight was inconclusive and valid, uncensored, complete archive coverage
produces no fitting endpoint, record `bounded_complete_archive_miss`. This is a
bounded-search outcome, not proof that no complete arrangement exists. Capacity
mode may then run because it can still provide a useful exact result.

Cancellation, deadline censoring, invalid geometry, or incomplete source
accounting remain errors and must not be reclassified as capacity transitions.

## Stage 2: Capture Reusable Complete-Search Prefixes

Prefix reuse is part of the first capacity version, but it must not consume
capacity placement evaluations or influence complete construction.

After each successful direct constructor returns, walk its already-committed
parent lineage once. Capture descriptors at the unique valid depths:

```text
floor(pieceCount / 4)
floor(pieceCount / 2)
floor(3 * pieceCount / 4)
```

Eligible direct roles are:

- `canonical-grid`;
- `legacy-absolute-envelope`;
- `open-pocket-first`.

This yields at most nine descriptors.

Every descriptor must:

- contain no skipped or unplaced piece;
- represent exactly a processed prefix of the immutable prepared-piece order;
- retain placed prepared IDs, ordered remaining IDs, placement order, source
  role, depth, and immutable placed geometry;
- be canonical-grid legal and sheetless;
- be captured only after construction returns;
- avoid state copying, spatial-index reconstruction, cavity measurement, and
  q0/q90 work during complete mode.

The first version must exclude periodic frozen partitions, raw or losing
candidates, capped or incomplete constructors, ordinary requested-sheet beam
states, and request-oriented copies. Those states are not guaranteed to express
the same original-order prefix contract.

## Legacy Stage 3: Build A Prefix Incumbent In Production V1

The serial `intrinsic-capacity-v1` production baseline does not create a
competing warm beam. This historical boundary remains the disabled-option
control, not the current forward architecture and not evidence that warm
continuation is useless.

After a bounded complete-archive miss:

1. exact-fit each descriptor against the real sheet at partial q0/q90;
2. reject non-fitting descriptors;
3. convert every fitting descriptor into a fully accounted partial endpoint by
   deterministically marking all remaining prepared pieces as unplaced;
4. measure exact topology and intrinsic metrics for at most nine endpoints;
5. select the best endpoint under the capacity objective as the initial
   incumbent.

This performs zero warm placement evaluations. A useful complete-search prefix
can improve partial-layout quality immediately and can reduce later cold work,
but it cannot take beam slots or evaluation allowance from the capacity search.

## Legacy Stage 4: Empty-Start Intrinsic Capacity Search

The original `intrinsic-capacity-v1` implemented a separate empty-start search
and endpoint type. Its bounds remain the cold-lane semantics inside the unified
portfolio.

First-version bounds:

- cold beam width: `16`;
- local legal-placement fanout: `3`;
- deterministic minimum placement-evaluation allowance: `50,000`;
- deterministic placement-evaluation quota per piece depth: `4,096`;
- total allowance: `max(50,000, pieceCount * 4,096)`;
- one mandatory skip successor at every piece depth.

At every depth, each retained state emits:

```text
up to three ordinary legal placement successors
one skip-this-piece successor
```

Every successor is checked for exact partial q0/q90 fit and deduplicated before
retention. Different piece depths never compete directly. Skip successors are
reserved for every retained state before that depth spends its placement
quota. If the quota is exhausted, the already-scored placement successors are
retained normally and the search continues at the next depth. The search
therefore considers every prepared piece even when candidate density is heavily
front-loaded. It starts from the empty state even when a prefix incumbent
exists.

The prefix incumbent may prune a cold state only when it is mathematically
unable to tie or beat the incumbent:

```text
placedCount + remainingCount < incumbentCount
```

or, when attainable counts are equal:

```text
placedMaterialArea + remainingMaterialArea < incumbentMaterialArea
```

Both comparisons are strict. Equality must remain searchable because cavities,
compactness, and deterministic geometry may still produce a better endpoint.
No cavity or compactness heuristic may prune a state without a separately
proved sound bound.

Exact cavity measurement happens after raw successor fit and deduplication. It
is cached by canonical occupied-union identity and must cover every retained
count/material contender before cavity-based retention or final comparison.

## Exact Endpoint And Accounting Contract

Capacity mode returns an `IntrinsicCapacityEndpoint` rather than weakening the
complete archive endpoint.

The endpoint must contain:

- exact placed prepared IDs;
- exact unplaced prepared IDs;
- no duplicate or missing requested piece;
- canonical collision legality;
- selected q0/q90 orientation;
- canonical geometry identity;
- placed unpadded material area;
- exact cavity count and area;
- intrinsic compactness metrics;
- deterministic settlement status.

A deterministic evaluation cap may settle the best retained endpoint.
Cancellation, deadline expiry, invalid geometry, or incomplete piece
partitioning may not.

## Required Trace Vocabulary

The result trace must distinguish:

- `capacity_preflight_proven_impossible`;
- `capacity_preflight_inconclusive`;
- `complete_archive_fitted`;
- `bounded_complete_archive_miss`;
- `capacity_subset_settled`.

It must also record:

- exact preflight proof reason and integer measurements;
- descriptor role, depth, and geometry identity;
- descriptors captured, fitting, rejected, and terminalized;
- prefix-incumbent count, material area, q0/q90 orientation, and identity;
- cold beam width, fanout, available cap, and consumed evaluations;
- per-depth quota, quota-exhaustion count, and completed piece depths;
- auxiliary placement evaluations, which must be zero;
- cold states pruned by count and by material bounds separately;
- exact placed/unplaced partition;
- cancellation, deadline, and settlement outcome.

## Falsifiers And Acceptance Gates

Reject or revise the implementation if:

- enabling descriptor capture changes complete archive construction, source
  selection, evaluation count, rank, canonical hash, or q0/q90 winner;
- Phase A reads requested-sheet dimensions;
- more than nine descriptors survive;
- a descriptor violates the original-order prefix contract;
- equality on attainable count and material area is pruned;
- prefix-enabled capacity output ranks below cold-only output;
- a run with no fitting prefix differs from the same cold-only search;
- repeated runs produce different descriptors, pruning, endpoint, or trace
  identity;
- placed and unplaced IDs do not form an exact partition of the request;
- a settled capacity search does not reach every requested piece depth;
- a runtime benefit is claimed without fewer cold successor evaluations and
  lower capacity elapsed time.

Required positive evidence:

- uninterrupted and depth-boundary-resumed cold runs have identical semantic
  traces and exact endpoint ordering;
- the six durable Triangle-20, Mixed-61, and Shapes-17 baselines pass on both
  `2000 x 2700` and `600 x 400`;
- current complete results remain at least equivalent in quality wherever they
  fit;
- multiple roomy sheets select the same complete motif;
- an area-proven constrained fixture bypasses complete construction;
- a singleton-infeasible fixture bypasses complete construction;
- an inconclusive/no-fitting-complete fixture enters capacity mode honestly;
- skip successors can prefer several smaller pieces over one larger piece when
  that improves count and material priority;
- prefix-incumbent and cold-only paired runs demonstrate whether reuse improves
  quality, runtime, both, or neither.

## Runtime Expectations

The proof-only preflight should cheaply bypass complete construction for
obviously area-deficient or singleton-infeasible sheets.

For an inconclusive request, the complete archive still runs first. Prefix
incumbents add only one bounded parent-chain walk and at most nine exact endpoint
measurements. They do not run a second warm search.

The unavoidable worst case is:

```text
inconclusive preflight
    + full complete archive
    + no useful fitting prefix
    + full max(50,000, pieceCount * 4,096)-evaluation cold capacity search
```

This worst case must be reported honestly. It can be optimized later only with
sound additional bounds or measured scheduling changes; it must not be hidden
by reclassifying a bounded archive miss as an impossibility proof.

This remains an unresolved architectural cost, not an accepted final design.
The prefix incumbents preserve quality but do not continue the complete search
or prevent duplicated work. A future version must evaluate protected reuse or
handoff of exact complete-search partial states so inconclusive constrained
sheets do not routinely pay for a full complete run followed by a cold restart.

A fixed `minimumCollisionAreaSum * 1.10 > sheetArea` routing rule is rejected.
It misses both measured serial double-work cases: Mixed-61 on `700 x 500` and
Shapes-17 on `600 x 400`. Exact raw-area and singleton-fit tests remain proofs.
Scale-free density, span, fit-slack, or no-skip-frontier measurements may only
schedule protected work or reserve named diversity buckets. They may not prune
a complete-capable state, order the legacy complete cohort, consume its slots,
or enter terminal compactness ranking.

## Later: Identical-Sheet Continuation

Multi-sheet continuation is not part of the first capacity implementation.
Once one capacity endpoint is settled:

1. remove exactly its placed prepared IDs;
2. preserve the ordered remaining prepared IDs;
3. invoke the same policy on a fresh identical sheet;
4. require partition equality and a no-progress guard.

This later layer must not move pieces between settled sheets or change the
single-sheet capacity objective without a separate reviewed design.
