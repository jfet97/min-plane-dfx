/**
 * Differential-vector dump for `crates/irregular-nesting-native/src/transforms/flattening.rs`.
 *
 * Per `docs/planning/rust-irregular-backend/stage0-rulings.md` R14 and the
 * migration prompt's differential-vector requirement: imports the REAL
 * production TS namespace objects --
 *   - `ArcFlattening` (`src/workers/irregular/arcFlattening.ts`):
 *     `samplePoints`, `sampleBulgePoints`, `computeSampleCount`
 *   - `EllipseFlattening` (`src/workers/irregular/ellipseFlattening.ts`):
 *     `samplePoints`
 * -- evaluates them over a broad, deliberate radius/sweep/rotation/degenerate
 * input matrix plus real DXF-fixture-derived curves, and writes byte-exact
 * JSON oracle vectors for the Rust port's in-crate differential test
 * (`transforms::flattening::vector_tests`, see that module for why the test
 * lives in-crate rather than as a `tests/flattening_vectors.rs` integration
 * test -- `transforms::flattening` is currently a private Rust module owned
 * by a different task).
 *
 * Fixture search note: `grep`ping `tests/fixtures/` for arc/ellipse/bulge
 * segment data found real `kind: "arc"`/`"ellipse"` DXF *entities* only under
 * `tests/fixtures/dxf/circle-ellipse-arcs.dxf` (CIRCLE, ELLIPSE, two ARCs)
 * and `tests/fixtures/dxf/rounded-rectangle.dxf` (five ARCs) -- both are
 * imported below through the real production `importDxfFile` and flattened
 * with the real production functions at several sag tolerances. No real
 * LWPOLYLINE/POLYLINE **bulge** fixture exists anywhere under
 * `tests/fixtures/` (confirmed by grepping every `.dxf` file's group-code-42
 * vertex fields; the one apparent hit, in `near-collinear.dxf`, is a
 * coordinate value that happens to equal `42`, not a bulge), nor does the
 * JSON fixture `tests/fixtures/irregularSheetInvariance/mixed61-request.json`
 * carry anything but `"kind": "line"` segments (confirmed by scanning every
 * `sourcePieces[*].geometry.segments[*].kind`) -- so bulge coverage below
 * relies on the synthetic matrix, plus one hand-authored-but-real-parsed
 * LWPOLYLINE (mirroring `tests/unit/dxfSourceFlattening.test.ts`'s own
 * `bulgePolyline()`/`ellipse()` DXF text fixtures, imported through the same
 * real `importDxfFile` production entry point rather than constructed as a
 * bare object literal).
 *
 * Trig bit-parity note: the Rust side compares point counts and
 * `computeSampleCount` bit-exactly, but uses a documented, narrow
 * (1e-9 absolute/relative) tolerance for individual trig-derived point
 * coordinates -- `cos`/`sin`/`atan`/`atan2`/`acos`/`hypot` are not
 * guaranteed bit-identical between V8 and any Rust implementation, measured
 * directly against this exact vector set. See
 * `transforms::flattening::vector_tests::assert_points_match_ts_oracle`'s
 * doc comment (Rust side) for the full measured evidence and magnitude
 * analysis; nothing here needs to change on the TS side as a result.
 *
 * Run with:
 *   pnpm exec tsx --tsconfig tsconfig.node.json scripts/rust-parity/dump-flattening.ts
 *
 * Output: crates/irregular-nesting-native/tests/vectors/flattening.json
 *
 * Additive only -- does not modify any existing script, test, or fixture.
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

import { ArcFlattening } from '../../src/workers/irregular/arcFlattening.js'
import { EllipseFlattening } from '../../src/workers/irregular/ellipseFlattening.js'
import { importDxfFile } from '../../src/main/services/DxfImportService.js'
import type {
  DxfArcSegment,
  DxfEllipseSource,
  DxfLineSegment
} from '../../src/shared/domain/dxf.js'
import type { IrregularPoint } from '../../src/shared/irregular/domain.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..', '..')
const outputPath = join(
  repoRoot,
  'crates',
  'irregular-nesting-native',
  'tests',
  'vectors',
  'flattening.json'
)
const dxfFixturesDir = join(repoRoot, 'tests', 'fixtures', 'dxf')

function generatingCommit(): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot }).toString().trim()
}

// ---------------------------------------------------------------------------
// JSON-safe f64 encoding: plain JSON number for ordinary finite values;
// tagged strings for "0"/"-0"/"NaN"/"Infinity"/"-Infinity" (`JSON.stringify`
// itself folds -0 to 0 and cannot represent NaN/Infinity at all). Both
// `JSON.stringify`/`JSON.parse` (V8) and `serde_json` with the
// `float_roundtrip` feature (this crate's dependency, see `Cargo.toml`)
// implement the ECMAScript shortest-round-trip number<->string algorithm, so
// a plain JSON number round-trips to the bit-exact same `f64` on both sides.
// Mirrors `scripts/rust-parity/dump-canonical-grid.ts`'s `encodeF64`.
// ---------------------------------------------------------------------------

type EncodedF64 = number | 'NaN' | 'Infinity' | '-Infinity' | '0' | '-0'

function encodeF64(value: number): EncodedF64 {
  if (Number.isNaN(value)) return 'NaN'
  if (value === Number.POSITIVE_INFINITY) return 'Infinity'
  if (value === Number.NEGATIVE_INFINITY) return '-Infinity'
  if (value === 0) return Object.is(value, -0) ? '-0' : '0'
  return value
}

function encodeOptionalF64(value: number | undefined): EncodedF64 | null {
  return value === undefined ? null : encodeF64(value)
}

interface EncodedPoint {
  readonly x: EncodedF64
  readonly y: EncodedF64
}

function encodePoint(point: IrregularPoint): EncodedPoint {
  return { x: encodeF64(point.x), y: encodeF64(point.y) }
}

function encodePoints(points: ReadonlyArray<IrregularPoint>): EncodedPoint[] {
  return points.map(encodePoint)
}

// ---------------------------------------------------------------------------
// Deterministic seeded PRNG (mulberry32, matching the convention already
// used by `dump-predicates.ts`/`dump-canonical-grid.ts`) so the "combined
// random" categories are reproducible across machines and runs.
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

function pick<T>(random: () => number, values: readonly T[]): T {
  const value = values[Math.floor(random() * values.length)]
  if (value === undefined) throw new Error('pick from empty array')
  return value
}

// =============================================================================
// Arc `samplePoints` matrix
// =============================================================================

interface ArcCase {
  readonly category: string
  readonly arc: {
    readonly x1: EncodedF64
    readonly y1: EncodedF64
    readonly x2: EncodedF64
    readonly y2: EncodedF64
    readonly cx: EncodedF64
    readonly cy: EncodedF64
    readonly radius: EncodedF64
    readonly startAngle: EncodedF64
    readonly endAngle: EncodedF64
  }
  readonly sagToleranceMm: EncodedF64
  readonly points: EncodedPoint[]
}

interface ArcCountCase {
  readonly category: string
  readonly arc: ArcCase['arc']
  readonly sagToleranceMm: EncodedF64
  readonly sampleCount: EncodedF64
}

function encodeArc(arc: DxfArcSegment): ArcCase['arc'] {
  return {
    x1: encodeF64(arc.x1),
    y1: encodeF64(arc.y1),
    x2: encodeF64(arc.x2),
    y2: encodeF64(arc.y2),
    cx: encodeF64(arc.cx),
    cy: encodeF64(arc.cy),
    radius: encodeF64(arc.radius),
    startAngle: encodeF64(arc.startAngle),
    endAngle: encodeF64(arc.endAngle)
  }
}

/** Builds a DXF arc whose endpoints are exactly on the analytic circle (the common case). */
function arcOnCircle(
  cx: number,
  cy: number,
  radius: number,
  startAngleDeg: number,
  endAngleDeg: number
): DxfArcSegment {
  const toRad = (deg: number) => (deg * Math.PI) / 180
  return {
    kind: 'arc',
    x1: cx + Math.cos(toRad(startAngleDeg)) * radius,
    y1: cy + Math.sin(toRad(startAngleDeg)) * radius,
    x2: cx + Math.cos(toRad(endAngleDeg)) * radius,
    y2: cy + Math.sin(toRad(endAngleDeg)) * radius,
    cx,
    cy,
    radius,
    startAngle: startAngleDeg,
    endAngle: endAngleDeg
  }
}

