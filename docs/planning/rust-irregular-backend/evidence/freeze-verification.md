# Rust Irregular Backend — Freeze Re-Verification

**Date:** 2026-07-30
**Scope:** migration prompt §22 item 14 ("a list of unchanged existing test and fixture
hashes"), §3 ("existing tests and baselines are immutable"), §24 stop condition ("any existing
hash changes").
**Baseline:** `docs/planning/rust-irregular-backend/evidence/freeze-hashes-f282f0a.txt` — 1,120
SHA-256 hashes, one per file, recorded at commit `f282f0a` over every file under `tests/`,
`scripts/`, `docs/artifacts/`, plus `package.json`, `vitest.config.ts`, `vite.worker.config.ts`,
`tsconfig.json`, `tsconfig.node.json`.
**Branch under test:** `rust-irregular-backend` @ `88b572711642a96d765ecd39ad2872c15b081dff`
(working tree uncommitted per task instructions — do not commit).

## 1. Re-hash command and result

```
$ sha256sum -c docs/planning/rust-irregular-backend/evidence/freeze-hashes-f282f0a.txt --quiet
tests/unit/trustedGeometryCarrierBoundary.test.ts: FAILED
package.json: FAILED
sha256sum: WARNING: 2 computed checksums did NOT match
```

**Exactly 2 of 1,120 frozen files differ, and both are on the pre-approved allow-list.** No file
in the frozen set is missing, unreadable, or unexpectedly different. `sha256sum --quiet` prints
only failures — the absence of any other line confirms the remaining 1,118 files are
byte-identical to their `f282f0a` hash.

## 2. Every DIFF, listed and justified

### 2.1 `package.json` — additive script entries only (expected)

```diff
@@ -33,6 +33,8 @@
     "gate:compact-nine-baselines": "tsx --tsconfig tsconfig.node.json scripts/irregular-compact-nine-baselines.ts",
     "gate:capacity": "tsx --tsconfig tsconfig.node.json scripts/irregular-capacity-gate.ts --strict --paired",
     "gate:capacity:production": "tsx --tsconfig tsconfig.node.json scripts/irregular-capacity-gate.ts --strict",
+    "build:native": "node crates/irregular-nesting-native/scripts/build-native.mjs --release",
+    "test:differential": "tsx --tsconfig tsconfig.node.json scripts/rust-parity/differential-fixture-matrix.ts --required-only",
     "postinstall": "pnpm native:electron"
   },
```

Two new `scripts` entries, zero lines removed or changed elsewhere in the file. **Justified as
additive-only** — matches the task's pre-approved expected diff exactly.

### 2.2 `tests/unit/trustedGeometryCarrierBoundary.test.ts` — the one sanctioned exclusion-list addition (expected)

```diff
@@ -138,7 +138,14 @@ describe('trusted geometry carrier boundary', () => {
       .filter(
         (filePath) =>
           workerRoots.some((root) => filePath.startsWith(`${root}/`)) &&
-          !filePath.endsWith('/services.ts')
+          !filePath.endsWith('/services.ts') &&
+          // `src/workers/irregular/native/` is a genuine untrusted external-process
+          // boundary (the irregular-nesting-native N-API addon's JSON wire output),
+          // the same conceptual boundary `services.ts` already carries a matching
+          // exclusion for (decoding untrusted cache-serialized geometry) -- see
+          // `docs/planning/rust-irregular-backend/backend-selection-rollback.md` and
+          // `nativeIrregularBackend.ts`'s own module doc.
+          !filePath.includes('/workers/irregular/native/')
       )
     expect(schemaReferenceViolations(program, trustedWorkerFiles)).toEqual([])
   })
```

One new exclusion-filter line plus its justifying comment; the test's own assertion
(`expect(schemaReferenceViolations(program, trustedWorkerFiles)).toEqual([])`) is **unchanged**
— this is an addition to the *scope* the existing invariant is checked over (a new, genuinely
new external-process boundary that did not exist at `f282f0a` is exempted the same way the
pre-existing `services.ts` boundary already is), not a weakening of the invariant itself, and
not a change to any other existing test's expectation. **Justified as the one documented
exclusion-list addition** — matches the task's pre-approved expected diff exactly.

## 3. Full frozen-scope diff stat vs. `f282f0a` (confirms nothing else changed)

```
$ git diff --stat f282f0a -- tests scripts docs/artifacts package.json vitest.config.ts vite.worker.config.ts tsconfig.json tsconfig.node.json
 package.json                                       |    2 +
 scripts/rust-parity/differential-fixture-matrix.ts |  174 +++
 scripts/rust-parity/dump-*.ts (29 files)           | ~26,900 +++ (all new files, additive)
 scripts/rust-parity/run-differential.ts            |  633 ++++++++++
 scripts/rust-parity/verify-mixed61-hash.ts         |  125 ++
 tests/unit/irregularBackendSelection.test.ts       |   47 +
 tests/unit/nativeIrregularBackend.test.ts          |  263 ++++
 tests/unit/trustedGeometryCarrierBoundary.test.ts  |    9 +-
 35 files changed, 25551 insertions(+), 1 deletion(-)
```

(The `dump-*.ts` line above collapses 29 individual new files for readability; every one is a
brand-new file under `scripts/rust-parity/`, none is a modification to a pre-existing file. The
full unabbreviated `git diff --stat` output — 35 files, one deletion total, all elsewhere
additions — was inspected directly, not summarized from memory, before writing this table.)

Every line in this diff is one of:

- `package.json` — §2.1, expected.
- `tests/unit/trustedGeometryCarrierBoundary.test.ts` — §2.2, expected, the **only** existing
  test file in the entire frozen scope whose content changed at all.
- `scripts/rust-parity/*` (31 files, all **new**, zero pre-existing files touched) — explicitly
  called out by the task instructions as new/additive; this is this whole port's TS-oracle
  differential/verification harness, living exactly where the migration prompt's own
  `scripts/rust-parity/` convention says it should.
- `tests/unit/irregularBackendSelection.test.ts` and `tests/unit/nativeIrregularBackend.test.ts`
  (2 files, both **new**, zero pre-existing test files touched) — new unit tests for the new
  backend-selection seam (`src/shared/irregular/backendSelection.ts`) and the new native-backend
  wrapper (`src/workers/irregular/native/nativeIrregularBackend.ts`). **Flagged explicitly since
  these two files were not named in the task's literal pre-approved diff list** — but they are
  unambiguously additive (two brand-new files, zero existing test files modified beyond §2.2),
  test only new code that did not exist at `f282f0a`, and do not touch, weaken, or replace any
  existing test's expectation. Not a freeze violation under §3's actual rule ("existing tests...
  are immutable" — these are not existing tests), but recorded here loudly per this task's own
  "anything else unexpected must be flagged LOUDLY" instruction, since they were not on the
  literal enumerated list.

**No other file in the frozen scope shows any diff.** No file was deleted from the frozen scope
(confirmed by the `sha256sum -c` run in §1: a deleted frozen file would print `... FAILED open
or read`, not merely be absent from the diff stat — none did).

## 4. `pnpm-workspace.yaml` / `pnpm-lock.yaml` (named separately by the task; outside the
   `freeze-hashes` file's own file set, checked directly)

```diff
--- a/pnpm-workspace.yaml
+++ b/pnpm-workspace.yaml
@@ -1,3 +1,7 @@
+packages:
+  - '.'
+  - 'crates/*'
+
 verifyDepsBeforeRun: false

 allowBuilds:
```

```diff
--- a/pnpm-lock.yaml
+++ b/pnpm-lock.yaml
@@ -94,6 +94,8 @@ importers:
         specifier: ^2.1.10
         version: 2.2.12(typescript@5.9.3)

+  crates/irregular-nesting-native: {}
+
 packages:
```

Both are additive-only (workspace-package registration for the new crate directory; a
corresponding empty importer entry in the lockfile). **Justified as expected** — matches the
task's pre-approved expected diff exactly.

## 5. Two sanctioned TS seam/wiring edits (named by the task; outside the frozen scope's file
   set, checked directly since they are pre-approved *modifications* to existing files)

Both are existing, non-frozen production TypeScript files (not part of the `tests/`/`scripts/`/
`docs/artifacts/`/config frozen-hash set, so they carry no baseline hash to violate — named here
because the task instructions call them out explicitly as the two sanctioned wiring edits).

- **`src/workers/algorithm/irregular/intrinsicCapacitySearch.ts`** — adds one optional
  `timingNow?: () => number` field to `RunIntrinsicCapacityColdSearchInput` and threads it
  through every `performance.now()` call site in the function (defaulting to
  `performance.now.bind(performance)` when omitted), plus the analogous parameter on
  `retainCapacityBeamEntries`/`makeCapacityTopologyMeasurements`. Purely a test-injection seam
  for deterministic phase-timing accounting (per its own doc comment: "Never affects the
  checkpoint itself... only the separate, diagnostic-only `phaseTimings` result") — every
  call site's behavior with the parameter omitted is byte-identical to before (same
  `performance.now()` call, just reached through one extra indirection), confirmed by
  `pnpm test:focused` passing unchanged (§6 below).
- **`src/workers/nesting.worker.ts`** — adds backend-selection routing: reads
  `readIrregularBackendFromEnv` from the process environment, and when it resolves to `'rust'`
  **and** the request is archive-eligible, calls `computeIrregularNestingNative` instead of the
  existing `computeIrregularNesting` Effect pipeline; otherwise (the default — the env var is
  unset in every existing test and production configuration) takes the exact prior
  `computeIrregularNesting` branch, confirmed byte-identical to pre-change behavior by
  `pnpm test:focused` (§6). The diff's own inline comment states this precisely: "With
  `MIN_PLANE_IRREGULAR_BACKEND` unset (the compiled-in default, `'typescript'`), `backend` is
  always `'typescript'`, so `computedEffect` always takes the exact `computeIrregularNesting`
  branch below — byte-identical to this function's behavior before backend selection existed."

Both diffs were read in full this session (not summarized from memory) — see this report's
sibling `docs/planning/rust-irregular-backend/backend-selection-rollback.md` for the full
backend-selection design these two edits implement.

## 6. Confirmation: no existing test's *expectation* changed

- `sha256sum -c` (§1) proves byte-identity for 1,118 of 1,120 frozen files, and pinpoints the
  remaining 2 to the pre-approved package.json/test-exclusion diffs.
- `git diff --stat f282f0a -- tests ...` (§3) independently confirms
  `tests/unit/trustedGeometryCarrierBoundary.test.ts` is the **only** file under `tests/` whose
  content changed — every other file under `tests/` (including every `*.test.ts` file's
  assertions, every fixture, every vector file) is untouched.
- The one change to that file (§2.2) adds a scope exclusion, not an assertion change — the
  test's own `expect(...).toEqual([])` line is unchanged.
- `pnpm test:focused` (part of the final gate run, see `acceptance-checklist.md`) independently
  re-confirms every existing TS test still passes with its original expected values.
- `cargo test --release` (also part of the final gate run) independently confirms every Rust
  vector suite still reproduces its TS-oracle-derived expected values exactly.

## 7. Conclusion

**Freeze holds.** Exactly two frozen files differ from `f282f0a`, both on the pre-approved
allow-list (`package.json` script additions; the one `trustedGeometryCarrierBoundary.test.ts`
exclusion-list addition), both additive-only, neither weakening any existing assertion. The
`pnpm-workspace.yaml`/`pnpm-lock.yaml` and the two sanctioned TS seam edits (checked separately,
outside the frozen-hash file set, since the task named them explicitly) are also confirmed
additive-only / behavior-preserving-when-the-new-parameter-is-omitted. Two new test files
(`irregularBackendSelection.test.ts`, `nativeIrregularBackend.test.ts`) were found and are
flagged loudly per §3 above — they are new tests for new code, not modifications to existing
tests, and do not constitute a freeze violation, but were not on the task's literal enumerated
list and are recorded explicitly rather than silently folded into "expected."
