/**
 * TS-side adapter for the `irregular-nesting-native` addon's real job
 * surface (`runIrregularJob`/`cancelIrregularJob`, the package's `polygon-nesting-napi::job` module).
 *
 * Mirrors `computeIrregularNesting`'s own external contract (same
 * `NestingRequest` input, same `IrregularComputeResult` success shape) so the
 * one production call site (`nesting.worker.ts`'s `computeIrregularWorkerResult`)
 * can select between the two with a minimal branch. Unlike
 * `computeIrregularNesting`, the
 * error channel here is already the terminal `WorkerResponseFailureError`
 * (not `IrregularComputeErrorType`) -- native failures never originate from
 * the TS `IrregularComputeErrorType` tagged union, so re-deriving one just to
 * immediately re-map it via `toIrregularWorkerFailure` would be pure
 * indirection. The Rust boundary's `BoundaryError.category` is already a
 * real `AppErrorCode` string (the package's native error projection's
 * module doc: "category carries the real AppErrorCode string ... not a
 * placeholder"), so the mapping in this module is a validated pass-through,
 * not a second copy of the section-16 table.
 *
 * # Trace fidelity
 *
 * `capacityTrace`/`intrinsicAnytimeSchedulerTrace`/`focusedCompleteReconstructionTrace`/
 * `intrinsicShortSideObserverTrace`/`intrinsicShortSidePairFoldTrace` are
 * reconstructed field-for-field from the native result DTO's own
 * field-for-field wire projection of each trace (`boundary::result`'s own
 * module doc), matching the exact in-memory shape `computeIrregularNesting`
 * itself would have produced. `capacityTrace`'s handful of `BigInt`-valued
 * fields (`placedDoubledMaterialAreaGrid2` and
 * `IntrinsicCapacityPreflightMeasurements`'s four pressure/area fields)
 * cross the wire as decimal-digit strings (`capacity::serialize_bigint_decimal_string`'s
 * own doc comment) and are decoded back to `bigint` via `BigInt(<string>)`
 * below (`WireBigInt`); every other field in all five traces is
 * already a JSON-native type (`number`/`string`/`boolean`/literal union), so
 * `JSON.parse`'s own output already has the right runtime shape -- these
 * decoders exist to thread the `bigint` conversion through each trace's
 * nested structure and to give the result its exact TS type, not to
 * re-validate field names Rust already asserts by construction.
 * `capacityShadowTelemetry`/`experimentalPlaceDeferTrace` are omitted:
 * neither `computeIrregularWorkerResult` nor `makeIrregularWorkerOutput`
 * reads either field, and neither is ever populated in production
 * regardless of backend (`computeIrregularWorkerResult` never sets the
 * opt-in options that would enable them) -- verified by source grep, same
 * reasoning this module already applied to the five traces above before
 * they were reconstructed.
 *
 * # State-snapshot fidelity
 *
 * Streamed and retained native snapshots carry the complete remaining
 * prepared-piece queue alongside placements and unplaced IDs. The adapter
 * decodes each prepared piece through the shared boundary schema and
 * reconstructs the exact `IrregularBeamState` shape consumed by
 * `makeIrregularHistoryFrame`, including reveal titles and remaining IDs.
 */
