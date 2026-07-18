# Resolve irregular nesting sheet invariance

You are taking over a real production investigation in
`min-plane-dfx`. Work as an expert algorithm engineer and experimental
researcher. Do not stop at a code review, a list of ideas, or a generic nesting
survey. Reproduce the current behavior, locate the first causal divergence,
implement the strongest safe candidate in an isolated worktree, test it against
all quality gates, inspect rendered layouts, and leave the repository with a
reproducible result and a clear production decision.

The living project ledger is [`help/help.md`](../help/help.md). Read it before
acting, treat it as authoritative for accepted and rejected checkpoints, and
update it before leaving any new experiment or production decision. If this
prompt and the live ledger disagree, verify current `main` and follow the ledger.

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

At this prompt revision, the protected Pareto frontier lane is proposed
through pull request #4 (`protected-pareto-frontier-lane`) and the
sheet-invariance mechanism arc is complete with a verified blocker. Refresh
`main` and record the actual starting commit. This hash is a handoff
checkpoint, not permission to skip live verification. The arc's outcome, the
step-0 divergence, and the remaining blocker are recorded in
[`help/research/sheet-invariance-mechanism-arc-and-blocker.md`](../help/research/sheet-invariance-mechanism-arc-and-blocker.md);
read it before designing any new invariance experiment.

Read these files in order before editing:

1. `AGENTS.md` and `CLAUDE.md`, if present;
2. `knowledge/INDEX.md`, then the relevant knowledge pages;
3. `SCORING_CRITERIA_NOTES.md`;
4. `docs/architecture.md`;
5. `docs/architecture/irregular-v2-infrastructure.md`;
6. [`help/help.md`](../help/help.md), especially Current Production Truth,
   Current Research Status, the provenance ledger, and the newest
   investigation-log entry;
7. [`help/research/protected-intrinsic-contact-seed.md`](../help/research/protected-intrinsic-contact-seed.md);
8. [`help/research/contact-tier-intrinsic-reservation.md`](../help/research/contact-tier-intrinsic-reservation.md);
9. [`help/research/protected-contact-tier-reservation.md`](../help/research/protected-contact-tier-reservation.md);
10. [`help/research/protected-boundary-anchor-diversity.md`](../help/research/protected-boundary-anchor-diversity.md);
11. [`help/research/open-source-nesting-strategies.md`](../help/research/open-source-nesting-strategies.md);
12. [`help/research/bounded-ga-order-rotation-probe.md`](../help/research/bounded-ga-order-rotation-probe.md);
13. [`docs/research/deepnest-svgnest-source-comparison.md`](../docs/research/deepnest-svgnest-source-comparison.md);
14. [`docs/research/irregular-nesting-literature-and-web-research.md`](../docs/research/irregular-nesting-literature-and-web-research.md).

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
  boundary-anchor and intrinsic-contact lanes are active only when repair is
  disabled, beam width is greater than one, and no chromosome transform
  preference is active.
- Production beam slots and the width-one incumbent are isolated from both
  protected lanes. The legacy boundary lane retains width eight; the intrinsic
  contact lane retains width one. Cross-lane geometry deduplication preserves
  the production representative and propagates only eligibility.
- Production, boundary, and intrinsic terminal candidates are oriented
  independently. Each protected result may win only if it is strictly better
  under the production layout comparator and strictly smaller in
  collision-envelope area.
- A converged state can carry both protected eligibilities. Decision traces must
  report the rank of the lane that actually caused retention.
- The NFP near-parallel crossing recovery is already merged. Do not conflate
  this search investigation with that resolved kernel crash.

### Mixed-61 four-sheet checkpoint

The current measured outputs are:

| Sheet | Envelope area | Holes | Current status |
| --- | ---: | ---: | --- |
| `1000 x 1300` | `506,644.934 mm2` | 12 | unchanged post-canonicalization geometry |
| `1000 x 1700` | `461,475.664 mm2` | 10 | unchanged post-canonicalization geometry |
| `2000 x 1700` | `535,808.686 mm2` | 4 | protected intrinsic contact winner |
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
and discarded a distinct sheet-boundary lineage. The merged boundary-anchor
lane recovers that lineage. The later protected intrinsic contact lane recovers a
smaller `2000 x 1700` lineage without changing the other three hashes.

The general gap remains earlier in pruning:

- balanced and edge-contact local compactness still divide occupied width and
  height by sheet width and height;
- the same legal candidate can therefore receive a different local rank on a
  different roomy sheet and disappear before whole-beam protection sees it;
- the legacy boundary lane intentionally follows a sheet-relative historical
  order and cannot be the invariant decoder;
- the width-one intrinsic lane is sheet-independent, but one survivor is not
  enough to recover the common reference motif on the remaining sheets.

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
- The rejected `protected-contact-tier-reservation` narrow local port remained
  shape-dependent: it improved the pentagon/star hull family but regressed
  trapezoids and mixed-50 and did not help mixed-61.
- Moving the same primitive behind production fanout succeeds: all existing
  corpus hashes remain exact, while the `2000 x 1700` mixed-61 area improves
  `18.99%` and holes fall from 6 to 4.
- The unsafe placement in production fanout is disproven; the protected role is
  now production evidence, not only a research lead.

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

## Completed primary hypothesis

