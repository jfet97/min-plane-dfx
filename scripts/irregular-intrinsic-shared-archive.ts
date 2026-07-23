import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Effect, Layer, Schema } from 'effect'
import { importDxfFile } from '../src/main/services/DxfImportService.js'
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
  IrregularPreparedPiece,
  IrregularPriorityOrderKey,
  type IrregularNestingSettings as IrregularSettings
} from '../src/shared/irregular/domain.js'
import { makePresetShapeDocument, type PresetShapeKind } from '../src/shared/presetShapes.js'
import { preparePieces as prepareNestingPieces } from '../src/shared/preparePieces.js'
import {
  INTRINSIC_SHARED_ARCHIVE_DIRECT_ROLES,
  retainRankedSharedArchive,
  runIntrinsicSharedArchiveDirectPortfolio,
  runIntrinsicSharedArchivePortfolio,
  selectFittingSharedArchive,
  selectIntrinsicSharedArchiveWinner,
  type IntrinsicSharedArchiveDirectRole,
  type IntrinsicSharedArchiveEndpoint,
  type IntrinsicSharedArchiveRun
} from '../src/workers/algorithm/irregular/intrinsicSharedArchivePortfolio.js'
import type {
  IntrinsicPeriodicSourceAuditReplayEnvelope,
  IntrinsicPeriodicSourceAuditScope
} from '../src/workers/algorithm/irregular/intrinsicPeriodicFamilyPortfolio.js'
import { sortPiecesForNesting } from '../src/workers/algorithm/sortPiecesForNesting.js'
import { CollisionGeometryBuilder } from '../src/workers/irregular/collisionGeometryBuilder.js'
import { GeometryKernel, GeometrySettings } from '../src/workers/irregular/geometryKernel.js'
import { NfpIfpServiceLive } from '../src/workers/irregular/nfpIfpService.js'
import { TransformGenerator } from '../src/workers/irregular/services.js'
import { TransformGeneratorLive } from '../src/workers/irregular/transformGenerator.js'

type FixtureName =
  | 'triangle-20'
  | 'rectangles-20'
  | 'pentagons-20'
  | 'mixed-61'
  | 'shapes-17'
type Mode = 'calibration' | 'matrix'

interface GeneratedFixture {
  readonly name: Exclude<FixtureName, 'mixed-61' | 'shapes-17'>
  readonly kind: PresetShapeKind
  readonly width: number
  readonly height: number
}

const HARNESS_PATH = fileURLToPath(import.meta.url)
const MIXED_FIXTURE = fileURLToPath(
  new URL('../tests/fixtures/irregularSheetInvariance/mixed61-request.json', import.meta.url)
)
const SHAPES_17_FIXTURE = fileURLToPath(
  new URL('../tests/fixtures/irregularSeventeenShapes', import.meta.url)
)
const ROOMY_SHEET = new SheetSpec({ width: 2000, height: 2700, label: 'shared archive roomy' })
const generatedFixtures: Readonly<
  Record<Exclude<FixtureName, 'mixed-61' | 'shapes-17'>, GeneratedFixture>
> = {
  'triangle-20': { name: 'triangle-20', kind: 'triangle', width: 70, height: 60 },
  'rectangles-20': { name: 'rectangles-20', kind: 'rectangle', width: 154, height: 104 },
  'pentagons-20': { name: 'pentagons-20', kind: 'pentagon', width: 90, height: 90 }
}

