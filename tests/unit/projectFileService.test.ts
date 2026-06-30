import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import {
  saveProjectFile,
  loadProjectFile,
  ProjectFileError
} from '../../src/main/services/ProjectFileService.js'

const VALID_PROJECT = {
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
        segments: []
      },
      warnings: []
    }
  ],
  sheet: { width: 100, height: 100, label: 'default' },
  padding: 2,
  options: {
    allowGlobalRotation: true,
    timeoutMs: 5000,
    workerMode: 'maxrects-beam-search',
    historyMode: 'final',
    historyScope: 'winning_path',
    strategySelectionMode: 'single',
    strategyIds: ['balanced-preserve-free-then-bottom-left'],
    layoutSelectionStrategyId: 'compact-first',
    finalSelectionMode: 'manual'
  }
}

const NESTING_OPTIONS_V2 = {
  allowGlobalRotation: true,
  timeoutMs: 30000,
  workerMode: 'maxrects-beam-search',
  historyMode: 'final',
  historyScope: 'winning_path',
  strategySelectionMode: 'single',
  strategyIds: ['balanced-preserve-free-then-bottom-left'],
  layoutSelectionStrategyId: 'compact-first',
  finalSelectionMode: 'manual'
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

const VALID_PROJECT_V2 = {
  ...VALID_PROJECT,
  version: 2,
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

describe('ProjectFileService', () => {
  let dir: string
  let path: string

  beforeEach(async () => {
    dir = join(tmpdir(), `min-plane-project-${randomUUID()}`)
    await mkdir(dir, { recursive: true })
    path = join(dir, 'project.json')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('round-trips a valid project document', async () => {
    await saveProjectFile(path, VALID_PROJECT as never)
    const loaded = await loadProjectFile(path)
    expect(loaded.version).toBe(1)
    expect(loaded.sheet.width).toBe(100)
    expect(loaded.options.strategyIds).toEqual(['balanced-preserve-free-then-bottom-left'])
  })

  it('writes pretty JSON', async () => {
    await saveProjectFile(path, VALID_PROJECT as never)
    const text = await readFile(path, 'utf8')
    expect(text).toContain('\n')
    expect(text).toMatch(/{\s+"version"/)
  })

  it('round-trips a valid version-2 project document with CSV imports and run records', async () => {
    await saveProjectFile(path, VALID_PROJECT_V2 as never)
    const loaded = await loadProjectFile(path)
    expect(loaded.version).toBe(2)
    expect(loaded.csvImports).toHaveLength(1)
    expect(loaded.csvImports?.[0]?.rows).toHaveLength(1)
    expect(loaded.csvImports?.[0]?.rows[0]?.reference).toBe('3282597_2')
    expect(loaded.csvRunRecords).toHaveLength(1)
    expect(loaded.csvRunRecords?.[0]?.subRuns).toHaveLength(1)
    expect(loaded.csvRunRecords?.[0]?.preparedPieces).toHaveLength(1)
    expect(loaded.csvRunRecords?.[0]?.preparedPieces?.[0]?.cutRowRef?.reference).toBe('3282597_2')
  })

  it('round-trips a legacy version-1 project document without CSV fields', async () => {
    await saveProjectFile(path, VALID_PROJECT as never)
    const loaded = await loadProjectFile(path)
    expect(loaded.version).toBe(1)
    expect(loaded.csvImports).toBeUndefined()
    expect(loaded.csvRunRecords).toBeUndefined()
  })

  it('rejects an invalid project on save', async () => {
    const invalid = { ...VALID_PROJECT, sheet: { width: -10, height: 100, label: 'x' } } as never
    await expect(saveProjectFile(path, invalid)).rejects.toBeInstanceOf(ProjectFileError)
  })

  it('rejects an unreadable file', async () => {
    const badPath = join(dir, 'missing', 'project.json')
    await expect(loadProjectFile(badPath)).rejects.toBeInstanceOf(ProjectFileError)
  })

  it('rejects malformed JSON', async () => {
    await writeFile(path, '{ this is not json', 'utf8')
    await expect(loadProjectFile(path)).rejects.toBeInstanceOf(ProjectFileError)
  })

  it('rejects JSON that does not satisfy the schema', async () => {
    await writeFile(path, JSON.stringify({ version: 1 }), 'utf8')
    await expect(loadProjectFile(path)).rejects.toBeInstanceOf(ProjectFileError)
  })
})
