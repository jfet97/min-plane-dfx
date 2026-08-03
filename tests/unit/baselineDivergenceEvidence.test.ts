import { describe, expect, it } from 'vitest'

import { auditProjectionDivergences } from '../../scripts/rust-parity/baseline-divergence-evidence.js'

describe('auditProjectionDivergences', () => {
  it('masks only the explicitly accepted divergent leaves', () => {
    const typescript = {
      value: {
        portfolio: { score: { freeMaterialSliverMetric: 1 } },
        score: { freeMaterialSliverMetric: 1 },
        stable: 'same'
      }
    }
    const rust = {
      value: {
        portfolio: { score: { freeMaterialSliverMetric: 2 } },
        score: { freeMaterialSliverMetric: 2 },
        stable: 'same'
      }
    }

    const audit = auditProjectionDivergences(typescript, rust, [
      {
        path: 'value.portfolio.score.freeMaterialSliverMetric',
        typescript: 1,
        rust: 2
      },
      { path: 'value.score.freeMaterialSliverMetric', typescript: 1, rust: 2 }
    ])

    expect(audit.divergences).toEqual([
      {
        path: 'value.portfolio.score.freeMaterialSliverMetric',
        typescript: 1,
        rust: 2
      },
      { path: 'value.score.freeMaterialSliverMetric', typescript: 1, rust: 2 }
    ])
    expect(audit.unexpectedDivergences).toEqual([])
    expect(audit.exactAfterMask).toBe(true)
  })

  it('retains every divergence outside the accepted path set', () => {
    const audit = auditProjectionDivergences(
      { value: { accepted: 1, unexpected: ['left'] } },
      { value: { accepted: 2, unexpected: ['right'] } },
      [{ path: 'value.accepted', typescript: 1, rust: 2 }]
    )

    expect(audit.unexpectedDivergences).toEqual([
      { path: 'value.unexpected[0]', typescript: 'left', rust: 'right' }
    ])
    expect(audit.exactAfterMask).toBe(false)
  })

  it('does not mask a known path when either frozen value changes', () => {
    const audit = auditProjectionDivergences(
      { value: { score: 1.0000000000000002 } },
      { value: { score: 1.0000000000000004 } },
      [{ path: 'value.score', typescript: 1, rust: 2 }]
    )

    expect(audit.unexpectedDivergences).toEqual([
      {
        path: 'value.score',
        typescript: 1.0000000000000002,
        rust: 1.0000000000000004
      }
    ])
    expect(audit.missingAcceptedPaths).toEqual(['value.score'])
    expect(audit.exactAfterMask).toBe(false)
  })

  it('rejects duplicate accepted exact definitions', () => {
    const accepted = { path: 'value.score', typescript: 1, rust: 2 }

    expect(() =>
      auditProjectionDivergences({ value: { score: 1 } }, { value: { score: 2 } }, [
        accepted,
        accepted
      ])
    ).toThrowError('Duplicate accepted divergence definition: value.score (typescript=1, rust=2)')
  })

  it('reports an object key that is missing from one projection', () => {
    const audit = auditProjectionDivergences(
      { value: { stable: true } },
      { value: { stable: true, rustOnly: 'present' } },
      []
    )

    expect(audit.divergences).toEqual([
      { path: 'value.rustOnly', typescript: undefined, rust: 'present' }
    ])
    expect(audit.unexpectedDivergences).toEqual(audit.divergences)
    expect(audit.exactAfterMask).toBe(false)
  })
})
