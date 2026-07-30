#!/usr/bin/env node
/**
 * Differential harness (docs/planning/rust-irregular-backend/backend-selection-rollback.md
 * §5): runs one real `NestingRequest` through **both** the TypeScript
 * (`computeIrregularNesting`) and native (`computeIrregularNestingNative`)
 * irregular-nesting backends -- sequentially, TypeScript first, never
 * concurrently -- and diffs the documented semantic projection (placements,
 * score, portfolio, diagnostics, sorted-piece order, and the
 * step/rank/candidate/source/placement/unplaced-id state-snapshot
 * sequence). Prints the exact first field where the two backends disagree
 * and exits nonzero on any real difference.
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
 * - Elapsed/timing/byte-count fields: `computeIrregularNesting.ts` has no
 *   injectable clock seam of its own (only `intrinsicCapacitySearch.ts`, a
 *   lower layer, carries one -- confirmed by source grep, matching
 *   `dump-coordinator.ts`'s own finding), so every wall-clock-derived field
 *   the two backends compute independently is expected to differ in value.
 *   All five trace fields (`capacityTrace` / `intrinsicAnytimeSchedulerTrace` /
 *   `focusedCompleteReconstructionTrace` / `intrinsicShortSideObserverTrace` /
 *   `intrinsicShortSidePairFoldTrace`) are otherwise compared field-for-field
 *   (`nativeIrregularBackend.ts` now reconstructs every one of them from the
 *   native boundary's real, structured wire projection -- see that module's
 *   own "Trace fidelity" doc); every field named in
 *   `TIMING_ONLY_TRACE_FIELD_NAMES` below (`runtimeMs`/`elapsedMs`/
 *   `preflightRuntimeMs`/`completeArchiveRuntimeMs`/`prefixTerminalizationMs`/
 *   `coldSearchMs`/`topologyMeasurementMs`/`contactMeasurementMs`/
 *   `serializedTraceBytes`/`peakRssDeltaBytes`, wherever it occurs at any
 *   nesting depth in any of the five traces) is normalized to a presence-only
 *   marker before comparison (`normalizeTimingOnlyFields`): both backends
 *   must agree the field is present-or-absent, but its wall-clock-derived
 *   *value* is never compared.
 * - `IrregularBeamState.remainingPreparedPieces` inside each state
 *   snapshot: the native snapshot DTO does not carry the not-yet-decided
 *   piece queue (`nativeIrregularBackend.ts`'s own "Deferred history-frame
 *   fidelity" doc); the projection below compares only the
 *   step/rank/candidate-count/source/placements/unplaced-id fields every
 *   snapshot's wire representation actually carries on both sides.
 *
 * Usage:
 *   pnpm exec tsx --tsconfig tsconfig.node.json scripts/rust-parity/run-differential.ts \
 *     [--fixture mixed61] [--pieces 4|all] [--request-file <path-to-NestingRequest.json>]
 *
 * `--pieces` (default `4`) truncates a named fixture's `pieces`/`sourcePieces`
 * to a fast, iterable subset; `--request-file` always runs the file's full,
 * untruncated request. Exit code 0 only if both backends actually ran to
 * completion and the compared projection matched exactly; nonzero otherwise
 * (including: native addon unavailable, either backend failed, or any real
 * divergence).
 */
import { Cause, Effect, Exit, Layer, Result, Schema } from 'effect'
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
import {
  IrregularNestingSettings,
  IrregularOptimizerSettings
} from '@shared/irregular/domain.js'
import { intrinsicSharedArchiveEligibility } from '@shared/irregular/executionMode.js'
import { makePresetShapeDocument } from '@shared/presetShapes.js'
import { preparePieces } from '@shared/preparePieces.js'

