/** Schema-backed contracts for convex irregular nesting geometry and search data. */
import { Effect, Schema } from 'effect'
import { ImportedPiece } from '@shared/domain/dxf.js'
import { JobId, PieceId } from '@shared/domain/ids.js'
import { SheetSpec } from '@shared/domain/nesting.js'

/** Identifies the convex irregular worker implementation. */
export const IrregularWorkerMode = Schema.Literal('irregular-convex-v2')

/** Type of the convex irregular worker identifier. */
export type IrregularWorkerMode = Schema.Schema.Type<typeof IrregularWorkerMode>

/** Explains why a transform candidate was included in the finite transform set. */
export const IrregularTransformReason = Schema.Literals([
  'orthogonal',
  'edge_alignment',
  'configured'
])

/** Type of a transform-candidate reason. */
export type IrregularTransformReason = Schema.Schema.Type<typeof IrregularTransformReason>

/** Names the phase reported by the irregular search portfolio. */
export const IrregularPortfolioPhase = Schema.Literals([
  'preparing_geometry',
  'deterministic_beam',
  'ga_search',
  'shared_archive',
  'short_side_profile',
  'validating',
  'completed',
  'cancelled'
])

/** Type of an irregular portfolio phase. */
export type IrregularPortfolioPhase = Schema.Schema.Type<typeof IrregularPortfolioPhase>

/** Identifies which search source produced a portfolio result. */
export const IrregularSearchSource = Schema.Literals(['beam', 'ga', 'shared-archive', 'none'])

/** Type of an irregular portfolio search source. */
export type IrregularSearchSource = Schema.Schema.Type<typeof IrregularSearchSource>

/** Explicit local policies used to rank already-legal placement candidates. */
export const IrregularPlacementPolicyId = Schema.Literals([
  'balanced-compactness',
  'short-side-fill',
  'edge-contact-then-balanced-compactness'
])

/** Type of a configured irregular local placement policy. */
export type IrregularPlacementPolicyId = Schema.Schema.Type<typeof IrregularPlacementPolicyId>

/** Selects the terminal objective applied after protected Compact construction settles. */
export const IntrinsicObjectiveProfileId = Schema.Literals(['compact', 'short-side'])

/** Type of the production Compact objective profile. */
export type IntrinsicObjectiveProfileId = Schema.Schema.Type<typeof IntrinsicObjectiveProfileId>

/** Stable default local policy retained for the deterministic beam baseline. */
export const DEFAULT_IRREGULAR_PLACEMENT_POLICY_ID: IrregularPlacementPolicyId =
  'balanced-compactness'

/** Stable policy choices available to the irregular portfolio by default. */
export const DEFAULT_IRREGULAR_PLACEMENT_POLICY_IDS: ReadonlyArray<IrregularPlacementPolicyId> = [
  'balanced-compactness',
  'short-side-fill',
  'edge-contact-then-balanced-compactness'
]

/** Finite real-valued number used by irregular geometry contracts. */
const FiniteNumber = Schema.Finite

/** Finite non-negative millimeter distance used by irregular geometry settings. */
export const NonNegativeFiniteMillimeters = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))

/** Finite non-negative scalar used by whole-layout score summaries. */
const NonNegativeFiniteNumber = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))

/** Finite positive millimeter distance used for flattening tolerances. */
export const PositiveFiniteMillimeters = Schema.Finite.check(Schema.isGreaterThan(0))

/** Finite positive angular tolerance measured in degrees. */
const PositiveFiniteDegrees = Schema.Finite.check(Schema.isGreaterThan(0))

/** Finite rotation value measured in degrees before periodic normalization. */
const FiniteDegrees = Schema.Finite

/** Finite non-negative integer used for indexed irregular controls. */
const NonNegativeFiniteInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/** Finite positive integer used for bounded irregular controls. */
const PositiveFiniteInteger = Schema.Int.check(Schema.isGreaterThan(0))

/** Default local candidate fanout for the first deterministic irregular result. */
export const DEFAULT_IRREGULAR_LOCAL_CANDIDATE_FANOUT = 4

/** Default number of GA generations for an explicitly enabled experiment. */
export const DEFAULT_IRREGULAR_GA_GENERATION_BUDGET = 2

/** Default deterministic GA evaluation cap for an explicitly enabled experiment. */
export const DEFAULT_IRREGULAR_GA_EVALUATION_BUDGET = 24

