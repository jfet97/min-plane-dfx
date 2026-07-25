import { createHash } from 'node:crypto'
import type { PieceId } from '@shared/domain/ids.js'
import type { SheetSpec } from '@shared/domain/nesting.js'
import type { IrregularPlacedPiece } from '@shared/irregular/domain.js'
import {
  assertCanonicalGridLegalLayout,
  canonicalCollisionLayoutIdentity,
  placedCollisionWorldGridPath
} from '../../irregular/canonicalLayoutGeometry.js'
import {
  fromGrid,
  toGridMm
} from '../../irregular/clipper2OffsetPolicy.js'
import {
  compareBigInts,
  compareCanonicalGridRatios
} from '../../irregular/canonicalGridMath.js'
import type { IntrinsicSharedArchiveEndpoint } from './intrinsicSharedArchivePortfolio.js'
import {
  INTRINSIC_STRICT_COHESION_FLOORS,
  intrinsicStrictCompletedLayoutDominates
} from './intrinsicStrictDecoder.js'
import { IrregularBeamState } from './irregularBeamState.js'

export const INTRINSIC_SHORT_SIDE_OBSERVER_VERSION =
  'intrinsic-short-side-observer-v4' as const
export const INTRINSIC_SHORT_SIDE_OBSERVER_MAX_RUNTIME_MS = 250 as const
export const INTRINSIC_SHORT_SIDE_OBSERVER_MAX_TRACE_BYTES = 1_048_576 as const

export type IntrinsicShortSideObserverRotation = 0 | 90
export type IntrinsicShortSideObserverStatus =
  | 'observed'
  | 'observed-no-legal-orientation'
  | 'observed-no-guard-eligible-endpoint'
  | 'observed-no-directional-improvement'
  | 'skipped-square-sheet'
  | 'skipped-no-settled-complete-endpoints'
  | 'runtime-budget-exceeded'
  | 'trace-budget-exceeded'

export interface IntrinsicShortSideOrientationObservation {
  readonly rotationDeg: IntrinsicShortSideObserverRotation
  readonly exactLegal: boolean
  readonly canonicalGeometryHash: string | undefined
  readonly usedWidthMm: number | undefined
  readonly usedHeightMm: number | undefined
  readonly requestedLongAxisUsedSpanMm: number | undefined
  readonly requestedShortAxisShortfallMm: number | undefined
  readonly requestedLongAxisUsedSpanGrid: number | undefined
  readonly requestedShortAxisShortfallGrid: number | undefined
  readonly cavityCount: number
  readonly hullGapRatio: number
  readonly hullGapDoubledAreaGrid2: string | undefined
  readonly occupiedHullDoubledAreaGrid2: string | undefined
  readonly cohesionPasses: boolean
  readonly cohesionDeficit: number
  readonly cohesionDeficitNumerator: string | undefined
  readonly cohesionDeficitDenominator: string | undefined
  readonly intrinsicEnvelopeAreaMm2: number
  readonly intrinsicEnvelopeMaximumSideMm: number
  readonly intrinsicEnvelopeSpanMm: number
  readonly intrinsicEnvelopeAreaGrid2: string | undefined
  readonly intrinsicEnvelopeMaximumSideGrid: number | undefined
  readonly intrinsicEnvelopeSpanGrid: number | undefined
  readonly dominantStructuralContacts: number
  readonly totalStructuralContacts: number
  readonly contactUnits: number
  readonly sharedBoundaryLengthMm: number
  readonly comparisonTuple: ReadonlyArray<number | string>
}

export interface IntrinsicShortSideEndpointObservation {
  readonly archiveIndex: number
  readonly role: string
  readonly sourceId: string | undefined
  readonly canonicalGeometryHash: string
  readonly q0: IntrinsicShortSideOrientationObservation
  readonly q90: IntrinsicShortSideOrientationObservation
  readonly selectedRotationDeg: IntrinsicShortSideObserverRotation
  readonly selected: IntrinsicShortSideOrientationObservation
  readonly cavityHullGuardEligible: boolean
  readonly geometricParetoEligible: boolean
}

