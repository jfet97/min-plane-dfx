# PR 27 Rust irregular backend handoff

Date: 2026-07-30
Branch: `rust-irregular-backend`
Pre-checkpoint HEAD: `06120d42141f7a6fb7b28de20dd7cf4d989a87ac`
Remote: `origin` (`git@github.com:jfet97/min-plane-dfx.git`)

This document is an emergency durable handoff before a full computer restart. The working implementation, generated corpora, tests, documentation, this handoff, and a repository copy of the remediation plan are committed and pushed together by the session that wrote this file.

## Binding contract

- Port only archive-eligible Compact and Compact Short Side irregular nesting to Rust.
- Keep rectangular nesting in TypeScript.
- Keep the TypeScript irregular backend maintained as the alternative, differential oracle, fallback, and rollback path.
- Preserve exact TypeScript and Node/V8 behavior: fixtures, accepted hashes, comparator winners, traces, ledgers, checkpoints, tolerances, layouts, area, cavities, history, and output quality.
- Accept execution-time improvements only.
- Merge the corrected implementation with the custom Node/V8-compatible two-argument `Math.hypot` implementation first.
- Test `f64::hypot` and `libm::hypot` only after the custom implementation is merged.
- Use Rayon only for pure deterministic work. Shared cache behavior and performance are first-class constraints.
- Do not modify `knowledge/dependencies/`. Dependency drift auditing is explicitly out of scope.
- Do not alter baselines or tolerances to make tests pass.
- Do not add AI attribution or co-author footers.

The full approved 15-section plan is copied to `PR27-REMEDIATION-PLAN.md` in the repository root. The original Claude plan file is `/Users/andreasimonecosta/.claude/plans/warm-mapping-lemur.md`.

## Completed remediation sections

### Section 2: Node/V8 `Math.hypot` parity

Completed:

- Added a custom Node/V8-compatible two-argument hypot implementation.
- Routed the production flattening semantic call sites through it.
- Added a reproducible Node 24 oracle with 21,696 exact binary64 vectors.
- Added Rust bit-exact corpus tests.
- Pinned Node to 24.11.1 through `.node-version` and CI changes.
- Corrected stale documentation about implementation provenance and reachability.
- Preserved unrelated transcendental operations and source-faithful Clipper operations.

Key files:

- `.node-version`
- `scripts/rust-parity/dump-js-hypot.ts`
- `crates/irregular-nesting-native/src/js_number/js_math.rs`
- `crates/irregular-nesting-native/src/transforms/flattening.rs`
- `crates/irregular-nesting-native/tests/js_hypot_vectors.rs`
- `crates/irregular-nesting-native/tests/vectors/js-hypot.json`

Prior required matrix evidence: 16/16 required differential rows passed after the custom hypot correction.

### Section 3: native trust-boundary validation

Completed strict Rust revalidation for direct N-API requests, including:

- positive and non-negative safe integers;
- safe-integer millimeter fields;
- finite transforms and configured rotations;
- non-empty seeds and identity strings;
- policy membership and uniqueness;
- Compact Short Side cross-field rules;
- worker mode, timeout, piece identity, duplicate IDs, and JSON numeric overflow.

Key file: `crates/irregular-nesting-native/src/boundary/request.rs`.

Latest focused Rust boundary run after section 5: 66/66 passed.

### Section 4: complete native history and snapshot fidelity

Completed:

- Native snapshots carry the complete ordered `remainingPreparedPieces` queue, not IDs only.
- TypeScript decodes each prepared piece through the shared schema and rebuilds `IrregularBeamState` with the full queue.
- Returned and streamed queues preserve order and values.
- History frame titles and `remainingPieceIds` now match TypeScript for initial, intermediate, and final snapshots.
- Differential projection and coordinator vectors compare complete queues exactly.
- Mixed-61 four-piece differential matched across five snapshots for Compact and Compact Short Side.
- Coordinator corpus remains 114 cases; 476 snapshots contain the full queue.

Key files:

- `crates/irregular-nesting-native/src/boundary/result.rs`
- `src/workers/irregular/native/nativeIrregularBackend.ts`
- `scripts/rust-parity/run-differential.ts`
- `scripts/rust-parity/dump-coordinator.ts`
- `crates/irregular-nesting-native/tests/coordinator_vectors.rs`
- `crates/irregular-nesting-native/tests/vectors/coordinator.json`
- `tests/unit/nativeIrregularBackend.test.ts`

## Section 5 current implementation

Section 5 is implemented in the working tree and focused verification is green, but it must not be declared closed until the pending Sol xhigh re-review returns an approval or all new findings are resolved.

### Implemented event contract

