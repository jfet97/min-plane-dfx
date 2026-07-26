import { mkdir, readFile, writeFile } from 'node:fs/promises'
import {
  enableNfpIfpTelemetry,
  nfpIfpTelemetrySnapshot
} from '../src/workers/irregular/nfpIfpTelemetry.js'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { Effect, Layer, Schema } from 'effect'
import { ImportedPiece } from '../src/shared/domain/dxf.js'
import { JobId, PieceId, SourceFileId } from '../src/shared/domain/ids.js'
import { NestingOptions, NestingRequest, SheetSpec } from '../src/shared/domain/nesting.js'
import {
  DEFAULT_IRREGULAR_GEOMETRY_SETTINGS,
  makeCompactQualityIrregularOptimizerSettings
} from '../src/shared/irregular/defaults.js'
import { IrregularNestingSettings } from '../src/shared/irregular/domain.js'
import {
  makePresetShapeDocument,
  type PresetShapeKind
} from '../src/shared/presetShapes.js'
import { preparePieces } from '../src/shared/preparePieces.js'
import { sortPiecesForNesting } from '../src/workers/algorithm/sortPiecesForNesting.js'
import { computeIrregularNesting } from '../src/workers/algorithm/irregular/computeIrregularNesting.js'
import { IrregularLayoutScorer } from '../src/workers/algorithm/irregular/irregularLayoutScorer.js'
import { IrregularPlacementScorer } from '../src/workers/algorithm/irregular/irregularPlacementScorer.js'
import { CollisionGeometryBuilder } from '../src/workers/irregular/collisionGeometryBuilder.js'
import { FreeMaterialServiceLive } from '../src/workers/irregular/freeMaterialService.js'
import { GeometrySettings } from '../src/workers/irregular/geometryKernel.js'
import { NfpIfpServiceLive } from '../src/workers/irregular/nfpIfpService.js'
import { TransformGeneratorLive } from '../src/workers/irregular/transformGenerator.js'
import { measureCanonicalLayoutTopology } from '../src/workers/irregular/canonicalLayoutGeometry.js'
import {
  canonicalizeIrregularLayout,
  type LayoutPoint
} from './lib/irregularLayoutCanonicalization.js'

interface ShapeSpec {
  readonly id: string
  readonly kind: PresetShapeKind
  readonly width: number
  readonly height: number
  readonly topWidth?: number
}

interface GeneratedCorpusCase {
  readonly id: string
  readonly count: number
  readonly shapes: ReadonlyArray<ShapeSpec>
  readonly localRepairBudget: number
}

interface CorpusArguments {
  readonly selectedCaseIds: ReadonlySet<string>
  readonly outputDirectory: string
  readonly sheets: ReadonlyArray<SheetSpec>
  readonly strict: boolean
  readonly allowSingleSheet: boolean
  readonly expectedCanonicalSha256: string | undefined
  readonly maximumAreaMm2: number | undefined
  readonly maximumCanonicalCavities: number | undefined
  readonly maximumElapsedMs: number | undefined
  readonly inventoryOnly: boolean
  readonly sourceCommit: string | undefined
  readonly captureCacheTelemetry: boolean
}

const COMPACT_SHEET = new SheetSpec({ width: 1000, height: 1700, label: 'compact roomy' })
const REFERENCE_SHEET = new SheetSpec({
  width: 2000,
  height: 2700,
  label: 'reference roomy'
})
const MIXED_61_FIXTURE = fileURLToPath(
  new URL('../tests/fixtures/irregularSheetInvariance/mixed61-request.json', import.meta.url)
)
const HARNESS_SOURCE = fileURLToPath(import.meta.url)
const PRESET_SOURCE = fileURLToPath(new URL('../src/shared/presetShapes.ts', import.meta.url))

const triangle: ShapeSpec = { id: 'triangle-70x60', kind: 'triangle', width: 70, height: 60 }
const trapezoid: ShapeSpec = {
  id: 'trapezoid-100x75x60',
  kind: 'trapezoid',
  width: 100,
  height: 75,
  topWidth: 60
}
const rectangle: ShapeSpec = {
  id: 'rectangle-154x104',
  kind: 'rectangle',
  width: 154,
  height: 104
}
const pentagon: ShapeSpec = { id: 'pentagon-90', kind: 'pentagon', width: 90, height: 90 }
const star: ShapeSpec = { id: 'star-hull-90', kind: 'star', width: 90, height: 90 }
const hexagon: ShapeSpec = { id: 'hexagon-100x86', kind: 'hexagon', width: 100, height: 86 }

