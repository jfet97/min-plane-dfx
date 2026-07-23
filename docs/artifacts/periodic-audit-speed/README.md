# Periodic Source-Audit Speed Arms

Branch: `deterministic-periodic-budget`

Implementation lineage starts at `091bc67`; the accepted code and documentation
are committed together on this branch after the three-arm gate.

| Fixture / arm | Periodic time | Physical raw attempts | Winner | Area | Cavities |
| --- | ---: | ---: | --- | ---: | ---: |
| Triangle cold full | 100.970 s | 234,320 | `371db269...` | 74,428.143 | 0 |
| Triangle warm replay | 6.793 s | 0 | `371db269...` | 74,428.143 | 0 |
| Triangle cold P2 axis | 12.388 s | 12,560 | `371db269...` | 74,428.143 | 0 |
| Mixed cold full | 347.944 s | 513,904 | periodic control `310adc64...` | 426,530.392 | 0 |
| Mixed warm replay | 182.106 s | 0 | `5a1f1ba6...` | 405,773.434 | 0 |
| Mixed cold P2 axis | 196.673 s | 23,456 | `3839e80d...` | 391,605.850 | 0 |

The Mixed cold-full row used starved direct caps, so its periodic timing and
source-set measurement are valid but its overall experiment flag is not. The
established `fa9ab29` full-budget control supplies the 405,773.434 reference.
The warm and filtered final rows use the correct frozen Mixed direct caps and
report `experimentValid: true`.

## Portable renders

- [Triangle filtered SVG](triangle-20-filtered.svg)
- [Triangle filtered PNG](triangle-20-filtered.png)
- [Mixed filtered SVG](mixed-61-filtered.svg)
- [Mixed filtered PNG](mixed-61-filtered.png)

## Immutable report hashes

- Triangle cold: `abdd5e80079f8ffc285205e86c03ac98b6befaf3f8712b1cc43a7a5f2ba50e22`
- Triangle warm: `314434b9e38a5b978173611df8c630dc3c7a8be50f81a6bf8cbd3c87221dfc6a`
- Triangle filtered: `8878e2c62fc904ff9f0b32cb89d76c8c57134b70146db5e1979cd6534a9bb7c9`
- Mixed warm: `ace66befc98eb7eafd51bdbd7cd5c0d2be9516958f85f3ddbf7c67c6a24f1668`
- Mixed filtered: `95b114e06c682c93d8669a2a49df347a2e5e0a83973801caed15c38d005f3ac8`
- Triangle cache: `f32a521f248ce3e65b5d849578903ebee7fd001cf0ea87206906d0d4db175737`
- Mixed cache: `83f253616f3cddfa324011745360820ea1399f2f57dcf58d7ee47cf1bec56b86`
