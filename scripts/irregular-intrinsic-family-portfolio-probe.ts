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
  type IrregularNestingSettings,
  type IrregularPlacedPiece
} from '../src/shared/irregular/domain.js'
import {
  runIntrinsicStrictFamilyPortfolio,
  type IntrinsicFamilyPortfolioRun
} from '../src/workers/algorithm/irregular/intrinsicStrictFamilyPortfolio.js'
import { decodeIntrinsicStrictPriorityOrder } from '../src/workers/algorithm/irregular/intrinsicStrictDecoder.js'
import { sortPiecesForNesting } from '../src/workers/algorithm/sortPiecesForNesting.js'
import { CollisionGeometryBuilder } from '../src/workers/irregular/collisionGeometryBuilder.js'
import { GeometryKernel, GeometrySettings } from '../src/workers/irregular/geometryKernel.js'
import { NfpIfpServiceLayer } from '../src/workers/irregular/nfpIfpService.js'
import {
  GeometryCacheInMemory,
  IrregularNfpIfpControlAbortError,
  TransformGenerator
} from '../src/workers/irregular/services.js'
import { TransformGeneratorLive } from '../src/workers/irregular/transformGenerator.js'

const FIXTURE = fileURLToPath(
  new URL('../tests/fixtures/irregularSheetInvariance/mixed61-request.json', import.meta.url)
)
const PREREGISTRATION =
  '/private/tmp/min-plane-provenance/intrinsic-family-portfolio-e2/preregistration.md'
const ARCHIVE_SHEET = new SheetSpec({ width: 2000, height: 2700, label: '2000x2700' })
const FOUR_SHEETS = [
  new SheetSpec({ width: 1000, height: 1300, label: '1000x1300' }),
  new SheetSpec({ width: 1000, height: 1700, label: '1000x1700' }),
  new SheetSpec({ width: 2000, height: 1700, label: '2000x1700' }),
  ARCHIVE_SHEET
] as const
const MAXIMUM_RUNTIME_MS_PER_CHROMOSOME = 30_000
const MAXIMUM_TOTAL_RUNTIME_MS = 240_000
const EARLY_MAXIMUM_AREA_MM2 = 439_904.169466
const E1_HULL_GAP_RATIO = 0.22414927709210425
const E1_TOTAL_STRUCTURAL_CONTACTS = 21
const E1_DOMINANT_STRUCTURAL_CONTACTS = 4
const E1_ISOLATED_PIECE_COUNT = 26
const E1_LARGEST_COMPONENT_SIZE = 14
const E1_CERTIFICATE_DEFICIT = 2.2074432680457226

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}

const outputDirectory =
  argument('--output') ?? '/private/tmp/min-plane-provenance/intrinsic-family-portfolio-e2/run'
const sourceCommit = argument('--source-commit') ?? 'unknown'
const strict = process.argv.includes('--strict')
await mkdir(outputDirectory, { recursive: true })
const fixtureBytes = await readFile(FIXTURE)
const preregistrationBytes = await readFile(PREREGISTRATION)
const request = Schema.decodeUnknownSync(NestingRequest)(JSON.parse(fixtureBytes.toString('utf8')))
const settings = request.options.irregularSettings
if (settings === undefined) throw new Error('mixed-61 fixture has no irregular settings')

const { preparedPieces, portfolio } = await Effect.runPromise(
  withSharedLayers(
    Effect.gen(function* () {
      const preparedPieces = yield* preparePieces(request, settings)
      const portfolio = yield* runIntrinsicStrictFamilyPortfolio(ARCHIVE_SHEET, preparedPieces, {
        maximumRuntimeMsPerChromosome: MAXIMUM_RUNTIME_MS_PER_CHROMOSOME,
        maximumTotalRuntimeMs: MAXIMUM_TOTAL_RUNTIME_MS
      })
      return { preparedPieces, portfolio }
    }),
    settings
  )
)

const artifactPaths: string[] = []
const chromosomeRuns = []
for (const run of portfolio.runs) {
  const label = `${run.chromosome.orderId}--${run.chromosome.templateId}`
  const svgPath =
    run.result?.status === 'completed'
      ? `${outputDirectory}/mixed-61-${label}.svg`
      : undefined
  if (svgPath !== undefined && run.result !== undefined) {
    await writeFile(svgPath, renderSvg(run.result.placedCollisionGeometries))
    artifactPaths.push(svgPath)
  }
  chromosomeRuns.push(reportRun(run, svgPath))
}

const completedRuns = portfolio.runs.filter(
  (run): run is IntrinsicFamilyPortfolioRun & { result: NonNullable<IntrinsicFamilyPortfolioRun['result']> } =>
    run.status === 'completed' && run.result?.metrics !== undefined
)
const earlySignalLabels = completedRuns
  .filter((run) => passesEarlySignal(run))
  .map(chromosomeLabel)
const bridgeLabels = completedRuns.filter((run) => passesBridge(run)).map(chromosomeLabel)
const archiveWinnerLabel =
  portfolio.winner === undefined ? undefined : chromosomeLabel(portfolio.winner)
