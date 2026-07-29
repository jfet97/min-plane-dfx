/**
 * Differential-vector dump for `crates/irregular-nesting-native/src/clipper/`
 * (the vendor-translated `clipper2-ts@2.0.1-18` `Core.ts` + `Offset.ts` port,
 * per ruling R10 in `docs/planning/rust-irregular-backend/stage0-rulings.md`).
 *
 * Imports the REAL `clipper2-ts` package directly (the pinned production
 * dependency named by R10 itself, `CLIPPER2_OFFSET_POLICY.backendVersion` ==
 * `2.0.1-18`), evaluates it over a broad deliberate input matrix (typical
 * values, extremes, negative zero, safe-integer-boundary magnitudes,
 * empty/degenerate paths), and writes JSON oracle vectors for the Rust port's
 * integration tests to reproduce exactly.
 *
 * Two output files:
 *   - `tests/vectors/clipper-core.json`: every vector this script can
 *     compute WITHOUT the Clipper2 boolean-clip engine (`Engine.ts`), which
 *     is out of R10's Core.ts+Offset.ts scope for this crate module. This
 *     includes the full per-group offset geometry pipeline
 *     (`ClipperOffset`'s private `doGroupOffset`/`offsetPoint`/etc.,
 *     exercised through a small harness that mirrors `executeInternal`'s
 *     pre-cleanup steps — see `preCleanupSolution` below — reached via a
 *     TypeScript privacy-erasing cast, since `private` is compile-time-only).
 *   - `tests/vectors/clipper-offset-pending.json`: full `ClipperOffset.execute`
 *     / `inflatePaths` outputs on convex polygons at several offsets with
 *     Miter+Polygon (the only join/end-type combination the production app
 *     exercises per `docs/planning/rust-irregular-backend/characterization/collision-prep.md`).
 *     These genuinely require the boolean-clip engine's self-intersection
 *     union cleanup (`executeInternal`, Offset.ts:192-203), which this crate
 *     module deliberately stubs (`clipper::offset::engine_union_stub`, see
 *     that function's doc comment). NOT asserted by any Rust test today —
 *     for the engine agent to activate once `Engine.ts`/`Clipper64` lands.
 *
 * Run with:
 *   pnpm exec tsx --tsconfig tsconfig.node.json scripts/rust-parity/dump-clipper-core.ts
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Path64, Paths64, Point64, PointD, Rect64 } from 'clipper2-ts'
import {
  ClipperOffset,
  EndType,
  InternalClipper,
  JoinType,
  Point64Utils,
  Rect64Utils,
  area,
  isPositive
} from 'clipper2-ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..', '..')
const vectorsDir = join(repoRoot, 'crates/irregular-nesting-native/tests/vectors')
const outputPath = join(vectorsDir, 'clipper-core.json')
const pendingOutputPath = join(vectorsDir, 'clipper-offset-pending.json')

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32 — same generator already used by
// `dump-canonical-grid.ts`, kept identical for repo-wide consistency; no
// `Math.random` anywhere so the vector file is stable across regenerations).
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

// ---------------------------------------------------------------------------
// JSON-safe f64 encoding (same convention as `dump-canonical-grid.ts`):
// finite non-zero values are plain JSON numbers (both V8's `JSON.stringify`
// and Rust's `serde_json` implement ECMAScript's shortest-round-trip
// number<->string algorithm, so this round-trips bit-exact); zero, NaN, and
// Infinity are tagged strings, since plain `JSON.stringify` silently folds
// `-0` to `"0"` and cannot represent `NaN`/`Infinity` at all.
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
  readonly z: EncodedF64
}

function encodePoint(pt: Point64 | PointD): EncodedPoint {
  return { x: encodeF64(pt.x), y: encodeF64(pt.y), z: encodeF64(pt.z ?? 0) }
}

function encodePath(path: ReadonlyArray<Point64 | PointD>): EncodedPoint[] {
  return path.map(encodePoint)
}

function encodePaths(paths: ReadonlyArray<ReadonlyArray<Point64 | PointD>>): EncodedPoint[][] {
  return paths.map(encodePath)
}

interface EncodedRect {
  readonly left: EncodedF64
  readonly top: EncodedF64
  readonly right: EncodedF64
  readonly bottom: EncodedF64
}

function encodeRect(rect: Rect64): EncodedRect {
  return {
    left: encodeF64(rect.left),
    top: encodeF64(rect.top),
    right: encodeF64(rect.right),
    bottom: encodeF64(rect.bottom)
  }
}

function encodeBigInt(value: bigint): string {
  return value.toString()
}

// ---------------------------------------------------------------------------
// Point/path builders.
// ---------------------------------------------------------------------------

function pt(x: number, y: number, z = 0): Point64 {
  return { x, y, z }
}

/** CCW square with side `side`, lower-left corner at `(originX, originY)`. */
function ccwSquare(side: number, originX = 0, originY = 0): Path64 {
  return [
    pt(originX, originY),
    pt(originX + side, originY),
    pt(originX + side, originY + side),
    pt(originX, originY + side)
  ]
}

function cwSquare(side: number, originX = 0, originY = 0): Path64 {
  return [...ccwSquare(side, originX, originY)].reverse()
}

function ccwTriangle(scale = 1, originX = 0, originY = 0): Path64 {
  return [pt(originX, originY), pt(originX + 10 * scale, originY), pt(originX + 5 * scale, originY + 10 * scale)]
}

