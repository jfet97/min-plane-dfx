# Compact Short-Side Observer Artifacts

Source commit: `dfb458ff8bbaa5ca0832e71bd1062ee29e397b22`.

- `matrix/` contains the strict nine-case production-preservation gate as 18
  layouts: nine Compact controls and nine short-side-profile outputs. A
  short-side output uses a legal guarded Stage 1 winner when available and the
  exact Compact fallback otherwise. Every layout has JSON, SVG, and PNG
  evidence plus a provenance manifest and verified `SHA256SUMS`.
- `triangle-600x400-reproduction/` contains the independent reproduction and
  complete production/observer SVG and PNG comparison.
- `shapes-transpose/` contains the `2700 x 2000` transpose proof paired with
  Shapes-17 `2000 x 2700` in the matrix.

Algorithm cases were executed strictly sequentially with at most one algorithm
process active. The observer performed zero placement and candidate evaluations
and had no production output influence.
