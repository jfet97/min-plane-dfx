import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Effect, Layer, Schema } from 'effect'
import type { ImportedPiece } from '../src/shared/domain/dxf.js'
import type { PieceId } from '../src/shared/domain/ids.js'
import { NestingRequest, SheetSpec } from '../src/shared/domain/nesting.js'
import {
  IrregularPreparedPiece,
  IrregularPriorityOrderKey,
  type IrregularNestingSettings
} from '../src/shared/irregular/domain.js'
import { runIntrinsicPeriodicSmallFillE3 } from '../src/workers/algorithm/irregular/intrinsicPeriodicSmallFillE3.js'
import { finalizeIntrinsicStrictState } from '../src/workers/algorithm/irregular/intrinsicStrictDecoder.js'
import { sortPiecesForNesting } from '../src/workers/algorithm/sortPiecesForNesting.js'
import { CollisionGeometryBuilder } from '../src/workers/irregular/collisionGeometryBuilder.js'
import { GeometryKernel, GeometrySettings } from '../src/workers/irregular/geometryKernel.js'
import { NfpIfpServiceLive } from '../src/workers/irregular/nfpIfpService.js'
import { TransformGenerator } from '../src/workers/irregular/services.js'
import { TransformGeneratorLive } from '../src/workers/irregular/transformGenerator.js'

const FIXTURE = fileURLToPath(
  new URL('../tests/fixtures/irregularSheetInvariance/mixed61-request.json', import.meta.url)
)
const PREREGISTRATION =
  '/private/tmp/min-plane-provenance/intrinsic-periodic-small-fill-e3/preregistration.md'
const FOUR_SHEETS = [
  new SheetSpec({ width: 1000, height: 1300, label: '1000x1300' }),
  new SheetSpec({ width: 1000, height: 1700, label: '1000x1700' }),
  new SheetSpec({ width: 2000, height: 1700, label: '2000x1700' }),
  new SheetSpec({ width: 2000, height: 2700, label: '2000x2700' })
] as const
const ARCHIVE_SHEET = FOUR_SHEETS[3]
const E1_HULL_GAP_RATIO = 0.22414927709210425
const E1_TOTAL_CONTACTS = 21
const E1_DOMINANT_CONTACTS = 4
const E1_CERTIFICATE_DEFICIT = 2.2074432680457226

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}

const outputDirectory =
  argument('--output') ?? '/private/tmp/min-plane-provenance/intrinsic-periodic-small-fill-e3/run'
const sourceCommit = argument('--source-commit') ?? 'unknown'
const strict = process.argv.includes('--strict')
await mkdir(outputDirectory, { recursive: true })
const fixtureBytes = await readFile(FIXTURE)
const preregistrationBytes = await readFile(PREREGISTRATION)
const request = Schema.decodeUnknownSync(NestingRequest)(JSON.parse(fixtureBytes.toString('utf8')))
const settings = request.options.irregularSettings
if (settings === undefined) throw new Error('mixed-61 fixture has no irregular settings')

const { preparedPieces, experiment } = await Effect.runPromise(
  withLayers(
    Effect.gen(function* () {
      const preparedPieces = yield* preparePieces(request, settings)
      const experiment = yield* runIntrinsicPeriodicSmallFillE3(ARCHIVE_SHEET, preparedPieces)
      return { preparedPieces, experiment }
    }),
    settings
  )
)

const artifactPaths: string[] = []
const roles = []
for (const role of experiment.roles) {
  const sheetRuns = []
  if (role.constructed !== undefined) {
    for (const sheet of FOUR_SHEETS) {
      const result = await Effect.runPromise(finalizeIntrinsicStrictState(sheet, role.constructed))
      const svgPath = `${outputDirectory}/mixed-61-${role.role}-${sheet.width}x${sheet.height}.svg`
      await writeFile(svgPath, renderSvg(result.placedCollisionGeometries))
      artifactPaths.push(svgPath)
      sheetRuns.push({
        sheet: { width: sheet.width, height: sheet.height },
        status: result.status,
        canonicalGeometryHash: result.canonicalGeometryHash,
        terminalRotationDeg: result.terminalRotationDeg,
        metrics: result.metrics,
        certificate: result.certificate,
        svgPath
      })
    }
  }
  roles.push({
    role: role.role,
    status: role.status,
    reason: role.reason,
    seedPlacementCount: role.seedPlacementCount,
    nonInertFillCount: role.nonInertFillCount,
    runtimeMs: role.runtimeMs,
    gapFillEvidence: role.constructed?.gapFillEvidence ?? [],
    sheetRuns
  })
}

