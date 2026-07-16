import { Effect, Layer } from 'effect'
import { describe, expect, it } from 'vitest'
import { Rect } from '@shared/domain/geometry.js'
import { DxfGeometrySummary, ImportedPiece } from '@shared/domain/dxf.js'
import { PieceId, SourceFileId } from '@shared/domain/ids.js'
import { SheetSpec } from '@shared/domain/nesting.js'
import {
  CollisionGeometry,
  IrregularBounds,
  IrregularNestingSettings,
  IrregularOptimizerSettings,
  IrregularPlacementCandidate,
  IrregularPoint,
  IrregularPolygon,
  IrregularPreparedPiece,
  IrregularTransformCandidate
} from '@shared/irregular/domain.js'
import { GeometryKernel, GeometrySettings } from '../../src/workers/irregular/geometryKernel.js'
import { NfpIfpServiceLive } from '../../src/workers/irregular/nfpIfpService.js'
import { NfpIfpService } from '../../src/workers/irregular/services.js'
import { IrregularLayoutScorer } from '../../src/workers/algorithm/irregular/irregularLayoutScorer.js'
import { IrregularPlacementScorer } from '../../src/workers/algorithm/irregular/irregularPlacementScorer.js'
import { decodeStrictPriorityOrder } from '../../src/workers/algorithm/irregular/strictPriorityDecoder.js'
import {
  decodeWindowedIrregularBeam,
  type IrregularWindowedBeamHooks,
  type IrregularWindowedBeamOptions
} from '../../src/workers/algorithm/irregular/windowedBeam.js'

function point(x: number, y: number): IrregularPoint {
  return new IrregularPoint({ x, y })
}

function rectangle(width: number, height: number): ReadonlyArray<IrregularPoint> {
  return [point(0, 0), point(width, 0), point(width, height), point(0, height)]
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

function source(id: string): ImportedPiece {
  return new ImportedPiece({
    id: PieceId.make(id),
    sourceFileId: SourceFileId.make(`source-${id}`),
    label: id,
    realBounds: new Rect({ x: 0, y: 0, width: 1, height: 1 }),
    geometry: new DxfGeometrySummary({ entityType: 'PRESET_SHAPE', closed: true, segments: [] }),
    warnings: []
  })
}

function preparedPiece(
  id: string,
  width: number,
  height: number,
  pieceId?: string,
  transforms?: ReadonlyArray<IrregularTransformCandidate>
): IrregularPreparedPiece {
  const points = rectangle(width, height)
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
    ...(pieceId === undefined ? {} : { pieceId: PieceId.make(pieceId) }),
    source: source(id),
    allowMirror: false,
    collisionGeometry: geometry,
    transforms:
      transforms ??
      [
        new IrregularTransformCandidate({
          index: 0,
          rotationDeg: 0,
          mirrored: false,
          reason: 'configured'
        })
      ]
  })
}

function sheet(width: number, height: number): SheetSpec {
  return new SheetSpec({ width, height, label: 'windowed beam test sheet' })
}

function settings(
  orderWindow: number,
  beamWidth = 4,
  localCandidateFanout =
    GeometrySettings.Make.optimizer.localCandidateFanout ?? GeometrySettings.Make.optimizer.beamWidth
): IrregularNestingSettings {
  return new IrregularNestingSettings({
    geometry: GeometrySettings.Make.geometry,
    optimizer: new IrregularOptimizerSettings({
      ...GeometrySettings.Make.optimizer,
      orderWindow,
      beamWidth,
      localCandidateFanout
    })
  })
}

function candidateService(
  makeCandidates: (input: {
    readonly moving: { readonly sourcePieceId: PieceId; readonly transform: IrregularTransformCandidate }
    readonly placed: ReadonlyArray<{ readonly placement: { readonly sourcePieceId: PieceId } }>
  }) => ReadonlyArray<IrregularPlacementCandidate>
): Layer.Layer<NfpIfpService, never, never> {
  return Layer.succeed(NfpIfpService, {
    computeNfp: () => Effect.die('unused in windowed beam control-flow test'),
    computeIfpBounds: () => Effect.die('unused in windowed beam control-flow test'),
    generatePlacementCandidates: (input) => Effect.succeed(makeCandidates(input))
  })
}

