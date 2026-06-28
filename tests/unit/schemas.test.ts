import { describe, expect, it } from 'vitest'
import { Exit, Schema } from 'effect'
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
    workerMode: 'stub' as const,
    historyMode: 'final' as const,
    historyScope: 'winning_path' as const,
    strategySelectionMode: 'single' as const,
    strategyIds: ['balanced-preserve-free-then-bottom-left'],
    finalSelectionMode: 'manual' as const
  }
}

const validate = (schema: Schema.Top, input: unknown) =>
  Schema.decodeUnknownExit(schema as never)(input)

describe('ProjectDocumentStrict', () => {
  it('accepts a valid project document', () => {
    const result = validate(ProjectDocumentStrict, validProject)
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
      paddedBounds: { x: 0, y: 0, width: 14, height: 9 },
      padding: 2,
      allowRotation: true
    }
  ],
  options: {
    allowGlobalRotation: true,
    timeoutMs: 5000,
    workerMode: 'stub' as const,
    historyMode: 'final' as const,
    historyScope: 'winning_path' as const,
    strategySelectionMode: 'single' as const,
    strategyIds: ['balanced-preserve-free-then-bottom-left'],
    finalSelectionMode: 'manual' as const
  }
}

describe('NestingRequestStrict', () => {
  it('accepts a valid nesting request', () => {
    const result = validate(NestingRequestStrict, validRequest)
    expect(Exit.isSuccess(result)).toBe(true)
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

  it('rejects a request with non-positive timeout', () => {
    const invalid = {
      ...validRequest,
      options: { ...validRequest.options, timeoutMs: 0 }
    }
    const result = validate(NestingRequestStrict, invalid)
    expect(Exit.isFailure(result)).toBe(true)
  })
})