/** Terminal status of an irregular nesting portfolio. */
export const IrregularPortfolioStatus = Schema.Literals([
  'completed',
  'budget-expired',
  'cancelled',
  'no-valid-result'
])

/** Type of an irregular portfolio terminal status. */
export type IrregularPortfolioStatus = Schema.Schema.Type<typeof IrregularPortfolioStatus>

/** Concrete condition that ended one irregular portfolio run. */
export const IrregularPortfolioTerminationReason = Schema.Literals([
  'ga_disabled',
  'generation_budget',
  'evaluation_budget',
  'time_budget',
  'cancelled',
  'shared_archive_completed',
  'capacity_subset_settled',
  'no_valid_result'
])

/** Type of the concrete condition that ended one irregular portfolio run. */
export type IrregularPortfolioTerminationReason = Schema.Schema.Type<
  typeof IrregularPortfolioTerminationReason
>

/** One finite source or collision-geometry coordinate in millimeters. */
export class IrregularPoint extends Schema.Class<IrregularPoint>('IrregularPoint')({
  x: FiniteNumber,
  y: FiniteNumber
}) {}

/**
 * Ordered finite bounds in the coordinate system of the associated geometry.
 * The minimum values may equal the maximum values for a degenerate derived
 * artifact, but they may never exceed them.
 */
const IrregularBoundsFields = Schema.Struct({
  minX: FiniteNumber,
  minY: FiniteNumber,
  maxX: FiniteNumber,
  maxY: FiniteNumber
}).check(
  Schema.makeFilter((bounds) =>
    bounds.minX <= bounds.maxX && bounds.minY <= bounds.maxY
      ? undefined
      : 'bounds minimums must not exceed their maximums.'
  )
)

/** Finite axis-aligned bounds for source, collision, or transformed geometry. */
export class IrregularBounds extends Schema.Class<IrregularBounds>('IrregularBounds')(
  IrregularBoundsFields
) {}

/** A polygon represented by finite vertices without an implicit closing vertex. */
export class IrregularPolygon extends Schema.Class<IrregularPolygon>('IrregularPolygon')({
  points: Schema.Array(IrregularPoint)
}) {}

/**
 * Optional translated collision hulls retained for result and history display.
 * When present, their order exactly matches the associated placement array;
 * older persisted results omit the field and decode to an empty array.
 */
const IrregularCollisionPolygons = Schema.Array(IrregularPolygon).pipe(
  Schema.optionalKey,
  Schema.withConstructorDefault(Effect.succeed([])),
  Schema.withDecodingDefaultKey(Effect.succeed([]))
)

/** A finite translation, rotation, and mirror transform for a placed piece. */
export class IrregularTransform extends Schema.Class<IrregularTransform>('IrregularTransform')({
  translateX: FiniteNumber,
  translateY: FiniteNumber,
  rotationDeg: FiniteNumber,
  mirrored: Schema.Boolean
}) {}

/**
 * One finite transform choice considered by the irregular optimizer. Rotation
 * values are intentionally not range-limited here: the worker canonicalizes
 * periodic values such as `-90` and `450` without changing their geometry.
 */
export class IrregularTransformCandidate extends Schema.Class<IrregularTransformCandidate>(
  'IrregularTransformCandidate'
)({
  index: NonNegativeFiniteInteger,
  rotationDeg: FiniteNumber,
  mirrored: Schema.Boolean,
  reason: IrregularTransformReason
}) {}

/**
 * Geometry preparation settings. Flattening tolerance is positive, and the
 * safety margin is at least that tolerance so inward curve-flattening sag is
 * covered by the collision offset.
 */
const IrregularGeometrySettingsFields = Schema.Struct({
  flatteningSagToleranceMm: PositiveFiniteMillimeters,
  clearanceSafetyMarginMm: NonNegativeFiniteMillimeters,
  geometryBackendId: Schema.NonEmptyString,
  geometryBackendVersion: Schema.NonEmptyString
}).check(
  Schema.makeFilter((settings) =>
    settings.clearanceSafetyMarginMm >= settings.flatteningSagToleranceMm
      ? undefined
      : {
          path: ['clearanceSafetyMarginMm'],
          issue: 'clearance safety margin must cover flattening sag tolerance.'
        }
  )
)

/** Geometry backend and conservative curve-flattening settings. */
export class IrregularGeometrySettings extends Schema.Class<IrregularGeometrySettings>(
  'IrregularGeometrySettings'
)(IrregularGeometrySettingsFields) {}

