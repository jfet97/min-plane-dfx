/**
 * Differential-vector oracle for `crates/irregular-nesting-native/src/js_number/`.
 *
 * Per the Rust migration prompt's stage-0 rulings (R7, R8, R14) and
 * `docs/planning/rust-irregular-backend/js-semantics-audit.md` §7 ("Numeric
 * semantics") and §5.2 ("Comparator taxonomy"), this script evaluates the
 * *real* V8/Node runtime's JavaScript `Number`/`Math` built-ins — which
 * literally are the production implementation these primitives must
 * reproduce, since generic `Number.prototype.toString`/`Math.round`/etc. have
 * no exported TS wrapper to import — over a broad, deliberate input matrix,
 * plus the two concrete exported production functions that route through
 * `Math.round` at a real canonical-grid call site
 * (`canonicalLinearMetric`/`canonicalAreaMetric`,
 * `src/workers/algorithm/irregular/intrinsicStrictDecoder.ts:1692-1698`).
 *
 * Run with:
 *   pnpm exec tsx --tsconfig tsconfig.node.json scripts/rust-parity/dump-js-number.ts
 *
 * Output: crates/irregular-nesting-native/tests/vectors/js-number.json
 *
 * This script is additive only — it does not modify any existing script,
 * test, or fixture (per the migration prompt's semantic-freeze rules and
 * stage-0 ruling R14).
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  canonicalAreaMetric,
  canonicalLinearMetric
} from '../../src/workers/algorithm/irregular/intrinsicStrictDecoder.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..', '..')
const outputPath = join(
  repoRoot,
  'crates',
  'irregular-nesting-native',
  'tests',
  'vectors',
  'js-number.json'
)

// ---------------------------------------------------------------------------
// Bit-exact f64 <-> hex-string encoding (avoids JSON's inability to represent
// NaN/Infinity as numbers, and avoids relying on decimal round-tripping for
// ordinary floats). Mirrors the Rust side's `f64::to_bits()`/`f64::from_bits()`.
// ---------------------------------------------------------------------------

const bitsBuffer = new ArrayBuffer(8)
const bitsAsFloat = new Float64Array(bitsBuffer)
const bitsAsUint = new BigUint64Array(bitsBuffer)

function toBitsHex(value: number): string {
  bitsAsFloat[0] = value
  // `bitsAsUint` is a fixed-length-1 `BigUint64Array` sharing `bitsBuffer`
  // with `bitsAsFloat`, so index 0 always exists; the non-null assertion is
  // only needed to satisfy `noUncheckedIndexedAccess`.
  return bitsAsUint[0]!.toString(16).padStart(16, '0')
}

interface F64Vector {
  readonly bits: string
  readonly expectedBits: string
  readonly expectedIsNaN: boolean
}

function f64Vector(input: number, output: number): F64Vector {
  return {
    bits: toBitsHex(input),
    expectedBits: toBitsHex(output),
    // NaN payload bits are not guaranteed portable between V8 and Rust's
    // `f64::NAN` (see js-semantics-audit.md §7.3 item 10's transcendental-
    // function caveat, and the general IEEE-754 NaN-payload non-portability
    // it generalizes from) — the Rust test asserts `is_nan()` instead of
    // exact-bits equality whenever this is `true`.
    expectedIsNaN: Number.isNaN(output)
  }
}

// ---------------------------------------------------------------------------
// Input value matrix
// ---------------------------------------------------------------------------

/** Deterministic PRNG (mulberry32) — never `Math.random()`, so failures
 * reproduce exactly, matching this codebase's own stated practice for
 * differential geometry tests (`tests/unit/canonicalGridMath.test.ts`'s
 * `makeSequence` LCG, cited by js-semantics-audit.md §7.2). */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function buildNumericMatrix(): number[] {
  // Deduplicate by IEEE-754 bit pattern, not by a `Set<number>`/`===`-keyed
  // structure: JS `Set` uses SameValueZero equality, under which `+0` and
  // `-0` are the *same* element (`Object.is(+0, -0) === false` but
  // `SameValueZero(+0, -0) === true`), so a naive `Set<number>` silently
  // collapses the `-0` test case into `+0` and never round-trips the sign of
  // zero at all — exactly the hazard this module's `fold_negative_zero`/
  // `number_to_js_string` primitives exist to get right. Keying by the bit
  // pattern preserves `+0`/`-0` (and, incidentally, any distinct NaN bit
  // patterns) as separate matrix entries.
  const values = new Map<string, number>()
  const add = (value: number): void => {
    values.set(toBitsHex(value), value)
  }

  // Special values.
  for (const value of [
    0,
    -0,
    NaN,
    Infinity,
    -Infinity,
    Number.EPSILON,
    -Number.EPSILON,
    Number.MIN_VALUE,
    -Number.MIN_VALUE,
    Number.MAX_VALUE,
    -Number.MAX_VALUE,
    Number.MAX_SAFE_INTEGER,
    -Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER + 1,
    Number.MAX_SAFE_INTEGER + 2,
    -(Number.MAX_SAFE_INTEGER + 1),
    2 ** 53,
    2 ** 53 - 1,
    2 ** 52,
    2 ** 52 + 1,
    -(2 ** 52) - 1,
    2 ** 25 - 1, // CANONICAL_GRID_EXACT_NUMBER_CROSS_LIMIT (canonicalGridMath.ts:50-62)
    2 ** 25,
    2 ** 25 + 1,
    1e21,
    -1e21,
    9.999999999999999e20,
    1e-7,
    -1e-7,
    1e-6,
    1.0000000000000002e-6,
    1e20,
    1e-21,
    5e-324,
    Math.PI,
    Math.E,
    Math.SQRT2,
    1,
    -1,
    100,
    -100
  ]) {
    add(value)
  }

  // Realistic millimeter/area fixture-scale values (per task brief: "mm
  // coordinates like 622.202, areas like 391605.850174").
  for (const value of [
    622.202, -622.202, 391605.850174, -391605.850174, 2000, 2700, 0.001, 1000.5, 13.37, 2000.0005,
    2699.9995, 0.0005, 123.456789, 999999.999999, 0.1, 0.2, 0.3, 10.999999999999998, 45.0, 90.0,
    180.0, 270.0, 360.0, 1.5707963267948966, 3.141592653589793
  ]) {
    add(value)
    add(-value)
  }

  // Halves and near-halves at a spread of magnitudes and signs — the
  // Math.round differential-test matrix (mirrors the manual verification
  // recorded in js_math.rs's `round` doc comment).
  const magnitudes = [0, 1, 2, 3, 4, 5, 10, 50, 100, 1000, 1e6, 1e9, 1e15, 2 ** 52, 2 ** 53 - 2]
  const fractions = [
    0, 0.1, 0.25, 0.4999999999999999, 0.5, 0.5000000000000001, 0.6, 0.75, 0.9, 0.9999999999999999
  ]
  for (const magnitude of magnitudes) {
    for (const fraction of fractions) {
      for (const sign of [1, -1]) {
        add(sign * (magnitude + fraction))
      }
    }
  }

  // Broad seeded-random coverage across a wide exponent range (subnormal to
  // near-MAX_VALUE), both signs.
  const random = mulberry32(0xdb95_7c1e)
  for (let index = 0; index < 400; index += 1) {
    const exponent = Math.floor(random() * 620) - 310 // roughly [-310, 310]
    const mantissa = random() * 9 + 1 // [1, 10)
    const magnitude = mantissa * 10 ** exponent
    const sign = random() < 0.5 ? -1 : 1
    if (Number.isFinite(magnitude)) {
      add(sign * magnitude)
    }
  }

  return [...values.values()]
}

