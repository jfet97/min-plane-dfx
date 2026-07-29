/**
 * Differential-vector generator for
 * `crates/irregular-nesting-native/src/validation/` (`placement.rs`,
 * `spatial_index.rs`, `sat.rs`).
 *
 * Per docs/planning/rust-irregular-backend/stage0-rulings.md R14: this script
 * imports the REAL production TS entry points --
 *   - `assessPlacement` (`src/workers/irregular/placementValidation.ts`), the
 *     pure synchronous function `nfpIfpService.ts`'s hot loop calls directly
 *     (bypassing `Effect`), for exact translated-polygon legality
 *     assessment,
 *   - `makeEmptyPlacedCollisionSpatialIndex` / `makePlacedCollisionSpatialIndex`
 *     (`src/workers/irregular/placedCollisionSpatialIndex.ts`) for the
 *     persistent uniform-grid broad-phase index's `add`/`query`/`matches`
 *     sequences, and
 *   - `measureConvexSatPenetration`
 *     (`src/workers/irregular/convexSatPenetration.ts`) for SAT penetration
 *     depth/translation --
 * evaluates them over a deliberate matrix of touching/overlapping/separated/
 * collinear-contact polygon pairs (using real `mixed61-request.json` piece
 * dimensions where possible) at grid-snapped and unsnapped positions, and
 * writes byte-exact JSON vectors for the Rust ports
 * (`validation::placement::assess_placement`,
 * `validation::spatial_index::{make_empty_placed_collision_spatial_index,
 * make_placed_collision_spatial_index}`,
 * `validation::sat::measure_convex_sat_penetration`) to replay exactly.
 *
 * Run with:
 *   pnpm exec tsx --tsconfig tsconfig.node.json scripts/rust-parity/dump-validation.ts
 *
 * Output (additive; never edits existing fixtures/tests):
 *   - crates/irregular-nesting-native/tests/vectors/validation.json
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PieceId } from '../../src/shared/domain/ids.js'
import { SheetSpec } from '../../src/shared/domain/nesting.js'
import {
  IrregularBounds,
  IrregularPlacedPiece,
  IrregularPlacement,
  IrregularPoint,
  IrregularPolygon,
  IrregularTransform,
  IrregularTransformCandidate,
  TransformedCollisionGeometry
} from '../../src/shared/irregular/domain.js'
import { assessPlacement } from '../../src/workers/irregular/placementValidation.js'
import type { ValidatePlacementInput } from '../../src/workers/irregular/services.js'
import {
  makeEmptyPlacedCollisionSpatialIndex,
  makePlacedCollisionSpatialIndex,
  type PlacedCollisionSpatialIndex
} from '../../src/workers/irregular/placedCollisionSpatialIndex.js'
import { measureConvexSatPenetration } from '../../src/workers/irregular/convexSatPenetration.js'
import type { InternalPoint } from '../../src/workers/irregular/internalGeometry.js'

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
// f64 -> exact big-endian IEEE-754 bit-pattern hex string. Matches
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

// ---------------------------------------------------------------------------
// Deterministic seeded PRNG (mulberry32), matching the convention already
// established by `dump-predicates.ts` / `dump-canonical-grid.ts` /
// `dump-convex.ts` / `dump-transforms.ts`.
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

/** Rounds to 3 decimals -- the "grid-snapped" convention this script uses
 * (an easily distinguishable stand-in for the canonical 0.001mm grid step
 * referenced elsewhere in this codebase; this script does not depend on or
 * exercise `canonical_grid` itself). */
function snapped(value: number): number {
  return Math.round(value * 1000) / 1000
}

/** An arbitrary many-fractional-digit "unsnapped" offset derived from an
 * irrational multiple, deliberately never landing on a 0.001 boundary. */
function unsnapped(value: number): number {
  return value + Math.PI / 97
}

// ---------------------------------------------------------------------------
// Point / shape builders.
// ---------------------------------------------------------------------------
function point(x: number, y: number): IrregularPoint {
  return new IrregularPoint({ x, y })
}

function square(min: number, max: number): ReadonlyArray<IrregularPoint> {
  return [point(min, min), point(max, min), point(max, max), point(min, max)]
}

function rectangle(width: number, height: number): ReadonlyArray<IrregularPoint> {
  return [point(0, 0), point(width, 0), point(width, height), point(0, height)]
}

function regularPolygon(
  sides: number,
  radius: number,
  rotationOffsetDeg: number
): ReadonlyArray<IrregularPoint> {
  const points: IrregularPoint[] = []
  for (let i = 0; i < sides; i++) {
    const angleDeg = rotationOffsetDeg + (360 * i) / sides
    const angleRad = (angleDeg * Math.PI) / 180
    points.push(point(radius * Math.cos(angleRad), radius * Math.sin(angleRad)))
  }
  return points
}

function scaleneTriangle(scale: number): ReadonlyArray<IrregularPoint> {
  return [point(0, 0), point(4 * scale, 0.6 * scale), point(1.2 * scale, 3.7 * scale)]
}

interface Mixed61Piece {
  readonly realBounds: { readonly width: number; readonly height: number }
}

function loadMixed61Dimensions(): ReadonlyArray<{ readonly width: number; readonly height: number }> {
  const raw = readFileSync(MIXED61_FIXTURE_PATH, 'utf8')
  const parsed = JSON.parse(raw) as { readonly sourcePieces: ReadonlyArray<Mixed61Piece> }
  const seen = new Set<string>()
  const dimensions: Array<{ width: number; height: number }> = []
  for (const piece of parsed.sourcePieces) {
    const key = `${piece.realBounds.width}x${piece.realBounds.height}`
    if (seen.has(key)) continue
    seen.add(key)
    dimensions.push({ width: piece.realBounds.width, height: piece.realBounds.height })
  }
  return dimensions
}

const mixed61Rectangles = loadMixed61Dimensions()

// ---------------------------------------------------------------------------
// Domain-object builders for assessPlacement / spatial-index inputs.
// ---------------------------------------------------------------------------
let pieceCounter = 0
function nextPieceId(label: string): PieceId {
  pieceCounter += 1
  return PieceId.make(`dump-validation-${label}-${pieceCounter}`)
}

