/**
 * Differential-vector generator for `crates/irregular-nesting-native/src/transforms/`
 * (`generator.rs`, `rotate.rs`, `boundary_check.rs`).
 *
 * Per docs/planning/rust-irregular-backend/stage0-rulings.md R14: this script
 * imports the REAL production TS entry points --
 *   - `TransformGenerator.generateTransforms` (`TransformGeneratorLive`,
 *     `src/workers/irregular/transformGenerator.ts`) for candidate
 *     enumeration/ordering/dedup/the adaptive Compact policy, and
 *   - `computeTransformedCollisionGeometry`
 *     (`src/workers/irregular/core/transformCollisionGeometryCore.ts`) for
 *     rotation/mirror point-application, applied to real
 *     `tests/fixtures/irregularSheetInvariance/mixed61-request.json` piece
 *     dimensions --
 * evaluates them over a deliberate settings/geometry matrix, and writes
 * byte-exact JSON vectors for the Rust ports
 * (`transforms::generator::generate_transforms`,
 * `transforms::rotate::transform_and_snap_point`) to replay exactly.
 *
 * Run with:
 *   pnpm exec tsx --tsconfig tsconfig.node.json scripts/rust-parity/dump-transforms.ts
 *
 * Outputs (additive; never edits existing fixtures/tests):
 *   - crates/irregular-nesting-native/tests/vectors/transforms.json
 */
import { Effect, Exit } from 'effect'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  CollisionGeometry,
  IrregularBounds,
  IrregularGeometrySettings,
  IrregularOptimizerSettings,
  IrregularPoint,
  IrregularPolygon
} from '../../src/shared/irregular/domain.js'
import {
  makeCompactQualityIrregularOptimizerSettings,
  makeCompactShortSideIrregularOptimizerSettings,
  makeDerivedOrientationIrregularOptimizerSettings,
  makeFastIdentityIrregularOptimizerSettings,
  makeOrthogonalIrregularOptimizerSettings
} from '../../src/shared/irregular/defaults.js'
import { PieceId } from '../../src/shared/domain/ids.js'
import { TransformGenerator, type GenerateTransformsInput } from '../../src/workers/irregular/services.js'
import { TransformGeneratorLive } from '../../src/workers/irregular/transformGenerator.js'
import { computeTransformedCollisionGeometry } from '../../src/workers/irregular/core/transformCollisionGeometryCore.js'

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
// independent per-script per that script's own precedent, no shared TS
// utility exists for this yet).
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
// Deterministic PRNG (mulberry32), matching dump-canonical-grid.ts's
// precedent -- no Math.random anywhere, so the vector file is stable.
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

// ---------------------------------------------------------------------------
// Polygon builders. All must be strictly convex, simple rings (the same
// invariant `ConvexPolygonValidation.validateStrictBoundary` enforces) --
// `generateTransforms` rejects anything else.
// ---------------------------------------------------------------------------
function point(x: number, y: number): IrregularPoint {
  return new IrregularPoint({ x, y })
}

function rectangle(widthMm: number, heightMm: number): ReadonlyArray<IrregularPoint> {
  return [point(0, 0), point(widthMm, 0), point(widthMm, heightMm), point(0, heightMm)]
}

function regularPolygon(
  sides: number,
  radiusMm: number,
  rotationOffsetDeg: number,
  centerX: number,
  centerY: number
): ReadonlyArray<IrregularPoint> {
  const points: IrregularPoint[] = []
  for (let i = 0; i < sides; i++) {
    const angleDeg = rotationOffsetDeg + (360 * i) / sides
    const angleRad = (angleDeg * Math.PI) / 180
    points.push(
      point(centerX + radiusMm * Math.cos(angleRad), centerY + radiusMm * Math.sin(angleRad))
    )
  }
  return points
}

/** A scalene triangle with edges at deliberately non-orthogonal angles. */
function scaleneTriangle(scale: number): ReadonlyArray<IrregularPoint> {
  return [point(0, 0), point(4 * scale, 0.6 * scale), point(1.2 * scale, 3.7 * scale)]
}

/**
 * A pentagon with two edges perturbed to sit within the adaptive angle
 * tolerance of one another, exercising the "longer usable edge wins" dedup
 * tie-break rule.
 */
