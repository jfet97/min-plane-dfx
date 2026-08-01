#!/usr/bin/env node
/**
 * Additive, timing-only companion to `scripts/irregular-compact-baseline.ts`
 * for the preregistered performance contract's C2/C3/C4 per-fixture Rust
 * samples (docs/planning/rust-irregular-backend/performance-contract.md).
 *
 * `run-differential.ts` (the promoted differential harness) deliberately
 * never reports wall-clock elapsed for either backend -- see its own module
 * doc, "What is *not* compared" -- so it cannot supply the per-backend
 * timing samples the contract's C2-C4 batches need. This script exists only
 * to fill that gap without modifying any existing script: it builds the
 * exact same `NestingRequest` `scripts/irregular-compact-baseline.ts` builds
 * for `triangle-20`/`shapes-17`/`mixed-61` at an arbitrary `--sheet`
 * (identical fixture sources, identical `preparePieces` call, identical
 * settings construction -- see that script's `triangleRequest`/
 * `shapes17Request`/`mixed61Request`/`compactSettings`, duplicated here
 * verbatim rather than imported because those helpers are module-private),
 * then calls `computeIrregularNestingNative` (the real N-API boundary,
 * same entry point `nativeIrregularBackend.ts`/`nesting.worker.ts` use in
 * production -- same as `verify-mixed61-hash.ts`) and times only that one
 * call, exactly mirroring `verify-mixed61-hash.ts`'s own `elapsedMs`
 * methodology (Effect.runPromise duration only, no process-startup or
 * tsx-compile overhead) so the two backends' `elapsedMs` numbers stay
 * apples-to-apples comparable.
 *
 * Usage:
 *   pnpm exec tsx --tsconfig tsconfig.node.json scripts/rust-parity/time-native-backend.ts \
 *     --fixture triangle-20|shapes-17|mixed-61 --profile compact|short-side --sheet WIDTHxHEIGHT
 */
import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Effect } from 'effect'

import { importDxfFile } from '../../src/main/services/DxfImportService.js'
import { ImportedPiece } from '../../src/shared/domain/dxf.js'
import { JobId, PieceId, SourceFileId } from '../../src/shared/domain/ids.js'
import { NestingOptions, NestingRequest, SheetSpec } from '../../src/shared/domain/nesting.js'
import {
  DEFAULT_IRREGULAR_GEOMETRY_SETTINGS,
  makeCompactQualityIrregularOptimizerSettings
} from '../../src/shared/irregular/defaults.js'
import { IrregularNestingSettings, IrregularOptimizerSettings } from '../../src/shared/irregular/domain.js'
import { makePresetShapeDocument } from '../../src/shared/presetShapes.js'
import { preparePieces } from '../../src/shared/preparePieces.js'
import { canonicalCollisionLayoutIdentity } from '../../src/workers/irregular/canonicalLayoutGeometry.js'
import { computeIrregularNestingNative } from '../../src/workers/irregular/native/nativeIrregularBackend.js'
import { loadNativeIrregularAddon } from '../../src/workers/irregular/native/loadNativeBackend.js'
import { canonicalizeIrregularLayout, type LayoutPoint } from '../lib/irregularLayoutCanonicalization.js'
import type { IrregularComputeResult } from '../../src/workers/algorithm/irregular/computeIrregularNesting.js'

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const MIXED61_FIXTURE_PATH = join(REPO_ROOT, 'tests/fixtures/irregularSheetInvariance/mixed61-request.json')
const SHAPES_17_FIXTURE = join(REPO_ROOT, 'tests/fixtures/irregularSeventeenShapes')

type FixtureName = 'triangle-20' | 'mixed-61' | 'shapes-17'
type LayoutProfile = 'compact' | 'short-side'

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

function profileArgument(value: string | undefined): LayoutProfile {
  if (value === undefined || value === 'compact') return 'compact'
  if (value === 'short-side') return value
  throw new Error('--profile must be compact or short-side')
}

function parseSheet(value: string): SheetSpec {
  const match = /^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/.exec(value)
  if (match === null) throw new Error('--sheet must be WIDTHxHEIGHT')
  const width = Number(match[1])
  const height = Number(match[2])
  return new SheetSpec({ width, height, label: `${width}x${height}` })
}

// Verbatim duplicate of `scripts/irregular-compact-baseline.ts`'s own
// `compactSettings`/`requestOptions`/`buildPreparedRequest`/`triangleRequest`/
// `shapes17Request` (module-private there, so not importable) -- see this
// file's top doc for why an exact duplicate, not a reimplementation, is used.
function compactSettings(profile: LayoutProfile): IrregularNestingSettings {
  const optimizer = makeCompactQualityIrregularOptimizerSettings({ localRepairBudget: 0 })
  return new IrregularNestingSettings({
    geometry: DEFAULT_IRREGULAR_GEOMETRY_SETTINGS,
    optimizer:
      profile === 'compact'
        ? optimizer
        : new IrregularOptimizerSettings({
            ...optimizer,
            intrinsicObjectiveProfileId: 'short-side'
          })
  })
}

