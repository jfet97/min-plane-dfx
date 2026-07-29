/**
 * Differential-vector generator for
 * `crates/irregular-nesting-native/src/search/gap_regions.rs` and
 * `crates/irregular-nesting-native/src/search/strict_family.rs`.
 *
 * Per docs/planning/rust-irregular-backend/stage0-rulings.md R14: this script
 * imports the REAL production TS entry points --
 *   - `deriveCanonicalIntrinsicGapRegions`, `candidateContainedInIntrinsicGap`
 *     (`src/workers/algorithm/irregular/intrinsicGapRegions.ts`), and
 *   - `groupIntrinsicCollisionFamilies`, `intrinsicCollisionFamilyKey`
 *     (`src/workers/algorithm/irregular/intrinsicStrictFamilyPortfolio.ts`)
 * -- both plain, synchronous, `Effect`-free functions -- and evaluates them
 * over a deliberate matrix (touching chains, picture-frame enclosed
 * cavities, malformed/ungriddable geometry) plus real
 * `tests/fixtures/irregularSheetInvariance/mixed61-request.json` piece
 * shapes and interchangeability-key groupings (single/pair/chain sweeps
 * across every distinct real shape, randomized multi-piece layouts, and the
 * full real 61-piece/11-family grouping), writing byte-exact JSON vectors
 * for `gap_regions::{derive_canonical_intrinsic_gap_regions,
 * candidate_contained_in_intrinsic_gap}` and
 * `strict_family::{group_intrinsic_collision_families,
 * intrinsic_collision_family_key}` to replay exactly.
 *
 * Run with:
 *   pnpm exec tsx --tsconfig tsconfig.node.json scripts/rust-parity/dump-gap-family.ts
 *
 * Outputs (additive; never edits existing fixtures/tests):
 *   - crates/irregular-nesting-native/tests/vectors/gap-family.json
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PieceId, SourceFileId } from '../../src/shared/domain/ids.js'
import { DxfGeometrySummary, ImportedPiece } from '../../src/shared/domain/dxf.js'
import { Rect } from '../../src/shared/domain/geometry.js'
import {
  CollisionGeometry,
  IrregularBounds,
  IrregularPlacedPiece,
  IrregularPlacement,
  IrregularPoint,
  IrregularPolygon,
  IrregularPreparedPiece,
  IrregularTransform,
  IrregularTransformCandidate,
  TransformedCollisionGeometry
} from '../../src/shared/irregular/domain.js'
import {
  candidateContainedInIntrinsicGap,
  deriveCanonicalIntrinsicGapRegions,
  type CanonicalIntrinsicGapRegion
} from '../../src/workers/algorithm/irregular/intrinsicGapRegions.js'
import {
  groupIntrinsicCollisionFamilies,
  intrinsicCollisionFamilyKey,
  type IntrinsicCollisionFamily
} from '../../src/workers/algorithm/irregular/intrinsicStrictFamilyPortfolio.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..', '..')
const VECTORS_DIR = join(REPO_ROOT, 'crates', 'irregular-nesting-native', 'tests', 'vectors')
const MIXED61_FIXTURE_PATH = join(
  REPO_ROOT,
  'tests/fixtures/irregularSheetInvariance/mixed61-request.json'
)

function generatingCommit(): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT }).toString().trim()
}

// ---------------------------------------------------------------------------
// f64 -> exact bit pattern (matches dump-free-material.ts's/dump-beam-state.ts's
// own `f64Bits` convention exactly).
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

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32), matching dump-free-material.ts's/
// dump-transforms.ts's precedent -- no Math.random anywhere.
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

function point(x: number, y: number): IrregularPoint {
  return new IrregularPoint({ x, y })
}

function rectangle(width: number, height: number): IrregularPoint[] {
  return [point(0, 0), point(width, 0), point(width, height), point(0, height)]
}

function boundsOf(points: ReadonlyArray<IrregularPoint>): {
  minX: number
  minY: number
  maxX: number
  maxY: number
} {
  const xs = points.map((p) => p.x)
  const ys = points.map((p) => p.y)
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys)
  }
}

// ---------------------------------------------------------------------------
// Real mixed61 fixture data (mirrors dump-beam-state.ts's `loadRealRings`
// plus dump-free-material.ts's dimension loader): joins `pieces[]` (real
// `interchangeabilityKey` groupings) with `sourcePieces[]` (real all-line
// polygon rings) by id.
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
  readonly geometry?: { readonly segments?: ReadonlyArray<FixtureLineSegment> }
}
interface FixturePiece {
  readonly id: string
  readonly interchangeabilityKey: string
  readonly realBounds: { readonly width: number; readonly height: number }
}
interface RealPiece {
  readonly id: string
  readonly interchangeabilityKey: string
  readonly width: number
  readonly height: number
  readonly points: ReadonlyArray<IrregularPoint>
}

function loadRealPieces(): RealPiece[] {
  const raw = JSON.parse(readFileSync(MIXED61_FIXTURE_PATH, 'utf8')) as {
    readonly pieces: ReadonlyArray<FixturePiece>
    readonly sourcePieces: ReadonlyArray<FixtureSourcePiece>
  }
  const sourceById = new Map(raw.sourcePieces.map((sp) => [sp.id, sp]))
  const result: RealPiece[] = []
  for (const piece of raw.pieces) {
    const source = sourceById.get(piece.id)
    const segments = source?.geometry?.segments
    if (segments === undefined || segments.length < 3) continue
    if (!segments.every((segment) => segment.kind === 'line')) continue
    result.push({
      id: piece.id,
      interchangeabilityKey: piece.interchangeabilityKey,
      width: piece.realBounds.width,
      height: piece.realBounds.height,
      points: segments.map((segment) => point(segment.x1, segment.y1))
    })
  }
  return result
}

const realPieces = loadRealPieces()
if (realPieces.length < 50) {
  throw new Error(`Expected most mixed61 pieces to be real all-line rings, got ${realPieces.length}.`)
}

/** First-occurrence piece per distinct real `interchangeabilityKey` -- 11 distinct real shapes. */
const distinctRealShapes: RealPiece[] = (() => {
  const seen = new Set<string>()
  const shapes: RealPiece[] = []
  for (const piece of realPieces) {
    if (seen.has(piece.interchangeabilityKey)) continue
    seen.add(piece.interchangeabilityKey)
    shapes.push(piece)
  }
  return shapes
})()

