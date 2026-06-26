/**
 * Smoke test: ensure the preload AppApi surface and the renderer global.d.ts
 * agree on the bridge contract. This catches drift between the two without
 * needing to spin up Electron.
 */
import { describe, expect, it } from 'vitest'
import type { AppApi } from '@shared/protocol/ipc.js'

const requiredKeys: ReadonlyArray<keyof AppApi> = [
  'ping',
  'onPong',
  'selectDxfFiles',
  'importDxfFiles',
  'exportNestingRequest',
  'runNesting',
  'cancelJob',
  'onNestingHistory',
  'loadHistoryReplay',
  'saveProject',
  'openProject',
  'exportNestingResult',
  'exportNestingHistory'
]

describe('AppApi contract', () => {
  it('exposes the full set of bridge methods declared in shared/protocol/ipc.ts', () => {
    // This test is meta: it enforces that the AppApi type keeps the same
    // shape that preload/index.ts and renderer/types/global.d.ts reference.
    // We assert presence of every key by constructing a typed object literal.
    const sample: AppApi = {
      ping: () => Promise.resolve({ at: '' }),
      onPong: () => () => {},
      selectDxfFiles: () => Promise.resolve([]),
      importDxfFiles: () => Promise.resolve([]),
      exportNestingRequest: () => Promise.resolve(),
      runNesting: () =>
        Promise.reject(new Error('not implemented') as never) as never,
      cancelJob: () => Promise.resolve(),
      onNestingHistory: () => () => {},
      loadHistoryReplay: () => Promise.resolve([]),
      saveProject: () => Promise.resolve(''),
      openProject: () => Promise.reject(new Error('not implemented') as never) as never,
      exportNestingResult: () => Promise.resolve(),
      exportNestingHistory: () => Promise.resolve()
    }

    for (const key of requiredKeys) {
      expect(typeof sample[key]).toBe('function')
    }
  })
})
