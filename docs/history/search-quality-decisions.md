# Irregular Search Quality Decisions

## Intrinsic Capacity Lane Budget

The first deterministic anytime scheduler proved checkpoint reuse but still
settled cold and every warm lane serially, increasing total work. The
`intrinsic-anytime-portfolio` branch therefore keeps the same exact lanes and
replaces settle-all execution with one warm pilot depth per fitting prefix, one
shared aggregate evaluation allowance, and continuation of at most one exact
pilot winner. Paused frontiers materialize honest best-known partial endpoints
without consuming their resumable checkpoints. Promotion remains contingent on
the retained complete hashes, constrained quality floors, and lower aggregate
work in the full matrix.

The first one-depth selector at `d827971` is rejected. It lowered aggregate work
substantially, but chose `legacy-absolute-envelope@30` on Mixed-61 `700 x 560`
and produced `57/61`, below the known `59/61` warm floor. It also chose a
Triangle-20 warm endpoint that tied count/material but lost the exact cold
objective. Shallow terminal compactness is not accepted as a proxy for future
continuation value.

The replacement hypothesis protects the exact cold checkpoint with one
single-lane entitlement and gives warm checkpoints a separate entitlement.
Warm selection is repeated after each completed depth and compares only
equal-depth continuation signals: no-skip persistence, placed count, and exact
material. Distinct tied frontier identities advance round-robin. It deliberately
excludes cavities, envelope dimensions, terminal hashes, and sheet-relative
compactness from scheduling.

The targeted `86875e0` measurement rejects that allocation too. Round-robin
preserves Triangle's exact cold endpoint, but splits the warm entitlement
across three Mixed depth-30 lanes and leaves all three censored around depth
`51-52`; final selection falls back to cold at `55/61`, below the required
`59/61`. Protected diversity without enough settlement runway is therefore not
itself a continuation strategy.

The next bounded experiment retains every pilot but pins the deepest fitting
`canonical-grid` lane through settlement under the same warm entitlement.
Open-pocket and legacy are absence fallbacks, not competing predictions. The
choice is intentionally evidence-specific: canonical already produced both
known Mixed constrained floors within one entitlement. Detailed coordinator
quanta and ledger reconciliation must prove that exactly one warm lane receives
post-pilot work.

This document condenses the former chronological research ledger into decision
arcs. Metrics describe the named commit and experiment, not current production,
unless the row explicitly says otherwise. Detailed reports and negative results
remain under [`../research/`](../research/index.md), immutable portable evidence
under [`../artifacts/`](../artifacts/README.md), and the original chronology in
Git history.

## Exactness and Determinism Foundation

The search experiments share one non-negotiable boundary: canonical Clipper2
geometry decides exact legality and endpoint admission. Floating SAT loss is a
proposal signal only. Sheetless identity normalizes translation, rigid
quarter-turn, interchangeable-copy order, ring origin, and winding while
preserving reflection and relative placement.

Important foundations include:

- contact-score preservation through final reconstruction at `ac75222`;
- `0.001 mm` canonical occupied-geometry identity and canonicalized score
  fields at `95de72c`;
- phase-aware exact-state identity and SAT/Clipper2 cross-classification from
  `13396c5` through `71f8292`;
- near-parallel NFP crossing recovery in `f12b466` / `f68be50`;
- valid full-circle closure-point quantization repair at `6d1cfa1`.

These fixes are correctness work, not evidence that one search policy is best.

## Immediate Scoring and Protected-Lane Arc

### Candidate L and L2

Candidate L replaced sheet-normalized compactness with intrinsic maximum side,
area, and span. It made homogeneous rectangles invariant and reduced the
Mixed-61 four-sheet area spread from `276,459.435 mm2` to `50,457.263 mm2`, but
it widened the accepted Triangle lattice. L2 did not recover the production
quality gate. Both were rejected unchanged, while their intrinsic ranking
remains a reusable ingredient.

The recombination audit found one useful constrained result: keep production
local ranking and use Candidate L's intrinsic whole-layout order only after
depth 20. That reduced Mixed four-sheet spread by `65.16%` and average holes
from `9.5` to `2.5`, but raised mean area by `6.15%` and the then-reference
sheet by `34.26%`. It is evidence about delayed global ranking, not a shipping
candidate.

Evidence:

- [`../research/candidate-l-corpus-audit.md`](../research/candidate-l-corpus-audit.md)
- [`../research/candidate-l-recombination-audit.md`](../research/candidate-l-recombination-audit.md)
- [`../artifacts/candidate-l-audit/`](../artifacts/candidate-l-audit/)
- [`../artifacts/candidate-l-recombination/`](../artifacts/candidate-l-recombination/)

### Contact and topology diversity

Contact-tier reservations established that maximum-side-first intrinsic growth
inside a duplicated exact-contact tier can preserve a useful alternative. Broad
contact-first promotion failed: it often strengthened local contact while
forming chains, rings, or larger envelopes.

The whole-beam topology experiment is the clearest counterexample. It produced
acceptable Mixed results on three sheets but selected a high-contact perimeter
chain of `1,677,571.04 mm2` on `2000 x 2700`. Contact connectivity is therefore
a bounded diversity signal, never a terminal authority that can rescue
geometrically dominated layouts.

