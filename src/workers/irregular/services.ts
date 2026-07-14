import { Context, Data, Effect, Layer, Schema } from 'effect'
import type { ImportedPiece } from '@shared/domain/dxf.js'
import type { PieceId } from '@shared/domain/ids.js'
import { NonNegativeIntegerMillimeters } from '@shared/domain/geometry.js'
import type { SheetSpec } from '@shared/domain/nesting.js'
import type {
  CollisionGeometry,
  FreeMaterialSnapshot,
  IrregularGeometryCacheKey,
  IrregularIfpBounds,
  IrregularNestingSettings,
  IrregularNfp,
  IrregularPlacedPiece,
  IrregularPlacementCandidate,
  IrregularPortfolioProgress,
  IrregularPortfolioResult,
  IrregularPreparedPiece,
  IrregularTransformCandidate,
  TransformedCollisionGeometry
} from '@shared/irregular/domain.js'
import { IrregularPolygon } from '@shared/irregular/domain.js'

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

export interface FlattenSourceGeometryInput {
  readonly piece: ImportedPiece
}

export interface BuildCollisionGeometryInput {
  readonly piece: ImportedPiece
  readonly totalPaddingMm: number
}

/**
 * Decoded boundary for deriving a collision offset from a prepared nesting
 * request. Padding is an integer millimeter value because it originates from
 * `NestingRequest.padding`, before the kernel adds its fractional safety margin.
 */
export const OffsetConvexPolygonInput = Schema.Struct({
  polygon: IrregularPolygon,
  totalPaddingMm: NonNegativeIntegerMillimeters
})
export type OffsetConvexPolygonInput = Schema.Schema.Type<typeof OffsetConvexPolygonInput>

export interface TransformCollisionGeometryInput {
  readonly geometry: CollisionGeometry
  readonly transform: IrregularTransformCandidate
}

export interface GenerateTransformsInput {
  readonly geometry: CollisionGeometry
  readonly allowMirror: boolean
  readonly settings: IrregularNestingSettings['optimizer']
}

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

export interface GeneratePlacementCandidatesInput {
  readonly sheet: SheetSpec
  readonly placed: ReadonlyArray<IrregularPlacedPiece>
  readonly moving: TransformedCollisionGeometry
  readonly settings: IrregularNestingSettings
}

export interface ValidatePlacementInput {
  readonly sheet: SheetSpec
  readonly placed: ReadonlyArray<IrregularPlacedPiece>
  /** Moving polygon expressed around the same placement origin as `candidate.point`. */
  readonly moving: TransformedCollisionGeometry
  readonly candidate: IrregularPlacementCandidate
}

export interface ComputeFreeMaterialInput {
  readonly sheet: SheetSpec
  readonly placed: ReadonlyArray<IrregularPlacedPiece>
  readonly settings: IrregularNestingSettings['geometry']
}

export interface BuildPriorityOrderInput {
  readonly pieces: ReadonlyArray<IrregularPreparedPiece>
  readonly settings: IrregularNestingSettings['optimizer']
}

export interface RunPortfolioInput {
  readonly sheet: SheetSpec
  readonly pieces: ReadonlyArray<IrregularPreparedPiece>
  readonly settings: IrregularNestingSettings
  readonly onProgress?: (progress: IrregularPortfolioProgress) => Effect.Effect<void>
}

export interface TransformGenerator {
  /**
   * Produces the finite rotation and mirror choices permitted for one prepared
   * collision shape. It does not place the shape or evaluate a nesting score.
   */
  readonly generateTransforms: (
    input: GenerateTransformsInput
  ) => Effect.Effect<ReadonlyArray<IrregularTransformCandidate>, IrregularNestingNotImplementedError>
}

