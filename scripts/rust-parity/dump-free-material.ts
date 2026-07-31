/**
 * Differential-vector generator for
 * `crates/irregular-nesting-native/src/geometry/free_material.rs`.
 *
 * Per docs/planning/rust-irregular-backend/stage0-rulings.md R14: this script
 * imports the REAL production TS entry points --
 *   - `createFreeMaterialService('union-then-difference').computeFreeMaterial`
 *     (== `FreeMaterialServiceLive.computeFreeMaterial`, the only production
 *     entry point, `src/workers/irregular/freeMaterialService.ts`),
 *   - `createFreeMaterialService('direct-difference').computeFreeMaterial`
 *     (unreachable in production, ported for test parity per ruling R3), and
 *   - `createFreeMaterialService(...).extendFreeMaterial` (unreachable in
 *     production, ported for test parity per ruling R3)
 * -- evaluates them over a deliberate matrix of sheets/placements (0/1/many
 * placed pieces, edge/corner-touching geometry, hole-producing layouts,
 * mirrored windings, full-coverage/empty degenerate cases, malformed
 * geometry, and extendFreeMaterial parent chains), drawing real piece
 * dimensions from `tests/fixtures/irregularSheetInvariance/mixed61-request.json`
 * where practical, and writes byte-exact JSON vectors for
 * `free_material::{compute_free_material, compute_free_material_live,
 * extend_free_material}` to replay exactly.
 *
 * Run with:
 *   pnpm exec tsx --tsconfig tsconfig.node.json scripts/rust-parity/dump-free-material.ts
 *
 * Outputs (additive; never edits existing fixtures/tests):
 *   - crates/irregular-nesting-native/tests/vectors/free-material.json
 */
import { Effect, Exit, Option } from 'effect'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  FreeMaterialRegion,
  FreeMaterialSnapshot,
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
import { DEFAULT_IRREGULAR_GEOMETRY_SETTINGS } from '../../src/shared/irregular/defaults.js'
import type {
  ComputeFreeMaterialInput,
  ExtendFreeMaterialInput
} from '../../src/workers/irregular/services.js'
import {
  createFreeMaterialService,
  type FreeMaterialOperation
} from '../../src/workers/irregular/freeMaterialService.js'

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
// f64 -> exact bit pattern (matches dump-predicates.ts's `f64Bits`, kept
// independent per-script per that script's own precedent).
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

// ---------------------------------------------------------------------------
// Real fixture piece dimensions (mixed61-request.json) -- "real fixture data
// where available" per the task.
// ---------------------------------------------------------------------------
interface Mixed61Piece {
  readonly realBounds: { readonly width: number; readonly height: number }
}

function loadMixed61Dimensions(): ReadonlyArray<{ readonly width: number; readonly height: number }> {
  const raw = readFileSync(MIXED61_FIXTURE_PATH, 'utf8')
  const parsed = JSON.parse(raw) as { readonly pieces: ReadonlyArray<Mixed61Piece> }
  const seen = new Set<string>()
  const dimensions: Array<{ width: number; height: number }> = []
  for (const piece of parsed.pieces) {
    const key = `${piece.realBounds.width}x${piece.realBounds.height}`
    if (seen.has(key)) continue
    seen.add(key)
    dimensions.push({ width: piece.realBounds.width, height: piece.realBounds.height })
  }
  return dimensions
}

const mixed61Dimensions = loadMixed61Dimensions()
if (mixed61Dimensions.length < 5) {
  throw new Error(`Expected several distinct mixed61 piece dimensions, got ${mixed61Dimensions.length}.`)
}

// ---------------------------------------------------------------------------
// Shape builders. All must be strictly convex, simple rings for the
// "well-formed" case matrix (the same invariant
// `ConvexPolygonValidation.validateStrictBoundary` enforces).
// ---------------------------------------------------------------------------
function point(x: number, y: number): IrregularPoint {
  return new IrregularPoint({ x, y })
}

function rectangle(width: number, height: number): ReadonlyArray<IrregularPoint> {
  return [point(0, 0), point(width, 0), point(width, height), point(0, height)]
}

/** Same rectangle ring in reverse (clockwise) order -- exercises the mirrored-winding branch. */
function clockwiseRectangle(width: number, height: number): ReadonlyArray<IrregularPoint> {
  return [point(0, height), point(width, height), point(width, 0), point(0, 0)]
}