import { randomUUID } from 'node:crypto'
import { Effect, Schema } from 'effect'
import { PieceId } from '@shared/domain/ids.js'
import { NestingRequest } from '@shared/domain/nesting.js'
import { AppErrorCode } from '@shared/protocol/errors.js'
import {
  WorkerResponseFailureError,
  type WorkerCancellationReason
} from '@shared/protocol/worker.js'
import {
  CollisionGeometryDiagnostic,
  CollisionGeometryDiagnosticSchema,
  FreeMaterialSnapshot,
  FreeMaterialSnapshotSchema,
  IrregularNestingSettings,
  IrregularPlacedPiece,
  IrregularPlacedPieceSchema,
  IrregularPreparedPiece,
  IrregularPreparedPieceSchema,
  IrregularPortfolioProgress,
  IrregularPortfolioResult
} from '@shared/irregular/domain.js'
import type {
  ComputeIrregularNestingOptions,
  IntrinsicAnytimeSchedulerTrace,
  IntrinsicFocusedCompleteReconstructionTrace,
  IrregularComputeResult,
  IrregularStateSnapshot
} from '../../algorithm/irregular/computeIrregularNesting.js'
import { IrregularBeamState } from '../../algorithm/irregular/irregularBeamState.js'
import type {
  IntrinsicCapacityCohesionShadowTrace,
  IntrinsicCapacityQualityWarmPrefixTrace,
  IntrinsicCapacitySelectionTrace,
  IntrinsicCapacityTrace,
  IntrinsicCapacityWarmPrefixLaneTrace
} from '../../algorithm/irregular/intrinsicCapacityMode.js'
import type {
  IntrinsicCapacityPreflightMeasurements,
  IntrinsicCapacityPreflightOutcome
} from '../../algorithm/irregular/intrinsicCapacityPreflight.js'
import type { IntrinsicCapacityObjective } from '../../algorithm/irregular/intrinsicCapacityEndpoint.js'
import type {
  IntrinsicCapacitySearchTrace,
  IntrinsicCapacityTopologyRepresentative,
  IntrinsicCapacityTopologyRetentionDepthTrace
} from '../../algorithm/irregular/intrinsicCapacitySearch.js'
import type { IntrinsicShortSideObserverTrace } from '../../algorithm/irregular/intrinsicShortSideObserver.js'
import type { IntrinsicShortSidePairFoldTrace } from '../../algorithm/irregular/intrinsicShortSidePairFoldObserver.js'
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
  readonly registerNativeCancellation?: ComputeIrregularNestingOptions['registerNativeCancellation']
}