function transformedCollisionGeometry(
  points: ReadonlyArray<IrregularPoint>,
  bounds: IrregularBounds
): TransformedCollisionGeometry {
  return new TransformedCollisionGeometry({
    sourcePieceId: nextPieceId('moving-tcg'),
    transform: new IrregularTransformCandidate({
      index: 0,
      rotationDeg: 0,
      mirrored: false,
      reason: 'orthogonal'
    }),
    polygon: new IrregularPolygon({ points }),
    bounds
  })
}

function boundsOfPoints(points: ReadonlyArray<IrregularPoint>): IrregularBounds {
  const xs = points.map((p) => p.x)
  const ys = points.map((p) => p.y)
  return new IrregularBounds({
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys)
  })
}

function placedPiece(
  label: string,
  points: ReadonlyArray<IrregularPoint>,
  translateX: number,
  translateY: number
): IrregularPlacedPiece {
  const pieceId = nextPieceId(label)
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
        reason: 'orthogonal'
      }),
      polygon: new IrregularPolygon({ points }),
      bounds: boundsOfPoints(points)
    })
  })
}

// ---------------------------------------------------------------------------
// Encoding helpers.
// ---------------------------------------------------------------------------
interface EncodedPoint {
  readonly x: string
  readonly y: string
}

function encodePoint(p: IrregularPoint): EncodedPoint {
  return { x: f64Bits(p.x), y: f64Bits(p.y) }
}

function encodePoints(points: ReadonlyArray<IrregularPoint>): EncodedPoint[] {
  return points.map(encodePoint)
}

interface EncodedBounds {
  readonly minX: string
  readonly minY: string
  readonly maxX: string
  readonly maxY: string
}

function encodeBounds(bounds: IrregularBounds): EncodedBounds {
  return {
    minX: f64Bits(bounds.minX),
    minY: f64Bits(bounds.minY),
    maxX: f64Bits(bounds.maxX),
    maxY: f64Bits(bounds.maxY)
  }
}

// ===========================================================================
// Section 1: assessPlacement vectors.
// ===========================================================================
interface AssessPlacementCase {
  readonly caseLabel: string
  readonly category: string
  readonly enforceSheetBounds: boolean
  readonly sheet: { readonly width: string; readonly height: string } | null
  readonly movingPolygon: EncodedPoint[]
  readonly candidatePoint: EncodedPoint
  readonly placedPolygons: EncodedPoint[][]
  readonly placedTranslations: EncodedPoint[]
  readonly useIndex: boolean
  readonly indexCellSizeMm: string | null
  readonly outcome:
    | { readonly kind: 'legal' }
    | { readonly kind: 'illegal'; readonly message: string }
    | { readonly kind: 'failure'; readonly operation: string; readonly message: string }
}

const assessCases: AssessPlacementCase[] = []

function runAssessPlacementCase(input: {
  readonly caseLabel: string
  readonly category: string
  readonly enforceSheetBounds: boolean
  readonly sheetWidth?: number
  readonly sheetHeight?: number
  readonly movingPolygon: ReadonlyArray<IrregularPoint>
  readonly candidatePoint: { readonly x: number; readonly y: number }
  readonly placed: ReadonlyArray<{
    readonly polygon: ReadonlyArray<IrregularPoint>
    readonly translateX: number
    readonly translateY: number
  }>
  readonly useIndex: boolean
  readonly indexCellSizeMm: number | undefined
}): void {
  const sheet =
    input.sheetWidth !== undefined && input.sheetHeight !== undefined
      ? new SheetSpec({ width: input.sheetWidth, height: input.sheetHeight, label: 'dump-validation-sheet' })
      : undefined

  const placedPieces = input.placed.map((p, index) =>
    placedPiece(`${input.caseLabel}-placed-${index}`, p.polygon, p.translateX, p.translateY)
  )

  const spatialIndex: PlacedCollisionSpatialIndex | undefined = input.useIndex
    ? makePlacedCollisionSpatialIndex(placedPieces, input.indexCellSizeMm)
    : undefined

  const movingGeometry = transformedCollisionGeometry(input.movingPolygon, boundsOfPoints(input.movingPolygon))

  // `candidate` is deliberately a bare `{ point }` structural object here,
  // not a full `IrregularPlacementCandidate` -- mirroring
  // `nfpIfpService.ts:516-521`'s own production `InternalPlacementCandidate`
  // shape, which `assessPlacement` accepts via structural typing because it
  // only ever reads `candidate.point.x`/`.y` (see
  // `validation-spatial.md` §3). Cast through `unknown` since this object
  // literal's `candidate` field intentionally does not nominally match
  // `IrregularPlacementCandidate`.
  const validateInput = {
    ...(sheet !== undefined ? { sheet } : {}),
    placed: placedPieces,
    ...(spatialIndex !== undefined ? { placedCollisionIndex: spatialIndex } : {}),
    moving: movingGeometry,
    candidate: { point: input.candidatePoint }
  } as unknown as ValidatePlacementInput

  const assessment = assessPlacement(validateInput, input.enforceSheetBounds)

  const outcome: AssessPlacementCase['outcome'] =
    'failure' in assessment
      ? { kind: 'failure', operation: assessment.failure.operation, message: assessment.failure.message }
      : assessment.legal
        ? { kind: 'legal' }
        : { kind: 'illegal', message: assessment.message }

  assessCases.push({
    caseLabel: input.caseLabel,
    category: input.category,
    enforceSheetBounds: input.enforceSheetBounds,
    sheet: sheet !== undefined ? { width: f64Bits(sheet.width), height: f64Bits(sheet.height) } : null,
    movingPolygon: encodePoints(input.movingPolygon),
    candidatePoint: { x: f64Bits(input.candidatePoint.x), y: f64Bits(input.candidatePoint.y) },
    placedPolygons: input.placed.map((p) => encodePoints(p.polygon)),
    placedTranslations: input.placed.map((p) => ({ x: f64Bits(p.translateX), y: f64Bits(p.translateY) })),
    useIndex: input.useIndex,
    indexCellSizeMm: input.indexCellSizeMm !== undefined ? f64Bits(input.indexCellSizeMm) : null,
    outcome
  })
}

