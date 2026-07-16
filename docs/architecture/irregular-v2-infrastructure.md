# Irregular V2 Infrastructure

Irregular v2 has a real deterministic convex baseline. It flattens imported
closed outlines, builds padded convex collision polygons, generates finite
rotation/mirror choices, produces NFP/IFP contact candidates, validates each
placement directly, and runs a configurable windowed beam plus a bounded seeded
GA portfolio. It is not a concave/hole-aware nesting engine.

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

The verified derived-geometry hot path uses worker-private structural point,
bounds, polygon, and polygon-with-bounds records. Schema-backed geometry is
still accepted at service inputs and restored at output/cache boundaries; the
private records avoid class construction while preserving those contracts.

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
the configured local candidate policy, then translated candidate bottom/left
and transform `(index, rotationDeg, mirrored, reason)`, retains the chosen
transformed geometry for later candidates, and records an ordinary no-fit piece
as unplaced before continuing. Transform indexes are normally unique because
`TransformGenerator` emits them that way; the complete tie-break keeps malformed
or replayed input deterministic.

This is the strict-order baseline for the real windowed beam. It does not
generate transforms, reorder pieces, score layouts, prune a beam, emit history,
or invent placement data. Candidate
generation and direct placement validation remain the legality authority. The
decoder uses `IrregularPlacementScorer` only to compare those real legal
candidates with the requested explicit local policy: balanced compactness or
short-side fill of the combined collision-polygon bounds, then stable metadata
ties. It does not use free-material metrics to accept candidates; whole-layout
metrics remain a separate beam-retention and portfolio concern. A valid transformed
polygon that exceeds the sheet is an infeasible transform and produces zero
candidates, allowing the decoder to try the next supplied transform; invalid
geometry and invalid derived arithmetic remain typed failures. The supplied
order must remain untouched so future beam and portfolio layers can make their
priority decisions outside this baseline.

`GeometrySettings` yields one `IrregularNestingSettings` value containing both
geometry and optimizer settings. `GeometrySettings.Live` supplies the shared
defaults only; tests and future worker configuration can replace that layer with
arbitrary schema-validated settings. Algorithms yield the service instead of
accepting positional settings arguments, so each run has one configuration
source.

`IrregularOptimizerSettings` is the complete experiment surface. A request can
persist an `options.irregularSettings` value, which the worker supplies through
`GeometrySettings` for that run. It can independently vary `orderWindow`,
`beamWidth`, local-candidate fanout, transform limits and configured-angle
enablement, global rotation/mirror gates, local policy choices, GA population,
generation/evaluation/time budgets, seed, and the three chromosome-gene toggles
(priority order, transform preference, and policy). `gaEnabled`,
`baselineOnly`, or a zero GA budget retain the deterministic beam-only baseline.
This makes benchmark rows schema-validated and replayable without hidden
process-global knobs.

The concrete transform-profile factories are convenience bundles over those
persisted explicit settings, not a separate configuration model. Fast identity
(`cap1`) and orthogonal (`cap4`) disable configured and edge-derived angle
sources; derived orientation (`cap16`) enables both. Mirror safety gates remain
per job and per piece.

When `beamWidth > 1`, each step protects the exact width-one incumbent lineage
and uses the remaining slots for ranked alternatives. With all other settings
identical, this guarantees that the wider beam cannot finish with more unplaced
pieces than `beamWidth = 1`. This changes search retention only, not geometry
legality.

The shipped interactive profile is intentionally narrow: `orderWindow = 1`,
`beamWidth = 1`, local candidate fanout `= 1`, transform cap `= 1`, and GA
disabled. It produces a deterministic first result before broader beam or GA
experiments are deliberately enabled. Each invocation uses an independent
settings instance, so renderer and CSV editing cannot mutate a shared default.

