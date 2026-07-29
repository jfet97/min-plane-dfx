/**
 * Differential-vector generator for the Compact Short Side cluster:
 *   - `crates/irregular-nesting-native/src/short_side/axes.rs`
 *   - `crates/irregular-nesting-native/src/short_side/observer.rs`
 *   - `crates/irregular-nesting-native/src/short_side/pair_fold.rs`
 *   - `crates/irregular-nesting-native/src/short_side/contact_strip.rs`
 *
 * Imports the REAL production TS entry points --
 *   `intrinsicShortSideAxes`/`intrinsicShortSideSpan`
 *   (`src/workers/algorithm/irregular/intrinsicShortSideAxes.ts`),
 *   `observeIntrinsicShortSideOrientations`
 *   (`intrinsicShortSideObserver.ts`),
 *   `observeIntrinsicShortSidePairFold` (`intrinsicShortSidePairFoldObserver.ts`),
 *   `constructIntrinsicShortSideContactStrip` (`intrinsicShortSideContactStrip.ts`)
 * -- and evaluates the three Effect-based entry points through the REAL
 * `GeometryKernel.Live` / `GeometrySettings.Live` / `NfpIfpServiceLive`
 * service layer stack, `Effect.runSyncExit`, matching `dump-capacity-search.ts`'s
 * and `dump-strict-decoder.ts`'s own established pattern for this exact
 * layer stack.
 *
 * Determinism: every pair-fold/contact-strip call supplies its own
 * `runtimeControl.now`/`currentRssBytes` seam -- deterministic incrementing
 * counters (see `makeClock`/`makeRssClock`) -- so `runtimeMs`/
 * `peakRssDeltaBytes` are byte-exact, reproducible outputs, not real
 * wall-clock/RSS noise. A dedicated battery of cases sets
 * `maximumRuntimeMs: 0` / `maximumRssDeltaBytes: 0` against those same
 * injected clocks to deterministically trip `deadline`/`memory-cap` on the
 * very first cooperative checkpoint.
 *
 * Fixtures: real mixed61 convex-hull pieces (`computeConvexHull` over
 * `tests/fixtures/irregularSheetInvariance/mixed61-request.json` segment
 * endpoints -- the same technique `dump-capacity-search.ts`/
 * `dump-strict-decoder.ts` use) for pair-fold/contact-strip/observer cases,
 * plus a dense sweep of plain `{width, height}` sheets (including squares)
 * for axes coverage.
 *
 * `observeIntrinsicShortSideOrientations`'s `IntrinsicSharedArchiveEndpoint`
 * fixtures are assembled from REAL `measureCanonicalLayoutTopologyExact`/
 * `measureCanonicalLayoutEnvelope`/`measureCanonicalLayoutContacts` output on
 * real placed mixed61 pieces (shelf-packed via `layoutPiecesInRow`, a local
 * non-overlapping placement helper -- this cluster's own scope does not own
 * NFP/IFP-driven placement for this specific fixture-construction need, only
 * for the contact-strip entry point itself). Every
 * `IntrinsicStrictCompletedMetrics` field this cluster's Rust port never
 * reads (confirmed by a full source read of `observer.rs`) is filled with a
 * fixed placeholder (`0`) rather than reproducing the private
 * `completedMetrics`/`analyzeCanonicalLayoutStructure` internals -- the
 * fields that DO reach comparators/trace output are always the real
 * computed values.
 *
 * Run with:
 *   pnpm exec tsx --tsconfig tsconfig.node.json scripts/rust-parity/dump-short-side.ts
 *
 * Output (additive; never edits existing fixtures/tests):
 *   - crates/irregular-nesting-native/tests/vectors/short-side.json
 */
import { Effect } from 'effect'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DxfGeometrySummary, ImportedPiece } from '@shared/domain/dxf.js'
import { Rect } from '@shared/domain/geometry.js'
import { PieceId, SourceFileId } from '@shared/domain/ids.js'
import { SheetSpec } from '@shared/domain/nesting.js'
import { DEFAULT_IRREGULAR_NESTING_SETTINGS } from '../../src/shared/irregular/defaults.js'
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
  TransformedCollisionGeometry,
  type IrregularPreparedPiece as IrregularPreparedPieceType
} from '../../src/shared/irregular/domain.js'
import { computeConvexHull } from '../../src/workers/irregular/core/convexHullCore.js'
import { GeometryKernel, GeometrySettings } from '../../src/workers/irregular/geometryKernel.js'
import { NfpIfpServiceLive } from '../../src/workers/irregular/nfpIfpService.js'
import { toGridMm } from '../../src/workers/irregular/clipper2OffsetPolicy.js'
import {
  canonicalCollisionLayoutIdentity,
  measureCanonicalLayoutContacts,
  measureCanonicalLayoutEnvelope,
  measureCanonicalLayoutTopologyExact
} from '../../src/workers/irregular/canonicalLayoutGeometry.js'
import {
  intrinsicShortSideAxes,
  intrinsicShortSideSpan
} from '../../src/workers/algorithm/irregular/intrinsicShortSideAxes.js'
import { observeIntrinsicShortSideOrientations } from '../../src/workers/algorithm/irregular/intrinsicShortSideObserver.js'
import { observeIntrinsicShortSidePairFold } from '../../src/workers/algorithm/irregular/intrinsicShortSidePairFoldObserver.js'
import {
  constructIntrinsicShortSideContactStrip,
  type IntrinsicShortSideContactStripOrderPolicy,
  type IntrinsicShortSideContactStripSelectionPolicy
} from '../../src/workers/algorithm/irregular/intrinsicShortSideContactStrip.js'
import type { IntrinsicStrictCertificate } from '../../src/workers/algorithm/irregular/intrinsicStrictDecoder.js'

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
// f64 -> exact big-endian IEEE-754 bit-pattern hex string (matches every
// other dump script's own `f64Bits` convention exactly).
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
// Deterministic clock/RSS seams -- see this file's top-level doc.
// ---------------------------------------------------------------------------
// A tiny increment (not `1`) keeps every accumulated `now()`/`currentRssBytes()`
// reading many orders of magnitude below the real production runtime/RSS
// budgets (20-30 s / 256-512 MiB) even though this cluster's own
// `boundedStatus` call sites are interleaved with `nfp_ifp::generate_placement_candidates`'s
// own internal `NfpIfpControl::checkpoint` call frequency -- a GREEN module
// outside this cluster's file ownership whose exact call count is not
// itself part of this cluster's own contract. Without this margin, a
// same-language-but-different-call-count divergence there could
// deterministically cross the real budget threshold in one language and
// not the other for the exact same logical computation, corrupting the
// recorded `status` itself rather than only the (already non-parity-gated)
// timing fields.
const CLOCK_INCREMENT = 0.0001