const numericMatrix = buildNumericMatrix()

// ---------------------------------------------------------------------------
// number_to_js_string / is_safe_integer / fold_negative_zero
// ---------------------------------------------------------------------------

const numberToString = numericMatrix.map((value) => ({
  bits: toBitsHex(value),
  expected: String(value)
}))

const isSafeInteger = numericMatrix.map((value) => ({
  bits: toBitsHex(value),
  expected: Number.isSafeInteger(value)
}))

// The `value === 0 ? 0 : value` idiom
// (`src/workers/algorithm/irregular/intrinsicTransformSeparator.ts:1038-1039`,
// `src/workers/irregular/canonicalLayoutGeometry.ts:100-101`).
const foldNegativeZero = numericMatrix.map((value) => {
  const folded = value === 0 ? 0 : value
  return f64Vector(value, folded)
})

// ---------------------------------------------------------------------------
// Math.round / Math.trunc / Math.sign / Math.floor / Math.ceil
// ---------------------------------------------------------------------------

const mathRound = numericMatrix.map((value) => f64Vector(value, Math.round(value)))
const mathTrunc = numericMatrix.map((value) => f64Vector(value, Math.trunc(value)))
const mathSign = numericMatrix.map((value) => f64Vector(value, Math.sign(value)))
const mathFloor = numericMatrix.map((value) => f64Vector(value, Math.floor(value)))
const mathCeil = numericMatrix.map((value) => f64Vector(value, Math.ceil(value)))

