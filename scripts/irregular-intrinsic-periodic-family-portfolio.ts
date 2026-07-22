import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
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
  IrregularPreparedPiece,
  IrregularPriorityOrderKey,
  type IrregularNestingSettings as IrregularSettings
} from '../src/shared/irregular/domain.js'
import { makePresetShapeDocument, type PresetShapeKind } from '../src/shared/presetShapes.js'
import { preparePieces as prepareNestingPieces } from '../src/shared/preparePieces.js'
import { IrregularBeamState } from '../src/workers/algorithm/irregular/irregularBeamState.js'
import { projectIntrinsicLayoutExactly } from '../src/workers/algorithm/irregular/intrinsicExactProjection.js'
import { runIntrinsicGlobalSqueezePortfolio } from '../src/workers/algorithm/irregular/intrinsicGlobalSqueezePortfolio.js'
import { runIntrinsicPeriodicFamilyPortfolio } from '../src/workers/algorithm/irregular/intrinsicPeriodicFamilyPortfolio.js'
import {
  INTRINSIC_GLOBAL_SEARCH_DEFAULTS,
  runIntrinsicSqueezeDisruptSeparateWithSchedule,
  type IntrinsicContractedPressureAttemptTrace
} from '../src/workers/algorithm/irregular/intrinsicSqueezeDisruptSeparate.js'
import {
  measureIntrinsicSheetlessCompletedLayout,
  rankIntrinsicStrictCompletedLayouts
} from '../src/workers/algorithm/irregular/intrinsicStrictDecoder.js'
import {
  MAXIMUM_EDGE_CONTACT_BASIS_CANDIDATES_PER_DERIVATION,
  MAXIMUM_EDGE_CONTACT_PAIR_VALIDATION_ATTEMPTS_PER_DERIVATION,
  MAXIMUM_EDGE_CONTACT_RELATIONS_PER_DERIVATION,
  MAXIMUM_NFP_BOUNDARY_VERTEX_BASIS_CANDIDATES
} from '../src/workers/algorithm/irregular/intrinsicPeriodicCells.js'
import { sortPiecesForNesting } from '../src/workers/algorithm/sortPiecesForNesting.js'
import { CollisionGeometryBuilder } from '../src/workers/irregular/collisionGeometryBuilder.js'
import { GeometryKernel, GeometrySettings } from '../src/workers/irregular/geometryKernel.js'
import { NfpIfpServiceLive } from '../src/workers/irregular/nfpIfpService.js'
import { TransformGenerator } from '../src/workers/irregular/services.js'
import { TransformGeneratorLive } from '../src/workers/irregular/transformGenerator.js'

type FixtureName = 'triangle-20' | 'rectangles-20' | 'pentagons-20' | 'mixed-61'

interface GeneratedFixture {
  readonly name: FixtureName
  readonly kind: PresetShapeKind
  readonly width: number
  readonly height: number
}

const MIXED_FIXTURE = fileURLToPath(
  new URL('../tests/fixtures/irregularSheetInvariance/mixed61-request.json', import.meta.url)
)
const ROOMY_SHEET = new SheetSpec({ width: 2000, height: 2700, label: 'periodic portfolio roomy' })

const generatedFixtures: Readonly<Record<Exclude<FixtureName, 'mixed-61'>, GeneratedFixture>> = {
  'triangle-20': { name: 'triangle-20', kind: 'triangle', width: 70, height: 60 },
  'rectangles-20': { name: 'rectangles-20', kind: 'rectangle', width: 154, height: 104 },
  'pentagons-20': { name: 'pentagons-20', kind: 'pentagon', width: 90, height: 90 }
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}

function positiveIntegerArgument(name: string, fallback: number): number {
  const value = argument(name)
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`)
  return parsed
}

function optionalPositiveIntegerArgument(name: string): number | undefined {
  const value = argument(name)
  if (value === undefined) return undefined
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`)
  }
  return parsed
}

function requiredFixture(value: string | undefined): FixtureName {
  if (
    value === 'triangle-20' ||
    value === 'rectangles-20' ||
    value === 'pentagons-20' ||
    value === 'mixed-61'
  ) {
    return value
  }
  throw new Error('--fixture must be triangle-20, rectangles-20, pentagons-20, or mixed-61')
}

