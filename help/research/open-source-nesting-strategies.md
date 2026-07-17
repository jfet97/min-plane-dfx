# Open-Source Irregular Nesting Strategy Review

Date: 2026-07-17

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

## Bottom Line

The open-source control pass supports the current direction with one correction:
the project should stop trying to encode every future decision into a single
contact-heavy beam tuple. Use an intrinsic compact constructor, preserve several
bounded order/orientation seeds, and optionally let the existing GA explore
order and rotation around those seeds. This can make balanced and edge-contact
behavior independent of roomy sheet dimensions while still giving small pieces
a real opportunity to fill cavities.
