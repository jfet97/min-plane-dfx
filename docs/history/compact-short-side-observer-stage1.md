# Compact Short-Side Observer Stage 1

## Accepted

- A sibling-profile, zero-search q0/q90 observer over settled complete Compact
  endpoints.
- Exact sheet legality, hard cavity/hull eligibility, and the existing
  intrinsic geometric Pareto front before directional ranking.
- Censored runtime/trace budgets and strict zero-evaluation accounting.
- Separate observer geometry artifacts with immutable checksums.
- The reproducible Triangle-20 `600 x 400` directional tradeoff.
- A strict promotion matrix with nine Compact controls and nine materialized
  short-side-profile layouts. When Stage 1 has no legal guarded winner, the
  short-side profile records and renders the exact Compact result as an
  explicit fallback instead of inventing or omitting a layout.

The current-source promotion run at `1cd5ac7` passed all 18 layouts: four
guarded Stage 1 winners and five exact Compact fallbacks. Every layout has an
exact piece partition, SVG, PNG, canonical hashes, and checksummed provenance.
The maximum observed Stage 1 runtime was `57.984 ms`; placement and candidate
evaluations remained zero.

Final review found that the v1 comparison tuple placed intrinsic hull/cohesion
tie-breakers before the documented short-axis shortfall. Version v2 restores
the declared order: exact legality, requested long-axis span, requested
short-axis shortfall, then intrinsic metrics. A discriminating Pareto-front
test covers the ordering. The corrected full matrix produced the same 18
layout hashes as v1.

## Rejected

- Reusing the old ordinary `short-side-fill` scorer or beam.
- A fixed `material area + 20%` target as proof, pruning, or routing.
- Raw long-axis minimization without hard geometric guards. The rejected
  `1513.5 x 88.288 mm` Triangle strip was the concrete falsifier.
- Any Stage 1 influence on production Compact or capacity output.
- Parallel algorithm execution or cross-target checkpoint resume.

## Later experiments

- Fixed-target exact projection was tested as Stage 2 and rejected after exact
  closure exhausted at piece 17 without a complete endpoint.
- Width-one target-aware construction was tested as Stage 3 and rejected
  because it lost to the free Stage 1 winner and exceeded the `0.15`
  occupied-hull-gap admission floor.

Neither rejected implementation is part of the Stage 1 promotion. Their
measurements and stop decisions remain in the corresponding history pages.