export interface NfpIfpService {
  /**
   * Computes the no-fit boundary of translations where `moving` would overlap
   * `fixed`; callers use it to propose collision-free candidate positions.
   */
  readonly computeNfp: (
    input: ComputeNfpInput
  ) => Effect.Effect<IrregularNfp, IrregularNestingNotImplementedError | IrregularGeometryInputError>
  /**
   * Computes the rectangular translation bounds that keep `moving` inside the
   * rectangular sheet before considering any already placed pieces.
   */
  readonly computeIfpBounds: (
    input: ComputeIfpBoundsInput
  ) => Effect.Effect<
    IrregularIfpBounds,
    IrregularNestingNotImplementedError | IrregularGeometryInputError
  >
  /**
   * Produces deterministic candidate placements from sheet bounds and placed
   * collision geometry; legality remains a later direct validation step.
   */
  readonly generatePlacementCandidates: (
    input: GeneratePlacementCandidatesInput
  ) => Effect.Effect<
    ReadonlyArray<IrregularPlacementCandidate>,
    IrregularNestingNotImplementedError | IrregularGeometryInputError
  >
}

export interface FreeMaterialService {
  /**
   * Derives optional remaining-sheet material for visualization and scoring;
   * it is not proof that any particular moving piece can be placed there.
   */
  readonly computeFreeMaterial: (
    input: ComputeFreeMaterialInput
  ) => Effect.Effect<FreeMaterialSnapshot, IrregularNestingNotImplementedError>
}

export interface PriorityOrderService {
  /**
   * Builds the deterministic priority order used to seed the irregular search
   * without generating placements or scores itself.
   */
  readonly buildPriorityOrder: (
    input: BuildPriorityOrderInput
  ) => Effect.Effect<ReadonlyArray<PieceId>, IrregularNestingNotImplementedError>
}

export interface IrregularNestingPortfolio {
  /**
   * Runs the bounded irregular search portfolio and returns only a worker-owned
   * result with its reported progress and diagnostics.
   */
  readonly run: (
    input: RunPortfolioInput
  ) => Effect.Effect<IrregularPortfolioResult, IrregularNestingNotImplementedError>
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
export const NfpIfpService = Context.Service<NfpIfpService>(
  'min-plane-dfx/irregular/NfpIfpService'
)
export const FreeMaterialService = Context.Service<FreeMaterialService>(
  'min-plane-dfx/irregular/FreeMaterialService'
)
export const PriorityOrderService = Context.Service<PriorityOrderService>(
  'min-plane-dfx/irregular/PriorityOrderService'
)
export const IrregularNestingPortfolio = Context.Service<IrregularNestingPortfolio>(
  'min-plane-dfx/irregular/IrregularNestingPortfolio'
)
export const GeometryCache = Context.Service<GeometryCache>(
  'min-plane-dfx/irregular/GeometryCache'
)

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

function cacheKeyToString(key: IrregularGeometryCacheKey): string {
  return `${key.namespace}:${key.parts.join('|')}`
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
  computeFreeMaterial: () => failNotImplemented('FreeMaterialService', 'computeFreeMaterial')
})

export const PriorityOrderServiceUnimplemented = Layer.succeed(PriorityOrderService, {
  buildPriorityOrder: () => failNotImplemented('PriorityOrderService', 'buildPriorityOrder')
})

export const IrregularNestingPortfolioUnimplemented = Layer.succeed(IrregularNestingPortfolio, {
  run: () => failNotImplemented('IrregularNestingPortfolio', 'run')
})

export const GeometryCacheInMemory = Layer.sync(GeometryCache, () => {
  const cache = new Map<string, unknown>()
  return {
    get: <A>(key: IrregularGeometryCacheKey) =>
      Effect.sync(() => cache.get(cacheKeyToString(key)) as A | undefined),
    set: <A>(key: IrregularGeometryCacheKey, value: A) =>
      Effect.sync(() => {
        cache.set(cacheKeyToString(key), value)
      }),
    remove: (key: IrregularGeometryCacheKey) =>
      Effect.sync(() => {
        cache.delete(cacheKeyToString(key))
      }),
    clear: Effect.sync(() => {
      cache.clear()
    })
  }
})
