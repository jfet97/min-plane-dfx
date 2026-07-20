import { Data, Effect } from 'effect'
import type { PieceId } from '@shared/domain/ids.js'
import { SheetSpec } from '@shared/domain/nesting.js'
import {
  IrregularPlacedPiece,
  IrregularPlacement,
  IrregularPlacementCandidate,
  IrregularPreparedPiece,
  IrregularTransform,
  type IrregularNestingSettings,
  type IrregularTransformCandidate,
  type TransformedCollisionGeometry
} from '@shared/irregular/domain.js'
import {
  analyzeCanonicalLayoutStructure,
  assertCanonicalGridLegalLayout,
  canonicalCollisionLayoutIdentity,
  placedCollisionWorldGridPath,
  type CanonicalLayoutStructuralAnalysis
} from '../../irregular/canonicalLayoutGeometry.js'
import { fromGrid, toGridMm } from '../../irregular/clipper2OffsetPolicy.js'
import { GeometryKernel, GeometrySettings } from '../../irregular/geometryKernel.js'
import {
  IrregularGeometryInputError,
  IrregularNfpIfpCandidateMemoScope,
  type IrregularNfpIfpControl,
  IrregularNfpIfpControlAbortError,
  IrregularNestingNotImplementedError,
  NfpIfpService
} from '../../irregular/services.js'
import { canonicalCollisionPolygonKey } from './irregularBeamState.js'

export interface IntrinsicTargetBox {
  readonly widthMm: number
  readonly heightMm: number
}

export interface IntrinsicProjectionGridPoint {
  readonly x: number
  readonly y: number
}

export interface IntrinsicFiniteTransform {
  readonly transform: IrregularTransformCandidate
  readonly geometry: TransformedCollisionGeometry
  readonly orientationFamily: string
  readonly canonicalLocalGeometryKey: string
  readonly canonicalTransformKey: string
}

export interface IntrinsicTransformCatalogEntry {
  readonly pieceId: PieceId
  readonly preparedPiece: IrregularPreparedPiece
  readonly transforms: ReadonlyArray<IntrinsicFiniteTransform>
}

export interface IntrinsicTransformCatalog {
  readonly entries: ReadonlyArray<IntrinsicTransformCatalogEntry>
  readonly canonicalKey: string
}

export interface IntrinsicProjectionConflictAnalysis {
  readonly targetBox: IntrinsicTargetBox
  readonly structure: CanonicalLayoutStructuralAnalysis
  readonly removedPieceIds: ReadonlyArray<PieceId>
  readonly frozenPlaced: ReadonlyArray<IrregularPlacedPiece>
  readonly frozenRemainderExactLegal: true
}

export interface IntrinsicExactProjectionResult {
  readonly placedCollisionGeometries: ReadonlyArray<IrregularPlacedPiece>
  readonly canonicalGeometryIdentity: string
  readonly initialRemovedPieceIds: ReadonlyArray<PieceId>
  readonly finalRemovedPieceIds: ReadonlyArray<PieceId>
  readonly transformedPieceIds: ReadonlyArray<PieceId>
  readonly directPosePieceIds: ReadonlyArray<PieceId>
  readonly orientationFallbackPieceIds: ReadonlyArray<PieceId>
  readonly dilationSteps: number
}

export class IntrinsicExactProjectionError extends Data.TaggedError(
  'IntrinsicExactProjectionError'
)<{
  readonly operation:
    | 'buildTransformCatalog'
    | 'analyzeConflictClosure'
    | 'canonicalizeProvisional'
    | 'projectConflictClosure'
  readonly category: 'invalid-input' | 'exact-analysis' | 'projection-exhausted'
  readonly message: string
  readonly failedPieceId?: PieceId
  readonly attempts?: number
}> {}

interface CanonicalTargetBox {
  readonly descriptor: IntrinsicTargetBox
  readonly sheet: SheetSpec
  readonly widthGrid: number
  readonly heightGrid: number
}

interface ProjectionCandidate {
  readonly placed: IrregularPlacedPiece
  readonly directProvisionalPose: boolean
  readonly preservesPinnedTransform: boolean
  readonly squaredGridDistance: bigint
  readonly maximumSideGrid: bigint
  readonly envelopeAreaGrid2: bigint
  readonly envelopeSpanGrid: bigint
  readonly canonicalGeometryIdentity: string
}

interface ProjectionAttemptSuccess {
  readonly placed: ReadonlyArray<IrregularPlacedPiece>
  readonly directPosePieceIds: ReadonlyArray<PieceId>
  readonly orientationFallbackPieceIds: ReadonlyArray<PieceId>
}

interface ProjectionAttemptFailure {
  readonly failedPieceId: PieceId
}

/** Builds the finite transformed-geometry domain without reading a target or requested sheet. */
export function buildIntrinsicTransformCatalog(
  pieces: ReadonlyArray<IrregularPreparedPiece>
): Effect.Effect<
  IntrinsicTransformCatalog,
  IntrinsicExactProjectionError | IrregularNestingNotImplementedError | IrregularGeometryInputError,
  GeometryKernel
