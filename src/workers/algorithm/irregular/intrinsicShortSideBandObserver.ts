import { Effect } from 'effect'
import { performance } from 'node:perf_hooks'
import type { SheetSpec } from '@shared/domain/nesting.js'
import type {
  IrregularPlacedPiece,
  IrregularPreparedPiece
} from '@shared/irregular/domain.js'
import {
  placedCollisionWorldGridPath
} from '../../irregular/canonicalLayoutGeometry.js'
import { GeometryKernel, GeometrySettings } from '../../irregular/geometryKernel.js'
import type { IrregularNfpIfpControl } from '../../irregular/services.js'
import {
  IrregularNfpIfpControlAbortError,
  NfpIfpService
} from '../../irregular/services.js'
import { IrregularBeamState } from './irregularBeamState.js'
import {
  canonicalAreaMetric,
  canonicalLinearMetric,
  enumerateIntrinsicStrictObserverSuccessors,
  finalizeIntrinsicStrictState,
  type IntrinsicStrictDecodeResult,
  type IntrinsicStrictLocalScore,
  type IntrinsicStrictObserverSuccessor
} from './intrinsicStrictDecoder.js'

export const INTRINSIC_SHORT_SIDE_BAND_OBSERVER_VERSION =
  'intrinsic-short-side-band-observer-v1' as const
export const INTRINSIC_SHORT_SIDE_BAND_BEAM_WIDTH = 4 as const
export const INTRINSIC_SHORT_SIDE_BAND_MAX_CANDIDATE_EVALUATIONS =
  20_000 as const
export const INTRINSIC_SHORT_SIDE_BAND_MAX_RUNTIME_MS = 5_000 as const
export const INTRINSIC_SHORT_SIDE_BAND_MAX_RSS_DELTA_BYTES =
  256 * 1_048_576
export const INTRINSIC_SHORT_SIDE_BAND_MAX_TRACE_BYTES = 1_048_576 as const
export const INTRINSIC_SHORT_SIDE_BAND_MIN_FILL_RATIO = 0.8 as const
export const INTRINSIC_SHORT_SIDE_BAND_MIN_PROJECTION_COVERAGE_RATIO =
  0.9 as const
export const INTRINSIC_SHORT_SIDE_BAND_MAX_PROJECTION_COMPONENTS = 2 as const

export type IntrinsicShortSideBandStatus =
  | 'accepted'
  | 'rejected-terminal-gates'
  | 'no-complete-endpoint'
  | 'skipped-square-sheet'
  | 'evaluation-cap'
  | 'deadline'
  | 'memory-cap'
  | 'trace-cap'
  | 'failed-protected-fallback'

export interface IntrinsicShortSideBandDepthTrace {
  readonly depth: number
  readonly expandedParentCount: number
  readonly generatedCandidateCount: number
  readonly candidateEvaluationCount: number
  readonly exactSuccessorCount: number
  readonly deduplicatedSuccessorCount: number
  readonly retainedStateCount: number
  readonly bestShortAxisSpanMm: number | undefined
  readonly bestLongAxisDepthMm: number | undefined
}

export interface IntrinsicShortSideBandAdmission {
  readonly allPiecesPlaced: boolean
  readonly exactLegal: boolean
  readonly fillRatio: number
  readonly closesHalfProductionShortfall: boolean
  readonly depthWithinCompactMaximumSide: boolean
  readonly enclosedCavityCount: number | undefined
  readonly cavityGate: boolean
  readonly occupiedHullGapRatio: number | undefined
  readonly hullGate: boolean
  readonly projectionCoverageRatio: number
  readonly projectionComponentCount: number
  readonly projectionGate: boolean
  readonly accepted: boolean
}

