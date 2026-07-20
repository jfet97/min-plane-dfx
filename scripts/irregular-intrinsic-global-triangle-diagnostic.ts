import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Effect, Layer } from 'effect'
import { ImportedPiece } from '../src/shared/domain/dxf.js'
import { JobId, PieceId, SourceFileId } from '../src/shared/domain/ids.js'
import { NestingOptions, NestingRequest, SheetSpec } from '../src/shared/domain/nesting.js'
import {
  DEFAULT_IRREGULAR_GEOMETRY_SETTINGS,
  makeCompactQualityIrregularOptimizerSettings
} from '../src/shared/irregular/defaults.js'
import {
  IrregularNestingSettings,
  IrregularPreparedPiece,
  IrregularPriorityOrderKey,
  type IrregularPlacedPiece
} from '../src/shared/irregular/domain.js'
import { makePresetShapeDocument } from '../src/shared/presetShapes.js'
import { preparePieces as prepareNestingPieces } from '../src/shared/preparePieces.js'
import { runIntrinsicGlobalSqueezePortfolio } from '../src/workers/algorithm/irregular/intrinsicGlobalSqueezePortfolio.js'
import { IrregularBeamState } from '../src/workers/algorithm/irregular/irregularBeamState.js'
import {
  constructIntrinsicStrictState,
  finalizeIntrinsicStrictState,
  measureIntrinsicSheetlessCompletedLayout,
  type IntrinsicStrictConstructResult
} from '../src/workers/algorithm/irregular/intrinsicStrictDecoder.js'
import { sortPiecesForNesting } from '../src/workers/algorithm/sortPiecesForNesting.js'
import { CollisionGeometryBuilder } from '../src/workers/irregular/collisionGeometryBuilder.js'
import { GeometryKernel, GeometrySettings } from '../src/workers/irregular/geometryKernel.js'
import { NfpIfpServiceLive } from '../src/workers/irregular/nfpIfpService.js'
import { TransformGenerator } from '../src/workers/irregular/services.js'
import { TransformGeneratorLive } from '../src/workers/irregular/transformGenerator.js'

const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url))
const HARNESS_PATH = fileURLToPath(import.meta.url)
const SHEET = new SheetSpec({ width: 2000, height: 2700, label: 'triangle golden' })
const settings = new IrregularNestingSettings({
  geometry: DEFAULT_IRREGULAR_GEOMETRY_SETTINGS,
  optimizer: makeCompactQualityIrregularOptimizerSettings()
})

const requestedOutput = argument('--output')
if (requestedOutput === undefined) {
  throw new Error('--output is required for immutable diagnostic evidence')
}
const outputDirectory = resolve(requestedOutput)
const sourceCommit = verifiedSourceCommit(argument('--source-commit'))
await mkdir(dirname(outputDirectory), { recursive: true })
await mkdir(outputDirectory)

const request = makeTriangleRequest()
const result = await Effect.runPromise(
  withLayers(
    Effect.gen(function* () {
      const preparedPieces = yield* prepareIrregularPieces(request)
      const e1 = yield* constructIntrinsicStrictState({
        allPreparedPieces: preparedPieces,
        remainingPreparedPieces: preparedPieces,
        frozenPlaced: [],
        candidateMode: 'pure-growth'
      })
      const measuredE1 = measureIntrinsicSheetlessCompletedLayout(e1.state, e1.runtimeMs)
      if (measuredE1 === undefined || measuredE1.placedCollisionGeometries.length !== 20) {
        throw new Error('triangle E1 must be complete and exact')
      }
      const portfolio = yield* runIntrinsicGlobalSqueezePortfolio({
        allPreparedPieces: preparedPieces,
        fullE1Placed: measuredE1.placedCollisionGeometries
      })
      const finalized = yield* finalizeIntrinsicStrictState(
        SHEET,
        completeConstructedState(
          portfolio.selected.placedCollisionGeometries,
          portfolio.runtimeMs
        ),
        portfolio.runtimeMs
      )
      return { measuredE1, portfolio, finalized }
    }),
    settings
  )
)

