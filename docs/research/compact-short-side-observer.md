# Compact Short-Side Archive Observer

## Question

Can an alternative Compact profile substantially fill the requested short
axis while remaining compact along the requested long axis, without reviving the historical
ordinary `short-side-fill` beam or contaminating production Compact?

The first experiment is deliberately smaller than a new search lane. It
observes every settled complete Compact archive endpoint at q0/q90, performs no
placement or candidate evaluation, and cannot change output.

## Exact observer contract

For every complete endpoint:

1. rigidly orient at q0 and q90 and require canonical exact sheet legality;
2. require the existing cavity and occupied-hull floors;
3. retain only the existing intrinsic geometric Pareto front;
4. minimize requested short-axis shortfall;
5. minimize requested long-axis used span;
6. apply intrinsic envelope/contact metrics and canonical identity.

Version 3 only materializes that ranked endpoint when it fills at least `80%`
of the short axis, closes at least half the production Compact shortfall, and
uses no more long-axis depth than production Compact's maximum side. Square
sheets have no directional winner. A legal ranked archive endpoint that misses
these materiality gates remains visible in telemetry but produces an explicit
Compact fallback.

The observer is censored without a winner if runtime exceeds `250 ms` or the
serialized trace exceeds `1 MiB`. Complete misses and exact preflight
impossibility report explicit zero-work states. Production Compact and capacity
selection remain unchanged.

## Rejected first measurement

Commit `058c973` treated hull and cohesion terms as tie-breakers. Triangle-20 on
`2000 x 2700` therefore selected a `1513.5 x 88.288 mm` strip with `0.5` hull
gap and `133,623.888 mm2` envelope instead of the production
`487.983 x 152.522 mm`, `0.0297` hull-gap, `74,428.143126 mm2` endpoint.

That was a wasteful false positive. It triggered the hard eligibility and
Pareto-front correction in `dfb458f`; it is not evidence for target-aware
search.

## Accepted Stage 1 evidence

At `a9504d30d8bb69a78d8e7b26afe14aa9b04d0c6d`:

- the strict nine-case matrix preserves every production collision/fitted hash,
  placed/unplaced count, exact partition, cavity gate, and scheduler chronology;
- observer work remains zero placement and zero candidate evaluations;
- maximum measured observer runtime is `57.548333 ms`;
- every trace is below `1 MiB`;
- Mixed-61 `600 x 400` reports the exact zero-work complete-miss fallback;
- Shapes-17 `2000 x 2700` and `2700 x 2000` select the same canonical endpoint
  and swap q0/q90 exactly.

The promotion gate materializes two layouts for each case: nine unchanged
Compact controls and nine short-side-profile outputs. A guarded Stage 1 winner
is used when one exists; otherwise the short-side profile is the exact Compact
fallback with explicit provenance. This makes the archive a complete
18-layout contract without claiming that all 18 geometries are distinct.

The current-source promotion run at `1cd5ac7` passed the full contract:

- 18/18 layouts passed exact piece accounting and rendering;
- all nine Compact collision and fitted hashes remained exact;
- four short-side outputs selected guarded Stage 1 archive winners;
- five short-side outputs recorded exact Compact fallbacks;
- the maximum observer runtime was `57.984 ms`;
- at most one algorithm process was active and all nine cases ran
  sequentially.

The first promotion review corrected the trace to
`intrinsic-short-side-observer-v2`. Version 3 then corrected the profile's
meaning: after legality it ranks short-axis fill before long-axis depth and
requires a material improvement over production. This prevents a merely thin
cluster from being labelled short-side fill.

Triangle-20 `600 x 400` contains one reproducible, guard-eligible Pareto
alternative:

| Metric | Production Compact | Short-side observer |
| --- | ---: | ---: |
| used width | `487.983 mm` | `228.786 mm` |
| used height | `152.522 mm` | `394.922 mm` |
| requested long-axis reduction | — | `53.116%` |
| requested short-side fill | `38.131%` | `98.731%` |
| envelope area | `74,428.143126 mm2` | `90,352.624692 mm2` |
| area change | — | `+21.396%` |
| hull gap | `0.029711` | `0.086902` |