export interface IntrinsicShortSideBandTrace {
  readonly version: typeof INTRINSIC_SHORT_SIDE_BAND_OBSERVER_VERSION
  readonly status: IntrinsicShortSideBandStatus
  readonly outputInfluence: 'none'
  readonly executionModel: 'single-process-sequential'
  readonly beamWidth: typeof INTRINSIC_SHORT_SIDE_BAND_BEAM_WIDTH
  readonly requestedShortAxisMm: number
  readonly requestedLongAxisMm: number
  readonly productionShortAxisSpanMm: number
  readonly productionMaximumSideMm: number
  readonly candidateEvaluations: number
  readonly runtimeMs: number
  readonly peakRssDeltaBytes: number
  readonly serializedTraceBytes: number
  readonly depthTrace: ReadonlyArray<IntrinsicShortSideBandDepthTrace>
  readonly canonicalGeometryHash: string | undefined
  readonly terminalRotationDeg: 0 | 90 | undefined
  readonly usedShortAxisSpanMm: number | undefined
  readonly usedLongAxisDepthMm: number | undefined
  readonly admission: IntrinsicShortSideBandAdmission | undefined
  readonly failureReason: string | undefined
}

export interface IntrinsicShortSideBandOutcome {
  readonly trace: IntrinsicShortSideBandTrace
  readonly endpoint: IntrinsicStrictDecodeResult | undefined
}

interface RetainedState {
  readonly state: IrregularBeamState
  readonly score: IntrinsicStrictLocalScore
  readonly projection: ProjectionMetrics
}

interface ProjectionMetrics {
  readonly coverageRatio: number
  readonly componentCount: number
}

/** Builds one bounded exact band without influencing production Compact. */
export function observeIntrinsicShortSideBand(input: {
  readonly sheet: SheetSpec
  readonly preparedPieces: ReadonlyArray<IrregularPreparedPiece>
  readonly productionShortAxisSpanMm: number
  readonly productionMaximumSideMm: number
  readonly upstreamControl?: IrregularNfpIfpControl
}): Effect.Effect<
  IntrinsicShortSideBandOutcome,
  IrregularNfpIfpControlAbortError,
  GeometryKernel | GeometrySettings | NfpIfpService
