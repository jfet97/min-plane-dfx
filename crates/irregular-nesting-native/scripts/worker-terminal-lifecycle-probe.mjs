#!/usr/bin/env node
/**
 * Exercises terminal delivery through the public addon API in a real Worker.
 * The caller supplies any outer harness deadline. This fixture deliberately
 * has no timeout because terminal acknowledgement is a strict production barrier.
 */

import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'

const SCRIPT_PATH = fileURLToPath(import.meta.url)
const SCRIPT_DIR = dirname(SCRIPT_PATH)
const CRATE_ROOT = dirname(SCRIPT_DIR)
const REPO_ROOT = dirname(dirname(CRATE_ROOT))
const ADDON_ENTRY_PATH = join(CRATE_ROOT, 'npm', 'index.cjs')
const LIFECYCLE_JOB_ID = 'native-worker-terminal-lifecycle'
const REQUEST_FIXTURE_PATH = join(
  REPO_ROOT,
  'tests',
  'fixtures',
  'irregularSheetInvariance',
  'mixed61-request.json'
)

const CONTROL = {
  startWorker: 0,
  terminalEntered: 1,
  releaseTerminal: 2,
  callbackReturned: 3,
  promiseSettled: 4
}

function assert(condition, message) {
  if (!condition) throw new Error(`assertion failed: ${message}`)
}

function loadAddon() {
  assert(existsSync(ADDON_ENTRY_PATH), `native addon entry missing: ${ADDON_ENTRY_PATH}`)
  const require = createRequire(import.meta.url)
  const addon = require(ADDON_ENTRY_PATH)
  const capability = addon.nativeCapability()
  assert(capability.apiVersion === 3, `expected apiVersion 3, received ${capability.apiVersion}`)
  return addon
}

function lifecycleRequest() {
  const fixture = JSON.parse(readFileSync(REQUEST_FIXTURE_PATH, 'utf8'))
  assert(Array.isArray(fixture.pieces) && fixture.pieces.length >= 1, 'fixture has one piece')
  assert(Array.isArray(fixture.sourcePieces), 'fixture has source pieces')

  const pieces = fixture.pieces.slice(0, 1)
  const sourcePieceIds = new Set(pieces.map((piece) => piece.sourcePieceId))
  const sourcePieces = fixture.sourcePieces.filter((piece) => sourcePieceIds.has(piece.id))
  assert(
    sourcePieces.length === sourcePieceIds.size,
    'fixture includes source geometry for every piece'
  )

  return {
    ...fixture,
    jobId: LIFECYCLE_JOB_ID,
    pieces,
    sourcePieces
  }
}

function waitForWorkerMessage(worker, expectedKind) {
  return new Promise((resolve, reject) => {
    const onMessage = (message) => {
      cleanup()
      if (message?.kind === expectedKind) {
        resolve(message)
        return
      }
      if (message?.kind === 'native-promise-rejected') {
        reject(new Error(`native promise rejected before ${expectedKind}: ${message.message}`))
        return
      }
      reject(
        new Error(`expected worker message ${expectedKind}, received ${String(message?.kind)}`)
      )
    }
    const onError = (error) => {
      cleanup()
      reject(error)
    }
    const onExit = (code) => {
      cleanup()
      reject(new Error(`worker exited before ${expectedKind}: ${code}`))
    }
    const cleanup = () => {
      worker.off('message', onMessage)
      worker.off('error', onError)
      worker.off('exit', onExit)
    }

    worker.once('message', onMessage)
    worker.once('error', onError)
    worker.once('exit', onExit)
  })
}

function createLifecycleWorker(controlBuffer) {
  return new Worker(SCRIPT_PATH, {
    workerData: {
      controlBuffer,
      request: lifecycleRequest()
    }
  })
}

function releaseWorkerStart(control) {
  Atomics.store(control, CONTROL.startWorker, 1)
  Atomics.notify(control, CONTROL.startWorker)
}

function assertBlockedTerminalGate(control) {
  assert(Atomics.load(control, CONTROL.terminalEntered) === 1, 'terminal callback entered')
  assert(Atomics.load(control, CONTROL.callbackReturned) === 0, 'terminal callback remains blocked')
  assert(Atomics.load(control, CONTROL.promiseSettled) === 0, 'native promise remains pending')
}

function readProcessLifecycle(addon) {
  const diagnostics = JSON.parse(addon.getLastJobDiagnostics())
  assert(diagnostics !== null, 'parent diagnostics sidecar exists after terminal entry')
  const lifecycle = diagnostics.processLifecycle
  assert(lifecycle !== null && typeof lifecycle === 'object', 'process lifecycle exists')
  assert(
    Number.isSafeInteger(lifecycle.terminalCleanupHooksFired),
    'terminal cleanup hook counter is a safe integer'
  )
  assert(
    Number.isSafeInteger(lifecycle.terminalLatchCloseRequestsByCleanup),
    'terminal latch close counter is a safe integer'
  )
  return lifecycle
}

