# Resolve irregular nesting sheet invariance

> Historical execution brief retained as decision provenance. Its “current”
> claims describe the fixed-reference era, not production at `b506344`; use the
> active roadmap and architecture for new work. Repository paths were updated
> after the documentation move, but the instructions themselves are not active.

You are taking over a real production investigation in
`min-plane-dfx`. Work as an expert algorithm engineer and experimental
researcher. Do not stop at a code review, a list of ideas, or a generic nesting
survey. Reproduce the current behavior, locate the first causal divergence,
implement the strongest safe candidate in an isolated worktree, test it against
all quality gates, inspect rendered layouts, and leave the repository with a
reproducible result and a clear production decision.

The living project ledger is [`docs/history/search-quality-decisions.md`](../search-quality-decisions.md). Read it before
acting, treat it as authoritative for accepted and rejected checkpoints, and
update it before leaving any new experiment or production decision. If this
prompt and the live ledger disagree, verify current `main` and follow the ledger.

## Mission status and continuation

The flagship mixed-61 sheet-invariance gap is closed. Preserve and independently
reproduce that result before attempting to generalize or optimize it.

For the same pieces and settings, every sheet on which the target compact motif
is legal should select the same collision geometry after canonicalization under
translation and rigid quarter-turn rotation. Sheet width, height, and aspect
ratio may constrain legality. They must not change balanced or edge-contact
compactness preferences. `short_side_fill` is the deliberate sheet-relative
exception.

The accepted implementation returns the exact approved two-hole motif on ten
legal sheets. The next mission is to reduce the protected second-decode cost,
generalize its intrinsic certificate only with counterexamples and corpus
evidence, and investigate mixed-50 separately. It must retain the official
triangle lattice, legality, determinism, trace truthfulness, and the exact
mixed-61 hash.

## Checkout and source of truth

Start from the repository root:

```text
/Users/andreasimonecosta/Documents/Work/min-plane-dfx
```

At this prompt revision, the canonical-reference decode handoff is the accepted
production result. Refresh `main` and record the actual starting commit. This
hash is a handoff checkpoint, not permission to skip live verification. Read
[`docs/research/canonical-reference-decode-handoff.md`](../../research/canonical-reference-decode-handoff.md)
first. The preceding step-0 divergence and per-sheet-decode blocker remain
recorded in
[`docs/research/sheet-invariance-mechanism-arc-and-blocker.md`](../../research/sheet-invariance-mechanism-arc-and-blocker.md);
read it to understand why comparator-only changes failed.

Read these files in order before editing:

1. `AGENTS.md` and `CLAUDE.md`, if present;
2. `knowledge/INDEX.md`, then the relevant knowledge pages;
3. `SCORING_CRITERIA_NOTES.md`;
4. `docs/architecture.md`;
5. `docs/architecture/irregular-v2-infrastructure.md`;
6. [`docs/history/search-quality-decisions.md`](../search-quality-decisions.md), especially Current Production Truth,
   Current Research Status, the provenance ledger, and the newest
   investigation-log entry;
7. [`docs/research/protected-intrinsic-contact-seed.md`](../../research/protected-intrinsic-contact-seed.md);
8. [`docs/research/contact-tier-intrinsic-reservation.md`](../../research/contact-tier-intrinsic-reservation.md);
9. [`docs/research/protected-contact-tier-reservation.md`](../../research/protected-contact-tier-reservation.md);
10. [`docs/research/protected-boundary-anchor-diversity.md`](../../research/protected-boundary-anchor-diversity.md);
11. [`docs/research/open-source-nesting-strategies.md`](../../research/open-source-nesting-strategies.md);
12. [`docs/research/bounded-ga-order-rotation-probe.md`](../../research/bounded-ga-order-rotation-probe.md);
13. [`docs/research/deepnest-svgnest-source-comparison.md`](../../research/deepnest-svgnest-source-comparison.md);
14. [`docs/research/irregular-nesting-literature-and-web-research.md`](../../research/irregular-nesting-literature-and-web-research.md);
15. [`docs/research/canonical-reference-decode-handoff.md`](../../research/canonical-reference-decode-handoff.md).

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
- Explicit compact-quality jobs may additionally run one protected fixed
  `2000 x 2700` decode. This outer coordinator is nonrecursive, shares
  cancellation and progress with the requested decode, and keeps histories
  private until one real winner is selected.
- A distinct canonical finalist must fit the requested sheet at q0 or q90 with
  zero positive overlap and pass the intrinsic certificate documented in
  [`docs/research/canonical-reference-decode-handoff.md`](../../research/canonical-reference-decode-handoff.md).
  Incomplete, non-finite, schema-invalid, uncertified, or identity-equivalent
  candidates retain production. The capability defaults off.
- The NFP near-parallel crossing recovery is already merged. Do not conflate
  this search investigation with that resolved kernel crash.

### Mixed-61 ten-sheet checkpoint

The review-hardened candidate returns the same result on every measured sheet:

| Sheets | Envelope area | Holes | Contacts | Canonical result |
| --- | ---: | ---: | ---: | --- |
| `900x1800`, `1000x1300`, `1000x1700`, `1100x1100`, `1200x1600` | `430,344.918 mm2` | 2 | `53/14` | exact |
| `1400x1100`, `1500x2200`, `1700x1000`, `2000x1700`, `2000x2700` | `430,344.918 mm2` | 2 | `53/14` | exact |

