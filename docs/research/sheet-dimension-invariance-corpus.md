# Sheet-Dimension Invariance Corpus

## Purpose

Balanced compactness and edge-contact search should treat the sheet as a
legality boundary, not as an intrinsic shape objective. If two sheets are both
large enough for the same compact layout, changing sheet size or aspect ratio
should preserve the collision geometry up to rigid quarter-turn and
bottom-left translation. The explicitly directional `short-side-fill` policy
is exempt from this contract.

The reusable diagnostic is:

```sh
pnpm corpus:sheet-invariance
```

Use `--strict` once production ranking is expected to satisfy the contract.
The default run remains diagnostic so the currently known failures can be
measured without making the normal test suite red.

## Fixtures

Every case uses `10 mm` total padding, rotations and mirroring enabled, reorder
window `4`, beam width `8`, local fanout `4`, transform cap `8`, edge-contact
then balanced compactness, and GA disabled. Terminal repair is disabled except
for the exact 20-triangle golden, which uses repair budget `8`.

| Case | Pieces | Source geometry |
| --- | ---: | --- |
| `triangle-golden-20` | 20 | repeated `70 x 60 mm` triangle |
| `rectangles-20` | 20 | repeated `154 x 104 mm` rectangle |
| `trapezoids-20` | 20 | repeated `100 x 75 mm` trapezoid with `60 mm` top |
| `pentagons-20` | 20 | repeated `90 x 90 mm` pentagon |
| `star-hulls-20` | 20 | repeated `90 x 90 mm` star source, convex collision hull |
| `mixed-50` | 50 | round-robin triangle, trapezoid, rectangle, pentagon, star hull, hexagon |
| `mixed-61` | 61 | exact persisted request `780d4ec5-b64e-4f48-a8d8-0bfd30877549` |

The same prepared pieces and optimizer settings run on `1000 x 1700 mm` and
`2000 x 2700 mm` sheets. The smaller sheet admits the known compact envelopes,
so a mismatch is a search/ranking dependency rather than an oversized-piece
fixture error.

## Geometry Comparison

The canonicalizer uses the live `0.001 mm` collision grid. It:

1. evaluates all four rigid quarter-turns;
2. bottom-left normalizes the whole collision cluster;
3. canonicalizes polygon ring origin and winding;
4. sorts polygons so interchangeable-copy order does not matter;
5. hashes the lexicographically smallest representation.

It deliberately preserves reflection and every relative placement. Two layouts
therefore pass only when their real collision geometry is the same under the
allowed terminal equivalences.

## Baseline Measurement

Measured at commit `32c1951e35115d249df3327542dd52acdae82f14` on 2026-07-17.
All seven cases fail exact sheet invariance.

| Case | 1000x1700 ms | 2000x2700 ms | Areas mm2 | Short/long sides mm | Holes |
| --- | ---: | ---: | --- | --- | --- |
| triangle golden | 1,921 | 3,582 | 80,174 / 80,174 | 151/530 vs 227/353 | 0 / 0 |
| rectangles | 1,298 | 1,297 | 539,325 / 439,304 | 608/887 vs 608/723 | 0 / 0 |
| trapezoids | 1,430 | 1,489 | 299,295 / 233,380 | 318/941 vs 136/1,710 | 0 / 0 |
| pentagons | 1,721 | 1,642 | 345,212 / 240,528 | 407/847 vs 451/533 | 2 / 2 |
| star hulls | 1,688 | 1,667 | 345,212 / 240,528 | 407/847 vs 451/533 | 2 / 2 |
| mixed 50 | 9,705 | 9,238 | 621,895 / 622,961 | 652/953 vs 673/925 | 8 / 8 |
| mixed 61 | 17,195 | 18,862 | 446,166 / 536,612 | 493/906 vs 657/817 | 9 / 1 |

The complete machine-readable result and cluster-only SVGs are under:

```text
/private/tmp/irregular-sheet-invariance/report.json
/private/tmp/irregular-sheet-invariance/<case>-1000x1700.svg
/private/tmp/irregular-sheet-invariance/<case>-2000x2700.svg
```

The triangle result is especially important: both sheets produce the same
bounding area, but one is a `151 x 530 mm` chain with weaker contacts while the
reference sheet produces the approved `227 x 353 mm` lattice. Area equality is
therefore insufficient; exact canonical collision geometry and the existing
golden quality gate are both required.

The mixed-61 result demonstrates a different tradeoff. The smaller sheet has a
smaller envelope area but nine holes, while the larger sheet has one hole.
Sheet invariance should remove this accidental objective drift; separate corpus
quality gates must still decide which intrinsic geometry is acceptable.