> {
  return Effect.gen(function* () {
    const geometryKernel = yield* GeometryKernel
    const pieceIds = pieces.map(preparedPieceId)
    if (new Set(pieceIds).size !== pieceIds.length) {
      return yield* failProjection(
        'buildTransformCatalog',
        'invalid-input',
        'prepared piece ids must be unique.'
      )
    }

    const entries: IntrinsicTransformCatalogEntry[] = []
    for (const preparedPiece of pieces) {
      const transforms: IntrinsicFiniteTransform[] = []
      for (const transform of [...preparedPiece.transforms].toSorted(compareTransforms)) {
        const geometry = yield* geometryKernel.transformCollisionGeometry({
          geometry: preparedPiece.collisionGeometry,
          transform
        })
        const localGeometryKey = canonicalLocalGeometryKey(geometry)
        if (localGeometryKey === undefined) {
          return yield* failProjection(
            'buildTransformCatalog',
            'invalid-input',
            `piece ${preparedPieceId(preparedPiece)} has a transform outside the canonical grid.`
          )
        }
        transforms.push({
          transform,
          geometry,
          orientationFamily: orientationFamilyKey(transform),
          canonicalLocalGeometryKey: localGeometryKey,
          canonicalTransformKey: transformKey(transform)
        })
      }
      if (transforms.length === 0) {
        return yield* failProjection(
          'buildTransformCatalog',
          'invalid-input',
          `piece ${preparedPieceId(preparedPiece)} has no finite transform.`
        )
      }
      entries.push({
        pieceId: preparedPieceId(preparedPiece),
        preparedPiece,
        transforms
      })
    }

    return {
      entries,
      canonicalKey: JSON.stringify(
        entries.map((entry) => [
          entry.pieceId,
          entry.transforms.map((transform) => [
            transform.canonicalTransformKey,
            transform.canonicalLocalGeometryKey
          ])
        ])
      )
    }
  })
}

/** Removes every exact conflict endpoint and target-wall offender, then proves the remainder. */
export function analyzeIntrinsicProjectionConflicts(
  targetBox: IntrinsicTargetBox,
  placed: ReadonlyArray<IrregularPlacedPiece>
): Effect.Effect<IntrinsicProjectionConflictAnalysis, IntrinsicExactProjectionError> {
  const target = canonicalTargetBox(targetBox)
  if (target === undefined) {
    return failProjection(
      'analyzeConflictClosure',
      'invalid-input',
      'the intrinsic target box must have positive finite canonical-grid dimensions.'
    )
  }
  const structure = analyzeCanonicalLayoutStructure(target.sheet, placed)
  if (structure === undefined) {
    return failProjection(
      'analyzeConflictClosure',
      'exact-analysis',
      'canonical conflict and wall analysis could not be completed.'
    )
  }
  const exactWallOffenders = structure.pieces
    .filter(
      ({ aabb }) =>
        aabb.minX < 0 ||
        aabb.minY < 0 ||
        aabb.maxX > target.widthGrid ||
        aabb.maxY > target.heightGrid
    )
    .map(({ pieceId }) => pieceId)
    .toSorted()
  const exactStructure = { ...structure, wallOffenders: exactWallOffenders }
  const removed = new Set<PieceId>(exactWallOffenders)
  for (const [first, second] of structure.positiveAreaConflicts) {
    removed.add(first)
    removed.add(second)
  }
  const removedPieceIds = [...removed].toSorted()
  const frozenPlaced = placed.filter((entry) => !removed.has(placedPieceId(entry)))
  if (!assertExactTargetLegal(target, frozenPlaced)) {
    return failProjection(
      'analyzeConflictClosure',
      'exact-analysis',
      'removing every conflict endpoint and wall offender did not leave an exact-legal remainder.'
    )
  }
  return Effect.succeed({
    targetBox: target.descriptor,
    structure: exactStructure,
    removedPieceIds,
    frozenPlaced,
    frozenRemainderExactLegal: true
  })
}

/**
 * Projects one provisional finite-transform layout into an intrinsic target box.
 * Only a complete canonical-exact-legal layout can be returned.
 */
export function projectIntrinsicLayoutExactly(input: {
  readonly targetBox: IntrinsicTargetBox
  readonly catalog: IntrinsicTransformCatalog
  readonly referencePlaced: ReadonlyArray<IrregularPlacedPiece>
  readonly provisionalPlaced: ReadonlyArray<IrregularPlacedPiece>
  readonly reinsertionPriorityPieceIds: ReadonlyArray<PieceId>
  readonly maximumDilationSteps?: number
  readonly control?: IrregularNfpIfpControl
}): Effect.Effect<
  IntrinsicExactProjectionResult,
  | IntrinsicExactProjectionError
  | IrregularNestingNotImplementedError
  | IrregularGeometryInputError
  | IrregularNfpIfpControlAbortError,
  GeometrySettings | NfpIfpService
