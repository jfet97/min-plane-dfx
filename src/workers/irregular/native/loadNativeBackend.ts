/**
 * Resolves and probes the `irregular-nesting-native` N-API addon.
 *
 * Design: `docs/planning/rust-irregular-backend/backend-selection-rollback.md`
 * §3 (capability probe) and `build-packaging.md` §5/§10 (binary resolution,
 * actionable load-failure errors).
 *
 * Resolution is a direct relative path to the crate's own
 * `npm/index.cjs` (built by `crates/irregular-nesting-native/scripts/build-native.mjs`),
 * not `require('irregular-nesting-native')` package-name resolution -- the
 * root package never declares a `dependencies` entry for the native package
 * (out of this task's scope; see `build-packaging.md` §2 for the Stage-5
 * workspace-dependency design this deliberately does not implement yet).
 * `createRequire` + a runtime-computed (non-literal) path keeps this module
 * safely bundle-able by Rollup: a non-literal `require(...)` call cannot be
 * statically resolved/inlined, so it survives unchanged in a bundled ESM
 * worker output and resolves for real only at Node runtime
 * (`build-packaging.md` §4.1's documented ESM/CJS-interop sidestep).
 */
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** `lib.rs`'s `Capability` struct, camelCase per napi-rs's default object-field mapping. */
export interface NativeCapability {
  readonly apiVersion: number
  readonly crateVersion: string
  readonly targetTriple: string
  readonly profiles: ReadonlyArray<string>
}

/** The subset of the native addon's exported N-API surface this integration uses. */
export interface NativeIrregularAddon {
  readonly nativeCapability: () => NativeCapability
  readonly runIrregularJob: (
    requestJson: string,
    onPortfolioProgress: (json: string) => void,
    onStateSnapshot: ((json: string) => void) | null,
    onDecisionTraceBatch: ((json: string) => void) | null
  ) => Promise<string>
  readonly cancelIrregularJob: (jobId: string) => boolean
  readonly getLastJobDiagnostics: () => string
}

/**
 * `backend-selection-rollback.md` §3's `NativeCapabilityProbe`. Non-semantic:
 * never persisted, hashed, or compared as part of nesting-result parity.
 */
export type NativeCapabilityProbe =
  | {
      readonly available: true
      readonly nativeApiVersion: number
      readonly backendVersion: string
      readonly targetTriple: string
      readonly profiles: ReadonlyArray<string>
    }
  | {
      readonly available: false
      /** `build-packaging.md` §10's three load-failure classifications. */
      readonly reason: 'not-installed' | 'load-error' | 'version-mismatch'
      /** Sanitized, actionable, single-line -- never a raw panic payload or backtrace. */
      readonly detail: string
    }

/** N-API contract version this TypeScript build was written against. */
export const EXPECTED_NATIVE_API_VERSION = 1

function candidateAddonEntryPaths(): ReadonlyArray<string> {
  const moduleDir = dirname(fileURLToPath(import.meta.url))
  return [
    // Dev / `pnpm test`/`test:focused` / `tsx` scripts: this module runs
    // directly from `src/workers/irregular/native/`, four levels below the
    // repository root.
    join(
      moduleDir,
      '..',
      '..',
      '..',
      '..',
      'crates',
      'irregular-nesting-native',
      'npm',
      'index.cjs'
    ),
    // Bundled worker (`out/workers/nesting.worker.mjs`, `vite.worker.config.ts`):
    // this module's code is inlined there, two levels below the repository
    // root at runtime. Not exercised by any Stage-1 gate (`pnpm test`/
    // `test:focused`/`typecheck`/`lint` all run against source, per
    // `build-packaging.md` §5's dual-runtime table) -- included so the
    // resolver degrades gracefully rather than silently only working in dev.
    join(moduleDir, '..', '..', 'crates', 'irregular-nesting-native', 'npm', 'index.cjs')
  ]
}

function resolveAddonEntryPath(): {
  readonly resolved: string | undefined
  readonly candidates: ReadonlyArray<string>
} {
  const candidates = candidateAddonEntryPaths()
  return { resolved: candidates.find((candidate) => existsSync(candidate)), candidates }
}

