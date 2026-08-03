/**
 * Differential-vector generator for
 * `crates/irregular-nesting-native/src/geometry/collision_builder.rs`.
 *
 * Per docs/planning/rust-irregular-backend/stage0-rulings.md R14: this script
 * imports the REAL production TS entry point --
 *   - `CollisionGeometryBuilder.buildPiece` (`CollisionGeometryBuilder.Live`,
 *     `src/workers/irregular/collisionGeometryBuilder.ts`), which itself
 *     composes the real `GeometryKernel.Live` (`flattenSourceGeometry` ->
 *     `ArcFlattening`/`EllipseFlattening`, `convexHull`, `offsetConvexPolygon`
 *     -> `ConvexPolygonOffset.compute` -> `Clipper2OffsetAdapter.compute` ->
 *     the real pinned `clipper2-ts@2.0.1-18` `inflatePaths`)
 * -- evaluates it over all 61 `mixed61-request.json` source pieces, two real
 * DXF fixtures with ARC/ELLIPSE source curves, a varied padding/geometry-settings
 * matrix, and a set of degenerate/invalid inputs, and writes byte-exact JSON
 * vectors for the Rust port
 * (`geometry::collision_builder::build_piece`/`clipper2_offset_adapter_compute`/
 * `convex_polygon_offset_compute`) to replay exactly.
 *
 * Run with:
 *   pnpm exec tsx --tsconfig tsconfig.node.json scripts/rust-parity/dump-collision-builder.ts
 *
 * Output (additive; never edits existing fixtures/tests):
 *   - crates/irregular-nesting-native/tests/vectors/collision-builder.json
 */
import { Effect, Exit, Layer, Option } from 'effect'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  CollisionGeometry,
  CollisionGeometryDiagnostic,
  IrregularGeometrySettings,
  IrregularNestingSettings,
  IrregularPoint
} from '../../src/shared/irregular/domain.js'
import { DEFAULT_IRREGULAR_NESTING_SETTINGS } from '../../src/shared/irregular/defaults.js'
import { DxfGeometrySummary, ImportedPiece, ImportWarning } from '../../src/shared/domain/dxf.js'
import { PieceId, SourceFileId } from '../../src/shared/domain/ids.js'
import { Rect } from '../../src/shared/domain/geometry.js'
import { CollisionGeometryBuilder } from '../../src/workers/irregular/collisionGeometryBuilder.js'
import { GeometryKernel, GeometrySettings } from '../../src/workers/irregular/geometryKernel.js'
import { IrregularGeometryInputError } from '../../src/workers/irregular/services.js'
import { importDxfFile } from '../../src/main/services/DxfImportService.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..', '..')
const VECTORS_DIR = join(REPO_ROOT, 'crates', 'irregular-nesting-native', 'tests', 'vectors')
const MIXED61_FIXTURE_PATH = join(
  REPO_ROOT,
  'tests/fixtures/irregularSheetInvariance/mixed61-request.json'
)
const DXF_FIXTURES_DIR = join(REPO_ROOT, 'tests', 'fixtures', 'dxf')

function generatingCommit(): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT }).toString().trim()
}

// ---------------------------------------------------------------------------
// f64 -> exact bit pattern (matches dump-predicates.ts's `f64Bits`/
// dump-transforms.ts's own copy; kept independent per-script per that
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

interface PointBits {
  readonly x: string
  readonly y: string
}

function encodePoint(point: IrregularPoint): PointBits {
  return { x: f64Bits(point.x), y: f64Bits(point.y) }
}

function encodePoints(points: ReadonlyArray<IrregularPoint>): PointBits[] {
  return points.map(encodePoint)
}

interface BoundsBits {
  readonly minX: string
  readonly minY: string
  readonly maxX: string
  readonly maxY: string
}

function encodeBounds(bounds: {
  readonly minX: number
  readonly minY: number
  readonly maxX: number
  readonly maxY: number
}): BoundsBits {
  return {
    minX: f64Bits(bounds.minX),
    minY: f64Bits(bounds.minY),
    maxX: f64Bits(bounds.maxX),
    maxY: f64Bits(bounds.maxY)
  }
}

interface DiagnosticRecord {
  readonly code: string
  readonly message: string
  readonly pieceId: string | null
}

