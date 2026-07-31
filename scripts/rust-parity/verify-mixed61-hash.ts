#!/usr/bin/env node
/**
 * One-shot acceptance-bar verifier: runs the REAL Rust backend
 * (`computeIrregularNestingNative`, the same entry point
 * `nesting.worker.ts` uses in production) on the mixed-61 fixture at a given
 * sheet/profile and prints its fitted canonical SHA-256
 * (`canonicalCollisionLayoutIdentity` + `sha256`, the exact same computation
 * `scripts/irregular-compact-baseline.ts`'s own `sha256CanonicalLayout`
 * uses) plus placed/unplaced counts -- so the acceptance bar
 * ("mixed-61 2000x2700 fitted canonical SHA-256 ... from the RUST backend")
 * can be checked directly against the native addon, not just diffed against
 * TypeScript.
 *
 * Usage:
 *   pnpm exec tsx --tsconfig tsconfig.node.json scripts/rust-parity/verify-mixed61-hash.ts \
 *     [--sheet 2000x2700] [--profile compact|short-side]
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Effect, Schema } from 'effect'

import { NestingOptions, NestingRequest, SheetSpec } from '@shared/domain/nesting.js'
import { IrregularNestingSettings, IrregularOptimizerSettings } from '@shared/irregular/domain.js'
import { canonicalCollisionLayoutIdentity } from '../../src/workers/irregular/canonicalLayoutGeometry.js'
import { computeIrregularNestingNative } from '../../src/workers/irregular/native/nativeIrregularBackend.js'
import {
  canonicalizeIrregularLayout,
  type LayoutPoint
} from '../lib/irregularLayoutCanonicalization.js'
import type { IrregularComputeResult } from '../../src/workers/algorithm/irregular/computeIrregularNesting.js'

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const MIXED61_FIXTURE_PATH = join(
  REPO_ROOT,
  'tests/fixtures/irregularSheetInvariance/mixed61-request.json'
)

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}

function parseSheet(value: string): SheetSpec {
  const match = /^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/.exec(value)
  if (match === null) throw new Error('--sheet must be WIDTHxHEIGHT')
  const width = Number(match[1])
  const height = Number(match[2])
  return new SheetSpec({ width, height, label: `${width}x${height}` })
}

async function main(): Promise<void> {
  const sheetArg = argument('--sheet') ?? '2000x2700'
  const profileArg = argument('--profile') ?? 'compact'
  if (profileArg !== 'compact' && profileArg !== 'short-side') {
    throw new Error('--profile must be compact or short-side')
  }
  const sheet = parseSheet(sheetArg)

  const raw = JSON.parse(readFileSync(MIXED61_FIXTURE_PATH, 'utf8')) as unknown
  const decoded = Schema.decodeUnknownSync(NestingRequest)(raw)
  const baseSettings = decoded.options.irregularSettings
  if (baseSettings === undefined) throw new Error('mixed-61 fixture has no irregular settings')
  const settings = new IrregularNestingSettings({
    ...baseSettings,
    optimizer: new IrregularOptimizerSettings({
      ...baseSettings.optimizer,
      intrinsicObjectiveProfileId: profileArg
    })
  })
  const request = new NestingRequest({
    ...decoded,
    sheet,
    options: new NestingOptions({
      ...decoded.options,
      timeoutMs: Number.MAX_SAFE_INTEGER,
      historyMode: 'off',
      irregularSettings: settings
    })
  })

  console.log(
    `[verify-mixed61-hash] sheet=${sheetArg} profile=${profileArg} pieces=${request.pieces.length}`
  )
  const startedAt = Date.now()
  const result = await Effect.runPromise(computeIrregularNestingNative(request, settings))
  const elapsedMs = Date.now() - startedAt

  // TS: `scripts/irregular-compact-baseline.ts`'s own `collisionIdentitySha256`
  // -- a same-process self-consistency hash over the production
  // `canonicalCollisionLayoutIdentity`, never the acceptance-bar hash itself.
  const identity = canonicalCollisionLayoutIdentity(result.placedCollisionGeometries)
  const collisionIdentitySha256 =
    identity === undefined ? undefined : createHash('sha256').update(identity).digest('hex')

  // TS: `scripts/irregular-compact-baseline.ts`'s own `fittedCanonicalSha256`
  // -- the gate-script canonicalization (`scripts/lib/irregularLayoutCanonicalization.js`)
  // over absolute-space collision polygons. This is the acceptance-bar hash
  // (`pnpm gate:mixed61-compact`'s `--expected-canonical-sha256`).
  const polygons = absoluteCollisionPolygons(result)
  const fittedCanonicalSha256 =
    polygons.length === 0 ? undefined : canonicalizeIrregularLayout(polygons).sha256

  console.log(
    JSON.stringify(
      {
        placedCount: result.placedCollisionGeometries.length,
        unplacedCount: result.unplacedPieceIds.length,
        collisionIdentitySha256,
        fittedCanonicalSha256,
        elapsedMs
      },
      null,
      2
    )
  )
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

main().catch((error: unknown) => {
  console.error('[verify-mixed61-hash] FAILED', error)
  process.exit(1)
})
