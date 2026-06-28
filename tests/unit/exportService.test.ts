import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import {
  exportNestingRequestToFile,
  exportNestingResultToFile,
  exportHistoryToFile
} from '../../src/main/services/ExportService.js'
import type {
  NestingHistoryFrame,
  NestingRequest,
  NestingResult,
  PreparedPiece
} from '@shared/domain/nesting.js'
import type { JobId } from '@shared/domain/ids.js'

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
    workerMode: 'stub',
    historyMode: 'final',
    historyScope: 'winning_path',
    strategySelectionMode: 'single',
    strategyIds: ['balanced-preserve-free-then-bottom-left'],
    finalSelectionMode: 'manual'
  }
}

const sampleResult: NestingResult = {
  version: 1,
  jobId: 'job-1' as JobId,
  status: 'stub',
  strategyResults: [],
  sortedPieceIds: ['p-1' as PreparedPiece['id']],
  placements: [],
  unplacedPieceIds: ['p-1' as PreparedPiece['id']],
  warnings: [
    {
      code: 'algorithm_not_implemented',
      message: 'The nesting algorithm is intentionally not implemented yet.'
    }
  ],
  stats: { elapsedMs: 5, pieceCount: 1 }
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
  createdAt: '2025-01-01T00:00:00.000Z'
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
    expect(parsed.status).toBe('stub')
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
})
