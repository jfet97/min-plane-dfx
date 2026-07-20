# V7 Irregular Nesting Search Plan

## Status

This is the active implementation plan for branch `v7-geometric-cohesion`.
It replaces the historical irregular-v2 construction plan. The geometry kernel,
canonical exactness boundary, production beam, and experimental V7 foundation
already exist; the remaining problem is search quality and topology.

The plan is intentionally staged. Complete and measure each stage before
activating its conditional successor. Do not replace this sequence with another
single comparator experiment.

## Objective

Build a deterministic, sheet-independent constructive search that:

- keeps sheet dimensions out of compactness preferences and uses them only for
  legality and final fit;
- produces compact layouts without large rings, arcs, reusable cavities, or
  perimeter chains;
- preserves multiple useful partial futures when their value appears only after
  later placements;
- gives heterogeneous small pieces a bounded opportunity to fill real gaps;
- retains exact canonical legality and reproducibility;
- keeps Triangle-20 compact and substantially improves Mixed-61;
- remains generic: no fixture names, piece counts, saved layouts, or
  fixture-specific thresholds in production search code.

## Current Evidence

### Exactness and search foundation

- Canonical Clipper2 geometry is authoritative at exact admission boundaries.
- SAT is movement guidance and a later tie-break, not final legality.
- The V7 seed/archive experiment has two sheet-free exact seeds and bounded
  endpoint retention.
- F0 candidate provenance found no justification for another generic Dalsoo
  vertex/edge contact generator. The relevant finite NFP/IFP contact families
  already exist; the important question is which states and piece orders retain
  them.

### Reconstruction portfolio

The existing bounded portfolio contains ordinary, reversed,
geometry-derived q0/q90 traversal, and pocket-first reconstructions.

- Mixed `open-pocket-first` is the best measured geometric result:
  `405,773.434 mm2`, maximum side `642.501 mm`, zero enclosed cavities, and
  largest hull-gap ratio `0.200227`.
- The `418,220.374 mm2` endpoint-derived layout has stronger exact contact but
  is visibly and geometrically worse.
- Triangle nominal roles collapse to three distinct decodes because all copies
  are geometrically interchangeable. Reordering identical ids cannot create a
  new triangle layout.

### Geometric-cohesion correction

Commit `a3a7b95` defines three compound archive selectors:

1. compactness: maximum side, envelope area, span;
2. void topology: enclosed cavities, cavity area, largest hull gap, hull waste;
3. exact contact: isolates, contact components, largest component, structural
   contacts, contact units, and shared boundary.

Only compactness and void topology decide Pareto dominance. Contact receives
one bounded selection turn after the two geometric turns. It can preserve a
useful structurally connected alternative, but it cannot veto a layout that is
strictly better on both geometric axes. Diagnostic certificate floors do not
form hard archive partitions.

### Queue-versus-beam discriminator

Commit `7be8d04` adds a trace-only independent replay. It changes no live
candidate, rank, selection, archive, or deadline.

At each synchronized depth it:

1. enumerates every canonical successor for the scheduled piece;
2. tests one representative of every distinct remaining geometry class for a
   non-inert gap-contained successor;
3. retains up to four rejected same-piece geometric-front alternatives;
4. continues those alternatives through one unchanged next placement; and
5. classifies the depth as queue headroom, beam headroom, both, or neither.

Evidence at commit `14868c2`:

- Triangle completes all 20 depths with beam headroom at 15, queue headroom at
  zero, and neither at five. The audit evaluates 16,627 candidates in 11.2 s.
- Mixed reaches the 25,000-evaluation cap after 11 depths: five beam-only, one
  queue-only, three both, and two neither. It finds 14 non-inert gap-contained
  queue candidates, including five that dominate every scheduled-piece
  successor, plus 16 non-dominated beam continuations and two strict beam
  improvements.
