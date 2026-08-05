#!/usr/bin/env node
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { createRequire } = require('node:module')
const { resolve } = require('node:path')

const [addonPath, requestPath, outputPath, invocationToken] = process.argv.slice(2)
if ([addonPath, requestPath, outputPath, invocationToken].some((value) => value === undefined)) {
  throw new Error('usage: capture-old-parity-runner.cjs <addon> <request> <output> <token>')
}

mkdirSync(outputPath, { recursive: false })
const request = readFileSync(requestPath)
writeFileSync(resolve(outputPath, 'request.json'), request, { flag: 'wx' })
const events = []
const addon = createRequire(addonPath)(addonPath)

;(async () => {
  let exitCode = 0
  let result = ''
  let stderr = ''
  try {
    result = await addon.runIrregularJob(
      request.toString('utf8'),
      invocationToken,
      (event) => {
        events.push(event)
      },
      false
    )
  } catch (error) {
    exitCode = 1
    stderr = error instanceof Error ? `${error.stack ?? error.message}\n` : `${String(error)}\n`
  }
  writeFileSync(resolve(outputPath, 'result.json'), result, { flag: 'wx' })
  writeFileSync(
    resolve(outputPath, 'events.ndjson'),
    events.length === 0 ? '' : `${events.join('\n')}\n`,
    { flag: 'wx' }
  )
  writeFileSync(resolve(outputPath, 'stderr.txt'), stderr, { flag: 'wx' })
  writeFileSync(
    resolve(outputPath, 'process.json'),
    `${JSON.stringify({ exitCode, diagnostics: addon.getLastJobDiagnostics() }, null, 2)}\n`,
    { flag: 'wx' }
  )
  process.exitCode = exitCode
})()
