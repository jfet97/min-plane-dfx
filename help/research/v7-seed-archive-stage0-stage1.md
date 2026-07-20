# V7 Seed Archive: Stage 0 And Independent Stage 1 Arms

Status: Stage 0/1 and the first bounded reconstruction checkpoint are complete.
The branch remains experiment-only; no V7 result is approved for production.

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

The committed harness is
`scripts/irregular-intrinsic-v7-seed-archive.ts`. It requires a clean checkout
and an exact `--source-commit` match when supplied, then writes an immutable
`report.json`, `manifest.json`, seed SVGs, and every legal endpoint-archive SVG.

```sh
pnpm exec tsx --tsconfig tsconfig.node.json scripts/irregular-intrinsic-v7-seed-archive.ts \
  --fixture triangle-20 \
  --output /private/tmp/min-plane-provenance/v7-triangle \
  --source-commit "$(git rev-parse HEAD)"

pnpm exec tsx --tsconfig tsconfig.node.json scripts/irregular-intrinsic-v7-seed-archive.ts \
  --fixture mixed-61 \
  --output /private/tmp/min-plane-provenance/v7-mixed61 \
  --source-commit "$(git rev-parse HEAD)"
```

Use `--arms control,split` to isolate arms and `--compact` only for a harness
smoke run (128 evaluations, one sweep, two seconds per arm). It is not evidence
for the 12,000-evaluation / 60-second Stage 1 contract.

The reviewer must inspect cache savings, endpoint archive handoffs, all
independent arms, exact legality classifications, counter deltas, and rendered
SVG/PNG layouts. The experimental ancestry is known not to be the current-main
triangle golden, so no wholesale merge is permitted even if a Mixed-61 relaxed
trace improves.

## Compactness-Cohesion Reconstruction Checkpoint

Commit `e8748e1` replaces saturated failed-certificate ordering with exact
Pareto dominance over raw compactness and cohesion measurements. Certified
layouts remain strictly ahead of failures, both baseline seed geometries are
protected, and capacity truncation interleaves objective representatives rather
than collapsing tradeoffs into one contact- or area-first scalar. The same
checkpoint pairs `gap-contained` placement with the reversed and four
endpoint-derived deterministic orders. Effective orders are keyed by canonical
geometry-class sequence so interchangeable copies do not consume duplicate
decode budgets.

Immutable evidence:

- Triangle:
  `/private/tmp/min-plane-provenance/v7-cohesion-front-e8748e1/triangle/`
- Mixed:
  `/private/tmp/min-plane-provenance/v7-cohesion-front-e8748e1/mixed/`

The Triangle run collapses thirteen nominal roles to three effective decodes,
as required for interchangeable copies. Its two exact endpoints remain the
diagnostic V7 ancestry and do not satisfy or replace the current-main repair-8
golden.

The Mixed run completes all thirteen layouts. The smallest envelope remains
`open-pocket-first` at `405,773.434 mm2`, but it remains fragmented with 26
isolates and a largest contact component of 11. The new combined frontier is
`endpoint-q0-left-to-right`: `418,220.374 mm2`, 13 isolates, 24 contact
components, largest component 27/61, and 28/3 total/dominant contacts. This is a
real cohesion improvement over the previous 15-isolate / largest-16 endpoint,
but it still misses the compactness/contact gate. Stacking pocket placement
onto that order is worse (`423,297.842 mm2`, 15 isolates, largest component
14), so additional order/pocket combinations are not justified.

The next isolated experiment is a bounded sheetless partial-state Pareto beam.
It must preserve the exact pure-growth lineage, compare only synchronized
construction depths, and retain states over three compound axes: intrinsic
envelope compactness, contact-component fragmentation, and exact void topology.
Contact length is diagnostic only and must not reward chains. This is a new
search/retention hypothesis and must not be conflated with the completed
reconstruction checkpoint.

## Geometric-Cohesion Correction And Queue/Beam Discriminator

Commit `a3a7b95` removes the false all-or-nothing treatment of contact. Completed
layouts are dominated only when they lose on the compound intrinsic compactness
and exact void-topology axes. Front truncation still gives exact-contact
structure one bounded turn after the compactness and void representatives, so
contact remains actionable without preserving a worse ring by veto. Diagnostic
contact floors no longer split the archive into hard pass/fail partitions.

The fresh Mixed archive selects `open-pocket-first` at `405,773.434 mm2`, zero
enclosed cavities, and `0.200227` largest hull-gap ratio. Triangle remains the
same legacy reconstruction because interchangeable pieces collapse the nominal
orders to three distinct decodes; the correction creates no missing geometry.

Commit `7be8d04` adds an independent trace-only discriminator. Per synchronized
depth it compares every distinct remaining geometry class with the scheduled
piece, then continues up to four rejected same-piece geometric-front states by
one unchanged placement. Compactness and void topology determine headroom;
contact fragmentation is reported and used only as the bounded deterministic
tie-break. This measurement decides whether the next search change should be a
dynamic queue, a partial beam, or both.

Immutable runs at commit `14868c2` answer that question:

- Triangle completes all 20 depths with `15` beam-headroom, `0` queue-headroom,
  and `5` neither classifications (`16,627` evaluations, `11.2 s`). Identical
  pieces make queue changes inert, while discarded placement states remain
  non-dominated after one further triangle at most depths.
- Mixed reaches its `25,000`-evaluation cap after 11 completed depths (`13.3 s`):
  `5` beam-only, `1` queue-only, `3` both, and `2` neither. The trace contains
  `14` non-inert gap-contained queue candidates, including `5` that dominate
  every scheduled-piece successor, plus `16` non-dominated beam continuations
  and `2` strict beam improvements.

The selected Stage 2 design is therefore a bounded geometric partial beam for
all jobs plus a dynamic queue only when distinct remaining geometry classes
produce real gap-contained opportunities. The Mixed audit followed the
`canonical-grid` pure-growth reconstruction: under concurrent cold execution,
the non-baseline compact roles exceeded the compact harness's 15-second
per-decode limit. These counts prove generic reachability headroom but do not
claim complete-lineage coverage for the `405,773.434 mm2` pocket-first result.
