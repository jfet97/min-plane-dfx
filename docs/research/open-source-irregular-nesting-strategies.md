# Open-Source Irregular Nesting Strategy Comparison

## Scope

This report compares three additional open-source irregular nesting engines
against the current `min-plane-dfx` irregular beam. It complements the existing
Deepnest/SVGnest analysis in `docs/planning/irregular-nesting-roadmap.md` and focuses on mechanisms that may improve
both the repeated-triangle fixture and larger mixed-shape jobs.

The source was read from local checkouts under `/private/tmp`; no behavior below
is inferred from screenshots or project marketing.

| Project | Revision inspected | Revision date |
| --- | --- | --- |
| libnest2d | `663daa69e1d7478669f714218e27681edbc96640` | 2022-11-16 |
| PackingSolver | `3d8d97dd8ae5ac46f08328636f5e168283282ebc` | 2026-07-15 |
| Sparrow | `961ec31f576c5817ece779ff73982b4553760a4e` | 2026-06-30 |

The PackingSolver revision is newer than the current date of many published
releases. Its periodic-packing and large-item-first modules are present and
tested or callable in isolation, but neither is called from the main irregular
`optimize` entry point at this revision. They are useful algorithm references,
not evidence of production integration.

## Executive Conclusion

None of the inspected engines treats total shared boundary as a universal proxy
for compactness. They directly optimize an envelope, strip width, density,
feasibility, or a support-based guide. This supports keeping structural contact
as a useful lattice signal while preventing it from overriding materially worse
sheet consumption.

The strongest transferable design is a bounded portfolio of real decoders:

1. retain the current legal NFP/IFP beam as the baseline;
2. add a periodic-cell seed or decoder for high-copy interchangeable classes;
3. add a large-item-first mixed-shape decoder that fixes a good macro layout,
   then fills small pieces;
4. compare every validated terminal layout with one shared final comparator.

This avoids a screenshot-specific conditional threshold. A routing condition,
when required for runtime, should use structural instance traits such as copy
concentration and convex-hull-area dispersion. Prefer running at least one
bounded decode from each applicable family when the budget permits.

## Strategy Matrix

| Engine | Candidate generation | Initial order | Primary objective | Compaction or repair | Identical copies | Runtime controls |
| --- | --- | --- | --- | --- | --- | --- |
| libnest2d | NFP contours for every configured rotation; contour-local optimization from NFP corners | Selector dependent; FirstFit and Filler use descending area, with priority before area in FirstFit | Default placement score is distance to bin center plus squared overfit; custom callback may replace it | No whole-layout post-compaction in the NFP placer | Copies remain ordinary items; no periodic-cell quotient | Accuracy slider, optional parallel contour search, optimizer stop predicates and iteration limits |
| PackingSolver | Support/trapezoid tree branching, plus separate local, MILP, and sequential solvers | Algorithm dependent; local search builds largest first | Guide area or bounding-box area normalized by occupied hull/profit; final objective owned by the instance | Separate stochastic local search; standalone large-item-first decomposition | Native item-type copy counts; standalone one/two-item periodic-cell generator | Shared timer, memory limit, algorithm flags, deterministic replay of parallel results |
| Sparrow | Uniform and focused transformation samples, retaining distinct starts before coordinate descent | Descending `convex_hull_area * diameter` | Legal left-bottom construction, then strip-width/density improvement | Temporary-overlap separation, disruption, exploration, and compression phases | Quantities expanded during construction; no periodic-cell quotient in LBF | Explicit phase deadlines, sample counts, coordinate-descent counts, failed-attempt limits, parallel separator workers |

## libnest2d

### Placement mechanics

`include/libnest2d/placers/nfpplacer.hpp:29-123` exposes rotations,
start/alignment policy, a custom placement objective, an accuracy-versus-speed
control, optional parallelism, and a `before_packing` callback that sees the
merged pile, placed items, and remaining items.

The default objective in `nfpplacer.hpp:637-671` measures the candidate item's
bounding-box center distance from the bin center and adds a squared overfit
penalty. It does not score shared contact. The first item tries every configured
rotation at the selected starting point (`nfpplacer.hpp:674-695`). Later items
build an NFP for every configured rotation (`nfpplacer.hpp:699-721`), optimize
along each contour from its corners (`nfpplacer.hpp:772-876`), and select the
best score across all rotations (`nfpplacer.hpp:879-895`).

The important transfer is transform-family coverage: each retained orientation
gets a placement search before the global choice. `min-plane-dfx` already keeps
the four orthogonal transforms ahead of derived transforms in
`src/workers/irregular/transformGenerator.ts:220-249`; it should preserve that
coverage and benchmark whether mirrored or derived families can still starve
under the remaining cap.

### Selection mechanics

FirstFit orders by priority and then descending area
(`include/libnest2d/selections/firstfit.hpp:66-104`). Filler uses descending
area (`selections/filler.hpp:56-79`). The more involved DJD selector estimates a
bin-count lower bound, chooses parallel execution by item and vertex count, and
tries singles, pairs, and triplets under progressively relaxed waste limits
(`selections/djd_heuristic.hpp:572-696`).