export interface IntrinsicShortSideObserverTrace {
  readonly version: typeof INTRINSIC_SHORT_SIDE_OBSERVER_VERSION
  readonly status: IntrinsicShortSideObserverStatus
  readonly outputInfluence: 'none' | 'selected'
  readonly requestedSheetWidthMm: number
  readonly requestedSheetHeightMm: number
  readonly requestedLongAxisMm: number
  readonly requestedShortAxisMm: number
  readonly requestedLongAxis: 'width' | 'height' | 'square'
  readonly productionShortAxisSpanMm: number | undefined
  readonly productionMaximumSideMm: number | undefined
  readonly productionEnvelopeAreaMm2: number | undefined
  readonly productionShortAxisSpanGrid: number | undefined
  readonly productionMaximumSideGrid: number | undefined
  readonly productionEnvelopeAreaGrid2: string | undefined
  readonly settledEndpointCount: number
  readonly evaluatedOrientationCount: number
  readonly cavityHullGuardEligibleEndpointCount: number
  readonly geometricParetoEligibleEndpointCount: number
  readonly placementEvaluations: 0
  readonly candidateEvaluations: 0
  readonly runtimeMs: number
  readonly runtimeBudgetExceeded: boolean
  readonly serializedTraceBytes: number
  readonly endpoints: ReadonlyArray<IntrinsicShortSideEndpointObservation>
  readonly rankedCanonicalGeometryHashes: ReadonlyArray<string>
  readonly observerWinnerCanonicalGeometryHash: string | undefined
  readonly observerWinnerRotationDeg: IntrinsicShortSideObserverRotation | undefined
}