- The Mixed audit follows the `canonical-grid` pure-growth lineage. The compact
  harness's other reconstruction roles exceeded their 15-second per-decode
  deadline under that cold concurrent run. Treat the counts as generic
  reachability evidence, not proof about the complete `405k` pocket-first
  lineage.

## What The Completed Proofs Rule Out

### Why exactness had to be fixed before search

Earlier relaxed runs exposed states with effectively zero SAT loss that were
classified differently by the exact canonical geometry. On Mixed, SAT could
report microscopic residual conflicts while canonical Clipper2 proved the
layout legal. Conversely, selecting a raw proposal by SAT before exact admission
could prefer a numerically cleaner but canonically worse move. V7 therefore
separates responsibilities:

- SAT proposes directions and distinguishes otherwise tied relaxed pressure;
- direct convex validation filters live candidates;
- canonical Clipper2 decides protected/archive legality;
- the search controller never converts a tiny floating loss into a fake exact
  placement.

This rules out using relaxed loss as the terminal objective or interpreting
"zero collision-free relaxed states" as proof that no exact legal arrangement
exists.

### Why another contact generator is not the next step

The Dalsoo/Abey investigation compared its finite constructions with the actual
NFP/IFP service. Existing generation already includes NFP vertices,
antiparallel edge-support endpoints, sheet/IFP intersections, and intersections
between pairwise NFP boundaries. F0 then traced candidates from raw source,
through point deduplication, live legality, canonical legality, and selection.

The useful placements are not generally absent at the geometric source. They
are lost because the wrong piece is scheduled or because a locally losing
partial state is discarded. Adding the same points again would raise candidate
volume without changing reachability. A new feature family remains conditional
on one concrete F0 witness proving a direct-legal and canonical-legal point is
actually absent.

### Why contact cannot remain a hard certificate partition

The completed portfolio gives a direct counterexample:

- `open-pocket-first`: `405,773.434 mm2`, maximum side `642.501 mm`, zero
  enclosed cavities, hull-gap ratio `0.200227`, but weaker exact connectivity;
- endpoint-derived contact layout: `418,220.374 mm2`, maximum side
  `650.876 mm`, hull-gap ratio `0.224299`, but stronger exact connectivity.

The first layout is visually and geometrically better. A hard contact partition
selected the second because it treated exact edge connectivity as the meaning
of cohesion. Commit `a3a7b95` corrects the model: spatial cohesion is compact
external geometry plus low void topology; exact contact is useful secondary
structure. This rules out contact-only, isolate-only, and component-only final
selection.

### Why a completed-decode portfolio is insufficient

The reconstruction portfolio proves that order matters: pocket-first finds the
`405k` layout and endpoint-derived orders find different contact topology. But
each decode is still greedy internally. Once it discards a placement at depth
`d`, no completed portfolio comparison can recover that branch.

Triangle is the clean proof. All ids are interchangeable, so different id
orders collapse to the same geometry-class sequence, yet the discriminator
finds useful rejected placement continuations at 15 of 20 depths. Therefore the
missing diversity is inside the partial-state search, not only between whole
piece orders.

### Why dynamic queue alone is insufficient

Triangle has one remaining geometry class at every non-terminal depth. Choosing
a different triangle id cannot change geometry, and the measured queue headroom
is zero. A queue can improve heterogeneous cavity access, but it cannot preserve
alternative placements of the same shape. This rules out replacing the beam
with unrestricted piece reordering.

### Why partial beam alone knowingly leaves Mixed value unused

Within the first 11 Mixed depths, the discriminator finds 14 non-inert
gap-contained candidates from alternate remaining geometry classes. Five
strictly dominate every successor of the scheduled piece. At one depth the
queue has strict headroom while the tested same-piece beam alternatives have
none. A same-piece beam cannot create that successor because it expands the
wrong shape. This is the measured reason to stack the guarded queue with the
beam.

### Why Stage 1 pressure arms are not the final search

