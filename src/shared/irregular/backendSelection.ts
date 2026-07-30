/**
 * Irregular-nesting backend selection: out-of-band, process-level worker
 * execution configuration, never part of `NestingOptions`/`NestingRequest`
 * or any persisted/canonical/history/checkpoint data.
 *
 * Design: `docs/planning/rust-irregular-backend/backend-selection-rollback.md`
 * §1-§2. Pure, no I/O, no Effect dependency, so it is importable from both
 * `src/main` and `src/workers` without pulling in Electron (§2.2).
 *
 * Backend selection is independent of `workerMode` (rectangle vs. irregular
 * algorithm shape) and, per Stage 0 ruling R2, the Rust backend claims a job
 * only when the request matches the archive-eligible Compact / Compact Short
 * Side production shape -- everything else always runs on TypeScript
 * regardless of the configured backend preference. That routing decision
 * lives at the one real call site (`nesting.worker.ts`'s
 * `computeIrregularWorkerResult`), not in this module.
 */

/** Which irregular-nesting implementation a job should run on. */
export type IrregularBackend = 'typescript' | 'rust' | 'differential'

/**
 * Out-of-band environment variable read once, at worker-thread startup,
 * before algorithm execution -- never persisted, never part of a request.
 * Mirrors the existing `MIN_PLANE_HISTORY_DIR` precedent
 * (`WorkerSupervisor.makeWorkerThread`).
 */
export const IRREGULAR_BACKEND_ENV_VAR = 'MIN_PLANE_IRREGULAR_BACKEND'

/**
 * Compiled-in default. Must stay `'typescript'` until an explicit, separate
 * promotion decision (gated by `performance-contract.md`'s thresholds) flips
 * it -- this module does not authorize that flip.
 */
export const DEFAULT_IRREGULAR_BACKEND: IrregularBackend = 'typescript'

const IRREGULAR_BACKEND_VALUES: ReadonlySet<IrregularBackend> = new Set([
  'typescript',
  'rust',
  'differential'
])

/**
 * Pure, total, no I/O. `undefined`/empty-string resolves to the compiled-in
 * default; any other unrecognized value throws -- an operator typo must
 * never silently resolve to the default, per the design doc's "fallback is
 * explicit and observable" requirement.
 */
export function parseIrregularBackend(raw: string | undefined): IrregularBackend {
  if (raw === undefined || raw === '') return DEFAULT_IRREGULAR_BACKEND
  if (IRREGULAR_BACKEND_VALUES.has(raw as IrregularBackend)) {
    return raw as IrregularBackend
  }
  throw new Error(
    `${IRREGULAR_BACKEND_ENV_VAR} must be one of 'typescript' | 'rust' | 'differential', received ${JSON.stringify(raw)}`
  )
}

/** Reads and parses `IRREGULAR_BACKEND_ENV_VAR` from a process-like env bag. */
export function readIrregularBackendFromEnv(
  env: Readonly<Record<string, string | undefined>>
): IrregularBackend {
  return parseIrregularBackend(env[IRREGULAR_BACKEND_ENV_VAR])
}
