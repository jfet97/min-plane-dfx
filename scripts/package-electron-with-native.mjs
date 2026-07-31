#!/usr/bin/env node
/** Packages Electron with a physical, allowlisted native workspace package. */
import { existsSync, renameSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stageNativePackageForElectron } from './stage-native-package-for-electron.mjs'

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WORKSPACE_PACKAGE = resolve(REPOSITORY_ROOT, 'node_modules/irregular-nesting-native')
const WORKSPACE_PACKAGE_BACKUP = `${WORKSPACE_PACKAGE}.workspace-link-${process.pid}`

if (!existsSync(WORKSPACE_PACKAGE)) {
  throw new Error(`native workspace package link does not exist: ${WORKSPACE_PACKAGE}`)
}
if (existsSync(WORKSPACE_PACKAGE_BACKUP)) {
  throw new Error(`native workspace package backup already exists: ${WORKSPACE_PACKAGE_BACKUP}`)
}

renameSync(WORKSPACE_PACKAGE, WORKSPACE_PACKAGE_BACKUP)
try {
  const addonFiles = stageNativePackageForElectron(undefined, WORKSPACE_PACKAGE)
  console.log(`staged irregular-nesting-native for Electron: ${addonFiles.join(', ')}`)

  const electronBuilderCli = resolve(REPOSITORY_ROOT, 'node_modules/electron-builder/cli.js')
  const result = spawnSync(process.execPath, [electronBuilderCli, ...process.argv.slice(2)], {
    cwd: REPOSITORY_ROOT,
    stdio: 'inherit'
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`electron-builder exited with status ${String(result.status)}`)
  }
} finally {
  rmSync(WORKSPACE_PACKAGE, { force: true, recursive: true })
  renameSync(WORKSPACE_PACKAGE_BACKUP, WORKSPACE_PACKAGE)
}
