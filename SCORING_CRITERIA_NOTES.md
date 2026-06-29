# Scoring Criteria Notes

These are working notes for the future nesting algorithm.
The app implementer must not implement the algorithm yet.

## Initial Rectangle Ordering

Use one initial piece ordering for now.
Compute these values from padded rectangle dimensions:

```text
u_i = padded width
v_i = padded height

longSide_i = max(u_i, v_i)
area_i = u_i * v_i
imbalance_i = abs(u_i - v_i)
```

Sort descending lexicographically:

```text
(
  -longSide_i,
  -area_i,
  -imbalance_i
)
```

Equivalent plain-English order:

1. longest side descending;
2. area descending;
3. imbalance descending.

Rationale:

- long pieces are harder to place after the sheet has been fragmented;
- larger pieces are generally harder to place than smaller pieces;
- more imbalanced pieces are less flexible than square-ish pieces.

This ordering is part of the future algorithm and must not be implemented by the app shell.

## Shared Setup

For each candidate placement, compute the used cluster size after the move:

- `U'`: used cluster width after placing the candidate.
- `V'`: used cluster height after placing the candidate.
- `W`: sheet width.
- `H`: sheet height.

Compare candidates lexicographically: compare criterion 1 first; only if tied, compare criterion 2; only if tied, continue.
Smaller values are better.

## Prefix A: Balanced Compactness

```text
(
  U' * V',
  max(U' / W, V' / H),
  U' / W + V' / H,
  U' + V'
)
```

## 1. Used Cluster Area

```text
U' * V'
```

This keeps the placed pieces compact.
It measures the area of the bounding rectangle around the placed cluster, not the real area of the pieces and not the sheet area.

## 2. Worst Normalized Sheet Consumption

```text
max(U' / W, V' / H)
```

This avoids stretching the used cluster too aggressively in one sheet direction.
It asks which sheet direction is most consumed after this placement.

## 3. Normalized Perimeter-Like Criterion

```text
U' / W + V' / H
```

This is like a perimeter tie-breaker, but normalized by the sheet dimensions.
It treats growth in the tighter sheet dimension as more expensive.

## 4. Absolute Perimeter-Like Criterion

```text
U' + V'
```

This is the absolute perimeter tie-breaker, ignoring the constant factor `2`.
It is useful after the normalized perimeter-like criterion ties.

Keep this after the normalized version so rectangular sheets still respect their shape before absolute millimeter compactness decides.

## Prefix B: Fill Short Sheet Direction First

This is an alternative direction, not a replacement decision yet.

Use this when the intended behavior is to fill the short side of a rectangular sheet first, like an upright bottle filling upward before spreading sideways.

For each candidate, define:

```text
shortFill = if H <= W then V' / H else U' / W
longFill  = if H <= W then U' / W else V' / H
```

Meaning:

- if the sheet is wider than tall, the short direction is height, so `shortFill = V' / H`;
- if the sheet is taller than wide, the short direction is width, so `shortFill = U' / W`;
- `longFill` is the normalized consumption of the other direction.

Because the score tuple is smaller-is-better, prefer larger short-side fill by negating it:

```text
(
  U' * V',
  -shortFill,
  longFill,
  U' / W + V' / H,
  U' + V'
)
```

Interpretation:

1. Keep the used cluster area compact.
2. Among similar areas, prefer filling the sheet's short direction first.
3. Then avoid expanding too much along the long direction.
4. Then use normalized perimeter-like compactness.
5. Then use absolute perimeter-like compactness.

Open question:

- Should `-shortFill` be an exact criterion after area, or should it only apply when `U' * V'` is within a tolerance?

## Tail Criteria

The tail is experimental.
It decides how much weight local free-rectangle quality gets compared with bottom-left stability.

### Global Bottom Position

```text
y
```

This is the actual `y` coordinate of the candidate placement in the sheet.

Every candidate is placed at the bottom-left corner of its own free rectangle, but different free rectangles have different positions in the sheet.
This criterion chooses the lower placement among candidates that are otherwise tied by the global cluster criteria.

