# Irregular Nesting Plan

## Purpose

This document captures the direction for moving `min-plane-dfx` from
rectangle-based nesting toward shape-aware irregular nesting.

The immediate motivation is visible with triangles and other non-rectangular
shapes: packing each shape by its bounding rectangle wastes the interior voids
of the rectangle. The long-term target is to stop treating bounding rectangles
as the real occupied geometry.

The central geometric tool for this direction is the no-fit polygon (NFP). NFP
does not solve nesting by itself. It provides the geometry primitive used to
answer:

```text
Given already placed shapes, where can this moving shape be placed without
overlap?
```

The optimizer still has to decide piece order, rotations, candidate position,
and tie-breaking.

## Literature Anchor

This plan is aligned with the irregular strip-packing / nesting literature, but
it is not a direct implementation of one paper.

Relevant references:

- Lastra-Diaz and Ortuno, "A new mixed-integer programming model for irregular
  strip packing based on vertical slices with a reproducible survey",
  arXiv:2206.00032, 2022.
  https://arxiv.org/abs/2206.00032
- Rocha, "Robust NFP generation for Nesting problems", arXiv:1903.11139, 2019.
  https://arxiv.org/abs/1903.11139
- Yang et al., "Learning based 2D Irregular Shape Packing",
  arXiv:2309.10329, 2023.
  https://arxiv.org/abs/2309.10329
- Clipper2 documentation, for practical polygon clipping/offsetting robustness.
  https://www.angusj.com/clipper2/Docs/Overview.htm

The Lastra-Diaz/Ortuno paper is important because it frames the exact
optimization side. It defines irregular strip packing as placing non-convex
polygons without overlap on a rectangular strip, notes that heuristic nesting is
the practical mature technology for large instances, and introduces an exact
continuous MIP family based on the NoFit-Polygon Covering Model with vertical
slices. That exact MIP direction is academically valuable, but it is probably
not the first practical target for this desktop app.

The practical direction for this project should be:

```text
NFP/IFP geometry primitive
  + constructive heuristic candidate placement
  + beam search / metaheuristic policy
  + optional clustering
```

## Practical Open-Source Reference: SVGNest / Deepnest

SVGNest and Deepnest are useful implementation references because they separate
the problem into the same two layers this app needs:

```text
NFP/IFP geometry decides legal placements
search policy decides order, rotation, and which legal point to use
```

The relevant lessons are:

- use NFPs for part-to-part forbidden placement regions;
- use IFPs for sheet containment;
- choose candidate points from NFP/IFP boundaries, not from a dense sheet grid;
- start from first-fit-decreasing style ordering because large/hard pieces placed
  late often create unrecoverable layouts;
- cache NFPs by shape pair and transform pair, because the optimizer evaluates
  many similar individuals or beam branches;
- treat the placement algorithm as a decoder: given an order and transform
  choices, it constructs one deterministic layout.

Deepnest's genetic algorithm is most relevant as an outer search layer. Its gene
is essentially piece order plus rotation choices; this project extends that idea
to mirror-aware transform choices. Fitness then measures how good the decoded
layout is. This is a good fit for this project because the current worker
already separates initial ordering, candidate ordering, and survivor selection.

## Terms

### Cut Polygon

The true shape outline used for rendering and export. For DXF curves, this may
remain the original DXF geometry for export, while the nesting engine receives a
flattened polygon approximation.

### Collision Polygon

A conservative convex polygon derived from flattened cut geometry, then
inflated by clearance. This is the geometry used for overlap tests, NFP
generation, and candidate validity.

### Placement Point

A fixed reference point used to describe a placed polygon. This should be a
single convention across the engine, for example the lower-left corner of the
collision polygon bounding box in local coordinates.

Use a deterministic derived reference point, not the parser's first vertex or
`path[0]`. The default convention should be the collision polygon bounding-box
minimum corner:

```text
referencePoint = (minX(collisionPolygon), minY(collisionPolygon))
```

Normalize local geometry by translating that point to `(0, 0)`.

The placement point is not a special geometric truth. It is just the coordinate
used by the placement API:

```text
placedPolygon = translate(localPolygon, placementPoint)
```

Changing the reference point shifts placement coordinates and shifts the NFP,
but it does not change which physical placements overlap.

### No-Fit Polygon

For a fixed polygon `A` and a moving polygon `B`, the NFP is the forbidden
region in placement-coordinate space for `B`'s placement point.

Using one fixed placement-point convention:

```text
point inside NFP boundary  -> B overlaps A
point on NFP boundary      -> B touches A
point outside NFP          -> B is separated from A
```

For candidate generation, the useful part is the boundary: compact placements
usually occur when the moving shape touches something already placed or touches
the sheet boundary.

### Inner-Fit Polygon

For a sheet and a moving polygon `B`, the inner-fit polygon (IFP) is the region
of placement points where `B` lies fully inside the sheet.

Feasible placement for `B` is classified in placement-coordinate space:

```text
placement point inside IFP(sheet, B)
and not strictly inside any NFP(placedPiece, B)
```

This replaces free rectangles. The free space is not stored as rectangles or
polygons on the sheet; it is represented by candidate placement points plus
per-moving-piece feasibility tests.

## V2 Scope: Strong Convex Irregular Nesting

