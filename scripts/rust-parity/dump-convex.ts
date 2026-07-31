/**
 * Differential-vector dump for the Rust `geometry::convex` module
 * (`crates/irregular-nesting-native/src/geometry/convex.rs`).
 *
 * Imports the REAL production TS entry points --
 *   - `ConvexHull.compute` (`src/workers/irregular/convexHull.ts`), the sole
 *     implementation bound to `GeometryKernel.Live`'s `convexHull` operation,
 *   - `boundsForPoints` / `translatePolygonWithBounds` / `areDisjoint`
 *     (`src/workers/irregular/convexBounds.ts`),
 *   - `ConvexPolygonValidation.validateStrictBoundary`
 *     (`src/workers/irregular/convexPolygonValidation.ts`) --
 * evaluates them over a broad deliberate input matrix (random seeded point
 * sets with collinear/duplicate points, all 61 real fixture-piece rings,
 * validation pass/fail cases straddling every guard bound, and bounds/
 * translate/disjoint outputs), and writes byte-exact JSON vectors for a Rust
 * integration test to replay.
 *
 * Run with:
 *   pnpm exec tsx --tsconfig tsconfig.node.json scripts/rust-parity/dump-convex.ts
 *
 * Output (additive; never edits existing fixtures/tests):
 *   - crates/irregular-nesting-native/tests/vectors/convex.json
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ConvexHull } from '../../src/workers/irregular/convexHull.js'
import {
  areDisjoint,
  boundsForPoints,
  translatePolygonWithBounds
} from '../../src/workers/irregular/convexBounds.js'
import { ConvexPolygonValidation } from '../../src/workers/irregular/convexPolygonValidation.js'
import type { InternalBounds, InternalPoint } from '../../src/workers/irregular/internalGeometry.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..', '..')
const VECTORS_DIR = join(REPO_ROOT, 'crates', 'irregular-nesting-native', 'tests', 'vectors')
const MIXED61_FIXTURE = join(
  REPO_ROOT,
  'tests',
  'fixtures',
  'irregularSheetInvariance',
  'mixed61-request.json'
)

function generatingCommit(): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT }).toString().trim()
}

// ---------------------------------------------------------------------------
// f64 -> exact big-endian IEEE-754 bit-pattern hex string, so the Rust side
// reads the identical bits rather than round-tripping through a decimal/JSON
// number literal (which cannot represent negative zero exactness reliably
// across every code path, and cannot represent NaN/Infinity at all). Matches
// `dump-predicates.ts`'s `f64Bits` convention exactly.
// ---------------------------------------------------------------------------
function f64Bits(value: number): string {
  const buffer = new ArrayBuffer(8)
  const view = new DataView(buffer)
  view.setFloat64(0, value, false)
  let hex = '0x'
  for (let i = 0; i < 8; i++) {
    hex += view.getUint8(i).toString(16).padStart(2, '0')
  }
  return hex
}

function bitsOf(value: number): bigint {
  const buffer = new ArrayBuffer(8)
  const view = new DataView(buffer)
  view.setFloat64(0, value, false)
  return view.getBigUint64(0, false)
}

function fromBits(bits: bigint): number {
  const buffer = new ArrayBuffer(8)
  const view = new DataView(buffer)
  view.setBigUint64(0, bits, false)
  return view.getFloat64(0, false)
}

/** Next representable double strictly greater than a positive finite `value`. */
function nextUp(value: number): number {
  return fromBits(bitsOf(value) + 1n)
}

/** Next representable double strictly less than a positive finite `value`. */
function nextDown(value: number): number {
  return fromBits(bitsOf(value) - 1n)
}

// ---------------------------------------------------------------------------
// Deterministic seeded PRNG (mulberry32), matching the convention already
// established by `dump-predicates.ts` / `dump-canonical-grid.ts`.
// ---------------------------------------------------------------------------
function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function randomInRange(random: () => number, lo: number, hi: number): number {
  return lo + random() * (hi - lo)
}

