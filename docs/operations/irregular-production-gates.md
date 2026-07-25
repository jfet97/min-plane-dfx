# Irregular Production Gates

Use these gates for changes that can affect convex irregular geometry,
construction, source allocation, archive admission, ranking, final fit,
cancellation, history, or timeout behavior.

## Current Baselines

| Fixture | Sheet | Required result | Observed runtime |
| --- | --- | --- | ---: |
| Triangle-20 | `2000 x 2700` | collision hash `371db269...`, area `74,428.143126 mm2`, zero canonical cavities, 20/20 pieces | `14.942 s` |
| Mixed-61 | `2000 x 2700` | fitted hash `ef2b783a...`, area `391,605.850174 mm2`, zero canonical cavities, 61/61 pieces | `69.361 s` |
| Shapes-17 | `2000 x 2700` | collision hash `1ddc8426...`, area `281,233.148068 mm2`, zero canonical cavities, 17/17 pieces | `12.658 s` |
| Triangle-20 | `600 x 400` | collision hash `371db269...`, area `74,428.143126 mm2`, zero canonical cavities, 20/20 pieces | `14.749 s` |
| Mixed-61 | `600 x 400` | collision hash `2c53f312...`, area `239,484.966600 mm2`, zero canonical cavities, 25/61 pieces | `4.591 s` |
| Shapes-17 | `600 x 400` | collision hash `01b2060d...`, area `232,178.021694 mm2`, zero canonical cavities, 14/17 pieces | `12.874 s` |
| Triangle-20 | `300 x 300` | collision hash `0f5befd7...`, area `78,811.504488 mm2`, zero canonical cavities, 17/20 pieces | `15.841 s` |
| Mixed-61 | `300 x 300` | collision hash `bb22df35...`, area `89,504.369008 mm2`, zero canonical cavities, 6/61 pieces | `1.338 s` |
| Shapes-17 | `300 x 300` | collision hash `e4ad1ce1...`, area `87,791.951625 mm2`, zero canonical cavities, 5/17 pieces | `3.030 s` |

The exact collision and fitted hashes, placed/unplaced partitions, area and
cavity limits, and generous runtime ceilings live in
`scripts/irregular-compact-nine-baselines.ts`. The observed runtimes above came
from the no-options sequential run at `acb4186`; they are measurements, not exact
timing assertions. Portable reports and renders are under
[`../artifacts/current-compact-baselines/`](../artifacts/current-compact-baselines/).

Triangle-20 retains the same canonical complete geometry on both roomy sheets.
Every constrained result has an exact disjoint placed/unplaced partition.

## Focused Correctness Gate

```sh
ELECTRON_RUN_AS_NODE=1 pnpm exec electron ./node_modules/vitest/vitest.mjs run \
  tests/unit/intrinsicSharedArchiveAdmission.test.ts \
  tests/unit/intrinsicSharedArchivePortfolio.test.ts \
  tests/unit/intrinsicCapacityMode.test.ts \
  tests/unit/intrinsicCapacityIntegration.test.ts \
  tests/unit/intrinsicReconstructionPortfolio.test.ts \
  tests/unit/irregularTriangleCompactGolden.test.ts \
  tests/unit/irregularSeventeenShapesCompactGolden.test.ts
pnpm gate:mixed61-compact
pnpm gate:compact-nine-baselines
```

The Mixed command is intentionally a one-sheet production-quality gate. Its
report sets `geometryEquivalent` to `null`; it is not an invariance result.
The nine-baseline command runs serially and covers the roomy complete path plus
`600 x 400` and `300 x 300` constrained final-fit/capacity behavior.

When short-side capture is enabled, the same command also requires nine
material short-edge outcomes and zero directional misses. An observer winner
must pass exact legality, accounting, topology, density, projection, depth, and
area-cost admission. Compact reuse passes only when the materialized geometry
already fills at least `80%` of the relevant edge, and is reported as
`short-side-satisfied-by-compact`. The accepted matrix and individual visual
review are under
[`../artifacts/compact-short-side-observer/matrix/`](../artifacts/compact-short-side-observer/matrix/).

