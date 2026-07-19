import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
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
  runIntrinsicGlobalSqueezePortfolio,
  type IntrinsicGlobalFullCandidate
} from '../src/workers/algorithm/irregular/intrinsicGlobalSqueezePortfolio.js'
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
const FIXTURE = fileURLToPath(
  new URL('../tests/fixtures/irregularSheetInvariance/mixed61-request.json', import.meta.url)
)
const PREREGISTRATION =
  '/private/tmp/min-plane-provenance/intrinsic-global-squeeze-disrupt-e4/preregistration.md'
const ROOMY_SHEET = new SheetSpec({ width: 2000, height: 2700, label: '2000x2700' })
const MAXIMUM_RUNTIME_MS = 110_000
const MAXIMUM_AREA_MM2 = 439_904.17
const MAXIMUM_CAVITY_COUNT = 2
const MAXIMUM_HULL_GAP_RATIO = 0.15

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}

const outputDirectory = resolve(
  argument('--output') ??
    '/private/tmp/min-plane-provenance/intrinsic-global-squeeze-disrupt-e4/early-gate-run'
)
const sourceCommit = verifiedSourceCommit(argument('--source-commit'))
const strict = process.argv.includes('--strict')
await mkdir(dirname(outputDirectory), { recursive: true })
await mkdir(outputDirectory)

const fixtureBytes = await readFile(FIXTURE)
const preregistrationBytes = await readFile(PREREGISTRATION)
const request = Schema.decodeUnknownSync(NestingRequest)(JSON.parse(fixtureBytes.toString('utf8')))
const settings = request.options.irregularSettings
if (settings === undefined) throw new Error('mixed-61 fixture has no irregular settings')

const experimentAttempt = await Effect.runPromise(
  withLayers(
    Effect.gen(function* () {
      const preparedPieces = yield* preparePieces(request, settings)
      const e1 = yield* constructIntrinsicStrictState({
        allPreparedPieces: preparedPieces,
        remainingPreparedPieces: preparedPieces,
        frozenPlaced: [],
        candidateMode: 'pure-growth'
      })
      const measuredE1 = measureIntrinsicSheetlessCompletedLayout(e1.state, e1.runtimeMs)
      if (
        measuredE1 === undefined ||
        measuredE1.placedCollisionGeometries.length !== preparedPieces.length
      ) {
        throw new Error('the sheetless pure-growth E1 state must be complete and exact')
      }
      const portfolio = yield* runIntrinsicGlobalSqueezePortfolio({
        allPreparedPieces: preparedPieces,
        fullE1Placed: measuredE1.placedCollisionGeometries
      })
      const terminalConstructed = completeConstructedState(
        portfolio.selected.placedCollisionGeometries,
        portfolio.runtimeMs
      )
      const realSheet = yield* finalizeIntrinsicStrictState(
        ROOMY_SHEET,
        terminalConstructed,
        portfolio.runtimeMs
      )
      return { preparedPieces, e1, measuredE1, portfolio, realSheet }
    }),
    settings
  )
).then(
  (value) => ({ kind: 'success' as const, value }),
  (error: unknown) => ({ kind: 'failure' as const, error })
)