// --- (a) single-placed-piece touching/overlapping/separated/collinear-contact
//     matrix, over several shapes, at grid-snapped and unsnapped translations,
//     both indexed and brute-force. ---
interface RelationshipShape {
  readonly label: string
  readonly points: ReadonlyArray<IrregularPoint>
  readonly size: number // bounding span along x for offset math
}

const relationshipShapes: RelationshipShape[] = [
  { label: 'square-2', points: square(0, 2), size: 2 },
  { label: 'square-10', points: square(0, 10), size: 10 },
  { label: 'pentagon-r5', points: regularPolygon(5, 5, 0), size: 10 },
  { label: 'hexagon-r6', points: regularPolygon(6, 6, 15), size: 12 },
  { label: 'octagon-r7', points: regularPolygon(8, 7, 5), size: 14 },
  { label: 'scalene-triangle', points: scaleneTriangle(3), size: 12 }
]
for (const dims of mixed61Rectangles) {
  relationshipShapes.push({
    label: `mixed61-${dims.width}x${dims.height}`,
    points: rectangle(dims.width, dims.height),
    size: Math.max(dims.width, dims.height)
  })
}

const relationshipOffsets: ReadonlyArray<{ readonly kind: string; readonly fraction: number }> = [
  { kind: 'separated', fraction: 1.2 },
  { kind: 'separated-tiny-gap', fraction: 1.0001 },
  { kind: 'touching', fraction: 1.0 },
  { kind: 'overlapping-slight', fraction: 0.999 },
  { kind: 'overlapping-quarter', fraction: 0.75 },
  { kind: 'overlapping-half', fraction: 0.5 },
  { kind: 'overlapping-most', fraction: 0.1 },
  { kind: 'coincident', fraction: 0.0 }
]

for (const shape of relationshipShapes) {
  for (const offset of relationshipOffsets) {
    for (const snapMode of ['snapped', 'unsnapped'] as const) {
      const rawDx = shape.size * offset.fraction
      const dx = snapMode === 'snapped' ? snapped(rawDx) : unsnapped(rawDx)
      for (const useIndex of [false, true]) {
        runAssessPlacementCase({
          caseLabel: `${shape.label}__${offset.kind}__${snapMode}__index${useIndex}`,
          category: `relationship:${offset.kind}`,
          enforceSheetBounds: true,
          sheetWidth: 100000,
          sheetHeight: 100000,
          movingPolygon: shape.points,
          candidatePoint: { x: 0, y: 0 },
          placed: [{ polygon: shape.points, translateX: dx, translateY: 0 }],
          useIndex,
          indexCellSizeMm: useIndex ? 4 : undefined
        })
      }
    }
  }
}

// --- (b) vertical-offset collinear-edge configuration: two axis-aligned
//     rectangles sharing an x-range with a partial vertical overlap, so any
//     collinear-edge overlap logic is exercised without any vertex of either
//     landing strictly inside the other. ---
{
  const random = mulberry32(0x51a5c011)
  for (let trial = 0; trial < 40; trial += 1) {
    const width = 4 + random() * 20
    const height = 4 + random() * 20
    const overlapFraction = 0.05 + random() * 0.9
    const dy = height * (1 - overlapFraction)
    const snapMode = trial % 2 === 0 ? 'snapped' : 'unsnapped'
    const dyFinal = snapMode === 'snapped' ? snapped(dy) : unsnapped(dy)
    for (const useIndex of [false, true]) {
      runAssessPlacementCase({
        caseLabel: `collinear-edge-share-w${width.toFixed(3)}-h${height.toFixed(3)}-t${trial}-index${useIndex}`,
        category: 'relationship:collinear-edge-share',
        enforceSheetBounds: true,
        sheetWidth: 100000,
        sheetHeight: 100000,
        movingPolygon: rectangle(width, height),
        candidatePoint: { x: 0, y: 0 },
        placed: [{ polygon: rectangle(width, height), translateX: 0, translateY: dyFinal }],
        useIndex,
        indexCellSizeMm: useIndex ? 4 : undefined
      })
    }
  }
}

// --- (c) diagonal near-vertex-touch and rotated-boundary-contact cases
//     (a diamond touching a square at a single vertex, a diamond rotated by
//     an odd angle sliding across a square's edge). ---
{
  const diamond = [point(0, -3), point(3, 0), point(0, 3), point(-3, 0)]
  const random = mulberry32(0x0d1a5e0d)
  for (let trial = 0; trial < 40; trial += 1) {
    const dx = randomInRange(random, -6, 6)
    const dy = randomInRange(random, -6, 6)
    const snapMode = trial % 2 === 0 ? 'snapped' : 'unsnapped'
    const dxFinal = snapMode === 'snapped' ? snapped(dx) : unsnapped(dx)
    const dyFinal = snapMode === 'snapped' ? snapped(dy) : unsnapped(dy)
    for (const useIndex of [false, true]) {
      runAssessPlacementCase({
        caseLabel: `diamond-vs-square-t${trial}-index${useIndex}`,
        category: 'relationship:diamond-vs-square',
        enforceSheetBounds: true,
        sheetWidth: 100000,
        sheetHeight: 100000,
        movingPolygon: diamond,
        candidatePoint: { x: 0, y: 0 },
        placed: [{ polygon: square(0, 6), translateX: dxFinal, translateY: dyFinal }],
        useIndex,
        indexCellSizeMm: useIndex ? 4 : undefined
      })
    }
  }
}