The control, static split, balanced atomic-pair, and two-radius refine arms
improved accounting and exposed useful local pressure behavior, but no tested
Triangle or Mixed contraction ratio produced an acceptable new exact endpoint.
Transform-family expansion produced thousands of candidates that collapsed to
zero new canonical states in its measured run. These results retain the exact
admission, accounting, and refinement machinery but rule out simply increasing
single-piece pressure vocabulary. The next search must retain different
futures or coordinate several pieces.

## Frozen Implementation Sequence

## Stage 2A: Bounded Partial Geometric Beam

### Purpose

Stop the greedy decoder from irreversibly discarding a placement whose value
appears several pieces later. This is mandatory for both homogeneous and mixed
jobs.

### Design

- Search partial layouts at synchronized placed-piece depths.
- Preserve the exact width-one pure-growth lineage in one protected slot.
- Deduplicate translated-equivalent states by canonical occupied geometry.
- Use the same two geometric dominance axes as the completed-layout archive:
  compactness and exact void topology.
- Give exact contact one bounded representative after compactness and void
  representatives; do not make it a Pareto veto.
- Start with a small fixed capacity. The first implementation should expose the
  capacity as an experiment setting and test at least width 2 and width 4.
- Keep transform-family coverage before truncation.
- Keep states only at the same construction depth. Never compare a state with
  fewer placed pieces against a deeper state.
- Preserve exact candidate validation and canonical legality. The beam changes
  retention, not geometry authority.

### How the controller should execute

For each synchronized depth:

1. expand every retained parent with the ordinary scheduled piece;
2. evaluate all permitted transform families and canonical legal successors;
3. deduplicate equal occupied geometry across parents without losing the
   protected width-one representative;
4. compute the compactness and void-topology compound comparisons;
5. build the non-dominated geometric frontier;
6. select compactness, void, and bounded contact representatives in deterministic
   round-robin order until capacity is full;
7. carry parent identity and the actual selected placement into the next depth;
8. archive complete legal states under the existing completed-layout policy.

Do not use terminal sheet fit to prune the sheetless partial beam. A requested
sheet may reject the final rigid layout, but it must not alter intrinsic
preferences while the same partial placements remain legal.

### Origin

- Original Kimi/Sol V7 review: bounded partial-state Pareto retention.
- Confirmed by the queue-versus-beam discriminator.
- Related precedent: libnest2d transform-family coverage and the existing
  protected Pareto lane.
- Project adaptation: sheet-free compound geometric axes and canonical identity.

### Required trace additions

Per depth and parent state, record bounded aggregate data:

- generated, scored, canonical-legal, and unique successor counts;
- geometric frontier size;
- selected compactness, void, and contact representative hashes;
- deduplication and capacity evictions by reason;
- protected width-one lineage survival;
- parent/child identity required for deterministic replay;
- cumulative evaluations and runtime.

Do not serialize every candidate geometry.

### Pass, failure, and interpretation

Pass evidence requires at least one new deterministic complete canonical layout
that improves the geometric archive on Triangle or Mixed without losing the
protected control. A lower-quality alternative merely surviving is evidence
that retention works, not that its width is useful.

Failure cases have different meanings:

- no new partial state survives: the geometric frontier/dedup implementation is
  collapsing back to width one;
- new partial states survive but converge to the same final hashes: one-step
  diversity is real but insufficiently deep or the candidate policy reconverges;
- Triangle improves but Mixed does not: add the guarded queue before changing
  beam axes;
- runtime grows superlinearly beyond the configured width: profile repeated NFP,
  topology, and identity work before raising capacity;
- layouts become chains/rings: contact has regained veto power or the void axis
  is not applied at the same pruning boundary.

## Stage 2B: Guarded Dynamic Gap Queue

### Purpose

Allow a heterogeneous remaining piece to use a real cavity or hull-open pocket
before the scheduled piece destroys that opportunity. This complements the
beam; it does not replace it.

### Admission rule

For each retained partial state:

1. keep the ordinary scheduled piece;
2. group remaining pieces by canonical geometry class;
3. inspect one deterministic representative per distinct class;
4. retain a queue proposal only when it has a canonical gap-contained
   placement;
5. require the placement to reduce measured gap area without increasing
   maximum side or envelope area;
6. require it to be non-dominated on compactness and void topology;
7. admit only a small bounded number of queue successors per parent.

The initial queue cap should be one protected queue successor per parent. Raise
it only after traces prove additional distinct classes provide value.

Identical-piece jobs naturally disable the mechanism because there is no
different remaining geometry class.

### How a queue proposal is evaluated

The queue does not globally sort all remaining pieces. It constructs one
temporary representative per geometry class, enumerates its already-supported
NFP/IFP candidates, and checks containment against exact layout-created gap
regions. A proposal is non-inert only when it consumes real gap area without
growing the occupied envelope. It then competes through the same geometric
frontier as ordinary successors and receives no private terminal winner.

After selecting a queue piece, preserve the relative order of all other
remaining pieces. Record the deferral so starvation can be bounded. A later
production form should reuse the existing reorder-window debt model or an
equivalent explicit bypass limit; it must not silently become free permutation.

### Origin

- Abeysooriya: test hole placement before ordinary boundary placement.
- PackingSolver: large-piece skeleton followed by small/filler handling.
- Dalsoo/F0: candidate contact families already exist, so change scheduling and
  retention rather than duplicate geometry generation.
- Project adaptation: exact gap regions, geometry-class deduplication, and
  bounded sheet-free admission.

### Pass, failure, and interpretation

- Pass: at least one queue successor survives to a distinct complete canonical
  endpoint that improves compactness or void topology without regressing the
  protected control.
- Generated but never retained: the queue opportunity exists, but partial-state
  frontier capacity or ordering is still wrong.
- Retained but reconverged: the scheduled order later destroys the benefit;
  record deferral history and consider the stagnation kick only after beam depth
  is verified.
- No opportunities on heterogeneous fixtures: re-check gap-region containment
  and the non-inert definition; do not add new contact points without F0 evidence.
- Runtime dominated by scanning equivalent copies: geometry-class deduplication
  is incorrect or occurs too late.

## Stage 2C: One Controller, Three Ablations

Implement Stage 2A and Stage 2B in one controller with three modes:

1. partial beam only;
2. dynamic queue only;
3. partial beam plus dynamic queue.

All modes must use identical:

- candidate generation;
- transform catalog;
- canonical legality;
- geometric/contact archive semantics;
- runtime and evaluation accounting;
- terminal orientation and final-sheet validation.

This is one controlled experiment, not three unrelated branches.

The ablations are necessary because a better combined result does not identify
which mechanism earned it. Beam-only measures delayed placement value;
queue-only measures piece-scheduling value; combined measures their interaction.
The discriminator already observed three Mixed depths with both forms of
headroom, so a combined mode is justified, but the final complete-layout gain
must still be attributed before promotion or optimization.

### Initial run matrix

- Triangle-20 on its golden sheet;
- Mixed-61 on the current reference sheet;
- Mixed-61 on the four historical sheet dimensions;
- the existing heterogeneous and homogeneous corpus after the two primary
  fixtures are understood.

Run beam widths 2 and 4. Keep the queue cap at one. Do not expand the matrix
until one mode produces new useful canonical endpoints.

### Measurements

- canonical geometry hash and deterministic replay;
- placed/unplaced count and exact legality;
- maximum side, envelope area, and span;
- enclosed cavity count and area;
- largest hull-gap ratio and occupied hull waste;
- isolates, contact components, largest contact component, total/dominant
  structural contacts, contact units, and shared boundary;
- per-depth frontier/queue admissions and eviction reasons;
- evaluations, runtime, cache hits, and peak retained states;
- readable SVG and PNG renders.

### Decision

- Promote combined beam + queue when it improves mixed layouts and preserves or
  improves homogeneous layouts within the accepted runtime budget.