// ---------------------------------------------------------------------------
// Domain-object construction helpers (mirror
// `tests/unit/intrinsicGapRegions.test.ts`'s/`intrinsicStrictFamilyPortfolio
// .test.ts`'s own helpers -- the same real domain classes, no parallel
// Rust-side shape).
// ---------------------------------------------------------------------------
function sourcePiece(id: string, width: number, height: number): ImportedPiece {
  return new ImportedPiece({
    id: PieceId.make(id),
    sourceFileId: SourceFileId.make(`source-${id}`),
    label: id,
    realBounds: new Rect({ x: 0, y: 0, width, height }),
    geometry: new DxfGeometrySummary({ entityType: 'PRESET_SHAPE', closed: true, segments: [] }),
    warnings: []
  })
}

function placedFromPolygon(
  id: string,
  points: ReadonlyArray<IrregularPoint>,
  translateX: number,
  translateY: number
): IrregularPlacedPiece {
  const pieceId = PieceId.make(id)
  return new IrregularPlacedPiece({
    placement: new IrregularPlacement({
      sourcePieceId: pieceId,
      transform: new IrregularTransform({ translateX, translateY, rotationDeg: 0, mirrored: false })
    }),
    collisionGeometry: new TransformedCollisionGeometry({
      sourcePieceId: pieceId,
      transform: new IrregularTransformCandidate({
        index: 0,
        rotationDeg: 0,
        mirrored: false,
        reason: 'configured'
      }),
      polygon: new IrregularPolygon({ points }),
      bounds: boundsOf(points)
    })
  })
}

function transformedGeometry(id: string, points: ReadonlyArray<IrregularPoint>): TransformedCollisionGeometry {
  return new TransformedCollisionGeometry({
    sourcePieceId: PieceId.make(id),
    transform: new IrregularTransformCandidate({
      index: 0,
      rotationDeg: 0,
      mirrored: false,
      reason: 'configured'
    }),
    polygon: new IrregularPolygon({ points }),
    bounds: boundsOf(points)
  })
}

interface PreparedPieceSpec {
  readonly label: string
  readonly interchangeabilityKey?: string
  readonly width: number
  readonly height: number
  readonly points: ReadonlyArray<IrregularPoint>
}

function preparedPiece(spec: PreparedPieceSpec): IrregularPreparedPiece {
  const source = sourcePiece(spec.label, spec.width, spec.height)
  const polygon = new IrregularPolygon({ points: spec.points })
  return new IrregularPreparedPiece({
    pieceId: source.id,
    ...(spec.interchangeabilityKey === undefined ? {} : { interchangeabilityKey: spec.interchangeabilityKey }),
    source,
    allowMirror: true,
    collisionGeometry: new CollisionGeometry({
      sourcePieceId: source.id,
      sourceBounds: new IrregularBounds({ minX: 0, minY: 0, maxX: spec.width, maxY: spec.height }),
      sampledPoints: spec.points,
      convexHull: polygon,
      collisionPolygon: polygon,
      placementReference: point(0, 0),
      diagnostics: []
    }),
    transforms: [
      new IrregularTransformCandidate({ index: 0, rotationDeg: 0, mirrored: false, reason: 'configured' })
    ]
  })
}

function rotateRing(points: ReadonlyArray<IrregularPoint>, offset: number): IrregularPoint[] {
  const n = points.length
  const result: IrregularPoint[] = []
  for (let i = 0; i < n; i += 1) {
    const p = points[(i + offset) % n]
    if (p === undefined) throw new Error('rotateRing: unreachable out-of-bounds index')
    result.push(p)
  }
  return result
}

function reverseRing(points: ReadonlyArray<IrregularPoint>): IrregularPoint[] {
  return [...points].reverse()
}

