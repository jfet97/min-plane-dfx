#!/usr/bin/env node
/**
 * P5 aggregate performance harness for the explicit TypeScript and Rust
 * irregular backends. This file owns orchestration, timing, statistics, and
 * evidence capture only. Geometry, placement, capacity, and validation remain
 * in the maintained production harnesses and compute entry points.
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { cpus, platform as hostPlatform, release, totalmem } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { Effect, Layer, Schema } from 'effect'

import { importDxfFile } from '../../src/main/services/DxfImportService.js'
import { ImportedPiece } from '../../src/shared/domain/dxf.js'
import { JobId, PieceId, SourceFileId } from '../../src/shared/domain/ids.js'
import { NestingOptions, NestingRequest, SheetSpec } from '../../src/shared/domain/nesting.js'
import {
  DEFAULT_IRREGULAR_GEOMETRY_SETTINGS,
  makeCompactQualityIrregularOptimizerSettings
} from '../../src/shared/irregular/defaults.js'
import {
  IrregularNestingSettings,
  IrregularOptimizerSettings
} from '../../src/shared/irregular/domain.js'
import { makePresetShapeDocument, type PresetShapeKind } from '../../src/shared/presetShapes.js'
import { preparePieces } from '../../src/shared/preparePieces.js'
import {
  computeIrregularNesting,
  type ComputeIrregularNestingOptions,
  type IrregularComputeResult
} from '../../src/workers/algorithm/irregular/computeIrregularNesting.js'
import { CollisionGeometryBuilder } from '../../src/workers/irregular/collisionGeometryBuilder.js'
import { FreeMaterialServiceLive } from '../../src/workers/irregular/freeMaterialService.js'
import { GeometryKernel, GeometrySettings } from '../../src/workers/irregular/geometryKernel.js'
import { NfpIfpServiceLive } from '../../src/workers/irregular/nfpIfpService.js'
import { TransformGeneratorLive } from '../../src/workers/irregular/transformGenerator.js'
import { IrregularLayoutScorer } from '../../src/workers/algorithm/irregular/irregularLayoutScorer.js'
import { IrregularPlacementScorer } from '../../src/workers/algorithm/irregular/irregularPlacementScorer.js'
import {
  canonicalCollisionLayoutIdentity,
  measureCanonicalLayoutTopologyExact
} from '../../src/workers/irregular/canonicalLayoutGeometry.js'
import {
  canonicalizeIrregularLayout,
  type LayoutPoint
} from '../lib/irregularLayoutCanonicalization.js'
import { computeIrregularNestingNative } from '../../src/workers/irregular/native/nativeIrregularBackend.js'
import {
  loadNativeIrregularAddon,
  probeNativeIrregularAddon,
  type NativeCapabilityProbe
} from '../../src/workers/irregular/native/loadNativeBackend.js'

export type BenchmarkBackend = 'typescript' | 'rust'
export type RustThreadSetting = 1 | 2 | 8 | 'default'
export type BenchmarkSuite = 'C5' | 'C6' | 'C7'
export type LayoutProfile = 'compact' | 'short-side'

export interface LayoutBenchmarkRow {
  readonly id: string
  readonly fixture: 'triangle-20' | 'mixed-61' | 'shapes-17'
  readonly sheet: '2000x2700' | '600x400' | '300x300'
  readonly profile: LayoutProfile
}

const layoutRows = (profile: LayoutProfile): ReadonlyArray<LayoutBenchmarkRow> => {
  const combinations: ReadonlyArray<
    readonly [LayoutBenchmarkRow['fixture'], LayoutBenchmarkRow['sheet']]
  > = [
    ['triangle-20', '2000x2700'],
    ['mixed-61', '2000x2700'],
    ['shapes-17', '2000x2700'],
    ['triangle-20', '600x400'],
    ['mixed-61', '600x400'],
    ['shapes-17', '600x400'],
    ['triangle-20', '300x300'],
    ['mixed-61', '300x300'],
    ['shapes-17', '300x300']
  ]
  return combinations.map(([fixture, sheet]) => ({
    id: `${fixture}-${sheet}`,
    fixture,
    sheet,
    profile
  }))
}

/** The nine Compact rows. Short Side rows are intentionally not included. */
export const C5_COMPACT_ROWS: ReadonlyArray<LayoutBenchmarkRow> = layoutRows('compact')

/** The nine Compact Short Side rows, reported independently as C7. */
export const C7_SHORT_SIDE_ROWS: ReadonlyArray<LayoutBenchmarkRow> = layoutRows('short-side')

/** The maintained production capacity fixture order from irregular-capacity-gate.ts. */
export const C6_CAPACITY_FIXTURE_IDS: ReadonlyArray<string> = [
  'capacity-area-proven-rect2',
  'capacity-singleton-proven',
  'capacity-archive-miss-squares2',
  'capacity-count-vs-material',
  'capacity-triangles20-300x300',
  'capacity-mixed61-500x400',
  'capacity-mixed61-700x500',
  'capacity-mixed61-700x560'
]

export const P5_THRESHOLDS = Object.freeze({
  oneThread: 0.75,
  defaultThread: 0.6
})

export const COMPARABLE_CAPACITY_OPTIONS = Object.freeze({
  intrinsicAnytimeSchedulerMode: 'deterministic-v1' as const,
  captureCapacityPhaseTimings: false,
  captureCapacityShadowTelemetry: false,
  captureCapacityWarmPrefixTelemetry: false,
  captureExperimentalPlaceDeferCompleteShadow: false,
  captureCapacityCohesionShadow: false
})

export const COMPARABLE_CAPACITY_CACHE_POLICY =
  'production-defaults; TypeScript-only diagnostics and shadows excluded'

export interface BackendThreadCell {
  readonly backend: BenchmarkBackend
  readonly rustThreads: RustThreadSetting
}

export function buildBackendThreadCells(): ReadonlyArray<BackendThreadCell> {
  return [
    { backend: 'typescript', rustThreads: 'default' },
    { backend: 'rust', rustThreads: 1 },
    { backend: 'rust', rustThreads: 2 },
    { backend: 'rust', rustThreads: 'default' },
    { backend: 'rust', rustThreads: 8 }
  ]
}

export function selectSuiteRows(
  suite: 'C5' | 'C7',
  rows: ReadonlyArray<LayoutBenchmarkRow>
): ReadonlyArray<LayoutBenchmarkRow> {
  const expectedProfile: LayoutProfile = suite === 'C5' ? 'compact' : 'short-side'
  const selected = rows.filter(({ profile }) => profile === expectedProfile)
  if (selected.length !== 9) {
    throw new Error(
      `${suite} requires exactly nine ${expectedProfile} rows, received ${selected.length}`
    )
  }
  return selected
}

export interface MeasurementScheduleItem {
  readonly phase: 'warmup' | 'measured'
  readonly ordinal: number
  readonly backend: BenchmarkBackend
  readonly rustThreads: RustThreadSetting
}

export function buildMeasurementSchedule(input: {
  readonly measuredSamples: number
  readonly rustThreads: RustThreadSetting
  readonly includeWarmups?: boolean
}): ReadonlyArray<MeasurementScheduleItem> {
  if (!Number.isInteger(input.measuredSamples) || input.measuredSamples <= 0) {
    throw new Error('measuredSamples must be a positive integer')
  }
  const schedule: MeasurementScheduleItem[] = []
  if (input.includeWarmups !== false) {
    schedule.push(
      { phase: 'warmup', ordinal: 0, backend: 'typescript', rustThreads: 'default' },
      { phase: 'warmup', ordinal: 0, backend: 'rust', rustThreads: input.rustThreads }
    )
  }
  for (let ordinal = 0; ordinal < input.measuredSamples; ordinal += 1) {
    schedule.push(
      { phase: 'measured', ordinal, backend: 'typescript', rustThreads: 'default' },
      { phase: 'measured', ordinal, backend: 'rust', rustThreads: input.rustThreads }
    )
  }
  return schedule
}

