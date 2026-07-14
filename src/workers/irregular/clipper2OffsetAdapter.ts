import {
  area,
  EndType,
  inflatePaths,
  isPositive,
  JoinType,
  type Path64,
  type Point64,
  type Paths64
} from 'clipper2-ts'
import { Effect } from 'effect'
import { IrregularPoint, IrregularPolygon } from '@shared/irregular/domain.js'
import { ConvexPolygonValidation } from './convexPolygonValidation.js'
import { GeometryPredicates } from './geometryPredicates.js'
import { CLIPPER2_OFFSET_POLICY, fromGrid, toGridMm } from './clipper2OffsetPolicy.js'
import { IrregularGeometryInputError } from './services.js'

/** Input to the integer-path Clipper2 offset adapter, measured in millimeters. */
export interface Clipper2OffsetInput {
  readonly polygon: IrregularPolygon
  readonly distanceMm: number
}

/**
 * Runs one positive-or-zero convex offset through Clipper2's integer Paths64
 * API and returns exactly one finite, simple, convex, CCW polygon.
 */
export const Clipper2OffsetAdapter = {
  compute
} as const

/**
 * Applies the policy boundary: robustly validates the source, quantizes once,
 * guards scaled coordinates, calls Miter/Polygon inflation, and validates the
 * single derived path before dequantizing it.
 */
function compute(
  input: Clipper2OffsetInput
): Effect.Effect<IrregularPolygon, IrregularGeometryInputError> {
  if (!Number.isFinite(input.distanceMm) || input.distanceMm < 0) {
    return failInvalidInput('distanceMm must be a finite non-negative millimeter distance.')
  }

  const boundary = ConvexPolygonValidation.validateStrictBoundary(input.polygon.points)
  if ('message' in boundary) return failInvalidInput(boundary.message)
  if (!isSimpleBoundary(input.polygon.points)) {
    return failInvalidInput('polygon must be a single simple convex closed ring.')
  }

  const canonicalPoints =
    boundary.winding === 1 ? [...input.polygon.points] : [...input.polygon.points].reverse()
  const integerPath = toIntegerPath(canonicalPoints)
  if ('message' in integerPath) return failInvalidInput(integerPath.message)

  const quantizedValidation = validatePath(integerPath.path, 'quantized input')
  if (quantizedValidation !== undefined) return failInvalidInput(quantizedValidation)

  const scaledOffset = toGridMm(input.distanceMm)
  if (scaledOffset === undefined) {
    return failInvalidInput('distanceMm cannot be represented by the Clipper2 integer grid.')
  }

  const coordinateGuardMessage = validateCoordinateGuard(integerPath.path, scaledOffset)
  if (coordinateGuardMessage !== undefined) return failInvalidInput(coordinateGuardMessage)

  let offsetPaths: Paths64
  try {
    offsetPaths = inflatePaths(
      [integerPath.path],
      scaledOffset,
      JoinType.Miter,
      EndType.Polygon,
      CLIPPER2_OFFSET_POLICY.miterLimit,
      CLIPPER2_OFFSET_POLICY.futureRoundJoinArcToleranceMm * CLIPPER2_OFFSET_POLICY.scale
    )
  } catch (error) {
    return failInvalidInput(clipperFailureMessage(error))
  }

  if (offsetPaths.length !== 1) {
    return failInvalidInput(
      `Clipper2 offset must return exactly one path; received ${offsetPaths.length}.`
    )
  }

  const offsetPath = offsetPaths[0]
  if (offsetPath === undefined) {
    return failInvalidInput('Clipper2 offset returned no path.')
  }

  const outputValidation = validatePath(offsetPath, 'Clipper2 offset result')
  if (outputValidation !== undefined) return failInvalidInput(outputValidation)
  if (!isPositive(offsetPath)) {
    return failInvalidInput('Clipper2 offset result must use counter-clockwise winding.')
  }

  const outputGuardMessage = validateOutputCoordinates(offsetPath)
  if (outputGuardMessage !== undefined) return failInvalidInput(outputGuardMessage)

  return Effect.succeed(
    new IrregularPolygon({
      points: toIrregularPoints(rotateToStableStart(offsetPath))
    })
  )
}

