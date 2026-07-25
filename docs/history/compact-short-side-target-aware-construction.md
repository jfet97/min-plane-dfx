# Compact Short-Side Target-Aware Construction Pilot

Date: 2026-07-24

## Hypothesis

A width-one target-aware constructor might improve on the accepted Stage 1
archive winner by creating directional geometry during placement instead of
repairing a settled motif.

The experiment was predeclared as one Triangle-20 `600 x 400` pilot. A
directional arm that censored, failed to complete, or lost to Stage 1 would
stop the hypothesis without a reproduction or matrix run.

## Implementation

Commit `e19ddf1` added two opt-in shadow arms:

- a matched `legacy-absolute-envelope` control;
- a target-aware directional selector over the same strict candidate seam.

Both arms run sequentially in one process after production Compact and the
zero-search Stage 1 observer settle. They use fresh candidate memo scopes,
independent configured `12,000`-evaluation, `5,000 ms`, and `256 MiB`
sampled-RSS limits, and a shared configured `1 MiB` trace limit. Neither arm
can influence production output.

The directional arm rejects exact successor spans outside the requested
oriented sheet, retains the nondominated strict-local partial set, then
minimizes requested long-axis span and short-axis shortfall. The trace records
candidate counts, bound rejections, nondominated counts, selected identities,
best distinct discarded identities, memory, runtime, and first divergence.

Post-run review found that runtime and sampled RSS stopped before endpoint
finalization, and trace size was measured before its final self-referential
fields settled. Those measurements remain useful diagnostics but are not
fully enforced hard-budget evidence.

## Result

The two arms constructed all pieces under their configured limits and first
diverged at depth 1. The runtime and RSS values below are diagnostics, not
fully settled hard-budget measurements:

| Measurement | Matched control | Directional |
| --- | ---: | ---: |
| runtime | `1,494.924 ms` | `1,300.750 ms` |
| candidate evaluations | `3,265` | `2,980` |
| sampled RSS delta | `17,154,048 bytes` | `16,384 bytes` |
| used width | `341.785 mm` | `271.256 mm` |
| used height | `337.138 mm` | `380.723 mm` |
| envelope area | `115,228.711330 mm2` | `103,273.398088 mm2` |
| enclosed cavities | `0` | `0` |
| occupied-hull gap | `0.331255` | `0.288475` |

The directional construction is exact and complete, but it is not an
admissible sibling endpoint: its `0.288475` occupied-hull gap exceeds the
existing `0.15` floor. Even as a raw diagnostic, it loses to the already
available Stage 1 archive winner:

| Measurement | Stage 1 winner | Directional |
| --- | ---: | ---: |
| requested long-axis use | `228.786 mm` | `271.256 mm` |
| requested short-side fill | `98.731%` | `95.181%` |
| envelope area | `90,352.624692 mm2` | `103,273.398088 mm2` |
| occupied-hull gap | `0.086902` | `0.288475` |

Production remained exactly unchanged at `20/20`, `487.983 x 152.522 mm`,
`74,428.143126 mm2`, and zero canonical cavities. Its collision and fitted
hashes remained:

- `371db2696b65e2122b98bdb197a1d327df0c6ecbeca6ed73d2722971be52a127`;
- `b4d1fd9af8a1ecb4a17f1031546c1dbbb5afb19b2d99e41bdb646e52084092f7`.

## Decision

Reject this width-one target-aware selector from promotion and stop the
experiment. Do not run a reproduction or matrix under the same hypothesis.
Stage 1 is sufficient for the measured Triangle case and remains the accepted
short-side sibling profile.

This result falsifies only the greedy partial selector. It does not prove that
all construction-time diversity is useless, but another attempt needs a
materially different causal mechanism and a new review.

Post-run review also found that scored-state retention was accidentally active
in ordinary strict construction even when the observer was disabled. Commit
`edeed42` removes the entire rejected implementation and its tests while
retaining `e19ddf1`, this history, and the immutable artifacts as provenance.

## Protected width-four band follow-up

On 2026-07-25, commit `1163bd3` tested the separately reviewed fixed-width
construction alternative on Shapes-17 `2000 x 2700`. This was not the rejected
width-one selector: a private observer-only beam retained four exact,
canonically distinct roles for short-axis fill, long-axis depth, projection
coverage, and intrinsic compactness.

The predeclared finalization-inclusive limit was `5,000 ms`. The observer hit
that deadline after `6,118` candidate evaluations and only five completed
piece depths. Its best retained state spanned `402.892 mm` of the requested
`2,000 mm` short axis, far below the `1,600 mm` admission floor. It produced no
endpoint and did not affect production output.