const generatedCases: ReadonlyArray<GeneratedCorpusCase> = [
  { id: 'triangle-golden-20', count: 20, shapes: [triangle], localRepairBudget: 8 },
  { id: 'rectangles-20', count: 20, shapes: [rectangle], localRepairBudget: 0 },
  { id: 'trapezoids-20', count: 20, shapes: [trapezoid], localRepairBudget: 0 },
  { id: 'pentagons-20', count: 20, shapes: [pentagon], localRepairBudget: 0 },
  { id: 'star-hulls-20', count: 20, shapes: [star], localRepairBudget: 0 },
  {
    id: 'mixed-50',
    count: 50,
    shapes: [triangle, trapezoid, rectangle, pentagon, star, hexagon],
    localRepairBudget: 0
  }
]
const allCaseIds = [...generatedCases.map(({ id }) => id), 'mixed-61']

function parseArguments(argumentsList: ReadonlyArray<string>): CorpusArguments {
  const selectedCaseIds = new Set<string>()
  let outputDirectory = '/private/tmp/irregular-sheet-invariance'
  let sheets: ReadonlyArray<SheetSpec> = [COMPACT_SHEET, REFERENCE_SHEET]
  let strict = false
  let allowSingleSheet = false
  let expectedCanonicalSha256: string | undefined
  let maximumAreaMm2: number | undefined
  let maximumCanonicalCavities: number | undefined
  let maximumElapsedMs: number | undefined
  let inventoryOnly = false
  let sourceCommit: string | undefined
  let captureCacheTelemetry = false
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index]
    if (argument === '--capture-cache-telemetry') {
      captureCacheTelemetry = true
      continue
    }
    if (argument === '--inventory-only') {
      inventoryOnly = true
      continue
    }
    if (argument === '--source-commit') {
      sourceCommit = requiredArgumentValue(argumentsList, index, argument)
      index += 1
      continue
    }
    if (argument === '--strict') {
      strict = true
      continue
    }
    if (argument === '--allow-single-sheet') {
      allowSingleSheet = true
      continue
    }
    if (argument === '--expected-canonical-sha256') {
      expectedCanonicalSha256 = requiredArgumentValue(argumentsList, index, argument)
      index += 1
      continue
    }
    if (argument === '--maximum-area-mm2') {
      maximumAreaMm2 = positiveNumberArgument(argumentsList, index, argument)
      index += 1
      continue
    }
    if (argument === '--maximum-canonical-cavities') {
      maximumCanonicalCavities = nonNegativeIntegerArgument(argumentsList, index, argument)
      index += 1
      continue
    }
    if (argument === '--maximum-elapsed-ms') {
      maximumElapsedMs = positiveNumberArgument(argumentsList, index, argument)
      index += 1
      continue
    }
    if (argument === '--case') {
      const value = argumentsList[index + 1]
      if (value === undefined) throw new Error('--case requires a comma-separated value')
      for (const caseId of value.split(',')) selectedCaseIds.add(caseId)
      index += 1
      continue
    }
    if (argument === '--output') {
      const value = argumentsList[index + 1]
      if (value === undefined) throw new Error('--output requires a directory')
      outputDirectory = value
      index += 1
      continue
    }
    if (argument === '--sheets') {
      const value = argumentsList[index + 1]
      if (value === undefined) throw new Error('--sheets requires comma-separated WIDTHxHEIGHT values')
      sheets = parseSheets(value)
      index += 1
      continue
    }
    if (argument === '--help') {
      console.log(
        `Usage: pnpm corpus:sheet-invariance [--case ${allCaseIds.join(',')}] [--output <dir>] [--sheets WIDTHxHEIGHT,...] [--strict] [--allow-single-sheet] [--expected-canonical-sha256 <hash>] [--maximum-area-mm2 <number>] [--maximum-canonical-cavities <integer>] [--maximum-elapsed-ms <number>] [--inventory-only --source-commit <sha>]`
      )
      process.exit(0)
    }
    throw new Error(`unknown argument ${argument ?? ''}`)
  }
  if (selectedCaseIds.size === 0) {
    for (const caseId of allCaseIds) selectedCaseIds.add(caseId)
  }
  for (const caseId of selectedCaseIds) {
    if (!allCaseIds.includes(caseId)) throw new Error(`unknown corpus case ${caseId}`)
  }
  if (strict && sheets.length < 2 && !allowSingleSheet) {
    throw new Error('--strict with one sheet requires --allow-single-sheet and explicit quality gates')
  }
  if (
    strict &&
    sheets.length < 2 &&
    (expectedCanonicalSha256 === undefined ||
      maximumAreaMm2 === undefined ||
      maximumCanonicalCavities === undefined ||
      maximumElapsedMs === undefined)
  ) {
    throw new Error(
      '--strict with one sheet requires hash, area, canonical-cavity, and runtime quality gates'
    )
  }
  if (inventoryOnly && sourceCommit === undefined) {
    throw new Error('--inventory-only requires --source-commit')
  }
  return {
    selectedCaseIds,
    outputDirectory,
    sheets,
    strict,
    allowSingleSheet,
    expectedCanonicalSha256,
    maximumAreaMm2,
    maximumCanonicalCavities,
    maximumElapsedMs,
    inventoryOnly,
    captureCacheTelemetry,
    sourceCommit
  }
}