/** Evaluates settled complete endpoints without constructing placements or candidates. */
export function observeIntrinsicShortSideOrientations(input: {
  readonly sheet: SheetSpec
  readonly endpoints: ReadonlyArray<IntrinsicSharedArchiveEndpoint>
  readonly productionPlacedCollisionGeometries?: ReadonlyArray<IrregularPlacedPiece>
  readonly now?: () => number
}): IntrinsicShortSideObserverTrace {
  const now = input.now ?? performance.now.bind(performance)
  const startedAt = now()
  const requestedLongAxis =
    input.sheet.width === input.sheet.height
      ? ('square' as const)
      : input.sheet.width > input.sheet.height
        ? ('width' as const)
        : ('height' as const)
  const requestedLongAxisMm = Math.max(input.sheet.width, input.sheet.height)
  const requestedShortAxisMm = Math.min(input.sheet.width, input.sheet.height)
  const requestedShortAxisGrid = toGridMm(requestedShortAxisMm)
  const productionReference = directionalReference({
    sheet: input.sheet,
    placedCollisionGeometries:
      input.productionPlacedCollisionGeometries ??
      input.endpoints[0]?.placedCollisionGeometries ??
      [],
    requestedLongAxis,
    requestedShortAxisMm
  })
  const observedEndpoints = input.endpoints.map((endpoint, archiveIndex) =>
    observeEndpoint({
      sheet: input.sheet,
      endpoint,
      archiveIndex,
      requestedLongAxis,
      requestedShortAxisMm
    })
  )
  const legalEndpoints = observedEndpoints.filter(({ selected }) => selected.exactLegal)
  const guardEligibleEndpoints = legalEndpoints.filter(cavityHullGuardEligible)
  const geometricParetoEndpoints = guardEligibleEndpoints.filter(
    (candidate) => {
      const candidateSource = input.endpoints[candidate.archiveIndex]
      if (candidateSource === undefined) return false
      return !guardEligibleEndpoints.some((other) => {
        const otherSource = input.endpoints[other.archiveIndex]
        return (
          other !== candidate &&
          otherSource !== undefined &&
          intrinsicStrictCompletedLayoutDominates(
            otherSource.metrics,
            candidateSource.metrics
          )
        )
      })
    }
  )
  const geometricParetoIndexes = new Set(
    geometricParetoEndpoints.map(({ archiveIndex }) => archiveIndex)
  )
  const endpoints = observedEndpoints.map((endpoint) => ({
    ...endpoint,
    cavityHullGuardEligible: cavityHullGuardEligible(endpoint),
    geometricParetoEligible: geometricParetoIndexes.has(endpoint.archiveIndex)
  }))
  const ranked = endpoints
    .filter(({ geometricParetoEligible }) => geometricParetoEligible)
    .toSorted(compareEndpointObservations)
  const rankedWinner = ranked[0]
  const winner =
    rankedWinner !== undefined &&
    productionReference !== undefined &&
    directionalImprovementAdmitted({
      candidate: rankedWinner.selected,
      production: productionReference,
      requestedShortAxisGrid
    })
      ? rankedWinner
      : undefined
  const observed = {
    version: INTRINSIC_SHORT_SIDE_OBSERVER_VERSION,
    status:
      requestedLongAxis === 'square'
        ? ('skipped-square-sheet' as const)
        : endpoints.length === 0
        ? ('skipped-no-settled-complete-endpoints' as const)
        : legalEndpoints.length === 0
          ? ('observed-no-legal-orientation' as const)
          : guardEligibleEndpoints.length === 0
            ? ('observed-no-guard-eligible-endpoint' as const)
            : winner === undefined
              ? ('observed-no-directional-improvement' as const)
              : ('observed' as const),
    outputInfluence: 'none',
    requestedSheetWidthMm: input.sheet.width,
    requestedSheetHeightMm: input.sheet.height,
    requestedLongAxisMm,
    requestedShortAxisMm,
    requestedLongAxis,
    productionShortAxisSpanMm:
      productionReference?.usedShortAxisSpanMm,
    productionMaximumSideMm:
      productionReference?.maximumSideMm,
    productionEnvelopeAreaMm2:
      productionReference?.envelopeAreaMm2,
    productionShortAxisSpanGrid:
      productionReference?.usedShortAxisSpanGrid,
    productionMaximumSideGrid:
      productionReference?.maximumSideGrid,
    productionEnvelopeAreaGrid2:
      productionReference?.envelopeAreaGrid2.toString(),
    settledEndpointCount: endpoints.length,
    evaluatedOrientationCount: endpoints.length * 2,
    cavityHullGuardEligibleEndpointCount: guardEligibleEndpoints.length,
    geometricParetoEligibleEndpointCount: geometricParetoEndpoints.length,
    placementEvaluations: 0,
    candidateEvaluations: 0,
    runtimeMs: 0,
    runtimeBudgetExceeded: false,
    serializedTraceBytes: 0,
    endpoints,
    rankedCanonicalGeometryHashes: ranked.map(
      ({ canonicalGeometryHash }) => canonicalGeometryHash
    ),
    observerWinnerCanonicalGeometryHash: winner?.canonicalGeometryHash,
    observerWinnerRotationDeg: winner?.selectedRotationDeg
  } satisfies IntrinsicShortSideObserverTrace
  const measured = withMeasuredIntrinsicShortSideObserverTrace({
    ...observed,
    runtimeMs: Math.max(0, now() - startedAt)
  })
  if (measured.runtimeMs > INTRINSIC_SHORT_SIDE_OBSERVER_MAX_RUNTIME_MS) {
    return censoredTrace(measured, 'runtime-budget-exceeded', true)
  }
  const selectedSize = withMeasuredIntrinsicShortSideObserverTrace({
    ...measured,
    outputInfluence: 'selected'
  }).serializedTraceBytes
  if (selectedSize <= INTRINSIC_SHORT_SIDE_OBSERVER_MAX_TRACE_BYTES) {
    return measured
  }
  return censoredTrace(measured, 'trace-budget-exceeded', false)
}

