import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Exit, Schema } from 'effect'
import { ProjectDocumentStrict } from '@shared/schemas/projectSchemas.js'
import { ProjectDocument } from '@shared/domain/project.js'
import type { AppErrorCode } from '@shared/protocol/errors.js'

export class ProjectFileError extends Error {
  readonly code: AppErrorCode

  constructor(code: AppErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

/**
 * Save a ProjectDocument to a chosen file path. Validates before writing so
 * the file on disk is always consistent with the schema.
 */
export async function saveProjectFile(path: string, project: ProjectDocument): Promise<void> {
  const exit = Schema.decodeUnknownExit(ProjectDocumentStrict)(project)
  if (Exit.isFailure(exit)) {
    throw new ProjectFileError('project_write_error', 'Project document failed schema validation.')
  }
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(project, null, 2), 'utf8')
}

/**
 * Read a project file from disk and validate it. Returns the parsed
 * ProjectDocument or throws a ProjectFileError with the failure code.
 */
export async function loadProjectFile(path: string): Promise<ProjectDocument> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (err) {
    throw new ProjectFileError(
      'file_read_error',
      err instanceof Error ? err.message : 'unknown file read error'
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new ProjectFileError(
      'project_read_error',
      err instanceof Error ? err.message : 'invalid JSON'
    )
  }

  const exit = Schema.decodeUnknownExit(ProjectDocumentStrict)(parsed)
  if (Exit.isFailure(exit)) {
    throw new ProjectFileError('project_read_error', 'Project file failed schema validation.')
  }
  return Schema.decodeUnknownSync(ProjectDocument)(exit.value)
}