function regularPolygon(
  sides: number,
  radius: number,
  rotationOffsetDeg: number,
  centerX: number,
  centerY: number
): ReadonlyArray<IrregularPoint> {
  const points: IrregularPoint[] = []
  for (let i = 0; i < sides; i++) {
    const angleDeg = rotationOffsetDeg + (360 * i) / sides
    const angleRad = (angleDeg * Math.PI) / 180
    points.push(point(centerX + radius * Math.cos(angleRad), centerY + radius * Math.sin(angleRad)))
  }
  return points
}

// ---------------------------------------------------------------------------
// `IrregularPlacedPiece` construction (mirrors
// `tests/unit/freeMaterialService.test.ts`'s `placedPiece`/`rectangle`
// helpers -- the same real domain classes, no parallel Rust-side shape).
// ---------------------------------------------------------------------------
let placedPieceCounter = 0

function placedPiece(
  pieceIdLabel: string,
  points: ReadonlyArray<IrregularPoint>,
  translateX: number,
  translateY: number,
  mirrored = false
): IrregularPlacedPiece {
  placedPieceCounter += 1
  const pieceId = PieceId.make(`${pieceIdLabel}-${placedPieceCounter}`)
  const polygon = new IrregularPolygon({ points })
  return new IrregularPlacedPiece({
    placement: new IrregularPlacement({
      sourcePieceId: pieceId,
      transform: new IrregularTransform({
        translateX,
        translateY,
        rotationDeg: 0,
        mirrored
      })
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

function boundsOf(points: ReadonlyArray<IrregularPoint>) {
  const xs = points.map((p) => p.x)
  const ys = points.map((p) => p.y)
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys)
  }
}

function rectanglePiece(
  label: string,
  width: number,
  height: number,
  translateX = 0,
  translateY = 0
): IrregularPlacedPiece {
  return placedPiece(label, rectangle(width, height), translateX, translateY)
}

// ---------------------------------------------------------------------------
// Encoding helpers -- f64 fields become bit-pattern hex strings.
// ---------------------------------------------------------------------------
function encodePoint(p: IrregularPoint) {
  return { x: f64Bits(p.x), y: f64Bits(p.y) }
}

function encodePolygonPoints(p: IrregularPolygon) {
  return p.points.map(encodePoint)
}

function encodeSheet(sheet: SheetSpec) {
  return { width: f64Bits(sheet.width), height: f64Bits(sheet.height), label: sheet.label }
}

function encodePlacedPiece(piece: IrregularPlacedPiece) {
  return {
    pieceId: piece.placement.sourcePieceId,
    points: encodePolygonPoints(piece.collisionGeometry.polygon),
    translateX: f64Bits(piece.placement.transform.translateX),
    translateY: f64Bits(piece.placement.transform.translateY),
    mirrored: piece.placement.transform.mirrored
  }
}

function encodeSnapshot(snapshot: FreeMaterialSnapshot) {
  return {
    sheet: encodeSheet(snapshot.sheet),
    regions: snapshot.regions.map((region) => ({
      boundary: encodePolygonPoints(region.boundary),
      holes: region.holes.map(encodePolygonPoints)
    })),
    diagnosticsCount: snapshot.diagnostics.length
  }
}

// ---------------------------------------------------------------------------
// Runners -- `Effect.runSyncExit` + `Exit.findErrorOption` extracts the one
// typed error this file's boundary produces without any async plumbing
// (every code path in `deriveFreeMaterial`/`deriveExtendedFreeMaterial` is a
// synchronous `Effect.succeed`/`Effect.fail`, never a generator with an
// asynchronous `yield*`).
// ---------------------------------------------------------------------------
interface OutcomeOk {
  readonly ok: true
  readonly snapshot: ReturnType<typeof encodeSnapshot>
}
interface OutcomeErr {
  readonly ok: false
  readonly operation: string
  readonly message: string
}
type Outcome = OutcomeOk | OutcomeErr

function runCompute(operation: FreeMaterialOperation, input: ComputeFreeMaterialInput): Outcome {
  const effect = createFreeMaterialService(operation).computeFreeMaterial(input)
  return runOutcome(effect)
}

function runExtend(input: ExtendFreeMaterialInput): Outcome {
  const effect = createFreeMaterialService('union-then-difference').extendFreeMaterial(input)
  return runOutcome(effect)
}

function runOutcome(
  effect: Effect.Effect<FreeMaterialSnapshot, { readonly operation: string; readonly message: string }>
): Outcome {
  const exit = Effect.runSyncExit(effect)
  if (Exit.isFailure(exit)) {
    const failure = Exit.findErrorOption(exit)
    if (Option.isNone(failure)) {
      throw new Error(`unexpected non-Fail exit cause: ${JSON.stringify(exit)}`)
    }
    return { ok: false, operation: failure.value.operation, message: failure.value.message }
  }
  return { ok: true, snapshot: encodeSnapshot(exit.value) }
}

function computeInput(
  placed: ReadonlyArray<IrregularPlacedPiece>,
  sheet: SheetSpec = new SheetSpec({ width: 10, height: 8, label: 'default sheet' })
): ComputeFreeMaterialInput {
  return { sheet, placed, settings: DEFAULT_IRREGULAR_GEOMETRY_SETTINGS }
}

// ===========================================================================
// 1. Deliberate synthetic cases (mirrors
//    tests/unit/freeMaterialService.test.ts's `differentialCases`, plus a
//    few additional edge/hole/degenerate scenarios), each run through both
//    operations.
// ===========================================================================
interface ComputeCase {
  readonly caseLabel: string
  readonly input: ComputeFreeMaterialInput
}

const deliberateCases: ComputeCase[] = [
  { caseLabel: 'empty', input: computeInput([]) },
  { caseLabel: 'interior', input: computeInput([rectanglePiece('interior', 2, 2, 4, 3)]) },
  {
    caseLabel: 'boundary-touching',
    input: computeInput([rectanglePiece('boundary-touching', 4, 2, 0, 3)])
  },
  {
    caseLabel: 'disjoint',
    input: computeInput([
      rectanglePiece('disjoint-left', 2, 2, 1, 1),
      rectanglePiece('disjoint-right', 2, 2, 6, 3)
    ])
  },
  {
    caseLabel: 'touching-edge',
    input: computeInput([
      rectanglePiece('touching-left', 2, 2, 1, 1),
      rectanglePiece('touching-right', 2, 2, 3, 1)
    ])
  },
  {
    caseLabel: 'touching-point',
    input: computeInput([
      rectanglePiece('touching-lower', 2, 2, 1, 1),
      rectanglePiece('touching-upper', 2, 2, 3, 3)
    ])
  },
  {
    caseLabel: 'overlap',
    input: computeInput([
      rectanglePiece('overlap-first', 3, 3, 2, 2),
      rectanglePiece('overlap-second', 3, 3, 4, 3)
    ])
  },
  {
    caseLabel: 'mirrored-winding',
    input: computeInput([
      rectanglePiece('unmirrored', 2, 2, 2, 2),
      placedPiece('mirrored-clockwise', clockwiseRectangle(2, 2), 3, 2, true),
      rectanglePiece('mirrored-neighbor', 2, 2, 5, 2)
    ])
  },
  { caseLabel: 'full-sheet', input: computeInput([rectanglePiece('full-sheet', 10, 8)]) },
  {
    caseLabel: 'four-corners-touching',
    input: computeInput([
      rectanglePiece('corner-bl', 2, 2, 0, 0),
      rectanglePiece('corner-br', 2, 2, 8, 0),
      rectanglePiece('corner-tl', 2, 2, 0, 6),
      rectanglePiece('corner-tr', 2, 2, 8, 6)
    ])
  },
  {
    caseLabel: 'three-holes',
    input: computeInput([
      rectanglePiece('hole-a', 1, 1, 1, 1),
      rectanglePiece('hole-b', 1, 1, 4, 1),
      rectanglePiece('hole-c', 1, 1, 7, 1)
    ])
  },
  {
    caseLabel: 'wall-splitting-two-regions',
    input: computeInput([rectanglePiece('wall', 2, 8, 4, 0)])
  },
  {
    caseLabel: 'wall-plus-two-holes',
    input: computeInput([
      rectanglePiece('sheet-wall', 2, 8, 4, 0),
      rectanglePiece('left-hole', 2, 2, 1, 1),
      rectanglePiece('right-hole', 2, 2, 7, 4)
    ])
  },
  {
    caseLabel: 'triangle-piece-interior-hole',
    input: computeInput([placedPiece('triangle', regularPolygon(3, 1.5, 90, 0, 0), 5, 4)])
  },
  {
    caseLabel: 'pentagon-piece-corner',
    input: computeInput([placedPiece('pentagon', regularPolygon(5, 1.2, -18, 0, 0), 0, 0)])
  },
  // Exercises `toPlacedPath`'s `normalizeNegativeZero(toGridMm(translated))` call
  // (freeMaterialService.ts:282-289) on a genuine negative-zero-producing branch:
  // a piece translated by a sub-grid-step negative offset (-0.0002mm, well under the
  // 0.0005mm rounding tie) so `toGridMm` quantizes at least one translated vertex to
  // exactly `-0` before it is folded to `+0`. Distinct from `canonical_grid`'s own
  // `toGridMm`-level `-0` vectors: this proves the free-material-specific call site
  // itself folds the sign, not just the shared primitive in isolation.
  {
    caseLabel: 'sub-grid-negative-translation-folds-to-positive-zero',
    input: computeInput([
      placedPiece('negative-zero-fold', rectangle(2, 2), -0.0002, -0.0002)
    ])
  },
  // Exercises `comparePolygons`'s `polygonKey(...).localeCompare(...)` fallback
  // (freeMaterialService.ts:466), which is otherwise dead in every other case in
  // this matrix (no two holes/regions ever tie on `(firstPoint.y, firstPoint.x)`
  // -- see the characterization doc's canonical-grid.md:550 note that this
  // equivalence is "asserted plausible but not proven" for this file's specific
  // call site). Two disjoint wedge-shaped occupied triangles that touch at
  // exactly one point (so they remain two separate hole polygons after the
  // occupied union, per the `accepts_occupied_polygons_that_meet_at_one_exact_point`
  // precedent) are constructed so that point is each triangle's own
  // `rotateToStableStart` minimum (lowest y, then lowest x) vertex -- forcing
  // both holes' sorted-array first points to be bit-identical and driving
  // `comparePolygons` all the way to its `localeCompare` fallback.
  {
    caseLabel: 'tied-hole-start-points-exercise-localeCompare-fallback',
    input: computeInput([
      placedPiece(
        'wedge-along-x',
        [point(0, 0), point(1, 0), point(1, 0.1)],
        3,
        3
      ),
      placedPiece(
        'wedge-along-y',
        [point(0, 0), point(0.1, 1), point(0, 1)],
        3,
        3
      )
    ])
  }
]

// ===========================================================================
// 2. Real mixed61-dimension single-piece sweeps: for every distinct fixture
//    piece dimension, place one rectangle at several edge/corner/interior
//    offsets on a sheet sized to comfortably contain it.
// ===========================================================================
for (const dims of mixed61Dimensions) {
  const sheetWidth = dims.width * 2 + 40
  const sheetHeight = dims.height * 2 + 40
  const sheet = new SheetSpec({
    width: sheetWidth,
    height: sheetHeight,
    label: `mixed61-sheet-${dims.width}x${dims.height}`
  })
  const offsets: ReadonlyArray<readonly [string, number, number]> = [
    ['interior', dims.width / 2, dims.height / 2],
    ['left-edge', 0, dims.height / 2],
    ['bottom-edge', dims.width / 2, 0],
    ['right-edge', sheetWidth - dims.width, dims.height / 2],
    ['top-edge', dims.width / 2, sheetHeight - dims.height],
    ['bottom-left-corner', 0, 0]
  ]
  for (const [offsetLabel, translateX, translateY] of offsets) {
    deliberateCases.push({
      caseLabel: `mixed61-${dims.width}x${dims.height}__${offsetLabel}`,
      input: computeInput(
        [rectanglePiece(`mixed61-${dims.width}x${dims.height}`, dims.width, dims.height, translateX, translateY)],
        sheet
      )
    })
  }
}

// ===========================================================================
// 3. Real mixed61-dimension multi-piece randomized layouts: deterministic
//    PRNG places 2-4 rectangles (drawn from real fixture dimensions,
//    including deliberate overlaps and mirrored windings) on a shared sheet.
// ===========================================================================
const random = mulberry32(0x51a1c0de)
function randomInRange(lo: number, hi: number): number {
  return lo + random() * (hi - lo)
}

const RANDOM_LAYOUT_SHEET = new SheetSpec({ width: 400, height: 300, label: 'random-layout-sheet' })
const RANDOM_LAYOUT_COUNT = 110

for (let layoutIndex = 0; layoutIndex < RANDOM_LAYOUT_COUNT; layoutIndex += 1) {
  const pieceCount = 2 + Math.floor(random() * 3) // 2..4
  const placed: IrregularPlacedPiece[] = []
  for (let pieceIndex = 0; pieceIndex < pieceCount; pieceIndex += 1) {
    const dims = mixed61Dimensions[Math.floor(random() * mixed61Dimensions.length)]
    if (dims === undefined) throw new Error('mixed61Dimensions must be non-empty')
    // Scale fixture dimensions down so several pieces fit on the shared sheet.
    const scale = 0.4
    const width = dims.width * scale
    const height = dims.height * scale
    const translateX = randomInRange(0, Math.max(1, RANDOM_LAYOUT_SHEET.width - width))
    const translateY = randomInRange(0, Math.max(1, RANDOM_LAYOUT_SHEET.height - height))
    const mirrored = random() < 0.3
    const ring = mirrored ? clockwiseRectangle(width, height) : rectangle(width, height)
    placed.push(
      placedPiece(`random-${layoutIndex}-${pieceIndex}`, ring, translateX, translateY, mirrored)
    )
  }
  deliberateCases.push({
    caseLabel: `random-layout-${layoutIndex}`,
    input: computeInput(placed, RANDOM_LAYOUT_SHEET)
  })
}

// ===========================================================================
// 4. Malformed-geometry cases: expect a typed IrregularGeometryInputError
//    with `operation: 'computeFreeMaterial'` from every distinct validation
//    branch this file's own `toPlacedPath`/`toSheetPath` can reach.
// ===========================================================================
const malformedCases: ComputeCase[] = [
  {
    caseLabel: 'non-convex-polygon',
    input: computeInput([
      placedPiece(
        'non-convex',
        [point(0, 0), point(4, 0), point(2, 1), point(4, 4), point(0, 4)],
        0,
        0
      )
    ])
  },
  {
    caseLabel: 'too-few-vertices',
    input: computeInput([placedPiece('too-few-vertices', [point(0, 0), point(1, 0)], 0, 0)])
  },
  {
    caseLabel: 'collinear-polygon',
    input: computeInput([
      placedPiece('collinear', [point(0, 0), point(1, 0), point(2, 0)], 0, 0)
    ])
  },
  {
    caseLabel: 'repeated-adjacent-vertex',
    input: computeInput([
      placedPiece('repeated', [point(0, 0), point(1, 0), point(1, 0), point(0, 1)], 0, 0)
    ])
  },
  {
    caseLabel: 'non-finite-coordinate',
    input: computeInput([
      placedPiece('non-finite', [point(0, 0), point(Number.NaN, 0), point(1, 1), point(0, 1)], 0, 0)
    ])
  },
  {
    caseLabel: 'non-finite-translation',
    input: computeInput([rectanglePiece('infinite-translate', 2, 2, Number.POSITIVE_INFINITY, 0)])
  },
  {
    caseLabel: 'ungriddable-translation',
    input: computeInput([rectanglePiece('huge-translate', 2, 2, 1e300, 0)])
  },
  {
    caseLabel: 'coordinate-guard-exceeded',
    input: computeInput([rectanglePiece('guard-exceeded', 2, 2, 2_000_000, 0)])
  },
  {
    // `SheetSpec` is a real validating `Schema.Class` (`Schema.Int`, no
    // explicit upper bound), unlike every other domain class this file
    // constructs -- so this must stay a large *integer* (not `1e300`,
    // which would fail `SheetSpec`'s own schema decode before ever
    // reaching `toSheetPath`). `9.5e12 * CLIPPER2_OFFSET_SCALE (1000) =
    // 9.5e15 > Number.MAX_SAFE_INTEGER (~9.007e15)`, so `toGridMm` itself
    // rejects it.
    caseLabel: 'ungriddable-sheet-dimension',
    input: computeInput(
      [rectanglePiece('any', 2, 2, 0, 0)],
      new SheetSpec({ width: 9_500_000_000_000, height: 8, label: 'ungriddable-sheet' })
    )
  }
]

// ===========================================================================
// Run compute cases through both operations.
// ===========================================================================
interface ComputeVectorCase {
  readonly caseLabel: string
  readonly operation: FreeMaterialOperation
  readonly sheet: ReturnType<typeof encodeSheet>
  readonly placed: ReadonlyArray<ReturnType<typeof encodePlacedPiece>>
  readonly outcome: Outcome
}

const operations: FreeMaterialOperation[] = ['union-then-difference', 'direct-difference']
const computeVectorCases: ComputeVectorCase[] = []

for (const testCase of [...deliberateCases, ...malformedCases]) {
  for (const operation of operations) {
    const outcome = runCompute(operation, testCase.input)
    computeVectorCases.push({
      caseLabel: `${testCase.caseLabel}__${operation}`,
      operation,
      sheet: encodeSheet(testCase.input.sheet),
      placed: testCase.input.placed.map(encodePlacedPiece),
      outcome
    })
  }
}

const deliberateLabels = new Set(deliberateCases.map((c) => c.caseLabel))
const malformedLabels = new Set(malformedCases.map((c) => c.caseLabel))
for (const vectorCase of computeVectorCases) {
  const baseLabel = vectorCase.caseLabel.slice(0, vectorCase.caseLabel.lastIndexOf('__'))
  if (deliberateLabels.has(baseLabel) && !vectorCase.outcome.ok) {
    throw new Error(`deliberate case ${vectorCase.caseLabel} unexpectedly failed: ${JSON.stringify(vectorCase.outcome)}`)
  }
  if (malformedLabels.has(baseLabel) && vectorCase.outcome.ok) {
    throw new Error(`malformed case ${vectorCase.caseLabel} unexpectedly succeeded`)
  }
}

// ===========================================================================
// 5. extendFreeMaterial parent chains: incrementally add pieces via
//    extendFreeMaterial starting from an empty computeFreeMaterial snapshot,
//    recording every step's full input/output for standalone replay.
// ===========================================================================
interface ExtendStepVector {
  readonly stepLabel: string
  readonly parent: ReturnType<typeof encodeSnapshot>
  readonly placed: ReturnType<typeof encodePlacedPiece>
  readonly outcome: Outcome
}

interface ExtendChainVector {
  readonly chainLabel: string
  readonly sheet: ReturnType<typeof encodeSheet>
  readonly steps: ExtendStepVector[]
}

function buildExtendChain(
  chainLabel: string,
  sheet: SheetSpec,
  pieces: ReadonlyArray<IrregularPlacedPiece>
): ExtendChainVector {
  const steps: ExtendStepVector[] = []
  let parentSnapshot = mustSucceed(runCompute('union-then-difference', computeInput([], sheet)))
  let parentPlaced: IrregularPlacedPiece[] = []

  for (const nextPiece of pieces) {
    const parentForStep = decodeSnapshotForReplay(parentSnapshot, sheet)
    const extendInput: ExtendFreeMaterialInput = {
      parent: parentForStep,
      placed: nextPiece,
      settings: DEFAULT_IRREGULAR_GEOMETRY_SETTINGS
    }
    const outcome = runExtend(extendInput)
    steps.push({
      stepLabel: `${chainLabel}__step${steps.length}`,
      parent: parentSnapshot,
      placed: encodePlacedPiece(nextPiece),
      outcome
    })

    if (!outcome.ok) {
      // A step's own failure ends the chain (matches the TS test's own
      // sequencing -- every deliberately-constructed chain here succeeds at
      // every step, but this guards against silently continuing past a
      // failure with a stale parent).
      break
    }

    parentPlaced = [...parentPlaced, nextPiece]
    parentSnapshot = outcome.snapshot
    // Cross-check against full recomputation, matching
    // `tests/unit/freeMaterialService.test.ts`'s `incrementalCases` assertion.
    const fullOutcome = runCompute('union-then-difference', computeInput(parentPlaced, sheet))
    if (!fullOutcome.ok) {
      throw new Error(`${chainLabel}: full recomputation unexpectedly failed after step ${steps.length - 1}`)
    }
    if (JSON.stringify(fullOutcome.snapshot) !== JSON.stringify(parentSnapshot)) {
      throw new Error(
        `${chainLabel}: extendFreeMaterial diverged from full recomputation after step ${steps.length - 1}`
      )
    }
  }

  return { chainLabel, sheet: encodeSheet(sheet), steps }
}

function mustSucceed(outcome: Outcome): ReturnType<typeof encodeSnapshot> {
  if (!outcome.ok) throw new Error(`expected success, got failure: ${JSON.stringify(outcome)}`)
  return outcome.snapshot
}

/** Reconstructs a `FreeMaterialSnapshot` from this script's own bit-encoded
 * form, for feeding back into `extendFreeMaterial` as `parent` -- avoids
 * carrying two independent representations of the same snapshot in memory. */
function decodeSnapshotForReplay(
  encoded: ReturnType<typeof encodeSnapshot>,
  sheet: SheetSpec
): FreeMaterialSnapshot {
  function decodeBits(hex: string): number {
    const stripped = hex.startsWith('0x') ? hex.slice(2) : hex
    const buffer = new ArrayBuffer(8)
    const view = new DataView(buffer)
    for (let i = 0; i < 8; i++) {
      view.setUint8(i, Number.parseInt(stripped.slice(i * 2, i * 2 + 2), 16))
    }
    return view.getFloat64(0, false)
  }
  function decodePolygon(points: ReadonlyArray<{ readonly x: string; readonly y: string }>): IrregularPolygon {
    return new IrregularPolygon({
      points: points.map((p) => point(decodeBits(p.x), decodeBits(p.y)))
    })
  }
  return new FreeMaterialSnapshot({
    sheet,
    regions: encoded.regions.map(
      (region) =>
        new FreeMaterialRegion({
          boundary: decodePolygon(region.boundary),
          holes: region.holes.map(decodePolygon)
        })
    ),
    diagnostics: []
  })
}

const extendChains: ExtendChainVector[] = []

const chainSheet = new SheetSpec({ width: 10, height: 8, label: 'extend-chain-sheet' })
extendChains.push(
  buildExtendChain('disjoint-chain', chainSheet, [
    rectanglePiece('disjoint-left', 2, 2, 1, 1),
    rectanglePiece('disjoint-right', 2, 2, 6, 3)
  ])
)
extendChains.push(
  buildExtendChain('boundary-touching-chain', chainSheet, [
    rectanglePiece('boundary-left', 2, 2, 0, 0),
    rectanglePiece('boundary-right', 2, 2, 2, 0)
  ])
)
extendChains.push(
  buildExtendChain('multiple-regions-and-holes-chain', chainSheet, [
    rectanglePiece('sheet-wall', 2, 8, 4, 0),
    rectanglePiece('left-hole', 2, 2, 1, 1),
    rectanglePiece('right-hole', 2, 2, 7, 4)
  ])
)

// Additional real-dimension chains for volume, one per mixed61 dimension: a
// three-piece incremental build-up on a sheet sized to fit all three without
// exceeding the grid.
for (const dims of mixed61Dimensions) {
  const sheetWidth = dims.width * 3 + 60
  const sheetHeight = dims.height * 2 + 40
  const sheet = new SheetSpec({
    width: sheetWidth,
    height: sheetHeight,
    label: `extend-mixed61-${dims.width}x${dims.height}`
  })
  extendChains.push(
    buildExtendChain(`mixed61-chain-${dims.width}x${dims.height}`, sheet, [
      rectanglePiece(`a-${dims.width}x${dims.height}`, dims.width, dims.height, 0, 0),
      rectanglePiece(`b-${dims.width}x${dims.height}`, dims.width, dims.height, dims.width + 10, 0),
      rectanglePiece(
        `c-${dims.width}x${dims.height}`,
        dims.width,
        dims.height,
        (dims.width + 10) * 2,
        sheetHeight - dims.height
      )
    ])
  )
}

// extendFreeMaterial malformed cases: same validation branches as
// `computeFreeMaterial`, reached through `toMaterialPaths`/`toPlacedPath`
// instead.
interface ExtendMalformedCase {
  readonly caseLabel: string
  readonly parent: FreeMaterialSnapshot
  readonly placed: IrregularPlacedPiece
}

const wholeSheetParent = new FreeMaterialSnapshot({
  sheet: chainSheet,
  regions: [
    new FreeMaterialRegion({
      boundary: new IrregularPolygon({ points: rectangle(10, 8) }),
      holes: []
    })
  ],
  diagnostics: []
})

const extendMalformedCases: ExtendMalformedCase[] = [
  {
    caseLabel: 'extend-non-convex-placed',
    parent: wholeSheetParent,
    placed: placedPiece(
      'extend-non-convex',
      [point(0, 0), point(4, 0), point(2, 1), point(4, 4), point(0, 4)],
      0,
      0
    )
  },
  {
    caseLabel: 'extend-ungriddable-material-boundary',
    parent: new FreeMaterialSnapshot({
      sheet: chainSheet,
      regions: [
        new FreeMaterialRegion({
          boundary: new IrregularPolygon({ points: rectangle(1e300, 1e300) }),
          holes: []
        })
      ],
      diagnostics: []
    }),
    placed: rectanglePiece('extend-placed-ok', 1, 1, 0, 0)
  },
  {
    caseLabel: 'extend-non-finite-placed-translation',
    parent: wholeSheetParent,
    placed: rectanglePiece('extend-infinite-translate', 2, 2, Number.NaN, 0)
  }
]

interface ExtendMalformedVectorCase {
  readonly caseLabel: string
  readonly sheet: ReturnType<typeof encodeSheet>
  readonly parent: ReturnType<typeof encodeSnapshot>
  readonly placed: ReturnType<typeof encodePlacedPiece>
  readonly outcome: Outcome
}

const extendMalformedVectorCases: ExtendMalformedVectorCase[] = extendMalformedCases.map((testCase) => {
  const outcome = runExtend({
    parent: testCase.parent,
    placed: testCase.placed,
    settings: DEFAULT_IRREGULAR_GEOMETRY_SETTINGS
  })
  if (outcome.ok) {
    throw new Error(`extend malformed case ${testCase.caseLabel} unexpectedly succeeded`)
  }
  return {
    caseLabel: testCase.caseLabel,
    sheet: encodeSheet(testCase.parent.sheet),
    parent: encodeSnapshot(testCase.parent),
    placed: encodePlacedPiece(testCase.placed),
    outcome
  }
})

// ===========================================================================
// Vector-count accounting and write-out.
// ===========================================================================
const extendStepVectorCount = extendChains.reduce((total, chain) => total + chain.steps.length, 0)
const totalVectorCount =
  computeVectorCases.length + extendStepVectorCount + extendMalformedVectorCases.length

if (totalVectorCount < 300) {
  throw new Error(`Expected >= 300 free-material vectors, got ${totalVectorCount}.`)
}

mkdirSync(VECTORS_DIR, { recursive: true })
const commit = generatingCommit()

const output = {
  generatedByScript: 'scripts/rust-parity/dump-free-material.ts',
  generatingCommit: commit,
  description:
    'freeMaterialService.ts full port coverage: createFreeMaterialService(...).computeFreeMaterial ' +
    '(both union-then-difference == FreeMaterialServiceLive, and direct-difference) over sheets with ' +
    '0/1/many placed pieces (interior, edge/corner-touching, disjoint, touching-edge, touching-point, ' +
    'overlapping, mirrored-winding, full-coverage, hole-producing, random layouts drawn from real ' +
    'mixed61-request.json piece dimensions) and malformed-geometry error cases, plus ' +
    'createFreeMaterialService(...).extendFreeMaterial parent-chain cases (cross-checked against full ' +
    'computeFreeMaterial recomputation at every step) and their own malformed-geometry error cases. f64 ' +
    'values are recorded as big-endian IEEE-754 bit-pattern hex strings for bit-exact comparison.',
  computeCaseCount: computeVectorCases.length,
  computeCases: computeVectorCases,
  extendChainCount: extendChains.length,
  extendStepVectorCount,
  extendChains,
  extendMalformedCaseCount: extendMalformedVectorCases.length,
  extendMalformedCases: extendMalformedVectorCases,
  totalVectorCount
}

writeFileSync(join(VECTORS_DIR, 'free-material.json'), JSON.stringify(output, null, 2) + '\n')

console.log(
  `Wrote ${computeVectorCases.length} compute cases, ${extendChains.length} extend chains ` +
    `(${extendStepVectorCount} step vectors), and ${extendMalformedVectorCases.length} extend malformed ` +
    `cases (${totalVectorCount} total vectors, commit ${commit}) to ${VECTORS_DIR}`
)