// ---------------------------------------------------------------------------
// Encoding helpers -- f64 fields become bit-pattern hex strings; the exact
// `doubledAreaGrid2` BigInt-as-decimal-string field is recorded verbatim
// (not through f64Bits) since it is compared as an exact string/BigInt in
// the Rust port, never as a float.
// ---------------------------------------------------------------------------
function encodePoint(p: { readonly x: number; readonly y: number }) {
  return { x: f64Bits(p.x), y: f64Bits(p.y) }
}
function encodePoints(points: ReadonlyArray<{ readonly x: number; readonly y: number }>) {
  return points.map(encodePoint)
}
function encodePlacedPiece(piece: IrregularPlacedPiece) {
  return {
    pieceId: piece.placement.sourcePieceId,
    points: encodePoints(piece.collisionGeometry.polygon.points),
    translateX: f64Bits(piece.placement.transform.translateX),
    translateY: f64Bits(piece.placement.transform.translateY)
  }
}
function encodeRegion(region: CanonicalIntrinsicGapRegion) {
  return {
    kind: region.kind,
    boundary: encodePoints(region.boundary),
    holes: region.holes.map(encodePoints),
    areaMm2: f64Bits(region.areaMm2),
    doubledAreaGrid2: region.doubledAreaGrid2,
    aabb: {
      minX: f64Bits(region.aabb.minX),
      minY: f64Bits(region.aabb.minY),
      maxX: f64Bits(region.aabb.maxX),
      maxY: f64Bits(region.aabb.maxY)
    },
    canonicalKey: region.canonicalKey
  }
}
function encodePreparedPiece(piece: IrregularPreparedPiece) {
  return {
    label: piece.source.id,
    interchangeabilityKey: piece.interchangeabilityKey ?? null,
    sourceId: piece.source.id,
    points: encodePoints(piece.collisionGeometry.collisionPolygon.points)
  }
}
function encodeFamily(family: IntrinsicCollisionFamily) {
  return {
    key: family.key,
    memberSourceIds: family.members.map((member) => member.source.id),
    firstBaselineIndex: family.firstBaselineIndex,
    collisionAreaMm2: f64Bits(family.collisionAreaMm2),
    maximumSideMm: f64Bits(family.maximumSideMm),
    aspectRatio: f64Bits(family.aspectRatio)
  }
}

// ===========================================================================
// 1. Gap-region cases: parametrized axis-aligned "chain"/"picture-frame"
//    generators with an independently hand-derived expected area/kind
//    (asserted against the real function's own output as a sanity check
//    before being trusted as ground truth), giving reliable true-containment
//    oracles via the real function's own returned `aabb`.
// ===========================================================================
interface GapRegionCase {
  readonly caseLabel: string
  readonly placed: ReadonlyArray<IrregularPlacedPiece>
}
const gapRegionCases: GapRegionCase[] = []
interface TrueContainmentSeed {
  readonly caseLabel: string
  readonly placed: ReadonlyArray<IrregularPlacedPiece>
  readonly region: CanonicalIntrinsicGapRegion
}
const trueContainmentSeeds: TrueContainmentSeed[] = []

/**
 * Left/bottom/right (+ optional top) rectangle assembly, matching
 * `tests/unit/intrinsicGapRegions.test.ts`'s own real-oracle scenario
 * exactly (left=(1,4)@(0,0), bottom=(2,1)@(1,0), right=(1,4)@(3,0) ->
 * hull-open-gap area 6; +top=(2,1)@(1,3) -> encloses to cavity area 4),
 * generalized and parametrized so this script can generate many additional
 * independently-verifiable single-region cases beyond that one pinned
 * example.
 */
function chainAssembly(
  caseLabel: string,
  lw: number,
  bw: number,
  rw: number,
  bottomH: number,
  topH: number | undefined,
  H: number
): void {
  const placed: IrregularPlacedPiece[] = [
    placedFromPolygon(`${caseLabel}-left`, rectangle(lw, H), 0, 0),
    placedFromPolygon(`${caseLabel}-bottom`, rectangle(bw, bottomH), lw, 0),
    placedFromPolygon(`${caseLabel}-right`, rectangle(rw, H), lw + bw, 0)
  ]
  let expectedKind: CanonicalIntrinsicGapRegion['kind'] = 'hull-open-gap'
  let expectedAreaMm2 = bw * (H - bottomH)
  if (topH !== undefined) {
    placed.push(placedFromPolygon(`${caseLabel}-top`, rectangle(bw, topH), lw, H - topH))
    expectedKind = 'enclosed-cavity'
    expectedAreaMm2 = bw * (H - bottomH - topH)
  }
  gapRegionCases.push({ caseLabel, placed })
  const regions = deriveCanonicalIntrinsicGapRegions(placed)
  if (regions === undefined) throw new Error(`${caseLabel}: expected a defined region list`)
  if (regions.length !== 1) {
    throw new Error(`${caseLabel}: expected exactly one region, got ${regions.length}`)
  }
  const region = regions[0]
  if (region === undefined) throw new Error(`${caseLabel}: unreachable`)
  if (region.kind !== expectedKind) {
    throw new Error(`${caseLabel}: expected kind ${expectedKind}, got ${region.kind}`)
  }
  if (Math.abs(region.areaMm2 - expectedAreaMm2) > 1e-6) {
    throw new Error(
      `${caseLabel}: expected areaMm2 ~= ${expectedAreaMm2}, got ${region.areaMm2}`
    )
  }
  trueContainmentSeeds.push({ caseLabel, placed, region })
}

// Pin the exact real-TS-unit-test scenarios first (highest-confidence oracle).
chainAssembly('unit-test-open-gap', 1, 2, 1, 1, undefined, 4)
chainAssembly('unit-test-enclosed-cavity', 1, 2, 1, 1, 1, 4)

