import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  IrregularBounds,
  IrregularPlacedPiece,
  IrregularPlacement,
  IrregularPoint,
  IrregularPolygon,
  IrregularTransform,
  IrregularTransformCandidate,
  TransformedCollisionGeometry,
  FreeMaterialSnapshot
} from '@shared/irregular/domain.js'
import { PieceId } from '@shared/domain/ids.js'
import { SheetSpec } from '@shared/domain/nesting.js'
import { DEFAULT_IRREGULAR_GEOMETRY_SETTINGS } from '@shared/irregular/defaults.js'
import type { ComputeFreeMaterialInput } from '../../src/workers/irregular/services.js'
import {
  FreeMaterialService,
  IrregularGeometryInputError
} from '../../src/workers/irregular/services.js'
import {
  createFreeMaterialService,
  FreeMaterialServiceLive,
  type FreeMaterialOperation
} from '../../src/workers/irregular/freeMaterialService.js'

function point(x: number, y: number): IrregularPoint {
  return new IrregularPoint({ x, y })
}

function bounds(points: ReadonlyArray<IrregularPoint>): IrregularBounds {
  return new IrregularBounds({
    minX: Math.min(...points.map(({ x }) => x)),
    minY: Math.min(...points.map(({ y }) => y)),
    maxX: Math.max(...points.map(({ x }) => x)),
    maxY: Math.max(...points.map(({ y }) => y))
  })
}

function polygon(points: ReadonlyArray<IrregularPoint>): IrregularPolygon {
  return new IrregularPolygon({ points })
}

function placedPiece(
  pieceId: string,
  points: ReadonlyArray<IrregularPoint>,
  translateX = 0,
  translateY = 0,
  mirrored = false
): IrregularPlacedPiece {
  const collisionPolygon = polygon(points)
  return new IrregularPlacedPiece({
    placement: new IrregularPlacement({
      sourcePieceId: PieceId.make(pieceId),
      transform: new IrregularTransform({
        translateX,
        translateY,
        rotationDeg: 0,
        mirrored
      })
    }),
    collisionGeometry: new TransformedCollisionGeometry({
      sourcePieceId: PieceId.make(pieceId),
      transform: new IrregularTransformCandidate({
        index: 0,
        rotationDeg: 0,
        mirrored,
        reason: 'configured'
      }),
      polygon: collisionPolygon,
      bounds: bounds(points)
    })
  })
}

function rectangle(
  pieceId: string,
  width: number,
  height: number,
  translateX = 0,
  translateY = 0
): IrregularPlacedPiece {
  return placedPiece(
    pieceId,
    [point(0, 0), point(width, 0), point(width, height), point(0, height)],
    translateX,
    translateY
  )
}

function input(placed: ReadonlyArray<IrregularPlacedPiece>): ComputeFreeMaterialInput {
  return {
    sheet: new SheetSpec({ width: 10, height: 8, label: 'test sheet' }),
    placed,
    settings: DEFAULT_IRREGULAR_GEOMETRY_SETTINGS
  }
}

function computeFreeMaterial(value: ComputeFreeMaterialInput) {
  return Effect.runPromise(
    FreeMaterialService.use((service) => service.computeFreeMaterial(value)).pipe(
      Effect.provide(FreeMaterialServiceLive)
    )
  )
}

function computeWithOperation(
  operation: FreeMaterialOperation,
  value: ComputeFreeMaterialInput
): Promise<FreeMaterialSnapshot> {
  return Effect.runPromise(createFreeMaterialService(operation).computeFreeMaterial(value))
}

function canonicalRegions(snapshot: FreeMaterialSnapshot) {
  return snapshot.regions.map((region) => ({
    boundary: region.boundary.points.map(({ x, y }) => [x, y]),
    holes: region.holes.map((hole) => hole.points.map(({ x, y }) => [x, y]))
  }))
}