The renderer separately persists one mirror-eligibility flag per imported source
shape. Both normal and CSV preparation copy that flag into every generated
`PreparedPiece`, and the global mirror gate must also be enabled before a
mirrored transform can be generated.

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
is `0.01` degrees. When global rotation or the prepared piece disables
rotation, it emits `0` degrees only. `configuredRotationDeg` defaults to an
empty array and lets the optimizer add finite degree values explicitly.
`NfpIfpServiceLive` defaults to the exact vertex-pair plus convex-hull
construction for correctness. The linear edge-merge constructor remains
available through the explicit `makeNfpIfpServiceLayer` and
`makeNfpIfpServiceLive` factories for benchmark and differential-test wiring;
its translated-ring canonicalization uses an exact hull fallback whenever the
O(n) pass cannot prove strict convexity. Both factories accept
`NfpConstructionAlgorithm` (`linear-edge-merge` or `vertex-pair-hull`) and
default to `vertex-pair-hull`; the linear edge-merge path is an explicit
differential/experimental construction, not the current performance default,
because safe translated-ring canonicalization can require an exact hull
fallback. Every candidate still passes direct
convex placement validation, which remains the legality authority. Reusable axis-aligned bounds
skip only provably disjoint NFP-boundary pairs, point-in-NFP checks, and
collision pairs; exact contacts and every non-disjoint case continue to robust
predicate classification. `FreeMaterialServiceLive`
computes the
sheet-space difference between the sheet and the union of translated placed
collision polygons through Clipper2's integer `Paths64` and `PolyTree64`
boundary. Its output groups each outer material boundary with its direct holes
for visualization and scoring. An exact point contact can appear as a repeated
non-adjacent vertex in a computed Clipper boundary; that winding is preserved
for its correct net diagnostic area, while source polygons remain strictly
unique-vertex validated. Free material is never used as placement legality or
as an implicit concave/hole-aware nesting feature.

## Current Integration State

`NestingOptions.workerMode` accepts both:

- `maxrects-beam-search`;
- `irregular-convex-v2`.

Normal requests, exported requests, project/workspace persistence, and CSV
run configuration can carry the irregular mode. `NestingRequest` also has an
optional `sourcePieces` payload so the irregular worker can receive the original
DXF geometry summaries instead of only rectangle-prepared pieces.

The worker runs `computeIrregularNesting` for this mode. It preserves prepared
copy ids and source ids, emits `IrregularLayout` transform placements with the
source-space placement reference required to reproduce each transform rather
than fabricated rectangle placements, and writes tagged `IrregularHistoryFrame`
records to the normal NDJSON history path. It replays the selected portfolio
chromosome when GA is enabled; a deterministic beam-only run records its
winning path during the single baseline decode. In either case it follows
explicit beam-state parent links from the terminal state back to the empty
state, so persisted and emitted history contains only the actual winning branch
rather than losing beam alternatives. Worker lifecycle and portfolio-progress
events are forwarded through the main-process supervisor to the renderer, which
shows the real current phase instead of a fake percentage. Missing source
geometry becomes the typed
`irregular_source_geometry_missing` worker failure; invalid derived geometry
and scoring become distinct typed failures.

Do not route `irregular-convex-v2` requests to MaxRects.

The renderer accepts tagged irregular history alongside existing rectangular
history. It redraws the original DXF segments using the stored placement
reference, mirror, rotation, and translation; a placement missing its source or
reference is reported as unrenderable rather than replaced with a rectangle.
The debug and history panels expose real result status, transforms, candidate
counts, free-material score metrics, unplaced ids, and diagnostics.

CSV/manual subruns preserve tagged irregular layouts and transforms while they
are aggregated. The rectangle CSV serializer rejects an irregular record only
at export time because its rows cannot represent a transform placement; regular
result JSON instead includes an explicit schema-validated irregular transform
export with source/copy ids, placement reference, transform, subrun metadata,
and CSV source-row links when available.

## Benchmark Corpus Contract

