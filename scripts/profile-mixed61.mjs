import { spawnSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const runId = `${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}-${process.pid}`
const outputRoot =
  process.env.IRREGULAR_PROFILE_OUTPUT_ROOT ?? join(tmpdir(), 'min-plane-provenance')
const outputDirectory = join(outputRoot, `mixed61-profile-${runId}`)
const outputPrefix = join(outputDirectory, 'mixed-61-2000x2700')
const profilePath = join(outputDirectory, 'mixed-61.cpuprofile')
const analysisPath = join(outputDirectory, 'analysis.txt')

await mkdir(outputDirectory, { recursive: true })
await captureSourceState(outputDirectory)

const baseline = run(process.execPath, [
  '--cpu-prof',
  `--cpu-prof-dir=${outputDirectory}`,
  '--cpu-prof-name=mixed-61.cpuprofile',
  '--import',
  'tsx',
  'scripts/irregular-compact-baseline.ts',
  '--fixture',
  'mixed-61',
  '--sheet',
  '2000x2700',
  '--output-prefix',
  outputPrefix,
  '--strict',
  '--expected-collision-identity-sha256',
  '3839e80d26be257381f1962816765a886d4b7e3c3d78120892e4a6a943dfa742',
  '--expected-fitted-canonical-sha256',
  'ef2b783ae12491d2a80a12ef94d1bb2801c13cbd43aeb6e2c1cc00d86828fd3b',
  '--expected-placed-count',
  '61',
  '--expected-unplaced-count',
  '0',
  '--maximum-area-mm2',
  '391605.850174',
  '--maximum-canonical-cavities',
  '0',
  '--maximum-elapsed-ms',
  '330000',
  '--expected-focused-status',
  'evaluation-cap',
  '--expected-focused-evaluations',
  '12000',
  '--expected-focused-source-hash',
  '3839e80d26be257381f1962816765a886d4b7e3c3d78120892e4a6a943dfa742',
  '--expected-focused-candidate-hash',
  'none',
  '--expected-focused-selected-hash',
  '3839e80d26be257381f1962816765a886d4b7e3c3d78120892e4a6a943dfa742',
  '--expected-focused-influence',
  'protected-fallback'
])
if (baseline.status !== 0) process.exit(baseline.status ?? 1)

const analysis = run(process.execPath, [
  '--import',
  'tsx',
  'scripts/analyze-cpu-profile.ts',
  '--profile',
  profilePath,
  '--top',
  '40'
])
if (analysis.status !== 0) process.exit(analysis.status ?? 1)

await writeFile(analysisPath, analysis.stdout ?? '')
process.stdout.write(`\nArtifacts: ${outputDirectory}\n`)

function run(command, arguments_) {
  const result = spawnSync(command, arguments_, {
    cwd: process.cwd(),
    env: { ...process.env, TSX_TSCONFIG_PATH: 'tsconfig.node.json' },
    encoding: 'utf8'
  })
  if (result.error !== undefined) throw result.error
  if (result.stdout !== undefined) process.stdout.write(result.stdout)
  if (result.stderr !== undefined) process.stderr.write(result.stderr)
  return result
}

async function captureSourceState(directory) {
  const commit = git(['rev-parse', 'HEAD'])
  const status = git(['status', '--short'])
  const diff = git(['diff', '--binary', 'HEAD'])
  await Promise.all([
    writeFile(join(directory, 'git-commit.txt'), commit),
    writeFile(join(directory, 'git-status.txt'), status),
    writeFile(join(directory, 'source.diff'), diff)
  ])
}

function git(arguments_) {
  const result = spawnSync('git', arguments_, { cwd: process.cwd(), encoding: 'utf8' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${arguments_.join(' ')} exited with ${result.status}`)
  }
  return result.stdout
}