// ---------------------------------------------------------------------------
// Math.max / Math.min (binary and variadic), including NaN and zero-sign
// tie-break coverage.
// ---------------------------------------------------------------------------

function buildPairMatrix(): Array<readonly [number, number]> {
  const pairs: Array<readonly [number, number]> = []
  const special = [0, -0, NaN, Infinity, -Infinity, 1, -1, 0.5, -0.5]
  for (const a of special) {
    for (const b of special) {
      pairs.push([a, b])
    }
  }
  // Sample a broader spread of ordinary finite pairs from the numeric matrix
  // (deterministic stride sampling, not the full n^2 cross product).
  const sampled = numericMatrix.filter((value) => Number.isFinite(value))
  for (let index = 0; index < sampled.length; index += 7) {
    const a = sampled[index] as number
    const b = sampled[(index + 3) % sampled.length] as number
    pairs.push([a, b])
  }
  return pairs
}

const pairMatrix = buildPairMatrix()

const mathMaxPairs = pairMatrix.map(([a, b]) => ({
  aBits: toBitsHex(a),
  bBits: toBitsHex(b),
  ...(() => {
    const result = Math.max(a, b)
    const vector = f64Vector(a, result)
    return { expectedBits: vector.expectedBits, expectedIsNaN: vector.expectedIsNaN }
  })()
}))

const mathMinPairs = pairMatrix.map(([a, b]) => ({
  aBits: toBitsHex(a),
  bBits: toBitsHex(b),
  ...(() => {
    const result = Math.min(a, b)
    const vector = f64Vector(a, result)
    return { expectedBits: vector.expectedBits, expectedIsNaN: vector.expectedIsNaN }
  })()
}))

const variadicCases: number[][] = [
  [],
  [5],
  [1, 5, 3],
  [-1, -5, -3],
  [0, -0],
  [-0, 0],
  [0, -0, 0, -0],
  [1, NaN, 3],
  [NaN],
  [Infinity, -Infinity, 0],
  [1.5, 2.5, -2.5, 0.5, -0.5],
  numericMatrix.filter((value) => Number.isFinite(value)).slice(0, 25)
]

const mathMaxAll = variadicCases.map((values) => {
  const result = Math.max(...values)
  return {
    valuesBits: values.map(toBitsHex),
    expectedBits: toBitsHex(result),
    expectedIsNaN: Number.isNaN(result)
  }
})

const mathMinAll = variadicCases.map((values) => {
  const result = Math.min(...values)
  return {
    valuesBits: values.map(toBitsHex),
    expectedBits: toBitsHex(result),
    expectedIsNaN: Number.isNaN(result)
  }
})