The standalone `benchmark:irregular` runner has named deterministic corpus cases
and search profiles so capacity-sensitive comparisons do not depend on hidden
process state. The current cases use the imported triangle/trapezoid set with
20 pieces on `500x300` and `550x300` sheets. The named profiles include narrow
and wider deterministic beams, a low-budget seeded GA same-count comparison,
and a bounded GA run that reaches all 20 pieces on the tighter sheet.
Named GA profiles use explicit generation/evaluation limits and a neutralized
large time sentinel rather than a 15-second wall-clock cutoff, so the seed and
those finite limits determine the comparison result.
For option precedence, an explicit CLI value overrides the selected profile,
which overrides general defaults. An explicit `--ga-enabled` also derives
`baselineOnly` to its inverse when `--baseline-only` is omitted; an explicit
`--baseline-only` value wins over that derivation, and the contradictory pair
`gaEnabled=true` plus `baselineOnly=true` is rejected.

Every measured row reports the elapsed time, placed and unplaced counts, the
terminal legality-audit status, and the complete whole-layout score. The score
is compared in this order:

1. lower `unplacedCount`;
2. higher `largestNetFreeMaterialRegionAreaMm2`;
3. lower `freeMaterialRegionCount`;
4. lower `freeMaterialHoleCount`;
5. lower `freeMaterialSliverMetric`;
6. lower `collisionBoundsWorstNormalizedSheetConsumption`;
7. lower `collisionBoundsNormalizedSpanSum`;
8. lower `collisionBoundsAreaMm2`;
9. lower `collisionBoundsSpanMm`.

Rows also include placement order and unplaced source ids for the scorer's
final deterministic tie-breaks. A terminal audit failure makes the row invalid;
placed count alone is not a quality result.

## Ownership

Geometry services remain under `src/workers/irregular/`. Placement selection,
scoring, beam state, and search belong under `src/workers/algorithm/`, including
the strict-priority decoder, local irregular scorer, layout scorer, windowed
beam, and seeded GA/search portfolio:

- priority ordering;
- placement candidate selection;
- windowed beam;
- scoring;
- GA/search.

`src/workers/algorithm/irregular/irregularPlacementScorer.ts` owns the local
candidate-policy score for candidates already accepted by NFP/IFP generation
and direct validation. `irregularLayoutScorer.ts` owns a separate lexicographic
whole-layout score for beam retention: unplaced count first, then free-material
usability/fragmentation metrics and compact collision bounds. Free material is
scoring-only and never accepts or rejects a placement. Before a beam step calls
that expensive scorer, it deduplicates successor states by canonical occupied
geometry and retains a deterministic representative. The run also retains its
scored beam states. A bounded cache owned by the layout-scorer service reuses
only Clipper2 free-material snapshots for identical sheet and occupied
geometry, including across portfolio decodes. When a cached parent state gains
one placement, it subtracts that collision polygon from the cached material
snapshot through the same integer-grid `PolyTree64` adapter; root, cache-miss,
and failed-incremental paths retain the full sheet-minus-occupied computation.
It always rebuilds the state-specific score so placement order and unplaced ids
remain correct. This removes duplicate Clipper2 work without changing legality,
score criteria, or the winning-path history.

`portfolioSearch.ts` owns chromosome construction, deterministic PRNG mutation,
crossover, evaluation/generation/time checkpoints, progress, cancellation, and
selection between the GA and beam results. Its transform gene is a preferred
candidate index with deterministic fallback to the remaining legal transforms;
it never encodes raw coordinates. `geometryCacheKeys.ts` namespaces transformed
geometry, pairwise NFP, and IFP artifacts by their complete geometry/settings
identity, and validates cached artifacts before reuse. Pairwise NFP keys use
canonical transformed fixed and moving polygon geometry plus transform, settings,
NFP operation, and construction algorithm identity; they deliberately exclude
piece ids and fixed sheet translation. The pairwise cache stores only the
relative NFP boundary, while `NfpIfpService` returns a fresh id-bearing result
after applying the current fixed translation. Free-material regions remain a
sheet-space diagnostic artifact and do not replace direct placement validation.