// --- (d) sheet-bounds enforcement matrix: inside, exactly on boundary,
//     outside, both enforced and unenforced. ---
{
  const shape = square(0, 4)
  const sheetCases: ReadonlyArray<{ readonly label: string; readonly x: number; readonly y: number }> = [
    { label: 'fully-inside', x: 10, y: 10 },
    { label: 'exact-boundary-touch', x: 0, y: 0 },
    { label: 'exact-far-corner', x: 96, y: 96 },
    { label: 'outside-left', x: -1, y: 10 },
    { label: 'outside-right', x: 97, y: 10 },
    { label: 'outside-below', x: 10, y: -0.5 },
    { label: 'outside-above', x: 10, y: 96.5 },
    { label: 'unsnapped-outside', x: unsnapped(-0.5), y: 10 }
  ]
  for (const sheetCase of sheetCases) {
    for (const enforceSheetBounds of [true, false]) {
      runAssessPlacementCase({
        caseLabel: `sheet-bounds__${sheetCase.label}__enforce${enforceSheetBounds}`,
        category: 'sheet-bounds',
        enforceSheetBounds,
        sheetWidth: 100,
        sheetHeight: 100,
        movingPolygon: shape,
        candidatePoint: { x: sheetCase.x, y: sheetCase.y },
        placed: [],
        useIndex: false,
        indexCellSizeMm: undefined
      })
    }
  }
}

// --- (e) failure paths: non-finite candidate translation, non-finite placed
//     translation, invalid placed polygon topology (in both brute-force and
//     indexed branches). ---
{
  const shape = square(0, 2)
  const nonFiniteValues = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]
  for (const badValue of nonFiniteValues) {
    runAssessPlacementCase({
      caseLabel: `failure-non-finite-candidate-x-${badValue}`,
      category: 'failure:non-finite-moving-translation',
      enforceSheetBounds: true,
      sheetWidth: 1000,
      sheetHeight: 1000,
      movingPolygon: shape,
      candidatePoint: { x: badValue, y: 0 },
      placed: [],
      useIndex: false,
      indexCellSizeMm: undefined
    })
    runAssessPlacementCase({
      caseLabel: `failure-non-finite-placed-translation-y-${badValue}`,
      category: 'failure:non-finite-placed-translation',
      enforceSheetBounds: true,
      sheetWidth: 1000,
      sheetHeight: 1000,
      movingPolygon: shape,
      candidatePoint: { x: 0, y: 0 },
      placed: [{ polygon: shape, translateX: 10, translateY: badValue }],
      useIndex: false,
      indexCellSizeMm: undefined
    })
    runAssessPlacementCase({
      caseLabel: `failure-non-finite-placed-translation-y-indexed-${badValue}`,
      category: 'failure:non-finite-placed-translation-indexed',
      enforceSheetBounds: true,
      sheetWidth: 1000,
      sheetHeight: 1000,
      movingPolygon: shape,
      candidatePoint: { x: 0, y: 0 },
      placed: [{ polygon: shape, translateX: 10, translateY: badValue }],
      useIndex: true,
      indexCellSizeMm: 4
    })
  }
  // Invalid placed polygon topology: too few vertices, self-intersecting
  // bowtie.
  const invalidPolygons: ReadonlyArray<{ readonly label: string; readonly points: ReadonlyArray<IrregularPoint> }> = [
    { label: 'too-few-vertices', points: [point(0, 0), point(1, 1)] },
    { label: 'bowtie', points: [point(0, 0), point(10, 10), point(10, 0), point(0, 10)] },
    { label: 'collinear-vertex', points: [point(0, 0), point(5, 0), point(10, 0), point(10, 10), point(0, 10)] }
  ]
  for (const invalid of invalidPolygons) {
    for (const useIndex of [false, true]) {
      runAssessPlacementCase({
        caseLabel: `failure-invalid-placed-topology-${invalid.label}-index${useIndex}`,
        category: 'failure:invalid-placed-topology',
        enforceSheetBounds: true,
        sheetWidth: 1000,
        sheetHeight: 1000,
        movingPolygon: shape,
        candidatePoint: { x: 100, y: 100 }, // far away, so only topology (not overlap) can fail
        placed: [{ polygon: invalid.points, translateX: 0, translateY: 0 }],
        useIndex,
        indexCellSizeMm: useIndex ? 4 : undefined
      })
    }
  }
  // Invalid *moving* polygon topology.
  for (const invalid of invalidPolygons) {
    runAssessPlacementCase({
      caseLabel: `failure-invalid-moving-topology-${invalid.label}`,
      category: 'failure:invalid-moving-topology',
      enforceSheetBounds: true,
      sheetWidth: 1000,
      sheetHeight: 1000,
      movingPolygon: invalid.points,
      candidatePoint: { x: 0, y: 0 },
      placed: [],
      useIndex: false,
      indexCellSizeMm: undefined
    })
  }
}

// --- (f) multi-placed-piece sequences (2-5 pieces), exercising ordinal-order
//     legality decisions and indexed/brute-force parity together. ---
{
  const random = mulberry32(0x7ea1c0de)
  for (let trial = 0; trial < 40; trial += 1) {
    const shape = square(0, 3)
    const placedCount = 2 + (trial % 4)
    const placed: Array<{ polygon: ReadonlyArray<IrregularPoint>; translateX: number; translateY: number }> = []
    for (let i = 0; i < placedCount; i += 1) {
      const gx = i * 3.5
      const gy = Math.floor(i / 2) * 3.5
      const jitterX = randomInRange(random, -0.2, 0.2)
      const jitterY = randomInRange(random, -0.2, 0.2)
      placed.push({ polygon: shape, translateX: snapped(gx + jitterX), translateY: snapped(gy + jitterY) })
    }
    for (const useIndex of [false, true]) {
      runAssessPlacementCase({
        caseLabel: `multi-placed-t${trial}-n${placedCount}-index${useIndex}`,
        category: 'multi-placed-sequence',
        enforceSheetBounds: true,
        sheetWidth: 1000,
        sheetHeight: 1000,
        movingPolygon: shape,
        candidatePoint: { x: snapped(randomInRange(random, -1, 12)), y: snapped(randomInRange(random, -1, 12)) },
        placed,
        useIndex,
        indexCellSizeMm: useIndex ? 4 : undefined
      })
    }
  }
}

if (assessCases.length < 250) {
  throw new Error(`Expected >= 250 assessPlacement cases, got ${assessCases.length}.`)
}