function makeClock(start: number, increment: number): () => number {
  let clock = start
  return () => {
    clock += increment
    return clock
  }
}

function makeRssClock(start: number, increment: number): () => number {
  let value = start
  return () => {
    value += increment
    return value
  }
}

// ---------------------------------------------------------------------------
// Domain-object construction helpers (mirror `dump-capacity-search.ts`'s own
// identically-named helpers).
// ---------------------------------------------------------------------------
function point(x: number, y: number): IrregularPoint {
  return new IrregularPoint({ x, y })
}

function boundsOf(points: ReadonlyArray<IrregularPoint>): IrregularBounds {
  return new IrregularBounds({
    minX: Math.min(...points.map((p) => p.x)),
    minY: Math.min(...points.map((p) => p.y)),
    maxX: Math.max(...points.map((p) => p.x)),
    maxY: Math.max(...points.map((p) => p.y))
  })
}

function sourcePiece(id: string): ImportedPiece {
  return new ImportedPiece({
    id: PieceId.make(id),
    sourceFileId: SourceFileId.make(`source-${id}`),
    label: id,
    realBounds: new Rect({ x: 0, y: 0, width: 1, height: 1 }),
    geometry: new DxfGeometrySummary({ entityType: 'PRESET_SHAPE', closed: true, segments: [] }),
    warnings: []
  })
}

function transformCandidate(index: number, rotationDeg: number): IrregularTransformCandidate {
  return new IrregularTransformCandidate({
    index,
    rotationDeg,
    mirrored: false,
    reason: 'configured'
  })
}

function preparedPiece(
  id: string,
  points: ReadonlyArray<IrregularPoint>
): IrregularPreparedPieceType {
  const shape = new IrregularPolygon({ points })
  return new IrregularPreparedPiece({
    pieceId: PieceId.make(id),
    source: sourcePiece(id),
    allowMirror: false,
    collisionGeometry: new CollisionGeometry({
      sourcePieceId: PieceId.make(id),
      sourceBounds: boundsOf(points),
      sampledPoints: points,
      convexHull: shape,
      collisionPolygon: shape,
      placementReference: point(0, 0),
      diagnostics: []
    }),
    transforms: [transformCandidate(0, 0), transformCandidate(1, 90)]
  })
}

function sheetSpec(width: number, height: number, label = 'dump-short-side'): SheetSpec {
  return new SheetSpec({ width, height, label: `${label} ${width}x${height}` })
}

// ---------------------------------------------------------------------------
// Real mixed61 fixture-piece hull rings (mirrors `dump-capacity-search.ts`'s
// own `fixtureHullRing`, scaled down so 3-8 hull pieces genuinely fit inside
// short-axis strips at the scale this cluster's fixtures use).
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

const mixed61Fixture: Mixed61Fixture = JSON.parse(readFileSync(MIXED61_FIXTURE_PATH, 'utf8'))
if (mixed61Fixture.sourcePieces.length !== 61) {
  throw new Error(
    `Expected 61 source pieces in the mixed61 fixture, got ${mixed61Fixture.sourcePieces.length}.`
  )
}

const HULL_SCALE = 0.12

const fixtureHullCache = new Map<number, IrregularPoint[]>()
function fixtureHullRing(index: number): IrregularPoint[] {
  const wrapped = ((index % 61) + 61) % 61
  const cached = fixtureHullCache.get(wrapped)
  if (cached !== undefined) return cached
  const piece = mixed61Fixture.sourcePieces[wrapped]
  if (piece === undefined) throw new Error('fixture piece index out of range')
  const rawPoints = piece.geometry.segments.map((segment) => point(segment.x1, segment.y1))
  const hull = computeConvexHull(rawPoints)
  const hullPoints = hull.points.map((p) => point(p.x * HULL_SCALE, p.y * HULL_SCALE))
  if (hullPoints.length < 3) {
    throw new Error(`fixture piece ${wrapped} produced a degenerate hull`)
  }
  fixtureHullCache.set(wrapped, hullPoints)
  return hullPoints
}

