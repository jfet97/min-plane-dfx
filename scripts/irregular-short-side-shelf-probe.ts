import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { Effect, Layer, Schema } from 'effect'
import { importDxfFile } from '../src/main/services/DxfImportService.js'
import { ImportedPiece } from '../src/shared/domain/dxf.js'
import { JobId, PieceId, SourceFileId, type PieceId as PieceIdType } from '../src/shared/domain/ids.js'
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
import { preparePieces as prepareRequestPieces } from '../src/shared/preparePieces.js'
import { observeIntrinsicShortSidePairFold } from '../src/workers/algorithm/irregular/intrinsicShortSidePairFoldObserver.js'
import { sortPiecesForNesting } from '../src/workers/algorithm/sortPiecesForNesting.js'
import {
  measureCanonicalLayoutContacts,
  measureCanonicalLayoutTopology
} from '../src/workers/irregular/canonicalLayoutGeometry.js'
import { CollisionGeometryBuilder } from '../src/workers/irregular/collisionGeometryBuilder.js'
import { toGridMm } from '../src/workers/irregular/clipper2OffsetPolicy.js'
import { GeometryKernel, GeometrySettings } from '../src/workers/irregular/geometryKernel.js'
import { NfpIfpServiceLayer } from '../src/workers/irregular/nfpIfpService.js'
import { GeometryCacheInMemory, TransformGenerator } from '../src/workers/irregular/services.js'
import { TransformGeneratorLive } from '../src/workers/irregular/transformGenerator.js'
import { canonicalizeIrregularLayout, type LayoutPoint } from './lib/irregularLayoutCanonicalization.js'

/**
 * Fast terminal short-side construction probe.
 *
 * It reproduces exactly the prepared-piece input the production coordinator
 * hands to the terminal short-side observer, then runs only that observer with
 * recorded production reference scalars. It never runs Compact, never touches
 * production authority, and is a measurement tool rather than a gate.
 */

type FixtureName = 'triangle-20' | 'mixed-61' | 'shapes-17'

interface ProductionReference {
  readonly shortAxisSpanMm: number
  readonly maximumSideMm: number
  readonly envelopeAreaMm2: number
}

/**
 * Reference scalars measured by the accepted nine-case matrix at `9027aa6`.
 * The probe requires them because the terminal observer admits a construction
 * relative to the settled production Compact result.
 */
const RECORDED_PRODUCTION_REFERENCES: Readonly<
  Record<FixtureName, Readonly<Record<string, ProductionReference>>>