// ===========================================================================
// Request encoding (TS NestingRequest -> the crate's `RequestDto` wire shape,
// the package's native request adapter).
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
    encoded.options.irregularSettings =
      Schema.encodeSync(IrregularNestingSettings)(geometrySettings)
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
 * (the package's native error projection). Falls back to
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

/** Maps an unavailable native capability for an explicit Rust request. */
function addonUnavailableFailure(
  probe: Extract<NativeCapabilityProbe, { available: false }>
): WorkerResponseFailureError {
  return new WorkerResponseFailureError({
    code: 'worker_protocol_error',
    message: `irregular-nesting-native addon unavailable (${probe.reason}): ${probe.detail}`,
    context: { nativeApiVersion: 'unavailable', requestedBackend: 'rust', reason: probe.reason }
  })
}

function protocolFailure(
  message: string,
  context?: Readonly<Record<string, unknown>>
): WorkerResponseFailureError {
  return new WorkerResponseFailureError({
    code: 'worker_protocol_error',
    message,
    ...(context !== undefined ? { context } : {})
  })
}

// ===========================================================================
// Trace decoding (the five `boundary::result`-projected optional trace
// fields on `NativeIrregularComputeResult` -> the exact TS trace types
// `computeIrregularNesting`'s own control flow would have produced -- see
// module doc, "Trace fidelity"). `WireBigInt<T, K>` mechanically re-types
// every `bigint`-valued field `K` on `T` as the decimal-string wire
// encoding `capacity::serialize_bigint_decimal_string` uses, so each "wire"
// type below is otherwise structurally identical to its real TS
// counterpart (same field names, same nesting) -- only the finitely many
// `bigint` leaves actually need a manual `BigInt(<string>)` decode step.
// ===========================================================================

type WireBigInt<T, K extends keyof T> = Omit<T, K> & { readonly [P in K]: string }

type WireIntrinsicCapacityObjective = WireBigInt<
  IntrinsicCapacityObjective,
  'placedDoubledMaterialAreaGrid2'
>

function toIntrinsicCapacityObjective(
  wire: WireIntrinsicCapacityObjective
): IntrinsicCapacityObjective {
  return {
    ...wire,
    placedDoubledMaterialAreaGrid2: BigInt(wire.placedDoubledMaterialAreaGrid2)
  }
}

type WireIntrinsicCapacityTopologyRepresentative = WireBigInt<
  IntrinsicCapacityTopologyRepresentative,
  'placedDoubledMaterialAreaGrid2'
>

function toIntrinsicCapacityTopologyRepresentative(
  wire: WireIntrinsicCapacityTopologyRepresentative
): IntrinsicCapacityTopologyRepresentative {
  return {
    ...wire,
    placedDoubledMaterialAreaGrid2: BigInt(wire.placedDoubledMaterialAreaGrid2)
  }
}

type WireIntrinsicCapacityTopologyRetentionDepthTrace = Omit<
  IntrinsicCapacityTopologyRetentionDepthTrace,
  'representatives'
> & {
  readonly representatives: ReadonlyArray<WireIntrinsicCapacityTopologyRepresentative>
}

function toIntrinsicCapacityTopologyRetentionDepthTrace(
  wire: WireIntrinsicCapacityTopologyRetentionDepthTrace
): IntrinsicCapacityTopologyRetentionDepthTrace {
  return {
    ...wire,
    representatives: wire.representatives.map(toIntrinsicCapacityTopologyRepresentative)
  }
}

type WireIntrinsicCapacitySearchTrace = Omit<
  IntrinsicCapacitySearchTrace,
  'topologyRetentionDepths'
> & {
  readonly topologyRetentionDepths:
    | ReadonlyArray<WireIntrinsicCapacityTopologyRetentionDepthTrace>
    | undefined
}

function toIntrinsicCapacitySearchTrace(
  wire: WireIntrinsicCapacitySearchTrace
): IntrinsicCapacitySearchTrace {
  return {
    ...wire,
    topologyRetentionDepths: wire.topologyRetentionDepths?.map(
      toIntrinsicCapacityTopologyRetentionDepthTrace
    )
  }
}

type WireIntrinsicCapacityWarmPrefixLaneTrace = Omit<
  IntrinsicCapacityWarmPrefixLaneTrace,
  'endpoint'
> & {
  readonly endpoint: WireIntrinsicCapacityObjective | undefined
}

function toIntrinsicCapacityWarmPrefixLaneTrace(
  wire: WireIntrinsicCapacityWarmPrefixLaneTrace
): IntrinsicCapacityWarmPrefixLaneTrace {
  return {
    ...wire,
    endpoint: wire.endpoint === undefined ? undefined : toIntrinsicCapacityObjective(wire.endpoint)
  }
}

type WireIntrinsicCapacityCohesionShadowTrace = Omit<
  IntrinsicCapacityCohesionShadowTrace,
  'endpoint' | 'retentionDepths'
> & {
  readonly endpoint: WireIntrinsicCapacityObjective | undefined
  readonly retentionDepths:
    | ReadonlyArray<WireIntrinsicCapacityTopologyRetentionDepthTrace>
    | undefined
}

function toIntrinsicCapacityCohesionShadowTrace(
  wire: WireIntrinsicCapacityCohesionShadowTrace
): IntrinsicCapacityCohesionShadowTrace {
  return {
    ...wire,
    endpoint: wire.endpoint === undefined ? undefined : toIntrinsicCapacityObjective(wire.endpoint),
    retentionDepths: wire.retentionDepths?.map(toIntrinsicCapacityTopologyRetentionDepthTrace)
  }
}

type WireIntrinsicCapacityQualityWarmPrefixTrace = Omit<
  IntrinsicCapacityQualityWarmPrefixTrace,
  'endpoint'
> & {
  readonly endpoint: WireIntrinsicCapacityObjective | undefined
}

function toIntrinsicCapacityQualityWarmPrefixTrace(
  wire: WireIntrinsicCapacityQualityWarmPrefixTrace
): IntrinsicCapacityQualityWarmPrefixTrace {
  return {
    ...wire,
    endpoint: wire.endpoint === undefined ? undefined : toIntrinsicCapacityObjective(wire.endpoint)
  }
}

type WireIntrinsicCapacitySelectionTrace = WireBigInt<
  IntrinsicCapacitySelectionTrace,
  'placedDoubledMaterialAreaGrid2'
>

function toIntrinsicCapacitySelectionTrace(
  wire: WireIntrinsicCapacitySelectionTrace
): IntrinsicCapacitySelectionTrace {
  return {
    ...wire,
    placedDoubledMaterialAreaGrid2: BigInt(wire.placedDoubledMaterialAreaGrid2)
  }
}

type WireIntrinsicCapacityPreflightMeasurements = WireBigInt<
  IntrinsicCapacityPreflightMeasurements,
  | 'sheetDoubledAreaGrid2'
  | 'minimumDoubledCollisionAreaSumGrid2'
  | 'minimumCollisionAreaPressurePpm'
  | 'maximumSingletonSpanPressurePpm'
>

function toIntrinsicCapacityPreflightMeasurements(
  wire: WireIntrinsicCapacityPreflightMeasurements
): IntrinsicCapacityPreflightMeasurements {
  return {
    ...wire,
    sheetDoubledAreaGrid2: BigInt(wire.sheetDoubledAreaGrid2),
    minimumDoubledCollisionAreaSumGrid2: BigInt(wire.minimumDoubledCollisionAreaSumGrid2),
    minimumCollisionAreaPressurePpm: BigInt(wire.minimumCollisionAreaPressurePpm),
    maximumSingletonSpanPressurePpm: BigInt(wire.maximumSingletonSpanPressurePpm)
  }
}

type WireIntrinsicCapacityPreflightOutcome =
  | {
      readonly kind: 'proven_impossible'
      readonly reason: 'singleton-transform-set-does-not-fit'
      readonly pieceId: string
      readonly measurements: WireIntrinsicCapacityPreflightMeasurements
    }
  | {
      readonly kind: 'proven_impossible'
      readonly reason: 'minimum-collision-area-exceeds-sheet-area'
      readonly measurements: WireIntrinsicCapacityPreflightMeasurements
    }
  | {
      readonly kind: 'inconclusive'
      readonly measurements: WireIntrinsicCapacityPreflightMeasurements
    }

function toIntrinsicCapacityPreflightOutcome(
  wire: WireIntrinsicCapacityPreflightOutcome
): IntrinsicCapacityPreflightOutcome {
  const measurements = toIntrinsicCapacityPreflightMeasurements(wire.measurements)
  if (wire.kind === 'inconclusive') {
    return { kind: 'inconclusive', measurements }
  }
  if (wire.reason === 'singleton-transform-set-does-not-fit') {
    return {
      kind: 'proven_impossible',
      reason: wire.reason,
      pieceId: PieceId.make(wire.pieceId),
      measurements
    }
  }
  return { kind: 'proven_impossible', reason: wire.reason, measurements }
}

type WireIntrinsicCapacityTrace = Omit<
  IntrinsicCapacityTrace,
  | 'preflight'
  | 'coldSearch'
  | 'warmPrefixLanes'
  | 'cohesionShadow'
  | 'qualityWarmPrefix'
  | 'selected'
> & {
  readonly preflight: WireIntrinsicCapacityPreflightOutcome
  readonly coldSearch: WireIntrinsicCapacitySearchTrace
  readonly warmPrefixLanes: ReadonlyArray<WireIntrinsicCapacityWarmPrefixLaneTrace> | undefined
  readonly cohesionShadow: WireIntrinsicCapacityCohesionShadowTrace | undefined
  readonly qualityWarmPrefix: WireIntrinsicCapacityQualityWarmPrefixTrace | undefined
  readonly selected: WireIntrinsicCapacitySelectionTrace
}

/** `boundary::result`'s `capacity_trace` wire shape -> the real `IntrinsicCapacityTrace`. */
function toIntrinsicCapacityTrace(wire: WireIntrinsicCapacityTrace): IntrinsicCapacityTrace {
  return {
    ...wire,
    preflight: toIntrinsicCapacityPreflightOutcome(wire.preflight),
    coldSearch: toIntrinsicCapacitySearchTrace(wire.coldSearch),
    warmPrefixLanes: wire.warmPrefixLanes?.map(toIntrinsicCapacityWarmPrefixLaneTrace),
    cohesionShadow:
      wire.cohesionShadow === undefined
        ? undefined
        : toIntrinsicCapacityCohesionShadowTrace(wire.cohesionShadow),
    qualityWarmPrefix:
      wire.qualityWarmPrefix === undefined
        ? undefined
        : toIntrinsicCapacityQualityWarmPrefixTrace(wire.qualityWarmPrefix),
    selected: toIntrinsicCapacitySelectionTrace(wire.selected)
  } as IntrinsicCapacityTrace
}

/**
 * The remaining four traces carry no `bigint` field
 * (`intrinsicAnytimeSchedulerTrace`/`focusedCompleteReconstructionTrace`:
 * verified against `computeIrregularNesting.ts:185-226`;
 * `intrinsicShortSideObserverTrace`/`intrinsicShortSidePairFoldTrace`: every
 * `*Grid2` field in `intrinsicShortSideObserver.ts`/
 * `intrinsicShortSidePairFoldObserver.ts` is already TS `string`, never
 * `bigint`) -- `JSON.parse`'s own output already has the right runtime
 * shape, so decoding is a direct, honest cast, not a fabrication (Rust's
 * `Serialize` derive on each real trace struct, field-for-field verified
 * against these same TS sources, is what actually guarantees the shape).
 */
function toIntrinsicAnytimeSchedulerTrace(wire: unknown): IntrinsicAnytimeSchedulerTrace {
  return wire as IntrinsicAnytimeSchedulerTrace
}

function toIntrinsicFocusedCompleteReconstructionTrace(
  wire: unknown
): IntrinsicFocusedCompleteReconstructionTrace {
  return wire as IntrinsicFocusedCompleteReconstructionTrace
}

function toIntrinsicShortSideObserverTrace(wire: unknown): IntrinsicShortSideObserverTrace {
  return wire as IntrinsicShortSideObserverTrace
}

function toIntrinsicShortSidePairFoldTrace(wire: unknown): IntrinsicShortSidePairFoldTrace {
  return wire as IntrinsicShortSidePairFoldTrace
}

/** The five optional trace fields as they appear on the raw wire envelope result. */
interface NativeTraceFieldsJson {
  readonly capacityTrace?: WireIntrinsicCapacityTrace
  readonly intrinsicAnytimeSchedulerTrace?: unknown
  readonly focusedCompleteReconstructionTrace?: unknown
  readonly intrinsicShortSideObserverTrace?: unknown
  readonly intrinsicShortSidePairFoldTrace?: unknown
}

/**
 * Reconstructs the five trace fields onto `result`. `raw` is the same
 * envelope-result value `decodeNativeComputeResult` decodes the rest of
 * `IrregularComputeResult` from -- `Schema.decodeUnknownSync` on the
 * narrower `NativeIrregularComputeResultSchema` silently ignores these five
 * unrecognized wire keys (this module's own established convention, see
 * `encodeNativeRequestJson`'s doc comment), so they are read directly off
 * `raw` here instead.
 */
function withNativeTraces(
  result: IrregularComputeResult,
  raw: NativeTraceFieldsJson
): IrregularComputeResult {
  return {
    ...result,
    ...(raw.capacityTrace !== undefined
      ? { capacityTrace: toIntrinsicCapacityTrace(raw.capacityTrace) }
      : {}),
    ...(raw.intrinsicAnytimeSchedulerTrace !== undefined
      ? {
          intrinsicAnytimeSchedulerTrace: toIntrinsicAnytimeSchedulerTrace(
            raw.intrinsicAnytimeSchedulerTrace
          )
        }
      : {}),
    ...(raw.focusedCompleteReconstructionTrace !== undefined
      ? {
          focusedCompleteReconstructionTrace: toIntrinsicFocusedCompleteReconstructionTrace(
            raw.focusedCompleteReconstructionTrace
          )
        }
      : {}),
    ...(raw.intrinsicShortSideObserverTrace !== undefined
      ? {
          intrinsicShortSideObserverTrace: toIntrinsicShortSideObserverTrace(
            raw.intrinsicShortSideObserverTrace
          )
        }
      : {}),
    ...(raw.intrinsicShortSidePairFoldTrace !== undefined
      ? {
          intrinsicShortSidePairFoldTrace: toIntrinsicShortSidePairFoldTrace(
            raw.intrinsicShortSidePairFoldTrace
          )
        }
      : {})
  }
}

// ===========================================================================
// Result decoding (the crate's `NativeIrregularComputeResult` wire shape,
// the package's native result projection, -> TS
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
  stepIndex: Schema.Number,
  beamRank: Schema.Number,
  candidateCount: Schema.Number,
  source: Schema.optional(Schema.Literals(['beam', 'shared-archive'])),
  placements: Schema.Array(IrregularPlacedPieceSchema),
  remainingPreparedPieces: Schema.Array(IrregularPreparedPieceSchema),
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

/** Reconstructs the complete state snapshot, including the exact pending queue. */
function toIrregularStateSnapshot(dto: NativeStateSnapshotDto): IrregularStateSnapshot {
  const placedCollisionGeometries = dto.placements.map((placed) => new IrregularPlacedPiece(placed))
  const placementOrder = placedCollisionGeometries.map(
    (placed) => placed.placement.pieceId ?? placed.placement.sourcePieceId
  )
  const state = new IrregularBeamState({
    remainingPreparedPieces: dto.remainingPreparedPieces.map(
      (piece) => new IrregularPreparedPiece(piece)
    ),
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
  const result: IrregularComputeResult = {
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
  }
  // See module doc, "Trace fidelity", and `withNativeTraces`'s own doc
  // comment for why these five fields are read off `raw` directly rather
  // than through `NativeIrregularComputeResultSchema`.
  return withNativeTraces(result, raw as NativeTraceFieldsJson)
}

/** Validates a successful raw N-API result envelope before it is archived. */
export function validateNativeIrregularResultEnvelope(value: unknown): void {
  if (typeof value !== 'object' || value === null) {
    throw new Error('native result envelope must be an object')
  }
  const envelope = value as NativeEnvelope
  if (envelope.ok !== true || envelope.result === undefined) {
    throw new Error('native result envelope must be successful and contain a result')
  }
  decodeNativeComputeResult(envelope.result)
}

// ===========================================================================
// Unified streamed event channel (`boundary::events`'s `NativeIrregularEvent`).
// ===========================================================================

const NativeIrregularEventSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('portfolio-progress'),
    ordinal: Schema.Number,
    progress: IrregularPortfolioProgress
  }),
  Schema.Struct({
    kind: Schema.Literal('state-snapshot'),
    ordinal: Schema.Number,
    snapshot: NativeStateSnapshotSchema,
    beamWidth: Schema.Number
  }),
  Schema.Struct({
    kind: Schema.Literal('terminal'),
    ordinal: Schema.Number
  })
])
type NativeIrregularEvent = Schema.Schema.Type<typeof NativeIrregularEventSchema>

