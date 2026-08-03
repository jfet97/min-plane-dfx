#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { intrinsicSharedArchiveEligibility } from '@shared/irregular/executionMode.js'
import { GeometrySettings } from '../../src/workers/irregular/geometryKernel.js'
import { probeNativeIrregularAddon } from '../../src/workers/irregular/native/loadNativeBackend.js'
import { projectIrregularDifferentialOutcome } from '../../src/workers/irregular/differential/irregularSemanticComparison.js'
import {
  loadDifferentialRequest,
  parseDifferentialArgs,
  runRustBackend,
  runToOutcome,
  runTypeScriptBackend
} from './run-differential.js'

export interface ProjectionDivergence {
  readonly path: string
  readonly typescript: unknown
  readonly rust: unknown
}

export interface ProjectionDivergenceAudit {
  readonly divergences: ReadonlyArray<ProjectionDivergence>
  readonly acceptedDivergences: ReadonlyArray<ProjectionDivergence>
  readonly unexpectedDivergences: ReadonlyArray<ProjectionDivergence>
  readonly missingAcceptedPaths: ReadonlyArray<string>
  readonly exactAfterMask: boolean
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function collectProjectionDivergences(
  path: string,
  typescript: unknown,
  rust: unknown,
  output: ProjectionDivergence[]
): void {
  if (Object.is(typescript, rust)) return

  if (Array.isArray(typescript) && Array.isArray(rust)) {
    if (typescript.length !== rust.length) {
      output.push({ path: `${path}.length`, typescript: typescript.length, rust: rust.length })
    }
    const sharedLength = Math.min(typescript.length, rust.length)
    for (let index = 0; index < sharedLength; index += 1) {
      collectProjectionDivergences(`${path}[${index}]`, typescript[index], rust[index], output)
    }
    return
  }

  if (isPlainObject(typescript) && isPlainObject(rust)) {
    const keys = [...new Set([...Object.keys(typescript), ...Object.keys(rust)])].toSorted(
      (first, second) => (first < second ? -1 : first > second ? 1 : 0)
    )
    for (const key of keys) {
      collectProjectionDivergences(
        path === '' ? key : `${path}.${key}`,
        typescript[key],
        rust[key],
        output
      )
    }
    return
  }

  output.push({ path: path === '' ? '(root)' : path, typescript, rust })
}

function divergenceMatches(actual: ProjectionDivergence, accepted: ProjectionDivergence): boolean {
  return (
    actual.path === accepted.path &&
    Object.is(actual.typescript, accepted.typescript) &&
    Object.is(actual.rust, accepted.rust)
  )
}

function formatDivergenceValue(value: unknown): string {
  const serialized = JSON.stringify(value)
  return serialized === undefined ? String(value) : serialized
}

function assertUniqueAcceptedDivergences(accepted: ReadonlyArray<ProjectionDivergence>): void {
  for (let index = 0; index < accepted.length; index += 1) {
    const candidate = accepted[index]
    if (candidate === undefined) continue
    if (accepted.slice(0, index).some((previous) => divergenceMatches(previous, candidate))) {
      throw new Error(
        `Duplicate accepted divergence definition: ${candidate.path} ` +
          `(typescript=${formatDivergenceValue(candidate.typescript)}, ` +
          `rust=${formatDivergenceValue(candidate.rust)})`
      )
    }
  }
}

export function auditProjectionDivergences(
  typescript: unknown,
  rust: unknown,
  accepted: ReadonlyArray<ProjectionDivergence>
): ProjectionDivergenceAudit {
  assertUniqueAcceptedDivergences(accepted)
  const divergences: ProjectionDivergence[] = []
  collectProjectionDivergences('', typescript, rust, divergences)
  const acceptedDivergences = divergences.filter((divergence) =>
    accepted.some((candidate) => divergenceMatches(divergence, candidate))
  )
  const unexpectedDivergences = divergences.filter(
    (divergence) => !accepted.some((candidate) => divergenceMatches(divergence, candidate))
  )
  const missingAcceptedPaths = accepted
    .filter(
      (candidate) =>
        !acceptedDivergences.some((divergence) => divergenceMatches(divergence, candidate))
    )
    .map((candidate) => candidate.path)

  return {
    divergences,
    acceptedDivergences,
    unexpectedDivergences,
    missingAcceptedPaths,
    exactAfterMask: unexpectedDivergences.length === 0
  }
}

interface EvidenceRow {
  readonly label: string
  readonly args: ReadonlyArray<string>
  readonly acceptedDivergences: ReadonlyArray<ProjectionDivergence>
}

function acceptedSliverMetricDivergences(
  typescript: number,
  rust: number
): ReadonlyArray<ProjectionDivergence> {
  return [
    {
      path: 'value.portfolio.score.freeMaterialSliverMetric',
      typescript,
      rust
    },
    { path: 'value.score.freeMaterialSliverMetric', typescript, rust }
  ]
}

const NO_ACCEPTED_DIVERGENCES: ReadonlyArray<ProjectionDivergence> = []

const REQUIRED_ROWS: ReadonlyArray<EvidenceRow> = [
  {
    label: 'mixed61 pieces=2 profile=compact',
    args: ['--fixture', 'mixed61', '--pieces', '2', '--profile', 'compact'],
    acceptedDivergences: NO_ACCEPTED_DIVERGENCES
  },
  {
    label: 'mixed61 pieces=2 profile=short-side',
    args: ['--fixture', 'mixed61', '--pieces', '2', '--profile', 'short-side'],
    acceptedDivergences: NO_ACCEPTED_DIVERGENCES
  },
  {
    label: 'mixed61 pieces=4 profile=compact',
    args: ['--fixture', 'mixed61', '--pieces', '4', '--profile', 'compact'],
    acceptedDivergences: NO_ACCEPTED_DIVERGENCES
  },
  {
    label: 'mixed61 pieces=4 profile=short-side',
    args: ['--fixture', 'mixed61', '--pieces', '4', '--profile', 'short-side'],
    acceptedDivergences: NO_ACCEPTED_DIVERGENCES
  },
  {
    label: 'mixed61 pieces=8 profile=compact',
    args: ['--fixture', 'mixed61', '--pieces', '8', '--profile', 'compact'],
    acceptedDivergences: NO_ACCEPTED_DIVERGENCES
  },
  {
    label: 'mixed61 pieces=8 profile=short-side',
    args: ['--fixture', 'mixed61', '--pieces', '8', '--profile', 'short-side'],
    acceptedDivergences: NO_ACCEPTED_DIVERGENCES
  },
  {
    label: 'triangle-20 sheet=2000x2700 profile=compact',
    args: ['--fixture', 'triangle-20', '--sheet', '2000x2700'],
    acceptedDivergences: NO_ACCEPTED_DIVERGENCES
  },
  {
    label: 'triangle-20 sheet=2000x2700 profile=short-side',
    args: ['--fixture', 'triangle-20', '--sheet', '2000x2700', '--profile', 'short-side'],
    acceptedDivergences: NO_ACCEPTED_DIVERGENCES
  },
  {
    label: 'shapes-17 sheet=2000x2700 profile=compact',
    args: ['--fixture', 'shapes-17', '--sheet', '2000x2700'],
    acceptedDivergences: NO_ACCEPTED_DIVERGENCES
  },
  {
    label: 'shapes-17 sheet=2000x2700 profile=short-side',
    args: ['--fixture', 'shapes-17', '--sheet', '2000x2700', '--profile', 'short-side'],
    acceptedDivergences: acceptedSliverMetricDivergences(222.54854651458191, 222.54854651458194)
  },
  {
    label: 'mixed61 sheet=600x400 profile=compact',
    args: ['--fixture', 'mixed61', '--sheet', '600x400'],
    acceptedDivergences: NO_ACCEPTED_DIVERGENCES
  },
  {
    label: 'mixed61 sheet=600x400 profile=short-side',
    args: ['--fixture', 'mixed61', '--sheet', '600x400', '--profile', 'short-side'],
    acceptedDivergences: NO_ACCEPTED_DIVERGENCES
  },
  {
    label: 'mixed61 sheet=300x300 profile=compact',
    args: ['--fixture', 'mixed61', '--sheet', '300x300'],
    acceptedDivergences: NO_ACCEPTED_DIVERGENCES
  },
  {
    label: 'mixed61 sheet=300x300 profile=short-side',
    args: ['--fixture', 'mixed61', '--sheet', '300x300', '--profile', 'short-side'],
    acceptedDivergences: NO_ACCEPTED_DIVERGENCES
  },
  {
    label: 'mixed61 sheet=2000x2700 profile=compact',
    args: ['--fixture', 'mixed61', '--sheet', '2000x2700'],
    acceptedDivergences: acceptedSliverMetricDivergences(11301451.399040371, 11301451.399040373)
  },
  {
    label: 'mixed61 sheet=2000x2700 profile=short-side',
    args: ['--fixture', 'mixed61', '--sheet', '2000x2700', '--profile', 'short-side'],
    acceptedDivergences: acceptedSliverMetricDivergences(313539.85657207255, 313539.8565720725)
  }
]

function parseOutputPath(argv: ReadonlyArray<string>): string {
  const outputIndex = argv.indexOf('--output')
  if (outputIndex < 0) {
    throw new Error('Missing required --output <path> argument')
  }
  const output = argv[outputIndex + 1]
  if (output === undefined || output.startsWith('--')) {
    throw new Error('Missing path after --output')
  }
  if (argv.length !== 2) {
    throw new Error(
      `Unrecognized arguments: ${argv.filter((_, index) => index !== outputIndex && index !== outputIndex + 1).join(' ')}`
    )
  }
  return resolve(output)
}

async function main(): Promise<void> {
  const outputPath = parseOutputPath(process.argv.slice(2))
  const startedAt = new Date().toISOString()
  const probe = probeNativeIrregularAddon()
  if (!probe.available) {
    throw new Error(`Native addon unavailable: ${probe.reason}: ${probe.detail}`)
  }

  const rows = []
  for (const row of REQUIRED_ROWS) {
    process.stdout.write(`[baseline-divergence-evidence] ${row.label} ... `)
    const rowStartedAt = Date.now()
    const args = parseDifferentialArgs(row.args)
    const request = await loadDifferentialRequest(args)
    const geometrySettings = request.options.irregularSettings ?? GeometrySettings.Make
    const eligibility = intrinsicSharedArchiveEligibility(geometrySettings.optimizer)
    if (!eligibility.eligible) {
      throw new Error(`${row.label}: request is not archive-eligible: ${eligibility.reason}`)
    }

    const typescriptOutcome = await runToOutcome(runTypeScriptBackend(request, geometrySettings))
    const rustOutcome = await runToOutcome(runRustBackend(request, geometrySettings))
    const audit = auditProjectionDivergences(
      projectIrregularDifferentialOutcome(typescriptOutcome),
      projectIrregularDifferentialOutcome(rustOutcome),
      row.acceptedDivergences
    )
    const passed =
      typescriptOutcome.ok === rustOutcome.ok &&
      audit.exactAfterMask &&
      audit.missingAcceptedPaths.length === 0
    console.log(passed ? 'OK' : 'FAILED')
    rows.push({
      label: row.label,
      args: row.args,
      acceptedDivergences: row.acceptedDivergences,
      divergences: audit.divergences,
      unexpectedDivergences: audit.unexpectedDivergences,
      missingAcceptedPaths: audit.missingAcceptedPaths,
      exactAfterMask: audit.exactAfterMask,
      typescriptOutcomeKind: typescriptOutcome.ok ? 'success' : 'failure',
      rustOutcomeKind: rustOutcome.ok ? 'success' : 'failure',
      durationMs: Date.now() - rowStartedAt,
      status: passed ? 'passed' : 'failed'
    })
  }

  const divergences = rows.flatMap((row) =>
    row.divergences.map((divergence) => ({ row: row.label, ...divergence }))
  )
  const failedRows = rows.filter((row) => row.status !== 'passed')
  const evidence = {
    schemaVersion: 1,
    purpose:
      'Complete TypeScript versus accepted Rust diagnostic divergence audit for the required 16-row matrix',
    command: `pnpm exec tsx --tsconfig tsconfig.node.json scripts/rust-parity/baseline-divergence-evidence.ts --output ${outputPath}`,
    startedAt,
    endedAt: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      nativeTargetTriple: probe.targetTriple,
      nativeApiVersion: probe.nativeApiVersion,
      nativeBackendVersion: probe.backendVersion
    },
    policy: {
      comparisonRole: 'diagnostic',
      blockingExtractionOracle:
        'exact old Rust versus extracted Rust on a matching target and toolchain pair',
      acceptedRowPathValuePairs: REQUIRED_ROWS.flatMap((row) =>
        row.acceptedDivergences.map((divergence) => ({ row: row.label, ...divergence }))
      )
    },
    summary: {
      requiredRows: rows.length,
      passedRows: rows.length - failedRows.length,
      failedRows: failedRows.length,
      divergentLeaves: divergences.length,
      unexpectedDivergentLeaves: rows.reduce(
        (count, row) => count + row.unexpectedDivergences.length,
        0
      ),
      allRowsExactAfterMask: rows.every((row) => row.exactAfterMask),
      allExpectedDivergencesObserved: rows.every((row) => row.missingAcceptedPaths.length === 0)
    },
    divergences,
    rows,
    status: failedRows.length === 0 ? 'passed' : 'failed'
  }

  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`)
  console.log(
    `[baseline-divergence-evidence] ${evidence.summary.passedRows}/${evidence.summary.requiredRows} rows passed; ` +
      `${evidence.summary.divergentLeaves} accepted divergent leaves; ` +
      `${evidence.summary.unexpectedDivergentLeaves} unexpected divergent leaves`
  )
  if (failedRows.length > 0) process.exitCode = 1
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error))
    process.exitCode = 1
  })
}
