/**
 * Differential-vector dump for `src/workers/irregular/canonicalGridMath.ts`
 * and the `toGridMm`/`fromGrid` grid-quantization authority in
 * `src/workers/irregular/clipper2OffsetPolicy.ts`.
 *
 * Additive, standalone script (per `stage0-rulings.md` R14 / the migration
 * prompt's differential-vector requirement): imports the real production TS
 * functions, evaluates them over a broad deliberate input matrix, and writes
 * JSON oracle vectors for the Rust port's integration tests to reproduce
 * exactly.
 *
 * Run with:
 *   pnpm exec tsx --tsconfig tsconfig.node.json scripts/rust-parity/dump-canonical-grid.ts
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Path64 } from 'clipper2-ts'

import {
  CANONICAL_GRID_EXACT_NUMBER_CROSS_LIMIT,
  canonicalGridAbsoluteDoubledArea,
  canonicalGridClockwise,
  canonicalGridConvexHull,
  canonicalGridCounterClockwise,
  canonicalGridCross,
  canonicalGridCrossSign,
  canonicalGridPointOnSegment,
  canonicalGridSignedDoubledArea,
  compareBigInts,
  compareCanonicalGridRatios,
  doubledGridAreaToMm2,
  type CanonicalGridPoint
} from '../../src/workers/irregular/canonicalGridMath.js'
import { fromGrid, toGridMm } from '../../src/workers/irregular/clipper2OffsetPolicy.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..', '..')
const outputPath = join(
  repoRoot,
  'crates/irregular-nesting-native/tests/vectors/canonical-grid.json'
)

// ---------------------------------------------------------------------------
// Deterministic PRNG (no Math.random anywhere, so failures reproduce and the
// vector file is stable across runs). mulberry32, a small, well-known,
// good-enough-for-testing 32-bit generator.
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Deterministic pseudo-random integers via a linear congruential generator (matches the style already used by `tests/unit/canonicalGridMath.test.ts`'s `makeSequence`). */
function lcgSequence(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0
    return state
  }
}

// ---------------------------------------------------------------------------
// JSON-safe encoding: BigInt as quoted base-10 strings; f64 values that are
// exactly zero, NaN, or infinite as tagged strings (`JSON.stringify` itself
// silently folds `-0` to `"0"`, which would erase the exact negative-zero
// vectors this suite deliberately covers, and cannot represent `NaN`/
// `Infinity` at all). Every other finite, non-zero value is written as a
// plain JSON number: both `JSON.stringify`/`JSON.parse` (V8) and
// `serde_json` (Rust) implement the ECMAScript shortest-round-trip
// number<->string algorithm, so a plain JSON number round-trips to the
// bit-exact same `f64` on both sides.
// ---------------------------------------------------------------------------

type EncodedF64 = number | 'NaN' | 'Infinity' | '-Infinity' | '0' | '-0'

function encodeF64(value: number): EncodedF64 {
  if (Number.isNaN(value)) return 'NaN'
  if (value === Number.POSITIVE_INFINITY) return 'Infinity'
  if (value === Number.NEGATIVE_INFINITY) return '-Infinity'
  if (value === 0) return Object.is(value, -0) ? '-0' : '0'
  return value
}

interface EncodedPoint {
  readonly x: EncodedF64
  readonly y: EncodedF64
}

function encodePoint(point: CanonicalGridPoint): EncodedPoint {
  return { x: encodeF64(point.x), y: encodeF64(point.y) }
}

function encodePath(path: ReadonlyArray<CanonicalGridPoint>): EncodedPoint[] {
  return path.map(encodePoint)
}

function encodeOptionalPath(path: Path64 | undefined): EncodedPoint[] | null {
  return path === undefined ? null : encodePath(path)
}

function encodeBigInt(value: bigint): string {
  return value.toString()
}

function encodeOptionalBigInt(value: bigint | undefined): string | null {
  return value === undefined ? null : encodeBigInt(value)
}

function encodeOptionalNumber(value: -1 | 0 | 1 | undefined): number | null {
  return value === undefined ? null : value
}

