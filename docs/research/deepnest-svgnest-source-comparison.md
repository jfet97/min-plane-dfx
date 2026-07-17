# DeepNest and SVGnest Source Comparison

This comparison uses pinned upstream source snapshots rather than product
screenshots or secondary descriptions:

- DeepNest commit
  [`2fb10513a30681971dcc991c528fa0738a2c0c76`](https://github.com/Jack000/Deepnest/tree/2fb10513a30681971dcc991c528fa0738a2c0c76)
  from 2018-08-25;
- SVGnest commit
  [`1248dc21efd3f90d1aa52ba5785e27e5217ed2c9`](https://github.com/Jack000/SVGnest/tree/1248dc21efd3f90d1aa52ba5785e27e5217ed2c9)
  from 2019-04-11.

The useful transfer is their separation between legal NFP placement, local
envelope compaction, and global order/rotation search. Their numerical formulas
are not suitable for copying verbatim.

## Piece Order and Global Exploration

### Upstream Behavior

SVGnest describes and implements first-fit decreasing: the initial search order
is descending polygon area, and a genetic algorithm explores insertion order and
rotation. See its
[`readme.md`](https://github.com/Jack000/SVGnest/blob/1248dc21efd3f90d1aa52ba5785e27e5217ed2c9/readme.md#L65-L89)
and
[`svgnest.js`](https://github.com/Jack000/SVGnest/blob/1248dc21efd3f90d1aa52ba5785e27e5217ed2c9/svgnest.js#L269-L302).

DeepNest expands quantities into unique copies, sorts the initial chromosome by
descending polygon area, and uses the same broad GA structure. Mutations swap
adjacent pieces and change rotations, ordered crossover preserves every unique
piece id, and elitism retains the current best. See
[`main/deepnest.js`](https://github.com/Jack000/Deepnest/blob/2fb10513a30681971dcc991c528fa0738a2c0c76/main/deepnest.js#L1062-L1087)
and its
[`GeneticAlgorithm`](https://github.com/Jack000/Deepnest/blob/2fb10513a30681971dcc991c528fa0738a2c0c76/main/deepnest.js#L1329-L1437).

### Current Engine

`min-plane-dfx` also starts large-first, but its user-owned baseline sorts by
longest edge, then padded-bounds area, then imbalance in
[`sortPiecesForNesting.ts`](../../src/workers/algorithm/sortPiecesForNesting.ts).
The deterministic decoder can reorder only within `orderWindow`. Broader
order/rotation exploration exists in the GA portfolio, but it is disabled by
default in
[`defaults.ts`](../../src/shared/irregular/defaults.ts).

## Candidate Generation

Both upstream engines construct the feasible region as the sheet IFP minus the
union of translated outer NFPs, then evaluate vertices on the remaining NFP
boundary:

- SVGnest
  [`util/placementworker.js`](https://github.com/Jack000/SVGnest/blob/1248dc21efd3f90d1aa52ba5785e27e5217ed2c9/util/placementworker.js#L95-L259);
- DeepNest
  [`main/background.js`](https://github.com/Jack000/Deepnest/blob/2fb10513a30681971dcc991c528fa0738a2c0c76/main/background.js#L911-L1129).

This is the same broad contact-candidate construction used here. The source
comparison does not reveal a missing placement primitive that by itself explains
the mixed-shape failure. The important differences are candidate ranking and
global search.

SVGnest anchors the first piece at the leftmost legal point. DeepNest anchors it
at the top-left legal point. DeepNest tries alternative cardinal rotations when
the first part on a sheet otherwise does not fit; normal rotation exploration
belongs to the GA chromosome.

## Objective and Compaction

SVGnest ranks local placements by `2 * boundingWidth + boundingHeight`, with the
leftmost position as its tie-break. Its GA fitness penalizes additional bins and
unplaced pieces before occupied width. See
[`util/placementworker.js`](https://github.com/Jack000/SVGnest/blob/1248dc21efd3f90d1aa52ba5785e27e5217ed2c9/util/placementworker.js#L213-L288).

DeepNest exposes `gravity`, `box`, and hull placement modes. The default
`gravity` objective is `2 * boundingWidth + boundingHeight`, `box` uses
bounding-box area, and the remaining mode uses convex-hull area. See
[`main/background.js`](https://github.com/Jack000/Deepnest/blob/2fb10513a30681971dcc991c528fa0738a2c0c76/main/background.js#L995-L1077).

DeepNest does reward common-line contact, but it does not make contact a
lexicographically dominant whole-layout criterion. It computes envelope or hull
cost first and then subtracts the soft bonus `mergedLength * timeRatio`, whose
default ratio is `0.5`. See
[`main/background.js`](https://github.com/Jack000/Deepnest/blob/2fb10513a30681971dcc991c528fa0738a2c0c76/main/background.js#L1080-L1095)
and the
[`main/deepnest.js` defaults](https://github.com/Jack000/Deepnest/blob/2fb10513a30681971dcc991c528fa0738a2c0c76/main/deepnest.js#L20-L33).
The line reward is bounded by available boundary length and acts as a soft bonus
after envelope evaluation, not categorical proof of compactness.

The current local `edge contact, then compactness` policy instead sorts raw
shared boundary before every envelope measure. It reserves one compactness
candidate, but the rest of the local fanout remains contact-first in
[`irregularPlacementScorer.ts`](../../src/workers/algorithm/irregular/irregularPlacementScorer.ts)
and
[`windowedBeam.ts`](../../src/workers/algorithm/irregular/windowedBeam.ts).

More importantly, whole-layout beam retention currently puts dominant
near-complete structural contacts and total near-complete structural contacts
before collision-bounds consumption, span, area, and hull waste in
[`irregularLayoutScorer.ts`](../../src/workers/algorithm/irregular/irregularLayoutScorer.ts).
One additional structural contact can therefore beat an arbitrarily worse
envelope. A repeated contact-rich chain or separated contact-rich blocks can
categorically outrank a tighter cluster.

## Identical Copies and Caching

DeepNest assigns each copy a unique `id` but shares a `source` identity across
copies of the same part. NFP preprocessing and caching deduplicate pairs by
source and rotations rather than copy id. See
[`main/deepnest.js`](https://github.com/Jack000/Deepnest/blob/2fb10513a30681971dcc991c528fa0738a2c0c76/main/deepnest.js#L1065-L1077)
and
[`main/background.js`](https://github.com/Jack000/Deepnest/blob/2fb10513a30681971dcc991c528fa0738a2c0c76/main/background.js#L137-L169).

Its GA still treats copies as separate ids, so it can generate redundant copy
permutations. Current `min-plane-dfx` is stronger at the decoder boundary: local
candidates are deduplicated by occupied geometry, beam states use an
interchangeability signature, and the decode-local NFP memo reuses equivalent
geometry. Identical-copy handling is therefore not the remaining mixed-layout
root cause.

## Why the Upstream Objective Is Less Prone to Fragmented Chains

The following conclusions are inferences from the source, not claims that either
upstream engine is optimal for every fixture:

1. Every accepted insertion directly minimizes the occupied envelope or hull,
   so an isolated contact-rich appendage is expensive immediately.
2. Global order/rotation search can change which large shapes establish the
   envelope; smaller shapes then fill the remaining gaps.
3. Common-edge length improves a DeepNest candidate only as a soft bonus after
   envelope evaluation.
4. Current structural-contact counts precede envelope quality
   lexicographically, so NFP accuracy, beam width, and copy deduplication cannot
   correct the objective by themselves.

## Production Recommendations

### Guard Contact Rewards With Compactness

Compare unplaced count first, then place layouts into small scale-normalized
compactness bands based on worst normalized sheet consumption and span or area
growth. Allow dominant and total structural contact to decide only inside the
same compactness band, followed by exact compactness. This preserves contact as
a useful lattice signal without allowing one additional contact to purchase an
unbounded chain.

This is the closest deterministic transfer of DeepNest's envelope-first
objective. A lexicographic band is preferable to copying its dimensionally mixed
formula because the band remains deterministic and directly testable.

### Retain Contact and Envelope Decodes

Keep a small deterministic portfolio containing both the contact-aware policy
and an envelope-first `balanced_compactness` or gravity-like policy. Select the
complete results with the guarded whole-layout comparator. An optional
area-first order seed can broaden the portfolio without replacing the user-owned
baseline order.

This mirrors the upstream split between placement policy and order search and is
safer than forcing one local heuristic to solve repeated triangles and
heterogeneous jobs simultaneously.

### Spend Heterogeneous-Job Budget on Order and Rotation

For mixed jobs, add a bounded area-first chromosome and a few deterministic
adjacent-swap and rotation chromosomes before increasing a contact-driven beam
width. DeepNest and SVGnest gain global diversity by repeatedly evaluating
order/rotation combinations. A wider beam with the same contact-dominant ranking
searches the wrong objective more thoroughly.

## What Not to Copy

- Do not copy the upstream formulas literally. SVGnest mixes width and bin area
  dimensionally, while DeepNest mixes envelope area or length with a line-length
  bonus. The transferable principle is envelope-first with bounded contact
  influence.
- Do not replace the current geometry validator or convex collision artifacts
  with upstream SVG simplification or NFP code.
- Do not assume upstream GA identity handling removes equivalent-copy
  permutations; it does not.
- Do not assume the GA alone fixes a contact-dominant final comparator. A broader
  search can optimize the wrong objective more effectively.