function observeEndpoint(input: {
  readonly sheet: SheetSpec
  readonly endpoint: IntrinsicSharedArchiveEndpoint
  readonly archiveIndex: number
  readonly requestedLongAxis: 'width' | 'height' | 'square'
  readonly requestedShortAxisMm: number
}): IntrinsicShortSideEndpointObservation {
  const state = new IrregularBeamState({
    remainingPreparedPieces: [],
    placedCollisionGeometries: input.endpoint.placedCollisionGeometries,
    unplacedPieceIds: [],
    placementOrder: input.endpoint.placedCollisionGeometries.map(placedPieceId)
  })
  const q0 = observeOrientation({
    sheet: input.sheet,
    endpoint: input.endpoint,
    state,
    rotationDeg: 0,
    requestedLongAxis: input.requestedLongAxis,
    requestedShortAxisMm: input.requestedShortAxisMm
  })
  const q90 = observeOrientation({
    sheet: input.sheet,
    endpoint: input.endpoint,
    state,
    rotationDeg: 90,
    requestedLongAxis: input.requestedLongAxis,
    requestedShortAxisMm: input.requestedShortAxisMm
  })
  const selected = compareOrientationObservations(q0, q90) <= 0 ? q0 : q90
  return {
    archiveIndex: input.archiveIndex,
    role: input.endpoint.role,
    sourceId: input.endpoint.sourceId,
    canonicalGeometryHash: input.endpoint.sheetlessCanonicalGeometryHash,
    q0,
    q90,
    selectedRotationDeg: selected.rotationDeg,
    selected,
    cavityHullGuardEligible: false,
    geometricParetoEligible: false
  }
}

function cavityHullGuardEligible(
  endpoint: IntrinsicShortSideEndpointObservation
): boolean {
  const gapArea = endpoint.selected.hullGapDoubledAreaGrid2
  const hullArea = endpoint.selected.occupiedHullDoubledAreaGrid2
  return (
    endpoint.selected.exactLegal &&
    endpoint.selected.cavityCount <=
      INTRINSIC_STRICT_COHESION_FLOORS.maximumEnclosedCavityCount &&
    gapArea !== undefined &&
    hullArea !== undefined &&
    20n * BigInt(gapArea) <= 3n * BigInt(hullArea)
  )
}

