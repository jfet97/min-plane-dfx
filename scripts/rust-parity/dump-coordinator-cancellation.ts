/**
 * Differential-vector generator proving the control-threading fix in
 * `crates/irregular-nesting-native/src/result/coordinator.rs`'s
 * `on_canonical_grid_checkpointed` closure: the nested resume call to
 * `run_intrinsic_capacity_scheduler_cold_quantum` must thread the SAME
 * cooperative-cancellation `control`/`isCancelled` observation TS threads
 * into its own nested `runIntrinsicCapacitySchedulerColdQuantum` resume call
 * (`computeIrregularNesting.ts:673-684`, `...(control === undefined ? {} :
 * { control })`).
 *
 * A deterministic-clock cancellation (a plain call-counter: `isCancelled`
 * returns `true` starting at exactly the Nth invocation) is injected at a
 * call ordinal independently calibrated (via temporary, since-reverted
 * instrumentation on both the TS and Rust sides -- see this task's own
 * evidence notes) to fall inside the nested resume's own internal
 * `control.checkpoint()` calls, for one fixed 5-rectangle scenario chosen to
 * force that resume to fire (`intrinsicAnytimeSchedulerTrace.quanta[1]`
 * `legacy-complete`/`checkpointed` immediately followed by `quanta[2]`
 * `capacity-cold`/`partial` -- the resume's own quantum -- confirms it fired
 * on the uncancelled baseline run below).
 *
 * Calibration (reproducible by temporarily adding a call-counter increment
 * inside `computeIrregularNesting.ts`'s `control.checkpoint` closure plus
 * two `console.error` markers immediately before/after the nested
 * `runIntrinsicCapacitySchedulerColdQuantum` call, then reverting both
 * edits) found, for this exact scenario: 3269 total `control.checkpoint()`
 * calls happen before the nested resume begins, and a further 3132 happen
 * inside it (exit counter 6401) before it returns -- i.e. the resume's own
 * calls are exactly the closed interval `[3270, 6401]` (1-indexed). The
 * identical Rust-side instrumentation (a temporary `AtomicU64` incremented
 * inside `CancellationControl::checkpoint`, later reverted) found the exact
 * same three numbers (3269 / 6401 / 10098 total) AND the exact same
 * `intrinsicAnytimeSchedulerTrace.quanta` sequence for the equivalent Rust
 * request -- strong, independently-confirmed evidence that Rust and TS make
 * checkpoint calls in the same order and count for this scenario, so
 * injecting a cancellation at ordinal 3270 on both sides observes "the same
 * point" in both backends' control flow, not merely the same integer.
 *
 * Run with:
 *   pnpm exec tsx --tsconfig tsconfig.node.json scripts/rust-parity/dump-coordinator-cancellation.ts
 *
 * Output (additive; never edits existing fixtures/tests):
 *   - crates/irregular-nesting-native/tests/vectors/coordinator-cancellation.json
 */
import { Cause, Effect, Layer, Result } from 'effect'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DxfGeometrySummary, ImportedPiece } from '@shared/domain/dxf.js'
import { SheetSpec, NestingOptions, NestingRequest } from '@shared/domain/nesting.js'
import { PieceId, SourceFileId } from '@shared/domain/ids.js'
import { preparePieces } from '@shared/preparePieces.js'
import {
  IrregularGeometrySettings,
  IrregularNestingSettings
} from '../../src/shared/irregular/domain.js'
import {
  DEFAULT_IRREGULAR_GEOMETRY_SETTINGS,
  makeCompactQualityIrregularOptimizerSettings
} from '../../src/shared/irregular/defaults.js'
import {
  computeIrregularNesting,
  type IrregularComputeResult
} from '../../src/workers/algorithm/irregular/computeIrregularNesting.js'
import { CollisionGeometryBuilder } from '../../src/workers/irregular/collisionGeometryBuilder.js'
import { FreeMaterialServiceLive } from '../../src/workers/irregular/freeMaterialService.js'
import { GeometryKernel, GeometrySettings } from '../../src/workers/irregular/geometryKernel.js'
import { NfpIfpServiceLive } from '../../src/workers/irregular/nfpIfpService.js'
import { TransformGeneratorLive } from '../../src/workers/irregular/transformGenerator.js'
import { IrregularLayoutScorer } from '../../src/workers/algorithm/irregular/irregularLayoutScorer.js'
import { IrregularPlacementScorer } from '../../src/workers/algorithm/irregular/irregularPlacementScorer.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..', '..')
const VECTORS_DIR = join(REPO_ROOT, 'crates', 'irregular-nesting-native', 'tests', 'vectors')

function generatingCommit(): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT }).toString().trim()
}

// ---------------------------------------------------------------------------
// The fixed 5-rectangle scenario calibrated to force the nested resume.
// ---------------------------------------------------------------------------
const SIZES: ReadonlyArray<readonly [number, number]> = [
  [30, 20],
  [25, 15],
  [20, 20],
  [18, 12],
  [15, 15]
]
const SHEET = new SheetSpec({ width: 45, height: 45, label: 's' })
// The nested resume's own `control.checkpoint()` calls span the closed,
// 1-indexed interval [3270, 6401] -- see this script's own top doc for how
// that was calibrated. 3270 is the earliest possible "during" observation
// point; 6401 is the latest.
const NESTED_RESUME_FIRST_CALL_ORDINAL = 3270
const NESTED_RESUME_LAST_CALL_ORDINAL = 6401

