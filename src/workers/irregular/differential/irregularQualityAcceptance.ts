import { createHash } from 'node:crypto'
import type { NestingRequest } from '@shared/domain/nesting.js'
import type { IrregularBackend } from '@shared/irregular/backendSelection.js'
import {
  IrregularPreparedPiece,
  type CollisionGeometry,
  type IrregularPlacedPiece,
  type IrregularTransformCandidate,
  type TransformedCollisionGeometry
} from '@shared/irregular/domain.js'
import {
  assertCanonicalGridLegalLayout,
  canonicalCollisionLayoutIdentity,
  measureCanonicalEnclosedCavities,
  measureCanonicalLayoutEnvelope,
  measureCanonicalLayoutTopologyExact
} from '../canonicalLayoutGeometry.js'
import {
  intrinsicAnytimeSchedulerTraceValid,
  type IrregularComputeResult
} from '../../algorithm/irregular/computeIrregularNesting.js'
import {
  intrinsicCapacityLaneCoordinatorTraceValid,
  type IntrinsicCapacityQualityWarmPrefixTrace,
  type IntrinsicCapacityRouting
} from '../../algorithm/irregular/intrinsicCapacityMode.js'
import {
  compareIntrinsicCapacityObjectives,
  INTRINSIC_CAPACITY_EMPTY_LAYOUT_IDENTITY,
  type IntrinsicCapacityEndpointOrigin,
  type IntrinsicCapacityObjective
} from '../../algorithm/irregular/intrinsicCapacityEndpoint.js'
import {
  doubledGrid2ToMm2,
  intrinsicCapacityPreparedPieceId,
  preparedPieceDoubledMaterialAreaGrid2
} from '../../algorithm/irregular/intrinsicCapacityMaterial.js'
import {
  measureIntrinsicShortSideDirectionalReference,
  type IntrinsicShortSideDirectionalReference
} from '../../algorithm/irregular/intrinsicShortSideObserver.js'
import { computeTransformedCollisionGeometry } from '../core/transformCollisionGeometryCore.js'
import type { WorkerResponseFailureError } from '@shared/protocol/worker.js'
import type { IrregularDifferentialDivergence } from './irregularSemanticComparison.js'

export type IrregularQualityCategory =
  | 'exact-match'
  | 'different-but-quality-accepted'
  | 'quality-regression'
  | 'hard-invariant-failure'

export const IRREGULAR_AREA_TOLERANCE_MM2 = 0.000_001

export interface IrregularQualityTopologyFacts {
  readonly positiveContactComponentCount: number
  readonly isolatedPieceCount: number
  readonly largestPositiveContactComponentSize: number
  readonly largestOccupiedHullGapRatio?: number
  readonly occupiedEnvelopeAspectRatio?: number
}

export interface IrregularQualityThresholds {
  readonly minimumPlacedCount: number
  readonly maximumAreaMm2: number
  readonly maximumCanonicalCavities: number
  readonly maximumPositiveContactComponentCount: number
  readonly maximumIsolatedPieceCount: number
  readonly minimumLargestPositiveContactComponentSize: number
  readonly maximumOccupiedHullGapRatio: number
  readonly maximumOccupiedEnvelopeAspectRatio: number
}

export interface IrregularCapacityNotRequiredPolicy {
  readonly kind: 'not-required'
}

export interface IrregularCapacityQualityWarmPrefixExpectation {
  readonly status: IntrinsicCapacityQualityWarmPrefixTrace['status'] | undefined
  readonly outputInfluence: IntrinsicCapacityQualityWarmPrefixTrace['outputInfluence'] | undefined
  readonly sourceRole: string | undefined
  readonly prefixDepth: number | undefined
  readonly endpointCanonicalGeometryHash: string | undefined
}

export interface IrregularCapacityRequiredPolicy {
  readonly kind: 'required'
  readonly allowedRoutings: ReadonlyArray<IntrinsicCapacityRouting>
  readonly allowedSelectedOrigins: ReadonlyArray<IntrinsicCapacityEndpointOrigin>
  readonly expectedTerminationReason: 'capacity_subset_settled'
  readonly coldOnlyObjective?: IntrinsicCapacityObjective
  readonly requireColdOnlyDominance: boolean
  readonly expectedQualityWarmPrefix: IrregularCapacityQualityWarmPrefixExpectation
}

export type IrregularCapacityPolicy =
  | IrregularCapacityNotRequiredPolicy
  | IrregularCapacityRequiredPolicy

export interface IrregularCohesionNotRequiredPolicy {
  readonly kind: 'not-required'
}

export interface IrregularCohesionRequiredPolicy {
  readonly kind: 'required'
  readonly minimumPlacedCount: number
  readonly maximumCavities: number
  readonly maximumEnvelopeMaximumSideMm: number
  readonly maximumEnvelopeAreaMm2: number
  readonly maximumEnvelopeAreaInclusive: boolean
  readonly maximumPositiveContactComponentCount: number
  readonly maximumIsolatedPieceCount: number
  readonly requireLargestComponentContainsEveryPlacedPiece: boolean
}

export type IrregularCohesionPolicy =
  | IrregularCohesionNotRequiredPolicy
  | IrregularCohesionRequiredPolicy

export interface IrregularCompactQualityPolicy {
  readonly objectiveProfile: 'compact'
  readonly thresholds: IrregularQualityThresholds
  readonly capacity: IrregularCapacityPolicy
  readonly cohesion: IrregularCohesionPolicy
  readonly shortSide: { readonly kind: 'not-required' }
}

export interface IrregularShortSideQualityPolicy {
  readonly objectiveProfile: 'short-side'
  readonly thresholds: IrregularQualityThresholds
  readonly capacity: IrregularCapacityPolicy
  readonly cohesion: IrregularCohesionPolicy
  readonly shortSide: {
    readonly kind: 'required'
    readonly selectedPieceIds: ReadonlyArray<string>
  }
}

export type IrregularQualityPolicy = IrregularCompactQualityPolicy | IrregularShortSideQualityPolicy

export interface IrregularCohesionEvidence {
  readonly accepted: boolean
  readonly canonicalGeometryHash: string
  readonly placedCount: number
  readonly enclosedCavityCount: number
  readonly envelopeMaximumSideMm: number
  readonly envelopeAreaMm2: number
  readonly positiveContactComponentCount: number
  readonly isolatedPieceCount: number
  readonly largestPositiveContactComponentSize: number
}

/** Caller-owned Short Side geometry and construction witness. */
export interface IrregularShortSideAuthoritativeEvidence {
  readonly productionPlacedCollisionGeometries: ReadonlyArray<IrregularPlacedPiece>
  readonly directionalConstructionPlacedCollisionGeometries:
    | ReadonlyArray<IrregularPlacedPiece>
    | undefined
}

export interface IrregularQualityFacts {
  readonly backend: Extract<IrregularBackend, 'typescript' | 'rust'>
  readonly requestedPieceIds: ReadonlyArray<string>
  readonly placedPieceIds: ReadonlyArray<string | undefined>
  readonly unplacedPieceIds: ReadonlyArray<string>
  readonly legalGeometry: boolean
  readonly provenanceValid: boolean
  readonly placedCount: number
  readonly areaMm2: number | undefined
  readonly canonicalCavities: number | undefined
  readonly topology: IrregularQualityTopologyFacts | undefined
  readonly capacityContractValid: boolean
  readonly schedulerTraceValid: boolean
  readonly shortSideContractValid: boolean | undefined
  readonly cohesionContractValid: boolean | undefined
  readonly canonicalGeometryHash: string | undefined
}

