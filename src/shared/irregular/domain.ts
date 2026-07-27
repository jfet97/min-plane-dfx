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

/** Boundary schema for one finite source or collision-geometry coordinate. */
export const IrregularPointSchema = Schema.Struct({
  x: FiniteNumber,
  y: FiniteNumber
})

/** One finite source or collision-geometry coordinate in millimeters. */
export class IrregularPoint {
  readonly x: number
  readonly y: number

  constructor(fields: { readonly x: number; readonly y: number }) {
    this.x = fields.x
    this.y = fields.y
  }
}

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

/** Boundary schema for finite ordered axis-aligned bounds. */
export const IrregularBoundsSchema = IrregularBoundsFields

/** Finite axis-aligned bounds for source, collision, or transformed geometry. */
export class IrregularBounds {
  readonly minX: number
  readonly minY: number
  readonly maxX: number
  readonly maxY: number

  constructor(fields: {
    readonly minX: number
    readonly minY: number
    readonly maxX: number
    readonly maxY: number
  }) {
    this.minX = fields.minX
    this.minY = fields.minY
    this.maxX = fields.maxX
    this.maxY = fields.maxY
  }
}

/** Boundary schema for a polygon without an implicit closing vertex. */
export const IrregularPolygonSchema = Schema.Struct({
  points: Schema.Array(IrregularPointSchema)
})

/** A polygon represented by finite vertices without an implicit closing vertex. */
export class IrregularPolygon {
  readonly points: ReadonlyArray<IrregularPoint>

  constructor(fields: { readonly points: ReadonlyArray<IrregularPoint> }) {
    this.points = fields.points
  }
}

/**
 * Optional translated collision hulls retained for result and history display.
 * When present, their order exactly matches the associated placement array;
 * older persisted results omit the field and decode to an empty array.
 */
const IrregularCollisionPolygons = Schema.Array(IrregularPolygonSchema).pipe(
  Schema.optionalKey,
  Schema.withConstructorDefault(Effect.succeed([])),
  Schema.withDecodingDefaultKey(Effect.succeed([]))
)

/** Boundary schema for one finite placement transform. */
export const IrregularTransformSchema = Schema.Struct({
  translateX: FiniteNumber,
  translateY: FiniteNumber,
  rotationDeg: FiniteNumber,
  mirrored: Schema.Boolean
})

/** A finite translation, rotation, and mirror transform for a placed piece. */
export class IrregularTransform {
  readonly translateX: number
  readonly translateY: number
  readonly rotationDeg: number
  readonly mirrored: boolean

  constructor(fields: {
    readonly translateX: number
    readonly translateY: number
    readonly rotationDeg: number
    readonly mirrored: boolean
  }) {
    this.translateX = fields.translateX
    this.translateY = fields.translateY
    this.rotationDeg = fields.rotationDeg
    this.mirrored = fields.mirrored
  }
}

/**
 * One finite transform choice considered by the irregular optimizer. Rotation
 * values are intentionally not range-limited here: the worker canonicalizes
 * periodic values such as `-90` and `450` without changing their geometry.
 */
export const IrregularTransformCandidateSchema = Schema.Struct({
  index: NonNegativeFiniteInteger,
  rotationDeg: FiniteNumber,
  mirrored: Schema.Boolean,
  reason: IrregularTransformReason
})

/** Trusted runtime representation of one finite transform choice. */
export class IrregularTransformCandidate {
  readonly index: number
  readonly rotationDeg: number
  readonly mirrored: boolean
  readonly reason: IrregularTransformReason

  constructor(fields: {
    readonly index: number
    readonly rotationDeg: number
    readonly mirrored: boolean
    readonly reason: IrregularTransformReason
  }) {
    this.index = fields.index
    this.rotationDeg = fields.rotationDeg
    this.mirrored = fields.mirrored
    this.reason = fields.reason
  }
}

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

/** Boundary schema for the prepared rectangle priority key. */
export const IrregularPriorityOrderKeySchema = Schema.Struct({
  longSideMm: NonNegativeFiniteNumber,
  areaMm2: NonNegativeFiniteNumber,
  imbalanceMm: NonNegativeFiniteNumber
})

/** Priority key retained from the user-owned prepared rectangle ordering. */
export class IrregularPriorityOrderKey {
  readonly longSideMm: number
  readonly areaMm2: number
  readonly imbalanceMm: number

  constructor(fields: {
    readonly longSideMm: number
    readonly areaMm2: number
    readonly imbalanceMm: number
  }) {
    this.longSideMm = fields.longSideMm
    this.areaMm2 = fields.areaMm2
    this.imbalanceMm = fields.imbalanceMm
  }
}

