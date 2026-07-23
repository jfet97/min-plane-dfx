# V7 Irregular Nesting: Independent Search Redesign, Implementation, And Evidence Mission

> Historical implementation brief retained as decision provenance. “Current”
> refers to its named research checkout, not production at `b506344`.
> Repository paths were updated after the documentation move; this is not an
> active work plan.

You are taking over an advanced research branch of a deterministic convex
irregular-nesting engine. This is a combined architecture review,
implementation, experimentation, and evidence-delivery mission. It is not a
request for a summary, a speculative list of algorithms, or a fixture-specific
patch.

The previous independent review was extremely valuable. It identified that an
infinite-lattice far-neighbour certificate was being used too early as a
necessary finite-crop gate. That finding led to a real compact Triangle-20
construction and substantially changed the project. Since then, the branch has
implemented the finite-crop correction, audited every generated periodic source
and crop, tested exact contact-derived bases, built a more faithful adaptive
incumbent-pressure loop, and causally rejected its cross-target restart
mechanism. We now need another disruptive review informed by everything learned
since the first one.

Your mission is to improve the engine's generic search quality. You may change
pruning, construction, coordinated contraction/global search, portfolio
scheduling, and online budget allocation. You may implement more than one
bounded competing version. You must preserve exact legality, deterministic
replay, honest provenance, and immutable exact fallbacks.

The user cares about visibly and geometrically good layouts:

- compact occupied envelopes;
- no hollow rings, perimeter arcs, long contact chains, or stranded islands;
- strong side-to-side cohesion where geometry permits it;
- small pieces filling real pockets instead of decorating the perimeter;
- sheet-invariant preferences whenever the same placements remain legal;
- useful anytime behavior under realistic online budgets;
- no special cases for Triangle-20, Mixed-61, piece count, fixture name, or a
  remembered layout.

Do not optimize the research process for preserving historical byte identity at
the cost of quality. Exact deterministic legality and reproducibility are
mandatory; reproducing an old layout is not.

## Repository, Starting Point, Branch, And Remote Handoff

Fetch the repository and start from the current published research branch:

```text
repository: git@github.com:jfet97/min-plane-dfx.git
base branch: v7-geometric-cohesion
required base commit: d56d9d7
commit subject: Reject ineffective pressure restarts
```

Verify all three before working:

```sh
git fetch --all --prune
git switch v7-geometric-cohesion
git pull --ff-only
git rev-parse HEAD
git status --short
```

Create a descendant branch with no tool or model branding:

```text
v7-search-redesign-review
```

Push that branch and set its upstream. This work runs on another person's
machine, so a local-only branch is not a deliverable. If the machine uses a
fork, push to the writable fork and open the PR with the correct owner-qualified
head.

Open a pull request into `v7-geometric-cohesion`, not `main`, with title:

```text
Advance V7 irregular search design
```

The PR description must contain exactly these headings, in this order:

```md
## Why

## What

## How

## Remarks
```

Do not include model attribution, generated-by text, co-author footers, or
tool/process branding in the branch, commits, files, or PR.

## Mandatory First Reads

Read these committed files before forming a conclusion or editing code:

```text
AGENTS.md
CLAUDE.md                         # if present
SCORING_CRITERIA_NOTES.md
docs/architecture.md
docs/architecture/index.md
docs/architecture/irregular-v2-infrastructure.md
docs/planning/irregular-nesting-roadmap.md
docs/history/search-quality-decisions.md
docs/history/reviews/fable5-v7-search-quality-review.md
docs/research/open-source-nesting-strategies.md
docs/research/open-source-irregular-nesting-strategies.md
docs/research/dalsoo-abey-dalalah-transfer-study.md
docs/research/pre-v7-exactness-retained-foundations.md
docs/research/v7-seed-archive-stage0-stage1.md
docs/history/prompts/resolve-irregular-sheet-invariance.md
```

There is no portable `knowledge/` directory on your machine. Do not cite or
depend on it. Read the committed source and research documents, then clone the
external projects listed below yourself.

