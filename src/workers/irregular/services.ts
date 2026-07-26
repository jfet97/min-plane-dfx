import { Context, Data, Effect, Layer, Schema } from 'effect'
import type { ImportedPiece } from '@shared/domain/dxf.js'
import type { PieceId } from '@shared/domain/ids.js'
import { SheetSpec } from '@shared/domain/nesting.js'
import type {
  IrregularGeometryCacheKey,
  IrregularIfpBounds,
  IrregularNestingSettings,
  IrregularNfp,
  IrregularPlacementCandidate,
  IrregularPortfolioProgress,
  IrregularPortfolioResult,
  IrregularPreparedPiece,
  IrregularTransformCandidate,
  TransformedCollisionGeometry
} from '@shared/irregular/domain.js'
import type { IrregularBeamState } from '../algorithm/irregular/irregularBeamState.js'
import type { EmitIrregularDecisionTrace } from '../algorithm/irregular/decisionTrace.js'
import * as NfpIfpTelemetry from './nfpIfpTelemetry.js'
import type { PlacedCollisionSpatialIndex } from './placedCollisionSpatialIndex.js'
import {
  CollisionGeometry,
  FreeMaterialSnapshot,
  IrregularGeometrySettings,
  IrregularOptimizerSettings,
  IrregularPlacedPiece,
  IrregularPolygon,
  NonNegativeFiniteMillimeters
} from '@shared/irregular/domain.js'

export class IrregularNestingNotImplementedError extends Data.TaggedError(
  'IrregularNestingNotImplementedError'
)<{
  readonly service: string
  readonly operation: string
  readonly message: string
}> {}

export class IrregularGeometryInputError extends Data.TaggedError('IrregularGeometryInputError')<{
  readonly operation: string
  readonly message: string
}> {}

export class IrregularGeometryInfeasibleError extends Data.TaggedError(
  'IrregularGeometryInfeasibleError'
)<{
  readonly operation: string
  readonly message: string
}> {}

/** Typed failure raised when the portfolio cannot complete a real decoder step. */
export class IrregularPortfolioError extends Data.TaggedError('IrregularPortfolioError')<{
  readonly operation: string
  readonly category: 'geometry' | 'scoring' | 'search'
  readonly message: string
}> {}

/** internal NFP-only abort signal; this is not the worker supervisor contract. */
export class IrregularNfpIfpControlAbortError extends Data.TaggedError(
  'IrregularNfpIfpControlAbortError'
)<{
  readonly reason: 'deadline' | 'cancelled'
  readonly message: string
}> {}

/** typed cooperative checkpoint supplied only through the NFP service interface. */
export type IrregularNfpIfpCheckpointPhase =
  | 'ifp'
  | 'placed-nfp'
  | 'ifp-boundary-intersection'
  | 'pairwise-nfp-boundary-intersection'
  | 'candidate-points'

export interface IrregularNfpIfpControl {
  readonly checkpoint: (
    phase: IrregularNfpIfpCheckpointPhase
  ) => Effect.Effect<void, IrregularNfpIfpControlAbortError>
}

export interface FlattenSourceGeometryInput {
  readonly piece: ImportedPiece
}

export interface BuildCollisionGeometryInput {
  readonly piece: ImportedPiece
  readonly totalPaddingMm: number
}

/**
 * Decoded boundary for deriving a collision offset from a prepared nesting
 * request. Padding remains a finite non-negative millimeter distance before the
 * kernel adds its fractional safety margin.
 */
export const OffsetConvexPolygonInput = Schema.Struct({
  polygon: IrregularPolygon,
  totalPaddingMm: NonNegativeFiniteMillimeters
})
export type OffsetConvexPolygonInput = Schema.Schema.Type<typeof OffsetConvexPolygonInput>

export interface TransformCollisionGeometryInput {
  readonly geometry: CollisionGeometry
  readonly transform: IrregularTransformCandidate
}

/** Schema-backed boundary for finite transform generation. */
export const GenerateTransformsInput = Schema.Struct({
  geometry: CollisionGeometry,
  allowRotation: Schema.Boolean,
  allowMirror: Schema.Boolean,
  geometrySettings: IrregularGeometrySettings,
  settings: IrregularOptimizerSettings
})
export type GenerateTransformsInput = Schema.Schema.Type<typeof GenerateTransformsInput>

