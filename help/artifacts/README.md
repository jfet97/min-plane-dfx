# Irregular Nesting Reference Artifacts

These SVGs are portable copies of immutable headless experiment outputs. They
exist so `help/help.md` remains useful on machines that do not have the original
`/private/tmp/min-plane-provenance/` tree.

| File | Commit | Request / sheet | Bounds | SHA-256 |
| --- | --- | --- | --- | --- |
| `approved-mixed61-ac75222-2000x2700.svg` | `ac75222` plus `depth21-total2` | `780d4ec5-b64e-4f48-a8d8-0bfd30877549`, `2000 x 2700` | `564.660 x 773.545` | `c7b2fa24a5fa721fa9ff87c7aafff3e25ff0d89474be7be7191117fe05c64a34` |
| `approved-mixed61-ac75222-2000x2700.png` | Electron render of the approved SVG | `780d4ec5-b64e-4f48-a8d8-0bfd30877549`, `2000 x 2700` | `564.660 x 773.545` | `69599fb77b587aaf7f7930fa20ae04eeb8365ff02d2839501a715e0a5c5b6b93` |
| `approved-mixed61-ac75222-2000x2700.manifest.json` | immutable experiment manifest | `780d4ec5-b64e-4f48-a8d8-0bfd30877549`, `2000 x 2700` | n/a | `f618afe31f512d05753d925ff1dc2a6be3e9590fc66ea0ff7131b1f353fbcf76` |
| `ac75222-1000x1700-sheet-dependent-failure.svg` | `ac75222` plus `depth21-total2` | `55f7d560-5068-4a28-bedf-86466a5bb77e`, `1000 x 1700` | `515.765 x 1382.896` | `48df7dae76016f496568e2280f45c80df7e76939cba834315caed4bc458b81f3` |
| `b164d61-2000x2700-scale-diverse.svg` | `b164d61` | `780d4ec5-b64e-4f48-a8d8-0bfd30877549`, `2000 x 2700` | `657.041 x 816.710` | `801f0be2ffe00a6806a2d2e6732a363e7cf3280700294ca40e09d5be31675334` |
| `b164d61-1000x1700-scale-diverse.svg` | `b164d61` | `55f7d560-5068-4a28-bedf-86466a5bb77e`, `1000 x 1700` | `492.567 x 905.797` | `d95d4e52058970a008b29b86473f2df738ff2b9541542b32cf8dccb6655c7492` |
| `protected-boundary-anchor/mixed-61-2000x2700.svg` | `680e9a5` | persisted mixed-61 fixture, `2000 x 2700` | `545.515 x 788.878` | `2d8556fc00b7517a4b3c06a35dac1c3f755063f94f840de22b53a89b4a6f6c93` |
| `protected-boundary-anchor/mixed-61-2000x2700.png` | Chromium render of `680e9a5` SVG | persisted mixed-61 fixture, `2000 x 2700` | `545.515 x 788.878` | `cfb4e876cafd676f835434e7f201bf3e9a7188cb69c774a261ce569bc3c66d1a` |
| `protected-boundary-anchor/manifest.json` | immutable `680e9a5` experiment manifest | full corpus and four-sheet mixed-61 gate | n/a | `02b618a490db27b9dadee9e1cc3a875d65f2f30eb2fe2b6842036ae4ce5671b0` |
| `protected-intrinsic-contact-seed/mixed-61-2000x1700.svg` | `13a2351` | persisted mixed-61 fixture, `2000 x 1700` | `744.164 x 720.014` | `e3ed14b7ad13228b950ab9d4b09569f2c0ef8f5c6702dacdc5fe95bd0cd0a8c4` |
| `protected-intrinsic-contact-seed/mixed-61-2000x1700.png` | Chromium render of `13a2351` SVG | persisted mixed-61 fixture, `2000 x 1700` | `744.164 x 720.014` | `0fe3b81c8a5e3af9898c999c0b88131a1ca4b17306ae4670263e7ca947ceed0d` |
| `protected-intrinsic-contact-seed/manifest.json` | immutable `13a2351` experiment manifest | full corpus and reproducible four-sheet mixed-61 gate | n/a | `0cb539325d4db726bae9805f201cab446a1f2169da1ed4e9d0574bc50b3adc31` |

The first row remains the historical user-approved reference. The protected
boundary-anchor rows are the current accepted repair-disabled result: smaller
than the current post-canonicalization baseline, with the two-hole motif
recovered. The intrinsic-contact rows are the next accepted checkpoint: they
preserve that reference and reduce the `2000 x 1700` envelope by `18.99%` while
reducing holes from 6 to 4. Four hashes remain, so these rows are not evidence
of complete sheet invariance. The remaining files demonstrate sheet-normalized
drift and the later scale-diverse escape paths.