// Additional parametrized variants (integer and fractional mm dimensions).
const chainVariants: ReadonlyArray<
  readonly [number, number, number, number, number | undefined, number]
> = [
  [2, 3, 2, 2, undefined, 8],
  [2, 3, 2, 2, 1.5, 8],
  [5, 1, 5, 3, undefined, 10],
  [5, 1, 5, 3, 2, 10],
  [0.5, 0.75, 0.5, 0.25, undefined, 2],
  [0.5, 0.75, 0.5, 0.25, 0.5, 2],
  [10, 20, 10, 4, undefined, 30],
  [10, 20, 10, 4, 8, 30],
  [3.3, 4.4, 3.3, 1.1, undefined, 12.5],
  [3.3, 4.4, 3.3, 1.1, 2.2, 12.5],
  [1, 40, 1, 10, undefined, 50],
  [1, 40, 1, 10, 15, 50],
  [7, 2, 7, 5, undefined, 20],
  [7, 2, 7, 5, 6, 20],
  [15, 6, 15, 8, undefined, 40],
  [15, 6, 15, 8, 12, 40],
  [2, 0.6, 2, 0.3, undefined, 3],
  [2, 0.6, 2, 0.3, 0.4, 3]
]
chainVariants.forEach(([lw, bw, rw, bottomH, topH, H], index) => {
  const label = `chain-variant-${index}${topH === undefined ? '-open' : '-frame'}`
  chainAssembly(label, lw, bw, rw, bottomH, topH, H)
})

// ===========================================================================
// 2. Deliberate synthetic edge cases beyond the parametrized chain family:
//    empty/single-piece/no-gap, multi-region layouts, touching-at-a-point,
//    and malformed/ungriddable geometry (the `undefined` outcome path).
// ===========================================================================
gapRegionCases.push({ caseLabel: 'empty-placed-list', placed: [] })
gapRegionCases.push({
  caseLabel: 'single-square-no-gap',
  placed: [placedFromPolygon('solo', rectangle(10, 10), 0, 0)]
})
gapRegionCases.push({
  caseLabel: 'two-diagonal-squares-one-open-band',
  placed: [
    placedFromPolygon('diag-a', rectangle(10, 10), 0, 0),
    placedFromPolygon('diag-b', rectangle(10, 10), 20, 20)
  ]
})
gapRegionCases.push({
  caseLabel: 'plus-shaped-cross-gap-touches-boundary',
  placed: [
    placedFromPolygon('corner-bl', rectangle(10, 10), 0, 0),
    placedFromPolygon('corner-br', rectangle(10, 10), 20, 0),
    placedFromPolygon('corner-tl', rectangle(10, 10), 0, 20),
    placedFromPolygon('corner-tr', rectangle(10, 10), 20, 20)
  ]
})
gapRegionCases.push({
  caseLabel: 'touching-at-single-corner-point',
  placed: [
    placedFromPolygon('touch-a', rectangle(5, 5), 0, 0),
    placedFromPolygon('touch-b', rectangle(5, 5), 5, 5),
    placedFromPolygon('touch-c', rectangle(5, 5), 10, 0),
    placedFromPolygon('touch-d', rectangle(5, 5), 0, 10)
  ]
})
gapRegionCases.push({
  caseLabel: 'stacked-non-overlapping-strips',
  placed: [
    placedFromPolygon('strip-a', rectangle(20, 3), 0, 0),
    placedFromPolygon('strip-b', rectangle(20, 3), 0, 6),
    placedFromPolygon('strip-c', rectangle(20, 3), 0, 12)
  ]
})
// Malformed / ungriddable geometry -- the `undefined` outcome path.
gapRegionCases.push({
  caseLabel: 'malformed-degenerate-two-point-polygon',
  placed: [placedFromPolygon('degenerate', [point(0, 0), point(1, 0)], 0, 0)]
})
gapRegionCases.push({
  caseLabel: 'malformed-ungriddable-translation',
  placed: [
    placedFromPolygon('ok', rectangle(10, 10), 0, 0),
    placedFromPolygon('huge', rectangle(10, 10), 1e300, 0)
  ]
})
gapRegionCases.push({
  caseLabel: 'malformed-non-finite-translation',
  placed: [
    placedFromPolygon('ok2', rectangle(10, 10), 0, 0),
    placedFromPolygon('nan-translate', rectangle(10, 10), Number.NaN, 0)
  ]
})

