# V7 Irregular Search Redesign: Review And Decision Memo

Reviewer basis: branch `v7-geometric-cohesion` at required base commit
`d56d9d7` ("Reject ineffective pressure restarts"), reviewed and extended from
descendant branch `v7-search-redesign-review`. Every source citation below is
against that tree unless a commit is named. Every measurement below was
produced on this machine from committed harnesses; no number is inherited from
the briefing without a local reproduction, and the memo says so explicitly
where a briefed number could not be reproduced.

External references were re-cloned and read at their pinned revisions under
`/tmp/v7-nesting-references/`: Deepnest `2fb1051`, SVGnest `1248dc2`,
libnest2d `663daa6`, PackingSolver `3d8d97dd`, Sparrow `961ec31`,
Dalsoo-Bin-Packing `bde2a3e`.

# Executive Verdict

**`REPAIR_THE_GATE_THEN_CHANGE_THE_MOVE_VOCABULARY`** — with three measured
results delivered on this branch:

1. **The production engine at the required base commit was completely broken,
   and no gate noticed.** Commit `48abf69` (2026-07-20, "Complete V7 feature
   coverage provenance") removed the empty-layout seed candidate from
   `generatePlacementCandidatesUncached`. Because the production windowed beam
   requests the `contact-only` candidate domain for every policy except
   short-side-fill, the first placement of every production decode received
   zero candidates, every piece was recorded unplaced, and terminal
   orientation died with "terminal irregular layout has no legal quarter-turn
   orientation". The Triangle golden test, the entire windowed-beam suite, and
   every production decode failed from that commit through `d56d9d7` — one
   line, undetected for the branch's most productive day, because all V7
   evidence generation runs through the sheetless intrinsic paths that bypass
   the production beam, and doc-only commits skip tests by policy. Repaired in
   one commit (`6bcba8c`); the focused suites return exactly to their
   documented pre-`48abf69` state. This is the single most important process
   finding of this review: the branch's stated regression gate was not being
   exercised by the workflow that mattered.

2. **The adaptive-pressure line is correctly diagnosed as move-vocabulary
   bound, and the mission's smaller-contraction falsifier measures the wrong
   variable.** Source reading (this tree and Sparrow's) shows the pressure
   composite moves one collider at a time along its minimum-translation-vector
   with only finite transform swaps as an alternative; Sparrow's separator —
   the mechanism the project says it is following — relocates *every* colliding
   item per pass through ~75 sampled positions plus two-phase coordinate
   descent. Contraction step size does not change what the walk can reach; it
   changes only how much overlap the walk must remove. Both were run anyway as
   a controlled matrix from the same pinned exact seed under equal budgets
   (results below); the vocabulary arm is the informative one.

3. **The branch's own headline compact seed is retention-evicted by its own
   bounded frontier.** The celebrated 74,428.143126 mm² Triangle two-band
   witness (hash `371db269…`) is *not reproducible from the default committed
   harness*: its shared basis `x:(88.972,0);(0,76.261)` is generated and then
   evicted (`cellsBeforeFront: 1, cellsRetained: 0`) by the 16-cell per-source
   front, at `d56d9d7` and at `9da94e2` alike. It exists only as a
   source-survival-audit diagnostic. The default-run archive's best entry is
   102,182 mm² — 37 % worse than the witness the plan reasons about. A bounded
   witness-admission repair (`96368ca`) makes the raw-crop Pareto front
   compete in the shared archive under an explicit flag, which restores the
   74k endpoint to the archive it should have been winning all along.

The recommended architecture (detailed in "Recommended Production
Architecture") keeps the mission's shape — generic exact constructors →
behavior-aware bounded retention → one shared exact archive → optional
faithful coordinated improvement → deterministic budget controller → exact
final sheet fit — with two corrections learned here: retention repairs must be
driven by the *raw-front vs bounded-front* gap the source-survival audit
already measures, and the coordinated stage must adopt Sparrow's per-item
sampled relocation before any further budget, ratio, or restart tuning is
worth money.

# Current Architecture And Failure Model

The engine has four layers with clean authority boundaries:

1. **Exact geometry authority.** Canonical integer-grid Clipper2
   (`canonicalLayoutGeometry.ts`) decides identity, topology, cavity/hull
   measurement, and endpoint admission. Robust convex predicates
   (`placementValidation.ts`) are the fast local legality authority for
   candidate filtering. SAT penetration (`intrinsicTransformSeparator.ts`)
   guides relaxed movement and never admits or rejects an endpoint.

2. **Candidate generation.** `nfpIfpService.ts` produces IFP corners, NFP
   vertices, antiparallel edge supports, IFP/NFP and NFP/NFP intersections;
   the intrinsic (sheetless) paths add origin-anchor candidates and the
   occupied-envelope event family. Direct validation filters every point.

3. **Search.** Production: the windowed beam (`windowedBeam.ts`) with
   protected lanes. Research: the intrinsic strict decoder
   (`intrinsicStrictDecoder.ts`, greedy per depth, full transform-family
   coverage before selection, modes pure-growth / legacy-absolute-envelope /
   contact-band / gap-contained), the 13-role reconstruction portfolio, the
   periodic family portfolio, the Stage 2A partial geometric beam, and the
   adaptive-pressure/squeeze controller (`intrinsicSqueezeDisruptSeparate.ts`).

4. **Selection.** The shared exact archive (capacity 8) ranks completed
   layouts by two Pareto axes — compactness (max side, envelope area, span)
   and void topology (cavities, cavity area, hull gap, hull waste) — with
   exact contact receiving one bounded selection turn and no veto.

The failure model, sharpened by everything since the first review, has four
distinct modes that must not be conflated:

- **Candidate absence** — repaired once (envelope events, `1d527bc`) and
  since then audited to exhaustion for the periodic P1/P2 sources; not the
  current binding constraint.
- **Retention loss** — *live and measured twice in this review*: the raw-crop
  Pareto witness eviction (F2 below) and, historically, the delayed-value
  witness evictions of the Stage 2A calibrations.
- **Movement vocabulary** — live and now directly measured: the pressure loop
  cannot clear distributed conflicts because its per-collider move set is
  MTV-directional (F4 below).
- **Budget/scheduling truncation** — live: Mixed-61 continuation coverage is
  wall-clock-bound and machine-dependent (this machine completed 4/8
  continuations where the author machine completed 1/8, and found a better
  endpoint purely by being faster — F6 below).

# What Changed Since The Previous Review

The previous review (`reviews/fable5-v7-search-quality-review.md`) localized
the far-neighbour certificate defect. Everything it demanded was implemented
and honestly measured by the branch:

- `8ec00b4..9da94e2`: certificate demoted to a diagnostic; finite crops
  materialized with one shared BigInt lattice translation, direct-validated,
  canonically admitted. Triangle produced the 74,428.143126 mm² zero-cavity
  two-band witness; Mixed produced the 426,530.392211 mm² zero-cavity
  endpoint (both reproduced on this machine — see next section).
- `3110a56..a7c697f`: the raw source-survival audit proved the complete raw
  crop Pareto set for the generated domain has ten members, all fragmented or
  worse except the 74k witness; no compact exact-contact lattice is hidden
  behind the caps *among the crops the current generator produces*.
- `9848e17..37fd64f`: the exact two-contact periodic source was implemented
  and honestly falsified: 11 exact contact translations, 4 non-collinear
  pairs, 2 fail the material bound, 2 collide under 3×3 repetition, 0
  admitted bases.
- `8e1e123..d56d9d7`: adaptive incumbent pressure with contraction schedule
  5 %/2.5 %/1.25 %, cumulative budget reservations, adaptive sweep depth, and
  the paired restart ablation that rejected cross-target restart transport.

This memo's contribution on top: the production-gate regression and its
repair, the reproducibility audit of the 74k witness, the equal-budget
smaller-contraction and move-vocabulary matrix, the witness-admission
retention repair, and the external-source re-audit from fresh pinned clones.

# Evidence Reproduced On This Machine

All raw provenance is under `/private/tmp/min-plane-provenance/`; compact
copies of accepted evidence are committed under
`help/artifacts/v7-search-redesign/`.

| Claim | Source run (this machine) | Result |
| --- | --- | --- |
| Triangle raw Pareto set has 10 witnesses incl. 74,428.143126 / `371db269…` | `v7-search-redesign-6bcba8c/triangle-20-adaptive-ablation` | Reproduced exactly (10 witnesses, same areas/topology) |
| Restart ablation, capacity 0 | same | losses 0.042353645 / 0.008297379 / 0.000525129, 57.1 s, 51,373 evals, no exact endpoint — byte-equal to briefed values |
| Restart ablation, capacity 3 | same | 0.013267824 / 0.003116739, 56.2 s — byte-equal to briefed values |
| Mixed-61 periodic 426,530.392211 / `310adc64…` | `v7-search-redesign-6bcba8c/mixed-61-periodic` | Reproduced; plus a **new** completed endpoint 420,059.254 mm², 0 cavities, 33/10 contacts, 23 isolates (`a79f6148…`) because this machine completed 4/8 continuations inside the same 25 s deadlines |
| 74k witness reproducible from default harness | `v7-search-redesign-6bcba8c/triangle-20-periodic` (+ re-run at `9da94e2` in a worktree) | **Not reproduced** — witness basis generated, `cellsRetained: 0`; default archive best is 102,182 mm² (F2) |
| Production golden state | focused suites at `6bcba8c` vs `48abf69~1` worktree | identical 28-failed/102-passed baseline; engine functional again; remaining failures are the documented ancestry regression (short side 305.631 > 228) |

The cross-machine determinism result deserves emphasis: the pressure-loop
loss trajectories reproduce to the last printed digit across two machines,
while Mixed-61 *continuation coverage* does not reproduce at all, because the
former is evaluation-budgeted and the latter wall-clock-budgeted. The
determinism boundary in this codebase is exactly the boundary between
evaluation caps and wall-clock caps, and Mixed's periodic evidence sits on
the wrong side of it.

# Findings Ranked By Severity

**F1 — The production decode was completely broken at the base commit
(fixed here).** `48abf69` dropped the `placed.length === 0` IFP-seed branch
from `generatePlacementCandidatesUncached` while folding provenance tags into
the IFP-corner path. Under `candidateDomain: 'contact-only'` (requested by
`windowedBeam.ts:471-475` for every policy except short-side-fill since
`a726b60`), an empty layout has no NFP boundaries and no IFP corners, so the
decode places zero pieces. Verified by bisection: works at `634bf21`
(`48abf69~1`), broken at `48abf69` through `d56d9d7`. Repaired in `6bcba8c`
by restoring the single bottom-left IFP seed with its `ifpCorner` provenance
tag. Process lesson: the golden is a *gate*, but nothing runs it — the V7
harnesses exercise only `src/workers/algorithm/irregular/intrinsic*`, and the
Markdown-only-commit rule waived tests exactly when the tree was most active.
A pre-push hook or CI running the four focused suites would have caught this
within minutes.

**F2 — The branch's best Triangle seed is unreachable through its own
default pipeline (repaired behind a flag).** The shared basis
`x:88972/1,0/1;0/1,76261/1` is enumerated but evicted from the axis-union
source-kind front (`periodicCellFront`, `intrinsicPeriodicCells.ts:630-657`;
ranking `compareCells`, `:2175-2188`: 3×3-contact priority, then density,
max side, hull waste, shared boundary). The 74k crop's cell loses the
16-slot front to denser or contact-complete cells whose *crops* are all
worse. This is a textbook instance of the delayed-value problem the mission
asks about (question B6): the binding irreversible pruning boundary in the
periodic pipeline is the **cell front**, which ranks by cell-local proxies
(density, contact-completeness) that are provably non-predictive of crop
quality — the highest-priority cells produce the 102k–240k archive entries
while the evicted basis produces the 74k witness. `96368ca` routes the
already-computed raw-crop Pareto front (bounded at 16) into continuation
selection as source-tagged `raw-witness:` seeds behind `--admit-raw-witnesses`.

**F3 — Nothing in the committed tree reproduces the number the plan
reasons about.** Beyond F2's mechanism: the exact invocation that produced
the 74,428 report at `9da94e2` is not recorded in the repository (plan.md
cites only the machine-local report path), and this review could not find
*any* flag combination at `9da94e2` that emits it except the raw-witness
diagnostic at later commits. Decision-gating numbers must carry their replay
command in-repo; this was already Required Plan Correction 7 of the previous
review and remains only half-adopted.

**F4 — The pressure move vocabulary is structurally unable to clear
distributed conflicts, and this is now measured, not argued.** Source facts:
per composite visit, a collider's candidate set is its conflict-MTV
translation (×1 and ×2) plus finite transform swaps
(`intrinsicFocusedProposalsForPiece`, `intrinsicTransformSeparator.ts`);
commits are weighted-nonworsening with 0.1 % slack
(`selectIntrinsicPressureCompositeChoice`); the loss is a sum of squared
normalized penetration depths, so exchanging one deep overlap for several
shallow ones lowers loss while conflict cardinality rises (the recorded
V6.2/ablation behavior). Sparrow's separator — the explicitly cited model —
relocates every colliding item per pass through ~25 focused + ~50 uniform
position samples refined by two-phase coordinate descent
(`sparrow/src/sample/search.rs`, `coord_descent.rs`; steps ±0.25/±0.02 then
±0.01/±0.001 × item min-dimension, grow ×1.1 / shrink ×0.5), with weight
multipliers 1.2–2.0 and 0.95 decay (`quantify/tracker.rs`). The missing
mechanism is position sampling + descent, not step size, restarts, sweeps,
or budget. The matrix below tests exactly this.

**F5 — The mission-mandated smaller-contraction ablation is a low-information
experiment (run anyway, as mandated).** With the same vocabulary, a smaller
final contraction (0.625 % instead of 1.25 %) only reduces the amount of
overlap to remove; the reachability of a zero-conflict state under
MTV-directional moves is unchanged. Its only positive gate (a canonical-exact
endpoint) was correctly predicted by the source reading to stay unreachable —
see Experimental Results. The arm cost ~1 minute and closes the branch per
the plan's standing stop rule, which is the correct bureaucratic outcome;
the vocabulary arm is where the information is.

**F6 — Mixed-61 periodic evidence is machine-relative because continuations
are wall-clock-budgeted.** 25 s/continuation and 240 s/fixture caps select
*which endpoints exist*. This machine: 4 completed / 4 deadline; author
machine: 1 / 7 — and the extra completions include a 420,059 mm² zero-cavity
endpoint that beats the briefed 426,530 seed. A "conclusive Mixed periodic
negative" cannot be declared from any wall-clock-truncated run, on any
machine, per the plan's own rule — and the plan's Mixed numbers are already
superseded by hardware. Continuations need an evaluation budget (the decoder
already counts evaluations) with the wall clock as a safety abort only.

**F7 — The default periodic archive never contains a baseline.** The
portfolio archive ranks only periodic continuations
(`runIntrinsicPeriodicFamilyPortfolio`); the ordinary width-3 production
baseline and the pocket-first reconstruction endpoint never compete in-run.
This was F6 of the previous review, accepted as Route 4, and remains
unimplemented. The witness-admission repair (`96368ca`) reduces but does not
close this gap: constructive baselines still live in a different harness.

**F8 — The sheet-invariance corpus was silently broken with the production
beam (consequence of F1), and post-repair behavior is production evidence.**
`scripts/irregular-sheet-invariance.ts` decodes through the production beam;
from `48abf69` to the repair every corpus case would fail with the
quarter-turn error. Runs after `6bcba8c` are the first sheet-invariance
evidence since the regression.

**F9 — Determinism of the new vocabulary is bounded by design but the
refinement ring has one accepted imprecision.** The sampled-relocation
refinement rings around the best candidate's pose translate expressed in that
candidate's canonical frame; if the moved piece defines the layout's
bottom-left anchor, the canonical re-anchor shifts the frame by the anchor
delta, so the refinement ring lands offset by that delta. All candidates
remain legal, deterministic, and evaluated under the same accounting — the
descent target is merely displaced in a bounded, reproducible way. Recorded
here so a future exactness pass doesn't rediscover it as a bug.

# Construction And Candidate Generation

Answers to mission questions C10–C14, from source and this review's runs:

**C10 (how sources should compete).** The mechanism already exists in
embryo: every constructor emits frozen exact seeds; seeds complete through
the one strict decoder; endpoints rank in the one archive. What is missing is
*membership*: the periodic archive omits baselines (F7) and omitted its own
best seed (F2). The correction is not a new comparator but an admission rule:
any bounded, source-tagged, deterministic seed producer may enter, and the
run report must record for every producer its best endpoint and its best
*evicted* candidate (the audit already computes the latter for periodic
sources — generalize it). Concretely: one portfolio run should decode, under
one budget report, {ordinary strict, reversed, endpoint-derived q0/q90,
open-pocket-first (and gap-contained variants), periodic continuations,
raw-crop witnesses}, all into the same 8-slot archive. Nothing in the
architecture prevents this today; it is harness consolidation, not research.

**C11 (generalizing the 405k open-pocket-first result).** The pocket
mechanism (`intrinsicGapRegions.ts` + `selectGapContainedWinner`,
`intrinsicStrictDecoder.ts:637-655`) is generic: gap regions are the convex
hull minus the occupied union; a candidate contained in a gap is preferred by
region area then shared boundary. Its weakness is scheduling, not geometry:
pockets are only checked for the *scheduled* piece, so pocket opportunity
still depends on the piece order — exactly the cavity-access failure the old
help.md filler experiments hit. A first-class cavity queue needs: cavity
birth = a new bounded region in the hull-minus-union decomposition
(measurable incrementally at each placement); accessibility = existence of a
direct-legal gap-contained candidate for some remaining geometry class
(the discriminator already computes this one representative per class);
assignment = smallest remaining class that fits with maximal region-area
consumption; scheduling = one bounded look-ahead slot per depth (the
commensurate two-order barrier from Stage 2B is the right admission
discipline, already specified in plan.md). This is the highest-leverage
constructive follow-up and needs no new geometry.

**C12 (finite motif grammar beyond P1/P2).** Not yet justified. The
two-contact source falsification (37fd64f) is complete for Triangle's
measured domain, and the raw-Pareto audit shows the *crops* the current
sources generate already contain the best-known compact seed. The blocking
loss was retention (F2), which is now repaired. Revisit richer motif grammars
(3+-member cells, supercells) only after a homogeneous fixture with a known
compact motif fails a coverage-complete run *with witness admission on*.

**C13 (NFP pool verdict).** Retain unchanged. Every mechanism this review
measured runs on the NFP/IFP + direct validation + canonical Clipper2 stack,
and both defects found were above it (a removed seed branch; a front
ranking). Nothing here justifies replacing candidate generation, direct
legality, global legality, or replay.

**C14 (Dalsoo/Abey transfer).** The F0 conclusion stands: the finite pose
families exist in generation. The still-untransferred Abey ideas that this
review's evidence supports are (a) hole-first *scheduling* (C11 above) and
(b) rebuild orders derived from an existing layout — the reconstruction
portfolio already implements (b). Controlled kicks and join/release remain
correctly deferred.

# Pruning And Delayed Value

Answers to B6–B9:

**B6 (which boundary loses the most).** Measured ranking on current
evidence: (1) the periodic **cell front** (F2 — loses the best-known seed);
(2) **continuation wall-clock truncation** (F6 — loses completed endpoints
by hardware); (3) the Stage 2A **whole-state beam** (historically measured:
the delayed-value witness dies at every tested width; but its best recovered
improvement was 0.0003 % — low value); (4) local candidate fanout (no
current witness of loss after the envelope-event repair). The first two are
cheap to fix and were fixed/flagged in this review; the third is expensive
and its measured upside is negligible on Triangle.

**B7 (generic delayed-value retention).** The generalizable pattern behind
`96368ca`: *every bounded front must publish its raw non-dominated set, and
an explicit arm must be able to admit that raw set into the terminal
competition.* This is not another comparator tuple: it reuses each front's
existing dominance definition and changes only what is allowed to compete.
It is bounded (a Pareto front over ≤6 objective fields is small in practice:
10 for Triangle's 4,627 crops), deterministic, and self-auditing (the front
vs bounded-front gap is the retention loss, printed per run). Apply the same
pattern next to the Stage 2A beam: retain the per-depth Pareto-layer-0 raw
front digest in the trace, and allow a bounded "front-replay" arm that
continues evicted layer-0 members. That is the trace-only counterfactual the
mission's minimum experiment 2 asks for, and the periodic instance of it was
implemented and measured here.

**B8 (cheap surrogates for later value).** The periodic evidence is a
warning: the cell front's surrogates (density, 3×3 contact completeness)
were *anti*-predictive of crop quality. Any proposed surrogate must first be
validated exactly as F2 was falsified: correlate the surrogate's ranking
with realized endpoint ranking over a completed run's raw front, in the
report, before it is allowed to prune. The codebase already has the right
instrument (source-survival audits); make surrogate-vs-outcome correlation a
standard report field wherever a front caps.

**B9 (phase-aware dedup and histories).** The future-equivalence key
(occupied geometry + remaining interchangeability order + unplaced set +
reorder debt) is correct and should not be weakened. The measured risk is
not the key but capacity eviction after dedup; nothing in this review
justifies changing the key.

# Coordinated Contraction And Global Search

Answers to A1–A5 and D15–D19, now with measured backing:

**A1/D15 (is the smaller-step ablation the right falsifier; smallest missing
Sparrow step).** No / per-item sampled relocation with coordinate descent.
Facts from the two source trees are in F4. The composite's only
position-changing move is the conflict MTV (and its double); Sparrow's is a
75-sample position search per item per pass with descent refinement. The
implemented `sampled-relocation` vocabulary (commit `e77f3c1`) adds, per
collider visit: two 8-direction compass rings at ¼ and 1/16 of the piece's
characteristic length, 12 Halton-covered legal bottom-left positions inside
the contracted box, and up to two shrinking-ring refinement rounds around
the best candidate — all deterministic, all inside the unchanged
weighted-nonworsening commit, evaluation accounting, GLS weights, and
canonical-exact-only promotion gate.

**A2 (what smaller step is geometrically justified).** Continuation of the
existing geometric halving (5 %, 2.5 %, 1.25 % → 0.625 %), i.e. ratios
[1/20, 1/40, 1/160] replacing only the final target so the failure chain's
earlier arms remain identical. Budgets are frozen equal by construction: the
same 50,000-evaluation pressure reservation, restart capacity 0, wall
deadline 240 s (never binding on Triangle), same pinned seed hash.

**A3 (why loss falls while conflicts spread).** Structural, from the loss
definition: squared normalized depths reward converting one deep overlap
into several shallow ones; the GLS increment (+1 on the maximum-utility
conflict) is too weak to redirect it (compare Sparrow's multiplicative
1.2–2.0). The scalar objective is therefore descending into exactly the
dead basin the trace shows (8 wall / 24 pair conflicts at loss 0.0005).

**A4 (should conflict topology enter retention).** Yes, with bounded weight,
and the cheapest faithful form is already in Sparrow: multiplicative
per-conflict weights with decay. A second-order improvement after the
vocabulary lands; not before, because under MTV-only moves no weighting can
create the missing positions.

**A5 (exact finalization mechanism).** Not justified yet. Projection exists
and works (measured in the coordinated pilot); the failure is that no
relaxed state gets close enough to be worth projecting. Finalization tuning
before vocabulary repair would hide the real boundary.

**D16 (what should move).** Pieces first (sampled relocation), components
second. The rigid component-interface pilot already proved rigid legal
component translation is a dead end on Triangle; component moves matter only
inside the relaxed phase (group-transport exists there) and only after
single-piece relocation stops being the binding constraint.

**D17 (breaking rings).** The disruption vocabulary (swap, group-transport,
split-squeeze, interface-disrupt) is adequate *if* the subsequent separation
can actually re-pack — which returns to the vocabulary. No new ring-breaking
mechanism is justified until sampled relocation is measured on Mixed.

**D18 (which coordinated family).** Deterministic sampled relocation +
descent (implemented) first; LNS destroy/repair second (the targeted-LNS
probe's negative was on the old fragmented seed and deserves a rerun from
the 74k/420k seeds if pressure with the new vocabulary still fails);
infeasible populations last (the restart ablation already rejected the
cheapest population form).

**D19 (the exact handoff).** Keep the current contract: only
canonical-exact, strictly-improving endpoints promote; projection bounded by
catalog-size dilation steps; archive admission through the shared exact
archive. It was exercised end-to-end by the coordinated pilot and is not the
bottleneck.

# Online Portfolio And Budgeting

Answers to E20–E25, evidence-first:

**E20 (tiers).** The measured cost structure supports three honest tiers:
*fast* = ordinary production beam (seconds; unchanged); *default* = beam +
bounded reconstruction portfolio (the 13 roles cost ~tens of seconds and
already contain the best Mixed result); *high* = + periodic portfolio with
witness admission (adds ~1–4 min, evaluation-bounded after F6's repair);
*max* = + adaptive pressure with the sampled vocabulary (adds its 50k
evaluations, ~1 min on Triangle-class jobs, several on Mixed-class).
Determinism per tier is preserved exactly insofar as every stage is
evaluation-budgeted; F6 is the one repair required before the high tier can
be called deterministic.

**E21 (instance fingerprint).** PackingSolver's precedent
(`optimize.cpp:431-602`) selects algorithms from objective type and
copies-per-type/items-per-bin ratios — all cheap instance traits. The
equivalents here are already computed during preparation: family
multiplicity (periodic arm is pointless below multiplicity ~4), collision
area dispersion (the ≥4× scale-diversity trait already gates production
escapes), and transform-family count. A first deterministic router: run the
periodic arm only when some family multiplicity ≥ 4; run pocket-first roles
only when ≥ 2 distinct geometry classes; pressure only in max tier. This
needs no learning and no new measurements.

**E22 (progress signals for early stop).** From the pressure traces: the
two-flat-sweep rule already implements loss-based early stop *within* an
attempt; what is missing is an *evaluation-transfer* rule between arms. The
matrix reports below include per-attempt cumulative evaluation start/end, so
a controller can transfer unused reservation forward deterministically —
the accounting machinery (`pressureAttemptEvaluationLimit`) already rolls
unused budget; extend the same idea portfolio-wide (unused periodic
continuation evaluations flow to pressure, etc.). Relaxed loss alone is
correctly excluded as a signal by the plan; completed-endpoint archive
admissions and coverage-complete flags are the honest signals.

**E23 (parallel arms with deterministic replay).** Yes — PackingSolver's
NotAnytimeDeterministic pattern (parallel execution, private outputs,
replay in registration order) fits this codebase directly because arms are
already isolated Effect programs with private outputs and the archive
compares completed layouts only. Wall-clock completion order must not matter
— which again requires F6's evaluation budgets first.

**E24 (making the high tier online-viable).** The measured hot spots from
the plan's own timing runs (scoring/topology ≫ canonical admission ≫
candidate generation) mean warm NFP caches and staged topology (already
landed for the beam) are the transferable optimizations for the strict
decoder used by continuations; nothing new is proposed here beyond applying
the existing staged-measurement pattern to `finalizeIntrinsicStrictState`.

**E25 (promotion path).** Research harness → optional quality mode requires:
evaluation-budgeted determinism end-to-end (F6 repair), the consolidated
portfolio run of C10, latency gates per tier (default ≤ 30 s on Mixed-61
hardware-class, high ≤ 240 s), memory gate (the audit's full-witness
retention is bounded at 16 placements-lists), and the golden/corpus gates on
every ranking change — which after F1 must be enforced by automation, not
convention.

# Sheet Invariance

Answers to F26–F28:

**F26 (hidden sheet-normalized fields).** The intrinsic research pipeline is
sheet-free by construction and audit: the strict decoder's candidate domain
is sheetless, its comparators use absolute geometry, and sheet dimensions
appear only in the monotone q0/q90 fit gate and final-sheet legality
(re-verified in this review's source audit). The *production* beam remains
sheet-normalized in local and whole-state ranking — a known, documented,
deliberate legacy (help.md). No new leakage was found.

**F27 (one rigid layout, multi-sheet fit).** Already the architecture of
every V7 path: sheet-free construction, terminal q0/q90 fit. The remaining
work is production adoption, which is a product decision beyond this
branch's evidence.

**F28 (strongest invariance guarantee short of identical hashes).** When
candidate legality itself differs across sheets, the honest guarantee is:
identical canonical geometry *whenever the selected sheet-free layout fits*,
plus a recorded fit-failure fallback chain (next archive entry that fits).
The archive provides this for free — the guarantee should be stated in docs
rather than engineered further.

# Open-Source And Paper Transfer Audit

Fresh clones at pinned revisions were read directly (agent-assisted, file:line
citations verified in the reports retained in the session record):

- **Sparrow** (`961ec31`): the decision-critical mechanism is the separator's
  per-item position sampling (25 focused + 50 uniform) with two-phase
  coordinate descent, executed for every colliding item per pass by 3
  workers, under multiplicative GLS weights (×1.2–2.0, decay 0.95), an
  infeasible pool restored by a low-loss-biased stochastic rule, and
  large-item-swap disruption; explore shrinks the strip 0.1 % per success
  with time split ~540 s explore / 60 s compress. Transferred here:
  deterministic per-item sampled relocation + shrinking-ring descent
  (commit `e77f3c1`). Deliberately not transferred: stochastic restore,
  free rotation, strip objective, parallel workers (determinism first).
- **PackingSolver** (`3d8d97dd`): portfolio routing from instance traits and
  deterministic parallel replay (E21/E23 above). Confirmed again that
  `periodic_packing` and `large_item_first` are *not* called from
  `optimize()` at this revision — they are references, not precedents of
  production integration.
- **libnest2d** (`663daa6`): orientation-family coverage before truncation —
  already implemented in the strict decoder; objective-callback separation
  supports the archive-owned selection this codebase already has.
- **Deepnest/SVGnest**: unchanged lessons (absolute envelope pressure,
  GA as order/rotation diversity, contact as bounded bonus); nothing new to
  transfer.
- **Dalsoo** (`bde2a3e`): re-confirmed the Abey path is edge-derived
  orientation tuning, the hull objective is axis-skewed and
  formula-inconsistent between its own branches, and feasibility is
  non-robust — reference only. The Abeysooriya accepted manuscript's
  hole-first placement remains the strongest untransferred idea (C11).

# Implemented Variants

All on branch `v7-search-redesign-review`, each with focused tests, default
behavior preserved:

1. **`6bcba8c` — Restore empty-layout placement candidate seed.** One-line
   geometry-pipeline repair (plus provenance tag); returns the production
   beam, golden gate, benchmark runner, and sheet-invariance corpus to
   operation. No search-policy change.
2. **`e77f3c1` — Pressure ratio schedule + sampled relocation vocabulary.**
   `IntrinsicGlobalSearchSchedule` gains optional
   `pressureContractionRatios` and `pressureMoveVocabulary`; the composite
   accepts `moveVocabulary` and, under `sampled-relocation`, augments every
   collider visit with deterministic ring + Halton target-box candidates and
   ≤2 shrinking-ring refinement rounds; harness gains
   `--adaptive-pressure-matrix` (arms `baseline-mtv`, `smaller-step-mtv`,
   `sampled-relocation`, `sampled-relocation-smaller-step`; restart capacity
   0; equal 50k evaluation reservations; same pinned seed). Defaults
   reproduce the previous behavior byte-for-byte (63/63 suite green).
3. **`96368ca` — Admit raw-crop Pareto witnesses to archive competition.**
   `--admit-raw-witnesses` (requires the source-survival audit) turns the
   bounded raw Pareto front into source-tagged continuations deduplicated
   against retained seeds, finalized through the unchanged strict decoder,
   ranked in the same archive.

# Experimental Results

## The equal-budget pressure matrix (E-A + E-B)

Both fixtures, four arms each, from the same pinned exact seeds
(Triangle: 74,428.143126 / `371db269…`; Mixed: 426,530.392211 / `310adc64…`),
restart capacity 0, wall deadline 240 s/arm (never binding), the same
50,000-evaluation pressure reservation, identical seeds and orderings. The
only positive gate was a canonical-exact strictly-improving endpoint.

**Triangle-20** (`v7-search-redesign-e77f3c1/triangle-20-pressure-matrix`):

| Arm | Ratios | Vocabulary | Loss @5 % | @2.5 % | @final | Final conflicts (pairs/pieces) | Evals | Runtime | Exact endpoint |
| --- | --- | --- | ---: | ---: | ---: | --- | ---: | ---: | --- |
| baseline-mtv | 5/2.5/1.25 % | mtv | 0.042354 | 0.008297 | 5.25e-04 | 26 / 17 | 51,373 | 56.9 s | **none** |
| smaller-step-mtv | 5/2.5/0.625 % | mtv | 0.042354 | 0.008297 | **3.63e-06** | 12 / 16 | 51,373 | 54.8 s | **none** |
| sampled-relocation | 5/2.5/1.25 % | sampled | 0.037986 | 0.005896 | 8.54e-04 | 25 / 19 | 51,373 | 56.2 s | **none** |
| sampled + smaller | 5/2.5/0.625 % | sampled | 0.037986 | 0.005896 | 4.30e-05 | 17 / 16 | 51,373 | 54.4 s | **none** |

**Mixed-61** (`v7-search-redesign-96368ca/mixed-61-pressure-matrix`):

| Arm | Loss @5 % | @2.5 % | @final | Final conflicts | Evals | Runtime | Exact endpoint |
| --- | ---: | ---: | ---: | --- | ---: | ---: | --- |
| baseline-mtv | 0.126384 | 0.037917 | 9.81e-03 | 25 / 26 | 48,373 | 148.4 s | **none** |
| smaller-step-mtv | 0.126384 | 0.037917 | 2.66e-03 | 18 / 22 | 45,246 | 143.4 s | **none** |
| sampled-relocation | **0.046460** | **0.021777** | 6.69e-03 | 33 / 29 | 52,235 | 193.6 s | **none** |
| sampled + smaller | 0.046460 | 0.021777 | **2.23e-03** | 25 / 24 | 52,235 | 187.3 s | **none** |

Readings, in decreasing certainty:

1. **The preregistered stop rule fires on both fixtures.** Eight arms, equal
   budgets, zero admissible endpoints. Per plan.md's standing rule ("if
   neither equal-budget arm produces an admissible endpoint, stop this
   pressure branch"), the adaptive-pressure branch is closed — not the idea
   of coordinated repair, but this contraction-framed, penetration-loss-driven
   instance of it.
2. **The smaller-step arm is the definitive dead-basin exhibit.** At 0.625 %
   contraction the Triangle walk reaches raw loss 3.6e-06 — six orders of
   magnitude down — while still carrying 12 pair conflicts across 16 pieces:
   microscopic penetrations distributed over most of the lattice, exactly the
   state the plan predicted lower relaxed loss would purchase. Nothing about
   this state is close to exact legality; the metric is simply exhausted.
3. **The sampled vocabulary is a materially better mover on heterogeneous
   geometry and an irrelevant one on a dense lattice.** On Mixed it reaches
   2.7× lower loss at the 5 % target (0.0465 vs 0.1264) and 1.7× at 2.5 %,
   with 12,700+ of its evaluations spent in sampled/refinement candidates;
   on Triangle it helps the early targets and loses the final one. The
   interpretation is geometric: contracting a dense repeated lattice by even
   0.6 % of one axis requires re-phasing many pieces at once (a coordinated
   basis change), which no single-piece move — sampled or not — can express;
   a loose heterogeneous layout has real per-piece slack the sampler finds
   quickly. The vocabulary is retained (default-off) as the per-piece
   primitive for any future coordinated stage.
4. Budget accounting held exactly (the cumulative-thirds reservations and
   rollover reproduce; Triangle arms consumed identical evaluation counts),
   and no wall deadline was hit — the negatives are budget-complete, not
   censored.

## Witness admission (E-C)

Triangle-20 with `--source-survival-audit --admit-raw-witnesses`
(`v7-search-redesign-96368ca/triangle-20-witness-admission`, replayed
hash-identically in `…-replay`):

| Archive entry (top of rank) | Area mm² | Max side | Cavities | Isolates | Components | Note |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| `4b87d6df…` (raw witness) | **90,352.625** | **394.922** | 0 | **7** | **9** | three-band lattice; new archive winner; the most cohesive V7 Triangle endpoint yet surfaced by committed machinery |
| `d7c135d4…` (raw witness) | 70,206.416 | 920.595 | 0 | 20 | 20 | one-row strip; smallest area, worst shape — correctly not selected |
| `371db269…` (raw witness) | 74,428.143 | 487.983 | 0 | 10 | 11 | the previously machine-local headline seed, now archive-resident |

Without the flag, the same run's archive tops out at 102,182 mm² with 14
isolates. Controls: rectangles-20 (single-component, zero-isolate 376,727 mm²
lattice with 31/16 contacts) and pentagons-20 (zero-isolate 208,200 mm² front)
run clean with the flag on; witness admission adds only entries, never
removes. Two full replays produced identical archive hash sequences and
winners.

## Sheet invariance and legal divergence (production path, post-repair)

First working production-path corpus runs since `48abf69`
(`v7-search-redesign-96368ca/sheet-invariance-subset`, `…/sheet-divergence-*`):

| Case | Sheets | Result |
| --- | --- | --- |
| triangle-golden-20 | 1000×1700 vs 2000×2700 | geometry-equivalent (`d9d6605a…`), 20/20 — the documented ancestry shape (305.631 short side), not the approved golden |
| rectangles-20 | same pair | geometry-equivalent (`397a5d6b…`), 20/20 |
| mixed-61 | same pair | geometry-equivalent (`f58cf0f2…`), 61/61, 435,949.517 mm², 0 cavities, hull gap 0.2404, 23 isolates |
| mixed-61 | 660×1200 vs 2000×2700 | still equivalent — the 654.13-wide common layout fits a 660 sheet |
| mixed-61 | 640×1200 vs 2000×2700 | divergent (`b8e47901…`, 638.8 wide, 61/61) — divergence occurs exactly when the common layout stops fitting |

The full seven-fixture corpus (triangle-golden-20, rectangles-20,
trapezoids-20, pentagons-20, star-hulls-20, mixed-50, mixed-61) was then run
on the same roomy pair: **all seven cases are geometry-equivalent**, with
mixed-50 placing 50/50 (`fa981c54…`, 747.9 × 748.2 mm) — the first fully
invariant roomy-sheet corpus result recorded for the production path
(`v7-search-redesign-96368ca/sheet-invariance-full`).

This is the measured form of the F28 guarantee: identical canonical geometry
whenever the selected sheet-free layout fits, different legal geometry
exactly at the legality boundary, no preference leakage detected on the
tested pairs.

## Anytime and budget measurements (E-D)

From the Mixed-61 default periodic run: catalog ≈ 12.9 s; first exact
endpoint (426,530 / `310adc64…`) at 59.8 s; best endpoint (420,059 /
`a79f6148…`) at 208.6 s — produced by the *last*-ranked continuation seed,
which is also the smallest-area seed (13,124.6 mm² for 8 placements). The
topology-first seed ranking scheduled a 20-placement, 133,624 mm² seed first,
which deadlined. Counterfactual on the same recorded data: seed-area-ascending
scheduling delivers the best endpoint at ≈ 38 s instead of 208.6 s. At the
10 s and 30 s checkpoints the periodic arm contributes nothing on Mixed;
early anytime value must come from the constructive portfolio. Additionally,
continuation coverage is machine-relative (4/8 completed here vs 1/8 on the
author machine under identical 25 s deadlines — F6), so any scheduling
improvement must ride on evaluation budgets to be a deterministic claim.

# Recommended Production Architecture

The mission's target shape survives this review intact; every correction is a
membership or budgeting rule inside it, not a new mechanism:

```text
generic exact constructors
  ordinary strict (pure-growth) · reversed · endpoint-derived q0/q90
  · open-pocket-first (+ gap-contained variants)
  · periodic continuations · raw-crop Pareto witnesses      <- F2 repair
-> behavior-aware bounded retention
  every capped front publishes its raw non-dominated set,
  and an explicit arm may admit that set to terminal competition
  (the generic delayed-value rule measured here)
-> one shared exact archive
  compactness + void Pareto, contact one bounded turn (unchanged),
  with constructive baselines as first-class entries          <- F7 repair
-> optional faithful coordinated improvement
  adaptive incumbent pressure with per-item sampled relocation
  + descent (implemented), promoted only by canonical-exact
  strict improvement (unchanged gate); currently CLOSED on
  Triangle by the preregistered stop rule — reopen only with a
  mechanism that can re-phase a dense lattice (LNS destroy/repair
  from archive endpoints is the next candidate, not more pressure)
-> deterministic online budget controller
  evaluation budgets everywhere wall clocks now decide (F6),
  instance-trait routing (family multiplicity, class count,
  scale dispersion), seed-area-ascending continuation order
  (measured 38 s vs 208 s to best endpoint on Mixed),
  cumulative reservation rollover generalized portfolio-wide
-> exact final sheet fit  (unchanged)
```

And one non-algorithmic requirement above all of it: **the focused production
suites must run automatically on every code commit to this branch.** F1 is
what happens otherwise.

# Exact Next Steps

Ranked, each with its falsifier:

1. **Wire the four focused suites into an automatic gate** (pre-push hook or
   CI). Falsifier: none needed — F1 is the evidence.
2. **Make Mixed-61 periodic continuations evaluation-budgeted** (wall clock
   as safety abort only), then rerun the portfolio on both machines.
   Falsifier: if hashes still differ across machines at equal evaluation
   budgets, the decoder has a hidden nondeterminism and that is a stop-line
   bug.
3. **Consolidate one decision-grade portfolio run** (C10): all constructors
   plus witnesses into one archive with one budget report, on Triangle,
   Mixed-61, rectangles-20, pentagons-20. Success: the report can name, for
   every arm, its best endpoint and best evicted candidate. This replaces
   cross-run number comparison permanently.
4. **Cavity-first scheduling (C11)** as the next constructive experiment on
   Mixed: one bounded cavity-queue slot per depth with the commensurate
   two-order admission barrier. Positive gate: a completed endpoint that
   improves the shared archive against the 405,773 reference. Falsifier:
   pocket opportunities exist but every commensurate branch loses the
   archive comparison.
5. **LNS destroy/repair from archive endpoints** (D18) as the coordinated
   mechanism replacing pressure: destroy = remove a conflict-adjacent or
   cavity-adjacent subset (bounded k), repair = strict-decoder reinsertion,
   accept only canonical-exact archive improvement. Run it from the 90,352
   witness and the 420,059 Mixed endpoint. Falsifier: zero admissible
   improvements over the same 50k-evaluation budget the pressure line used.
6. **Only after 3–5: revisit widths/queues.** Nothing measured here changes
   the Stage 2A conclusions.

# Rejected Mechanisms And Why

- **Cross-target restart transport** — rejected by the branch's own paired
  ablation (`9baaa95`), independently reproduced here to the last digit.
- **Smaller final contraction (0.625 %) under the MTV vocabulary** — run as
  mandated, equal budgets, restart 0: reaches raw loss 3.6e-06 with 12 pair
  conflicts across 16 pieces and no canonical-exact endpoint. The
  preregistered stop rule fires; the pressure branch on Triangle is closed.
  Retained: the configurable ratio schedule (generic machinery).
- **Sampled-relocation vocabulary as a pressure rescue on a dense lattice** —
  implemented faithfully, exercised (12,760 sampled evaluations in the final
  attempt), improves the 5 %/2.5 % targets, does not produce an exact
  endpoint either. Verdict: on a *dense repeated lattice* the contraction
  task requires coordinated re-phasing of many pieces at once, which
  single-piece relocation cannot express regardless of sampling. Retained:
  the vocabulary itself (generic, default-off) — its honest test is Mixed
  (heterogeneous, loose), and any future coordinated stage should keep it as
  the per-piece primitive.
- **Restoring the far-neighbour certificate, widening P1/P2, or new contact
  definitions** — no new evidence; previous falsifications stand.
- **Preserving historical byte identity of the periodic archive as a
  default** — deliberately not done: witness admission changes the archive
  winner (as it must); the flag keeps replay of historical runs possible.

# Reproduction Commands

```sh
# F1 regression demonstration (fails at 48abf69..d56d9d7, works after 6bcba8c)
pnpm exec tsx --tsconfig tsconfig.node.json scripts/irregular-benchmark.ts \
  --fixtures triangle.dxf --piece-count 2 --repeat-count 2 --sheet 500x300 \
  --padding 0 --runs 1 --warmup 0

# Triangle source audit + restart ablation reproduction (pinned 74k seed)
pnpm exec tsx --tsconfig tsconfig.node.json \
  scripts/irregular-intrinsic-periodic-family-portfolio.ts \
  --fixture triangle-20 --output <dir> --source-commit "$(git rev-parse HEAD)" \
  --source-survival-audit --adaptive-restart-ablation --adaptive-seed-hash 371db269

# Equal-budget pressure matrix (this review's causal experiment)
pnpm exec tsx --tsconfig tsconfig.node.json \
  scripts/irregular-intrinsic-periodic-family-portfolio.ts \
  --fixture triangle-20 --output <dir> --source-commit "$(git rev-parse HEAD)" \
  --source-survival-audit --adaptive-pressure-matrix --adaptive-seed-hash 371db269

# Witness admission (E-C)
pnpm exec tsx --tsconfig tsconfig.node.json \
  scripts/irregular-intrinsic-periodic-family-portfolio.ts \
  --fixture triangle-20 --output <dir> --source-commit "$(git rev-parse HEAD)" \
  --source-survival-audit --admit-raw-witnesses

# Focused suites
ELECTRON_RUN_AS_NODE=1 pnpm exec electron ./node_modules/vitest/vitest.mjs run \
  tests/unit/intrinsicSqueezeDisruptSeparate.test.ts \
  tests/unit/intrinsicPeriodicFamilyPortfolio.test.ts
```

# Artifact Index

Committed portable evidence (`help/artifacts/v7-search-redesign/`, hashes in
its README):

- `triangle-20-witness-74428-371db269.{svg,png}` — the reproduced 74,428 mm²
  two-band witness (diagnostic; retention-evicted by default fronts).
- `triangle-20-witness-90352-4b87d6df.{svg,png}` — the new witness-admission
  archive winner (accepted archive content, not a golden).
- `mixed-61-periodic-420059-a79f6148.{svg,png}` — the new best periodic Mixed
  endpoint from this machine's default run (accepted archive content).
- `mixed-61-production-invariant-f58cf0f2-2000x2700.{svg,png}` — the
  production-path sheet-invariant Mixed layout (diagnostic quality witness).
- `summary.json` — compact metrics for every run cited in this memo, with the
  raw report paths and SHA-256 hashes.

Raw immutable provenance (machine-local, referenced by the summaries):

```text
/private/tmp/min-plane-provenance/v7-search-redesign-6bcba8c/
  triangle-20-periodic/           default run (F2 evidence)
  triangle-20-periodic-sharedbasis/  pinned-basis control (F2)
  triangle-20-adaptive-ablation/  10-witness audit + restart ablation repro
  mixed-61-periodic/              426k repro + new 420k endpoint
/private/tmp/min-plane-provenance/v7-search-redesign-repro-9da94e2/  worktree runs at 9da94e2 (F2/F3)
/private/tmp/min-plane-provenance/v7-search-redesign-e77f3c1/
  triangle-20-pressure-matrix/    Triangle 4-arm matrix
/private/tmp/min-plane-provenance/v7-search-redesign-96368ca/
  mixed-61-pressure-matrix/       Mixed 4-arm matrix
  triangle-20-witness-admission{,-replay}/  E-C + determinism replay
  rectangles-20-witness-admission/  control
  pentagons-20-witness-admission/   control
  sheet-invariance-subset/        3-case 2-sheet corpus (production path)
  sheet-divergence-mixed61{,-640}/  legal-divergence pair
```
