/**
 * TS-side adapter for the `irregular-nesting-native` addon's real job
 * surface (`runIrregularJob`/`cancelIrregularJob`, `crates/irregular-nesting-native/src/boundary/job.rs`).
 *
 * Mirrors `computeIrregularNesting`'s own external contract (same
 * `NestingRequest` input, same `IrregularComputeResult` success shape) so the
 * one production call site (`nesting.worker.ts`'s `computeIrregularWorkerResult`)
 * can select between the two with a minimal branch, and so
 * `scripts/rust-parity/run-differential.ts` can run both backends
 * side-by-side over the same request. Unlike `computeIrregularNesting`, the
 * error channel here is already the terminal `WorkerResponseFailureError`
 * (not `IrregularComputeErrorType`) -- native failures never originate from
 * the TS `IrregularComputeErrorType` tagged union, so re-deriving one just to
 * immediately re-map it via `toIrregularWorkerFailure` would be pure
 * indirection. The Rust boundary's `BoundaryError.category` is already a
 * real `AppErrorCode` string (`crates/irregular-nesting-native/src/boundary/error.rs`'s
 * module doc: "category carries the real AppErrorCode string ... not a
 * placeholder"), so the mapping in this module is a validated pass-through,
 * not a second copy of the section-16 table.
 *
 * # Deferred trace fidelity
 *
 * `capacityTrace`/`intrinsicAnytimeSchedulerTrace`/`focusedCompleteReconstructionTrace`/
 * `intrinsicShortSideObserverTrace`/`intrinsicShortSidePairFoldTrace` are
 * left `undefined` on the `IrregularComputeResult` this module produces.
 * The native result DTO currently projects each of these (when present) as
 * an opaque `{"raw": "<Rust Debug repr>"}` blob (`boundary::result`'s own
 * module doc, "Deferred: five optional trace fields' internal field shape"),
 * not the real structured TS shape -- fabricating a value that merely
 * type-checks would be worse than an honest absence. Verified this is safe
 * for the one production consumer: neither `computeIrregularWorkerResult`
 * nor `makeIrregularWorkerOutput` reads into any of these five fields today
 * (source-grepped; both only read `placedCollisionGeometries`, `score`,
 * `unplacedPieceIds`, `diagnostics`, `sortedPieceIds`, `stateSnapshots`,
 * `beamWidth`, `portfolio`). `capacityShadowTelemetry`/`experimentalPlaceDeferTrace`
 * are omitted for the same reason and are additionally never populated in
 * production regardless of backend (`computeIrregularWorkerResult` never
 * sets the opt-in options that would enable them).
 *
 * # Deferred history-frame fidelity for live-streamed snapshots
 *
 * A streamed/retained native state snapshot does not carry the queued,
 * not-yet-decided prepared-piece list (`native-boundary.md`'s own note on
 * `NativeStateSnapshot`: it "carries the real, exact placements/unplaced-ids/
 * step/rank/source data every consumer ... actually needs", deliberately
 * narrower than the full `IrregularBeamState`). This module reconstructs a
 * real `IrregularBeamState` from the exact placement/unplaced data (so
 * `canonicalOccupiedGeometryKey`, contact metrics, etc. are genuine, derived
 * values, not fabricated), with `remainingPreparedPieces: []` always -- the
 * only field this cannot reconstruct. The one downstream reader sensitive to
 * this is `makeIrregularHistoryFrame`'s title/`remainingPieceIds` heuristic,
 * used both for the live-streamed history frame and for
 * `makeIrregularWorkerOutput`'s `historyFrames` output (itself discarded by
 * `computeIrregularWorkerResult`, which only reads `.result`).
 */
