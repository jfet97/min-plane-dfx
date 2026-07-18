import { Effect, Layer } from 'effect'
import { describe, expect, it, vi } from 'vitest'
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
  IrregularPlacementPolicyId,
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
import { IrregularBeamState } from '../../src/workers/algorithm/irregular/irregularBeamState.js'
import { decodeStrictPriorityOrder } from '../../src/workers/algorithm/irregular/strictPriorityDecoder.js'
import {
  decodeWindowedIrregularBeam,
  type IrregularWindowedBeamControl,
  type IrregularWindowedBeamHooks,
  type IrregularWindowedBeamOptions
} from '../../src/workers/algorithm/irregular/windowedBeam.js'
import {
  IrregularDecisionTraceDecodeStarted,
  IrregularDecisionTraceStateIdRegistry,
  type EmitIrregularDecisionTrace,
  type IrregularDecisionTraceEvent
} from '../../src/workers/algorithm/irregular/decisionTrace.js'

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
  transforms?: ReadonlyArray<IrregularTransformCandidate>,
  interchangeabilityKey?: string
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
    ...(interchangeabilityKey === undefined ? {} : { interchangeabilityKey }),
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
    GeometrySettings.Make.optimizer.localCandidateFanout ?? GeometrySettings.Make.optimizer.beamWidth,
  placementPolicyId: IrregularPlacementPolicyId = 'balanced-compactness',
  localRepairBudget = 0
): IrregularNestingSettings {
  return new IrregularNestingSettings({
    geometry: GeometrySettings.Make.geometry,
    optimizer: new IrregularOptimizerSettings({
      ...GeometrySettings.Make.optimizer,
      orderWindow,
      beamWidth,
      localCandidateFanout,
      localRepairBudget,
      placementPolicyId,
      placementPolicyIds: [placementPolicyId]
    })
  })
}

