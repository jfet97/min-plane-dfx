import type { Path64 } from 'clipper2-ts'

export interface CanonicalGridPoint {
  readonly x: number
  readonly y: number
}

function isCanonicalGridCoordinate(value: number): boolean {
  return Number.isSafeInteger(value)
}

export function compareBigInts(first: bigint, second: bigint): number {
  return first === second ? 0 : first < second ? -1 : 1
}

export function compareCanonicalGridRatios(
  firstNumerator: bigint,
  firstDenominator: bigint,
  secondNumerator: bigint,
  secondDenominator: bigint
): number | undefined {
  if (firstDenominator <= 0n || secondDenominator <= 0n) return undefined
  return compareBigInts(
    firstNumerator * secondDenominator,
    secondNumerator * firstDenominator
  )
}

export function canonicalGridCross(
  origin: CanonicalGridPoint,
  first: CanonicalGridPoint,
  second: CanonicalGridPoint
): bigint | undefined {
  if (
    !isCanonicalGridCoordinate(origin.x) ||
    !isCanonicalGridCoordinate(origin.y) ||
    !isCanonicalGridCoordinate(first.x) ||
    !isCanonicalGridCoordinate(first.y) ||
    !isCanonicalGridCoordinate(second.x) ||
    !isCanonicalGridCoordinate(second.y)
  ) {
    return undefined
  }
  return (
    (BigInt(first.x) - BigInt(origin.x)) * (BigInt(second.y) - BigInt(origin.y)) -
    (BigInt(first.y) - BigInt(origin.y)) * (BigInt(second.x) - BigInt(origin.x))
  )
}

export function canonicalGridSignedDoubledArea(path: Path64): bigint | undefined {
  if (path.length < 3) return 0n
  let doubledArea = 0n
  for (let index = 0; index < path.length; index += 1) {
    const first = path[index]
    const second = path[(index + 1) % path.length]
    if (
      first === undefined ||
      second === undefined ||
      !isCanonicalGridCoordinate(first.x) ||
      !isCanonicalGridCoordinate(first.y) ||
      !isCanonicalGridCoordinate(second.x) ||
      !isCanonicalGridCoordinate(second.y)
    ) {
      return undefined
    }
    doubledArea +=
      BigInt(first.x) * BigInt(second.y) - BigInt(second.x) * BigInt(first.y)
  }
  return doubledArea
}

export function canonicalGridAbsoluteDoubledArea(path: Path64): bigint | undefined {
  const signed = canonicalGridSignedDoubledArea(path)
  return signed === undefined ? undefined : signed < 0n ? -signed : signed
}

export function canonicalGridConvexHull(points: ReadonlyArray<CanonicalGridPoint>): Path64 | undefined {
  const unique = [
    ...new Map(points.map((point) => [`${point.x},${point.y}`, point])).values()
  ].toSorted((first, second) => first.x - second.x || first.y - second.y)
  if (
    unique.some(
      ({ x, y }) => !isCanonicalGridCoordinate(x) || !isCanonicalGridCoordinate(y)
    )
  ) {
    return undefined
  }
  if (unique.length <= 1) return unique
  const buildHalf = (ordered: ReadonlyArray<CanonicalGridPoint>): Path64 | undefined => {
    const half: Path64 = []
    for (const point of ordered) {
      while (half.length >= 2) {
        const origin = half.at(-2)
        const first = half.at(-1)
        if (origin === undefined || first === undefined) return undefined
        const turn = canonicalGridCross(origin, first, point)
        if (turn === undefined) return undefined
        if (turn > 0n) break
        half.pop()
      }
      half.push(point)
    }
    return half
  }
  const lower = buildHalf(unique)
  const upper = buildHalf([...unique].reverse())
  return lower === undefined || upper === undefined
    ? undefined
    : [...lower.slice(0, -1), ...upper.slice(0, -1)]
}

export function canonicalGridPointOnSegment(
  point: CanonicalGridPoint,
  start: CanonicalGridPoint,
  end: CanonicalGridPoint
): boolean {
  const cross = canonicalGridCross(start, end, point)
  return (
    cross === 0n &&
    point.x >= Math.min(start.x, end.x) &&
    point.x <= Math.max(start.x, end.x) &&
    point.y >= Math.min(start.y, end.y) &&
    point.y <= Math.max(start.y, end.y)
  )
}

export function canonicalGridCounterClockwise(path: Path64): Path64 | undefined {
  const signed = canonicalGridSignedDoubledArea(path)
  return signed === undefined ? undefined : signed >= 0n ? path : [...path].reverse()
}

export function canonicalGridClockwise(path: Path64): Path64 | undefined {
  const signed = canonicalGridSignedDoubledArea(path)
  return signed === undefined ? undefined : signed <= 0n ? path : [...path].reverse()
}

export function doubledGridAreaToMm2(doubledAreaGrid2: bigint): number | undefined {
  const areaMm2 = Number(doubledAreaGrid2) / 2_000_000
  return Number.isFinite(areaMm2) ? areaMm2 : undefined
}
