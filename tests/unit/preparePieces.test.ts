import { describe, expect, it } from 'vitest'
import { preparePieces } from '@shared/preparePieces.js'
import type { ImportedPiece } from '@shared/domain/dxf.js'
import type { JobId } from '@shared/domain/ids.js'

function piece(id: string, width: number, height: number): ImportedPiece {
  return {
    id: id as ImportedPiece['id'],
    sourceFileId: 'sf-1' as ImportedPiece['sourceFileId'],
    label: id,
    realBounds: { x: 0, y: 0, width, height },
    geometry: {
      entityType: 'LWPOLYLINE',
      closed: true,
      segments: []
    },
    warnings: []
  }
}

const sheet = { width: 100, height: 100, label: 'default' }
const jobId = 'job-1' as JobId

describe('preparePieces', () => {
  it('produces paddedBounds = real + 2*padding for each piece', () => {
    const result = preparePieces([piece('p-1', 10, 5)], sheet, 2, jobId)
    expect(result.pieces[0]?.paddedBounds).toEqual({ width: 14, height: 9 })
    expect(result.warnings.length).toBe(0)
  })

  it('marks allowRotation=true and warns when only the rotated orientation fits', () => {
    // tall narrow sheet: piece 30x20 + padding 2 = 34x24. Fits only rotated.
    const tallSheet = { width: 30, height: 100, label: 'tall' }
    const wide = piece('p-1', 30, 20)
    const result = preparePieces([wide], tallSheet, 2, jobId)
    expect(result.pieces[0]?.allowRotation).toBe(true)
    const warnings = result.warnings.filter((w) => w.code === 'piece_requires_rotation')
    expect(warnings.length).toBe(1)
  })

  it('emits piece_does_not_fit when no orientation fits the sheet', () => {
    // piece 80x80 padded = 84x84. Fits. Now make it bigger.
    const result = preparePieces([piece('p-1', 95, 95)], sheet, 5, jobId)
    expect(result.warnings.some((w) => w.code === 'piece_does_not_fit')).toBe(true)
    expect(result.pieces[0]?.allowRotation).toBe(false)
  })

  it('handles zero padding', () => {
    const result = preparePieces([piece('p-1', 10, 5)], sheet, 0, jobId)
    expect(result.pieces[0]?.paddedBounds).toEqual({ width: 10, height: 5 })
  })

  it('produces no warnings when every piece fits comfortably', () => {
    const result = preparePieces(
      [piece('p-1', 10, 10), piece('p-2', 20, 15)],
      sheet,
      2,
      jobId
    )
    expect(result.warnings.length).toBe(0)
  })
})