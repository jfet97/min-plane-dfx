/**
 * Differential-vector dump for `crates/irregular-nesting-native/src/clipper/engine.rs`
 * (the vendor-translated `clipper2-ts@2.0.1-18` boolean-clip engine port —
 * `Engine.ts`'s `Clipper64`/`PolyTree64`, plus the small `Clipper.ts` wrapper
 * surface `booleanOp`/`booleanOpWithPolyTree`/`polyTreeToPaths64` — per ruling
 * R10 in `docs/planning/rust-irregular-backend/stage0-rulings.md`).
 *
 * Imports the REAL `clipper2-ts` package directly (the pinned production
 * dependency, `2.0.1-18`) and evaluates `booleanOp`/`booleanOpWithPolyTree`/
 * `polyTreeToPaths64` over a broad deliberate matrix of:
 *   - operation (Intersection/Union/Difference/Xor) x fill rule (EvenOdd/NonZero)
 *   - convex, concave, multi-ring, holes (nested CCW/CW rings), overlapping,
 *     touching (collinear-edge), point-touching, self-intersecting (bowtie,
 *     pentagram) and degenerate (empty/single-point/zero-area) polygon pairs
 *   - deterministically seeded random convex polygons and star polygons
 *   - the application's exact real usage shapes (Union EvenOdd over many
 *     rects; Difference of a sheet hull vs. a unioned occupied region with
 *     NonZero; Intersection pairs with NonZero; Xor of two unions with
 *     NonZero) — see `src/workers/irregular/canonicalLayoutGeometry.ts`,
 *     `src/workers/algorithm/irregular/intrinsicGapRegions.ts`,
 *     `src/workers/irregular/freeMaterialService.ts`, and
 *     `src/workers/algorithm/irregular/intrinsicQueueBeamDiscriminator.ts`'s
 *     `booleanPaths` helper for the real call shapes this mirrors.
 *
 * Each vector records: the full `booleanOp` (`Paths64`) output, the full
 * `booleanOpWithPolyTree` `PolyTree64` structure (polygon + children,
 * recursively, in child order), and the `polyTreeToPaths64` flattening of
 * that same tree — so the Rust integration test can assert vertex-for-vertex
 * equality (including ring order and starting vertex) against all three
 * surfaces from one oracle run.
 *
 * Run with:
 *   pnpm exec tsx --tsconfig tsconfig.node.json scripts/rust-parity/dump-clipper-engine.ts
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Path64, Paths64, Point64, PolyPath64 } from 'clipper2-ts'
import { ClipType, FillRule, PolyTree64, booleanOp, booleanOpWithPolyTree, polyTreeToPaths64 } from 'clipper2-ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..', '..')
const vectorsDir = join(repoRoot, 'crates/irregular-nesting-native/tests/vectors')
const outputPath = join(vectorsDir, 'clipper-engine.json')

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32 — same generator already used by
// `dump-canonical-grid.ts`/`dump-clipper-core.ts`, kept identical for
// repo-wide consistency; no `Math.random` anywhere so the vector file is
// stable across regenerations).
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
// JSON-safe f64 encoding (same convention as `dump-clipper-core.ts`).
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

function encodePoint(p: Point64): EncodedPoint {
  return { x: encodeF64(p.x), y: encodeF64(p.y), z: encodeF64(p.z ?? 0) }
}

function encodePath(path: ReadonlyArray<Point64>): EncodedPoint[] {
  return path.map(encodePoint)
}

function encodePaths(paths: ReadonlyArray<ReadonlyArray<Point64>>): EncodedPoint[][] {
  return paths.map(encodePath)
}

interface EncodedPolyTreeNode {
  readonly polygon: EncodedPoint[] | null
  readonly children: EncodedPolyTreeNode[]
}

function encodePolyTreeNode(node: PolyPath64): EncodedPolyTreeNode {
  const children: EncodedPolyTreeNode[] = []
  for (let i = 0; i < node.count; i += 1) {
    children.push(encodePolyTreeNode(node.child(i)))
  }
  const poly = node.poly
  return { polygon: poly ? encodePath(poly) : null, children }
}

// ---------------------------------------------------------------------------
// Point/path builders.
// ---------------------------------------------------------------------------

function pt(x: number, y: number): Point64 {
  return { x, y, z: 0 }
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

function rect(x0: number, y0: number, x1: number, y1: number): Path64 {
  return [pt(x0, y0), pt(x1, y0), pt(x1, y1), pt(x0, y1)]
}

function lShape(originX = 0, originY = 0): Path64 {
  return [
    pt(originX + 0, originY + 0),
    pt(originX + 20, originY + 0),
    pt(originX + 20, originY + 10),
    pt(originX + 10, originY + 10),
    pt(originX + 10, originY + 20),
    pt(originX + 0, originY + 20)
  ]
}

function regularPolygon(sides: number, radius: number, cx = 0, cy = 0): Path64 {
  const result: Path64 = []
  for (let i = 0; i < sides; i += 1) {
    const angle = (2 * Math.PI * i) / sides
    result.push(pt(Math.round(cx + radius * Math.cos(angle)), Math.round(cy + radius * Math.sin(angle))))
  }
  return result
}

/** Classic self-touching bowtie quad. */
function bowtie(originX = 0, originY = 0, scale = 10): Path64 {
  return [
    pt(originX, originY),
    pt(originX + scale, originY + scale),
    pt(originX + scale, originY),
    pt(originX, originY + scale)
  ]
}

