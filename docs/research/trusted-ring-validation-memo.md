# Trusted Ring Validation Memo

## Decision

Stop re-deriving what the trusted geometry path already established, without
moving the boundary that decides what is valid.

Two redundancies on the warm pairwise NFP path are removed without trusting
TypeScript `readonly` as runtime immutability. Each ring receives a linear exact
coordinate fingerprint; an unchanged array identity reuses its strict
validation result, while any mutation forces validation again. Each canonical
ring vertex key is built once instead of three times.

Strict validation remains the authority. Nothing skips it on first sight,
mutation invalidates the memo, and foreign or malformed values keep taking the
full check.

## Why the warm path is the whole path

`ConvexPolygonValidation.validateStrictBoundary` is quadratic in the vertex
count: the simple-ring check compares every non-adjacent edge pair, because a
star boundary can cross itself while every local turn keeps the same sign.

Before this change, one warm pairwise resolution ran that quadratic check four
times: over the fixed input, the moving input, the relative boundary read back
from the cache, and the translated ring. The hardened memo keeps the translated
ring check and replaces the other repeated quadratic checks with linear
fingerprint comparisons.

Reported cache telemetry over one `mixed-61 2000x2700` gate run suggests the
warm path is not a corner case:

| namespace | lookups | present | stores |
| --- | --- | --- | --- |
| `pairwise-nfp-relative-v3` | `266977` | `262166` | `4811` |
| `transform-collision-v1` | `10028` | `9540` | `488` |

`98.2%` of pairwise NFP lookups hit, against `4811` stores. The retained file
does not include source-ref or command provenance, so this is motivation rather
than independently reproducible evidence.

How much a quadratic check costs depends on the vertex-count distribution.
Across the 36 retained production artifacts (`332` rings) the median ring has
`5` vertices, but p90 is `28` and p99 is `107`. Weighted by `n^2`, the `6.6%` of
rings above 32 vertices account for roughly `77%` of validation cost. The tail
pays, not the median.

## Correctness evidence

Lint and both typechecks passed. The complete suite passed `895` tests with
`17` intentional skips across `87` files.

The canonical collision-polygon key is pinned by an oracle test that retains
the previous implementation verbatim and compares both input orientations over
a deterministic randomized corpus of `5000` polygons, including repeated
vertices and signed zero. An independent oracle-side classification proves that
more than `1000` cases require the reverse candidate. Start vertex independence,
winding independence for ordinary simple rings, and translation folding are
pinned separately.

The validation memo is pinned by cases proving a foreign valid ring is still
accepted, and that concave, too-short, non-finite, and non-ring values are still
rejected. Valid-to-invalid and invalid-to-valid in-place mutations force
revalidation, and replacing a stored entry with a malformed one still
recomputes.

The original identity-only candidate reported three alternating strict
`mixed-61 2000x2700` gate runs per ref. All six summaries contain the pinned canonical hash
`ef2b783ae12491d2a80a12ef94d1bb2801c13cbd43aeb6e2c1cc00d86828fd3b` and passed
every strict quality gate. The underlying SVGs and full reports were not
retained, so the reported byte and field comparisons are not independently
reproducible from the committed bundle.

The retained synthesized matrix summary reports that all 18 Compact and Short
Side layouts passed under each ref and that all 18 rendered SVG digests matched.
The underlying SVGs and raw reports are absent, so this is historical supporting
evidence rather than a portable reproduction.

The matrix omits its usual Chromium PNG renders: that step shells out to
Electron, which needs an X server this sandbox does not provide, and it fails
identically on `main`. The 18 layout gates completed and passed before it.

## Runtime observation

The original identity-only candidate reported three alternating
`mixed-61 2000x2700` runs per ref on one sandboxed Linux machine:

| ref | run 1 | run 2 | run 3 | median |
| --- | --- | --- | --- | --- |
| `main` | `50325` | `49871` | `51846` | `50325` |
| this branch | `44032` | `43531` | `47675` | `44032` |

Median elapsed time falls `12.50%` (`1.14292x`), and the two sets do not
overlap: the slowest branch run (`47675ms`) beat the fastest `main` run
(`49871ms`). The nine-baseline matrix took `212942ms` on `main` and `194943ms`
here, `8.5%` lower.

The original reports also claim a `20.6%` lower peak RSS delta. The raw traces
are absent, so that claim is not independently auditable here.

These are historical observations for the rejected identity-only trust
mechanism, not performance claims for the hardened fingerprint implementation.
The hardened implementation must be judged by fresh final-commit gates.

## Component measurements

The original experiment reported the following synthetic component numbers.
The raw benchmark records and commands were not retained, so these numbers are
motivation only and do not compose into an end-to-end claim.

Warm pairwise hit path, cost of strict validation:

| vertices | baseline | validation-free | ratio |
| --- | --- | --- | --- |
| 8 | `9414ns` | `4285ns` | `2.20x` |
| 16 | `28367ns` | `6752ns` | `4.20x` |
| 32 | `95474ns` | `11887ns` | `8.03x` |
| 64 | `355481ns` | `23440ns` | `15.17x` |

At 8 vertices one warm hit cost about `160%` of recomputing the relative
boundary outright, so at small vertex counts the pairwise cache was a net loss
before this change.

Canonical collision-polygon key, previous form versus the reduced-allocation
form, with byte-identical output asserted on every sample:

| vertices | 8 | 16 | 32 | 64 |
| --- | --- | --- | --- | --- |
| speedup | `3.07x` | `2.74x` | `2.52x` | `2.45x` |

## Not attempted

The translated ring is still validated on every warm resolution. It is a fresh
array each time, and floating-point translation can round three vertices into
collinearity, so identity memoization does not apply and the check is not
redundant.

The quadratic simple-ring test itself is left alone. It is replaceable by an
`O(n)` argument — consistent turn signs plus a total turning of exactly one
revolution rejects the star boundaries the current comment cites — but that
changes which inputs produce which rejection message, so it belongs to its own
change with its own falsifiers.

Portable evidence:
[`../artifacts/trusted-ring-validation-memo/`](../artifacts/trusted-ring-validation-memo/).