// ---------------------------------------------------------------------------
// Point/bounds encoding.
// ---------------------------------------------------------------------------
interface EncodedPoint {
  readonly x: string
  readonly y: string
}

interface EncodedBounds {
  readonly minX: string
  readonly minY: string
  readonly maxX: string
  readonly maxY: string
}

function encodePoint(point: InternalPoint): EncodedPoint {
  return { x: f64Bits(point.x), y: f64Bits(point.y) }
}

function encodePoints(points: ReadonlyArray<InternalPoint>): EncodedPoint[] {
  return points.map(encodePoint)
}

function encodeBounds(bounds: InternalBounds): EncodedBounds {
  return {
    minX: f64Bits(bounds.minX),
    minY: f64Bits(bounds.minY),
    maxX: f64Bits(bounds.maxX),
    maxY: f64Bits(bounds.maxY)
  }
}

function point(x: number, y: number): InternalPoint {
  return { x, y }
}

// ---------------------------------------------------------------------------
// Section 1: compute_convex_hull vectors.
// ---------------------------------------------------------------------------
interface HullCase {
  readonly category: string
  readonly input: EncodedPoint[]
  readonly hull: EncodedPoint[]
}

const hullCases: HullCase[] = []

function makeHullCase(category: string, points: ReadonlyArray<InternalPoint>): void {
  const hull = ConvexHull.compute(points)
  hullCases.push({ category, input: encodePoints(points), hull: encodePoints(hull.points) })
}

// Degenerate sizes.
makeHullCase('empty', [])
makeHullCase('single-point', [point(3, 4)])
makeHullCase('single-point', [point(-0, 0)])
makeHullCase('two-points-sorted', [point(1, 2), point(5, 0)])
makeHullCase('two-points-same-x', [point(2, 5), point(2, -5)])
makeHullCase('two-identical-points', [point(2, 2), point(2, 2)])

// Duplicate-coordinate heavy inputs.
makeHullCase('all-duplicates', [point(1, 1), point(1, 1), point(1, 1), point(1, 1)])
makeHullCase('square-with-duplicated-corners', [
  point(0, 0),
  point(0, 0),
  point(10, 0),
  point(10, 0),
  point(10, 10),
  point(0, 10),
  point(0, 10)
])

// Collinear-only inputs.
makeHullCase('collinear-line', [point(0, 0), point(1, 1), point(2, 2), point(3, 3), point(1.5, 1.5)])
makeHullCase('collinear-horizontal', [point(-5, 2), point(0, 2), point(5, 2), point(2, 2)])
makeHullCase('collinear-vertical', [point(3, -5), point(3, 0), point(3, 5)])

// Square with collinear edge points and an interior point that must be
// discarded.
makeHullCase('square-with-collinear-edge-and-interior', [
  point(0, 0),
  point(5, 0),
  point(10, 0),
  point(10, 10),
  point(0, 10),
  point(5, 5)
])

// Negative-zero / zero tie-break at the sort comparator.
makeHullCase('negative-zero-x-tie', [point(-0, 1), point(0, -1), point(0, 3)])
makeHullCase('negative-zero-y-dedup', [point(2, -0), point(2, 0), point(5, 5)])

// Regular polygons at several vertex counts and radii, with an interior
// centroid point, both windings of the input order.
{
  const random = mulberry32(0x7ea15e0d)
  for (let vertexCount = 3; vertexCount <= 20; vertexCount += 1) {
    for (let variant = 0; variant < 3; variant += 1) {
      const radius = 5 + random() * 95
      const cx = randomInRange(random, -50, 50)
      const cy = randomInRange(random, -50, 50)
      const points: InternalPoint[] = []
      for (let index = 0; index < vertexCount; index += 1) {
        const angle = (2 * Math.PI * index) / vertexCount + random() * 0.01
        points.push(
          point(
            Number((cx + radius * Math.cos(angle)).toFixed(6)),
            Number((cy + radius * Math.sin(angle)).toFixed(6))
          )
        )
      }
      points.push(point(cx, cy)) // interior centroid, must be discarded
      const ordered = variant === 2 ? [...points].reverse() : points
      makeHullCase(`regular-polygon-${vertexCount}`, ordered)
    }
  }
}

