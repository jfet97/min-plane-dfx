import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  ACCEPTED_ENGINE_REVISION,
  CAPTURE_TOOLCHAIN,
  CAPTURE_TARGETS,
  EXPECTED_ROW_IDS,
  captureArchiveName,
  captureArtifactName,
  buildCaptureMetadata,
  finalizeOldParityBundle,
  parseOldParityArguments,
  buildOldParityBundleManifest,
  validateFreshCaptureInputs,
  validateOldParityCaptureInputs,
  validateRawCaptureDirectory,
  validateRawCaptureManifest
} from '../../scripts/rust-parity/capture-old-parity.js'

const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await (await import('node:fs/promises')).mkdtemp(join(tmpdir(), 'old-parity-'))
  temporaryDirectories.push(directory)
  return directory
}

function sha256(bytes: string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true }))
  )
})

describe('old parity capture assembly', () => {
  it('pins the accepted engine execution environment', () => {
    expect(ACCEPTED_ENGINE_REVISION).toBe('5c72d8fca8e078b0a6e7d5f2515a8a0953475481')
    expect(CAPTURE_TOOLCHAIN).toBe('1.95.0')
    expect(CAPTURE_TARGETS).toEqual([
      'x86_64-unknown-linux-gnu',
      'x86_64-pc-windows-msvc',
      'aarch64-apple-darwin',
      'x86_64-apple-darwin'
    ])
    expect(captureArtifactName('x86_64-unknown-linux-gnu')).toBe(
      'old-rust-parity-capture-x86_64-unknown-linux-gnu'
    )
    expect(captureArchiveName('x86_64-unknown-linux-gnu')).toBe(
      'old-rust-parity-capture-x86_64-unknown-linux-gnu.tar.gz'
    )
  })

  it('parses every required target-specific assembly argument', () => {
    const hash = 'a'.repeat(64)
    expect(
      parseOldParityArguments([
        '--assemble',
        '--corpus-dir',
        'corpus',
        '--raw-dir',
        'raw',
        '--output-dir',
        'capture',
        '--metadata-input',
        'metadata-input.json',
        '--target',
        'x86_64-unknown-linux-gnu',
        '--historical-addon-sha256',
        hash,
        '--fresh-addon-sha256',
        hash
      ])
    ).toEqual({
      mode: 'assemble',
      corpusDirectory: 'corpus',
      rawDirectory: 'raw',
      outputDirectory: 'capture',
      metadataInputPath: 'metadata-input.json',
      repositoryRoot: expect.any(String),
      target: 'x86_64-unknown-linux-gnu',
      historicalAddonSha256: hash,
      freshAddonSha256: hash
    })
    expect(() => parseOldParityArguments(['--assemble'])).toThrow(/historical-addon-sha256/)
  })

  it('rejects a raw capture manifest without each expected row artifact', () => {
    expect(() => validateRawCaptureManifest({ version: 1, files: [] })).toThrow(
      /every corpus row exactly once/
    )
  })

  it('rejects duplicate or extra raw capture artifact paths', () => {
    const files = EXPECTED_ROW_IDS.flatMap((rowId) =>
      ['request.json', 'result.json', 'events.ndjson', 'stderr.txt', 'process.json'].map(
        (name) => ({
          path: `${rowId}/${name}`,
          sha256: 'a'.repeat(64),
          size: 1
        })
      )
    )

    expect(() =>
      validateRawCaptureManifest({
        version: 1,
        files: [...files, { path: 'extra.json', sha256: 'a'.repeat(64), size: 1 }]
      })
    ).toThrow(/all five artifacts/)
    expect(() => validateRawCaptureManifest({ version: 1, files: [...files, files[0]!] })).toThrow(
      /all five artifacts/
    )
  })

  it('rejects a malformed raw process record even when all required paths exist', async () => {
    const root = await temporaryDirectory()
    const rawDirectory = join(root, 'raw')
    const corpusDirectory = join(root, 'corpus')

    for (const rowId of EXPECTED_ROW_IDS) {
      await mkdir(join(rawDirectory, rowId), { recursive: true })
      await mkdir(join(corpusDirectory, 'migration-corpus', rowId), { recursive: true })
      const request = '{"sheet":{"width":1,"height":1}}\n'
      await writeFile(join(rawDirectory, rowId, 'request.json'), request)
      await writeFile(join(corpusDirectory, 'migration-corpus', rowId, 'request.json'), request)
      await writeFile(join(rawDirectory, rowId, 'result.json'), '{"ok":true,"result":{}}\n')
      await writeFile(
        join(rawDirectory, rowId, 'events.ndjson'),
        '{"kind":"terminal","ordinal":0}\n'
      )
      await writeFile(join(rawDirectory, rowId, 'stderr.txt'), '')
      await writeFile(join(rawDirectory, rowId, 'process.json'), '{"exitCode":1}\n')
    }

    await expect(validateRawCaptureDirectory(rawDirectory, corpusDirectory)).rejects.toThrow(
      /exitCode 0/
    )
  })

  it('rejects an arbitrary successful result envelope', async () => {
    const root = await temporaryDirectory()
    const rawDirectory = join(root, 'raw')
    const corpusDirectory = join(root, 'corpus')

    for (const rowId of EXPECTED_ROW_IDS) {
      await mkdir(join(rawDirectory, rowId), { recursive: true })
      await mkdir(join(corpusDirectory, 'migration-corpus', rowId), { recursive: true })
      const request = '{"sheet":{"width":1,"height":1}}\n'
      await writeFile(join(rawDirectory, rowId, 'request.json'), request)
      await writeFile(join(corpusDirectory, 'migration-corpus', rowId, 'request.json'), request)
      await writeFile(join(rawDirectory, rowId, 'result.json'), '{"ok":true,"result":{}}\n')
      await writeFile(
        join(rawDirectory, rowId, 'events.ndjson'),
        '{"kind":"terminal","ordinal":0}\n'
      )
      await writeFile(join(rawDirectory, rowId, 'stderr.txt'), '')
      await writeFile(join(rawDirectory, rowId, 'process.json'), '{"exitCode":0}\n')
    }

    await expect(validateRawCaptureDirectory(rawDirectory, corpusDirectory)).rejects.toThrow(
      /valid typed result/
    )
  })

  it('rejects a malformed nonterminal raw event', async () => {
    const root = await temporaryDirectory()
    const rawDirectory = join(root, 'raw')
    const corpusDirectory = join(root, 'corpus')

    for (const rowId of EXPECTED_ROW_IDS) {
      await mkdir(join(rawDirectory, rowId), { recursive: true })
      await mkdir(join(corpusDirectory, 'migration-corpus', rowId), { recursive: true })
      const request = '{"sheet":{"width":1,"height":1}}\n'
      await writeFile(join(rawDirectory, rowId, 'request.json'), request)
      await writeFile(join(corpusDirectory, 'migration-corpus', rowId, 'request.json'), request)
      await writeFile(join(rawDirectory, rowId, 'result.json'), '{"ok":true,"result":{}}\n')
      await writeFile(
        join(rawDirectory, rowId, 'events.ndjson'),
        '{"kind":"state-snapshot","ordinal":0}\n{"kind":"terminal","ordinal":1}\n'
      )
      await writeFile(join(rawDirectory, rowId, 'stderr.txt'), '')
      await writeFile(join(rawDirectory, rowId, 'process.json'), '{"exitCode":0}\n')
    }

    await expect(validateRawCaptureDirectory(rawDirectory, corpusDirectory)).rejects.toThrow(
      /valid typed semantic events/
    )
  })

  it('binds the required structured capture metadata fields', async () => {
    const hash = 'a'.repeat(64)
    const metadata = buildCaptureMetadata({
      target: 'x86_64-unknown-linux-gnu',
      historicalAddonSha256: hash,
      freshAddonSha256: 'b'.repeat(64),
      rustc: { identity: 'rustc 1.95.0', verbose: 'release: 1.95.0' },
      cargo: { identity: 'cargo 1.95.0' },
      sourceCargoLockSha256: 'c'.repeat(64),
      nativeDependencies: {
        entries: [{ name: 'napi', version: '3.12.0' }],
        sha256: sha256(`${JSON.stringify([{ name: 'napi', version: '3.12.0' }])}\n`)
      },
      workflow: {
        repository: 'owner/repo',
        ref: 'refs/heads/main',
        sha: 'e'.repeat(40),
        runId: '17',
        runAttempt: '2'
      },
      corpus: {
        manifestName: 'migration-corpus.json',
        manifestSha256: 'f'.repeat(64),
        sha256SumsSha256: '0'.repeat(64),
        rowIds: EXPECTED_ROW_IDS
      }
    })

    expect(metadata).toMatchObject({
      version: 1,
      target: 'x86_64-unknown-linux-gnu',
      build: { profile: 'release', features: [] },
      rustc: { identity: 'rustc 1.95.0' },
      cargo: { identity: 'cargo 1.95.0' },
      sourceCargoLockSha256: 'c'.repeat(64),
      addon: { historicalSha256: hash, freshSha256: 'b'.repeat(64) },
      workflow: { repository: 'owner/repo', runId: '17' },
      corpus: { rowIds: EXPECTED_ROW_IDS, manifestName: 'migration-corpus.json' }
    })

    const fixture = JSON.parse(
      await readFile(join('tests', 'fixtures', 'capture-metadata-v1.json'), 'utf8')
    ) as typeof metadata & {
      readonly raw: { readonly version: 1; readonly files: ReadonlyArray<never> }
    }
    const { raw: _raw, addon, ...input } = fixture
    void _raw
    expect(
      buildCaptureMetadata({
        ...input,
        historicalAddonSha256: addon.historicalSha256,
        freshAddonSha256: addon.freshSha256
      })
    ).toEqual({ ...input, addon })
  })

  it('defines every raw bundle file in the capture metadata schema', async () => {
    const schema = JSON.parse(
      await readFile(join('docs', 'planning', 'capture-metadata-v1.schema.json'), 'utf8')
    ) as {
      readonly properties: {
        readonly raw: { readonly properties: { readonly files: { readonly items?: unknown } } }
      }
    }

    expect(schema.properties.raw.properties.files.items).toEqual({
      type: 'object',
      additionalProperties: false,
      required: ['path', 'sha256', 'size'],
      properties: {
        path: {
          type: 'string',
          pattern: '^[^/]+/(?:request|result|events|stderr|process)\\.(?:json|ndjson|txt)$'
        },
        sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
        size: { type: 'integer', minimum: 0 }
      }
    })
  })

  it('fails closed when the validated frozen corpus does not contain all 18 rows', async () => {
    const root = await temporaryDirectory()
    const corpusDirectory = join(root, 'corpus')
    await mkdir(corpusDirectory)
    const corpus = JSON.stringify({ version: 1, acceptedEngine: 'old-rust', rows: [] })
    await writeFile(join(corpusDirectory, 'migration-corpus.json'), corpus)
    await writeFile(
      join(corpusDirectory, 'SHA256SUMS'),
      `${sha256(corpus)}  migration-corpus.json\n`
    )

    await expect(validateOldParityCaptureInputs(corpusDirectory)).rejects.toThrow(
      /every expected row exactly once/
    )
  })

  it('validates fresh capture inputs while preserving the unavailable historical addon hash', async () => {
    await expect(
      validateFreshCaptureInputs('docs/artifacts/polygon-nesting-extraction-baseline')
    ).resolves.toEqual({
      historicalAddonSha256: '9fc447f80a820c60676eee62706694c7f7ac79092a66ac131ac50b4f216dec9b'
    })
  })

  it('uses the supplied accepted-engine root for frozen source manifests', async () => {
    const root = await temporaryDirectory()
    await expect(
      validateFreshCaptureInputs('docs/artifacts/polygon-nesting-extraction-baseline', root)
    ).rejects.toThrow(/ENOENT/)
  })

  it('selects GNU tar explicitly for deterministic capture archives', async () => {
    const workflow = await readFile('.github/workflows/capture-old-rust-parity.yml', 'utf8')

    expect(workflow).toMatch(/command -v gtar/)
    expect(workflow).toMatch(/tar --version.*GNU tar/)
    expect(workflow).toMatch(/GNU_TAR=.*gtar/)
    expect(workflow).toMatch(/"\$GNU_TAR" --sort=name --owner=0 --group=0 --numeric-owner/)
  })

  it('keeps the bundle inventory hashable after two finalize passes', async () => {
    const root = await temporaryDirectory()
    await mkdir(join(root, 'old', 'raw', 'row-a'), { recursive: true })
    await writeFile(join(root, 'capture-metadata.json'), '{"version":1}\n')
    await writeFile(join(root, 'old', 'raw', 'row-a', 'request.json'), '{"request":true}\n')

    await finalizeOldParityBundle(root)
    await writeFile(join(root, 'workflow-revision.txt'), 'workflow-sha\n')
    await finalizeOldParityBundle(root)

    const manifest = JSON.parse(await readFile(join(root, 'bundle-manifest.json'), 'utf8')) as {
      readonly files: ReadonlyArray<{
        readonly path: string
        readonly sha256: string
        readonly size: number
      }>
    }
    expect(manifest.files.map((entry) => entry.path)).toEqual([
      'capture-metadata.json',
      'old/raw/row-a/request.json',
      'workflow-revision.txt'
    ])
    await Promise.all(
      manifest.files.map(async (entry) => {
        const bytes = await readFile(join(root, entry.path))
        expect(sha256(bytes.toString('utf8'))).toBe(entry.sha256)
        expect((await stat(join(root, entry.path))).size).toBe(entry.size)
      })
    )
  })

  it('makes the archive manifest deterministic and excludes its checksum file', async () => {
    const root = await temporaryDirectory()
    await mkdir(join(root, 'old', 'raw', 'row-a'), { recursive: true })
    await writeFile(join(root, 'old', 'raw', 'row-a', 'request.json'), '{"request":true}\n')
    await writeFile(join(root, 'capture-metadata.json'), '{"version":1}\n')
    await writeFile(join(root, 'SHA256SUMS'), 'must not be included\n')

    const manifest = await buildOldParityBundleManifest(root)

    expect(manifest.files.map((entry) => entry.path)).toEqual([
      'capture-metadata.json',
      'old/raw/row-a/request.json'
    ])
    expect(manifest.files).toEqual(
      [...manifest.files].toSorted((first, second) => first.path.localeCompare(second.path))
    )
    expect(manifest.files.some((entry) => entry.path === 'SHA256SUMS')).toBe(false)
    await expect(readFile(join(root, 'SHA256SUMS'), 'utf8')).resolves.toBe('must not be included\n')
  })
})