// ===========================================================================
// 3. Real mixed61 shape sweeps: single piece (no gap), diagonal pair
//    (hull-open-gap band), and three-in-a-row (multi-region) -- for every
//    one of the 11 distinct real shapes.
// ===========================================================================
for (const shape of distinctRealShapes) {
  const bw = boundsOf(shape.points)
  const w = bw.maxX - bw.minX
  const h = bw.maxY - bw.minY
  const label = `real-${shape.interchangeabilityKey.slice(0, 8)}`

  gapRegionCases.push({
    caseLabel: `${label}-solo`,
    placed: [placedFromPolygon(`${label}-solo`, shape.points, 0, 0)]
  })
  gapRegionCases.push({
    caseLabel: `${label}-diagonal-pair`,
    placed: [
      placedFromPolygon(`${label}-pair-a`, shape.points, 0, 0),
      placedFromPolygon(`${label}-pair-b`, shape.points, w * 1.4, h * 1.4)
    ]
  })
  gapRegionCases.push({
    caseLabel: `${label}-row-of-three`,
    placed: [
      placedFromPolygon(`${label}-row-a`, shape.points, 0, 0),
      placedFromPolygon(`${label}-row-b`, shape.points, w * 1.6, 0),
      placedFromPolygon(`${label}-row-c`, shape.points, w * 3.2, 0)
    ]
  })
  gapRegionCases.push({
    caseLabel: `${label}-plus-formation`,
    placed: [
      placedFromPolygon(`${label}-plus-c`, shape.points, w * 0.9, h * 0.9),
      placedFromPolygon(`${label}-plus-n`, shape.points, w * 0.9, 0),
      placedFromPolygon(`${label}-plus-s`, shape.points, w * 0.9, h * 1.8),
      placedFromPolygon(`${label}-plus-e`, shape.points, w * 1.8, h * 0.9),
      placedFromPolygon(`${label}-plus-w`, shape.points, 0, h * 0.9)
    ]
  })
}

// ===========================================================================
// 4. Randomized multi-piece layouts drawn from real mixed61 shapes
//    (deterministic PRNG, no `Math.random`).
// ===========================================================================
const random = mulberry32(0x6a7ac0de)
function randomInRange(lo: number, hi: number): number {
  return lo + random() * (hi - lo)
}
const RANDOM_LAYOUT_COUNT = 100
for (let layoutIndex = 0; layoutIndex < RANDOM_LAYOUT_COUNT; layoutIndex += 1) {
  const pieceCount = 2 + Math.floor(random() * 3) // 2..4
  const placed: IrregularPlacedPiece[] = []
  const scale = 0.35
  const canvas = 260
  for (let pieceIndex = 0; pieceIndex < pieceCount; pieceIndex += 1) {
    const shapeIndex = Math.floor(random() * distinctRealShapes.length)
    const shape = distinctRealShapes[shapeIndex]
    if (shape === undefined) throw new Error('distinctRealShapes must be non-empty')
    const scaledPoints = shape.points.map((p) => point(p.x * scale, p.y * scale))
    const translateX = randomInRange(0, canvas)
    const translateY = randomInRange(0, canvas)
    placed.push(
      placedFromPolygon(`random-${layoutIndex}-${pieceIndex}`, scaledPoints, translateX, translateY)
    )
  }
  gapRegionCases.push({ caseLabel: `random-layout-${layoutIndex}`, placed })
}

// ===========================================================================
// Run every gap-region case through the real production function.
// ===========================================================================
interface GapRegionOutcome {
  readonly ok: boolean
  readonly regions?: ReadonlyArray<ReturnType<typeof encodeRegion>>
}
interface GapRegionVectorCase {
  readonly caseLabel: string
  readonly placed: ReadonlyArray<ReturnType<typeof encodePlacedPiece>>
  readonly outcome: GapRegionOutcome
}
const gapRegionVectorCases: GapRegionVectorCase[] = gapRegionCases.map((testCase) => {
  const regions = deriveCanonicalIntrinsicGapRegions(testCase.placed)
  const outcome: GapRegionOutcome =
    regions === undefined ? { ok: false } : { ok: true, regions: regions.map(encodeRegion) }
  return {
    caseLabel: testCase.caseLabel,
    placed: testCase.placed.map(encodePlacedPiece),
    outcome
  }
})

const malformedGapLabels = new Set(
  gapRegionCases.filter((c) => c.caseLabel.startsWith('malformed-')).map((c) => c.caseLabel)
)
for (const vectorCase of gapRegionVectorCases) {
  if (malformedGapLabels.has(vectorCase.caseLabel) && vectorCase.outcome.ok) {
    throw new Error(`malformed gap-region case ${vectorCase.caseLabel} unexpectedly succeeded`)
  }
  if (!malformedGapLabels.has(vectorCase.caseLabel) && !vectorCase.outcome.ok) {
    throw new Error(`deliberate gap-region case ${vectorCase.caseLabel} unexpectedly failed`)
  }
}

// ===========================================================================
// 5. Containment cases.
//
//    "False" cases: for every succeeded gap-region case with >=1 region,
//    a candidate identical (in absolute position) to one of the case's own
//    placed pieces is guaranteed `false` -- by construction, every gap
//    region is a component of hull-minus-union-of-occupied, so an occupied
//    piece's own area can never overlap any region's solid, making the
//    Difference always equal the candidate's full (positive) area. This
//    requires no shape-specific reasoning and is robust for any case.
//
//    "True" cases: only from `trueContainmentSeeds` (the parametrized
//    chain/picture-frame generator), using the real function's own returned
//    `aabb` (converted from grid units back to mm, inset by a safety
//    margin) to place a small candidate rectangle that is provably strictly
//    inside the single known region.
// ===========================================================================
interface ContainmentCase {
  readonly caseLabel: string
  readonly placed: ReadonlyArray<IrregularPlacedPiece>
  readonly regionIndex: number
  readonly moving: TransformedCollisionGeometry
  readonly anchor: IrregularPoint
  readonly expected: boolean
}
const containmentCases: ContainmentCase[] = []

