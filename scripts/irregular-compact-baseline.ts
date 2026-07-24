import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
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
  type IrregularPlacedPiece
} from '../src/shared/irregular/domain.js'
import { makePresetShapeDocument } from '../src/shared/presetShapes.js'
import { preparePieces } from '../src/shared/preparePieces.js'
import {
  computeIrregularNesting,
  intrinsicAnytimeSchedulerTraceValid,
  type IrregularComputeResult
} from '../src/workers/algorithm/irregular/computeIrregularNesting.js'
import { IrregularLayoutScorer } from '../src/workers/algorithm/irregular/irregularLayoutScorer.js'
import { IrregularPlacementScorer } from '../src/workers/algorithm/irregular/irregularPlacementScorer.js'
import { INTRINSIC_SHORT_SIDE_OBSERVER_MAX_TRACE_BYTES } from '../src/workers/algorithm/irregular/intrinsicShortSideObserver.js'
import {
  canonicalCollisionLayoutIdentity,
  measureCanonicalLayoutTopology
} from '../src/workers/irregular/canonicalLayoutGeometry.js'
import { CollisionGeometryBuilder } from '../src/workers/irregular/collisionGeometryBuilder.js'
import { FreeMaterialServiceLive } from '../src/workers/irregular/freeMaterialService.js'
import { GeometrySettings } from '../src/workers/irregular/geometryKernel.js'
import { NfpIfpServiceLive } from '../src/workers/irregular/nfpIfpService.js'
import { TransformGeneratorLive } from '../src/workers/irregular/transformGenerator.js'
import {
  canonicalizeIrregularLayout,
  type LayoutPoint
} from './lib/irregularLayoutCanonicalization.js'

type FixtureName = 'triangle-20' | 'mixed-61' | 'shapes-17'

interface Arguments {
  readonly fixture: FixtureName
  readonly sheet: SheetSpec
  readonly outputPrefix: string
  readonly strict: boolean
  readonly expectedCollisionIdentitySha256: string | undefined
  readonly expectedFittedCanonicalSha256: string | undefined
  readonly expectedPlacedCount: number | undefined
  readonly expectedUnplacedCount: number | undefined
  readonly maximumAreaMm2: number | undefined
  readonly maximumCanonicalCavities: number | undefined
  readonly maximumElapsedMs: number | undefined
  readonly disableFocusedCompleteReconstruction: boolean
  readonly captureShortSideObserver: boolean
  readonly expectedFocusedStatus: string | undefined
  readonly expectedFocusedEvaluations: number | undefined
  readonly expectedFocusedSourceHash: string | undefined
  readonly expectedFocusedCandidateHash: string | undefined
  readonly expectedFocusedSelectedHash: string | undefined
  readonly expectedFocusedInfluence: string | undefined
}

const MIXED_61_FIXTURE = fileURLToPath(
  new URL('../tests/fixtures/irregularSheetInvariance/mixed61-request.json', import.meta.url)
)
const SHAPES_17_FIXTURE = fileURLToPath(
  new URL('../tests/fixtures/irregularSeventeenShapes', import.meta.url)
)

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}

function requiredArgument(name: string): string {
  const value = argument(name)
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`)
  return value
}

function fixtureArgument(value: string): FixtureName {
  if (value === 'triangle-20' || value === 'mixed-61' || value === 'shapes-17') return value
  throw new Error('--fixture must be triangle-20, mixed-61, or shapes-17')
}

function sheetArgument(value: string): SheetSpec {
  const match = /^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/.exec(value)
  if (match === null) throw new Error('--sheet must be WIDTHxHEIGHT')
  const width = Number(match[1])
  const height = Number(match[2])
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('--sheet dimensions must be positive')
  }
  return new SheetSpec({ width, height, label: `${width}x${height}` })
}

function optionalNumberArgument(name: string): number | undefined {
  const value = argument(name)
  if (value === undefined) return undefined
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} must be non-negative`)
  return parsed
}

