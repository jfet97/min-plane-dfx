import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { PieceId } from '@shared/domain/ids.js'
import { SheetSpec } from '@shared/domain/nesting.js'
import {
  IrregularBounds,
  IrregularPlacedPiece,
  IrregularPlacement,
  IrregularPoint,
  IrregularPolygon,
  IrregularTransformCandidate,
  TransformedCollisionGeometry
} from '@shared/irregular/domain.js'
import { relaxOverlappingLayout } from '../../src/workers/algorithm/irregular/overlapRelaxation.js'

function placedSquare(pieceId: string, x: number, y: number): IrregularPlacedPiece {
  const id = PieceId.make(pieceId)
  return new IrregularPlacedPiece({
    placement: new IrregularPlacement({
      pieceId: id,
      sourcePieceId: id,
      transform: { translateX: x, translateY: y, rotationDeg: 0, mirrored: false }
    }),
    collisionGeometry: new TransformedCollisionGeometry({
      sourcePieceId: id,
      transform: new IrregularTransformCandidate({
        index: 0,
        rotationDeg: 0,
        mirrored: false,
        reason: 'configured'
      }),
      polygon: new IrregularPolygon({
        points: [
          new IrregularPoint({ x: 0, y: 0 }),
          new IrregularPoint({ x: 2, y: 0 }),
          new IrregularPoint({ x: 2, y: 2 }),
          new IrregularPoint({ x: 0, y: 2 })
        ]
      }),
      bounds: new IrregularBounds({ minX: 0, minY: 0, maxX: 2, maxY: 2 })
    })
  })
}

describe('relaxOverlappingLayout', () => {
  it('keeps the incumbent immutable when an isotropic squeeze cannot be separated', async () => {
    const incumbent = [placedSquare('a', 0, 0), placedSquare('b', 2, 2)]
    const translations = incumbent.map(({ placement }) => ({ ...placement.transform }))
    const result = await Effect.runPromise(
      relaxOverlappingLayout(new SheetSpec({ width: 10, height: 10, label: 'test' }), incumbent, {
        squeezeRatios: [0.01],
        maximumEvaluations: 200,
        completedAttemptBudget: 20
      })
    )

    expect(result.accepted).toBe(false)
    expect(result.placedCollisionGeometries).toBe(incumbent)
    expect(incumbent.map(({ placement }) => placement.transform)).toEqual(translations)
    expect(result.evaluations).toBeLessThanOrEqual(200)
    expect(result.completedAttempts).toBeLessThanOrEqual(20)
  })
})
