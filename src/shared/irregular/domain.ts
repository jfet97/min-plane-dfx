import { Schema } from 'effect'
import { ImportedPiece } from '@shared/domain/dxf.js'
import { PieceId } from '@shared/domain/ids.js'
import { SheetSpec } from '@shared/domain/nesting.js'

export const IrregularWorkerMode = Schema.Literal('irregular-convex-v2')
export type IrregularWorkerMode = Schema.Schema.Type<typeof IrregularWorkerMode>

export const IrregularTransformReason = Schema.Literals([
  'orthogonal',
  'edge_alignment',
  'oriented_bounds',
  'configured'
])
export type IrregularTransformReason = Schema.Schema.Type<typeof IrregularTransformReason>

export const IrregularPortfolioPhase = Schema.Literals([
  'preparing_geometry',
  'deterministic_beam',
  'ga_search',
  'validating',
  'completed',
  'cancelled'
])
export type IrregularPortfolioPhase = Schema.Schema.Type<typeof IrregularPortfolioPhase>

export const IrregularSearchSource = Schema.Literals(['beam', 'ga', 'none'])
export type IrregularSearchSource = Schema.Schema.Type<typeof IrregularSearchSource>

export const IrregularPortfolioStatus = Schema.Literals([
  'completed',
  'budget-expired',
  'cancelled',
  'no-valid-result'
])
export type IrregularPortfolioStatus = Schema.Schema.Type<typeof IrregularPortfolioStatus>

export class IrregularPoint extends Schema.Class<IrregularPoint>('IrregularPoint')({
  x: Schema.Number,
  y: Schema.Number
}) {}

export class IrregularBounds extends Schema.Class<IrregularBounds>('IrregularBounds')({
  minX: Schema.Number,
  minY: Schema.Number,
  maxX: Schema.Number,
  maxY: Schema.Number
}) {}

export class IrregularPolygon extends Schema.Class<IrregularPolygon>('IrregularPolygon')({
  points: Schema.Array(IrregularPoint)
}) {}

export class IrregularTransform extends Schema.Class<IrregularTransform>('IrregularTransform')({
  translateX: Schema.Number,
  translateY: Schema.Number,
  rotationDeg: Schema.Number,
  mirrored: Schema.Boolean
}) {}

export class IrregularTransformCandidate extends Schema.Class<IrregularTransformCandidate>(
  'IrregularTransformCandidate'
)({
  index: Schema.Number,
  rotationDeg: Schema.Number,
  mirrored: Schema.Boolean,
  reason: IrregularTransformReason
}) {}

export class IrregularGeometrySettings extends Schema.Class<IrregularGeometrySettings>(
  'IrregularGeometrySettings'
)({
  flatteningSagToleranceMm: Schema.Number,
  clearanceSafetyMarginMm: Schema.Number,
  convexHullSimplificationToleranceMm: Schema.Number,
  geometryBackendId: Schema.String,
  geometryBackendVersion: Schema.String
}) {}

export class IrregularOptimizerSettings extends Schema.Class<IrregularOptimizerSettings>(
  'IrregularOptimizerSettings'
)({
  orderWindow: Schema.Number,
  beamWidth: Schema.Number,
  transformCap: Schema.Number,
  gaPopulation: Schema.Number,
  gaTimeBudgetMs: Schema.Number,
  gaSeed: Schema.String
}) {}

export class IrregularNestingSettings extends Schema.Class<IrregularNestingSettings>(
  'IrregularNestingSettings'
)({
  geometry: IrregularGeometrySettings,
  optimizer: IrregularOptimizerSettings
}) {}

export class CollisionGeometryDiagnostic extends Schema.Class<CollisionGeometryDiagnostic>(
  'CollisionGeometryDiagnostic'
)({
  code: Schema.String,
  message: Schema.String,
  pieceId: Schema.optional(PieceId)
}) {}

export class FlattenedGeometry extends Schema.Class<FlattenedGeometry>('FlattenedGeometry')({
  sourcePieceId: PieceId,
  sampledPoints: Schema.Array(IrregularPoint),
  diagnostics: Schema.Array(CollisionGeometryDiagnostic)
}) {}

export class CollisionGeometry extends Schema.Class<CollisionGeometry>('CollisionGeometry')({
  sourcePieceId: PieceId,
  sourceBounds: IrregularBounds,
  sampledPoints: Schema.Array(IrregularPoint),
  convexHull: IrregularPolygon,
  collisionPolygon: IrregularPolygon,
  placementReference: IrregularPoint,
  diagnostics: Schema.Array(CollisionGeometryDiagnostic)
}) {}

export class TransformedCollisionGeometry extends Schema.Class<TransformedCollisionGeometry>(
  'TransformedCollisionGeometry'
)({
  sourcePieceId: PieceId,
  transform: IrregularTransformCandidate,
  polygon: IrregularPolygon,
  bounds: IrregularBounds
}) {}

export class IrregularPreparedPiece extends Schema.Class<IrregularPreparedPiece>(
  'IrregularPreparedPiece'
)({
  source: ImportedPiece,
  allowMirror: Schema.Boolean,
  collisionGeometry: CollisionGeometry,
  transforms: Schema.Array(IrregularTransformCandidate)
}) {}

export class IrregularPlacement extends Schema.Class<IrregularPlacement>('IrregularPlacement')({
  sourcePieceId: PieceId,
  transform: IrregularTransform
}) {}

export class IrregularPlacedPiece extends Schema.Class<IrregularPlacedPiece>(
  'IrregularPlacedPiece'
)({
  placement: IrregularPlacement,
  collisionGeometry: TransformedCollisionGeometry
}) {}

export class IrregularPlacementCandidate extends Schema.Class<IrregularPlacementCandidate>(
  'IrregularPlacementCandidate'
)({
  pieceId: PieceId,
  transform: IrregularTransformCandidate,
  point: IrregularPoint,
  diagnostics: Schema.Array(CollisionGeometryDiagnostic)
}) {}

export class IrregularNfp extends Schema.Class<IrregularNfp>('IrregularNfp')({
  fixedPieceId: PieceId,
  movingPieceId: PieceId,
  boundary: IrregularPolygon
}) {}

export class IrregularIfpBounds extends Schema.Class<IrregularIfpBounds>('IrregularIfpBounds')({
  sheet: SheetSpec,
  movingPieceId: PieceId,
  bounds: IrregularBounds
}) {}

export class FreeMaterialSnapshot extends Schema.Class<FreeMaterialSnapshot>(
  'FreeMaterialSnapshot'
)({
  sheet: SheetSpec,
  regions: Schema.Array(IrregularPolygon),
  diagnostics: Schema.Array(CollisionGeometryDiagnostic)
}) {}

export class IrregularGeometryCacheKey extends Schema.Class<IrregularGeometryCacheKey>(
  'IrregularGeometryCacheKey'
)({
  namespace: Schema.String,
  parts: Schema.Array(Schema.String)
}) {}

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