const fixtureName = requiredFixture(argument('--fixture'))
const outputDirectory =
  argument('--output') ??
  `/private/tmp/min-plane-provenance/v7-periodic-family-portfolio/${fixtureName}`
const sourceCommit = argument('--source-commit') ?? 'unknown'
const maximumCellsPerFamilyRole = positiveIntegerArgument('--cells-per-role', 16)
const maximumCropsPerCell = positiveIntegerArgument('--crops-per-cell', 4)
const maximumContinuationCount = positiveIntegerArgument('--continuations', 8)
const maximumCatalogRuntimeMs = positiveIntegerArgument('--catalog-ms', 15_000)
const maximumContinuationRuntimeMs = positiveIntegerArgument('--continuation-ms', 25_000)
const maximumTotalRuntimeMs = positiveIntegerArgument('--fixture-ms', 240_000)
const maximumContinuationCandidateEvaluations = optionalPositiveIntegerArgument(
  '--continuation-evaluations'
)
const basisSourceKey = argument('--basis-source-key')
const captureSourceSurvivalAudit = process.argv.includes('--source-survival-audit')
const admitSourceAuditWitnesses = process.argv.includes('--admit-raw-witnesses')
if (admitSourceAuditWitnesses && !captureSourceSurvivalAudit) {
  throw new Error('--admit-raw-witnesses requires --source-survival-audit')
}
const adaptivePressurePilot = process.argv.includes('--adaptive-pressure-pilot')
const adaptiveRestartAblation = process.argv.includes('--adaptive-restart-ablation')
const adaptivePressureMatrix = process.argv.includes('--adaptive-pressure-matrix')
const adaptiveMatrixArmsArgument = argument('--adaptive-matrix-arms')
const requestedAdaptiveSeedHash = argument('--adaptive-seed-hash')
await mkdir(outputDirectory, { recursive: true })

const fixture = await loadFixture(fixtureName)
const settings = fixture.request.options.irregularSettings
if (settings === undefined) throw new Error(`${fixtureName} has no irregular settings`)
const preparedPieces = await Effect.runPromise(withLayers(preparePieces(fixture.request, settings), settings))
const result = await Effect.runPromise(
  withLayers(
    runIntrinsicPeriodicFamilyPortfolio(fixture.request.sheet, preparedPieces, {
      maximumCatalogRuntimeMs,
      maximumCellsPerFamilyRole,
      maximumCropsPerCell,
      maximumContinuationCount,
      maximumContinuationRuntimeMs,
      maximumTotalRuntimeMs,
      ...(maximumContinuationCandidateEvaluations === undefined
        ? {}
        : { maximumContinuationCandidateEvaluations }),
      captureSourceSurvivalAudit,
      admitSourceAuditWitnesses,
      ...(basisSourceKey === undefined ? {} : { basisSourceKey })
    }),
    settings
  )
)

const artifactPaths: string[] = []
const runs = []
const basisSourceVariantCounts = new Map<string, number>()
for (const family of result.catalog.families) {
  for (const cell of family.cells) {
    const sourceKey = cell.basisProvenance?.sourceKey
    if (sourceKey !== undefined) {
      basisSourceVariantCounts.set(sourceKey, (basisSourceVariantCounts.get(sourceKey) ?? 0) + 1)
    }
  }
}
for (const run of result.runs) {
  const placed = run.result?.placedCollisionGeometries
  const svgPath =
    placed === undefined
      ? undefined
      : `${outputDirectory}/${fixtureName}-${safePath(run.continuation.sourceId)}.svg`
  if (svgPath !== undefined && placed !== undefined) {
    await writeFile(svgPath, renderSvg(placed))
    artifactPaths.push(svgPath)
  }
  runs.push({
    sourceId: run.continuation.sourceId,
    role: run.continuation.role,
    familyKeySha256: sha256(run.continuation.familyKey),
    cellKeySha256: sha256(run.continuation.cellKey),
    basisSourceKey: run.continuation.basisSourceKey,
    basisSourceKeySha256:
      run.continuation.basisSourceKey === undefined
        ? undefined
        : sha256(run.continuation.basisSourceKey),
    seed: {
      canonicalKeySha256: sha256(run.continuation.seed.canonicalKey),
      placementCount: run.continuation.seed.placements.length,
      componentCount: run.continuation.seed.componentCount,
      isolatedPieceCount: run.continuation.seed.isolatedPieceCount,
      largestComponentSize: run.continuation.seed.largestComponentSize,
      maximumSideMm: run.continuation.seed.maximumSideMm,
      envelopeAreaMm2: run.continuation.seed.envelopeAreaMm2,
      envelopeSpanMm: run.continuation.seed.envelopeSpanMm,
      crop: run.continuation.seed.crop,
      placements: run.continuation.seed.placements.map(({ placement }) => ({
        pieceId: placement.pieceId,
        sourcePieceId: placement.sourcePieceId,
        rotationDeg: placement.transform.rotationDeg,
        mirrored: placement.transform.mirrored,
        translateX: placement.transform.translateX,
        translateY: placement.transform.translateY
      }))
    },
    status: run.status,
    reason: run.reason,
    runtimeMs: run.runtimeMs,
    ...(maximumContinuationCandidateEvaluations === undefined
      ? {}
      : {
          candidateEvaluationCount: run.constructed?.candidateEvaluationCount,
          truncationReason: run.constructed?.truncationReason
        }),
    metrics: run.result?.metrics,
    certificate: run.result?.certificate,
    canonicalGeometryHash: run.result?.canonicalGeometryHash,
    svgPath
  })
}