// Seeded random point clouds of varying size, some with injected duplicates
// and collinear runs.
{
  const random = mulberry32(0xc0117de0)
  for (let trial = 0; trial < 120; trial += 1) {
    const size = 3 + Math.floor(random() * 30)
    const points: InternalPoint[] = []
    for (let index = 0; index < size; index += 1) {
      points.push(
        point(
          Number((randomInRange(random, -200, 200)).toFixed(3)),
          Number((randomInRange(random, -200, 200)).toFixed(3))
        )
      )
    }
    // Inject duplicates for roughly a third of trials.
    if (trial % 3 === 0 && points.length > 0) {
      points.push({ ...(points[0] as InternalPoint) })
      points.push({ ...(points[Math.floor(points.length / 2)] as InternalPoint) })
    }
    // Inject a collinear run along one existing edge direction for another
    // third.
    if (trial % 3 === 1 && points.length >= 2) {
      const a = points[0] as InternalPoint
      const b = points[1] as InternalPoint
      for (let t = 2; t <= 4; t += 1) {
        points.push(point(a.x + ((b.x - a.x) * t) / 5, a.y + ((b.y - a.y) * t) / 5))
      }
    }
    makeHullCase('random-seeded', points)
  }
}

// Extreme-magnitude and mixed-magnitude clouds.
{
  const extremeValues = [
    0,
    -0,
    Number.MIN_VALUE,
    -Number.MIN_VALUE,
    1e-300,
    1e300,
    -1e300,
    Number.MAX_SAFE_INTEGER,
    -Number.MAX_SAFE_INTEGER
  ]
  for (const value of extremeValues) {
    makeHullCase('extreme-magnitude', [
      point(value, 0),
      point(0, value === 0 ? 1 : value / 2),
      point(1, 1),
      point(-1, -1)
    ])
  }
}

// ---------------------------------------------------------------------------
// Section 2: hulls of all 61 real fixture pieces' geometry rings.
// ---------------------------------------------------------------------------
interface FixtureLineSegment {
  readonly kind: string
  readonly x1: number
  readonly y1: number
  readonly x2: number
  readonly y2: number
}
interface FixturePiece {
  readonly label: string
  readonly geometry: { readonly segments: ReadonlyArray<FixtureLineSegment> }
}
interface Mixed61Fixture {
  readonly sourcePieces: ReadonlyArray<FixturePiece>
}

{
  const fixtureRaw = readFileSync(MIXED61_FIXTURE, 'utf8')
  const fixture = JSON.parse(fixtureRaw) as Mixed61Fixture
  if (fixture.sourcePieces.length !== 61) {
    throw new Error(
      `Expected 61 source pieces in the mixed61 fixture, got ${fixture.sourcePieces.length}.`
    )
  }
  for (const piece of fixture.sourcePieces) {
    // Every segment in this fixture is a `line`; its ring is the ordered
    // sequence of segment start points (the implicit closing edge runs from
    // the last segment's end back to the first segment's start).
    const points = piece.geometry.segments.map((segment) => point(segment.x1, segment.y1))
    makeHullCase(`fixture-piece:${piece.label}`, points)
  }
}

if (hullCases.length < 150) {
  throw new Error(`Expected at least 150 hull vectors, generated only ${hullCases.length}.`)
}

// ---------------------------------------------------------------------------
// Section 3: boundsForPoints vectors.
// ---------------------------------------------------------------------------
interface BoundsCase {
  readonly category: string
  readonly input: EncodedPoint[]
  readonly bounds: EncodedBounds | null
}

