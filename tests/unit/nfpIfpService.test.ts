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
  TransformedCollisionGeometry
} from '@shared/irregular/domain.js'
import { PieceId } from '@shared/domain/ids.js'
import { SheetSpec } from '@shared/domain/nesting.js'
import {
  DEFAULT_IRREGULAR_GEOMETRY_SETTINGS,
  DEFAULT_IRREGULAR_NESTING_SETTINGS
} from '@shared/irregular/defaults.js'
import { NfpIfpServiceLive } from '../../src/workers/irregular/nfpIfpService.js'
import type {
  ComputeIfpBoundsInput,
  ComputeNfpInput,
  GeneratePlacementCandidatesInput
} from '../../src/workers/irregular/services.js'
import { IrregularGeometryInputError, NfpIfpService } from '../../src/workers/irregular/services.js'

function point(x: number, y: number): IrregularPoint {
  return new IrregularPoint({ x, y })
}

function polygon(points: ReadonlyArray<IrregularPoint>): IrregularPolygon {
  return new IrregularPolygon({ points })
}

function bounds(points: ReadonlyArray<IrregularPoint>): IrregularBounds {
  const firstPoint = points[0]
  if (firstPoint === undefined) throw new Error('test polygon must contain a point')

  return new IrregularBounds({
    minX: Math.min(...points.map(({ x }) => x)),
    minY: Math.min(...points.map(({ y }) => y)),
    maxX: Math.max(...points.map(({ x }) => x)),
    maxY: Math.max(...points.map(({ y }) => y))
  })
}