- Retain beam-only if the queue adds no selected endpoint or only duplicates.
- Retain queue-only only as an ablation; current Triangle evidence excludes it
  as the general solution.
- Do not move to a new comparator experiment if Stage 2 fails. Diagnose whether
  the surviving limitation is delayed reachability or inability to rearrange
  already placed topology.

The Stage 2 matrix is complete only after renders and trace summaries agree.
An area improvement with a visible ring, an isolate reduction with a larger
envelope, or an attractive PNG whose canonical replay differs is not a win.

## Conditional Stage 3: Deterministic Stagnation Kick

Implement only if Stage 2 reaches a stable archive without acceptable quality.

### Design

- Detect stagnation through a fixed number of completed depths or reconstruction
  rounds without a new canonical geometric-front endpoint.
- Apply one deterministic insertion, reversal, or geometry-derived order rebuild.
- Continue through the same Stage 2 beam, queue, legality, and archive.
- Bound the number of kicks and account for their evaluations separately.
- Do not introduce random mutation or an unbounded GA loop.

### Origin

- Abeysooriya/Jostle reconstruction and bounded kick.
- Deepnest/SVGnest order mutation as an outer-search dimension.
- Kimi/Sol sequencing: only after the retained constructive search is measured.

### Evidence required before implementation

Implement the kick only when Stage 2 traces show all of the following:

- useful partial alternatives survive for multiple depths;
- the archive stops receiving new geometry despite remaining evaluation budget;
- different fixed reconstruction orders previously reached distinct endpoints;
- the failure is not dominated by missing candidate coverage or queue admission.

The kick is falsified if it produces only orders already represented by the
current geometry-class keys, or if every kicked decode reconverges before any
new partial frontier state appears.

## Conditional Stage 4: Hull-Guided Proposal Steering

Implement only when traces show that Stage 2 generates too many equivalent or
obviously expansive proposals.

- Use absolute convex-hull growth as a cheap proposal or seed-order signal.
- Keep maximum-side/envelope and exact void topology as archive authority.
- Never select a terminal layout through hull area alone.

Origin: Dalalah/Dalsoo convex-hull compactness and Deepnest/SVGnest absolute
envelope/hull objectives. The restriction is project-specific: hull-only
scoring cannot distinguish a solid cluster from a hollow ring.

The evidence for using hull only as steering is the `405k` versus `418k`
comparison and earlier contact-rich ring failures: external hull pressure is
correlated with compactness but cannot describe internal cavities or future
filler access. Accept this stage only if it reduces proposal/evaluation volume
while preserving the exact candidate set or improves endpoints under the same
budget. Reject it if it changes terminal authority or recreates axis/sheet bias.

## Conditional Stage 5: Coordinated Multi-Piece Transport

Implement when Stage 2 plus one bounded kick still cannot rebuild bad topology.
This is the first stage allowed to rearrange an already-formed ring globally.

### Design boundary

- Start from an exact legal seed or retained endpoint.
- Maintain a separately bounded temporarily infeasible pool.
- Apply container contraction, conflict-component separation, deterministic
  disruption, and coordinate descent.
- Permit coordinated translation of a small component or multiple pieces.
- Reuse the retained exactness foundations: SAT proposes directions, canonical
  Clipper2 pressure orders infeasible states, and only exact legal endpoints
  enter the archive.
- Preserve the best exact legal incumbent throughout.
- Use explicit evaluation and wall-clock limits. A quality-mode budget of up to
  four or five minutes is acceptable, but the first implementation must expose
  where that time is spent.

### Origin

- Sparrow: legal construction followed by strip contraction, separation,
  disruption, exploration, and coordinate descent.
- Original Kimi/Sol disruptive V7 direction.
- Existing V7 split/atomic/refine infrastructure supplies accounting and exact
  admission pieces, but not the complete coordinated search.

### Why this is later rather than immediate