function oneCandidate(
  moving: { readonly sourcePieceId: PieceId; readonly transform: IrregularTransformCandidate },
  x: number,
  y = 0
): IrregularPlacementCandidate {
  return new IrregularPlacementCandidate({
    pieceId: moving.sourcePieceId,
    transform: moving.transform,
    point: point(x, y),
    diagnostics: []
  })
}

function runWindowed(
  currentSheet: SheetSpec,
  pieces: ReadonlyArray<IrregularPreparedPiece>,
  settingsLayer: Layer.Layer<GeometrySettings, never, never> = GeometrySettings.Live,
  service: Layer.Layer<NfpIfpService, never, never> = NfpIfpServiceLive,
  options?: IrregularWindowedBeamOptions,
  hooks?: IrregularWindowedBeamHooks,
  layoutScorer?: IrregularLayoutScorer.Service
) {
  const layoutScorerLayer =
    layoutScorer === undefined
      ? IrregularLayoutScorer.Live
      : Layer.succeed(IrregularLayoutScorer, layoutScorer)
  return Effect.runPromise(
    decodeWindowedIrregularBeam(currentSheet, pieces, hooks, options).pipe(
      Effect.provide(GeometryKernel.Live),
      Effect.provide(service),
      Effect.provide(IrregularPlacementScorer.Live),
      Effect.provide(layoutScorerLayer),
      Effect.provide(settingsLayer)
    )
  )
}

function stateSnapshot(result: Awaited<ReturnType<typeof runWindowed>>) {
  return result.rankedStates.map((state) => ({
    placements: state.placedCollisionGeometries.map(({ placement }) => placement),
    remaining: state.remainingPreparedPieces.map((piece) => piece.pieceId ?? piece.source.id),
    unplaced: state.unplacedPieceIds,
    order: state.placementOrder
  }))
}

