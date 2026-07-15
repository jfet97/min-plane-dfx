# Irregular Nesting Plan

## Purpose

`min-plane-dfx` currently nests parts as rectangles. That is simple and robust,
but it wastes material whenever the real part is not rectangular. A triangle,
trapezoid, angled profile, or approximated circle may occupy only part of its
bounding rectangle, but the current algorithm treats the whole rectangle as
blocked.

This plan describes the v2 target: a real shape-aware nesting engine for fixed
rectangular sheets. V2 is not a temporary prototype and not a stepping stone to
concave or hole-aware nesting. The final target is convex-only irregular nesting
with a complete optimizer portfolio.

The important shift is:

```text
v1: rectangles are the occupied geometry
v2: convex collision polygons are the occupied geometry
```

The source DXF geometry remains authoritative for display and export. The
nesting engine works on a derived conservative collision polygon that is easier
to reason about and validate.

## Executive Summary

V2 should use:

```text
DXF source geometry
  -> nesting-grade flattening
  -> convex hull
  -> padded convex collision polygon
  -> finite rotation/mirror transforms
  -> NFP/IFP candidate generation
  -> windowed beam decoder
  -> GA/search portfolio
  -> final validation
  -> render/export original geometry with stored transforms
```

Core decisions:

- The sheet is a fixed rectangle, not an infinite strip.
- Collision geometry is convex-only.
- Concave source DXF is preserved for display/export, but its convex hull is the
  conservative collision shape.
- Placement legality is based on NFP/IFP candidate generation plus direct
  validation, not on accepting a free-space polygon as proof.
- `freeMaterial = sheet - union(placed collision polygons)` is still useful for
  visualization and scoring.
- Clipper2 is allowed behind a geometry adapter for offsetting, cleanup, and
  sheet-space polygon booleans, but it is not the definition of the whole
  algorithm.
- GA is part of v2. It explores priority order, transform choices, and placement
  policy. The decoder remains shared and deterministic for a given chromosome.
- Beam expansion is windowed by `orderWindow`, usually `2` or `3`, not full
  free-order over all remaining pieces.
- Mirroring is per-piece via `allowMirror`, default enabled and user-disableable.

## How To Read This Plan

This document has two audiences:

- a human reader who wants to understand the algorithmic direction;
- an implementer who needs concrete boundaries, data shapes, and acceptance
  criteria.

The first half explains the model: what the geometry means, how placements are
generated, how beam search and GA cooperate, and why some tempting shortcuts are
unsafe. The second half turns that model into workstreams.

The important mental split is:

```text
geometry answers: "is this placement legal?"
search answers:   "which legal placement should we try?"
scoring answers:  "which partial or complete layout is better?"
```

Keeping those questions separate makes the implementation easier to debug. A
bug in candidate generation should not be fixed by faking a score. A weak score
should not be fixed by accepting illegal geometry. A UI preview should not
invent placements that the worker did not emit.

## Running Example

Imagine two right triangles on a rectangular sheet.

With the current rectangle engine, each triangle blocks its whole bounding
rectangle. Two opposite triangles that could share one rectangle-like area are
treated as two full rectangles, so the engine wastes the empty triangular voids.

With v2:

1. Each triangle becomes a convex collision polygon.
2. The moving triangle is allowed to rotate and possibly mirror.
3. NFP boundaries produce candidate positions where the moving triangle touches
   the placed triangle without overlap.
4. The decoder tests those contact points.
5. The optimizer prefers the placement that keeps the used extents compact and
   preserves useful remaining material.

This same idea applies to trapezoids, angled profiles, hexagons, circles
approximated by polygons, and mixed jobs.

## Scale Target

The expected job size is tens of pieces. V2 should remain practical around
100-150 pieces and keep a hard input cap around the current 200-piece range.

This target drives the caps:

- finite transform sets per piece;
- small `orderWindow`;
- bounded beam width;
- top-N candidate pruning;
- cached transformed polygons and NFPs;
- bounded GA population and wall-clock budget;
- cheap free-material metrics by default.

Full free-order search, uncapped rotations, exhaustive scoring, and expensive
probe-heavy future-usability metrics are for tiny fixtures, debug modes, or
offline benchmarks.

## Main Concepts

### Cut Polygon

The true part outline used for display and export. For DXF curves, this may be
the original DXF entity data or a high-quality flattened export representation.

The cut polygon is not what the optimizer mutates.

Think of this as the customer's part. It is the shape that should appear in the
preview and the shape that should be exported to downstream cutting workflows.
If the optimizer simplifies or inflates geometry internally, that must not
replace the source geometry.

### Collision Polygon

A conservative convex polygon derived from the source geometry and expanded by
clearance. This is the geometry used by the nesting engine for overlap checks,
NFP generation, candidate validity, and final validation.

For v2:

```text
source shape -> sampled points -> convex hull -> padded collision polygon
```

If the source part is concave, the convex collision polygon covers the concavity.
That loses some possible packing efficiency, but it keeps v2 robust and
tractable.

This polygon is deliberately conservative. If the collision polygons do not
overlap, then the real parts should have the requested clearance, assuming the
flattening and safety-margin rules are respected. The optimizer is allowed to be
conservative; it is not allowed to create a layout that violates physical
clearance.

### Placement Point

The single coordinate used to say where a part is placed. The convention should
be deterministic and shared across the engine:

```text
referencePoint = bbox minimum corner of the local collision polygon
```

After normalization:

```text
placedPolygon = translate(localCollisionPolygon, placementPoint)
```

The placement point is not a physical feature of the part. It is an API
convention. Changing the convention shifts coordinates and NFPs, but it does not
change which physical placements overlap.

### Transform