function requiredArgumentValue(
  argumentsList: ReadonlyArray<string>,
  index: number,
  name: string
): string {
  const value = argumentsList[index + 1]
  if (value === undefined) throw new Error(`${name} requires a value`)
  return value
}

function positiveNumberArgument(
  argumentsList: ReadonlyArray<string>,
  index: number,
  name: string
): number {
  const value = Number(requiredArgumentValue(argumentsList, index, name))
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`)
  return value
}

function nonNegativeIntegerArgument(
  argumentsList: ReadonlyArray<string>,
  index: number,
  name: string
): number {
  const value = Number(requiredArgumentValue(argumentsList, index, name))
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`)
  }
  return value
}

function parseSheets(value: string): ReadonlyArray<SheetSpec> {
  const dimensions = value.split(',')
  if (dimensions.length < 1) throw new Error('--sheets requires at least one sheet')
  const seen = new Set<string>()
  return dimensions.map((dimension) => {
    const match = /^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/.exec(dimension)
    if (match === null) throw new Error(`invalid sheet dimensions ${dimension}`)
    const width = Number(match[1])
    const height = Number(match[2])
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      throw new Error(`invalid sheet dimensions ${dimension}`)
    }
    const key = `${width}x${height}`
    if (seen.has(key)) throw new Error(`duplicate sheet dimensions ${dimension}`)
    seen.add(key)
    return new SheetSpec({ width, height, label: key })
  })
}