interface IntegerPathResult {
  readonly path: Path64
}

/** Converts real points to safe integer grid points without hidden library rounding. */
function toIntegerPath(
  points: ReadonlyArray<IrregularPoint>
): IntegerPathResult | { readonly message: string } {
  const path: Path64 = []
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index]
    if (point === undefined) {
      return { message: 'polygon points must form a closed boundary.' }
    }

    const x = toGridMm(point.x)
    const y = toGridMm(point.y)
    if (x === undefined || y === undefined) {
      return {
        message: `polygon vertex ${index} cannot be represented by the Clipper2 integer grid.`
      }
    }
    path.push({ x, y })
  }

  return { path }
}

/** Rejects duplicate, non-convex, non-simple, zero-area, or unsafe integer paths. */
function validatePath(path: Path64, label: string): string | undefined {
  if (path.length < 3) return `${label} must contain at least three vertices.`

  const uniquePoints = new Set<string>()
  for (const point of path) {
    if (!Number.isSafeInteger(point.x) || !Number.isSafeInteger(point.y)) {
      return `${label} contains a non-finite or unsafe integer coordinate.`
    }

    const key = `${point.x}:${point.y}`
    if (uniquePoints.has(key)) return `${label} must contain at least three unique vertices.`
    uniquePoints.add(key)
  }

  const points = toIrregularPoints(path)
  const boundary = ConvexPolygonValidation.validateStrictBoundary(points)
  if ('message' in boundary) return `${label} ${boundary.message}`
  if (!isSimpleBoundary(points)) return `${label} must be a single simple convex closed ring.`

  const signedArea = area(path)
  if (!Number.isFinite(signedArea) || signedArea === 0) {
    return `${label} must have a finite non-zero area.`
  }

  return undefined
}

/** Enforces the planned coordinate headroom before Clipper2 receives the path. */
function validateCoordinateGuard(path: Path64, scaledOffset: number): string | undefined {
  const offsetHeadroom = 2 * Math.abs(scaledOffset)
  for (const point of path) {
    if (
      Math.abs(point.x) + offsetHeadroom > CLIPPER2_OFFSET_POLICY.maxScaledCoordinate ||
      Math.abs(point.y) + offsetHeadroom > CLIPPER2_OFFSET_POLICY.maxScaledCoordinate
    ) {
      return 'polygon coordinates plus twice the scaled offset exceed the Clipper2 coordinate guard.'
    }
  }

  return undefined
}

/** Rejects malformed or out-of-range coordinates returned by the external library. */
function validateOutputCoordinates(path: Path64): string | undefined {
  for (const point of path) {
    if (
      !Number.isSafeInteger(point.x) ||
      !Number.isSafeInteger(point.y) ||
      Math.abs(point.x) > CLIPPER2_OFFSET_POLICY.maxScaledCoordinate ||
      Math.abs(point.y) > CLIPPER2_OFFSET_POLICY.maxScaledCoordinate
    ) {
      return 'Clipper2 offset result contains a coordinate outside the scaled coordinate guard.'
    }
  }

  return undefined
}

/** Converts integer path coordinates back to domain points without re-rounding. */
function toIrregularPoints(path: ReadonlyArray<Point64>): IrregularPoint[] {
  return path.map((point) => new IrregularPoint({ x: fromGrid(point.x), y: fromGrid(point.y) }))
}

/** Gives every adapter result a stable lowest-left starting vertex. */
function rotateToStableStart(path: Path64): Path64 {
  let startIndex = 0
  for (let index = 1; index < path.length; index += 1) {
    const candidate = path[index]
    const current = path[startIndex]
    if (candidate === undefined || current === undefined) continue
    if (candidate.y < current.y || (candidate.y === current.y && candidate.x < current.x)) {
      startIndex = index
    }
  }

  return [...path.slice(startIndex), ...path.slice(0, startIndex)]
}