## Non-Negotiable Correctness Boundaries

1. Canonical integer-grid Clipper2 geometry is authoritative for exact
   collision legality, identity, topology, and endpoint admission.
2. SAT and continuous/relaxed collision loss may guide movement, but they may
   neither admit nor reject a final endpoint by themselves.
3. Robust convex predicates and direct placement validation remain the fast
   local authorities where the architecture currently assigns them. Audit the
   boundary; do not silently replace canonical admission with tolerances.
4. Sheet dimensions constrain legality and final q0/q90 fit. Balanced,
   edge-contact, and intrinsic compactness preferences must not change merely
   because a roomy sheet changes size.
5. Every experimental exact result competes in one sheet-free, phase-aware
   archive before final sheet fit. Existing exact baselines remain available as
   immutable fallbacks.
6. No fake macro-pieces, fake placements, fabricated free rectangles, saved
   fixture layouts, hidden fixture IDs, piece-count branches, or unexplained
   random search.
7. Temporary overlapping states are allowed only inside a clearly isolated
   global-search role. They never enter normal history or output and must be
   projected/admitted through exact authorities.
8. A lower relaxed loss is not a quality result. As contraction approaches
   zero, relaxed loss and conflict count naturally become easier. Only a new
   canonical-exact endpoint satisfying the common improvement gate can promote
   a global-search hypothesis.
9. Preserve source tags, deterministic seeds, complete budget accounting, and
   replay commands. Report deadline-censored work as inconclusive.
10. Keep search behavior in `src/workers/algorithm/`; geometry kernels and
    Effect service boundaries in `src/workers/irregular/` must not invent
    placements, scores, or search history.

## What Has Changed Since The Previous Review

The earlier review was based around commit `0b3309e`. Read the complete commit
range through `d56d9d7`. Important checkpoints follow.

### 1. The finite-periodic certificate diagnosis was correct

Commits `8ec00b4` through `9da94e2` demoted the infinite-lattice
far-neighbour certificate to a diagnostic for finite crops. Finite layouts are
materialized with exact grid translations, direct-validated member by member,
and admitted only through canonical legality.

Triangle-20 then produced a real canonical-legal, zero-cavity two-band layout:

```text
area:                 74,428.143126 mm2
maximum side:         487.983 mm
span:                 640.505 mm
canonical hash:       371db2696b65e2122b98bdb197a1d327df0c6ecbeca6ed73d2722971be52a127
positive components:  11
isolates:              10
```

This is much more compact than the old 88k V7 construction, but it is not the
cohesive golden lattice. Its two basis vectors are grid-representable, and
independent floor/ceil controls yield contactless strips. Do not independently
snap individual pieces or redefine a grid gap as contact.

Mixed-61 produced one canonical-legal zero-cavity endpoint at
`426,530.392211 mm2`, with `30/10` structural/dominant contacts, 21 isolates,
and hull-gap ratio `0.2392`. Seven of eight continuations hit their deadlines,
so that run is neither a promotion nor a periodic negative.

### 2. The raw source-survival audit ruled out a simple pruning explanation

Commits `3110a56` through `a7c697f` trace raw periodic sources before bounded
frontiers. For Triangle, the measured domain covered all 8 transforms and all
28 transform pairs. It generated:

```text
2,963 raw cells
4,627 direct-valid finite crops
294 bounded-front cells
303 bounded-front crops
10 complete raw Pareto witnesses
```

The compact 74k lattice is already in the complete raw Pareto set. Every more
connected witness is still fragmented; the first zero-isolate source is much
larger (`133,622.99898 mm2`) and still has ten components. Therefore the
current bounded axis-union plus arbitrary NFP-boundary-vertex P1/P2 generator
is not hiding the cohesive Triangle lattice merely through its frontier cap.

This conclusion is scoped to the explicitly generated domain. It is not a
proof that all finite motifs, all contact grammars, or all global search are
impossible.

### 3. A stronger exact contact-derived periodic source was also falsified

