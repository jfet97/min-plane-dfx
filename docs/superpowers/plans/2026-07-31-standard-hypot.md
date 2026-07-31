# Standard Rust Hypot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the custom V8-compatible `hypot` algorithm and use Rust's standard `f64::hypot` while keeping final geometry, quality, determinism, and supported-platform behavior authoritative.

**Architecture:** Keep `js_number::js_math::hypot` as the single audited production boundary, but reduce it to one `x.hypot(y)` call. Convert the committed Node/V8 corpus from a bit-exact production requirement into bounded diagnostic characterization, keep exact cross-backend comparison visible, and make quality acceptance the blocking CI lane.

**Tech Stack:** Rust 2021, napi-rs, TypeScript, Vitest, Cargo, GitHub Actions, pnpm, Electron packaging.

---

## File structure

- `crates/irregular-nesting-native/src/js_number/js_math.rs`: one-line standard-library implementation and focused numerical safety tests.
- `crates/irregular-nesting-native/tests/js_hypot_vectors.rs`: diagnostic Node/V8 corpus characterization with bounded ULP and classification safety.
- `crates/irregular-nesting-native/src/canonical_grid/contact.rs`: remove obsolete exact-V8 requirement comments while preserving semantic call-site documentation.
- `crates/irregular-nesting-native/src/search/layout_scorer.rs`: update the semantic distance documentation.
- `crates/irregular-nesting-native/src/transforms/flattening.rs`: update the production call-site documentation.
- `crates/irregular-nesting-native/src/transforms/generator.rs`: update the production call-site documentation.
- `scripts/rust-parity/run-differential.ts`: add an explicit diagnostic mode that reports semantic divergence without converting it into a process failure.
- `scripts/rust-parity/differential-fixture-matrix.ts`: run exact comparison through diagnostic mode while retaining operational failures as blocking.
- `package.json`: expose exact diagnostic and quality-blocking commands clearly.
- `.github/workflows/rust-native.yml`: run quality acceptance for pull requests and execute the hypot characterization test on every supported packaged target.
- `scripts/verify-native-package-layout.test.mjs`: statically enforce the new CI commands and ordering.
- `docs/planning/rust-irregular-backend/js-semantics-audit.md`: record the superseded exact-V8 decision.
- `docs/planning/rust-irregular-backend/quality-acceptance.md`: document quality-equivalent hash acceptance.
- `docs/planning/rust-irregular-backend/evidence/performance-report.md`: record the maintenance-first standard-library decision and measured non-material timing.
- `knowledge/native-hypot-parity.md`: replace the old custom implementation pattern with the standard-library boundary and diagnostic corpus evidence.
- `knowledge/INDEX.md`: update the hypot page summary.

### Task 1: Convert the corpus test into diagnostic numerical characterization

**Files:**
- Modify: `crates/irregular-nesting-native/tests/js_hypot_vectors.rs`

- [ ] **Step 1: Add an ordered ULP helper and replace the exact-parity assertion**

Use this helper for non-NaN values:

```rust
fn ordered_bits(value: f64) -> u64 {
    let bits = value.to_bits();
    if bits & (1_u64 << 63) == 0 {
        bits | (1_u64 << 63)
    } else {
        !bits
    }
}

fn ulp_distance(first: f64, second: f64) -> u64 {
    ordered_bits(first).abs_diff(ordered_bits(second))
}
```

Replace `custom_hypot_matches_committed_node_v8_oracle` with `standard_hypot_stays_within_the_documented_node_v8_envelope`. Preserve every corpus metadata assertion. For each vector:

- require NaN classification equality;
- require infinity classification and sign equality;
- count finite exact matches and ULP mismatches;
- require every finite mismatch to be at most 2 ULPs;
- print exact matches, mismatch count, 1-ULP count, 2-ULP count, and maximum ULP distance.

Use these final assertions:

```rust
assert_eq!(classification_mismatches, 0);
assert!(maximum_ulp_distance <= 2);
assert_eq!(exact_matches + ulp_mismatches, finite_or_infinite_cases);
```

