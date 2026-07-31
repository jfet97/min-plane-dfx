import { describe, expect, it } from 'vitest'
import {
  buildAggregateContainerArgs,
  classifyControlledHost,
  createSourceDiffFingerprint,
  parseWrapperArguments,
  type ControlledHostContract,
  type P5RunnerProvenance
} from '../../scripts/rust-parity/run-p5-linux-container.mjs'
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
  parseWrapperProvenanceJson,
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

  it('accepts wrapper-owned provenance and classification only as a JSON object', () => {
    const wrapperEvidence = {
      provenance: { host: { architecture: 'x86_64' } },
      classification: { authoritative: false, status: 'blocked' }
    }

    expect(parseWrapperProvenanceJson(JSON.stringify(wrapperEvidence))).toEqual(wrapperEvidence)
    expect(() => parseWrapperProvenanceJson('[]')).toThrow(
      'wrapper provenance must be a JSON object'
    )
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

const controlledHostContract: ControlledHostContract = {
  schemaVersion: 1,
  host: {
    platform: 'linux',
    kernelRelease: '6.18.38',
    architecture: 'x86_64',
    processArchitecture: 'x64',
    hardwareThreads: 16,
    memoryGiB: 125
  },
  container: {
    platform: 'linux',
    architecture: 'x86_64',
    processArchitecture: 'x64',
    imagePlatform: 'linux',
    imageArchitecture: 'amd64'
  },
  dockerDaemon: {
    operatingSystem: 'NixOS',
    name: 't3vm'
  },
  toolchain: {
    node: 'v24.18.0',
    pnpm: '11.11.0',
    rustc: '1.97.1',
    rustChannel: 'stable',
    rustTarget: 'x86_64-unknown-linux-gnu'
  }
}

const matchingRunnerProvenance: P5RunnerProvenance = {
  schemaVersion: 1,
  generatedAt: '2026-08-01T00:00:00.000Z',
  sourceHost: {
    ...controlledHostContract.host,
    cpu: 'Intel(R) Core(TM) Ultra 7 270K Plus',
    node: 'v24.18.0',
    commit: 'test-commit',
    dirty: false,
    sourceDiffFingerprintSha256: 'a'.repeat(64),
    exactCommand: 'node scripts/rust-parity/run-p5-linux-container.mjs'
  },
  host: { ...controlledHostContract.host },
  container: {
    ...controlledHostContract.container,
    kernelRelease: '6.18.38',
    hardwareThreads: 16,
    memoryGiB: 125,
    imageId: 'sha256:test',
    repoDigests: [],
    created: '2026-08-01T00:00:00Z'
  },
  toolchain: { ...controlledHostContract.toolchain },
  docker: {
    clientVersion: '28.0.0',
    serverVersion: '28.0.0',
    context: 'default',
    operatingSystem: 'NixOS',
    name: 't3vm'
  }
}

describe('P5 controlled Linux container classification', () => {
  it('consumes the pnpm argument separator instead of forwarding it to the aggregate runner', () => {
    expect(parseWrapperArguments(['--', '--dry-run', '--suite', 'C5'])).toMatchObject({
      dryRun: true,
      benchmarkArgs: ['--suite', 'C5']
    })
  })

  it('allows only an exact native x64 controlled-host contract match', () => {
    const classification = classifyControlledHost(controlledHostContract, matchingRunnerProvenance)

    expect(classification).toEqual({
      authoritative: true,
      status: 'available',
      controlledLinux: true,
      reasons: [],
      mismatches: []
    })
    expect(
      buildAggregateContainerArgs({
        classification,
        outputPath: '/output/p5-aggregate-evidence.json',
        provenancePath: '/output/p5-wrapper-provenance.json',
        benchmarkArgs: []
      })
    ).toContain('--controlled-linux')
  })

  it('blocks non-contract benchmark schedules and never forwards controlled authority', () => {
    const cases = [
      {
        benchmarkArgs: ['--suite', 'C5'],
        mismatch: { field: 'benchmark.suites', expected: ['C5', 'C6', 'C7'], actual: ['C5'] }
      },
      {
        benchmarkArgs: ['--rust-threads', '1'],
        mismatch: { field: 'benchmark.rustThreads', expected: [1, 'default'], actual: [1] }
      },
      {
        benchmarkArgs: ['--samples', '1'],
        mismatch: { field: 'benchmark.measuredSamples', expected: 3, actual: 1 }
      },
      {
        benchmarkArgs: ['--skip-warmups'],
        mismatch: { field: 'benchmark.includeWarmups', expected: true, actual: false }
      }
    ] as const

    for (const { benchmarkArgs, mismatch } of cases) {
      const classification = classifyControlledHost(
        controlledHostContract,
        matchingRunnerProvenance,
        benchmarkArgs
      )
      const aggregateArgs = buildAggregateContainerArgs({
        classification,
        outputPath: '/output/p5-aggregate-evidence.json',
        provenancePath: '/output/p5-wrapper-provenance.json',
        benchmarkArgs
      })

      expect(classification).toMatchObject({
        authoritative: false,
        status: 'blocked',
        controlledLinux: false
      })
      expect(classification.reasons).toContain('non-authoritative-benchmark-schedule')
      expect(classification.mismatches).toContainEqual(mismatch)
      expect(aggregateArgs).not.toContain('--controlled-linux')
    }
  })

  it('refuses controlled forwarding when aggregate arguments contradict classification', () => {
    const classification = classifyControlledHost(controlledHostContract, matchingRunnerProvenance)

    expect(classification.authoritative).toBe(true)
    expect(
      buildAggregateContainerArgs({
        classification,
        outputPath: '/output/p5-aggregate-evidence.json',
        provenancePath: '/output/p5-wrapper-provenance.json',
        benchmarkArgs: ['--samples', '1']
      })
    ).not.toContain('--controlled-linux')
  })

  it('creates a stable opaque fingerprint for source-tree diagnostics', () => {
    const input = {
      workingTreeDiff: 'binary diff with sensitive source text',
      cachedDiff: 'cached binary diff',
      status: ' M src/private-file.ts'
    }
    const first = createSourceDiffFingerprint(input)
    const second = createSourceDiffFingerprint(input)
    const changed = createSourceDiffFingerprint({ ...input, status: 'M  src/private-file.ts' })

    expect(first).toMatch(/^[a-f0-9]{64}$/)
    expect(second).toBe(first)
    expect(changed).not.toBe(first)
    expect(first).not.toContain(input.workingTreeDiff)
    expect(first).not.toContain(input.cachedDiff)
    expect(first).not.toContain(input.status)
  })

  it('blocks dirty and unknown source-tree state from authoritative evidence', () => {
    const cases = [
      { dirty: true, reason: 'dirty-source-tree' },
      { dirty: undefined, reason: 'unknown-source-tree-state' }
    ] as const

    for (const { dirty, reason } of cases) {
      const provenance: P5RunnerProvenance = {
        ...matchingRunnerProvenance,
        sourceHost: { ...matchingRunnerProvenance.sourceHost, dirty }
      }
      const classification = classifyControlledHost(controlledHostContract, provenance)
      const aggregateArgs = buildAggregateContainerArgs({
        classification,
        outputPath: '/output/p5-aggregate-evidence.json',
        provenancePath: '/output/p5-wrapper-provenance.json',
        benchmarkArgs: []
      })

      expect(classification).toMatchObject({
        authoritative: false,
        status: 'blocked',
        controlledLinux: false
      })
      expect(classification.reasons).toContain(reason)
      expect(classification.mismatches).toContainEqual({
        field: 'sourceHost.dirty',
        expected: false,
        actual: dirty
      })
      expect(aggregateArgs).not.toContain('--controlled-linux')
    }
  })

  it('blocks Docker Desktop on Darwin even when its Linux VM matches the contract', () => {
    const provenance: P5RunnerProvenance = {
      ...matchingRunnerProvenance,
      sourceHost: {
        ...matchingRunnerProvenance.sourceHost,
        platform: 'darwin',
        kernelRelease: '25.5.0'
      }
    }

    const classification = classifyControlledHost(controlledHostContract, provenance)

    expect(classification.authoritative).toBe(false)
    expect(classification.controlledLinux).toBe(false)
    expect(classification.mismatches).toContainEqual({
      field: 'sourceHost.platform',
      expected: 'linux',
      actual: 'darwin'
    })
  })

  it('blocks Docker Desktop on an otherwise exact Linux x64 source host', () => {
    const provenance: P5RunnerProvenance = {
      ...matchingRunnerProvenance,
      docker: {
        ...matchingRunnerProvenance.docker,
        operatingSystem: 'Docker Desktop',
        name: 'desktop-linux'
      }
    }

    const classification = classifyControlledHost(controlledHostContract, provenance)

    expect(classification.authoritative).toBe(false)
    expect(classification.controlledLinux).toBe(false)
    expect(classification.mismatches).toContainEqual({
      field: 'docker.operatingSystem',
      expected: 'NixOS',
      actual: 'Docker Desktop'
    })
    expect(classification.mismatches).toContainEqual({
      field: 'docker.name',
      expected: 't3vm',
      actual: 'desktop-linux'
    })
  })

  it('blocks local Linux arm64 without claiming controlled authority', () => {
    const provenance: P5RunnerProvenance = {
      ...matchingRunnerProvenance,
      host: {
        ...matchingRunnerProvenance.host,
        architecture: 'aarch64',
        processArchitecture: 'arm64'
      },
      container: {
        ...matchingRunnerProvenance.container,
        architecture: 'aarch64',
        processArchitecture: 'arm64',
        imageArchitecture: 'arm64'
      }
    }

    const classification = classifyControlledHost(controlledHostContract, provenance)

    expect(classification.authoritative).toBe(false)
    expect(classification.controlledLinux).toBe(false)
    expect(classification.reasons).toContain('local-linux-arm64')
  })

  it('blocks Linux amd64 containers emulated on arm64 hosts', () => {
    const provenance: P5RunnerProvenance = {
      ...matchingRunnerProvenance,
      host: {
        ...matchingRunnerProvenance.host,
        architecture: 'aarch64',
        processArchitecture: 'arm64'
      }
    }

    const classification = classifyControlledHost(controlledHostContract, provenance)
    const aggregateArgs = buildAggregateContainerArgs({
      classification,
      outputPath: '/output/p5-aggregate-evidence.json',
      provenancePath: '/output/p5-wrapper-provenance.json',
      benchmarkArgs: []
    })

    expect(classification.reasons).toContain('linux-amd64-emulated-on-arm64')
    expect(aggregateArgs).not.toContain('--controlled-linux')
  })

  it('blocks native x64 hosts when any controlled-host field mismatches', () => {
    const provenance: P5RunnerProvenance = {
      ...matchingRunnerProvenance,
      host: { ...matchingRunnerProvenance.host, hardwareThreads: 15 }
    }

    const classification = classifyControlledHost(controlledHostContract, provenance)

    expect(classification).toMatchObject({
      authoritative: false,
      status: 'blocked',
      controlledLinux: false,
      reasons: ['controlled-host-contract-mismatch']
    })
    expect(classification.mismatches).toContainEqual({
      field: 'host.hardwareThreads',
      expected: 16,
      actual: 15
    })
  })

  it('blocks containers whose runtime CPU or memory visibility differs from the host contract', () => {
    const provenance: P5RunnerProvenance = {
      ...matchingRunnerProvenance,
      container: {
        ...matchingRunnerProvenance.container,
        hardwareThreads: 8,
        memoryGiB: 64
      }
    }

    const classification = classifyControlledHost(controlledHostContract, provenance)

    expect(classification.authoritative).toBe(false)
    expect(classification.mismatches).toContainEqual({
      field: 'container.hardwareThreads',
      expected: 16,
      actual: 8
    })
    expect(classification.mismatches).toContainEqual({
      field: 'container.memoryGiB',
      expected: 125,
      actual: 64
    })
  })
})