The winner, orientation, ranking, and endpoint observations reproduce exactly
across two sequential runs. This is a genuine sibling-profile tradeoff, not a
production Compact improvement.

## Conclusion

Stage 1 proves that settled archive reuse can sometimes provide the requested
directional behavior for almost no extra cost. It also proves that raw
long-axis minimization is unsafe without geometric admissibility.

Stages 2 through 5 tested four materially different ways to go beyond archive
reuse. The fixed-target repair, two construction beams, and exact one-row shelf
were rejected under their predeclared stop rules. A final narrower terminal
pair-fold observer succeeded for Shapes-17 without changing production Compact
or restarting construction.

## Stage 2 fixed-target result

The smallest fixed-target experiment was implemented at `2fcd44d` and
calibrated at `8f66399`. It used:

- the immutable Stage 1 guarded Pareto winner;
- exact collision-area and singleton lower bounds in canonical `bigint` grid
  units;
- the requested short side and one midpoint between the lower bound and
  witnessed upper bound;
- one catalog-compatible inverse-axis q90 projection;
- exact candidate/checkpoint accounting and hard runtime, candidate, sampled
  memory, trace, and dilation budgets;
- zero production-output authority.

The first committed run exposed a measurement mistake rather than a search
result: a `25,000` cooperative-checkpoint cap fired after only `73.898 ms` and
`133` scored candidates because NFP service checkpoints are deliberately
fine-grained. That censored v1 report is retained. Review required checkpoints
to remain exact accounting but not termination authority; the trace was bumped
to v2 before one identical-target rerun.

The v2 Triangle-20 `600 x 400` rerun settled normally in `330.309 ms`:

| Measurement | Value |
| --- | ---: |
| target in projection axes | `400 x 197.907 mm` |
| exact lower bound | `167.029 mm` |
| witnessed upper bound | `228.786 mm` |
| scored candidates | `1,281` |
| cooperative checkpoints | `86,784` |
| dilation attempts | `17` |
| sampled RSS delta | `2,899,968 bytes` |
| trace size | `4,289 bytes` |

Exact projection exhausted its complete closure at `triangle-copy-17`; it
produced no endpoint. Production collision and fitted hashes, exact partition,
area, cavities, scheduler chronology, and observer contracts all remained
unchanged.

This falsifies the single midpoint projection as the next promotable mechanism.
It does not falsify target-aware construction generally. Per the predeclared
stop contract, no target sweep, second seed, or matrix run followed. The free
Stage 1 archive observer remains the accepted sibling-profile result.

## Stage 3 target-aware construction result

A separately reviewed width-one construction pilot was committed at `e19ddf1`.
It ran a matched `legacy-absolute-envelope` control followed by one directional
arm, sequentially in one process after production settlement. Both used the
same prepared order, strict sheetless candidate seam, transform domain, fresh
memo scope, and independently configured limits.

Triangle-20 `600 x 400` constructed all pieces in both arms. The directional
arm used `271.256 x 380.723 mm`, `103,273.398088 mm2`, and a `0.288475`
occupied-hull gap after `2,980` candidate evaluations and a measured
`1,300.750 ms`. It fails the existing `0.15` hull-gap floor, so it is a raw
completed diagnostic rather than an admissible sibling endpoint.

That is worse than the free Stage 1 winner on every directional admission
measure: Stage 1 uses `228.786 x 394.922 mm`, `90,352.624692 mm2`, and a
`0.086902` hull-gap ratio. Production hashes remained exact.

The predeclared stop rule therefore rejected the greedy target-aware selector.
No reproduction or matrix run followed. This sharpens the conclusion: for the
measured Triangle case, Stage 1 is not merely cheaper; its existing archive
alternative is materially better than this new construction path.

Post-run review additionally found incomplete finalization coverage in the
runtime, sampled-RSS, and self-sized trace accounting, plus disabled-path state
retention in the strict constructor. These do not weaken the rejection, but
they prevent budget-passing claims. Commit `edeed42` removes the rejected
implementation while its committed provenance remains available.

