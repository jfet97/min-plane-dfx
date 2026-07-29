/**
 * Differential-vector oracle for the four canonical-JSON-family encoders in
 * `crates/irregular-nesting-native/src/checkpoints/canonical_json.rs`
 * (ruling R5: kept as four distinct functions, never unified) and the
 * `docs/planning/rust-irregular-backend/characterization/checkpoint-encoding.md`
 * §8 cluster it characterizes:
 *
 *   - Encoder A: `canonicalJson`, `src/workers/algorithm/irregular/intrinsicCapacitySearch.ts:1626-1635`
 *     (+ `compareStrings`, `:2233-2237`) — ordinal key sort.
 *   - Encoder B: `intrinsicStrictCanonicalJson`, `src/workers/algorithm/irregular/intrinsicStrictDecoder.ts:1257-1277`
 *     — `localeCompare` key sort, explicit `Map` handling.
 *   - Encoder C: `canonicalJson`, `src/workers/algorithm/irregular/intrinsicPeriodicFamilyPortfolio.ts:1285-1293`
 *     — `localeCompare` key sort, no `bigint` branch (throws on `bigint`).
 *   - Encoder D: `canonicalRecord`/`canonicalToken`/`canonicalNumber`/
 *     `canonicalEntryListKey`, `src/workers/algorithm/irregular/irregularBeamState.ts:829-864`
 *     — a length-prefixed token record format, not JSON.
 *
 * ## Why this script transcribes the encoders instead of importing them
 *
 * All four encoder functions (and their two private comparator helpers,
 * `compareStrings` and `canonicalToken`/`canonicalRecord`) are file-local —
 * not `export`ed — in their respective production source files. Per the
 * migration prompt's semantic-freeze rules and this task's explicit
 * instruction, this script may not edit any production TS file (including to
 * add an `export` keyword). No existing exported function in any of the four
 * source files surfaces the *raw string* these encoders produce (the
 * exported entry points that consume them,
 * `runIntrinsicCapacityColdSearch`/`constructIntrinsicStrictState`/
 * `runIntrinsicPeriodicFamilyPortfolio`, only ever expose a downstream
 * SHA-256 **hash** of a *curated projection* of a live, in-process object
 * graph — `checkpoint-encoding.md` §8.4 — reconstructing that whole
 * projection pipeline, and the `IrregularBeamState`/prepared-piece domain
 * model it depends on, is far outside this file's scope: `checkpoints/
 * canonical_json.rs` ports the four encoder *functions themselves*, not the
 * checkpoint-construction pipeline around them).
 *
 * This is exactly the same situation `dump-js-number.ts` documents for
 * `Number.prototype.toString`/`Math.round` ("generic ... have no exported TS
 * wrapper to import" — it exercises the real V8 built-in directly as the
 * oracle instead). Every function below is a verbatim, byte-for-byte
 * transcription of the read production source (cited by exact line range at
 * each function), reproducing the *real* algorithm exactly — these are pure,
 * self-contained functions with no dependency on any other module's hidden
 * state (each one only calls itself recursively, native `JSON.stringify`/
 * `Array`/`Object`/`Map` methods, and its own one-or-two-line comparator
 * helper, all reproduced alongside it), so a verbatim transcription *is* the
 * real algorithm for differential-oracle purposes. Every transcribed
 * function's behavior was independently spot-checked against live `node -e`
 * execution during this script's authoring (bigint quoting, undefined
 * omission, the `Array.prototype.join` undefined-element quirk, `-0`/`NaN`/
 * `Infinity` handling, and the `localeCompare` vs. ordinal divergence) before
 * being trusted as an oracle.
 *
 * Run with:
 *   pnpm exec tsx --tsconfig tsconfig.node.json scripts/rust-parity/dump-canonical-json.ts
 *
 * Output: crates/irregular-nesting-native/tests/vectors/canonical-json.json
 *
 * Additive only — this script does not modify any existing script, test, or
 * fixture (per the migration prompt's semantic-freeze rules and stage-0
 * ruling R14).
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..', '..')
const outputPath = join(
  repoRoot,
  'crates',
  'irregular-nesting-native',
  'tests',
  'vectors',
  'canonical-json.json'
)

// ---------------------------------------------------------------------------
// Verbatim transcriptions of the four production encoders (see file header).
// ---------------------------------------------------------------------------

/** Verbatim port of `compareStrings`, `intrinsicCapacitySearch.ts:2233-2237`. */
function compareStrings(first: string, second: string): number {
  if (first < second) return -1
  if (first > second) return 1
  return 0
}

