import { afterEach, describe, expect, it } from 'vitest'
import {
  disableNfpIfpTelemetry,
  enableNfpIfpTelemetry,
  nfpIfpTelemetrySnapshot,
  recordCacheGet,
  recordCacheInstance,
  recordCacheRemove,
  recordCacheSet,
  recordCheckpoint,
  recordMemoBypass,
  recordMemoRequest,
  recordMemoRestore
} from '../../src/workers/irregular/nfpIfpTelemetry.js'

afterEach(() => {
  disableNfpIfpTelemetry()
})

describe('NFP/IFP telemetry', () => {
  it('does nothing while disabled', () => {
    recordCacheInstance()
    recordCacheGet('pairwise', true)
    recordCacheSet('pairwise')
    recordCacheRemove('pairwise')
    recordMemoBypass()
    recordMemoRequest('hit')
    recordMemoRestore(3)
    recordCheckpoint('placed-nfp', 'composed')

    expect(nfpIfpTelemetrySnapshot()).toBeUndefined()
  })

  it('resets on enable and discards state on disable', () => {
    enableNfpIfpTelemetry()
    recordCacheInstance()
    recordMemoBypass()

    enableNfpIfpTelemetry()

    expect(nfpIfpTelemetrySnapshot()).toEqual({
      cacheInstances: 0,
      namespaces: {},
      memo: {
        bypasses: 0,
        requests: 0,
        hits: 0,
        misses: 0,
        provenanceMisses: 0,
        restoreCalls: 0,
        restoredCandidates: 0
      },
      checkpoints: {
        byPhase: {},
        live: 0,
        inert: 0,
        directVoid: 0,
        composed: 0
      }
    })

    disableNfpIfpTelemetry()
    expect(nfpIfpTelemetrySnapshot()).toBeUndefined()
  })

  it('returns detached, deterministically ordered snapshots', () => {
    enableNfpIfpTelemetry()
    recordCacheInstance()
    recordCacheGet('zeta', false)
    recordCacheSet('zeta')
    recordCacheGet('alpha', true)
    recordCacheRemove('alpha')
    recordMemoRequest('hit')
    recordMemoRequest('miss')
    recordMemoRequest('provenance-miss')
    recordMemoRestore(4)
    recordCheckpoint('zeta-phase', 'composed')
    recordCheckpoint('alpha-phase', 'inert')
    recordCheckpoint('direct-phase', 'direct-void')

    const first = nfpIfpTelemetrySnapshot()
    recordCacheGet('alpha', false)
    recordCheckpoint('alpha-phase', 'inert')
    const second = nfpIfpTelemetrySnapshot()

    expect(first).toEqual({
      cacheInstances: 1,
      namespaces: {
        alpha: { getCalls: 1, getPresent: 1, setCalls: 0, removeCalls: 1 },
        zeta: { getCalls: 1, getPresent: 0, setCalls: 1, removeCalls: 0 }
      },
      memo: {
        bypasses: 0,
        requests: 3,
        hits: 1,
        misses: 1,
        provenanceMisses: 1,
        restoreCalls: 1,
        restoredCandidates: 4
      },
      checkpoints: {
        byPhase: { 'alpha-phase': 1, 'direct-phase': 1, 'zeta-phase': 1 },
        live: 2,
        inert: 1,
        directVoid: 1,
        composed: 1
      }
    })
    expect(Object.keys(first?.namespaces ?? {})).toEqual(['alpha', 'zeta'])
    expect(Object.keys(first?.checkpoints.byPhase ?? {})).toEqual([
      'alpha-phase',
      'direct-phase',
      'zeta-phase'
    ])
    expect(second?.namespaces.alpha?.getCalls).toBe(2)
    expect(second?.checkpoints.byPhase['alpha-phase']).toBe(2)
    expect(first?.namespaces.alpha?.getCalls).toBe(1)
    expect(first?.checkpoints.byPhase['alpha-phase']).toBe(1)
  })
})