function lShape(): Path64 {
  return [pt(0, 0), pt(20, 0), pt(20, 10), pt(10, 10), pt(10, 20), pt(0, 20)]
}

function regularPolygon(sides: number, radius: number, cx = 0, cy = 0): Path64 {
  const result: Path64 = []
  for (let i = 0; i < sides; i += 1) {
    const angle = (2 * Math.PI * i) / sides
    result.push(pt(Math.round(cx + radius * Math.cos(angle)), Math.round(cy + radius * Math.sin(angle))))
  }
  return result
}

// A representative set of paths covering: empty/degenerate, small convex,
// concave, self-touching, large-but-safe coordinates (BigInt-area fast/slow
// paths), and non-integer coordinates.
const SAFE_INT = Number.MAX_SAFE_INTEGER
function pathFixtures(): { name: string; path: Path64 }[] {
  return [
    { name: 'empty', path: [] },
    { name: 'one-point', path: [pt(5, 5)] },
    { name: 'two-points', path: [pt(0, 0), pt(10, 10)] },
    { name: 'ccw-triangle-small', path: ccwTriangle(1) },
    { name: 'cw-triangle-small', path: [...ccwTriangle(1)].reverse() },
    { name: 'ccw-square-10', path: ccwSquare(10) },
    { name: 'cw-square-10', path: cwSquare(10) },
    { name: 'ccw-square-offset-negative', path: ccwSquare(50, -1000, -2000) },
    { name: 'ccw-square-1', path: ccwSquare(1) },
    { name: 'ccw-square-zero-side', path: ccwSquare(0) },
    { name: 'l-shape-concave', path: lShape() },
    { name: 'l-shape-reversed', path: [...lShape()].reverse() },
    { name: 'collinear-degenerate', path: [pt(0, 0), pt(5, 0), pt(10, 0)] },
    { name: 'hexagon', path: regularPolygon(6, 1000) },
    { name: 'pentagon', path: regularPolygon(5, 12345) },
    { name: 'bowtie-self-touching', path: [pt(0, 0), pt(10, 10), pt(10, 0), pt(0, 10)] },
    {
      name: 'ccw-square-large-safe-fast-path',
      path: ccwSquare(1000, 20_000_000, 20_000_000)
    },
    {
      name: 'ccw-square-near-safe-area-product-boundary',
      path: ccwSquare(2, InternalClipper.maxCoordForSafeAreaProduct - 2)
    },
    {
      name: 'ccw-square-exceeding-safe-area-product-boundary-bigint-path',
      path: ccwSquare(2, InternalClipper.maxCoordForSafeAreaProduct + 10)
    },
    {
      name: 'ccw-square-near-max-safe-integer',
      path: ccwSquare(2, SAFE_INT - 100)
    },
    {
      name: 'square-exceeding-safe-integer-non-integer-coords',
      path: [pt(1e20, 1e20), pt(1e20 + 1e10, 1e20), pt(1e20 + 1e10, 1e20 + 1e10), pt(1e20, 1e20 + 1e10)]
    },
    { name: 'fractional-triangle', path: [pt(0.1, 0.2), pt(10.5, 0.3), pt(5.25, 10.75)] },
    { name: 'negative-zero-vertex', path: [pt(-0, -0), pt(10, -0), pt(10, 10), pt(-0, 10)] }
  ]
}

// ---------------------------------------------------------------------------
// Scalar / point-triple generators shared across cross/dot-product-family
// functions.
// ---------------------------------------------------------------------------

const SCALARS: number[] = [
  0,
  -0,
  1,
  -1,
  0.5,
  -0.5,
  3.14159,
  -3.14159,
  1000,
  -1000,
  1_000_000,
  -1_000_000,
  InternalClipper.maxCoordForSafeAreaProduct,
  -InternalClipper.maxCoordForSafeAreaProduct,
  94_906_265, // maxDeltaForSafeProduct fast-path boundary (Core.ts:98)
  94_906_266,
  -94_906_265,
  Number.MAX_SAFE_INTEGER,
  -Number.MAX_SAFE_INTEGER,
  Number.MAX_SAFE_INTEGER / 2,
  1e16,
  -1e16,
  1e18,
  1.5e20
]

interface PointTriple {
  readonly pt1: Point64
  readonly pt2: Point64
  readonly pt3: Point64
}

/** Builds point triples by using scalar pairs as edge deltas (pt1 at origin, pt2 = pt1+delta1, pt3 = pt2+delta2), covering the full magnitude-regime matrix relevant to `crossProduct`/`dotProduct`'s fast/slow-path split. */
function buildPointTriples(): PointTriple[] {
  const triples: PointTriple[] = []
  const deltas = SCALARS
  for (const dax of deltas) {
    for (const day of [0, 1, -1]) {
      for (const dbx of [1, -1, 0]) {
        for (const dby of deltas.length > 0 ? [deltas[0]!, deltas[Math.floor(deltas.length / 2)]!] : [0]) {
          const p1 = pt(0, 0)
          const p2 = pt(dax, day)
          const p3 = pt(dax + dbx, day + dby)
          triples.push({ pt1: p1, pt2: p2, pt3: p3 })
        }
      }
    }
  }
  // A handful of explicit geometric-meaning cases.
  triples.push({ pt1: pt(0, 0), pt2: pt(10, 0), pt3: pt(10, 10) }) // left turn
  triples.push({ pt1: pt(10, 10), pt2: pt(10, 0), pt3: pt(0, 0) }) // right turn
  triples.push({ pt1: pt(0, 0), pt2: pt(10, 0), pt3: pt(20, 0) }) // collinear
  triples.push({ pt1: pt(-0, -0), pt2: pt(0, 0), pt3: pt(10, 10) }) // negative-zero start
  return triples
}