const IrregularOptimizerSettingsFields = Schema.Struct({
  /** Number of queued pieces each beam state may reorder at one decision point. */
  orderWindow: PositiveFiniteInteger,
  /** Maximum whole-layout states retained after every beam expansion. */
  beamWidth: PositiveFiniteInteger,
  /** Maximum legal local placements retained per eligible piece before beam scoring. */
  localCandidateFanout: PositiveFiniteInteger.pipe(
    Schema.optionalKey,
    Schema.withConstructorDefault(Effect.succeed(DEFAULT_IRREGULAR_LOCAL_CANDIDATE_FANOUT)),
    Schema.withDecodingDefaultKey(Effect.succeed(DEFAULT_IRREGULAR_LOCAL_CANDIDATE_FANOUT))
  ),
  /** Bounded terminal remove-and-reinsert iterations; zero disables local repair. */
  localRepairBudget: NonNegativeFiniteInteger.pipe(
    Schema.optionalKey,
    Schema.withConstructorDefault(Effect.succeed(0)),
    Schema.withDecodingDefaultKey(Effect.succeed(0))
  ),
  /** Runs the sheet-independent direct and periodic constructors under one exact archive. */
  intrinsicSharedArchiveEnabled: Schema.Boolean.pipe(
    Schema.optionalKey,
    Schema.withConstructorDefault(Effect.succeed(false)),
    Schema.withDecodingDefaultKey(Effect.succeed(false))
  ),
  /** Keeps ordinary Compact or applies the bounded Short Side terminal profile after it settles. */
  intrinsicObjectiveProfileId: IntrinsicObjectiveProfileId.pipe(
    Schema.optionalKey,
    Schema.withConstructorDefault(Effect.succeed('compact' as const)),
    Schema.withDecodingDefaultKey(Effect.succeed('compact' as const))
  ),
  /** Maximum orientation candidates emitted for one prepared collision polygon. */
  transformCap: PositiveFiniteInteger,
  /** Ordinary-path edge threshold; Compact derives a scale-aware value per collision polygon. */
  transformMinimumEdgeLengthMm: NonNegativeFiniteMillimeters.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(1))
  ),
  /** Ordinary-path angle tolerance; Compact derives a sag-bounded value per collision polygon. */
  transformAngleDeduplicationToleranceDeg: PositiveFiniteDegrees.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(0.01))
  ),
  /** Enables the explicit angles in configuredRotationDeg without disabling derived angles. */
  configuredRotationEnabled: Schema.Boolean.pipe(
    Schema.optionalKey,
    Schema.withConstructorDefault(Effect.succeed(true)),
    Schema.withDecodingDefaultKey(Effect.succeed(true))
  ),
  /** Enables geometry-derived edge-alignment angles. */
  edgeAlignmentEnabled: Schema.Boolean.pipe(
    Schema.optionalKey,
    Schema.withConstructorDefault(Effect.succeed(true)),
    Schema.withDecodingDefaultKey(Effect.succeed(true))
  ),
  /** Explicit finite rotation angles to add to the orthogonal and edge-derived choices. */
  configuredRotationDeg: Schema.Array(FiniteDegrees).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([]))
  ),
  /** Enables seeded GA portfolio evaluations after the deterministic beam baseline. */
  gaEnabled: Schema.Boolean.pipe(
    Schema.optionalKey,
    Schema.withConstructorDefault(Effect.succeed(false)),
    Schema.withDecodingDefaultKey(Effect.succeed(false))
  ),
  /** Keeps only the deterministic beam baseline regardless of other GA limits. */
  baselineOnly: Schema.Boolean.pipe(
    Schema.optionalKey,
    Schema.withConstructorDefault(Effect.succeed(true)),
    Schema.withDecodingDefaultKey(Effect.succeed(true))
  ),
  /** Number of chromosomes evaluated in every GA generation. */
  gaPopulation: PositiveFiniteInteger,
  /** Maximum number of generated GA populations; zero disables GA evaluation. */
  gaGenerationBudget: NonNegativeFiniteInteger.pipe(
    Schema.optionalKey,
    Schema.withConstructorDefault(Effect.succeed(DEFAULT_IRREGULAR_GA_GENERATION_BUDGET)),
    Schema.withDecodingDefaultKey(Effect.succeed(DEFAULT_IRREGULAR_GA_GENERATION_BUDGET))
  ),
  /** Maximum chromosome evaluations across all generations; zero disables GA evaluation. */
  gaEvaluationBudget: NonNegativeFiniteInteger.pipe(
    Schema.optionalKey,
    Schema.withConstructorDefault(Effect.succeed(DEFAULT_IRREGULAR_GA_EVALUATION_BUDGET)),
    Schema.withDecodingDefaultKey(Effect.succeed(DEFAULT_IRREGULAR_GA_EVALUATION_BUDGET))
  ),
  /** Wall-clock budget in milliseconds for GA evaluation; zero disables GA evaluation. */
  gaTimeBudgetMs: NonNegativeFiniteInteger,
  /** Stable seed used for deterministic chromosome initialization and mutation. */
  gaSeed: Schema.NonEmptyString,
  /** Lets GA mutate the prepared-piece priority order gene. */
  priorityOrderMutationEnabled: Schema.Boolean.pipe(
    Schema.optionalKey,
    Schema.withConstructorDefault(Effect.succeed(true)),
    Schema.withDecodingDefaultKey(Effect.succeed(true))
  ),
  /** Lets GA mutate the preferred transform index for each prepared piece. */
  transformPreferenceMutationEnabled: Schema.Boolean.pipe(
    Schema.optionalKey,
    Schema.withConstructorDefault(Effect.succeed(true)),
    Schema.withDecodingDefaultKey(Effect.succeed(true))
  ),
  /** Lets GA mutate the local candidate-scoring policy gene. */
  placementPolicyMutationEnabled: Schema.Boolean.pipe(
    Schema.optionalKey,
    Schema.withConstructorDefault(Effect.succeed(true)),
    Schema.withDecodingDefaultKey(Effect.succeed(true))
  ),
  /** Local policy used by the deterministic baseline and when the policy gene is disabled. */
  placementPolicyId: IrregularPlacementPolicyId.pipe(
    Schema.optionalKey,
    Schema.withConstructorDefault(Effect.succeed(DEFAULT_IRREGULAR_PLACEMENT_POLICY_ID)),
    Schema.withDecodingDefaultKey(Effect.succeed(DEFAULT_IRREGULAR_PLACEMENT_POLICY_ID))
  ),
  /** Distinct local policies available to the baseline and GA policy gene. */
  placementPolicyIds: Schema.Array(IrregularPlacementPolicyId)
    .check(Schema.isNonEmpty())
    .pipe(
      Schema.optionalKey,
      Schema.withConstructorDefault(Effect.succeed([...DEFAULT_IRREGULAR_PLACEMENT_POLICY_IDS])),
      Schema.withDecodingDefaultKey(Effect.succeed([...DEFAULT_IRREGULAR_PLACEMENT_POLICY_IDS]))
    )
}).check(
  Schema.makeFilter((settings) => {
    const placementPolicyIds =
      settings.placementPolicyIds ?? DEFAULT_IRREGULAR_PLACEMENT_POLICY_IDS
    const placementPolicyId =
      settings.placementPolicyId ?? DEFAULT_IRREGULAR_PLACEMENT_POLICY_ID
    if (!placementPolicyIds.includes(placementPolicyId)) {
      return {
        path: ['placementPolicyId'],
        issue: 'the selected placement policy must be allowed by placementPolicyIds.'
      }
    }
    if (new Set(placementPolicyIds).size !== placementPolicyIds.length) {
      return {
        path: ['placementPolicyIds'],
        issue: 'placementPolicyIds must not contain duplicates.'
      }
    }
    if (settings.intrinsicObjectiveProfileId === 'short-side') {
      const gaDisabled =
        settings.gaEnabled === false ||
        settings.baselineOnly === true ||
        settings.gaTimeBudgetMs === 0 ||
        (settings.gaGenerationBudget ?? DEFAULT_IRREGULAR_GA_GENERATION_BUDGET) === 0 ||
        (settings.gaEvaluationBudget ?? DEFAULT_IRREGULAR_GA_EVALUATION_BUDGET) === 0
      if (settings.intrinsicSharedArchiveEnabled !== true || !gaDisabled) {
        return {
          path: ['intrinsicObjectiveProfileId'],
          issue: 'the Short Side objective requires the protected Compact shared archive with GA inactive.'
        }
      }
      if (placementPolicyId === 'short-side-fill') {
        return {
          path: ['placementPolicyId'],
          issue: 'the Short Side objective cannot use the legacy short-side-fill beam policy.'
        }
      }
    }
    return undefined
  })
)

