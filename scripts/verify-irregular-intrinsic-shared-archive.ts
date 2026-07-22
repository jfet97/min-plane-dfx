import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Schema } from 'effect'

const fixtures = ['triangle-20', 'mixed-61', 'rectangles-20', 'pentagons-20'] as const
const MIXED_POCKET_SHEETLESS_HASH =
  '5a1f1ba6957031d839862709f4390727b4bc878004a1660d4ffa45393eda0d21'
const MIXED_PERIODIC_FITTED_HASH =
  '310adc648970ae24798241bbb7178bbbc6f4506b1506012392235470a6dc6d0a'
const TRIANGLE_TWO_BAND_WITNESS_HASH =
  '371db2696b65e2122b98bdb197a1d327df0c6ecbeca6ed73d2722971be52a127'

const Endpoint = Schema.Struct({
  role: Schema.String,
  sourceId: Schema.optional(Schema.String),
  sheetlessCanonicalGeometryHash: Schema.String,
  requestedSheetFit: Schema.Struct({
    selectedRotationDeg: Schema.optional(Schema.Number),
    selectedCanonicalGeometryHash: Schema.optional(Schema.String)
  })
})

const Run = Schema.Struct({
  role: Schema.String,
  sourceId: Schema.optional(Schema.String),
  status: Schema.String,
  requestedCandidateEvaluations: Schema.optional(Schema.Number),
  consumedCandidateEvaluations: Schema.optional(Schema.Number),
  endpoint: Schema.optional(Endpoint)
})

const Report = Schema.Struct({
  sourceCommit: Schema.String,
  harness: Schema.Struct({ sha256: Schema.String }),
  fixture: Schema.Struct({
    name: Schema.String,
    sha256: Schema.String,
    pieceCount: Schema.Number,
    sheet: Schema.Struct({ width: Schema.Number, height: Schema.Number })
  }),
  runtime: Schema.Struct({ node: Schema.String, v8: Schema.String }),
  limits: Schema.Struct({
    maximumDirectRuntimeMs: Schema.Number,
    maximumCatalogRuntimeMs: Schema.Number,
    maximumContinuationRuntimeMs: Schema.Number,
    maximumPeriodicRuntimeMs: Schema.Number,
    directCandidateEvaluationCaps: Schema.Struct({
      'canonical-grid': Schema.Number,
      'legacy-absolute-envelope': Schema.Number,
      'open-pocket-first': Schema.Number
    }),
    periodicContinuationCandidateEvaluations: Schema.Number,
    periodicContinuationCount: Schema.Number,
    rawSourceAudit: Schema.Boolean
  }),
  directRuns: Schema.Array(Run),
  periodicRuns: Schema.Array(Run),
  periodic: Schema.Struct({
    catalogRuntimeCoverageComplete: Schema.Boolean,
    continuationBudgetSettlementComplete: Schema.Boolean,
    selectedSourceIds: Schema.Array(Schema.String),
    omissions: Schema.Array(Schema.Unknown)
  }),
  sheetlessArchive: Schema.Array(Endpoint),
  fittedArchive: Schema.Array(Endpoint),
  fittedWinner: Schema.optional(Endpoint),
  periodicSelectionValid: Schema.Boolean,
  experimentValid: Schema.Boolean
})

const runARoot = requiredArgument('--run-a')
const runBRoot = requiredArgument('--run-b')
const outputPath = requiredArgument('--output')
const failures: string[] = []
const comparisons = []

