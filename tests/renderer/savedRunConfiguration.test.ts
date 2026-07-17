import { describe, expect, it } from 'vitest'
import { savedRunRestoreStatus } from '../../src/renderer/utils/savedRunConfiguration.js'
import type { ImportedPiece } from '@shared/domain/dxf.js'
import type { NestingRequest, PreparedPiece } from '@shared/domain/nesting.js'
import type { JobId } from '@shared/domain/ids.js'

function sourcePiece(id: string, sourceFileId = 'source-file-1'): ImportedPiece {
  return {
    id: id as ImportedPiece['id'],
    sourceFileId: sourceFileId as ImportedPiece['sourceFileId'],
    label: id,
    realBounds: { x: 0, y: 0, width: 80, height: 70 },
    geometry: {
      entityType: 'LWPOLYLINE',
      closed: true,
      segments: [{ kind: 'line', x1: 0, y1: 0, x2: 80, y2: 0 }]
    },
    warnings: []
  }
}

function preparedCopy(baseId: string, copy: number, allowMirror: boolean): PreparedPiece {
  const copyId = `${baseId}-copy-${copy}`
  return {
    id: copyId as PreparedPiece['id'],
    sourcePieceId: copyId as PreparedPiece['sourcePieceId'],
    interchangeabilityKey: baseId,
    realBounds: { x: 0, y: 0, width: 80, height: 70 },
    paddedBounds: {
      x: 0,
      y: 0,
      width: 90,
      height: 80,
      longestEdge: 90,
      area: 7200,
      imbalance: 10
    },
    padding: 5,
    allowRotation: true,
    allowMirror
  }
}

function request(): NestingRequest {
  const pieces = [preparedCopy('triangle', 1, false), preparedCopy('triangle', 2, false)]
  return {
    version: 1,
    jobId: 'job-1' as JobId,
    sheet: { width: 2000, height: 2700, label: 'test sheet' },
    padding: 10,
    pieces,
    sourcePieces: pieces.map((piece) => ({
      ...sourcePiece(piece.sourcePieceId),
      id: piece.sourcePieceId
    })),
    options: {
      allowGlobalRotation: true,
      allowGlobalMirror: true,
      timeoutMs: 60000,
      workerMode: 'irregular-convex-v2',
      historyMode: 'final',
      historyScope: 'winning_path',
      strategySelectionMode: 'single',
      strategyIds: ['edge-contact'],
      layoutSelectionStrategyId: 'compact-quality',
      finalSelectionMode: 'manual'
    }
  }
}

describe('savedRunRestoreStatus', () => {
  it('reconstructs quantities and mirror eligibility from the exact request copies', () => {
    const status = savedRunRestoreStatus({ request: request() }, [sourcePiece('triangle')])

    expect(status).toEqual({
      available: true,
      quantities: { triangle: 2 },
      mirrorEnabled: { triangle: false }
    })
  })

  it('refuses restoration when a referenced source shape is missing', () => {
    const status = savedRunRestoreStatus({ request: request() }, [])

    expect(status.available).toBe(false)
    if (!status.available) expect(status.reason).toContain('Missing source shape(s): triangle')
  })

  it('refuses restoration when the current source identity or geometry changed', () => {
    const status = savedRunRestoreStatus({ request: request() }, [
      {
        ...sourcePiece('triangle'),
        sourceFileId: 'different-source' as ImportedPiece['sourceFileId']
      }
    ])

    expect(status.available).toBe(false)
    if (!status.available) expect(status.reason).toContain('Source geometry changed')
  })

  it('keeps legacy records visible but marks configuration restore unavailable', () => {
    const status = savedRunRestoreStatus({}, [sourcePiece('triangle')])

    expect(status.available).toBe(false)
    if (!status.available) expect(status.reason).toContain('before request snapshots')
  })
})