The useful lesson is that small bounded groups can be searched explicitly. The
library does not provide an identical-copy canonical state or a periodic motif,
so it does not solve repeated triangles by itself.

## PackingSolver

### Tree-search guide and portfolio routing

PackingSolver's irregular tree search is support/trapezoid based rather than an
NFP placer. Its node comparator offers guide-area and bounding-box-area variants
normalized by occupied convex-hull area, profit, or mean item area
(`src/irregular/tree_search.hpp:643-728`). These objectives directly expose
envelope waste instead of assuming that more contact means less waste.

The main optimizer selects a portfolio from objective, bin count, estimated
items per bin, and mean item-type copies (`src/irregular/optimize.cpp:431-602`).
Selected algorithms may run concurrently. In deterministic mode, each writes a
private output that is replayed in a fixed order after completion
(`optimize.cpp:627-647`). This is the strongest architectural precedent for
instance-trait routing plus a common terminal comparison.

### Transform selection

The checked revision scores rotation/mirror candidates by bounding-box waste
relative to convex-hull area and deduplicates equal normalized transformed
shapes (`src/irregular/rotations.cpp:228-374`). Per bin, it reserves minimum
width and minimum height choices, ensures coverage for every item type, rejects
equivalent transforms, and then fills a global budget of at least 100 or five
times the item-type count (`rotations.cpp:390-580`).

The direct transfer is not the large absolute budget. It is the allocation
order: deduplicate first, guarantee per-item and extreme-span coverage, and only
then spend the remaining global cap by quality.

### Repeated-item periodic cells

`src/irregular/periodic_packing.cpp:380-476` constructs horizontal and vertical
lattice vectors from pair NFPs and validates neighboring repeated cells. The
one-shape entry point is at `periodic_packing.cpp:484-510`. The two-rotation
entry point derives candidates from NFP boundary vertices and constraint-line
intersections, deduplicates them, and validates the lattice
(`periodic_packing.cpp:512-607`). `periodic_packing.cpp:609-675` computes
one-item and two-rotation cells per item type.

Repository-wide call search finds the implementation, header, and tests, but no
call from `optimize`. Therefore `min-plane-dfx` should treat this as a reference
for a new decoder, not copy an assumed production pipeline. A valid integration
must expand cells over the finite sheet, create ordinary real placements, run
the existing direct legality validator, and let the common terminal scorer
compare the result. It must never hardcode the known triangle motif.

### Large-item-first decomposition

The standalone `large_item_first` module classifies non-fixed item types by
convex-hull area, with a threshold of one eighth of the largest type
(`src/irregular/large_item_first.cpp:23-64`). It solves the large-only problem,
then fixes those placements while solving for the small items
(`large_item_first.cpp:90-150` and the following phase-two construction).

The module is not called from the main optimizer in the inspected revision.
Still, it precisely targets the observed mixed fixture failure where small
repeated pieces can consume early search capacity while large rectangles are
left to awkward late placements. In `min-plane-dfx`, test this as an additional
decoder or bounded survivor family, not a silent replacement for the user-owned
initial ordering boundary.

### Runtime controls

`include/packingsolver/irregular/optimize.hpp:20-64` exposes memory limits,
algorithm switches, approximation controls, and queue sizes through shared
parameters. The main optimizer checks its common timer before dispatch
(`optimize.cpp:627-634`). The transferable point is a shared budget across a
portfolio, with explicit per-family allocations and deterministic result merge.

## Sparrow

### Constructive start

Sparrow is not an NFP engine. Its LBF constructor expands quantities after
sorting item types by descending convex-hull area times diameter
(`src/optimizer/lbf.rs:38-61`). Legal candidates are scored left-bottom with x
weighted ten times y (`src/eval/lbf_evaluator.rs:9-49`).

For each item it samples the whole container and, when available, a focused
region around the current placement. It keeps several distinct best starts,
refines all of them with coordinate descent, then finely refines the best one
(`src/sample/search.rs:12-76`). `src/sample/best_samples.rs:7-107` evicts the
worst retained start and merges transformations that are too similar. The
translation threshold scales with the item's minimum dimension and the angular
threshold is one degree. Defaults are 1,000 container samples and three
coordinate descents (`src/consts.rs:28-55`).

The transferable ideas are size-aware initial construction and diversity before
local refinement. `min-plane-dfx` already deduplicates local geometry and
reserves a compactness candidate in `windowedBeam.ts:916-1014`; any Sparrow-like
change should be measured as stronger transform-family or spatial-basin
diversity rather than duplicate another generic compactness survivor.

### Infeasible local search

Sparrow repeatedly shrinks a feasible strip, keeps a ranked pool of infeasible
layouts after failed separation, restores a weighted random member, and
disrupts it (`src/optimizer/explore.rs:20-84`). Its separator runs multiple local
workers, moves colliding items in varied orders, and keeps the lowest collision
loss (`src/optimizer/separator.rs:40-178`). Exploration and compression receive
explicit time shares; defaults are 80% and 20%
(`src/main.rs:38-62`, `src/consts.rs:31-36`).