const reportPath = `${outputDirectory}/report.json`
const auditWitnesses = await Promise.all(
  result.sourceAuditWitnesses.map(async (witness, index) => {
    const svgPath = `${outputDirectory}/${fixtureName}-raw-crop-pareto-${String(index + 1).padStart(2, '0')}-${safePath(witness.seed.canonicalKey)}.svg`
    await writeFile(svgPath, renderSvg(witness.placements))
    artifactPaths.push(svgPath)
    return {
      role: witness.role,
      familyKeySha256: sha256(witness.familyKey),
      sourceKey: witness.sourceKey,
      sourceKeySha256: sha256(witness.sourceKey),
      sourceKind: witness.sourceKind,
      cellKeySha256: sha256(witness.cellKey),
      basisProvenance: witness.basisProvenance,
      seed: {
        ...serializeSeed(witness.seed),
        placementCount: witness.placements.length,
        placements: witness.placements.map(({ placement }) => ({
          pieceId: placement.pieceId,
          sourcePieceId: placement.sourcePieceId,
          rotationDeg: placement.transform.rotationDeg,
          mirrored: placement.transform.mirrored,
          translateX: placement.transform.translateX,
          translateY: placement.transform.translateY
        }))
      },
      svgPath
    }
  })
)
const adaptiveSeedCandidates = [
  ...result.sourceAuditWitnesses.map((witness) => ({
    source: `raw-crop:${sha256(witness.seed.canonicalKey).slice(0, 16)}`,
    placed: witness.placements
  })),
  ...result.runs.flatMap((run) =>
    run.result === undefined
      ? []
      : [
          {
            source: `continuation:${run.continuation.sourceId}`,
            placed: run.result.placedCollisionGeometries
          }
        ]
  )
]
  .flatMap((candidate) => {
    if (candidate.placed.length !== preparedPieces.length) return []
    const measured = measureIntrinsicSheetlessCompletedLayout(
      new IrregularBeamState({
        remainingPreparedPieces: [],
        placedCollisionGeometries: candidate.placed,
        placementOrder: candidate.placed.map(
          ({ placement }) => placement.pieceId ?? placement.sourcePieceId
        )
      })
    )
    return measured === undefined ? [] : [{ ...candidate, measured }]
  })
const adaptiveSeedsByHash = new Map(
  adaptiveSeedCandidates.map((candidate) => [
    candidate.measured.canonicalGeometryHash,
    candidate
  ])
)
const rankedAdaptiveSeedHashes = rankIntrinsicStrictCompletedLayouts(
  [...adaptiveSeedsByHash.values()].map(({ measured }) => measured.metrics)
).map(({ canonicalGeometryHash }) => canonicalGeometryHash)
const adaptiveSeed =
  requestedAdaptiveSeedHash === undefined
    ? rankedAdaptiveSeedHashes
        .map((hash) => adaptiveSeedsByHash.get(hash))
        .find((candidate) => candidate !== undefined)
    : [...adaptiveSeedsByHash.values()].find(({ measured }) =>
        measured.canonicalGeometryHash.startsWith(requestedAdaptiveSeedHash)
      )