const archiveWinnerPassesBridge = portfolio.winner !== undefined && passesBridge(portfolio.winner)
const runFourSheetReplay = bridgeLabels.length > 0 && archiveWinnerPassesBridge
const replayRuns = []
if (runFourSheetReplay && portfolio.winner !== undefined) {
  for (const sheet of FOUR_SHEETS) {
    const sheetId = `${sheet.width}x${sheet.height}`
    try {
      const result = await Effect.runPromise(
        withSharedLayers(
          decodeIntrinsicStrictPriorityOrder(sheet, portfolio.winner.chromosome.pieces, {
            comparatorMode: 'pure-growth',
            maximumRuntimeMs: MAXIMUM_RUNTIME_MS_PER_CHROMOSOME
          }),
          settings
        )
      )
      const svgPath = `${outputDirectory}/mixed-61-winner-${sheetId}.svg`
      await writeFile(svgPath, renderSvg(result.placedCollisionGeometries))
      artifactPaths.push(svgPath)
      replayRuns.push({
        sheet: { width: sheet.width, height: sheet.height },
        status: result.status,
        canonicalGeometryHash: result.canonicalGeometryHash,
        metrics: result.metrics,
        runtimeMs: result.runtimeMs,
        svgPath
      })
    } catch (error) {
      if (!(error instanceof IrregularNfpIfpControlAbortError)) throw error
      replayRuns.push({
        sheet: { width: sheet.width, height: sheet.height },
        status: 'deadline' as const,
        reason: error.reason,
        message: error.message
      })
    }
  }
}

const replayHashes = new Set(
  replayRuns.flatMap((run) =>
    'canonicalGeometryHash' in run && run.canonicalGeometryHash !== undefined
      ? [run.canonicalGeometryHash]
      : []
  )
)
const fourSheetReplayGate = {
  executed: runFourSheetReplay,
  passes:
    runFourSheetReplay &&
    replayRuns.length === FOUR_SHEETS.length &&
    replayRuns.every((run) => run.status === 'completed') &&
    replayHashes.size === 1,
  canonicalHashes: [...replayHashes]
}
const reportPath = `${outputDirectory}/report.json`
const report = {
  experiment: 'intrinsic-family-portfolio-e2',
  sourceCommit,
  fixture: FIXTURE,
  fixtureSha256: sha256(fixtureBytes),
  preregistration: PREREGISTRATION,
  preregistrationSha256: sha256(preregistrationBytes),
  runtime: { node: process.version, v8: process.versions.v8 },
  limits: {
    maximumChromosomes: 8,
    maximumRuntimeMsPerChromosome: MAXIMUM_RUNTIME_MS_PER_CHROMOSOME,
    maximumTotalRuntimeMs: MAXIMUM_TOTAL_RUNTIME_MS
  },
  contract: {
    comparatorMode: 'pure-growth',
    orders: [
      'baseline',
      'family-round-robin',
      'size-band-family-interleave',
      'large-first-small-fill'
    ],
    orientationTemplates: ['coaxial', 'crossed'],
    candidateDomain: 'sheetless-nfp',
    realSheetUse: 'archive final legality and conditional winner q0/q90 replay only'
  },
  preparedPieceCount: preparedPieces.length,
  selectedElongatedFamilyKeys:
    portfolio.chromosomes[0]?.selectedElongatedFamilyKeys.map(sha256) ?? [],
  gates: {
    earlySignal: {
      passes: earlySignalLabels.length > 0,
      chromosomeLabels: earlySignalLabels
    },
    bridge: {
      passes: bridgeLabels.length > 0,
      chromosomeLabels: bridgeLabels,
      archiveWinnerLabel,
      archiveWinnerPasses: archiveWinnerPassesBridge
    },
    fourSheetReplay: fourSheetReplayGate
  },
  decision:
    bridgeLabels.length === 0 || !archiveWinnerPassesBridge
      ? 'stop_before_triangle_and_corpus'
      : fourSheetReplayGate.passes
        ? 'run_triangle_and_corpus'
        : 'reject_on_four_sheet_replay',
  portfolioRuntimeMs: portfolio.runtimeMs,
  archive: portfolio.archive,
  chromosomes: chromosomeRuns,
  replayRuns
}
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
artifactPaths.unshift(reportPath)
const manifestPath = `${outputDirectory}/manifest.json`
await writeFile(
  manifestPath,
  `${JSON.stringify(
    {
      experiment: report.experiment,
      sourceCommit,
      fixture: { path: FIXTURE, sha256: report.fixtureSha256 },
      preregistration: {
        path: PREREGISTRATION,
        sha256: report.preregistrationSha256
      },
      files: Object.fromEntries(
        await Promise.all(artifactPaths.map(async (path) => [path, sha256(await readFile(path))]))
      )
    },
    null,
    2
  )}\n`
)
console.log(
  JSON.stringify({
    reportPath,
    reportSha256: sha256(await readFile(reportPath)),
    manifestPath,
    manifestSha256: sha256(await readFile(manifestPath)),
    gates: report.gates,
    decision: report.decision
  })
)
if (strict && report.decision !== 'run_triangle_and_corpus') process.exitCode = 2