Commits `9848e17` through `37fd64f` derive phase-compatible antiparallel
physical-edge contact vectors. Triangle coverage is complete:

```text
8 transforms
28 transform pairs
11 distinct exact contact translations
4 non-collinear translation pairs
2 pairs rejected by material-area bound
2 remaining pairs collide under exact 3x3 repetition
0 admitted contact bases
```

The loose predecessors proved that isolated contacts were legal but mutually
phase-incompatible when repeated. No current evidence justifies widening the
same P1/P2 source, weakening exactness, or changing the contact definition.

### 4. Adaptive incumbent pressure was implemented and causally tested

Commits `8e1e123` through `d56d9d7` replace the old three unrelated static
boxes with seed-derived contractions at 5%, 2.5%, and 1.25%. Three failed
targets share 50,000 pressure evaluations. Four mandatory sweeps may extend to
eight while improving. Only canonical-exact, strictly improving endpoints may
be promoted.

The initial implementation carried up to three low-loss states and injected
group/split/interface disruptions at the next target. A paired capacity-0 vs
capacity-3 ablation proved that this restart transport was not helping:

```text
Triangle, capacity 0:
  2.5% loss  = 0.008297379
  1.25% loss = 0.000525129
  runtime    = 57.923 s
  exact endpoint: none

Triangle, capacity 3:
  2.5% loss  = 0.013267824
  1.25% loss = 0.003116739
  runtime    = 55.902 s
  exact endpoint: none

Mixed, capacity 0:
  losses     = 0.126383755, 0.037917172, 0.009810656
  runtime    = 143.398 s
  exact endpoint: none

Mixed, capacity 3:
  identical losses
  runtime    = 169.928 s
  exact endpoint: none
```

Restart transport is therefore disabled by default. Adaptive target depth,
truthful local/cumulative budget fields, exact fallback, and the isolated
pressure machinery remain. A reviewed next falsifier compares the current
1.25% contraction with a smaller contraction under equal budgets and no
restart. Its only positive gate is a new admissible canonical-exact
improvement. If neither arm produces one, this pressure branch stops; lower
relaxed loss cannot save it.

### 5. The best constructive Mixed result still matters

The best measured Mixed-61 geometric result remains the generic
`open-pocket-first` reconstruction:

```text
area:                 405,773.434 mm2
maximum side:         642.501 mm
enclosed cavities:    0
largest hull gap:     0.200227
```

It is better than the 426k periodic continuation and much better than the ugly
historical ring. It proves that construction order and cavity opportunity can
matter more than terminal comparator changes. It is not yet a universal online
policy, and its source/order interaction must be generalized rather than
special-cased.

### 6. Pruning and delayed value remain unresolved

Earlier V7 evidence showed all of the following:

- a useful Mixed placement was once absent from ordinary NFP endpoints and was
  recovered by a generic occupied-envelope event candidate;
- changing only terminal comparison cannot restore a branch pruned earlier;
- Triangle has legal compact partial witnesses that a proposed retention rule
  evicts even with total capacity 13;
- partial geometric beam width three improves some construction behavior but
  does not retain the right future far enough;
- a trace-only queue-vs-beam audit found heterogeneous Mixed depths with queue
  headroom, but Triangle had beam headroom and no queue headroom;
- contact-first growth creates chains and rings;
- area-first growth is also chain-forming;
- peel/reinsert, two-step closure, four-contributor reconstruction, rigid
  component-interface closure, and the first coordinated transport pilots did
  not repair Triangle cohesion.

This is a search problem: candidates can be missing, generated then locally
discarded, retained briefly then globally evicted, or reachable only after an
initially dominated sequence. Treat those as different failure modes.

## Main Source Areas To Audit

### Candidate generation and exactness

```text
src/workers/irregular/nfpIfpService.ts
src/workers/irregular/placementValidation.ts
src/workers/irregular/canonicalLayoutGeometry.ts
src/workers/irregular/geometryKernel.ts
src/workers/algorithm/irregular/intrinsicSuccessorPool.ts
src/workers/algorithm/irregular/intrinsicPeriodicCells.ts
```