V2 should be a real shape-aware irregular nesting engine, not a minimal
four-rotation prototype and not a transitional rectangle wrapper. It should use:

```text
convex collision polygons
  + adaptive finite per-piece rotations
  + NFP/IFP placement legality
  + a shared deterministic placement kernel
  + beam search and GA/search portfolio modes
  + final geometric validation
```

Each imported DXF shape should initially be approximated with a convex collision
polygon, not a concave polygon. Rendering and export should still use the
original DXF geometry or a high-quality flattened representation; the convex
polygon is only the conservative geometry consumed by the nesting engine.

This keeps the geometry layer tractable:

- convex NFP construction can be implemented with edge-angle merging in roughly
  linear time in the number of polygon edges;
- the NFP of two convex polygons remains manageable and does not require
  convex decomposition plus pairwise NFP fusion;
- app code can construct convex pairwise NFP boundaries and use direct
  point-in-convex / SAT-style validation instead of constructing full
  feasible-space boolean regions;
- the geometry adapter can still use Clipper2 where it reduces risk, especially
  for offsetting or cleanup, without making Clipper2 boolean union/difference
  the runtime legality model;
- candidate generation stays smaller and easier to debug;
- offsetting, validation, and caching are much simpler.

The cost is conservative packing. Concavities and holes in the source DXF are
not usable free space in v2 because the convex collision polygon covers them.
That is acceptable for v2 because convex collision geometry should already beat
bounding rectangles for triangles, trapezoids, stars, circles approximated by
polygons, and rotated/angled profiles, while avoiding the combinatorial and
robustness risk of full concave NFP.

## V2 Scale Target

V2 should be designed for jobs in the tens of pieces, with practical support for
roughly 100-150 pieces and a hard input cap around the current 200-piece range.
This target should guide rotation caps, `orderWindow`, beam width, candidate
pruning, NFP/cache strategy, free-material metrics, GA population size, and time
budgeting.

Full free-order search, uncapped rotations, exhaustive candidate scoring, and
expensive probe-heavy future-usability metrics are not the normal operating
model for this scale. They belong in tiny fixtures, debug modes, or offline
benchmarks.

## DXF To Convex Collision Polygon

The renderer or import layer should preserve the original DXF entities for
display, traceability, and export. The nesting engine consumes a derived convex
collision polygon per nestable piece. These are separate artifacts: source DXF
geometry remains authoritative, while collision geometry is a conservative
optimization aid.

Pipeline:

```text
DXF geometry
  -> flatten supported entities to sampled points
  -> deduplicate / clean sampled points
  -> compute convex hull
  -> normalize hull so bbox min corner is the local placement origin
  -> offset by padding / 2 + clearanceSafetyMargin
  -> use as collision polygon for NFP/IFP
```

This preprocessing step is quality-critical. The same source DXF, flattening
tolerance, padding, and import rules must always produce the same sampled
points, convex hull, and padded collision polygon.

Debug views should make the transformation inspectable:

```text
source DXF
sampled points
convex hull
padded collision polygon
warnings / unresolved geometry
```

Flattening should classify DXF entities and convert nestable cut geometry into
points at a configured tolerance:

- lines and polyline segments contribute endpoints;
- LWPOLYLINE bulges, arcs, circles, and ellipses are sampled into enough points
  to respect the flattening tolerance;
- text, dimensions, construction helpers, blocks, layers, open contours, or
  ambiguous contour groups may be valid DXF data without being directly nestable
  cut geometry.

The current preview/import geometry summaries are not nesting-grade polygon
input. They are useful for display and bounds, but v2 must add a dedicated
flattening path for collision geometry. In particular:

- LWPOLYLINE bulges must be interpreted as arc segments, not silently connected
  with straight lines;
- ellipses must be polygonalized from their real ellipse parameters, not
  approximated by bounding-box lines;
- the flattening tolerance and safety margin become part of the derived
  geometry identity.

Do not silently repair, drop, or reinterpret DXF entities to make them fit the
nesting pipeline. Preserve the source entities and surface unresolved geometry
as warnings or user decisions:

```text
source DXF entity is preserved
nestable cut geometry contributes sampled points
unresolved geometry is reported, not faked
```

Convex hull construction is app-owned geometry logic. Use robust predicates for
the hull turn test, because the algorithm repeatedly asks whether three sampled
points make a left turn, right turn, or are collinear. Do not use a raw floating
cross-product as the only source of truth for that decision.

After the hull exists, polygon surgery belongs behind a project-local geometry
adapter. For v2 that adapter is still convex-only. It may use a direct
TypeScript implementation, Clipper2, or both, but the rest of the worker should
not depend on library-specific shapes or tolerance policy.

Adapter-owned operations include:

- offset the hull outward to create the padded collision polygon;
- clean/simplify operation results when needed;
- compute convex pairwise NFP boundaries;
- classify points against convex polygons;
- validate containment and overlap.

Do not make full feasible-space boolean construction a v2 requirement. With
convex collision polygons and a rectangular sheet, candidate generation can use
NFP boundaries/intersections plus direct feasibility tests. Clipper2 boolean
union/difference is allowed for experiments, debug comparison, or offset
implementation, but it should not be the central runtime model unless the
convex candidate-and-validation path proves insufficient.

