/**
 * Differential-vector generator for
 * `crates/irregular-nesting-native/src/capacity/{preflight,material,endpoint}.rs`.
 *
 * Per docs/planning/rust-irregular-backend/stage0-rulings.md R14: this script
 * imports the REAL production TS entry points --
 *   - `preflightIntrinsicCompleteCapacity` (`intrinsicCapacityPreflight.ts`),
 *     run through the real `GeometryKernel.Live`/`GeometrySettings.Live`
 *     layers via `Effect.runSyncExit`, for exact impossibility-proof
 *     verdicts and their bigint measurements,
 *   - `intrinsicCapacityMaterialAreas` (`intrinsicCapacityMaterial.ts`), for
 *     exact bigint per-piece material accounting and fail-fast
 *     first-invalid-piece reporting,
 *   - `materializeIntrinsicCapacityEndpoint` /
 *     `compareIntrinsicCapacityEndpoints` / `compareIntrinsicCapacityObjectives`
 *     (`intrinsicCapacityEndpoint.ts`), for real endpoint construction
 *     (canonical identity/hash via the real SHA-256 + canonical-grid
 *     pipeline) and the full 11-key comparator total order --
 * evaluates them over a deliberate sheet/piece matrix (including shapes
 * modeled on the production capacity gate's fixtures, `capacity-area-proven-
 * rect2`/`capacity-singleton-proven`/`capacity-archive-miss-squares2`,
 * `scripts/irregular-capacity-gate.ts:104-138`), and writes byte-exact JSON
 * vectors for the Rust ports (`capacity::preflight::preflight_intrinsic_complete_capacity`,
 * `capacity::material::intrinsic_capacity_material_areas`,
 * `capacity::endpoint::{materialize_intrinsic_capacity_endpoint,
 * compare_intrinsic_capacity_endpoints, compare_intrinsic_capacity_objectives}`)
 * to replay exactly.
 *
 * Run with:
 *   pnpm exec tsx --tsconfig tsconfig.node.json scripts/rust-parity/dump-capacity-core.ts
 *
 * Output (additive; never edits existing fixtures/tests):
 *   - crates/irregular-nesting-native/tests/vectors/capacity-core.json
 */
import { Effect } from 'effect'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DxfGeometrySummary, ImportedPiece } from '../../src/shared/domain/dxf.js'
import { Rect } from '../../src/shared/domain/geometry.js'
import { PieceId, SourceFileId } from '../../src/shared/domain/ids.js'
import { SheetSpec } from '../../src/shared/domain/nesting.js'
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
  TransformedCollisionGeometry
} from '../../src/shared/irregular/domain.js'
import {
  compareIntrinsicCapacityEndpoints,
  compareIntrinsicCapacityObjectives,
  intrinsicCapacityObjective,
  materializeIntrinsicCapacityEndpoint,
  type IntrinsicCapacityCavityCache,
  type IntrinsicCapacityEndpoint,
  type IntrinsicCapacityEndpointOrigin,
  type IntrinsicCapacityObjective
} from '../../src/workers/algorithm/irregular/intrinsicCapacityEndpoint.js'
import {
  intrinsicCapacityMaterialAreas,
  intrinsicCapacityPreparedPieceId
} from '../../src/workers/algorithm/irregular/intrinsicCapacityMaterial.js'
import { preflightIntrinsicCompleteCapacity } from '../../src/workers/algorithm/irregular/intrinsicCapacityPreflight.js'
import { IrregularBeamState } from '../../src/workers/algorithm/irregular/irregularBeamState.js'
import { GeometryKernel, GeometrySettings } from '../../src/workers/irregular/geometryKernel.js'
import { NfpIfpServiceLive } from '../../src/workers/irregular/nfpIfpService.js'
import type { NfpIfpService } from '../../src/workers/irregular/services.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..', '..')
const VECTORS_DIR = join(REPO_ROOT, 'crates', 'irregular-nesting-native', 'tests', 'vectors')

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
// `dump-convex.ts` / `dump-transforms.ts` / `dump-validation.ts`.
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
// Piece / geometry builders (mirrors tests/unit/intrinsicCapacityMode.test.ts's
// own fixture builders, which are this cluster's own regression-tested
// vocabulary).
// ---------------------------------------------------------------------------
function point(x: number, y: number): IrregularPoint {
  return new IrregularPoint({ x, y })
}

function rectanglePoints(width: number, height: number): ReadonlyArray<IrregularPoint> {
  return [point(0, 0), point(width, 0), point(width, height), point(0, height)]
}

