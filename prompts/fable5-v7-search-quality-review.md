# Fable 5 Review: V7 Search Quality, Periodic Seeds, And the Next Decision

You are conducting an independent, adversarial architecture and experiment review
of a deterministic irregular-convex nesting engine. This is **not** a request
for a summary, a generic code review, or a new implementation. Read the
evidence and source below, challenge the current interpretation, and recommend
one disciplined next experimental step.

Work read-only. Do not edit files, run destructive commands, alter artifacts,
or silently substitute a generic nesting recipe for the constraints of this
engine.

## Review Goal

Decide what the project should do next to improve *generic* layout quality:

- compact occupied envelopes;
- no large hollow rings, arcs, perimeter chains, or stranded shape islands;
- compact repeated-shape motifs when the geometry permits them;
- sheet-invariant preferences whenever the same placements remain legal;
- exact, deterministic, reproducible legality.

The key decision is whether the current bounded repeated-family / periodic seed
path should be repaired and rerun, or whether its evidence is sufficiently
negative to move next to a more faithful Sparrow-style global
shrink/separate/restart controller. You may recommend a third option, but only
if you define it generically, preserve exactness, and give a falsifiable
experiment that is smaller and more informative than either existing path.

Do **not** recommend fixture-specific triangle code, remembered placements,
saved-layout injection, piece-count branches, or a new scalar comparator as a
shortcut.

## Repository And Exact Checkout

Run from this worktree, not the root checkout:

```text
/Users/andreasimonecosta/Documents/Work/min-plane-dfx-worktrees/v7-geometric-cohesion
branch: v7-geometric-cohesion
commit: 0b3309e ("Record rejected periodic lattice witnesses")
```

The root checkout is on `main` at a different commit and does **not** contain
the current V7 implementation. The V7 worktree is clean at the stated commit.

The current dual review by Kimi/Sol is stuck because the Sol reviewer hit a
context-window API error before acknowledging the final evidence update. Treat
there as being **no accepted peer consensus after the current periodic results**.
Independently verify all claims from the files and artifacts below.

## System Invariants: These Are Not Negotiable

1. Input shapes are convex collision polygons. This is not yet a general
   concave/hole-aware nesting engine.
2. The engine uses deterministic finite transforms, NFP/IFP candidate geometry,
   direct placement validation, canonical translation/grid identity, and
   Clipper2 integer geometry at authoritative admission boundaries.
3. SAT / relaxed loss may guide an experimental infeasible search, but it is
   never final legality. A result is publishable only if canonical Clipper2
   admission says it is legal.
4. Sheet dimensions may decide legality and final q0/q90 fit. For intrinsic
   balanced/edge-contact quality, they must not decide compactness preference.
5. No fake macro pieces, fabricated candidates, fake free rectangles, hidden
   fixture names, saved placements, or non-deterministic random searches.
6. Existing NFP/IFP, direct validation, canonical identity, exact terminal
   archive, and provenance machinery are retained unless you can prove a
   replacement is both safer and necessary. The ordinary NFP pool need not be
   the *only* source of seeds, but it remains the legality backbone.
7. Experimental work must be bounded, source-tagged, reproducible, and compare
   completed exact endpoints under one common archive. A capped run is
   diagnostic, not a quality win.

## What Production And V7 Currently Do

The production engine is a windowed beam with NFP/IFP placement candidates.
Historically it used sheet-normalized compactness too early, which could prune
different orientation families on different sheets. V7 is isolated research to
replace that failure mode with sheet-free geometric construction and common
exact archive selection.

Relevant architecture source:

- `docs/architecture.md`
- `docs/architecture/irregular-v2-infrastructure.md`
- `SCORING_CRITERIA_NOTES.md`
- `src/workers/algorithm/irregular/intrinsicStrictDecoder.ts`
- `src/workers/algorithm/irregular/intrinsicReconstructionPortfolio.ts`
- `src/workers/algorithm/irregular/intrinsicPeriodicCells.ts`
- `src/workers/algorithm/irregular/intrinsicPeriodicFamilyPortfolio.ts`
- `scripts/irregular-intrinsic-periodic-family-portfolio.ts`

The V7 exact archive deliberately separates three concerns:

1. **compactness:** absolute maximum side, envelope area, span;
2. **void topology:** enclosed cavities/cavity area, largest hull gap,
   hull waste;
3. **structural contact diagnostics:** isolates, contact components, largest
   component, contacts, contact units, shared boundary.

Only compactness and void topology decide Pareto dominance. Contact receives a
bounded preservation turn so it can retain a structurally useful alternative,
but cannot veto a layout strictly better geometrically. This was a deliberate
correction after contact-heavy greedy branches formed chains and rings.

## The Concrete Quality Problem

The user cares about actual visual and geometric quality, not byte-identical
historical layouts for their own sake.

### Triangle-20

Twenty copies of the same `70 x 60 mm` triangle should form a compact lattice
with side-to-side contacts / hexagonal local structure when legal. Current V7
legal constructive output can still leave visible side wings or vertex-touching
fans even when it is quite compact. The reference production golden is a strong
regression gate, not permission to special-case triangles.

Important measured facts:

- the strict V7 width-3 result after the generic envelope-event repair had area
  `88,124.330 mm2`, zero cavities, `5/3` total/dominant contacts, 11 isolates,
  15 positive-contact components, largest component 3;
- a corrected legal peel/reinsert observer found a real but negligible shadow
  improvement: `88,124.026123 mm2`, with unchanged cohesion;
- bounded coordinated multi-piece and exact component-interface experiments
  were mechanically real but did **not** produce a compact cohesive lattice;
- all 8 transform variants were available. The principal problem is therefore
  not simply “only four rotations.”

Useful renders and reports:

```text
/private/tmp/min-plane-provenance/v7-peel-shadow-e41897b-triangle/report.json
/private/tmp/min-plane-provenance/v7-peel-shadow-e41897b-triangle/triangle-20-partial-geometric-beam-width-3.png
/private/tmp/min-plane-provenance/v7-peel-shadow-e41897b-triangle/triangle-20-peel-reinsert-best.png
/private/tmp/min-plane-provenance/v7-coordinated-d55d55e-triangle/
/private/tmp/min-plane-provenance/v7-component-interface-5729b25-triangle/
```

### Mixed-61

This is the heterogeneous stress case that previously produced visually ugly
rings/holes. The current useful baseline is an `open-pocket-first`
reconstruction endpoint with:

```text
area: 405,773.434 mm2
maximum side: 642.501 mm
enclosed cavities: 0
largest hull-gap ratio: 0.200227
```

It is a constructive portfolio result, not yet a universal production answer.
The completed width-3 V7 beam result was legal and ring-free but worse:
`431,558.250585 mm2`, 31 isolates, `17/2` total/dominant contacts. A later
canonical-admission staging refactor finished the same result in `287.698 s`;
this is research-budget territory, not a hidden default.

The fixture source is:

```text
tests/fixtures/irregularSheetInvariance/mixed61-request.json
```

## Prior Results You Must Not Re-litigate Without New Evidence

Read the full active plan first:

```text
plan.md
```

It includes detailed provenance and explicit rejected mechanisms. At a high
level:

- **Candidate omission was real once.** A historical useful Mixed pose lay in
  the interior of a horizontal NFP segment rather than at an ordinary endpoint.
  A generic sheet-free occupied-envelope event generator recovered it. This
  proves not every useful contact comes from the old endpoint pool.
- **Contact-first greedy search is bad.** It can create long chains / rings.
  More contacts are evidence, not an unlimited lexicographic objective.
- **Changing only the terminal comparator cannot recover a partial future
  pruned earlier.** Local candidate and beam retention matter.
- **A queue-vs-beam observer found reachability headroom, but is not yet a live
  design proof.** Its queue comparison is not commensurate by placed material;
  it therefore cannot yet justify an online queue policy.
- **Triangle peel/reinsert, compact-closure, contributor reconstruction,
  bounded coordinated transport, and exact rigid component-interface closure
  all failed as macroscopic Triangle cohesion repairs.** Preserve their traces;
  do not repeat them with minor tuning.
- **The old E3 periodic experiment is not a conclusive periodic negative.** It
  selected only one largest family, one crop, and never ran Triangle.