A placement stores a transform, not rewritten geometry:

```ts
interface IrregularPlacement {
  sourcePieceId: PieceId
  transform: {
    translateX: number
    translateY: number
    rotationDeg: number
    mirrored: boolean
  }
}
```

Rendering and export apply that transform to the original DXF geometry or to a
high-quality flattened representation.

### No-Fit Polygon

For a fixed placed polygon `A` and a moving polygon `B`, the no-fit polygon
describes where `B`'s placement point would make `B` touch or overlap `A`.

Using one placement-point convention:

```text
point inside NFP boundary  -> B overlaps A
point on NFP boundary      -> B touches A
point outside NFP          -> B is separated from A
```

The useful part for nesting is usually the boundary. Good compact placements
often happen when the moving piece touches another piece or touches the sheet
boundary.

The NFP is easiest to understand as "forbidden placement coordinates". It is not
drawn on the sheet where the part physically lies. It is drawn in placement
coordinate space: every point represents one possible location of the moving
piece's reference point.

That distinction matters. A shape on the sheet and its NFP are not the same
kind of polygon. The sheet shape lives in material space. The NFP lives in
"where could the next placement point go?" space.

### Inner-Fit Polygon

The inner-fit polygon describes where the moving polygon's placement point can
go while keeping the whole polygon inside the sheet.

Because v2 uses fixed rectangular sheets and convex collision polygons, the IFP
for runtime placement can be represented as a rectangular placement interval:

```text
ifpBounds = [0, sheetWidth - movingBBoxWidth]
          x [0, sheetHeight - movingBBoxHeight]
```

For a rectangular sheet, the IFP is simple because the moving convex polygon is
normalized to a local bounding box. If the placement point goes outside this
rectangle, some part of the moving collision polygon would leave the sheet.

### Free Material Polygon

This is a sheet-space artifact:

```text
freeMaterial = sheet rectangle - union(placed collision polygons)
```

It answers: "what material on the sheet is not occupied by placed collision
geometry?"

It is useful for visualization and scoring. It is not the placement legality
model, because legality is piece-specific.

Example: a long thin rectangle and a compact triangle can see the same leftover
material very differently. The material polygon can say "there is empty sheet
area here", but only the moving piece's IFP/NFP test can say whether that exact
piece can be translated there without overlap.

### Geometry Adapter

The geometry adapter is the project-owned boundary around geometric operations.
The worker should depend on the adapter, not on Clipper2 or any specific library
shape directly.

The adapter owns:

- flattening outputs used for collision geometry;
- convex hull;
- convex offset;
- rotation and mirroring;
- convex NFP;
- point classification;
- overlap/containment validation;
- optional `freeMaterial` polygon construction.

The adapter may use direct TypeScript geometry, Clipper2, robust predicates, or a
combination. The important rule is that library choices stay behind the adapter.

### Beam Search

Beam search keeps several partial layouts alive instead of committing to one
greedy path.

At each step:

1. Expand each retained state into possible next states.
2. Score the successors.
3. Keep the best `K` states.
4. Repeat until all pieces are placed or rejected.

In v2, beam expansion is priority-bounded. It tries only the next
`orderWindow` eligible pieces from the active priority order, not every
remaining piece.

Plainly: beam search is a controlled "keep a few good alternatives" strategy.
It is useful when the best immediate-looking move is not actually best later.
Instead of choosing only one move, the worker keeps the top few partial layouts
and lets later pieces decide which branch was better.

### Genetic Algorithm

A genetic algorithm is a search method that keeps a population of candidate
solutions. Each candidate has a "chromosome", which is just a compact encoding
of the choices the optimizer wants to explore.

For v2, a chromosome is:

```text
piece priority order
transform index per piece
placement policy id
```

The GA does not store raw `(x, y)` coordinates. It asks the shared decoder to
turn the chromosome into a real layout, then scores the validated result.

Common GA operations:

- seed: create the first population from sensible orders and transforms;
- mutate: make a small random change, such as swapping two pieces;
- crossover: combine two parent priority orders;
- fitness: score a decoded layout;
- elitism: keep the best validated candidates so they are not lost.

SVGNest and Deepnest use the same broad model: global search explores insertion
order and rotations, while a placement decoder builds the actual layout.
`min-plane-dfx` extends that model with per-piece mirroring and a windowed beam
decoder.

The GA is useful because the order of insertion matters. If a difficult large
piece is left until the end, no amount of clever local placement may recover the
layout. The GA tries many priority orders and transform choices, but every
candidate still goes through the same deterministic decoder and final validator.

### How GA And Beam Work Together

GA and beam search solve different parts of the problem.

The GA is the outer search. It asks broad questions:

- Which piece priority order should we try?
- Which rotation/mirror transform should each piece prefer?
- Which placement policy should score local choices?

Those choices are high-level. A GA chromosome does not say "put piece A at
`x = 120`, `y = 40`". It says something closer to:

```text
try these pieces in this priority order
use these transform choices
rank legal placements with this policy
```

The beam decoder is the inner constructive search. Given one GA chromosome, it
actually builds a layout. It walks through the priority order, generates legal
NFP/IFP contact candidates, scores them, and keeps the best few partial layouts.

The division is:

```text
GA:
  explores global strategy across many possible layouts

windowed beam decoder:
  turns one global strategy into a concrete validated layout
```

The `orderWindow` is the bridge between them. With `orderWindow = 1`, the beam
must follow the GA priority order strictly. With `orderWindow = 2` or `3`, the
beam may choose among the next few eligible pieces when that gives a better
local fit. This gives the decoder a small amount of local repair without making
the GA order meaningless.

That means the GA order is a priority order, not a rigid script. The GA still
controls the broad sequence, while beam search handles local placement details:

```text
chromosome priority order:
  [large triangle, long profile, trapezoid, small part, ...]

orderWindow = 2:
  at each step, beam may choose between the next two eligible pieces
```

Full free-order beam search would let the decoder pick any remaining piece at
each step. That is intentionally not the normal model because it explodes the
branching factor and weakens the GA chromosome: if the decoder can ignore most
of the proposed order, the GA is no longer learning a meaningful ordering.

So the intended v2 relationship is:

1. Deterministic beam can run from the normal sorted order.
2. GA creates many alternative priority orders and transform choices.
3. Each GA candidate is decoded by the same windowed beam kernel.
4. The portfolio compares the validated deterministic beam result and the best
   validated GA result using the same score.
5. The best validated layout wins.

## References

This plan is aligned with irregular nesting literature and open-source nesting
tools, but it is not a direct implementation of one paper.

Useful anchors:

- Lastra-Diaz and Ortuno, "A new mixed-integer programming model for irregular
  strip packing based on vertical slices with a reproducible survey",
  arXiv:2206.00032, 2022.
  https://arxiv.org/abs/2206.00032
- Rocha, "Robust NFP generation for Nesting problems", arXiv:1903.11139, 2019.
  https://arxiv.org/abs/1903.11139
- Yang et al., "Learning based 2D Irregular Shape Packing",
  arXiv:2309.10329, 2023.
  https://arxiv.org/abs/2309.10329
- Clipper2 documentation, for practical polygon clipping and offsetting.
  https://www.angusj.com/clipper2/Docs/Overview.htm
- SVGNest and Deepnest, for the practical split between placement geometry and
  GA order/rotation optimization.
  https://github.com/Jack000/SVGnest
  https://github.com/Jack000/Deepnest

The exact MIP direction is useful academic context, but it is not the v2
implementation path.

## End-To-End Pipeline

### 1. Import And Preserve Source Geometry

The app keeps the source DXF geometry for display, traceability, and export.
The optimizer receives a derived collision artifact.

```text
DXF source
  -> preserved source entities
  -> preview/display summaries
  -> collision-geometry flattening
```

Preview/bounds summaries are not nesting-grade geometry. V2 needs a dedicated
flattening path for collision geometry.

Required flattening behavior:

- lines and ordinary polyline segments contribute endpoints;
- LWPOLYLINE bulges are sampled as arcs, not straight lines;
- arcs, circles, and ellipses are sampled to respect `flatteningSagTolerance`;
- ellipses are polygonalized from their real ellipse parameters, not from
  bounding-box lines;
- unresolved geometry is reported, not silently repaired or dropped.

Examples of unresolved or non-nestable DXF data:

- text;
- dimensions;
- construction helpers;
- blocks that cannot be expanded safely;
- open contours;
- ambiguous contour groups.

### 2. Build Collision Geometry

For every nestable source shape:

```text
sampled points
  -> deduplicate and clean
  -> convex hull
  -> offset by padding / 2 + clearanceSafetyMargin
  -> normalize collision polygon placement reference
  -> collision polygon
```

The same source DXF, flattening tolerance, padding, and import settings must
produce the same sampled points, hull, and collision polygon.

Debug views should expose:

- source DXF;
- sampled points;
- convex hull;
- padded collision polygon;
- warnings and unresolved geometry.

Pseudocode:

```text
function buildCollisionGeometry(sourceShape, settings):
  samples = flattenSourceShape(sourceShape, settings.flatteningTolerance)
  samples = deduplicateAndClean(samples)

  if samples cannot describe a nestable closed shape:
    return warning("unresolved geometry")

  hull = convexHull(samples)
  hullNearOrigin = translate(hull, -bboxMin(hull))

  margin = settings.clearanceSafetyMargin
  offset = settings.padding / 2 + margin

  paddedCollision = offsetConvexPolygon(hullNearOrigin, offset)
  collisionOrigin = bboxMin(paddedCollision)
  localHull = translate(hullNearOrigin, -collisionOrigin)
  collision = translate(paddedCollision, -collisionOrigin)

  return {
    sourcePieceId,
    sampledPoints: samples,
    convexHull: localHull,
    collisionPolygon: collision,
    diagnostics
  }
```

The key invariant is that this step is deterministic. Re-importing the same DXF
with the same settings should not produce a different hull or offset polygon.

### 3. Generate Transform Choices

V2 should not search arbitrary continuous rotations. It should generate a strong
finite transform set per piece.

Baseline rotations:

```text
0, 90, 180, 270
```

Additional useful rotations:

- long edge alignment angles;
- oriented-bounding-box or principal-axis angles;
- configured machine-safe angles.

Filtering rules:

- ignore very short noisy edges;
- deduplicate near-equal angles;
- cap transforms per piece;
- include mirror variants only when `allowMirror = true`.

Mirroring:

- per-piece `allowMirror`;
- default enabled;
- user-disableable for handed, front-faced, grain-sensitive, engraved, or
  otherwise orientation-sensitive parts;
- mirror state is stored in final transforms and cache keys.

### 4. Generate Candidate Placement Points

For one state, one moving piece, and one transform:

```text
placed = already placed collision polygons
moving = transformed collision polygon

ifpBounds = rectangular placement interval where moving fits in sheet
nfpBoundaries = convex NFP boundary for each placed polygon vs moving
candidatePoints = vertices/intersections/contact points from NFP and IFP bounds
```

Candidate sources:

- IFP rectangle corners;
- IFP edge contacts;
- NFP vertices;
- intersections between NFP boundaries;
- intersections between NFP and IFP bounds;
- bottom-left-like points;
- low-y / low-x contact points;
- optional local fallback around best points.