Concavity recovery is not part of the v2 collision model. Do not make full
concave or hole-aware NFP a planned follow-up path in this document. Keep the
convex engine honest and complete: concave source geometry is preserved for
display/export, while its convex collision polygon is the conservative nesting
geometry.

## What Changes Compared With MaxRects

Current MaxRects state:

```text
sheet rectangle
free rectangles
piece bounding rectangles
candidate placement = place a rectangle into a free rectangle
```

NFP-based irregular nesting state:

```text
sheet polygon or rectangle
placed collision polygons
remaining collision polygons
candidate placement = feasible placement point derived from IFP/NFP boundaries
```

Rectangles do not disappear completely. They remain useful for:

- broad-phase acceleration;
- bounding box filtering;
- UI framing;
- compactness scoring;
- sheet extents;
- optional transitional clustering.

But they stop being the truth of occupied geometry.

## Padding And Clearance

Padding must be handled geometrically before overlap/NFP work.

Current rectangle preparation treats padding as total clearance split across
sides, rounded with integer `ceil(padding / 2)` footprints. V2 intentionally
keeps the same half-padding meaning but uses real-valued geometry, so the
collision offset is the exact half-padding plus a named physical safety margin:

```text
clearance = padding
collisionOffset = padding / 2 + clearanceSafetyMargin
collisionPolygon = offset(cutPolygon, collisionOffset)
```

Mathematically, `offset(polygon, d)` means moving every polygon edge outward by
distance `d` and joining the result into a larger polygon. The geometry adapter
owns this offset operation; its v2 implementation may be a direct convex offset,
Clipper2, or a Clipper2-checked implementation.

If two collision polygons touch, their real cut polygons have at least roughly
`padding + 2 * clearanceSafetyMargin` between them before accounting for source
curve approximation error.

`clearanceSafetyMargin` is not an ad hoc floating-point comparison tolerance. It
is a physical margin used to preserve clearance after flattening curves into
segments. If arc/circle/ellipse flattening is allowed to approximate the real
curve inward by at most `flatteningSagTolerance`, then:

```text
clearanceSafetyMargin >= flatteningSagTolerance
```

Alternatively, the flattening step may produce a conservative outward
approximation, but the margin/tolerance relationship must still be explicit and
owned by the geometry adapter.

If product semantics change to "padding around each piece", then the offset
would be full padding rather than half padding. For current app semantics,
half-padding is the correct continuity with rectangle preparation.

For the sheet border:

```text
collisionPolygon must be inside sheet
```

This is equivalent to keeping a
`padding / 2 + clearanceSafetyMargin` internal border around the sheet, but it
is easier to express as an IFP constraint: only placement points whose enlarged
collision polygon remains inside the sheet are feasible.

Score reporting should be explicit:

- packing/collision uses collision polygons;
- utilization reporting should normally use real cut polygon area;
- envelope/bounds scoring may use collision bounds because that reflects actual
  machine clearance consumption.

## Coordinates And Numerical Robustness

The engine should not force all geometry onto integer millimeter coordinates.
Imported DXF geometry, adaptive rotations, edge-alignment angles, and
principal-axis angles can naturally produce fractional coordinates.

Use real-valued coordinates for source geometry, rotated collision polygons,
placement candidates, and stored transforms:

```text
DXF geometry
  -> flattened real-valued cut polygon
  -> real-valued convex collision polygon
  -> real-valued rotated candidates
  -> real-valued placement transforms
```

Correctness must come from robust geometric decisions, not from pretending that
ordinary floating-point equality is reliable. App-owned low-level geometry
decisions should go through the geometry adapter and use robust predicates where
appropriate:

- orientation / left-right-on-edge tests;
- segment intersection;
- point-in-convex-polygon and boundary classification;
- convex polygon overlap / separation tests.

For v2, the project-local geometry adapter is the boundary, not Clipper2 itself.
The adapter should expose convex operations needed by the worker: flattening
outputs, convex hull, convex offset, rotation, convex NFP, candidate
classification, and final validation. It can be backed by direct TypeScript
geometry, official Clipper2 C++ through WASM/native bindings, or a combination
where Clipper2 is used for offsetting and differential checks.

Clipper2 exposes double-coordinate paths while internally scaling to integer
arithmetic for robust clipping. Do not depend on an unofficial
JavaScript/TypeScript Clipper port as the production clipping backend. Plain
TypeScript is acceptable for the convex operations that v2 owns directly.

If app-owned code makes low-level geometry decisions, use robust predicates
rather than ad hoc numeric tolerance checks. In TypeScript that can mean
`robust-predicates`; in a backend implementation it can mean equivalent robust
predicate routines inside the geometry adapter.

Do not make snap rounding or integer grid rounding the core legality model.
Rounding may be used only at controlled boundaries such as cache keys, debug
display, export normalization, or machine-output precision.

Degenerate cases need explicit deterministic rules:

- touching is allowed when the configured clearance is satisfied;
- positive overlap is forbidden;
- boundary points are classified consistently;
- equal candidate scores use stable tie-breakers such as `y`, `x`, rotation, and
  piece id;
- duplicate candidate points from different NFP/IFP boundaries are deduplicated
  deterministically.

Final placement records should store transforms, not rewritten geometry:

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

