import assert from 'node:assert/strict'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const VERIFIER_PATH = resolve(REPOSITORY_ROOT, 'scripts/verify-packaged-native-load.mjs')
const UPSTREAM_CLIPPER_LICENSE = readFileSync(
  resolve(REPOSITORY_ROOT, 'node_modules/clipper2-ts/LICENSE')
)
const NATIVE_PACKAGE_NOTICE = readFileSync(
  resolve(REPOSITORY_ROOT, 'crates/irregular-nesting-native/NOTICE')
)

function makeFakeElectron(tempDirectory) {
  const executable = resolve(tempDirectory, 'packaged-electron.mjs')
  writeFileSync(
    executable,
    `#!/usr/bin/env node
import { writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
writeFileSync(process.env.FAKE_ELECTRON_REPORT, JSON.stringify({ argv: process.argv.slice(2), appAsar: process.env.MIN_PLANE_PACKAGED_APP_ASAR }))
const child = spawnSync(process.execPath, process.argv.slice(2), { encoding: 'utf8', env: process.env })
process.stdout.write(child.stdout ?? '')
process.stderr.write(child.stderr ?? '')
process.exitCode = child.status ?? 1
`
  )
  chmodSync(executable, 0o755)
  return executable
}

function makePackagedApp(
  tempDirectory,
  capability,
  licenseBytes = UPSTREAM_CLIPPER_LICENSE,
  noticeBytes = NATIVE_PACKAGE_NOTICE
) {
  const appAsar = resolve(tempDirectory, 'app.asar')
  const packageRoot = resolve(appAsar, 'node_modules/irregular-nesting-native')
  mkdirSync(resolve(packageRoot, 'npm'), { recursive: true })
  mkdirSync(resolve(packageRoot, 'LICENSES'), { recursive: true })
  writeFileSync(resolve(appAsar, 'package.json'), JSON.stringify({ private: true }))
  writeFileSync(
    resolve(packageRoot, 'package.json'),
    JSON.stringify({ name: 'irregular-nesting-native', main: 'npm/index.cjs' })
  )
  writeFileSync(
    resolve(packageRoot, 'npm/index.cjs'),
    `'use strict'\nmodule.exports = { nativeCapability: () => (${JSON.stringify(capability)}) }\n`
  )
  const artifactLegalDirectory = resolve(tempDirectory, 'LICENSES/irregular-nesting-native')
  if (licenseBytes !== null) {
    writeFileSync(resolve(packageRoot, 'LICENSES/clipper2-ts-BSL-1.0.txt'), licenseBytes)
    mkdirSync(resolve(artifactLegalDirectory, 'LICENSES'), { recursive: true })
    writeFileSync(resolve(artifactLegalDirectory, 'LICENSES/clipper2-ts-BSL-1.0.txt'), licenseBytes)
  }
  if (noticeBytes !== null) {
    writeFileSync(resolve(packageRoot, 'NOTICE'), noticeBytes)
    mkdirSync(artifactLegalDirectory, { recursive: true })
    writeFileSync(resolve(artifactLegalDirectory, 'NOTICE'), noticeBytes)
  }
  return appAsar
}

function makePackagedAppWithAncestorFallback(tempDirectory, capability) {
  const appAsar = resolve(tempDirectory, 'release/app.asar')
  const packagedLegalRoot = resolve(appAsar, 'node_modules/irregular-nesting-native')
  const fallbackRoot = resolve(tempDirectory, 'node_modules/irregular-nesting-native')

  mkdirSync(resolve(packagedLegalRoot, 'LICENSES'), { recursive: true })
  mkdirSync(resolve(fallbackRoot, 'npm'), { recursive: true })
  writeFileSync(resolve(appAsar, 'package.json'), JSON.stringify({ private: true }))
  writeFileSync(
    resolve(fallbackRoot, 'package.json'),
    JSON.stringify({ name: 'irregular-nesting-native', main: 'npm/index.cjs' })
  )
  writeFileSync(
    resolve(fallbackRoot, 'npm/index.cjs'),
    `'use strict'\nmodule.exports = { nativeCapability: () => (${JSON.stringify(capability)}) }\n`
  )
  mkdirSync(resolve(fallbackRoot, 'LICENSES'), { recursive: true })
  writeFileSync(resolve(fallbackRoot, 'LICENSES/clipper2-ts-BSL-1.0.txt'), UPSTREAM_CLIPPER_LICENSE)
  writeFileSync(resolve(fallbackRoot, 'NOTICE'), NATIVE_PACKAGE_NOTICE)
  writeFileSync(
    resolve(packagedLegalRoot, 'LICENSES/clipper2-ts-BSL-1.0.txt'),
    UPSTREAM_CLIPPER_LICENSE
  )
  writeFileSync(resolve(packagedLegalRoot, 'NOTICE'), NATIVE_PACKAGE_NOTICE)

  const artifactLegalDirectory = resolve(tempDirectory, 'release/LICENSES/irregular-nesting-native')
  mkdirSync(resolve(artifactLegalDirectory, 'LICENSES'), { recursive: true })
  writeFileSync(
    resolve(artifactLegalDirectory, 'LICENSES/clipper2-ts-BSL-1.0.txt'),
    UPSTREAM_CLIPPER_LICENSE
  )
  writeFileSync(resolve(artifactLegalDirectory, 'NOTICE'), NATIVE_PACKAGE_NOTICE)
  return appAsar
}