## Stage 4 protected width-four band result

Commit `1163bd3` tested a separate observer-only width-four construction beam
on Shapes-17 `2000 x 2700`. It retained deterministic fill, depth, projection,
and intrinsic roles, used exact legality and canonical deduplication, and ran
strictly sequentially after production. Hard limits were `20,000` candidate
evaluations, `5,000 ms`, `256 MiB` sampled RSS delta, and a `1 MiB` trace.

The lane reached only five of seventeen depths before the deadline:

| Measurement | Value |
| --- | ---: |
| runtime | `5,000.534 ms` |
| candidate evaluations | `6,118` |
| deepest completed depth | `5/17` |
| best retained short-axis span | `402.892 mm` |
| required admission span | `1,600 mm` |
| sampled RSS delta | `557,056 bytes` |
| trace size | `1,685 bytes` |

It produced no endpoint and had zero output influence. The existing Compact
geometry remained the honest fallback. This is not close enough to justify a
second reproduction, a matrix expansion, a higher cap, or a narrower variant
of the same greedy construction hypothesis. The implementation and its
observer-only enumeration seam were removed; immutable failure provenance
remains under
`/private/tmp/min-plane-provenance/short-side-band-1163bd3-run1/`.

## Stage 5 exact one-row shelf result

Commit `999e9fb` selected each prepared piece's exact minimum-width transform
once and attempted one rigid, search-free row along the requested short edge.
On Shapes-17 `2000 x 2700`, all `136` transform candidates were evaluated in
`3.451 ms`, but the row required `2007.195 mm`: `7.195 mm` more than the
physical short edge. The pilot therefore produced no endpoint and stopped
without a matrix run or transform reselection.

Immutable evidence remains under:

- `/private/tmp/min-plane-provenance/short-side-shelf-999e9fb-run1/`;
- `/private/tmp/min-plane-provenance/short-side-shelf-999e9fb-diagnostic/`.

## Stage 6 exact terminal pair fold

Corrected source commit `2645e7c` retained the Stage 5 fixed transforms and
tested the smallest possible generic relaxation: enumerate every unordered pair once and stack
exactly one pair at the first member's row position. The lower prepared index
is bottom, the higher index is upper, and all other pieces remain in their
original one-row order. There is no transform reselection, NFP search, beam,
row wrapping, second fold, or iterative repair.

Two independent Shapes-17 `2000 x 2700` runs and one `2700 x 2000` transpose
selected the same pair and canonical geometry:

| Measurement | Value |
| --- | ---: |
| fixed-transform evaluations | `136` |
| expected/evaluated pairs | `136/136` |
| selected pair | `shapes-17-1` + `shapes-17-10` |
| short-axis span | `1897.173 mm` |
| requested short-axis fill | `94.85865%` |
| long-axis depth | `220.526 mm` |
| envelope area | `418,375.972998 mm2` |
| collision-envelope density | `50.2790%` |
| enclosed cavities | `0` |
| observer runtime | `6.834 ms`, `6.865 ms` |
| canonical hash | `4dd34dcee54caa79e1cc0dc3fc88b867ddfa15a98588dda1083e820cdb44c0bb` |

The transpose preserved the same intrinsic identity, pair, span, and depth
with the prescribed quarter turn. Admission additionally required exact
legality and piece accounting, at least `80%` short-axis fill, no more depth
than production Compact's maximum side, `99%` projection coverage in one
component, zero cavities, at least `50%` exact collision-envelope density, and
a short-axis gain factor no smaller than the envelope-area cost factor.

The current-source matrix at `2645e7c` passed all nine algorithm cases and all
18 rendered layouts sequentially in one process. Every production Compact
hash, placed/unplaced count, area ceiling, and cavity gate remained exact. The
short-side outputs now comprise one guarded Stage 1 winner, one terminal
pair-fold winner, and seven exact Compact fallbacks. When the pair observer
runs, measured overhead is `2.462–6.912 ms`; square sheets perform zero pair
work.