for (const testCase of gapRegionCases) {
  if (testCase.placed.length === 0) continue
  const regions = deriveCanonicalIntrinsicGapRegions(testCase.placed)
  if (regions === undefined || regions.length === 0) continue
  const overlapPiece = testCase.placed[0]
  if (overlapPiece === undefined) continue
  const moving = transformedGeometry(
    `${testCase.caseLabel}-overlap-probe`,
    overlapPiece.collisionGeometry.polygon.points
  )
  containmentCases.push({
    caseLabel: `${testCase.caseLabel}__overlap-is-not-contained`,
    placed: testCase.placed,
    regionIndex: 0,
    moving,
    anchor: point(
      overlapPiece.placement.transform.translateX,
      overlapPiece.placement.transform.translateY
    ),
    expected: false
  })
}

const GRID_SCALE = 1000
for (const seed of trueContainmentSeeds) {
  const marginGrid = 200 // 0.2mm inset on every side, well inside a >=1mm region.
  const minXGrid = seed.region.aabb.minX + marginGrid
  const minYGrid = seed.region.aabb.minY + marginGrid
  const maxXGrid = seed.region.aabb.maxX - marginGrid
  const maxYGrid = seed.region.aabb.maxY - marginGrid
  if (maxXGrid <= minXGrid || maxYGrid <= minYGrid) continue // region too small for this margin
  const insetWidthMm = (maxXGrid - minXGrid) / GRID_SCALE
  const insetHeightMm = (maxYGrid - minYGrid) / GRID_SCALE
  const anchorXMm = minXGrid / GRID_SCALE
  const anchorYMm = minYGrid / GRID_SCALE
  const candidatePoints = rectangle(insetWidthMm, insetHeightMm)
  const moving = transformedGeometry(`${seed.caseLabel}-inset-probe`, candidatePoints)
  containmentCases.push({
    caseLabel: `${seed.caseLabel}__inset-rectangle-is-contained`,
    placed: seed.placed,
    regionIndex: 0,
    moving,
    anchor: point(anchorXMm, anchorYMm),
    expected: true
  })
}

interface ContainmentVectorCase {
  readonly caseLabel: string
  readonly placed: ReadonlyArray<ReturnType<typeof encodePlacedPiece>>
  readonly regionIndex: number
  readonly movingPoints: ReadonlyArray<ReturnType<typeof encodePoint>>
  readonly anchor: ReturnType<typeof encodePoint>
  readonly expected: boolean
}
const containmentVectorCases: ContainmentVectorCase[] = containmentCases.map((testCase) => {
  const regions = deriveCanonicalIntrinsicGapRegions(testCase.placed)
  if (regions === undefined) throw new Error(`${testCase.caseLabel}: expected defined region list`)
  const region = regions[testCase.regionIndex]
  if (region === undefined) {
    throw new Error(`${testCase.caseLabel}: regionIndex ${testCase.regionIndex} out of range`)
  }
  const actual = candidateContainedInIntrinsicGap(testCase.moving, testCase.anchor, region)
  if (actual !== testCase.expected) {
    throw new Error(
      `${testCase.caseLabel}: expected containment=${testCase.expected}, real TS function returned ${actual}`
    )
  }
  return {
    caseLabel: testCase.caseLabel,
    placed: testCase.placed.map(encodePlacedPiece),
    regionIndex: testCase.regionIndex,
    movingPoints: encodePoints(testCase.moving.polygon.points),
    anchor: encodePoint(testCase.anchor),
    expected: testCase.expected
  }
})

// ===========================================================================
// 6. Family-key cases (`intrinsicCollisionFamilyKey` in isolation): every
//    real mixed61 piece individually, rotation/reversal-invariance variants
//    of a handful of real shapes, and JSON-string-escaping edge cases for
//    the `interchangeabilityKey` (quotes, backslashes, control characters,
//    non-ASCII passthrough, empty string).
// ===========================================================================
interface FamilyKeyVectorCase {
  readonly caseLabel: string
  readonly piece: ReturnType<typeof encodePreparedPiece>
  readonly key: string
}
const familyKeyVectorCases: FamilyKeyVectorCase[] = []

for (const rp of realPieces) {
  const piece = preparedPiece({
    label: rp.id,
    interchangeabilityKey: rp.interchangeabilityKey,
    width: rp.width,
    height: rp.height,
    points: rp.points
  })
  familyKeyVectorCases.push({
    caseLabel: `real-piece-key__${rp.id}`,
    piece: encodePreparedPiece(piece),
    key: intrinsicCollisionFamilyKey(piece)
  })
}

for (const shape of distinctRealShapes.slice(0, 5)) {
  const variants: ReadonlyArray<readonly [string, ReadonlyArray<IrregularPoint>]> = [
    ['as-is', shape.points],
    ['rotated-1', rotateRing(shape.points, 1)],
    ['rotated-2', rotateRing(shape.points, 2)],
    ['reversed', reverseRing(shape.points)],
    ['reversed-rotated-1', rotateRing(reverseRing(shape.points), 1)]
  ]
  for (const [variantLabel, points] of variants) {
    const piece = preparedPiece({
      label: `${shape.interchangeabilityKey.slice(0, 8)}-${variantLabel}`,
      interchangeabilityKey: shape.interchangeabilityKey,
      width: shape.width,
      height: shape.height,
      points
    })
    familyKeyVectorCases.push({
      caseLabel: `rotation-invariance__${shape.interchangeabilityKey.slice(0, 8)}__${variantLabel}`,
      piece: encodePreparedPiece(piece),
      key: intrinsicCollisionFamilyKey(piece)
    })
  }
}

