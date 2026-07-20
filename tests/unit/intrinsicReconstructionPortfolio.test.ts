import { describe, expect, it } from 'vitest'
import { DxfGeometrySummary, ImportedPiece } from '@shared/domain/dxf.js'
import { Rect } from '@shared/domain/geometry.js'
import { PieceId, SourceFileId } from '@shared/domain/ids.js'
import {
  CollisionGeometry,
  IrregularBounds,
  IrregularPlacedPiece,
  IrregularPlacement,
  IrregularPoint,
  IrregularPolygon,
  IrregularPreparedPiece,
  IrregularTransform,
  IrregularTransformCandidate,
  TransformedCollisionGeometry
} from '@shared/irregular/domain.js'
import {
  buildCanonicalEndpointOrders,
  retainIntrinsicReconstructionArchive,
  type IntrinsicReconstructionRun
} from '../../src/workers/algorithm/irregular/intrinsicReconstructionPortfolio.js'
import type { IntrinsicStrictCompletedMetrics } from '../../src/workers/algorithm/irregular/intrinsicStrictDecoder.js'

function point(x: number, y: number): IrregularPoint {
  return new IrregularPoint({ x, y })
}

function piece(id: string): IrregularPreparedPiece {
  const points = [point(0, 0), point(2, 0), point(2, 2), point(0, 2)]
  const polygon = new IrregularPolygon({ points })
  const source = new ImportedPiece({
    id: PieceId.make(id),
    sourceFileId: SourceFileId.make(`source-${id}`),
    label: id,
    realBounds: new Rect({ x: 0, y: 0, width: 2, height: 2 }),
    geometry: new DxfGeometrySummary({ entityType: 'PRESET_SHAPE', closed: true, segments: [] }),
    warnings: []
  })
  return new IrregularPreparedPiece({
    pieceId: source.id,
    source,
    allowMirror: false,
    collisionGeometry: new CollisionGeometry({
      sourcePieceId: source.id,
      sourceBounds: new IrregularBounds({ minX: 0, minY: 0, maxX: 2, maxY: 2 }),
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

function place(prepared: IrregularPreparedPiece, x: number, y: number): IrregularPlacedPiece {
  const transform = prepared.transforms[0]
  if (transform === undefined) throw new Error('test transform missing')
  return new IrregularPlacedPiece({
    placement: new IrregularPlacement({
      pieceId: prepared.pieceId,
      sourcePieceId: prepared.source.id,
      placementReference: prepared.collisionGeometry.placementReference,
      transform: new IrregularTransform({
        translateX: x,
        translateY: y,
        rotationDeg: 0,
        mirrored: false
      })
    }),
    collisionGeometry: new TransformedCollisionGeometry({
      sourcePieceId: prepared.source.id,
      transform,
      polygon: prepared.collisionGeometry.collisionPolygon,
      bounds: prepared.collisionGeometry.sourceBounds
    })
  })
}

function metrics(hash: string, maximumSide: number): IntrinsicStrictCompletedMetrics {
  return {
    envelopeMaximumSideMm: maximumSide,
    envelopeAreaMm2: maximumSide * maximumSide,
    envelopeSpanMm: maximumSide * 2,
    enclosedCavityCount: 0,
    totalEnclosedCavityAreaMm2: 0,
    largestOccupiedHullGapRatio: 0,
    isolatedPieceCount: 0,
    positiveContactComponentCount: 1,
    largestPositiveContactComponentSize: 3,
    largestPositiveContactComponentRatio: 1,
    occupiedAreaOutsideLargestContactComponentMm2: 0,
    occupiedHullWasteRatio: 0,
    totalStructuralContacts: 2,
    dominantStructuralContacts: 2,
    contactUnits: 2,
    sharedBoundaryLengthMm: 4,
    canonicalGeometryHash: hash,
    runtimeMs: 1
  }
}

function run(hash: string, maximumSide: number): IntrinsicReconstructionRun {
  return {
    role: 'reversed-priority',
    sourceEndpointHash: undefined,
    candidateMode: 'pure-growth',
    pieceIds: [],
    status: 'completed',
    duplicateOf: undefined,
    placedCollisionGeometries: [],
    stepTrace: [],
    gapFillEvidence: [],
    metrics: metrics(hash, maximumSide),
    runtimeMs: 1
  }
}

describe('intrinsic reconstruction portfolio', () => {
  it('derives paired q0/q90 traversal orders from exact endpoint geometry', () => {
    const first = piece('first')
    const second = piece('second')
    const third = piece('third')
    const orders = buildCanonicalEndpointOrders(
      [first, second, third],
      [place(first, 0, 0), place(second, 10, 20), place(third, 20, 10)]
    )
    const ids = Object.fromEntries(
      orders.map(({ role, pieces }) => [role, pieces.map(({ pieceId }) => pieceId)])
    )

    expect(ids['endpoint-q0-left-to-right']).toEqual([
      PieceId.make('first'),
      PieceId.make('second'),
      PieceId.make('third')
    ])
    expect(ids['endpoint-q0-right-to-left']).toEqual([
      PieceId.make('third'),
      PieceId.make('second'),
      PieceId.make('first')
    ])
    expect(ids['endpoint-q90-left-to-right']).toEqual([
      PieceId.make('second'),
      PieceId.make('third'),
      PieceId.make('first')
    ])
    expect(ids['endpoint-q90-right-to-left']).toEqual([
      PieceId.make('first'),
      PieceId.make('third'),
      PieceId.make('second')
    ])
  })

  it('deduplicates canonical identities and applies the shared exact order', () => {
    const retained = retainIntrinsicReconstructionArchive([
      run('larger', 20),
      run('smaller', 10),
      run('smaller', 10)
    ])

    expect(retained.map(({ metrics: value }) => value.canonicalGeometryHash)).toEqual([
      'smaller',
      'larger'
    ])
  })
})
