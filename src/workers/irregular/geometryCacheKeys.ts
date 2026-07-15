import type {
  CollisionGeometry,
  IrregularGeometryCacheKey,
  IrregularGeometrySettings,
  IrregularNfp,
  IrregularTransformCandidate,
  IrregularIfpBounds,
  TransformedCollisionGeometry
} from '@shared/irregular/domain.js'
import type {
  ComputeIfpBoundsInput,
  ComputeNfpInput,
  TransformCollisionGeometryInput
} from './services.js'
import { ConvexPolygonValidation } from './convexPolygonValidation.js'

/** Versioned cache namespaces keep derived artifacts isolated across algorithms. */
export const TRANSFORM_GEOMETRY_CACHE_NAMESPACE = 'transform-collision-v1'
export const NFP_GEOMETRY_CACHE_NAMESPACE = 'pairwise-nfp-v1'
export const IFP_GEOMETRY_CACHE_NAMESPACE = 'sheet-ifp-v1'

/** Builds the complete identity for one transformed collision polygon. */
export function transformCollisionGeometryCacheKey(
  input: TransformCollisionGeometryInput,
  settings: IrregularGeometrySettings
): IrregularGeometryCacheKey {
  return newKey(TRANSFORM_GEOMETRY_CACHE_NAMESPACE, [
    collisionGeometryDigest(input.geometry),
    transformDigest(input.transform),
    ...geometrySettingsParts(settings),
    'placement-reference=local-lower-left',
    'transform-operation=mirror-y-then-ccw-rotate'
  ])
}

/** Builds the complete identity for one fixed/moving pairwise NFP. */
export function pairwiseNfpCacheKey(input: ComputeNfpInput): IrregularGeometryCacheKey {
  return newKey(NFP_GEOMETRY_CACHE_NAMESPACE, [
    `fixed-piece=${pieceIdentity(input.fixed.placement.pieceId, input.fixed.placement.sourcePieceId)}`,
    `moving-piece=${input.moving.sourcePieceId}`,
    `fixed-translation=${numberKey(input.fixed.placement.transform.translateX)},${numberKey(input.fixed.placement.transform.translateY)}`,
    `fixed-transform=${transformDigest(input.fixed.collisionGeometry.transform)}`,
    `moving-transform=${transformDigest(input.moving.transform)}`,
    `fixed-polygon=${polygonDigest(input.fixed.collisionGeometry.polygon.points)}`,
    `moving-polygon=${polygonDigest(input.moving.polygon.points)}`,
    ...geometrySettingsParts(input.settings),
    'nfp-operation=convex-fixed-plus-negated-moving'
  ])
}

/** Builds the identity for a sheet/piece inner-fit bounds artifact. */
export function innerFitBoundsCacheKey(input: ComputeIfpBoundsInput): IrregularGeometryCacheKey {
  return newKey(IFP_GEOMETRY_CACHE_NAMESPACE, [
    `sheet=${numberKey(input.sheet.width)},${numberKey(input.sheet.height)},${input.sheet.label}`,
    `moving-piece=${input.moving.sourcePieceId}`,
    `moving-transform=${transformDigest(input.moving.transform)}`,
    `moving-polygon=${polygonDigest(input.moving.polygon.points)}`,
    'ifp-operation=rectangular-sheet-vertex-bounds'
  ])
}

/** Checks that a cached transformed artifact still describes its key inputs. */
export function isValidCachedTransform(
  value: TransformedCollisionGeometry | undefined,
  input: TransformCollisionGeometryInput
): value is TransformedCollisionGeometry {
  if (value === undefined) return false
  if (value.sourcePieceId !== input.geometry.sourcePieceId) return false
  if (!sameTransform(value.transform, input.transform)) return false
  if (value.polygon.points.length < 3) return false
  if ('message' in ConvexPolygonValidation.validateStrictBoundary(value.polygon.points)) {
    return false
  }
  const bounds = boundsForPoints(value.polygon.points)
  if (bounds === undefined) return false
  return (
    value.bounds.minX === bounds.minX &&
    value.bounds.minY === bounds.minY &&
    value.bounds.maxX === bounds.maxX &&
    value.bounds.maxY === bounds.maxY
  )
}

/** Checks that a cached NFP still has the expected pair and strict convex boundary. */
export function isValidCachedNfp(
  value: IrregularNfp | undefined,
  input: ComputeNfpInput
): value is IrregularNfp {
  return (
    value !== undefined &&
    value.fixedPieceId === input.fixed.placement.sourcePieceId &&
    value.movingPieceId === input.moving.sourcePieceId &&
    value.boundary.points.length >= 3
  )
}

