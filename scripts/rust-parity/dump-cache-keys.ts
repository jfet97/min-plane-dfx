/**
 * Differential-vector dump for the Rust `caches` module
 * (`crates/irregular-nesting-native/src/caches/{nfp_cache_key,
 * geometry_cache_identity, legal_candidate_memo, store}.rs`).
 *
 * Imports the REAL production TS entry points --
 *   - `makePairwiseNfpCacheKey` (`src/workers/irregular/core/nfpCacheKey.ts`,
 *     namespace `pairwise-nfp-relative-v3`),
 *   - `makeTransformCollisionGeometryCacheKey` /
 *     `makeInnerFitBoundsCacheKey` (`src/workers/irregular/core/geometryCacheIdentity.ts`,
 *     namespaces `transform-collision-v1` / `sheet-ifp-v1`),
 *   - `legalPlacementCandidateMemoKey` (`src/workers/irregular/geometryCacheKeys.ts`,
 *     namespace `legal-placement-candidates-v1`),
 *   - `serializeGeometryCacheKey` (`src/workers/irregular/core/geometryCacheStore.ts`),
 *   - `makeGeometryCacheStore` (`src/workers/irregular/geometryCacheStoreLive.ts`) --
 * evaluates them over a broad deliberate input matrix (piece ids with
 * special/control/non-ASCII characters, transforms including `-0` rotations
 * and indices, sheets with and without labels, real mixed61 fixture-piece
 * rings, every `NfpConstructionAlgorithm`/`NfpCandidatePruningMode`/
 * candidate-domain variant), plus store hit/miss/stale-eviction scenarios
 * exercised through the real `makeGeometryCacheStore`, and writes byte-exact
 * JSON vectors for a Rust integration test to replay.
 *
 * Every case records **both** the raw input the TS key builder consumed
 * (`f64` fields as big-endian IEEE-754 bit-pattern hex strings, per
 * `dump-predicates.ts`'s `f64Bits` convention) **and** the resulting key, so
 * the Rust test can feed the identical input through its own port and assert
 * exact equality against the recorded key -- not just replay a pre-rendered
 * string.
 *
 * Run with:
 *   pnpm exec tsx --tsconfig tsconfig.node.json scripts/rust-parity/dump-cache-keys.ts
 *
 * Output (additive; never edits existing fixtures/tests):
 *   - crates/irregular-nesting-native/tests/vectors/cache-keys.json
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_NFP_CONSTRUCTION_ALGORITHM,
  makePairwiseNfpCacheKey,
  NFP_CONSTRUCTION_ALGORITHMS,
  NFP_GEOMETRY_CACHE_NAMESPACE,
  type NfpConstructionAlgorithm,
  type PairwiseNfpKeyInput
} from '../../src/workers/irregular/core/nfpCacheKey.js'
import {
  IFP_GEOMETRY_CACHE_NAMESPACE,
  type InnerFitBoundsKeyInput,
  makeInnerFitBoundsCacheKey,
  makeTransformCollisionGeometryCacheKey,
  TRANSFORM_GEOMETRY_CACHE_NAMESPACE,
  type TransformCollisionGeometryKeyInput
} from '../../src/workers/irregular/core/geometryCacheIdentity.js'
import {
  LEGAL_CANDIDATE_MEMO_NAMESPACE,
  legalPlacementCandidateMemoKey,
  type NfpCandidatePruningMode
} from '../../src/workers/irregular/geometryCacheKeys.js'
import type { GeometryCacheKey } from '../../src/workers/irregular/core/geometryCacheStore.js'
import { serializeGeometryCacheKey } from '../../src/workers/irregular/core/geometryCacheStore.js'
import { makeGeometryCacheStore } from '../../src/workers/irregular/geometryCacheStoreLive.js'
import type {
  InternalCollisionGeometry,
  InternalGeometrySettings,
  InternalPoint,
  InternalTransformCandidate
} from '../../src/workers/irregular/internalGeometry.js'
import type { GeneratePlacementCandidatesInput } from '../../src/workers/irregular/services.js'

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
// across every code path). Matches `dump-predicates.ts`'s `f64Bits`
// convention exactly.
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

function point(x: number, y: number): InternalPoint {
  return { x, y }
}

// ---------------------------------------------------------------------------
// Real mixed61 fixture-piece rings.
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
function fixtureRing(index: number): InternalPoint[] {
  const piece = mixed61Fixture.sourcePieces[index % mixed61Fixture.sourcePieces.length]
  if (piece === undefined) throw new Error('fixture piece index out of range')
  return piece.geometry.segments.map((segment) => point(segment.x1, segment.y1))
}
function fixtureLabel(index: number): string {
  return mixed61Fixture.sourcePieces[index % mixed61Fixture.sourcePieces.length]?.label ?? `piece-${index}`
}

// ---------------------------------------------------------------------------
// Encoding helpers.
// ---------------------------------------------------------------------------
interface EncodedPoint {
  readonly x: string
  readonly y: string
}
function encodePoint(p: InternalPoint): EncodedPoint {
  return { x: f64Bits(p.x), y: f64Bits(p.y) }
}
function encodePoints(points: ReadonlyArray<InternalPoint>): EncodedPoint[] {
  return points.map(encodePoint)
}

interface EncodedBounds {
  readonly minX: string
  readonly minY: string
  readonly maxX: string
  readonly maxY: string
}
function encodeBounds(bounds: {
  minX: number
  minY: number
  maxX: number
  maxY: number
}): EncodedBounds {
  return {
    minX: f64Bits(bounds.minX),
    minY: f64Bits(bounds.minY),
    maxX: f64Bits(bounds.maxX),
    maxY: f64Bits(bounds.maxY)
  }
}

interface EncodedTransform {
  readonly index: string
  readonly rotationDeg: string
  readonly mirrored: boolean
  readonly reason: string
}
function transform(
  index: number,
  rotationDeg: number,
  mirrored: boolean,
  reason: string
): InternalTransformCandidate {
  return { index, rotationDeg, mirrored, reason }
}
function encodeTransform(t: InternalTransformCandidate): EncodedTransform {
  return {
    index: f64Bits(t.index),
    rotationDeg: f64Bits(t.rotationDeg),
    mirrored: t.mirrored,
    reason: t.reason
  }
}

interface EncodedSettings {
  readonly flatteningSagToleranceMm: string
  readonly clearanceSafetyMarginMm: string
  readonly geometryBackendId: string
  readonly geometryBackendVersion: string
}
function settings(
  flatteningSagToleranceMm: number,
  clearanceSafetyMarginMm: number,
  geometryBackendId: string,
  geometryBackendVersion: string
): InternalGeometrySettings {
  return {
    flatteningSagToleranceMm,
    clearanceSafetyMarginMm,
    geometryBackendId,
    geometryBackendVersion
  }
}
function encodeSettings(s: InternalGeometrySettings): EncodedSettings {
  return {
    flatteningSagToleranceMm: f64Bits(s.flatteningSagToleranceMm),
    clearanceSafetyMarginMm: f64Bits(s.clearanceSafetyMarginMm),
    geometryBackendId: s.geometryBackendId,
    geometryBackendVersion: s.geometryBackendVersion
  }
}

interface EncodedGeometryCacheKey {
  readonly namespace: string
  readonly parts: ReadonlyArray<string>
  readonly serialized: string
}
function encodeKey(key: GeometryCacheKey): EncodedGeometryCacheKey {
  return {
    namespace: key.namespace,
    parts: key.parts,
    serialized: serializeGeometryCacheKey(key)
  }
}

const REASONS = ['orthogonal', 'edge_alignment', 'configured'] as const

// Piece ids / labels / backend-id strings deliberately covering: empty
// string, ASCII punctuation, JSON-special characters (quote/backslash),
// control characters, non-ASCII text, and leading/trailing whitespace.
const SPECIAL_STRINGS: ReadonlyArray<string> = [
  'plain-piece-id',
  '',
  'has "quotes" inside',
  'has\\backslash\\inside',
  'has\ttab\tand\nnewline',
  'pièce-日本語-emoji-🧩',
  '  leading and trailing spaces  ',
  "single'quote",
  'unicode--control',
  'a'.repeat(200)
]

// ---------------------------------------------------------------------------
// Section A: pairwise-nfp-relative-v3 (`makePairwiseNfpCacheKey`).
// ---------------------------------------------------------------------------
interface PairwiseNfpCase {
  readonly category: string
  readonly fixedPolygon: EncodedPoint[]
  readonly movingPolygon: EncodedPoint[]
  readonly fixedTransform: EncodedTransform
  readonly movingTransform: EncodedTransform
  readonly settings: EncodedSettings
  readonly algorithm: string
  readonly key: EncodedGeometryCacheKey
}
const pairwiseNfpCases: PairwiseNfpCase[] = []

function makePairwiseCase(
  category: string,
  input: PairwiseNfpKeyInput,
  algorithm: NfpConstructionAlgorithm
): void {
  const key = makePairwiseNfpCacheKey(input, algorithm)
  pairwiseNfpCases.push({
    category,
    fixedPolygon: encodePoints(input.fixedPolygon),
    movingPolygon: encodePoints(input.movingPolygon),
    fixedTransform: encodeTransform(input.fixedTransform),
    movingTransform: encodeTransform(input.movingTransform),
    settings: encodeSettings(input.settings),
    algorithm,
    key: encodeKey(key)
  })
}

{
  const squareA = [point(0, 0), point(4, 0), point(4, 4), point(0, 4)]
  const squareB = [point(4, 4), point(0, 4), point(0, 0), point(4, 0)] // rotated start, same winding
  const squareCw = [point(0, 0), point(0, 4), point(4, 4), point(4, 0)] // reversed winding
  const triangle = [point(0, 0), point(2, 0), point(1, 2)]
  const withNegZero = [point(-0, 0), point(2, -0), point(2, 2), point(-0, 2)]
  const withDuplicates = [point(0, 0), point(0, 0), point(4, 0), point(4, 4), point(0, 4)]
  const empty: InternalPoint[] = []
  const singlePoint = [point(3, 3)]

  const polygonPairs: ReadonlyArray<[string, InternalPoint[], InternalPoint[]]> = [
    ['squares', squareA, [point(0, 0), point(0, 2), point(2, 2), point(2, 0)]],
    ['rotated-start-vertex', squareA, squareB],
    ['reversed-winding', squareA, squareCw],
    ['triangle-and-square', triangle, squareA],
    ['negative-zero-coords', withNegZero, squareA],
    ['duplicate-vertices', withDuplicates, squareA],
    ['empty-fixed', empty, squareA],
    ['single-point-moving', squareA, singlePoint],
    ['fixture-piece-pair-0', fixtureRing(0), fixtureRing(1)],
    ['fixture-piece-pair-30', fixtureRing(30), fixtureRing(31)],
    ['fixture-piece-pair-60', fixtureRing(60), fixtureRing(2)]
  ]

  const transformVariants: ReadonlyArray<[string, InternalTransformCandidate]> = [
    ['zero', transform(0, 0, false, 'configured')],
    ['negative-zero-index-and-rotation', transform(-0, -0, false, 'orthogonal')],
    ['mirrored-true', transform(2, 90, true, 'edge_alignment')],
    ['negative-index', transform(-5, 270, false, 'configured')],
    ['full-turn-vs-zero', transform(0, 360, false, 'configured')],
    ['fractional-rotation', transform(1.5, 47.25, true, 'orthogonal')]
  ]

  const settingsVariants: ReadonlyArray<[string, InternalGeometrySettings]> = [
    ['default', settings(0.05, 0.05, 'clipper2-ts', '2.0.1-18')],
    ['negative-zero-margins', settings(0.1, -0, 'clipper2-ts', '2.0.1-18')],
    ['special-backend-strings', settings(0.25, 0.5, 'backend "quoted" \\ id', 'v1.0.0-é')]
  ]

  for (const [pairLabel, fixed, moving] of polygonPairs) {
    for (const algorithm of NFP_CONSTRUCTION_ALGORITHMS) {
      makePairwiseCase(
        `polygon-pair:${pairLabel}:algorithm=${algorithm}`,
        {
          fixedPolygon: fixed,
          movingPolygon: moving,
          fixedTransform: transform(0, 0, false, 'configured'),
          movingTransform: transform(0, 0, false, 'configured'),
          settings: settings(0.05, 0.05, 'clipper2-ts', '2.0.1-18')
        },
        algorithm
      )
    }
  }

  // Every real fixture-piece ring paired with its successor, both
  // construction algorithms -- exercises `canonicalPolygonDigest` broadly
  // (rotation-/winding-invariant fingerprint) across 61 real rings.
  for (let index = 0; index < 61; index += 1) {
    for (const algorithm of NFP_CONSTRUCTION_ALGORITHMS) {
      makePairwiseCase(
        `fixture-pair:${index}:algorithm=${algorithm}`,
        {
          fixedPolygon: fixtureRing(index),
          movingPolygon: fixtureRing((index + 1) % 61),
          fixedTransform: transform(0, 0, false, 'configured'),
          movingTransform: transform(0, 0, false, 'configured'),
          settings: settings(0.05, 0.05, 'clipper2-ts', '2.0.1-18')
        },
        algorithm
      )
    }
  }

  for (const [transformLabel, fixedTransform] of transformVariants) {
    for (const [transformLabel2, movingTransform] of transformVariants) {
      makePairwiseCase(
        `transform-pair:fixed=${transformLabel}:moving=${transformLabel2}`,
        {
          fixedPolygon: squareA,
          movingPolygon: triangle,
          fixedTransform,
          movingTransform,
          settings: settings(0.05, 0.05, 'clipper2-ts', '2.0.1-18')
        },
        DEFAULT_NFP_CONSTRUCTION_ALGORITHM
      )
    }
  }

  for (const [settingsLabel, geometrySettings] of settingsVariants) {
    makePairwiseCase(
      `settings:${settingsLabel}`,
      {
        fixedPolygon: squareA,
        movingPolygon: triangle,
        fixedTransform: transform(0, 0, false, 'configured'),
        movingTransform: transform(0, 0, false, 'configured'),
        settings: geometrySettings
      },
      DEFAULT_NFP_CONSTRUCTION_ALGORITHM
    )
  }

  for (const reason of REASONS) {
    makePairwiseCase(
      `reason:${reason}`,
      {
        fixedPolygon: squareA,
        movingPolygon: triangle,
        fixedTransform: transform(0, 0, false, reason),
        movingTransform: transform(0, 0, false, reason),
        settings: settings(0.05, 0.05, 'clipper2-ts', '2.0.1-18')
      },
      DEFAULT_NFP_CONSTRUCTION_ALGORITHM
    )
  }
}

// ---------------------------------------------------------------------------
// Section B: transform-collision-v1 (`makeTransformCollisionGeometryCacheKey`).
// ---------------------------------------------------------------------------
interface TransformCollisionCase {
  readonly category: string
  readonly sourcePieceId: string
  readonly sourceBounds: EncodedBounds
  readonly placementReference: EncodedPoint
  readonly convexHull: EncodedPoint[]
  readonly collisionPolygon: EncodedPoint[]
  readonly transform: EncodedTransform
  readonly settings: EncodedSettings
  readonly key: EncodedGeometryCacheKey
}
const transformCollisionCases: TransformCollisionCase[] = []

function makeTransformCollisionCase(
  category: string,
  input: TransformCollisionGeometryKeyInput,
  geometrySettings: InternalGeometrySettings
): void {
  const key = makeTransformCollisionGeometryCacheKey(input, geometrySettings)
  transformCollisionCases.push({
    category,
    sourcePieceId: input.geometry.sourcePieceId,
    sourceBounds: encodeBounds(input.geometry.sourceBounds),
    placementReference: encodePoint(input.geometry.placementReference),
    convexHull: encodePoints(input.geometry.convexHull.points),
    collisionPolygon: encodePoints(input.geometry.collisionPolygon.points),
    transform: encodeTransform(input.transform),
    settings: encodeSettings(geometrySettings),
    key: encodeKey(key)
  })
}

function collisionGeometry(
  sourcePieceId: string,
  hull: InternalPoint[],
  collision: InternalPoint[],
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  placementReference: InternalPoint
): InternalCollisionGeometry {
  return {
    sourcePieceId,
    sourceBounds: bounds,
    sampledPoints: [point(0.1, 0.1), point(0.2, 0.2)], // deliberately populated -- must NOT reach the digest
    convexHull: { points: hull },
    collisionPolygon: { points: collision },
    placementReference
  }
}

{
  const sampleHull = [point(0, 0), point(4, 0), point(4, 3), point(0, 3)]
  const sampleBounds = { minX: 0, minY: 0, maxX: 4, maxY: 3 }
  const defaultSettings = settings(0.25, 0.25, 'irregular-convex-v2-default', '0')

  const transformVariants: ReadonlyArray<[string, InternalTransformCandidate]> = [
    ['zero', transform(0, 0, false, 'configured')],
    ['negative-zero-index-and-rotation', transform(-0, -0, false, 'orthogonal')],
    ['rotation-0-vs-360', transform(0, 360, false, 'configured')],
    ['mirrored', transform(3, 180, true, 'edge_alignment')],
    ['negative-index', transform(-1, 45, false, 'configured')]
  ]

  // Cross product: every special-character piece id against every transform
  // variant, so the digest boundary between `source=` and the following
  // `;source-bounds=` component is exercised with adversarial piece ids at
  // every rotation/mirror/reason combination.
  for (const pieceId of SPECIAL_STRINGS) {
    for (const [label, transformCandidate] of transformVariants) {
      makeTransformCollisionCase(
        `piece-id:${JSON.stringify(pieceId)}:transform=${label}`,
        {
          geometry: collisionGeometry(pieceId, sampleHull, sampleHull, sampleBounds, point(0, 0)),
          transform: transformCandidate
        },
        defaultSettings
      )
    }
  }

  for (const [label, transformCandidate] of transformVariants) {
    makeTransformCollisionCase(
      `transform:${label}`,
      {
        geometry: collisionGeometry('key-piece', sampleHull, sampleHull, sampleBounds, point(0, 0)),
        transform: transformCandidate
      },
      defaultSettings
    )
  }

  const boundsVariants: ReadonlyArray<
    [string, { minX: number; minY: number; maxX: number; maxY: number }]
  > = [
    ['negative-zero-bounds', { minX: -0, minY: -0, maxX: 4, maxY: 3 }],
    ['negative-bounds', { minX: -10, minY: -5, maxX: -2, maxY: -1 }]
  ]
  for (const [label, bounds] of boundsVariants) {
    makeTransformCollisionCase(
      `bounds:${label}`,
      {
        geometry: collisionGeometry('key-piece', sampleHull, sampleHull, bounds, point(-0, -0)),
        transform: transform(0, 0, false, 'configured')
      },
      defaultSettings
    )
  }

  // Distinct hull vs. collision polygon -- both fold into the digest.
  makeTransformCollisionCase(
    'distinct-hull-and-collision-polygon',
    {
      geometry: collisionGeometry(
        'key-piece',
        sampleHull,
        [point(0, 0), point(5, 0), point(5, 5), point(0, 5)],
        sampleBounds,
        point(1, 1)
      ),
      transform: transform(0, 0, false, 'configured')
    },
    defaultSettings
  )

  // Real fixture-piece hulls, both as hull and collision polygon.
  for (let index = 0; index < 61; index += 1) {
    const ring = fixtureRing(index)
    makeTransformCollisionCase(
      `fixture-piece:${index}`,
      {
        geometry: collisionGeometry(fixtureLabel(index), ring, ring, sampleBounds, point(0, 0)),
        transform: transform(index, (index * 37) % 360, index % 2 === 0, REASONS[index % 3] as string)
      },
      defaultSettings
    )
  }

  const settingsVariants: ReadonlyArray<[string, InternalGeometrySettings]> = [
    ['negative-zero-margins', settings(0.1, -0, 'backend', 'v1')],
    ['special-strings', settings(0.5, 0.75, 'backend "id" \\ x', 'v-é-1')]
  ]
  for (const [label, geometrySettings] of settingsVariants) {
    makeTransformCollisionCase(
      `settings:${label}`,
      {
        geometry: collisionGeometry('key-piece', sampleHull, sampleHull, sampleBounds, point(0, 0)),
        transform: transform(0, 0, false, 'configured')
      },
      geometrySettings
    )
  }
}

// ---------------------------------------------------------------------------
// Section C: sheet-ifp-v1 (`makeInnerFitBoundsCacheKey`).
// ---------------------------------------------------------------------------
interface IfpCase {
  readonly category: string
  readonly sheetWidth: string
  readonly sheetHeight: string
  readonly sheetLabel: string
  readonly movingPieceId: string
  readonly movingTransform: EncodedTransform
  readonly movingPolygon: EncodedPoint[]
  readonly key: EncodedGeometryCacheKey
}
const ifpCases: IfpCase[] = []

function makeIfpCase(category: string, input: InnerFitBoundsKeyInput): void {
  const key = makeInnerFitBoundsCacheKey(input)
  ifpCases.push({
    category,
    sheetWidth: f64Bits(input.sheet.width),
    sheetHeight: f64Bits(input.sheet.height),
    sheetLabel: input.sheet.label,
    movingPieceId: input.moving.sourcePieceId,
    movingTransform: encodeTransform(input.moving.transform),
    movingPolygon: encodePoints(input.moving.polygon.points),
    key: encodeKey(key)
  })
}

{
  const sheetVariants: ReadonlyArray<[string, { width: number; height: number; label: string }]> = [
    ['plain-label', { width: 20, height: 15, label: 'key sheet' }],
    ['empty-label', { width: 20, height: 15, label: '' }],
    ['negative-zero-dims', { width: -0, height: -0, label: 'zeroed' }],
    ['label-with-quotes-and-backslash', { width: 10, height: 8, label: 'label "with" \\quotes\\' }],
    ['label-with-comma', { width: 10, height: 8, label: 'a,b,c' }],
    ['unicode-label', { width: 10, height: 8, label: '日本語ラベル' }]
  ]
  const sampleGeometry = [point(0, 0), point(4, 0), point(4, 3), point(0, 3)]
  const sampleBounds = { minX: 0, minY: 0, maxX: 4, maxY: 3 }

  const transformVariants: ReadonlyArray<[string, InternalTransformCandidate]> = [
    ['zero', transform(0, 0, false, 'configured')],
    ['negative-zero', transform(-0, -0, false, 'orthogonal')],
    ['mirrored', transform(4, 270, true, 'edge_alignment')]
  ]

  // Cross product: every sheet variant against every transform variant.
  for (const [sheetLabel, sheet] of sheetVariants) {
    for (const [transformLabel, transformCandidate] of transformVariants) {
      makeIfpCase(`sheet:${sheetLabel}:transform=${transformLabel}`, {
        sheet,
        moving: {
          sourcePieceId: 'key-piece',
          transform: transformCandidate,
          polygon: { points: sampleGeometry },
          bounds: sampleBounds
        }
      })
    }
  }

  for (const pieceId of SPECIAL_STRINGS) {
    for (const [transformLabel, transformCandidate] of transformVariants) {
      makeIfpCase(`moving-piece-id:${JSON.stringify(pieceId)}:transform=${transformLabel}`, {
        sheet: { width: 20, height: 15, label: 'key sheet' },
        moving: {
          sourcePieceId: pieceId,
          transform: transformCandidate,
          polygon: { points: sampleGeometry },
          bounds: sampleBounds
        }
      })
    }
  }

  for (let index = 0; index < 61; index += 1) {
    const ring = fixtureRing(index)
    makeIfpCase(`fixture-piece:${index}`, {
      sheet: { width: 2000, height: 2700, label: 'default 1x1 m' },
      moving: {
        sourcePieceId: fixtureLabel(index),
        transform: transform(index, (index * 11) % 360, index % 2 === 1, REASONS[index % 3] as string),
        polygon: { points: ring },
        bounds: sampleBounds
      }
    })
  }
}

// ---------------------------------------------------------------------------
// Section D: legal-placement-candidates-v1 (`legalPlacementCandidateMemoKey`).
// ---------------------------------------------------------------------------
interface EncodedPlacedPiece {
  readonly points: EncodedPoint[]
  readonly translateX: string
  readonly translateY: string
}
interface LegalCandidateMemoCase {
  readonly category: string
  /** `null` mirrors Rust's `Option::None` -- `candidateDomain ===
   * 'sheetless-nfp'`, where sheet identity collapses to `sheet=deferred`
   * regardless of whatever sheet dimensions were fed into the TS call
   * (which are irrelevant to the output in that branch). */
  readonly sheet: { readonly width: string; readonly height: string } | null
  readonly placed: EncodedPlacedPiece[]
  readonly movingPolygon: EncodedPoint[]
  readonly movingBounds: EncodedBounds
  readonly settings: EncodedSettings
  readonly algorithm: string
  readonly pruningMode: string
  readonly candidateDomain: string
  readonly key: string
}
const legalCandidateMemoCases: LegalCandidateMemoCase[] = []

