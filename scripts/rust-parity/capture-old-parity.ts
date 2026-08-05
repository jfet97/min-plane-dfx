#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  validateNativeIrregularEventSequence,
  validateNativeIrregularResultEnvelope
} from '../../src/workers/irregular/native/nativeIrregularBackend.js'
import { validateHashManifest, validateMigrationCorpus } from './migration-corpus.js'

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const EXPECTED_ROW_IDS = [
  'triangle-20-2000x2700-compact',
  'triangle-20-2000x2700-short-side',
  'triangle-20-600x400-compact',
  'triangle-20-600x400-short-side',
  'triangle-20-300x300-compact',
  'triangle-20-300x300-short-side',
  'mixed-61-2000x2700-compact',
  'mixed-61-2000x2700-short-side',
  'mixed-61-600x400-compact',
  'mixed-61-600x400-short-side',
  'mixed-61-300x300-compact',
  'mixed-61-300x300-short-side',
  'shapes-17-2000x2700-compact',
  'shapes-17-2000x2700-short-side',
  'shapes-17-600x400-compact',
  'shapes-17-600x400-short-side',
  'shapes-17-300x300-compact',
  'shapes-17-300x300-short-side'
] as const

export const ACCEPTED_ENGINE_REVISION = '5c72d8fca8e078b0a6e7d5f2515a8a0953475481'
export const SOURCE_PROVENANCE_REVISION = 'e4f3608878611c002f343473fab72adc7d155f87'
export const CAPTURE_TOOLCHAIN = '1.95.0'
export const CAPTURE_TARGETS = [
  'x86_64-unknown-linux-gnu',
  'x86_64-pc-windows-msvc',
  'aarch64-apple-darwin',
  'x86_64-apple-darwin'
] as const

export type CaptureTarget = (typeof CAPTURE_TARGETS)[number]

export function captureArtifactName(target: CaptureTarget): string {
  return `old-rust-parity-capture-${target}`
}

export function captureArchiveName(target: CaptureTarget): string {
  return `${captureArtifactName(target)}.tar.gz`
}

interface BundleFile {
  readonly path: string
  readonly sha256: string
  readonly size: number
}

export interface OldParityBundleManifest {
  readonly version: 1
  readonly files: ReadonlyArray<BundleFile>
}

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function assertSha256(value: string, label: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(`${label} must be a lowercase SHA-256`)
}

function contained(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
}

async function readRegularContainedFile(
  root: string,
  path: string,
  label: string
): Promise<Buffer> {
  const resolvedRoot = resolve(root)
  const resolvedPath = resolve(path)
  if (!contained(resolvedRoot, resolvedPath)) throw new Error(`${label} escapes ${root}`)
  let current = resolvedRoot
  const rootStatus = await lstat(current)
  if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink()) {
    throw new Error(`${label} root must be a real directory`)
  }
  for (const component of relative(resolvedRoot, resolvedPath).split(sep).filter(Boolean)) {
    current = join(current, component)
    if ((await lstat(current)).isSymbolicLink())
      throw new Error(`${label} is a symlink: ${current}`)
  }
  const status = await lstat(resolvedPath)
  if (!status.isFile()) throw new Error(`${label} is not a regular file: ${resolvedPath}`)
  const [realRoot, realPath] = await Promise.all([realpath(resolvedRoot), realpath(resolvedPath)])
  if (!contained(realRoot, realPath)) throw new Error(`${label} realpath escapes ${root}`)
  return readFile(realPath)
}

async function listRegularFiles(root: string, directory = root): Promise<string[]> {
  const status = await lstat(directory)
  if (status.isSymbolicLink()) throw new Error(`bundle input contains a symlink: ${directory}`)
  if (!status.isDirectory()) throw new Error(`bundle input is not a directory: ${directory}`)
  const files: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`bundle input contains a symlink: ${path}`)
    if (entry.isDirectory()) files.push(...(await listRegularFiles(root, path)))
    else if (entry.isFile()) files.push(path)
    else throw new Error(`bundle input contains an unsupported entry: ${path}`)
  }
  return files.toSorted((first, second) =>
    relative(root, first).localeCompare(relative(root, second))
  )
}