const nonControl = experiment.roles.filter(({ role }) => role !== 'E1')
const earlySignalRoles = nonControl.filter(passesEarlySignal).map(({ role }) => role)
const bridgeRoles = nonControl.filter(passesBridge).map(({ role }) => role)
const globalBudgetPasses = experiment.runtimeMs <= 120_000
const reportPath = `${outputDirectory}/report.json`
const report = {
  experiment: 'intrinsic-periodic-small-fill-e3',
  sourceCommit,
  fixture: FIXTURE,
  fixtureSha256: sha256(fixtureBytes),
  preregistration: PREREGISTRATION,
  preregistrationSha256: sha256(preregistrationBytes),
  runtime: { node: process.version, v8: process.versions.v8 },
  limits: {
    cellEnumerationMs: 5_000,
    p1ContinuationMs: 25_000,
    p2ContinuationMs: 25_000,
    l1LargePhaseMs: 20_000,
    l1SmallFillMs: 25_000,
    globalHardMs: 120_000
  },
  preparedPieceCount: preparedPieces.length,
  catalog: {
    selectedFamilyKeySha256:
      experiment.catalog.selectedFamilyKey === undefined
        ? undefined
        : sha256(experiment.catalog.selectedFamilyKey),
    uniqueTransformCount: experiment.catalog.uniqueTransformCount,
    enumeratedPairCount: experiment.catalog.enumeratedPairCount,
    certifiedCellCount: experiment.catalog.cells.length,
    cells: experiment.catalog.cells.map((cell) => ({
      role: cell.role,
      memberCount: cell.members.length,
      v1: cell.v1,
      v2: cell.v2,
      determinantGrid2: cell.determinantGrid2,
      memberDoubledAreaGrid2: cell.memberDoubledAreaGrid2,
      density: cell.density,
      sharedBoundaryLengthMm: cell.sharedBoundaryLengthMm,
      canonicalKeySha256: sha256(cell.canonicalKey)
    })),
    rejected: experiment.catalog.rejected
  },
  gates: {
    globalBudget: { passes: globalBudgetPasses, runtimeMs: experiment.runtimeMs },
    earlySignal: { passes: earlySignalRoles.length > 0, roles: earlySignalRoles },
    bridge: { passes: bridgeRoles.length > 0, roles: bridgeRoles }
  },
  decision:
    !globalBudgetPasses || earlySignalRoles.length === 0
      ? 'reject_bounded_constructor_portfolio'
      : bridgeRoles.length === 0
        ? 'preserve_early_signal_stop_before_triangle_and_corpus'
        : 'run_triangle_and_corpus',
  roles
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
      fixture: { path: FIXTURE, sha256: report.fixtureSha256 },
      preregistration: { path: PREREGISTRATION, sha256: report.preregistrationSha256 },
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
    gates: report.gates,
    decision: report.decision
  })
)
if (strict && report.decision !== 'run_triangle_and_corpus') process.exitCode = 2

function passesEarlySignal(role: (typeof experiment.roles)[number]): boolean {
  const metrics = role.result?.metrics
  const certificate = role.result?.certificate
  if (metrics === undefined || certificate === undefined) return false
  const roleSpecific =
    role.role === 'L1'
      ? role.nonInertFillCount > 0
      : role.role === 'P1' || role.role === 'P2'
        ? role.seedPlacementCount > 0
        : false
  const contactSignal =
    (metrics.totalStructuralContacts > E1_TOTAL_CONTACTS &&
      metrics.dominantStructuralContacts > E1_DOMINANT_CONTACTS) ||
    (certificate.relativeDeficitSum < E1_CERTIFICATE_DEFICIT &&
      metrics.totalStructuralContacts >= E1_TOTAL_CONTACTS &&
      metrics.dominantStructuralContacts >= E1_DOMINANT_CONTACTS)
  return (
    roleSpecific &&
    metrics.envelopeAreaMm2 <= 439_904.169466 &&
    metrics.largestOccupiedHullGapRatio < E1_HULL_GAP_RATIO &&
    metrics.isolatedPieceCount < 26 &&
    metrics.largestPositiveContactComponentSize > 14 &&
    contactSignal
  )
}

function passesBridge(role: (typeof experiment.roles)[number]): boolean {
  const metrics = role.result?.metrics
  return (
    metrics !== undefined &&
    metrics.envelopeAreaMm2 <= 450_000 &&
    metrics.largestOccupiedHullGapRatio <= 0.15 &&
    metrics.positiveContactComponentCount <= 8 &&
    metrics.isolatedPieceCount <= 4 &&
    metrics.largestPositiveContactComponentSize >= 45 &&
    metrics.enclosedCavityCount <= 2
  )
}

function withLayers<A, E, R>(effect: Effect.Effect<A, E, R>, settings: IrregularNestingSettings) {
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
  if (points.length === 0)
    return '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1200"/>'
  const minX = Math.min(...points.map(({ x }) => x))
  const minY = Math.min(...points.map(({ y }) => y))
  const maxX = Math.max(...points.map(({ x }) => x))
  const maxY = Math.max(...points.map(({ y }) => y))
  const margin = 20
  const paths = polygons
    .map((polygon) => `<polygon points="${polygon.map(({ x, y }) => `${x},${-y}`).join(' ')}"/>`)
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX - margin} ${-maxY - margin} ${maxX - minX + margin * 2} ${maxY - minY + margin * 2}" width="1200" height="1200"><rect x="${minX - margin}" y="${-maxY - margin}" width="${maxX - minX + margin * 2}" height="${maxY - minY + margin * 2}" fill="#1b2328"/><g fill="#22313b" stroke="#39a9ff" stroke-width="1">${paths}</g></svg>`
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}
