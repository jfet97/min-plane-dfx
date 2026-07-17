import { describe, expect, it } from 'vitest'
import type { JobId, PieceId } from '@shared/domain/ids.js'
import {
  IrregularHistoryFrame,
  IrregularPlacement,
  IrregularPoint,
  IrregularPolygon,
  IrregularTransform
} from '@shared/irregular/domain.js'
import { selectFirstBeamSequence } from '../../src/renderer/utils/runHistoryGif.js'

const jobId = 'job-irregular-gif' as JobId
const firstPieceId = 'triangle-copy-1' as PieceId
const secondPieceId = 'triangle-copy-2' as PieceId
const sourcePieceId = 'triangle' as PieceId

function frame(input: {
  readonly id: string
  readonly stepIndex: number
  readonly beamRank: number
  readonly pieceIds: ReadonlyArray<PieceId>
}): IrregularHistoryFrame {
  return new IrregularHistoryFrame({
    kind: 'irregular',
    frameId: input.id,
    jobId,
    strategyRunId: 'irregular-run',
    strategyLabel: 'Irregular convex windowed beam',
    stepIndex: input.stepIndex,
    title: `Step ${input.stepIndex}`,
    placements: input.pieceIds.map(
      (pieceId, index) =>
        new IrregularPlacement({
          pieceId,
          sourcePieceId,
          placementReference: new IrregularPoint({ x: 0, y: 0 }),
          transform: new IrregularTransform({
            translateX: index * 10,
            translateY: 0,
            rotationDeg: 0,
            mirrored: false
          })
        })
    ),
    collisionPolygons: input.pieceIds.map(
      (_pieceId, index) =>
        new IrregularPolygon({
          points: [
            new IrregularPoint({ x: index * 10, y: 0 }),
            new IrregularPoint({ x: index * 10 + 8, y: 0 }),
            new IrregularPoint({ x: index * 10, y: 8 })
          ]
        })
    ),
    remainingPieceIds: [],
    unplacedPieceIds: [],
    beamRank: input.beamRank,
    beamWidth: 8,
    createdAt: '2026-07-17T00:00:00.000Z'
  })
}

describe('run history GIF sequence selection', () => {
  it('keeps meaningful rank-zero irregular polygon frames', () => {
    const frames = [
      frame({ id: 'empty', stepIndex: 0, beamRank: 0, pieceIds: [] }),
      frame({ id: 'rank-one', stepIndex: 1, beamRank: 1, pieceIds: [secondPieceId] }),
      frame({ id: 'first', stepIndex: 1, beamRank: 0, pieceIds: [firstPieceId] }),
      frame({ id: 'duplicate', stepIndex: 2, beamRank: 0, pieceIds: [firstPieceId] }),
      frame({
        id: 'second',
        stepIndex: 3,
        beamRank: 0,
        pieceIds: [firstPieceId, secondPieceId]
      })
    ]

    const selected = selectFirstBeamSequence(frames, 'irregular-run')

    expect(selected.map(({ frameId }) => frameId)).toEqual(['first', 'second'])
  })
})
