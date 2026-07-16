import { describe, expect, it } from 'vitest'
import {
  IrregularDecisionTraceBeamStepStarted,
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
})
