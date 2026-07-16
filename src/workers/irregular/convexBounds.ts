import {
  IrregularBounds,
  IrregularPoint,
  IrregularPolygon
} from '@shared/irregular/domain.js'

export interface PolygonWithBounds {
  readonly polygon: IrregularPolygon
  readonly bounds: IrregularBounds
}

export function boundsForPoints(
  points: ReadonlyArray<IrregularPoint>
): IrregularBounds | undefined {
  const firstPoint = points[0]
  if (firstPoint === undefined) return undefined
  if (!Number.isFinite(firstPoint.x) || !Number.isFinite(firstPoint.y)) return undefined

  let minX = firstPoint.x
  let minY = firstPoint.y
  let maxX = firstPoint.x
  let maxY = firstPoint.y

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

  return new IrregularBounds({ minX, minY, maxX, maxY })
}

export function translatePolygonWithBounds(
  polygon: IrregularPolygon,
  translation: IrregularPoint
): PolygonWithBounds | undefined {
  const firstPoint = polygon.points[0]
  if (firstPoint === undefined) return undefined

  const firstX = firstPoint.x + translation.x
  const firstY = firstPoint.y + translation.y
  if (!Number.isFinite(firstX) || !Number.isFinite(firstY)) return undefined

  const translatedPoints: IrregularPoint[] = [new IrregularPoint({ x: firstX, y: firstY })]
  let minX = firstX
  let minY = firstY
  let maxX = firstX
  let maxY = firstY

  for (let index = 1; index < polygon.points.length; index += 1) {
    const point = polygon.points[index]
    if (point === undefined) return undefined

    const x = point.x + translation.x
    const y = point.y + translation.y
    if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined

    translatedPoints.push(new IrregularPoint({ x, y }))
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
  }

  return {
    polygon: new IrregularPolygon({ points: translatedPoints }),
    bounds: new IrregularBounds({ minX, minY, maxX, maxY })
  }
}

export function areDisjoint(first: IrregularBounds, second: IrregularBounds): boolean {
  return (
    first.maxX < second.minX ||
    second.maxX < first.minX ||
    first.maxY < second.minY ||
    second.maxY < first.minY
  )
}
