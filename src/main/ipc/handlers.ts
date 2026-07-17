import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  type IpcMainEvent,
  type IpcMainInvokeEvent
} from 'electron'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Exit, Schema } from 'effect'
import { WorkerSupervisor, SupervisorError } from '../services/WorkerSupervisor.js'
import {
  saveProjectFile,
  loadProjectFile,
  ProjectFileError
} from '../services/ProjectFileService.js'
import {
  buildCsvExportFileName,
  exportCsvResultToFile,
  exportNestingResultToFile,
  loadHistoryReplayFromFile
} from '../services/ExportService.js'
import type { EncodedNestingHistoryFramePayload } from '../services/ExportService.js'
import {
  WorkspaceProjectService,
  WorkspaceProjectError
} from '../services/WorkspaceProjectService.js'
import {
  deleteRunHistoryFiles,
  RunHistoryArchiveError
} from '../services/RunHistoryArchiveService.js'
import { NestingRequest } from '@shared/domain/nesting.js'
import { NestingRequestStrict } from '@shared/schemas/nestingSchemas.js'
import { WorkspaceProjectSettingsStrict } from '@shared/schemas/projectSchemas.js'
import { DeleteRunHistoriesPayload, RunGifExportPayload } from '@shared/protocol/ipc.js'
import type { IpcResult } from '@shared/protocol/ipc.js'
import type { Unsubscribe, NestingHistoryEvent } from '@shared/protocol/ipc.js'
import type { JobId } from '@shared/domain/ids.js'
import {
  CsvRunRecord as CsvRunRecordSchema,
  ProjectCsvImport as ProjectCsvImportSchema,
  WorkspaceProjectSettings,
  type CsvRunRecord,
  type ProjectCsvImport,
  type ProjectDocument,
  type WorkspaceProjectSettings as WorkspaceProjectSettingsModel
} from '@shared/domain/project.js'
import type { NestingResult, ProjectHistoryRef } from '@shared/domain/nesting.js'
import { ImportedDxfDocument as ImportedDxfDocumentSchema } from '@shared/domain/dxf.js'
import type { ImportedDxfDocument } from '@shared/domain/dxf.js'

/**
 * Allowlist of channels the renderer can invoke.
 * Every channel must have a registered handler below.
 */
export const IPC_CHANNELS = [
  'app:ping',
  'dxf:list-imports',
  'dxf:select-files',
  'dxf:import-files',
  'dxf:persist-source-document',
  'dxf:remove-import',
  'dxf:clear-imports',
  'csv:list-imports',
  'csv:select-files',
  'csv:import-files',
  'csv:import-documents-from-project',
  'csv:update-import',
  'csv:remove-import',
  'csv:clear-imports',
  'csv:export-result',
  'workspace:load-settings',
  'workspace:save-settings',
  'workspace:save-settings-sync',
  'nesting:export-request',
  'nesting:export-result',
  'nesting:export-history',
  'nesting:export-run-gif',
  'nesting:load-replay',
  'nesting:delete-run-histories',
  'nesting:run',
  'nesting:cancel',
  'nesting:on-history',
  'project:save',
  'project:open'
] as const
export type IpcChannel = (typeof IPC_CHANNELS)[number]

let pongTimer: NodeJS.Timeout | null = null
let supervisor: WorkerSupervisor | null = null
let workspace: WorkspaceProjectService | null = null
let resultBroadcastRegistered = false
const historyListenersByJob = new Map<JobId, Set<(event: NestingHistoryEvent) => void>>()

function getSupervisor(): WorkerSupervisor {
  if (!supervisor) {
    supervisor = createSupervisor()
  }
  return supervisor
}

function getWorkspace(): WorkspaceProjectService {
  if (!workspace) {
    workspace = new WorkspaceProjectService(app.getPath('userData'))
  }
  return workspace
}

function fromWorkspaceError(err: unknown): IpcResult<never> {
  if (err instanceof WorkspaceProjectError) {
    return { ok: false, error: { code: 'dxf_parse_error', message: err.message } }
  }
  return {
    ok: false,
    error: {
      code: 'dxf_parse_error',
      message: err instanceof Error ? err.message : 'unknown error'
    }
  }
}

function fromCsvError(err: unknown): IpcResult<never> {
  if (err instanceof WorkspaceProjectError) {
    return { ok: false, error: { code: 'dxf_parse_error', message: err.message } }
  }
  return {
    ok: false,
    error: {
      code: 'unknown_error',
      message: err instanceof Error ? err.message : 'unknown error'
    }
  }
}