Candidate filtering:

```text
accept point if:
  point inside rectangular IFP bounds
  and point not strictly inside any convex NFP
  and translated moving polygon is inside sheet
  and translated moving polygon does not overlap placed polygons
```

The NFP is a candidate generator and feasibility map. It is not the final
authority. Final validation remains mandatory.

Pseudocode:

```text
function generateLegalPlacements(state, piece, transform):
  moving = transformedCollisionPolygon(piece, transform)
  ifpBounds = rectangularIfpBounds(state.sheet, moving)

  rawPoints = cornersAndEdges(ifpBounds)

  for each placed in state.placed:
    nfp = getOrComputeNfp(placed.collisionPolygon, moving)
    rawPoints += vertices(nfp)
    rawPoints += intersections(nfp, ifpBounds)
    rawPoints += intersections(nfp, previousNfps)

  points = dedupe(rawPoints)

  legal = []
  for point in points:
    if point outside ifpBounds:
      continue
    if point strictly inside any NFP:
      continue

    candidate = translate(moving, point)
    if validateLocalPlacement(candidate, state.placed, state.sheet):
      legal.push({ point, transform, diagnostics })

  return legal
```

This avoids a dense grid. The engine looks at geometrically meaningful points:
touching another piece, touching the sheet boundary, or sitting at intersections
of those boundaries.

### 5. Decode A Layout

The shared decoder turns an order and transform choices into a concrete layout.

```text
decode(priorityOrder, transforms, placementPolicy, orderWindow, geometryCache)
  -> layoutResult
```

Inputs:

- priority-ordered piece ids;
- allowed transforms per piece for the strict baseline decoder, or later
  transform choices supplied by a GA chromosome;
- placement policy id;
- `orderWindow`;
- geometry cache.

Output:

- placed transforms;
- unplaced pieces;
- score and diagnostics;
- validation result.

The decoder is shared by deterministic beam and GA. Neither optimizer is allowed
to invent placements outside this kernel.

The initial strict decoder evaluates every allowed transform and lets the local
placement policy choose among the legal results. This is a baseline before GA
exists, not an implicit GA transform-gene rule. When the GA receives a transform
gene, its contract must explicitly choose one behavior: either force that
transform and allow a normal no-fit result, or prefer it and define the ordered
fallback transforms. The worker must not silently ignore a GA transform choice.

## Placement Legality

Every accepted placement must pass the same legality gate:

```text
for every placed pair:
  collision polygons do not positively overlap
  real/cut geometry clearance is >= padding - accepted tolerance

for every placed piece:
  collision polygon is inside the sheet
```

Touching is allowed when the configured clearance is satisfied. Positive overlap
is forbidden.

Degenerate cases need deterministic rules:

- boundary points classify consistently;
- duplicate candidates deduplicate deterministically;
- equal scores use stable tie-breakers such as `y`, `x`, transform, and piece id;
- rounding is only for controlled boundaries such as display, cache keys, or
  export precision.

## Padding And Clearance

Current rectangle preparation treats padding as total clearance split across
sides:

```text
sidePadding = ceil(padding / 2)
```

V2 keeps the same meaning with real geometry:

```text
clearance = padding
collisionOffset = padding / 2 + clearanceSafetyMargin
collisionPolygon = offset(cutPolygon, collisionOffset)
```

`clearanceSafetyMargin` is not a random floating-point epsilon. It is a physical
margin used to preserve clearance after curves are flattened into segments.

If flattening can approximate the true curve inward by at most
`flatteningSagTolerance`, then:

```text
clearanceSafetyMargin >= flatteningSagTolerance
```

Alternatively, the flattening step may produce a conservative outward
approximation, but the margin/tolerance relationship must be explicit and owned
by the geometry adapter.

For the sheet border, the collision polygon must be inside the sheet. This is
equivalent to an internal border of:

```text
padding / 2 + clearanceSafetyMargin
```

## Geometry Robustness

The engine should use real-valued coordinates for:

- flattened cut geometry;
- convex collision polygons;
- transformed candidates;
- final transforms.

Do not force the core legality model onto an integer grid. Correctness should
come from robust geometric decisions.

Low-level geometry decisions should use robust predicates where appropriate:

- orientation tests;
- segment intersection;
- point-in-convex-polygon classification;
- convex polygon overlap or separation tests.

Clipper2 can be used behind the adapter for:

- offsetting;
- cleaning/simplifying polygon operation results;
- constructing `freeMaterial`;
- differential checks.

Do not make Clipper2 boolean construction of `IFP - union(NFP)` the normal
placement legality model.

The difference is important:

```text
sheet-space boolean:
  freeMaterial = sheet - union(placed collision polygons)
  useful for visualization and scoring

placement-space boolean:
  feasible = IFP - union(NFPs)
  not required as the normal legality model
```

Both use polygon language, but they answer different questions. The first says
what material remains. The second tries to describe every legal coordinate for a
specific moving piece. V2 may use Clipper2 for the first without making the
second the core algorithm.

### Initial Clipper2 Adapter Policy

This is the starting adapter configuration for collision-polygon offsetting. It
is configurable and must be validated against the geometry fixture corpus before
it becomes a production default; it does not change the real-valued core model
or make Clipper2 the legality authority.

```text
backend package = clipper2-ts@2.0.1-18
adapter path mode = integer Paths64 via inflatePaths
decimal precision = 3
scale = 1000 integer units per mm
grid step = 0.001 mm
rounding = nearest grid point, ties away from zero
conservative offset allowance = 0.002 mm
join type = Miter
miter limit = 2.0
end type = Polygon
future round-join arc tolerance = 0.01 mm
fill rule = NonZero
winding = normalize one outer collision ring counter-clockwise in Cartesian coordinates
max scaled coordinate, including 2 * offset = 1,000,000,000
adapter policy version = clipper2-offset-v2
```