export interface IrregularQualityAssessment {
  readonly hardInvariantFailures: ReadonlyArray<string>
  readonly qualityRegressions: ReadonlyArray<string>
  readonly hardInvariantPassed: boolean
  readonly qualityAccepted: boolean
}

export type IrregularQualityBackendOutcome =
  | { readonly ok: true; readonly facts: IrregularQualityFacts }
  | { readonly ok: false; readonly error: WorkerResponseFailureError }

export interface IrregularQualityDifferentialInput {
  readonly semanticDivergence: IrregularDifferentialDivergence | undefined
  readonly typescript: IrregularQualityBackendOutcome
  readonly rust: IrregularQualityBackendOutcome
  readonly policy: IrregularQualityPolicy
}

export interface IrregularQualityDifferentialResult {
  readonly category: IrregularQualityCategory
  readonly accepted: boolean
  readonly semanticDivergence: IrregularDifferentialDivergence | undefined
  readonly typescript: IrregularQualityAssessment
  readonly rust: IrregularQualityAssessment
  readonly hardInvariantFailures: ReadonlyArray<string>
  readonly qualityRegressions: ReadonlyArray<string>
  readonly backendFailures: ReadonlyArray<'typescript' | 'rust'>
}

export interface IrregularUnsnappedTranslatedEnvelope {
  readonly widthMm: number
  readonly heightMm: number
  readonly areaMm2: number
  readonly spanMm: number
}

export function makeCompactIrregularQualityPolicy(input: {
  readonly thresholds: IrregularQualityThresholds
  readonly capacity: IrregularCapacityPolicy
  readonly cohesion: IrregularCohesionPolicy
}): IrregularCompactQualityPolicy {
  validateThresholds(input.thresholds)
  validateCapacityPolicy(input.capacity)
  validateCohesionPolicy(input.cohesion)
  return {
    objectiveProfile: 'compact',
    thresholds: input.thresholds,
    capacity: input.capacity,
    cohesion: input.cohesion,
    shortSide: { kind: 'not-required' }
  }
}

export function makeShortSideIrregularQualityPolicy(input: {
  readonly thresholds: IrregularQualityThresholds
  readonly capacity: IrregularCapacityPolicy
  readonly cohesion: IrregularCohesionPolicy
  readonly selectedPieceIds: ReadonlyArray<string>
}): IrregularShortSideQualityPolicy {
  validateThresholds(input.thresholds)
  validateCapacityPolicy(input.capacity)
  validateCohesionPolicy(input.cohesion)
  if (
    input.selectedPieceIds.length === 0 ||
    new Set(input.selectedPieceIds).size !== input.selectedPieceIds.length ||
    input.selectedPieceIds.some((pieceId) => typeof pieceId !== 'string' || pieceId.length === 0)
  ) {
    throw new Error('Short Side quality policy requires a non-empty unique selected piece set.')
  }
  return {
    objectiveProfile: 'short-side',
    thresholds: input.thresholds,
    capacity: input.capacity,
    cohesion: input.cohesion,
    shortSide: {
      kind: 'required',
      selectedPieceIds: [...input.selectedPieceIds]
    }
  }
}

export function assertIrregularQualityPolicy(
  policy: unknown
): asserts policy is IrregularQualityPolicy {
  if (typeof policy !== 'object' || policy === null) {
    throw new Error('Irregular quality policy must be an object.')
  }
  const candidate = policy as {
    readonly objectiveProfile?: unknown
    readonly thresholds?: unknown
    readonly capacity?: unknown
    readonly cohesion?: unknown
    readonly shortSide?: {
      readonly kind?: unknown
      readonly selectedPieceIds?: unknown
    }
  }
  if (candidate.objectiveProfile !== 'compact' && candidate.objectiveProfile !== 'short-side') {
    throw new Error('Irregular quality policy requires a valid objective profile.')
  }
  if (typeof candidate.thresholds !== 'object' || candidate.thresholds === null) {
    throw new Error('Irregular quality policy requires complete thresholds.')
  }
  if (typeof candidate.capacity !== 'object' || candidate.capacity === null) {
    throw new Error('Irregular quality policy requires a capacity policy.')
  }
  if (typeof candidate.cohesion !== 'object' || candidate.cohesion === null) {
    throw new Error('Irregular quality policy requires a cohesion policy.')
  }
  validateThresholds(candidate.thresholds as IrregularQualityThresholds)
  validateCapacityPolicy(candidate.capacity as IrregularCapacityPolicy)
  validateCohesionPolicy(candidate.cohesion as IrregularCohesionPolicy)
  if (candidate.objectiveProfile === 'compact') {
    if (candidate.shortSide?.kind !== 'not-required') {
      throw new Error('Compact quality policy must disable Short Side requirements.')
    }
    return
  }
  const selectedPieceIds = candidate.shortSide?.selectedPieceIds
  if (
    candidate.shortSide?.kind !== 'required' ||
    !Array.isArray(selectedPieceIds) ||
    selectedPieceIds.length === 0 ||
    new Set(selectedPieceIds).size !== selectedPieceIds.length ||
    selectedPieceIds.some((pieceId) => typeof pieceId !== 'string' || pieceId.length === 0)
  ) {
    throw new Error('Short Side quality policy requires a non-empty selected piece set.')
  }
}

function validateThresholds(thresholds: IrregularQualityThresholds): void {
  const requiredKeys: ReadonlyArray<keyof IrregularQualityThresholds> = [
    'minimumPlacedCount',
    'maximumAreaMm2',
    'maximumCanonicalCavities',
    'maximumPositiveContactComponentCount',
    'maximumIsolatedPieceCount',
    'minimumLargestPositiveContactComponentSize',
    'maximumOccupiedHullGapRatio',
    'maximumOccupiedEnvelopeAspectRatio'
  ]
  const keys = Object.keys(thresholds)
  const values = requiredKeys.map((key) => thresholds[key])
  if (
    keys.length !== requiredKeys.length ||
    requiredKeys.some((key) => !Object.prototype.hasOwnProperty.call(thresholds, key)) ||
    values.some((value) => typeof value !== 'number' || !Number.isFinite(value) || value < 0)
  ) {
    throw new Error('Irregular quality policy requires all finite non-negative thresholds.')
  }
}

function validateCapacityPolicy(policy: IrregularCapacityPolicy): void {
  if (policy.kind === 'not-required') return
  if (policy.kind !== 'required') {
    throw new Error('Required capacity policy is incomplete.')
  }
  if (
    !Array.isArray(policy.allowedSelectedOrigins) ||
    policy.allowedSelectedOrigins.length === 0 ||
    policy.allowedSelectedOrigins.some(
      (origin) =>
        origin !== 'cold-search' &&
        origin !== 'prefix-incumbent' &&
        origin !== 'warm-prefix-continuation'
    )
  ) {
    throw new Error('Required capacity policy needs selected endpoint origins.')
  }
  if (
    !Array.isArray(policy.allowedRoutings) ||
    policy.allowedRoutings.length === 0 ||
    policy.allowedRoutings.some(
      (routing) =>
        routing !== 'preflight-proven-impossible' && routing !== 'bounded-complete-archive-miss'
    ) ||
    policy.expectedTerminationReason !== 'capacity_subset_settled' ||
    typeof policy.requireColdOnlyDominance !== 'boolean' ||
    (policy.requireColdOnlyDominance && policy.coldOnlyObjective === undefined)
  ) {
    throw new Error('Required capacity policy is incomplete.')
  }
  validateQualityWarmPrefixExpectation(policy.expectedQualityWarmPrefix)
}