### Construction, pruning, and archive

```text
src/workers/algorithm/irregular/windowedBeam.ts
src/workers/algorithm/irregular/irregularPlacementScorer.ts
src/workers/algorithm/irregular/irregularLayoutScorer.ts
src/workers/algorithm/irregular/intrinsicStrictDecoder.ts
src/workers/algorithm/irregular/intrinsicReconstructionPortfolio.ts
src/workers/algorithm/irregular/intrinsicPeriodicFamilyPortfolio.ts
src/workers/algorithm/irregular/intrinsicPartialGeometricBeam.ts
src/workers/algorithm/irregular/intrinsicV7SeedArchive.ts
```

### Coordinated/global search

```text
src/workers/algorithm/irregular/intrinsicTransformSeparator.ts
src/workers/algorithm/irregular/intrinsicSqueezeDisruptSeparate.ts
src/workers/algorithm/irregular/intrinsicGlobalSqueezePortfolio.ts
src/workers/algorithm/irregular/intrinsicExactProjection.ts
```

### Harnesses and fixtures

```text
scripts/irregular-intrinsic-v7-seed-archive.ts
scripts/irregular-intrinsic-periodic-family-portfolio.ts
scripts/irregular-intrinsic-global-squeeze-e4.ts
scripts/irregular-intrinsic-global-triangle-diagnostic.ts
scripts/irregular-targeted-exact-lns-probe.ts
scripts/irregular-sheet-invariance.ts
tests/fixtures/irregularSheetInvariance/mixed61-request.json
```

Use `rg --files src/workers/algorithm/irregular tests/unit scripts` to find any
renamed or newly split modules. Do not assume this list is exhaustive.

## External Source Projects: Clone And Read Them Yourself

Do not rely only on this repository's summaries. Clone each project into an
untracked external directory such as `/tmp/v7-nesting-references/`, check out
the pinned revision, and inspect the actual source. Do not commit the clones or
import code from them.

### Deepnest

```text
https://github.com/Jack000/Deepnest.git
2fb10513a30681971dcc991c528fa0738a2c0c76
```

Study the deterministic NFP decoder, absolute envelope objectives, GA over
order/rotation, elitism, and common-line bonus. Ask what belongs in a bounded
online constructor portfolio and what merely searches a bad decoder harder.

### SVGnest

```text
https://github.com/Jack000/SVGnest.git
1248dc21efd3f90d1aa52ba5785e27e5217ed2c9
```

Study the clean division between greedy placement and chromosome order/rotation
search, plus its absolute `2*width+height` pressure. Transfer the separation of
responsibilities, not the fixed axis bias.

### libnest2d

```text
https://github.com/tamasmeszaros/libnest2d.git
663daa69e1d7478669f714218e27681edbc96640
```

Study contour search across rotations, orientation-family coverage before
truncation, custom objectives, and hole contours. Determine whether our finite
candidate pool or its retention semantics are materially narrower.

### PackingSolver

```text
https://github.com/fontanf/packingsolver.git
3d8d97dd8ae5ac46f08328636f5e168283282ebc
```

Study its deterministic algorithm portfolio, tree/search guides, rotation
coverage, large-item-first then small-fill decomposition, periodic packing,
timers, and replay. Focus especially on how to allocate online budget across
heterogeneous algorithms without one universal comparator predicting the whole
future.

### Sparrow

```text
https://github.com/JeroenGar/sparrow.git
961ec31f576c5817ece779ff73982b4553760a4e
```

Read the real constructor, compression, separation, sampling, exploration,
disruption, best-sample pool, and coordinate-descent code. Our old fixed-box
separator was not faithful Sparrow. Compare its actual loop:

```text
legal incumbent
-> tighten current container
-> separate temporary overlaps
-> retain useful infeasible starts
-> disrupt/retry
-> accept a new exact feasible incumbent
-> tighten again
```

