import { Effect } from 'effect'
import { IrregularPoint, IrregularPolygon } from '@shared/irregular/domain.js'
import type { ValidatePlacementInput } from './services.js'
import { IrregularGeometryInputError } from './services.js'
import {
  ConvexPolygonValidation,
  type ConvexPolygonWinding
} from './convexPolygonValidation.js'
import {
  areDisjoint,
  translatePolygonWithBounds,
  type PolygonWithBounds
} from './convexBounds.js'
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
  const movingPolygon = translateAndValidatePolygon(
    input.moving.polygon,
    input.candidate.point,
    'moving'
  )
  if ('message' in movingPolygon) {
    return failInvalidGeometry(
      'validatePlacement',
      movingPolygon.message
    )
  }

  const placedPolygons: ValidatedPolygonWithBounds[] = []

  for (const placed of input.placed) {
    const placedPolygon = translateAndValidatePolygon(
      placed.collisionGeometry.polygon,
      new IrregularPoint({
        x: placed.placement.transform.translateX,
        y: placed.placement.transform.translateY
      }),
      'placed'
    )
    if ('message' in placedPolygon) {
      return failInvalidGeometry(
        'validatePlacement',
        placedPolygon.message
      )
    }

    placedPolygons.push(placedPolygon)
  }

  if (!isInsideSheet(movingPolygon.polygon.points, input.sheet.width, input.sheet.height)) {
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

interface ValidatedPolygonWithBounds extends PolygonWithBounds {
  readonly winding: ConvexPolygonWinding
}

interface OverlapResult {
  readonly value: boolean
}

function polygonsHavePositiveAreaOverlap(
  first: ValidatedPolygonWithBounds,
  second: ValidatedPolygonWithBounds
): OverlapResult | GeometryFailure {
  if (areDisjoint(first.bounds, second.bounds)) return { value: false }

  for (const point of first.polygon.points) {
    if (isStrictlyInside(point, second.polygon, second.winding)) return { value: true }
  }
  for (const point of second.polygon.points) {
    if (isStrictlyInside(point, first.polygon, first.winding)) return { value: true }
  }

  const crossing = boundariesHaveProperCrossing(first.polygon, second.polygon)
  if ('message' in crossing) return crossing
  if (crossing.value) return { value: true }

  const firstInteriorPoint = strictConvexInteriorPoint(first.polygon)
  if ('message' in firstInteriorPoint) return firstInteriorPoint
  const secondInteriorPoint = strictConvexInteriorPoint(second.polygon)
  if ('message' in secondInteriorPoint) return secondInteriorPoint

  if (
    isStrictlyInside(firstInteriorPoint.value, second.polygon, second.winding) ||
    isStrictlyInside(secondInteriorPoint.value, first.polygon, first.winding)
  ) {
    return { value: true }
  }

  const collinearOverlap = boundariesHavePositiveCollinearOverlap(
    first.polygon,
    second.polygon,
    first.winding
  )
  if ('message' in collinearOverlap) return collinearOverlap
  if (collinearOverlap.value) return { value: true }

  // with strict convex rings, positive overlap without a strict vertex or a
  // proper crossing can only be coincident boundaries. Shared boundary contact
  // alone remains legal because it does not satisfy this condition.
  const firstOnSecond = first.polygon.points.every((point) => isOnBoundary(point, second.polygon))
  const secondOnFirst = second.polygon.points.every((point) => isOnBoundary(point, first.polygon))
  return { value: firstOnSecond && secondOnFirst }
}

function translateAndValidatePolygon(
  polygon: IrregularPolygon,
  translation: IrregularPoint,
  label: string
): ValidatedPolygonWithBounds | GeometryFailure {
  const translatedPolygon = translatePolygonWithBounds(polygon, translation)
  if (translatedPolygon === undefined) {
    return { message: `${label} translation must produce finite polygon coordinates.` }
  }

  const validation = ConvexPolygonValidation.validateStrictBoundary(
    translatedPolygon.polygon.points
  )
  if ('message' in validation) return validation

  return { ...translatedPolygon, winding: validation.winding }
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
