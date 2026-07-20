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

These counts are discovery evidence, not yet a live-search design proof. The
same-piece beam continuation looks only one placement ahead. More importantly,
the queue comparison occurs at equal placement counts but not equal placed
material: a queue branch can place a much smaller geometry class than the
scheduled branch and therefore appear intrinsically smaller for the wrong
reason. Queue value must be re-measured after both orderings have placed the
same geometry-class multiset. Beam capacity and survival horizon must likewise
be calibrated against a known delayed-value lineage before widths are chosen.

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

### Why alternate-class scheduling alone is insufficient

Triangle has one remaining geometry class at every non-terminal depth. Choosing
a different triangle id cannot change geometry, and the measured queue headroom
is zero. A queue can improve heterogeneous cavity access, but it cannot preserve
alternative placements of the same shape. This rules out replacing the beam
with unrestricted piece reordering.

### Why the current trace keeps alternate-class scheduling under investigation

Within the first 11 Mixed depths, the discriminator finds 14 non-inert
gap-contained candidates from alternate remaining geometry classes. Five
strictly dominate every successor of the scheduled piece. At one depth the
queue has strict headroom while the tested same-piece beam alternatives have
none. A same-piece beam cannot create that exact successor because it expands
the scheduled shape.

That observation does not yet prove queue superiority. The compared successors
may contain different piece areas and different remaining workloads, so their
partial compactness and void metrics are not commensurate. It proves only that
the scheduled class can miss a real gap opportunity. The next measurement must
compare the two orders after both have placed the same pair of geometry classes,
or compare complete endpoints. Only that result may justify a live alternate-
class scheduling branch.

### Why Stage 1 pressure arms are not the final search

The control, static split, balanced atomic-pair, and two-radius refine arms
improved accounting and exposed useful local pressure behavior, but no tested
Triangle or Mixed contraction ratio produced an acceptable new exact endpoint.
Transform-family expansion produced thousands of candidates that collapsed to
zero new canonical states in its measured run. These results retain the exact
admission, accounting, and refinement machinery but rule out simply increasing
single-piece pressure vocabulary. The next search must retain different
futures or coordinate several pieces.

## Evidence Hardening Before Live Stage 2

The current discriminator is intentionally cheap and one-step. It selected the
mechanisms worth measuring, but it did not establish their production retention
rules. Two trace-only calibrations are mandatory before live Stage 2 selection:

1. **Delayed-lineage calibration.** Replay the known compact Triangle lineage
   through the proposed partial-state identity and ranking. At each depth record
   its rank, objective basin, first eviction width, and the number of later
   placements required before it becomes better than the locally preferred
   branch. Continue rejected alternatives for that measured horizon or to a
   complete endpoint. Test total retained capacities 1, 2, 4, 8, and 13
   (`experimentalWidth` 0, 1, 3, 7, and 12), then only the next capacity needed
   to bracket survival. This is a calibration witness, not a production triangle
   special case.
2. **Commensurate queue calibration.** When an alternate geometry class has a
   gap-contained placement, compare `scheduled -> alternate` with `alternate ->
   scheduled`. Admit the comparison only after both branches have placed the
   same geometry-class multiset and carry the same remaining workload. Record
   complete endpoints where the two-step branches survive. Do not call an
   alternate-class successor better merely because it placed a smaller piece.

These probes change no live winner. Their purpose is to determine a sufficient
beam-capacity range, a useful continuation horizon, and whether alternate-class
scheduling has any fair headroom. If the commensurate queue probe finds none,
Stage 2B remains an ablation only and cannot be promoted by the old one-step
counts.

## Frozen Implementation Sequence

## Stage 2A: Bounded Partial Geometric Beam

### Purpose

Stop the greedy decoder from irreversibly discarding a placement whose value
appears several pieces later. This is mandatory for both homogeneous and mixed
jobs.

### Design