Do not require the platform to reproduce the macOS-specific count of 521 mismatches. Record that count in documentation as observed evidence.

- [ ] **Step 2: Run the test against the custom implementation and verify RED**

Run:

```bash
cargo test --release --manifest-path crates/irregular-nesting-native/Cargo.toml --test js_hypot_vectors -- --nocapture
```

Expected: FAIL because the custom implementation has zero ULP mismatches and the test name and expected standard-library characterization are not yet satisfied by the production function. If the bounded assertions alone pass, add `assert!(ulp_mismatches > 0)` so the RED test proves the production implementation has changed away from the custom oracle clone.

- [ ] **Step 3: Commit the RED test separately**

```bash
git add crates/irregular-nesting-native/tests/js_hypot_vectors.rs
git commit -m "test: characterize standard hypot variance"
```

### Task 2: Replace the custom algorithm with `f64::hypot`

**Files:**
- Modify: `crates/irregular-nesting-native/src/js_number/js_math.rs:230-289,410-450`

- [ ] **Step 1: Add focused standard-library safety assertions**

Add or retain this test:

```rust
#[test]
fn hypot_delegates_to_standard_rounding_and_handles_extremes() {
    let cases = [
        (1.0_f64, 1.4142135623730951_f64),
        (f64::MAX, f64::MIN_POSITIVE),
        (1e308, 1e-308),
        (1e-300, 1e-300),
        (-3.0, 4.0),
        (4.0, -3.0),
    ];

    for (x, y) in cases {
        assert_eq!(hypot(x, y).to_bits(), x.hypot(y).to_bits());
        assert_eq!(hypot(x, y).to_bits(), hypot(y, x).to_bits());
    }
}
```

Keep the existing infinity-before-NaN behavior test only if `f64::hypot` passes it on the supported Rust toolchain. If standard Rust returns NaN for `(Infinity, NaN)`, update the test to standard-library behavior rather than reintroducing custom branching.

- [ ] **Step 2: Verify the focused test fails before implementation**

Run:

```bash
cargo test --release --manifest-path crates/irregular-nesting-native/Cargo.toml js_math::tests::hypot_delegates_to_standard_rounding_and_handles_extremes -- --exact --nocapture
```

Expected: FAIL on at least the known one-ULP vector.

- [ ] **Step 3: Replace the custom body and documentation**

Replace the custom implementation with:

```rust
/// Two-argument Euclidean norm used by semantic geometry and scoring paths.
///
/// Final geometry, quality, and deterministic output are authoritative. The
/// committed Node/V8 corpus remains diagnostic characterization of bounded
/// binary64 differences from JavaScript.
pub fn hypot(x: f64, y: f64) -> f64 {
    x.hypot(y)
}
```

Delete the normalization, compensated summation, special-value branches, and obsolete implementation-specific comments.

- [ ] **Step 4: Run focused and corpus tests GREEN**

```bash
cargo test --release --manifest-path crates/irregular-nesting-native/Cargo.toml js_math::tests::hypot_delegates_to_standard_rounding_and_handles_extremes -- --exact --nocapture
cargo test --release --manifest-path crates/irregular-nesting-native/Cargo.toml --test js_hypot_vectors -- --nocapture
```

Expected: PASS. The local corpus output should report the known macOS characterization near 21,175 exact matches, 505 one-ULP mismatches, 16 two-ULP mismatches, and no classification mismatch.

- [ ] **Step 5: Commit the implementation**

```bash
git add crates/irregular-nesting-native/src/js_number/js_math.rs
git commit -m "refactor: use standard Rust hypot"
```

### Task 3: Remove obsolete exact-V8 production claims

**Files:**
- Modify: `crates/irregular-nesting-native/src/canonical_grid/contact.rs`
- Modify: `crates/irregular-nesting-native/src/search/layout_scorer.rs`
- Modify: `crates/irregular-nesting-native/src/transforms/flattening.rs`
- Modify: `crates/irregular-nesting-native/src/transforms/generator.rs`

