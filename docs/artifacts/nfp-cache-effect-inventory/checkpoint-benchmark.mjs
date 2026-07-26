import { performance } from 'node:perf_hooks'
import { Effect } from 'effect'

const checkpointCount = 2_975_313
const deadline = Number.MAX_SAFE_INTEGER

const directCheckpoint = () =>
  performance.now() >= deadline ? Effect.fail(new Error('deadline')) : Effect.void

const composedCheckpoint = () =>
  Effect.gen(function* () {
    if (performance.now() >= deadline) {
      return yield* Effect.fail(new Error('deadline'))
    }
  })

function run(checkpoint, count) {
  Effect.runSync(
    Effect.gen(function* () {
      for (let index = 0; index < count; index += 1) {
        yield* checkpoint()
      }
    })
  )
}

function measure(checkpoint) {
  const startedAt = performance.now()
  run(checkpoint, checkpointCount)
  return performance.now() - startedAt
}

run(directCheckpoint, 100_000)
run(composedCheckpoint, 100_000)

const pairs = []
for (let pair = 1; pair <= 5; pair += 1) {
  if (pair % 2 === 1) {
    const composedMs = measure(composedCheckpoint)
    const directMs = measure(directCheckpoint)
    pairs.push({ pair, composedMs, directMs, differenceMs: composedMs - directMs })
  } else {
    const directMs = measure(directCheckpoint)
    const composedMs = measure(composedCheckpoint)
    pairs.push({ pair, composedMs, directMs, differenceMs: composedMs - directMs })
  }
}

console.log(JSON.stringify({ checkpointCount, pairs }, null, 2))