/**
 * Pentagram: 5 points evenly spaced around a circle, connected in
 * skip-one order (0,2,4,1,3) so the path self-intersects — the classic
 * even-odd-vs-nonzero fill-rule differential case.
 */
function pentagram(radius: number, cx = 0, cy = 0): Path64 {
  const outer: Point64[] = []
  for (let i = 0; i < 5; i += 1) {
    const angle = (2 * Math.PI * i) / 5 - Math.PI / 2
    outer.push(pt(Math.round(cx + radius * Math.cos(angle)), Math.round(cy + radius * Math.sin(angle))))
  }
  return [0, 2, 4, 1, 3].map((i) => outer[i]!)
}

/** Simple Andrew monotone-chain convex hull over integer points (CCW, no collinear dupes trimmed beyond the algorithm itself). */
function convexHull(points: Point64[]): Path64 {
  const pts = [...points].sort((a, b) => (a.x !== b.x ? a.x - b.x : a.y - b.y))
  const cross = (o: Point64, a: Point64, b: Point64): number => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
  const lower: Point64[] = []
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) lower.pop()
    lower.push(p)
  }
  const upper: Point64[] = []
  for (let i = pts.length - 1; i >= 0; i -= 1) {
    const p = pts[i]!
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) upper.pop()
    upper.push(p)
  }
  lower.pop()
  upper.pop()
  return [...lower, ...upper]
}

function randomConvexPolygon(rng: () => number, count: number, cx: number, cy: number, radius: number): Path64 {
  const points: Point64[] = []
  for (let i = 0; i < count; i += 1) {
    const angle = rng() * 2 * Math.PI
    const r = radius * (0.4 + 0.6 * rng())
    points.push(pt(Math.round(cx + r * Math.cos(angle)), Math.round(cy + r * Math.sin(angle))))
  }
  const hull = convexHull(points)
  return hull.length >= 3 ? hull : ccwSquare(radius, cx, cy)
}

// ---------------------------------------------------------------------------
// Scenario matrix: each scenario is a (subject, clip) pair of Paths64. `clip`
// is `null` for single-argument operations (mirrors the app's
// `booleanOpWithPolyTree(ClipType.Union, paths, null, tree, fillRule)` shape).
// ---------------------------------------------------------------------------

interface Scenario {
  readonly name: string
  readonly subject: Paths64
  readonly clip: Paths64 | null
}

