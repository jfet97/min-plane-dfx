const { app, BrowserWindow } = require('electron')
const { existsSync, readFileSync, writeFileSync } = require('node:fs')
const { extname, resolve } = require('node:path')

const [, , inputArgument, outputArgument, widthArgument] = process.argv

if (inputArgument === undefined) {
  console.error('usage: render-svg.cjs <input.svg> [output.png] [target-width]')
  process.exit(64)
}

const inputPath = resolve(inputArgument)
const outputPath = resolve(outputArgument ?? inputPath.replace(/\.svg$/i, '.png'))
const targetWidth = widthArgument === undefined ? 1000 : Number(widthArgument)

if (extname(inputPath).toLowerCase() !== '.svg' || !existsSync(inputPath)) {
  console.error(`input SVG does not exist: ${inputPath}`)
  process.exit(66)
}
if (!Number.isInteger(targetWidth) || targetWidth <= 0) {
  console.error(`target width must be a positive integer: ${widthArgument}`)
  process.exit(64)
}

app.disableHardwareAcceleration()

app
  .whenReady()
  .then(async () => {
    const svgBase64 = readFileSync(inputPath).toString('base64')
    const html = `<!doctype html><html><head><style>html,body{width:100%;height:100%;margin:0;background:#1b2328;overflow:hidden}img{display:block;width:100%;height:100%;object-fit:contain}</style></head><body><img src="data:image/svg+xml;base64,${svgBase64}"></body></html>`
    const window = new BrowserWindow({
      width: 1200,
      height: 900,
      show: false,
      backgroundColor: '#1b2328',
      webPreferences: { backgroundThrottling: false }
    })

    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    const capture = await window.webContents.capturePage()
    writeFileSync(outputPath, capture.resize({ width: targetWidth }).toPNG())
    window.destroy()
    console.log(outputPath)
    app.quit()
  })
  .catch((error) => {
    console.error(error)
    app.exit(1)
  })
