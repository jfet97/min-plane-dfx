#!/usr/bin/env node
/**
 * Permanent differential-harness fixture list: a fixed set of
 * `run-differential.ts` invocations (fixture/pieces/sheet/profile
 * combinations) run in sequence, each shelling out to `run-differential.ts`
 * itself (never duplicating its comparison logic), with a summary printed
 * at the end. Two rows-groups:
 *
 * - `REQUIRED_ROWS`: the acceptance-bar matrix `differential-e2e-report.md`
 *   documents as passing (2/4/8-piece mixed61 subsets both profiles, the
 *   named baselines, the full 61-piece request both profiles). A regression
 *   here blocks the gate.
 * - `EXPLORATORY_ROWS`: the mixed61 9/10/20/40-piece truncated subsets
 *   `differential-e2e-report.md` Finding N1 documents as an intermittent
 *   (now: reproducibly deterministic) periodic-P2 "raw-witness" continuation
 *   tie-break divergence, added here per that finding's own follow-up
 *   instruction ("Add the truncated subsets as permanent rows in the
 *   differential harness fixture list"). **Not required** for the
 *   acceptance bar (outside the production fixture-size matrix, per the
 *   finding's own "Does not affect the required acceptance bar" note) --
 *   tracked here so a regression or a fix is visible without re-deriving
 *   the repro commands from the report every time. See that finding's own
 *   text (and its follow-up addendum, if present) for root-cause status.
 *
 * Usage:
 *   pnpm exec tsx --tsconfig tsconfig.node.json scripts/rust-parity/differential-fixture-matrix.ts [--required-only] [--exploratory-only]
 *
 * Exit code: nonzero if any `REQUIRED_ROWS` row fails. `EXPLORATORY_ROWS`
 * failures are reported but never fail the overall exit code (matching
 * their "documented, not blocking" status) unless `--strict-exploratory` is
 * passed.
 */
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..', '..')
const RUN_DIFFERENTIAL = join(__dirname, 'run-differential.ts')

interface FixtureRow {
  readonly label: string
  readonly args: ReadonlyArray<string>
}

const PROFILES: ReadonlyArray<'compact' | 'short-side'> = ['compact', 'short-side']

function mixed61PieceRows(pieceCounts: ReadonlyArray<number>): FixtureRow[] {
  const rows: FixtureRow[] = []
  for (const pieces of pieceCounts) {
    for (const profile of PROFILES) {
      rows.push({
        label: `mixed61 pieces=${pieces} profile=${profile}`,
        args: ['--fixture', 'mixed61', '--pieces', String(pieces), '--profile', profile]
      })
    }
  }
  return rows
}

/** The acceptance-bar matrix (`differential-e2e-report.md`'s own "Reproduction" section). */
const REQUIRED_ROWS: FixtureRow[] = [
  ...mixed61PieceRows([2, 4, 8]),
  {
    label: 'triangle-20 sheet=2000x2700 profile=compact',
    args: ['--fixture', 'triangle-20', '--sheet', '2000x2700']
  },
  {
    label: 'triangle-20 sheet=2000x2700 profile=short-side',
    args: ['--fixture', 'triangle-20', '--sheet', '2000x2700', '--profile', 'short-side']
  },
  {
    label: 'shapes-17 sheet=2000x2700 profile=compact',
    args: ['--fixture', 'shapes-17', '--sheet', '2000x2700']
  },
  {
    label: 'shapes-17 sheet=2000x2700 profile=short-side',
    args: ['--fixture', 'shapes-17', '--sheet', '2000x2700', '--profile', 'short-side']
  },
  {
    label: 'mixed61 sheet=600x400 profile=compact',
    args: ['--fixture', 'mixed61', '--sheet', '600x400']
  },
  {
    label: 'mixed61 sheet=600x400 profile=short-side',
    args: ['--fixture', 'mixed61', '--sheet', '600x400', '--profile', 'short-side']
  },
  {
    label: 'mixed61 sheet=300x300 profile=compact',
    args: ['--fixture', 'mixed61', '--sheet', '300x300']
  },
  {
    label: 'mixed61 sheet=300x300 profile=short-side',
    args: ['--fixture', 'mixed61', '--sheet', '300x300', '--profile', 'short-side']
  },
  {
    label: 'mixed61 sheet=2000x2700 profile=compact',
    args: ['--fixture', 'mixed61', '--sheet', '2000x2700']
  },
  {
    label: 'mixed61 sheet=2000x2700 profile=short-side',
    args: ['--fixture', 'mixed61', '--sheet', '2000x2700', '--profile', 'short-side']
  }
]