// ===========================================================================
// Section 2: PlacedCollisionSpatialIndex add/query/matches sequences.
// ===========================================================================
interface SpatialIndexSequenceCase {
  readonly caseLabel: string
  readonly cellSizeMm: string
  readonly pieceCount: number
  /** Raw `add()` inputs, in insertion order -- enough for the Rust test to
   * independently rebuild the identical index via its own
   * `make_placed_collision_spatial_index`, rather than replaying only
   * derived output. */
  readonly pieces: ReadonlyArray<{
    readonly polygon: EncodedPoint[]
    readonly translateX: string
    readonly translateY: string
  }>
  readonly pieceBounds: EncodedBounds[]
  readonly pieceValid: boolean[]
  readonly queries: ReadonlyArray<{
    readonly label: string
    readonly bounds: EncodedBounds | null
    readonly resultOrdinals: number[]
  }>
  readonly matchesChecks: ReadonlyArray<{ readonly label: string; readonly result: boolean }>
  /** `PlacedCollisionSpatialIndex.continuationIdentity()`'s own real TS
   * output for this exact index -- added when ruling R22's byte-exactness
   * carve-out was revoked (2026-07-30) so this string, once believed to
   * only ever need Rust-to-Rust self-consistency, could be pinned against
   * the real cross-language oracle directly (not just indirectly, nested
   * inside `beam-state.json`/`strict-decoder.json`/`capacity-search.json`'s
   * own `continuationMetadataIdentity`/`integrityHash` fields). */
  readonly continuationIdentity: string
}

const spatialSequenceCases: SpatialIndexSequenceCase[] = []

function buildSpatialSequenceCase(input: {
  readonly caseLabel: string
  readonly cellSizeMm: number
  readonly pieces: ReadonlyArray<{
    readonly polygon: ReadonlyArray<IrregularPoint>
    readonly translateX: number
    readonly translateY: number
  }>
  readonly queryBoundsList: ReadonlyArray<{ readonly label: string; readonly bounds: IrregularBounds | undefined }>
}): void {
  const placedPieces = input.pieces.map((p, index) =>
    placedPiece(`${input.caseLabel}-p${index}`, p.polygon, p.translateX, p.translateY)
  )
  const index = makePlacedCollisionSpatialIndex(placedPieces, input.cellSizeMm)

  const queries = input.queryBoundsList.map((q) => {
    const result = index.query(q.bounds)
    return {
      label: q.label,
      bounds: q.bounds !== undefined ? encodeBounds(q.bounds) : null,
      resultOrdinals: result.map((entry) => entry.ordinal)
    }
  })

  const matchesChecks: Array<{ label: string; result: boolean }> = [
    { label: 'same-array', result: index.matches(placedPieces) },
    { label: 'empty-array', result: index.matches([]) },
    {
      label: 'truncated',
      result: index.matches(placedPieces.slice(0, Math.max(0, placedPieces.length - 1)))
    },
    {
      label: 'reordered',
      result: placedPieces.length >= 2 ? index.matches([...placedPieces].reverse()) : index.matches(placedPieces)
    },
    {
      label: 'structural-copy',
      // Rebuild structurally-identical-but-distinct-reference pieces: must
      // fail `matches()` under JS reference-identity semantics.
      result: index.matches(
        input.pieces.map((p, i) => placedPiece(`${input.caseLabel}-copy-${i}`, p.polygon, p.translateX, p.translateY))
      )
    }
  ]

  spatialSequenceCases.push({
    caseLabel: input.caseLabel,
    cellSizeMm: f64Bits(input.cellSizeMm),
    pieceCount: placedPieces.length,
    pieces: input.pieces.map((p) => ({
      polygon: encodePoints(p.polygon),
      translateX: f64Bits(p.translateX),
      translateY: f64Bits(p.translateY)
    })),
    pieceBounds: index.entries.map((entry) =>
      encodeBounds(entry.indexedBounds ?? new IrregularBounds({ minX: 0, minY: 0, maxX: 0, maxY: 0 }))
    ),
    pieceValid: index.entries.map((entry) => entry.translated !== undefined),
    queries,
    matchesChecks,
    continuationIdentity: index.continuationIdentity()
  })
}

// --- Deterministic grids of pieces across several cell sizes, with query
//     windows ranging from a tight single-cell box to a huge "select-all"
//     box, plus an out-of-range box selecting nothing. ---
{
  const random = mulberry32(0xc0117de5)
  for (const cellSizeMm of [4, 16, 64]) {
    for (let gridTrial = 0; gridTrial < 6; gridTrial += 1) {
      const pieceCount = 6 + gridTrial * 4
      const pieces: Array<{ polygon: ReadonlyArray<IrregularPoint>; translateX: number; translateY: number }> = []
      for (let i = 0; i < pieceCount; i += 1) {
        const side = 1 + random() * 3
        const tx = randomInRange(random, -200, 200)
        const ty = randomInRange(random, -200, 200)
        pieces.push({ polygon: square(0, side), translateX: snapped(tx), translateY: snapped(ty) })
      }
      buildSpatialSequenceCase({
        caseLabel: `grid-cell${cellSizeMm}-trial${gridTrial}`,
        cellSizeMm,
        pieces,
        queryBoundsList: [
          { label: 'undefined-bounds', bounds: undefined },
          { label: 'tight-origin-box', bounds: new IrregularBounds({ minX: -5, minY: -5, maxX: 5, maxY: 5 }) },
          {
            label: 'huge-select-all-box',
            bounds: new IrregularBounds({ minX: -1e7, minY: -1e7, maxX: 1e7, maxY: 1e7 })
          },
          {
            label: 'far-empty-box',
            bounds: new IrregularBounds({ minX: 100000, minY: 100000, maxX: 100010, maxY: 100010 })
          },
          {
            label: 'moving-window',
            bounds: new IrregularBounds({
              minX: snapped(randomInRange(random, -200, 200)),
              minY: snapped(randomInRange(random, -200, 200)),
              maxX: snapped(randomInRange(random, -200, 200)) + 20,
              maxY: snapped(randomInRange(random, -200, 200)) + 20
            })
          }
        ]
      })
    }
  }
}