interface PlacedPieceInput {
  readonly points: InternalPoint[]
  readonly translateX: number
  readonly translateY: number
}

function legalCandidateInput(fields: {
  readonly candidateDomain?: 'sheet' | 'contact-only' | 'sheetless-nfp'
  readonly sheet?: { readonly width: number; readonly height: number }
  readonly placed: ReadonlyArray<PlacedPieceInput>
  readonly movingPoints: InternalPoint[]
  readonly movingBounds: { minX: number; minY: number; maxX: number; maxY: number }
  readonly settings: InternalGeometrySettings
}): GeneratePlacementCandidatesInput {
  return {
    sheet:
      fields.sheet !== undefined
        ? { width: fields.sheet.width, height: fields.sheet.height, label: 'label-not-read-by-this-key' }
        : { width: 0, height: 0, label: 'label-not-read-by-this-key' },
    placed: fields.placed.map((placed) => ({
      placement: {
        sourcePieceId: 'placed-piece',
        transform: {
          translateX: placed.translateX,
          translateY: placed.translateY,
          rotationDeg: 0,
          mirrored: false
        }
      },
      collisionGeometry: { polygon: { points: placed.points } }
    })),
    moving: { polygon: { points: fields.movingPoints }, bounds: fields.movingBounds },
    settings: { geometry: fields.settings },
    candidateDomain: fields.candidateDomain
  } as unknown as GeneratePlacementCandidatesInput
}