> {
  return Effect.gen(function* () {
    const requestedShortAxisMm = Math.min(
      input.sheet.width,
      input.sheet.height
    )
    const requestedLongAxisMm = Math.max(
      input.sheet.width,
      input.sheet.height
    )
    if (input.sheet.width === input.sheet.height) {
      return emptyOutcome(input, {
        status: 'skipped-square-sheet',
        requestedShortAxisMm,
        requestedLongAxisMm,
        failureReason: 'square sheets do not define a short-side direction.'
      })
    }

    const startedAt = performance.now()
    const startingRssBytes = process.memoryUsage.rss()
    let peakRssBytes = startingRssBytes
    let candidateEvaluations = 0
    const depthTrace: IntrinsicShortSideBandDepthTrace[] = []
    const sampleRss = (): number => {
      peakRssBytes = Math.max(peakRssBytes, process.memoryUsage.rss())
      return Math.max(0, peakRssBytes - startingRssBytes)
    }
    const control: IrregularNfpIfpControl = {
      checkpoint: (phase) =>
        Effect.gen(function* () {
          if (input.upstreamControl !== undefined) {
            yield* input.upstreamControl.checkpoint(phase)
          }
          if (
            performance.now() - startedAt >=
            INTRINSIC_SHORT_SIDE_BAND_MAX_RUNTIME_MS
          ) {
            return yield* Effect.fail(
              new IrregularNfpIfpControlAbortError({
                reason: 'deadline',
                message: 'short-side band observer exceeded its runtime budget.'
              })
            )
          }
        })
    }
    const initial = new IrregularBeamState({
      remainingPreparedPieces: input.preparedPieces,
      placedCollisionGeometries: [],
      placementOrder: []
    }).withBottomLeftAnchored()
    if (initial === undefined) {
      return emptyOutcome(input, {
        status: 'failed-protected-fallback',
        requestedShortAxisMm,
        requestedLongAxisMm,
        failureReason: 'failed to create the exact empty band state.'
      })
    }
    let frontier: ReadonlyArray<RetainedState> = [
      {
        state: initial,
        score: emptyScore(initial),
        projection: { coverageRatio: 1, componentCount: 0 }
      }
    ]

    for (
      let depth = 0;
      depth < input.preparedPieces.length;
      depth += 1
    ) {
      const piece = input.preparedPieces[depth]
      if (piece === undefined) continue
      const remainingPreparedPieces =
        input.preparedPieces.slice(depth + 1)
      const successors: IntrinsicStrictObserverSuccessor[] = []
      let generatedCandidateCount = 0
      let depthCandidateEvaluations = 0
      const expandedParentCount = frontier.length
      for (const parent of frontier) {
        const remainingBudget =
          INTRINSIC_SHORT_SIDE_BAND_MAX_CANDIDATE_EVALUATIONS -
          candidateEvaluations
        if (remainingBudget <= 0) {
          return boundedOutcome(input, {
            status: 'evaluation-cap',
            requestedShortAxisMm,
            requestedLongAxisMm,
            startedAt,
            startingRssBytes,
            peakRssBytes,
            candidateEvaluations,
            depthTrace,
            failureReason: 'candidate evaluation cap reached.'
          })
        }
        const enumeration = yield* enumerateIntrinsicStrictObserverSuccessors(
          {
            state: parent.state,
            piece,
            remainingPreparedPieces,
            maximumCandidateEvaluations: remainingBudget,
            control
          }
        ).pipe(
          Effect.map((value) => ({
            _tag: 'Completed' as const,
            value
          })),
          Effect.catchTags({
            IrregularNfpIfpControlAbortError: (error) =>
              error.reason === 'cancelled'
                ? Effect.fail(error)
                : Effect.succeed({
                    _tag: 'Bounded' as const,
                    status: 'deadline' as const,
                    reason:
                      'runtime budget reached during candidate generation.'
                  }),
            IrregularGeometryInputError: (error) =>
              Effect.succeed({
                _tag: 'Failed' as const,
                reason: error.message
              }),
            IrregularNestingNotImplementedError: (error) =>
              Effect.succeed({
                _tag: 'Failed' as const,
                reason: error.message
              })
          })
        )
        if (enumeration._tag === 'Bounded') {
          return boundedOutcome(input, {
            status: enumeration.status,
            requestedShortAxisMm,
            requestedLongAxisMm,
            startedAt,
            startingRssBytes,
            peakRssBytes,
            candidateEvaluations,
            depthTrace,
            failureReason: enumeration.reason
          })
        }
        if (enumeration._tag === 'Failed') {
          return boundedOutcome(input, {
            status: 'failed-protected-fallback',
            requestedShortAxisMm,
            requestedLongAxisMm,
            startedAt,
            startingRssBytes,
            peakRssBytes,
            candidateEvaluations,
            depthTrace,
            failureReason: enumeration.reason
          })
        }
        const enumerated = enumeration.value
        generatedCandidateCount += enumerated.generatedCandidateCount
        depthCandidateEvaluations +=
          enumerated.candidateEvaluationCount
        candidateEvaluations += enumerated.candidateEvaluationCount
        if (enumerated.evaluationCapReached) {
          return boundedOutcome(input, {
            status: 'evaluation-cap',
            requestedShortAxisMm,
            requestedLongAxisMm,
            startedAt,
            startingRssBytes,
            peakRssBytes,
            candidateEvaluations,
            depthTrace,
            failureReason: 'candidate evaluation cap reached.'
          })
        }
        successors.push(
          ...enumerated.successors.filter((successor) =>
            fitsNormalizedBand(
              successor.state,
              requestedShortAxisMm,
              requestedLongAxisMm
            )
          )
        )
      }
      const deduplicated = deduplicateSuccessors(successors)
      frontier = retainProtectedBandStates(deduplicated)
      const rssDelta = sampleRss()
      depthTrace.push({
        depth,
        expandedParentCount,
        generatedCandidateCount,
        candidateEvaluationCount: depthCandidateEvaluations,
        exactSuccessorCount: successors.length,
        deduplicatedSuccessorCount: deduplicated.length,
        retainedStateCount: frontier.length,
        bestShortAxisSpanMm: bestBounds(frontier)?.width,
        bestLongAxisDepthMm: shallowestBounds(frontier)?.height
      })
      if (
        rssDelta >
        INTRINSIC_SHORT_SIDE_BAND_MAX_RSS_DELTA_BYTES
      ) {
        return boundedOutcome(input, {
          status: 'memory-cap',
          requestedShortAxisMm,
          requestedLongAxisMm,
          startedAt,
          startingRssBytes,
          peakRssBytes,
          candidateEvaluations,
          depthTrace,
          failureReason: 'sampled RSS delta cap reached.'
        })
      }
      if (frontier.length === 0) {
        return boundedOutcome(input, {
          status: 'no-complete-endpoint',
          requestedShortAxisMm,
          requestedLongAxisMm,
          startedAt,
          startingRssBytes,
          peakRssBytes,
          candidateEvaluations,
          depthTrace,
          failureReason: `exact frontier exhausted at depth ${depth}.`
        })
      }
    }

    const terminalCandidates: Array<{
      readonly retained: RetainedState
      readonly endpoint: IntrinsicStrictDecodeResult
      readonly admission: IntrinsicShortSideBandAdmission
    }> = []
    for (const retained of frontier) {
      const finalized = yield* finalizeIntrinsicStrictState(
        input.sheet,
        {
          state: retained.state,
          stepTrace: [],
          gapFillEvidence: [],
          runtimeMs: Math.max(0, performance.now() - startedAt)
        }
      ).pipe(
        Effect.catchTag('IntrinsicStrictDecoderError', () =>
          Effect.succeed(undefined)
        )
      )
      if (finalized === undefined) continue
      const admission = terminalAdmission({
        state: retained.state,
        endpoint: finalized,
        requestedPieceCount: input.preparedPieces.length,
        requestedShortAxisMm,
        productionShortAxisSpanMm:
          input.productionShortAxisSpanMm,
        productionMaximumSideMm: input.productionMaximumSideMm
      })
      terminalCandidates.push({
        retained,
        endpoint: finalized,
        admission
      })
    }
    const selected = terminalCandidates
      .filter(({ admission }) => admission.accepted)
      .toSorted(compareTerminalCandidates)[0]
    sampleRss()
    const runtimeMs = Math.max(0, performance.now() - startedAt)
    const status =
      runtimeMs > INTRINSIC_SHORT_SIDE_BAND_MAX_RUNTIME_MS
        ? ('deadline' as const)
        : sampleRss() >
            INTRINSIC_SHORT_SIDE_BAND_MAX_RSS_DELTA_BYTES
          ? ('memory-cap' as const)
          : selected === undefined
            ? ('rejected-terminal-gates' as const)
            : ('accepted' as const)
    const rawTrace: IntrinsicShortSideBandTrace = {
      version: INTRINSIC_SHORT_SIDE_BAND_OBSERVER_VERSION,
      status,
      outputInfluence: 'none',
      executionModel: 'single-process-sequential',
      beamWidth: INTRINSIC_SHORT_SIDE_BAND_BEAM_WIDTH,
      requestedShortAxisMm,
      requestedLongAxisMm,
      productionShortAxisSpanMm:
        input.productionShortAxisSpanMm,
      productionMaximumSideMm: input.productionMaximumSideMm,
      candidateEvaluations,
      runtimeMs,
      peakRssDeltaBytes: Math.max(
        0,
        peakRssBytes - startingRssBytes
      ),
      serializedTraceBytes: 0,
      depthTrace,
      canonicalGeometryHash:
        status === 'accepted'
          ? selected?.endpoint.canonicalGeometryHash
          : undefined,
      terminalRotationDeg:
        status === 'accepted'
          ? selected?.endpoint.terminalRotationDeg
          : undefined,
      usedShortAxisSpanMm:
        status === 'accepted'
          ? selected?.retained.state.translatedCollisionBounds?.width
          : undefined,
      usedLongAxisDepthMm:
        status === 'accepted'
          ? selected?.retained.state.translatedCollisionBounds?.height
          : undefined,
      admission:
        selected?.admission ??
        terminalCandidates
          .toSorted(compareRejectedTerminalCandidates)[0]
          ?.admission,
      failureReason:
        status === 'accepted'
          ? undefined
          : 'no finalized endpoint passed every band admission gate.'
    }
    const trace = withMeasuredTraceSize(rawTrace)
    if (
      trace.serializedTraceBytes >
      INTRINSIC_SHORT_SIDE_BAND_MAX_TRACE_BYTES
    ) {
      return {
        trace: withMeasuredTraceSize({
          ...trace,
          status: 'trace-cap',
          canonicalGeometryHash: undefined,
          terminalRotationDeg: undefined,
          usedShortAxisSpanMm: undefined,
          usedLongAxisDepthMm: undefined,
          failureReason: 'serialized trace cap reached.'
        }),
        endpoint: undefined
      }
    }
    return {
      trace,
      endpoint: status === 'accepted' ? selected?.endpoint : undefined
    }
  })
}

