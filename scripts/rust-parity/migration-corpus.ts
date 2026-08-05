#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Effect, Schema } from 'effect'

import type { IrregularComputeResult } from '../../src/workers/algorithm/irregular/computeIrregularNesting.js'
import { canonicalCollisionLayoutIdentity } from '../../src/workers/irregular/canonicalLayoutGeometry.js'
import {
  computeIrregularNestingNativeWithTransportForTests,
  encodeNativeRequestJson,
  type NativeIrregularJobTransport
} from '../../src/workers/irregular/native/nativeIrregularBackend.js'
import {
  loadNativeIrregularAddon,
  probeNativeIrregularAddon
} from '../../src/workers/irregular/native/loadNativeBackend.js'
import { GeometrySettings } from '../../src/workers/irregular/geometryKernel.js'
import { projectIrregularDifferentialOutcome } from '../../src/workers/irregular/differential/irregularSemanticComparison.js'
import { NestingRequest } from '@shared/domain/nesting.js'
import { canonicalizeIrregularLayout } from '../lib/irregularLayoutCanonicalization.js'
import { loadDifferentialRequest, type DifferentialArgs } from './run-differential.js'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const DEFAULT_OUTPUT_DIRECTORY = join(
  REPO_ROOT,
  'docs/artifacts/polygon-nesting-extraction-baseline'
)
const HASH_PATTERN = /^[0-9a-f]{64}$/
const FIXTURES = ['triangle-20', 'mixed61', 'shapes-17'] as const
const SHEETS = ['2000x2700', '600x400', '300x300'] as const
const PROFILES = ['compact', 'short-side'] as const
const ARTIFACT_KEYS = ['request', 'result', 'events', 'semanticProjection', 'metadata'] as const
const MANAGED_OUTPUT_NAMES = [
  'migration-corpus',
  'native-vectors.sha256',
  'source-fixtures.sha256',
  'legal-and-addon.sha256',
  'package-manifest.json',
  'migration-corpus.json',
  'SHA256SUMS'
] as const

interface PackageDryRunFile {
  readonly path: string
}

interface PackageDryRunEntry {
  readonly files?: ReadonlyArray<PackageDryRunFile>
}

interface SourceFixtureMetadata {
  readonly kind: 'file' | 'generated'
  readonly path?: string
  readonly description?: string
  readonly sha256: string
}

export interface MigrationMetadata {
  readonly acceptedEngine: 'old-rust'
  readonly sourceFixtures: ReadonlyArray<SourceFixtureMetadata>
  readonly profile: 'compact' | 'short-side'
  readonly sheet: { readonly width: number; readonly height: number }
  readonly workers: { readonly requested: number; readonly actual: number }
  readonly collisionIdentitySha256: string
  readonly fittedIdentitySha256: string
  readonly normalizedSemanticSha256: string
  readonly targetTriple: string
  readonly rustcIdentity: string
  readonly cargoIdentity: string
  readonly build: {
    readonly profile: 'release'
    readonly features: ReadonlyArray<string>
  }
  readonly nativeDependencies: ReadonlyArray<{
    readonly name: string
    readonly version: string
    readonly features?: ReadonlyArray<string>
  }>
}

interface CorpusRow {
  readonly id: string
  readonly fixture: string
  readonly sheet: string
  readonly profile: string
  readonly artifacts: Readonly<Record<(typeof ARTIFACT_KEYS)[number], string>>
  readonly sha256: Readonly<Record<(typeof ARTIFACT_KEYS)[number], string>>
}

interface MigrationCorpus {
  readonly version: number
  readonly acceptedEngine?: string
  readonly rows: ReadonlyArray<CorpusRow>
}

interface NativeJobDiagnostics {
  readonly backendVersion: string
  readonly threadCountUsed: number
  readonly threadCountRequested: number
}

