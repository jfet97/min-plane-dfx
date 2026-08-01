#!/usr/bin/env node
/**
 * Builds and runs the P5 aggregate harness inside its pinned Linux amd64 image.
 * This wrapper owns container orchestration and fail-closed host classification.
 * The aggregate benchmark remains implemented only by measure-p5-aggregate.ts.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { cpus, machine, platform, release, totalmem } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const CONTRACT_PATH = resolve(REPOSITORY_ROOT, 'docker/p5-controlled-host.contract.json')
const DOCKERFILE_PATH = resolve(REPOSITORY_ROOT, 'docker/p5-runner.Dockerfile')
const DEFAULT_IMAGE = 'min-plane-dfx-p5-runner:local'
const CONTAINER_PLATFORM = 'linux/amd64'
const CONTAINER_OUTPUT_DIRECTORY = '/output'
const RAW_EVIDENCE_FILE = 'p5-aggregate-evidence.json'
const WRAPPER_PROVENANCE_FILE = 'p5-wrapper-provenance.json'
const GIBIBYTE = 1024 ** 3

const CONTAINER_PROBE_SOURCE = String.raw`
const { execFileSync } = require('node:child_process')
const os = require('node:os')
const output = (command, args) => execFileSync(command, args, { encoding: 'utf8' }).trim()
const rustVerbose = output('rustc', ['-vV'])
const rustRelease = rustVerbose.match(/^release: (.+)$/m)?.[1]
const rustTarget = rustVerbose.match(/^host: (.+)$/m)?.[1]
const rustChannel = rustRelease?.includes('nightly')
  ? 'nightly'
  : rustRelease?.includes('beta')
    ? 'beta'
    : 'stable'
process.stdout.write(JSON.stringify({
  platform: process.platform,
  architecture: os.machine(),
  processArchitecture: process.arch,
  kernelRelease: os.release(),
  hardwareThreads: os.cpus().length,
  memoryGiB: Math.floor(os.totalmem() / (1024 ** 3)),
  toolchain: {
    node: process.version,
    pnpm: output('pnpm', ['--version']),
    rustc: rustRelease,
    rustChannel,
    rustTarget
  }
}))
`

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function commandJson(command, args) {
  return JSON.parse(
    execFileSync(command, args, {
      cwd: REPOSITORY_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit']
    })
  )
}

function commandText(command, args) {
  return execFileSync(command, args, {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit']
  }).trim()
}

function runInherited(command, args) {
  const result = spawnSync(command, args, {
    cwd: REPOSITORY_ROOT,
    stdio: 'inherit'
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with status ${String(result.status)}`)
  }
}

export function parseWrapperArguments(argv) {
  let outputDirectory = resolve(REPOSITORY_ROOT, 'out/p5-linux-container')
  let image = DEFAULT_IMAGE
  let dryRun = false
  let help = false
  const benchmarkArgs = []

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--') continue
    if (argument === '--dry-run') dryRun = true
    else if (argument === '--help' || argument === '-h') help = true
    else if (argument === '--output-dir') {
      const value = argv[index + 1]
      if (value === undefined) throw new Error('--output-dir requires a path')
      outputDirectory = resolve(value)
      index += 1
    } else if (argument === '--image') {
      const value = argv[index + 1]
      if (value === undefined) throw new Error('--image requires a tag')
      image = value
      index += 1
    } else {
      benchmarkArgs.push(argument)
    }
  }

  for (const reserved of ['--controlled-linux', '--output', '--wrapper-provenance']) {
    if (
      benchmarkArgs.some((argument) => argument === reserved || argument.startsWith(`${reserved}=`))
    ) {
      throw new Error(`${reserved} is owned by the P5 Linux container wrapper`)
    }
  }

  return { outputDirectory, image, dryRun, help, benchmarkArgs }
}

function printHelp() {
  console.log(`Usage: pnpm benchmark:p5:linux -- [wrapper options] [aggregate options]

Wrapper options:
  --output-dir PATH   Host directory for raw evidence (default: out/p5-linux-container)
  --image TAG         Local image tag (default: ${DEFAULT_IMAGE})
  --dry-run           Print Docker build and run plans without executing Docker
  --help              Print this help

All other arguments are forwarded to measure-p5-aggregate.ts. The wrapper owns
--controlled-linux, --output, and --wrapper-provenance so callers cannot override
fail-closed classification or evidence paths.`)
}

function optionalCommandText(command, args) {
  try {
    return commandText(command, args)
  } catch {
    return undefined
  }
}

export function createSourceDiffFingerprint(input) {
  const hash = createHash('sha256')
  for (const [label, value] of [
    ['git diff --binary', input.workingTreeDiff],
    ['git diff --cached --binary', input.cachedDiff],
    ['git status --porcelain', input.status]
  ]) {
    hash.update(label).update('\0').update(value).update('\0')
  }
  return hash.digest('hex')
}

function collectSourceHostProvenance() {
  const dirtyOutput = optionalCommandText('git', ['status', '--porcelain'])
  const workingTreeDiff = optionalCommandText('git', ['diff', '--binary'])
  const cachedDiff = optionalCommandText('git', ['diff', '--cached', '--binary'])
  const sourceDiffFingerprintSha256 =
    dirtyOutput === undefined || workingTreeDiff === undefined || cachedDiff === undefined
      ? undefined
      : createSourceDiffFingerprint({
          workingTreeDiff,
          cachedDiff,
          status: dirtyOutput
        })
  return {
    platform: platform(),
    kernelRelease: release(),
    architecture: machine(),
    processArchitecture: process.arch,
    hardwareThreads: cpus().length,
    memoryGiB: Math.floor(totalmem() / GIBIBYTE),
    cpu: cpus()[0]?.model,
    node: process.version,
    commit: optionalCommandText('git', ['rev-parse', 'HEAD']),
    dirty: dirtyOutput === undefined ? undefined : dirtyOutput.length > 0,
    sourceDiffFingerprintSha256,
    exactCommand: [process.execPath, ...process.argv.slice(1)].join(' ')
  }
}

function inspectImage(image) {
  const [inspection] = commandJson('docker', ['image', 'inspect', image])
  if (inspection === undefined) throw new Error(`Docker image ${image} was not found after build`)
  return inspection
}

function probeContainer(image) {
  return commandJson('docker', [
    'run',
    '--rm',
    '--platform',
    CONTAINER_PLATFORM,
    '--entrypoint',
    'node',
    image,
    '-e',
    CONTAINER_PROBE_SOURCE
  ])
}

function dockerProcessArchitecture(architecture) {
  if (architecture === 'amd64' || architecture === 'x86_64') return 'x64'
  if (architecture === 'arm64' || architecture === 'aarch64') return 'arm64'
  return architecture
}

function collectDockerProvenance() {
  const version = commandJson('docker', ['version', '--format', '{{json .}}'])
  const info = commandJson('docker', ['info', '--format', '{{json .}}'])
  return {
    clientVersion: version.Client?.Version ?? 'unknown',
    serverVersion: version.Server?.Version ?? 'unknown',
    context: version.Client?.Context ?? 'unknown',
    operatingSystem: info.OperatingSystem ?? 'unknown',
    name: info.Name ?? 'unknown',
    host: {
      platform: info.OSType,
      kernelRelease: info.KernelVersion,
      architecture: info.Architecture,
      processArchitecture: dockerProcessArchitecture(info.Architecture),
      hardwareThreads: info.NCPU,
      memoryGiB: Math.floor(info.MemTotal / GIBIBYTE)
    }
  }
}

function expectedFields(contract) {
  return [
    ['sourceHost.platform', contract.host.platform],
    ['sourceHost.kernelRelease', contract.host.kernelRelease],
    ['sourceHost.architecture', contract.host.architecture],
    ['sourceHost.processArchitecture', contract.host.processArchitecture],
    ['sourceHost.hardwareThreads', contract.host.hardwareThreads],
    ['sourceHost.memoryGiB', contract.host.memoryGiB],
    ['host.platform', contract.host.platform],
    ['host.kernelRelease', contract.host.kernelRelease],
    ['host.architecture', contract.host.architecture],
    ['host.processArchitecture', contract.host.processArchitecture],
    ['host.hardwareThreads', contract.host.hardwareThreads],
    ['host.memoryGiB', contract.host.memoryGiB],
    ['container.platform', contract.container.platform],
    ['container.kernelRelease', contract.host.kernelRelease],
    ['container.architecture', contract.container.architecture],
    ['container.processArchitecture', contract.container.processArchitecture],
    ['container.hardwareThreads', contract.host.hardwareThreads],
    ['container.memoryGiB', contract.host.memoryGiB],
    ['container.imagePlatform', contract.container.imagePlatform],
    ['container.imageArchitecture', contract.container.imageArchitecture],
    ['docker.operatingSystem', contract.dockerDaemon.operatingSystem],
    ['docker.name', contract.dockerDaemon.name],
    ['toolchain.node', contract.toolchain.node],
    ['toolchain.pnpm', contract.toolchain.pnpm],
    ['toolchain.rustc', contract.toolchain.rustc],
    ['toolchain.rustChannel', contract.toolchain.rustChannel],
    ['toolchain.rustTarget', contract.toolchain.rustTarget]
  ]
}

function fieldValue(value, path) {
  return path.split('.').reduce((current, segment) => current?.[segment], value)
}

function parseBenchmarkSchedule(benchmarkArgs) {
  let suites = ['C5', 'C6', 'C7']
  let rustThreads = [1, 'default']
  let measuredSamples = 3
  let includeWarmups = true
  for (let index = 0; index < benchmarkArgs.length; index += 1) {
    const argument = benchmarkArgs[index]
    if (argument === '--suite') {
      suites = [benchmarkArgs[index + 1]]
      index += 1
    } else if (argument === '--rust-threads') {
      const value = benchmarkArgs[index + 1]
      rustThreads =
        value === 'matrix'
          ? [1, 2, 'default', 8]
          : value === 'default'
            ? ['default']
            : [Number(value)]
      index += 1
    } else if (argument === '--samples') {
      measuredSamples = Number(benchmarkArgs[index + 1])
      index += 1
    } else if (argument === '--skip-warmups') {
      includeWarmups = false
    }
  }
  return { suites, rustThreads, measuredSamples, includeWarmups }
}

function benchmarkScheduleMismatches(benchmarkArgs) {
  const actual = parseBenchmarkSchedule(benchmarkArgs)
  const expected = {
    suites: ['C5', 'C6', 'C7'],
    rustThreads: [1, 'default'],
    measuredSamples: 3,
    includeWarmups: true
  }
  return Object.entries(expected).flatMap(([field, expectedValue]) =>
    JSON.stringify(actual[field]) === JSON.stringify(expectedValue)
      ? []
      : [{ field: `benchmark.${field}`, expected: expectedValue, actual: actual[field] }]
  )
}

export function classifyControlledHost(contract, provenance, benchmarkArgs = []) {
  const controlledHostMismatches = expectedFields(contract).flatMap(([field, expected]) => {
    const actual = fieldValue(provenance, field)
    return Object.is(actual, expected) ? [] : [{ field, expected, actual }]
  })
  const sourceTreeMismatches =
    provenance.sourceHost.dirty === false
      ? []
      : [{ field: 'sourceHost.dirty', expected: false, actual: provenance.sourceHost.dirty }]
  const scheduleMismatches = benchmarkScheduleMismatches(benchmarkArgs)
  const mismatches = [...controlledHostMismatches, ...sourceTreeMismatches, ...scheduleMismatches]
  const reasons = []
  const sourceHostIsLinuxArm64 =
    provenance.sourceHost.platform === 'linux' &&
    (provenance.sourceHost.architecture === 'aarch64' ||
      provenance.sourceHost.processArchitecture === 'arm64')
  const dockerHostIsLinuxArm64 =
    provenance.host.platform === 'linux' &&
    (provenance.host.architecture === 'aarch64' || provenance.host.processArchitecture === 'arm64')
  const hostIsLinuxArm64 = sourceHostIsLinuxArm64 || dockerHostIsLinuxArm64
  if (hostIsLinuxArm64) reasons.push('local-linux-arm64')
  if (
    hostIsLinuxArm64 &&
    provenance.container.architecture === 'x86_64' &&
    provenance.container.processArchitecture === 'x64'
  ) {
    reasons.push('linux-amd64-emulated-on-arm64')
  }
  if (controlledHostMismatches.length > 0 && reasons.length === 0) {
    reasons.push('controlled-host-contract-mismatch')
  }
  if (provenance.sourceHost.dirty === true) {
    reasons.push('dirty-source-tree')
  } else if (provenance.sourceHost.dirty !== false) {
    reasons.push('unknown-source-tree-state')
  }
  if (scheduleMismatches.length > 0) {
    reasons.push('non-authoritative-benchmark-schedule')
  }
  const authoritative = mismatches.length === 0 && reasons.length === 0
  return {
    authoritative,
    status: authoritative ? 'available' : 'blocked',
    controlledLinux: authoritative,
    reasons,
    mismatches
  }
}

export function buildAggregateContainerArgs(input) {
  const scheduleIsAuthoritative = benchmarkScheduleMismatches(input.benchmarkArgs).length === 0
  return [
    '--output',
    input.outputPath,
    '--wrapper-provenance',
    input.provenancePath,
    ...input.benchmarkArgs,
    ...(input.classification.controlledLinux && scheduleIsAuthoritative
      ? ['--controlled-linux']
      : [])
  ]
}

function buildRunnerProvenance(image) {
  const containerProbe = probeContainer(image)
  const imageInspection = inspectImage(image)
  const docker = collectDockerProvenance()
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sourceHost: collectSourceHostProvenance(),
    host: docker.host,
    container: {
      platform: containerProbe.platform,
      architecture: containerProbe.architecture,
      processArchitecture: containerProbe.processArchitecture,
      kernelRelease: containerProbe.kernelRelease,
      hardwareThreads: containerProbe.hardwareThreads,
      memoryGiB: containerProbe.memoryGiB,
      imagePlatform: imageInspection.Os,
      imageArchitecture: imageInspection.Architecture,
      imageId: imageInspection.Id,
      repoDigests: imageInspection.RepoDigests ?? [],
      created: imageInspection.Created
    },
    toolchain: containerProbe.toolchain,
    docker
  }
}

function dockerBuildArgs(image) {
  return [
    'build',
    '--file',
    DOCKERFILE_PATH,
    '--platform',
    CONTAINER_PLATFORM,
    '--tag',
    image,
    REPOSITORY_ROOT
  ]
}

function dockerRunArgs(image, outputDirectory, aggregateArgs) {
  const args = [
    'run',
    '--rm',
    '--platform',
    CONTAINER_PLATFORM,
    '--volume',
    `${outputDirectory}:${CONTAINER_OUTPUT_DIRECTORY}`,
    '--env',
    'HOME=/tmp'
  ]
  if (typeof process.getuid === 'function' && typeof process.getgid === 'function') {
    args.push('--user', `${String(process.getuid())}:${String(process.getgid())}`)
  }
  return [...args, image, ...aggregateArgs]
}

function main() {
  const args = parseWrapperArguments(process.argv.slice(2))
  if (args.help) {
    printHelp()
    return
  }

  const contract = readJson(CONTRACT_PATH)
  const buildArgs = dockerBuildArgs(args.image)
  const containerEvidencePath = join(CONTAINER_OUTPUT_DIRECTORY, RAW_EVIDENCE_FILE)
  const containerProvenancePath = join(CONTAINER_OUTPUT_DIRECTORY, WRAPPER_PROVENANCE_FILE)
  const dryRunClassification = {
    authoritative: false,
    status: 'blocked',
    controlledLinux: false,
    reasons: ['dry-run-no-host-probe'],
    mismatches: []
  }
  const dryRunAggregateArgs = buildAggregateContainerArgs({
    classification: dryRunClassification,
    outputPath: containerEvidencePath,
    provenancePath: containerProvenancePath,
    benchmarkArgs: args.benchmarkArgs
  })

  if (args.dryRun) {
    console.log(
      JSON.stringify(
        {
          status: 'dry-run',
          contractPath: CONTRACT_PATH,
          contract,
          outputDirectory: args.outputDirectory,
          dockerBuild: ['docker', ...buildArgs],
          dockerRun: [
            'docker',
            ...dockerRunArgs(args.image, args.outputDirectory, dryRunAggregateArgs)
          ],
          controlledLinuxForwarded: false
        },
        null,
        2
      )
    )
    return
  }

  mkdirSync(args.outputDirectory, { recursive: true })
  runInherited('docker', buildArgs)

  const provenance = buildRunnerProvenance(args.image)
  const classification = classifyControlledHost(contract, provenance, args.benchmarkArgs)
  const wrapperEvidence = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    contractPath: 'docker/p5-controlled-host.contract.json',
    contract,
    provenance,
    classification,
    invocation: {
      image: args.image,
      containerPlatform: CONTAINER_PLATFORM,
      dockerfile: 'docker/p5-runner.Dockerfile',
      benchmarkArgs: args.benchmarkArgs
    }
  }
  const hostProvenancePath = join(args.outputDirectory, WRAPPER_PROVENANCE_FILE)
  writeFileSync(hostProvenancePath, `${JSON.stringify(wrapperEvidence, null, 2)}\n`, 'utf8')

  const aggregateArgs = buildAggregateContainerArgs({
    classification,
    outputPath: containerEvidencePath,
    provenancePath: containerProvenancePath,
    benchmarkArgs: args.benchmarkArgs
  })
  console.log(
    `[p5-linux-container] classification=${classification.status} authoritative=${String(classification.authoritative)}`
  )
  if (!classification.authoritative) {
    console.error(`[p5-linux-container] blocked reasons: ${classification.reasons.join(', ')}`)
  }
  runInherited('docker', dockerRunArgs(args.image, args.outputDirectory, aggregateArgs))
  console.log(`[p5-linux-container] raw evidence: ${join(args.outputDirectory, RAW_EVIDENCE_FILE)}`)
  console.log(`[p5-linux-container] wrapper provenance: ${hostProvenancePath}`)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    console.error(
      `[p5-linux-container] FAILED: ${error instanceof Error ? error.message : String(error)}`
    )
    process.exitCode = 1
  }
}