function emptyScore(state: IrregularBeamState): IntrinsicStrictLocalScore {
  return {
    maximumSideMm: 0,
    envelopeAreaMm2: 0,
    envelopeSpanMm: 0,
    sharedBoundaryLengthMm: 0,
    canonicalCombinedGeometryKey: state.canonicalOccupiedGeometryKey
  }
}

function fitsNormalizedBand(
  state: IrregularBeamState,
  shortAxisMm: number,
  longAxisMm: number
): boolean {
  const bounds = state.translatedCollisionBounds
  return (
    bounds !== undefined &&
    canonicalLinearMetric(bounds.width) <=
      canonicalLinearMetric(shortAxisMm) &&
    canonicalLinearMetric(bounds.height) <=
      canonicalLinearMetric(longAxisMm)
  )
}

function deduplicateSuccessors(
  successors: ReadonlyArray<IntrinsicStrictObserverSuccessor>
): ReadonlyArray<RetainedState> {
  const deduplicated = new Map<string, RetainedState>()
  for (const successor of successors) {
    const projection = projectionMetrics(
      successor.state.placedCollisionGeometries
    )
    const retained = {
      state: successor.state,
      score: successor.score,
      projection
    }
    const key = successor.state.canonicalOccupiedGeometryKey
    const incumbent = deduplicated.get(key)
    if (
      incumbent === undefined ||
      compareIntrinsic(retained, incumbent) < 0
    ) {
      deduplicated.set(key, retained)
    }
  }
  return [...deduplicated.values()]
}

