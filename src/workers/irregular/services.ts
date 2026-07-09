import { Context, Data, Effect, Layer } from 'effect'
import type { ImportedPiece } from '@shared/domain/dxf.js'
import type { PieceId } from '@shared/domain/ids.js'
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
  IrregularPolygon,
  IrregularPortfolioProgress,
  IrregularPortfolioResult,
  IrregularPreparedPiece,
  IrregularTransformCandidate,
  TransformedCollisionGeometry
} from '@shared/irregular/domain.js'

export class IrregularNestingNotImplementedError extends Data.TaggedError(
  'IrregularNestingNotImplementedError'
)<{
  readonly service: string
  readonly operation: string
  readonly message: string
}> {}

export interface FlattenSourceGeometryInput {
  readonly piece: ImportedPiece
}

export interface BuildCollisionGeometryInput {
  readonly piece: ImportedPiece
  readonly allowMirror: boolean
  readonly settings: IrregularNestingSettings
}

export interface OffsetConvexPolygonInput {
  readonly polygon: IrregularPolygon
  readonly distanceMm: number
}

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
  readonly fixed: TransformedCollisionGeometry
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

export interface CollisionGeometryBuilder {
  readonly buildPiece: (
    input: BuildCollisionGeometryInput
  ) => Effect.Effect<IrregularPreparedPiece, IrregularNestingNotImplementedError>
  readonly buildPieces: (
    input: ReadonlyArray<BuildCollisionGeometryInput>
  ) => Effect.Effect<ReadonlyArray<IrregularPreparedPiece>, IrregularNestingNotImplementedError>
}

export interface TransformGenerator {
  readonly generateTransforms: (
    input: GenerateTransformsInput
  ) => Effect.Effect<ReadonlyArray<IrregularTransformCandidate>, IrregularNestingNotImplementedError>
}

export interface NfpIfpService {
  readonly computeNfp: (
    input: ComputeNfpInput
  ) => Effect.Effect<IrregularNfp, IrregularNestingNotImplementedError>
  readonly computeIfpBounds: (
    input: ComputeIfpBoundsInput
  ) => Effect.Effect<IrregularIfpBounds, IrregularNestingNotImplementedError>
  readonly generatePlacementCandidates: (
    input: GeneratePlacementCandidatesInput
  ) => Effect.Effect<
    ReadonlyArray<IrregularPlacementCandidate>,
    IrregularNestingNotImplementedError
  >
}

export interface FreeMaterialService {
  readonly computeFreeMaterial: (
    input: ComputeFreeMaterialInput
  ) => Effect.Effect<FreeMaterialSnapshot, IrregularNestingNotImplementedError>
}

export interface PriorityOrderService {
  readonly buildPriorityOrder: (
    input: BuildPriorityOrderInput
  ) => Effect.Effect<ReadonlyArray<PieceId>, IrregularNestingNotImplementedError>
}

export interface IrregularNestingPortfolio {
  readonly run: (
    input: RunPortfolioInput
  ) => Effect.Effect<IrregularPortfolioResult, IrregularNestingNotImplementedError>
}

export interface GeometryCache {
  readonly get: <A>(key: IrregularGeometryCacheKey) => Effect.Effect<A | undefined>
  readonly set: <A>(key: IrregularGeometryCacheKey, value: A) => Effect.Effect<void>
  readonly remove: (key: IrregularGeometryCacheKey) => Effect.Effect<void>
  readonly clear: Effect.Effect<void>
}

export const CollisionGeometryBuilder = Context.Service<CollisionGeometryBuilder>(
  'min-plane-dfx/irregular/CollisionGeometryBuilder'
)
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

export const CollisionGeometryBuilderUnimplemented = Layer.succeed(CollisionGeometryBuilder, {
  buildPiece: () => failNotImplemented('CollisionGeometryBuilder', 'buildPiece'),
  buildPieces: () => failNotImplemented('CollisionGeometryBuilder', 'buildPieces')
})

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
