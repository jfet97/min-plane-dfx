import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { AppApi, HistoryEventEnvelope, IpcResult } from '@shared/protocol/ipc.js'
import type { ImportedDxfDocument } from '@shared/domain/dxf.js'
import type {
  NestingRequest,
  NestingResult,
  NestingHistoryFrame,
  ProjectHistoryRef
} from '@shared/domain/nesting.js'
import type { ProjectDocument, WorkspaceProjectSettings } from '@shared/domain/project.js'
import type { JobId } from '@shared/domain/ids.js'

/**
 * Strongly-typed envelope-aware invoke helper.
 *
 * The main side wraps every reply in `IpcResult<T>`. This helper:
 *   - validates that the shape matches IpcResult<T>
 *   - throws on error envelopes (so the renderer can use a regular try/catch)
 *   - unwraps `.value` on success
 */
async function invokeEnvelope<Args extends ReadonlyArray<unknown>, T>(
  channel: string,
  ...args: Args
): Promise<T> {
  const raw: unknown = await ipcRenderer.invoke(channel, ...args)
  if (!isIpcEnvelope<T>(raw)) {
    throw new Error(`IPC channel ${channel} returned a non-IpcResult envelope`)
  }
  if (raw.ok) return raw.value
  throw new Error(`[${raw.error.code}] ${raw.error.message}`)
}

function isIpcEnvelope<T>(value: unknown): value is IpcResult<T> {
  if (!value || typeof value !== 'object') return false
  const v = value as { ok?: unknown; value?: unknown; error?: unknown }
  if (v.ok === true) return 'value' in v
  if (v.ok === false && v.error && typeof v.error === 'object') {
    const e = v.error as { code?: unknown; message?: unknown }
    return typeof e.code === 'string' && typeof e.message === 'string'
  }
  return false
}

const api: AppApi = {
  ping: () => invokeEnvelope<[], { readonly at: string }>('app:ping'),

  onPong: (callback) => {
    const listener = (_event: IpcRendererEvent, at: string): void => callback(at)
    ipcRenderer.on('app:pong', listener)
    return () => ipcRenderer.removeListener('app:pong', listener)
  },

  listImportedDxfs: () =>
    invokeEnvelope<[], { readonly documents: ReadonlyArray<ImportedDxfDocument> }>(
      'dxf:list-imports'
    ).then((r) => r.documents),

  selectDxfFiles: () =>
    invokeEnvelope<[], { readonly documents: ReadonlyArray<ImportedDxfDocument> }>(
      'dxf:select-files'
    ).then((r) => r.documents),

  importDxfFiles: (paths) =>
    invokeEnvelope<
      [ReadonlyArray<string>],
      { readonly documents: ReadonlyArray<ImportedDxfDocument> }
    >('dxf:import-files', paths).then((r) => r.documents),

  persistSourceDocument: (document) =>
    invokeEnvelope<[ImportedDxfDocument], { readonly document: ImportedDxfDocument }>(
      'dxf:persist-source-document',
      document
    ).then((r) => r.document),

  removeImportedDxf: (pieceId) =>
    invokeEnvelope<[typeof pieceId], void>('dxf:remove-import', pieceId).then(() => undefined),

  clearImportedDxfs: () => invokeEnvelope<[], void>('dxf:clear-imports').then(() => undefined),

  exportNestingRequest: (request) =>
    invokeEnvelope<[NestingRequest], { readonly path: string }>(
      'nesting:export-request',
      request
    ).then(() => undefined),

  runNesting: (request) =>
    new Promise<NestingResult>((resolve, reject) => {
      // Subscribe BEFORE invoking `nesting:run` so we never miss the
      // `nesting:result-event` broadcast that the main handler emits during
      // its awaited supervisor run.
      const listener = (_event: IpcRendererEvent, _jobId: JobId, payload: NestingResult): void => {
        resolve(payload)
        ipcRenderer.removeListener('nesting:result-event', listener)
      }
      ipcRenderer.on('nesting:result-event', listener)
      void invokeEnvelope<[NestingRequest], { readonly jobId: JobId }>(
        'nesting:run',
        request
      ).catch((err: unknown) => {
        ipcRenderer.removeListener('nesting:result-event', listener)
        reject(err instanceof Error ? err : new Error(String(err)))
      })
    }),

  cancelJob: (jobId) =>
    invokeEnvelope<[JobId], { readonly ok: boolean }>('nesting:cancel', jobId).then(
      () => undefined
    ),

  onNestingHistory: (callback) => {
    const listener = (_event: IpcRendererEvent, event: HistoryEventEnvelope): void =>
      callback(event)
    ipcRenderer.on('nesting:history-event', listener)
    return () => ipcRenderer.removeListener('nesting:history-event', listener)
  },

  loadHistoryReplay: (ref) =>
    invokeEnvelope<[ProjectHistoryRef], { readonly frames: ReadonlyArray<NestingHistoryFrame> }>(
      'nesting:load-replay',
      ref
    ).then((r) => r.frames),

  loadWorkspaceSettings: () =>
    invokeEnvelope<[], { readonly settings: WorkspaceProjectSettings | null }>(
      'workspace:load-settings'
    ).then((r) => r.settings),

  saveWorkspaceSettings: (settings) =>
    invokeEnvelope<[WorkspaceProjectSettings], void>('workspace:save-settings', settings).then(
      () => undefined
    ),
  saveWorkspaceSettingsSync: (settings) => {
    ipcRenderer.sendSync('workspace:save-settings-sync', settings)
  },

  saveProject: (project) =>
    invokeEnvelope<[ProjectDocument], { readonly path: string }>('project:save', project).then(
      (r) => r.path
    ),

  openProject: () => invokeEnvelope<[], ProjectDocument>('project:open'),

  exportNestingResult: (result) =>
    invokeEnvelope<[NestingResult], { readonly path: string }>(
      'nesting:export-result',
      result
    ).then(() => undefined),

  exportNestingHistory: (ref) =>
    invokeEnvelope<[ProjectHistoryRef], { readonly path: string }>(
      'nesting:export-history',
      ref
    ).then(() => undefined)
}

try {
  contextBridge.exposeInMainWorld('appApi', api)
} catch {
  // contextBridge is only available in a sandboxed preload; fall back silently
  // in case the bundler ever produces a non-sandboxed build for testing.
}

declare global {
  var appApi: AppApi | undefined
}
