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

The default layers are infrastructure only. Except for the in-memory cache, they
fail with `IrregularNestingNotImplementedError`. This is deliberate: the app
must not emit fake collision polygons, fake placements, fake NFPs, fake scores,
or fake history.

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

Until then, only infrastructure, settings, DTOs, and docs should depend on this
shell.
