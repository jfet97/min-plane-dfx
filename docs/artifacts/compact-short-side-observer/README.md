# Compact Short-Side Observer Artifacts

Current 18-layout matrix source commit: `2645e7c`.

- `matrix/` contains the strict nine-case production-preservation gate as 18
  layouts: nine Compact controls and nine short-side-profile outputs. A
  short-side output uses a legal guarded Stage 1 winner when available, then
  one admitted exact terminal pair fold, and the exact Compact fallback
  otherwise. Every layout has JSON, SVG, and PNG evidence plus a provenance
  manifest and verified `SHA256SUMS`.
- `triangle-600x400-reproduction/` contains the independent reproduction and
  complete production/observer SVG and PNG comparison.
- `shapes-transpose/` contains the `2700 x 2000` transpose proof paired with
  Shapes-17 `2000 x 2700` in the matrix.

The reproduction and transpose directories retain the earlier Stage 1
acceptance evidence. The `matrix/` directory is the current-source promotion
gate.

Algorithm cases were executed strictly sequentially with at most one algorithm
process active. The archive observer performed zero placement and candidate
evaluations. The terminal observer fixes one transform per piece, evaluates
each unordered pair once, and never performs NFP search or beam expansion.
Neither observer has production Compact output influence.

The current matrix contains one guarded Stage 1 winner, one exact terminal
pair-fold winner, and seven exact Compact fallbacks. Shapes-17 `2000 x 2700`
is the pair-fold winner at `1897.173 x 220.526 mm`; its full-sheet render is
`matrix/shapes-17-2000x2700.short-side-profile.png`.