function encodeOptionalF64(value: number | undefined): EncodedF64 | null {
  return value === undefined ? null : encodeF64(value)
}

// ---------------------------------------------------------------------------
// Coordinate/point/path generators.
// ---------------------------------------------------------------------------

/** Mirrors `tests/unit/canonicalGridMath.test.ts`'s coordinate sampler: a value in `[-magnitude, magnitude]`, clamped to `magnitude` on the rare rounding miss for magnitudes near `Number.MAX_SAFE_INTEGER`. */
function safeCoordinate(next: () => number, magnitude: number): number {
  const span = 2 * magnitude + 1
  const value = (next() % span) - magnitude
  return Number.isSafeInteger(value) ? value : magnitude
}

function point(x: number, y: number): CanonicalGridPoint {
  return { x, y }
}

const MAGNITUDE_BUCKETS = [
  1,
  1_000,
  2_700_000,
  CANONICAL_GRID_EXACT_NUMBER_CROSS_LIMIT - 1,
  CANONICAL_GRID_EXACT_NUMBER_CROSS_LIMIT,
  CANONICAL_GRID_EXACT_NUMBER_CROSS_LIMIT + 1,
  2 ** 31,
  900_000_000,
  Number.MAX_SAFE_INTEGER
]

/** Random decimal-digit BigInt of `1..=maxDigits` digits, sign chosen by `next`. */
function randomBigInt(next: () => number, maxDigits: number): bigint {
  const digitCount = 1 + Math.floor(next() * maxDigits)
  let digits = ''
  for (let index = 0; index < digitCount; index += 1) {
    const digit = index === 0 ? 1 + Math.floor(next() * 9) : Math.floor(next() * 10)
    digits += String(digit)
  }
  const magnitude = BigInt(digits)
  return next() < 0.5 ? -magnitude : magnitude
}

// ---------------------------------------------------------------------------
// Real ring data extracted from a production fixture.
// ---------------------------------------------------------------------------

interface FixtureLineSegment {
  readonly kind: string
  readonly x1: number
  readonly y1: number
  readonly x2: number
  readonly y2: number
}

interface FixtureSourcePiece {
  readonly id: string
  readonly geometry?: {
    readonly segments?: ReadonlyArray<FixtureLineSegment>
  }
}

function loadRealMmRings(): CanonicalGridPoint[][] {
  const fixturePath = join(
    repoRoot,
    'tests/fixtures/irregularSheetInvariance/mixed61-request.json'
  )
  const parsed = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
    sourcePieces: ReadonlyArray<FixtureSourcePiece>
  }
  const rings: CanonicalGridPoint[][] = []
  for (const sourcePiece of parsed.sourcePieces) {
    const segments = sourcePiece.geometry?.segments
    if (segments === undefined || segments.length < 3) continue
    if (!segments.every((segment) => segment.kind === 'line')) continue
    const gridPoints: CanonicalGridPoint[] = []
    let degenerate = false
    for (const segment of segments) {
      const gridX = toGridMm(segment.x1)
      const gridY = toGridMm(segment.y1)
      if (gridX === undefined || gridY === undefined) {
        degenerate = true
        break
      }
      gridPoints.push(point(gridX, gridY))
    }
    if (!degenerate && gridPoints.length >= 3) rings.push(gridPoints)
  }
  return rings
}

// ---------------------------------------------------------------------------
// Vector builders.
// ---------------------------------------------------------------------------

interface CrossVector {
  readonly origin: EncodedPoint
  readonly first: EncodedPoint
  readonly second: EncodedPoint
  readonly crossSign: number | null
  readonly cross: string | null
}