function encodeDiagnostics(
  diagnostics: ReadonlyArray<CollisionGeometryDiagnostic>
): DiagnosticRecord[] {
  return diagnostics.map((diagnostic) => ({
    code: diagnostic.code,
    message: diagnostic.message,
    pieceId: Object.prototype.hasOwnProperty.call(diagnostic, 'pieceId')
      ? (diagnostic.pieceId as string)
      : null
  }))
}

// ---------------------------------------------------------------------------
// buildPiece harness: real `CollisionGeometryBuilder.Live` (which internally
// composes real `GeometryKernel.Live`), with `GeometrySettings` supplied per
// case -- mirrors `nesting.worker.ts:391-398`'s production layer wiring
// (`CollisionGeometryBuilder.Live` + `GeometryKernel.Live` + a
// `Layer.succeed(GeometrySettings, ...)` override), matching
// `dump-transforms.ts`'s established pattern for this crate's other Effect
// service ports.
// ---------------------------------------------------------------------------
function geometrySettings(sagToleranceMm: number, clearanceSafetyMarginMm: number): IrregularGeometrySettings {
  return new IrregularGeometrySettings({
    flatteningSagToleranceMm: sagToleranceMm,
    clearanceSafetyMarginMm,
    geometryBackendId: 'dump-collision-builder',
    geometryBackendVersion: '0'
  })
}

interface BuildResult {
  readonly ok: boolean
  readonly operation?: string
  readonly message?: string
  readonly sourceBounds?: BoundsBits
  readonly sampledPoints?: PointBits[]
  readonly convexHull?: PointBits[]
  readonly collisionPolygon?: PointBits[]
  readonly placementReference?: PointBits
  readonly diagnostics?: DiagnosticRecord[]
}

function runBuildPiece(
  piece: ImportedPiece,
  totalPaddingMm: number,
  geometry: IrregularGeometrySettings
): BuildResult {
  const settings = new IrregularNestingSettings({
    geometry,
    optimizer: DEFAULT_IRREGULAR_NESTING_SETTINGS.optimizer
  })
  const exit = Effect.runSyncExit(
    CollisionGeometryBuilder.use((builder) => builder.buildPiece({ piece, totalPaddingMm })).pipe(
      Effect.provide(CollisionGeometryBuilder.Live),
      Effect.provide(GeometryKernel.Live),
      Effect.provide(Layer.succeed(GeometrySettings, settings))
    )
  )

  if (Exit.isFailure(exit)) {
    const failure = Exit.findErrorOption(exit)
    if (Option.isNone(failure) || !(failure.value instanceof IrregularGeometryInputError)) {
      throw new Error(
        `unexpected buildPiece failure cause for piece ${piece.id}: ${JSON.stringify(exit.cause)}`
      )
    }
    return { ok: false, operation: failure.value.operation, message: failure.value.message }
  }

  const geometryResult: CollisionGeometry = exit.value
  return {
    ok: true,
    sourceBounds: encodeBounds(geometryResult.sourceBounds),
    sampledPoints: encodePoints(geometryResult.sampledPoints),
    convexHull: encodePoints(geometryResult.convexHull.points),
    collisionPolygon: encodePoints(geometryResult.collisionPolygon.points),
    placementReference: encodePoint(geometryResult.placementReference),
    diagnostics: encodeDiagnostics(geometryResult.diagnostics)
  }
}

// ---------------------------------------------------------------------------
// Load real mixed61 source pieces (line-segment geometry).
// ---------------------------------------------------------------------------
interface Mixed61Fixture {
  readonly sourcePieces: ReadonlyArray<ImportedPiece>
}

function loadMixed61SourcePieces(): ReadonlyArray<ImportedPiece> {
  const raw = readFileSync(MIXED61_FIXTURE_PATH, 'utf8')
  const parsed = JSON.parse(raw) as Mixed61Fixture
  return parsed.sourcePieces
}