function observeOrientation(input: {
  readonly sheet: SheetSpec
  readonly endpoint: IntrinsicSharedArchiveEndpoint
  readonly state: IrregularBeamState
  readonly rotationDeg: IntrinsicShortSideObserverRotation
  readonly requestedLongAxis: 'width' | 'height' | 'square'
  readonly requestedShortAxisMm: number
}): IntrinsicShortSideOrientationObservation {
  const oriented = input.state.withQuarterTurnBottomLeft(input.rotationDeg)
  const exactLegal =
    oriented !== undefined &&
    assertCanonicalGridLegalLayout(input.sheet, oriented.placedCollisionGeometries)
  const dimensions = oriented === undefined ? undefined : canonicalDimensions(oriented.placedCollisionGeometries)
  const canonicalGeometryHash =
    oriented === undefined
      ? undefined
      : hashCanonicalIdentity(canonicalCollisionLayoutIdentity(oriented.placedCollisionGeometries))
  const usedLongAxisSpanMm =
    dimensions === undefined
      ? undefined
      : input.requestedLongAxis === 'square'
        ? Math.max(dimensions.widthMm, dimensions.heightMm)
        : input.requestedLongAxis === 'width'
          ? dimensions.widthMm
          : dimensions.heightMm
  const usedShortAxisSpanMm =
    dimensions === undefined || input.requestedLongAxis === 'square'
      ? undefined
      : input.requestedLongAxis === 'width'
        ? dimensions.heightMm
        : dimensions.widthMm
  const usedLongAxisSpanGrid =
    dimensions === undefined
      ? undefined
      : input.requestedLongAxis === 'square'
        ? Math.max(dimensions.widthGrid, dimensions.heightGrid)
        : input.requestedLongAxis === 'width'
          ? dimensions.widthGrid
          : dimensions.heightGrid
  const usedShortAxisSpanGrid =
    dimensions === undefined || input.requestedLongAxis === 'square'
      ? undefined
      : input.requestedLongAxis === 'width'
        ? dimensions.heightGrid
        : dimensions.widthGrid
  const requestedShortAxisGrid = toGridMm(input.requestedShortAxisMm)
  const requestedShortAxisShortfallMm =
    input.requestedLongAxis === 'square'
      ? 0
      : usedShortAxisSpanMm === undefined
        ? undefined
        : input.requestedShortAxisMm - usedShortAxisSpanMm
  const requestedShortAxisShortfallGrid =
    input.requestedLongAxis === 'square'
      ? 0
      : usedShortAxisSpanGrid === undefined ||
          requestedShortAxisGrid === undefined
        ? undefined
        : requestedShortAxisGrid - usedShortAxisSpanGrid
  const metrics = input.endpoint.metrics
  const tuple = comparisonTuple({
    exactLegal,
    requestedLongAxisUsedSpanMm: usedLongAxisSpanMm,
    cavityCount: metrics.enclosedCavityCount,
    hullGapRatio: metrics.largestOccupiedHullGapRatio,
    cohesionPasses: input.endpoint.certificate.passes,
    cohesionDeficit: input.endpoint.certificate.relativeDeficitSum,
    requestedShortAxisShortfallMm,
    intrinsicEnvelopeAreaMm2: metrics.envelopeAreaMm2,
    intrinsicEnvelopeMaximumSideMm: metrics.envelopeMaximumSideMm,
    intrinsicEnvelopeSpanMm: metrics.envelopeSpanMm,
    dominantStructuralContacts: metrics.dominantStructuralContacts,
    totalStructuralContacts: metrics.totalStructuralContacts,
    contactUnits: metrics.contactUnits,
    sharedBoundaryLengthMm: metrics.sharedBoundaryLengthMm,
    canonicalGeometryHash
  })
  return {
    rotationDeg: input.rotationDeg,
    exactLegal,
    canonicalGeometryHash,
    usedWidthMm: dimensions?.widthMm,
    usedHeightMm: dimensions?.heightMm,
    requestedLongAxisUsedSpanMm: usedLongAxisSpanMm,
    requestedShortAxisShortfallMm,
    requestedLongAxisUsedSpanGrid: usedLongAxisSpanGrid,
    requestedShortAxisShortfallGrid,
    cavityCount: metrics.enclosedCavityCount,
    hullGapRatio: metrics.largestOccupiedHullGapRatio,
    hullGapDoubledAreaGrid2:
      metrics.exact?.largestOccupiedHullGapDoubledAreaGrid2,
    occupiedHullDoubledAreaGrid2:
      metrics.exact?.occupiedHullDoubledAreaGrid2,
    cohesionPasses: input.endpoint.certificate.passes,
    cohesionDeficit: input.endpoint.certificate.relativeDeficitSum,
    cohesionDeficitNumerator:
      input.endpoint.certificate.exactRelativeDeficitNumerator,
    cohesionDeficitDenominator:
      input.endpoint.certificate.exactRelativeDeficitDenominator,
    intrinsicEnvelopeAreaMm2: metrics.envelopeAreaMm2,
    intrinsicEnvelopeMaximumSideMm: metrics.envelopeMaximumSideMm,
    intrinsicEnvelopeSpanMm: metrics.envelopeSpanMm,
    intrinsicEnvelopeAreaGrid2: metrics.exact?.envelopeAreaGrid2,
    intrinsicEnvelopeMaximumSideGrid:
      metrics.exact?.envelopeMaximumSideGrid,
    intrinsicEnvelopeSpanGrid: metrics.exact?.envelopeSpanGrid,
    dominantStructuralContacts: metrics.dominantStructuralContacts,
    totalStructuralContacts: metrics.totalStructuralContacts,
    contactUnits: metrics.contactUnits,
    sharedBoundaryLengthMm: metrics.sharedBoundaryLengthMm,
    comparisonTuple: tuple
  }
}

