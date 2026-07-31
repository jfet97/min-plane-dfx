#!/usr/bin/env node
/**
 * Verifies the native addon from an Electron-builder app without resolving any
 * source-tree paths. It starts the packaged Electron executable as Node and
 * loads the addon through the package entry point inside app.asar.
 *
 * Usage:
 *   node scripts/verify-packaged-native-load.mjs --electron <path> --app-asar <path>
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const EXPECTED_CLIPPER2_LICENSE_SHA256 =
  'ea056d2c64294936b226f7360c265e77c52adc4ba171ee61029357f101f439cf'
const EXPECTED_NATIVE_NOTICE_SHA256 =
  '1fa11aadfd5f98d734cbaced1fa10d525fd85565c560044734db4ce752037c1d'

function parseArgs(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--electron' || argument === '--app-asar') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`missing value for ${argument}`)
      }
      values.set(argument, value)
      index += 1
      continue
    }
    throw new Error(`unknown argument "${argument}"`)
  }

  const electronExecutable = values.get('--electron')
  const appAsar = values.get('--app-asar')
  if (electronExecutable === undefined || appAsar === undefined) {
    throw new Error('usage: --electron <path> --app-asar <path> are required')
  }
  return { electronExecutable, appAsar }
}

function assertPathExists(path, description) {
  if (!existsSync(path)) {
    throw new Error(`${description} does not exist: ${path}`)
  }
}

function writeLoaderScript(directory) {
  const loaderPath = join(directory, 'load-packaged-native.cjs')
  writeFileSync(
    loaderPath,
    `'use strict'
const { createHash } = require('node:crypto')
const { readFileSync, realpathSync } = require('node:fs')
const { createRequire } = require('node:module')
const { dirname, join, relative, resolve } = require('node:path')
const appAsar = process.env.MIN_PLANE_PACKAGED_APP_ASAR
if (typeof appAsar !== 'string' || appAsar.length === 0) {
  throw new Error('MIN_PLANE_PACKAGED_APP_ASAR is required')
}
const requireFromPackagedApp = createRequire(join(appAsar, 'package.json'))
const addonEntry = requireFromPackagedApp.resolve('irregular-nesting-native')
const addon = requireFromPackagedApp(addonEntry)
const packageRoot = resolve(dirname(addonEntry), '..')
const expectedPackageRoot = resolve(
  realpathSync(appAsar),
  'node_modules',
  'irregular-nesting-native'
)
if (relative(expectedPackageRoot, packageRoot) !== '') {
  throw new Error(
    'irregular-nesting-native resolved outside packaged app.asar: ' + addonEntry
  )
}
const artifactLegalRoot = resolve(
  dirname(appAsar),
  'LICENSES',
  'irregular-nesting-native'
)
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
process.stdout.write(JSON.stringify({
  capability: addon.nativeCapability(),
  packageLicenseSha256: sha256(
    resolve(packageRoot, 'LICENSES', 'clipper2-ts-BSL-1.0.txt')
  ),
  artifactLicenseSha256: sha256(
    resolve(artifactLegalRoot, 'LICENSES', 'clipper2-ts-BSL-1.0.txt')
  ),
  packageNoticeSha256: sha256(resolve(packageRoot, 'NOTICE')),
  artifactNoticeSha256: sha256(resolve(artifactLegalRoot, 'NOTICE'))
}))
`
  )
  return loaderPath
}

function parseVerificationOutput(stdout) {
  const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1)
  if (line === undefined) {
    throw new Error('packaged Electron produced no verification output')
  }

  let verification
  try {
    verification = JSON.parse(line)
  } catch {
    throw new Error(`packaged Electron produced invalid verification JSON: ${line}`)
  }

  const capability = verification?.capability
  if (
    capability === null ||
    typeof capability !== 'object' ||
    !Number.isInteger(capability.apiVersion) ||
    capability.apiVersion <= 0 ||
    typeof capability.crateVersion !== 'string' ||
    capability.crateVersion.length === 0 ||
    typeof capability.targetTriple !== 'string' ||
    capability.targetTriple.length === 0 ||
    !Array.isArray(capability.profiles) ||
    !capability.profiles.every((profile) => typeof profile === 'string')
  ) {
    throw new Error('nativeCapability() returned an invalid payload')
  }

  for (const [location, digest] of [
    ['native package', verification.packageLicenseSha256],
    ['Electron artifact', verification.artifactLicenseSha256]
  ]) {
    if (digest !== EXPECTED_CLIPPER2_LICENSE_SHA256) {
      throw new Error(
        `packaged Clipper2 license SHA-256 mismatch in ${location}: expected ${EXPECTED_CLIPPER2_LICENSE_SHA256}, received ${String(digest)}`
      )
    }
  }

  for (const [location, digest] of [
    ['native package', verification.packageNoticeSha256],
    ['Electron artifact', verification.artifactNoticeSha256]
  ]) {
    if (digest !== EXPECTED_NATIVE_NOTICE_SHA256) {
      throw new Error(
        `packaged native NOTICE SHA-256 mismatch in ${location}: expected ${EXPECTED_NATIVE_NOTICE_SHA256}, received ${String(digest)}`
      )
    }
  }

  return capability
}

function verifyPackagedNativeLoad({ electronExecutable, appAsar }) {
  const absoluteElectronExecutable = resolve(electronExecutable)
  const absoluteAppAsar = resolve(appAsar)
  assertPathExists(absoluteElectronExecutable, 'packaged Electron executable')
  assertPathExists(absoluteAppAsar, 'packaged app.asar')

  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'min-plane-packaged-native-loader-'))
  try {
    const loaderPath = writeLoaderScript(temporaryDirectory)
    const result = spawnSync(absoluteElectronExecutable, [loaderPath], {
      encoding: 'utf8',
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        MIN_PLANE_PACKAGED_APP_ASAR: absoluteAppAsar
      }
    })
    if (result.error !== undefined || result.status !== 0) {
      const failure = result.error?.message ?? `exit status ${result.status}`
      throw new Error(
        `packaged Electron native load failed (${failure}). stdout: ${result.stdout ?? ''}. stderr: ${result.stderr ?? ''}`
      )
    }

    return parseVerificationOutput(result.stdout ?? '')
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true })
  }
}

try {
  const capability = verifyPackagedNativeLoad(parseArgs(process.argv.slice(2)))
  console.log(
    `packaged native addon and Clipper2 license loaded: target=${capability.targetTriple}, apiVersion=${capability.apiVersion}`
  )
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