// --- Sequences that include at least one structurally-invalid placed piece
//     (too few vertices), to exercise the `fallbackEntries` unconditional
//     "always returned by query()" behavior. ---
{
  const random = mulberry32(0xba1112ad)
  for (let trial = 0; trial < 15; trial += 1) {
    const pieces: Array<{ polygon: ReadonlyArray<IrregularPoint>; translateX: number; translateY: number }> = [
      { polygon: [point(0, 0), point(1, 1)], translateX: 0, translateY: 0 } // invalid: too few vertices
    ]
    for (let i = 0; i < 8; i += 1) {
      const tx = randomInRange(random, -100, 100)
      const ty = randomInRange(random, -100, 100)
      pieces.push({ polygon: square(0, 2), translateX: snapped(tx), translateY: snapped(ty) })
    }
    buildSpatialSequenceCase({
      caseLabel: `with-invalid-fallback-t${trial}`,
      cellSizeMm: 8,
      pieces,
      queryBoundsList: [
        { label: 'undefined-bounds', bounds: undefined },
        {
          label: 'far-box-must-still-include-invalid',
          bounds: new IrregularBounds({ minX: 100000, minY: 100000, maxX: 100002, maxY: 100002 })
        }
      ]
    })
  }
}

// --- Touching-boundary exactness: entries exactly touching a query box edge
//     must survive (areDisjoint uses strict `<`). ---
{
  const pieces = [
    { polygon: square(0, 4), translateX: 0, translateY: 0 },
    { polygon: square(0, 4), translateX: 4, translateY: 0 }, // touches at x=4
    { polygon: square(0, 4), translateX: 4.0001, translateY: 0 }, // barely separated
    { polygon: square(0, 4), translateX: 1000, translateY: 1000 } // far
  ]
  buildSpatialSequenceCase({
    caseLabel: 'touching-boundary-survival',
    cellSizeMm: 4,
    pieces,
    queryBoundsList: [
      { label: 'query-first-box', bounds: new IrregularBounds({ minX: 0, minY: 0, maxX: 4, maxY: 4 }) }
    ]
  })
}

// --- Empty-index edge case: `makeEmptyPlacedCollisionSpatialIndex` directly
//     (not via `makePlacedCollisionSpatialIndex`'s left-fold), queried with
//     and without bounds, and `matches([])`. ---
{
  const emptyIndex = makeEmptyPlacedCollisionSpatialIndex(8)
  spatialSequenceCases.push({
    caseLabel: 'empty-index',
    cellSizeMm: f64Bits(8),
    pieceCount: 0,
    pieces: [],
    pieceBounds: [],
    pieceValid: [],
    queries: [
      { label: 'undefined-bounds', bounds: null, resultOrdinals: emptyIndex.query(undefined).map((e) => e.ordinal) },
      {
        label: 'some-bounds',
        bounds: encodeBounds(new IrregularBounds({ minX: 0, minY: 0, maxX: 10, maxY: 10 })),
        resultOrdinals: emptyIndex
          .query(new IrregularBounds({ minX: 0, minY: 0, maxX: 10, maxY: 10 }))
          .map((e) => e.ordinal)
      }
    ],
    matchesChecks: [
      { label: 'same-array', result: emptyIndex.matches([]) },
      { label: 'non-empty-array', result: emptyIndex.matches([placedPiece('empty-check', square(0, 1), 0, 0)]) }
    ],
    continuationIdentity: emptyIndex.continuationIdentity()
  })
}

// --- Grid-cell fan-out boundary coverage (validation-spatial.md §14/§15:
//     "No test directly exercises MAX_GRID_CELLS_PER_ENTRY/
//     MAX_GRID_CELLS_PER_QUERY (= 4096 each)... Recommend a dedicated test
//     before/alongside the Rust port to lock this boundary byte-for-byte.").
//     `add()`'s per-entry fan-out gate (`MAX_GRID_CELLS_PER_ENTRY`) and
//     `query()`'s per-call fan-out gate (`MAX_GRID_CELLS_PER_QUERY`) are
//     tested at the exact accepted (4096 cells, inclusive) and rejected
//     (4097 cells) boundary. ---
{
  // (i) `add()` boundary: a single valid rectangle whose grid-cell fan-out is
  // exactly 4096 (accepted -> bucketed, pruned from a far-away query) vs
  // exactly 4097 (rejected -> `fallbackEntries`, unconditionally returned by
  // every query regardless of bounds -- see §9 point 3c/e).
  const farBounds = new IrregularBounds({ minX: 100000, minY: 100000, maxX: 100001, maxY: 100001 })
  buildSpatialSequenceCase({
    caseLabel: 'entry-fanout-boundary-accepted-4096-cells',
    cellSizeMm: 1,
    pieces: [{ polygon: rectangle(63.5, 63.5), translateX: 0, translateY: 0 }], // floor(63.5)=63 -> 64x64=4096 cells
    queryBoundsList: [
      { label: 'far-bounds-must-be-pruned', bounds: farBounds },
      { label: 'own-bounds-must-survive', bounds: new IrregularBounds({ minX: 0, minY: 0, maxX: 1, maxY: 1 }) }
    ]
  })
  buildSpatialSequenceCase({
    caseLabel: 'entry-fanout-boundary-rejected-4097-cells',
    cellSizeMm: 1,
    pieces: [{ polygon: rectangle(4096.5, 0.5), translateX: 0, translateY: 0 }], // floor(4096.5)=4096 -> 4097x1=4097 cells
    queryBoundsList: [
      { label: 'far-bounds-must-still-surface-fallback', bounds: farBounds },
      { label: 'undefined-bounds', bounds: undefined }
    ]
  })

  // (ii) `query()` boundary: a handful of pieces at known positions, queried
  // with a bounds box sized to exactly 4096 cells (indexed-bucket path) vs
  // exactly 4097 cells (exceeds the cap -> "select every entry" conservative
  // degrade, per §9 point 3c) -- both must still prune to the same precise
  // `areDisjoint`-checked result set (§9: "the exact precise re-check...
  // makes the broad-phase bucket lookup safe even when bucket assignment is
  // itself only approximate/conservative").
  const queryFanoutPieces = [
    { polygon: square(0, 2), translateX: 0, translateY: 0 }, // inside both query boxes below
    { polygon: square(0, 2), translateX: 4090, translateY: 0 }, // inside the 4097-cell box only
    { polygon: square(0, 2), translateX: 100000, translateY: 100000 } // outside both
  ]
  buildSpatialSequenceCase({
    caseLabel: 'query-fanout-boundary',
    cellSizeMm: 1,
    pieces: queryFanoutPieces,
    queryBoundsList: [
      {
        label: 'exactly-4096-cells',
        bounds: new IrregularBounds({ minX: 0, minY: 0, maxX: 4095.5, maxY: 0.5 }) // 4096x1 cells
      },
      {
        label: 'exactly-4097-cells',
        bounds: new IrregularBounds({ minX: 0, minY: 0, maxX: 4096.5, maxY: 0.5 }) // 4097x1 cells
      }
    ]
  })
}

