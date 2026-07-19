import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Effect, Layer, Schema } from 'effect'
import type { ImportedPiece } from '../src/shared/domain/dxf.js'
import type { PieceId } from '../src/shared/domain/ids.js'
import { NestingRequest, SheetSpec } from '../src/shared/domain/nesting.js'
import {
  IrregularPreparedPiece,
  IrregularPriorityOrderKey,
  type IrregularNestingSettings
} from '../src/shared/irregular/domain.js'
import { decodeIntrinsicStrictPriorityOrder } from '../src/workers/algorithm/irregular/intrinsicStrictDecoder.js'
import { sortPiecesForNesting } from '../src/workers/algorithm/sortPiecesForNesting.js'
import { CollisionGeometryBuilder } from '../src/workers/irregular/collisionGeometryBuilder.js'
import { GeometryKernel, GeometrySettings } from '../src/workers/irregular/geometryKernel.js'
import { NfpIfpServiceLive } from '../src/workers/irregular/nfpIfpService.js'
import {
  IrregularNfpIfpControlAbortError,
  TransformGenerator
} from '../src/workers/irregular/services.js'
import { TransformGeneratorLive } from '../src/workers/irregular/transformGenerator.js'

const FIXTURE = fileURLToPath(
  new URL('../tests/fixtures/irregularSheetInvariance/mixed61-request.json', import.meta.url)
)
const FOUR_SHEETS = [
  new SheetSpec({ width: 1000, height: 1300, label: '1000x1300' }),
  new SheetSpec({ width: 1000, height: 1700, label: '1000x1700' }),
  new SheetSpec({ width: 2000, height: 1700, label: '2000x1700' }),
  new SheetSpec({ width: 2000, height: 2700, label: '2000x2700' })
] as const
const TARGET_AREA_MM2 = 430_344.918
const KILL_AREA_MM2 = 451_862.164
const MAXIMUM_RUNTIME_MS = 120_000

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}

const outputDirectory =
  argument('--output') ?? '/private/tmp/min-plane-provenance/intrinsic-strict-decoder/e1-four-sheet'
const sourceCommit = argument('--source-commit') ?? 'unknown'
const strict = process.argv.includes('--strict')
await mkdir(outputDirectory, { recursive: true })
const fixtureBytes = await readFile(FIXTURE)
const request = Schema.decodeUnknownSync(NestingRequest)(JSON.parse(fixtureBytes.toString('utf8')))
const settings = request.options.irregularSettings
if (settings === undefined) throw new Error('mixed-61 fixture has no irregular settings')
const preparedPieces = await Effect.runPromise(withLayers(preparePieces(request, settings), settings))

const runs = []
for (const sheet of FOUR_SHEETS) {
  const sheetId = `${sheet.width}x${sheet.height}`
  try {
    const result = await Effect.runPromise(
      withLayers(
        decodeIntrinsicStrictPriorityOrder(sheet, preparedPieces, {
          maximumRuntimeMs: MAXIMUM_RUNTIME_MS
        }),
        settings
      )
    )
    const svgPath = `${outputDirectory}/mixed-61-${sheetId}.svg`
    await writeFile(svgPath, renderSvg(result.placedCollisionGeometries))
    runs.push({
      sheet: { width: sheet.width, height: sheet.height },
      status: result.status,
      placedCount: result.placedCollisionGeometries.length,
      unplacedPieceIds: result.unplacedPieceIds,
      terminalRotationDeg: result.terminalRotationDeg,
      canonicalGeometryHash: result.canonicalGeometryHash,
      metrics: result.metrics,
      certificate: result.certificate,
      runtimeMs: result.runtimeMs,
      stepTrace: result.stepTrace.map((step) => ({
        pieceId: step.pieceId,
        candidateCount: step.candidateCount,
        transformFamilyCount: step.transformFamilyCount,
        selectedTransformFamily: step.selectedTransformFamily,
        selectedScore:
          step.selectedScore === undefined
            ? undefined
            : {
                maximumSideMm: step.selectedScore.maximumSideMm,
                envelopeAreaMm2: step.selectedScore.envelopeAreaMm2,
                envelopeSpanMm: step.selectedScore.envelopeSpanMm,
                sharedBoundaryLengthMm: step.selectedScore.sharedBoundaryLengthMm,
                canonicalCombinedGeometrySha256: sha256(
                  step.selectedScore.canonicalCombinedGeometryKey
                )
              }
      })),
      svgPath
    })
  } catch (error) {
    if (!(error instanceof IrregularNfpIfpControlAbortError)) throw error
    runs.push({
      sheet: { width: sheet.width, height: sheet.height },
      status: 'deadline' as const,
      reason: error.reason,
      message: error.message
    })
  }
}

