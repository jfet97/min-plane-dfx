import { Context, Effect, Layer } from 'effect'
import type {
  FlattenSourceGeometryInput,
  OffsetConvexPolygonInput,
  TransformCollisionGeometryInput,
  ValidatePlacementInput
} from './services.js'
import { IrregularNestingNotImplementedError } from './services.js'
import type {
  FlattenedGeometry,
  IrregularPoint,
  IrregularPolygon,
  TransformedCollisionGeometry
} from '@shared/irregular/domain.js'

export namespace GeometryKernel {
  export interface Service {
    readonly flattenSourceGeometry: (
      input: FlattenSourceGeometryInput
    ) => Effect.Effect<FlattenedGeometry, IrregularNestingNotImplementedError>
    readonly convexHull: (
      points: ReadonlyArray<IrregularPoint>
    ) => Effect.Effect<IrregularPolygon, IrregularNestingNotImplementedError>
    readonly offsetConvexPolygon: (
      input: OffsetConvexPolygonInput
    ) => Effect.Effect<IrregularPolygon, IrregularNestingNotImplementedError>
    readonly transformCollisionGeometry: (
      input: TransformCollisionGeometryInput
    ) => Effect.Effect<TransformedCollisionGeometry, IrregularNestingNotImplementedError>
    readonly validatePlacement: (
      input: ValidatePlacementInput
    ) => Effect.Effect<void, IrregularNestingNotImplementedError>
  }
}

export class GeometryKernel extends Context.Service<
  GeometryKernel,
  GeometryKernel.Service
>()('min-plane-dfx/irregular/GeometryKernel') {
  static readonly Make = GeometryKernel.of({
    flattenSourceGeometry: () => failNotImplemented('flattenSourceGeometry'),
    convexHull: () => failNotImplemented('convexHull'),
    offsetConvexPolygon: () => failNotImplemented('offsetConvexPolygon'),
    transformCollisionGeometry: () => failNotImplemented('transformCollisionGeometry'),
    validatePlacement: () => failNotImplemented('validatePlacement')
  })

  static readonly Live = Layer.succeed(GeometryKernel, GeometryKernel.Make)
  static readonly Unimplemented = GeometryKernel.Live
}

function failNotImplemented(
  operation: string
): Effect.Effect<never, IrregularNestingNotImplementedError> {
  return Effect.fail(
    new IrregularNestingNotImplementedError({
      service: 'GeometryKernel',
      operation,
      message: `GeometryKernel.${operation} is intentionally unimplemented.`
    })
  )
}
