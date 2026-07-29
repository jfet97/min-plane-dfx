/**
 * Differential-vector generator for the Rust `geometry::predicates` and
 * `geometry::hash` modules (`crates/irregular-nesting-native/src/geometry/`).
 *
 * Per docs/planning/rust-irregular-backend/stage0-rulings.md R9 and R14: this
 * script imports the REAL production TS entry points --
 *   - `orient2d` straight from the `robust-predicates` npm package (the exact
 *     import used at `src/workers/irregular/geometryPredicates.ts:1`), and
 *   - `GeometryPredicates.orientation` from that same production module, and
 *   - Node's own `crypto.createHash('sha256')`, the exact primitive every
 *     `src/workers/algorithm/irregular/*.ts` identity-hash call site uses --
 * evaluates them over a deliberate input matrix, and writes byte-exact JSON
 * vectors for a Rust integration test to replay.
 *
 * Run with:
 *   pnpm exec tsx --tsconfig tsconfig.node.json scripts/rust-parity/dump-predicates.ts
 *
 * Outputs (additive; never edits existing fixtures/tests):
 *   - crates/irregular-nesting-native/tests/vectors/predicates.json
 *   - crates/irregular-nesting-native/tests/vectors/hash.json
 */
import { orient2d } from 'robust-predicates'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import DxfParser from 'dxf-parser'
import { GeometryPredicates } from '../../src/workers/irregular/geometryPredicates.js'
import type { InternalPoint } from '../../src/workers/irregular/internalGeometry.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..', '..')
const VECTORS_DIR = join(REPO_ROOT, 'crates', 'irregular-nesting-native', 'tests', 'vectors')
const DXF_FIXTURES_DIR = join(REPO_ROOT, 'tests', 'fixtures', 'dxf')

function generatingCommit(): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT }).toString().trim()
}

// ---------------------------------------------------------------------------
// f64 -> exact bit pattern, so the Rust side reads the identical IEEE-754
// bits rather than round-tripping through a decimal/JSON number literal
// (which would lose exactness for values like negative zero, subnormals, or
// non-round-trippable literals).
// ---------------------------------------------------------------------------
function f64Bits(value: number): string {
  const buffer = new ArrayBuffer(8)
  const view = new DataView(buffer)
  // Big-endian (default `littleEndian = false`): the leftmost hex digits are
  // the most-significant byte, matching a plain big-endian u64 parse in Rust.
  view.setFloat64(0, value, false)
  let hex = '0x'
  for (let i = 0; i < 8; i++) {
    hex += view.getUint8(i).toString(16).padStart(2, '0')
  }
  return hex
}

interface PredicateCase {
  readonly category: string
  readonly ax: string
  readonly ay: string
  readonly bx: string
  readonly by: string
  readonly cx: string
  readonly cy: string
  /** Sign of the raw `orient2d(ax, ay, bx, by, cx, cy)` result: -1 | 0 | 1. */
  readonly orient2dSign: -1 | 0 | 1
  /**
   * Result of the real production `GeometryPredicates.orientation(origin,
   * first, second)` for `origin = (ax, ay)`, `first = (bx, by)`,
   * `second = (cx, cy)`.
   */
  readonly orientationResult: -1 | 0 | 1
}

function sign(value: number): -1 | 0 | 1 {
  if (value > 0) return 1
  if (value < 0) return -1
  return 0
}

function makeCase(
  category: string,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number
): PredicateCase {
  const origin: InternalPoint = { x: ax, y: ay }
  const first: InternalPoint = { x: bx, y: by }
  const second: InternalPoint = { x: cx, y: cy }
  const rawResult = orient2d(ax, ay, bx, by, cx, cy)
  const orientationResult = GeometryPredicates.orientation(origin, first, second)
  return {
    category,
    ax: f64Bits(ax),
    ay: f64Bits(ay),
    bx: f64Bits(bx),
    by: f64Bits(by),
    cx: f64Bits(cx),
    cy: f64Bits(cy),
    orient2dSign: sign(rawResult),
    orientationResult
  }
}

// ---------------------------------------------------------------------------
// Deterministic seeded PRNG (mulberry32) so the "random" category is
// reproducible across runs and machines.
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

function randomInRange(random: () => number, lo: number, hi: number): number {
  return lo + random() * (hi - lo)
}

/** Uniform-in-log-magnitude float in [-maxMagnitude, maxMagnitude], signed randomly. */
function randomWideMagnitude(random: () => number, maxExponent: number): number {
  const exponent = randomInRange(random, -20, maxExponent)
  const mantissa = randomInRange(random, 1, 10)
  const value = mantissa * 10 ** exponent
  return random() < 0.5 ? -value : value
}