/** Complete geometry and optimizer configuration for one irregular run. */
export class IrregularNestingSettings extends Schema.Class<IrregularNestingSettings>(
  'IrregularNestingSettings'
)({
  geometry: IrregularGeometrySettings,
  optimizer: IrregularOptimizerSettings
}) {}

/** Boundary schema for one irregular geometry diagnostic. */
export const CollisionGeometryDiagnosticSchema = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  pieceId: Schema.optional(PieceId)
})

/** A diagnostic attached to an irregular geometry or portfolio artifact. */
export class CollisionGeometryDiagnostic {
  readonly code: string
  readonly message: string
  readonly pieceId?: PieceId | undefined

  constructor(fields: {
    readonly code: string
    readonly message: string
    readonly pieceId?: PieceId | undefined
  }) {
    this.code = fields.code
    this.message = fields.message
    this.pieceId = fields.pieceId
  }
}

/** Boundary schema for flattened source samples and diagnostics. */
export const FlattenedGeometrySchema = Schema.Struct({
  sourcePieceId: PieceId,
  sampledPoints: Schema.Array(IrregularPointSchema),
  diagnostics: Schema.Array(CollisionGeometryDiagnosticSchema)
})

/** Flattened source samples and diagnostics before hull and offset derivation. */
export class FlattenedGeometry {
  readonly sourcePieceId: PieceId
  readonly sampledPoints: ReadonlyArray<IrregularPoint>
  readonly diagnostics: ReadonlyArray<CollisionGeometryDiagnostic>

  constructor(fields: {
    readonly sourcePieceId: PieceId
    readonly sampledPoints: ReadonlyArray<IrregularPoint>
    readonly diagnostics: ReadonlyArray<CollisionGeometryDiagnostic>
  }) {
    this.sourcePieceId = fields.sourcePieceId
    this.sampledPoints = fields.sampledPoints
    this.diagnostics = fields.diagnostics
  }
}

/**
 * Conservative collision geometry derived from one imported source piece.
 * Polygons are local to the stored padded placement reference.
 */
export const CollisionGeometrySchema = Schema.Struct({
  /** Source piece that produced this derived collision artifact. */
  sourcePieceId: PieceId,
  /** Unpadded convex-hull bounds in original source coordinates. */
  sourceBounds: IrregularBoundsSchema,
  /** Flattened source points kept in original source coordinates for diagnostics. */
  sampledPoints: Schema.Array(IrregularPointSchema),
  /** Convex hull rebased to the collision polygon's placement origin. */
  convexHull: IrregularPolygonSchema,
  /** Padded collision polygon whose lower-left bounds corner is local `(0, 0)`. */
  collisionPolygon: IrregularPolygonSchema,
  /** Source-space coordinate of the padded collision bounds corner used as placement origin. */
  placementReference: IrregularPointSchema,
  /** Import and geometry diagnostics carried with this derived artifact. */
  diagnostics: Schema.Array(CollisionGeometryDiagnosticSchema)
})

/** Conservative collision geometry derived from one imported source piece. */
export class CollisionGeometry {
  readonly sourcePieceId: PieceId
  readonly sourceBounds: IrregularBounds
  readonly sampledPoints: ReadonlyArray<IrregularPoint>
  readonly convexHull: IrregularPolygon
  readonly collisionPolygon: IrregularPolygon
  readonly placementReference: IrregularPoint
  readonly diagnostics: ReadonlyArray<CollisionGeometryDiagnostic>

  constructor(fields: {
    readonly sourcePieceId: PieceId
    readonly sourceBounds: IrregularBounds
    readonly sampledPoints: ReadonlyArray<IrregularPoint>
    readonly convexHull: IrregularPolygon
    readonly collisionPolygon: IrregularPolygon
    readonly placementReference: IrregularPoint
    readonly diagnostics: ReadonlyArray<CollisionGeometryDiagnostic>
  }) {
    this.sourcePieceId = fields.sourcePieceId
    this.sourceBounds = fields.sourceBounds
    this.sampledPoints = fields.sampledPoints
    this.convexHull = fields.convexHull
    this.collisionPolygon = fields.collisionPolygon
    this.placementReference = fields.placementReference
    this.diagnostics = fields.diagnostics
  }
}

