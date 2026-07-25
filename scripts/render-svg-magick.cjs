const { spawnSync } = require('node:child_process')
const { resolve } = require('node:path')
const { existsSync } = require('node:fs')

/**
 * Headless SVG renderer with the same command interface as
 * `.agents/skills/render-svg-with-electron/scripts/render-svg.cjs`.
 *
 * Electron needs a display server and aborts during platform initialization on
 * machines that have none, which makes the Electron renderer unusable for
 * evidence generation in headless environments. This fallback produces the same
 * PNG from the same SVG using ImageMagick. It is not the default: the gate
 * scripts only use it when `IRREGULAR_SVG_RENDERER` selects it explicitly.
 */

const [, , inputArgument, outputArgument, widthArgument] = process.argv

if (inputArgument === undefined) {
  console.error('usage: render-svg-magick.cjs <input.svg> [output.png] [target-width]')
  process.exit(64)
}

const inputPath = resolve(inputArgument)
const outputPath = resolve(outputArgument ?? inputPath.replace(/\.svg$/i, '.png'))
const targetWidth = widthArgument === undefined ? 1000 : Number(widthArgument)

if (!inputPath.toLowerCase().endsWith('.svg') || !existsSync(inputPath)) {
  console.error(`input SVG does not exist: ${inputPath}`)
  process.exit(66)
}
if (!Number.isInteger(targetWidth) || targetWidth <= 0) {
  console.error(`target width must be a positive integer: ${widthArgument}`)
  process.exit(64)
}

const result = spawnSync(
  'magick',
  [
    '-background',
    '#1b2328',
    '-density',
    '288',
    inputPath,
    '-resize',
    `${targetWidth}x`,
    `PNG24:${outputPath}`
  ],
  { stdio: ['ignore', 'inherit', 'pipe'] }
)

if (result.error !== undefined) {
  console.error(result.error)
  process.exit(1)
}
if (result.status !== 0) {
  console.error(result.stderr?.toString() ?? 'magick failed')
  process.exit(result.status ?? 1)
}
if (!existsSync(outputPath)) {
  console.error(`renderer produced no output: ${outputPath}`)
  process.exit(1)
}

console.log(outputPath)
