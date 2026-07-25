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

## One-row terminal shelf follow-up

Commit `999e9fb` then tested a search-free rigid shelf over the existing
prepared transform catalog. The exact Shapes-17 `2000 x 2700` construction
reached the final piece after `136` transform evaluations in `3.451 ms`, but
required `2007.195 mm` of the `2000 mm` short edge. It therefore produced no
endpoint and left Compact unchanged.

The SVG preview that suggested `1977.520 mm` was not authoritative because it
rotated already placed polygons outside the prepared transform catalog. Per
the predeclared contract, the one-row implementation was removed without a
second run or matrix. The precise `7.195 mm` overflow justifies one new,
separately reviewed pair-fold pilot, not modification of the failed run.

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
- rejected one-row source commit: `999e9fb`
- immutable one-row failure report:
  `/private/tmp/min-plane-provenance/short-side-shelf-999e9fb-run1/shapes-17-2000x2700.json`