This is a user-directed, narrow exception to the earlier multi-family promotion
preference. It is accepted because it fixes the explicitly targeted Shapes
layout with a bounded shape-generic mechanism, complete exact matrix evidence,
and protected fallback semantics. It does not justify a second fold or a more
general shelf search.

## Stage 7 exact multi-row terminal shelf

The previous matrix exposed a semantic failure: seven files named
`short-side-profile` were legal Compact fallbacks, and the gate counted them as
success even when roomy Triangle-20 and Mixed-61 occupied only `24.399%` and
`31.110%` of the requested short edge. Artifact validity was not directional
success.

Commit `d57b7d6` corrects both layers. After Stage 1 and the exact pair fold
miss, the terminal observer reuses the transform catalog evaluation to retain
one depth-minimizing transform per prepared piece and performs exactly one
prepared-order next-fit shelf. It creates AABB-separated rows, then passes the
ordinary canonical legality, q0/q90 fit, topology, density, projection, depth,
and area-cost admission. It performs no NFP search, beam search, or restart.

The strict current-source matrix produced:

| Fixture | Sheet | Source | Short-edge fill | Bounds |
| --- | --- | --- | ---: | ---: |
| Triangle-20 | `2000 x 2700` | multi-row shelf | `88.288%` | `1765.760 x 75.675 mm` |
| Mixed-61 | `2000 x 2700` | multi-row shelf | `99.389%` | `1987.776 x 301.187 mm` |
| Shapes-17 | `2000 x 2700` | pair fold | `94.859%` | `1897.173 x 220.526 mm` |
| Triangle-20 | `600 x 400` | archive winner | `98.731%` | `228.786 x 394.922 mm` |

The five remaining constrained or square Compact results already fill
`98.021–99.858%` of the relevant edge. They are explicitly classified as
`short-side-satisfied-by-compact`, not observer-generated winners. The matrix
requires nine satisfied profiles and zero `directional-miss` results.

Two clean Mixed-61 reproductions produced byte-identical SVG/PNG files and the
same canonical collision hash
`de6dff6d3b0745055d3cefc54d468b2fa6f5bb72ab4e0a1b749b70c7261f8918`.
The terminal work measured `11–13 ms`; all production Compact hashes, counts,
areas, cavities, and scheduler chronology remained exact. Every matrix PNG was
opened individually and recorded in `matrix/VISUAL_REVIEW.md`.

Commit `9193f26` adds one generic tie-break inside the shelf transform order:
after equal depth and width, prefer the longest exact horizontal support on the
row baseline. The full matrix retains the same 18 envelopes and all production
Compact hashes. Triangle-20 and Mixed-61 change only their shelf orientation
identities; their pointed pieces now rest on stable bases. Mixed-61 remains
`1987.776 x 301.187 mm`, while isolated pieces improve from `39` to `38` and
the largest positive-contact component grows from `8` to `11`. End-to-end
runtime was `68.971 s`, comparable with the preceding `68.721 s`
reproduction.

## Evidence

- [`../artifacts/compact-short-side-observer/README.md`](../artifacts/compact-short-side-observer/README.md)
- [`../artifacts/compact-short-side-observer/matrix/summary.json`](../artifacts/compact-short-side-observer/matrix/summary.json)
- [`../artifacts/compact-short-side-observer/matrix/shapes-17-2000x2700.short-side-profile.png`](../artifacts/compact-short-side-observer/matrix/shapes-17-2000x2700.short-side-profile.png)
- [`../artifacts/compact-short-side-observer/triangle-600x400-reproduction/triangle-20-600x400.short-side-observer.png`](../artifacts/compact-short-side-observer/triangle-600x400-reproduction/triangle-20-600x400.short-side-observer.png)
- [`../artifacts/compact-short-side-observer/triangle-600x400-reproduction/triangle-20-600x400.production.png`](../artifacts/compact-short-side-observer/triangle-600x400-reproduction/triangle-20-600x400.production.png)
- immutable rejected-pilot manifest:
  `/private/tmp/min-plane-provenance/short-side-projection-stage2-manifest.json`
- target-aware construction history:
  [`../history/compact-short-side-target-aware-construction.md`](../history/compact-short-side-target-aware-construction.md)