if (experimentAttempt.kind === 'failure') {
  await publishFailureEvidence(experimentAttempt.error)
  process.exitCode = strict ? 2 : 1
} else {
  const experiment = experimentAttempt.value
  const svgPath = `${outputDirectory}/mixed-61-e4-selected-2000x2700.svg`
  await writeFile(svgPath, renderCollisionSvg(experiment.realSheet.placedCollisionGeometries))

  const selected = experiment.portfolio.selected
  const selectedMetrics = selected.measured.metrics
  const earlyGateChecks = {
    runtime: {
      passes: experiment.portfolio.runtimeMs <= MAXIMUM_RUNTIME_MS,
      actualMs: experiment.portfolio.runtimeMs,
      maximumMs: MAXIMUM_RUNTIME_MS
    },
    projectedCandidate: {
      passes:
        selected.source === 'projected-gap-fill' &&
        experiment.portfolio.admittedCandidates.length > 0,
      selectedSource: selected.source,
      admittedCandidateCount: experiment.portfolio.admittedCandidates.length
    },
    envelopeArea: {
      passes: selectedMetrics.envelopeAreaMm2 <= MAXIMUM_AREA_MM2,
      actualMm2: selectedMetrics.envelopeAreaMm2,
      maximumMm2: MAXIMUM_AREA_MM2
    },
    enclosedCavities: {
      passes: selectedMetrics.enclosedCavityCount <= MAXIMUM_CAVITY_COUNT,
      actual: selectedMetrics.enclosedCavityCount,
      maximum: MAXIMUM_CAVITY_COUNT
    },
    occupiedHullGap: {
      passes: selectedMetrics.largestOccupiedHullGapRatio <= MAXIMUM_HULL_GAP_RATIO,
      actual: selectedMetrics.largestOccupiedHullGapRatio,
      maximum: MAXIMUM_HULL_GAP_RATIO
    },
    roomySheetExactFit: {
      passes:
        experiment.realSheet.status === 'completed' &&
        experiment.realSheet.canonicalGeometryHash === selected.measured.canonicalGeometryHash,
      status: experiment.realSheet.status,
      canonicalGeometryHash: experiment.realSheet.canonicalGeometryHash
    }
  }
  const earlyGatePasses = Object.values(earlyGateChecks).every(({ passes }) => passes)
  const decision = earlyGatePasses ? 'run_triangle_and_corpus' : 'reject_e4_before_other_gates'

  const reportPath = `${outputDirectory}/report.json`
  const report = {
    experiment: 'intrinsic-global-squeeze-disrupt-e4-early-gate',
    sourceCommit,
    fixture: { path: FIXTURE, sha256: sha256(fixtureBytes) },
    preregistration: { path: PREREGISTRATION, sha256: sha256(preregistrationBytes) },
    runtime: runtimeVersions(),
    preparedPieceCount: experiment.preparedPieces.length,
    e1: {
      status: 'complete-exact',
      placementCount: experiment.measuredE1.placedCollisionGeometries.length,
      runtimeMs: experiment.e1.runtimeMs,
      canonicalGeometryHash: experiment.measuredE1.canonicalGeometryHash,
      metrics: experiment.measuredE1.metrics
    },
    portfolio: {
      status: experiment.portfolio.status,
      runtimeMs: experiment.portfolio.runtimeMs,
      maximumRuntimeMs: experiment.portfolio.maximumRuntimeMs,
      remainingBudgetMs: experiment.portfolio.remainingBudgetMs,
      structuralOutcome: experiment.portfolio.structuralOutcome,
      fillTrace: experiment.portfolio.fillTrace,
      promotion: experiment.portfolio.promotion,
      selected: archiveRecord(selected),
      archive: experiment.portfolio.completeArchive.map(archiveRecord)
    },
    realSheet: {
      sheet: { width: ROOMY_SHEET.width, height: ROOMY_SHEET.height },
      status: experiment.realSheet.status,
      placementCount: experiment.realSheet.placedCollisionGeometries.length,
      unplacedPieceCount: experiment.realSheet.unplacedPieceIds.length,
      terminalRotationDeg: experiment.realSheet.terminalRotationDeg,
      canonicalGeometryHash: experiment.realSheet.canonicalGeometryHash,
      metrics: experiment.realSheet.metrics,
      certificate: experiment.realSheet.certificate,
      svgPath
    },
    earlyGate: {
      passes: earlyGatePasses,
      checks: earlyGateChecks
    },
    decision
  }
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)

  const artifactPaths = [reportPath, svgPath]
  const manifestPath = `${outputDirectory}/manifest.json`
  await writeManifest(manifestPath, report.experiment, artifactPaths)

  console.log(
    JSON.stringify({
      reportPath,
      reportSha256: sha256(await readFile(reportPath)),
      svgPath,
      svgSha256: sha256(await readFile(svgPath)),
      manifestPath,
      manifestSha256: sha256(await readFile(manifestPath)),
      earlyGate: report.earlyGate,
      decision
    })
  )
  if (strict && !earlyGatePasses) process.exitCode = 2
}

async function publishFailureEvidence(error: unknown): Promise<void> {
  const reportPath = `${outputDirectory}/report.json`
  const decision = 'reject_e4_before_other_gates'
  const report = {
    experiment: 'intrinsic-global-squeeze-disrupt-e4-early-gate',
    sourceCommit,
    fixture: { path: FIXTURE, sha256: sha256(fixtureBytes) },
    preregistration: { path: PREREGISTRATION, sha256: sha256(preregistrationBytes) },
    runtime: runtimeVersions(),
    failure: serializeExperimentError(error),
    earlyGate: {
      passes: false,
      checks: {
        experimentExecution: {
          passes: false
        }
      }
    },
    decision
  }
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  const manifestPath = `${outputDirectory}/manifest.json`
  await writeManifest(manifestPath, report.experiment, [reportPath])
  console.error(
    JSON.stringify({
      reportPath,
      reportSha256: sha256(await readFile(reportPath)),
      manifestPath,
      manifestSha256: sha256(await readFile(manifestPath)),
      failure: report.failure,
      decision
    })
  )
}