import { Effect, Schema } from 'effect'
import { PieceId } from '@shared/domain/ids.js'
import { NestingRequest } from '@shared/domain/nesting.js'
import { AppErrorCode } from '@shared/protocol/errors.js'
import { WorkerResponseFailureError } from '@shared/protocol/worker.js'
import {
  CollisionGeometryDiagnostic,
  CollisionGeometryDiagnosticSchema,
  FreeMaterialSnapshot,
  FreeMaterialSnapshotSchema,
  IrregularNestingSettings,
  IrregularPlacedPiece,
  IrregularPlacedPieceSchema,
  IrregularPortfolioProgress,
  IrregularPortfolioResult
} from '@shared/irregular/domain.js'
import type {
  ComputeIrregularNestingOptions,
  IrregularComputeResult,
  IrregularStateSnapshot
} from '../../algorithm/irregular/computeIrregularNesting.js'
import { IrregularBeamState } from '../../algorithm/irregular/irregularBeamState.js'
import {
  describeError,
  loadNativeIrregularAddon,
  probeNativeIrregularAddon
} from './loadNativeBackend.js'
import type { NativeCapabilityProbe } from './loadNativeBackend.js'

/** Polling cadence for the `isCancelled` -> `cancelIrregularJob` cooperative-cancellation bridge. */
let isCancelledPollIntervalMs = 50

/**
 * Test-only: overrides the `isCancelled` poll cadence so a test does not have
 * to race a trivially-fast native job against the production 50ms default.
 * Never called from production code.
 */
export function setIsCancelledPollIntervalMsForTests(ms: number): void {
  isCancelledPollIntervalMs = ms
}

/** The subset of `ComputeIrregularNestingOptions` the native backend adapts. */
export interface NativeIrregularBackendOptions {
  readonly emitStateSnapshot?: ComputeIrregularNestingOptions['emitStateSnapshot']
  readonly emitPortfolioProgress?: ComputeIrregularNestingOptions['emitPortfolioProgress']
  readonly isCancelled?: ComputeIrregularNestingOptions['isCancelled']
}

// ===========================================================================
// Request encoding (TS NestingRequest -> the crate's `RequestDto` wire shape,
// `crates/irregular-nesting-native/src/boundary/request.rs`).
// ===========================================================================

/**
 * Encodes `request` to the exact wire JSON `RequestDto::decode_and_prepare`
 * expects. Reuses `NestingRequest`'s own schema encoder (canonical field
 * spelling and optional-field omission "for free", never a hand-maintained
 * second copy of the wire shape); the Rust side ignores wire keys it does
 * not declare a field for (`request.rs`'s own doc: "serde ignores
 * unrecognized wire keys by default"), so encoding the *whole* validated
 * request is safe even though the Rust `NestingOptionsDto` only declares a
 * subset of `NestingOptions`' fields.
 *
 * `geometrySettings` is the caller's already-resolved
 * `request.options.irregularSettings ?? GeometrySettings.Make` value
 * (`native-boundary.md` §7.4: the native boundary requires this field
 * populated, never resolves the default itself) -- passed in rather than
 * re-resolved here so there is exactly one default-resolution call site,
 * matching `computeIrregularWorkerResult`'s own.
 */
export function encodeNativeRequestJson(
  request: NestingRequest,
  geometrySettings: IrregularNestingSettings
): string {
  const encoded = Schema.encodeSync(NestingRequest)(request) as {
    options: { irregularSettings?: unknown }
  } & Record<string, unknown>
  if (encoded.options.irregularSettings === undefined) {
    encoded.options.irregularSettings = Schema.encodeSync(IrregularNestingSettings)(geometrySettings)
  }
  return JSON.stringify(encoded)
}

// ===========================================================================
// Error mapping (`backend-selection-rollback.md` §6.2; the Rust side already
// carries a real `AppErrorCode` string per `boundary::error`'s own doc).
// ===========================================================================

interface NativeBoundaryErrorJson {
  readonly category: string
  readonly operation: string
  readonly message: string
  readonly context?: Readonly<Record<string, string>>
}

function isAppErrorCode(value: string): value is AppErrorCode {
  return (AppErrorCode as ReadonlyArray<string>).includes(value)
}

/**
 * Validated pass-through: the Rust `BoundaryError` this decodes already
 * carries the exact `AppErrorCode` string and per-code context fields
 * `toIrregularWorkerFailure` (`nesting.worker.ts`) derives for the TS path,
 * transcribed and unit-tested on the Rust side
 * (`crates/irregular-nesting-native/src/boundary/error.rs`). Falls back to
 * `unknown_error` only for a category this TypeScript build does not
 * recognize -- constructing `WorkerResponseFailureError` with an
 * unrecognized `code` would itself throw (`code` is a `Schema.Literals`
 * over `AppErrorCode`), so this guard is required, not defensive polish.
 */
