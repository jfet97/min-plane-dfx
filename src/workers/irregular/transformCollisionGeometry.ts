import { Effect } from 'effect'
import {
  IrregularBounds,
  IrregularPoint,
  IrregularPolygon,
  TransformedCollisionGeometry
} from '@shared/irregular/domain.js'
import type { TransformCollisionGeometryInput } from './services.js'
import { IrregularGeometryInputError } from './services.js'
import { ConvexPolygonValidation } from './convexPolygonValidation.js'
import { fromGrid, toGridMm } from './clipper2OffsetPolicy.js'
import type { InternalBounds, InternalPoint, InternalPolygon } from './internalGeometry.js'

export const TransformCollisionGeometry = {
  compute
} as const

/**
 * Produces one rotated and optionally mirrored copy of a local collision
 * polygon, together with the polygon's new bounds.
 *
 * Input collision coordinates are already rebased so the padded collision
 * polygon bounds minimum is `(0, 0)`. That point is the placement origin: a
 * later placement translation says where this origin lands on the sheet.
 *
 * Mirroring happens first across the local Y axis, then rotation happens
 * counter-clockwise in DXF's Y-up coordinates. The operation never re-bases
 * after rotation. At `90°`, for example, some X coordinates become negative;
 * that is correct because the same placement origin remains fixed. The returned
 * bounds describe those negative extents for later IFP and placement work.
 */
function compute(
  input: TransformCollisionGeometryInput
): Effect.Effect<TransformedCollisionGeometry, IrregularGeometryInputError> {
  const { geometry, transform } = input
  // robust validation protects this direct service boundary as well as the builder pipeline
  const boundary = ConvexPolygonValidation.validateStrictBoundary(
    geometry.collisionPolygon.points
  )
  if ('message' in boundary) return failInvalidInput(boundary.message)

  const rotationDeg = normalizeRotationDegrees(transform.rotationDeg)
  const transformedPoints: InternalPoint[] = []
  for (const point of geometry.collisionPolygon.points) {
    const transformedPoint = transformPoint(point, transform.mirrored, rotationDeg)
    if (!Number.isFinite(transformedPoint.x) || !Number.isFinite(transformedPoint.y)) {
      return failInvalidInput('transform must produce finite collision polygon coordinates.')
    }

    const snappedPoint = snapPointToCollisionGrid(transformedPoint)
    if (snappedPoint === undefined) {
      return failInvalidInput(
        'transformed collision polygon coordinates must fit the canonical collision grid.'
      )
    }

    transformedPoints.push(snappedPoint)
  }

  const transformedBoundary = ConvexPolygonValidation.validateStrictBoundary(transformedPoints)
  if ('message' in transformedBoundary) {
    return failInvalidInput(`transformed collision ${transformedBoundary.message}`)
  }

  const bounds = boundsForPoints(transformedPoints)
  if (bounds === undefined) {
    return failInvalidInput('collision polygon must contain at least one transformable vertex.')
  }

  return Effect.succeed(
    new TransformedCollisionGeometry({
      sourcePieceId: geometry.sourcePieceId,
      transform,
      polygon: toDomainPolygon({ points: transformedPoints }),
      bounds: new IrregularBounds(bounds)
    })
  )
}

/**
 * Quantizes one transformed vertex through the collision kernel's canonical
 * 0.001 mm integer grid. Every downstream geometry authority consumes this
 * same point, including strict validation, bounds, NFP construction, direct
 * collision validation, scoring, and cache values.
 */
function snapPointToCollisionGrid(point: InternalPoint): InternalPoint | undefined {
  const x = toGridMm(point.x)
  const y = toGridMm(point.y)
  if (x === undefined || y === undefined) return undefined

  return {
    x: normalizeNegativeZero(fromGrid(x)),
    y: normalizeNegativeZero(fromGrid(y))
  }
}

/**
 * Converts any finite degree value to one equivalent angle in `[0, 360)`.
 *
 * This is angle periodicity, not a geometric tolerance: `450°` becomes the
 * exact same `90°` request, while `90.0001°` remains a distinct angle.
 */
function normalizeRotationDegrees(rotationDeg: number): number {
  const remainder = rotationDeg % 360
  return remainder < 0 ? remainder + 360 : remainder
}

/**
 * Applies the documented mirror-then-rotate order to one point around the
 * unchanged local origin.
 *
 * The right-angle branches use coordinate swaps and sign changes rather than
 * `sin` and `cos`. This keeps baseline transforms such as `90°` exactly
 * representable instead of producing values like `6.123e-17`.
 */
function transformPoint(
  point: InternalPoint,
  mirrored: boolean,
  rotationDeg: number
): InternalPoint {
  // mirror first so every caller gets one deterministic operation order
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

/**
 * Computes extents without changing any coordinates. Bounds are derived data,
 * not a reason to shift the polygon away from its stable placement origin.
 */
function boundsForPoints(points: ReadonlyArray<InternalPoint>): InternalBounds | undefined {
  const firstPoint = points[0]
  if (firstPoint === undefined) return undefined

  let minX = firstPoint.x
  let minY = firstPoint.y
  let maxX = firstPoint.x
  let maxY = firstPoint.y

  for (let index = 1; index < points.length; index += 1) {
    const point = points[index]
    if (point === undefined) return undefined
    minX = Math.min(minX, point.x)
    minY = Math.min(minY, point.y)
    maxX = Math.max(maxX, point.x)
    maxY = Math.max(maxY, point.y)
  }

  return { minX, minY, maxX, maxY }
}

function toDomainPolygon(polygon: InternalPolygon): IrregularPolygon {
  return new IrregularPolygon({
    points: polygon.points.map(
      (point) => new IrregularPoint({ x: point.x, y: point.y })
    )
  })
}

/**
 * Converts JavaScript's distinct `-0` value to `0` so exact orthogonal output
 * has one stable representation for equality checks, cache keys, and tests.
 */
function normalizeNegativeZero(value: number): number {
  return Object.is(value, -0) ? 0 : value
}

function failInvalidInput(message: string): Effect.Effect<never, IrregularGeometryInputError> {
  return Effect.fail(
    new IrregularGeometryInputError({
      operation: 'transformCollisionGeometry',
      message
    })
  )
}