// ---------------------------------------------------------------------------
// Vector accumulators.
// ---------------------------------------------------------------------------

const out: Record<string, unknown[]> = {}
function push(group: string, vector: unknown): void {
  ;(out[group] ??= []).push(vector)
}

// --- area / isPositive --------------------------------------------------

for (const { name, path } of pathFixtures()) {
  push('area', { name, path: encodePath(path), expected: encodeF64(area(path)) })
  push('isPositive', { name, path: encodePath(path), expected: isPositive(path) })
}

// --- crossProduct / crossProductSign / dotProduct / dotProductSign -------

for (const { pt1, pt2, pt3 } of buildPointTriples()) {
  push('crossProduct', {
    pt1: encodePoint(pt1),
    pt2: encodePoint(pt2),
    pt3: encodePoint(pt3),
    expected: encodeF64(InternalClipper.crossProduct(pt1, pt2, pt3))
  })
  push('crossProductSign', {
    pt1: encodePoint(pt1),
    pt2: encodePoint(pt2),
    pt3: encodePoint(pt3),
    expected: InternalClipper.crossProductSign(pt1, pt2, pt3)
  })
  push('dotProduct', {
    pt1: encodePoint(pt1),
    pt2: encodePoint(pt2),
    pt3: encodePoint(pt3),
    expected: encodeF64(InternalClipper.dotProduct(pt1, pt2, pt3))
  })
  push('dotProductSign', {
    pt1: encodePoint(pt1),
    pt2: encodePoint(pt2),
    pt3: encodePoint(pt3),
    expected: InternalClipper.dotProductSign(pt1, pt2, pt3)
  })
  push('isCollinear', {
    pt1: encodePoint(pt1),
    sharedPt: encodePoint(pt2),
    pt2b: encodePoint(pt3),
    expected: InternalClipper.isCollinear(pt1, pt2, pt3)
  })
}

// --- productsAreEqual (direct a,b,c,d matrix over SCALARS) ---------------

{
  const abcdSeeds: [number, number, number, number][] = []
  const rnd = mulberry32(0xc11ff321)
  for (let i = 0; i < 150; i += 1) {
    const pick = (): number => SCALARS[Math.floor(rnd() * SCALARS.length)]!
    abcdSeeds.push([pick(), pick(), pick(), pick()])
  }
  // Explicit equal-product pairs (a*b === c*d) to exercise the true branch broadly.
  abcdSeeds.push([2, 6, 3, 4], [-2, 6, 3, -4], [0, 5, 3, 0], [7, 0, 0, 9])
  for (const [a, b, c, d] of abcdSeeds) {
    push('productsAreEqual', {
      a: encodeF64(a),
      b: encodeF64(b),
      c: encodeF64(c),
      d: encodeF64(d),
      expected: InternalClipper.productsAreEqual(a, b, c, d)
    })
  }
}

// --- roundToEven / checkCastInt64 / triSign / isAlmostZero ---------------

const ROUND_INPUTS: number[] = [
  0,
  -0,
  0.5,
  -0.5,
  1.5,
  -1.5,
  2.5,
  -2.5,
  3.5,
  -3.5,
  0.4999999999999,
  0.5000000000001,
  -0.4999999999999,
  -0.5000000000001,
  100.5,
  -100.5,
  1234567.5,
  NaN,
  Infinity,
  -Infinity,
  Number.MAX_SAFE_INTEGER,
  -Number.MAX_SAFE_INTEGER,
  InternalClipper.MaxCoord,
  -InternalClipper.MaxCoord,
  InternalClipper.MaxCoord - 1,
  InternalClipper.MaxCoord + 1,
  1e300,
  -1e300
]

for (const value of ROUND_INPUTS) {
  push('roundToEven', { input: encodeF64(value), expected: encodeF64(InternalClipper.roundToEven(value)) })
  push('checkCastInt64', { input: encodeF64(value), expected: encodeF64(InternalClipper.checkCastInt64(value)) })
  push('triSign', { input: encodeF64(value), expected: InternalClipper.triSign(value) })
  push('isAlmostZero', { input: encodeF64(value), expected: InternalClipper.isAlmostZero(value) })
}
for (const value of [1e-13, -1e-13, 1e-12, -1e-12, 1e-11, -1e-11, 0.000000000001]) {
  push('isAlmostZero', { input: encodeF64(value), expected: InternalClipper.isAlmostZero(value) })
}

// --- getBounds / Rect64Utils ---------------------------------------------

for (const { name, path } of pathFixtures()) {
  push('getBounds', { name, path: encodePath(path), expected: encodeRect(InternalClipper.getBounds(path)) })
}

interface RectFixture {
  readonly name: string
  readonly rect: Rect64
}
const RECT_FIXTURES: RectFixture[] = [
  { name: 'unit', rect: { left: 0, top: 0, right: 10, bottom: 10 } },
  { name: 'negative-origin', rect: { left: -100, top: -50, right: 100, bottom: 50 } },
  { name: 'empty-zero-width', rect: { left: 5, top: 0, right: 5, bottom: 10 } },
  { name: 'empty-inverted', rect: { left: 10, top: 10, right: 0, bottom: 0 } },
  { name: 'invalid-sentinel', rect: Rect64Utils.createInvalid() },
  {
    name: 'huge-triggers-bigint-midpoint',
    rect: { left: -Number.MAX_SAFE_INTEGER, top: -Number.MAX_SAFE_INTEGER + 1, right: Number.MAX_SAFE_INTEGER, bottom: Number.MAX_SAFE_INTEGER - 1 }
  },
  { name: 'point-rect', rect: { left: 3, top: 3, right: 3, bottom: 3 } }
]
const RECT_PAIRS: [RectFixture, RectFixture][] = []
for (const a of RECT_FIXTURES) for (const b of RECT_FIXTURES) RECT_PAIRS.push([a, b])

