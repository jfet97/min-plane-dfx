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
- cache NFPs by shape pair and rotation pair, because the optimizer evaluates
  many similar individuals or beam branches;
- treat the placement algorithm as a decoder: given an order and rotations, it
  constructs one deterministic layout.

Deepnest's genetic algorithm is most relevant as an outer search layer. Its gene
is essentially piece order plus rotation choices. Fitness then measures how good
the decoded layout is. This is a good fit for this project because the current
worker already separates initial ordering, candidate ordering, and survivor
selection.

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

Feasible placement space for `B` is:

```text
IFP(sheet, B) minus union(NFP(placedPiece, B) for each placed piece)
```

This replaces free rectangles. The free space is not stored as rectangles or
polygons on the sheet; it is represented as feasible placement regions for the
next moving piece.

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
- app code can construct convex pairwise NFP boundaries while the Clipper2
  adapter owns polygon offsetting and region boolean operations;
- candidate generation stays smaller and easier to debug;
- offsetting, validation, and caching are much simpler.

The cost is conservative packing. Concavities and holes in the source DXF are
not usable free space in v2 because the convex collision polygon covers them.
That is acceptable for v2 because convex collision geometry should already beat
bounding rectangles for triangles, trapezoids, stars, circles approximated by
polygons, and rotated/angled profiles, while avoiding the combinatorial and
robustness risk of full concave NFP.

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
  -> offset by padding / 2 + epsilon
  -> use as collision polygon for NFP/IFP
```

Flattening should classify DXF entities and convert nestable cut geometry into
points at a configured tolerance:

- lines and polyline segments contribute endpoints;
- arcs, circles, and bulges are sampled into enough points to respect the
  flattening tolerance;
- text, dimensions, construction helpers, blocks, layers, open contours, or
  ambiguous contour groups may be valid DXF data without being directly nestable
  cut geometry.

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

Clipper2 is used after the hull exists, when we need polygon surgery:

- offset the hull outward to create the padded collision polygon;
- clean/simplify operation results when needed;
- later, perform boolean/NFP/IFP region operations.

Concavity recovery is not part of the default v2 collision model. If explored,
it should be isolated behind controlled modes:

- convex decomposition for selected shapes only;
- multi-convex-piece clusters that keep each component convex;
- opt-in precise concave NFP for small edge counts;
- benchmark-only exact/concave mode for comparison.

Do not make full concave NFP the default v2 path. For concave shapes, the
number of edge interactions and fusion cases can grow quickly, and the candidate
set can become noisy before the optimizer is mature.

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
collision offset is the exact half-padding plus a conservative epsilon:

```text
clearance = padding
collisionOffset = padding / 2 + epsilon
collisionPolygon = offset(cutPolygon, collisionOffset)
```

Mathematically, `offset(polygon, d)` means moving every polygon edge outward by
distance `d` and joining the result into a larger polygon. Clipper2 owns this
offset operation.

If two collision polygons touch, their real cut polygons have at least roughly
`padding + 2 * epsilon` between them.

If product semantics change to "padding around each piece", then the offset
would be full padding rather than half padding. For current app semantics,
half-padding is the correct continuity with rectangle preparation.

For the sheet border:

```text
collisionPolygon must be inside sheet
```

This is equivalent to keeping a `padding / 2 + epsilon` internal border around
the sheet, but it is easier to express as an IFP constraint: only placement
points whose enlarged collision polygon remains inside the sheet are feasible.

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
decisions that are not delegated to Clipper2 should go through robust
predicates:

- orientation / left-right-on-edge tests;
- segment intersection;
- point-in-polygon and boundary classification;

For constructive polygon operations such as offsetting, union, difference,
intersection, IFP/NFP region operations, and Minkowski-style geometry, use a
project-local geometry adapter backed by official Clipper2 C++. The preferred
runtime boundary is WASM or a native addon/shared library so the same geometry
backend can be reused by the Electron app and by a real service backend.

Clipper2 exposes double-coordinate paths while internally scaling to integer
arithmetic for robust clipping. Do not make an unofficial JavaScript/TypeScript
port the production geometry backend. A JS port is acceptable only for quick
experiments or differential tests against the official C++ backend.

If app-owned code still makes low-level geometry decisions outside Clipper2,
use robust predicates rather than ad hoc epsilon checks. In TypeScript that can
mean `robust-predicates`; in a backend implementation it can mean equivalent
robust predicate routines inside the geometry adapter.

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

ifp = innerFitPolygon(sheet, moving)
forbidden = union(nfp(placedPiece, moving) for placedPiece in placed)
feasible = ifp - forbidden
candidatePoints = sample boundary/vertices/intersections of feasible
```

Candidate points should initially include:

- feasible-region vertices;
- intersections between NFP boundaries;
- intersections between NFP and IFP boundaries;
- bottom-left-like points;
- low-y / low-x contact points;
- optionally a small local fallback around best points.