/** Validates the complete native event sequence retained in a parity capture. */
export function validateNativeIrregularEventSequence(events: ReadonlyArray<unknown>): void {
  if (events.length === 0) throw new Error('native event sequence must not be empty')
  for (const [index, value] of events.entries()) {
    const event = Schema.decodeUnknownSync(NativeIrregularEventSchema)(value)
    if (!Number.isSafeInteger(event.ordinal) || event.ordinal !== index) {
      throw new Error('native event ordinals must be contiguous from zero')
    }
    if (event.kind === 'terminal' && index !== events.length - 1) {
      throw new Error('native terminal event must be last')
    }
  }
  const terminal = events.at(-1)
  if (
    typeof terminal !== 'object' ||
    terminal === null ||
    !('kind' in terminal) ||
    terminal.kind !== 'terminal'
  ) {
    throw new Error('native event sequence must end with a terminal event')
  }
}

type EventChannelState = 'open' | 'terminal-seen' | 'closed'

export interface NativeIrregularJobTransport {
  readonly run: (
    requestJson: string,
    invocationToken: string,
    onEvent: (json: string) => void,
    emitStateSnapshots: boolean
  ) => Promise<string>
  readonly cancel: (invocationToken: string, reason: WorkerCancellationReason) => boolean
}

interface NativeEventDispatcher {
  readonly onEvent: (json: string) => void
  readonly drain: () => Promise<void>
  readonly close: () => void
  readonly failure: () => WorkerResponseFailureError | undefined
  readonly terminalSeen: () => boolean
}