const fixtureName = requiredFixture(argument('--fixture'))
const mode = requiredMode(argument('--mode'))
const outputDirectory = requiredArgument('--output')
const sourceCommit = requiredArgument('--source-commit')
const maximumDirectRuntimeMs = positiveIntegerArgument('--direct-ms', 600_000)
const maximumCatalogRuntimeMs = positiveIntegerArgument('--catalog-ms', 30_000)
const maximumContinuationRuntimeMs = positiveIntegerArgument('--continuation-ms', 600_000)
const maximumPeriodicRuntimeMs = positiveIntegerArgument('--periodic-ms', 600_000)
const sourceAuditCacheInput = argument('--source-audit-cache-in')
const sourceAuditCacheOutput = argument('--source-audit-cache-out')
const sourceAuditScope = sourceAuditScopeArgument(argument('--source-audit-scope'))
const fixture = await loadFixture(fixtureName)
const settings = fixture.request.options.irregularSettings
if (settings === undefined) throw new Error(`${fixtureName} has no irregular settings`)
await mkdir(outputDirectory, { recursive: true })
const preparedPieces = await Effect.runPromise(
  withLayers(preparePieces(fixture.request, settings), settings)
)
const directCandidateEvaluationCaps = mode === 'calibration' ? undefined : directCapsFromArguments()
if (mode === 'matrix' && directCandidateEvaluationCaps === undefined) {
  throw new Error('matrix mode requires direct candidate-evaluation caps')
}
const sourceAuditReplayEnvelope =
  sourceAuditCacheInput === undefined
    ? undefined
    : await readSourceAuditReplayEnvelope(sourceAuditCacheInput)
const result =
  mode === 'calibration'
    ? await (async () => {
        const directRuns = await Effect.runPromise(
          withLayers(
            runIntrinsicSharedArchiveDirectPortfolio(fixture.request.sheet, preparedPieces, {
              maximumDirectRuntimeMs
            }),
            settings
          )
        )
        const sheetlessArchive = retainRankedSharedArchive(
          directRuns.flatMap(({ endpoint }) => (endpoint === undefined ? [] : [endpoint]))
        )
        const archive = selectFittingSharedArchive(sheetlessArchive)
        return {
          directRuns,
          periodicRuns: [],
          periodicPortfolio: undefined,
          sheetlessArchive,
          archive,
          winner: selectIntrinsicSharedArchiveWinner(archive),
          periodicSelectionValid: undefined,
          experimentValid: directRuns.every(({ status }) => status === 'completed')
        }
      })()
    : await Effect.runPromise(
        withLayers(
          runIntrinsicSharedArchivePortfolio(fixture.request.sheet, preparedPieces, {
            directCandidateEvaluationCaps: requiredDirectCaps(directCandidateEvaluationCaps),
            maximumDirectRuntimeMs,
            includeSourceAuditWitnesses: true,
            periodic: {
              maximumCatalogRuntimeMs,
              maximumCellsPerFamilyRole: 16,
              maximumCropsPerCell: 4,
              maximumContinuationRuntimeMs,
              maximumTotalRuntimeMs: maximumPeriodicRuntimeMs,
              capturePhaseTimings: true,
              sourceAuditScope,
              ...(sourceAuditReplayEnvelope === undefined
                ? {}
                : { sourceAuditReplayEnvelope })
            }
          }),
          settings
        )
      )

const artifactPaths: string[] = []
const directRuns = await Promise.all(
  result.directRuns.map((run) => runRecord(run, fixtureName, outputDirectory, artifactPaths))
)
const periodicRuns = await Promise.all(
  result.periodicRuns.map((run) => runRecord(run, fixtureName, outputDirectory, artifactPaths))
)
const winnerSvgPath =
  result.winner === undefined
    ? undefined
    : `${outputDirectory}/${fixtureName}-shared-archive-winner.svg`
