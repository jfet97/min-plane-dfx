import { describe, expect, it } from 'vitest'
import {
  C5_COMPACT_ROWS,
  C6_CAPACITY_FIXTURE_IDS,
  C7_SHORT_SIDE_ROWS,
  P5_THRESHOLDS,
  buildBackendThreadCells,
  collectThresholds,
  buildMeasurementSchedule,
  evaluateThresholds,
  filterValidSamples,
  isNearThreshold,
  makeAuthoritativeHostStatus,
  selectSuiteRows,
  summarizeSamples,
  type BenchmarkSample,
  type RustThreadSetting
} from '../../scripts/rust-parity/measure-p5-aggregate.js'

describe('P5 aggregate benchmark contract', () => {
  it('selects exactly the nine Compact rows for C5 and excludes Short Side', () => {
    const c5Rows = selectSuiteRows('C5', [...C5_COMPACT_ROWS, ...C7_SHORT_SIDE_ROWS])

    expect(c5Rows).toHaveLength(9)
    expect(c5Rows.every((row) => row.profile === 'compact')).toBe(true)
    expect(c5Rows.some((row) => row.profile === 'short-side')).toBe(false)
    expect(new Set(c5Rows.map((row) => row.id)).size).toBe(9)
  })

  it('keeps Compact Short Side as a separate C7 suite', () => {
    const c7Rows = selectSuiteRows('C7', [...C5_COMPACT_ROWS, ...C7_SHORT_SIDE_ROWS])

    expect(c7Rows).toHaveLength(9)
    expect(c7Rows.every((row) => row.profile === 'short-side')).toBe(true)
    expect(c7Rows.map((row) => row.id)).toEqual(C7_SHORT_SIDE_ROWS.map((row) => row.id))
  })

  it('preserves the eight capacity production fixtures in their maintained serial order', () => {
    expect(C6_CAPACITY_FIXTURE_IDS).toEqual([
      'capacity-area-proven-rect2',
      'capacity-singleton-proven',
      'capacity-archive-miss-squares2',
      'capacity-count-vs-material',
      'capacity-triangles20-300x300',
      'capacity-mixed61-500x400',
      'capacity-mixed61-700x500',
      'capacity-mixed61-700x560'
    ])
  })

  it('accepts only explicit TypeScript or Rust backend cells and supports all Rust thread settings', () => {
    const cells = buildBackendThreadCells()

    expect(cells.map(({ backend, rustThreads }) => `${backend}:${rustThreads}`)).toEqual([
      'typescript:default',
      'rust:1',
      'rust:2',
      'rust:default',
      'rust:8'
    ])
    expect(cells.every(({ backend }) => backend === 'typescript' || backend === 'rust')).toBe(true)

    const requested: ReadonlyArray<RustThreadSetting> = [1, 2, 'default', 8]
    expect(requested).toEqual([1, 2, 'default', 8])
  })

  it('builds one warm-up per backend and alternating measured full-suite samples per cell', () => {
    expect(buildMeasurementSchedule({ measuredSamples: 3, rustThreads: 1 })).toEqual([
      { phase: 'warmup', ordinal: 0, backend: 'typescript', rustThreads: 'default' },
      { phase: 'warmup', ordinal: 0, backend: 'rust', rustThreads: 1 },
      { phase: 'measured', ordinal: 0, backend: 'typescript', rustThreads: 'default' },
      { phase: 'measured', ordinal: 0, backend: 'rust', rustThreads: 1 },
      { phase: 'measured', ordinal: 1, backend: 'typescript', rustThreads: 'default' },
      { phase: 'measured', ordinal: 1, backend: 'rust', rustThreads: 1 },
      { phase: 'measured', ordinal: 2, backend: 'typescript', rustThreads: 'default' },
      { phase: 'measured', ordinal: 2, backend: 'rust', rustThreads: 1 }
    ])
  })

  it('reports pure median, minimum, maximum, IQR, and raw samples without deleting outliers', () => {
    expect(summarizeSamples([10, 100, 20, 30, 40])).toEqual({
      median: 30,
      minimum: 10,
      maximum: 100,
      firstQuartile: 15,
      thirdQuartile: 70,
      iqr: 55,
      rawSamples: [10, 100, 20, 30, 40]
    })
  })

  it('rejects invalid or non-executed samples before calculating ratios', () => {
    const samples: ReadonlyArray<BenchmarkSample> = [
      {
        elapsedMs: 10,
        backend: 'typescript',
        executedBackend: 'typescript',
        valid: true,
        qualityPassed: true
      },
      {
        elapsedMs: 20,
        backend: 'rust',
        executedBackend: 'typescript',
        valid: true,
        qualityPassed: true
      },
      {
        elapsedMs: 30,
        backend: 'rust',
        executedBackend: 'rust',
        valid: false,
        qualityPassed: true
      },
      {
        elapsedMs: 40,
        backend: 'rust',
        executedBackend: 'rust',
        valid: true,
        qualityPassed: false
      },
      { elapsedMs: 50, backend: 'rust', executedBackend: 'rust', valid: true, qualityPassed: true }
    ]

    expect(filterValidSamples(samples)).toEqual([samples[0], samples[4]])
  })

  it('applies C5 and C6 thresholds independently for one-thread and default Rust', () => {
    const results = evaluateThresholds({
      C5: { typescriptMs: 100, rustOneThreadMs: 75, rustDefaultMs: 61 },
      C6: { typescriptMs: 100, rustOneThreadMs: 76, rustDefaultMs: 59 }
    })

    expect(results.C5).toEqual({
      oneThreadRatio: 0.75,
      defaultThreadRatio: 0.61,
      oneThreadPassed: true,
      defaultThreadPassed: false
    })
    expect(results.C6).toEqual({
      oneThreadRatio: 0.76,
      defaultThreadRatio: 0.59,
      oneThreadPassed: false,
      defaultThreadPassed: true
    })
    expect(P5_THRESHOLDS).toEqual({ oneThread: 0.75, defaultThread: 0.6 })
  })

  it('requests five extra alternating samples when a ratio is within five percent of its threshold', () => {
    expect(isNearThreshold(0.76, 0.75)).toBe(true)
    expect(isNearThreshold(0.79, 0.75)).toBe(false)
    expect(isNearThreshold(0.57, 0.6)).toBe(true)
    expect(isNearThreshold(0.5, 0.6)).toBe(false)
  })

  it('compares every Rust thread cell against the shared TypeScript default cell', () => {
    const cell = (
      suite: 'C5' | 'C6',
      backend: 'typescript' | 'rust',
      rustThreads: RustThreadSetting,
      median: number
    ) => ({
      key: `${suite}:rust-${rustThreads}`,
      suite,
      backend,
      rustThreads,
      sampleCount: 1,
      validSampleCount: 1,
      statistics: summarizeSamples([median])
    })

    expect(
      collectThresholds(
        [
          cell('C5', 'typescript', 'default', 100),
          cell('C5', 'rust', 1, 75),
          cell('C5', 'rust', 'default', 60),
          cell('C6', 'typescript', 'default', 100),
          cell('C6', 'rust', 1, 76),
          cell('C6', 'rust', 'default', 61)
        ],
        ['C5', 'C6']
      )
    ).toEqual({
      C5: {
        oneThreadRatio: 0.75,
        defaultThreadRatio: 0.6,
        oneThreadPassed: true,
        defaultThreadPassed: true
      },
      C6: {
        oneThreadRatio: 0.76,
        defaultThreadRatio: 0.61,
        oneThreadPassed: false,
        defaultThreadPassed: false
      }
    })
  })

  it('marks local macOS and other uncontrolled hosts as non-authoritative Linux evidence', () => {
    expect(makeAuthoritativeHostStatus({ platform: 'darwin', controlledLinux: false })).toEqual({
      authoritative: false,
      status: 'blocked',
      reason: 'controlled-linux-unavailable'
    })
    expect(makeAuthoritativeHostStatus({ platform: 'linux', controlledLinux: false })).toEqual({
      authoritative: false,
      status: 'blocked',
      reason: 'controlled-linux-unavailable'
    })
    expect(makeAuthoritativeHostStatus({ platform: 'linux', controlledLinux: true })).toEqual({
      authoritative: true,
      status: 'available'
    })
  })
})