function buildScenarios(): Scenario[] {
  const scenarios: Scenario[] = []
  const push = (name: string, subject: Paths64, clip: Paths64 | null): void => {
    scenarios.push({ name, subject, clip })
  }

  // --- convex vs convex --------------------------------------------------
  push('overlap-squares-partial', [ccwSquare(100)], [ccwSquare(100, 50, 50)])
  push('disjoint-squares', [ccwSquare(50)], [ccwSquare(50, 1000, 1000)])
  push('touching-squares-shared-edge-same-length', [rect(0, 0, 100, 100)], [rect(100, 0, 200, 100)])
  push('touching-squares-shared-edge-different-length', [rect(0, 0, 100, 100)], [rect(100, 20, 200, 80)])
  push('nested-square-fully-inside', [ccwSquare(200)], [ccwSquare(50, 75, 75)])
  push('identical-squares', [ccwSquare(100)], [ccwSquare(100)])
  push('opposite-orientation-duplicate', [ccwSquare(100)], [cwSquare(100)])
  push('corner-touching-squares', [rect(0, 0, 100, 100)], [rect(100, 100, 200, 200)])
  push('t-junction-touch', [rect(0, 0, 100, 100)], [rect(50, 100, 60, 200)])
  push('overlap-hexagons', [regularPolygon(6, 1000)], [regularPolygon(6, 1000, 800, 0)])
  push('overlap-many-sided-polygons', [regularPolygon(16, 500)], [regularPolygon(16, 500, 400, 300)])
  push('triangle-overlap-square', [[pt(0, 0), pt(100, 0), pt(50, 100)]], [ccwSquare(60, 20, 20)])
  push('diamond-overlap-square', [[pt(50, 0), pt(100, 50), pt(50, 100), pt(0, 50)]], [ccwSquare(60, 20, 20)])
  push('collinear-diagonal-edge-triangles', [[pt(0, 0), pt(100, 100), pt(100, 0)]], [[pt(0, 0), pt(0, 100), pt(100, 100)]])

  // --- concave vs {convex, concave} --------------------------------------
  push('l-shape-overlap-square', [lShape()], [ccwSquare(15, 5, 5)])
  push('l-shape-overlap-square-in-notch', [lShape()], [ccwSquare(8, 11, 11)])
  push('l-shape-vs-mirrored-l-shape', [lShape()], [[...lShape(5, 5)].reverse()])
  push('l-shape-vs-l-shape-offset', [lShape()], [lShape(10, 10)])
  push('c-shape-filled-by-rect', [[pt(0, 0), pt(30, 0), pt(30, 10), pt(10, 10), pt(10, 20), pt(30, 20), pt(30, 30), pt(0, 30)]], [rect(10, 10, 30, 20)])

  // --- multi-ring (several separate rings per side) -----------------------
  push('multi-ring-subject-vs-single-clip', [ccwSquare(30, 0, 0), ccwSquare(30, 200, 0)], [ccwSquare(30, 15, 15)])
  push('multi-ring-both-sides', [ccwSquare(30, 0, 0), ccwSquare(30, 200, 0)], [ccwSquare(30, 15, 15), ccwSquare(30, 215, 15)])
  push(
    'multi-ring-three-rects-forming-l-union-vs-square',
    [rect(0, 0, 100, 30), rect(0, 30, 30, 100), rect(0, 0, 30, 30)],
    [ccwSquare(20, 40, 40)]
  )
  push(
    'multi-ring-disjoint-triple-subject',
    [ccwSquare(20, 0, 0), ccwSquare(20, 100, 0), ccwSquare(20, 200, 0)],
    [ccwSquare(300, -10, -10)]
  )

  // --- holes (outer CCW ring + inner CW ring in the same path set) --------
  push('square-with-hole-vs-crossing-square', [ccwSquare(200), cwSquare(50, 75, 75)], [ccwSquare(60, 50, 90)])
  push('square-with-hole-vs-square-inside-hole', [ccwSquare(200), cwSquare(50, 75, 75)], [ccwSquare(20, 90, 90)])
  push('square-with-hole-vs-hole-shaped-clip', [ccwSquare(200), cwSquare(50, 75, 75)], [ccwSquare(50, 75, 75)])
  push('square-with-hole-vs-outer-shaped-clip', [ccwSquare(200), cwSquare(50, 75, 75)], [ccwSquare(200)])
  push('nested-square-with-hole-no-clip', [ccwSquare(200), cwSquare(50, 75, 75)], null)

  // --- collinear-edge join stress (adjacent rects forming a bigger rect) --
  push('two-adjacent-rects-form-bigger-rect', [rect(0, 0, 50, 100)], [rect(50, 0, 100, 100)])
  push('three-adjacent-rects-form-bigger-rect', [rect(0, 0, 50, 100), rect(50, 0, 100, 100)], [rect(100, 0, 150, 100)])
  push('collinear-top-edges-partial-vertical-overlap', [rect(0, 50, 100, 100)], [rect(50, 0, 150, 100)])
  push('collinear-edges-both-directions', [rect(0, 0, 100, 50), rect(0, 50, 100, 100)], [rect(0, 25, 100, 75)])

  // --- self-intersecting seeded polygons -----------------------------------
  push('bowtie-vs-square', [bowtie(0, 0, 20)], [ccwSquare(15, 5, 5)])
  push('bowtie-self-union-no-clip', [bowtie(0, 0, 20)], null)
  push('pentagram-no-clip', [pentagram(1000)], null)
  push('pentagram-vs-square', [pentagram(1000)], [ccwSquare(600, -300, -300)])
  push('two-overlapping-pentagrams', [pentagram(1000)], [pentagram(1000, 500, 200)])
  push('bowtie-vs-bowtie', [bowtie(0, 0, 20)], [bowtie(10, 0, 20)])

  // --- degenerate ------------------------------------------------------------
  push('empty-subject-empty-clip', [], [])
  push('empty-subject-nonempty-clip', [], [ccwSquare(10)])
  push('nonempty-subject-empty-clip-array', [ccwSquare(10)], [])
  push('subject-null-clip', [ccwSquare(10)], null)
  push('single-point-subject', [[pt(5, 5)]], [ccwSquare(10)])
  push('two-point-degenerate-subject', [[pt(0, 0), pt(10, 10)]], [ccwSquare(10)])
  push('zero-area-collinear-subject', [[pt(0, 0), pt(5, 0), pt(10, 0)]], [ccwSquare(10)])
  push('zero-side-square-subject', [ccwSquare(0)], [ccwSquare(10)])

  // --- seeded random convex polygons (broad coverage of general geometry) --
  {
    const rng = mulberry32(0xc0ffee01)
    for (let i = 0; i < 10; i += 1) {
      const a = randomConvexPolygon(rng, 5 + (i % 5), 0, 0, 200 + i * 37)
      const b = randomConvexPolygon(rng, 5 + ((i + 2) % 5), 50 + i * 20, 30 + i * 10, 180 + i * 29)
      push(`random-convex-pair-${i}`, [a], [b])
    }
  }

  // --- negative-zero vertices ------------------------------------------------
  // `-0`/`0` compare equal under every `===`/`</`>` comparison this engine
  // uses (JS, matching Rust `f64`), so these are not expected to change any
  // *result*, but they do exercise the `InternalClipper.isCollinear`/
  // `crossProductSign`/`Point64Utils.equals` call sites in the engine's hot
  // path (vertex insertion, AEL ordering, join checks) with a `pt.x`/`pt.y`
  // actually holding a negative-zero bit pattern, per the migration prompt's
  // "signed zero" risk category. See `dump-clipper-core.ts`'s
  // `negative-zero-vertex` fixture for the equivalent Core.ts/Offset.ts-level
  // coverage; this is the engine-level (boolean-clip) counterpart.
  push('negative-zero-square-vs-square', [[pt(-0, -0), pt(10, -0), pt(10, 10), pt(-0, 10)]], [ccwSquare(10, 5, 5)])
  push(
    'negative-zero-touching-collinear-edge',
    [[pt(-0, -0), pt(100, -0), pt(100, 100), pt(-0, 100)]],
    [[pt(100, -0), pt(200, -0), pt(200, 100), pt(100, 100)]]
  )
  push('negative-zero-bowtie-self-union-no-clip', [[pt(-0, -0), pt(20, 20), pt(20, -0), pt(-0, 20)]], null)

  // --- large coordinates straddling InternalClipper.maxCoordForSafeCrossSq --
  // (`Math.floor(Math.sqrt(Math.sqrt(Number.MAX_SAFE_INTEGER / 4)))` == 6888)
  // used by `perpendicDistFromLineSqrdGreaterThanQuarter` (the join-check
  // helper `checkJoinLeft`/`checkJoinRight` call via `checkCurrX`) to pick its
  // fast-path-vs-BigInt branch. The "adjacent rects form a bigger rect"
  // shape is chosen because it's confirmed (see the small-scale scenario
  // above, "two-adjacent-rects-form-bigger-rect") to actually reach the
  // collinear-edge join-check code path, not just generic scanline code —
  // scaling that same shape up past the boundary exercises the BigInt branch
  // specifically (both just-under and just-over the 6888 threshold, plus a
  // magnitude an order further out).
  push('collinear-join-large-coords-below-cross-sq-boundary', [rect(0, 0, 6800, 6800)], [rect(6800, 0, 13600, 6800)])
  push('collinear-join-large-coords-above-cross-sq-boundary', [rect(0, 0, 7000, 7000)], [rect(7000, 0, 14000, 7000)])
  push(
    'collinear-join-large-coords-far-above-cross-sq-boundary',
    [rect(0, 0, 1_000_000, 1_000_000)],
    [rect(1_000_000, 0, 2_000_000, 1_000_000)]
  )

  // --- large coordinates straddling InternalClipper.maxCoordForSafeAreaProduct
  // (`Math.floor(Math.floor(Math.sqrt(Number.MAX_SAFE_INTEGER)) / 2)` ==
  // 47_453_132) used by `ClipperBase.areaOutPt`/`ClipperBase.areaTriangle`
  // (the self-intersection splitter `doSplitOp`, reached from
  // `fixSelfIntersects` for any output ring that self-intersects — see the
  // existing small-scale `bowtie-*`/`pentagram-*` scenarios above, confirmed
  // to reach this same splitter) to pick its fast-path-vs-BigInt branch.
  // Scaling the bowtie shape past the boundary exercises the BigInt area
  // accumulation specifically.
  push('bowtie-self-union-large-coords-below-area-product-boundary', [bowtie(0, 0, 47_000_000)], null)
  push('bowtie-self-union-large-coords-above-area-product-boundary', [bowtie(0, 0, 48_000_000)], null)

  return scenarios
}

