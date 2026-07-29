/**
 * Differential-vector generator for
 * `crates/irregular-nesting-native/src/nfp_ifp/{boundary_core,ifp_bounds,candidates,service}.rs`.
 *
 * Imports the REAL production TS entry points and evaluates them through the
 * REAL Effect service layer stack (per stage0-rulings.md R14 and this task's
 * own instruction: "Effect.runSyncExit with real Live layers"):
 *   - `NfpIfpService.use((service) => service.computeNfp(input))` /
 *     `.computeIfpBounds(input)` / `.generatePlacementCandidates(input)`,
 *     provided with the real `NfpIfpServiceLive`
 *     (`src/workers/irregular/nfpIfpService.ts`, which itself
 *     `provideMerge`s the real `GeometryCacheInMemory` -- the same layer
 *     shape `nesting.worker.ts:391-398` wires into production, minus the
 *     sibling services this cluster's pure entry points do not need).
 *   - `canonicalPlacementPointAlternatives` (pure, no Effect;
 *     `nfpIfpService.ts`'s exported ordering-contract function).
 *   - `pairwiseNfpCacheKey`/`innerFitBoundsCacheKey` (`geometryCacheKeys.ts`)
 *     plus a hand-built `GeometryCache` layer wrapping a real, externally
 *     held `makeGeometryCacheStore()` instance, so cache hit/stale/telemetry
 *     sequences can be observed across repeated calls against the same
 *     backing store -- exactly mirroring the exact access sequence
 *     `cache-concurrency-design.md` §1.1/§1.3 documents.
 *   - `computeConvexHull` (`core/convexHullCore.ts`) applied to real
 *     mixed61 fixture-piece segment endpoints, producing guaranteed-valid
 *     strict-convex polygons derived from real fixture data without needing
 *     the full DXF-import/offset pipeline (NFP/IFP inputs must be strict
 *     convex; raw un-hulled fixture rings are not guaranteed convex).
 *
 * Sections (each independently exceeds coverage floors; combined total is
 * asserted >= 500 below):
 *   A. Pairwise NFPs (`computeNfp`) across real fixture-piece pairs (both
 *      pairings, both construction algorithms) plus hand-authored polygons
 *      across rotation/mirror/translation variants, including
 *      canonically-equivalent fixed-piece-copy scenarios.
 *   B. IFPs (`computeIfpBounds`) for real fixture pieces against feasible,
 *      infeasible, and exactly-fitting sheets, plus a degenerate-polygon
 *      `'invalid'` case.
 *   C. `canonicalPlacementPointAlternatives`'s complete ordered 9-alternative
 *      lists across a battery of raw points (grid ties, negative
 *      coordinates, near-safe-integer-overflow magnitudes).
 *   D. `generatePlacementCandidates`'s complete ordered `candidates` array
 *      across small scenes varying placed-piece count, candidate domain,
 *      and pruning mode.
 *   E. Validation-rejection and cooperative-abort cases (typed error tag,
 *      message, and -- for aborts -- the observed checkpoint phase
 *      sequence).
 *   F. Cache hit/store/stale-eviction sequences with `NfpIfpTelemetry`
 *      snapshots after each step.
 *
 * Run with:
 *   pnpm exec tsx --tsconfig tsconfig.node.json scripts/rust-parity/dump-nfp-ifp.ts
 *
 * Output (additive; never edits existing fixtures/tests):
 *   - crates/irregular-nesting-native/tests/vectors/nfp-ifp.json
 */
import { Effect, Exit, Layer, Option } from 'effect'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  IrregularBounds,
  IrregularPlacedPiece,
  IrregularPlacement,
  IrregularPoint,
  IrregularPolygon,
  IrregularTransform,
  IrregularTransformCandidate,
  type IrregularTransformReason,
  TransformedCollisionGeometry
} from '../../src/shared/irregular/domain.js'
import { PieceId } from '../../src/shared/domain/ids.js'
import { SheetSpec } from '../../src/shared/domain/nesting.js'
import { DEFAULT_IRREGULAR_NESTING_SETTINGS } from '../../src/shared/irregular/defaults.js'
import {
  makeNfpIfpServiceLayer,
  makeNfpIfpServiceLive,
  NfpIfpServiceLive,
  canonicalPlacementPointAlternatives
} from '../../src/workers/irregular/nfpIfpService.js'
import {
  NFP_CONSTRUCTION_ALGORITHMS,
  type NfpConstructionAlgorithm
} from '../../src/workers/irregular/core/nfpCacheKey.js'
import {
  pairwiseNfpCacheKey,
  innerFitBoundsCacheKey,
  type NfpCandidatePruningMode
} from '../../src/workers/irregular/geometryCacheKeys.js'
import { computeConvexHull } from '../../src/workers/irregular/core/convexHullCore.js'
import {
  GeometryCache,
  IrregularGeometryInfeasibleError,
  IrregularGeometryInputError,
  IrregularNfpIfpControlAbortError,
  NfpIfpService,
  type ComputeIfpBoundsInput,
  type ComputeNfpInput,
  type GeneratePlacementCandidatesInput,
  type IrregularNfpIfpCheckpointPhase
} from '../../src/workers/irregular/services.js'
import { makeGeometryCacheStore } from '../../src/workers/irregular/geometryCacheStoreLive.js'
import * as NfpIfpTelemetry from '../../src/workers/irregular/nfpIfpTelemetry.js'

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
// f64 -> exact big-endian IEEE-754 bit-pattern hex string (matches
// dump-cache-keys.ts's / dump-predicates.ts's `f64Bits` convention exactly).
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
// Domain-object construction helpers.
// ---------------------------------------------------------------------------
function point(x: number, y: number): IrregularPoint {
  return new IrregularPoint({ x, y })
}

