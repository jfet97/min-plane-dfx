import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { Effect, Layer, Schema } from 'effect'
import { JobId } from '../src/shared/domain/ids.js'
import { NestingOptions, NestingRequest, SheetSpec } from '../src/shared/domain/nesting.js'
import {
  IrregularPreparedPiece,
  IrregularPriorityOrderKey,
  type IrregularNestingSettings,
  type IrregularPlacedPiece
} from '../src/shared/irregular/domain.js'
import {
  measureCanonicalLayoutContacts,
  measureCanonicalLayoutTopology
} from '../src/workers/irregular/canonicalLayoutGeometry.js'
import { CollisionGeometryBuilder } from '../src/workers/irregular/collisionGeometryBuilder.js'
import { GeometryKernel, GeometrySettings } from '../src/workers/irregular/geometryKernel.js'
import { NfpIfpServiceLayer } from '../src/workers/irregular/nfpIfpService.js'
import { GeometryCacheInMemory, TransformGenerator } from '../src/workers/irregular/services.js'
import { TransformGeneratorLive } from '../src/workers/irregular/transformGenerator.js'
import { sortPiecesForNesting } from '../src/workers/algorithm/sortPiecesForNesting.js'
import { constructIntrinsicShortSideContactStrip } from '../src/workers/algorithm/irregular/intrinsicShortSideContactStrip.js'
import { canonicalizeIrregularLayout, type LayoutPoint } from './lib/irregularLayoutCanonicalization.js'

/*
 * Renders the exact contact-driven short-side strip for one fixture/sheet pair
 * without any admission or promotion gate, so a rejected strip can be reviewed
 * visually. It is an evidence tool, never a gate and never production.
 */

const MIXED_61_FIXTURE = fileURLToPath(
  new URL('../tests/fixtures/irregularSheetInvariance/mixed61-request.json', import.meta.url)
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

async function mixed61Request(sheet: SheetSpec): Promise<NestingRequest> {
  const document: unknown = JSON.parse(await readFile(MIXED_61_FIXTURE, 'utf8'))
  const request = Schema.decodeUnknownSync(NestingRequest)(document)
  const settings = request.options.irregularSettings
  if (settings === undefined) throw new Error('mixed-61 fixture has no irregular settings')
  return new NestingRequest({
    ...request,
    jobId: JobId.make(`short-side-strip-evidence-mixed-61-${sheet.label}`),
    sheet,
    options: new NestingOptions({
      ...request.options,
      timeoutMs: 0,
      historyMode: 'off',
      irregularSettings: settings
    })
  })
}

function preparePiecesForStrip(
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
      const source = sourcePieces.find(
        (candidate) => candidate.id === prepared.sourcePieceId || candidate.id === prepared.id
      )
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

function jsonSafe(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, entry: unknown) =>
      typeof entry === 'bigint' ? entry.toString() : entry
    )
  )
}

const sheet = sheetArgument(argument('--sheet') ?? '1000x2700')
const outputPrefix = requiredArgument('--output-prefix')

const request = await mixed61Request(sheet)
const settings = request.options.irregularSettings
if (settings === undefined) throw new Error('mixed-61 fixture has no irregular settings')

const startedAt = performance.now()
const stripSheet = new SheetSpec({
  width: Math.min(sheet.width, sheet.height),
  height: Math.max(sheet.width, sheet.height),
  label: `short-side-strip-evidence-${sheet.label}`
})
const outcome = await Effect.runPromise(
  preparePiecesForStrip(request, settings).pipe(
    Effect.flatMap((preparedPieces) =>
      constructIntrinsicShortSideContactStrip({
        stripSheet,
        preparedPieces,
        settings
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
if (placed === undefined) {
  throw new Error(`strip construction failed with status ${outcome.trace.status}`)
}
const polygons = absoluteCollisionPolygons(placed)
const topology = measureCanonicalLayoutTopology(placed)
const contacts = measureCanonicalLayoutContacts(placed)
const fittedCanonicalSha256 = canonicalizeIrregularLayout(polygons).sha256
const svgPath = `${outputPrefix}.svg`
await mkdir(dirname(outputPrefix), { recursive: true })
await writeFile(svgPath, renderSvg(sheet, polygons))
const report = jsonSafe({
  sheet: { width: sheet.width, height: sheet.height },
  probeElapsedMs: Math.max(0, performance.now() - startedAt),
  stripStatus: outcome.trace.status,
  placedCount: placed.length,
  topology,
  contacts,
  fittedCanonicalSha256,
  svgPath
})
await writeFile(`${outputPrefix}.json`, `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify({ sheet: sheet.label, status: outcome.trace.status, topology, svgPath }))
