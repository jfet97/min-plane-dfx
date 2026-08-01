#!/usr/bin/env node
/**
 * Differential harness (docs/planning/rust-irregular-backend/backend-selection-rollback.md
 * §5): runs one real `NestingRequest` through **both** the TypeScript
 * (`computeIrregularNesting`) and native (`computeIrregularNestingNative`)
 * irregular-nesting backends, sequentially with TypeScript first, and diffs
 * the documented semantic projection (placements, score, portfolio,
 * diagnostics, sorted-piece order, and the complete state-snapshot sequence,
 * including remaining prepared pieces). Prints the exact first field where
 * the two backends disagree. With `--diagnostic`, semantic differences are
 * reported and accepted after both backends complete successfully. Native
 * availability failures and typed backend failures remain blocking; omitting
 * the flag preserves strict exact comparison.
 *
 * This is a development/CI diagnostic instrument, never a production code
 * path: it drives `computeIrregularNesting`/`computeIrregularNestingNative`
 * directly, exactly the way `nesting.worker.ts`'s `computeIrregularWorkerResult`
 * does for each backend (same Effect layer-provide chain as that function
 * and as `scripts/rust-parity/dump-coordinator.ts`), bypassing the worker
 * thread and the `MIN_PLANE_IRREGULAR_BACKEND` env var entirely -- there is
 * no ambiguity here about which backend "actually ran": both always run,
 * or the script fails loudly before either does.
 *
 * # What is *not* compared, and why (never a silent omission)
 *
 * The shared production comparator projects the complete success or typed
 * failure outcome. BigInt values remain exact decimal strings. Documented
 * wall-clock fields, timing-derived `serializedTraceBytes`, and
 * `peakRssDeltaBytes` are normalized to presence markers, so both backends must
 * agree that each measurement exists while independent timing and process-memory
 * values do not create semantic mismatches. Every
 * other result field is compared exactly, including ordered placements and
 * transforms, scores, archive and candidate contents, complete snapshots,
 * traces, ledgers, checkpoints, hashes, and typed failure context.
 *
 * Usage:
 *   pnpm exec tsx --tsconfig tsconfig.node.json scripts/rust-parity/run-differential.ts \
 *     [--fixture mixed61] [--pieces 4|all] [--request-file <path-to-NestingRequest.json>] [--diagnostic]
 *
 * `--pieces` (default `4`) truncates a named fixture's `pieces`/`sourcePieces`
 * to a fast, iterable subset; `--request-file` always runs the file's full,
 * untruncated request. Equal typed failures remain a valid exact parity
 * outcome. Semantic divergence between successful outcomes is blocking unless
 * `--diagnostic` is passed; native addon unavailability, unequal typed
 * failures, and operational failures are always blocking.
 */
import { Effect, Layer, Schema } from 'effect'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { importDxfFile } from '../../src/main/services/DxfImportService.js'
import { ImportedPiece } from '@shared/domain/dxf.js'
import { JobId, PieceId, SourceFileId } from '@shared/domain/ids.js'
import { NestingOptions, NestingRequest, SheetSpec } from '@shared/domain/nesting.js'
import {
  DEFAULT_IRREGULAR_GEOMETRY_SETTINGS,
  makeCompactQualityIrregularOptimizerSettings
} from '@shared/irregular/defaults.js'
import { IrregularNestingSettings, IrregularOptimizerSettings } from '@shared/irregular/domain.js'
import { intrinsicSharedArchiveEligibility } from '@shared/irregular/executionMode.js'
import { makePresetShapeDocument } from '@shared/presetShapes.js'
import { preparePieces } from '@shared/preparePieces.js'