async function validateCompleteChecksumManifest(
  corpusDirectory: string,
  repositoryRoot: string
): Promise<void> {
  const corpusRoot = resolve(corpusDirectory)
  const checksumPath = join(corpusRoot, 'SHA256SUMS')
  const checksumText = (
    await readRegularContainedFile(corpusRoot, checksumPath, 'SHA256SUMS')
  ).toString('utf8')
  const resolvedRepositoryRoot = resolve(repositoryRoot)
  const hashRoot = contained(resolvedRepositoryRoot, corpusRoot)
    ? resolvedRepositoryRoot
    : corpusRoot
  await validateHashManifest(hashRoot, checksumText)
  const listed = new Set(
    checksumText
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => /^([0-9a-f]{64})  (.+)$/.exec(line)?.[2])
  )
  const files = await listRegularFiles(corpusRoot)
  const expected = files
    .map((path) => relative(hashRoot, path).split(sep).join('/'))
    .filter((path) => path !== relative(hashRoot, checksumPath).split(sep).join('/'))
  if (listed.size !== expected.length || expected.some((path) => !listed.has(path))) {
    throw new Error('SHA256SUMS must cover every corpus input exactly once')
  }
}

export async function validateOldParityCaptureInputs(
  corpusDirectory: string,
  repositoryRoot = REPOSITORY_ROOT
): Promise<void> {
  const corpusRoot = resolve(corpusDirectory)
  await validateCompleteChecksumManifest(corpusRoot, repositoryRoot)
  const corpus = JSON.parse(
    (
      await readRegularContainedFile(
        corpusRoot,
        join(corpusRoot, 'migration-corpus.json'),
        'migration-corpus.json'
      )
    ).toString('utf8')
  ) as unknown
  await validateMigrationCorpus(corpusRoot, corpus, EXPECTED_ROW_IDS)
}

/**
 * Validates the immutable request corpus for a fresh old-engine run. The baseline
 * also records a historical ignored addon byte hash. It is provenance evidence,
 * not an input to a fresh target-specific build, so this mode verifies the legal
 * text while returning that historical hash for separate capture metadata.
 */
export async function validateFreshCaptureInputs(
  corpusDirectory: string,
  repositoryRoot = REPOSITORY_ROOT
): Promise<{ readonly historicalAddonSha256: string }> {
  const corpusRoot = resolve(corpusDirectory)
  const acceptedEngineRoot = resolve(repositoryRoot)
  await validateOldParityCaptureInputs(corpusRoot, acceptedEngineRoot)

  for (const name of ['native-vectors.sha256', 'source-fixtures.sha256']) {
    const text = (
      await readRegularContainedFile(corpusRoot, join(corpusRoot, name), name)
    ).toString('utf8')
    await validateHashManifest(acceptedEngineRoot, text)
  }

  const legalManifest = (
    await readRegularContainedFile(
      corpusRoot,
      join(corpusRoot, 'legal-and-addon.sha256'),
      'legal-and-addon.sha256'
    )
  ).toString('utf8')
  const entries = legalManifest.split(/\r?\n/).filter(Boolean)
  const historicalAddon = entries.find((entry) => entry.endsWith('.node'))
  const historicalAddonSha256 = /^([0-9a-f]{64})  /.exec(historicalAddon ?? '')?.[1]
  if (historicalAddonSha256 === undefined) {
    throw new Error('legal-and-addon.sha256 must contain exactly one historical addon hash')
  }
  if (entries.filter((entry) => entry.endsWith('.node')).length !== 1) {
    throw new Error('legal-and-addon.sha256 must contain exactly one historical addon hash')
  }
  await validateHashManifest(
    acceptedEngineRoot,
    `${entries.filter((entry) => !entry.endsWith('.node')).join('\n')}\n`
  )
  return { historicalAddonSha256 }
}

export async function buildOldParityBundleManifest(
  bundleDirectory: string
): Promise<OldParityBundleManifest> {
  const root = resolve(bundleDirectory)
  const files = await listRegularFiles(root)
  const entries = await Promise.all(
    files
      .filter((path) => !['SHA256SUMS', 'bundle-manifest.json'].includes(basename(path)))
      .map(async (path) => {
        const bytes = await readRegularContainedFile(root, path, 'bundle input')
        return {
          path: relative(root, path).split(sep).join('/'),
          sha256: sha256(bytes),
          size: bytes.length
        }
      })
  )
  return { version: 1, files: entries }
}

