import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { decode } from 'iconv-lite'
import type { Schema } from 'effect'
import { NestingHistoryFrame as NestingHistoryFrameSchema } from '@shared/domain/nesting.js'
import {
  buildCsvExportFileName,
  exportCsvResultToFile,
  exportNestingRequestToFile,
  exportNestingResultToFile,
  exportHistoryToFile,
  loadHistoryReplayFromFile,
  type EncodedNestingHistoryFramePayload
} from '../../src/main/services/ExportService.js'
import type {
  NestingHistoryFrame,
  NestingRequest,
  NestingResult,
  Placement,
  PreparedPiece,
  ProjectHistoryRef
} from '@shared/domain/nesting.js'
import type { FreeRectId, JobId, PieceId, SourceFileId } from '@shared/domain/ids.js'
import type { CsvRunRecord, ProjectCsvImport } from '@shared/domain/project.js'

const piece: PreparedPiece = {
  id: 'p-1' as PreparedPiece['id'],
  sourcePieceId: 'p-1' as PreparedPiece['id'],
  realBounds: { x: 0, y: 0, width: 10, height: 5 },
  paddedBounds: { x: 0, y: 0, width: 14, height: 9, longestEdge: 14, area: 126, imbalance: 5 },
  padding: 2,
  allowRotation: true
}