Rendering/export applies the transform to original geometry or high-quality
flattened geometry. The nesting engine consumes the derived collision polygon.

Mirroring is a per-piece capability. V2 should default pieces to mirrorable,
while allowing users or source metadata to disable mirroring for handed,
front-faced, grain-sensitive, engraved, or otherwise orientation-sensitive
parts. The optimizer may only generate mirrored variants for pieces whose
`allowMirror` flag is true, and the final transform must record the chosen
mirror state explicitly.

## Validation Invariant

NFP/IFP geometry proposes feasible placement candidates; it is not the final
authority. Before accepting any beam or GA result, run a final validation pass:

```text
for every placed pair:
  distance(realGeometryA, realGeometryB) >= padding - tolerance

for every placed piece:
  collisionPolygon is inside sheet
  collisionPolygon does not overlap any placed collision polygon
```

The conservative offset should make this pass comfortably. If it fails, the
result is invalid even if the heuristic thought it was valid.

This validation is not debug-only. It is the shared legality gate for every
optimizer mode, every cached NFP/IFP result, and every replayed or exported
layout.

## Adaptive Finite Rotation Set

Do not search arbitrary continuous rotations. V2 should still use a strong
finite per-piece rotation set generated from the piece geometry and shop
constraints.

Every piece should include the baseline orthogonal rotations when physically
allowed:

```text
0, 90, 180, 270
```

Then add piece-specific shape angles:

- edge angles that align important edges to the sheet X or Y axis;
- principal-axis / oriented-bounding-box angles for elongated or diagonal
  pieces;
- configured machine-safe angles if the cutting workflow has constraints.

For pieces with `allowMirror = true`, generate mirrored variants of the same
bounded rotation set. For pieces with `allowMirror = false`, only unmirrored
rotations are legal. Mirroring doubles the transform candidates for a piece, so
it must count toward rotation/transform caps and diagnostics.

Do not add every tiny flattened segment as a rotation. Rotation candidates must
be filtered and capped:

- ignore very short/noisy edges from curve flattening;
- prefer long edges and stable hull edges;
- deduplicate near-equal angles by tolerance;
- cap rotations per piece, for example top 12-24 candidates before benchmark
  tuning.

The result is finite but adaptive: more useful than only orthogonal rotations,
without turning rotation into an unbounded continuous search problem.

## Candidate Generation With NFP

For one beam state and one moving piece:

```text
placed = already placed collision polygons
moving = candidate collision polygon in one allowed rotation

ifpBounds = rectangular placement interval where moving's bbox fits in sheet
nfpBoundaries = convex NFP boundary for each placed piece vs moving
candidatePoints = vertices/intersections/contact points from NFP and IFP bounds
```

Candidate points should initially include:

- IFP rectangle corners and edge contacts;
- NFP vertices;
- intersections between NFP boundaries;
- intersections between NFP and IFP boundaries;
- bottom-left-like points;
- low-y / low-x contact points;
- optionally a small local fallback around best points.

Candidate points are accepted only after direct feasibility classification:

```text
point inside rectangular IFP bounds
point not strictly inside any convex NFP
translated moving polygon is inside the sheet
translated moving polygon does not overlap any placed collision polygon
```

Candidate placements should also be locally validated before they are committed
to a successor state:

```text
translated moving polygon is inside sheet
translated moving polygon does not overlap any placed collision polygon
```

The NFP is a candidate generator and broad feasibility map. V2 should not need
to materialize `IFP - union(NFP)` as polygons during normal runtime. Validation
remains mandatory because NFP generation, simplification, offsets, and
tolerances can fail.

## Geometry Cache Identity

NFP generation, rotation, and validation metadata can be reused by both beam
search and GA. The engine should keep derived geometry identity explicit and
cache artifacts when benchmarks show repeated branches are spending material
time recomputing the same pair/rotation data.

Cacheable artifacts include:

- rotated collision polygons;
- pairwise outer NFPs;
- sheet/piece IFP bounds;
- bounding boxes and broad-phase data;
- point-classification and segment-intersection acceleration data;
- optional unioned/debug forbidden regions when useful outside the hot path.

The cache is correctness-sensitive. Reusing an NFP computed for a different
clearance, rotation, placement reference, or geometry backend can create invalid
placements. Cache keys must include the full derived-geometry identity:

```text
piece geometry digest
rotation angle
mirror state
clearance / padding / clearanceSafetyMargin
flattening tolerance
convex-hull simplification tolerance
placement reference convention
geometry backend name and version/config
NFP/IFP algorithm version
```

Pairwise NFP keys must include both pieces, both rotations, and both mirror
states. IFP keys must include the sheet geometry plus the moving piece rotation
and mirror state. If any input in the key changes, the cached artifact is stale
and must not be reused.

## Shared Decoder And Optimizer Portfolio

The optimizer should stay close to the current worker architecture, but v2
should include both deterministic beam search and a GA/search portfolio. Both
must use the same placement kernel, NFP/IFP cache, scoring primitives, and final
validator.

The shared placement kernel is the core abstraction. A complete layout is
produced through an explicit decoder contract:

```text
decode(priorityOrder, rotations, placementPolicy, orderWindow, geometryCache)
  -> layoutResult

input:
  priority-ordered piece ids
  selected rotation per piece
  placement policy id
  order window size
  NFP/IFP geometry cache

responsibility:
  place pieces through bounded expandState steps
  choose candidate pieces from the next orderWindow eligible ids
  generate NFP/IFP candidates
  rank legal candidates through the selected policy
  validate accepted placements

output:
  placed transforms
  unplaced pieces
  score and diagnostics
  validation result
```

Beam and GA differ in how they choose decoder inputs. They must not place
geometry themselves.

The one-step operation underneath `decode` is:

```text
input:
  current placed state
  candidate piece ids from the next orderWindow eligible ids
  candidate transform choices
  placement policy id

expandState:
  generate NFP/IFP candidate points for each candidate piece/transform
  score legal candidate placements using the selected policy
  return successor states

output:
  concrete transform choices
  successor scores and diagnostics
```

The GA must not encode raw `(x, y)` placement coordinates. Legal placement stays
centralized in the placement kernel so every portfolio mode uses the same
geometry rules.

All placement policies consume the same validated NFP/IFP candidate set. They
differ only in how they rank legal candidates.

Beam search constructs layouts while keeping multiple partial states alive:

For each beam state:

```text
for each candidate piece in next orderWindow eligible pieces:
  for each allowed rotation:
    generate NFP/IFP candidate points
    score candidate placements
keep top K successor states
```

Beam expansion is priority-bounded, not full free-order by default. The active
priority order comes from either the deterministic seed order or the GA
chromosome. The default v2 `orderWindow` should be small, for example `2` or
`3`, with `1` available as strict-order decoding. Full free-order expansion over
all remaining pieces is reserved for tiny fixtures, debugging, or benchmark
experiments because its branching factor grows quickly and weakens the meaning
of the GA order gene.

GA/search explores the global choices that beam can miss:

```text
chromosome =
  piece priority order
  transform index per piece
  placement policy id

fitness(layout) =
  decode the chromosome priority order through the shared windowed decoder
  then rank the resulting validated layout
```

This is not the exact MIP approach from Lastra-Diaz/Ortuno. It is a practical
heuristic. It is aligned with the broader literature direction where NFP
handles geometry and heuristic/metaheuristic search handles sequencing.

Initial scoring should reuse ideas already present in the project:

- keep used extents compact;
- prefer lower placements;
- prefer left placements;
- preserve future usable material;
- penalize tiny unusable cavities;
- penalize fragmentation of remaining material;
- prefer placements that increase contact without overlap.

Avoid relying only on local best area. NFP gives more candidates and therefore
more ways to make locally attractive mistakes. Beam width, GA diversity, and
scoring diversity matter.

## GA Search Model

Recommended chromosome fields:

- priority order of prepared piece ids;
- rotation choice per piece from the finite rotation set;
- optional placement policy id, e.g. compact, preserve-free, contact-heavy.

The order gene is a priority order, not a raw coordinate plan and not an
immutable trace when `orderWindow > 1`. This preserves the SVGNest/Deepnest
model where GA explores insertion order and rotations, while allowing bounded
local repair inside the decoder.

Recommended initial population:

- current `sortPiecesForNesting` order;
- first-fit-decreasing by convex hull area, longest edge, height, width, and
  imbalance;
- a few strategy-derived priority orders that put awkward/high-vertex pieces
  first;
- random swaps/inversions from those seeds.

Recommended mutations:

- swap two pieces;
- move one piece earlier/later;
- reverse a short subsequence;
- rotate one piece to another allowed angle;
- change placement policy id if that field is used.

Recommended crossover:

- order-preserving crossover for the priority order;
- per-piece rotation inherited from either parent, then occasionally mutated.

Fitness should stay lexicographic and conservative:

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

For this app, preserving future usable material should rank ahead of pure
compactness once all pieces placed/unplaced status ties. That score should be
derived from the free material artifact and cheap proxies such as largest
component area, cavity/sliver penalties, largest-empty-rectangle estimates, or
limited probes against representative remaining pieces. It must not claim to be
the exact feasible placement region for every future piece.

Beam and GA are complementary v2 modes, not a first/later split. Windowed beam
search is the deterministic reference and gives inspectable partial-state
history. GA is part of v2 and can outperform deterministic beam when the main
mistake is early piece priority, rotation, or policy choice. The practical
target is a portfolio:

```text
deterministic convex-NFP windowed beam
  + time-budgeted GA/search using the same placement kernel and caches
  + final validator shared by both
```

### GA Budget And Reproducibility

GA/search uses an app-owned seeded deterministic PRNG and never depends on
ambient `Math.random()`. Given the same inputs, settings, seed, algorithm
version, and evaluation cap, it must produce the same sequence of chromosomes
and scores.

Wall-clock time is the user-facing budget for desktop UX, but it is not an exact
cross-machine replay guarantee. The worker should also track generation and
completed evaluation counts so runs can be explained and, when needed, replayed
through an evaluation-count cap.

The time budget is checked at deterministic scheduling checkpoints:

- before starting a new chromosome evaluation;
- after a completed layout has passed final validation.

A layout is eligible to become best-so-far only after the shared final validator
accepts it. Partial or in-flight layouts are never published as results. When
the budget expires, the worker stops scheduling new evaluations and returns the
best fully validated GA result seen so far. If no GA result has validated, the
GA lane reports `no-valid-result` and the portfolio may still return the
validated deterministic beam result.