/**
 * Verbatim port of `canonicalJson`, `intrinsicCapacitySearch.ts:1626-1635`
 * (Encoder A). Declared `string | undefined` here (rather than the original
 * file's own `: string` annotation) to describe its *actual* runtime return
 * type honestly — `JSON.stringify(undefined)` really does evaluate to the
 * JS `undefined` value, not a string, which this function inherits
 * unchanged in its `typeof value !== 'object'` branch; the original file's
 * `: string` annotation is a pre-existing type inaccuracy in the ported
 * source, not part of the ported *behavior*.
 */
function canonicalJsonCapacity(value: unknown): string | undefined {
  if (typeof value === 'bigint') return JSON.stringify(value.toString())
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJsonCapacity).join(',')}]`
  const fields = Object.entries(value)
    .filter(([, fieldValue]) => fieldValue !== undefined)
    .toSorted(([firstKey], [secondKey]) => compareStrings(firstKey, secondKey))
    .map(([key, fieldValue]) => `${JSON.stringify(key)}:${canonicalJsonCapacity(fieldValue)}`)
  return `{${fields.join(',')}}`
}

/**
 * Verbatim port of `intrinsicStrictCanonicalJson`,
 * `intrinsicStrictDecoder.ts:1257-1277` (Encoder B). Same
 * `string | undefined` honesty note as [`canonicalJsonCapacity`].
 */
function canonicalJsonStrict(value: unknown): string | undefined {
  if (typeof value === 'bigint') return JSON.stringify(value.toString())
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJsonStrict).join(',')}]`
  if (value instanceof Map) {
    const entries = [...value.entries()].toSorted(([first], [second]) =>
      String(first).localeCompare(String(second))
    )
    return canonicalJsonStrict(entries)
  }
  const fields = Object.entries(value)
    .filter(([, fieldValue]) => fieldValue !== undefined)
    .toSorted(([firstKey], [secondKey]) => firstKey.localeCompare(secondKey))
    .map(([key, fieldValue]) => `${JSON.stringify(key)}:${canonicalJsonStrict(fieldValue)}`)
  return `{${fields.join(',')}}`
}

/**
 * Verbatim port of `canonicalJson`,
 * `intrinsicPeriodicFamilyPortfolio.ts:1285-1293` (Encoder C). No `bigint`
 * branch — a `bigint` input falls through to `JSON.stringify(value)`, which
 * genuinely throws `TypeError: Do not know how to serialize a BigInt`
 * (confirmed live against Node v24 during this script's authoring; also
 * exercised as an explicit vector below).
 */