function buildCrossVectors(): CrossVector[] {
  const vectors: CrossVector[] = []
  const push = (origin: CanonicalGridPoint, first: CanonicalGridPoint, second: CanonicalGridPoint): void => {
    vectors.push({
      origin: encodePoint(origin),
      first: encodePoint(first),
      second: encodePoint(second),
      crossSign: encodeOptionalNumber(canonicalGridCrossSign(origin, first, second)),
      cross: encodeOptionalBigInt(canonicalGridCross(origin, first, second))
    })
  }

  // Deterministic random trials across every magnitude bucket, straddling
  // the exact-Number-cross fast-path bound in both directions (below and
  // above `CANONICAL_GRID_EXACT_NUMBER_CROSS_LIMIT`) as required.
  const next = lcgSequence(0x5eed)
  for (const magnitude of MAGNITUDE_BUCKETS) {
    for (let trial = 0; trial < 40; trial += 1) {
      const coordinate = (): number => safeCoordinate(next, magnitude)
      push(point(coordinate(), coordinate()), point(coordinate(), coordinate()), point(coordinate(), coordinate()))
    }
  }

  // Fixed boundary/degenerate/orientation cases.
  const limit = CANONICAL_GRID_EXACT_NUMBER_CROSS_LIMIT
  const maximum = Number.MAX_SAFE_INTEGER
  push(point(0, 0), point(10, 10), point(5, 5)) // collinear
  push(point(0, 0), point(10, 0), point(5, 0)) // collinear, horizontal
  push(point(0, 0), point(0, 0), point(0, 0)) // fully degenerate
  push(point(-0, -0), point(1, 0), point(0, 1)) // signed zero origin
  push(point(0, 0), point(1, 0), point(0, -1))
  push(point(-5, -5), point(-1, -5), point(-3, -5))
  push(point(limit, limit), point(-limit, limit), point(0, -limit))
  push(point(-limit, -limit), point(limit, limit), point(limit, limit - 1))
  push(point(-limit, -limit), point(limit, limit), point(limit, limit))
  push(point(-limit, -limit), point(limit, limit), point(limit - 1, limit))
  // Exact-fallback boundary, both signs.
  const outside = limit + 1
  push(point(-outside, 0), point(outside, 1), point(outside, 0))
  push(point(outside, 0), point(-outside, -1), point(-outside, 0))
  push(point(-maximum, -maximum), point(maximum, -maximum), point(-maximum, maximum))
  push(point(maximum, maximum), point(-maximum, maximum), point(maximum, -maximum))
  push(point(-maximum, -maximum), point(0, 0), point(maximum, maximum))
  // One-unit orientation flips at several magnitudes, not only the limit.
  for (const magnitude of [1_000, 2_700_000, limit, 900_000_000, maximum]) {
    push(point(-magnitude, -magnitude), point(magnitude, magnitude), point(magnitude, magnitude - 1))
    push(point(-magnitude, -magnitude), point(magnitude, magnitude), point(magnitude, magnitude))
    push(point(-magnitude, -magnitude), point(magnitude, magnitude), point(magnitude - 1, magnitude))
  }
  // Invalid coordinates (non-integer, or finite-but-over-safe-integer-bound)
  // — exercises the `undefined` branch without needing non-JSON-safe NaN/
  // Infinity inputs (those are covered by native Rust unit tests instead).
  const valid = point(1, 1)
  push(point(0.5, 0), valid, valid)
  push(point(maximum + 2, 0), valid, valid) // first unsafe integer above MAX_SAFE_INTEGER
  push(valid, point(-0.25, 3), valid)
  push(valid, valid, point(0, maximum + 1024))

  return vectors
}

interface CompareBigIntsVector {
  readonly first: string
  readonly second: string
  readonly expected: number
}

function buildCompareBigIntsVectors(): CompareBigIntsVector[] {
  const vectors: CompareBigIntsVector[] = []
  const next = mulberry32(0xc0ffee)
  const push = (first: bigint, second: bigint): void => {
    vectors.push({ first: encodeBigInt(first), second: encodeBigInt(second), expected: compareBigInts(first, second) })
  }
  push(0n, 0n)
  push(0n, 1n)
  push(1n, 0n)
  push(-1n, 1n)
  push(1n, -1n)
  for (let index = 0; index < 120; index += 1) {
    const maxDigits = 1 + (index % 60)
    push(randomBigInt(next, maxDigits), randomBigInt(next, maxDigits))
  }
  // Equal-magnitude, equal-value pairs built by construction (guarantees a
  // meaningful sample of the `=== 0` branch beyond literal 0n/0n).
  for (let index = 0; index < 30; index += 1) {
    const value = randomBigInt(next, 1 + (index % 40))
    push(value, value)
  }
  return vectors
}