Coordinated movement is more expensive and introduces a temporarily infeasible
state space. The current discriminator proves that cheaper legal partial-state
retention already has substantial headroom, so that mechanism must be exhausted
first. However, beam and queue only choose future construction decisions; they
cannot move a bad ring after all of its pieces have been placed. If Stage 2
retains diverse branches yet every branch closes into poor topology, the failure
has crossed from reachability into rearrangement and Stage 5 becomes necessary.

### Pass, failure, and interpretation

- Pass: a coordinated trajectory reaches a new exact legal endpoint that the
  legal constructive beam did not reach and improves the common geometric
  archive.
- Lower SAT loss without an exact endpoint is not a pass.
- A legal endpoint worse than the protected constructive incumbent is useful
  trace evidence but not a selected result.
- Repeated movement of one offender while the conflict component is unchanged
  means the implementation is still single-piece refinement, not coordinated
  transport.
- Runtime near the allowed multi-minute ceiling must be explained by counters;
  opaque wall-clock exhaustion is a profiling failure.

## Deferred Mechanisms

### Join and release

Abeysooriya's Jostle method may temporarily join adjacent pieces and release
them after a kick. Do not implement this until traces identify a connected
component that is already compact and non-cyclic under the common topology
metrics. Joining the current contact-rich ring could freeze the failure.

Evidence required to revisit it: a canonical component with low internal hull
waste, no enclosed cycle, stable rigid identity, and a trace showing that moving
its members independently destroys a useful relation. Without all four, keep it
deferred.

### Optional bounded GA

The existing GA may later explore priority order and transform preferences
around the corrected deterministic decoder. It is not an immediate fix: GA
cannot restore candidates or partial states that the decoder always prunes.

Evidence required to revisit it: Stage 2 must be capable of preserving useful
geometry, while deterministic stagnation traces show that the remaining limit
is order/transform diversity. The baseline chromosome must remain in every
population and the common exact archive must reject worse offspring.

### Additional feature-contact generator

Do not add one without an exact F0 witness proving a direct-legal and
canonical-legal finite contact point is absent. Current evidence says the
relevant Dalsoo finite families are already generated.

## Non-Negotiable Gates

### Geometry and determinism

- Canonical Clipper2 legality at protection/archive boundaries.
- No missing or duplicated pieces.
- Deterministic canonical hashes under identical inputs and budgets.
- Sheet dimensions affect legality and final fit, not intrinsic ranking.
- No fixture-specific production branches.

### Triangle-20

- Preserve or improve the approved compact repeated-triangle behavior.
- Avoid visible triangle-sized holes, chains, and disconnected fans.
- Treat the golden as a production gate, not as permission to hard-code a
  triangle pattern.

### Mixed-61

- Beat the current search qualitatively and quantitatively.
- The immediate geometric reference is the `405,773.434 mm2` zero-cavity
  pocket-first layout, not the more contact-heavy `418k` layout.
- Prefer lower maximum side, area, cavities, hull gap, and hull waste.
- Use contact as bounded structural evidence, never as permission to form a
  larger ring.

### Runtime

- Report total and per-mechanism evaluations and runtime.
- Keep ordinary construction bounded and deterministic.
- Reserve multi-minute budgets for an explicit quality mode or later
  coordinated search, not for hidden default work.

## Implementation Discipline

- Work on the durable `v7-geometric-cohesion` branch/worktree, never a temporary
  worktree under `/private/tmp`.
- Keep immutable experiment outputs under `/private/tmp/min-plane-provenance/`
  as required by repository provenance rules.
- Commit every implementation before generating evidence from it.
- Run `pnpm lint:fix`, `pnpm typecheck`, and focused tests after each code cycle.
- Render and inspect Triangle and Mixed PNGs after each meaningful search change.
- Update `help/help.md`, the V7 research report, architecture documentation, and
  branch-local knowledge before beginning a materially different experiment.
- Keep rejected mechanisms and their evidence documented; reject the specific
  implementation, not an underlying idea that has not been falsified.