- [ ] **Step 1: Find every obsolete claim**

Run:

```bash
rg -n "Node/V8-compatible|bit-exact|21,696-vector|not `f64::hypot`|js_math::hypot" crates/irregular-nesting-native/src
```

- [ ] **Step 2: Rewrite comments without changing call sites**

Use this wording pattern where the result reaches semantic output:

```rust
/*
 * The semantic distance routes through js_math::hypot so production geometry
 * and scoring share one audited standard-library boundary. Final quality and
 * deterministic output are blocking; Node/V8 ULP differences are diagnostic.
 */
```

Retain call-site-specific explanations about which score, metric, or comparator consumes the value. Do not change any function body outside `js_math::hypot`.

- [ ] **Step 3: Verify only comments changed**

```bash
git diff --word-diff=plain -- crates/irregular-nesting-native/src/canonical_grid/contact.rs crates/irregular-nesting-native/src/search/layout_scorer.rs crates/irregular-nesting-native/src/transforms/flattening.rs crates/irregular-nesting-native/src/transforms/generator.rs
cargo fmt --manifest-path crates/irregular-nesting-native/Cargo.toml -- --check
```

Expected: production expressions remain identical.

- [ ] **Step 4: Commit the documentation cleanup**

```bash
git add crates/irregular-nesting-native/src/canonical_grid/contact.rs crates/irregular-nesting-native/src/search/layout_scorer.rs crates/irregular-nesting-native/src/transforms/flattening.rs crates/irregular-nesting-native/src/transforms/generator.rs
git commit -m "docs: update native hypot semantics"
```

### Task 4: Make exact differential comparison diagnostic and quality acceptance blocking

**Files:**
- Modify: `scripts/rust-parity/run-differential.ts:450-500`
- Modify: `scripts/rust-parity/differential-fixture-matrix.ts:100-210`
- Modify: `package.json:36-41`
- Modify: `.github/workflows/rust-native.yml:155-244`
- Test: `scripts/verify-native-package-layout.test.mjs`

- [ ] **Step 1: Add failing static CI contract assertions**

In `scripts/verify-native-package-layout.test.mjs`, require:

- the differential matrix command to pass `--diagnostic` to exact comparisons;
- the quality-acceptance job to run for pull requests, schedules, and manual dispatches;
- `pnpm gate:quality-acceptance` to execute after a release addon build;
- the exact differential output to remain present in CI.

Run:

```bash
node --test scripts/verify-native-package-layout.test.mjs
```

Expected: FAIL because the workflow still treats required exact divergence as blocking and skips quality acceptance on pull requests.

- [ ] **Step 2: Add the diagnostic CLI flag**

In `scripts/rust-parity/run-differential.ts`, parse:

```ts
const diagnostic = process.argv.includes('--diagnostic')
```

When `compareIrregularDifferentialOutcomes` returns a divergence, always print the first path and both values. Then:

```ts
if (!diagnostic) {
  fail('the compared semantic outcome diverged between backends.')
}
console.error('[run-differential] diagnostic divergence accepted for quality evaluation')
return
```

Do not suppress native availability failures, typed backend failures, malformed output, timeout failures, or process failures.

- [ ] **Step 3: Pass diagnostic mode through the fixture matrix**

Append `--diagnostic` to every `run-differential.ts` child invocation in `scripts/rust-parity/differential-fixture-matrix.ts`. Keep required and exploratory execution coverage unchanged. A child process still fails for operational errors.

- [ ] **Step 4: Clarify package scripts**

Use:

```json
"test:differential": "tsx --tsconfig tsconfig.node.json scripts/rust-parity/differential-fixture-matrix.ts --required-only",
"test:differential:exact": "tsx --tsconfig tsconfig.node.json scripts/rust-parity/differential-fixture-matrix.ts --required-only --strict-exact"
```