/** Checks every pair of non-adjacent edges for robust self-intersection. */
function isSimpleBoundary(points: ReadonlyArray<IrregularPoint>): boolean {
  for (let firstEdgeIndex = 0; firstEdgeIndex < points.length; firstEdgeIndex += 1) {
    const firstStart = points[firstEdgeIndex]
    const firstEnd = points[(firstEdgeIndex + 1) % points.length]
    if (firstStart === undefined || firstEnd === undefined) return false

    for (
      let secondEdgeIndex = firstEdgeIndex + 1;
      secondEdgeIndex < points.length;
      secondEdgeIndex += 1
    ) {
      if (edgesAreAdjacent(firstEdgeIndex, secondEdgeIndex, points.length)) continue

      const secondStart = points[secondEdgeIndex]
      const secondEnd = points[(secondEdgeIndex + 1) % points.length]
      if (secondStart === undefined || secondEnd === undefined) return false
      if (segmentsIntersect(firstStart, firstEnd, secondStart, secondEnd)) return false
    }
  }

  return true
}

/** Identifies shared endpoints that are expected between neighboring polygon edges. */
function edgesAreAdjacent(firstIndex: number, secondIndex: number, pointCount: number): boolean {
  return (
    firstIndex === secondIndex ||
    (firstIndex + 1) % pointCount === secondIndex ||
    (secondIndex + 1) % pointCount === firstIndex
  )
}

/** Uses robust orientations to reject crossing or touching non-adjacent segments. */
function segmentsIntersect(
  firstStart: IrregularPoint,
  firstEnd: IrregularPoint,
  secondStart: IrregularPoint,
  secondEnd: IrregularPoint
): boolean {
  const firstStartTurn = GeometryPredicates.orientation(firstStart, firstEnd, secondStart)
  const firstEndTurn = GeometryPredicates.orientation(firstStart, firstEnd, secondEnd)
  const secondStartTurn = GeometryPredicates.orientation(secondStart, secondEnd, firstStart)
  const secondEndTurn = GeometryPredicates.orientation(secondStart, secondEnd, firstEnd)

  if (firstStartTurn === 0 && isOnSegment(secondStart, firstStart, firstEnd)) return true
  if (firstEndTurn === 0 && isOnSegment(secondEnd, firstStart, firstEnd)) return true
  if (secondStartTurn === 0 && isOnSegment(firstStart, secondStart, secondEnd)) return true
  if (secondEndTurn === 0 && isOnSegment(firstEnd, secondStart, secondEnd)) return true

  return firstStartTurn !== firstEndTurn && secondStartTurn !== secondEndTurn
}

/** Checks a collinear point against the closed axis-aligned bounds of a segment. */
function isOnSegment(
  point: IrregularPoint,
  segmentStart: IrregularPoint,
  segmentEnd: IrregularPoint
): boolean {
  return (
    point.x >= Math.min(segmentStart.x, segmentEnd.x) &&
    point.x <= Math.max(segmentStart.x, segmentEnd.x) &&
    point.y >= Math.min(segmentStart.y, segmentEnd.y) &&
    point.y <= Math.max(segmentStart.y, segmentEnd.y)
  )
}

/** Preserves external-library failure context in the typed domain error message. */
function clipperFailureMessage(error: unknown): string {
  if (error instanceof Error) return `Clipper2 offset failed: ${error.message}`
  return 'Clipper2 offset failed with a non-error exception.'
}

/** Builds the typed failure returned for every rejected geometry operation. */
function failInvalidInput(message: string): Effect.Effect<never, IrregularGeometryInputError> {
  return Effect.fail(
    new IrregularGeometryInputError({
      operation: 'offsetConvexPolygon',
      message
    })
  )
}