function comparisonTuple(input: {
  readonly exactLegal: boolean
  readonly requestedLongAxisUsedSpanMm: number | undefined
  readonly cavityCount: number
  readonly hullGapRatio: number
  readonly cohesionPasses: boolean
  readonly cohesionDeficit: number
  readonly requestedShortAxisShortfallMm: number | undefined
  readonly intrinsicEnvelopeAreaMm2: number
  readonly intrinsicEnvelopeMaximumSideMm: number
  readonly intrinsicEnvelopeSpanMm: number
  readonly dominantStructuralContacts: number
  readonly totalStructuralContacts: number
  readonly contactUnits: number
  readonly sharedBoundaryLengthMm: number
  readonly canonicalGeometryHash: string | undefined
}): ReadonlyArray<number | string> {
  return [
    input.exactLegal ? 0 : 1,
    input.requestedShortAxisShortfallMm ?? Number.POSITIVE_INFINITY,
    input.requestedLongAxisUsedSpanMm ?? Number.POSITIVE_INFINITY,
    input.cavityCount,
    input.hullGapRatio,
    input.cohesionPasses ? 0 : 1,
    input.cohesionDeficit,
    input.intrinsicEnvelopeAreaMm2,
    input.intrinsicEnvelopeMaximumSideMm,
    input.intrinsicEnvelopeSpanMm,
    -input.dominantStructuralContacts,
    -input.totalStructuralContacts,
    -input.contactUnits,
    -input.sharedBoundaryLengthMm,
    input.canonicalGeometryHash ?? '￿'
  ]
}

interface DirectionalReference {
  readonly usedShortAxisSpanMm: number
  readonly usedLongAxisSpanMm: number
  readonly maximumSideMm: number
  readonly envelopeAreaMm2: number
  readonly usedShortAxisSpanGrid: number
  readonly usedLongAxisSpanGrid: number
  readonly maximumSideGrid: number
  readonly envelopeAreaGrid2: bigint
}

function directionalReference(input: {
  readonly sheet: SheetSpec
  readonly placedCollisionGeometries: ReadonlyArray<IrregularPlacedPiece>
  readonly requestedLongAxis: 'width' | 'height' | 'square'
  readonly requestedShortAxisMm: number
}): DirectionalReference | undefined {
  if (
    input.requestedLongAxis === 'square' ||
    input.placedCollisionGeometries.length === 0
  ) {
    return undefined
  }
  const state = new IrregularBeamState({
    remainingPreparedPieces: [],
    placedCollisionGeometries: input.placedCollisionGeometries,
    placementOrder: input.placedCollisionGeometries.map(placedPieceId)
  })
  const orientations = ([0, 90] as const).flatMap((rotationDeg) => {
    const oriented = state.withQuarterTurnBottomLeft(rotationDeg)
    if (
      oriented === undefined ||
      !assertCanonicalGridLegalLayout(
        input.sheet,
        oriented.placedCollisionGeometries
      )
    ) {
      return []
    }
    const dimensions = canonicalDimensions(
      oriented.placedCollisionGeometries
    )
    if (dimensions === undefined) return []
    const usedShortAxisSpanMm =
      input.requestedLongAxis === 'width'
        ? dimensions.heightMm
        : dimensions.widthMm
    const usedLongAxisSpanMm =
      input.requestedLongAxis === 'width'
        ? dimensions.widthMm
        : dimensions.heightMm
    const usedShortAxisSpanGrid =
      input.requestedLongAxis === 'width'
        ? dimensions.heightGrid
        : dimensions.widthGrid
    const usedLongAxisSpanGrid =
      input.requestedLongAxis === 'width'
        ? dimensions.widthGrid
        : dimensions.heightGrid
    const maximumSideGrid = Math.max(dimensions.widthGrid, dimensions.heightGrid)
    const envelopeAreaGrid2 = BigInt(dimensions.widthGrid) * BigInt(dimensions.heightGrid)
    return [
      {
        usedShortAxisSpanMm,
        usedLongAxisSpanMm,
        usedShortAxisSpanGrid,
        usedLongAxisSpanGrid,
        maximumSideMm: Math.max(
          dimensions.widthMm,
          dimensions.heightMm
        ),
        maximumSideGrid,
        envelopeAreaMm2:
          Number(envelopeAreaGrid2) / 1_000_000,
        envelopeAreaGrid2
      }
    ]
  })
  return orientations.toSorted(
    (first, second) =>
      second.usedShortAxisSpanGrid - first.usedShortAxisSpanGrid ||
      first.usedLongAxisSpanGrid - second.usedLongAxisSpanGrid
  )[0]
}