// --- `Number.isSafeInteger` rejection-boundary coverage
//     (validation-spatial.md §14/§15: "No test exercises
//     `Number.isSafeInteger`'s exact rejection boundary in `gridCellRange`
//     -- e.g. bounds whose cell-count arithmetic lands just above
//     `2^53 - 1`."). `gridCellRange` is shared by both `add()` and
//     `query()`, so a single `add()`-routing case (piece bounds whose
//     `minX / cellSizeMm` alone exceeds `Number.MAX_SAFE_INTEGER`, landing
//     the entry in `fallbackEntries` despite being topologically valid) plus
//     one `query()`-side case (an out-of-safe-integer-range query bounds,
//     which must degrade to the same "select every entry, then precise
//     re-check" path as the fan-out-exceeded case above) cover both call
//     sites. A third case pins the "individually-safe `minX`/`maxX` combine
//     into an unsafe `width`" scenario `spatial_index.rs`'s `grid_cell_range`
//     doc comment calls out explicitly. ---
{
  // `minX / cellSizeMm = 1e6 / 1e-10 = 1e16`, far beyond
  // `Number.MAX_SAFE_INTEGER` (`2^53 - 1 ~= 9.007e15`) -- `gridCellRange`
  // must reject via the `minX` safe-integer check specifically (the bounds
  // box itself is tiny, so cell *count* alone would not explain rejection).
  buildSpatialSequenceCase({
    caseLabel: 'unsafe-integer-min-x-forces-fallback',
    cellSizeMm: 1e-10,
    pieces: [{ polygon: rectangle(0.5, 0.5), translateX: 1_000_000, translateY: 0 }],
    queryBoundsList: [
      { label: 'undefined-bounds', bounds: undefined },
      {
        label: 'far-bounds-must-still-surface-fallback',
        bounds: new IrregularBounds({ minX: -100, minY: -100, maxX: -99, maxY: -99 })
      }
    ]
  })

  // `minX`/`maxX` are each individually well within the safe-integer bound,
  // but `width = maxX - minX + 1` exceeds it -- exercising the
  // width-specific (not input-coordinate) safe-integer gate.
  buildSpatialSequenceCase({
    caseLabel: 'individually-safe-bounds-combine-into-unsafe-width',
    cellSizeMm: 1,
    pieces: [
      { polygon: rectangle(0.5, 0.5), translateX: -4_600_000_000_000_000, translateY: 0 },
      { polygon: rectangle(0.5, 0.5), translateX: 4_600_000_000_000_000, translateY: 0 }
    ],
    queryBoundsList: [{ label: 'undefined-bounds', bounds: undefined }]
  })

  // `query()`-side: a query bounds box whose `minX / cellSizeMm` alone
  // exceeds the safe-integer bound must degrade the same way `add()` does
  // above (`gridCellRange` returns `undefined` -> "select every entry, then
  // precise re-check").
  buildSpatialSequenceCase({
    caseLabel: 'unsafe-integer-query-bounds',
    cellSizeMm: 1,
    pieces: [
      { polygon: square(0, 2), translateX: 0, translateY: 0 },
      { polygon: square(0, 2), translateX: 100000, translateY: 100000 }
    ],
    queryBoundsList: [
      {
        label: 'query-bounds-min-x-exceeds-safe-integer',
        bounds: new IrregularBounds({ minX: 1e16, minY: 0, maxX: 1e16 + 1, maxY: 1 })
      }
    ]
  })
}

if (spatialSequenceCases.length < 25) {
  throw new Error(`Expected >= 25 spatial-index sequence cases, got ${spatialSequenceCases.length}.`)
}

const spatialIndexQueryVectorCount = spatialSequenceCases.reduce(
  (total, c) => total + c.queries.reduce((qTotal, q) => qTotal + q.resultOrdinals.length + 1, 0),
  0
)

// ===========================================================================
// Section 3: measureConvexSatPenetration vectors.
// ===========================================================================
interface SatCase {
  readonly caseLabel: string
  readonly category: string
  readonly first: EncodedPoint[]
  readonly second: EncodedPoint[]
  readonly result: { readonly depth: string; readonly translation: EncodedPoint } | null
}

const satCases: SatCase[] = []

function runSatCase(
  caseLabel: string,
  category: string,
  first: ReadonlyArray<InternalPoint>,
  second: ReadonlyArray<InternalPoint>
): void {
  const result = measureConvexSatPenetration(first, second)
  satCases.push({
    caseLabel,
    category,
    first: encodePoints(first as ReadonlyArray<IrregularPoint>),
    second: encodePoints(second as ReadonlyArray<IrregularPoint>),
    result:
      result === undefined
        ? null
        : { depth: f64Bits(result.depth), translation: encodePoint(result.translation as IrregularPoint) }
  })
}