const differentialCases = [
  ['empty', input([])],
  ['interior', input([rectangle('interior', 2, 2, 4, 3)])],
  ['boundary-touching', input([rectangle('boundary-touching', 4, 2, 0, 3)])],
  [
    'disjoint',
    input([rectangle('disjoint-left', 2, 2, 1, 1), rectangle('disjoint-right', 2, 2, 6, 3)])
  ],
  [
    'touching-edge',
    input([rectangle('touching-left', 2, 2, 1, 1), rectangle('touching-right', 2, 2, 3, 1)])
  ],
  [
    'touching-point',
    input([rectangle('touching-lower', 2, 2, 1, 1), rectangle('touching-upper', 2, 2, 3, 3)])
  ],
  [
    'overlap',
    input([rectangle('overlap-first', 3, 3, 2, 2), rectangle('overlap-second', 3, 3, 4, 3)])
  ],
  [
    'mirrored-winding',
    input([
      rectangle('unmirrored', 2, 2, 2, 2),
      placedPiece(
        'mirrored-clockwise',
        [point(0, 2), point(2, 2), point(2, 0), point(0, 0)],
        3,
        2,
        true
      ),
      rectangle('mirrored-neighbor', 2, 2, 5, 2)
    ])
  ],
  ['full-sheet', input([rectangle('full-sheet', 10, 8)])]
] satisfies ReadonlyArray<readonly [string, ComputeFreeMaterialInput]>

const malformedCases = [
  [
    'non-convex-polygon',
    input([
      placedPiece('non-convex', [point(0, 0), point(4, 0), point(2, 1), point(4, 4), point(0, 4)])
    ])
  ],
  ['too-few-vertices', input([placedPiece('too-few-vertices', [point(0, 0), point(1, 0)])])],
  ['collinear-polygon', input([placedPiece('collinear', [point(0, 0), point(1, 0), point(2, 0)])])],
  [
    'repeated-adjacent-vertex',
    input([placedPiece('repeated', [point(0, 0), point(1, 0), point(1, 0), point(0, 1)])])
  ]
] satisfies ReadonlyArray<readonly [string, ComputeFreeMaterialInput]>

type ComputationOutcome = { readonly snapshot: FreeMaterialSnapshot } | { readonly error: unknown }

async function captureOperation(
  operation: FreeMaterialOperation,
  value: ComputeFreeMaterialInput
): Promise<ComputationOutcome> {
  try {
    return { snapshot: await computeWithOperation(operation, value) }
  } catch (error) {
    return { error }
  }
}

async function captureFailure(value: Promise<unknown>) {
  try {
    await value
    return undefined
  } catch (error) {
    return error
  }
}