Add `--strict-exact` handling to omit `--diagnostic` when a developer explicitly requests the historical blocking lane.

- [ ] **Step 5: Make the six-row quality gate run on pull requests**

Remove the event filter from `quality-acceptance` or change it so the job runs on pull requests, schedules, and manual dispatches. Preserve the explicit release addon build before `pnpm gate:quality-acceptance`.

- [ ] **Step 6: Run focused checks**

```bash
node --test scripts/verify-native-package-layout.test.mjs
pnpm test:differential
pnpm gate:quality-acceptance
```

Expected: PASS. Exact differences, if any, are logged; hard failures and quality regressions remain nonzero exits.

- [ ] **Step 7: Commit the policy wiring**

```bash
git add scripts/rust-parity/run-differential.ts scripts/rust-parity/differential-fixture-matrix.ts package.json .github/workflows/rust-native.yml scripts/verify-native-package-layout.test.mjs
git commit -m "test: make native quality the blocking gate"
```

### Task 5: Add supported-platform hypot characterization

**Files:**
- Modify: `.github/workflows/rust-native.yml:246-306`
- Modify: `scripts/verify-native-package-layout.test.mjs`

- [ ] **Step 1: Extend the static workflow test RED**

Require every `packaged-native-load` matrix entry to execute:

```bash
cargo test --release --manifest-path "$CRATE_MANIFEST" --target "${{ matrix.cargo_target }}" --test js_hypot_vectors -- --nocapture
```

Run:

```bash
node --test scripts/verify-native-package-layout.test.mjs
```

Expected: FAIL before workflow modification.

- [ ] **Step 2: Add the native-target characterization step**

After toolchain setup and before building the addon, add:

```yaml
- name: Characterize standard hypot on target
  run: cargo test --release --manifest-path "$CRATE_MANIFEST" --target "${{ matrix.cargo_target }}" --test js_hypot_vectors -- --nocapture
```

This runs natively on Linux x64, Windows x64, macOS arm64, and macOS x64. It blocks only classification errors or variance beyond the documented 2-ULP envelope.

- [ ] **Step 3: Run the static workflow test GREEN**

```bash
node --test scripts/verify-native-package-layout.test.mjs
```

Expected: PASS.

- [ ] **Step 4: Commit the platform gate**

```bash
git add .github/workflows/rust-native.yml scripts/verify-native-package-layout.test.mjs
git commit -m "ci: characterize standard hypot on supported targets"
```

### Task 6: Run complete local quality, determinism, and performance verification

**Files:**
- Evidence output only under `/tmp/min-plane-standard-hypot-*`

- [ ] **Step 1: Confirm no competing benchmark process**

```bash
ps -axo pid,etime,%cpu,command | rg "measure-p5-aggregate|irregular-compact|irregular-capacity|time-native-backend" || true
```

Do not overlap CPU-heavy commands.

- [ ] **Step 2: Build the release addon**

```bash
pnpm build:native
```

Expected: staged host addon under `crates/irregular-nesting-native/npm/`.

- [ ] **Step 3: Run all 18 maintained layouts through the Rust quality-aware P5 arms**

Run serially:

```bash
pnpm exec tsx --tsconfig tsconfig.node.json scripts/rust-parity/measure-p5-aggregate.ts --suite C5 --rust-threads default --samples 1 --output /tmp/min-plane-standard-hypot-c5/report.json
pnpm exec tsx --tsconfig tsconfig.node.json scripts/rust-parity/measure-p5-aggregate.ts --suite C7 --rust-threads default --samples 1 --output /tmp/min-plane-standard-hypot-c7/report.json
```

Expected: nine valid Compact rows and nine valid Short Side rows, with every unchanged hard and quality check passing. Preserve changed hashes as evidence rather than failure when quality passes.

- [ ] **Step 4: Run the six-row backend promotion gate**

```bash
pnpm gate:quality-acceptance
```

Expected: 6/6 rows accepted as either `exact-match` or `different-but-quality-accepted`.