- **The existing V7 static squeeze controller is not faithful Sparrow.** It
  launches three static target boxes with fixed sweeps then projects. It lacks
  incumbent-driven repeated contraction, a restart pool, and disruption between
  failures.

## The New Periodic-Family Experiment

The current branch implemented the peer-reviewed bounded P1/P2 repeated-family
portfolio at commits `9c93239`, `ecb1186`, and `0b3309e`.

### Intended contract

For collision-shape families with multiplicity at least two:

1. retain up to 8 families ordered by multiplicity, total collision area, then
   stable family key;
2. preserve transform-family coverage before transform truncation: up to 16
   transforms/family, reserving representatives of direct/mirror and orthogonal
   qturn or edge-alignment source families;
3. examine up to 120 transform pairs/family;
4. construct exact one-/two-member P1/P2 periodic cells; retain up to 4
   non-dominated cells per `(family, role)`; expand at most 2 finite crops/cell;
5. reserve one continuation per eligible family, then fill a global cap of 8;
6. hand the resulting real seed back to the unchanged strict NFP/IFP decoder;
7. score all completed endpoints using the shared exact archive.

The implementation adds catalog coverage flags and rejected-cell witnesses.
It is source-tagged and is intentionally isolated: it does not change the live
production beam, repaired candidate pool, comparator, or static squeeze path.

### Exact current artifacts

Triangle:

```text
/private/tmp/min-plane-provenance/v7-periodic-family-portfolio-0b3309e/triangle-20/report.json
/private/tmp/min-plane-provenance/v7-periodic-family-portfolio-0b3309e/triangle-20/manifest.json
```

Mixed:

```text
/private/tmp/min-plane-provenance/v7-periodic-family-portfolio-0b3309e/mixed-61/report.json
/private/tmp/min-plane-provenance/v7-periodic-family-portfolio-0b3309e/mixed-61/manifest.json
/private/tmp/min-plane-provenance/v7-periodic-family-portfolio-0b3309e/mixed-61/mixed-61-d91b1106e3efec7a.svg
/private/tmp/min-plane-provenance/v7-periodic-family-portfolio-0b3309e/mixed-61/mixed-61-7679bd9cafbac829.svg
```

### Triangle result: bounded catalog complete, no cell materialized

The run took about `77.68 ms` on 20 pieces. Its single repeated family had:

```text
unique transforms: 8
retained transforms: 8
transform coverage complete: true
transform pairs: 28
pair coverage complete: true
cell coverage complete: true
certified cells: 0
farNeighborRejected: 185
threeByThreeLatticeRejected: 16
noP1Basis: 8
noP2Basis: 71
continuations: 0
```

This does **not** prove that a compact finite triangle lattice is impossible:
the historical golden proves some compact layout is legal. It does prove that
the current P1/P2 certificate pipeline rejected every enumerated basis before
it could materialize and crop a finite seed.

The important hypothesis to test is whether `farNeighborCertificate` is a
sound *sufficient condition for an infinite lattice* but is too strong for a
finite crop. A safe revision, if warranted, must never simply remove the
proof and call the infinite lattice legal. It would need to materialize a
bounded finite crop and direct-/canonical-check every placed member using the
existing exact authorities. `threeByThreeLatticeRejected` may be a separate,
genuine condition and must not be waved away.

The rejected samples are in the Triangle report. Relevant code:

```text
src/workers/algorithm/irregular/intrinsicPeriodicCells.ts
  enumerateIntrinsicPeriodicCells
  farNeighborCertificate
  validatePeriodicContactLatticeControl
  expandIntrinsicPeriodicCell
```

### Mixed result: deliberately inconclusive, not promotable

The run took `199,743.887 ms`. The eight selected families each completed their
individual transform/pair/cell coverage contract, but the global result has:

```text
familyCoverageComplete: false
continuationCoverageComplete: false
```

There were more eligible families / continuations than the global caps. Six of
eight continuations hit their 25-second deadline. Two completed zero-cavity
layouts entered the portfolio archive:

