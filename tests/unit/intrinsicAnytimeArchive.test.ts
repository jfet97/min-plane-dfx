import { describe, expect, it } from 'vitest'
import {
  retainIntrinsicAnytimeArchiveNamespace,
  selectIntrinsicAnytimeSettledEndpoint
} from '../../src/workers/algorithm/irregular/intrinsicAnytimeArchive.js'

interface Endpoint {
  readonly id: string
  readonly score: number
  readonly valid: boolean
  readonly source: string
}

describe('intrinsic anytime archive', () => {
  it('validates and deduplicates within one namespace using its own policy', () => {
    const retained = retainIntrinsicAnytimeArchiveNamespace<Endpoint>({
      namespace: 'partial',
      endpoints: [
        { id: 'same', score: 3, valid: true, source: 'cold' },
        { id: 'invalid', score: 0, valid: false, source: 'invalid' },
        { id: 'same', score: 1, valid: true, source: 'warm' },
        { id: 'other', score: 2, valid: true, source: 'prefix' }
      ],
      identity: ({ id }) => id,
      validate: ({ valid }) => valid,
      selectDuplicate: (retainedEndpoint, candidate) =>
        candidate.score < retainedEndpoint.score ? candidate : retainedEndpoint,
      rank: (endpoints) => endpoints.toSorted((first, second) => first.score - second.score)
    })

    expect(retained.map(({ id, source }) => ({ id, source }))).toEqual([
      { id: 'same', source: 'warm' },
      { id: 'other', source: 'prefix' }
    ])
  })

  it('keeps complete and partial namespaces isolated and applies complete dominance at output', () => {
    const complete = [{ id: 'complete', score: 100, valid: true, source: 'legacy' }]
    const partial = [{ id: 'partial', score: 0, valid: true, source: 'warm' }]

    expect(selectIntrinsicAnytimeSettledEndpoint({ complete, partial })).toEqual({
      namespace: 'complete',
      endpoint: complete[0]
    })
    expect(selectIntrinsicAnytimeSettledEndpoint({ complete: [], partial })).toEqual({
      namespace: 'partial',
      endpoint: partial[0]
    })
  })
})
