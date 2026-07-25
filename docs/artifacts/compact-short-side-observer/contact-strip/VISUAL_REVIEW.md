# Short-side matrix visual review

Every PNG in this directory was opened and inspected individually after the
strict sequential matrix completed. All four sheet margins were visible and no
polygon was truncated. The roomy short-side bands are thin relative to the
sheet, so they were additionally inspected at magnified crops.

| Fixture | Sheet | Source | Review |
| --- | --- | --- | --- |
| Triangle-20 | `2000x2700` | multi-row shelf | pass with a recorded limitation; one exact strip spans `88.288%` of the short edge, but the row has zero interlocking and every triangle is isolated |
| Mixed-61 | `2000x2700` | contact strip | pass; the band spans the full `2000 mm` short edge, triangles and trapezoids alternate up and down into each other, and the small rectangles now sit inside the notches between triangles instead of at row ends |
| Shapes-17 | `2000x2700` | pair fold | pass with a recorded limitation; the exact pair-fold strip spans `94.859%` of the short edge but stays a single sparse row |
| Triangle-20 | `600x400` | archive winner | pass; three interlocked triangle columns span `98.731%` of the short edge |
| Mixed-61 | `600x400` | Compact | pass; the Compact capacity result already spans `99.825%` of the short edge and is densely interlocked |
| Shapes-17 | `600x400` | Compact | pass; the Compact capacity result already spans `98.021%` of the short edge |
| Triangle-20 | `300x300` | Compact | pass; the square Compact result spans `98.913%` of either eligible edge with a fully interlocked triangular lattice |
| Mixed-61 | `300x300` | Compact | pass; the square Compact result spans `99.837%` of either eligible edge |
| Shapes-17 | `300x300` | Compact | pass; the square Compact result spans `99.858%` of either eligible edge |

## What changed against the rejected matrix

Exactly one short-side layout changed. Mixed-61 `2000 x 2700` moves from the
rejected AABB shelf to the contact strip. The other eight short-side layouts and
all nine production Compact layouts keep byte-identical canonical collision and
fitted hashes against
[`../matrix/`](../matrix/).

The [`comparison/`](./comparison/) directory holds the rejected shelf and the
accepted strip for that case side by side.

## Recorded limitations

Triangle-20 and Shapes-17 on `2000 x 2700` are not Compact-quality yet. Their
contact strips were constructed and measured, and both were rejected by the
strict no-regression rule: the Triangle strip is far denser but fills only
`46.2333%` of the short edge, and the Shapes strip regresses collision density
and occupied-hull gap. Their measurements are retained in each case's
`intrinsicShortSidePairFoldTrace.contactStripPromotion.contactStripSummary`.

Triangle-20 `2000 x 2700` also changed its occupied-hull gap from
`0.02564102564102564` to `0.48717948717948717` when the rejected `9193f26`
tie-break was reverted, with no change to its canonical identity, envelope,
fill, density, isolated-piece count, or contact components. The wasted area is
identical; only its connectivity changed.

## Renderer

PNGs were produced with the repository Electron/Chromium renderer. The manifest
records the exact renderer and source commit.