export function validateRawCaptureManifest(manifest: OldParityBundleManifest): void {
  const expectedPaths = new Set(
    EXPECTED_ROW_IDS.flatMap((rowId) =>
      ['request.json', 'result.json', 'events.ndjson', 'stderr.txt', 'process.json'].map(
        (name) => `${rowId}/${name}`
      )
    )
  )
  const paths = manifest.files.map((file) => file.path)
  if (
    paths.length !== expectedPaths.size ||
    new Set(paths).size !== paths.length ||
    paths.some((path) => !expectedPaths.has(path))
  ) {
    throw new Error(
      'raw capture must contain every corpus row exactly once with all five artifacts'
    )
  }
}

function validateRawEvents(text: string, rowId: string): void {
  try {
    validateNativeIrregularEventSequence(
      text
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as unknown)
    )
  } catch (error) {
    throw new Error(`${rowId} raw events must be valid typed semantic events: ${String(error)}`)
  }
}

export async function validateRawCaptureDirectory(
  rawDirectory: string,
  corpusDirectory: string
): Promise<void> {
  const rawRoot = resolve(rawDirectory)
  const corpusRoot = resolve(corpusDirectory)
  const manifest = await buildOldParityBundleManifest(rawRoot)
  validateRawCaptureManifest(manifest)

  for (const rowId of EXPECTED_ROW_IDS) {
    const readRaw = (name: string): Promise<Buffer> =>
      readRegularContainedFile(rawRoot, join(rawRoot, rowId, name), `${rowId} raw ${name}`)
    const [request, expectedRequest, resultText, eventsText, stderr, processText] =
      await Promise.all([
        readRaw('request.json'),
        readRegularContainedFile(
          corpusRoot,
          join(corpusRoot, 'migration-corpus', rowId, 'request.json'),
          `${rowId} frozen request.json`
        ),
        readRaw('result.json').then((bytes) => bytes.toString('utf8')),
        readRaw('events.ndjson').then((bytes) => bytes.toString('utf8')),
        readRaw('stderr.txt'),
        readRaw('process.json').then((bytes) => bytes.toString('utf8'))
      ])
    if (!request.equals(expectedRequest)) {
      throw new Error(`${rowId} raw request bytes do not match the frozen corpus`)
    }
    const process = JSON.parse(processText) as {
      readonly exitCode?: unknown
      readonly signal?: unknown
    }
    if (process.exitCode !== 0) throw new Error(`${rowId} raw process must have exitCode 0`)
    if ('signal' in process && process.signal !== null) {
      throw new Error(`${rowId} raw process must not have a signal`)
    }
    if (stderr.length !== 0) throw new Error(`${rowId} raw stderr must be empty on success`)
    validateRawEvents(eventsText, rowId)
    try {
      validateNativeIrregularResultEnvelope(JSON.parse(resultText) as unknown)
    } catch (error) {
      throw new Error(`${rowId} raw result must be valid typed result JSON: ${String(error)}`)
    }
  }
}

function assertCaptureTarget(target: string): asserts target is CaptureTarget {
  if (!CAPTURE_TARGETS.includes(target as CaptureTarget)) {
    throw new Error(`unsupported capture target: ${target}`)
  }
}

export function assertCaptureEnvironment(sourceDirectory: string, target: CaptureTarget): void {
  const source = resolve(sourceDirectory)
  const sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: source,
    encoding: 'utf8'
  }).trim()
  if (sourceRevision !== ACCEPTED_ENGINE_REVISION) {
    throw new Error(
      `accepted engine revision mismatch: expected ${ACCEPTED_ENGINE_REVISION}, got ${sourceRevision}`
    )
  }
  const rustc = execFileSync('rustc', ['-vV'], { encoding: 'utf8' })
  if (!rustc.includes(`release: ${CAPTURE_TOOLCHAIN}\n`)) {
    throw new Error(`Rust toolchain drift: expected ${CAPTURE_TOOLCHAIN}`)
  }
  const host = /^host: (.+)$/m.exec(rustc)?.[1]
  if (host !== target) throw new Error(`Rust host drift: expected ${target}, got ${host}`)
}

