# Intrinsic Capacity Mode

This document specifies the planned Compact behavior when the requested sheet
cannot contain every prepared piece. It is a forward implementation contract,
not current production behavior.

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

## Stage 3: Build a Prefix Incumbent

Prefix reuse must not create a competing warm beam.

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

## Stage 4: Empty-Start Intrinsic Capacity Search

Implement `intrinsic-capacity-v1` as a separate search and endpoint type.

Fixed first-version bounds:

- cold beam width: `16`;
- local legal-placement fanout: `3`;
- deterministic placement-evaluation cap: `50,000`;
- one mandatory skip successor at every piece depth.

At every depth, each retained state emits:

```text
up to three ordinary legal placement successors
one skip-this-piece successor
```

Every successor is checked for exact partial q0/q90 fit and deduplicated before
retention. Different piece depths never compete directly. The search starts
from the empty state even when a prefix incumbent exists.

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
- a runtime benefit is claimed without fewer cold successor evaluations and
  lower capacity elapsed time.

Required positive evidence:

- current Triangle-20, Mixed-61, and Shapes-17 complete results remain at least
  equivalent in quality wherever they fit;
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
    + full 50,000-evaluation cold capacity search
```

This worst case must be reported honestly. It can be optimized later only with
sound additional bounds or measured scheduling changes; it must not be hidden
by reclassifying a bounded archive miss as an impossibility proof.

## Later: Identical-Sheet Continuation

Multi-sheet continuation is not part of the first capacity implementation.
Once one capacity endpoint is settled:

1. remove exactly its placed prepared IDs;
2. preserve the ordered remaining prepared IDs;
3. invoke the same policy on a fresh identical sheet;
4. require partition equality and a no-progress guard.

This later layer must not move pieces between settled sheets or change the
single-sheet capacity objective without a separate reviewed design.

