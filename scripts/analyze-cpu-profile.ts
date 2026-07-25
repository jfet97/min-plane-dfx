import { readFile } from 'node:fs/promises'
import { createGunzip } from 'node:zlib'
import { createReadStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'

/**
 * Categorizes a V8 CPU profile by self time and by inclusive time per function.
 *
 * The categories separate framework machinery from algorithm work, because the
 * question this tool exists to answer is how much of a run is Effect runtime and
 * Effect Schema rather than geometry and search. Accepts `.cpuprofile` or
 * `.cpuprofile.gz`.
 *
 * ```sh
 * pnpm exec tsx --tsconfig tsconfig.node.json scripts/analyze-cpu-profile.ts \
 *   --profile <file> [--top 30] [--inclusive-filter src/shared/irregular/domain]
 * ```
 */

interface CallFrame {
  readonly functionName?: string
  readonly url?: string
  readonly lineNumber?: number
}

interface ProfileNode {
  readonly id: number
  readonly callFrame: CallFrame
  readonly children?: ReadonlyArray<number>
}

interface CpuProfile {
  readonly nodes: ReadonlyArray<ProfileNode>
  readonly samples: ReadonlyArray<number>
  readonly timeDeltas: ReadonlyArray<number>
}

const CATEGORIES: ReadonlyArray<{
  readonly name: string
  readonly matches: (url: string, functionName: string) => boolean
}> = [
  { name: 'GC', matches: (_url, fn) => fn === '(garbage collector)' },
  {
    name: 'runtime/idle',
    matches: (_url, fn) => fn === '(program)' || fn === '(idle)' || fn === '(root)'
  },
  {
    name: 'Effect Schema (decode/validate)',
    matches: (url) => url.includes('effect/dist/Schema')
  },
  {
    name: 'Effect runtime (fiber/effect machinery)',
    matches: (url) => url.includes('effect/dist')
  },
  {
    name: 'canonical grid exact math',
    matches: (url) => url.includes('canonicalGridMath') || url.includes('canonicalGridContact')
  },
  { name: 'canonical layout metrics', matches: (url) => url.includes('canonicalLayoutGeometry') },
  { name: 'NFP/IFP candidate generation', matches: (url) => url.includes('nfpIfpService') },
  {
    name: 'beam-state canonical keys',
    matches: (url) => url.includes('irregularBeamState')
  },
  { name: 'spatial index', matches: (url) => url.includes('placedCollisionSpatialIndex') },
  {
    name: 'placement validation / convex predicates',
    matches: (url) =>
      url.includes('placementValidation') || url.includes('convexPolygon') || url.includes('convexSat')
  },
  { name: 'clipper2', matches: (url) => url.toLowerCase().includes('clipper') },
  { name: 'other node_modules', matches: (url) => url.includes('node_modules') },
  {
    name: 'search / decoders / portfolios',
    matches: (url) => url.includes('/src/workers/algorithm/')
  },
  { name: 'other geometry kernels', matches: (url) => url.includes('/src/workers/irregular/') },
  { name: 'node builtins', matches: (url) => url.startsWith('node:') }
]

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}

function categorize(url: string, functionName: string): string {
  return CATEGORIES.find(({ matches }) => matches(url, functionName))?.name ?? 'other'
}

async function readProfile(path: string): Promise<CpuProfile> {
  if (!path.endsWith('.gz')) {
    return JSON.parse(await readFile(path, 'utf8')) as CpuProfile
  }
  const chunks: Buffer[] = []
  await pipeline(createReadStream(path), createGunzip(), async function* (source) {
    for await (const chunk of source) chunks.push(Buffer.from(chunk as Uint8Array))
  })
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as CpuProfile
}

const profilePath = argument('--profile')
if (profilePath === undefined) throw new Error('--profile is required')
const top = Number(argument('--top') ?? 30)
const inclusiveFilter = argument('--inclusive-filter')

const profile = await readProfile(profilePath)
const nodes = new Map(profile.nodes.map((node) => [node.id, node]))
const selfMicros = new Map<number, number>()
for (let index = 0; index < profile.samples.length; index += 1) {
  const id = profile.samples[index]
  const delta = profile.timeDeltas[index]
  if (id === undefined || delta === undefined) continue
  selfMicros.set(id, (selfMicros.get(id) ?? 0) + delta)
}
const total = [...selfMicros.values()].reduce((sum, value) => sum + value, 0)

function label(node: ProfileNode): string {
  const url = (node.callFrame.url ?? '').replace(/^file:\/\/.*?\/(?=src\/|scripts\/|node_modules\/)/, '')
  return `${node.callFrame.functionName || '(anon)'}  [${url}:${(node.callFrame.lineNumber ?? -1) + 1}]`
}

const byCategory = new Map<string, number>()
const byFunction = new Map<string, number>()
for (const [id, micros] of selfMicros) {
  const node = nodes.get(id)
  if (node === undefined) continue
  const category = categorize(node.callFrame.url ?? '', node.callFrame.functionName ?? '')
  byCategory.set(category, (byCategory.get(category) ?? 0) + micros)
  byFunction.set(label(node), (byFunction.get(label(node)) ?? 0) + micros)
}

function inclusiveMicros(id: number): number {
  let sum = 0
  const stack = [id]
  while (stack.length > 0) {
    const current = stack.pop()
    if (current === undefined) continue
    sum += selfMicros.get(current) ?? 0
    stack.push(...(nodes.get(current)?.children ?? []))
  }
  return sum
}

function report(title: string, entries: ReadonlyArray<readonly [string, number]>, limit: number) {
  console.log(`\n=== ${title} ===`)
  for (const [name, micros] of [...entries].sort((a, b) => b[1] - a[1]).slice(0, limit)) {
    console.log(`${(micros / 1e6).toFixed(2).padStart(8)}s ${((100 * micros) / total).toFixed(1).padStart(5)}%  ${name}`)
  }
}

console.log(`samples ${profile.samples.length}, total sampled ${(total / 1e6).toFixed(1)}s`)
report('SELF TIME BY CATEGORY', [...byCategory.entries()], CATEGORIES.length + 1)
report('SELF TIME BY FUNCTION', [...byFunction.entries()], top)

if (inclusiveFilter !== undefined) {
  const inclusive = new Map<string, number>()
  for (const node of profile.nodes) {
    if (!(node.callFrame.url ?? '').includes(inclusiveFilter)) continue
    const name = node.callFrame.functionName || '(anon)'
    inclusive.set(name, (inclusive.get(name) ?? 0) + inclusiveMicros(node.id))
  }
  report(
    `INCLUSIVE TIME matching "${inclusiveFilter}" (nested; not additive)`,
    [...inclusive.entries()],
    top
  )
}
