import { Effect, Layer } from 'effect'
import {
  IrregularBounds,
  IrregularIfpBounds,
  IrregularNfp,
  IrregularPlacementCandidate,
  IrregularPoint,
  IrregularPolygon
} from '@shared/irregular/domain.js'
import type {
  ComputeIfpBoundsInput,
  ComputeNfpInput,
  GeneratePlacementCandidatesInput
} from './services.js'
import { IrregularGeometryInputError, NfpIfpService } from './services.js'
import { ConvexHull } from './convexHull.js'
import { ConvexPolygonValidation } from './convexPolygonValidation.js'
import { GeometryPredicates } from './geometryPredicates.js'
import { PlacementValidation } from './placementValidation.js'

/** Provides deterministic convex IFP bounds and outer NFP boundaries. */
export const NfpIfpServiceLive = Layer.succeed(NfpIfpService, {
  computeNfp,
  computeIfpBounds,
  generatePlacementCandidates
})

/**
 * Computes the outer forbidden translation boundary for two strict convex polygons.
 *
 * For a fixed polygon `F` already translated into sheet space and a moving local
 * polygon `M`, the forbidden placement translations are `F ⊕ (-M)`. A
 * Minkowski sum is defined exactly as `A ⊕ B = { a + b | a ∈ A, b ∈ B }`.
 * Here `-M` means multiplying every moving local point by `-1`: translating
 * `M` by `t` meets `F` exactly when some `f + (-m)` equals `t`, so collision
 * translations become this sum. For convex polygons, pairwise vertex sums
 * followed by a convex hull produce the same Minkowski sum boundary.
 *
 * The returned NFP uses placement-coordinate space: its interior means
 * positive-area overlap is forbidden, while its boundary means touching is
 * allowed.
 */
function computeNfp(
  input: ComputeNfpInput
): Effect.Effect<IrregularNfp, IrregularGeometryInputError> {
  const fixedValidation = ConvexPolygonValidation.validateStrictBoundary(
    input.fixed.collisionGeometry.polygon.points
  )
  if ('message' in fixedValidation)
    return failInvalidGeometry('computeNfp', fixedValidation.message)

  const movingValidation = ConvexPolygonValidation.validateStrictBoundary(
    input.moving.polygon.points
  )
  if ('message' in movingValidation)
    return failInvalidGeometry('computeNfp', movingValidation.message)

  const fixedSheetPoints: IrregularPoint[] = []
  for (const point of input.fixed.collisionGeometry.polygon.points) {
    const x = point.x + input.fixed.placement.transform.translateX
    const y = point.y + input.fixed.placement.transform.translateY
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return failInvalidGeometry('computeNfp', 'fixed translation must produce finite coordinates.')
    }
    fixedSheetPoints.push(new IrregularPoint({ x, y }))
  }

  const negatedMovingPoints = input.moving.polygon.points.map(
    (point) => new IrregularPoint({ x: -point.x, y: -point.y })
  )
  const minkowskiPoints: IrregularPoint[] = []
  for (const fixedPoint of fixedSheetPoints) {
    for (const movingPoint of negatedMovingPoints) {
      const x = fixedPoint.x + movingPoint.x
      const y = fixedPoint.y + movingPoint.y
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return failInvalidGeometry('computeNfp', 'Minkowski sum must produce finite coordinates.')
      }
      minkowskiPoints.push(new IrregularPoint({ x, y }))
    }
  }

  const boundary = ConvexHull.compute(minkowskiPoints)
  const boundaryValidation = ConvexPolygonValidation.validateStrictBoundary(boundary.points)
  if ('message' in boundaryValidation)
    return failInvalidGeometry('computeNfp', boundaryValidation.message)

  return Effect.succeed(
    new IrregularNfp({
      fixedPieceId: input.fixed.placement.sourcePieceId,
      movingPieceId: input.moving.sourcePieceId,
      boundary: new IrregularPolygon({ points: rotateToStableStart(boundary.points) })
    })
  )
}