function optionalIntegerArgument(name: string): number | undefined {
  const parsed = optionalNumberArgument(name)
  if (parsed === undefined) return undefined
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} must be an integer`)
  return parsed
}

function parseArguments(): Arguments {
  return {
    fixture: fixtureArgument(requiredArgument('--fixture')),
    sheet: sheetArgument(requiredArgument('--sheet')),
    outputPrefix: requiredArgument('--output-prefix'),
    strict: process.argv.includes('--strict'),
    expectedCollisionIdentitySha256: argument('--expected-collision-identity-sha256'),
    expectedFittedCanonicalSha256: argument('--expected-fitted-canonical-sha256'),
    expectedPlacedCount: optionalIntegerArgument('--expected-placed-count'),
    expectedUnplacedCount: optionalIntegerArgument('--expected-unplaced-count'),
    maximumAreaMm2: optionalNumberArgument('--maximum-area-mm2'),
    maximumCanonicalCavities: optionalIntegerArgument('--maximum-canonical-cavities'),
    maximumElapsedMs: optionalNumberArgument('--maximum-elapsed-ms'),
    disableFocusedCompleteReconstruction: process.argv.includes(
      '--disable-focused-complete-reconstruction'
    ),
    captureShortSideObserver: process.argv.includes(
      '--capture-short-side-observer'
    ),
    expectedFocusedStatus: argument('--expected-focused-status'),
    expectedFocusedEvaluations: optionalIntegerArgument(
      '--expected-focused-evaluations'
    ),
    expectedFocusedSourceHash: argument('--expected-focused-source-hash'),
    expectedFocusedCandidateHash: argument(
      '--expected-focused-candidate-hash'
    ),
    expectedFocusedSelectedHash: argument('--expected-focused-selected-hash'),
    expectedFocusedInfluence: argument('--expected-focused-influence')
  }
}

function compactSettings(): IrregularNestingSettings {
  return new IrregularNestingSettings({
    geometry: DEFAULT_IRREGULAR_GEOMETRY_SETTINGS,
    optimizer: makeCompactQualityIrregularOptimizerSettings({ localRepairBudget: 0 })
  })
}

function requestOptions(settings: IrregularNestingSettings): NestingOptions {
  return new NestingOptions({
    allowGlobalRotation: true,
    allowGlobalMirror: true,
    timeoutMs: 0,
    workerMode: 'irregular-convex-v2',
    historyMode: 'off',
    historyScope: 'winning_path',
    strategySelectionMode: 'single',
    strategyIds: [],
    layoutSelectionStrategyId: 'compact-first',
    finalSelectionMode: 'best',
    irregularSettings: settings
  })
}

function buildPreparedRequest(input: {
  readonly fixture: FixtureName
  readonly sheet: SheetSpec
  readonly sources: ReadonlyArray<ImportedPiece>
  readonly interchangeabilityKey: (piece: ImportedPiece) => string
}): NestingRequest {
  const jobId = JobId.make(`compact-baseline-${input.fixture}-${input.sheet.label}`)
  const prepared = preparePieces(
    input.sources,
    input.sheet,
    10,
    jobId,
    undefined,
    undefined,
    input.interchangeabilityKey
  )
  if (prepared.warnings.length > 0) {
    throw new Error(`${input.fixture}: preparation warnings ${JSON.stringify(prepared.warnings)}`)
  }
  const settings = compactSettings()
  return new NestingRequest({
    version: 1,
    jobId,
    sheet: input.sheet,
    padding: 10,
    pieces: prepared.pieces,
    sourcePieces: input.sources,
    options: requestOptions(settings)
  })
}

function triangleRequest(sheet: SheetSpec): NestingRequest {
  const triangle = makePresetShapeDocument({
    kind: 'triangle',
    width: 70,
    height: 60,
    label: 'triangle'
  }).pieces[0]
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
  return buildPreparedRequest({
    fixture: 'triangle-20',
    sheet,
    sources,
    interchangeabilityKey: () => 'triangle-70x60'
  })
}

async function shapes17Request(sheet: SheetSpec): Promise<NestingRequest> {
  const fileNames = (await readdir(SHAPES_17_FIXTURE))
    .filter((fileName) => fileName.endsWith('.dxf'))
    .sort((first, second) => first.localeCompare(second, undefined, { numeric: true }))
  if (fileNames.length !== 17) throw new Error(`expected 17 DXF files, found ${fileNames.length}`)
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
  return buildPreparedRequest({
    fixture: 'shapes-17',
    sheet,
    sources,
    interchangeabilityKey: () => 'shapes-17'
  })
}

async function mixed61Request(sheet: SheetSpec): Promise<NestingRequest> {
  const document: unknown = JSON.parse(await readFile(MIXED_61_FIXTURE, 'utf8'))
  const request = Schema.decodeUnknownSync(NestingRequest)(document)
  const settings = request.options.irregularSettings
  if (settings === undefined) throw new Error('mixed-61 fixture has no irregular settings')
  return new NestingRequest({
    ...request,
    jobId: JobId.make(`compact-baseline-mixed-61-${sheet.label}`),
    sheet,
    options: new NestingOptions({
      ...request.options,
      timeoutMs: 0,
      historyMode: 'off',
      irregularSettings: settings
    })
  })
}

async function loadRequest(fixture: FixtureName, sheet: SheetSpec): Promise<NestingRequest> {
  if (fixture === 'triangle-20') return triangleRequest(sheet)
  if (fixture === 'shapes-17') return shapes17Request(sheet)
  return mixed61Request(sheet)
}

function absoluteCollisionPolygons(
  result: Pick<IrregularComputeResult, 'placedCollisionGeometries'>
): ReadonlyArray<ReadonlyArray<LayoutPoint>> {
  return result.placedCollisionGeometries.map(({ placement, collisionGeometry }) =>
    collisionGeometry.polygon.points.map(({ x, y }) => ({
      x: x + placement.transform.translateX,
      y: y + placement.transform.translateY
    }))
  )
}

function renderSvg(
  sheet: SheetSpec,
  polygons: ReadonlyArray<ReadonlyArray<LayoutPoint>>
): string {
  const margin = Math.max(20, Math.max(sheet.width, sheet.height) * 0.04)
  const viewMinX = -margin
  const viewMinY = -sheet.height - margin
  const viewWidth = sheet.width + margin * 2
  const viewHeight = sheet.height + margin * 2
  const paths = polygons
    .map((polygon) => `<polygon points="${polygon.map(({ x, y }) => `${x},${-y}`).join(' ')}"/>`)
    .join('')
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewMinX} ${viewMinY} ${viewWidth} ${viewHeight}" width="1000" height="${Math.round((1000 * viewHeight) / viewWidth)}">`,
    `<rect x="${viewMinX}" y="${viewMinY}" width="${viewWidth}" height="${viewHeight}" fill="#1b2328"/>`,
    `<rect x="0" y="${-sheet.height}" width="${sheet.width}" height="${sheet.height}" fill="#141b20" stroke="#9aa7b0" stroke-width="1.5" stroke-dasharray="6 4"/>`,
    `<g fill="#22313b" stroke="#39a9ff" stroke-width="1">${paths}</g>`,
    `</svg>`
  ].join('')
}

