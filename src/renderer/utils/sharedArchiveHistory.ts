import { isIrregularHistoryFrame } from '@shared/domain/nesting.js'
import type { NestingHistoryFramePayload } from '@shared/domain/nesting.js'

/** Expands a legacy terminal-only shared-archive frame into a truthful layout reveal. */
export function expandSharedArchiveSelectedLayoutReveal(
  frame: NestingHistoryFramePayload
): ReadonlyArray<NestingHistoryFramePayload> {
  if (
    !isIrregularHistoryFrame(frame) ||
    frame.title !== 'shared-archive-final-selected' ||
    frame.placements.length === 0
  ) {
    return [frame]
  }

  const orderedPieceIds = frame.placements.map(
    (placement) => placement.pieceId ?? placement.sourcePieceId
  )
  return Array.from({ length: frame.placements.length + 1 }, (_, stepIndex) => ({
    ...frame,
    frameId: `${frame.frameId}:selected-layout-reveal:${stepIndex}`,
    stepIndex,
    title:
      stepIndex === frame.placements.length
        ? 'shared-archive-final-selected'
        : 'shared-archive-selected-layout-reveal',
    placements: frame.placements.slice(0, stepIndex),
    ...(frame.collisionPolygons === undefined
      ? {}
      : { collisionPolygons: frame.collisionPolygons.slice(0, stepIndex) }),
    remainingPieceIds: orderedPieceIds.slice(stepIndex),
    beamRank: 0,
    beamWidth: 1,
    candidateCount: 1
  }))
}
