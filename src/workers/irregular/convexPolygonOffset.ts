import { Effect } from 'effect'
import { IrregularPoint, IrregularPolygon } from '@shared/irregular/domain.js'
import { Clipper2OffsetAdapter } from './clipper2OffsetAdapter.js'
import { ConvexPolygonValidation, type ConvexPolygonWinding } from './convexPolygonValidation.js'
import { IrregularGeometryInputError } from './services.js'

/** Offsets one validated convex polygon through the project-owned geometry adapter. */
export const ConvexPolygonOffset = {
  compute
} as const

/**
 * Validates the real-valued convex input before it crosses into integer geometry.
 * The returned polygon uses the adapter's deterministic policy and preserves the
 * caller's winding at this public boundary for compatibility with existing
 * collision-geometry consumers.
 */
function compute(
  polygon: IrregularPolygon,
  distanceMm: number
): Effect.Effect<IrregularPolygon, IrregularGeometryInputError> {
  if (!Number.isFinite(distanceMm) || distanceMm < 0) {
    return failInvalidInput('distanceMm must be a finite non-negative millimeter distance.')
  }

  const boundary = ConvexPolygonValidation.validateStrictBoundary(polygon.points)
  if ('message' in boundary) return failInvalidInput(boundary.message)

  return Clipper2OffsetAdapter.compute({ polygon, distanceMm }).pipe(
    Effect.map((offsetPolygon) => restoreInputWinding(offsetPolygon, boundary.winding))
  )
}

/** Restores the caller's clockwise winding after the adapter's CCW computation. */
function restoreInputWinding(
  polygon: IrregularPolygon,
  winding: ConvexPolygonWinding
): IrregularPolygon {
  if (winding === 1) return polygon

  const reversedPoints = [...polygon.points].reverse()
  return new IrregularPolygon({ points: rotateToStableStart(reversedPoints) })
}

/** Rotates a closed polygon to its lowest, then leftmost, vertex without reversing it. */
function rotateToStableStart(points: ReadonlyArray<IrregularPoint>): IrregularPoint[] {
  let startIndex = 0
  for (let index = 1; index < points.length; index += 1) {
    const candidate = points[index]
    const current = points[startIndex]
    if (candidate === undefined || current === undefined) continue
    if (candidate.y < current.y || (candidate.y === current.y && candidate.x < current.x)) {
      startIndex = index
    }
  }

  return [...points.slice(startIndex), ...points.slice(0, startIndex)]
}

/** Converts an adapter failure into the typed geometry error used by worker services. */
function failInvalidInput(message: string): Effect.Effect<never, IrregularGeometryInputError> {
  return Effect.fail(
    new IrregularGeometryInputError({
      operation: 'offsetConvexPolygon',
      message
    })
  )
}
