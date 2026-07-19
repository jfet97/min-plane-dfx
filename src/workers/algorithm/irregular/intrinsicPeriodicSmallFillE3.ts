import { Effect } from 'effect'
import type { SheetSpec } from '@shared/domain/nesting.js'
import type { IrregularPreparedPiece } from '@shared/irregular/domain.js'
import {
  enumerateIntrinsicPeriodicCells,
  expandIntrinsicPeriodicCell,
  type IntrinsicPeriodicCatalog
} from './intrinsicPeriodicCells.js'
import {
  constructIntrinsicStrictState,
  finalizeIntrinsicStrictState,
  type IntrinsicStrictConstructResult,
  type IntrinsicStrictDecodeResult,
  type IntrinsicStrictDecoderError
} from './intrinsicStrictDecoder.js'
import {
  type IrregularGeometryInputError,
  type IrregularNestingNotImplementedError,
  type IrregularNfpIfpControlAbortError,
  type NfpIfpService
} from '../../irregular/services.js'
import type { GeometryKernel, GeometrySettings } from '../../irregular/geometryKernel.js'
import { groupIntrinsicCollisionFamilies } from './intrinsicStrictFamilyPortfolio.js'

export type IntrinsicE3RoleId = 'E1' | 'P1' | 'P2' | 'L1'

export interface IntrinsicE3RoleResult {
  readonly role: IntrinsicE3RoleId
  readonly status: IntrinsicStrictDecodeResult['status'] | 'invalid' | 'deadline'
  readonly result: IntrinsicStrictDecodeResult | undefined
  readonly constructed: IntrinsicStrictConstructResult | undefined
  readonly reason: string | undefined
  readonly seedPlacementCount: number
  readonly nonInertFillCount: number
  readonly runtimeMs: number
}

export interface IntrinsicE3Result {
  readonly catalog: IntrinsicPeriodicCatalog
  readonly roles: ReadonlyArray<IntrinsicE3RoleResult>
  readonly runtimeMs: number
}

type E3Error =
  | IntrinsicStrictDecoderError
  | IrregularNestingNotImplementedError
  | IrregularGeometryInputError
  | IrregularNfpIfpControlAbortError

/** Runs the four bounded E3 roles without allowing cross-role seed contamination. */
export function runIntrinsicPeriodicSmallFillE3(
  archiveSheet: SheetSpec,
  pieces: ReadonlyArray<IrregularPreparedPiece>
): Effect.Effect<IntrinsicE3Result, E3Error, GeometryKernel | GeometrySettings | NfpIfpService> {
  return Effect.gen(function* () {
    const startedAt = performance.now()
    const catalog = yield* enumerateIntrinsicPeriodicCells(pieces, 5_000)
    const roles: IntrinsicE3RoleResult[] = []

    roles.push(
      yield* runConstructedRole(
        'E1',
        archiveSheet,
        () =>
          constructIntrinsicStrictState({
            allPreparedPieces: pieces,
            remainingPreparedPieces: pieces,
            frozenPlaced: [],
            candidateMode: 'pure-growth',
            maximumRuntimeMs: 20_000
          }),
        0
      )
    )

    const selectedFamily = groupIntrinsicCollisionFamilies(pieces).find(
      ({ key }) => key === catalog.selectedFamilyKey
    )
    for (const role of ['P1', 'P2'] as const) {
      const cell = catalog.cells.find((candidate) => candidate.role === role)
      if (cell === undefined || selectedFamily === undefined) {
        roles.push(invalidRole(role, 'no certified retained periodic cell'))
        continue
      }
      const seed = (yield* expandIntrinsicPeriodicCell(cell, selectedFamily.members))[0]
      if (seed === undefined) {
        roles.push(invalidRole(role, 'certified cell produced no exact finite expansion'))
        continue
      }
      const frozenIds = new Set(
        seed.placements.map(({ placement }) => placement.pieceId ?? placement.sourcePieceId)
      )
      const remaining = pieces.filter((piece) => !frozenIds.has(piece.pieceId ?? piece.source.id))
      roles.push(
        yield* runConstructedRole(
          role,
          archiveSheet,
          () =>
            constructIntrinsicStrictState({
              allPreparedPieces: pieces,
              remainingPreparedPieces: remaining,
              frozenPlaced: seed.placements,
              candidateMode: 'pure-growth',
              maximumRuntimeMs: 25_000
            }),
          seed.placements.length
        )
      )
    }

    const areas = pieces.map(collisionAreaMm2)
    const threshold = Math.max(0, ...areas) / 8
    const large = pieces.filter((_, index) => (areas[index] ?? 0) >= threshold)
    const small = pieces.filter((_, index) => (areas[index] ?? 0) < threshold)
    const largePhase = yield* Effect.matchEffect(
      constructIntrinsicStrictState({
        allPreparedPieces: large,
        remainingPreparedPieces: large,
        frozenPlaced: [],
        candidateMode: 'pure-growth',
        maximumRuntimeMs: 20_000
      }),
      {
        onFailure: (error) => Effect.succeed({ kind: 'failure' as const, error }),
        onSuccess: (value) => Effect.succeed({ kind: 'success' as const, value })
      }
    )
    if (largePhase.kind === 'failure') {
      roles.push({ ...invalidRole('L1', largePhase.error._tag), status: 'deadline' })
    } else if (largePhase.value.state.unplacedPieceIds.length > 0) {
      roles.push(invalidRole('L1', 'large phase incomplete'))
    } else {
      roles.push(
        yield* runConstructedRole(
          'L1',
          archiveSheet,
          () =>
            constructIntrinsicStrictState({
              allPreparedPieces: pieces,
              remainingPreparedPieces: small,
              frozenPlaced: largePhase.value.state.placedCollisionGeometries,
              candidateMode: { kind: 'gap-contained' },
              maximumRuntimeMs: 25_000
            }),
          largePhase.value.state.placedCollisionGeometries.length,
          largePhase.value.runtimeMs
        )
      )
    }
    return { catalog, roles, runtimeMs: Math.max(0, performance.now() - startedAt) }
  })
}

