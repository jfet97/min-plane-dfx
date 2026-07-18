# First current-main four-sheet divergence: causal diagnosis

Base commit: `89e34dc438f50c3aebbea73b0f7af8d72e32a03b` (verified live, clean tree).
Traces: `baseline/traces/mixed-61-<sheet>.decision-trace.ndjson` (bounded, historyMode final;
canonical hashes match the corpus exactly: 25143934..., 03c10b1b..., 236f5f40..., 40f8ac9c...).

## Verdict

The first causal divergence is a **local-fanout rotation-family eviction at beam step 0**
(the very first placement), in the zero-contact tier, driven solely by the
sheet-normalized compactness fields of the production local comparator.

## Evidence

Step 0, empty parent, first-priority pieces (padded rectangles):

- `28f5a1d1-afd4-46e4-b2b9-f1841386be28-copy-1..3` (real 154 x 104, padded 164 x 114,
  longest edge 164, area 18,696);
- `c5135087-12f0-44f9-bd91-4bcf67affd8b-copy-1` (real 140 x 100, padded 150 x 110).

For `28f5a1d1-copy-1`, the rotation-0 and rotation-90 candidates have **identical intrinsic
compactness** (maxSide 164.504, area 18,836.366016 mm2, span 279.008 mm) and identical
contact tier (0 mm, first placement). Only the sheet-normalized fields differ:

| Sheet | rot 0 worstNorm / normSpan | rot 90 worstNorm / normSpan | fanout winner | evicted family |
| --- | --- | --- | --- | --- |
| 1000 x 1300 | 0.164504 / 0.252584 | 0.126542 / 0.241046 | rot 90 (ranks 1-4) | rot 0 at rank 17 |
| 1000 x 1700 | (same pattern as 1000x1300) | | rot 90 | rot 0 outside fanout |
| 2000 x 1700 | 0.082252 / 0.149607 | 0.096767 / 0.154019 | rot 0 (ranks 1-4) | rot 90 at rank 17 |
| 2000 x 2700 | 0.082252 / 0.124661 | 0.060927 / 0.118179 | rot 90 (ranks 1-4) | rot 0 at rank 17 |

`c5135087-copy-1` repeats the pattern: rot 0 selected on 2000 x 1700
(worstNorm 0.075252), rot 90 selected on 2000 x 2700 (worstNorm 0.055742 vs 0.075252).

- Legal candidate count: canonically identical on all sheets (sheet-corner absolute
  positions differ; canonical geometry identical). Legality is NOT the cause.
- Contact tier: exact shared-boundary length 0 for every candidate (first placement).
  The intrinsic contact lane cannot seed (positive tier required), so no protected
  mechanism covers this decision.
- The intrinsic local tie-break (transform index) would collapse the maxSide/area/span
  tie to rot 0 (t0) on every sheet. On 2000 x 1700 that seed is already in production
  fanout, so a single intrinsic winner adds nothing there; only a non-dominated SET
  keeps both tied orientation families. This is the concrete width-one insufficiency.
- Production fanout keeps only the aspect-favored family; the evicted family never
  becomes a successor, so no beam-level or terminal mechanism can recover it.

## Downstream cascade

All further splits build on this: on 2000 x 1700 the tree develops from rot-0 parents
(ends in the 535,808.686 mm2 / 4-hole ring); the other three sheets develop from rot-90
parents but keep splitting at steps 1-2 through the same sheet-normalized ranking
(e.g., step 1: `c5135087-rot90 + 28f5a1d1-rot160.346@(9.039,243.872)` retained ranks 4-5
on 1000 x 1700, pruned ranks 14-15 on 1000 x 1300 and 2000 x 2700; step 2: 39 canonical
signatures differ, including divergent intrinsic-lane survivors anchored to different
sheet edges).

## Consequence for the candidate mechanism

A protected Pareto frontier within exact contact strength addresses exactly this:
within the (zero) contact tier, rot-0 and rot-90 are tied on every sheet-independent
objective, so both are non-dominated and a bounded frontier seed keeps both without
consuming production fanout. The seed must allow the zero tier (the current intrinsic
seed's positive-tier restriction is what leaves step 0 uncovered), must stay behind
production fanout (never replace a production candidate), and its descendant pruning
must use only sheet-independent fields so the same canonical frontier survives on
every sheet.