```text
417,922.681228 mm2; max side 651.898 mm; span 1292.984 mm;
  zero cavities; 20 isolates; 29 components; largest component 19;
  20/5 total/dominant contacts; hull-gap 0.221731

424,747.401046 mm2; max side 651.899 mm; span 1303.453 mm;
  zero cavities; 24 isolates; 32 components; largest component 18;
  20/4 total/dominant contacts; hull-gap 0.217891
```

They are not quality wins against the 405k pocket-first endpoint. Do not call
Mixed a negative test of all periodic seeding: the global coverage and
continuation schedule were truncated.

## Open-Source And Literature Control Pass

Read the actual research documents and, where useful, pinned local source:

```text
help/research/open-source-nesting-strategies.md
docs/research/open-source-irregular-nesting-strategies.md
help/research/dalsoo-abey-dalalah-transfer-study.md
knowledge/dependencies/sparrow
knowledge/dependencies/dalsoo-bin-packing
```

Pinned projects and their safe transfer boundaries:

| Source | Useful idea | Do not copy |
| --- | --- | --- |
| Deepnest / SVGnest | absolute envelope pressure in a deterministic decoder; outer order/rotation diversity | fixed gravity axis; GA as first repair |
| libnest2d | retain orientation families before a transform cap; candidate visibility matters | center-distance objective |
| PackingSolver | bounded deterministic portfolio, large-first/small-fill, periodic seeds | full solver/MILP machinery |
| Sparrow | legal incumbent -> contract -> infeasible multi-piece separation -> disruption/restart -> exact feasible archive | its collision kernel or strip-only objective |
| Dalsoo / Abeysooriya / Dalalah | finite edge/vertex contact pose grammar, transform family coverage, hole-first and reconstruction/kick concepts, hull as proposal pressure | floating/asymmetric feasibility, greedy hull terminal, arbitrary rotations, multi-bin semantics |

Do not take screenshots as algorithmic evidence. Inspect the source and the
project's source-level transfer studies. In particular, explain whether the
current periodic cell representation is materially narrower than the finite
edge/vertex contact grammar that Dalsoo/Abeysooriya make available, and whether
that distinction matters *after* the prior F0 evidence that ordinary finite
NFP/IFP contact families existed.

## Questions You Must Answer

### A. Diagnose the periodic failure precisely

1. Is it correct to describe the Triangle result as “candidate bases generated,
   then rejected pre-materialization,” rather than “a compact solution was
   generated and pruned”? Identify the exact boundary from source and trace.
2. Is the infinite `farNeighborCertificate` a likely representation mismatch
   for finite crops, a sound necessary condition in this implementation, or
   something else? Answer from the implementation and geometry, not intuition.
3. What must remain true for a finite-crop relaxation to be correctness-safe?
   Specify exact validation, deduplication, and runtime limits.
4. Could the triangle lattice require a finite motif that P1/P2 cells cannot
   represent even if all pair bases are covered? If yes, define the smallest
   *generic* motif/crop extension worth testing and why it is not triangle
   special-casing. If no, explain why P1/P2 should be expressive enough.
5. Does `threeByThreeLatticeRejected` independently refute the finite-crop
   idea for any subset of bases? State what measurement would discriminate it.

### B. Assess the architecture and current plan

6. Audit `plan.md` for stale, contradictory, or overly confident claims. Is the
   order “periodic portfolio first, faithful adaptive Sparrow controller only
   after a conclusive periodic result” still sound after the new artifacts?
7. Is the current *periodic-only* archive acceptable as an experiment, or must
   each portfolio result compete directly against the ordinary / pocket-first
   protected baseline during the same run to make a meaningful decision?
8. Identify provenance gaps. In particular, assess whether omitted family and
   continuation identities/counts, per-stage rejection samples, replay
   guarantees, and time allocation are sufficient to distinguish coverage from
   scheduling failure.
9. Is it better to repair the periodic certificate first, broaden finite
   contact-pose generation, run a fuller bounded portfolio, or start the
   Sparrow-shaped controller now? Rank these choices with explicit reasons,
   not “try everything.”
10. If the periodic certificate is repaired, what would constitute a conclusive
    negative result on Triangle and on Mixed? Keep the criteria fair: Triangle
    has one family and completed bounded transform/pair coverage; Mixed has
    many families and deadline/cap truncation.

### C. Examine the larger search-quality question

