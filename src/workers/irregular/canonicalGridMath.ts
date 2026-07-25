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

/**
 * Largest coordinate magnitude for which the cross product is exact in `Number`.
 *
 * With every coordinate bounded by `L`, each difference is at most `2L`, each
 * product at most `4L^2`, and their difference at most `8L^2`. Choosing
 * `L = 2^25 - 1` gives `8L^2 = 2^53 - 2^29 + 8`, strictly below
 * `Number.MAX_SAFE_INTEGER`, so no intermediate value can round. In canonical
 * grid units of a thousandth of a millimetre this covers `+/- 33.5 m`, more
 * than twelve times the largest dimension in the maintained production gates.
 *
 * Coordinates outside this bound are not approximated: they take the exact
 * `bigint` path instead.
 */
export const CANONICAL_GRID_EXACT_NUMBER_CROSS_LIMIT = 2 ** 25 - 1

function withinExactNumberCrossLimit(point: CanonicalGridPoint): boolean {
  return (
    Math.abs(point.x) <= CANONICAL_GRID_EXACT_NUMBER_CROSS_LIMIT &&
    Math.abs(point.y) <= CANONICAL_GRID_EXACT_NUMBER_CROSS_LIMIT
  )
}

/**
 * Exact orientation sign of `origin -> first -> second`.
 *
 * Every caller of {@link canonicalGridCross} needs only the sign, and `bigint`
 * allocation for that answer dominated the canonical grid predicates. Inside the
 * bound proved by {@link CANONICAL_GRID_EXACT_NUMBER_CROSS_LIMIT} the sign is
 * computed in `Number` with no rounding possible; outside it the exact `bigint`
 * value still decides. The result is therefore identical to
 * `canonicalGridCross(...)` compared against zero, for every input.
 */
export function canonicalGridCrossSign(
  origin: CanonicalGridPoint,
  first: CanonicalGridPoint,
  second: CanonicalGridPoint
): -1 | 0 | 1 | undefined {
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
  if (
    withinExactNumberCrossLimit(origin) &&
    withinExactNumberCrossLimit(first) &&
    withinExactNumberCrossLimit(second)
  ) {
    const cross =
      (first.x - origin.x) * (second.y - origin.y) - (first.y - origin.y) * (second.x - origin.x)
    return cross === 0 ? 0 : cross < 0 ? -1 : 1
  }
  const exact = canonicalGridCross(origin, first, second)
  if (exact === undefined) return undefined
  return exact === 0n ? 0 : exact < 0n ? -1 : 1
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
        const turn = canonicalGridCrossSign(origin, first, point)
        if (turn === undefined) return undefined
        if (turn > 0) break
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
  const cross = canonicalGridCrossSign(start, end, point)
  return (
    cross === 0 &&
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
