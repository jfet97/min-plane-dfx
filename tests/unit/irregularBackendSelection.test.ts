import { describe, expect, it } from 'vitest'
import {
  DEFAULT_IRREGULAR_BACKEND,
  IRREGULAR_BACKEND_ENV_VAR,
  parseIrregularBackend,
  readIrregularBackendFromEnv
} from '@shared/irregular/backendSelection.js'

describe('parseIrregularBackend', () => {
  it('resolves undefined to the compiled-in default', () => {
    expect(parseIrregularBackend(undefined)).toBe('typescript')
    expect(parseIrregularBackend(undefined)).toBe(DEFAULT_IRREGULAR_BACKEND)
  })

  it('resolves an empty string to the compiled-in default', () => {
    expect(parseIrregularBackend('')).toBe(DEFAULT_IRREGULAR_BACKEND)
  })

  it('accepts every documented backend value', () => {
    expect(parseIrregularBackend('typescript')).toBe('typescript')
    expect(parseIrregularBackend('rust')).toBe('rust')
    expect(parseIrregularBackend('differential')).toBe('differential')
  })

  it('throws on an unrecognized value instead of silently defaulting', () => {
    expect(() => parseIrregularBackend('rustt')).toThrow(/typescript.*rust.*differential/)
    expect(() => parseIrregularBackend('Rust')).toThrow()
    expect(() => parseIrregularBackend(' rust')).toThrow()
  })
})

describe('readIrregularBackendFromEnv', () => {
  it('reads the documented env var name', () => {
    expect(IRREGULAR_BACKEND_ENV_VAR).toBe('MIN_PLANE_IRREGULAR_BACKEND')
    expect(readIrregularBackendFromEnv({ [IRREGULAR_BACKEND_ENV_VAR]: 'rust' })).toBe('rust')
  })

  it('defaults when the env var is absent from the bag', () => {
    expect(readIrregularBackendFromEnv({})).toBe(DEFAULT_IRREGULAR_BACKEND)
  })

  it('ignores unrelated env vars', () => {
    expect(readIrregularBackendFromEnv({ PATH: '/usr/bin', HOME: '/root' })).toBe(
      DEFAULT_IRREGULAR_BACKEND
    )
  })
})
