import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Effect, Layer, Schema } from 'effect'
import { ImportedPiece } from '../src/shared/domain/dxf.js'
import { JobId, PieceId, SourceFileId } from '../src/shared/domain/ids.js'
import { NestingOptions, NestingRequest, SheetSpec } from '../src/shared/domain/nesting.js'
import {
  DEFAULT_IRREGULAR_GEOMETRY_SETTINGS,
  makeCompactQualityIrregularOptimizerSettings
} from '../src/shared/irregular/defaults.js'
import {
  IrregularNestingSettings,
  IrregularPlacedPiece,
  IrregularPlacement,
  IrregularPreparedPiece,
  IrregularPriorityOrderKey,
  IrregularTransform
} from '../src/shared/irregular/domain.js'
import { makePresetShapeDocument } from '../src/shared/presetShapes.js'
import { preparePieces as prepareNestingPieces } from '../src/shared/preparePieces.js'
import { assertCanonicalGridLegalLayout } from '../src/workers/irregular/canonicalLayoutGeometry.js'
import {
  runIntrinsicV7SeedArchive,
  type IntrinsicV7Endpoint,
  type IntrinsicV7FeatureContactObserver,
  type IntrinsicV7Stage1Arm
} from '../src/workers/algorithm/irregular/intrinsicV7SeedArchive.js'
import { IrregularBeamState } from '../src/workers/algorithm/irregular/irregularBeamState.js'
import {
  runIntrinsicReconstructionPortfolio,
  type IntrinsicReconstructionPortfolioResult
} from '../src/workers/algorithm/irregular/intrinsicReconstructionPortfolio.js'
import {
  auditIntrinsicReferenceSuccessorReachability,
  runIntrinsicPartialGeometricBeam,
  runIntrinsicPeelReinsertObserver,
  runIntrinsicQueueBeamDiscriminator
} from '../src/workers/algorithm/irregular/intrinsicQueueBeamDiscriminator.js'
import { sortPiecesForNesting } from '../src/workers/algorithm/sortPiecesForNesting.js'
import { CollisionGeometryBuilder } from '../src/workers/irregular/collisionGeometryBuilder.js'
import { GeometryKernel, GeometrySettings } from '../src/workers/irregular/geometryKernel.js'
import { NfpIfpServiceLive } from '../src/workers/irregular/nfpIfpService.js'
import {
  NFP_IFP_CANDIDATE_SOURCE_MASK,
  TransformGenerator
} from '../src/workers/irregular/services.js'
import { TransformGeneratorLive } from '../src/workers/irregular/transformGenerator.js'

const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url))
const HARNESS_PATH = fileURLToPath(import.meta.url)
const SVG_RENDERER_PATH = fileURLToPath(
  new URL('../.agents/skills/render-svg-with-electron/scripts/render-svg.cjs', import.meta.url)
)
const MIXED_FIXTURE_PATH = fileURLToPath(
  new URL('../tests/fixtures/irregularSheetInvariance/mixed61-request.json', import.meta.url)
)
const TRIANGLE_SHEET = new SheetSpec({ width: 2000, height: 2700, label: 'triangle golden' })

const StructuredLineagePlacement = Schema.Struct({
  pieceId: PieceId,
  rotationDeg: Schema.Finite,
  mirrored: Schema.Boolean,
  translateX: Schema.Finite,
  translateY: Schema.Finite
})

const StructuredLineageStep = Schema.Struct({
  stepIndex: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  placements: Schema.Array(StructuredLineagePlacement)
})

const StructuredLineage = Schema.Array(StructuredLineageStep)

