# Compact Short-Side Contact Tie-Break Matrix

Accepted 18-layout matrix (3 fixtures x 3 sheets x Compact/Short Side) for the
bounded contact-aware strip tie-break, regenerated from commit
`51befe5b388a37cd02088963688c7cee902ed17e`. Regenerate with:

```sh
pnpm gate:compact-nine-baselines --output-dir <output-directory>
```

The immutable original run, including the same manifest, reports, renders, and
SHA256SUMS, is `/private/tmp/min-plane-provenance/short-side-contact-tie-break-matrix/`.

Outcome: all nine Compact controls byte-identical; the Mixed-61 `2000x2700`
flagship strip keeps span `2000`, depth `207.700`, envelope `415,400 mm2`,
density, fill, and zero cavities while its connectivity strictly improves
(shared boundary `1,279.1 -> 1,367.4 mm`, isolated pieces `28 -> 27`,
components `37 -> 36`, largest component `12 -> 13`, hull gap `0.2151 ->
0.2111`); the Triangle-20 `600 x 400` archive zigzag is byte-identical; the
five Compact satisfactions and two quality-protected fallbacks are unchanged;
zero directional misses.

Visual review: [VISUAL-REVIEW.md](./VISUAL-REVIEW.md).
Decision narrative: `../../history/compact-short-side-strip-relaxation-rejection.md`.