function layoutBounds(polygons: ReadonlyArray<ReadonlyArray<LayoutPoint>>): {
  readonly width: number
  readonly height: number
  readonly area: number
  readonly span: number
} {
  const points = polygons.flat()
  if (points.length === 0) return { width: 0, height: 0, area: 0, span: 0 }
  const minX = Math.min(...points.map(({ x }) => x))
  const minY = Math.min(...points.map(({ y }) => y))
  const maxX = Math.max(...points.map(({ x }) => x))
  const maxY = Math.max(...points.map(({ y }) => y))
  const width = maxX - minX
  const height = maxY - minY
  return { width, height, area: width * height, span: width + height }
}

function sha256CanonicalLayout(
  result: Pick<IrregularComputeResult, 'placedCollisionGeometries'>
): string | undefined {
  const identity = canonicalCollisionLayoutIdentity(result.placedCollisionGeometries)
  return identity === undefined ? undefined : createHash('sha256').update(identity).digest('hex')
}

function jsonSafe(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, entry: unknown) =>
      typeof entry === 'bigint' ? entry.toString() : entry
    )
  )
}

const args = parseArguments()
const request = await loadRequest(args.fixture, args.sheet)
const settings = request.options.irregularSettings
if (settings === undefined) throw new Error(`${args.fixture} has no irregular settings`)
let observerWinner:
  | {
      readonly canonicalGeometryHash: string
      readonly rotationDeg: 0 | 90
      readonly placedCollisionGeometries: ReadonlyArray<IrregularPlacedPiece>
    }
  | undefined