import {
  computeIrregularNesting,
  type IrregularComputeErrorType,
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

// ===========================================================================
// CLI
// ===========================================================================

interface Args {
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

function parseArgs(argv: ReadonlyArray<string>): Args {
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
          throw new Error(`--pieces must be a positive integer or "all", received ${JSON.stringify(raw)}`)
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
const MIXED61_FIXTURE_PATH = join(REPO_ROOT, 'tests/fixtures/irregularSheetInvariance/mixed61-request.json')
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
  if (match === null) throw new Error(`--sheet must be WIDTHxHEIGHT, received ${JSON.stringify(value)}`)
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
function applyProfileOverride(request: NestingRequest, profile: 'compact' | 'short-side' | undefined): NestingRequest {
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

/** Same production options literal `scripts/irregular-compact-baseline.ts`'s
 * `requestOptions` builds for its synthetic (triangle-20/shapes-17) fixtures. */
function compactBaselineRequestOptions(settings: IrregularNestingSettings): NestingOptions {
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

/** Triangle-20 and shapes-17 both go through the real `preparePieces` production
 * step, exactly as `scripts/irregular-compact-baseline.ts`'s own
 * `buildPreparedRequest` does (same helper, not a reimplementation). */
function buildSyntheticRequest(input: {
  readonly fixtureLabel: string
  readonly sheet: SheetSpec
  readonly sources: ReadonlyArray<ImportedPiece>
}): NestingRequest {
  const jobId = JobId.make(`run-differential-${input.fixtureLabel}-${input.sheet.label}`)
  const prepared = preparePieces(input.sources, input.sheet, 10, jobId, undefined, undefined, () => input.fixtureLabel)
  if (prepared.warnings.length > 0) {
    throw new Error(`${input.fixtureLabel}: preparation warnings ${JSON.stringify(prepared.warnings)}`)
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
  const triangle = makePresetShapeDocument({ kind: 'triangle', width: 70, height: 60, label: 'triangle' }).pieces[0]
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
      timeoutMs: 0,
      historyMode: 'off',
      irregularSettings: settings
    })
  })
}

async function loadRequest(args: Args): Promise<NestingRequest> {
  if (args.requestFile !== undefined) {
    if (!existsSync(args.requestFile)) throw new Error(`Request file not found: ${args.requestFile}`)
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

function runTypeScriptBackend(
  request: NestingRequest,
  geometrySettings: IrregularNestingSettings
): Effect.Effect<IrregularComputeResult, IrregularComputeErrorType> {
  return computeIrregularNesting(request).pipe(
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
    Effect.provide(Layer.succeed(GeometrySettings, geometrySettings))
  )
}

function runRustBackend(
  request: NestingRequest,
  geometrySettings: IrregularNestingSettings
): Effect.Effect<IrregularComputeResult, WorkerResponseFailureError> {
  return computeIrregularNestingNative(request, geometrySettings)
}

type Outcome<A> =
  | { readonly ran: true; readonly ok: true; readonly value: A }
  | { readonly ran: true; readonly ok: false; readonly errorSummary: string }

async function runToOutcome<A, E>(effect: Effect.Effect<A, E>): Promise<Outcome<A>> {
  const exit = await Effect.runPromiseExit(effect)
  if (Exit.isSuccess(exit)) {
    return { ran: true, ok: true, value: exit.value }
  }
  const found = Cause.findFail(exit.cause)
  if (Result.isSuccess(found)) {
    return { ran: true, ok: false, errorSummary: describeError(found.success.error) }
  }
  return { ran: true, ok: false, errorSummary: `unexpected defect: ${Cause.pretty(exit.cause)}` }
}

function describeError(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error && 'message' in error) {
    const withShape = error as { readonly code: unknown; readonly message: unknown }
    return `${String(withShape.code)}: ${String(withShape.message)}`
  }
  return JSON.stringify(error)
}

// ===========================================================================
// Semantic projection + first-divergence diff
// ===========================================================================

/**
 * Every wall-clock/wall-clock-derived field name across all five trace
 * types (`capacityTrace`/`intrinsicAnytimeSchedulerTrace`/
 * `focusedCompleteReconstructionTrace`/`intrinsicShortSideObserverTrace`/
 * `intrinsicShortSidePairFoldTrace`), compared presence-only regardless of
 * nesting depth (`normalizeTimingOnlyFields`) -- see module doc, "What is
 * *not* compared". Name-based (not path-based): every one of these field
 * names is a real, single-purpose measurement field in its own trace
 * interface (verified against `computeIrregularNesting.ts`/
 * `intrinsicCapacitySearch.ts`/`intrinsicShortSideObserver.ts`/
 * `intrinsicShortSidePairFoldObserver.ts`/`intrinsicShortSideContactStrip.ts`),
 * never reused for a differently-typed, semantically-real field elsewhere in
 * these traces.
 */
const TIMING_ONLY_TRACE_FIELD_NAMES: ReadonlySet<string> = new Set([
  'runtimeMs',
  'elapsedMs',
  'preflightRuntimeMs',
  'completeArchiveRuntimeMs',
  'prefixTerminalizationMs',
  'coldSearchMs',
  'topologyMeasurementMs',
  'contactMeasurementMs',
  'serializedTraceBytes',
  'peakRssDeltaBytes'
])

const TIMING_PRESENT_MARKER = '<timing: present>'

/**
 * Walks `value` recursively and replaces every object field whose key is in
 * [`TIMING_ONLY_TRACE_FIELD_NAMES`] with a fixed presence marker (leaving
 * `undefined` untouched, so an absent field stays absent through
 * `toComparable`'s `JSON.stringify` undefined-omission) -- applied to both
 * backends' projections identically before diffing, so `firstDivergence`
 * still catches a presence/absence mismatch but never a wall-clock value
 * mismatch.
 */
function normalizeTimingOnlyFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeTimingOnlyFields)
  }
  if (isPlainObject(value)) {
    const normalized: Record<string, unknown> = {}
    for (const [key, fieldValue] of Object.entries(value)) {
      if (TIMING_ONLY_TRACE_FIELD_NAMES.has(key)) {
        normalized[key] = fieldValue === undefined ? undefined : TIMING_PRESENT_MARKER
      } else {
        normalized[key] = normalizeTimingOnlyFields(fieldValue)
      }
    }
    return normalized
  }
  return value
}