function directionalImprovementAdmitted(input: {
  readonly candidate: IntrinsicShortSideOrientationObservation
  readonly production: DirectionalReference
  readonly requestedShortAxisGrid: number | undefined
}): boolean {
  const candidateShortfall =
    input.candidate.requestedShortAxisShortfallGrid
  const candidateDepth =
    input.candidate.requestedLongAxisUsedSpanGrid
  if (
    candidateShortfall === undefined ||
    candidateDepth === undefined ||
    input.requestedShortAxisGrid === undefined ||
    input.requestedShortAxisGrid <= 0
  ) {
    return false
  }
  const candidateShortAxisSpanGrid =
    input.requestedShortAxisGrid - candidateShortfall
  const productionShortfall = Math.max(
    0,
    input.requestedShortAxisGrid -
      input.production.usedShortAxisSpanGrid
  )
  return (
    5n * BigInt(candidateShortAxisSpanGrid) >=
      4n * BigInt(input.requestedShortAxisGrid) &&
    2n * BigInt(candidateShortfall) <= BigInt(productionShortfall) &&
    candidateDepth <= input.production.maximumSideGrid
  )
}

function compareEndpointObservations(
  first: IntrinsicShortSideEndpointObservation,
  second: IntrinsicShortSideEndpointObservation
): number {
  return (
    compareOrientationObservations(first.selected, second.selected) ||
    first.canonicalGeometryHash.localeCompare(second.canonicalGeometryHash) ||
    first.archiveIndex - second.archiveIndex
  )
}

function compareOrientationObservations(
  first: IntrinsicShortSideOrientationObservation,
  second: IntrinsicShortSideOrientationObservation
): number {
  const exactDimensionComparison =
    Number(!first.exactLegal) - Number(!second.exactLegal) ||
    compareOptionalGrid(
      first.requestedShortAxisShortfallGrid,
      second.requestedShortAxisShortfallGrid
    ) ||
    compareOptionalGrid(
      first.requestedLongAxisUsedSpanGrid,
      second.requestedLongAxisUsedSpanGrid
    )
  if (exactDimensionComparison !== 0) return exactDimensionComparison
  return (
    first.cavityCount - second.cavityCount ||
    compareOptionalExactRatio(
      first.hullGapDoubledAreaGrid2,
      first.occupiedHullDoubledAreaGrid2,
      second.hullGapDoubledAreaGrid2,
      second.occupiedHullDoubledAreaGrid2
    ) ||
    Number(!first.cohesionPasses) - Number(!second.cohesionPasses) ||
    compareOptionalExactRatio(
      first.cohesionDeficitNumerator,
      first.cohesionDeficitDenominator,
      second.cohesionDeficitNumerator,
      second.cohesionDeficitDenominator
    ) ||
    compareOptionalBigIntStrings(
      first.intrinsicEnvelopeAreaGrid2,
      second.intrinsicEnvelopeAreaGrid2
    ) ||
    compareOptionalGrid(
      first.intrinsicEnvelopeMaximumSideGrid,
      second.intrinsicEnvelopeMaximumSideGrid
    ) ||
    compareOptionalGrid(
      first.intrinsicEnvelopeSpanGrid,
      second.intrinsicEnvelopeSpanGrid
    ) ||
    second.dominantStructuralContacts - first.dominantStructuralContacts ||
    second.totalStructuralContacts - first.totalStructuralContacts ||
    (first.canonicalGeometryHash ?? '￿').localeCompare(
      second.canonicalGeometryHash ?? '￿'
    ) ||
    first.rotationDeg - second.rotationDeg
  )
}