/**
 * A transformed local collision polygon and its derived finite bounds.
 *
 * This is a trusted internal search artifact produced by the geometry kernel
 * from already-decoded input. The class itself is never used as boundary
 * validation; replay data carrying the same structural shape uses
 * {@link TransformedCollisionGeometrySchema}. It is a plain class rather than a
 * `Schema.Class`, because schema construction revalidates the whole nested ring
 * on every instantiation and the search instantiates this per placement and per
 * quarter turn.
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

/** Boundary schema for a source piece paired with prepared geometry and transforms. */
export const IrregularPreparedPieceSchema = Schema.Struct({
  /** Prepared or copied identity; legacy payloads fall back to source.id. */
  pieceId: Schema.optional(PieceId),
  /** Search-equivalence class shared only by interchangeable prepared copies. */
  interchangeabilityKey: Schema.optional(Schema.NonEmptyString),
  source: ImportedPiece,
  allowMirror: Schema.Boolean,
  collisionGeometry: CollisionGeometrySchema,
  transforms: Schema.Array(IrregularTransformCandidateSchema),
  priorityOrderKey: Schema.optional(IrregularPriorityOrderKeySchema)
})

/** A source piece paired with its prepared collision geometry and transforms. */
export class IrregularPreparedPiece {
  readonly pieceId?: PieceId | undefined
  readonly interchangeabilityKey?: string | undefined
  readonly source: ImportedPiece
  readonly allowMirror: boolean
  readonly collisionGeometry: CollisionGeometry
  readonly transforms: ReadonlyArray<IrregularTransformCandidate>
  readonly priorityOrderKey?: IrregularPriorityOrderKey | undefined

  constructor(fields: {
    readonly pieceId?: PieceId | undefined
    readonly interchangeabilityKey?: string | undefined
    readonly source: ImportedPiece
    readonly allowMirror: boolean
    readonly collisionGeometry: CollisionGeometry
    readonly transforms: ReadonlyArray<IrregularTransformCandidate>
    readonly priorityOrderKey?: IrregularPriorityOrderKey | undefined
  }) {
    this.pieceId = fields.pieceId
    this.interchangeabilityKey = fields.interchangeabilityKey
    this.source = fields.source
    this.allowMirror = fields.allowMirror
    this.collisionGeometry = fields.collisionGeometry
    this.transforms = fields.transforms
    this.priorityOrderKey = fields.priorityOrderKey
  }
}

/**
 * A prepared piece transform retained as part of a final irregular placement.
 * Its translation positions `placementReference` after mirror-then-rotation
 * around that same source-space point.
 */
export const IrregularPlacementSchema = Schema.Struct({
  /** Prepared or copied piece identity; new results must always emit this id. */
  pieceId: Schema.optional(PieceId),
  /** Original imported piece identity retained for source-geometry lookup. */
  sourcePieceId: PieceId,
  /** Source-space pivot for the transform; new worker results always emit it. */
  placementReference: Schema.optional(IrregularPointSchema),
  transform: IrregularTransformSchema
})

/** Trusted runtime representation of one prepared-piece placement. */
export class IrregularPlacement {
  readonly pieceId?: PieceId | undefined
  readonly sourcePieceId: PieceId
  readonly placementReference?: IrregularPoint | undefined
  readonly transform: IrregularTransform

  constructor(fields: {
    readonly pieceId?: PieceId | undefined
    readonly sourcePieceId: PieceId
    readonly placementReference?: IrregularPoint | undefined
    readonly transform: IrregularTransform
  }) {
    this.pieceId = fields.pieceId
    this.sourcePieceId = fields.sourcePieceId
    this.placementReference = fields.placementReference
    this.transform = fields.transform
  }
}

