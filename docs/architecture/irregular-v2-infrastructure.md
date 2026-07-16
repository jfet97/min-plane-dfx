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
still accepted at service inputs and restored at public-service outputs; cache
entries intentionally retain private records so hot cache hits avoid class
construction while preserving those public contracts.

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
candidates with the requested explicit local policy: balanced compactness,
short-side fill, or exact shared padded-edge contact followed by balanced
compactness. The contact policy measures only the collision envelopes already
accepted by direct validation, so its preferred edge mates preserve configured
source clearance. It does not use free-material metrics to accept candidates; whole-layout
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

### Decision Trace

When worker history is enabled, every irregular beam decode can synchronously
emit plain internal decision-event classes. The trace identifies the executed
baseline or GA chromosome and records generated legal candidates, named local
and whole-layout scores, local fanout decisions, successor deduplication, beam
retention or pruning, and the final winner. `historyMode: off` leaves the
callback absent, so normal benchmark decodes do not construct trace events.

The worker serializes these events as one JSON object per line in a separate
`<jobId>.decision-trace.ndjson` file. Replay history remains the selected
winning-state timeline used by the UI; the decision trace is a diagnostic audit
of alternatives that disappeared before the winner was chosen. Each decode uses
compact deterministic chromosome, state, and candidate ids while retaining its
decode id for correlation. The worker preserves event order while serializing
bounded batches instead of issuing one filesystem append per event.

The shipped interactive profile is intentionally narrow: `orderWindow = 1`,
`beamWidth = 1`, local candidate fanout `= 4`, transform cap `= 16`, and GA
disabled. It produces a deterministic first result while retaining enough real
local alternatives for the whole-layout scorer to reject obvious fragmentation.
Each invocation uses an independent settings instance, so renderer and CSV
editing cannot mutate a shared default.

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
convex placement validation, which remains the legality authority. Candidate
generation indexes NFP boundaries and boundary segments using inclusive
axis-aligned overlap, so it skips only pairs whose bounds prove that no contact
can occur. Candidate points are canonicalized and deduplicated as they are
collected, and points or boundary pairs outside the IFP bounds are discarded
only when those bounds make them impossible candidates. Exact contacts and
every non-disjoint case continue to robust predicate classification, followed
by direct legality validation. `FreeMaterialServiceLive`
computes the
sheet-space difference between the sheet and the union of translated placed
collision polygons through Clipper2's integer `Paths64` and `PolyTree64`
boundary. Its output groups each outer material boundary with its direct holes
for visualization and scoring. An exact point contact can appear as a repeated
non-adjacent vertex in a computed Clipper boundary; that winding is preserved
for its correct net diagnostic area, while source polygons remain strictly
unique-vertex validated. Free material is never used as placement legality or
as an implicit concave/hole-aware nesting feature.

The alternative geometry paths are parity-gated experiments, not interchangeable
defaults. Focused tests compare NFP construction and free-material operations
using convex fixture-derived geometry across winding, transforms, padding, and
typed failures. A backend switch also requires the complete
`IrregularLayoutScorer` tuple: elapsed time and placed count alone are not a
quality equivalence proof. The hard benchmark corpus records exact score deltas
and serial elapsed-time medians. Its measured linear-edge-merge variations are
numerically negligible but have no broad speed advantage; direct difference is
exact-score equivalent but slower. The shipped vertex-pair-hull plus
union-then-difference defaults therefore remain unchanged.

`PlacedCollisionSpatialIndex` is a worker-private persistent uniform grid for
translated placed-collision bounds. Each beam state carries the index for its
branch and appends one committed placement when creating a successor; the
strict decoder follows the same append-only path. Grid queries are conservative:
large or non-finite cell ranges and invalid placed geometry remain in a fallback
set, and exact convex validation still decides legality.

