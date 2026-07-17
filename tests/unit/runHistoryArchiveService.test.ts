import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deleteRunHistoryFiles } from '../../src/main/services/RunHistoryArchiveService.js'
import type { JobId } from '@shared/domain/ids.js'

const temporaryDirectories: string[] = []

async function temporaryHistoryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'min-plane-run-history-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true }))
  )
})

describe('RunHistoryArchiveService', () => {
  it('deletes both managed files for one run and leaves unrelated files untouched', async () => {
    const directory = await temporaryHistoryDirectory()
    await writeFile(join(directory, 'job-1.ndjson'), 'replay')
    await writeFile(join(directory, 'job-1.decision-trace.ndjson'), 'trace')
    await writeFile(join(directory, 'unrelated.ndjson'), 'keep')

    await deleteRunHistoryFiles(directory, ['job-1' as JobId])

    await expect(readFile(join(directory, 'job-1.ndjson'))).rejects.toThrow()
    await expect(readFile(join(directory, 'job-1.decision-trace.ndjson'))).rejects.toThrow()
    await expect(readFile(join(directory, 'unrelated.ndjson'), 'utf8')).resolves.toBe('keep')
  })

  it('treats already-missing managed files as a successful deletion', async () => {
    const directory = await temporaryHistoryDirectory()

    await expect(
      deleteRunHistoryFiles(directory, ['missing-job' as JobId])
    ).resolves.toBeUndefined()
  })

  it('validates every job id before deleting any file', async () => {
    const directory = await temporaryHistoryDirectory()
    await writeFile(join(directory, 'job-1.ndjson'), 'replay')

    await expect(
      deleteRunHistoryFiles(directory, ['job-1' as JobId, '../outside' as JobId])
    ).rejects.toThrow('Invalid saved-run job id')
    await expect(readFile(join(directory, 'job-1.ndjson'), 'utf8')).resolves.toBe('replay')
  })
})
