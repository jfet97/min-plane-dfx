import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { Effect, Layer, Schema } from 'effect'
import { JobId } from '../src/shared/domain/ids.js'
import { NestingOptions, NestingRequest, SheetSpec } from '../src/shared/domain/nesting.js'
import type { IrregularNestingSettings } from '../src/shared/irregular/domain.js'
import { computeIrregularNesting } from '../src/workers/algorithm/irregular/computeIrregularNesting.js'
import type { IrregularDecisionTraceEvent } from '../src/workers/algorithm/irregular/decisionTrace.js'
import { IrregularLayoutScorer } from '../src/workers/algorithm/irregular/irregularLayoutScorer.js'
import { IrregularPlacementScorer } from '../src/workers/algorithm/irregular/irregularPlacementScorer.js'
import { CollisionGeometryBuilder } from '../src/workers/irregular/collisionGeometryBuilder.js'
import { FreeMaterialServiceLive } from '../src/workers/irregular/freeMaterialService.js'
import { GeometrySettings } from '../src/workers/irregular/geometryKernel.js'
import { NfpIfpServiceLive } from '../src/workers/irregular/nfpIfpService.js'
import { TransformGeneratorLive } from '../src/workers/irregular/transformGenerator.js'
import {
  canonicalizeIrregularLayout,
  type LayoutPoint
} from './lib/irregularLayoutCanonicalization.js'

/*
 * Bounded decision-trace dump for the persisted mixed-61 request.
 *
 * The sheet-invariance corpus forces historyMode off, so it cannot emit
 * decision traces. This harness reruns the identical decode with historyMode
 * final and a collecting emitDecisionTrace callback, writing one NDJSON trace
 * per sheet plus a summary with the canonical geometry hash and winner score.
 * Search behavior is unchanged: tracing is observation only.
 */

interface TraceDumpArguments {
  readonly outputDirectory: string
  readonly sheets: ReadonlyArray<SheetSpec>
}

const MIXED_61_FIXTURE = fileURLToPath(
  new URL('../tests/fixtures/irregularSheetInvariance/mixed61-request.json', import.meta.url)
)

function parseSheets(value: string): ReadonlyArray<SheetSpec> {
  const dimensions = value.split(',').map((entry) => {
    const match = /^(\d+)x(\d+)$/.exec(entry.trim())
    if (match === null) throw new Error(`invalid sheet dimensions: ${entry}`)
    return { width: Number(match[1]), height: Number(match[2]) }
  })
  if (dimensions.length < 1) throw new Error('--sheets requires at least one sheet')
  return dimensions.map(
    ({ width, height }) => new SheetSpec({ width, height, label: `${width}x${height}` })
  )
}

function parseArguments(args: ReadonlyArray<string>): TraceDumpArguments {
  let outputDirectory = '/private/tmp/irregular-sheet-trace-dump'
  let sheets: ReadonlyArray<SheetSpec> | undefined
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    const value = args[index + 1]
    if (argument === '--output') {
      if (value === undefined) throw new Error('--output requires a directory')
      outputDirectory = value
      index += 1
      continue
    }
    if (argument === '--sheets') {
      if (value === undefined) throw new Error('--sheets requires comma-separated WIDTHxHEIGHT values')
      sheets = parseSheets(value)
      index += 1
      continue
    }
    if (argument === '--help') {
      console.log(
        'Usage: tsx scripts/irregular-sheet-trace-dump.ts --sheets WIDTHxHEIGHT,... [--output <dir>]'
      )
      process.exit(0)
    }
    throw new Error(`unknown argument: ${argument}`)
  }
  if (sheets === undefined) {
    sheets = parseSheets('1000x1300,1000x1700,2000x1700,2000x2700')
  }
  return { outputDirectory, sheets }
}