export function selectAdditionalSampleCount(ratio: number, threshold: number): number {
  return isNearThreshold(ratio, threshold) ? 5 : 0
}

export function isNearThreshold(ratio: number, threshold: number, margin = 0.05): boolean {
  if (!Number.isFinite(ratio) || !Number.isFinite(threshold) || threshold <= 0) return false
  const tolerance = threshold * margin
  return Math.abs(ratio - threshold) <= tolerance + Number.EPSILON * Math.max(1, tolerance)
}

export interface BenchmarkSample {
  readonly elapsedMs: number
  readonly backend: BenchmarkBackend
  readonly executedBackend: BenchmarkBackend | undefined
  readonly valid: boolean
  readonly qualityPassed: boolean
  readonly suite?: BenchmarkSuite
  readonly cell?: string
  readonly error?: string
  readonly metadata?: ReproducibilityMetadata
}

export function filterValidSamples(
  samples: ReadonlyArray<BenchmarkSample>
): ReadonlyArray<BenchmarkSample> {
  return samples.filter(
    (sample) =>
      sample.executedBackend === sample.backend &&
      sample.valid &&
      sample.qualityPassed &&
      Number.isFinite(sample.elapsedMs) &&
      sample.elapsedMs >= 0
  )
}

export interface SampleStatistics {
  readonly median: number
  readonly minimum: number
  readonly maximum: number
  readonly firstQuartile: number
  readonly thirdQuartile: number
  readonly iqr: number
  readonly rawSamples: ReadonlyArray<number>
}

function medianOf(sorted: ReadonlyArray<number>): number {
  if (sorted.length === 0) throw new Error('cannot summarize an empty sample set')
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[middle] as number
  return ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2
}

export function summarizeSamples(samples: ReadonlyArray<number>): SampleStatistics {
  if (samples.length === 0 || samples.some((sample) => !Number.isFinite(sample) || sample < 0)) {
    throw new Error('sample set must contain finite non-negative numbers')
  }
  const sorted = [...samples].sort((first, second) => first - second)
  const middle = Math.floor(sorted.length / 2)
  const lowerHalf = sorted.slice(0, middle)
  const upperHalf = sorted.slice(sorted.length % 2 === 0 ? middle : middle + 1)
  const firstQuartile = lowerHalf.length === 0 ? medianOf(sorted) : medianOf(lowerHalf)
  const thirdQuartile = upperHalf.length === 0 ? medianOf(sorted) : medianOf(upperHalf)
  return {
    median: medianOf(sorted),
    minimum: sorted[0] as number,
    maximum: sorted[sorted.length - 1] as number,
    firstQuartile,
    thirdQuartile,
    iqr: thirdQuartile - firstQuartile,
    rawSamples: [...samples]
  }
}

export interface ThresholdInput {
  readonly typescriptMs: number
  readonly rustOneThreadMs: number
  readonly rustDefaultMs: number
}

export interface ThresholdResult {
  readonly oneThreadRatio: number
  readonly defaultThreadRatio: number
  readonly oneThreadPassed: boolean
  readonly defaultThreadPassed: boolean
}

export function evaluateThresholds(
  suites: Readonly<Record<'C5' | 'C6', ThresholdInput>>
): Readonly<Record<'C5' | 'C6', ThresholdResult>> {
  return Object.fromEntries(
    (['C5', 'C6'] as const).map((suite) => {
      const input = suites[suite]
      const oneThreadRatio = input.rustOneThreadMs / input.typescriptMs
      const defaultThreadRatio = input.rustDefaultMs / input.typescriptMs
      return [
        suite,
        {
          oneThreadRatio,
          defaultThreadRatio,
          oneThreadPassed: oneThreadRatio <= P5_THRESHOLDS.oneThread,
          defaultThreadPassed: defaultThreadRatio <= P5_THRESHOLDS.defaultThread
        }
      ]
    })
  ) as Readonly<Record<'C5' | 'C6', ThresholdResult>>
}

export interface AuthoritativeHostStatus {
  readonly authoritative: boolean
  readonly status: 'available' | 'blocked'
  readonly reason?: 'controlled-linux-unavailable'
}

export function makeAuthoritativeHostStatus(input: {
  readonly platform: string
  readonly controlledLinux: boolean
}): AuthoritativeHostStatus {
  if (input.platform === 'linux' && input.controlledLinux) {
    return { authoritative: true, status: 'available' }
  }
  return {
    authoritative: false,
    status: 'blocked',
    reason: 'controlled-linux-unavailable'
  }
}

export type WrapperProvenance = Readonly<Record<string, unknown>>

export function parseWrapperProvenanceJson(source: string): WrapperProvenance {
  const parsed: unknown = JSON.parse(source)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('wrapper provenance must be a JSON object')
  }
  return parsed as WrapperProvenance
}

export interface RawEvidenceEnvelope {
  readonly generatedAt: string
  readonly metadata: ReproducibilityMetadata
  readonly wrapperProvenance?: WrapperProvenance
  readonly samples: ReadonlyArray<BenchmarkSample>
  readonly suites: Readonly<Record<string, unknown>>
}

export async function preserveRawEvidence(
  path: string,
  evidence: RawEvidenceEnvelope
): Promise<string> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
  return path
}

interface CapacityShapeSpec {
  readonly kind: PresetShapeKind
  readonly width: number
  readonly height: number
  readonly count: number
}

interface CapacityFixtureSpec {
  readonly id: string
  readonly source: 'preset' | 'mixed-61'
  readonly shapes: ReadonlyArray<CapacityShapeSpec>
  readonly paddingMm: number
  readonly sheet: SheetSpec
  readonly allowPrepareWarnings?: boolean
}

const MIXED_61_FIXTURE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../tests/fixtures/irregularSheetInvariance/mixed61-request.json'
)
const SHAPES_17_FIXTURE_DIRECTORY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../tests/fixtures/irregularSeventeenShapes'
)