if (
  (adaptivePressurePilot || adaptiveRestartAblation || adaptivePressureMatrix) &&
  adaptiveSeed === undefined
) {
  throw new Error(
    requestedAdaptiveSeedHash === undefined
      ? 'the adaptive pressure pilot found no complete exact seed'
      : `the adaptive pressure seed hash ${requestedAdaptiveSeedHash} was not found`
  )
}
const adaptiveResult =
  !adaptivePressurePilot || adaptiveSeed === undefined
    ? undefined
    : await Effect.runPromise(
        withLayers(
          runIntrinsicGlobalSqueezePortfolio({
            allPreparedPieces: preparedPieces,
            fullE1Placed: adaptiveSeed.measured.placedCollisionGeometries
          }),
          settings
        )
      )
const adaptiveRestartAblationResults: Array<{
  readonly pressureRestartPoolCapacity: number
  readonly status: 'completed' | 'deadline-fallback' | 'budget-fallback'
  readonly runtimeMs: number
  readonly separationEvaluationCount: number
  readonly pressureRepairSweepCount: number
  readonly contractedPressureTrace: ReadonlyArray<IntrinsicContractedPressureAttemptTrace>
}> = []
if (adaptiveRestartAblation && adaptiveSeed !== undefined) {
  for (const pressureRestartPoolCapacity of [0, 3]) {
    const structural = await Effect.runPromise(
      withLayers(
        runIntrinsicSqueezeDisruptSeparateWithSchedule(
          {
            allPreparedPieces: preparedPieces,
            fullE1Placed: adaptiveSeed.measured.placedCollisionGeometries
          },
          {
            ...INTRINSIC_GLOBAL_SEARCH_DEFAULTS,
            forcedDisruptionSweeps: [
              ...INTRINSIC_GLOBAL_SEARCH_DEFAULTS.forcedDisruptionSweeps
            ],
            maximumRuntimeMs: 240_000,
            pressureRestartPoolCapacity
          },
          { project: projectIntrinsicLayoutExactly }
        ),
        settings
      )
    )
    adaptiveRestartAblationResults.push({
      pressureRestartPoolCapacity,
      status: structural.status,
      runtimeMs: structural.runtimeMs,
      separationEvaluationCount: structural.separationEvaluationCount,
      pressureRepairSweepCount: structural.pressureRepairSweepCount,
      contractedPressureTrace: structural.contractedPressureTrace
    })
  }
}
interface AdaptivePressureMatrixArmSpec {
  readonly name: string
  readonly pressureContractionRatios: readonly [number, number, number]
  readonly pressureMoveVocabulary: 'mtv' | 'sampled-relocation'
}
const ADAPTIVE_PRESSURE_MATRIX_ARMS: ReadonlyArray<AdaptivePressureMatrixArmSpec> = [
  {
    name: 'baseline-mtv',
    pressureContractionRatios: [1 / 20, 1 / 40, 1 / 80],
    pressureMoveVocabulary: 'mtv'
  },
  {
    name: 'smaller-step-mtv',
    pressureContractionRatios: [1 / 20, 1 / 40, 1 / 160],
    pressureMoveVocabulary: 'mtv'
  },
  {
    name: 'sampled-relocation',
    pressureContractionRatios: [1 / 20, 1 / 40, 1 / 80],
    pressureMoveVocabulary: 'sampled-relocation'
  },
  {
    name: 'sampled-relocation-smaller-step',
    pressureContractionRatios: [1 / 20, 1 / 40, 1 / 160],
    pressureMoveVocabulary: 'sampled-relocation'
  }
]
const requestedMatrixArmNames =
  adaptiveMatrixArmsArgument === undefined
    ? undefined
    : new Set(adaptiveMatrixArmsArgument.split(',').map((name) => name.trim()))
