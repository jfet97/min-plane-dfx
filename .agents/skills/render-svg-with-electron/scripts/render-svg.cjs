const { spawnSync } = require('node:child_process')
const { resolve } = require('node:path')

if (process.env.CODEX_SANDBOX !== undefined) {
  console.error(
    'Electron cannot register an AppKit application inside the macOS seatbelt sandbox. Run this command with approved unsandboxed execution.'
  )
  process.exit(78)
}

const electronPath = require('electron')
const rendererPath = resolve(__dirname, 'render-svg-electron.cjs')
const result = spawnSync(electronPath, [rendererPath, ...process.argv.slice(2)], {
  stdio: 'inherit'
})

if (result.error !== undefined) {
  console.error(result.error)
  process.exit(1)
}
if (result.signal !== null) {
  console.error(`Electron exited with signal ${result.signal}`)
  process.exit(1)
}

process.exit(result.status ?? 1)