/**
 * Positive integer limits, finite-transform controls, and reproducibility
 * settings for irregular search.
 */
export class IrregularOptimizerSettings extends Schema.Class<IrregularOptimizerSettings>(
  'IrregularOptimizerSettings'
)(IrregularOptimizerSettingsFields) {}

/** Priority key retained from the user-owned prepared rectangle ordering. */
export class IrregularPriorityOrderKey extends Schema.Class<IrregularPriorityOrderKey>(
  'IrregularPriorityOrderKey'
)({
  longSideMm: NonNegativeFiniteNumber,
  areaMm2: NonNegativeFiniteNumber,
  imbalanceMm: NonNegativeFiniteNumber
}) {}

/** Complete geometry and optimizer configuration for one irregular run. */
export class IrregularNestingSettings extends Schema.Class<IrregularNestingSettings>(
  'IrregularNestingSettings'
)({
  geometry: IrregularGeometrySettings,
  optimizer: IrregularOptimizerSettings
}) {}

/** A diagnostic attached to an irregular geometry or portfolio artifact. */
export class CollisionGeometryDiagnostic extends Schema.Class<CollisionGeometryDiagnostic>(
  'CollisionGeometryDiagnostic'
)({
  code: Schema.String,
  message: Schema.String,
  pieceId: Schema.optional(PieceId)
}) {}