- Search partial layouts at synchronized placed-piece depths.
- Preserve the exact width-one pure-growth lineage in one protected slot.
- Use a versioned future-equivalence key containing canonical occupied geometry,
  the ordered remaining interchangeability signatures, the unplaced set, and
  any reorder/deferral debt. Occupied geometry alone is not a sufficient key.
- Keep protection role and parent/child lineage as retention metadata. On a
  future-equivalence collision choose a deterministic representative without
  erasing the protected control identity.
- Rank through the same two geometric axes as the completed-layout archive:
  compactness and exact void topology. Do not treat current partial-state
  dominance as a proof that a future is useless.
- Give exact contact one bounded representative after compactness and void
  representatives; do not make it a Pareto veto.
- Keep the protected pure-growth control outside experimental capacity. Define
  `experimentalWidth` as the number of additional retained states; total live
  states are therefore at most `1 + experimentalWidth`.
- Replace undefined “novelty” with deterministic frontier-layer retention. After
  non-dominated sorting, reserve `ceil(experimentalWidth / 2)` slots for one
  representative from each successive dominated layer `L1`, `L2`, ... . Within
  a layer choose lexicographically by maximum side, envelope area, span, cavity
  count/area, hull gap/waste, the bounded contact tuple, then the future-
  equivalence key. Fill the remaining slots from `L0` through compactness, void,
  and contact round-robin. If fewer dominated layers exist, return their unused
  slots to `L0`.
- Expose `experimentalWidth` as an experiment setting. Begin with 0, 1, 2, and
  4, then escalate through 8 and the calibrated survival boundary instead of
  assuming that four experimental states are sufficient.
- Keep transform-family coverage before truncation.
- Keep states only at the same construction depth. Never compare a state with
  fewer placed pieces against a deeper state.
- Preserve exact candidate validation and canonical legality. The beam changes
  retention, not geometry authority.
- Apply one monotone fit-feasibility gate: reject a state only when neither its
  current q0 nor q90 occupied bounds can fit the requested sheet. Additive
  placement cannot shrink either bound, so no descendant can recover. Do not
  use the amount of sheet consumption in ranking.

### How the controller should execute

For each synchronized depth:

1. expand every retained parent with the ordinary scheduled piece;
2. evaluate all permitted transform families and canonical legal successors;
3. deduplicate only future-equivalent states, using the versioned key and
   deterministic protection precedence;
4. compute the compactness and void-topology compound comparisons;
5. assign every unique state a deterministic geometric frontier layer rather
   than deleting currently dominated layers;
6. retain the protected control outside capacity, allocate the explicit later-
   layer slots, then fill remaining experimental slots from `L0` through the
   compactness/void/contact round-robin;
7. carry parent identity and the actual selected placement into the next depth;
8. archive complete legal states under the existing completed-layout policy.

Sheet dimensions participate only in candidate legality and the monotone
q0/q90 fit-feasibility gate. They never enter compactness ranking. This preserves
sheet-independent preference whenever the same partial placements remain legal,
without allowing an impossible partial state to evict every fit-capable future.

### Origin

- Original Kimi/Sol V7 review: bounded partial-state Pareto retention.
- Selected for deeper testing by the queue-versus-beam discriminator; the
  delayed-lineage calibration determines its actual horizon and capacity.
- Related precedent: libnest2d transform-family coverage and the existing
  protected Pareto lane.
- Project adaptation: sheet-free compound geometric axes and canonical identity.

### Required trace additions

Per depth and parent state, record bounded aggregate data:

- generated, scored, canonical-legal, and unique successor counts;
- geometric frontier size;
- selected compactness, void, and contact representative hashes;
- frontier layer, later-layer slot and objective selection, deduplication,
  monotone-fit rejection, and capacity eviction counts by reason;
- protected width-one lineage survival;
- future-equivalence key version, remaining-order digest, and reorder debt;
- parent/child identity required for deterministic replay;
- cumulative evaluations and runtime.