User cancellation follows the same best-so-far rule with status `cancelled`.
The normal terminal statuses should distinguish `completed`, `budget-expired`,
`cancelled`, and `no-valid-result`.

The final portfolio result is the better validated layout between deterministic
windowed beam and GA/search according to the shared lexicographic score.
Progress reports should include generation, completed evaluations, population
size, current best score, best source, elapsed time, remaining budget, and
current phase.

## Free Space Model

The engine should not use "free polygons" as the placement-legality model in the
same way MaxRects uses free rectangles.

Instead, free space is computed per candidate moving piece:

```text
free placement space for moving piece =
  sheet containment region for that moving piece
  minus forbidden placement regions induced by placed pieces
```

This is the key conceptual shift. Free space depends on the shape being placed.
There is no single universal free-space polygon that is equally useful for all
future shapes.

Use the geometry cache for repeated NFP/IFP and broad-phase artifacts, but do
not treat cached geometry as proof of validity. Candidate placements still need
the final containment and overlap validation described above.

### Derived Free Material Polygon

V2 should maintain a derived sheet-space artifact when useful for scoring,
debugging, and user inspection:

```text
freeMaterial = sheet rectangle - union(placed collision polygons)
```

This artifact answers "which sheet material is not occupied by placed collision
geometry?" It is useful for:

- renderer/debug overlays of remaining material;
- utilization display;
- connected-component, cavity, sliver, and fragmentation metrics;
- largest empty rectangle or rectangle-proxy scoring;
- future-usability scoring and branch comparison;
- explaining why a compact-looking layout left poor remaining material.

`freeMaterial` is not the placement legality authority. It should not replace
per-moving-piece IFP/NFP candidate generation, and rectangle proxies derived
from it must never prove that a placement is legal or impossible. Every accepted
placement still needs direct containment and overlap validation.

Computing `freeMaterial` is a sheet-space polygon union/difference problem, so
Clipper2 is appropriate behind the geometry adapter if it reduces risk. This
does not contradict avoiding Clipper2 boolean feasible regions for legality:
the engine still does not need to materialize `IFP - union(NFP)` in placement
space during normal placement.

## Option A: Transitional NFP Clustering Then Rectangles

This is a possible prototype, but it is not the v2 target.

Pipeline:

```text
input pieces
  -> derive cut/collision polygons
  -> generate local clusters with NFP contacts
  -> represent each cluster by a rectangular envelope
  -> pack cluster envelopes with existing MaxRects
  -> expand cluster placements back to real shape placements
```

Cluster generation:

```text
start with one piece
try adding compatible pieces using NFP boundary candidates
validate against all cluster members
score by low rectangular-envelope waste
keep top B clusters
repeat up to cluster size K
```

This directly addresses triangles and trapezoids because multiple shapes can
share a compact envelope before MaxRects sees them.

Advantages:

- smaller architectural change;
- reuses current MaxRects and history UI;
- good quick win for repeated triangles;
- useful testbed for polygon offset/intersection/NFP.

Disadvantages:

- still ultimately packs cluster bounding rectangles;
- may miss global irregular placements;
- cluster selection can consume pieces badly;
- hard to make general without reimplementing much of the real optimizer.

This should be considered a prototype or interim feature only, not the v2
architecture.

## Option B: Direct NFP-Based Irregular Nesting

This is the recommended v2 direction.

Pipeline:

```text
input pieces
  -> derive cut/collision polygons
  -> generate adaptive finite rotations per piece
  -> candidate generation via IFP/NFP placement regions
  -> shared placement kernel
  -> deterministic beam and time-budgeted GA/search portfolio
  -> final validation
  -> render/export original geometry with stored transforms
```

Advantages:

- eliminates bounding-rectangle waste as the core model;
- handles unknown DXF geometry generically;
- aligns with irregular nesting literature;
- gives a clean conceptual answer to free space;
- avoids making cluster selection a prerequisite for correctness.

Disadvantages:

- much larger implementation;
- needs robust polygon operations;
- performance must be managed carefully;
- scoring is harder than rectangular MaxRects;
- debugging history UI must show polygon placements and placement-space
  candidates clearly.

## Recommended Direction

Target Option B.

Do not make clustering the main architecture. Treat clustering as non-v2
experimental work or an optional enhancement after the direct NFP engine is
stable.

The reason is simple: the real problem is irregular nesting. If we introduce
NFP only to make better rectangles, we will still be fighting rectangle
artifacts. The cleaner model is to let polygons be the occupied geometry and
let NFP/IFP define feasible placement space.

## V2 Delivery Workstreams

These are workstreams for one strong v2, not separate product versions.

### Geometry Kernel

Goal: provide robust polygon operations outside the worker optimizer.

Tasks:

- flatten supported DXF entities to sampled points at a configurable tolerance;
- add nesting-grade LWPOLYLINE bulge sampling;
- add nesting-grade ellipse polygonalization;
- keep preview/bounds summaries separate from collision-geometry flattening;
- compute convex hulls from sampled points using robust predicates for turn
  tests;
- normalize hulls to a stable local placement point;
- offset hulls by `padding / 2 + clearanceSafetyMargin` through the geometry
  adapter;
