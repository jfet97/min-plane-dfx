# Current Compact Baseline Renders

These complete Chromium renders make the six durable Compact-quality gates
directly inspectable. The `2000 x 2700` rows protect the roomy complete-layout
path. The `700 x 500` rows protect final fit and constrained capacity behavior.

| Fixture | Sheet | Placed | Area | Cavities | Runtime | PNG |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| Triangle-20 | `2000 x 2700` | 20/20 | `74,428.143126 mm2` | 0 | `12.702 s` | [`triangle-20-2000x2700.png`](./triangle-20-2000x2700.png) |
| Mixed-61 | `2000 x 2700` | 61/61 | `391,605.850174 mm2` | 0 | `52.535 s` | [`mixed-61-2000x2700.png`](./mixed-61-2000x2700.png) |
| Shapes-17 | `2000 x 2700` | 17/17 | `304,499.845650 mm2` | 0 | `6.489 s` | [`shapes-17-2000x2700.png`](./shapes-17-2000x2700.png) |
| Triangle-20 | `700 x 500` | 20/20 | `74,428.143126 mm2` | 0 | `13.673 s` | [`triangle-20-700x500.png`](./triangle-20-700x500.png) |
| Mixed-61 | `700 x 500` | 45/61 | `345,342.264687 mm2` | 0 | `60.240 s` | [`mixed-61-700x500.png`](./mixed-61-700x500.png) |
| Shapes-17 | `700 x 500` | 17/17 | `303,852.763787 mm2` | 0 | `9.681 s` | [`shapes-17-700x500.png`](./shapes-17-700x500.png) |

Triangle-20 proves the same canonical motif is retained when it fits both
sheets. Shapes-17 needs the capacity path on `700 x 500`, but still places all
17 pieces in a different exact fitting motif. Mixed-61 cannot place all pieces
on `700 x 500`; its durable result honestly reports 16 unplaced pieces.

The sequential strict run used commit `976b6da`, Node `v24.16.0`, and V8
`13.6.233.17-node.49`. Full immutable reports are tracked beside each SVG and
PNG and remain available under
`/private/tmp/min-plane-provenance/compact-six-baselines-976b6da/`.

All PNGs were rendered at 1800 pixels with the repository Electron/Chromium
renderer and visually checked for complete margins and untruncated geometry.