async function main(): Promise<void> {
  const fixtureName = requiredFixture(argument('--fixture'))
  const outputDirectory = resolve(requiredArgument('--output'))
  const sourceCommit = verifiedSourceCommit(argument('--source-commit'))
  const requestedArms = parseArms(argument('--arms'))
  const compact = process.argv.includes('--compact')
  const featureContactCoverage = process.argv.includes('--feature-contact-coverage')
  const queueBeamDiscriminatorEnabled = process.argv.includes('--queue-beam-discriminator')
  const partialBeamWidthArgument = argument('--partial-beam-width')
  const partialBeamEnabled = partialBeamWidthArgument !== undefined
  const partialBeamOnly = process.argv.includes('--partial-beam-only')
  const peelReinsertObserver = process.argv.includes('--peel-reinsert-observer')
  const fourContributorReconstruction = process.argv.includes(
    '--four-contributor-reconstruction'
  )
  const structuredLineagePath = argument('--structured-lineage')
  const lineageCalibrationOnly = process.argv.includes('--lineage-calibration-only')
  const firstMissAuditOnly = process.argv.includes('--first-miss-audit-only')
  if (partialBeamOnly && !partialBeamEnabled) {
    throw new Error('--partial-beam-only requires --partial-beam-width')
  }
  if (peelReinsertObserver && !partialBeamOnly) {
    throw new Error('--peel-reinsert-observer requires --partial-beam-only')
  }
  if (fourContributorReconstruction && !peelReinsertObserver) {
    throw new Error('--four-contributor-reconstruction requires --peel-reinsert-observer')
  }
  if ((lineageCalibrationOnly || firstMissAuditOnly) && structuredLineagePath === undefined) {
    throw new Error('lineage calibration/audit requires --structured-lineage')
  }
  const reconstructionPortfolioEnabled =
    process.argv.includes('--reconstruction-portfolio') ||
    queueBeamDiscriminatorEnabled ||
    partialBeamEnabled
  const schedule = compact
    ? {
        maximumRuntimeMs: 2_000,
        maximumEvaluations: 128,
        completedSweeps: 1
      }
    : undefined

  await mkdir(dirname(outputDirectory), { recursive: true })
  await mkdir(outputDirectory)

  const fixture = await loadFixture(fixtureName)
  const fixtureBytes = fixture.bytes
  const harnessBytes = await readFile(HARNESS_PATH)
  const featureContactCollector = featureContactCoverage
    ? new FeatureContactCoverageCollector()
    : undefined
  const preparedPieces = await Effect.runPromise(
    withLayers(prepareIrregularPieces(fixture.request), fixture.settings)
  )
  if (firstMissAuditOnly && structuredLineagePath !== undefined) {
    await runStructuredFirstMissAudit({
      fixtureName,
      outputDirectory,
      sourceCommit,
      fixture,
      fixtureBytes,
      harnessBytes,
      preparedPieces,
      structuredLineagePath: resolve(structuredLineagePath),
      depth: nonNegativeIntegerArgument('--first-miss-depth', 1)
    })
    return
  }
  if (lineageCalibrationOnly && structuredLineagePath !== undefined) {
    await runStructuredLineageCalibration({
      fixtureName,
      outputDirectory,
      sourceCommit,
      fixture,
      fixtureBytes,
      harnessBytes,
      preparedPieces,
      structuredLineagePath: resolve(structuredLineagePath),
      maximumRuntimeMs: positiveIntegerArgument('--queue-beam-runtime-ms', 300_000),
      maximumEvaluations: positiveIntegerArgument('--queue-beam-evaluations', 250_000)
    })
    return
  }
  if (partialBeamOnly) {
    await runPartialBeamOnly({
      fixtureName,
      outputDirectory,
      sourceCommit,
      fixture,
      fixtureBytes,
      harnessBytes,
      preparedPieces,
      experimentalWidth: nonNegativeIntegerArgument('--partial-beam-width', 0),
      maximumRuntimeMs: positiveIntegerArgument(
        '--partial-beam-runtime-ms',
        compact ? 30_000 : 90_000
      ),
      maximumEvaluations: positiveIntegerArgument(
        '--partial-beam-evaluations',
        compact ? 25_000 : 100_000
      ),
      peelReinsertObserver,
      fourContributorReconstruction,
      peelMaximumRuntimeMs: positiveIntegerArgument('--peel-runtime-ms', 120_000),
      peelMaximumEvaluations: positiveIntegerArgument('--peel-evaluations', 100_000)
    })
    return
  }
  const outcome = await Effect.runPromise(
    withLayers(
      runIntrinsicV7SeedArchive({
        allPreparedPieces: preparedPieces,
        ...(requestedArms === undefined ? {} : { arms: requestedArms }),
        ...(schedule === undefined ? {} : { schedule }),
        ...(featureContactCollector === undefined
          ? {}
          : { featureContactObserver: featureContactCollector })
      }),
      fixture.settings
    )
  )
  const reconstructionPortfolio = reconstructionPortfolioEnabled
    ? await Effect.runPromise(
        withLayers(
          runIntrinsicReconstructionPortfolio({
            allPreparedPieces: preparedPieces,
            baselineSeeds: outcome.seedArchive,
            maximumRuntimeMsPerDecode: compact ? 15_000 : 120_000,
            maximumTotalRuntimeMs: compact ? 90_000 : 300_000
          }),
          fixture.settings
        )
      )
    : undefined
  const queueBeamTarget =
    (queueBeamDiscriminatorEnabled || partialBeamEnabled) && reconstructionPortfolio !== undefined
      ? selectQueueBeamAuditTarget(reconstructionPortfolio)
      : undefined
  const queueBeamOrderedPieces =
    queueBeamTarget === undefined
      ? undefined
      : orderedPiecesForRun(preparedPieces, queueBeamTarget.pieceIds)
  const queueBeamDiscriminator =
    queueBeamTarget === undefined || queueBeamOrderedPieces === undefined
      ? undefined
      : await Effect.runPromise(
          withLayers(
            runIntrinsicQueueBeamDiscriminator({
              orderedPreparedPieces: queueBeamOrderedPieces,
              maximumRuntimeMs: positiveIntegerArgument(
                '--queue-beam-runtime-ms',
                compact ? 15_000 : 60_000
              ),
              maximumEvaluations: positiveIntegerArgument(
                '--queue-beam-evaluations',
                compact ? 5_000 : 25_000
              )
            }),
            fixture.settings
          )
        )
  const partialGeometricBeam =
    !partialBeamEnabled || queueBeamOrderedPieces === undefined
      ? undefined
      : await Effect.runPromise(
          withLayers(
            runIntrinsicPartialGeometricBeam({
              orderedPreparedPieces: queueBeamOrderedPieces,
              finalSheet: fixture.sheet,
              experimentalWidth: nonNegativeIntegerArgument('--partial-beam-width', 0),
              maximumRuntimeMs: positiveIntegerArgument(
                '--partial-beam-runtime-ms',
                compact ? 30_000 : 90_000
              ),
              maximumEvaluations: positiveIntegerArgument(
                '--partial-beam-evaluations',
                compact ? 25_000 : 100_000
              )
            }),
            fixture.settings
          )
        )
  const partialBeamWinnerSvgPath =
    partialGeometricBeam?.winner === undefined
      ? undefined
      : `${outputDirectory}/${fixtureName}-partial-geometric-beam-width-${partialGeometricBeam.experimentalWidth}.svg`
  if (partialBeamWinnerSvgPath !== undefined && partialGeometricBeam?.winner !== undefined) {
    await writeFile(
      partialBeamWinnerSvgPath,
      renderCollisionSvg(partialGeometricBeam.winner.placedCollisionGeometries)
    )
  }

  const seedArtifacts = await Promise.all(
    outcome.seedArchive.map(async (seed) => {
      const svgPath = `${outputDirectory}/${fixtureName}-${seed.role}-seed.svg`
      await writeFile(svgPath, renderCollisionSvg(seed.placedCollisionGeometries))
      return {
        role: seed.role,
        comparatorMode: seed.comparatorMode,
        canonicalGeometryIdentity: seed.canonicalGeometryIdentity,
        canonicalGeometryHash: seed.canonicalGeometryHash,
        placementCount: seed.placedCollisionGeometries.length,
        metrics: seed.metrics,
        stepTrace: seed.stepTrace,
        realSheetFit: qTurnFit(fixture.sheet, seed.placedCollisionGeometries),
        svgPath
      }
    })
  )

  const armArtifacts = await Promise.all(
    outcome.armResults.map(async (armResult) => {
      const endpoints = await Promise.all(
        armResult.endpointArchive.map(async (endpoint, index) => {
          const svgPath = `${outputDirectory}/${fixtureName}-${armResult.arm}-endpoint-${String(index + 1).padStart(2, '0')}-${endpoint.stateKey.slice(-12)}.svg`
          await writeFile(svgPath, renderCollisionSvg(endpoint.placedCollisionGeometries))
          return endpointRecord(endpoint, fixture.sheet, svgPath)
        })
      )
      return {
        arm: armResult.arm,
        trace: armResult.traces,
        cacheAggregate: aggregateCache(armResult.traces),
        endpointArchive: endpoints,
        boundedDiagnosticSamples: armResult.diagnosticSamples
      }
    })
  )

  const reconstructionArtifacts =
    reconstructionPortfolio === undefined
      ? []
      : await Promise.all(
          reconstructionPortfolio.runs.map(async (run) => {
            const svgPath =
              run.placedCollisionGeometries.length === 0
                ? undefined
                : `${outputDirectory}/${fixtureName}-reconstruction-${run.role}.svg`
            if (svgPath !== undefined) {
              await writeFile(svgPath, renderCollisionSvg(run.placedCollisionGeometries))
            }
            return {
              role: run.role,
              status: run.status,
              duplicateOf: run.duplicateOf,
              sourceEndpointHash: run.sourceEndpointHash,
              candidateMode: run.candidateMode,
              pieceIds: run.pieceIds,
              metrics: run.metrics,
              stepTrace: run.stepTrace,
              gapFillEvidence: run.gapFillEvidence,
              runtimeMs: run.runtimeMs,
              svgPath
            }
          })
        )

  const reportPath = `${outputDirectory}/report.json`
  const report = {
    experiment: 'intrinsic-v7-seed-archive-stage0-stage1',
    status: 'diagnostic-only-no-production-winner',
    sourceCommit,
    harness: { path: HARNESS_PATH, sha256: sha256(harnessBytes) },
    fixture: {
      name: fixtureName,
      path: fixture.path,
      sha256: sha256(fixtureBytes),
      sheet: { width: fixture.sheet.width, height: fixture.sheet.height },
      pieceCount: fixture.request.pieces.length,
      paddingMm: fixture.request.padding,
      settings: fixture.settings
    },
    runtime: runtimeVersions(),
    requestedArms: requestedArms ?? 'all-independent-arms',
    schedule: schedule ?? {
      maximumRuntimeMsPerArm: 60_000,
      maximumEvaluationsPerArm: 12_000,
      completedSweeps: 2,
      contractionRatios: [1 / 20, 1 / 40, 1 / 80]
    },
    triangleGolden: {
      currentMainGoldenChanged: false,
      note: 'This experiment ancestry is not current main. Triangle output is diagnostic only and cannot claim the current-main repair-8 golden.'
    },
    seedArchive: seedArtifacts,
    arms: armArtifacts,
    ...(reconstructionPortfolio === undefined
      ? {}
      : {
          reconstructionPortfolio: {
            capacity: 8,
            runtimeMs: reconstructionPortfolio.runtimeMs,
            runs: reconstructionArtifacts,
            archive: reconstructionPortfolio.archive.map(({ role, metrics }) => ({
              role,
              canonicalGeometryHash: metrics.canonicalGeometryHash,
              metrics
            })),
            winner:
              reconstructionPortfolio.winner === undefined
                ? undefined
                : {
                    role: reconstructionPortfolio.winner.role,
                    canonicalGeometryHash:
                      reconstructionPortfolio.winner.metrics.canonicalGeometryHash
                  }
          }
        }),
    ...(featureContactCollector === undefined
      ? {}
      : {
          featureContactCoverage: featureContactCollector.complete(outcome.seedArchive)
        }),
    ...(queueBeamDiscriminator === undefined || queueBeamTarget === undefined
      ? {}
      : {
          queueBeamDiscriminator: {
            mode: 'trace-only-independent-replay',
            delayedLineageSource: 'not-provided-structured-lineage-required',
            selectedRole: queueBeamTarget.role,
            selectedCandidateMode: queueBeamTarget.candidateMode,
            liveDecodeCandidateBehaviorChanged: false,
            liveDecodeRankingChanged: false,
            liveDecodeStateSelectionChanged: false,
            liveDecodeArchiveChanged: false,
            liveDecodeDeadlineChanged: false,
            result: queueBeamDiscriminator
          }
        }),
    ...(partialGeometricBeam === undefined
      ? {}
      : {
          partialGeometricBeam: {
            mode: 'stage2a-beam-only-cap-zero-reordering',
            result: {
              ...partialGeometricBeam,
              finalists: partialGeometricBeam.finalists.map(
                ({ placedCollisionGeometries: _placedCollisionGeometries, ...finalist }) => finalist
              ),
              winner:
                partialGeometricBeam.winner === undefined
                  ? undefined
                  : {
                      futureEquivalenceKey: partialGeometricBeam.winner.futureEquivalenceKey,
                      canonicalGeometryKey: partialGeometricBeam.winner.canonicalGeometryKey,
                      metrics: partialGeometricBeam.winner.metrics,
                      svgPath: partialBeamWinnerSvgPath
                    }
            }
          }
        }),
    immutableFallback: {
      role: outcome.immutableFallback.role,
      canonicalGeometryHash: outcome.immutableFallback.canonicalGeometryHash
    },
    runtimeMs: outcome.runtimeMs,
    promotion: {
      eligible: false,
      reason:
        'V7 Stage 0/1 reports exact seeds and independent probe evidence only; no production terminal comparator is invoked.'
    }
  }
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)

  const artifactPaths = [
    reportPath,
    ...seedArtifacts.map(({ svgPath }) => svgPath),
    ...armArtifacts.flatMap(({ endpointArchive }) => endpointArchive.map(({ svgPath }) => svgPath)),
    ...reconstructionArtifacts.flatMap(({ svgPath }) => (svgPath === undefined ? [] : [svgPath])),
    ...(partialBeamWinnerSvgPath === undefined ? [] : [partialBeamWinnerSvgPath])
  ]
  const manifestPath = `${outputDirectory}/manifest.json`
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        experiment: report.experiment,
        sourceCommit,
        fixture: report.fixture,
        harness: report.harness,
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
      seedSvgPaths: seedArtifacts.map(({ svgPath }) => svgPath),
      endpointSvgPaths: armArtifacts.flatMap(({ endpointArchive }) =>
        endpointArchive.map(({ svgPath }) => svgPath)
      ),
      reconstructionSvgPaths: reconstructionArtifacts.flatMap(({ svgPath }) =>
        svgPath === undefined ? [] : [svgPath]
      ),
      partialBeamWinnerSvgPath,
      runtimeMs: outcome.runtimeMs
    })
  )
}