Do not serialize every candidate geometry.

### Pass, failure, and interpretation

Pass evidence requires at least one new deterministic complete canonical layout
that improves the geometric archive on Triangle or Mixed without losing the
protected control. A lower-quality alternative merely surviving is evidence
that retention works, not that its width is useful.

Failure cases have different meanings:

- no new partial state survives: identity, selection, or capacity is collapsing
  back to width one;
- new partial states survive but converge to the same final hashes: one-step
  diversity is real but the measured horizon, capacity, or candidate policy is
  insufficient; use forced-witness survival before assigning the cause;
- the known delayed lineage dies below its calibrated boundary: implementation
  or ranking is wrong; survival only above it means capacity is the limiting
  resource;
- Triangle improves but Mixed does not: run the commensurate queue ablation
  before changing beam axes;
- runtime grows superlinearly beyond the configured width: profile repeated NFP,
  topology, and identity work before raising capacity;
- layouts become chains/rings: contact has regained veto power or the void axis
  is not applied at the same pruning boundary.

## Stage 2B: Guarded Commensurate Gap Reordering

### Purpose

Test whether a heterogeneous remaining piece should use a real cavity or hull-
open pocket before the scheduled piece destroys that opportunity. The first
live form is a bounded two-piece order swap, not a free asynchronous queue. Both
orders rejoin only after placing the same geometry-class multiset, so their
partial-state metrics describe comparable work.

### Admission rule

For each retained partial state:

1. keep the ordinary scheduled piece;
2. group remaining pieces by canonical geometry class;
3. inspect one deterministic representative per distinct class;
4. rank qualifying class/candidate pairs by: larger exact gap-area reduction,
   no maximum-side growth, smaller maximum-side growth, no envelope-area growth,
   smaller envelope-area growth, better void tuple, class signature, then
   canonical candidate key; select only the first alternate class;
5. construct both bounded two-step orders: `scheduled -> alternate` and
   `alternate -> scheduled`;
6. admit either result to common retention only when both pieces were placed and
   both results therefore have the same remaining geometry-class workload;
7. rank the commensurate results through the Stage 2A selector. Gap reduction
   and no-envelope-growth are preferred proposal tiers, not future-dominance
   proofs or hard deletion rules.

The initial proposal cap is one alternate class per parent. Retained-state
capacity remains one global beam capacity across all parents; no queue result is
privately guaranteed a slot. A separate global queue representative may be
added only if traces show useful commensurate results are generated and always
evicted.

Hard fanout limits apply symmetrically before the second placement:

- retain at most two canonical scheduled-first states for `scheduled ->
  alternate` and at most two canonical alternate-first states for `alternate ->
  scheduled`;
- from each retained first-step state, retain at most two canonical second-step
  placements;
- therefore emit at most four completed successors for each order, eight total
  commensurate macro successors per parent.

Apply the same deterministic geometric ordering inside each cap. These limits
bound the initial 2,331-candidate Mixed opportunity before it becomes a
quadratic two-step expansion. Raising a cap requires trace evidence that a
useful commensurate witness was evicted specifically by that cap.

Identical-piece jobs naturally disable the mechanism because there is no
different remaining geometry class.

### How a reordering proposal is evaluated

The controller does not globally sort all remaining pieces. It constructs one
temporary representative per geometry class, enumerates its already-supported
NFP/IFP candidates, and checks containment against exact layout-created gap
regions. A proposal is relevant when it consumes real gap area. No-envelope-
growth candidates are evaluated first, but a bounded growing proposal may
survive because current envelope dominance is not future-monotone.

The scheduled piece must be placed immediately second in the alternate-first
branch. This makes the initial bypass limit exactly one and prevents starvation
by construction. Preserve the relative order of every other remaining class.
During the intermediate step, include the pending scheduled-class signature and
debt `1` in the future-equivalence key. After the second placement, debt resets
and the future-equivalence key contains only the resulting occupancy, remaining
order, and unplaced set. The past order role and formerly deferred class remain
trace metadata, not semantic identity. Any later experiment allowing chained
deferrals must reuse the existing deterministic reorder-window debt model from
its first run; it must never become free permutation.