/** Flattened source samples and diagnostics before hull and offset derivation. */
export class FlattenedGeometry extends Schema.Class<FlattenedGeometry>('FlattenedGeometry')({
  sourcePieceId: PieceId,
  sampledPoints: Schema.Array(IrregularPoint),
  diagnostics: Schema.Array(CollisionGeometryDiagnostic)
}) {}

/**
 * Conservative collision geometry derived from one imported source piece.
 * Polygons are local to the stored padded placement reference.
 */
export class CollisionGeometry extends Schema.Class<CollisionGeometry>('CollisionGeometry')({
  /** Source piece that produced this derived collision artifact. */
  sourcePieceId: PieceId,
  /** Unpadded convex-hull bounds in original source coordinates. */
  sourceBounds: IrregularBounds,
  /** Flattened source points kept in original source coordinates for diagnostics. */
  sampledPoints: Schema.Array(IrregularPoint),
  /** Convex hull rebased to the collision polygon's placement origin. */
  convexHull: IrregularPolygon,
  /** Padded collision polygon whose lower-left bounds corner is local `(0, 0)`. */
  collisionPolygon: IrregularPolygon,
  /** Source-space coordinate of the padded collision bounds corner used as placement origin. */
  placementReference: IrregularPoint,
  /** Import and geometry diagnostics carried with this derived artifact. */
  diagnostics: Schema.Array(CollisionGeometryDiagnostic)
}) {}

/**
 * A transformed local collision polygon and its derived finite bounds.
 *
 * This is a trusted internal search artifact: it is produced by the geometry
 * kernel from already-decoded input, it never crosses the worker, IPC, or
 * persistence boundary, and it appears in no encoded schema. It is therefore a
 * plain class rather than a `Schema.Class`, because schema construction
 * revalidates the whole nested ring on every instantiation and the search
 * instantiates this per placement and per quarter turn.
 */
export class TransformedCollisionGeometry {
  readonly sourcePieceId: PieceId
  readonly transform: IrregularTransformCandidate
  readonly polygon: IrregularPolygon
  readonly bounds: IrregularBounds

  constructor(fields: {
    readonly sourcePieceId: PieceId
    readonly transform: IrregularTransformCandidate
    readonly polygon: IrregularPolygon
    readonly bounds: IrregularBounds
  }) {
    this.sourcePieceId = fields.sourcePieceId
    this.transform = fields.transform
    this.polygon = fields.polygon
    this.bounds = fields.bounds
  }
}

/** A source piece paired with its prepared collision geometry and transforms. */
export class IrregularPreparedPiece extends Schema.Class<IrregularPreparedPiece>(
  'IrregularPreparedPiece'
)({
  /** Prepared or copied identity; legacy payloads fall back to source.id. */
  pieceId: Schema.optional(PieceId),
  /** Search-equivalence class shared only by interchangeable prepared copies. */
  interchangeabilityKey: Schema.optional(Schema.NonEmptyString),
  source: ImportedPiece,
  allowMirror: Schema.Boolean,
  collisionGeometry: CollisionGeometry,
  transforms: Schema.Array(IrregularTransformCandidate),
  priorityOrderKey: Schema.optional(IrregularPriorityOrderKey)
}) {}