const cases: PredicateCase[] = []

// ---------------------------------------------------------------------------
// Category 1: exactly-collinear integer triples. Points along an integer
// line a + t * (dx, dy) for several (a, dx, dy, t-triples) combinations.
// ---------------------------------------------------------------------------
{
  const random = mulberry32(0xc0111ea1)
  const lineSpecs: Array<{ x0: number; y0: number; dx: number; dy: number }> = []
  for (let i = 0; i < 30; i++) {
    lineSpecs.push({
      x0: Math.round(randomInRange(random, -1000, 1000)),
      y0: Math.round(randomInRange(random, -1000, 1000)),
      dx: Math.round(randomInRange(random, -50, 50)) || 1,
      dy: Math.round(randomInRange(random, -50, 50)) || 1
    })
  }
  for (const { x0, y0, dx, dy } of lineSpecs) {
    for (let k = 0; k < 5; k++) {
      const t1 = Math.round(randomInRange(random, -20, 20))
      const t2 = Math.round(randomInRange(random, -20, 20))
      const t3 = Math.round(randomInRange(random, -20, 20))
      cases.push(
        makeCase(
          'collinear-integer',
          x0 + t1 * dx,
          y0 + t1 * dy,
          x0 + t2 * dx,
          y0 + t2 * dy,
          x0 + t3 * dx,
          y0 + t3 * dy
        )
      )
    }
  }
  // A few axis-aligned and identity-adjacent collinear cases by hand.
  cases.push(makeCase('collinear-integer', 0, 0, 5, 0, -5, 0))
  cases.push(makeCase('collinear-integer', 0, 0, 0, 5, 0, -5))
  cases.push(makeCase('collinear-integer', 0, 0, 0, 0, 0, 0))
  cases.push(makeCase('collinear-integer', 7, 7, 7, 7, 3, 3))
}

// ---------------------------------------------------------------------------
// Category 2: near-collinear float triples at the adaptive-precision
// boundary -- start from an exactly collinear base triple and perturb the
// third point by tiny epsilons at several magnitudes, at several base-point
// magnitudes, to exercise `orient2d`'s exact-arithmetic fallback path (the
// same one `robust::orient2d`'s adaptive path must agree with).
// ---------------------------------------------------------------------------
{
  const random = mulberry32(0xadaf71ec)
  const epsilons = [
    Number.EPSILON,
    -Number.EPSILON,
    1e-17,
    -1e-17,
    1e-15,
    -1e-15,
    1e-12,
    -1e-12,
    1e-10,
    -1e-10
  ]
  const magnitudes = [0, 1, 1e2, 1e4, 1e6, 1e8]
  for (const magnitude of magnitudes) {
    for (let i = 0; i < 5; i++) {
      const x0 = magnitude === 0 ? 0 : randomInRange(random, -magnitude, magnitude)
      const y0 = magnitude === 0 ? 0 : randomInRange(random, -magnitude, magnitude)
      const dx = randomInRange(random, -10, 10) || 1
      const dy = randomInRange(random, -10, 10) || 1
      const bx = x0 + dx
      const by = y0 + dy
      const cxBase = x0 + 2 * dx
      const cyBase = y0 + 2 * dy
      for (const epsilon of epsilons) {
        cases.push(makeCase('near-collinear-float', x0, y0, bx, by, cxBase + epsilon, cyBase))
      }
    }
  }
  // Perturbation directly on the fixture-observed near-collinear triple
  // (mirrors tests/fixtures/dxf/near-collinear.dxf's own construction).
  for (const epsilon of epsilons) {
    cases.push(makeCase('near-collinear-float', 0, 0, 100, 0, 100 + epsilon, epsilon))
  }
}

// ---------------------------------------------------------------------------
// Category 3: seeded random floats across a wide range of magnitudes,
// including sub-unit and super-large values and mixed signs.
// ---------------------------------------------------------------------------
{
  const random = mulberry32(0x5eed5eed)
  for (let i = 0; i < 150; i++) {
    cases.push(
      makeCase(
        'seeded-random-float',
        randomWideMagnitude(random, 6),
        randomWideMagnitude(random, 6),
        randomWideMagnitude(random, 6),
        randomWideMagnitude(random, 6),
        randomWideMagnitude(random, 6),
        randomWideMagnitude(random, 6)
      )
    )
  }
}