function nearDuplicateEdgePentagon(scale: number): ReadonlyArray<IrregularPoint> {
  const base = regularPolygon(5, 10 * scale, 7, 0, 0) as IrregularPoint[]
  // Nudge one vertex a tiny amount so two adjacent edges' directions land
  // within a small angular distance of each other but keep different
  // lengths, without breaking convexity for a small enough nudge.
  const nudged = [...base]
  const target = nudged[2]
  if (target === undefined) throw new Error('nudged base ring must have at least 3 points')
  nudged[2] = point(target.x + 0.02 * scale, target.y - 0.01 * scale)
  return nudged
}

/** A thin sliver rectangle, to exercise the minimum-edge-length filter. */
function sliver(longSideMm: number, shortSideMm: number): ReadonlyArray<IrregularPoint> {
  return rectangle(longSideMm, shortSideMm)
}

function scalePoints(points: ReadonlyArray<IrregularPoint>, factor: number): ReadonlyArray<IrregularPoint> {
  return points.map(({ x, y }) => point(x * factor, y * factor))
}

// ---------------------------------------------------------------------------
// Load real fixture piece dimensions (mixed61-request.json) as rectangle
// collision polygons -- "real fixture data where available" per the task.
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

// ---------------------------------------------------------------------------
// generateTransforms harness.
// ---------------------------------------------------------------------------
function collisionGeometry(points: ReadonlyArray<IrregularPoint>): CollisionGeometry {
  return new CollisionGeometry({
    sourcePieceId: PieceId.make('dump-transforms-piece'),
    sourceBounds: new IrregularBounds({ minX: 0, minY: 0, maxX: 10, maxY: 10 }),
    sampledPoints: points,
    convexHull: new IrregularPolygon({ points }),
    collisionPolygon: new IrregularPolygon({ points }),
    placementReference: point(0, 0),
    diagnostics: []
  })
}

interface GenerateCase {
  readonly label: string
  readonly points: ReadonlyArray<IrregularPoint>
  readonly allowRotation: boolean
  readonly allowMirror: boolean
  readonly geometrySettings: IrregularGeometrySettings
  readonly settings: IrregularOptimizerSettings
}

/**
 * The exact `IrregularOptimizerSettings`/`IrregularGeometrySettings` fields
 * `generateTransforms`'s algorithm actually reads (per
 * `transformGenerator.ts`'s full read, cross-checked against
 * `deriveEffectiveTransformPolicy`/`intrinsicSharedArchiveEligibility`).
 * Recorded per-case so the Rust differential test can reconstruct
 * `GenerateTransformsInput` from the vector file alone, with no parallel
 * Rust re-implementation of this script's own shape/settings builders.
 */
interface RecordedSettings {
  readonly transformCap: number
  readonly transformMinimumEdgeLengthMm: string
  readonly transformAngleDeduplicationToleranceDeg: string
  // The optional-typed fields mirror IrregularOptimizerSettings' schema type;
  // at runtime every recorded instance is a decoded settings object whose
  // defaults are applied, so none of these are ever undefined in the vectors.
  readonly configuredRotationEnabled: boolean | undefined
  readonly edgeAlignmentEnabled: boolean | undefined
  readonly configuredRotationDeg: ReadonlyArray<string>
  readonly intrinsicSharedArchiveEnabled: boolean | undefined
  readonly placementPolicyId: string | undefined
  readonly gaEnabled: boolean | undefined
  readonly baselineOnly: boolean | undefined
  readonly gaTimeBudgetMs: number | undefined
  readonly gaGenerationBudget: number | undefined
  readonly gaEvaluationBudget: number | undefined
}

function recordSettings(settings: IrregularOptimizerSettings): RecordedSettings {
  return {
    transformCap: settings.transformCap,
    transformMinimumEdgeLengthMm: f64Bits(settings.transformMinimumEdgeLengthMm),
    transformAngleDeduplicationToleranceDeg: f64Bits(settings.transformAngleDeduplicationToleranceDeg),
    configuredRotationEnabled: settings.configuredRotationEnabled,
    edgeAlignmentEnabled: settings.edgeAlignmentEnabled,
    configuredRotationDeg: settings.configuredRotationDeg.map((deg) => f64Bits(deg)),
    intrinsicSharedArchiveEnabled: settings.intrinsicSharedArchiveEnabled,
    placementPolicyId: settings.placementPolicyId,
    gaEnabled: settings.gaEnabled,
    baselineOnly: settings.baselineOnly,
    gaTimeBudgetMs: settings.gaTimeBudgetMs,
    gaGenerationBudget: settings.gaGenerationBudget,
    gaEvaluationBudget: settings.gaEvaluationBudget
  }
}

