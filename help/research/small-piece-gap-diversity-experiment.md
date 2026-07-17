# Small-piece gap-diversity experiment

This report preserves a bounded research result. The protected front-8
candidate is not a production recommendation and its implementation was not
merged. It shows that earlier access to a small-piece cohort can close some
mixed-job cavities, but it also shows why hole count cannot be optimized without
intrinsic envelope guards.

## Provenance

- base commit: `aa7a264d4bc8ee99f6e5e9d890246e87e82b5db5`
- front-8 standalone commit: `02c712ea813875c5751f245b171e56835efa5677`
- front-16 standalone commit: `b3b56e5dbeee8b7d45ec32440b8461a4b7b630d9`
- front-4 standalone commit: `abe664ecc730a6c4dd0d4bb68a9d72be46a079d8`
- protected front-8 commit: `94cb35cafc874a090dfbc81f1c45ea1e16a21318`
- rejected tail-cohort commit: `69ca2052b5b2116c8d86b9baf1f1757542d54229`
- tail-cohort revert: `28751468a29873a52c792d9f0aa4f5de5a7e788c`
- fixture: `tests/fixtures/irregularSheetInvariance/mixed61-request.json`
- runtime: Node `v24.16.0`, pnpm `11.8.0`, Electron `33.4.11`
- settings: rotations and mirroring enabled; reorder `4`; beam `8`; fanout
  `4`; transform cap `8`; edge-contact-then-compactness; local repair and GA
  disabled

The protected candidate passed the exact 20-triangle golden, 46 focused tests,
lint, typecheck, the worker build, and diff validation. All reported mixed-61
runs placed 61 of 61 pieces.

The portable artifact manifest is
[`manifest.json`](../artifacts/small-piece-gap-diversity/manifest.json).

## Baseline

| Sheet | Runtime | Envelope (mm) | Area (mm2) | Span (mm) | Holes |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1000 x 1700 | 15.349 s | 658.907 x 700.365 | 461475.664 | 1359.272 | 10 |
| 2000 x 2700 | 15.104 s | 658.907 x 662.870 | 436770.039 | 1321.778 | 10 |

## Standalone reorder probes

Each probe changed only deterministic initial access order. All three preserved
the triangle golden, but none was safe as a universal replacement.

| Candidate | Sheet | Area (mm2) | Span (mm) | Holes | Decision |
| --- | --- | ---: | ---: | ---: | --- |
| front 8 | 1000 x 1700 | 452880.472 | 1349.975 | 7 | promising |
| front 8 | 2000 x 2700 | 476062.133 | 1450.658 | 4 | reject standalone |
| front 4 | 1000 x 1700 | 562656.338 | 1517.158 | 9 | reject |
| front 4 | 2000 x 2700 | 525709.454 | 1462.082 | 7 | reject |
| front 16 | 1000 x 1700 | 1037786.771 | 2062.703 | 1 | reject |
| front 16 | 2000 x 2700 | 664182.002 | 1633.479 | 0 | reject |

Front 16 is the clearest warning: one or zero holes accompanied a catastrophic
envelope expansion. Fewer detected holes do not imply a denser layout.

The later tail-cohort rule advanced the smallest `2 * reorderWindow` pieces
after 75% of the large-first head. It used no shape identity and also preserved
the triangle golden, but regressed both sheets:

| Sheet | Area (mm2) | Span (mm) | Holes | Decision |
| --- | ---: | ---: | ---: | --- |
| 1000 x 1700 | 527914.204 | 1459.411 | 4 | reject |
| 2000 x 2700 | 459135.085 | 1355.720 | 8 | reject |

That implementation was reverted. The result again shows that globally moving
small pieces earlier is too blunt: it can close local cavities while making the
whole envelope worse.

## Protected front-8 candidate

The protected candidate leaves the user-owned initial sort unchanged. For
heterogeneous jobs it runs the baseline decode and one front-8 alternative. The
alternative may win only when it:

1. places at least as many pieces;
2. strictly reduces the free-material hole count;
3. does not worsen intrinsic collision-bounds area;
4. does not worsen intrinsic collision-bounds span.

All-interchangeable jobs, including the 20-triangle golden, skip the second
decode.

| Sheet | Selected decode | Runtime | Area (mm2) | Span (mm) | Holes |
| --- | --- | ---: | ---: | ---: | ---: |
| 1000 x 1700 | front 8 | 31.995 s | 452880.472 | 1349.975 | 7 |
| 2000 x 2700 | baseline | 33.306 s | 436770.039 | 1321.778 | 10 |

On `1000 x 1700`, the protected result improves area by about `1.86%`, span by
about `0.68%`, and holes from `10` to `7`. On `2000 x 2700`, it retains the
baseline canonical geometry hash exactly. The cost is substantial: runtime
increases from roughly 15 seconds to 32-33 seconds, about `2.1-2.2x`, because
both full decodes run for heterogeneous jobs.

### Portable previews

- `1000 x 1700`: [SVG](../artifacts/small-piece-gap-diversity/mixed-61-1000x1700.svg) · [PNG](../artifacts/small-piece-gap-diversity/mixed-61-1000x1700.png)
- `2000 x 2700`: [SVG](../artifacts/small-piece-gap-diversity/mixed-61-2000x2700.svg) · [PNG](../artifacts/small-piece-gap-diversity/mixed-61-2000x2700.png)

The `1000 x 1700` preview is a modest improvement, not a solved packing. The
reference-sheet preview is deliberately the unchanged baseline.

## Recommendation

Preserve the protected front-8 mechanism as a research lead, but do not ship it
unchanged. It proves that a guarded secondary decode can expose useful small-
piece placements without sacrificing the triangle golden or the approved
reference-sheet result. Its quality gain is too small to justify doubling
runtime.

The next experiment should avoid a second complete decode. Reserve a bounded,
geometry-deduplicated small-piece or cavity-compatible survivor inside the
existing search only when a real bounded cavity exists, then let the intrinsic
whole-layout comparator decide. Retain area and span guards; hole count alone is
not a safe objective.

As with Candidate L and L2, rejection for direct production use does not erase
research value. The exact commits, metrics, and portable artifacts remain valid
inputs for a later decoder or beam-diversity design that passes every production
gate.