> {
  return Effect.gen(function* () {
    const settings = yield* GeometrySettings
    const nfpIfp = yield* NfpIfpService
    const target = canonicalTargetBox(input.targetBox)
    if (target === undefined) {
      return yield* failProjection(
        'canonicalizeProvisional',
        'invalid-input',
        'the intrinsic target box must have positive finite canonical-grid dimensions.'
      )
    }
    const catalogById = new Map(input.catalog.entries.map((entry) => [entry.pieceId, entry]))
    if (catalogById.size !== input.catalog.entries.length) {
      return yield* failProjection(
        'canonicalizeProvisional',
        'invalid-input',
        'the transform catalog must contain unique piece ids.'
      )
    }
    const reinsertionPriority = validateReinsertionPriority(
      input.catalog,
      input.reinsertionPriorityPieceIds
    )
    if (reinsertionPriority === undefined) {
      return yield* failProjection(
        'canonicalizeProvisional',
        'invalid-input',
        'reinsertionPriorityPieceIds must be an exact permutation of the transform catalog piece ids.'
      )
    }
    const candidateMemoScope = new IrregularNfpIfpCandidateMemoScope()
    const provisional = yield* canonicalizePlacedAgainstCatalog(
      input.catalog,
      input.provisionalPlaced
    )
    const referenceTransforms = yield* referenceTransformKeys(input.catalog, input.referencePlaced)
    const provisionalById = new Map(provisional.map((entry) => [placedPieceId(entry), entry]))
    const transformedPieceIds = input.catalog.entries
      .filter((entry) => {
        const provisionalEntry = provisionalById.get(entry.pieceId)
        const referenceTransform = referenceTransforms.get(entry.pieceId)
        return (
          provisionalEntry !== undefined &&
          referenceTransform !== transformKey(provisionalEntry.collisionGeometry.transform)
        )
      })
      .map(({ pieceId }) => pieceId)

    const conflictAnalysis = yield* analyzeIntrinsicProjectionConflicts(
      target.descriptor,
      provisional
    )
    const removed = new Set<PieceId>([
      ...conflictAnalysis.removedPieceIds,
      ...transformedPieceIds
    ])
    const initialRemovedPieceIds = orderedPriorityIds(reinsertionPriority, removed)
    const requestedMaximumDilationSteps =
      input.maximumDilationSteps ?? input.catalog.entries.length
    if (!Number.isFinite(requestedMaximumDilationSteps)) {
      return yield* failProjection(
        'canonicalizeProvisional',
        'invalid-input',
        'maximumDilationSteps must be finite.'
      )
    }
    const maximumDilationSteps = Math.max(
      0,
      Math.min(
        input.catalog.entries.length,
        Math.floor(requestedMaximumDilationSteps)
      )
    )

    for (let dilationSteps = 0; dilationSteps <= maximumDilationSteps; dilationSteps += 1) {
      yield* projectionCheckpoint(input.control)
      const frozen = provisional.filter((entry) => !removed.has(placedPieceId(entry)))
      if (!assertExactTargetLegal(target, frozen)) {
        return yield* failProjection(
          'projectConflictClosure',
          'exact-analysis',
          'the current closure dilation did not retain an exact-legal frozen remainder.'
        )
      }
      const attempt = yield* projectRemovedPieces({
        target,
        catalog: input.catalog,
        provisionalById,
        removed,
        frozen,
        settings,
        nfpIfp,
        reinsertionPriority,
        catalogById,
        candidateMemoScope,
        control: input.control
      })
      if ('placed' in attempt) {
        const canonicalGeometryIdentity = canonicalCollisionLayoutIdentity(attempt.placed)
        if (
          attempt.placed.length !== input.catalog.entries.length ||
          canonicalGeometryIdentity === undefined ||
          !assertExactTargetLegal(target, attempt.placed)
        ) {
          return yield* failProjection(
            'projectConflictClosure',
            'exact-analysis',
            'a projection attempt completed without a publishable canonical exact layout.'
          )
        }
        return {
          placedCollisionGeometries: attempt.placed,
          canonicalGeometryIdentity,
          initialRemovedPieceIds,
          finalRemovedPieceIds: orderedPriorityIds(reinsertionPriority, removed),
          transformedPieceIds,
          directPosePieceIds: attempt.directPosePieceIds,
          orientationFallbackPieceIds: attempt.orientationFallbackPieceIds,
          dilationSteps
        }
      }

      const dilationPieceId = selectClosureDilationPiece(
        reinsertionPriority,
        provisionalById,
        removed,
        attempt.failedPieceId
      )
      if (dilationSteps >= maximumDilationSteps || dilationPieceId === undefined) {
        return yield* failProjection(
          'projectConflictClosure',
          'projection-exhausted',
          `exact projection exhausted its closure dilation path at piece ${attempt.failedPieceId}.`,
          attempt.failedPieceId,
          dilationSteps + 1
        )
      }
      removed.add(dilationPieceId)
    }

    return yield* failProjection(
      'projectConflictClosure',
      'projection-exhausted',
      'exact projection exhausted its bounded closure dilation path.',
      undefined,
      maximumDilationSteps + 1
    )
  })
}