async function loadMixed61Request(): Promise<NestingRequest> {
  const document: unknown = JSON.parse(await readFile(MIXED_61_FIXTURE, 'utf8'))
  return Schema.decodeUnknownSync(NestingRequest)(document)
}

function withTracedSheet(request: NestingRequest, sheet: SheetSpec, suffix: string): NestingRequest {
  const settings: IrregularNestingSettings | undefined = request.options.irregularSettings
  if (settings === undefined) throw new Error(`${request.jobId} has no irregular settings`)
  return new NestingRequest({
    ...request,
    jobId: JobId.make(`${request.jobId}-${suffix}`),
    sheet,
    options: new NestingOptions({
      ...request.options,
      timeoutMs: 0,
      historyMode: 'final',
      irregularSettings: settings
    })
  })
}

function absoluteCollisionPolygons(
  placed: ReadonlyArray<{
    readonly placement: { readonly transform: { readonly translateX: number; translateY: number } }
    readonly collisionGeometry: {
      readonly polygon: { readonly points: ReadonlyArray<LayoutPoint> }
    }
  }>
): ReadonlyArray<ReadonlyArray<LayoutPoint>> {
  return placed.map(({ placement, collisionGeometry }) =>
    collisionGeometry.polygon.points.map(({ x, y }) => ({
      x: x + placement.transform.translateX,
      y: y + placement.transform.translateY
    }))
  )
}

async function runTracedSheet(request: NestingRequest, tracePath: string) {
  const settings = request.options.irregularSettings
  if (settings === undefined) throw new Error(`${request.jobId} has no irregular settings`)
  const events: Array<IrregularDecisionTraceEvent> = []
  const startedAt = performance.now()
  const result = await Effect.runPromise(
    computeIrregularNesting(request, {
      emitDecisionTrace: (event) => {
        events.push(event)
      }
    }).pipe(
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
  const serialized = events.map((event) => JSON.stringify(event)).join('\n') + '\n'
  await writeFile(tracePath, serialized)
  const polygons = absoluteCollisionPolygons(result.placedCollisionGeometries)
  const canonical = canonicalizeIrregularLayout(polygons)
  return {
    sheet: { width: request.sheet.width, height: request.sheet.height },
    elapsedMs,
    traceEventCount: events.length,
    traceBytes: Buffer.byteLength(serialized),
    placedCount: result.placedCollisionGeometries.length,
    unplacedCount: result.unplacedPieceIds.length,
    canonicalSha256: canonical.sha256,
    canonicalRotationDeg: canonical.rotationDeg,
    score: {
      collisionBoundsAreaMm2: result.score.collisionBoundsAreaMm2,
      collisionBoundsSpanMm: result.score.collisionBoundsSpanMm,
      occupiedHullWasteRatio: result.score.occupiedHullWasteRatio,
      nearCompleteStructuralContactCount: result.score.nearCompleteStructuralContactCount,
      dominantNearCompleteStructuralContactCount:
        result.score.dominantNearCompleteStructuralContactCount,
      sharedCollisionBoundaryContactUnits: result.score.sharedCollisionBoundaryContactUnits,
      freeMaterialHoleCount: result.score.freeMaterialHoleCount
    },
    tracePath
  }
}

const argumentsData = parseArguments(process.argv.slice(2))
await mkdir(argumentsData.outputDirectory, { recursive: true })
const sourceRequest = await loadMixed61Request()
const summaries = []
for (const currentSheet of argumentsData.sheets) {
  const sheetId = `${currentSheet.width}x${currentSheet.height}`
  const summary = await runTracedSheet(
    withTracedSheet(sourceRequest, currentSheet, sheetId),
    `${argumentsData.outputDirectory}/mixed-61-${sheetId}.decision-trace.ndjson`
  )
  summaries.push(summary)
  console.log(JSON.stringify(summary))
}
await writeFile(
  `${argumentsData.outputDirectory}/trace-summary.json`,
  JSON.stringify({ runs: summaries }, null, 2)
)