function retainProtectedBandStates(
  states: ReadonlyArray<RetainedState>
): ReadonlyArray<RetainedState> {
  const selected: RetainedState[] = []
  const selectedKeys = new Set<string>()
  const orders = [
    compareFill,
    compareDepth,
    compareProjection,
    compareIntrinsic
  ] as const
  for (const order of orders) {
    const candidate = states
      .filter(
        ({ state }) =>
          !selectedKeys.has(state.canonicalOccupiedGeometryKey)
      )
      .toSorted(order)[0]
    if (candidate === undefined) continue
    selected.push(candidate)
    selectedKeys.add(candidate.state.canonicalOccupiedGeometryKey)
  }
  for (const candidate of states.toSorted(compareFill)) {
    if (selected.length >= INTRINSIC_SHORT_SIDE_BAND_BEAM_WIDTH) break
    if (selectedKeys.has(candidate.state.canonicalOccupiedGeometryKey)) {
      continue
    }
    selected.push(candidate)
    selectedKeys.add(candidate.state.canonicalOccupiedGeometryKey)
  }
  return selected
}

function compareFill(first: RetainedState, second: RetainedState): number {
  const firstBounds = first.state.translatedCollisionBounds
  const secondBounds = second.state.translatedCollisionBounds
  if (firstBounds === undefined) return secondBounds === undefined ? 0 : 1
  if (secondBounds === undefined) return -1
  return (
    canonicalLinearMetric(secondBounds.width) -
      canonicalLinearMetric(firstBounds.width) ||
    canonicalLinearMetric(firstBounds.height) -
      canonicalLinearMetric(secondBounds.height) ||
    compareProjection(first, second) ||
    compareIntrinsic(first, second)
  )
}