function bounds(points: ReadonlyArray<IrregularPoint>): IrregularBounds {
  return new IrregularBounds({
    minX: Math.min(...points.map(({ x }) => x)),
    minY: Math.min(...points.map(({ y }) => y)),
    maxX: Math.max(...points.map(({ x }) => x)),
    maxY: Math.max(...points.map(({ y }) => y))
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

function transform(index: number, rotationDeg: number): IrregularTransformCandidate {
  return new IrregularTransformCandidate({
    index,
    rotationDeg,
    mirrored: false,
    reason: 'configured'
  })
}

function preparedRectangle(
  id: string,
  width: number,
  height: number,
  transforms: ReadonlyArray<IrregularTransformCandidate> = [transform(0, 0)]
): IrregularPreparedPiece {
  const points = rectanglePoints(width, height)
  const shape = new IrregularPolygon({ points })
  return new IrregularPreparedPiece({
    pieceId: PieceId.make(id),
    source: sourcePiece(id),
    allowMirror: false,
    collisionGeometry: new CollisionGeometry({
      sourcePieceId: PieceId.make(id),
      sourceBounds: bounds(points),
      sampledPoints: points,
      convexHull: shape,
      collisionPolygon: shape,
      placementReference: point(0, 0),
      diagnostics: []
    }),
    transforms
  })
}

function preparedRectangleWithMaterialHull(
  id: string,
  collisionWidth: number,
  collisionHeight: number,
  materialWidth: number,
  materialHeight: number
): IrregularPreparedPiece {
  const prepared = preparedRectangle(id, collisionWidth, collisionHeight)
  const materialPoints = rectanglePoints(materialWidth, materialHeight)
  return new IrregularPreparedPiece({
    ...prepared,
    collisionGeometry: new CollisionGeometry({
      ...prepared.collisionGeometry,
      convexHull: new IrregularPolygon({ points: materialPoints })
    })
  })
}

function sheet(width: number, height: number): SheetSpec {
  return new SheetSpec({ width, height, label: `${width}x${height}` })
}

function placedRectangle(
  piece: IrregularPreparedPiece,
  translateX: number,
  translateY: number
): IrregularPlacedPiece {
  const geometry = piece.collisionGeometry
  const pieceTransform = piece.transforms[0]
  if (pieceTransform === undefined) throw new Error('test piece must have one transform')
  return new IrregularPlacedPiece({
    placement: new IrregularPlacement({
      sourcePieceId: piece.source.id,
      ...(piece.pieceId === undefined ? {} : { pieceId: piece.pieceId }),
      transform: new IrregularTransform({
        translateX,
        translateY,
        rotationDeg: pieceTransform.rotationDeg,
        mirrored: pieceTransform.mirrored
      })
    }),
    collisionGeometry: new TransformedCollisionGeometry({
      sourcePieceId: piece.source.id,
      transform: pieceTransform,
      polygon: geometry.collisionPolygon,
      bounds: bounds(geometry.collisionPolygon.points)
    })
  })
}

function provideGeometry<A, E>(
  effect: Effect.Effect<A, E, GeometryKernel | GeometrySettings | NfpIfpService>
): A {
  const exit = Effect.runSyncExit(
    effect.pipe(
      Effect.provide(GeometryKernel.Live),
      Effect.provide(GeometrySettings.Live),
      Effect.provide(NfpIfpServiceLive)
    )
  )
  if (exit._tag === 'Failure') {
    throw new Error(`effect failed: ${JSON.stringify(exit.cause)}`)
  }
  return exit.value
}

// ---------------------------------------------------------------------------
// Encoding helpers.
// ---------------------------------------------------------------------------
function encodePieceForPreflight(piece: IrregularPreparedPiece): unknown {
  return {
    id: intrinsicCapacityPreparedPieceId(piece),
    width: f64Bits(piece.collisionGeometry.collisionPolygon.points[2]?.x ?? 0),
    height: f64Bits(piece.collisionGeometry.collisionPolygon.points[2]?.y ?? 0),
    materialWidth: f64Bits(piece.collisionGeometry.convexHull.points[2]?.x ?? 0),
    materialHeight: f64Bits(piece.collisionGeometry.convexHull.points[2]?.y ?? 0),
    transforms: piece.transforms.map((t) => ({
      index: f64Bits(t.index),
      rotationDeg: f64Bits(t.rotationDeg),
      mirrored: t.mirrored
    }))
  }
}

function encodeMeasurements(measurements: {
  readonly pieceCount: number
  readonly sheetWidthGrid: number
  readonly sheetHeightGrid: number
  readonly sheetDoubledAreaGrid2: bigint
  readonly minimumDoubledCollisionAreaSumGrid2: bigint
  readonly minimumCollisionAreaPressurePpm: bigint
  readonly maximumSingletonSpanPressurePpm: bigint
  readonly singletonInfeasiblePieceIds: ReadonlyArray<string>
}): unknown {
  return {
    pieceCount: f64Bits(measurements.pieceCount),
    sheetWidthGrid: f64Bits(measurements.sheetWidthGrid),
    sheetHeightGrid: f64Bits(measurements.sheetHeightGrid),
    sheetDoubledAreaGrid2: measurements.sheetDoubledAreaGrid2.toString(),
    minimumDoubledCollisionAreaSumGrid2: measurements.minimumDoubledCollisionAreaSumGrid2.toString(),
    minimumCollisionAreaPressurePpm: measurements.minimumCollisionAreaPressurePpm.toString(),
    maximumSingletonSpanPressurePpm: measurements.maximumSingletonSpanPressurePpm.toString(),
    singletonInfeasiblePieceIds: [...measurements.singletonInfeasiblePieceIds]
  }
}

function encodeSheet(s: SheetSpec): unknown {
  return { width: f64Bits(s.width), height: f64Bits(s.height), label: s.label }
}

// ---------------------------------------------------------------------------
// Preflight vectors.
// ---------------------------------------------------------------------------
interface PreflightVector {
  readonly description: string
  readonly sheet: unknown
  readonly pieces: ReadonlyArray<unknown>
  readonly outcome: unknown
}

function runPreflightVector(
  description: string,
  finalSheet: SheetSpec,
  pieces: ReadonlyArray<IrregularPreparedPiece>
): PreflightVector {
  const outcome = provideGeometry(preflightIntrinsicCompleteCapacity(finalSheet, pieces))
  const encodedOutcome =
    outcome.kind === 'proven_impossible'
      ? outcome.reason === 'singleton-transform-set-does-not-fit'
        ? {
            kind: 'proven_impossible',
            reason: outcome.reason,
            pieceId: outcome.pieceId,
            measurements: encodeMeasurements(outcome.measurements)
          }
        : {
            kind: 'proven_impossible',
            reason: outcome.reason,
            measurements: encodeMeasurements(outcome.measurements)
          }
      : { kind: 'inconclusive', measurements: encodeMeasurements(outcome.measurements) }
  return {
    description,
    sheet: encodeSheet(finalSheet),
    pieces: pieces.map(encodePieceForPreflight),
    outcome: encodedOutcome
  }
}

function generatePreflightVectors(): ReadonlyArray<PreflightVector> {
  const vectors: PreflightVector[] = []

  // Gate-fixture-shaped anchors (scripts/irregular-capacity-gate.ts:104-138).
  vectors.push(
    runPreflightVector('gate: capacity-area-proven-rect2 shape', sheet(100, 100), [
      preparedRectangle('rect-0', 100, 80),
      preparedRectangle('rect-1', 100, 80)
    ])
  )
  vectors.push(
    runPreflightVector('gate: capacity-singleton-proven shape', sheet(100, 100), [
      preparedRectangle('fits', 90, 20),
      preparedRectangle('never-fits', 150, 20, [transform(0, 0), transform(1, 90)])
    ])
  )
  vectors.push(
    runPreflightVector('gate: capacity-archive-miss-squares2 shape', sheet(100, 100), [
      preparedRectangle('square2-0', 55, 55),
      preparedRectangle('square2-1', 55, 55)
    ])
  )

  // Matrix A: exact area-proof sweep across sheet size x piece side x count.
  const sheetSizesA = [80, 100, 120]
  const sidesA = [20, 30, 40, 50, 60]
  const countsA = [1, 2, 3, 4, 5]
  for (const sheetSize of sheetSizesA) {
    for (const side of sidesA) {
      for (const count of countsA) {
        const pieces = Array.from({ length: count }, (_, index) =>
          preparedRectangle(`area-${sheetSize}-${side}-${count}-${index}`, side, side)
        )
        vectors.push(
          runPreflightVector(
            `area sweep: sheet=${sheetSize} side=${side} count=${count}`,
            sheet(sheetSize, sheetSize),
            pieces
          )
        )
      }
    }
  }

  // Matrix B: singleton q0/q90 fit sweep, fixed 100x100 sheet, one piece
  // that always fits plus one piece whose dimensions vary.
  const widthsB = [80, 90, 100, 110, 120, 150, 200]
  const heightsB = [10, 20, 50, 80, 100, 120]
  for (const width of widthsB) {
    for (const height of heightsB) {
      const pieces = [
        preparedRectangle('anchor', 90, 20),
        preparedRectangle('varying', width, height, [transform(0, 0), transform(1, 90)])
      ]
      vectors.push(
        runPreflightVector(`singleton sweep: width=${width} height=${height}`, sheet(100, 100), pieces)
      )
    }
  }

  // Matrix C: mixed multi-piece deterministic sweep across sheet sizes and
  // piece counts, transforms alternating single/dual per piece index.
  const sheetsC: ReadonlyArray<readonly [number, number]> = [
    [100, 100],
    [200, 150],
    [500, 500],
    [2000, 2700]
  ]
  for (const [sheetWidth, sheetHeight] of sheetsC) {
    for (let count = 1; count <= 8; count += 1) {
      const pieces = Array.from({ length: count }, (_, index) => {
        const width = 20 + ((index * 13) % 40)
        const height = 15 + ((index * 7) % 35)
        const transforms = index % 2 === 0 ? [transform(0, 0)] : [transform(0, 0), transform(1, 90)]
        return preparedRectangle(`mixed-${sheetWidth}x${sheetHeight}-${count}-${index}`, width, height, transforms)
      })
      vectors.push(
        runPreflightVector(
          `mixed sweep: sheet=${sheetWidth}x${sheetHeight} count=${count}`,
          sheet(sheetWidth, sheetHeight),
          pieces
        )
      )
    }
  }

  // Matrix D: seeded-random dimension sweep for additional coverage,
  // deterministic across regenerations (mulberry32 seed 1337).
  const random = mulberry32(1337)
  for (let index = 0; index < 40; index += 1) {
    const sheetSize = 80 + Math.floor(random() * 200)
    const count = 1 + Math.floor(random() * 5)
    const pieces = Array.from({ length: count }, (_, pieceIndex) => {
      const width = 10 + Math.floor(random() * 150)
      const height = 10 + Math.floor(random() * 150)
      const useTwoTransforms = random() > 0.5
      const transforms = useTwoTransforms ? [transform(0, 0), transform(1, 90)] : [transform(0, 0)]
      return preparedRectangle(`random-${index}-${pieceIndex}`, width, height, transforms)
    })
    vectors.push(runPreflightVector(`random sweep #${index}`, sheet(sheetSize, sheetSize), pieces))
  }

  return vectors
}

// ---------------------------------------------------------------------------
// Material vectors.
// ---------------------------------------------------------------------------
interface MaterialVector {
  readonly description: string
  readonly pieces: ReadonlyArray<unknown>
  readonly result: unknown
}

function encodePieceForMaterial(piece: IrregularPreparedPiece): unknown {
  return {
    id: intrinsicCapacityPreparedPieceId(piece),
    materialPoints: piece.collisionGeometry.convexHull.points.map((p) => ({
      x: f64Bits(p.x),
      y: f64Bits(p.y)
    }))
  }
}

function runMaterialVector(description: string, pieces: ReadonlyArray<IrregularPreparedPiece>): MaterialVector {
  const materials = intrinsicCapacityMaterialAreas(pieces)
  const result =
    materials.kind === 'complete'
      ? {
          kind: 'complete',
          areas: [...materials.areasByPieceId.entries()].map(([id, area]) => [id, area.toString()])
        }
      : { kind: 'invalid', pieceId: materials.pieceId }
  return { description, pieces: pieces.map(encodePieceForMaterial), result }
}

function generateMaterialVectors(): ReadonlyArray<MaterialVector> {
  const vectors: MaterialVector[] = []

  // Sweep of valid rectangles, varying side and count.
  const sidesA = [10, 20, 33, 50, 75, 100, 150, 250]
  const countsA = [1, 2, 3, 5]
  for (const side of sidesA) {
    for (const count of countsA) {
      const pieces = Array.from({ length: count }, (_, index) =>
        preparedRectangle(`mat-${side}-${count}-${index}`, side, side + index)
      )
      vectors.push(runMaterialVector(`valid sweep: side=${side} count=${count}`, pieces))
    }
  }

  // Material-hull-differs-from-collision-polygon vectors.
  for (const [collisionSide, materialSide] of [
    [60, 40],
    [60, 60],
    [80, 79],
    [100, 30]
  ] as const) {
    vectors.push(
      runMaterialVector(`material hull differs: collision=${collisionSide} material=${materialSide}`, [
        preparedRectangleWithMaterialHull('hull-piece', collisionSide, collisionSide, materialSide, materialSide)
      ])
    )
  }

  // Degenerate / invalid pieces (fewer than 3 effective vertices, or a
  // collinear/zero-area hull).
  const degenerateHull = new IrregularPolygon({ points: [point(0, 0), point(10, 0)] })
  const degenerate = new IrregularPreparedPiece({
    ...preparedRectangle('degenerate', 10, 10),
    collisionGeometry: new CollisionGeometry({
      ...preparedRectangle('degenerate', 10, 10).collisionGeometry,
      convexHull: degenerateHull
    })
  })
  vectors.push(runMaterialVector('degenerate hull (too few points)', [degenerate]))
  vectors.push(
    runMaterialVector('degenerate hull mixed with a valid piece', [preparedRectangle('valid', 20, 20), degenerate])
  )
  vectors.push(
    runMaterialVector('degenerate hull is first, later piece never reported', [
      degenerate,
      preparedRectangle('valid-after', 20, 20)
    ])
  )

  // Duplicate ids.
  vectors.push(
    runMaterialVector('duplicate ids report the duplicate as invalid', [
      preparedRectangle('dup', 10, 10),
      preparedRectangle('dup', 20, 20)
    ])
  )
  vectors.push(
    runMaterialVector('duplicate id after two valid pieces', [
      preparedRectangle('first', 10, 10),
      preparedRectangle('second', 20, 20),
      preparedRectangle('first', 30, 30)
    ])
  )

  // Empty piece list.
  vectors.push(runMaterialVector('empty piece list', []))

  // Seeded-random sweep.
  const random = mulberry32(4242)
  for (let index = 0; index < 30; index += 1) {
    const count = 1 + Math.floor(random() * 6)
    const pieces = Array.from({ length: count }, (_, pieceIndex) => {
      const side = 5 + Math.floor(random() * 300)
      return preparedRectangle(`random-mat-${index}-${pieceIndex}`, side, side + pieceIndex + 1)
    })
    vectors.push(runMaterialVector(`random material sweep #${index}`, pieces))
  }

  return vectors
}

// ---------------------------------------------------------------------------
// Endpoint construction vectors.
// ---------------------------------------------------------------------------
interface EndpointVector {
  readonly description: string
  readonly sheet: unknown
  readonly placed: ReadonlyArray<unknown>
  readonly unplacedPreparedIds: ReadonlyArray<PieceId>
  readonly origin: string
  /** Input `sourceRole`, mirrored (not just the output's echoed field). */
  readonly sourceRole: string | null
  /** Input `prefixDepth`, mirrored (not just the output's echoed field). */
  readonly prefixDepth: unknown
  readonly materials: ReadonlyArray<readonly [string, string]>
  readonly result: unknown
}

function encodeEndpoint(endpoint: IntrinsicCapacityEndpoint | undefined): unknown {
  if (endpoint === undefined) return { kind: 'undefined' }
  return {
    kind: 'endpoint',
    origin: endpoint.origin,
    sourceRole: endpoint.sourceRole ?? null,
    prefixDepth: endpoint.prefixDepth === undefined ? null : f64Bits(endpoint.prefixDepth),
    placedPreparedIds: [...endpoint.placedPreparedIds],
    unplacedPreparedIds: [...endpoint.unplacedPreparedIds],
    selectedRotationDeg: f64Bits(endpoint.selectedRotationDeg),
    canonicalGeometryIdentity: endpoint.canonicalGeometryIdentity,
    canonicalGeometryHash: endpoint.canonicalGeometryHash,
    metrics: {
      placedCount: f64Bits(endpoint.metrics.placedCount),
      placedDoubledMaterialAreaGrid2: endpoint.metrics.placedDoubledMaterialAreaGrid2.toString(),
      placedMaterialAreaMm2: f64Bits(endpoint.metrics.placedMaterialAreaMm2),
      enclosedCavityCount: f64Bits(endpoint.metrics.enclosedCavityCount),
      totalEnclosedCavityAreaMm2: f64Bits(endpoint.metrics.totalEnclosedCavityAreaMm2),
      totalEnclosedCavityDoubledAreaGrid2: endpoint.metrics.totalEnclosedCavityDoubledAreaGrid2,
      envelopeMaximumSideMm: f64Bits(endpoint.metrics.envelopeMaximumSideMm),
      envelopeAreaMm2: f64Bits(endpoint.metrics.envelopeAreaMm2),
      envelopeSpanMm: f64Bits(endpoint.metrics.envelopeSpanMm),
      envelopeMaximumSideGrid: f64Bits(endpoint.metrics.envelopeMaximumSideGrid),
      envelopeAreaGrid2: endpoint.metrics.envelopeAreaGrid2,
      envelopeSpanGrid: f64Bits(endpoint.metrics.envelopeSpanGrid)
    }
  }
}

function runEndpointVector(
  description: string,
  finalSheet: SheetSpec,
  placedPieces: ReadonlyArray<readonly [IrregularPreparedPiece, number, number]>,
  unplacedPreparedIds: ReadonlyArray<PieceId>,
  origin: IntrinsicCapacityEndpointOrigin,
  sourceRole?: string,
  prefixDepth?: number
): EndpointVector {
  const placedGeometries = placedPieces.map(([piece, x, y]) => placedRectangle(piece, x, y))
  const placementOrder = placedPieces.map(([piece]) => intrinsicCapacityPreparedPieceId(piece))
  const state = new IrregularBeamState({
    remainingPreparedPieces: [],
    placedCollisionGeometries: placedGeometries,
    placementOrder
  })
  const materialsByPieceId = new Map<PieceId, bigint>()
  for (const [piece] of placedPieces) {
    const areas = intrinsicCapacityMaterialAreas([piece])
    if (areas.kind === 'complete') {
      const area = areas.areasByPieceId.get(intrinsicCapacityPreparedPieceId(piece))
      if (area !== undefined) materialsByPieceId.set(intrinsicCapacityPreparedPieceId(piece), area)
    }
  }
  const cavityCache: IntrinsicCapacityCavityCache = new Map()
  const endpoint = materializeIntrinsicCapacityEndpoint({
    sheet: finalSheet,
    state,
    unplacedPreparedIds,
    origin,
    ...(sourceRole === undefined ? {} : { sourceRole }),
    ...(prefixDepth === undefined ? {} : { prefixDepth }),
    materialAreasByPieceId: materialsByPieceId,
    cavityCache
  })
  return {
    description,
    sheet: encodeSheet(finalSheet),
    placed: placedPieces.map(([piece, x, y]) => ({
      id: intrinsicCapacityPreparedPieceId(piece),
      x: f64Bits(x),
      y: f64Bits(y),
      width: f64Bits(piece.collisionGeometry.collisionPolygon.points[2]?.x ?? 0),
      height: f64Bits(piece.collisionGeometry.collisionPolygon.points[2]?.y ?? 0)
    })),
    unplacedPreparedIds,
    origin,
    sourceRole: sourceRole ?? null,
    prefixDepth: prefixDepth === undefined ? null : f64Bits(prefixDepth),
    materials: [...materialsByPieceId.entries()].map(([id, area]) => [id, area.toString()] as const),
    result: encodeEndpoint(endpoint)
  }
}

function generateEndpointVectors(): ReadonlyArray<EndpointVector> {
  const vectors: EndpointVector[] = []

  vectors.push(runEndpointVector('empty state', sheet(200, 200), [], [], 'cold-search'))
  vectors.push(
    runEndpointVector(
      'empty state with unplaced ids and warm-prefix-continuation origin',
      sheet(200, 200),
      [],
      [PieceId.make('a'), PieceId.make('b')],
      'warm-prefix-continuation'
    )
  )

  const single = preparedRectangle('solo', 50, 40)
  vectors.push(runEndpointVector('single placed piece', sheet(200, 200), [[single, 0, 0]], [], 'cold-search'))

  const twoA = preparedRectangle('two-a', 40, 30)
  const twoB = preparedRectangle('two-b', 40, 30)
  vectors.push(
    runEndpointVector('two adjacent pieces, no gap', sheet(200, 200), [
      [twoA, 0, 0],
      [twoB, 40, 0]
    ], [], 'cold-search')
  )
  vectors.push(
    runEndpointVector('two pieces with a gap between them', sheet(200, 200), [
      [twoA, 0, 0],
      [twoB, 100, 0]
    ], [], 'cold-search')
  )

  // Overlapping pieces -> illegal on the canonical grid (both q0/q90 reject).
  vectors.push(
    runEndpointVector('overlapping pieces are illegal', sheet(200, 200), [
      [twoA, 0, 0],
      [twoB, 10, 0]
    ], [], 'cold-search')
  )

  // Off-sheet placement -> illegal.
  vectors.push(
    runEndpointVector('placement exceeding the sheet bounds is illegal', sheet(50, 50), [[single, 0, 0]], [], 'cold-search')
  )

  // Missing material area for a placed piece id -> undefined endpoint.
  {
    const piece = preparedRectangle('missing-material', 20, 20)
    const placedGeometries = [placedRectangle(piece, 0, 0)]
    const state = new IrregularBeamState({
      remainingPreparedPieces: [],
      placedCollisionGeometries: placedGeometries,
      placementOrder: [intrinsicCapacityPreparedPieceId(piece)]
    })
    const cavityCache: IntrinsicCapacityCavityCache = new Map()
    const endpoint = materializeIntrinsicCapacityEndpoint({
      sheet: sheet(200, 200),
      state,
      unplacedPreparedIds: [],
      origin: 'cold-search',
      materialAreasByPieceId: new Map(),
      cavityCache
    })
    vectors.push({
      description: 'missing material area produces an undefined endpoint',
      sheet: encodeSheet(sheet(200, 200)),
      placed: [
        {
          id: intrinsicCapacityPreparedPieceId(piece),
          x: f64Bits(0),
          y: f64Bits(0),
          width: f64Bits(20),
          height: f64Bits(20)
        }
      ],
      unplacedPreparedIds: [],
      origin: 'cold-search',
      sourceRole: null,
      prefixDepth: null,
      materials: [],
      result: encodeEndpoint(endpoint)
    })
  }

  // Enclosed cavity: a ring of pieces around an empty interior square.
  {
    const ringPieces: Array<readonly [IrregularPreparedPiece, number, number]> = [
      [preparedRectangle('ring-bottom', 90, 30), 0, 0],
      [preparedRectangle('ring-top', 90, 30), 0, 60],
      [preparedRectangle('ring-left', 30, 30), 0, 30],
      [preparedRectangle('ring-right', 30, 30), 60, 30]
    ]
    vectors.push(runEndpointVector('ring of pieces enclosing a cavity', sheet(300, 300), ringPieces, [], 'cold-search'))
  }

  // Origin/sourceRole/prefixDepth propagation for prefix-incumbent.
  {
    const piece = preparedRectangle('prefix-piece', 30, 30)
    vectors.push(
      runEndpointVector(
        'prefix-incumbent origin carries sourceRole/prefixDepth',
        sheet(200, 200),
        [[piece, 0, 0]],
        [],
        'prefix-incumbent',
        'canonical-grid',
        3
      )
    )
  }

  // Seeded-random non-overlapping grid layouts.
  const random = mulberry32(9001)
  for (let index = 0; index < 25; index += 1) {
    const count = 1 + Math.floor(random() * 4)
    const cellSize = 60
    const placedPieces: Array<readonly [IrregularPreparedPiece, number, number]> = Array.from(
      { length: count },
      (_, pieceIndex) => {
        const side = 20 + Math.floor(random() * 30)
        const piece = preparedRectangle(`random-endpoint-${index}-${pieceIndex}`, side, side)
        const column = pieceIndex % 3
        const row = Math.floor(pieceIndex / 3)
        return [piece, column * cellSize, row * cellSize] as const
      }
    )
    vectors.push(
      runEndpointVector(`random non-overlapping layout #${index}`, sheet(400, 400), placedPieces, [], 'cold-search')
    )
  }

  return vectors
}

// ---------------------------------------------------------------------------
// Comparator vectors: pairs of `IntrinsicCapacityObjective`-shaped values
// evaluated through the real `compareIntrinsicCapacityObjectives`.
// ---------------------------------------------------------------------------
interface ComparatorVector {
  readonly description: string
  readonly first: unknown
  readonly second: unknown
  readonly sign: number
}

function baseObjective(): IntrinsicCapacityObjective {
  return {
    placedCount: 5,
    placedDoubledMaterialAreaGrid2: 1_000n,
    enclosedCavityCount: 0,
    totalEnclosedCavityAreaMm2: 0,
    totalEnclosedCavityDoubledAreaGrid2: '0',
    envelopeMaximumSideMm: 100,
    envelopeAreaMm2: 5_000,
    envelopeSpanMm: 150,
    envelopeMaximumSideGrid: 100_000,
    envelopeAreaGrid2: '5000000000',
    envelopeSpanGrid: 150_000,
    canonicalGeometryHash: 'aaaaaaaa',
    origin: 'cold-search',
    prefixDepth: undefined,
    sourceRole: undefined
  }
}

function encodeObjective(objective: IntrinsicCapacityObjective): unknown {
  return {
    placedCount: f64Bits(objective.placedCount),
    placedDoubledMaterialAreaGrid2: objective.placedDoubledMaterialAreaGrid2.toString(),
    enclosedCavityCount: f64Bits(objective.enclosedCavityCount),
    totalEnclosedCavityAreaMm2: f64Bits(objective.totalEnclosedCavityAreaMm2),
    totalEnclosedCavityDoubledAreaGrid2: objective.totalEnclosedCavityDoubledAreaGrid2,
    envelopeMaximumSideMm: f64Bits(objective.envelopeMaximumSideMm),
    envelopeAreaMm2: f64Bits(objective.envelopeAreaMm2),
    envelopeSpanMm: f64Bits(objective.envelopeSpanMm),
    envelopeMaximumSideGrid: f64Bits(objective.envelopeMaximumSideGrid),
    envelopeAreaGrid2: objective.envelopeAreaGrid2,
    envelopeSpanGrid: f64Bits(objective.envelopeSpanGrid),
    canonicalGeometryHash: objective.canonicalGeometryHash,
    origin: objective.origin,
    prefixDepth: objective.prefixDepth === undefined ? null : f64Bits(objective.prefixDepth),
    sourceRole: objective.sourceRole ?? null
  }
}

function runComparatorVector(
  description: string,
  first: IntrinsicCapacityObjective,
  second: IntrinsicCapacityObjective
): ComparatorVector {
  const raw = compareIntrinsicCapacityObjectives(first, second)
  const sign = raw === 0 ? 0 : raw < 0 ? -1 : 1
  return { description, first: encodeObjective(first), second: encodeObjective(second), sign }
}

function generateComparatorVectors(): ReadonlyArray<ComparatorVector> {
  const vectors: ComparatorVector[] = []
  const base = baseObjective()

  // Key 1: placedCount, descending.
  for (const [a, b] of [
    [5, 4],
    [4, 5],
    [5, 5],
    [10, 1],
    [1, 10]
  ] as const) {
    vectors.push(
      runComparatorVector(`key1 placedCount ${a} vs ${b}`, { ...base, placedCount: a }, { ...base, placedCount: b })
    )
  }

  // Key 2: placedDoubledMaterialAreaGrid2, descending, bigint.
  for (const [a, b] of [
    [2000n, 1000n],
    [1000n, 2000n],
    [1000n, 1000n],
    [0n, 999999999999n]
  ] as const) {
    vectors.push(
      runComparatorVector(
        `key2 material area ${a} vs ${b}`,
        { ...base, placedDoubledMaterialAreaGrid2: a },
        { ...base, placedDoubledMaterialAreaGrid2: b }
      )
    )
  }

  // Key 3: enclosedCavityCount, ascending.
  for (const [a, b] of [
    [0, 1],
    [1, 0],
    [2, 2],
    [5, 3]
  ] as const) {
    vectors.push(
      runComparatorVector(
        `key3 cavity count ${a} vs ${b}`,
        { ...base, enclosedCavityCount: a },
        { ...base, enclosedCavityCount: b }
      )
    )
  }

  // Key 4: totalEnclosedCavityDoubledAreaGrid2, ascending, string bigint round trip.
  for (const [a, b] of [
    ['100', '200'],
    ['200', '100'],
    ['0', '0'],
    ['999999999999999999', '1']
  ] as const) {
    vectors.push(
      runComparatorVector(
        `key4 cavity area string ${a} vs ${b}`,
        { ...base, totalEnclosedCavityDoubledAreaGrid2: a },
        { ...base, totalEnclosedCavityDoubledAreaGrid2: b }
      )
    )
  }

  // Key 5: envelopeMaximumSideGrid, ascending -- including the
  // near-coordinate-limit case pinned by the existing TS unit test
  // (`compareIntrinsicCapacityEnvelopeAreas`'s sibling comparator).
  for (const [a, b] of [
    [100_000, 200_000],
    [200_000, 100_000],
    [999_999_999, 999_999_998]
  ] as const) {
    vectors.push(
      runComparatorVector(
        `key5 envelope max side grid ${a} vs ${b}`,
        { ...base, envelopeMaximumSideGrid: a },
        { ...base, envelopeMaximumSideGrid: b }
      )
    )
  }

  // Key 6: envelopeAreaGrid2, ascending, string bigint round trip.
  for (const [a, b] of [
    ['5000000000', '6000000000'],
    ['6000000000', '5000000000'],
    ['0', '1']
  ] as const) {
    vectors.push(
      runComparatorVector(
        `key6 envelope area string ${a} vs ${b}`,
        { ...base, envelopeAreaGrid2: a },
        { ...base, envelopeAreaGrid2: b }
      )
    )
  }

  // Key 7: envelopeSpanGrid, ascending.
  for (const [a, b] of [
    [150_000, 160_000],
    [160_000, 150_000]
  ] as const) {
    vectors.push(
      runComparatorVector(
        `key7 envelope span grid ${a} vs ${b}`,
        { ...base, envelopeSpanGrid: a },
        { ...base, envelopeSpanGrid: b }
      )
    )
  }

  // Key 8: canonicalGeometryHash, ascending, localeCompare (ASCII hex digests).
  for (const [a, b] of [
    ['aaaa', 'bbbb'],
    ['bbbb', 'aaaa'],
    ['0000', 'ffff'],
    ['1234abcd', '1234abce']
  ] as const) {
    vectors.push(
      runComparatorVector(
        `key8 hash ${a} vs ${b}`,
        { ...base, canonicalGeometryHash: a },
        { ...base, canonicalGeometryHash: b }
      )
    )
  }

  // Key 9: origin rank -- cold-search (0) before prefix-incumbent/warm-prefix-continuation (1).
  for (const [a, b] of [
    ['cold-search', 'prefix-incumbent'],
    ['prefix-incumbent', 'cold-search'],
    ['prefix-incumbent', 'warm-prefix-continuation'],
    ['warm-prefix-continuation', 'prefix-incumbent'],
    ['cold-search', 'cold-search']
  ] as const) {
    vectors.push(
      runComparatorVector(`key9 origin ${a} vs ${b}`, { ...base, origin: a }, { ...base, origin: b })
    )
  }

  // Key 10: prefixDepth, ascending, missing treated as -1.
  for (const [a, b] of [
    [undefined, 0],
    [0, undefined],
    [1, 2],
    [2, 1],
    [undefined, undefined]
  ] as const) {
    vectors.push(
      runComparatorVector(`key10 prefixDepth ${a} vs ${b}`, { ...base, prefixDepth: a }, { ...base, prefixDepth: b })
    )
  }

  // Key 11: sourceRole, ascending, missing treated as ''.
  for (const [a, b] of [
    [undefined, 'canonical-grid'],
    ['canonical-grid', undefined],
    ['canonical-grid', 'open-pocket-first'],
    ['open-pocket-first', 'canonical-grid'],
    [undefined, undefined]
  ] as const) {
    vectors.push(
      runComparatorVector(`key11 sourceRole ${a} vs ${b}`, { ...base, sourceRole: a }, { ...base, sourceRole: b })
    )
  }

  // Full ties (every key equal): objectives are indistinguishable.
  vectors.push(runComparatorVector('full tie', base, { ...base }))

  // Combined multi-key tie chains: differ only at the Nth key, all prior
  // keys tied, to pin exact fallthrough behavior of the `||`-chain port.
  const tieChainBase: IntrinsicCapacityObjective = {
    ...base,
    placedCount: 3,
    placedDoubledMaterialAreaGrid2: 500n,
    enclosedCavityCount: 1,
    totalEnclosedCavityDoubledAreaGrid2: '10',
    envelopeMaximumSideGrid: 50_000,
    envelopeAreaGrid2: '2500000000',
    envelopeSpanGrid: 75_000,
    canonicalGeometryHash: 'same-hash',
    origin: 'prefix-incumbent',
    prefixDepth: 4,
    sourceRole: 'canonical-grid'
  }
  vectors.push(runComparatorVector('tie chain: identical through key 8, differs at key 9', tieChainBase, { ...tieChainBase, origin: 'warm-prefix-continuation' }))
  vectors.push(runComparatorVector('tie chain: identical through key 9, differs at key 10', tieChainBase, { ...tieChainBase, prefixDepth: 5 }))
  vectors.push(runComparatorVector('tie chain: identical through key 10, differs at key 11', tieChainBase, { ...tieChainBase, sourceRole: 'open-pocket-first' }))

  // Seeded-random combinatorial sweep varying every key simultaneously.
  const random = mulberry32(2024)
  const origins: ReadonlyArray<'cold-search' | 'prefix-incumbent' | 'warm-prefix-continuation'> = [
    'cold-search',
    'prefix-incumbent',
    'warm-prefix-continuation'
  ]
  const sourceRoles: ReadonlyArray<string | undefined> = [
    undefined,
    'canonical-grid',
    'open-pocket-first',
    'legacy-absolute-envelope'
  ]
  function randomObjective(seedIndex: number): IntrinsicCapacityObjective {
    return {
      placedCount: Math.floor(random() * 10),
      placedDoubledMaterialAreaGrid2: BigInt(Math.floor(random() * 1_000_000)),
      enclosedCavityCount: Math.floor(random() * 4),
      totalEnclosedCavityAreaMm2: random() * 1000,
      totalEnclosedCavityDoubledAreaGrid2: Math.floor(random() * 1_000_000).toString(),
      envelopeMaximumSideMm: random() * 500,
      envelopeAreaMm2: random() * 100_000,
      envelopeSpanMm: random() * 800,
      envelopeMaximumSideGrid: Math.floor(random() * 900_000),
      envelopeAreaGrid2: Math.floor(random() * 1_000_000_000).toString(),
      envelopeSpanGrid: Math.floor(random() * 900_000),
      canonicalGeometryHash: `hash-${seedIndex}-${Math.floor(random() * 1000)}`,
      origin: origins[Math.floor(random() * origins.length)] as (typeof origins)[number],
      prefixDepth: random() > 0.5 ? Math.floor(random() * 10) : undefined,
      sourceRole: sourceRoles[Math.floor(random() * sourceRoles.length)]
    }
  }
  for (let index = 0; index < 60; index += 1) {
    const first = randomObjective(index)
    const second = randomObjective(index + 1000)
    vectors.push(runComparatorVector(`random comparator sweep #${index}`, first, second))
  }

  return vectors
}

// ---------------------------------------------------------------------------
// Endpoint comparator vectors: real `IntrinsicCapacityEndpoint`s (not
// synthetic objectives) built by `materializeIntrinsicCapacityEndpoint` and
// compared pairwise through the real `compareIntrinsicCapacityEndpoints` /
// `intrinsicCapacityObjective` projection -- exercises the full endpoint ->
// objective -> comparator path end to end, complementing
// `generateComparatorVectors`'s synthetic-objective coverage of each of the
// 11 keys in isolation.
// ---------------------------------------------------------------------------
interface EndpointComparatorVector {
  readonly description: string
  readonly first: unknown
  readonly second: unknown
  readonly sign: number
}

function buildRealEndpoint(
  sheetSpec: SheetSpec,
  placedPieces: ReadonlyArray<readonly [IrregularPreparedPiece, number, number]>,
  origin: IntrinsicCapacityEndpointOrigin
): IntrinsicCapacityEndpoint {
  const placedGeometries = placedPieces.map(([piece, x, y]) => placedRectangle(piece, x, y))
  const placementOrder = placedPieces.map(([piece]) => intrinsicCapacityPreparedPieceId(piece))
  const state = new IrregularBeamState({
    remainingPreparedPieces: [],
    placedCollisionGeometries: placedGeometries,
    placementOrder
  })
  const materialsByPieceId = new Map<PieceId, bigint>()
  for (const [piece] of placedPieces) {
    const areas = intrinsicCapacityMaterialAreas([piece])
    if (areas.kind === 'complete') {
      const area = areas.areasByPieceId.get(intrinsicCapacityPreparedPieceId(piece))
      if (area !== undefined) materialsByPieceId.set(intrinsicCapacityPreparedPieceId(piece), area)
    }
  }
  const cavityCache: IntrinsicCapacityCavityCache = new Map()
  const endpoint = materializeIntrinsicCapacityEndpoint({
    sheet: sheetSpec,
    state,
    unplacedPreparedIds: [],
    origin,
    materialAreasByPieceId: materialsByPieceId,
    cavityCache
  })
  if (endpoint === undefined) throw new Error('test endpoint failed to materialize')
  return endpoint
}

function runEndpointComparatorVector(
  description: string,
  first: IntrinsicCapacityEndpoint,
  second: IntrinsicCapacityEndpoint
): EndpointComparatorVector {
  const raw = compareIntrinsicCapacityEndpoints(first, second)
  const sign = raw === 0 ? 0 : raw < 0 ? -1 : 1
  return {
    description,
    first: encodeObjective(intrinsicCapacityObjective(first)),
    second: encodeObjective(intrinsicCapacityObjective(second)),
    sign
  }
}

function generateEndpointComparatorVectors(): ReadonlyArray<EndpointComparatorVector> {
  const vectors: EndpointComparatorVector[] = []
  const sheet200 = sheet(200, 200)

  const single = preparedRectangle('solo', 40, 30)
  const twoA = preparedRectangle('two-a', 40, 30)
  const twoB = preparedRectangle('two-b', 40, 30)
  const threeA = preparedRectangle('three-a', 30, 30)
  const threeB = preparedRectangle('three-b', 30, 30)
  const threeC = preparedRectangle('three-c', 30, 30)

  const endpointEmpty = materializeIntrinsicCapacityEndpoint({
    sheet: sheet200,
    state: new IrregularBeamState({
      remainingPreparedPieces: [],
      placedCollisionGeometries: [],
      placementOrder: []
    }),
    unplacedPreparedIds: [PieceId.make('solo')],
    origin: 'cold-search',
    materialAreasByPieceId: new Map(),
    cavityCache: new Map()
  })
  if (endpointEmpty === undefined) throw new Error('empty endpoint failed to materialize')
  const endpointOne = buildRealEndpoint(sheet200, [[single, 0, 0]], 'cold-search')
  const endpointTwo = buildRealEndpoint(
    sheet200,
    [
      [twoA, 0, 0],
      [twoB, 40, 0]
    ],
    'cold-search'
  )
  const endpointThree = buildRealEndpoint(
    sheet200,
    [
      [threeA, 0, 0],
      [threeB, 30, 0],
      [threeC, 60, 0]
    ],
    'warm-prefix-continuation'
  )

  vectors.push(runEndpointComparatorVector('more placed pieces wins (three vs two)', endpointThree, endpointTwo))
  vectors.push(runEndpointComparatorVector('more placed pieces wins (two vs three, reversed)', endpointTwo, endpointThree))
  vectors.push(runEndpointComparatorVector('fewer placed pieces loses (one vs two)', endpointOne, endpointTwo))
  vectors.push(runEndpointComparatorVector('empty endpoint loses to any placed endpoint', endpointEmpty, endpointOne))
  vectors.push(runEndpointComparatorVector('an endpoint compared against itself is a tie', endpointTwo, endpointTwo))
  vectors.push(runEndpointComparatorVector('an endpoint compared against a value-identical clone is a tie', endpointOne, buildRealEndpoint(sheet200, [[single, 0, 0]], 'cold-search')))
  vectors.push(
    runEndpointComparatorVector(
      'same placed count, origin breaks the tie (cold-search wins over warm-prefix-continuation)',
      endpointTwo,
      buildRealEndpoint(
        sheet200,
        [
          [preparedRectangle('two-a-origin', 40, 30), 0, 0],
          [preparedRectangle('two-b-origin', 40, 30), 40, 0]
        ],
        'warm-prefix-continuation'
      )
    )
  )

  return vectors
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------
function main(): void {
  const preflightVectors = generatePreflightVectors()
  const materialVectors = generateMaterialVectors()
  const endpointVectors = generateEndpointVectors()
  const comparatorVectors = generateComparatorVectors()
  const endpointComparatorVectors = generateEndpointComparatorVectors()

  const total =
    preflightVectors.length +
    materialVectors.length +
    endpointVectors.length +
    comparatorVectors.length +
    endpointComparatorVectors.length

  const output = {
    generatingCommit: generatingCommit(),
    generatedAt: new Date().toISOString(),
    counts: {
      preflight: preflightVectors.length,
      material: materialVectors.length,
      endpoint: endpointVectors.length,
      comparator: comparatorVectors.length,
      endpointComparator: endpointComparatorVectors.length,
      total
    },
    preflightVectors,
    materialVectors,
    endpointVectors,
    comparatorVectors,
    endpointComparatorVectors
  }

  mkdirSync(VECTORS_DIR, { recursive: true })
  const outputPath = join(VECTORS_DIR, 'capacity-core.json')
  writeFileSync(outputPath, JSON.stringify(output, (_key, value) => (typeof value === 'bigint' ? value.toString() : value), 2))
  console.log(`wrote ${total} capacity-core vectors to ${outputPath}`)
}

main()