const escapingInterchangeabilityKeys: ReadonlyArray<readonly [string, string]> = [
  ['double-quote', 'family "quoted"'],
  ['backslash', 'family\\path'],
  ['tab-and-newline', 'family\ttab\nline'],
  ['carriage-return', 'family\rreturn'],
  ['control-char', 'familycontrol'],
  ['backspace-formfeed', 'family'],
  ['unicode-passthrough', 'family-é中\u{1f600}'],
  ['empty-string', '']
]
for (const [escapeLabel, key] of escapingInterchangeabilityKeys) {
  const shape = distinctRealShapes[0]
  if (shape === undefined) throw new Error('distinctRealShapes must be non-empty')
  const piece = preparedPiece({
    label: `escape-${escapeLabel}`,
    interchangeabilityKey: key,
    width: shape.width,
    height: shape.height,
    points: shape.points
  })
  familyKeyVectorCases.push({
    caseLabel: `json-escaping__${escapeLabel}`,
    piece: encodePreparedPiece(piece),
    key: intrinsicCollisionFamilyKey(piece)
  })
}

// No-`interchangeabilityKey` fallback-to-source-id cases.
for (const shape of distinctRealShapes.slice(0, 4)) {
  const piece = preparedPiece({
    label: `no-key-${shape.interchangeabilityKey.slice(0, 8)}`,
    width: shape.width,
    height: shape.height,
    points: shape.points
  })
  familyKeyVectorCases.push({
    caseLabel: `no-interchangeability-key-fallback__${shape.interchangeabilityKey.slice(0, 8)}`,
    piece: encodePreparedPiece(piece),
    key: intrinsicCollisionFamilyKey(piece)
  })
}

// ===========================================================================
// 7. Family-grouping cases (`groupIntrinsicCollisionFamilies`): the full
//    real 61-piece/11-family layout, curated subsets/shuffles, explicit
//    rotation-invariance groupings, the no-interchangeability-key fallback
//    (each piece becomes its own singleton family despite identical shape),
//    and a degenerate (<3-point) polygon exercising the
//    `measureCollisionPolygon` `undefined` fallback stats.
// ===========================================================================
interface FamilyGroupCase {
  readonly caseLabel: string
  readonly pieces: ReadonlyArray<IrregularPreparedPiece>
}
const familyGroupCases: FamilyGroupCase[] = []

familyGroupCases.push({
  caseLabel: 'full-mixed61-real-pieces',
  pieces: realPieces.map((rp) =>
    preparedPiece({
      label: rp.id,
      interchangeabilityKey: rp.interchangeabilityKey,
      width: rp.width,
      height: rp.height,
      points: rp.points
    })
  )
})

// Reversed scan order (proves grouping is a pure function of content, not
// scan direction, while still checking THIS scan's own first-occurrence
// insertion order is what gets recorded).
familyGroupCases.push({
  caseLabel: 'full-mixed61-real-pieces-reverse-order',
  pieces: [...realPieces]
    .reverse()
    .map((rp) =>
      preparedPiece({
        label: rp.id,
        interchangeabilityKey: rp.interchangeabilityKey,
        width: rp.width,
        height: rp.height,
        points: rp.points
      })
    )
})

// Deterministically shuffled subsets at several sizes.
const shuffleRandom = mulberry32(0x51a1c0de)
function shuffled<T>(items: ReadonlyArray<T>): T[] {
  const copy = [...items]
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(shuffleRandom() * (i + 1))
    const a = copy[i]
    const b = copy[j]
    if (a === undefined || b === undefined) throw new Error('shuffle: unreachable')
    copy[i] = b
    copy[j] = a
  }
  return copy
}
for (const size of [5, 10, 20, 35, 50]) {
  const subset = shuffled(realPieces).slice(0, size)
  familyGroupCases.push({
    caseLabel: `shuffled-subset-${size}`,
    pieces: subset.map((rp) =>
      preparedPiece({
        label: rp.id,
        interchangeabilityKey: rp.interchangeabilityKey,
        width: rp.width,
        height: rp.height,
        points: rp.points
      })
    )
  })
}

// Explicit rotation/reversal-invariance grouping: three variants of the same
// real ring sharing one interchangeabilityKey, interleaved with a second,
// distinct real shape's members -- proves both that rotation/reversal
// variants collapse into one family and that interleaving doesn't disturb
// first-occurrence insertion order.
for (const shape of distinctRealShapes.slice(0, 3)) {
  const other = distinctRealShapes.find((s) => s.interchangeabilityKey !== shape.interchangeabilityKey)
  if (other === undefined) continue
  const keyLabel = shape.interchangeabilityKey.slice(0, 8)
  familyGroupCases.push({
    caseLabel: `rotation-invariant-grouping__${keyLabel}`,
    pieces: [
      preparedPiece({
        label: `${keyLabel}-variant-as-is`,
        interchangeabilityKey: shape.interchangeabilityKey,
        width: shape.width,
        height: shape.height,
        points: shape.points
      }),
      preparedPiece({
        label: `${other.interchangeabilityKey.slice(0, 8)}-interleaved`,
        interchangeabilityKey: other.interchangeabilityKey,
        width: other.width,
        height: other.height,
        points: other.points
      }),
      preparedPiece({
        label: `${keyLabel}-variant-rotated`,
        interchangeabilityKey: shape.interchangeabilityKey,
        width: shape.width,
        height: shape.height,
        points: rotateRing(shape.points, 2)
      }),
      preparedPiece({
        label: `${keyLabel}-variant-reversed`,
        interchangeabilityKey: shape.interchangeabilityKey,
        width: shape.width,
        height: shape.height,
        points: reverseRing(shape.points)
      })
    ]
  })
}