async function writeManifest(
  manifestPath: string,
  experimentName: string,
  artifactPaths: ReadonlyArray<string>
): Promise<void> {
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        experiment: experimentName,
        sourceCommit,
        fixture: { path: FIXTURE, sha256: sha256(fixtureBytes) },
        preregistration: { path: PREREGISTRATION, sha256: sha256(preregistrationBytes) },
        files: Object.fromEntries(
          await Promise.all(artifactPaths.map(async (path) => [path, sha256(await readFile(path))]))
        )
      },
      null,
      2
    )}\n`
  )
}

function runtimeVersions() {
  return {
    node: process.version,
    v8: process.versions.v8,
    electron: process.versions.electron,
    platform: process.platform,
    architecture: process.arch
  }
}

function serializeExperimentError(error: unknown) {
  const tag =
    typeof error === 'object' && error !== null && '_tag' in error ? error._tag : undefined
  return {
    tag: typeof tag === 'string' ? tag : undefined,
    name: error instanceof Error ? error.name : undefined,
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined
  }
}

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
  requestInput: NestingRequest,
  settings: IrregularNestingSettings
): Effect.Effect<
  ReadonlyArray<IrregularPreparedPiece>,
  unknown,
  CollisionGeometryBuilder | TransformGenerator
> {
  return Effect.gen(function* () {
    const geometryBuilder = yield* CollisionGeometryBuilder
    const transformGenerator = yield* TransformGenerator
    const sourcePieces = requestInput.sourcePieces ?? []
    const result: IrregularPreparedPiece[] = []
    for (const prepared of sortPiecesForNesting(requestInput.pieces)) {
      const source = findSourcePiece(prepared.sourcePieceId, prepared.id, sourcePieces)
      if (source === undefined) throw new Error(`missing source ${prepared.sourcePieceId}`)
      const collisionGeometry = yield* geometryBuilder.buildPiece({
        piece: source,
        totalPaddingMm: requestInput.padding
      })
      const allowMirror =
        (requestInput.options.allowGlobalMirror ?? true) && (prepared.allowMirror ?? true)
      const transforms = yield* transformGenerator.generateTransforms({
        geometry: collisionGeometry,
        allowRotation: requestInput.options.allowGlobalRotation && prepared.allowRotation,
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
    sourcePieces.find((source) => source.id === sourcePieceId || source.id === preparedPieceId) ??
    sourcePieces.find((source) => {
      const base = sourcePieceId.replace(/-copy-\d+$/, '')
      const preparedBase = preparedPieceId.replace(/-copy-\d+$/, '')
      return source.id === base || source.id === preparedBase
    })
  )
}

function completeConstructedState(
  placed: ReadonlyArray<IrregularPlacedPiece>,
  runtimeMs: number
): IntrinsicStrictConstructResult {
  return {
    state: new IrregularBeamState({
      remainingPreparedPieces: [],
      placedCollisionGeometries: placed,
      placementOrder: placed.map(placedPieceId)
    }),
    stepTrace: [],
    gapFillEvidence: [],
    runtimeMs
  }
}

function archiveRecord(candidate: IntrinsicGlobalFullCandidate) {
  return {
    source: candidate.source,
    structuralProjectionAttempt: candidate.structuralProjectionAttempt,
    canonicalGeometryHash: candidate.measured.canonicalGeometryHash,
    placementCount: candidate.placedCollisionGeometries.length,
    metrics: candidate.measured.metrics,
    productionAreaTargetMet: candidate.productionAreaTargetMet,
    historicContactTargetMet: candidate.historicContactTargetMet
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
    return '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1200"/>'
  }
  const minX = Math.min(...points.map(({ x }) => x))
  const minY = Math.min(...points.map(({ y }) => y))
  const maxX = Math.max(...points.map(({ x }) => x))
  const maxY = Math.max(...points.map(({ y }) => y))
  const margin = Math.max(maxX - minX, maxY - minY) * 0.03
  const paths = polygons
    .map((polygon) => `<polygon points="${polygon.map(({ x, y }) => `${x},${-y}`).join(' ')}"/>`)
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX - margin} ${-maxY - margin} ${maxX - minX + margin * 2} ${maxY - minY + margin * 2}" width="1600" height="1600"><rect x="${minX - margin}" y="${-maxY - margin}" width="${maxX - minX + margin * 2}" height="${maxY - minY + margin * 2}" fill="#151d22"/><g fill="#26343d" stroke="#39a9ff" stroke-width="1" vector-effect="non-scaling-stroke">${paths}</g></svg>`
}

function verifiedSourceCommit(requestedCommit: string | undefined): string {
  const head = gitOutput(['rev-parse', 'HEAD'])
  if (requestedCommit !== undefined && requestedCommit !== head) {
    throw new Error(`--source-commit ${requestedCommit} does not match checked-out HEAD ${head}`)
  }
  const status = gitOutput(['status', '--porcelain', '--untracked-files=all'])
  if (status !== '') {
    throw new Error('the E4 evidence harness requires a clean worktree')
  }
  return head
}

function gitOutput(arguments_: ReadonlyArray<string>): string {
  return execFileSync('git', arguments_, {
    cwd: PROJECT_ROOT,
    encoding: 'utf8'
  }).trim()
}

function placedPieceId(piece: IrregularPlacedPiece): PieceId {
  return piece.placement.pieceId ?? piece.placement.sourcePieceId
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}
