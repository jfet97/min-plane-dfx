/**
 * Differential-vector dump for the Rust `search::beam_state` module
 * (`crates/irregular-nesting-native/src/search/beam_state.rs`).
 *
 * Imports the REAL production TS entry points --
 *   - `IrregularBeamState`, `canonicalCollisionPolygonKey`
 *     (`src/workers/algorithm/irregular/irregularBeamState.ts`) --
 * constructs real `IrregularBeamState` instances by replaying placement
 * (and unplacement) sequences built from real mixed61 fixture-piece rings
 * (plus a handful of synthetic touching/degenerate/`-0` shapes), and records:
 *
 *   - every `canonicalCollisionPolygonKey` value computed directly (ring-key
 *     byte-exact section) plus ring-key invariance sweeps (rotated start
 *     vertex / reversed winding / translation all producing the identical
 *     key);
 *   - a full `IrregularBeamState` snapshot after every step of many
 *     `withPlacement`/`withUnplacedPiece` chains (occupied-geometry key,
 *     translated bounds, shared-boundary/contact metrics, continuation
 *     identities, `withBottomLeftAnchored`/`bottomLeftAnchoredCanonicalOccupiedGeometryKey`/
 *     `withQuarterTurnBottomLeft` results);
 *   - dedicated `-0`-producing coordinate/translation cases;
 *   - a dedup section proving two states built from the same placed-piece
 *     set in different insertion orders share one `canonicalOccupiedGeometryKey`.
 *
 * Every case records the raw input the TS function consumed (`f64` fields as
 * big-endian IEEE-754 bit-pattern hex strings, per `dump-predicates.ts`'s
 * `f64Bits` convention) **and** the resulting value(s), so the Rust test
 * replays the identical input through its own port rather than a
 * pre-rendered string.
 *
 * Run with:
 *   pnpm exec tsx --tsconfig tsconfig.node.json scripts/rust-parity/dump-beam-state.ts
 *
 * Output (additive; never edits existing fixtures/tests):
 *   - crates/irregular-nesting-native/tests/vectors/beam-state.json
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PieceId } from '../../src/shared/domain/ids.js'
import {
  IrregularPlacedPiece,
  IrregularPlacement,
  IrregularPoint,
  IrregularPolygon,
  IrregularTransform,
  IrregularTransformCandidate,
  TransformedCollisionGeometry
} from '../../src/shared/irregular/domain.js'
import {
  canonicalCollisionPolygonKey,
  IrregularBeamState
} from '../../src/workers/algorithm/irregular/irregularBeamState.js'

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
// f64 -> exact bit pattern (matches dump-predicates.ts's/dump-canonical-layout.ts's
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

function point(x: number, y: number): IrregularPoint {
  return new IrregularPoint({ x, y })
}

// ---------------------------------------------------------------------------
// Real mixed61 fixture-piece rings (mirrors dump-canonical-layout.ts's
// `loadRealRings`).
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

const realRings = loadRealRings()
if (realRings.length < 20) {
  throw new Error(`Expected many real all-line rings, got ${realRings.length}.`)
}

function rectangle(width: number, height: number): IrregularPoint[] {
  return [point(0, 0), point(width, 0), point(width, height), point(0, height)]
}

// ---------------------------------------------------------------------------
// `IrregularPlacedPiece` construction (mirrors dump-canonical-layout.ts's
// `placedPiece` helper -- the same real domain classes).
// ---------------------------------------------------------------------------
let placedPieceCounter = 0
const REASONS = ['orthogonal', 'edge_alignment', 'configured'] as const

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
  options?: {
    readonly rotationDeg?: number
    readonly mirrored?: boolean
    readonly transformIndex?: number
    readonly reasonIndex?: number
  }
): IrregularPlacedPiece {
  placedPieceCounter += 1
  const pieceId = PieceId.make(`${label}-${placedPieceCounter}`)
  const polygon = new IrregularPolygon({ points })
  const rotationDeg = options?.rotationDeg ?? 0
  const mirrored = options?.mirrored ?? false
  const transformIndex = options?.transformIndex ?? 0
  const reason = REASONS[(options?.reasonIndex ?? 2) % REASONS.length] as (typeof REASONS)[number]
  return new IrregularPlacedPiece({
    placement: new IrregularPlacement({
      sourcePieceId: pieceId,
      transform: new IrregularTransform({ translateX, translateY, rotationDeg, mirrored })
    }),
    collisionGeometry: new TransformedCollisionGeometry({
      sourcePieceId: pieceId,
      transform: new IrregularTransformCandidate({
        index: transformIndex,
        rotationDeg,
        mirrored,
        reason
      }),
      polygon,
      bounds: boundsOf(points)
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
  readonly width: string
  readonly height: string
}
function encodeCollisionBounds(
  bounds:
    | {
        readonly minX: number
        readonly minY: number
        readonly maxX: number
        readonly maxY: number
        readonly width: number
        readonly height: number
      }
    | undefined
): EncodedBounds | null {
  if (bounds === undefined) return null
  return {
    minX: f64Bits(bounds.minX),
    minY: f64Bits(bounds.minY),
    maxX: f64Bits(bounds.maxX),
    maxY: f64Bits(bounds.maxY),
    width: f64Bits(bounds.width),
    height: f64Bits(bounds.height)
  }
}

function encodeOptionalNumber(value: number | undefined): string | null {
  return value === undefined ? null : f64Bits(value)
}

function encodeOptionalString(value: string | undefined): { present: boolean; value: string | null } {
  return value === undefined ? { present: false, value: null } : { present: true, value }
}

interface EncodedTransform {
  readonly translateX: string
  readonly translateY: string
  readonly rotationDeg: string
  readonly mirrored: boolean
}
interface EncodedTransformCandidate {
  readonly index: string
  readonly rotationDeg: string
  readonly mirrored: boolean
  readonly reason: string
}
interface EncodedPlacedPiece {
  readonly pieceId: string
  readonly points: EncodedPoint[]
  readonly placement: EncodedTransform
  readonly collisionTransform: EncodedTransformCandidate
}
function encodePlacedPiece(piece: IrregularPlacedPiece): EncodedPlacedPiece {
  return {
    pieceId: piece.placement.sourcePieceId,
    points: encodePoints(piece.collisionGeometry.polygon.points),
    placement: {
      translateX: f64Bits(piece.placement.transform.translateX),
      translateY: f64Bits(piece.placement.transform.translateY),
      rotationDeg: f64Bits(piece.placement.transform.rotationDeg),
      mirrored: piece.placement.transform.mirrored
    },
    collisionTransform: {
      index: f64Bits(piece.collisionGeometry.transform.index),
      rotationDeg: f64Bits(piece.collisionGeometry.transform.rotationDeg),
      mirrored: piece.collisionGeometry.transform.mirrored,
      reason: piece.collisionGeometry.transform.reason
    }
  }
}

interface EncodedQuarterTurnResult {
  readonly present: boolean
  readonly canonicalOccupiedGeometryKey?: string
  readonly translatedCollisionBounds?: EncodedBounds | null
  readonly placedPieces?: EncodedPlacedPiece[]
}
function encodeQuarterTurnResult(result: IrregularBeamState | undefined): EncodedQuarterTurnResult {
  if (result === undefined) return { present: false }
  return {
    present: true,
    canonicalOccupiedGeometryKey: result.canonicalOccupiedGeometryKey,
    translatedCollisionBounds: encodeCollisionBounds(result.translatedCollisionBounds),
    placedPieces: result.placedCollisionGeometries.map(encodePlacedPiece)
  }
}

interface EncodedStateSnapshot {
  readonly canonicalOccupiedGeometryKey: string
  readonly translatedCollisionBounds: EncodedBounds | null
  readonly sharedCollisionBoundaryLengthMm: string | null
  readonly sharedCollisionBoundaryContactUnits: string | null
  readonly nearCompleteStructuralContactCount: string | null
  readonly dominantNearCompleteStructuralContactCount: string | null
  readonly unplacedPieceIds: string[]
  readonly unplacedSourcePieceIds: string[]
  readonly placementOrder: string[]
  readonly canonicalEntryContinuationIdentity: string
  readonly contactSignatureContinuationIdentity: { present: boolean; value: string | null }
  readonly continuationMetadataIdentity: string
  readonly bottomLeftAnchored: EncodedQuarterTurnResult
  readonly bottomLeftAnchoredProjectionKey: string | null
  readonly quarterTurn90: EncodedQuarterTurnResult
  readonly quarterTurn180: EncodedQuarterTurnResult
  readonly quarterTurn270: EncodedQuarterTurnResult
}

function encodeSnapshot(state: IrregularBeamState): EncodedStateSnapshot {
  const bottomLeftAnchoredProjection = state.bottomLeftAnchoredCanonicalOccupiedGeometryKey()
  return {
    canonicalOccupiedGeometryKey: state.canonicalOccupiedGeometryKey,
    translatedCollisionBounds: encodeCollisionBounds(state.translatedCollisionBounds),
    sharedCollisionBoundaryLengthMm: encodeOptionalNumber(state.sharedCollisionBoundaryLengthMm),
    sharedCollisionBoundaryContactUnits: encodeOptionalNumber(
      state.sharedCollisionBoundaryContactUnits
    ),
    nearCompleteStructuralContactCount: encodeOptionalNumber(
      state.nearCompleteStructuralContactCount
    ),
    dominantNearCompleteStructuralContactCount: encodeOptionalNumber(
      state.dominantNearCompleteStructuralContactCount
    ),
    unplacedPieceIds: [...state.unplacedPieceIds],
    unplacedSourcePieceIds: [...state.unplacedSourcePieceIds],
    placementOrder: [...state.placementOrder],
    canonicalEntryContinuationIdentity: state.canonicalEntryContinuationIdentity(),
    contactSignatureContinuationIdentity: encodeOptionalString(
      state.contactSignatureContinuationIdentity()
    ),
    continuationMetadataIdentity: state.continuationMetadataIdentity(),
    bottomLeftAnchored: encodeQuarterTurnResult(state.withBottomLeftAnchored()),
    bottomLeftAnchoredProjectionKey: bottomLeftAnchoredProjection ?? null,
    quarterTurn90: encodeQuarterTurnResult(state.withQuarterTurnBottomLeft(90)),
    quarterTurn180: encodeQuarterTurnResult(state.withQuarterTurnBottomLeft(180)),
    quarterTurn270: encodeQuarterTurnResult(state.withQuarterTurnBottomLeft(270))
  }
}

// ---------------------------------------------------------------------------
// Section A: ring-key byte-exact values (`canonicalCollisionPolygonKey`).
// ---------------------------------------------------------------------------
interface RingKeyValueCase {
  readonly category: string
  readonly points: EncodedPoint[]
  readonly translateX: string
  readonly translateY: string
  readonly key: string
}
const ringKeyValueCases: RingKeyValueCase[] = []

function recordRingKeyValue(category: string, points: ReadonlyArray<IrregularPoint>, tx: number, ty: number): void {
  ringKeyValueCases.push({
    category,
    points: encodePoints(points),
    translateX: f64Bits(tx),
    translateY: f64Bits(ty),
    key: canonicalCollisionPolygonKey(points, tx, ty)
  })
}

{
  // Every real fixture ring at several translations, including negative,
  // fractional, and `-0` translations.
  const translations: ReadonlyArray<[string, number, number]> = [
    ['zero', 0, 0],
    ['positive', 137.5, 42.25],
    ['negative', -50.125, -19.75],
    ['negative-zero-both-axes', -0, -0],
    ['negative-zero-x-only', -0, 0],
    ['negative-zero-y-only', 0, -0]
  ]
  for (const ring of realRings) {
    for (const [label, tx, ty] of translations) {
      recordRingKeyValue(`fixture:${ring.label}:translate=${label}`, ring.points, tx, ty)
    }
  }

  // Empty ring, single point, two points (degenerate rings the algorithm
  // must still key deterministically without throwing).
  recordRingKeyValue('empty-ring', [], 0, 0)
  recordRingKeyValue('single-point', [point(5, -5)], 3, 3)
  recordRingKeyValue('two-points', [point(0, 0), point(4, 4)], 0, 0)

  // NaN/Infinity coordinates -- `canonicalNumber`'s special-token branches.
  recordRingKeyValue('nan-coordinate', [point(NaN, 0), point(1, 0), point(1, 1)], 0, 0)
  recordRingKeyValue(
    'infinity-coordinates',
    [point(Infinity, 0), point(-Infinity, 0), point(0, 1)],
    0,
    0
  )
}

// ---------------------------------------------------------------------------
// Section B: ring-key invariance sweeps (rotation/winding/translation).
// ---------------------------------------------------------------------------
// Every variant is recorded as `{ label, key }` **and** the invariance sweep
// records `points`/`translateX`/`translateY` for the *base* ring only: each
// variant's own point array is a pure, cheaply-Rust-reproducible function of
// the base points (`rotatedStart(points, offset)`/`reversedRing(points)`,
// both ported trivially as slice rotations/reversals, not novel geometry),
// so the Rust test independently rebuilds every variant's point array from
// the one recorded base ring rather than needing each variant's full point
// array duplicated in the fixture -- while still recomputing every key
// (base and every variant) from raw points through Rust's own
// `canonical_collision_polygon_key`, never merely comparing two
// TS-precomputed strings against each other.
interface RingKeyInvarianceCase {
  readonly category: string
  readonly points: EncodedPoint[]
  readonly translateX: string
  readonly translateY: string
  readonly baseKey: string
  readonly variants: ReadonlyArray<{ readonly label: string; readonly key: string }>
}
const ringKeyInvarianceCases: RingKeyInvarianceCase[] = []

function rotatedStart(points: ReadonlyArray<IrregularPoint>, offset: number): IrregularPoint[] {
  const n = points.length
  return points.map((_, index) => points[(index + offset) % n] as IrregularPoint)
}
function reversedRing(points: ReadonlyArray<IrregularPoint>): IrregularPoint[] {
  return [...points].reverse()
}

function recordInvariance(category: string, points: ReadonlyArray<IrregularPoint>, tx: number, ty: number): void {
  const baseKey = canonicalCollisionPolygonKey(points, tx, ty)
  const variants: Array<{ label: string; key: string }> = []
  for (let offset = 1; offset < points.length; offset += 1) {
    variants.push({
      label: `rotated-start-${offset}`,
      key: canonicalCollisionPolygonKey(rotatedStart(points, offset), tx, ty)
    })
  }
  variants.push({
    label: 'reversed-winding',
    key: canonicalCollisionPolygonKey(reversedRing(points), tx, ty)
  })
  for (let offset = 1; offset < points.length; offset += 1) {
    variants.push({
      label: `reversed-winding-rotated-start-${offset}`,
      key: canonicalCollisionPolygonKey(rotatedStart(reversedRing(points), offset), tx, ty)
    })
  }
  ringKeyInvarianceCases.push({
    category,
    points: encodePoints(points),
    translateX: f64Bits(tx),
    translateY: f64Bits(ty),
    baseKey,
    variants
  })
}

{
  for (const ring of realRings) {
    recordInvariance(`fixture:${ring.label}`, ring.points, 0, 0)
    recordInvariance(`fixture:${ring.label}:translated`, ring.points, 11.5, -7.25)
  }
  // Synthetic shapes: square, triangle, an irregular pentagon.
  recordInvariance('square', rectangle(10, 6), 0, 0)
  recordInvariance('triangle', [point(0, 0), point(4, 0), point(2, 3)], 0, 0)
  recordInvariance(
    'irregular-pentagon',
    [point(0, 0), point(5, 0), point(6, 3), point(2.5, 5), point(-1, 3)],
    -2,
    9
  )
  // A point-symmetric (fully self-symmetric under offset) ring: every offset
  // ties, so `forwardWins` must stay `true` -- both direction sweeps should
  // yield zero variants recorded but the base key itself is still asserted
  // stable by re-computing it independently in Rust.
  recordInvariance('point-symmetric-square', rectangle(4, 4), 0, 0)
}

// ---------------------------------------------------------------------------
// Section C: state chains -- `withPlacement`/`withUnplacedPiece` sequences.
// ---------------------------------------------------------------------------
type ChainStep =
  | { readonly kind: 'place'; readonly piece: IrregularPlacedPiece; readonly placementOrderPieceId: string }
  | { readonly kind: 'unplace'; readonly unplacedPieceId: string }

interface EncodedStepResult {
  readonly kind: 'place' | 'unplace'
  readonly placedPiece?: EncodedPlacedPiece
  readonly placementOrderPieceId?: string
  readonly unplacedPieceId?: string
  readonly snapshotAfter: EncodedStateSnapshot
}
interface ChainCase {
  readonly category: string
  readonly initialSnapshot: EncodedStateSnapshot
  readonly steps: EncodedStepResult[]
}
const chainCases: ChainCase[] = []

function runChain(category: string, steps: ReadonlyArray<ChainStep>): void {
  let state = IrregularBeamState.empty([])
  const initialSnapshot = encodeSnapshot(state)
  const encodedSteps: EncodedStepResult[] = []
  for (const step of steps) {
    if (step.kind === 'place') {
      state = state.withPlacement({
        remainingPreparedPieces: [],
        placedCollisionGeometry: step.piece,
        placementOrderPieceId: PieceId.make(step.placementOrderPieceId)
      })
      encodedSteps.push({
        kind: 'place',
        placedPiece: encodePlacedPiece(step.piece),
        placementOrderPieceId: step.placementOrderPieceId,
        snapshotAfter: encodeSnapshot(state)
      })
    } else {
      state = state.withUnplacedPiece({
        remainingPreparedPieces: [],
        unplacedPieceId: PieceId.make(step.unplacedPieceId)
      })
      encodedSteps.push({
        kind: 'unplace',
        unplacedPieceId: step.unplacedPieceId,
        snapshotAfter: encodeSnapshot(state)
      })
    }
  }
  chainCases.push({ category, initialSnapshot, steps: encodedSteps })
}

{
  // C1: non-touching chains of increasing length (1..10), built from
  // consecutive real fixture rings placed on a generous grid so bounding
  // boxes never overlap or touch.
  for (let length = 1; length <= 10; length += 1) {
    const steps: ChainStep[] = []
    for (let index = 0; index < length; index += 1) {
      const ring = realRings[index % realRings.length] as RealRing
      const gridX = (index % 5) * 400
      const gridY = Math.floor(index / 5) * 400
      const piece = placedPiece(`chain-a-len${length}`, ring.points, gridX, gridY, {
        reasonIndex: index
      })
      steps.push({
        kind: 'place',
        piece,
        placementOrderPieceId: piece.placement.sourcePieceId
      })
    }
    runChain(`non-touching:length=${length}`, steps)
  }

  // C2: touching rectangle chains -- pieces placed edge-to-edge so
  // `sharedCollisionBoundaryLengthMm`/contact metrics are exercised on the
  // defined (non-`undefined`) happy path.
  const rectangleSizes: ReadonlyArray<[number, number]> = [
    [10, 6],
    [8, 8],
    [12, 4],
    [6, 10],
    [9, 9],
    [15, 3]
  ]
  for (let chainIndex = 0; chainIndex < rectangleSizes.length; chainIndex += 1) {
    const [width, height] = rectangleSizes[chainIndex] as [number, number]
    const steps: ChainStep[] = []
    let cursorX = 0
    for (let index = 0; index < 5; index += 1) {
      const piece = placedPiece(`chain-b-${chainIndex}`, rectangle(width, height), cursorX, 0, {
        reasonIndex: index
      })
      steps.push({
        kind: 'place',
        piece,
        placementOrderPieceId: piece.placement.sourcePieceId
      })
      cursorX += width // exact edge touch with the next rectangle
    }
    runChain(`touching-rectangles:chain=${chainIndex}`, steps)
  }

  // C2b: an "L-shaped" touching cluster (touches on two sides at once for
  // the last piece), stacking rows too.
  {
    const steps: ChainStep[] = []
    const a = placedPiece('chain-l', rectangle(10, 10), 0, 0, { reasonIndex: 0 })
    const b = placedPiece('chain-l', rectangle(10, 10), 10, 0, { reasonIndex: 1 })
    const c = placedPiece('chain-l', rectangle(10, 10), 0, 10, { reasonIndex: 2 })
    const d = placedPiece('chain-l', rectangle(10, 10), 10, 10, { reasonIndex: 0 })
    for (const piece of [a, b, c, d]) {
      steps.push({ kind: 'place', piece, placementOrderPieceId: piece.placement.sourcePieceId })
    }
    runChain('touching-rectangles:2x2-cluster', steps)
  }

  // C3: touching chains built from REAL (possibly non-convex) fixture
  // rings placed edge-to-edge by their bounding box -- deliberately may
  // trigger the "sticky undefined" shared-boundary-metrics propagation
  // (`search-scoring.md` §4.3) when a ring fails strict convex validation.
  for (let chainIndex = 0; chainIndex < 6; chainIndex += 1) {
    const steps: ChainStep[] = []
    let cursorX = 0
    for (let index = 0; index < 4; index += 1) {
      const ring = realRings[(chainIndex * 4 + index) % realRings.length] as RealRing
      const bounds = boundsOf(ring.points)
      const piece = placedPiece(`chain-c-${chainIndex}`, ring.points, cursorX - bounds.minX, -bounds.minY, {
        reasonIndex: index
      })
      steps.push({ kind: 'place', piece, placementOrderPieceId: piece.placement.sourcePieceId })
      cursorX += bounds.maxX - bounds.minX
    }
    runChain(`touching-real-fixture-rings:chain=${chainIndex}`, steps)
  }

  // C4: chains with interspersed `withUnplacedPiece` steps -- bounds/metrics
  // must carry through unchanged.
  for (let chainIndex = 0; chainIndex < 4; chainIndex += 1) {
    const steps: ChainStep[] = []
    for (let index = 0; index < 4; index += 1) {
      const ring = realRings[(chainIndex * 3 + index) % realRings.length] as RealRing
      const piece = placedPiece(`chain-d-${chainIndex}`, ring.points, index * 300, chainIndex * 300, {
        reasonIndex: index
      })
      steps.push({ kind: 'place', piece, placementOrderPieceId: piece.placement.sourcePieceId })
      steps.push({ kind: 'unplace', unplacedPieceId: `skipped-${chainIndex}-${index}` })
    }
    runChain(`interspersed-unplaced:chain=${chainIndex}`, steps)
  }

  // C5: rotated/mirrored placement metadata (rotationDeg/mirrored on the
  // transform candidate) threaded through `withQuarterTurnBottomLeft`'s
  // `rotationDeg` summation and `normalizeRotationDegrees`.
  for (const [label, rotationDeg] of [
    ['zero', 0],
    ['ninety', 90],
    ['one-eighty', 180],
    ['two-seventy', 270],
    ['already-360', 360],
    ['negative-ninety', -90]
  ] as const) {
    const steps: ChainStep[] = []
    for (let index = 0; index < 3; index += 1) {
      const ring = realRings[index % realRings.length] as RealRing
      const piece = placedPiece(`chain-e-${label}`, ring.points, index * 250, 0, {
        rotationDeg,
        mirrored: index % 2 === 0,
        reasonIndex: index
      })
      steps.push({ kind: 'place', piece, placementOrderPieceId: piece.placement.sourcePieceId })
    }
    runChain(`rotation-metadata:initial-rotation=${label}`, steps)
  }

  // C6: a placement with a non-finite translation, exercising the
  // `translatedCollisionBounds === undefined` short-circuit branch of
  // `withBottomLeftAnchored`/`bottomLeftAnchoredCanonicalOccupiedGeometryKey`/
  // `withQuarterTurnBottomLeft` (`irregularBeamState.ts:289,359-361`) --
  // TS returns the CURRENT instance (resp. its already-defined
  // `canonicalOccupiedGeometryKey`) unchanged in this branch, it does NOT
  // return `undefined`. A second, ordinary placement proves the "sticky
  // undefined" bounds (`extendCollisionBounds`'s `current === undefined`
  // short-circuit, `irregularBeamState.ts:911`) persists once poisoned.
  {
    const steps: ChainStep[] = []
    const ring = realRings[0] as RealRing
    const nonFinitePiece = placedPiece('chain-f-non-finite-bounds', ring.points, Infinity, 0, {
      reasonIndex: 0
    })
    steps.push({
      kind: 'place',
      piece: nonFinitePiece,
      placementOrderPieceId: nonFinitePiece.placement.sourcePieceId
    })
    const secondRing = realRings[1] as RealRing
    const secondPiece = placedPiece('chain-f-non-finite-bounds', secondRing.points, 500, 500, {
      reasonIndex: 1
    })
    steps.push({
      kind: 'place',
      piece: secondPiece,
      placementOrderPieceId: secondPiece.placement.sourcePieceId
    })
    runChain('non-finite-translated-bounds', steps)
  }
}

// ---------------------------------------------------------------------------
// Section D: `-0`-producing coordinates/translations.
// ---------------------------------------------------------------------------
interface NegativeZeroCase {
  readonly category: string
  readonly points: EncodedPoint[]
  readonly translateX: string
  readonly translateY: string
  readonly key: string
  readonly comparisonPoints: EncodedPoint[]
  readonly comparisonTranslateX: string
  readonly comparisonTranslateY: string
  readonly comparisonKey: string
}
const negativeZeroCases: NegativeZeroCase[] = []

function recordNegativeZero(
  category: string,
  points: ReadonlyArray<IrregularPoint>,
  tx: number,
  ty: number,
  comparisonPoints: ReadonlyArray<IrregularPoint>,
  comparisonTx: number,
  comparisonTy: number
): void {
  negativeZeroCases.push({
    category,
    points: encodePoints(points),
    translateX: f64Bits(tx),
    translateY: f64Bits(ty),
    key: canonicalCollisionPolygonKey(points, tx, ty),
    comparisonPoints: encodePoints(comparisonPoints),
    comparisonTranslateX: f64Bits(comparisonTx),
    comparisonTranslateY: f64Bits(comparisonTy),
    comparisonKey: canonicalCollisionPolygonKey(comparisonPoints, comparisonTx, comparisonTy)
  })
}

{
  // D1: literal `-0` coordinate summed with a literal `-0` translation --
  // the only addition-based path that produces a true `-0` sum
  // (`(-0) + (-0) === -0`; every other zero-sign combination yields `+0`).
  const negZeroPoints = [point(-0, -0), point(4, -0), point(4, 4), point(-0, 4)]
  recordNegativeZero(
    'both-operands-negative-zero',
    negZeroPoints,
    -0,
    -0,
    [point(0, 0), point(4, 0), point(4, 4), point(0, 4)],
    0,
    0
  )

  // D2: a tiny negative sub-grid coordinate whose
  // `canonicalizeIrregularScoreMillimeterUnits` rounds to grid magnitude
  // `0`, producing a literal `-0` grid value via `Math.sign(x) * 0` (the
  // realistic, most-likely-to-occur `-0` source in this cluster -- see
  // this dump script's own top doc).
  const tinyNegativePoints = [point(-0.0000001, 0), point(4, 0), point(4, 4), point(0, 4)]
  recordNegativeZero(
    'tiny-negative-rounds-to-negative-zero-grid-unit',
    tinyNegativePoints,
    0,
    0,
    [point(0, 0), point(4, 0), point(4, 4), point(0, 4)],
    0,
    0
  )

  // D3: same tiny-negative hazard reached through the translation instead
  // of the vertex coordinate.
  const zeroVertexPoints = [point(0, 0), point(4, 0), point(4, 4), point(0, 4)]
  recordNegativeZero(
    'tiny-negative-translation-rounds-to-negative-zero-grid-unit',
    zeroVertexPoints,
    -0.0000001,
    0,
    zeroVertexPoints,
    0,
    0
  )

  // D4: quarter-turn rotation's own `-point.x`/`-point.y` negation must NOT
  // leak `-0` into a later canonical key -- confirmed by chaining a real
  // `withQuarterTurnBottomLeft` rotation through this dump script's state
  // machinery (Section E) rather than here; this section only covers the
  // direct `canonicalCollisionPolygonKey` entry point.
  recordNegativeZero(
    'negative-zero-only-on-y-translation',
    zeroVertexPoints,
    0,
    -0,
    zeroVertexPoints,
    0,
    0
  )
}

// ---------------------------------------------------------------------------
// Section E: dedup identity -- same placed-piece set, different insertion
// order, must share one `canonicalOccupiedGeometryKey`.
// ---------------------------------------------------------------------------
interface DedupCase {
  readonly category: string
  readonly orderA: EncodedPlacedPiece[]
  readonly orderB: EncodedPlacedPiece[]
  readonly keyA: string
  readonly keyB: string
}
const dedupCases: DedupCase[] = []

{
  for (let setIndex = 0; setIndex < 6; setIndex += 1) {
    const pieces: IrregularPlacedPiece[] = []
    for (let index = 0; index < 5; index += 1) {
      const ring = realRings[(setIndex * 5 + index) % realRings.length] as RealRing
      pieces.push(
        placedPiece(`dedup-${setIndex}`, ring.points, index * 350, setIndex * 350, {
          reasonIndex: index
        })
      )
    }
    const forward = pieces
    const reversedOrder = [...pieces].reverse()
    // A third, shuffled order (rotate by 2).
    const shuffled = [...pieces.slice(2), ...pieces.slice(0, 2)]

    const stateForward = IrregularBeamState.empty([])
    let acc = stateForward
    for (const piece of forward) {
      acc = acc.withPlacement({
        remainingPreparedPieces: [],
        placedCollisionGeometry: piece,
        placementOrderPieceId: piece.placement.sourcePieceId
      })
    }
    const stateReversed = IrregularBeamState.empty([])
    let accReversed = stateReversed
    for (const piece of reversedOrder) {
      accReversed = accReversed.withPlacement({
        remainingPreparedPieces: [],
        placedCollisionGeometry: piece,
        placementOrderPieceId: piece.placement.sourcePieceId
      })
    }
    dedupCases.push({
      category: `set=${setIndex}:forward-vs-reversed`,
      orderA: forward.map(encodePlacedPiece),
      orderB: reversedOrder.map(encodePlacedPiece),
      keyA: acc.canonicalOccupiedGeometryKey,
      keyB: accReversed.canonicalOccupiedGeometryKey
    })

    const stateShuffled = IrregularBeamState.empty([])
    let accShuffled = stateShuffled
    for (const piece of shuffled) {
      accShuffled = accShuffled.withPlacement({
        remainingPreparedPieces: [],
        placedCollisionGeometry: piece,
        placementOrderPieceId: piece.placement.sourcePieceId
      })
    }
    dedupCases.push({
      category: `set=${setIndex}:forward-vs-shuffled`,
      orderA: forward.map(encodePlacedPiece),
      orderB: shuffled.map(encodePlacedPiece),
      keyA: acc.canonicalOccupiedGeometryKey,
      keyB: accShuffled.canonicalOccupiedGeometryKey
    })
  }
}

// ---------------------------------------------------------------------------
// Assemble + write output.
// ---------------------------------------------------------------------------
const totalCaseCount =
  ringKeyValueCases.length +
  ringKeyInvarianceCases.length +
  chainCases.reduce((sum, chain) => sum + chain.steps.length, 0) +
  negativeZeroCases.length +
  dedupCases.length

if (totalCaseCount < 500) {
  throw new Error(`Expected at least 500 total beam-state vectors, generated only ${totalCaseCount}.`)
}

mkdirSync(VECTORS_DIR, { recursive: true })

const commit = generatingCommit()

const output = {
  generatedByScript: 'scripts/rust-parity/dump-beam-state.ts',
  generatingCommit: commit,
  sourceModules: ['src/workers/algorithm/irregular/irregularBeamState.ts'],
  description:
    'IrregularBeamState replayed over real mixed61 fixture-piece rings (plus a handful of ' +
    'synthetic touching/degenerate/-0 shapes): canonicalCollisionPolygonKey byte-exact values, ' +
    'ring-key rotation/winding invariance sweeps, full state snapshots after every ' +
    'withPlacement/withUnplacedPiece chain step (occupied-geometry key, translated bounds, ' +
    'shared-boundary/contact metrics, continuation identities, withBottomLeftAnchored/' +
    'bottomLeftAnchoredCanonicalOccupiedGeometryKey/withQuarterTurnBottomLeft results), ' +
    '-0-producing coordinate/translation cases, and insertion-order dedup-identity proofs.',
  totalCaseCount,
  ringKeyValues: {
    caseCount: ringKeyValueCases.length,
    cases: ringKeyValueCases
  },
  ringKeyInvariance: {
    caseCount: ringKeyInvarianceCases.length,
    cases: ringKeyInvarianceCases
  },
  chains: {
    chainCount: chainCases.length,
    stepCount: chainCases.reduce((sum, chain) => sum + chain.steps.length, 0),
    cases: chainCases
  },
  negativeZero: {
    caseCount: negativeZeroCases.length,
    cases: negativeZeroCases
  },
  dedup: {
    caseCount: dedupCases.length,
    cases: dedupCases
  }
}

writeFileSync(join(VECTORS_DIR, 'beam-state.json'), JSON.stringify(output, null, 2) + '\n')

console.log(
  `Wrote ${totalCaseCount} beam-state vectors ` +
    `(ringKeyValues=${ringKeyValueCases.length}, ringKeyInvariance=${ringKeyInvarianceCases.length}, ` +
    `chainSteps=${chainCases.reduce((sum, chain) => sum + chain.steps.length, 0)} across ` +
    `${chainCases.length} chains, negativeZero=${negativeZeroCases.length}, dedup=${dedupCases.length}; ` +
    `commit ${commit}) to ${VECTORS_DIR}`
)