const arcSamplePointsCases: ArcCase[] = []
const arcComputeSampleCountCases: ArcCountCase[] = []

function addArcSamplePointsCase(category: string, arc: DxfArcSegment, sagToleranceMm: number): void {
  const points = ArcFlattening.samplePoints(arc, sagToleranceMm)
  arcSamplePointsCases.push({
    category,
    arc: encodeArc(arc),
    sagToleranceMm: encodeF64(sagToleranceMm),
    points: encodePoints(points)
  })
}

function addArcComputeSampleCountCase(
  category: string,
  arc: DxfArcSegment,
  sagToleranceMm: number
): void {
  const sampleCount = ArcFlattening.computeSampleCount(arc, sagToleranceMm)
  arcComputeSampleCountCases.push({
    category,
    arc: encodeArc(arc),
    sagToleranceMm: encodeF64(sagToleranceMm),
    sampleCount: encodeF64(sampleCount)
  })
}

// --- 1. Radius matrix: fixed half-turn sweep and moderate sag, vary radius across many orders of magnitude, including zero. ---
{
  const radii = [
    0, 1e-9, 1e-6, 0.001, 0.01, 0.1, 0.5, 1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 1e4, 1e6
  ]
  for (const radius of radii) {
    addArcSamplePointsCase('radius-matrix', arcOnCircle(0, 0, radius, 0, 180), 0.1)
    addArcComputeSampleCountCase('radius-matrix', arcOnCircle(0, 0, radius, 0, 180), 0.1)
  }
}