function requestOptions(settings: IrregularNestingSettings): NestingOptions {
  return new NestingOptions({
    allowGlobalRotation: true,
    allowGlobalMirror: true,
    timeoutMs: 180000,
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
  readonly profile: LayoutProfile
  readonly sheet: SheetSpec
  readonly sources: ReadonlyArray<ImportedPiece>
  readonly interchangeabilityKey: (piece: ImportedPiece) => string
}): NestingRequest {
  const jobId = JobId.make(`time-native-${input.fixture}-${input.sheet.label}`)
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
  const settings = compactSettings(input.profile)
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

function triangleRequest(sheet: SheetSpec, profile: LayoutProfile): NestingRequest {
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
    profile,
    sheet,
    sources,
    interchangeabilityKey: () => 'triangle-70x60'
  })
}

async function shapes17Request(sheet: SheetSpec, profile: LayoutProfile): Promise<NestingRequest> {
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
    profile,
    sheet,
    sources,
    interchangeabilityKey: () => 'shapes-17'
  })
}

async function mixed61Request(
  sheet: SheetSpec,
  profile: LayoutProfile
): Promise<{ request: NestingRequest; settings: IrregularNestingSettings }> {
  const document: unknown = JSON.parse(await readFile(MIXED61_FIXTURE_PATH, 'utf8'))
  const { Schema } = await import('effect')
  const request = Schema.decodeUnknownSync(NestingRequest)(document)
  const settings = request.options.irregularSettings
  if (settings === undefined) throw new Error('mixed-61 fixture has no irregular settings')
  const profileSettings = new IrregularNestingSettings({
    ...settings,
    optimizer:
      profile === 'compact'
        ? settings.optimizer
        : new IrregularOptimizerSettings({
            ...settings.optimizer,
            intrinsicObjectiveProfileId: 'short-side'
          })
  })
  const rebuilt = new NestingRequest({
    ...request,
    jobId: JobId.make(`time-native-mixed-61-${sheet.label}`),
    sheet,
    options: new NestingOptions({
      ...request.options,
      timeoutMs: 180000,
      historyMode: 'off',
      irregularSettings: profileSettings
    })
  })
  return { request: rebuilt, settings: profileSettings }
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

async function main(): Promise<void> {
  const fixture = fixtureArgument(requiredArgument('--fixture'))
  const profile = profileArgument(argument('--profile'))
  const sheet = parseSheet(requiredArgument('--sheet'))

  let request: NestingRequest
  let settings: IrregularNestingSettings
  if (fixture === 'triangle-20') {
    request = triangleRequest(sheet, profile)
    settings = compactSettings(profile)
  } else if (fixture === 'shapes-17') {
    request = await shapes17Request(sheet, profile)
    settings = compactSettings(profile)
  } else {
    const built = await mixed61Request(sheet, profile)
    request = built.request
    settings = built.settings
  }

  console.log(
    `[time-native-backend] fixture=${fixture} sheet=${sheet.label} pieces=${request.pieces.length}`
  )
  const startedAt = Date.now()
  const result = await Effect.runPromise(computeIrregularNestingNative(request, settings))
  const elapsedMs = Date.now() - startedAt

  const nativeDiagnosticsJson = loadNativeIrregularAddon().getLastJobDiagnostics()
  const nativeDiagnostics: unknown = JSON.parse(nativeDiagnosticsJson)
  const identity = canonicalCollisionLayoutIdentity(result.placedCollisionGeometries)
  const collisionIdentitySha256 =
    identity === undefined ? undefined : createHash('sha256').update(identity).digest('hex')

  const polygons = absoluteCollisionPolygons(result)
  const fittedCanonicalSha256 = polygons.length === 0 ? undefined : canonicalizeIrregularLayout(polygons).sha256

  console.log(
    JSON.stringify(
      {
        fixture,
        profile,
        sheet: sheet.label,
        placedCount: result.placedCollisionGeometries.length,
        unplacedCount: result.unplacedPieceIds.length,
        collisionIdentitySha256,
        fittedCanonicalSha256,
        elapsedMs,
        nativeDiagnostics
      },
      null,
      2
    )
  )
}

main().catch((error: unknown) => {
  console.error('[time-native-backend] FAILED', error)
  process.exit(1)
})
