# Compact Short-Side Observer Artifacts

Current 18-layout matrix source commit: `9193f26`.

- `matrix/` contains the strict nine-case production-preservation gate as 18
  layouts: nine Compact controls and nine short-side-profile outputs. A
  short-side output uses a legal guarded Stage 1 winner when available, then
  an admitted exact terminal pair fold, then one deterministic multi-row
  shelf. Compact reuse is accepted only when that geometry already fills at
  least `80%` of the short edge. Every layout has JSON, SVG, and PNG evidence,
  a provenance manifest, verified `SHA256SUMS`, and a nine-image visual review.
- `triangle-600x400-reproduction/` contains the independent reproduction and
  complete production/observer SVG and PNG comparison.
- `shapes-transpose/` contains the `2700 x 2000` transpose proof paired with
  Shapes-17 `2000 x 2700` in the matrix.

The reproduction and transpose directories retain the earlier Stage 1
acceptance evidence. The `matrix/` directory is the current-source promotion
gate.

Algorithm cases were executed strictly sequentially with at most one algorithm
process active. The archive observer performed zero placement and candidate
evaluations. The terminal observer evaluates the prepared transform catalog
once, evaluates each unordered pair once, and never performs NFP search or beam
expansion. After a pair miss it may run one prepared-order next-fit shelf using
the depth-minimizing transform retained from that same catalog evaluation.
When equally shallow and wide shelf transforms exist, it prefers the transform
with the longest exact support on the row baseline. This is shape-generic and
does not change the shelf envelope. Neither observer has production Compact
output influence.

The current matrix contains one guarded Stage 1 winner, one exact terminal
pair-fold winner, two exact multi-row winners, and five Compact layouts that
already satisfy the short-edge contract. It has nine satisfied profiles and
zero directional misses. The roomy outputs are Triangle-20 at
`1765.760 x 75.675 mm`, Mixed-61 at `1987.776 x 301.187 mm`, and Shapes-17
at `1897.173 x 220.526 mm`.