function validateQualityWarmPrefixExpectation(expectation: unknown): void {
  const requiredKeys: ReadonlyArray<keyof IrregularCapacityQualityWarmPrefixExpectation> = [
    'status',
    'outputInfluence',
    'sourceRole',
    'prefixDepth',
    'endpointCanonicalGeometryHash'
  ]
  if (typeof expectation !== 'object' || expectation === null) {
    throw new Error('Required capacity policy quality warm-prefix expectation is incomplete.')
  }
  const candidate = expectation as Record<string, unknown>
  if (
    Object.keys(candidate).length !== requiredKeys.length ||
    requiredKeys.some((key) => !Object.prototype.hasOwnProperty.call(candidate, key))
  ) {
    throw new Error('Required capacity policy quality warm-prefix expectation is incomplete.')
  }
  const validStatuses = [
    'skipped-below-minimum-piece-count',
    'skipped-no-fitting-canonical-prefix',
    'settled',
    'evaluation-cap',
    'checkpointed-censored'
  ]
  const validOutputInfluences = ['none', 'strict-count-improvement']
  if (
    (candidate.status !== undefined && !validStatuses.includes(candidate.status as string)) ||
    (candidate.outputInfluence !== undefined &&
      !validOutputInfluences.includes(candidate.outputInfluence as string)) ||
    (candidate.sourceRole !== undefined && typeof candidate.sourceRole !== 'string') ||
    (candidate.prefixDepth !== undefined &&
      (!Number.isSafeInteger(candidate.prefixDepth) || (candidate.prefixDepth as number) < 0)) ||
    (candidate.endpointCanonicalGeometryHash !== undefined &&
      (typeof candidate.endpointCanonicalGeometryHash !== 'string' ||
        candidate.endpointCanonicalGeometryHash.length === 0))
  ) {
    throw new Error('Required capacity policy quality warm-prefix expectation is invalid.')
  }
}

function validateCohesionPolicy(policy: IrregularCohesionPolicy): void {
  if (policy.kind === 'not-required') return
  if (policy.kind !== 'required') {
    throw new Error('Required cohesion policy is incomplete.')
  }
  const values = [
    policy.minimumPlacedCount,
    policy.maximumCavities,
    policy.maximumEnvelopeMaximumSideMm,
    policy.maximumEnvelopeAreaMm2,
    policy.maximumPositiveContactComponentCount,
    policy.maximumIsolatedPieceCount
  ]
  if (
    values.some((value) => !Number.isFinite(value) || value < 0) ||
    typeof policy.maximumEnvelopeAreaInclusive !== 'boolean' ||
    typeof policy.requireLargestComponentContainsEveryPlacedPiece !== 'boolean'
  ) {
    throw new Error('Required cohesion policy is incomplete.')
  }
}

export function exactIrregularPiecePartition(
  requestedPieceIds: ReadonlyArray<string>,
  placedPieceIds: ReadonlyArray<string | undefined>,
  unplacedPieceIds: ReadonlyArray<string>
): boolean {
  if (
    requestedPieceIds.some((pieceId) => typeof pieceId !== 'string') ||
    placedPieceIds.some((pieceId) => typeof pieceId !== 'string') ||
    unplacedPieceIds.some((pieceId) => typeof pieceId !== 'string')
  ) {
    return false
  }
  const requested = new Set(requestedPieceIds)
  const placed = new Set(placedPieceIds as ReadonlyArray<string>)
  const unplaced = new Set(unplacedPieceIds)
  const accounted = [...placedPieceIds, ...unplacedPieceIds]
  return (
    requested.size === requestedPieceIds.length &&
    placed.size === placedPieceIds.length &&
    unplaced.size === unplacedPieceIds.length &&
    accounted.length === requestedPieceIds.length &&
    accounted.every((pieceId) => typeof pieceId === 'string' && requested.has(pieceId)) &&
    requestedPieceIds.every((pieceId) => placed.has(pieceId) !== unplaced.has(pieceId))
  )
}

export function measureIrregularUnsnappedTranslatedEnvelope(
  placed: ReadonlyArray<Pick<IrregularPlacedPiece, 'placement' | 'collisionGeometry'>>
): IrregularUnsnappedTranslatedEnvelope {
  const points = placed.flatMap(({ placement, collisionGeometry }) =>
    collisionGeometry.polygon.points.map(({ x, y }) => ({
      x: x + placement.transform.translateX,
      y: y + placement.transform.translateY
    }))
  )
  if (points.length === 0) {
    return { widthMm: 0, heightMm: 0, areaMm2: 0, spanMm: 0 }
  }
  const xs = points.map(({ x }) => x)
  const ys = points.map(({ y }) => y)
  const widthMm = Math.max(...xs) - Math.min(...xs)
  const heightMm = Math.max(...ys) - Math.min(...ys)
  return { widthMm, heightMm, areaMm2: widthMm * heightMm, spanMm: widthMm + heightMm }
}

function sameNumber(first: number, second: number): boolean {
  return Object.is(first, second) || first === second
}

function sha256CanonicalGeometryHash(
  placed: ReadonlyArray<IrregularPlacedPiece>
): string | undefined {
  const identity = canonicalCollisionLayoutIdentity(placed)
  return identity === undefined ? undefined : createHash('sha256').update(identity).digest('hex')
}

function sameTransformCandidate(
  first: IrregularTransformCandidate,
  second: IrregularTransformCandidate
): boolean {
  return (
    first.index === second.index &&
    sameNumber(first.rotationDeg, second.rotationDeg) &&
    first.mirrored === second.mirrored &&
    first.reason === second.reason
  )
}

function samePlacementTransform(
  placement: IrregularPlacedPiece['placement'],
  candidate: IrregularTransformCandidate
): boolean {
  return (
    sameNumber(placement.transform.rotationDeg, candidate.rotationDeg) &&
    placement.transform.mirrored === candidate.mirrored
  )
}

function samePolygon(
  first: TransformedCollisionGeometry['polygon'],
  second: TransformedCollisionGeometry['polygon']
): boolean {
  return (
    first.points.length === second.points.length &&
    first.points.every(
      (point, index) =>
        sameNumber(point.x, second.points[index]?.x ?? Number.NaN) &&
        sameNumber(point.y, second.points[index]?.y ?? Number.NaN)
    )
  )
}

function sameBounds(
  first: TransformedCollisionGeometry['bounds'],
  second: TransformedCollisionGeometry['bounds']
): boolean {
  return (
    sameNumber(first.minX, second.minX) &&
    sameNumber(first.minY, second.minY) &&
    sameNumber(first.maxX, second.maxX) &&
    sameNumber(first.maxY, second.maxY)
  )
}

function sameOptionalPoint(
  first: { readonly x: number; readonly y: number } | undefined,
  second: { readonly x: number; readonly y: number } | undefined
): boolean {
  if (first === undefined || second === undefined) return first === second
  return sameNumber(first.x, second.x) && sameNumber(first.y, second.y)
}

function samePlacedCollisionGeometry(
  first: IrregularPlacedPiece,
  second: IrregularPlacedPiece
): boolean {
  return (
    first.placement.pieceId === second.placement.pieceId &&
    first.placement.sourcePieceId === second.placement.sourcePieceId &&
    sameOptionalPoint(first.placement.placementReference, second.placement.placementReference) &&
    sameNumber(first.placement.transform.translateX, second.placement.transform.translateX) &&
    sameNumber(first.placement.transform.translateY, second.placement.transform.translateY) &&
    sameNumber(first.placement.transform.rotationDeg, second.placement.transform.rotationDeg) &&
    first.placement.transform.mirrored === second.placement.transform.mirrored &&
    first.collisionGeometry.sourcePieceId === second.collisionGeometry.sourcePieceId &&
    sameTransformCandidate(first.collisionGeometry.transform, second.collisionGeometry.transform) &&
    samePolygon(first.collisionGeometry.polygon, second.collisionGeometry.polygon) &&
    sameBounds(first.collisionGeometry.bounds, second.collisionGeometry.bounds)
  )
}