// ---------------------------------------------------------------------------
// Real production call sites: canonicalLinearMetric / canonicalAreaMetric
// (both wrap `Math.round` directly — the exact "floating millimeters to
// canonical grid" conversion the migration prompt §8.1 calls out by name).
// ---------------------------------------------------------------------------

const mmScaleValues = numericMatrix.filter(
  (value) => Number.isFinite(value) && Math.abs(value) < 1e9
)

const canonicalLinearMetricVectors = mmScaleValues.map((value) =>
  f64Vector(value, canonicalLinearMetric(value))
)
const canonicalAreaMetricVectors = mmScaleValues.map((value) =>
  f64Vector(value, canonicalAreaMetric(value))
)

// ---------------------------------------------------------------------------
// cmp_js_code_units — UTF-16 code-unit string ordering
// (`compareStrings`/`compareCanonicalKeys`: `first < second ? -1 : first >
// second ? 1 : 0`, `src/workers/algorithm/irregular/intrinsicCapacitySearch.ts:2233-2237`,
// `src/workers/algorithm/irregular/irregularBeamState.ts:867-871`).
// ---------------------------------------------------------------------------

function compareStrings(first: string, second: string): number {
  if (first < second) return -1
  if (first > second) return 1
  return 0
}

// Real piece-id strings observed via `grep -roE '"id"\s*:\s*"[^"]+"'
// tests/fixtures/irregularSheetInvariance/mixed61-request.json` (UUID-based
// copy-suffixed ids) and `grep -rhoE "pieceId:\s*'[^']+'" tests/unit`
// (short hand-authored fixture ids), both re-verified at authoring time
// against commit `26115fc07742368c12e6f8bf492cc90296db2c4d`.
const fixtureIdAlphabet = [
  '0aff79d8-47d7-49b2-958b-8f8648eafc07-copy-1',
  '0aff79d8-47d7-49b2-958b-8f8648eafc07-copy-2',
  '0aff79d8-47d7-49b2-958b-8f8648eafc07-copy-3',
  '25cc62e4-e3e7-4b00-b8b7-7a2ef22b6846-copy-1',
  '25cc62e4-e3e7-4b00-b8b7-7a2ef22b6846-copy-2',
  '28f5a1d1-afd4-46e4-b2b9-f1841386be28-copy-1',
  '28f5a1d1-afd4-46e4-b2b9-f1841386be28-copy-2',
  '28f5a1d1-afd4-46e4-b2b9-f1841386be28-copy-3',
  '3c364de9-07d8-4e8f-8e47-d5ac4961f640-copy-1',
  '3c364de9-07d8-4e8f-8e47-d5ac4961f640-copy-2',
  '3c364de9-07d8-4e8f-8e47-d5ac4961f640-copy-3',
  '3c364de9-07d8-4e8f-8e47-d5ac4961f640-copy-4',
  '3c364de9-07d8-4e8f-8e47-d5ac4961f640-copy-5',
  '54345eb7-a37e-45eb-b0fd-eccffdfa14cc-copy-1',
  '54345eb7-a37e-45eb-b0fd-eccffdfa14cc-copy-2',
  '604bc424-469c-4ab8-93f1-80c0fc4090b3-copy-1',
  '604bc424-469c-4ab8-93f1-80c0fc4090b3-copy-2',
  '68c5a4cc-cf24-447c-ad54-974a021198a8-copy-1',
  'b8721c24-33b9-4244-9ce6-fff728f7e73b-copy-1',
  'c5135087-12f0-44f9-bd91-4bcf67affd8b-copy-1',
  'd06db288-d2d6-4f40-874e-98287f516d93-copy-1',
  'd06db288-d2d6-4f40-874e-98287f516d93-copy-10',
  'd06db288-d2d6-4f40-874e-98287f516d93-copy-11',
  'd06db288-d2d6-4f40-874e-98287f516d93-copy-2',
  // tests/unit/*.test.ts pieceId literals.
  'a',
  'copy-0-of-p-1-for-row-1',
  'copy-1',
  'copy-10',
  'p-1',
  'piece-a',
  'source-2',
  // Curated edge cases.
  '',
  'A',
  'Z',
  'a',
  'z',
  '0',
  '9',
  'copy',
  'copy-',
  'Copy-1',
  '3268390_1',
  '3268390_10',
  '3268390_17',
  'ACRYL_5MM_EXTRUDIERT_TRANSPARENT_13-05-2026-13-53-20',
  'piece-A',
  'piece-B',
  'source-10',
  'source-2a'
]