Candidate placements should also be locally validated before they are committed
to a successor state:

```text
translated moving polygon is inside sheet
translated moving polygon does not overlap any placed collision polygon
```

The NFP is a candidate generator and broad feasibility map. Validation remains
mandatory because polygon operations, simplification, and tolerances can fail.

## Geometry Cache Identity

NFP and IFP generation are expensive, and both beam search and GA evaluate many
states that reuse the same piece pairs and rotations. The engine should cache
derived geometry so repeated branches do not recompute the same placement-space
regions.

Cacheable artifacts include:

- rotated collision polygons;
- pairwise outer NFPs;
- sheet/piece IFPs;
- bounding boxes and broad-phase data;
- unioned forbidden regions for a beam state when profitable.

The cache is correctness-sensitive. Reusing an NFP computed for a different
clearance, rotation, placement reference, or geometry backend can create invalid
placements. Cache keys must include the full derived-geometry identity:

```text
piece geometry digest
rotation angle
clearance / padding / epsilon
flattening tolerance
convex-hull simplification tolerance
placement reference convention
geometry backend name and version/config
NFP/IFP algorithm version
```

Pairwise NFP keys must include both pieces and both rotations. IFP keys must
include the sheet geometry and the moving piece rotation. If any input in the key
changes, the cached artifact is stale and must not be reused.

## Shared Decoder And Optimizer Portfolio

The optimizer should stay close to the current worker architecture, but v2
should include both deterministic beam search and a GA/search portfolio. Both
must use the same placement kernel, NFP/IFP cache, scoring primitives, and final
validator.

The shared placement kernel is the core abstraction:

```text
input:
  current placed state
  candidate piece id
  candidate rotation
  placement policy id

expandState:
  generate NFP/IFP candidate points for the candidate rotation
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
for each remaining piece:
  for each allowed rotation:
    generate NFP/IFP candidate points
    score candidate placements
keep top K successor states
```

GA/search explores the global choices that beam can miss:

```text
chromosome =
  piece permutation
  rotation index per piece
  placement policy id

fitness(layout) =
  decode the chromosome by repeatedly calling expandState
  then rank the resulting validated layout
```

This is not the exact MIP approach from Lastra-Diaz/Ortuno. It is a practical
heuristic. It is aligned with the broader literature direction where NFP
handles geometry and heuristic/metaheuristic search handles sequencing.

Initial scoring should reuse ideas already present in the project:

- keep used extents compact;
- prefer lower placements;
- prefer left placements;
- preserve future feasible area;
- penalize tiny unusable cavities;
- penalize high fragmentation of feasible placement space;
- prefer placements that increase contact without overlap.

Avoid relying only on local best area. NFP gives more candidates and therefore
more ways to make locally attractive mistakes. Beam width, GA diversity, and
scoring diversity matter.

## GA Search Model

Recommended chromosome fields:

- permutation of prepared piece ids;
- rotation choice per piece from the finite rotation set;
- optional placement policy id, e.g. compact, preserve-free, contact-heavy.

Recommended initial population:

- current `sortPiecesForNesting` order;
- first-fit-decreasing by convex hull area, longest edge, height, width, and
  imbalance;
- a few strategy-derived permutations that put awkward/high-vertex pieces first;
- random swaps/inversions from those seeds.

Recommended mutations:

- swap two pieces;
- move one piece earlier/later;
- reverse a short subsequence;
- rotate one piece to another allowed angle;
- change placement policy id if that field is used.

Recommended crossover:

- order-preserving crossover for the permutation;
- per-piece rotation inherited from either parent, then occasionally mutated.

Fitness should stay lexicographic and conservative:

```text
(
  unplaced_count,
  sheets_used_or_partial_failure,
  -largest_future_feasible_region_score,
  feasible_region_fragmentation_score,
  used_cluster_area_or_width,
  max_used_sheet_ratio,
  normalized_used_span_sum,
  contact_bonus_as_negative,
  bottom_left_tie_breakers
)
```

For this app, preserving a large future usable region should rank ahead of pure
compactness once all pieces placed/unplaced status ties. That directly avoids
the bad local behavior where a visually compact contact placement fragments the
remaining sheet.

Beam and GA are complementary v2 modes, not a first/later split. Beam search is
the deterministic reference and gives inspectable partial-state history. GA can
outperform beam when the main mistake is early piece order, rotation, or policy
choice. The practical target is a portfolio:

```text
deterministic convex-NFP beam
  + time-budgeted GA/search using the same placement kernel and caches
  + final validator shared by both
```

## Free Space Model

The engine should not maintain "free polygons" as first-class sheet leftovers
in the same way MaxRects maintains free rectangles.

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
- compute convex hulls from sampled points using robust predicates for turn
  tests;