function sameOrderedPlacedCollisionGeometries(
  first: ReadonlyArray<IrregularPlacedPiece>,
  second: ReadonlyArray<IrregularPlacedPiece>
): boolean {
  return (
    first.length === second.length &&
    first.every((placed, index) => {
      const other = second[index]
      return other !== undefined && samePlacedCollisionGeometry(placed, other)
    })
  )
}

function finitePoint(point: { readonly x: number; readonly y: number } | undefined): boolean {
  return point !== undefined && Number.isFinite(point.x) && Number.isFinite(point.y)
}

function finiteBounds(
  bounds:
    | {
        readonly minX: number
        readonly minY: number
        readonly maxX: number
        readonly maxY: number
      }
    | undefined
): boolean {
  return (
    bounds !== undefined &&
    [bounds.minX, bounds.minY, bounds.maxX, bounds.maxY].every(Number.isFinite)
  )
}

function finiteCollisionGeometry(geometry: CollisionGeometry | undefined): boolean {
  return (
    geometry !== undefined &&
    finiteBounds(geometry.sourceBounds) &&
    finitePoint(geometry.placementReference) &&
    Array.isArray(geometry.sampledPoints) &&
    geometry.sampledPoints.every(finitePoint) &&
    Array.isArray(geometry.convexHull?.points) &&
    geometry.convexHull.points.every(finitePoint) &&
    Array.isArray(geometry.collisionPolygon?.points) &&
    geometry.collisionPolygon.points.every(finitePoint)
  )
}

function finiteTransformCandidate(candidate: IrregularTransformCandidate): boolean {
  return Number.isSafeInteger(candidate.index) && Number.isFinite(candidate.rotationDeg)
}

function finiteTransformedCollisionGeometry(
  geometry: TransformedCollisionGeometry | undefined
): boolean {
  return (
    geometry !== undefined &&
    finiteTransformCandidate(geometry.transform) &&
    Array.isArray(geometry.polygon?.points) &&
    geometry.polygon.points.every(finitePoint) &&
    finiteBounds(geometry.bounds)
  )
}

function finiteTransform(placement: IrregularPlacedPiece['placement']): boolean {
  return [
    placement.transform.translateX,
    placement.transform.translateY,
    placement.transform.rotationDeg,
    placement.placementReference?.x,
    placement.placementReference?.y
  ].every((value) => value === undefined || Number.isFinite(value))
}

export function validateIrregularPlacedGeometryProvenance(input: {
  readonly request: NestingRequest
  readonly result: {
    readonly placedCollisionGeometries: ReadonlyArray<IrregularPlacedPiece>
    readonly unplacedPieceIds: ReadonlyArray<string>
  }
  readonly geometryAuthority: ReadonlyArray<IrregularPreparedPiece>
}): ReadonlyArray<string> {
  const failures: string[] = []
  const requestedIds = input.request.pieces.map(({ id }) => String(id))
  const authorityByPieceId = new Map(
    input.geometryAuthority.map((prepared) => [String(prepared.pieceId), prepared])
  )
  const seenGeometry = new Set<string>()
  for (const [index, placed] of input.result.placedCollisionGeometries.entries()) {
    const pieceId = placed.placement.pieceId
    if (pieceId === undefined) {
      failures.push(`placed[${index}].pieceId`)
      continue
    }
    const pieceIdString = String(pieceId)
    const prepared = authorityByPieceId.get(pieceIdString)
    if (prepared === undefined || !requestedIds.includes(pieceIdString)) {
      failures.push(`placed[${index}].pieceId.provenance`)
      continue
    }
    const preparedSourcePieceId = String(prepared.source.id)
    const requestedPiece = input.request.pieces.find(
      (candidatePiece) => String(candidatePiece.id) === pieceIdString
    )
    if (
      requestedPiece === undefined ||
      String(requestedPiece.sourcePieceId) !== preparedSourcePieceId
    ) {
      failures.push(`placed[${index}].request.sourcePieceId`)
    }
    if (preparedSourcePieceId !== String(placed.placement.sourcePieceId)) {
      failures.push(`placed[${index}].sourcePieceId`)
    }
    if (String(placed.collisionGeometry.sourcePieceId) !== preparedSourcePieceId) {
      failures.push(`placed[${index}].collisionGeometry.sourcePieceId`)
    }
    if (!finiteCollisionGeometry(prepared.collisionGeometry)) {
      failures.push(`placed[${index}].authority.geometry.finite`)
      continue
    }
    if (!finiteTransformedCollisionGeometry(placed.collisionGeometry)) {
      failures.push(`placed[${index}].geometry.finite`)
      continue
    }
    if (!finiteTransform(placed.placement)) {
      failures.push(`placed[${index}].transform.finite`)
      continue
    }
    if (
      placed.placement.placementReference !== undefined &&
      (!sameNumber(
        placed.placement.placementReference.x,
        prepared.collisionGeometry.placementReference.x
      ) ||
        !sameNumber(
          placed.placement.placementReference.y,
          prepared.collisionGeometry.placementReference.y
        ))
    ) {
      failures.push(`placed[${index}].placementReference`)
    }
    const candidate = prepared.transforms.find((transform) =>
      samePlacementTransform(placed.placement, transform)
    )
    if (candidate === undefined) {
      failures.push(`placed[${index}].transform.authority`)
      continue
    }
    if (!sameTransformCandidate(placed.collisionGeometry.transform, candidate)) {
      failures.push(`placed[${index}].collisionGeometry.transform`)
    }
    const computed = computeTransformedCollisionGeometry({
      geometry: prepared.collisionGeometry as CollisionGeometry,
      transform: candidate
    })
    if (!computed.ok) {
      failures.push(`placed[${index}].geometry.recompute`)
      continue
    }
    if (!samePolygon(placed.collisionGeometry.polygon, computed.value.polygon)) {
      failures.push(`placed[${index}].geometry.polygon`)
    }
    if (!sameBounds(placed.collisionGeometry.bounds, computed.value.bounds)) {
      failures.push(`placed[${index}].geometry.bounds`)
    }
    const geometryKey = JSON.stringify({
      pieceId: pieceIdString,
      sourcePieceId: String(placed.collisionGeometry.sourcePieceId),
      translateX: placed.placement.transform.translateX,
      translateY: placed.placement.transform.translateY,
      transform: placed.collisionGeometry.transform,
      polygon: placed.collisionGeometry.polygon.points
    })
    if (seenGeometry.has(geometryKey)) failures.push(`placed[${index}].geometry.duplicate`)
    seenGeometry.add(geometryKey)
  }
  if (
    !exactIrregularPiecePartition(
      requestedIds,
      input.result.placedCollisionGeometries.map(({ placement }) =>
        placement.pieceId === undefined ? undefined : String(placement.pieceId)
      ),
      input.result.unplacedPieceIds.map(String)
    )
  ) {
    failures.push('exactPiecePartition')
  }
  return [...new Set(failures)]
}

type IrregularCapacityTrace = NonNullable<IrregularComputeResult['capacityTrace']>