function canonicalJsonPeriodic(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJsonPeriodic).join(',')}]`
  const fields = Object.entries(value)
    .filter(([, fieldValue]) => fieldValue !== undefined)
    .toSorted(([firstKey], [secondKey]) => firstKey.localeCompare(secondKey))
    .map(([key, fieldValue]) => `${JSON.stringify(key)}:${canonicalJsonPeriodic(fieldValue)}`)
  return `{${fields.join(',')}}`
}

/** Verbatim port of `canonicalToken`, `irregularBeamState.ts:840-842`. */
function canonicalToken(value: string): string {
  return `${value.length}:${value}`
}

/** Verbatim port of `canonicalRecord`, `irregularBeamState.ts:829-838`. */
function canonicalRecord(fields: ReadonlyArray<ReadonlyArray<string>>): string {
  return fields
    .map((field) => {
      const name = field[0]
      const value = field[1]
      if (name === undefined || value === undefined) return ''
      return `${canonicalToken(name)}${canonicalToken(value)}`
    })
    .join('')
}

/** Verbatim port of `canonicalNumber`, `irregularBeamState.ts:844-850`. */
function canonicalNumber(value: number): string {
  if (Number.isNaN(value)) return 'NaN'
  if (Object.is(value, -0)) return '0'
  if (value === Number.POSITIVE_INFINITY) return '+Infinity'
  if (value === Number.NEGATIVE_INFINITY) return '-Infinity'
  return String(value)
}

/** Verbatim port of `canonicalEntryListKey`, `irregularBeamState.ts:859-864`. */
function canonicalEntryListKey(entryKeys: ReadonlyArray<string>): string {
  return canonicalRecord([
    ['version', 'irregular-occupied-geometry-v2'],
    ['entry-count', canonicalNumber(entryKeys.length)],
    ...entryKeys.map((entryKey, index) => [`entry-${index}`, entryKey])
  ])
}

// ---------------------------------------------------------------------------
// Tagged JSON marshalling for arbitrary JS value trees (BigInt/undefined/Map
// have no native JSON representation). The Rust integration test's
// `from_vector_json` parses this exact tag set back into `JsValue`.
//
// Objects and arrays are wrapped in `{ $obj: [[key, value], ...] }` /
// `{ $arr: [value, ...] }` rather than emitted as plain JSON
// objects/arrays, specifically so this file's own field-insertion order is
// preserved byte-for-byte through the JSON round-trip regardless of
// `serde_json`'s object-map feature configuration on the Rust side (a plain
// JSON object's key order is not a portable guarantee across JSON libraries
// without opting into an order-preserving map type) — order fidelity is
// itself under test here (encoders re-sort object keys; the vector's own
// input order must be under the test's control, not silently normalized by
// the marshalling layer).
// ---------------------------------------------------------------------------
type VectorJson =
  | null
  | boolean
  | number
  | string
  | { readonly $undefined: true }
  | { readonly $bigint: string }
  | { readonly $number: 'NaN' | 'Infinity' | '-Infinity' | '-0' }
  | { readonly $arr: VectorJson[] }
  | { readonly $obj: Array<[string, VectorJson]> }
  | { readonly $map: Array<[VectorJson, VectorJson]> }

function toVectorJson(value: unknown): VectorJson {
  if (value === undefined) return { $undefined: true }
  if (typeof value === 'bigint') return { $bigint: value.toString() }
  if (value instanceof Map) {
    return {
      $map: [...value.entries()].map(
        ([key, entryValue]) => [toVectorJson(key), toVectorJson(entryValue)] as [VectorJson, VectorJson]
      )
    }
  }
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return { $number: 'NaN' }
    if (value === Number.POSITIVE_INFINITY) return { $number: 'Infinity' }
    if (value === Number.NEGATIVE_INFINITY) return { $number: '-Infinity' }
    if (Object.is(value, -0)) return { $number: '-0' }
    return value
  }
  if (value === null) return null
  if (Array.isArray(value)) return { $arr: value.map(toVectorJson) }
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'object') {
    return {
      $obj: Object.entries(value as Record<string, unknown>).map(
        ([key, fieldValue]) => [key, toVectorJson(fieldValue)] as [string, VectorJson]
      )
    }
  }
  throw new Error(`toVectorJson: unsupported value type ${typeof value}`)
}

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32 — matches this directory's established
// convention, e.g. `dump-canonical-grid.ts`).
// ---------------------------------------------------------------------------

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

function randomBigInt(next: () => number, maxDigits: number): bigint {
  const digitCount = 1 + Math.floor(next() * maxDigits)
  let digits = ''
  for (let index = 0; index < digitCount; index += 1) {
    const digit = index === 0 ? 1 + Math.floor(next() * 9) : Math.floor(next() * 10)
    digits += String(digit)
  }
  const magnitude = BigInt(digits)
  return next() < 0.5 ? -magnitude : magnitude
}

// ---------------------------------------------------------------------------
// Number rendering classes (R7): integers, fractions, both exponent-
// threshold directions, the safe-integer boundary, MIN_VALUE/MAX_VALUE
// magnitudes, negative zero, and the three non-finite values.
// ---------------------------------------------------------------------------

const NUMBER_CASES: number[] = [
  0,
  -0,
  1,
  -1,
  0.5,
  -0.5,
  100,
  -100,
  0.1,
  123.456,
  -123.456,
  622.202,
  391605.850174,
  1e20,
  1e21,
  -1e21,
  9.999999999999998e20,
  1e-6,
  1e-7,
  1e-8,
  -1e-7,
  Number.MAX_SAFE_INTEGER,
  -Number.MAX_SAFE_INTEGER,
  Number.MAX_SAFE_INTEGER + 2,
  Number.MAX_VALUE,
  -Number.MAX_VALUE,
  Number.MIN_VALUE,
  -Number.MIN_VALUE,
  Number.EPSILON,
  3.14159265358979,
  1234567890123456,
  100000000000000000000,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY
]

// ---------------------------------------------------------------------------
// Key alphabets: real checkpoint field names, plus synthetic alphabets
// deliberately chosen so ordinal and `localeCompare` order diverge
// (`checkpoint-encoding.md` §6's own example: ordinal `'B' < 'a'`, locale
// `'a' < 'B'`).
// ---------------------------------------------------------------------------
const REAL_FIELD_NAME_ALPHABET: string[] = [
  'version',
  'requestFingerprint',
  'producerRole',
  'archiveCohort',
  'searchBounds',
  'incumbentBinding',
  'frontier',
  'nextDepth',
  'depthBoundaryResumePosition',
  'budgetLedgers',
  'schedulerDeficit',
  'settlement',
  'censoring',
  'noSkipFrontier',
  'counters',
  'topologyRetentionDepths',
  'integrityHash',
  'state',
  'nextPieceIndex',
  'stepTrace',
  'gapFillEvidence',
  'candidateEvaluationCount',
  'activeRuntimeMs',
  'phaseLedger',
  'q0',
  'q90',
  'pendingIds',
  'placedIds',
  'cavities',
  'anchoredOccupiedKey'
]

const MIXED_CASE_DIVERGENT_ALPHABET: string[] = [
  'a',
  'B',
  'c',
  'D',
  'e',
  'F',
  'aa',
  'Aa',
  'aB',
  'Ab',
  'AB',
  'ab',
  'Zebra',
  'zebra',
  'Apple',
  'apple',
  'apple2',
  'Apple10',
  'apple10'
]

const PUNCTUATION_AND_DIGIT_ALPHABET: string[] = [
  '1',
  '2',
  '10',
  '9',
  'a1',
  'A1',
  'q0',
  'q90',
  'q9',
  'point-count',
  'entry-0',
  'entry-1',
  'entry-10',
  'x',
  'y',
  'a_b',
  'a-b',
  'a.b',
  'a b'
]

function randomKeySet(next: () => number, alphabet: readonly string[], count: number): string[] {
  const pool = [...alphabet]
  const chosen: string[] = []
  for (let index = 0; index < count && pool.length > 0; index += 1) {
    const pick = Math.floor(next() * pool.length)
    const removed = pool.splice(pick, 1)[0]
    if (removed !== undefined) chosen.push(removed)
  }
  return chosen
}

// ---------------------------------------------------------------------------
// Randomized nested value-tree generator for Encoders A/B/C.
// ---------------------------------------------------------------------------

interface TreeOptions {
  readonly keyAlphabets: readonly (readonly string[])[]
  readonly allowBigint: boolean
}

function randomLeafValue(next: () => number, options: TreeOptions): unknown {
  const choice = Math.floor(next() * (options.allowBigint ? 9 : 8))
  switch (choice) {
    case 0:
      return null
    case 1:
      return next() < 0.5
    case 2:
      return NUMBER_CASES[Math.floor(next() * NUMBER_CASES.length)] ?? 0
    case 3:
      return `str-${Math.floor(next() * 1000)}`
    case 4:
      return ''
    case 5:
      return undefined
    case 6:
      return 'plain-text'
    case 7:
      return next() < 0.5
    default:
      return randomBigInt(next, 1 + Math.floor(next() * 20))
  }
}

function randomValueTree(next: () => number, depth: number, options: TreeOptions): unknown {
  if (depth <= 0 || next() < 0.35) return randomLeafValue(next, options)
  if (next() < 0.5) {
    const length = Math.floor(next() * 5)
    const items: unknown[] = []
    for (let index = 0; index < length; index += 1) {
      items.push(randomValueTree(next, depth - 1, options))
    }
    return items
  }
  const alphabet = options.keyAlphabets[Math.floor(next() * options.keyAlphabets.length)] ?? REAL_FIELD_NAME_ALPHABET
  const keyCount = 1 + Math.floor(next() * Math.min(6, alphabet.length))
  const keys = randomKeySet(next, alphabet, keyCount)
  const obj: Record<string, unknown> = {}
  for (const key of keys) obj[key] = randomValueTree(next, depth - 1, options)
  return obj
}

// ---------------------------------------------------------------------------
// Vector shapes.
// ---------------------------------------------------------------------------

interface EncoderVector {
  readonly id: string
  readonly input: VectorJson
  readonly outcome: 'value' | 'undefined' | 'throws'
  readonly expected: string | null
}

function buildEncoderVector(
  id: string,
  value: unknown,
  encoder: (v: unknown) => string | undefined
): EncoderVector {
  let rendered: string | undefined
  try {
    rendered = encoder(value)
  } catch {
    return { id, input: toVectorJson(value), outcome: 'throws', expected: null }
  }
  if (rendered === undefined) {
    return { id, input: toVectorJson(value), outcome: 'undefined', expected: null }
  }
  return { id, input: toVectorJson(value), outcome: 'value', expected: rendered }
}

// ---------------------------------------------------------------------------
// Fixed edge-case values shared across encoders A/B/C.
// ---------------------------------------------------------------------------

function fixedEdgeCaseValues(): Array<[string, unknown]> {
  const cases: Array<[string, unknown]> = [
    ['null', null],
    ['true', true],
    ['false', false],
    ['empty-string', ''],
    ['plain-string', 'hello'],
    ['string-with-quotes-and-backslash', 'a"b\\c'],
    ['string-with-control-chars', 'a\nb\tc\rd\bf\x0cg\x01h\x1fi'],
    ['string-with-non-ascii', 'héllo — 日本語 😀'],
    ['empty-array', []],
    ['empty-object', {}],
    ['top-level-undefined', undefined],
    ['array-with-undefined-elements', [1, undefined, 3]],
    ['array-with-leading-undefined', [undefined, 1]],
    ['array-with-trailing-undefined', [1, undefined]],
    ['array-of-arrays-with-undefined', [[1, undefined], [undefined, 2]]],
    ['nested-empty-containers', { a: [], b: {}, c: [{}], d: [[]] }],
    ['bigint-zero', 0n],
    ['bigint-positive', 123456789012345678901234567890n],
    ['bigint-negative', -987654321098765432109876543210n],
    ['bigint-in-array', [1n, -2n, 3n]],
    ['bigint-in-object', { a: 1n, b: -2n }],
    [
      'deeply-nested-unsorted-keys',
      {
        zulu: 1,
        alpha: { delta: 2, bravo: { foxtrot: 3, charlie: [4, 5, { echo: 6, delta: 7 }] } },
        bravo: 8
      }
    ],
    ['object-with-undefined-field-omitted', { a: 1, b: undefined, c: 3 }],
    ['object-with-only-undefined-fields', { a: undefined, b: undefined }],
    ['negative-zero-bare', -0],
    ['negative-zero-in-array', [-0, 0, 1]],
    ['negative-zero-in-object', { x: -0, y: 0 }],
    ['nan-bare', Number.NaN],
    ['infinity-bare', Number.POSITIVE_INFINITY],
    ['negative-infinity-bare', Number.NEGATIVE_INFINITY],
    ['nan-in-array', [Number.NaN, 1]],
    ['mixed-case-object', { B: 1, a: 2, C: 3, b: 4, A: 5, c: 6 }],
    [
      'checkpoint-shaped-synthetic-object',
      {
        version: 'intrinsic-anytime-checkpoint-v3',
        producerRole: 'capacity-cold',
        archiveCohort: 'partial',
        incumbentBinding: undefined,
        nextDepth: 4,
        depthBoundaryResumePosition: 4,
        schedulerDeficit: 0,
        settlement: 'active',
        censoring: 'none',
        counters: { deduplicatedSuccessors: 2, prunedByIncumbent: 0 },
        frontier: [
          {
            eligibility: 'completeEligible',
            placedPreparedIds: ['p1', 'p2'],
            pendingPreparedIds: [],
            deferredPreparedIds: [],
            permanentlySkippedPreparedIds: [],
            placedDoubledMaterialAreaGrid2: 4000000n,
            fitMask: { q0: true, q90: false }
          }
        ]
      }
    ]
  ]
  for (const value of NUMBER_CASES) cases.push([`number-bare-${cases.length}`, value])
  return cases
}

// ---------------------------------------------------------------------------
// Map-specific vectors for Encoder B only.
// ---------------------------------------------------------------------------

function fixedMapVectors(): Array<[string, unknown]> {
  return [
    ['empty-map', new Map()],
    [
      'map-string-keys-divergent-case',
      new Map<unknown, unknown>([
        ['B', 1],
        ['a', 2],
        ['C', 3]
      ])
    ],
    [
      'map-number-and-string-keys',
      new Map<unknown, unknown>([
        [2, 'two'],
        ['1', 'one-string'],
        [10, 'ten']
      ])
    ],
    [
      'map-with-bigint-and-undefined-values',
      new Map<unknown, unknown>([
        ['a', 1n],
        ['b', undefined],
        ['c', 3]
      ])
    ],
    [
      'map-with-nested-map-value',
      new Map<unknown, unknown>([
        [
          'outer',
          new Map<unknown, unknown>([
            ['B', 1],
            ['a', 2]
          ])
        ]
      ])
    ],
    [
      'map-with-null-and-boolean-keys-coerced',
      new Map<unknown, unknown>([
        [null, 'null-key'],
        [true, 'true-key'],
        [false, 'false-key']
      ])
    ]
  ]
}

// ---------------------------------------------------------------------------
// Bigint-into-encoder-C throw vectors.
// ---------------------------------------------------------------------------

function periodicThrowVectors(): Array<[string, unknown]> {
  return [
    ['bare-bigint', 5n],
    ['bigint-in-array', [1, 5n, 3]],
    ['bigint-in-object-field', { a: 1, b: 5n }],
    ['bigint-nested-deep', { a: [{ b: { c: 5n } }] }]
  ]
}

// ---------------------------------------------------------------------------
// Encoder D (canonicalToken/canonicalNumber/canonicalRecord/canonicalEntryListKey) vectors.
// ---------------------------------------------------------------------------

interface TokenVector {
  readonly id: string
  readonly value: string
  readonly expected: string
}

function buildTokenVectors(): TokenVector[] {
  const values = [
    '',
    'a',
    'ab',
    'point-count',
    'entry-0',
    'irregular-occupied-geometry-v2',
    'héllo',
    '日本語',
    '\u{1f600}',
    '\u{1f600}\u{1f600}',
    'a\u{1f600}b',
    'normal text with spaces',
    '0',
    'NaN',
    '-Infinity'
  ]
  return values.map((value, index) => ({
    id: `token-${index}`,
    value,
    expected: canonicalToken(value)
  }))
}

interface NumberVector {
  readonly id: string
  readonly value: VectorJson
  readonly expected: string
}

function buildCanonicalNumberVectors(): NumberVector[] {
  return NUMBER_CASES.map((value, index) => ({
    id: `canonical-number-${index}`,
    value: toVectorJson(value),
    expected: canonicalNumber(value)
  }))
}

interface RecordVector {
  readonly id: string
  readonly fields: string[][]
  readonly expected: string
}

function buildRecordVectors(): RecordVector[] {
  const cases: string[][][] = [
    [],
    [['name', 'value']],
    [
      ['a', '1'],
      ['b', '2']
    ],
    [['point-count', '0']],
    [['only-name']], // malformed row: R3 faithful reproduction of the field[1]-undefined guard
    [[]], // malformed row: both indices undefined
    [
      ['x', '5'],
      ['y', '-3'],
      ['point-count', '2']
    ],
    [['unicode-value', 'héllo — 日本語 😀']],
    [['empty-value', '']]
  ]
  return cases.map((fields, index) => ({
    id: `record-${index}`,
    fields,
    expected: canonicalRecord(fields)
  }))
}

interface EntryListKeyVector {
  readonly id: string
  readonly entryKeys: string[]
  readonly expected: string
}

function buildEntryListKeyVectors(): EntryListKeyVector[] {
  const cases: string[][] = [
    [],
    ['k0'],
    ['k0', 'k1'],
    ['k0', 'k1', 'k2', 'k3', 'k4'],
    ['same', 'same', 'same'],
    ['héllo', '日本語', '😀']
  ]
  // A longer synthetic list to exercise multi-digit `entry-<index>` field names.
  const long: string[] = []
  for (let index = 0; index < 15; index += 1) long.push(`entry-value-${index}`)
  cases.push(long)
  return cases.map((entryKeys, index) => ({
    id: `entry-list-key-${index}`,
    entryKeys,
    expected: canonicalEntryListKey(entryKeys)
  }))
}

// ---------------------------------------------------------------------------
// Assemble and write.
// ---------------------------------------------------------------------------

function gitCommit(): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot }).toString().trim()
}

function buildAbcVectors(
  encoderName: 'capacity' | 'strict' | 'periodic',
  encoder: (v: unknown) => string | undefined,
  randomTreeCount: number,
  randomSeed: number,
  allowBigint: boolean
): EncoderVector[] {
  const vectors: EncoderVector[] = []

  for (const [name, value] of fixedEdgeCaseValues()) {
    vectors.push(buildEncoderVector(`${encoderName}-fixed-${name}`, value, encoder))
  }

  // Divergent-key-alphabet objects: same shape, run through every encoder
  // separately so each encoder's own real `localeCompare`/ordinal order is
  // captured (this is what proves the divergence, not a shared assumption).
  const alphabets: Array<[string, readonly string[]]> = [
    ['real-fields', REAL_FIELD_NAME_ALPHABET],
    ['mixed-case', MIXED_CASE_DIVERGENT_ALPHABET],
    ['punctuation-digit', PUNCTUATION_AND_DIGIT_ALPHABET]
  ]
  const alphabetNext = mulberry32(0x0a1_0a1 + randomSeed)
  for (const [alphabetName, alphabet] of alphabets) {
    for (let trial = 0; trial < 8; trial += 1) {
      const keyCount = 1 + Math.floor(alphabetNext() * Math.min(8, alphabet.length))
      const keys = randomKeySet(alphabetNext, alphabet, keyCount)
      const obj: Record<string, unknown> = {}
      keys.forEach((key, index) => {
        obj[key] = index % 2 === 0 ? index : `v${index}`
      })
      vectors.push(
        buildEncoderVector(`${encoderName}-alphabet-${alphabetName}-${trial}`, obj, encoder)
      )
    }
  }

  const options: TreeOptions = {
    keyAlphabets: [REAL_FIELD_NAME_ALPHABET, MIXED_CASE_DIVERGENT_ALPHABET, PUNCTUATION_AND_DIGIT_ALPHABET],
    allowBigint
  }
  const next = mulberry32(randomSeed)
  for (let trial = 0; trial < randomTreeCount; trial += 1) {
    const depth = 1 + Math.floor(next() * 4)
    const tree = randomValueTree(next, depth, options)
    vectors.push(buildEncoderVector(`${encoderName}-random-${trial}`, tree, encoder))
  }

  return vectors
}

function main(): void {
  const capacityVectors = buildAbcVectors('capacity', canonicalJsonCapacity, 90, 0x5eed1, true)
  const strictVectors = buildAbcVectors('strict', canonicalJsonStrict, 90, 0x5eed2, true)
  const periodicVectors = [
    ...buildAbcVectors('periodic', canonicalJsonPeriodic, 90, 0x5eed3, false),
    ...periodicThrowVectors().map(([name, value]) =>
      buildEncoderVector(`periodic-throws-${name}`, value, canonicalJsonPeriodic)
    )
  ]
  const strictMapVectors = fixedMapVectors().map(([name, value]) =>
    buildEncoderVector(`strict-map-${name}`, value, canonicalJsonStrict)
  )

  const tokenVectors = buildTokenVectors()
  const canonicalNumberVectors = buildCanonicalNumberVectors()
  const recordVectors = buildRecordVectors()
  const entryListKeyVectors = buildEntryListKeyVectors()

  const totalVectorCount =
    capacityVectors.length +
    strictVectors.length +
    periodicVectors.length +
    strictMapVectors.length +
    tokenVectors.length +
    canonicalNumberVectors.length +
    recordVectors.length +
    entryListKeyVectors.length

  const document = {
    header: {
      generatedBy: 'scripts/rust-parity/dump-canonical-json.ts',
      generatingCommit: gitCommit(),
      generatedAt: new Date().toISOString(),
      sourceFiles: [
        'src/workers/algorithm/irregular/intrinsicCapacitySearch.ts',
        'src/workers/algorithm/irregular/intrinsicStrictDecoder.ts',
        'src/workers/algorithm/irregular/intrinsicPeriodicFamilyPortfolio.ts',
        'src/workers/algorithm/irregular/irregularBeamState.ts'
      ],
      totalVectorCount,
      note:
        'Encoders A/B/C (capacity/strict/periodic) each produce an EncoderVector: ' +
        '`input` is a tagged-JSON value tree ($undefined/$bigint/$number/$arr/$obj/$map ' +
        'tags disambiguate values with no native JSON representation, or where object/' +
        'array/Map order fidelity must survive the JSON round-trip exactly); `outcome` is ' +
        '"value" (expected holds the real encoder\'s rendered string), "undefined" (the ' +
        'real encoder returned the literal JS `undefined` value, only possible for a bare ' +
        'top-level `undefined` input), or "throws" (the real encoder threw synchronously, ' +
        'currently only reachable for Encoder C given a `bigint` anywhere in the input). ' +
        'Encoder D (canonicalToken/canonicalNumber/canonicalRecord/canonicalEntryListKey) ' +
        'vectors are plain string/array-of-strings input/output pairs (no tagging needed).'
    },
    capacityVectors,
    strictVectors,
    periodicVectors,
    strictMapVectors,
    tokenVectors,
    canonicalNumberVectors,
    recordVectors,
    entryListKeyVectors
  }

  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
  // eslint-disable-next-line no-console
  console.log(`Wrote ${totalVectorCount} canonical-json vectors to ${outputPath}`)
}

main()
