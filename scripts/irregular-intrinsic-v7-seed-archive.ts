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
  IrregularPreparedPiece,
  IrregularPriorityOrderKey,
  type IrregularPlacedPiece
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
import { sortPiecesForNesting } from '../src/workers/algorithm/sortPiecesForNesting.js'
import { CollisionGeometryBuilder } from '../src/workers/irregular/collisionGeometryBuilder.js'
import { GeometryKernel, GeometrySettings } from '../src/workers/irregular/geometryKernel.js'
import { NfpIfpServiceLive } from '../src/workers/irregular/nfpIfpService.js'
import { TransformGenerator } from '../src/workers/irregular/services.js'
import { TransformGeneratorLive } from '../src/workers/irregular/transformGenerator.js'

const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url))
const HARNESS_PATH = fileURLToPath(import.meta.url)
const MIXED_FIXTURE_PATH = fileURLToPath(
  new URL('../tests/fixtures/irregularSheetInvariance/mixed61-request.json', import.meta.url)
)
const TRIANGLE_SHEET = new SheetSpec({ width: 2000, height: 2700, label: 'triangle golden' })

async function main(): Promise<void> {
const fixtureName = requiredFixture(argument('--fixture'))
const outputDirectory = resolve(requiredArgument('--output'))
const sourceCommit = verifiedSourceCommit(argument('--source-commit'))
const requestedArms = parseArms(argument('--arms'))
const compact = process.argv.includes('--compact')
const featureContactCoverage = process.argv.includes('--feature-contact-coverage')
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
const featureContactCollector = featureContactCoverage ? new FeatureContactCoverageCollector() : undefined
const preparedPieces = await Effect.runPromise(
  withLayers(prepareIrregularPieces(fixture.request), fixture.settings)
)
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
    note:
      'This experiment ancestry is not current main. Triangle output is diagnostic only and cannot claim the current-main repair-8 golden.'
  },
  seedArchive: seedArtifacts,
  arms: armArtifacts,
  ...(featureContactCollector === undefined
    ? {}
    : {
        featureContactCoverage: featureContactCollector.complete(outcome.seedArchive)
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
  ...armArtifacts.flatMap(({ endpointArchive }) => endpointArchive.map(({ svgPath }) => svgPath))
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
    runtimeMs: outcome.runtimeMs
  })
)
}

type FeatureCandidateObservation = Parameters<
  IntrinsicV7FeatureContactObserver['onSeedCandidateProvenance']
>[0]
type FeatureSelectionObservation = Parameters<
  IntrinsicV7FeatureContactObserver['onSeedStepSelection']
>[0]

/**
 * Keeps F0 source evidence aggregate-only. Stage 1 does not request a fresh
 * NFP decode, so its global transport moves intentionally have no F0 rows.
 */
class FeatureContactCoverageCollector implements IntrinsicV7FeatureContactObserver {
  readonly pending = new Map<string, FeatureCandidateObservation[]>()
  readonly rows: FeatureCoverageRow[] = []

  onSeedCandidateProvenance(observation: FeatureCandidateObservation): void {
    const key = featureSelectionKey(observation.seedRole, observation.observation)
    const pending = this.pending.get(key) ?? []
    pending.push(observation)
    this.pending.set(key, pending)
  }

  onSeedStepSelection(observation: FeatureSelectionObservation): void {
    const key = featureSelectionKey(observation.seedRole, observation.observation)
    const candidates = this.pending.get(key) ?? []
    for (const candidate of candidates) {
      this.rows.push(featureCoverageRow(candidate, observation))
    }
    this.pending.delete(key)
  }

  complete(seedArchive: ReadonlyArray<{ readonly role: string; readonly placedCollisionGeometries: ReadonlyArray<IrregularPlacedPiece> }>) {
    if (this.pending.size > 0) {
      throw new Error('F0 feature-contact observer did not receive every strict seed selection.')
    }
    const rows = this.rows
    const sourceNames = [
      'ifpCorner',
      'nfpVertex',
      'antiparallelEdgeSupport',
      'ifpNfpIntersection',
      'nfpNfpIntersection'
    ] as const
    const witnesses = sourceNames.flatMap((source) => {
      const row = rows.find((candidate) => candidate.rawBySource[source] > 0)
      return row === undefined
        ? []
        : [
            {
              source,
              seedRole: row.seedRole,
              step: row.step,
              parentStateId: row.parentStateId,
              pieceId: row.pieceId,
              transform: row.transform
            }
          ]
    })
    return {
      mode: 'F0-observer-only',
      scope: {
        seedDecodes: 'two strict Stage 0 seeds',
        stage1Arms:
          'no rows: Stage 1 transport/refinement does not request a fresh NFP/IFP decode or reconstruction',
        candidateBehaviorChanged: false,
        scoringBehaviorChanged: false,
        transformPolicyChanged: false
      },
      rows,
      boundedWitnesses: witnesses,
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
  readonly liveConvexRejected: number
  readonly liveConvexLegal: number
  readonly phaseIncompatible: number
  readonly canonicalChecked: number
  readonly canonicalLegal: number
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
    liveConvexRejected: observation.provenance.liveConvexRejected,
    liveConvexLegal: observation.provenance.liveConvexLegal,
    phaseIncompatible: observation.provenance.phaseIncompatible,
    canonicalChecked: observation.provenance.canonicalChecked,
    canonicalLegal: observation.provenance.canonicalLegal,
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

function transformIdentity(transform: { readonly index: number; readonly rotationDeg: number; readonly mirrored: boolean; readonly reason: string }): string {
  return `${transform.index}:${transform.rotationDeg}:${transform.mirrored ? 'mirror' : 'plain'}:${transform.reason}`
}

function sameTransform(
  first: { readonly index: number; readonly rotationDeg: number; readonly mirrored: boolean; readonly reason: string },
  second: { readonly index: number; readonly rotationDeg: number; readonly mirrored: boolean; readonly reason: string }
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
  const arms = value.split(',').filter((arm): arm is IntrinsicV7Stage1Arm =>
    arm === 'control' || arm === 'split' || arm === 'atomic' || arm === 'refine'
  )
  if (arms.length === 0 || arms.join(',') !== value) {
    throw new Error('--arms must be a comma-separated subset of control,split,atomic,refine')
  }
  return [...new Set(arms)]
}

async function loadFixture(
  name: 'triangle-20' | 'mixed-61'
): Promise<{
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

function withLayers<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  settings: IrregularNestingSettings
) {
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
        settings: request.options.irregularSettings?.optimizer ??
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
    placementOrder: placed.map(
      ({ placement }) => placement.pieceId ?? placement.sourcePieceId
    )
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
    .map(
      (polygon) =>
        `<polygon points="${polygon.map(({ x, y }) => `${x},${-y}`).join(' ')}"/>`
    )
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