- Native API contract version is now exactly 2.
- Progress, state snapshots, and terminal use one tagged JSON event channel and one Rust-owned ordinal sequence.
- Retained result snapshots remain ordinal-free and keep the full prepared-piece queue.
- Rust ordinary events use checked nonblocking TSFN calls.
- Rust terminal delivery uses `ThreadsafeFunction::call_with_return_value`.
- Native completion blocks until JavaScript has received and returned from the terminal callback.
- No new fixed terminal acknowledgment timeout exists.
- A disconnected acknowledgment channel maps to the actual N-API status name `Closing`; synthetic status strings such as `TerminalAckTimeout` are not used.
- The first native delivery failure becomes a sanitized `worker_protocol_error` with operation `nativeEventDelivery` and only `napiStatus` in context.
- TypeScript captures transport and envelope outcomes as data, drains the callback tail, closes the dispatcher, then applies deterministic failure precedence.
- The injected test seam is the narrow `NativeIrregularJobTransport`, not the full addon and not a second callback seam.
- Production callback types remain `Effect<void, never>`.
- Callback failures are sanitized and cannot leak user callback errors.
- Transport resolution without terminal is a typed `nativeEventTerminal` protocol failure.
- Post-terminal input before settlement is a typed `nativeEventAfterTerminal` failure.
- Events attempted after adapter settlement are suppressed by the closed latch.
- Cancellation polling is stopped in one idempotent cleanup path.

Key files:

- `crates/irregular-nesting-native/src/boundary/events.rs`
- `crates/irregular-nesting-native/src/boundary/job.rs`
- `crates/irregular-nesting-native/src/boundary/error.rs`
- `crates/irregular-nesting-native/src/lib.rs`
- `src/workers/irregular/native/loadNativeBackend.ts`
- `src/workers/irregular/native/nativeIrregularBackend.ts`
- `tests/unit/nativeIrregularBackend.test.ts`
- `crates/irregular-nesting-native/scripts/smoke-run.mjs`
- `.github/workflows/rust-native.yml`
- `docs/planning/rust-irregular-backend/native-boundary.md`

### Important dispatcher semantic choice

The latest lifecycle test starts a delayed progress callback, yields so that callback is already running, queues a snapshot, then delivers malformed JSON. The dispatcher:

- awaits the already-running progress callback;
- suppresses the queued snapshot after the protocol failure;
- drains the promise tail;
- exposes `nativeEventDecode` only afterward.

The focused test name is `drains delayed progress but suppresses a queued snapshot after a malformed event` in `tests/unit/nativeIrregularBackend.test.ts`.

### Fresh verification after the latest edits

Run directly by the controlling session:

- `pnpm typecheck`: PASS.
- `pnpm exec vitest run tests/unit/nativeIrregularBackend.test.ts`: PASS, 22/22.
- `cargo fmt --check --manifest-path crates/irregular-nesting-native/Cargo.toml`: PASS.
- `cargo test --manifest-path crates/irregular-nesting-native/Cargo.toml boundary::`: PASS, 66/66 focused boundary tests, 0 failed.
- `git diff --check`: PASS.
- `mcp__ide__getDiagnostics`: no diagnostics.

Additional agent verification:

- Full Rust crate suite: 560 passed.
- Real native smoke: PASS with `apiVersion: 2`, 4 progress events, 3 state snapshots, and terminal receipt before native promise resolution.
- Release addon rebuild plus native adapter suite: PASS, 22/22.

No baseline, tolerance, accepted hash, output-quality rule, or fixture expectation was relaxed.

## Sol gpt-5.6-sol xhigh review state

### Previous completed Sol review

The previous Sol xhigh implementation review returned `VERDICT: NEEDS_CHANGES` with four verified findings:

- F1 CRITICAL: plain nonblocking terminal enqueue was not an acknowledgment barrier under napi-rs semantics.
- F2 MAJOR: failure paths could settle before already-running callback work drained.
- F3 MAJOR: the fake seam and tests missed lifecycle races such as missing terminal, pending callback plus transport failure, and delayed post-terminal input.
- F4 MAJOR: API v2 fail-closed checks were incomplete in CI, smoke, stale-addon handling, and documentation.

The current implementation was written to resolve all four findings.

Previous review output path before reboot: `/tmp/codex-section5-design-reply-20a84392.txt`. That `/tmp` file may disappear after reboot, so the four findings are preserved above.

### Pending final Sol re-review

A new read-only Sol xhigh review was launched against the corrected implementation.

- Model: `gpt-5.6-sol`
- Reasoning effort: `xhigh`
- Codex thread ID: `019fb346-12fe-7d63-8a4a-e4555f75320d`
- Persistent Codex rollout:
  `/Users/andreasimonecosta/.codex/sessions/2026/07/30/rollout-2026-07-30T15-45-41-019fb346-12fe-7d63-8a4a-e4555f75320d.jsonl`