export interface ComputeNfpInput {
  /** Fixed collision geometry together with its existing sheet translation. */
  readonly fixed: IrregularPlacedPiece
  /** Moving collision geometry still expressed around its own placement origin. */
  readonly moving: TransformedCollisionGeometry
  readonly settings: IrregularNestingSettings['geometry']
}

export interface ComputeIfpBoundsInput {
  readonly sheet: SheetSpec
  readonly moving: TransformedCollisionGeometry
}

/** Finite geometry families that can contribute one raw NFP/IFP contact point. */
export const NFP_IFP_CANDIDATE_SOURCE_MASK = {
  ifpCorner: 1,
  nfpVertex: 2,
  antiparallelEdgeSupport: 4,
  ifpNfpIntersection: 8,
  nfpNfpIntersection: 16
} as const

export type NfpIfpCandidateSource = keyof typeof NFP_IFP_CANDIDATE_SOURCE_MASK

/** Compact source observation for a legal candidate after canonical grid admission. */
export interface NfpIfpLegalCandidateSource {
  readonly gridX: number
  readonly gridY: number
  readonly sourceMask: number
}

/**
 * Observer-only candidate provenance. It deliberately describes generator
 * admission, not a scorer, fanout, or terminal selection decision.
 */
export interface NfpIfpCandidateProvenance {
  readonly rawBySource: Readonly<Record<NfpIfpCandidateSource, number>>
  readonly uniqueBySourceMask: ReadonlyArray<{
    readonly sourceMask: number
    readonly count: number
  }>
  readonly outsideIfp: number
  readonly nfpInteriorRejected: number
  readonly liveConvexRejected: number
  readonly liveConvexLegal: number
  readonly phaseIncompatible: number | 'not-evaluated'
  readonly canonicalChecked: number | 'not-evaluated'
  readonly canonicalLegal: number | 'not-evaluated'
  readonly legalCandidateSources: ReadonlyArray<NfpIfpLegalCandidateSource>
}

export interface GeneratePlacementCandidatesInput {
  readonly sheet: SheetSpec
  readonly placed: ReadonlyArray<IrregularPlacedPiece>
  readonly placedCollisionIndex?: PlacedCollisionSpatialIndex
  readonly moving: TransformedCollisionGeometry
  readonly settings: IrregularNestingSettings
  /** Selects the sheet-boundary pool or one of the intrinsic NFP candidate pools. */
  readonly candidateDomain?: 'sheet' | 'contact-only' | 'sheetless-nfp'
  readonly candidateMemoScope?: IrregularNfpIfpCandidateMemoScope
  /** Optional observer for experiment traces; it cannot alter candidate admission. */
  readonly onCandidateProvenance?: (provenance: NfpIfpCandidateProvenance) => void
  readonly control?: IrregularNfpIfpControl
}

const IRREGULAR_NFP_IFP_CANDIDATE_MEMO_SCOPE_IDENTITY = Symbol()

/** Opaque identity that bounds legal-candidate memo entries to one decoder invocation. */
export class IrregularNfpIfpCandidateMemoScope {
  readonly [IRREGULAR_NFP_IFP_CANDIDATE_MEMO_SCOPE_IDENTITY] = true
}

/** Candidate input whose caller has proved that no cooperative control exists. */
export type GeneratePlacementCandidatesInputWithoutControl = Omit<
  GeneratePlacementCandidatesInput,
  'control'
> & {
  readonly control?: never
}

export interface ValidatePlacementInput {
  readonly sheet: SheetSpec
  readonly placed: ReadonlyArray<IrregularPlacedPiece>
  readonly placedCollisionIndex?: PlacedCollisionSpatialIndex
  /** Moving polygon expressed around the same placement origin as `candidate.point`. */
  readonly moving: TransformedCollisionGeometry
  readonly candidate: IrregularPlacementCandidate
}

/**
 * Internal input for deriving sheet-space free-material diagnostics.
 *
 * This is a worker-internal service call, not an untrusted boundary: the sheet
 * and settings were decoded on entry and the placed geometry was produced by
 * the search itself. It is therefore a plain interface, and the service no
 * longer redecodes it per call.
 */
export interface ComputeFreeMaterialInput {
  readonly sheet: SheetSpec
  readonly placed: ReadonlyArray<IrregularPlacedPiece>
  readonly settings: IrregularGeometrySettings
}

/** Internal input for subtracting one new placement from cached material. */
export interface ExtendFreeMaterialInput {
  readonly parent: FreeMaterialSnapshot
  readonly placed: IrregularPlacedPiece
  readonly settings: IrregularGeometrySettings
}