async function runPartialBeamOnly(input: {
  readonly fixtureName: 'triangle-20' | 'mixed-61'
  readonly outputDirectory: string
  readonly sourceCommit: string
  readonly fixture: Awaited<ReturnType<typeof loadFixture>>
  readonly fixtureBytes: Uint8Array
  readonly harnessBytes: Uint8Array
  readonly preparedPieces: ReadonlyArray<IrregularPreparedPiece>
  readonly experimentalWidth: number
  readonly maximumRuntimeMs: number
  readonly maximumEvaluations: number
  readonly peelReinsertObserver: boolean
  readonly fourContributorReconstruction: boolean
  readonly peelMaximumRuntimeMs: number
  readonly peelMaximumEvaluations: number
}): Promise<void> {
  const startedAt = performance.now()
  const orderedPieceIds = input.preparedPieces.map(
    (piece) => piece.pieceId ?? piece.source.id
  )
  const orderBytes = new TextEncoder().encode(JSON.stringify(orderedPieceIds))
  const result = await Effect.runPromise(
    withLayers(
      runIntrinsicPartialGeometricBeam({
        orderedPreparedPieces: input.preparedPieces,
        finalSheet: input.fixture.sheet,
        experimentalWidth: input.experimentalWidth,
        maximumRuntimeMs: input.maximumRuntimeMs,
        maximumEvaluations: input.maximumEvaluations
      }),
      input.fixture.settings
    )
  )
  const svgPath =
    result.winner === undefined
      ? undefined
      : `${input.outputDirectory}/${input.fixtureName}-partial-geometric-beam-width-${input.experimentalWidth}.svg`
  const pngPath = svgPath === undefined ? undefined : svgPath.replace(/\.svg$/, '.png')
  if (svgPath !== undefined && pngPath !== undefined && result.winner !== undefined) {
    await writeFile(svgPath, renderCollisionSvg(result.winner.placedCollisionGeometries))
    execFileSync('node', [SVG_RENDERER_PATH, svgPath, pngPath, '1400'], {
      cwd: PROJECT_ROOT,
      stdio: 'inherit'
    })
  }
  const peelResult =
    !input.peelReinsertObserver || result.winner === undefined
      ? undefined
      : await Effect.runPromise(
          withLayers(
            runIntrinsicPeelReinsertObserver({
              orderedPreparedPieces: input.preparedPieces,
              finalSheet: input.fixture.sheet,
              seedPlacedCollisionGeometries: result.winner.placedCollisionGeometries,
              seedMetrics: result.winner.metrics,
              maximumRuntimeMs: input.peelMaximumRuntimeMs,
              maximumEvaluations: input.peelMaximumEvaluations,
              ...(input.fourContributorReconstruction
                ? {
                    subsetSizes: [4] as const,
                    distinctGeometryClassOrdersOnly: true
                  }
                : {})
            }),
            input.fixture.settings
          )
        )
  const peelSvgPath =
    peelResult?.bestEndpoint === undefined
      ? undefined
      : `${input.outputDirectory}/${input.fixtureName}-peel-reinsert-best.svg`
  const peelPngPath =
    peelSvgPath === undefined ? undefined : peelSvgPath.replace(/\.svg$/, '.png')
  if (
    peelSvgPath !== undefined &&
    peelPngPath !== undefined &&
    peelResult?.bestEndpoint !== undefined
  ) {
    await writeFile(
      peelSvgPath,
      renderCollisionSvg(peelResult.bestEndpoint.placedCollisionGeometries)
    )
    execFileSync('node', [SVG_RENDERER_PATH, peelSvgPath, peelPngPath, '1400'], {
      cwd: PROJECT_ROOT,
      stdio: 'inherit'
    })
  }
  const reportPath = `${input.outputDirectory}/report.json`
  const report = {
    schemaVersion: 1,
    experiment: 'intrinsic-v7-stage2a-partial-geometric-beam',
    status: 'diagnostic-only-no-production-promotion',
    sourceCommit: input.sourceCommit,
    harness: { path: HARNESS_PATH, sha256: sha256(input.harnessBytes) },
    fixture: {
      name: input.fixtureName,
      path: input.fixture.path,
      sha256: sha256(input.fixtureBytes),
      sheet: { width: input.fixture.sheet.width, height: input.fixture.sheet.height },
      pieceCount: input.fixture.request.pieces.length,
      paddingMm: input.fixture.request.padding,
      settings: input.fixture.settings
    },
    inputOrder: {
      source: 'prepared-priority-order',
      pieceIds: orderedPieceIds,
      sha256: sha256(orderBytes)
    },
    budget: {
      maximumRuntimeMs: input.maximumRuntimeMs,
      maximumEvaluations: input.maximumEvaluations,
      experimentalWidth: input.experimentalWidth
    },
    peelReinsertBudget: input.peelReinsertObserver
      ? {
          maximumRuntimeMs: input.peelMaximumRuntimeMs,
          maximumEvaluations: input.peelMaximumEvaluations,
          retainedWidth: 4,
          maximumContributorCount: 4,
          subsetSizes: input.fourContributorReconstruction ? [4] : [2, 3],
          distinctGeometryClassOrdersOnly: input.fourContributorReconstruction
        }
      : undefined,
    serviceOwnership: 'cold-per-beam-run',
    terminalSelection: 'canonical-q0-q90-final-sheet',
    result: {
      ...result,
      finalists: result.finalists.map(
        ({
          futureEquivalenceKey,
          canonicalGeometryKey,
          placedCollisionGeometries: _placedCollisionGeometries,
          ...finalist
        }) => ({
          ...finalist,
          futureEquivalenceDigest: sha256(new TextEncoder().encode(futureEquivalenceKey)),
          canonicalGeometryKeyHash: sha256(new TextEncoder().encode(canonicalGeometryKey))
        })
      ),
      winner:
        result.winner === undefined
          ? undefined
          : {
              canonicalGeometryHash: result.winner.canonicalGeometryHash,
              canonicalGeometryKeyHash: sha256(
                new TextEncoder().encode(result.winner.canonicalGeometryKey)
              ),
              futureEquivalenceDigest: sha256(
                new TextEncoder().encode(result.winner.futureEquivalenceKey)
              ),
              terminalRotationDeg: result.winner.terminalRotationDeg,
              metrics: result.winner.metrics,
              svgPath,
              pngPath
            }
    },
    peelReinsertObserver:
      peelResult === undefined
        ? undefined
        : {
            ...peelResult,
            bestEndpoint:
              peelResult.bestEndpoint === undefined
                ? undefined
                : {
                    removedPieceIds: peelResult.bestEndpoint.removedPieceIds,
                    reinsertionOrderPieceIds:
                      peelResult.bestEndpoint.reinsertionOrderPieceIds,
                    canonicalGeometryHash:
                      peelResult.bestEndpoint.canonicalGeometryHash,
                    metrics: peelResult.bestEndpoint.metrics,
                    source: peelResult.bestEndpoint.source,
                    strictGeometricArchiveImprovement:
                      peelResult.bestEndpoint.strictGeometricArchiveImprovement,
                    svgPath: peelSvgPath,
                    pngPath: peelPngPath
                  }
          },
    runtimeMs: Math.max(0, performance.now() - startedAt),
    promotion: {
      eligible: false,
      reason:
        'Stage 2A remains diagnostic until structured-lineage calibration and primary quality gates pass.'
    }
  }
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  const artifactPaths = [
    reportPath,
    ...(svgPath === undefined ? [] : [svgPath]),
    ...(pngPath === undefined ? [] : [pngPath]),
    ...(peelSvgPath === undefined ? [] : [peelSvgPath]),
    ...(peelPngPath === undefined ? [] : [peelPngPath])
  ]
  const manifestPath = `${input.outputDirectory}/manifest.json`
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        experiment: report.experiment,
        sourceCommit: input.sourceCommit,
        fixture: report.fixture,
        inputOrder: report.inputOrder,
        harness: report.harness,
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
  process.stdout.write(
    `${JSON.stringify({
      reportPath,
      reportSha256: sha256(await readFile(reportPath)),
      manifestPath,
      manifestSha256: sha256(await readFile(manifestPath)),
      svgPath,
      pngPath,
      peelSvgPath,
      peelPngPath,
      peelClassification: peelResult?.classification,
      runtimeMs: report.runtimeMs
    })}\n`
  )
}