function transformedGeometry(
  pieceId: string,
  points: ReadonlyArray<IrregularPoint>,
  geometryBounds = bounds(points)
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
    bounds: geometryBounds
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

function sheet(width: number, height: number): SheetSpec {
  return new SheetSpec({ width, height, label: 'test sheet' })
}

function computeNfp(input: ComputeNfpInput) {
  return Effect.runPromise(
    NfpIfpService.use((service) => service.computeNfp(input)).pipe(
      Effect.provide(NfpIfpServiceLive)
    )
  )
}

function computeIfpBounds(input: ComputeIfpBoundsInput) {
  return Effect.runPromise(
    NfpIfpService.use((service) => service.computeIfpBounds(input)).pipe(
      Effect.provide(NfpIfpServiceLive)
    )
  )
}

function generateCandidates(input: GeneratePlacementCandidatesInput) {
  return Effect.runPromise(
    NfpIfpService.use((service) => service.generatePlacementCandidates(input)).pipe(
      Effect.provide(NfpIfpServiceLive)
    )
  )
}

function candidatePoints(
  candidates: ReadonlyArray<{ readonly point: IrregularPoint }>
): ReadonlyArray<IrregularPoint> {
  return candidates.map(({ point: candidatePoint }) => candidatePoint)
}

async function captureFailure(promise: Promise<unknown>) {
  try {
    await promise
    return undefined
  } catch (error) {
    return error
  }
}

describe('NfpIfpServiceLive', () => {
  it('computes axis-aligned square NFP and IFP bounds', async () => {
    const moving = transformedGeometry('moving-square', [
      point(0, 0),
      point(2, 0),
      point(2, 2),
      point(0, 2)
    ])
    const fixed = placedPiece(
      'fixed-square',
      [point(0, 0), point(4, 0), point(4, 4), point(0, 4)],
      0,
      0
    )

    const [nfp, ifp] = await Promise.all([
      computeNfp({ fixed, moving, settings: DEFAULT_IRREGULAR_GEOMETRY_SETTINGS }),
      computeIfpBounds({ sheet: sheet(10, 8), moving })
    ])

    expect(nfp.boundary.points).toEqual([point(-2, -2), point(4, -2), point(4, 4), point(-2, 4)])
    expect(ifp.bounds).toEqual(new IrregularBounds({ minX: 0, minY: 0, maxX: 8, maxY: 6 }))
  })

  it('includes the fixed placement translation in NFP coordinates', async () => {
    const moving = transformedGeometry('moving-translated', [
      point(0, 0),
      point(2, 0),
      point(2, 2),
      point(0, 2)
    ])
    const fixed = placedPiece(
      'fixed-translated',
      [point(0, 0), point(4, 0), point(4, 4), point(0, 4)],
      10,
      20
    )

    const nfp = await computeNfp({ fixed, moving, settings: DEFAULT_IRREGULAR_GEOMETRY_SETTINGS })

    expect(nfp.boundary.points).toEqual([point(8, 18), point(14, 18), point(14, 24), point(8, 24)])
  })

  it('computes the outer convex NFP for triangles', async () => {
    const fixed = placedPiece('fixed-triangle', [point(0, 0), point(4, 0), point(0, 3)], 0, 0)
    const moving = transformedGeometry('moving-triangle', [point(0, 0), point(1, 0), point(0, 1)])

    const nfp = await computeNfp({ fixed, moving, settings: DEFAULT_IRREGULAR_GEOMETRY_SETTINGS })

    expect(nfp.boundary.points).toEqual([
      point(0, -1),
      point(4, -1),
      point(4, 0),
      point(0, 3),
      point(-1, 3),
      point(-1, 0)
    ])
  })

  it('rejects an IFP when the transformed polygon cannot fit', async () => {
    const moving = transformedGeometry('too-wide', [
      point(-1, 0),
      point(11, 0),
      point(11, 2),
      point(-1, 2)
    ])

    const failure = await captureFailure(computeIfpBounds({ sheet: sheet(10, 10), moving }))

    expect(failure).toBeInstanceOf(IrregularGeometryInputError)
    if (!(failure instanceof IrregularGeometryInputError))
      throw new Error('expected geometry input error')
    expect(failure.message).toBe('moving polygon cannot fit inside the sheet.')
  })

  it('recomputes IFP bounds from the polygon instead of trusting stale cached bounds', async () => {
    const moving = transformedGeometry(
      'stale-bounds',
      [point(0, 0), point(4, 0), point(4, 4), point(0, 4)],
      new IrregularBounds({ minX: 0, minY: 0, maxX: 2, maxY: 2 })
    )

    const failure = await captureFailure(computeIfpBounds({ sheet: sheet(3, 3), moving }))

    expect(failure).toBeInstanceOf(IrregularGeometryInputError)
    if (!(failure instanceof IrregularGeometryInputError))
      throw new Error('expected geometry input error')
    expect(failure.message).toBe('moving polygon cannot fit inside the sheet.')
  })

  it('rejects non-convex polygon input', async () => {
    const moving = transformedGeometry('invalid-concave', [
      point(0, 0),
      point(4, 0),
      point(2, 1),
      point(4, 4),
      point(0, 4)
    ])
    const fixed = placedPiece(
      'fixed-valid',
      [point(0, 0), point(3, 0), point(3, 3), point(0, 3)],
      0,
      0
    )

    const failure = await captureFailure(
      computeNfp({ fixed, moving, settings: DEFAULT_IRREGULAR_GEOMETRY_SETTINGS })
    )

    expect(failure).toBeInstanceOf(IrregularGeometryInputError)
    if (!(failure instanceof IrregularGeometryInputError))
      throw new Error('expected geometry input error')
    expect(failure.operation).toBe('computeNfp')
  })

  it('emits only IFP corners when there are no placed pieces', async () => {
    const moving = transformedGeometry('moving-corners', [
      point(0, 0),
      point(2, 0),
      point(2, 2),
      point(0, 2)
    ])

    const candidates = await generateCandidates({
      sheet: sheet(10, 10),
      placed: [],
      moving,
      settings: DEFAULT_IRREGULAR_NESTING_SETTINGS
    })

    expect(candidatePoints(candidates)).toEqual([
      point(0, 0),
      point(8, 0),
      point(0, 8),
      point(8, 8)
    ])
    expect(candidates.every(({ diagnostics }) => diagnostics.length === 0)).toBe(true)
  })

  it('combines IFP corners and square NFP vertices without duplicates', async () => {
    const moving = transformedGeometry('moving-square-candidates', [
      point(0, 0),
      point(2, 0),
      point(2, 2),
      point(0, 2)
    ])
    const fixed = placedPiece(
      'fixed-square-candidates',
      [point(0, 0), point(2, 0), point(2, 2), point(0, 2)],
      4,
      4
    )

    const candidates = await generateCandidates({
      sheet: sheet(10, 10),
      placed: [fixed],
      moving,
      settings: DEFAULT_IRREGULAR_NESTING_SETTINGS
    })

    expect(candidatePoints(candidates)).toEqual([
      point(0, 0),
      point(8, 0),
      point(2, 2),
      point(6, 2),
      point(2, 6),
      point(6, 6),
      point(0, 8),
      point(8, 8)
    ])
  })

  it('includes IFP and NFP boundary intersections in y/x order', async () => {
    const moving = transformedGeometry('moving-ifp-intersection', [
      point(0, 0),
      point(2, 0),
      point(2, 2),
      point(0, 2)
    ])
    const fixed = placedPiece(
      'fixed-ifp-intersection',
      [point(0, 0), point(4, 0), point(4, 4), point(0, 4)],
      7,
      2
    )

    const candidates = await generateCandidates({
      sheet: sheet(10, 10),
      placed: [fixed],
      moving,
      settings: DEFAULT_IRREGULAR_NESTING_SETTINGS
    })

    expect(candidatePoints(candidates)).toEqual([
      point(0, 0),
      point(5, 0),
      point(8, 0),
      point(5, 6),
      point(8, 6),
      point(0, 8),
      point(8, 8)
    ])
  })

  it('includes legal pairwise NFP intersections and deduplicates exact points', async () => {
    const moving = transformedGeometry('moving-pairwise-intersection', [
      point(0, 0),
      point(2, 0),
      point(2, 2),
      point(0, 2)
    ])
    const firstFixed = placedPiece(
      'first-fixed-pairwise-intersection',
      [point(0, 0), point(2, 0), point(2, 2), point(0, 2)],
      4,
      4
    )
    const secondFixed = placedPiece(
      'second-fixed-pairwise-intersection',
      [point(0, 0), point(2, 0), point(2, 2), point(0, 2)],
      7,
      2
    )

    const candidates = await generateCandidates({
      sheet: sheet(10, 10),
      placed: [firstFixed, secondFixed],
      moving,
      settings: DEFAULT_IRREGULAR_NESTING_SETTINGS
    })

    expect(candidatePoints(candidates)).toEqual([
      point(0, 0),
      point(5, 0),
      point(8, 0),
      point(2, 2),
      point(5, 2),
      point(6, 4),
      point(8, 4),
      point(2, 6),
      point(6, 6),
      point(0, 8),
      point(8, 8)
    ])
  })

  it('keeps a rotated NFP boundary-touching candidate and filters positive overlap', async () => {
    const moving = transformedGeometry('moving-rotated-contact', [
      point(0, 0),
      point(1, 1),
      point(2, 0),
      point(1, -1)
    ])
    const fixed = placedPiece(
      'fixed-rotated-contact',
      [point(0, 0), point(2, 0), point(2, 2), point(0, 2)],
      0,
      0
    )

    const candidates = await generateCandidates({
      sheet: sheet(6, 6),
      placed: [fixed],
      moving,
      settings: DEFAULT_IRREGULAR_NESTING_SETTINGS
    })

    expect(candidatePoints(candidates)).toContainEqual(point(2, 1))
    expect(candidatePoints(candidates)).not.toContainEqual(point(1, 1))
  })
})
