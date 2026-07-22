import { describe, expect, it } from 'vitest'
import { PieceId } from '@shared/domain/ids.js'
import {
  IrregularBounds,
  IrregularPlacedPiece,
  IrregularPlacement,
  IrregularPoint,
  IrregularPolygon,
  IrregularTransform,
  IrregularTransformCandidate,
  TransformedCollisionGeometry
} from '@shared/irregular/domain.js'
import { runIntrinsicComponentInterfaceClosure } from '../../src/workers/algorithm/irregular/intrinsicComponentInterfaceClosure.js'

function square(id: string, translateX: number): IrregularPlacedPiece {
  const pieceId = PieceId.make(id)
  return new IrregularPlacedPiece({
    placement: new IrregularPlacement({
      pieceId,
      sourcePieceId: pieceId,
      transform: new IrregularTransform({
        translateX,
        translateY: 0,
        rotationDeg: 0,
        mirrored: false
      })
    }),
    collisionGeometry: new TransformedCollisionGeometry({
      sourcePieceId: pieceId,
      transform: new IrregularTransformCandidate({
        index: 0,
        rotationDeg: 0,
        mirrored: false,
        reason: 'configured'
      }),
      polygon: new IrregularPolygon({
        points: [
          new IrregularPoint({ x: 0, y: 0 }),
          new IrregularPoint({ x: 1, y: 0 }),
          new IrregularPoint({ x: 1, y: 1 }),
          new IrregularPoint({ x: 0, y: 1 })
        ]
      }),
      bounds: new IrregularBounds({ minX: 0, minY: 0, maxX: 1, maxY: 1 })
    })
  })
}

describe('intrinsic component interface closure', () => {
  it('rigidly closes two exact contact components without losing their internal edges', () => {
    const seed = [
      square('a', 0),
      square('b', 1),
      square('c', 2),
      square('d', 3),
      square('e', 4),
      square('f', 5),
      square('g', 9)
    ]

    const result = runIntrinsicComponentInterfaceClosure({
      seedPlaced: seed,
      maximumMaterializations: 2_000,
      maximumRuntimeMs: 30_000
    })

    expect(result).toBeDefined()
    expect(result?.compatibleEdgePairCount).toBeGreaterThan(0)
    expect(result?.exactEndpoints).not.toHaveLength(0)
    const endpoint = result?.qualifyingEndpoints[0]
    expect(endpoint).toBeDefined()
    expect(endpoint?.attempt.metrics?.positiveContactComponentCount).toBe(1)
    expect(endpoint?.attempt.metrics?.totalStructuralContacts).toBeGreaterThanOrEqual(6)
    expect(endpoint?.attempt.metrics?.envelopeAreaMm2).toBeLessThanOrEqual(
      result?.seedMetrics.envelopeAreaMm2 ?? Number.POSITIVE_INFINITY
    )
    expect(endpoint?.attempt.preservedInternalContactCount).toBe(5)
    expect(endpoint?.attempt.newStructuralInterfaceSignatures).not.toHaveLength(0)
  })
})