const boundsCases: BoundsCase[] = []

function makeBoundsCase(category: string, points: ReadonlyArray<InternalPoint>): void {
  const bounds = boundsForPoints(points)
  boundsCases.push({
    category,
    input: encodePoints(points),
    bounds: bounds === undefined ? null : encodeBounds(bounds)
  })
}

makeBoundsCase('empty', [])
makeBoundsCase('single-finite-point', [point(3, -4)])
makeBoundsCase('first-point-nan-x', [point(Number.NaN, 0), point(1, 1)])
makeBoundsCase('first-point-infinite-y', [point(0, Number.POSITIVE_INFINITY), point(1, 1)])
makeBoundsCase('later-point-nan', [point(0, 0), point(1, 1), point(Number.NaN, 2)])
makeBoundsCase('later-point-neg-infinite', [point(0, 0), point(Number.NEGATIVE_INFINITY, 2)])
makeBoundsCase('tight-box', [point(2, -3), point(-1, 5), point(4, 1)])
makeBoundsCase('negative-zero-extents', [point(-0, -0), point(0, 0)])
makeBoundsCase('single-point-extreme-magnitude', [point(1e300, -1e300)])

// Reuse a subset of the hull random clouds (every input's bounds).
{
  const random = mulberry32(0xb0117d5)
  for (let trial = 0; trial < 60; trial += 1) {
    const size = 1 + Math.floor(random() * 12)
    const points: InternalPoint[] = []
    for (let index = 0; index < size; index += 1) {
      points.push(point(randomInRange(random, -1000, 1000), randomInRange(random, -1000, 1000)))
    }
    makeBoundsCase('random-seeded', points)
  }
}

if (boundsCases.length < 60) {
  throw new Error(`Expected at least 60 bounds vectors, generated only ${boundsCases.length}.`)
}

// ---------------------------------------------------------------------------
// Section 4: translatePolygonWithBounds vectors.
// ---------------------------------------------------------------------------
interface TranslateCase {
  readonly category: string
  readonly polygon: EncodedPoint[]
  readonly translation: EncodedPoint
  readonly result: { readonly polygon: EncodedPoint[]; readonly bounds: EncodedBounds } | null
}

const translateCases: TranslateCase[] = []

function makeTranslateCase(
  category: string,
  polygonPoints: ReadonlyArray<InternalPoint>,
  translation: InternalPoint
): void {
  const result = translatePolygonWithBounds({ points: polygonPoints }, translation)
  translateCases.push({
    category,
    polygon: encodePoints(polygonPoints),
    translation: encodePoint(translation),
    result:
      result === undefined
        ? null
        : { polygon: encodePoints(result.polygon.points), bounds: encodeBounds(result.bounds) }
  })
}

makeTranslateCase('empty-polygon', [], point(1, 1))
makeTranslateCase('identity-translation', [point(0, 0), point(2, 0), point(2, 2), point(0, 2)], point(0, 0))
makeTranslateCase(
  'positive-translation',
  [point(0, 0), point(2, 0), point(2, 2), point(0, 2)],
  point(10, -5)
)
makeTranslateCase(
  'negative-zero-translation',
  [point(1, 1), point(2, 2), point(3, 1)],
  point(-0, -0)
)
makeTranslateCase(
  'non-finite-translation-x',
  [point(0, 0), point(1, 1)],
  point(Number.POSITIVE_INFINITY, 0)
)
makeTranslateCase(
  'non-finite-translation-y',
  [point(0, 0), point(1, 1)],
  point(0, Number.NaN)
)
makeTranslateCase(
  'overflow-to-infinity',
  [point(Number.MAX_VALUE, 0), point(0, 0), point(1, 1)],
  point(Number.MAX_VALUE, 0)
)
makeTranslateCase('single-point-polygon', [point(5, 5)], point(-5, -5))