function canonicalizePlacedAgainstCatalog(
  catalog: IntrinsicTransformCatalog,
  placed: ReadonlyArray<IrregularPlacedPiece>
): Effect.Effect<ReadonlyArray<IrregularPlacedPiece>, IntrinsicExactProjectionError> {
  const placedById = new Map<PieceId, IrregularPlacedPiece>()
  for (const entry of placed) {
    const pieceId = placedPieceId(entry)
    if (placedById.has(pieceId)) {
      return failProjection(
        'canonicalizeProvisional',
        'invalid-input',
        `provisional piece id ${pieceId} is duplicated.`
      )
    }
    placedById.set(pieceId, entry)
  }
  if (placedById.size !== catalog.entries.length) {
    return failProjection(
      'canonicalizeProvisional',
      'invalid-input',
      'provisional placements must exactly cover the transform catalog.'
    )
  }
  const result: IrregularPlacedPiece[] = []
  for (const catalogEntry of catalog.entries) {
    const provisional = placedById.get(catalogEntry.pieceId)
    if (provisional === undefined) {
      return failProjection(
        'canonicalizeProvisional',
        'invalid-input',
        `provisional placement is missing piece ${catalogEntry.pieceId}.`
      )
    }
    const transform = catalogEntry.transforms.find(
      (candidate) => candidate.canonicalTransformKey === transformKey(provisional.collisionGeometry.transform)
    )
    const translateX = provisional.placement.transform.translateX
    const translateY = provisional.placement.transform.translateY
    if (
      transform === undefined ||
      !Number.isFinite(translateX) ||
      !Number.isFinite(translateY) ||
      normalizedRotationDeg(provisional.placement.transform.rotationDeg) !==
        normalizedRotationDeg(transform.transform.rotationDeg) ||
      provisional.placement.transform.mirrored !== transform.transform.mirrored
    ) {
      return failProjection(
        'canonicalizeProvisional',
        'invalid-input',
        `provisional piece ${catalogEntry.pieceId} must use one catalog transform and a canonicalizable translation.`
      )
    }
    const canonical = makePlaced(catalogEntry, transform, { x: translateX, y: translateY })
    const provisionalPath = placedCollisionWorldGridPath(provisional)
    const canonicalPath = placedCollisionWorldGridPath(canonical)
    if (
      provisionalPath === undefined ||
      canonicalPath === undefined ||
      gridPathKey(provisionalPath) !== gridPathKey(canonicalPath)
    ) {
      return failProjection(
        'canonicalizeProvisional',
        'invalid-input',
        `provisional piece ${catalogEntry.pieceId} could not preserve its canonical world path.`
      )
    }
    result.push(canonical)
  }
  return Effect.succeed(result)
}

function referenceTransformKeys(
  catalog: IntrinsicTransformCatalog,
  referencePlaced: ReadonlyArray<IrregularPlacedPiece>
): Effect.Effect<ReadonlyMap<PieceId, string>, IntrinsicExactProjectionError> {
  const referenceById = new Map<PieceId, IrregularPlacedPiece>()
  for (const entry of referencePlaced) referenceById.set(placedPieceId(entry), entry)
  if (referenceById.size !== catalog.entries.length || referencePlaced.length !== catalog.entries.length) {
    return failProjection(
      'canonicalizeProvisional',
      'invalid-input',
      'reference placements must exactly cover the transform catalog with unique piece ids.'
    )
  }
  const result = new Map<PieceId, string>()
  for (const entry of catalog.entries) {
    const reference = referenceById.get(entry.pieceId)
    if (reference === undefined) {
      return failProjection(
        'canonicalizeProvisional',
        'invalid-input',
        `reference placement is missing piece ${entry.pieceId}.`
      )
    }
    const key = transformKey(reference.collisionGeometry.transform)
    if (!entry.transforms.some((transform) => transform.canonicalTransformKey === key)) {
      return failProjection(
        'canonicalizeProvisional',
        'invalid-input',
        `reference piece ${entry.pieceId} does not use a catalog transform.`
      )
    }
    result.set(entry.pieceId, key)
  }
  return Effect.succeed(result)
}

function projectRemovedPieces(input: {
  readonly target: CanonicalTargetBox
  readonly catalog: IntrinsicTransformCatalog
  readonly provisionalById: ReadonlyMap<PieceId, IrregularPlacedPiece>
  readonly removed: ReadonlySet<PieceId>
  readonly frozen: ReadonlyArray<IrregularPlacedPiece>
  readonly settings: IrregularNestingSettings
  readonly nfpIfp: NfpIfpService
  readonly reinsertionPriority: ReadonlyArray<PieceId>
  readonly catalogById: ReadonlyMap<PieceId, IntrinsicTransformCatalogEntry>
  readonly candidateMemoScope: IrregularNfpIfpCandidateMemoScope
  readonly control: IrregularNfpIfpControl | undefined
}): Effect.Effect<
  ProjectionAttemptSuccess | ProjectionAttemptFailure,
  | IrregularNestingNotImplementedError
  | IrregularGeometryInputError
  | IrregularNfpIfpControlAbortError
