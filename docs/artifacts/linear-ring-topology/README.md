# Linear Ring Topology

Historical summaries that motivated the guarded linear simple-ring decision,
and records for two candidates that were measured and then dropped. These
summaries are incomplete provenance: they do not retain both source revisions,
commands, raw reports, or rendered artifacts.

The accepted final-commit matrix and complete provenance belong under
[`final-review/`](./final-review/).

## `component-measurements.json`

The measurement that decided the change set. Whole-run wall clock cannot resolve
a one percent effect against nine percent run-to-run noise, so each function was
timed in process over one Mixed-61 run per ref.

| function | main | branch | saved | share of run | kept |
| --- | --- | --- | --- | --- | --- |
| strict validation | `854.2ms` | `514.1ms` | `340ms` | `0.79%` | yes |
| pairwise cache key | `487.7ms` | `364.0ms` | `124ms` | `0.29%` | no |
| canonical entry insertion | `126.1ms` | `111.2ms` | `15ms` | `0.035%` | no |

Both arms carry the same instrumentation overhead, so the difference is the
figure that means anything, not the totals.

## `paired-gate.json`

Three alternating strict Mixed-61 runs per ref. All six reported the pinned
canonical hash `ef2b783a…` and passed every strict quality gate.

The elapsed-time result is null and is recorded in full: median `43420ms` against
`43132ms`, a `0.67%` difference, with overlapping sets — the slowest branch run is
slower than every main run. That is consistent with the `0.79%` the component
measurement predicts, and it is not separable from noise. The case for this
change is the removed quadratic term, not an observable speedup.

## `nine-baselines-identity.json`

The synthesized summary reports that the strict nine-baseline matrix passed on
both refs with matching SVG digests. The branch revision, commands, raw reports,
and SVGs were not retained, so the claim is historical rather than portable
acceptance evidence.

The matrix omits its usual Chromium PNG renders: that step shells out to
Electron, which needs an X server this sandbox does not provide, and it fails
identically on both refs after all 18 layout gates have passed.

## `instrumented-corpus.json`

Counters added temporarily to one run and then reverted. They are what turned
two plausible candidates into rejected ones, and they corrected an assumption:
the rings actually validated on the hot path are small, `97%` at eight vertices
or fewer and none above sixteen. An earlier estimate of a long vertex tail came
from output-layout artifacts, which are not the rings being validated.

## `adversarial-review.md`

The original review record, including the brute force over `2753880`
small-grid rings and the findings that removed two optimizations. A later review
found an extreme-coordinate divergence that this corpus missed.

This README was added after generation and is intentionally outside the
generated checksum manifest.