function mapNativeErrorToWorkerFailure(error: NativeBoundaryErrorJson): WorkerResponseFailureError {
  const code = isAppErrorCode(error.category) ? error.category : 'unknown_error'
  const context: Record<string, unknown> = { ...error.context }
  if (code !== error.category) {
    context['nativeCategory'] = error.category
  }
  return new WorkerResponseFailureError({
    code,
    message: error.message,
    ...(Object.keys(context).length > 0 ? { context } : {})
  })
}

/** §6.2 row 1: `backend === 'rust'`, capability probe unavailable, policy `strict`. */
function addonUnavailableFailure(
  probe: Extract<NativeCapabilityProbe, { available: false }>
): WorkerResponseFailureError {
  return new WorkerResponseFailureError({
    code: 'worker_protocol_error',
    message: `irregular-nesting-native addon unavailable (${probe.reason}): ${probe.detail}`,
    context: { nativeApiVersion: 'unavailable', requestedBackend: 'rust', reason: probe.reason }
  })
}

function protocolFailure(message: string, context?: Readonly<Record<string, unknown>>): WorkerResponseFailureError {
  return new WorkerResponseFailureError({
    code: 'worker_protocol_error',
    message,
    ...(context !== undefined ? { context } : {})
  })
}

// ===========================================================================
// Result decoding (the crate's `NativeIrregularComputeResult` wire shape,
// `crates/irregular-nesting-native/src/boundary/result.rs`, -> TS
// `IrregularComputeResult`). Reuses every existing boundary/domain schema
// this crate's own ported types already declare; only the shapes with no
// existing TS schema (the full, non-summary `IrregularLayoutScore` and the
// native state-snapshot event/result shape) are declared locally.
// ===========================================================================

const NativeIrregularLayoutScoreSchema = Schema.Struct({
  unplacedCount: Schema.Number,
  sharedCollisionBoundaryLengthMm: Schema.Number,
  sharedCollisionBoundaryContactUnits: Schema.Number,
  sharedCollisionBoundaryContactBand: Schema.Number,
  nearCompleteStructuralContactCount: Schema.Number,
  dominantNearCompleteStructuralContactCount: Schema.Number,
  largestNetFreeMaterialRegionAreaMm2: Schema.Number,
  freeMaterialRegionCount: Schema.Number,
  freeMaterialHoleCount: Schema.Number,
  freeMaterialSliverMetric: Schema.Number,
  collisionBoundsWorstNormalizedSheetConsumption: Schema.Number,
  collisionBoundsNormalizedSpanSum: Schema.Number,
  collisionBoundsAreaMm2: Schema.Number,
  collisionBoundsSpanMm: Schema.Number,
  occupiedHullWasteRatio: Schema.Number,
  collisionBoundsBottomMm: Schema.Number,
  collisionBoundsLeftMm: Schema.Number,
  freeMaterialSnapshot: FreeMaterialSnapshotSchema,
  placementOrder: Schema.Array(PieceId),
  unplacedSourcePieceIds: Schema.Array(PieceId)
})

/** `boundary::events`/`boundary::result`'s `NativeStateSnapshot` wire shape. */
const NativeStateSnapshotSchema = Schema.Struct({
  ordinal: Schema.Number,
  stepIndex: Schema.Number,
  beamRank: Schema.Number,
  candidateCount: Schema.Number,
  source: Schema.optional(Schema.Literals(['beam', 'shared-archive'])),
  placements: Schema.Array(IrregularPlacedPieceSchema),
  unplacedPieceIds: Schema.Array(PieceId)
})
type NativeStateSnapshotDto = Schema.Schema.Type<typeof NativeStateSnapshotSchema>

const NativeIrregularComputeResultSchema = Schema.Struct({
  placedCollisionGeometries: Schema.Array(IrregularPlacedPieceSchema),
  score: NativeIrregularLayoutScoreSchema,
  unplacedPieceIds: Schema.Array(PieceId),
  diagnostics: Schema.Array(CollisionGeometryDiagnosticSchema),
  sortedPieceIds: Schema.Array(PieceId),
  stateSnapshots: Schema.Array(NativeStateSnapshotSchema),
  beamWidth: Schema.Number,
  portfolio: IrregularPortfolioResult
})