Determine what our adaptive-pressure implementation still lacks: movement
vocabulary, target progression, pool semantics, coordinate descent,
conflict-directed group movement, exact projection, or budget policy. Do not
copy Sparrow's collision kernel or strip-only objective.

### Dalsoo Bin Packing

```text
https://github.com/whitegreen/Dalsoo-Bin-Packing.git
bde2a3ef09f48980e59328eae7b042e6d9fdd4bc
```

Study both the Abey-style edge-alignment construction and the Dalalah-style
discrete rotation/vertex-contact construction, hull pressure, largest-first
order, edge subdivision, and examples. Its floating/asymmetric collision test
is not authoritative for this project. Its useful ideas are finite
geometry-derived pose grammars, reconstruction order, and cheap hull pressure.

### Primary papers

Download and read the papers directly. Convert PDFs to searchable text or
Markdown if useful, but visually inspect algorithms and figures whose meaning
depends on layout.

```text
Abeysooriya, Bennell, Martínez-Sykora (2018)
Jostle heuristics for the 2D-irregular shapes bin packing problems with free rotation
DOI: 10.1016/j.ijpe.2017.09.014
accepted manuscript:
https://eprints.whiterose.ac.uk/134688/1/Accepted_article_IJPE.pdf

Dalalah, Khrais, Bataineh (2014)
Waste minimization in irregular stock cutting
DOI: 10.1016/j.jmsy.2013.11.003
publisher record:
https://www.sciencedirect.com/science/article/abs/pii/S0278612513001209
```

If the Dalalah full text is unavailable, say so and limit claims to verifiable
source/publisher material. Do not invent missing paper details.

## Questions You Must Answer From Source And Evidence

### A. Current adaptive-pressure direction

1. Is the reviewed smaller-contraction ablation the best immediate falsifier,
   or does source inspection show that its move/projection vocabulary cannot
   possibly close the observed distributed conflicts?
2. If you run it, what smaller intrinsic step is justified by geometry rather
   than fixture tuning, and how do you freeze equal budgets fairly?
3. Why does raw loss fall while wall/pair conflicts may spread across more
   pieces? Is the scalar pressure objective directing movement toward a dead
   basin even when total penetration shrinks?
4. Should conflict topology, component cohesion, or exact candidate events
   influence relaxed-state retention with bounded weight rather than becoming
   either an absolute gate or a diagnostic-only field?
5. Is an exact finalization mechanism justified by traces, or would it merely
   hide inadequate coordinated movement?

### B. Pruning and delayed-value futures

6. Which irreversible pruning boundary currently loses the most valuable
   future: local candidate fanout, orientation-family truncation, whole-state
   beam, geometry deduplication, order scheduling, or terminal archive?
7. Design a generic delayed-value retention rule that can keep an initially
   dominated but structurally distinct future without exploding beam width.
   Consider Pareto layers, novelty/behavior descriptors, family coverage,
   bounded queue+beam hybrids, diverse quality archives, or lookahead—but prove
   why your proposal is not another arbitrary comparator tuple.
8. Can a cheap surrogate predict later pocket closure, hull closure, component
   merge, or envelope improvement? What counterfactual trace would falsify it
   before live promotion?
9. How should phase-aware canonical dedup preserve useful histories when equal
   occupied geometry but different remaining order or construction source can
   lead to different futures?

### C. Construction and source portfolios

10. How should ordinary NFP growth, occupied-envelope event candidates,
    pocket-first reconstruction, geometry-derived orders, large-first/small-fill,
    repeated-family seeds, and periodic finite crops compete under one exact
    archive?
11. Can the 405k Mixed result be generalized through a first-class cavity/open-
    pocket queue without fixture knowledge? Define cavity birth, accessibility,
    candidate assignment, piece eligibility, and bounded scheduling.
12. Can repeated-shape cohesion be constructed through a finite motif grammar
    richer than P1/P2 infinite lattices—e.g. small exact contact graphs,
    periodic supercells, or local cell assembly—without exponential explosion?