const startedAt = performance.now()
const result = await Effect.runPromise(
  computeIrregularNesting(
    request,
    {
      ...(args.disableFocusedCompleteReconstruction
        ? { focusedCompleteReconstructionControlArm: 'disable' as const }
        : {}),
      ...(args.captureShortSideObserver
        ? {
            captureIntrinsicShortSideObserver: true,
            onIntrinsicShortSideObserverWinner: (
              winner: typeof observerWinner
            ) => {
              observerWinner = winner
            }
          }
        : {})
    }
  ).pipe(
    Effect.provide(CollisionGeometryBuilder.Live),
    Effect.provide(TransformGeneratorLive),
    Effect.provide(NfpIfpServiceLive),
    Effect.provide(FreeMaterialServiceLive),
    Effect.provide(IrregularPlacementScorer.Live),
    Effect.provide(IrregularLayoutScorer.Live),
    Effect.provide(Layer.succeed(GeometrySettings, settings))
  )
)
const elapsedMs = Math.max(0, performance.now() - startedAt)
const polygons = absoluteCollisionPolygons(result)
const bounds = layoutBounds(polygons)
const canonicalTopology = measureCanonicalLayoutTopology(result.placedCollisionGeometries)
const collisionIdentitySha256 = sha256CanonicalLayout(result)
const fittedCanonicalSha256 =
  polygons.length === 0 ? undefined : canonicalizeIrregularLayout(polygons).sha256
const focusedTrace = result.focusedCompleteReconstructionTrace
const shortSideObserverTrace = result.intrinsicShortSideObserverTrace
const shortSideObserverWinner =
  shortSideObserverTrace?.observerWinnerCanonicalGeometryHash === undefined
    ? undefined
    : shortSideObserverTrace.endpoints.find(
        ({ canonicalGeometryHash }) =>
          canonicalGeometryHash ===
          shortSideObserverTrace.observerWinnerCanonicalGeometryHash
      )
const shortSideGuardEligibleEndpoints =
  shortSideObserverTrace?.endpoints.filter(
    ({ cavityHullGuardEligible }) => cavityHullGuardEligible
  ) ?? []
const shortSideParetoEligibleEndpoints =
  shortSideObserverTrace?.endpoints.filter(
    ({ geometricParetoEligible }) => geometricParetoEligible
  ) ?? []
const shortSideParetoHashes = shortSideParetoEligibleEndpoints.map(
  ({ canonicalGeometryHash }) => canonicalGeometryHash
)
const shortSideRankedHashes =
  shortSideObserverTrace?.rankedCanonicalGeometryHashes ?? []
const shortSideParetoHashSet = new Set(shortSideParetoHashes)
const shortSideRankedHashSet = new Set(shortSideRankedHashes)
const shortSideRankingExactlyMatchesPareto =
  shortSideParetoHashes.length === shortSideParetoHashSet.size &&
  shortSideRankedHashes.length === shortSideRankedHashSet.size &&
  shortSideParetoHashSet.size === shortSideRankedHashSet.size &&
  shortSideParetoHashes.every((hash) => shortSideRankedHashSet.has(hash))
const shortSideObserverContractValid =
  shortSideObserverTrace === undefined ||
  (shortSideObserverTrace.placementEvaluations === 0 &&
    shortSideObserverTrace.candidateEvaluations === 0 &&
    shortSideObserverTrace.serializedTraceBytes <=
      INTRINSIC_SHORT_SIDE_OBSERVER_MAX_TRACE_BYTES &&
    shortSideObserverTrace.evaluatedOrientationCount ===
      shortSideObserverTrace.settledEndpointCount * 2 &&
    shortSideObserverTrace.cavityHullGuardEligibleEndpointCount ===
      shortSideGuardEligibleEndpoints.length &&
    shortSideObserverTrace.geometricParetoEligibleEndpointCount ===
      shortSideParetoEligibleEndpoints.length &&
    shortSideRankingExactlyMatchesPareto &&
    shortSideObserverTrace.status !== 'runtime-budget-exceeded' &&
    shortSideObserverTrace.status !== 'trace-budget-exceeded' &&
    (shortSideObserverTrace.status === 'observed'
      ? shortSideObserverWinner?.selected.exactLegal === true &&
        shortSideObserverWinner.geometricParetoEligible &&
        shortSideObserverTrace.rankedCanonicalGeometryHashes[0] ===
          shortSideObserverTrace.observerWinnerCanonicalGeometryHash
      : shortSideObserverTrace.observerWinnerCanonicalGeometryHash ===
          undefined &&
        shortSideObserverTrace.observerWinnerRotationDeg === undefined &&
        shortSideObserverTrace.rankedCanonicalGeometryHashes.length === 0))