NFP candidate generation deliberately iterates the supplied placed array; its
separate NFP-boundary `BoundsIndex` pruning remains the mainline/reference
differential path. The pre-Volta candidate reference supplies no spatial index
and therefore performs the original full placed-array legality checks. A
matched persistent index is used only by direct placement validation, where its
translated moving bounds can exclude disjoint placed entries before the same
exact positive-area overlap predicates run. A missing or mismatched index falls
back to the full placed array, so the optimization cannot use stale branch
state or change candidate legality.

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
reference, mirror, rotation, and translation, and can overlay the exact
translated padded collision hulls emitted by the worker. A placement missing
its source or reference is reported as unrenderable rather than replaced with
a rectangle.
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
20 pieces on `500x300` and `550x300` sheets, plus a raw skewed-quadrilateral
case with 12 pieces on `330x160`. The named profiles include narrow and wider
deterministic beams, a low-budget seeded GA same-count comparison, a bounded
GA run that reaches all 20 pieces on the tighter sheet, and same-count beam
profiles for the raw skewed-quadrilateral case.
Named GA profiles use explicit generation/evaluation limits and a neutralized
large time sentinel rather than a 15-second wall-clock cutoff, so the seed and
those finite limits determine the comparison result.
The skewed beam-1 and beam-4 profiles are executed through the shared runner
in tests; they place the same count with passing audits, while beam-4 produces
a strictly better whole-layout score.
For option precedence, an explicit CLI value overrides the selected profile,
which overrides general defaults. An explicit `--ga-enabled` also derives
`baselineOnly` to its inverse when `--baseline-only` is omitted; an explicit
`--baseline-only` value wins over that derivation, and the contradictory pair
`gaEnabled=true` plus `baselineOnly=true` is rejected.

Every invocation emits a `provenance` JSON record containing `baselineSha`,
`variantSha`, Node and pnpm versions, platform, architecture, host identifier,
UTC timestamp, exact replay command, and the benchmark runner version. The
record also contains `baselineRevision` and `variantRevision`, each recording
the verified full SHA (or `null` with an `unavailable` source), the requested
CLI/environment value or default ref, and the source used to resolve it. The
baseline revision defaults to `origin/main` and the variant revision to `HEAD`;
explicit CLI values and the corresponding environment variables must be full
40-character commit SHAs that resolve to commits in the current repository.
When both revisions resolve, `exactCommand` pins those SHAs for replay; if
either revision is unavailable, `exactCommand` is `null` rather than claiming
an exact replay command. A
`resolvedProfileSettings` JSON record follows it and contains the complete
resolved CLI/profile settings, including fixture and piece budgets, search
controls, GA controls, and measurement counts.
Corpus id and area bounds are included only when the resolved fixture order,
repeat count, piece count, sheet dimensions, and padding exactly match a
declared corpus case; otherwise those corpus-specific fields are omitted.

Each corpus case also carries raw polygon areas and axis-aligned bounding-box
areas measured from its checked-in DXF source geometry. The triangle/trapezoid
fixtures declare areas `3150` and `6375` square millimeters with bounding-box
areas `6300` and `8625`; the skewed quadrilateral declares `3200` and `4400`.
The runner-side bound reports the total raw piece area as a necessary lower
bound, the summed axis-aligned box area as a conservative packing diagnostic,
the sheet area, and both slacks. Passing the raw-area condition is necessary
but not sufficient for legal nesting; the raw skewed-quadrilateral case has a
deterministic 3-by-4 grid witness whose `12 * 110 * 40` bounding-box area
exactly equals its `330 * 160` sheet area.

Every measured row reports the elapsed time, placed and unplaced counts, the
terminal legality-audit status, and the complete whole-layout score. The score
is compared in this order:

1. lower `unplacedCount`;
2. higher whole `sharedCollisionBoundaryContactBand`, where each polygon-pair
   contact is normalized by the smaller polygon's longest collision edge;
