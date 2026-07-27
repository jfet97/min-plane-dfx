import { fromGrid, toGridMm } from '../clipper2OffsetPolicy.js'
import { ConvexPolygonValidation } from '../convexPolygonValidation.js'
import type {
  InternalGeometrySettings,
  InternalPoint,
  InternalTransformCandidate,
  InternalTransformedCollisionGeometry
} from '../internalGeometry.js'
import {
  boundsForPoints,
  isInternalPolygon,
  makeTransformCollisionGeometryCacheKey,
  sameTransform,
  type TransformCollisionGeometryKeyInput
} from './geometryCacheIdentity.js'
import type { GeometryCacheKey, GeometryCacheStore } from './geometryCacheStore.js'

export interface CoreTransformCollisionSuccess<
  TPieceId extends string,
  TTransform extends InternalTransformCandidate
> {
  readonly ok: true
  readonly value: InternalTransformedCollisionGeometry<TPieceId, TTransform>
  readonly key?: GeometryCacheKey
}

export interface CoreTransformCollisionFailure {
  readonly ok: false
  readonly message: string
}

export type CoreTransformCollisionResult<
  TPieceId extends string,
  TTransform extends InternalTransformCandidate
> = CoreTransformCollisionSuccess<TPieceId, TTransform> | CoreTransformCollisionFailure

/** Resolves transformed collision geometry while preserving key/get-before-validation ordering. */
export function resolveTransformedCollisionGeometry<
  TPieceId extends string,
  TTransform extends InternalTransformCandidate,
  TValue extends InternalTransformedCollisionGeometry<TPieceId, TTransform> =
    InternalTransformedCollisionGeometry<TPieceId, TTransform>
>(
  input: TransformCollisionGeometryKeyInput<TPieceId, TTransform>,
  settings: InternalGeometrySettings,
  cache: GeometryCacheStore,
  materialize: (
    value: InternalTransformedCollisionGeometry<TPieceId, TTransform>
  ) => TValue
): CoreTransformCollisionSuccess<TPieceId, TTransform> | CoreTransformCollisionFailure {
  const key = makeTransformCollisionGeometryCacheKey(input, settings)
  const cached = cache.get<TValue>(key)
  if (isValidCachedTransformedCollisionGeometry(cached, input)) {
    return { ok: true, value: cached, key }
  }

  if (cached !== undefined) cache.remove(key)
  const computed = computeTransformedCollisionGeometry(input)
  if (!computed.ok) return computed
  const value = materialize(computed.value)
  cache.set(key, value)
  return { ok: true, value, key }
}

/** Computes one mirror-then-rotate transform on the canonical collision grid. */
export function computeTransformedCollisionGeometry<
  TPieceId extends string,
  TTransform extends InternalTransformCandidate
>(
  input: TransformCollisionGeometryKeyInput<TPieceId, TTransform>
): CoreTransformCollisionResult<TPieceId, TTransform> {
  const boundary = ConvexPolygonValidation.validateStrictBoundary(
    input.geometry.collisionPolygon.points
  )
  if ('message' in boundary) return failure(boundary.message)

  const rotationDeg = normalizeRotationDegrees(input.transform.rotationDeg)
  const transformedPoints: InternalPoint[] = []
  for (const point of input.geometry.collisionPolygon.points) {
    const transformedPoint = transformPoint(point, input.transform.mirrored, rotationDeg)
    if (!Number.isFinite(transformedPoint.x) || !Number.isFinite(transformedPoint.y)) {
      return failure('transform must produce finite collision polygon coordinates.')
    }

    const snappedPoint = snapPointToCollisionGrid(transformedPoint)
    if (snappedPoint === undefined) {
      return failure(
        'transformed collision polygon coordinates must fit the canonical collision grid.'
      )
    }
    transformedPoints.push(snappedPoint)
  }

  const transformedBoundary = ConvexPolygonValidation.validateStrictBoundary(transformedPoints)
  if ('message' in transformedBoundary) {
    return failure(`transformed collision ${transformedBoundary.message}`)
  }

  const transformedBounds = boundsForPoints(transformedPoints)
  if (transformedBounds === undefined) {
    return failure('collision polygon must contain at least one transformable vertex.')
  }

  return {
    ok: true,
    value: {
      sourcePieceId: input.geometry.sourcePieceId,
      transform: input.transform,
      polygon: { points: transformedPoints },
      bounds: transformedBounds
    }
  }
}

export function isValidCachedTransformedCollisionGeometry<
  TPieceId extends string,
  TTransform extends InternalTransformCandidate
>(
  value: InternalTransformedCollisionGeometry<TPieceId, TTransform> | undefined,
  input: TransformCollisionGeometryKeyInput<TPieceId, TTransform>
): value is InternalTransformedCollisionGeometry<TPieceId, TTransform> {
  if (value === undefined || typeof value !== 'object' || value === null) return false
  if (value.sourcePieceId !== input.geometry.sourcePieceId) return false
  if (!sameTransform(value.transform, input.transform)) return false
  if (!isInternalPolygon(value.polygon) || value.polygon.points.length < 3) return false
  if ('message' in ConvexPolygonValidation.validateStrictBoundary(value.polygon.points)) {
    return false
  }
  const computedBounds = boundsForPoints(value.polygon.points)
  if (computedBounds === undefined) return false
  return (
    value.bounds.minX === computedBounds.minX &&
    value.bounds.minY === computedBounds.minY &&
    value.bounds.maxX === computedBounds.maxX &&
    value.bounds.maxY === computedBounds.maxY
  )
}

function snapPointToCollisionGrid(point: InternalPoint): InternalPoint | undefined {
  const x = toGridMm(point.x)
  const y = toGridMm(point.y)
  if (x === undefined || y === undefined) return undefined
  return { x: normalizeNegativeZero(fromGrid(x)), y: normalizeNegativeZero(fromGrid(y)) }
}

function normalizeRotationDegrees(rotationDeg: number): number {
  const remainder = rotationDeg % 360
  return remainder < 0 ? remainder + 360 : remainder
}

function transformPoint(
  point: InternalPoint,
  mirrored: boolean,
  rotationDeg: number
): InternalPoint {
  const x = mirrored ? -point.x : point.x
  const y = point.y

  switch (rotationDeg) {
    case 0:
      return { x: normalizeNegativeZero(x), y: normalizeNegativeZero(y) }
    case 90:
      return { x: normalizeNegativeZero(-y), y: normalizeNegativeZero(x) }
    case 180:
      return { x: normalizeNegativeZero(-x), y: normalizeNegativeZero(-y) }
    case 270:
      return { x: normalizeNegativeZero(y), y: normalizeNegativeZero(-x) }
    default: {
      const rotationRad = (rotationDeg * Math.PI) / 180
      const cos = Math.cos(rotationRad)
      const sin = Math.sin(rotationRad)
      return {
        x: normalizeNegativeZero(x * cos - y * sin),
        y: normalizeNegativeZero(x * sin + y * cos)
      }
    }
  }
}

function normalizeNegativeZero(value: number): number {
  return Object.is(value, -0) ? 0 : value
}

function failure(message: string): CoreTransformCollisionFailure {
  return { ok: false, message }
}
