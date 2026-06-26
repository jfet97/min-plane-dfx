// manual runtime smoke test for src/main/runtime/effectRuntime.ts.
// run with: pnpm exec tsx scripts/effect-rt-smoke.ts
import { Effect, FileSystem } from 'effect'
import { AppLiveLayer } from '../src/main/runtime/effectRuntime'
import path from 'node:path'
import { promises as fs } from 'node:fs'

const target = path.join(process.cwd(), 'out', 'smoke-fs.txt')
await fs.rm(target, { force: true })

const program = Effect.gen(function* () {
  const fsSvc = yield* FileSystem.FileSystem
  yield* fsSvc.makeDirectory(path.dirname(target), { recursive: true })
  yield* fsSvc.writeFileString(target, 'hello effect-smol\n')
  const back = yield* fsSvc.readFileString(target)
  yield* fsSvc.remove(target)
  return back
}).pipe(Effect.provide(AppLiveLayer))

const exit = await Effect.runPromiseExit(program)
console.log('round-trip exit:', JSON.stringify(exit, null, 2))

const failProgram = Effect.gen(function* () {
  const fsSvc = yield* FileSystem.FileSystem
  return yield* fsSvc.readFileString(
    path.join(process.cwd(), 'out', 'definitely-missing-' + Date.now() + '.txt')
  )
}).pipe(Effect.provide(AppLiveLayer))

const failExit = await Effect.runPromiseExit(failProgram)
console.log('fail exit:', JSON.stringify(failExit, null, 2))
