import type { ImportedDxfDocument } from '../domain/dxf.js'
import {
  NestingResult,
  NestingRequest,
  NestingHistoryFrame,
  NestingHistorySummary,
  ProjectHistoryRef
} from '../domain/nesting.js'
import { ProjectDocument, WorkspaceProjectSettings } from '../domain/project.js'
import type { JobId, PieceId, SourceFileId } from '../domain/ids.js'
import type { SerializedAppError } from './errors.js'

export type Unsubscribe = () => void

/**
 * A history event emitted by the worker over the wire. Shape-compatible
 * with the variant entries of WorkerResponse that carry `history_frame` or
 * `history_complete`. We expose it here so renderer/main code can name the
 * concept without reaching into worker protocol internals.
 */
export type NestingHistoryEvent =
  | {
      readonly type: 'history_frame'
      readonly requestId: string
      readonly jobId: JobId
      readonly payload: NestingHistoryFrame
    }
  | {
      readonly type: 'history_complete'
      readonly requestId: string
      readonly jobId: JobId
      readonly payload: NestingHistorySummary
    }

/**
 * The renderer-only API exposed via contextBridge. The signature is the
 * single source of truth used by:
 *   - src/preload/index.ts (real implementations)
 *   - src/renderer/types/global.d.ts (window.appApi typing)
 *   - tests/unit/appApiContract.test.ts (drift guard)
 */
export interface AppApi {
  readonly ping: () => Promise<{ readonly at: string }>
  readonly onPong: (callback: (at: string) => void) => Unsubscribe

  // Phase 3
  readonly listImportedDxfs: () => Promise<ReadonlyArray<ImportedDxfDocument>>
  readonly selectDxfFiles: () => Promise<ReadonlyArray<ImportedDxfDocument>>
  readonly importDxfFiles: (
    paths: ReadonlyArray<string>
  ) => Promise<ReadonlyArray<ImportedDxfDocument>>
  readonly persistSourceDocument: (document: ImportedDxfDocument) => Promise<ImportedDxfDocument>
  readonly removeImportedDxf: (pieceId: PieceId) => Promise<void>
  readonly clearImportedDxfs: () => Promise<void>

  // Phase 4
  readonly exportNestingRequest: (request: NestingRequest) => Promise<void>

  // Phase 5
  readonly runNesting: (request: NestingRequest) => Promise<NestingResult>
  readonly cancelJob: (jobId: JobId) => Promise<void>
  readonly onNestingHistory: (callback: (event: HistoryEventEnvelope) => void) => Unsubscribe
  readonly loadHistoryReplay: (
    ref: ProjectHistoryRef
  ) => Promise<ReadonlyArray<NestingHistoryFrame>>

  // Phase 8
  readonly loadWorkspaceSettings: () => Promise<WorkspaceProjectSettings | null>
  readonly saveWorkspaceSettings: (settings: WorkspaceProjectSettings) => void
  readonly saveProject: (project: ProjectDocument) => Promise<string>
  readonly openProject: () => Promise<ProjectDocument>
  readonly exportNestingResult: (result: NestingResult) => Promise<void>
  readonly exportNestingHistory: (ref: ProjectHistoryRef) => Promise<void>
}

export type HistoryEventEnvelope = NestingHistoryEvent

/**
 * Cross-reference of id brands used in the API surface. This is a typed
 * documentation of where each brand flows; the actual types live in
 * src/shared/domain/ids.ts and are imported above.
 */
export type AppApiIdContract = {
  readonly jobId: JobId
  readonly sourceFileId: SourceFileId
  readonly pieceId: PieceId
}

/** Typed result envelope used internally by handlers before serializing. */
export type IpcOkShape<T> = { readonly ok: true; readonly value: T }
export type IpcErrShape = { readonly ok: false; readonly error: SerializedAppError }
export type IpcResult<T> = IpcOkShape<T> | IpcErrShape