- [ ] **Step 5: Run capacity gates**

```bash
pnpm gate:capacity:production
pnpm gate:capacity
```

Expected: unchanged settlement, routing, chronology, cold-depth, objective, accounting, and quality contracts pass.

- [ ] **Step 6: Run complete thread equality and repeatability**

```bash
cargo test --release --manifest-path crates/irregular-nesting-native/Cargo.toml --test thread_equality -- --nocapture
cargo test --release --manifest-path crates/irregular-nesting-native/Cargo.toml --test coordinator_vectors -- --nocapture
```

Expected: identical semantic output at native thread counts 1, 2, 4, and 8, plus repeated-run equality.

- [ ] **Step 7: Run Rust validation**

```bash
cargo fmt --manifest-path crates/irregular-nesting-native/Cargo.toml -- --check
cargo clippy --release --manifest-path crates/irregular-nesting-native/Cargo.toml --all-targets -- -D warnings
cargo test --release --manifest-path crates/irregular-nesting-native/Cargo.toml
```

Expected: PASS.

- [ ] **Step 8: Run bounded performance comparison**

Use the existing raw custom evidence as baseline. Run standard-library C1, C5, and one representative C6 sample serially with the same commands and settings used in `/tmp/rust-hypot-std/custom-*`. Record medians or single comparable samples without deleting outliers. Reject only a material end-to-end regression, defined as more than 5 percent on a maintained comparable arm after one confirmation rerun.

- [ ] **Step 9: Commit evidence documentation only after all gates pass**

Do not commit `/tmp` artifacts. Record commands, host classification, hashes, quality classifications, and timing summaries in the performance report during Task 7.

### Task 7: Update planning and knowledge documentation

**Files:**
- Modify: `docs/planning/rust-irregular-backend/js-semantics-audit.md`
- Modify: `docs/planning/rust-irregular-backend/quality-acceptance.md`
- Modify: `docs/planning/rust-irregular-backend/evidence/performance-report.md`
- Modify: `knowledge/native-hypot-parity.md`
- Modify: `knowledge/INDEX.md`

- [ ] **Step 1: Document the superseding decision**

State explicitly:

- the custom algorithm was removed to eliminate maintenance burden;
- `f64::hypot` is the production implementation;
- exact V8 corpus and TypeScript-versus-Rust hashes are diagnostic;
- unchanged legality, quality, capacity, determinism, and platform gates are blocking;
- the observed local corpus difference was 521 of 21,696 vectors, with a maximum of 2 ULPs;
- final 18-layout and capacity outcomes determine acceptance;
- performance improvement was not required, only absence of a material regression.

Do not rewrite historical evidence as if it never existed. Label the earlier exact-V8 requirement as superseded by this dated follow-up decision.

- [ ] **Step 2: Run knowledge update**

Invoke `/knowledge update` after the source and documentation changes are stable. Do not modify `knowledge/dependencies/`.

- [ ] **Step 3: Validate docs and formatting**

```bash
pnpm exec prettier --check docs/superpowers/specs/2026-07-31-standard-hypot-design.md docs/superpowers/plans/2026-07-31-standard-hypot.md docs/planning/rust-irregular-backend/js-semantics-audit.md docs/planning/rust-irregular-backend/quality-acceptance.md docs/planning/rust-irregular-backend/evidence/performance-report.md knowledge/native-hypot-parity.md knowledge/INDEX.md
git diff --check
```

Expected: PASS.

- [ ] **Step 4: Commit documentation**

```bash
git add docs/planning/rust-irregular-backend/js-semantics-audit.md docs/planning/rust-irregular-backend/quality-acceptance.md docs/planning/rust-irregular-backend/evidence/performance-report.md knowledge/native-hypot-parity.md knowledge/INDEX.md
git commit -m "docs: record standard hypot acceptance"
```

### Task 8: Run full repository verification

**Files:**
- Verification only

- [ ] **Step 1: Run TypeScript checks**

```bash
pnpm typecheck
pnpm lint
pnpm test
```