const cmpJsCodeUnitsCases: Array<{ first: string; second: string; expected: number }> = []
for (let i = 0; i < fixtureIdAlphabet.length; i += 1) {
  for (let j = i; j < fixtureIdAlphabet.length; j += 1) {
    const first = fixtureIdAlphabet[i] as string
    const second = fixtureIdAlphabet[j] as string
    cmpJsCodeUnitsCases.push({ first, second, expected: compareStrings(first, second) })
  }
}

// The concrete supplementary-plane-vs-BMP code-unit-order divergence this
// primitive exists to reproduce exactly (see cmp_js_code_units's doc comment
// in js_number/mod.rs) — U+10000 encodes as the UTF-16 surrogate pair
// (0xD800, 0xDC00), whose leading code unit sorts before U+E000's single code
// unit, even though the actual code point 0x10000 is numerically greater.
const supplementaryPlaneCases = [
  ['\u{10000}', '\u{E000}'],
  ['\u{E000}', '\u{10000}'],
  ['\u{10000}', '\u{10000}'],
  ['\u{D7FF}', '\u{E000}'],
  ['\u{FFFF}', '\u{10000}'],
  ['a\u{10000}b', 'a\u{E000}b']
] as const
for (const [first, second] of supplementaryPlaneCases) {
  cmpJsCodeUnitsCases.push({ first, second, expected: compareStrings(first, second) })
}

// ---------------------------------------------------------------------------
// Write output
// ---------------------------------------------------------------------------

const generatingCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: repoRoot,
  encoding: 'utf8'
}).trim()

const output = {
  meta: {
    area: 'js-number',
    generatingCommit,
    generatedAt: new Date().toISOString(),
    nodeVersion: process.version,
    description:
      'Differential vectors for crates/irregular-nesting-native/src/js_number/: ' +
      'ECMAScript Number::toString (ryu-js target), Number.isSafeInteger, the ' +
      'signed-zero fold idiom, Math.round/trunc/sign/floor/ceil/max/min, the real ' +
      'production canonicalLinearMetric/canonicalAreaMetric call sites, and UTF-16 ' +
      'code-unit string comparison (compareStrings/compareCanonicalKeys).'
  },
  numberToString,
  isSafeInteger,
  foldNegativeZero,
  mathRound,
  mathTrunc,
  mathSign,
  mathFloor,
  mathCeil,
  mathMaxPairs,
  mathMinPairs,
  mathMaxAll,
  mathMinAll,
  canonicalLinearMetric: canonicalLinearMetricVectors,
  canonicalAreaMetric: canonicalAreaMetricVectors,
  cmpJsCodeUnits: cmpJsCodeUnitsCases
}

mkdirSync(dirname(outputPath), { recursive: true })
writeFileSync(outputPath, JSON.stringify(output, null, 2) + '\n', 'utf8')

const totalVectorCount =
  numberToString.length +
  isSafeInteger.length +
  foldNegativeZero.length +
  mathRound.length +
  mathTrunc.length +
  mathSign.length +
  mathFloor.length +
  mathCeil.length +
  mathMaxPairs.length +
  mathMinPairs.length +
  mathMaxAll.length +
  mathMinAll.length +
  canonicalLinearMetricVectors.length +
  canonicalAreaMetricVectors.length +
  cmpJsCodeUnitsCases.length

console.log(`wrote ${outputPath}`)
console.log(`numeric matrix size: ${numericMatrix.length}`)
console.log(`total vector count: ${totalVectorCount}`)
