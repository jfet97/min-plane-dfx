# Canonical Reference Decode Handoff

## Status

Production-candidate implementation on branch `canonical-reference-decode-handoff`.
The isolated certified-priority experiment is green across all six mixed-61 target
sheets and all twelve non-mixed corpus lanes. Promotion gates must still be rerun
on the consolidated candidate before merge.

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

The isolated `c9a2d64` experiment produced the same approved result on all six
mixed-61 target sheets:

```text
canonical hash: 40f8ac9c0fb24073ac141b5fb667366af55df90c78c6cca21ff76703a4a7f300
area:           430344.917527 mm2
holes:          2
contacts:       53 / 14
all six:         exact hash and metrics above
```

All twelve non-mixed corpus lanes retained their exact baseline hashes and
metrics. The full suite was `564/566`; the two failures were the pre-existing
irregular benchmark failures reproduced on the base branch.

The renderer irregular timeout floor is therefore `120000 ms`, leaving headroom
over the measured protected pass without changing rectangular-worker defaults.

## Remaining Gate

Rerun the four-sheet, corpus, and ten-sheet gates on the consolidated candidate,
including selected-role history, role diagnostics, runtime, and aggregated decode
counts, before merging. The evidence above belongs to the preserved isolated
experiment and is not silently relabeled as a run of this checkout.
