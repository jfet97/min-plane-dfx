import { createHash } from 'node:crypto'
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { NativeIrregularJobTransport } from '../../src/workers/irregular/native/nativeIrregularBackend.js'
import {
  captureNativeTransportEvents,
  generateMigrationCorpusAtomically,
  validateEvidenceTree,
  validateHashManifest,
  validateMigrationCorpus,
  validateMigrationCorpusOutputDirectory,
  validateMigrationMetadata,
  validateNativePackageManifest
} from '../../scripts/rust-parity/migration-corpus.js'

const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'migration-corpus-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true }))
  )
})

const validMetadata = {
  acceptedEngine: 'old-rust',
  sourceFixtures: [
    {
      kind: 'generated',
      description: '20 triangle copies from makePresetShapeDocument',
      sha256: 'a'.repeat(64)
    }
  ],
  profile: 'compact',
  sheet: { width: 2000, height: 2700 },
  workers: { requested: 15, actual: 15 },
  collisionIdentitySha256: 'b'.repeat(64),
  fittedIdentitySha256: 'c'.repeat(64),
  normalizedSemanticSha256: 'd'.repeat(64),
  targetTriple: 'aarch64-apple-darwin',
  rustcIdentity: 'rustc 1.95.0',
  cargoIdentity: 'cargo 1.95.0',
  build: { profile: 'release', features: [] },
  nativeDependencies: [{ name: 'rayon', version: '1.11.0' }]
} as const

type ArtifactKey = 'request' | 'result' | 'events' | 'semanticProjection' | 'metadata'

async function writeCorpusRow(
  root: string,
  descriptor: {
    readonly id: string
    readonly fixture: string
    readonly sheet: string
    readonly profile: 'compact' | 'short-side'
  }
) {
  const directory = join(root, 'migration-corpus', descriptor.id)
  await mkdir(directory, { recursive: true })
  const artifacts: Record<ArtifactKey, string> = {
    request: `migration-corpus/${descriptor.id}/request.json`,
    result: `migration-corpus/${descriptor.id}/result.json`,
    events: `migration-corpus/${descriptor.id}/events.ndjson`,
    semanticProjection: `migration-corpus/${descriptor.id}/semantic-projection.json`,
    metadata: `migration-corpus/${descriptor.id}/metadata.json`
  }
  const fileNames: Record<ArtifactKey, string> = {
    request: 'request.json',
    result: 'result.json',
    events: 'events.ndjson',
    semanticProjection: 'semantic-projection.json',
    metadata: 'metadata.json'
  }
  const baselineDirectory = resolve(
    'docs/artifacts/polygon-nesting-extraction-baseline/migration-corpus',
    descriptor.id
  )
  const hashes = {} as Record<ArtifactKey, string>
  for (const key of Object.keys(artifacts) as ArtifactKey[]) {
    const contents = await readFile(join(baselineDirectory, fileNames[key]))
    await writeFile(join(root, artifacts[key]), contents)
    hashes[key] = createHash('sha256').update(contents).digest('hex')
  }
  return { ...descriptor, artifacts, sha256: hashes }
}

type CorpusTestRow = Awaited<ReturnType<typeof writeCorpusRow>>

async function replaceArtifact(
  root: string,
  row: CorpusTestRow,
  key: ArtifactKey,
  value: unknown
): Promise<void> {
  const contents = `${JSON.stringify(value)}\n`
  await writeFile(join(root, row.artifacts[key]), contents)
  row.sha256[key] = createHash('sha256').update(contents).digest('hex')
}

async function readArtifact(
  root: string,
  row: CorpusTestRow,
  key: ArtifactKey
): Promise<unknown> {
  return JSON.parse(await readFile(join(root, row.artifacts[key]), 'utf8')) as unknown
}