### Origin

- Abeysooriya supports making exact layout-created cavities visible before
  ordinary boundary placement of the currently scheduled piece.
- PackingSolver supports bounded/static large-first then small-fill
  decomposition.
- Dalsoo/F0: candidate contact families already exist, so change scheduling and
  retention rather than duplicate geometry generation.
- **Project hypothesis:** alternate-class scheduling, the commensurate two-order
  barrier, gap-containment priority, capacity, and bypass semantics. The cited
  sources do not validate this dynamic rule.

### Pass, failure, and interpretation

- Pass: `alternate -> scheduled` reaches a distinct complete canonical endpoint
  that improves the common geometric archive over both the protected control
  and its commensurate `scheduled -> alternate` comparison.
- No two-step commensurate survivor: the earlier queue-headroom count was a
  workload artifact or the scheduled piece cannot safely be deferred; do not
  enable the live queue.
- Generated but never retained: measure global capacity and selector eviction;
  do not infer that the gap rule itself failed.
- Retained but reconverged: the order swap has no complete-endpoint value under
  the tested horizon; do not jump directly to the stagnation kick until the beam
  witness and budgets are verified.
- No opportunities on heterogeneous fixtures: re-check gap-region containment
  and the non-inert definition; do not add new contact points without F0 evidence.
- Runtime dominated by scanning equivalent copies: geometry-class deduplication
  is incorrect or occurs too late.

## Stage 2C: One Controller, Factorial Ablations

Implement Stage 2A and Stage 2B in one controller. Express the experiment as
two independent settings rather than three ambiguous named modes:

1. experimental width outside the protected control: `0`, `1`, `2`, `4`, `8`,
   and the delayed-lineage calibrated boundary;
2. commensurate gap-reordering cap: `0` or `1` alternate class per parent.

`experimentalWidth = 0`, cap `0` is the exact protected-control cell. A cap of
`1` is meaningful only when experimental width is positive. At any fixed
positive width, cap `0` versus cap `1` measures the reordering main effect;
increasing width at cap `0` measures the partial-retention main effect. The
protected control remains available outside both cells and does not consume an
experimental slot.

All modes must use identical:

- candidate generation;
- transform catalog;
- canonical legality;
- geometric/contact archive semantics;
- runtime and evaluation accounting;
- terminal orientation and final-sheet validation.

This is one controlled experiment, not three unrelated branches.

The factorial ablations are necessary because a better combined result does not
identify which mechanism earned it. Width measures delayed placement value;
the cap measures commensurate order-swap value; their combination measures the
interaction. The old discriminator observed both forms of apparent headroom,
but only the commensurate probe and complete endpoints may attribute a gain.

### Initial run matrix

- Triangle-20 on its golden sheet;
- Mixed-61 on the current reference sheet;
- Mixed-61 on the four historical sheet dimensions;
- the existing heterogeneous and homogeneous corpus after the two primary
  fixtures are understood.

Run the full width-by-cap factorial on Triangle and Mixed, stopping width
escalation only after the forced delayed-lineage witness survives or the
calibrated failure boundary is bracketed. Then carry only non-duplicate useful
settings to the four-sheet and corpus gates. Every run uses identical repair
settings. Compare against both the V7 width-1 controller and the actual Triangle
production golden, which uses its protected production settings.

For every forced witness, record whether the required candidate was generated,
future-equivalent deduplicated, fit-rejected, selected, capacity-evicted, or
survived for the calibrated horizon. A final hash alone cannot distinguish
candidate, scoring, capacity, horizon, budget, or rearrangement failure.

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

### Deterministic budget and stopping contract

