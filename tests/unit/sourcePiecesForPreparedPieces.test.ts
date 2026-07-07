import { describe, expect, it } from 'vitest'
import { sourcePiecesForPreparedPieces } from '@shared/sourcePiecesForPreparedPieces.js'
import type { ImportedPiece } from '@shared/domain/dxf.js'
import type { PreparedPiece } from '@shared/domain/nesting.js'

function sourcePiece(id: string): ImportedPiece {
  return {
    id: id as ImportedPiece['id'],
    sourceFileId: 'sf-1' as ImportedPiece['sourceFileId'],
    label: id,
    realBounds: { x: 0, y: 0, width: 10, height: 5 },
    geometry: {
      entityType: 'LWPOLYLINE',
      closed: true,
      segments: [{ kind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 }]
    },
    warnings: []
  }
}

function preparedPiece(id: string, sourcePieceId = id): PreparedPiece {
  return {
    id: id as PreparedPiece['id'],
    sourcePieceId: sourcePieceId as PreparedPiece['sourcePieceId'],
    realBounds: { x: 0, y: 0, width: 10, height: 5 },
    paddedBounds: { x: 0, y: 0, width: 14, height: 9, longestEdge: 14, area: 126, imbalance: 5 },
    padding: 2,
    allowRotation: true
  }
}

describe('sourcePiecesForPreparedPieces', () => {
  it('returns source geometry for direct prepared source ids', () => {
    const result = sourcePiecesForPreparedPieces([preparedPiece('p-1')], [sourcePiece('p-1')])

    expect(result.map((piece) => piece.id)).toEqual(['p-1'])
    expect(result[0]?.geometry.segments.length).toBe(1)
  })

  it('duplicates original geometry under normal quantity-copy ids', () => {
    const result = sourcePiecesForPreparedPieces(
      [preparedPiece('p-1-copy-2', 'p-1-copy-2')],
      [sourcePiece('p-1')]
    )

    expect(result.map((piece) => piece.id)).toEqual(['p-1-copy-2'])
    expect(result[0]?.geometry).toEqual(sourcePiece('p-1').geometry)
  })

  it('deduplicates repeated source ids', () => {
    const result = sourcePiecesForPreparedPieces(
      [preparedPiece('a', 'p-1'), preparedPiece('b', 'p-1')],
      [sourcePiece('p-1')]
    )

    expect(result.map((piece) => piece.id)).toEqual(['p-1'])
  })
})