The repair-disabled ordinary decoder subsequently accepted three isolated
mechanisms:

- a protected boundary-anchor lane;
- one protected intrinsic contact lane;
- a width-two protected Pareto frontier by exact contact tier.

They improved historical ordinary-decoder checkpoints without consuming
production beam capacity, but they never closed sheet invariance. Compact
quality no longer uses that ordinary decoder; these mechanisms remain relevant
only to the ordinary path and as research evidence.

Evidence:

- [`../research/contact-tier-diversity-experiment.md`](../research/contact-tier-diversity-experiment.md)
- [`../research/contact-tier-intrinsic-reservation.md`](../research/contact-tier-intrinsic-reservation.md)
- [`../research/beam-topology-diversity-experiment.md`](../research/beam-topology-diversity-experiment.md)
- [`../research/protected-boundary-anchor-diversity.md`](../research/protected-boundary-anchor-diversity.md)
- [`../research/protected-intrinsic-contact-seed.md`](../research/protected-intrinsic-contact-seed.md)
- [`../research/protected-contact-pareto-frontier-spec.md`](../research/protected-contact-pareto-frontier-spec.md)

### Small-piece ordering and bounded GA

A protected front-eight order variant improved one Mixed envelope by `1.86%`
and reduced holes from 10 to 7, but roughly doubled runtime. The reusable idea
is a bounded alternative order behind an incumbent, not two independent full
decodes.

The bounded GA probe improved rectangles and some Mixed-50 envelope metrics,
but cost roughly `4.3-6.4x`, did not solve invariance, and selected a Mixed-61
result `17.48%` larger with more holes. GA remains conditional on a demonstrated
order/rotation bottleneck after deterministic construction exposes useful
futures.

Evidence:

- [`../research/small-piece-gap-diversity-experiment.md`](../research/small-piece-gap-diversity-experiment.md)
- [`../research/bounded-ga-order-rotation-probe.md`](../research/bounded-ga-order-rotation-probe.md)
- [`../artifacts/small-piece-gap-diversity/`](../artifacts/small-piece-gap-diversity/)
- [`../artifacts/bounded-ga-order-rotation/`](../artifacts/bounded-ga-order-rotation/)

## V7 Constructive Search Arc

V7 separated exact completed endpoints from relaxed search and measured whether
the missing quality came from candidate generation, partial-state retention,
piece scheduling, or global reconstruction.

### What worked

- Two sheetless exact seed constructors and a bounded exact endpoint archive
  made comparisons reproducible.
- Compactness and exact void topology became the geometric dominance axes;
  contact received one bounded selection turn after geometric dominance.
- That correction selected the `405,773.434053 mm2` zero-cavity Mixed
  pocket-first endpoint instead of the more connected but geometrically worse
  `418,220.374 mm2` endpoint.
- A finite intrinsic envelope-event candidate recovered a previously absent
  historical Triangle lineage through depth 3, proving a real candidate-domain
  omission rather than merely a comparator issue.

### What failed

- The trace-only queue/beam discriminator found Triangle beam headroom but no
  queue headroom. Initial Mixed queue evidence compared different placed
  material and was invalid as a scheduling conclusion.
- The commensurate two-order follow-up was too sparse and expensive to justify
  a free dynamic queue.
- Width-three partial geometric beam runs did not recover the delayed Triangle
  witness. Contact-role allocation improved cohesion only by accepting a large
  envelope regression.
- A two-placement compact-closure horizon completed 24 equal-work comparisons
  with zero passes.
- Four-contributor legal reconstruction produced no endpoint that jointly
  improved geometry, cohesion, and topology.
- Coordinated multi-piece transport and exact component-interface closure found
  only microscopic canonical-grid improvements, not a useful reassembly.

These results closed broad rigid-legal Triangle reconstruction as the next
direction. They did not close a carefully bounded cavity-first commensurate
scheduler for heterogeneous jobs.

Evidence:

- [`../research/v7-seed-archive-stage0-stage1.md`](../research/v7-seed-archive-stage0-stage1.md)
- [`reviews/fable5-v7-search-quality-review.md`](reviews/fable5-v7-search-quality-review.md)
- [`reviews/v7-search-redesign-review.md`](reviews/v7-search-redesign-review.md)
- [`../artifacts/v7-search-redesign/`](../artifacts/v7-search-redesign/)

## Relaxed Pressure and Global Repair Arc

The exactness-retained E4 controller allowed private overlapping states, used
SAT/GLS only for proposal guidance, and admitted only complete
canonical-legal endpoints. Restart capacity three was harmful on Triangle and
quality-neutral but slower on Mixed (`9baaa95`), so cross-target restart
injection was rejected.

The equal-budget matrix tested baseline contraction, a smaller `0.625%` final
step, sampled relocation, and both together from pinned Triangle and Mixed
seeds. All eight arms produced zero canonical-exact endpoints. The smallest
Triangle loss reached `3.6e-06` while 12 pair conflicts remained across 16
pieces, demonstrating that tiny relaxed loss is not proximity to exact
legality. The adaptive-pressure branch is closed for these fixtures.