// Every fixture piece ring, translated by a handful of representative
// vectors (identity, integer, fractional, large, negative).
{
  const fixtureRaw = readFileSync(MIXED61_FIXTURE, 'utf8')
  const fixture = JSON.parse(fixtureRaw) as Mixed61Fixture
  const translations = [point(0, 0), point(1000, 500), point(-250.5, 75.25), point(-1e6, 1e6)]
  for (let index = 0; index < fixture.sourcePieces.length; index += 4) {
    const piece = fixture.sourcePieces[index] as FixturePiece
    const points = piece.geometry.segments.map((segment) => point(segment.x1, segment.y1))
    for (const translation of translations) {
      makeTranslateCase(`fixture-piece:${piece.label}`, points, translation)
    }
  }
}

if (translateCases.length < 40) {
  throw new Error(`Expected at least 40 translate vectors, generated only ${translateCases.length}.`)
}

// ---------------------------------------------------------------------------
// Section 5: areDisjoint vectors.
// ---------------------------------------------------------------------------
interface DisjointCase {
  readonly category: string
  readonly first: EncodedBounds
  readonly second: EncodedBounds
  readonly disjoint: boolean
}

const disjointCases: DisjointCase[] = []

function makeDisjointBounds(minX: number, minY: number, maxX: number, maxY: number): InternalBounds {
  return { minX, minY, maxX, maxY }
}

function makeDisjointCase(category: string, first: InternalBounds, second: InternalBounds): void {
  disjointCases.push({
    category,
    first: encodeBounds(first),
    second: encodeBounds(second),
    disjoint: areDisjoint(first, second)
  })
}

const boundsA = makeDisjointBounds(0, 0, 10, 10)
makeDisjointCase('overlapping', boundsA, makeDisjointBounds(5, 5, 15, 15))
makeDisjointCase('touching-on-x', boundsA, makeDisjointBounds(10, 0, 20, 10))
makeDisjointCase('touching-on-y', boundsA, makeDisjointBounds(0, 10, 10, 20))
makeDisjointCase('separated-on-x', boundsA, makeDisjointBounds(11, 0, 20, 10))
makeDisjointCase('separated-on-y', boundsA, makeDisjointBounds(0, 11, 10, 20))
makeDisjointCase('nested', boundsA, makeDisjointBounds(2, 2, 8, 8))
makeDisjointCase('identical', boundsA, boundsA)
makeDisjointCase(
  'negative-coordinates-separated',
  makeDisjointBounds(-20, -20, -10, -10),
  makeDisjointBounds(-5, -5, 5, 5)
)
makeDisjointCase(
  'negative-coordinates-touching',
  makeDisjointBounds(-10, -10, 0, 0),
  makeDisjointBounds(0, -10, 10, 0)
)
makeDisjointCase(
  'degenerate-point-bounds-inside',
  makeDisjointBounds(5, 5, 5, 5),
  boundsA
)
makeDisjointCase(
  'degenerate-point-bounds-outside',
  makeDisjointBounds(50, 50, 50, 50),
  boundsA
)

// Systematic grid of translated boxes against a fixed reference box, to
// exercise every combination of x/y separated/touching/overlapping.
{
  const reference = makeDisjointBounds(0, 0, 10, 10)
  const offsets = [-15, -10, -5, 0, 5, 10, 15]
  for (const dx of offsets) {
    for (const dy of offsets) {
      const other = makeDisjointBounds(dx, dy, dx + 10, dy + 10)
      makeDisjointCase('offset-grid', reference, other)
    }
  }
}

if (disjointCases.length < 40) {
  throw new Error(`Expected at least 40 disjoint vectors, generated only ${disjointCases.length}.`)
}

// ---------------------------------------------------------------------------
// Section 6: validateStrictBoundary vectors -- pass/fail cases straddling
// every guard bound.
// ---------------------------------------------------------------------------
type ValidationResult = { readonly winding: -1 | 1 } | { readonly message: string }

