# Compact Short-Side Observer Artifacts

Current 18-layout matrix source commit: `1cd5ac7`.

- `matrix/` contains the strict nine-case production-preservation gate as 18
  layouts: nine Compact controls and nine short-side-profile outputs. A
  short-side output uses a legal guarded Stage 1 winner when available and the
  exact Compact fallback otherwise. Every layout has JSON, SVG, and PNG
  evidence plus a provenance manifest and verified `SHA256SUMS`.
- `triangle-600x400-reproduction/` contains the independent reproduction and
  complete production/observer SVG and PNG comparison.
- `shapes-transpose/` contains the `2700 x 2000` transpose proof paired with
  Shapes-17 `2000 x 2700` in the matrix.

The reproduction and transpose directories retain the earlier Stage 1
acceptance evidence. The `matrix/` directory is the current-source promotion
gate.

Algorithm cases were executed strictly sequentially with at most one algorithm
process active. The observer performed zero placement and candidate evaluations
and had no production output influence.