function runGenerateTransforms(
  testCase: GenerateCase
): { readonly ok: true; readonly candidates: ReadonlyArray<Record<string, unknown>> } | { readonly ok: false; readonly message: string } {
  const input: GenerateTransformsInput = {
    geometry: collisionGeometry(testCase.points),
    allowRotation: testCase.allowRotation,
    allowMirror: testCase.allowMirror,
    geometrySettings: testCase.geometrySettings,
    settings: testCase.settings
  }
  const exit = Effect.runSyncExit(
    TransformGenerator.use((service) => service.generateTransforms(input)).pipe(
      Effect.provide(TransformGeneratorLive)
    )
  )
  if (Exit.isFailure(exit)) {
    const failure = exit.cause
    return { ok: false, message: JSON.stringify(failure) }
  }
  const candidates = exit.value.map((candidate) => ({
    index: candidate.index,
    rotationDeg: f64Bits(candidate.rotationDeg),
    rotationDegDecimal: candidate.rotationDeg,
    mirrored: candidate.mirrored,
    reason: candidate.reason
  }))
  return { ok: true, candidates }
}

function geometrySettings(sagMm: number): IrregularGeometrySettings {
  return new IrregularGeometrySettings({
    flatteningSagToleranceMm: sagMm,
    clearanceSafetyMarginMm: sagMm,
    geometryBackendId: 'dump-transforms',
    geometryBackendVersion: '0'
  })
}

function ordinarySettings(overrides: Partial<IrregularOptimizerSettings> = {}): IrregularOptimizerSettings {
  return new IrregularOptimizerSettings({
    orderWindow: 2,
    beamWidth: 8,
    intrinsicSharedArchiveEnabled: false,
    transformCap: 16,
    transformMinimumEdgeLengthMm: 1,
    transformAngleDeduplicationToleranceDeg: 0.01,
    configuredRotationEnabled: true,
    edgeAlignmentEnabled: true,
    configuredRotationDeg: [],
    gaPopulation: 8,
    gaTimeBudgetMs: 1000,
    gaSeed: 'dump-transforms',
    ...overrides
  })
}

function ineligibleGaActiveSettings(): IrregularOptimizerSettings {
  return new IrregularOptimizerSettings({
    orderWindow: 2,
    beamWidth: 8,
    intrinsicSharedArchiveEnabled: true,
    placementPolicyId: 'edge-contact-then-balanced-compactness',
    transformCap: 16,
    transformMinimumEdgeLengthMm: 1,
    transformAngleDeduplicationToleranceDeg: 0.01,
    configuredRotationEnabled: true,
    edgeAlignmentEnabled: true,
    configuredRotationDeg: [],
    gaEnabled: true,
    baselineOnly: false,
    gaPopulation: 8,
    gaGenerationBudget: 3,
    gaEvaluationBudget: 30,
    gaTimeBudgetMs: 5000,
    gaSeed: 'dump-transforms-ga-active'
  })
}

function ineligibleShortSideFillSettings(): IrregularOptimizerSettings {
  return new IrregularOptimizerSettings({
    orderWindow: 2,
    beamWidth: 8,
    intrinsicSharedArchiveEnabled: true,
    placementPolicyId: 'short-side-fill',
    transformCap: 16,
    transformMinimumEdgeLengthMm: 1,
    transformAngleDeduplicationToleranceDeg: 0.01,
    configuredRotationEnabled: true,
    edgeAlignmentEnabled: true,
    configuredRotationDeg: [],
    gaPopulation: 8,
    gaTimeBudgetMs: 1000,
    gaSeed: 'dump-transforms-short-side-fill'
  })
}