const selectedMatrixArms = ADAPTIVE_PRESSURE_MATRIX_ARMS.filter(
  (arm) => requestedMatrixArmNames === undefined || requestedMatrixArmNames.has(arm.name)
)
if (adaptivePressureMatrix && selectedMatrixArms.length === 0) {
  throw new Error('--adaptive-matrix-arms selected no known adaptive pressure matrix arm')
}
const adaptivePressureMatrixResults: Array<{
  readonly arm: AdaptivePressureMatrixArmSpec
  readonly status: 'completed' | 'deadline-fallback' | 'budget-fallback'
  readonly runtimeMs: number
  readonly separationEvaluationCount: number
  readonly pressureRepairSweepCount: number
  readonly structuralHandoffCount: number
  readonly acceptedPressureAttemptCount: number
  readonly contractedPressureTrace: ReadonlyArray<IntrinsicContractedPressureAttemptTrace>
}> = []
if (adaptivePressureMatrix && adaptiveSeed !== undefined) {
  for (const arm of selectedMatrixArms) {
    const structural = await Effect.runPromise(
      withLayers(
        runIntrinsicSqueezeDisruptSeparateWithSchedule(
          {
            allPreparedPieces: preparedPieces,
            fullE1Placed: adaptiveSeed.measured.placedCollisionGeometries
          },
          {
            ...INTRINSIC_GLOBAL_SEARCH_DEFAULTS,
            forcedDisruptionSweeps: [
              ...INTRINSIC_GLOBAL_SEARCH_DEFAULTS.forcedDisruptionSweeps
            ],
            maximumRuntimeMs: 240_000,
            pressureRestartPoolCapacity: 0,
            pressureContractionRatios: arm.pressureContractionRatios,
            pressureMoveVocabulary: arm.pressureMoveVocabulary
          },
          { project: projectIntrinsicLayoutExactly }
        ),
        settings
      )
    )
    adaptivePressureMatrixResults.push({
      arm,
      status: structural.status,
      runtimeMs: structural.runtimeMs,
      separationEvaluationCount: structural.separationEvaluationCount,
      pressureRepairSweepCount: structural.pressureRepairSweepCount,
      structuralHandoffCount: structural.structuralHandoffs.length,
      acceptedPressureAttemptCount: structural.contractedPressureTrace.filter(
        ({ outcome }) => outcome === 'accepted'
      ).length,
      contractedPressureTrace: structural.contractedPressureTrace
    })
  }
}
const adaptiveSelectedSvgPath =
  adaptiveResult === undefined
    ? undefined
    : `${outputDirectory}/${fixtureName}-adaptive-pressure-selected.svg`