13. Does the evidence justify abandoning the current NFP pool, supplementing
    it, or changing when it is queried? If replacing any responsibility, state
    exactly what replaces candidate generation, direct legality, global
    legality, and deterministic replay.
14. What can be transferred from Dalsoo/Abey Jostle now that simple missing
    vertex/edge poses were largely ruled out? Examine rebuild orders,
    join/release, controlled kicks, and hole-first reconstruction rather than
    adding duplicate contact points.

### D. Coordinated global search

15. Compare our adaptive-pressure loop line-by-line with Sparrow. What is the
    smallest faithful coordinated movement step still missing?
16. Should movement operate on pieces, exact-contact components, conflict graph
    cuts, cavity boundaries, or a hierarchy of all four?
17. How can the search deliberately break a ring/arc topology and rebuild it
    without rewarding a different chain?
18. Would deterministic coordinate descent, large-neighborhood destroy/repair,
    component transport, or a small infeasible population best address the
    current distributed-conflict states?
19. Define the exact handoff: when is a relaxed state worth projecting, how is
    projection bounded, and which exact endpoint enters the archive?

### E. Effective online use

20. The app cannot spend research-level minutes on every ordinary request.
    Design quality tiers such as fast/default/high/max without hiding
    nondeterminism or weakening fallbacks.
21. Can an instance fingerprint—piece-family multiplicity, size distribution,
    transform count, cavity opportunity, NFP complexity, early search
    diversity—allocate budgets among constructors and global repair?
22. Which progress signals permit deterministic early stopping or budget
    transfer between arms? Avoid relaxed loss alone.
23. Should independent exact constructors run in parallel and publish results
    in deterministic replay order as PackingSolver does? Specify reproducible
    scheduling even if wall-clock completion order changes.
24. How can warm starts, cached NFPs, incremental topology, conflict graph
    updates, or spatial indexing reduce a 4–5 minute high-quality run to a
    useful online option?
25. Define a promotion path from research harness to optional quality mode and
    eventually to default production. Include latency and memory gates.

### F. Sheet invariance

26. Audit every branch-pruning decision for hidden sheet-normalized fields.
    Which remaining paths are truly sheet-free and which are only protected by
    a final fit gate?
27. Can a sheet-free constructor/global search produce one rigid layout first,
    then test q0/q90 against multiple sheets, while preserving useful legality
    alternatives for narrower sheets?
28. If exact common geometry is impossible because legal candidate sets differ,
    define the strongest meaningful invariance guarantee short of identical
    hashes.

## Required Work: Review Plus Real Implementation

Do not stop at the review document. Work in this order.

### Phase 0: reproduce and compress the current evidence

1. Verify base commit `d56d9d7` and run the focused tests.
2. Reproduce the current selected Triangle and Mixed layouts from committed
   harnesses. Do not assume `/private/tmp` artifacts from the original machine
   exist.
3. Reproduce only the compact summaries necessary for the restart ablation or
   rerun a smaller equivalent if full 166 MB reports are unreasonable.
4. Write a compact evidence table containing seed hash, exact result hash,
   area, maximum side, span, holes, hull gap/waste, contact components,
   isolates, structural/dominant contacts, evaluations, runtime, and deadline.

### Phase 1: perform the adversarial design review

Write the complete decision memo described below. Explicitly separate:

- facts verified from source or reproduced artifacts;
- inferences supported but not yet measured;
- hypotheses requiring experiments;
- mechanisms already falsified in their measured domain;
- ideas worth retaining even from rejected implementations.

### Phase 2: implement the most informative bounded experiments

Implement the smallest set of experiments that can answer the major decision,
not every imaginable combination. However, you may implement multiple variants
when they share a harness and yield a clean causal matrix—for example:

```text
A: current construction + current pruning
B: construction A + delayed-value retention
C: pocket/cavity-first construction + current pruning
D: pocket/cavity-first + delayed-value retention
E: best exact constructor + coordinated global repair
F: best exact constructor + coordinated repair + adaptive online budget
```

