import { describe, expect, it } from 'vitest'
import { ok, err, fromUnknown, isOk, isErr } from '@shared/utils/result.js'

describe('result utils', () => {
  it('ok wraps a value', () => {
    const r = ok(42)
    expect(isOk(r)).toBe(true)
    if (isOk(r)) expect(r.value).toBe(42)
  })

  it('err wraps a code/message', () => {
    const r = err('validation_error', 'bad')
    expect(isErr(r)).toBe(true)
    if (isErr(r)) {
      expect(r.error.code).toBe('validation_error')
      expect(r.error.message).toBe('bad')
      expect(r.error.context).toBeUndefined()
    }
  })

  it('err with context includes it', () => {
    const r = err('worker_crashed', 'boom', { exitCode: 134 })
    if (isErr(r)) {
      expect(r.error.context).toEqual({ exitCode: 134 })
    }
  })

  it('fromUnknown extracts structured errors', () => {
    const r = fromUnknown({ code: 'dxf_parse_error', message: 'oops' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('dxf_parse_error')
  })

  it('fromUnknown falls back to unknown_error for plain Error', () => {
    const r = fromUnknown(new Error('plain'))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('unknown_error')
  })

  it('fromUnknown produces a string message for string input', () => {
    const r = fromUnknown('just a string')
    if (!r.ok) expect(r.error.message).toBe('just a string')
  })
})
