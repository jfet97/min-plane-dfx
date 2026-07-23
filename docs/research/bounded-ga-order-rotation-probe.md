# Bounded GA order and rotation probe

## Status

This experiment is complete and intentionally remains isolated. It changes no
production scorer, decoder, UI setting, or worker behavior.

The result is a negative production decision with one useful positive signal:

- do not enable the existing GA to compensate for the current sheet-dependent
  ranking;
- retain GA as a possible bounded second-stage optimizer after an intrinsic
  whole-path comparator is accepted;
- order and transform search can materially improve homogeneous rectangles, but
  the current winner comparator can also select layouts with larger envelopes
  and more holes.

## Question

Can the existing optional portfolio search make the current deterministic beam
sheet-independent without changing placement generation or scoring?

The probe deliberately limited GA freedom to the model used by Deepnest and
SVGnest at the outer level:

- mutate piece priority/order;
- mutate transform preferences;
- do not mutate the placement policy;
- disable local repair;
- always retain the deterministic beam result as a candidate.

## Reproducible implementation

- base commit: `be19e75c090c201191b5dd3ee9b4b99d3798fa8a`
- frozen harness commit: `9eea5761fa97b940f391e7bc80eb16c99055b55e`
- branch: `bounded-ga-order-rotation`
- harness: `scripts/irregular-bounded-ga-probe.ts`
- runtime: Electron Node `20.18.3`, V8 from Electron 33, pnpm `11.8.0`

The experiment was run from the frozen harness commit. A separate immutable
provenance manifest records the exact commands and report hashes. The portable
reference images below are copies of the hashed experiment artifacts.

## Fixed settings

| Setting | Value |
| --- | ---: |
| Reorder window | 4 |
| Beam width | 8 |
| Local candidate fanout | 4 |
| Transform cap | 8 |
| Local repair budget | 0 |
| Placement policy | Edge contact, then compactness |
| GA population | 4 |
| GA generations | 1 |
| GA evaluations | 4 |
| GA time budget | 60 seconds after baseline |
| GA seed | `bounded-order-transform-v1` |

The matrix used five fixtures on four sheets: the 20-triangle golden geometry,
20 equal rectangles, 20 equal trapezoids, mixed50, and the persisted exact
mixed61 request; sheets were `1000x1300`, `1000x1700`, `2000x1700`, and
`2000x2700`.

The normal triangle golden test, including its production repair setting,
passed separately. In the GA matrix the same triangle fixture was intentionally
run with repair disabled so GA could not receive credit for repair work.

## Results

Negative area change means GA used a smaller collision-bounds envelope.

| Fixture | Sheet | Baseline area | GA area | Area change | Holes | Runtime multiplier | Selected source |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| Triangles 20 | 1000x1300 | 80,174 | 80,174 | 0.00% | 0 -> 0 | 5.36x | equal GA chromosome |
| Triangles 20 | 1000x1700 | 80,174 | 80,174 | 0.00% | 0 -> 0 | 5.73x | equal GA chromosome |
| Triangles 20 | 2000x1700 | 73,493 | 73,493 | 0.00% | 0 -> 0 | 6.42x | equal GA chromosome |
| Triangles 20 | 2000x2700 | 100,218 | 100,218 | 0.00% | 0 -> 0 | 5.98x | equal GA chromosome |
| Rectangles 20 | 1000x1300 | 439,304 | 439,304 | 0.00% | 0 -> 0 | 5.86x | GA |
| Rectangles 20 | 1000x1700 | 539,325 | 469,705 | -12.91% | 0 -> 0 | 5.64x | GA |
| Rectangles 20 | 2000x1700 | 508,331 | 439,304 | -13.58% | 0 -> 0 | 5.67x | GA |
| Rectangles 20 | 2000x2700 | 439,304 | 403,178 | -8.22% | 0 -> 0 | 5.51x | GA |
| Trapezoids 20 | 1000x1300 | 299,295 | 299,295 | 0.00% | 0 -> 0 | 5.37x | equal GA chromosome |
| Trapezoids 20 | 1000x1700 | 299,295 | 299,295 | 0.00% | 0 -> 0 | 5.17x | equal GA chromosome |
| Trapezoids 20 | 2000x2700 | 233,380 | 233,380 | 0.00% | 0 -> 0 | 5.13x | equal GA chromosome |
| Mixed 50 | 1000x1300 | 751,462 | 619,571 | -17.55% | 3 -> 10 | 5.65x | GA |
| Mixed 50 | 1000x1700 | 593,512 | 593,512 | 0.00% | 10 -> 10 | 5.64x | beam |
| Mixed 50 | 2000x1700 | 632,290 | 659,547 | +4.31% | 10 -> 10 | 5.64x | GA |
| Mixed 50 | 2000x2700 | 623,249 | 618,038 | -0.84% | 10 -> 10 | 5.37x | GA |
| Mixed 61 | 1000x1300 | 701,017 | 701,017 | 0.00% | 1 -> 1 | 4.81x | beam |
| Mixed 61 | 1000x1700 | 713,249 | 713,249 | 0.00% | 0 -> 0 | 4.68x | beam |
| Mixed 61 | 2000x1700 | 642,864 | 642,864 | 0.00% | 6 -> 6 | 4.32x | beam |
| Mixed 61 | 2000x2700 | 436,790 | 513,154 | +17.48% | 2 -> 5 | 5.01x | GA |