/**
 * A prepared piece transform retained as part of a final irregular placement.
 * Its translation positions `placementReference` after mirror-then-rotation
 * around that same source-space point.
 */
export class IrregularPlacement extends Schema.Class<IrregularPlacement>('IrregularPlacement')({
  /** Prepared or copied piece identity; new results must always emit this id. */
  pieceId: Schema.optional(PieceId),
  /** Original imported piece identity retained for source-geometry lookup. */
  sourcePieceId: PieceId,
  /** Source-space pivot for the transform; new worker results always emit it. */
  placementReference: Schema.optional(IrregularPoint),
  transform: IrregularTransform
}) {}

/**
 * A placed piece with the transformed collision geometry used for legality.
 *
 * Trusted internal search artifact, plain for the same reason as
 * {@link TransformedCollisionGeometry}. Only its `placement` is externally
 * visible, and that field remains a schema class because the worker result
 * emits it.
 */
export class IrregularPlacedPiece {
  readonly placement: IrregularPlacement
  readonly collisionGeometry: TransformedCollisionGeometry

  constructor(fields: {
    readonly placement: IrregularPlacement
    readonly collisionGeometry: TransformedCollisionGeometry
  }) {
    this.placement = fields.placement
    this.collisionGeometry = fields.collisionGeometry
  }
}

/**
 * Boundary schema for {@link TransformedCollisionGeometry}.
 *
 * The internal artifact is a plain class, so untrusted boundaries that carry it
 * — imported JSON and replay NDJSON — validate against this schema instead.
 * Keep the two shapes in step; `tests/unit/irregularSchemaContracts.test.ts`
 * asserts they agree.
 */
export const TransformedCollisionGeometrySchema = Schema.Struct({
  sourcePieceId: PieceId,
  transform: IrregularTransformCandidate,
  polygon: IrregularPolygon,
  bounds: IrregularBounds
})

/** Boundary schema for {@link IrregularPlacedPiece}. */
export const IrregularPlacedPieceSchema = Schema.Struct({
  placement: IrregularPlacement,
  collisionGeometry: TransformedCollisionGeometrySchema
})

/**
 * A candidate placement point plus its transform and diagnostics.
 *
 * Trusted internal search artifact: candidate generation emits one per legal
 * grid point and nothing outside the worker consumes it, so it is plain for the
 * same reason as {@link IrregularPlacedPiece}.
 */
export class IrregularPlacementCandidate {
  readonly pieceId: PieceId
  readonly transform: IrregularTransformCandidate
  readonly point: IrregularPoint
  readonly diagnostics: ReadonlyArray<CollisionGeometryDiagnostic>

  constructor(fields: {
    readonly pieceId: PieceId
    readonly transform: IrregularTransformCandidate
    readonly point: IrregularPoint
    readonly diagnostics: ReadonlyArray<CollisionGeometryDiagnostic>
  }) {
    this.pieceId = fields.pieceId
    this.transform = fields.transform
    this.point = fields.point
    this.diagnostics = fields.diagnostics
  }
}

/** A no-fit polygon boundary in moving-placement-coordinate space. */
export class IrregularNfp extends Schema.Class<IrregularNfp>('IrregularNfp')({
  fixedPieceId: PieceId,
  movingPieceId: PieceId,
  boundary: IrregularPolygon
}) {}

/** A rectangular inner-fit bound for one transformed moving piece. */
export class IrregularIfpBounds extends Schema.Class<IrregularIfpBounds>('IrregularIfpBounds')({
  sheet: Schema.suspend(() => SheetSpec),
  movingPieceId: PieceId,
  bounds: IrregularBounds
}) {}

/**
 * One sheet-space material region: material inside `boundary` except for its
 * explicitly represented interior `holes`.
 *
 * This is a diagnostic and scoring display model, not a nesting-legality
 * model. It must not be used as an implicit concave or hole-aware placement
 * feature.
 */
export class FreeMaterialRegion extends Schema.Class<FreeMaterialRegion>('FreeMaterialRegion')({
  boundary: IrregularPolygon,
  holes: Schema.Array(IrregularPolygon)
}) {}

/** Remaining sheet-space material and diagnostics after placed collision geometry. */
export class FreeMaterialSnapshot extends Schema.Class<FreeMaterialSnapshot>(
  'FreeMaterialSnapshot'
)({
  sheet: Schema.suspend(() => SheetSpec),
  regions: Schema.Array(FreeMaterialRegion),
  diagnostics: Schema.Array(CollisionGeometryDiagnostic)
}) {}