// --- 2. Sweep/wraparound matrix: fixed radius and sag, vary (startAngle, endAngle) pairs. ---
{
  const sweepPairs: Array<[number, number]> = [
    [0, 0.0001], // tiny sweep
    [10, 10.00005], // tiny sweep, offset start
    [0, 90],
    [0, 180],
    [0, 270],
    [0, 359.999], // near full turn
    [0, 360], // exact full turn (raw positive, kept as-is)
    [0, 400], // over a full turn (raw positive > 360, kept as-is)
    [0, 720], // two full turns
    [45, 45], // exactly matching angles -> treated as full 360 turn
    [-45, -45],
    [10, 5], // small negative wrap: raw=-5 -> wrapped 355
    [350, 10], // negative wrap crossing zero: raw=-340 -> wrapped 20
    [720, 0], // raw=-720, wrapped -720 % 360 === -0 -> treated as full turn
    [730, 0], // raw=-730, wrapped -730 % 360 = -10 -> +360 = 350
    [-90, 90], // raw=180, negative start
    [-180, -90], // raw=90, both negative
    [-370, -10], // raw=360 (still positive per rawSweepDeg>0 branch)
    [0.0001, 0], // raw=-0.0001 -> wrapped -0.0001 -> +360 = 359.9999
    [359.9999, 0.0001], // raw negative tiny wrap
    [123.456, 234.567],
    [-123.456, -12.345],
    [1000, 1010], // large angle magnitudes, raw=10
    [-1000, -990]
  ]
  for (const [startAngleDeg, endAngleDeg] of sweepPairs) {
    addArcSamplePointsCase('sweep-matrix', arcOnCircle(0, 0, 10, startAngleDeg, endAngleDeg), 0.1)
    addArcComputeSampleCountCase(
      'sweep-matrix',
      arcOnCircle(0, 0, 10, startAngleDeg, endAngleDeg),
      0.1
    )
  }
}

// --- 3. Rotation matrix: fixed radius, fixed non-round sweep width, vary the start-angle rotation offset broadly. ---
{
  const sweepWidthDeg = 47.3
  const rotationOffsets = [
    0, 15, 30, 45, 60, 75, 90, 120, 150, 180, 210, 240, 270, 300, 330, 345, -15, -90, -180, -270,
    -359, 360, 370, 720, -720, 1e4
  ]
  for (const startAngleDeg of rotationOffsets) {
    addArcSamplePointsCase(
      'rotation-matrix',
      arcOnCircle(3, -7, 10, startAngleDeg, startAngleDeg + sweepWidthDeg),
      0.1
    )
  }
}

// --- 4. Sag-tolerance matrix: fixed radius/sweep, vary sag broadly, including edge/adversarial values. ---
{
  const radius = 10
  const sagValues = [
    0,
    -0,
    -5, // negative (adversarial: not TS-guarded to be positive)
    1e-4, // very tight but bounded: ~350 chords at radius=10, not the ~10^5 a 1e-9 tolerance would need
    0.001,
    0.01,
    0.1,
    1,
    2,
    5,
    radius, // sag exactly equal to radius (cappedSagToleranceMm boundary)
    // sag >= radius always clamps to `cappedSagToleranceMm = radius` (computeSampleCountForSweep's
    // `Math.min(sagToleranceMm, radius)`), so radius*2/radius*3 are deliberately-redundant
    // confirmations of that clamp, not distinct maxStepRad values.
    radius * 2,
    radius * 3,
    1e6,
    Number.POSITIVE_INFINITY,
    Number.NaN
  ]
  for (const sagToleranceMm of sagValues) {
    addArcSamplePointsCase('sag-matrix', arcOnCircle(0, 0, radius, 0, 180), sagToleranceMm)
    addArcComputeSampleCountCase('sag-matrix', arcOnCircle(0, 0, radius, 0, 180), sagToleranceMm)
  }
}

// --- 5. Combined seeded-random matrix: broad joint coverage of radius x sweep x sag x center position. ---
{
  const random = mulberry32(0xa2c5011a)
  for (let i = 0; i < 100; i++) {
    const radius = 10 ** randomInRange(random, -3, 4)
    const cx = randomInRange(random, -1000, 1000)
    const cy = randomInRange(random, -1000, 1000)
    const startAngleDeg = randomInRange(random, -720, 720)
    const sweepDeg = pick(random, [0.001, 1, 5, 30, 90, 180, 270, 359, 360, 400])
    const sagToleranceMm = radius * pick(random, [0.0001, 0.001, 0.01, 0.05, 0.2, 1, 3])
    addArcSamplePointsCase(
      'combined-random',
      arcOnCircle(cx, cy, radius, startAngleDeg, startAngleDeg + sweepDeg),
      sagToleranceMm
    )
    if (i % 2 === 0) {
      addArcComputeSampleCountCase(
        'combined-random',
        arcOnCircle(cx, cy, radius, startAngleDeg, startAngleDeg + sweepDeg),
        sagToleranceMm
      )
    }
  }
}

// --- 6. Adversarial non-finite inputs: pin exact NaN/Infinity propagation behavior. ---
{
  const baseArc = arcOnCircle(0, 0, 10, 0, 180)
  addArcSamplePointsCase('adversarial-non-finite', { ...baseArc, radius: Number.NaN }, 0.1)
  addArcSamplePointsCase(
    'adversarial-non-finite',
    { ...baseArc, radius: Number.POSITIVE_INFINITY },
    0.1
  )
  addArcSamplePointsCase('adversarial-non-finite', { ...baseArc, radius: -10 }, 0.1)
  addArcSamplePointsCase(
    'adversarial-non-finite',
    { ...baseArc, startAngle: Number.NaN },
    0.1
  )
  addArcSamplePointsCase(
    'adversarial-non-finite',
    { ...baseArc, endAngle: Number.POSITIVE_INFINITY },
    0.1
  )
  addArcSamplePointsCase(
    'adversarial-non-finite',
    { ...baseArc, startAngle: Number.NEGATIVE_INFINITY, endAngle: Number.POSITIVE_INFINITY },
    0.1
  )
  addArcComputeSampleCountCase('adversarial-non-finite', { ...baseArc, radius: Number.NaN }, 0.1)
  addArcComputeSampleCountCase(
    'adversarial-non-finite',
    { ...baseArc, radius: Number.POSITIVE_INFINITY },
    0.1
  )
  addArcComputeSampleCountCase('adversarial-non-finite', baseArc, Number.NaN)
}