describe('FreeMaterialServiceLive', () => {
  it('returns the whole sheet with no holes when there are no placements', async () => {
    const snapshot = await computeFreeMaterial(input([]))

    expect(snapshot.regions).toHaveLength(1)
    expect(snapshot.regions[0]?.boundary.points).toEqual([
      point(0, 0),
      point(10, 0),
      point(10, 8),
      point(0, 8)
    ])
    expect(snapshot.regions[0]?.holes).toEqual([])
    expect(snapshot.diagnostics).toEqual([])
  })

  it('represents one interior placement as one material region with one hole', async () => {
    const snapshot = await computeFreeMaterial(input([rectangle('interior', 2, 2, 4, 3)]))

    expect(snapshot.regions).toHaveLength(1)
    expect(snapshot.regions[0]?.boundary.points[0]).toEqual(point(0, 0))
    expect(snapshot.regions[0]?.holes).toHaveLength(1)
    expect(snapshot.regions[0]?.holes[0]?.points[0]).toEqual(point(4, 3))
  })

  it('does not create an artificial hole for geometry touching the sheet border', async () => {
    const snapshot = await computeFreeMaterial(input([rectangle('border-touch', 4, 2, 0, 3)]))

    expect(snapshot.regions).toHaveLength(1)
    expect(snapshot.regions[0]?.holes).toEqual([])
  })

  it('accepts occupied polygons that meet at one exact interior point', async () => {
    const snapshot = await computeFreeMaterial(
      input([rectangle('lower', 2, 2, 1, 1), rectangle('upper', 2, 2, 3, 3)])
    )

    expect(snapshot.regions).toHaveLength(1)
    expect(snapshot.regions[0]?.holes).toHaveLength(2)
  })

  it('orders holes deterministically by their stable lowest-y then lowest-x point', async () => {
    const snapshot = await computeFreeMaterial(
      input([rectangle('first-hole', 2, 2, 1, 1), rectangle('second-hole', 2, 2, 6, 3)])
    )

    const holes = snapshot.regions[0]?.holes ?? []
    expect(holes).toHaveLength(2)
    expect(holes.map((hole) => hole.points[0])).toEqual([point(1, 1), point(6, 3)])
  })

  it('canonicalizes mixed mirrored windings before the NonZero occupied union', async () => {
    const clockwiseSquare = [point(0, 2), point(2, 2), point(2, 0), point(0, 0)]
    const snapshot = await computeFreeMaterial(
      input([
        rectangle('unmirrored', 2, 2, 2, 2),
        placedPiece('mirrored-clockwise', clockwiseSquare, 3, 2, true),
        rectangle('touching', 2, 2, 5, 2)
      ])
    )

    expect(snapshot.regions).toHaveLength(1)
    expect(snapshot.regions[0]?.holes).toHaveLength(1)
    expect(snapshot.regions[0]?.holes[0]?.points[0]).toEqual(point(2, 2))
  })

  it('returns no regions when the placed geometry covers the whole sheet', async () => {
    const snapshot = await computeFreeMaterial(input([rectangle('full-sheet', 10, 8)]))

    expect(snapshot.regions).toEqual([])
  })

  it('rejects malformed non-convex collision geometry with a typed error', async () => {
    const invalid = placedPiece('invalid', [
      point(0, 0),
      point(4, 0),
      point(2, 1),
      point(4, 4),
      point(0, 4)
    ])
    const failure = await captureFailure(computeFreeMaterial(input([invalid])))

    expect(failure).toBeInstanceOf(IrregularGeometryInputError)
    if (!(failure instanceof IrregularGeometryInputError)) {
      throw new Error('expected geometry input error')
    }
    expect(failure.operation).toBe('computeFreeMaterial')
  })
})

describe('FreeMaterialService differential operations', () => {
  it.each(differentialCases)('matches canonical output for %s', async (_name, value) => {
    const [unionThenDifference, directDifference] = await Promise.all([
      captureOperation('union-then-difference', value),
      captureOperation('direct-difference', value)
    ])

    expect('error' in unionThenDifference).toBe(false)
    expect('error' in directDifference).toBe(false)
    if ('error' in unionThenDifference || 'error' in directDifference) return

    expect(canonicalRegions(directDifference.snapshot)).toEqual(
      canonicalRegions(unionThenDifference.snapshot)
    )
  })

  it.each(malformedCases)('preserves typed failures for %s', async (_name, value) => {
    const [unionThenDifference, directDifference] = await Promise.all([
      captureOperation('union-then-difference', value),
      captureOperation('direct-difference', value)
    ])

    expect('error' in unionThenDifference).toBe(true)
    expect('error' in directDifference).toBe(true)
    if (!('error' in unionThenDifference) || !('error' in directDifference)) return

    expect(unionThenDifference.error).toBeInstanceOf(IrregularGeometryInputError)
    expect(directDifference.error).toBeInstanceOf(IrregularGeometryInputError)
    if (
      !(unionThenDifference.error instanceof IrregularGeometryInputError) ||
      !(directDifference.error instanceof IrregularGeometryInputError)
    ) {
      return
    }

    expect(directDifference.error.operation).toBe(unionThenDifference.error.operation)
    expect(directDifference.error.message).toBe(unionThenDifference.error.message)
  })

  it('keeps the live layer on union-then-difference', async () => {
    const value = input([rectangle('live-default', 2, 2, 4, 3)])
    const liveSnapshot = await computeFreeMaterial(value)
    const defaultSnapshot = await computeWithOperation('union-then-difference', value)

    expect(canonicalRegions(liveSnapshot)).toEqual(canonicalRegions(defaultSnapshot))
  })
})
