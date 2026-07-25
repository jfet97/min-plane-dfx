import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { DxfGeometrySummary, ImportedPiece } from '@shared/domain/dxf.js'
import { Rect } from '@shared/domain/geometry.js'
import { PieceId, SourceFileId } from '@shared/domain/ids.js'
import { SheetSpec } from '@shared/domain/nesting.js'
import {
  CollisionGeometry,
  IrregularBounds,
  IrregularPoint,
  IrregularPolygon,
  IrregularPreparedPiece,
  IrregularTransformCandidate
} from '@shared/irregular/domain.js'
import { observeIntrinsicShortSidePairFold } from '../../src/workers/algorithm/irregular/intrinsicShortSidePairFoldObserver.js'
import {
  assertCanonicalGridLegalLayout,
  canonicalCollisionLayoutIdentity
} from '../../src/workers/irregular/canonicalLayoutGeometry.js'
import {
  GeometryKernel,
  GeometrySettings
} from '../../src/workers/irregular/geometryKernel.js'

function point(x: number, y: number): IrregularPoint {
  return new IrregularPoint({ x, y })
}

function sourcePiece(id: string): ImportedPiece {
  return new ImportedPiece({
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
  })
}

function preparedRectangle(
  id: string,
  width: number,
  height: number
): IrregularPreparedPiece {
  const points = [
    point(0, 0),
    point(width, 0),
    point(width, height),
    point(0, height)
  ]
  const polygon = new IrregularPolygon({ points })
  return new IrregularPreparedPiece({
    pieceId: PieceId.make(id),
    source: sourcePiece(id),
    allowMirror: false,
    collisionGeometry: new CollisionGeometry({
      sourcePieceId: PieceId.make(id),
      sourceBounds: new IrregularBounds({
        minX: 0,
        minY: 0,
        maxX: width,
        maxY: height
      }),
      sampledPoints: points,
      convexHull: polygon,
      collisionPolygon: polygon,
      placementReference: point(0, 0),
      diagnostics: []
    }),
    transforms: [
      new IrregularTransformCandidate({
        index: 0,
        rotationDeg: 0,
        mirrored: false,
        reason: 'configured'
      })
    ]
  })
}

function readings(...values: ReadonlyArray<number>): () => number {
  let index = 0
  return () => values[Math.min(index++, values.length - 1)] ?? 0
}

function observe(input: {
  readonly pieces: ReadonlyArray<IrregularPreparedPiece>
  readonly sheet?: SheetSpec
  readonly productionShortAxisSpanMm?: number
  readonly productionMaximumSideMm?: number
  readonly productionEnvelopeAreaMm2?: number
  readonly maximumRuntimeMs?: number
  readonly maximumRssDeltaBytes?: number
  readonly maximumTraceBytes?: number
  readonly now?: () => number
  readonly currentRssBytes?: () => number
}) {
  return Effect.runPromise(
    observeIntrinsicShortSidePairFold({
      sheet:
        input.sheet ??
        new SheetSpec({
          width: 80,
          height: 100,
          label: 'portrait'
        }),
      preparedPieces: input.pieces,
      productionShortAxisSpanMm:
        input.productionShortAxisSpanMm ?? 40,
      productionMaximumSideMm:
        input.productionMaximumSideMm ?? 100,
      productionEnvelopeAreaMm2:
        input.productionEnvelopeAreaMm2 ?? 1_600,
      runtimeControl: {
        ...(input.maximumRuntimeMs === undefined
          ? {}
          : { maximumRuntimeMs: input.maximumRuntimeMs }),
        ...(input.maximumRssDeltaBytes === undefined
          ? {}
          : {
              maximumRssDeltaBytes:
                input.maximumRssDeltaBytes
            }),
        ...(input.maximumTraceBytes === undefined
          ? {}
          : { maximumTraceBytes: input.maximumTraceBytes }),
        ...(input.now === undefined ? {} : { now: input.now }),
        ...(input.currentRssBytes === undefined
          ? {}
          : { currentRssBytes: input.currentRssBytes })
      }
    }).pipe(
      Effect.provide(GeometryKernel.Live),
      Effect.provide(GeometrySettings.Live)
    )
  )
}