const completedRuns = runs.filter((run) => run.status === 'completed')
const canonicalHashes = new Set(completedRuns.map((run) => run.canonicalGeometryHash))
const k1 = {
  passes: completedRuns.length === FOUR_SHEETS.length && canonicalHashes.size === 1,
  completedSheetCount: completedRuns.length,
  canonicalHashes: [...canonicalHashes]
}
const k2 = {
  passes:
    completedRuns.length === FOUR_SHEETS.length &&
    completedRuns.every((run) => run.certificate?.passes === true),
  stopBeforeE2:
    completedRuns.length === 0 ||
    completedRuns.every(
      (run) =>
        run.metrics !== undefined &&
        (run.metrics.isolatedPieceCount > 4 ||
          run.metrics.largestPositiveContactComponentRatio < 0.7)
    )
}
const k3 = {
  passes:
    completedRuns.length === FOUR_SHEETS.length &&
    completedRuns.every(
      (run) =>
        run.metrics !== undefined &&
        run.metrics.envelopeAreaMm2 <= TARGET_AREA_MM2 &&
        run.metrics.enclosedCavityCount <= 2 &&
        run.metrics.totalStructuralContacts >= 53 &&
        run.metrics.dominantStructuralContacts >= 14
    ),
  pureGrowthKilled:
    completedRuns.length === 0 ||
    completedRuns.some(
      (run) => run.metrics === undefined || run.metrics.envelopeAreaMm2 > KILL_AREA_MM2
    )
}
const survivesK1ToK3 = k1.passes && k2.passes && k3.passes
const reportPath = `${outputDirectory}/report.json`
const report = {
  experiment: 'intrinsic-strict-decoder-e1',
  sourceCommit,
  fixture: FIXTURE,
  fixtureSha256: sha256(fixtureBytes),
  runtime: { node: process.version, v8: process.versions.v8 },
  maximumRuntimeMsPerSheet: MAXIMUM_RUNTIME_MS,
  contract: {
    order: 'one user-owned prepared-piece order',
    candidateDomain: 'sheetless NFP vertices, supports, and intersections',
    localTuple: [
      'maximum side',
      'bounding-box area',
      'width plus height',
      'exact shared boundary descending',
      'canonical combined geometry key'
    ],
    realSheetUse: 'final q0/q90 exact legality only'
  },
  gates: { k1, k2, k3, survivesK1ToK3 },
  decision: survivesK1ToK3 ? 'survives_to_e2' : 'stop_before_e2',
  runs
}
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
const artifactFiles = [reportPath, ...runs.flatMap((run) => ('svgPath' in run ? [run.svgPath] : []))]
const manifestPath = `${outputDirectory}/manifest.json`
await writeFile(
  manifestPath,
  `${JSON.stringify(
    {
      experiment: report.experiment,
      sourceCommit,
      fixture: { path: FIXTURE, sha256: report.fixtureSha256 },
      files: Object.fromEntries(
        await Promise.all(artifactFiles.map(async (path) => [path, sha256(await readFile(path))]))
      )
    },
    null,
    2
  )}\n`
)
console.log(JSON.stringify({ reportPath, manifestPath, gates: report.gates, decision: report.decision }))
if (strict && !survivesK1ToK3) process.exitCode = 2

