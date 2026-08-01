import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { stageNativePackageForElectron } from './stage-native-package-for-electron.mjs'

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function readJson(relativePath) {
  return JSON.parse(readFileSync(resolve(REPOSITORY_ROOT, relativePath), 'utf8'))
}

function readText(relativePath) {
  return readFileSync(resolve(REPOSITORY_ROOT, relativePath), 'utf8')
}

function listFiles(root) {
  const files = []
  const visit = (directory) => {
    for (const entry of readdirSync(directory).sort()) {
      const path = join(directory, entry)
      if (statSync(path).isDirectory()) visit(path)
      else files.push(relative(root, path))
    }
  }
  visit(root)
  return files
}

test('declares the native workspace package as a production dependency', () => {
  const rootPackage = readJson('package.json')
  assert.equal(rootPackage.dependencies['irregular-nesting-native'], 'workspace:*')
})

test('exposes the Node packaging contract suite through the root scripts', () => {
  const rootPackage = readJson('package.json')
  assert.equal(
    rootPackage.scripts['test:native:package'],
    'node --test crates/irregular-nesting-native/scripts/build-native.test.mjs scripts/verify-native-license-compliance.test.mjs scripts/verify-native-package-layout.test.mjs scripts/verify-packaged-native-load.test.mjs'
  )
})

test('publishes the loader, target binaries, and notices from the native package', () => {
  const nativePackage = readJson('crates/irregular-nesting-native/package.json')
  assert.equal(nativePackage.main, 'npm/index.cjs')
  assert.equal(nativePackage.exports, './npm/index.cjs')
  assert.deepEqual(nativePackage.files, [
    'npm/index.cjs',
    'npm/target.cjs',
    'npm/*.node',
    'NOTICE',
    'LICENSES/**'
  ])
})

test('includes a distributable native package notice', () => {
  const result = spawnSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: resolve(REPOSITORY_ROOT, 'crates/irregular-nesting-native'),
    encoding: 'utf8'
  })

  assert.equal(result.status, 0, result.stderr)
  const [packageReport] = JSON.parse(result.stdout)
  assert.ok(packageReport.files.some(({ path }) => path === 'NOTICE'))
})

test('loads the addon by package name without checkout-relative fallbacks', () => {
  const loader = readText('src/workers/irregular/native/loadNativeBackend.ts')
  assert.match(loader, /require\('irregular-nesting-native'\)/)
  assert.doesNotMatch(loader, /crates[\\/]irregular-nesting-native/)

  const workerBuild = readText('vite.worker.config.ts')
  assert.match(workerBuild, /'irregular-nesting-native'/)
})

test('keeps native package loader failures independent from checkout paths', () => {
  const packageLoader = readText('crates/irregular-nesting-native/npm/index.cjs')
  assert.doesNotMatch(packageLoader, /crates[\\/]irregular-nesting-native/)
})

