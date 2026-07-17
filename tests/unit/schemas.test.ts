import { describe, expect, it } from 'vitest'
import { Exit, Schema } from 'effect'
import { NestingRequest } from '@shared/domain/nesting.js'
import { IrregularGeometrySettings } from '@shared/irregular/domain.js'
import { ProjectDocumentStrict } from '@shared/schemas/projectSchemas.js'
import { NestingRequestStrict } from '@shared/schemas/nestingSchemas.js'

const validProject = {
  version: 1,
  savedAt: '2025-01-01T00:00:00.000Z',
  sourceFiles: [{ id: 'sf-1', path: '/tmp/a.dxf', fileName: 'a.dxf', available: true }],
  importedPieces: [
    {
      id: 'p-1',
      sourceFileId: 'sf-1',
      label: 'piece-1',
      realBounds: { x: 0, y: 0, width: 10, height: 5 },
      geometry: {
        entityType: 'LWPOLYLINE',
        closed: true,
        segments: [
          { kind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 },
          { kind: 'line', x1: 10, y1: 0, x2: 10, y2: 5 },
          { kind: 'line', x1: 10, y1: 5, x2: 0, y2: 5 },
          { kind: 'line', x1: 0, y1: 5, x2: 0, y2: 0 }
        ]
      },
      warnings: []
    }
  ],
  sheet: { width: 100, height: 100, label: 'default' },
  padding: 2,
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

const NESTING_OPTIONS_V2 = {
  allowGlobalRotation: true,
  timeoutMs: 30000,
  workerMode: 'maxrects-beam-search' as const,
  historyMode: 'final' as const,
  historyScope: 'winning_path' as const,
  strategySelectionMode: 'single' as const,
  strategyIds: ['balanced-preserve-free-then-bottom-left'],
  layoutSelectionStrategyId: 'compact-first',
  finalSelectionMode: 'manual' as const
}

const PREPARED_PIECE_V2 = {
  id: 'copy-0-of-p-1-for-row-1',
  sourcePieceId: 'p-1',
  realBounds: { x: 0, y: 0, width: 10, height: 5 },
  paddedBounds: { x: 0, y: 0, width: 14, height: 9, longestEdge: 14, area: 126, imbalance: 5 },
  padding: 2,
  allowRotation: true,
  cutRowRef: {
    reference: '3282597_2',
    customerName: 'Customer A',
    csvRowId: 'row-1'
  }
}

const validProjectV2 = {
  ...validProject,
  version: 2 as const,
  csvImports: [
    {
      id: 'csv-1',
      sourcePath: '/workspace/jobs/sample.csv',
      fileName: 'sample.csv',
      materialCode: '8669',
      materialDescription: 'ACRYL 5MM GEGOSSEN SATIN',
      thicknessMm: 5,
      jobDate: '20260630',
      rows: [
        {
          id: 'row-1',
          reference: '3282597_2',
          customerName: 'Customer A',
          amount: 3,
          linkedPieceId: 'p-1'
        }
      ],
      runConfiguration: {
        runId: 'csv-1',
        label: 'ACRYL 5MM GEGOSSEN SATIN',
        defaultSheet: { width: 1500, height: 1500, label: 'mother plate 1500x1500' },
        padding: 10,
        options: NESTING_OPTIONS_V2
      }
    }
  ],
  csvRunRecords: [
    {
      csvImportId: 'csv-1',
      runId: 'csv-1',
      label: 'ACRYL 5MM GEGOSSEN SATIN',
      subRuns: [
        {
          subRunId: 'csv-1-subrun-0',
          parentRunId: 'csv-1',
          index: 0,
          sheet: { width: 1500, height: 1500, label: 'mother plate 1500x1500' },
          padding: 10,
          options: NESTING_OPTIONS_V2,
          placements: [
            { pieceId: 'copy-0-of-p-1-for-row-1', x: 0, y: 0, width: 14, height: 9, rotation: 0 }
          ],
          unplacedPieceIds: [],
          pieceIds: ['copy-0-of-p-1-for-row-1'],
          requestPieceIds: ['copy-0-of-p-1-for-row-1']
        }
      ],
      unplacedPieceIds: [],
      preparedPieces: [PREPARED_PIECE_V2],
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z'
    }
  ]
}

const validate = (schema: Schema.Top, input: unknown) =>
  Schema.decodeUnknownExit(schema as never)(input)

describe('ProjectDocumentStrict', () => {
  it('accepts a valid project document', () => {
    const result = validate(ProjectDocumentStrict, validProject)
    expect(Exit.isSuccess(result)).toBe(true)
  })

  it('accepts a version-2 project document with CSV imports and run records', () => {
    const result = validate(ProjectDocumentStrict, validProjectV2)
    expect(Exit.isSuccess(result)).toBe(true)
  })

  it('accepts irregular worker mode in saved project options', () => {
    const result = validate(ProjectDocumentStrict, {
      ...validProject,
      options: {
        ...validProject.options,
        workerMode: 'irregular-convex-v2'
      }
    })
    expect(Exit.isSuccess(result)).toBe(true)
  })

  it('accepts an irregular project without MaxRects candidate strategies', () => {
    const result = validate(ProjectDocumentStrict, {
      ...validProject,
      options: {
        ...validProject.options,
        workerMode: 'irregular-convex-v2',
        strategyIds: []
      }
    })
    expect(Exit.isSuccess(result)).toBe(true)
  })

  it('decodes a version-1 project document', () => {
    const result = validate(ProjectDocumentStrict, { ...validProject, version: 1 as const })
    expect(Exit.isSuccess(result)).toBe(true)
  })

  it('rejects a project with negative sheet width', () => {
    const invalid = { ...validProject, sheet: { ...validProject.sheet, width: -10 } }
    const result = validate(ProjectDocumentStrict, invalid)
    expect(Exit.isFailure(result)).toBe(true)
  })

  it('rejects a project with negative padding', () => {
    const invalid = { ...validProject, padding: -1 }
    const result = validate(ProjectDocumentStrict, invalid)
    expect(Exit.isFailure(result)).toBe(true)
  })

  it('rejects a project with a non-positive piece width', () => {
    const basePiece = validProject.importedPieces[0]!
    const invalid = {
      ...validProject,
      importedPieces: [
        {
          ...basePiece,
          realBounds: { x: 0, y: 0, width: 0, height: 5 }
        }
      ]
    }
    const result = validate(ProjectDocumentStrict, invalid)
    expect(Exit.isFailure(result)).toBe(true)
  })

  it('rejects a project with fractional nesting bounds', () => {
    const basePiece = validProject.importedPieces[0]!
    const invalid = {
      ...validProject,
      importedPieces: [
        {
          ...basePiece,
          realBounds: { x: 0.5, y: 0, width: 10, height: 5 }
        }
      ]
    }
    const result = validate(ProjectDocumentStrict, invalid)
    expect(Exit.isFailure(result)).toBe(true)
  })
})

const validRequest = {
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

function projectWithSavedRequest(request: typeof validRequest) {
  return {
    ...validProject,
    runRecords: [
      {
        jobId: 'job-1',
        createdAt: '2026-07-17T00:00:00.000Z',
        label: 'saved run',
        pieceCount: 1,
        sheet: validProject.sheet,
        result: {
          version: 1,
          jobId: 'job-1',
          status: 'ok',
          strategyResults: [],
          sortedPieceIds: ['p-1'],
          placements: [],
          unplacedPieceIds: [],
          warnings: [],
          stats: {
            elapsedMs: 1,
            pieceCount: 1,
            algorithm: {
              startedAt: '2026-07-17T00:00:00.000Z',
              endedAt: '2026-07-17T00:00:00.001Z',
              elapsedMs: 1
            }
          }
        },
        history: null,
        request
      }
    ]
  }
}

describe('saved run request snapshots', () => {
  it('accepts a strict request snapshot in a project run record', () => {
    expect(Exit.isSuccess(validate(ProjectDocumentStrict, projectWithSavedRequest(validRequest)))).toBe(
      true
    )
  })

  it('rejects an invalid request snapshot at the project boundary', () => {
    const invalidRequest = { ...validRequest, pieces: [] }
    expect(
      Exit.isFailure(validate(ProjectDocumentStrict, projectWithSavedRequest(invalidRequest)))
    ).toBe(true)
  })
})

describe('NestingRequestStrict', () => {
  it('accepts a valid nesting request', () => {
    const result = validate(NestingRequestStrict, validRequest)
    expect(Exit.isSuccess(result)).toBe(true)
  })

  it('preserves padded-bound metadata for the domain request decode', () => {
    const boundaryRequest = Schema.decodeUnknownSync(NestingRequestStrict)(validRequest)
    const request = Schema.decodeUnknownSync(NestingRequest)(boundaryRequest)

    expect(request.pieces[0]?.paddedBounds).toMatchObject({
      longestEdge: 14,
      area: 126,
      imbalance: 5
    })
  })

  it('accepts irregular worker requests with source geometry', () => {
    const result = validate(NestingRequestStrict, {
      ...validRequest,
      sourcePieces: validProject.importedPieces,
      options: {
        ...validRequest.options,
        workerMode: 'irregular-convex-v2'
      }
    })
    expect(Exit.isSuccess(result)).toBe(true)
  })

  it('accepts an irregular request without MaxRects candidate strategies', () => {
    const result = validate(NestingRequestStrict, {
      ...validRequest,
      sourcePieces: validProject.importedPieces,
      options: {
        ...validRequest.options,
        workerMode: 'irregular-convex-v2',
        strategyIds: []
      }
    })
    expect(Exit.isSuccess(result)).toBe(true)
  })

  it('rejects a MaxRects request without a candidate strategy', () => {
    const result = validate(NestingRequestStrict, {
      ...validRequest,
      options: { ...validRequest.options, strategyIds: [] }
    })
    expect(Exit.isFailure(result)).toBe(true)
  })

  it('rejects a request with zero sheet height', () => {
    const invalid = { ...validRequest, sheet: { ...validRequest.sheet, height: 0 } }
    const result = validate(NestingRequestStrict, invalid)
    expect(Exit.isFailure(result)).toBe(true)
  })

  it('rejects a request with empty pieces array', () => {
    const invalid = { ...validRequest, pieces: [] }
    const result = validate(NestingRequestStrict, invalid)
    expect(Exit.isFailure(result)).toBe(true)
  })

  it('rejects a request with duplicate piece ids', () => {
    const basePiece = validRequest.pieces[0]!
    const invalid = {
      ...validRequest,
      pieces: [
        basePiece,
        {
          ...basePiece,
          sourcePieceId: 'p-2'
        }
      ]
    }
    const result = validate(NestingRequestStrict, invalid)
    expect(Exit.isFailure(result)).toBe(true)
  })

  it('rejects a request with non-positive timeout', () => {
    const invalid = {
      ...validRequest,
      options: { ...validRequest.options, timeoutMs: 0 }
    }
    const result = validate(NestingRequestStrict, invalid)
    expect(Exit.isFailure(result)).toBe(true)
  })

  it('rejects a request with fractional piece bounds before it reaches the worker', () => {
    const basePiece = validRequest.pieces[0]!
    const invalid = {
      ...validRequest,
      pieces: [
        {
          ...basePiece,
          realBounds: { x: 0, y: 0, width: 10.5, height: 5 }
        }
      ]
    }
    const result = validate(NestingRequestStrict, invalid)
    expect(Exit.isFailure(result)).toBe(true)
  })
})

describe('IrregularGeometrySettings', () => {
  it('requires finite non-negative millimeter settings', () => {
    const valid = {
      flatteningSagToleranceMm: 0.25,
      clearanceSafetyMarginMm: 0.25,
      geometryBackendId: 'test-backend',
      geometryBackendVersion: '1'
    }

    expect(Exit.isSuccess(validate(IrregularGeometrySettings, valid))).toBe(true)
    expect(
      Exit.isFailure(
        validate(IrregularGeometrySettings, { ...valid, clearanceSafetyMarginMm: -0.01 })
      )
    ).toBe(true)
    expect(
      Exit.isFailure(
        validate(IrregularGeometrySettings, {
          ...valid,
          flatteningSagToleranceMm: Number.POSITIVE_INFINITY
        })
      )
    ).toBe(true)
  })
})
