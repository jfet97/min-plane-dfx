/**
 * Differential-vector generator for
 * `crates/irregular-nesting-native/src/canonical_grid/{layout.rs,contact.rs}`.
 *
 * Per docs/planning/rust-irregular-backend/stage0-rulings.md R14: this script
 * imports the REAL production TS entry points from
 * `src/workers/irregular/canonicalLayoutGeometry.ts`,
 * `src/workers/irregular/canonicalGridContact.ts`, and
 * `src/workers/irregular/convexPolygonContact.ts`, evaluates them over a
 * broad deliberate matrix of layouts (built where practical from real piece
 * rings in `tests/fixtures/irregularSheetInvariance/mixed61-request.json`)
 * and edge/vertex pairs, and writes byte-exact JSON vectors for the Rust
 * port to reproduce exactly.
 *
 * `canonicalCollisionLayoutIdentity`'s output is recorded as the **full
 * preimage string** (not just a hash) since that string is itself the UTF-8
 * SHA-256 preimage of the production collision identity
 * (`intrinsicCapacityEndpoint.ts:190`) -- byte-exactness here is existential
 * for the whole port (see this script's sibling `layout.rs`/`contact.rs`
 * module doc comments).
 *
 * Run with:
 *   pnpm exec tsx --tsconfig tsconfig.node.json scripts/rust-parity/dump-canonical-layout.ts
 *
 * Output (additive; never edits existing fixtures/tests):
 *   - crates/irregular-nesting-native/tests/vectors/canonical-layout.json
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  IrregularPlacedPiece,
  IrregularPlacement,
  IrregularPoint,
  IrregularPolygon,
  IrregularTransform,
  IrregularTransformCandidate,
  TransformedCollisionGeometry
} from '../../src/shared/irregular/domain.js'
import { PieceId } from '../../src/shared/domain/ids.js'
import { SheetSpec } from '../../src/shared/domain/nesting.js'

import {
  analyzeCanonicalLayoutStructure,
  assertCanonicalGridLegalLayout,
  canonicalCollisionLayoutIdentity,
  measureCanonicalEnclosedCavities,
  measureCanonicalLayoutContacts,
  measureCanonicalLayoutEnvelope,
  measureCanonicalLayoutTopologyExact,
  placedCollisionWorldGridPath,
  type CanonicalLayoutStructuralAnalysis
} from '../../src/workers/irregular/canonicalLayoutGeometry.js'
import {
  hasPositiveCanonicalGridBoundaryContact,
  measureCanonicalGridBoundaryContact,
  measureCanonicalGridBoundaryOverlapAxisUnits,
  type CanonicalGridBoundaryOverlapAxisUnitsResult
} from '../../src/workers/irregular/canonicalGridContact.js'
import {
  measureSharedConvexPolygonBoundaryContact,
  sharedConvexPolygonBoundarySegments
} from '../../src/workers/irregular/convexPolygonContact.js'
import type { CanonicalGridPoint } from '../../src/workers/irregular/canonicalGridMath.js'
import type { InternalPolygonWithBounds } from '../../src/workers/irregular/internalGeometry.js'

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
// f64 -> exact bit pattern (matches dump-predicates.ts's `f64Bits`/
// dump-free-material.ts's own copy; kept independent per-script per that
// script's own precedent).
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
// Deterministic PRNG (mulberry32), matching dump-canonical-grid.ts's/
// dump-free-material.ts's precedent -- no Math.random anywhere.
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

// ---------------------------------------------------------------------------
// Real fixture geometry: every `sourcePieces[]` entry whose geometry is a
// closed all-line ring becomes a real `IrregularPoint[]` ring (mirrors
// dump-canonical-grid.ts's `loadRealMmRings`, but keeps millimeter points
// instead of grid-snapping them here -- these become real
// `IrregularPlacedPiece` collision polygons, snapped by the production
// functions themselves).
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
  readonly realBounds: { readonly width: number; readonly height: number }
}

function point(x: number, y: number): IrregularPoint {
  return new IrregularPoint({ x, y })
}

interface RealRing {
  readonly label: string
  readonly points: ReadonlyArray<IrregularPoint>
}

function loadRealRings(): RealRing[] {
  const raw = JSON.parse(readFileSync(MIXED61_FIXTURE_PATH, 'utf8')) as {
    readonly sourcePieces: ReadonlyArray<FixtureSourcePiece>
  }
  const rings: RealRing[] = []
  for (const sourcePiece of raw.sourcePieces) {
    const segments = sourcePiece.geometry?.segments
    if (segments === undefined || segments.length < 3) continue
    if (!segments.every((segment) => segment.kind === 'line')) continue
    rings.push({
      label: sourcePiece.id,
      points: segments.map((segment) => point(segment.x1, segment.y1))
    })
  }
  return rings
}

function loadMixed61Dimensions(): ReadonlyArray<{ readonly width: number; readonly height: number }> {
  const raw = JSON.parse(readFileSync(MIXED61_FIXTURE_PATH, 'utf8')) as {
    readonly pieces: ReadonlyArray<FixturePiece>
  }
  const seen = new Set<string>()
  const dimensions: Array<{ width: number; height: number }> = []
  for (const piece of raw.pieces) {
    const key = `${piece.realBounds.width}x${piece.realBounds.height}`
    if (seen.has(key)) continue
    seen.add(key)
    dimensions.push({ width: piece.realBounds.width, height: piece.realBounds.height })
  }
  return dimensions
}

const realRings = loadRealRings()
if (realRings.length < 20) {
  throw new Error(`Expected many real all-line rings, got ${realRings.length}.`)
}
const mixed61Dimensions = loadMixed61Dimensions()
if (mixed61Dimensions.length < 5) {
  throw new Error(`Expected several distinct mixed61 piece dimensions, got ${mixed61Dimensions.length}.`)
}

// ---------------------------------------------------------------------------
// Shape builders and transforms.
// ---------------------------------------------------------------------------
function rectangle(width: number, height: number): IrregularPoint[] {
  return [point(0, 0), point(width, 0), point(width, height), point(0, height)]
}

function regularPolygon(
  sides: number,
  radius: number,
  rotationOffsetDeg: number,
  centerX: number,
  centerY: number
): IrregularPoint[] {
  const points: IrregularPoint[] = []
  for (let i = 0; i < sides; i++) {
    const angleDeg = rotationOffsetDeg + (360 * i) / sides
    const angleRad = (angleDeg * Math.PI) / 180
    points.push(point(centerX + radius * Math.cos(angleRad), centerY + radius * Math.sin(angleRad)))
  }
  return points
}

function reversedRing(points: ReadonlyArray<IrregularPoint>): IrregularPoint[] {
  return [...points].reverse()
}

function rotatedOffset(points: ReadonlyArray<IrregularPoint>, offset: number): IrregularPoint[] {
  const n = points.length
  return points.map((_, index) => {
    const source = points[(index + offset) % n]
    if (source === undefined) throw new Error('rotatedOffset: index out of range')
    return source
  })
}

// Exact quarter-turn rotations about the origin, mirroring `rotateGridPoint`
// (negation/swap only -- exact at every finite float magnitude, so rotating
// the *source* mm ring here and letting the production `toGridMm` snap
// afterward is equivalent to rotating the already-snapped grid ring).
function rotate90(points: ReadonlyArray<IrregularPoint>): IrregularPoint[] {
  return points.map((p) => point(-p.y, p.x))
}
function rotate180(points: ReadonlyArray<IrregularPoint>): IrregularPoint[] {
  return points.map((p) => point(-p.x, -p.y))
}
function rotate270(points: ReadonlyArray<IrregularPoint>): IrregularPoint[] {
  return points.map((p) => point(p.y, -p.x))
}

// ---------------------------------------------------------------------------
// `IrregularPlacedPiece` construction (mirrors dump-free-material.ts's
// `placedPiece`/`rectangle` helpers -- the same real domain classes, no
// parallel Rust-side shape).
// ---------------------------------------------------------------------------
let placedPieceCounter = 0

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

function placedPiece(
  label: string,
  points: ReadonlyArray<IrregularPoint>,
  translateX: number,
  translateY: number,
  mirrored = false
): IrregularPlacedPiece {
  placedPieceCounter += 1
  const pieceId = PieceId.make(`${label}-${placedPieceCounter}`)
  const polygon = new IrregularPolygon({ points })
  return new IrregularPlacedPiece({
    placement: new IrregularPlacement({
      sourcePieceId: pieceId,
      transform: new IrregularTransform({ translateX, translateY, rotationDeg: 0, mirrored })
    }),
    collisionGeometry: new TransformedCollisionGeometry({
      sourcePieceId: pieceId,
      transform: new IrregularTransformCandidate({
        index: 0,
        rotationDeg: 0,
        mirrored,
        reason: 'configured'
      }),
      polygon,
      bounds: boundsOf(points)
    })
  })
}

function rectanglePiece(
  label: string,
  width: number,
  height: number,
  translateX: number,
  translateY: number,
  mirrored = false
): IrregularPlacedPiece {
  return placedPiece(label, rectangle(width, height), translateX, translateY, mirrored)
}

// ---------------------------------------------------------------------------
// Encoding helpers.
// ---------------------------------------------------------------------------
function encodePoint(p: IrregularPoint): { readonly x: string; readonly y: string } {
  return { x: f64Bits(p.x), y: f64Bits(p.y) }
}

function encodePlacedPiece(piece: IrregularPlacedPiece): unknown {
  return {
    pieceId: piece.placement.sourcePieceId,
    points: piece.collisionGeometry.polygon.points.map(encodePoint),
    translateX: f64Bits(piece.placement.transform.translateX),
    translateY: f64Bits(piece.placement.transform.translateY),
    mirrored: piece.placement.transform.mirrored
  }
}

function encodeSheet(sheet: SheetSpec): unknown {
  return { width: f64Bits(sheet.width), height: f64Bits(sheet.height), label: sheet.label }
}

function encodeAabb(aabb: { minX: number; minY: number; maxX: number; maxY: number }): unknown {
  return {
    minX: f64Bits(aabb.minX),
    minY: f64Bits(aabb.minY),
    maxX: f64Bits(aabb.maxX),
    maxY: f64Bits(aabb.maxY)
  }
}

function encodeTopologyExact(
  exact: ReturnType<typeof measureCanonicalLayoutTopologyExact>
): unknown {
  if (exact === undefined) return null
  return {
    topology: {
      enclosedCavityCount: f64Bits(exact.topology.enclosedCavityCount),
      largestOccupiedHullGapRatio: f64Bits(exact.topology.largestOccupiedHullGapRatio),
      occupiedEnvelopeAspectRatio: f64Bits(exact.topology.occupiedEnvelopeAspectRatio),
      positiveContactComponentCount: f64Bits(exact.topology.positiveContactComponentCount),
      isolatedPieceCount: f64Bits(exact.topology.isolatedPieceCount),
      largestPositiveContactComponentSize: f64Bits(
        exact.topology.largestPositiveContactComponentSize
      ),
      largestPositiveContactComponentRatio: f64Bits(
        exact.topology.largestPositiveContactComponentRatio
      )
    },
    hullGapDoubledAreaGrid2: f64Bits(exact.hullGapDoubledAreaGrid2),
    hullDoubledAreaGrid2: f64Bits(exact.hullDoubledAreaGrid2),
    exactHullGapDoubledAreaGrid2: exact.exactHullGapDoubledAreaGrid2,
    exactHullDoubledAreaGrid2: exact.exactHullDoubledAreaGrid2
  }
}

function encodeCavities(
  cavities: ReturnType<typeof measureCanonicalEnclosedCavities>
): unknown {
  if (cavities === undefined) return null
  return {
    count: f64Bits(cavities.count),
    totalAreaMm2: f64Bits(cavities.totalAreaMm2),
    totalDoubledAreaGrid2: cavities.totalDoubledAreaGrid2
  }
}

function encodeContactsMetrics(
  metrics: ReturnType<typeof measureCanonicalLayoutContacts>
): unknown {
  if (metrics === undefined) return null
  return {
    sharedBoundaryLengthMm: f64Bits(metrics.sharedBoundaryLengthMm),
    contactUnits: f64Bits(metrics.contactUnits),
    totalStructuralContacts: f64Bits(metrics.totalStructuralContacts),
    dominantStructuralContacts: f64Bits(metrics.dominantStructuralContacts)
  }
}

function encodeEnvelope(envelope: ReturnType<typeof measureCanonicalLayoutEnvelope>): unknown {
  if (envelope === undefined) return null
  return {
    areaMm2: f64Bits(envelope.areaMm2),
    maximumSideMm: f64Bits(envelope.maximumSideMm),
    spanMm: f64Bits(envelope.spanMm),
    occupiedHullWasteRatio: f64Bits(envelope.occupiedHullWasteRatio),
    maximumSideGrid: f64Bits(envelope.maximumSideGrid),
    spanGrid: f64Bits(envelope.spanGrid),
    envelopeAreaGrid2: envelope.envelopeAreaGrid2,
    occupiedDoubledAreaGrid2: envelope.occupiedDoubledAreaGrid2,
    hullDoubledAreaGrid2: envelope.hullDoubledAreaGrid2
  }
}

function encodeStructuralAnalysis(
  analysis: CanonicalLayoutStructuralAnalysis | undefined
): unknown {
  if (analysis === undefined) return null
  return {
    pieces: analysis.pieces.map((piece) => ({
      pieceId: piece.pieceId,
      aabb: encodeAabb(piece.aabb),
      areaGrid2: f64Bits(piece.areaGrid2),
      doubledAreaGrid2: piece.doubledAreaGrid2
    })),
    positiveContactComponents: analysis.positiveContactComponents.map((component) => [
      ...component
    ]),
    positiveContactPairs: analysis.positiveContactPairs.map((pair) => [...pair]),
    largestHullGap:
      analysis.largestHullGap === undefined
        ? null
        : {
            path: analysis.largestHullGap.path.map(encodePoint),
            areaMm2: f64Bits(analysis.largestHullGap.areaMm2),
            aabb: encodeAabb(analysis.largestHullGap.aabb)
          },
    positiveAreaConflicts: analysis.positiveAreaConflicts.map((pair) => [...pair]),
    positiveAreaConflictMeasurements: analysis.positiveAreaConflictMeasurements.map(
      (measurement) => ({
        pair: [...measurement.pair],
        areaMm2: f64Bits(measurement.areaMm2)
      })
    ),
    wallOffenders: [...analysis.wallOffenders]
  }
}

// ===========================================================================
// 1. Layout cases: one (sheet, placed[]) pair, measured through every
//    exported function in `canonicalLayoutGeometry.ts`.
// ===========================================================================
interface LayoutCase {
  readonly caseLabel: string
  readonly sheet: SheetSpec
  readonly placed: ReadonlyArray<IrregularPlacedPiece>
}

const layoutCases: LayoutCase[] = []
function pushLayout(caseLabel: string, sheet: SheetSpec, placed: ReadonlyArray<IrregularPlacedPiece>): void {
  layoutCases.push({ caseLabel, sheet, placed })
}

// --- 1a. Real single-piece translation sweep (every real all-line ring). ---
for (const ring of realRings) {
  const bounds = boundsOf(ring.points)
  const width = bounds.maxX - bounds.minX
  const height = bounds.maxY - bounds.minY
  const sheet = new SheetSpec({
    width: Math.max(10, Math.ceil(width * 2 + 40)),
    height: Math.max(10, Math.ceil(height * 2 + 40)),
    label: `single-${ring.label}`
  })
  pushLayout(`single__${ring.label}__origin`, sheet, [placedPiece(ring.label, ring.points, 0, 0)])
  pushLayout(`single__${ring.label}__offset`, sheet, [
    placedPiece(ring.label, ring.points, 17.25, 9.5)
  ])
  pushLayout(`single__${ring.label}__negative`, sheet, [
    placedPiece(ring.label, ring.points, -33.125, -12.75)
  ])
  pushLayout(`single__${ring.label}__subgrid-negative-zero`, sheet, [
    placedPiece(ring.label, ring.points, -0.0002, -0.0002)
  ])
}

// --- 1b. Quarter-turn invariance: same real ring at 0/90/180/270. ---
const quarterTurnRings = realRings.slice(0, 12)
for (const ring of quarterTurnRings) {
  const rotations: ReadonlyArray<readonly [string, (p: ReadonlyArray<IrregularPoint>) => IrregularPoint[]]> = [
    ['r0', (p) => [...p]],
    ['r90', rotate90],
    ['r180', rotate180],
    ['r270', rotate270]
  ]
  const sheet = new SheetSpec({ width: 4000, height: 4000, label: `quarterturn-${ring.label}` })
  for (const [tag, rotate] of rotations) {
    pushLayout(`quarterturn__${ring.label}__${tag}`, sheet, [
      placedPiece(ring.label, rotate(ring.points), 5, 5)
    ])
  }
}

// --- 1c. Winding invariance: forward vs reversed vertex order. ---
const windingRings = realRings.slice(0, 20)
for (const ring of windingRings) {
  const sheet = new SheetSpec({ width: 4000, height: 4000, label: `winding-${ring.label}` })
  pushLayout(`winding__${ring.label}__forward`, sheet, [placedPiece(ring.label, ring.points, 2, 2)])
  pushLayout(`winding__${ring.label}__reversed`, sheet, [
    placedPiece(ring.label, reversedRing(ring.points), 2, 2)
  ])
}

// --- 1d. Ring-origin invariance: every cyclic rotation offset of small real rings. ---
const smallRealRings = realRings.filter((ring) => ring.points.length <= 6).slice(0, 8)
for (const ring of smallRealRings) {
  const sheet = new SheetSpec({ width: 4000, height: 4000, label: `ringorigin-${ring.label}` })
  for (let offset = 0; offset < ring.points.length; offset += 1) {
    pushLayout(`ringorigin__${ring.label}__offset${offset}`, sheet, [
      placedPiece(ring.label, rotatedOffset(ring.points, offset), 3, 3)
    ])
  }
  // Ring-origin invariance combined with winding (reversed-order cyclic offsets too).
  const reversed = reversedRing(ring.points)
  for (let offset = 0; offset < reversed.length; offset += 1) {
    pushLayout(`ringorigin__${ring.label}__reversed-offset${offset}`, sheet, [
      placedPiece(ring.label, rotatedOffset(reversed, offset), 3, 3)
    ])
  }
}

// --- 1e. Multi-piece rectangle configurations over every real mixed61 dimension. ---
for (const dims of mixed61Dimensions) {
  const sheet = new SheetSpec({
    width: Math.max(20, Math.ceil(dims.width * 4 + 40)),
    height: Math.max(20, Math.ceil(dims.height * 4 + 40)),
    label: `pair-${dims.width}x${dims.height}`
  })
  const touchingEdge = [
    rectanglePiece('a', dims.width, dims.height, 5, 5),
    rectanglePiece('b', dims.width, dims.height, 5 + dims.width, 5)
  ]
  const touchingPoint = [
    rectanglePiece('a', dims.width, dims.height, 5, 5),
    rectanglePiece('b', dims.width, dims.height, 5 + dims.width, 5 + dims.height)
  ]
  const overlapping = [
    rectanglePiece('a', dims.width, dims.height, 5, 5),
    rectanglePiece('b', dims.width, dims.height, 5 + dims.width * 0.5, 5 + dims.height * 0.5)
  ]
  const disjoint = [
    rectanglePiece('a', dims.width, dims.height, 5, 5),
    rectanglePiece('b', dims.width, dims.height, 5 + dims.width * 3, 5 + dims.height * 3)
  ]
  pushLayout(`touching-edge__${dims.width}x${dims.height}`, sheet, touchingEdge)
  pushLayout(`touching-point__${dims.width}x${dims.height}`, sheet, touchingPoint)
  pushLayout(`overlap__${dims.width}x${dims.height}`, sheet, overlapping)
  pushLayout(`disjoint__${dims.width}x${dims.height}`, sheet, disjoint)
  // Placement-order invariance: same pieces, reversed array order.
  pushLayout(`touching-edge__${dims.width}x${dims.height}__reversed-order`, sheet, [
    ...touchingEdge
  ].reverse())
  pushLayout(`overlap__${dims.width}x${dims.height}__reversed-order`, sheet, [
    ...overlapping
  ].reverse())
}

// --- 1f. Picture-frame layouts (four bars enclosing a hole) at several scales. ---
for (const scale of [1, 2, 5, 10]) {
  const outer = 100 * scale
  const bar = 10 * scale
  const sheet = new SheetSpec({ width: outer + 20, height: outer + 20, label: `frame-${scale}` })
  pushLayout(`picture-frame__scale${scale}`, sheet, [
    rectanglePiece('bottom', outer, bar, 10, 10),
    rectanglePiece('top', outer, bar, 10, 10 + outer - bar),
    rectanglePiece('left', bar, outer - 2 * bar, 10, 10 + bar),
    rectanglePiece('right', bar, outer - 2 * bar, 10 + outer - bar, 10 + bar)
  ])
}

// --- 1g. Wall-splitting bar plus two holes (mirrors freeMaterialService's own fixture). ---
pushLayout(
  'wall-plus-two-holes',
  new SheetSpec({ width: 10, height: 8, label: 'wall-plus-two-holes-sheet' }),
  [
    rectanglePiece('sheet-wall', 2, 8, 4, 0),
    rectanglePiece('left-hole', 2, 2, 1, 1),
    rectanglePiece('right-hole', 2, 2, 7, 4)
  ]
)

// --- 1h. Wall-overrun (illegal) layouts. ---
for (const dims of mixed61Dimensions.slice(0, 6)) {
  const sheet = new SheetSpec({
    width: Math.max(10, Math.ceil(dims.width + 5)),
    height: Math.max(10, Math.ceil(dims.height + 5)),
    label: `wall-overrun-${dims.width}x${dims.height}`
  })
  pushLayout(`wall-overrun__${dims.width}x${dims.height}`, sheet, [
    rectanglePiece('overrun', dims.width, dims.height, sheet.width - dims.width / 2, 0)
  ])
}

// --- 1i. Multi-piece touching chains (contact-component coverage). ---
for (const chainLength of [3, 4, 5]) {
  const width = 20
  const height = 15
  const sheet = new SheetSpec({
    width: width * (chainLength + 2),
    height: height + 20,
    label: `chain-${chainLength}`
  })
  const chain: IrregularPlacedPiece[] = []
  for (let index = 0; index < chainLength; index += 1) {
    chain.push(rectanglePiece(`chain-${chainLength}-${index}`, width, height, 5 + index * width, 5))
  }
  pushLayout(`touching-chain__length${chainLength}`, sheet, chain)
}

// --- 1j. Mirrored-winding layouts. ---
pushLayout(
  'mirrored-winding-layout',
  new SheetSpec({ width: 40, height: 20, label: 'mirrored-winding-sheet' }),
  [
    rectanglePiece('unmirrored', 5, 5, 2, 2),
    placedPiece('mirrored', reversedRing(rectangle(5, 5)), 8, 2, true),
    rectanglePiece('neighbor', 5, 5, 14, 2)
  ]
)

// --- 1k. Randomized multi-piece layouts drawn from real mixed61 dimensions. ---
const random = mulberry32(0x51a1c0de)
function randomInRange(lo: number, hi: number): number {
  return lo + random() * (hi - lo)
}
const RANDOM_LAYOUT_SHEET = new SheetSpec({ width: 500, height: 400, label: 'random-layout-sheet' })
const RANDOM_LAYOUT_COUNT = 160
for (let layoutIndex = 0; layoutIndex < RANDOM_LAYOUT_COUNT; layoutIndex += 1) {
  const pieceCount = 2 + Math.floor(random() * 4) // 2..5
  const placed: IrregularPlacedPiece[] = []
  for (let pieceIndex = 0; pieceIndex < pieceCount; pieceIndex += 1) {
    const dims = mixed61Dimensions[Math.floor(random() * mixed61Dimensions.length)]
    if (dims === undefined) throw new Error('mixed61Dimensions must be non-empty')
    const scale = 0.35
    const width = dims.width * scale
    const height = dims.height * scale
    const translateX = randomInRange(0, Math.max(1, RANDOM_LAYOUT_SHEET.width - width))
    const translateY = randomInRange(0, Math.max(1, RANDOM_LAYOUT_SHEET.height - height))
    const mirrored = random() < 0.3
    const ring = mirrored ? reversedRing(rectangle(width, height)) : rectangle(width, height)
    placed.push(placedPiece(`random-${layoutIndex}-${pieceIndex}`, ring, translateX, translateY, mirrored))
  }
  pushLayout(`random-layout-${layoutIndex}`, RANDOM_LAYOUT_SHEET, placed)
}

// --- 1l. Degenerate cases. ---
pushLayout('empty-layout', new SheetSpec({ width: 100, height: 100, label: 'empty-sheet' }), [])
pushLayout(
  'infinite-translate',
  new SheetSpec({ width: 100, height: 100, label: 'infinite-translate-sheet' }),
  [rectanglePiece('infinite', 5, 5, Number.POSITIVE_INFINITY, 0)]
)
pushLayout('nan-translate', new SheetSpec({ width: 100, height: 100, label: 'nan-translate-sheet' }), [
  rectanglePiece('nan', 5, 5, Number.NaN, 0)
])
pushLayout(
  'ungriddable-translate',
  new SheetSpec({ width: 100, height: 100, label: 'ungriddable-translate-sheet' }),
  [rectanglePiece('huge', 5, 5, 1e300, 0)]
)

// --- Run every layout case through every measurement function. ---
interface LayoutVector {
  readonly caseLabel: string
  readonly sheet: unknown
  readonly placed: ReadonlyArray<unknown>
  readonly identity: string | null
  readonly topologyExact: unknown
  readonly cavities: unknown
  readonly contactsMetrics: unknown
  readonly envelope: unknown
  readonly legal: boolean
  readonly structuralAnalysis: unknown
}

const layoutVectors: LayoutVector[] = layoutCases.map((layoutCase) => ({
  caseLabel: layoutCase.caseLabel,
  sheet: encodeSheet(layoutCase.sheet),
  placed: layoutCase.placed.map(encodePlacedPiece),
  identity: canonicalCollisionLayoutIdentity(layoutCase.placed) ?? null,
  topologyExact: encodeTopologyExact(measureCanonicalLayoutTopologyExact(layoutCase.placed)),
  cavities: encodeCavities(measureCanonicalEnclosedCavities(layoutCase.placed)),
  contactsMetrics: encodeContactsMetrics(measureCanonicalLayoutContacts(layoutCase.placed)),
  envelope: encodeEnvelope(measureCanonicalLayoutEnvelope(layoutCase.placed)),
  legal: assertCanonicalGridLegalLayout(layoutCase.sheet, layoutCase.placed),
  structuralAnalysis: encodeStructuralAnalysis(
    analyzeCanonicalLayoutStructure(layoutCase.sheet, layoutCase.placed)
  )
}))

// ===========================================================================
// 2. Canonical-grid pair vectors: `hasPositiveCanonicalGridBoundaryContact`,
//    `measureCanonicalGridBoundaryContact`, and
//    `measureCanonicalGridBoundaryOverlapAxisUnits` over the same pair.
// ===========================================================================
function grid(x: number, y: number): CanonicalGridPoint {
  return { x, y }
}

function gridSquare(size: number, x: number, y: number): CanonicalGridPoint[] {
  return [grid(x, y), grid(x + size, y), grid(x + size, y + size), grid(x, y + size)]
}

interface GridPairCase {
  readonly caseLabel: string
  readonly first: ReadonlyArray<CanonicalGridPoint>
  readonly second: ReadonlyArray<CanonicalGridPoint>
}

const gridPairCases: GridPairCase[] = []
function pushGridPair(
  caseLabel: string,
  first: ReadonlyArray<CanonicalGridPoint>,
  second: ReadonlyArray<CanonicalGridPoint>
): void {
  gridPairCases.push({ caseLabel, first, second })
}

const gridSizes = [500, 1000, 2500, 6000, 15000]
const overlapRatios = [0.1, 0.3, 0.5, 0.6, 0.94, 0.95, 0.99, 1.0]

for (const size of gridSizes) {
  const first = gridSquare(size, 0, 0)
  pushGridPair(`touching-full-edge__${size}`, first, gridSquare(size, size, 0))
  pushGridPair(`touching-point__${size}`, first, gridSquare(size, size, size))
  pushGridPair(`disjoint__${size}`, first, gridSquare(size, size * 5, size * 5))
  pushGridPair(`overlap-no-boundary-contact__${size}`, first, gridSquare(size, Math.round(size / 2), 0))

  for (const ratio of overlapRatios) {
    const shiftY = Math.round(size * (1 - ratio))
    const second = gridSquare(size, size, shiftY)
    pushGridPair(`partial-edge-overlap__${size}__ratio${ratio}`, first, second)
  }
}

// Diagonal (non-axis-aligned) collinear-edge pairs: `dx !== 0 && dy !== 0`,
// so `measureCanonicalGridBoundaryOverlapAxisUnits` must report
// `'undecidable'` while `hasPositiveCanonicalGridBoundaryContact` still
// reports `true` (see `canonicalGridContact.ts:37-52` vs `:302-337`).
for (const scale of [200, 800, 5000, 123000]) {
  pushGridPair(
    `diagonal-edge-contact__${scale}`,
    [grid(0, 0), grid(scale, scale), grid(0, 2 * scale)],
    [grid(scale, scale), grid(0, 0), grid(2 * scale, 0)]
  )
  pushGridPair(
    `diagonal-edge-contact-transposed__${scale}`,
    [grid(0, 0), grid(scale, scale), grid(2 * scale, 0)],
    [grid(scale, scale), grid(0, 0), grid(0, 2 * scale)]
  )
}

// Negative-coordinate and negative-zero-adjacent pairs.
pushGridPair(
  'negative-coordinates-touching',
  [grid(-2000, -2000), grid(-1000, -2000), grid(-1000, -1000), grid(-2000, -1000)],
  [grid(-1000, -2000), grid(0, -2000), grid(0, -1000), grid(-1000, -1000)]
)
pushGridPair('negative-zero-vertex', [grid(-0, -0), grid(1000, 0), grid(1000, 1000), grid(0, 1000)], [
  grid(1000, 0),
  grid(2000, 0),
  grid(2000, 1000),
  grid(1000, 1000)
])

// Real-ring-derived pairs (through the production `placedCollisionWorldGridPath`).
for (const ring of realRings.slice(0, 8)) {
  const bounds = boundsOf(ring.points)
  const width = bounds.maxX - bounds.minX
  const piece = placedPiece(ring.label, ring.points, 100, 100)
  const neighbor = placedPiece(ring.label, ring.points, 100 + width, 100)
  const pieceGrid = placedCollisionWorldGridPath(piece)
  const neighborGrid = placedCollisionWorldGridPath(neighbor)
  if (pieceGrid === undefined || neighborGrid === undefined) continue
  pushGridPair(`real-ring-adjacent__${ring.label}`, pieceGrid, neighborGrid)
}

interface GridPairVector {
  readonly caseLabel: string
  readonly first: ReadonlyArray<unknown>
  readonly second: ReadonlyArray<unknown>
  readonly hasPositiveContact: boolean | null
  readonly contact: unknown
  readonly axisUnits: unknown
}

function encodeGridPath(path: ReadonlyArray<CanonicalGridPoint>): ReadonlyArray<unknown> {
  return path.map((p) => ({ x: f64Bits(p.x), y: f64Bits(p.y) }))
}

function encodeGridContact(
  contact: ReturnType<typeof measureCanonicalGridBoundaryContact>
): unknown {
  if (contact === undefined) return null
  return {
    lengthMm: f64Bits(contact.lengthMm),
    normalizedUnits: f64Bits(contact.normalizedUnits),
    nearCompleteStructuralContactCount: f64Bits(contact.nearCompleteStructuralContactCount),
    nearCompleteStructuralContactSignatures: [...contact.nearCompleteStructuralContactSignatures]
  }
}

function encodeAxisUnitsResult(result: CanonicalGridBoundaryOverlapAxisUnitsResult): unknown {
  if (result.kind === 'measured') {
    return { kind: 'measured', score: result.score.toString() }
  }
  return { kind: result.kind }
}

const gridPairVectors: GridPairVector[] = gridPairCases.map((pairCase) => ({
  caseLabel: pairCase.caseLabel,
  first: encodeGridPath(pairCase.first),
  second: encodeGridPath(pairCase.second),
  hasPositiveContact:
    hasPositiveCanonicalGridBoundaryContact(pairCase.first, pairCase.second) ?? null,
  contact: encodeGridContact(
    measureCanonicalGridBoundaryContact([...pairCase.first], [...pairCase.second])
  ),
  axisUnits: encodeAxisUnitsResult(
    measureCanonicalGridBoundaryOverlapAxisUnits(pairCase.first, pairCase.second)
  )
}))

// ===========================================================================
// 3. Convex source-geometry pair vectors:
//    `sharedConvexPolygonBoundarySegments`/`measureSharedConvexPolygonBoundaryContact`.
// ===========================================================================
function polygonWithBounds(points: ReadonlyArray<IrregularPoint>): InternalPolygonWithBounds {
  return { polygon: { points }, bounds: boundsOf(points) }
}

interface ConvexPairCase {
  readonly caseLabel: string
  readonly first: InternalPolygonWithBounds
  readonly second: InternalPolygonWithBounds
}

const convexPairCases: ConvexPairCase[] = []
function pushConvexPair(caseLabel: string, first: IrregularPoint[], second: IrregularPoint[]): void {
  convexPairCases.push({
    caseLabel,
    first: polygonWithBounds(first),
    second: polygonWithBounds(second)
  })
}

const convexSizes = [1, 2.5, 6, 15, 40]
for (const size of convexSizes) {
  const first = rectangle(size, size)
  pushConvexPair(`convex-touching-full-edge__${size}`, first, rectangle(size, size).map((p) => point(p.x + size, p.y)))
  pushConvexPair(
    `convex-touching-point__${size}`,
    first,
    rectangle(size, size).map((p) => point(p.x + size, p.y + size))
  )
  pushConvexPair(
    `convex-disjoint__${size}`,
    first,
    rectangle(size, size).map((p) => point(p.x + size * 5, p.y + size * 5))
  )
  pushConvexPair(
    `convex-overlap-no-boundary-contact__${size}`,
    first,
    rectangle(size, size).map((p) => point(p.x + size / 2, p.y))
  )
  for (const ratio of overlapRatios) {
    const shiftY = size * (1 - ratio)
    const second = rectangle(size, size).map((p) => point(p.x + size, p.y + shiftY))
    pushConvexPair(`convex-partial-edge-overlap__${size}__ratio${ratio}`, first, second)
  }
}

// Regular-polygon convex pairs (pentagon/hexagon/octagon) sharing one edge exactly.
for (const sides of [3, 5, 6, 8]) {
  for (const radius of [2, 10, 50]) {
    const first = regularPolygon(sides, radius, 0, 0, 0)
    const firstEdgeStart = first[0]
    const firstEdgeEnd = first[1]
    if (firstEdgeStart === undefined || firstEdgeEnd === undefined) continue
    // Reflect the first polygon's first edge to build a second polygon that
    // shares that exact edge (mirrored across it), guaranteeing a genuine
    // positive-length collinear boundary overlap.
    const dx = firstEdgeEnd.x - firstEdgeStart.x
    const dy = firstEdgeEnd.y - firstEdgeStart.y
    const second = [
      firstEdgeEnd,
      firstEdgeStart,
      point(firstEdgeStart.x - dy, firstEdgeStart.y + dx),
      point(firstEdgeEnd.x - dy, firstEdgeEnd.y + dx)
    ]
    pushConvexPair(`convex-regular-polygon-shared-edge__sides${sides}__radius${radius}`, first, second)
  }
}

interface ConvexPairVector {
  readonly caseLabel: string
  readonly first: ReadonlyArray<unknown>
  readonly second: ReadonlyArray<unknown>
  readonly segments: ReadonlyArray<unknown>
  readonly contact: unknown
}

function encodeConvexContact(
  contact: ReturnType<typeof measureSharedConvexPolygonBoundaryContact>
): unknown {
  if (contact === undefined) return null
  return {
    lengthMm: f64Bits(contact.lengthMm),
    normalizedUnits: f64Bits(contact.normalizedUnits),
    nearCompleteStructuralContactCount: f64Bits(contact.nearCompleteStructuralContactCount),
    nearCompleteStructuralContactSignatures: [...contact.nearCompleteStructuralContactSignatures]
  }
}

const convexPairVectors: ConvexPairVector[] = convexPairCases.map((pairCase) => {
  const segments = sharedConvexPolygonBoundarySegments(pairCase.first, pairCase.second)
  return {
    caseLabel: pairCase.caseLabel,
    first: pairCase.first.polygon.points.map((p) => encodePoint(p as IrregularPoint)),
    second: pairCase.second.polygon.points.map((p) => encodePoint(p as IrregularPoint)),
    segments:
      segments === undefined
        ? []
        : segments.map((segment) => ({
            firstEdgeIndex: f64Bits(segment.firstEdgeIndex),
            secondEdgeIndex: f64Bits(segment.secondEdgeIndex),
            start: encodePoint(segment.start as IrregularPoint),
            end: encodePoint(segment.end as IrregularPoint),
            lengthMm: f64Bits(segment.lengthMm)
          })),
    contact: encodeConvexContact(
      measureSharedConvexPolygonBoundaryContact(pairCase.first, pairCase.second)
    )
  }
})

// ===========================================================================
// Assemble and write.
// ===========================================================================
const totalVectorCount = layoutVectors.length + gridPairVectors.length + convexPairVectors.length

if (totalVectorCount < 600) {
  throw new Error(`Expected >= 600 canonical-layout vectors, got ${totalVectorCount}.`)
}

mkdirSync(VECTORS_DIR, { recursive: true })
const commit = generatingCommit()

const output = {
  generatedByScript: 'scripts/rust-parity/dump-canonical-layout.ts',
  generatingCommit: commit,
  description:
    'canonicalLayoutGeometry.ts + canonicalGridContact.ts + convexPolygonContact.ts full port ' +
    'coverage: canonicalCollisionLayoutIdentity (full preimage strings, not just hashes), ' +
    'measureCanonicalLayoutTopologyExact, measureCanonicalEnclosedCavities, ' +
    'measureCanonicalLayoutContacts, measureCanonicalLayoutEnvelope, assertCanonicalGridLegalLayout, ' +
    'and analyzeCanonicalLayoutStructure over layouts built from real mixed61-request.json piece ' +
    'rings/dimensions at varied placements, rotations (incl. quarter-turn and ring-origin/winding ' +
    'invariance sweeps), negative/-0-producing translations, touching/overlapping/disjoint ' +
    'multi-piece configurations, and enclosed-hole layouts; plus hasPositiveCanonicalGridBoundaryContact ' +
    '/ measureCanonicalGridBoundaryContact / measureCanonicalGridBoundaryOverlapAxisUnits over a grid-pair ' +
    'matrix (touching/overlapping/diagonal/disjoint), and sharedConvexPolygonBoundarySegments / ' +
    'measureSharedConvexPolygonBoundaryContact over a convex-pair matrix. f64 values are recorded as ' +
    'big-endian IEEE-754 bit-pattern hex strings; bigint values are quoted base-10 strings.',
  layoutVectorCount: layoutVectors.length,
  layoutVectors,
  gridPairVectorCount: gridPairVectors.length,
  gridPairVectors,
  convexPairVectorCount: convexPairVectors.length,
  convexPairVectors,
  totalVectorCount
}

writeFileSync(join(VECTORS_DIR, 'canonical-layout.json'), `${JSON.stringify(output, null, 2)}\n`, 'utf8')

console.log(
  `Wrote ${layoutVectors.length} layout vectors, ${gridPairVectors.length} grid-pair vectors, ` +
    `${convexPairVectors.length} convex-pair vectors (${totalVectorCount} total, commit ${commit}) to ${VECTORS_DIR}`
)