for (const { name, rect } of RECT_FIXTURES) {
  push('rectScalar', {
    name,
    rect: encodeRect(rect),
    width: encodeF64(Rect64Utils.width(rect)),
    height: encodeF64(Rect64Utils.height(rect)),
    isEmpty: Rect64Utils.isEmpty(rect),
    isValid: Rect64Utils.isValid(rect),
    midPoint: encodePoint(Rect64Utils.midPoint(rect)),
    asPath: encodePath(Rect64Utils.asPath(rect))
  })
  push('rectContains', {
    name,
    rect: encodeRect(rect),
    pt: encodePoint(pt(1, 1)),
    expected: Rect64Utils.contains(rect, pt(1, 1))
  })
}
for (const [a, b] of RECT_PAIRS) {
  push('rectContainsRect', {
    name: `${a.name}__${b.name}`,
    rect: encodeRect(a.rect),
    rec: encodeRect(b.rect),
    expected: Rect64Utils.containsRect(a.rect, b.rect)
  })
  push('rectIntersects', {
    name: `${a.name}__${b.name}`,
    rect: encodeRect(a.rect),
    rec: encodeRect(b.rect),
    expected: Rect64Utils.intersects(a.rect, b.rect)
  })
}

// --- Point64Utils: create / scale / add / subtract / equals / toString ---

const CREATE_INPUTS: [number, number][] = [
  [0.5, 1.5],
  [-0.5, -1.5],
  [1.4999999999, 1.5000000001],
  [2.5, -2.5],
  [1234.5, -1234.5],
  [0, -0],
  [InternalClipper.MaxCoord, -InternalClipper.MaxCoord],
  [1e15 + 0.5, -1e15 - 0.5]
]
for (const [x, y] of CREATE_INPUTS) {
  push('point64Create', { x: encodeF64(x), y: encodeF64(y), expected: encodePoint(Point64Utils.create(x, y, 0)) })
}

const SCALE_FIXTURES: { pt: Point64; scale: number }[] = [
  { pt: pt(1, 1), scale: 1000 },
  { pt: pt(-1, -1), scale: 1000 },
  { pt: pt(1.5, 2.5), scale: 1 },
  { pt: pt(3, 5), scale: 0.001 },
  { pt: pt(1000, -2000), scale: -1.5 },
  { pt: pt(123456, 654321), scale: 1e6 },
  { pt: pt(0, 0), scale: 0 },
  { pt: pt(-0, 3), scale: 1000 }
]
for (const { pt: p, scale } of SCALE_FIXTURES) {
  push('point64Scale', { pt: encodePoint(p), scale: encodeF64(scale), expected: encodePoint(Point64Utils.scale(p, scale)) })
}

const ADD_SUB_PAIRS: [Point64, Point64][] = [
  [pt(1, 2), pt(3, 4)],
  [pt(-1, -2), pt(3, 4)],
  [pt(SAFE_INT - 1, SAFE_INT - 1), pt(1, 1)],
  [pt(SAFE_INT, SAFE_INT), pt(SAFE_INT, SAFE_INT)],
  [pt(-SAFE_INT, -SAFE_INT), pt(-SAFE_INT, -SAFE_INT)],
  [pt(0, 0), pt(-0, -0)],
  [pt(1.5, 2.5), pt(0.5, 0.5)]
]
for (const [a, b] of ADD_SUB_PAIRS) {
  push('point64Add', { a: encodePoint(a), b: encodePoint(b), expected: encodePoint(Point64Utils.add(a, b)) })
  push('point64Subtract', { a: encodePoint(a), b: encodePoint(b), expected: encodePoint(Point64Utils.subtract(a, b)) })
  push('point64Equals', { a: encodePoint(a), b: encodePoint(b), expected: Point64Utils.equals(a, b) })
}
push('point64Equals', { a: encodePoint(pt(5, 5)), b: encodePoint(pt(5, 5)), expected: Point64Utils.equals(pt(5, 5), pt(5, 5)) })

const TO_STRING_FIXTURES: Point64[] = [pt(1, 2), pt(-1, -2, 3), pt(0, 0), pt(-0, -0), pt(1.5, -2.75, 0), pt(1e20, -1e20, 5)]
for (const p of TO_STRING_FIXTURES) {
  push('point64ToString', { pt: encodePoint(p), expected: Point64Utils.toString(p) })
}

// --- getClosestPtOnSegment ------------------------------------------------

const CLOSEST_PT_FIXTURES: { off: Point64; seg1: Point64; seg2: Point64 }[] = [
  { off: pt(5, 5), seg1: pt(0, 0), seg2: pt(10, 0) },
  { off: pt(-5, 5), seg1: pt(0, 0), seg2: pt(10, 0) },
  { off: pt(15, 5), seg1: pt(0, 0), seg2: pt(10, 0) },
  { off: pt(5, 5), seg1: pt(3, 3), seg2: pt(3, 3) }, // degenerate segment
  { off: pt(0, 0), seg1: pt(-10, -10), seg2: pt(10, 10) },
  { off: pt(1000000, -1000000), seg1: pt(0, 0), seg2: pt(2000000, 0) }
]
for (const { off, seg1, seg2 } of CLOSEST_PT_FIXTURES) {
  push('getClosestPtOnSegment', {
    off: encodePoint(off),
    seg1: encodePoint(seg1),
    seg2: encodePoint(seg2),
    expected: encodePoint(InternalClipper.getClosestPtOnSegment(off, seg1, seg2))
  })
}

