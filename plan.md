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
- Clipper2 documentation, for practical polygon clipping/offsetting and integer
  coordinate robustness.
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

## Terms

### Cut Polygon

The true shape outline used for rendering and export. For DXF curves, this may
remain the original DXF geometry for export, while the nesting engine receives a
flattened polygon approximation.

### Collision Polygon

The cut polygon inflated by clearance. This is the geometry used for overlap
tests, NFP generation, and candidate validity.

### Placement Point

A fixed reference point used to describe a placed polygon. This should be a
single convention across the engine, for example the lower-left corner of the
collision polygon bounding box in local coordinates.

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
sides. For irregular polygons, mirror that semantics:

```text
clearance = padding
collisionOffset = padding / 2 + epsilon
collisionPolygon = offset(cutPolygon, collisionOffset)
```

If two collision polygons touch, their real cut polygons have at least roughly
`padding + 2 * epsilon` between them.

If product semantics change to "padding around each piece", then the offset
would be full padding rather than half padding. For current app semantics,
half-padding is the correct continuity with rectangle preparation.

For the sheet border:

```text
collisionPolygon must be inside sheet
```

This is equivalent to shrinking usable sheet space by the same clearance, but it
is easier to express as an IFP constraint.

Score reporting should be explicit:

- packing/collision uses collision polygons;
- utilization reporting should normally use real cut polygon area;
- envelope/bounds scoring may use collision bounds because that reflects actual
  machine clearance consumption.

## Rounding And Numerical Robustness

The engine should not rely on floating-point equality.

Use an internal integer precision grid:

```text
1 mm = 1000 internal units
10 mm padding = 10000 internal units
epsilon = 50 or 100 internal units, i.e. 0.05mm or 0.1mm
```

All derived nesting geometry should be integer-grid geometry:

- flattened vertices;
- offsets;
- intersections;
- NFP vertices;
- candidate placement points;
- final transforms.

This matches the practical direction of robust polygon libraries such as
Clipper2, which performs clipping using integer coordinates internally for
robustness.

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

Before accepting a result, run a final validation pass:

```text
for every placed pair:
  distance(realGeometryA, realGeometryB) >= padding - tolerance

for every placed piece:
  collisionPolygon is inside sheet
```

The conservative offset should make this pass comfortably. If it fails, the
result is invalid even if the heuristic thought it was valid.

## Rotation Set

Do not search continuous rotation first.

Start with finite rotations:

```text
0, 90
```

If free rotation is enabled, add:

```text
0, 90, 180, 270
```

Later add shape-derived angles:

- edge angles that make an edge horizontal or vertical;
- principal-axis angles for elongated shapes;
- configured machine-safe angles if the cutting workflow has constraints.

This is a controlled approximation. Arbitrary continuous rotation can be added
later as local refinement, but it should not be the first implementation.

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
- optionally a small integer-grid fallback around best points.

Every candidate must be validated:

```text
translated moving polygon is inside sheet
translated moving polygon does not overlap any placed collision polygon
```

The NFP is a candidate generator and broad feasibility map. Validation remains
mandatory because polygon operations, simplification, and tolerances can fail.

## Optimizer

The optimizer should stay close to the current worker architecture.

For each beam state:

```text
for each remaining piece:
  for each allowed rotation:
    generate NFP/IFP candidate points
    score candidate placements
keep top K successor states
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
more ways to make locally attractive mistakes. Beam width and scoring diversity
matter.

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

For performance, cache:

- NFPs for shape-pair plus rotation-pair;
- IFPs for sheet plus shape rotation;
- bounding boxes for broad-phase rejection;
- unioned forbidden regions per beam state when feasible.

## Option A: Transitional NFP Clustering Then Rectangles

This is the safer first prototype.

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

This should be considered a prototype or interim feature, not the final target.

## Option B: Direct NFP-Based Irregular Nesting

This is the recommended long-term direction.

Pipeline:

```text
input pieces
  -> derive cut/collision polygons
  -> worker beam search over irregular placements
  -> candidate generation via IFP/NFP placement regions
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

Do not make clustering the main architecture. Use clustering only as an optional
enhancement after the NFP geometry layer exists, or as a short-lived prototype
if the project needs a fast triangle improvement before the full optimizer.

The reason is simple: the real problem is irregular nesting. If we introduce
NFP only to make better rectangles, we will still be fighting rectangle
artifacts. The cleaner model is to let polygons be the occupied geometry and
let NFP/IFP define feasible placement space.

## Implementation Phases

### Phase 1: Geometry Kernel Spike

Goal: prove robust polygon operations outside the worker optimizer.

Tasks:

- flatten DXF-supported geometry to polygons at a configurable tolerance;
- normalize local polygons to a stable placement point;
- offset polygons by `padding / 2 + epsilon`;
- compute area and bounding box;
- run pairwise intersection tests;
- run final clearance validation on sample placements;
- choose or wrap a polygon library, likely Clipper2 or a JavaScript/WASM
  equivalent that supports integer-coordinate clipping and offsetting.

Acceptance:

- triangles, trapezoids, rectangles, stars, circles approximated as polygons;
- padded polygons visually inspectable in the renderer;
- deterministic integer-grid output;
- final validation catches intentional clearance violations.

### Phase 2: Pairwise NFP Prototype

Goal: understand and test NFP semantics with real project shapes.

Tasks:

- compute or approximate NFP for two padded polygons and fixed rotations;
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

### Phase 3: Single-Sheet NFP Constructive Solver

Goal: replace free rectangles for one run while keeping the worker/history
contract recognizable.

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

### Phase 4: Multi-Plate And CSV Integration

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

### Phase 5: Optional Clustering

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

- integer grid;
- simplify input polygons with tolerance;
- conservative offset epsilon;
- robust library;
- final validation;
- visual debug overlays.

### Candidate Explosion

NFP creates many candidates, especially with many pieces and rotations.

Mitigation:

- finite rotation set;
- top-N candidate pruning per piece;
- broad-phase bounding boxes;
- NFP cache by shape pair and rotation pair;
- beam width cap;
- time budget with honest partial results.

### Local Minima

More accurate geometry can still produce globally worse layouts if the scoring
prefers a bad early contact.

Mitigation:

- beam search rather than greedy single path;
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
- Does the first irregular solver target fixed sheet nesting or strip-length
  minimization?
- Should exact MIP be kept only as a benchmark/offline experiment, or ignored
  until the heuristic engine is mature?

## Non-Goals For The First Irregular Version

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

NFP gives feasible/contact candidate positions. Beam search or another
heuristic chooses among them. Padding is handled by inflated collision polygons
on an integer precision grid, with conservative epsilon and final validation.

The recommended path is to build a direct NFP-based irregular nesting engine,
with optional clustering later. A cluster-to-rectangles prototype is acceptable
as a short-term triangle improvement, but it should not become the architectural
destination.