function mixed61Pieces(prefix: string, slots: ReadonlyArray<number>): IrregularPreparedPieceType[] {
  return slots.map((slot, index) => preparedPiece(`${prefix}-${slot}-${index}`, fixtureHullRing(slot)))
}

// Non-overlapping row placement for observer endpoint fixtures: stacks each
// piece's own convex hull along X by cumulative AABB width, exactly like
// `constructNextFitShelf`'s single-row special case -- always legal for
// disjoint axis-aligned bounding boxes.
function layoutPiecesInRow(pieces: ReadonlyArray<IrregularPreparedPieceType>): IrregularPlacedPiece[] {
  let cursorX = 0
  const placed: IrregularPlacedPiece[] = []
  for (const piece of pieces) {
    const bounds = piece.collisionGeometry.sourceBounds
    const width = bounds.maxX - bounds.minX
    const translateX = cursorX - bounds.minX
    const translateY = -bounds.minY
    placed.push(
      new IrregularPlacedPiece({
        placement: new IrregularPlacement({
          pieceId: piece.pieceId,
          sourcePieceId: piece.source.id,
          placementReference: piece.collisionGeometry.placementReference,
          transform: new IrregularTransform({
            translateX,
            translateY,
            rotationDeg: 0,
            mirrored: false
          })
        }),
        collisionGeometry: new TransformedCollisionGeometry({
          sourcePieceId: piece.source.id,
          transform: transformCandidate(0, 0),
          polygon: piece.collisionGeometry.collisionPolygon,
          bounds: new IrregularBounds({
            minX: bounds.minX + translateX,
            minY: bounds.minY + translateY,
            maxX: bounds.maxX + translateX,
            maxY: bounds.maxY + translateY
          })
        })
      })
    )
    cursorX += width + 1
  }
  return placed
}

// ---------------------------------------------------------------------------
// f64Bits-based geometry encoders (mirrors `dump-capacity-search.ts`'s own
// `encodePreparedPiece`/`encodePoint` convention exactly): the Rust vector
// test reconstructs prepared/placed pieces directly from these recorded
// bit-pattern hex fields rather than re-deriving mixed61 convex hulls
// independently (which would risk a hull-computation divergence unrelated to
// this cluster's own logic).
// ---------------------------------------------------------------------------
function encodePoint(p: IrregularPoint) {
  return { x: f64Bits(p.x), y: f64Bits(p.y) }
}

function encodeTransformCandidate(t: IrregularTransformCandidate) {
  return {
    index: f64Bits(t.index),
    rotationDeg: f64Bits(t.rotationDeg),
    mirrored: t.mirrored,
    reason: t.reason
  }
}

function encodePreparedPiece(piece: IrregularPreparedPieceType) {
  return {
    pieceId: piece.pieceId,
    points: piece.collisionGeometry.collisionPolygon.points.map(encodePoint),
    transforms: piece.transforms.map(encodeTransformCandidate)
  }
}

interface EncodedPlacedPieceCollisionGeometry {
  readonly sourcePieceId: string
  readonly transform: IrregularTransformCandidate
  readonly polygon: { readonly points: ReadonlyArray<IrregularPoint> }
  readonly bounds: IrregularBounds
}