This matrix is illustrative, not mandatory. Choose variants from evidence. Each
variant must have one isolated hypothesis, an explicit source tag, a fixed
budget, and an exact fallback. Do not stack unrelated changes until their
individual effect is known.

At minimum, unless source evidence falsifies it before execution:

1. complete the reviewed equal-budget smaller-contraction test with restart
   disabled and the canonical-exact-only success gate;
2. test one generic pruning/delayed-value improvement through a trace-only
   counterfactual before allowing it to affect winners;
3. implement or repair one globally useful construction or coordinated-search
   mechanism supported by the external source audit;
4. measure one deterministic online scheduling/budget policy rather than
   assuming every arm always runs to its cap.

If Phase 1 proves one of these meaningless, document the proof and replace it
with the smallest experiment addressing the newly localized boundary.

### Phase 3: retain useful code and reject failed mechanisms honestly

You may make several commits. Preserve reusable tracing, exactness, accounting,
or harness improvements even when a search variant fails, but do not leave a
failed mechanism enabled by default. Keep rejected versions accessible through
commits or explicit diagnostic arms; do not accumulate dormant production
complexity without a documented reason.

## Trace And Artifact Discipline

Some current reports exceed 100 MB. Do not flood context, Git, or the review
document with raw trace arrays.

For every run:

1. Write raw immutable provenance outside Git, preferably under:

   ```text
   /private/tmp/min-plane-provenance/<experiment>-<commit>/<fixture>/
   ```

2. Record a manifest with source commit, dirty diff hash if any, command,
   fixture hash, settings, runtime environment, seed, budgets, report/SVG/PNG
   hashes, and canonical result hash.
3. Produce a compact `summary.json` or Markdown table with aggregate counters
   and only bounded witnesses:

   - first missing/generated/evicted useful witness;
   - first state entering each behavior class;
   - best exact endpoint per arm;
   - best relaxed state only as diagnostic;
   - termination reason and unused budget;
   - at most a small fixed number of representative lineage records.

4. Never serialize every proposal merely because it exists. Aggregate by
   source, transform family, depth, rejection reason, and behavior descriptor.
5. Preserve replay commands. Run at least two deterministic replays for any
   claimed exact improvement and compare canonical hashes.
6. Copy only accepted, reasonably sized evidence into the repository under:

   ```text
   docs/artifacts/v7-search-redesign/
   ```

   Include compact manifests, summaries, selected SVGs, readable PNGs, and a
   README. Do not commit enormous raw JSON traces.

7. Render every selected SVG with the repository's Electron/Chromium renderer:

   ```text
   .agents/skills/render-svg-with-electron/
   ```

   Inspect every PNG visually. Ensure the complete cluster is visible with
   margins and no editor/renderer cropping.

## Metrics And Quality Gates

Every exact endpoint must report at least:

```text
placed/unplaced count
canonical geometry hash
envelope area
maximum side
span
enclosed cavity count and area
largest occupied-hull gap ratio
occupied-hull waste ratio
isolated piece count
positive-contact component count
largest contact component size/ratio
structural contacts
dominant structural contacts
contact units
shared-boundary length
runtime
candidate/evaluation/projection counts
termination reason
```

### Triangle-20

Triangle is a homogeneous cohesion and repeated-geometry falsifier, not a
special production mode. Preserve the strong production golden as a regression
gate. Also compare against the current exact 74,428 periodic witness. A result
that merely makes a smaller strip while destroying side-to-side cohesion is not
a win.

### Mixed-61

Mixed is the heterogeneous cavity/topology stress test. Compare against:

```text
405,773.434 mm2 open-pocket-first geometric reference
426,530.392211 mm2 current zero-cavity periodic/adaptive seed
```

Prefer zero cavities, low hull gap, fewer islands, and stronger components at
comparable compactness. Do not promote a smaller but hollow ring or a
contact-rich perimeter chain.

### Additional corpora

Run at least:

- two homogeneous repeated-shape fixtures other than Triangle;
- the existing seven-fixture sheet-invariance corpus on at least two roomy
  sheets each;
