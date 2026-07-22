import { Effect } from 'effect'
import type { ValidatePlacementInput } from './services.js'
import { IrregularGeometryInputError } from './services.js'
import type {
  InternalPoint,
  InternalPolygon,
  InternalPolygonWithBounds
} from './internalGeometry.js'
import {
  ConvexPolygonValidation,
  type ConvexPolygonWinding
} from './convexPolygonValidation.js'
import {
  areDisjoint,
  translatePolygonWithBounds
} from './convexBounds.js'
import { GeometryPredicates } from './geometryPredicates.js'

/** Checks translated convex placement geometry without using polygon booleans. */
export const PlacementValidation = {
  check,
  checkSheetless,
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
  return assess(input, true).pipe(Effect.map(({ legal }) => legal))
}

/** Exact overlap validation for an intrinsic candidate whose sheet fit is deferred. */
function checkSheetless(
  input: Omit<ValidatePlacementInput, 'sheet'>
): Effect.Effect<boolean, IrregularGeometryInputError> {
  return assess(input, false).pipe(Effect.map(({ legal }) => legal))
}

/**
 * Preserves the strict assertion boundary used by the geometry-kernel service.
 * Candidate generation must use `check`, because an illegal candidate is not
 * an invalid geometry input.
 */
function validate(input: ValidatePlacementInput): Effect.Effect<void, IrregularGeometryInputError> {
  return assess(input, true).pipe(
    Effect.flatMap((assessment) =>
      assessment.legal
        ? Effect.void
        : failInvalidGeometry('validatePlacement', assessment.message)
    )
  )
}

function assess(
  input: ValidatePlacementInput | Omit<ValidatePlacementInput, 'sheet'>,
  enforceSheetBounds: boolean
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

  const spatialIndex = input.placedCollisionIndex
  const indexedEntries =
    spatialIndex !== undefined && spatialIndex.matches(input.placed)
      ? spatialIndex.query(movingPolygon.bounds)
      : undefined
  if (indexedEntries !== undefined) {
    for (const entry of indexedEntries) {
      if (entry.validationMessage !== undefined) {
        return failInvalidGeometry('validatePlacement', entry.validationMessage)
      }
      if (entry.translated === undefined) {
        return failInvalidGeometry(
          'validatePlacement',
          'placed translation must produce finite polygon coordinates.'
        )
      }
      placedPolygons.push(entry.translated)
    }
  } else {
    for (const placed of input.placed) {
      const placedPolygon = translateAndValidatePolygon(
        placed.collisionGeometry.polygon,
        {
          x: placed.placement.transform.translateX,
          y: placed.placement.transform.translateY
        },
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
  }

  if (
    enforceSheetBounds &&
    'sheet' in input &&
    !isInsideSheet(movingPolygon.polygon.points, input.sheet.width, input.sheet.height)
  ) {
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
  points: ReadonlyArray<InternalPoint>,
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

interface ValidatedPolygonWithBounds extends InternalPolygonWithBounds {
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
  polygon: InternalPolygon,
  translation: InternalPoint,
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
  polygon: InternalPolygon
): { readonly value: InternalPoint } | GeometryFailure {
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

  return { value: { x, y } }
}

function boundariesHavePositiveCollinearOverlap(
  first: InternalPolygon,
  second: InternalPolygon,
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
  first: InternalPolygon,
  second: InternalPolygon
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
  readonly start: InternalPoint
  readonly end: InternalPoint
}

function polygonEdges(polygon: InternalPolygon): ReadonlyArray<PolygonEdge> {
  const edges: PolygonEdge[] = []
  for (let index = 0; index < polygon.points.length; index += 1) {
    const start = polygon.points[index]
    const end = polygon.points[(index + 1) % polygon.points.length]
    if (start !== undefined && end !== undefined) edges.push({ start, end })
  }
  return edges
}

function isStrictlyInside(
  point: InternalPoint,
  polygon: InternalPolygon,
  winding: -1 | 1
): boolean {
  for (const edge of polygonEdges(polygon)) {
    const turn = GeometryPredicates.orientation(edge.start, edge.end, point)
    if (turn === 0 || turn !== winding) return false
  }
  return true
}

function isOnBoundary(point: InternalPoint, polygon: InternalPolygon): boolean {
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

function pointIsOnSegment(point: InternalPoint, edge: PolygonEdge): boolean {
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
