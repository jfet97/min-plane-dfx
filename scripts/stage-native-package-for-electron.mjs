#!/usr/bin/env node
/**
 * Replaces the pnpm workspace link with the native package's distributable
 * files before Electron-builder follows production dependency links.
 */
import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE_ROOT = resolve(REPOSITORY_ROOT, 'crates/irregular-nesting-native')
const DESTINATION_ROOT = resolve(REPOSITORY_ROOT, 'node_modules/irregular-nesting-native')

function copyFile(sourceRoot, destinationRoot, relativePath) {
  const source = resolve(sourceRoot, relativePath)
  const destination = resolve(destinationRoot, relativePath)
  mkdirSync(dirname(destination), { recursive: true })
  cpSync(source, destination)
}

export function stageNativePackageForElectron(
  sourceRoot = SOURCE_ROOT,
  destinationRoot = DESTINATION_ROOT
) {
  const addonFiles = readdirSync(resolve(sourceRoot, 'npm'))
    .filter((fileName) => fileName.endsWith('.node'))
    .sort()
  if (addonFiles.length === 0) {
    throw new Error('no staged irregular-nesting-native .node artifact is available for packaging')
  }

  if (existsSync(destinationRoot)) {
    throw new Error(`native package staging destination already exists: ${destinationRoot}`)
  }
  mkdirSync(destinationRoot, { recursive: true })
  for (const relativePath of ['package.json', 'NOTICE', 'npm/index.cjs', 'npm/target.cjs']) {
    copyFile(sourceRoot, destinationRoot, relativePath)
  }
  cpSync(resolve(sourceRoot, 'LICENSES'), resolve(destinationRoot, 'LICENSES'), {
    recursive: true
  })
  for (const addonFile of addonFiles) {
    copyFile(sourceRoot, destinationRoot, `npm/${addonFile}`)
  }

  return addonFiles
}