The adapter converts real-valued coordinates at this one boundary only:

```text
toGrid(valueMm) = sign(valueMm) * floor(abs(valueMm) * 1000 + 0.5)
fromGrid(value) = value / 1000
```

Convert the collision hull with `toGrid`. Before converting the positive collision
offset, add the fixed `0.002 mm` conservative allowance, then call the
integer-path offset API and dequantize with `fromGrid` without a second rounding
pass. This avoids depending on library-internal floating-path conversion rules
and keeps the quantization convention deterministic for cache identity.

`0.001 mm` is 250 times finer than the starting `0.25 mm` flattening sag and
safety-margin scale. Nearest rounding moves one source point by at most
`sqrt(2) * 0.0005 mm`, while the requested offset can round down by at most
`0.0005 mm`. The fixed `0.002 mm` allowance exceeds their combined error, so a
quantized Clipper result cannot shrink the requested collision envelope. Miter
joins preserve the straight edges of convex collision hulls; the `2.0` limit
prevents unbounded acute-angle spikes. The round-join tolerance is inactive for
the initial Miter policy, but `0.01 mm` is reserved for any future Round policy
so its approximation stays well below the `0.25 mm` flattening tolerance.

Before calling Clipper, normalize the single convex collision ring to
counter-clockwise Cartesian winding and use `NonZero` for any adapter-owned
boolean operation. The collision model has no holes. Reject the operation with a
reported unresolved/non-nestable geometry diagnostic when the input or result is
non-finite, has fewer than three unique non-collinear points, has zero area, is
not a single simple convex closed ring, or produces zero or multiple paths. Do
not choose a largest component or silently repair such a result.

The coordinate guard applies after quantization and before the call: every
coordinate plus twice the absolute scaled offset must remain at most
`1,000,000,000` in magnitude. At the initial scale, this leaves up to
`1,000,000 mm` of coordinate range before offset headroom, far below the
JavaScript safe-integer limit while comfortably exceeding expected fixed-sheet
geometry.

The derived collision-geometry cache identity includes the canonical source
geometry digest, import and flattening settings, `flatteningSagTolerance`,
padding, `clearanceSafetyMargin`, placement reference convention, backend package
and version, and this full adapter policy tuple. Transformed-polygon cache
entries also include rotation and mirror state; pairwise NFP and IFP entries
additionally include their algorithm version. Any change to the package version,
policy version, scale, rounding, join, miter limit, round tolerance, fill/winding
rule, coordinate guard, or output-failure policy invalidates the relevant derived
cache.

Direct robust-predicate containment, overlap, and clearance validation remains
the placement-legality authority. Clipper output is a conservative derived
artifact and candidate aid, never proof that a placement is legal.

### Future Enhancement: Convex Round Joins

V2 remains convex-only; concave shapes and holes are not planned. The initial
convex offset uses mitered corners because extending the two shifted edge lines
to their intersection is simple and conservative, although acute angles can
produce long spikes.

A future round-join mode may connect the two shifted-edge endpoints with a
circular arc centered on the original convex vertex and with radius equal to the
collision offset. That is the exact Euclidean set of points within the offset
distance of the original vertex. For example, at a right angle with offset `d`,
the round arc contains `(-0.707d, -0.707d)`, exactly `d` from the vertex.

`IrregularPolygon` stores points, so the round arc must be sampled into a
deterministic polyline with an explicit sag tolerance. For an already validated
convex hull, this is moderate direct TypeScript work: use robust predicates to
preserve winding and reject invalid corners, then sample the outward arc. It does
not require Clipper2. Clipper2 remains useful later for configurable joins,
operation-result cleanup, and sheet-space boolean operations.

Do not use a bevel join for collision geometry without additional compensation:
the straight chamfer between shifted-edge endpoints cuts inside the round
distance envelope at a convex vertex and can reduce the promised clearance.

## Free Material For Scoring And Debug

V2 should maintain a derived sheet-space artifact when useful:

```text
freeMaterial = sheet rectangle - union(placed collision polygons)
```

This is useful for:

- rendering remaining material;
- utilization display;
- connected-component metrics;
- cavity and sliver penalties;
- largest empty rectangle or rectangle-proxy scoring;
- future-usability scoring;
- explaining why a compact-looking placement left poor remaining material.

`freeMaterial` must not replace per-moving-piece NFP/IFP candidate generation.
A rectangle proxy derived from `freeMaterial` can help score a state, but it
must never prove that a placement is legal or impossible.

## Search Architecture

### Deterministic Windowed Beam

Beam search keeps multiple partial layouts alive.

V2 uses a priority-bounded beam:

```text
for each beam state:
  candidatePieces = next orderWindow eligible pieces from priorityOrder

  for each candidatePiece:
    for each legal transform:
      points = generateCandidatePoints(state, candidatePiece, transform)
      for each point:
        if placement is legal:
          successor = state + placement
          score successor

keep best K successors
```

`orderWindow` controls local reordering:

- `1`: strict priority-order decoding, closest to SVGNest/Deepnest;
- `2` or `3`: default v2 range, allowing bounded local repair;
- all remaining pieces: debug or tiny benchmark only.

This avoids the explosion:

```text
all remaining pieces * all transforms * all candidate points
```

while still letting the beam recover from small ordering mistakes.

More detailed pseudocode:

```text
function runWindowedBeam(priorityOrder, transformChoices, policy):
  beam = [emptyState(priorityOrder)]

  while beam has unfinished states:
    successors = []

    for state in beam:
      candidates = nextEligiblePieces(state.remaining, priorityOrder, orderWindow)

      for piece in candidates:
        for transform in legalTransforms(piece, transformChoices):
          placements = generateLegalPlacements(state, piece, transform)

          for placement in topPlacements(placements, policy):
            successors.push(applyPlacement(state, piece, placement))

      if state produced no successor:
        successors.push(markNextBlockedPieceUnplaced(state))

    beam = bestK(dedupe(successors), beamWidth)

  return bestCompleteOrPartialState(beam)
```

The beam does not invent an order from scratch. It receives a priority order,
then allows bounded local lookahead. With `orderWindow = 1`, the decoder places
pieces strictly in priority order. With `orderWindow = 2` or `3`, it can choose
between the next few pieces when that clearly creates a better partial layout.

### GA/Search Portfolio

The GA explores global choices:

```text
chromosome =
  piece priority order
  transform index per piece
  placement policy id
```

Fitness evaluation:

```text
layout = decode(chromosome.priorityOrder,
                chromosome.transforms,
                chromosome.policy,
                orderWindow,
                geometryCache)

fitness = score(validated layout)
```

The transform index is a future GA decision, not a behavior already provided by
the strict baseline decoder. Before GA implementation, define whether that index
is forced or preferred with an explicit fallback order.

The GA must not encode raw placement coordinates. Legal placement remains inside
the shared decoder.

One generation looks like this:

```text
function evaluateGeneration(population):
  scored = []

  for chromosome in population:
    layout = decode(
      chromosome.priorityOrder,
      chromosome.transforms,
      chromosome.placementPolicy,
      orderWindow,
      geometryCache
    )

    if layout.validated:
      scored.push({ chromosome, score(layout), layout })

  elite = best(scored)
  parents = selectParents(scored)
  children = crossoverAndMutate(parents)

  return nextPopulation(elite, children)
```

The GA explores "what should the decoder try?", not "where should every part be
placed?". That keeps all physical validity inside one shared placement kernel.

Recommended initial population:

- current `sortPiecesForNesting` order;
- first-fit-decreasing by convex hull area, longest edge, height, width, and
  imbalance;
- priority orders that put awkward or high-vertex pieces first;
- random swaps/inversions from those seeds.

Recommended mutations:

- swap two pieces;
- move one piece earlier or later;
- reverse a short subsequence;
- change one piece's transform;
- change placement policy.

Recommended crossover:

- order-preserving crossover for the priority order;
- per-piece transform inherited from either parent, then occasionally mutated.

### GA Budget And Reproducibility

GA/search uses an app-owned seeded deterministic PRNG. It must never depend on
ambient `Math.random()`.

Given the same inputs, settings, seed, algorithm version, and evaluation cap, it
must produce the same chromosome sequence and scores.

Wall-clock time is the user-facing budget, but it is not an exact cross-machine
replay guarantee. Track generation and completed evaluation counts so runs can
be explained and replayed with an evaluation-count cap when needed.

Budget checks happen at deterministic scheduling checkpoints:

- before starting a new chromosome evaluation;
- after a completed layout has passed final validation.

Only fully validated layouts can become best-so-far. Partial or in-flight
layouts are never published as results.

Terminal statuses:

- `completed`;
- `budget-expired`;
- `cancelled`;
- `no-valid-result`.

The final portfolio result is the better validated layout between deterministic
windowed beam and GA/search according to the shared score.

Progress should report:

- generation;
- completed evaluations;
- population size;
- current best score;
- best source;
- elapsed time;
- remaining budget;
- current phase.

## Scoring

Scoring should remain lexicographic and conservative. Earlier tuple entries are
more important than later entries.

Recommended score family:

```text
(
  unplaced_count,
  sheets_used_or_partial_failure,
  -future_usability_score,
  material_fragmentation_score,
  used_cluster_area_or_width,
  max_used_sheet_ratio,
  normalized_used_span_sum,
  contact_bonus_as_negative,
  bottom_left_tie_breakers
)
```

Plain-English meaning:

- place more pieces before optimizing fine details;
- prefer fewer sheets or less partial failure;
- preserve usable remaining material;
- avoid tiny cavities and long slivers;
- keep the used extents compact;
- prefer contact without overlap;
- use bottom-left tie-breakers for stability.

`future_usability_score` is not exact feasible area for every future piece. It
is derived from `freeMaterial` and cheap proxies such as:

- largest component area;
- component count;
- sliver/cavity penalties;
- largest-empty-rectangle estimate;
- limited probes against representative remaining pieces.

How to read the tuple:

- `unplaced_count`: the first priority is placing parts. A layout with fewer
  unplaced pieces beats a prettier layout that leaves more work behind.
- `sheets_used_or_partial_failure`: once placed count ties, avoid opening extra
  sheets or producing worse partial outcomes.
- `-future_usability_score`: the negative sign means a larger usability score is
  better, while the tuple still sorts smaller values first.
- `material_fragmentation_score`: penalizes many disconnected scraps, tiny
  cavities, and long thin regions that look like area but are hard to use.
- `used_cluster_area_or_width`: keeps the placed group compact.
- `max_used_sheet_ratio`: avoids consuming too much of one sheet dimension too
  early.
- `normalized_used_span_sum`: prefers balanced use of the sheet dimensions.
- `contact_bonus_as_negative`: rewards stable touching placements without
  allowing overlap.
- `bottom_left_tie_breakers`: gives deterministic, visually stable choices when
  higher-level scores tie.

The exact formulas can evolve through benchmarks, but the ordering matters. The
score should never reward a visually compact placement if it creates invalid
geometry or strands obvious future material.

## Cache Identity

Derived geometry is correctness-sensitive. Cache keys must include every input
that can change validity:

```text
piece geometry digest
rotation angle
mirror state
clearance / padding / clearanceSafetyMargin
flattening tolerance
placement reference convention
geometry backend name and version/config
NFP/IFP algorithm version
```

Pairwise NFP keys include both pieces, both rotations, and both mirror states.
IFP keys include the sheet geometry plus the moving piece rotation and mirror
state.

Cacheable artifacts:

- transformed collision polygons;
- pairwise outer NFPs;
- sheet/piece IFP bounds;
- bounding boxes;
- broad-phase data;
- point-classification acceleration data;
- optional debug `freeMaterial` or forbidden-region artifacts.

## Current App Contracts To Preserve

The worker remains the owner of computation. Infrastructure may prepare
requests, validate payloads, persist history, render results, and replay worker
output. It must not fabricate placements, fake scores, fake history, or fake
strategy output.

CSV and multi-plate/manual-subrun behavior already exists in the rectangle
workflow. V2 must preserve those contracts while changing placement geometry
from rectangles to transforms over source pieces:

- subruns remain independent worker requests;
- irregular placements are stored as transforms;
- CSV row links survive through prepared polygon pieces;
- CSV export maps placements back to source rows;
- replay/history files remain durable under `userData`;
- saved projects reload irregular geometry and histories.

## Option A: NFP Clustering Then Rectangles

This is not the recommended architecture. It is a possible experiment.

Pipeline:

```text
input pieces
  -> derive collision polygons
  -> create local clusters using NFP contacts
  -> represent each cluster by a rectangle
  -> pack cluster rectangles with MaxRects
  -> expand cluster placements back to real transforms
```

Advantages:

- smaller change;
- can improve repeated triangles/trapezoids;
- useful testbed for polygon operations.

Disadvantages:

- still treats rectangles as the final packing truth;
- cluster choice can consume pieces badly;
- misses global irregular placements;
- becomes a detour if we still need the real optimizer.

Clustering should remain optional and non-v2-critical.

## Option B: Direct NFP-Based Irregular Nesting

This is the recommended v2 direction.

Pipeline:

```text
input pieces
  -> derive collision polygons
  -> generate finite transforms
  -> generate candidates via IFP/NFP
  -> decode through windowed beam
  -> optimize with GA/search portfolio
  -> validate
  -> render/export original geometry with transforms
```

Advantages:

- removes bounding rectangles as the occupancy model;
- handles unknown DXF geometry through one derived collision model;
- aligns with irregular nesting literature;
- keeps legality, scoring, rendering, and export concepts separate.

Disadvantages:

- larger implementation;
- geometry robustness matters;
- scoring is harder than MaxRects;
- debug overlays need to show more internal state.

## V2 Delivery Workstreams

### Geometry Kernel

Goal: produce deterministic, inspectable convex collision geometry.

Tasks:

- flatten supported DXF entities at a configurable tolerance;
- sample LWPOLYLINE bulges correctly;
- polygonalize ellipses correctly;
- keep preview/bounds summaries separate from collision flattening;
- compute convex hulls with robust predicates;
- normalize placement reference;
- offset by `padding / 2 + clearanceSafetyMargin`;
- compute area and bounding box;
- validate containment and pairwise overlap;
- expose Clipper2 behind the adapter where useful;
- define deterministic touching, boundary, duplicate, and tie rules.

Acceptance:

- triangles, trapezoids, rectangles, stars, circles, arcs, and ellipses produce
  inspectable collision geometry;
- intentional clearance violations fail validation;
- repeated runs produce the same geometry.

### Transform Generator

Goal: generate bounded rotation and mirror choices.

Tasks:

- include baseline orthogonal rotations when allowed;
- carry per-piece `allowMirror`, defaulting to true but user-disableable;
- compute long-edge and oriented-bounding-box angles;
- deduplicate near-equal angles;
- cap transform count per piece;
- cache transformed polygons by geometry digest, rotation, and mirror state.

Acceptance:

- diagonal parts get useful non-orthogonal rotations;
- orientation-sensitive pieces can disable mirroring;
- noisy curve segments do not explode the transform set;
- repeated runs produce identical transform lists.

### Pairwise NFP And IFP

Goal: make placement-space geometry testable before the full optimizer.

Tasks:

- compute convex NFPs for two transformed padded polygons;
- compute rectangular IFP bounds for transformed pieces;
- generate NFP/IFP contact candidates;
- classify candidate points;
- validate candidates by real polygon checks;
- expose debug visualization.

Acceptance:

- two triangles produce compact opposite-orientation candidates;
- changing placement reference only shifts coordinates, not physical validity;
- padding is preserved;
- candidate generation is deterministic.

### Shared Decoder And Windowed Beam

Goal: replace free rectangles with polygon transforms while keeping worker and
history behavior recognizable.

Tasks:

- represent state as placed transforms plus remaining ids;
- implement `orderWindow`;
- generate candidates for the next `orderWindow` eligible pieces;
- filter by direct feasibility and validation;
- score successors;
- keep top beam states;
- emit polygon-aware history frames and diagnostics.

Acceptance:

- `orderWindow = 1` behaves as strict priority-order decoding;
- `orderWindow = 2` or `3` gives bounded local repair;
- triangle-heavy fixtures beat rectangle MaxRects;
- no fake placements or fake history.

### GA/Search Portfolio

Goal: improve global order, transform, and policy choices using the same
decoder.

Tasks:

- encode chromosomes as priority order, transform index per piece, and policy;
- seed deterministic populations;
- implement mutation, crossover, elitism, and scoring;
- use app-owned seeded PRNG;
- decode through the same `orderWindow` kernel;
- enforce wall-clock budget and cancellation checkpoints;
- publish only validated best-so-far layouts;
- report terminal status and progress.