- Mixed-50 if available;
- a heterogeneous fixture with small fillers;
- a case where candidate legality differs across sheets, to distinguish legal
  divergence from preference leakage.

### Runtime tiers

Measure cold runtime. Suggested research limits are up to 4–5 minutes for the
high-quality/global-search arm, but also report whether useful results appear
within 10s, 30s, 90s, and 180s. A promising algorithm must expose an anytime
exact incumbent and deterministic fallback rather than returning nothing until
the final deadline.

## Validation

After each meaningful implementation cycle inspect `package.json`, then run:

```sh
pnpm lint:fix
pnpm typecheck
```

Run the focused unit tests for every modified subsystem and add tests for new
budget, replay, exactness, pruning, and trace contracts. Before final delivery,
run the broadest relevant suite that fits the environment and clearly report
pre-existing failures separately from regressions.

## Required Repository Deliverables

Commit and push all useful work to `v7-search-redesign-review`.

### 1. One enormous standalone review and decision memo

Create exactly:

```text
docs/history/reviews/v7-search-redesign-review.md
```

It must be understandable without access to the original machine's
`/private/tmp` tree or `knowledge/`. Include:

```md
# Executive Verdict
# Current Architecture And Failure Model
# What Changed Since The Previous Review
# Evidence Reproduced On This Machine
# Findings Ranked By Severity
# Construction And Candidate Generation
# Pruning And Delayed Value
# Coordinated Contraction And Global Search
# Online Portfolio And Budgeting
# Sheet Invariance
# Open-Source And Paper Transfer Audit
# Implemented Variants
# Experimental Results
# Rejected Mechanisms And Why
# Recommended Production Architecture
# Exact Next Steps
# Reproduction Commands
# Artifact Index
```

The document must include possible fixes, alternative directions, concrete
source-level recommendations, risks, expected costs, falsification criteria,
and a ranked decision. It must explain both successes and failures. Do not bury
the recommended architecture under dozens of equal-weight ideas.

### 2. Real implementation

Commit the code, tests, trace schema, harness changes, and bounded variants you
actually used. Prefer separate descriptive commits for distinct hypotheses.
Do not put pseudocode in place of executable evidence.

### 3. Portable evidence

Commit small summaries, manifests, selected SVGs/PNGs, and their hashes under:

```text
docs/artifacts/v7-search-redesign/
```

Update its README with fixture, source commit, command, settings, metrics, and
whether each artifact is accepted, rejected, or diagnostic.

### 4. Project documentation

Update, as warranted by actual findings:

```text
docs/planning/irregular-nesting-roadmap.md
docs/history/search-quality-decisions.md
docs/architecture/irregular-v2-infrastructure.md
```

Do not rewrite history. Record accepted results, rejected hypotheses, exact
boundaries, and remaining uncertainty.

### 5. Final branch and PR

Before pushing:

```sh
git diff --check
git status --short
git log --oneline --decorate -n 20
```

Push the branch, open the PR into `v7-geometric-cohesion`, and report:

- branch name;
- commit list and SHA of the final head;
- PR URL;
- absolute path to the review document;
- absolute paths to every selected Triangle and Mixed PNG;
- compact summary/report paths;
- commands run and their outcomes;
- anything incomplete or blocked.

## Decision Standard

Be disruptive in architecture, conservative in truth claims, and ruthless about
causality. The project has spent too long tuning one mechanism at a time without
knowing whether the failure was candidate absence, pruning, construction order,
movement vocabulary, exact projection, or runtime allocation.

The desired outcome is not another clever tuple. It is a coherent search system
in which:

```text
multiple generic exact constructors
-> behavior-aware bounded retention
-> one common exact topology/compactness archive
-> optional faithful coordinated global improvement
-> deterministic online budget controller
-> exact final sheet fit
```

Challenge that architecture if source evidence supports something better. But
whatever you propose must generate and retain genuinely better exact layouts,
not merely improve a relaxed score, preserve a historical hash, or produce a
beautiful explanation.