function polygon(points: ReadonlyArray<IrregularPoint>): IrregularPolygon {
  return new IrregularPolygon({ points })
}

function boundsOf(points: ReadonlyArray<IrregularPoint>): IrregularBounds {
  return new IrregularBounds({
    minX: Math.min(...points.map((p) => p.x)),
    minY: Math.min(...points.map((p) => p.y)),
    maxX: Math.max(...points.map((p) => p.x)),
    maxY: Math.max(...points.map((p) => p.y))
  })
}

function transformCandidate(
  index: number,
  rotationDeg: number,
  mirrored: boolean,
  reason: IrregularTransformReason = 'configured'
): IrregularTransformCandidate {
  return new IrregularTransformCandidate({ index, rotationDeg, mirrored, reason })
}

function sheetSpec(width: number, height: number, label = 'dump-nfp-ifp sheet'): SheetSpec {
  return new SheetSpec({ width, height, label })
}

function movingGeometry(
  pieceId: string,
  points: ReadonlyArray<IrregularPoint>,
  transform: IrregularTransformCandidate = transformCandidate(0, 0, false)
): TransformedCollisionGeometry {
  return new TransformedCollisionGeometry({
    sourcePieceId: PieceId.make(pieceId),
    transform,
    polygon: polygon(points),
    bounds: boundsOf(points)
  })
}

function placedPiece(
  pieceId: string,
  points: ReadonlyArray<IrregularPoint>,
  translateX: number,
  translateY: number,
  transform: IrregularTransformCandidate = transformCandidate(0, 0, false)
): IrregularPlacedPiece {
  return new IrregularPlacedPiece({
    placement: new IrregularPlacement({
      sourcePieceId: PieceId.make(pieceId),
      transform: new IrregularTransform({
        translateX,
        translateY,
        rotationDeg: 0,
        mirrored: false
      })
    }),
    collisionGeometry: movingGeometry(pieceId, points, transform)
  })
}

// ---------------------------------------------------------------------------
// Real mixed61 fixture-piece hull rings.
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

const mixed61Fixture: Mixed61Fixture = JSON.parse(readFileSync(MIXED61_FIXTURE, 'utf8'))
if (mixed61Fixture.sourcePieces.length !== 61) {
  throw new Error(
    `Expected 61 source pieces in the mixed61 fixture, got ${mixed61Fixture.sourcePieces.length}.`
  )
}