- One successor evaluation is one direct-legal successor submitted to canonical
  identity plus compactness/topology scoring. Count it even when metric caches
  hit, so cache warmth cannot change the stopping point. Record raw generated,
  direct-legal, canonical-check, unique-successor, and metric-cache-miss counts
  separately.
- Use a stable traversal order: parent future-equivalence key, ordinary before
  reordered role, geometry-class signature, transform index, then canonical
  candidate key.
- Caches are run-local. Start each factorial cell cold and use the same cache
  ownership and candidate memoization rules.
- Before freezing matrix budgets, run a cold 25,000-evaluation pilot on the
  slowest primary fixture for the control, one positive-width beam cell, and one
  positive-width reordering cell. Record depth reached, evaluations per depth,
  median/p95 time per evaluation, topology/cache time, and projected evaluations
  and wall time to completion. This pilot is diagnostic and cannot select a
  layout.
- Freeze the resulting caps in the immutable experiment manifest before the
  factorial run. Do not adapt them from live elapsed time. Use the same frozen
  cap for every compared cell in a budget tier.
- The ordinary tier may use at most 100,000 successor evaluations with a
  90-second safety abort. The quality tier may use at most 400,000 evaluations
  with a 300-second safety abort. Both are search-wide caps, include intermediate
  and completed steps of reordering macros, and deliberately leave margin from
  the measured baseline rate of 25,000 evaluations in 13.3 seconds.
- If the cold pilot projects that a frozen cap will exceed 80% of its wall-time
  ceiling, lower the cap before the matrix. If the lowered cap cannot complete
  the fixture at the tested width, stop and profile/cache the dominant work;
  do not run a matrix designed to truncate every cell.
- Wall time is a safety abort, not a quality selector. A wall-time- or
  evaluation-cap-truncated run is diagnostic-only and ineligible to win or
  establish deterministic quality. Its protected control incumbent remains
  available but is not reported as a completed Stage 2 comparison.
- Evaluation-budget completion is authoritative for deterministic comparison.
  Record the wall-clock time and where it was spent, but never allow machine load
  to silently choose a different archive winner.
- Only a setting that completes the ordinary tier and all ordinary corpus gates
  is eligible for production-default promotion. A setting that completes only
  the 300-second tier remains an explicit quality mode, even when its layout is
  better.

### Decision

- Promote a combined width/cap setting only when it improves mixed layouts and
  preserves or improves homogeneous layouts within a completed deterministic
  budget.
- Set the reordering cap to zero if commensurate reordering adds no selected
  endpoint or only duplicates.
- Treat experimental-width-1/cap-1 only as the smallest scheduling ablation;
  current Triangle evidence excludes reordering without broader partial-state
  retention as the general solution.
- Do not assign a failed endpoint to rearrangement until witness traces have
  excluded candidate omission, unsafe pruning, insufficient capacity, too-short
  horizon, reorder debt, and budget truncation.
- If useful alternatives survive the calibrated horizon but all completed legal
  endpoints retain bad topology, the remaining limitation is coordinated
  rearrangement and Conditional Stage 5 becomes justified.

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
state space. The current discriminator identifies cheaper legal partial-state
retention as a credible hypothesis; the delayed-lineage and commensurate-order
calibrations must establish its real headroom before it is exhausted first.
However, beam and bounded reordering only choose future construction decisions; they
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

- hole-first directly informed `open-pocket-first` and exact cavity visibility;
- alternate-class commensurate reordering remains a project hypothesis rather
  than a mechanism claimed from the paper;
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

Run the delayed-lineage and commensurate-order trace calibrations first. Then
implement Stage 2A and the evidence-supported portion of Stage 2B in the same
controller, expose the width-by-reordering-cap factorial settings, and run the
Triangle/Mixed matrix under the deterministic budget contract. Do not start the
stagnation kick or Sparrow-style coordinated movement until witness survival,
complete endpoints, traces, budgets, and renders from that matrix have been
analyzed.
