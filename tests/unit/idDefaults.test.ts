import { describe, expect, it } from 'vitest'
import { Schema } from 'effect'
import { ImportedDxfDocument, ImportedPiece, DxfGeometrySummary } from '@shared/domain/dxf.js'
import {
  FreeRectangle,
  NestingOptions,
  NestingRequest,
  PreparedPiece
} from '@shared/domain/nesting.js'
import { Rect, RectWith } from '@shared/domain/geometry.js'
import { FreeRectId, JobId, PieceId, SourceFileId } from '@shared/domain/ids.js'

function options(): NestingOptions {
  return new NestingOptions({
    allowGlobalRotation: true,
    timeoutMs: 5000,
    workerMode: 'maxrects-beam-search',
    historyMode: 'final',
    historyScope: 'winning_path',
    strategySelectionMode: 'single',
    strategyIds: [],
    layoutSelectionStrategyId: 'compact-first',
    finalSelectionMode: 'manual'
  })
}

function bounds(): Rect {
  return new Rect({ x: 0, y: 0, width: 10, height: 5 })
}

function paddedBounds(): RectWith {
  return new RectWith({
    x: 0,
    y: 0,
    width: 14,
    height: 9,
    longestEdge: 14,
    area: 126,
    imbalance: 5
  })
}

function geometry(): DxfGeometrySummary {
  return new DxfGeometrySummary({
    entityType: 'LWPOLYLINE',
    closed: true,
    segments: []
  })
}

describe('generated id schemas', () => {
  it('exposes make helpers for every branded id', () => {
    expect(PieceId.make()).toEqual(expect.any(String))
    expect(SourceFileId.make()).toEqual(expect.any(String))
    expect(JobId.make()).toEqual(expect.any(String))
    expect(FreeRectId.make()).toEqual(expect.any(String))
    expect(JobId.make('job-1')).toBe('job-1')
  })

  it('defaults primary entity ids at construction time', () => {
    const sourceFileId = SourceFileId.make()
    const piece = new ImportedPiece({
      sourceFileId,
      label: 'piece',
      realBounds: bounds(),
      geometry: geometry(),
      warnings: []
    })
    const prepared = new PreparedPiece({
      sourcePieceId: piece.id,
      realBounds: bounds(),
      paddedBounds: paddedBounds(),
      padding: 2,
      allowRotation: true
    })
    const document = new ImportedDxfDocument({
      path: '/tmp/a.dxf',
      fileName: 'a.dxf',
      millimetersPerUnit: 1,
      pieces: [piece],
      warnings: []
    })
    const request = new NestingRequest({
      version: 1,
      sheet: { width: 100, height: 100, label: 'default' },
      padding: 2,
      pieces: [prepared],
      options: options()
    })
    const freeRectangle = new FreeRectangle({
      x: 0,
      y: 0,
      width: 100,
      height: 100
    })

    expect(piece.id).toEqual(expect.any(String))
    expect(prepared.id).toEqual(expect.any(String))
    expect(document.id).toEqual(expect.any(String))
    expect(request.jobId).toEqual(expect.any(String))
    expect(freeRectangle.id).toEqual(expect.any(String))
  })

  it('does not apply id defaults while decoding boundary payloads', () => {
    expect(() =>
      Schema.decodeUnknownSync(ImportedPiece)({
        sourceFileId: SourceFileId.make(),
        label: 'piece',
        realBounds: bounds(),
        geometry: geometry(),
        warnings: []
      })
    ).toThrow()
  })
})