/** See module doc for exactly what this excludes and why. */
function projectForComparison(result: IrregularComputeResult): unknown {
  return {
    placedCollisionGeometries: result.placedCollisionGeometries,
    score: result.score,
    unplacedPieceIds: result.unplacedPieceIds,
    diagnostics: result.diagnostics,
    sortedPieceIds: result.sortedPieceIds,
    beamWidth: result.beamWidth,
    portfolio: result.portfolio,
    stateSnapshots: result.stateSnapshots.map((snapshot) => ({
      stepIndex: snapshot.stepIndex,
      beamRank: snapshot.beamRank,
      candidateCount: snapshot.candidateCount,
      source: snapshot.source,
      placedCollisionGeometries: snapshot.state.placedCollisionGeometries,
      unplacedPieceIds: snapshot.state.unplacedPieceIds
    })),
    capacityTrace: result.capacityTrace,
    intrinsicAnytimeSchedulerTrace: result.intrinsicAnytimeSchedulerTrace,
    focusedCompleteReconstructionTrace: result.focusedCompleteReconstructionTrace,
    intrinsicShortSideObserverTrace: result.intrinsicShortSideObserverTrace,
    intrinsicShortSidePairFoldTrace: result.intrinsicShortSidePairFoldTrace
  }
}

/**
 * Converts to a plain JSON-shaped value first (sidesteps class identity;
 * exact for finite numbers). `bigint` fields (`capacityTrace`'s
 * `placedDoubledMaterialAreaGrid2` and friends) are rendered as their
 * decimal-string `toString()` -- `JSON.stringify` itself throws on a raw
 * `bigint` (`TypeError: Do not know how to serialize a BigInt`), and a
 * decimal string is exact and order-preserving for equality comparison,
 * which is all `firstDivergence` needs.
 */
function toComparable(value: unknown): unknown {
  const json = JSON.stringify(value, (_key, fieldValue: unknown) =>
    typeof fieldValue === 'bigint' ? fieldValue.toString() : fieldValue
  )
  return JSON.parse(json) as unknown
}

interface Divergence {
  readonly path: string
  readonly typescript: unknown
  readonly rust: unknown
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function firstDivergence(path: string, a: unknown, b: unknown): Divergence | undefined {
  if (Object.is(a, b)) return undefined
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      return { path: `${path}.length`, typescript: a.length, rust: b.length }
    }
    for (let index = 0; index < a.length; index += 1) {
      const found = firstDivergence(`${path}[${index}]`, a[index], b[index])
      if (found !== undefined) return found
    }
    return undefined
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].toSorted((x, y) => x.localeCompare(y))
    for (const key of keys) {
      const found = firstDivergence(path === '' ? key : `${path}.${key}`, a[key], b[key])
      if (found !== undefined) return found
    }
    return undefined
  }
  return { path: path === '' ? '(root)' : path, typescript: a, rust: b }
}

// ===========================================================================
// Main
// ===========================================================================

function fail(message: string): never {
  console.error(`[run-differential] FAILED: ${message}`)
  process.exit(1)
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const request = await loadRequest(args)
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

  console.log('[run-differential] running Rust backend (sequentially, after TypeScript completed)...')
  const rustOutcome = await runToOutcome(runRustBackend(request, geometrySettings))

  console.log(
    `[run-differential] backend execution: typescript=${tsOutcome.ran ? 'ran' : 'did-not-run'} ` +
      `rust=${rustOutcome.ran ? 'ran' : 'did-not-run'}`
  )

  if (!tsOutcome.ok || !rustOutcome.ok) {
    if (!tsOutcome.ok) console.error(`[run-differential] TypeScript backend failed: ${tsOutcome.errorSummary}`)
    if (!rustOutcome.ok) console.error(`[run-differential] Rust backend failed: ${rustOutcome.errorSummary}`)
    fail('at least one backend did not produce a result; nothing to compare.')
  }

  const tsProjection = normalizeTimingOnlyFields(toComparable(projectForComparison(tsOutcome.value)))
  const rustProjection = normalizeTimingOnlyFields(toComparable(projectForComparison(rustOutcome.value)))
  const divergence = firstDivergence('', tsProjection, rustProjection)

  if (divergence !== undefined) {
    console.error(`[run-differential] FIRST DIVERGENCE at path: ${divergence.path}`)
    console.error(`  typescript: ${JSON.stringify(divergence.typescript)}`)
    console.error(`  rust      : ${JSON.stringify(divergence.rust)}`)
    fail('the compared semantic projection diverged between backends.')
  }

  console.log(
    '[run-differential] OK: TypeScript and Rust backends produced an identical semantic projection ' +
      `(${tsOutcome.value.placedCollisionGeometries.length} placed, ${tsOutcome.value.unplacedPieceIds.length} unplaced, ` +
      `${tsOutcome.value.stateSnapshots.length} state snapshots compared).`
  )
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? (error.stack ?? error.message) : String(error))
})
