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
    workerMode: 'stub',
    historyMode: 'final',
    historyScope: 'winning_path',
    strategySelectionMode: 'single',
    strategyIds: ['balanced-preserve-free-then-bottom-left'],
    layoutSelectionStrategyId: 'compact-first',
    finalSelectionMode: 'manual'
  }
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
