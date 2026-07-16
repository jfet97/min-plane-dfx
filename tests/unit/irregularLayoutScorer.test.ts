import { Effect, Layer } from 'effect'
import { describe, expect, it } from 'vitest'
import { DxfGeometrySummary, ImportedPiece } from '@shared/domain/dxf.js'
import { Rect } from '@shared/domain/geometry.js'
import { PieceId } from '@shared/domain/ids.js'
import { SourceFileId } from '@shared/domain/ids.js'
import { SheetSpec } from '@shared/domain/nesting.js'
import {
  CollisionGeometry,
  FreeMaterialSnapshot,
  IrregularBounds,
  IrregularPlacedPiece,
  IrregularPlacement,
  IrregularPoint,
  IrregularPolygon,
  IrregularPreparedPiece,
  IrregularTransform,
  IrregularTransformCandidate,
  FreeMaterialRegion,
  TransformedCollisionGeometry
} from '@shared/irregular/domain.js'
import {
  FreeMaterialService,
  IrregularGeometryInputError,
  type ComputeFreeMaterialInput,
  type ExtendFreeMaterialInput
} from '../../src/workers/irregular/services.js'
import { createFreeMaterialService } from '../../src/workers/irregular/freeMaterialService.js'
import { IrregularBeamState } from '../../src/workers/algorithm/irregular/irregularBeamState.js'
import {
  IrregularLayoutScorer,
  IrregularLayoutScoringError,
  type IrregularLayoutScore,
  type ScoreIrregularLayoutInput
} from '../../src/workers/algorithm/irregular/irregularLayoutScorer.js'
import { GeometrySettings } from '../../src/workers/irregular/geometryKernel.js'

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

function rectanglePoints(width: number, height: number): ReadonlyArray<IrregularPoint> {
  return [point(0, 0), point(width, 0), point(width, height), point(0, height)]
}

function rotatePoints(
  points: ReadonlyArray<IrregularPoint>,
  startIndex: number
): ReadonlyArray<IrregularPoint> {
  return [...points.slice(startIndex), ...points.slice(0, startIndex)]
}