- compute area and bounding box;
- run pairwise intersection tests;
- run final clearance validation on sample placements;
- keep Clipper2 available behind the adapter for offsetting, cleanup, or
  differential checks if that reduces risk;
- add robust predicates for orientation, intersection, containment, and boundary
  classification;
- encode deterministic rules for touching, equal scores, duplicate candidates,
  and boundary points.

Acceptance:

- triangles, trapezoids, rectangles, stars, circles approximated as polygons;
- padded polygons visually inspectable in the renderer;
- deterministic real-valued output and stable edge-case classification;
- final validation catches intentional clearance violations.

### Adaptive Rotation Generator

Goal: generate strong bounded rotation and mirror candidates for each convex
collision polygon.

Tasks:

- include baseline orthogonal rotations when allowed;
- carry per-piece `allowMirror`, defaulting to true but user-disableable;
- compute stable edge-alignment angles from long convex-hull edges;
- compute principal-axis / oriented-bounding-box angles;
- deduplicate angles by tolerance;
- cap the candidate set per piece and expose diagnostics for discarded angles;
- cache transformed collision polygons by geometry digest, rotation, and mirror
  state.

Acceptance:

- diagonal and elongated pieces receive useful non-orthogonal rotations;
- orientation-sensitive pieces can disable mirrored transforms;
- tiny flattened curve segments do not explode the rotation set;
- repeated runs produce identical transform lists;
- NFP cache keys include the selected rotation and mirror state.

### Pairwise NFP And IFP

Goal: understand and test NFP semantics with real project shapes.

Tasks:

- compute or approximate NFP for two padded polygons and fixed rotations;
- compute rectangular IFP bounds for a rotated piece inside the sheet;
- expose debug visualization of placement-space NFP;
- generate contact candidate points from NFP boundaries, NFP intersections, and
  IFP-bound intersections;
- classify candidate points against IFP bounds and convex NFP interiors;
- validate each candidate by real polygon intersection;
- score pair placements by compact bounding envelope and real waste.

Acceptance:

- two triangles produce compact opposite-orientation candidates;
- changing placement reference point only shifts the NFP, not physical
  placement validity;
- padding is preserved by construction;
- candidate generation is deterministic.

### Shared Decoder And Beam Search

Goal: replace free rectangles for one run while keeping the worker/history
contract recognizable and deterministic.

Tasks:

- represent beam state as placed polygon transforms plus remaining ids;
- define `orderWindow` and candidate-piece selection from the active priority
  order;
- for each candidate piece in the next `orderWindow` eligible ids and each
  allowed rotation, generate placement candidates from rectangular IFP bounds
  plus convex NFP boundaries/intersections;
- filter candidates with direct convex feasibility and final local validation;
- score successors;
- keep top beam states;
- emit history frames with polygon placements and optional placement-space
  diagnostics.

Acceptance:

- triangle-heavy cases beat rectangle MaxRects on utilization;
- `orderWindow = 1` behaves as strict priority-order decoding;
- small windows such as `2` or `3` give bounded local repair without full
  free-order branching;
- final validator proves padding;
- fallback handles invalid/empty feasible regions honestly;
- no fake placements or fake history.

### GA/Search Portfolio

Goal: improve order, rotation, and policy choices using the same placement
kernel as the beam mode.

Tasks:

- encode chromosomes as piece priority order, mirror-aware transform index per
  piece, and placement policy id;
- seed the population with deterministic orders and transform choices;
- add swap, move, subsequence-reversal, transform, and policy mutations;
- use order-preserving crossover for piece priority orders;
- decode chromosomes through the same `orderWindow` placement kernel as
  deterministic beam;
- rank decoded layouts with the same lexicographic final score family;
- use an app-owned seeded deterministic PRNG;
- enforce wall-clock budget and cancellation at deterministic scheduling
  checkpoints;
- publish only fully validated layouts as best-so-far;
- return the better validated portfolio result between deterministic windowed
  beam and GA/search;
- report GA status as `completed`, `budget-expired`, `cancelled`, or
  `no-valid-result`;
- stream progress with generation, completed evaluations, population size, best
  score/source, elapsed time, remaining budget, and phase.

Acceptance:

- GA chromosome generation and scoring order are reproducible for the same
  inputs, settings, seed, algorithm version, and evaluation cap;
- every GA layout is produced by the shared placement kernel, not raw coordinate
  genes;
- the priority-order chromosome remains meaningful with the configured
  `orderWindow`;
- timeout or cancellation returns the last fully validated best-so-far layout,
  or `no-valid-result` if none exists;
- the best GA result can tie or beat deterministic beam on benchmark jobs;
- failed or partial GA runs are reported honestly.

### Multi-Plate And CSV Integration

Goal: preserve current subrun/CSV behavior while switching the geometry engine.

This is not a speculative v2 feature family. CSV import/export, row links,
manual follow-up subruns, run records, and durable history references already
exist in the rectangle workflow. V2 must carry those contracts forward while
changing placement geometry from rectangles to transforms over source pieces.

Tasks:

- keep subruns as independent worker requests;
- store irregular placements as transforms;
- preserve CSV row links through prepared polygon pieces;
- export CSV by placed source rows, not by rectangle ids;
- ensure replay/history files remain durable under `userData`.