## Source Map And Transfer Boundaries

The plan is based on source-level inspection, not screenshots or project claims.
External projects are algorithm references only; `min-plane-dfx` retains its
own canonical geometry, deterministic state identity, schemas, and Effect
boundaries.

### Primary open-source repositories

| Project | Inspected revision | Mechanism used by this plan | What is not copied |
| --- | --- | --- | --- |
| [Deepnest](https://github.com/Jack000/Deepnest/tree/2fb10513a30681971dcc991c528fa0738a2c0c76) | `2fb10513a30681971dcc991c528fa0738a2c0c76` | Deterministic NFP decoder separated from outer order/rotation search; absolute envelope or hull pressure; bounded contact bonus | Its exact `2 * width + height` axis bias, browser-worker architecture, and GA as an immediate repair |
| [SVGnest](https://github.com/Jack000/SVGnest/tree/1248dc21efd3f90d1aa52ba5785e27e5217ed2c9) | `1248dc21efd3f90d1aa52ba5785e27e5217ed2c9` | Clear evidence that GA changes the sequence seen by a deterministic decoder rather than repairing geometry itself | Unbounded dependence on GA and its fixed gravity axis |
| [libnest2d](https://github.com/tamasmeszaros/libnest2d/tree/663daa69e1d7478669f714218e27681edbc96640) | `663daa69e1d7478669f714218e27681edbc96640` | Search every retained orientation family before truncation; configurable objective; bounded singles/pairs/triplets as evidence for small grouped search | Its center-distance default objective and library-specific placer interface |
| [PackingSolver](https://github.com/fontanf/packingsolver/tree/3d8d97dd8ae5ac46f08328636f5e168283282ebc) | `3d8d97dd8ae5ac46f08328636f5e168283282ebc` | Bounded algorithm portfolio, explicit budgets, deterministic replay of variants, large-item-first then small-fill decomposition, periodic seeds for repeated types | Its complete solver portfolio, MILP/trapezoid representation, and any assumption that standalone periodic modules are active in its main optimizer |
| [Sparrow](https://github.com/JeroenGar/sparrow/tree/961ec31f576c5817ece779ff73982b4553760a4e) | `961ec31f576c5817ece779ff73982b4553760a4e` | The conditional global stage: legal construction followed by contraction, temporary-overlap separation, disruption, exploration, and coordinate descent under explicit phase limits | Its overlap kernel and strip-specific objective as legality or terminal semantics |
| [Dalsoo-Bin-Packing](https://github.com/whitegreen/Dalsoo-Bin-Packing/tree/bde2a3ef09f48980e59328eae7b042e6d9fdd4bc) | `bde2a3ef09f48980e59328eae7b042e6d9fdd4bc` | Finite vertex/edge-derived contact construction, largest-first ordering, convex-hull proposal pressure, and the need to test feature coverage | Its asymmetric floating collision test, origin/axis-skewed scalar, greedy no-backtracking decoder, free rotations, and multi-bin semantics |

### Primary papers behind the Java repository

#### Abeysooriya, Bennell, and Martínez-Sykora (2018)

*Jostle heuristics for the 2D-irregular shapes bin packing problems with free
rotation*:
[DOI 10.1016/j.ijpe.2017.09.014](https://doi.org/10.1016/j.ijpe.2017.09.014),
[accepted manuscript](https://eprints.whiterose.ac.uk/134688/1/Accepted_article_IJPE.pdf).

Verified from the complete accepted manuscript, particularly the constructive,
hole-placement, reconstruction, kick, and join/release sections. It contributes:

- hole-first placement before ordinary boundary placement;
- deterministic reconstruction orders derived from an existing layout;
- order insertion/reversal after stagnation;
- bounded disruption as an outer search responsibility;
- conditional join-and-release of adjacent parts.

Transfer into this plan:

- hole-first became `open-pocket-first` and the guarded dynamic gap queue;
- reconstruction became the reversed/q0/q90 bounded portfolio;
- the kick is Conditional Stage 3;
- join/release remains deferred until component topology proves it safe.

Not transferred:

- arbitrary free rotations, random/unbounded kicks, multi-bin swapping, and
  direct reuse of its scalar objective;
- joining a contact-rich ring, which would preserve the failure instead of
  breaking it.

#### Dalalah, Khrais, and Bataineh (2014)

*Waste minimization in irregular stock cutting*:
[DOI 10.1016/j.jmsy.2013.11.003](https://doi.org/10.1016/j.jmsy.2013.11.003),
[publisher record](https://www.sciencedirect.com/science/article/abs/pii/S0278612513001209).

The publisher abstract and visible method summaries were inspected; the full
primary PDF was not openly retrievable during the research pass. Claims from
this source are therefore intentionally narrower than the Abeysooriya evidence.
It supports evaluating discrete rotations, vertex-contact constructions, and
convex-hull waste as compactness guidance. In this plan those ideas inform
transform-family coverage and Conditional Stage 4 proposal steering. They do
not establish exact collision semantics, cavity topology, or a complete Jostle
search.

### How Sparrow changes the architecture if Stage 5 is reached

Sparrow is not another local comparator. Its important contribution is the
separation between:

```text
legal constructive start
  -> shrink the target container
  -> tolerate bounded temporary overlap
  -> separate conflicts
  -> disrupt a stagnating arrangement
  -> coordinate-descent refinement
  -> accept only a feasible improved layout
```

The current beam, queue, and reconstruction portfolio operate on legal
constructive states. They can prevent bad topology but cannot necessarily move
an already-completed ring as a unit. Stage 5 adopts Sparrow's phase separation
only after legal search is exhausted. The project-specific version keeps SAT as
directional guidance, uses the canonical pressure tuple for infeasible states,
and admits only Clipper2-legal endpoints to the common archive.

### Local research documents

- [`help/research/open-source-nesting-strategies.md`](help/research/open-source-nesting-strategies.md): pinned Deepnest, SVGnest, libnest2d, PackingSolver, and Sparrow control pass, plus the Dalsoo addition.
- [`docs/research/open-source-irregular-nesting-strategies.md`](docs/research/open-source-irregular-nesting-strategies.md): deeper libnest2d, PackingSolver, and Sparrow source comparison.
- [`help/research/dalsoo-abey-dalalah-transfer-study.md`](help/research/dalsoo-abey-dalalah-transfer-study.md): Java source audit, paper retrieval record, F0/F1 boundary, and Jostle transfer decision.
- [`help/research/pre-v7-exactness-retained-foundations.md`](help/research/pre-v7-exactness-retained-foundations.md): SAT/Clipper2 authority split and retained A-H machinery.
- [`help/research/v7-seed-archive-stage0-stage1.md`](help/research/v7-seed-archive-stage0-stage1.md): V7 Stage 0/1, reconstruction results, geometric-cohesion correction, and queue/beam evidence.
- [`help/help.md`](help/help.md): experiment ledger, accepted/rejected hypotheses, gates, and artifact provenance.

## Current Artifact Paths

- Triangle selected PNG:
  `/private/tmp/min-plane-provenance/v7-geometric-cohesion-a3a7b95/triangle/triangle-20-geometric-cohesion-selected.png`
- Mixed selected PNG:
  `/private/tmp/min-plane-provenance/v7-geometric-cohesion-a3a7b95/mixed/mixed-61-geometric-cohesion-selected.png`
- Queue/beam evidence:
  `/private/tmp/min-plane-provenance/v7-queue-beam-14868c2/`

## Immediate Next Action

Implement Stage 2A and Stage 2B in the same controller, expose the three
ablation modes, and run the width-2/width-4 Triangle and Mixed matrix. Do not
start the stagnation kick or Sparrow-style coordinated movement before that
matrix has been analyzed.