function createSupervisor(): WorkerSupervisor {
  // In dev, electron-vite dev server compiles main on the fly; the worker
  // file may still be missing until a build runs. Surface a clear error in
  // that case rather than silently swallowing it.
  return new WorkerSupervisor({
    workerPath: getWorkerPath(),
    historyDirectory: getHistoryDirectory(),
    defaultTimeoutMs: 60_000
  })
}

function getHistoryDirectory(): string {
  return join(app.getPath('userData'), 'dfx-min-project', 'history')
}

function getWorkerPath(): string {
  const candidates = [
    join(__dirname, 'workers', 'nesting.worker.mjs'),
    join(__dirname, '..', 'workers', 'nesting.worker.mjs')
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return candidates[0] ?? join(__dirname, 'workers', 'nesting.worker.mjs')
}

function fromSupervisorError(err: unknown): IpcResult<never> {
  if (err instanceof SupervisorError) {
    const ctx = err.context ? { context: err.context } : {}
    return { ok: false, error: { code: err.code, message: err.message, ...ctx } }
  }
  return {
    ok: false,
    error: {
      code: 'unknown_error',
      message: err instanceof Error ? err.message : 'unknown error'
    }
  }
}

export async function initializeWorkspaceProject(): Promise<void> {
  await getWorkspace().initialize()
}

export function registerIpcHandlers(): void {
  // Register the result-broadcast listener exactly once for the whole
  // supervisor lifetime. Round 1 registered a fresh listener on every
  // nesting:run call (handlers.ts old lines 315-325), so the N-th run
  // broadcast results N times and permanently captured the originating
  // window. Round 2 (F2) captures the windows at broadcast time so a
  // closed window is never held.
  if (!resultBroadcastRegistered) {
    getSupervisor().onResult((jobId, result) => {
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) {
          w.webContents.send('nesting:result-event', jobId, result)
        }
      }
    })
    resultBroadcastRegistered = true
  }

  ipcMain.handle('app:ping', (_event: IpcMainInvokeEvent): IpcResult<{ readonly at: string }> => {
    return {
      ok: true,
      value: { at: new Date().toISOString() }
    }
  })

  ipcMain.handle(
    'dxf:list-imports',
    async (): Promise<IpcResult<{ readonly documents: ReadonlyArray<ImportedDxfDocument> }>> => {
      try {
        const documents = await getWorkspace().listImportedDxfs()
        return { ok: true, value: { documents } }
      } catch (err) {
        return fromWorkspaceError(err)
      }
    }
  )

  ipcMain.handle(
    'dxf:select-files',
    async (
      event: IpcMainInvokeEvent
    ): Promise<IpcResult<{ readonly documents: ReadonlyArray<ImportedDxfDocument> }>> => {
      const win = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow()
      const dlg = win
        ? await dialog.showOpenDialog(win, {
            title: 'Select DXF files',
            properties: ['openFile', 'multiSelections'],
            filters: [{ name: 'DXF', extensions: ['dxf'] }]
          })
        : await dialog.showOpenDialog({
            title: 'Select DXF files',
            properties: ['openFile', 'multiSelections'],
            filters: [{ name: 'DXF', extensions: ['dxf'] }]
          })

      if (dlg.canceled) {
        return { ok: true, value: { documents: [] } }
      }
      try {
        const documents = await getWorkspace().importDxfFiles(dlg.filePaths)
        return { ok: true, value: { documents } }
      } catch (err) {
        return fromWorkspaceError(err)
      }
    }
  )

  ipcMain.handle(
    'dxf:import-files',
    async (
      _event: IpcMainInvokeEvent,
      paths: ReadonlyArray<string>
    ): Promise<IpcResult<{ readonly documents: ReadonlyArray<ImportedDxfDocument> }>> => {
      try {
        const documents = await getWorkspace().importDxfFiles(paths)
        return { ok: true, value: { documents } }
      } catch (err) {
        return fromWorkspaceError(err)
      }
    }
  )

  ipcMain.handle(
    'dxf:persist-source-document',
    async (
      _event: IpcMainInvokeEvent,
      raw: unknown
    ): Promise<IpcResult<{ readonly document: ImportedDxfDocument }>> => {
      const decoded = Schema.decodeUnknownExit(ImportedDxfDocumentSchema)(raw)
      if (Exit.isFailure(decoded)) {
        return {
          ok: false,
          error: {
            code: 'validation_error',
            message: 'Invalid source document payload.'
          }
        }
      }
      try {
        const document = await getWorkspace().storeSourceDocument(decoded.value)
        return { ok: true, value: { document } }
      } catch (err) {
        return fromWorkspaceError(err)
      }
    }
  )

  ipcMain.handle(
    'dxf:remove-import',
    async (_event: IpcMainInvokeEvent, pieceId: string): Promise<IpcResult<void>> => {
      try {
        await getWorkspace().removeImportedDxf(pieceId)
        return { ok: true, value: undefined }
      } catch (err) {
        return fromWorkspaceError(err)
      }
    }
  )

  ipcMain.handle('dxf:clear-imports', async (): Promise<IpcResult<void>> => {
    try {
      await getWorkspace().clearImportedDxfs()
      return { ok: true, value: undefined }
    } catch (err) {
      return fromWorkspaceError(err)
    }
  })

  ipcMain.handle(
    'csv:list-imports',
    async (): Promise<IpcResult<{ readonly documents: ProjectCsvImport[] }>> => {
      try {
        const documents = await getWorkspace().listImportedCsvs()
        return { ok: true, value: { documents } }
      } catch (err) {
        return fromCsvError(err)
      }
    }
  )

  ipcMain.handle(
    'csv:select-files',
    async (
      event: IpcMainInvokeEvent
    ): Promise<
      IpcResult<{
        readonly documents: ProjectCsvImport[]
        readonly failures: Array<{ path: string; error: unknown }>
      }>
    > => {
      const win = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow()
      const dlg = win
        ? await dialog.showOpenDialog(win, {
            title: 'Select CSV files',
            properties: ['openFile', 'multiSelections'],
            filters: [{ name: 'CSV', extensions: ['csv'] }]
          })
        : await dialog.showOpenDialog({
            title: 'Select CSV files',
            properties: ['openFile', 'multiSelections'],
            filters: [{ name: 'CSV', extensions: ['csv'] }]
          })

      if (dlg.canceled) {
        return { ok: true, value: { documents: [], failures: [] } }
      }
      try {
        return { ok: true, value: await getWorkspace().importCsvFiles(dlg.filePaths) }
      } catch (err) {
        return fromCsvError(err)
      }
    }
  )

  ipcMain.handle(
    'csv:import-files',
    async (
      _event: IpcMainInvokeEvent,
      paths: ReadonlyArray<string>
    ): Promise<
      IpcResult<{
        readonly documents: ProjectCsvImport[]
        readonly failures: Array<{ path: string; error: unknown }>
      }>
    > => {
      try {
        return { ok: true, value: await getWorkspace().importCsvFiles(paths) }
      } catch (err) {
        return fromCsvError(err)
      }
    }
  )

  ipcMain.handle(
    'csv:import-documents-from-project',
    async (
      _event: IpcMainInvokeEvent,
      raw: unknown
    ): Promise<IpcResult<{ readonly documents: ProjectCsvImport[] }>> => {
      const decoded = Schema.decodeUnknownExit(Schema.Array(ProjectCsvImportSchema))(raw)
      if (Exit.isFailure(decoded)) {
        return {
          ok: false,
          error: {
            code: 'validation_error',
            message: 'Invalid CSV import documents payload.'
          }
        }
      }
      try {
        const documents = await getWorkspace().importCsvDocumentsFromProject(decoded.value)
        return { ok: true, value: { documents } }
      } catch (err) {
        return fromCsvError(err)
      }
    }
  )

  ipcMain.handle(
    'csv:update-import',
    async (
      _event: IpcMainInvokeEvent,
      raw: unknown
    ): Promise<IpcResult<{ readonly document: ProjectCsvImport }>> => {
      const decoded = Schema.decodeUnknownExit(ProjectCsvImportSchema)(raw)
      if (Exit.isFailure(decoded)) {
        return {
          ok: false,
          error: {
            code: 'validation_error',
            message: 'Invalid CSV import payload.'
          }
        }
      }
      try {
        const document = decoded.value
        await getWorkspace().updateImportedCsv(document)
        return { ok: true, value: { document } }
      } catch (err) {
        return fromCsvError(err)
      }
    }
  )

  ipcMain.handle(
    'csv:remove-import',
    async (_event: IpcMainInvokeEvent, id: string): Promise<IpcResult<void>> => {
      try {
        await getWorkspace().removeImportedCsv(id)
        return { ok: true, value: undefined }
      } catch (err) {
        return fromCsvError(err)
      }
    }
  )

  ipcMain.handle('csv:clear-imports', async (): Promise<IpcResult<void>> => {
    try {
      await getWorkspace().clearImportedCsvs()
      return { ok: true, value: undefined }
    } catch (err) {
      return fromCsvError(err)
    }
  })

  ipcMain.handle(
    'csv:export-result',
    async (
      event: IpcMainInvokeEvent,
      csvImport: ProjectCsvImport,
      csvRunRecord: CsvRunRecord,
      outPath?: string
    ): Promise<IpcResult<{ readonly path: string }>> => {
      const importDecoded = Schema.decodeUnknownExit(ProjectCsvImportSchema)(csvImport)
      if (Exit.isFailure(importDecoded)) {
        return {
          ok: false,
          error: {
            code: 'validation_error',
            message: 'Invalid CSV import payload.'
          }
        }
      }
      const recordDecoded = Schema.decodeUnknownExit(CsvRunRecordSchema)(csvRunRecord)
      if (Exit.isFailure(recordDecoded)) {
        return {
          ok: false,
          error: {
            code: 'validation_error',
            message: 'Invalid CSV run record payload.'
          }
        }
      }

      let resolvedOutPath = outPath
      if (!resolvedOutPath) {
        const win = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow()
        const defaultName = buildCsvExportFileName(
          importDecoded.value.jobDate,
          importDecoded.value.materialDescription
        )
        const dlg = win
          ? await dialog.showSaveDialog(win, {
              title: 'Export CSV Result',
              defaultPath: join(app.getPath('downloads'), defaultName),
              filters: [{ name: 'CSV', extensions: ['csv'] }]
            })
          : await dialog.showSaveDialog({
              title: 'Export CSV Result',
              defaultPath: join(app.getPath('downloads'), defaultName),
              filters: [{ name: 'CSV', extensions: ['csv'] }]
            })
        if (dlg.canceled || !dlg.filePath) {
          return {
            ok: false,
            error: {
              code: 'export_error',
              message: 'CSV export cancelled by user.'
            }
          }
        }
        resolvedOutPath = dlg.filePath
      }

      try {
        const path = await exportCsvResultToFile(
          resolvedOutPath,
          importDecoded.value,
          recordDecoded.value
        )
        return { ok: true, value: { path } }
      } catch (err) {
        return {
          ok: false,
          error: {
            code: 'export_error',
            message: err instanceof Error ? err.message : 'unknown error'
          }
        }
      }
    }
  )

  ipcMain.handle(
    'workspace:load-settings',
    async (): Promise<IpcResult<{ readonly settings: WorkspaceProjectSettingsModel | null }>> => {
      try {
        const settings = await getWorkspace().loadWorkspaceSettings()
        return { ok: true, value: { settings } }
      } catch (err) {
        return fromWorkspaceError(err)
      }
    }
  )

  ipcMain.handle(
    'workspace:save-settings',
    async (_event: IpcMainInvokeEvent, raw: unknown): Promise<IpcResult<void>> => {
      const decoded = Schema.decodeUnknownExit(WorkspaceProjectSettingsStrict)(raw)
      if (Exit.isFailure(decoded)) {
        return {
          ok: false,
          error: {
            code: 'validation_error',
            message: 'Invalid workspace settings payload.'
          }
        }
      }
      try {
        await getWorkspace().saveWorkspaceSettings(
          Schema.decodeUnknownSync(WorkspaceProjectSettings)(decoded.value)
        )
        return { ok: true, value: undefined }
      } catch (err) {
        return fromWorkspaceError(err)
      }
    }
  )

  ipcMain.on('workspace:save-settings-sync', (_event: IpcMainEvent, raw: unknown): void => {
    const decoded = Schema.decodeUnknownExit(WorkspaceProjectSettingsStrict)(raw)
    if (Exit.isFailure(decoded)) {
      _event.returnValue = {
        ok: false,
        error: {
          code: 'validation_error',
          message: 'Invalid workspace settings payload.'
        }
      }
      return
    }
    // The renderer is about to tear down on reload. Fire the save and return
    // immediately; the main process outlives the renderer, so the Effect write
    // commits on its event loop even after teardown.
    void getWorkspace().saveWorkspaceSettings(
      Schema.decodeUnknownSync(WorkspaceProjectSettings)(decoded.value)
    )
    _event.returnValue = { ok: true, value: undefined }
  })

  ipcMain.handle(
    'nesting:export-request',
    async (
      event: IpcMainInvokeEvent,
      raw: unknown
    ): Promise<IpcResult<{ readonly path: string }>> => {
      const decoded = Schema.decodeUnknownExit(NestingRequestStrict)(raw)
      if (Exit.isFailure(decoded)) {
        return {
          ok: false,
          error: {
            code: 'validation_error',
            message: 'Invalid nesting request payload.'
          }
        }
      }
      const request = Schema.decodeUnknownSync(NestingRequest)(decoded.value)
      const win = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow()
      const defaultName = `nesting-request-${request.jobId}.json`
      const result = win
        ? await dialog.showSaveDialog(win, {
            title: 'Export Nesting Request',
            defaultPath: defaultName,
            filters: [{ name: 'JSON', extensions: ['json'] }]
          })
        : await dialog.showSaveDialog({
            title: 'Export Nesting Request',
            defaultPath: defaultName,
            filters: [{ name: 'JSON', extensions: ['json'] }]
          })

      if (result.canceled || !result.filePath) {
        return { ok: false, error: { code: 'export_error', message: 'Export cancelled' } }
      }

      try {
        await writeFile(result.filePath, JSON.stringify(request, null, 2), 'utf8')
        return { ok: true, value: { path: result.filePath } }
      } catch (err) {
        return {
          ok: false,
          error: {
            code: 'export_error',
            message: err instanceof Error ? err.message : 'unknown error'
          }
        }
      }
    }
  )

  ipcMain.handle(
    'nesting:export-result',
    async (
      event: IpcMainInvokeEvent,
      result: NestingResult
    ): Promise<IpcResult<{ readonly path: string }>> => {
      const win = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow()
      const defaultName = `nesting-result-${result.jobId}.json`
      const dlg = win
        ? await dialog.showSaveDialog(win, {
            title: 'Export Nesting Result',
            defaultPath: defaultName,
            filters: [{ name: 'JSON', extensions: ['json'] }]
          })
        : await dialog.showSaveDialog({
            title: 'Export Nesting Result',
            defaultPath: defaultName,
            filters: [{ name: 'JSON', extensions: ['json'] }]
          })
      if (dlg.canceled || !dlg.filePath) {
        return { ok: false, error: { code: 'export_error', message: 'Export cancelled' } }
      }
      try {
        const path = await exportNestingResultToFile(dlg.filePath, result)
        return { ok: true, value: { path } }
      } catch (err) {
        return {
          ok: false,
          error: {
            code: 'export_error',
            message: err instanceof Error ? err.message : 'unknown error'
          }
        }
      }
    }
  )

  ipcMain.handle(
    'nesting:export-history',
    async (
      event: IpcMainInvokeEvent,
      ref: ProjectHistoryRef
    ): Promise<IpcResult<{ readonly path: string }>> => {
      const win = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow()
      const defaultName = `history-${ref.jobId}.ndjson`
      const dlg = win
        ? await dialog.showSaveDialog(win, {
            title: 'Export History (NDJSON)',
            defaultPath: defaultName,
            filters: [
              { name: 'NDJSON', extensions: ['ndjson'] },
              { name: 'JSON', extensions: ['json'] }
            ]
          })
        : await dialog.showSaveDialog({
            title: 'Export History (NDJSON)',
            defaultPath: defaultName,
            filters: [
              { name: 'NDJSON', extensions: ['ndjson'] },
              { name: 'JSON', extensions: ['json'] }
            ]
          })
      if (dlg.canceled || !dlg.filePath) {
        return { ok: false, error: { code: 'export_error', message: 'Export cancelled' } }
      }
      try {
        // Copy the worker-written NDJSON replay file to the user-chosen path
        // instead of regenerating it from in-memory frames. The source file
        // is the source of truth.
        const sourceText = await readFile(ref.path, 'utf8')
        await writeFile(dlg.filePath, sourceText, 'utf8')
        return { ok: true, value: { path: dlg.filePath } }
      } catch (err) {
        return {
          ok: false,
          error: {
            code: 'export_error',
            message: err instanceof Error ? err.message : 'unknown error'
          }
        }
      }
    }
  )

  ipcMain.handle(
    'nesting:load-replay',
    async (
      _event: IpcMainInvokeEvent,
      ref: ProjectHistoryRef
    ): Promise<IpcResult<{ readonly frames: ReadonlyArray<EncodedNestingHistoryFramePayload> }>> => {
      try {
        const frames = await loadHistoryReplayFromFile(ref)
        return { ok: true, value: { frames } }
      } catch (err) {
        return {
          ok: false,
          error: {
            code: 'file_read_error',
            message: err instanceof Error ? err.message : 'unknown error'
          }
        }
      }
    }
  )

  ipcMain.handle(
    'nesting:delete-run-histories',
    async (_event: IpcMainInvokeEvent, raw: unknown): Promise<IpcResult<void>> => {
      const decoded = Schema.decodeUnknownExit(DeleteRunHistoriesPayload)(raw)
      if (Exit.isFailure(decoded)) {
        return {
          ok: false,
          error: {
            code: 'validation_error',
            message: 'Invalid saved-run history deletion payload.'
          }
        }
      }
      try {
        await deleteRunHistoryFiles(getHistoryDirectory(), decoded.value.jobIds)
        return { ok: true, value: undefined }
      } catch (error: unknown) {
        return {
          ok: false,
          error: {
            code: 'file_write_error',
            message:
              error instanceof RunHistoryArchiveError
                ? error.message
                : error instanceof Error
                  ? error.message
                  : 'Could not delete saved-run history files.'
          }
        }
      }
    }
  )

  ipcMain.handle(
    'nesting:export-run-gif',
    async (
      event: IpcMainInvokeEvent,
      raw: unknown
    ): Promise<IpcResult<{ readonly path: string }>> => {
      const decoded = Schema.decodeUnknownExit(RunGifExportPayload)(raw)
      if (Exit.isFailure(decoded)) {
        return {
          ok: false,
          error: {
            code: 'validation_error',
            message: 'Invalid GIF export payload.'
          }
        }
      }
      const payload = decoded.value
      if (payload.bytes.length === 0) {
        return {
          ok: false,
          error: {
            code: 'validation_error',
            message: 'GIF export payload is empty.'
          }
        }
      }

      const win = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow()
      const dlg = win
        ? await dialog.showSaveDialog(win, {
            title: 'Export Run GIF',
            defaultPath: join(app.getPath('downloads'), payload.defaultName),
            filters: [{ name: 'GIF', extensions: ['gif'] }]
          })
        : await dialog.showSaveDialog({
            title: 'Export Run GIF',
            defaultPath: join(app.getPath('downloads'), payload.defaultName),
            filters: [{ name: 'GIF', extensions: ['gif'] }]
          })
      if (dlg.canceled || !dlg.filePath) {
        return { ok: false, error: { code: 'export_error', message: 'Export cancelled' } }
      }
      try {
        await writeFile(dlg.filePath, Buffer.from(payload.bytes))
        return { ok: true, value: { path: dlg.filePath } }
      } catch (err) {
        return {
          ok: false,
          error: {
            code: 'export_error',
            message: err instanceof Error ? err.message : 'unknown error'
          }
        }
      }
    }
  )

  ipcMain.handle(
    'nesting:run',
    async (
      _event: IpcMainInvokeEvent,
      raw: unknown
    ): Promise<IpcResult<{ readonly jobId: JobId }>> => {
      const decoded = Schema.decodeUnknownExit(NestingRequestStrict)(raw)
      if (Exit.isFailure(decoded)) {
        return {
          ok: false,
          error: {
            code: 'validation_error',
            message: 'Invalid nesting request payload.'
          }
        }
      }
      const request = Schema.decodeUnknownSync(NestingRequest)(decoded.value)
      try {
        await getSupervisor().runNesting(request, (event) => {
          for (const w of BrowserWindow.getAllWindows()) {
            if (!w.isDestroyed()) {
              w.webContents.send('nesting:history-event', event)
            }
          }
        })
        return { ok: true, value: { jobId: request.jobId } }
      } catch (err) {
        console.error('[main:nesting] run failed', {
          jobId: request.jobId,
          message: err instanceof Error ? err.message : String(err)
        })
        return fromSupervisorError(err)
      }
    }
  )

  ipcMain.handle(
    'nesting:cancel',
    async (_event: IpcMainInvokeEvent, jobId: JobId): Promise<IpcResult<void>> => {
      try {
        getSupervisor().cancelJob(jobId)
        return { ok: true, value: undefined }
      } catch (err) {
        return fromSupervisorError(err)
      }
    }
  )

  ipcMain.handle(
    'nesting:on-history',
    (event: IpcMainInvokeEvent, jobId: JobId): IpcResult<{ readonly unsubscribe: Unsubscribe }> => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) {
        return { ok: false, error: { code: 'unknown_error', message: 'No window for subscriber' } }
      }
      const listener = (e: NestingHistoryEvent): void => {
        win.webContents.send('nesting:history-event', e)
      }
      const existing = historyListenersByJob.get(jobId) ?? new Set()
      existing.add(listener)
      historyListenersByJob.set(jobId, existing)
      return {
        ok: true,
        value: {
          unsubscribe: () => {
            const set = historyListenersByJob.get(jobId)
            if (!set) return
            set.delete(listener)
            if (set.size === 0) historyListenersByJob.delete(jobId)
          }
        }
      }
    }
  )

  ipcMain.handle(
    'project:save',
    async (
      event: IpcMainInvokeEvent,
      project: ProjectDocument
    ): Promise<IpcResult<{ readonly path: string }>> => {
      const win = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow()
      const defaultName = `min-plane-project.json`
      const dlg = win
        ? await dialog.showSaveDialog(win, {
            title: 'Save Project',
            defaultPath: defaultName,
            filters: [{ name: 'JSON', extensions: ['json'] }]
          })
        : await dialog.showSaveDialog({
            title: 'Save Project',
            defaultPath: defaultName,
            filters: [{ name: 'JSON', extensions: ['json'] }]
          })
      if (dlg.canceled || !dlg.filePath) {
        return { ok: false, error: { code: 'export_error', message: 'Save cancelled' } }
      }
      try {
        await saveProjectFile(dlg.filePath, project)
        await getWorkspace().promoteCurrentProject(dlg.filePath)
        return { ok: true, value: { path: dlg.filePath } }
      } catch (err) {
        if (err instanceof ProjectFileError) {
          return { ok: false, error: { code: err.code, message: err.message } }
        }
        return {
          ok: false,
          error: {
            code: 'project_write_error',
            message: err instanceof Error ? err.message : 'unknown error'
          }
        }
      }
    }
  )

  ipcMain.handle(
    'project:open',
    async (event: IpcMainInvokeEvent): Promise<IpcResult<ProjectDocument>> => {
      const win = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow()
      const dlg = win
        ? await dialog.showOpenDialog(win, {
            title: 'Open Project',
            properties: ['openFile'],
            filters: [{ name: 'JSON', extensions: ['json'] }]
          })
        : await dialog.showOpenDialog({
            title: 'Open Project',
            properties: ['openFile'],
            filters: [{ name: 'JSON', extensions: ['json'] }]
          })
      if (dlg.canceled || dlg.filePaths.length === 0) {
        return { ok: false, error: { code: 'project_read_error', message: 'Open cancelled' } }
      }
      const selectedPath = dlg.filePaths[0]
      if (!selectedPath) {
        return {
          ok: false,
          error: { code: 'project_read_error', message: 'No project file selected' }
        }
      }
      try {
        const project = await loadProjectFile(selectedPath)
        return { ok: true, value: project }
      } catch (err) {
        if (err instanceof ProjectFileError) {
          return { ok: false, error: { code: err.code, message: err.message } }
        }
        return {
          ok: false,
          error: {
            code: 'project_read_error',
            message: err instanceof Error ? err.message : 'unknown error'
          }
        }
      }
    }
  )

  // Tiny courtesy push the renderer can subscribe to.
  pongTimer = setInterval(() => {
    const at = new Date().toISOString()
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send('app:pong', at)
    }
  }, 5000)
}

export function unregisterIpcHandlers(): void {
  if (pongTimer) {
    clearInterval(pongTimer)
    pongTimer = null
  }
  for (const channel of IPC_CHANNELS) {
    ipcMain.removeHandler(channel)
  }
  supervisor = null
  workspace = null
  resultBroadcastRegistered = false
  historyListenersByJob.clear()
}