// (a) degenerate inputs.
runSatCase('too-few-vertices-first', 'degenerate', [point(0, 0), point(1, 1)], square(0, 2))
runSatCase('too-few-vertices-second', 'degenerate', square(0, 2), [point(0, 0), point(1, 1)])
runSatCase('both-too-few', 'degenerate', [point(0, 0)], [point(1, 1)])

// (b) axis-aligned squares across a dense separation/touch/overlap sweep.
{
  const base = square(0, 4)
  for (let step = -20; step <= 20; step += 1) {
    const dx = step * 0.25
    const other = square(0, 4).map((p) => point(p.x + dx, p.y))
    runSatCase(`axis-aligned-dx${dx}`, 'axis-aligned-sweep', base, other)
  }
  for (let step = -20; step <= 20; step += 1) {
    const dy = step * 0.25
    const other = square(0, 4).map((p) => point(p.x, p.y + dy))
    runSatCase(`axis-aligned-dy${dy}`, 'axis-aligned-sweep', base, other)
  }
}

// (c) diagonal / rotated overlaps: square vs diamond, square vs rotated
// square, at several separations.
{
  const square4 = square(-4, 4)
  const diamond = [point(0, -5), point(5, 0), point(0, 5), point(-5, 0)]
  const random = mulberry32(0x5a71c0de)
  for (let trial = 0; trial < 60; trial += 1) {
    const dx = randomInRange(random, -10, 10)
    const dy = randomInRange(random, -10, 10)
    const shifted = diamond.map((p) => point(p.x + dx, p.y + dy))
    runSatCase(`square-vs-diamond-t${trial}`, 'diagonal-overlap', square4, shifted)
  }
  for (let trial = 0; trial < 60; trial += 1) {
    const angleDeg = randomInRange(random, 0, 90)
    const angleRad = (angleDeg * Math.PI) / 180
    const dx = randomInRange(random, -6, 6)
    const dy = randomInRange(random, -6, 6)
    const rotatedSquare = regularPolygon(4, 4 * Math.SQRT2, 45 + angleDeg).map((p) =>
      point(p.x + dx, p.y + dy)
    )
    void angleRad
    runSatCase(`square-vs-rotated-square-t${trial}`, 'rotated-overlap', square4, rotatedSquare)
  }
}

// (d) regular polygons of varying vertex counts, concentric with growing
// separation, to sweep through touching/separated/overlapping deterministically.
{
  const random = mulberry32(0x9911feed)
  for (let sides = 3; sides <= 10; sides += 1) {
    const shapeA = regularPolygon(sides, 5, 0)
    for (let trial = 0; trial < 6; trial += 1) {
      const dx = randomInRange(random, -8, 8)
      const dy = randomInRange(random, -8, 8)
      const shapeB = regularPolygon(sides, 5, 10).map((p) => point(p.x + dx, p.y + dy))
      runSatCase(`regular-${sides}gon-t${trial}`, 'regular-polygon-sweep', shapeA, shapeB)
    }
  }
}

// (e) mixed61-derived rectangles vs a fixed reference square, several offsets.
{
  const reference = square(0, 6)
  for (let i = 0; i < mixed61Rectangles.length; i += 3) {
    const dims = mixed61Rectangles[i] as { width: number; height: number }
    const shape = rectangle(dims.width, dims.height)
    const offsets: ReadonlyArray<readonly [number, number]> = [
      [0, 0],
      [3, 0],
      [dims.width, 0],
      [dims.width + 1, dims.height + 1]
    ]
    for (const [dx, dy] of offsets) {
      const shifted = shape.map((p) => point(p.x + dx, p.y + dy))
      runSatCase(`mixed61-${dims.width}x${dims.height}-dx${dx}-dy${dy}`, 'mixed61-rectangle', reference, shifted)
    }
  }
}

if (satCases.length < 150) {
  throw new Error(`Expected >= 150 SAT cases, got ${satCases.length}.`)
}

// ===========================================================================
// Totals and output.
// ===========================================================================
const totalVectorCount = assessCases.length + spatialIndexQueryVectorCount + satCases.length
if (totalVectorCount < 500) {
  throw new Error(`Expected >= 500 total validation vectors, got ${totalVectorCount}.`)
}

mkdirSync(VECTORS_DIR, { recursive: true })
const commit = generatingCommit()

const output = {
  generatedByScript: 'scripts/rust-parity/dump-validation.ts',
  generatingCommit: commit,
  sourceModules: [
    'src/workers/irregular/placementValidation.ts',
    'src/workers/irregular/placedCollisionSpatialIndex.ts',
    'src/workers/irregular/convexSatPenetration.ts'
  ],
  description:
    'assessPlacement (placementValidation.ts) legality verdicts for touching/overlapping/separated/' +
    'collinear-contact pairs from synthetic and mixed61-derived pieces at grid-snapped and unsnapped ' +
    'positions, sheet-bounds enforcement, and geometry-failure paths; PlacedCollisionSpatialIndex ' +
    '(placedCollisionSpatialIndex.ts) add/query/matches sequences with full ordered results across ' +
    'several cell sizes and query-window shapes; measureConvexSatPenetration ' +
    '(convexSatPenetration.ts) penetration depth/translation across axis-aligned, diagonal, and ' +
    'regular-polygon sweeps. f64 values are recorded as big-endian IEEE-754 bit-pattern hex strings ' +
    'for bit-exact replay.',
  totalVectorCount,
  assessPlacement: { caseCount: assessCases.length, cases: assessCases },
  spatialIndex: {
    caseCount: spatialSequenceCases.length,
    queryVectorCount: spatialIndexQueryVectorCount,
    cases: spatialSequenceCases
  },
  sat: { caseCount: satCases.length, cases: satCases }
}

writeFileSync(join(VECTORS_DIR, 'validation.json'), JSON.stringify(output, null, 2) + '\n')

console.log(
  `Wrote ${totalVectorCount} validation vectors ` +
    `(assessPlacement=${assessCases.length}, spatialIndex=${spatialSequenceCases.length} sequences/` +
    `${spatialIndexQueryVectorCount} query vectors, sat=${satCases.length}; commit ${commit}) ` +
    `to ${VECTORS_DIR}`
)