11. Does the evidence support the proposition that the main remaining issue is
    **reachability / representation**, not merely a comparator weight? Explain
    how local candidate generation, partial-state retention, order, and global
    repair each differ.
12. Could a bounded portfolio of source-tagged constructors genuinely improve
    arbitrary future jobs, or is it accumulating unrelated special paths?
    State a clean common archive and source-admission contract.
13. If eventually moving to Sparrow-style global repair, name the minimal
    architecture change needed to make it faithful: incumbent-driven target
    progression, restart pool, disruption, multi-piece separator, coordinate
    descent, exact projection/admission, or something else. Give the order and
    explain why the existing fixed-target V7 controller is insufficient.
14. Should the NFP/IFP system remain the backbone? If you think a major change
    is justified, spell out exactly what replaces which responsibility and how
    exact legality/reproducibility survives. Do not recommend “replace NFP”
    without a concrete, testable design.

## Required Deliverable Format

Return **exactly one large, standalone Markdown document**. It must contain
your complete review, evidence-based diagnosis, possible fixes, possible new
directions, rejected shortcuts, and ranked recommendation. Do not split the
answer into chat messages, ask follow-up questions, propose a call, or provide
a terse executive reply without the technical reasoning.

Write it as a decision memo, not a stream of thoughts. Use these exact headings:

```md
# Verdict
# What the Evidence Actually Proves
# Findings (ranked by severity)
# Recommended Next Experiment
# Exact Safety and Provenance Contract
# What Not To Do Yet
# Required Plan Corrections
```

Within `# Findings`, include a clearly labelled subsection named
`## Candidate Fixes And Directions` that lists every credible route you found:

- a minimal repair to the current periodic implementation;
- a broader but still bounded repeated-geometry / finite-motif design;
- a contact-pose or reconstruction direction supported by Dalsoo / Abeysooriya;
- a portfolio / archive correction if one is necessary; and
- a faithful Sparrow-style global-repair direction.

For each route, state: what it changes, which evidence supports it, its main
risk, whether it is generic, its expected cost, and the falsifiable condition
under which it should be rejected. You may rank several paths, but nominate
only one immediate implementation experiment under `# Verdict`.

Under **Verdict**, choose exactly one:

- `REPAIR_PERIODIC_FINITE_CROP_FIRST`
- `RUN_A_CONCLUSIVE_PERIODIC_PORTFOLIO_FIRST`
- `MOVE_TO_ADAPTIVE_SPARROW_CONTROLLER`
- `ANOTHER_SPECIFIC_EXPERIMENT` (name it)

For **Recommended Next Experiment**, provide all of the following:

1. one-sentence hypothesis;
2. bounded algorithm sketch / pseudocode;
3. exact project source files likely to change;
4. which existing services must remain authoritative;
5. precise generation, retention, archive, runtime, and replay trace fields;
6. Triangle, two homogeneous-family, Mixed-61, and sheet-invariance gates;
7. promotion, rejection, and inconclusive criteria;
8. expected failure modes and how the trace would identify each;
9. whether this changes production behavior or remains an isolated portfolio.

Be decisive, but distinguish:

- **proven from current artifacts**;
- **plausible inference needing a measurement**; and
- **unsupported speculation**.

Do not ask for a separate summary. You have the plan, code, research documents,
and immutable artifacts. If a listed path is missing, say precisely which one
and continue with the evidence that is present.

## Suggested Reading Order

1. `plan.md`: current decision history, gates, and source map.
2. The two `report.json` files and manifests for the current periodic run.
3. `intrinsicPeriodicCells.ts`, `intrinsicPeriodicFamilyPortfolio.ts`, and the
   harness script.
4. `docs/architecture/irregular-v2-infrastructure.md` and
   `SCORING_CRITERIA_NOTES.md` for the exactness boundary.
5. `help/research/open-source-nesting-strategies.md` and
   `help/research/dalsoo-abey-dalalah-transfer-study.md`.
6. Pinned Sparrow and Dalsoo source only for claims that materially change the
   decision.

Your value is in identifying the smallest architecture-correct experiment that
can falsify the next causal claim—not in proposing another broad, unmeasured
heuristic.
