# Open-Source Irregular Nesting Strategy Review

Date: 2026-07-17 (updated 2026-07-20)

This is a final source-level control pass over the main open-source references
that are relevant to the current `min-plane-dfx` irregular convex nesting
problem. It answers three immediate questions:

1. Are we asking the deterministic beam to do work that other systems delegate
   to a genetic algorithm or another outer search?
2. Can balanced and edge-contact placement be made independent of sheet
   dimensions when the same placements remain legal?
3. What is the safest way to improve hole filling without losing the approved
   repeated-triangle lattice?

The source trees inspected below are pinned local clones. Line references are
to those exact checkouts, and each checkout is linked to its official upstream
commit.

## Pinned Sources

| Project | Commit | Official source |
| --- | --- | --- |
| Deepnest | `2fb10513a30681971dcc991c528fa0738a2c0c76` | [Jack000/Deepnest at the inspected commit](https://github.com/Jack000/Deepnest/tree/2fb10513a30681971dcc991c528fa0738a2c0c76) |
| SVGnest | `1248dc21efd3f90d1aa52ba5785e27e5217ed2c9` | [Jack000/SVGnest at the inspected commit](https://github.com/Jack000/SVGnest/tree/1248dc21efd3f90d1aa52ba5785e27e5217ed2c9) |
| libnest2d | `663daa69e1d7478669f714218e27681edbc96640` | [tamasmeszaros/libnest2d at the inspected commit](https://github.com/tamasmeszaros/libnest2d/tree/663daa69e1d7478669f714218e27681edbc96640) |
| PackingSolver | `3d8d97dd8ae5ac46f08328636f5e168283282ebc` | [fontanf/packingsolver at the inspected commit](https://github.com/fontanf/packingsolver/tree/3d8d97dd8ae5ac46f08328636f5e168283282ebc) |
| Sparrow | `961ec31f576c5817ece779ff73982b4553760a4e` | [JeroenGar/sparrow at the inspected commit](https://github.com/JeroenGar/sparrow/tree/961ec31f576c5817ece779ff73982b4553760a4e) |
| Dalsoo-Bin-Packing | `bde2a3ef09f48980e59328eae7b042e6d9fdd4bc` | [whitegreen/Dalsoo-Bin-Packing at the inspected commit](https://github.com/whitegreen/Dalsoo-Bin-Packing/tree/bde2a3ef09f48980e59328eae7b042e6d9fdd4bc) |

## Executive Conclusion

The evidence does **not** say that GA is universally better than beam search.
It says that successful nesters separate two responsibilities:

- a constructive decoder makes one placement at a time using an envelope- or
  strip-oriented objective;
- an outer search changes piece order, rotation, or the starting solution so
  that the decoder sees materially different futures.

Deepnest and SVGnest use a greedy NFP decoder plus a GA over order and rotation.
PackingSolver uses a portfolio of tree search, local search, MILP, sequential
value correction, and large-item-first phases. Sparrow uses a left-bottom
constructor followed by strip shrinking, separation, disruption, and coordinate
descent. libnest2d exposes a configurable NFP placer and simple selectors.
Dalsoo-Bin-Packing is a useful contrast: it enumerates feature-aligned poses and
maintains an incremental convex hull, but commits every successful greedy
placement, then opens another bin. It has neither an endpoint archive nor a
feasibility-restoration or topology-repair stage.

Therefore:

1. **Do not replace the deterministic beam with GA as a first fix.** The current
   beam is not failing because it is “too optimal”; it is pruning against
   sheet-normalized and sometimes contact-dominant signals. GA would explore
   more orderings but can still optimize the wrong decoder more thoroughly.
2. **Make local and global compactness intrinsic first.** For balanced and
   edge-contact modes, occupied envelope width, height, area, span, and hull
   waste should not be divided by sheet width or height. Sheet dimensions
   should constrain legality. `short_side_fill` is the intentional exception
   because its purpose is relative to the sheet's short side.
3. **Then use the existing GA portfolio as a bounded optional second stage.** It
   already mutates priority order, transform preferences, and placement policy,
   preserves the deterministic baseline, and selects the better decoded result.
   That is directly analogous to the useful part of Deepnest/SVGnest.
4. **Treat small-piece filling as a decoder/ordering phase, not a stronger
   contact reward.** Preserve legal NFP cavity candidates, defer a bounded set
   of small pieces, and/or run a deterministic large-first then small-fill seed.
   Let all seeds compete under the same intrinsic terminal comparator.

## Strategy Matrix

| Project | Constructive placement | Outer search | Main geometric pressure | Explicit small-piece or hole treatment |
| --- | --- | --- | --- | --- |
| Deepnest | NFP boundary vertex choice | GA over order and rotation | absolute `2 * width + height`, box area, or hull area | feasible NFP regions include cavities; GA can reorder small pieces; no explicit cavity score |
| SVGnest | NFP boundary vertex choice | GA over order and rotation | absolute `2 * width + height` | same cavity opportunity; no explicit cavity score |
| libnest2d | best contour point across rotations | caller-selected order; no core GA | configurable objective; default center distance and overfit | contour optimization can inspect hole contours; selectors remain area-first |
| PackingSolver | trapezoid/tree and local-search variants | algorithm portfolio | guide area or box area relative to occupied hull/profit | explicit large-item-first phase fixes large pieces, then solves small pieces |
| Sparrow | left-bottom constructive seed | sampled starts, coordinate descent, exploration/disruption | strip width, feasibility, density | global squeeze and disruption can reopen gaps; no NFP cavity enumerator |
| Dalsoo-Bin-Packing | vertex-to-vertex poses; its Abey mode also aligns adjacent edges | none; sequentially opens further bins | incremental convex-hull area times an origin/axis pressure | none; simple polygons only and no free-space or topology model |

## Deepnest

### What it actually searches

Deepnest creates one chromosome entry per copied part, seeds the chromosome in
descending area order, and associates a rotation with each entry
(`main/deepnest.js:1062-1087`). The GA then mutates
the order with adjacent swaps, mutates rotations, performs ordered crossover,
and preserves elites (`main/deepnest.js:1329-1437`). Defaults include a small
population, mutation rate, four rotations, gravity placement, and common-line
merging (`main/deepnest.js:20-33`).

The chromosome is not a geometric layout. It is an instruction sequence for a
deterministic NFP decoder. The decoder rotates the current part, opens sheets as
needed, and tries allowed rotations (`main/background.js:804-880`). It forms the
feasible region by subtracting the union of already-placed outer NFPs from the
sheet IFP (`main/background.js:911-980`).

### How it chooses a placement

The decoder evaluates feasible boundary vertices and scores the resulting
occupied cluster with an absolute geometric objective
(`main/background.js:995-1129`):

- gravity: `2 * occupiedWidth + occupiedHeight` (`background.js:1058-1064`);
- box: occupied bounding-box area;
- hull: occupied convex-hull area.

Common-line length is subtracted as a soft bonus, rather than placed ahead of
compactness as an unlimited lexicographic objective
(`background.js:1082-1095`). Equal placements use deterministic x/y ordering
(`background.js:1099-1113`). Final fitness adds opened-sheet area, a small
minimum-width/area term, and a very large unplaced penalty
(`background.js:1141-1172`).

### Transferable lesson

Deepnest's useful pattern is not “GA fixes geometry.” It is:

1. absolute envelope-oriented local placement;
2. deterministic decoding;
3. GA diversity over order and rotation;
4. contact as a bounded bonus.

This structure naturally resists long contact chains better than a comparator
that allows one extra contact band to dominate a large envelope regression.

## SVGnest

SVGnest is the same broad family and makes the evidence easier to isolate. It
seeds parts in descending area order and evaluates GA chromosomes
(`svgnest.js:265-300`). The chromosome contains
order and rotations, with mutation, ordered crossover, and elitism
(`svgnest.js:820-960`; defaults at `svgnest.js:28-36`).

Its placement worker starts a sheet at the leftmost legal first position
(`util/placementworker.js:81-140`), subtracts the
union of outer NFPs from the IFP (`placementworker.js:143-211`), and ranks legal
vertices with:

```text
2 * occupiedWidth + occupiedHeight
```

with an x-coordinate tie-break (`placementworker.js:213-288`, specifically
`249-252`). The outer fitness adds `minWidth / binArea` and an unplaced penalty
(`placementworker.js:266-286`).

SVGnest therefore supplies the clearest answer to the GA question: GA is used
because a greedy decoder is strongly order-dependent, not because the local
decoder lacks a compactness objective.

## libnest2d

libnest2d is a useful counterexample to “every good nester requires GA.” Its NFP
placer exposes configured rotations, alignment, starting position, accuracy,
and a custom objective callback
(`include/libnest2d/placers/nfpplacer.hpp:29-123`).
It tries all configured rotations for the first item (`nfpplacer.hpp:674-695`)
and for later items (`nfpplacer.hpp:699-735`). For each rotation it optimizes
along every NFP contour from all corners and keeps the global best point
(`nfpplacer.hpp:772-887`).

The default objective is based on candidate bounding-box center distance and a
squared overfit penalty (`nfpplacer.hpp:637-671`), but callers can replace it.
The standard FirstFit and Filler selectors remain area-descending
(`include/libnest2d/selections/firstfit.hpp:66-104` and
`include/libnest2d/selections/filler.hpp:56-79`).

The transferable idea is **orientation-family coverage before truncation**:
evaluate each meaningful rotation family, compare the best candidate from each,
then apply a cap. This is safer than allowing one orientation to consume the
whole local fanout. The hole-contour pathway also shows that cavity candidates
must remain visible to the selector; an objective cannot choose a hole that
candidate generation discarded.

## PackingSolver

PackingSolver is the strongest evidence for a bounded portfolio rather than one
universal tuple. Its irregular optimizer selects among tree search, local
search, MILP, sequential value correction, and column generation according to
instance properties (`src/irregular/optimize.cpp:431-603`).
Variants may run in parallel, while deterministic mode buffers results and
replays them in a stable order (`optimize.cpp:636-698`).

Tree-search guides include guide area or bounding-box area normalized by the
occupied convex hull/profit (`src/irregular/tree_search.hpp:643-728`), and the
implementation generates several guide/direction/growth-factor variants
(`src/irregular/tree_search.cpp:2870-2910`). Rotation preprocessing deduplicates
equivalent normalized shapes while preserving minimum-width, minimum-height,
and per-item coverage before enforcing a quality budget
(`src/irregular/rotations.cpp:247-300` and `430-568`).

Most relevant to the visible small-square gaps, PackingSolver has an explicit
large-item-first path. It classifies large and small items from convex-hull area,
solves the large items, fixes them, then solves the remaining small items
(`src/irregular/large_item_first.cpp:23-65`
and `90-138`). It also contains one- and two-shape periodic-cell construction
(`src/irregular/periodic_packing.cpp:394-529`), although this source pass did not
establish that the inspected main optimizer automatically consumes those cells.

The safe transfers are:

- multiple bounded deterministic decoders under one terminal comparator;
- preserve distinct transform families before a transform budget;
- large-first then small-fill as one seed, not the only run;
- periodic cells as an optional repeated-shape seed.

## Sparrow

Sparrow does not use NFP placement. Its initial left-bottom constructor orders
items by descending convex-hull area times diameter
(`src/optimizer/lbf.rs:38-61`) and scores a
left-bottom position with a strong x-before-y loss
(`src/eval/lbf_evaluator.rs:9-49`). It samples multiple focused and container
transformations, keeps distinct strong starts, then refines them with coordinate
descent (`src/sample/search.rs:12-76` and `src/sample/best_samples.rs:7-107`).

It repeatedly shrinks the strip and separates overlaps, accepting only feasible
results (`src/optimizer/compress.rs:10-72`). Its exploration phase retains an
infeasible pool and disrupts layouts by swapping large items
(`src/optimizer/explore.rs:20-75` and `95-165`).

The transferable lesson is a bounded **squeeze-and-repair outer phase**, not the
exact overlap-based kernel. It can improve global arrangement after a legal
constructor, but it is materially more expensive and is not a substitute for a
correct fast decoder.

## Dalsoo-Bin-Packing

### What it actually solves

Dalsoo-Bin-Packing is a Java library for two-dimensional irregular packing into
one or more rectangular bins. Its public constructor receives a collection of
polygons, spacing, a rotation setting, bin width/height, and `hSkew`, an
intentional horizontal-versus-vertical placement bias
([`DalsooPack.java:23-51`](https://github.com/whitegreen/Dalsoo-Bin-Packing/blob/bde2a3ef09f48980e59328eae7b042e6d9fdd4bc/src/main/java/whitegreen/dalsoo/DalsooPack.java#L23-L51)).
The stated input contract is a simple polygon with neither holes nor
self-intersections; the source accepts its outer vertex loop only
([`README.md:14-38`](https://github.com/whitegreen/Dalsoo-Bin-Packing/blob/bde2a3ef09f48980e59328eae7b042e6d9fdd4bc/README.md#L14-L38)).

`packAll` is not a fixed-sheet optimiser: it repeatedly takes the remaining
polygons and opens another bin until none are left
([`DalsooPack.java:62-84`](https://github.com/whitegreen/Dalsoo-Bin-Packing/blob/bde2a3ef09f48980e59328eae7b042e6d9fdd4bc/src/main/java/whitegreen/dalsoo/DalsooPack.java#L62-L84)).
Within a bin, optional area sorting is followed by a largest-first sequential
decode. A placement is final as soon as it is found; there is no retained
alternative state, restart, order mutation, local search, or backtracking
([`Bin.java:91-107`](https://github.com/whitegreen/Dalsoo-Bin-Packing/blob/bde2a3ef09f48980e59328eae7b042e6d9fdd4bc/src/main/java/whitegreen/dalsoo/Bin.java#L91-L107)).

### Constructive candidates and objective

The two code paths use the same greedy commitment but genuinely different pose
generators:

- the `Dalalah` path enumerates every configured rotation and every new-piece
  vertex / fixed-piece vertex translation
  ([`Bin.java:211-256`](https://github.com/whitegreen/Dalsoo-Bin-Packing/blob/bde2a3ef09f48980e59328eae7b042e6d9fdd4bc/src/main/java/whitegreen/dalsoo/Bin.java#L211-L256));
- the `Abey` path derives two rotations per pair of adjacent new and fixed
  edges, aligns a vertex, and tests the resulting pose
  ([`Bin.java:137-208`](https://github.com/whitegreen/Dalsoo-Bin-Packing/blob/bde2a3ef09f48980e59328eae7b042e6d9fdd4bc/src/main/java/whitegreen/dalsoo/Bin.java#L137-L208)).

Its only cost-quality controls are structural: `rotSteps` bounds the Dalalah
rotation scan and `segmentMaxLength` can subdivide long offset edges before
those vertex loops run ([`PackedPoly.java:42-63`](https://github.com/whitegreen/Dalsoo-Bin-Packing/blob/bde2a3ef09f48980e59328eae7b042e6d9fdd4bc/src/main/java/whitegreen/dalsoo/PackedPoly.java#L42-L63)).
It has no wall-time budget, evaluation budget, retained infeasible pool, or
archive. Its move vocabulary is insertion of one new polygon only: it never
translates, separates, removes, or jointly repairs already placed polygons.

For a feasible pose, each path incrementally adds the candidate vertices to a
copy of the occupied convex hull. It chooses the smallest hull-area expression
multiplied by an origin-relative `hSkew` pressure, then commits the pose
([`Convex.java:48-97`](https://github.com/whitegreen/Dalsoo-Bin-Packing/blob/bde2a3ef09f48980e59328eae7b042e6d9fdd4bc/src/main/java/whitegreen/dalsoo/Convex.java#L48-L97),
[`Bin.java:181-195`](https://github.com/whitegreen/Dalsoo-Bin-Packing/blob/bde2a3ef09f48980e59328eae7b042e6d9fdd4bc/src/main/java/whitegreen/dalsoo/Bin.java#L181-L195),
[`Bin.java:227-241`](https://github.com/whitegreen/Dalsoo-Bin-Packing/blob/bde2a3ef09f48980e59328eae7b042e6d9fdd4bc/src/main/java/whitegreen/dalsoo/Bin.java#L227-L241)).
This is absolute geometry, rather than a width/sheet-width ratio, but it is not
axis-invariant: `hSkew` deliberately rewards progress toward one sheet origin.

### Feasibility and topology limits

`isFeasible` checks the candidate against rectangular bounds, then uses a
bounding-box filter, one placed-polygon centroid-in-candidate test, and strict
edge-crossing tests ([`Bin.java:258-275`](https://github.com/whitegreen/Dalsoo-Bin-Packing/blob/bde2a3ef09f48980e59328eae7b042e6d9fdd4bc/src/main/java/whitegreen/dalsoo/Bin.java#L258-L275),
[`Bin.java:317-345`](https://github.com/whitegreen/Dalsoo-Bin-Packing/blob/bde2a3ef09f48980e59328eae7b042e6d9fdd4bc/src/main/java/whitegreen/dalsoo/Bin.java#L317-L345)).
The source explicitly says the centroid shortcut is not completely robust.
Its arithmetic is floating point; the only JTS operation is a fallback used to
buffer a problematic offset polygon, not a canonical legality oracle
([`MathUtil.java:459-489`](https://github.com/whitegreen/Dalsoo-Bin-Packing/blob/bde2a3ef09f48980e59328eae7b042e6d9fdd4bc/src/main/java/whitegreen/dalsoo/MathUtil.java#L459-L489)).

There is no occupied-union cavity count, contact graph, component score,
free-space decomposition, or repair mechanism. The convex hull makes the
algorithm sensitive to broad external spread, but it cannot distinguish a
compact filled cluster from a hollow ring with the same hull. Consequently it
cannot diagnose, let alone correct, the mixed-61 failure on its own.

### What transfers to `min-plane-dfx`

1. **Feature-contact pose coverage is worth measuring, not assuming.** Dalsoo's
   edge/vertex alignment is a concrete reminder that a constructive search may
   miss a good compact placement before its comparator has a chance to rank it.
   Add a Dalsoo-style candidate only if Stage-0/V7 traces prove that the current
   NFP candidate generator failed to materialize a deterministic feature-contact
   pose. It must be grid-projected once, canonical-Clipper2 admitted, deduped by
   the phase-aware state key, and compete under the existing intrinsic archive.
2. **Incremental external-envelope estimates belong in proposal steering.** The
   bounded hull-growth signal is compatible with the present intrinsic
   compactness direction, but the exact occupied union, cavity, and contact
   analysis must remain the authority at protection and terminal selection.
3. **The rotation lesson is family coverage, not free rotation.** The Abey path
   derives contact-compatible orientations while Dalalah enumerates a bounded
   rotation set. Preserve distinct permitted transform families before local
   truncation; do not introduce arbitrary-angle rotations into the current
   quarter-turn/canonical collision model.
4. **Use explicit search budgets, not geometry degradation, for runtime.**
   Dalsoo controls cost by reducing rotations or changing edge subdivision. V7
   should instead expose candidate/materialized/deduped/admitted counters and
   a per-arm evaluation/time cap, so a speed control cannot silently change the
   authoritative collision geometry.

### What must not transfer

- Do not replace canonical Clipper2 admission with Dalsoo's floating-point
  centroid/edge test, or use its one-sided offset collision convention.
- Do not copy the greedy first-feasible commitment, `packAll` multi-bin
  objective, or origin-biased `hSkew` scalarization. All three can hide a
  compact future or create an arbitrary axis preference.
- Do not infer hole filling from hull area. Dalsoo has no hole input and no
  cavity/topology representation.
- Do not use its continuous edge-derived rotations as a shortcut around the
  allowed transform policy or the sheet-invariance contract.

### Relation to the current V7 direction

Dalsoo does not change the Stage-0 endpoint archive or the independent
Stage-1 S/A/E probes: those address the missing retained futures and exact
feasibility boundary that its source lacks. It adds one falsifiable
post-V7 question: if traces show that a good *legal* compact endpoint is absent
because no current candidate reaches a relevant piece-feature contact, run a
bounded feature-contact coverage probe. If those poses are already present and
pruned, improve survivor policy instead; if they are absent but do not survive
the common intrinsic archive, reject the generator rather than increasing raw
contact reward.

The source/paper boundary, the exact feasibility caveats, and the conditional
V7 Stage-1.5/F coverage-audit contract are recorded in the
[Dalsoo, Abeysooriya, and Dalalah transfer study](dalsoo-abey-dalalah-transfer-study.md).

## Current `min-plane-dfx` Comparison

The current repository already has the beginnings of the Deepnest/SVGnest
division of responsibility:

- GA is disabled by default, but its settings include priority-order,
  transform-preference, and placement-policy mutation
  (`src/shared/irregular/defaults.ts:40-49`).
- the deterministic baseline is always decoded first
  (`src/workers/algorithm/irregular/portfolioSearch.ts:203-301`);
- the GA creates a population around that baseline
  (`portfolioSearch.ts:562-624`), preserves the baseline and elites
  (`portfolioSearch.ts:627-661`), and mutates piece priority with swaps, moves,
  and reversals (`portfolioSearch.ts:809-848`);
- the feature is activated only when its explicit settings and budgets permit
  it (`portfolioSearch.ts:988-995`).

The blocker is earlier in the decoder. Balanced local placement divides cluster
width and height by sheet width and height
(`src/workers/algorithm/irregular/irregularPlacementScorer.ts:209-222`) and
ranks those normalized values before absolute area/span
(`irregularPlacementScorer.ts:101-113`). Whole-state beam ranking repeats the
same normalization (`src/workers/algorithm/irregular/irregularLayoutScorer.ts:257-262`
and `505-565`). Terminal repair guards also use the normalized envelope first
(`src/workers/algorithm/irregular/windowedBeam.ts:706-717`).

That explains the observed sheet-size regression. Changing only the final
comparator cannot restore a branch that local ranking already pruned on an
earlier step.

## Can Sheet Dimensions Be Made Irrelevant?

Yes, with two precise qualifications:

1. The same candidate placements must remain legal on both sheets. If a smaller
   sheet removes a candidate, the result may legitimately change.
2. `short_side_fill` is explicitly a sheet-relative policy and may legitimately
   change when the short side changes.

For balanced and edge-contact placement, every search decision that can remove
a branch must use the same intrinsic compactness semantics:

- local candidate ranking;
- any local-policy reservation or fanout merge;
- whole-state beam ranking and diversity reservation;
- terminal winner comparison;
- terminal orientation and repair guards.

A safe intrinsic envelope tuple is based on absolute occupied geometry, for
example:

```text
smaller occupied bounding-box area
smaller maximum occupied span
smaller occupied width + height
smaller occupied hull waste
bounded structural-contact tie-break
deterministic lower-left identity tie-break
```

The exact tuple still needs corpus validation, but none of these terms changes
merely because an otherwise roomy sheet changes from `2000 x 2700` to
`1000 x 1700`. Sheet dimensions remain in legality and capacity checks.

Deepnest and SVGnest support this design direction because their local placement
costs use absolute occupied width/height. They are not proofs of rotational or
axis invariance: gravity deliberately weights one axis more than the other.

## Should GA Be Enabled?

### Recommended answer

Enable it only as a **bounded optional portfolio after intrinsic ranking is
correct**, not as a hidden always-on repair for the current decoder.

The existing implementation already has the right safety property: decode the
deterministic baseline, keep it in the population, and return a GA result only
when the common comparator says it is better. That makes a small experiment
low-risk.

Recommended first GA gate:

- repair disabled;
- baseline deterministic beam unchanged;
- small population and generation/evaluation/time budget;
- priority-order and transform-preference mutation enabled;
- placement-policy mutation initially disabled so the experiment isolates
  order/rotation value;
- compare triangle golden, mixed-50, mixed-61, sheet-size pairs, and a
  homogeneous repeated-shape corpus;
- require the baseline canonical geometry hash to remain available and reject
  any selected result that is worse under the shared terminal comparator.

If this helps mixed jobs consistently, expose it as an explicit quality/time
control. Do not silently make a long GA run part of every click.

### Why GA cannot be the first fix

GA changes the sequence fed to the decoder. It does not make a sheet-normalized
local objective sheet-independent. It also does not automatically place small
pieces in holes: the decoder must generate those legal candidates and rank them
competitively.

## Small Pieces And Visible Holes

The open-source evidence points to three complementary mechanisms:

1. **Keep cavity candidates.** NFP subtraction can expose vertices inside legal
   gaps. Candidate deduplication and fanout must not discard them before the
   global scorer sees them.
2. **Add bounded order diversity.** GA/order seeds can move a small item earlier
   or later so that it can occupy a cavity before the surrounding branch is
   pruned.
3. **Use one large-first then small-fill seed.** PackingSolver demonstrates this
   as a separate phase. The seed should compete with the ordinary beam result;
   it must not replace it unconditionally.

For this repository, the smallest safe experiment is deterministic:

- reserve the normal sorted-order decode;
- add one seed that temporarily defers a bounded number of smallest-area pieces;
- after the large-piece prefix, decode the small pieces against all legal NFP
  cavity candidates;
- deduplicate final geometry and compare with the same intrinsic terminal
  comparator;
- preserve the triangle golden and reject layouts with larger obvious one-piece
  cavities or worse occupied envelope.

This is preferable to increasing raw shared-boundary reward, which can recreate
the long-chain failure.

## Ranked Recommendation

1. **Complete sheet-invariant semantics across the entire pruning path.** Keep
   the work isolated until both sheet-size pairs and the triangle golden pass.
2. **Retain the deterministic beam as the baseline constructor.** Its geometry
   deduplication and bounded diversity are useful; wrong ranking is the issue,
   not beam search itself.
3. **Add a small deterministic decoder portfolio.** Start with normal order,
   large-first/small-fill, and an orientation-family-balanced seed.
4. **Evaluate the existing GA portfolio as an optional second stage.** Use it to
   explore order and rotation, not to conceal scoring defects.
5. **Consider periodic-cell seeds only for repeated-shape jobs.** They complement
   the general constructor but must not become a special-case final scorer.
6. **Defer Sparrow-style squeeze/large-neighborhood search until the fast path is
   correct and profiled.** It is promising but materially more expensive.
7. **Measure candidate-pose coverage before adding another generator.** If a
   trace proves that an NFP decoder never materializes a useful compact feature
   contact, test a bounded Dalsoo-style vertex/edge-alignment generator behind
   the same exact admission and archive. Do not use it as a new greedy decoder.

## Rejected Shortcuts

- Increasing beam width cannot fix a comparator that consistently removes the
  desired branch.
- More contact reward does not imply compactness; a one-dimensional chain can
  accumulate excellent contact.
- GA does not create missing NFP cavity candidates and does not remove
  sheet-normalized scoring.
- Changing only the terminal comparator is insufficient because local fanout
  and beam pruning are irreversible.
- Copying Deepnest's `2 * width + height` literally would introduce a fixed axis
  preference. The transferable principle is absolute occupied geometry, not
  that exact weight.
- Making the small-fill order mandatory risks starving repeated-shape motifs.
  It should be a bounded competing seed.

## Falsifiable Production Experiments

### Experiment A: full-path intrinsic compactness

Pass conditions:

- identical canonical geometry across roomy sheet-size variants, modulo an
  explicitly allowed terminal quarter-turn;
- triangle golden unchanged;
- no regression on mixed-50 and mixed-61 occupied envelope/hole gates;
- no legality, collision, or deterministic replay mismatch.

Failure meaning: one or more hidden pruning decisions still depend on sheet
dimensions, or the proposed intrinsic tuple loses required structural contact.

### Experiment B: deterministic order portfolio

Decode the same request with normal order and one large-first/small-fill order.

Pass conditions:

- small squares use previously empty legal regions on mixed-61;
- final occupied envelope does not grow;
- triangle golden selects its established baseline;
- runtime remains within a strict multiple of one decode.

Failure meaning: the current decoder does not expose useful cavity candidates,
or the terminal comparator does not value the resulting space utilization.

### Experiment C: bounded GA

Run the existing portfolio with only order and transform-preference mutation.

Pass conditions:

- improves at least two heterogeneous corpus fixtures over all deterministic
  seeds;
- never replaces a better baseline;
- keeps repeatability under the same seed/runtime environment;
- measured time/quality tradeoff is acceptable from the UI.

Failure meaning: order diversity is not the dominant limitation, so work should
return to candidate generation, local ranking, or a stronger compaction phase.

### Experiment D: feature-contact coverage audit

For each rejected compact continuation, record whether an equivalent legal pose
at the relevant candidate/fixed feature contact was materialized before
deduplication, after deduplication, and after local fanout. Only if it was never
materialized, add a bounded deterministic vertex/edge-alignment candidate
generator for the allowed transform family, with canonical Clipper2 admission.

Pass conditions:

- it adds phase-distinct legal candidates rather than duplicate NFP endpoints;
- at least one added candidate survives the ordinary intrinsic archive without
  worsening the triangle golden;
- runtime stays within a declared candidate-generation budget.

Failure meaning: the weakness lies in retention, order, or global topology—not
in missing feature-contact pose generation. Remove the probe rather than giving
feature contact more comparator weight.

## Bottom Line

The open-source control pass supports the current direction with one correction:
the project should stop trying to encode every future decision into a single
contact-heavy beam tuple. Use an intrinsic compact constructor, preserve several
bounded order/orientation seeds, and optionally let the existing GA explore
order and rotation around those seeds. This can make balanced and edge-contact
behavior independent of roomy sheet dimensions while still giving small pieces
a real opportunity to fill cavities.