const fixtureHullCache = new Map<number, IrregularPoint[]>()
function fixtureHullRing(index: number): IrregularPoint[] {
  const wrapped = ((index % 61) + 61) % 61
  const cached = fixtureHullCache.get(wrapped)
  if (cached !== undefined) return cached
  const piece = mixed61Fixture.sourcePieces[wrapped]
  if (piece === undefined) throw new Error('fixture piece index out of range')
  const rawPoints = piece.geometry.segments.map((segment) => point(segment.x1, segment.y1))
  const hull = computeConvexHull(rawPoints)
  const hullPoints = hull.points.map((p) => point(p.x, p.y))
  if (hullPoints.length < 3) {
    throw new Error(`fixture piece ${wrapped} produced a degenerate hull`)
  }
  fixtureHullCache.set(wrapped, hullPoints)
  return hullPoints
}
function fixtureLabel(index: number): string {
  const wrapped = ((index % 61) + 61) % 61
  return mixed61Fixture.sourcePieces[wrapped]?.label ?? `piece-${wrapped}`
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
function encodeBounds(b: IrregularBounds): EncodedBounds {
  return { minX: f64Bits(b.minX), minY: f64Bits(b.minY), maxX: f64Bits(b.maxX), maxY: f64Bits(b.maxY) }
}

interface EncodedTransform {
  readonly index: string
  readonly rotationDeg: string
  readonly mirrored: boolean
  readonly reason: string
}
function encodeTransform(t: IrregularTransformCandidate): EncodedTransform {
  return {
    index: f64Bits(t.index),
    rotationDeg: f64Bits(t.rotationDeg),
    mirrored: t.mirrored,
    reason: t.reason
  }
}

// ---------------------------------------------------------------------------
// Shared settings.
// ---------------------------------------------------------------------------
const NESTING_SETTINGS = DEFAULT_IRREGULAR_NESTING_SETTINGS

// =============================================================================
// Section A: pairwise NFPs (`computeNfp`).
// =============================================================================
interface PairwiseNfpCase {
  readonly category: string
  readonly fixedPolygon: EncodedPoint[]
  readonly fixedTransform: EncodedTransform
  readonly fixedTranslateX: string
  readonly fixedTranslateY: string
  readonly movingPolygon: EncodedPoint[]
  readonly movingTransform: EncodedTransform
  readonly algorithm: NfpConstructionAlgorithm
  readonly result:
    | { readonly ok: true; readonly boundary: EncodedPoint[] }
    | { readonly ok: false; readonly message: string }
}
const pairwiseNfpCases: PairwiseNfpCase[] = []

function runComputeNfp(
  input: ComputeNfpInput,
  algorithm: NfpConstructionAlgorithm
): { readonly ok: true; readonly boundary: EncodedPoint[] } | { readonly ok: false; readonly message: string } {
  const exit = Effect.runSyncExit(
    NfpIfpService.use((service) => service.computeNfp(input)).pipe(
      Effect.provide(makeNfpIfpServiceLive(algorithm))
    )
  )
  if (Exit.isSuccess(exit)) {
    return { ok: true, boundary: encodePoints(exit.value.boundary.points) }
  }
  const failure = Exit.findErrorOption(exit)
  if (Option.isNone(failure) || !(failure.value instanceof IrregularGeometryInputError)) {
    throw new Error(`unexpected computeNfp failure cause: ${JSON.stringify(exit.cause)}`)
  }
  return { ok: false, message: failure.value.message }
}

function makePairwiseCase(
  category: string,
  fixed: IrregularPlacedPiece,
  moving: TransformedCollisionGeometry,
  algorithm: NfpConstructionAlgorithm
): void {
  const input: ComputeNfpInput = { fixed, moving, settings: NESTING_SETTINGS.geometry }
  pairwiseNfpCases.push({
    category,
    fixedPolygon: encodePoints(fixed.collisionGeometry.polygon.points),
    fixedTransform: encodeTransform(fixed.collisionGeometry.transform),
    fixedTranslateX: f64Bits(fixed.placement.transform.translateX),
    fixedTranslateY: f64Bits(fixed.placement.transform.translateY),
    movingPolygon: encodePoints(moving.polygon.points),
    movingTransform: encodeTransform(moving.transform),
    algorithm,
    result: runComputeNfp(input, algorithm)
  })
}

{
  // Real fixture-piece pairs, two distinct pairings, both algorithms.
  for (let index = 0; index < 61; index += 1) {
    const fixedPoints = fixtureHullRing(index)
    for (const offset of [1, 7]) {
      const movingPoints = fixtureHullRing(index + offset)
      for (const algorithm of NFP_CONSTRUCTION_ALGORITHMS) {
        const fixed = placedPiece(
          `fixed-${fixtureLabel(index)}-${index}`,
          fixedPoints,
          10 + index * 3,
          5 + index * 2
        )
        const moving = movingGeometry(`moving-${fixtureLabel(index + offset)}-${index}-${offset}`, movingPoints)
        makePairwiseCase(
          `fixture-pair:${index}:offset=${offset}:algorithm=${algorithm}`,
          fixed,
          moving,
          algorithm
        )
      }
    }
  }

  // Hand-authored polygons across rotation/mirror/transform-index variants.
  const squareA = [point(0, 0), point(4, 0), point(4, 4), point(0, 4)]
  const triangle = [point(0, 0), point(2, 0), point(1, 2)]
  const pentagon = [point(0, 0), point(3, -1), point(4, 2), point(2, 4), point(-1, 2)]
  const shapes: ReadonlyArray<[string, IrregularPoint[]]> = [
    ['square', squareA],
    ['triangle', triangle],
    ['pentagon', pentagon]
  ]
  const transformVariants: ReadonlyArray<[string, IrregularTransformCandidate]> = [
    ['zero', transformCandidate(0, 0, false)],
    ['rotated-90', transformCandidate(1, 90, false)],
    ['rotated-180-mirrored', transformCandidate(2, 180, true, 'orthogonal')],
    ['fractional-rotation', transformCandidate(3, 47.25, true, 'edge_alignment')],
    ['negative-zero-index-and-rotation', transformCandidate(-0, -0, false)]
  ]

  for (const [fixedLabel, fixedShape] of shapes) {
    for (const [movingLabel, movingShape] of shapes) {
      for (const [transformLabel, transform] of transformVariants) {
        const fixed = placedPiece(`hand-fixed-${fixedLabel}`, fixedShape, 15, -6, transformCandidate(0, 0, false))
        const moving = movingGeometry(`hand-moving-${movingLabel}`, movingShape, transform)
        makePairwiseCase(
          `hand-authored:fixed=${fixedLabel}:moving=${movingLabel}:transform=${transformLabel}`,
          fixed,
          moving,
          'vertex-pair-hull'
        )
      }
    }
  }

  // Canonically-equivalent fixed-piece copies: same local shape, rotated
  // start vertex and/or reversed winding, different placement translations
  // -- must each translate the SAME relative NFP by their own placement.
  const squareRotatedStart = [point(4, 4), point(0, 4), point(0, 0), point(4, 0)]
  const squareReversedWinding = [point(0, 0), point(0, 4), point(4, 4), point(4, 0)]
  const copyVariants: ReadonlyArray<[string, IrregularPoint[], number, number]> = [
    ['original', squareA, 0, 0],
    ['rotated-start-vertex', squareRotatedStart, 50, 0],
    ['reversed-winding', squareReversedWinding, 0, 50],
    ['rotated-and-reversed', [...squareRotatedStart].reverse(), 50, 50]
  ]
  for (const [label, shape, translateX, translateY] of copyVariants) {
    const fixed = placedPiece(`copy-${label}`, shape, translateX, translateY, transformCandidate(0, 0, false))
    const moving = movingGeometry('copy-moving', triangle)
    for (const algorithm of NFP_CONSTRUCTION_ALGORITHMS) {
      makePairwiseCase(`canonical-copy:${label}:algorithm=${algorithm}`, fixed, moving, algorithm)
    }
  }
}

// =============================================================================
// Section B: IFP bounds (`computeIfpBounds`).
// =============================================================================
interface IfpCase {
  readonly category: string
  readonly sheetWidth: string
  readonly sheetHeight: string
  readonly movingPieceId: string
  readonly movingPolygon: EncodedPoint[]
  readonly movingTransform: EncodedTransform
  readonly result:
    | { readonly ok: true; readonly bounds: EncodedBounds }
    | { readonly ok: false; readonly kind: 'invalid' | 'infeasible'; readonly message: string }
}
const ifpCases: IfpCase[] = []

function runComputeIfpBounds(
  input: ComputeIfpBoundsInput
):
  | { readonly ok: true; readonly bounds: EncodedBounds }
  | { readonly ok: false; readonly kind: 'invalid' | 'infeasible'; readonly message: string } {
  const exit = Effect.runSyncExit(
    NfpIfpService.use((service) => service.computeIfpBounds(input)).pipe(
      Effect.provide(NfpIfpServiceLive)
    )
  )
  if (Exit.isSuccess(exit)) {
    return { ok: true, bounds: encodeBounds(exit.value.bounds) }
  }
  const failure = Exit.findErrorOption(exit)
  if (Option.isNone(failure)) {
    throw new Error(`unexpected computeIfpBounds failure cause: ${JSON.stringify(exit.cause)}`)
  }
  if (failure.value instanceof IrregularGeometryInfeasibleError) {
    return { ok: false, kind: 'infeasible', message: failure.value.message }
  }
  if (failure.value instanceof IrregularGeometryInputError) {
    return { ok: false, kind: 'invalid', message: failure.value.message }
  }
  throw new Error(`unexpected computeIfpBounds failure cause: ${JSON.stringify(exit.cause)}`)
}

function makeIfpCase(category: string, sheet: SheetSpec, moving: TransformedCollisionGeometry): void {
  ifpCases.push({
    category,
    sheetWidth: f64Bits(sheet.width),
    sheetHeight: f64Bits(sheet.height),
    movingPieceId: moving.sourcePieceId,
    movingPolygon: encodePoints(moving.polygon.points),
    movingTransform: encodeTransform(moving.transform),
    result: runComputeIfpBounds({ sheet, moving })
  })
}

{
  // `SheetSpec.width`/`.height` are `PositiveIntegerMillimeters` (schema-
  // enforced by the trusted `SheetSpec` constructor itself), so every sheet
  // dimension fed into this section is rounded to a positive integer.
  for (let index = 0; index < 61; index += 1) {
    const points = fixtureHullRing(index)
    const b = boundsOf(points)
    const width = b.maxX - b.minX
    const height = b.maxY - b.minY
    const moving = movingGeometry(`ifp-${fixtureLabel(index)}-${index}`, points)

    const feasibleWidth = Math.max(1, Math.round(width * 5) + 200)
    const feasibleHeight = Math.max(1, Math.round(height * 5) + 200)
    makeIfpCase(`fixture-piece:${index}:feasible`, sheetSpec(feasibleWidth, feasibleHeight), moving)

    const infeasibleWidth = Math.max(1, Math.floor(width / 4))
    const infeasibleHeight = Math.max(1, Math.floor(height / 4))
    makeIfpCase(`fixture-piece:${index}:infeasible`, sheetSpec(infeasibleWidth, infeasibleHeight), moving)

    const tightWidth = Math.max(1, Math.ceil(width))
    const tightHeight = Math.max(1, Math.ceil(height))
    makeIfpCase(`fixture-piece:${index}:tight-fit`, sheetSpec(tightWidth, tightHeight), moving)
  }

  // Degenerate moving polygon (fewer than three vertices) -- 'invalid'.
  const degenerate = new TransformedCollisionGeometry({
    sourcePieceId: PieceId.make('degenerate'),
    transform: transformCandidate(0, 0, false),
    polygon: polygon([point(0, 0), point(1, 1)]),
    bounds: new IrregularBounds({ minX: 0, minY: 0, maxX: 1, maxY: 1 })
  })
  makeIfpCase('degenerate-polygon-invalid', sheetSpec(100, 100), degenerate)
}

// =============================================================================
// Section C: canonicalPlacementPointAlternatives ordering (contractual).
// =============================================================================
interface CandidateAlternativesCase {
  readonly category: string
  readonly rawPoint: EncodedPoint
  readonly alternatives: ReadonlyArray<{
    readonly x: string
    readonly y: string
    readonly squaredDistance: string
    readonly gridX: string
    readonly gridY: string
  }>
}
const candidateAlternativesCases: CandidateAlternativesCase[] = []

function makeAlternativesCase(category: string, rawPoint: IrregularPoint): void {
  const alternatives = canonicalPlacementPointAlternatives(rawPoint)
  candidateAlternativesCases.push({
    category,
    rawPoint: encodePoint(rawPoint),
    alternatives: alternatives.map((alt) => ({
      x: f64Bits(alt.x),
      y: f64Bits(alt.y),
      squaredDistance: f64Bits(alt.squaredDistance),
      gridX: f64Bits(alt.gridX),
      gridY: f64Bits(alt.gridY)
    }))
  })
}

// Caps the fixture-vertex sweep so this section stays a bounded, reviewable
// size while still exercising every real fixture piece's hull vertices.
let fixtureVertexBudget = 60
function candidateAlternativesCasesPushLimited(category: string, rawPoint: IrregularPoint): void {
  if (fixtureVertexBudget <= 0) return
  fixtureVertexBudget -= 1
  makeAlternativesCase(category, rawPoint)
}

{
  const plainPoints: ReadonlyArray<[string, number, number]> = [
    ['origin', 0, 0],
    ['positive', 12.3456, 7.891],
    ['negative', -12.3456, -7.891],
    ['negative-zero', -0, -0],
    ['exact-grid-aligned', 5, 5],
    ['half-grid-tie-x', 5.0005, 5],
    ['half-grid-tie-y', 5, 5.0005],
    ['half-grid-tie-both', 5.0005, 5.0005],
    ['large-magnitude', 123456.789, -987654.321],
    ['tiny-magnitude', 0.0001, -0.0001],
    ['near-safe-integer-boundary', 9007199254.74, 9007199254.74]
  ]
  for (const [label, x, y] of plainPoints) {
    makeAlternativesCase(`plain:${label}`, point(x, y))
  }

  // Non-finite and unsafe-magnitude inputs -- must return zero alternatives.
  makeAlternativesCase('non-finite:nan', point(NaN, 0))
  makeAlternativesCase('non-finite:infinity', point(Infinity, 0))
  makeAlternativesCase('unsafe-magnitude', point(1e20, 1e20))

  // Real fixture-piece vertices, a broad, realistic battery.
  for (let index = 0; index < 61; index += 1) {
    const ring = fixtureHullRing(index)
    for (const vertex of ring) {
      candidateAlternativesCasesPushLimited(`fixture-vertex:${index}`, vertex)
    }
  }
}

// =============================================================================
// Section D: generatePlacementCandidates ordered candidate lists.
// =============================================================================
interface GeneratedCandidateEntry {
  readonly pieceId: string
  readonly point: EncodedPoint
  readonly transform: EncodedTransform
}
interface GeneratedCandidatesCase {
  readonly category: string
  readonly sheetWidth: string
  readonly sheetHeight: string
  readonly placed: ReadonlyArray<{
    readonly points: EncodedPoint[]
    readonly translateX: string
    readonly translateY: string
  }>
  readonly movingPieceId: string
  readonly movingPolygon: EncodedPoint[]
  readonly movingTransform: EncodedTransform
  readonly candidateDomain: 'sheet' | 'contact-only' | 'sheetless-nfp'
  readonly pruningMode: NfpCandidatePruningMode
  readonly result:
    | { readonly ok: true; readonly candidates: ReadonlyArray<GeneratedCandidateEntry> }
    | { readonly ok: false; readonly tag: string; readonly message: string }
}
const generatedCandidatesCases: GeneratedCandidatesCase[] = []

function runGenerateCandidates(
  input: GeneratePlacementCandidatesInput,
  algorithm: NfpConstructionAlgorithm,
  pruningMode: NfpCandidatePruningMode
):
  | { readonly ok: true; readonly candidates: ReadonlyArray<GeneratedCandidateEntry> }
  | { readonly ok: false; readonly tag: string; readonly message: string } {
  const exit = Effect.runSyncExit(
    NfpIfpService.use((service) => service.generatePlacementCandidates(input)).pipe(
      Effect.provide(makeNfpIfpServiceLive(algorithm, pruningMode))
    )
  )
  if (Exit.isSuccess(exit)) {
    return {
      ok: true,
      candidates: exit.value.map((candidate) => ({
        pieceId: candidate.pieceId,
        point: encodePoint(candidate.point),
        transform: encodeTransform(candidate.transform)
      }))
    }
  }
  const failure = Exit.findErrorOption(exit)
  if (Option.isNone(failure)) {
    throw new Error(`unexpected generatePlacementCandidates failure cause: ${JSON.stringify(exit.cause)}`)
  }
  const tag =
    failure.value instanceof IrregularGeometryInputError
      ? 'IrregularGeometryInputError'
      : failure.value instanceof IrregularNfpIfpControlAbortError
        ? 'IrregularNfpIfpControlAbortError'
        : 'unknown'
  return { ok: false, tag, message: (failure.value as { message: string }).message }
}

function makeGeneratedCandidatesCase(
  category: string,
  sheet: SheetSpec,
  placed: ReadonlyArray<IrregularPlacedPiece>,
  moving: TransformedCollisionGeometry,
  candidateDomain: 'sheet' | 'contact-only' | 'sheetless-nfp',
  pruningMode: NfpCandidatePruningMode
): void {
  const input: GeneratePlacementCandidatesInput = {
    sheet,
    placed,
    moving,
    settings: NESTING_SETTINGS,
    candidateDomain
  }
  generatedCandidatesCases.push({
    category,
    sheetWidth: f64Bits(sheet.width),
    sheetHeight: f64Bits(sheet.height),
    placed: placed.map((p) => ({
      points: encodePoints(p.collisionGeometry.polygon.points),
      translateX: f64Bits(p.placement.transform.translateX),
      translateY: f64Bits(p.placement.transform.translateY)
    })),
    movingPieceId: moving.sourcePieceId,
    movingPolygon: encodePoints(moving.polygon.points),
    movingTransform: encodeTransform(moving.transform),
    candidateDomain,
    pruningMode,
    result: runGenerateCandidates(input, 'vertex-pair-hull', pruningMode)
  })
}

{
  const square = [point(0, 0), point(2, 0), point(2, 2), point(0, 2)]
  const triangle = [point(0, 0), point(1, 0), point(0.5, 1)]
  const sheetSmall = sheetSpec(10, 10)
  const sheetMedium = sheetSpec(20, 20)

  const domains: ReadonlyArray<'sheet' | 'contact-only' | 'sheetless-nfp'> = [
    'sheet',
    'contact-only',
    'sheetless-nfp'
  ]
  const pruningModes: ReadonlyArray<NfpCandidatePruningMode> = ['indexed', 'reference']

  for (const placedCount of [0, 1, 2, 3]) {
    const placed: IrregularPlacedPiece[] = []
    for (let index = 0; index < placedCount; index += 1) {
      placed.push(placedPiece(`placed-${index}`, square, index * 4, 0))
    }
    const moving = movingGeometry('moving-triangle', triangle)
    for (const domain of domains) {
      for (const pruningMode of pruningModes) {
        makeGeneratedCandidatesCase(
          `placed-count=${placedCount}:domain=${domain}:pruning=${pruningMode}`,
          sheetSmall,
          placed,
          moving,
          domain,
          pruningMode
        )
      }
    }
  }

  // A slightly larger scene: three placed pieces at varied offsets, moving
  // a differently shaped piece -- exercises the pairwise NFP-NFP
  // intersection loops in both pruning modes.
  const pentagon = [point(0, 0), point(3, -1), point(4, 2), point(2, 4), point(-1, 2)]
  const largerPlaced = [
    placedPiece('large-a', square, 0, 0),
    placedPiece('large-b', square, 5, 0),
    placedPiece('large-c', square, 0, 5)
  ]
  for (const pruningMode of pruningModes) {
    makeGeneratedCandidatesCase(
      `larger-scene:pruning=${pruningMode}`,
      sheetMedium,
      largerPlaced,
      movingGeometry('moving-pentagon', pentagon),
      'sheet',
      pruningMode
    )
  }
}

// =============================================================================
// Section E: validation rejections and cooperative aborts.
// =============================================================================
interface RejectionCase {
  readonly category: string
  readonly operation: 'computeNfp' | 'computeIfpBounds' | 'generatePlacementCandidates'
  readonly expectedTag: string
  readonly message: string
  readonly observedPhases: ReadonlyArray<string>
}
const rejectionCases: RejectionCase[] = []

{
  // computeNfp: degenerate fixed collision polygon.
  const degenerateFixed = placedPiece('degenerate-fixed', [point(0, 0), point(1, 1)], 0, 0)
  const moving = movingGeometry('rejection-moving', [point(0, 0), point(2, 0), point(2, 2), point(0, 2)])
  const nfpResult = runComputeNfp({ fixed: degenerateFixed, moving, settings: NESTING_SETTINGS.geometry }, 'vertex-pair-hull')
  rejectionCases.push({
    category: 'computeNfp:degenerate-fixed-polygon',
    operation: 'computeNfp',
    expectedTag: 'IrregularGeometryInputError',
    message: nfpResult.ok ? '' : nfpResult.message,
    observedPhases: []
  })

  // computeIfpBounds: degenerate moving polygon ('invalid').
  const degenerateMoving = new TransformedCollisionGeometry({
    sourcePieceId: PieceId.make('degenerate-moving'),
    transform: transformCandidate(0, 0, false),
    polygon: polygon([point(0, 0), point(1, 1)]),
    bounds: new IrregularBounds({ minX: 0, minY: 0, maxX: 1, maxY: 1 })
  })
  const ifpResult = runComputeIfpBounds({ sheet: sheetSpec(100, 100), moving: degenerateMoving })
  rejectionCases.push({
    category: 'computeIfpBounds:degenerate-moving-polygon',
    operation: 'computeIfpBounds',
    expectedTag: 'IrregularGeometryInputError',
    message: !ifpResult.ok ? ifpResult.message : '',
    observedPhases: []
  })

  // generatePlacementCandidates: degenerate placed-piece collision polygon
  // (rejected inside the placed-NFP resolution loop).
  const degenerateInLoop = placedPiece('degenerate-in-loop', [point(0, 0), point(1, 1)], 0, 0)
  const squareMoving = movingGeometry('degenerate-loop-moving', [
    point(0, 0),
    point(2, 0),
    point(2, 2),
    point(0, 2)
  ])
  const candidatesResult = runGenerateCandidates(
    {
      sheet: sheetSpec(20, 20),
      placed: [degenerateInLoop],
      moving: squareMoving,
      settings: NESTING_SETTINGS
    },
    'vertex-pair-hull',
    'indexed'
  )
  rejectionCases.push({
    category: 'generatePlacementCandidates:degenerate-placed-piece',
    operation: 'generatePlacementCandidates',
    expectedTag: 'IrregularGeometryInputError',
    message: !candidatesResult.ok ? candidatesResult.message : '',
    observedPhases: []
  })

  // generatePlacementCandidates: cooperative abort at a specific phase.
  const abortPhases: IrregularNfpIfpCheckpointPhase[] = [
    'ifp',
    'placed-nfp',
    'ifp-boundary-intersection',
    'pairwise-nfp-boundary-intersection',
    'candidate-points'
  ]
  for (const abortPhase of abortPhases) {
    const observedPhases: string[] = []
    const firstFixed = placedPiece('abort-fixed-1', [point(0, 0), point(2, 0), point(2, 2), point(0, 2)], 4, 4)
    const secondFixed = placedPiece('abort-fixed-2', [point(0, 0), point(2, 0), point(2, 2), point(0, 2)], -4, -4)
    const abortMoving = movingGeometry('abort-moving', [point(0, 0), point(2, 0), point(2, 2), point(0, 2)])
    const controlledInput: GeneratePlacementCandidatesInput = {
      sheet: sheetSpec(10, 10),
      placed: [firstFixed, secondFixed],
      moving: abortMoving,
      settings: NESTING_SETTINGS,
      control: {
        checkpoint: (phase) => {
          observedPhases.push(phase)
          return phase === abortPhase
            ? Effect.fail(
                new IrregularNfpIfpControlAbortError({ reason: 'deadline', message: `test abort at ${phase}` })
              )
            : Effect.void
        }
      }
    }
    const exit = Effect.runSyncExit(
      NfpIfpService.use((service) => service.generatePlacementCandidates(controlledInput)).pipe(
        Effect.provide(NfpIfpServiceLive)
      )
    )
    const failure = Exit.isFailure(exit) ? Exit.findErrorOption(exit) : Option.none()
    const message =
      Option.isSome(failure) && failure.value instanceof IrregularNfpIfpControlAbortError
        ? failure.value.message
        : ''
    rejectionCases.push({
      category: `generatePlacementCandidates:abort-at-${abortPhase}`,
      operation: 'generatePlacementCandidates',
      expectedTag: 'IrregularNfpIfpControlAbortError',
      message,
      observedPhases
    })
  }
}

// =============================================================================
// Section F: cache hit/store/stale sequences with telemetry snapshots.
// =============================================================================
interface CacheStepResult {
  readonly op: 'compute-nfp' | 'compute-ifp'
  readonly ok: boolean
  readonly telemetryAfter: {
    readonly memo: NfpIfpTelemetry.NfpIfpTelemetrySnapshot['memo']
    readonly checkpoints: NfpIfpTelemetry.NfpIfpTelemetrySnapshot['checkpoints']
    /** This scenario's own namespace's counters (getCalls/getPresent/setCalls/removeCalls),
     * cumulative across every step so far -- proves the hit/stale/evict
     * sequence directly rather than only "the call succeeded", since
     * `makeGeometryCacheStore()` (`geometryCacheStoreLive.ts`) records every
     * `get`/`set`/`remove` into this same global telemetry singleton
     * regardless of which `GeometryCache` layer wraps the store. */
    readonly namespaceCounters: NfpIfpTelemetry.NfpIfpCacheNamespaceCounters
  }
}
interface CacheSequenceCase {
  readonly category: string
  readonly namespace: string
  readonly steps: ReadonlyArray<CacheStepResult>
}
const cacheSequenceCases: CacheSequenceCase[] = []

function sharedCacheLayer() {
  const store = makeGeometryCacheStore()
  const layer = Layer.succeed(GeometryCache, {
    store,
    get: <A>(key: Parameters<typeof store.get>[0]) => Effect.sync(() => store.get<A>(key)),
    set: <A>(key: Parameters<typeof store.set>[0], value: A) => Effect.sync(() => store.set(key, value)),
    remove: (key: Parameters<typeof store.remove>[0]) => Effect.sync(() => store.remove(key)),
    clear: Effect.sync(() => store.clear())
  })
  return { store, layer }
}

{
  // NFP cache: miss-then-store, then hit; then a poked-stale entry that
  // must be evicted and recomputed.
  const { store, layer } = sharedCacheLayer()
  const serviceLayer = makeNfpIfpServiceLayer('vertex-pair-hull').pipe(Layer.provideMerge(layer))
  NfpIfpTelemetry.enableNfpIfpTelemetry()

  const fixed = placedPiece('cache-fixed', [point(0, 0), point(4, 0), point(4, 4), point(0, 4)], 8, 8)
  const moving = movingGeometry('cache-moving', [point(0, 0), point(2, 0), point(2, 2), point(0, 2)])
  const nfpInput: ComputeNfpInput = { fixed, moving, settings: NESTING_SETTINGS.geometry }

  function nfpStep(): CacheStepResult {
    const exit = Effect.runSyncExit(
      NfpIfpService.use((service) => service.computeNfp(nfpInput)).pipe(Effect.provide(serviceLayer))
    )
    const snapshot = NfpIfpTelemetry.nfpIfpTelemetrySnapshot()
    if (snapshot === undefined) throw new Error('telemetry snapshot unexpectedly undefined')
    return {
      op: 'compute-nfp',
      ok: Exit.isSuccess(exit),
      telemetryAfter: {
        memo: snapshot.memo,
        checkpoints: snapshot.checkpoints,
        namespaceCounters: snapshot.namespaces['pairwise-nfp-relative-v3'] ?? {
          getCalls: 0,
          getPresent: 0,
          setCalls: 0,
          removeCalls: 0
        }
      }
    }
  }

  const steps: CacheStepResult[] = []
  steps.push(nfpStep()) // miss + store
  steps.push(nfpStep()) // hit

  // Poke a structurally-present-but-invalid entry under the exact key this
  // input builds, forcing the next lookup to detect staleness and evict.
  const key = pairwiseNfpCacheKey(nfpInput, 'vertex-pair-hull')
  store.set(key, { points: [{ x: 0, y: 0 }] }) // fewer than 3 points -> invalid
  steps.push(nfpStep()) // stale detection + evict + recompute + store

  cacheSequenceCases.push({ category: 'nfp:miss-hit-stale-recompute', namespace: 'pairwise-nfp-relative-v3', steps })
  NfpIfpTelemetry.disableNfpIfpTelemetry()
}

{
  // IFP cache: miss-then-store, then hit; then a poked-stale entry.
  const { store, layer } = sharedCacheLayer()
  const serviceLayer = makeNfpIfpServiceLayer('vertex-pair-hull').pipe(Layer.provideMerge(layer))
  NfpIfpTelemetry.enableNfpIfpTelemetry()

  const moving = movingGeometry('cache-ifp-moving', [point(0, 0), point(4, 0), point(4, 3), point(0, 3)])
  const ifpInput: ComputeIfpBoundsInput = { sheet: sheetSpec(40, 30), moving }

  function ifpStep(): CacheStepResult {
    const exit = Effect.runSyncExit(
      NfpIfpService.use((service) => service.computeIfpBounds(ifpInput)).pipe(Effect.provide(serviceLayer))
    )
    const snapshot = NfpIfpTelemetry.nfpIfpTelemetrySnapshot()
    if (snapshot === undefined) throw new Error('telemetry snapshot unexpectedly undefined')
    return {
      op: 'compute-ifp',
      ok: Exit.isSuccess(exit),
      telemetryAfter: {
        memo: snapshot.memo,
        checkpoints: snapshot.checkpoints,
        namespaceCounters: snapshot.namespaces['sheet-ifp-v1'] ?? {
          getCalls: 0,
          getPresent: 0,
          setCalls: 0,
          removeCalls: 0
        }
      }
    }
  }

  const steps: CacheStepResult[] = []
  steps.push(ifpStep()) // miss + store
  steps.push(ifpStep()) // hit

  const key = innerFitBoundsCacheKey(ifpInput)
  store.set(key, {
    sheet: ifpInput.sheet,
    movingPieceId: 'a-different-piece-id',
    bounds: { minX: -999, minY: -999, maxX: 999, maxY: 999 }
  })
  steps.push(ifpStep()) // stale detection + evict + recompute + store

  cacheSequenceCases.push({ category: 'ifp:miss-hit-stale-recompute', namespace: 'sheet-ifp-v1', steps })
  NfpIfpTelemetry.disableNfpIfpTelemetry()
}

// =============================================================================
// Assemble + write output.
// =============================================================================
const totalCaseCount =
  pairwiseNfpCases.length +
  ifpCases.length +
  candidateAlternativesCases.length +
  generatedCandidatesCases.length +
  rejectionCases.length +
  cacheSequenceCases.length

if (totalCaseCount < 500) {
  throw new Error(`Expected at least 500 total nfp-ifp vectors, generated only ${totalCaseCount}.`)
}

mkdirSync(VECTORS_DIR, { recursive: true })

const commit = generatingCommit()

const output = {
  generatedByScript: 'scripts/rust-parity/dump-nfp-ifp.ts',
  generatingCommit: commit,
  sourceModules: [
    'src/workers/irregular/core/nfpBoundaryCore.ts',
    'src/workers/irregular/core/ifpBoundsCore.ts',
    'src/workers/irregular/nfpIfpService.ts',
    'src/workers/irregular/nfpIfpTelemetry.ts'
  ],
  description:
    'computeNfp/computeIfpBounds/generatePlacementCandidates evaluated through the real NfpIfpServiceLive ' +
    '(and the real GeometryCache layer for cache-sequence scenarios) across real mixed61 fixture-piece ' +
    'convex hulls, hand-authored polygons with rotation/mirror/transform-index variants, canonically-' +
    'equivalent fixed-piece copies, canonicalPlacementPointAlternatives complete ordered alternative ' +
    'lists, generatePlacementCandidates complete ordered candidate lists across placed-piece-count/domain/' +
    'pruning-mode variants, validation-rejection and cooperative-abort cases with observed checkpoint ' +
    'phase sequences, and cache hit/store/stale-eviction sequences with NfpIfpTelemetry snapshots.',
  totalCaseCount,
  pairwiseNfp: { caseCount: pairwiseNfpCases.length, cases: pairwiseNfpCases },
  ifp: { caseCount: ifpCases.length, cases: ifpCases },
  candidateAlternatives: {
    caseCount: candidateAlternativesCases.length,
    cases: candidateAlternativesCases
  },
  generatedCandidates: {
    caseCount: generatedCandidatesCases.length,
    cases: generatedCandidatesCases
  },
  rejections: { caseCount: rejectionCases.length, cases: rejectionCases },
  cacheSequences: { caseCount: cacheSequenceCases.length, cases: cacheSequenceCases }
}

writeFileSync(join(VECTORS_DIR, 'nfp-ifp.json'), JSON.stringify(output, null, 2) + '\n')

console.log(
  `Wrote ${totalCaseCount} nfp-ifp vectors ` +
    `(pairwiseNfp=${pairwiseNfpCases.length}, ifp=${ifpCases.length}, ` +
    `candidateAlternatives=${candidateAlternativesCases.length}, ` +
    `generatedCandidates=${generatedCandidatesCases.length}, rejections=${rejectionCases.length}, ` +
    `cacheSequences=${cacheSequenceCases.length}; commit ${commit}) to ${VECTORS_DIR}`
)