function makeLegalCandidateCase(
  category: string,
  fields: Parameters<typeof legalCandidateInput>[0],
  algorithm: NfpConstructionAlgorithm,
  pruningMode: NfpCandidatePruningMode
): void {
  const key = legalPlacementCandidateMemoKey(legalCandidateInput(fields), algorithm, pruningMode)
  const domain = fields.candidateDomain ?? 'sheet'
  legalCandidateMemoCases.push({
    category,
    sheet:
      domain === 'sheetless-nfp' || fields.sheet === undefined
        ? null
        : { width: f64Bits(fields.sheet.width), height: f64Bits(fields.sheet.height) },
    placed: fields.placed.map((placed) => ({
      points: encodePoints(placed.points),
      translateX: f64Bits(placed.translateX),
      translateY: f64Bits(placed.translateY)
    })),
    movingPolygon: encodePoints(fields.movingPoints),
    movingBounds: encodeBounds(fields.movingBounds),
    settings: encodeSettings(fields.settings),
    algorithm,
    pruningMode,
    candidateDomain: domain,
    key
  })
}

{
  const square = [point(0, 0), point(2, 0), point(2, 2), point(0, 2)]
  const triangle = [point(0, 0), point(1, 0), point(0.5, 1)]
  const bounds = { minX: 0, minY: 0, maxX: 2, maxY: 2 }
  const geometrySettings = settings(0.05, 0.05, 'clipper2-ts', '2.0.1-18')

  const domains: ReadonlyArray<'sheet' | 'contact-only' | 'sheetless-nfp'> = [
    'sheet',
    'contact-only',
    'sheetless-nfp'
  ]
  const pruningModes: ReadonlyArray<NfpCandidatePruningMode> = ['indexed', 'reference']

  for (const domain of domains) {
    for (const algorithm of NFP_CONSTRUCTION_ALGORITHMS) {
      for (const pruningMode of pruningModes) {
        makeLegalCandidateCase(
          `domain=${domain}:algorithm=${algorithm}:pruning=${pruningMode}`,
          {
            candidateDomain: domain,
            sheet: { width: 20, height: 15 },
            placed: [{ points: square, translateX: 0, translateY: 0 }],
            movingPoints: triangle,
            movingBounds: bounds,
            settings: geometrySettings
          },
          algorithm,
          pruningMode
        )
      }
    }
  }

  // candidateDomain omitted entirely -- must default to `sheet` for the
  // final key component while still consulting `input.sheet`.
  makeLegalCandidateCase(
    'domain-omitted',
    {
      sheet: { width: 20, height: 15 },
      placed: [],
      movingPoints: triangle,
      movingBounds: bounds,
      settings: geometrySettings
    },
    DEFAULT_NFP_CONSTRUCTION_ALGORITHM,
    'indexed'
  )

  // Sheet label is present on the input but must NOT reach the key (the
  // sheet-label omission oddity, nfp-ifp.md §15 item 5). The label itself is
  // deliberately not recorded/encodable in this case's vector shape at all
  // (see `EncodedPlacedPiece`'s sibling `sheet` field, which carries only
  // width/height) -- there being nowhere to put it is the assertion.
  makeLegalCandidateCase(
    'sheet-label-present-but-omitted',
    {
      candidateDomain: 'sheet',
      sheet: { width: 20, height: 15 },
      placed: [],
      movingPoints: triangle,
      movingBounds: bounds,
      settings: geometrySettings
    },
    DEFAULT_NFP_CONSTRUCTION_ALGORITHM,
    'indexed'
  )

  // Placed-piece ordering: two different orderings of the same two pieces
  // must produce two different keys (order-sensitive by design).
  const pieceA: PlacedPieceInput = { points: square, translateX: 5, translateY: 0 }
  const pieceB: PlacedPieceInput = { points: triangle, translateX: 0, translateY: 0 }
  makeLegalCandidateCase(
    'placed-order:a-then-b',
    {
      candidateDomain: 'sheetless-nfp',
      placed: [pieceA, pieceB],
      movingPoints: triangle,
      movingBounds: bounds,
      settings: geometrySettings
    },
    DEFAULT_NFP_CONSTRUCTION_ALGORITHM,
    'indexed'
  )
  makeLegalCandidateCase(
    'placed-order:b-then-a',
    {
      candidateDomain: 'sheetless-nfp',
      placed: [pieceB, pieceA],
      movingPoints: triangle,
      movingBounds: bounds,
      settings: geometrySettings
    },
    DEFAULT_NFP_CONSTRUCTION_ALGORITHM,
    'indexed'
  )

  // Zero, one, and several placed pieces.
  for (let count = 0; count <= 4; count += 1) {
    const placed: PlacedPieceInput[] = []
    for (let index = 0; index < count; index += 1) {
      placed.push({ points: square, translateX: index * 3, translateY: -index })
    }
    makeLegalCandidateCase(
      `placed-count:${count}`,
      {
        candidateDomain: 'sheetless-nfp',
        placed,
        movingPoints: triangle,
        movingBounds: bounds,
        settings: geometrySettings
      },
      DEFAULT_NFP_CONSTRUCTION_ALGORITHM,
      'indexed'
    )
  }

  // Negative-zero translations and moving bounds.
  makeLegalCandidateCase(
    'negative-zero-translation-and-bounds',
    {
      candidateDomain: 'sheetless-nfp',
      placed: [{ points: square, translateX: -0, translateY: -0 }],
      movingPoints: triangle,
      movingBounds: { minX: -0, minY: -0, maxX: 2, maxY: 2 },
      settings: geometrySettings
    },
    DEFAULT_NFP_CONSTRUCTION_ALGORITHM,
    'indexed'
  )

  // Real fixture-piece rings as placed/moving geometry.
  for (let index = 0; index < 61; index += 1) {
    makeLegalCandidateCase(
      `fixture-piece:${index}`,
      {
        candidateDomain: 'sheet',
        sheet: { width: 2000, height: 2700 },
        placed: [{ points: fixtureRing(index), translateX: index, translateY: index * 2 }],
        movingPoints: fixtureRing((index + 1) % 61),
        movingBounds: bounds,
        settings: geometrySettings
      },
      DEFAULT_NFP_CONSTRUCTION_ALGORITHM,
      'indexed'
    )
  }

  // Settings variations.
  const settingsVariants: ReadonlyArray<[string, InternalGeometrySettings]> = [
    ['negative-zero-margin', settings(0.1, -0, 'backend', 'v1')],
    ['special-strings', settings(0.5, 0.75, 'backend "id" \\ x', 'v-é-1')]
  ]
  for (const [label, variantSettings] of settingsVariants) {
    makeLegalCandidateCase(
      `settings:${label}`,
      {
        candidateDomain: 'sheetless-nfp',
        placed: [],
        movingPoints: triangle,
        movingBounds: bounds,
        settings: variantSettings
      },
      DEFAULT_NFP_CONSTRUCTION_ALGORITHM,
      'indexed'
    )
  }
}