// --- 7. Endpoint-mismatch: imported endpoints deliberately off the analytic circle (real DXF rounding drift). ---
{
  const drifted: DxfArcSegment = {
    kind: 'arc',
    x1: 10.0000001,
    y1: -0.0000003,
    x2: -9.9999998,
    y2: 0.0000004,
    cx: 0,
    cy: 0,
    radius: 10,
    startAngle: 0,
    endAngle: 180
  }
  for (const sagToleranceMm of [0.01, 0.5, 5]) {
    addArcSamplePointsCase('endpoint-mismatch', drifted, sagToleranceMm)
  }
  const wildlyOff: DxfArcSegment = {
    kind: 'arc',
    x1: 3,
    y1: 4,
    x2: -3,
    y2: -4,
    cx: 0,
    cy: 0,
    radius: 10,
    startAngle: 0,
    endAngle: 180
  }
  addArcSamplePointsCase('endpoint-mismatch', wildlyOff, 0.1)
}

// =============================================================================
// Arc `sampleBulgePoints` matrix
// =============================================================================

interface BulgeCase {
  readonly category: string
  readonly segment: {
    readonly x1: EncodedF64
    readonly y1: EncodedF64
    readonly x2: EncodedF64
    readonly y2: EncodedF64
    readonly bulge: EncodedF64 | null
  }
  readonly sagToleranceMm: EncodedF64
  readonly points: EncodedPoint[]
}

const arcSampleBulgePointsCases: BulgeCase[] = []

function encodeSegment(segment: DxfLineSegment): BulgeCase['segment'] {
  return {
    x1: encodeF64(segment.x1),
    y1: encodeF64(segment.y1),
    x2: encodeF64(segment.x2),
    y2: encodeF64(segment.y2),
    bulge: encodeOptionalF64(segment.bulge)
  }
}

function addBulgeCase(category: string, segment: DxfLineSegment, sagToleranceMm: number): void {
  const points = ArcFlattening.sampleBulgePoints(segment, sagToleranceMm)
  arcSampleBulgePointsCases.push({
    category,
    segment: encodeSegment(segment),
    sagToleranceMm: encodeF64(sagToleranceMm),
    points: encodePoints(points)
  })
}

function segment(x1: number, y1: number, x2: number, y2: number, bulge?: number): DxfLineSegment {
  return { kind: 'line', x1, y1, x2, y2, bulge }
}

// --- 1. Bulge-value matrix: undefined/zero (straight-chord degradation) through a wide range of signed bulges. ---
{
  const bulgeValues: Array<number | undefined> = [
    undefined,
    0,
    -0,
    1e-9,
    -1e-9,
    0.001,
    0.01,
    0.1,
    0.2679, // ~30deg-scale sweep
    0.5,
    1, // exactly a semicircle: sweep = 4*atan(1) = pi
    1.5,
    2, // sweep = 4*atan(2) ~ 220.6deg
    5,
    10,
    100, // near-degenerate huge bulge (very tight radius relative to chord)
    -0.1,
    -0.5,
    -1,
    -2,
    -10
  ]
  for (const bulge of bulgeValues) {
    addBulgeCase('bulge-value-matrix', segment(0, 0, 10, 0, bulge), 0.05)
  }
}

// --- 2. Chord geometry matrix: horizontal/vertical/diagonal/negative-coordinate/zero-length chords, fixed bulge. ---
{
  const chords: Array<[number, number, number, number]> = [
    [0, 0, 10, 0], // horizontal
    [0, 0, 0, 10], // vertical
    [0, 0, 10, 10], // diagonal
    [-5, -5, 5, 5], // straddling origin
    [-100, 50, -80, -30], // negative coordinates
    [1000, 1000, 1000.001, 1000], // tiny chord at large offset
    [3, 4, 3, 4] // zero-length chord (degenerate: chord<=0 -> null arc)
  ]
  for (const [x1, y1, x2, y2] of chords) {
    addBulgeCase('chord-geometry-matrix', segment(x1, y1, x2, y2, 0.4142), 0.05)
    addBulgeCase('chord-geometry-matrix', segment(x1, y1, x2, y2, -0.7), 0.05)
  }
}

// --- 3. Sag-tolerance matrix for a fixed semicircle bulge. ---
{
  const sagValues = [0, -1, 1e-6, 0.001, 0.05, 0.5, 1, 5, 100, Number.NaN, Number.POSITIVE_INFINITY]
  for (const sagToleranceMm of sagValues) {
    addBulgeCase('bulge-sag-matrix', segment(0, 0, 10, 0, 1), sagToleranceMm)
  }
}

