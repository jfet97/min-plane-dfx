import type {
  InternalBounds,
  InternalCollisionGeometry,
  InternalGeometrySettings,
  InternalPoint,
  InternalPolygon,
  InternalSheetSpec,
  InternalTransformCandidate,
  InternalTransformedCollisionGeometry
} from '../internalGeometry.js'
import type { GeometryCacheKey } from './geometryCacheStore.js'

export const TRANSFORM_GEOMETRY_CACHE_NAMESPACE = 'transform-collision-v1'
export const IFP_GEOMETRY_CACHE_NAMESPACE = 'sheet-ifp-v1'

export interface TransformCollisionGeometryKeyInput<
  TPieceId extends string = string,
  TTransform extends InternalTransformCandidate = InternalTransformCandidate
> {
  readonly geometry: InternalCollisionGeometry<TPieceId>
  readonly transform: TTransform
}

export interface InnerFitBoundsKeyInput<
  TPieceId extends string = string,
  TTransform extends InternalTransformCandidate = InternalTransformCandidate,
  TSheet extends InternalSheetSpec = InternalSheetSpec
> {
  readonly sheet: TSheet
  readonly moving: InternalTransformedCollisionGeometry<TPieceId, TTransform>
}

/** Builds the existing transform-cache identity without shared domain models. */
export function makeTransformCollisionGeometryCacheKey(
  input: TransformCollisionGeometryKeyInput,
  settings: InternalGeometrySettings
): GeometryCacheKey {
  return {
    namespace: TRANSFORM_GEOMETRY_CACHE_NAMESPACE,
    parts: [
      collisionGeometryDigest(input.geometry),
      transformDigest(input.transform),
      ...geometrySettingsParts(settings),
      'placement-reference=local-lower-left',
      'transform-operation=mirror-y-then-ccw-rotate'
    ]
  }
}

/** Builds the existing rectangular IFP cache identity without shared domain models. */
export function makeInnerFitBoundsCacheKey(input: InnerFitBoundsKeyInput): GeometryCacheKey {
  return {
    namespace: IFP_GEOMETRY_CACHE_NAMESPACE,
    parts: [
      `sheet=${numberKey(input.sheet.width)},${numberKey(input.sheet.height)},${input.sheet.label}`,
      `moving-piece=${input.moving.sourcePieceId}`,
      `moving-transform=${transformDigest(input.moving.transform)}`,
      `moving-polygon=${polygonDigest(input.moving.polygon.points)}`,
      'ifp-operation=rectangular-sheet-vertex-bounds'
    ]
  }
}

export function boundsForPoints(points: ReadonlyArray<InternalPoint>): InternalBounds | undefined {
  const first = points[0]
  if (first === undefined) return undefined
  if (!Number.isFinite(first.x) || !Number.isFinite(first.y)) return undefined

  let minX = first.x
  let minY = first.y
  let maxX = first.x
  let maxY = first.y
  for (let index = 1; index < points.length; index += 1) {
    const point = points[index]
    if (point === undefined || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      return undefined
    }
    minX = Math.min(minX, point.x)
    minY = Math.min(minY, point.y)
    maxX = Math.max(maxX, point.x)
    maxY = Math.max(maxY, point.y)
  }
  return { minX, minY, maxX, maxY }
}

export function sameTransform(
  first: InternalTransformCandidate,
  second: InternalTransformCandidate
): boolean {
  return (
    first.index === second.index &&
    first.rotationDeg === second.rotationDeg &&
    first.mirrored === second.mirrored &&
    first.reason === second.reason
  )
}

function geometrySettingsParts(settings: InternalGeometrySettings): ReadonlyArray<string> {
  return [
    `flattening-sag=${numberKey(settings.flatteningSagToleranceMm)}`,
    `clearance-margin=${numberKey(settings.clearanceSafetyMarginMm)}`,
    `backend=${settings.geometryBackendId}`,
    `backend-version=${settings.geometryBackendVersion}`,
    'offset-policy=clipper2-offset-v3-sharp-miter-scale-1000'
  ]
}

function collisionGeometryDigest(geometry: InternalCollisionGeometry): string {
  return [
    `source=${geometry.sourcePieceId}`,
    `source-bounds=${boundsDigest(geometry.sourceBounds)}`,
    `placement-reference=${pointDigest(geometry.placementReference)}`,
    `hull=${polygonDigest(geometry.convexHull.points)}`,
    `collision=${polygonDigest(geometry.collisionPolygon.points)}`
  ].join(';')
}

function polygonDigest(points: ReadonlyArray<InternalPoint>): string {
  return points.map(pointDigest).join(';')
}

function pointDigest(point: InternalPoint): string {
  return `${numberKey(point.x)},${numberKey(point.y)}`
}

function boundsDigest(bounds: InternalBounds): string {
  return [bounds.minX, bounds.minY, bounds.maxX, bounds.maxY].map(numberKey).join(',')
}

function transformDigest(transform: InternalTransformCandidate): string {
  return [
    `index=${numberKey(transform.index)}`,
    `rotation=${numberKey(transform.rotationDeg)}`,
    `mirrored=${Number(transform.mirrored)}`,
    `reason=${transform.reason}`
  ].join(',')
}

function numberKey(value: number): string {
  return Object.is(value, -0) ? '0' : String(value)
}

export function isInternalPolygon(value: unknown): value is InternalPolygon {
  if (typeof value !== 'object' || value === null || !('points' in value)) return false
  return Array.isArray(value.points)
}