function waitForCleanupCommit(addon) {
  return new Promise((resolve, reject) => {
    const poll = () => {
      try {
        const lifecycle = readProcessLifecycle(addon)
        if (
          lifecycle.terminalCleanupHooksFired === 1 &&
          lifecycle.terminalLatchCloseRequestsByCleanup === 1
        ) {
          resolve(lifecycle)
          return
        }
        setImmediate(poll)
      } catch (error) {
        reject(error)
      }
    }
    setImmediate(poll)
  })
}

async function terminateAfterFailure(worker) {
  try {
    await worker.terminate()
  } catch {
    // preserve the original lifecycle failure
  }
}

async function runTerminalBarrier() {
  const controlBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 5)
  const control = new Int32Array(controlBuffer)
  const worker = createLifecycleWorker(controlBuffer)
  let terminated = false

  try {
    const terminalEnteredPromise = waitForWorkerMessage(worker, 'terminal-entered')
    releaseWorkerStart(control)
    await terminalEnteredPromise
    assert(Atomics.load(control, CONTROL.terminalEntered) === 1, 'terminal callback entered')
    assert(
      Atomics.load(control, CONTROL.callbackReturned) === 0,
      'terminal callback remains blocked'
    )
    assert(Atomics.load(control, CONTROL.promiseSettled) === 0, 'native promise remains pending')

    const settledPromise = waitForWorkerMessage(worker, 'promise-settled')
    Atomics.store(control, CONTROL.releaseTerminal, 1)
    Atomics.notify(control, CONTROL.releaseTerminal)

    const settled = await settledPromise
    assert(Atomics.load(control, CONTROL.callbackReturned) === 1, 'terminal callback returned')
    assert(
      Atomics.load(control, CONTROL.promiseSettled) === 1,
      'native promise settled after callback return'
    )
    assert(
      typeof settled.envelopeJson === 'string',
      'native promise resolved to its envelope string'
    )

    await worker.terminate()
    terminated = true
    process.stdout.write('terminal-barrier-ok\n')
  } finally {
    if (!terminated) await terminateAfterFailure(worker)
  }
}

async function runCleanupProof() {
  const addon = loadAddon()
  const controlBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 5)
  const control = new Int32Array(controlBuffer)
  const worker = createLifecycleWorker(controlBuffer)
  let terminated = false

  try {
    const terminalEnteredPromise = waitForWorkerMessage(worker, 'terminal-entered')
    releaseWorkerStart(control)
    await terminalEnteredPromise
    assertBlockedTerminalGate(control)

    const beforeTermination = readProcessLifecycle(addon)
    assert(
      beforeTermination.terminalCleanupHooksFired === 0,
      'cleanup hook counter starts at zero in the fresh probe process'
    )
    assert(
      beforeTermination.terminalLatchCloseRequestsByCleanup === 0,
      'latch close counter starts at zero in the fresh probe process'
    )

    await worker.terminate()
    terminated = true
    assertBlockedTerminalGate(control)

    const afterTermination = await waitForCleanupCommit(addon)
    const observation = `${afterTermination.terminalCleanupHooksFired}/${afterTermination.terminalLatchCloseRequestsByCleanup}`
    process.stdout.write(`cleanup-proof-process-lifecycle=${observation}\n`)
    assert(observation === '1/1', 'cleanup hook committed the terminal latch close')
    process.stdout.write('cleanup-proof-ok\n')
  } finally {
    if (!terminated) await terminateAfterFailure(worker)
  }
}

function runWorker() {
  const control = new Int32Array(workerData.controlBuffer)
  Atomics.wait(control, CONTROL.startWorker, 0)

  const addon = loadAddon()
  const nativePromise = addon.runIrregularJob(
    JSON.stringify(workerData.request),
    'native-worker-terminal-lifecycle-invocation-token',
    (json) => {
      const event = JSON.parse(json)
      if (event.kind !== 'terminal') return

      Atomics.store(control, CONTROL.terminalEntered, 1)
      Atomics.notify(control, CONTROL.terminalEntered)
      parentPort.postMessage({ kind: 'terminal-entered' })
      Atomics.wait(control, CONTROL.releaseTerminal, 0)
      Atomics.store(control, CONTROL.callbackReturned, 1)
      Atomics.notify(control, CONTROL.callbackReturned)
    },
    false
  )

  nativePromise.then(
    (envelopeJson) => {
      Atomics.store(control, CONTROL.promiseSettled, 1)
      Atomics.notify(control, CONTROL.promiseSettled)
      parentPort.postMessage({ kind: 'promise-settled', envelopeJson })
    },
    (error) => {
      parentPort.postMessage({
        kind: 'native-promise-rejected',
        message: error instanceof Error ? error.message : String(error)
      })
    }
  )
}

async function main() {
  if (!isMainThread) {
    runWorker()
    return
  }

  const mode = process.argv[2]
  if (mode === 'terminal-barrier') {
    await runTerminalBarrier()
    return
  }
  if (mode === 'cleanup-proof') {
    await runCleanupProof()
    return
  }
  throw new Error('usage: worker-terminal-lifecycle-probe.mjs <terminal-barrier|cleanup-proof>')
}

main().catch((error) => {
  process.stderr.write(
    `[worker-terminal-lifecycle] FAILED: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  )
  process.exitCode = 1
})