export async function finalizeOldParityBundle(bundleDirectory: string): Promise<void> {
  const bundleManifest = await buildOldParityBundleManifest(bundleDirectory)
  await writeFile(
    join(bundleDirectory, 'bundle-manifest.json'),
    `${JSON.stringify(bundleManifest, null, 2)}\n`
  )
  const manifest = await buildOldParityBundleManifest(bundleDirectory)
  const checksums = manifest.files.map((file) => `${file.sha256}  ${file.path}`).join('\n')
  await writeFile(join(bundleDirectory, 'SHA256SUMS'), `${checksums}\n`)
}

export interface CaptureMetadataInput {
  readonly target: CaptureTarget
  readonly historicalAddonSha256: string
  readonly freshAddonSha256: string
  readonly rustc: { readonly identity: string; readonly verbose: string }
  readonly cargo: { readonly identity: string }
  readonly sourceCargoLockSha256: string
  readonly nativeDependencies: {
    readonly entries: ReadonlyArray<{ readonly name: string; readonly version: string }>
    readonly sha256: string
  }
  readonly workflow: {
    readonly repository: string
    readonly ref: string
    readonly sha: string
    readonly runId: string
    readonly runAttempt: string
  }
  readonly corpus: {
    readonly manifestName: string
    readonly manifestSha256: string
    readonly sha256SumsSha256: string
    readonly rowIds: ReadonlyArray<string>
  }
}

export interface CaptureMetadata {
  readonly version: 1
  readonly acceptedEngineRevision: string
  readonly sourceProvenanceRevision: string
  readonly target: CaptureTarget
  readonly toolchain: string
  readonly artifactName: string
  readonly build: { readonly profile: 'release'; readonly features: ReadonlyArray<never> }
  readonly rustc: CaptureMetadataInput['rustc']
  readonly cargo: CaptureMetadataInput['cargo']
  readonly sourceCargoLockSha256: string
  readonly nativeDependencies: CaptureMetadataInput['nativeDependencies']
  readonly addon: { readonly historicalSha256: string; readonly freshSha256: string }
  readonly workflow: CaptureMetadataInput['workflow']
  readonly corpus: CaptureMetadataInput['corpus']
}

export function buildCaptureMetadata(input: CaptureMetadataInput): CaptureMetadata {
  assertSha256(input.historicalAddonSha256, 'historical addon hash')
  assertSha256(input.freshAddonSha256, 'fresh addon hash')
  assertSha256(input.sourceCargoLockSha256, 'source Cargo.lock hash')
  assertSha256(input.nativeDependencies.sha256, 'native dependency hash')
  assertSha256(input.corpus.manifestSha256, 'corpus manifest hash')
  assertSha256(input.corpus.sha256SumsSha256, 'corpus SHA256SUMS hash')
  if (input.rustc.identity.length === 0 || input.rustc.verbose.length === 0) {
    throw new Error('rustc identity is required')
  }
  if (input.cargo.identity.length === 0) throw new Error('cargo identity is required')
  if (
    !input.rustc.identity.includes(CAPTURE_TOOLCHAIN) ||
    !input.rustc.verbose.includes(`release: ${CAPTURE_TOOLCHAIN}`) ||
    !input.cargo.identity.includes(CAPTURE_TOOLCHAIN)
  ) {
    throw new Error(`Rust and Cargo identities must bind toolchain ${CAPTURE_TOOLCHAIN}`)
  }
  if (input.nativeDependencies.entries.length === 0)
    throw new Error('native dependencies are required')
  if (
    input.nativeDependencies.sha256 !==
    sha256(`${JSON.stringify(input.nativeDependencies.entries)}\n`)
  ) {
    throw new Error('native dependency hash does not match the canonical dependency entries')
  }
  if (input.corpus.manifestName !== 'migration-corpus.json') {
    throw new Error('corpus manifest must be migration-corpus.json')
  }
  if (input.corpus.rowIds.length !== EXPECTED_ROW_IDS.length) {
    throw new Error(`corpus must contain exactly ${EXPECTED_ROW_IDS.length} rows`)
  }
  if (input.corpus.rowIds.some((rowId, index) => rowId !== EXPECTED_ROW_IDS[index])) {
    throw new Error('corpus row IDs do not match the accepted capture order')
  }
  if (!/^[0-9a-f]{40}$/.test(input.workflow.sha)) {
    throw new Error('workflow SHA must be a lowercase Git revision')
  }
  if (
    input.workflow.repository.length === 0 ||
    input.workflow.ref.length === 0 ||
    input.workflow.runId.length === 0 ||
    input.workflow.runAttempt.length === 0
  ) {
    throw new Error('workflow identity is required')
  }
  for (const [index, entry] of input.nativeDependencies.entries.entries()) {
    const previous = input.nativeDependencies.entries[index - 1]
    if (
      entry.name.length === 0 ||
      entry.version.length === 0 ||
      (previous !== undefined &&
        `${previous.name}@${previous.version}` >= `${entry.name}@${entry.version}`)
    ) {
      throw new Error('native dependencies must be nonempty and canonically ordered')
    }
  }
  return {
    version: 1,
    acceptedEngineRevision: ACCEPTED_ENGINE_REVISION,
    sourceProvenanceRevision: SOURCE_PROVENANCE_REVISION,
    target: input.target,
    toolchain: CAPTURE_TOOLCHAIN,
    artifactName: captureArtifactName(input.target),
    build: { profile: 'release', features: [] },
    rustc: input.rustc,
    cargo: input.cargo,
    sourceCargoLockSha256: input.sourceCargoLockSha256,
    nativeDependencies: input.nativeDependencies,
    addon: {
      historicalSha256: input.historicalAddonSha256,
      freshSha256: input.freshAddonSha256
    },
    workflow: input.workflow,
    corpus: input.corpus
  }
}

