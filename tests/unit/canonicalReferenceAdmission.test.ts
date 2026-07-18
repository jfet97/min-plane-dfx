import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import { PieceId } from '@shared/domain/ids.js'
import { NestingRequest, PreparedPiece, SheetSpec } from '@shared/domain/nesting.js'
import {
  FreeMaterialSnapshot,
  IrregularNestingSettings
} from '@shared/irregular/domain.js'
import {
  CANONICAL_REFERENCE_ADMISSION_SLACKS,
  canonicalReferenceDecodeSheets,
  evaluateCanonicalReferenceAdmissionMetrics,
  isCanonicalReferenceRoleEligible
} from '../../src/workers/algorithm/irregular/computeIrregularNesting.js'
import type { IrregularLayoutScore } from '../../src/workers/algorithm/irregular/irregularLayoutScorer.js'
import type { CanonicalLayoutTopology } from '../../src/workers/irregular/canonicalLayoutGeometry.js'

const fixturePath = fileURLToPath(
  new URL('../fixtures/irregularSheetInvariance/mixed61-request.json', import.meta.url)
)
const mixedRequest = Schema.decodeUnknownSync(NestingRequest)(
  JSON.parse(readFileSync(fixturePath, 'utf8'))
)
const mixedSettings = mixedRequest.options.irregularSettings
if (mixedSettings === undefined) throw new Error('mixed-61 fixture must carry irregular settings')
const nonReferenceRequest = new NestingRequest({
  ...mixedRequest,
  sheet: new SheetSpec({ width: 2000, height: 1700, label: 'non-reference' })
})

const topology: CanonicalLayoutTopology = {
  largestOccupiedHullGapRatio: 0.2,
  positiveContactComponentCount: 5,
  isolatedPieceCount: 2,
  largestPositiveContactComponentSize: 53
}

function score(overrides: Partial<IrregularLayoutScore> = {}): IrregularLayoutScore {
  return {
    unplacedCount: 0,
    sharedCollisionBoundaryLengthMm: 100,
    sharedCollisionBoundaryContactUnits: 20,
    sharedCollisionBoundaryContactBand: 20,
    nearCompleteStructuralContactCount: 57,
    dominantNearCompleteStructuralContactCount: 17,
    largestNetFreeMaterialRegionAreaMm2: 1,
    freeMaterialRegionCount: 1,
    freeMaterialHoleCount: 2,
    freeMaterialSliverMetric: 1,
    collisionBoundsWorstNormalizedSheetConsumption: 1,
    collisionBoundsNormalizedSpanSum: 1,
    collisionBoundsAreaMm2: 500_000,
    collisionBoundsSpanMm: 1_500,
    occupiedHullWasteRatio: 0.2,
    collisionBoundsBottomMm: 0,
    collisionBoundsLeftMm: 0,
    freeMaterialSnapshot: new FreeMaterialSnapshot({
      sheet: mixedRequest.sheet,
      regions: [],
      diagnostics: []
    }),
    placementOrder: [],
    unplacedSourcePieceIds: [],
    ...overrides
  }
}

const canonicalScore = () =>
  score({
    collisionBoundsAreaMm2: 430_000,
    collisionBoundsSpanMm: 1_420,
    nearCompleteStructuralContactCount: 53,
    dominantNearCompleteStructuralContactCount: 14
  })

describe('canonical reference coordinator policy', () => {
  it('plans two decodes only for eligible non-reference jobs', () => {
    expect(isCanonicalReferenceRoleEligible(nonReferenceRequest, mixedSettings)).toBe(true)
    expect(canonicalReferenceDecodeSheets(nonReferenceRequest, mixedSettings)).toHaveLength(2)

    const referenceRequest = new NestingRequest({
      ...mixedRequest,
      sheet:
        canonicalReferenceDecodeSheets(nonReferenceRequest, mixedSettings)[1] ?? mixedRequest.sheet
    })
    expect(canonicalReferenceDecodeSheets(referenceRequest, mixedSettings)).toHaveLength(1)

    const firstPiece = mixedRequest.pieces[0]
    if (firstPiece === undefined) throw new Error('mixed fixture must contain a piece')
    const homogeneousRequest = new NestingRequest({
      ...nonReferenceRequest,
      pieces: Array.from(
        { length: 21 },
        (_, index) =>
          new PreparedPiece({
            ...firstPiece,
            id: PieceId.make(`homogeneous-${index}`)
          })
      )
    })
    expect(canonicalReferenceDecodeSheets(homogeneousRequest, mixedSettings)).toHaveLength(2)
    expect(
      canonicalReferenceDecodeSheets(
        new NestingRequest({ ...homogeneousRequest, pieces: homogeneousRequest.pieces.slice(0, 20) }),
        mixedSettings
      )
    ).toHaveLength(1)
  })

  it('keeps repair, GA, and short-side-fill jobs on one decode', () => {
    const settings = (overrides: Record<string, unknown>) =>
      Schema.decodeUnknownSync(IrregularNestingSettings)({
        ...mixedSettings,
        optimizer: { ...mixedSettings.optimizer, ...overrides }
      })
    for (const ineligible of [
      settings({ localRepairBudget: 1 }),
      settings({ gaEnabled: true, baselineOnly: false }),
      settings({ placementPolicyId: 'short-side-fill' })
    ]) {
      expect(canonicalReferenceDecodeSheets(nonReferenceRequest, ineligible)).toHaveLength(1)
    }
  })

  it('accepts the measured 57/17 to 53/14 contact trade within named slacks', () => {
    expect(CANONICAL_REFERENCE_ADMISSION_SLACKS).toEqual({
      maximumMaxSideRegressionRatio: 0.075,
      maximumTotalContactLoss: 4,
      maximumDominantContactLoss: 3
    })
    expect(
      evaluateCanonicalReferenceAdmissionMetrics({
        production: score(),
        productionTopology: topology,
        canonical: canonicalScore(),
        canonicalTopology: topology
      }).admitted
    ).toBe(true)
  })

  it('rejects one unit beyond either contact loss slack', () => {
    expect(
      evaluateCanonicalReferenceAdmissionMetrics({
        production: score(),
        productionTopology: topology,
        canonical: score({
          collisionBoundsAreaMm2: 430_000,
          collisionBoundsSpanMm: 1_420,
          nearCompleteStructuralContactCount: 52,
          dominantNearCompleteStructuralContactCount: 14
        }),
        canonicalTopology: topology
      }).admitted
    ).toBe(false)
    expect(
      evaluateCanonicalReferenceAdmissionMetrics({
        production: score(),
        productionTopology: topology,
        canonical: score({
          collisionBoundsAreaMm2: 430_000,
          collisionBoundsSpanMm: 1_420,
          nearCompleteStructuralContactCount: 53,
          dominantNearCompleteStructuralContactCount: 13
        }),
        canonicalTopology: topology
      }).admitted
    ).toBe(false)
  })

  it('rejects fragmented low-gap candidates and score ties', () => {
    expect(
      evaluateCanonicalReferenceAdmissionMetrics({
        production: score(),
        productionTopology: topology,
        canonical: canonicalScore(),
        canonicalTopology: {
          largestOccupiedHullGapRatio: 0.1,
          positiveContactComponentCount: 12,
          isolatedPieceCount: 8,
          largestPositiveContactComponentSize: 20
        }
      }).admitted
    ).toBe(false)
    expect(
      evaluateCanonicalReferenceAdmissionMetrics({
        production: score(),
        productionTopology: topology,
        canonical: score(),
        canonicalTopology: topology
      }).admitted
    ).toBe(false)
  })
})