interface ValidationCase {
  readonly category: string
  readonly points: EncodedPoint[]
  readonly result: ValidationResult
}

const validationCases: ValidationCase[] = []

function makeValidationCase(category: string, points: ReadonlyArray<InternalPoint>): void {
  const result = ConvexPolygonValidation.validateStrictBoundary(points)
  validationCases.push({ category, points: encodePoints(points), result })
}

function rotations(points: ReadonlyArray<InternalPoint>): InternalPoint[][] {
  const out: InternalPoint[][] = []
  for (let offset = 0; offset < points.length; offset += 1) {
    const rotated = [...points.slice(offset), ...points.slice(0, offset)]
    out.push(rotated, [...rotated].reverse())
  }
  return out
}

function convexRing(vertexCount: number, radius: number, cx = 0, cy = 0): InternalPoint[] {
  const points: InternalPoint[] = []
  for (let index = 0; index < vertexCount; index += 1) {
    const angle = (2 * Math.PI * index) / vertexCount
    points.push(
      point(
        Number((cx + radius * Math.cos(angle)).toFixed(4)),
        Number((cy + radius * Math.sin(angle)).toFixed(4))
      )
    )
  }
  return points
}

function starRing(vertexCount: number, step: number, radius = 50): InternalPoint[] {
  const points: InternalPoint[] = []
  for (let index = 0; index < vertexCount; index += 1) {
    const angle = (2 * Math.PI * ((index * step) % vertexCount)) / vertexCount
    points.push(point(Number((radius * Math.cos(angle)).toFixed(6)), Number((radius * Math.sin(angle)).toFixed(6))))
  }
  return points
}

// (1) vertex count < 3.
makeValidationCase('too-few-vertices', [])
makeValidationCase('too-few-vertices', [point(0, 0)])
makeValidationCase('too-few-vertices', [point(0, 0), point(1, 1)])

// (2) non-finite coordinates, at every vertex position of a triangle.
for (const badValue of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
  for (let position = 0; position < 3; position += 1) {
    const points = [point(0, 0), point(10, 0), point(5, 10)]
    points[position] = point(badValue, points[position]!.y)
    makeValidationCase('non-finite-coordinate', points)
    const pointsY = [point(0, 0), point(10, 0), point(5, 10)]
    pointsY[position] = point(pointsY[position]!.x, badValue)
    makeValidationCase('non-finite-coordinate', pointsY)
  }
}

// (3) repeated adjacent vertex, at every edge of a quadrilateral.
{
  const base = [point(0, 0), point(10, 0), point(10, 10), point(0, 10)]
  for (let index = 0; index < base.length; index += 1) {
    const points = base.map((p) => ({ ...p }))
    points[(index + 1) % base.length] = { ...(points[index] as InternalPoint) }
    makeValidationCase('repeated-adjacent-vertex', points)
  }
}

// (4) collinear vertex, at every position of a pentagon-with-a-midpoint.
{
  const base = [point(0, 0), point(5, 0), point(10, 0), point(10, 10), point(0, 10)]
  for (const variant of rotations(base)) makeValidationCase('collinear-vertex', variant)
}

// (5) inconsistent winding: concave "dart" shapes at several vertex counts.
{
  const darts: InternalPoint[][] = [
    [point(0, 0), point(10, 0), point(5, 3), point(10, 10), point(0, 10)],
    [point(0, 0), point(20, 0), point(10, 5), point(20, 20), point(0, 20)],
    [point(0, 0), point(10, 0), point(10, 10), point(5, 4), point(0, 10)]
  ]
  for (const dart of darts) for (const variant of rotations(dart)) makeValidationCase('inconsistent-winding', variant)
}

// (6) valid strictly convex rings: regular n-gons for a wide range of vertex
// counts, both windings, every rotation.
for (let vertexCount = 3; vertexCount <= 24; vertexCount += 1) {
  for (const variant of rotations(convexRing(vertexCount, 30))) {
    makeValidationCase('valid-convex-ring', variant)
  }
}