// ---------------------------------------------------------------------------
// Section E: `GeometryCacheStore` behavior scenarios (real
// `makeGeometryCacheStore`), recording the exact hit/miss/stale sequence.
// Values are plain JSON-serializable data (numbers/strings/small objects) so
// the Rust replay can store them as `serde_json::Value` and compare by
// structural equality against the recorded `getResult.value`.
// ---------------------------------------------------------------------------
type StoreOp =
  | { readonly op: 'get'; readonly key: GeometryCacheKey }
  | { readonly op: 'set'; readonly key: GeometryCacheKey; readonly value: unknown }
  | { readonly op: 'remove'; readonly key: GeometryCacheKey }
  | { readonly op: 'clear' }

interface StoreOpResult {
  readonly op: string
  readonly key: EncodedGeometryCacheKey | null
  readonly value?: unknown
  readonly getResult?: { readonly present: boolean; readonly value: unknown }
}

interface StoreScenarioCase {
  readonly category: string
  readonly results: ReadonlyArray<StoreOpResult>
}

const storeScenarioCases: StoreScenarioCase[] = []

function runStoreScenario(category: string, ops: ReadonlyArray<StoreOp>): void {
  const store = makeGeometryCacheStore()
  const results: StoreOpResult[] = []
  for (const step of ops) {
    switch (step.op) {
      case 'get': {
        const value = store.get(step.key)
        results.push({
          op: 'get',
          key: encodeKey(step.key),
          getResult: { present: value !== undefined, value: value ?? null }
        })
        break
      }
      case 'set': {
        store.set(step.key, step.value)
        results.push({ op: 'set', key: encodeKey(step.key), value: step.value })
        break
      }
      case 'remove': {
        store.remove(step.key)
        results.push({ op: 'remove', key: encodeKey(step.key) })
        break
      }
      case 'clear': {
        store.clear()
        results.push({ op: 'clear', key: null })
        break
      }
    }
  }
  storeScenarioCases.push({ category, results })
}

