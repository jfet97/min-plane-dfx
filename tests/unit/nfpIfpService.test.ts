import { Effect, Layer } from 'effect'
import { describe, expect, expectTypeOf, it } from 'vitest'
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
import {
  DEFAULT_IRREGULAR_GEOMETRY_SETTINGS,
  DEFAULT_IRREGULAR_NESTING_SETTINGS
} from '@shared/irregular/defaults.js'
import type {
  NfpBoundaryConstructionResult,
  NfpConstructionAlgorithm
} from '../../src/workers/irregular/nfpIfpService.js'
import {
  canonicalizeTranslatedConvexRing,
  makeNfpIfpServiceLive,
  makeNfpIfpServiceLayer,
  NfpBoundaryAlgorithms,
  NfpIfpServiceLive
} from '../../src/workers/irregular/nfpIfpService.js'
import { pairwiseNfpCacheKey } from '../../src/workers/irregular/geometryCacheKeys.js'
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
  IrregularNfpIfpControlAbortError,
  NfpIfpService
} from '../../src/workers/irregular/services.js'

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