/**
 * Computes sheet translation bounds from the actual polygon vertices.
 *
 * `TransformedCollisionGeometry.bounds` is derived cache data and is not
 * trusted at this legality boundary; a stale cache must not enlarge the IFP.
 */
function computeIfpBounds(
  input: ComputeIfpBoundsInput
): Effect.Effect<IrregularIfpBounds, IrregularGeometryInputError> {
  const validation = ConvexPolygonValidation.validateStrictBoundary(input.moving.polygon.points)
  if ('message' in validation) return failInvalidGeometry('computeIfpBounds', validation.message)

  const polygonBounds = boundsForPoints(input.moving.polygon.points)
  if (polygonBounds === undefined) {
    return failInvalidGeometry('computeIfpBounds', 'moving polygon bounds must be finite.')
  }

  const minX = normalizeNegativeZero(-polygonBounds.minX)
  const minY = normalizeNegativeZero(-polygonBounds.minY)
  const maxX = normalizeNegativeZero(input.sheet.width - polygonBounds.maxX)
  const maxY = normalizeNegativeZero(input.sheet.height - polygonBounds.maxY)
  if (
    !Number.isFinite(minX) ||
    !Number.isFinite(minY) ||
    !Number.isFinite(maxX) ||
    !Number.isFinite(maxY)
  ) {
    return failInvalidGeometry('computeIfpBounds', 'IFP arithmetic must produce finite bounds.')
  }
  if (minX > maxX || minY > maxY) {
    return failInvalidGeometry('computeIfpBounds', 'moving polygon cannot fit inside the sheet.')
  }

  const bounds = new IrregularBounds({ minX, minY, maxX, maxY })

  return Effect.succeed(
    new IrregularIfpBounds({
      sheet: input.sheet,
      movingPieceId: input.moving.sourcePieceId,
      bounds
    })
  )
}

/** Builds deterministic IFP/NFP contact candidates and filters illegal results. */
function generatePlacementCandidates(
  input: GeneratePlacementCandidatesInput
): Effect.Effect<ReadonlyArray<IrregularPlacementCandidate>, IrregularGeometryInputError> {
  return Effect.gen(function* () {
    const ifp = yield* computeIfpBounds({ sheet: input.sheet, moving: input.moving })
    const nfpBoundaries: NfpBoundary[] = []

    for (const placed of input.placed) {
      const nfp = yield* computeNfp({
        fixed: placed,
        moving: input.moving,
        settings: input.settings.geometry
      })
      const validation = ConvexPolygonValidation.validateStrictBoundary(nfp.boundary.points)
      if ('message' in validation)
        return yield* failInvalidGeometry('generatePlacementCandidates', validation.message)
      nfpBoundaries.push({ nfp, winding: validation.winding })
    }

    const ifpSegments = rectangleSegments(ifp.bounds)
    const pointsByKey = new Map<string, IrregularPoint>()
    for (const point of rectangleCorners(ifp.bounds)) addPoint(pointsByKey, point)
    for (const { nfp } of nfpBoundaries) {
      for (const point of nfp.boundary.points) addPoint(pointsByKey, point)
    }

    for (const { nfp } of nfpBoundaries) {
      const intersections = addBoundaryIntersections(
        pointsByKey,
        ifpSegments,
        polygonSegments(nfp.boundary)
      )
      if (intersections !== undefined) {
        return yield* failInvalidGeometry('generatePlacementCandidates', intersections)
      }
    }

    for (let firstIndex = 0; firstIndex < nfpBoundaries.length; firstIndex += 1) {
      const first = nfpBoundaries[firstIndex]
      if (first === undefined)
        return yield* failInvalidGeometry('generatePlacementCandidates', 'NFP boundary is missing.')

      for (let secondIndex = firstIndex + 1; secondIndex < nfpBoundaries.length; secondIndex += 1) {
        const second = nfpBoundaries[secondIndex]
        if (second === undefined)
          return yield* failInvalidGeometry(
            'generatePlacementCandidates',
            'NFP boundary is missing.'
          )

        const intersections = addBoundaryIntersections(
          pointsByKey,
          polygonSegments(first.nfp.boundary),
          polygonSegments(second.nfp.boundary)
        )
        if (intersections !== undefined) {
          return yield* failInvalidGeometry('generatePlacementCandidates', intersections)
        }
      }
    }

    const candidates: IrregularPlacementCandidate[] = []
    const sortedPoints = [...pointsByKey.values()].sort(comparePoints)
    for (const point of sortedPoints) {
      if (!isInsideBounds(point, ifp.bounds)) continue
      if (
        nfpBoundaries.some(({ nfp, winding }) => isStrictlyInside(point, nfp.boundary, winding))
      ) {
        continue
      }

      const candidate = new IrregularPlacementCandidate({
        pieceId: input.moving.sourcePieceId,
        transform: input.moving.transform,
        point,
        diagnostics: []
      })
      const legal = yield* PlacementValidation.check({
        sheet: input.sheet,
        placed: input.placed,
        moving: input.moving,
        candidate
      })
      if (legal) candidates.push(candidate)
    }

    return candidates
  })
}