// ---------------------------------------------------------------------------
// Build the generateTransforms case matrix: shapes x settings variants.
// ---------------------------------------------------------------------------
const shapes: Array<{ readonly label: string; readonly points: ReadonlyArray<IrregularPoint> }> = [
  { label: 'square-4x4', points: rectangle(4, 4) },
  { label: 'rectangle-10x3', points: rectangle(10, 3) },
  { label: 'scalene-triangle-1x', points: scaleneTriangle(1) },
  { label: 'scalene-triangle-0.1x', points: scalePoints(scaleneTriangle(1), 0.1) },
  { label: 'scalene-triangle-10x', points: scalePoints(scaleneTriangle(1), 10) },
  { label: 'regular-pentagon-r10', points: regularPolygon(5, 10, 0, 0, 0) },
  { label: 'regular-hexagon-r15-rot12', points: regularPolygon(6, 15, 12, 0, 0) },
  { label: 'near-duplicate-edge-pentagon-1x', points: nearDuplicateEdgePentagon(1) },
  { label: 'near-duplicate-edge-pentagon-10x', points: nearDuplicateEdgePentagon(10) },
  { label: 'sliver-100x0.5', points: sliver(100, 0.5) },
  { label: 'octagon-r20-rot3.5', points: regularPolygon(8, 20, 3.5, 0, 0) }
]

for (const dims of loadMixed61Dimensions()) {
  shapes.push({
    label: `mixed61-rect-${dims.width}x${dims.height}`,
    points: rectangle(dims.width, dims.height)
  })
}

interface SettingsVariant {
  readonly label: string
  readonly allowRotation: boolean
  readonly allowMirror: boolean
  readonly sagMm: number
  readonly settings: IrregularOptimizerSettings
}

const settingsVariants: SettingsVariant[] = [
  {
    label: 'ordinary-default',
    allowRotation: true,
    allowMirror: false,
    sagMm: 0.25,
    settings: ordinarySettings()
  },
  {
    label: 'ordinary-mirror',
    allowRotation: true,
    allowMirror: true,
    sagMm: 0.25,
    settings: ordinarySettings()
  },
  {
    label: 'ordinary-no-rotation',
    allowRotation: false,
    allowMirror: false,
    sagMm: 0.25,
    settings: ordinarySettings()
  },
  {
    label: 'ordinary-cap-1',
    allowRotation: true,
    allowMirror: true,
    sagMm: 0.25,
    settings: ordinarySettings({ transformCap: 1 })
  },
  {
    label: 'ordinary-cap-2',
    allowRotation: true,
    allowMirror: true,
    sagMm: 0.25,
    settings: ordinarySettings({ transformCap: 2 })
  },
  {
    label: 'ordinary-cap-3',
    allowRotation: true,
    allowMirror: true,
    sagMm: 0.25,
    settings: ordinarySettings({ transformCap: 3 })
  },
  {
    label: 'ordinary-cap-6',
    allowRotation: true,
    allowMirror: true,
    sagMm: 0.25,
    settings: ordinarySettings({ transformCap: 6 })
  },
  {
    label: 'ordinary-cap-40',
    allowRotation: true,
    allowMirror: true,
    sagMm: 0.25,
    settings: ordinarySettings({ transformCap: 40 })
  },
  {
    label: 'ordinary-configured-angles',
    allowRotation: true,
    allowMirror: true,
    sagMm: 0.25,
    settings: ordinarySettings({ configuredRotationDeg: [12.5, 47.25, 200.125] })
  },
  {
    label: 'ordinary-configured-disabled',
    allowRotation: true,
    allowMirror: false,
    sagMm: 0.25,
    settings: ordinarySettings({ configuredRotationEnabled: false, configuredRotationDeg: [12.5] })
  },
  {
    label: 'ordinary-edge-alignment-disabled',
    allowRotation: true,
    allowMirror: false,
    sagMm: 0.25,
    settings: ordinarySettings({ edgeAlignmentEnabled: false, configuredRotationDeg: [12.5] })
  },
  {
    label: 'ordinary-large-min-edge',
    allowRotation: true,
    allowMirror: false,
    sagMm: 0.25,
    settings: ordinarySettings({ transformMinimumEdgeLengthMm: 5 })
  },
  {
    label: 'ordinary-large-angle-tolerance',
    allowRotation: true,
    allowMirror: true,
    sagMm: 0.25,
    settings: ordinarySettings({ transformAngleDeduplicationToleranceDeg: 5 })
  },
  {
    label: 'fast-identity',
    allowRotation: true,
    allowMirror: true,
    sagMm: 0.25,
    settings: makeFastIdentityIrregularOptimizerSettings({ configuredRotationDeg: [12.5] })
  },
  {
    label: 'orthogonal-profile',
    allowRotation: true,
    allowMirror: true,
    sagMm: 0.25,
    settings: makeOrthogonalIrregularOptimizerSettings({ configuredRotationDeg: [12.5] })
  },
  {
    label: 'derived-orientation-profile',
    allowRotation: true,
    allowMirror: false,
    sagMm: 0.25,
    settings: makeDerivedOrientationIrregularOptimizerSettings({ configuredRotationDeg: [12.5] })
  },
  {
    label: 'compact-quality-sag-0.1',
    allowRotation: true,
    allowMirror: true,
    sagMm: 0.1,
    settings: makeCompactQualityIrregularOptimizerSettings()
  },
  {
    label: 'compact-quality-sag-0.25',
    allowRotation: true,
    allowMirror: true,
    sagMm: 0.25,
    settings: makeCompactQualityIrregularOptimizerSettings()
  },
  {
    label: 'compact-quality-sag-1.0',
    allowRotation: true,
    allowMirror: true,
    sagMm: 1.0,
    settings: makeCompactQualityIrregularOptimizerSettings()
  },
  {
    label: 'compact-quality-sag-5.0',
    allowRotation: true,
    allowMirror: false,
    sagMm: 5.0,
    settings: makeCompactQualityIrregularOptimizerSettings()
  },
  {
    label: 'compact-short-side-sag-0.25',
    allowRotation: true,
    allowMirror: true,
    sagMm: 0.25,
    settings: makeCompactShortSideIrregularOptimizerSettings()
  },
  {
    label: 'compact-ineligible-ga-active',
    allowRotation: true,
    allowMirror: true,
    sagMm: 0.25,
    settings: ineligibleGaActiveSettings()
  },
  {
    label: 'compact-ineligible-short-side-fill',
    allowRotation: true,
    allowMirror: true,
    sagMm: 0.25,
    settings: ineligibleShortSideFillSettings()
  }
]