export interface BuildPriorityOrderInput {
  readonly pieces: ReadonlyArray<IrregularPreparedPiece>
  readonly settings: IrregularNestingSettings['optimizer']
}

export interface RunPortfolioInput {
  readonly sheet: SheetSpec
  readonly pieces: ReadonlyArray<IrregularPreparedPiece>
  readonly onProgress?: (progress: IrregularPortfolioProgress) => Effect.Effect<void>
  readonly onStateSnapshot?: (
    snapshot: {
      readonly stepIndex: number
      readonly beamRank: number
      readonly candidateCount: number
      readonly state: IrregularBeamState
    },
    beamWidth: number
  ) => void
  readonly emitDecisionTrace?: EmitIrregularDecisionTrace
  /** Optional outer-role namespace preventing trace decode-id collisions. */
  readonly decisionTraceDecodeIdPrefix?: string
  /** Private algorithm seam retaining the exact selected legal terminal state. */
  readonly onSelectedState?: (state: IrregularBeamState) => void
  readonly isCancelled?: () => boolean
}

export interface TransformGenerator {
  /**
   * Produces the finite rotation and mirror choices permitted for one prepared
   * collision shape. It does not place the shape or evaluate a nesting score.
   */
  readonly generateTransforms: (
    input: GenerateTransformsInput
  ) => Effect.Effect<
    ReadonlyArray<IrregularTransformCandidate>,
    IrregularNestingNotImplementedError | IrregularGeometryInputError
  >
}

export interface NfpIfpService {
  /**
   * Computes the no-fit boundary of translations where `moving` would overlap
   * `fixed`; callers use it to propose collision-free candidate positions.
   */
  readonly computeNfp: (
    input: ComputeNfpInput
  ) => Effect.Effect<
    IrregularNfp,
    IrregularNestingNotImplementedError | IrregularGeometryInputError
  >
  /**
   * Computes the rectangular translation bounds that keep `moving` inside the
   * rectangular sheet before considering any already placed pieces.
   */
  readonly computeIfpBounds: (
    input: ComputeIfpBoundsInput
  ) => Effect.Effect<
    IrregularIfpBounds,
    | IrregularNestingNotImplementedError
    | IrregularGeometryInputError
    | IrregularGeometryInfeasibleError
  >
  /**
   * Produces deterministic candidate placements from sheet bounds and placed
   * collision geometry; legality remains a later direct validation step.
   */
  readonly generatePlacementCandidates: {
    (
      input: GeneratePlacementCandidatesInput & { readonly control: IrregularNfpIfpControl }
    ): Effect.Effect<
      ReadonlyArray<IrregularPlacementCandidate>,
      | IrregularNestingNotImplementedError
      | IrregularGeometryInputError
      | IrregularNfpIfpControlAbortError
    >
    (
      input: GeneratePlacementCandidatesInputWithoutControl
    ): Effect.Effect<
      ReadonlyArray<IrregularPlacementCandidate>,
      IrregularNestingNotImplementedError | IrregularGeometryInputError
    >
    (
      input: GeneratePlacementCandidatesInput
    ): Effect.Effect<
      ReadonlyArray<IrregularPlacementCandidate>,
      | IrregularNestingNotImplementedError
      | IrregularGeometryInputError
      | IrregularNfpIfpControlAbortError
    >
  }
}

export interface FreeMaterialService {
  /**
   * Derives optional remaining-sheet material for visualization and scoring;
   * it is not proof that any particular moving piece can be placed there.
   */
  readonly computeFreeMaterial: (
    input: ComputeFreeMaterialInput
  ) => Effect.Effect<
    FreeMaterialSnapshot,
    IrregularNestingNotImplementedError | IrregularGeometryInputError
  >
  /** Subtracts one newly placed collision polygon from a cached material snapshot. */
  readonly extendFreeMaterial: (
    input: ExtendFreeMaterialInput
  ) => Effect.Effect<
    FreeMaterialSnapshot,
    IrregularNestingNotImplementedError | IrregularGeometryInputError
  >
}

export interface PriorityOrderService {
  /**
   * Builds the deterministic priority order used to seed the irregular search
   * without generating placements or scores itself.
   */
  readonly buildPriorityOrder: (
    input: BuildPriorityOrderInput
  ) => Effect.Effect<
    ReadonlyArray<PieceId>,
    IrregularNestingNotImplementedError | IrregularGeometryInputError
  >
}

