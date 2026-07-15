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
import { IrregularGeometryInputError } from '../../src/workers/irregular/services.js'
import { GeometryKernel, GeometrySettings } from '../../src/workers/irregular/geometryKernel.js'
import { PlacementValidation } from '../../src/workers/irregular/placementValidation.js'

function point(x: number, y: number): IrregularPoint {
  return new IrregularPoint({ x, y })
}

function polygon(points: ReadonlyArray<IrregularPoint>): IrregularPolygon {
  return new IrregularPolygon({ points })
}

function bounds(points: ReadonlyArray<IrregularPoint>): IrregularBounds {
  return new IrregularBounds({
    minX: Math.min(...points.map(({ x }) => x)),
    minY: Math.min(...points.map(({ y }) => y)),
    maxX: Math.max(...points.map(({ x }) => x)),
    maxY: Math.max(...points.map(({ y }) => y))
  })
}

function transformedGeometry(
  pieceId: string,
  points: ReadonlyArray<IrregularPoint>
): TransformedCollisionGeometry {
  return new TransformedCollisionGeometry({
    sourcePieceId: PieceId.make(pieceId),
    transform: new IrregularTransformCandidate({
      index: 0,
      rotationDeg: 0,
      mirrored: false,
      reason: 'configured'
    }),
    polygon: polygon(points),
    bounds: bounds(points)
  })
}

function placedPiece(
  pieceId: string,
  points: ReadonlyArray<IrregularPoint>,
  translateX: number,
  translateY: number
): IrregularPlacedPiece {
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
    collisionGeometry: transformedGeometry(pieceId, points)
  })
}

function squarePiece(pieceId: string, translateX = 0, translateY = 0): IrregularPlacedPiece {
  return placedPiece(
    pieceId,
    [point(0, 0), point(2, 0), point(2, 2), point(0, 2)],
    translateX,
    translateY
  )
}

function movingSquare(): TransformedCollisionGeometry {
  return transformedGeometry('moving', [point(0, 0), point(2, 0), point(2, 2), point(0, 2)])
}

function candidate(moving: TransformedCollisionGeometry, x: number, y: number) {
  return new IrregularPlacementCandidate({
    pieceId: moving.sourcePieceId,
    transform: moving.transform,
    point: point(x, y),
    diagnostics: []
  })
}

function input(
  moving: TransformedCollisionGeometry,
  candidatePoint: IrregularPlacementCandidate,
  placed: ReadonlyArray<IrregularPlacedPiece> = []
): ValidatePlacementInput {
  return {
    sheet: new SheetSpec({ width: 10, height: 10, label: 'test sheet' }),
    placed,
    moving,
    candidate: candidatePoint
  }
}

function validatePlacement(value: ValidatePlacementInput) {
  return Effect.runPromise(PlacementValidation.validate(value))
}

function checkPlacement(value: ValidatePlacementInput) {
  return Effect.runPromise(PlacementValidation.check(value))
}

async function captureFailure(value: Promise<void>) {
  try {
    await value
    return undefined
  } catch (error) {
    return error
  }
}

describe('PlacementValidation', () => {
  it('allows edge and vertex touching', async () => {
    const moving = movingSquare()
    const placed = [squarePiece('edge-touch', 2, 0), squarePiece('vertex-touch', 2, 2)]

    await expect(
      validatePlacement(input(moving, candidate(moving, 0, 0), placed))
    ).resolves.toBeUndefined()
  })

  it('returns false for illegal candidates without failing the geometry effect', async () => {
    const moving = movingSquare()

    await expect(
      checkPlacement(input(moving, candidate(moving, 1, 0), [squarePiece('overlap', 2, 0)]))
    ).resolves.toBe(false)
  })

  it('allows exact rotated boundary contact and rejects rotated positive overlap', async () => {
    const moving = transformedGeometry('rotated-moving', [
      point(0, 0),
      point(1, 1),
      point(2, 0),
      point(1, -1)
    ])
    const placed = [squarePiece('rotated-fixed')]

    await expect(checkPlacement(input(moving, candidate(moving, 2, 1), placed))).resolves.toBe(true)
    await expect(checkPlacement(input(moving, candidate(moving, 1.9, 1), placed))).resolves.toBe(
      false
    )
  })

  it('rejects positive-area overlap when a diamond is inscribed in a square', async () => {
    const square = transformedGeometry('square', [
      point(0, 0),
      point(4, 0),
      point(4, 4),
      point(0, 4)
    ])
    const diamond = [point(2, 0), point(4, 2), point(2, 4), point(0, 2)]

    await expect(
      checkPlacement(input(square, candidate(square, 0, 0), [placedPiece('diamond', diamond, 0, 0)]))
    ).resolves.toBe(false)
  })

  it('rejects positive-area overlap', async () => {
    const moving = movingSquare()
    const failure = await captureFailure(
      validatePlacement(input(moving, candidate(moving, 1, 0), [squarePiece('overlap', 2, 0)]))
    )

    expect(failure).toBeInstanceOf(IrregularGeometryInputError)
    if (!(failure instanceof IrregularGeometryInputError))
      throw new Error('expected geometry input error')
    expect(failure.message).toBe(
      'moving polygon has positive-area overlap with placed collision geometry.'
    )
  })

  it('rejects identical polygons', async () => {
    const moving = movingSquare()

    await expect(
      checkPlacement(input(moving, candidate(moving, 0, 0), [squarePiece('identical')]))
    ).resolves.toBe(false)
  })

  it('rejects a translated moving polygon outside the sheet', async () => {
    const moving = movingSquare()
    const failure = await captureFailure(validatePlacement(input(moving, candidate(moving, -1, 0))))

    expect(failure).toBeInstanceOf(IrregularGeometryInputError)
    if (!(failure instanceof IrregularGeometryInputError))
      throw new Error('expected geometry input error')
    expect(failure.message).toBe('moving polygon must remain inside the sheet.')
  })

  it('is the validator used by GeometryKernel.Live', async () => {
    const moving = movingSquare()
    const value = input(moving, candidate(moving, 0, 0), [squarePiece('touching', 2, 0)])

    await expect(
      Effect.runPromise(
        GeometryKernel.use((kernel) => kernel.validatePlacement(value)).pipe(
          Effect.provide(GeometryKernel.Live),
          Effect.provide(GeometrySettings.Live)
        )
      )
    ).resolves.toBeUndefined()
  })
})