The first protected intrinsic experiment is accepted. It generates at most one
max-side-first candidate from a duplicated positive canonical shared-boundary
length, tags it protected-only, and advances one descendant under a
sheet-independent order. It never replaces or reorders production fanout.

The experiment answered the original questions:

1. the useful `2000 x 1700` branch was available in the real legal local set but
   absent from production fanout;
2. no geometry, NFP/IFP, transform, production-fanout, or production-beam change
   was required;
3. positive exact shared-boundary length was sufficient for the seed;
4. keeping the legacy width-eight boundary role and a separate width-one
   intrinsic role preserved both quality checkpoints safely;
5. geometry deduplication keeps the production representative and ORs only lane
   eligibility;
6. the intrinsic branch-removing order now excludes normalized sheet fields,
   sheet-boundary coordinates, and free-material metrics, using
   translation-normalized combined geometry for final ties.

The result is partial: four canonical hashes remain. The next experiment must
expand protected intrinsic coverage without consuming production slots or
weakening terminal Pareto acceptance.

## Next hypotheses, in order

The protected Pareto frontier arc (hypotheses 1-3 below) is complete and its
outcome is recorded in
[`help/research/sheet-invariance-mechanism-arc-and-blocker.md`](../help/research/sheet-invariance-mechanism-arc-and-blocker.md):
the lane is safe and promoted (PR #4), but sheet invariance is not closed
because the reference motif is sheet-relative-bound. Any new invariance
experiment must start from that report, not from the hypotheses below, which
are retained as the already-evaluated record.

Continue from the accepted primary result in this order. Record a counterexample
before switching away from any specific follow-up.

1. **Guided canonical replay of a found motif (legacy-reference role).** The
   verified blocker is that per-sheet decodes cannot reproduce the reference
   lineage (locally-dominated branches at depths 1/2/4; terminal gate
   arithmetic; trajectory divergence). Test a bounded replay of a motif found
   on one sheet as a protected prefix on the others, with an invariant
   terminal selection and the holes floor, and prove the dual gate on every
   sheet. This requires a cross-decode coordination step the single-request
   production flow does not have; evaluate it as an explicit corpus-mode
   stage, never as hidden per-request behavior.
2. **Invariantly reachable common motif search.** Instead of forcing the
   reference, search for a compact motif at reference quality (area <=
   430,344.918 mm2, <= 2 holes, >= 53/14 contacts, and beating the 2000 x 1700
   58/16 terminal gate) that the protected lanes can produce on all four
   sheets. The measured leads are the 426,881.608 mm2 / 56-15 / 3-hole and the
   557,698.950 mm2 / 65-17 / 2-hole states; neither satisfies the full bar.
3. **Orientation-family coverage before local truncation.** Transfer
   libnest2d's useful pattern: compare the best real candidate from each
   meaningful rotation/mirror family before the protected cap, without changing
   the production transform cap. Already shown by the probe to be necessary
   (depth-2) but not sufficient (depths 1/4) alone.
4. **Shared-prefix deterministic portfolio.** Only after the invariant decoder
   is sound, test one additional order/rotation seed while reusing prefix and
   geometry work. Do not run two full decodes if equivalent work can be shared.
5. **Optional GA.** Evaluate small priority/rotation-only budgets last, always
   retaining the deterministic baseline. Placement-policy mutation remains off
   until scoring semantics are invariant.

Completed and retained as the evaluated record, not as open work:

- ~~Protected Pareto frontier within exact contact strength~~: implemented and
  promoted (PR #4); measured safe, did not close invariance.
- ~~Canonical legacy lane + invariant terminal (v5/v5b)~~: rejected; loses the
  approved reference (`436,770.039 mm2` / 42-10 instead of
  `430,344.918 mm2` / 53-14) because determinism destroys the
  reference-producing trajectory.

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

The boundary-anchor lane costs approximately `1.7-2.0x` on active corpus paths
relative to the pre-boundary checkpoint. The later intrinsic sublane adds
about `1.05x` on `1000 x 1300` and `1.16x` on the changed `2000 x 1700` path
relative to its merged base. Compare every new candidate against the live merged
starting commit, not either historical baseline. Target no more than `1.25x`
additional runtime. If the solution needs more, explain the measured
quality/time frontier and do not hide the cost.

Prefer shared immutable geometry and score caches. Do not merge production and
protected retention semantics merely to reduce work.

## Mandatory acceptance gates

### Exact behavior

- all pieces placed and every final placement legal;
- deterministic canonical geometry hashes across repeated runs;
- replay/search equivalence where applicable;
- no fabricated placements, scores, free rectangles, history, or preview data;
- official repair-8 triangle golden green with its current dense lattice;
- both protected lanes remain disabled under terminal repair;
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
pnpm corpus:sheet-invariance \
  --case mixed-61 \
  --sheets 1000x1300,1000x1700,2000x1700,2000x2700 \
  --output <immutable-four-sheet-output-directory>
```

Do not use a temporary constant edit as the final four-sheet proof. The committed
`--sheets` interface is the provenance boundary; another checkout must be able
to regenerate the same matrix and hashes.

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
coherent rejected candidate. Update the living
[`help/help.md`](../help/help.md) ledger before switching to a materially
different hypothesis.

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
8. updated [`help/help.md`](../help/help.md), the relevant architecture page,
   artifact index, durable research report, and this prompt when its verified
   starting truth or next hypothesis changes;
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
