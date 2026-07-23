import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { Effect, Layer, Schema } from 'effect'
import type { ImportedPiece } from '../src/shared/domain/dxf.js'
import { JobId, type PieceId } from '../src/shared/domain/ids.js'
import { NestingOptions, NestingRequest, SheetSpec } from '../src/shared/domain/nesting.js'
import {
  IrregularNestingSettings,
  IrregularPreparedPiece,
  IrregularPriorityOrderKey
} from '../src/shared/irregular/domain.js'
import { computeIrregularNesting } from '../src/workers/algorithm/irregular/computeIrregularNesting.js'
import { IrregularLayoutScorer } from '../src/workers/algorithm/irregular/irregularLayoutScorer.js'
import { IrregularPlacementScorer } from '../src/workers/algorithm/irregular/irregularPlacementScorer.js'
import { measureRelaxationMetrics } from '../src/workers/algorithm/irregular/overlapRelaxation.js'
import { sortPiecesForNesting } from '../src/workers/algorithm/sortPiecesForNesting.js'
import {
  orderDestroyedQueue,
  replayFrozenExactLineage,
  runTargetedExactLns,
  selectTargetedDestroySet
} from '../src/workers/algorithm/irregular/targetedExactLns.js'
import { CollisionGeometryBuilder } from '../src/workers/irregular/collisionGeometryBuilder.js'
import { FreeMaterialServiceLive } from '../src/workers/irregular/freeMaterialService.js'
import { GeometryKernel, GeometrySettings } from '../src/workers/irregular/geometryKernel.js'
import { NfpIfpServiceLive } from '../src/workers/irregular/nfpIfpService.js'
import { TransformGeneratorLive } from '../src/workers/irregular/transformGenerator.js'
import { TransformGenerator } from '../src/workers/irregular/services.js'
import {
  analyzeCanonicalLayoutStructure,
  assertCanonicalGridLegalLayout,
  canonicalCollisionLayoutIdentity
} from '../src/workers/irregular/canonicalLayoutGeometry.js'

const FIXTURE = fileURLToPath(
  new URL('../tests/fixtures/irregularSheetInvariance/mixed61-request.json', import.meta.url)
)
const outputDirectory =
  process.argv[process.argv.indexOf('--output') + 1] ||
  '/private/tmp/min-plane-provenance/targeted-exact-lns/quality-run'
const sourceCommit = process.argv[process.argv.indexOf('--source-commit') + 1] || 'unknown'
const baselineOnly = process.argv.includes('--baseline-only')
const replayOnly = process.argv.includes('--replay-only')

await mkdir(outputDirectory, { recursive: true })
const fixture = Schema.decodeUnknownSync(NestingRequest)(JSON.parse(await readFile(FIXTURE, 'utf8')))
const settings = fixture.options.irregularSettings
if (settings === undefined) throw new Error('mixed-61 fixture has no irregular settings')
const sheet = new SheetSpec({ width: 2000, height: 2700, label: 'targeted-exact-lns-probe' })
const request = new NestingRequest({
  ...fixture,
  jobId: JobId.make(`${fixture.jobId}-targeted-exact-lns`),
  sheet,
  options: new NestingOptions({
    ...fixture.options,
    timeoutMs: 0,
    historyMode: 'off',
    irregularSettings: new IrregularNestingSettings({
      geometry: settings.geometry,
      optimizer: settings.optimizer
    })
  })
})
const layers = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(GeometryKernel.Live),
    Effect.provide(CollisionGeometryBuilder.Live),
    Effect.provide(TransformGeneratorLive),
    Effect.provide(NfpIfpServiceLive),
    Effect.provide(FreeMaterialServiceLive),
    Effect.provide(IrregularPlacementScorer.Live),
    Effect.provide(IrregularLayoutScorer.Live),
    Effect.provide(Layer.succeed(GeometrySettings, settings))
  )