> {
  return Effect.gen(function* () {
    let placed = [...input.frozen]
    const directPosePieceIds: PieceId[] = []
    const orientationFallbackPieceIds: PieceId[] = []
    for (const pieceId of input.reinsertionPriority) {
      if (!input.removed.has(pieceId)) continue
      const entry = input.catalogById.get(pieceId)
      if (entry === undefined) return { failedPieceId: pieceId }
      yield* projectionCheckpoint(input.control)
      const provisional = input.provisionalById.get(entry.pieceId)
      if (provisional === undefined) return { failedPieceId: entry.pieceId }
      const pinnedKey = transformKey(provisional.collisionGeometry.transform)
      const pinned = entry.transforms.find(
        (transform) => transform.canonicalTransformKey === pinnedKey
      )
      if (pinned === undefined) return { failedPieceId: entry.pieceId }

      const pinnedCandidates = yield* exactCandidatesForTransform({
        target: input.target,
        entry,
        transform: pinned,
        provisional,
        placed,
        settings: input.settings,
        nfpIfp: input.nfpIfp,
        candidateMemoScope: input.candidateMemoScope,
        control: input.control,
        preservesPinnedTransform: true
      })
      let selected = pinnedCandidates.toSorted(compareProjectionCandidates)[0]
      if (selected === undefined) {
        const familyWinners: ProjectionCandidate[] = []
        const transformsByFamily = new Map<string, IntrinsicFiniteTransform[]>()
        for (const transform of entry.transforms) {
          if (transform.canonicalTransformKey === pinned.canonicalTransformKey) continue
          const family = transformsByFamily.get(transform.orientationFamily) ?? []
          family.push(transform)
          transformsByFamily.set(transform.orientationFamily, family)
        }
        for (const transforms of [...transformsByFamily.values()]) {
          yield* projectionCheckpoint(input.control)
          const familyCandidates: ProjectionCandidate[] = []
          for (const transform of transforms) {
            yield* projectionCheckpoint(input.control)
            familyCandidates.push(
              ...(yield* exactCandidatesForTransform({
                target: input.target,
                entry,
                transform,
                provisional,
                placed,
                settings: input.settings,
                nfpIfp: input.nfpIfp,
                candidateMemoScope: input.candidateMemoScope,
                control: input.control,
                preservesPinnedTransform: false
              }))
            )
          }
          const familyWinner = familyCandidates.toSorted(compareProjectionCandidates)[0]
          if (familyWinner !== undefined) familyWinners.push(familyWinner)
        }
        selected = familyWinners.toSorted(compareProjectionCandidates)[0]
        if (selected !== undefined) orientationFallbackPieceIds.push(entry.pieceId)
      }
      if (selected === undefined) return { failedPieceId: entry.pieceId }
      if (selected.directProvisionalPose) directPosePieceIds.push(entry.pieceId)
      placed.push(selected.placed)
    }
    return { placed, directPosePieceIds, orientationFallbackPieceIds }
  })
}

function exactCandidatesForTransform(input: {
  readonly target: CanonicalTargetBox
  readonly entry: IntrinsicTransformCatalogEntry
  readonly transform: IntrinsicFiniteTransform
  readonly provisional: IrregularPlacedPiece
  readonly placed: ReadonlyArray<IrregularPlacedPiece>
  readonly settings: IrregularNestingSettings
  readonly nfpIfp: NfpIfpService
  readonly candidateMemoScope: IrregularNfpIfpCandidateMemoScope
  readonly control: IrregularNfpIfpControl | undefined
  readonly preservesPinnedTransform: boolean
}): Effect.Effect<
  ReadonlyArray<ProjectionCandidate>,
  | IrregularNestingNotImplementedError
  | IrregularGeometryInputError
  | IrregularNfpIfpControlAbortError