// ---------------------------------------------------------------------------
// Run the full shapes x settings matrix.
// ---------------------------------------------------------------------------
interface GenerateVectorCase {
  readonly caseLabel: string
  readonly shapeLabel: string
  readonly settingsLabel: string
  readonly points: ReadonlyArray<{ readonly x: string; readonly y: string }>
  readonly allowRotation: boolean
  readonly allowMirror: boolean
  readonly sagMm: string
  readonly settings: RecordedSettings
  readonly ok: boolean
  readonly message?: string
  readonly candidates?: ReadonlyArray<Record<string, unknown>>
}

const generateCases: GenerateVectorCase[] = []

for (const shape of shapes) {
  for (const variant of settingsVariants) {
    const result = runGenerateTransforms({
      label: `${shape.label}__${variant.label}`,
      points: shape.points,
      allowRotation: variant.allowRotation,
      allowMirror: variant.allowMirror,
      geometrySettings: geometrySettings(variant.sagMm),
      settings: variant.settings
    })
    generateCases.push({
      caseLabel: `${shape.label}__${variant.label}`,
      shapeLabel: shape.label,
      settingsLabel: variant.label,
      points: shape.points.map(({ x, y }) => ({ x: f64Bits(x), y: f64Bits(y) })),
      allowRotation: variant.allowRotation,
      allowMirror: variant.allowMirror,
      sagMm: f64Bits(variant.sagMm),
      settings: recordSettings(variant.settings),
      ok: result.ok,
      ...(result.ok ? { candidates: result.candidates } : { message: result.message })
    })
  }
}

if (generateCases.length < 300) {
  throw new Error(`Expected >= 300 generateTransforms cases, got ${generateCases.length}.`)
}
if (generateCases.some((c) => !c.ok)) {
  throw new Error('Every deliberately-constructed generateTransforms case must succeed (all inputs are valid convex boundaries).')
}

// ---------------------------------------------------------------------------
// Rotation-application vectors: real fixture-derived rectangles plus a
// couple of non-rectangular convex shapes, rotated/mirrored through
// `computeTransformedCollisionGeometry` (the real production entry point
// that composes `transformPoint` + `snapPointToCollisionGrid`), with
// bit-exact output coordinates.
// ---------------------------------------------------------------------------
interface RotationCase {
  readonly caseLabel: string
  readonly shapeLabel: string
  readonly rotationDeg: number
  readonly mirrored: boolean
  readonly ok: boolean
  readonly message?: string
  readonly inputPoints?: ReadonlyArray<{ readonly x: string; readonly y: string }>
  readonly outputPoints?: ReadonlyArray<{ readonly x: string; readonly y: string }>
}

