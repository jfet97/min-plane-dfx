/**
 * Resolves and probes the `irregular-nesting-native` N-API addon through its
 * stable dependency entry point in development and packaged execution.
 */
import { createRequire } from 'node:module'
import type { WorkerCancellationReason } from '@shared/protocol/worker.js'

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
    invocationToken: string,
    onEvent: (json: string) => void,
    emitStateSnapshots: boolean
  ) => Promise<string>
  readonly cancelIrregularJob: (
    invocationToken: string,
    reason: WorkerCancellationReason
  ) => boolean
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
      /** Sanitized, actionable, single-line. Never a raw panic payload or backtrace. */
      readonly detail: string
    }

/** N-API contract version this TypeScript build was written against. */
export const EXPECTED_NATIVE_API_VERSION = 3

const NATIVE_ADDON_PACKAGE_NAME = 'irregular-nesting-native'

function packageRequire(): ReturnType<typeof createRequire> {
  return createRequire(import.meta.url)
}

function resolveAddonEntryPath(): string | undefined {
  try {
    return packageRequire().resolve(NATIVE_ADDON_PACKAGE_NAME)
  } catch {
    return undefined
  }
}

/** Sanitized, single-line description of a thrown value. Never a raw stack or backtrace. */
export function describeError(cause: unknown): string {
  if (cause instanceof Error) return cause.message
  return String(cause)
}

function notInstalledMessage(): string {
  return (
    `irregular-nesting-native: package "${NATIVE_ADDON_PACKAGE_NAME}" is not installed ` +
    `(process.platform=${process.platform}, process.arch=${process.arch}). ` +
    'Install the root dependencies from GitHub Packages or use a packaged application that includes the native addon.'
  )
}

const STAGED_ADDON_BINARY_PATTERN = /(?:^|[\\/])irregular-nesting-native\.[^\\/]+\.node(?:['"]|$)/

/** Distinguishes an optional unstaged target binary from an actionable loader failure. */
export function classifyNativeAddonLoadFailure(cause: unknown): 'not-installed' | 'load-error' {
  const visited = new Set<unknown>()
  let current = cause
  while (current !== null && typeof current === 'object' && !visited.has(current)) {
    visited.add(current)
    const error = current as {
      readonly code?: unknown
      readonly message?: unknown
      readonly cause?: unknown
    }
    if (
      error.code === 'MODULE_NOT_FOUND' &&
      typeof error.message === 'string' &&
      STAGED_ADDON_BINARY_PATTERN.test(error.message)
    ) {
      return 'not-installed'
    }
    current = error.cause
  }
  return 'load-error'
}

let cachedAddon: NativeIrregularAddon | undefined

/**
 * Loads and caches the native addon. Throws a descriptive, actionable Error if
 * the package is unavailable or its loader cannot load a target binary.
 */
export function loadNativeIrregularAddon(): NativeIrregularAddon {
  if (cachedAddon !== undefined) return cachedAddon
  if (resolveAddonEntryPath() === undefined) {
    throw new Error(notInstalledMessage())
  }
  try {
    const require = packageRequire()
    const addon = require('irregular-nesting-native') as NativeIrregularAddon
    cachedAddon = addon
    return addon
  } catch (cause) {
    throw new Error(
      `irregular-nesting-native: package entry point failed to load ` +
        `(process.platform=${process.platform}, process.arch=${process.arch}). This usually means a ` +
        `corrupt binary, a wrong-OS/arch .node file, or a missing shared-library dependency. ` +
        `Original error: ${describeError(cause)}`,
      { cause }
    )
  }
}

let cachedProbe: NativeCapabilityProbe | undefined

/**
 * Lazily-initialized, memoized capability probe. Never throws. Every failure
 * mode is captured into the `available: false` variant.
 */
export function probeNativeIrregularAddon(): NativeCapabilityProbe {
  if (cachedProbe !== undefined) return cachedProbe
  cachedProbe = computeNativeCapabilityProbe()
  return cachedProbe
}

function computeNativeCapabilityProbe(): NativeCapabilityProbe {
  if (resolveAddonEntryPath() === undefined) {
    return { available: false, reason: 'not-installed', detail: notInstalledMessage() }
  }

  let addon: NativeIrregularAddon
  try {
    addon = loadNativeIrregularAddon()
  } catch (cause) {
    return {
      available: false,
      reason: classifyNativeAddonLoadFailure(cause),
      detail: describeError(cause)
    }
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