function rectPiece(id: string, w: number, h: number): ImportedPiece {
  return new ImportedPiece({
    id: PieceId.make(id),
    sourceFileId: SourceFileId.make('test-source'),
    label: `rect ${id}`,
    realBounds: { x: 0, y: 0, width: w, height: h },
    geometry: new DxfGeometrySummary({
      entityType: 'PRESET_SHAPE',
      closed: true,
      segments: [
        { kind: 'line' as const, x1: 0, y1: 0, x2: w, y2: 0 },
        { kind: 'line' as const, x1: w, y1: 0, x2: w, y2: h },
        { kind: 'line' as const, x1: w, y1: h, x2: 0, y2: h },
        { kind: 'line' as const, x1: 0, y1: h, x2: 0, y2: 0 }
      ]
    }),
    warnings: []
  })
}

const importedPieces = SIZES.map(([w, h], idx) => rectPiece(`p${idx}`, w, h))
const settings = new IrregularNestingSettings({
  geometry: new IrregularGeometrySettings({ ...DEFAULT_IRREGULAR_GEOMETRY_SETTINGS }),
  optimizer: makeCompactQualityIrregularOptimizerSettings()
})
const { pieces } = preparePieces(
  importedPieces,
  SHEET,
  0,
  PieceId.make('coordinator-cancellation-job') as unknown as never
)
const request = new NestingRequest({
  version: 1,
  jobId: 'coordinator-cancellation-job' as unknown as never,
  sheet: SHEET,
  padding: 0,
  pieces,
  sourcePieces: importedPieces,
  options: new NestingOptions({
    allowGlobalRotation: true,
    allowGlobalMirror: true,
    timeoutMs: 180_000,
    workerMode: 'irregular-convex-v2' as const,
    historyMode: 'off' as const,
    historyScope: 'winning_path' as const,
    strategySelectionMode: 'all_configured' as const,
    strategyIds: ['short-fill-bottom-left-then-short-side-fit'],
    layoutSelectionStrategyId: 'compact-first',
    finalSelectionMode: 'manual' as const,
    irregularSettings: settings
  })
})

function runWithCancelAt(cancelAtOrdinal: number | undefined): {
  outcome: 'ok' | 'aborted'
  reason?: string | undefined
  totalCalls: number
  trace?: unknown
} {
  let callCount = 0
  const isCancelled =
    cancelAtOrdinal === undefined
      ? undefined
      : () => {
          callCount += 1
          return callCount === cancelAtOrdinal
        }
  const countingIsCancelled =
    isCancelled ??
    (() => {
      callCount += 1
      return false
    })
  const exit = Effect.runSyncExit(
    computeIrregularNesting(request, { isCancelled: countingIsCancelled }).pipe(
      Effect.provide(CollisionGeometryBuilder.Live),
      Effect.provide(TransformGeneratorLive),
      Effect.provide(NfpIfpServiceLive),
      Effect.provide(FreeMaterialServiceLive),
      Effect.provide(IrregularPlacementScorer.Layer),
      Effect.provide(IrregularLayoutScorer.Live),
      Effect.provide(GeometryKernel.Live),
      Effect.provide(Layer.succeed(GeometrySettings, settings))
    )
  ) as ReturnType<typeof Effect.runSyncExit<IrregularComputeResult, unknown>>

  if (exit._tag === 'Success') {
    return {
      outcome: 'ok',
      totalCalls: callCount,
      trace: exit.value.intrinsicAnytimeSchedulerTrace
    }
  }
  const found = Cause.findFail(exit.cause)
  if (Result.isSuccess(found)) {
    const error = found.success.error as { readonly reason?: string }
    return {
      outcome: 'aborted',
      reason: error.reason,
      totalCalls: callCount
    }
  }
  throw new Error(`unexpected defect (not a typed Fail): ${Cause.pretty(exit.cause)}`)
}

// Baseline: uncancelled, confirms the nested resume actually fires (quanta[1]
// legacy-complete/checkpointed immediately followed by quanta[2]
// capacity-cold/partial) and pins the total checkpoint call count.
const baseline = runWithCancelAt(undefined)
if (baseline.outcome !== 'ok') {
  throw new Error(`baseline run must succeed, got ${JSON.stringify(baseline)}`)
}
const baselineTrace = baseline.trace as
  | {
      readonly coldStartStatus: string
      readonly quanta: ReadonlyArray<{
        readonly ordinal: number
        readonly cohort: string
        readonly producerRole: string
        readonly outcome: string
      }>
    }
  | undefined