// --- pointInPolygon / path2ContainsPath1 ----------------------------------

const POLY_FIXTURES: Path64[] = [ccwSquare(10), cwSquare(10), lShape(), regularPolygon(6, 1000), ccwTriangle(5)]
const TEST_POINTS: Point64[] = [
  pt(5, 5),
  pt(0, 0),
  pt(10, 10),
  pt(10, 5),
  pt(-5, -5),
  pt(15, 15),
  pt(5, 0),
  pt(0, 5),
  pt(15, 5),
  pt(5, 15)
]
for (const poly of POLY_FIXTURES) {
  for (const p of TEST_POINTS) {
    push('pointInPolygon', { poly: encodePath(poly), pt: encodePoint(p), expected: InternalClipper.pointInPolygon(p, poly) })
  }
}

const CONTAINS_PAIRS: [Path64, Path64][] = [
  [ccwSquare(10, 2, 2), ccwSquare(100)],
  [ccwSquare(100), ccwSquare(10, 2, 2)],
  [ccwSquare(10, 200, 200), ccwSquare(100)],
  [lShape(), ccwSquare(5, 12, 12)],
  [ccwTriangle(2), ccwSquare(100)]
]
for (const [path1, path2] of CONTAINS_PAIRS) {
  push('path2ContainsPath1', {
    path1: encodePath(path1),
    path2: encodePath(path2),
    expected: InternalClipper.path2ContainsPath1(path1, path2)
  })
}

// --- segsIntersect ---------------------------------------------------------

interface SegPairFixture {
  readonly seg1a: Point64
  readonly seg1b: Point64
  readonly seg2a: Point64
  readonly seg2b: Point64
}
const SEG_PAIRS: SegPairFixture[] = [
  { seg1a: pt(0, 0), seg1b: pt(10, 10), seg2a: pt(0, 10), seg2b: pt(10, 0) }, // crossing
  { seg1a: pt(0, 0), seg1b: pt(10, 0), seg2a: pt(0, 5), seg2b: pt(10, 5) }, // parallel, no cross
  { seg1a: pt(0, 0), seg1b: pt(10, 0), seg2a: pt(10, 0), seg2b: pt(20, 0) }, // collinear touching endpoint
  { seg1a: pt(0, 0), seg1b: pt(10, 0), seg2a: pt(5, 0), seg2b: pt(5, 10) }, // T-touch
  { seg1a: pt(0, 0), seg1b: pt(5, 5), seg2a: pt(5, 5), seg2b: pt(10, 0) }, // shared endpoint
  { seg1a: pt(-10, -10), seg1b: pt(10, 10), seg2a: pt(-10, 10), seg2b: pt(10, -10) } // crossing through origin
]
for (const { seg1a, seg1b, seg2a, seg2b } of SEG_PAIRS) {
  for (const inclusive of [false, true]) {
    push('segsIntersect', {
      seg1a: encodePoint(seg1a),
      seg1b: encodePoint(seg1b),
      seg2a: encodePoint(seg2a),
      seg2b: encodePoint(seg2b),
      inclusive,
      expected: InternalClipper.segsIntersect(seg1a, seg1b, seg2a, seg2b, inclusive)
    })
  }
}

// --- getLineIntersectPt -----------------------------------------------------

for (const { seg1a, seg1b, seg2a, seg2b } of SEG_PAIRS) {
  const result = InternalClipper.getLineIntersectPt(seg1a, seg1b, seg2a, seg2b)
  push('getLineIntersectPt', {
    ln1a: encodePoint(seg1a),
    ln1b: encodePoint(seg1b),
    ln2a: encodePoint(seg2a),
    ln2b: encodePoint(seg2b),
    expected: result === null ? null : encodePoint(result)
  })
}
// Extra: near-parallel / clamped-t cases.
const EXTRA_LINE_FIXTURES: SegPairFixture[] = [
  { seg1a: pt(0, 0), seg1b: pt(1, 0), seg2a: pt(5, -5), seg2b: pt(5, 5) }, // t >= 1 clamp
  { seg1a: pt(0, 0), seg1b: pt(10, 0), seg2a: pt(-5, -5), seg2b: pt(-5, 5) } // t <= 0 clamp
]
for (const { seg1a, seg1b, seg2a, seg2b } of EXTRA_LINE_FIXTURES) {
  const result = InternalClipper.getLineIntersectPt(seg1a, seg1b, seg2a, seg2b)
  push('getLineIntersectPt', {
    ln1a: encodePoint(seg1a),
    ln1b: encodePoint(seg1b),
    ln2a: encodePoint(seg2a),
    ln2b: encodePoint(seg2b),
    expected: result === null ? null : encodePoint(result)
  })
}

// --- multiplyUInt64 ---------------------------------------------------------

