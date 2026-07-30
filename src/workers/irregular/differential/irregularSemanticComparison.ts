import type { WorkerResponseFailureError } from '@shared/protocol/worker.js'
import type { IrregularComputeResult } from '../../algorithm/irregular/computeIrregularNesting.js'

/** Non-semantic measurements whose presence is compared but whose values are not. */
export const IRREGULAR_DIFFERENTIAL_TIMING_FIELD_NAMES: ReadonlySet<string> = new Set([
  'runtimeMs',
  'elapsedMs',
  'preflightRuntimeMs',
  'completeArchiveRuntimeMs',
  'prefixTerminalizationMs',
  'coldSearchMs',
  'topologyMeasurementMs',
  'contactMeasurementMs',
  'serializedTraceBytes',
  'peakRssDeltaBytes'
])

const TIMING_PRESENT_MARKER = '<timing:present>'

export type IrregularDifferentialOutcome =
  | { readonly ok: true; readonly value: IrregularComputeResult }
  | { readonly ok: false; readonly error: WorkerResponseFailureError }

export interface IrregularDifferentialDivergence {
  readonly path: string
  readonly typescript: unknown
  readonly rust: unknown
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeTimingFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeTimingFields)
  if (!isPlainObject(value)) return value

  const normalized: Record<string, unknown> = {}
  for (const [key, fieldValue] of Object.entries(value)) {
    normalized[key] = IRREGULAR_DIFFERENTIAL_TIMING_FIELD_NAMES.has(key)
      ? fieldValue === undefined
        ? undefined
        : TIMING_PRESENT_MARKER
      : normalizeTimingFields(fieldValue)
  }
  return normalized
}

/**
 * Projects the complete semantic outcome to plain JSON data. BigInt values remain
 * exact decimal strings. Only documented timing and process-memory measurements
 * are normalized, and their presence remains observable.
 */
export function projectIrregularDifferentialOutcome(
  outcome: IrregularDifferentialOutcome
): unknown {
  const json = JSON.stringify(outcome, (_key, value: unknown) =>
    typeof value === 'bigint' ? value.toString() : value
  )
  return normalizeTimingFields(JSON.parse(json) as unknown)
}

/** Returns the first deterministic divergence, preserving array order. */
export function firstIrregularDifferentialDivergence(
  path: string,
  typescript: unknown,
  rust: unknown
): IrregularDifferentialDivergence | undefined {
  if (Object.is(typescript, rust)) return undefined

  if (Array.isArray(typescript) && Array.isArray(rust)) {
    if (typescript.length !== rust.length) {
      return { path: `${path}.length`, typescript: typescript.length, rust: rust.length }
    }
    for (let index = 0; index < typescript.length; index += 1) {
      const divergence = firstIrregularDifferentialDivergence(
        `${path}[${index}]`,
        typescript[index],
        rust[index]
      )
      if (divergence !== undefined) return divergence
    }
    return undefined
  }

  if (isPlainObject(typescript) && isPlainObject(rust)) {
    const keys = [...new Set([...Object.keys(typescript), ...Object.keys(rust)])].toSorted(
      (first, second) => (first < second ? -1 : first > second ? 1 : 0)
    )
    for (const key of keys) {
      const divergence = firstIrregularDifferentialDivergence(
        path === '' ? key : `${path}.${key}`,
        typescript[key],
        rust[key]
      )
      if (divergence !== undefined) return divergence
    }
    return undefined
  }

  return {
    path: path === '' ? '(root)' : path,
    typescript,
    rust
  }
}

export function compareIrregularDifferentialOutcomes(
  typescript: IrregularDifferentialOutcome,
  rust: IrregularDifferentialOutcome
): IrregularDifferentialDivergence | undefined {
  return firstIrregularDifferentialDivergence(
    '',
    projectIrregularDifferentialOutcome(typescript),
    projectIrregularDifferentialOutcome(rust)
  )
}

export function boundedIrregularDifferentialValue(value: unknown, maximumLength = 512): string {
  const serialized = JSON.stringify(value)
  const text = serialized === undefined ? String(value) : serialized
  if (text.length <= maximumLength) return text
  return `${text.slice(0, maximumLength)}<truncated:${text.length - maximumLength}>`
}