function sameCapacityObjectiveIdentity(
  first: IntrinsicCapacityObjective,
  second: IntrinsicCapacityObjective
): boolean {
  return (
    first.canonicalGeometryHash === second.canonicalGeometryHash &&
    first.origin === second.origin &&
    first.sourceRole === second.sourceRole &&
    first.prefixDepth === second.prefixDepth
  )
}

function sameCapacityObjective(
  first: IntrinsicCapacityObjective,
  second: IntrinsicCapacityObjective
): boolean {
  return (
    first.placedCount === second.placedCount &&
    first.placedDoubledMaterialAreaGrid2 === second.placedDoubledMaterialAreaGrid2 &&
    first.enclosedCavityCount === second.enclosedCavityCount &&
    sameNumber(first.totalEnclosedCavityAreaMm2, second.totalEnclosedCavityAreaMm2) &&
    first.totalEnclosedCavityDoubledAreaGrid2 === second.totalEnclosedCavityDoubledAreaGrid2 &&
    sameNumber(first.envelopeMaximumSideMm, second.envelopeMaximumSideMm) &&
    sameNumber(first.envelopeAreaMm2, second.envelopeAreaMm2) &&
    sameNumber(first.envelopeSpanMm, second.envelopeSpanMm) &&
    first.envelopeMaximumSideGrid === second.envelopeMaximumSideGrid &&
    first.envelopeAreaGrid2 === second.envelopeAreaGrid2 &&
    first.envelopeSpanGrid === second.envelopeSpanGrid &&
    first.canonicalGeometryHash === second.canonicalGeometryHash &&
    first.origin === second.origin &&
    first.prefixDepth === second.prefixDepth &&
    first.sourceRole === second.sourceRole
  )
}

function capacityGeometryHash(placed: ReadonlyArray<IrregularPlacedPiece>): string | undefined {
  if (placed.length === 0) {
    return createHash('sha256').update(INTRINSIC_CAPACITY_EMPTY_LAYOUT_IDENTITY).digest('hex')
  }
  const identity = canonicalCollisionLayoutIdentity(placed)
  return identity === undefined ? undefined : createHash('sha256').update(identity).digest('hex')
}

function prefixDescriptorMatches(
  trace: IrregularCapacityTrace,
  sourceRole: string | undefined,
  prefixDepth: number | undefined
): boolean {
  return (
    sourceRole !== undefined &&
    prefixDepth !== undefined &&
    Array.isArray(trace.prefixes?.descriptors) &&
    trace.prefixes.descriptors.some(
      (descriptor) => descriptor.role === sourceRole && descriptor.depth === prefixDepth
    )
  )
}

function capacitySelectedProducerValid(trace: IrregularCapacityTrace): boolean {
  const selected = trace.selected
  switch (selected.origin) {
    case 'cold-search':
      return selected.sourceRole === undefined && selected.prefixDepth === undefined
    case 'prefix-incumbent':
      return (
        trace.prefixIncumbent !== undefined &&
        prefixDescriptorMatches(
          trace,
          trace.prefixIncumbent.sourceRole,
          trace.prefixIncumbent.prefixDepth
        ) &&
        trace.prefixIncumbent.canonicalGeometryHash === selected.canonicalGeometryHash &&
        trace.prefixIncumbent.sourceRole === selected.sourceRole &&
        trace.prefixIncumbent.prefixDepth === selected.prefixDepth
      )
    case 'warm-prefix-continuation':
      return (
        (trace.warmPrefixLanes ?? []).some(
          (lane) =>
            lane.selectedForContinuation &&
            prefixDescriptorMatches(trace, lane.sourceRole, lane.prefixDepth) &&
            lane.endpoint !== undefined &&
            sameCapacityObjectiveIdentity(lane.endpoint, selected)
        ) ||
        (trace.qualityWarmPrefix?.outputInfluence === 'strict-count-improvement' &&
          prefixDescriptorMatches(
            trace,
            trace.qualityWarmPrefix.sourceRole,
            trace.qualityWarmPrefix.prefixDepth
          ) &&
          trace.qualityWarmPrefix.endpoint !== undefined &&
          sameCapacityObjectiveIdentity(trace.qualityWarmPrefix.endpoint, selected))
      )
  }
}

function qualityWarmPrefixMatches(
  trace: IrregularCapacityTrace,
  expected: IrregularCapacityQualityWarmPrefixExpectation
): boolean {
  const actual = trace.qualityWarmPrefix
  if (actual === undefined) {
    return (
      expected.status === undefined &&
      expected.outputInfluence === undefined &&
      expected.sourceRole === undefined &&
      expected.prefixDepth === undefined &&
      expected.endpointCanonicalGeometryHash === undefined
    )
  }
  return (
    actual.version === 'intrinsic-capacity-quality-warm-prefix-v1' &&
    actual.producerRole === 'capacity-quality-warm-prefix' &&
    actual.policy === 'quality-frontier' &&
    actual.status === expected.status &&
    actual.outputInfluence === expected.outputInfluence &&
    actual.sourceRole === expected.sourceRole &&
    actual.prefixDepth === expected.prefixDepth &&
    actual.endpoint?.canonicalGeometryHash === expected.endpointCanonicalGeometryHash
  )
}

function recomputeCapacityObjective(input: {
  readonly result: IrregularComputeResult
  readonly trace: IrregularCapacityTrace
  readonly geometryAuthority: ReadonlyArray<IrregularPreparedPiece>
  readonly placedPieceIds: ReadonlyArray<string | undefined>
  readonly unplacedCount: number
}): IntrinsicCapacityObjective | undefined {
  const placed = input.result.placedCollisionGeometries
  if (
    input.placedPieceIds.some((pieceId) => pieceId === undefined) ||
    new Set(input.placedPieceIds).size !== input.placedPieceIds.length
  ) {
    return undefined
  }
  const materialAreas = new Map(
    input.geometryAuthority.map((prepared) => [
      String(intrinsicCapacityPreparedPieceId(prepared)),
      preparedPieceDoubledMaterialAreaGrid2(prepared)
    ])
  )
  let placedDoubledMaterialAreaGrid2 = 0n
  for (const pieceId of input.placedPieceIds) {
    if (pieceId === undefined) return undefined
    const materialArea = materialAreas.get(pieceId)
    if (materialArea === undefined) return undefined
    placedDoubledMaterialAreaGrid2 += materialArea
  }
  const cavities =
    placed.length === 0
      ? { count: 0, totalAreaMm2: 0, totalDoubledAreaGrid2: '0' }
      : measureCanonicalEnclosedCavities(placed)
  const envelope =
    placed.length === 0
      ? {
          maximumSideMm: 0,
          areaMm2: 0,
          spanMm: 0,
          maximumSideGrid: 0,
          envelopeAreaGrid2: '0',
          spanGrid: 0
        }
      : measureCanonicalLayoutEnvelope(placed)
  const canonicalGeometryHash = capacityGeometryHash(placed)
  if (cavities === undefined || envelope === undefined || canonicalGeometryHash === undefined) {
    return undefined
  }
  return {
    placedCount: input.placedPieceIds.length,
    placedDoubledMaterialAreaGrid2,
    enclosedCavityCount: cavities.count,
    totalEnclosedCavityAreaMm2: cavities.totalAreaMm2,
    totalEnclosedCavityDoubledAreaGrid2: cavities.totalDoubledAreaGrid2,
    envelopeMaximumSideMm: envelope.maximumSideMm,
    envelopeAreaMm2: envelope.areaMm2,
    envelopeSpanMm: envelope.spanMm,
    envelopeMaximumSideGrid: envelope.maximumSideGrid,
    envelopeAreaGrid2: envelope.envelopeAreaGrid2,
    envelopeSpanGrid: envelope.spanGrid,
    canonicalGeometryHash,
    origin: input.trace.selected.origin,
    prefixDepth: input.trace.selected.prefixDepth,
    sourceRole: input.trace.selected.sourceRole
  }
}

