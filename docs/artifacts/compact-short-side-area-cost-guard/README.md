# Compact Short-Side Area-Cost Guard Matrix

Accepted 18-layout matrix (3 fixtures x 3 sheets x Compact/Short Side) for the
production area-cost honesty guard. The guard implementation is commit
`903657e1aeaa80d2578e78436da9b3c810c12672`; this bundle was regenerated from
commit `a750798f4ec6cd8eb800c5fcaa5b629b79bc44d2`, which adds the retained
causal-veto evidence and the exact boundary tests. Regenerate with:

```sh
pnpm gate:compact-nine-baselines --output-dir <output-directory>
```

The immutable original run, including the same manifest, reports, renders, and
SHA256SUMS, is `/private/tmp/min-plane-provenance/short-side-area-cost-guard-a750798-matrix/`.

Outcome: all nine Compact controls byte-identical; two directional winners kept
(Triangle-20 `600 x 400` archive zigzag at `1.214x` production envelope,
Mixed-61 roomy contact strip at `1.061x`, `100%` fill); five Compact
satisfactions; two quality-protected fallbacks where the guard vetoed the
dishonest sibling (Triangle-20 roomy shelf at `1.795x`, Shapes-17 roomy pair
fold at `1.487x`); zero directional misses. Each quality-protected fallback
retains its causal veto record (construction kind and full admission terms) in
its short-side profile report.

Visual review: [VISUAL-REVIEW.md](./VISUAL-REVIEW.md).
Decision narrative: `../../history/compact-short-side-area-cost-guard.md`.