The `2000x1700` trapezoid run failed identically with and without GA:
`segment intersection arithmetic must produce finite coordinates.` This is a
separate deterministic geometry defect, not a GA result.

## Canonical evidence

GA did not converge different sheets to one geometry. Examples:

- triangle hashes remained three different layouts across the four sheets:
  `3267a68b4f59a6209f70e45e67a7ffe614b4648798c9e21160409c4639e266d8`,
  `c82fe9fb4eb0bda48e78563e8b066a19e8e35e131b055ed105f66788c857a65d`,
  and `b1f48443ff09aee65f783c3e2a436ada75516ffb69d6cd0cb36dc6d42414ed05`;
- mixed61 remained four different layouts and GA changed only the
  `2000x2700` result, from
  `b00c96402d0687a6190c7f724a118363a38d99faed533515594e20da9ecf9c51`
  to
  `9dd0c32e4fead7cb949e073ee212b652ffa08eeb6b5a5b1d07a094001c9904f7`.

## Visual evidence

The PNGs were rendered from the exact SVGs through the repository Electron
renderer and checked for complete margins and cropping.

### Triangle fixture with repair disabled

[SVG](../artifacts/bounded-ga-order-rotation/triangle-no-repair-baseline.svg) ·
[PNG](../artifacts/bounded-ga-order-rotation/triangle-no-repair-baseline.png)

GA reproduced this geometry unchanged. It is not the accepted repaired golden
lattice.

### Homogeneous rectangle improvement

[Baseline SVG](../artifacts/bounded-ga-order-rotation/rectangles-baseline.svg) ·
[Baseline PNG](../artifacts/bounded-ga-order-rotation/rectangles-baseline.png) ·
[GA SVG](../artifacts/bounded-ga-order-rotation/rectangles-ga.svg) ·
[GA PNG](../artifacts/bounded-ga-order-rotation/rectangles-ga.png)

This is the useful positive signal: priority and transform search can improve a
well-behaved homogeneous fixture without holes.

### Mixed50 tradeoff

[Baseline SVG](../artifacts/bounded-ga-order-rotation/mixed50-baseline.svg) ·
[Baseline PNG](../artifacts/bounded-ga-order-rotation/mixed50-baseline.png) ·
[GA SVG](../artifacts/bounded-ga-order-rotation/mixed50-ga.svg) ·
[GA PNG](../artifacts/bounded-ga-order-rotation/mixed50-ga.png)

The GA result has a smaller outer envelope on `1000x1300`, but the measured
free-material hole count rises from 3 to 10. It demonstrates more search, not a
generally better objective.

### Mixed61 comparator regression

[Baseline SVG](../artifacts/bounded-ga-order-rotation/mixed61-baseline.svg) ·
[Baseline PNG](../artifacts/bounded-ga-order-rotation/mixed61-baseline.png) ·
[GA SVG](../artifacts/bounded-ga-order-rotation/mixed61-ga.svg) ·
[GA PNG](../artifacts/bounded-ga-order-rotation/mixed61-ga.png)

On `2000x2700`, the retained deterministic baseline is visibly tighter. The GA
winner is 17.48% larger by envelope area and has three additional holes. This
proves the current comparator can prefer a worse intrinsic layout even when the
better baseline is explicitly present.

## Interpretation against open-source nesters

The open-source research remains directionally correct, but sequencing matters.
Deepnest and SVGnest use GA to explore order and rotation around a deterministic
decoder whose placement objective already represents the desired material
usage. They do not use GA to repair a decoder objective that changes meaning
with sheet dimensions.

The existing min-plane-dfx GA behaved consistently with that model:

- it found useful order/transform variants for rectangles;
- it could not recover branches already pruned by the sheet-normalized local
  comparator;
- it amplified the current scorer's preference when that preference disagreed
  with intrinsic envelope compactness and hole quality;
- even the smallest useful budget cost roughly 4.3x to 6.4x baseline runtime.

## Verdict

### Before intrinsic full-path ranking

Reject GA as the sheet-invariance solution. It does not make geometry invariant,
does not recover the no-repair triangle lattice, and can select a strictly larger
mixed61 result. Enabling it now would spend much more time searching the wrong
objective more thoroughly.

### After intrinsic full-path ranking

Keep the experiment available, but do not claim a result yet. There was no
accepted intrinsic local-plus-global ranking at the frozen base commit, so an
"after" run would require combining two unaccepted hypotheses and would not be
an attributable experiment.

Once intrinsic ranking passes the triangle golden and sheet-invariance corpus,
rerun exactly this bounded probe. Acceptance should require all of the following:

1. the deterministic baseline remains an explicit candidate;
2. GA cannot increase intrinsic envelope area or hole count at final selection;
3. the same fixture on larger legal sheets retains the same canonical geometry;
4. order/transform-only GA produces a material improvement on at least one mixed
   gate, not only homogeneous rectangles;
5. the measured runtime budget is acceptable.

This preserves the useful idea from Deepnest/SVGnest without mistaking broader
search for a scoring fix.
