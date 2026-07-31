/**
 * One-off fixture generator for the Rust standalone profiling runner
 * (`crates/irregular-nesting-native/examples/run_mixed61.rs`).
 *
 * Re-serializes `tests/fixtures/irregularSheetInvariance/mixed61-request.json`
 * -- the exact same fixture `scripts/irregular-compact-baseline.ts`'s own
 * `mixed61Request` and `scripts/rust-parity/verify-mixed61-hash.ts` load for
 * the acceptance-bar case -- into the plain-JSON shape
 * `crates/irregular-nesting-native/tests/coordinator_vectors.rs`'s
 * `decode_request` (and `dump-coordinator.ts`'s own `encodeRequest`) expect,
 * so the Rust example can `serde_json::from_value` it directly.
 *
 * Deliberately does **not** re-run `preparePieces` and does **not**
 * reconstruct settings from `makeCompactQualityIrregularOptimizerSettings`:
 * the fixture's own `pieces` are already the real prepared pieces
 * `irregular-compact-baseline.ts#mixed61Request` uses verbatim (only
 * `sheet`/`historyMode` are overridden there, and the fixture's own default
 * sheet is already `2000x2700`, confirmed by direct inspection -- so this
 * script's sheet override is a documented no-op kept for explicitness), and
 * the fixture's own embedded `options.irregularSettings` already encodes the
 * Compact profile (no `intrinsicObjectiveProfileId` key present; both the TS
 * schema and the Rust `#[serde(default = ...)]` default it to `'compact'`
 * identically). Reusing the fixture verbatim -- rather than reconstructing
 * it -- is what makes this script's output match the real acceptance-bar
 * run byte for byte instead of silently drifting (an earlier version of
 * this script rebuilt settings from `makeCompactQualityIrregularOptimizerSettings()`
 * and re-ran `preparePieces` with `padding: 0`, which produced a
 * different -- and measurably faster/wrong -- computation than the real
 * gate; this version's collision-identity SHA-256 was checked against the
 * documented acceptance value before being kept).
 *
 * This is profiling scaffolding, not a correctness vector: it is not
 * compared against any TS oracle output. It only feeds the Rust
 * `compute_irregular_nesting` entry point the same request bytes production
 * would.
 *
 * Run with:
 *   pnpm exec tsx --tsconfig tsconfig.node.json scripts/rust-parity/dump-mixed61-2000x2700-request.ts
 *
 * Output:
 *   crates/irregular-nesting-native/tests/vectors/mixed61-2000x2700-compact-request.json
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Schema } from 'effect'

import { NestingOptions, NestingRequest, SheetSpec } from '@shared/domain/nesting.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..', '..')
const VECTORS_DIR = join(REPO_ROOT, 'crates', 'irregular-nesting-native', 'tests', 'vectors')
const MIXED61_FIXTURE_PATH = join(
  REPO_ROOT,
  'tests/fixtures/irregularSheetInvariance/mixed61-request.json'
)
const OUTPUT_PATH = join(VECTORS_DIR, 'mixed61-2000x2700-compact-request.json')

const raw = JSON.parse(readFileSync(MIXED61_FIXTURE_PATH, 'utf8')) as unknown
const decoded = Schema.decodeUnknownSync(NestingRequest)(raw)
const settings = decoded.options.irregularSettings
if (settings === undefined) throw new Error('mixed-61 fixture has no irregular settings')

const sheet = new SheetSpec({ width: 2000, height: 2700, label: '2000x2700' })
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

function encodeImportedPiece(piece: NonNullable<typeof request.sourcePieces>[number]) {
  return {
    id: String(piece.id),
    sourceFileId: String(piece.sourceFileId),
    label: piece.label,
    realBounds: { ...piece.realBounds },
    geometry: {
      entityType: 'PRESET_SHAPE',
      closed: piece.geometry.closed,
      segments: piece.geometry.segments.map((segment) => {
        const line = segment as { readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number }
        return { kind: 'line', x1: line.x1, y1: line.y1, x2: line.x2, y2: line.y2 }
      })
    },
    warnings: []
  }
}
function encodePreparedPiece(piece: (typeof request.pieces)[number]) {
  return {
    id: String(piece.id),
    sourcePieceId: String(piece.sourcePieceId),
    interchangeabilityKey: piece.interchangeabilityKey ?? null,
    realBounds: { ...piece.realBounds },
    paddedBounds: { ...piece.paddedBounds },
    padding: piece.padding,
    allowRotation: piece.allowRotation,
    allowMirror: piece.allowMirror
  }
}
function encodeOptimizerSettings(optimizer: NonNullable<typeof settings>['optimizer']) {
  return {
    orderWindow: optimizer.orderWindow,
    beamWidth: optimizer.beamWidth,
    localCandidateFanout: optimizer.localCandidateFanout,
    localRepairBudget: optimizer.localRepairBudget,
    intrinsicSharedArchiveEnabled: optimizer.intrinsicSharedArchiveEnabled,
    intrinsicObjectiveProfileId: optimizer.intrinsicObjectiveProfileId,
    transformCap: optimizer.transformCap,
    transformMinimumEdgeLengthMm: optimizer.transformMinimumEdgeLengthMm,
    transformAngleDeduplicationToleranceDeg: optimizer.transformAngleDeduplicationToleranceDeg,
    configuredRotationEnabled: optimizer.configuredRotationEnabled,
    edgeAlignmentEnabled: optimizer.edgeAlignmentEnabled,
    configuredRotationDeg: [...optimizer.configuredRotationDeg],
    gaEnabled: optimizer.gaEnabled,
    baselineOnly: optimizer.baselineOnly,
    gaPopulation: optimizer.gaPopulation,
    gaGenerationBudget: optimizer.gaGenerationBudget,
    gaEvaluationBudget: optimizer.gaEvaluationBudget,
    gaTimeBudgetMs: optimizer.gaTimeBudgetMs,
    gaSeed: optimizer.gaSeed,
    priorityOrderMutationEnabled: optimizer.priorityOrderMutationEnabled,
    transformPreferenceMutationEnabled: optimizer.transformPreferenceMutationEnabled,
    placementPolicyMutationEnabled: optimizer.placementPolicyMutationEnabled,
    placementPolicyId: optimizer.placementPolicyId,
    placementPolicyIds: [...(optimizer.placementPolicyIds ?? [])]
  }
}

const encoded = {
  request: {
    sheet: { width: request.sheet.width, height: request.sheet.height, label: request.sheet.label },
    padding: request.padding,
    pieces: request.pieces.map(encodePreparedPiece),
    sourcePieces: (request.sourcePieces ?? []).map(encodeImportedPiece),
    allowGlobalRotation: request.options.allowGlobalRotation,
    allowGlobalMirror: request.options.allowGlobalMirror,
    historyMode: request.options.historyMode,
    settings: {
      geometry: {
        flatteningSagToleranceMm: settings.geometry.flatteningSagToleranceMm,
        clearanceSafetyMarginMm: settings.geometry.clearanceSafetyMarginMm,
        geometryBackendId: settings.geometry.geometryBackendId,
        geometryBackendVersion: settings.geometry.geometryBackendVersion
      },
      optimizer: encodeOptimizerSettings(settings.optimizer)
    }
  }
}

writeFileSync(OUTPUT_PATH, JSON.stringify(encoded, null, 2))
console.log(`[dump-mixed61-2000x2700-request] wrote ${OUTPUT_PATH} (${request.pieces.length} prepared pieces)`)
