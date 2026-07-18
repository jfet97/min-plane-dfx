import { describe, expect, it } from 'vitest'
import {
  IrregularDecisionTraceBeamSelection,
  IrregularDecisionTraceBeamStepStarted,
  IrregularDecisionTraceLocalCandidateDecisionCounts,
  IrregularDecisionTraceLocalCandidateSelection,
  IrregularDecisionTraceLocalCandidateSummary,
  type IrregularDecisionTraceEvent
} from '../../src/workers/algorithm/irregular/decisionTrace.js'
import {
  IrregularDecisionTraceBatcher,
  serializeIrregularDecisionTraceBatch
} from '../../src/workers/decisionTraceNdjson.js'

function event(stepIndex: number): IrregularDecisionTraceBeamStepStarted {
  return new IrregularDecisionTraceBeamStepStarted({
    decodeId: 'baseline-0',
    chromosomeId: 'c0',
    decodeSource: 'baseline',
    stepIndex,
    parentCount: stepIndex + 1
  })
}

describe('IrregularDecisionTraceBatcher', () => {
  it('emits bounded ordered batches and serializes one NDJSON line per event', () => {
    const batches: ReadonlyArray<IrregularDecisionTraceEvent>[] = []
    const batcher = new IrregularDecisionTraceBatcher({
      maximumEvents: 2,
      emitBatch: (batch) => batches.push(batch)
    })

    batcher.add(event(0))
    expect(batches).toEqual([])
    batcher.add(event(1))
    batcher.add(event(2))
    batcher.flush()

    expect(
      batches.map((batch) =>
        batch.map((item) => (item.kind === 'beam_step_started' ? item.stepIndex : undefined))
      )
    ).toEqual([[0, 1], [2]])
    const serialized = serializeIrregularDecisionTraceBatch(batches.flat())
    const lines = serialized.trimEnd().split('\n')
    expect(lines).toHaveLength(3)
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({ kind: 'beam_step_started', stepIndex: 0 }),
      expect.objectContaining({ kind: 'beam_step_started', stepIndex: 1 }),
      expect.objectContaining({ kind: 'beam_step_started', stepIndex: 2 })
    ])
  })

  it('round-trips pareto frontier reservation reasons through NDJSON', () => {
    const selection = new IrregularDecisionTraceLocalCandidateSelection({
      decodeId: 'baseline-0',
      chromosomeId: 'c0',
      decodeSource: 'baseline',
      stepIndex: 0,
      parentStateId: 's0',
      pieceId: 'piece-a',
      candidateId: 'k0',
      rank: 18,
      decision: 'selected',
      reason: 'pareto_frontier_reserved'
    })
    const beamSelection = new IrregularDecisionTraceBeamSelection({
      decodeId: 'baseline-0',
      chromosomeId: 'c0',
      decodeSource: 'baseline',
      stepIndex: 0,
      stateId: 's1',
      rank: 1,
      decision: 'retained',
      reason: 'protected_pareto_frontier_survivor'
    })

    const decoded = serializeIrregularDecisionTraceBatch([selection, beamSelection])
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as IrregularDecisionTraceEvent)

    expect(decoded).toEqual([
      expect.objectContaining({ kind: 'local_candidate_selection', reason: 'pareto_frontier_reserved' }),
      expect.objectContaining({ kind: 'beam_selection', reason: 'protected_pareto_frontier_survivor' })
    ])
  })

  it('serializes bounded local-candidate aggregate counts as one NDJSON record', () => {
    const summary = new IrregularDecisionTraceLocalCandidateSummary({
      decodeId: 'baseline-0',
      chromosomeId: 'c0',
      decodeSource: 'baseline',
      stepIndex: 2,
      parentStateId: 's1',
      pieceId: 'piece-a',
      generatedCandidateCount: 100,
      uniqueGeometryCandidateCount: 90,
      selectedCandidateCount: 4,
      detailedCandidateCount: 5,
      decisionCounts: new IrregularDecisionTraceLocalCandidateDecisionCounts({
        withinLocalCandidateFanout: 4,
        compactnessAlternativeReserved: 0,
        displacedByCompactnessReservation: 0,
        intrinsicContactTierReserved: 0,
        paretoFrontierReserved: 0,
        duplicateLocalGeometry: 10,
        outsideLocalCandidateFanout: 86
      })
    })

    const decoded = JSON.parse(serializeIrregularDecisionTraceBatch([summary]).trimEnd())
    expect(decoded).toEqual({
      decodeId: 'baseline-0',
      chromosomeId: 'c0',
      decodeSource: 'baseline',
      kind: 'local_candidate_summary',
      stepIndex: 2,
      parentStateId: 's1',
      pieceId: 'piece-a',
      generatedCandidateCount: 100,
      uniqueGeometryCandidateCount: 90,
      selectedCandidateCount: 4,
      detailedCandidateCount: 5,
      decisionCounts: {
        withinLocalCandidateFanout: 4,
        compactnessAlternativeReserved: 0,
        displacedByCompactnessReservation: 0,
        intrinsicContactTierReserved: 0,
        paretoFrontierReserved: 0,
        duplicateLocalGeometry: 10,
        outsideLocalCandidateFanout: 86
      }
    })
  })
})
