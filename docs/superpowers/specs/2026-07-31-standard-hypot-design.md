# Standard Rust Hypot Design

## Goal

Remove the custom V8-compatible two-argument `hypot` algorithm and its maintenance burden. Preserve a centralized semantic call boundary while delegating numerical behavior to Rust's standard library.

## Decision

`js_number::js_math::hypot` remains the single production entry point for semantic two-argument distance calculations. Its implementation becomes:

```rust
pub fn hypot(x: f64, y: f64) -> f64 {
    x.hypot(y)
}
```

Production call sites remain unchanged. This avoids broad geometry and scoring edits while reducing the maintained implementation to one standard-library call.

`libm::hypot` is not selected. It would also remove the custom algorithm, but it creates a library-specific policy without a demonstrated quality advantage. Calling `f64::hypot` directly at every call site is also rejected because it creates unnecessary churn and removes the central audit boundary.

## Acceptance policy

Final geometry and quality govern acceptance. Exact Node/V8 bit parity and exact TypeScript-versus-Rust hashes remain diagnostic characterization rather than blocking requirements.

The standard implementation is accepted only when all of the following hold:

- The complete maintained 18-layout Compact and Compact Short Side matrix passes without changing any quality threshold.
- The six-row backend quality gate passes.
- Capacity legality, settlement, chronology, objective, and quality gates pass.
- Geometry remains finite, provenance-valid, non-overlapping, and inside its assigned sheet.
- Placed and unplaced accounting remains exact.
- Repeated Rust executions are deterministic.
- Semantic output remains identical across native thread counts 1, 2, 4, and 8.
- Special-value, overflow, underflow, symmetry, order, sign, and repeatability tests pass.
- Supported Linux, Windows, macOS arm64, and macOS x64 CI gates pass.
- End-to-end performance does not regress materially. A speed improvement is not required.

A maintained exact hash may change when the resulting layout still passes every unchanged legality and quality contract. Such changes must remain visible in evidence and differential diagnostics.

## Corpus handling

The committed 21,696-vector Node/V8 corpus remains useful for describing numerical differences. The expected standard-library characterization is:

- 21,175 exact matches.
- 521 mismatches.
- 505 mismatches at 1 ULP.
- 16 mismatches at 2 ULPs.
- Identical finite, infinity, and NaN classifications.

The corpus test will no longer require bit-exact V8 equality from the production implementation. It will instead verify the documented standard-library characterization or be replaced with focused numerical safety tests plus a diagnostic comparison command. The final implementation must not retain duplicate custom arithmetic solely to satisfy the corpus.

## Documentation changes

Documentation and comments that declare exact V8 compatibility as a production requirement will be updated to reflect the new quality-first policy. Historical evidence remains intact and is labeled as superseded where appropriate.

The knowledge page for native hypot will describe the standard-library boundary, diagnostic V8 corpus, accepted ULP distribution, and unchanged quality gates.

## Verification and rollout

The change will be implemented through TDD in the feature branch. Verification will cover focused Rust tests, the 18-layout matrix, the six-row quality gate, capacity gates, native integration, thread equality, packaging, supported CI targets, TypeScript tests, type checking, linting, formatting, and final differential characterization.

The pull request will receive a persistent Codex review using `gpt-5.6-sol` with `xhigh` effort. Every verified finding will be resolved or technically rebutted before merge. CI must be green before the authorized merge into `main`.