const shortSideProfileSource =
  !args.captureShortSideObserver
    ? undefined
    : observerWinner === undefined
      ? ('compact-fallback' as const)
      : ('guarded-stage1-winner' as const)
const shortSideProfilePlacedCollisionGeometries =
  shortSideProfileSource === undefined
    ? undefined
    : observerWinner?.placedCollisionGeometries ??
      result.placedCollisionGeometries
const shortSideProfileUnplacedPieceIds =
  shortSideProfileSource === undefined
    ? undefined
    : observerWinner === undefined
      ? result.unplacedPieceIds
      : []
const shortSideProfilePolygons =
  shortSideProfilePlacedCollisionGeometries === undefined
    ? undefined
    : absoluteCollisionPolygons({
        placedCollisionGeometries:
          shortSideProfilePlacedCollisionGeometries
      })
const shortSideProfileBounds =
  shortSideProfilePolygons === undefined
    ? undefined
    : layoutBounds(shortSideProfilePolygons)
const shortSideProfileTopology =
  shortSideProfilePlacedCollisionGeometries === undefined
    ? undefined
    : measureCanonicalLayoutTopology(
        shortSideProfilePlacedCollisionGeometries
      )
const shortSideProfileCollisionIdentitySha256 =
  shortSideProfilePlacedCollisionGeometries === undefined
    ? undefined
    : sha256CanonicalLayout({
        placedCollisionGeometries:
          shortSideProfilePlacedCollisionGeometries
      })
const shortSideProfileFittedCanonicalSha256 =
  shortSideProfilePolygons === undefined ||
  shortSideProfilePolygons.length === 0
    ? undefined
    : canonicalizeIrregularLayout(shortSideProfilePolygons).sha256
const matchesExpectedOptional = (
  actual: string | undefined,
  expected: string | undefined
): boolean =>
  expected === undefined
    ? true
    : expected === 'none'
      ? actual === undefined
      : actual === expected
const requestedPieceIds = request.pieces.map(({ id }) => id)
const placedPieceIds = result.placedCollisionGeometries.map(
  ({ placement }) => placement.pieceId
)
const definedPlacedPieceIds = placedPieceIds.filter(
  (pieceId): pieceId is NonNullable<typeof pieceId> => pieceId !== undefined
)
const requestedPieceIdSet = new Set(requestedPieceIds)
const placedPieceIdSet = new Set(definedPlacedPieceIds)
const unplacedPieceIdSet = new Set(result.unplacedPieceIds)
const exactPiecePartition =
  definedPlacedPieceIds.length === placedPieceIds.length &&
  requestedPieceIdSet.size === requestedPieceIds.length &&
  placedPieceIdSet.size === definedPlacedPieceIds.length &&
  unplacedPieceIdSet.size === result.unplacedPieceIds.length &&
  placedPieceIdSet.size + unplacedPieceIdSet.size === requestedPieceIdSet.size &&
  definedPlacedPieceIds.every((pieceId) => requestedPieceIdSet.has(pieceId)) &&
  result.unplacedPieceIds.every(
    (pieceId) =>
      requestedPieceIdSet.has(pieceId) && !placedPieceIdSet.has(pieceId)
  ) &&
  requestedPieceIds.every(
    (pieceId) =>
      placedPieceIdSet.has(pieceId) || unplacedPieceIdSet.has(pieceId)
  )
const shortSideProfilePlacedPieceIds =
  shortSideProfilePlacedCollisionGeometries?.map(
    ({ placement }) => placement.pieceId
  ) ?? []
const shortSideProfileDefinedPlacedPieceIds =
  shortSideProfilePlacedPieceIds.filter(
    (pieceId): pieceId is NonNullable<typeof pieceId> =>
      pieceId !== undefined
  )
