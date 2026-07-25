# Compact Short-Side Observer Artifacts

- `contact-strip/` is the current 18-layout matrix and the accepted Stage 8
  evidence. It contains the strict nine-case production-preservation gate as
  18 layouts: nine Compact controls and nine short-side-profile outputs, plus
  the before/after comparison for the targeted Mixed-61 case.
- `matrix/` is the superseded `9193f26` matrix, retained because the user
  rejected its Mixed-61 layout and it is the reference the replacement is
  measured against.
- `rejected-stable-baseline/` records why the `9193f26` shelf tie-break is
  rejected and reverted.
- `triangle-600x400-reproduction/` contains the independent reproduction and
  complete production/observer SVG and PNG comparison.
- `shapes-transpose/` contains the `2700 x 2000` transpose proof paired with
  Shapes-17 `2000 x 2700` in the matrix.

A short-side output uses a legal guarded Stage 1 winner when available, then the
best admitted terminal construction. Compact reuse is accepted only when that
geometry already fills at least `80%` of the short edge. Every layout has JSON,
SVG, and PNG evidence, a provenance manifest, and verified `SHA256SUMS`.

Algorithm cases were executed strictly sequentially with at most one algorithm
process active. The archive observer performs zero placement and candidate
evaluations. The terminal observer evaluates the prepared transform catalog
once, evaluates each unordered pair once, and may run one prepared-order
next-fit shelf. It additionally builds one exact contact-driven strip that
reuses production Compact's NFP/IFP candidate generation and canonical
legality, and promotes it over the historical construction only when it
regresses none of short-edge fill, envelope area, depth, collision-envelope
density, occupied-hull gap, or isolated-piece count. No observer has production
Compact output influence.