// ---------------------------------------------------------------------------
// Hand-constructed adversarial `ImportedPiece` values for degenerate/invalid
// coverage. `BuildCollisionGeometryInput`/`ImportedPiece` are plain
// interfaces at this call boundary (collision-prep.md §3: "Not a
// `Schema.Struct` -- no runtime decoding at this call boundary"), so
// constructing these directly (bypassing DXF import) mirrors
// `tests/unit/collisionGeometryBuilder.test.ts`'s own `rectanglePiece`
// pattern exactly.
// ---------------------------------------------------------------------------
function rectanglePiece(input: {
  readonly id: string
  readonly closed?: boolean
  readonly warnings?: ReadonlyArray<ImportWarning>
}): ImportedPiece {
  return new ImportedPiece({
    id: PieceId.make(input.id),
    sourceFileId: SourceFileId.make('dump-collision-builder-source'),
    label: 'dump-collision-builder rectangle',
    realBounds: new Rect({ x: 10, y: 20, width: 4, height: 3 }),
    geometry: new DxfGeometrySummary({
      entityType: 'LWPOLYLINE',
      closed: input.closed ?? true,
      segments: [
        { kind: 'line', x1: 10, y1: 20, x2: 14, y2: 20 },
        { kind: 'line', x1: 14, y1: 20, x2: 14, y2: 23 },
        { kind: 'line', x1: 14, y1: 23, x2: 10, y2: 23 },
        { kind: 'line', x1: 10, y1: 23, x2: 10, y2: 20 }
      ]
    }),
    warnings: [...(input.warnings ?? [])]
  })
}

function zeroLengthDegeneratePiece(): ImportedPiece {
  return new ImportedPiece({
    id: PieceId.make('dump-degenerate-zero-length'),
    sourceFileId: SourceFileId.make('dump-collision-builder-source'),
    label: 'degenerate zero-length segment',
    realBounds: new Rect({ x: 0, y: 0, width: 1, height: 1 }),
    geometry: new DxfGeometrySummary({
      entityType: 'LINE',
      closed: true,
      segments: [{ kind: 'line', x1: 5, y1: 5, x2: 5, y2: 5 }]
    }),
    warnings: []
  })
}

function twoPointDegeneratePiece(): ImportedPiece {
  return new ImportedPiece({
    id: PieceId.make('dump-degenerate-two-point'),
    sourceFileId: SourceFileId.make('dump-collision-builder-source'),
    label: 'degenerate two-point segment',
    realBounds: new Rect({ x: 0, y: 0, width: 10, height: 1 }),
    geometry: new DxfGeometrySummary({
      entityType: 'LINE',
      closed: true,
      segments: [{ kind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 }]
    }),
    warnings: []
  })
}

// Coverage note: real-world fixture/mixed61 convex hulls in this case matrix
// never carry an interior angle sharper than ~55 degrees, so `inflatePaths`'s
// Miter-join path never exercises Clipper2's own miter-limit-exceeded
// fallback to a squared join (`ClipperOffset.doSquare`, reached from inside
// `offsetPoint`'s `JoinType.Miter` branch when `cosA <= mitLimSqr - 1`, i.e.
// interior angle below roughly 11 degrees for this adapter's fixed
// `miterLimit: 10`). This hand-authored sliver triangle (interior angle at
// the origin vertex is `2*atan(1/100)` ~= 1.15 degrees) forces that fallback
// so the Rust port's `do_square` branch has real production-shaped
// differential coverage, not just hand-verified ad hoc confirmation.
function sharpSliverTrianglePiece(): ImportedPiece {
  return new ImportedPiece({
    id: PieceId.make('dump-sharp-sliver-triangle'),
    sourceFileId: SourceFileId.make('dump-collision-builder-source'),
    label: 'sharp sliver triangle (forces Clipper2 miter-limit-exceeded squared join)',
    realBounds: new Rect({ x: 0, y: 0, width: 100, height: 2 }),
    geometry: new DxfGeometrySummary({
      entityType: 'LWPOLYLINE',
      closed: true,
      segments: [
        { kind: 'line', x1: 0, y1: 1, x2: 100, y2: 2 },
        { kind: 'line', x1: 100, y1: 2, x2: 100, y2: 0 },
        { kind: 'line', x1: 100, y1: 0, x2: 0, y2: 1 }
      ]
    }),
    warnings: []
  })
}

function circlePiece(): ImportedPiece {
  const arcs = [0, 90, 180, 270].map((startAngle) => {
    const endAngle = startAngle + 90
    const startRadians = (startAngle * Math.PI) / 180
    const endRadians = (endAngle * Math.PI) / 180
    return {
      kind: 'arc' as const,
      x1: 50 + Math.cos(startRadians) * 50,
      y1: 50 + Math.sin(startRadians) * 50,
      x2: 50 + Math.cos(endRadians) * 50,
      y2: 50 + Math.sin(endRadians) * 50,
      cx: 50,
      cy: 50,
      radius: 50,
      startAngle,
      endAngle
    }
  })
  return new ImportedPiece({
    id: PieceId.make('dump-offset-circle'),
    sourceFileId: SourceFileId.make('dump-circle-source'),
    label: 'Circle',
    realBounds: new Rect({ x: 0, y: 0, width: 100, height: 100 }),
    geometry: new DxfGeometrySummary({ entityType: 'CIRCLE', closed: true, segments: arcs }),
    warnings: []
  })
}