const rotationShapes: ReadonlyArray<{ readonly label: string; readonly points: ReadonlyArray<IrregularPoint> }> = [
  ...loadMixed61Dimensions().map((dims) => ({
    label: `mixed61-rect-${dims.width}x${dims.height}`,
    points: rectangle(dims.width, dims.height)
  })),
  { label: 'scalene-triangle-1x', points: scaleneTriangle(1) },
  { label: 'regular-hexagon-r15-rot12', points: regularPolygon(6, 15, 12, 0, 0) },
  { label: 'octagon-r20-rot3.5', points: regularPolygon(8, 20, 3.5, 0, 0) }
]

const random = mulberry32(0x7a4e1c02)
const rotationAngles: number[] = [
  0,
  90,
  180,
  270,
  -90,
  -360,
  360,
  33.7,
  47.25,
  12.5,
  200.125,
  359.999,
  0.001,
  135.0,
  225.0
]
for (let i = 0; i < 10; i++) {
  rotationAngles.push(randomInRange(random, -720, 720))
}

const rotationCases: RotationCase[] = []
for (const shape of rotationShapes) {
  for (const rotationDeg of rotationAngles) {
    for (const mirrored of [false, true]) {
      const inputGeometry = {
        sourcePieceId: 'dump-transforms-rotation-piece',
        sourceBounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
        sampledPoints: shape.points,
        convexHull: { points: shape.points },
        collisionPolygon: { points: shape.points },
        placementReference: { x: 0, y: 0 }
      }
      const transform = { index: 0, rotationDeg, mirrored, reason: 'configured' as const }
      const result = computeTransformedCollisionGeometry({ geometry: inputGeometry, transform })
      const caseLabel = `${shape.label}__rot${rotationDeg}__mirror${mirrored}`
      if (!result.ok) {
        rotationCases.push({
          caseLabel,
          shapeLabel: shape.label,
          rotationDeg,
          mirrored,
          ok: false,
          message: result.message
        })
        continue
      }
      rotationCases.push({
        caseLabel,
        shapeLabel: shape.label,
        rotationDeg,
        mirrored,
        ok: true,
        inputPoints: shape.points.map(({ x, y }) => ({ x: f64Bits(x), y: f64Bits(y) })),
        outputPoints: result.value.polygon.points.map(({ x, y }) => ({ x: f64Bits(x), y: f64Bits(y) }))
      })
    }
  }
}

const rotationVectorCount = rotationCases.reduce(
  (total, c) => total + (c.ok ? (c.outputPoints?.length ?? 0) : 0),
  0
)
if (rotationVectorCount < 300) {
  throw new Error(`Expected >= 300 rotated-point vectors, got ${rotationVectorCount}.`)
}

// ---------------------------------------------------------------------------
// Write output.
// ---------------------------------------------------------------------------
mkdirSync(VECTORS_DIR, { recursive: true })
const commit = generatingCommit()

const output = {
  generatedByScript: 'scripts/rust-parity/dump-transforms.ts',
  generatingCommit: commit,
  description:
    'generateTransforms (TransformGeneratorLive, transformGenerator.ts) full ordered candidate ' +
    'lists over a shapes x settings matrix (rotation/mirror enablement, transform caps, the ' +
    'adaptive Compact policy on both eligible/ineligible branches, configured/edge-alignment ' +
    'toggles), plus computeTransformedCollisionGeometry (transformCollisionGeometryCore.ts) ' +
    'rotation/mirror point-application results over real mixed61-request.json piece dimensions ' +
    'and synthetic convex shapes, at quarter-turn and arbitrary trig-requiring angles. f64 values ' +
    'are recorded as big-endian IEEE-754 bit-pattern hex strings for bit-exact comparison.',
  generateTransformsCaseCount: generateCases.length,
  generateTransformsCases: generateCases,
  rotationCaseCount: rotationCases.length,
  rotationVectorCount,
  rotationCases
}

writeFileSync(join(VECTORS_DIR, 'transforms.json'), JSON.stringify(output, null, 2) + '\n')

console.log(
  `Wrote ${generateCases.length} generateTransforms cases and ${rotationCases.length} rotation ` +
    `cases (${rotationVectorCount} point vectors) (commit ${commit}) to ${VECTORS_DIR}`
)
