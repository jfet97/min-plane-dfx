#!/usr/bin/env node
/** Packages Electron with the exact registry-installed native dependency. */
import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const NATIVE_PACKAGE_ROOT = resolve(REPOSITORY_ROOT, 'node_modules/irregular-nesting-native')
const EXPECTED_PACKAGE_NAME = '@jfet07-polygon-labs/polygon-nesting'
const EXPECTED_PACKAGE_VERSION = '0.1.0'

const packageManifestPath = resolve(NATIVE_PACKAGE_ROOT, 'package.json')
if (!existsSync(packageManifestPath)) {
  throw new Error(`native package is not installed: ${packageManifestPath}`)
}

const packageManifest = JSON.parse(readFileSync(packageManifestPath, 'utf8'))
if (
  packageManifest.name !== EXPECTED_PACKAGE_NAME ||
  packageManifest.version !== EXPECTED_PACKAGE_VERSION
) {
  throw new Error(
    `native package identity mismatch: expected ${EXPECTED_PACKAGE_NAME}@${EXPECTED_PACKAGE_VERSION}, ` +
      `received ${String(packageManifest.name)}@${String(packageManifest.version)}`
  )
}

for (const target of ['linux-x64', 'win32-x64', 'darwin-arm64', 'darwin-x64']) {
  const addonPath = resolve(NATIVE_PACKAGE_ROOT, 'npm', `irregular-nesting-native.${target}.node`)
  if (!existsSync(addonPath)) {
    throw new Error(`native package target is missing: ${addonPath}`)
  }
}

const electronBuilderCli = resolve(REPOSITORY_ROOT, 'node_modules/electron-builder/cli.js')
const result = spawnSync(process.execPath, [electronBuilderCli, ...process.argv.slice(2)], {
  cwd: REPOSITORY_ROOT,
  stdio: 'inherit'
})
if (result.error !== undefined) throw result.error
if (result.status !== 0) {
  throw new Error(`electron-builder exited with status ${String(result.status)}`)
}