function compareDepth(first: RetainedState, second: RetainedState): number {
  const firstBounds = first.state.translatedCollisionBounds
  const secondBounds = second.state.translatedCollisionBounds
  if (firstBounds === undefined) return secondBounds === undefined ? 0 : 1
  if (secondBounds === undefined) return -1
  return (
    canonicalLinearMetric(firstBounds.height) -
      canonicalLinearMetric(secondBounds.height) ||
    canonicalLinearMetric(secondBounds.width) -
      canonicalLinearMetric(firstBounds.width) ||
    compareProjection(first, second) ||
    compareIntrinsic(first, second)
  )
}

function compareProjection(
  first: RetainedState,
  second: RetainedState
): number {
  return (
    second.projection.coverageRatio -
      first.projection.coverageRatio ||
    first.projection.componentCount -
      second.projection.componentCount ||
    compareIntrinsic(first, second)
  )
}

function compareIntrinsic(
  first: RetainedState,
  second: RetainedState
): number {
  return (
    canonicalLinearMetric(first.score.maximumSideMm) -
      canonicalLinearMetric(second.score.maximumSideMm) ||
    canonicalAreaMetric(first.score.envelopeAreaMm2) -
      canonicalAreaMetric(second.score.envelopeAreaMm2) ||
    canonicalLinearMetric(first.score.envelopeSpanMm) -
      canonicalLinearMetric(second.score.envelopeSpanMm) ||
    second.score.sharedBoundaryLengthMm -
      first.score.sharedBoundaryLengthMm ||
    first.state.canonicalOccupiedGeometryKey.localeCompare(
      second.state.canonicalOccupiedGeometryKey
    )
  )
}

function projectionMetrics(
  placed: ReadonlyArray<IrregularPlacedPiece>
): ProjectionMetrics {
  const intervals = placed
    .flatMap((entry) => {
      const path = placedCollisionWorldGridPath(entry)
      if (path === undefined || path.length === 0) return []
      const values = path.map(({ x }) => x)
      return [{ start: Math.min(...values), end: Math.max(...values) }]
    })
    .toSorted((first, second) => first.start - second.start)
  if (intervals.length === 0) {
    return { coverageRatio: 1, componentCount: 0 }
  }
  const merged: Array<{ start: number; end: number }> = []
  for (const interval of intervals) {
    const last = merged.at(-1)
    if (last === undefined || interval.start > last.end) {
      merged.push({ ...interval })
    } else {
      last.end = Math.max(last.end, interval.end)
    }
  }
  const first = merged[0]
  const last = merged.at(-1)
  if (first === undefined || last === undefined) {
    return { coverageRatio: 1, componentCount: 0 }
  }
  const span = last.end - first.start
  const covered = merged.reduce(
    (sum, interval) => sum + interval.end - interval.start,
    0
  )
  return {
    coverageRatio: span <= 0 ? 1 : covered / span,
    componentCount: merged.length
  }
}

