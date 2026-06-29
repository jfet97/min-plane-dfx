import { describe, expect, it } from 'vitest'
import { encodeIndexedGif } from '../../src/shared/utils/gifEncoder.js'

describe('run history GIF encoder', () => {
  it('writes a GIF89a animation stream', () => {
    const bytes = encodeIndexedGif(2, 2, [
      { indexes: new Uint8Array([0, 1, 2, 3]), delayCs: 8 },
      { indexes: new Uint8Array([3, 2, 1, 0]), delayCs: 8 }
    ])

    const header = String.fromCharCode(...bytes.slice(0, 6))
    expect(header).toBe('GIF89a')
    expect(bytes.at(-1)).toBe(0x3b)
  })
})