// ---------------------------------------------------------------------------
// Category 4: fixture-derived mm coordinates. Every point from every entity
// in every DXF fixture under tests/fixtures/dxf/, combined into consecutive
// (wraparound) and skip-2 triples per fixture, preserving realistic
// production-scale mm coordinates and the actual near-collinear fixture's
// own tiny perturbation.
// ---------------------------------------------------------------------------
{
  const dxfFiles = readdirSync(DXF_FIXTURES_DIR).filter((name) => name.endsWith('.dxf'))
  for (const fileName of dxfFiles) {
    const text = readFileSync(join(DXF_FIXTURES_DIR, fileName), 'utf8')
    const parser = new DxfParser()
    const doc = parser.parseSync(text)
    const points: Array<{ x: number; y: number }> = []
    for (const entity of doc?.entities ?? []) {
      const vertices = (entity as { vertices?: Array<{ x: number; y: number }> }).vertices
      if (Array.isArray(vertices)) {
        for (const vertex of vertices) points.push({ x: vertex.x, y: vertex.y })
      }
      const center = (entity as { center?: { x: number; y: number } }).center
      if (center) points.push({ x: center.x, y: center.y })
    }
    if (points.length < 3) continue
    const category = `fixture:${fileName}`
    for (let i = 0; i < points.length; i++) {
      const a = points[i]!
      const b = points[(i + 1) % points.length]!
      const c = points[(i + 2) % points.length]!
      cases.push(makeCase(category, a.x, a.y, b.x, b.y, c.x, c.y))
      const d = points[(i + 3) % points.length]!
      cases.push(makeCase(category, a.x, a.y, c.x, c.y, d.x, d.y))
    }
  }
}

// ---------------------------------------------------------------------------
// Category 5: extreme and boundary magnitudes, signed zero, and degenerate
// (repeated-point) cases.
// ---------------------------------------------------------------------------
{
  const extremeValues = [
    0,
    -0,
    Number.MIN_VALUE,
    -Number.MIN_VALUE,
    5e-324,
    2.2250738585072014e-308, // smallest positive normal f64
    Number.MAX_SAFE_INTEGER,
    -Number.MAX_SAFE_INTEGER,
    Number.MAX_VALUE,
    -Number.MAX_VALUE,
    1.7976931348623157e300
  ]
  // Deliberately not a full cross product (11^6 is absurd); pick a
  // structured, still-large subset: every extreme value takes a turn as
  // each of the six coordinates, against a fixed well-conditioned triangle,
  // plus a handful of all-extreme combinations.
  const base = { ax: 1, ay: 2, bx: 5, by: 1, cx: 3, cy: 9 }
  const coordNames = ['ax', 'ay', 'bx', 'by', 'cx', 'cy'] as const
  for (const coordName of coordNames) {
    for (const extreme of extremeValues) {
      const values = { ...base, [coordName]: extreme }
      cases.push(
        makeCase(
          'extreme-magnitude',
          values.ax,
          values.ay,
          values.bx,
          values.by,
          values.cx,
          values.cy
        )
      )
    }
  }
  // Signed-zero combinations: every combination of +0/-0 across all six
  // coordinates for a triple that is otherwise exactly collinear at the
  // origin (all zero) -- this is the maximally degenerate, sign-sensitive
  // case for an orientation predicate.
  for (let mask = 0; mask < 64; mask++) {
    const z = (bit: number) => (mask & (1 << bit) ? -0 : 0)
    cases.push(makeCase('signed-zero', z(0), z(1), z(2), z(3), z(4), z(5)))
  }
  // Degenerate repeated-point cases.
  cases.push(makeCase('degenerate-repeated-point', 3, 4, 3, 4, 9, 9))
  cases.push(makeCase('degenerate-repeated-point', 3, 4, 9, 9, 3, 4))
  cases.push(makeCase('degenerate-repeated-point', 9, 9, 3, 4, 3, 4))
  cases.push(makeCase('degenerate-repeated-point', 5, 5, 5, 5, 5, 5))
  cases.push(makeCase('degenerate-repeated-point', 0, 0, 0, 0, 0, 0))
}

if (cases.length < 500) {
  throw new Error(
    `Expected at least 500 orient2d differential vectors, generated only ${cases.length}.`
  )
}

// ---------------------------------------------------------------------------
// SHA-256 vectors: representative canonical-identity-style strings, hashed
// with Node's own `crypto.createHash('sha256')` -- the exact primitive every
// production call site listed in `geometry/hash.rs`'s module doc comment
// uses (there is no shared TS wrapper function to import; the pattern is
// inlined at each call site).
// ---------------------------------------------------------------------------
interface HashCase {
  readonly category: string
  readonly input: string
  readonly sha256Hex: string
}