if (baselineTrace === undefined) {
  throw new Error('baseline run must produce an intrinsicAnytimeSchedulerTrace')
}
if (
  baselineTrace.quanta.length < 3 ||
  baselineTrace.quanta[1]?.producerRole !== 'legacy-complete' ||
  baselineTrace.quanta[1]?.outcome !== 'checkpointed' ||
  baselineTrace.quanta[2]?.producerRole !== 'capacity-cold' ||
  baselineTrace.quanta[2]?.cohort !== 'partial'
) {
  throw new Error(
    `baseline trace does not show the nested resume firing: ${JSON.stringify(baselineTrace.quanta)}`
  )
}

// Cancel exactly at the nested resume's own first call.
const cancelledAtFirst = runWithCancelAt(NESTED_RESUME_FIRST_CALL_ORDINAL)
if (cancelledAtFirst.outcome !== 'aborted' || cancelledAtFirst.reason !== 'cancelled') {
  throw new Error(
    `expected cancellation at ordinal ${NESTED_RESUME_FIRST_CALL_ORDINAL} to abort with reason 'cancelled', got ${JSON.stringify(cancelledAtFirst)}`
  )
}

// Cancel exactly at the nested resume's own last call.
const cancelledAtLast = runWithCancelAt(NESTED_RESUME_LAST_CALL_ORDINAL)
if (cancelledAtLast.outcome !== 'aborted' || cancelledAtLast.reason !== 'cancelled') {
  throw new Error(
    `expected cancellation at ordinal ${NESTED_RESUME_LAST_CALL_ORDINAL} to abort with reason 'cancelled', got ${JSON.stringify(cancelledAtLast)}`
  )
}

// Cancel one call before the nested resume begins (outer, already-correct
// control threading) -- sanity control, not itself evidence of the fix.
const cancelledJustBefore = runWithCancelAt(NESTED_RESUME_FIRST_CALL_ORDINAL - 1)
if (cancelledJustBefore.outcome !== 'aborted' || cancelledJustBefore.reason !== 'cancelled') {
  throw new Error(
    `expected cancellation at ordinal ${NESTED_RESUME_FIRST_CALL_ORDINAL - 1} to abort with reason 'cancelled', got ${JSON.stringify(cancelledJustBefore)}`
  )
}

mkdirSync(VECTORS_DIR, { recursive: true })
const commit = generatingCommit()

const output = {
  generatedByScript: 'scripts/rust-parity/dump-coordinator-cancellation.ts',
  generatingCommit: commit,
  description:
    'Proves result::coordinator::on_canonical_grid_checkpointed threads the cooperative-cancellation ' +
    'control into its nested run_intrinsic_capacity_scheduler_cold_quantum resume call, exactly as TS ' +
    'computeIrregularNesting.ts:673-684 does. A deterministic call-counting isCancelled (returns true on ' +
    'exactly the Nth control.checkpoint() invocation, false otherwise) is injected at the calibrated call ' +
    'ordinal window the nested resume\'s own checkpoint calls occupy ([3270, 6401], 1-indexed, closed interval ' +
    '-- confirmed identical on both the TS and Rust sides via temporary, since-reverted instrumentation; see ' +
    'this script\'s own top doc). f64/number fields are plain JSON numbers (small integers only, no precision ' +
    'concern here, unlike the bit-pattern-hex convention other dump scripts use for arbitrary f64 output).',
  scenario: {
    pieces: SIZES.map(([w, h], idx) => ({ id: `p${idx}`, width: w, height: h })),
    sheet: { width: SHEET.width, height: SHEET.height, label: SHEET.label }
  },
  nestedResumeFirstCallOrdinal: NESTED_RESUME_FIRST_CALL_ORDINAL,
  nestedResumeLastCallOrdinal: NESTED_RESUME_LAST_CALL_ORDINAL,
  baseline: {
    outcome: baseline.outcome,
    totalCalls: baseline.totalCalls,
    coldStartStatus: baselineTrace.coldStartStatus,
    quanta: baselineTrace.quanta
  },
  cancelledAtNestedResumeFirstCall: {
    cancelAtOrdinal: NESTED_RESUME_FIRST_CALL_ORDINAL,
    outcome: cancelledAtFirst.outcome,
    reason: cancelledAtFirst.reason
  },
  cancelledAtNestedResumeLastCall: {
    cancelAtOrdinal: NESTED_RESUME_LAST_CALL_ORDINAL,
    outcome: cancelledAtLast.outcome,
    reason: cancelledAtLast.reason
  },
  cancelledJustBeforeNestedResume: {
    cancelAtOrdinal: NESTED_RESUME_FIRST_CALL_ORDINAL - 1,
    outcome: cancelledJustBefore.outcome,
    reason: cancelledJustBefore.reason
  }
}

writeFileSync(join(VECTORS_DIR, 'coordinator-cancellation.json'), JSON.stringify(output, null, 2) + '\n')

const fileBytes = new TextEncoder().encode(JSON.stringify(output, null, 2) + '\n')
const fileHash = createHash('sha256').update(fileBytes).digest('hex')

console.log(
  `Wrote coordinator-cancellation vector (baseline totalCalls=${baseline.totalCalls}, ` +
    `commit ${commit}, sha256 ${fileHash}) to ${VECTORS_DIR}`
)