// (7) self-intersecting star rings: many vertex counts / steps / windings /
// rotations, all landing in the "consistent turns but crosses" cell that
// only the linear revolution-count decision (or its quadratic fallback) can
// reject.
{
  const random = mulberry32(0x51a551a5)
  for (let vertexCount = 5; vertexCount <= 25; vertexCount += 2) {
    for (let step = 2; step * 2 < vertexCount; step += 1) {
      const phase = random() * Math.PI
      const star = starRing(vertexCount, step, 20 + random() * 60).map((p) =>
        point(
          Number((p.x * Math.cos(phase) - p.y * Math.sin(phase)).toFixed(6)),
          Number((p.x * Math.sin(phase) + p.y * Math.cos(phase)).toFixed(6))
        )
      )
      for (const variant of rotations(star).slice(0, 4)) {
        makeValidationCase('self-intersecting-star', variant)
      }
    }
  }
  // The exact bowtie fixture from
  // `tests/unit/convexPolygonValidationTopology.test.ts:339-352`.
  makeValidationCase('bowtie', [point(0, 0), point(10, 10), point(10, 0), point(0, 10)])
}

// (8) pinched rings: a duplicated non-adjacent vertex, and a vertex resting
// exactly on a non-adjacent edge -- the sweep/linear decision must both
// treat touching as an intersection.
{
  const pinchBase = [point(0, 0), point(10, 0), point(14, 6), point(7, 12), point(-3, 6)]
  for (let source = 0; source < pinchBase.length; source += 1) {
    for (let target = 0; target < pinchBase.length; target += 1) {
      const adjacent =
        Math.abs(source - target) <= 1 ||
        (source === 0 && target === pinchBase.length - 1) ||
        (target === 0 && source === pinchBase.length - 1)
      if (adjacent) continue
      const pinched = pinchBase.map((p) => ({ ...p }))
      pinched[target] = { ...(pinchBase[source] as InternalPoint) }
      makeValidationCase('pinched-duplicate-vertex', pinched)
    }
  }
  makeValidationCase('vertex-on-non-adjacent-edge', [
    point(0, 0),
    point(10, 0),
    point(5, 0),
    point(5, 8)
  ])
  makeValidationCase('vertex-on-non-adjacent-edge', [
    point(0, 0),
    point(10, 0),
    point(10, 10),
    point(5, 0),
    point(0, 10)
  ])
}

// (9) random rings, mirroring the production topology test's own corpus:
// reaches concave, collinear, and crossing outcomes over many small vertex
// counts.
{
  const random = mulberry32(0x1de5eed1)
  for (let trial = 0; trial < 400; trial += 1) {
    const vertexCount = 3 + Math.floor(random() * 10)
    const points: InternalPoint[] = []
    if (trial % 2 === 0) {
      for (let index = 0; index < vertexCount; index += 1) {
        points.push(
          point(
            Number((random() * 100 - 50).toFixed(2)),
            Number((random() * 100 - 50).toFixed(2))
          )
        )
      }
    } else {
      for (const p of convexRing(vertexCount, 20 + random() * 20)) {
        points.push(
          point(
            Number((p.x + (random() * 2 - 1) * 6).toFixed(2)),
            Number((p.y + (random() * 2 - 1) * 6).toFixed(2))
          )
        )
      }
    }
    if (trial % 5 === 0) points.reverse()
    makeValidationCase('random-ring', points)
  }
}