function capacityContractValid(input: {
  readonly result: IrregularComputeResult
  readonly policy: IrregularCapacityPolicy
  readonly requestedCount: number
  readonly requestedPieceIds: ReadonlyArray<string>
  readonly placedPieceIds: ReadonlyArray<string | undefined>
  readonly unplacedPieceIds: ReadonlyArray<string>
  readonly unplacedCount: number
  readonly geometryAuthority: ReadonlyArray<IrregularPreparedPiece>
}): boolean {
  if (input.policy.kind === 'not-required') return true
  if (
    !exactIrregularPiecePartition(
      input.requestedPieceIds,
      input.placedPieceIds,
      input.unplacedPieceIds
    )
  ) {
    return false
  }
  const trace = input.result.capacityTrace
  if (trace === undefined || !input.policy.allowedRoutings.includes(trace.routing)) return false
  if (
    !input.policy.allowedSelectedOrigins.includes(trace.selected.origin) ||
    !capacitySelectedProducerValid(trace) ||
    !qualityWarmPrefixMatches(trace, input.policy.expectedQualityWarmPrefix) ||
    trace.selected.unplacedCount !== input.unplacedCount ||
    trace.selected.placedCount + trace.selected.unplacedCount !== input.requestedCount ||
    trace.selected.placedMaterialAreaMm2 !==
      doubledGrid2ToMm2(trace.selected.placedDoubledMaterialAreaGrid2) ||
    (trace.selected.selectedRotationDeg !== 0 && trace.selected.selectedRotationDeg !== 90) ||
    trace.coldSearch.settlement === 'paused' ||
    trace.coldSearch.auxiliaryPlacementEvaluations !== 0 ||
    trace.coldSearch.completedDepths !== trace.coldSearch.pieceCount ||
    trace.laneCoordinator === undefined ||
    !intrinsicCapacityLaneCoordinatorTraceValid(
      trace.laneCoordinator,
      trace.warmPrefixLanes ?? [],
      trace.qualityWarmPrefix
    ) ||
    (trace.warmPrefixLanes ?? []).filter(({ selectedForContinuation }) => selectedForContinuation)
      .length > 1 ||
    input.result.portfolio.terminationReason !== input.policy.expectedTerminationReason
  ) {
    return false
  }
  const recomputed = recomputeCapacityObjective({
    result: input.result,
    trace,
    geometryAuthority: input.geometryAuthority,
    placedPieceIds: input.placedPieceIds,
    unplacedCount: input.unplacedCount
  })
  if (recomputed === undefined || !sameCapacityObjective(recomputed, trace.selected)) {
    return false
  }
  if (
    input.policy.requireColdOnlyDominance &&
    (input.policy.coldOnlyObjective === undefined ||
      compareIntrinsicCapacityObjectives(recomputed, input.policy.coldOnlyObjective) > 0)
  ) {
    return false
  }
  return true
}

function authoritativeShortSideGeometryValid(input: {
  readonly request: NestingRequest
  readonly selectedPieceIds: ReadonlySet<string>
  readonly placedCollisionGeometries: ReadonlyArray<IrregularPlacedPiece> | undefined
  readonly requestedPieceIds: ReadonlyArray<string>
  readonly geometryAuthority: ReadonlyArray<IrregularPreparedPiece>
}): boolean {
  const placed = input.placedCollisionGeometries
  if (placed === undefined) return false
  const placedPieceIds = placed.map(({ placement }) =>
    placement.pieceId === undefined ? undefined : String(placement.pieceId)
  )
  const unplacedPieceIds = input.requestedPieceIds.filter(
    (pieceId) => !input.selectedPieceIds.has(pieceId)
  )
  if (
    validateIrregularPlacedGeometryProvenance({
      request: input.request,
      result: { placedCollisionGeometries: placed, unplacedPieceIds },
      geometryAuthority: input.geometryAuthority
    }).length > 0 ||
    placedPieceIds.some((pieceId) => pieceId === undefined)
  ) {
    return false
  }
  const normalizedPlacedPieceIds = placedPieceIds as ReadonlyArray<string>
  if (
    new Set(normalizedPlacedPieceIds).size !== normalizedPlacedPieceIds.length ||
    normalizedPlacedPieceIds.length !== input.selectedPieceIds.size ||
    normalizedPlacedPieceIds.some((pieceId) => !input.selectedPieceIds.has(pieceId))
  ) {
    return false
  }
  try {
    return assertCanonicalGridLegalLayout(input.request.sheet, placed)
  } catch {
    return false
  }
}

function shortSideProductionReference(input: {
  readonly request: NestingRequest
  readonly policy: IrregularShortSideQualityPolicy
  readonly authority: IrregularShortSideAuthoritativeEvidence | undefined
  readonly geometryAuthority: ReadonlyArray<IrregularPreparedPiece>
}):
  | {
      readonly production: IntrinsicShortSideDirectionalReference
      readonly preparedPieces: ReadonlyArray<IrregularPreparedPiece>
      readonly directionalConstructionPlacedCollisionGeometries: ReadonlyArray<IrregularPlacedPiece>
    }
  | undefined {
  if (input.authority === undefined) return undefined
  const selectedPieceIds = new Set(input.policy.shortSide.selectedPieceIds)
  const requestedPieceIds = input.request.pieces.map(({ id }) => String(id))
  if (
    !authoritativeShortSideGeometryValid({
      request: input.request,
      selectedPieceIds,
      placedCollisionGeometries: input.authority.productionPlacedCollisionGeometries,
      requestedPieceIds,
      geometryAuthority: input.geometryAuthority
    }) ||
    !authoritativeShortSideGeometryValid({
      request: input.request,
      selectedPieceIds,
      placedCollisionGeometries: input.authority.directionalConstructionPlacedCollisionGeometries,
      requestedPieceIds,
      geometryAuthority: input.geometryAuthority
    })
  ) {
    return undefined
  }
  const production = measureIntrinsicShortSideDirectionalReference({
    sheet: input.request.sheet,
    placedCollisionGeometries: input.authority.productionPlacedCollisionGeometries
  })
  if (production === undefined) return undefined
  const preparedById = new Map(
    input.geometryAuthority.map((prepared) => [
      String(prepared.pieceId ?? prepared.source.id),
      prepared
    ])
  )
  const preparedPieces = input.policy.shortSide.selectedPieceIds.map((pieceId) =>
    preparedById.get(pieceId)
  )
  return preparedPieces.every(
    (prepared): prepared is IrregularPreparedPiece => prepared !== undefined
  )
    ? {
        production,
        preparedPieces,
        directionalConstructionPlacedCollisionGeometries: input.authority
          .directionalConstructionPlacedCollisionGeometries as ReadonlyArray<IrregularPlacedPiece>
      }
    : undefined
}

