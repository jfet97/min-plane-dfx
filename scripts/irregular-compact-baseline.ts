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
import { IrregularNestingSettings } from '../src/shared/irregular/domain.js'
import { makePresetShapeDocument } from '../src/shared/presetShapes.js'
import { preparePieces } from '../src/shared/preparePieces.js'
import {
  computeIrregularNesting,
  type IrregularComputeResult
} from '../src/workers/algorithm/irregular/computeIrregularNesting.js'
import { IrregularLayoutScorer } from '../src/workers/algorithm/irregular/irregularLayoutScorer.js'
import { IrregularPlacementScorer } from '../src/workers/algorithm/irregular/irregularPlacementScorer.js'
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
    maximumElapsedMs: optionalNumberArgument('--maximum-elapsed-ms')
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
  result: IrregularComputeResult
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

function sha256CanonicalLayout(result: IrregularComputeResult): string | undefined {
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
const startedAt = performance.now()
const result = await Effect.runPromise(
  computeIrregularNesting(request, { captureCapacityPhaseTimings: true }).pipe(
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
const svgPath = `${args.outputPrefix}.svg`
const reportPath = `${args.outputPrefix}.json`
await mkdir(dirname(args.outputPrefix), { recursive: true })
await writeFile(svgPath, renderSvg(args.sheet, polygons))

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
  area: args.maximumAreaMm2 === undefined || bounds.area <= args.maximumAreaMm2,
  canonicalCavities:
    args.maximumCanonicalCavities === undefined ||
    (canonicalTopology?.enclosedCavityCount ?? Number.POSITIVE_INFINITY) <=
      args.maximumCanonicalCavities,
  runtime: args.maximumElapsedMs === undefined || elapsedMs <= args.maximumElapsedMs
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
    capacityTrace: result.capacityTrace
  },
  checks,
  passed,
  svgPath
})
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify({ reportPath, svgPath, elapsedMs, checks, passed }))
if (args.strict && !passed) process.exitCode = 1
