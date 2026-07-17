# Resolve irregular nesting sheet invariance

You are taking over a real production investigation in
`min-plane-dfx`. Work as an expert algorithm engineer and experimental
researcher. Do not stop at a code review, a list of ideas, or a generic nesting
survey. Reproduce the current behavior, locate the first causal divergence,
implement the strongest safe candidate in an isolated worktree, test it against
all quality gates, inspect rendered layouts, and leave the repository with a
reproducible result and a clear production decision.

## Mission

Close the remaining sheet-invariance gap for the deterministic convex irregular
nester.

For the same pieces and settings, every sheet on which the target compact motif
is legal should select the same collision geometry after canonicalization under
translation and rigid quarter-turn rotation. Sheet width, height, and aspect
ratio may constrain legality. They must not change balanced or edge-contact
compactness preferences. `short_side_fill` is the deliberate sheet-relative
exception.

The solution must preserve or improve layout quality, not merely make four bad
layouts identical. It must retain the official triangle lattice, the recovered
mixed-61 two-hole reference quality, legality, determinism, trace truthfulness,
and acceptable runtime.

## Checkout and source of truth

Start from the repository root:

```text
/Users/andreasimonecosta/Documents/Work/min-plane-dfx
```

At the time this prompt was written, merged `main` was
`c6d6dc91c52c0b4297556c70ac44506a166ee46a` after PR #2. Refresh `main` and
record the actual starting commit. Do not assume this hash is still current.

Read these files in order before editing:

1. `AGENTS.md` and `CLAUDE.md`, if present;
2. `knowledge/INDEX.md`, then the relevant knowledge pages;
3. `SCORING_CRITERIA_NOTES.md`;
4. `docs/architecture.md`;
5. `docs/architecture/irregular-v2-infrastructure.md`;
6. `help/help.md`, especially Current Production Truth, Current Research
   Status, the provenance ledger, and the newest investigation-log entry;
7. `help/research/contact-tier-intrinsic-reservation.md`;
8. `help/research/protected-contact-tier-reservation.md`;
9. `help/research/protected-boundary-anchor-diversity.md`;
10. `help/research/open-source-nesting-strategies.md`;
11. `help/research/bounded-ga-order-rotation-probe.md`;
12. `docs/research/deepnest-svgnest-source-comparison.md`;
13. `docs/research/irregular-nesting-literature-and-web-research.md`.

Then inspect the current implementation, especially:

```text
src/workers/algorithm/irregular/irregularPlacementScorer.ts
src/workers/algorithm/irregular/irregularLayoutScorer.ts
src/workers/algorithm/irregular/windowedBeam.ts
src/workers/algorithm/irregular/portfolioSearch.ts
src/workers/algorithm/sortPiecesForNesting.ts
scripts/irregular-sheet-invariance.ts
scripts/lib/irregularLayoutCanonicalization.ts
tests/unit/irregularWindowedBeam.test.ts
tests/unit/irregularTriangleCompactGolden.test.ts
tests/fixtures/irregularSheetInvariance/mixed61-request.json
```

Use installed source and types before memory or web documentation. Keep
placement, scoring, candidate generation, and search behavior inside
`src/workers/algorithm/`. Do not move search policy into the geometry kernel.

## Current verified truth

Treat these as claims to reproduce on the live starting commit, not as permission
to skip the baseline run.

### Production behavior

- The official 20-triangle golden uses repair budget `8`, order window `4`,
  beam width `8`, local fanout `4`, transform cap `8`, rotations and mirroring,
  edge-contact policy, and no GA. It produces the dense lattice and must remain
  green.
- The persisted mixed-61 request uses repair budget `0`. The merged protected
  boundary-anchor lane is active only when repair is disabled, beam width is
  greater than one, and no chromosome transform preference is active.
- Production beam slots and the width-one incumbent are isolated from the
  protected lane. Cross-lane geometry deduplication preserves the production
  representative.
- Production and protected terminal candidates are oriented independently. A
  protected result may win only if it is strictly better under the production
  layout comparator and strictly smaller in collision-envelope area.
