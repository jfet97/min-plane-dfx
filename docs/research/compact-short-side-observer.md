# Compact Short-Side Archive Observer

## Question

Can an alternative Compact profile aggressively reduce the requested long-axis
span while filling the requested short side, without reviving the historical
ordinary `short-side-fill` beam or contaminating production Compact?

The first experiment is deliberately smaller than a new search lane. It
observes every settled complete Compact archive endpoint at q0/q90, performs no
placement or candidate evaluation, and cannot change output.

## Exact observer contract

For every complete endpoint:

1. rigidly orient at q0 and q90 and require canonical exact sheet legality;
2. require the existing cavity and occupied-hull floors;
3. retain only the existing intrinsic geometric Pareto front;
4. minimize requested long-axis used span;
5. minimize requested short-axis shortfall;
6. apply intrinsic envelope/contact metrics and canonical identity.

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

The current-source promotion run at `63dd350` passed the full contract:

- 18/18 layouts passed exact piece accounting and rendering;
- all nine Compact collision and fitted hashes remained exact;
- four short-side outputs selected guarded Stage 1 archive winners;
- five short-side outputs recorded exact Compact fallbacks;
- the maximum observer runtime was `56.989 ms`;
- at most one algorithm process was active and all nine cases ran
  sequentially.

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

Stage 2 and Stage 3 tested two materially different ways to go beyond archive
reuse. Both were rejected under their predeclared stop rules, so Stage 1 is the
only promoted short-side mechanism.

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

## Evidence

- [`../artifacts/compact-short-side-observer/README.md`](../artifacts/compact-short-side-observer/README.md)
- [`../artifacts/compact-short-side-observer/matrix/summary.json`](../artifacts/compact-short-side-observer/matrix/summary.json)
- [`../artifacts/compact-short-side-observer/triangle-600x400-reproduction/triangle-20-600x400.short-side-observer.png`](../artifacts/compact-short-side-observer/triangle-600x400-reproduction/triangle-20-600x400.short-side-observer.png)
- [`../artifacts/compact-short-side-observer/triangle-600x400-reproduction/triangle-20-600x400.production.png`](../artifacts/compact-short-side-observer/triangle-600x400-reproduction/triangle-20-600x400.production.png)
- immutable rejected-pilot manifest:
  `/private/tmp/min-plane-provenance/short-side-projection-stage2-manifest.json`
- target-aware construction history:
  [`../history/compact-short-side-target-aware-construction.md`](../history/compact-short-side-target-aware-construction.md)