async function readCaptureMetadataInput(path: string): Promise<CaptureMetadataInput> {
  const status = await lstat(path)
  if (!status.isFile() || status.isSymbolicLink()) {
    throw new Error('metadata input must be a regular file')
  }
  try {
    return JSON.parse(await readFile(path, 'utf8')) as CaptureMetadataInput
  } catch (error) {
    throw new Error(`metadata input must be valid JSON: ${String(error)}`)
  }
}

async function assembleBundle(
  corpusDirectory: string,
  rawDirectory: string,
  outputDirectory: string,
  metadataInputPath: string,
  repositoryRoot: string,
  target: CaptureTarget,
  historicalAddonSha256: string,
  freshAddonSha256: string
): Promise<void> {
  const freshInputs = await validateFreshCaptureInputs(corpusDirectory, repositoryRoot)
  if (historicalAddonSha256 !== freshInputs.historicalAddonSha256) {
    throw new Error('historical addon hash does not match the frozen legal manifest')
  }
  assertSha256(freshAddonSha256, 'fresh addon hash')
  const output = resolve(outputDirectory)
  const outputStatus = await lstat(dirname(output))
  if (!outputStatus.isDirectory() || outputStatus.isSymbolicLink())
    throw new Error('bundle parent must be a real directory')
  await validateRawCaptureDirectory(rawDirectory, corpusDirectory)
  await mkdir(output, { recursive: false })
  await mkdir(join(output, 'old'), { recursive: false })
  await cp(rawDirectory, join(output, 'old', 'raw'), { recursive: true, errorOnExist: true })
  const manifest = await buildOldParityBundleManifest(join(output, 'old', 'raw'))
  const metadataInput = await readCaptureMetadataInput(metadataInputPath)
  if (
    metadataInput.target !== target ||
    metadataInput.historicalAddonSha256 !== historicalAddonSha256 ||
    metadataInput.freshAddonSha256 !== freshAddonSha256
  ) {
    throw new Error('metadata input does not match requested target or addon hashes')
  }
  const corpusManifestSha256 = sha256(
    await readRegularContainedFile(
      corpusDirectory,
      join(corpusDirectory, 'migration-corpus.json'),
      'migration-corpus.json'
    )
  )
  const corpusSha256SumsSha256 = sha256(
    await readRegularContainedFile(
      corpusDirectory,
      join(corpusDirectory, 'SHA256SUMS'),
      'SHA256SUMS'
    )
  )
  if (
    metadataInput.corpus.manifestSha256 !== corpusManifestSha256 ||
    metadataInput.corpus.sha256SumsSha256 !== corpusSha256SumsSha256
  ) {
    throw new Error('metadata input does not match frozen corpus digests')
  }
  const metadata = { ...buildCaptureMetadata(metadataInput), raw: manifest }
  await writeFile(join(output, 'capture-metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`)
  await finalizeOldParityBundle(output)
}

export type OldParityArguments =
  | {
      readonly mode: 'validate-inputs'
      readonly corpusDirectory: string
      readonly repositoryRoot: string
    }
  | {
      readonly mode: 'validate-fresh-inputs'
      readonly corpusDirectory: string
      readonly repositoryRoot: string
    }
  | {
      readonly mode: 'assemble'
      readonly corpusDirectory: string
      readonly rawDirectory: string
      readonly outputDirectory: string
      readonly metadataInputPath: string
      readonly repositoryRoot: string
      readonly target: CaptureTarget
      readonly historicalAddonSha256: string
      readonly freshAddonSha256: string
    }
  | { readonly mode: 'finalize'; readonly bundleDirectory: string }

export function parseOldParityArguments(args: ReadonlyArray<string>): OldParityArguments {
  const option = (name: string): string | undefined => {
    const index = args.indexOf(name)
    return index < 0 ? undefined : args[index + 1]
  }
  const corpusDirectory = option('--corpus-dir')
  const repositoryRoot = option('--repository-root') ?? REPOSITORY_ROOT
  if (args.includes('--validate-inputs') || args.includes('--validate-fresh-inputs')) {
    if (corpusDirectory === undefined) throw new Error('--corpus-dir is required')
    return args.includes('--validate-inputs')
      ? { mode: 'validate-inputs', corpusDirectory, repositoryRoot }
      : { mode: 'validate-fresh-inputs', corpusDirectory, repositoryRoot }
  }
  if (args.includes('--assemble')) {
    const rawDirectory = option('--raw-dir')
    const outputDirectory = option('--output-dir')
    const metadataInputPath = option('--metadata-input')
    const target = option('--target')
    const historicalAddonSha256 = option('--historical-addon-sha256')
    const freshAddonSha256 = option('--fresh-addon-sha256')
    if (
      corpusDirectory === undefined ||
      rawDirectory === undefined ||
      outputDirectory === undefined ||
      metadataInputPath === undefined ||
      target === undefined ||
      historicalAddonSha256 === undefined ||
      freshAddonSha256 === undefined
    ) {
      throw new Error(
        '--assemble requires --corpus-dir, --raw-dir, --output-dir, --metadata-input, --target, --historical-addon-sha256, and --fresh-addon-sha256'
      )
    }
    assertCaptureTarget(target)
    assertSha256(historicalAddonSha256, 'historical addon hash')
    assertSha256(freshAddonSha256, 'fresh addon hash')
    return {
      mode: 'assemble',
      corpusDirectory,
      rawDirectory,
      outputDirectory,
      metadataInputPath,
      repositoryRoot,
      target,
      historicalAddonSha256,
      freshAddonSha256
    }
  }
  if (args.includes('--finalize')) {
    const bundleDirectory = option('--bundle-dir')
    if (bundleDirectory === undefined) throw new Error('--bundle-dir is required')
    return { mode: 'finalize', bundleDirectory }
  }
  throw new Error('use --validate-inputs, --validate-fresh-inputs, --assemble, or --finalize')
}

async function main(): Promise<void> {
  const parsed = parseOldParityArguments(process.argv.slice(2))
  if (parsed.mode === 'validate-inputs') {
    await validateOldParityCaptureInputs(parsed.corpusDirectory, parsed.repositoryRoot)
    return
  }
  if (parsed.mode === 'validate-fresh-inputs') {
    console.log(
      JSON.stringify(
        await validateFreshCaptureInputs(parsed.corpusDirectory, parsed.repositoryRoot)
      )
    )
    return
  }
  if (parsed.mode === 'assemble') {
    await assembleBundle(
      parsed.corpusDirectory,
      parsed.rawDirectory,
      parsed.outputDirectory,
      parsed.metadataInputPath,
      parsed.repositoryRoot,
      parsed.target,
      parsed.historicalAddonSha256,
      parsed.freshAddonSha256
    )
    return
  }
  await finalizeOldParityBundle(parsed.bundleDirectory)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error))
    process.exitCode = 1
  })
}
