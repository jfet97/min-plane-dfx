import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SEED = 0x5eed_c0de
const VECTOR_COUNT = 21_696
const PINNED_NODE_VERSION = 'v24.11.1'
const scriptPath = fileURLToPath(import.meta.url)
const repoRoot = join(dirname(scriptPath), '..', '..')
const outputPath = join(
  repoRoot,
  'crates',
  'irregular-nesting-native',
  'tests',
  'vectors',
  'js-hypot.json'
)

const mode = process.argv.slice(2)
if (mode.length !== 1 || (mode[0] !== '--write' && mode[0] !== '--check')) {
  throw new Error('usage: dump-js-hypot.ts <--write|--check>')
}
if (process.version !== PINNED_NODE_VERSION) {
  throw new Error(
    `dump-js-hypot.ts requires Node ${PINNED_NODE_VERSION}; current runtime is ${process.version}. ` +
      'Activate the repository .node-version before writing or checking the oracle corpus.'
  )
}

const buffer = new ArrayBuffer(8)
const view = new DataView(buffer)

function toBits(value: number): bigint {
  view.setFloat64(0, value, false)
  return view.getBigUint64(0, false)
}

function fromBits(bits: bigint): number {
  view.setBigUint64(0, bits, false)
  return view.getFloat64(0, false)
}

function hex(bits: bigint): string {
  return bits.toString(16).padStart(16, '0')
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function makeRandom(): () => bigint {
  let state = BigInt(SEED)
  return () => {
    state ^= state << 13n
    state ^= state >> 7n
    state ^= state << 17n
    state = BigInt.asUintN(64, state)
    return state
  }
}

function randomFiniteBits(random: () => bigint): bigint {
  const sign = random() & (1n << 63n)
  const exponent = (random() % 2047n) << 52n
  const fraction = random() & ((1n << 52n) - 1n)
  return sign | exponent | fraction
}

interface HypotVector {
  readonly xBits: string
  readonly yBits: string
  readonly expectedBits: string
  readonly expectedIsNaN: boolean
}

function vector(xBits: bigint, yBits: bigint): HypotVector {
  const output = Math.hypot(fromBits(xBits), fromBits(yBits))
  return {
    xBits: hex(xBits),
    yBits: hex(yBits),
    expectedBits: hex(toBits(output)),
    expectedIsNaN: Number.isNaN(output)
  }
}

function buildCases(): HypotVector[] {
  const cases: HypotVector[] = []
  const edgeBits = [
    0x0000_0000_0000_0000n,
    0x8000_0000_0000_0000n,
    0x0000_0000_0000_0001n,
    0x8000_0000_0000_0001n,
    0x0010_0000_0000_0000n,
    0x8010_0000_0000_0000n,
    0x3ff0_0000_0000_0000n,
    0xbff0_0000_0000_0000n,
    0x4000_0000_0000_0000n,
    0xc000_0000_0000_0000n,
    0x4008_0000_0000_0000n,
    0x4010_0000_0000_0000n,
    0x408f_4000_0000_0000n,
    0x40b3_8800_0000_0000n,
    0x7fe0_0000_0000_0000n,
    0xffe0_0000_0000_0000n,
    0x7fef_ffff_ffff_ffffn,
    0xffef_ffff_ffff_ffffn,
    0x7ff0_0000_0000_0000n,
    0xfff0_0000_0000_0000n,
    0x7ff8_0000_0000_0000n,
    0x3ddb_7cdf_d9d7_bdbbn,
    0x3eb0_c6f7_a0b5_ed8dn,
    0x3f50_624d_d2f1_a9fcn,
    0x3f84_7ae1_47ae_147bn,
    0x3fb9_9999_9999_999an,
    0x3fd0_0000_0000_0000n,
    0x3fe0_0000_0000_0000n,
    0x40c3_8800_0000_0000n,
    0x7e37_e43c_8800_759cn,
    0x01a5_6e1f_c2f8_f359n,
    0x3ff6_a09e_667f_3bcdn
  ]

  for (const xBits of edgeBits) {
    for (const yBits of edgeBits) cases.push(vector(xBits, yBits))
  }

  const random = makeRandom()
  for (let index = 0; index < 1_500; index += 1) {
    const magnitudeBits = randomFiniteBits(random) & 0x7fff_ffff_ffff_ffffn
    const signedBits = magnitudeBits | (index % 2 === 0 ? 0n : 1n << 63n)
    const mode = index % 3
    if (mode === 0) cases.push(vector(signedBits, signedBits))
    if (mode === 1) cases.push(vector(signedBits, 0n))
    if (mode === 2) cases.push(vector(0n, signedBits))
  }

  while (cases.length < VECTOR_COUNT) {
    cases.push(vector(randomFiniteBits(random), randomFiniteBits(random)))
  }

  return cases
}

const cases = buildCases()
const corpusSha256 = sha256(JSON.stringify(cases))
const output = `${JSON.stringify(
  {
    meta: {
      area: 'js-hypot',
      nodeVersion: process.version,
      v8Version: process.versions.v8,
      seed: SEED,
      sourceSha256: sha256(readFileSync(scriptPath)),
      corpusSha256,
      vectorCount: cases.length
    },
    cases
  },
  null,
  2
)}\n`

if (mode[0] === '--write') {
  writeFileSync(outputPath, output, 'utf8')
  process.stdout.write(`wrote ${outputPath} (${cases.length} vectors, sha256 ${corpusSha256})\n`)
} else {
  const committed = readFileSync(outputPath, 'utf8')
  if (committed !== output) {
    throw new Error(`committed hypot corpus is stale; run this script with --write: ${outputPath}`)
  }
  process.stdout.write(`verified ${outputPath} (${cases.length} vectors, sha256 ${corpusSha256})\n`)
}