import {
  computeIrregularNesting,
  type ComputeIrregularNestingOptions,
  type IrregularComputeResult
} from '../../src/workers/algorithm/irregular/computeIrregularNesting.js'
import { CollisionGeometryBuilder } from '../../src/workers/irregular/collisionGeometryBuilder.js'
import { FreeMaterialServiceLive } from '../../src/workers/irregular/freeMaterialService.js'
import { GeometryKernel, GeometrySettings } from '../../src/workers/irregular/geometryKernel.js'
import { NfpIfpServiceLive } from '../../src/workers/irregular/nfpIfpService.js'
import { TransformGeneratorLive } from '../../src/workers/irregular/transformGenerator.js'
import { IrregularLayoutScorer } from '../../src/workers/algorithm/irregular/irregularLayoutScorer.js'
import { IrregularPlacementScorer } from '../../src/workers/algorithm/irregular/irregularPlacementScorer.js'
import { computeIrregularNestingNative } from '../../src/workers/irregular/native/nativeIrregularBackend.js'
import {
  probeNativeIrregularAddon,
  type NativeCapabilityProbe
} from '../../src/workers/irregular/native/loadNativeBackend.js'
import type { WorkerResponseFailureError } from '@shared/protocol/worker.js'
import { toIrregularWorkerFailure } from '../../src/workers/irregular/irregularWorkerFailure.js'
import {
  compareIrregularDifferentialOutcomes,
  projectIrregularDifferentialOutcome,
  type IrregularDifferentialOutcome
} from '../../src/workers/irregular/differential/irregularSemanticComparison.js'

// ===========================================================================
// CLI
// ===========================================================================

export interface DifferentialArgs {
  readonly fixture: string
  readonly pieces: number | 'all'
  readonly requestFile: string | undefined
  /** WIDTHxHEIGHT override; only meaningful for the named fixtures (never `--request-file`). */
  readonly sheet: string | undefined
  /** `intrinsicObjectiveProfileId` override; mirrors `scripts/irregular-compact-baseline.ts`'s
   * `--objective-profile` (same field, same two values), applied the same way: replace the
   * loaded settings' `optimizer.intrinsicObjectiveProfileId`, nothing else. */
  readonly profile: 'compact' | 'short-side' | undefined
}

export function parseDifferentialArgs(argv: ReadonlyArray<string>): DifferentialArgs {
  let fixture = 'mixed61'
  let pieces: number | 'all' = 4
  let requestFile: string | undefined
  let sheet: string | undefined
  let profile: 'compact' | 'short-side' | undefined
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--fixture') {
      fixture = argv[index + 1] ?? fixture
      index += 1
    } else if (arg === '--pieces') {
      const raw = argv[index + 1]
      index += 1
      if (raw === 'all') {
        pieces = 'all'
      } else {
        const parsed = Number(raw)
        if (!Number.isInteger(parsed) || parsed <= 0) {
          throw new Error(
            `--pieces must be a positive integer or "all", received ${JSON.stringify(raw)}`
          )
        }
        pieces = parsed
      }
    } else if (arg === '--request-file') {
      requestFile = argv[index + 1]
      index += 1
    } else if (arg === '--sheet') {
      sheet = argv[index + 1]
      index += 1
    } else if (arg === '--profile') {
      const raw = argv[index + 1]
      index += 1
      if (raw !== 'compact' && raw !== 'short-side') {
        throw new Error(`--profile must be compact or short-side, received ${JSON.stringify(raw)}`)
      }
      profile = raw
    } else if (arg === '--diagnostic') {
      continue
    } else {
      throw new Error(`Unrecognized argument ${JSON.stringify(arg)}`)
    }
  }
  return { fixture, pieces, requestFile, sheet, profile }
}

// ===========================================================================
// Request loading
// ===========================================================================

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const MIXED61_FIXTURE_PATH = join(
  REPO_ROOT,
  'tests/fixtures/irregularSheetInvariance/mixed61-request.json'
)
const SHAPES_17_DIR = join(REPO_ROOT, 'tests/fixtures/irregularSeventeenShapes')

interface FixtureJson {
  readonly pieces: ReadonlyArray<{ readonly sourcePieceId: string }>
  readonly sourcePieces: ReadonlyArray<{ readonly id: string }>
  readonly [key: string]: unknown
}

/** WIDTHxHEIGHT -> `SheetSpec`; same shape `scripts/irregular-compact-baseline.ts`'s
 * own `sheetArgument` produces (label mirrors the raw string). */
function parseSheet(value: string): SheetSpec {
  const match = /^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/.exec(value)
  if (match === null)
    throw new Error(`--sheet must be WIDTHxHEIGHT, received ${JSON.stringify(value)}`)
  const width = Number(match[1])
  const height = Number(match[2])
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('--sheet dimensions must be positive')
  }
  return new SheetSpec({ width, height, label: `${width}x${height}` })
}