const capacityFixtures: ReadonlyArray<CapacityFixtureSpec> = [
  {
    id: 'capacity-area-proven-rect2',
    source: 'preset',
    shapes: [{ kind: 'rectangle', width: 80, height: 60, count: 2 }],
    paddingMm: 10,
    sheet: new SheetSpec({ width: 100, height: 100, label: 'constrained 100x100' })
  },
  {
    id: 'capacity-singleton-proven',
    source: 'preset',
    shapes: [
      { kind: 'rectangle', width: 150, height: 20, count: 1 },
      { kind: 'rectangle', width: 90, height: 20, count: 1 }
    ],
    paddingMm: 0,
    sheet: new SheetSpec({ width: 100, height: 100, label: 'constrained 100x100' }),
    allowPrepareWarnings: true
  },
  {
    id: 'capacity-archive-miss-squares2',
    source: 'preset',
    shapes: [{ kind: 'rectangle', width: 55, height: 55, count: 2 }],
    paddingMm: 0,
    sheet: new SheetSpec({ width: 100, height: 100, label: 'constrained 100x100' })
  },
  {
    id: 'capacity-count-vs-material',
    source: 'preset',
    shapes: [
      { kind: 'rectangle', width: 90, height: 90, count: 1 },
      { kind: 'rectangle', width: 50, height: 45, count: 2 }
    ],
    paddingMm: 0,
    sheet: new SheetSpec({ width: 100, height: 100, label: 'constrained 100x100' })
  },
  {
    id: 'capacity-triangles20-300x300',
    source: 'preset',
    shapes: [{ kind: 'triangle', width: 70, height: 60, count: 20 }],
    paddingMm: 10,
    sheet: new SheetSpec({ width: 300, height: 300, label: 'constrained 300x300' })
  },
  {
    id: 'capacity-mixed61-500x400',
    source: 'mixed-61',
    shapes: [],
    paddingMm: 10,
    sheet: new SheetSpec({ width: 500, height: 400, label: 'constrained 500x400' })
  },
  {
    id: 'capacity-mixed61-700x500',
    source: 'mixed-61',
    shapes: [],
    paddingMm: 10,
    sheet: new SheetSpec({ width: 700, height: 500, label: 'constrained 700x500' })
  },
  {
    id: 'capacity-mixed61-700x560',
    source: 'mixed-61',
    shapes: [],
    paddingMm: 10,
    sheet: new SheetSpec({ width: 700, height: 560, label: 'constrained 700x560' })
  }
]

function compactSettings(profile: LayoutProfile = 'compact'): IrregularNestingSettings {
  const optimizer = makeCompactQualityIrregularOptimizerSettings({ localRepairBudget: 0 })
  return new IrregularNestingSettings({
    geometry: DEFAULT_IRREGULAR_GEOMETRY_SETTINGS,
    optimizer:
      profile === 'compact'
        ? optimizer
        : new IrregularOptimizerSettings({
            ...optimizer,
            intrinsicObjectiveProfileId: 'short-side'
          })
  })
}

function compactRequestOptions(settings: IrregularNestingSettings): NestingOptions {
  return new NestingOptions({
    allowGlobalRotation: true,
    allowGlobalMirror: true,
    timeoutMs: 180000,
    workerMode: 'irregular-convex-v2',
    historyMode: 'off',
    historyScope: 'winning_path',
    strategySelectionMode: 'single',
    strategyIds: [],
    layoutSelectionStrategyId: 'compact-first',
    finalSelectionMode: 'best',
    irregularSettings: settings
  })
}

function buildPreparedRequest(input: {
  readonly fixture: string
  readonly sheet: SheetSpec
  readonly sources: ReadonlyArray<ImportedPiece>
  readonly settings?: IrregularNestingSettings
  readonly paddingMm?: number
  readonly interchangeabilityKey?: (piece: ImportedPiece) => string
}): NestingRequest {
  const paddingMm = input.paddingMm ?? 10
  const jobId = JobId.make(`p5-${input.fixture}-${input.sheet.label}`)
  const prepared = preparePieces(
    input.sources,
    input.sheet,
    paddingMm,
    jobId,
    undefined,
    undefined,
    input.interchangeabilityKey
  )
  if (prepared.warnings.length > 0) {
    throw new Error(`${input.fixture}: preparation warnings ${JSON.stringify(prepared.warnings)}`)
  }
  const settings = input.settings ?? compactSettings()
  return new NestingRequest({
    version: 1,
    jobId,
    sheet: input.sheet,
    padding: paddingMm,
    pieces: prepared.pieces,
    sourcePieces: input.sources,
    options: compactRequestOptions(settings)
  })
}

function triangleRequest(sheet: SheetSpec, profile: LayoutProfile): NestingRequest {
  const triangle = makePresetShapeDocument({
    kind: 'triangle',
    width: 70,
    height: 60,
    label: 'triangle'
  }).pieces[0]
  if (triangle === undefined) throw new Error('triangle preset must contain one piece')
  const sources = Array.from(
    { length: 20 },
    (_, index) =>
      new ImportedPiece({
        ...triangle,
        id: PieceId.make(`triangle-copy-${index + 1}`),
        sourceFileId: SourceFileId.make(`triangle-source-copy-${index + 1}`),
        label: `triangle copy ${index + 1}`
      })
  )
  return buildPreparedRequest({
    fixture: 'triangle-20',
    sheet,
    sources,
    settings: compactSettings(profile),
    interchangeabilityKey: () => 'triangle-70x60'
  })
}

async function shapes17Request(sheet: SheetSpec, profile: LayoutProfile): Promise<NestingRequest> {
  const fileNames = (await readdir(SHAPES_17_FIXTURE_DIRECTORY))
    .filter((fileName) => fileName.endsWith('.dxf'))
    .sort((first, second) => first.localeCompare(second, undefined, { numeric: true }))
  if (fileNames.length !== 17) throw new Error(`expected 17 DXF files, found ${fileNames.length}`)
  const sources = await Promise.all(
    fileNames.map(async (fileName, index) => {
      const document = await importDxfFile(join(SHAPES_17_FIXTURE_DIRECTORY, fileName))
      const source = document.pieces[0]
      if (source === undefined || document.pieces.length !== 1) {
        throw new Error(`${fileName} must import exactly one piece`)
      }
      if (document.warnings.length > 0 || source.warnings.length > 0) {
        throw new Error(`${fileName} imported with warnings`)
      }
      return new ImportedPiece({
        ...source,
        id: PieceId.make(`shapes-17-${index + 1}`),
        sourceFileId: SourceFileId.make(`shapes-17-source-${index + 1}`),
        label: fileName
      })
    })
  )
  return buildPreparedRequest({
    fixture: 'shapes-17',
    sheet,
    sources,
    settings: compactSettings(profile),
    interchangeabilityKey: () => 'shapes-17'
  })
}

async function mixed61Request(sheet: SheetSpec, profile: LayoutProfile): Promise<NestingRequest> {
  const raw = JSON.parse(await readFile(MIXED_61_FIXTURE_PATH, 'utf8')) as unknown
  const decoded = Schema.decodeUnknownSync(NestingRequest)(raw)
  const settings = decoded.options.irregularSettings
  if (settings === undefined) throw new Error('mixed-61 fixture has no irregular settings')
  const profileSettings = new IrregularNestingSettings({
    ...settings,
    optimizer:
      profile === 'compact'
        ? settings.optimizer
        : new IrregularOptimizerSettings({
            ...settings.optimizer,
            intrinsicObjectiveProfileId: 'short-side'
          })
  })
  return new NestingRequest({
    ...decoded,
    jobId: JobId.make(`p5-mixed-61-${sheet.label}`),
    sheet,
    options: new NestingOptions({
      ...decoded.options,
      timeoutMs: 180000,
      historyMode: 'off',
      irregularSettings: profileSettings
    })
  })
}

async function makeLayoutRequest(row: LayoutBenchmarkRow): Promise<NestingRequest> {
  const sheetParts = row.sheet.split('x').map(Number)
  const width = sheetParts[0]
  const height = sheetParts[1]
  if (width === undefined || height === undefined) throw new Error(`invalid sheet ${row.sheet}`)
  const sheet = new SheetSpec({ width, height, label: row.sheet })
  if (row.fixture === 'triangle-20') return triangleRequest(sheet, row.profile)
  if (row.fixture === 'shapes-17') return shapes17Request(sheet, row.profile)
  return mixed61Request(sheet, row.profile)
}