### Global Left Position

```text
x
```

This is the actual `x` coordinate of the candidate placement in the sheet.

It is used after `y`.
If two candidates are equally good and equally low, prefer the more-left one.

### Local Remaining Free-Rectangle Area

```text
r = FW * FH - w * h
```

Where:

- `FW`: width of the free rectangle used by the candidate.
- `FH`: height of the free rectangle used by the candidate.
- `w`: width of the placed piece.
- `h`: height of the placed piece.

This is a local-fit tie-breaker.
It measures how much area remains in the selected free rectangle after placing the piece.

It matters mostly when two candidates have the same global placement point:

- same `U' * V'`;
- same shape criteria;
- same global `y`;
- same global `x`;
- but they came from different overlapping MaxRects free-rectangle records.

In that case, prefer the candidate with lower `r`, because it uses the smaller adequate free rectangle and preserves larger clean free rectangles for later.

### Local Short-Side Leftover

```text
s = min(FW - w, FH - h)
```

This is a local-fit tie-breaker.
It measures the smaller leftover side inside the chosen free rectangle.

If two different free rectangles produce the same global placement, `s` helps choose the one where the piece fits more tightly along at least one side.

## Experimental Strategy Matrix

Try the two prefixes with four tail orders.
This gives eight candidate scoring strategies.
Use descriptive ids in code/config; do not use opaque ids like `A.1` or `B.4` as persistent identifiers.

```text
Tail 1 = r, s, y, x
Tail 2 = s, r, y, x
Tail 3 = y, x, s, r
Tail 4 = y, x, r, s
```

### Balanced Compactness Strategies

Balanced compactness prefix:

```text
balanced-preserve-free-then-bottom-left
  prefix: balanced compactness
  tail: r, s, y, x
  label: Balanced / preserve free space first

balanced-short-side-fit-then-bottom-left
  prefix: balanced compactness
  tail: s, r, y, x
  label: Balanced / short-side fit first

balanced-bottom-left-then-short-side-fit
  prefix: balanced compactness
  tail: y, x, s, r
  label: Balanced / bottom-left, then short-side fit

balanced-bottom-left-then-preserve-free
  prefix: balanced compactness
  tail: y, x, r, s
  label: Balanced / bottom-left, then preserve free space
```

### Short-Side-Fill Strategies

Short-side-fill prefix:

```text
short-fill-preserve-free-then-bottom-left
  prefix: fill short sheet direction first
  tail: r, s, y, x
  label: Short-fill / preserve free space first

short-fill-short-side-fit-then-bottom-left
  prefix: fill short sheet direction first
  tail: s, r, y, x
  label: Short-fill / short-side fit first

short-fill-bottom-left-then-short-side-fit
  prefix: fill short sheet direction first
  tail: y, x, s, r
  label: Short-fill / bottom-left, then short-side fit

short-fill-bottom-left-then-preserve-free
  prefix: fill short sheet direction first
  tail: y, x, r, s
  label: Short-fill / bottom-left, then preserve free space
```

Notes:

- Tail 1 gives local free-rectangle preservation the highest tail priority.
- Tail 2 gives classic short-side fit the highest tail priority.
- Tail 3 gives bottom-left stability priority, then classic short-side fit.
- Tail 4 gives bottom-left stability priority, then free-rectangle preservation.

## How To Read Tail Ordering

The prefix chooses the globally promising candidate first.
The tail decides what wins after the prefix is tied or effectively tied.

### `r, s` Before `y, x`

```text
r, s, y, x
```

Local free-rectangle quality beats bottom-left stability.

This can choose a placement that is higher or more to the right if it uses a better free rectangle.

Use this when preserving clean free space is more important than forcing a bottom-left-looking placement.

### `y, x` Before `r, s`

```text
y, x, r, s
```

Bottom-left stability beats local free-rectangle quality.

This can choose a lower/more-left placement even if another candidate would use a free rectangle more cleanly.

Use this when visual/layout stability toward the origin is more important than local free-space preservation.