// --- 4. Combined seeded-random matrix. ---
{
  const random = mulberry32(0xb01765e)
  for (let i = 0; i < 40; i++) {
    const x1 = randomInRange(random, -500, 500)
    const y1 = randomInRange(random, -500, 500)
    const angle = randomInRange(random, 0, Math.PI * 2)
    const length = 10 ** randomInRange(random, -2, 3)
    const x2 = x1 + Math.cos(angle) * length
    const y2 = y1 + Math.sin(angle) * length
    const bulge = pick(random, [-5, -2, -1, -0.5, -0.1, 0.1, 0.3, 0.5, 1, 2, 5])
    const sagToleranceMm = length * pick(random, [0.001, 0.01, 0.1, 0.5, 2])
    addBulgeCase('bulge-combined-random', segment(x1, y1, x2, y2, bulge), sagToleranceMm)
  }
}

// =============================================================================
// Ellipse `samplePoints` matrix
// =============================================================================

interface EllipseCase {
  readonly category: string
  readonly ellipse: {
    readonly sourceId: string
    readonly cx: EncodedF64
    readonly cy: EncodedF64
    readonly majorAxisX: EncodedF64
    readonly majorAxisY: EncodedF64
    readonly axisRatio: EncodedF64
    readonly startAngle: EncodedF64
    readonly endAngle: EncodedF64
  }
  readonly sagToleranceMm: EncodedF64
  readonly points: EncodedPoint[]
}

const ellipseSamplePointsCases: EllipseCase[] = []

function encodeEllipse(ellipse: DxfEllipseSource): EllipseCase['ellipse'] {
  return {
    sourceId: ellipse.sourceId,
    cx: encodeF64(ellipse.cx),
    cy: encodeF64(ellipse.cy),
    majorAxisX: encodeF64(ellipse.majorAxisX),
    majorAxisY: encodeF64(ellipse.majorAxisY),
    axisRatio: encodeF64(ellipse.axisRatio),
    startAngle: encodeF64(ellipse.startAngle),
    endAngle: encodeF64(ellipse.endAngle)
  }
}

function addEllipseCase(
  category: string,
  ellipse: DxfEllipseSource,
  sagToleranceMm: number
): void {
  const points = EllipseFlattening.samplePoints(ellipse, sagToleranceMm)
  ellipseSamplePointsCases.push({
    category,
    ellipse: encodeEllipse(ellipse),
    sagToleranceMm: encodeF64(sagToleranceMm),
    points: encodePoints(points)
  })
}

function ellipse(
  sourceId: string,
  cx: number,
  cy: number,
  majorAxisX: number,
  majorAxisY: number,
  axisRatio: number,
  startAngle: number,
  endAngle: number
): DxfEllipseSource {
  return { kind: 'ellipse', sourceId, cx, cy, majorAxisX, majorAxisY, axisRatio, startAngle, endAngle }
}

const FULL_TURN = Math.PI * 2

// --- 1. Rotation matrix: vary major-axis direction/magnitude, fixed well-conditioned ratio/sweep/sag. ---
{
  const rotationsDeg = [
    0, 15, 30, 45, 60, 75, 90, 120, 150, 180, 210, 240, 270, 300, 330, -30, -90, 359
  ]
  const axisLengths = [1, 5, 10, 50, 100, 1000]
  for (const rotationDeg of rotationsDeg) {
    for (const axisLength of axisLengths) {
      const rad = (rotationDeg * Math.PI) / 180
      const majorAxisX = Math.cos(rad) * axisLength
      const majorAxisY = Math.sin(rad) * axisLength
      addEllipseCase(
        'rotation-matrix',
        ellipse('rot', 0, 0, majorAxisX, majorAxisY, 0.5, 0, FULL_TURN),
        axisLength * 0.02
      )
    }
  }
}

// --- 2. Axis-ratio matrix: vary axisRatio widely, fixed rotation/sweep/sag. ---
{
  const axisRatios = [1e-3, 1e-2, 0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 1.0, 1.5, 2, 5, 10]
  for (const axisRatio of axisRatios) {
    addEllipseCase(
      'axis-ratio-matrix',
      ellipse('ratio', 2, -3, 20, 0, axisRatio, 0, FULL_TURN),
      0.5
    )
  }
}

// --- 3. Sweep/wraparound matrix: vary (startAngle, endAngle) pairs (radians), fixed rotation/ratio/sag. ---
{
  const sweepPairs: Array<[number, number]> = [
    [0, FULL_TURN], // exact full turn
    [0, FULL_TURN - 0.001], // near-full turn
    [0, Math.PI], // half turn
    [0, Math.PI / 2], // quarter turn
    [0, 0.0005], // tiny sweep
    [1, 1], // equal angles -> wraps to full turn (endAngle <= startAngle branch)
    [FULL_TURN, 0], // genuine zero sweep (startAngle - endAngle === exactly one full turn)
    [5, 2], // endAngle < startAngle, small backward wrap
    [-1, 1], // negative start angle
    [-Math.PI, -Math.PI / 2],
    [10, 10.5],
    [-10, -9.5],
    [3 * Math.PI, 0], // large start angle magnitude
    [0, 3 * Math.PI] // endAngle far beyond a full turn (kept as-is, endAngle>startAngle branch)
  ]
  for (const [startAngle, endAngle] of sweepPairs) {
    addEllipseCase(
      'sweep-matrix',
      ellipse('sweep', 0, 0, 10, 0, 0.5, startAngle, endAngle),
      0.2
    )
  }
}

