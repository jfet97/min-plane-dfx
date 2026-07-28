# Compact Short Side Directional Contract

This directory is the portable source-of-truth bundle for the directional-only
Short Side contract at source commit `7009e04d3771b1259567b41722570de45dc20ec0`.

The run executed 18 algorithm cases sequentially with maximum concurrency one.
All nine Compact controls retain their expected hashes. All nine Short Side
cases return newly constructed directional geometry with the exact
Compact-selected piece partition; no Short Side case returns Compact geometry.

| Fixture / sheet | Compact | Short Side | Placed |
| --- | ---: | ---: | ---: |
| Triangle-20 `2000 x 2700` | `3.154 s` | `3.427 s` | `20 / 20` |
| Mixed-61 `2000 x 2700` | `33.134 s` | `34.759 s` | `61 / 61` |
| Shapes-17 `2000 x 2700` | `6.114 s` | `8.309 s` | `17 / 17` |
| Triangle-20 `600 x 400` | `3.114 s` | `3.403 s` | `20 / 20` |
| Mixed-61 `600 x 400` | `3.090 s` | `3.758 s` | `25 / 25` |
| Shapes-17 `600 x 400` | `6.407 s` | `8.014 s` | `14 / 14` |
| Triangle-20 `300 x 300` | `3.831 s` | `3.951 s` | `17 / 17` |
| Mixed-61 `300 x 300` | `0.540 s` | `0.577 s` | `6 / 6` |
| Shapes-17 `300 x 300` | `1.750 s` | `1.817 s` | `5 / 5` |

`summary.json` contains the paired layout records. `manifest.json` records the
source commit, execution model, command, and artifact hashes. `SHA256SUMS`
verifies all JSON, SVG, PNG, and manifest bytes.

The `*.short-side-profile.png` files are the nine directional outputs. The
plain `*.png` files are their paired Compact controls.