const svgPath = `${outputDirectory}/triangle-20-e4-2000x2700.svg`
const reportPath = `${outputDirectory}/report.json`
const manifestPath = `${outputDirectory}/manifest.json`
await writeFile(svgPath, renderCollisionSvg(result.finalized.placedCollisionGeometries))
const report = {
  experiment: 'intrinsic-global-squeeze-disrupt-e4-triangle20-diagnostic',
  sourceCommit,
  harness: { path: HARNESS_PATH, sha256: sha256(await readFile(HARNESS_PATH)) },
  request: {
    sheet: { width: SHEET.width, height: SHEET.height },
    pieceCount: request.pieces.length,
    paddingMm: request.padding
  },
  selectedSource: result.portfolio.selected.source,
  status: result.portfolio.status,
  e1: {
    canonicalGeometryHash: result.measuredE1.canonicalGeometryHash,
    metrics: result.measuredE1.metrics
  },
  portfolio: {
    runtimeMs: result.portfolio.runtimeMs,
    structuralOutcome: result.portfolio.structuralOutcome,
    fillTrace: result.portfolio.fillTrace,
    promotion: result.portfolio.promotion,
    selectedCanonicalGeometryHash: result.portfolio.selected.measured.canonicalGeometryHash,
    selectedMetrics: result.portfolio.selected.measured.metrics,
    admittedCandidateCount: result.portfolio.retainedAdmittedCandidates.length,
    evaluatedCompleteCandidates: result.portfolio.evaluatedCompleteCandidates.map(
      (candidate) => ({
        source: candidate.source,
        structuralProjectionAttempt: candidate.structuralProjectionAttempt,
        canonicalGeometryHash: candidate.canonicalGeometryHash,
        placementCount: candidate.placedCollisionGeometries.length,
        metrics: candidate.metrics
      })
    )
  },
  realSheet: {
    status: result.finalized.status,
    canonicalGeometryHash: result.finalized.canonicalGeometryHash,
    placementCount: result.finalized.placedCollisionGeometries.length,
    unplacedPieceCount: result.finalized.unplacedPieceIds.length,
    terminalRotationDeg: result.finalized.terminalRotationDeg,
    metrics: result.finalized.metrics,
    certificate: result.finalized.certificate
  },
  svgPath
}
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
await writeManifest(manifestPath, report.experiment, [reportPath, svgPath])
console.log(
  JSON.stringify({
    reportPath,
    reportSha256: sha256(await readFile(reportPath)),
    svgPath,
    svgSha256: sha256(await readFile(svgPath)),
    manifestPath,
    manifestSha256: sha256(await readFile(manifestPath)),
    selectedSource: report.selectedSource,
    status: report.status
  })
)

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}

function makeTriangleRequest(): NestingRequest {
  const preset = makePresetShapeDocument({
    kind: 'triangle',
    width: 70,
    height: 60,
    label: 'triangle'
  })
  const triangle = preset.pieces[0]
  if (triangle === undefined) throw new Error('triangle preset must contain one piece')
  const sources = Array.from(
    { length: 20 },
    (_, index) =>
      new ImportedPiece({
        ...triangle,
        id: PieceId.make(`triangle-copy-${index + 1}`),
        sourceFileId: SourceFileId.make(`triangle-source-copy-${index + 1}`),
        label: `triangle copy ${index + 1}`
      })
  )
  const jobId = JobId.make('triangle-compact-golden-e4-diagnostic')
  const prepared = prepareNestingPieces(
    sources,
    SHEET,
    10,
    jobId,
    undefined,
    undefined,
    () => 'triangle-70x60'
  )
  if (prepared.warnings.length > 0) throw new Error(prepared.warnings.join('; '))
  return new NestingRequest({
    version: 1,
    jobId,
    sheet: SHEET,
    padding: 10,
    pieces: prepared.pieces,
    sourcePieces: sources,
    options: new NestingOptions({
      allowGlobalRotation: true,
      allowGlobalMirror: true,
      timeoutMs: 120_000,
      workerMode: 'irregular-convex-v2',
      historyMode: 'off',
      historyScope: 'winning_path',
      strategySelectionMode: 'single',
      strategyIds: [],
      layoutSelectionStrategyId: 'compact-first',
      finalSelectionMode: 'best',
      irregularSettings: settings
    })
  })
}

function withLayers<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  runSettings: IrregularNestingSettings
) {
  return effect.pipe(
    Effect.provide(GeometryKernel.Live),
    Effect.provide(CollisionGeometryBuilder.Live),
    Effect.provide(TransformGeneratorLive),
    Effect.provide(NfpIfpServiceLive),
    Effect.provide(Layer.succeed(GeometrySettings, runSettings))
  )
}

