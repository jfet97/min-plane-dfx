const { createHash } = require('node:crypto')
const { readFileSync } = require('node:fs')

for (const path of process.argv.slice(2)) {
  const checksum = createHash('sha256').update(readFileSync(path)).digest('hex')
  process.stdout.write(`${checksum}  ${path}\n`)
}