- The NFP near-parallel crossing recovery is already merged. Do not conflate
  this search investigation with that resolved kernel crash.

### Mixed-61 four-sheet checkpoint

The current measured outputs are:

| Sheet | Envelope area | Holes | Current status |
| --- | ---: | ---: | --- |
| `1000 x 1300` | `506,644.934 mm2` | 12 | unchanged post-canonicalization geometry |
| `1000 x 1700` | `461,475.664 mm2` | 10 | unchanged post-canonicalization geometry |
| `2000 x 1700` | `661,441.643 mm2` | 6 | unchanged post-canonicalization geometry |
| `2000 x 2700` | `430,344.918 mm2` | 2 | protected boundary-anchor winner |

The reference result has canonical hash:

```text
40f8ac9c0fb24073ac141b5fb667366af55df90c78c6cca21ff76703a4a7f300
```

It has 53 total and 14 dominant structural contacts. Its `545.515 x 788.878
mm` envelope fits all four sheets, so legality alone does not explain why the
other three sheets choose different motifs.

### Causal boundary already established

`95de72c` correctly canonicalized occupied-hull waste and removed a meaningless
raw floating difference. On `2000 x 2700`, that exposed a production-score tie
and discarded a distinct sheet-boundary lineage. The merged protected lane
recovers that one lineage.

The general gap remains earlier in pruning:

- balanced and edge-contact local compactness still divide occupied width and
  height by sheet width and height;
- the same legal candidate can therefore receive a different local rank on a
  different roomy sheet and disappear before whole-beam protection sees it;
- the protected lane itself follows a legacy ordering containing sheet-relative
  fields, so it is not an invariant decoder.

Do not try to fix this only in final selection. A terminal comparator cannot
recover a branch removed by local fanout or earlier protected-lane pruning.

## Research findings that must be preserved

The historical contact-tier intrinsic experiment is not discarded.

- Area-first intrinsic greedy growth is chain-forming. Its triangle long side
  reached `927.024 mm`.
- Maximum-side-first, then area, then span is the useful intrinsic primitive.
- M1b made the pentagon/star collision family invariant and removed the old
  mixed-61 strip, but lost the approved contact/hole structure and slowed one
  sheet by up to `15x`.
- M2 spent two global reservations on balanced and intrinsic policies and
  regressed the reference result. Do not repeat it.
- A narrow max-side-first exact-contact local port on current main remained
  shape-dependent: it improved the pentagon/star hull family but regressed
  trapezoids and mixed-50 and did not help mixed-61.
- The mechanism is not disproven. Its unsafe placement in production fanout is
  disproven.

The next candidate should therefore put intrinsic local diversity behind the
already isolated production lane, not replace a production local candidate.

## Open-source control references

Use the pinned source review already in the repository. Re-open upstream source
only when a claim needs verification, and keep the commit pinned.

| Project | Pinned commit | Relevant lesson |
| --- | --- | --- |
| Deepnest | `2fb10513a30681971dcc991c528fa0738a2c0c76` | absolute envelope-oriented greedy NFP decoder; GA changes order and rotation; common-line contact is a bounded bonus |
| SVGnest | `1248dc21efd3f90d1aa52ba5785e27e5217ed2c9` | absolute `2 * occupiedWidth + occupiedHeight` placement objective; deterministic decoder beneath GA |
| libnest2d | `663daa69e1d7478669f714218e27681edbc96640` | preserve rotation-family coverage before truncation; keep hole contours visible to selection |
| PackingSolver | `3d8d97dd8ae5ac46f08328636f5e168283282ebc` | bounded guide/direction portfolio, deterministic result replay, large-item-first then small-fill, optional periodic-cell seeds |
| Sparrow | `961ec31f576c5817ece779ff73982b4553760a4e` | constructive seed is separate from global strip shrinking, separation, disruption, and coordinate descent |

Official pinned sources:

- <https://github.com/Jack000/Deepnest/tree/2fb10513a30681971dcc991c528fa0738a2c0c76>
- <https://github.com/Jack000/SVGnest/tree/1248dc21efd3f90d1aa52ba5785e27e5217ed2c9>
- <https://github.com/tamasmeszaros/libnest2d/tree/663daa69e1d7478669f714218e27681edbc96640>
- <https://github.com/fontanf/packingsolver/tree/3d8d97dd8ae5ac46f08328636f5e168283282ebc>
- <https://github.com/JeroenGar/sparrow/tree/961ec31f576c5817ece779ff73982b4553760a4e>

Transfer principles, not formulas:

1. sheet-independent absolute envelope pressure belongs in a compact decoder;
2. contact must not purchase an unbounded envelope regression;
3. distinct search intentions can survive in bounded roles or lanes;
4. outer GA/order search is useful only after the decoder objective has the
   intended meaning;
5. hole filling requires the relevant legal candidates to survive generation
   and truncation;
6. global squeeze/repair is a later expensive stage, not a substitute for the
   deterministic decoder.

Do not copy Deepnest/SVGnest's dimensionally mixed scalar literally. Do not
replace the real NFP legality path with overlap relaxation. Do not enable GA to
search a sheet-normalized decoder more thoroughly.

## Primary hypothesis

Test this first because it directly combines the strongest current evidence:

> Generate at most one max-side-first intrinsic candidate inside an exact
> production contact tier, but tag it as protected-only. Never use it to replace
> or reorder production fanout. Advance protected descendants under a
> sheet-independent max-side-first order while retaining the existing protected
> legacy lineage needed for the reference motif. Let only the production
> comparator plus strict envelope and topology guards promote a terminal result.

The implementation must answer these questions explicitly:

1. At which exact boundary is the intrinsic candidate currently lost: local
   candidate fanout, successor deduplication, production beam pruning, or
   protected descendant pruning?
2. Can the desired candidate be generated from the same real legal NFP/IFP
   candidate set without changing production fanout?
3. What exact contact tier must be preserved: shared padded-edge band, contact
   units, contact length, or the production comparator's structural band?
4. Can one protected width-eight budget retain both the legacy reference
   lineage and the invariant max-side lineage without a second global lane?
5. If role quotas are needed inside that budget, can unused quota spill back to
   the best protected pool and can geometry-equivalent states be deduplicated
   before allocation?
6. Which score fields remain sheet-relative in every branch-removing protected
   decision?

Start with a trace-only or injected-comparator proof when possible. Do not
modify production code before proving the target candidate exists and recording
where it is lost.

## Secondary hypotheses, in order

If the primary hypothesis is falsified, continue in this order. Record the
counterexample before switching.

1. **Protected Pareto frontier within exact contact strength.** Retain bounded
   non-dominated states over maximum side, area, span, contact tier, and holes;
   preserve production and legacy representatives separately.
2. **Orientation-family coverage before local truncation.** Transfer
   libnest2d's useful pattern: compare the best real candidate from each
   meaningful rotation/mirror family before the protected cap, without changing
   the production transform cap.
3. **Bounded deterministic guide roles.** Within one protected budget, test
   legacy-reference, intrinsic-max-side, and cavity-visible roles with
   geometry deduplication and quota spillover. Do not allocate multiple global
   beam-width reservations as M2 did.
4. **Shared-prefix deterministic portfolio.** Only after the invariant decoder
   is sound, test one additional order/rotation seed while reusing prefix and
   geometry work. Do not run two full decodes if equivalent work can be shared.
5. **Optional GA.** Evaluate small priority/rotation-only budgets last, always
   retaining the deterministic baseline. Placement-policy mutation remains off
   until scoring semantics are invariant.

## Experiment protocol

### 1. Establish immutable baseline

- Create a human-named experiment branch and isolated worktree from the latest
  `origin/main`.
- Record the base commit, working diff hash, Node/pnpm/Electron versions,
  operating system, fixture hashes, exact settings, and commands.
