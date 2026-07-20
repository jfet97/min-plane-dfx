# V7 Seed Archive: Stage 0 And Independent Stage 1 Arms

Status: implementation complete; diagnostic evidence pending the immutable
Triangle-20 and Mixed-61 runs from the committed checkout.

## Purpose

The retained E4 relaxed search proved two separate facts: SAT and canonical
Clipper2 can disagree at tiny residue, and a first legal intermediate is not a
valid reason to stop exploring. V7 is an isolated controller experiment that
addresses those control defects before attempting broader global motion.

It does not change production, the existing E4 controller, the protected
reference decode, or the current-main triangle golden.

## Stage 0 Controls

- Construct two full-coverage canonical-exact seeds without a requested sheet:
  `canonical-grid` (maximum-side then area) and
  `legacy-absolute-envelope` (area then maximum-side). The latter is a real
  comparator, not a saved Mixed-61 layout.
- Keep the finite translation basis immutable, cache the phase signature by
  catalog entry and basis, and report cache requests/hits/misses per run.
- Evaluate every materialized candidate with exact canonical structure at the
  protection boundary. The pressure tuple is:

  ```text
  (wall offenders, overlap pairs, conflicted pieces, wall overrun grid,
   doubled Clipper overlap grid area, envelope grid area, maximum side, span)
  ```

  SAT raw/weighted loss follows that tuple only as a tie-break and proposal
  direction. A legal canonical endpoint is archived but never remains in the
  infeasible pool or stops later parent/sweep work.
- Retain a capacity-eight legal endpoint archive by phase-aware `stateKey`, not
  quarter-turn layout identity. It has per-seed area and topology representatives
  plus alternating non-dominated P/topology frontier slots. Hull-gap fractions
  are compared by cross multiplication of grid-area numerator/denominator.
- Bound diagnostic samples to four kinds per `(arm, seed role, contraction
  ratio)`: strict numeric improvement, protected survivor, legal endpoint, and
  first SAT/Clipper disagreement. This bounds Stage 1 to at most 24 samples per
  arm while counters retain total generated/materialized/unique/evaluated and
  archive admission/rejection/eviction facts.

## Stage 1 Arms

Each arm gets one independent `12,000 evaluations / 60 seconds` budget across
both seeds and contraction ratios `1/20`, `1/40`, and `1/80`.

- `control`: contracted baseline with the new exact archive/control telemetry.
- `split`: q=1/3, 1/2, and 2/3 static role splits on the existing contraction
  axis; no second axis is invented.
- `atomic`: find the strongest canonical positive-area overlap pair, use its
  SAT MTV only as a direction, and enumerate every floor/ceil balanced exact
  allocation satisfying `firstDelta - secondDelta = MTV`. The candidates bypass
  the old local 1.001 improvement gate and enter the bounded protected pool.
- `refine`: standalone two-radius vocabulary around the strongest current
  conflict endpoint. It does not require an atomic success.

No Stage 2 combinations are present. Graph-cut/satellite moves, rigid component
transport, and broad coordinate descent remain later hypotheses.

## Required Measurements

The committed harness must next produce immutable manifests for Triangle-20 and
Mixed-61. The reviewer must inspect cache savings, endpoint archive handoffs,
all three independent arms, exact legality classifications, counter deltas, and
the rendered SVG/PNG layouts. The experimental ancestry is known not to be the
current-main triangle golden, so no wholesale merge is permitted even if a
Mixed-61 relaxed trace improves.
