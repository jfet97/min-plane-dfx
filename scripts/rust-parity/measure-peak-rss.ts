#!/usr/bin/env node
/**
 * Additive peak-RSS wrapper for the preregistered performance contract's P6
 * memory gate (docs/planning/rust-irregular-backend/performance-contract.md
 * §5, "Peak RSS measured via `/usr/bin/time -v`... on C1"; §"Reporting"
 * amendment for this measurement batch: TS via
 * `process.resourceUsage().maxRSS`, Rust-via-addon via the same call in this
 * same wrapper -- see the batch's own method notes in
 * `evidence/performance-report.md`). Runs the Mixed-61 `2000x2700` Compact
 * case (C1, the primary gate) through exactly one backend per invocation
 * (`--backend ts|rust`), using the identical request construction
 * `scripts/irregular-compact-baseline.ts`/`scripts/rust-parity/verify-mixed61-hash.ts`
 * use, and prints `process.resourceUsage().maxRSS` (Linux: kilobytes,
 * matching `/usr/bin/time -v`'s "Maximum resident set size" units) measured
 * *after* the compute call returns -- this is the whole Node process's
 * lifetime peak, the same quantity `/usr/bin/time -v` would report for the
 * process, not a delta.
 *
 * Never modifies `irregular-compact-baseline.ts` or `verify-mixed61-hash.ts`;
 * duplicates their request-construction logic in the same way
 * `time-native-backend.ts` does (see that script's own doc for why a
 * duplicate rather than an import).
 *
 * Usage:
 *   pnpm exec tsx --tsconfig tsconfig.node.json scripts/rust-parity/measure-peak-rss.ts --backend ts|rust
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Effect, Layer, Schema } from 'effect'

import { NestingOptions, NestingRequest, SheetSpec } from '@shared/domain/nesting.js'
import { IrregularNestingSettings, IrregularOptimizerSettings } from '@shared/irregular/domain.js'
import { canonicalCollisionLayoutIdentity } from '../../src/workers/irregular/canonicalLayoutGeometry.js'
import { computeIrregularNestingNative } from '../../src/workers/irregular/native/nativeIrregularBackend.js'
import { computeIrregularNesting } from '../../src/workers/algorithm/irregular/computeIrregularNesting.js'
import { CollisionGeometryBuilder } from '../../src/workers/irregular/collisionGeometryBuilder.js'
import { FreeMaterialServiceLive } from '../../src/workers/irregular/freeMaterialService.js'
import { GeometryKernel, GeometrySettings } from '../../src/workers/irregular/geometryKernel.js'
import { NfpIfpServiceLive } from '../../src/workers/irregular/nfpIfpService.js'
import { TransformGeneratorLive } from '../../src/workers/irregular/transformGenerator.js'
import { IrregularLayoutScorer } from '../../src/workers/algorithm/irregular/irregularLayoutScorer.js'
import { IrregularPlacementScorer } from '../../src/workers/algorithm/irregular/irregularPlacementScorer.js'
import { canonicalizeIrregularLayout, type LayoutPoint } from '../lib/irregularLayoutCanonicalization.js'
import type { IrregularComputeResult } from '../../src/workers/algorithm/irregular/computeIrregularNesting.js'

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const MIXED61_FIXTURE_PATH = join(REPO_ROOT, 'tests/fixtures/irregularSheetInvariance/mixed61-request.json')

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}

function absoluteCollisionPolygons(
  result: Pick<IrregularComputeResult, 'placedCollisionGeometries'>
): ReadonlyArray<ReadonlyArray<LayoutPoint>> {
  return result.placedCollisionGeometries.map(({ placement, collisionGeometry }) =>
    collisionGeometry.polygon.points.map(({ x, y }) => ({
      x: x + placement.transform.translateX,
      y: y + placement.transform.translateY
    }))
  )
}

async function main(): Promise<void> {
  const backend = argument('--backend')
  if (backend !== 'ts' && backend !== 'rust') throw new Error('--backend must be ts or rust')

  const sheet = new SheetSpec({ width: 2000, height: 2700, label: '2000x2700' })
  const raw = JSON.parse(readFileSync(MIXED61_FIXTURE_PATH, 'utf8')) as unknown
  const decoded = Schema.decodeUnknownSync(NestingRequest)(raw)
  const baseSettings = decoded.options.irregularSettings
  if (baseSettings === undefined) throw new Error('mixed-61 fixture has no irregular settings')
  const settings = new IrregularNestingSettings({
    ...baseSettings,
    optimizer: new IrregularOptimizerSettings({
      ...baseSettings.optimizer,
      intrinsicObjectiveProfileId: 'compact'
    })
  })
  const request = new NestingRequest({
    ...decoded,
    sheet,
    options: new NestingOptions({
      ...decoded.options,
      timeoutMs: 0,
      historyMode: 'off',
      irregularSettings: settings
    })
  })

  console.log(`[measure-peak-rss] backend=${backend} sheet=2000x2700 pieces=${request.pieces.length}`)
  const startedAt = Date.now()
  const result =
    backend === 'rust'
      ? await Effect.runPromise(computeIrregularNestingNative(request, settings))
      : await Effect.runPromise(
          computeIrregularNesting(request).pipe(
            Effect.provide(CollisionGeometryBuilder.Live),
            Effect.provide(TransformGeneratorLive),
            Effect.provide(NfpIfpServiceLive),
            Effect.provide(FreeMaterialServiceLive),
            Effect.provide(IrregularPlacementScorer.Layer),
            Effect.provide(IrregularLayoutScorer.Live),
            Effect.provide(GeometryKernel.Live),
            Effect.provide(Layer.succeed(GeometrySettings, settings))
          )
        )
  const elapsedMs = Date.now() - startedAt

  const identity = canonicalCollisionLayoutIdentity(result.placedCollisionGeometries)
  const collisionIdentitySha256 =
    identity === undefined ? undefined : createHash('sha256').update(identity).digest('hex')
  const polygons = absoluteCollisionPolygons(result)
  const fittedCanonicalSha256 = polygons.length === 0 ? undefined : canonicalizeIrregularLayout(polygons).sha256

  const usage = process.resourceUsage()

  console.log(
    JSON.stringify(
      {
        backend,
        placedCount: result.placedCollisionGeometries.length,
        unplacedCount: result.unplacedPieceIds.length,
        collisionIdentitySha256,
        fittedCanonicalSha256,
        elapsedMs,
        maxRSSKb: usage.maxRSS
      },
      null,
      2
    )
  )
}

main().catch((error: unknown) => {
  console.error('[measure-peak-rss] FAILED', error)
  process.exit(1)
})