for (const fixture of fixtures) {
  const first = await readReport(runARoot, fixture)
  const second = await readReport(runBRoot, fixture)
  requireEqual(first.sourceCommit, second.sourceCommit, fixture, 'source commit')
  requireEqual(first.harness, second.harness, fixture, 'harness hash')
  requireEqual(first.fixture, second.fixture, fixture, 'fixture provenance')
  requireEqual(first.runtime, second.runtime, fixture, 'runtime provenance')
  requireEqual(first.limits, second.limits, fixture, 'fixed matrix limits')
  requireGate(first.experimentValid, fixture, 'run A experiment validity')
  requireGate(second.experimentValid, fixture, 'run B experiment validity')
  requireGate(first.periodicSelectionValid, fixture, 'run A periodic selection validity')
  requireGate(second.periodicSelectionValid, fixture, 'run B periodic selection validity')
  requireGate(
    first.periodic.catalogRuntimeCoverageComplete &&
      second.periodic.catalogRuntimeCoverageComplete,
    fixture,
    'periodic catalog runtime coverage'
  )
  requireGate(first.directRuns.length === 3 && second.directRuns.length === 3, fixture, 'three direct runs')
  requireGate(
    directRunsCompleteAtCaps(first.directRuns) && directRunsCompleteAtCaps(second.directRuns),
    fixture,
    'direct completion at exact calibrated caps'
  )
  requireGate(
    periodicRunsSettled(first.periodicRuns) && periodicRunsSettled(second.periodicRuns),
    fixture,
    'eight completed or evaluation-capped periodic runs'
  )
  requireGate(
    first.periodic.continuationBudgetSettlementComplete &&
      second.periodic.continuationBudgetSettlementComplete,
    fixture,
    'periodic continuation budget settlement'
  )
  requireGate(
    first.periodic.selectedSourceIds.length === 8 &&
      second.periodic.selectedSourceIds.length === 8,
    fixture,
    'exactly eight selected periodic sources'
  )

  const firstTuple = reportTuple(first)
  const secondTuple = reportTuple(second)
  requireEqual(firstTuple, secondTuple, fixture, 'status/evaluation/hash and archive order')
  requireEqual(
    first.periodic.selectedSourceIds,
    second.periodic.selectedSourceIds,
    fixture,
    'periodic source order'
  )
  requireEqual(first.periodic.omissions, second.periodic.omissions, fixture, 'periodic omissions')

  if (fixture === 'triangle-20') {
    requireGate(
      first.fittedArchive.some(
        ({ sheetlessCanonicalGeometryHash }) =>
          sheetlessCanonicalGeometryHash === TRIANGLE_TWO_BAND_WITNESS_HASH
      ),
      fixture,
      '74,428 two-band witness remains archive-resident'
    )
  }
  if (fixture === 'mixed-61') {
    requireGate(
      first.directRuns.some(
        ({ role, endpoint }) =>
          role === 'open-pocket-first' &&
          endpoint?.sheetlessCanonicalGeometryHash === MIXED_POCKET_SHEETLESS_HASH
      ),
      fixture,
      '405,773 pocket-first sheetless reference'
    )
    requireGate(
      first.periodicRuns.some(
        ({ endpoint }) =>
          endpoint?.requestedSheetFit.selectedCanonicalGeometryHash ===
          MIXED_PERIODIC_FITTED_HASH
      ),
      fixture,
      '426,530 periodic fitted reference'
    )
  }

  comparisons.push({
    fixture,
    passed: !failures.some((failure) => failure.startsWith(`${fixture}:`)),
    fittedWinner: first.fittedWinner,
    selectedPeriodicSourceIds: first.periodic.selectedSourceIds,
    sheetlessArchiveOrder: first.sheetlessArchive.map(
      ({ sheetlessCanonicalGeometryHash }) => sheetlessCanonicalGeometryHash
    ),
    fittedArchiveOrder: first.fittedArchive.map(
      ({ sheetlessCanonicalGeometryHash }) => sheetlessCanonicalGeometryHash
    )
  })
}

const verification = {
  experiment: 'intrinsic-shared-archive-step4-repeatability',
  runARoot,
  runBRoot,
  passed: failures.length === 0,
  failures,
  comparisons
}
await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, `${JSON.stringify(verification, null, 2)}\n`)
if (failures.length > 0) {
  throw new Error(`shared archive verification failed:\n${failures.join('\n')}`)
}
console.log(JSON.stringify({ outputPath, passed: true }))

async function readReport(root: string, fixture: (typeof fixtures)[number]) {
  const path = join(root, fixture, 'report.json')
  const bytes = await readFile(path)
  return Schema.decodeUnknownSync(Report)(JSON.parse(bytes.toString('utf8')))
}

function reportTuple(report: typeof Report.Type) {
  const runTuple = (run: (typeof Report.Type)['directRuns'][number]) => ({
    role: run.role,
    sourceId: run.sourceId,
    status: run.status,
    requestedCandidateEvaluations: run.requestedCandidateEvaluations,
    consumedCandidateEvaluations: run.consumedCandidateEvaluations,
    sheetlessCanonicalGeometryHash: run.endpoint?.sheetlessCanonicalGeometryHash,
    selectedRotationDeg: run.endpoint?.requestedSheetFit.selectedRotationDeg,
    selectedCanonicalGeometryHash:
      run.endpoint?.requestedSheetFit.selectedCanonicalGeometryHash
  })
  return {
    directRuns: report.directRuns.map(runTuple),
    periodicRuns: report.periodicRuns.map(runTuple),
    sheetlessArchive: report.sheetlessArchive.map(
      ({ sheetlessCanonicalGeometryHash }) => sheetlessCanonicalGeometryHash
    ),
    fittedArchive: report.fittedArchive.map(
      ({ sheetlessCanonicalGeometryHash }) => sheetlessCanonicalGeometryHash
    )
  }
}

function directRunsCompleteAtCaps(runs: (typeof Report.Type)['directRuns']): boolean {
  return runs.every(
    ({ status, requestedCandidateEvaluations, consumedCandidateEvaluations }) =>
      status === 'completed' &&
      requestedCandidateEvaluations !== undefined &&
      requestedCandidateEvaluations === consumedCandidateEvaluations
  )
}

function periodicRunsSettled(runs: (typeof Report.Type)['periodicRuns']): boolean {
  return (
    runs.length === 8 &&
    runs.every(({ status }) => status === 'completed' || status === 'evaluation-cap')
  )
}

function requireGate(value: boolean, fixture: string, gate: string): void {
  if (!value) failures.push(`${fixture}: ${gate} failed`)
}

function requireEqual(first: unknown, second: unknown, fixture: string, gate: string): void {
  if (JSON.stringify(first) !== JSON.stringify(second)) {
    failures.push(`${fixture}: ${gate} differed`)
  }
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}

function requiredArgument(name: string): string {
  const value = argument(name)
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`)
  return value
}