describe('intrinsic short-side pair-fold observer', () => {
  const acceptedPieces = [
    preparedRectangle('piece-1', 40, 20),
    preparedRectangle('piece-2', 40, 20),
    preparedRectangle('piece-3', 40, 20)
  ]

  it('selects one deterministic exact pair and preserves transpose identity', async () => {
    const portrait = await observe({ pieces: acceptedPieces })
    const landscape = await observe({
      pieces: acceptedPieces,
      sheet: new SheetSpec({
        width: 100,
        height: 80,
        label: 'landscape'
      })
    })

    expect(portrait.trace).toMatchObject({
      status: 'accepted',
      transformEvaluations: 3,
      expectedPairCount: 3,
      evaluatedPairCount: 3,
      selectedBottomPieceId: 'piece-1',
      selectedUpperPieceId: 'piece-2',
      placedCount: 3,
      usedShortAxisSpanMm: 80,
      usedLongAxisDepthMm: 40,
      admission: {
        exactLegal: true,
        allPiecesPlaced: true,
        accepted: true
      }
    })
    expect(portrait.placedCollisionGeometries).toHaveLength(3)
    expect(
      assertCanonicalGridLegalLayout(
        new SheetSpec({
          width: 80,
          height: 100,
          label: 'portrait'
        }),
        portrait.placedCollisionGeometries ?? []
      )
    ).toBe(true)
    expect(landscape.trace.status).toBe('accepted')
    expect(landscape.trace.prescribedRotationDeg).toBe(90)
    expect(
      canonicalCollisionLayoutIdentity(
        landscape.placedCollisionGeometries ?? []
      )
    ).toBe(
      canonicalCollisionLayoutIdentity(
        portrait.placedCollisionGeometries ?? []
      )
    )
  })

  it('reports rejected admission, no fitting pair, and no pair exactly', async () => {
    const rejected = await observe({
      pieces: [
        preparedRectangle('small-1', 20, 20),
        preparedRectangle('small-2', 20, 20),
        preparedRectangle('small-3', 20, 20)
      ],
      productionShortAxisSpanMm: 20,
      productionEnvelopeAreaMm2: 400
    })
    const noFit = await observe({
      pieces: [
        preparedRectangle('wide-1', 60, 20),
        preparedRectangle('wide-2', 60, 20),
        preparedRectangle('wide-3', 60, 20)
      ]
    })
    const noPair = await observe({
      pieces: [preparedRectangle('only-piece', 20, 20)]
    })

    expect(rejected.trace).toMatchObject({
      status: 'rejected-admission',
      expectedPairCount: 3,
      evaluatedPairCount: 3,
      admission: { accepted: false }
    })
    expect(rejected.placedCollisionGeometries).toBeUndefined()
    expect(noFit.trace).toMatchObject({
      status: 'no-fitting-pair',
      expectedPairCount: 3,
      evaluatedPairCount: 3,
      selectedBottomPieceId: undefined,
      selectedUpperPieceId: undefined
    })
    expect(noPair.trace).toMatchObject({
      status: 'no-pair',
      transformEvaluations: 1,
      expectedPairCount: 0,
      evaluatedPairCount: 0
    })
  })

  it('censors after completed transform work with exact counters', async () => {
    const deadline = await observe({
      pieces: acceptedPieces,
      maximumRuntimeMs: 500,
      now: readings(0, 501)
    })
    const memory = await observe({
      pieces: acceptedPieces,
      maximumRssDeltaBytes: 64 * 1_048_576,
      currentRssBytes: readings(0, 65 * 1_048_576)
    })

    expect(deadline.trace).toMatchObject({
      status: 'deadline',
      transformEvaluations: 1,
      expectedPairCount: 0,
      evaluatedPairCount: 0
    })
    expect(memory.trace).toMatchObject({
      status: 'memory-cap',
      transformEvaluations: 1,
      expectedPairCount: 0,
      evaluatedPairCount: 0
    })
  })

  it('discards an accepted layout when its stabilized trace exceeds the cap', async () => {
    const outcome = await observe({
      pieces: acceptedPieces,
      maximumTraceBytes: 1
    })

    expect(outcome.trace).toMatchObject({
      status: 'trace-cap',
      transformEvaluations: 3,
      expectedPairCount: 3,
      evaluatedPairCount: 3
    })
    expect(outcome.placedCollisionGeometries).toBeUndefined()
  })
})
