# Intrinsic Shared-Archive Performance Checkpoint

Date: 2026-07-23

This checkpoint profiles and accelerates the current archive-only Compact
quality path without changing search allocation or result semantics.

## Change

Commit `54b437a47cfe641a9d240c0e1de9a39c6c9165ca` adds benchmark-only nested
strict-construction timings and replaces one redundant local operation. Candidate
ranking previously called the complete canonical envelope measurement for every
legal candidate. That function also computed a convex hull and hull waste even
though local ranking consumed only maximum side, bounding area, and span.

The strict decoder now derives those three values from the incrementally
maintained occupied bounds after conversion to the same canonical 0.001 mm grid.
Complete-layout hull metrics remain unchanged at archive admission. Timing is
absent unless the benchmark harness explicitly enables it; deterministic
evaluation caps no longer activate hot-loop telemetry in production.

## Frozen Work

All samples used the same Mixed-61 fixture, three direct candidate budgets
(`24,896`, `24,083`, `24,310`), eight selected periodic continuations at
`19,862` candidate evaluations each, `p2-axis-union` source audit, and serial
execution on Node `v24.16.0` / V8 `13.6.233.17-node.49`.

| Implementation | Exact identity | Direct total | Periodic total | Strict construction | Direct + periodic |
| --- | --- | ---: | ---: | ---: | ---: |
| Baseline sample 1 | `4f3ddb8` | `73,368.269 ms` | `180,405.370 ms` | `159,715.933 ms` | `253,773.640 ms` |
| Baseline sample 2 | `4f3ddb8` | `73,332.490 ms` | `177,855.647 ms` | `157,386.017 ms` | `251,188.137 ms` |
| Optimized sample 1 | `54b437a` | `70,724.493 ms` | `173,695.341 ms` | `153,124.514 ms` | `244,419.835 ms` |
| Optimized sample 2 | `54b437a` | `71,753.879 ms` | `176,529.359 ms` | `155,568.786 ms` | `248,283.237 ms` |

The direct-plus-periodic median falls from `252,480.888 ms` to `246,351.536 ms`
(`-2.43%`). Strict-construction median falls from `158,550.975 ms` to
`154,346.650 ms` (`-2.65%`). The paired ranges do not overlap. The earlier
single optimized pilot suggested roughly 9%; it is retained only as a noisy
observation and is not the accepted effect size.

Nested optimized timing remained coverage-complete. Candidate generation used
about `8.8 s`; candidate state construction/scoring used `144.3-146.7 s`; the
strict residual was about `13.5 ms`. The next useful profile split is therefore
inside state scoring, not NFP generation.

## Exactness and Quality Gates

All exact-commit reports retain the same ordered selected sources, continuation
statuses and candidate budgets, sheetless/fitted archive order, q0/q90 fit, and
winner. The diagnostic winner SVG is byte-identical across every sample:

```text
a6dd9e2d4a16a1f760a3b2b4ecbd64baeb3ae74c140d9603dfeccbf27f0d78f7
```

The production gates also passed:

- Triangle-20: exact `371db269...` identity and `74,428.143126 mm2` area;
- Mixed-61: exact fitted `ef2b783a...` identity, `391,605.850174 mm2`, zero cavities;
- Shapes-17: exact `c640c06f...` identity and `304,499.845650 mm2` area;
- `900 x 1800` and `1000 x 1300`: `geometryEquivalent: true`, both returning
  the exact fitted Mixed hash above.

This preserves the current two-sheet invariance sample. It does not close the
still-pending ten-sheet matrix.

## Immutable Local Evidence

- baseline sample 1:
  `/private/tmp/min-plane-provenance/current-performance-cold-4f3ddb8-20260723/`
- baseline sample 2:
  `/private/tmp/min-plane-provenance/performance-baseline-4f3ddb8-repeat-20260723/`
- optimized sample 1:
  `/private/tmp/min-plane-provenance/performance-optimized-54b437a-repeat-20260723/`
- optimized sample 2:
  `/private/tmp/min-plane-provenance/performance-optimized-54b437a-repeat2-20260723/`
- production Mixed gate: `/private/tmp/irregular-sheet-invariance/report.json`
- two-sheet gate:
  `/private/tmp/min-plane-provenance/current-performance-two-sheet-invariance-4f3ddb8-20260723/`

Every directory contains its report, manifest, and winner SVG where applicable.
The baseline repeat was executed from the persistent detached checkout at
`/Users/andreasimonecosta/Documents/Work/min-plane-dfx-worktrees/performance-baseline-4f3ddb8`.
