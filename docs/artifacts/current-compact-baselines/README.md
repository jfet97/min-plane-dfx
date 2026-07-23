# Current Compact Baseline Renders

These complete Chromium renders make the three durable Compact-quality gates
directly inspectable.

| Fixture | Canonical result | Current validation | PNG |
| --- | --- | --- | --- |
| Triangle-20 | `371db269...`, `74,428.143126 mm2`, zero cavities | exact unit golden at `f65a4e5` | [`triangle-20.png`](./triangle-20.png) |
| Mixed-61 | `ef2b783a...`, `391,605.850174 mm2`, zero cavities | clean production gate at `c3849fd` | [`mixed-61.png`](./mixed-61.png) |
| Shapes-17 | `c640c06f...`, `304,499.845650 mm2`, zero cavities | exact unit golden at `f65a4e5` | [`shapes-17.png`](./shapes-17.png) |

The Triangle-20 and Shapes-17 SVGs are the accepted canonical winner artifacts
revalidated by the current exact unit gates. Mixed-61 is copied from the clean
`c3849fd` production artifact under
`/private/tmp/min-plane-provenance/replay-scoring-final-c3849fd-20260723/`.

All PNGs were rendered at 1400 pixels with the repository Electron/Chromium
renderer and visually checked for complete margins.