function shortSideContractValid(input: {
  readonly result: IrregularComputeResult
  readonly policy: IrregularQualityPolicy
  readonly request: NestingRequest
  readonly geometryAuthority: ReadonlyArray<IrregularPreparedPiece>
  readonly shortSideAuthority: IrregularShortSideAuthoritativeEvidence | undefined
  readonly requestedPieceIds: ReadonlyArray<string>
  readonly placedPieceIds: ReadonlyArray<string>
}): boolean | undefined {
  if (input.policy.objectiveProfile !== 'short-side') return undefined
  const expectedPlaced = new Set(input.policy.shortSide.selectedPieceIds)
  const actualPlaced = new Set(input.placedPieceIds)
  const expectedUnplaced = new Set(input.requestedPieceIds.filter((id) => !expectedPlaced.has(id)))
  const actualUnplaced = new Set(input.result.unplacedPieceIds.map(String))
  const reference = shortSideProductionReference({
    request: input.request,
    policy: input.policy,
    authority: input.shortSideAuthority,
    geometryAuthority: input.geometryAuthority
  })
  return (
    reference !== undefined &&
    expectedPlaced.size === actualPlaced.size &&
    [...expectedPlaced].every((pieceId) => actualPlaced.has(pieceId)) &&
    expectedUnplaced.size === actualUnplaced.size &&
    [...expectedUnplaced].every((pieceId) => actualUnplaced.has(pieceId)) &&
    sameOrderedPlacedCollisionGeometries(
      input.result.placedCollisionGeometries,
      reference.directionalConstructionPlacedCollisionGeometries
    )
  )
}

function cohesionContractValid(
  placed: ReadonlyArray<IrregularPlacedPiece>,
  evidence: IrregularCohesionEvidence | undefined,
  policy: IrregularCohesionPolicy
): boolean | undefined {
  if (policy.kind === 'not-required') return undefined
  if (
    evidence === undefined ||
    typeof evidence.accepted !== 'boolean' ||
    typeof evidence.canonicalGeometryHash !== 'string' ||
    evidence.canonicalGeometryHash.length === 0 ||
    !Number.isSafeInteger(evidence.placedCount) ||
    evidence.placedCount < 0 ||
    !Number.isSafeInteger(evidence.enclosedCavityCount) ||
    evidence.enclosedCavityCount < 0 ||
    [evidence.envelopeMaximumSideMm, evidence.envelopeAreaMm2].some(
      (value) => !Number.isFinite(value) || value < 0
    ) ||
    !Number.isSafeInteger(evidence.positiveContactComponentCount) ||
    evidence.positiveContactComponentCount < 0 ||
    !Number.isSafeInteger(evidence.isolatedPieceCount) ||
    evidence.isolatedPieceCount < 0 ||
    !Number.isSafeInteger(evidence.largestPositiveContactComponentSize) ||
    evidence.largestPositiveContactComponentSize < 0
  ) {
    return false
  }
  const hash = sha256CanonicalGeometryHash(placed)
  const cavities =
    placed.length === 0 ? { count: 0, totalAreaMm2: 0 } : measureCanonicalEnclosedCavities(placed)
  const envelope =
    placed.length === 0 ? { maximumSideMm: 0, areaMm2: 0 } : measureCanonicalLayoutEnvelope(placed)
  const topology =
    placed.length === 0
      ? {
          positiveContactComponentCount: 0,
          isolatedPieceCount: 0,
          largestPositiveContactComponentSize: 0
        }
      : measureCanonicalLayoutTopologyExact(placed)?.topology
  if (
    hash === undefined ||
    cavities === undefined ||
    envelope === undefined ||
    topology === undefined
  ) {
    return false
  }
  return (
    evidence.accepted &&
    evidence.canonicalGeometryHash === hash &&
    evidence.placedCount === placed.length &&
    evidence.enclosedCavityCount === cavities.count &&
    sameNumber(evidence.envelopeMaximumSideMm, envelope.maximumSideMm) &&
    sameNumber(evidence.envelopeAreaMm2, envelope.areaMm2) &&
    evidence.positiveContactComponentCount === topology.positiveContactComponentCount &&
    evidence.isolatedPieceCount === topology.isolatedPieceCount &&
    evidence.largestPositiveContactComponentSize === topology.largestPositiveContactComponentSize &&
    evidence.placedCount >= policy.minimumPlacedCount &&
    evidence.enclosedCavityCount <= policy.maximumCavities &&
    evidence.envelopeMaximumSideMm <= policy.maximumEnvelopeMaximumSideMm &&
    (policy.maximumEnvelopeAreaInclusive
      ? evidence.envelopeAreaMm2 <= policy.maximumEnvelopeAreaMm2
      : evidence.envelopeAreaMm2 < policy.maximumEnvelopeAreaMm2) &&
    evidence.positiveContactComponentCount <= policy.maximumPositiveContactComponentCount &&
    evidence.isolatedPieceCount <= policy.maximumIsolatedPieceCount &&
    (!policy.requireLargestComponentContainsEveryPlacedPiece ||
      evidence.largestPositiveContactComponentSize === evidence.placedCount)
  )
}

export function assessIrregularQualityFacts(
  facts: IrregularQualityFacts,
  policy: IrregularQualityPolicy
): IrregularQualityAssessment {
  assertIrregularQualityPolicy(policy)
  const hardInvariantFailures: string[] = []
  const qualityRegressions: string[] = []
  if (
    !exactIrregularPiecePartition(
      facts.requestedPieceIds,
      facts.placedPieceIds,
      facts.unplacedPieceIds
    )
  ) {
    hardInvariantFailures.push('exactPiecePartition')
  }
  if (
    !Number.isSafeInteger(facts.placedCount) ||
    facts.placedCount < 0 ||
    facts.placedCount !== facts.placedPieceIds.length
  ) {
    hardInvariantFailures.push('placedCountAccounting')
  }
  if (!facts.provenanceValid) hardInvariantFailures.push('geometryProvenance')
  if (!facts.legalGeometry) hardInvariantFailures.push('legalGeometry')
  if (!facts.capacityContractValid) hardInvariantFailures.push('capacityTrace')
  if (!facts.schedulerTraceValid) hardInvariantFailures.push('schedulerTrace')
  if (facts.areaMm2 === undefined || !Number.isFinite(facts.areaMm2) || facts.areaMm2 < 0) {
    hardInvariantFailures.push('areaMeasurement')
  }
  if (
    facts.canonicalCavities === undefined ||
    !Number.isSafeInteger(facts.canonicalCavities) ||
    facts.canonicalCavities < 0
  ) {
    hardInvariantFailures.push('cavityMeasurement')
  }
  if (facts.topology === undefined) {
    hardInvariantFailures.push('topologyMeasurement')
  } else if (
    !Number.isSafeInteger(facts.topology.positiveContactComponentCount) ||
    facts.topology.positiveContactComponentCount < 0 ||
    !Number.isSafeInteger(facts.topology.isolatedPieceCount) ||
    facts.topology.isolatedPieceCount < 0 ||
    !Number.isSafeInteger(facts.topology.largestPositiveContactComponentSize) ||
    facts.topology.largestPositiveContactComponentSize < 0 ||
    facts.topology.positiveContactComponentCount > facts.placedCount ||
    facts.topology.isolatedPieceCount > facts.placedCount ||
    facts.topology.largestPositiveContactComponentSize > facts.placedCount ||
    [facts.topology.largestOccupiedHullGapRatio, facts.topology.occupiedEnvelopeAspectRatio].some(
      (value) => value !== undefined && (!Number.isFinite(value) || value < 0)
    )
  ) {
    hardInvariantFailures.push('topologyAccounting')
  }
  if (policy.objectiveProfile === 'short-side' && facts.shortSideContractValid !== true) {
    hardInvariantFailures.push('shortSideDirectionalGeometry')
  }
  if (policy.cohesion.kind === 'required' && facts.cohesionContractValid !== true) {
    hardInvariantFailures.push('cohesion')
  }

  const thresholds = policy.thresholds
  if (facts.placedCount < thresholds.minimumPlacedCount)
    qualityRegressions.push('minimumPlacedCount')
  if (
    facts.areaMm2 !== undefined &&
    facts.areaMm2 > thresholds.maximumAreaMm2 + IRREGULAR_AREA_TOLERANCE_MM2
  ) {
    qualityRegressions.push('maximumAreaMm2')
  }
  if (
    facts.canonicalCavities !== undefined &&
    facts.canonicalCavities > thresholds.maximumCanonicalCavities
  ) {
    qualityRegressions.push('maximumCanonicalCavities')
  }
  if (facts.topology !== undefined) {
    if (
      facts.topology.positiveContactComponentCount > thresholds.maximumPositiveContactComponentCount
    ) {
      qualityRegressions.push('maximumPositiveContactComponentCount')
    }
    if (facts.topology.isolatedPieceCount > thresholds.maximumIsolatedPieceCount) {
      qualityRegressions.push('maximumIsolatedPieceCount')
    }
    if (
      facts.topology.largestPositiveContactComponentSize <
      thresholds.minimumLargestPositiveContactComponentSize
    ) {
      qualityRegressions.push('minimumLargestPositiveContactComponentSize')
    }
    if (
      facts.topology.largestOccupiedHullGapRatio !== undefined &&
      facts.topology.largestOccupiedHullGapRatio > thresholds.maximumOccupiedHullGapRatio
    ) {
      qualityRegressions.push('maximumOccupiedHullGapRatio')
    }
    if (
      facts.topology.occupiedEnvelopeAspectRatio !== undefined &&
      facts.topology.occupiedEnvelopeAspectRatio > thresholds.maximumOccupiedEnvelopeAspectRatio
    ) {
      qualityRegressions.push('maximumOccupiedEnvelopeAspectRatio')
    }
  }
  return {
    hardInvariantFailures,
    qualityRegressions,
    hardInvariantPassed: hardInvariantFailures.length === 0,
    qualityAccepted: qualityRegressions.length === 0
  }
}

