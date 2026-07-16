import { beforeEach, describe, expect, it } from 'vitest'
import { useHistoryStore } from '../../src/renderer/composables/useHistoryStore.js'
import type {
  NestingHistoryFrame,
  NestingHistorySummary,
  NestingResult,
  NestingStats
} from '@shared/domain/nesting.js'
import type { JobId, PieceId } from '@shared/domain/ids.js'
import type { ProjectRunRecord } from '@shared/domain/project.js'

const jobId = 'job-1' as JobId
const pieceId = 'piece-1' as PieceId

function stats(): NestingStats {
  return {
    elapsedMs: 1,
    pieceCount: 1,
    algorithm: {
      startedAt: '2026-06-30T10:00:00.000Z',
      endedAt: '2026-06-30T10:00:00.001Z',
      elapsedMs: 1
    }
  }
}

function result(): NestingResult {
  return {
    version: 1,
    jobId,
    status: 'partial',
    strategyResults: [
      {
        strategyRunId: 'job-1-subrun-0',
        strategyId: 'maxrects-beam-search',
        strategyLabel: 'MaxRects beam search',
        status: 'partial',
        sortedPieceIds: [pieceId],
        placements: [],
        unplacedPieceIds: [pieceId],
        warnings: [],
        stats: stats()
      }
    ],
    selectedStrategyRunId: 'job-1-subrun-0',
    sortedPieceIds: [pieceId],
    placements: [],
    unplacedPieceIds: [pieceId],
    warnings: [],
    stats: stats()
  }
}

function runRecord(): ProjectRunRecord {
  return {
    jobId,
    createdAt: '2026-06-30T10:00:00.000Z',
    label: 'MaxRects beam search',
    pieceCount: 1,
    sheet: { width: 100, height: 100, label: 'test' },
    result: result(),
    history: null
  }
}

function historySummary(): NestingHistorySummary {
  return {
    frameCount: 1,
    strategyRunCount: 1,
    retainedFrameCount: 1,
    truncated: false,
    scope: 'winning_path',
    strategyRunIds: ['job-1-subrun-0'],
    ndjsonPath: '/tmp/job-1.ndjson'
  }
}

function frame(): NestingHistoryFrame {
  return {
    frameId: 'frame-1',
    jobId,
    strategyRunId: 'job-1-subrun-0',
    strategyLabel: 'MaxRects beam search',
    stepIndex: 0,
    beamRank: 0,
    title: 'Step 0',
    plate: { placements: [], freeRectangles: [] },
    state: { remainingPieceIds: [pieceId], unplacedPieceIds: [] },
    createdAt: '2026-06-30T10:00:00.000Z'
  }
}

describe('useHistoryStore', () => {
  const store = useHistoryStore()

  beforeEach(() => {
    store.clearRunRecords()
  })

  it('attaches a late history completion ref to an existing run record', () => {
    store.addRunRecord(runRecord())

    store.completeRun(jobId, historySummary())

    expect(store.runRecords.value[0]?.history).toEqual({
      kind: 'ndjson_replay',
      jobId,
      path: '/tmp/job-1.ndjson',
      frameCount: 1,
      createdAt: expect.any(String)
    })
  })

  it('deduplicates replay frames loaded from both result and history events', () => {
    store.setResult(result())

    store.pushFrame(frame())
    store.pushFrame(frame())

    expect(store.frameCount.value).toBe(1)
  })

  it('returns to the final replay frame after a completed run', () => {
    store.setResult(result())
    store.pushFrame(frame())
    store.pushFrame({
      ...frame(),
      frameId: 'frame-1-final',
      stepIndex: 1,
      title: 'Step 1'
    })

    store.selectStepPosition(0)
    store.selectLatestFrame()

    expect(store.selectedFrame.value?.stepIndex).toBe(1)
  })
})
