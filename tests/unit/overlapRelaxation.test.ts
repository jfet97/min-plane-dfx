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
import { relaxOverlappingLayoutV1 } from '../../src/workers/algorithm/irregular/overlapRelaxationV1.js'

function placedSquare(pieceId: string, x: number, y: number, size = 2): IrregularPlacedPiece {
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
          new IrregularPoint({ x: size, y: 0 }),
          new IrregularPoint({ x: size, y: size }),
          new IrregularPoint({ x: 0, y: size })
        ]
      }),
      bounds: new IrregularBounds({ minX: 0, minY: 0, maxX: size, maxY: size })
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

  it('restores and validates a collision-free longer-axis center split', async () => {
    const incumbent = [placedSquare('left', 0, 0, 1), placedSquare('right', 3, 0, 1)]
    const result = await Effect.runPromise(
      relaxOverlappingLayoutV1(
        new SheetSpec({ width: 10, height: 10, label: 'test' }),
        incumbent,
        {
          targetWidth: 3.9987,
          maximumEvaluations: 100,
          maximumSweeps: 2,
          strikeLimit: 1
        }
      )
    )

    expect(result.separated).toBe(true)
    expect(result.promotable).toBe(true)
    expect(result.initialRawLoss).toBe(0)
    expect(result.exactCandidatesChecked).toBe(1)
    expect(result.rawZeroRestorations).toHaveLength(1)
    expect(result.rawZeroRestorations[0]?.exactGridLegal).toBe(true)
    expect(result.requestedTargetWidth).toBe(3.9987)
    expect(result.targetWidth).toBe(3.998)
    expect(result.selectedMetrics.width).toBeCloseTo(3.998)
    expect(result.selectedMetrics.area).toBeLessThan(result.incumbentMetrics.area)
    expect(
      result.placedCollisionGeometries.every(({ placement }) =>
        Number.isInteger(placement.transform.translateX * 1000)
      )
    ).toBe(true)
  })

  it('bounds read-only exact checks without publishing an inadmissible snapshot', async () => {
    const incumbent = [placedSquare('a', 0, 0), placedSquare('b', 2, 1.5)]
    const result = await Effect.runPromise(
      relaxOverlappingLayoutV1(
        new SheetSpec({ width: 10, height: 10, label: 'test' }),
        incumbent,
        {
          targetWidth: 3.998,
          maximumEvaluations: 500,
          maximumSweeps: 1,
          strikeLimit: 1,
          maximumDiagnosticExactChecks: 1_000
        }
      )
    )

    expect(result.registeredBudget.maximumDiagnosticExactChecks).toBe(100)
    expect(result.diagnosticExactChecks.length).toBeGreaterThan(0)
    expect(result.diagnosticExactChecks.length).toBeLessThanOrEqual(100)
    expect(result.promotable).toBe(false)
    expect(result.placedCollisionGeometries).toBe(incumbent)
  })
})