// ---------------------------------------------------------------------------
// Case matrix.
// ---------------------------------------------------------------------------
interface VectorCase {
  readonly caseLabel: string
  readonly pieceLabel: string
  readonly settingsLabel: string
  // Plain-JSON-safe re-embedding of the exact `ImportedPiece` this case fed
  // to `buildPiece` (round-tripped through `JSON.parse(JSON.stringify(...))`
  // to strip any `Schema.Class` instance-ness down to plain data), so the
  // Rust vector test can deserialize and replay this case's input directly
  // instead of independently reconstructing 61 fixture pieces, hand-authored
  // pieces, and two real-DXF-imported fixtures' worth of geometry by hand.
  // Field names/shape match `ImportedPiece`'s schema (camelCase) exactly,
  // which is also this crate's `domain::ImportedPiece` `Deserialize` shape.
  readonly piece: unknown
  readonly totalPaddingMm: string
  readonly sagToleranceMm: string
  readonly clearanceSafetyMarginMm: string
  readonly result: BuildResult
}

const cases: VectorCase[] = []

function addCase(
  caseLabel: string,
  pieceLabel: string,
  settingsLabel: string,
  piece: ImportedPiece,
  totalPaddingMm: number,
  sagToleranceMm: number,
  clearanceSafetyMarginMm: number
): void {
  const settings = geometrySettings(sagToleranceMm, clearanceSafetyMarginMm)
  const result = runBuildPiece(piece, totalPaddingMm, settings)
  cases.push({
    caseLabel,
    pieceLabel,
    settingsLabel,
    piece: JSON.parse(JSON.stringify(piece)) as unknown,
    totalPaddingMm: f64Bits(totalPaddingMm),
    sagToleranceMm: f64Bits(sagToleranceMm),
    clearanceSafetyMarginMm: f64Bits(clearanceSafetyMarginMm),
    result
  })
}

interface SettingsVariant {
  readonly label: string
  readonly totalPaddingMm: number
  readonly sagToleranceMm: number
  readonly clearanceSafetyMarginMm: number
}

// A deliberate padding/sag/margin matrix: production-representative defaults
// (sag=0.25, margin=0.25 -- `DEFAULT_IRREGULAR_GEOMETRY_SETTINGS`), tight and
// loose tolerances, zero padding, and a margin strictly greater than padding
// contribution to exercise `computeCollisionOffsetMm`'s addition broadly.
const settingsVariants: SettingsVariant[] = [
  { label: 'default-padding-0', totalPaddingMm: 0, sagToleranceMm: 0.25, clearanceSafetyMarginMm: 0.25 },
  { label: 'default-padding-2', totalPaddingMm: 2, sagToleranceMm: 0.25, clearanceSafetyMarginMm: 0.25 },
  { label: 'default-padding-10', totalPaddingMm: 10, sagToleranceMm: 0.25, clearanceSafetyMarginMm: 0.25 },
  { label: 'tight-sag-padding-2', totalPaddingMm: 2, sagToleranceMm: 0.01, clearanceSafetyMarginMm: 0.01 },
  { label: 'loose-sag-padding-5', totalPaddingMm: 5, sagToleranceMm: 2, clearanceSafetyMarginMm: 2 },
  { label: 'large-margin-padding-0', totalPaddingMm: 0, sagToleranceMm: 0.25, clearanceSafetyMarginMm: 5 }
]

// --- 1. All 61 mixed61 source pieces x the settings variant matrix. ---
for (const sourcePiece of loadMixed61SourcePieces()) {
  for (const variant of settingsVariants) {
    addCase(
      `mixed61:${sourcePiece.id}__${variant.label}`,
      `mixed61:${sourcePiece.id}`,
      variant.label,
      sourcePiece,
      variant.totalPaddingMm,
      variant.sagToleranceMm,
      variant.clearanceSafetyMarginMm
    )
  }
}

