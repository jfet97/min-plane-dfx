import { Effect } from 'effect'
import { IrregularPoint, IrregularPolygon } from '@shared/irregular/domain.js'
import type { ValidatePlacementInput } from './services.js'
import { IrregularGeometryInputError } from './services.js'
import { ConvexPolygonValidation } from './convexPolygonValidation.js'
import { GeometryPredicates } from './geometryPredicates.js'

/** Checks translated convex placement geometry without using polygon booleans. */
export const PlacementValidation = {
  check,
  validate
} as const

/**
 * Returns whether a candidate is geometrically legal.
 *
 * Invalid polygons and non-finite derived translations remain typed geometry
 * failures. A candidate outside the sheet or with positive-area overlap is a
 * normal `false` result so candidate generation can filter it without
 * aborting the whole result. Boundaries are closed: exact edge, vertex, and
 * rotated contact are legal.
 */
function check(input: ValidatePlacementInput): Effect.Effect<boolean, IrregularGeometryInputError> {
  return assess(input).pipe(Effect.map(({ legal }) => legal))
}

/**
 * Preserves the strict assertion boundary used by the geometry-kernel service.
 * Candidate generation must use `check`, because an illegal candidate is not
 * an invalid geometry input.
 */
function validate(input: ValidatePlacementInput): Effect.Effect<void, IrregularGeometryInputError> {
  return assess(input).pipe(
    Effect.flatMap((assessment) =>
      assessment.legal
        ? Effect.void
        : failInvalidGeometry('validatePlacement', assessment.message)
    )
  )
}

function assess(
  input: ValidatePlacementInput
): Effect.Effect<PlacementAssessment, IrregularGeometryInputError> {
  const movingValidation = ConvexPolygonValidation.validateStrictBoundary(
    input.moving.polygon.points
  )
  if ('message' in movingValidation) {
    return failInvalidGeometry('validatePlacement', movingValidation.message)
  }

  const movingPolygon = translatePolygon(input.moving.polygon, input.candidate.point)
  if (movingPolygon === undefined) {
    return failInvalidGeometry(
      'validatePlacement',
      'moving translation must produce finite polygon coordinates.'
    )
  }

  const placedPolygons: IrregularPolygon[] = []

  for (const placed of input.placed) {
    const placedValidation = ConvexPolygonValidation.validateStrictBoundary(
      placed.collisionGeometry.polygon.points
    )
    if ('message' in placedValidation) {
      return failInvalidGeometry('validatePlacement', placedValidation.message)
    }

    const placedPolygon = translatePolygon(
      placed.collisionGeometry.polygon,
      new IrregularPoint({
        x: placed.placement.transform.translateX,
        y: placed.placement.transform.translateY
      })
    )
    if (placedPolygon === undefined) {
      return failInvalidGeometry(
        'validatePlacement',
        'placed translation must produce finite polygon coordinates.'
      )
    }

    placedPolygons.push(placedPolygon)
  }

  if (!isInsideSheet(movingPolygon.points, input.sheet.width, input.sheet.height)) {
    return Effect.succeed({
      legal: false,
      message: 'moving polygon must remain inside the sheet.'
    })
  }

  for (const placedPolygon of placedPolygons) {
    const overlap = polygonsHavePositiveAreaOverlap(movingPolygon, placedPolygon)
    if ('message' in overlap) return failInvalidGeometry('validatePlacement', overlap.message)
    if (overlap.value) {
      return Effect.succeed({
        legal: false,
        message: 'moving polygon has positive-area overlap with placed collision geometry.'
      })
    }
  }

  return Effect.succeed({ legal: true, message: '' })
}

function translatePolygon(
  polygon: IrregularPolygon,
  translation: IrregularPoint
): IrregularPolygon | undefined {
  const translatedPoints: IrregularPoint[] = []
  for (const point of polygon.points) {
    const x = point.x + translation.x
    const y = point.y + translation.y
    if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined
    translatedPoints.push(new IrregularPoint({ x, y }))
  }

  return new IrregularPolygon({ points: translatedPoints })
}

