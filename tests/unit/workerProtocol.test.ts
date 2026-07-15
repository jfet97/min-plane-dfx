import { describe, expect, it } from 'vitest'
import { Cause, Exit, Schema } from 'effect'
import { RunNestingPayload, WorkerRequest, WorkerResponse } from '@shared/protocol/worker.js'

const validate = (schema: Schema.Top, input: unknown) =>
  Schema.decodeUnknownExit(schema as never)(input)

describe('WorkerRequest', () => {
  it('accepts a valid run_nesting request', () => {
    const request = {
      type: 'run_nesting' as const,
      requestId: 'r-1',
      payload: {
        version: 1,
        jobId: 'job-1',
        sheet: { width: 100, height: 100, label: 'default' },
        padding: 2,
        pieces: [
          {
            id: 'p-1',
            sourcePieceId: 'p-1',
            realBounds: { x: 0, y: 0, width: 10, height: 5 },
            paddedBounds: {
              x: 0,
              y: 0,
              width: 14,
              height: 9,
              longestEdge: 14,
              area: 126,
              imbalance: 5
            },
            padding: 2,
            allowRotation: true
          }
        ],
        options: {
          allowGlobalRotation: true,
          timeoutMs: 5000,
          workerMode: 'maxrects-beam-search' as const,
          historyMode: 'final' as const,
          historyScope: 'winning_path' as const,
          strategySelectionMode: 'single' as const,
          strategyIds: ['balanced-preserve-free-then-bottom-left'],
          layoutSelectionStrategyId: 'compact-first',
          finalSelectionMode: 'manual' as const
        }
      }
    }
    const result = validate(WorkerRequest, request)
    expect(Exit.isSuccess(result)).toBe(true)
  })

  it('encodes prepared piece padded bounds for the RPC worker boundary', () => {
    const payload = {
      requestId: 'r-1',
      request: {
        version: 1,
        jobId: 'job-1',
        sheet: { width: 100, height: 100, label: 'default' },
        padding: 2,
        pieces: [
          {
            id: 'p-1',
            sourcePieceId: 'p-1',
            realBounds: { x: 0, y: 0, width: 10, height: 5 },
            paddedBounds: {
              x: 0,
              y: 0,
              width: 14,
              height: 9,
              longestEdge: 14,
              area: 126,
              imbalance: 5
            },
            padding: 2,
            allowRotation: true
          }
        ],
        options: {
          allowGlobalRotation: true,
          timeoutMs: 5000,
          workerMode: 'maxrects-beam-search' as const,
          historyMode: 'final' as const,
          historyScope: 'winning_path' as const,
          strategySelectionMode: 'single' as const,
          strategyIds: ['balanced-preserve-free-then-bottom-left'],
          layoutSelectionStrategyId: 'compact-first',
          finalSelectionMode: 'manual' as const
        }
      }
    }

    const decoded = Schema.decodeUnknownExit(RunNestingPayload)(payload)
    if (Exit.isFailure(decoded)) {
      throw new Error(Cause.pretty(decoded.cause))
    }

    const encoded = Schema.encodeUnknownExit(RunNestingPayload)(decoded.value)
    if (Exit.isFailure(encoded)) {
      throw new Error(Cause.pretty(encoded.cause))
    }
    expect(Exit.isSuccess(encoded)).toBe(true)
  })

  it('rejects a request with unknown type', () => {
    const result = validate(WorkerRequest, { type: 'whatever', requestId: 'r-1' })
    expect(Exit.isFailure(result)).toBe(true)
  })
})

describe('WorkerResponse', () => {
  it('accepts a valid progress response', () => {
    const response = {
      type: 'progress' as const,
      requestId: 'r-1',
      jobId: 'job-1',
      payload: { phase: 'started' as const, at: '2025-01-01T00:00:00.000Z' }
    }
    const result = validate(WorkerResponse, response)
    expect(Exit.isSuccess(result)).toBe(true)
  })

  it('accepts a valid history_frame response', () => {
    const response = {
      type: 'history_frame' as const,
      requestId: 'r-1',
      jobId: 'job-1',
      payload: {
        frameId: 'f-1',
        jobId: 'job-1',
        strategyRunId: 's-1',
        strategyLabel: 'maxrects-beam-search',
        stepIndex: 0,
        beamRank: 0,
        title: 'frame 0',
        plate: { placements: [], freeRectangles: [] },
        state: { remainingPieceIds: [], unplacedPieceIds: [] },
        createdAt: '2025-01-01T00:00:00.000Z'
      }
    }
    const result = validate(WorkerResponse, response)
    expect(Exit.isSuccess(result)).toBe(true)
  })

  it('accepts a tagged irregular history frame without rectangular state', () => {
    const response = {
      type: 'history_frame' as const,
      requestId: 'r-1',
      jobId: 'job-1',
      payload: {
        kind: 'irregular' as const,
        frameId: 'f-1',
        jobId: 'job-1',
        strategyRunId: 's-1',
        strategyLabel: 'irregular beam',
        stepIndex: 1,
        title: 'beam step',
        placements: [
          {
            pieceId: 'copy-1',
            sourcePieceId: 'source-1',
            transform: { translateX: 2, translateY: 3, rotationDeg: 0, mirrored: false }
          }
        ],
        remainingPieceIds: ['copy-2'],
        unplacedPieceIds: [],
        beamRank: 0,
        beamWidth: 4,
        candidateCount: 2,
        createdAt: '2026-07-15T00:00:00.000Z'
      }
    }
    const result = validate(WorkerResponse, response)
    expect(Exit.isSuccess(result)).toBe(true)
  })

  it('accepts a typed irregular source-geometry failure response', () => {
    const response = {
      type: 'failure' as const,
      requestId: 'r-1',
      jobId: 'job-1',
      error: {
        code: 'irregular_source_geometry_missing',
        message: 'No imported source geometry was found for prepared piece p-1.',
        context: {
          preparedPieceId: 'p-1',
          sourcePieceId: 'source-1'
        }
      }
    }
    const result = validate(WorkerResponse, response)
    expect(Exit.isSuccess(result)).toBe(true)
  })

  it('rejects a malformed progress phase', () => {
    const result = validate(WorkerResponse, {
      type: 'progress',
      requestId: 'r-1',
      jobId: 'job-1',
      payload: { phase: 'halfway', at: '2025-01-01T00:00:00.000Z' }
    })
    expect(Exit.isFailure(result)).toBe(true)
  })
})
