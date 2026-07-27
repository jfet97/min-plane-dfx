# Compact Short-Side Area-Cost Guard

Date: 2026-07-28

## Why the previous result was rejected

The accepted short-side matrix passed every numeric gate. The user rejected
the promoted directional layouts on sight: Triangle-20 roomy placed all twenty
triangles point-down in AABB-separated rows instead of the interleaved
herringbone production Compact had already settled in the same run's archive.
The interleaved arrangement occupies strictly less envelope area and, on
sheets where the shelf wraps to multiple rows, strictly less depth too.

Measured on the before-matrix: the promoted roomy shelf spans
`1,765.760 x 75.675 mm` at `133,623.888 mm2`, exactly `50%`
collision-envelope density, `20/20` isolated pieces, `0 mm` shared boundary,
and a `0.487` occupied-hull gap, replacing Compact's
`487.983 x 152.522 mm` at `74,428.143 mm2`, `89.8%` density, and `388.107 mm`
shared boundary. A sibling `1.795x` the Compact envelope was admitted because
no gate ever compared the candidate against Compact's packing quality.

## Diagnosis

Both admission stages gated only fill (`>= 80%`, itself a user-directed
correction), depth against Compact's maximum side, projection, cavities, an
absolute `0.5` density floor calibrated exactly at what AABB-separated
triangle rows achieve, and a fill-gain ratio that explicitly permits area
growth up to the fill gain. The strict no-regression comparator ran only
between the contact strip and the shelf/pair-fold incumbent, never against
production Compact. Stage 2 received only six production scalars.

On roomy sheets the conflict is structural: twenty padded triangles cannot
both interlock (zigzag span about `925 mm`, `46%` fill) and span `80%` of a
`2,000 mm` short edge (the `1,766 mm` spread row, `50%` density). The fill
floor therefore forces low-density layouts exactly when few small pieces meet
a roomy sheet, which is when the promoted sibling looks worst. Relaxing the
fill floor was rejected: it re-opens the settled product decision.

## Decision

Commit `903657e`. Both admission stages now require the exact BigInt bound
`3 * candidateEnvelopeAreaGrid2 <= 4 * productionEnvelopeAreaGrid2`: a
directional sibling may spend at most one third extra envelope area
(sacrifice at most one quarter of the production packing density when every
piece is placed) to buy requested-short-edge fill. The `80%` fill floor, the
shortfall-halving rule, and every pre-existing gate are unchanged; the
protected Compact path is byte-identical; the observer overhead is two BigInt
multiplications per admission evaluation.

Any bound inside `[1.214, 1.487)` reproduces the measured case outcomes;
`4/3` was chosen normatively as the point where the sibling retains at least
three quarters of the production density, not as the loosest villain bound.

Fallback outcomes are now three-valued. `short-side-satisfied-by-compact`
keeps its established `>= 80%` fill meaning. The new
`short-side-quality-protected-compact-fallback` reports a low-fill Compact
retention after a causal quality veto: at least one candidate passed every
pre-existing term and failed the area-cost term alone. Anything else below
the floor remains a `directional-miss`, and the gate contract becomes
`success + satisfied + quality-protected == 9 && miss == 0`.

## Accepted matrix evidence (commit `903657e`)

Nine unchanged Compact controls, byte-identical hashes. Sources: one archive
winner (Triangle-20 `600 x 400` zigzag, `1.214x`, kept), one contact-strip
winner (Mixed-61 roomy, `1.061x`, `100%` fill, kept), five Compact
satisfactions, two quality-protected fallbacks (Triangle-20 roomy shelf
`1.795x` vetoed, Shapes-17 roomy pair fold `1.487x` vetoed). Zero directional
misses. Observer runtime stayed in the same sub-second envelope per case.

Immutable manifest, reports, SVG/PNG renders, and checksums:
`/private/tmp/min-plane-provenance/short-side-area-cost-guard-903657e-matrix/`.
Accepted portable copies: `docs/artifacts/compact-short-side-area-cost-guard/`.
Design review: persistent codex dialogue (gpt-5.6-sol, xhigh), five findings
all accepted and applied (threshold math, distinct outcome, causal veto,
trace-interface correction, provenance flow).