function runVerifier(
  capability,
  licenseBytes = UPSTREAM_CLIPPER_LICENSE,
  noticeBytes = NATIVE_PACKAGE_NOTICE,
  relativePaths = false
) {
  const tempDirectory = mkdtempSync(resolve(tmpdir(), 'min-plane-packaged-native-'))
  const appAsar = makePackagedApp(tempDirectory, capability, licenseBytes, noticeBytes)
  const reportPath = resolve(tempDirectory, 'electron-report.json')
  const electronExecutable = makeFakeElectron(tempDirectory)
  const verifierElectronExecutable = relativePaths
    ? `./${relative(tempDirectory, electronExecutable)}`
    : electronExecutable
  const verifierAppAsar = relativePaths ? relative(tempDirectory, appAsar) : appAsar
  const result = spawnSync(
    process.execPath,
    [VERIFIER_PATH, '--electron', verifierElectronExecutable, '--app-asar', verifierAppAsar],
    {
      cwd: tempDirectory,
      encoding: 'utf8',
      env: {
        ...process.env,
        FAKE_ELECTRON_REPORT: reportPath
      }
    }
  )
  return { appAsar, reportPath, result, tempDirectory }
}

const VALID_CAPABILITY = {
  apiVersion: 3,
  crateVersion: '0.1.0',
  targetTriple: 'aarch64-apple-darwin',
  profiles: ['compact', 'compact-short-side']
}

test('runs the packaged Electron executable as Node against the packaged app path', (context) => {
  const { appAsar, reportPath, result, tempDirectory } = runVerifier(VALID_CAPABILITY)
  context.after(() => rmSync(tempDirectory, { force: true, recursive: true }))

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /packaged native addon and Clipper2 license loaded/)
  const report = JSON.parse(readFileSync(reportPath, 'utf8'))
  assert.equal(report.appAsar, appAsar)
  assert.equal(report.argv.length, 1)
  assert.match(report.argv[0], /min-plane-packaged-native-loader-.*\.cjs$/)
  assert.doesNotMatch(report.argv[0], /min-plane-dfx/)
})

test('rejects a native package resolved outside the packaged app', (context) => {
  const tempDirectory = mkdtempSync(resolve(tmpdir(), 'min-plane-packaged-native-fallback-'))
  const appAsar = makePackagedAppWithAncestorFallback(tempDirectory, VALID_CAPABILITY)
  const electronExecutable = makeFakeElectron(tempDirectory)
  const result = spawnSync(
    process.execPath,
    [VERIFIER_PATH, '--electron', electronExecutable, '--app-asar', appAsar],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        FAKE_ELECTRON_REPORT: resolve(tempDirectory, 'electron-report.json')
      }
    }
  )
  context.after(() => rmSync(tempDirectory, { force: true, recursive: true }))

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /resolved outside packaged app\.asar/)
})

test('resolves relative packaged paths before launching Electron', (context) => {
  const { appAsar, reportPath, result, tempDirectory } = runVerifier(
    VALID_CAPABILITY,
    UPSTREAM_CLIPPER_LICENSE,
    NATIVE_PACKAGE_NOTICE,
    true
  )
  context.after(() => rmSync(tempDirectory, { force: true, recursive: true }))

  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(readFileSync(reportPath, 'utf8'))
  assert.equal(realpathSync(report.appAsar), realpathSync(appAsar))
})

test('fails the packaged verifier when nativeCapability is malformed', (context) => {
  const { result, tempDirectory } = runVerifier({ apiVersion: '3' })
  context.after(() => rmSync(tempDirectory, { force: true, recursive: true }))

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /nativeCapability\(\) returned an invalid payload/)
})

test('fails the packaged verifier when the Clipper2 license is absent', (context) => {
  const { result, tempDirectory } = runVerifier(VALID_CAPABILITY, null)
  context.after(() => rmSync(tempDirectory, { force: true, recursive: true }))

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /clipper2-ts-BSL-1\.0\.txt/)
})

test('fails the packaged verifier when the Clipper2 license bytes changed', (context) => {
  const { result, tempDirectory } = runVerifier(VALID_CAPABILITY, Buffer.from('changed license'))
  context.after(() => rmSync(tempDirectory, { force: true, recursive: true }))

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /packaged Clipper2 license SHA-256 mismatch/)
})

test('fails the packaged verifier when the native NOTICE is absent', (context) => {
  const { result, tempDirectory } = runVerifier(VALID_CAPABILITY, UPSTREAM_CLIPPER_LICENSE, null)
  context.after(() => rmSync(tempDirectory, { force: true, recursive: true }))

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /NOTICE/)
})

test('fails the packaged verifier when the native NOTICE bytes changed', (context) => {
  const { result, tempDirectory } = runVerifier(
    VALID_CAPABILITY,
    UPSTREAM_CLIPPER_LICENSE,
    Buffer.from('changed notice')
  )
  context.after(() => rmSync(tempDirectory, { force: true, recursive: true }))

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /packaged native NOTICE SHA-256 mismatch/)
})