/**
 * Finding N1's truncated subsets. `--pieces` truncation (not `--sheet`)
 * keeps the default 2000x2700 sheet, matching the report's own repro
 * command shape (`--fixture mixed61 --pieces "$n" --profile "$profile"`).
 */
const EXPLORATORY_ROWS: FixtureRow[] = mixed61PieceRows([9, 10, 20, 40])

interface RowResult {
  readonly row: FixtureRow
  readonly ok: boolean
  readonly output: string
}

function runRow(row: FixtureRow): RowResult {
  try {
    const output = execFileSync(
      'pnpm',
      ['exec', 'tsx', '--tsconfig', 'tsconfig.node.json', RUN_DIFFERENTIAL, ...row.args],
      { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    )
    return { row, ok: true, output }
  } catch (error) {
    const output =
      error !== null && typeof error === 'object' && 'stdout' in error
        ? `${String((error as { stdout?: unknown }).stdout ?? '')}${String((error as { stderr?: unknown }).stderr ?? '')}`
        : String(error)
    return { row, ok: false, output }
  }
}

function runGroup(groupLabel: string, rows: ReadonlyArray<FixtureRow>): RowResult[] {
  const results: RowResult[] = []
  for (const row of rows) {
    process.stdout.write(`[differential-fixture-matrix] ${groupLabel}: ${row.label} ... `)
    const result = runRow(row)
    console.log(result.ok ? 'OK' : 'FAILED')
    if (!result.ok) {
      console.error(
        result.output
          .split('\n')
          .filter(
            (line) =>
              line.includes('FIRST DIVERGENCE') ||
              line.includes('typescript:') ||
              line.includes('rust      :') ||
              line.includes('[run-differential] placedCollisionGeometries:') ||
              line.includes('[run-differential] score:') ||
              line.includes('[run-differential] unplacedPieceIds:') ||
              line.includes('[run-differential] sortedPieceIds:') ||
              line.includes('[run-differential] diagnostics:') ||
              line.includes('[run-differential] portfolio:') ||
              line.includes('[run-differential] runtime:') ||
              line.includes('FAILED')
          )
          .map((line) => `    ${line}`)
          .join('\n')
      )
    }
    results.push(result)
  }
  return results
}

function main(): void {
  const argv = process.argv.slice(2)
  const requiredOnly = argv.includes('--required-only')
  const exploratoryOnly = argv.includes('--exploratory-only')
  const strictExploratory = argv.includes('--strict-exploratory')

  const requiredResults = exploratoryOnly ? [] : runGroup('required', REQUIRED_ROWS)
  const exploratoryResults = requiredOnly ? [] : runGroup('exploratory (N1)', EXPLORATORY_ROWS)

  const requiredFailures = requiredResults.filter((result) => !result.ok)
  const exploratoryFailures = exploratoryResults.filter((result) => !result.ok)

  console.log(
    `[differential-fixture-matrix] required: ${requiredResults.length - requiredFailures.length}/${requiredResults.length} passed; ` +
      `exploratory (N1): ${exploratoryResults.length - exploratoryFailures.length}/${exploratoryResults.length} passed`
  )

  if (requiredFailures.length > 0) {
    console.error(
      `[differential-fixture-matrix] FAILED: ${requiredFailures.length} required row(s) diverged: ` +
        requiredFailures.map((result) => result.row.label).join(', ')
    )
    process.exit(1)
  }
  if (exploratoryFailures.length > 0) {
    console.warn(
      `[differential-fixture-matrix] ${exploratoryFailures.length} exploratory row(s) diverged (Finding N1, non-blocking): ` +
        exploratoryFailures.map((result) => result.row.label).join(', ')
    )
    if (strictExploratory) process.exit(1)
  }
}

main()