function boundsForPoints(points: ReadonlyArray<IrregularPoint>): IrregularBounds | undefined {
  const firstPoint = points[0]
  if (firstPoint === undefined) return undefined
  if (!Number.isFinite(firstPoint.x) || !Number.isFinite(firstPoint.y)) return undefined

  let minX = firstPoint.x
  let minY = firstPoint.y
  let maxX = firstPoint.x
  let maxY = firstPoint.y

  for (const point of points.slice(1)) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return undefined
    minX = Math.min(minX, point.x)
    minY = Math.min(minY, point.y)
    maxX = Math.max(maxX, point.x)
    maxY = Math.max(maxY, point.y)
  }

  if (
    !Number.isFinite(minX) ||
    !Number.isFinite(minY) ||
    !Number.isFinite(maxX) ||
    !Number.isFinite(maxY)
  ) {
    return undefined
  }

  return new IrregularBounds({ minX, minY, maxX, maxY })
}

interface Segment {
  readonly start: IrregularPoint
  readonly end: IrregularPoint
}

interface NfpBoundary {
  readonly nfp: IrregularNfp
  readonly winding: -1 | 1
}

interface SegmentIntersection {
  readonly points: ReadonlyArray<IrregularPoint>
}

function rectangleCorners(bounds: IrregularBounds): ReadonlyArray<IrregularPoint> {
  return [
    new IrregularPoint({ x: bounds.minX, y: bounds.minY }),
    new IrregularPoint({ x: bounds.maxX, y: bounds.minY }),
    new IrregularPoint({ x: bounds.maxX, y: bounds.maxY }),
    new IrregularPoint({ x: bounds.minX, y: bounds.maxY })
  ]
}

function rectangleSegments(bounds: IrregularBounds): ReadonlyArray<Segment> {
  const corners = rectangleCorners(bounds)
  return polygonSegments(new IrregularPolygon({ points: corners }))
}

function polygonSegments(polygon: IrregularPolygon): ReadonlyArray<Segment> {
  const segments: Segment[] = []
  for (let index = 0; index < polygon.points.length; index += 1) {
    const start = polygon.points[index]
    const end = polygon.points[(index + 1) % polygon.points.length]
    if (start !== undefined && end !== undefined) segments.push({ start, end })
  }
  return segments
}

function addBoundaryIntersections(
  pointsByKey: Map<string, IrregularPoint>,
  firstSegments: ReadonlyArray<Segment>,
  secondSegments: ReadonlyArray<Segment>
): string | undefined {
  for (const first of firstSegments) {
    for (const second of secondSegments) {
      const intersection = intersectSegments(first, second)
      if ('message' in intersection) return intersection.message
      for (const point of intersection.points) addPoint(pointsByKey, point)
    }
  }
  return undefined
}