- normalize hulls to a stable local placement point;
- offset hulls by `padding / 2 + epsilon` through the Clipper2 adapter;
- compute area and bounding box;
- run pairwise intersection tests;
- run final clearance validation on sample placements;
- wrap official Clipper2 C++ behind a geometry adapter exposed through
  WASM/native bindings;
- add robust predicates for any app-owned orientation, intersection,
  containment, and boundary classification not delegated to Clipper2;
- encode deterministic rules for touching, equal scores, duplicate candidates,
  and boundary points.

Acceptance:

- triangles, trapezoids, rectangles, stars, circles approximated as polygons;
- padded polygons visually inspectable in the renderer;
- deterministic real-valued output and stable edge-case classification;
- final validation catches intentional clearance violations.

### Adaptive Rotation Generator

Goal: generate strong bounded rotation candidates for each convex collision
polygon.

Tasks:

- include baseline orthogonal rotations when allowed;
- compute stable edge-alignment angles from long convex-hull edges;
- compute principal-axis / oriented-bounding-box angles;
- deduplicate angles by tolerance;
- cap the candidate set per piece and expose diagnostics for discarded angles;
- cache rotated collision polygons by geometry digest and rotation.

Acceptance:

- diagonal and elongated pieces receive useful non-orthogonal rotations;
- tiny flattened curve segments do not explode the rotation set;
- repeated runs produce identical rotation lists;
- NFP cache keys include the selected rotation.

### Pairwise NFP And IFP

Goal: understand and test NFP semantics with real project shapes.

Tasks:

- compute or approximate NFP for two padded polygons and fixed rotations;
- compute IFP for a rotated piece inside the sheet;
- expose debug visualization of placement-space NFP;
- generate contact candidate points from NFP boundary;
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
- for each candidate piece and rotation, compute feasible placement points from
  IFP minus NFP union;
- score successors;
- keep top beam states;
- emit history frames with polygon placements and optional placement-space
  diagnostics.

Acceptance:

- triangle-heavy cases beat rectangle MaxRects on utilization;
- final validator proves padding;
- fallback handles invalid/empty feasible regions honestly;
- no fake placements or fake history.

### GA/Search Portfolio

Goal: improve order, rotation, and policy choices using the same placement
kernel as the beam mode.

Tasks:

- encode chromosomes as piece permutation, rotation index per piece, and
  placement policy id;
- seed the population with deterministic orders and rotation choices;
- add swap, move, subsequence-reversal, rotation, and policy mutations;
- use order-preserving crossover for piece permutations;
- rank decoded layouts with the same lexicographic final score family;
- respect a time budget and return the best validated layout.

Acceptance:

- GA results are reproducible when seeded;
- every GA layout is produced by the shared placement kernel, not raw coordinate
  genes;
- the best GA result can tie or beat deterministic beam on benchmark jobs;
- failed or partial GA runs are reported honestly.

### Multi-Plate And CSV Integration

Goal: preserve current subrun/CSV behavior while switching the geometry engine.

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

## Risks

### Geometry Robustness

Polygon offsetting and NFP generation are the main technical risks. Concave
polygons, holes, near-collinear edges, tiny segments, and self-intersections can
create invalid output.

Mitigation:

- official Clipper2 C++ behind a local geometry adapter;
- robust predicates for app-owned geometric truth decisions outside Clipper2;
- deterministic boundary/tie-breaking rules;
- simplify input polygons with tolerance;
- conservative offset epsilon;
- final validation;
- visual debug overlays.

### Candidate Explosion

NFP creates many candidates, especially with many pieces and rotations.

Mitigation:

- finite adaptive rotation set with dedupe and per-piece caps;
- top-N candidate pruning per piece;
- broad-phase bounding boxes;
- NFP cache by shape pair and rotation pair;
- beam width cap;
- GA population/time budget cap;
- time budget with honest partial results.

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

- Which rotation set is acceptable for the shop workflow?
- Is mirroring physically allowed, or only rotation?
- Should padding mean total clearance between cuts, or clearance around each
  piece? Current rectangle semantics imply total clearance.
- What flattening tolerance is acceptable for DXF arcs/circles?
- Does v2 target fixed sheet nesting or strip-length minimization?
- Should exact MIP be kept only as a benchmark/offline experiment, or ignored
  until the heuristic engine is mature?

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
  IFP(sheet, moving piece)
  minus union of NFP(placed piece, moving piece)
```

NFP gives feasible/contact candidate positions. Beam and GA/search modes choose
among them through the shared placement kernel. Padding is handled by inflated
collision polygons, robust geometric decisions, deterministic edge-case rules,
and final validation.

The recommended path is to build a direct NFP-based irregular nesting engine,
with adaptive finite rotations, deterministic beam search, and a time-budgeted
GA/search portfolio. Cluster-to-rectangles work is optional/non-v2 experimental
work and should not become the architectural destination.