{
  const keyA: GeometryCacheKey = { namespace: 'transform-collision-v1', parts: ['a', 'b'] }
  const keyB: GeometryCacheKey = { namespace: 'sheet-ifp-v1', parts: ['x'] }
  const keyC: GeometryCacheKey = {
    namespace: 'pairwise-nfp-relative-v3',
    parts: ['same', 'namespace', 'different', 'parts']
  }
  const keyCVariant: GeometryCacheKey = {
    namespace: 'pairwise-nfp-relative-v3',
    parts: ['same', 'namespace', 'different', 'parts-2']
  }

  runStoreScenario('get-on-empty-store-is-a-miss', [{ op: 'get', key: keyA }])

  runStoreScenario('set-then-get-hits', [
    { op: 'set', key: keyA, value: { field: 42 } },
    { op: 'get', key: keyA }
  ])

  runStoreScenario('set-overwrite-then-get-returns-latest', [
    { op: 'set', key: keyA, value: { field: 1 } },
    { op: 'set', key: keyA, value: { field: 2 } },
    { op: 'get', key: keyA }
  ])

  runStoreScenario('remove-then-get-is-a-miss', [
    { op: 'set', key: keyA, value: { field: 42 } },
    { op: 'remove', key: keyA },
    { op: 'get', key: keyA }
  ])

  runStoreScenario('remove-on-empty-store-is-a-no-op', [
    { op: 'remove', key: keyA },
    { op: 'get', key: keyA }
  ])

  runStoreScenario('clear-empties-every-namespace', [
    { op: 'set', key: keyA, value: 1 },
    { op: 'set', key: keyB, value: 2 },
    { op: 'clear' },
    { op: 'get', key: keyA },
    { op: 'get', key: keyB }
  ])

  runStoreScenario('distinct-keys-same-namespace-do-not-collide', [
    { op: 'set', key: keyC, value: 'c-value' },
    { op: 'get', key: keyCVariant },
    { op: 'get', key: keyC }
  ])

  runStoreScenario('distinct-namespaces-do-not-collide', [
    { op: 'set', key: keyA, value: 'a-value' },
    { op: 'get', key: keyB },
    { op: 'get', key: keyA }
  ])

  // Simulated stale-eviction sequence: a value is published, then a
  // "revalidation" step (external to the store, per every namespace's exact
  // access sequence in the design doc) decides the cached value no longer
  // matches its input and evicts before recomputing.
  runStoreScenario('stale-detection-then-remove-then-recompute-and-set', [
    { op: 'set', key: keyA, value: { generation: 1 } },
    { op: 'get', key: keyA },
    { op: 'remove', key: keyA },
    { op: 'get', key: keyA },
    { op: 'set', key: keyA, value: { generation: 2 } },
    { op: 'get', key: keyA }
  ])

  // A long chain of alternating operations across several keys, exercising
  // hit/miss/stale/store telemetry over a realistic access pattern.
  const chainOps: StoreOp[] = []
  for (let round = 0; round < 5; round += 1) {
    chainOps.push({ op: 'get', key: keyA })
    chainOps.push({ op: 'set', key: keyA, value: { round } })
    chainOps.push({ op: 'get', key: keyA })
    chainOps.push({ op: 'get', key: keyB })
    if (round % 2 === 0) {
      chainOps.push({ op: 'remove', key: keyB })
    } else {
      chainOps.push({ op: 'set', key: keyB, value: { round } })
    }
  }
  runStoreScenario('long-alternating-chain', chainOps)
}

