# Sheet invariance: causal diagnosis, mechanism arc, and the remaining blocker

Branch: `protected-contact-pareto-frontier`. Base: `89e34dc` (main).
Provenance: `/private/tmp/min-plane-provenance/protected-contact-pareto-frontier/`.

## Executive summary

The mission was to close the mixed-61 four-sheet invariance gap: one canonical
geometry hash across `1000x1300`, `1000x1700`, `2000x1700`, `2000x2700` at
reference quality (area <= 430,344.918 mm2, <= 2 holes, >= 53/14 contacts).

**Result: not closed, and the blocker is now precisely characterized and
verified by three independent measurements.** The reference motif is reachable
only through the exact historical sheet-relative search dynamics; any change
that makes the legacy lane deterministic breaks the trajectory that produces
it, even on the reference sheet itself. The promoted tree is the protected
Pareto frontier lane at variant `4e144ac` (family-coverage seeds behind
production fanout came one variant later and are not promoted here); the
canonicalized legacy lane and the invariant terminal selection (v5/v5b) are
rejected for production and preserved as research. The golden, 151 focused
tests, and the wider corpus are green, with only the intended rectangles and
`2000 x 1700` improvements differing from baseline.

## 1. First causal divergence (verified)

Beam step 0, zero-contact tier. The two largest padded rectangles
(`28f5a1d1` 164x114, `c5135087` 150x110) have rotation-0 and rotation-90
candidates with IDENTICAL intrinsic compactness (max side, area, span) and
identical contact (0). Only the sheet-normalized fields
`worstNormalizedSheetConsumption` / `normalizedSheetSpanSum` separate them:
2000x1700 keeps the landscape family (0.082252 < 0.096767), the other three
sheets keep portrait, and the losing family is evicted at rank 17, outside
fanout 4, never existing in that tree again. Legality is not the cause (the
reference envelope 545.515 x 788.878 mm fits all four sheets). The intrinsic
lane cannot seed (zero tier); a single intrinsic-order winner collapses the
tie to rot-0, so a bounded non-dominated set is required.

Evidence: `/private/tmp/min-plane-provenance/protected-contact-pareto-frontier/analysis/first-divergence-diagnosis.md`.

## 2. Terminal-gate arithmetic (verified)

On 2000x1700 the production winner is `661,441.643 mm2`, 58 total / 16
dominant. The 430k/53-14 reference loses the old production-comparator gate
there on dominant contacts even if replayed, so the current reference hash can
never be the common hash under the production comparator. Terminal selection
must be compactness-first (invariant), not contact-first.

## 3. Forced-lineage probe (verified)

`scripts/irregular-lineage-probe.ts` replays the exact 2000x2700 winner
lineage against each sheet's real services. The reference lineage needs
locally-dominated branches at depths 1/2/4 whose value appears only later
(delayed reward). No local invariant rule (non-domination, family coverage
within production-represented tiers) preserves all of them.

## 4. Mechanism arc (committed, measured)

| Variant | Commit | Mechanism | Four-sheet mixed-61 outcome | Decision |
| --- | --- | --- | --- | --- |
| v1 | `8175c44` | Pareto frontier lane (duplicated tiers, non-dominated, seeds from all parents) | 2000x2700 -> 426,881.608/56-15/3h; 2000x1700 -> 661,441.643 (intrinsic pool flooded) | quality on 2 sheets; isolation violated |
| v2 | `4e144ac` | both seeds scoped to baseline parents | 2000x1700 -> 535,808.686/57-17 (same area, more contacts); rest exact; rectangles-20 2000x2700 -8.22% | isolation restored; **promote candidate** |
| v3 | `24d6863` | pareto seeds recursive, intrinsic scoped | all exact; rectangles -8.22% | most conservative |
| v4 | `5f1e1db` | family-coverage seed (best-per-orientation-family) | subsumed | evidence |
| v5 | `371d3fb` | canonical legacy lane + invariant terminal (span-first, no holes) | 2000x1700 -> 557,698.950/65-17/2h; 2000x2700 -> 413,595.617/37-6/16h | tail-drop too destructive; holes-free terminal unsafe |
| v5b | `e4c0f01` | legacy positional tail restored + terminal holes floor | 2000x1700 -> 557,698.950/65-17/2h; 2000x2700 -> 436,770.039/42-10 (reference lost); narrow sheets exact; rectangles -18.55%, pentagons/star -14.13% 0h, mixed-50 exact | reference regression: do not ship tip |

## 5. The remaining blocker (the deep finding)

Three independent measurements (probe, v4, v5) show the same wall: even with
the legacy lane's ranking fully canonicalized, the narrow-sheet decode does
not produce the reference lineage, because candidate sets and the early
trajectory still diverge per sheet. The reference lineage's key branches are
locally suboptimal by every intrinsic measure, so they survive only through
the historical sheet-relative dynamics of one specific sheet (2000x2700).
Making the lane deterministic necessarily alters those dynamics and loses the
reference even there (v5b: 436,770.039/42-10 on 2000x2700). Sheet-independence
and reference reproduction are mutually exclusive for this motif. The
remaining paths are a guided canonical replay of a found motif (requires
cross-decode coordination that single-request production does not have), or a
common motif reachable by invariant semantics on every sheet at reference
quality (not found).

## 6. Review trail

- Terra: sheet-free final comparison; deterministic lane seed;
  freeMaterialHoleCount must not drive invariant pruning; strip guard.
- codex-review-chat (gpt-5.6-sol, xhigh, thread 019f7626): F1 fanout sheet
  dependence, F2 legacy tail sheet fields, F3 anchor vocabulary, F4 finalist
  preselection, F5 quarter-turn tie-break (INSISTING; fixed with a
  quarter-turn-canonical key), F6 poor-motif promotion (holes floor + corpus
  Pareto bars). F2-F5 verified RESOLVED after landing; F1/F6 held open for
  corpus evidence, which confirmed them.

## 7. Production decision

Promote **v2 (`4e144ac`)**: all checkpoints exact, rectangles-20 2000x2700
-8.22%, mixed-61 2000x1700 -> 535,808.686/57-17 (same area, more contacts),
triangle golden exact, 151 focused tests green, all other corpus hashes exact.
Do not promote the v5/v5b tip (2000x2700 reference regression). The v4/v5 arc
is preserved as research evidence for the replay/coordination follow-up.