/** Stable namespace and ordered parts used to identify cached geometry. */
export class IrregularGeometryCacheKey extends Schema.Class<IrregularGeometryCacheKey>(
  'IrregularGeometryCacheKey'
)({
  namespace: Schema.String,
  parts: Schema.Array(Schema.String)
}) {}

/** Named whole-layout criteria retained for an irregular result or progress update. */
export class IrregularLayoutScoreSummary extends Schema.Class<IrregularLayoutScoreSummary>(
  'IrregularLayoutScoreSummary'
)({
  unplacedCount: NonNegativeFiniteInteger,
  /** Optional for backward-compatible decoding of results saved before contact scoring. */
  sharedCollisionBoundaryLengthMm: Schema.optional(NonNegativeFiniteNumber),
  /** Optional for results saved before scale-normalized contact scoring. */
  sharedCollisionBoundaryContactUnits: Schema.optional(NonNegativeFiniteNumber),
  /** Optional whole-contact band used by the whole-layout comparator. */
  sharedCollisionBoundaryContactBand: Schema.optional(NonNegativeFiniteInteger),
  /** Optional for results saved before structural-contact classification. */
  nearCompleteStructuralContactCount: Schema.optional(NonNegativeFiniteInteger),
  /** Optional for results saved before repeated structural-contact classification. */
  dominantNearCompleteStructuralContactCount: Schema.optional(NonNegativeFiniteInteger),
  largestNetFreeMaterialRegionAreaMm2: NonNegativeFiniteNumber,
  freeMaterialRegionCount: NonNegativeFiniteInteger,
  freeMaterialHoleCount: NonNegativeFiniteInteger,
  /** Sheet-independent occupied-union cavities, when measured by an exact archive. */
  canonicalEnclosedCavityCount: Schema.optional(NonNegativeFiniteInteger),
  freeMaterialSliverMetric: NonNegativeFiniteNumber,
  collisionBoundsWorstNormalizedSheetConsumption: NonNegativeFiniteNumber,
  collisionBoundsNormalizedSpanSum: NonNegativeFiniteNumber,
  collisionBoundsAreaMm2: NonNegativeFiniteNumber,
  collisionBoundsSpanMm: NonNegativeFiniteNumber
}) {}

const IrregularLayoutFields = Schema.Struct({
  kind: Schema.Literal('irregular'),
  placements: Schema.Array(IrregularPlacement),
  collisionPolygons: IrregularCollisionPolygons,
  unplacedPieceIds: Schema.Array(PieceId),
  score: IrregularLayoutScoreSummary,
  source: IrregularSearchSource,
  status: IrregularPortfolioStatus,
  diagnostics: Schema.Array(CollisionGeometryDiagnostic)
}).check(
  Schema.makeFilter((layout) =>
    layout.collisionPolygons === undefined ||
    layout.collisionPolygons.length === 0 ||
    layout.collisionPolygons.length === layout.placements.length
      ? undefined
      : {
          path: ['collisionPolygons'],
          issue: 'collisionPolygons must be empty or align one-to-one with placements.'
        }
  )
)

/** A real irregular layout with optional worker-derived collision hulls for display. */
export class IrregularLayout extends Schema.Class<IrregularLayout>('IrregularLayout')(
  IrregularLayoutFields
) {}

/** csv-row identity carried into the transform-aware source-shape export. */
export class IrregularExportSourceRow extends Schema.Class<IrregularExportSourceRow>(
  'IrregularExportSourceRow'
)({
  reference: Schema.String,
  customerName: Schema.String,
  csvRowId: Schema.String
}) {}

/** one source-shape transform placement suitable for JSON export. */
export class IrregularExportPlacement extends Schema.Class<IrregularExportPlacement>(
  'IrregularExportPlacement'
)({
  /** prepared/copy identity used by the worker and CSV row mapping. */
  pieceId: PieceId,
  /** original imported source-shape identity. */
  sourcePieceId: PieceId,
  placementReference: Schema.optional(IrregularPoint),
  transform: IrregularTransform,
  sourceRow: Schema.optional(IrregularExportSourceRow)
}) {}