> {
  return Effect.gen(function* () {
    const provisionalPoint = canonicalPlacementPoint(input.provisional)
    if (provisionalPoint === undefined) return []
    const candidates: ProjectionCandidate[] = []
    const directCandidate = new IrregularPlacementCandidate({
      pieceId: input.entry.pieceId,
      transform: input.transform.transform,
      point: provisionalPoint,
      diagnostics: []
    })
    const direct = scoreExactProjectionCandidate({
      target: input.target,
      entry: input.entry,
      transform: input.transform,
      candidate: directCandidate,
      provisional: input.provisional,
      provisionalPoint,
      placed: input.placed,
      directProvisionalPose: input.preservesPinnedTransform,
      preservesPinnedTransform: input.preservesPinnedTransform
    })
    if (direct !== undefined) candidates.push(direct)

    yield* projectionCheckpoint(input.control)
    const candidateInput = {
      sheet: input.target.sheet,
      placed: input.placed,
      moving: input.transform.geometry,
      settings: input.settings,
      candidateDomain: 'sheet' as const,
      candidateMemoScope: input.candidateMemoScope
    }
    const serviceCandidates =
      input.control === undefined
        ? yield* input.nfpIfp.generatePlacementCandidates(candidateInput)
        : yield* input.nfpIfp.generatePlacementCandidates({
            ...candidateInput,
            control: input.control
          })
    const seen = new Set(
      candidates.map((candidate) => candidateTranslationKey(candidate.placed))
    )
    for (const candidate of serviceCandidates) {
      const scored = scoreExactProjectionCandidate({
        target: input.target,
        entry: input.entry,
        transform: input.transform,
        candidate,
        provisional: input.provisional,
        provisionalPoint,
        placed: input.placed,
        directProvisionalPose: false,
        preservesPinnedTransform: input.preservesPinnedTransform
      })
      if (scored === undefined) continue
      const key = candidateTranslationKey(scored.placed)
      if (seen.has(key)) continue
      seen.add(key)
      candidates.push(scored)
    }
    return candidates
  })
}

function scoreExactProjectionCandidate(input: {
  readonly target: CanonicalTargetBox
  readonly entry: IntrinsicTransformCatalogEntry
  readonly transform: IntrinsicFiniteTransform
  readonly candidate: IrregularPlacementCandidate
  readonly provisional: IrregularPlacedPiece
  readonly provisionalPoint: { readonly x: number; readonly y: number }
  readonly placed: ReadonlyArray<IrregularPlacedPiece>
  readonly directProvisionalPose: boolean
  readonly preservesPinnedTransform: boolean
}): ProjectionCandidate | undefined {
  if (
    !Number.isFinite(input.candidate.point.x) ||
    !Number.isFinite(input.candidate.point.y)
  ) {
    return undefined
  }
  const placed = makePlaced(input.entry, input.transform, {
    x: input.candidate.point.x,
    y: input.candidate.point.y
  })
  const complete = [...input.placed, placed]
  if (!assertExactTargetLegal(input.target, complete)) return undefined
  const envelope = canonicalEnvelopeTuple(complete)
  const canonicalGeometryIdentity = canonicalCollisionLayoutIdentity(complete)
  if (envelope === undefined || canonicalGeometryIdentity === undefined) return undefined
  const candidateCenter = canonicalPlacedCenter(placed)
  const provisionalCenter = canonicalPlacedCenter(input.provisional)
  if (candidateCenter === undefined || provisionalCenter === undefined) return undefined
  return {
    placed,
    directProvisionalPose: input.directProvisionalPose,
    preservesPinnedTransform: input.preservesPinnedTransform,
    squaredGridDistance: squaredGridDistance(candidateCenter, provisionalCenter),
    ...envelope,
    canonicalGeometryIdentity
  }
}

function compareProjectionCandidates(
  first: ProjectionCandidate,
  second: ProjectionCandidate
): number {
  return (
    Number(second.directProvisionalPose) - Number(first.directProvisionalPose) ||
    compareBigInt(first.squaredGridDistance, second.squaredGridDistance) ||
    Number(second.preservesPinnedTransform) - Number(first.preservesPinnedTransform) ||
    compareBigInt(first.maximumSideGrid, second.maximumSideGrid) ||
    compareBigInt(first.envelopeAreaGrid2, second.envelopeAreaGrid2) ||
    compareBigInt(first.envelopeSpanGrid, second.envelopeSpanGrid) ||
    first.canonicalGeometryIdentity.localeCompare(second.canonicalGeometryIdentity)
  )
}

function selectClosureDilationPiece(
  reinsertionPriority: ReadonlyArray<PieceId>,
  provisionalById: ReadonlyMap<PieceId, IrregularPlacedPiece>,
  removed: ReadonlySet<PieceId>,
  failedPieceId: PieceId
): PieceId | undefined {
  const failed = provisionalById.get(failedPieceId)
  const failedCenter = failed === undefined ? undefined : canonicalPlacedCenter(failed)
  return reinsertionPriority
    .filter((pieceId) => !removed.has(pieceId))
    .map((pieceId, rank) => {
      const placed = provisionalById.get(pieceId)
      const center = placed === undefined ? undefined : canonicalPlacedCenter(placed)
      const distance =
        failedCenter === undefined || center === undefined
          ? undefined
          : squaredGridDistance(failedCenter, center)
      return { pieceId, rank, distance }
    })
    .toSorted(
      (first, second) =>
        compareOptionalBigInt(first.distance, second.distance) ||
        first.rank - second.rank ||
        first.pieceId.localeCompare(second.pieceId)
    )[0]?.pieceId
}

