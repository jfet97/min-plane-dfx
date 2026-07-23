# Irregular Production Gates

Use these gates for changes that can affect convex irregular geometry,
construction, source allocation, archive admission, ranking, final fit,
cancellation, history, or timeout behavior.

## Current Baselines

| Fixture | Sheet | Required result |
| --- | --- | --- |
| Triangle-20 | `2000 x 2700` | hash `371db269...`, area `74,428.143126 mm2`, zero canonical cavities, all pieces |
| Mixed-61 | `2000 x 2700` | fitted hash `ef2b783a...`, area `391,605.850174 mm2`, zero canonical cavities, all pieces |
| Shapes-17 | `2000 x 2700` | hash `c640c06f...`, area `304,499.845650 mm2`, zero canonical cavities, all pieces |

The exact hash and threshold assertions live in the tests and `package.json`.
This page summarizes them; it does not replace them.

The latest serial observations at adaptive-policy commit `2174c63` are
`12.635 s` for Triangle-20, `52.962 s` for Mixed-61, and `7.447 s` for
Shapes-17. All three SVG and PNG artifacts remain byte-identical to their
accepted predecessors. See the
[adaptive transform report](../research/adaptive-compact-transform-policy.md).

## Focused Correctness Gate

```sh
ELECTRON_RUN_AS_NODE=1 pnpm exec electron ./node_modules/vitest/vitest.mjs run \
  tests/unit/intrinsicSharedArchiveAdmission.test.ts \
  tests/unit/intrinsicSharedArchivePortfolio.test.ts \
  tests/unit/intrinsicCapacityMode.test.ts \
  tests/unit/intrinsicCapacityIntegration.test.ts \
  tests/unit/irregularTriangleCompactGolden.test.ts \
  tests/unit/irregularSeventeenShapesCompactGolden.test.ts
pnpm gate:mixed61-compact
```

The Mixed command is intentionally a one-sheet production-quality gate. Its
report sets `geometryEquivalent` to `null`; it is not an invariance result.

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

Run the archive-only production fixture across the complete historical roomy
matrix:

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

The current durable checkpoint contains only `900 x 1800` and `1000 x 1300`:
[`../artifacts/current-production-invariance-sample/`](../artifacts/current-production-invariance-sample/).
The wider run was cancelled and is not a passed gate.

## Archive Admission

A production compact result is valid only when:

- every direct role completes with one exact endpoint;
- periodic catalog work is not runtime-censored;
- every selected continuation runs and settles as completed or at its explicit
  deterministic evaluation cap;
- incomplete or evaluation-capped partial states do not enter the archive;
- final q0/q90 fit passes on the requested sheet;
- no piece is unplaced;
- canonical identity and topology are finite and valid.

The configured family, cell, source, and continuation caps are intentional
search bounds. Do not misreport them as exhaustive coverage.

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
