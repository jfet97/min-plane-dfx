import type { InternalPoint } from './internalGeometry.js'

export interface ConvexSatPenetration {
  readonly depth: number
  /** Minimum translation that moves the first polygon out of the second. */
  readonly translation: InternalPoint
}

/** Returns the minimum positive SAT penetration, or undefined for separation/touch. */
export function measureConvexSatPenetration(
  first: ReadonlyArray<InternalPoint>,
  second: ReadonlyArray<InternalPoint>
): ConvexSatPenetration | undefined {
  if (first.length < 3 || second.length < 3) return undefined

  let best: ConvexSatPenetration | undefined
  for (const axis of [...polygonAxes(first), ...polygonAxes(second)]) {
    const firstProjection = project(first, axis)
    const secondProjection = project(second, axis)
    if (firstProjection === undefined || secondProjection === undefined) return undefined

    const negativeDepth = firstProjection.max - secondProjection.min
    const positiveDepth = secondProjection.max - firstProjection.min
    if (negativeDepth <= 0 || positiveDepth <= 0) return undefined

    const moveNegative = negativeDepth <= positiveDepth
    const depth = moveNegative ? negativeDepth : positiveDepth
    const translation = moveNegative
      ? { x: canonicalZero(-axis.x * depth), y: canonicalZero(-axis.y * depth) }
      : { x: canonicalZero(axis.x * depth), y: canonicalZero(axis.y * depth) }
    if (
      best === undefined ||
      depth < best.depth ||
      (depth === best.depth && comparePoint(translation, best.translation) < 0)
    ) {
      best = { depth, translation }
    }
  }
  return best
}

function polygonAxes(points: ReadonlyArray<InternalPoint>): ReadonlyArray<InternalPoint> {
  const axes: InternalPoint[] = []
  for (let index = 0; index < points.length; index += 1) {
    const start = points[index]
    const end = points[(index + 1) % points.length]
    if (start === undefined || end === undefined) return []
    const dx = end.x - start.x
    const dy = end.y - start.y
    const length = Math.hypot(dx, dy)
    if (!Number.isFinite(length) || length <= 0) return []
    let x = -dy / length
    let y = dx / length
    if (x < 0 || (x === 0 && y < 0)) {
      x = -x
      y = -y
    }
    axes.push({ x, y })
  }
  return axes
}

function project(
  points: ReadonlyArray<InternalPoint>,
  axis: InternalPoint
): { readonly min: number; readonly max: number } | undefined {
  const first = points[0]
  if (first === undefined) return undefined
  const firstProjection = first.x * axis.x + first.y * axis.y
  if (!Number.isFinite(firstProjection)) return undefined
  let min = firstProjection
  let max = firstProjection
  for (const point of points.slice(1)) {
    const value = point.x * axis.x + point.y * axis.y
    if (!Number.isFinite(value)) return undefined
    min = Math.min(min, value)
    max = Math.max(max, value)
  }
  return { min, max }
}

function comparePoint(first: InternalPoint, second: InternalPoint): number {
  if (first.x !== second.x) return first.x < second.x ? -1 : 1
  if (first.y !== second.y) return first.y < second.y ? -1 : 1
  return 0
}

function canonicalZero(value: number): number {
  return Object.is(value, -0) ? 0 : value
}