function runConstructedRole(
  role: IntrinsicE3RoleId,
  archiveSheet: SheetSpec,
  construct: () => Effect.Effect<
    IntrinsicStrictConstructResult,
    E3Error,
    GeometryKernel | GeometrySettings | NfpIfpService
  >,
  seedPlacementCount: number,
  priorRuntimeMs = 0
): Effect.Effect<
  IntrinsicE3RoleResult,
  IntrinsicStrictDecoderError,
  GeometryKernel | GeometrySettings | NfpIfpService
> {
  return Effect.gen(function* () {
    const startedAt = performance.now()
    const outcome = yield* Effect.matchEffect(construct(), {
      onFailure: (error) => Effect.succeed({ kind: 'failure' as const, error }),
      onSuccess: (value) => Effect.succeed({ kind: 'success' as const, value })
    })
    const runtimeMs = priorRuntimeMs + Math.max(0, performance.now() - startedAt)
    if (outcome.kind === 'failure') {
      return {
        role,
        status: outcome.error._tag === 'IrregularNfpIfpControlAbortError' ? 'deadline' : 'invalid',
        result: undefined,
        constructed: undefined,
        reason: outcome.error._tag,
        seedPlacementCount,
        nonInertFillCount: 0,
        runtimeMs
      }
    }
    const result = yield* finalizeIntrinsicStrictState(archiveSheet, outcome.value, runtimeMs)
    return {
      role,
      status: result.status,
      result,
      constructed: outcome.value,
      reason: undefined,
      seedPlacementCount,
      nonInertFillCount: outcome.value.gapFillEvidence.filter(({ nonInert }) => nonInert).length,
      runtimeMs
    }
  })
}

function invalidRole(role: IntrinsicE3RoleId, reason: string): IntrinsicE3RoleResult {
  return {
    role,
    status: 'invalid',
    result: undefined,
    constructed: undefined,
    reason,
    seedPlacementCount: 0,
    nonInertFillCount: 0,
    runtimeMs: 0
  }
}

function collisionAreaMm2(piece: IrregularPreparedPiece): number {
  const points = piece.collisionGeometry.collisionPolygon.points
  let doubled = 0
  for (let index = 0; index < points.length; index += 1) {
    const first = points[index]
    const second = points[(index + 1) % points.length]
    if (first === undefined || second === undefined) return 0
    doubled += first.x * second.y - second.x * first.y
  }
  return Math.abs(doubled) / 2
}