test('stages only distributable native package files before Electron packaging', () => {
  const rootPackage = readJson('package.json')
  assert.equal(
    rootPackage.scripts['package:native:electron'],
    'node scripts/package-electron-with-native.mjs'
  )

  const stagingScript = readText('scripts/stage-native-package-for-electron.mjs')
  for (const packagedPath of [
    'package.json',
    'NOTICE',
    'npm/index.cjs',
    'npm/target.cjs',
    'LICENSES'
  ]) {
    assert.match(stagingScript, new RegExp(packagedPath.replaceAll('/', '\\/')))
  }
  assert.match(stagingScript, /endsWith\('\.node'\)/)
  assert.doesNotMatch(stagingScript, /cpSync\(sourceRoot, destinationRoot/)

  const packagingWrapper = readText('scripts/package-electron-with-native.mjs')
  assert.match(packagingWrapper, /renameSync\(WORKSPACE_PACKAGE, WORKSPACE_PACKAGE_BACKUP\)/)
  assert.match(packagingWrapper, /spawnSync\(process\.execPath, \[electronBuilderCli/)
  assert.doesNotMatch(packagingWrapper, /pnpm\.cmd/)
  assert.match(packagingWrapper, /finally \{/)
  assert.match(packagingWrapper, /renameSync\(WORKSPACE_PACKAGE_BACKUP, WORKSPACE_PACKAGE\)/)

  const electronBuilder = readText('electron-builder.yml')
  assert.match(electronBuilder, /node_modules\/irregular-nesting-native\/npm\/\*\.node/)
  assert.match(electronBuilder, /node_modules\/better-sqlite3\/build\/Release\/\*\.node/)
  assert.doesNotMatch(electronBuilder, /\*\*\/\*\.node/)
})

test('staged Electron package contains no Rust workspace or target files', (context) => {
  const temporaryDirectory = mkdtempSync(resolve(tmpdir(), 'min-plane-native-stage-'))
  const destinationRoot = resolve(temporaryDirectory, 'irregular-nesting-native')
  context.after(() => rmSync(temporaryDirectory, { force: true, recursive: true }))

  const addonFiles = stageNativePackageForElectron(
    resolve(REPOSITORY_ROOT, 'crates/irregular-nesting-native'),
    destinationRoot
  )
  assert.deepEqual(
    listFiles(destinationRoot),
    [
      'LICENSES/clipper2-ts-BSL-1.0.txt',
      'NOTICE',
      'npm/index.cjs',
      ...addonFiles.map((fileName) => `npm/${fileName}`),
      'npm/target.cjs',
      'package.json'
    ].sort()
  )
})

test('requires the real addon integration and package contract suites in native CI', () => {
  const workflow = readText('.github/workflows/rust-native.yml')
  assert.match(workflow, /MIN_PLANE_REQUIRE_NATIVE_ADDON:\s*['"]1['"]/)
  assert.match(workflow, /tests\/unit\/nativeIrregularBackend\.test\.ts/)
  assert.match(workflow, /^\s*- run: pnpm test:native:package$/m)
  assert.ok(
    workflow.indexOf('build-native.mjs --release') < workflow.indexOf('pnpm test:native:package'),
    'native package contracts must run after the staged addon exists'
  )
})

test('requires packaged native loading on every supported native runner', () => {
  const workflow = readText('.github/workflows/rust-native.yml')
  assert.match(workflow, /packaged-native-load/)
  for (const runner of ['ubuntu-24.04', 'windows-latest', 'macos-15', 'macos-15-intel']) {
    assert.match(workflow, new RegExp(`^\\s*runner: ${runner}$`, 'm'))
  }
  for (const target of [
    'x86_64-unknown-linux-gnu',
    'x86_64-pc-windows-msvc',
    'aarch64-apple-darwin',
    'x86_64-apple-darwin'
  ]) {
    assert.match(workflow, new RegExp(target))
  }
  assert.match(workflow, /scripts\/verify-packaged-native-load\.mjs/)

  const packagedJob = workflow.slice(workflow.indexOf('  packaged-native-load:'))
  assert.match(packagedJob, /^\s*- run: pnpm native:electron$/m)
  assert.match(
    packagedJob,
    /^\s*run: pnpm package:native:electron --publish=never --dir --\$\{\{ matrix\.electron_target \}\}$/m
  )
})

test('runs the full strict differential matrix only on scheduled and manual CI', () => {
  const workflow = readText('.github/workflows/rust-native.yml')
  assert.match(workflow, /^\s*schedule:/m)
  assert.match(workflow, /^\s*workflow_dispatch:/m)
  assert.match(workflow, /differential-full/)
  const fullStrictJob = workflow.slice(
    workflow.indexOf('  differential-full:'),
    workflow.indexOf('  thread-equality:')
  )
  assert.match(fullStrictJob, /differential-fixture-matrix\.ts --strict-exploratory --strict-exact/)
  assert.match(workflow, /differential-required/)
  assert.match(workflow, /pnpm test:differential/)
})

test('keeps exact differential output visible while making quality acceptance blocking', () => {
  const rootPackage = readJson('package.json')
  assert.equal(
    rootPackage.scripts['test:differential'],
    'tsx --tsconfig tsconfig.node.json scripts/rust-parity/differential-fixture-matrix.ts --required-only'
  )
  assert.equal(
    rootPackage.scripts['test:differential:exact'],
    'tsx --tsconfig tsconfig.node.json scripts/rust-parity/differential-fixture-matrix.ts --required-only --strict-exact'
  )

  const differential = readText('scripts/rust-parity/run-differential.ts')
  assert.match(differential, /const diagnostic = process\.argv\.includes\('--diagnostic'\)/)
  assert.match(differential, /diagnostic divergence accepted for quality evaluation/)
  assert.match(differential, /FIRST DIVERGENCE at path/)
  assert.match(differential, /if \(!tsOutcome\.ok \|\| !rustOutcome\.ok\)/)

  const matrix = readText('scripts/rust-parity/differential-fixture-matrix.ts')
  assert.match(matrix, /const differentialFlags = strictExact \? \[\] : \['--diagnostic'\]/)
  assert.match(matrix, /\.\.\.row\.args,\s+\.\.\.differentialFlags/)

  const workflow = readText('.github/workflows/rust-native.yml')
  const qualityJob = workflow.slice(workflow.indexOf('  quality-acceptance:'))
  assert.match(
    qualityJob,
    /if: github\.event_name == 'pull_request' \|\| github\.event_name == 'schedule' \|\| github\.event_name == 'workflow_dispatch'/
  )
  assert.ok(
    qualityJob.indexOf('build-native.mjs --release') <
      qualityJob.indexOf('pnpm gate:quality-acceptance'),
    'quality acceptance must run after the release addon build'
  )
  assert.match(workflow, /dump-js-hypot\.ts --check/)
  assert.match(workflow, /pnpm test:differential/)
})

test('surfaces accepted diagnostic divergence from successful differential rows', () => {
  const matrix = readText('scripts/rust-parity/differential-fixture-matrix.ts')
  assert.match(matrix, /spawnSync\(/)
  assert.match(matrix, /result\.stdout[\s\S]*?result\.stderr/)
  assert.match(matrix, /diagnostic divergence accepted for quality evaluation/)
  assert.match(matrix, /if \(result\.ok && hasDiagnosticDivergence\(result\.output\)\)/)
})

test('characterizes standard hypot on every packaged native target', () => {
  const workflow = readText('.github/workflows/rust-native.yml')
  const packagedJob = workflow.slice(workflow.indexOf('  packaged-native-load:'))
  assert.match(
    packagedJob,
    /cargo test --release --manifest-path "\$CRATE_MANIFEST" --target "\$\{\{ matrix\.cargo_target \}\}" --test js_hypot_vectors -- --nocapture/
  )
  assert.ok(
    packagedJob.indexOf('test js_hypot_vectors') <
      packagedJob.indexOf('Build the matrix target addon'),
    'hypot characterization must run before the packaged addon build'
  )
})

test('packages the fail-closed P5 Linux container runner and controlled-host contract', () => {
  const rootPackage = readJson('package.json')
  assert.equal(
    rootPackage.scripts['benchmark:p5:linux'],
    'node scripts/rust-parity/run-p5-linux-container.mjs'
  )

  const contract = readJson('docker/p5-controlled-host.contract.json')
  assert.deepEqual(contract, {
    schemaVersion: 1,
    host: {
      platform: 'linux',
      kernelRelease: '6.18.38',
      architecture: 'x86_64',
      processArchitecture: 'x64',
      hardwareThreads: 16,
      memoryGiB: 125
    },
    container: {
      platform: 'linux',
      architecture: 'x86_64',
      processArchitecture: 'x64',
      imagePlatform: 'linux',
      imageArchitecture: 'amd64'
    },
    dockerDaemon: {
      operatingSystem: 'NixOS',
      name: 't3vm'
    },
    toolchain: {
      node: 'v24.18.0',
      pnpm: '11.11.0',
      rustc: '1.97.1',
      rustChannel: 'stable',
      rustTarget: 'x86_64-unknown-linux-gnu'
    }
  })

  const dockerfile = readText('docker/p5-runner.Dockerfile')
  assert.match(dockerfile, /FROM node:24\.18\.0-bookworm-slim/)
  assert.match(dockerfile, /PNPM_VERSION=11\.11\.0/)
  assert.match(dockerfile, /RUST_VERSION=1\.97\.1/)
  assert.match(dockerfile, /pnpm build:native/)
  assert.match(
    dockerfile,
    /ENTRYPOINT \["pnpm", "exec", "tsx", "--tsconfig", "tsconfig\.node\.json", "scripts\/rust-parity\/measure-p5-aggregate\.ts"\]/
  )

  const runner = readText('scripts/rust-parity/run-p5-linux-container.mjs')
  assert.match(runner, /p5-controlled-host\.contract\.json/)
  assert.match(runner, /function dockerBuildArgs[\s\S]*?'build'/)
  assert.match(runner, /function dockerRunArgs[\s\S]*?'run'/)
  assert.match(runner, /runInherited\('docker', buildArgs\)/)
  assert.match(runner, /runInherited\('docker', dockerRunArgs/)
  assert.match(runner, /p5-wrapper-provenance\.json/)
  assert.match(runner, /p5-aggregate-evidence\.json/)
  assert.doesNotMatch(runner, /runSuiteOnce|P5_THRESHOLDS|computeIrregularNesting/)

  const dockerIgnore = readText('.dockerignore')
  for (const excluded of ['.git', 'node_modules', 'out', 'target']) {
    assert.match(dockerIgnore, new RegExp(`^${excluded.replace('.', '\\.')}`, 'm'))
  }
})