async function runStructuredLineageCalibration(input: {
  readonly fixtureName: 'triangle-20' | 'mixed-61'
  readonly outputDirectory: string
  readonly sourceCommit: string
  readonly fixture: Awaited<ReturnType<typeof loadFixture>>
  readonly fixtureBytes: Uint8Array
  readonly harnessBytes: Uint8Array
  readonly preparedPieces: ReadonlyArray<IrregularPreparedPiece>
  readonly structuredLineagePath: string
  readonly maximumRuntimeMs: number
  readonly maximumEvaluations: number
}): Promise<void> {
  const lineageBytes = await readFile(input.structuredLineagePath)
  const lineage = Schema.decodeUnknownSync(StructuredLineage)(
    JSON.parse(new TextDecoder().decode(lineageBytes))
  )
  const materialized = await Effect.runPromise(
    withLayers(
      materializeStructuredLineage(input.preparedPieces, lineage, input.fixture.sheet),
      input.fixture.settings
    )
  )
  const startedAt = performance.now()
  const result = await Effect.runPromise(
    withLayers(
      runIntrinsicQueueBeamDiscriminator({
        orderedPreparedPieces: materialized.orderedPreparedPieces,
        referenceLineageCanonicalGeometryKeys: materialized.canonicalGeometryKeys,
        maximumRuntimeMs: input.maximumRuntimeMs,
        maximumEvaluations: input.maximumEvaluations
      }),
      input.fixture.settings
    )
  )
  const finalState = materialized.states[materialized.states.length - 1]
  const svgPath =
    finalState === undefined
      ? undefined
      : `${input.outputDirectory}/${input.fixtureName}-structured-lineage-final.svg`
  const pngPath = svgPath === undefined ? undefined : svgPath.replace(/\.svg$/, '.png')
  if (finalState !== undefined && svgPath !== undefined && pngPath !== undefined) {
    await writeFile(svgPath, renderCollisionSvg(finalState.placedCollisionGeometries))
    execFileSync('node', [SVG_RENDERER_PATH, svgPath, pngPath, '1400'], {
      cwd: PROJECT_ROOT,
      stdio: 'inherit'
    })
  }
  const reportPath = `${input.outputDirectory}/report.json`
  const report = {
    schemaVersion: 1,
    experiment: 'intrinsic-v7-structured-lineage-calibration',
    status: 'diagnostic-only-no-production-promotion',
    sourceCommit: input.sourceCommit,
    harness: { path: HARNESS_PATH, sha256: sha256(input.harnessBytes) },
    fixture: {
      name: input.fixtureName,
      path: input.fixture.path,
      sha256: sha256(input.fixtureBytes),
      sheet: { width: input.fixture.sheet.width, height: input.fixture.sheet.height },
      pieceCount: input.fixture.request.pieces.length,
      paddingMm: input.fixture.request.padding,
      settings: input.fixture.settings
    },
    structuredLineage: {
      path: input.structuredLineagePath,
      sha256: sha256(lineageBytes),
      stepCount: lineage.length,
      placementCount: materialized.orderedPreparedPieces.length,
      orderedPieceIds: materialized.orderedPieceIds,
      orderedPieceIdsSha256: sha256(
        new TextEncoder().encode(JSON.stringify(materialized.orderedPieceIds))
      ),
      canonicalGeometryKeyHashes: materialized.canonicalGeometryKeys.map((key) =>
        sha256(new TextEncoder().encode(key))
      ),
      finalSvgPath: svgPath,
      finalPngPath: pngPath
    },
    budget: {
      maximumRuntimeMs: input.maximumRuntimeMs,
      maximumEvaluations: input.maximumEvaluations
    },
    result,
    runtimeMs: Math.max(0, performance.now() - startedAt),
    promotion: {
      eligible: false,
      reason:
        'The structured-lineage calibration measures reachability and retention only; it does not select a production result.'
    }
  }
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  const artifactPaths = [
    reportPath,
    ...(svgPath === undefined ? [] : [svgPath]),
    ...(pngPath === undefined ? [] : [pngPath])
  ]
  const manifestPath = `${input.outputDirectory}/manifest.json`
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        experiment: report.experiment,
        sourceCommit: input.sourceCommit,
        fixture: report.fixture,
        structuredLineage: report.structuredLineage,
        harness: report.harness,
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
  process.stdout.write(
    `${JSON.stringify({
      reportPath,
      reportSha256: sha256(await readFile(reportPath)),
      manifestPath,
      manifestSha256: sha256(await readFile(manifestPath)),
      svgPath,
      pngPath,
      runtimeMs: report.runtimeMs
    })}\n`
  )
}