function canonicalEnvelopeTuple(
  placed: ReadonlyArray<IrregularPlacedPiece>
):
  | {
      readonly maximumSideGrid: bigint
      readonly envelopeAreaGrid2: bigint
      readonly envelopeSpanGrid: bigint
    }
  | undefined {
  const points: Array<{ readonly x: bigint; readonly y: bigint }> = []
  for (const entry of placed) {
    const path = placedCollisionWorldGridPath(entry)
    if (path === undefined) return undefined
    for (const { x, y } of path) {
      points.push({ x: BigInt(x), y: BigInt(y) })
    }
  }
  const first = points[0]
  if (first === undefined) return undefined
  let minX = first.x
  let minY = first.y
  let maxX = first.x
  let maxY = first.y
  for (const point of points.slice(1)) {
    if (point.x < minX) minX = point.x
    if (point.y < minY) minY = point.y
    if (point.x > maxX) maxX = point.x
    if (point.y > maxY) maxY = point.y
  }
  const width = maxX - minX
  const height = maxY - minY
  return {
    maximumSideGrid: width > height ? width : height,
    envelopeAreaGrid2: width * height,
    envelopeSpanGrid: width + height
  }
}

function gridPathKey(
  path: ReadonlyArray<{ readonly x: number; readonly y: number }>
): string {
  return path.map(({ x, y }) => `${x}:${y}`).join('|')
}

function canonicalTargetBox(targetBox: IntrinsicTargetBox): CanonicalTargetBox | undefined {
  const widthGrid = toGridMm(targetBox.widthMm)
  const heightGrid = toGridMm(targetBox.heightMm)
  if (widthGrid === undefined || heightGrid === undefined || widthGrid <= 0 || heightGrid <= 0) {
    return undefined
  }
  const descriptor = { widthMm: fromGrid(widthGrid), heightMm: fromGrid(heightGrid) }
  return {
    descriptor,
    sheet: new SheetSpec({
      width: Math.ceil(descriptor.widthMm),
      height: Math.ceil(descriptor.heightMm),
      label: 'intrinsic-exact-projection-target'
    }),
    widthGrid,
    heightGrid
  }
}

function assertExactTargetLegal(
  target: CanonicalTargetBox,
  placed: ReadonlyArray<IrregularPlacedPiece>
): boolean {
  if (!assertCanonicalGridLegalLayout(target.sheet, placed)) return false
  for (const entry of placed) {
    const path = placedCollisionWorldGridPath(entry)
    if (path === undefined) return false
    for (const { x, y } of path) {
      if (x < 0 || y < 0 || x > target.widthGrid || y > target.heightGrid) return false
    }
  }
  return true
}

/** Exact fractional-grid target legality; integer sheets are only NFP supersets. */
export function assertIntrinsicTargetExactLegal(
  targetBox: IntrinsicTargetBox,
  placed: ReadonlyArray<IrregularPlacedPiece>
): boolean {
  const target = canonicalTargetBox(targetBox)
  return target !== undefined && assertExactTargetLegal(target, placed)
}

function canonicalLocalGeometryKey(
  geometry: TransformedCollisionGeometry
): string | undefined {
  const gridPoints = geometry.polygon.points.map((point) => ({
    x: toGridMm(point.x),
    y: toGridMm(point.y)
  }))
  if (
    gridPoints.length < 3 ||
    gridPoints.some(({ x, y }) => x === undefined || y === undefined)
  ) {
    return undefined
  }
  const points = gridPoints.filter(
    (point): point is { readonly x: number; readonly y: number } =>
      point.x !== undefined && point.y !== undefined
  )
  const minX = Math.min(...points.map(({ x }) => x))
  const minY = Math.min(...points.map(({ y }) => y))
  return canonicalCollisionPolygonKey(
    points.map(({ x, y }) => ({ x: fromGrid(x - minX), y: fromGrid(y - minY) }))
  )
}

function makePlaced(
  entry: IntrinsicTransformCatalogEntry,
  transform: IntrinsicFiniteTransform,
  point: { readonly x: number; readonly y: number }
): IrregularPlacedPiece {
  const placementInput = {
    pieceId: entry.pieceId,
    sourcePieceId: entry.preparedPiece.source.id,
    placementReference: entry.preparedPiece.collisionGeometry.placementReference,
    transform: new IrregularTransform({
      translateX: point.x,
      translateY: point.y,
      rotationDeg: transform.transform.rotationDeg,
      mirrored: transform.transform.mirrored
    })
  }
  return new IrregularPlacedPiece({
    placement: new IrregularPlacement(placementInput),
    collisionGeometry: transform.geometry
  })
}

function canonicalPlacementPoint(
  entry: IrregularPlacedPiece
): { readonly x: number; readonly y: number } | undefined {
  const { translateX, translateY } = entry.placement.transform
  return !Number.isFinite(translateX) || !Number.isFinite(translateY)
    ? undefined
    : { x: translateX, y: translateY }
}

