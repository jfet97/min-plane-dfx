import { describe, expect, it } from 'vitest'
import { classifyNativeAddonLoadFailure } from '../../src/workers/irregular/native/loadNativeBackend.js'

describe('native addon load failure classification', () => {
  it('classifies a missing staged target binary as optional absence', () => {
    const missingBinary = Object.assign(
      new Error(
        "Cannot find module '/app/node_modules/irregular-nesting-native/npm/irregular-nesting-native.darwin-arm64.node'"
      ),
      { code: 'MODULE_NOT_FOUND' }
    )
    const wrapped = new Error('native package entry failed', { cause: missingBinary })

    expect(classifyNativeAddonLoadFailure(wrapped)).toBe('not-installed')
  })

  it('keeps missing transitive modules and binary load failures actionable', () => {
    const missingDependency = Object.assign(
      new Error("Cannot find module 'unexpected-dependency'"),
      {
        code: 'MODULE_NOT_FOUND'
      }
    )
    const dlopenFailure = Object.assign(new Error('binary has an incompatible architecture'), {
      code: 'ERR_DLOPEN_FAILED'
    })

    expect(classifyNativeAddonLoadFailure(missingDependency)).toBe('load-error')
    expect(classifyNativeAddonLoadFailure(dlopenFailure)).toBe('load-error')
  })
})
