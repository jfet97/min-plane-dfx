# Compact Short Side Directional Contract

This directory is the portable source-of-truth bundle for the directional-only
Short Side contract, reproduced from committed source
`4bc3c0f613a8094195b1bc8a7243f0e7f91117bd`.

The run executed 18 algorithm cases sequentially with maximum concurrency one.
All nine Compact controls retain their expected hashes. All nine Short Side
cases return newly constructed directional geometry with the exact
Compact-selected piece partition; no Short Side case returns Compact geometry.

| Fixture / sheet | Compact | Short Side | Placed |
| --- | ---: | ---: | ---: |
| Triangle-20 `2000 x 2700` | `3.477 s` | `3.712 s` | `20 / 20` |
| Mixed-61 `2000 x 2700` | `35.578 s` | `35.231 s` | `61 / 61` |
| Shapes-17 `2000 x 2700` | `6.091 s` | `8.322 s` | `17 / 17` |
| Triangle-20 `600 x 400` | `3.087 s` | `3.437 s` | `20 / 20` |
| Mixed-61 `600 x 400` | `3.093 s` | `3.787 s` | `25 / 25` |
| Shapes-17 `600 x 400` | `6.480 s` | `7.952 s` | `14 / 14` |
| Triangle-20 `300 x 300` | `3.957 s` | `4.196 s` | `17 / 17` |
| Mixed-61 `300 x 300` | `0.610 s` | `0.691 s` | `6 / 6` |
| Shapes-17 `300 x 300` | `1.836 s` | `1.811 s` | `5 / 5` |

`summary.json` contains the paired layout records. `manifest.json` records the
algorithm-producing command, clean source commit, execution model, renderer,
and artifact hashes. It does not use the resume path. `SHA256SUMS` verifies all
JSON, SVG, PNG, and manifest bytes.

The `*.short-side-profile.png` files are the nine directional outputs. The
plain `*.png` files are their paired Compact controls.
