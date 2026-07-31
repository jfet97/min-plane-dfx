'use strict'

/**
 * Loads the platform-appropriate staged native addon. This CommonJS entry
 * remains stable for workspace and packaged application resolution.
 */
const path = require('node:path')
const { stagedAddonFileName } = require('./target.cjs')

const binaryName = stagedAddonFileName(process.platform, process.arch)
const binaryPath = path.join(__dirname, binaryName)

let native
try {
  native = require(binaryPath)
} catch (cause) {
  const causeMessage = cause && cause.message ? cause.message : String(cause)
  throw new Error(
    `irregular-nesting-native: failed to load native addon "${binaryName}" from ${binaryPath}.\n` +
      'For development, build the root workspace with `pnpm build:native`.\n' +
      'For packaged execution, ensure the application includes the matching unpacked .node file.\n' +
      `Original error: ${causeMessage}`,
    { cause }
  )
}

module.exports = native
