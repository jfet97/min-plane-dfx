import { Effect, Layer } from 'effect'
import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  CollisionGeometry,
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
import {
  DEFAULT_IRREGULAR_GEOMETRY_SETTINGS,
  DEFAULT_IRREGULAR_NESTING_SETTINGS
} from '@shared/irregular/defaults.js'
import type {
  NfpBoundaryConstructionResult,
  NfpCandidatePruningMode,
  NfpConstructionAlgorithm
} from '../../src/workers/irregular/nfpIfpService.js'
import {
  canonicalizeTranslatedConvexRing,
  canonicalPlacementPointAlternatives,
  makeNfpIfpServiceLive,
  makeNfpIfpServiceLayer,
  NfpBoundaryAlgorithms,
  NfpIfpServiceLive
} from '../../src/workers/irregular/nfpIfpService.js'
import {
  legalPlacementCandidateMemoKey,
  pairwiseNfpCacheKey
} from '../../src/workers/irregular/geometryCacheKeys.js'
import { makePlacedCollisionSpatialIndex } from '../../src/workers/irregular/placedCollisionSpatialIndex.js'
import type {
  ComputeIfpBoundsInput,
  ComputeNfpInput,
  GeneratePlacementCandidatesInput
} from '../../src/workers/irregular/services.js'
import {
  GeometryCache,
  cacheKeyToString,
  IrregularGeometryInfeasibleError,
  IrregularGeometryInputError,
  IrregularNfpIfpCandidateMemoScope,
  IrregularNfpIfpControlAbortError,
  NfpIfpService
} from '../../src/workers/irregular/services.js'
import { PlacementValidation } from '../../src/workers/irregular/placementValidation.js'
import { TransformCollisionGeometry } from '../../src/workers/irregular/transformCollisionGeometry.js'
import { assertCanonicalGridLegalLayout } from '../../src/workers/irregular/canonicalLayoutGeometry.js'

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
  geometryBounds = bounds(points),
  transformCandidate = transform(0, 0, false)
): TransformedCollisionGeometry {
  return new TransformedCollisionGeometry({
    sourcePieceId: PieceId.make(pieceId),
    transform: transformCandidate,
    polygon: polygon(points),
    bounds: geometryBounds
  })
}

function collisionGeometry(
  pieceId: string,
  points: ReadonlyArray<IrregularPoint>
): CollisionGeometry {
  const geometryBounds = bounds(points)
  return new CollisionGeometry({
    sourcePieceId: PieceId.make(pieceId),
    sourceBounds: geometryBounds,
    sampledPoints: points,
    convexHull: polygon(points),
    collisionPolygon: polygon(points),
    placementReference: point(0, 0),
    diagnostics: []
  })
}

function placedPiece(
  pieceId: string,
  points: ReadonlyArray<IrregularPoint>,
  translateX: number,
  translateY: number,
  transformCandidate = transform(0, 0, false)
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
    collisionGeometry: transformedGeometry(pieceId, points, bounds(points), transformCandidate)
  })
}

function workloadPlacedPieces(pieceCount: number): ReadonlyArray<IrregularPlacedPiece> {
  const points = [point(0, 0), point(2, 0), point(2, 2), point(0, 2)]
  const columns = 20
  const spacing = 35

  return Array.from({ length: pieceCount }, (_, index) =>
    placedPiece(
      `workload-fixed-${pieceCount}-${index}`,
      points,
      20 + (index % columns) * spacing,
      20 + Math.floor(index / columns) * spacing
    )
  )
}