// --- 4. Sag-tolerance matrix: fixed well-conditioned ellipse, vary sag broadly including edge/adversarial values. ---
//
// Deliberately excludes sag <= 0 and NaN sag here: unlike ArcFlattening's
// computeSampleCountForSweep (which has an explicit `maxStepRad <= 0 ->
// return 1` guard, `arcFlattening.ts:127`), EllipseFlattening's
// needsSubdivision has no analogous guard -- `conservativeDeviationBound <=
// sagToleranceMm` is false for every sag <= 0 (bound is always positive) and
// for NaN sag (every JS/Rust comparison against NaN is false), so subdivision
// never stops on tolerance grounds and every leaf recurses to the full
// `MAX_RECURSION_DEPTH`, which for a full-turn ellipse produces on the order
// of `4 * 2^20` candidate points (capped by `MAX_SAMPLE_POINTS`, but only
// after crossing it) -- real, mechanically-preserved TS behavior, but far
// too large a point list for a JSON differential-vector fixture. That exact
// interaction (sag <= 0 / NaN forcing the recursion-depth and
// MAX_SAMPLE_POINTS caps to both engage, and still terminating without
// panicking) is covered directly and cheaply by this crate's own
// `ellipse::unit_tests::sample_points_recursion_depth_cap_terminates_without_panicking`
// instead, which asserts the bound rather than diffing ~1M coordinates
// against a TS oracle. `Infinity` sag is safe to include here (the
// conservative bound is trivially `<= Infinity`, so it never subdivides at
// all), so it stays.
{
  const sagValues = [1e-6, 0.001, 0.01, 0.1, 0.5, 1, 5, 50, 1e6, Number.POSITIVE_INFINITY]
  for (const sagToleranceMm of sagValues) {
    addEllipseCase('sag-matrix', ellipse('sag', 0, 0, 10, 0, 0.5, 0, FULL_TURN), sagToleranceMm)
  }
}

// --- 5. Degenerate matrix: zero major axis, zero sweep, extreme thin/fat ratio, huge/tiny scale. ---
{
  addEllipseCase('degenerate', ellipse('deg-zero-axis', 0, 0, 0, 0, 0.5, 0, FULL_TURN), 0.1)
  addEllipseCase('degenerate', ellipse('deg-zero-sweep', 0, 0, 10, 0, 0.5, 5, 5 - FULL_TURN), 0.1)
  addEllipseCase(
    'degenerate',
    ellipse('deg-nan-sweep', 0, 0, 10, 0, 0.5, Number.NaN, FULL_TURN),
    0.1
  )
  addEllipseCase(
    'degenerate',
    ellipse('deg-infinite-axis', 0, 0, Number.POSITIVE_INFINITY, 0, 0.5, 0, FULL_TURN),
    0.1
  )
  addEllipseCase('degenerate', ellipse('deg-huge-axis', 0, 0, 1e8, 0, 0.5, 0, FULL_TURN), 1000)
  addEllipseCase('degenerate', ellipse('deg-tiny-axis', 0, 0, 1e-6, 0, 0.5, 0, FULL_TURN), 1e-8)
  addEllipseCase(
    'degenerate',
    ellipse('deg-thin-ratio', 0, 0, 20, 0, 1e-3, 0, FULL_TURN),
    0.05
  )
  addEllipseCase(
    'degenerate',
    ellipse('deg-fat-ratio', 0, 0, 20, 0, 50, 0, FULL_TURN),
    0.5
  )
  addEllipseCase(
    'degenerate',
    ellipse('deg-negative-axis-vector', 0, 0, -20, -5, 0.5, 0, FULL_TURN),
    0.5
  )
}

// --- 6. Combined seeded-random matrix. ---
{
  const random = mulberry32(0xe11ec1de)
  for (let i = 0; i < 80; i++) {
    const axisLength = 10 ** randomInRange(random, -1, 3)
    const rotationRad = randomInRange(random, -Math.PI * 2, Math.PI * 2)
    const majorAxisX = Math.cos(rotationRad) * axisLength
    const majorAxisY = Math.sin(rotationRad) * axisLength
    const axisRatio = pick(random, [0.05, 0.1, 0.25, 0.4, 0.6, 0.8, 1, 1.3, 2])
    const cx = randomInRange(random, -1000, 1000)
    const cy = randomInRange(random, -1000, 1000)
    const startAngle = randomInRange(random, -Math.PI * 2, Math.PI * 2)
    const sweep = pick(random, [
      0.001,
      Math.PI / 4,
      Math.PI / 2,
      Math.PI,
      FULL_TURN * 0.9,
      FULL_TURN
    ])
    const sagToleranceMm = axisLength * pick(random, [0.001, 0.01, 0.05, 0.2, 1])
    addEllipseCase(
      'combined-random',
      ellipse('combined', cx, cy, majorAxisX, majorAxisY, axisRatio, startAngle, startAngle + sweep),
      sagToleranceMm
    )
  }
}

// =============================================================================
// Real DXF-fixture-derived cases (real production parser + importer + the
// real production flattening functions -- not hand-constructed literals).
// =============================================================================