const CLIP_TYPE_NAMES: Record<ClipType, string> = {
  [ClipType.NoClip]: 'NoClip',
  [ClipType.Intersection]: 'Intersection',
  [ClipType.Union]: 'Union',
  [ClipType.Difference]: 'Difference',
  [ClipType.Xor]: 'Xor'
}
const FILL_RULE_NAMES: Record<FillRule, string> = {
  [FillRule.EvenOdd]: 'EvenOdd',
  [FillRule.NonZero]: 'NonZero',
  [FillRule.Positive]: 'Positive',
  [FillRule.Negative]: 'Negative'
}

const MATRIX_CLIP_TYPES: ClipType[] = [ClipType.Intersection, ClipType.Union, ClipType.Difference, ClipType.Xor]
const MATRIX_FILL_RULES: FillRule[] = [FillRule.EvenOdd, FillRule.NonZero]

// ---------------------------------------------------------------------------
// Vector accumulator.
// ---------------------------------------------------------------------------

const vectors: unknown[] = []

function recordVector(name: string, clipType: ClipType, fillRule: FillRule, subject: Paths64, clip: Paths64 | null): void {
  const booleanOpExpected = booleanOp(clipType, subject, clip, fillRule)

  const tree = new PolyTree64()
  booleanOpWithPolyTree(clipType, subject, clip, tree, fillRule)
  const polyTreeExpected = encodePolyTreeNode(tree)
  const polyTreeToPathsExpected = polyTreeToPaths64(tree)

  vectors.push({
    name,
    clipType: CLIP_TYPE_NAMES[clipType],
    fillRule: FILL_RULE_NAMES[fillRule],
    subject: encodePaths(subject),
    clip: clip === null ? null : encodePaths(clip),
    booleanOpExpected: encodePaths(booleanOpExpected),
    polyTreeExpected,
    polyTreeToPathsExpected: encodePaths(polyTreeToPathsExpected)
  })
}