const MULTIPLY_PAIRS: [number, number][] = [
  [0, 0],
  [1, 1],
  [2 ** 32, 2],
  [2 ** 32, 2 ** 20],
  [Number.MAX_SAFE_INTEGER, 2],
  [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
  [0, Number.MAX_SAFE_INTEGER],
  [12345, 6789],
  [-1, 5],
  [-12345, -6789]
]
for (const [a, b] of MULTIPLY_PAIRS) {
  const result = InternalClipper.multiplyUInt64(a, b)
  push('multiplyUInt64', {
    a: encodeF64(a),
    b: encodeF64(b),
    expectedLo: encodeBigInt(result.lo64),
    expectedHi: encodeBigInt(result.hi64)
  })
}

// ---------------------------------------------------------------------------
// Offset.ts static utility functions (no engine needed).
// ---------------------------------------------------------------------------

const NORMAL_EDGES: [Point64, Point64][] = [
  [pt(0, 0), pt(10, 0)],
  [pt(0, 0), pt(0, 10)],
  [pt(0, 0), pt(10, 10)],
  [pt(5, 5), pt(5, 5)], // degenerate
  [pt(0, 0), pt(-10, -10)],
  [pt(1_000_000, -1_000_000), pt(-1_000_000, 1_000_000)]
]
for (const [p1, p2] of NORMAL_EDGES) {
  push('offsetGetUnitNormal', { pt1: encodePoint(p1), pt2: encodePoint(p2), expected: encodePoint(ClipperOffset.getUnitNormal(p1, p2)) })
}

const LOWEST_PATH_FIXTURES: { name: string; paths: Paths64 }[] = [
  { name: 'single-ccw-square', paths: [ccwSquare(10)] },
  { name: 'single-cw-square', paths: [cwSquare(10)] },
  { name: 'two-squares', paths: [ccwSquare(10, 100, 100), ccwSquare(10, 0, 0)] },
  { name: 'empty', paths: [] },
  { name: 'degenerate-zero-area', paths: [[pt(0, 0), pt(10, 0), pt(20, 0)]] },
  { name: 'l-shape-plus-square', paths: [lShape(), ccwSquare(5, -50, -50)] }
]
for (const { name, paths } of LOWEST_PATH_FIXTURES) {
  const info = ClipperOffset.getLowestPathInfo(paths)
  push('offsetGetLowestPathInfo', { name, paths: encodePaths(paths), expectedIdx: info.idx, expectedIsNegArea: info.isNegArea })
}

const STRIP_DUP_FIXTURES: { path: Path64; isClosed: boolean }[] = [
  { path: [pt(0, 0), pt(0, 0), pt(1, 0), pt(1, 1), pt(0, 0)], isClosed: true },
  { path: [pt(0, 0), pt(0, 0), pt(1, 0), pt(1, 1), pt(0, 0)], isClosed: false },
  { path: [], isClosed: true },
  { path: [pt(5, 5)], isClosed: true },
  { path: ccwSquare(10), isClosed: true },
  { path: [pt(1, 1), pt(1, 1), pt(1, 1)], isClosed: true }
]
for (const { path, isClosed } of STRIP_DUP_FIXTURES) {
  push('offsetStripDuplicates', { path: encodePath(path), isClosed, expected: encodePath(ClipperOffset.stripDuplicates(path, isClosed)) })
}

for (const { name, path } of pathFixtures()) {
  push('offsetArea', { name, path: encodePath(path), expected: encodeF64(ClipperOffset.area(path)) })
}

for (const value of [0, -0, 1, -1, 2.5, -2.5, 1000, -1000, 1e10, NaN, Infinity]) {
  push('offsetSqr', { input: encodeF64(value), expected: encodeF64(ClipperOffset.sqr(value)) })
}

const ELLIPSE_FIXTURES: { center: Point64; radiusX: number; radiusY: number; steps: number }[] = [
  { center: pt(0, 0), radiusX: 0, radiusY: 0, steps: 0 },
  { center: pt(0, 0), radiusX: 100, radiusY: 0, steps: 0 },
  { center: pt(0, 0), radiusX: 100, radiusY: 50, steps: 0 },
  { center: pt(100, 200), radiusX: 100, radiusY: 100, steps: 8 },
  { center: pt(0, 0), radiusX: 1000, radiusY: 1000, steps: 36 },
  { center: pt(-500, -500), radiusX: 250, radiusY: 750, steps: 12 }
]
for (const { center, radiusX, radiusY, steps } of ELLIPSE_FIXTURES) {
  push('offsetEllipse', {
    center: encodePoint(center),
    radiusX: encodeF64(radiusX),
    radiusY: encodeF64(radiusY),
    steps,
    expected: encodePath(ClipperOffset.ellipse(center, radiusX, radiusY, steps))
  })
}

// ---------------------------------------------------------------------------
// ClipperOffset per-group offset pipeline, pre-cleanup (no engine needed).
//
// Mirrors `ClipperOffset.executeInternal`'s pre-cleanup steps exactly
// (Offset.ts:166-186, up to but excluding the `Clipper64` union): this is a
// thin harness, not a reimplementation of the tested logic — `doGroupOffset`
// itself (and everything it calls: `buildNormals`, `offsetPolygon` /
// `offsetOpenPath` / `offsetOpenJoined`, `offsetPoint`, `doMiter`/`doSquare`/
// `doBevel`/`doRound`) is the real `clipper2-ts` private implementation,
// reached via a TypeScript privacy-erasing cast since `private` is
// compile-time-only in TS (the compiled runtime object has no encapsulation).
// ---------------------------------------------------------------------------

function preCleanupSolution(offset: ClipperOffset, delta: number): Paths64 {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyOffset = offset as any
  anyOffset.solution = []
  if (anyOffset.groupList.length === 0) return anyOffset.solution as Paths64
  if (Math.abs(delta) < 0.5) {
    for (const group of anyOffset.groupList) {
      for (const path of group.inPaths) {
        anyOffset.solution.push(path)
      }
    }
    return anyOffset.solution as Paths64
  }
  anyOffset.delta = delta
  anyOffset.mitLimSqr = anyOffset.miterLimit <= 1 ? 2.0 : 2.0 / ClipperOffset.sqr(anyOffset.miterLimit)
  for (const group of anyOffset.groupList) {
    anyOffset.doGroupOffset(group)
  }
  return anyOffset.solution as Paths64
}

interface OffsetPipelineFixture {
  readonly name: string
  readonly paths: Paths64
  readonly joinType: JoinType
  readonly endType: EndType
  readonly deltas: number[]
  readonly miterLimit?: number
}

const JOIN_TYPE_NAMES: Record<JoinType, string> = {
  [JoinType.Miter]: 'Miter',
  [JoinType.Square]: 'Square',
  [JoinType.Bevel]: 'Bevel',
  [JoinType.Round]: 'Round'
}
const END_TYPE_NAMES: Record<EndType, string> = {
  [EndType.Polygon]: 'Polygon',
  [EndType.Joined]: 'Joined',
  [EndType.Butt]: 'Butt',
  [EndType.Square]: 'Square',
  [EndType.Round]: 'Round'
}

const OFFSET_PIPELINE_FIXTURES: OffsetPipelineFixture[] = [
  // Production combination (Miter + Polygon) is the priority: several convex
  // shapes at several offsets, both inflate and shrink.
  { name: 'square-miter-polygon', paths: [ccwSquare(100)], joinType: JoinType.Miter, endType: EndType.Polygon, deltas: [1, 2, 5, 10, 50, 100, 1000, -1, -5, -10, -40, 0.6, 0.4, -0.4] },
  { name: 'square-cw-miter-polygon', paths: [cwSquare(100)], joinType: JoinType.Miter, endType: EndType.Polygon, deltas: [10, -10] },
  { name: 'rect-miter-polygon', paths: [[pt(0, 0), pt(200, 0), pt(200, 50), pt(0, 50)]], joinType: JoinType.Miter, endType: EndType.Polygon, deltas: [5, 10, 20, -5, -10] },
  { name: 'hexagon-miter-polygon', paths: [regularPolygon(6, 1000)], joinType: JoinType.Miter, endType: EndType.Polygon, deltas: [10, 100, -50] },
  { name: 'triangle-miter-polygon-acute', paths: [[pt(0, 0), pt(100, 0), pt(50, 5)]], joinType: JoinType.Miter, endType: EndType.Polygon, deltas: [1, 2, 5] }, // very acute apex forces miter-limit -> doSquare fallback
  { name: 'l-shape-miter-polygon', paths: [lShape()], joinType: JoinType.Miter, endType: EndType.Polygon, deltas: [1, 2, -1] }, // concave corners exercise the concave-join branch
  { name: 'two-squares-miter-polygon', paths: [ccwSquare(50), ccwSquare(20, 200, 200)], joinType: JoinType.Miter, endType: EndType.Polygon, deltas: [5, -2] },
  { name: 'square-miter-polygon-low-miter-limit', paths: [[pt(0, 0), pt(100, 0), pt(50, 5)]], joinType: JoinType.Miter, endType: EndType.Polygon, deltas: [2], miterLimit: 1.0 },
  { name: 'square-miter-polygon-high-miter-limit', paths: [[pt(0, 0), pt(100, 0), pt(50, 5)]], joinType: JoinType.Miter, endType: EndType.Polygon, deltas: [2], miterLimit: 10.0 },
  { name: 'two-point-polygon', paths: [[pt(0, 0), pt(100, 0)]], joinType: JoinType.Miter, endType: EndType.Polygon, deltas: [10] },
  // Other join/end-type combinations, for full mechanical-translation coverage
  // even though production never reaches them.
  { name: 'square-bevel-polygon', paths: [ccwSquare(100)], joinType: JoinType.Bevel, endType: EndType.Polygon, deltas: [10, -10] },
  { name: 'square-square-polygon', paths: [ccwSquare(100)], joinType: JoinType.Square, endType: EndType.Polygon, deltas: [10, -10] },
  { name: 'square-round-polygon', paths: [ccwSquare(100)], joinType: JoinType.Round, endType: EndType.Polygon, deltas: [10] },
  { name: 'line-butt-open', paths: [[pt(0, 0), pt(100, 0), pt(100, 100)]], joinType: JoinType.Miter, endType: EndType.Butt, deltas: [5, 10] },
  { name: 'line-square-open', paths: [[pt(0, 0), pt(100, 0), pt(100, 100)]], joinType: JoinType.Miter, endType: EndType.Square, deltas: [5, 10] },
  { name: 'line-round-open', paths: [[pt(0, 0), pt(100, 0), pt(100, 100)]], joinType: JoinType.Miter, endType: EndType.Round, deltas: [5, 10] },
  { name: 'line-joined-miter', paths: [[pt(0, 0), pt(100, 0), pt(100, 100)]], joinType: JoinType.Miter, endType: EndType.Joined, deltas: [5] },
  { name: 'two-point-joined-round', paths: [[pt(0, 0), pt(100, 0)]], joinType: JoinType.Round, endType: EndType.Joined, deltas: [10] },
  { name: 'single-point-round', paths: [[pt(50, 50)]], joinType: JoinType.Round, endType: EndType.Round, deltas: [10, 25] },
  { name: 'single-point-butt-square-cap', paths: [[pt(50, 50)]], joinType: JoinType.Miter, endType: EndType.Butt, deltas: [10] }
]

for (const fixture of OFFSET_PIPELINE_FIXTURES) {
  for (const delta of fixture.deltas) {
    const co = new ClipperOffset(fixture.miterLimit ?? 2.0, 0.0, false, false)
    co.addPaths(fixture.paths, fixture.joinType, fixture.endType)
    const solution = preCleanupSolution(co, delta)
    push('offsetPreCleanup', {
      name: fixture.name,
      paths: encodePaths(fixture.paths),
      joinType: JOIN_TYPE_NAMES[fixture.joinType],
      endType: END_TYPE_NAMES[fixture.endType],
      miterLimit: encodeF64(fixture.miterLimit ?? 2.0),
      delta: encodeF64(delta),
      expected: encodePaths(solution)
    })
  }
}

// ---------------------------------------------------------------------------
// Pending: full ClipperOffset.execute() / inflatePaths outputs that require
// the boolean-clip engine's union cleanup. Written to a SEPARATE file for the
// engine agent; NOT asserted by any Rust test in this module today.
// ---------------------------------------------------------------------------

const pendingVectors: unknown[] = []
for (const fixture of OFFSET_PIPELINE_FIXTURES) {
  if (fixture.joinType !== JoinType.Miter || fixture.endType !== EndType.Polygon) continue
  for (const delta of fixture.deltas) {
    if (Math.abs(delta) < 0.5) continue // trivial passthrough is already covered pre-cleanup, no engine needed
    const co = new ClipperOffset(fixture.miterLimit ?? 2.0, 0.0, false, false)
    co.addPaths(fixture.paths, fixture.joinType, fixture.endType)
    const solution: Paths64 = []
    co.execute(delta, solution)
    pendingVectors.push({
      name: fixture.name,
      paths: encodePaths(fixture.paths),
      joinType: JOIN_TYPE_NAMES[fixture.joinType],
      endType: END_TYPE_NAMES[fixture.endType],
      miterLimit: encodeF64(fixture.miterLimit ?? 2.0),
      delta: encodeF64(delta),
      expected: encodePaths(solution)
    })
  }
}

// ---------------------------------------------------------------------------
// Write output.
// ---------------------------------------------------------------------------

const generatingCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()

const totalVectorCount = Object.values(out).reduce((sum, arr) => sum + arr.length, 0)

const output = {
  meta: {
    area: 'clipper-core',
    generatingCommit,
    generatedAt: new Date().toISOString(),
    nodeVersion: process.version,
    clipperVersion: '2.0.1-18',
    totalVectorCount,
    description:
      'Differential vectors for crates/irregular-nesting-native/src/clipper/ (Core.ts + ' +
      'Offset.ts vendor port, ruling R10): area/isPositive/cross/dot-product family, ' +
      'roundToEven/checkCastInt64/triSign/isAlmostZero, Rect64Utils, Point64Utils, ' +
      'getClosestPtOnSegment, pointInPolygon/path2ContainsPath1, segsIntersect, ' +
      'getLineIntersectPt, multiplyUInt64, and the full ClipperOffset per-group offset ' +
      'geometry pipeline pre-boolean-engine-cleanup (offsetPreCleanup, reached via a ' +
      'privacy-erasing cast — see preCleanupSolution in this script).'
  },
  ...out
}

mkdirSync(vectorsDir, { recursive: true })
writeFileSync(outputPath, JSON.stringify(output, null, 2) + '\n', 'utf8')

const pendingOutput = {
  meta: {
    area: 'clipper-offset-pending',
    generatingCommit,
    generatedAt: new Date().toISOString(),
    nodeVersion: process.version,
    clipperVersion: '2.0.1-18',
    vectorCount: pendingVectors.length,
    description:
      'PENDING vectors for the boolean-clip-engine agent: full ClipperOffset.execute() ' +
      '(== inflatePaths) outputs for Miter+Polygon (the only join/end-type combination the ' +
      'production app exercises, per docs/planning/rust-irregular-backend/characterization/' +
      'collision-prep.md) on convex/concave polygons at several offsets. These require the ' +
      'Clipper64 boolean-clip engine self-intersection union cleanup (Offset.ts:192-203), ' +
      'which crates/irregular-nesting-native/src/clipper/offset.rs deliberately stubs as ' +
      'clipper::offset::engine_union_stub (returns a typed NotYetImplemented error, never a ' +
      'panic). NOT asserted by any Rust test today. Once Engine.ts/Clipper64 is ported, wire ' +
      'engine_union_stub to the real union-cleanup implementation and add an integration test ' +
      'in crates/irregular-nesting-native/tests/ that loads this file and asserts ' +
      'ClipperOffset::execute(...) reproduces every `expected` path set exactly (byte-exact ' +
      'vertex sequences including ring order and starting vertex, per stage0-rulings.md R10).'
  },
  vectors: pendingVectors
}
writeFileSync(pendingOutputPath, JSON.stringify(pendingOutput, null, 2) + '\n', 'utf8')

console.log(`Wrote ${totalVectorCount} vectors across ${Object.keys(out).length} groups to ${outputPath}`)
console.log(`Wrote ${pendingVectors.length} pending (engine-dependent) vectors to ${pendingOutputPath}`)
