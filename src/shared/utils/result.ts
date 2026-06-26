import type { SerializedAppError, AppErrorCode } from '../protocol/errors.js'

export const ok = <T>(value: T): { readonly ok: true; readonly value: T } => ({ ok: true, value })

export const err = (
  code: AppErrorCode,
  message: string,
  context?: Readonly<Record<string, unknown>>
): { readonly ok: false; readonly error: SerializedAppError } => {
  const error: SerializedAppError =
    context === undefined
      ? { code, message }
      : { code, message, context }
  return { ok: false, error }
}

export function fromUnknown(
  unknown: unknown,
  fallbackCode: AppErrorCode = 'unknown_error'
): { readonly ok: false; readonly error: SerializedAppError } {
  if (unknown && typeof unknown === 'object' && 'code' in unknown && 'message' in unknown) {
    const maybe = unknown as Record<string, unknown>
    if (typeof maybe['code'] === 'string' && typeof maybe['message'] === 'string') {
      const code = maybe['code'] as AppErrorCode
      const message = maybe['message'] as string
      const hasContext =
        'context' in maybe && maybe['context'] && typeof maybe['context'] === 'object'
      if (hasContext) {
        return {
          ok: false,
          error: {
            code,
            message,
            context: maybe['context'] as Record<string, unknown>
          }
        }
      }
      return { ok: false, error: { code, message } }
    }
  }
  if (unknown instanceof Error) {
    return err(fallbackCode, unknown.message, { name: unknown.name })
  }
  return err(fallbackCode, typeof unknown === 'string' ? unknown : 'Unknown error')
}

export const isOk = <T>(
  r: { ok: true; value: T } | { ok: false; error: SerializedAppError }
): r is { ok: true; value: T } => r.ok

export const isErr = <T>(
  r: { ok: true; value: T } | { ok: false; error: SerializedAppError }
): r is { ok: false; error: SerializedAppError } => !r.ok