- Prompt before reboot: `/tmp/codex-section5-rereview-prompt.txt`
- Transport events before reboot: `/tmp/codex-section5-rereview-events.jsonl`
- Transport stderr before reboot: `/tmp/codex-section5-rereview-stderr.txt`
- Expected reply path before reboot: `/tmp/codex-section5-rereview-reply.txt`

The launcher was killed by the tool timeout after 10 minutes with exit 143. The retained rollout continued for a while, reached 165 JSONL lines, but had not emitted `turn.completed` or a final verdict when this handoff was written. It then stopped growing. There is no valid final reply yet.

The complete review prompt is preserved below so the review can be resumed even if `/tmp` is cleared:

```text
Re-read the current section 5 focus files directly. Re-evaluate previous findings F1 through F4. Adversarially verify ordering, call_with_return_value acknowledgment, no fixed timeout, actual N-API status vocabulary, failure precedence, tail drain, cancellation timer cleanup, callback suppression, terminal state, error sanitization, stale-addon behavior, exact API v2 CI/smoke assertions, and full remainingPreparedPieces fidelity. Include F1-F4 with lifecycle status and return only Findings plus VERDICT: APPROVED or VERDICT: NEEDS_CHANGES.
```

Recommended resume command after reboot, from the repository root:

```sh
zsh -ic "cx -a never exec resume --json 019fb346-12fe-7d63-8a4a-e4555f75320d --model gpt-5.6-sol -c 'model_reasoning_effort=\"xhigh\"' -c 'sandbox_mode=\"read-only\"' -o /tmp/codex-section5-rereview-resumed-reply.txt -" <<'PROMPT'
The prior launcher timed out before your final reply. Re-read the current working tree because it may have changed. Return the strict F1-F4 findings table and final verdict requested in the previous turn. Do not edit files, spawn agents, inspect knowledge/dependencies, or invoke nested reviewers.
PROMPT
```

After the launcher exits, do not assume the retained turn completed. Check the reply plus `turn.completed` in the new event stream or persistent rollout. If the session cannot be resumed, start a fresh one-shot review using the focus list in this document.

## Workflow and agent references

### Dynamic workflow

A dynamic workflow named `Design, implement, and review ordered terminal-safe native callbacks` completed.

- Workflow run ID: `wf_283a2b53-6ed`
- Persisted script:
  `/Users/andreasimonecosta/.claude/projects/-Users-andreasimonecosta-Documents-Work-min-plane-dfx/20a84392-48f4-4599-96cb-edf4be977132/workflows/scripts/ordered-native-callbacks-wf_283a2b53-6ed.js`
- Workflow journal:
  `/Users/andreasimonecosta/.claude/projects/-Users-andreasimonecosta-Documents-Work-min-plane-dfx/20a84392-48f4-4599-96cb-edf4be977132/subagents/workflows/wf_283a2b53-6ed/journal.jsonl`
- Usage: 3 agents, all completed, 561,249 subagent tokens, 197 tool uses.

The workflow's original design predated Sol's terminal acknowledgment finding, so its nonblocking terminal recommendation is obsolete. The current working tree and the acknowledged-close design in this handoff supersede that part of the workflow output.

### Main section 5 implementation agent

- Agent/task ID: `a9b9d6bf8c58a3784`
- Output before reboot:
  `/private/tmp/claude-501/-Users-andreasimonecosta-Documents-Work-min-plane-dfx/7521aa37-a6b7-4238-a763-78329df20834/tasks/a9b9d6bf8c58a3784.output`
- It implemented the corrected acknowledged-close contract, narrow seam, lifecycle tests, API v2 checks, docs, and focused verification.
- It was resumed once after a stream disconnect, then completed.

### Independent reviewer agent

- Agent/task ID: `af060f059d78aacb1`
- Output before reboot:
  `/private/tmp/claude-501/-Users-andreasimonecosta-Documents-Work-min-plane-dfx/7521aa37-a6b7-4238-a763-78329df20834/tasks/af060f059d78aacb1.output`
- It found a transient mid-edit failure where a protocol failure skipped a progress callback that had not started. The final implementation changed the test to guarantee progress is already running before malformed input, then proved that running work drains while the queued snapshot is suppressed. Final focused tests pass 22/22.

## Knowledge base

Meaningful work was documented locally in the git-ignored knowledge base:

- `knowledge/native-state-snapshot-fidelity.md`
- `knowledge/native-event-channel.md`
- `knowledge/INDEX.md`
- `knowledge/.audit/log.md`

Do not modify `knowledge/dependencies/`.

## Current task list at handoff

