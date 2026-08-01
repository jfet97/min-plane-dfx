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
 * algorithm shape). Auto selects Rust only for archive-eligible Compact or
 * Compact Short Side jobs with a compatible advertised native profile. An
 * explicit Rust or differential request that is unavailable or ineligible
 * fails; TypeScript runs only when it is the selected backend. The routing
 * decision lives in the worker's irregular backend execution module, not in
 * this pure parser.
 */

/** Which irregular-nesting implementation a job should run on. */
export type IrregularBackend = 'auto' | 'typescript' | 'rust' | 'differential'

/**
 * Out-of-band environment variable read fresh for each irregular job, before
 * algorithm execution. It is never persisted and never part of a request.
 * Mirrors the existing `MIN_PLANE_HISTORY_DIR` precedent
 * (`WorkerSupervisor.makeWorkerThread`).
 */
export const IRREGULAR_BACKEND_ENV_VAR = 'MIN_PLANE_IRREGULAR_BACKEND'

/**
 * Compiled-in default. Auto owns the production promotion decision by
 * selecting only a preflight-eligible native profile; this module does not
 * inspect requests or capabilities.
 */
export const DEFAULT_IRREGULAR_BACKEND: IrregularBackend = 'auto'

const IRREGULAR_BACKEND_VALUES: ReadonlySet<IrregularBackend> = new Set([
  'auto',
  'typescript',
  'rust',
  'differential'
])

/**
 * Pure, total, no I/O. `undefined`/empty-string resolves to the compiled-in
 * auto default; any other unrecognized value throws -- an operator typo must
 * never silently resolve to the default, per the design doc's "fallback is
 * explicit and observable" requirement.
 */
export function parseIrregularBackend(raw: string | undefined): IrregularBackend {
  if (raw === undefined || raw === '') return DEFAULT_IRREGULAR_BACKEND
  if (IRREGULAR_BACKEND_VALUES.has(raw as IrregularBackend)) {
    return raw as IrregularBackend
  }
  throw new Error(
    `${IRREGULAR_BACKEND_ENV_VAR} must be one of 'auto' | 'typescript' | 'rust' | 'differential', received ${JSON.stringify(raw)}`
  )
}

/** Reads and parses `IRREGULAR_BACKEND_ENV_VAR` from a process-like env bag. */
export function readIrregularBackendFromEnv(
  env: Readonly<Record<string, string | undefined>>
): IrregularBackend {
  return parseIrregularBackend(env[IRREGULAR_BACKEND_ENV_VAR])
}