function candidateService(
  makeCandidates: (input: {
    readonly moving: { readonly sourcePieceId: PieceId; readonly transform: IrregularTransformCandidate }
    readonly placed: ReadonlyArray<{
      readonly placement: {
        readonly sourcePieceId: PieceId
        readonly transform: { readonly translateX: number; readonly translateY: number }
      }
    }>
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
  layoutScorer?: IrregularLayoutScorer.Service,
  emitDecisionTrace?: EmitIrregularDecisionTrace,
  control?: IrregularWindowedBeamControl
) {
  const layoutScorerLayer =
    layoutScorer === undefined
      ? IrregularLayoutScorer.Live
      : Layer.succeed(IrregularLayoutScorer, layoutScorer)
  return Effect.runPromise(
    decodeWindowedIrregularBeam(
      currentSheet,
      pieces,
      hooks,
      options,
      control,
      undefined,
      emitDecisionTrace
    ).pipe(
      Effect.provide(GeometryKernel.Live),
      Effect.provide(service),
      Effect.provide(IrregularPlacementScorer.Layer),
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

async function branchBiasedLayoutScorer(): Promise<IrregularLayoutScorer.Service> {
  const baseScorer = await Effect.runPromise(
    IrregularLayoutScorer.use((scorer) => Effect.succeed(scorer)).pipe(
      Effect.provide(IrregularLayoutScorer.Live),
      Effect.provide(GeometrySettings.Live)
    )
  )
  return {
    compare: baseScorer.compare,
    scoreState: (input) =>
      baseScorer.scoreState(input).pipe(
        Effect.map((score) => {
          const first = input.state.placementOrder[0]
          const second = input.state.placementOrder[1]
          const preference =
            first === PieceId.make('a') ? (second === PieceId.make('b') ? 0 : 2) : 1
          return { ...score, largestNetFreeMaterialRegionAreaMm2: preference }
        })
      )
  }
}

async function protectedLaneRankBiasedLayoutScorer(): Promise<IrregularLayoutScorer.Service> {
  const baseScorer = await Effect.runPromise(
    IrregularLayoutScorer.use((scorer) => Effect.succeed(scorer)).pipe(
      Effect.provide(IrregularLayoutScorer.Live),
      Effect.provide(GeometrySettings.Live)
    )
  )
  return {
    compare: baseScorer.compare,
    scoreState: (input) =>
      baseScorer.scoreState(input).pipe(
        Effect.map((score) => {
          const anchor = input.state.placedCollisionGeometries.find(
            ({ placement }) => placement.sourcePieceId === PieceId.make('a')
          )
          const moving = input.state.placedCollisionGeometries.find(
            ({ placement }) => placement.sourcePieceId === PieceId.make('b')
          )
          const demoteFromBoundaryLane =
            anchor?.placement.transform.translateY === 106 &&
            moving?.placement.transform.translateX === 0
          return demoteFromBoundaryLane
            ? {
                ...score,
                collisionBoundsWorstNormalizedSheetConsumption:
                  score.collisionBoundsWorstNormalizedSheetConsumption + 1
              }
            : score
        })
      )
  }
}

describe('decodeWindowedIrregularBeam', () => {
  it('assigns compact repeated state ids without hashing canonical keys', () => {
    const registry = new IrregularDecisionTraceStateIdRegistry()

    expect(registry.idFor('very-long-canonical-state-key')).toBe('s0')
    expect(registry.idFor('very-long-canonical-state-key')).toBe('s0')
    expect(registry.idFor('another-canonical-state-key')).toBe('s1')
  })

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

  it('preserves the exact width-one lineage', async () => {
    const pieces = [
      preparedPiece('a', 3, 3),
      preparedPiece('b', 3, 3),
      preparedPiece('c', 2, 3)
    ]
    const currentSheet = sheet(10, 4)
    const strict = await Effect.runPromise(
      decodeStrictPriorityOrder(currentSheet, pieces).pipe(
        Effect.provide(GeometryKernel.Live),
        Effect.provide(GeometrySettings.Live),
        Effect.provide(NfpIfpServiceLive),
        Effect.provide(IrregularPlacementScorer.Live)
      )
    )
    const widthOne = await runWindowed(
      currentSheet,
      pieces,
      Layer.succeed(GeometrySettings, settings(1, 1, 1))
    )

    expect({
      placements: widthOne.bestState.placedCollisionGeometries.map(({ placement }) => placement),
      unplacedPieceIds: widthOne.bestState.unplacedPieceIds
    }).toEqual({ placements: strict.placements, unplacedPieceIds: strict.unplacedPieceIds })
  })

  it('retains the incumbent when globally better alternatives would prune it', async () => {
    const service = candidateService(({ moving, placed }) => {
      const hasA = placed.some(({ placement }) => placement.sourcePieceId === PieceId.make('a'))
      const hasB = placed.some(({ placement }) => placement.sourcePieceId === PieceId.make('b'))
      if (!hasA && !hasB) return [oneCandidate(moving, 0)]
      if (hasA && moving.sourcePieceId === PieceId.make('b')) return [oneCandidate(moving, 3)]
      if (hasB && moving.sourcePieceId === PieceId.make('a')) {
        return [oneCandidate(moving, 1), oneCandidate(moving, 2)]
      }
      return []
    })
    const result = await runWindowed(
      sheet(10, 2),
      [preparedPiece('a', 1, 1), preparedPiece('b', 1, 1)],
      Layer.succeed(GeometrySettings, settings(2, 2, 2)),
      service,
      undefined,
      undefined,
      await branchBiasedLayoutScorer()
    )

    expect(result.rankedStates).toHaveLength(2)
    expect(result.rankedStates.map((state) => state.placementOrder)).toContainEqual([
      PieceId.make('a'),
      PieceId.make('b')
    ])
  })

  it('does not regress final placed or unplaced counts on an awkward fixture', async () => {
    const pieces = [
      preparedPiece('long-thin', 7, 2),
      preparedPiece('upright', 2, 5),
      preparedPiece('wide-block', 5, 3),
      preparedPiece('short-block', 4, 2),
      preparedPiece('small-tall', 3, 4)
    ]
    const currentSheet = sheet(10, 5)
    const widthOne = await runWindowed(
      currentSheet,
      pieces,
      Layer.succeed(GeometrySettings, settings(2, 1, 2))
    )
    const wider = await runWindowed(
      currentSheet,
      pieces,
      Layer.succeed(GeometrySettings, settings(2, 4, 2))
    )

    expect(wider.bestState.placedCollisionGeometries.length).toBeGreaterThanOrEqual(
      widthOne.bestState.placedCollisionGeometries.length
    )
    expect(wider.bestState.unplacedPieceIds.length).toBeLessThanOrEqual(
      widthOne.bestState.unplacedPieceIds.length
    )
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

  it('adds one translation-equivalent survivor on a distinct sheet boundary', async () => {
    const events: IrregularDecisionTraceEvent[] = []
    const result = await runWindowed(
      sheet(100, 100),
      [preparedPiece('a', 2, 2)],
      Layer.succeed(GeometrySettings, settings(1, 2, 3)),
      candidateService(({ moving }) => [
        oneCandidate(moving, 0, 0),
        oneCandidate(moving, 10, 0),
        oneCandidate(moving, 0, 98)
      ]),
      undefined,
      undefined,
      undefined,
      (event) => events.push(event)
    )

    expect(result.rankedStates).toHaveLength(3)
    expect(
      new Set(result.rankedStates.map((state) => state.canonicalOccupiedGeometryKey)).size
    ).toBe(3)
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'beam_selection',
        decision: 'retained',
        reason: 'protected_boundary_anchor_survivor'
      })
    )
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'beam_step_completed',
        retainedStateCount: 3
      })
    )
    expect(events.filter(({ kind }) => kind === 'terminal_orientation_scored')).toHaveLength(4)
  })

  it('promotes a smaller protected descendant after a second expansion', async () => {
    const events: IrregularDecisionTraceEvent[] = []
    const service = candidateService(({ moving, placed }) => {
      const anchor = placed[0]?.placement.transform
      if (anchor === undefined) {
        return [
          oneCandidate(moving, 0, 0),
          oneCandidate(moving, 10, 0),
          oneCandidate(moving, 0, 98)
        ]
      }
      return anchor.translateY === 98
        ? [oneCandidate(moving, 2, 98)]
        : [oneCandidate(moving, anchor.translateX + 20, anchor.translateY)]
    })
    const result = await runWindowed(
      sheet(100, 100),
      [preparedPiece('a', 2, 2), preparedPiece('b', 2, 2)],
      Layer.succeed(GeometrySettings, settings(1, 2, 3)),
      service,
      undefined,
      undefined,
      undefined,
      (event) => events.push(event)
    )

    expect(result.bestState.translatedCollisionBounds).toMatchObject({ width: 4, height: 2 })
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'beam_selection',
        stepIndex: 1,
        decision: 'retained',
        reason: 'protected_boundary_anchor_survivor'
      })
    )
    expect(events.filter(({ kind }) => kind === 'terminal_orientation_scored')).toHaveLength(4)
  })

  it('rejects a larger oriented protected descendant without duplicating ranks', async () => {
    const events: IrregularDecisionTraceEvent[] = []
    const service = candidateService(({ moving, placed }) => {
      const anchor = placed[0]?.placement.transform
      if (anchor === undefined) {
        return [
          oneCandidate(moving, 0, 0),
          oneCandidate(moving, 10, 0),
          oneCandidate(moving, 0, 98)
        ]
      }
      return anchor.translateY === 98
        ? [oneCandidate(moving, 50, 98)]
        : [oneCandidate(moving, anchor.translateX + 2, anchor.translateY)]
    })
    const result = await runWindowed(
      sheet(100, 100),
      [preparedPiece('a', 2, 2), preparedPiece('b', 2, 2)],
      Layer.succeed(GeometrySettings, settings(1, 2, 3)),
      service,
      undefined,
      undefined,
      undefined,
      (event) => events.push(event)
    )

    expect(result.bestState.translatedCollisionBounds).toMatchObject({ width: 4, height: 2 })
    expect(
      new Set(result.rankedStates.map((state) => state.canonicalOccupiedGeometryKey)).size
    ).toBe(result.rankedStates.length)
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'beam_selection',
        stepIndex: 1,
        decision: 'retained',
        reason: 'protected_boundary_anchor_survivor'
      })
    )
    expect(events.filter(({ kind }) => kind === 'terminal_orientation_scored')).toHaveLength(4)
  })

  it('observes cancellation while scoring protected terminal orientations', async () => {
    const baseScorer = await Effect.runPromise(
      IrregularLayoutScorer.use((scorer) => Effect.succeed(scorer)).pipe(
        Effect.provide(IrregularLayoutScorer.Live),
        Effect.provide(GeometrySettings.Live)
      )
    )
    let cancelled = false
    const cancellingScorer: IrregularLayoutScorer.Service = {
      compare: baseScorer.compare,
      scoreState: (input) =>
        baseScorer.scoreState(input).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              const bounds = input.state.translatedCollisionBounds
              const rotated = input.state.placedCollisionGeometries.some(
                ({ placement }) => placement.transform.rotationDeg === 90
              )
              if (bounds !== undefined && bounds.width * bounds.height > 100 && rotated) {
                cancelled = true
              }
            })
          )
        )
    }
    const service = candidateService(({ moving, placed }) => {
      const anchor = placed[0]?.placement.transform
      if (anchor === undefined) {
        return [
          oneCandidate(moving, 0, 0),
          oneCandidate(moving, 10, 0),
          oneCandidate(moving, 0, 98)
        ]
      }
      return anchor.translateY === 98
        ? [oneCandidate(moving, 50, 98)]
        : [oneCandidate(moving, anchor.translateX + 2, anchor.translateY)]
    })

    await expect(
      runWindowed(
        sheet(100, 100),
        [preparedPiece('a', 2, 2), preparedPiece('b', 2, 2)],
        Layer.succeed(GeometrySettings, settings(1, 2, 3)),
        service,
        undefined,
        undefined,
        cancellingScorer,
        undefined,
        { isCancelled: () => cancelled }
      )
    ).rejects.toMatchObject({
      _tag: 'IrregularWindowedBeamAbortedError',
      reason: 'cancelled'
    })
  })

  it('keeps the production representative when both lanes converge', async () => {
    const events: IrregularDecisionTraceEvent[] = []
    const service = candidateService(({ moving, placed }) => {
      const anchor = placed[0]?.placement.transform
      if (anchor === undefined) {
        return [
          oneCandidate(moving, 0, 0),
          oneCandidate(moving, 10, 0),
          oneCandidate(moving, 0, 98)
        ]
      }
      if (anchor.translateX === 0 && anchor.translateY === 0) {
        return [oneCandidate(moving, 0, 98)]
      }
      if (anchor.translateX === 0 && anchor.translateY === 98) {
        return [oneCandidate(moving, 0, 0)]
      }
      return [oneCandidate(moving, 12, 0)]
    })
    const pieces = [preparedPiece('a', 2, 2), preparedPiece('b', 2, 2)]
    const settingsLayer = Layer.succeed(GeometrySettings, settings(1, 2, 3))
    const protectedResult = await runWindowed(
      sheet(100, 100),
      pieces,
      settingsLayer,
      service,
      undefined,
      undefined,
      undefined,
      (event) => events.push(event)
    )
    const productionOnlyResult = await runWindowed(
      sheet(100, 100),
      pieces,
      settingsLayer,
      service,
      { transformPreferences: new Map([[PieceId.make('unused'), 0]]) }
    )

    expect(stateSnapshot(protectedResult)).toEqual(stateSnapshot(productionOnlyResult))
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'beam_selection',
        stepIndex: 1,
        decision: 'retained',
        reason: 'within_beam_width'
      })
    )
  })

  it('reports the intrinsic rank when both protected lanes converge', async () => {
    const events: IrregularDecisionTraceEvent[] = []
    const layoutScorer = await protectedLaneRankBiasedLayoutScorer()
    await runWindowed(
      sheet(100, 110),
      [preparedPiece('a', 20, 4), preparedPiece('b', 2, 2)],
      Layer.succeed(
        GeometrySettings,
        settings(1, 2, 10, 'edge-contact-then-balanced-compactness')
      ),
      candidateService(({ moving, placed }) => {
        const anchor = placed[0]?.placement.transform
        if (anchor === undefined) {
          return [
            oneCandidate(moving, 0, 0),
            oneCandidate(moving, 10, 0),
            oneCandidate(moving, 0, 106)
          ]
        }
        if (anchor.translateY === 106) {
          return Array.from({ length: 10 }, (_, index) =>
            oneCandidate(moving, index * 2, 104)
          )
        }
        return [oneCandidate(moving, anchor.translateX + 20, 0)]
      }),
      { policyId: 'edge-contact-then-balanced-compactness' },
      undefined,
      layoutScorer,
      (event) => events.push(event)
    )

    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'beam_selection',
        stepIndex: 1,
        decision: 'retained',
        reason: 'protected_intrinsic_contact_survivor',
        rank: 1
      })
    )
  })

  it('does not activate the protected lane when terminal repair is enabled', async () => {
    const events: IrregularDecisionTraceEvent[] = []
    await runWindowed(
      sheet(100, 100),
      [preparedPiece('a', 2, 2)],
      Layer.succeed(GeometrySettings, settings(1, 2, 3, 'balanced-compactness', 1)),
      candidateService(({ moving }) => [
        oneCandidate(moving, 0, 0),
        oneCandidate(moving, 10, 0),
        oneCandidate(moving, 0, 98)
      ]),
      undefined,
      undefined,
      undefined,
      (event) => events.push(event)
    )

    expect(events).not.toContainEqual(
      expect.objectContaining({
        kind: 'beam_selection',
        reason: 'protected_boundary_anchor_survivor'
      })
    )
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

  it('uses bounded terminal repair to reinsert one piece into a better legal contact', async () => {
    const events: IrregularDecisionTraceEvent[] = []
    const emittedPlacementCounts: number[] = []
    const result = await runWindowed(
      sheet(6, 4),
      [preparedPiece('a', 1, 1), preparedPiece('b', 1, 1)],
      Layer.succeed(
        GeometrySettings,
        settings(1, 1, 1, 'balanced-compactness', 1)
      ),
      candidateService(({ moving, placed }) => {
        if (placed.length === 0) return [oneCandidate(moving, 0, 2)]
        return [
          oneCandidate(
            moving,
            moving.sourcePieceId === PieceId.make('a') ? 2 : 3,
            2
          )
        ]
      }),
      undefined,
      {
        onInitialState: (state) => {
          emittedPlacementCounts.push(state.placedCollisionGeometries.length)
        },
        onStateSelected: ({ state }) => {
          emittedPlacementCounts.push(state.placedCollisionGeometries.length)
        }
      },
      undefined,
      (event) => events.push(event)
    )

    expect(
      result.bestState.placedCollisionGeometries.map(
        ({ placement }) => placement.transform.translateX
      )
    ).toEqual([0, 1])
    expect(result.bestScore.nearCompleteStructuralContactCount).toBe(1)
    expect(result.bestScore.collisionBoundsBottomMm).toBe(0)
    expect(
      result.bestState.placedCollisionGeometries.map(
        ({ placement }) => placement.transform.translateY
      )
    ).toEqual([0, 0])
    expect(emittedPlacementCounts).toEqual([0, 1, 2])
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'local_repair_accepted',
        iterationIndex: 0,
        pieceId: PieceId.make('a')
      })
    )
    const acceptedRepair = events.findLast((event) => event.kind === 'local_repair_accepted')
    const winner = events.findLast((event) => event.kind === 'decode_winner')
    expect(winner?.state.stateId).not.toBe(acceptedRepair?.state.stateId)
    expect(winner?.score.nearCompleteStructuralContactCount).toBe(
      acceptedRepair?.score.nearCompleteStructuralContactCount
    )
    expect(winner?.score.sharedCollisionBoundaryContactUnits).toBe(
      acceptedRepair?.score.sharedCollisionBoundaryContactUnits
    )
    expect(acceptedRepair?.score.collisionBoundsBottomMm).toBe(2)
    expect(winner?.score.collisionBoundsBottomMm).toBe(0)
  })

  it('rejects a contact-favored terminal repair that enlarges the occupied envelope', async () => {
    const baseScorer = await Effect.runPromise(
      IrregularLayoutScorer.use((scorer) => Effect.succeed(scorer)).pipe(
        Effect.provide(IrregularLayoutScorer.Live),
        Effect.provide(GeometrySettings.Live)
      )
    )
    const contactBiasedScorer: IrregularLayoutScorer.Service = {
      compare: baseScorer.compare,
      scoreState: (input) =>
        baseScorer.scoreState(input).pipe(
          Effect.map((score) => {
            const containsFarPlacement = input.state.placedCollisionGeometries.some(
              ({ placement }) => placement.transform.translateX >= 4
            )
            return containsFarPlacement
              ? {
                  ...score,
                  nearCompleteStructuralContactCount: 2,
                  dominantNearCompleteStructuralContactCount: 2
                }
              : score
          })
        )
    }
    let candidateCallCount = 0
    const events: IrregularDecisionTraceEvent[] = []
    const result = await runWindowed(
      sheet(6, 4),
      [preparedPiece('a', 1, 1), preparedPiece('b', 1, 1)],
      Layer.succeed(GeometrySettings, settings(1, 1, 1, 'balanced-compactness', 1)),
      candidateService(({ moving }) => {
        candidateCallCount += 1
        return [oneCandidate(moving, candidateCallCount <= 2 ? candidateCallCount - 1 : 4)]
      }),
      undefined,
      undefined,
      contactBiasedScorer,
      (event) => events.push(event)
    )

    expect(result.bestScore.collisionBoundsAreaMm2).toBe(2)
    expect(result.bestScore.collisionBoundsSpanMm).toBe(3)
    expect(events.some((event) => event.kind === 'local_repair_accepted')).toBe(false)
  })

  it('returns the last fully accepted repair when the deadline expires during the next iteration', async () => {
    const currentSheet = sheet(6, 4)
    const pieces = [preparedPiece('a', 1, 1), preparedPiece('b', 1, 1)]
    const makeRepairService = (onCall?: (callCount: number) => void) => {
      let callCount = 0
      return candidateService(({ moving, placed }) => {
        callCount += 1
        onCall?.(callCount)
        if (placed.length === 0) return [oneCandidate(moving, 0, 2)]
        return [
          oneCandidate(
            moving,
            moving.sourcePieceId === PieceId.make('a') ? 2 : 3,
            2
          )
        ]
      })
    }
    const oneAcceptedRepair = await runWindowed(
      currentSheet,
      pieces,
      Layer.succeed(GeometrySettings, settings(1, 1, 1, 'balanced-compactness', 1)),
      makeRepairService()
    )

    let deadlineReached = false
    const now = vi.spyOn(Date, 'now').mockImplementation(() => (deadlineReached ? 2 : 0))
    try {
      const result = await runWindowed(
        currentSheet,
        pieces,
        Layer.succeed(GeometrySettings, settings(1, 1, 1, 'balanced-compactness', 2)),
        makeRepairService((callCount) => {
          if (callCount === 5) deadlineReached = true
        }),
        undefined,
        undefined,
        undefined,
        undefined,
        { deadlineMs: 1 }
      )

      expect(result.bestState.canonicalOccupiedGeometryKey).toBe(
        oneAcceptedRepair.bestState.canonicalOccupiedGeometryKey
      )
      expect(result.bestScore).toEqual(oneAcceptedRepair.bestScore)
    } finally {
      now.mockRestore()
    }
  })

  it('still aborts cancellation observed during terminal repair', async () => {
    let callCount = 0
    let cancelled = false
    const service = candidateService(({ moving, placed }) => {
      callCount += 1
      if (callCount === 5) cancelled = true
      if (placed.length === 0) return [oneCandidate(moving, 0, 2)]
      return [oneCandidate(moving, moving.sourcePieceId === PieceId.make('a') ? 2 : 3, 2)]
    })

    await expect(
      runWindowed(
        sheet(6, 4),
        [preparedPiece('a', 1, 1), preparedPiece('b', 1, 1)],
        Layer.succeed(GeometrySettings, settings(1, 1, 1, 'balanced-compactness', 2)),
        service,
        undefined,
        undefined,
        undefined,
        undefined,
        { isCancelled: () => cancelled }
      )
    ).rejects.toMatchObject({
      _tag: 'IrregularWindowedBeamAbortedError',
      reason: 'cancelled'
    })
  })

  it('still aborts a deadline observed during beam search', async () => {
    let deadlineReached = false
    const now = vi.spyOn(Date, 'now').mockImplementation(() => (deadlineReached ? 2 : 0))
    try {
      await expect(
        runWindowed(
          sheet(6, 4),
          [preparedPiece('a', 1, 1), preparedPiece('b', 1, 1)],
          Layer.succeed(GeometrySettings, settings(1, 1, 1, 'balanced-compactness', 2)),
          candidateService(({ moving }) => {
            deadlineReached = true
            return [oneCandidate(moving, 0, 2)]
          }),
          undefined,
          undefined,
          undefined,
          undefined,
          { deadlineMs: 1 }
        )
      ).rejects.toMatchObject({
        _tag: 'IrregularWindowedBeamAbortedError',
        reason: 'deadline'
      })
    } finally {
      now.mockRestore()
    }
  })

  it('bottom-anchors a repair-enabled terminal layout before returning it', async () => {
    const result = await runWindowed(
      sheet(6, 4),
      [preparedPiece('a', 1, 1)],
      Layer.succeed(
        GeometrySettings,
        settings(1, 1, 1, 'balanced-compactness', 1)
      ),
      candidateService(({ moving }) => [oneCandidate(moving, 0, 2)])
    )

    expect(
      result.bestState.placedCollisionGeometries[0]?.placement.transform.translateY
    ).toBe(0)
    expect(result.bestScore.collisionBoundsBottomMm).toBe(0)
  })

  it('keeps a compactness alternative beside the edge-contact winner', async () => {
    const result = await runWindowed(
      sheet(100, 10),
      [preparedPiece('a', 4, 2), preparedPiece('b', 4, 2)],
      Layer.succeed(
        GeometrySettings,
        settings(1, 2, 2, 'edge-contact-then-balanced-compactness')
      ),
      candidateService(({ moving, placed }) =>
        placed.length === 0
          ? [oneCandidate(moving, 0, 0)]
          : [oneCandidate(moving, 5, 0), oneCandidate(moving, 4, 0), oneCandidate(moving, 0, 2)]
      )
    )

    const retainedPoints = result.rankedStates.map((state) => {
        const placement = state.placedCollisionGeometries[1]?.placement.transform
        return placement === undefined ? undefined : [placement.translateX, placement.translateY]
      })

    expect(retainedPoints).toEqual(
      expect.arrayContaining([
        [4, 0],
        [0, 2]
      ])
    )
    expect(retainedPoints).not.toContainEqual([5, 0])
  })

  it('continues one max-side-first candidate from a duplicated exact contact tier', async () => {
    const events: IrregularDecisionTraceEvent[] = []
    const result = await runWindowed(
      sheet(100, 10),
      [preparedPiece('a', 20, 4), preparedPiece('b', 2, 2)],
      Layer.succeed(
        GeometrySettings,
        settings(1, 3, 3, 'edge-contact-then-balanced-compactness')
      ),
      candidateService(({ moving, placed }) =>
        placed.length === 0
          ? [oneCandidate(moving, 0, 0)]
          : [
              oneCandidate(moving, 20, 0),
              oneCandidate(moving, 20, 1),
              oneCandidate(moving, 20, 2),
              oneCandidate(moving, 0, 4)
            ]
      ),
      undefined,
      undefined,
      undefined,
      (event) => events.push(event)
    )

    const terminalPoints = result.rankedStates.map((state) => {
      const placement = state.placedCollisionGeometries[1]?.placement.transform
      return placement === undefined ? undefined : [placement.translateX, placement.translateY]
    })
    expect(terminalPoints).toContainEqual([0, 4])
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'local_candidate_selection',
        decision: 'selected',
        reason: 'intrinsic_contact_tier_reserved'
      })
    )
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'local_candidate_summary',
        selectedCandidateCount: 4,
        decisionCounts: expect.objectContaining({ intrinsicContactTierReserved: 1 })
      })
    )
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'beam_selection',
        decision: 'retained',
        reason: 'protected_intrinsic_contact_survivor',
        rank: 1
      })
    )
  })

  it('does not treat a duplicated zero-contact tier as an intrinsic seed', async () => {
    const events: IrregularDecisionTraceEvent[] = []
    await runWindowed(
      sheet(100, 10),
      [preparedPiece('a', 2, 2)],
      Layer.succeed(
        GeometrySettings,
        settings(1, 3, 3, 'edge-contact-then-balanced-compactness')
      ),
      candidateService(({ moving }) => [
        oneCandidate(moving, 0, 0),
        oneCandidate(moving, 20, 0),
        oneCandidate(moving, 40, 0),
        oneCandidate(moving, 60, 0)
      ]),
      undefined,
      undefined,
      undefined,
      (event) => events.push(event)
    )

    expect(events).not.toContainEqual(
      expect.objectContaining({
        kind: 'local_candidate_selection',
        reason: 'intrinsic_contact_tier_reserved'
      })
    )
    expect(events).not.toContainEqual(
      expect.objectContaining({
        kind: 'beam_selection',
        reason: 'protected_intrinsic_contact_survivor'
      })
    )
  })

  it('keeps full trace detail for compactness reservation and displacement', async () => {
    const events: IrregularDecisionTraceEvent[] = []
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
    await runWindowed(
      sheet(10, 100),
      [preparedPiece('a', 4, 2), preparedPiece('b', 4, 2, undefined, transforms)],
      Layer.succeed(
        GeometrySettings,
        settings(1, 2, 2, 'edge-contact-then-balanced-compactness')
      ),
      candidateService(({ moving, placed }) =>
        placed.length === 0
          ? [oneCandidate(moving, 0, 0)]
          : moving.transform.index === 1
            ? [oneCandidate(moving, 6, 0), oneCandidate(moving, 5, 0)]
            : [oneCandidate(moving, 0, 2)]
      ),
      {
        policyId: 'edge-contact-then-balanced-compactness',
        transformPreferences: new Map([[PieceId.make('b'), 1]])
      },
      undefined,
      undefined,
      (event) => events.push(event)
    )

    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'local_candidate_selection',
        decision: 'selected',
        reason: 'compactness_alternative_reserved'
      })
    )
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'local_candidate_selection',
        decision: 'rejected',
        reason: 'displaced_by_compactness_reservation'
      })
    )
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'local_candidate_summary',
        generatedCandidateCount: 3,
        uniqueGeometryCandidateCount: 3,
        selectedCandidateCount: 2,
        detailedCandidateCount: 3,
        decisionCounts: expect.objectContaining({
          compactnessAlternativeReserved: 1,
          displacedByCompactnessReservation: 1
        })
      })
    )
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

  it('deduplicates equivalent translated geometry before applying local fanout', async () => {
    const transforms = [
      new IrregularTransformCandidate({
        index: 0,
        rotationDeg: 0,
        mirrored: false,
        reason: 'configured'
      }),
      new IrregularTransformCandidate({
        index: 1,
        rotationDeg: 360,
        mirrored: false,
        reason: 'configured'
      })
    ]
    const events: IrregularDecisionTraceEvent[] = []
    const result = await runWindowed(
      sheet(4, 1),
      [preparedPiece('a', 1, 1, undefined, transforms)],
      Layer.succeed(GeometrySettings, settings(1, 2, 2)),
      candidateService(({ moving }) =>
        moving.transform.index === 0
          ? [oneCandidate(moving, 0)]
          : [oneCandidate(moving, 0), oneCandidate(moving, 1)]
      ),
      undefined,
      undefined,
      undefined,
      (event) => events.push(event)
    )

    expect(result.rankedStates).toHaveLength(2)
    expect(events).not.toContainEqual(
      expect.objectContaining({
        kind: 'local_candidate_selection',
        decision: 'rejected',
        reason: 'duplicate_local_geometry'
      })
    )
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'local_candidate_summary',
        generatedCandidateCount: 3,
        uniqueGeometryCandidateCount: 2,
        selectedCandidateCount: 2,
        detailedCandidateCount: 2,
        decisionCounts: expect.objectContaining({
          duplicateLocalGeometry: 1
        })
      })
    )
  })

  it('bounds local candidate detail independently from the generated candidate count', async () => {
    const events: IrregularDecisionTraceEvent[] = []
    const generatedCandidateCount = 200
    await runWindowed(
      sheet(generatedCandidateCount + 1, 1),
      [preparedPiece('a', 1, 1)],
      Layer.succeed(GeometrySettings, settings(1, 1, 4)),
      candidateService(({ moving }) =>
        Array.from({ length: generatedCandidateCount }, (_, index) => oneCandidate(moving, index))
      ),
      undefined,
      undefined,
      undefined,
      (event) => events.push(event)
    )

    const scoredEvents = events.filter((event) => event.kind === 'local_candidate_scored')
    const selectionEvents = events.filter((event) => event.kind === 'local_candidate_selection')
    const summary = events.find((event) => event.kind === 'local_candidate_summary')
    const localEvents = events.filter(
      (event) =>
        event.kind === 'local_candidate_scored' ||
        event.kind === 'local_candidate_selection' ||
        event.kind === 'local_candidate_summary'
    )
    expect(scoredEvents).toHaveLength(5)
    expect(selectionEvents).toHaveLength(5)
    expect(localEvents).toHaveLength(11)
    expect(
      new TextEncoder().encode(localEvents.map((event) => JSON.stringify(event)).join('\n'))
        .byteLength
    ).toBeLessThan(12_000)
    expect(summary).toEqual(
      expect.objectContaining({
        generatedCandidateCount,
        uniqueGeometryCandidateCount: generatedCandidateCount,
        selectedCandidateCount: 4,
        detailedCandidateCount: 5,
        decisionCounts: expect.objectContaining({
          withinLocalCandidateFanout: 4,
          outsideLocalCandidateFanout: generatedCandidateCount - 4
        })
      })
    )
    if (summary?.kind !== 'local_candidate_summary') throw new Error('missing trace summary')
    expect(
      Object.values(summary.decisionCounts).reduce((total, count) => total + count, 0)
    ).toBe(generatedCandidateCount)
  })

  it('returns the same winner and placements with bounded decision tracing enabled', async () => {
    const run = (emitDecisionTrace?: EmitIrregularDecisionTrace) =>
      runWindowed(
        sheet(12, 3),
        [preparedPiece('a', 2, 1), preparedPiece('b', 2, 1), preparedPiece('c', 2, 1)],
        Layer.succeed(GeometrySettings, settings(2, 3, 2)),
        candidateService(({ moving, placed }) =>
          Array.from({ length: 12 }, (_, index) =>
            oneCandidate(moving, index, placed.length % 2)
          )
        ),
        undefined,
        undefined,
        undefined,
        emitDecisionTrace
      )
    const traceEvents: IrregularDecisionTraceEvent[] = []
    const withoutTrace = await run()
    const withTrace = await run((event) => traceEvents.push(event))

    expect(stateSnapshot(withTrace)).toEqual(stateSnapshot(withoutTrace))
    expect(withTrace.bestScore).toEqual(withoutTrace.bestScore)
    expect(traceEvents.at(-1)).toEqual(expect.objectContaining({ kind: 'decode_winner' }))
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

  it('bottom-left normalizes every emitted winning-history state', async () => {
    const emittedBounds: Array<readonly [number, number]> = []
    const recordBounds = (state: IrregularBeamState): void => {
      const bounds = state.translatedCollisionBounds
      if (bounds !== undefined) emittedBounds.push([bounds.minX, bounds.minY])
    }
    const result = await runWindowed(
      sheet(8, 6),
      [preparedPiece('a', 1, 1), preparedPiece('b', 1, 1)],
      Layer.succeed(GeometrySettings, settings(1, 1, 1)),
      candidateService(({ moving, placed }) => [
        oneCandidate(moving, placed.length === 0 ? 2 : 4, 2)
      ]),
      undefined,
      {
        onInitialState: recordBounds,
        onStateSelected: ({ state }) => recordBounds(state)
      }
    )

    expect(result.bestState.translatedCollisionBounds?.minX).toBe(0)
    expect(result.bestState.translatedCollisionBounds?.minY).toBe(0)
    expect(emittedBounds).toEqual([
      [0, 0],
      [0, 0],
      [0, 0]
    ])
  })

  it('selects the legal terminal quarter-turn with the smallest bottom-left corner gap', async () => {
    const events: IrregularDecisionTraceEvent[] = []
    const emittedRotations: number[] = []
    const result = await runWindowed(
      sheet(4, 4),
      [preparedPiece('a', 1, 1), preparedPiece('b', 1, 1)],
      Layer.succeed(GeometrySettings, settings(1, 1, 1)),
      candidateService(({ moving, placed }) => [
        oneCandidate(moving, placed.length === 0 ? 0 : 1, placed.length === 0 ? 1 : 0)
      ]),
      undefined,
      {
        onStateSelected: ({ state }) => {
          const rotationDeg = state.placedCollisionGeometries[0]?.placement.transform.rotationDeg
          if (rotationDeg !== undefined) emittedRotations.push(rotationDeg)
        }
      },
      undefined,
      (event) => events.push(event)
    )

    expect(result.bestState.translatedCollisionBounds?.minX).toBe(0)
    expect(result.bestState.translatedCollisionBounds?.minY).toBe(0)
    expect(
      result.bestState.placedCollisionGeometries.map(
        ({ placement }) => placement.transform.rotationDeg
      )
    ).toEqual([90, 90])
    expect(emittedRotations).toEqual([90, 90])
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'terminal_orientation_scored',
        rotationDeg: 90,
        cornerGapMm: 0,
        decision: 'selected'
      })
    )
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'terminal_orientation_scored',
        rotationDeg: 0,
        cornerGapMm: 1,
        decision: 'rejected'
      })
    )
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

  it('forces the oldest piece after the reorder window has bypassed it', async () => {
    const ids = ['a', 'b', 'c', 'd', 'e']
    const xById = new Map([
      [PieceId.make('a'), 20],
      [PieceId.make('b'), 10],
      [PieceId.make('c'), 0],
      [PieceId.make('d'), 0],
      [PieceId.make('e'), 0]
    ])
    const events: IrregularDecisionTraceEvent[] = []
    const result = await runWindowed(
      sheet(30, 2),
      ids.map((id) => preparedPiece(id, 1, 1)),
      Layer.succeed(GeometrySettings, settings(3, 1)),
      candidateService(({ moving }) => [oneCandidate(moving, xById.get(moving.sourcePieceId) ?? 0)]),
      undefined,
      undefined,
      undefined,
      (event) => events.push(event)
    )

    expect(result.bestState.placementOrder.slice(0, 4)).toEqual([
      PieceId.make('c'),
      PieceId.make('d'),
      PieceId.make('a'),
      PieceId.make('b')
    ])
    const stepTwoEligiblePieceIds = events.flatMap((event) =>
      event.kind === 'eligible_pieces' && event.stepIndex === 2 ? [event.pieceIds] : []
    )
    expect(stepTwoEligiblePieceIds).toContainEqual([PieceId.make('a')])
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

  it('records local fanout rejection and beam pruning with explicit reasons', async () => {
    const events: IrregularDecisionTraceEvent[] = []
    await runWindowed(
      sheet(4, 1),
      [preparedPiece('a', 1, 1)],
      Layer.succeed(GeometrySettings, settings(1, 1, 2)),
      candidateService(({ moving }) => [
        oneCandidate(moving, 2),
        oneCandidate(moving, 0),
        oneCandidate(moving, 1)
      ]),
      undefined,
      undefined,
      undefined,
      (event) => events.push(event)
    )

    expect(events[0]).toBeInstanceOf(IrregularDecisionTraceDecodeStarted)
    const parent = events.find((event) => event.kind === 'parent_state')
    const eligible = events.find((event) => event.kind === 'eligible_pieces')
    const scored = events.find((event) => event.kind === 'successor_layout_scored')
    const retained = events
      .filter((event) => event.kind === 'beam_selection')
      .find((event) => event.decision === 'retained')
    expect(parent?.state.stateId).toMatch(/^s[0-9a-z]+$/)
    expect(eligible?.parentStateId).toBe(parent?.state.stateId)
    expect(retained?.stateId).toBe(scored?.state.stateId)
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'local_candidate_selection',
        rank: 3,
        decision: 'rejected',
        reason: 'outside_local_candidate_fanout'
      })
    )
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'beam_selection',
        rank: 2,
        decision: 'pruned',
        reason: 'outside_beam_width'
      })
    )
  })

  it('keeps decision tracing silent when the callback is absent', async () => {
    const events: IrregularDecisionTraceEvent[] = []
    await runWindowed(
      sheet(2, 1),
      [preparedPiece('a', 1, 1)],
      Layer.succeed(GeometrySettings, settings(1, 1, 1)),
      candidateService(({ moving }) => [oneCandidate(moving, 0)])
    )

    expect(events).toEqual([])
  })

  it('deduplicates equivalent successors before scoring the four terminal orientations', async () => {
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

    expect(scoreCalls.count).toBe(5)
    expect(result.rankedStates).toHaveLength(1)
    expect(result.bestState.placementOrder).toEqual([PieceId.make('a')])
    expect(result.bestState.placedCollisionGeometries.map(({ placement }) => placement.sourcePieceId)).toEqual([
      PieceId.make('a')
    ])
    expect(history).toEqual([0, 1])
  })

  it('deduplicates permutations of interchangeable prepared copies', async () => {
    const events: IrregularDecisionTraceEvent[] = []
    const firstCopy = preparedPiece('source', 1, 1, 'copy-1', undefined, 'source-copies')
    const secondCopy = preparedPiece('source', 1, 1, 'copy-2', undefined, 'source-copies')
    const result = await runWindowed(
      sheet(4, 1),
      [firstCopy, secondCopy],
      Layer.succeed(GeometrySettings, settings(2, 5, 1)),
      candidateService(({ moving, placed }) => [oneCandidate(moving, placed.length)]),
      undefined,
      undefined,
      undefined,
      (event) => events.push(event)
    )

    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'beam_step_completed',
        stepIndex: 0,
        uniqueSuccessorCount: 1,
        retainedStateCount: 1
      })
    )
    expect(result.bestState.placementOrder).toEqual([
      PieceId.make('copy-1'),
      PieceId.make('copy-2')
    ])
  })

  it('keeps distinct sources and per-copy transform preferences in the beam identity', async () => {
    const distinctSourceEvents: IrregularDecisionTraceEvent[] = []
    await runWindowed(
      sheet(4, 1),
      [
        preparedPiece('source-a', 1, 1, 'copy-a', undefined, 'source-a'),
        preparedPiece('source-b', 1, 1, 'copy-b', undefined, 'source-b')
      ],
      Layer.succeed(GeometrySettings, settings(2, 5, 1)),
      candidateService(({ moving, placed }) => [oneCandidate(moving, placed.length)]),
      undefined,
      undefined,
      undefined,
      (event) => distinctSourceEvents.push(event)
    )
    expect(distinctSourceEvents).toContainEqual(
      expect.objectContaining({
        kind: 'beam_step_completed',
        stepIndex: 0,
        uniqueSuccessorCount: 2
      })
    )

    const preferenceEvents: IrregularDecisionTraceEvent[] = []
    const firstCopy = preparedPiece('source', 1, 1, 'copy-1', undefined, 'source-copies')
    const secondCopy = preparedPiece('source', 1, 1, 'copy-2', undefined, 'source-copies')
    await runWindowed(
      sheet(4, 1),
      [firstCopy, secondCopy],
      Layer.succeed(GeometrySettings, settings(2, 5, 1)),
      candidateService(({ moving, placed }) => [oneCandidate(moving, placed.length)]),
      {
        transformPreferences: new Map([
          [PieceId.make('copy-1'), 0],
          [PieceId.make('copy-2'), 1]
        ])
      },
      undefined,
      undefined,
      (event) => preferenceEvents.push(event)
    )
    expect(preferenceEvents).toContainEqual(
      expect.objectContaining({
        kind: 'beam_step_completed',
        stepIndex: 0,
        uniqueSuccessorCount: 2
      })
    )
  })
})
