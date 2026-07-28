# Visual Review

All nine Short Side PNGs were inspected at full render scale with visible sheet
margins and no cropped geometry. Their bytes match the candidate renders
reviewed before baseline promotion.

- Triangle-20 `2000 x 2700`: one shallow row spanning `88.288%` of the short
  edge.
- Mixed-61 `2000 x 2700`: compact multi-family strip spanning the complete
  short edge.
- Shapes-17 `2000 x 2700`: shallow mixed-shape strip spanning `99.7816%`.
- Triangle-20 `600 x 400`: clean interlocked strip, `20/20`, no isolated
  pieces, `99.32425%` short-edge fill.
- Mixed-61 `600 x 400`: dense `25/25` constrained subset spanning the complete
  short edge.
- Shapes-17 `600 x 400`: dense `14/14` constrained subset spanning the complete
  short edge.
- Triangle-20 `300 x 300`: cohesive `17/17` subset spanning the complete
  deterministic square short axis.
- Mixed-61 `300 x 300`: compact `6/6` subset from the protected reverse-order
  continuation.
- Shapes-17 `300 x 300`: valid `5/5` subset from the canonical piece-ID-order
  continuation.

No Short Side PNG is a Compact fallback.

