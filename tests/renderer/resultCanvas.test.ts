import { describe, expect, it } from 'vitest'
import type { ImportedPiece } from '@shared/domain/dxf.js'
import type { PieceId } from '@shared/domain/ids.js'
import type { Placement } from '@shared/domain/nesting.js'
import type { IrregularLayoutScoreSummary, IrregularPlacement } from '@shared/irregular/domain.js'
import {
  buildIrregularCanvasModel,
  irregularPlacementSvgTransform,
  rectangularPlacementSvgTransform,
  transformIrregularPoint,
  type IrregularCanvasSource
} from '../../src/renderer/utils/resultCanvas.js'

function pieceId(value: string): PieceId {
  return value as PieceId
}

function irregularPlacement(input: {
  readonly pieceId?: string
  readonly sourcePieceId: string
  readonly reference?: { readonly x: number; readonly y: number }
  readonly translateX: number
  readonly translateY: number
  readonly rotationDeg: number
  readonly mirrored?: boolean
}): IrregularPlacement {
  return {
    ...(input.pieceId === undefined ? {} : { pieceId: pieceId(input.pieceId) }),
    sourcePieceId: pieceId(input.sourcePieceId),
    ...(input.reference === undefined
      ? {}
      : {
          placementReference: input.reference
        }),
    transform: {
      translateX: input.translateX,
      translateY: input.translateY,
      rotationDeg: input.rotationDeg,
      mirrored: input.mirrored ?? false
    }
  }
}

function sourcePiece(id: string): ImportedPiece {
  return {
    id: pieceId(id),
    sourceFileId: 'source-file' as ImportedPiece['sourceFileId'],
    label: id,
    realBounds: { x: 10, y: 20, width: 4, height: 3 },
    geometry: {
      entityType: 'PRESET_SHAPE',
      closed: true,
      segments: [
        { kind: 'line', x1: 10, y1: 20, x2: 14, y2: 20 },
        {
          kind: 'arc',
          x1: 14,
          y1: 20,
          x2: 10,
          y2: 20,
          cx: 12,
          cy: 20,
          radius: 2,
          startAngle: 0,
          endAngle: 180
        }
      ]
    },
    warnings: []
  }
}

describe('result canvas transforms', () => {
  it('maps the source placement reference directly to the stored translation', () => {
    const placement = irregularPlacement({
      sourcePieceId: 'source-1',
      reference: { x: 10, y: 20 },
      translateX: 100,
      translateY: 200,
      rotationDeg: 137
    })

    expect(transformIrregularPoint({ x: 10, y: 20 }, placement)).toEqual({ x: 100, y: 200 })
  })

  it('mirrors before rotating around the source pivot', () => {
    const placement = irregularPlacement({
      sourcePieceId: 'source-1',
      reference: { x: 10, y: 20 },
      translateX: 100,
      translateY: 200,
      rotationDeg: 90,
      mirrored: true
    })

    expect(transformIrregularPoint({ x: 14, y: 23 }, placement)).toEqual({ x: 97, y: 196 })
    expect(irregularPlacementSvgTransform(placement, 500)).toBe('matrix(0 1 -1 0 120 290)')
  })

  it('generates an irregular model from source geometry without rectangle stand-ins', () => {
    const source: IrregularCanvasSource = {
      placements: [
        irregularPlacement({
          pieceId: 'source-1-copy-1',
          sourcePieceId: 'source-1',
          reference: { x: 10, y: 20 },
          translateX: 30,
          translateY: 40,
          rotationDeg: 0
        }),
        irregularPlacement({
          sourcePieceId: 'missing-source',
          reference: { x: 0, y: 0 },
          translateX: 50,
          translateY: 60,
          rotationDeg: 0
        }),
        irregularPlacement({
          sourcePieceId: 'source-1',
          translateX: 70,
          translateY: 80,
          rotationDeg: 0
        })
      ],
      unplacedPieceIds: [pieceId('leftover-1')],
      score: {
        unplacedCount: 1,
        largestNetFreeMaterialRegionAreaMm2: 125,
        freeMaterialRegionCount: 2,
        freeMaterialHoleCount: 1,
        freeMaterialSliverMetric: 0.5,
        collisionBoundsWorstNormalizedSheetConsumption: 0.4,
        collisionBoundsNormalizedSpanSum: 0.7,
        collisionBoundsAreaMm2: 80,
        collisionBoundsSpanMm: 18
      } satisfies IrregularLayoutScoreSummary,
      diagnostics: []
    }

    const model = buildIrregularCanvasModel({
      source,
      sourcePieces: [sourcePiece('source-1')],
      sheet: { height: 200 }
    })

    expect(model.placements[0]?.sourcePiece?.id).toBe(pieceId('source-1'))
    expect(model.placements[0]?.status).toBe('rendered')
    expect(model.placements[0]?.svgTransform).toBe('matrix(1 0 0 -1 20 180)')
    expect(model.placements[1]?.status).toBe('source-missing')
    expect(model.placements[2]?.status).toBe('placement-reference-missing')
    expect(model.unplacedPieceIds).toEqual([pieceId('leftover-1')])
    expect(model.unrenderablePlacementCount).toBe(2)
    expect(model.score?.largestNetFreeMaterialRegionAreaMm2).toBe(125)
    expect(model.placements[0]?.sourcePiece?.geometry.segments[1]?.kind).toBe('arc')
  })

  it('keeps the established rectangular source transform unchanged', () => {
    const placement: Placement = {
      pieceId: pieceId('rect-1'),
      x: 5,
      y: 10,
      width: 20,
      height: 30,
      rotation: 0
    }

    expect(
      rectangularPlacementSvgTransform(placement, { x: 2, y: 3, width: 16, height: 24 }, 100)
    ).toBe('matrix(1 0 0 1 5 60)')
  })
})
