import { Effect, Layer } from 'effect'
import { describe, expect, it } from 'vitest'
import { DxfGeometrySummary, ImportedPiece } from '@shared/domain/dxf.js'
import { Rect } from '@shared/domain/geometry.js'
import { PieceId, SourceFileId } from '@shared/domain/ids.js'
import {
  CollisionGeometry,
  IrregularBounds,
  IrregularPlacedPiece,
  IrregularPlacement,
  IrregularPlacementCandidate,
  IrregularPoint,
  IrregularPolygon,
  IrregularPreparedPiece,
  IrregularTransform,
  IrregularTransformCandidate,
  TransformedCollisionGeometry
} from '@shared/irregular/domain.js'
import { constructIntrinsicStrictState } from '../../src/workers/algorithm/irregular/intrinsicStrictDecoder.js'
import {
  candidateContainedInIntrinsicGap,
  deriveCanonicalIntrinsicGapRegions
} from '../../src/workers/algorithm/irregular/intrinsicGapRegions.js'
import { GeometryKernel, GeometrySettings } from '../../src/workers/irregular/geometryKernel.js'
import { NfpIfpServiceLive } from '../../src/workers/irregular/nfpIfpService.js'
import { NfpIfpService } from '../../src/workers/irregular/services.js'

function point(x: number, y: number): IrregularPoint {
  return new IrregularPoint({ x, y })
}

function piece(id: string, width: number, height: number): IrregularPreparedPiece {
  const points = [point(0, 0), point(width, 0), point(width, height), point(0, height)]
  const polygon = new IrregularPolygon({ points })
  const source = new ImportedPiece({
    id: PieceId.make(id),
    sourceFileId: SourceFileId.make(`source-${id}`),
    label: id,
    realBounds: new Rect({ x: 0, y: 0, width, height }),
    geometry: new DxfGeometrySummary({ entityType: 'PRESET_SHAPE', closed: true, segments: [] }),
    warnings: []
  })
  return new IrregularPreparedPiece({
    pieceId: source.id,
    source,
    allowMirror: false,
    collisionGeometry: new CollisionGeometry({
      sourcePieceId: source.id,
      sourceBounds: new IrregularBounds({ minX: 0, minY: 0, maxX: width, maxY: height }),
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

function place(piece: IrregularPreparedPiece, x: number, y: number): IrregularPlacedPiece {
  const transform = piece.transforms[0]
  if (transform === undefined) throw new Error('test transform missing')
  const points = piece.collisionGeometry.collisionPolygon.points
  return new IrregularPlacedPiece({
    placement: new IrregularPlacement({
      pieceId: piece.pieceId,
      sourcePieceId: piece.source.id,
      placementReference: piece.collisionGeometry.placementReference,
      transform: new IrregularTransform({
        translateX: x,
        translateY: y,
        rotationDeg: 0,
        mirrored: false
      })
    }),
    collisionGeometry: new TransformedCollisionGeometry({
      sourcePieceId: piece.source.id,
      transform,
      polygon: new IrregularPolygon({ points }),
      bounds: piece.collisionGeometry.sourceBounds
    })
  })
}

describe('intrinsic gap regions', () => {
  it('derives exact hull gaps and accepts boundary-touching containment', () => {
    const left = piece('left', 1, 4)
    const right = piece('right', 1, 4)
    const bottom = piece('bottom', 2, 1)
    const small = piece('small', 2, 1)
    const frozen = [place(left, 0, 0), place(bottom, 1, 0), place(right, 3, 0)]
    const regions = deriveCanonicalIntrinsicGapRegions(frozen)

    expect(regions).toHaveLength(1)
    expect(regions?.[0]?.areaMm2).toBe(6)
    const region = regions?.[0]
    if (region === undefined) return
    expect(
      candidateContainedInIntrinsicGap(place(small, 0, 0).collisionGeometry, point(1, 1), region)
    ).toBe(true)
    expect(
      candidateContainedInIntrinsicGap(place(small, 0, 0).collisionGeometry, point(1, 4), region)
    ).toBe(false)
  })

  it('selects a real contained L1 candidate and records non-inert evidence', async () => {
    const left = piece('left', 1, 4)
    const right = piece('right', 1, 4)
    const bottom = piece('bottom', 2, 1)
    const small = piece('small', 2, 1)
    const all = [left, bottom, right, small]
    const frozen = [place(left, 0, 0), place(bottom, 1, 0), place(right, 3, 0)]
    const result = await Effect.runPromise(
      constructIntrinsicStrictState({
        allPreparedPieces: all,
        remainingPreparedPieces: [small],
        frozenPlaced: frozen,
        candidateMode: { kind: 'gap-contained' }
      }).pipe(
        Effect.provide(GeometryKernel.Live),
        Effect.provide(GeometrySettings.Live),
        Effect.provide(NfpIfpServiceLive)
      )
    )

    expect(result.state.unplacedPieceIds).toEqual([])
    expect(result.gapFillEvidence).toHaveLength(1)
    expect(result.gapFillEvidence[0]).toMatchObject({
      regionAreaBeforeMm2: 6,
      regionAreaAfterMm2: 4,
      envelopeMaximumSideDeltaMm: 0,
      envelopeAreaDeltaMm2: 0,
      nonInert: true
    })
  })

  it('retains contained candidates before same-family growth collapse and measures incremental contact', async () => {
    const bottomLeft = piece('bottom-left', 1, 1)
    const bottomRight = piece('bottom-right', 1, 1)
    const topLeft = piece('top-left', 1, 1)
    const small = piece('small', 1, 1)
    const all = [bottomLeft, bottomRight, topLeft, small]
    const frozen = [place(bottomLeft, 0, 0), place(bottomRight, 1, 0), place(topLeft, 0, 4)]
    const candidateService = Layer.succeed(NfpIfpService, {
      computeNfp: () => Effect.die('unused'),
      computeIfpBounds: () => Effect.die('unused'),
      generatePlacementCandidates: ({ moving }) =>
        Effect.succeed([
          new IrregularPlacementCandidate({
            pieceId: moving.sourcePieceId,
            transform: moving.transform,
            point: point(1, 4),
            diagnostics: []
          }),
          new IrregularPlacementCandidate({
            pieceId: moving.sourcePieceId,
            transform: moving.transform,
            point: point(0.5, 2),
            diagnostics: []
          })
        ])
    })
    const regions = deriveCanonicalIntrinsicGapRegions(frozen)
    expect(
      regions?.some((region) =>
        candidateContainedInIntrinsicGap(
          place(small, 0, 0).collisionGeometry,
          point(0.5, 2),
          region
        )
      )
    ).toBe(true)
    const result = await Effect.runPromise(
      constructIntrinsicStrictState({
        allPreparedPieces: all,
        remainingPreparedPieces: [small],
        frozenPlaced: frozen,
        candidateMode: { kind: 'gap-contained' }
      }).pipe(
        Effect.provide(GeometryKernel.Live),
        Effect.provide(GeometrySettings.Live),
        Effect.provide(candidateService)
      )
    )

    expect(result.state.placedCollisionGeometries.at(-1)?.placement.transform).toMatchObject({
      translateX: 0.5,
      translateY: 2
    })
    expect(result.gapFillEvidence[0]).toMatchObject({
      sharedBoundaryLengthMm: 0,
      nonInert: false
    })
  })
})
