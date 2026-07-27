# Linear Ring Topology

## Decision

Decide the simple-ring question in linear time for rings whose corners all turn
the same non-zero way and whose binary64 coordinates lie inside a conservative
proved arithmetic envelope. Keep the historical quadratic sweep for every
other input.

Two further candidates were implemented, measured, and removed: a memo for the
pairwise cache-key polygon digest, and bisection for canonical entry insertion.
They are recorded here because the measurement that rejected them is the
substance of this report.

## Why the linear decision is admissible

`ConvexPolygonValidation.validateStrictBoundary` compares every non-adjacent
edge pair, because a consistent turn sign does not imply a simple ring: a star
crosses itself while every local turn keeps the same sign.

For a ring whose corners all turn the same non-zero way the edge directions
rotate monotonically, so the boundary closes without crossing itself exactly
when those directions complete one revolution. A star closes only after several.
Counting how often the edge direction stops pointing downwards counts those
revolutions.

The shortcut is restricted to zero or coordinate magnitudes between `2^-450`
and `2^500`. Within that envelope, representable coordinate differences and
the products used by orientation retain explicit binary64 underflow and
overflow margins. Inputs outside it take the historical sweep, including
finite extreme or subnormal values. This guard preserves the existing
predicate's exact observable behavior rather than assuming that every finite
binary64 value is a safe arithmetic operand.

Message order is the constraint that shapes the implementation. A
self-intersection is reported ahead of any turn failure, so the turn scan runs
first and withholds its outcome: rings with consistent turns inside the safe
envelope settle the question by counting revolutions, and every other ring goes
through the retained sweep. Every diagnostic remains ordered as before.

The sweep is still reachable for any concave ring and for numerically extreme
coordinates, so worst-case validation remains quadratic. That is deliberate.
The earlier instrumented run reported `73` turn-failing validations among
`3012117` calls; its retained summary is motivation rather than portable
reproduction evidence.

## What the measurements changed

An instrumented run corrected an assumption this work started from. The rings
actually validated on the hot path are small: `97.0%` have eight vertices or
fewer, `3.0%` have nine to sixteen, and none exceed sixteen. An earlier estimate
of a long vertex tail came from output-layout artifacts, which are not the rings
being validated.

Whole-run wall clock could not resolve the effect. Three alternating Mixed-61
runs per ref give medians of `43420ms` and `43132ms`, a `0.67%` difference with
overlapping sets. Timing each function in process instead:

| function | main | branch | saved | share of run | kept |
| --- | --- | --- | --- | --- | --- |
| strict validation | `854.2ms` | `514.1ms` | `340ms` | `0.79%` | yes |
| pairwise cache key | `487.7ms` | `364.0ms` | `124ms` | `0.29%` | no |
| canonical entry insertion | `126.1ms` | `111.2ms` | `15ms` | `0.035%` | no |

The digest memo was dropped because it returns a third of the validation saving
while carrying the review's demonstrated guard defect. The bisection was dropped
because `15ms` justifies nothing. Both removals were decided by a rule fixed
before the numbers were read.

Two candidates never reached implementation, for the same reason. Memoizing the
anchored per-piece key looked strong — `80.0%` of `4621726` constructions repeat
— until the fingerprint guard the architecture requires measured `7-31%` of the
key it protects, inconsistently. Memoizing
`bottomLeftAnchoredCanonicalOccupiedGeometryKey` per state returns nothing at
all: `249636` calls against `248610` constructed states is one call per state.

## Correctness evidence

Lint, both typechecks, and the complete suite passed on source
`8c1862010456f9da1b7f6b6a89f9cc5d4499ac36`: `901` tests passed and `17`
were intentionally skipped across `89` files.

The topology test retains the previous validator verbatim as an oracle and
compares the exact returned object, message included, over star families
spanning vertex counts 5 to 41, rings pinched by a duplicated non-adjacent
vertex, a vertex resting on a non-adjacent edge, axis-aligned rings in every
rotation and winding, and randomized corpora. It asserts that more than a
thousand comparisons land in the cell where turns are consistent and the ring
still crosses itself, because that is the only cell the revolution count answers
for alone; the first corpus reached it `28` times, which was not coverage.

An earlier review brute-forced `2753880` small-grid rings without divergence,
but a later review found that the retained test oracle had changed the
historical segment predicate and that extreme finite coordinates falsified the
unrestricted shortcut. The oracle now preserves the old predicate literally,
and a permanent regression proves that the extreme witness takes the fallback
and returns the historical self-intersection diagnostic.

The original paired and matrix summaries lack the branch source manifest,
commands, raw reports, and SVGs required for portable reproduction. They remain
historical motivation only.

The accepted final-commit matrix is committed under
[`../artifacts/linear-ring-topology/final-review/`](../artifacts/linear-ring-topology/final-review/).
Its manifest records source, command, and runtime; checksums cover every report,
SVG, PNG, summary, and manifest. All `18` layouts passed. Direct comparison
against the accepted PR #20 reference bundle found `0/18` SVG mismatches,
`0/18` PNG mismatches, and `0/18` canonical-identity mismatches.

## A narrowed guard, not a closed one

Review found that the fingerprint retaining a validation walked its ring through
the iterator while validation reads the ring by index, so a supplied iterator
could replay one content while the indexed positions moved underneath it. That
fingerprint now reads by index.

This narrows the divergence without closing it: coordinates behind accessors can
still change between the guard's read and validation's read within one call.
Closing that means copying every ring on every one of three million calls, which
would cost more than the whole change saves, and no caller in this worker
supplies anything but plain arrays of plain points. The limitation is stated in
the test header and the commit message.

Only the retained-rejection direction is observable, because a retained
acceptance still reaches construction, which validates the ring again. The test
covers that direction and fails if the iterator walk is restored.

## Not attempted

The defensive array copies in `IrregularBeamState`'s constructor are untouched.
Removing them would trade the immutability guarantee for a saving nothing here
measured.

The search, decoder and portfolio bucket of the profile was not measured at all.
This report is about the geometry and keying path, and says nothing about the
rest.

Portable evidence:
[`../artifacts/linear-ring-topology/`](../artifacts/linear-ring-topology/).