if (winnerSvgPath !== undefined && result.winner !== undefined) {
  await writeFile(winnerSvgPath, renderSvg(renderedPlacements(result.winner)))
  artifactPaths.push(winnerSvgPath)
}
if (
  sourceAuditCacheOutput !== undefined &&
  result.periodicPortfolio?.sourceAuditReplayEnvelope !== undefined
) {
  await writeFile(
    sourceAuditCacheOutput,
    `${JSON.stringify(result.periodicPortfolio.sourceAuditReplayEnvelope, null, 2)}\n`
  )
  artifactPaths.push(sourceAuditCacheOutput)
}
const report = {
  experiment: 'intrinsic-shared-archive-step4',
  mode,
  sourceCommit,
  harness: { path: HARNESS_PATH, sha256: sha256(await readFile(HARNESS_PATH)) },
  fixture: {
    name: fixtureName,
    path: fixture.path,
    sha256: sha256(fixture.bytes),
    pieceCount: preparedPieces.length,
    sheet: {
      width: fixture.request.sheet.width,
      height: fixture.request.sheet.height
    }
  },
  runtime: { node: process.version, v8: process.versions.v8 },
  limits: {
    maximumDirectRuntimeMs,
    maximumCatalogRuntimeMs,
    maximumContinuationRuntimeMs,
    maximumPeriodicRuntimeMs,
    directCandidateEvaluationCaps,
    periodicContinuationCandidateEvaluations: mode === 'matrix' ? 19_862 : undefined,
    periodicContinuationCount: mode === 'matrix' ? 8 : undefined,
    rawSourceAudit: mode === 'matrix',
    sourceAuditScope,
    sourceAuditReplayProvided: sourceAuditReplayEnvelope !== undefined,
    sourceAuditReplayAccepted: result.periodicPortfolio?.sourceAuditReplayAccepted ?? false,
    sourceAuditReplayRejectionReason:
      result.periodicPortfolio?.sourceAuditReplayRejectionReason
  },
  directRuns,
  periodicRuns,
  periodic:
    result.periodicPortfolio === undefined
      ? undefined
      : {
          catalogRuntimeCoverageComplete: result.periodicPortfolio.catalog.runtimeCoverageComplete,
          catalogFamilyCoverageComplete: result.periodicPortfolio.catalog.familyCoverageComplete,
          continuationCoverageComplete: result.periodicPortfolio.continuationCoverageComplete,
          continuationBudgetSettlementComplete:
            result.periodicPortfolio.continuationBudgetSettlementComplete,
          selectedSourceIds: result.periodicPortfolio.continuations.map(({ sourceId }) => sourceId),
          omissions: result.periodicPortfolio.continuationOmissions,
          phaseTimings: result.periodicPortfolio.phaseTimings,
          sourceAuditWitnesses: result.periodicPortfolio.sourceAuditWitnesses,
          sourceAuditNonDominatedCropCount:
            result.periodicPortfolio.sourceAuditNonDominatedCropCount,
          sourceCropSurvival: result.periodicPortfolio.sourceCropSurvival
        },
  sheetlessArchive: result.sheetlessArchive.map(endpointRecord),
  fittedArchive: result.archive.map(endpointRecord),
  sheetlessArchiveLeader: result.sheetlessArchive[0]
    ? endpointRecord(result.sheetlessArchive[0])
    : undefined,
  sheetlessSelectedWinner: (() => {
    const winner = selectIntrinsicSharedArchiveWinner(result.sheetlessArchive)
    return winner === undefined ? undefined : endpointRecord(winner)
  })(),
  fittedWinner: result.winner === undefined ? undefined : endpointRecord(result.winner),
  winnerSvgPath,
  periodicSelectionValid: result.periodicSelectionValid,
  experimentValid: result.experimentValid
}
const reportPath = `${outputDirectory}/report.json`
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
artifactPaths.unshift(reportPath)
const manifestPath = `${outputDirectory}/manifest.json`
await writeFile(
  manifestPath,
  `${JSON.stringify(
    {
      experiment: report.experiment,
      mode,
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
console.log(JSON.stringify({ reportPath, manifestPath, winnerSvgPath }))

async function runRecord(
  run: IntrinsicSharedArchiveRun,
  fixture: FixtureName,
  output: string,
  artifactPaths: string[]
) {
  const svgPath =
    run.endpoint === undefined
      ? undefined
      : `${output}/${fixture}-${safePath(`${run.role}-${run.sourceId ?? 'direct'}`)}.svg`
  if (svgPath !== undefined && run.endpoint !== undefined) {
    await writeFile(svgPath, renderSvg(renderedPlacements(run.endpoint)))
    artifactPaths.push(svgPath)
  }
  return {
    role: run.role,
    sourceId: run.sourceId,
    status: run.status,
    requestedCandidateEvaluations: run.requestedCandidateEvaluations,
    consumedCandidateEvaluations: run.consumedCandidateEvaluations,
    reason: run.reason,
    runtimeMs: run.runtimeMs,
    endpoint: run.endpoint === undefined ? undefined : endpointRecord(run.endpoint),
    svgPath
  }
}

function endpointRecord(endpoint: IntrinsicSharedArchiveEndpoint) {
  return {
    role: endpoint.role,
    sourceId: endpoint.sourceId,
    sheetlessCanonicalGeometryHash: endpoint.sheetlessCanonicalGeometryHash,
    sheetlessCanonicalGeometryIdentityBytes: Buffer.byteLength(
      endpoint.sheetlessCanonicalGeometryIdentity
    ),
    metrics: endpoint.metrics,
    certificate: endpoint.certificate,
    requestedSheetFit: {
      q0: endpoint.requestedSheetFit.q0,
      q90: endpoint.requestedSheetFit.q90,
      selectedRotationDeg: endpoint.requestedSheetFit.selectedRotationDeg,
      selectedCanonicalGeometryHash: endpoint.requestedSheetFit.selectedCanonicalGeometryHash
    }
  }
}

function renderedPlacements(endpoint: IntrinsicSharedArchiveEndpoint) {
  return endpoint.requestedSheetFit.selectedPlacedCollisionGeometries.length > 0
    ? endpoint.requestedSheetFit.selectedPlacedCollisionGeometries
    : endpoint.placedCollisionGeometries
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}

function requiredArgument(name: string): string {
  const value = argument(name)
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`)
  return value
}

