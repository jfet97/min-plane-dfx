# Irregular V2 Infrastructure

Irregular v2 infrastructure is present as typed boundaries only. It must not be
treated as a working nesting engine until the geometry and search algorithms are
implemented intentionally.

## Shared DTOs

`src/shared/irregular/` owns schema-backed DTO classes and default constants for
the convex irregular engine shell:

- collision and transformed geometry shapes;
- placement transforms;
- geometry settings;
- optimizer settings;
- cache keys;
- portfolio progress and result envelopes;
- free-material regions with explicit boundaries and holes.

These DTOs are named app payloads and should stay aligned with the rest of
`src/shared/domain/`: use `Schema.Class` for exported data shapes. Service
contracts may still use interfaces for operation inputs because those are
dependency boundaries, not persisted payloads.

## Worker Services

`src/workers/irregular/` owns Effect service tags for the future engine:

- `GeometryKernel`;
- `CollisionGeometryBuilder`;
- `TransformGenerator`;
- `NfpIfpService`;
- `FreeMaterialService`;
- `PriorityOrderService`;
- `IrregularNestingPortfolio`;
- `GeometryCache`.

`src/workers/algorithm/irregular/strictPriorityDecoder.ts` is an algorithm
module rather than another Effect service. `decodeStrictPriorityOrder` consumes
an already priority-ordered list, transforms each piece's existing transform
candidates in deterministic metadata order, and asks `NfpIfpService` for legal
candidates against the real placed collision geometries. It chooses by
the local balanced-compactness score, then translated candidate bottom/left and
transform `(index, rotationDeg, mirrored, reason)`, retains the chosen
transformed geometry for later candidates, and records an ordinary no-fit piece
as unplaced before continuing. Transform indexes are normally unique because
`TransformGenerator` emits them that way; the complete tie-break keeps malformed
or replayed input deterministic.

This is an intermediate strict-order decoder, not the future windowed beam or
portfolio result. It does not generate transforms, reorder pieces, score
layouts, prune a beam, emit history, or invent placement data. Candidate
generation and direct placement validation remain the legality authority. The
decoder uses `IrregularPlacementScorer.Live` only to compare those real legal
candidates with the first explicit local policy: balanced compactness of the
combined collision-polygon bounds, then translated bottom/left and stable
transform metadata ties. It does not yet use free-material metrics, a
short-side-fill policy, or any portfolio/layout score. A valid transformed
polygon that exceeds the sheet is an infeasible transform and produces zero
candidates, allowing the decoder to try the next supplied transform; invalid
geometry and invalid derived arithmetic remain typed failures. The supplied
order must remain untouched so future beam and portfolio layers can make their
priority decisions outside this baseline.

`GeometryKernel.Live` currently implements DXF source flattening, convex hull,
strictly convex polygon offsetting, and transformation of one padded collision
polygon. Transforming validates the strictly convex collision boundary with
robust predicates, mirrors across the stable local Y axis first, then rotates
counter-clockwise around the unchanged placement reference; its output includes
the resulting local bounds. `CollisionGeometryBuilder.Live` composes flattening,
hulling, offsetting, and normalization for a closed imported outline: it
preserves source samples, rebases both derived polygons to the padded collision
polygon's lower-left bounds corner, and carries import warnings as diagnostics.
Offset derives its outward distance from half the caller-provided total padding
plus `clearanceSafetyMarginMm`. Invalid or non-convex geometry is rejected
instead of inventing a collision polygon. `TransformGeneratorLive` now emits
only a deterministic finite set of rotation/mirror metadata: orthogonal angles,
configured angles, and usable-edge alignments. For a convex polygon, the
minimum-area oriented bounding box always has a side parallel to a polygon edge,
so the complete edge-alignment set already contains every OBB orientation and
there is no separate redundant `oriented_bounds` reason. It does not transform
polygons or place pieces. Its
`transformMinimumEdgeLengthMm` setting means that edges shorter than the
configured physical millimeter threshold are ignored as geometric noise; the
default is `1`. Its
`transformAngleDeduplicationToleranceDeg` setting means that periodic angles
within that circular degree distance are treated as one candidate; the default
is `0.01` degrees. `configuredRotationDeg` defaults to an empty array and lets
the optimizer add finite degree values explicitly. `NfpIfpServiceLive` computes
convex no-fit boundaries, rectangular inner-fit bounds, and deterministic
contact candidates; every candidate still passes direct convex placement
validation, which remains the legality authority. The remaining algorithm
services, except for these geometry services and the in-memory cache, fail with
`IrregularNestingNotImplementedError`. This is deliberate: the app must not
emit fake placements, fake scores, or fake history. `FreeMaterialServiceLive`
computes the
sheet-space difference between the sheet and the union of translated placed
collision polygons through Clipper2's integer `Paths64` and `PolyTree64`
boundary. Its output groups each outer material boundary with its direct holes
for visualization and scoring; it is never used as placement legality or as an
implicit concave/hole-aware nesting feature.

## Current Integration State

`NestingOptions.workerMode` accepts both:

- `maxrects-beam-search`;
- `irregular-convex-v2`.

Normal requests, exported requests, project/workspace persistence, and CSV
run configuration can carry the irregular mode. `NestingRequest` also has an
optional `sourcePieces` payload so the irregular worker can receive the original
DXF geometry summaries instead of only rectangle-prepared pieces.

The worker is callable in this mode, but it currently returns an honest
`not_implemented` failure before MaxRects is reached. This keeps the vertical
path testable without fake placements, fake polygons, fake scores, or fake
history.

Do not route `irregular-convex-v2` requests to MaxRects.

The renderer has a compact irregular debug panel. It displays real available
inputs and empty diagnostic slots until worker events exist for flattened
polygons, collision polygons, free material, candidates, and irregular progress.

## Ownership

Geometry services remain under `src/workers/irregular/`. Placement selection,
scoring, beam state, and search belong under `src/workers/algorithm/`, including
the strict-priority decoder, local irregular scorer, and future beam/search
layers:

- priority ordering;
- placement candidate selection;
- windowed beam;
- scoring;
- GA/search.

`src/workers/algorithm/irregular/irregularPlacementScorer.ts` now owns the
dependency-free local balanced-compactness score for candidates already accepted
by NFP/IFP generation and direct validation. A separate layout score for beam
survivors and final beam/GA portfolio comparison remains future work.

Until those algorithms are implemented, the remaining service boundaries stay
as honest infrastructure-only failures. Free-material regions remain a
sheet-space diagnostic artifact and do not replace direct placement validation.