Sampled relocation remains default-off machinery. A frame bug was fixed after
the first Mixed advantage measurement; that advantage must reproduce before the
primitive is used inside a future bounded destroy-and-repair experiment.

Evidence:

- [`../research/pre-v7-exactness-retained-foundations.md`](../research/pre-v7-exactness-retained-foundations.md)
- [`reviews/v7-search-redesign-review.md`](reviews/v7-search-redesign-review.md)

## Periodic Construction and Shared Archive Arc

Periodic-family research produced the current compact-production foundation.

1. Raw periodic source-survival auditing showed that a bounded retained-cell
   front evicted the source of the `74,428.143126 mm2` Triangle witness.
2. `ee9d0fa` introduced exact direct-legal candidate-evaluation caps. The
   square-basis Mixed continuation completes at exactly 19,862 evaluations;
   19,861 produces no endpoint.
3. `e4378e5` measured source-audit crop enumeration as `173.286 s` of
   `173.702 s` selection time. Removing that observer preserved the selected
   source order in that control but periodic-only Triangle quality remained
   unacceptable at `240,521.398 mm2`.
4. `4831035` created one exact common archive. Its initial no-audit matrix was
   repeatable but selected a poor `115,228.711 mm2` Triangle direct control.
5. `fa9ab29` restored bounded raw-witness admission under the same
   eight-continuation cap and restricted selection to the first geometric
   Pareto front. It recovered Triangle `74,428.143126 mm2` and retained Mixed
   `405,773.434053 mm2`, both with zero cavities.
6. The speed arms showed an exact warm replay and a generic cold
   `P2 + axis-union` allocation. The cold allocation retained Triangle and
   found a smaller exact Mixed endpoint at `391,605.850174 mm2`, zero cavities.
7. Shapes-17 added an all-distinct control: all three direct roles completed,
   zero periodic families was valid, and the selected endpoint was
   `304,499.845650 mm2` with zero cavities.
8. `8b0fba4` made the shared archive the Compact quality production path;
   `f33831f` merged it and `b506344` recorded the integration on `main`.

The production promotion does not convert every experiment into a universal
claim. The fixed family/front/continuation caps are deterministic search bounds,
not exhaustive enumeration. Current ten-sheet invariance is still unverified.

Evidence:

- [`../artifacts/deterministic-periodic-budget/`](../artifacts/deterministic-periodic-budget/)
- [`../artifacts/intrinsic-shared-archive-step4/`](../artifacts/intrinsic-shared-archive-step4/)
- [`../artifacts/intrinsic-shared-archive-quality/`](../artifacts/intrinsic-shared-archive-quality/)
- [`../artifacts/periodic-audit-speed/`](../artifacts/periodic-audit-speed/)
- [`../artifacts/shapes-17-baseline/`](../artifacts/shapes-17-baseline/)

## External Provenance and Transfer Limits

The source audits preserve pinned evidence from Deepnest `2fb1051`, SVGnest
`1248dc2`, libnest2d `663daa6`, PackingSolver `3d8d97dd`, Sparrow `961ec31`,
and Dalsoo `bde2a3e`, plus the Abeysooriya and Dalalah paper provenance.

Transferable ideas include bounded order populations, exact incumbent
preservation, gap-aware reconstruction, destroy/rebuild around a subset, and
coordinated movement. Their geometry assumptions are not interchangeable with
this repository's canonical Clipper2 boundary, and no external source proves
the proposed cavity-first scheduler.

See:

- [`../research/open-source-nesting-strategies.md`](../research/open-source-nesting-strategies.md)
- [`../research/open-source-irregular-nesting-strategies.md`](../research/open-source-irregular-nesting-strategies.md)
- [`../research/deepnest-svgnest-source-comparison.md`](../research/deepnest-svgnest-source-comparison.md)
- [`../research/dalsoo-abey-dalalah-transfer-study.md`](../research/dalsoo-abey-dalalah-transfer-study.md)
- [`../research/irregular-nesting-literature-and-web-research.md`](../research/irregular-nesting-literature-and-web-research.md)

## Unified Intrinsic Capacity Direction

Capacity v1 established exact constrained-sheet output but retained a serial
boundary: an inconclusive request may finish the complete archive and then
restart a cold subset beam. Its captured prefixes were tested only as terminal
incumbents. That evidence did not test continuation from their already legal
geometry.

The accepted correction is a stratified anytime portfolio. The protected
legacy complete cohort remains sheetless and unchanged; capacity and later
place/defer experiments receive independent slots and budgets. They share
scheduling, checkpoints, exact geometry authority, and endpoint/archive
mechanics, not one survivor list or comparator. Complete dominance occurs only
after exact q0/q90 endpoint fit. Fixed `+10%` area routing is rejected.

Implementation proceeds through six separately measurable stages, beginning
with deterministic cold-search depth-boundary checkpoint/resume. See
[`../research/intrinsic-anytime-portfolio.md`](../research/intrinsic-anytime-portfolio.md).
