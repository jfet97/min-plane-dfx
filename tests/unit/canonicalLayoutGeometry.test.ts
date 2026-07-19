import { describe, expect, it } from 'vitest'
import { PieceId } from '@shared/domain/ids.js'
import { SheetSpec } from '@shared/domain/nesting.js'
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
import {
  assertCanonicalGridLegalLayout,
  canonicalCollisionLayoutIdentity,
  measureCanonicalLayoutTopology
} from '../../src/workers/irregular/canonicalLayoutGeometry.js'
import {
  canonicalStateOrientationsFittingSheet,
  orientCanonicalStateSnapshots
} from '../../src/workers/algorithm/irregular/computeIrregularNesting.js'
import { IrregularBeamState } from '../../src/workers/algorithm/irregular/irregularBeamState.js'

function placed(
  id: string,
  points: ReadonlyArray<readonly [number, number]>,
  translateX: number,
  translateY: number
): IrregularPlacedPiece {
  const sourcePieceId = PieceId.make(id)
  const xs = points.map(([x]) => x)
  const ys = points.map(([, y]) => y)
  return new IrregularPlacedPiece({
    placement: new IrregularPlacement({
      sourcePieceId,
      transform: new IrregularTransform({ translateX, translateY, rotationDeg: 0, mirrored: false })
    }),
    collisionGeometry: new TransformedCollisionGeometry({
      sourcePieceId,
      transform: new IrregularTransformCandidate({
        index: 0,
        rotationDeg: 0,
        mirrored: false,
        reason: 'configured'
      }),
      polygon: new IrregularPolygon({
        points: points.map(([x, y]) => new IrregularPoint({ x, y }))
      }),
      bounds: new IrregularBounds({
        minX: Math.min(...xs),
        minY: Math.min(...ys),
        maxX: Math.max(...xs),
        maxY: Math.max(...ys)
      })
    })
  })
}

const rectangle = (id: string, width: number, height: number, x: number, y: number) =>
  placed(id, [[0, 0], [width, 0], [width, height], [0, height]], x, y)

function quarterTurnLayout(layout: ReadonlyArray<IrregularPlacedPiece>) {
  return layout.map((entry) => {
    const polygon = entry.collisionGeometry.polygon.points.map(({ x, y }) => [-y, x] as const)
    const { translateX, translateY } = entry.placement.transform
    return placed(entry.placement.sourcePieceId, polygon, -translateY + 20, translateX + 30)
  })
}

describe('canonical collision layout geometry', () => {
  it('ignores translation, quarter-turn, copy order, ring origin, and winding', () => {
    const first = [rectangle('a', 3, 1, 1, 2), rectangle('b', 1, 2, 5, 4)]
    const representedDifferently = [...quarterTurnLayout(first)]
      .reverse()
      .map((entry) => {
        const points = [...entry.collisionGeometry.polygon.points].reverse()
        points.unshift(points.pop() ?? points[0] ?? new IrregularPoint({ x: 0, y: 0 }))
        return placed(
          entry.placement.sourcePieceId,
          points.map(({ x, y }) => [x, y] as const),
          entry.placement.transform.translateX,
          entry.placement.transform.translateY
        )
      })

    expect(canonicalCollisionLayoutIdentity(representedDifferently)).toBe(
      canonicalCollisionLayoutIdentity(first)
    )
  })

  it('preserves reflection and relative-placement differences', () => {
    const triangle = [[0, 0], [2, 0], [0, 1]] as const
    const first = [placed('triangle', triangle, 0, 0), rectangle('bar', 1, 3, 4, 1)]
    const reflected = [
      placed('triangle', triangle.map(([x, y]) => [-x, y] as const), 8, 0),
      rectangle('bar', 1, 3, 3, 1)
    ]
    const moved = [first[0], rectangle('bar', 1, 3, 5, 1)].filter(
      (entry): entry is IrregularPlacedPiece => entry !== undefined
    )

    expect(canonicalCollisionLayoutIdentity(reflected)).not.toBe(
      canonicalCollisionLayoutIdentity(first)
    )
    expect(canonicalCollisionLayoutIdentity(moved)).not.toBe(
      canonicalCollisionLayoutIdentity(first)
    )
  })

  it('measures a ring invariantly and rejects positive overlap on the grid', () => {
    const ring = [
      rectangle('bottom', 4, 1, 0, 0),
      rectangle('top', 4, 1, 0, 3),
      rectangle('left', 1, 2, 0, 1),
      rectangle('right', 1, 2, 3, 1)
    ]
    const sheet = new SheetSpec({ width: 10, height: 10, label: 'test' })
    expect(measureCanonicalLayoutTopology(quarterTurnLayout(ring))).toEqual(
      measureCanonicalLayoutTopology(ring)
    )
    expect(measureCanonicalLayoutTopology(ring)).toMatchObject({
      enclosedCavityCount: 1,
      largestOccupiedHullGapRatio: 0.25,
      occupiedEnvelopeAspectRatio: 1,
      positiveContactComponentCount: 1,
      isolatedPieceCount: 0,
      largestPositiveContactComponentSize: 4,
      largestPositiveContactComponentRatio: 1
    })
    expect(assertCanonicalGridLegalLayout(sheet, ring)).toBe(true)
    expect(
      assertCanonicalGridLegalLayout(sheet, [
        rectangle('first', 2, 2, 0, 0),
        rectangle('second', 2, 2, 1.999, 0)
      ])
    ).toBe(false)
  })

  it('accepts exact sheet boundaries and rejects an overrun', () => {
    const sheet = new SheetSpec({ width: 4, height: 3, label: 'boundary' })
    expect(assertCanonicalGridLegalLayout(sheet, [rectangle('exact', 4, 3, 0, 0)])).toBe(true)
    expect(assertCanonicalGridLegalLayout(sheet, [rectangle('over', 4.001, 3, 0, 0)])).toBe(false)
  })

  it('admits q0, q90-only, and unfit rigid states exactly', () => {
    const geometry = [rectangle('wide', 6, 3, 0, 0)]
    const state = new IrregularBeamState({
      remainingPreparedPieces: [],
      placedCollisionGeometries: geometry,
      placementOrder: [PieceId.make('wide')]
    })
    expect(
      canonicalStateOrientationsFittingSheet(
        state,
        new SheetSpec({ width: 6, height: 3, label: 'q0' })
      ).map(({ rotationDeg }) => rotationDeg)
    ).toEqual([0])
    expect(
      canonicalStateOrientationsFittingSheet(
        state,
        new SheetSpec({ width: 3, height: 6, label: 'q90' })
      ).map(({ rotationDeg }) => rotationDeg)
    ).toEqual([90])
    expect(
      canonicalStateOrientationsFittingSheet(
        state,
        new SheetSpec({ width: 6, height: 6, label: 'q0-first' })
      ).map(({ rotationDeg }) => rotationDeg)
    ).toEqual([0, 90])
    expect(
      canonicalStateOrientationsFittingSheet(
        state,
        new SheetSpec({ width: 5, height: 5, label: 'unfit' })
      )
    ).toEqual([])

    const oriented = orientCanonicalStateSnapshots(
      [{ stepIndex: 1, beamRank: 0, candidateCount: 1, state }],
      90
    )
    expect(canonicalCollisionLayoutIdentity(oriented?.at(-1)?.state.placedCollisionGeometries ?? [])).toBe(
      canonicalCollisionLayoutIdentity(state.placedCollisionGeometries)
    )
  })
})