The reference result has canonical hash:

```text
40f8ac9c0fb24073ac141b5fb667366af55df90c78c6cca21ff76703a4a7f300
```

It has 53 total and 14 dominant structural contacts. Its `545.515 x 788.878
mm` envelope fits all ten sheets. Exact q0/q90 legality is rechecked on the real
requested sheet before the protected result can be selected.

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

This boundary is resolved for mixed-61 by cross-decode coordination, not by a
new comparator. A terminal comparator still cannot recover a branch removed by
local fanout or earlier protected-lane pruning inside one requested-sheet tree.
The accepted coordinator obtains the exact terminal from a fixed protected
decode, then admits it only through sheet-free intrinsic topology and real-sheet
legality.

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

This was a historical partial result. The later canonical-reference handoff
closed the mixed-61 gap without weakening production fanout or the protected
lanes.

## Next hypotheses, in order

Continue from the accepted handoff in this order. Record a counterexample before
changing certificate bounds or enabling the role for another workload.

1. **Share deterministic decode work.** Profile repeated preparation, NFP/IFP,
   candidate generation, state scoring, and prefix expansion across the requested
   and reference roles. Reuse only immutable geometry or exact prefix results;
   role retention and traces must remain isolated. The target is to reduce the
   measured `70.4-89.3 s` non-reference runtime without changing any hash.
2. **Build a certificate-negative corpus.** Add layouts that are complete and
   legal but ring-forming, chain-forming, fragmented, reflected, or topology-
   ambiguous. Prove that each intrinsic bound rejects its intended failure mode
   before broadening the explicit opt-in beyond the flagship workload family.
3. **Investigate mixed-50 independently.** The rejected unconditional priority
   changed its compact topology from four to six holes. The accepted certificate
   rejects its protected reference candidate (hull-gap `0.2373`, five isolated
   pieces). Find a better source motif or decoder without relaxing the mixed-61
   safety boundary to admit that regression.
4. **General intrinsic decoder research.** Orientation-family coverage,
   max-side-first contact growth, bounded global squeeze, and optional GA remain
   useful research inputs. They are not required to preserve the now-closed
   mixed-61 result and must remain isolated experiments.

Completed and retained as the evaluated record, not as open work:

- ~~Protected Pareto frontier within exact contact strength~~: implemented and
  promoted (PR #4); measured safe, did not close invariance.
- ~~Canonical legacy lane + invariant terminal (v5/v5b)~~: rejected; loses the
  approved reference (`436,770.039 mm2` / 42-10 instead of
  `430,344.918 mm2` / 53-14) because determinism destroys the
  reference-producing trajectory.
- ~~Guided canonical replay / cross-decode coordination~~: completed as the
  fixed reference decode handoff. Ten sheets return the approved hash under
  exact real-sheet legality and a sheet-free topology certificate.

## Experiment protocol

### 1. Establish immutable baseline

- Create a human-named experiment branch and isolated worktree from the latest
  `origin/main`.
- Record the base commit, working diff hash, Node/pnpm/Electron versions,
  operating system, fixture hashes, exact settings, and commands.
- Run the current corpus and all ten mixed-61 sheets recorded in the accepted
  artifact report.
- Produce bounded decision traces for the first divergence; do not emit
  avoidable full-state payloads merely to make the trace large.
- Render all ten mixed-61 outputs to PNG using
  `.agents/skills/render-svg-with-electron/` and inspect all margins and cluster
  connectivity.
- Store immutable evidence under a new directory in
  `/private/tmp/min-plane-provenance/`.

### 2. Preserve the established causal boundary

Do not repeat the step-0 divergence or forced-lineage work unless a proposed
decoder change invalidates it. For a new workload, compare the same parent
geometry and same legal moving candidate across the relevant sheets. Report:

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
- mixed-61 on all ten accepted sheets.

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
  --sheets 900x1800,1000x1300,1000x1700,1100x1100,1200x1600,1400x1100,1500x2200,1700x1000,2000x1700,2000x2700 \
  --output <immutable-ten-sheet-output-directory>
```

Do not use a temporary constant edit as the final ten-sheet proof. The committed
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
[`docs/history/search-quality-decisions.md`](../search-quality-decisions.md) ledger before switching to a materially
different hypothesis.

## Required deliverables

Do not finish with only recommendations. Produce:

1. a concise causal diagnosis of any regression from the accepted ten-sheet result;
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
8. updated [`docs/history/search-quality-decisions.md`](../search-quality-decisions.md), the relevant architecture page,
   artifact index, durable research report, and this prompt when its verified
   starting truth or next hypothesis changes;
9. a final project knowledge update with fresh qmd index and embeddings;
10. if the candidate passes every gate, a clean single-purpose integration
    branch and PR description using exactly `Why`, `What`, `How`, `Remarks`.

Do not merge production code without explicit authorization. Do not add AI or
tool attribution to branches, commits, PRs, comments, or project content.

## Final response format

Lead with the outcome:

- whether the accepted sheet invariance remains closed;
- the common canonical hash and ten-sheet quality table;
- what was merged or left branch-local;
- the exact remaining blocker if not closed.

Then give only the evidence needed to continue: accepted/rejected mechanisms,
runtime, validation, artifact/report paths, and the next falsifiable step. Do
not claim success from area alone or from only the reference sheet.