interface CompareRatiosVector {
  readonly firstNumerator: string
  readonly firstDenominator: string
  readonly secondNumerator: string
  readonly secondDenominator: string
  readonly expected: number | null
}

function buildCompareRatiosVectors(): CompareRatiosVector[] {
  const vectors: CompareRatiosVector[] = []
  const next = mulberry32(0xba5eba11)
  const push = (fn: bigint, fd: bigint, sn: bigint, sd: bigint): void => {
    vectors.push({
      firstNumerator: encodeBigInt(fn),
      firstDenominator: encodeBigInt(fd),
      secondNumerator: encodeBigInt(sn),
      secondDenominator: encodeBigInt(sd),
      expected: compareCanonicalGridRatios(fn, fd, sn, sd) ?? null
    })
  }
  // Non-positive-denominator -> undefined, both sides.
  push(1n, 0n, 1n, 1n)
  push(1n, -1n, 1n, 1n)
  push(1n, 1n, 1n, 0n)
  push(1n, 1n, 1n, -1n)
  push(0n, 0n, 0n, 0n)
  // Exactly-equal ratios via explicit scaling.
  push(1n, 3n, 2n, 6n)
  push(1n, 3n, 2n, 5n)
  push(-1n, 3n, -2n, 6n)
  for (let index = 0; index < 60; index += 1) {
    const scale = randomBigInt(next, 6) || 1n
    const numerator = randomBigInt(next, 10)
    const denominator = (randomBigInt(next, 10) || 1n) ** 2n + 1n // always positive
    const scaleMagnitude = scale < 0n ? -scale : scale
    const scaleFactor = scaleMagnitude === 0n ? 1n : scaleMagnitude
    push(numerator, denominator, numerator * scaleFactor, denominator * scaleFactor)
  }
  // Ordinary random ratios, small and large magnitudes.
  for (let index = 0; index < 150; index += 1) {
    const digitBudget = 1 + (index % 45)
    const firstNumerator = randomBigInt(next, digitBudget)
    const firstDenominatorRaw = randomBigInt(next, digitBudget)
    const secondNumerator = randomBigInt(next, digitBudget)
    const secondDenominatorRaw = randomBigInt(next, digitBudget)
    const firstDenominator = firstDenominatorRaw === 0n ? 1n : firstDenominatorRaw < 0n ? -firstDenominatorRaw : firstDenominatorRaw
    const secondDenominator = secondDenominatorRaw === 0n ? 1n : secondDenominatorRaw < 0n ? -secondDenominatorRaw : secondDenominatorRaw
    push(firstNumerator, firstDenominator, secondNumerator, secondDenominator)
  }
  // Deliberately huge cross-multiplication magnitudes: each operand ~30
  // digits, so `numerator * otherDenominator` is ~60 digits — far beyond
  // `i128`'s ~38-39 decimal digits of range (R6: this is exactly the case
  // `stage0-rulings.md` cites for why `i128` is unsafe here).
  for (let index = 0; index < 40; index += 1) {
    const firstNumerator = randomBigInt(next, 32)
    const firstDenominator = (randomBigInt(next, 30) < 0n ? randomBigInt(next, 30) : randomBigInt(next, 30)) ** 2n + 1n
    const secondNumerator = randomBigInt(next, 32)
    const secondDenominator = (randomBigInt(next, 30) < 0n ? randomBigInt(next, 30) : randomBigInt(next, 30)) ** 2n + 1n
    push(firstNumerator, firstDenominator, secondNumerator, secondDenominator)
  }
  return vectors
}

interface AreaVector {
  readonly path: EncodedPoint[]
  readonly signed: string | null
  readonly absolute: string | null
  readonly counterClockwise: EncodedPoint[] | null
  readonly clockwise: EncodedPoint[] | null
}