/**
 * A placed piece with the transformed collision geometry used for legality.
 *
 * Trusted internal search artifact, plain for the same reason as
 * {@link TransformedCollisionGeometry}. The worker result exposes its
 * `placement`; replay data carrying the complete structural shape uses
 * {@link IrregularPlacedPieceSchema}.
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
  transform: IrregularTransformCandidateSchema,
  polygon: IrregularPolygonSchema,
  bounds: IrregularBoundsSchema
})

/** Boundary schema for {@link IrregularPlacedPiece}. */
export const IrregularPlacedPieceSchema = Schema.Struct({
  placement: IrregularPlacementSchema,
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

/** Boundary schema for one no-fit polygon. */
export const IrregularNfpSchema = Schema.Struct({
  fixedPieceId: PieceId,
  movingPieceId: PieceId,
  boundary: IrregularPolygonSchema
})

/** A no-fit polygon boundary in moving-placement-coordinate space. */
export class IrregularNfp {
  readonly fixedPieceId: PieceId
  readonly movingPieceId: PieceId
  readonly boundary: IrregularPolygon

  constructor(fields: {
    readonly fixedPieceId: PieceId
    readonly movingPieceId: PieceId
    readonly boundary: IrregularPolygon
  }) {
    this.fixedPieceId = fields.fixedPieceId
    this.movingPieceId = fields.movingPieceId
    this.boundary = fields.boundary
  }
}

/** Boundary schema for one rectangular inner-fit bound. */
export const IrregularIfpBoundsSchema = Schema.Struct({
  sheet: Schema.suspend(() => SheetSpec),
  movingPieceId: PieceId,
  bounds: IrregularBoundsSchema
})

/** A rectangular inner-fit bound for one transformed moving piece. */
export class IrregularIfpBounds {
  readonly sheet: SheetSpec
  readonly movingPieceId: PieceId
  readonly bounds: IrregularBounds

  constructor(fields: {
    readonly sheet: SheetSpec
    readonly movingPieceId: PieceId
    readonly bounds: IrregularBounds
  }) {
    this.sheet = fields.sheet
    this.movingPieceId = fields.movingPieceId
    this.bounds = fields.bounds
  }
}

/**
 * One sheet-space material region: material inside `boundary` except for its
 * explicitly represented interior `holes`.
 *
 * This is a diagnostic and scoring display model, not a nesting-legality
 * model. It must not be used as an implicit concave or hole-aware placement
 * feature.
 */
export const FreeMaterialRegionSchema = Schema.Struct({
  boundary: IrregularPolygonSchema,
  holes: Schema.Array(IrregularPolygonSchema)
})

export class FreeMaterialRegion {
  readonly boundary: IrregularPolygon
  readonly holes: ReadonlyArray<IrregularPolygon>

  constructor(fields: {
    readonly boundary: IrregularPolygon
    readonly holes: ReadonlyArray<IrregularPolygon>
  }) {
    this.boundary = fields.boundary
    this.holes = fields.holes
  }
}

/** Boundary schema for remaining sheet-space material and diagnostics. */
export const FreeMaterialSnapshotSchema = Schema.Struct({
  sheet: Schema.suspend(() => SheetSpec),
  regions: Schema.Array(FreeMaterialRegionSchema),
  diagnostics: Schema.Array(CollisionGeometryDiagnosticSchema)
})

/** Remaining sheet-space material and diagnostics after placed collision geometry. */
export class FreeMaterialSnapshot {
  readonly sheet: SheetSpec
  readonly regions: ReadonlyArray<FreeMaterialRegion>
  readonly diagnostics: ReadonlyArray<CollisionGeometryDiagnostic>

  constructor(fields: {
    readonly sheet: SheetSpec
    readonly regions: ReadonlyArray<FreeMaterialRegion>
    readonly diagnostics: ReadonlyArray<CollisionGeometryDiagnostic>
  }) {
    this.sheet = fields.sheet
    this.regions = fields.regions
    this.diagnostics = fields.diagnostics
  }
}

/** Boundary schema for a stable geometry-cache identity. */
export const IrregularGeometryCacheKeySchema = Schema.Struct({
  namespace: Schema.String,
  parts: Schema.Array(Schema.String)
})

/** Stable namespace and ordered parts used to identify cached geometry. */
export class IrregularGeometryCacheKey {
  readonly namespace: string
  readonly parts: ReadonlyArray<string>

  constructor(fields: { readonly namespace: string; readonly parts: ReadonlyArray<string> }) {
    this.namespace = fields.namespace
    this.parts = fields.parts
  }
}

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
  placements: Schema.Array(IrregularPlacementSchema),
  collisionPolygons: IrregularCollisionPolygons,
  unplacedPieceIds: Schema.Array(PieceId),
  score: IrregularLayoutScoreSummary,
  source: IrregularSearchSource,
  status: IrregularPortfolioStatus,
  diagnostics: Schema.Array(CollisionGeometryDiagnosticSchema)
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
  placementReference: Schema.optional(IrregularPointSchema),
  transform: IrregularTransformSchema,
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
  placements: Schema.Array(IrregularPlacementSchema),
  collisionPolygons: IrregularCollisionPolygons,
  remainingPieceIds: Schema.Array(PieceId),
  unplacedPieceIds: Schema.Array(PieceId),
  beamRank: NonNegativeFiniteInteger,
  beamWidth: PositiveFiniteInteger,
  candidateCount: Schema.optional(NonNegativeFiniteInteger),
  selectedCandidateId: Schema.optional(Schema.String),
  selectedPieceId: Schema.optional(PieceId),
  selectedTransform: Schema.optional(IrregularTransformSchema),
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
  placements: Schema.Array(IrregularPlacementSchema),
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
  placements: Schema.Array(IrregularPlacementSchema),
  unplacedPieceIds: Schema.Array(PieceId),
  score: Schema.optional(IrregularLayoutScoreSummary),
  diagnostics: Schema.Array(CollisionGeometryDiagnosticSchema)
}) {}