- Run the current two-sheet corpus and all four mixed-61 sheets.
- Produce bounded decision traces for the first divergence; do not emit
  avoidable full-state payloads merely to make the trace large.
- Render the current four mixed-61 outputs to PNG using
  `.agents/skills/render-svg-with-electron/` and inspect all margins and cluster
  connectivity.
- Store immutable evidence under a new directory in
  `/private/tmp/min-plane-provenance/`.

### 2. Find the first divergence on current main

Compare the same parent geometry and same legal moving candidate across all
four sheets. For the first differing branch-removing decision, report:

- step and parent canonical geometry key;
- piece and transform family;
- legal candidate count and canonical candidate geometry;
- exact production rank on each sheet;
- exact contact tier;
- normalized fields;
- absolute maximum side, area, span, hull waste, and deterministic tie-breaks;
- whether the candidate survived production fanout, production beam,
  protected seeding, and protected descendant pruning;
- the later terminal quality of the lost lineage when forcibly preserved only
  in the isolated experiment.

Do not reuse the old `b750ac0` divergence as a substitute. The merged protected
lane changed the current search graph.

### 3. Implement one mechanism at a time

- Commit the exact candidate before running a result worth comparing.
- Never stack unrelated local ranking, global ranking, order, GA, cavity, and
  performance changes in one checkpoint.
- Keep production fanout and production beam byte-equivalent unless the
  experiment specifically passes every production gate and justifies changing
  them.
- Tag protected-only successors explicitly. Cross-lane deduplication must keep
  the production representative and OR only lane eligibility.
- Every reservation, displacement, role, and terminal rejection must be visible
  and truthful in decision traces.
- Preserve cooperative cancellation and deadline behavior.
- Compute expensive hull or topology fields once per state between control
  checkpoints; comparators must consume cached values.

### 4. Prove sheet-independent semantics

For every protected comparator or quota that can remove a branch, identify all
inputs. With the exception of legality and `short_side_fill`, none may derive
from sheet width, sheet height, normalized sheet consumption, sheet-boundary
position, or an orientation chosen only because of sheet aspect ratio.

If a boundary anchor is still needed to preserve the historical reference
lineage, treat it as a protected legacy role, not as the invariant role's
ranking objective. The final common motif must be selected through invariant
semantics.

### 5. Profile before optimizing

Measure time and counts for:

- legal candidate generation;
- local candidate scoring and deduplication;
- production successor scoring;
- protected successor scoring;
- free-material/topology derivation;
- raw and canonical hull calculation;
- terminal orientation;
- trace serialization separately.

The current protected lane costs approximately `1.7-2.0x` on active corpus
paths. Compare against the merged starting commit, not the pre-lane baseline.
Target no more than `1.25x` additional runtime. If the solution needs more,
explain the measured quality/time frontier and do not hide the cost.

Prefer shared immutable geometry and score caches. Do not merge production and
protected retention semantics merely to reduce work.

## Mandatory acceptance gates

### Exact behavior

- all pieces placed and every final placement legal;
- deterministic canonical geometry hashes across repeated runs;
- replay/search equivalence where applicable;
- no fabricated placements, scores, free rectangles, history, or preview data;
- official repair-8 triangle golden green with its current dense lattice;
- protected lane remains disabled under terminal repair;
- cancellation and repair-deadline tests green;
- production representative preserved when lanes converge;
- terminal rotation scored once per legal variant and trace emitted once.

### Sheet invariance

For mixed-61, require one canonical geometry hash across:

```text
1000 x 1300
1000 x 1700
2000 x 1700
2000 x 2700
```

The common result must fit every sheet and meet or beat the current reference
quality unless a clearly superior common motif is proved:

- envelope area no greater than `430,344.918 mm2`;
- no more than 2 free-material holes;
- at least 53 total and 14 dominant structural contacts, or an independently
  justified better topology;
- one coherent connected cluster on rendered inspection;
- no tall strip, perimeter ring, detached island, or obvious piece-sized cavity.

If exact common geometry is impossible, provide a concrete legality proof for
the first unavailable placement. Different hashes alone are not such a proof.

