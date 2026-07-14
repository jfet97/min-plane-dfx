import { Effect } from 'effect'
import { IrregularPoint, IrregularPolygon } from '@shared/irregular/domain.js'
import type { ValidatePlacementInput } from './services.js'
import { IrregularGeometryInputError } from './services.js'
import { ConvexPolygonValidation } from './convexPolygonValidation.js'

/** Validates translated convex placement geometry without using polygon booleans. */
export const PlacementValidation = {
  validate
} as const

/**
 * Accepts a placement when the moving polygon stays in the sheet and has no
 * positive-area overlap with any translated placed polygon. Sheet and polygon
 * boundaries are closed, so edge and vertex touching remains legal.
 */
function validate(input: ValidatePlacementInput): Effect.Effect<void, IrregularGeometryInputError> {
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

  if (!isInsideSheet(movingPolygon.points, input.sheet.width, input.sheet.height)) {
    return failInvalidGeometry('validatePlacement', 'moving polygon must remain inside the sheet.')
  }

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

    const overlap = polygonsHavePositiveAreaOverlap(movingPolygon, placedPolygon)
    if ('message' in overlap) return failInvalidGeometry('validatePlacement', overlap.message)
    if (overlap.value) {
      return failInvalidGeometry(
        'validatePlacement',
        'moving polygon has positive-area overlap with placed collision geometry.'
      )
    }
  }

  return Effect.void
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

interface Projection {
  readonly min: number
  readonly max: number
}

interface GeometryFailure {
  readonly message: string
}

interface OverlapResult {
  readonly value: boolean
}

function polygonsHavePositiveAreaOverlap(
  first: IrregularPolygon,
  second: IrregularPolygon
): OverlapResult | GeometryFailure {
  const polygons = [first.points, second.points]
  for (const axisPolygon of polygons) {
    for (let index = 0; index < axisPolygon.length; index += 1) {
      const start = axisPolygon[index]
      const end = axisPolygon[(index + 1) % axisPolygon.length]
      if (start === undefined || end === undefined) {
        return { message: 'polygon boundary must contain every closed edge.' }
      }

      const axisX = -(end.y - start.y)
      const axisY = end.x - start.x
      if (!Number.isFinite(axisX) || !Number.isFinite(axisY)) {
        return { message: 'polygon edge arithmetic must produce finite axes.' }
      }

      const firstProjection = projectPolygon(first.points, axisX, axisY)
      if ('message' in firstProjection) return firstProjection
      const secondProjection = projectPolygon(second.points, axisX, axisY)
      if ('message' in secondProjection) return secondProjection

      if (
        firstProjection.max <= secondProjection.min ||
        secondProjection.max <= firstProjection.min
      ) {
        return { value: false }
      }
    }
  }

  return { value: true }
}

function projectPolygon(
  points: ReadonlyArray<IrregularPoint>,
  axisX: number,
  axisY: number
): Projection | GeometryFailure {
  const firstPoint = points[0]
  if (firstPoint === undefined) return { message: 'polygon must contain a closed boundary.' }

  const firstProjection = firstPoint.x * axisX + firstPoint.y * axisY
  if (!Number.isFinite(firstProjection)) {
    return { message: 'polygon projection arithmetic must produce finite values.' }
  }

  let min = firstProjection
  let max = firstProjection
  for (const point of points.slice(1)) {
    const projection = point.x * axisX + point.y * axisY
    if (!Number.isFinite(projection)) {
      return { message: 'polygon projection arithmetic must produce finite values.' }
    }
    min = Math.min(min, projection)
    max = Math.max(max, projection)
  }

  return { min, max }
}

function failInvalidGeometry(
  operation: string,
  message: string
): Effect.Effect<never, IrregularGeometryInputError> {
  return Effect.fail(new IrregularGeometryInputError({ operation, message }))
}
