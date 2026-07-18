# Canonical Reference Decode Handoff

## Status

Production-candidate implementation on branch `canonical-reference-decode-handoff`.
The two-sheet mixed-61 smoke is green; four-sheet, corpus, and ten-sheet gates remain.

## Measured Premise

The real `2000 x 2700` mixed-61 decode produces the approved canonical collision
arrangement (`40f8ac9c0fb24073ac141b5fb667366af55df90c78c6cca21ff76703a4a7f300`,
`430344.918 mm2`, two holes, contacts `53/14`). Probe
`5b800b3` established that this exact integer-grid arrangement is legal on all
four original sheets even though requested-sheet search does not retain the
candidates needed to reproduce it. Comparator-only variants therefore cannot
close this gap.

## Candidate

Eligible scale-diverse, multi-family jobs run the unchanged requested-sheet portfolio and one protected
portfolio on a fixed `2000 x 2700` reference sheet. The outer coordinator never
recurses through `computeIrregularNesting` or through the portfolio. It prepares
pieces once, buffers each role's winning-path snapshots privately, suppresses
protected user progress, shares cancellation, and aggregates full-decode
instrumentation. A request already on the reference sheet performs one decode.
The collision-area ratio must be at least `4x` and at least two interchangeability
families must be present, so homogeneous jobs do not pay for the second decode.

The protected finalist is the exact legal terminal beam state. Only bottom-left
anchored q0 and q90 rigid orientations may be admitted, and their collision
polygons must fit the requested sheet with zero positive overlap on the canonical
`0.001 mm` grid. Requested-sheet free-material diagnostics are recomputed, while
the state's five contact metrics remain attached to the unchanged arrangement.

## Admission Guard

The following named values are protected-role slacks, not score weights:

- maximum max-side regression: `7.5%`;
- maximum total-contact loss: `4`;
- maximum dominant-contact loss: `3`.

The canonical role must also have no more unplaced pieces, strictly smaller
collision-bounds area, no more requested-sheet holes, no worse largest hull-gap
ratio, contact-component count, isolated count, or span, and no smaller largest
contact component. Non-finite topology and canonical identity ties retain
production.

## Geometry Boundary

`src/workers/irregular/canonicalLayoutGeometry.ts` owns integer-grid layout
identity, cavity/contact topology, sheet fit, and the zero-positive-overlap
assertion. The module canonicalizes translated collision polygons before boolean
or contact analysis, making its measurements invariant under translation and
rigid quarter-turns. Selection policy remains in `src/workers/algorithm/`.

## Focused Evidence

- canonical layout identity covers translation, quarter-turn, copy order, ring
  origin, winding, preserved reflection, and changed relative placement;
- canonical-grid legality covers q0, q90-only, unfit, exact-boundary, and positive
  overlap cases;
- admission covers `57/17 -> 53/14`, one-unit contact-slack overruns,
  fragmented low-gap candidates, and score ties;
- reference reuse, repair/GA/short-side-fill exclusion, existing portfolio tests,
  and the exact 20-triangle repair-8 golden remain green.

The post-`cea022a` two-sheet smoke produced the same canonical hash on both sheets:

```text
canonical hash: 40f8ac9c0fb24073ac141b5fb667366af55df90c78c6cca21ff76703a4a7f300
area:           430344.917527 mm2
holes:          2
contacts:       53 / 14
2000 x 1700:    about 89.5 s
2000 x 2700:    about 40.0 s
```

The renderer irregular timeout floor is therefore `120000 ms`, leaving headroom
over the measured protected pass without changing rectangular-worker defaults.

## Remaining Gate

Do not promote from this report alone. The two-sheet smoke confirmed the canonical
hash and approved quality metrics. Run the four-sheet, corpus, and ten-sheet gates,
including selected-role history, role diagnostics, runtime, and aggregated decode
counts, before merging.