function buildAreaVectors(realRings: ReadonlyArray<CanonicalGridPoint[]>): AreaVector[] {
  const vectors: AreaVector[] = []
  const push = (path: CanonicalGridPoint[]): void => {
    vectors.push({
      path: encodePath(path),
      signed: encodeOptionalBigInt(canonicalGridSignedDoubledArea(path)),
      absolute: encodeOptionalBigInt(canonicalGridAbsoluteDoubledArea(path)),
      counterClockwise: encodeOptionalPath(canonicalGridCounterClockwise(path)),
      clockwise: encodeOptionalPath(canonicalGridClockwise(path))
    })
  }

  // Degenerate lengths (< 3): the TS source special-cases these to `0n`
  // *without* validating coordinates at all.
  push([])
  push([point(1, 1)])
  push([point(1, 1), point(2, 2)])
  push([point(Number.NaN, 0)]) // still length 1 -> 0n, coordinate never checked
  push([point(0.5, 0.5), point(1.5, 1.5)]) // length 2 -> 0n regardless of validity

  // Small deterministic shapes: triangle, square, rectangle, both windings.
  push([point(0, 0), point(4, 0), point(0, 3)])
  push([point(0, 0), point(0, 3), point(4, 0)])
  push([point(0, 0), point(10, 0), point(10, 10), point(0, 10)])
  push([point(0, 0), point(0, 10), point(10, 10), point(10, 0)])
  push([point(0, 0), point(10, 0), point(10, 10), point(0, 10), point(0, 0)]) // repeated closing vertex
  // Collinear ring: zero area.
  push([point(0, 0), point(5, 0), point(10, 0)])
  // Self-intersecting (bowtie) ring: shoelace still computes, magnitude
  // reflects the signed sum of both lobes.
  push([point(0, 0), point(10, 10), point(10, 0), point(0, 10)])
  // A non-convex star.
  push([
    point(0, 10),
    point(3, 3),
    point(10, 0),
    point(3, -3),
    point(0, -10),
    point(-3, -3),
    point(-10, 0),
    point(-3, 3)
  ])
  // Invalid coordinate ring.
  push([point(0, 0), point(1.5, 0), point(1, 1)])
  push([point(0, 0), point(Number.MAX_SAFE_INTEGER + 2, 0), point(1, 1)])

  const next = mulberry32(0x51de5)
  // Random polygons at ordinary magnitude and near the safe-integer bound.
  for (const magnitude of [10, 10_000, 2_700_000, 900_000_000, Number.MAX_SAFE_INTEGER]) {
    for (let trial = 0; trial < 12; trial += 1) {
      const vertexCount = 3 + Math.floor(next() * 6)
      const path: CanonicalGridPoint[] = []
      for (let vertex = 0; vertex < vertexCount; vertex += 1) {
        const angle = (vertex / vertexCount) * Math.PI * 2
        const radius = Math.floor(magnitude * (0.3 + 0.7 * next()))
        const x = Math.round(Math.cos(angle) * radius)
        const y = Math.round(Math.sin(angle) * radius)
        path.push(point(Number.isSafeInteger(x) ? x : 0, Number.isSafeInteger(y) ? y : 0))
      }
      push(path)
    }
  }

  for (const ring of realRings) push(ring)

  return vectors
}

interface ConvexHullVector {
  readonly points: EncodedPoint[]
  readonly hull: EncodedPoint[] | null
}