function transform(
  index: number,
  rotationDeg: number,
  mirrored: boolean
): IrregularTransformCandidate {
  return new IrregularTransformCandidate({
    index,
    rotationDeg,
    mirrored,
    reason: 'configured'
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

function generateCandidatesEffect(input: GeneratePlacementCandidatesInput) {
  return NfpIfpService.use((service) => service.generatePlacementCandidates(input))
}

interface CacheCounters {
  gets: number
  sets: number
  removes: number
}

function cacheLayer(values: Map<string, unknown>, counters?: CacheCounters) {
  return Layer.sync(GeometryCache, () => ({
    get: <A>(key: Parameters<GeometryCache['get']>[0]) =>
      Effect.sync(() => {
        if (counters !== undefined) counters.gets += 1
        return values.get(cacheKeyToString(key)) as A | undefined
      }),
    set: <A>(key: Parameters<GeometryCache['set']>[0], value: A) =>
      Effect.sync(() => {
        if (counters !== undefined) counters.sets += 1
        values.set(cacheKeyToString(key), value)
      }),
    remove: (key: Parameters<GeometryCache['remove']>[0]) =>
      Effect.sync(() => {
        if (counters !== undefined) counters.removes += 1
        values.delete(cacheKeyToString(key))
      }),
    clear: Effect.sync(() => {
      values.clear()
    })
  }))
}

function computeNfpWithCache(
  input: ComputeNfpInput,
  values: Map<string, unknown>,
  constructionAlgorithm: NfpConstructionAlgorithm = 'linear-edge-merge',
  counters?: CacheCounters
) {
  return Effect.runPromise(
    NfpIfpService.use((service) => service.computeNfp(input)).pipe(
      Effect.provide(makeNfpIfpServiceLayer(constructionAlgorithm)),
      Effect.provide(cacheLayer(values, counters))
    )
  )
}

function computeNfpWithConstruction(
  input: ComputeNfpInput,
  constructionAlgorithm: NfpConstructionAlgorithm
) {
  return Effect.runPromise(
    NfpIfpService.use((service) => service.computeNfp(input)).pipe(
      Effect.provide(makeNfpIfpServiceLive(constructionAlgorithm))
    )
  )
}

function generateCandidatesWithConstruction(
  input: GeneratePlacementCandidatesInput,
  constructionAlgorithm: NfpConstructionAlgorithm
) {
  return Effect.runPromise(
    NfpIfpService.use((service) => service.generatePlacementCandidates(input)).pipe(
      Effect.provide(makeNfpIfpServiceLive(constructionAlgorithm))
    )
  )
}

function generateCandidatesWithCache(
  input: GeneratePlacementCandidatesInput,
  values: Map<string, unknown>
) {
  return Effect.runPromise(
    NfpIfpService.use((service) => service.generatePlacementCandidates(input)).pipe(
      Effect.provide(makeNfpIfpServiceLayer()),
      Effect.provide(cacheLayer(values))
    )
  )
}

function generateCandidatesWithPruning(
  input: GeneratePlacementCandidatesInput,
  candidatePruningMode: NfpCandidatePruningMode
) {
  return Effect.runPromise(
    NfpIfpService.use((service) => service.generatePlacementCandidates(input)).pipe(
      Effect.provide(makeNfpIfpServiceLive('vertex-pair-hull', candidatePruningMode))
    )
  )
}

function boundaryOrThrow(
  construct: (
    fixedPoints: ReadonlyArray<IrregularPoint>,
    movingPoints: ReadonlyArray<IrregularPoint>
  ) => NfpBoundaryConstructionResult,
  fixedPoints: ReadonlyArray<IrregularPoint>,
  movingPoints: ReadonlyArray<IrregularPoint>
): IrregularPolygon {
  const result = construct(fixedPoints, movingPoints)
  if ('message' in result) throw new Error(result.message)
  return result
}

function candidatePoints(
  candidates: ReadonlyArray<{ readonly point: IrregularPoint }>
): ReadonlyArray<IrregularPoint> {
  return candidates.map(({ point: candidatePoint }) => candidatePoint)
}

/** Mirrors the padded convex collision polygon produced by `rounded-rectangle.dxf`. */
function roundedRectangleCollisionPoints(): ReadonlyArray<IrregularPoint> {
  return [
    point(18.232, 0),
    point(107.27199999999999, 0),
    point(112.893, 0.89),
    point(117.982, 3.484),
    point(122.02, 7.521999999999999),
    point(124.61399999999999, 12.611),
    point(125.50399999999999, 18.232),
    point(125.50399999999999, 52.272000000000006),
    point(124.61399999999999, 57.893),
    point(122.02, 62.982),
    point(117.982, 67.02),
    point(112.893, 69.61399999999999),
    point(107.27199999999999, 70.50399999999999),
    point(18.232, 70.50399999999999),
    point(12.611, 69.61399999999999),
    point(7.521999999999999, 67.02),
    point(3.484, 62.982),
    point(0.89, 57.893),
    point(0, 52.272000000000006),
    point(0, 18.232),
    point(0.89, 12.611),
    point(3.484, 7.521999999999999),
    point(7.521999999999999, 3.484),
    point(12.611, 0.89)
  ]
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
  it('orders the step-31 raw translation by canonical-grid distance and identity', () => {
    const alternatives = canonicalPlacementPointAlternatives({
      x: 509.4153570036576,
      y: 527.8944897285338
    })

    expect(alternatives).toHaveLength(9)
    expect(alternatives[0]).toMatchObject({ x: 509.415, y: 527.894 })
    expect(
      alternatives.every(
        ({ x, y }) => Number.isInteger(x * 1_000) && Number.isInteger(y * 1_000)
      )
    ).toBe(true)
    expect(new Set(alternatives.map(({ gridX, gridY }) => `${gridX},${gridY}`)).size).toBe(9)
  })

  it('keeps direct and final canonical legality aligned for the step-31 pair', async () => {
    const fixedPoints = [
      point(0, 23.502),
      point(0, 91.072),
      point(-70.504, 114.574),
      point(-70.504, 0)
    ]
    const movingPoints = [point(0, -44.144), point(75.675, -88.288), point(75.675, 0)]
    const fixedTranslation = canonicalPlacementPointAlternatives({
      x: 527.902,
      y: 381.8945535748431
    })[0]
    if (fixedTranslation === undefined) throw new Error('expected fixed canonical translation')
    const fixed = placedPiece(
      '604bc424-469c-4ab8-93f1-80c0fc4090b3-copy-4',
      fixedPoints,
      fixedTranslation.x,
      fixedTranslation.y,
      transform(1, 90, false)
    )
    const moving = transformedGeometry(
      'd06db288-d2d6-4f40-874e-98287f516d93-copy-2',
      movingPoints,
      bounds(movingPoints),
      transform(3, 270, false)
    )
    const canonicalAlternatives = canonicalPlacementPointAlternatives({
      x: 509.4153570036576,
      y: 527.8944897285338
    })
    let accepted: (typeof canonicalAlternatives)[number] | undefined
    for (const candidatePoint of canonicalAlternatives) {
      const candidate = new IrregularPlacementCandidate({
        pieceId: moving.sourcePieceId,
        transform: moving.transform,
        point: candidatePoint,
        diagnostics: []
      })
      if (
        await Effect.runPromise(
          PlacementValidation.check({
            sheet: sheet(2000, 2700),
            placed: [fixed],
            moving,
            candidate
          })
        )
      ) {
        accepted = candidatePoint
        break
      }
    }
    expect(accepted).toBeDefined()
    if (accepted === undefined) throw new Error('expected a legal canonical alternative')
    const acceptedMoving = placedPiece(
      'd06db288-d2d6-4f40-874e-98287f516d93-copy-2',
      movingPoints,
      accepted.x,
      accepted.y,
      transform(3, 270, false)
    )

    expect(accepted).toMatchObject({ x: 509.416, y: 527.895 })
    expect(assertCanonicalGridLegalLayout(sheet(2000, 2700), [fixed, acceptedMoving])).toBe(true)
  })
  it('canonicalizes wrap-around collinear and repeated vertices without changing the ring', () => {
    const wrapAround = canonicalizeTranslatedConvexRing([
      point(0, 0),
      point(2, 0),
      point(2, 2),
      point(0, 2),
      point(0, 1)
    ])
    const repeatedClosing = canonicalizeTranslatedConvexRing([
      point(0, 0),
      point(2, 0),
      point(2, 2),
      point(0, 2),
      point(0, 0)
    ])

    if ('message' in wrapAround || 'message' in repeatedClosing) {
      throw new Error('expected cyclic ring canonicalization to succeed')
    }
    const expected = [point(0, 0), point(2, 0), point(2, 2), point(0, 2)]
    expect(wrapAround.points).toEqual(expected)
    expect(repeatedClosing.points).toEqual(expected)
  })

  it('rejects a canonical ring that collapses below three vertices', () => {
    const result = canonicalizeTranslatedConvexRing([point(0, 0), point(1, 0), point(2, 0)])

    expect(result).toEqual({ message: 'polygon must contain at least three vertices.' })
  })

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

  it('keeps the disputed arbitrary-angle NFP tangent legal in direct validation', async () => {
    const moving = Effect.runSync(
      TransformCollisionGeometry.compute({
        geometry: collisionGeometry('disputed-trapezoid', [
          point(20, 0),
          point(80, 0),
          point(100, 60),
          point(0, 60)
        ]),
        transform: transform(5, 71.56456358247075, false)
      })
    )
    const fixedGeometry = Effect.runSync(
      TransformCollisionGeometry.compute({
        geometry: collisionGeometry('disputed-hexagon', [
          point(35, 0),
          point(70, 25),
          point(70, 75),
          point(35, 100),
          point(0, 75),
          point(0, 25)
        ]),
        transform: transform(4, 35.53727384446901, true)
      })
    )
    const fixed = new IrregularPlacedPiece({
      placement: new IrregularPlacement({
        sourcePieceId: fixedGeometry.sourcePieceId,
        transform: new IrregularTransform({
          translateX: 406.0464207658377,
          translateY: 242.57802340266528,
          rotationDeg: fixedGeometry.transform.rotationDeg,
          mirrored: fixedGeometry.transform.mirrored
        })
      }),
      collisionGeometry: fixedGeometry
    })
    const nfp = await computeNfp({
      fixed,
      moving,
      settings: DEFAULT_IRREGULAR_GEOMETRY_SETTINGS
    })
    const tangentPoint = nfp.boundary.points[4]
    if (tangentPoint === undefined) {
      throw new Error('expected the disputed NFP support vertex')
    }
    const tangentCandidate = new IrregularPlacementCandidate({
      pieceId: moving.sourcePieceId,
      transform: moving.transform,
      point: tangentPoint,
      diagnostics: []
    })

    await expect(
      Effect.runPromise(
        PlacementValidation.check({
          sheet: sheet(2000, 2700),
          placed: [fixed],
          moving,
          candidate: tangentCandidate
        })
      )
    ).resolves.toBe(true)
  })

  it('rejects a translated NFP whose strict boundary collapses numerically', async () => {
    const moving = transformedGeometry('moving-collapsed-translation', [
      point(0, 0),
      point(0.1, 0),
      point(0.1, 0.1),
      point(0, 0.1)
    ])
    const fixed = placedPiece(
      'fixed-collapsed-translation',
      [point(0, 0), point(0.25, 0), point(0.25, 0.25), point(0, 0.25)],
      1e16,
      1e16
    )

    const input = { fixed, moving, settings: DEFAULT_IRREGULAR_GEOMETRY_SETTINGS }
    const referenceBoundary = boundaryOrThrow(
      NfpBoundaryAlgorithms.reference,
      fixed.collisionGeometry.polygon.points,
      moving.polygon.points
    )
    const referenceValues = new Map<string, unknown>()
    referenceValues.set(
      cacheKeyToString(
        pairwiseNfpCacheKey(
          {
            fixed,
            moving,
            settings: DEFAULT_IRREGULAR_GEOMETRY_SETTINGS
          },
          'vertex-pair-hull'
        )
      ),
      referenceBoundary
    )

    const linearFailure = await captureFailure(computeNfp(input))
    const referenceFailure = await captureFailure(
      computeNfpWithCache(input, referenceValues, 'vertex-pair-hull')
    )

    expect(linearFailure).toBeInstanceOf(IrregularGeometryInputError)
    expect(referenceFailure).toBeInstanceOf(IrregularGeometryInputError)
    if (!(linearFailure instanceof IrregularGeometryInputError))
      throw new Error('expected linear geometry input error')
    if (!(referenceFailure instanceof IrregularGeometryInputError))
      throw new Error('expected reference geometry input error')
    expect(linearFailure.operation).toBe('computeNfp')
    expect(referenceFailure.operation).toBe('computeNfp')
  })

  it('separates relative NFP cache entries by construction algorithm', async () => {
    const moving = transformedGeometry('moving-cache-algorithm', [
      point(0, 0),
      point(2, 0),
      point(2, 2),
      point(0, 2)
    ])
    const fixed = placedPiece(
      'fixed-cache-algorithm',
      [point(0, 0), point(4, 0), point(4, 4), point(0, 4)],
      0,
      0
    )
    const input = { fixed, moving, settings: DEFAULT_IRREGULAR_GEOMETRY_SETTINGS }
    const values = new Map<string, unknown>()
    const counters = { gets: 0, sets: 0, removes: 0 }
    const linearKey = pairwiseNfpCacheKey(input, 'linear-edge-merge')
    const referenceKey = pairwiseNfpCacheKey(input, 'vertex-pair-hull')

    expect(cacheKeyToString(linearKey)).not.toBe(cacheKeyToString(referenceKey))

    const firstLinear = await computeNfpWithCache(input, values, 'linear-edge-merge', counters)
    const firstReference = await computeNfpWithCache(input, values, 'vertex-pair-hull', counters)
    expect(firstReference).toEqual(firstLinear)
    expect(counters).toEqual({ gets: 2, sets: 2, removes: 0 })

    const secondLinear = await computeNfpWithCache(input, values, 'linear-edge-merge', counters)
    const secondReference = await computeNfpWithCache(input, values, 'vertex-pair-hull', counters)
    expect(secondLinear).toEqual(firstLinear)
    expect(secondReference).toEqual(firstReference)
    expect(counters).toEqual({ gets: 4, sets: 2, removes: 0 })
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

  it('matches the reference NFP for rotated, mirrored, and asymmetric convex polygons', () => {
    const fixedPoints = [
      point(-3, -1),
      point(0, -3),
      point(4, -2),
      point(5, 1),
      point(2, 4),
      point(-2, 3)
    ]
    const movingPoints = [
      point(2, -1),
      point(0, -3),
      point(-3, -2),
      point(-4, 1),
      point(-2, 3),
      point(1, 2)
    ]

    const reference = boundaryOrThrow(NfpBoundaryAlgorithms.reference, fixedPoints, movingPoints)
    const linear = boundaryOrThrow(NfpBoundaryAlgorithms.linear, fixedPoints, movingPoints)

    expect(linear).toEqual(reference)
    expect(linear.points[0]).toEqual(point(2, -6))
  })

  it('matches the reference NFP when parallel edge directions tie', () => {
    const fixtures = [
      {
        fixed: [point(0, 0), point(6, 0), point(6, 4), point(0, 4)],
        moving: [point(0, 2), point(0, 0), point(3, 0), point(3, 2)]
      },
      {
        fixed: [point(0, 0), point(4, 0), point(0, 3)],
        moving: [point(0, 1), point(1, 0), point(0, 0)]
      }
    ]

    for (const fixture of fixtures) {
      const reference = boundaryOrThrow(
        NfpBoundaryAlgorithms.reference,
        fixture.fixed,
        fixture.moving
      )
      const linear = boundaryOrThrow(NfpBoundaryAlgorithms.linear, fixture.fixed, fixture.moving)
      expect(linear).toEqual(reference)
    }
  })

  it('keeps rounded-rectangle collision pairs strict in both NFP constructions', async () => {
    const points = roundedRectangleCollisionPoints()
    const fixed = placedPiece('fixed-rounded-rectangle', points, 0, 1)
    const moving = transformedGeometry('moving-rounded-rectangle', points)
    const input = {
      fixed,
      moving,
      settings: DEFAULT_IRREGULAR_GEOMETRY_SETTINGS
    }

    const [linear, reference] = await Promise.all([
      computeNfpWithConstruction(input, 'linear-edge-merge'),
      computeNfpWithConstruction(input, 'vertex-pair-hull')
    ])

    expect(linear.boundary.points.length).toBeGreaterThanOrEqual(3)
    expect(reference.boundary.points.length).toBeGreaterThanOrEqual(3)
  })

  it('keeps candidate generation identical with reference and linear NFP boundaries', async () => {
    const fixedPoints = [
      point(-3, -1),
      point(0, -3),
      point(4, -2),
      point(5, 1),
      point(2, 4),
      point(-2, 3)
    ]
    const movingPoints = [
      point(2, -1),
      point(0, -3),
      point(-3, -2),
      point(-4, 1),
      point(-2, 3),
      point(1, 2)
    ]
    const fixed = placedPiece(
      'fixed-parity-asymmetric',
      fixedPoints,
      12,
      10,
      transform(4, 37, false)
    )
    const moving = transformedGeometry(
      'moving-parity-asymmetric',
      movingPoints,
      bounds(movingPoints),
      transform(9, 143.5, true)
    )
    const input = {
      sheet: sheet(40, 40),
      placed: [fixed],
      moving,
      settings: DEFAULT_IRREGULAR_NESTING_SETTINGS
    }
    const nfpInput = {
      fixed,
      moving,
      settings: input.settings.geometry
    }

    const linearNfp = await computeNfpWithConstruction(nfpInput, 'linear-edge-merge')
    const referenceNfp = await computeNfpWithConstruction(nfpInput, 'vertex-pair-hull')
    expect(linearNfp).toEqual(referenceNfp)

    const linearCandidates = await generateCandidatesWithConstruction(input, 'linear-edge-merge')
    const referenceCandidates = await generateCandidatesWithConstruction(input, 'vertex-pair-hull')

    expect(linearCandidates.length).toBeGreaterThan(0)
    expect(linearCandidates).toEqual(referenceCandidates)
  })

  it('preserves exact candidate sets and direct legality with indexed NFP pruning', async () => {
    const squareMoving = transformedGeometry('moving-index-parity-square', [
      point(0, 0),
      point(2, 0),
      point(2, 2),
      point(0, 2)
    ])
    const firstFixed = placedPiece(
      'fixed-index-parity-first',
      [point(0, 0), point(2, 0), point(2, 2), point(0, 2)],
      4,
      4
    )
    const secondFixed = placedPiece(
      'fixed-index-parity-second',
      [point(0, 0), point(2, 0), point(2, 2), point(0, 2)],
      7,
      2
    )
    const asymmetricPoints = [
      point(-3, -1),
      point(0, -3),
      point(4, -2),
      point(5, 1),
      point(2, 4),
      point(-2, 3)
    ]
    const asymmetricMoving = transformedGeometry(
      'moving-index-parity-asymmetric',
      asymmetricPoints,
      bounds(asymmetricPoints),
      transform(3, 67, true)
    )
    const asymmetricFixed = placedPiece(
      'fixed-index-parity-asymmetric',
      asymmetricPoints,
      12,
      10,
      transform(5, 29, false)
    )
    const cases: ReadonlyArray<GeneratePlacementCandidatesInput> = [
      {
        sheet: sheet(10, 10),
        placed: [],
        moving: squareMoving,
        settings: DEFAULT_IRREGULAR_NESTING_SETTINGS
      },
      {
        sheet: sheet(10, 10),
        placed: [firstFixed, secondFixed],
        moving: squareMoving,
        settings: DEFAULT_IRREGULAR_NESTING_SETTINGS
      },
      {
        sheet: sheet(40, 40),
        placed: [asymmetricFixed],
        moving: asymmetricMoving,
        settings: DEFAULT_IRREGULAR_NESTING_SETTINGS
      }
    ]

    for (const input of cases) {
      const referenceCandidates = await generateCandidatesWithPruning(input, 'reference')
      const indexedCandidates = await generateCandidatesWithPruning(input, 'indexed')

      expect(indexedCandidates).toEqual(referenceCandidates)
      const candidateKeys = indexedCandidates.map(
        ({ point: candidatePoint }) => `${candidatePoint.x}:${candidatePoint.y}`
      )
      expect(new Set(candidateKeys).size).toBe(indexedCandidates.length)

      const legality = await Promise.all(
        indexedCandidates.map((candidate) =>
          Effect.runPromise(
            PlacementValidation.check({
              sheet: input.sheet,
              placed: input.placed,
              moving: input.moving,
              candidate
            })
          )
        )
      )
      expect(legality.every((isLegal) => isLegal)).toBe(true)
    }
  })

  it.each([100, 200])(
    'preserves unfiltered pre-Volta candidate and legality parity for a %i-piece workload',
    async (pieceCount) => {
      const moving = transformedGeometry(`moving-workload-${pieceCount}`, [
        point(0, 0),
        point(2, 0),
        point(2, 2),
        point(0, 2)
      ])
      const placed = workloadPlacedPieces(pieceCount)
      const input: GeneratePlacementCandidatesInput = {
        sheet: sheet(1000, 1000),
        placed,
        moving,
        settings: DEFAULT_IRREGULAR_NESTING_SETTINGS
      }
      const indexedInput: GeneratePlacementCandidatesInput = {
        ...input,
        placedCollisionIndex: makePlacedCollisionSpatialIndex(placed)
      }

      const referenceCandidates = await generateCandidatesWithPruning(input, 'reference')
      const indexedCandidates = await generateCandidatesWithPruning(indexedInput, 'reference')

      expect(indexedCandidates).toEqual(referenceCandidates)

      const directLegality = await Promise.all(
        referenceCandidates.map((candidate) =>
          Effect.runPromise(PlacementValidation.check({ ...input, candidate }))
        )
      )
      const indexedLegality = await Promise.all(
        indexedCandidates.map((candidate) =>
          Effect.runPromise(PlacementValidation.check({ ...indexedInput, candidate }))
        )
      )

      expect(indexedLegality).toEqual(directLegality)
      expect(indexedLegality.every((isLegal) => isLegal)).toBe(true)
    },
    30_000
  )

  it('rejects an IFP when the transformed polygon cannot fit', async () => {
    const moving = transformedGeometry('too-wide', [
      point(-1, 0),
      point(11, 0),
      point(11, 2),
      point(-1, 2)
    ])

    const failure = await captureFailure(computeIfpBounds({ sheet: sheet(10, 10), moving }))

    expect(failure).toBeInstanceOf(IrregularGeometryInfeasibleError)
    expect(failure).not.toBeInstanceOf(IrregularGeometryInputError)
    if (!(failure instanceof IrregularGeometryInfeasibleError))
      throw new Error('expected geometry infeasible error')
    expect(failure._tag).toBe('IrregularGeometryInfeasibleError')
    expect(failure.message).toBe('moving polygon cannot fit inside the sheet.')
  })

  it('recomputes IFP bounds from the polygon instead of trusting stale cached bounds', async () => {
    const moving = transformedGeometry(
      'stale-bounds',
      [point(0, 0), point(4, 0), point(4, 4), point(0, 4)],
      new IrregularBounds({ minX: 0, minY: 0, maxX: 2, maxY: 2 })
    )

    const failure = await captureFailure(computeIfpBounds({ sheet: sheet(3, 3), moving }))

    expect(failure).toBeInstanceOf(IrregularGeometryInfeasibleError)
    expect(failure).not.toBeInstanceOf(IrregularGeometryInputError)
    if (!(failure instanceof IrregularGeometryInfeasibleError))
      throw new Error('expected geometry infeasible error')
    expect(failure._tag).toBe('IrregularGeometryInfeasibleError')
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
    expect(candidates.every((candidate) => candidate instanceof IrregularPlacementCandidate)).toBe(
      true
    )
    expect(candidates.every(({ diagnostics }) => diagnostics.length === 0)).toBe(true)
  })

  it('memoizes legal points by geometry and remaps current candidate metadata', async () => {
    const values = new Map<string, unknown>()
    const counters: CacheCounters = { gets: 0, sets: 0, removes: 0 }
    const currentSheet = sheet(10, 10)
    const fixed = placedPiece(
      'fixed-memo',
      [point(0, 0), point(2, 0), point(2, 2), point(0, 2)],
      4,
      4
    )
    const interchangeableFixedCopy = placedPiece(
      'fixed-memo-copy',
      fixed.collisionGeometry.polygon.points,
      4,
      4
    )
    const firstMoving = transformedGeometry(
      'moving-memo-first',
      [point(0, 0), point(2, 0), point(2, 2), point(0, 2)],
      undefined,
      transform(0, 0, false)
    )
    const secondTransform = transform(7, 0, false)
    const secondMoving = transformedGeometry(
      'moving-memo-second',
      firstMoving.polygon.points,
      firstMoving.bounds,
      secondTransform
    )
    const firstScope = new IrregularNfpIfpCandidateMemoScope()
    const secondScope = new IrregularNfpIfpCandidateMemoScope()
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* NfpIfpService
        const first = yield* service.generatePlacementCandidates({
          sheet: currentSheet,
          placed: [fixed],
          moving: firstMoving,
          settings: DEFAULT_IRREGULAR_NESTING_SETTINGS,
          candidateMemoScope: firstScope
        })
        const getsAfterFirst = counters.gets
        const second = yield* service.generatePlacementCandidates({
          sheet: currentSheet,
          placed: [interchangeableFixedCopy],
          moving: secondMoving,
          settings: DEFAULT_IRREGULAR_NESTING_SETTINGS,
          candidateMemoScope: firstScope
        })
        const getsAfterMemoHit = counters.gets
        yield* service.generatePlacementCandidates({
          sheet: currentSheet,
          placed: [interchangeableFixedCopy],
          moving: secondMoving,
          settings: DEFAULT_IRREGULAR_NESTING_SETTINGS,
          candidateMemoScope: secondScope
        })
        return { first, second, getsAfterFirst, getsAfterMemoHit, getsAfterNewScope: counters.gets }
      }).pipe(
        Effect.provide(makeNfpIfpServiceLayer()),
        Effect.provide(cacheLayer(values, counters))
      )
    )

    expect(candidatePoints(result.second)).toEqual(candidatePoints(result.first))
    expect(result.second.every(({ pieceId }) => pieceId === secondMoving.sourcePieceId)).toBe(true)
    expect(result.second.every(({ transform }) => transform.index === secondTransform.index)).toBe(true)
    expect(result.getsAfterMemoHit).toBe(result.getsAfterFirst)
    expect(result.getsAfterNewScope).toBeGreaterThan(result.getsAfterMemoHit)
  })

  it('keeps floating-point construction identity exact in legal-candidate memo keys', () => {
    const currentSheet = sheet(10, 10)
    const fixedPoints = [point(0, 0), point(2, 0), point(2, 2), point(0, 2)]
    const moving = transformedGeometry('moving-exact-memo-key', fixedPoints)
    const baseInput = {
      sheet: currentSheet,
      placed: [placedPiece('fixed-exact-memo-key', fixedPoints, 4, 4)],
      moving,
      settings: DEFAULT_IRREGULAR_NESTING_SETTINGS
    }
    const cyclicRingInput = {
      ...baseInput,
      placed: [
        placedPiece(
          'fixed-exact-memo-key-cyclic',
          [point(2, 0), point(2, 2), point(0, 2), point(0, 0)],
          4,
          4
        )
      ]
    }
    const shiftedLocalOriginInput = {
      ...baseInput,
      placed: [
        placedPiece(
          'fixed-exact-memo-key-shifted',
          [point(1, 0), point(3, 0), point(3, 2), point(1, 2)],
          3,
          4
        )
      ]
    }
    const additionalFixed = placedPiece(
      'fixed-exact-memo-key-additional',
      fixedPoints,
      7,
      4
    )
    const orderedPlacedInput = {
      ...baseInput,
      placed: [...baseInput.placed, additionalFixed]
    }
    const reversedPlacedInput = {
      ...baseInput,
      placed: [additionalFixed, ...baseInput.placed]
    }
    const key = (input: GeneratePlacementCandidatesInput) =>
      legalPlacementCandidateMemoKey(input, 'vertex-pair-hull', 'indexed')

    expect(key(cyclicRingInput)).not.toBe(key(baseInput))
    expect(key(shiftedLocalOriginInput)).not.toBe(key(baseInput))
    expect(key(reversedPlacedInput)).not.toBe(key(orderedPlacedInput))
  })

  it('preserves uncached service behavior when no decoder memo scope is supplied', async () => {
    const values = new Map<string, unknown>()
    const counters: CacheCounters = { gets: 0, sets: 0, removes: 0 }
    const input = {
      sheet: sheet(10, 10),
      placed: [
        placedPiece(
          'fixed-without-memo-scope',
          [point(0, 0), point(2, 0), point(2, 2), point(0, 2)],
          4,
          4
        )
      ],
      moving: transformedGeometry('moving-without-memo-scope', [
        point(0, 0),
        point(2, 0),
        point(2, 2),
        point(0, 2)
      ]),
      settings: DEFAULT_IRREGULAR_NESTING_SETTINGS
    }
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* NfpIfpService
        const first = yield* service.generatePlacementCandidates(input)
        const getsAfterFirst = counters.gets
        const second = yield* service.generatePlacementCandidates(input)
        return { first, second, getsAfterFirst, getsAfterSecond: counters.gets }
      }).pipe(
        Effect.provide(makeNfpIfpServiceLayer()),
        Effect.provide(cacheLayer(values, counters))
      )
    )

    expect(candidatePoints(result.second)).toEqual(candidatePoints(result.first))
    expect(result.getsAfterSecond).toBeGreaterThan(result.getsAfterFirst)
  })

  it('checks cooperative control on memo hits and never memoizes an aborted generation', async () => {
    const values = new Map<string, unknown>()
    const counters: CacheCounters = { gets: 0, sets: 0, removes: 0 }
    const currentMoving = transformedGeometry('moving-memo-control', [
      point(0, 0),
      point(2, 0),
      point(2, 2),
      point(0, 2)
    ])
    const input = {
      sheet: sheet(10, 10),
      placed: [],
      moving: currentMoving,
      settings: DEFAULT_IRREGULAR_NESTING_SETTINGS
    }
    const cachedScope = new IrregularNfpIfpCandidateMemoScope()
    const abortedScope = new IrregularNfpIfpCandidateMemoScope()
    const cachedPhases: string[] = []
    const abortedPhases: string[] = []
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* NfpIfpService
        yield* service.generatePlacementCandidates({ ...input, candidateMemoScope: cachedScope })
        const getsAfterFill = counters.gets
        const cachedFailure = yield* service
          .generatePlacementCandidates({
            ...input,
            candidateMemoScope: cachedScope,
            control: {
              checkpoint: (phase) => {
                cachedPhases.push(phase)
                return Effect.fail(
                  new IrregularNfpIfpControlAbortError({
                    reason: 'cancelled',
                    message: 'test cancellation'
                  })
                )
              }
            }
          })
          .pipe(Effect.flip)
        const getsAfterCachedAbort = counters.gets
        const abortedFailure = yield* service
          .generatePlacementCandidates({
            ...input,
            candidateMemoScope: abortedScope,
            control: {
              checkpoint: (phase) => {
                abortedPhases.push(phase)
                return Effect.fail(
                  new IrregularNfpIfpControlAbortError({
                    reason: 'deadline',
                    message: 'test deadline'
                  })
                )
              }
            }
          })
          .pipe(Effect.flip)
        const getsAfterUncachedAbort = counters.gets
        const recovered = yield* service.generatePlacementCandidates({
          ...input,
          candidateMemoScope: abortedScope
        })
        return {
          cachedFailure,
          abortedFailure,
          recovered,
          getsAfterFill,
          getsAfterCachedAbort,
          getsAfterUncachedAbort,
          getsAfterRecovery: counters.gets
        }
      }).pipe(
        Effect.provide(makeNfpIfpServiceLayer()),
        Effect.provide(cacheLayer(values, counters))
      )
    )

    expect(result.cachedFailure).toBeInstanceOf(IrregularNfpIfpControlAbortError)
    expect(cachedPhases).toEqual(['candidate-points'])
    expect(result.getsAfterCachedAbort).toBe(result.getsAfterFill)
    expect(result.abortedFailure).toBeInstanceOf(IrregularNfpIfpControlAbortError)
    expect(abortedPhases).toEqual(['ifp'])
    expect(result.getsAfterUncachedAbort).toBe(result.getsAfterCachedAbort)
    expect(result.recovered).not.toHaveLength(0)
    expect(result.getsAfterRecovery).toBeGreaterThan(result.getsAfterUncachedAbort)
  })

  it('propagates cooperative aborts through placed-NFP and pairwise boundary work', async () => {
    const moving = transformedGeometry('moving-controlled', [
      point(0, 0),
      point(2, 0),
      point(2, 2),
      point(0, 2)
    ])
    const firstFixed = placedPiece(
      'fixed-controlled-first',
      [point(0, 0), point(2, 0), point(2, 2), point(0, 2)],
      4,
      4
    )
    const secondFixed = placedPiece(
      'fixed-controlled-second',
      [point(0, 0), point(2, 0), point(2, 2), point(0, 2)],
      4,
      4
    )
    const phases: string[] = []
    const controlledInput: GeneratePlacementCandidatesInput = {
      sheet: sheet(10, 10),
      placed: [firstFixed, secondFixed],
      moving,
      settings: DEFAULT_IRREGULAR_NESTING_SETTINGS,
      control: {
        checkpoint: (phase) => {
          phases.push(phase)
          return phase === 'pairwise-nfp-boundary-intersection'
            ? Effect.fail(
                new IrregularNfpIfpControlAbortError({
                  reason: 'deadline',
                  message: 'test deadline'
                })
              )
            : Effect.void
        }
      }
    }
    type ControlledCandidateError = Effect.Error<
      ReturnType<typeof generateCandidatesEffect>
    >
    expectTypeOf<IrregularNfpIfpControlAbortError>().toMatchTypeOf<
      ControlledCandidateError
    >()

    const failure = await captureFailure(
      Effect.runPromise(
        generateCandidatesEffect(controlledInput).pipe(Effect.provide(NfpIfpServiceLive))
      )
    )

    expect(failure).toBeInstanceOf(IrregularNfpIfpControlAbortError)
    expect(phases).toContain('placed-nfp')
    expect(phases).toContain('pairwise-nfp-boundary-intersection')
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
      point(4, 2),
      point(6, 2),
      point(2, 4),
      point(6, 4),
      point(2, 6),
      point(4, 6),
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
      point(7, 0),
      point(8, 0),
      point(5, 2),
      point(5, 4),
      point(5, 6),
      point(7, 6),
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
      point(7, 0),
      point(8, 0),
      point(2, 2),
      point(4, 2),
      point(5, 2),
      point(2, 4),
      point(6, 4),
      point(7, 4),
      point(8, 4),
      point(2, 6),
      point(4, 6),
      point(6, 6),
      point(0, 8),
      point(8, 8)
    ])
  })

  it('recovers a finite candidate when a near-parallel crossing denominator rounds to zero', async () => {
    const moving = transformedGeometry('moving-near-parallel-intersection', [
      point(0, 0),
      point(2, 0),
      point(2, 2),
      point(0, 2)
    ])
    const firstFixed = placedPiece(
      'first-near-parallel-intersection',
      [point(0, 0), point(2, 0), point(2, 2), point(0, 2)],
      0,
      0
    )
    const secondFixed = placedPiece(
      'second-near-parallel-intersection',
      [point(0, 0), point(3, 0), point(3, 2), point(0, 2)],
      0,
      0
    )
    const firstStart = point(0, 0)
    const firstEnd = point(1684.3634304823354, 1393.2255685795099)
    const secondStart = point(20.360831287689507, 16.841514268342394)
    const secondEnd = point(1664.0025991946459, 1376.3840543111673)
    const firstBoundary = polygon([
      firstStart,
      firstEnd,
      point(firstEnd.x - 100, firstEnd.y + 100),
      point(firstStart.x - 100, firstStart.y + 100)
    ])
    const secondBoundary = polygon([
      secondStart,
      secondEnd,
      point(secondEnd.x - 100, secondEnd.y + 100),
      point(secondStart.x - 100, secondStart.y + 100)
    ])
    const values = new Map<string, unknown>()
    for (const [fixed, boundary] of [
      [firstFixed, firstBoundary],
      [secondFixed, secondBoundary]
    ] as const) {
      values.set(
        cacheKeyToString(
          pairwiseNfpCacheKey(
            { fixed, moving, settings: DEFAULT_IRREGULAR_GEOMETRY_SETTINGS },
            'vertex-pair-hull'
          )
        ),
        boundary
      )
    }

    const candidates = await generateCandidatesWithCache(
      {
        sheet: sheet(2000, 1700),
        placed: [firstFixed, secondFixed],
        moving,
        settings: DEFAULT_IRREGULAR_NESTING_SETTINGS
      },
      values
    )
    const firstDirectionX = firstEnd.x - firstStart.x
    const firstDirectionY = firstEnd.y - firstStart.y
    const secondDirectionX = secondEnd.x - secondStart.x
    const secondDirectionY = secondEnd.y - secondStart.y
    const denominator =
      firstDirectionX * secondDirectionY - firstDirectionY * secondDirectionX
    const startArea =
      firstDirectionX * (secondStart.y - firstStart.y) -
      firstDirectionY * (secondStart.x - firstStart.x)
    const endArea =
      firstDirectionX * (secondEnd.y - firstStart.y) -
      firstDirectionY * (secondEnd.x - firstStart.x)
    const fallbackParameter = startArea / (startArea - endArea)
    const expectedIntersection = point(
      secondStart.x + fallbackParameter * secondDirectionX,
      secondStart.y + fallbackParameter * secondDirectionY
    )
    const canonicalIntersectionAlternatives = canonicalPlacementPointAlternatives(
      expectedIntersection
    )
    const admittedPoints = candidatePoints(candidates)

    expect(denominator).toBe(0)
    expect(
      admittedPoints.some((admitted) =>
        canonicalIntersectionAlternatives.some(
          (alternative) =>
            alternative.x === admitted.x && alternative.y === admitted.y
        )
      )
    ).toBe(true)
  })

  it('preserves an error result when crossing arithmetic overflows', () => {
    const result = NfpBoundaryAlgorithms.segmentIntersection(
      point(-1e308, 0),
      point(1e308, 0),
      point(0, -1),
      point(0, 1)
    )

    expect(result).toEqual({
      message: 'segment intersection arithmetic must produce finite coordinates.'
    })
  })

  it('preserves candidates when disjoint NFP bounds skip pair intersections', async () => {
    const moving = transformedGeometry('moving-disjoint-nfps', [
      point(0, 0),
      point(2, 0),
      point(2, 2),
      point(0, 2)
    ])
    const firstFixed = placedPiece(
      'first-disjoint-nfp',
      [point(0, 0), point(2, 0), point(2, 2), point(0, 2)],
      0,
      0
    )
    const secondFixed = placedPiece(
      'second-disjoint-nfp',
      [point(0, 0), point(2, 0), point(2, 2), point(0, 2)],
      8,
      8
    )

    const candidates = await generateCandidates({
      sheet: sheet(10, 10),
      placed: [firstFixed, secondFixed],
      moving,
      settings: DEFAULT_IRREGULAR_NESTING_SETTINGS
    })

    expect(candidatePoints(candidates)).toEqual([
      point(2, 0),
      point(8, 0),
      point(0, 2),
      point(2, 2),
      point(6, 6),
      point(8, 6),
      point(0, 8),
      point(6, 8)
    ])
  })

  it('keeps candidate generation identical with a persistent placed-collision index', async () => {
    const moving = transformedGeometry('moving-index-parity', [
      point(0, 0),
      point(2, 0),
      point(2, 2),
      point(0, 2)
    ])
    const nearby = placedPiece(
      'nearby-index-parity',
      [point(0, 0), point(2, 0), point(2, 2), point(0, 2)],
      4,
      4
    )
    const outsideSheet = placedPiece(
      'outside-index-parity',
      [point(0, 0), point(2, 0), point(2, 2), point(0, 2)],
      100,
      100
    )
    const placed = [nearby, outsideSheet]
    const input = {
      sheet: sheet(10, 10),
      placed,
      moving,
      settings: DEFAULT_IRREGULAR_NESTING_SETTINGS
    }

    const withoutIndex = await generateCandidates(input)
    const withIndex = await generateCandidates({
      ...input,
      placedCollisionIndex: makePlacedCollisionSpatialIndex(placed)
    })

    expect(withIndex).toEqual(withoutIndex)
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