interface NativeEnvelope {
  readonly ok: boolean
  readonly result?: unknown
  readonly error?: NativeBoundaryErrorJson
}

function nativeEventFailure(
  operation: string,
  context: Readonly<Record<string, unknown>> = {}
): WorkerResponseFailureError {
  return protocolFailure('native irregular event channel failed', { operation, ...context })
}

function decodedEventKind(json: string): string | undefined {
  try {
    const value: unknown = JSON.parse(json)
    if (
      typeof value === 'object' &&
      value !== null &&
      'kind' in value &&
      typeof value.kind === 'string'
    ) {
      return value.kind
    }
  } catch {
    return undefined
  }
  return undefined
}

function createNativeEventDispatcher(
  options: NativeIrregularBackendOptions | undefined
): NativeEventDispatcher {
  let expectedOrdinal = 0
  const requiresContiguousOrdinals = options?.emitStateSnapshot !== undefined
  let state: EventChannelState = 'open'
  let terminalOrdinal: number | undefined
  let firstFailure: WorkerResponseFailureError | undefined
  let externalCallbacksStopped = false
  let tail = Promise.resolve()

  const fail = (error: WorkerResponseFailureError): void => {
    externalCallbacksStopped = true
    if (firstFailure === undefined) firstFailure = error
  }

  const append = (operation: () => Promise<void> | void, eventKind: string): void => {
    tail = tail.then(async () => {
      if (externalCallbacksStopped) return
      try {
        await operation()
      } catch {
        fail(nativeEventFailure('nativeEventCallback', { eventKind }))
      }
    })
  }

  const emitPortfolioProgress =
    options?.emitPortfolioProgress === undefined
      ? undefined
      : (progress: IrregularPortfolioProgress) =>
          Effect.runPromise(options.emitPortfolioProgress?.(progress) ?? Effect.void)
  const emitStateSnapshot = options?.emitStateSnapshot

  return {
    onEvent: (json: string): void => {
      if (state === 'closed') return
      if (state === 'terminal-seen') {
        fail(
          nativeEventFailure('nativeEventAfterTerminal', {
            ...(decodedEventKind(json) === undefined ? {} : { eventKind: decodedEventKind(json) }),
            ...(terminalOrdinal === undefined ? {} : { terminalOrdinal })
          })
        )
        return
      }
      if (firstFailure !== undefined) return

      let event: NativeIrregularEvent
      try {
        event = Schema.decodeUnknownSync(NativeIrregularEventSchema)(JSON.parse(json))
      } catch {
        fail(nativeEventFailure('nativeEventDecode', { nativeEventFailure: 'decode' }))
        return
      }

      if (
        !Number.isSafeInteger(event.ordinal) ||
        event.ordinal < 0 ||
        (requiresContiguousOrdinals
          ? event.ordinal !== expectedOrdinal
          : event.ordinal < expectedOrdinal)
      ) {
        fail(
          nativeEventFailure('nativeEventOrdinal', {
            expectedOrdinal,
            receivedOrdinal: event.ordinal,
            eventKind: event.kind
          })
        )
        return
      }
      expectedOrdinal = event.ordinal + 1

      switch (event.kind) {
        case 'portfolio-progress':
          if (emitPortfolioProgress !== undefined) {
            append(() => emitPortfolioProgress(event.progress), event.kind)
          }
          return
        case 'state-snapshot':
          if (emitStateSnapshot !== undefined) {
            append(
              () => emitStateSnapshot(toIrregularStateSnapshot(event.snapshot), event.beamWidth),
              event.kind
            )
          }
          return
        case 'terminal':
          state = 'terminal-seen'
          terminalOrdinal = event.ordinal
      }
    },
    drain: () => tail,
    close: () => {
      state = 'closed'
    },
    failure: () => firstFailure,
    terminalSeen: () => terminalOrdinal !== undefined
  }
}