/** Sanitized, single-line description of a thrown value -- no raw stack/backtrace. */
export function describeError(cause: unknown): string {
  if (cause instanceof Error) return cause.message
  return String(cause)
}

function notInstalledMessage(candidates: ReadonlyArray<string>): string {
  return (
    `irregular-nesting-native: no built addon entry point found ` +
    `(process.platform=${process.platform}, process.arch=${process.arch}). Tried: ${candidates.join(', ')}. ` +
    `Build it with \`node crates/irregular-nesting-native/scripts/build-native.mjs\` (dev) or the ` +
    `release build used by CI/packaging, then retry.`
  )
}

let cachedAddon: NativeIrregularAddon | undefined

/**
 * Loads (and caches) the native addon. Throws a descriptive, actionable
 * `Error` if the addon cannot be found or fails to load -- callers that need
 * a typed, non-throwing capability result should call
 * {@link probeNativeIrregularAddon} instead.
 */
export function loadNativeIrregularAddon(): NativeIrregularAddon {
  if (cachedAddon !== undefined) return cachedAddon
  const { resolved, candidates } = resolveAddonEntryPath()
  if (resolved === undefined) {
    throw new Error(notInstalledMessage(candidates))
  }
  const require = createRequire(import.meta.url)
  try {
    const addon = require(resolved) as NativeIrregularAddon
    cachedAddon = addon
    return addon
  } catch (cause) {
    throw new Error(
      `irregular-nesting-native: addon entry point exists at ${resolved} but failed to load ` +
        `(process.platform=${process.platform}, process.arch=${process.arch}). This usually means a ` +
        `corrupt binary, a wrong-OS/arch .node file, or a missing shared-library dependency. ` +
        `Original error: ${describeError(cause)}`,
      { cause }
    )
  }
}

let cachedProbe: NativeCapabilityProbe | undefined

/**
 * Lazily-initialized, memoized capability probe. Never throws -- every
 * failure mode is captured into the `available: false` variant
 * (`build-packaging.md` §10). Intended to be invoked only when a caller has
 * already decided it wants `'rust'`/`'differential'` (never on the default
 * `'typescript'` path), so the addon is never even attempted to load for a
 * pure-TypeScript production job.
 */
export function probeNativeIrregularAddon(): NativeCapabilityProbe {
  if (cachedProbe !== undefined) return cachedProbe
  cachedProbe = computeNativeCapabilityProbe()
  return cachedProbe
}

function computeNativeCapabilityProbe(): NativeCapabilityProbe {
  const { resolved, candidates } = resolveAddonEntryPath()
  if (resolved === undefined) {
    return { available: false, reason: 'not-installed', detail: notInstalledMessage(candidates) }
  }

  let addon: NativeIrregularAddon
  try {
    addon = loadNativeIrregularAddon()
  } catch (cause) {
    return { available: false, reason: 'load-error', detail: describeError(cause) }
  }

  let capability: NativeCapability
  try {
    capability = addon.nativeCapability()
  } catch (cause) {
    return {
      available: false,
      reason: 'load-error',
      detail: `irregular-nesting-native: addon loaded but nativeCapability() threw: ${describeError(cause)}`
    }
  }

  if (capability.apiVersion !== EXPECTED_NATIVE_API_VERSION) {
    return {
      available: false,
      reason: 'version-mismatch',
      detail:
        `irregular-nesting-native: addon reports apiVersion ${capability.apiVersion}, ` +
        `this TypeScript build expects ${EXPECTED_NATIVE_API_VERSION}.`
    }
  }

  return {
    available: true,
    nativeApiVersion: capability.apiVersion,
    backendVersion: capability.crateVersion,
    targetTriple: capability.targetTriple,
    profiles: capability.profiles
  }
}

/** Test-only: clears the memoized addon/probe so tests can exercise both branches. */
export function resetNativeAddonCacheForTests(): void {
  cachedAddon = undefined
  cachedProbe = undefined
}