function makeCapacityPresetRequest(fixture: CapacityFixtureSpec): NestingRequest {
  const sources: ImportedPiece[] = []
  for (const shape of fixture.shapes) {
    const preset = makePresetShapeDocument({
      kind: shape.kind,
      width: shape.width,
      height: shape.height,
      label: shape.kind
    })
    const piece = preset.pieces[0]
    if (piece === undefined) throw new Error(`${fixture.id}: preset must contain one piece`)
    for (let index = 0; index < shape.count; index += 1) {
      const key = `${shape.kind}-${shape.width}x${shape.height}-copy-${index + 1}`
      sources.push(
        new ImportedPiece({
          ...piece,
          id: PieceId.make(key),
          sourceFileId: SourceFileId.make(`source-${key}`),
          label: key
        })
      )
    }
  }
  const jobId = JobId.make(fixture.id)
  const prepared = preparePieces(
    sources,
    fixture.sheet,
    fixture.paddingMm,
    jobId,
    undefined,
    undefined,
    (piece) => piece.label ?? piece.id
  )
  if (prepared.warnings.length > 0 && fixture.allowPrepareWarnings !== true) {
    throw new Error(`${fixture.id}: preparePieces warnings ${JSON.stringify(prepared.warnings)}`)
  }
  return new NestingRequest({
    version: 1,
    jobId,
    sheet: fixture.sheet,
    padding: fixture.paddingMm,
    pieces: prepared.pieces,
    sourcePieces: sources,
    options: compactRequestOptions(
      new IrregularNestingSettings({
        geometry: DEFAULT_IRREGULAR_GEOMETRY_SETTINGS,
        optimizer: makeCompactQualityIrregularOptimizerSettings()
      })
    )
  })
}

async function makeCapacityRequest(fixture: CapacityFixtureSpec): Promise<NestingRequest> {
  if (fixture.source === 'preset') return makeCapacityPresetRequest(fixture)
  const raw = JSON.parse(await readFile(MIXED_61_FIXTURE_PATH, 'utf8')) as unknown
  const decoded = Schema.decodeUnknownSync(NestingRequest)(raw)
  const settings = decoded.options.irregularSettings
  if (settings === undefined) throw new Error(`${fixture.id}: fixture has no irregular settings`)
  return new NestingRequest({
    ...decoded,
    jobId: JobId.make(fixture.id),
    sheet: fixture.sheet,
    options: new NestingOptions({
      ...decoded.options,
      timeoutMs: 180000,
      historyMode: 'off',
      irregularSettings: settings
    })
  })
}