function passesEarlySignal(run: IntrinsicFamilyPortfolioRun): boolean {
  const metrics = run.result?.metrics
  const certificate = run.result?.certificate
  if (metrics === undefined || certificate === undefined) return false
  const contactSignal =
    (metrics.totalStructuralContacts > E1_TOTAL_STRUCTURAL_CONTACTS &&
      metrics.dominantStructuralContacts > E1_DOMINANT_STRUCTURAL_CONTACTS) ||
    (certificate.relativeDeficitSum < E1_CERTIFICATE_DEFICIT &&
      metrics.totalStructuralContacts >= E1_TOTAL_STRUCTURAL_CONTACTS &&
      metrics.dominantStructuralContacts >= E1_DOMINANT_STRUCTURAL_CONTACTS)
  return (
    metrics.envelopeAreaMm2 <= EARLY_MAXIMUM_AREA_MM2 &&
    metrics.largestOccupiedHullGapRatio < E1_HULL_GAP_RATIO &&
    contactSignal &&
    metrics.isolatedPieceCount < E1_ISOLATED_PIECE_COUNT &&
    metrics.largestPositiveContactComponentSize > E1_LARGEST_COMPONENT_SIZE
  )
}

function passesBridge(run: IntrinsicFamilyPortfolioRun): boolean {
  const metrics = run.result?.metrics
  return (
    metrics !== undefined &&
    metrics.envelopeAreaMm2 <= 450_000 &&
    metrics.largestOccupiedHullGapRatio <= 0.15 &&
    metrics.positiveContactComponentCount <= 8 &&
    metrics.isolatedPieceCount <= 4 &&
    metrics.largestPositiveContactComponentSize >= 45 &&
    metrics.enclosedCavityCount <= 2
  )
}

function chromosomeLabel(run: IntrinsicFamilyPortfolioRun): string {
  return `${run.chromosome.orderId}/${run.chromosome.templateId}`
}

function reportRun(run: IntrinsicFamilyPortfolioRun, svgPath: string | undefined) {
  const stepTrace = run.result?.stepTrace ?? []
  return {
    label: chromosomeLabel(run),
    orderId: run.chromosome.orderId,
    templateId: run.chromosome.templateId,
    chromosomeStatus: run.chromosome.status,
    status: run.status,
    invalidReason: run.chromosome.invalidReason,
    duplicateOf: run.chromosome.duplicateOf,
    identitySha256: run.chromosome.identitySha256,
    selectedElongatedFamilyKeys: run.chromosome.selectedElongatedFamilyKeys.map(sha256),
    pieceOrderSha256: sha256(JSON.stringify(run.chromosome.pieceIds)),
    placedCount: run.result?.placedCollisionGeometries.length,
    unplacedPieceIds: run.result?.unplacedPieceIds,
    terminalRotationDeg: run.result?.terminalRotationDeg,
    canonicalGeometryHash: run.result?.canonicalGeometryHash,
    metrics: run.result?.metrics,
    certificate: run.result?.certificate,
    runtimeMs: run.runtimeMs,
    totalCandidateCount: stepTrace.reduce((sum, step) => sum + step.candidateCount, 0),
    stepTraceSha256: sha256(JSON.stringify(stepTrace)),
    svgPath
  }
}

function withSharedLayers<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  settings: IrregularNestingSettings
) {
  return effect.pipe(
    Effect.provide(CollisionGeometryBuilder.Layer),
    Effect.provide(TransformGeneratorLive),
    Effect.provide(GeometryKernel.LayerWithCache),
    Effect.provide(NfpIfpServiceLayer),
    Effect.provide(Layer.succeed(GeometrySettings, settings)),
    Effect.provide(GeometryCacheInMemory)
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
    sourcePieces.find((source) => source.id === sourcePieceId || source.id === preparedPieceId) ??
    sourcePieces.find((source) => {
      const base = sourcePieceId.replace(/-copy-\d+$/, '')
      const preparedBase = preparedPieceId.replace(/-copy-\d+$/, '')
      return source.id === base || source.id === preparedBase
    })
  )
}

function renderSvg(placed: ReadonlyArray<IrregularPlacedPiece>): string {
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
    .map((polygon) => `<polygon points="${polygon.map(({ x, y }) => `${x},${-y}`).join(' ')}"/>`)
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX - margin} ${-maxY - margin} ${maxX - minX + margin * 2} ${maxY - minY + margin * 2}" width="1200" height="1200"><rect x="${minX - margin}" y="${-maxY - margin}" width="${maxX - minX + margin * 2}" height="${maxY - minY + margin * 2}" fill="#1b2328"/><g fill="#22313b" stroke="#39a9ff" stroke-width="1">${paths}</g></svg>`
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}
