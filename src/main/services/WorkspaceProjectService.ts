import { basename, extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import * as NodePath from '@effect/platform-node/NodePath'
import { SqliteClient } from '@effect/sql-sqlite-node'
import { Effect, Exit, FileSystem, Layer, ManagedRuntime, Path, Schema } from 'effect'
import * as SqlClient from 'effect/unstable/sql/SqlClient'
import { importDxfFile } from './DxfImportService.js'
import { ImportedDxfDocument as ImportedDxfDocumentSchema } from '@shared/domain/dxf.js'
import type { ImportedDxfDocument } from '@shared/domain/dxf.js'
import {
  WorkspaceProjectSettings,
  type WorkspaceProjectSettings as WorkspaceProjectSettingsModel
} from '@shared/domain/project.js'

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

interface StoredSettingsRow {
  readonly settings_json: string | null
  readonly settings_revision: number | null
}

function firstRow(rows: ReadonlyArray<unknown>): StoredDxfRow | null {
  const row = rows[0]
  return storedDxfRow(row)
}

function storedDxfRow(row: unknown): StoredDxfRow | null {
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
    return this.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const revision = settings.revision ?? Date.now()
        const storedSettings = new WorkspaceProjectSettings({ ...settings, revision })
        const json = JSON.stringify(storedSettings)
        const now = new Date().toISOString()
        yield* sql`
          UPDATE projects
          SET settings_json = ${json}, settings_revision = ${revision}, updated_at = ${now}
          WHERE id = 'temporary'
            AND (settings_revision IS NULL OR settings_revision <= ${revision})
        `
      })
    )
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

  private decodeStoredDocument(json: string): ImportedDxfDocument {
    const parsed: unknown = JSON.parse(json)
    const exit = Schema.decodeUnknownExit(ImportedDxfDocumentSchema)(parsed)
    if (Exit.isFailure(exit)) {
      throw new WorkspaceProjectError('Stored DXF document failed schema validation.')
    }
    return exit.value
  }

  private decodeWorkspaceSettings(json: string): WorkspaceProjectSettingsModel {
    const parsed: unknown = JSON.parse(json)
    const exit = Schema.decodeUnknownExit(WorkspaceProjectSettings)(parsed)
    if (Exit.isFailure(exit)) {
      const withoutRunRecords = dropRunRecords(parsed)
      const fallback = Schema.decodeUnknownExit(WorkspaceProjectSettings)(withoutRunRecords)
      if (Exit.isSuccess(fallback)) {
        return fallback.value
      }
      throw new WorkspaceProjectError('Stored workspace settings failed schema validation.')
    }
    return exit.value
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