function prepareIrregularPieces(
  requestInput: NestingRequest
): Effect.Effect<
  ReadonlyArray<IrregularPreparedPiece>,
  unknown,
  CollisionGeometryBuilder | TransformGenerator
> {
  return Effect.gen(function* () {
    const geometryBuilder = yield* CollisionGeometryBuilder
    const transformGenerator = yield* TransformGenerator
    const result: IrregularPreparedPiece[] = []
    for (const prepared of sortPiecesForNesting(requestInput.pieces)) {
      const source = requestInput.sourcePieces?.find(
        (candidate) =>
          candidate.id === prepared.sourcePieceId || candidate.id === prepared.id
      )
      if (source === undefined) throw new Error(`missing source ${prepared.sourcePieceId}`)
      const collisionGeometry = yield* geometryBuilder.buildPiece({
        piece: source,
        totalPaddingMm: requestInput.padding
      })
      const allowMirror =
        (requestInput.options.allowGlobalMirror ?? true) &&
        (prepared.allowMirror ?? true)
      const transforms = yield* transformGenerator.generateTransforms({
        geometry: collisionGeometry,
        allowRotation:
          requestInput.options.allowGlobalRotation && prepared.allowRotation,
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

function completeConstructedState(
  placed: ReadonlyArray<IrregularPlacedPiece>,
  runtimeMs: number
): IntrinsicStrictConstructResult {
  return {
    state: new IrregularBeamState({
      remainingPreparedPieces: [],
      placedCollisionGeometries: placed,
      placementOrder: placed.map(
        (piece) => piece.placement.pieceId ?? piece.placement.sourcePieceId
      )
    }),
    stepTrace: [],
    gapFillEvidence: [],
    runtimeMs
  }
}

function renderCollisionSvg(placed: ReadonlyArray<IrregularPlacedPiece>): string {
  const polygons = placed.map(({ placement, collisionGeometry }) =>
    collisionGeometry.polygon.points.map(({ x, y }) => ({
      x: x + placement.transform.translateX,
      y: y + placement.transform.translateY
    }))
  )
  const points = polygons.flat()
  if (points.length === 0) {
    return '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1200"/>'
  }
  const minX = Math.min(...points.map(({ x }) => x))
  const minY = Math.min(...points.map(({ y }) => y))
  const maxX = Math.max(...points.map(({ x }) => x))
  const maxY = Math.max(...points.map(({ y }) => y))
  const margin = Math.max(maxX - minX, maxY - minY) * 0.04
  const paths = polygons
    .map(
      (polygon) =>
        `<polygon points="${polygon.map(({ x, y }) => `${x},${-y}`).join(' ')}"/>`
    )
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX - margin} ${-maxY - margin} ${maxX - minX + margin * 2} ${maxY - minY + margin * 2}" width="1600" height="1200"><rect x="${minX - margin}" y="${-maxY - margin}" width="${maxX - minX + margin * 2}" height="${maxY - minY + margin * 2}" fill="#151d22"/><g fill="#26343d" stroke="#39a9ff" stroke-width="1" vector-effect="non-scaling-stroke">${paths}</g></svg>`
}

async function writeManifest(
  manifestPath: string,
  experiment: string,
  artifactPaths: ReadonlyArray<string>
): Promise<void> {
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        experiment,
        sourceCommit,
        harness: { path: HARNESS_PATH, sha256: sha256(await readFile(HARNESS_PATH)) },
        files: Object.fromEntries(
          await Promise.all(
            artifactPaths.map(async (path) => [path, sha256(await readFile(path))])
          )
        )
      },
      null,
      2
    )}\n`
  )
}

function verifiedSourceCommit(requestedCommit: string | undefined): string {
  const head = gitOutput(['rev-parse', 'HEAD'])
  if (requestedCommit !== undefined && requestedCommit !== head) {
    throw new Error(`--source-commit ${requestedCommit} does not match checked-out HEAD ${head}`)
  }
  const status = gitOutput(['status', '--porcelain', '--untracked-files=all'])
  if (status !== '') {
    throw new Error('the triangle diagnostic harness requires a clean worktree')
  }
  return head
}

function gitOutput(arguments_: ReadonlyArray<string>): string {
  return execFileSync('git', arguments_, { cwd: PROJECT_ROOT, encoding: 'utf8' }).trim()
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}
