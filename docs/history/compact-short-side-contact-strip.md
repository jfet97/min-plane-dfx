# Compact Short-Side Contact Strip Stage 8

Date: 2026-07-25

## Why the previous result was rejected

The `9027aa6` matrix passed every numeric gate. The user rejected its Mixed-61
`2000 x 2700` short-side layout on sight, describing repeated empty spaces,
pentagons that should have faced downward, and small rectangles left at row ends
that would have fitted the voids. The stated requirement was to keep Compact's
compactness and add the short-edge fill requirement on top of it.

Commit `9193f26`, the generic stable-baseline shelf tie-break, is reverted. It
resolved equal-envelope transforms by the longest exact horizontal support on the
row baseline, before any row or neighbour context existed, so it flipped whole
asymmetric families onto flat bases. It preserved all 18 matrix envelopes, every
production Compact hash, fill, density, and exact legality while worsening the
occupied-hull gap from `0.4325051759018452` to `0.43256001182424386`.

That is the standing evidence that unchanged envelopes are not promotion
evidence, and that visual review has to be a first-class gate.

## Diagnosis

The failure is structural, not a tie-break bug.

`constructNextFitShelf` advances a cursor by each piece's AABB width and opens a
new row at the tallest bounding box of the closed row. Neither decision reads
polygon geometry, so no piece can enter a neighbour's concavity. All three roomy
fixtures therefore sit near `50%` collision-envelope density against production
Compact's `80.05%`. Triangle-20 is the extreme case: `20` isolated pieces, a
largest positive-contact component of `1`, and `0 mm` of shared boundary.

The proposed row-tail backfill was evaluated and not implemented. Retaining
closed-row rectangular tails and probing later pieces into them only relocates
the trailing rectangles. The photographed voids are interior to the rows, above
flat-bottomed pieces, and no tail rule reaches them.

## Decision

Replace the mechanism instead of its tie-break.

One exact contact-driven directional strip reuses production Compact's
`NfpIfpService.generatePlacementCandidates` and canonical grid legality. In
normalized directional coordinates, where `x` is the requested short axis and `y`
is the requested long axis, each prepared piece is placed once, in prepared
order, at the legal candidate whose occupied grid anchor is lexicographically
smallest in `(y, x)`.

Interlocking emerges from exact contact rather than from any shape rule: an
inverted triangle advances the frontier less than an upright one, so the
comparator selects it. There is no beam, reordering, repair, restart, new
geometry kernel, or fixture-specific branch, and the pass stays single-process
and sequential.

## Promotion rule

The strip replaces the historical pair fold or shelf only when it regresses none
of short-edge fill, envelope area, long-axis depth, collision-envelope density,
occupied-hull gap, isolated-piece count, positive-contact component count, or
largest positive-contact component size, and strictly improves at least one.
Rejected strips remain in the trace with their measurements. This promotion is
benchmark-side only; no worker or UI path enables the sibling profile.

## Results

Mixed-61 `2000 x 2700` is promoted.

| Measurement | Multi-row shelf | Contact strip |
| --- | ---: | ---: |
| bounds | `1987.776 x 301.187 mm` | `2000.000 x 207.700 mm` |
| envelope area | `598,692.290112 mm2` | `415,400.000000 mm2` |
| long-axis depth | `301.187 mm` | `207.700 mm` |
| short-edge fill | `99.3888%` | `100.0000%` |
| collision-envelope density | `52.3621%` | `75.4664%` |
| occupied-hull gap | `0.4325051759018452` | `0.2150884212578726` |
| isolated pieces | `39` | `28` |
| largest contact component | `8` | `12` |
| shared boundary | `0 mm` | `1356.501 mm` |
| pieces / cavities | `61/61`, `0` | `61/61`, `0` |

Triangle-20 and Shapes-17 keep their historical sources. Their strips are
constructed, measured, and rejected: the Triangle strip is far more compact but
fills only `46.2333%` of the short edge, and the Shapes strip regresses density
and occupied-hull gap.

The alternative comparator that orders by lowest resulting long-axis extent
improved those two fixtures and regressed the targeted Mixed-61 depth from
`207.700 mm` to `221.043 mm`. It was measured and not adopted.

## Accepted cost of the revert

The revert changes Triangle-20 `2000 x 2700` from an upright row to an inverted
row. Canonical collision identity, fitted hash, `1765.760 x 75.675 mm` envelope,
`88.288%` fill, `50%` density, `20` isolated pieces, and the largest contact
component of `1` are all unchanged. Its occupied-hull gap moves from
`0.02564102564102564` to `0.48717948717948717` because the same wasted area
becomes one connected band instead of `19` separate notches.

This is accepted rather than hidden. Both layouts have zero interlocking, so the
hull-gap difference is a connectivity artifact, not a packing change. It is also
the clearest available proof that occupied-hull gap must never be read as a
standalone quality score.

## Budgets

The terminal observer budget moves from `500 ms` to `30,000 ms` and its sampled
RSS ceiling from `64 MiB` to `512 MiB`, because the observer now performs a real
exact construction instead of a fixed-transform accounting pass. The strip may
use at most `20,000 ms` and `256 MiB`, but only from the outer observer's
remaining allowance. Both phases share the clock and RSS sampler, and the final
composite trace is checked against the common `1 MiB` cap. The largest measured
case, Mixed-61, uses `1,005.6 ms` and `5,636,096 bytes` inside the coordinator.

## Evidence

- [`../research/compact-short-side-observer.md`](../research/compact-short-side-observer.md)
- [`../artifacts/compact-short-side-observer/contact-strip/README.md`](../artifacts/compact-short-side-observer/contact-strip/README.md)
- [`../artifacts/compact-short-side-observer/rejected-stable-baseline/README.md`](../artifacts/compact-short-side-observer/rejected-stable-baseline/README.md)
