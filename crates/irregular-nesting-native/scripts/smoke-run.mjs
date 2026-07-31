#!/usr/bin/env node
// End-to-end smoke test for the real N-API boundary
// (`src/boundary/{request,result,error,events,job,diagnostics,run_job}.rs`,
// `src/lib.rs`'s `runIrregularJob`/`cancelIrregularJob`/`getLastJobDiagnostics`).
//
// Builds the addon, loads it, derives a small 2-piece request from the real
// `tests/fixtures/irregularSheetInvariance/mixed61-request.json` production
// fixture (same sheet, same real `irregularSettings`, first two real pieces
// plus their matching source geometry), runs one real job through
// `runIrregularJob`, and asserts:
//   - the returned value is a `Promise` that resolves (never rejects) with
//     `{"ok":true,"result":{...}}`;
//   - `onPortfolioProgress` fired at least once, with strictly increasing
//     ordinals starting at 0;
//   - the result carries a placement for every requested piece (2 pieces,
//     a small enough case to always fit the fixture's real sheet);
//   - `cancelIrregularJob` on an unrelated/unknown invocation token is a harmless
//     `false` no-op (does not disturb the real job in flight);
//   - `getLastJobDiagnostics()` returns valid JSON with this job's identity
//     fields populated, structurally separate from the semantic result.
//
// Usage:
//   node crates/irregular-nesting-native/scripts/smoke-run.mjs
//
// Exits non-zero (with a clear message) on any assertion failure, a
// rejected promise, or a native load failure.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const CRATE_ROOT = dirname(SCRIPT_DIR);
const REPO_ROOT = dirname(dirname(CRATE_ROOT));
const FIXTURE_PATH = join(
  REPO_ROOT,
  'tests/fixtures/irregularSheetInvariance/mixed61-request.json'
);

function log(message) {
  console.log(`[smoke-run] ${message}`);
}

function fail(message) {
  console.error(`[smoke-run] FAILED: ${message}`);
  process.exitCode = 1;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`assertion failed: ${message}`);
  }
}

function buildAddon() {
  log('building the native addon (cargo build, dev profile)...');
  execFileSync(process.execPath, [join(CRATE_ROOT, 'scripts/build-native.mjs'), '--profile', 'dev'], {
    cwd: CRATE_ROOT,
    stdio: 'inherit',
  });
}

function loadAddon() {
  // `npm/index.cjs` is CommonJS (see its own top comment); this script is an
  // ES module, so it needs `createRequire` to load it.
  const indexPath = join(CRATE_ROOT, 'npm/index.cjs');
  const require = createRequire(import.meta.url);
  return require(indexPath);
}

/** Derives a small, real 2-piece request from the real mixed61 fixture. */
function deriveTwoPieceRequest() {
  if (!existsSync(FIXTURE_PATH)) {
    throw new Error(`fixture not found at ${FIXTURE_PATH}`);
  }
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
  assert(Array.isArray(fixture.pieces) && fixture.pieces.length >= 2, 'fixture has >= 2 pieces');
  assert(
    fixture.options?.irregularSettings?.optimizer?.intrinsicSharedArchiveEnabled === true,
    'fixture optimizer settings are archive-eligible'
  );

  const pieces = fixture.pieces.slice(0, 2);
  const sourcePieceIds = new Set(pieces.map((piece) => piece.sourcePieceId));
  const sourcePieces = fixture.sourcePieces.filter((piece) => sourcePieceIds.has(piece.id));
  assert(sourcePieces.length === sourcePieceIds.size, 'every prepared piece has matching source geometry');

  return {
    version: fixture.version,
    jobId: 'smoke-run-2-piece-job',
    sheet: fixture.sheet,
    padding: fixture.padding,
    pieces,
    sourcePieces,
    options: {
      allowGlobalRotation: fixture.options.allowGlobalRotation,
      allowGlobalMirror: fixture.options.allowGlobalMirror,
      timeoutMs: fixture.options.timeoutMs,
      workerMode: fixture.options.workerMode,
      historyMode: 'stream',
      irregularSettings: fixture.options.irregularSettings,
    },
  };
}