function isInsideSheet(
  points: ReadonlyArray<IrregularPoint>,
  sheetWidth: number,
  sheetHeight: number
): boolean {
  return points.every(
    (point) => point.x >= 0 && point.x <= sheetWidth && point.y >= 0 && point.y <= sheetHeight
  )
}

interface GeometryFailure {
  readonly message: string
}

interface PlacementAssessment {
  readonly legal: boolean
  readonly message: string
}

interface OverlapResult {
  readonly value: boolean
}

function polygonsHavePositiveAreaOverlap(
  first: IrregularPolygon,
  second: IrregularPolygon
): OverlapResult | GeometryFailure {
  const firstValidation = ConvexPolygonValidation.validateStrictBoundary(first.points)
  const secondValidation = ConvexPolygonValidation.validateStrictBoundary(second.points)
  if ('message' in firstValidation) return { message: firstValidation.message }
  if ('message' in secondValidation) return { message: secondValidation.message }

  for (const point of first.points) {
    if (isStrictlyInside(point, second, secondValidation.winding)) return { value: true }
  }
  for (const point of second.points) {
    if (isStrictlyInside(point, first, firstValidation.winding)) return { value: true }
  }

  const crossing = boundariesHaveProperCrossing(first, second)
  if ('message' in crossing) return crossing
  if (crossing.value) return { value: true }

  const firstInteriorPoint = strictConvexInteriorPoint(first)
  if ('message' in firstInteriorPoint) return firstInteriorPoint
  const secondInteriorPoint = strictConvexInteriorPoint(second)
  if ('message' in secondInteriorPoint) return secondInteriorPoint

  if (
    isStrictlyInside(firstInteriorPoint.value, second, secondValidation.winding) ||
    isStrictlyInside(secondInteriorPoint.value, first, firstValidation.winding)
  ) {
    return { value: true }
  }

  const collinearOverlap = boundariesHavePositiveCollinearOverlap(
    first,
    second,
    firstValidation.winding
  )
  if ('message' in collinearOverlap) return collinearOverlap
  if (collinearOverlap.value) return { value: true }

  // with strict convex rings, positive overlap without a strict vertex or a
  // proper crossing can only be coincident boundaries. Shared boundary contact
  // alone remains legal because it does not satisfy this condition.
  const firstOnSecond = first.points.every((point) => isOnBoundary(point, second))
  const secondOnFirst = second.points.every((point) => isOnBoundary(point, first))
  return { value: firstOnSecond && secondOnFirst }
}

/**
 * Computes the equal-weight vertex average, a strictly interior convex
 * combination for a strict convex ring.
 */
function strictConvexInteriorPoint(
  polygon: IrregularPolygon
): { readonly value: IrregularPoint } | GeometryFailure {
  const weight = 1 / polygon.points.length
  if (!Number.isFinite(weight)) {
    return { message: 'polygon interior-point arithmetic must produce finite coordinates.' }
  }

  let x = 0
  let y = 0
  for (const point of polygon.points) {
    const weightedX = point.x * weight
    const weightedY = point.y * weight
    if (!Number.isFinite(weightedX) || !Number.isFinite(weightedY)) {
      return { message: 'polygon interior-point arithmetic must produce finite coordinates.' }
    }

    x += weightedX
    y += weightedY
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return { message: 'polygon interior-point arithmetic must produce finite coordinates.' }
    }
  }

  return { value: new IrregularPoint({ x, y }) }
}

function boundariesHavePositiveCollinearOverlap(
  first: IrregularPolygon,
  second: IrregularPolygon,
  firstWinding: -1 | 1
): { readonly value: boolean } | GeometryFailure {
  for (const firstEdge of polygonEdges(first)) {
    for (const secondEdge of polygonEdges(second)) {
      if (
        GeometryPredicates.orientation(firstEdge.start, firstEdge.end, secondEdge.start) !== 0 ||
        GeometryPredicates.orientation(firstEdge.start, firstEdge.end, secondEdge.end) !== 0
      ) {
        continue
      }

      if (!segmentsHavePositiveLengthOverlap(firstEdge, secondEdge)) continue

      const secondInteriorPoint = second.points.find(
        (point) => GeometryPredicates.orientation(firstEdge.start, firstEdge.end, point) !== 0
      )
      if (secondInteriorPoint === undefined) {
        return { message: 'polygon interior side arithmetic must produce a finite classification.' }
      }

      const secondInteriorSide = GeometryPredicates.orientation(
        firstEdge.start,
        firstEdge.end,
        secondInteriorPoint
      )
      if (secondInteriorSide === firstWinding) return { value: true }
    }
  }

  return { value: false }
}