// --- 2. A hand-authored circle (ARC segments) x the same settings matrix. ---
for (const variant of settingsVariants) {
  addCase(
    `circle__${variant.label}`,
    'circle',
    variant.label,
    circlePiece(),
    variant.totalPaddingMm,
    variant.sagToleranceMm,
    variant.clearanceSafetyMarginMm
  )
}

// --- 2b. A sharp sliver triangle x the same settings matrix, forcing
//         Clipper2's Miter-limit-exceeded squared-join fallback (see
//         `sharpSliverTrianglePiece`'s doc comment). ---
for (const variant of settingsVariants) {
  addCase(
    `sharp-sliver-triangle__${variant.label}`,
    'sharp-sliver-triangle',
    variant.label,
    sharpSliverTrianglePiece(),
    variant.totalPaddingMm,
    variant.sagToleranceMm,
    variant.clearanceSafetyMarginMm
  )
}

// --- 3. A rectangle carrying an import warning, proving diagnostics order/content. ---
{
  const warning = new ImportWarning({
    code: 'source_note',
    message: 'The source outline was grouped from multiple DXF entities.'
  })
  const secondWarning = new ImportWarning({
    code: 'another_note',
    message: 'A second diagnostic to prove ordering is preserved.',
    entityType: 'LWPOLYLINE'
  })
  for (const variant of settingsVariants) {
    addCase(
      `rectangle-with-warnings__${variant.label}`,
      'rectangle-with-warnings',
      variant.label,
      rectanglePiece({ id: 'dump-warned-rectangle', warnings: [warning, secondWarning] }),
      variant.totalPaddingMm,
      variant.sagToleranceMm,
      variant.clearanceSafetyMarginMm
    )
  }
}