function canonicalPlacedCenter(
  entry: IrregularPlacedPiece
): { readonly x: bigint; readonly y: bigint } | undefined {
  const points = placedCollisionWorldGridPath(entry)
  if (points === undefined) return undefined
  const first = points[0]
  if (first === undefined) return undefined
  let minX = BigInt(first.x)
  let minY = BigInt(first.y)
  let maxX = minX
  let maxY = minY
  for (const point of points.slice(1)) {
    const x = BigInt(point.x)
    const y = BigInt(point.y)
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  return { x: minX + maxX, y: minY + maxY }
}

function squaredGridDistance(
  first: { readonly x: bigint; readonly y: bigint },
  second: { readonly x: bigint; readonly y: bigint }
): bigint {
  const deltaX = first.x - second.x
  const deltaY = first.y - second.y
  return deltaX * deltaX + deltaY * deltaY
}

/** Exact distance order for already canonical safe-integer grid points. */
export function compareIntrinsicProjectionGridDistance(
  reference: IntrinsicProjectionGridPoint,
  first: IntrinsicProjectionGridPoint,
  second: IntrinsicProjectionGridPoint
): number | undefined {
  if (
    ![reference.x, reference.y, first.x, first.y, second.x, second.y].every(
      Number.isSafeInteger
    )
  ) {
    return undefined
  }
  const referenceGrid = { x: BigInt(reference.x), y: BigInt(reference.y) }
  return compareBigInt(
    squaredGridDistance(referenceGrid, { x: BigInt(first.x), y: BigInt(first.y) }),
    squaredGridDistance(referenceGrid, { x: BigInt(second.x), y: BigInt(second.y) })
  )
}

function orderedPriorityIds(
  reinsertionPriority: ReadonlyArray<PieceId>,
  selected: ReadonlySet<PieceId>
): ReadonlyArray<PieceId> {
  return reinsertionPriority.filter((pieceId) => selected.has(pieceId))
}

function validateReinsertionPriority(
  catalog: IntrinsicTransformCatalog,
  priority: ReadonlyArray<PieceId>
): ReadonlyArray<PieceId> | undefined {
  if (priority.length !== catalog.entries.length || new Set(priority).size !== priority.length) {
    return undefined
  }
  const catalogIds = new Set(catalog.entries.map(({ pieceId }) => pieceId))
  return priority.every((pieceId) => catalogIds.has(pieceId)) ? [...priority] : undefined
}

function candidateTranslationKey(entry: IrregularPlacedPiece): string {
  const path = placedCollisionWorldGridPath(entry)
  return `${transformKey(entry.collisionGeometry.transform)}:${path === undefined ? 'invalid' : gridPathKey(path)}`
}

function compareTransforms(
  first: IrregularTransformCandidate,
  second: IrregularTransformCandidate
): number {
  return (
    first.index - second.index ||
    first.rotationDeg - second.rotationDeg ||
    Number(first.mirrored) - Number(second.mirrored) ||
    first.reason.localeCompare(second.reason)
  )
}

function transformKey(transform: IrregularTransformCandidate): string {
  return JSON.stringify([
    transform.index,
    normalizedRotationDeg(transform.rotationDeg),
    transform.mirrored,
    transform.reason
  ])
}

function orientationFamilyKey(transform: IrregularTransformCandidate): string {
  return `${normalizedRotationDeg(transform.rotationDeg)}:${Number(transform.mirrored)}`
}

function normalizedRotationDeg(rotationDeg: number): number {
  const remainder = rotationDeg % 360
  const normalized = remainder < 0 ? remainder + 360 : remainder
  return Object.is(normalized, -0) ? 0 : normalized
}

function preparedPieceId(piece: IrregularPreparedPiece): PieceId {
  return piece.pieceId ?? piece.source.id
}

function placedPieceId(piece: IrregularPlacedPiece): PieceId {
  return piece.placement.pieceId ?? piece.placement.sourcePieceId
}

function compareBigInt(first: bigint, second: bigint): number {
  return first < second ? -1 : first > second ? 1 : 0
}

function compareOptionalBigInt(first: bigint | undefined, second: bigint | undefined): number {
  if (first === undefined || second === undefined) {
    return first === second ? 0 : first === undefined ? 1 : -1
  }
  return compareBigInt(first, second)
}

function projectionCheckpoint(
  control: IrregularNfpIfpControl | undefined
): Effect.Effect<void, IrregularNfpIfpControlAbortError> {
  return control?.checkpoint('candidate-points') ?? Effect.void
}

function failProjection(
  operation: IntrinsicExactProjectionError['operation'],
  category: IntrinsicExactProjectionError['category'],
  message: string,
  failedPieceId?: PieceId,
  attempts?: number
): Effect.Effect<never, IntrinsicExactProjectionError> {
  return Effect.fail(
    new IntrinsicExactProjectionError({
      operation,
      category,
      message,
      ...(failedPieceId === undefined ? {} : { failedPieceId }),
      ...(attempts === undefined ? {} : { attempts })
    })
  )
}