function runTypeScriptBackend(
  request: NestingRequest,
  options: ComputeIrregularNestingOptions
): Effect.Effect<IrregularComputeResult, unknown> {
  const settings = request.options.irregularSettings
  if (settings === undefined) throw new Error(`${request.jobId} has no irregular settings`)
  return computeIrregularNesting(request, options).pipe(
    Effect.provide(CollisionGeometryBuilder.Live),
    Effect.provide(TransformGeneratorLive),
    Effect.provide(NfpIfpServiceLive),
    Effect.provide(FreeMaterialServiceLive),
    Effect.provide(IrregularPlacementScorer.Live),
    Effect.provide(IrregularLayoutScorer.Live),
    Effect.provide(GeometryKernel.Live),
    Effect.provide(Layer.succeed(GeometrySettings, settings))
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

function sha256CanonicalCollisionIdentity(result: IrregularComputeResult): string | undefined {
  const identity = canonicalCollisionLayoutIdentity(result.placedCollisionGeometries)
  if (identity === undefined) return undefined
  return createSha256(identity)
}

function createSha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

interface LayoutExpectation {
  readonly placedCount: number
  readonly unplacedCount: number
  readonly collisionIdentitySha256: string
  readonly fittedCanonicalSha256: string
}

const layoutExpectations: Readonly<Record<string, LayoutExpectation>> = {
  'triangle-20-2000x2700': {
    placedCount: 20,
    unplacedCount: 0,
    collisionIdentitySha256: '371db2696b65e2122b98bdb197a1d327df0c6ecbeca6ed73d2722971be52a127',
    fittedCanonicalSha256: 'b4d1fd9af8a1ecb4a17f1031546c1dbbb5afb19b2d99e41bdb646e52084092f7'
  },
  'mixed-61-2000x2700': {
    placedCount: 61,
    unplacedCount: 0,
    collisionIdentitySha256: '3839e80d26be257381f1962816765a886d4b7e3c3d78120892e4a6a943dfa742',
    fittedCanonicalSha256: 'ef2b783ae12491d2a80a12ef94d1bb2801c13cbd43aeb6e2c1cc00d86828fd3b'
  },
  'shapes-17-2000x2700': {
    placedCount: 17,
    unplacedCount: 0,
    collisionIdentitySha256: '1ddc8426e032ce01b47ff82cae6104fa99a3f92f44f37782d846e1a8b83c8c5d',
    fittedCanonicalSha256: '490194ca505f545cfb5880209d20b2f48cdcffbc847c8686705fd12661b5e7bf'
  },
  'triangle-20-600x400': {
    placedCount: 20,
    unplacedCount: 0,
    collisionIdentitySha256: '371db2696b65e2122b98bdb197a1d327df0c6ecbeca6ed73d2722971be52a127',
    fittedCanonicalSha256: 'b4d1fd9af8a1ecb4a17f1031546c1dbbb5afb19b2d99e41bdb646e52084092f7'
  },
  'mixed-61-600x400': {
    placedCount: 25,
    unplacedCount: 36,
    collisionIdentitySha256: '2c53f3123d5d57ab5e120717ae1e49046bb574925c49c4a33ed4febe7e81e414',
    fittedCanonicalSha256: '39e74c34e0cfcd4929ba3dde53d1b0215ca2c48e383297b15922f07115569f38'
  },
  'shapes-17-600x400': {
    placedCount: 14,
    unplacedCount: 3,
    collisionIdentitySha256: '01b2060d87752bb36eebfd4eb8602709687d5cb00c71b8feaec14a6e7cf9ba12',
    fittedCanonicalSha256: '4472adc8ddfcc26af748adcfeb220e049a4f0e814cb17a99c0dc092db903921e'
  },
  'triangle-20-300x300': {
    placedCount: 17,
    unplacedCount: 3,
    collisionIdentitySha256: '0f5befd7d02fc111be47ee447fab7f8778f06ae05d045448f22a916d66949410',
    fittedCanonicalSha256: '2f236b79c7c49a999daf5363e257bbda6b8562239571c6fedab2485cffb38c35'
  },
  'mixed-61-300x300': {
    placedCount: 6,
    unplacedCount: 55,
    collisionIdentitySha256: 'bb22df3517b4f2bbbdebc1d35704dbf4374f96d264af919a4c8d29dc2168fa33',
    fittedCanonicalSha256: '37d7bf9c37dfe2b9702bf8df73791782006178eb570ac043b23f1ca20ca22c0b'
  },
  'shapes-17-300x300': {
    placedCount: 5,
    unplacedCount: 12,
    collisionIdentitySha256: 'e4ad1ce1c7fa26e7a00ba38a5d9c11e1908ebf753031ff4811420d5097be7c71',
    fittedCanonicalSha256: 'bccfa5a4b7db4b5009a8c0f12d7c6f308c9a72550df3feb218355f33a5c1ef18'
  }
}

const shortSideExpectations: Readonly<Record<string, LayoutExpectation>> = {
  'triangle-20-2000x2700': {
    placedCount: 20,
    unplacedCount: 0,
    collisionIdentitySha256: '7a79ebd40029094854748d569acb52f95f32a96e71b3b674941ba7f20f9cfe15',
    fittedCanonicalSha256: 'bc978c3710e6865a68c4c965fde545d0421d5d915319056b5a67689a6e918e5a'
  },
  'mixed-61-2000x2700': {
    placedCount: 61,
    unplacedCount: 0,
    collisionIdentitySha256: 'c38a0cb4bb7765e4db102869224ef5b51f2a0bbc787cea05adf94ca0e2fe5e22',
    fittedCanonicalSha256: '2a63c729108ba7680339cebaf86d4e39368a020eee95580caf9811d6d2bbc2ca'
  },
  'shapes-17-2000x2700': {
    placedCount: 17,
    unplacedCount: 0,
    collisionIdentitySha256: 'b1902994bbc318522d3684b32ec3fba692aad0116ef9dad2985a1a32cdb1a2df',
    fittedCanonicalSha256: '90bc2d76ef247394edd0719693c3aada9d8db7f9b334ccda3bcfd3c3559f8135'
  },
  'triangle-20-600x400': {
    placedCount: 20,
    unplacedCount: 0,
    collisionIdentitySha256: '6ca8e267b18556ae57f459a33cf2cccbf885bac1f0f362eaad8c676d9d189196',
    fittedCanonicalSha256: 'fd075d118e29a5089ea684bc5af26ad4cf83f560fc7a525316d96921549957b2'
  },
  'mixed-61-600x400': {
    placedCount: 25,
    unplacedCount: 36,
    collisionIdentitySha256: '7a2d7906095f69b8def581738fd68d4ca9e27ee223f32646367e6fd71658675e',
    fittedCanonicalSha256: '86d65b16b47cfe43936db0fe383ac66408d811880c9dc52fb3ea4bf572933e67'
  },
  'shapes-17-600x400': {
    placedCount: 14,
    unplacedCount: 3,
    collisionIdentitySha256: 'ec2d5653fa92f45a96bf48143a216fe93e0908c5b3f2c8a571c869e4e7baace7',
    fittedCanonicalSha256: '3812e0e1c7731f6ffcf9ae20a946c357fb41c460911dd185632003af6d306fc4'
  },
  'triangle-20-300x300': {
    placedCount: 17,
    unplacedCount: 3,
    collisionIdentitySha256: 'f7ddba15b5122ec7335c17bf2fe01851a9061ad500742f1efbcc716d9cc5cc55',
    fittedCanonicalSha256: 'c149a21ba24b32fb029e0e5ac8cf515483ccbce673750f7458a95bf522b011b5'
  },
  'mixed-61-300x300': {
    placedCount: 6,
    unplacedCount: 55,
    collisionIdentitySha256: 'e0647c8175bfadb7c158720978b7e2f0b9ab44496ac55bb90f42205fd17f7858',
    fittedCanonicalSha256: 'c37e7e68e19c7ac35195def7324091782dcfb4d933c716f0cca7a3f10ee15707'
  },
  'shapes-17-300x300': {
    placedCount: 5,
    unplacedCount: 12,
    collisionIdentitySha256: '5d1412d3c3591612bffa40a451ab8f60e5cafaa6ad69ae1aaecaf18653067d9c',
    fittedCanonicalSha256: '454ed333f6e94089e94f5569ef6ac7f53c43d9a95862a05abca18d214104a005'
  }
}

const capacityExpectations: Readonly<Record<string, Partial<LayoutExpectation>>> = {
  'capacity-area-proven-rect2': { placedCount: 1, unplacedCount: 1 },
  'capacity-singleton-proven': { placedCount: 1, unplacedCount: 1 },
  'capacity-archive-miss-squares2': { placedCount: 1, unplacedCount: 1 },
  'capacity-count-vs-material': { placedCount: 2, unplacedCount: 1 },
  'capacity-triangles20-300x300': {
    placedCount: 17,
    unplacedCount: 3,
    fittedCanonicalSha256: '2f236b79c7c49a999daf5363e257bbda6b8562239571c6fedab2485cffb38c35'
  },
  'capacity-mixed61-700x500': {
    placedCount: 50,
    unplacedCount: 11,
    fittedCanonicalSha256: '97dbc5029a050389b9b8f440dfd764e0b758e75c5cbfdbc8f27e1c0ddcdca04b'
  },
  'capacity-mixed61-700x560': {
    placedCount: 59,
    unplacedCount: 2,
    fittedCanonicalSha256: '36cee3489abffe6f5961a7ae96cbe9ce34d33d8754c9822841abb7585117ba16'
  }
}

function validateResult(
  request: NestingRequest,
  result: IrregularComputeResult,
  expectation: Partial<LayoutExpectation> | undefined
): boolean {
  const requestedIds = request.pieces.map(({ id }) => id).sort()
  const accountedIds = [
    ...result.placedCollisionGeometries.map(
      ({ placement }) => placement.pieceId ?? placement.sourcePieceId
    ),
    ...result.unplacedPieceIds
  ].sort()
  const partitionExact =
    requestedIds.length === accountedIds.length &&
    requestedIds.every((id, index) => id === accountedIds[index])
  if (!partitionExact) return false
  if (expectation === undefined) return true
  if (
    expectation.placedCount !== undefined &&
    result.placedCollisionGeometries.length !== expectation.placedCount
  ) {
    return false
  }
  if (
    expectation.unplacedCount !== undefined &&
    result.unplacedPieceIds.length !== expectation.unplacedCount
  ) {
    return false
  }
  const collisionIdentity = sha256CanonicalCollisionIdentity(result)
  if (
    expectation.collisionIdentitySha256 !== undefined &&
    collisionIdentity !== expectation.collisionIdentitySha256
  ) {
    return false
  }
  const polygons = absoluteCollisionPolygons(result)
  const fittedCanonical =
    polygons.length === 0 ? undefined : canonicalizeIrregularLayout(polygons).sha256
  if (
    expectation.fittedCanonicalSha256 !== undefined &&
    fittedCanonical !== expectation.fittedCanonicalSha256
  ) {
    return false
  }
  const topology = measureCanonicalLayoutTopologyExact(result.placedCollisionGeometries)
  return topology !== undefined && topology.topology.enclosedCavityCount >= 0
}

interface BackendExecution {
  readonly elapsedMs: number
  readonly executedBackend: BenchmarkBackend | undefined
  readonly result: IrregularComputeResult | undefined
  readonly valid: boolean
  readonly qualityPassed: boolean
  readonly actualThreadCount: number | undefined
  readonly error?: string
}

async function withRustThreadSetting<T>(
  setting: RustThreadSetting,
  callback: () => Promise<T>
): Promise<T> {
  const previous = process.env.MIN_PLANE_IRREGULAR_NATIVE_THREADS
  if (setting === 'default') {
    delete process.env.MIN_PLANE_IRREGULAR_NATIVE_THREADS
  } else {
    process.env.MIN_PLANE_IRREGULAR_NATIVE_THREADS = String(setting)
  }
  try {
    return await callback()
  } finally {
    if (previous === undefined) delete process.env.MIN_PLANE_IRREGULAR_NATIVE_THREADS
    else process.env.MIN_PLANE_IRREGULAR_NATIVE_THREADS = previous
  }
}

function nativeThreadCount(): number | undefined {
  try {
    const parsed = JSON.parse(loadNativeIrregularAddon().getLastJobDiagnostics()) as {
      readonly threadCountUsed?: unknown
    }
    return typeof parsed.threadCountUsed === 'number' ? parsed.threadCountUsed : undefined
  } catch {
    return undefined
  }
}

async function executeBackend(input: {
  readonly request: NestingRequest
  readonly backend: BenchmarkBackend
  readonly rustThreads: RustThreadSetting
  readonly expectation: Partial<LayoutExpectation> | undefined
  readonly capacity: boolean
}): Promise<BackendExecution> {
  let startedAt = performance.now()
  try {
    if (input.backend === 'typescript') {
      const options: ComputeIrregularNestingOptions = input.capacity
        ? COMPARABLE_CAPACITY_OPTIONS
        : {}
      const result = await Effect.runPromise(runTypeScriptBackend(input.request, options))
      return {
        elapsedMs: Math.max(0, performance.now() - startedAt),
        executedBackend: 'typescript',
        result,
        valid: true,
        qualityPassed: validateResult(input.request, result, input.expectation),
        actualThreadCount: undefined
      }
    }
    const probe: NativeCapabilityProbe = probeNativeIrregularAddon()
    if (!probe.available) {
      return {
        elapsedMs: Math.max(0, performance.now() - startedAt),
        executedBackend: undefined,
        result: undefined,
        valid: false,
        qualityPassed: false,
        actualThreadCount: undefined,
        error: `${probe.reason}: ${probe.detail}`
      }
    }
    return await withRustThreadSetting(input.rustThreads, async () => {
      startedAt = performance.now()
      const result = await Effect.runPromise(
        computeIrregularNestingNative(
          input.request,
          input.request.options.irregularSettings ?? GeometrySettings.Make
        )
      )
      return {
        elapsedMs: Math.max(0, performance.now() - startedAt),
        executedBackend: 'rust' as const,
        result,
        valid: true,
        qualityPassed: validateResult(input.request, result, input.expectation),
        actualThreadCount: nativeThreadCount()
      }
    })
  } catch (error) {
    return {
      elapsedMs: Math.max(0, performance.now() - startedAt),
      executedBackend: input.backend === 'typescript' ? 'typescript' : undefined,
      result: undefined,
      valid: false,
      qualityPassed: false,
      actualThreadCount: undefined,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

interface SuiteCase {
  readonly id: string
  readonly request: NestingRequest
  readonly expectation: Partial<LayoutExpectation> | undefined
  readonly capacity: boolean
}

async function makeSuiteCases(suite: BenchmarkSuite): Promise<ReadonlyArray<SuiteCase>> {
  if (suite === 'C5' || suite === 'C7') {
    const rows = selectSuiteRows(suite, suite === 'C5' ? C5_COMPACT_ROWS : C7_SHORT_SIDE_ROWS)
    const expectations = suite === 'C5' ? layoutExpectations : shortSideExpectations
    return Promise.all(
      rows.map(async (row) => ({
        id: row.id,
        request: await makeLayoutRequest(row),
        expectation: expectations[row.id],
        capacity: false
      }))
    )
  }
  return Promise.all(
    capacityFixtures.map(async (fixture) => ({
      id: fixture.id,
      request: await makeCapacityRequest(fixture),
      expectation: capacityExpectations[fixture.id],
      capacity: true
    }))
  )
}

interface TimedSuiteRun {
  readonly suite: BenchmarkSuite
  readonly backend: BenchmarkBackend
  readonly rustThreads: RustThreadSetting
  readonly executedBackend: BenchmarkBackend | undefined
  readonly elapsedMs: number
  readonly valid: boolean
  readonly qualityPassed: boolean
  readonly actualThreadCounts: ReadonlyArray<number | undefined>
  readonly errors: ReadonlyArray<string>
  readonly metadata: ReproducibilityMetadata
}

export async function runSuiteOnce(input: {
  readonly suite: BenchmarkSuite
  readonly backend: BenchmarkBackend
  readonly rustThreads: RustThreadSetting
}): Promise<TimedSuiteRun> {
  const cases = await makeSuiteCases(input.suite)
  const executions: BackendExecution[] = []
  for (const suiteCase of cases) {
    executions.push(
      await executeBackend({
        request: suiteCase.request,
        backend: input.backend,
        rustThreads: input.rustThreads,
        expectation: suiteCase.expectation,
        capacity: suiteCase.capacity
      })
    )
  }
  const executedBackend = executions.every(
    ({ executedBackend }) => executedBackend === input.backend
  )
    ? input.backend
    : undefined
  const actualThreadCount = executions.find(
    ({ actualThreadCount }) => actualThreadCount !== undefined
  )?.actualThreadCount
  const probe = probeNativeIrregularAddon()
  const metadata = collectReproducibilityMetadata({
    backendExecuted: executedBackend,
    ...(actualThreadCount === undefined ? {} : { actualThreadCount }),
    cachePolicy: COMPARABLE_CAPACITY_CACHE_POLICY,
    probe
  })
  return {
    suite: input.suite,
    backend: input.backend,
    rustThreads: input.rustThreads,
    executedBackend,
    elapsedMs: executions.reduce((total, execution) => total + execution.elapsedMs, 0),
    valid: executions.every(({ valid }) => valid),
    qualityPassed: executions.every(({ qualityPassed }) => qualityPassed),
    actualThreadCounts: executions.map(({ actualThreadCount }) => actualThreadCount),
    errors: executions.flatMap(({ error }) => (error === undefined ? [] : [error])),
    metadata
  }
}

function commandOutput(command: string, args: ReadonlyArray<string>): string | undefined {
  try {
    return execFileSync(command, [...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  } catch {
    return undefined
  }
}

function gitCommit(): string | undefined {
  return commandOutput('git', ['rev-parse', 'HEAD'])
}

function gitDirty(): boolean | undefined {
  const output = commandOutput('git', ['status', '--porcelain'])
  return output === undefined ? undefined : output.length > 0
}

function rustVersion(): { readonly version?: string; readonly targetTriple?: string } {
  const output = commandOutput('rustc', ['-vV'])
  if (output === undefined) return {}
  const version = output.split('\n')[0]?.replace(/^rustc\s+/, '')
  const targetTriple = output
    .split('\n')
    .find((line) => line.startsWith('host: '))
    ?.slice('host: '.length)
  return {
    ...(version === undefined ? {} : { version }),
    ...(targetTriple === undefined ? {} : { targetTriple })
  }
}

export interface ReproducibilityMetadata {
  readonly exactCommand: string
  readonly commit: string | undefined
  readonly dirty: boolean | undefined
  readonly nodeVersion: string
  readonly pnpmVersion: string | undefined
  readonly rustcVersion: string | undefined
  readonly targetTriple: string | undefined
  readonly kernel: string
  readonly cpu: string | undefined
  readonly cpuCount: number
  readonly memoryBytes: number
  readonly nativeApiVersion: number | undefined
  readonly nativeCrateVersion: string | undefined
  readonly advertisedNativeProfiles: ReadonlyArray<string>
  readonly actualThreadCount: number | undefined
  readonly cachePolicy: string
  readonly backendExecuted: BenchmarkBackend | undefined
}

export function collectReproducibilityMetadata(input: {
  readonly backendExecuted: BenchmarkBackend | undefined
  readonly actualThreadCount?: number
  readonly cachePolicy: string
  readonly probe?: NativeCapabilityProbe
  readonly argv?: ReadonlyArray<string>
}): ReproducibilityMetadata {
  const rust = rustVersion()
  const probe = input.probe?.available === true ? input.probe : undefined
  return {
    exactCommand: (input.argv ?? process.argv).join(' '),
    commit: gitCommit(),
    dirty: gitDirty(),
    nodeVersion: process.version,
    pnpmVersion: commandOutput('pnpm', ['--version']),
    rustcVersion: rust.version,
    targetTriple: rust.targetTriple,
    kernel: `${hostPlatform()} ${release()}`,
    cpu: cpus()[0]?.model,
    cpuCount: cpus().length,
    memoryBytes: totalmem(),
    nativeApiVersion: probe?.nativeApiVersion,
    nativeCrateVersion: probe?.backendVersion,
    advertisedNativeProfiles: probe?.profiles ?? [],
    actualThreadCount: input.actualThreadCount,
    cachePolicy: input.cachePolicy,
    backendExecuted: input.backendExecuted
  }
}

interface CliArguments {
  readonly suites: ReadonlyArray<BenchmarkSuite>
  readonly rustThreads: ReadonlyArray<RustThreadSetting>
  readonly measuredSamples: number
  readonly includeWarmups: boolean
  readonly outputPath: string
  readonly wrapperProvenancePath: string | undefined
  readonly controlledLinux: boolean
  readonly dryRun: boolean
  readonly help: boolean
}

function parseRustThreads(value: string): ReadonlyArray<RustThreadSetting> {
  if (value === 'matrix') return [1, 2, 'default', 8]
  if (value === 'default') return ['default']
  const parsed = Number(value)
  if (parsed === 1 || parsed === 2 || parsed === 8) return [parsed]
  throw new Error('--rust-threads must be 1, 2, 8, default, or matrix')
}

function parseCliArguments(argv: ReadonlyArray<string>): CliArguments {
  let suites: ReadonlyArray<BenchmarkSuite> = ['C5', 'C6', 'C7']
  let rustThreads: ReadonlyArray<RustThreadSetting> = [1, 'default']
  let measuredSamples = 3
  let includeWarmups = true
  let outputPath = join(process.cwd(), 'p5-aggregate-evidence.json')
  let wrapperProvenancePath: string | undefined
  let controlledLinux = process.env.P5_CONTROLLED_LINUX === '1'
  let dryRun = false
  let help = false
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--help' || argument === '-h') help = true
    else if (argument === '--dry-run') dryRun = true
    else if (argument === '--controlled-linux') controlledLinux = true
    else if (argument === '--skip-warmups') includeWarmups = false
    else if (argument === '--suite') {
      const value = argv[index + 1]
      index += 1
      if (value !== 'C5' && value !== 'C6' && value !== 'C7')
        throw new Error('--suite must be C5, C6, or C7')
      suites = [value]
    } else if (argument === '--rust-threads') {
      rustThreads = parseRustThreads(argv[index + 1] ?? '')
      index += 1
    } else if (argument === '--samples') {
      const parsed = Number(argv[index + 1])
      if (!Number.isInteger(parsed) || parsed <= 0)
        throw new Error('--samples must be a positive integer')
      measuredSamples = parsed
      index += 1
    } else if (argument === '--output') {
      outputPath = argv[index + 1] ?? outputPath
      index += 1
    } else if (argument === '--wrapper-provenance') {
      const value = argv[index + 1]
      if (value === undefined) throw new Error('--wrapper-provenance requires a path')
      wrapperProvenancePath = value
      index += 1
    } else {
      throw new Error(`unrecognized argument ${JSON.stringify(argument)}`)
    }
  }
  return {
    suites,
    rustThreads,
    measuredSamples,
    includeWarmups,
    outputPath,
    wrapperProvenancePath,
    controlledLinux,
    dryRun,
    help
  }
}

function printHelp(): void {
  console.log(`Usage: pnpm exec tsx --tsconfig tsconfig.node.json scripts/rust-parity/measure-p5-aggregate.ts [options]

Options:
  --suite C5|C6|C7       Measure one suite (default: all three)
  --rust-threads value    1, 2, 8, default, or matrix (default: 1 and default)
  --samples N             Measured samples per backend/thread cell (default: 3)
  --skip-warmups           Omit discarded warmups for bounded profiling only
  --controlled-linux      Declare that this process runs on the controlled Linux host
  --output PATH           Preserve raw JSON evidence at PATH
  --wrapper-provenance PATH
                          Include wrapper-owned host/container classification in raw evidence
  --dry-run               Print the explicit schedule without running algorithms
  --help                  Print this help

The benchmark always dispatches an explicit TypeScript or Rust backend. Local macOS
measurements are non-authoritative and cannot produce a P5 verdict.`)
}

export interface AggregateCellStatistics {
  readonly key: string
  readonly suite: BenchmarkSuite
  readonly backend: BenchmarkBackend
  readonly rustThreads: RustThreadSetting
  readonly sampleCount: number
  readonly validSampleCount: number
  readonly statistics: SampleStatistics | undefined
}

export interface AggregateReport {
  readonly host: AuthoritativeHostStatus
  readonly metadata: ReproducibilityMetadata
  readonly wrapperProvenance: WrapperProvenance | undefined
  readonly schedules: Readonly<Record<string, ReadonlyArray<MeasurementScheduleItem>>>
  readonly runs: ReadonlyArray<TimedSuiteRun>
  readonly statistics: ReadonlyArray<AggregateCellStatistics>
  readonly thresholds: Readonly<Partial<Record<'C5' | 'C6', ThresholdResult>>>
  readonly verdict: 'pass' | 'fail' | 'blocked' | 'unevaluated'
}

function explicitCellKey(suite: BenchmarkSuite, threads: RustThreadSetting): string {
  return `${suite}:rust-${threads}`
}

function runToSample(run: TimedSuiteRun): BenchmarkSample {
  return {
    elapsedMs: run.elapsedMs,
    backend: run.backend,
    executedBackend: run.executedBackend,
    valid: run.valid,
    qualityPassed: run.qualityPassed,
    suite: run.suite,
    cell: explicitCellKey(run.suite, run.rustThreads),
    ...(run.errors.length === 0 ? {} : { error: run.errors.join('; ') }),
    metadata: run.metadata
  }
}

function collectCellStatistics(
  runs: ReadonlyArray<TimedSuiteRun>,
  suites: ReadonlyArray<BenchmarkSuite>,
  rustThreads: ReadonlyArray<RustThreadSetting>
): ReadonlyArray<AggregateCellStatistics> {
  const statistics: AggregateCellStatistics[] = []
  for (const suite of suites) {
    const cells: ReadonlyArray<BackendThreadCell> = [
      { backend: 'typescript', rustThreads: 'default' },
      ...rustThreads.map((threads) => ({ backend: 'rust' as const, rustThreads: threads }))
    ]
    for (const { backend, rustThreads: threads } of cells) {
      const key = explicitCellKey(suite, threads)
      const cellRuns = runs.filter(
        (run) => run.suite === suite && run.rustThreads === threads && run.backend === backend
      )
      const validSamples = filterValidSamples(cellRuns.map(runToSample))
      statistics.push({
        key,
        suite,
        backend,
        rustThreads: threads,
        sampleCount: cellRuns.length,
        validSampleCount: validSamples.length,
        statistics:
          validSamples.length === 0
            ? undefined
            : summarizeSamples(validSamples.map(({ elapsedMs }) => elapsedMs))
      })
    }
  }
  return statistics
}

function cellMedian(
  statistics: ReadonlyArray<AggregateCellStatistics>,
  suite: 'C5' | 'C6',
  backend: BenchmarkBackend,
  rustThreads: RustThreadSetting
): number | undefined {
  return statistics.find(
    (entry) =>
      entry.suite === suite && entry.backend === backend && entry.rustThreads === rustThreads
  )?.statistics?.median
}

export function collectThresholds(
  statistics: ReadonlyArray<AggregateCellStatistics>,
  suites: ReadonlyArray<BenchmarkSuite>
): Readonly<Partial<Record<'C5' | 'C6', ThresholdResult>>> {
  const result: Partial<Record<'C5' | 'C6', ThresholdResult>> = {}
  for (const suite of suites) {
    if (suite !== 'C5' && suite !== 'C6') continue
    const typescriptMs = cellMedian(statistics, suite, 'typescript', 'default')
    const oneThread = {
      typescriptMs,
      rustMs: cellMedian(statistics, suite, 'rust', 1)
    }
    const defaultThread = {
      typescriptMs,
      rustMs: cellMedian(statistics, suite, 'rust', 'default')
    }
    if (
      oneThread.typescriptMs === undefined ||
      oneThread.rustMs === undefined ||
      defaultThread.typescriptMs === undefined ||
      defaultThread.rustMs === undefined
    ) {
      continue
    }
    const oneThreadRatio = oneThread.rustMs / oneThread.typescriptMs
    const defaultThreadRatio = defaultThread.rustMs / defaultThread.typescriptMs
    result[suite] = {
      oneThreadRatio,
      defaultThreadRatio,
      oneThreadPassed: oneThreadRatio <= P5_THRESHOLDS.oneThread,
      defaultThreadPassed: defaultThreadRatio <= P5_THRESHOLDS.defaultThread
    }
  }
  return result
}

async function runAggregate(args: CliArguments): Promise<AggregateReport> {
  const wrapperProvenance =
    args.wrapperProvenancePath === undefined
      ? undefined
      : parseWrapperProvenanceJson(await readFile(args.wrapperProvenancePath, 'utf8'))
  const host = makeAuthoritativeHostStatus({
    platform: hostPlatform(),
    controlledLinux: args.controlledLinux
  })
  const schedules: Record<string, ReadonlyArray<MeasurementScheduleItem>> = {}
  const runs: TimedSuiteRun[] = []
  const appendScheduleRuns = async (
    suite: BenchmarkSuite,
    schedule: ReadonlyArray<MeasurementScheduleItem>
  ): Promise<void> => {
    for (const item of schedule) {
      const run = await runSuiteOnce({
        suite,
        backend: item.backend,
        rustThreads: item.rustThreads
      })
      if (item.phase === 'measured') runs.push(run)
    }
  }

  for (const suite of args.suites) {
    for (const rustThreads of args.rustThreads) {
      const key = explicitCellKey(suite, rustThreads)
      const initialSchedule = buildMeasurementSchedule({
        measuredSamples: args.measuredSamples,
        rustThreads,
        includeWarmups: args.includeWarmups
      })
      schedules[key] = initialSchedule
      if (!args.dryRun) await appendScheduleRuns(suite, initialSchedule)
    }
  }

  if (!args.dryRun) {
    let statistics = collectCellStatistics(runs, args.suites, args.rustThreads)
    for (const suite of args.suites) {
      if (suite !== 'C5' && suite !== 'C6') continue
      for (const rustThreads of args.rustThreads) {
        if (rustThreads !== 1 && rustThreads !== 'default') continue
        const tsMedian = cellMedian(statistics, suite, 'typescript', 'default')
        const rustMedian = cellMedian(statistics, suite, 'rust', rustThreads)
        const threshold = rustThreads === 1 ? P5_THRESHOLDS.oneThread : P5_THRESHOLDS.defaultThread
        if (tsMedian === undefined || rustMedian === undefined) continue
        const ratio = rustMedian / tsMedian
        const extraSamples = selectAdditionalSampleCount(ratio, threshold)
        if (extraSamples === 0) continue
        const key = explicitCellKey(suite, rustThreads)
        const extraSchedule = buildMeasurementSchedule({
          measuredSamples: extraSamples,
          rustThreads,
          includeWarmups: false
        })
        schedules[key] = [...(schedules[key] ?? []), ...extraSchedule]
        await appendScheduleRuns(suite, extraSchedule)
        statistics = collectCellStatistics(runs, args.suites, args.rustThreads)
      }
    }
  }

  const statistics = collectCellStatistics(runs, args.suites, args.rustThreads)
  const thresholds = collectThresholds(statistics, args.suites)
  const selectedRunsValid =
    runs.length > 0 && runs.every(({ valid, qualityPassed }) => valid && qualityPassed)
  const requiredThresholdsPresent = thresholds.C5 !== undefined && thresholds.C6 !== undefined
  const allThresholdsPassed = Object.values(thresholds).every(
    (threshold) => threshold.oneThreadPassed && threshold.defaultThreadPassed
  )
  const lastRun = runs.at(-1)
  const metadata =
    lastRun?.metadata ??
    collectReproducibilityMetadata({
      backendExecuted: undefined,
      cachePolicy: COMPARABLE_CAPACITY_CACHE_POLICY,
      probe: probeNativeIrregularAddon()
    })
  const verdict: AggregateReport['verdict'] = args.dryRun
    ? 'unevaluated'
    : !host.authoritative
      ? 'blocked'
      : !selectedRunsValid || !requiredThresholdsPresent
        ? 'unevaluated'
        : allThresholdsPassed
          ? 'pass'
          : 'fail'
  return {
    host,
    metadata,
    wrapperProvenance,
    schedules,
    runs,
    statistics,
    thresholds,
    verdict
  }
}

async function main(): Promise<void> {
  const args = parseCliArguments(process.argv.slice(2))
  if (args.help) {
    printHelp()
    return
  }
  const report = await runAggregate(args)
  if (!args.dryRun) {
    await preserveRawEvidence(args.outputPath, {
      generatedAt: new Date().toISOString(),
      metadata: report.metadata,
      ...(report.wrapperProvenance === undefined
        ? {}
        : { wrapperProvenance: report.wrapperProvenance }),
      samples: report.runs.flatMap((run) =>
        run.errors.length === 0
          ? [
              {
                elapsedMs: run.elapsedMs,
                backend: run.backend,
                executedBackend: run.executedBackend,
                valid: run.valid,
                qualityPassed: run.qualityPassed,
                suite: run.suite,
                cell: explicitCellKey(run.suite, run.rustThreads),
                metadata: run.metadata
              }
            ]
          : [
              {
                elapsedMs: run.elapsedMs,
                backend: run.backend,
                executedBackend: run.executedBackend,
                valid: false,
                qualityPassed: false,
                suite: run.suite,
                cell: explicitCellKey(run.suite, run.rustThreads),
                error: run.errors.join('; '),
                metadata: run.metadata
              }
            ]
      ),
      suites: {
        schedules: report.schedules,
        statistics: report.statistics,
        thresholds: report.thresholds,
        host: report.host,
        verdict: report.verdict
      }
    })
  }
  console.log(JSON.stringify(report, null, 2))
  if (report.verdict === 'blocked') {
    console.error('[measure-p5-aggregate] authoritative Linux evidence is blocked')
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(
      `[measure-p5-aggregate] FAILED: ${error instanceof Error ? error.message : String(error)}`
    )
    process.exitCode = 1
  })
}
