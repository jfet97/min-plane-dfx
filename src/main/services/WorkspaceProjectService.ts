import { basename, extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import * as NodePath from '@effect/platform-node/NodePath'
import { SqliteClient } from '@effect/sql-sqlite-node'
import { Effect, Exit, FileSystem, Layer, ManagedRuntime, Path, Schema } from 'effect'
import * as SqlClient from 'effect/unstable/sql/SqlClient'
import { importDxfFile } from './DxfImportService.js'
import { importCsvFiles as parseAndImportCsvFiles } from './CsvImportService.js'
import { ImportedDxfDocument as ImportedDxfDocumentSchema } from '@shared/domain/dxf.js'
import type { ImportedDxfDocument } from '@shared/domain/dxf.js'
import {
  ProjectCsvImport as ProjectCsvImportSchema,
  WorkspaceProjectSettings,
  type ProjectCsvImport,
  type WorkspaceProjectSettings as WorkspaceProjectSettingsModel
} from '@shared/domain/project.js'
import { WorkspaceProjectSettingsStrict } from '@shared/schemas/projectSchemas.js'

export class WorkspaceProjectError extends Error {
  readonly code: 'workspace_error'

  constructor(message: string) {
    super(message)
    this.code = 'workspace_error'
  }
}

interface StoredDxfRow {
  readonly document_json: string
}

interface StoredCsvRow {
  readonly document_json: string
}

interface StoredSettingsRow {
  readonly settings_json: string | null
  readonly settings_revision: number | null
}

function firstRow(rows: ReadonlyArray<unknown>): StoredDxfRow | null {
  const row = rows[0]
  return storedDxfRow(row)
}

function firstCsvRow(rows: ReadonlyArray<unknown>): StoredCsvRow | null {
  const row = rows[0]
  return storedCsvRow(row)
}

function storedDxfRow(row: unknown): StoredDxfRow | null {
  if (typeof row !== 'object' || row === null) return null
  const documentJson = (row as { readonly document_json?: unknown }).document_json
  return typeof documentJson === 'string' ? { document_json: documentJson } : null
}

function storedCsvRow(row: unknown): StoredCsvRow | null {
  if (typeof row !== 'object' || row === null) return null
  const documentJson = (row as { readonly document_json?: unknown }).document_json
  return typeof documentJson === 'string' ? { document_json: documentJson } : null
}

function storedSettingsRow(row: unknown): StoredSettingsRow | null {
  if (typeof row !== 'object' || row === null) return null
  const settingsJson = (row as { readonly settings_json?: unknown }).settings_json
  const settingsRevision = (row as { readonly settings_revision?: unknown }).settings_revision
  const revision =
    typeof settingsRevision === 'number' ? settingsRevision : settingsRevision === null ? null : 0
  return settingsJson === null || typeof settingsJson === 'string'
    ? { settings_json: settingsJson, settings_revision: revision }
    : null
}

export class WorkspaceProjectService {
  private readonly workspaceRoot: string
  private readonly filesRoot: string
  private readonly stagingRoot: string
  private readonly runtime: ManagedRuntime.ManagedRuntime<
    FileSystem.FileSystem | Path.Path | SqliteClient.SqliteClient | SqlClient.SqlClient,
    never
  >
  /** Serializes workspace settings writes so dispatch order equals commit order. */
  private settingsWriteQueue: Promise<void> = Promise.resolve()

  constructor(userDataPath: string) {
    this.workspaceRoot = join(userDataPath, 'temporary-project')
    this.filesRoot = join(this.workspaceRoot, 'sources')
    this.stagingRoot = join(this.workspaceRoot, '.staging')
    const dbPath = join(this.workspaceRoot, 'workspace.sqlite')
    mkdirSync(this.workspaceRoot, { recursive: true })
    this.runtime = ManagedRuntime.make(
      Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, SqliteClient.layer({ filename: dbPath }))
    )
  }

  initialize(): Promise<void> {
    const workspaceRoot = this.workspaceRoot
    const stagingRoot = this.stagingRoot
    return this.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const fs = yield* FileSystem.FileSystem
        yield* fs.makeDirectory(workspaceRoot, { recursive: true })
        yield* fs.remove(stagingRoot, { recursive: true }).pipe(Effect.ignore)
        yield* fs.makeDirectory(stagingRoot, { recursive: true })
        yield* sql`
          CREATE TABLE IF NOT EXISTS projects (
            id TEXT PRIMARY KEY,
            kind TEXT NOT NULL,
            saved_path TEXT,
            promoted_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          )
        `
        yield* sql`
          CREATE TABLE IF NOT EXISTS imported_dxf (
            id TEXT PRIMARY KEY,
            source_path TEXT NOT NULL UNIQUE,
            stored_path TEXT NOT NULL,
            piece_id TEXT,
            file_name TEXT NOT NULL,
            document_json TEXT NOT NULL,
            imported_at TEXT NOT NULL
          )
        `
        yield* sql`
          CREATE TABLE IF NOT EXISTS imported_csv (
            id TEXT PRIMARY KEY,
            source_path TEXT NOT NULL UNIQUE,
            file_name TEXT NOT NULL,
            document_json TEXT NOT NULL,
            imported_at TEXT NOT NULL
          )
        `
        yield* sql`ALTER TABLE projects ADD COLUMN saved_path TEXT`.pipe(Effect.ignore)
        yield* sql`ALTER TABLE projects ADD COLUMN promoted_at TEXT`.pipe(Effect.ignore)
        yield* sql`ALTER TABLE projects ADD COLUMN settings_json TEXT`.pipe(Effect.ignore)
        yield* sql`ALTER TABLE projects ADD COLUMN settings_revision INTEGER`.pipe(Effect.ignore)
        yield* sql`ALTER TABLE imported_dxf ADD COLUMN piece_id TEXT`.pipe(Effect.ignore)
        const now = new Date().toISOString()
        yield* sql`
          INSERT INTO projects (id, kind, saved_path, promoted_at, created_at, updated_at)
          VALUES ('temporary', 'temporary', NULL, NULL, ${now}, ${now})
          ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at
        `
      })
    )
  }

  importDxfFiles(paths: ReadonlyArray<string>): Promise<ReadonlyArray<ImportedDxfDocument>> {
    return this.run(Effect.forEach(paths, (path) => this.importDxfFile(path), { concurrency: 2 }))
  }

  storeSourceDocument(document: ImportedDxfDocument): Promise<ImportedDxfDocument> {
    return this.run(this.storeSourceDocumentEffect(document))
  }

  importCsvFiles(
    paths: readonly string[]
  ): Promise<{ documents: ProjectCsvImport[]; failures: Array<{ path: string; error: unknown }> }> {
    return this.run(
      Effect.forEach(
        paths,
        (path) =>
          Effect.match(this.importCsvFile(path), {
            onFailure: (error) => ({ kind: 'failure' as const, path, error }),
            onSuccess: (document) => ({ kind: 'success' as const, document })
          }),
        { concurrency: 2 }
      ).pipe(
        Effect.map((results) => {
          const documents: ProjectCsvImport[] = []
          const failures: Array<{ path: string; error: unknown }> = []
          for (const result of results) {
            if (result.kind === 'success') {
              documents.push(result.document)
            } else {
              failures.push({ path: result.path, error: result.error })
            }
          }
          return { documents, failures }
        })
      )
    )
  }

  storeSourceCsvDocument(document: ProjectCsvImport): Promise<ProjectCsvImport> {
    const core = this.storeSourceCsvDocumentCoreEffect.bind(this)
    return this.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const result = yield* sql.withTransaction(core(document))
        const now = new Date().toISOString()
        yield* sql`UPDATE projects SET updated_at = ${now} WHERE id = 'temporary'`
        return result
      })
    )
  }

  importCsvDocumentsFromProject(
    documents: readonly ProjectCsvImport[]
  ): Promise<ProjectCsvImport[]> {
    const core = this.storeSourceCsvDocumentCoreEffect.bind(this)
    return this.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const stored: ProjectCsvImport[] = []
        yield* sql.withTransaction(
          Effect.gen(function* () {
            for (const document of documents) {
              stored.push(yield* core(document))
            }
          })
        )
        const now = new Date().toISOString()
        yield* sql`UPDATE projects SET updated_at = ${now} WHERE id = 'temporary'`
        return stored
      })
    )
  }

  listImportedCsvs(): Promise<ProjectCsvImport[]> {
    const decodeStoredCsvDocument = this.decodeStoredCsvDocument.bind(this)
    return this.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const rows = yield* sql`
          SELECT document_json
          FROM imported_csv
          ORDER BY imported_at ASC, id ASC
        `
        return rows.map((row) => {
          const stored = storedCsvRow(row)
          if (!stored) {
            throw new WorkspaceProjectError('Stored CSV row has an invalid shape.')
          }
          return decodeStoredCsvDocument(stored.document_json)
        })
      })
    )
  }

  updateImportedCsv(document: ProjectCsvImport): Promise<void> {
    return this.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const json = JSON.stringify(document)
        const now = new Date().toISOString()
        yield* sql.withTransaction(
          Effect.gen(function* () {
            const existing = yield* sql`
              SELECT id FROM imported_csv WHERE id = ${document.id}
            `
            if (existing.length > 0) {
              yield* sql`
                UPDATE imported_csv
                SET document_json = ${json}
                WHERE id = ${document.id}
              `
            } else {
              yield* sql`
                INSERT INTO imported_csv (id, source_path, file_name, document_json, imported_at)
                VALUES (${document.id}, ${document.sourcePath}, ${document.fileName}, ${json}, ${now})
              `
            }
            yield* sql`
              UPDATE projects SET updated_at = ${now} WHERE id = 'temporary'
            `
          })
        )
      })
    )
  }

  removeImportedCsv(id: string): Promise<void> {
    return this.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`DELETE FROM imported_csv WHERE id = ${id}`
      })
    )
  }

  clearImportedCsvs(): Promise<void> {
    return this.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`DELETE FROM imported_csv`
      })
    )
  }

  loadWorkspaceSettings(): Promise<WorkspaceProjectSettingsModel | null> {
    const decodeWorkspaceSettings = this.decodeWorkspaceSettings.bind(this)
    return this.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const rows = yield* sql`
          SELECT settings_json, settings_revision FROM projects WHERE id = 'temporary'
        `
        const stored = storedSettingsRow(rows[0])
        if (!stored?.settings_json) return null
        return decodeWorkspaceSettings(stored.settings_json)
      })
    )
  }

  saveWorkspaceSettings(settings: WorkspaceProjectSettingsModel): Promise<void> {
    const strict = Schema.decodeUnknownExit(WorkspaceProjectSettingsStrict)(settings)
    if (Exit.isFailure(strict)) {
      return Promise.reject(
        new WorkspaceProjectError('Workspace settings failed schema validation before save.')
      )
    }
    const decoded = Schema.decodeUnknownSync(WorkspaceProjectSettings)(strict.value)
    const performWrite = () =>
      this.run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const revision = decoded.revision ?? Date.now()
          const json = JSON.stringify({ ...decoded, revision })
          const now = new Date().toISOString()
          yield* sql`
            UPDATE projects
            SET settings_json = ${json}, settings_revision = ${revision}, updated_at = ${now}
            WHERE id = 'temporary'
          `
        })
      )
    const enqueued = this.settingsWriteQueue.then(performWrite, performWrite)
    this.settingsWriteQueue = enqueued.catch(() => undefined)
    return enqueued
  }

  listImportedDxfs(): Promise<ReadonlyArray<ImportedDxfDocument>> {
    const decodeStoredDocument = this.decodeStoredDocument.bind(this)
    return this.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const rows = yield* sql`
          SELECT document_json
          FROM imported_dxf
          ORDER BY imported_at ASC, id ASC
        `
        return rows.map((row) => {
          const stored = storedDxfRow(row)
          if (!stored) {
            throw new WorkspaceProjectError('Stored DXF row has an invalid shape.')
          }
          return decodeStoredDocument(stored.document_json)
        })
      })
    )
  }

  removeImportedDxf(pieceId: string): Promise<void> {
    return this.run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const sql = yield* SqlClient.SqlClient
        const rows = yield* sql`
          SELECT stored_path FROM imported_dxf WHERE piece_id = ${pieceId}
        `
        const paths = rows.flatMap((row) => {
          if (typeof row !== 'object' || row === null) return []
          const storedPath = (row as { readonly stored_path?: unknown }).stored_path
          return typeof storedPath === 'string' ? [storedPath] : []
        })
        yield* sql`
          DELETE FROM imported_dxf WHERE piece_id = ${pieceId}
        `
        yield* Effect.forEach(paths, (path) => fs.remove(path).pipe(Effect.ignore))
      })
    )
  }

  clearImportedDxfs(): Promise<void> {
    return this.run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const sql = yield* SqlClient.SqlClient
        const rows = yield* sql`
          SELECT stored_path FROM imported_dxf
        `
        const paths = rows.flatMap((row) => {
          if (typeof row !== 'object' || row === null) return []
          const storedPath = (row as { readonly stored_path?: unknown }).stored_path
          return typeof storedPath === 'string' ? [storedPath] : []
        })
        yield* sql`DELETE FROM imported_dxf`
        yield* Effect.forEach(paths, (path) => fs.remove(path).pipe(Effect.ignore))
      })
    )
  }

  promoteCurrentProject(savedPath: string): Promise<void> {
    return this.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const now = new Date().toISOString()
        yield* sql`
          UPDATE projects
          SET kind = 'saved', saved_path = ${savedPath}, promoted_at = ${now}, updated_at = ${now}
          WHERE id = 'temporary'
        `
      })
    )
  }

  private importDxfFile(sourcePath: string) {
    const filesRoot = this.filesRoot
    const stagingRoot = this.stagingRoot
    const decodeStoredDocument = this.decodeStoredDocument.bind(this)
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const sql = yield* SqlClient.SqlClient
      yield* fs.makeDirectory(filesRoot, { recursive: true })

      const existingRows = yield* sql`
        SELECT document_json FROM imported_dxf WHERE source_path = ${sourcePath}
      `
      const existing = firstRow(existingRows)
      if (existing) {
        return decodeStoredDocument(existing.document_json)
      }

      const storedName = `${randomUUID()}${extname(sourcePath) || '.dxf'}`
      const stagingPath = join(stagingRoot, storedName)
      const storedPath = join(filesRoot, storedName)
      yield* fs.copyFile(sourcePath, stagingPath)
      return yield* Effect.gen(function* () {
        const document = yield* Effect.tryPromise({
          try: () => importDxfFile(stagingPath),
          catch: (cause) =>
            new WorkspaceProjectError(cause instanceof Error ? cause.message : String(cause))
        })
        yield* fs.rename(stagingPath, storedPath)
        const storedDocument: ImportedDxfDocument = {
          ...document,
          path: storedPath,
          fileName: basename(sourcePath)
        }
        const pieceId = storedDocument.pieces[0]?.id ?? storedDocument.id
        const json = JSON.stringify(storedDocument)
        const now = new Date().toISOString()
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              INSERT INTO imported_dxf (id, source_path, stored_path, piece_id, file_name, document_json, imported_at)
              VALUES (${storedDocument.id}, ${sourcePath}, ${storedPath}, ${pieceId}, ${storedDocument.fileName}, ${json}, ${now})
            `
            yield* sql`
              UPDATE projects SET updated_at = ${now} WHERE id = 'temporary'
            `
          })
        )
        return storedDocument
      }).pipe(
        Effect.tapError(() =>
          Effect.all(
            [fs.remove(stagingPath).pipe(Effect.ignore), fs.remove(storedPath).pipe(Effect.ignore)],
            { discard: true }
          )
        )
      )
    })
  }

  private storeSourceDocumentEffect(document: ImportedDxfDocument) {
    const decodeStoredDocument = this.decodeStoredDocument.bind(this)
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const existingRows = yield* sql`
        SELECT document_json FROM imported_dxf WHERE source_path = ${document.path}
      `
      const existing = firstRow(existingRows)
      if (existing) {
        return decodeStoredDocument(existing.document_json)
      }

      const pieceId = document.pieces[0]?.id ?? document.id
      const json = JSON.stringify(document)
      const now = new Date().toISOString()
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`
            INSERT INTO imported_dxf (id, source_path, stored_path, piece_id, file_name, document_json, imported_at)
            VALUES (${document.id}, ${document.path}, ${document.path}, ${pieceId}, ${document.fileName}, ${json}, ${now})
          `
          yield* sql`
            UPDATE projects SET updated_at = ${now} WHERE id = 'temporary'
          `
        })
      )
      return document
    })
  }

  private importCsvFile(sourcePath: string) {
    const filesRoot = this.filesRoot
    const stagingRoot = this.stagingRoot
    const decodeStoredCsvDocument = this.decodeStoredCsvDocument.bind(this)
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const sql = yield* SqlClient.SqlClient
      yield* fs.makeDirectory(filesRoot, { recursive: true })

      const existingRows = yield* sql`
        SELECT document_json FROM imported_csv WHERE source_path = ${sourcePath}
      `
      const existing = firstCsvRow(existingRows)
      if (existing) {
        return decodeStoredCsvDocument(existing.document_json)
      }

      const storedName = `${randomUUID()}${extname(sourcePath) || '.csv'}`
      const stagingPath = join(stagingRoot, storedName)
      const storedPath = join(filesRoot, storedName)
      yield* fs.copyFile(sourcePath, stagingPath)
      return yield* Effect.gen(function* () {
        const { successes, failures } = yield* Effect.tryPromise({
          try: () => parseAndImportCsvFiles([stagingPath]),
          catch: (cause) =>
            new WorkspaceProjectError(cause instanceof Error ? cause.message : String(cause))
        })
        if (failures.length > 0) {
          const failure = failures[0]
          const failureError =
            failure?.error instanceof Error
              ? failure.error
              : new WorkspaceProjectError(String(failure?.error ?? 'Unknown CSV import failure'))
          return yield* Effect.fail(failureError)
        }
        const parsed = successes[0]
        if (!parsed) {
          return yield* Effect.fail(new WorkspaceProjectError('CSV import produced no document.'))
        }
        yield* fs.rename(stagingPath, storedPath)
        const storedDocument = new ProjectCsvImportSchema({
          ...parsed,
          sourcePath,
          fileName: basename(sourcePath)
        })
        const json = JSON.stringify(storedDocument)
        const now = new Date().toISOString()
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              INSERT INTO imported_csv (id, source_path, file_name, document_json, imported_at)
              VALUES (${storedDocument.id}, ${sourcePath}, ${storedDocument.fileName}, ${json}, ${now})
            `
            yield* sql`
              UPDATE projects SET updated_at = ${now} WHERE id = 'temporary'
            `
          })
        )
        return storedDocument
      }).pipe(
        Effect.tapError(() =>
          Effect.all(
            [fs.remove(stagingPath).pipe(Effect.ignore), fs.remove(storedPath).pipe(Effect.ignore)],
            { discard: true }
          )
        )
      )
    })
  }

  private storeSourceCsvDocumentCoreEffect(document: ProjectCsvImport) {
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const json = JSON.stringify(document)
      const now = new Date().toISOString()

      /*
       * Remove any stale row tied to the same source path but a different id
       * before upserting, so the unique source_path constraint is respected
       * when a project rehydrates documents with new ids.
       */
      yield* sql`
        DELETE FROM imported_csv
        WHERE source_path = ${document.sourcePath} AND id != ${document.id}
      `

      yield* sql`
        INSERT INTO imported_csv (id, source_path, file_name, document_json, imported_at)
        VALUES (${document.id}, ${document.sourcePath}, ${document.fileName}, ${json}, ${now})
        ON CONFLICT(id) DO UPDATE SET
          source_path = excluded.source_path,
          file_name = excluded.file_name,
          document_json = excluded.document_json,
          imported_at = excluded.imported_at
      `

      return document
    })
  }

  private decodeStoredDocument(json: string): ImportedDxfDocument {
    const parsed: unknown = JSON.parse(json)
    const exit = Schema.decodeUnknownExit(ImportedDxfDocumentSchema)(parsed)
    if (Exit.isFailure(exit)) {
      throw new WorkspaceProjectError('Stored DXF document failed schema validation.')
    }
    return exit.value
  }

  private decodeStoredCsvDocument(json: string): ProjectCsvImport {
    const parsed: unknown = JSON.parse(json)
    const exit = Schema.decodeUnknownExit(ProjectCsvImportSchema)(parsed)
    if (Exit.isFailure(exit)) {
      throw new WorkspaceProjectError('Stored CSV document failed schema validation.')
    }
    return exit.value
  }

  private decodeWorkspaceSettings(json: string): WorkspaceProjectSettingsModel {
    const parsed: unknown = JSON.parse(json)
    const exit = Schema.decodeUnknownExit(WorkspaceProjectSettingsStrict)(parsed)
    if (Exit.isFailure(exit)) {
      const withoutRunRecords = dropRunRecords(parsed)
      const fallback = Schema.decodeUnknownExit(WorkspaceProjectSettingsStrict)(withoutRunRecords)
      if (Exit.isSuccess(fallback)) {
        return Schema.decodeUnknownSync(WorkspaceProjectSettings)(fallback.value)
      }
      throw new WorkspaceProjectError('Stored workspace settings failed schema validation.')
    }
    return Schema.decodeUnknownSync(WorkspaceProjectSettings)(exit.value)
  }

  private run<A, E>(
    effect: Effect.Effect<
      A,
      E,
      FileSystem.FileSystem | Path.Path | SqliteClient.SqliteClient | SqlClient.SqlClient
    >
  ): Promise<A> {
    return this.runtime.runPromise(effect)
  }
}

function dropRunRecords(value: unknown): unknown {
  if (!isRecord(value)) return value
  // a bad archived run must not prevent the current workspace setup loading
  return {
    ...Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'runRecords')),
    runRecords: []
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