3. lower `collisionBoundsWorstNormalizedSheetConsumption`;
4. lower `collisionBoundsNormalizedSpanSum`;
5. lower `collisionBoundsAreaMm2`;
6. lower `collisionBoundsSpanMm`;
7. lower `occupiedHullWasteRatio`;
8. higher normalized contact units, then exact shared boundary length, only
   after compactness has decided within the same whole-contact band;
9. lower collision-bound `minY`, then `minX`, to anchor equivalent layouts at lower-left;
10. higher `largestNetFreeMaterialRegionAreaMm2`;
11. lower `freeMaterialRegionCount`;
12. lower `freeMaterialHoleCount`;
13. lower `freeMaterialSliverMetric`.

Collision-bound compactness intentionally comes before free-material diagnostics:
when every piece stays within one connected sheet region, the total free area is
nearly constant and small Clipper2 quantization differences must not steer the
beam toward a looser cluster. Collision-bound width, height, `minX`, and `minY`
are first canonicalized to an explicit `0.001 mm` score grid. This removes
floating subtraction noise that can otherwise make translated but identical
layouts compare differently at large sheet coordinates; it is deterministic
quantization at the existing collision-geometry precision, not an epsilon
comparison. Lower-left anchoring then precedes free-material diagnostics so
symmetric placement is not selected by fragmentation noise.

Rows also include placement order and unplaced source ids for the scorer's
final deterministic tie-breaks. A terminal audit failure makes the row invalid;
placed count alone is not a quality result.

Benchmark rows also include a `gaMetrics` JSON record that stays outside worker
protocols and product output. `scheduledEvaluationSlots` and
`distinctChromosomeKeys` describe GA-loop scheduling; evaluated-chromosome cache
hits and misses distinguish reused results from new work. `actualFullBeamDecodes`
includes the deterministic baseline plus every cache miss that starts a decoder.
The decoded-beam elapsed and candidate totals aggregate successful baseline and
GA phase measurements, while final reconstruction and final-score timings
measure materializing the selected portfolio result separately. These counters
are benchmark-only and do not alter optimizer decisions, scores, or legality.
Candidate totals are read from completed decoder results rather than step-time
callbacks. During GA search, the portfolio reimburses only metrics collection
and benchmark phase callbacks against the search deadline before scheduling the
next evaluation, so opt-in reporting cannot change time-budget termination.

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
whole-layout score for beam retention: unplaced count first, then shared padded
boundary, compact collision bounds, occupied-hull waste, lower-left anchoring, and free-material
usability/fragmentation diagnostics. Free material is scoring-only and never
accepts or rejects a placement. Before a beam step calls
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
selection between the GA and beam results. GA initialization always puts the
deterministic priority-ordered chromosome first as the greedy incumbent. The
remaining initial chromosomes use deterministic single-gene and multi-gene
mutation strata derived from `gaSeed`, deduplicate when alternatives are
available, and fall back to the incumbent only when the configured gene space
cannot produce enough distinct chromosomes. Every later generation carries the
same incumbent forward, and final portfolio selection compares it with every
GA result, so broader search cannot discard a baseline result. Its transform
gene is a preferred candidate index with deterministic fallback to the
remaining legal transforms; it never encodes raw coordinates. Portfolio
selection uses the same `IrregularLayoutScorer` ordering as beam retention,
including placement order and unplaced source ids as final deterministic
tie-breaks; the incumbent preference applies only on a complete score tie.
`geometryCacheKeys.ts` namespaces transformed geometry, pairwise NFP, and IFP
artifacts by their complete geometry/settings identity, and validates cached
artifacts before reuse. Pairwise NFP keys use
canonical transformed fixed and moving polygon geometry plus transform, settings,
NFP operation, and construction algorithm identity; they deliberately exclude
piece ids and fixed sheet translation. The pairwise cache stores only the
relative NFP boundary, while `NfpIfpService` returns a fresh id-bearing result
after applying the current fixed translation. Free-material regions remain a
sheet-space diagnostic artifact and do not replace direct placement validation.
