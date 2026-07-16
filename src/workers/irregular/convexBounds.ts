import type {
  InternalBounds,
  InternalPoint,
  InternalPolygon,
  InternalPolygonWithBounds
} from './internalGeometry.js'

export function boundsForPoints(
  points: ReadonlyArray<InternalPoint>
): InternalBounds | undefined {
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

  return makeBounds(minX, minY, maxX, maxY)
}

export function translatePolygonWithBounds(
  polygon: InternalPolygon,
  translation: InternalPoint
): InternalPolygonWithBounds | undefined {
  const firstPoint = polygon.points[0]
  if (firstPoint === undefined) return undefined

  const firstX = firstPoint.x + translation.x
  const firstY = firstPoint.y + translation.y
  if (!Number.isFinite(firstX) || !Number.isFinite(firstY)) return undefined

  const translatedPoints: InternalPoint[] = [{ x: firstX, y: firstY }]
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

    translatedPoints.push({ x, y })
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
  }

  const bounds = makeBounds(minX, minY, maxX, maxY)
  if (bounds === undefined) return undefined

  return {
    polygon: { points: translatedPoints },
    bounds
  }
}

export function areDisjoint(first: InternalBounds, second: InternalBounds): boolean {
  return (
    first.maxX < second.minX ||
    second.maxX < first.minX ||
    first.maxY < second.minY ||
    second.maxY < first.minY
  )
}

function makeBounds(
  minX: number,
  minY: number,
  maxX: number,
  maxY: number
): InternalBounds | undefined {
  if (
    !Number.isFinite(minX) ||
    !Number.isFinite(minY) ||
    !Number.isFinite(maxX) ||
    !Number.isFinite(maxY) ||
    minX > maxX ||
    minY > maxY
  ) {
    return undefined
  }

  return { minX, minY, maxX, maxY }
}