function positiveIntegerArgument(name: string, fallback: number): number {
  const value = argument(name)
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be positive`)
  return parsed
}

function requiredMode(value: string | undefined): Mode {
  if (value === 'calibration' || value === 'matrix') return value
  throw new Error('--mode must be calibration or matrix')
}

function requiredFixture(value: string | undefined): FixtureName {
  if (
    value === 'triangle-20' ||
    value === 'rectangles-20' ||
    value === 'pentagons-20' ||
    value === 'mixed-61' ||
    value === 'shapes-17'
  ) {
    return value
  }
  throw new Error(
    '--fixture must be triangle-20, rectangles-20, pentagons-20, mixed-61, or shapes-17'
  )
}

function sourceAuditScopeArgument(value: string | undefined): IntrinsicPeriodicSourceAuditScope {
  if (value === undefined || value === 'all') return 'all'
  if (value === 'p2-axis-union') return value
  throw new Error('--source-audit-scope must be all or p2-axis-union')
}

function makeSourceAuditReplaySchema() {
  const sourceAuditRoleSchema = Schema.Union([Schema.Literal('P1'), Schema.Literal('P2')])
  const sourceAuditKindSchema = Schema.Union([
    Schema.Literal('axis-union'),
    Schema.Literal('nfp-boundary-vertex-pair'),
    Schema.Literal('edge-contact-pair')
  ])
  const sourceAuditContactRelationSchema = Schema.Struct({
    vector: Schema.Struct({ x: Schema.Number, y: Schema.Number }),
    fixedMemberIndex: Schema.Number,
    fixedPieceId: Schema.String,
    fixedEdgeIndex: Schema.Number,
    movingMemberIndex: Schema.Number,
    movingPieceId: Schema.String,
    movingEdgeIndex: Schema.Number,
    segmentStart: Schema.Struct({ x: Schema.Number, y: Schema.Number }),
    segmentEnd: Schema.Struct({ x: Schema.Number, y: Schema.Number }),
    lengthMm: Schema.Number
  })
  return Schema.Struct({
    formatVersion: Schema.Literal(2),
    algorithmVersion: Schema.Literal('intrinsic-periodic-source-audit-v2'),
    scope: Schema.Union([Schema.Literal('all'), Schema.Literal('p2-axis-union')]),
    preparedInputDigest: Schema.String,
    eligibleSourceDomainDigest: Schema.String,
    replayDigest: Schema.String,
    replay: Schema.Struct({
      witnesses: Schema.Array(
        Schema.Struct({
          role: sourceAuditRoleSchema,
          familyKey: Schema.String,
          sourceKey: Schema.String,
          sourceKind: sourceAuditKindSchema,
          cellKey: Schema.String,
          basisProvenance: Schema.Struct({
            sourceKey: Schema.String,
            sourceKind: sourceAuditKindSchema,
            sourcePoints: Schema.Tuple([
              Schema.Struct({ x: Schema.String, y: Schema.String }),
              Schema.Struct({ x: Schema.String, y: Schema.String })
            ]),
          axis: Schema.optionalKey(Schema.Union([Schema.Literal('x'), Schema.Literal('y')])),
            selectedBasis: Schema.Tuple([
              Schema.Struct({ x: Schema.Number, y: Schema.Number }),
              Schema.Struct({ x: Schema.Number, y: Schema.Number })
            ]),
            selectedResidualGrid: Schema.Tuple([
              Schema.Struct({ x: Schema.String, y: Schema.String }),
              Schema.Struct({ x: Schema.String, y: Schema.String })
            ]),
            canonicalBasis: Schema.Tuple([
              Schema.Struct({ x: Schema.Number, y: Schema.Number }),
              Schema.Struct({ x: Schema.Number, y: Schema.Number })
            ]),
            memberTransforms: Schema.Array(
              Schema.Struct({
                memberIndex: Schema.Number,
                pieceId: Schema.String,
                transformIndex: Schema.Number,
                rotationDeg: Schema.Number,
                mirrored: Schema.Boolean
              })
            ),
          contactRelations: Schema.optionalKey(
              Schema.Tuple([sourceAuditContactRelationSchema, sourceAuditContactRelationSchema])
            )
          }),
          placements: Schema.Array(IrregularPlacedPiece),
          seed: Schema.Struct({
            canonicalKey: Schema.String,
            componentCount: Schema.Number,
            isolatedPieceCount: Schema.Number,
            largestComponentSize: Schema.Number,
            maximumSideMm: Schema.Number,
            envelopeAreaMm2: Schema.Number,
            envelopeSpanMm: Schema.Number,
            crop: Schema.Struct({
              rows: Schema.Number,
              columns: Schema.Number,
              traversal: Schema.Union([Schema.Literal('row'), Schema.Literal('column')]),
              corner: Schema.Union([
                Schema.Literal(0),
                Schema.Literal(1),
                Schema.Literal(2),
                Schema.Literal(3)
              ])
            })
          })
        })
      ),
      nonDominatedCropCount: Schema.Number,
      sourceCropSurvival: Schema.Array(
        Schema.Struct({
          role: sourceAuditRoleSchema,
          sourceKey: Schema.String,
          sourceKind: sourceAuditKindSchema,
          retainedCellCount: Schema.Number,
          directValidCropCountBeforeFront: Schema.Number,
          directValidCropCount: Schema.Number,
          cropFrontCount: Schema.Number,
          uniqueSeedCount: Schema.Number,
          selectedContinuationCount: Schema.Number
        })
      )
    })
  })
}

async function readSourceAuditReplayEnvelope(
  path: string
): Promise<IntrinsicPeriodicSourceAuditReplayEnvelope | undefined> {
  try {
    const decoded = Schema.decodeUnknownSync(makeSourceAuditReplaySchema())(
      JSON.parse((await readFile(path)).toString('utf8'))
    )
    return {
      ...decoded,
      replay: {
        ...decoded.replay,
        witnesses: decoded.replay.witnesses.map((witness) => {
          const { axis, contactRelations, ...basisProvenance } = witness.basisProvenance
          const replayAxis =
            axis ??
            (basisProvenance.sourceKind === 'axis-union'
              ? axisFromSourceKey(basisProvenance.sourceKey)
              : undefined)
          return {
            ...witness,
            basisProvenance: {
              ...basisProvenance,
              ...(replayAxis === undefined ? {} : { axis: replayAxis }),
              ...(contactRelations === undefined ? {} : { contactRelations })
            }
          }
        })
      }
    }
  } catch {
    return undefined
  }
}

function axisFromSourceKey(sourceKey: string): 'x' | 'y' {
  if (sourceKey.startsWith('x:')) return 'x'
  if (sourceKey.startsWith('y:')) return 'y'
  throw new Error('axis-union replay source key has no axis prefix')
}

function directCapsFromArguments(): Readonly<Record<IntrinsicSharedArchiveDirectRole, number>> {
  return Object.fromEntries(
    INTRINSIC_SHARED_ARCHIVE_DIRECT_ROLES.map((role) => [
      role,
      requiredPositiveIntegerArgument(`--${role}-evaluations`)
    ])
  ) as Readonly<Record<IntrinsicSharedArchiveDirectRole, number>>
}

function requiredPositiveIntegerArgument(name: string): number {
  const value = argument(name)
  if (value === undefined) throw new Error(`${name} is required in matrix mode`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be positive`)
  return parsed
}