### `r` Before `s`

```text
r, s
```

Remaining free-rectangle area is considered before short-side tightness.

This prefers using the smaller adequate free rectangle and preserving larger clean free rectangles for later.

Example intent:

```text
do not spend a huge free rectangle if a smaller one can host the piece
```

This is closer to a "preserve big free space" policy.

### `s` Before `r`

```text
s, r
```

Short-side tightness is considered before remaining area.

This prefers placements where the piece fits tightly along at least one dimension of the free rectangle, even if the total remaining area is larger.

Example intent:

```text
snap pieces into locally tight slots and avoid thin awkward gaps
```

This is closer to classic Best Short Side Fit behavior.

## Beam Search Working Model

Use beam search inside a single beam run after the initial piece order has
already been fixed.

Current working parameters:

```text
beamWidth = max(5, selectedStrategyCount * 2)
freeRectFanout = 2
orientations = normal, rotated when allowed
```

Meaning:

- `beamWidth` is the maximum number of partial layout states kept alive after
  each placed piece;
- `selectedStrategyCount` is the number of selected placement-order strategies;
- `freeRectFanout` is the number of top candidate placements retained for each
  current state, next piece, and placement-order strategy;
- rotation is not the beam width; it only doubles the candidate list when the
  piece can legally rotate.

For each current partial state and next piece `X`:

```text
generate legal candidate placements from all fitting free rectangles and allowed orientations
score/order candidates using the chosen strategy
keep the first freeRectFanout candidates
create one successor state for each kept candidate
```

With `freeRectFanout = 2`, each state produces at most two successors per
placement order. Candidate generation may inspect both orientations:

```text
(X,    fr1(X))
(X,    fr2(X))
(X_90, fr1(X_90))
(X_90, fr2(X_90))
```

Normal and rotated candidates compete in the same ordered candidate list,
because the candidate score depends on the placed dimensions and resulting
state.

At the end of the step:

```text
current states <= beamWidth
successors <= beamWidth * selectedStrategyCount * freeRectFanout
rank successor states with the chosen layout-selection metric
keep the best beamWidth successor states
```

The eight placement strategies are therefore candidate ordering rules for the
current state and next piece. The layout-selection metric decides which
successor states survive after all current states have been expanded.

The outer loop continues while at least one retained state still has
`remainingPieces`. A completed state has no remaining pieces and is carried
forward as a survivor candidate while the rest of the beam keeps expanding.

If a state has a next piece but no legal candidate placement in any selected
strategy, the algorithm still creates one successor: the piece is removed from
`remainingPieces` and appended to `unplacedPieces`. Therefore an empty next beam
is an internal invariant failure, not the normal loop termination signal.

## Layout Selection Ranking

This is separate from candidate scoring during placement.
The selected candidate strategies all feed one beam run; after each expansion,
the layout-selection metric compares successor states and keeps the best beam
members.

The same metric family can also compare complete layouts later if the app ever
needs to choose between multiple completed layouts, but the first model is one
beam run that selects its own best retained state.

Hard requirement:

```text
all pieces must be placed
```

If a strategy leaves any piece unplaced, that strategy is not a valid final result.
It should be treated as a failed run, not as a low-ranked partial success.

Current final-ranking ingredients:

```text
usedArea = U * V
largestFreeRectArea = max_j(FW_j * FH_j)
largestFreeRectShortSide = max_j(min(FW_j, FH_j))
```

Where:

- `U`: final used cluster width.
- `V`: final used cluster height.
- `U * V`: final used cluster area.
- `FW_j`: free rectangle `j` width.
- `FH_j`: free rectangle `j` height.
- `largestFreeRectArea`: area of the largest remaining clean free rectangle.
- `largestFreeRectShortSide`: short side of the best remaining free rectangle, useful to avoid preferring a very long thin strip.

Because final-score tuples use smaller-is-better ordering, use negative values for criteria where bigger is better:

```text
-largestFreeRectArea
-largestFreeRectShortSide
```