const shortSideProfilePlacedPieceIdSet = new Set(
  shortSideProfileDefinedPlacedPieceIds
)
const shortSideProfileUnplacedPieceIdSet = new Set(
  shortSideProfileUnplacedPieceIds ?? []
)
const shortSideProfileExactPiecePartition =
  shortSideProfileSource === undefined ||
  (shortSideProfileUnplacedPieceIds !== undefined &&
    shortSideProfileDefinedPlacedPieceIds.length ===
    shortSideProfilePlacedPieceIds.length &&
    shortSideProfilePlacedPieceIdSet.size ===
      shortSideProfileDefinedPlacedPieceIds.length &&
    shortSideProfileUnplacedPieceIdSet.size ===
      shortSideProfileUnplacedPieceIds.length &&
    shortSideProfilePlacedPieceIdSet.size +
      shortSideProfileUnplacedPieceIdSet.size ===
      requestedPieceIdSet.size &&
    shortSideProfileDefinedPlacedPieceIds.every((pieceId) =>
      requestedPieceIdSet.has(pieceId)
    ) &&
    shortSideProfileUnplacedPieceIds.every(
      (pieceId) =>
        requestedPieceIdSet.has(pieceId) &&
        !shortSideProfilePlacedPieceIdSet.has(pieceId)
    ) &&
    requestedPieceIds.every(
      (pieceId) =>
        shortSideProfilePlacedPieceIdSet.has(pieceId) ||
        shortSideProfileUnplacedPieceIdSet.has(pieceId)
    ))
const svgPath = `${args.outputPrefix}.svg`
const shortSideProfileSvgPath =
  shortSideProfilePolygons === undefined
    ? undefined
    : `${args.outputPrefix}.short-side-profile.svg`
const shortSideProfileReportPath =
  shortSideProfileSource === undefined
    ? undefined
    : `${args.outputPrefix}.short-side-profile.json`
const reportPath = `${args.outputPrefix}.json`
await mkdir(dirname(args.outputPrefix), { recursive: true })
await writeFile(svgPath, renderSvg(args.sheet, polygons))
if (
  shortSideProfilePolygons !== undefined &&
  shortSideProfileSvgPath !== undefined
) {
  await writeFile(
    shortSideProfileSvgPath,
    renderSvg(args.sheet, shortSideProfilePolygons)
  )
}
if (
  shortSideProfileSource !== undefined &&
  shortSideProfileReportPath !== undefined
) {
  await writeFile(
    shortSideProfileReportPath,
    `${JSON.stringify(
      jsonSafe({
        fixture: args.fixture,
        profile: 'short-side',
        sheet: {
          width: args.sheet.width,
          height: args.sheet.height
        },
        source: shortSideProfileSource,
        observerStatus: shortSideObserverTrace?.status,
        selectedRotationDeg:
          shortSideObserverTrace?.observerWinnerRotationDeg,
        placedCount:
          shortSideProfilePlacedCollisionGeometries?.length ?? 0,
        unplacedCount:
          shortSideProfileUnplacedPieceIds?.length ?? 0,
        unplacedPieceIds: shortSideProfileUnplacedPieceIds ?? [],
        collisionIdentitySha256:
          shortSideProfileCollisionIdentitySha256,
        fittedCanonicalSha256:
          shortSideProfileFittedCanonicalSha256,
        canonicalTopology: shortSideProfileTopology,
        bounds: shortSideProfileBounds,
        exactPiecePartition: shortSideProfileExactPiecePartition,
        svgPath: shortSideProfileSvgPath
      }),
      null,
      2
    )}\n`
  )
}