async function addRealFixtureCases(): Promise<void> {
  // --- circle-ellipse-arcs.dxf: one CIRCLE, one full-turn ELLIPSE, two ARCs. ---
  {
    const path = join(dxfFixturesDir, 'circle-ellipse-arcs.dxf')
    const document = await importDxfFile(path)
    for (const piece of document.pieces) {
      // Mirrors `GeometryKernel.flattenSourceGeometry`'s `sampledSourceCurves`
      // dedup (`geometryKernel.ts:116-126`): one ELLIPSE source entity is
      // preview-approximated into many `kind: 'line'` segments that all carry
      // an identical (deep-equal) `sourceCurve` copy keyed by `sourceId`; the
      // real production flattener samples each distinct `sourceId` only once
      // (via the first segment that carries it), not once per preview
      // segment. Reproduced here both for realism and to avoid dumping
      // dozens of byte-identical duplicate cases.
      const sampledSourceCurveIds = new Set<string>()
      for (const seg of piece.geometry.segments) {
        if (seg.kind === 'arc') {
          for (const sagToleranceMm of [0.05, 0.5, 2, 10]) {
            addArcSamplePointsCase(`fixture:circle-ellipse-arcs.dxf:${piece.label}`, seg, sagToleranceMm)
            addArcComputeSampleCountCase(
              `fixture:circle-ellipse-arcs.dxf:${piece.label}`,
              seg,
              sagToleranceMm
            )
          }
        }
        if (seg.kind === 'line' && seg.sourceCurve !== undefined) {
          if (sampledSourceCurveIds.has(seg.sourceCurve.sourceId)) continue
          sampledSourceCurveIds.add(seg.sourceCurve.sourceId)
          for (const sagToleranceMm of [0.05, 0.5, 2, 10]) {
            addEllipseCase(
              `fixture:circle-ellipse-arcs.dxf:${piece.label}`,
              seg.sourceCurve,
              sagToleranceMm
            )
          }
        }
      }
    }
  }

  // --- rounded-rectangle.dxf: five ARCs (rounded corners). ---
  {
    const path = join(dxfFixturesDir, 'rounded-rectangle.dxf')
    const document = await importDxfFile(path)
    for (const piece of document.pieces) {
      for (const seg of piece.geometry.segments) {
        if (seg.kind === 'arc') {
          for (const sagToleranceMm of [0.02, 0.2, 1, 5]) {
            addArcSamplePointsCase(`fixture:rounded-rectangle.dxf:${piece.label}`, seg, sagToleranceMm)
            addArcComputeSampleCountCase(
              `fixture:rounded-rectangle.dxf:${piece.label}`,
              seg,
              sagToleranceMm
            )
          }
        }
      }
    }
  }

  // --- Hand-authored-but-really-parsed LWPOLYLINE bulge and ELLIPSE entities,
  //     mirroring tests/unit/dxfSourceFlattening.test.ts's bulgePolyline()/
  //     ellipse() DXF text exactly, imported through the real production
  //     parser (dxf-parser + DxfImportService), not constructed as bare
  //     object literals. No fixture file under tests/fixtures/dxf carries a
  //     real bulge, so this is the closest available "real parser output"
  //     bulge coverage. ---
  {
    const pair = (code: number, value: number | string): string => `${code}\n${value}\n`
    const dxfText = (entity: string): string =>
      [
        pair(0, 'SECTION'),
        pair(2, 'HEADER'),
        pair(0, 'ENDSEC'),
        pair(0, 'SECTION'),
        pair(2, 'ENTITIES'),
        entity,
        pair(0, 'ENDSEC'),
        pair(0, 'EOF')
      ].join('')

    const bulgePolyline = [
      pair(0, 'LWPOLYLINE'),
      pair(70, 1),
      pair(90, 3),
      pair(10, 0),
      pair(20, 0),
      pair(42, 1),
      pair(10, 20),
      pair(20, 0),
      pair(10, 0),
      pair(20, 20)
    ].join('')

    const ellipseEntity = [
      pair(0, 'ELLIPSE'),
      pair(10, 30),
      pair(20, 20),
      pair(30, 0),
      pair(11, 40),
      pair(21, 0),
      pair(31, 0),
      pair(40, 0.5),
      pair(41, 0),
      pair(42, Math.PI * 2)
    ].join('')

    const directory = mkdtempSync(join(tmpdir(), 'min-plane-dxf-flatten-dump-'))
    try {
      const bulgePath = join(directory, 'bulge.dxf')
      writeFileSync(bulgePath, dxfText(bulgePolyline), 'utf8')
      const bulgeDoc = await importDxfFile(bulgePath)
      const bulgePiece = bulgeDoc.pieces[0]
      if (bulgePiece !== undefined) {
        for (const seg of bulgePiece.geometry.segments) {
          if (seg.kind === 'line' && seg.bulge !== undefined) {
            for (const sagToleranceMm of [0.01, 0.1, 1, 5]) {
              addBulgeCase('fixture:real-parsed-bulge-polyline', seg, sagToleranceMm)
            }
          }
        }
      }

      const ellipsePath = join(directory, 'ellipse.dxf')
      writeFileSync(ellipsePath, dxfText(ellipseEntity), 'utf8')
      const ellipseDoc = await importDxfFile(ellipsePath)
      const ellipsePiece = ellipseDoc.pieces[0]
      if (ellipsePiece !== undefined) {
        // Same `sourceId`-keyed dedup as the circle-ellipse-arcs.dxf block
        // above (one ELLIPSE entity's preview polygon carries the identical
        // `sourceCurve` on every one of its many line segments).
        const sampledSourceCurveIds = new Set<string>()
        for (const seg of ellipsePiece.geometry.segments) {
          if (seg.kind === 'line' && seg.sourceCurve !== undefined) {
            if (sampledSourceCurveIds.has(seg.sourceCurve.sourceId)) continue
            sampledSourceCurveIds.add(seg.sourceCurve.sourceId)
            for (const sagToleranceMm of [0.05, 0.5, 5, 25]) {
              addEllipseCase('fixture:real-parsed-ellipse-entity', seg.sourceCurve, sagToleranceMm)
            }
          }
        }
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }
}

await addRealFixtureCases()

// ---------------------------------------------------------------------------
// Sanity checks before writing.
// ---------------------------------------------------------------------------

const totalCaseCount =
  arcSamplePointsCases.length +
  arcSampleBulgePointsCases.length +
  ellipseSamplePointsCases.length +
  arcComputeSampleCountCases.length

if (totalCaseCount < 400) {
  throw new Error(`Expected at least 400 flattening differential vectors, generated only ${totalCaseCount}.`)
}
if (arcSamplePointsCases.length < 100) {
  throw new Error(`Expected >= 100 arc samplePoints cases, got ${arcSamplePointsCases.length}.`)
}
if (ellipseSamplePointsCases.length < 100) {
  throw new Error(`Expected >= 100 ellipse samplePoints cases, got ${ellipseSamplePointsCases.length}.`)
}
if (arcSampleBulgePointsCases.length < 30) {
  throw new Error(`Expected >= 30 bulge samplePoints cases, got ${arcSampleBulgePointsCases.length}.`)
}
if (arcComputeSampleCountCases.length < 30) {
  throw new Error(
    `Expected >= 30 arc computeSampleCount cases, got ${arcComputeSampleCountCases.length}.`
  )
}

const maxPointsInAnyCase = Math.max(
  ...arcSamplePointsCases.map((c) => c.points.length),
  ...arcSampleBulgePointsCases.map((c) => c.points.length),
  ...ellipseSamplePointsCases.map((c) => c.points.length)
)

// Confirm the fixture directory this script documents scanning still exists
// with the two files this script names by name (a silent rename/removal
// would otherwise degrade the "real fixture" categories to nothing without
// failing loudly).
const fixtureFiles = readdirSync(dxfFixturesDir)
for (const requiredFixture of ['circle-ellipse-arcs.dxf', 'rounded-rectangle.dxf']) {
  if (!fixtureFiles.includes(requiredFixture)) {
    throw new Error(`Expected fixture ${requiredFixture} under ${dxfFixturesDir}`)
  }
}

// ---------------------------------------------------------------------------
// Write output.
// ---------------------------------------------------------------------------

mkdirSync(dirname(outputPath), { recursive: true })

const commit = generatingCommit()

const output = {
  generatedByScript: 'scripts/rust-parity/dump-flattening.ts',
  generatingCommit: commit,
  sourceModules: [
    'src/workers/irregular/arcFlattening.ts',
    'src/workers/irregular/ellipseFlattening.ts'
  ],
  description:
    'ArcFlattening.samplePoints/sampleBulgePoints/computeSampleCount and ' +
    'EllipseFlattening.samplePoints (the real production namespace-object exports) ' +
    'evaluated over a deliberate radius/sweep/rotation/degenerate input matrix plus ' +
    'real DXF-fixture-derived curves (tests/fixtures/dxf/circle-ellipse-arcs.dxf, ' +
    'tests/fixtures/dxf/rounded-rectangle.dxf, and two hand-authored-but-really-parsed ' +
    'entities mirroring tests/unit/dxfSourceFlattening.test.ts). f64 values are plain ' +
    'JSON numbers for ordinary finite values and tagged strings ("0"/"-0"/"NaN"/' +
    '"Infinity"/"-Infinity") otherwise, matching dump-canonical-grid.ts\'s encodeF64 ' +
    'convention (both JSON.stringify/JSON.parse and serde_json[float_roundtrip] ' +
    'round-trip plain finite JSON numbers bit-exactly).',
  caseCount: totalCaseCount,
  maxPointsInAnySingleCase: maxPointsInAnyCase,
  arcSamplePoints: arcSamplePointsCases,
  arcSampleBulgePoints: arcSampleBulgePointsCases,
  ellipseSamplePoints: ellipseSamplePointsCases,
  arcComputeSampleCount: arcComputeSampleCountCases
}

writeFileSync(outputPath, JSON.stringify(output, null, 2) + '\n')

console.log(
  `Wrote ${totalCaseCount} flattening differential vectors ` +
    `(arc.samplePoints=${arcSamplePointsCases.length}, ` +
    `arc.sampleBulgePoints=${arcSampleBulgePointsCases.length}, ` +
    `ellipse.samplePoints=${ellipseSamplePointsCases.length}, ` +
    `arc.computeSampleCount=${arcComputeSampleCountCases.length}, ` +
    `maxPointsInAnySingleCase=${maxPointsInAnyCase}) ` +
    `(commit ${commit}) to ${outputPath}`
)
