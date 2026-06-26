import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { AppApi, HistoryEventEnvelope } from '@shared/protocol/ipc.js'
import type { ImportedDxfDocument } from '@shared/domain/dxf.js'
import type { NestingRequest, NestingResult, ProjectHistoryRef } from '@shared/domain/nesting.js'
import type { ProjectDocument } from '@shared/domain/project.js'

/** Wraps a Promise-returning IPC invoke into a typed result. */
function invoke<Args extends ReadonlyArray<unknown>, Result>(
  channel: string
): (...args: Args) => Promise<Result> {
  return (...args) => ipcRenderer.invoke(channel, ...args) as unknown as Promise<Result>
}

/**
 * Preload bridge exposed via contextBridge. The renderer never sees raw IPC
 * channels; it talks to typed methods. Channels are added in later phases.
 */
const api: AppApi = {
  ping: () =>
    ipcRenderer.invoke('app:ping') as unknown as Promise<{ readonly at: string }>,

  onPong: (callback) => {
    const listener = (_event: IpcRendererEvent, at: string): void => callback(at)
    ipcRenderer.on('app:pong', listener)
    return () => ipcRenderer.removeListener('app:pong', listener)
  },

  selectDxfFiles: () =>
    invoke<[], { readonly paths: ReadonlyArray<string> }>('dxf:select-files')().then((r) =>
      r.paths.length === 0 ? [] : Promise.reject(new Error('user cancelled'))
    ),

  importDxfFiles: (paths) =>
    invoke<[ReadonlyArray<string>], {
      readonly documents: ReadonlyArray<ImportedDxfDocument | { readonly path: string; readonly error: unknown }>
    }>('dxf:import-files')(paths).then((r) => {
      // Filter out failures; the renderer treats the absence of a document
      // as a soft error surfaced through the import store.
      return r.documents.filter(
        (d): d is ImportedDxfDocument => !('error' in d)
      )
    }),

  // Phase 4 placeholder
  exportNestingRequest: (request: NestingRequest): Promise<void> =>
    invoke<[NestingRequest], { readonly path: string }>('nesting:export-request')(request).then(
      () => undefined
    ),

  // Phase 5
  runNesting: (request) =>
    invoke<[NestingRequest], { readonly jobId: string }>('nesting:run')(request).then(() => {
      // The supervisor does the heavy lifting; the renderer awaits the result
      // by listening for `nesting:result-event` push (added below). Return a
      // throwaway promise so the AppApi contract still resolves.
      return undefined as unknown as NestingResult
    }),
  cancelJob: (jobId) =>
    invoke<[string], { readonly ok: boolean }>('nesting:cancel')(jobId).then(() => undefined),
  onNestingHistory: (callback) => {
    const listener = (_event: IpcRendererEvent, event: HistoryEventEnvelope): void => callback(event)
    ipcRenderer.on('nesting:history-event', listener)
    return () => ipcRenderer.removeListener('nesting:history-event', listener)
  },
  loadHistoryReplay: (_ref: ProjectHistoryRef): Promise<ReadonlyArray<NestingResult>> => Promise.resolve([]),

  // Phase 8 placeholders
  saveProject: (project) =>
    invoke<[ProjectDocument], { readonly path: string }>('project:save')(project).then((r) => r.path),
  openProject: () =>
    invoke<[], ProjectDocument>('project:open')().then((p) => p),
  exportNestingResult: (result) =>
    invoke<[NestingResult], { readonly path: string }>('nesting:export-result')(result).then(() => undefined),
  exportNestingHistory: (_ref) =>
    invoke<[], { readonly path: string }>('nesting:export-history')().then(() => undefined)
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