describe('migration corpus export helpers', () => {
  it('captures the exact native event bytes while preserving forwarding and cancellation', async () => {
    const forwarded: string[] = []
    const captured: string[] = []
    const cancellations: Array<readonly [string, 'cancelled' | 'timeout']> = []
    const transport: NativeIrregularJobTransport = {
      run: async (_requestJson, _invocationToken, onEvent) => {
        onEvent('{"kind":"portfolio-progress","ordinal":0,"progress":{}}')
        onEvent('{"kind":"terminal","ordinal":1}')
        return '{"ok":false,"error":{"category":"worker_cancelled","operation":"run","message":"cancelled"}}'
      },
      cancel: (invocationToken, reason) => {
        cancellations.push([invocationToken, reason])
        return true
      }
    }

    const decorated = captureNativeTransportEvents(transport, captured)
    const envelope = await decorated.run(
      'request',
      'token',
      (event) => forwarded.push(event),
      false
    )
    const cancelled = decorated.cancel('token', 'timeout')

    expect(captured).toEqual(forwarded)
    expect(captured).toEqual([
      '{"kind":"portfolio-progress","ordinal":0,"progress":{}}',
      '{"kind":"terminal","ordinal":1}'
    ])
    expect(envelope).toContain('worker_cancelled')
    expect(cancelled).toBe(true)
    expect(cancellations).toEqual([['token', 'timeout']])
  })

  it('validates required metadata and accepts an explicit generated source fixture', () => {
    expect(() => validateMigrationMetadata(validMetadata)).not.toThrow()
  })

  it('rejects a package dry-run that contains source or target paths', () => {
    expect(() =>
      validateNativePackageManifest([
        {
          files: [
            { path: 'package.json' },
            { path: 'NOTICE' },
            { path: 'LICENSES/clipper2-ts-BSL-1.0.txt' },
            { path: 'npm/index.cjs' },
            { path: 'npm/target.cjs' },
            { path: 'npm/irregular-nesting-native.test.node' },
            { path: 'src/lib.rs' },
            { path: 'target/release/addon.node' }
          ]
        }
      ])
    ).toThrow(/forbidden package path/)
  })

  it('validates source hash manifests against repository-contained files', async () => {
    const root = await temporaryDirectory()
    const sourcePath = join(root, 'source.txt')
    const source = 'frozen bytes\n'
    await writeFile(sourcePath, source)
    const hash = createHash('sha256').update(source).digest('hex')

    await expect(validateHashManifest(root, `${hash}  source.txt\n`)).resolves.toBe(1)
    await expect(validateHashManifest(root, `${'0'.repeat(64)}  source.txt\n`)).rejects.toThrow(
      /hash mismatch/
    )
    await expect(validateHashManifest(root, `${hash}  ..\/escaped.txt\n`)).rejects.toThrow(
      /escapes/
    )
  })

  it('rejects a canonical artifact replaced by an absolute symlink outside the evidence root', async () => {
    const root = await temporaryDirectory()
    const externalRoot = await temporaryDirectory()
    const row = await writeCorpusRow(root, {
      id: 'triangle-20-2000x2700-compact',
      fixture: 'triangle-20',
      sheet: '2000x2700',
      profile: 'compact'
    })
    const artifactPath = join(root, row.artifacts.request)
    const externalPath = join(externalRoot, 'request.json')
    await writeFile(externalPath, await readFile(artifactPath))
    await rm(artifactPath)
    await symlink(externalPath, artifactPath)

    await expect(
      validateMigrationCorpus(root, { version: 1, acceptedEngine: 'old-rust', rows: [row] }, [
        row.id
      ])
    ).rejects.toThrow(/request.*symlink|symlink.*request/)
  })

  it('rejects a relative artifact symlink that resolves outside the evidence root', async () => {
    const root = await temporaryDirectory()
    const externalRoot = await temporaryDirectory()
    const row = await writeCorpusRow(root, {
      id: 'triangle-20-2000x2700-compact',
      fixture: 'triangle-20',
      sheet: '2000x2700',
      profile: 'compact'
    })
    const artifactPath = join(root, row.artifacts.result)
    const externalPath = join(externalRoot, 'result.json')
    await writeFile(externalPath, await readFile(artifactPath))
    await rm(artifactPath)
    await symlink(relative(dirname(artifactPath), externalPath), artifactPath)

    await expect(
      validateMigrationCorpus(root, { version: 1, acceptedEngine: 'old-rust', rows: [row] }, [
        row.id
      ])
    ).rejects.toThrow(/result.*symlink|symlink.*result/)
  })

  it('rejects a managed artifact below a symlinked directory', async () => {
    const root = await temporaryDirectory()
    const row = await writeCorpusRow(root, {
      id: 'triangle-20-2000x2700-compact',
      fixture: 'triangle-20',
      sheet: '2000x2700',
      profile: 'compact'
    })
    const corpusDirectory = join(root, 'migration-corpus')
    const realCorpusDirectory = join(root, 'real-migration-corpus')
    await rename(corpusDirectory, realCorpusDirectory)
    await symlink(realCorpusDirectory, corpusDirectory)

    await expect(
      validateMigrationCorpus(root, { version: 1, acceptedEngine: 'old-rust', rows: [row] }, [
        row.id
      ])
    ).rejects.toThrow(/migration-corpus.*symlink|symlink.*migration-corpus/)
  })

  it('rejects a hash-manifest target below a symlinked directory', async () => {
    const root = await temporaryDirectory()
    const actualDirectory = join(root, 'actual')
    await mkdir(actualDirectory)
    const source = 'frozen bytes\n'
    await writeFile(join(actualDirectory, 'source.txt'), source)
    await symlink(actualDirectory, join(root, 'linked'))
    const hash = createHash('sha256').update(source).digest('hex')

    await expect(validateHashManifest(root, `${hash}  linked/source.txt\n`)).rejects.toThrow(
      /linked.*symlink|symlink.*linked/
    )
  })

  it('rejects a hash-manifest target replaced by a symlink', async () => {
    const root = await temporaryDirectory()
    const externalRoot = await temporaryDirectory()
    const sourcePath = join(root, 'source.txt')
    const externalPath = join(externalRoot, 'source.txt')
    const source = 'frozen bytes\n'
    const hash = createHash('sha256').update(source).digest('hex')
    await writeFile(externalPath, source)
    await symlink(externalPath, sourcePath)

    await expect(validateHashManifest(root, `${hash}  source.txt\n`)).rejects.toThrow(
      /source\.txt.*symlink|symlink.*source\.txt/
    )
  })

  it('rejects unrelated nested, directory, and broken symlinks in an evidence tree', async () => {
    const root = await temporaryDirectory()
    const externalRoot = await temporaryDirectory()
    await mkdir(join(root, 'gates'), { recursive: true })
    await writeFile(join(externalRoot, 'external.log'), 'external\n')

    const cases = [
      {
        path: join(root, 'gates', 'external.log'),
        target: join(externalRoot, 'external.log')
      },
      { path: join(root, 'linked-directory'), target: externalRoot },
      { path: join(root, 'gates', 'broken.log'), target: join(externalRoot, 'missing.log') }
    ]
    for (const entry of cases) {
      await symlink(entry.target, entry.path)
      await expect(validateEvidenceTree(root)).rejects.toThrow(/symlink/)
      await rm(entry.path)
    }
  })

  it('aborts staging before promotion when the existing evidence tree contains a symlink', async () => {
    const root = await temporaryDirectory()
    const externalRoot = await temporaryDirectory()
    const baselineRoot = join(root, 'polygon-nesting-extraction-baseline')
    await mkdir(join(baselineRoot, 'gates'), { recursive: true })
    await writeFile(join(baselineRoot, 'source.json'), 'preserve me\n')
    const externalPath = join(externalRoot, 'external.log')
    await writeFile(externalPath, 'external\n')
    await symlink(externalPath, join(baselineRoot, 'gates', 'external.log'))
    let generationStarted = false

    await expect(
      generateMigrationCorpusAtomically(
        baselineRoot,
        async () => {
          generationStarted = true
        },
        baselineRoot
      )
    ).rejects.toThrow(/gates.*external\.log.*symlink|symlink.*gates.*external\.log/)
    expect(generationStarted).toBe(false)
    await expect(readFile(join(baselineRoot, 'source.json'), 'utf8')).resolves.toBe(
      'preserve me\n'
    )
  })

  it('rejects a symlink created in staging before promotion', async () => {
    const root = await temporaryDirectory()
    const externalRoot = await temporaryDirectory()
    const baselineRoot = join(root, 'polygon-nesting-extraction-baseline')
    await mkdir(baselineRoot)
    await writeFile(join(baselineRoot, 'source.json'), 'preserve me\n')
    const externalPath = join(externalRoot, 'external.log')
    await writeFile(externalPath, 'external\n')

    await expect(
      generateMigrationCorpusAtomically(
        baselineRoot,
        async (stagingDirectory) => {
          await mkdir(join(stagingDirectory, 'gates'), { recursive: true })
          await symlink(externalPath, join(stagingDirectory, 'gates', 'external.log'))
        },
        baselineRoot
      )
    ).rejects.toThrow(/gates.*external\.log.*symlink|symlink.*gates.*external\.log/)
    await expect(readFile(join(baselineRoot, 'source.json'), 'utf8')).resolves.toBe(
      'preserve me\n'
    )
  })

  it('rejects rows that share artifact maps or artifact paths', async () => {
    const root = await temporaryDirectory()
    const first = await writeCorpusRow(root, {
      id: 'triangle-20-2000x2700-compact',
      fixture: 'triangle-20',
      sheet: '2000x2700',
      profile: 'compact'
    })
    const second = {
      ...(await writeCorpusRow(root, {
        id: 'triangle-20-600x400-compact',
        fixture: 'triangle-20',
        sheet: '600x400',
        profile: 'compact'
      })),
      artifacts: first.artifacts,
      sha256: first.sha256
    }
    const corpus = { version: 1, acceptedEngine: 'old-rust', rows: [first, second] }

    await expect(
      validateMigrationCorpus(root, corpus, [first.id, second.id])
    ).rejects.toThrow(/canonical artifact path|duplicate artifact path/)
  })

  it('rejects row descriptors and paths that do not match the canonical row ID', async () => {
    const root = await temporaryDirectory()
    const row = await writeCorpusRow(root, {
      id: 'triangle-20-2000x2700-compact',
      fixture: 'triangle-20',
      sheet: '2000x2700',
      profile: 'compact'
    })
    const corpus = {
      version: 1,
      acceptedEngine: 'old-rust',
      rows: [{ ...row, fixture: 'mixed-61' }]
    }

    await expect(validateMigrationCorpus(root, corpus, [row.id])).rejects.toThrow(
      /canonical row descriptor/
    )

    corpus.rows[0] = {
      ...row,
      artifacts: { ...row.artifacts, request: row.artifacts.result },
      sha256: { ...row.sha256, request: row.sha256.result }
    }
    await expect(validateMigrationCorpus(root, corpus, [row.id])).rejects.toThrow(
      /canonical artifact path/
    )
  })

  it('rejects a semantic projection artifact redirected to request.json', async () => {
    const root = await temporaryDirectory()
    const row = await writeCorpusRow(root, {
      id: 'triangle-20-2000x2700-compact',
      fixture: 'triangle-20',
      sheet: '2000x2700',
      profile: 'compact'
    })
    row.artifacts.semanticProjection = row.artifacts.request
    row.sha256.semanticProjection = row.sha256.request

    await expect(
      validateMigrationCorpus(root, { version: 1, acceptedEngine: 'old-rust', rows: [row] }, [
        row.id
      ])
    ).rejects.toThrow(/canonical artifact path/)
  })

  it.each([
    ['normalizedSemanticSha256', 'normalized semantic projection'],
    ['collisionIdentitySha256', 'collision identity'],
    ['fittedIdentitySha256', 'fitted identity']
  ] as const)('rejects stale %s metadata', async (metadataKey, expectedMessage) => {
    const root = await temporaryDirectory()
    const row = await writeCorpusRow(root, {
      id: 'triangle-20-2000x2700-compact',
      fixture: 'triangle-20',
      sheet: '2000x2700',
      profile: 'compact'
    })
    const metadata = (await readArtifact(root, row, 'metadata')) as Record<string, unknown>
    metadata[metadataKey] = '0'.repeat(64)
    await replaceArtifact(root, row, 'metadata', metadata)

    await expect(
      validateMigrationCorpus(root, { version: 1, acceptedEngine: 'old-rust', rows: [row] }, [
        row.id
      ])
    ).rejects.toThrow(new RegExp(expectedMessage))
  })

  it('rejects a semantic projection that is not normalized from result.json', async () => {
    const root = await temporaryDirectory()
    const row = await writeCorpusRow(root, {
      id: 'triangle-20-2000x2700-compact',
      fixture: 'triangle-20',
      sheet: '2000x2700',
      profile: 'compact'
    })
    await replaceArtifact(root, row, 'semanticProjection', await readArtifact(root, row, 'request'))

    await expect(
      validateMigrationCorpus(root, { version: 1, acceptedEngine: 'old-rust', rows: [row] }, [
        row.id
      ])
    ).rejects.toThrow(/semantic projection/)
  })

  it.each([
    ['profile', 'metadata profile', 'short-side'],
    ['sheet', 'metadata sheet', { width: 600, height: 400 }]
  ] as const)('rejects wrong %s metadata', async (metadataKey, expectedMessage, invalidValue) => {
    const root = await temporaryDirectory()
    const row = await writeCorpusRow(root, {
      id: 'triangle-20-2000x2700-compact',
      fixture: 'triangle-20',
      sheet: '2000x2700',
      profile: 'compact'
    })
    const metadata = (await readArtifact(root, row, 'metadata')) as Record<string, unknown>
    metadata[metadataKey] = invalidValue
    await replaceArtifact(root, row, 'metadata', metadata)

    await expect(
      validateMigrationCorpus(root, { version: 1, acceptedEngine: 'old-rust', rows: [row] }, [
        row.id
      ])
    ).rejects.toThrow(new RegExp(expectedMessage))
  })

  it('rejects unsafe generation output directories', async () => {
    const root = await temporaryDirectory()
    const repositoryRoot = join(root, 'repository')
    const baselineRoot = join(
      repositoryRoot,
      'docs/artifacts/polygon-nesting-extraction-baseline'
    )
    await mkdir(baselineRoot, { recursive: true })
    const existingChild = join(baselineRoot, 'existing-child')
    await mkdir(existingChild)

    await expect(
      validateMigrationCorpusOutputDirectory(repositoryRoot, baselineRoot)
    ).rejects.toThrow(/baseline directory or a fresh direct child/)
    await expect(
      validateMigrationCorpusOutputDirectory(join(repositoryRoot, 'src'), baselineRoot)
    ).rejects.toThrow(/baseline directory or a fresh direct child/)
    await expect(
      validateMigrationCorpusOutputDirectory(join(root, 'escaped'), baselineRoot)
    ).rejects.toThrow(/baseline directory or a fresh direct child/)
    await expect(
      validateMigrationCorpusOutputDirectory(existingChild, baselineRoot)
    ).rejects.toThrow(/fresh output child already exists/)
    await expect(
      validateMigrationCorpusOutputDirectory(join(baselineRoot, 'fresh-child'), baselineRoot)
    ).resolves.toEqual({ kind: 'fresh-child' })
  })

  it('keeps the existing baseline untouched on failure and preserves unrelated content on success', async () => {
    const root = await temporaryDirectory()
    const baselineRoot = join(root, 'polygon-nesting-extraction-baseline')
    await mkdir(join(baselineRoot, 'migration-corpus', 'old-row'), { recursive: true })
    await writeFile(join(baselineRoot, 'source.json'), 'preserve me\n')
    await writeFile(join(baselineRoot, 'migration-corpus', 'old-row', 'result.json'), 'old\n')

    await expect(
      generateMigrationCorpusAtomically(
        baselineRoot,
        async (stagingDirectory) => {
          await mkdir(join(stagingDirectory, 'migration-corpus', 'new-row'), { recursive: true })
          await writeFile(
            join(stagingDirectory, 'migration-corpus', 'new-row', 'result.json'),
            'partial\n'
          )
          throw new Error('generation failed')
        },
        baselineRoot
      )
    ).rejects.toThrow(/generation failed/)
    await expect(
      readFile(join(baselineRoot, 'migration-corpus', 'old-row', 'result.json'), 'utf8')
    ).resolves.toBe('old\n')
    await expect(access(join(root, '.polygon-nesting-extraction-baseline.staging'))).rejects.toThrow()

    await generateMigrationCorpusAtomically(
      baselineRoot,
      async (stagingDirectory) => {
        await mkdir(join(stagingDirectory, 'migration-corpus', 'new-row'), { recursive: true })
        await writeFile(
          join(stagingDirectory, 'migration-corpus', 'new-row', 'result.json'),
          'complete\n'
        )
      },
      baselineRoot
    )
    await expect(readFile(join(baselineRoot, 'source.json'), 'utf8')).resolves.toBe(
      'preserve me\n'
    )
    await expect(
      readFile(join(baselineRoot, 'migration-corpus', 'new-row', 'result.json'), 'utf8')
    ).resolves.toBe('complete\n')
    await expect(access(join(baselineRoot, 'migration-corpus', 'old-row'))).rejects.toThrow()
  })

  it('validates hashes, ordered event ordinals, unique rows, and repository-contained paths', async () => {
    const root = await temporaryDirectory()
    const row = await writeCorpusRow(root, {
      id: 'triangle-20-2000x2700-compact',
      fixture: 'triangle-20',
      sheet: '2000x2700',
      profile: 'compact'
    })
    const corpus = { version: 1, acceptedEngine: 'old-rust', rows: [row] }

    await expect(validateMigrationCorpus(root, corpus, [row.id])).resolves.toEqual({
      artifactCount: 5,
      rowCount: 1
    })

    const invalidEvents = '{"kind":"terminal","ordinal":2}\n'
    await writeFile(join(root, row.artifacts.events), invalidEvents)
    row.sha256.events = createHash('sha256').update(invalidEvents).digest('hex')
    await expect(validateMigrationCorpus(root, corpus, [row.id])).rejects.toThrow(/event ordinal/)
  })
})