/** See module doc, "Deferred history-frame fidelity for live-streamed snapshots". */
function toIrregularStateSnapshot(dto: NativeStateSnapshotDto): IrregularStateSnapshot {
  const placedCollisionGeometries = dto.placements.map((placed) => new IrregularPlacedPiece(placed))
  const placementOrder = placedCollisionGeometries.map(
    (placed) => placed.placement.pieceId ?? placed.placement.sourcePieceId
  )
  const state = new IrregularBeamState({
    remainingPreparedPieces: [],
    placedCollisionGeometries,
    unplacedPieceIds: dto.unplacedPieceIds,
    placementOrder
  })
  return {
    stepIndex: dto.stepIndex,
    beamRank: dto.beamRank,
    candidateCount: dto.candidateCount,
    ...(dto.source !== undefined ? { source: dto.source } : {}),
    state
  }
}

/** Throws (never a typed `Result`) -- callers wrap this in `Effect.try`. */
function decodeNativeComputeResult(raw: unknown): IrregularComputeResult {
  const dto = Schema.decodeUnknownSync(NativeIrregularComputeResultSchema)(raw)
  return {
    placedCollisionGeometries: dto.placedCollisionGeometries.map(
      (placed) => new IrregularPlacedPiece(placed)
    ),
    score: {
      ...dto.score,
      freeMaterialSnapshot: new FreeMaterialSnapshot(dto.score.freeMaterialSnapshot)
    },
    unplacedPieceIds: dto.unplacedPieceIds,
    diagnostics: dto.diagnostics.map((diagnostic) => new CollisionGeometryDiagnostic(diagnostic)),
    sortedPieceIds: dto.sortedPieceIds,
    stateSnapshots: dto.stateSnapshots.map(toIrregularStateSnapshot),
    beamWidth: dto.beamWidth,
    portfolio: dto.portfolio
    // capacityTrace / intrinsicAnytimeSchedulerTrace / focusedCompleteReconstructionTrace /
    // intrinsicShortSideObserverTrace / intrinsicShortSidePairFoldTrace: deliberately
    // omitted -- see module doc, "Deferred trace fidelity".
  }
}

// ===========================================================================
// Streamed event envelope shape (`boundary::events`'s `OrdinalPortfolioProgress`
// -- `{"ordinal", ...flattened NativeIrregularPortfolioProgress}`).
// ===========================================================================

interface NativeEnvelope {
  readonly ok: boolean
  readonly result?: unknown
  readonly error?: NativeBoundaryErrorJson
}

/**
 * Tracks the shared cross-channel ordinal `boundary::events`'s `BoundaryEventSink`
 * assigns (one counter across both the portfolio-progress and state-snapshot
 * channels). Node/napi's `ThreadsafeFunctionCallMode::NonBlocking` calls from
 * one coordinating native thread are delivered to JS in call order (libuv's
 * own FIFO guarantee), so this is a defensive tripwire -- logged, never
 * thrown -- rather than the sole mechanism preserving logical order.
 */
function makeOrdinalTripwire(jobId: string): (ordinal: number) => void {
  let lastOrdinal = -1
  return (ordinal: number) => {
    if (ordinal <= lastOrdinal) {
      console.error(
        `[nativeIrregularBackend] out-of-order event ordinal ${ordinal} (last ${lastOrdinal}) for job ${jobId}`
      )
    }
    lastOrdinal = Math.max(lastOrdinal, ordinal)
  }
}

// ===========================================================================
// The adapter itself.
// ===========================================================================

/**
 * Runs one archive-eligible job on the native backend. Mirrors
 * `computeIrregularNesting`'s contract; see module doc for the exact
 * differences (error channel, deferred trace/history-frame fidelity).
 *
 * Cancellation: `options.isCancelled`, when supplied, is polled (never
 * pushed) at a configurable interval (production default 50ms) and bridged to the
 * native job's own push-based `cancelIrregularJob(jobId)` registry
 * (`boundary::job`'s cooperative `Arc<AtomicBool>` flag) -- the same
 * logical observation-point contract `computeIrregularNesting`'s own
 * `isCancelled` seam has (R19), adapted across the pull/push boundary
 * mismatch between the two backends' cancellation designs. Once the native
 * promise has been created, no code path here retries the job in
 * TypeScript on any failure, cancellation, or deadline outcome (§4.1's
 * no-retry rule).
 */
