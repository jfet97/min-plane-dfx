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
- portfolio progress and result envelopes.

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
instead of inventing a collision polygon. Transform choices remain the
responsibility of the unimplemented `TransformGenerator`. The remaining algorithm
services, except for the in-memory cache, fail with
`IrregularNestingNotImplementedError`. This is deliberate: the app must not emit
fake placements, fake NFPs, fake scores, or fake history.

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

Algorithm implementations should fill these service boundaries later:

- DXF-to-polygon flattening;
- convex hull and offset;
- transform generation;
- convex NFP/IFP candidate generation;
- placement validation;
- priority ordering;
- windowed beam;
- GA/search;
- free-material polygon construction and scoring.

Until their algorithms are implemented, the remaining service boundaries stay
as honest infrastructure-only failures.