describe('decodeWindowedIrregularBeam', () => {
  it('uses the injected orderWindow when selecting eligible pieces', async () => {
    const pieces = [preparedPiece('a', 1, 1), preparedPiece('b', 1, 1)]
    const calls: PieceId[] = []
    const service = candidateService(({ moving }) => {
      calls.push(moving.sourcePieceId)
      return [oneCandidate(moving, 0)]
    })

    await runWindowed(
      sheet(10, 2),
      pieces,
      Layer.succeed(GeometrySettings, settings(1, 1)),
      service
    )
    const firstWindowCalls = [...calls]
    calls.length = 0

    await runWindowed(
      sheet(10, 2),
      pieces,
      Layer.succeed(GeometrySettings, settings(2, 1)),
      service
    )

    expect(firstWindowCalls.slice(0, 1)).toEqual([PieceId.make('a')])
    expect(calls.slice(0, 2)).toEqual([PieceId.make('a'), PieceId.make('b')])
  })

  it('matches strict priority decoding when orderWindow is one', async () => {
    const pieces = [
      preparedPiece('a', 3, 3),
      preparedPiece('b', 3, 3),
      preparedPiece('c', 2, 3)
    ]
    const currentSheet = sheet(10, 4)
    const currentSettings = settings(1, 4)
    const strict = await Effect.runPromise(
      decodeStrictPriorityOrder(currentSheet, pieces).pipe(
        Effect.provide(GeometryKernel.Live),
        Effect.provide(GeometrySettings.Live),
        Effect.provide(NfpIfpServiceLive),
        Effect.provide(IrregularPlacementScorer.Live)
      )
    )
    const windowed = await runWindowed(
      currentSheet,
      pieces,
      Layer.succeed(GeometrySettings, currentSettings)
    )

    expect(windowed.bestState.placedCollisionGeometries.map(({ placement }) => placement)).toEqual(
      strict.placements
    )
    expect(windowed.bestState.unplacedPieceIds).toEqual(strict.unplacedPieceIds)
  })

  it('retains bounded local placement alternatives when the window can reorder', async () => {
    const result = await runWindowed(
      sheet(4, 1),
      [preparedPiece('a', 1, 1)],
      Layer.succeed(GeometrySettings, settings(2, 2, 2)),
      candidateService(({ moving }) => [oneCandidate(moving, 2), oneCandidate(moving, 0)])
    )

    expect(
      result.rankedStates.map(
        (state) => state.placedCollisionGeometries[0]?.placement.transform.translateX
      )
    ).toEqual([0, 2])
  })

  it('uses localCandidateFanout independently from the retained beam width', async () => {
    const result = await runWindowed(
      sheet(4, 1),
      [preparedPiece('a', 1, 1)],
      Layer.succeed(GeometrySettings, settings(1, 3, 1)),
      candidateService(({ moving }) => [
        oneCandidate(moving, 2),
        oneCandidate(moving, 0),
        oneCandidate(moving, 1)
      ])
    )

    expect(result.rankedStates).toHaveLength(1)
    expect(result.bestState.placedCollisionGeometries[0]?.placement.transform.translateX).toBe(0)
  })

  it('retains candidates for a chromosome-preferred transform before better local scores', async () => {
    const transforms = [
      new IrregularTransformCandidate({
        index: 0,
        rotationDeg: 0,
        mirrored: false,
        reason: 'configured'
      }),
      new IrregularTransformCandidate({
        index: 1,
        rotationDeg: 90,
        mirrored: false,
        reason: 'configured'
      })
    ]
    const result = await runWindowed(
      sheet(4, 1),
      [preparedPiece('a', 1, 1, undefined, transforms)],
      Layer.succeed(GeometrySettings, settings(1, 1, 1)),
      candidateService(({ moving }) => [oneCandidate(moving, moving.transform.index * 2)]),
      { transformPreferences: new Map([[PieceId.make('a'), 1]]) }
    )

    expect(result.bestState.placedCollisionGeometries[0]?.placement.transform.rotationDeg).toBe(90)
  })

  it('emits only the winning state ancestry to history hooks', async () => {
    const emittedPlacementCounts: number[] = []
    await runWindowed(
      sheet(4, 1),
      [preparedPiece('a', 1, 1), preparedPiece('b', 1, 1)],
      Layer.succeed(GeometrySettings, settings(1, 2, 2)),
      candidateService(({ moving }) =>
        moving.sourcePieceId === PieceId.make('a')
          ? [oneCandidate(moving, 0), oneCandidate(moving, 1)]
          : [oneCandidate(moving, 2)]
      ),
      undefined,
      {
        onInitialState: (state) => {
          emittedPlacementCounts.push(state.placedCollisionGeometries.length)
        },
        onStateSelected: ({ state }) => {
          emittedPlacementCounts.push(state.placedCollisionGeometries.length)
        }
      }
    )

    expect(emittedPlacementCounts).toEqual([0, 1, 2])
  })

  it('can select the second eligible piece when it produces the better branch', async () => {
    const service = candidateService(({ moving, placed }) => {
      const sourceId = moving.sourcePieceId
      const hasA = placed.some(({ placement }) => placement.sourcePieceId === PieceId.make('a'))
      const hasB = placed.some(({ placement }) => placement.sourcePieceId === PieceId.make('b'))
      if (sourceId === PieceId.make('b') && hasA) return []
      if (sourceId === PieceId.make('a') && hasB) return [oneCandidate(moving, 6)]
      return [oneCandidate(moving, 0)]
    })
    const emittedHistory: PieceId[][] = []
    const result = await runWindowed(
      sheet(10, 4),
      [preparedPiece('a', 4, 4), preparedPiece('b', 6, 4, 'copy-b')],
      Layer.succeed(GeometrySettings, settings(2, 2)),
      service,
      undefined,
      {
        onInitialState: (state) => emittedHistory.push([...state.placementOrder]),
        onStateSelected: ({ state }) => emittedHistory.push([...state.placementOrder])
      }
    )

    expect(result.bestState.unplacedPieceIds).toEqual([])
    expect(result.bestState.placementOrder).toEqual([PieceId.make('copy-b'), PieceId.make('a')])
    expect(result.bestState.placedCollisionGeometries[0]?.placement.pieceId).toBe(
      PieceId.make('copy-b')
    )
    expect(emittedHistory).toEqual([
      [],
      [PieceId.make('copy-b')],
      [PieceId.make('copy-b'), PieceId.make('a')]
    ])
  })

  it('never expands beyond the first three remaining pieces for orderWindow three', async () => {
    const calls: PieceId[] = []
    const ids = ['a', 'b', 'c', 'd']
    const service = candidateService(({ moving }) => {
      calls.push(moving.sourcePieceId)
      return [oneCandidate(moving, ids.indexOf(moving.sourcePieceId) * 2)]
    })

    await runWindowed(
      sheet(20, 2),
      ids.map((id) => preparedPiece(id, 1, 1)),
      Layer.succeed(GeometrySettings, settings(3, 1)),
      service
    )

    expect(calls.slice(0, 3)).toEqual([PieceId.make('a'), PieceId.make('b'), PieceId.make('c')])
    expect(calls.slice(0, 3)).not.toContain(PieceId.make('d'))
  })

  it('marks only the current first piece unplaced when later eligible pieces fit', async () => {
    const service = candidateService(({ moving }) =>
      moving.sourcePieceId === PieceId.make('first')
        ? []
        : [oneCandidate(moving, moving.sourcePieceId === PieceId.make('second') ? 0 : 2)]
    )
    const result = await runWindowed(
      sheet(10, 2),
      [preparedPiece('first', 1, 1), preparedPiece('second', 1, 1), preparedPiece('third', 1, 1)],
      Layer.succeed(GeometrySettings, settings(2, 2)),
      service
    )

    expect(result.bestState.placedCollisionGeometries.map(({ placement }) => placement.sourcePieceId)).toEqual([
      PieceId.make('second'),
      PieceId.make('third')
    ])
    expect(result.bestState.unplacedPieceIds).toEqual([PieceId.make('first')])
  })

  it('deduplicates and prunes deterministically when candidate input is reversed', async () => {
    const run = (reverse: boolean) =>
      runWindowed(
        sheet(4, 2),
        [preparedPiece('a', 1, 1), preparedPiece('b', 1, 1)],
        Layer.succeed(GeometrySettings, settings(2, 2)),
        candidateService(({ moving }) => {
          const candidates = [oneCandidate(moving, 0), oneCandidate(moving, 1)]
          return reverse ? [...candidates].reverse() : candidates
        })
      )
    const forward = await run(false)
    const reversed = await run(true)

    expect(stateSnapshot(reversed)).toEqual(stateSnapshot(forward))
    expect(reversed.bestState.placementOrder).toEqual(forward.bestState.placementOrder)
  })

  it('deduplicates equivalent successors before whole-layout scoring without changing history', async () => {
    const scoreCalls = { count: 0 }
    const baseScorer = await Effect.runPromise(
      IrregularLayoutScorer.use((scorer) => Effect.succeed(scorer)).pipe(
        Effect.provide(IrregularLayoutScorer.Live),
        Effect.provide(GeometrySettings.Live)
      )
    )
    const countingScorer: IrregularLayoutScorer.Service = {
      compare: baseScorer.compare,
      scoreState: (input) =>
        Effect.sync(() => {
          scoreCalls.count += 1
        }).pipe(Effect.flatMap(() => baseScorer.scoreState(input)))
    }
    const history: number[] = []
    const result = await runWindowed(
      sheet(4, 1),
      [preparedPiece('a', 1, 1)],
      Layer.succeed(GeometrySettings, settings(1, 2, 2)),
      candidateService(({ moving }) => [oneCandidate(moving, 0), oneCandidate(moving, 0)]),
      undefined,
      {
        onInitialState: (state) => history.push(state.placedCollisionGeometries.length),
        onStateSelected: ({ state }) => history.push(state.placedCollisionGeometries.length)
      },
      countingScorer
    )

    expect(scoreCalls.count).toBe(1)
    expect(result.rankedStates).toHaveLength(1)
    expect(result.bestState.placementOrder).toEqual([PieceId.make('a')])
    expect(result.bestState.placedCollisionGeometries.map(({ placement }) => placement.sourcePieceId)).toEqual([
      PieceId.make('a')
    ])
    expect(history).toEqual([0, 1])
  })
})