function terminalAdmission(input: {
  readonly state: IrregularBeamState
  readonly endpoint: IntrinsicStrictDecodeResult
  readonly requestedPieceCount: number
  readonly requestedShortAxisMm: number
  readonly productionShortAxisSpanMm: number
  readonly productionMaximumSideMm: number
}): IntrinsicShortSideBandAdmission {
  const bounds = input.state.translatedCollisionBounds
  const usedShortAxisSpanMm = bounds?.width ?? 0
  const usedLongAxisDepthMm = bounds?.height ?? Number.POSITIVE_INFINITY
  const fillRatio =
    input.requestedShortAxisMm <= 0
      ? 0
      : usedShortAxisSpanMm / input.requestedShortAxisMm
  const productionShortfall = Math.max(
    0,
    input.requestedShortAxisMm -
      input.productionShortAxisSpanMm
  )
  const candidateShortfall = Math.max(
    0,
    input.requestedShortAxisMm - usedShortAxisSpanMm
  )
  const projection = projectionMetrics(
    input.state.placedCollisionGeometries
  )
  const cavityCount = input.endpoint.metrics?.enclosedCavityCount
  const hullGap =
    input.endpoint.metrics?.largestOccupiedHullGapRatio
  const allPiecesPlaced =
    input.endpoint.placedCollisionGeometries.length ===
      input.requestedPieceCount &&
    input.endpoint.unplacedPieceIds.length === 0
  const exactLegal = input.endpoint.status === 'completed'
  const closesHalfProductionShortfall =
    canonicalLinearMetric(candidateShortfall) <=
    canonicalLinearMetric(productionShortfall / 2)
  const depthWithinCompactMaximumSide =
    canonicalLinearMetric(usedLongAxisDepthMm) <=
    canonicalLinearMetric(input.productionMaximumSideMm)
  const cavityGate =
    cavityCount !== undefined && cavityCount <= 2
  const hullGate =
    hullGap !== undefined && hullGap <= 0.15
  const projectionGate =
    projection.coverageRatio >=
      INTRINSIC_SHORT_SIDE_BAND_MIN_PROJECTION_COVERAGE_RATIO &&
    projection.componentCount <=
      INTRINSIC_SHORT_SIDE_BAND_MAX_PROJECTION_COMPONENTS
  const accepted =
    allPiecesPlaced &&
    exactLegal &&
    fillRatio >= INTRINSIC_SHORT_SIDE_BAND_MIN_FILL_RATIO &&
    closesHalfProductionShortfall &&
    depthWithinCompactMaximumSide &&
    cavityGate &&
    hullGate &&
    projectionGate
  return {
    allPiecesPlaced,
    exactLegal,
    fillRatio,
    closesHalfProductionShortfall,
    depthWithinCompactMaximumSide,
    enclosedCavityCount: cavityCount,
    cavityGate,
    occupiedHullGapRatio: hullGap,
    hullGate,
    projectionCoverageRatio: projection.coverageRatio,
    projectionComponentCount: projection.componentCount,
    projectionGate,
    accepted
  }
}

function compareTerminalCandidates(
  first: {
    readonly retained: RetainedState
    readonly endpoint: IntrinsicStrictDecodeResult
  },
  second: {
    readonly retained: RetainedState
    readonly endpoint: IntrinsicStrictDecodeResult
  }
): number {
  return (
    compareFill(first.retained, second.retained) ||
    (first.endpoint.canonicalGeometryHash ?? '').localeCompare(
      second.endpoint.canonicalGeometryHash ?? ''
    )
  )
}

function compareRejectedTerminalCandidates(
  first: { readonly admission: IntrinsicShortSideBandAdmission },
  second: { readonly admission: IntrinsicShortSideBandAdmission }
): number {
  return (
    Number(second.admission.accepted) -
      Number(first.admission.accepted) ||
    second.admission.fillRatio - first.admission.fillRatio ||
    Number(second.admission.projectionGate) -
      Number(first.admission.projectionGate) ||
    Number(second.admission.hullGate) -
      Number(first.admission.hullGate)
  )
}

function bestBounds(
  frontier: ReadonlyArray<RetainedState>
): { readonly width: number; readonly height: number } | undefined {
  return frontier.toSorted(compareFill)[0]?.state
    .translatedCollisionBounds
}

