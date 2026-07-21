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
import { runIntrinsicPeriodicFamilyPortfolio } from '../src/workers/algorithm/irregular/intrinsicPeriodicFamilyPortfolio.js'
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
const basisSourceKey = argument('--basis-source-key')
await mkdir(outputDirectory, { recursive: true })

const fixture = await loadFixture(fixtureName)
const settings = fixture.request.options.irregularSettings
if (settings === undefined) throw new Error(`${fixtureName} has no irregular settings`)
const preparedPieces = await Effect.runPromise(withLayers(preparePieces(fixture.request, settings), settings))
const result = await Effect.runPromise(
  withLayers(
    runIntrinsicPeriodicFamilyPortfolio(fixture.request.sheet, preparedPieces, {
      maximumCellsPerFamilyRole,
      maximumCropsPerCell,
      maximumContinuationCount,
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
    metrics: run.result?.metrics,
    certificate: run.result?.certificate,
    canonicalGeometryHash: run.result?.canonicalGeometryHash,
    svgPath
  })
}

const reportPath = `${outputDirectory}/report.json`
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
    catalogMs: 15_000,
    families: 8,
    transformsPerFamily: 16,
    pairsPerFamily: 120,
    cellsPerFamilyRole: maximumCellsPerFamilyRole,
    cropsPerCell: maximumCropsPerCell,
    continuations: maximumContinuationCount,
    basisSourceKey,
    continuationMs: 25_000,
    fixtureMs: 240_000
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

function safePath(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}