if (adaptiveSelectedSvgPath !== undefined && adaptiveResult !== undefined) {
  await writeFile(
    adaptiveSelectedSvgPath,
    renderSvg(adaptiveResult.selected.placedCollisionGeometries)
  )
  artifactPaths.push(adaptiveSelectedSvgPath)
}
const report = {
  experiment: 'intrinsic-periodic-family-portfolio',
  sourceCommit,
  fixture: { name: fixtureName, path: fixture.path, sha256: sha256(fixture.bytes) },
  requestedSheet: {
    width: fixture.request.sheet.width,
    height: fixture.request.sheet.height,
    label: fixture.request.sheet.label
  },
  runtime: { node: process.version, v8: process.versions.v8 },
  limits: {
    catalogMs: maximumCatalogRuntimeMs,
    families: 8,
    transformsPerFamily: 16,
    pairsPerFamily: 120,
    nfpBoundaryVertexBasisCandidatesPerDerivation: MAXIMUM_NFP_BOUNDARY_VERTEX_BASIS_CANDIDATES,
    edgeContactRelationsPerDerivation: MAXIMUM_EDGE_CONTACT_RELATIONS_PER_DERIVATION,
    edgeContactBasisCandidatesPerDerivation:
      MAXIMUM_EDGE_CONTACT_BASIS_CANDIDATES_PER_DERIVATION,
    edgeContactPairValidationAttemptsPerDerivation:
      MAXIMUM_EDGE_CONTACT_PAIR_VALIDATION_ATTEMPTS_PER_DERIVATION,
    cellsPerFamilyRole: maximumCellsPerFamilyRole,
    cropsPerCell: maximumCropsPerCell,
    cropEnumeration: {
      rows: '1..floor(family member count / base-cell member count)',
      columns: 'ceil(family member count / base-cell member count / rows)',
      traversals: ['row', 'column'],
      corners: [0, 1, 2, 3]
    },
    continuations: maximumContinuationCount,
    basisSourceKey,
    sourceSurvivalAudit: captureSourceSurvivalAudit,
    admitSourceAuditWitnesses,
    adaptivePressurePilot,
    adaptiveRestartAblation,
    adaptivePressureMatrix,
    adaptiveMatrixArmNames: selectedMatrixArms.map(({ name }) => name),
    requestedAdaptiveSeedHash,
    continuationMs: maximumContinuationRuntimeMs,
    continuationCandidateEvaluations: maximumContinuationCandidateEvaluations,
    fixtureMs: maximumTotalRuntimeMs
  },
  preparedPieceCount: preparedPieces.length,
  catalog: {
    familyCoverageComplete: result.catalog.familyCoverageComplete,
    runtimeCoverageComplete: result.catalog.runtimeCoverageComplete,
    rejected: result.catalog.rejected,
    families: result.catalog.families.map((family) => ({
      familyKeySha256: sha256(family.familyKey),
      memberCount: family.memberCount,
      collisionAreaMm2: family.collisionAreaMm2,
      uniqueTransformCount: family.uniqueTransformCount,
      retainedTransformCount: family.retainedTransformCount,
      transformCoverageComplete: family.transformCoverageComplete,
      transformReservations: family.transformReservations,
      enumeratedPairCount: family.enumeratedPairCount,
      pairCoverageComplete: family.pairCoverageComplete,
      cellCoverageComplete: family.cellCoverageComplete,
      edgeContactDiagnostics: family.edgeContactDiagnostics,
      sourceCellSurvival: family.sourceSurvival,
      rejectedSamples: family.rejectedSamples,
      finiteCropSources: family.cells.map((cell) => ({
        role: cell.role,
        canonicalKeySha256: sha256(cell.canonicalKey),
        v1: cell.v1,
        v2: cell.v2,
        determinantGrid2: cell.determinantGrid2,
        memberDoubledAreaGrid2: cell.memberDoubledAreaGrid2,
        density: cell.density,
        envelopeMaximumSideMm: cell.envelopeMaximumSideMm,
        hullWasteRatio: cell.hullWasteRatio,
        sharedBoundaryLengthMm: cell.sharedBoundaryLengthMm,
        infiniteFarProof: cell.infiniteFarProof,
        threeByThreeLatticeLegal: cell.threeByThreeLatticeLegal,
        threeByThreeCentreContactComplete: cell.threeByThreeCentreContactComplete,
        basisProvenance: cell.basisProvenance,
        retainedBasisSourceVariantCount:
          cell.basisProvenance === undefined
            ? undefined
            : basisSourceVariantCounts.get(cell.basisProvenance.sourceKey)
      })),
      rejected: family.rejected
    }))
  },
  continuationCoverageComplete: result.continuationCoverageComplete,
  ...(maximumContinuationCandidateEvaluations === undefined
    ? {}
    : {
        continuationExecutionCoverageComplete: result.continuationExecutionCoverageComplete
      }),
  sourceCropSurvival: result.sourceCropSurvival,
  sourceAuditWitnesses: auditWitnesses,
  adaptivePressurePilot:
    adaptiveResult === undefined || adaptiveSeed === undefined
      ? undefined
      : {
          seed: {
            source: adaptiveSeed.source,
            canonicalGeometryHash: adaptiveSeed.measured.canonicalGeometryHash,
            metrics: adaptiveSeed.measured.metrics
          },
          status: adaptiveResult.status,
          selected: {
            source: adaptiveResult.selected.source,
            canonicalGeometryHash:
              adaptiveResult.selected.measured.canonicalGeometryHash,
            metrics: adaptiveResult.selected.measured.metrics,
            svgPath: adaptiveSelectedSvgPath
          },
          promotion: adaptiveResult.promotion,
          fillTrace: adaptiveResult.fillTrace,
          structuralOutcome: adaptiveResult.structuralOutcome,
          runtimeMs: adaptiveResult.runtimeMs
        },
  adaptiveRestartAblation:
    !adaptiveRestartAblation || adaptiveSeed === undefined
      ? undefined
      : {
          seed: {
            source: adaptiveSeed.source,
            canonicalGeometryHash: adaptiveSeed.measured.canonicalGeometryHash,
            metrics: adaptiveSeed.measured.metrics
          },
          maximumRuntimeMsPerArm: 240_000,
          maximumPressureEvaluationCountPerArm: Math.floor(
            INTRINSIC_GLOBAL_SEARCH_DEFAULTS.maximumSeparationEvaluations / 4
          ),
          arms: adaptiveRestartAblationResults
        },
  adaptivePressureMatrix:
    !adaptivePressureMatrix || adaptiveSeed === undefined
      ? undefined
      : {
          seed: {
            source: adaptiveSeed.source,
            canonicalGeometryHash: adaptiveSeed.measured.canonicalGeometryHash,
            metrics: adaptiveSeed.measured.metrics
          },
          maximumRuntimeMsPerArm: 240_000,
          maximumPressureEvaluationCountPerArm: Math.floor(
            INTRINSIC_GLOBAL_SEARCH_DEFAULTS.maximumSeparationEvaluations / 4
          ),
          pressureRestartPoolCapacity: 0,
          arms: adaptivePressureMatrixResults.map((entry) => ({
            name: entry.arm.name,
            pressureContractionRatios: entry.arm.pressureContractionRatios,
            pressureMoveVocabulary: entry.arm.pressureMoveVocabulary,
            status: entry.status,
            runtimeMs: entry.runtimeMs,
            separationEvaluationCount: entry.separationEvaluationCount,
            pressureRepairSweepCount: entry.pressureRepairSweepCount,
            structuralHandoffCount: entry.structuralHandoffCount,
            acceptedPressureAttemptCount: entry.acceptedPressureAttemptCount,
            contractedPressureTrace: entry.contractedPressureTrace
          }))
        },
  sourceAuditNonDominatedCropCount: result.sourceAuditNonDominatedCropCount,
  continuationOmissions: result.continuationOmissions,
  archive: result.archive,
  winnerSourceId: result.winner?.continuation.sourceId,
  runtimeMs: result.runtimeMs,
  runs
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
      fixture: report.fixture,
      files: Object.fromEntries(
        await Promise.all(artifactPaths.map(async (path) => [path, sha256(await readFile(path))]))
      )
    },
    null,
    2
  )}\n`
)
console.log(JSON.stringify({ reportPath, manifestPath, winnerSourceId: report.winnerSourceId }))

async function loadFixture(name: FixtureName): Promise<{
  readonly path: string
  readonly bytes: Uint8Array
  readonly request: NestingRequest
}> {
  if (name === 'mixed-61') {
    const bytes = await readFile(MIXED_FIXTURE)
    return {
      path: MIXED_FIXTURE,
      bytes,
      request: Schema.decodeUnknownSync(NestingRequest)(JSON.parse(bytes.toString('utf8')))
    }
  }
  const generated = generatedFixtures[name]
  if (generated === undefined) throw new Error(`unknown generated fixture ${name}`)
  const request = makeGeneratedRequest(generated)
  return {
    path: `generated:${name}`,
    bytes: new TextEncoder().encode(JSON.stringify(request)),
    request
  }
}

function makeGeneratedRequest(fixture: GeneratedFixture): NestingRequest {
  const jobId = JobId.make(`periodic-family-${fixture.name}`)
  const base = makePresetShapeDocument({
    kind: fixture.kind,
    width: fixture.width,
    height: fixture.height,
    label: fixture.name
  }).pieces[0]
  if (base === undefined) throw new Error(`missing generated ${fixture.name} base piece`)
  const sources = Array.from(
    { length: 20 },
    (_, index) =>
      new ImportedPiece({
        ...base,
        id: PieceId.make(`${fixture.name}-${index + 1}`),
        sourceFileId: SourceFileId.make(`${fixture.name}-source-${index + 1}`),
        label: `${fixture.name} copy ${index + 1}`
      })
  )
  const prepared = prepareNestingPieces(sources, ROOMY_SHEET, 10, jobId, undefined, undefined, () => fixture.name)
  if (prepared.warnings.length > 0) throw new Error(prepared.warnings.join('; '))
  const irregularSettings = new IrregularNestingSettings({
    geometry: DEFAULT_IRREGULAR_GEOMETRY_SETTINGS,
    optimizer: makeCompactQualityIrregularOptimizerSettings({ localRepairBudget: 0 })
  })
  return new NestingRequest({
    version: 1,
    jobId,
    sheet: ROOMY_SHEET,
    padding: 10,
    pieces: prepared.pieces,
    sourcePieces: sources,
    options: new NestingOptions({
      allowGlobalRotation: true,
      allowGlobalMirror: true,
      timeoutMs: 240_000,
      workerMode: 'irregular-convex-v2',
      historyMode: 'off',
      historyScope: 'winning_path',
      strategySelectionMode: 'single',
      strategyIds: [],
      layoutSelectionStrategyId: 'compact-first',
      finalSelectionMode: 'best',
      irregularSettings
    })
  })
}

function withLayers<A, E, R>(effect: Effect.Effect<A, E, R>, settings: IrregularSettings) {
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
  settings: IrregularSettings
): Effect.Effect<ReadonlyArray<IrregularPreparedPiece>, unknown, CollisionGeometryBuilder | TransformGenerator> {
  return Effect.gen(function* () {
    const geometryBuilder = yield* CollisionGeometryBuilder
    const transformGenerator = yield* TransformGenerator
    const sources = request.sourcePieces ?? []
    const pieces: IrregularPreparedPiece[] = []
    for (const prepared of sortPiecesForNesting(request.pieces)) {
      const source = sources.find(
        (candidate) => candidate.id === prepared.sourcePieceId || candidate.id === prepared.id
      )
      if (source === undefined) throw new Error(`missing source ${prepared.sourcePieceId}`)
      const collisionGeometry = yield* geometryBuilder.buildPiece({
        piece: source,
        totalPaddingMm: request.padding
      })
      const transforms = yield* transformGenerator.generateTransforms({
        geometry: collisionGeometry,
        allowRotation: request.options.allowGlobalRotation && prepared.allowRotation,
        allowMirror: (request.options.allowGlobalMirror ?? true) && (prepared.allowMirror ?? true),
        settings: settings.optimizer
      })
      pieces.push(
        new IrregularPreparedPiece({
          pieceId: prepared.id,
          interchangeabilityKey: prepared.interchangeabilityKey ?? prepared.id,
          source,
          allowMirror: (request.options.allowGlobalMirror ?? true) && (prepared.allowMirror ?? true),
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
    return pieces
  })
}

function renderSvg(
  placed: ReadonlyArray<{
    readonly placement: { readonly transform: { readonly translateX: number; readonly translateY: number } }
    readonly collisionGeometry: { readonly polygon: { readonly points: ReadonlyArray<{ readonly x: number; readonly y: number }> } }
  }>
): string {
  const polygons = placed.map(({ placement, collisionGeometry }) =>
    collisionGeometry.polygon.points.map(({ x, y }) => ({
      x: x + placement.transform.translateX,
      y: y + placement.transform.translateY
    }))
  )
  const points = polygons.flat()
  if (points.length === 0) return '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1200"/>'
  const minX = Math.min(...points.map(({ x }) => x))
  const minY = Math.min(...points.map(({ y }) => y))
  const maxX = Math.max(...points.map(({ x }) => x))
  const maxY = Math.max(...points.map(({ y }) => y))
  const margin = 20
  const polygonsSvg = polygons
    .map((polygon) => `<polygon points="${polygon.map(({ x, y }) => `${x},${-y}`).join(' ')}"/>`)
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX - margin} ${-maxY - margin} ${maxX - minX + margin * 2} ${maxY - minY + margin * 2}" width="1200" height="1200"><rect x="${minX - margin}" y="${-maxY - margin}" width="${maxX - minX + margin * 2}" height="${maxY - minY + margin * 2}" fill="#1b2328"/><g fill="#22313b" stroke="#39a9ff" stroke-width="1">${polygonsSvg}</g></svg>`
}

function serializeSeed(seed: {
  readonly canonicalKey: string
  readonly componentCount: number
  readonly isolatedPieceCount: number
  readonly largestComponentSize: number
  readonly maximumSideMm: number
  readonly envelopeAreaMm2: number
  readonly envelopeSpanMm: number
  readonly crop: unknown
}) {
  return {
    canonicalKeySha256: sha256(seed.canonicalKey),
    componentCount: seed.componentCount,
    isolatedPieceCount: seed.isolatedPieceCount,
    largestComponentSize: seed.largestComponentSize,
    maximumSideMm: seed.maximumSideMm,
    envelopeAreaMm2: seed.envelopeAreaMm2,
    envelopeSpanMm: seed.envelopeSpanMm,
    crop: seed.crop
  }
}

function safePath(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}