Acceptance:

- manual leftovers still work;
- CSV export still maps placements back to source rows;
- saved projects reload with irregular geometry and histories.

### Optional Clustering

Goal: improve dense local arrangements without making clustering mandatory.

Tasks:

- generate candidate clusters with local NFP search;
- cap cluster size and beam width;
- keep singleton candidates so clustering is never forced;
- compare cluster-first runs against direct NFP runs.

Acceptance:

- repeated triangles/trapezoids improve or tie direct NFP;
- clustering never makes final validation fail;
- the engine can disable clustering for debugging.

### Benchmark And Debug Corpus

Goal: keep v2 measurable against the current rectangle engine and make geometry
failures reproducible.

Tasks:

- collect small deterministic fixtures for triangles, trapezoids, rectangles,
  stars, circles/arcs approximated by polygons, and mixed repeated pieces;
- measure convex-vs-rectangle opportunity for presets and real jobs:
  `area(convexHull) / area(boundingBox)` and
  `area(collisionPolygon) / area(paddedBoundingBox)`;
- include stress fixtures for near-collinear points, tiny segments, high
  padding, duplicate points, open contours, unresolved DXF entities, and
  rotation-heavy angled profiles;
- store expected preprocessing diagnostics: sampled point count, convex hull,
  padded collision polygon, unresolved geometry warnings, and rotation set;
- compare v2 against current rectangle MaxRects on utilization, placed count,
  runtime, and validation failures;
- keep renderer/debug overlays able to show source DXF, sampled points, convex
  hull, padded collision polygon, derived free material, NFP/IFP candidates,
  and final placements.

Acceptance:

- every benchmark run is deterministic for the same seed and geometry settings;
- benchmark reports show the expected upper-bound gain from convex collision
  geometry before optimizer effects;
- v2 beats or ties rectangle MaxRects on triangle/trapezoid-heavy fixtures;
- geometry failures can be reproduced from saved fixture inputs and diagnostics;
- no benchmark layout is accepted without final validation.

## Risks

### Geometry Robustness

Polygon offsetting, convex NFP generation, and geometric classification are the
main technical risks. Near-collinear edges, tiny segments, duplicate points,
touching boundaries, and self-intersections in source geometry can create
invalid output.

Mitigation:

- local geometry adapter boundary with Clipper2 available where it reduces
  offsetting or cleanup risk;
- robust predicates for app-owned geometric truth decisions;
- deterministic boundary/tie-breaking rules;
- simplify input polygons with tolerance;
- conservative clearance safety margin tied to flattening tolerance;
- final validation;
- visual debug overlays.

### Candidate Explosion

NFP creates many candidates, especially with many pieces and rotations.

Mitigation:

- finite adaptive transform set with dedupe and per-piece caps;
- top-N candidate pruning per piece;
- broad-phase bounding boxes;
- NFP cache by shape pair and transform pair;
- beam width cap;
- GA population/time budget cap;
- time budget with honest best-so-far and terminal-status reporting.

### Local Minima

More accurate geometry can still produce globally worse layouts if the scoring
prefers a bad early contact.

Mitigation:

- beam search rather than greedy single path;
- GA/search over order, rotations, and placement policy;
- scoring diversity;
- preserve multiple candidate types;
- compare against current rectangle MaxRects as a baseline;
- keep history rich enough to inspect decisions.

### Export Mapping

The engine must never lose the connection to original DXF/CSV pieces.

Mitigation:

- placements store `sourcePieceId` and transform;
- derived polygons are cached artifacts, not authoritative source data;
- export applies transforms to original or high-quality flattened geometry.

## Open Questions

Settled v2 decisions:

- Padding means total clearance between cuts. V2 preserves current rectangle
  semantics by offsetting each collision polygon by
  `padding / 2 + clearanceSafetyMargin`.
- The target is fixed rectangular sheet nesting, not strip-length minimization.
- Exact MIP is a literature/benchmark reference only, not an implementation
  path for v2.
- Mirroring is a per-piece capability, defaulting to enabled and user-disableable
  for orientation-sensitive pieces.

Remaining product/geometry questions:

- Which rotation set is acceptable for the shop workflow?
- What flattening tolerance is acceptable for DXF arcs/circles?

## Non-Goals For V2

- exact global optimality;
- arbitrary continuous rotation;
- exact analytic curve NFPs;
- replacing DXF export geometry with low-quality flattened polygons;
- full MIP solver integration;
- clustering as a required correctness layer.

## Summary

The project can abandon rectangle occupancy for the core algorithm.

The replacement is not "free polygons". The replacement is:

```text
placement-space geometry:
  rectangular IFP bounds for the moving piece
  plus convex NFP boundaries against placed pieces
  plus direct candidate feasibility classification
```

NFP gives feasible/contact candidate positions. Beam and GA/search modes choose
among them through the shared placement kernel. Padding is handled by inflated
collision polygons, robust geometric decisions, deterministic edge-case rules,
and final validation.

The recommended path is to build a direct NFP-based irregular nesting engine,
with adaptive finite rotations, deterministic beam search, and a time-budgeted
GA/search portfolio. Cluster-to-rectangles work is optional/non-v2 experimental
work and should not become the architectural destination.