### Wider corpus

Run:

- official triangle-20;
- rectangles-20;
- trapezoids-20;
- pentagons-20;
- star-hulls-20;
- mixed-50;
- mixed-61 on all four sheets.

Remember that the current pentagon and star-hull collision fixtures reduce to
the same convex family; do not count them as independent shape evidence.

Do not accept envelope area alone. Compare maximum side, span, hull waste,
total/dominant contacts, normalized contact units, holes, unplaced pieces,
canonical hash, runtime, and visual topology. Reject a smaller chain or a
lower-area layout with materially worse holes/contact structure.

### Validation commands

After each development cycle:

```sh
pnpm lint:fix
pnpm typecheck
```

At minimum run the affected subsystem suite:

```sh
pnpm test:focused \
  tests/unit/decisionTraceNdjson.test.ts \
  tests/unit/nfpIfpService.test.ts \
  tests/unit/irregularWindowedBeam.test.ts \
  tests/unit/irregularLayoutScorer.test.ts \
  tests/unit/irregularTriangleCompactGolden.test.ts \
  tests/unit/irregularSchemaContracts.test.ts \
  tests/unit/irregularPortfolio.test.ts \
  tests/renderer/resultCanvas.test.ts
```

Run the full repository suite before promotion. At the prompt checkpoint, two
`irregularBenchmark.test.ts` assertions also failed on the base commit. Recheck
the live base and candidate; classify only new failures as candidate
regressions.

Run the corpus through the committed harness:

```sh
pnpm corpus:sheet-invariance --output <immutable-output-directory>
```

Do not use a temporary constant edit as the final four-sheet proof. Extend or
reuse a committed reproducible four-sheet harness so another checkout can
regenerate the same hashes.

Render accepted SVGs with the repository Electron/Chromium renderer and inspect
the PNGs. Confirm visible background margin on all four sides and no clipping
before judging layout quality.

## Rejection rules

Reject a specific implementation, not the underlying research direction, when:

- the official triangle golden regresses;
- production output changes without a strict terminal quality improvement;
- contact-tier protection still produces chains or rings;
- a candidate becomes invariant by converging on a poor motif;
- runtime grows without a measured causal benefit;
- a comparator remains sheet-relative in a branch-removing decision;
- the result depends on an uncommitted injection or cannot reproduce its hash.

Keep the branch, commit, manifest, metrics, traces, and renders for every
coherent rejected candidate. Update `help/help.md` before switching to a
materially different hypothesis.

## Required deliverables

Do not finish with only recommendations. Produce:

1. a concise causal diagnosis of the first current-main four-sheet divergence;
2. a table of every tested variant, exact commit, mechanism, hashes, quality
   metrics, runtime, and decision;
3. the strongest implemented candidate in an isolated branch;
4. immutable manifests, diff hashes, reports, bounded traces, SVGs, and PNGs;
5. focused and full-suite results, including base-vs-candidate classification
   of any failure;
6. a source-level explanation of which Deepnest, SVGnest, libnest2d,
   PackingSolver, and Sparrow principles were transferred or rejected;
7. a production decision: promote, reject, or blocked by a precise falsifiable
   condition;
8. updated `help/help.md`, the relevant architecture page, artifact index, and
   durable research report;
9. a final project knowledge update with fresh qmd index and embeddings;
10. if the candidate passes every gate, a clean single-purpose integration
    branch and PR description using exactly `Why`, `What`, `How`, `Remarks`.

Do not merge production code without explicit authorization. Do not add AI or
tool attribution to branches, commits, PRs, comments, or project content.

## Final response format

Lead with the outcome:

- whether sheet invariance is actually closed;
- the common canonical hash and four-sheet quality table if closed;
- what was merged or left branch-local;
- the exact remaining blocker if not closed.

Then give only the evidence needed to continue: accepted/rejected mechanisms,
runtime, validation, artifact/report paths, and the next falsifiable step. Do
not claim success from area alone or from only the reference sheet.