- #19 in progress: Make native callbacks ordered and terminal-safe.
- #20 completed: Design ordered native event protocol.
- #21 completed: Add callback ordering red tests.
- #22 in progress: Implement ordered callback dispatcher.
- #23 in progress: Verify callback ordering remediation.
- #24 completed: Inspect native and TypeScript event paths.
- #25 completed: Design unified native event protocol.
- #26 completed: Review remediation section 5.

Tasks #19, #22, and #23 should remain open until Sol xhigh returns approval and any surviving findings are resolved. There are no scheduled cron jobs.

## Working tree scope captured by the checkpoint

Before adding this handoff and the root plan copy, the tree contained 27 modified tracked files plus four untracked files, with approximately 210,399 insertions and 1,223 deletions. The large insertion count is primarily the regenerated coordinator vector corpus.

Modified tracked files:

- `.github/workflows/capacity-quality.yml`
- `.github/workflows/rust-native.yml`
- `crates/irregular-nesting-native/Cargo.toml`
- `crates/irregular-nesting-native/scripts/smoke-run.mjs`
- `crates/irregular-nesting-native/src/boundary/error.rs`
- `crates/irregular-nesting-native/src/boundary/events.rs`
- `crates/irregular-nesting-native/src/boundary/job.rs`
- `crates/irregular-nesting-native/src/boundary/request.rs`
- `crates/irregular-nesting-native/src/boundary/result.rs`
- `crates/irregular-nesting-native/src/canonical_grid/contact.rs`
- `crates/irregular-nesting-native/src/js_number/js_math.rs`
- `crates/irregular-nesting-native/src/lib.rs`
- `crates/irregular-nesting-native/src/search/layout_scorer.rs`
- `crates/irregular-nesting-native/src/transforms/flattening.rs`
- `crates/irregular-nesting-native/src/transforms/generator.rs`
- `crates/irregular-nesting-native/tests/coordinator_vectors.rs`
- `crates/irregular-nesting-native/tests/vectors/coordinator.json`
- `docs/planning/rust-irregular-backend/acceptance-checklist.md`
- `docs/planning/rust-irregular-backend/evidence/differential-e2e-report.md`
- `docs/planning/rust-irregular-backend/evidence/performance-report.md`
- `docs/planning/rust-irregular-backend/native-boundary.md`
- `docs/planning/rust-irregular-backend/stage0-rulings.md`
- `scripts/rust-parity/dump-coordinator.ts`
- `scripts/rust-parity/run-differential.ts`
- `src/workers/irregular/native/loadNativeBackend.ts`
- `src/workers/irregular/native/nativeIrregularBackend.ts`
- `tests/unit/nativeIrregularBackend.test.ts`

Untracked files before the checkpoint:

- `.node-version`
- `crates/irregular-nesting-native/tests/js_hypot_vectors.rs`
- `crates/irregular-nesting-native/tests/vectors/js-hypot.json`
- `scripts/rust-parity/dump-js-hypot.ts`

The checkpoint also adds:

- `HANDOFF.md`
- `PR27-REMEDIATION-PLAN.md`

## Immediate next steps after reboot

1. Pull or switch to `rust-irregular-backend` and verify this checkpoint commit is present.
2. Run `git status --short`. The checkpoint should leave a clean tree unless local ignored build artifacts differ.
3. Resume the persistent Sol xhigh review using thread `019fb346-12fe-7d63-8a4a-e4555f75320d`, or start a fresh read-only Sol xhigh review if resume fails.
4. Verify every previous finding F1-F4 is `RESOLVED` or `WITHDRAWN`. Resolve any new Sol finding and re-review until approved.
5. Re-run:
   - `pnpm typecheck`
   - `pnpm exec vitest run tests/unit/nativeIrregularBackend.test.ts`
   - `cargo fmt --check --manifest-path crates/irregular-nesting-native/Cargo.toml`
   - `cargo test --manifest-path crates/irregular-nesting-native/Cargo.toml boundary::`
   - `node crates/irregular-nesting-native/scripts/smoke-run.mjs`
   - `git diff --check` against the checkpoint if additional edits are made
   - IDE diagnostics
6. Only after Sol approval, mark section 5 tasks complete and continue section 6: real runtime differential mode.
7. Continue the remaining plan sections in order: runtime differential, cancellation RPC, cancellation ownership, bounded cache, redundant NFP pre-pass removal, packaging, licensing, CI integrity, full verification, explicit merge approval, then post-merge hypot experiments.

## Commit and push policy after this emergency checkpoint

The user explicitly authorized this emergency checkpoint commit and push so the computer can be restarted safely. That authorization applies to this handoff checkpoint only. After reboot, return to the standing rule: do not commit, push, merge, or alter baselines unless the user explicitly authorizes the next outward-facing action.
