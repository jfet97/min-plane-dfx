# Canonical Reference Decode Handoff

> Historical report, accepted on its named branch in July 2026 and retired by
> archive-only production commit `8b0fba4`. The fixed-reference coordinator,
> fixed `2000 x 2700` decode, admission flag, `120 s` timeout, and ten-sheet
> result below do not describe current production. See
> [`../history/sheet-invariance-decisions.md`](../history/sheet-invariance-decisions.md).

## Status

Accepted historical implementation on branch `canonical-reference-decode-handoff`.
The consolidated, review-hardened candidate is green across ten mixed-61 sheets
and all twelve non-mixed corpus lanes at its recorded commit. It closed the
then-current sheet-invariance gap with the approved collision geometry and was
subsequently replaced.

## Measured Premise

The real `2000 x 2700` mixed-61 decode produces the approved canonical collision
arrangement (`40f8ac9c0fb24073ac141b5fb667366af55df90c78c6cca21ff76703a4a7f300`,
`430344.918 mm2`, two holes, contacts `53/14`). Probe
`5b800b3` established that this exact integer-grid arrangement is legal on all
four original sheets even though requested-sheet search does not retain the
candidates needed to reproduce it. Comparator-only variants therefore cannot
close this gap.

## Candidate

Eligible scale-diverse, multi-family compact-quality jobs run the unchanged
requested-sheet portfolio and one protected portfolio on a fixed `2000 x 2700`
reference sheet. The outer coordinator never
recurses through `computeIrregularNesting` or through the portfolio. It prepares
pieces once, buffers each role's winning-path snapshots privately, publishes both
roles through one role-tagged progress stream, shares cancellation, and aggregates
full-decode instrumentation. A request already on the reference sheet performs
one decode and reuses that result unconditionally; the intrinsic certificate
arbitrates only a distinct protected decode.
The collision-area ratio must be at least `4x` and at least two interchangeability
families must be present. The schema-owned `canonicalReferenceDecodeEnabled`
capability defaults to false and is enabled by the compact-quality factory only,
so homogeneous and ordinary deterministic jobs do not pay for the second decode.
The flagship `mixed61-request.json` fixture carries the same explicit opt-in so
the sheet-invariance corpus cannot silently fall back to one decode. That fixture
migration does not change its pieces, source geometry, sheet, padding, or any
pre-existing optimizer value.

The protected finalist is the exact legal terminal beam state. Only bottom-left
anchored q0 and q90 rigid orientations may be admitted, and their collision
polygons must fit the requested sheet with zero positive overlap on the canonical
`0.001 mm` grid. Requested-sheet free-material diagnostics are recomputed, while
the state's five contact metrics remain attached to the unchanged arrangement.

## Intrinsic Priority Certificate

After exact q0/q90 fit and overlap checks, a complete canonical finalist has
priority when its sheet-free certificate satisfies every bound:

- exact occupied-union enclosed cavities: at most `2`;
- largest occupied-hull gap ratio: at most `0.15`;
- occupied-envelope aspect ratio: at most `1.5`;
- isolated pieces: at most `2`;
- largest positive-contact component: at least `0.5` of all pieces.

All certificate and required score values must be finite and unplaced count must
be zero. q0 is tried before q90. A canonical identity tie, incomplete decode,
undefined topology, non-finite value, or failed bound retains production. This is
deliberately a safe, over-strict fallback: the constants are anchored on the
approved mixed-61 motif, not presented as universal nesting-quality thresholds.

This policy retires the production-relative max-side and contact-loss slacks.
Envelope aspect replaces max side as the anti-chain guard; occupied-hull gap and
exact union cavities bound open chains and holes; isolation and largest-component
ratio require contact cohesion. Once that intrinsic certificate passes, selection
deliberately accepts requested-sheet remnant and raw-contact tradeoffs instead of
letting a sheet-relative production score veto the same legal collision geometry.

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
- intrinsic priority covers every certificate boundary, incomplete and non-finite
  candidates, identity ties, uncertified fallback, and q0-first orientation;
- reference reuse, repair/GA/short-side-fill exclusion, existing portfolio tests,
  and the exact 20-triangle repair-8 golden remain green.

The final `5186255` candidate produced the same approved result on ten
mixed-61 sheets:

```text
canonical hash: 40f8ac9c0fb24073ac141b5fb667366af55df90c78c6cca21ff76703a4a7f300
area:           430344.917527 mm2
holes:          2
contacts:       53 / 14
all ten:         exact hash and metrics above
```

The sheets were `900 x 1800`, `1000 x 1300`, `1000 x 1700`, `1100 x 1100`,
`1200 x 1600`, `1400 x 1100`, `1500 x 2200`, `1700 x 1000`, `2000 x 1700`,
and `2000 x 2700`. Every run placed all 61 pieces. The intrinsic topology was
also identical: two enclosed cavities, hull-gap ratio `0.119130`, envelope
aspect `1.446116`, two isolated pieces, and a largest positive-contact component
of 53 pieces (`0.868852`). Measured runtimes were `70.4-89.3 s` off the
reference sheet and `40.1 s` on `2000 x 2700`.

All twelve non-mixed corpus lanes retained their exact baseline hashes and
metrics. The full suite was `564/566`; the two failures were the pre-existing
irregular benchmark failures reproduced on the base branch.

The final implementation review found and resolved complete score-summary schema
validation and all renderer timeout edit paths. Earlier review rounds also
hardened role lifecycle diagnostics, cancellation, q0/q90 legality, mixed-winding
cavity topology, identity ties, trace ownership, and certificate boundaries.

The renderer irregular timeout floor is therefore `120000 ms`, leaving headroom
over the measured protected pass without changing rectangular-worker defaults.

## Promotion Evidence

The immutable final report is
`/private/tmp/min-plane-provenance/canonical-reference-decode-handoff/5186255-ten-sheets/report.json`.
Portable copies of the report and all ten SVG/PNG renders live under
[`docs/artifacts/canonical-reference-decode-handoff/`](../artifacts/canonical-reference-decode-handoff/).
The report hash is
`b1e1059231312200ec9879a25697bcadd8fdd622b8d28a32eacb4750af1e0d84`.