function buildConvexHullVectors(realRings: ReadonlyArray<CanonicalGridPoint[]>): ConvexHullVector[] {
  const vectors: ConvexHullVector[] = []
  const push = (points: CanonicalGridPoint[]): void => {
    vectors.push({ points: encodePath(points), hull: encodeOptionalPath(canonicalGridConvexHull(points)) })
  }

  push([])
  push([point(1, 1)])
  push([point(1, 1), point(1, 1)])
  push([point(0, 0), point(1, 1)])
  push([point(0, 0), point(1, 0), point(2, 0), point(3, 0)]) // all collinear
  push([point(0, 0), point(1, 0), point(0, 1), point(1, 1)])
  // Duplicate points, including a signed-zero key collision: `{x:0,y:0}`
  // and `{x:-0,y:0}` render to the same `Map` key (`"0,0"`) but the *value*
  // stored is whichever occurrence is last, only the *position* is first.
  push([point(0, 0), point(-0, 0), point(5, 5), point(0, 0)])
  push([point(-0, -0), point(0, 0), point(3, 0), point(0, 3)])
  push([point(2, 2), point(2, 2), point(2, 2)])
  // Invalid coordinate mixed in.
  push([point(0, 0), point(1.5, 0), point(0, 1)])

  const next = mulberry32(0x1de4)
  for (const magnitude of [5, 1_000, 2_700_000, 900_000_000, Number.MAX_SAFE_INTEGER]) {
    for (let trial = 0; trial < 10; trial += 1) {
      const count = 3 + Math.floor(next() * 30)
      const points: CanonicalGridPoint[] = []
      for (let index = 0; index < count; index += 1) {
        const x = Math.floor(next() * (2 * magnitude + 1)) - magnitude
        const y = Math.floor(next() * (2 * magnitude + 1)) - magnitude
        points.push(point(Number.isSafeInteger(x) ? x : 0, Number.isSafeInteger(y) ? y : 0))
      }
      push(points)
    }
  }
  // Points forming a perfect grid (many collinear subsets, exercises the
  // tie-break heavy path of the monotone chain).
  const gridPoints: CanonicalGridPoint[] = []
  for (let gx = 0; gx < 6; gx += 1) {
    for (let gy = 0; gy < 6; gy += 1) gridPoints.push(point(gx * 1000, gy * 1000))
  }
  push(gridPoints)

  for (const ring of realRings) push(ring)

  return vectors
}

interface PointOnSegmentVector {
  readonly point: EncodedPoint
  readonly start: EncodedPoint
  readonly end: EncodedPoint
  readonly expected: boolean
}

function buildPointOnSegmentVectors(): PointOnSegmentVector[] {
  const vectors: PointOnSegmentVector[] = []
  const push = (p: CanonicalGridPoint, start: CanonicalGridPoint, end: CanonicalGridPoint): void => {
    vectors.push({
      point: encodePoint(p),
      start: encodePoint(start),
      end: encodePoint(end),
      expected: canonicalGridPointOnSegment(p, start, end)
    })
  }

  // Degenerate zero-length segment.
  push(point(0, 0), point(0, 0), point(0, 0))
  push(point(1, 0), point(0, 0), point(0, 0))
  // Exactly on segment, at endpoints, at midpoint.
  push(point(0, 0), point(0, 0), point(10, 0))
  push(point(10, 0), point(0, 0), point(10, 0))
  push(point(5, 0), point(0, 0), point(10, 0))
  push(point(5, 5), point(0, 0), point(10, 10))
  // Collinear but outside the segment's bounding box.
  push(point(15, 0), point(0, 0), point(10, 0))
  push(point(-1, -1), point(0, 0), point(10, 10))
  // Not collinear at all.
  push(point(5, 1), point(0, 0), point(10, 0))
  // Negative-zero coordinates.
  push(point(-0, 0), point(0, 0), point(10, 0))
  push(point(0, -0), point(-0, -0), point(-0, -0))
  // Invalid coordinate -> false (undefined cross, not a thrown error).
  push(point(0.5, 0), point(0, 0), point(10, 0))
  push(point(5, 0), point(Number.MAX_SAFE_INTEGER + 4, 0), point(10, 0))

  const next = mulberry32(0x7e57)
  for (let trial = 0; trial < 200; trial += 1) {
    const magnitude = [10, 1_000, 2_700_000, 900_000_000][trial % 4] ?? 10
    const start = point(
      Math.floor(next() * (2 * magnitude + 1)) - magnitude,
      Math.floor(next() * (2 * magnitude + 1)) - magnitude
    )
    const end = point(
      Math.floor(next() * (2 * magnitude + 1)) - magnitude,
      Math.floor(next() * (2 * magnitude + 1)) - magnitude
    )
    // Interpolate along the segment (on-segment cases) half the time,
    // otherwise pick an unrelated random point (mostly-off-segment cases).
    if (trial % 2 === 0) {
      const t = next() % 1_000_007
      const fraction = t / 1_000_007
      const px = Math.round(start.x + (end.x - start.x) * fraction)
      const py = Math.round(start.y + (end.y - start.y) * fraction)
      push(point(px, py), start, end)
    } else {
      const other = point(
        Math.floor(next() * (2 * magnitude + 1)) - magnitude,
        Math.floor(next() * (2 * magnitude + 1)) - magnitude
      )
      push(other, start, end)
    }
  }

  return vectors
}