Expected: full suite passes with only documented skips.

- [ ] **Step 2: Run native packaging and Electron verification**

```bash
pnpm test:native:package
pnpm build
pnpm package:native:electron --publish=never --dir --mac
```

Run the repository packaged-native verifier against the generated app. Expected: packaged application loads the staged addon and reports the required native API and profiles.

- [ ] **Step 3: Run exact diagnostic and blocking quality lanes**

```bash
pnpm test:differential
pnpm gate:quality-acceptance
```

Expected: exact differences remain visible; operational failures and quality regressions fail.

- [ ] **Step 4: Check diagnostics and working tree**

Use the available LSP diagnostics for changed TypeScript files. The configured IDE diagnostics MCP is unavailable in this environment, so record that fact and rely on LSP, typecheck, lint, tests, Cargo, and CI. Then run:

```bash
git diff --check
git status --short
```

Expected: only intended tracked changes remain.

### Task 9: Persistent Codex review, PR update, CI, merge, and post-merge verification

**Files:**
- Current branch diff against `main`

- [ ] **Step 1: Run the persistent Codex review chat**

Use `codex-review-chat` on the complete diff with `gpt-5.6-sol` and `xhigh` reasoning. Do not use subagents as code reviewers. Resolve or technically rebut every verified finding, rerun affected tests, and continue the same Codex thread until `VERDICT: APPROVED`.

- [ ] **Step 2: Run final verification after review fixes**

Repeat Task 8 plus every focused gate affected by review fixes.

- [ ] **Step 3: Commit and push final changes**

```bash
git status --short
git add .github/workflows/rust-native.yml package.json scripts/rust-parity/run-differential.ts scripts/rust-parity/differential-fixture-matrix.ts scripts/verify-native-package-layout.test.mjs crates/irregular-nesting-native/src/js_number/js_math.rs crates/irregular-nesting-native/src/canonical_grid/contact.rs crates/irregular-nesting-native/src/search/layout_scorer.rs crates/irregular-nesting-native/src/transforms/flattening.rs crates/irregular-nesting-native/src/transforms/generator.rs crates/irregular-nesting-native/tests/js_hypot_vectors.rs docs/planning/rust-irregular-backend/js-semantics-audit.md docs/planning/rust-irregular-backend/quality-acceptance.md docs/planning/rust-irregular-backend/evidence/performance-report.md knowledge/native-hypot-parity.md knowledge/INDEX.md docs/superpowers/plans/2026-07-31-standard-hypot.md
git commit -m "refactor: adopt standard Rust hypot"
git push origin feat/auto-rust-irregular-p5-native-performance
```

Do not add attribution trailers.

- [ ] **Step 4: Update PR 28**

Update the existing pull request body with:

- standard-library hypot adoption;
- maintenance-first rationale;
- 18-layout, six-row, capacity, determinism, and platform evidence;
- exact parity as diagnostic;
- performance result and authoritative P5 status;
- complete verification commands.

- [ ] **Step 5: Monitor every required CI check**

Use `gh pr checks 28 --watch` and inspect failed logs with `gh run view`. Fix hosted failures, rerun local affected gates, commit, push, and wait again. Do not merge with a required failure or pending required check.

- [ ] **Step 6: Merge the authorized PR**

After Codex approval and green required CI:

```bash
gh pr merge 28 --merge --delete-branch
```

The user explicitly authorized merging this PR. Verify the returned merge commit and PR state.

- [ ] **Step 7: Verify merged `main`**

```bash
git fetch origin
git switch main
git pull --ff-only origin main
git status --short
git log -3 --oneline
```

Run focused post-merge smoke checks:

```bash
cargo test --release --manifest-path crates/irregular-nesting-native/Cargo.toml --test js_hypot_vectors
cargo test --release --manifest-path crates/irregular-nesting-native/Cargo.toml --test thread_equality
pnpm typecheck
```

Expected: clean `main`, merge commit present, and all focused checks pass.