// No-interchangeabilityKey fallback: identical shape, no interchangeability
// key -> each piece is its own singleton family (falls back to source.id).
familyGroupCases.push({
  caseLabel: 'no-interchangeability-key-each-piece-is-its-own-family',
  pieces: distinctRealShapes.slice(0, 4).map((shape, index) =>
    preparedPiece({
      label: `singleton-${index}`,
      width: shape.width,
      height: shape.height,
      points: distinctRealShapes[0]?.points ?? shape.points // identical shape across all
    })
  )
})

// Degenerate (<3-point) polygon: `measureCollisionPolygon` returns
// `undefined`, exercising the `collisionAreaMm2: 0, maximumSideMm: 0,
// aspectRatio: 1` fallback defaults.
familyGroupCases.push({
  caseLabel: 'degenerate-polygon-fallback-measurements',
  pieces: [
    preparedPiece({
      label: 'degenerate',
      interchangeabilityKey: 'degenerate-family',
      width: 1,
      height: 1,
      points: [point(0, 0), point(1, 0)]
    }),
    preparedPiece({
      label: 'degenerate-2',
      interchangeabilityKey: 'degenerate-family',
      width: 1,
      height: 1,
      points: [point(0, 0), point(1, 0)]
    })
  ]
})

familyGroupCases.push({ caseLabel: 'empty-pieces', pieces: [] })

interface FamilyGroupVectorCase {
  readonly caseLabel: string
  readonly pieces: ReadonlyArray<ReturnType<typeof encodePreparedPiece>>
  readonly families: ReadonlyArray<ReturnType<typeof encodeFamily>>
}
const familyGroupVectorCases: FamilyGroupVectorCase[] = familyGroupCases.map((testCase) => {
  const families = groupIntrinsicCollisionFamilies(testCase.pieces)
  return {
    caseLabel: testCase.caseLabel,
    pieces: testCase.pieces.map(encodePreparedPiece),
    families: families.map(encodeFamily)
  }
})

// ===========================================================================
// Vector-count accounting and write-out.
// ===========================================================================
const totalVectorCount =
  gapRegionVectorCases.length +
  containmentVectorCases.length +
  familyKeyVectorCases.length +
  familyGroupVectorCases.length

if (totalVectorCount < 350) {
  throw new Error(`Expected >= 350 gap-family vectors, got ${totalVectorCount}.`)
}

mkdirSync(VECTORS_DIR, { recursive: true })
const commit = generatingCommit()

const output = {
  generatedByScript: 'scripts/rust-parity/dump-gap-family.ts',
  generatingCommit: commit,
  description:
    'intrinsicGapRegions.ts full port coverage (deriveCanonicalIntrinsicGapRegions over deliberate ' +
    'axis-aligned chain/picture-frame assemblies with independently-derived expected area/kind, ' +
    'multi-region and boundary-touching layouts, malformed/ungriddable geometry, real mixed61 shape ' +
    'single/pair/row/plus-formation sweeps, and randomized multi-piece layouts; ' +
    'candidateContainedInIntrinsicGap over guaranteed-false overlap probes and guaranteed-true ' +
    'aabb-inset probes) plus intrinsicStrictFamilyPortfolio.ts production-live subset coverage ' +
    '(intrinsicCollisionFamilyKey over every real mixed61 piece, rotation/reversal-invariance ' +
    'variants, JSON-string-escaping edge cases, and the no-interchangeabilityKey fallback; ' +
    'groupIntrinsicCollisionFamilies over the full real 61-piece/11-family layout, reversed scan ' +
    'order, shuffled subsets, explicit rotation-invariant grouping, and a degenerate-polygon ' +
    'fallback-measurements case). f64 values are recorded as big-endian IEEE-754 bit-pattern hex ' +
    'strings for bit-exact comparison; doubledAreaGrid2 is recorded as the exact BigInt decimal string.',
  gapRegionCaseCount: gapRegionVectorCases.length,
  gapRegionCases: gapRegionVectorCases,
  containmentCaseCount: containmentVectorCases.length,
  containmentCases: containmentVectorCases,
  familyKeyCaseCount: familyKeyVectorCases.length,
  familyKeyCases: familyKeyVectorCases,
  familyGroupCaseCount: familyGroupVectorCases.length,
  familyGroupCases: familyGroupVectorCases,
  totalVectorCount
}

writeFileSync(join(VECTORS_DIR, 'gap-family.json'), JSON.stringify(output, null, 2) + '\n')

console.log(
  `Wrote ${gapRegionVectorCases.length} gap-region cases, ${containmentVectorCases.length} containment ` +
    `cases, ${familyKeyVectorCases.length} family-key cases, and ${familyGroupVectorCases.length} ` +
    `family-group cases (${totalVectorCount} total vectors, commit ${commit}) to ${VECTORS_DIR}`
)