## Constrained Capacity Gate

```sh
pnpm gate:capacity
```

Runs the constrained capacity fixtures through the full production
coordinator in paired production and cold-only arms. It fails when routing,
exact placed/unplaced partitioning, deterministic capacity settlement, the
zero auxiliary-evaluation contract, all-piece-depth coverage, or the
prefix-not-below-cold-only guarantee under the complete capacity objective is
violated. Reports and sheet-outline SVG renders land under
`/private/tmp/irregular-capacity-gate/` by default.

## Full Current Sheet Matrix

Run the no-options intertwined production coordinator across the complete
historical roomy matrix:

```sh
pnpm corpus:sheet-invariance \
  --case mixed-61 \
  --sheets 900x1800,1000x1300,1000x1700,1100x1100,1200x1600,1400x1100,1500x2200,1700x1000,2000x1700,2000x2700 \
  --strict \
  --output /private/tmp/min-plane-provenance/current-shared-archive-sheet-matrix
```

Before claiming invariance, require:

- coverage-complete, uncensored construction for every run;
- the same sheetless leader wherever it fits at q0 or q90;
- one canonical collision geometry and normalized SVG for those sheets;
- explicit classification of fit-boundary divergence;
- a complete report, exact source commit, runtime versions, commands, hashes,
  and portable renders.

The full matrix passed twice at `6179cef` on 2026-07-24. All twenty decodes
placed `61/61` pieces, returned canonical hash `ef2b783a...`, area
`391,605.850174 mm2`, zero canonical cavities, and byte-identical normalized
SVGs. Reports and portable renders are archived under
[`../artifacts/current-production-invariance-matrix/`](../artifacts/current-production-invariance-matrix/).

## Complete-Archive Admission

A complete endpoint may enter the protected complete archive only when:

- every direct role completes with one exact endpoint;
- periodic catalog work is not runtime-censored;
- every selected continuation runs and settles as completed or at its explicit
  deterministic evaluation cap;
- incomplete or evaluation-capped partial states do not enter the archive;
- canonical identity and topology are finite and valid.

The configured family, cell, source, and continuation caps are intentional
search bounds. Do not misreport them as exhaustive coverage.

The coordinator applies requested-sheet q0/q90 fit after intrinsic complete
construction. A fitting complete endpoint has no unplaced pieces and dominates
every capacity endpoint. On constrained sheets where no complete endpoint fits,
the separately protected capacity archive may instead return an exact
canonical-legal placed/unplaced partition.

## Cancellation, Progress, History, and Timeout

- Renderer cancellation and the outer request timeout terminate the worker and
  return no partial result.
- Internal archive checkpoints protect long construction phases, but they are
  not a substitute for the supervisor boundary.
- Archive progress reports `shared_archive` and then `completed`.
- Archive history is zero frames when history is off. Otherwise it reveals the
  selected exact layout from empty through one additional final placement per
  frame. Intermediate frames are tagged
  `shared-archive-selected-layout-reveal`; the last is
  `shared-archive-final-selected`. This supports timeline and GIF inspection
  without claiming beam ancestry.
- Canonical occupied-union cavities and requested-sheet free-material holes are
  distinct metrics.
- The irregular request timeout floor is `390,000 ms`. Internal experimental
  decoder budgets may use smaller values; they are not the worker timeout.

## Provenance

For every reported layout, retain the source commit and any diff, exact fixture
and request, sheet, optimizer settings, runtime environment, metrics, SVG/PNG,
and hashes. A performance result must also retain selected sources, per-source
status/evaluation counts, archive order, and coverage flags.

Accepted and rejected evidence belongs under
[`../artifacts/`](../artifacts/README.md). Detailed experiment interpretations
belong under [`../research/`](../research/index.md); decisions belong under
[`../history/`](../history/README.md).