/** Checks the finite bounds shape before a cached IFP is used by candidate generation. */
export function isValidCachedIfp(
  value: IrregularIfpBounds | undefined,
  input: ComputeIfpBoundsInput
): value is IrregularIfpBounds {
  if (value === undefined) return false
  const movingBounds = boundsForPoints(input.moving.polygon.points)
  if (movingBounds === undefined) return false
  return (
    value.movingPieceId === input.moving.sourcePieceId &&
    value.sheet.width === input.sheet.width &&
    value.sheet.height === input.sheet.height &&
    value.bounds.minX === -movingBounds.minX &&
    value.bounds.minY === -movingBounds.minY &&
    value.bounds.maxX === input.sheet.width - movingBounds.maxX &&
    value.bounds.maxY === input.sheet.height - movingBounds.maxY &&
    [value.bounds.minX, value.bounds.minY, value.bounds.maxX, value.bounds.maxY].every(
      Number.isFinite
    )
  )
}

function newKey(namespace: string, parts: ReadonlyArray<string>): IrregularGeometryCacheKey {
  return { namespace, parts: [...parts] }
}

function geometrySettingsParts(settings: IrregularGeometrySettings): ReadonlyArray<string> {
  return [
    `flattening-sag=${numberKey(settings.flatteningSagToleranceMm)}`,
    `clearance-margin=${numberKey(settings.clearanceSafetyMarginMm)}`,
    `backend=${settings.geometryBackendId}`,
    `backend-version=${settings.geometryBackendVersion}`,
    'offset-policy=clipper2-offset-v2-miter-scale-1000'
  ]
}

function collisionGeometryDigest(geometry: CollisionGeometry): string {
  return [
    `source=${geometry.sourcePieceId}`,
    `source-bounds=${boundsDigest(geometry.sourceBounds)}`,
    `placement-reference=${pointDigest(geometry.placementReference)}`,
    `hull=${polygonDigest(geometry.convexHull.points)}`,
    `collision=${polygonDigest(geometry.collisionPolygon.points)}`
  ].join(';')
}

function polygonDigest(points: ReadonlyArray<{ readonly x: number; readonly y: number }>): string {
  return points.map(pointDigest).join(';')
}

function pointDigest(point: { readonly x: number; readonly y: number }): string {
  return `${numberKey(point.x)},${numberKey(point.y)}`
}

function boundsDigest(bounds: {
  readonly minX: number
  readonly minY: number
  readonly maxX: number
  readonly maxY: number
}): string {
  return [bounds.minX, bounds.minY, bounds.maxX, bounds.maxY].map(numberKey).join(',')
}

function transformDigest(transform: IrregularTransformCandidate): string {
  return [
    `index=${numberKey(transform.index)}`,
    `rotation=${numberKey(transform.rotationDeg)}`,
    `mirrored=${Number(transform.mirrored)}`,
    `reason=${transform.reason}`
  ].join(',')
}

function pieceIdentity(pieceId: string | undefined, sourcePieceId: string): string {
  return pieceId === undefined ? sourcePieceId : `${pieceId}|source=${sourcePieceId}`
}

function numberKey(value: number): string {
  return Object.is(value, -0) ? '0' : String(value)
}

function boundsForPoints(
  points: ReadonlyArray<{ readonly x: number; readonly y: number }>
):
  | { readonly minX: number; readonly minY: number; readonly maxX: number; readonly maxY: number }
  | undefined {
  const first = points[0]
  if (first === undefined) return undefined
  if (!Number.isFinite(first.x) || !Number.isFinite(first.y)) return undefined
  let minX = first.x
  let minY = first.y
  let maxX = first.x
  let maxY = first.y
  for (const point of points.slice(1)) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return undefined
    minX = Math.min(minX, point.x)
    minY = Math.min(minY, point.y)
    maxX = Math.max(maxX, point.x)
    maxY = Math.max(maxY, point.y)
  }
  return { minX, minY, maxX, maxY }
}

function sameTransform(
  first: IrregularTransformCandidate,
  second: IrregularTransformCandidate
): boolean {
  return (
    first.index === second.index &&
    first.rotationDeg === second.rotationDeg &&
    first.mirrored === second.mirrored &&
    first.reason === second.reason
  )
}
