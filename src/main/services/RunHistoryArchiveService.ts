import { Effect, FileSystem, Path } from 'effect'
import type { JobId } from '@shared/domain/ids.js'
import { appRuntime } from '../runtime/effectRuntime.js'

const SAFE_JOB_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

export class RunHistoryArchiveError extends Error {}

function ownedHistoryPaths(
  historyDirectory: string,
  jobIds: ReadonlyArray<JobId>,
  path: Path.Path
): ReadonlyArray<string> {
  const root = path.resolve(historyDirectory)
  const uniqueJobIds = [...new Set(jobIds)]
  const paths: string[] = []

  for (const jobId of uniqueJobIds) {
    if (!SAFE_JOB_ID.test(jobId) || path.basename(jobId) !== jobId) {
      throw new RunHistoryArchiveError(`Invalid saved-run job id: ${jobId}`)
    }

    for (const fileName of [`${jobId}.ndjson`, `${jobId}.decision-trace.ndjson`]) {
      const candidate = path.resolve(root, fileName)
      if (path.relative(root, candidate) !== fileName) {
        throw new RunHistoryArchiveError(
          `History path is outside the managed directory: ${fileName}`
        )
      }
      paths.push(candidate)
    }
  }

  return paths
}

export function removeRunHistoryFiles(
  historyDirectory: string,
  jobIds: ReadonlyArray<JobId>
): Effect.Effect<void, RunHistoryArchiveError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const paths = yield* Effect.try({
      try: () => ownedHistoryPaths(historyDirectory, jobIds, path),
      catch: (error) =>
        error instanceof RunHistoryArchiveError
          ? error
          : new RunHistoryArchiveError(
              error instanceof Error ? error.message : 'Invalid saved-run history path.'
            )
    })

    yield* Effect.forEach(
      paths,
      (ownedPath) =>
        fs
          .remove(ownedPath, { force: true })
          .pipe(
            Effect.mapError(
              (error) =>
                new RunHistoryArchiveError(
                  `Could not delete saved-run history ${ownedPath}: ${String(error)}`
                )
            )
          ),
      { concurrency: 1, discard: true }
    )
  })
}

export function deleteRunHistoryFiles(
  historyDirectory: string,
  jobIds: ReadonlyArray<JobId>
): Promise<void> {
  return appRuntime.runPromise(removeRunHistoryFiles(historyDirectory, jobIds))
}
