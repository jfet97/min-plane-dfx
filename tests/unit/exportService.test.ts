import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import {
  exportNestingRequestToFile,
  exportNestingResultToFile,
  exportHistoryToFile,
  loadHistoryReplayFromFile
} from '../../src/main/services/ExportService.js'
import type {
  NestingHistoryFrame,
  NestingRequest,
  NestingResult,
  ProjectHistoryRef,
  PreparedPiece
} from '@shared/domain/nesting.js'
import type { FreeRectId, JobId } from '@shared/domain/ids.js'

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

    expect(frame.frameId).toBe('f-1')
    expect(frame.beam?.selectedCandidateOrderId).toBe('order-1')
    expect(Object.getPrototypeOf(frame)).toBe(Object.prototype)
    expect(Object.getPrototypeOf(frame.plate)).toBe(Object.prototype)
    expect(Object.getPrototypeOf(frame.plate.placements[0])).toBe(Object.prototype)
    expect(Object.getPrototypeOf(frame.beam)).toBe(Object.prototype)
    expect(() => structuredClone(frames)).not.toThrow()
  })
})