// --- full op x fillRule matrix over every scenario --------------------------

for (const scenario of buildScenarios()) {
  for (const clipType of MATRIX_CLIP_TYPES) {
    for (const fillRule of MATRIX_FILL_RULES) {
      recordVector(scenario.name, clipType, fillRule, scenario.subject, scenario.clip)
    }
  }
}

// --- application's exact real usage patterns ---------------------------------
// See this script's top-level doc comment for the production call sites each
// pattern mirrors.

{
  // "Union EvenOdd over many rects" — src/workers/irregular/canonicalLayoutGeometry.ts:655
  // (`booleanOpWithPolyTree(ClipType.Union, [...occupied], null, occupiedTree, FillRule.EvenOdd)`).
  const rng = mulberry32(0x5eed0001)
  const manyRects: Paths64 = []
  for (let i = 0; i < 9; i += 1) {
    const w = 20 + Math.floor(rng() * 40)
    const h = 20 + Math.floor(rng() * 40)
    const x = Math.floor(rng() * 200)
    const y = Math.floor(rng() * 200)
    manyRects.push(rect(x, y, x + w, y + h))
  }
  recordVector('app-usage-union-evenodd-many-rects', ClipType.Union, FillRule.EvenOdd, manyRects, null)

  // "Difference union-vs-sheet" — src/workers/irregular/canonicalLayoutGeometry.ts:656-662
  // (union the occupied rects with EvenOdd, flatten, then subtract from the
  // sheet hull with NonZero).
  const occupiedTree = new PolyTree64()
  booleanOpWithPolyTree(ClipType.Union, manyRects, null, occupiedTree, FillRule.EvenOdd)
  const occupiedUnion = polyTreeToPaths64(occupiedTree)
  const sheetHull = ccwSquare(400, -50, -50)
  recordVector('app-usage-difference-union-vs-sheet', ClipType.Difference, FillRule.NonZero, [sheetHull], occupiedUnion)

  // "Intersection pairs" — src/workers/irregular/canonicalLayoutGeometry.ts:365-371
  // (pairwise convex/concave piece-vs-piece checks, always NonZero).
  const intersectionPairs: [Path64, Path64][] = [
    [ccwSquare(100), ccwSquare(100, 40, 40)],
    [regularPolygon(6, 500), regularPolygon(6, 500, 300, 100)],
    [lShape(0, 0), ccwSquare(12, 8, 8)],
    [regularPolygon(5, 300), regularPolygon(7, 300, 150, 150)]
  ]
  for (const [i, [first, second]] of intersectionPairs.entries()) {
    recordVector(`app-usage-intersection-pair-${i}`, ClipType.Intersection, FillRule.NonZero, [first], [second])
  }

  // "Xor" — src/workers/algorithm/irregular/intrinsicQueueBeamDiscriminator.ts's
  // `booleanPaths` helper, as used at line 4387:
  // `booleanPaths(ClipType.Xor, firstUnion, secondUnion)` (always NonZero).
  const firstGroup: Paths64 = [ccwSquare(60, 0, 0), ccwSquare(60, 40, 40)]
  const secondGroup: Paths64 = [ccwSquare(60, 30, 0), ccwSquare(60, 70, 40)]
  const firstUnionTree = new PolyTree64()
  booleanOpWithPolyTree(ClipType.Union, firstGroup, null, firstUnionTree, FillRule.NonZero)
  const firstUnion = polyTreeToPaths64(firstUnionTree)
  const secondUnionTree = new PolyTree64()
  booleanOpWithPolyTree(ClipType.Union, secondGroup, null, secondUnionTree, FillRule.NonZero)
  const secondUnion = polyTreeToPaths64(secondUnionTree)
  recordVector('app-usage-xor-symmetric-difference-of-unions', ClipType.Xor, FillRule.NonZero, firstUnion, secondUnion)
  recordVector('app-usage-union-of-two-group-unions', ClipType.Union, FillRule.NonZero, firstUnion, secondUnion)
}