function segmentsHavePositiveLengthOverlap(first: PolygonEdge, second: PolygonEdge): boolean {
  const useX = Math.abs(first.end.x - first.start.x) >= Math.abs(first.end.y - first.start.y)
  const firstStart = useX ? first.start.x : first.start.y
  const firstEnd = useX ? first.end.x : first.end.y
  const secondStart = useX ? second.start.x : second.start.y
  const secondEnd = useX ? second.end.x : second.end.y
  return (
    Math.max(Math.min(firstStart, firstEnd), Math.min(secondStart, secondEnd)) <
    Math.min(Math.max(firstStart, firstEnd), Math.max(secondStart, secondEnd))
  )
}

function boundariesHaveProperCrossing(
  first: IrregularPolygon,
  second: IrregularPolygon
): { readonly value: boolean } | GeometryFailure {
  for (const firstEdge of polygonEdges(first)) {
    for (const secondEdge of polygonEdges(second)) {
      const firstStartTurn = GeometryPredicates.orientation(
        firstEdge.start,
        firstEdge.end,
        secondEdge.start
      )
      const firstEndTurn = GeometryPredicates.orientation(
        firstEdge.start,
        firstEdge.end,
        secondEdge.end
      )
      const secondStartTurn = GeometryPredicates.orientation(
        secondEdge.start,
        secondEdge.end,
        firstEdge.start
      )
      const secondEndTurn = GeometryPredicates.orientation(
        secondEdge.start,
        secondEdge.end,
        firstEdge.end
      )

      if (
        firstStartTurn === 0 ||
        firstEndTurn === 0 ||
        secondStartTurn === 0 ||
        secondEndTurn === 0
      ) {
        continue
      }

      if (firstStartTurn !== firstEndTurn && secondStartTurn !== secondEndTurn) {
        return { value: true }
      }
    }
  }

  return { value: false }
}

interface PolygonEdge {
  readonly start: IrregularPoint
  readonly end: IrregularPoint
}

function polygonEdges(polygon: IrregularPolygon): ReadonlyArray<PolygonEdge> {
  const edges: PolygonEdge[] = []
  for (let index = 0; index < polygon.points.length; index += 1) {
    const start = polygon.points[index]
    const end = polygon.points[(index + 1) % polygon.points.length]
    if (start !== undefined && end !== undefined) edges.push({ start, end })
  }
  return edges
}

function isStrictlyInside(
  point: IrregularPoint,
  polygon: IrregularPolygon,
  winding: -1 | 1
): boolean {
  for (const edge of polygonEdges(polygon)) {
    const turn = GeometryPredicates.orientation(edge.start, edge.end, point)
    if (turn === 0 || turn !== winding) return false
  }
  return true
}

function isOnBoundary(point: IrregularPoint, polygon: IrregularPolygon): boolean {
  for (const edge of polygonEdges(polygon)) {
    if (
      GeometryPredicates.orientation(edge.start, edge.end, point) === 0 &&
      pointIsOnSegment(point, edge)
    ) {
      return true
    }
  }
  return false
}

function pointIsOnSegment(point: IrregularPoint, edge: PolygonEdge): boolean {
  return (
    point.x >= Math.min(edge.start.x, edge.end.x) &&
    point.x <= Math.max(edge.start.x, edge.end.x) &&
    point.y >= Math.min(edge.start.y, edge.end.y) &&
    point.y <= Math.max(edge.start.y, edge.end.y)
  )
}

function failInvalidGeometry(
  operation: string,
  message: string
): Effect.Effect<never, IrregularGeometryInputError> {
  return Effect.fail(new IrregularGeometryInputError({ operation, message }))
}