// ---------------------------------------------------------------------------
// Assemble + write output.
// ---------------------------------------------------------------------------
const totalCaseCount =
  pairwiseNfpCases.length +
  transformCollisionCases.length +
  ifpCases.length +
  legalCandidateMemoCases.length +
  storeScenarioCases.length

if (totalCaseCount < 400) {
  throw new Error(`Expected at least 400 total cache-key vectors, generated only ${totalCaseCount}.`)
}

mkdirSync(VECTORS_DIR, { recursive: true })

const commit = generatingCommit()

const output = {
  generatedByScript: 'scripts/rust-parity/dump-cache-keys.ts',
  generatingCommit: commit,
  sourceModules: [
    'src/workers/irregular/core/nfpCacheKey.ts',
    'src/workers/irregular/core/geometryCacheIdentity.ts',
    'src/workers/irregular/geometryCacheKeys.ts',
    'src/workers/irregular/core/geometryCacheStore.ts',
    'src/workers/irregular/geometryCacheStoreLive.ts'
  ],
  description:
    'makePairwiseNfpCacheKey, makeTransformCollisionGeometryCacheKey, makeInnerFitBoundsCacheKey, ' +
    'legalPlacementCandidateMemoKey, and the real makeGeometryCacheStore evaluated over a broad ' +
    'input matrix: piece ids/labels/backend strings with quotes, backslashes, control characters, ' +
    'and non-ASCII text; transforms with negative-zero/rotation-360/negative indices; sheets with ' +
    'and without labels; every NfpConstructionAlgorithm/NfpCandidatePruningMode/candidate-domain ' +
    'variant (including the real "contact-only" domain); real mixed61 fixture-piece rings; and ' +
    'GeometryCacheStore hit/miss/overwrite/remove/clear scenarios. Every case records both the raw ' +
    'input (f64 fields as big-endian IEEE-754 bit-pattern hex strings) and the resulting key/store ' +
    'outcome, so the Rust test replays the identical input through its own port rather than a ' +
    'pre-rendered string.',
  totalCaseCount,
  pairwiseNfp: {
    namespace: NFP_GEOMETRY_CACHE_NAMESPACE,
    caseCount: pairwiseNfpCases.length,
    cases: pairwiseNfpCases
  },
  transformCollision: {
    namespace: TRANSFORM_GEOMETRY_CACHE_NAMESPACE,
    caseCount: transformCollisionCases.length,
    cases: transformCollisionCases
  },
  ifp: {
    namespace: IFP_GEOMETRY_CACHE_NAMESPACE,
    caseCount: ifpCases.length,
    cases: ifpCases
  },
  legalCandidateMemo: {
    namespace: LEGAL_CANDIDATE_MEMO_NAMESPACE,
    caseCount: legalCandidateMemoCases.length,
    cases: legalCandidateMemoCases
  },
  storeScenarios: {
    caseCount: storeScenarioCases.length,
    cases: storeScenarioCases
  }
}

writeFileSync(join(VECTORS_DIR, 'cache-keys.json'), JSON.stringify(output, null, 2) + '\n')

console.log(
  `Wrote ${totalCaseCount} cache-key vectors ` +
    `(pairwiseNfp=${pairwiseNfpCases.length}, transformCollision=${transformCollisionCases.length}, ` +
    `ifp=${ifpCases.length}, legalCandidateMemo=${legalCandidateMemoCases.length}, ` +
    `storeScenarios=${storeScenarioCases.length}; commit ${commit}) to ${VECTORS_DIR}`
)