async function runStructuredFirstMissAudit(input: {
  readonly fixtureName: 'triangle-20' | 'mixed-61'
  readonly outputDirectory: string
  readonly sourceCommit: string
  readonly fixture: Awaited<ReturnType<typeof loadFixture>>
  readonly fixtureBytes: Uint8Array
  readonly harnessBytes: Uint8Array
  readonly preparedPieces: ReadonlyArray<IrregularPreparedPiece>
  readonly structuredLineagePath: string
  readonly depth: number
}): Promise<void> {
  const lineageBytes = await readFile(input.structuredLineagePath)
  const lineage = Schema.decodeUnknownSync(StructuredLineage)(
    JSON.parse(new TextDecoder().decode(lineageBytes))
  )
  const materialized = await Effect.runPromise(
    withLayers(
      materializeStructuredLineage(input.preparedPieces, lineage, input.fixture.sheet),
      input.fixture.settings
    )
  )
  const expectedState = materialized.states[input.depth]
  const piece = materialized.orderedPreparedPieces[input.depth]
  const parentState =
    input.depth === 0
      ? IrregularBeamState.empty(materialized.orderedPreparedPieces)
      : materialized.states[input.depth - 1]
  if (expectedState === undefined || piece === undefined || parentState === undefined) {
    throw new Error(`structured first-miss depth ${input.depth} is unavailable`)
  }
  const result = await Effect.runPromise(
    withLayers(
      auditIntrinsicReferenceSuccessorReachability({
        parentState,
        expectedState,
        piece,
        remainingPreparedPieces: materialized.orderedPreparedPieces.slice(input.depth + 1)
      }),
      input.fixture.settings
    )
  )
  const reportPath = `${input.outputDirectory}/report.json`
  const report = {
    schemaVersion: 1,
    experiment: 'intrinsic-v7-structured-first-miss-audit',
    status: 'diagnostic-only-no-production-promotion',
    sourceCommit: input.sourceCommit,
    harness: { path: HARNESS_PATH, sha256: sha256(input.harnessBytes) },
    fixture: {
      name: input.fixtureName,
      path: input.fixture.path,
      sha256: sha256(input.fixtureBytes),
      sheet: { width: input.fixture.sheet.width, height: input.fixture.sheet.height },
      pieceCount: input.fixture.request.pieces.length,
      paddingMm: input.fixture.request.padding,
      settings: input.fixture.settings
    },
    historicalPose: {
      path: input.structuredLineagePath,
      sha256: sha256(lineageBytes),
      depth: input.depth,
      parentCanonicalGeometryHash: sha256(
        new TextEncoder().encode(parentState.canonicalOccupiedGeometryKey)
      ),
      expectedCanonicalGeometryHash: sha256(
        new TextEncoder().encode(expectedState.canonicalOccupiedGeometryKey)
      )
    },
    result,
    interpretation:
      'The audit classifies one historical transition only. It does not establish delayed value, beam capacity, or production quality.'
  }
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  const manifestPath = `${input.outputDirectory}/manifest.json`
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        experiment: report.experiment,
        sourceCommit: input.sourceCommit,
        fixture: report.fixture,
        historicalPose: report.historicalPose,
        harness: report.harness,
        files: { [reportPath]: sha256(await readFile(reportPath)) }
      },
      null,
      2
    )}\n`
  )
  process.stdout.write(
    `${JSON.stringify({
      reportPath,
      reportSha256: sha256(await readFile(reportPath)),
      manifestPath,
      manifestSha256: sha256(await readFile(manifestPath)),
      classification: result.classification
    })}\n`
  )
}

function materializeStructuredLineage(
  preparedPieces: ReadonlyArray<IrregularPreparedPiece>,
  lineage: Schema.Schema.Type<typeof StructuredLineage>,
  sheet: SheetSpec
): Effect.Effect<
  {
    readonly orderedPreparedPieces: ReadonlyArray<IrregularPreparedPiece>
    readonly orderedPieceIds: ReadonlyArray<PieceId>
    readonly canonicalGeometryKeys: ReadonlyArray<string>
    readonly states: ReadonlyArray<IrregularBeamState>
  },
  unknown,
  GeometryKernel
> {
  return Effect.gen(function* () {
    const geometryKernel = yield* GeometryKernel
    const piecesById = new Map(
      preparedPieces.map((piece) => [piece.pieceId ?? piece.source.id, piece] as const)
    )
    const orderedPieceIds: PieceId[] = []
    const canonicalGeometryKeys: string[] = []
    const states: IrregularBeamState[] = []
    let previousIds = new Set<PieceId>()

    for (let index = 0; index < lineage.length; index += 1) {
      const step = lineage[index]
      if (step === undefined || step.stepIndex !== index) {
        throw new Error(`structured lineage step ${index} is missing or misnumbered`)
      }
      const currentIds = new Set(step.placements.map(({ pieceId }) => pieceId))
      if (currentIds.size !== step.placements.length) {
        throw new Error(`structured lineage step ${index} contains duplicate piece ids`)
      }
      if (index === 0) {
        if (currentIds.size !== 0) {
          throw new Error('structured lineage step 0 must be empty')
        }
        previousIds = currentIds
        continue
      }
      const removedIds = [...previousIds].filter((pieceId) => !currentIds.has(pieceId))
      const addedIds = [...currentIds].filter((pieceId) => !previousIds.has(pieceId))
      if (removedIds.length !== 0 || addedIds.length !== 1) {
        throw new Error(
          `structured lineage step ${index} must add exactly one piece without removing any`
        )
      }
      const addedPieceId = addedIds[0]
      if (addedPieceId === undefined) {
        throw new Error(`structured lineage step ${index} did not add a piece`)
      }
      orderedPieceIds.push(addedPieceId)
      const placedCollisionGeometries: IrregularPlacedPiece[] = []
      for (const placement of step.placements) {
        const piece = piecesById.get(placement.pieceId)
        if (piece === undefined) {
          throw new Error(`structured lineage piece ${placement.pieceId} is unavailable`)
        }
        const transform = piece.transforms.find(
          (candidate) =>
            candidate.mirrored === placement.mirrored &&
            circularDegreeDistance(candidate.rotationDeg, placement.rotationDeg) <= 0.01
        )
        if (transform === undefined) {
          throw new Error(
            `structured lineage transform ${placement.rotationDeg}/${placement.mirrored} is unavailable for ${placement.pieceId}`
          )
        }
        const collisionGeometry = yield* geometryKernel.transformCollisionGeometry({
          geometry: piece.collisionGeometry,
          transform
        })
        placedCollisionGeometries.push(
          new IrregularPlacedPiece({
            placement: new IrregularPlacement({
              pieceId: placement.pieceId,
              sourcePieceId: piece.source.id,
              placementReference: piece.collisionGeometry.placementReference,
              transform: new IrregularTransform({
                translateX: placement.translateX,
                translateY: placement.translateY,
                rotationDeg: transform.rotationDeg,
                mirrored: transform.mirrored
              })
            }),
            collisionGeometry
          })
        )
      }
      const state = new IrregularBeamState({
        remainingPreparedPieces: preparedPieces.filter(
          (piece) => !currentIds.has(piece.pieceId ?? piece.source.id)
        ),
        placedCollisionGeometries,
        placementOrder: orderedPieceIds
      }).withBottomLeftAnchored()
      if (state === undefined) {
        throw new Error(`structured lineage step ${index} could not be anchored`)
      }
      if (!assertCanonicalGridLegalLayout(sheet, state.placedCollisionGeometries)) {
        throw new Error(`structured lineage step ${index} is not canonically legal`)
      }
      states.push(state)
      canonicalGeometryKeys.push(state.canonicalOccupiedGeometryKey)
      previousIds = currentIds
    }
    if (orderedPieceIds.length !== preparedPieces.length) {
      throw new Error(
        `structured lineage placed ${orderedPieceIds.length} of ${preparedPieces.length} prepared pieces`
      )
    }
    return {
      orderedPreparedPieces: orderedPieceIds.map((pieceId) => {
        const piece = piecesById.get(pieceId)
        if (piece === undefined) throw new Error(`ordered piece ${pieceId} is unavailable`)
        return piece
      }),
      orderedPieceIds,
      canonicalGeometryKeys,
      states
    }
  })
}

function circularDegreeDistance(first: number, second: number): number {
  const distance = Math.abs(((first - second) % 360 + 360) % 360)
  return Math.min(distance, 360 - distance)
}

function selectQueueBeamAuditTarget(portfolio: IntrinsicReconstructionPortfolioResult) {
  const nonBaseline = portfolio.archive.find(
    ({ role, candidateMode }) =>
      role !== 'canonical-grid' &&
      role !== 'legacy-absolute-envelope' &&
      candidateMode === 'pure-growth'
  )
  const fallback = portfolio.archive.find(({ candidateMode }) => candidateMode === 'pure-growth')
  const selected = nonBaseline ?? fallback
  if (selected === undefined) {
    throw new Error('queue-beam audit requires one completed pure-growth reconstruction run')
  }
  return selected
}

function orderedPiecesForRun(
  pieces: ReadonlyArray<IrregularPreparedPiece>,
  pieceIds: ReadonlyArray<PieceId>
): ReadonlyArray<IrregularPreparedPiece> {
  const byId = new Map(pieces.map((piece) => [piece.pieceId ?? piece.source.id, piece] as const))
  return pieceIds.map((pieceId) => {
    const piece = byId.get(pieceId)
    if (piece === undefined) throw new Error(`queue-beam audit piece ${pieceId} is unavailable`)
    return piece
  })
}

function positiveIntegerArgument(name: string, fallback: number): number {
  const raw = argument(name)
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`)
  }
  return value
}