const checks = {
  collisionIdentity:
    args.expectedCollisionIdentitySha256 === undefined ||
    collisionIdentitySha256 === args.expectedCollisionIdentitySha256,
  fittedCanonical:
    args.expectedFittedCanonicalSha256 === undefined ||
    fittedCanonicalSha256 === args.expectedFittedCanonicalSha256,
  placedCount:
    args.expectedPlacedCount === undefined ||
    result.placedCollisionGeometries.length === args.expectedPlacedCount,
  unplacedCount:
    args.expectedUnplacedCount === undefined ||
    result.unplacedPieceIds.length === args.expectedUnplacedCount,
  exactPiecePartition,
  area:
    args.maximumAreaMm2 === undefined || bounds.area <= args.maximumAreaMm2 + 0.000_001,
  canonicalCavities:
    args.maximumCanonicalCavities === undefined ||
    (canonicalTopology?.enclosedCavityCount ?? Number.POSITIVE_INFINITY) <=
      args.maximumCanonicalCavities,
  runtime: args.maximumElapsedMs === undefined || elapsedMs <= args.maximumElapsedMs,
  schedulerChronology:
    result.intrinsicAnytimeSchedulerTrace === undefined ||
    intrinsicAnytimeSchedulerTraceValid(result.intrinsicAnytimeSchedulerTrace),
  focusedTracePresent:
    args.disableFocusedCompleteReconstruction ||
    focusedTrace !== undefined,
  focusedStatus:
    args.expectedFocusedStatus === undefined ||
    focusedTrace?.status === args.expectedFocusedStatus,
  focusedEvaluations:
    args.expectedFocusedEvaluations === undefined ||
    focusedTrace?.consumedCandidateEvaluations ===
      args.expectedFocusedEvaluations,
  focusedSourceHash: matchesExpectedOptional(
    focusedTrace?.sourceCanonicalGeometryHash,
    args.expectedFocusedSourceHash
  ),
  focusedCandidateHash: matchesExpectedOptional(
    focusedTrace?.candidateCanonicalGeometryHash,
    args.expectedFocusedCandidateHash
  ),
  focusedSelectedHash: matchesExpectedOptional(
    focusedTrace?.selectedCanonicalGeometryHash,
    args.expectedFocusedSelectedHash
  ),
  focusedInfluence:
    args.expectedFocusedInfluence === undefined ||
    focusedTrace?.outputInfluence === args.expectedFocusedInfluence,
  focusedAccounting:
    focusedTrace === undefined ||
    focusedTrace.candidateEvaluationAccountingComplete,
  focusedFailureReason:
    focusedTrace === undefined || focusedTrace.failureReason === undefined,
  shortSideObserverTracePresent:
    !args.captureShortSideObserver ||
    result.intrinsicShortSideObserverTrace !== undefined,
  shortSideObserverOutputInfluence:
    result.intrinsicShortSideObserverTrace === undefined ||
    result.intrinsicShortSideObserverTrace.outputInfluence === 'none',
  shortSideObserverRuntimeBudget:
    shortSideObserverTrace === undefined ||
    !shortSideObserverTrace.runtimeBudgetExceeded,
  shortSideObserverContract: shortSideObserverContractValid,
  shortSideProfileMaterialized:
    !args.captureShortSideObserver ||
    (shortSideProfileSource !== undefined &&
      shortSideProfilePlacedCollisionGeometries !== undefined &&
      shortSideProfileUnplacedPieceIds !== undefined &&
      shortSideProfileSvgPath !== undefined &&
      shortSideProfileReportPath !== undefined),
  shortSideProfileExactPiecePartition
}
const passed = Object.values(checks).every(Boolean)
const report = jsonSafe({
  fixture: args.fixture,
  sheet: { width: args.sheet.width, height: args.sheet.height },
  sourceCommit:
    process.env.BASELINE_SOURCE_COMMIT ??
    execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  runtime: { elapsedMs, node: process.version, v8: process.versions.v8 },
  result: {
    placedCount: result.placedCollisionGeometries.length,
    unplacedCount: result.unplacedPieceIds.length,
    unplacedPieceIds: result.unplacedPieceIds,
    collisionIdentitySha256,
    fittedCanonicalSha256,
    canonicalTopology,
    bounds,
    score: result.score,
    portfolio: result.portfolio,
    capacityTrace: result.capacityTrace,
    capacityShadowTelemetry: result.capacityShadowTelemetry,
    intrinsicAnytimeSchedulerTrace: result.intrinsicAnytimeSchedulerTrace,
    experimentalPlaceDeferTrace: result.experimentalPlaceDeferTrace,
    focusedCompleteReconstructionTrace:
      result.focusedCompleteReconstructionTrace,
    intrinsicShortSideObserverTrace:
      result.intrinsicShortSideObserverTrace
  },
  checks,
  passed,
  svgPath,
  shortSideProfileSvgPath,
  shortSideProfileReportPath
})
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify({ reportPath, svgPath, elapsedMs, checks, passed }))
if (args.strict && !passed) process.exitCode = 1