interface DoubledAreaToMm2Vector {
  readonly doubledAreaGrid2: string
  readonly expected: EncodedF64 | null
}

function buildDoubledAreaToMm2Vectors(): DoubledAreaToMm2Vector[] {
  const vectors: DoubledAreaToMm2Vector[] = []
  const push = (value: bigint): void => {
    vectors.push({ doubledAreaGrid2: encodeBigInt(value), expected: encodeOptionalF64(doubledGridAreaToMm2(value)) })
  }

  push(0n)
  push(1n)
  push(-1n)
  push(2_000_000n) // exactly 1mm^2
  push(-2_000_000n)
  push(3n)
  push(2_000_001n)

  const next = mulberry32(0xfeed)
  for (let index = 0; index < 80; index += 1) {
    push(randomBigInt(next, 1 + (index % 20)))
  }

  // Magnitudes bracketing the f64-overflow boundary: `Number(value)` itself
  // overflows to `+-Infinity` once `value`'s magnitude exceeds
  // `Number.MAX_VALUE` (~1.7976931348623157e308, ~309 decimal digits), and
  // the subsequent `/2_000_000` division preserves that non-finiteness;
  // sample well below, straddling, and well past that boundary so both the
  // `Some` and `None` branches of the `Number.isFinite` guard are exercised
  // by the real function, not assumed.
  const nine = (count: number): string => '9'.repeat(count)
  for (const digitCount of [300, 310, 314, 315, 316, 320, 400, 1000]) {
    push(BigInt(nine(digitCount)))
    push(-BigInt(nine(digitCount)))
  }

  return vectors
}

interface ToGridMmVector {
  readonly valueMm: EncodedF64
  readonly expected: EncodedF64 | null
}

function buildToGridMmVectors(): ToGridMmVector[] {
  const vectors: ToGridMmVector[] = []
  const push = (value: number): void => {
    vectors.push({ valueMm: encodeF64(value), expected: encodeOptionalF64(toGridMm(value)) })
  }

  push(0)
  push(-0)
  push(1)
  push(-1)
  push(0.5)
  push(-0.5)
  push(0.0005)
  push(-0.0005)
  push(0.0004999)
  push(1.0005)
  push(-1.0005)
  push(100)
  push(-100)
  push(0.001)
  push(0.0001)
  push(123.456)
  push(-123.456)
  push(9_007_199_254_740.99) // just inside the scaled safe-integer boundary
  push(9_007_199_254_741.5) // just outside it
  push(-9_007_199_254_740.99)
  push(-9_007_199_254_741.5)
  push(1e-10)
  push(1e10)
  push(Number.MAX_SAFE_INTEGER)
  push(-Number.MAX_SAFE_INTEGER)
  push(Number.MAX_VALUE) // scaled value overflows to Infinity
  push(-Number.MAX_VALUE)

  const next = mulberry32(0x9001)
  for (let index = 0; index < 150; index += 1) {
    const magnitude = [0.001, 1, 100, 10_000, 1_000_000, 1_000_000_000][index % 6] ?? 1
    const sign = next() < 0.5 ? -1 : 1
    const value = sign * next() * (magnitude ?? 1)
    push(value)
  }
  // Values that land exactly on a `.5` tie after scaling (ties away from
  // zero), at several magnitudes.
  for (let millis = -50; millis <= 50; millis += 1) {
    push((millis + 0.5) / 1000)
  }

  return vectors
}

interface ToGridMmSpecialVector {
  readonly tag: 'nan' | 'positiveInfinity' | 'negativeInfinity'
  readonly expected: EncodedF64 | null
}