// ===========================================================================
// The adapter itself.
// ===========================================================================

/**
 * Runs one archive-eligible job on the native backend. Mirrors
 * `computeIrregularNesting`'s contract and waits for the terminal event before
 * exposing either a native result or a mapped native domain error.
 */
export function computeIrregularNestingNative(
  request: NestingRequest,
  geometrySettings: IrregularNestingSettings,
  options?: NativeIrregularBackendOptions
): Effect.Effect<IrregularComputeResult, WorkerResponseFailureError> {
  return Effect.gen(function* () {
    const probe = probeNativeIrregularAddon()
    if (!probe.available) return yield* Effect.fail(addonUnavailableFailure(probe))

    const addon = yield* Effect.try({
      try: () => loadNativeIrregularAddon(),
      catch: (cause) =>
        protocolFailure(`irregular-nesting-native addon failed to load: ${describeError(cause)}`, {
          requestedBackend: 'rust'
        })
    })
    return yield* computeIrregularNestingNativeWithTransportForTests(
      {
        run: (requestJson, invocationToken, onEvent, emitStateSnapshots) =>
          addon.runIrregularJob(requestJson, invocationToken, onEvent, emitStateSnapshots),
        cancel: (invocationToken, reason) => addon.cancelIrregularJob(invocationToken, reason)
      },
      request,
      geometrySettings,
      options
    )
  })
}