Confirmed so far:

1. All pieces placed is mandatory.
2. Smaller final used area matters.
3. Large/clean residual free space matters strongly.

## Layout Selection Modes

These compare layout states, not individual placement candidates.
They are used after candidate application to decide which beam states survive.

### Layout Mode 1: Compact First

```text
(
  U * V,
  -largestFreeRectArea,
  -largestFreeRectShortSide
)
```

Use this when the primary goal is the smallest occupied cluster.
Residual free space breaks ties or near-ties.

### Layout Mode 2: Largest Free Area First

```text
(
  -largestFreeRectArea,
  U * V,
  -largestFreeRectShortSide
)
```

Use this when preserving the largest clean remaining rectangle is more important than the absolute smallest used cluster.
Used area becomes the second criterion.

### Layout Mode 3: Widest Usable Free Rectangle First

```text
(
  -largestFreeRectShortSide,
  -largestFreeRectArea,
  U * V
)
```

Use this when the final remaining space must be practically usable, not just large.
This avoids choosing a long thin leftover strip over a more usable rectangular free area.

Open questions:

- Should these layout modes use strict lexicographic comparison or tolerance bands?
- Should the UI default to Compact First or Largest Free Area First?

## Future Branch-And-Bound Notes

Branch-and-bound is not a replacement for beam search.
It is an optional pruning layer inside the future algorithm.

The app implementer must not add this logic.

In this MaxRects setup, candidates should already respect the sheet dimensions:

```text
if a piece cannot fit inside any free rectangle,
there is no valid candidate placement
```

So pruning for `U > W` or `V > H` is mostly redundant with candidate generation.

Potential safe pruning metrics to consider later:

### Used Area Bound

If a complete incumbent layout already exists:

```text
partialUsedArea = U * V
bestCompleteUsedArea = incumbent U * incumbent V
```

Then:

```text
if partialUsedArea > bestCompleteUsedArea:
  prune this partial branch
```

Reason:

```text
adding more pieces can only keep or increase U and V
```

So `U * V` cannot improve later.

### Remaining Piece Fit Bound

For each remaining piece, check whether it can fit in at least one current free rectangle in at least one allowed orientation.

```text
if any remaining piece fits no current free rectangle:
  prune this partial branch
```

This can be useful, but should be implemented carefully because MaxRects free rectangles can overlap and are a candidate-space representation, not a disjoint decomposition.

### Remaining Area Bound

A tempting bound is:

```text
remainingPieceArea <= remainingFreeArea
```

But with MaxRects, do not sum all free-rectangle areas directly because free rectangles can overlap.
That double-counts space.

Only use a remaining-area bound if the free area is computed from a non-overlapping representation or by a conservative exact method.

### What To Avoid Initially

Avoid pruning based on:

- approximate free-space sums from overlapping MaxRects rectangles;
- "looks unlikely" heuristics;
- local candidate scores that are not monotonic;
- final residual-space quality unless a safe lower/upper bound is proven.

Keep the first version of branch-and-bound conservative.
Wrong pruning is worse than no pruning.

## Final Benchmark Questions

Use real jobs to compare beam/search freedom against runtime cost.

For each benchmark case, run several widths:

```text
beamWidth = 5
beamWidth = 8
beamWidth = max(5, selectedStrategyCount * 2)
beamWidth = 16
beamWidth = 32
```

Track final quality:

- How many pieces were placed?
- If all pieces were placed, which run has the smaller final used cluster area?
- Which run preserves the largest clean remaining free rectangle?
- Which run preserves the best remaining short side?

Track cost:

- How many candidates were generated?
- How long did the run take?
- How much history was emitted?
- Does increasing `beamWidth` improve quality enough to justify the extra time?

Track strategy dominance:

- After each step, how many selected placement strategies are still represented
  among the retained states?
- Does one strategy dominate the beam early and eliminate the others?
- Does keeping at least one survivor per strategy improve final quality?
- If a strategy rarely survives, is it genuinely weak or is the survivor
  pruning policy too aggressive?
