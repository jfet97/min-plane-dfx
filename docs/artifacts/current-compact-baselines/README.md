# Current Compact Baseline Renders

These complete Chromium renders make the three durable Compact-quality gates
directly inspectable.

| Fixture | Canonical result | Current validation | PNG |
| --- | --- | --- | --- |
| Triangle-20 | `371db269...`, `74,428.143126 mm2`, zero cavities | `12.635 s` exact gate at `2174c63` | [`triangle-20.png`](./triangle-20.png) |
| Mixed-61 | `ef2b783a...`, `391,605.850174 mm2`, zero cavities | `52.962 s` production gate at `2174c63` | [`mixed-61.png`](./mixed-61.png) |
| Shapes-17 | `c640c06f...`, `304,499.845650 mm2`, zero cavities | `7.447 s` exact gate at `2174c63` | [`shapes-17.png`](./shapes-17.png) |

All three SVGs and PNGs were regenerated or revalidated after the adaptive
Compact transform policy at `2174c63`. Their hashes remain byte-identical to
the previous accepted artifacts. Full reports and manifests are under
`/private/tmp/min-plane-provenance/adaptive-policy-2174c63/`; the production
Mixed report is `/private/tmp/irregular-sheet-invariance/report.json`.

All PNGs were rendered at 1400 pixels with the repository Electron/Chromium
renderer and visually checked for complete margins.