function intersectSegments(
  first: Segment,
  second: Segment
): SegmentIntersection | { readonly message: string } {
  const firstStartTurn = GeometryPredicates.orientation(first.start, first.end, second.start)
  const firstEndTurn = GeometryPredicates.orientation(first.start, first.end, second.end)
  const secondStartTurn = GeometryPredicates.orientation(second.start, second.end, first.start)
  const secondEndTurn = GeometryPredicates.orientation(second.start, second.end, first.end)
  const points: IrregularPoint[] = []

  if (
    firstStartTurn !== 0 &&
    firstEndTurn !== 0 &&
    secondStartTurn !== 0 &&
    secondEndTurn !== 0 &&
    firstStartTurn !== firstEndTurn &&
    secondStartTurn !== secondEndTurn
  ) {
    const firstDirectionX = first.end.x - first.start.x
    const firstDirectionY = first.end.y - first.start.y
    const secondDirectionX = second.end.x - second.start.x
    const secondDirectionY = second.end.y - second.start.y
    const denominator = firstDirectionX * secondDirectionY - firstDirectionY * secondDirectionX
    const offsetX = second.start.x - first.start.x
    const offsetY = second.start.y - first.start.y
    const numerator = offsetX * secondDirectionY - offsetY * secondDirectionX
    const parameter = numerator / denominator
    const x = first.start.x + parameter * firstDirectionX
    const y = first.start.y + parameter * firstDirectionY
    if (
      !Number.isFinite(firstDirectionX) ||
      !Number.isFinite(firstDirectionY) ||
      !Number.isFinite(secondDirectionX) ||
      !Number.isFinite(secondDirectionY) ||
      !Number.isFinite(denominator) ||
      !Number.isFinite(parameter) ||
      !Number.isFinite(x) ||
      !Number.isFinite(y)
    ) {
      return { message: 'segment intersection arithmetic must produce finite coordinates.' }
    }
    return { points: [new IrregularPoint({ x, y })] }
  }

  if (firstStartTurn === 0 && pointIsOnSegment(second.start, first)) points.push(second.start)
  if (firstEndTurn === 0 && pointIsOnSegment(second.end, first)) points.push(second.end)
  if (secondStartTurn === 0 && pointIsOnSegment(first.start, second)) points.push(first.start)
  if (secondEndTurn === 0 && pointIsOnSegment(first.end, second)) points.push(first.end)

  return { points }
}

function pointIsOnSegment(point: IrregularPoint, segment: Segment): boolean {
  return (
    point.x >= Math.min(segment.start.x, segment.end.x) &&
    point.x <= Math.max(segment.start.x, segment.end.x) &&
    point.y >= Math.min(segment.start.y, segment.end.y) &&
    point.y <= Math.max(segment.start.y, segment.end.y)
  )
}

function addPoint(pointsByKey: Map<string, IrregularPoint>, point: IrregularPoint): void {
  const canonicalPoint = new IrregularPoint({
    x: normalizeNegativeZero(point.x),
    y: normalizeNegativeZero(point.y)
  })
  const key = `${canonicalPoint.x}:${canonicalPoint.y}`
  if (!pointsByKey.has(key)) pointsByKey.set(key, canonicalPoint)
}

function comparePoints(first: IrregularPoint, second: IrregularPoint): number {
  if (first.y !== second.y) return first.y - second.y
  return first.x - second.x
}

function isInsideBounds(point: IrregularPoint, bounds: IrregularBounds): boolean {
  return (
    point.x >= bounds.minX &&
    point.x <= bounds.maxX &&
    point.y >= bounds.minY &&
    point.y <= bounds.maxY
  )
}

function isStrictlyInside(
  point: IrregularPoint,
  polygon: IrregularPolygon,
  winding: -1 | 1
): boolean {
  for (let index = 0; index < polygon.points.length; index += 1) {
    const start = polygon.points[index]
    const end = polygon.points[(index + 1) % polygon.points.length]
    if (start === undefined || end === undefined) return false
    const turn = GeometryPredicates.orientation(start, end, point)
    if (turn === 0 || turn !== winding) return false
  }
  return true
}

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

function normalizeNegativeZero(value: number): number {
  return Object.is(value, -0) ? 0 : value
}

function failInvalidGeometry(
  operation: string,
  message: string
): Effect.Effect<never, IrregularGeometryInputError> {
  return Effect.fail(new IrregularGeometryInputError({ operation, message }))
}