function sha256Bytes(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function jsonText(value: unknown): string {
  return `${JSON.stringify(
    value,
    (_key, entry: unknown) => (typeof entry === 'bigint' ? entry.toString() : entry),
    2
  )}\n`
}

function isContainedPath(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate)
  return (
    relativePath === '' ||
    (!relativePath.startsWith(`..${sep}`) && relativePath !== '..' && !isAbsolute(relativePath))
  )
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function readRegularContainedFile(
  rootDirectory: string,
  path: string,
  label: string
): Promise<Buffer> {
  const root = resolve(rootDirectory)
  const candidate = resolve(path)
  if (!isContainedPath(root, candidate)) {
    throw new Error(`${label} escapes ${rootDirectory}: ${path}`)
  }

  const rootStatus = await lstat(root)
  if (rootStatus.isSymbolicLink()) throw new Error(`${label} root is a symlink: ${root}`)
  if (!rootStatus.isDirectory()) throw new Error(`${label} root is not a directory: ${root}`)
  let current = root
  for (const component of relative(root, candidate).split(sep).filter(Boolean)) {
    current = join(current, component)
    const status = await lstat(current)
    if (status.isSymbolicLink()) throw new Error(`${label} path component is a symlink: ${current}`)
  }

  const status = await lstat(candidate)
  if (!status.isFile()) throw new Error(`${label} is not a regular file: ${candidate}`)
  const [resolvedRoot, resolvedPath] = await Promise.all([realpath(root), realpath(candidate)])
  if (!isContainedPath(resolvedRoot, resolvedPath)) {
    throw new Error(`${label} realpath escapes ${rootDirectory}: ${resolvedPath}`)
  }
  return readFile(resolvedPath)
}

export async function validateMigrationCorpusOutputDirectory(
  outputDirectory: string,
  baselineDirectory = DEFAULT_OUTPUT_DIRECTORY
): Promise<{ readonly kind: 'baseline' | 'fresh-child' }> {
  const output = resolve(outputDirectory)
  const baseline = resolve(baselineDirectory)
  if (output !== baseline && dirname(output) !== baseline) {
    throw new Error('output directory must be the baseline directory or a fresh direct child')
  }

  if (await pathExists(baseline)) {
    const baselineStatus = await lstat(baseline)
    if (!baselineStatus.isDirectory() || baselineStatus.isSymbolicLink()) {
      throw new Error('baseline output path must be a real directory')
    }
  } else if (output !== baseline) {
    throw new Error('baseline directory must exist before creating a fresh output child')
  }

  if (output === baseline) return { kind: 'baseline' }
  if (await pathExists(output)) throw new Error('fresh output child already exists')
  return { kind: 'fresh-child' }
}

async function clearManagedOutput(directory: string): Promise<void> {
  await Promise.all(
    MANAGED_OUTPUT_NAMES.map((name) => rm(join(directory, name), { recursive: true, force: true }))
  )
}

export async function generateMigrationCorpusAtomically(
  outputDirectory: string,
  generateAndValidate: (stagingDirectory: string, logicalOutputDirectory: string) => Promise<void>,
  baselineDirectory = DEFAULT_OUTPUT_DIRECTORY
): Promise<void> {
  await validateMigrationCorpusOutputDirectory(outputDirectory, baselineDirectory)
  const output = resolve(outputDirectory)
  const parent = dirname(output)
  const name = basename(output)
  const staging = join(parent, `.${name}.staging`)
  const backup = join(parent, `.${name}.backup`)
  if (await pathExists(staging)) throw new Error(`staging directory already exists: ${staging}`)
  if (await pathExists(backup)) throw new Error(`backup directory already exists: ${backup}`)

  const outputExists = await pathExists(output)
  try {
    if (outputExists) {
      await validateEvidenceTree(output)
      await cp(output, staging, { recursive: true, errorOnExist: true })
    } else {
      await mkdir(staging, { recursive: false })
    }
    await clearManagedOutput(staging)
    await generateAndValidate(staging, output)
    await validateEvidenceTree(staging)

    if (!outputExists) {
      await rename(staging, output)
      return
    }

    await rename(output, backup)
    try {
      await rename(staging, output)
    } catch (error) {
      await rename(backup, output)
      throw error
    }
    await rm(backup, { recursive: true })
  } catch (error) {
    if (await pathExists(staging)) await rm(staging, { recursive: true })
    throw error
  }
}

function assertHash(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256`)
  }
}

export function captureNativeTransportEvents(
  transport: NativeIrregularJobTransport,
  capturedEvents: string[]
): NativeIrregularJobTransport {
  return {
    run: (requestJson, invocationToken, onEvent, emitStateSnapshots) =>
      transport.run(
        requestJson,
        invocationToken,
        (eventJson) => {
          capturedEvents.push(eventJson)
          onEvent(eventJson)
        },
        emitStateSnapshots
      ),
    cancel: (invocationToken, reason) => transport.cancel(invocationToken, reason)
  }
}

export function validateMigrationMetadata(value: unknown): asserts value is MigrationMetadata {
  if (typeof value !== 'object' || value === null) throw new Error('metadata must be an object')
  const metadata = value as Partial<MigrationMetadata>
  if (metadata.acceptedEngine !== 'old-rust')
    throw new Error('metadata acceptedEngine must be old-rust')
  if (!Array.isArray(metadata.sourceFixtures) || metadata.sourceFixtures.length === 0) {
    throw new Error('metadata sourceFixtures must be non-empty')
  }
  for (const [index, fixture] of metadata.sourceFixtures.entries()) {
    if (fixture.kind === 'file') {
      if (typeof fixture.path !== 'string' || fixture.path.length === 0) {
        throw new Error(`metadata sourceFixtures[${index}] file path is required`)
      }
    } else if (fixture.kind === 'generated') {
      if (typeof fixture.description !== 'string' || fixture.description.length === 0) {
        throw new Error(`metadata sourceFixtures[${index}] generated description is required`)
      }
    } else {
      throw new Error(`metadata sourceFixtures[${index}] kind is invalid`)
    }
    assertHash(fixture.sha256, `metadata sourceFixtures[${index}].sha256`)
  }
  if (metadata.profile !== 'compact' && metadata.profile !== 'short-side') {
    throw new Error('metadata profile is invalid')
  }
  if (
    metadata.sheet === undefined ||
    !Number.isFinite(metadata.sheet.width) ||
    !Number.isFinite(metadata.sheet.height) ||
    metadata.sheet.width <= 0 ||
    metadata.sheet.height <= 0
  ) {
    throw new Error('metadata sheet dimensions must be positive')
  }
  if (
    metadata.workers === undefined ||
    !Number.isSafeInteger(metadata.workers.requested) ||
    !Number.isSafeInteger(metadata.workers.actual) ||
    metadata.workers.requested <= 0 ||
    metadata.workers.actual <= 0
  ) {
    throw new Error('metadata workers must be positive integers')
  }
  assertHash(metadata.collisionIdentitySha256, 'metadata collisionIdentitySha256')
  assertHash(metadata.fittedIdentitySha256, 'metadata fittedIdentitySha256')
  assertHash(metadata.normalizedSemanticSha256, 'metadata normalizedSemanticSha256')
  if (typeof metadata.targetTriple !== 'string' || metadata.targetTriple.length === 0) {
    throw new Error('metadata targetTriple is required')
  }
  if (typeof metadata.rustcIdentity !== 'string' || metadata.rustcIdentity.length === 0) {
    throw new Error('metadata rustcIdentity is required')
  }
  if (typeof metadata.cargoIdentity !== 'string' || metadata.cargoIdentity.length === 0) {
    throw new Error('metadata cargoIdentity is required')
  }
  if (metadata.build?.profile !== 'release' || !Array.isArray(metadata.build.features)) {
    throw new Error('metadata release build profile and feature set are required')
  }
  if (!Array.isArray(metadata.nativeDependencies) || metadata.nativeDependencies.length === 0) {
    throw new Error('metadata nativeDependencies must be non-empty')
  }
  for (const dependency of metadata.nativeDependencies) {
    if (
      typeof dependency.name !== 'string' ||
      dependency.name.length === 0 ||
      typeof dependency.version !== 'string' ||
      dependency.version.length === 0
    ) {
      throw new Error('metadata native dependency name and version are required')
    }
  }
}

export function validateNativePackageManifest(value: unknown): void {
  const entries = Array.isArray(value) ? value : [value]
  const files = entries.flatMap((entry) => (entry as PackageDryRunEntry | undefined)?.files ?? [])
  const paths = files.map((file) => file.path).toSorted()
  for (const path of paths) {
    if (
      path === 'src' ||
      path.startsWith('src/') ||
      path === 'target' ||
      path.startsWith('target/')
    ) {
      throw new Error(`forbidden package path: ${path}`)
    }
    const allowed =
      path === 'package.json' ||
      path === 'NOTICE' ||
      path === 'LICENSES/clipper2-ts-BSL-1.0.txt' ||
      path === 'npm/index.cjs' ||
      path === 'npm/target.cjs' ||
      /^npm\/irregular-nesting-native\.[^/]+\.node$/.test(path)
    if (!allowed) throw new Error(`unexpected package path: ${path}`)
  }
  for (const required of [
    'package.json',
    'NOTICE',
    'LICENSES/clipper2-ts-BSL-1.0.txt',
    'npm/index.cjs',
    'npm/target.cjs'
  ]) {
    if (!paths.includes(required)) throw new Error(`required package path is missing: ${required}`)
  }
  if (!paths.some((path) => path.endsWith('.node'))) {
    throw new Error('required package addon is missing')
  }
}

export async function validateHashManifest(rootDirectory: string, text: string): Promise<number> {
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0)
  const seen = new Set<string>()
  for (const line of lines) {
    const match = /^([0-9a-f]{64})  (.+)$/.exec(line)
    const expectedHash = match?.[1]
    const manifestPath = match?.[2]
    if (expectedHash === undefined || manifestPath === undefined) {
      throw new Error(`invalid hash manifest line: ${line}`)
    }
    const absolutePath = resolve(rootDirectory, manifestPath)
    if (!isContainedPath(rootDirectory, absolutePath)) {
      throw new Error(`hash manifest path escapes its root: ${manifestPath}`)
    }
    if (seen.has(absolutePath)) throw new Error(`duplicate hash manifest path: ${manifestPath}`)
    seen.add(absolutePath)
    const actualHash = sha256Bytes(
      await readRegularContainedFile(rootDirectory, absolutePath, `hash manifest target ${manifestPath}`)
    )
    if (actualHash !== expectedHash) {
      throw new Error(
        `hash mismatch for ${manifestPath}: expected ${expectedHash}, got ${actualHash}`
      )
    }
  }
  return lines.length
}

function validateEventLines(text: string, label: string): number {
  const lines = text.split('\n').filter((line) => line.length > 0)
  let terminalCount = 0
  for (const [index, line] of lines.entries()) {
    const event = JSON.parse(line) as { readonly kind?: unknown; readonly ordinal?: unknown }
    if (event.ordinal !== index) {
      throw new Error(`${label}: event ordinal ${String(event.ordinal)} does not match ${index}`)
    }
    if (event.kind === 'terminal') {
      terminalCount += 1
      if (index !== lines.length - 1) throw new Error(`${label}: terminal event must be last`)
    }
  }
  if (terminalCount !== 1) throw new Error(`${label}: exactly one terminal event is required`)
  return lines.length
}

interface CanonicalRowDescriptor {
  readonly id: string
  readonly fixture: 'triangle-20' | 'mixed-61' | 'shapes-17'
  readonly sheet: (typeof SHEETS)[number]
  readonly profile: (typeof PROFILES)[number]
  readonly width: number
  readonly height: number
}

function canonicalRowDescriptor(id: string): CanonicalRowDescriptor | undefined {
  for (const fixture of FIXTURES) {
    for (const sheet of SHEETS) {
      for (const profile of PROFILES) {
        if (rowId(fixture, sheet, profile) !== id) continue
        const [width, height] = sheet.split('x').map(Number) as [number, number]
        return {
          id,
          fixture: fixture === 'mixed61' ? 'mixed-61' : fixture,
          sheet,
          profile,
          width,
          height
        }
      }
    }
  }
  return undefined
}

function canonicalArtifactPaths(id: string): Record<(typeof ARTIFACT_KEYS)[number], string> {
  const directory = `migration-corpus/${id}`
  return {
    request: `${directory}/request.json`,
    result: `${directory}/result.json`,
    events: `${directory}/events.ndjson`,
    semanticProjection: `${directory}/semantic-projection.json`,
    metadata: `${directory}/metadata.json`
  }
}

function assertExactArtifactKeys(
  value: unknown,
  label: string
): asserts value is Record<(typeof ARTIFACT_KEYS)[number], string> {
  if (typeof value !== 'object' || value === null) throw new Error(`${label} must be an object`)
  const actualKeys = Object.keys(value).toSorted()
  const expectedKeys = [...ARTIFACT_KEYS].toSorted()
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new Error(`${label} must contain exactly the canonical artifact keys`)
  }
}

export async function validateMigrationCorpus(
  rootDirectory: string,
  value: unknown,
  expectedRowIds: ReadonlyArray<string>
): Promise<{ readonly artifactCount: number; readonly rowCount: number }> {
  if (
    typeof value !== 'object' ||
    value === null ||
    !Array.isArray((value as MigrationCorpus).rows)
  ) {
    throw new Error('migration corpus rows are required')
  }
  const corpus = value as MigrationCorpus
  if (corpus.version !== 1) throw new Error('migration corpus version must be 1')
  if (corpus.acceptedEngine !== 'old-rust') {
    throw new Error('migration corpus acceptedEngine must be old-rust')
  }
  const rowIds = corpus.rows.map((row) => row.id)
  if (new Set(rowIds).size !== rowIds.length)
    throw new Error('migration corpus contains duplicate rows')
  if (
    rowIds.length !== expectedRowIds.length ||
    expectedRowIds.some((id) => !rowIds.includes(id))
  ) {
    throw new Error('migration corpus does not reference every expected row exactly once')
  }

  const artifactPaths = new Set<string>()
  let artifactCount = 0
  for (const row of corpus.rows) {
    const descriptor = canonicalRowDescriptor(row.id)
    if (
      descriptor === undefined ||
      row.fixture !== descriptor.fixture ||
      row.sheet !== descriptor.sheet ||
      row.profile !== descriptor.profile
    ) {
      throw new Error(`${row.id} does not match its canonical row descriptor`)
    }
    assertExactArtifactKeys(row.artifacts, `${row.id}.artifacts`)
    assertExactArtifactKeys(row.sha256, `${row.id}.sha256`)
    const expectedArtifacts = canonicalArtifactPaths(row.id)
    const artifactBytes = new Map<(typeof ARTIFACT_KEYS)[number], Buffer>()
    for (const key of ARTIFACT_KEYS) {
      const artifactPath = row.artifacts[key]
      const expectedArtifactPath = expectedArtifacts[key]
      if (artifactPath !== expectedArtifactPath) {
        throw new Error(
          `${row.id}.${key} canonical artifact path must be ${expectedArtifactPath}, got ${artifactPath}`
        )
      }
      if (artifactPaths.has(artifactPath)) {
        throw new Error(`duplicate artifact path: ${artifactPath}`)
      }
      artifactPaths.add(artifactPath)
      const expectedHash = row.sha256[key]
      assertHash(expectedHash, `${row.id}.${key}`)
      const absolutePath = resolve(rootDirectory, artifactPath)
      if (!isContainedPath(rootDirectory, absolutePath)) {
        throw new Error(`${row.id}.${key} escapes the baseline directory`)
      }
      const bytes = await readRegularContainedFile(
        rootDirectory,
        absolutePath,
        `${row.id}.${key}`
      )
      artifactBytes.set(key, bytes)
      const actualHash = sha256Bytes(bytes)
      if (actualHash !== expectedHash) {
        throw new Error(
          `${row.id}.${key} hash mismatch: expected ${expectedHash}, got ${actualHash}`
        )
      }
      if (key === 'events') {
        validateEventLines(bytes.toString('utf8'), `${row.id}.events`)
      } else {
        JSON.parse(bytes.toString('utf8'))
      }
      artifactCount += 1
    }
    const request = JSON.parse(artifactBytes.get('request')?.toString('utf8') ?? '') as {
      readonly sheet?: { readonly width?: unknown; readonly height?: unknown }
      readonly options?: {
        readonly irregularSettings?: {
          readonly optimizer?: { readonly intrinsicObjectiveProfileId?: unknown }
        }
      }
    }
    const result = JSON.parse(
      artifactBytes.get('result')?.toString('utf8') ?? ''
    ) as IrregularComputeResult
    const semanticProjection = JSON.parse(
      artifactBytes.get('semanticProjection')?.toString('utf8') ?? ''
    ) as unknown
    const metadata = JSON.parse(
      artifactBytes.get('metadata')?.toString('utf8') ?? ''
    ) as unknown
    validateMigrationMetadata(metadata)

    if (metadata.profile !== descriptor.profile) {
      throw new Error(`${row.id} metadata profile does not match its canonical row descriptor`)
    }
    if (metadata.sheet.width !== descriptor.width || metadata.sheet.height !== descriptor.height) {
      throw new Error(`${row.id} metadata sheet does not match its canonical row descriptor`)
    }
    if (request.sheet?.width !== descriptor.width || request.sheet.height !== descriptor.height) {
      throw new Error(`${row.id} request sheet does not match its canonical row descriptor`)
    }
    if (
      request.options?.irregularSettings?.optimizer?.intrinsicObjectiveProfileId !==
      descriptor.profile
    ) {
      throw new Error(`${row.id} request profile does not match its canonical row descriptor`)
    }

    const normalizedProjection = projectIrregularDifferentialOutcome({ ok: true, value: result })
    const normalizedProjectionText = JSON.stringify(normalizedProjection)
    if (JSON.stringify(semanticProjection) !== normalizedProjectionText) {
      throw new Error(`${row.id} semantic projection is not normalized from result.json`)
    }
    const normalizedSemanticSha256 = sha256Bytes(normalizedProjectionText)
    if (metadata.normalizedSemanticSha256 !== normalizedSemanticSha256) {
      throw new Error(`${row.id} normalized semantic projection hash does not match metadata`)
    }
    if (metadata.collisionIdentitySha256 !== collisionIdentitySha256(result)) {
      throw new Error(`${row.id} collision identity does not match metadata`)
    }
    if (metadata.fittedIdentitySha256 !== fittedIdentitySha256(result)) {
      throw new Error(`${row.id} fitted identity does not match metadata`)
    }
  }
  return { artifactCount, rowCount: corpus.rows.length }
}

async function collectEvidenceFiles(directory: string, rootDirectory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    const label = relative(rootDirectory, path).split(sep).join('/')
    if (entry.isSymbolicLink()) throw new Error(`${label} is a symlink`)
    if (entry.isDirectory()) files.push(...(await collectEvidenceFiles(path, rootDirectory)))
    else if (entry.isFile()) files.push(path)
    else throw new Error(`${label} is not a regular file or directory`)
  }
  return files
}

async function listFiles(directory: string): Promise<string[]> {
  const status = await lstat(directory)
  if (status.isSymbolicLink()) throw new Error(`${directory} is a symlink`)
  if (!status.isDirectory()) throw new Error(`${directory} is not a directory`)
  return (await collectEvidenceFiles(directory, directory)).toSorted()
}

export async function validateEvidenceTree(directory: string): Promise<number> {
  return (await listFiles(directory)).length
}

async function hashManifest(
  paths: ReadonlyArray<string>,
  physicalRoot?: string,
  logicalRoot?: string
): Promise<string> {
  if ((physicalRoot === undefined) !== (logicalRoot === undefined)) {
    throw new Error('physical and logical manifest roots must be provided together')
  }
  const lines: string[] = []
  const evidenceRoot = physicalRoot ?? REPO_ROOT
  for (const path of paths.toSorted()) {
    const bytes = await readRegularContainedFile(evidenceRoot, path, `manifest source ${path}`)
    const logicalPath =
      physicalRoot === undefined || logicalRoot === undefined
        ? path
        : join(logicalRoot, relative(physicalRoot, path))
    lines.push(
      `${sha256Bytes(bytes)}  ${relative(REPO_ROOT, logicalPath).split(sep).join('/')}`
    )
  }
  return `${lines.join('\n')}\n`
}

async function writeHashManifest(
  outputPath: string,
  paths: ReadonlyArray<string>,
  physicalRoot?: string,
  logicalRoot?: string
): Promise<void> {
  await writeFile(outputPath, await hashManifest(paths, physicalRoot, logicalRoot))
}

function rowId(fixture: (typeof FIXTURES)[number], sheet: string, profile: string): string {
  const normalizedFixture = fixture === 'mixed61' ? 'mixed-61' : fixture
  return `${normalizedFixture}-${sheet}-${profile}`
}

function expectedRowIds(): string[] {
  return FIXTURES.flatMap((fixture) =>
    SHEETS.flatMap((sheet) => PROFILES.map((profile) => rowId(fixture, sheet, profile)))
  )
}

function absoluteCollisionPolygons(
  result: Pick<IrregularComputeResult, 'placedCollisionGeometries'>
): ReadonlyArray<ReadonlyArray<{ readonly x: number; readonly y: number }>> {
  return result.placedCollisionGeometries.map(({ placement, collisionGeometry }) =>
    collisionGeometry.polygon.points.map(({ x, y }) => ({
      x: x + placement.transform.translateX,
      y: y + placement.transform.translateY
    }))
  )
}

function collisionIdentitySha256(result: IrregularComputeResult): string {
  const identity = canonicalCollisionLayoutIdentity(result.placedCollisionGeometries)
  if (identity === undefined) throw new Error('baseline row produced no collision identity')
  return sha256Bytes(identity)
}

function fittedIdentitySha256(result: IrregularComputeResult): string {
  const polygons = absoluteCollisionPolygons(result)
  if (polygons.length === 0) throw new Error('baseline row produced no fitted identity')
  return canonicalizeIrregularLayout(polygons).sha256
}

async function fixtureMetadata(
  fixture: (typeof FIXTURES)[number],
  request: NestingRequest
): Promise<ReadonlyArray<SourceFixtureMetadata>> {
  if (fixture === 'triangle-20') {
    const encoded = Schema.encodeSync(NestingRequest)(request) as { readonly sourcePieces: unknown }
    return [
      {
        kind: 'generated',
        description:
          '20 triangle copies generated by makePresetShapeDocument with width 70 mm and height 60 mm',
        sha256: sha256Bytes(JSON.stringify(encoded.sourcePieces))
      }
    ]
  }
  if (fixture === 'mixed61') {
    const path = join(REPO_ROOT, 'tests/fixtures/irregularSheetInvariance/mixed61-request.json')
    return [
      {
        kind: 'file',
        path: relative(REPO_ROOT, path).split(sep).join('/'),
        sha256: sha256Bytes(await readRegularContainedFile(REPO_ROOT, path, `source fixture ${path}`))
      }
    ]
  }
  const directory = join(REPO_ROOT, 'tests/fixtures/irregularSeventeenShapes')
  const paths = (await listFiles(directory)).filter((path) => path.endsWith('.dxf'))
  return Promise.all(
    paths.map(async (path) => ({
      kind: 'file' as const,
      path: relative(REPO_ROOT, path).split(sep).join('/'),
      sha256: sha256Bytes(await readRegularContainedFile(REPO_ROOT, path, `source fixture ${path}`))
    }))
  )
}

function directNativeDependencies(): MigrationMetadata['nativeDependencies'] {
  const metadata = JSON.parse(
    execFileSync(
      'cargo',
      [
        'metadata',
        '--format-version',
        '1',
        '--locked',
        '--manifest-path',
        join(REPO_ROOT, 'crates/irregular-nesting-native/Cargo.toml')
      ],
      { cwd: REPO_ROOT, encoding: 'utf8' }
    )
  ) as {
    readonly packages: ReadonlyArray<{
      readonly id: string
      readonly name: string
      readonly version: string
      readonly dependencies: ReadonlyArray<{ readonly name: string; readonly features: string[] }>
    }>
    readonly resolve: {
      readonly root: string
      readonly nodes: ReadonlyArray<{
        readonly id: string
        readonly deps: ReadonlyArray<{ readonly name: string; readonly pkg: string }>
      }>
    }
  }
  const rootNode = metadata.resolve.nodes.find((node) => node.id === metadata.resolve.root)
  const rootPackage = metadata.packages.find((entry) => entry.id === metadata.resolve.root)
  if (rootNode === undefined || rootPackage === undefined)
    throw new Error('native Cargo metadata has no root package')
  return rootNode.deps
    .map((dependency) => {
      const resolved = metadata.packages.find((entry) => entry.id === dependency.pkg)
      const declared = rootPackage.dependencies.find((entry) => entry.name === dependency.name)
      if (resolved === undefined)
        throw new Error(`native dependency ${dependency.name} is unresolved`)
      return {
        name: resolved.name,
        version: resolved.version,
        ...(declared !== undefined && declared.features.length > 0
          ? { features: declared.features.toSorted() }
          : {})
      }
    })
    .toSorted((first, second) => first.name.localeCompare(second.name))
}

async function generateCorpus(outputDirectory: string): Promise<MigrationCorpus> {
  const probe = probeNativeIrregularAddon()
  if (!probe.available)
    throw new Error(`native addon unavailable: ${probe.reason}: ${probe.detail}`)
  const addon = loadNativeIrregularAddon()
  const rustcIdentity = execFileSync('rustc', ['-vV'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  const cargoIdentity = execFileSync('cargo', ['-V'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  const nativeDependencies = directNativeDependencies()
  const rows: CorpusRow[] = []

  for (const fixture of FIXTURES) {
    for (const sheet of SHEETS) {
      for (const profile of PROFILES) {
        const args: DifferentialArgs = {
          fixture,
          pieces: 'all',
          requestFile: undefined,
          sheet,
          profile
        }
        const request = await loadDifferentialRequest(args)
        const settings = request.options.irregularSettings ?? GeometrySettings.Make
        const capturedEvents: string[] = []
        const transport = captureNativeTransportEvents(
          {
            run: (requestJson, invocationToken, onEvent, emitStateSnapshots) =>
              addon.runIrregularJob(requestJson, invocationToken, onEvent, emitStateSnapshots),
            cancel: (invocationToken, reason) => addon.cancelIrregularJob(invocationToken, reason)
          },
          capturedEvents
        )
        const result = await Effect.runPromise(
          computeIrregularNestingNativeWithTransportForTests(transport, request, settings, {
            emitStateSnapshot: () => undefined
          })
        )
        const diagnostics = JSON.parse(addon.getLastJobDiagnostics()) as NativeJobDiagnostics
        const semanticProjection = projectIrregularDifferentialOutcome({ ok: true, value: result })
        const normalizedSemanticSha256 = sha256Bytes(JSON.stringify(semanticProjection))
        const metadata: MigrationMetadata = {
          acceptedEngine: 'old-rust',
          sourceFixtures: await fixtureMetadata(fixture, request),
          profile,
          sheet: { width: request.sheet.width, height: request.sheet.height },
          workers: {
            requested: diagnostics.threadCountRequested,
            actual: diagnostics.threadCountUsed
          },
          collisionIdentitySha256: collisionIdentitySha256(result),
          fittedIdentitySha256: fittedIdentitySha256(result),
          normalizedSemanticSha256,
          targetTriple: probe.targetTriple,
          rustcIdentity,
          cargoIdentity,
          build: { profile: 'release', features: [] },
          nativeDependencies
        }
        validateMigrationMetadata(metadata)

        const id = rowId(fixture, sheet, profile)
        const rowDirectory = join(outputDirectory, 'migration-corpus', id)
        await mkdir(rowDirectory, { recursive: true })
        const artifactText = {
          request: jsonText(JSON.parse(encodeNativeRequestJson(request, settings)) as unknown),
          result: jsonText(result),
          events: `${capturedEvents.join('\n')}\n`,
          semanticProjection: jsonText(semanticProjection),
          metadata: jsonText(metadata)
        }
        validateEventLines(artifactText.events, `${id}.events`)
        const artifacts = {
          request: `migration-corpus/${id}/request.json`,
          result: `migration-corpus/${id}/result.json`,
          events: `migration-corpus/${id}/events.ndjson`,
          semanticProjection: `migration-corpus/${id}/semantic-projection.json`,
          metadata: `migration-corpus/${id}/metadata.json`
        }
        const fileNames = {
          request: 'request.json',
          result: 'result.json',
          events: 'events.ndjson',
          semanticProjection: 'semantic-projection.json',
          metadata: 'metadata.json'
        }
        const hashes = {} as Record<(typeof ARTIFACT_KEYS)[number], string>
        for (const key of ARTIFACT_KEYS) {
          await writeFile(join(rowDirectory, fileNames[key]), artifactText[key])
          hashes[key] = sha256Bytes(artifactText[key])
        }
        rows.push({
          id,
          fixture: fixture === 'mixed61' ? 'mixed-61' : fixture,
          sheet,
          profile,
          artifacts,
          sha256: hashes
        })
        console.log(`[migration-corpus] exported ${id}`)
      }
    }
  }
  return { version: 1, acceptedEngine: 'old-rust', rows }
}

async function verifyChecksumManifest(
  outputDirectory: string,
  logicalOutputDirectory = outputDirectory
): Promise<number> {
  const manifestPath = join(outputDirectory, 'SHA256SUMS')
  const lines = (
    await readRegularContainedFile(outputDirectory, manifestPath, 'SHA256SUMS')
  )
    .toString('utf8')
    .split('\n')
    .filter(Boolean)
  const expectedFiles = (await listFiles(outputDirectory)).filter((path) => path !== manifestPath)
  if (lines.length !== expectedFiles.length) {
    throw new Error(
      `SHA256SUMS line count ${lines.length} does not match artifact count ${expectedFiles.length}`
    )
  }
  const seen = new Set<string>()
  for (const line of lines) {
    const match = /^([0-9a-f]{64})  (.+)$/.exec(line)
    const expectedHash = match?.[1]
    const manifestRelativePath = match?.[2]
    if (expectedHash === undefined || manifestRelativePath === undefined) {
      throw new Error(`invalid SHA256SUMS line: ${line}`)
    }
    const logicalPath = resolve(REPO_ROOT, manifestRelativePath)
    if (
      !isContainedPath(REPO_ROOT, logicalPath) ||
      !isContainedPath(logicalOutputDirectory, logicalPath)
    ) {
      throw new Error(`SHA256SUMS path escapes the baseline directory: ${manifestRelativePath}`)
    }
    const path = resolve(outputDirectory, relative(logicalOutputDirectory, logicalPath))
    if (!isContainedPath(outputDirectory, path)) {
      throw new Error(`SHA256SUMS physical path escapes the baseline directory: ${manifestRelativePath}`)
    }
    if (seen.has(path)) throw new Error(`SHA256SUMS duplicate path: ${manifestRelativePath}`)
    seen.add(path)
    const actual = sha256Bytes(
      await readRegularContainedFile(outputDirectory, path, `SHA256SUMS target ${manifestRelativePath}`)
    )
    if (actual !== expectedHash) {
      throw new Error(`SHA256SUMS hash mismatch: ${manifestRelativePath}`)
    }
  }
  if (expectedFiles.some((path) => !seen.has(path))) throw new Error('SHA256SUMS omits an artifact')
  return lines.length
}

async function validateAllJson(outputDirectory: string): Promise<void> {
  for (const path of await listFiles(outputDirectory)) {
    if (!path.endsWith('.json') && !path.endsWith('.ndjson')) continue
    const text = (
      await readRegularContainedFile(
        outputDirectory,
        path,
        `evidence file ${relative(outputDirectory, path)}`
      )
    ).toString('utf8')
    if (path.endsWith('.json')) JSON.parse(text)
    else validateEventLines(text, relative(outputDirectory, path))
  }
}

async function generateStaticArtifacts(outputDirectory: string): Promise<void> {
  const nativeVectorPaths = await listFiles(
    join(REPO_ROOT, 'crates/irregular-nesting-native/tests/vectors')
  )
  await writeHashManifest(join(outputDirectory, 'native-vectors.sha256'), nativeVectorPaths)

  const sourceFixturePaths = [
    ...(await listFiles(join(REPO_ROOT, 'tests/fixtures/irregularSheetInvariance'))),
    ...(await listFiles(join(REPO_ROOT, 'tests/fixtures/irregularSeventeenShapes')))
  ]
  await writeHashManifest(join(outputDirectory, 'source-fixtures.sha256'), sourceFixturePaths)

  const legalAndAddonPaths = [
    join(REPO_ROOT, 'crates/irregular-nesting-native/NOTICE'),
    join(REPO_ROOT, 'crates/irregular-nesting-native/LICENSES/clipper2-ts-BSL-1.0.txt'),
    ...(await listFiles(join(REPO_ROOT, 'crates/irregular-nesting-native/npm'))).filter((path) =>
      path.endsWith('.node')
    )
  ]
  if (!legalAndAddonPaths.some((path) => path.endsWith('.node'))) {
    throw new Error('no staged native addon was found')
  }
  await writeHashManifest(join(outputDirectory, 'legal-and-addon.sha256'), legalAndAddonPaths)

  const packageManifest = JSON.parse(
    execFileSync(
      'pnpm',
      ['--dir', 'crates/irregular-nesting-native', 'pack', '--dry-run', '--json'],
      { cwd: REPO_ROOT, encoding: 'utf8' }
    )
  ) as unknown
  validateNativePackageManifest(packageManifest)
  await writeFile(join(outputDirectory, 'package-manifest.json'), jsonText(packageManifest))
}

async function validateGeneratedBaseline(
  outputDirectory: string,
  logicalOutputDirectory = outputDirectory
): Promise<void> {
  await validateEvidenceTree(outputDirectory)
  const frozenInputCount = await Promise.all(
    ['native-vectors.sha256', 'source-fixtures.sha256', 'legal-and-addon.sha256'].map(
      async (fileName) =>
        validateHashManifest(
          REPO_ROOT,
          (
            await readRegularContainedFile(
              outputDirectory,
              join(outputDirectory, fileName),
              fileName
            )
          ).toString('utf8')
        )
    )
  ).then((counts) => counts.reduce((total, count) => total + count, 0))
  const packageManifest = JSON.parse(
    (
      await readRegularContainedFile(
        outputDirectory,
        join(outputDirectory, 'package-manifest.json'),
        'package-manifest.json'
      )
    ).toString('utf8')
  ) as unknown
  validateNativePackageManifest(packageManifest)
  const corpus = JSON.parse(
    (
      await readRegularContainedFile(
        outputDirectory,
        join(outputDirectory, 'migration-corpus.json'),
        'migration-corpus.json'
      )
    ).toString('utf8')
  ) as unknown
  const validation = await validateMigrationCorpus(outputDirectory, corpus, expectedRowIds())
  await validateAllJson(outputDirectory)
  const checksumCount = await verifyChecksumManifest(outputDirectory, logicalOutputDirectory)
  console.log(
    `[migration-corpus] validated ${validation.rowCount} rows, ${validation.artifactCount} row artifacts, ` +
      `${frozenInputCount} frozen inputs, ${checksumCount} total checksums`
  )
}

async function main(): Promise<void> {
  const outputArgumentIndex = process.argv.indexOf('--output-dir')
  if (outputArgumentIndex >= 0 && process.argv[outputArgumentIndex + 1] === undefined) {
    throw new Error('--output-dir requires a path')
  }
  const outputDirectory = resolve(
    outputArgumentIndex < 0
      ? DEFAULT_OUTPUT_DIRECTORY
      : (process.argv[outputArgumentIndex + 1] as string)
  )
  const validateOnly = process.argv.includes('--validate-only')

  if (validateOnly) {
    if (
      outputDirectory !== DEFAULT_OUTPUT_DIRECTORY &&
      dirname(outputDirectory) !== DEFAULT_OUTPUT_DIRECTORY
    ) {
      throw new Error('output directory must be the baseline directory or a direct child')
    }
    const status = await lstat(outputDirectory)
    if (!status.isDirectory() || status.isSymbolicLink()) {
      throw new Error('validation output path must be a real directory')
    }
    await validateGeneratedBaseline(outputDirectory)
    return
  }

  await generateMigrationCorpusAtomically(
    outputDirectory,
    async (stagingDirectory, logicalOutputDirectory) => {
      await generateStaticArtifacts(stagingDirectory)
      const corpus = await generateCorpus(stagingDirectory)
      await writeFile(join(stagingDirectory, 'migration-corpus.json'), jsonText(corpus))
      const files = (await listFiles(stagingDirectory)).filter(
        (path) => path !== join(stagingDirectory, 'SHA256SUMS')
      )
      await writeHashManifest(
        join(stagingDirectory, 'SHA256SUMS'),
        files,
        stagingDirectory,
        logicalOutputDirectory
      )
      await validateGeneratedBaseline(stagingDirectory, logicalOutputDirectory)
    }
  )
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error))
    process.exitCode = 1
  })
}