function transformedGeometry(
  id: string,
  points: ReadonlyArray<IrregularPoint>
): TransformedCollisionGeometry {
  return new TransformedCollisionGeometry({
    sourcePieceId: PieceId.make(id),
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

function placedPolygon(
  id: string,
  points: ReadonlyArray<IrregularPoint>,
  translateX: number,
  translateY: number
): IrregularPlacedPiece {
  return new IrregularPlacedPiece({
    placement: new IrregularPlacement({
      sourcePieceId: PieceId.make(id),
      transform: new IrregularTransform({
        translateX,
        translateY,
        rotationDeg: 0,
        mirrored: false
      })
    }),
    collisionGeometry: transformedGeometry(id, points)
  })
}

function placedRectangle(
  id: string,
  width: number,
  height: number,
  translateX: number,
  translateY: number
): IrregularPlacedPiece {
  return placedPolygon(id, rectanglePoints(width, height), translateX, translateY)
}

function preparedPiece(id: string): IrregularPreparedPiece {
  const points = rectanglePoints(1, 1)
  const geometry = new CollisionGeometry({
    sourcePieceId: PieceId.make(id),
    sourceBounds: bounds(points),
    sampledPoints: points,
    convexHull: polygon(points),
    collisionPolygon: polygon(points),
    placementReference: point(0, 0),
    diagnostics: []
  })
  return new IrregularPreparedPiece({
    source: new ImportedPiece({
      id: PieceId.make(id),
      sourceFileId: SourceFileId.make(`source-${id}`),
      label: id,
      realBounds: new Rect({ x: 0, y: 0, width: 1, height: 1 }),
      geometry: new DxfGeometrySummary({
        entityType: 'PRESET_SHAPE',
        closed: true,
        segments: []
      }),
      warnings: []
    }),
    allowMirror: false,
    collisionGeometry: geometry,
    transforms: []
  })
}

function input(state: IrregularBeamState): ScoreIrregularLayoutInput {
  return {
    sheet: new SheetSpec({ width: 10, height: 10, label: 'layout scorer test sheet' }),
    state
  }
}

function state(
  placed: ReadonlyArray<IrregularPlacedPiece>,
  unplacedSourcePieceIds: ReadonlyArray<string> = [],
  placementOrder: ReadonlyArray<string> = placed.map(({ placement }) => placement.sourcePieceId)
): IrregularBeamState {
  return new IrregularBeamState({
    remainingPreparedPieces: [],
    placedCollisionGeometries: placed,
    unplacedSourcePieceIds: unplacedSourcePieceIds.map(PieceId.make),
    placementOrder: placementOrder.map(PieceId.make)
  })
}

function scoreWith(
  scorerLayer: Layer.Layer<IrregularLayoutScorer, never, GeometrySettings>,
  value: ScoreIrregularLayoutInput
): Promise<IrregularLayoutScore> {
  return Effect.runPromise(
    IrregularLayoutScorer.use((scorer) => scorer.scoreState(value)).pipe(
      Effect.provide(scorerLayer),
      Effect.provide(GeometrySettings.Live)
    )
  )
}

function score(
  value: ScoreIrregularLayoutInput | IrregularBeamState
): Promise<IrregularLayoutScore> {
  return scoreWith(
    IrregularLayoutScorer.Live,
    value instanceof IrregularBeamState ? input(value) : value
  )
}

function materialSnapshot(
  snapshot: FreeMaterialSnapshot
): Layer.Layer<IrregularLayoutScorer, never, GeometrySettings> {
  const service = Layer.succeed(FreeMaterialService, {
    computeFreeMaterial: (_input: ComputeFreeMaterialInput) => Effect.succeed(snapshot),
    extendFreeMaterial: (_input) => Effect.succeed(snapshot)
  })
  return IrregularLayoutScorer.Layer.pipe(Layer.provide(service))
}

async function makeScorer(
  computeFreeMaterial: (input: ComputeFreeMaterialInput) => Effect.Effect<FreeMaterialSnapshot>,
  settingsLayer: Layer.Layer<GeometrySettings, never, never> = GeometrySettings.Live
): Promise<IrregularLayoutScorer.Service> {
  const defaultFreeMaterialService = createFreeMaterialService('union-then-difference')
  const service = Layer.succeed(FreeMaterialService, {
    computeFreeMaterial,
    extendFreeMaterial: defaultFreeMaterialService.extendFreeMaterial
  })
  return Effect.runPromise(
    IrregularLayoutScorer.use((scorer) => Effect.succeed(scorer)).pipe(
      Effect.provide(IrregularLayoutScorer.Layer.pipe(Layer.provide(service))),
      Effect.provide(settingsLayer)
    )
  )
}

function scoreWithService(
  scorer: IrregularLayoutScorer.Service,
  value: ScoreIrregularLayoutInput
): Promise<IrregularLayoutScore> {
  return Effect.runPromise(
    scorer.scoreState(value).pipe(Effect.provide(Layer.succeed(IrregularLayoutScorer, scorer)))
  )
}

describe('IrregularLayoutScorer', () => {
  it('lets unplaced count dominate every prettier layout', async () => {
    const complete = await score(state([placedRectangle('placed', 8, 8, 0, 0)]))
    const incomplete = await score(state([placedRectangle('placed', 1, 1, 0, 0)], ['missing']))

    expect(IrregularLayoutScorer.Make).toBeDefined()
    expect(incomplete.unplacedCount).toBe(1)
    expect(complete.unplacedCount).toBe(0)
    const comparison = await compareScores(complete, incomplete)
    expect(comparison).toBeLessThan(0)
  })

  it('orders equal-count states by real free-material usability and fragmentation metrics', async () => {
    const preserved = await score(
      state([placedRectangle('left', 2, 8, 0, 0), placedRectangle('right', 2, 8, 8, 0)])
    )
    const fragmented = await score(
      state([
        placedRectangle('barrier', 2, 10, 4, 0),
        placedRectangle('left-corner', 2, 2, 0, 0)
      ])
    )

    expect(preserved.unplacedCount).toBe(fragmented.unplacedCount)
    expect(preserved.placementOrder).toHaveLength(fragmented.placementOrder.length)
    expect(preserved.largestNetFreeMaterialRegionAreaMm2).toBeGreaterThan(
      fragmented.largestNetFreeMaterialRegionAreaMm2
    )
    expect(preserved.freeMaterialRegionCount).toBeLessThan(fragmented.freeMaterialRegionCount)
    expect(preserved.freeMaterialHoleCount).toBeLessThanOrEqual(fragmented.freeMaterialHoleCount)
    expect(preserved.freeMaterialSliverMetric).toBeLessThan(fragmented.freeMaterialSliverMetric)
    expect(IrregularLayoutScorer.Make).toBeDefined()
    expect(await compareScores(preserved, fragmented)).toBeLessThan(0)
  })

  it('uses compact collision bounds only after free-material metrics tie', async () => {
    const snapshot = new FreeMaterialSnapshot({
      sheet: new SheetSpec({ width: 10, height: 10, label: 'snapshot sheet' }),
      regions: [
        new FreeMaterialRegion({
          boundary: polygon(rectanglePoints(10, 10)),
          holes: []
        })
      ],
      diagnostics: []
    })
    const compact = state([placedRectangle('compact', 2, 2, 0, 0)])
    const wide = state([placedRectangle('wide', 2, 2, 8, 8)])
    const compactScore = await scoreWith(materialSnapshot(snapshot), input(compact))
    const wideScore = await scoreWith(materialSnapshot(snapshot), input(wide))

    expect(compactScore.largestNetFreeMaterialRegionAreaMm2).toBe(
      wideScore.largestNetFreeMaterialRegionAreaMm2
    )
    expect(await compareScores(compactScore, wideScore)).toBeLessThan(0)
  })

  it('keeps exact numeric ties deterministic by placement order and source ids', async () => {
    const first = await score(input(state([placedRectangle('a', 2, 2, 0, 0)], [], ['a', 'b'])))
    const second = await score(input(state([placedRectangle('a', 2, 2, 0, 0)], [], ['a', 'c'])))
    const repeated = await score(input(state([placedRectangle('a', 2, 2, 0, 0)], [], ['a', 'c'])))

    expect(await compareScores(first, second)).toBeLessThan(0)
    expect(await compareScores(second, repeated)).toBe(0)
  })

  it('uses unplaced source ids as the final deterministic tie-break', async () => {
    const first = await score(state([], ['a']))
    const second = await score(state([], ['b']))

    expect(await compareScores(first, second)).toBeLessThan(0)
  })

  it('accepts empty free material without producing a non-finite score', async () => {
    const snapshot = new FreeMaterialSnapshot({
      sheet: new SheetSpec({ width: 10, height: 10, label: 'empty snapshot sheet' }),
      regions: [],
      diagnostics: []
    })

    const result = await scoreWith(materialSnapshot(snapshot), input(state([])))

    expect(result.largestNetFreeMaterialRegionAreaMm2).toBe(0)
    expect(result.freeMaterialSliverMetric).toBe(0)
  })

  it('consumes concave and holed snapshots as metrics, never as placement proof', async () => {
    const snapshot = new FreeMaterialSnapshot({
      sheet: new SheetSpec({ width: 10, height: 10, label: 'snapshot sheet' }),
      regions: [
        new FreeMaterialRegion({
          boundary: polygon([
            point(0, 0),
            point(10, 0),
            point(10, 10),
            point(6, 10),
            point(6, 4),
            point(0, 4)
          ]),
          holes: [polygon([point(1, 1), point(2, 1), point(2, 2), point(1, 2)])]
        })
      ],
      diagnostics: []
    })
    const scorerInput = input(
      new IrregularBeamState({
        remainingPreparedPieces: [preparedPiece('not-yet-placed')],
        placedCollisionGeometries: [],
        unplacedSourcePieceIds: [],
        placementOrder: []
      })
    )
    const result = await scoreWith(materialSnapshot(snapshot), scorerInput)

    expect(result.freeMaterialRegionCount).toBe(1)
    expect(result.freeMaterialHoleCount).toBe(1)
    expect(result.freeMaterialSliverMetric).toBeGreaterThan(0)
    expect(result.unplacedCount).toBe(0)
  })

  it('fails with a typed scoring error when derived metrics are non-finite', async () => {
    const invalidSnapshot = new FreeMaterialSnapshot({
      sheet: new SheetSpec({ width: 10, height: 10, label: 'snapshot sheet' }),
      regions: [
        new FreeMaterialRegion({
          boundary: polygon([]),
          holes: []
        })
      ],
      diagnostics: []
    })

    const failure = await Effect.runPromise(
      IrregularLayoutScorer.use((scorer) => scorer.scoreState(input(state([])))).pipe(
        Effect.match({
          onFailure: (error) => error,
          onSuccess: () => undefined
        }),
        Effect.provide(materialSnapshot(invalidSnapshot)),
        Effect.provide(GeometrySettings.Live)
      )
    )

    expect(failure).toBeInstanceOf(IrregularLayoutScoringError)
    if (failure instanceof IrregularLayoutScoringError) {
      expect(failure.operation).toBe('scoreState')
    }
  })

  it('reuses free material for identical geometry while rebuilding path data', async () => {
    const snapshot = new FreeMaterialSnapshot({
      sheet: new SheetSpec({ width: 10, height: 10, label: 'snapshot sheet' }),
      regions: [],
      diagnostics: []
    })
    let calls = 0
    const scorer = await makeScorer((_) => {
      calls += 1
      return Effect.succeed(snapshot)
    })

    const first = await scoreWithService(
      scorer,
      input(state([placedRectangle('first', 2, 2, 1, 1)]))
    )
    const second = await scoreWithService(
      scorer,
      input(state([placedRectangle('second', 2, 2, 1, 1)], ['unplaced'], ['second']))
    )

    expect(calls).toBe(1)
    expect(first.placementOrder).toEqual([PieceId.make('first')])
    expect(first.unplacedSourcePieceIds).toEqual([])
    expect(second.placementOrder).toEqual([PieceId.make('second')])
    expect(second.unplacedSourcePieceIds).toEqual([PieceId.make('unplaced')])
    expect(second.unplacedCount).toBe(1)
  })

  it('extends a cached parent snapshot and preserves independent full score metrics', async () => {
    const fullService = createFreeMaterialService('union-then-difference')
    let fullCalls = 0
    let incrementalCalls = 0
    const service = Layer.succeed(FreeMaterialService, {
      computeFreeMaterial: (value: ComputeFreeMaterialInput) => {
        fullCalls += 1
        return fullService.computeFreeMaterial(value)
      },
      extendFreeMaterial: (value: ExtendFreeMaterialInput) => {
        incrementalCalls += 1
        return fullService.extendFreeMaterial(value)
      }
    })
    const scorer = await Effect.runPromise(
      IrregularLayoutScorer.use((instance) => Effect.succeed(instance)).pipe(
        Effect.provide(IrregularLayoutScorer.Layer.pipe(Layer.provide(service))),
        Effect.provide(GeometrySettings.Live)
      )
    )
    const parent = state([placedRectangle('parent', 2, 2, 2, 2)])
    const child = parent.withPlacement({
      remainingPreparedPieces: [],
      placedCollisionGeometry: placedRectangle('child', 2, 2, 6, 4),
      placementOrderPieceId: PieceId.make('child')
    })

    await scoreWithService(scorer, input(parent))
    const incrementalScore = await scoreWithService(scorer, input(child))
    const independentFullScore = await score(input(state(child.placedCollisionGeometries)))

    expect(fullCalls).toBe(1)
    expect(incrementalCalls).toBe(1)
    expect(incrementalScore.freeMaterialSnapshot).toEqual(independentFullScore.freeMaterialSnapshot)
    expect({
      unplacedCount: incrementalScore.unplacedCount,
      largestNetFreeMaterialRegionAreaMm2: incrementalScore.largestNetFreeMaterialRegionAreaMm2,
      freeMaterialRegionCount: incrementalScore.freeMaterialRegionCount,
      freeMaterialHoleCount: incrementalScore.freeMaterialHoleCount,
      freeMaterialSliverMetric: incrementalScore.freeMaterialSliverMetric,
      collisionBoundsWorstNormalizedSheetConsumption:
        incrementalScore.collisionBoundsWorstNormalizedSheetConsumption,
      collisionBoundsNormalizedSpanSum: incrementalScore.collisionBoundsNormalizedSpanSum,
      collisionBoundsAreaMm2: incrementalScore.collisionBoundsAreaMm2,
      collisionBoundsSpanMm: incrementalScore.collisionBoundsSpanMm
    }).toEqual({
      unplacedCount: independentFullScore.unplacedCount,
      largestNetFreeMaterialRegionAreaMm2: independentFullScore.largestNetFreeMaterialRegionAreaMm2,
      freeMaterialRegionCount: independentFullScore.freeMaterialRegionCount,
      freeMaterialHoleCount: independentFullScore.freeMaterialHoleCount,
      freeMaterialSliverMetric: independentFullScore.freeMaterialSliverMetric,
      collisionBoundsWorstNormalizedSheetConsumption:
        independentFullScore.collisionBoundsWorstNormalizedSheetConsumption,
      collisionBoundsNormalizedSpanSum: independentFullScore.collisionBoundsNormalizedSpanSum,
      collisionBoundsAreaMm2: independentFullScore.collisionBoundsAreaMm2,
      collisionBoundsSpanMm: independentFullScore.collisionBoundsSpanMm
    })
  })

  it('falls back to full material computation when incremental extension fails', async () => {
    const fullService = createFreeMaterialService('union-then-difference')
    let fullCalls = 0
    let incrementalCalls = 0
    const service = Layer.succeed(FreeMaterialService, {
      computeFreeMaterial: (value: ComputeFreeMaterialInput) => {
        fullCalls += 1
        return fullService.computeFreeMaterial(value)
      },
      extendFreeMaterial: (_value: ExtendFreeMaterialInput) => {
        incrementalCalls += 1
        return Effect.fail(
          new IrregularGeometryInputError({
            operation: 'extendFreeMaterial',
            message: 'incremental geometry failed'
          })
        )
      }
    })
    const scorer = await Effect.runPromise(
      IrregularLayoutScorer.use((instance) => Effect.succeed(instance)).pipe(
        Effect.provide(IrregularLayoutScorer.Layer.pipe(Layer.provide(service))),
        Effect.provide(GeometrySettings.Live)
      )
    )
    const parent = state([placedRectangle('parent-fallback', 2, 2, 2, 2)])
    const child = parent.withPlacement({
      remainingPreparedPieces: [],
      placedCollisionGeometry: placedRectangle('child-fallback', 2, 2, 6, 4),
      placementOrderPieceId: PieceId.make('child-fallback')
    })

    await scoreWithService(scorer, input(parent))
    const fallbackScore = await scoreWithService(scorer, input(child))
    const independentFullScore = await score(input(state(child.placedCollisionGeometries)))

    expect(fullCalls).toBe(2)
    expect(incrementalCalls).toBe(1)
    expect(fallbackScore.freeMaterialSnapshot).toEqual(
      independentFullScore.freeMaterialSnapshot
    )
    expect({
      unplacedCount: fallbackScore.unplacedCount,
      largestNetFreeMaterialRegionAreaMm2: fallbackScore.largestNetFreeMaterialRegionAreaMm2,
      freeMaterialRegionCount: fallbackScore.freeMaterialRegionCount,
      freeMaterialHoleCount: fallbackScore.freeMaterialHoleCount,
      freeMaterialSliverMetric: fallbackScore.freeMaterialSliverMetric,
      collisionBoundsWorstNormalizedSheetConsumption:
        fallbackScore.collisionBoundsWorstNormalizedSheetConsumption,
      collisionBoundsNormalizedSpanSum: fallbackScore.collisionBoundsNormalizedSpanSum,
      collisionBoundsAreaMm2: fallbackScore.collisionBoundsAreaMm2,
      collisionBoundsSpanMm: fallbackScore.collisionBoundsSpanMm
    }).toEqual({
      unplacedCount: independentFullScore.unplacedCount,
      largestNetFreeMaterialRegionAreaMm2:
        independentFullScore.largestNetFreeMaterialRegionAreaMm2,
      freeMaterialRegionCount: independentFullScore.freeMaterialRegionCount,
      freeMaterialHoleCount: independentFullScore.freeMaterialHoleCount,
      freeMaterialSliverMetric: independentFullScore.freeMaterialSliverMetric,
      collisionBoundsWorstNormalizedSheetConsumption:
        independentFullScore.collisionBoundsWorstNormalizedSheetConsumption,
      collisionBoundsNormalizedSpanSum: independentFullScore.collisionBoundsNormalizedSpanSum,
      collisionBoundsAreaMm2: independentFullScore.collisionBoundsAreaMm2,
      collisionBoundsSpanMm: independentFullScore.collisionBoundsSpanMm
    })
  })

  it('keeps occupancy identity independent of placement order and extends bounds incrementally', () => {
    const firstPlaced = placedRectangle('first', 2, 2, 1, 1)
    const secondPlaced = placedRectangle('second', 3, 1, 5, 4)
    const parent = state([firstPlaced])
    const child = parent.withPlacement({
      remainingPreparedPieces: [],
      placedCollisionGeometry: secondPlaced,
      placementOrderPieceId: PieceId.make('second')
    })
    const rebuilt = state([firstPlaced, secondPlaced])
    const reversed = state([secondPlaced, firstPlaced], [], ['second', 'first'])

    expect(child.canonicalOccupiedGeometryKey).toBe(rebuilt.canonicalOccupiedGeometryKey)
    expect(child.canonicalOccupiedGeometryKey).toBe(reversed.canonicalOccupiedGeometryKey)
    expect(child.translatedCollisionBounds).toEqual({
      minX: 1,
      minY: 1,
      maxX: 8,
      maxY: 5,
      width: 7,
      height: 4
    })
    expect(child.translatedCollisionBounds).toEqual(rebuilt.translatedCollisionBounds)

    const unplacedChild = child.withUnplacedPiece({
      remainingPreparedPieces: [],
      unplacedPieceId: PieceId.make('unplaced')
    })
    expect(unplacedChild.canonicalOccupiedGeometryKey).toBe(child.canonicalOccupiedGeometryKey)
    expect(unplacedChild.translatedCollisionBounds).toEqual(child.translatedCollisionBounds)
  })

  it('canonicalizes translated polygon rings across cyclic starts and winding', () => {
    const points = rectanglePoints(2, 1)
    const first = state([placedPolygon('first', points, 3, 4)])
    const cyclic = state([placedPolygon('cyclic', rotatePoints(points, 2), 3, 4)])
    const reversed = state([placedPolygon('reversed', [...points].reverse(), 3, 4)])
    const negativeZero = state([
      placedPolygon('negative-zero', [point(-0, -0), point(2, -0), point(2, 1), point(-0, 1)], 0, 0)
    ])
    const zero = state([placedPolygon('zero', points, 0, 0)])

    expect(cyclic.canonicalOccupiedGeometryKey).toBe(first.canonicalOccupiedGeometryKey)
    expect(reversed.canonicalOccupiedGeometryKey).toBe(first.canonicalOccupiedGeometryKey)
    expect(negativeZero.canonicalOccupiedGeometryKey).toBe(zero.canonicalOccupiedGeometryKey)
  })

  it('does not reuse free material after geometry or sheet inputs change', async () => {
    const snapshot = new FreeMaterialSnapshot({
      sheet: new SheetSpec({ width: 10, height: 10, label: 'snapshot sheet' }),
      regions: [],
      diagnostics: []
    })
    let calls = 0
    const scorer = await makeScorer((_) => {
      calls += 1
      return Effect.succeed(snapshot)
    })
    const placed = state([placedRectangle('piece', 2, 2, 1, 1)])

    await scoreWithService(scorer, input(placed))
    await scoreWithService(scorer, input(state([placedRectangle('piece', 3, 2, 1, 1)])))
    await scoreWithService(scorer, {
      sheet: new SheetSpec({ width: 11, height: 10, label: 'layout scorer test sheet' }),
      state: placed
    })

    expect(calls).toBe(3)
  })
})

async function compareScores(
  first: IrregularLayoutScore,
  second: IrregularLayoutScore
): Promise<number> {
  const scorer = await Effect.runPromise(
    IrregularLayoutScorer.use((service) => Effect.succeed(service)).pipe(
      Effect.provide(IrregularLayoutScorer.Live),
      Effect.provide(GeometrySettings.Live)
    )
  )
  return scorer.compare(first, second)
}