function requiredDirectCaps(
  caps: Readonly<Record<IntrinsicSharedArchiveDirectRole, number>> | undefined
): Readonly<Record<IntrinsicSharedArchiveDirectRole, number>> {
  if (caps === undefined) throw new Error('matrix mode requires direct candidate-evaluation caps')
  return caps
}

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
  if (name === 'shapes-17') {
    const fileNames = (await readdir(SHAPES_17_FIXTURE))
      .filter((fileName) => fileName.endsWith('.dxf'))
      .sort((first, second) => first.localeCompare(second, undefined, { numeric: true }))
    if (fileNames.length !== 17) {
      throw new Error(`shapes-17 fixture requires 17 DXF files, found ${fileNames.length}`)
    }
    const sources = await Promise.all(
      fileNames.map(async (fileName, index) => {
        const document = await importDxfFile(join(SHAPES_17_FIXTURE, fileName))
        const source = document.pieces[0]
        if (source === undefined || document.pieces.length !== 1) {
          throw new Error(`${fileName} must import exactly one piece`)
        }
        if (document.warnings.length > 0 || source.warnings.length > 0) {
          throw new Error(`${fileName} imported with warnings`)
        }
        return new ImportedPiece({
          ...source,
          id: PieceId.make(`shapes-17-${index + 1}`),
          sourceFileId: SourceFileId.make(`shapes-17-source-${index + 1}`),
          label: fileName
        })
      })
    )
    const manifest = await Promise.all(
      [...fileNames, 'ACRYL_5MM_EXTRUDIERT_TRANSPARENT_13-05-2026-13-53-20.csv'].map(
        async (fileName) => ({
          fileName,
          sha256: sha256(await readFile(join(SHAPES_17_FIXTURE, fileName)))
        })
      )
    )
    const bytes = new TextEncoder().encode(JSON.stringify(manifest))
    return {
      path: SHAPES_17_FIXTURE,
      bytes,
      request: makeImportedRequest(name, sources)
    }
  }
  const generated = generatedFixtures[name]
  const request = makeGeneratedRequest(generated)
  return {
    path: `generated:${name}`,
    bytes: new TextEncoder().encode(JSON.stringify(request)),
    request
  }
}

function makeGeneratedRequest(fixture: GeneratedFixture): NestingRequest {
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
  return makeImportedRequest(fixture.name, sources)
}

function makeImportedRequest(name: FixtureName, sources: ReadonlyArray<ImportedPiece>): NestingRequest {
  const jobId = JobId.make(`shared-archive-${name}`)
  const prepared = prepareNestingPieces(
    sources,
    ROOMY_SHEET,
    10,
    jobId,
    undefined,
    undefined,
    () => name
  )
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
      timeoutMs: 600_000,
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
): Effect.Effect<
  ReadonlyArray<IrregularPreparedPiece>,
  unknown,
  CollisionGeometryBuilder | TransformGenerator
> {
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
          allowMirror:
            (request.options.allowGlobalMirror ?? true) && (prepared.allowMirror ?? true),
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
  if (points.length === 0) {
    return '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1200"/>'
  }
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

function safePath(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}
