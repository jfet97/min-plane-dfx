/** Schema-backed contracts for convex irregular nesting geometry and search data. */
import { Effect, Schema } from 'effect'
import { ImportedPiece } from '@shared/domain/dxf.js'
import { PieceId } from '@shared/domain/ids.js'
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
  'validating',
  'completed',
  'cancelled'
])

/** Type of an irregular portfolio phase. */
export type IrregularPortfolioPhase = Schema.Schema.Type<typeof IrregularPortfolioPhase>

/** Identifies which search source produced a portfolio result. */
export const IrregularSearchSource = Schema.Literals(['beam', 'ga', 'none'])

/** Type of an irregular portfolio search source. */
export type IrregularSearchSource = Schema.Schema.Type<typeof IrregularSearchSource>

/** Finite real-valued number used by irregular geometry contracts. */
const FiniteNumber = Schema.Finite

/** Finite non-negative millimeter distance used by irregular geometry settings. */
export const NonNegativeFiniteMillimeters = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))

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

/** Terminal status of an irregular nesting portfolio. */
export const IrregularPortfolioStatus = Schema.Literals([
  'completed',
  'budget-expired',
  'cancelled',
  'no-valid-result'
])

/** Type of an irregular portfolio terminal status. */
export type IrregularPortfolioStatus = Schema.Schema.Type<typeof IrregularPortfolioStatus>

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

/**
 * Positive integer limits, finite-transform controls, and reproducibility
 * settings for irregular search.
 */
export class IrregularOptimizerSettings extends Schema.Class<IrregularOptimizerSettings>(
  'IrregularOptimizerSettings'
)({
  orderWindow: PositiveFiniteInteger,
  beamWidth: PositiveFiniteInteger,
  /**
   * Maximum emitted transforms: orthogonal baseline first, then configured
   * choices, then edge-derived choices with reserved mirror capacity.
   */
  transformCap: PositiveFiniteInteger,
  /** Edges shorter than this millimeter length are ignored as geometric noise. */
  transformMinimumEdgeLengthMm: NonNegativeFiniteMillimeters.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(1))
  ),
  /** Circular angular distance at or below this degree value is one transform. */
  transformAngleDeduplicationToleranceDeg: PositiveFiniteDegrees.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(0.01))
  ),
  /** Additional finite rotations in degrees, normalized by the transform generator. */
  configuredRotationDeg: Schema.Array(FiniteDegrees).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([]))
  ),
  gaPopulation: PositiveFiniteInteger,
  gaTimeBudgetMs: PositiveFiniteInteger,
  gaSeed: Schema.NonEmptyString
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

/** A transformed local collision polygon and its derived finite bounds. */
export class TransformedCollisionGeometry extends Schema.Class<TransformedCollisionGeometry>(
  'TransformedCollisionGeometry'
)({
  sourcePieceId: PieceId,
  transform: IrregularTransformCandidate,
  polygon: IrregularPolygon,
  bounds: IrregularBounds
}) {}

/** A source piece paired with its prepared collision geometry and transforms. */
export class IrregularPreparedPiece extends Schema.Class<IrregularPreparedPiece>(
  'IrregularPreparedPiece'
)({
  source: ImportedPiece,
  allowMirror: Schema.Boolean,
  collisionGeometry: CollisionGeometry,
  transforms: Schema.Array(IrregularTransformCandidate)
}) {}

/** A source piece transform retained as part of a final irregular placement. */
export class IrregularPlacement extends Schema.Class<IrregularPlacement>('IrregularPlacement')({
  sourcePieceId: PieceId,
  transform: IrregularTransform
}) {}

/** A placed piece with the transformed collision geometry used for legality. */
export class IrregularPlacedPiece extends Schema.Class<IrregularPlacedPiece>(
  'IrregularPlacedPiece'
)({
  placement: IrregularPlacement,
  collisionGeometry: TransformedCollisionGeometry
}) {}

/** A candidate placement point plus its transform and diagnostics. */
export class IrregularPlacementCandidate extends Schema.Class<IrregularPlacementCandidate>(
  'IrregularPlacementCandidate'
)({
  pieceId: PieceId,
  transform: IrregularTransformCandidate,
  point: IrregularPoint,
  diagnostics: Schema.Array(CollisionGeometryDiagnostic)
}) {}

/** A no-fit polygon boundary in moving-placement-coordinate space. */
export class IrregularNfp extends Schema.Class<IrregularNfp>('IrregularNfp')({
  fixedPieceId: PieceId,
  movingPieceId: PieceId,
  boundary: IrregularPolygon
}) {}

/** A rectangular inner-fit bound for one transformed moving piece. */
export class IrregularIfpBounds extends Schema.Class<IrregularIfpBounds>('IrregularIfpBounds')({
  sheet: SheetSpec,
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
  sheet: SheetSpec,
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

/** Progress envelope emitted by the irregular search portfolio. */
export class IrregularPortfolioProgress extends Schema.Class<IrregularPortfolioProgress>(
  'IrregularPortfolioProgress'
)({
  phase: IrregularPortfolioPhase,
  generation: Schema.optional(Schema.Number),
  evaluationsCompleted: Schema.optional(Schema.Number),
  populationSize: Schema.optional(Schema.Number),
  bestScore: Schema.optional(Schema.Array(Schema.Number)),
  bestSource: Schema.optional(Schema.Literals(['beam', 'ga'])),
  elapsedMs: Schema.Number,
  remainingMs: Schema.optional(Schema.Number)
}) {}

/** Final irregular portfolio status, placements, score, and diagnostics. */
export class IrregularPortfolioResult extends Schema.Class<IrregularPortfolioResult>(
  'IrregularPortfolioResult'
)({
  status: IrregularPortfolioStatus,
  source: IrregularSearchSource,
  placements: Schema.Array(IrregularPlacement),
  unplacedPieceIds: Schema.Array(PieceId),
  score: Schema.optional(Schema.Array(Schema.Number)),
  diagnostics: Schema.Array(CollisionGeometryDiagnostic)
}) {}