// ---------------------------------------------------------------------------
// Write output.
// ---------------------------------------------------------------------------

const generatingCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()

const output = {
  meta: {
    area: 'clipper-engine',
    generatingCommit,
    generatedAt: new Date().toISOString(),
    nodeVersion: process.version,
    clipperVersion: '2.0.1-18',
    vectorCount: vectors.length,
    description:
      'Differential vectors for crates/irregular-nesting-native/src/clipper/engine.rs (the ' +
      'Engine.ts Clipper64/PolyTree64 boolean-clip engine port, plus Clipper.ts booleanOp/' +
      'booleanOpWithPolyTree/polyTreeToPaths64, ruling R10): op x fillRule matrix ' +
      '(Intersection/Union/Difference/Xor x EvenOdd/NonZero) over convex/concave/multi-ring/' +
      'holes/overlapping/touching/collinear-edge/self-intersecting/degenerate polygon pairs, ' +
      'seeded random convex polygons, and the application exact usage patterns (Union EvenOdd ' +
      'over many rects, Difference of a sheet hull vs. a unioned occupied region with NonZero, ' +
      'Intersection pairs with NonZero, Xor of two group unions with NonZero). Each vector ' +
      'records booleanOp (Paths64), the full booleanOpWithPolyTree PolyTree64 structure ' +
      '(polygon + children recursively, in child order), and the polyTreeToPaths64 flattening ' +
      'of that same tree.'
  },
  vectors
}

mkdirSync(vectorsDir, { recursive: true })
writeFileSync(outputPath, JSON.stringify(output, null, 2) + '\n', 'utf8')

console.log(`Wrote ${vectors.length} vectors to ${outputPath}`)
