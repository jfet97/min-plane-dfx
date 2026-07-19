import { createHash } from 'node:crypto'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Effect, Layer, Schema } from 'effect'
import { JobId } from '../src/shared/domain/ids.js'
import { NestingOptions, NestingRequest, SheetSpec } from '../src/shared/domain/nesting.js'
import { IrregularNestingSettings } from '../src/shared/irregular/domain.js'
import { computeIrregularNesting } from '../src/workers/algorithm/irregular/computeIrregularNesting.js'
import { IrregularLayoutScorer } from '../src/workers/algorithm/irregular/irregularLayoutScorer.js'
import { relaxOverlappingLayout } from '../src/workers/algorithm/irregular/overlapRelaxation.js'
import { IrregularPlacementScorer } from '../src/workers/algorithm/irregular/irregularPlacementScorer.js'
import { CollisionGeometryBuilder } from '../src/workers/irregular/collisionGeometryBuilder.js'
import { FreeMaterialServiceLive } from '../src/workers/irregular/freeMaterialService.js'
import { GeometrySettings } from '../src/workers/irregular/geometryKernel.js'
import { NfpIfpServiceLive } from '../src/workers/irregular/nfpIfpService.js'
import { TransformGeneratorLive } from '../src/workers/irregular/transformGenerator.js'

const FIXTURE = fileURLToPath(
  new URL('../tests/fixtures/irregularSheetInvariance/mixed61-request.json', import.meta.url)
)
const DEFAULT_OUTPUT =
  '/private/tmp/min-plane-provenance/intrinsic-overlap-relaxation-v0'

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}

const outputDirectory = argument('--output') ?? DEFAULT_OUTPUT
const sourceCommit = argument('--source-commit')
const manifestOnly = process.argv.includes('--manifest-only')

if (manifestOnly) {
  if (sourceCommit === undefined) throw new Error('--source-commit is required')
  const files = ['report.json', 'incumbent.svg', 'selected.svg', 'selected.png']
  const hashes = Object.fromEntries(
    await Promise.all(
      files.map(async (name) => [
        name,
        createHash('sha256').update(await readFile(`${outputDirectory}/${name}`)).digest('hex')
      ])
    )
  )
  await writeFile(
    `${outputDirectory}/manifest.json`,
    `${JSON.stringify(
      {
        sourceCommit,
        nodeVersion: process.version,
        fixture: FIXTURE,
        sheet: { width: 2000, height: 2700 },
        optimizer: {
          fixedRotations: true,
          squeezeRatios: [0.005, 0.01, 0.02],
          maximumEvaluations: 25_000,
          completedAttemptBudget: 768
        },
        files: hashes
      },
      null,
      2
    )}\n`
  )
  console.log(JSON.stringify({ manifestPath: `${outputDirectory}/manifest.json`, hashes }))
  process.exit(0)
}

await mkdir(outputDirectory, { recursive: true })
const decoded: unknown = JSON.parse(await readFile(FIXTURE, 'utf8'))
const fixture = Schema.decodeUnknownSync(NestingRequest)(decoded)
const settings = fixture.options.irregularSettings
if (settings === undefined) throw new Error('mixed-61 fixture has no irregular settings')
const sheet = new SheetSpec({ width: 2000, height: 2700, label: 'probe-2000x2700' })
const request = new NestingRequest({
  ...fixture,
  jobId: JobId.make(`${fixture.jobId}-overlap-relaxation-v0`),
  sheet,
  options: new NestingOptions({
    ...fixture.options,
    timeoutMs: 0,
    historyMode: 'off',
    irregularSettings: new IrregularNestingSettings({
      geometry: settings.geometry,
      optimizer: settings.optimizer
    })
  })
})
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
const relaxation = await Effect.runPromise(
  relaxOverlappingLayout(sheet, result.placedCollisionGeometries)
)
await writeFile(`${outputDirectory}/incumbent.svg`, renderSvg(result.placedCollisionGeometries))
await writeFile(
  `${outputDirectory}/selected.svg`,
  renderSvg(relaxation.placedCollisionGeometries)
)
const report = {
  sourceCommit: sourceCommit ?? 'unknown',
  placedCount: result.placedCollisionGeometries.length,
  unplacedCount: result.unplacedPieceIds.length,
  accepted: relaxation.accepted,
  evaluations: relaxation.evaluations,
  completedAttempts: relaxation.completedAttempts,
  exactCandidatesChecked: relaxation.exactCandidatesChecked,
  squeezeRatiosCompleted: relaxation.squeezeRatiosCompleted,
  incumbentMetrics: relaxation.incumbentMetrics,
  selectedMetrics: relaxation.selectedMetrics,
  decision: relaxation.accepted ? 'promote' : 'reject'
}
await writeFile(`${outputDirectory}/report.json`, `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify(report))

function renderSvg(
  placed: ReadonlyArray<{
    readonly placement: { readonly transform: { readonly translateX: number; readonly translateY: number } }
    readonly collisionGeometry: {
      readonly polygon: { readonly points: ReadonlyArray<{ readonly x: number; readonly y: number }> }
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
  const minX = Math.min(...points.map(({ x }) => x))
  const maxX = Math.max(...points.map(({ x }) => x))
  const minY = Math.min(...points.map(({ y }) => y))
  const maxY = Math.max(...points.map(({ y }) => y))
  const margin = 20
  const paths = polygons
    .map(
      (polygon) =>
        `<polygon points="${polygon.map(({ x, y }) => `${x},${-y}`).join(' ')}"/>`
    )
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX - margin} ${-maxY - margin} ${maxX - minX + margin * 2} ${maxY - minY + margin * 2}" width="1200" height="1200"><rect x="${minX - margin}" y="${-maxY - margin}" width="${maxX - minX + margin * 2}" height="${maxY - minY + margin * 2}" fill="#1b2328"/><g fill="#22313b" stroke="#39a9ff" stroke-width="1">${paths}</g></svg>`
}