Per the stop contract, there was no second reproduction or matrix expansion.
The width-four implementation and enumeration seam were removed. Raising the
cap, reducing the width, or replacing it with another greedy width-one
selector would continue the same unsupported hypothesis. A future reopening
requires a useful discarded directional future already generated by an
existing producer, followed by one bounded warm continuation; do not add that
cost without such a witness.

## Evidence

- source commit: `e19ddf1`
- immutable run:
  `/private/tmp/min-plane-provenance/short-side-construction-e19ddf1.ssQLhK/`
- report SHA-256:
  `df707cda76ddc3617768fdcb377c92ba8e7f13c125578c2211b721f036f0fe76`
- directional PNG SHA-256:
  `6272b4eaa5119c5ed1ec5914d0958a8b9eaecf0a7959ef578811827f8a6d45cd`
- rejected width-four source commit: `1163bd3`
- immutable width-four failure report:
  `/private/tmp/min-plane-provenance/short-side-band-1163bd3-run1/shapes-17-2000x2700.json`

## Exact shelf and terminal pair-fold follow-up

Commit `999e9fb` tested an exact, search-free one-row shelf on Shapes-17
`2000 x 2700`. It selected one minimum-width transform per piece and evaluated
all `136` transforms in `3.451 ms`. The resulting row required
`2007.195 mm`, exceeding the requested short edge by `7.195 mm`, so it was
rejected without transform reselection, a second row, or a matrix run.

The next reviewed experiment changed only that failed terminal packing.
Corrected source commit `2645e7c` enumerated all `136` unordered pairs over the
same fixed transforms and stacked exactly one pair. Two identical portrait runs and the
landscape transpose selected `shapes-17-1` below `shapes-17-10`, producing
the same canonical geometry at `1897.173 x 220.526 mm`, zero cavities, and
`50.2790%` collision-envelope density. Pair-fold runtime was `6.834 ms` and
`6.865 ms`; the transpose used `10.567 ms`.

The strict current-source matrix at `2645e7c` then passed 9/9 algorithm cases
and 18/18 rendered layouts with every production Compact hash and count
unchanged. The terminal observer measured only `2.462–6.912 ms` when eligible
and performed zero work on square sheets. The accepted implementation remains
single-process and sequential, runs only after the protected Compact and Stage
1 archive observer have no winner, and falls back exactly when no pair is
admitted.

Each standalone reproduction directory below contains both production and
short-side SVG/PNG renders, a manifest with the exact command and runtime, and
a verified `SHA256SUMS`.

Evidence:

- rejected row:
  `/private/tmp/min-plane-provenance/short-side-shelf-999e9fb-run1/`;
- deterministic pair-fold runs:
  `/private/tmp/min-plane-provenance/short-side-pair-fold-2645e7c-run1/`,
  `/private/tmp/min-plane-provenance/short-side-pair-fold-2645e7c-run2/`;
- transpose:
  `/private/tmp/min-plane-provenance/short-side-pair-fold-2645e7c-transpose/`;
- accepted matrix:
  `/private/tmp/min-plane-provenance/compact-short-side-pair-fold-2645e7c/`.

## Multi-row terminal follow-up

The accepted pair-fold matrix was later found insufficient as a feature gate:
it treated seven exact Compact fallbacks as successful short-side profiles.
Roomy Triangle-20 and Mixed-61 therefore remained corner clusters despite
passing the 18-layout accounting contract.

The next bounded terminal experiment retained one depth-minimizing transform
per piece during the existing transform evaluation and applied one
prepared-order next-fit shelf after a pair miss. At source `d57b7d6` it
produced:

- Triangle-20 `2000 x 2700`: `1765.760 x 75.675 mm`, `88.288%` fill;
- Mixed-61 `2000 x 2700`: `1987.776 x 301.187 mm`, `99.389%` fill in four rows.

Both remain exact, complete, zero-cavity layouts and pass the established
projection, density, production-depth, and area-cost guards. Two clean
Mixed-61 reproductions are byte-identical. The full sequential matrix keeps
all nine Compact controls exact and reports four generated directional
winners, five `short-side-satisfied-by-compact` results, and zero directional
misses.

Evidence:

- `/private/tmp/min-plane-provenance/short-side-multi-row-d57b7d6-run3/`;
- `/private/tmp/min-plane-provenance/short-side-multi-row-d57b7d6-run4/`;
- `/private/tmp/min-plane-provenance/short-side-multi-row-d57b7d6-matrix/`.