// (10) linear-topology envelope guard bounds: exactly on both bounds, one
// ULP inside, one ULP outside, and clearly-outside multiples -- for both
// valid (convex square) and invalid (self-intersecting bowtie-shaped) rings,
// so the dispatch between the linear revolution-count decision and the
// quadratic edge sweep is exercised right at the guard.
{
  const MIN_BOUND = 2 ** -450
  const MAX_BOUND = 2 ** 500
  const magnitudes: Array<[string, number]> = [
    ['min-bound-exact', MIN_BOUND],
    ['min-bound-one-ulp-inside', nextUp(MIN_BOUND)],
    ['min-bound-one-ulp-outside', nextDown(MIN_BOUND)],
    ['min-bound-clearly-outside', MIN_BOUND / 2],
    ['max-bound-exact', MAX_BOUND],
    ['max-bound-one-ulp-inside', nextDown(MAX_BOUND)],
    ['max-bound-one-ulp-outside', nextUp(MAX_BOUND)],
    ['max-bound-clearly-outside', MAX_BOUND * 2]
  ]
  for (const [label, magnitude] of magnitudes) {
    // Valid axis-aligned convex square: one corner at the origin (magnitude
    // 0, trivially envelope-supported) and the opposite corner at
    // `magnitude`, both windings.
    const squareCcw = [point(0, 0), point(magnitude, 0), point(magnitude, magnitude), point(0, magnitude)]
    makeValidationCase(`envelope-guard:${label}:valid-square-ccw`, squareCcw)
    makeValidationCase(`envelope-guard:${label}:valid-square-cw`, [...squareCcw].reverse())

    // Self-intersecting bowtie at the same magnitude scale.
    const bowtie = [point(0, 0), point(magnitude, magnitude), point(magnitude, 0), point(0, magnitude)]
    makeValidationCase(`envelope-guard:${label}:bowtie`, bowtie)
  }
}

if (validationCases.length < 250) {
  throw new Error(
    `Expected at least 250 validation vectors, generated only ${validationCases.length}.`
  )
}

const totalCaseCount =
  hullCases.length +
  boundsCases.length +
  translateCases.length +
  disjointCases.length +
  validationCases.length

if (totalCaseCount < 500) {
  throw new Error(`Expected at least 500 total convex vectors, generated only ${totalCaseCount}.`)
}

// ---------------------------------------------------------------------------
// Write output.
// ---------------------------------------------------------------------------
mkdirSync(VECTORS_DIR, { recursive: true })

const commit = generatingCommit()

const output = {
  generatedByScript: 'scripts/rust-parity/dump-convex.ts',
  generatingCommit: commit,
  sourceModules: [
    'src/workers/irregular/convexHull.ts',
    'src/workers/irregular/core/convexHullCore.ts',
    'src/workers/irregular/convexBounds.ts',
    'src/workers/irregular/convexPolygonValidation.ts'
  ],
  description:
    'ConvexHull.compute, boundsForPoints, translatePolygonWithBounds, areDisjoint, and ' +
    'ConvexPolygonValidation.validateStrictBoundary evaluated over a broad input matrix: ' +
    'random seeded point sets with collinear/duplicate points, all 61 mixed61 fixture ' +
    'piece rings, and validation pass/fail cases straddling every guard bound (including ' +
    'the 2^-450 / 2^500 linear-topology envelope). f64 values are recorded as big-endian ' +
    'IEEE-754 bit-pattern hex strings for bit-exact replay.',
  totalCaseCount,
  hull: { caseCount: hullCases.length, cases: hullCases },
  bounds: { caseCount: boundsCases.length, cases: boundsCases },
  translate: { caseCount: translateCases.length, cases: translateCases },
  disjoint: { caseCount: disjointCases.length, cases: disjointCases },
  validation: { caseCount: validationCases.length, cases: validationCases }
}

writeFileSync(join(VECTORS_DIR, 'convex.json'), JSON.stringify(output, null, 2) + '\n')

console.log(
  `Wrote ${totalCaseCount} convex vectors ` +
    `(hull=${hullCases.length}, bounds=${boundsCases.length}, translate=${translateCases.length}, ` +
    `disjoint=${disjointCases.length}, validation=${validationCases.length}; commit ${commit}) ` +
    `to ${VECTORS_DIR}`
)