/** Applies `--profile`'s `intrinsicObjectiveProfileId` override the same way
 * `scripts/irregular-compact-baseline.ts` does at its own request-construction
 * site: replace only that one optimizer field, keep everything else. */
function applyProfileOverride(
  request: NestingRequest,
  profile: 'compact' | 'short-side' | undefined
): NestingRequest {
  if (profile === undefined) return request
  const settings = request.options.irregularSettings
  if (settings === undefined) throw new Error(`${request.jobId}: request has no irregular settings`)
  return new NestingRequest({
    ...request,
    options: new NestingOptions({
      ...request.options,
      irregularSettings: new IrregularNestingSettings({
        ...settings,
        optimizer: new IrregularOptimizerSettings({
          ...settings.optimizer,
          intrinsicObjectiveProfileId: profile
        })
      })
    })
  })
}

/**
 * Mirrors `scripts/irregular-compact-baseline.ts`'s synthetic fixture options,
 * except that the differential worker boundary requires a positive timeout.
 * `Number.MAX_SAFE_INTEGER` preserves the baseline harness's practical
 * no-timeout behavior while satisfying the strict request schema.
 */
function compactBaselineRequestOptions(settings: IrregularNestingSettings): NestingOptions {
  return new NestingOptions({
    allowGlobalRotation: true,
    allowGlobalMirror: true,
    timeoutMs: Number.MAX_SAFE_INTEGER,
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

/** Triangle-20 and shapes-17 both go through the real `preparePieces` production
 * step, exactly as `scripts/irregular-compact-baseline.ts`'s own
 * `buildPreparedRequest` does (same helper, not a reimplementation). */
function buildSyntheticRequest(input: {
  readonly fixtureLabel: string
  readonly sheet: SheetSpec
  readonly sources: ReadonlyArray<ImportedPiece>
}): NestingRequest {
  const jobId = JobId.make(`run-differential-${input.fixtureLabel}-${input.sheet.label}`)
  const prepared = preparePieces(
    input.sources,
    input.sheet,
    10,
    jobId,
    undefined,
    undefined,
    () => input.fixtureLabel
  )
  if (prepared.warnings.length > 0) {
    throw new Error(
      `${input.fixtureLabel}: preparation warnings ${JSON.stringify(prepared.warnings)}`
    )
  }
  const settings = new IrregularNestingSettings({
    geometry: DEFAULT_IRREGULAR_GEOMETRY_SETTINGS,
    optimizer: makeCompactQualityIrregularOptimizerSettings({ localRepairBudget: 0 })
  })
  return new NestingRequest({
    version: 1,
    jobId,
    sheet: input.sheet,
    padding: 10,
    pieces: prepared.pieces,
    sourcePieces: input.sources,
    options: compactBaselineRequestOptions(settings)
  })
}

function triangle20Request(sheet: SheetSpec): NestingRequest {
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
  return buildSyntheticRequest({ fixtureLabel: 'triangle-20', sheet, sources })
}

async function shapes17Request(sheet: SheetSpec): Promise<NestingRequest> {
  const fileNames = readdirSync(SHAPES_17_DIR)
    .filter((fileName) => fileName.endsWith('.dxf'))
    .sort((first, second) => first.localeCompare(second, undefined, { numeric: true }))
  if (fileNames.length !== 17) throw new Error(`expected 17 DXF files, found ${fileNames.length}`)
  const sources = await Promise.all(
    fileNames.map(async (fileName, index) => {
      const document = await importDxfFile(join(SHAPES_17_DIR, fileName))
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
  return buildSyntheticRequest({ fixtureLabel: 'shapes-17', sheet, sources })
}

/** `--fixture mixed61 --sheet ...`: rebuilds the mixed-61 request at a
 * different sheet the same way `scripts/irregular-compact-baseline.ts`'s own
 * `mixed61Request` does (decode the fixture, then replace only `sheet` and
 * `jobId`) -- `preparePieces` already ran when the fixture file was captured,
 * and `sheet` carries no back-reference into that prepared-piece geometry
 * (confirmed by that script's own identical override), so this never re-runs
 * `preparePieces`. */
function mixed61RequestAtSheet(raw: FixtureJson, sheet: SheetSpec): NestingRequest {
  const decoded = Schema.decodeUnknownSync(NestingRequest)(raw)
  const settings = decoded.options.irregularSettings
  if (settings === undefined) throw new Error('mixed-61 fixture has no irregular settings')
  return new NestingRequest({
    ...decoded,
    jobId: JobId.make(`run-differential-mixed-61-${sheet.label}`),
    sheet,
    options: new NestingOptions({
      ...decoded.options,
      timeoutMs: Number.MAX_SAFE_INTEGER,
      historyMode: 'off',
      irregularSettings: settings
    })
  })
}

export async function loadDifferentialRequest(args: DifferentialArgs): Promise<NestingRequest> {
  if (args.requestFile !== undefined) {
    if (!existsSync(args.requestFile))
      throw new Error(`Request file not found: ${args.requestFile}`)
    const raw = JSON.parse(readFileSync(args.requestFile, 'utf8')) as unknown
    return applyProfileOverride(Schema.decodeUnknownSync(NestingRequest)(raw), args.profile)
  }

  if (args.fixture === 'triangle-20') {
    if (args.sheet === undefined) throw new Error('--fixture triangle-20 requires --sheet')
    return applyProfileOverride(triangle20Request(parseSheet(args.sheet)), args.profile)
  }
  if (args.fixture === 'shapes-17') {
    if (args.sheet === undefined) throw new Error('--fixture shapes-17 requires --sheet')
    return applyProfileOverride(await shapes17Request(parseSheet(args.sheet)), args.profile)
  }
  if (args.fixture !== 'mixed61') {
    throw new Error(
      `Unknown fixture ${JSON.stringify(args.fixture)}. Known fixtures: mixed61, triangle-20, shapes-17. ` +
        'Pass --request-file <path> to use an arbitrary NestingRequest JSON file instead.'
    )
  }
  if (!existsSync(MIXED61_FIXTURE_PATH)) {
    throw new Error(`Request/fixture file not found: ${MIXED61_FIXTURE_PATH}`)
  }
  const raw = JSON.parse(readFileSync(MIXED61_FIXTURE_PATH, 'utf8')) as FixtureJson

  if (args.sheet !== undefined) {
    return applyProfileOverride(mixed61RequestAtSheet(raw, parseSheet(args.sheet)), args.profile)
  }

  const truncated =
    args.pieces === 'all'
      ? raw
      : (() => {
          const pieces = raw.pieces.slice(0, args.pieces)
          const sourcePieceIds = new Set(pieces.map((piece) => piece.sourcePieceId))
          return {
            ...raw,
            pieces,
            sourcePieces: raw.sourcePieces.filter((piece) => sourcePieceIds.has(piece.id))
          }
        })()

  return applyProfileOverride(Schema.decodeUnknownSync(NestingRequest)(truncated), args.profile)
}

// ===========================================================================
// Running both backends
// ===========================================================================

export function runTypeScriptBackend(
  request: NestingRequest,
  geometrySettings: IrregularNestingSettings,
  options?: ComputeIrregularNestingOptions
): Effect.Effect<IrregularComputeResult, WorkerResponseFailureError> {
  return computeIrregularNesting(request, {
    ...options,
    intrinsicShortSidePairFoldRuntimeControl: options?.intrinsicShortSidePairFoldRuntimeControl ?? {
      now: () => 0,
      currentRssBytes: () => 0
    }
  }).pipe(
    Effect.provide(CollisionGeometryBuilder.Live),
    Effect.provide(TransformGeneratorLive),
    Effect.provide(NfpIfpServiceLive),
    Effect.provide(FreeMaterialServiceLive),
    // `.Layer`, not `.Live` -- picks up the request-derived GeometrySettings
    // instead of the placement scorer's own default, matching production
    // exactly (same reasoning as `dump-coordinator.ts` and
    // `nesting.worker.ts`'s `computeIrregularWorkerResult`).
    Effect.provide(IrregularPlacementScorer.Layer),
    Effect.provide(IrregularLayoutScorer.Live),
    Effect.provide(GeometryKernel.Live),
    Effect.provide(Layer.succeed(GeometrySettings, geometrySettings)),
    Effect.mapError(toIrregularWorkerFailure)
  )
}

export function runRustBackend(
  request: NestingRequest,
  geometrySettings: IrregularNestingSettings
): Effect.Effect<IrregularComputeResult, WorkerResponseFailureError> {
  return computeIrregularNestingNative(request, geometrySettings)
}

export async function runToOutcome(
  effect: Effect.Effect<IrregularComputeResult, WorkerResponseFailureError>
): Promise<IrregularDifferentialOutcome> {
  return Effect.runPromise(
    effect.pipe(
      Effect.match({
        onFailure: (error) => ({ ok: false as const, error }),
        onSuccess: (value) => ({ ok: true as const, value })
      })
    )
  )
}

// ===========================================================================
// Main
// ===========================================================================

function fail(message: string): never {
  console.error(`[run-differential] FAILED: ${message}`)
  process.exit(1)
}

function logDivergence(
  divergence: NonNullable<ReturnType<typeof compareIrregularDifferentialOutcomes>>
): void {
  console.error(`[run-differential] FIRST DIVERGENCE at path: ${divergence.path}`)
  console.error(`  typescript: ${JSON.stringify(divergence.typescript)}`)
  console.error(`  rust      : ${JSON.stringify(divergence.rust)}`)
  console.error(
    `[run-differential] runtime: node=${process.version} platform=${process.platform} arch=${process.arch}`
  )
}

async function main(): Promise<void> {
  const diagnostic = process.argv.includes('--diagnostic')
  const args = parseDifferentialArgs(process.argv.slice(2))
  const request = await loadDifferentialRequest(args)
  const geometrySettings = request.options.irregularSettings ?? GeometrySettings.Make
  const eligibility = intrinsicSharedArchiveEligibility(geometrySettings.optimizer)

  console.log(
    `[run-differential] request: ${args.requestFile ?? `fixture=${args.fixture}`} ` +
      `(jobId=${request.jobId}, pieces=${request.pieces.length}, sheet=${request.sheet.width}x${request.sheet.height}mm)`
  )
  if (!eligibility.eligible) {
    fail(
      `request is not archive-eligible (reason: ${eligibility.reason}); the native backend only implements ` +
        'the Compact / Compact Short Side archive path (R2) -- choose an archive-eligible fixture/request.'
    )
  }

  const probe: NativeCapabilityProbe = probeNativeIrregularAddon()
  if (!probe.available) {
    console.log('[run-differential] backend execution: typescript=did-not-run rust=did-not-run')
    fail(
      `native addon unavailable (${probe.reason}): ${probe.detail} -- aborting before either backend ran ` +
        '(this script never silently reports success with only one backend having executed).'
    )
  }
  console.log(
    `[run-differential] native addon: apiVersion=${probe.nativeApiVersion} backendVersion=${probe.backendVersion} ` +
      `targetTriple=${probe.targetTriple}`
  )

  console.log('[run-differential] running TypeScript backend...')
  const tsOutcome = await runToOutcome(runTypeScriptBackend(request, geometrySettings))

  console.log(
    '[run-differential] running Rust backend (sequentially, after TypeScript completed)...'
  )
  const rustOutcome = await runToOutcome(runRustBackend(request, geometrySettings))

  console.log('[run-differential] backend execution: typescript=ran rust=ran')

  const divergence = compareIrregularDifferentialOutcomes(tsOutcome, rustOutcome)
  if (!tsOutcome.ok || !rustOutcome.ok) {
    if (divergence !== undefined) {
      logDivergence(divergence)
      fail('the compared typed failure outcomes diverged between backends.')
    }
    console.log(
      '[run-differential] OK: TypeScript and Rust backends produced an identical typed failure envelope ' +
        JSON.stringify(projectIrregularDifferentialOutcome(tsOutcome))
    )
    return
  }

  if (divergence !== undefined) {
    logDivergence(divergence)
    if (!diagnostic) {
      fail('the compared semantic outcome diverged between backends.')
    }
    console.error('[run-differential] diagnostic divergence accepted for quality evaluation')
    return
  }

  console.log(
    '[run-differential] OK: TypeScript and Rust backends produced an identical semantic projection ' +
      `(${tsOutcome.value.placedCollisionGeometries.length} placed, ${tsOutcome.value.unplacedPieceIds.length} unplaced, ` +
      `${tsOutcome.value.stateSnapshots.length} state snapshots compared).`
  )
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    fail(error instanceof Error ? (error.stack ?? error.message) : String(error))
  })
}