function compareOptionalExactRatio(
  firstNumerator: string | undefined,
  firstDenominator: string | undefined,
  secondNumerator: string | undefined,
  secondDenominator: string | undefined
): number {
  const firstDefined =
    firstNumerator !== undefined && firstDenominator !== undefined
  const secondDefined =
    secondNumerator !== undefined && secondDenominator !== undefined
  if (!firstDefined || !secondDefined) {
    return firstDefined === secondDefined ? 0 : firstDefined ? -1 : 1
  }
  return (
    compareCanonicalGridRatios(
      BigInt(firstNumerator),
      BigInt(firstDenominator),
      BigInt(secondNumerator),
      BigInt(secondDenominator)
    ) ?? 0
  )
}

function compareOptionalBigIntStrings(
  first: string | undefined,
  second: string | undefined
): number {
  if (first === undefined) return second === undefined ? 0 : 1
  if (second === undefined) return -1
  return compareBigInts(BigInt(first), BigInt(second))
}

function compareOptionalGrid(
  first: number | undefined,
  second: number | undefined
): number {
  if (first === undefined) return second === undefined ? 0 : 1
  if (second === undefined) return -1
  return first < second ? -1 : first > second ? 1 : 0
}

function canonicalDimensions(
  placed: ReadonlyArray<IrregularPlacedPiece>
):
  | {
      readonly widthMm: number
      readonly heightMm: number
      readonly widthGrid: number
      readonly heightGrid: number
    }
  | undefined {
  const points = placed.flatMap((entry) => placedCollisionWorldGridPath(entry) ?? [])
  if (points.length === 0) return undefined
  const minX = Math.min(...points.map(({ x }) => x))
  const minY = Math.min(...points.map(({ y }) => y))
  const maxX = Math.max(...points.map(({ x }) => x))
  const maxY = Math.max(...points.map(({ y }) => y))
  const widthGrid = maxX - minX
  const heightGrid = maxY - minY
  if (
    ![minX, minY, maxX, maxY, widthGrid, heightGrid].every(Number.isSafeInteger) ||
    widthGrid < 0 ||
    heightGrid < 0
  ) {
    return undefined
  }
  const widthMm = fromGrid(widthGrid)
  const heightMm = fromGrid(heightGrid)
  return Number.isFinite(widthMm) && Number.isFinite(heightMm)
    ? { widthMm, heightMm, widthGrid, heightGrid }
    : undefined
}

function hashCanonicalIdentity(identity: string | undefined): string | undefined {
  return identity === undefined ? undefined : createHash('sha256').update(identity).digest('hex')
}

export function withMeasuredIntrinsicShortSideObserverTrace(
  trace: IntrinsicShortSideObserverTrace
): IntrinsicShortSideObserverTrace {
  const firstMeasurement = Buffer.byteLength(JSON.stringify(trace), 'utf8')
  const measured = { ...trace, serializedTraceBytes: firstMeasurement }
  const finalMeasurement = Buffer.byteLength(JSON.stringify(measured), 'utf8')
  return { ...measured, serializedTraceBytes: finalMeasurement }
}

function censoredTrace(
  trace: IntrinsicShortSideObserverTrace,
  status: 'runtime-budget-exceeded' | 'trace-budget-exceeded',
  runtimeBudgetExceeded: boolean
): IntrinsicShortSideObserverTrace {
  return withMeasuredIntrinsicShortSideObserverTrace({
    ...trace,
    status,
    runtimeBudgetExceeded,
    endpoints: [],
    rankedCanonicalGeometryHashes: [],
    observerWinnerCanonicalGeometryHash: undefined,
    observerWinnerRotationDeg: undefined,
    serializedTraceBytes: 0
  })
}

function placedPieceId(placed: IrregularPlacedPiece): PieceId {
  return placed.placement.pieceId ?? placed.placement.sourcePieceId
}