// --- 4. Real DXF fixtures with ARC/ELLIPSE source curves, imported through
//        the real production parser + importer (not hand-constructed). ---
async function addDxfFixtureCases(): Promise<void> {
  const dxfPaddingMm = [0, 3, 15]
  for (const fixtureName of ['circle-ellipse-arcs.dxf', 'rounded-rectangle.dxf']) {
    const path = join(DXF_FIXTURES_DIR, fixtureName)
    const document = await importDxfFile(path)
    for (const piece of document.pieces) {
      for (const totalPaddingMm of dxfPaddingMm) {
        addCase(
          `fixture:${fixtureName}:${piece.label}__padding${totalPaddingMm}`,
          `fixture:${fixtureName}:${piece.label}`,
          `padding${totalPaddingMm}`,
          piece,
          totalPaddingMm,
          0.25,
          0.25
        )
      }
    }
  }

  // A hand-authored-but-really-parsed LWPOLYLINE bulge piece, mirroring
  // `dump-flattening.ts`'s precedent for real-parser bulge coverage (no
  // fixture file under `tests/fixtures/dxf` carries a real bulge).
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
  const bulgeSquare = [
    pair(0, 'LWPOLYLINE'),
    pair(70, 1),
    pair(90, 4),
    pair(10, 0),
    pair(20, 0),
    pair(42, 1),
    pair(10, 20),
    pair(20, 0),
    pair(10, 20),
    pair(20, 20),
    pair(10, 0),
    pair(20, 20)
  ].join('')

  const directory = mkdtempSync(join(tmpdir(), 'min-plane-dfx-collision-builder-dump-'))
  try {
    const bulgePath = join(directory, 'bulge-square.dxf')
    writeFileSync(bulgePath, dxfText(bulgeSquare), 'utf8')
    const bulgeDoc = await importDxfFile(bulgePath)
    for (const piece of bulgeDoc.pieces) {
      for (const totalPaddingMm of dxfPaddingMm) {
        addCase(
          `fixture:real-parsed-bulge-square:${piece.label}__padding${totalPaddingMm}`,
          `fixture:real-parsed-bulge-square:${piece.label}`,
          `padding${totalPaddingMm}`,
          piece,
          totalPaddingMm,
          0.25,
          0.25
        )
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

await addDxfFixtureCases()

// --- 5. Degenerate/invalid inputs: expect exact error operations/messages. ---
{
  addCase(
    'invalid:open-path',
    'invalid:open-path',
    'default-padding-2',
    rectanglePiece({ id: 'dump-open-path', closed: false }),
    2,
    0.25,
    0.25
  )
  addCase(
    'invalid:zero-length-segment-hull',
    'invalid:zero-length-segment-hull',
    'default-padding-0',
    zeroLengthDegeneratePiece(),
    0,
    0.25,
    0.25
  )
  addCase(
    'invalid:two-point-collinear-hull',
    'invalid:two-point-collinear-hull',
    'default-padding-0',
    twoPointDegeneratePiece(),
    0,
    0.25,
    0.25
  )
  // Distance not representable on the Clipper2 integer grid at all
  // (`scaledAbsoluteValue` overflows `Number.MAX_SAFE_INTEGER` inside
  // `toGridMm`) -- a distinct error message from the coordinate-guard case
  // below.
  addCase(
    'invalid:distance-not-representable',
    'invalid:distance-not-representable',
    'huge-padding-1e13',
    rectanglePiece({ id: 'dump-huge-padding-1e13' }),
    2e13,
    0.25,
    0.25
  )
  // Distance representable on the grid, but coordinate-plus-headroom exceeds
  // the Clipper2 scaled-coordinate guard.
  addCase(
    'invalid:coordinate-guard-exceeded',
    'invalid:coordinate-guard-exceeded',
    'huge-padding-2e6',
    rectanglePiece({ id: 'dump-huge-padding-2e6' }),
    2_000_000,
    0.25,
    0.25
  )
}

// ---------------------------------------------------------------------------
// Sanity checks before writing.
// ---------------------------------------------------------------------------
if (cases.length < 300) {
  throw new Error(`Expected >= 300 collision-builder differential vectors, got ${cases.length}.`)
}
const okCases = cases.filter((c) => c.result.ok)
const failureCases = cases.filter((c) => !c.result.ok)
if (okCases.length < 250) {
  throw new Error(`Expected >= 250 successful buildPiece cases, got ${okCases.length}.`)
}
if (failureCases.length < 5) {
  throw new Error(`Expected >= 5 deliberately-invalid buildPiece cases, got ${failureCases.length}.`)
}
const distinctOperations = new Set(failureCases.map((c) => c.result.operation))
if (!distinctOperations.has('buildCollisionGeometry') || !distinctOperations.has('offsetConvexPolygon')) {
  throw new Error(
    `Expected failure cases to cover both 'buildCollisionGeometry' and 'offsetConvexPolygon' operations, got: ${[...distinctOperations].join(', ')}`
  )
}

// ---------------------------------------------------------------------------
// Write output.
// ---------------------------------------------------------------------------
mkdirSync(VECTORS_DIR, { recursive: true })
const commit = generatingCommit()

const output = {
  generatedByScript: 'scripts/rust-parity/dump-collision-builder.ts',
  generatingCommit: commit,
  description:
    'CollisionGeometryBuilder.buildPiece (CollisionGeometryBuilder.Live, composing the real ' +
    'GeometryKernel.Live: flattenSourceGeometry -> ArcFlattening/EllipseFlattening, convexHull, ' +
    'offsetConvexPolygon -> ConvexPolygonOffset.compute -> Clipper2OffsetAdapter.compute -> the ' +
    'pinned clipper2-ts@2.0.1-18 inflatePaths) over all 61 mixed61-request.json source pieces, a ' +
    'hand-authored circle (ARC segments), two real DXF fixtures with ARC/ELLIPSE source curves ' +
    '(circle-ellipse-arcs.dxf, rounded-rectangle.dxf) plus one real-parsed LWPOLYLINE bulge ' +
    'fixture, a padding/sag/clearance-margin settings matrix, an import-warning-diagnostics case, ' +
    'and degenerate/invalid inputs (open path, degenerate hulls, distance-not-representable, ' +
    'coordinate-guard-exceeded) with their exact IrregularGeometryInputError operation/message. ' +
    'f64 values are recorded as big-endian IEEE-754 bit-pattern hex strings for bit-exact comparison.',
  caseCount: cases.length,
  okCaseCount: okCases.length,
  failureCaseCount: failureCases.length,
  cases
}

writeFileSync(join(VECTORS_DIR, 'collision-builder.json'), JSON.stringify(output, null, 2) + '\n')

console.log(
  `Wrote ${cases.length} collision-builder vectors (${okCases.length} ok, ${failureCases.length} ` +
    `failures) (commit ${commit}) to ${VECTORS_DIR}`
)
