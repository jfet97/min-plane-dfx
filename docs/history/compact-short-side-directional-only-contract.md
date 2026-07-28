# Compact Short Side Directional-Only Contract

## Decision

Short Side must always return geometry constructed by a directional Short Side
mechanism. Compact geometry may not be returned, rotated, relabelled, or used as
a fallback. The settled Compact/capacity result supplies only the exact target
piece-ID set and comparison metrics.

## Implementation

Commit `7009e04` establishes one sequential terminal portfolio:

1. exact pair-fold and multi-row shelf;
2. protected prepared-order depth-first contact strip;
3. capped contact-first strip with resumable depth-first decisions;
4. for targets of at most eight pieces only, reverse-order and canonical
   piece-ID-order depth continuations after both prepared-order lanes fail.

All candidates use the existing exact NFP/IFP and canonical legality authority.
Completed outcomes share one exact comparator. Square sheets use physical Y as
the short axis and X as the long axis. A missing directional endpoint produces
`irregular_no_valid_result`.

## Measurement

The first full probe exposed two honest failures: Mixed-61 and Shapes-17 on
`300 x 300`. Raising contact backtracking did not help. Reverse prepared order
recovered Mixed-61, while canonical piece-ID order recovered Shapes-17. The
first Shapes success was initially mislabelled as area ordering because an
absent bounds accessor made the experimental comparator fall through to its ID
tie-break. Typecheck exposed the mistake; the mechanism and trace were renamed,
then reproduced identically three times.

The contract was independently reproduced from clean committed source
`4bc3c0f`. Its algorithm-producing command passed all 18 sequential layouts:

- nine unchanged Compact controls;
- nine genuine directional Short Side layouts;
- one multi-row shelf and eight contact-strip winners;
- zero Compact fallbacks and zero directional misses;
- exact paired placed/unplaced ID partitions.

The reproduction invoked the normal matrix command without
`--resume-existing`, executed all algorithm cases itself, rendered all PNGs with
the repository Electron helper, and wrote the final manifest and checksums in
the same run. All SVG and PNG bytes match the previously reviewed directional
layouts.

## Evidence

- [`../artifacts/compact-short-side-directional-contract/README.md`](../artifacts/compact-short-side-directional-contract/README.md)
- [`../artifacts/compact-short-side-directional-contract/summary.json`](../artifacts/compact-short-side-directional-contract/summary.json)
- [`../artifacts/compact-short-side-directional-contract/manifest.json`](../artifacts/compact-short-side-directional-contract/manifest.json)
- [`../artifacts/compact-short-side-directional-contract/SHA256SUMS`](../artifacts/compact-short-side-directional-contract/SHA256SUMS)