function encodePlacedPiece(placed: IrregularPlacedPiece) {
  const collisionGeometry = placed.collisionGeometry as unknown as EncodedPlacedPieceCollisionGeometry
  const placementReference = placed.placement.placementReference
  return {
    pieceId: placed.placement.pieceId,
    sourcePieceId: placed.placement.sourcePieceId,
    placementReference: placementReference === undefined ? undefined : encodePoint(placementReference),
    transform: {
      translateX: f64Bits(placed.placement.transform.translateX),
      translateY: f64Bits(placed.placement.transform.translateY),
      rotationDeg: f64Bits(placed.placement.transform.rotationDeg),
      mirrored: placed.placement.transform.mirrored
    },
    collisionGeometry: {
      sourcePieceId: collisionGeometry.sourcePieceId,
      transform: encodeTransformCandidate(collisionGeometry.transform),
      points: collisionGeometry.polygon.points.map(encodePoint),
      bounds: {
        minX: f64Bits(collisionGeometry.bounds.minX),
        minY: f64Bits(collisionGeometry.bounds.minY),
        maxX: f64Bits(collisionGeometry.bounds.maxX),
        maxY: f64Bits(collisionGeometry.bounds.maxY)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Effect layer runners.
// ---------------------------------------------------------------------------
function runPairFold(input: Parameters<typeof observeIntrinsicShortSidePairFold>[0]) {
  return Effect.runSync(
    observeIntrinsicShortSidePairFold(input).pipe(
      Effect.provide(GeometryKernel.Live),
      Effect.provide(GeometrySettings.Live),
      Effect.provide(NfpIfpServiceLive)
    )
  )
}

function runContactStrip(input: Parameters<typeof constructIntrinsicShortSideContactStrip>[0]) {
  return Effect.runSync(
    constructIntrinsicShortSideContactStrip(input).pipe(
      Effect.provide(GeometryKernel.Live),
      Effect.provide(GeometrySettings.Live),
      Effect.provide(NfpIfpServiceLive)
    )
  )
}

// ---------------------------------------------------------------------------
// `productionReferenceFor` -- deterministic, self-consistent, real-toGridMm
// production-comparison scalars. Pair-fold treats these purely as caller
// input (§1/§3.3 of the characterization doc): the exact provenance is not
// part of its own contract, only byte-exact grid-quantization matters, so a
// fixed formula driven through the real `toGridMm` is legitimate fixture
// data, not a fabricated shortcut around production logic.
// ---------------------------------------------------------------------------
function productionReferenceFor(sheet: SheetSpec) {
  const axes = intrinsicShortSideAxes(sheet)
  const shortMm = axes.shortAxisMm * 0.75
  const maxSideMm = axes.longAxisMm
  const shortGrid = toGridMm(shortMm)
  const maxSideGrid = toGridMm(maxSideMm)
  if (shortGrid === undefined || maxSideGrid === undefined) {
    throw new Error('production reference axes must fit the canonical grid')
  }
  const areaGrid2 = BigInt(shortGrid) * BigInt(maxSideGrid)
  return {
    productionShortAxisSpanMm: shortMm,
    productionMaximumSideMm: maxSideMm,
    productionEnvelopeAreaMm2: Number(areaGrid2) / 1_000_000,
    productionShortAxisSpanGrid: shortGrid,
    productionMaximumSideGrid: maxSideGrid,
    productionEnvelopeAreaGrid2: areaGrid2.toString()
  }
}

// ===========================================================================
// 1. `intrinsicShortSideAxes` / `intrinsicShortSideSpan` vectors.
// ===========================================================================
interface AxesCase {
  readonly caseId: string
  readonly sheet: { readonly width: number; readonly height: number }
  readonly axes: {
    readonly shortAxis: string
    readonly longAxis: string
    readonly shortAxisMm: string
    readonly longAxisMm: string
    readonly normalizedToPhysicalRotationDeg: number
  }
  readonly spanWidthFirst: string
  readonly spanHeightFirst: string
}

const axesCases: AxesCase[] = []
const AXES_DIMENSIONS = [
  50, 100, 150, 200, 250, 300, 333, 400, 500, 600, 700, 800, 900, 1000, 1200, 1500, 2000, 2001,
  2700, 3000
]
for (const width of AXES_DIMENSIONS) {
  for (const height of AXES_DIMENSIONS) {
    const sheet = sheetSpec(width, height)
    const axes = intrinsicShortSideAxes(sheet)
    const spanA = intrinsicShortSideSpan(axes, { width: 111.5, height: 222.5 })
    const spanB = intrinsicShortSideSpan(axes, { width: 999, height: 1 })
    axesCases.push({
      caseId: `axes-${width}x${height}`,
      sheet: { width, height },
      axes: {
        shortAxis: axes.shortAxis,
        longAxis: axes.longAxis,
        shortAxisMm: f64Bits(axes.shortAxisMm),
        longAxisMm: f64Bits(axes.longAxisMm),
        normalizedToPhysicalRotationDeg: axes.normalizedToPhysicalRotationDeg
      },
      spanWidthFirst: f64Bits(spanA),
      spanHeightFirst: f64Bits(spanB)
    })
  }
}

// ===========================================================================
// 2. `observeIntrinsicShortSideOrientations` vectors.
// ===========================================================================
function fixtureEndpoint(
  role: string,
  sourceId: string | undefined,
  archiveSlotSeed: number,
  slots: ReadonlyArray<number>
) {
  const pieces = mixed61Pieces(`obs${archiveSlotSeed}`, slots)
  const placed = layoutPiecesInRow(pieces)
  const identity = canonicalCollisionLayoutIdentity(placed)
  if (identity === undefined) throw new Error('fixture layout failed to produce a canonical identity')
  const hash = createHash('sha256').update(identity).digest('hex')
  const topologyExact = measureCanonicalLayoutTopologyExact(placed)
  const envelope = measureCanonicalLayoutEnvelope(placed)
  const contacts = measureCanonicalLayoutContacts(placed)
  if (topologyExact === undefined || envelope === undefined || contacts === undefined) {
    throw new Error('fixture layout failed to produce real canonical metrics')
  }
  const metrics = {
    envelopeMaximumSideMm: envelope.maximumSideMm,
    envelopeAreaMm2: envelope.areaMm2,
    envelopeSpanMm: envelope.spanMm,
    enclosedCavityCount: topologyExact.topology.enclosedCavityCount,
    totalEnclosedCavityAreaMm2: 0,
    largestOccupiedHullGapRatio: topologyExact.topology.largestOccupiedHullGapRatio,
    isolatedPieceCount: topologyExact.topology.isolatedPieceCount,
    positiveContactComponentCount: topologyExact.topology.positiveContactComponentCount,
    largestPositiveContactComponentSize: topologyExact.topology.largestPositiveContactComponentSize,
    largestPositiveContactComponentRatio: topologyExact.topology.largestPositiveContactComponentRatio,
    occupiedAreaOutsideLargestContactComponentMm2: 0,
    occupiedHullWasteRatio: envelope.occupiedHullWasteRatio,
    totalStructuralContacts: contacts.totalStructuralContacts,
    dominantStructuralContacts: contacts.dominantStructuralContacts,
    contactUnits: contacts.contactUnits,
    sharedBoundaryLengthMm: contacts.sharedBoundaryLengthMm,
    canonicalGeometryHash: hash,
    runtimeMs: 0,
    exact: {
      envelopeMaximumSideGrid: envelope.maximumSideGrid,
      envelopeAreaGrid2: envelope.envelopeAreaGrid2,
      envelopeSpanGrid: envelope.spanGrid,
      totalEnclosedCavityDoubledAreaGrid2: '0',
      largestOccupiedHullGapDoubledAreaGrid2: topologyExact.exactHullGapDoubledAreaGrid2,
      occupiedHullDoubledAreaGrid2: topologyExact.exactHullDoubledAreaGrid2,
      // Never read by `observer.rs` (confirmed by a full source read -- see
      // this file's top doc); filled with fixed placeholders only to
      // satisfy `IntrinsicStrictCompletedMetricsExact`'s full shape.
      occupiedHullWasteDoubledAreaGrid2: '0',
      largestPositiveContactComponentSize: topologyExact.topology.largestPositiveContactComponentSize,
      placedPieceCount: placed.length,
      occupiedOutsideLargestContactComponentDoubledAreaGrid2: '0'
    }
  }
  const certificate: IntrinsicStrictCertificate = {
    passes: topologyExact.topology.enclosedCavityCount <= 2,
    violatedFloors: [],
    relativeDeficitSum: 0
  }
  const encoded = {
    role,
    sourceId,
    canonicalGeometryHash: hash,
    placedCollisionGeometries: placed.map(encodePlacedPiece),
    // Only the metrics fields `observer.rs` actually reads (confirmed by a
    // full source read -- see this file's top doc) are recorded bit-exact;
    // every other `IntrinsicStrictCompletedMetrics` field is reconstructed
    // from the identical fixed placeholder (`0`/`"0"`) on the Rust side, so
    // both languages agree on the unread fields by construction.
    metrics: {
      envelopeAreaMm2: f64Bits(metrics.envelopeAreaMm2),
      envelopeMaximumSideMm: f64Bits(metrics.envelopeMaximumSideMm),
      envelopeSpanMm: f64Bits(metrics.envelopeSpanMm),
      enclosedCavityCount: f64Bits(metrics.enclosedCavityCount),
      largestOccupiedHullGapRatio: f64Bits(metrics.largestOccupiedHullGapRatio),
      dominantStructuralContacts: f64Bits(metrics.dominantStructuralContacts),
      totalStructuralContacts: f64Bits(metrics.totalStructuralContacts),
      contactUnits: f64Bits(metrics.contactUnits),
      sharedBoundaryLengthMm: f64Bits(metrics.sharedBoundaryLengthMm),
      exactEnvelopeAreaGrid2: metrics.exact.envelopeAreaGrid2,
      exactEnvelopeMaximumSideGrid: f64Bits(metrics.exact.envelopeMaximumSideGrid),
      exactEnvelopeSpanGrid: f64Bits(metrics.exact.envelopeSpanGrid),
      exactLargestOccupiedHullGapDoubledAreaGrid2: metrics.exact.largestOccupiedHullGapDoubledAreaGrid2,
      exactOccupiedHullDoubledAreaGrid2: metrics.exact.occupiedHullDoubledAreaGrid2
    },
    certificate: {
      passes: certificate.passes,
      relativeDeficitSum: f64Bits(certificate.relativeDeficitSum)
    }
  }
  return {
    real: {
      role,
      sourceId,
      sheetlessCanonicalGeometryIdentity: identity,
      sheetlessCanonicalGeometryHash: hash,
      placedCollisionGeometries: placed,
      metrics,
      certificate,
      requestedSheetFit: {
        q0: { fits: true, canonicalGeometryHash: hash },
        q90: { fits: true, canonicalGeometryHash: hash },
        selectedRotationDeg: 0 as const,
        selectedCanonicalGeometryHash: hash,
        selectedPlacedCollisionGeometries: placed
      }
    },
    encoded
  }
}

interface ObserverCase {
  readonly caseId: string
  readonly sheet: { readonly width: number; readonly height: number }
  readonly endpoints: ReadonlyArray<ReturnType<typeof fixtureEndpoint>['encoded']>
  readonly result: unknown
}

const observerCases: ObserverCase[] = []
const OBSERVER_SLOT_SETS: ReadonlyArray<ReadonlyArray<number>> = [
  [0, 1],
  [2, 3, 4],
  [5, 6],
  [7, 8, 9, 10],
  [11, 12],
  [13, 14, 15],
  [16, 17],
  [18, 19, 20]
]
const OBSERVER_SHEETS = [sheetSpec(300, 300), sheetSpec(600, 400), sheetSpec(2000, 2700)]

type ObserverEndpointInput = Parameters<
  typeof observeIntrinsicShortSideOrientations
>[0]['endpoints'][number]

OBSERVER_SHEETS.forEach((sheet, sheetIndex) => {
  const built = OBSERVER_SLOT_SETS.map((slots, index) =>
    fixtureEndpoint(`endpoint-${index}`, `source-${index}`, sheetIndex * 100 + index, slots)
  )
  const endpoints: ObserverEndpointInput[] = built.map((entry) => entry.real)
  const trace = observeIntrinsicShortSideOrientations({
    sheet,
    endpoints,
    now: () => 0
  })
  observerCases.push({
    caseId: `observer-full-${sheetIndex}`,
    sheet: { width: sheet.width, height: sheet.height },
    endpoints: built.map((entry) => entry.encoded),
    result: JSON.parse(JSON.stringify(trace))
  })
  // Single-endpoint subsets exercise the guard/legal/Pareto boundary
  // statuses across a real archive-index sweep.
  built.forEach((_entry, index) => {
    const subset = endpoints.slice(0, index + 1)
    const subTrace = observeIntrinsicShortSideOrientations({
      sheet,
      endpoints: subset,
      now: () => 0
    })
    observerCases.push({
      caseId: `observer-prefix-${sheetIndex}-${index}`,
      sheet: { width: sheet.width, height: sheet.height },
      endpoints: built.slice(0, index + 1).map((entry) => entry.encoded),
      result: JSON.parse(JSON.stringify(subTrace))
    })
  })
})
// Empty-archive skip case.
;[sheetSpec(300, 300), sheetSpec(600, 400)].forEach((sheet, index) => {
  const trace = observeIntrinsicShortSideOrientations({ sheet, endpoints: [], now: () => 0 })
  observerCases.push({
    caseId: `observer-empty-${index}`,
    sheet: { width: sheet.width, height: sheet.height },
    endpoints: [],
    result: JSON.parse(JSON.stringify(trace))
  })
})

// ===========================================================================
// 3. `observeIntrinsicShortSidePairFold` vectors.
// ===========================================================================
interface PairFoldCase {
  readonly caseId: string
  readonly sheet: { readonly width: number; readonly height: number }
  readonly pieces: ReturnType<typeof encodePreparedPiece>[]
  readonly clockStart: number
  readonly clockIncrement: number
  readonly rssStart: number
  readonly rssIncrement: number
  readonly maximumRuntimeMs: number | undefined
  readonly maximumRssDeltaBytes: number | undefined
  readonly production: ReturnType<typeof productionReferenceFor>
  readonly result: unknown
}

const pairFoldCases: PairFoldCase[] = []
const PAIR_FOLD_PAIR_SLOTS: ReadonlyArray<ReadonlyArray<number>> = [
  [0, 1],
  [2, 3],
  [4, 5],
  [6, 7],
  [8, 9],
  [10, 11],
  [12, 13],
  [14, 15]
]
const PAIR_FOLD_SHELF_SLOTS: ReadonlyArray<ReadonlyArray<number>> = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8, 9],
  [10, 11, 12, 13, 14],
  [15, 16, 17, 18, 19, 20]
]
const PAIR_FOLD_SHEETS = [
  sheetSpec(90, 200),
  sheetSpec(150, 220),
  sheetSpec(300, 300),
  sheetSpec(60, 400)
]

function runPairFoldCase(
  caseId: string,
  sheet: SheetSpec,
  slots: ReadonlyArray<number>,
  budget: { maximumRuntimeMs?: number; maximumRssDeltaBytes?: number } = {}
): void {
  const pieces = mixed61Pieces(caseId, slots)
  const production = productionReferenceFor(sheet)
  const clock = makeClock(1000, CLOCK_INCREMENT)
  const rss = makeRssClock(0, CLOCK_INCREMENT)
  const outcome = runPairFold({
    sheet,
    preparedPieces: pieces,
    settings: DEFAULT_IRREGULAR_NESTING_SETTINGS,
    ...production,
    runtimeControl: {
      now: clock,
      currentRssBytes: rss,
      ...budget
    }
  })
  pairFoldCases.push({
    caseId,
    sheet: { width: sheet.width, height: sheet.height },
    pieces: pieces.map(encodePreparedPiece),
    clockStart: 1000,
    clockIncrement: CLOCK_INCREMENT,
    rssStart: 0,
    rssIncrement: CLOCK_INCREMENT,
    maximumRuntimeMs: budget.maximumRuntimeMs,
    maximumRssDeltaBytes: budget.maximumRssDeltaBytes,
    production,
    result: JSON.parse(JSON.stringify(outcome))
  })
}

PAIR_FOLD_PAIR_SLOTS.forEach((slots, index) => {
  const sheet = PAIR_FOLD_SHEETS[index % PAIR_FOLD_SHEETS.length]
  if (sheet === undefined) return
  runPairFoldCase(`pairfold-pair-${index}`, sheet, slots)
})
PAIR_FOLD_SHELF_SLOTS.forEach((slots, index) => {
  const sheet = PAIR_FOLD_SHEETS[index % PAIR_FOLD_SHEETS.length]
  if (sheet === undefined) return
  runPairFoldCase(`pairfold-shelf-${index}`, sheet, slots)
})
// Square-sheet prescribed-rotation coverage.
;[
  [0, 1],
  [2, 3, 4]
].forEach((slots, index) => {
  runPairFoldCase(`pairfold-square-${index}`, sheetSpec(300, 300), slots)
})
// Deadline / memory-cap deterministic trips (see this file's top doc).
PAIR_FOLD_PAIR_SLOTS.slice(0, 3).forEach((slots, index) => {
  const sheet = PAIR_FOLD_SHEETS[index % PAIR_FOLD_SHEETS.length]
  if (sheet === undefined) return
  runPairFoldCase(`pairfold-deadline-${index}`, sheet, slots, { maximumRuntimeMs: 0 })
  runPairFoldCase(`pairfold-memorycap-${index}`, sheet, slots, { maximumRssDeltaBytes: 0 })
})
// Too-small sheets: no exact directional construction fits either axis.
;[
  [0, 1, 2, 3],
  [4, 5, 6, 7]
].forEach((slots, index) => {
  runPairFoldCase(`pairfold-toosmall-${index}`, sheetSpec(5, 5), slots)
})

// ===========================================================================
// 4. `constructIntrinsicShortSideContactStrip` vectors.
// ===========================================================================
interface ContactStripCase {
  readonly caseId: string
  readonly stripSheet: { readonly width: number; readonly height: number }
  readonly pieces: ReturnType<typeof encodePreparedPiece>[]
  readonly order: string
  readonly selectionPolicy: IntrinsicShortSideContactStripSelectionPolicy
  readonly orderPolicy: IntrinsicShortSideContactStripOrderPolicy
  readonly clockStart: number
  readonly clockIncrement: number
  readonly rssStart: number
  readonly rssIncrement: number
  readonly maximumRuntimeMs: number | undefined
  readonly maximumRssDeltaBytes: number | undefined
  readonly maximumCandidateEvaluations: number | undefined
  readonly maximumBacktracks: number | undefined
  readonly tieEvidence: unknown[]
  readonly result: unknown
}

const contactStripCases: ContactStripCase[] = []
const CONTACT_STRIP_SLOT_SETS: ReadonlyArray<ReadonlyArray<number>> = [
  [0, 1, 2],
  [3, 4, 5, 6],
  [7, 8, 9, 10, 11],
  [12, 13, 14, 15, 16, 17],
  [18, 19, 20, 21, 22, 23, 24],
  [25, 26, 27, 28, 29, 30, 31, 32]
]
const CONTACT_STRIP_SHEETS = [sheetSpec(90, 260, 'strip'), sheetSpec(150, 400, 'strip')]
const SELECTION_POLICIES: IntrinsicShortSideContactStripSelectionPolicy[] = [
  'depth-first',
  'contact-first'
]

function orderedPieces(
  order: string,
  pieces: ReadonlyArray<IrregularPreparedPieceType>
): IrregularPreparedPieceType[] {
  if (order === 'reverse') return [...pieces].toReversed()
  if (order === 'piece-id-ascending') {
    return [...pieces].sort((a, b) => {
      const first = a.pieceId ?? a.source.id
      const second = b.pieceId ?? b.source.id
      return first < second ? -1 : first > second ? 1 : 0
    })
  }
  return [...pieces]
}

function runContactStripCase(
  caseId: string,
  stripSheet: SheetSpec,
  slots: ReadonlyArray<number>,
  selectionPolicy: IntrinsicShortSideContactStripSelectionPolicy,
  order: 'prepared' | 'reverse' | 'piece-id-ascending',
  runtimeControlExtra: {
    maximumRuntimeMs?: number
    maximumRssDeltaBytes?: number
    maximumCandidateEvaluations?: number
    maximumBacktracks?: number
  } = {}
): void {
  const pieces = orderedPieces(order, mixed61Pieces(caseId, slots))
  const clock = makeClock(2000, CLOCK_INCREMENT)
  const rss = makeRssClock(0, CLOCK_INCREMENT)
  const tieEvidence: unknown[] = []
  const outcome = runContactStrip({
    stripSheet,
    preparedPieces: pieces,
    settings: DEFAULT_IRREGULAR_NESTING_SETTINGS,
    selectionPolicy,
    orderPolicy: order,
    runtimeControl: {
      now: clock,
      currentRssBytes: rss,
      tieEvidenceSink: (entry: unknown) => tieEvidence.push(entry),
      ...runtimeControlExtra
    }
  })
  contactStripCases.push({
    caseId,
    stripSheet: { width: stripSheet.width, height: stripSheet.height },
    pieces: pieces.map(encodePreparedPiece),
    order,
    selectionPolicy,
    orderPolicy: order,
    clockStart: 2000,
    clockIncrement: CLOCK_INCREMENT,
    rssStart: 0,
    rssIncrement: CLOCK_INCREMENT,
    maximumRuntimeMs: runtimeControlExtra.maximumRuntimeMs,
    maximumRssDeltaBytes: runtimeControlExtra.maximumRssDeltaBytes,
    maximumCandidateEvaluations: runtimeControlExtra.maximumCandidateEvaluations,
    maximumBacktracks: runtimeControlExtra.maximumBacktracks,
    tieEvidence: JSON.parse(JSON.stringify(tieEvidence)),
    result: JSON.parse(JSON.stringify(outcome))
  })
}

CONTACT_STRIP_SLOT_SETS.forEach((slots, slotIndex) => {
  CONTACT_STRIP_SHEETS.forEach((sheet, sheetIndex) => {
    SELECTION_POLICIES.forEach((policy) => {
      ;(['prepared', 'reverse', 'piece-id-ascending'] as const).forEach((order) => {
        runContactStripCase(
          `strip-${slotIndex}-${sheetIndex}-${policy}-${order}`,
          sheet,
          slots,
          policy,
          order
        )
      })
    })
  })
})
// Contact-first with the real production evaluation/backtrack caps.
CONTACT_STRIP_SLOT_SETS.forEach((slots, index) => {
  runContactStripCase(
    `strip-capped-${index}`,
    sheetSpec(90, 260, 'strip'),
    slots,
    'contact-first',
    'prepared',
    { maximumCandidateEvaluations: 2000, maximumBacktracks: 4 }
  )
})
// Deterministic deadline / memory-cap / tiny-evaluation-cap trips.
CONTACT_STRIP_SLOT_SETS.slice(0, 3).forEach((slots, index) => {
  runContactStripCase(`strip-deadline-${index}`, sheetSpec(90, 260, 'strip'), slots, 'depth-first', 'prepared', {
    maximumRuntimeMs: 0
  })
  runContactStripCase(
    `strip-memorycap-${index}`,
    sheetSpec(90, 260, 'strip'),
    slots,
    'depth-first',
    'prepared',
    { maximumRssDeltaBytes: 0 }
  )
  runContactStripCase(
    `strip-evalcap-${index}`,
    sheetSpec(90, 260, 'strip'),
    slots,
    'contact-first',
    'prepared',
    { maximumCandidateEvaluations: 1 }
  )
  runContactStripCase(
    `strip-backtrackcap-${index}`,
    sheetSpec(90, 260, 'strip'),
    slots,
    'contact-first',
    'prepared',
    { maximumCandidateEvaluations: 2000, maximumBacktracks: 0 }
  )
})
// Directional-failure coverage: strips far too small for any legal
// placement (`no-legal-placement`).
CONTACT_STRIP_SLOT_SETS.slice(0, 3).forEach((slots, index) => {
  runContactStripCase(`strip-toosmall-${index}`, sheetSpec(1, 1, 'strip'), slots, 'depth-first', 'prepared')
})

// ===========================================================================
// Vector-count accounting and write-out.
// ===========================================================================
const totalVectorCount =
  axesCases.length + observerCases.length + pairFoldCases.length + contactStripCases.length
if (totalVectorCount < 400) {
  throw new Error(`Expected >= 400 short-side vectors, got ${totalVectorCount}.`)
}

mkdirSync(VECTORS_DIR, { recursive: true })
const commit = generatingCommit()

const settingsJson = JSON.parse(
  JSON.stringify(DEFAULT_IRREGULAR_NESTING_SETTINGS, (_key, value: unknown) =>
    typeof value === 'bigint' ? value.toString() : value
  )
) as unknown

const output = {
  generatedByScript: 'scripts/rust-parity/dump-short-side.ts',
  generatingCommit: commit,
  description:
    'Compact Short Side cluster full-port coverage: intrinsicShortSideAxes/intrinsicShortSideSpan ' +
    'across a dense {width,height} sweep including squares; observeIntrinsicShortSideOrientations over ' +
    'real mixed61-hull endpoint fixtures (full archives and archive-index prefixes, plus the empty-archive ' +
    'skip status); observeIntrinsicShortSidePairFold over real mixed61 pair/shelf/square-sheet partitions ' +
    'including deterministic deadline/memory-cap trips and too-small-sheet no-fitting-pair cases; ' +
    'constructIntrinsicShortSideContactStrip over real mixed61 3-8-piece partitions crossed with ' +
    'depth-first/contact-first selection policies and prepared/reverse/piece-id-ascending orderings, plus ' +
    'production evaluation/backtrack caps, deterministic deadline/memory-cap/evaluation-cap/backtrack-cap ' +
    'trips, and no-legal-placement directional-failure cases. f64 values are recorded as big-endian ' +
    'IEEE-754 bit-pattern hex strings for bit-exact comparison; BigInt/doubled-area-grid2 fields are ' +
    'recorded verbatim as decimal strings. Every pair-fold/contact-strip case supplies its own ' +
    'deterministic incrementing now/currentRssBytes clock seam (see clockStart/clockIncrement/rssStart/' +
    'rssIncrement per case), so runtimeMs/peakRssDeltaBytes are byte-exact reproducible outputs. ' +
    '`settings` is the byte-exact JSON projection of the real production DEFAULT_IRREGULAR_NESTING_SETTINGS.',
  settings: settingsJson,
  axesCaseCount: axesCases.length,
  axesCases,
  observerCaseCount: observerCases.length,
  observerCases,
  pairFoldCaseCount: pairFoldCases.length,
  pairFoldCases,
  contactStripCaseCount: contactStripCases.length,
  contactStripCases,
  totalVectorCount
}

writeFileSync(join(VECTORS_DIR, 'short-side.json'), JSON.stringify(output, null, 2) + '\n')

// Self-check: SHA-256 of the written file's own bytes is stable across
// re-runs on an unchanged commit (a cheap sanity signal, not itself part of
// the differential contract).
const fileBytes = readFileSync(join(VECTORS_DIR, 'short-side.json'))
console.log(
  `wrote ${totalVectorCount} short-side vectors (axes=${axesCases.length}, ` +
    `observer=${observerCases.length}, pairFold=${pairFoldCases.length}, ` +
    `contactStrip=${contactStripCases.length}); sha256=${createHash('sha256').update(fileBytes).digest('hex')}`
)