Acceptance:

- seeded runs are reproducible for the same inputs/settings/version/evaluation
  cap;
- no raw coordinate genes are used;
- timeout/cancellation returns best validated result or `no-valid-result`;
- final portfolio result is the better validated beam or GA layout.

### Free Material And Scoring

Goal: make remaining material visible and useful for scoring without making it
the legality model.

Tasks:

- compute `freeMaterial` behind the geometry adapter;
- render it in debug views;
- compute component, cavity, sliver, and rectangle-proxy metrics;
- feed `future_usability_score` and `material_fragmentation_score`;
- keep all placement legality inside NFP/IFP plus validation.

Acceptance:

- users can inspect remaining material visually;
- scoring can distinguish compact-but-fragmented layouts;
- free-material proxies never accept or reject placements by themselves.

### Multi-Plate And CSV Integration

Goal: preserve existing CSV/manual-subrun behavior.

Tasks:

- keep subruns as independent worker requests;
- store irregular placements as transforms;
- preserve CSV row links;
- export by source rows;
- keep durable replay/history references under `userData`.

Acceptance:

- manual leftovers still work;
- CSV export maps placements back to source rows;
- saved projects reload irregular results and histories.

### Benchmark And Debug Corpus

Goal: make v2 measurable and geometry failures reproducible.

Tasks:

- create deterministic fixtures for triangles, trapezoids, rectangles, stars,
  circles/arcs, ellipses, and mixed repeated pieces;
- include stress fixtures for near-collinear points, tiny segments, high
  padding, duplicate points, open contours, unresolved DXF entities, and angled
  profiles;
- measure convex-vs-rectangle opportunity:

```text
area(convexHull) / area(boundingBox)
area(collisionPolygon) / area(paddedBoundingBox)
```

- compare against current rectangle MaxRects on utilization, placed count,
  runtime, and validation failures;
- show debug overlays for source DXF, sampled points, hull, collision polygon,
  free material, NFP/IFP candidates, and final placements.

Acceptance:

- every benchmark run is deterministic for the same seed and settings;
- reports show the expected upper-bound gain from convex collision geometry;
- v2 beats or ties rectangle MaxRects on triangle/trapezoid-heavy fixtures;
- no benchmark layout is accepted without final validation.

## Risks

### Geometry Robustness

Risk: offsets, NFPs, and classifications can fail near tiny segments,
near-collinear points, duplicate points, or touching boundaries.

Mitigation:

- geometry adapter boundary;
- robust predicates;
- deterministic boundary rules;
- conservative clearance safety margin;
- final validation;
- visual debug overlays.

### Candidate Explosion

Risk: many pieces, transforms, and NFP intersections create too many candidates.

Mitigation:

- transform caps;
- small `orderWindow`;
- top-N candidate pruning;
- broad-phase bounding boxes;
- NFP cache by transform pair;
- beam width cap;
- GA time/population budget.

### Local Minima

Risk: a locally compact placement can hurt the final layout.

Mitigation:

- beam search keeps alternatives;
- GA explores global priority orders and transforms;
- free-material scoring penalizes bad fragmentation;
- benchmark against MaxRects;
- keep history rich enough to inspect decisions.

### Export Mapping

Risk: derived polygons could lose the connection to source geometry.

Mitigation:

- placements store `sourcePieceId` and transform;
- derived polygons remain cached artifacts;
- export applies transforms to original or high-quality flattened geometry;
- CSV row links remain part of prepared pieces.

## Settled Decisions

- V2 is convex-only irregular nesting.
- V2 targets fixed rectangular sheets.
- Padding means total clearance between cuts.
- Collision offset is `padding / 2 + clearanceSafetyMargin`.
- Mirroring is per-piece, default enabled, and user-disableable.
- GA/search is part of v2.
- The decoder uses priority-bounded `orderWindow`.
- Exact MIP is not the implementation path.
- Concave or hole-aware nesting is not planned.
- The starting rotation set is orthogonal rotations plus selected stable
  geometry-derived angles.
- The starting curve flattening tolerance is `0.25 mm`, with `0.1 mm` as a high
  precision option and `0.5 mm` as a coarse/fast option.
- `clearanceSafetyMargin` should start at
  `max(0.25 mm, flatteningSagTolerance)`.
- Starting optimizer defaults:

```text
orderWindow = 2
beamWidth = 24
transformCap = 16 per piece, including mirrored variants
GA population = 32
GA time budget = 60 seconds
```

These are starting defaults, not permanent laws. Benchmarks should tune them
against real jobs and fixture corpora.

## Assumptions To Revisit

There are no known shop-specific rotation restrictions or per-material optimizer
presets at this point. V2 should proceed with the default finite transform set
and default optimizer budgets above.

Keep these values configurable so future shop, material, machine, or job-level
constraints can be added without changing the core architecture.

## Non-Goals For V2

- exact global optimality;
- arbitrary continuous rotation;
- exact analytic curve NFPs;
- replacing export geometry with low-quality flattened polygons;
- full MIP solver integration;
- concave or hole-aware nesting;
- clustering as a required correctness layer.

## Summary

V2 replaces rectangle occupancy with convex collision polygon occupancy.

The legality model is:

```text
rectangular IFP bounds for the moving piece
plus convex NFP boundaries against placed pieces
plus direct feasibility classification
plus final validation
```

The optimizer model is:

```text
shared decoder
  + deterministic windowed beam
  + GA/search portfolio
  + shared scoring
  + shared validation
```

The user-visible result remains simple: original parts are rendered and exported
with stored transforms, while the engine uses conservative convex geometry to
find valid, material-efficient layouts.