function nonNegativeIntegerArgument(name: string, fallback: number): number {
  const raw = argument(name)
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`)
  }
  return value
}

type FeatureCandidateObservation = Parameters<
  IntrinsicV7FeatureContactObserver['onSeedCandidateProvenance']
>[0]
type FeatureSelectionObservation = Parameters<
  IntrinsicV7FeatureContactObserver['onSeedStepSelection']
>[0]

const FEATURE_SOURCE_NAMES = [
  'ifpCorner',
  'nfpVertex',
  'antiparallelEdgeSupport',
  'ifpNfpIntersection',
  'nfpNfpIntersection'
] as const

/**
 * Keeps F0 source evidence aggregate-only. Stage 1 does not request a fresh
 * NFP decode, so its global transport moves intentionally have no F0 rows.
 */
class FeatureContactCoverageCollector implements IntrinsicV7FeatureContactObserver {
  readonly pending = new Map<string, FeatureCandidateObservation[]>()
  readonly rows: FeatureCoverageRow[] = []
  readonly stepZeroSelections: FeatureSelectionObservation[] = []
  readonly firstLiveLegalWitnesses = new Map<
    (typeof FEATURE_SOURCE_NAMES)[number],
    {
      readonly seedRole: string
      readonly step: number
      readonly parentStateId: string
      readonly pieceId: string
      readonly transform: string
      readonly gridX: number
      readonly gridY: number
      readonly sourceMask: number
    }
  >()

  onSeedCandidateProvenance(observation: FeatureCandidateObservation): void {
    const key = featureSelectionKey(observation.seedRole, observation.observation)
    const pending = this.pending.get(key) ?? []
    pending.push(observation)
    this.pending.set(key, pending)
    for (const source of FEATURE_SOURCE_NAMES) {
      if (this.firstLiveLegalWitnesses.has(source)) continue
      const sourceMask = NFP_IFP_CANDIDATE_SOURCE_MASK[source]
      const point = observation.observation.provenance.legalCandidateSources.find(
        (candidate) => (candidate.sourceMask & sourceMask) !== 0
      )
      if (point === undefined) continue
      this.firstLiveLegalWitnesses.set(source, {
        seedRole: observation.seedRole,
        step: observation.observation.step,
        parentStateId: observation.observation.parentStateId,
        pieceId: observation.observation.pieceId,
        transform: transformIdentity(observation.observation.transform),
        gridX: point.gridX,
        gridY: point.gridY,
        sourceMask: point.sourceMask
      })
    }
  }

  onSeedStepSelection(observation: FeatureSelectionObservation): void {
    const key = featureSelectionKey(observation.seedRole, observation.observation)
    const candidates = this.pending.get(key) ?? []
    if (candidates.length === 0) this.stepZeroSelections.push(observation)
    for (const candidate of candidates) {
      this.rows.push(featureCoverageRow(candidate, observation))
    }
    this.pending.delete(key)
  }

  complete(
    seedArchive: ReadonlyArray<{
      readonly role: string
      readonly placedCollisionGeometries: ReadonlyArray<IrregularPlacedPiece>
    }>
  ) {
    if (this.pending.size > 0) {
      throw new Error('F0 feature-contact observer did not receive every strict seed selection.')
    }
    const rows = this.rows
    const witnesses = FEATURE_SOURCE_NAMES.map((source) => {
      const row = rows.find((candidate) => candidate.rawBySource[source] > 0)
      const legalPoint = this.firstLiveLegalWitnesses.get(source)
      return {
        source,
        status:
          row === undefined
            ? source === 'ifpCorner' || source === 'ifpNfpIntersection'
              ? 'structurally-unavailable-in-sheetless-seed-scope'
              : 'not-observed'
            : legalPoint === undefined
              ? 'raw-only-no-live-legal-point'
              : 'live-legal-point-observed',
        seedRole: legalPoint?.seedRole ?? row?.seedRole,
        step: legalPoint?.step ?? row?.step,
        parentStateId: legalPoint?.parentStateId ?? row?.parentStateId,
        pieceId: legalPoint?.pieceId ?? row?.pieceId,
        transform: legalPoint?.transform ?? row?.transform,
        gridPoint:
          legalPoint === undefined
            ? undefined
            : {
                gridX: legalPoint.gridX,
                gridY: legalPoint.gridY,
                sourceMask: legalPoint.sourceMask
              }
      }
    })
    return {
      mode: 'F0-observer-only',
      scope: {
        seedDecodes: 'two strict Stage 0 seeds',
        stage1Arms:
          'no rows: Stage 1 transport/refinement does not request a fresh NFP/IFP decode or reconstruction',
        candidateBehaviorChanged: false,
        scoringBehaviorChanged: false,
        transformPolicyChanged: false,
        instrumentationTimeIncludedInDecodeBudget: true,
        memoizedProvenanceReplayEnabled: true,
        candidateDomain: 'sheetless-nfp',
        structurallyUnavailableSourceFamilies: ['ifpCorner', 'ifpNfpIntersection']
      },
      rows,
      gapClassification: {
        candidateTransformsWithEnclosedCavities: rows.filter(
          ({ gapCoverage }) => gapCoverage.enclosedRegionCount > 0
        ).length,
        candidateTransformsWithHullOpenGaps: rows.filter(
          ({ gapCoverage }) => gapCoverage.hullOpenRegionCount > 0
        ).length,
        directLegalInEnclosedCavities: rows.reduce(
          (sum, { gapCoverage }) => sum + gapCoverage.directLegalInEnclosedCavity,
          0
        ),
        directLegalInHullOpenGaps: rows.reduce(
          (sum, { gapCoverage }) => sum + gapCoverage.directLegalInHullOpenGap,
          0
        ),
        canonicalLegalInEnclosedCavities: rows.reduce(
          (sum, { gapCoverage }) => sum + gapCoverage.canonicalLegalInEnclosedCavity,
          0
        ),
        canonicalLegalInHullOpenGaps: rows.reduce(
          (sum, { gapCoverage }) => sum + gapCoverage.canonicalLegalInHullOpenGap,
          0
        ),
        selectedEnclosedCavityPlacements: rows.filter(
          ({ selectedGap }) => selectedGap?.kind === 'enclosed-cavity'
        ).length,
        selectedHullOpenGapPlacements: rows.filter(
          ({ selectedGap }) => selectedGap?.kind === 'hull-open-gap'
        ).length
      },
      boundedWitnesses: witnesses,
      stepZeroSelections: this.stepZeroSelections.map(({ seedRole, observation }) => ({
        seedRole,
        step: observation.step,
        parentStateId: observation.parentStateId,
        pieceId: observation.pieceId,
        selectedTransform:
          observation.selectedTransform === undefined
            ? undefined
            : transformIdentity(observation.selectedTransform),
        selectedGridPoint: observation.selectedGridPoint,
        selectedGap: observation.selectedGap
      })),
      canonicalSeedEndpoints: seedArchive.map((seed) => ({
        seedRole: seed.role,
        canonicalChecked: true,
        canonicalLegal: isIntrinsicCanonicalLayoutLegal(seed.placedCollisionGeometries)
      }))
    }
  }
}

interface FeatureCoverageRow {
  readonly seedRole: string
  readonly arm: 'stage0-seed-construction'
  readonly step: number
  readonly parentStateId: string
  readonly pieceId: string
  readonly transform: string
  readonly rawBySource: FeatureCandidateObservation['observation']['provenance']['rawBySource']
  readonly uniqueBySourceMask: FeatureCandidateObservation['observation']['provenance']['uniqueBySourceMask']
  readonly outsideIfp: number
  readonly nfpInteriorRejected: number
  readonly liveConvexRejected: number
  readonly liveConvexLegal: number
  readonly phaseIncompatible: number | 'not-evaluated'
  readonly canonicalChecked: number | 'not-evaluated'
  readonly canonicalLegal: number | 'not-evaluated'
  readonly gapCoverage: FeatureCandidateObservation['observation']['gapCoverage']
  readonly selectedCandidate:
    | { readonly gridX: number; readonly gridY: number; readonly sourceMask: number }
    | undefined
  readonly selectedGap: FeatureSelectionObservation['observation']['selectedGap']
  readonly selectionAttribution:
    | 'transform-not-selected'
    | 'selected-source-observed'
    | 'selected-source-missing'
  readonly localFanoutRetained: number
  readonly localFanoutEvictedByReason: { readonly strictSeedNotSelected: number }
}

function featureCoverageRow(
  candidate: FeatureCandidateObservation,
  selection: FeatureSelectionObservation
): FeatureCoverageRow {
  const { seedRole, observation } = candidate
  const selected =
    selection.observation.selectedTransform !== undefined &&
    sameTransform(selection.observation.selectedTransform, observation.transform) &&
    selection.observation.selectedGridPoint !== undefined
      ? selection.observation.selectedGridPoint
      : undefined
  const selectedSource =
    selected === undefined
      ? undefined
      : observation.provenance.legalCandidateSources.find(
          ({ gridX, gridY }) => gridX === selected.gridX && gridY === selected.gridY
        )
  const uniqueLegalCandidateCount = observation.provenance.legalCandidateSources.length
  return {
    seedRole,
    arm: 'stage0-seed-construction',
    step: observation.step,
    parentStateId: observation.parentStateId,
    pieceId: observation.pieceId,
    transform: transformIdentity(observation.transform),
    rawBySource: observation.provenance.rawBySource,
    uniqueBySourceMask: observation.provenance.uniqueBySourceMask,
    outsideIfp: observation.provenance.outsideIfp,
    nfpInteriorRejected: observation.provenance.nfpInteriorRejected,
    liveConvexRejected: observation.provenance.liveConvexRejected,
    liveConvexLegal: observation.provenance.liveConvexLegal,
    phaseIncompatible: observation.provenance.phaseIncompatible,
    canonicalChecked: observation.provenance.canonicalChecked,
    canonicalLegal: observation.provenance.canonicalLegal,
    gapCoverage: observation.gapCoverage,
    selectedCandidate:
      selectedSource === undefined
        ? undefined
        : {
            gridX: selectedSource.gridX,
            gridY: selectedSource.gridY,
            sourceMask: selectedSource.sourceMask
          },
    selectionAttribution:
      selected === undefined
        ? 'transform-not-selected'
        : selectedSource === undefined
          ? 'selected-source-missing'
          : 'selected-source-observed',
    selectedGap:
      selected === undefined || selection.observation.selectedGap === undefined
        ? undefined
        : selection.observation.selectedGap,
    // Strict seeds retain a single winner, not a production fanout. The
    // counts below are therefore selection facts, never fabricated fanout history.
    localFanoutRetained: selectedSource === undefined ? 0 : 1,
    localFanoutEvictedByReason:
      selectedSource === undefined
        ? { strictSeedNotSelected: uniqueLegalCandidateCount }
        : { strictSeedNotSelected: Math.max(0, uniqueLegalCandidateCount - 1) }
  }
}

function featureSelectionKey(
  seedRole: string,
  observation: { readonly step: number; readonly parentStateId: string; readonly pieceId: string }
): string {
  return `${seedRole}:${observation.step}:${observation.parentStateId}:${observation.pieceId}`
}

function transformIdentity(transform: {
  readonly index: number
  readonly rotationDeg: number
  readonly mirrored: boolean
  readonly reason: string
}): string {
  return `${transform.index}:${transform.rotationDeg}:${transform.mirrored ? 'mirror' : 'plain'}:${transform.reason}`
}

function sameTransform(
  first: {
    readonly index: number
    readonly rotationDeg: number
    readonly mirrored: boolean
    readonly reason: string
  },
  second: {
    readonly index: number
    readonly rotationDeg: number
    readonly mirrored: boolean
    readonly reason: string
  }
): boolean {
  return transformIdentity(first) === transformIdentity(second)
}

function isIntrinsicCanonicalLayoutLegal(placed: ReadonlyArray<IrregularPlacedPiece>): boolean {
  const points = placed.flatMap(({ placement, collisionGeometry }) =>
    collisionGeometry.polygon.points.map((point) => ({
      x: point.x + placement.transform.translateX,
      y: point.y + placement.transform.translateY
    }))
  )
  const maximumX = Math.max(1, ...points.map(({ x }) => x))
  const maximumY = Math.max(1, ...points.map(({ y }) => y))
  return assertCanonicalGridLegalLayout(
    new SheetSpec({
      width: Math.ceil(maximumX),
      height: Math.ceil(maximumY),
      label: 'intrinsic-f0-canonical-boundary'
    }),
    placed
  )
}

function requiredFixture(value: string | undefined): 'triangle-20' | 'mixed-61' {
  if (value === 'triangle-20' || value === 'mixed-61') return value
  throw new Error('--fixture must be triangle-20 or mixed-61')
}

function requiredArgument(name: string): string {
  const value = argument(name)
  if (value === undefined) throw new Error(`${name} is required for immutable diagnostic evidence`)
  return value
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}

function parseArms(value: string | undefined): ReadonlyArray<IntrinsicV7Stage1Arm> | undefined {
  if (value === undefined) return undefined
  const arms = value
    .split(',')
    .filter(
      (arm): arm is IntrinsicV7Stage1Arm =>
        arm === 'control' || arm === 'split' || arm === 'atomic' || arm === 'refine'
    )
  if (arms.length === 0 || arms.join(',') !== value) {
    throw new Error('--arms must be a comma-separated subset of control,split,atomic,refine')
  }
  return [...new Set(arms)]
}

async function loadFixture(name: 'triangle-20' | 'mixed-61'): Promise<{
  readonly path: string
  readonly bytes: Uint8Array
  readonly request: NestingRequest
  readonly sheet: SheetSpec
  readonly settings: IrregularNestingSettings
}> {
  if (name === 'triangle-20') {
    const request = makeTriangleRequest()
    const bytes = new TextEncoder().encode(JSON.stringify(request))
    const settings = request.options.irregularSettings
    if (settings === undefined) throw new Error('triangle fixture has no irregular settings')
    return {
      path: 'generated:triangle-20',
      bytes,
      request,
      sheet: TRIANGLE_SHEET,
      settings
    }
  }
  const bytes = await readFile(MIXED_FIXTURE_PATH)
  const request = Schema.decodeUnknownSync(NestingRequest)(JSON.parse(bytes.toString('utf8')))
  const settings = request.options.irregularSettings
  if (settings === undefined) throw new Error('mixed-61 fixture has no irregular settings')
  return {
    path: MIXED_FIXTURE_PATH,
    bytes,
    request,
    sheet: request.sheet,
    settings
  }
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
  const prepared = prepareNestingPieces(
    sources,
    TRIANGLE_SHEET,
    10,
    JobId.make('triangle-v7-seed-archive-diagnostic'),
    undefined,
    undefined,
    () => 'triangle-70x60'
  )
  if (prepared.warnings.length > 0) throw new Error(prepared.warnings.join('; '))
  const settings = new IrregularNestingSettings({
    geometry: DEFAULT_IRREGULAR_GEOMETRY_SETTINGS,
    optimizer: makeCompactQualityIrregularOptimizerSettings()
  })
  return new NestingRequest({
    version: 1,
    jobId: JobId.make('triangle-v7-seed-archive-diagnostic'),
    sheet: TRIANGLE_SHEET,
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

function withLayers<A, E, R>(effect: Effect.Effect<A, E, R>, settings: IrregularNestingSettings) {
  return effect.pipe(
    Effect.provide(GeometryKernel.Live),
    Effect.provide(CollisionGeometryBuilder.Live),
    Effect.provide(TransformGeneratorLive),
    Effect.provide(NfpIfpServiceLive),
    Effect.provide(Layer.succeed(GeometrySettings, settings))
  )
}

function prepareIrregularPieces(
  request: NestingRequest
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
        settings:
          request.options.irregularSettings?.optimizer ??
          makeCompactQualityIrregularOptimizerSettings()
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

function endpointRecord(endpoint: IntrinsicV7Endpoint, sheet: SheetSpec, svgPath: string) {
  return {
    seedRole: endpoint.seedRole,
    stateKey: endpoint.stateKey,
    terminalIdentity: endpoint.terminalIdentity,
    placementCount: endpoint.placedCollisionGeometries.length,
    metrics: endpoint.metric,
    realSheetFit: qTurnFit(sheet, endpoint.placedCollisionGeometries),
    svgPath
  }
}

function qTurnFit(sheet: SheetSpec, placed: ReadonlyArray<IrregularPlacedPiece>) {
  const state = new IrregularBeamState({
    remainingPreparedPieces: [],
    placedCollisionGeometries: placed,
    placementOrder: placed.map(({ placement }) => placement.pieceId ?? placement.sourcePieceId)
  })
  const q0 = state.withQuarterTurnBottomLeft(0)
  const q90 = state.withQuarterTurnBottomLeft(90)
  return {
    q0: q0 !== undefined && assertCanonicalGridLegalLayout(sheet, q0.placedCollisionGeometries),
    q90: q90 !== undefined && assertCanonicalGridLegalLayout(sheet, q90.placedCollisionGeometries)
  }
}

function aggregateCache(
  traces: ReadonlyArray<{
    readonly phaseCache: {
      readonly requestCount: number
      readonly cacheHitCount: number
      readonly cacheMissCount: number
    }
  }>
) {
  return traces.reduce(
    (total, { phaseCache }) => ({
      requestCount: total.requestCount + phaseCache.requestCount,
      cacheHitCount: total.cacheHitCount + phaseCache.cacheHitCount,
      cacheMissCount: total.cacheMissCount + phaseCache.cacheMissCount
    }),
    { requestCount: 0, cacheHitCount: 0, cacheMissCount: 0 }
  )
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
    .map((polygon) => `<polygon points="${polygon.map(({ x, y }) => `${x},${-y}`).join(' ')}"/>`)
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX - margin} ${-maxY - margin} ${maxX - minX + margin * 2} ${maxY - minY + margin * 2}" width="1600" height="1200"><rect x="${minX - margin}" y="${-maxY - margin}" width="${maxX - minX + margin * 2}" height="${maxY - minY + margin * 2}" fill="#151d22"/><g fill="#26343d" stroke="#39a9ff" stroke-width="1" vector-effect="non-scaling-stroke">${paths}</g></svg>`
}

function verifiedSourceCommit(requestedCommit: string | undefined): string {
  const head = gitOutput(['rev-parse', 'HEAD'])
  if (requestedCommit !== undefined && requestedCommit !== head) {
    throw new Error(`--source-commit ${requestedCommit} does not match checked-out HEAD ${head}`)
  }
  const status = gitOutput(['status', '--porcelain', '--untracked-files=all'])
  if (status !== '') throw new Error('the V7 evidence harness requires a clean worktree')
  return head
}

function gitOutput(arguments_: ReadonlyArray<string>): string {
  return execFileSync('git', arguments_, { cwd: PROJECT_ROOT, encoding: 'utf8' }).trim()
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

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

await main()