export function classifyIrregularQualityDifferential(
  input: IrregularQualityDifferentialInput
): IrregularQualityDifferentialResult {
  assertIrregularQualityPolicy(input.policy)
  const typescript = input.typescript.ok
    ? assessIrregularQualityFacts(input.typescript.facts, input.policy)
    : {
        hardInvariantFailures: ['backendFailure'],
        qualityRegressions: [],
        hardInvariantPassed: false,
        qualityAccepted: false
      }
  const rust = input.rust.ok
    ? assessIrregularQualityFacts(input.rust.facts, input.policy)
    : {
        hardInvariantFailures: ['backendFailure'],
        qualityRegressions: [],
        hardInvariantPassed: false,
        qualityAccepted: false
      }
  const hardInvariantFailures = [
    ...(input.typescript.ok && input.typescript.facts.backend === 'typescript'
      ? []
      : ['typescript.backendIdentity']),
    ...(input.rust.ok && input.rust.facts.backend === 'rust' ? [] : ['rust.backendIdentity']),
    ...typescript.hardInvariantFailures.map((failure) => `typescript.${failure}`),
    ...rust.hardInvariantFailures.map((failure) => `rust.${failure}`)
  ]
  const qualityRegressions = [
    ...typescript.qualityRegressions.map((failure) => `typescript.${failure}`),
    ...rust.qualityRegressions.map((failure) => `rust.${failure}`)
  ]
  const backendFailures = [
    ...(input.typescript.ok ? [] : (['typescript'] as const)),
    ...(input.rust.ok ? [] : (['rust'] as const))
  ]
  const category: IrregularQualityCategory =
    backendFailures.length > 0
      ? input.semanticDivergence === undefined && backendFailures.length === 2
        ? 'exact-match'
        : 'hard-invariant-failure'
      : hardInvariantFailures.length > 0
        ? 'hard-invariant-failure'
        : qualityRegressions.length > 0
          ? 'quality-regression'
          : input.semanticDivergence === undefined
            ? 'exact-match'
            : 'different-but-quality-accepted'
  return {
    category,
    accepted:
      backendFailures.length === 0 &&
      category !== 'quality-regression' &&
      category !== 'hard-invariant-failure',
    semanticDivergence: input.semanticDivergence,
    typescript,
    rust,
    hardInvariantFailures,
    qualityRegressions,
    backendFailures
  }
}

export function makeIrregularQualityFacts(input: {
  readonly backend: Extract<IrregularBackend, 'typescript' | 'rust'>
  readonly request: NestingRequest
  readonly result: IrregularComputeResult
  readonly policy: IrregularQualityPolicy
  readonly geometryAuthority: ReadonlyArray<IrregularPreparedPiece>
  readonly shortSideAuthority?: IrregularShortSideAuthoritativeEvidence
  readonly cohesionEvidence?: IrregularCohesionEvidence
}): IrregularQualityFacts {
  assertIrregularQualityPolicy(input.policy)
  const requestedPieceIds = input.request.pieces.map(({ id }) => String(id))
  const placedPieceIds = input.result.placedCollisionGeometries.map(({ placement }) =>
    placement.pieceId === undefined ? undefined : String(placement.pieceId)
  )
  const unplacedPieceIds = input.result.unplacedPieceIds.map(String)
  const provenanceFailures = validateIrregularPlacedGeometryProvenance({
    request: input.request,
    result: input.result,
    geometryAuthority: input.geometryAuthority
  })
  let legalGeometry = false
  try {
    legalGeometry = assertCanonicalGridLegalLayout(
      input.request.sheet,
      input.result.placedCollisionGeometries
    )
  } catch {
    legalGeometry = false
  }
  const topology = (() => {
    try {
      return measureCanonicalLayoutTopologyExact(input.result.placedCollisionGeometries)?.topology
    } catch {
      return undefined
    }
  })()
  const envelope = measureIrregularUnsnappedTranslatedEnvelope(
    input.result.placedCollisionGeometries
  )
  const canonicalGeometryHash = (() => {
    try {
      return sha256CanonicalGeometryHash(input.result.placedCollisionGeometries)
    } catch {
      return undefined
    }
  })()
  const capacityValid = capacityContractValid({
    result: input.result,
    policy: input.policy.capacity,
    requestedCount: requestedPieceIds.length,
    requestedPieceIds,
    placedPieceIds,
    unplacedPieceIds,
    unplacedCount: unplacedPieceIds.length,
    geometryAuthority: input.geometryAuthority
  })
  const schedulerTraceValid =
    input.result.intrinsicAnytimeSchedulerTrace === undefined ||
    intrinsicAnytimeSchedulerTraceValid(input.result.intrinsicAnytimeSchedulerTrace)
  return {
    backend: input.backend,
    requestedPieceIds,
    placedPieceIds,
    unplacedPieceIds,
    legalGeometry,
    provenanceValid: provenanceFailures.length === 0,
    placedCount: placedPieceIds.length,
    areaMm2: envelope.areaMm2,
    canonicalCavities: topology?.enclosedCavityCount,
    topology,
    capacityContractValid: capacityValid,
    schedulerTraceValid,
    shortSideContractValid: shortSideContractValid({
      result: input.result,
      policy: input.policy,
      request: input.request,
      geometryAuthority: input.geometryAuthority,
      shortSideAuthority: input.shortSideAuthority,
      requestedPieceIds,
      placedPieceIds: placedPieceIds.filter((pieceId): pieceId is string => pieceId !== undefined)
    }),
    cohesionContractValid: cohesionContractValid(
      input.result.placedCollisionGeometries,
      input.cohesionEvidence,
      input.policy.cohesion
    ),
    canonicalGeometryHash
  }
}