/** Test-only transport seam for deterministic event-channel lifecycle coverage. */
export function computeIrregularNestingNativeWithTransportForTests(
  transport: NativeIrregularJobTransport,
  request: NestingRequest,
  geometrySettings: IrregularNestingSettings,
  options?: NativeIrregularBackendOptions
): Effect.Effect<IrregularComputeResult, WorkerResponseFailureError> {
  return Effect.gen(function* () {
    const requestJson = yield* Effect.try({
      try: () => encodeNativeRequestJson(request, geometrySettings),
      catch: (cause) =>
        protocolFailure(
          `failed to encode NestingRequest for the native backend: ${describeError(cause)}`,
          { requestedBackend: 'rust' }
        )
    })
    const invocationToken = randomUUID()
    const dispatcher = createNativeEventDispatcher(options)
    let cancelPollTimer: ReturnType<typeof setInterval> | undefined
    let cancellationPollingStopped = false
    const stopCancellationPolling = (): void => {
      if (cancellationPollingStopped) return
      cancellationPollingStopped = true
      if (cancelPollTimer !== undefined) {
        clearInterval(cancelPollTimer)
        cancelPollTimer = undefined
      }
    }
    const isCancelled = options?.isCancelled
    if (isCancelled !== undefined && options?.registerNativeCancellation === undefined) {
      cancelPollTimer = setInterval(() => {
        if (isCancelled()) {
          transport.cancel(invocationToken, 'cancelled')
          stopCancellationPolling()
        }
      }, isCancelledPollIntervalMs)
    }

    const transportOutcome = yield* Effect.promise(async () => {
      try {
        const runPromise = transport.run(
          requestJson,
          invocationToken,
          dispatcher.onEvent,
          options?.emitStateSnapshot !== undefined
        )
        options?.registerNativeCancellation?.((reason) => {
          transport.cancel(invocationToken, reason)
        })
        return {
          ok: true as const,
          envelopeJson: await runPromise
        }
      } catch (cause) {
        return { ok: false as const, cause }
      } finally {
        stopCancellationPolling()
      }
    })

    const envelopeOutcome = transportOutcome.ok
      ? (() => {
          try {
            return {
              ok: true as const,
              envelope: JSON.parse(transportOutcome.envelopeJson) as NativeEnvelope
            }
          } catch {
            return { ok: false as const }
          }
        })()
      : undefined

    yield* Effect.promise(() => dispatcher.drain())
    dispatcher.close()

    const callbackFailure = dispatcher.failure()
    if (callbackFailure !== undefined) return yield* Effect.fail(callbackFailure)

    if (!transportOutcome.ok) {
      return yield* Effect.fail(
        protocolFailure(
          `irregular-nesting-native runIrregularJob rejected unexpectedly: ${describeError(transportOutcome.cause)}`,
          { operation: 'nativeTransport', requestedBackend: 'rust' }
        )
      )
    }
    if (envelopeOutcome?.ok !== true) {
      return yield* Effect.fail(
        protocolFailure(
          'irregular-nesting-native returned a response that did not parse as JSON.',
          {
            operation: 'nativeEnvelopeDecode',
            requestedBackend: 'rust'
          }
        )
      )
    }

    const envelope = envelopeOutcome.envelope
    if (!envelope.ok && envelope.error?.operation === 'nativeEventDelivery') {
      return yield* Effect.fail(mapNativeErrorToWorkerFailure(envelope.error))
    }
    if (!dispatcher.terminalSeen()) {
      return yield* Effect.fail(nativeEventFailure('nativeEventTerminal'))
    }
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