function shallowestBounds(
  frontier: ReadonlyArray<RetainedState>
): { readonly width: number; readonly height: number } | undefined {
  return frontier.toSorted(compareDepth)[0]?.state
    .translatedCollisionBounds
}

function withMeasuredTraceSize(
  trace: IntrinsicShortSideBandTrace
): IntrinsicShortSideBandTrace {
  const firstSize = Buffer.byteLength(JSON.stringify(trace), 'utf8')
  const measured = { ...trace, serializedTraceBytes: firstSize }
  return {
    ...measured,
    serializedTraceBytes: Buffer.byteLength(
      JSON.stringify(measured),
      'utf8'
    )
  }
}

function emptyOutcome(
  input: {
    readonly productionShortAxisSpanMm: number
    readonly productionMaximumSideMm: number
  },
  trace: {
    readonly status: IntrinsicShortSideBandStatus
    readonly requestedShortAxisMm: number
    readonly requestedLongAxisMm: number
    readonly failureReason: string
  }
): IntrinsicShortSideBandOutcome {
  return {
    trace: withMeasuredTraceSize({
      version: INTRINSIC_SHORT_SIDE_BAND_OBSERVER_VERSION,
      ...trace,
      outputInfluence: 'none',
      executionModel: 'single-process-sequential',
      beamWidth: INTRINSIC_SHORT_SIDE_BAND_BEAM_WIDTH,
      productionShortAxisSpanMm:
        input.productionShortAxisSpanMm,
      productionMaximumSideMm: input.productionMaximumSideMm,
      candidateEvaluations: 0,
      runtimeMs: 0,
      peakRssDeltaBytes: 0,
      serializedTraceBytes: 0,
      depthTrace: [],
      canonicalGeometryHash: undefined,
      terminalRotationDeg: undefined,
      usedShortAxisSpanMm: undefined,
      usedLongAxisDepthMm: undefined,
      admission: undefined
    }),
    endpoint: undefined
  }
}

function boundedOutcome(
  input: {
    readonly productionShortAxisSpanMm: number
    readonly productionMaximumSideMm: number
  },
  bounded: {
    readonly status: IntrinsicShortSideBandStatus
    readonly requestedShortAxisMm: number
    readonly requestedLongAxisMm: number
    readonly startedAt: number
    readonly startingRssBytes: number
    readonly peakRssBytes: number
    readonly candidateEvaluations: number
    readonly depthTrace: ReadonlyArray<IntrinsicShortSideBandDepthTrace>
    readonly failureReason: string
  }
): IntrinsicShortSideBandOutcome {
  return {
    trace: withMeasuredTraceSize({
      version: INTRINSIC_SHORT_SIDE_BAND_OBSERVER_VERSION,
      status: bounded.status,
      outputInfluence: 'none',
      executionModel: 'single-process-sequential',
      beamWidth: INTRINSIC_SHORT_SIDE_BAND_BEAM_WIDTH,
      requestedShortAxisMm: bounded.requestedShortAxisMm,
      requestedLongAxisMm: bounded.requestedLongAxisMm,
      productionShortAxisSpanMm:
        input.productionShortAxisSpanMm,
      productionMaximumSideMm: input.productionMaximumSideMm,
      candidateEvaluations: bounded.candidateEvaluations,
      runtimeMs: Math.max(0, performance.now() - bounded.startedAt),
      peakRssDeltaBytes: Math.max(
        0,
        bounded.peakRssBytes - bounded.startingRssBytes
      ),
      serializedTraceBytes: 0,
      depthTrace: bounded.depthTrace,
      canonicalGeometryHash: undefined,
      terminalRotationDeg: undefined,
      usedShortAxisSpanMm: undefined,
      usedLongAxisDepthMm: undefined,
      admission: undefined,
      failureReason: bounded.failureReason
    }),
    endpoint: undefined
  }
}
