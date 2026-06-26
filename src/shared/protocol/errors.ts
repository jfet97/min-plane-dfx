/**
 * Canonical, serializable error code list used at every IPC and worker
 * boundary. The plan forbids raw `Error` objects across boundaries; handlers
 * always convert to one of these codes plus a human-readable message.
 */
export const AppErrorCode = [
  'validation_error',
  'file_not_found',
  'file_read_error',
  'dxf_parse_error',
  'unsupported_dxf_entity',
  'project_read_error',
  'project_write_error',
  'export_error',
  'worker_crashed',
  'worker_timeout',
  'worker_cancelled',
  'worker_protocol_error',
  'algorithm_not_implemented',
  'unknown_error'
] as const
export type AppErrorCode = (typeof AppErrorCode)[number]

export interface SerializedAppError {
  readonly code: AppErrorCode
  readonly message: string
  /** Optional, code-specific context. Never contains Functions or Buffers. */
  readonly context?: Readonly<Record<string, unknown>>
}

export const SerializedAppError = {
  is(value: unknown): value is SerializedAppError {
    if (typeof value !== 'object' || value === null) return false
    const v = value as Record<string, unknown>
    return typeof v['code'] === 'string' && typeof v['message'] === 'string'
  }
}