const sampleRequest: NestingRequest = {
  version: 1,
  jobId: 'job-1' as JobId,
  sheet: { width: 100, height: 100, label: 'default' },
  padding: 2,
  pieces: [piece],
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

const sampleResult: NestingResult = {
  version: 1,
  jobId: 'job-1' as JobId,
  status: 'partial',
  strategyResults: [],
  sortedPieceIds: ['p-1' as PreparedPiece['id']],
  placements: [],
  unplacedPieceIds: ['p-1' as PreparedPiece['id']],
  warnings: [],
  stats: {
    elapsedMs: 5,
    pieceCount: 1,
    algorithm: {
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-01T00:00:00.005Z',
      elapsedMs: 5
    }
  }
}

const sampleFrame: NestingHistoryFrame = {
  frameId: 'f-1',
  jobId: 'job-1' as JobId,
  strategyRunId: 'run-1',
  strategyLabel: 'Balanced / preserve free space first',
  stepIndex: 0,
  beamRank: 0,
  title: 'frame 0',
  plate: { placements: [], freeRectangles: [] },
  state: { remainingPieceIds: [], unplacedPieceIds: [] },
  createdAt: '2025-01-01T00:00:00.000Z'
}

type EncodedRectangularHistoryFrame = Schema.Codec.Encoded<typeof NestingHistoryFrameSchema>

function isEncodedRectangularHistoryFrame(
  frame: EncodedNestingHistoryFramePayload
): frame is EncodedRectangularHistoryFrame {
  return !('kind' in frame && frame.kind === 'irregular')
}

const defaultOptions: NestingRequest['options'] = {
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

function pid(value: string): PieceId {
  return value as PieceId
}

function sfid(value: string): SourceFileId {
  return value as SourceFileId
}

function makeCsvImport(overrides?: Partial<ProjectCsvImport>): ProjectCsvImport {
  return {
    id: sfid('csv-import-1'),
    sourcePath: '/tmp/input.csv',
    fileName: 'input.csv',
    materialCode: '8669',
    materialDescription: 'ACRYL 5MM GEGOSSEN SATIN',
    thicknessMm: 5,
    jobDate: '20260630',
    rows: [],
    runConfiguration: {
      runId: 'csv-import-1',
      label: 'ACRYL 5MM GEGOSSEN SATIN',
      defaultSheet: { width: 1500, height: 1500, label: 'mother plate 1500x1500' },
      padding: 10,
      options: defaultOptions
    },
    ...overrides
  }
}

function makePreparedPiece(
  id: string,
  sourcePieceId: string,
  cutRowRef: PreparedPiece['cutRowRef']
): PreparedPiece {
  return {
    id: pid(id),
    sourcePieceId: pid(sourcePieceId),
    realBounds: { x: 0, y: 0, width: 10, height: 5 },
    paddedBounds: { x: 0, y: 0, width: 14, height: 9, longestEdge: 14, area: 126, imbalance: 5 },
    padding: 2,
    allowRotation: true,
    cutRowRef
  }
}

function makePlacement(pieceId: string): Placement {
  return { pieceId: pid(pieceId), x: 0, y: 0, width: 10, height: 5, rotation: 0 }
}

function makeCsvRunRecord(overrides?: Partial<CsvRunRecord>): CsvRunRecord {
  return {
    csvImportId: 'csv-import-1',
    runId: 'run-1',
    label: 'Run 1',
    subRuns: [],
    unplacedPieceIds: [],
    preparedPieces: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  }
}

describe('ExportService', () => {
  let dir: string

  beforeEach(async () => {
    dir = join(tmpdir(), `min-plane-export-${randomUUID()}`)
    await mkdir(dir, { recursive: true })
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('writes a NestingRequest as pretty JSON', async () => {
    const file = join(dir, 'request.json')
    const out = await exportNestingRequestToFile(file, sampleRequest)
    expect(out).toBe(file)
    const text = await readFile(file, 'utf8')
    const parsed = JSON.parse(text)
    expect(parsed.version).toBe(1)
    expect(parsed.jobId).toBe('job-1')
  })

  it('writes a NestingResult as pretty JSON', async () => {
    const file = join(dir, 'result.json')
    const out = await exportNestingResultToFile(file, sampleResult)
    expect(out).toBe(file)
    const text = await readFile(file, 'utf8')
    const parsed = JSON.parse(text)
    expect(parsed.status).toBe('partial')
  })

  it('writes history frames as one NDJSON line per frame', async () => {
    const file = join(dir, 'history.ndjson')
    const out = await exportHistoryToFile(file, [sampleFrame])
    expect(out).toBe(file)
    const text = await readFile(file, 'utf8')
    const lines = text.split('\n').filter((l) => l.length > 0)
    expect(lines.length).toBe(1)
    const parsed = JSON.parse(lines[0]!)
    expect(parsed.frameId).toBe('f-1')
  })

  it('writes an empty NDJSON file when there are no frames', async () => {
    const file = join(dir, 'empty.ndjson')
    await exportHistoryToFile(file, [])
    const text = await readFile(file, 'utf8')
    expect(text).toBe('')
  })

  it('loads replay frames as schema-encoded IPC-cloneable objects', async () => {
    const file = join(dir, 'history.ndjson')
    const frameWithNestedTrace: NestingHistoryFrame = {
      ...sampleFrame,
      plate: {
        placements: [
          { pieceId: 'p-1' as PreparedPiece['id'], x: 0, y: 0, width: 10, height: 5, rotation: 0 }
        ],
        freeRectangles: [{ id: 'free-1' as FreeRectId, x: 10, y: 0, width: 90, height: 100 }]
      },
      beam: {
        strategyRunId: 'run-1',
        strategyLabel: 'Balanced / preserve free space first',
        stepIndex: 1,
        insertedPieceId: 'p-1' as PreparedPiece['id'],
        beamRank: 0,
        beamWidth: 16,
        candidateCount: 4,
        selectedCandidateId: 'candidate-1',
        selectedCandidateOrderId: 'order-1'
      }
    }
    await writeFile(file, `${JSON.stringify(frameWithNestedTrace)}\n`, 'utf8')
    const ref: ProjectHistoryRef = {
      kind: 'ndjson_replay',
      jobId: 'job-1' as JobId,
      path: file,
      frameCount: 1,
      createdAt: '2025-01-01T00:00:00.000Z'
    }

    const frames = await loadHistoryReplayFromFile(ref)
    expect(frames.length).toBe(1)
    const frame = frames[0]
    if (!frame) throw new Error('expected replay frame')
    if (!isEncodedRectangularHistoryFrame(frame)) {
      throw new Error('expected a rectangular replay frame')
    }

    expect(frame.frameId).toBe('f-1')
    expect(frame.beam?.selectedCandidateOrderId).toBe('order-1')
    expect(Object.getPrototypeOf(frame)).toBe(Object.prototype)
    expect(Object.getPrototypeOf(frame.plate)).toBe(Object.prototype)
    expect(Object.getPrototypeOf(frame.plate.placements[0])).toBe(Object.prototype)
    expect(Object.getPrototypeOf(frame.beam)).toBe(Object.prototype)
    expect(() => structuredClone(frames)).not.toThrow()
  })

  it('builds a CSV export file name from job date and material description', () => {
    expect(buildCsvExportFileName('20260630', 'ACRYL 5MM GEGOSSEN SATIN')).toBe(
      '20260630_ACRYL_5MM_GEGOSSEN_SATIN.csv'
    )
    expect(buildCsvExportFileName(undefined, 'Some Material')).toBe('Some_Material.csv')
    expect(buildCsvExportFileName('20260630', 'ACRYL <5MM>')).toBe('20260630_ACRYL_5MM.csv')
  })

  it('writes a CSV result as a Windows-1252 buffer with CRLF line endings', async () => {
    const csvImport = makeCsvImport({ materialCode: '8669', materialDescription: 'ACRYL 5MM' })
    const runRecord = makeCsvRunRecord({
      subRuns: [
        {
          subRunId: 'sub-0',
          parentRunId: 'run-1',
          index: 0,
          sheet: { width: 1500, height: 1500, label: 'mother plate' },
          padding: 10,
          options: defaultOptions,
          placements: [makePlacement('p-1'), makePlacement('p-2')],
          unplacedPieceIds: [],
          pieceIds: [pid('p-1'), pid('p-2')],
          requestPieceIds: [pid('p-1'), pid('p-2')]
        }
      ],
      preparedPieces: [
        makePreparedPiece('p-1', 'p-1', {
          reference: '3282597_2',
          customerName: 'Customer A',
          csvRowId: 'row-1'
        }),
        makePreparedPiece('p-2', 'p-2', {
          reference: '3282597_3',
          customerName: 'Customer B',
          csvRowId: 'row-2'
        })
      ]
    })

    const file = join(dir, 'export.csv')
    const out = await exportCsvResultToFile(file, csvImport, runRecord)
    expect(out).toBe(file)

    const buffer = await readFile(file)
    const text = decode(buffer, 'win1252')
    expect(text).toContain('MATERIAL;8669;\r\n')
    expect(text).toContain('PLATTENMASS;1500;1500\r\n')
    expect(text).toContain('AUFTRAG;3282597;2;Customer A;1\r\n')
    expect(text).toContain('AUFTRAG;3282597;3;Customer B;1\r\n')
    expect(text.endsWith('\r\n')).toBe(true)
  })

  it('aggregates AUFTRAG amounts by pieceId and then by reference/customerName', async () => {
    const csvImport = makeCsvImport()
    const runRecord = makeCsvRunRecord({
      subRuns: [
        {
          subRunId: 'sub-0',
          parentRunId: 'run-1',
          index: 0,
          sheet: { width: 1000, height: 1000, label: 'mother plate' },
          padding: 10,
          options: defaultOptions,
          placements: [
            makePlacement('p-1'),
            makePlacement('p-1'),
            makePlacement('p-1'),
            makePlacement('p-2')
          ],
          unplacedPieceIds: [],
          pieceIds: [pid('p-1'), pid('p-2')],
          requestPieceIds: [pid('p-1'), pid('p-2')]
        }
      ],
      preparedPieces: [
        makePreparedPiece('p-1', 'p-1', {
          reference: '1000_1',
          customerName: 'Customer A',
          csvRowId: 'row-1'
        }),
        makePreparedPiece('p-2', 'p-2', {
          reference: '1000_2',
          customerName: 'Customer B',
          csvRowId: 'row-2'
        })
      ]
    })

    const file = join(dir, 'aggregated.csv')
    await exportCsvResultToFile(file, csvImport, runRecord)
    const text = decode(await readFile(file), 'win1252')
    const lines = text.split('\r\n').filter((line) => line.startsWith('AUFTRAG'))
    expect(lines).toEqual(['AUFTRAG;1000;1;Customer A;3', 'AUFTRAG;1000;2;Customer B;1'])
  })

  it('splits references on the last underscore and leaves position empty when absent', async () => {
    const csvImport = makeCsvImport()
    const runRecord = makeCsvRunRecord({
      subRuns: [
        {
          subRunId: 'sub-0',
          parentRunId: 'run-1',
          index: 0,
          sheet: { width: 1000, height: 1000, label: 'mother plate' },
          padding: 10,
          options: defaultOptions,
          placements: [makePlacement('p-1'), makePlacement('p-2')],
          unplacedPieceIds: [],
          pieceIds: [pid('p-1'), pid('p-2')],
          requestPieceIds: [pid('p-1'), pid('p-2')]
        }
      ],
      preparedPieces: [
        makePreparedPiece('p-1', 'p-1', {
          reference: '123_456_7',
          customerName: 'A',
          csvRowId: 'row-1'
        }),
        makePreparedPiece('p-2', 'p-2', {
          reference: 'nounderscore',
          customerName: 'B',
          csvRowId: 'row-2'
        })
      ]
    })

    const file = join(dir, 'split.csv')
    await exportCsvResultToFile(file, csvImport, runRecord)
    const text = decode(await readFile(file), 'win1252')
    expect(text).toContain('AUFTRAG;123_456;7;A;1\r\n')
    expect(text).toContain('AUFTRAG;nounderscore;;B;1\r\n')
  })

  it('skips unplaced pieces and emits no AUFTRAG line for them', async () => {
    const csvImport = makeCsvImport()
    const runRecord = makeCsvRunRecord({
      subRuns: [
        {
          subRunId: 'sub-0',
          parentRunId: 'run-1',
          index: 0,
          sheet: { width: 1000, height: 1000, label: 'mother plate' },
          padding: 10,
          options: defaultOptions,
          placements: [makePlacement('p-1')],
          unplacedPieceIds: [pid('p-2')],
          pieceIds: [pid('p-1'), pid('p-2')],
          requestPieceIds: [pid('p-1'), pid('p-2')]
        }
      ],
      preparedPieces: [
        makePreparedPiece('p-1', 'p-1', {
          reference: '1000_1',
          customerName: 'Customer A',
          csvRowId: 'row-1'
        }),
        makePreparedPiece('p-2', 'p-2', {
          reference: '1000_2',
          customerName: 'Customer B',
          csvRowId: 'row-2'
        })
      ],
      unplacedPieceIds: [pid('p-2')]
    })

    const file = join(dir, 'unplaced.csv')
    await exportCsvResultToFile(file, csvImport, runRecord)
    const text = decode(await readFile(file), 'win1252')
    expect(text).toContain('AUFTRAG;1000;1;Customer A;1\r\n')
    expect(text).not.toContain('AUFTRAG;1000;2')
  })

  it('sanitizes customer names and references by stripping semicolons and line breaks', async () => {
    const csvImport = makeCsvImport()
    const runRecord = makeCsvRunRecord({
      subRuns: [
        {
          subRunId: 'sub-0',
          parentRunId: 'run-1',
          index: 0,
          sheet: { width: 1000, height: 1000, label: 'mother plate' },
          padding: 10,
          options: defaultOptions,
          placements: [makePlacement('p-1'), makePlacement('p-2')],
          unplacedPieceIds: [],
          pieceIds: [pid('p-1'), pid('p-2')],
          requestPieceIds: [pid('p-1'), pid('p-2')]
        }
      ],
      preparedPieces: [
        makePreparedPiece('p-1', 'p-1', {
          reference: 'bad\r\n_ref_X',
          customerName: 'Bad;Name\r\nLine',
          csvRowId: 'row-1'
        }),
        makePreparedPiece('p-2', 'p-2', {
          reference: '  clean_ref_2  ',
          customerName: '  Clean Name  ',
          csvRowId: 'row-2'
        })
      ]
    })

    const file = join(dir, 'sanitized.csv')
    await exportCsvResultToFile(file, csvImport, runRecord)
    const text = decode(await readFile(file), 'win1252')
    expect(text).toContain('AUFTRAG;bad_ref;X;BadNameLine;1\r\n')
    expect(text).toContain('AUFTRAG;clean_ref;2;Clean Name;1\r\n')
  })

  it('throws when the CSV run record has no subruns', async () => {
    const csvImport = makeCsvImport()
    const runRecord = makeCsvRunRecord()
    const file = join(dir, 'empty.csv')
    await expect(exportCsvResultToFile(file, csvImport, runRecord)).rejects.toThrow(
      'CSV run record has no subruns; nothing to export.'
    )
  })
})
