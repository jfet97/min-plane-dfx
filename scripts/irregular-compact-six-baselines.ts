import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

interface Baseline {
  readonly fixture: 'triangle-20' | 'mixed-61' | 'shapes-17'
  readonly sheet: '2000x2700' | '600x400'
  readonly collisionIdentitySha256: string
  readonly fittedCanonicalSha256: string
  readonly placedCount: number
  readonly unplacedCount: number
  readonly maximumAreaMm2: number
  readonly maximumCanonicalCavities: number
  readonly maximumElapsedMs: number
}

const BASELINES: ReadonlyArray<Baseline> = [
  {
    fixture: 'triangle-20',
    sheet: '2000x2700',
    collisionIdentitySha256:
      '371db2696b65e2122b98bdb197a1d327df0c6ecbeca6ed73d2722971be52a127',
    fittedCanonicalSha256:
      'b4d1fd9af8a1ecb4a17f1031546c1dbbb5afb19b2d99e41bdb646e52084092f7',
    placedCount: 20,
    unplacedCount: 0,
    maximumAreaMm2: 74_428.143126,
    maximumCanonicalCavities: 0,
    maximumElapsedMs: 120_000
  },
  {
    fixture: 'mixed-61',
    sheet: '2000x2700',
    collisionIdentitySha256:
      '3839e80d26be257381f1962816765a886d4b7e3c3d78120892e4a6a943dfa742',
    fittedCanonicalSha256:
      'ef2b783ae12491d2a80a12ef94d1bb2801c13cbd43aeb6e2c1cc00d86828fd3b',
    placedCount: 61,
    unplacedCount: 0,
    maximumAreaMm2: 391_605.850174,
    maximumCanonicalCavities: 0,
    maximumElapsedMs: 330_000
  },
  {
    fixture: 'shapes-17',
    sheet: '2000x2700',
    collisionIdentitySha256:
      'c640c06f662050f8a132168f63988c40ba41f2ebc57dc50277a91119b4b4980a',
    fittedCanonicalSha256:
      'ae54425025fa5060057342f00a4c7ed9957c0740722e91e32919db553949e38d',
    placedCount: 17,
    unplacedCount: 0,
    maximumAreaMm2: 304_499.84565,
    maximumCanonicalCavities: 0,
    maximumElapsedMs: 120_000
  },
  {
    fixture: 'triangle-20',
    sheet: '600x400',
    collisionIdentitySha256:
      '371db2696b65e2122b98bdb197a1d327df0c6ecbeca6ed73d2722971be52a127',
    fittedCanonicalSha256:
      'b4d1fd9af8a1ecb4a17f1031546c1dbbb5afb19b2d99e41bdb646e52084092f7',
    placedCount: 20,
    unplacedCount: 0,
    maximumAreaMm2: 74_428.143126,
    maximumCanonicalCavities: 0,
    maximumElapsedMs: 120_000
  },
  {
    fixture: 'mixed-61',
    sheet: '600x400',
    collisionIdentitySha256:
      '120f5f1eef64411032d0aee828cb61bc0c5464015397b600f194d63e242f6569',
    fittedCanonicalSha256:
      'b0c0d8395758b62058d29efb9702bff8519fbba028a9d8beb6b46d1492ce9e3d',
    placedCount: 24,
    unplacedCount: 37,
    maximumAreaMm2: 232_800.043098,
    maximumCanonicalCavities: 0,
    maximumElapsedMs: 330_000
  },
  {
    fixture: 'shapes-17',
    sheet: '600x400',
    collisionIdentitySha256:
      '510225fc9dba197e1b56d6f1d3ebd70963b13cdfcb23c567acd14b56653054a8',
    fittedCanonicalSha256:
      'e73b0cfa3f10056aa4bab547c928384300a41e81c35737a98014ecef2956a90f',
    placedCount: 13,
    unplacedCount: 4,
    maximumAreaMm2: 228_616.694352,
    maximumCanonicalCavities: 1,
    maximumElapsedMs: 120_000
  }
]

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}

function runBaseline(baseline: Baseline, outputDirectory: string): Promise<void> {
  const outputPrefix = join(outputDirectory, `${baseline.fixture}-${baseline.sheet}`)
  const arguments_ = [
    'exec',
    'tsx',
    '--tsconfig',
    'tsconfig.node.json',
    'scripts/irregular-compact-baseline.ts',
    '--fixture',
    baseline.fixture,
    '--sheet',
    baseline.sheet,
    '--output-prefix',
    outputPrefix,
    '--strict',
    '--expected-collision-identity-sha256',
    baseline.collisionIdentitySha256,
    '--expected-fitted-canonical-sha256',
    baseline.fittedCanonicalSha256,
    '--expected-placed-count',
    String(baseline.placedCount),
    '--expected-unplaced-count',
    String(baseline.unplacedCount),
    '--maximum-area-mm2',
    String(baseline.maximumAreaMm2),
    '--maximum-canonical-cavities',
    String(baseline.maximumCanonicalCavities),
    '--maximum-elapsed-ms',
    String(baseline.maximumElapsedMs)
  ]

  return new Promise((resolve, reject) => {
    const child = spawn('pnpm', arguments_, { stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(
        new Error(
          `${baseline.fixture} ${baseline.sheet} exited with ${code ?? `signal ${signal}`}`
        )
      )
    })
  })
}

const outputDirectory =
  argument('--output-dir') ?? '/private/tmp/min-plane-provenance/compact-six-baselines'
await mkdir(outputDirectory, { recursive: true })

for (const baseline of BASELINES) {
  await runBaseline(baseline, outputDirectory)
}

const reports = await Promise.all(
  BASELINES.map(async (baseline) =>
    JSON.parse(
      await readFile(join(outputDirectory, `${baseline.fixture}-${baseline.sheet}.json`), 'utf8')
    )
  )
)
await writeFile(
  join(outputDirectory, 'summary.json'),
  `${JSON.stringify({ generatedAt: new Date().toISOString(), reports }, null, 2)}\n`
)
console.log(JSON.stringify({ outputDirectory, baselineCount: BASELINES.length, passed: true }))
