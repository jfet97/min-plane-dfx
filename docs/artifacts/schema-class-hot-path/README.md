# Effect Schema in the trusted algorithm hot path

Evidence for issue #11 §3.1 and §3.3: the CPU profile that established the
priority order, and the measured result of converting the trusted internal
search artifacts to plain classes.

## Environment

```
baseline commit   ae75409
case              mixed-61, sheet 2000x2700
command           TSX_TSCONFIG_PATH=tsconfig.node.json \
                  node --cpu-prof --cpu-prof-dir=<dir> --cpu-prof-interval=500 \
                       --import tsx scripts/irregular-compact-baseline.ts \
                       --fixture mixed-61 --sheet 2000x2700 \
                       --output-prefix <prefix> \
                       --capture-short-side-observer \
                       --capture-short-side-pair-fold-observer
node              v24.18.0
v8                13.6.233.17-node.50
os                Linux 6.18.38, x86_64, 16 cores, 125 GiB RAM
build mode        tsx (source, no bundling)
samples           159,420, 94.9 s sampled
```

Reproduce the categorization from the archived profile:

```sh
pnpm exec tsx --tsconfig tsconfig.node.json scripts/analyze-cpu-profile.ts \
  --profile docs/artifacts/schema-class-hot-path/mixed-61-2000x2700.baseline.cpuprofile.gz \
  --inclusive-filter src/shared/irregular/domain
```

## Profiling overhead is not a confounder

Concern: several producers terminate on `performance.now()`, so profiling
overhead could change how much logical work a run performs, and a matching final
hash would not prove otherwise. Measured against an unprofiled control at the
same commit:

| Field | Profiled | Unprofiled |
| --- | ---: | ---: |
| collision identity hash | `3839e80d26be2573` | `3839e80d26be2573` |
| fitted canonical hash | `ef2b783ae12491d2` | `ef2b783ae12491d2` |
| placed / unplaced | 61 / 0 | 61 / 0 |
| focused status | `evaluation-cap` | `evaluation-cap` |
| focused candidate evaluations | 12,000 | 12,000 |
| settled endpoints | 5 | 5 |
| transform evaluations | 488 | 488 |
| evaluated pairs | 1,830 | 1,830 |
| contact strip candidates | 25,788 | 25,788 |
| wall time | 94,402 ms | 94,368 ms |

Logical work is identical and sampling costs `+0.04%`. The only budget that
fired was a counted `evaluation-cap`, not a deadline.

## Baseline profile

Self time by category:

| Category | Self time | Share |
| --- | ---: | ---: |
| Effect runtime (fiber/effect machinery) | 22.15 s | 23.4% |
| Effect Schema (decode/validate) | 15.08 s | 15.9% |
| NFP/IFP candidate generation | 14.25 s | 15.0% |
| beam-state canonical keys | 10.74 s | 11.3% |
| canonical grid exact math | 7.01 s | 7.4% |
| search / decoders / portfolios | 6.17 s | 6.5% |
| GC | 5.54 s | 5.8% |
| placement validation / convex predicates | 4.01 s | 4.2% |
| clipper2 | 2.35 s | 2.5% |
| other geometry kernels | 2.12 s | 2.2% |
| spatial index | 1.81 s | 1.9% |
| canonical layout metrics | 1.51 s | 1.6% |

Framework machinery is roughly 39%; genuine geometry roughly 32%.

Inclusive time per `src/shared/irregular/domain.ts` constructor. **Nested and
overlapping — not additive, and not "independently removable runtime".**

| Class | Inclusive | Share |
| --- | ---: | ---: |
| `IrregularPlacedPiece` | 24.16 s | 25.5% |
| `TransformedCollisionGeometry` | 13.25 s | 14.0% |
| `IrregularPolygon` | 8.35 s | 8.8% |
| `IrregularPoint` | 5.54 s | 5.8% |
| `IrregularPlacementCandidate` | 4.04 s | 4.3% |
| `IrregularPlacement` | 3.98 s | 4.2% |
| `IrregularTransformCandidate` | 1.65 s | 1.7% |
| `IrregularTransform` | 1.64 s | 1.7% |
| `IrregularBounds` | 0.97 s | 1.0% |
| `IrregularNfp` | 0.04 s | 0.0% |

## Why nesting is the mechanism

`new IrregularPlacedPiece({ placement, collisionGeometry })` where
`collisionGeometry` is an **already-validated instance passed by reference**,
2,000,000-iteration microbenchmark after warm-up:

| Ring vertices | ns/op | plain object wrapper |
| ---: | ---: | ---: |
| 4 | 37,358 | 5 |
| 8 | 46,587 | 7 |
| 16 | 76,682 | 6 |
| 32 | 136,065 | 5 |
| 64 | 249,657 | 5 |

Cost grows linearly with vertex count at roughly `3,700 ns` per vertex: schema
construction rewalks the entire nested ring every time. `IrregularPlacedPiece`
reaches 25.5% from only 22 construction sites for exactly this reason, and
`irregularBeamState` rebuilds every placed piece with a fresh geometry, polygon,
and point set on each quarter turn.

`{ disableChecks: true }` is not a remedy: it moved `IrregularPoint` from
`402 ns` to `225 ns` against `4 ns` for a plain class. The cost is the schema
construction machinery, not only the checks.

## Paired committed result

The optimized report is generated from committed implementation
`701992da9a6930e15a3012b819ba711b054464f9`; the paired baseline is generated
from `ae7540979bec202b231f1bb642a683f6fd568ee0`. Both use the same command on
the same host without another measured workload running:

```text
node              v24.16.0
os                macOS 26.5.2, arm64
cpu               Apple M4 Max
```

| Committed stage | Wall time | Relative speed |
| --- | ---: | ---: |
| baseline `ae75409` | 78,695 ms | 1.000 |
| plain internal classes `701992d` | 48,827 ms | **1.612x** |

Both reports retain:

- collision identity
  `3839e80d26be257381f1962816765a886d4b7e3c3d78120892e4a6a943dfa742`;
- fitted canonical identity
  `ef2b783ae12491d2a80a12ef94d1bb2801c13cbd43aeb6e2c1cc00d86828fd3b`;
- `61 / 0` placed/unplaced accounting and identical bounds;
- five settled endpoints, 12,000 focused candidate evaluations, and 25,788
  contact-strip candidate evaluations;
- every production, trace, scheduler, observer, and directional check.

## Rejected in passing

Memoizing `canonicalPolygonDigest` and `polygonDigest` by point-array identity
was implemented and measured: **94,368 ms to 103,561 ms, a 0.91x regression**
with identical hashes. The premise was wrong. The hot path does not reuse point
arrays — `irregularBeamState` allocates fresh ones per rotation — so every probe
missed and paid the added `WeakMap` traffic. This is evidence that the digest
cost is a symptom of geometry reconstruction, not of a missing cache, and it is
another argument for attacking reconstruction directly.

## Files

- `mixed-61-2000x2700.baseline.cpuprofile.gz` — raw V8 CPU profile at `ae75409`
- `mixed-61-2000x2700.baseline-profiled.json` — report from the profiled run
- `mixed-61-2000x2700.baseline-unprofiled.json` — report from the unprofiled control
- `mixed-61-2000x2700.baseline-local-macos.json` — paired local baseline at
  `ae75409`
- `mixed-61-2000x2700.plain-classes-local-macos.json` — paired optimized report
  at `701992d`