> = {
  'triangle-20': {
    '2000x2700': {
      shortAxisSpanMm: 487.983,
      maximumSideMm: 487.983,
      envelopeAreaMm2: 74_428.143126
    }
  },
  'mixed-61': {
    '2000x2700': {
      shortAxisSpanMm: 629.387,
      maximumSideMm: 629.387,
      envelopeAreaMm2: 391_605.850174
    }
  },
  'shapes-17': {
    '2000x2700': {
      shortAxisSpanMm: 532.691,
      maximumSideMm: 532.691,
      envelopeAreaMm2: 281_233.148068
    }
  }
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
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be positive`)
  return parsed
}

function compactSettings(): IrregularNestingSettings {
  return new IrregularNestingSettings({
    geometry: DEFAULT_IRREGULAR_GEOMETRY_SETTINGS,
    optimizer: makeCompactQualityIrregularOptimizerSettings({ localRepairBudget: 0 })
  })
}

function buildPreparedRequest(input: {
  readonly fixture: FixtureName
  readonly sheet: SheetSpec
  readonly sources: ReadonlyArray<ImportedPiece>
  readonly interchangeabilityKey: (piece: ImportedPiece) => string
}): NestingRequest {
  const jobId = JobId.make(`short-side-probe-${input.fixture}-${input.sheet.label}`)
  const prepared = prepareRequestPieces(
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
    jobId: JobId.make(`short-side-probe-mixed-61-${sheet.label}`),
    sheet,
    options: new NestingOptions({
      ...request.options,
      timeoutMs: 0,
      historyMode: 'off',
      irregularSettings: settings
    })
  })
}

function loadRequest(fixture: FixtureName, sheet: SheetSpec): Promise<NestingRequest> {
  if (fixture === 'triangle-20') return Promise.resolve(triangleRequest(sheet))
  if (fixture === 'shapes-17') return shapes17Request(sheet)
  return mixed61Request(sheet)
}

function findSourcePiece(
  sourcePieceId: PieceIdType,
  preparedPieceId: PieceIdType,
  sourcePieces: ReadonlyArray<ImportedPiece>
): ImportedPiece | undefined {
  return sourcePieces.find(
    (source) => source.id === sourcePieceId || source.id === preparedPieceId
  )
}

function preparePiecesForObserver(
  request: NestingRequest,
  settings: IrregularNestingSettings
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
        geometrySettings: settings.geometry,
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

function absoluteCollisionPolygons(
  placed: ReadonlyArray<IrregularPlacedPiece>
): ReadonlyArray<ReadonlyArray<LayoutPoint>> {
  return placed.map(({ placement, collisionGeometry }) =>
    collisionGeometry.polygon.points.map(({ x, y }) => ({
      x: x + placement.transform.translateX,
      y: y + placement.transform.translateY
    }))
  )
}

function renderSvg(sheet: SheetSpec, polygons: ReadonlyArray<ReadonlyArray<LayoutPoint>>): string {
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
} {
  const points = polygons.flat()
  if (points.length === 0) return { width: 0, height: 0, area: 0 }
  const width = Math.max(...points.map(({ x }) => x)) - Math.min(...points.map(({ x }) => x))
  const height = Math.max(...points.map(({ y }) => y)) - Math.min(...points.map(({ y }) => y))
  return { width, height, area: width * height }
}

function jsonSafe(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, entry: unknown) =>
      typeof entry === 'bigint' ? entry.toString() : entry
    )
  )
}

const fixture = fixtureArgument(requiredArgument('--fixture'))
const sheet = sheetArgument(argument('--sheet') ?? '2000x2700')
const outputPrefix = requiredArgument('--output-prefix')
const recorded = RECORDED_PRODUCTION_REFERENCES[fixture][sheet.label]
const productionShortAxisSpanMm =
  optionalNumberArgument('--production-short-axis-span-mm') ?? recorded?.shortAxisSpanMm
const productionMaximumSideMm =
  optionalNumberArgument('--production-maximum-side-mm') ?? recorded?.maximumSideMm
const productionEnvelopeAreaMm2 =
  optionalNumberArgument('--production-envelope-area-mm2') ?? recorded?.envelopeAreaMm2
const productionShortAxisSpanGrid =
  productionShortAxisSpanMm === undefined
    ? undefined
    : toGridMm(productionShortAxisSpanMm)
const productionMaximumSideGrid =
  productionMaximumSideMm === undefined
    ? undefined
    : toGridMm(productionMaximumSideMm)
const productionEnvelopeAreaGrid2 =
  productionEnvelopeAreaMm2 === undefined
    ? undefined
    : Math.round(productionEnvelopeAreaMm2 * 1_000_000)
if (
  productionShortAxisSpanMm === undefined ||
  productionMaximumSideMm === undefined ||
  productionEnvelopeAreaMm2 === undefined ||
  productionShortAxisSpanGrid === undefined ||
  productionMaximumSideGrid === undefined ||
  productionEnvelopeAreaGrid2 === undefined ||
  !Number.isSafeInteger(productionEnvelopeAreaGrid2)
) {
  throw new Error(
    `no recorded production reference for ${fixture} ${sheet.label}; pass the three --production-* arguments`
  )
}

const request = await loadRequest(fixture, sheet)
const settings = request.options.irregularSettings
if (settings === undefined) throw new Error(`${fixture} has no irregular settings`)

const startedAt = performance.now()
const outcome = await Effect.runPromise(
  preparePiecesForObserver(request, settings).pipe(
    Effect.flatMap((preparedPieces) =>
      observeIntrinsicShortSidePairFold({
        sheet,
        preparedPieces,
        settings,
        productionShortAxisSpanMm,
        productionMaximumSideMm,
        productionEnvelopeAreaMm2,
        productionShortAxisSpanGrid,
        productionMaximumSideGrid,
        productionEnvelopeAreaGrid2:
          productionEnvelopeAreaGrid2.toString()
      })
    ),
    Effect.provide(CollisionGeometryBuilder.Layer),
    Effect.provide(TransformGeneratorLive),
    Effect.provide(GeometryKernel.LayerWithCache),
    Effect.provide(NfpIfpServiceLayer),
    Effect.provide(Layer.succeed(GeometrySettings, settings)),
    Effect.provide(GeometryCacheInMemory)
  )
)

const placed = outcome.placedCollisionGeometries
const polygons = placed === undefined ? undefined : absoluteCollisionPolygons(placed)
const bounds = polygons === undefined ? undefined : layoutBounds(polygons)
const topology = placed === undefined ? undefined : measureCanonicalLayoutTopology(placed)
const contacts = placed === undefined ? undefined : measureCanonicalLayoutContacts(placed)
const fittedCanonicalSha256 =
  polygons === undefined || polygons.length === 0
    ? undefined
    : canonicalizeIrregularLayout(polygons).sha256
const svgPath = `${outputPrefix}.svg`
await mkdir(dirname(outputPrefix), { recursive: true })
if (polygons !== undefined) await writeFile(svgPath, renderSvg(sheet, polygons))
const report = jsonSafe({
  fixture,
  sheet: { width: sheet.width, height: sheet.height },
  productionReference: {
    shortAxisSpanMm: productionShortAxisSpanMm,
    maximumSideMm: productionMaximumSideMm,
    envelopeAreaMm2: productionEnvelopeAreaMm2
  },
  probeElapsedMs: Math.max(0, performance.now() - startedAt),
  trace: outcome.trace,
  placedCount: placed?.length ?? 0,
  bounds,
  topology,
  contacts,
  fittedCanonicalSha256,
  svgPath: polygons === undefined ? undefined : svgPath
})
await writeFile(`${outputPrefix}.json`, `${JSON.stringify(report, null, 2)}\n`)
console.log(
  JSON.stringify({
    fixture,
    sheet: sheet.label,
    status: outcome.trace.status,
    constructionKind: outcome.trace.constructionKind,
    usedShortAxisSpanMm: outcome.trace.usedShortAxisSpanMm,
    usedLongAxisDepthMm: outcome.trace.usedLongAxisDepthMm,
    density: outcome.trace.admission?.collisionEnvelopeDensity,
    fillRatio: outcome.trace.admission?.fillRatio,
    cavities: topology?.enclosedCavityCount,
    hullGap: topology?.largestOccupiedHullGapRatio,
    isolatedPieces: topology?.isolatedPieceCount,
    contactComponents: topology?.positiveContactComponentCount,
    observerRuntimeMs: outcome.trace.runtimeMs,
    sha256: createHash('sha256')
      .update(outcome.trace.canonicalGeometryHash ?? 'none')
      .digest('hex')
      .slice(0, 12)
  })
)