export function computeIrregularNestingNative(
  request: NestingRequest,
  geometrySettings: IrregularNestingSettings,
  options?: NativeIrregularBackendOptions
): Effect.Effect<IrregularComputeResult, WorkerResponseFailureError> {
  return Effect.gen(function* () {
    const probe = probeNativeIrregularAddon()
    if (!probe.available) {
      return yield* Effect.fail(addonUnavailableFailure(probe))
    }

    const addon = yield* Effect.try({
      try: () => loadNativeIrregularAddon(),
      catch: (cause) =>
        protocolFailure(`irregular-nesting-native addon failed to load: ${describeError(cause)}`, {
          requestedBackend: 'rust'
        })
    })

    const requestJson = yield* Effect.try({
      try: () => encodeNativeRequestJson(request, geometrySettings),
      catch: (cause) =>
        protocolFailure(`failed to encode NestingRequest for the native backend: ${describeError(cause)}`, {
          requestedBackend: 'rust'
        })
    })

    const noteOrdinal = makeOrdinalTripwire(request.jobId)

    const onPortfolioProgress = (json: string): void => {
      if (options?.emitPortfolioProgress === undefined) return
      const parsed = JSON.parse(json) as { readonly ordinal: number } & Record<string, unknown>
      noteOrdinal(parsed.ordinal)
      // Schema decode silently ignores unrecognized wire keys by default, so the shared
      // `ordinal` key (consumed only by `noteOrdinal` above) does not need stripping first.
      const progress = Schema.decodeUnknownSync(IrregularPortfolioProgress)(parsed)
      void Effect.runPromise(options.emitPortfolioProgress(progress)).catch(() => {})
    }

    const emitStateSnapshot = options?.emitStateSnapshot
    const onStateSnapshot =
      emitStateSnapshot === undefined
        ? null
        : (json: string): void => {
            const parsed = JSON.parse(json) as { readonly ordinal: number }
            noteOrdinal(parsed.ordinal)
            const dto = Schema.decodeUnknownSync(NativeStateSnapshotSchema)(parsed)
            emitStateSnapshot(toIrregularStateSnapshot(dto), geometrySettings.optimizer.beamWidth)
          }

    let cancelPollTimer: ReturnType<typeof setInterval> | undefined
    const isCancelled = options?.isCancelled
    if (isCancelled !== undefined) {
      cancelPollTimer = setInterval(() => {
        if (isCancelled()) {
          addon.cancelIrregularJob(request.jobId)
          if (cancelPollTimer !== undefined) clearInterval(cancelPollTimer)
        }
      }, isCancelledPollIntervalMs)
    }

    const envelopeJson = yield* Effect.tryPromise({
      try: () => addon.runIrregularJob(requestJson, onPortfolioProgress, onStateSnapshot, null),
      catch: (cause) =>
        protocolFailure(
          `irregular-nesting-native runIrregularJob rejected unexpectedly: ${describeError(cause)}`,
          { requestedBackend: 'rust' }
        )
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (cancelPollTimer !== undefined) clearInterval(cancelPollTimer)
        })
      )
    )

    const envelope = yield* Effect.try({
      try: () => JSON.parse(envelopeJson) as NativeEnvelope,
      catch: () =>
        protocolFailure('irregular-nesting-native returned a response that did not parse as JSON.', {
          requestedBackend: 'rust'
        })
    })

    if (!envelope.ok) {
      if (envelope.error === undefined) {
        return yield* Effect.fail(
          protocolFailure('irregular-nesting-native returned ok:false without an error payload.', {
            requestedBackend: 'rust'
          })
        )
      }
      return yield* Effect.fail(mapNativeErrorToWorkerFailure(envelope.error))
    }

    return yield* Effect.try({
      try: () => decodeNativeComputeResult(envelope.result),
      catch: (cause) =>
        protocolFailure(
          `irregular-nesting-native returned a result that did not decode: ${describeError(cause)}`,
          { requestedBackend: 'rust' }
        )
    })
  })
}
