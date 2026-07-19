import { describe, expect, it } from 'vitest'
import { OverlapRelaxationTracker } from '../../src/workers/algorithm/irregular/overlapRelaxationTracker.js'

describe('OverlapRelaxationTracker', () => {
  it('retains least raw loss independently of later guided states', () => {
    const tracker = new OverlapRelaxationTracker({ value: 'initial', rawLoss: 4, tieKey: 'z' })
    tracker.record({ value: 'guided-worse', rawLoss: 8, tieKey: 'a' })
    tracker.record({ value: 'best', rawLoss: 2, tieKey: 'b' })
    tracker.record({ value: 'equal-deterministic', rawLoss: 2, tieKey: 'a' })

    expect(tracker.leastRaw()).toEqual({
      value: 'equal-deterministic',
      rawLoss: 2,
      tieKey: 'a'
    })
  })
})