function buildToGridMmSpecialVectors(): ToGridMmSpecialVector[] {
  return [
    { tag: 'nan', expected: encodeOptionalF64(toGridMm(Number.NaN)) },
    { tag: 'positiveInfinity', expected: encodeOptionalF64(toGridMm(Number.POSITIVE_INFINITY)) },
    { tag: 'negativeInfinity', expected: encodeOptionalF64(toGridMm(Number.NEGATIVE_INFINITY)) }
  ]
}

interface FromGridVector {
  readonly value: EncodedF64
  readonly expected: EncodedF64
}

function buildFromGridVectors(): FromGridVector[] {
  const vectors: FromGridVector[] = []
  const push = (value: number): void => {
    vectors.push({ value: encodeF64(value), expected: encodeF64(fromGrid(value)) })
  }
  push(0)
  push(-0)
  push(1)
  push(-1)
  push(1000)
  push(-1000)
  push(1)
  push(999)
  push(Number.MAX_SAFE_INTEGER)
  push(-Number.MAX_SAFE_INTEGER)
  const next = mulberry32(0x9002)
  for (let index = 0; index < 60; index += 1) {
    const magnitude = [1, 1_000, 1_000_000, 1_000_000_000, Number.MAX_SAFE_INTEGER][index % 5] ?? 1
    const sign = next() < 0.5 ? -1 : 1
    push(Math.floor(sign * next() * magnitude))
  }
  return vectors
}

// ---------------------------------------------------------------------------
// Assemble and write.
// ---------------------------------------------------------------------------

function gitCommit(): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot }).toString().trim()
}

function main(): void {
  const realRings = loadRealMmRings()

  const crossVectors = buildCrossVectors()
  const compareBigIntsVectors = buildCompareBigIntsVectors()
  const compareRatiosVectors = buildCompareRatiosVectors()
  const areaVectors = buildAreaVectors(realRings)
  const convexHullVectors = buildConvexHullVectors(realRings)
  const pointOnSegmentVectors = buildPointOnSegmentVectors()
  const doubledAreaToMm2Vectors = buildDoubledAreaToMm2Vectors()
  const toGridMmVectors = buildToGridMmVectors()
  const toGridMmSpecialVectors = buildToGridMmSpecialVectors()
  const fromGridVectors = buildFromGridVectors()

  const totalVectorCount =
    crossVectors.length +
    compareBigIntsVectors.length +
    compareRatiosVectors.length +
    areaVectors.length +
    convexHullVectors.length +
    pointOnSegmentVectors.length +
    doubledAreaToMm2Vectors.length +
    toGridMmVectors.length +
    toGridMmSpecialVectors.length +
    fromGridVectors.length

  const document = {
    header: {
      generatedBy: 'scripts/rust-parity/dump-canonical-grid.ts',
      generatingCommit: gitCommit(),
      generatedAt: new Date().toISOString(),
      sourceFiles: [
        'src/workers/irregular/canonicalGridMath.ts',
        'src/workers/irregular/clipper2OffsetPolicy.ts'
      ],
      totalVectorCount,
      realRingCount: realRings.length,
      note:
        'BigInt values are quoted base-10 strings. f64 values that are exactly zero, NaN, or infinite are tagged strings ("0", "-0", "NaN", "Infinity", "-Infinity") because JSON.stringify cannot distinguish -0 from 0 and cannot represent non-finite numbers at all; every other f64 value is a plain JSON number, which both JSON.stringify/JSON.parse and serde_json round-trip bit-exactly via the ECMAScript shortest-round-trip algorithm.'
    },
    crossVectors,
    compareBigIntsVectors,
    compareRatiosVectors,
    areaVectors,
    convexHullVectors,
    pointOnSegmentVectors,
    doubledAreaToMm2Vectors,
    toGridMmVectors,
    toGridMmSpecialVectors,
    fromGridVectors
  }

  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
   
  console.log(`Wrote ${totalVectorCount} canonical-grid vectors to ${outputPath}`)
}

main()