This phase intentionally uses overlapping intermediate states. It is not a
drop-in replacement for the current legal-at-every-step beam or its replay
history. It could become an optional terminal local-search family only if every
emitted winning state is reconstructed from and validated as legal real
placements.

Sparrow's collision evaluator does offer one low-risk runtime lesson: it checks
a cheap surrogate first and lets exact evaluation stop when accumulated loss
cannot beat the current upper bound
(`src/eval/specialized_jaguars_pipeline.rs:24-88`). Comparable fail-fast bounds
are worth profiling in expensive candidate validation, but only after measuring
the current hot path.

## Comparison With the Current Beam

The current implementation already includes several previously missing
protections:

- local candidates are deduplicated by canonical occupied geometry;
- edge-contact policy reserves one balanced-compactness candidate before local
  fanout pruning (`windowedBeam.ts:916-1014`);
- beam states quotient interchangeable remaining pieces by a structural
  signature rather than ordered copy IDs (`windowedBeam.ts:1373-1422`);
- terminal layout ordering puts repeated structural-contact counts first, then
  collision-envelope metrics, and only later contact bands and raw boundary
  length (`irregularLayoutScorer.ts:501-525`).

Those safeguards mean another scalar band sweep alone is unlikely to address
all failures. The source comparison points instead to missing constructive
families: periodic repeated-item seeds and macro-first mixed-size layouts.

## Recommended Production Experiments

### Priority 0: establish one common terminal gate

Every decoder must return ordinary source-linked placements and pass the same
IFP/NFP plus direct collision validation. Compare complete legal layouts using
the same terminal score. The final comparator should continue to expose sheet
consumption and hull waste directly; contact remains a structural signal, not a
substitute for those metrics.

### Priority 1: periodic repeated-class decoder

For each interchangeable class with multiple copies:

1. derive one-item and two-transform contact cells from real transformed
   collision polygons;
2. reject duplicate or invalid cells;
3. tile each cell only within the finite sheet;
4. convert the selected cells to ordinary placements;
5. continue with the baseline beam for leftovers and other classes;
6. validate and compare the terminal result normally.

Do not fix a copy-count threshold from the triangle fixture. Benchmark copy
concentration, candidate-cell count, and finite-sheet fill benefit on a corpus,
then choose either a bounded always-run branch or a data-supported routing
threshold.

### Priority 2: bounded macro-first decoder

Run a bounded decode that schedules the upper convex-hull-area tier first,
freezes its best legal macro arrangement, then continues with the remaining
pieces. Use area dispersion only to allocate budget; do not change the global
user-owned sort function. Compare its terminal result with the baseline beam.

This branch directly addresses large rectangles placed after many small shapes.
It should be rejected if it regresses the repeated-triangle golden or produces
inferior final envelope metrics; it need not reproduce one exact triangle
permutation.

### Priority 3: transform allocation before cap

Preserve current orthogonal coverage, then test a PackingSolver-style allocation
for the remaining cap:

- exact transformed-geometry deduplication;
- at least one minimum-width and one minimum-height choice when distinct;
- mirror-family coverage when mirroring is enabled;
- derived-angle choices ranked only after those reservations.

The benchmark must show that this adds useful geometric diversity rather than
only increasing candidate count.

### Priority 4: optional stochastic terminal improvement

Consider a Sparrow-like temporary-overlap separator only after the deterministic
constructive branches are stable. Give it an explicit small time share, seed it
deterministically for reproducible tests, and expose only fully legal validated
states to output and history.

## Validation Corpus

Evaluate changes on more than a single separator threshold:

- the approved 20-identical-triangle fixture, accepting any equally compact,
  hole-free lattice orientation;
- repeated rectangles, trapezoids, and convex pentagons at several copy counts;
- mixed 10, 20, 60, and 100-piece jobs with high and low area dispersion;
- mixtures containing one or two dominant rectangles plus many small copies;
- asymmetric shapes with mirroring disabled and enabled;
- sheets whose aspect ratio makes minimum-width and minimum-height transforms
  differ materially.

Record legality, unplaced count, worst normalized sheet consumption, normalized
span sum, bounding area, hull waste, runtime, candidate count, peak memory, and
trace bytes. Render representative terminal SVGs to PNG and inspect them, but
use the measured gates for acceptance.

## What Not to Copy

- Do not replace direct compactness metrics with shared-contact length.
- Do not hardcode the known triangle hexagon or a copy-count-specific score.
- Do not assume PackingSolver's periodic or large-item-first modules are wired
  into its optimizer; they are not at the inspected revision.
- Do not import Sparrow's infeasible intermediate layouts into normal history.
- Do not raise transform, beam, or trace budgets without a measured diversity or
  quality gain.
- Do not silently change the user-owned initial piece ordering. Add and compare
  a separate decoder or survivor family instead.

