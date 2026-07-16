import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  IrregularBounds,
  IrregularPlacedPiece,
  IrregularPlacement,
  IrregularPlacementCandidate,
  IrregularPoint,
  IrregularPolygon,
  IrregularTransform,
  IrregularTransformCandidate,
  TransformedCollisionGeometry
} from '@shared/irregular/domain.js'
import { PieceId } from '@shared/domain/ids.js'
import { SheetSpec } from '@shared/domain/nesting.js'
import type { ValidatePlacementInput } from '../../src/workers/irregular/services.js'
import { PlacementValidation } from '../../src/workers/irregular/placementValidation.js'
import {
  makeEmptyPlacedCollisionSpatialIndex,
  makePlacedCollisionSpatialIndex
} from '../../src/workers/irregular/placedCollisionSpatialIndex.js'

function point(x: number, y: number): IrregularPoint {
  return new IrregularPoint({ x, y })
}

function squarePoints(size = 2): ReadonlyArray<IrregularPoint> {
  return [point(0, 0), point(size, 0), point(size, size), point(0, size)]
}

function bounds(points: ReadonlyArray<IrregularPoint>): IrregularBounds {
  return new IrregularBounds({
    minX: Math.min(...points.map(({ x }) => x)),
    minY: Math.min(...points.map(({ y }) => y)),
    maxX: Math.max(...points.map(({ x }) => x)),
    maxY: Math.max(...points.map(({ y }) => y))
  })
}

function movingGeometry(pieceId: string): TransformedCollisionGeometry {
  const points = squarePoints()
  return new TransformedCollisionGeometry({
    sourcePieceId: PieceId.make(pieceId),
    transform: new IrregularTransformCandidate({
      index: 0,
      rotationDeg: 0,
      mirrored: false,
      reason: 'configured'
    }),
    polygon: new IrregularPolygon({ points }),
    bounds: bounds(points)
  })
}

function placedPiece(pieceId: string, translateX: number, translateY: number): IrregularPlacedPiece {
  const geometry = movingGeometry(pieceId)
  return new IrregularPlacedPiece({
    placement: new IrregularPlacement({
      sourcePieceId: PieceId.make(pieceId),
      transform: new IrregularTransform({
        translateX,
        translateY,
        rotationDeg: 0,
        mirrored: false
      })
    }),
    collisionGeometry: geometry
  })
}

function queryBounds(minX: number, minY: number, maxX: number, maxY: number): IrregularBounds {
  return new IrregularBounds({ minX, minY, maxX, maxY })
}

function candidate(moving: TransformedCollisionGeometry, x: number, y: number) {
  return new IrregularPlacementCandidate({
    pieceId: moving.sourcePieceId,
    transform: moving.transform,
    point: point(x, y),
    diagnostics: []
  })
}

function validationInput(
  moving: TransformedCollisionGeometry,
  placed: ReadonlyArray<IrregularPlacedPiece>,
  x: number,
  y: number,
  indexed: boolean
): ValidatePlacementInput {
  return {
    sheet: new SheetSpec({ width: 20, height: 20, label: 'spatial-index-test' }),
    placed,
    ...(indexed ? { placedCollisionIndex: makePlacedCollisionSpatialIndex(placed, 4) } : {}),
    moving,
    candidate: candidate(moving, x, y)
  }
}

describe('PlacedCollisionSpatialIndex', () => {
  it('keeps boundary contacts and filters only disjoint indexed bounds', () => {
    const first = placedPiece('first', 0, 0)
    const second = placedPiece('second', 10, 0)
    const index = makePlacedCollisionSpatialIndex([first, second], 4)

    expect(index.query()).toHaveLength(2)
    expect(index.query(queryBounds(2, 0, 2, 2)).map(({ placed }) => placed.placement.sourcePieceId)).toEqual([
      PieceId.make('first')
    ])
    expect(index.query(queryBounds(8, 0, 10, 2)).map(({ placed }) => placed.placement.sourcePieceId)).toEqual([
      PieceId.make('second')
    ])
  })

  it('persists parent entries while appending a child entry', () => {
    const first = placedPiece('first', 0, 0)
    const second = placedPiece('second', 10, 0)
    const parent = makeEmptyPlacedCollisionSpatialIndex(4).add(first)
    const child = parent.add(second)

    expect(parent.size).toBe(1)
    expect(child.size).toBe(2)
    expect(parent.query(queryBounds(10, 0, 12, 2))).toEqual([])
    expect(child.query(queryBounds(10, 0, 12, 2)).map(({ placed }) => placed)).toEqual([second])
  })

  it('keeps invalid placed geometry in the conservative fallback set', () => {
    const invalid = placedPiece('invalid', 0, 0)
    const invalidGeometry = new TransformedCollisionGeometry({
      ...invalid.collisionGeometry,
      polygon: new IrregularPolygon({ points: [point(0, 0), point(0, 0), point(2, 2)] })
    })
    const invalidPlaced = new IrregularPlacedPiece({
      placement: invalid.placement,
      collisionGeometry: invalidGeometry
    })
    const index = makePlacedCollisionSpatialIndex([invalidPlaced], 4)

    expect(index.query(queryBounds(100, 100, 102, 102))).toHaveLength(1)
    expect(index.query(queryBounds(100, 100, 102, 102))[0]?.validationMessage).toBe(
      'polygon must not repeat adjacent vertices.'
    )
  })

  it('matches direct validation across contacts, overlaps, and disjoint candidates', async () => {
    const moving = movingGeometry('moving')
    const placed = [placedPiece('first', 0, 0), placedPiece('second', 10, 10)]
    const candidatePoints = [
      [0, 0],
      [2, 0],
      [1, 0],
      [8, 8],
      [18, 18]
    ] as const

    const direct = await Promise.all(
      candidatePoints.map(([x, y]) =>
        Effect.runPromise(PlacementValidation.check(validationInput(moving, placed, x, y, false)))
      )
    )
    const indexed = await Promise.all(
      candidatePoints.map(([x, y]) =>
        Effect.runPromise(PlacementValidation.check(validationInput(moving, placed, x, y, true)))
      )
    )

    expect(indexed).toEqual(direct)
  })
})