export interface IrregularNestingPortfolio {
  /**
   * Runs the bounded irregular search portfolio and returns only a worker-owned
   * result with its reported progress and diagnostics.
   */
  readonly run: (
    input: RunPortfolioInput
  ) => Effect.Effect<
    IrregularPortfolioResult,
    IrregularNestingNotImplementedError | IrregularPortfolioError
  >
}

export interface GeometryCache {
  /** Returns one derived artifact for its complete geometry cache identity. */
  readonly get: <A>(key: IrregularGeometryCacheKey) => Effect.Effect<A | undefined>
  /** Stores one derived artifact under its complete geometry cache identity. */
  readonly set: <A>(key: IrregularGeometryCacheKey, value: A) => Effect.Effect<void>
  /** Removes one derived artifact without affecting unrelated cache entries. */
  readonly remove: (key: IrregularGeometryCacheKey) => Effect.Effect<void>
  /** Removes every in-memory derived artifact for the current worker process. */
  readonly clear: Effect.Effect<void>
}

export const TransformGenerator = Context.Service<TransformGenerator>(
  'min-plane-dfx/irregular/TransformGenerator'
)
export const NfpIfpService = Context.Service<NfpIfpService>('min-plane-dfx/irregular/NfpIfpService')
export const FreeMaterialService = Context.Service<FreeMaterialService>(
  'min-plane-dfx/irregular/FreeMaterialService'
)
export const PriorityOrderService = Context.Service<PriorityOrderService>(
  'min-plane-dfx/irregular/PriorityOrderService'
)
export const IrregularNestingPortfolio = Context.Service<IrregularNestingPortfolio>(
  'min-plane-dfx/irregular/IrregularNestingPortfolio'
)
export const GeometryCache = Context.Service<GeometryCache>('min-plane-dfx/irregular/GeometryCache')

function failNotImplemented(
  service: string,
  operation: string
): Effect.Effect<never, IrregularNestingNotImplementedError> {
  return Effect.fail(
    new IrregularNestingNotImplementedError({
      service,
      operation,
      message: `${service}.${operation} is intentionally unimplemented.`
    })
  )
}

export function cacheKeyToString(key: IrregularGeometryCacheKey): string {
  return JSON.stringify([key.namespace, key.parts])
}

export const TransformGeneratorUnimplemented = Layer.succeed(TransformGenerator, {
  generateTransforms: () => failNotImplemented('TransformGenerator', 'generateTransforms')
})

export const NfpIfpServiceUnimplemented = Layer.succeed(NfpIfpService, {
  computeNfp: () => failNotImplemented('NfpIfpService', 'computeNfp'),
  computeIfpBounds: () => failNotImplemented('NfpIfpService', 'computeIfpBounds'),
  generatePlacementCandidates: () =>
    failNotImplemented('NfpIfpService', 'generatePlacementCandidates')
})

export const FreeMaterialServiceUnimplemented = Layer.succeed(FreeMaterialService, {
  computeFreeMaterial: () => failNotImplemented('FreeMaterialService', 'computeFreeMaterial'),
  extendFreeMaterial: () => failNotImplemented('FreeMaterialService', 'extendFreeMaterial')
})

/** Deterministic per-worker cache with no failure entries. */
export const GeometryCacheLive = Layer.sync(GeometryCache, () => {
  const cache = new Map<string, unknown>()
  NfpIfpTelemetry.recordCacheInstance()
  return {
    get: <A>(key: IrregularGeometryCacheKey) =>
      Effect.sync(() => {
        const entry = cache.get(cacheKeyToString(key)) as A | undefined
        NfpIfpTelemetry.recordCacheGet(key.namespace, entry !== undefined)
        return entry
      }),
    set: <A>(key: IrregularGeometryCacheKey, value: A) =>
      Effect.sync(() => {
        cache.set(cacheKeyToString(key), value)
        NfpIfpTelemetry.recordCacheSet(key.namespace)
      }),
    remove: (key: IrregularGeometryCacheKey) =>
      Effect.sync(() => {
        cache.delete(cacheKeyToString(key))
        NfpIfpTelemetry.recordCacheRemove(key.namespace)
      }),
    clear: Effect.sync(() => {
      cache.clear()
    })
  }
})

/** Backwards-compatible name for the real in-memory worker cache layer. */
export const GeometryCacheInMemory = GeometryCacheLive