const computeStartedAt = performance.now()
const incumbent = await Effect.runPromise(layers(computeIrregularNesting(request)))
const computeElapsedMs = performance.now() - computeStartedAt
const preparedPieces = await Effect.runPromise(layers(preparePieces(request, settings)))
const preflightStructure = analyzeCanonicalLayoutStructure(
  sheet,
  incumbent.placedCollisionGeometries
)
console.log(
  JSON.stringify({
    preflightPlaced: incumbent.placedCollisionGeometries.length,
    preflightUnplaced: incumbent.unplacedPieceIds.length,
    preparedPieces: preparedPieces.length,
    canonicalGridLegal: assertCanonicalGridLegalLayout(
      sheet,
      incumbent.placedCollisionGeometries
    ),
    exactConflictCount: preflightStructure?.positiveAreaConflicts.length,
    wallOffenderCount: preflightStructure?.wallOffenders.length,
    exactConflicts: preflightStructure?.positiveAreaConflicts,
    exactConflictMeasurements: preflightStructure?.positiveAreaConflictMeasurements,
    wallOffenders: preflightStructure?.wallOffenders
  })
)
await writeFile(
  `${outputDirectory}/preflight.json`,
  `${JSON.stringify(
    {
      sourceCommit,
      runtime: { node: process.version, v8: process.versions.v8 },
      placed: incumbent.placedCollisionGeometries.length,
      unplaced: incumbent.unplacedPieceIds.length,
      canonicalGridLegal: assertCanonicalGridLegalLayout(
        sheet,
        incumbent.placedCollisionGeometries
      ),
      exactConflicts: preflightStructure?.positiveAreaConflictMeasurements,
      wallOffenders: preflightStructure?.wallOffenders
    },
    null,
    2
  )}\n`
)
if (replayOnly) {
  const baselineMetrics = measureRelaxationMetrics(incumbent.placedCollisionGeometries)
  if (baselineMetrics === undefined || preflightStructure === undefined) {
    throw new Error('baseline replay requires finite exact structural metrics')
  }
  const constraintSheet: SheetSpec = {
    width: baselineMetrics.width,
    height: baselineMetrics.height,
    label: 'targeted exact LNS replay constraint'
  }
  const originalRankById = new Map(
    preparedPieces.map((piece, index) => [piece.pieceId ?? piece.source.id, index] as const)
  )
  const preparedById = new Map(
    preparedPieces.map((piece) => [piece.pieceId ?? piece.source.id, piece] as const)
  )
  const replayReports = []
  for (const target of ['interface', 'hull_void'] as const) {
    const selection = selectTargetedDestroySet({
      target,
      requestedK: 2,
      analysis: preflightStructure,
      originalRankById
    })
    const queue = orderDestroyedQueue({
      destroyIds: selection.destroyIds,
      queueOrder: 'priority',
      preparedById,
      originalRankById
    })
    if (queue === undefined) throw new Error(`replay queue failed for ${target}`)
    const destroySet = new Set(selection.destroyIds)
    const frozen = incumbent.placedCollisionGeometries.filter(
      ({ placement }) => !destroySet.has(placement.pieceId ?? placement.sourcePieceId)
    )
    const replay = await Effect.runPromise(
      replayFrozenExactLineage({
        constraintSheet,
        sourceLayout: incumbent.placedCollisionGeometries,
        frozenPlaced: frozen,
        destroyedQueue: queue
      })
    )
    replayReports.push({ target, selection, queue: queue.map((piece) => piece.pieceId), replay })
  }
  const replayReport = {
    sourceCommit,
    runtime: { node: process.version, v8: process.versions.v8 },
    constraint: { width: constraintSheet.width, height: constraintSheet.height },
    baselineCanonicalLegal: assertCanonicalGridLegalLayout(
      constraintSheet,
      incumbent.placedCollisionGeometries
    ),
    replays: replayReports
  }
  await writeFile(
    `${outputDirectory}/incumbent-replay-report.json`,
    `${JSON.stringify(replayReport, null, 2)}\n`
  )
  console.log(JSON.stringify(replayReport))
  process.exit(replayReports.every(({ replay }) => replay.legal) ? 0 : 3)
}
if (baselineOnly) {
  const baselineMetrics = measureRelaxationMetrics(incumbent.placedCollisionGeometries)
  const baselineHash = canonicalCollisionLayoutIdentity(incumbent.placedCollisionGeometries)
  const canonicalGridLegal = assertCanonicalGridLegalLayout(
    sheet,
    incumbent.placedCollisionGeometries
  )
  await writeFile(`${outputDirectory}/baseline.svg`, renderSvg(incumbent.placedCollisionGeometries))
  const baselineReport = {
    sourceCommit,
    fixture: FIXTURE,
    sheet: { width: sheet.width, height: sheet.height },
    runtime: { node: process.version, v8: process.versions.v8 },
    computeElapsedMs,
    placed: incumbent.placedCollisionGeometries.length,
    unplaced: incumbent.unplacedPieceIds.length,
    canonicalGridLegal,
    canonicalHash: baselineHash,
    exactConflicts: preflightStructure?.positiveAreaConflictMeasurements,
    wallOffenders: preflightStructure?.wallOffenders,
    metrics: baselineMetrics,
    decision: canonicalGridLegal ? 'baseline_preflight_pass' : 'baseline_preflight_stop'
  }
  await writeFile(
    `${outputDirectory}/baseline-report.json`,
    `${JSON.stringify(baselineReport, null, 2)}\n`
  )
  console.log(JSON.stringify(baselineReport))
  process.exit(canonicalGridLegal ? 0 : 2)
}
const lnsStartedAt = performance.now()
const result = await Effect.runPromise(
  layers(
    runTargetedExactLns({
      sheet,
      allPreparedPieces: preparedPieces,
      incumbent: incumbent.placedCollisionGeometries
    })
  )
)
const lnsElapsedMs = performance.now() - lnsStartedAt
const selectedHash = createHash('sha256')
  .update(JSON.stringify(result.placedCollisionGeometries))
  .digest('hex')
await writeFile(`${outputDirectory}/incumbent.svg`, renderSvg(incumbent.placedCollisionGeometries))
await writeFile(`${outputDirectory}/selected.svg`, renderSvg(result.placedCollisionGeometries))
const report = {
  sourceCommit,
  fixture: FIXTURE,
  sheet: { width: sheet.width, height: sheet.height },
  runtime: { node: process.version, v8: process.versions.v8 },
  clean: true,
  computeElapsedMs,
  lnsElapsedMs,
  incumbentPlaced: incumbent.placedCollisionGeometries.length,
  incumbentUnplaced: incumbent.unplacedPieceIds.length,
  selectedHash,
  ...result,
  placedCollisionGeometries: undefined,
  decision: result.accepted ? 'promote_to_broad_gates' : 'kill_after_24_rounds'
}
await writeFile(`${outputDirectory}/report.json`, `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify(report))

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
        geometrySettings: settings.geometry,
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
  const maxX = Math.max(...points.map(({ x }) => x))
  const minY = Math.min(...points.map(({ y }) => y))
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