/** one independently nested sheet in a transform-aware export. */
export class IrregularExportSubRun extends Schema.Class<IrregularExportSubRun>(
  'IrregularExportSubRun'
)({
  subRunId: Schema.String,
  parentRunId: Schema.String,
  index: NonNegativeFiniteInteger,
  sheet: Schema.optional(Schema.suspend(() => SheetSpec)),
  placements: Schema.Array(IrregularExportPlacement),
  unplacedPieceIds: Schema.Array(PieceId)
}) {}

/** explicit source-shape transform output; this is not transformed DXF bytes. */
export class IrregularTransformExport extends Schema.Class<IrregularTransformExport>(
  'IrregularTransformExport'
)({
  format: Schema.Literal('min-plane-dfx/irregular-transform-export'),
  version: Schema.Literal(1),
  jobId: JobId,
  runId: Schema.String,
  subRuns: Schema.Array(IrregularExportSubRun)
}) {}

const IrregularHistoryFrameFields = Schema.Struct({
  kind: Schema.Literal('irregular'),
  frameId: Schema.String,
  jobId: JobId,
  strategyRunId: Schema.String,
  strategyLabel: Schema.String,
  stepIndex: NonNegativeFiniteInteger,
  title: Schema.String,
  placements: Schema.Array(IrregularPlacement),
  collisionPolygons: IrregularCollisionPolygons,
  remainingPieceIds: Schema.Array(PieceId),
  unplacedPieceIds: Schema.Array(PieceId),
  beamRank: NonNegativeFiniteInteger,
  beamWidth: PositiveFiniteInteger,
  candidateCount: Schema.optional(NonNegativeFiniteInteger),
  selectedCandidateId: Schema.optional(Schema.String),
  selectedPieceId: Schema.optional(PieceId),
  selectedTransform: Schema.optional(IrregularTransform),
  createdAt: Schema.String
}).check(
  Schema.makeFilter((frame) =>
    frame.collisionPolygons === undefined ||
    frame.collisionPolygons.length === 0 ||
    frame.collisionPolygons.length === frame.placements.length
      ? undefined
      : {
          path: ['collisionPolygons'],
          issue: 'collisionPolygons must be empty or align one-to-one with placements.'
        }
  )
)

/** One emitted irregular beam state with optional worker-derived collision hulls for replay. */
export class IrregularHistoryFrame extends Schema.Class<IrregularHistoryFrame>(
  'IrregularHistoryFrame'
)(IrregularHistoryFrameFields) {}

/** Progress envelope emitted by the irregular search portfolio. */
export class IrregularPortfolioProgress extends Schema.Class<IrregularPortfolioProgress>(
  'IrregularPortfolioProgress'
)({
  /** Optional outer-coordinator role for multi-decode progress streams. */
  decodeRole: Schema.optional(Schema.Literals(['production', 'canonical-reference'])),
  phase: IrregularPortfolioPhase,
  generation: Schema.optional(Schema.Number),
  evaluationsCompleted: Schema.optional(Schema.Number),
  populationSize: Schema.optional(Schema.Number),
  bestScore: Schema.optional(IrregularLayoutScoreSummary),
  bestSource: Schema.optional(Schema.Literals(['beam', 'ga'])),
  elapsedMs: Schema.Number,
  remainingMs: Schema.optional(Schema.Number)
}) {}

/** One actual selected beam state retained for portfolio history replay. */
export class IrregularPortfolioHistoryState extends Schema.Class<IrregularPortfolioHistoryState>(
  'IrregularPortfolioHistoryState'
)({
  stepIndex: NonNegativeFiniteInteger,
  placements: Schema.Array(IrregularPlacement),
  remainingPieceIds: Schema.Array(PieceId),
  unplacedPieceIds: Schema.Array(PieceId),
  beamRank: NonNegativeFiniteInteger,
  beamWidth: PositiveFiniteInteger,
  candidateCount: NonNegativeFiniteInteger
}) {}

/** Final irregular portfolio status, placements, score, and diagnostics. */
export class IrregularPortfolioResult extends Schema.Class<IrregularPortfolioResult>(
  'IrregularPortfolioResult'
)({
  status: IrregularPortfolioStatus,
  /** Optional for older persisted results; emitted by every current portfolio run. */
  terminationReason: Schema.optional(IrregularPortfolioTerminationReason),
  source: IrregularSearchSource,
  placements: Schema.Array(IrregularPlacement),
  unplacedPieceIds: Schema.Array(PieceId),
  score: Schema.optional(IrregularLayoutScoreSummary),
  diagnostics: Schema.Array(CollisionGeometryDiagnostic)
}) {}
