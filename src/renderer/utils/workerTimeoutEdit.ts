import type { NestingOptions } from '@shared/domain/nesting.js'
import { workerTimeoutForMode } from '@shared/irregular/defaults.js'

/** Applies the renderer's generic and worker-specific timeout floors to one edit. */
export function workerTimeoutForEdit(
  workerMode: NestingOptions['workerMode'],
  timeoutMs: number
): number {
  const finiteTimeoutMs = Number.isFinite(timeoutMs) ? timeoutMs : 1_000
  return workerTimeoutForMode(workerMode, Math.max(1_000, finiteTimeoutMs))
}

/** Normalizes timeout-bearing patches used by local settings models. */
export function normalizeWorkerTimeoutPatch(
  current: Pick<NestingOptions, 'workerMode' | 'timeoutMs'>,
  patch: Partial<NestingOptions>
): Partial<NestingOptions> {
  if (patch.timeoutMs === undefined && patch.workerMode === undefined) return patch
  const workerMode = patch.workerMode ?? current.workerMode
  return {
    ...patch,
    timeoutMs: workerTimeoutForEdit(workerMode, patch.timeoutMs ?? current.timeoutMs)
  }
}
