import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { AppApi, HistoryEventEnvelope, IpcResult } from '@shared/protocol/ipc.js'
import type { ImportedDxfDocument } from '@shared/domain/dxf.js'
import type {
  NestingRequest,
  NestingResult,
  NestingHistoryFrame,
  ProjectHistoryRef
} from '@shared/domain/nesting.js'
import type { ProjectDocument } from '@shared/domain/project.js'
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
  const raw = await ipcRenderer.invoke(channel, ...args)
  if (!raw || typeof raw !== 'object' || !('ok' in raw)) {
    throw new Error(`IPC channel ${channel} returned a non-IpcResult envelope`)
  }
  const result = raw as IpcResult<T>
  if (result.ok) return result.value
  const message = result.error?.message ?? 'IPC error'
  const code = result.error?.code ?? 'unknown_error'
  throw new Error(`[${code}] ${message}`)
}

const api: AppApi = {
  ping: () => invokeEnvelope<[], { readonly at: string }>('app:ping'),

  onPong: (callback) => {
    const listener = (_event: IpcRendererEvent, at: string): void => callback(at)
    ipcRenderer.on('app:pong', listener)
    return () => ipcRenderer.removeListener('app:pong', listener)
  },

  selectDxfFiles: () =>
    invokeEnvelope<[], { readonly documents: ReadonlyArray<ImportedDxfDocument> }>(
      'dxf:select-files'
    ).then((r) => r.documents),

  importDxfFiles: (paths) =>
    invokeEnvelope<[ReadonlyArray<string>], { readonly documents: ReadonlyArray<ImportedDxfDocument> }>(
      'dxf:import-files',
      paths
    ).then((r) => r.documents),

  exportNestingRequest: (request) =>
    invokeEnvelope<[NestingRequest], { readonly path: string }>(
      'nesting:export-request',
      request
    ).then(() => undefined),

  runNesting: (request) =>
    invokeEnvelope<[NestingRequest], { readonly jobId: JobId }>(
      'nesting:run',
      request
    ).then(async () => {
      // The supervisor delivers the final NestingResult via a `nesting:result-event`
      // push that this bridge subscribes to. The renderer awaits it through the
      // subscribe path below; here we resolve a placeholder so the AppApi contract
      // stays Promise<NestingResult>.
      return new Promise<NestingResult>((resolve) => {
        const listener = (_event: IpcRendererEvent, payload: NestingResult): void => {
          resolve(payload)
          ipcRenderer.removeListener('nesting:result-event', listener)
        }
        ipcRenderer.on('nesting:result-event', listener)
      })
    }),

  cancelJob: (jobId) =>
    invokeEnvelope<[JobId], { readonly ok: boolean }>('nesting:cancel', jobId).then(() => undefined),

  onNestingHistory: (callback) => {
    const listener = (_event: IpcRendererEvent, event: HistoryEventEnvelope): void => callback(event)
    ipcRenderer.on('nesting:history-event', listener)
    return () => ipcRenderer.removeListener('nesting:history-event', listener)
  },

  loadHistoryReplay: (ref) =>
    invokeEnvelope<[ProjectHistoryRef], { readonly frames: ReadonlyArray<NestingHistoryFrame> }>(
      'nesting:load-replay',
      ref
    ).then((r) => r.frames),

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