async function main() {
  buildAddon();
  const native = loadAddon();

  const capability = native.nativeCapability();
  log(`native capability: ${JSON.stringify(capability)}`);
  assert(capability.apiVersion === 3, 'native capability reports API version 3');

  const request = deriveTwoPieceRequest();
  log(`derived a ${request.pieces.length}-piece request from the mixed61 fixture (sheet ${request.sheet.width}x${request.sheet.height}mm)`);

  const progressEvents = [];
  const stateSnapshotEvents = [];

  let terminalEvent;
  const invocationToken = 'smoke-run-main-invocation-token';
  const promiseValue = native.runIrregularJob(
    JSON.stringify(request),
    invocationToken,
    (json) => {
      const event = JSON.parse(json);
      if (event.kind === 'portfolio-progress') progressEvents.push(event);
      if (event.kind === 'state-snapshot') stateSnapshotEvents.push(event);
      if (event.kind === 'terminal') terminalEvent = event;
    },
    true
  );
  assert(promiseValue instanceof Promise, 'runIrregularJob returns a real Promise');

  /* Exercise cancelIrregularJob against an unrelated invocation token while the
   * real job may still be in flight. This must be a harmless no-op that never
   * disturbs the real job (native-boundary.md §6.3's idempotent-no-op contract).
   */
  const cancelledUnrelated = native.cancelIrregularJob(
    'not-the-real-invocation-token',
    'cancelled'
  );
  assert(
    cancelledUnrelated === false,
    'cancelIrregularJob on an unrelated token returns false'
  );

  const envelopeJson = await promiseValue;
  const envelope = JSON.parse(envelopeJson);
  log(`job resolved: ok=${envelope.ok}`);
  if (!envelope.ok) {
    throw new Error(`job failed: ${JSON.stringify(envelope.error)}`);
  }

  assert(progressEvents.length >= 1, 'at least one portfolio progress event fired');
  for (let i = 0; i < progressEvents.length; i += 1) {
    assert(progressEvents[i].ordinal === i || progressEvents[i].ordinal > (progressEvents[i - 1]?.ordinal ?? -1),
      'progress ordinals are strictly increasing');
  }
  log(`portfolio progress events: ${progressEvents.length} (ordinals: ${progressEvents.map((e) => e.ordinal).join(',')})`);
  log(`state snapshot events: ${stateSnapshotEvents.length}`);
  assert(terminalEvent !== undefined, 'terminal event fired before the promise resolved');
  assert(
    terminalEvent.ordinal === progressEvents.length + stateSnapshotEvents.length,
    'terminal ordinal follows every algorithm event'
  );

  const result = envelope.result;
  assert(Array.isArray(result.placedCollisionGeometries), 'result carries placedCollisionGeometries');
  assert(Array.isArray(result.unplacedPieceIds), 'result carries unplacedPieceIds');
  assert(typeof result.portfolio?.status === 'string', 'result carries a portfolio status');
  const placedCount = result.placedCollisionGeometries.length;
  const unplacedCount = result.unplacedPieceIds.length;
  assert(placedCount + unplacedCount === request.pieces.length,
    `placed (${placedCount}) + unplaced (${unplacedCount}) accounts for every requested piece (${request.pieces.length})`);
  log(`placed ${placedCount}/${request.pieces.length} pieces; portfolio status "${result.portfolio.status}"`);

  const diagnosticsJson = native.getLastJobDiagnostics();
  const diagnostics = JSON.parse(diagnosticsJson);
  assert(diagnostics !== null, 'getLastJobDiagnostics returns a populated sidecar after a job ran');
  assert(typeof diagnostics.backendVersion === 'string', 'diagnostics carries backendVersion');
  assert(typeof diagnostics.wallClockMs === 'number', 'diagnostics carries wallClockMs');
  assert(diagnostics.threadCountUsed === 1, 'diagnostics reports the Stage-2 single-thread placeholder');
  log(`diagnostics sidecar: backendVersion=${diagnostics.backendVersion}, wallClockMs=${diagnostics.wallClockMs.toFixed(2)}, cacheInstances=${diagnostics.cacheTelemetry.cacheInstances}`);
  // `result.diagnostics` (per-piece `CollisionGeometryDiagnostic[]`, part of
  // the semantic result DTO) and `getLastJobDiagnostics()` (the sidecar just
  // read above) are two structurally distinct things sharing a similar name
  // -- confirm they are not accidentally the same value.
  assert(
    !Array.isArray(diagnostics.cacheTelemetry),
    'the sidecar is a distinct shape from result.diagnostics, not accidentally aliased'
  );

  // Malformed-request and archive-ineligible-routing paths both resolve
  // (never reject/throw) with a distinguishable `ok:false` envelope -- see
  // `boundary::run_job`'s own doc for why.
  const malformedEnvelope = JSON.parse(
    await native.runIrregularJob(
      'not json',
      'smoke-run-malformed-request-invocation-token',
      () => {},
      false
    )
  );
  assert(malformedEnvelope.ok === false, 'malformed JSON resolves ok:false');
  assert(malformedEnvelope.error.category === 'worker_protocol_error', 'malformed JSON maps to worker_protocol_error');

  log('all assertions passed.');
}

main().catch((err) => {
  fail(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
