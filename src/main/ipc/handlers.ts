import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { importDxfFiles } from '../services/DxfImportService.js'
import { WorkerSupervisor, SupervisorError } from '../services/WorkerSupervisor.js'
import { saveProjectFile, loadProjectFile, ProjectFileError } from '../services/ProjectFileService.js'
import { exportNestingResultToFile } from '../services/ExportService.js'
import type { IpcResult } from '@shared/protocol/ipc.js'
import type { Unsubscribe, NestingHistoryEvent } from '@shared/protocol/ipc.js'
import type { JobId } from '@shared/domain/ids.js'
import type { ProjectDocument } from '@shared/domain/project.js'
import type {
  NestingRequest,
  NestingResult,
  ProjectHistoryRef,
  NestingHistoryFrame
} from '@shared/domain/nesting.js'
import type { ImportedDxfDocument } from '@shared/domain/dxf.js'

/**
 * Allowlist of channels the renderer can invoke.
 * Every channel must have a registered handler below.
 */
export const IPC_CHANNELS = [
  'app:ping',
  'dxf:select-files',
  'dxf:import-files',
  'nesting:export-request',
  'nesting:export-result',
  'nesting:export-history',
  'nesting:run',
  'nesting:cancel',
  'nesting:on-history',
  'project:save',
  'project:open'
] as const
export type IpcChannel = (typeof IPC_CHANNELS)[number]

let pongTimer: NodeJS.Timeout | null = null
let supervisor: WorkerSupervisor | null = null
const historyListenersByJob = new Map<JobId, Set<(event: NestingHistoryEvent) => void>>()

function getSupervisor(): WorkerSupervisor {
  if (!supervisor) {
    supervisor = createSupervisor()
  }
  return supervisor
}

function createSupervisor(): WorkerSupervisor {
  // In dev, electron-vite dev server compiles main on the fly; the worker
  // file may still be missing until a build runs. Surface a clear error in
  // that case rather than silently swallowing it.
  return new WorkerSupervisor({
    workerPath: getWorkerPath(),
    defaultTimeoutMs: 60_000
  })
}

function getWorkerPath(): string {
  const candidates = [
    join(__dirname, 'workers', 'nesting.worker.cjs'),
    join(__dirname, '..', 'workers', 'nesting.worker.cjs')
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return candidates[0]!
}

export function registerIpcHandlers(): void {
  ipcMain.handle('app:ping', (_event: IpcMainInvokeEvent): IpcResult<{ readonly at: string }> => {
    return {
      ok: true,
      value: { at: new Date().toISOString() }
    }
  })

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
        const results = await importDxfFiles(dlg.filePaths)
        const documents = results.flatMap((r) => ('error' in r ? [] : [r]))
        return { ok: true, value: { documents } }
      } catch (err) {
        return {
          ok: false,
          error: {
            code: 'dxf_parse_error',
            message: err instanceof Error ? err.message : 'unknown error'
          }
        }
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
        const results = await importDxfFiles(paths)
        const documents = results.flatMap((r) => ('error' in r ? [] : [r]))
        return { ok: true, value: { documents } }
      } catch (err) {
        return {
          ok: false,
          error: {
            code: 'dxf_parse_error',
            message: err instanceof Error ? err.message : 'unknown error'
          }
        }
      }
    }
  )

  ipcMain.handle(
    'nesting:export-request',
    async (
      event: IpcMainInvokeEvent,
      request: NestingRequest
    ): Promise<IpcResult<{ readonly path: string }>> => {
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
    'nesting:run',
    async (
      event: IpcMainInvokeEvent,
      request: NestingRequest
    ): Promise<IpcResult<{ readonly jobId: JobId }>> => {
      const win = BrowserWindow.fromWebContents(event.sender)
      const sup = getSupervisor()

      // Broadcast the final result so the renderer can resolve its pending
      // runNesting promise even though `nesting:run` returns only the jobId.
      sup.onResult((jobId, result) => {
        if (win) {
          win.webContents.send('nesting:result-event', jobId, result)
        } else {
          for (const w of BrowserWindow.getAllWindows()) {
            w.webContents.send('nesting:result-event', jobId, result)
          }
        }
      })

      try {
        await sup.runNesting(request, (event) => {
          const listeners = historyListenersByJob.get(request.jobId)
          if (!listeners) return
          for (const l of listeners) {
            try {
              l(event)
            } catch (err) {
              console.error('[ipc] history listener threw:', err)
            }
          }
        })
        return { ok: true, value: { jobId: request.jobId } }
      } catch (err) {
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
    (
      event: IpcMainInvokeEvent,
      jobId: JobId
    ): IpcResult<{ readonly unsubscribe: Unsubscribe }> => {
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
  historyListenersByJob.clear()
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
            filters: [{ name: 'NDJSON', extensions: ['ndjson'] }, { name: 'JSON', extensions: ['json'] }]
          })
        : await dialog.showSaveDialog({
            title: 'Export History (NDJSON)',
            defaultPath: defaultName,
            filters: [{ name: 'NDJSON', extensions: ['ndjson'] }, { name: 'JSON', extensions: ['json'] }]
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
    ): Promise<IpcResult<{ readonly frames: ReadonlyArray<NestingHistoryFrame> }>> => {
      try {
        const text = await readFile(ref.path, 'utf8')
        const frames = text
          .split('\n')
          .filter((line) => line.length > 0)
          .flatMap((line) => {
            try {
              const obj = JSON.parse(line) as NestingHistoryFrame
              return [obj]
            } catch {
              return []
            }
          })
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
      try {
        const project = await loadProjectFile(dlg.filePaths[0]!)
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