function withLayers<A, E, R>(effect: Effect.Effect<A, E, R>, settings: IrregularNestingSettings) {
  return effect.pipe(
    Effect.provide(GeometryKernel.Live),
    Effect.provide(CollisionGeometryBuilder.Live),
    Effect.provide(TransformGeneratorLive),
    Effect.provide(NfpIfpServiceLive),
    Effect.provide(Layer.succeed(GeometrySettings, settings))
  )
}

function preparePieces(
  request: NestingRequest,
  settings: IrregularNestingSettings
): Effect.Effect<
  ReadonlyArray<IrregularPreparedPiece>,
  unknown,
  CollisionGeometryBuilder | TransformGenerator
> {
  return Effect.gen(function* () {
    const geometryBuilder = yield* CollisionGeometryBuilder
    const transformGenerator = yield* TransformGenerator
    const sourcePieces = request.sourcePieces ?? []
    const result: IrregularPreparedPiece[] = []
    for (const prepared of sortPiecesForNesting(request.pieces)) {
      const source = findSourcePiece(prepared.sourcePieceId, prepared.id, sourcePieces)
      if (source === undefined) throw new Error(`missing source ${prepared.sourcePieceId}`)
      const collisionGeometry = yield* geometryBuilder.buildPiece({
        piece: source,
        totalPaddingMm: request.padding
      })
      const allowMirror =
        (request.options.allowGlobalMirror ?? true) && (prepared.allowMirror ?? true)
      const transforms = yield* transformGenerator.generateTransforms({
        geometry: collisionGeometry,
        allowRotation: request.options.allowGlobalRotation && prepared.allowRotation,
        allowMirror,
        settings: settings.optimizer
      })
      result.push(
        new IrregularPreparedPiece({
          pieceId: prepared.id,
          interchangeabilityKey: prepared.interchangeabilityKey ?? prepared.id,
          source,
          allowMirror,
          collisionGeometry,
          transforms,
          priorityOrderKey: new IrregularPriorityOrderKey({
            longSideMm: prepared.paddedBounds.longestEdge,
            areaMm2: prepared.paddedBounds.area,
            imbalanceMm: prepared.paddedBounds.imbalance
          })
        })
      )
    }
    return result
  })
}

function findSourcePiece(
  sourcePieceId: PieceId,
  preparedPieceId: PieceId,
  sourcePieces: ReadonlyArray<ImportedPiece>
): ImportedPiece | undefined {
  return (
    sourcePieces.find(
      (source) => source.id === sourcePieceId || source.id === preparedPieceId
    ) ??
    sourcePieces.find((source) => {
      const base = sourcePieceId.replace(/-copy-\d+$/, '')
      const preparedBase = preparedPieceId.replace(/-copy-\d+$/, '')
      return source.id === base || source.id === preparedBase
    })
  )
}

function renderSvg(
  placed: ReadonlyArray<{
    readonly placement: {
      readonly transform: { readonly translateX: number; readonly translateY: number }
    }
    readonly collisionGeometry: {
      readonly polygon: {
        readonly points: ReadonlyArray<{ readonly x: number; readonly y: number }>
      }
    }
  }>
): string {
  const polygons = placed.map(({ placement, collisionGeometry }) =>
    collisionGeometry.polygon.points.map(({ x, y }) => ({
      x: x + placement.transform.translateX,
      y: y + placement.transform.translateY
    }))
  )
  const points = polygons.flat()
  const minX = Math.min(...points.map(({ x }) => x))
  const minY = Math.min(...points.map(({ y }) => y))
  const maxX = Math.max(...points.map(({ x }) => x))
  const maxY = Math.max(...points.map(({ y }) => y))
  const margin = 20
  const paths = polygons
    .map(
      (polygon) =>
        `<polygon points="${polygon.map(({ x, y }) => `${x},${-y}`).join(' ')}"/>`
    )
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX - margin} ${-maxY - margin} ${maxX - minX + margin * 2} ${maxY - minY + margin * 2}" width="1200" height="1200"><rect x="${minX - margin}" y="${-maxY - margin}" width="${maxX - minX + margin * 2}" height="${maxY - minY + margin * 2}" fill="#1b2328"/><g fill="#22313b" stroke="#39a9ff" stroke-width="1">${paths}</g></svg>`
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}
