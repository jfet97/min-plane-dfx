# Rejected Stable-Baseline Short-Side Experiment

This package records why commit `9193f26` is not accepted as Short Side
quality, even though commit `9027aa6` archived a numerically passing matrix.

## Comparison

Pre-tie-break control:

- [PNG](./mixed-61-before-stable-baseline.png)
- [SVG](./mixed-61-before-stable-baseline.svg)

Rejected stable-baseline result:

- [PNG](./mixed-61-after-stable-baseline.png)
- [SVG](./mixed-61-after-stable-baseline.svg)

Both layouts use all `61/61` pieces and have the same
`1987.776 x 301.187 mm` envelope, `598,692.290112 mm²` area, `99.3888%`
short-edge fill, and zero cavities. Equal AABB metrics concealed a visual and
structural regression.

The rejected comparator resolves equal-height/equal-width transforms by the
longest exact horizontal support on the row baseline. Because this decision is
made before a row or neighbour exists, it globally flips asymmetric families.
The resulting layout contains systematic triangular voids above
pentagons/trapezoids and leaves later small rectangles at row ends instead of
using earlier available tails.

The occupied-hull gap also worsens:

- control: `0.4325051759018452`;
- rejected result: `0.43256001182424386`.

## Sol xhigh review findings

The retained review reached these conclusions after receiving the user’s
visual evidence:

1. Directional-success versus Compact-satisfaction classification remains
   correct.
2. The terminal shelf is still deterministic, exact, sequential, bounded, and
   output-neutral.
3. The promotion gate is incomplete because equal envelope, density, fill,
   legality, and unchanged production hashes did not detect degraded
   interlocking.
4. The global stable-baseline comparator and its test should be reverted.
5. A possible smallest experiment is deterministic earlier-row-tail backfill:
   retain the pre-tie-break transforms and prepared order, remember each
   closed row’s rectangular tail, and probe later pieces into those tails
   before opening a new row.
6. That row-tail proposal is only a hypothesis. It does not justify a beam,
   general search, contextual orientation rule, or promotion without a strict
   measurable win.

The suggested row-tail experiment must be independently challenged. The
product requirement may instead require a protected directional Compact
construction cohort that reuses exact NFP/contact search while treating
short-edge coverage as a protected directional objective.

## Required correction and next decision

Treat the stable-baseline state as rejected, not production-quality evidence.
Before implementing a replacement, compare:

- clean revert plus bounded row-tail backfill;
- contextual row/neighbor-aware orientation;
- a protected directional Compact construction cohort;
- warm target-envelope continuation from existing Compact states.

No replacement may be shape-specific, concurrent, nondeterministic, or allowed
to alter production Compact hashes.
