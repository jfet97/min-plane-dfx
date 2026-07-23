# Current Compact Baseline Renders

These complete Chromium renders make the six durable Compact-quality gates
directly inspectable. The `2000 x 2700` rows protect the roomy complete-layout
path. The `600 x 400` rows protect final fit and constrained capacity behavior.

| Fixture | Sheet | Placed | Area | Cavities | Runtime | PNG |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| Triangle-20 | `2000 x 2700` | 20/20 | `74,428.143126 mm2` | 0 | `12.702 s` | [`triangle-20-2000x2700.png`](./triangle-20-2000x2700.png) |
| Mixed-61 | `2000 x 2700` | 61/61 | `391,605.850174 mm2` | 0 | `52.535 s` | [`mixed-61-2000x2700.png`](./mixed-61-2000x2700.png) |
| Shapes-17 | `2000 x 2700` | 17/17 | `304,499.845650 mm2` | 0 | `6.489 s` | [`shapes-17-2000x2700.png`](./shapes-17-2000x2700.png) |
| Triangle-20 | `600 x 400` | 20/20 | `74,428.143126 mm2` | 0 | `12.761 s` | [`triangle-20-600x400.png`](./triangle-20-600x400.png) |
| Mixed-61 | `600 x 400` | 24/61 | `232,800.043098 mm2` | 0 | `3.726 s` | [`mixed-61-600x400.png`](./mixed-61-600x400.png) |
| Shapes-17 | `600 x 400` | 13/17 | `228,616.694352 mm2` | 1 | `9.326 s` | [`shapes-17-600x400.png`](./shapes-17-600x400.png) |

Triangle-20 proves the same canonical motif is retained when it fits both
sheets. On `600 x 400`, the exact capacity results honestly report four
unplaced Shapes-17 pieces and 37 unplaced Mixed-61 pieces.

The sequential strict run used commit `7b71611`, Node `v24.16.0`, and V8
`13.6.233.17-node.49`. Full immutable reports are tracked beside each SVG and
PNG and remain available under
`/private/tmp/min-plane-provenance/compact-600x400-7b71611/`.

All PNGs were rendered at 1800 pixels with the repository Electron/Chromium
renderer and visually checked for complete margins and untruncated geometry.
