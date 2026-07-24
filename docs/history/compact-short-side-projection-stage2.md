# Compact Short-Side Fixed-Target Stage 2

Date: 2026-07-24

## Hypothesis

One exact midpoint target, seeded from the accepted Stage 1 guarded Pareto
archive winner, might improve directional short-side behavior without a new
construction engine.

The experiment was intentionally narrow: one seed, one target, one exact
projection, one process, no target sweep, and no production-output influence.

## Implementation

Commit `2fcd44d` added:

- exact canonical-grid target derivation;
- a catalog-compatible inverse-axis q90 seam;
- behavior-neutral scored-candidate telemetry in exact projection;
- explicit censoring, rejection, and protected-fallback outcomes;
- an opt-in baseline artifact hook;
- focused target, telemetry, observer, and integration tests.

Commit `8f66399` corrected the checkpoint policy after the first measurement.
Cooperative checkpoints remain exactly counted, but they are accounting-only;
scored candidates, runtime, sampled memory, trace size, and dilation remain the
hard budgets.

## Results

Triangle-20 `600 x 400` was the sole real fixture, chosen before execution
because Stage 1 has its strongest accepted directional signal there.

The v1 control censored at checkpoint `25,001` after `73.898 ms`, only `133`
scored candidates, and six dilation attempts. This proved the checkpoint cap
measured NFP cooperation granularity rather than proportional search work.

The one authorized v2 rerun used the identical `400 x 197.907 mm` projection
target. It settled rejected after `330.309 ms`, `1,281` scored candidates,
`86,784` checkpoints, and `17` dilation attempts. Exact closure exhausted at
`triangle-copy-17`; no complete projected endpoint existed.

The production result remained:

- collision hash
  `371db2696b65e2122b98bdb197a1d327df0c6ecbeca6ed73d2722971be52a127`;
- fitted hash
  `b4d1fd9af8a1ecb4a17f1031546c1dbbb5afb19b2d99e41bdb646e52084092f7`;
- `20/20` pieces;
- `487.983 x 152.522 mm`;
- `74,428.143126 mm2`;
- zero canonical cavities.

## Decision

Reject this single-midpoint projection mechanism from promotion. Do not sweep
targets or add seeds under the same hypothesis. The accepted Stage 1 archive
observer remains intact and production Compact remains unchanged.

The result leaves one materially different future direction: a separately
budgeted target-aware construction producer that creates directional geometry
during placement instead of repairing a settled motif afterward. That requires
a new reviewed experiment; it is not implied by this rejection.

## Evidence

- `/private/tmp/min-plane-provenance/short-side-projection-stage2-manifest.json`
- `/private/tmp/min-plane-provenance/short-side-projection-2fcd44d-run1/`
- `/private/tmp/min-plane-provenance/short-side-projection-8f66399-run2/`
