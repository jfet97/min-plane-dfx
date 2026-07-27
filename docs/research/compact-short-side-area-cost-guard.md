# Compact Short-Side Area-Cost Guard

Method and measurements for the production area-cost honesty guard accepted at
commits `903657e1aeaa80d2578e78436da9b3c810c12672` (guard),
`536da14360f0d5782295d1115747cadbe1b3dd88` (retained causal-veto evidence and
exact boundary tests), and `a750798f4ec6cd8eb800c5fcaa5b629b79bc44d2`
(composite veto refresh; accepted evidence bundle source). The decision record is
[`../history/compact-short-side-area-cost-guard.md`](../history/compact-short-side-area-cost-guard.md);
accepted matrix artifacts are
[`../artifacts/compact-short-side-area-cost-guard/`](../artifacts/compact-short-side-area-cost-guard/README.md).

## Method

1. Baseline capture: the accepted 18-layout matrix (3 fixtures x 3 sheets x
   Compact/Short Side) at `8c51261`, all checks green, per-layout metrics
   (envelope area, density, hull gap, isolated pieces, contact components,
   shared boundary) extracted for the Compact control and the promoted sibling.
2. Source archaeology: full read of the stage-1 observer, the terminal
   observer, the contact strip, and the coordinator wiring, cross-checked
   against the accepted contact-strip/matrix artifacts.
3. Guard design: one exact BigInt term added to both admission stages,
   `3 * candidateEnvelopeAreaGrid2 <= 4 * productionEnvelopeAreaGrid2`, plus
   causal per-construction veto telemetry and a distinct fallback outcome.
4. Verification: focused unit tests with exact 4/3 boundary cases (admit at
   the exact bound, reject one grid step above it), the terminal-observer
   probe per roomy fixture, the full 18-matrix before/after, the
   compact-focused unit set, `gate:mixed61-compact`, and visual review of
   every changed render. Independent design review; five findings, all
   accepted.

## Before/after per directional case (roomy `2000 x 2700` unless noted)

| Case | Before (promoted) | Area vs Compact | After |
| --- | --- | --- | --- |
| Triangle-20 | multi-row shelf `1,765.760 x 75.675`, fill `88.288%`, density `0.500`, `0 mm` shared boundary | `1.795x` | vetoed; Compact herringbone retained (`short-side-quality-protected-compact-fallback`) |
| Mixed-61 | contact strip `2,000.000 x 207.700`, fill `100%`, density `0.755` | `1.061x` | kept, byte-identical hashes (`directional-success`) |
| Shapes-17 | pair fold `1,897 x 221`, fill `94.859%`, density `0.672` | `1.487x` | vetoed; Compact block retained (`short-side-quality-protected-compact-fallback`) |
| Triangle-20 `600 x 400` | guarded archive zigzag, fill `98.731%`, shared boundary `481.2 mm` | `1.214x` | kept, byte-identical hashes (`directional-success`) |

The five Compact-satisfied constrained cases are unchanged. The Shapes-17
fallback chain is recorded in full: the vetoed pair fold yields the terminal
flow to the next-fit shelf, whose `1,962.547 x 311.682 mm` envelope (`2.175x`,
density `0.344`) is vetoed as well, and the contact strip stays rejected on the
pre-existing density floor.

## Alternatives considered and rejected

- Relaxing the `>= 80%` short-edge fill floor: re-opens the user-directed
  correction that produced the floor; roomy dense layouts would again count as
  directional success at `24-46%` fill.
- Contact/hull no-regression terms against production: kills the Mixed-61
  flagship strip (`1,279 mm` vs `2,371 mm` shared boundary, `28` vs `7`
  isolated pieces), which is the showcase short-side result; area alone
  separates every measured dishonest winner from every good one.
- Threshold `5/4`: sits inside the same valid interval `[1.214, 1.487)` and
  reproduces the same case outcomes; `4/3` was preferred normatively (the
  sibling retains at least three quarters of the production density).
  Threshold `3/2`: keeps the Shapes-17 pair fold, which leaks a third of the
  production density.
- Promoting the interleaved contact strip on Triangle-20 roomy (`924.666 mm`
  span, `46.2%` fill, envelope smaller than Compact's): requires breaking the
  fill floor; Compact fallback is the honest answer there.
- Stretching `short-side-satisfied-by-compact` to low-fill vetoes: rejected in
  review (F2); the distinct `short-side-quality-protected-compact-fallback`
  outcome keeps the established `>= 80%` fill meaning intact.

## Cost

Observer overhead is two BigInt cross-multiplications per admission evaluation
plus one boolean per construction; measured terminal-observer runtimes stayed
in their previous sub-second envelope (probe: `99 ms` Triangle-20, `744 ms`
Mixed-61, `268 ms` Shapes-17 roomy). End-to-end per-case matrix elapsed times
moved only within machine noise. Compact runtime is untouched: the guard reads
only scalars already computed for the short-side stages.

## Open questions

- Whether a future interleaving-capable directional construction (an exact
  pairwise-NFP zigzag shelf) can win fill and density simultaneously on
  mid-width sheets where the Compact block already fills `60-80%` of the edge;
  such a construction would still have to pass the same area-cost guard.
- The capacity gate (`gate:capacity`) failed `minimumPlacedCount` on this host
  during this work on BOTH the pristine main checkout and the worktree, with
  different failing cases per run; it does not exercise the short-side path.
  Tracked as host-load sensitivity, not as a regression of this change.