function makeGeneratedRequest(corpusCase: GeneratedCorpusCase): NestingRequest {
  const jobId = JobId.make(`sheet-invariance-${corpusCase.id}`)
  const bases = new Map(
    corpusCase.shapes.map((shape) => {
      const piece = makePresetShapeDocument({
        kind: shape.kind,
        width: shape.width,
        height: shape.height,
        ...(shape.topWidth === undefined ? {} : { topWidth: shape.topWidth }),
        label: shape.id
      }).pieces[0]
      if (piece === undefined) throw new Error(`preset ${shape.id} produced no piece`)
      return [shape.id, piece] as const
    })
  )
  const interchangeabilityKeys = new Map<PieceId, string>()
  const sources = Array.from({ length: corpusCase.count }, (_, index) => {
    const shape = corpusCase.shapes[index % corpusCase.shapes.length]
    if (shape === undefined) throw new Error(`${corpusCase.id} has no source shapes`)
    const base = bases.get(shape.id)
    if (base === undefined) throw new Error(`missing preset base ${shape.id}`)
    const id = PieceId.make(`${corpusCase.id}-${shape.id}-${index + 1}`)
    interchangeabilityKeys.set(id, shape.id)
    return new ImportedPiece({
      ...base,
      id,
      sourceFileId: SourceFileId.make(`${corpusCase.id}-${shape.id}-source-${index + 1}`),
      label: `${shape.id} copy ${index + 1}`
    })
  })
  const prepared = preparePieces(
    sources,
    COMPACT_SHEET,
    10,
    jobId,
    undefined,
    undefined,
    (piece) => interchangeabilityKeys.get(piece.id) ?? piece.id
  )
  if (prepared.warnings.length > 0) {
    throw new Error(`${corpusCase.id} preparation warnings: ${JSON.stringify(prepared.warnings)}`)
  }
  const settings = new IrregularNestingSettings({
    geometry: DEFAULT_IRREGULAR_GEOMETRY_SETTINGS,
    optimizer: makeCompactQualityIrregularOptimizerSettings({
      localRepairBudget: corpusCase.localRepairBudget
    })
  })
  return new NestingRequest({
    version: 1,
    jobId,
    sheet: COMPACT_SHEET,
    padding: 10,
    pieces: prepared.pieces,
    sourcePieces: sources,
    options: new NestingOptions({
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
  })
}

async function loadMixed61Request(): Promise<NestingRequest> {
  const document: unknown = JSON.parse(await readFile(MIXED_61_FIXTURE, 'utf8'))
  return Schema.decodeUnknownSync(NestingRequest)(document)
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

async function fileSha256(path: string): Promise<string> {
  return sha256(await readFile(path, 'utf8'))
}

async function writeInventory(argumentsData: CorpusArguments): Promise<string> {
  const cases = []
  for (const caseId of allCaseIds) {
    if (!argumentsData.selectedCaseIds.has(caseId)) continue
    const generated = generatedCases.find(({ id }) => id === caseId)
    const request = generated === undefined ? await loadMixed61Request() : makeGeneratedRequest(generated)
    const requestOrder = request.pieces.map(({ id }) => id)
    const productionPreparedOrder = sortPiecesForNesting(request.pieces).map(({ id }) => id)
    const source =
      generated === undefined
        ? {
            kind: 'persisted-request',
            path: 'tests/fixtures/irregularSheetInvariance/mixed61-request.json',
            sha256: await fileSha256(MIXED_61_FIXTURE)
          }
        : {
            kind: 'generated-preset-recipe',
            recipe: generated,
            recipeSha256: sha256(JSON.stringify(generated))
          }
    cases.push({
      caseId,
      included: true,
      source,
      requestSha256: sha256(JSON.stringify(request)),
      pieceCount: request.pieces.length,
      requestOrder,
      requestOrderSha256: sha256(requestOrder.join('\n')),
      productionPreparedOrder,
      productionPreparedOrderSha256: sha256(productionPreparedOrder.join('\n')),
      paddingMm: request.padding,
      optimizerSettingsSha256: sha256(JSON.stringify(request.options.irregularSettings)),
      compactEligible:
        request.options.workerMode === 'irregular-convex-v2' &&
        request.options.layoutSelectionStrategyId === 'compact-first',
      sheetClassification: argumentsData.sheets.map(({ width, height }) => ({
        width,
        height,
        expected: 'roomy_same_complete'
      }))
    })
  }
  const inventoryPath = `${argumentsData.outputDirectory}/inventory.json`
  const inventory = {
    version: 2,
    sourceCommit: argumentsData.sourceCommit,
    harness: {
      path: 'scripts/irregular-sheet-invariance.ts',
      sha256: await fileSha256(HARNESS_SOURCE)
    },
    presetGenerator: {
      path: 'src/shared/presetShapes.ts',
      sha256: await fileSha256(PRESET_SOURCE)
    },
    sheets: argumentsData.sheets,
    cases,
    excluded: [
      {
        classification: 'curved',
        reason: 'no exact current request exists in the maintained no-options harness'
      },
      {
        classification: 'scale-diverse',
        reason: 'no exact current request exists in the maintained no-options harness'
      },
      {
        classification: 'Shapes-17 and current constrained baselines',
        reason: 'covered by the separate accepted nine-case gate'
      },
      {
        classification: 'historical Mixed-61 aspect-ratio sheets',
        reason: 'covered by the separate accepted ten-sheet gate'
      }
    ]
  }
  await writeFile(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`)
  return inventoryPath
}

function withSheet(request: NestingRequest, sheet: SheetSpec, suffix: string): NestingRequest {
  const settings = request.options.irregularSettings
  if (settings === undefined) throw new Error(`${request.jobId} has no irregular settings`)
  return new NestingRequest({
    ...request,
    jobId: JobId.make(`${request.jobId}-${suffix}`),
    sheet,
    options: new NestingOptions({
      ...request.options,
      timeoutMs: 0,
      historyMode: 'off',
      irregularSettings: settings
    })
  })
}

function absoluteCollisionPolygons(
  placed: ReadonlyArray<{
    readonly placement: { readonly transform: { readonly translateX: number; readonly translateY: number } }
    readonly collisionGeometry: { readonly polygon: { readonly points: ReadonlyArray<LayoutPoint> } }
  }>
): ReadonlyArray<ReadonlyArray<LayoutPoint>> {
  return placed.map(({ placement, collisionGeometry }) =>
    collisionGeometry.polygon.points.map(({ x, y }) => ({
      x: x + placement.transform.translateX,
      y: y + placement.transform.translateY
    }))
  )
}

function polygonBounds(polygons: ReadonlyArray<ReadonlyArray<LayoutPoint>>): {
  readonly minX: number
  readonly minY: number
  readonly width: number
  readonly height: number
} {
  const points = polygons.flat()
  if (points.length === 0) return { minX: 0, minY: 0, width: 0, height: 0 }
  const minX = Math.min(...points.map(({ x }) => x))
  const minY = Math.min(...points.map(({ y }) => y))
  const maxX = Math.max(...points.map(({ x }) => x))
  const maxY = Math.max(...points.map(({ y }) => y))
  return { minX, minY, width: maxX - minX, height: maxY - minY }
}

function renderSvg(polygons: ReadonlyArray<ReadonlyArray<LayoutPoint>>): string {
  const bounds = polygonBounds(polygons)
  const margin = 20
  const paths = polygons
    .map(
      (polygon) =>
        `<polygon points="${polygon.map(({ x, y }) => `${x},${-y}`).join(' ')}"/>`
    )
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${bounds.minX - margin} ${-bounds.minY - bounds.height - margin} ${bounds.width + margin * 2} ${bounds.height + margin * 2}" width="1000" height="1000"><rect x="${bounds.minX - margin}" y="${-bounds.minY - bounds.height - margin}" width="${bounds.width + margin * 2}" height="${bounds.height + margin * 2}" fill="#1b2328"/><g fill="#22313b" stroke="#39a9ff" stroke-width="1">${paths}</g></svg>`
}

async function runRequest(request: NestingRequest, artifactPath: string) {
  const settings = request.options.irregularSettings
  if (settings === undefined) throw new Error(`${request.jobId} has no irregular settings`)
  const startedAt = performance.now()
  const result = await Effect.runPromise(
    computeIrregularNesting(request).pipe(
      Effect.provide(CollisionGeometryBuilder.Live),
      Effect.provide(TransformGeneratorLive),
      Effect.provide(NfpIfpServiceLive),
      Effect.provide(FreeMaterialServiceLive),
      Effect.provide(IrregularPlacementScorer.Live),
      Effect.provide(IrregularLayoutScorer.Live),
      Effect.provide(Layer.succeed(GeometrySettings, settings))
    )
  )
  const elapsedMs = performance.now() - startedAt
  const polygons = absoluteCollisionPolygons(result.placedCollisionGeometries)
  const bounds = polygonBounds(polygons)
  const canonical = canonicalizeIrregularLayout(polygons)
  const canonicalTopology = measureCanonicalLayoutTopology(result.placedCollisionGeometries)
  await writeFile(artifactPath, renderSvg(polygons))
  return {
    sheet: { width: request.sheet.width, height: request.sheet.height },
    elapsedMs,
    placedCount: result.placedCollisionGeometries.length,
    unplacedCount: result.unplacedPieceIds.length,
    bounds: {
      ...bounds,
      shortSide: Math.min(bounds.width, bounds.height),
      longSide: Math.max(bounds.width, bounds.height),
      area: bounds.width * bounds.height,
      span: bounds.width + bounds.height
    },
    canonicalSha256: canonical.sha256,
    canonicalRotationDeg: canonical.rotationDeg,
    canonicalTopology,
    score: {
      occupiedHullWasteRatio: result.score.occupiedHullWasteRatio,
      nearCompleteStructuralContactCount: result.score.nearCompleteStructuralContactCount,
      dominantNearCompleteStructuralContactCount:
        result.score.dominantNearCompleteStructuralContactCount,
      sharedCollisionBoundaryContactUnits: result.score.sharedCollisionBoundaryContactUnits,
      freeMaterialHoleCount: result.score.freeMaterialHoleCount
    },
    artifactPath
  }
}

async function runCorpus(argumentsData: CorpusArguments): Promise<void> {
  const caseReports = []
  for (const caseId of allCaseIds) {
    if (!argumentsData.selectedCaseIds.has(caseId)) continue
    const generated = generatedCases.find(({ id }) => id === caseId)
    const sourceRequest =
      generated === undefined ? await loadMixed61Request() : makeGeneratedRequest(generated)
    const runs = []
    for (const currentSheet of argumentsData.sheets) {
      const sheetId = `${currentSheet.width}x${currentSheet.height}`
      runs.push(
        await runRequest(
          withSheet(sourceRequest, currentSheet, sheetId),
          `${argumentsData.outputDirectory}/${caseId}-${sheetId}.svg`
        )
      )
    }
    const firstRun = runs[0]
    const geometryEquivalent =
      runs.length < 2
        ? null
        : firstRun !== undefined &&
          runs.every(({ canonicalSha256 }) => canonicalSha256 === firstRun.canonicalSha256)
    const qualityChecks = runs.map((run) => ({
      sheet: run.sheet,
      canonicalHash:
        argumentsData.expectedCanonicalSha256 === undefined ||
        run.canonicalSha256 === argumentsData.expectedCanonicalSha256,
      area:
        argumentsData.maximumAreaMm2 === undefined ||
        run.bounds.area <= argumentsData.maximumAreaMm2,
      canonicalCavities:
        argumentsData.maximumCanonicalCavities === undefined ||
        (run.canonicalTopology?.enclosedCavityCount ?? Number.POSITIVE_INFINITY) <=
          argumentsData.maximumCanonicalCavities,
      runtime:
        argumentsData.maximumElapsedMs === undefined ||
        run.elapsedMs <= argumentsData.maximumElapsedMs
    }))
    const qualityAccepted = qualityChecks.every((checks) =>
      Object.entries(checks).every(([key, value]) => key === 'sheet' || value === true)
    )
    const report =
      runs.length === 2
        ? {
            caseId,
            geometryEquivalent,
            qualityAccepted,
            qualityChecks,
            compact: runs[0],
            reference: runs[1]
          }
        : { caseId, geometryEquivalent, qualityAccepted, qualityChecks, runs }
    caseReports.push(report)
    console.log(JSON.stringify(report))
  }
  const reportPath = `${argumentsData.outputDirectory}/report.json`
  const report = {
    generatedAt: new Date().toISOString(),
    sheets: argumentsData.sheets,
    comparison: {
      gridSizeMm: 0.001,
      ignores: ['piece order', 'polygon winding', 'ring origin', 'translation', 'quarter-turn'],
      preserves: ['collision geometry', 'relative placement', 'reflection']
    },
    cases: caseReports
  }
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  const passed = caseReports.every(
    ({ geometryEquivalent, qualityAccepted }) => geometryEquivalent !== false && qualityAccepted
  )
  // deliberately a separate file: `docs/artifacts/current-compact-baselines/`
  // manifests and SHA256SUMS verify against the bytes of `report.json`.
  const telemetry = nfpIfpTelemetrySnapshot()
  if (telemetry !== undefined) {
    const telemetryPath = `${argumentsData.outputDirectory}/cache-telemetry.json`
    await writeFile(telemetryPath, `${JSON.stringify(telemetry, null, 2)}\n`)
    console.log(JSON.stringify({ telemetryPath }))
  }
  console.log(JSON.stringify({ reportPath, passed }))
  if (argumentsData.strict && !passed) {
    process.exitCode = 1
  }
}

const argumentsData = parseArguments(process.argv.slice(2))
if (argumentsData.captureCacheTelemetry) enableNfpIfpTelemetry()
await mkdir(argumentsData.outputDirectory, { recursive: true })
if (argumentsData.inventoryOnly) {
  console.log(JSON.stringify({ inventoryPath: await writeInventory(argumentsData) }))
} else {
  await runCorpus(argumentsData)
}