function makeHashCase(category: string, input: string): HashCase {
  return {
    category,
    input,
    sha256Hex: createHash('sha256').update(input).digest('hex')
  }
}

const hashCases: HashCase[] = []

hashCases.push(makeHashCase('empty', ''))
hashCases.push(makeHashCase('ascii-word', 'abc'))
hashCases.push(makeHashCase('ascii-word', 'irregular-nesting-native'))
hashCases.push(
  makeHashCase(
    'json-stringify-object',
    JSON.stringify({
      version: 3,
      occupied: 'grid:12:-4/7:9',
      remaining: ['piece-1', 'piece-2', 'piece-3'],
      unplaced: []
    })
  )
)
hashCases.push(
  makeHashCase(
    'json-stringify-nested',
    JSON.stringify({
      a: [1, -2, 3.5, -0, null, true, false],
      b: { c: { d: [1e21, -1e-7, Number.MAX_SAFE_INTEGER] } },
      unicode: 'pièce-héxàgone-★'
    })
  )
)
hashCases.push(
  makeHashCase('null-joined-identity', ['piece:0:0:0', 'piece:1:90:0', 'piece:2:180:1'].join(' '))
)
hashCases.push(makeHashCase('null-joined-empty-parts', ['', '', ''].join(' ')))
hashCases.push(makeHashCase('single-null-char', ' '))
hashCases.push(makeHashCase('control-chars', '\n\t\r'))
hashCases.push(makeHashCase('sha256-prefixed-source', `sha256:${'x'.repeat(64)}`))
hashCases.push(makeHashCase('multibyte-latin1-supplement', 'café résumé naïve'))
hashCases.push(makeHashCase('multibyte-cjk', '不规则排样引擎'))
hashCases.push(makeHashCase('astral-emoji-surrogate-pairs', '🚀🧵📐 rocket thread square'))
hashCases.push(makeHashCase('mixed-astral-and-ascii', 'piece-🚀-42-héxàgone-不规则'))
hashCases.push(makeHashCase('long-repeated', 'ab'.repeat(5000)))
hashCases.push(
  makeHashCase('long-varied', Array.from({ length: 2000 }, (_, i) => `p${i}`).join(','))
)
hashCases.push(
  makeHashCase(
    'numeric-edge-strings',
    ['-0', '0', 'NaN', 'Infinity', '-Infinity', '1e21', '5e-324'].join(',')
  )
)

if (hashCases.length < 15) {
  throw new Error(`Expected a representative spread of sha256 vectors, got ${hashCases.length}.`)
}

// ---------------------------------------------------------------------------
// Write output.
// ---------------------------------------------------------------------------
mkdirSync(VECTORS_DIR, { recursive: true })

const commit = generatingCommit()

const predicatesOutput = {
  generatedByScript: 'scripts/rust-parity/dump-predicates.ts',
  generatingCommit: commit,
  sourcePackage: 'robust-predicates@3.0.3',
  sourceModule: 'src/workers/irregular/geometryPredicates.ts',
  description:
    'orient2d (raw robust-predicates package call, argument order ax,ay,bx,by,cx,cy) ' +
    'and GeometryPredicates.orientation (the real production wrapper) evaluated over ' +
    'a broad input matrix. f64 inputs are recorded as big-endian IEEE-754 bit-pattern ' +
    'hex strings; only the SIGN of orient2d and the exact -1/0/1 orientation result ' +
    'are asserted, per ruling R9 (only predicate signs are consumed in production).',
  caseCount: cases.length,
  cases
}
writeFileSync(
  join(VECTORS_DIR, 'predicates.json'),
  JSON.stringify(predicatesOutput, null, 2) + '\n'
)

const hashOutput = {
  generatedByScript: 'scripts/rust-parity/dump-predicates.ts',
  generatingCommit: commit,
  sourcePrimitive: "node:crypto createHash('sha256').update(input).digest('hex')",
  description:
    'Representative canonical-identity-style strings hashed with SHA-256, matching the ' +
    "inlined createHash('sha256').update(x).digest('hex') pattern used throughout " +
    'src/workers/algorithm/irregular/*.ts.',
  caseCount: hashCases.length,
  cases: hashCases
}
writeFileSync(join(VECTORS_DIR, 'hash.json'), JSON.stringify(hashOutput, null, 2) + '\n')

console.log(
  `Wrote ${cases.length} predicate vectors and ${hashCases.length} hash vectors ` +
    `(commit ${commit}) to ${VECTORS_DIR}`
)
