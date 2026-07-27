import { Effect } from 'effect'
import {
  IrregularBounds,
  IrregularPoint,
  IrregularPolygon,
  TransformedCollisionGeometry
} from '@shared/irregular/domain.js'
import type { PieceId } from '@shared/domain/ids.js'
import type { IrregularTransformCandidate } from '@shared/irregular/domain.js'
import type { TransformCollisionGeometryInput } from './services.js'
import { IrregularGeometryInputError } from './services.js'
import { computeTransformedCollisionGeometry } from './core/transformCollisionGeometryCore.js'
import type { InternalTransformedCollisionGeometry } from './internalGeometry.js'

export const TransformCollisionGeometry = {
  compute
} as const

/**
 * Preserves the public Effect service contract while deferring all trusted
 * transform work to the structural core.
 */
function compute(
  input: TransformCollisionGeometryInput
): Effect.Effect<TransformedCollisionGeometry, IrregularGeometryInputError> {
  return Effect.suspend(() => {
    const result = computeTransformedCollisionGeometry(input)
    return result.ok
      ? Effect.succeed(toDomainTransformedCollisionGeometry(result.value))
      : failInvalidInput(result.message)
  })
}

/** Adapts one trusted structural transform to the existing public worker model. */
export function toDomainTransformedCollisionGeometry(
  geometry: InternalTransformedCollisionGeometry<PieceId, IrregularTransformCandidate>
): TransformedCollisionGeometry {
  return new TransformedCollisionGeometry({
    sourcePieceId: geometry.sourcePieceId,
    transform: geometry.transform,
    polygon: new IrregularPolygon({
      points: geometry.polygon.points.map(
        (point) => new IrregularPoint({ x: point.x, y: point.y })
      )
    }),
    bounds: new IrregularBounds(geometry.bounds)
  })
}

function failInvalidInput(message: string): Effect.Effect<never, IrregularGeometryInputError> {
  return Effect.fail(
    new IrregularGeometryInputError({
      operation: 'transformCollisionGeometry',
      message
    })
  )
}
