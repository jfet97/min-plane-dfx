# Visual Review: Area-Cost Guard Matrix

Per the promotion-gate rule that visual review is first-class and no short-side
change ships on numbers alone. Reviewer inspected the Electron-rendered PNGs in
this bundle against the pre-guard accepted renders.

## Changed layouts (2)

- `triangle-20-2000x2700.short-side-profile.png`: previously one AABB row of
  twenty point-down triangles with empty inverted notches between neighbours
  (density `0.500`, zero shared boundary). Now the protected Compact
  herringbone: two bands of alternating point-up/point-down triangles with
  edge contacts throughout (`388.107 mm` shared boundary). VERDICT: strict
  improvement on every visible dimension; exactly the arrangement the user
  asked to keep.
- `shapes-17-2000x2700.short-side-profile.png`: previously one spread row of
  seventeen pieces with visible gaps and one floating piece (`1.487x` the
  Compact envelope). Now the dense Compact block with interlocked pieces.
  VERDICT: strict improvement; the spread row is gone.

## Unchanged layouts (16, hash-verified)

- `mixed-61-2000x2700.short-side-profile`: the `100%`-fill contact strip with
  the interleaved left section is byte-identical to the pre-guard render;
  previously reviewed and still the correct flagship.
- `triangle-20-600x400.short-side-profile`: the zigzag interleaved columns
  are byte-identical; re-inspected in this bundle, still correct.
- All nine Compact controls and the five Compact-satisfied short-side arms
  are byte-identical to the pre-guard matrix; no visual change possible.

No layout in this bundle shows spread AABB rows, floating pieces, or visible
notch voids. Visual review passes alongside the numeric contract.
