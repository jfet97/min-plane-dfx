# Accepted old Rust parity capture

**Status:** archived capture procedure. The embedded Rust engine, workflow, and local capture scripts have been removed after the authorized package cutover. Do not run or recreate this capture from the application repository.

The retained content below documents how the accepted old-side evidence was produced before removal. It is historical and its commands are no longer available on the current branch.

## Preconditions

- The workflow has four exact runner pairs: `ubuntu-24.04` with `x86_64-unknown-linux-gnu`, `windows-latest` with `x86_64-pc-windows-msvc`, `macos-15` with `aarch64-apple-darwin`, and `macos-15-intel` with `x86_64-apple-darwin`.
- Rust and Cargo `1.95.0`, the matrix target, the release profile, and an empty feature list are required. Any drift fails the workflow.
- The exact engine revision is `5c72d8fca8e078b0a6e7d5f2515a8a0953475481`. The provenance revision is `e4f3608878611c002f343473fab72adc7d155f87`.
- The fresh-capture input gate validates the frozen corpus, every row artifact, corpus checksums, provenance, vectors, source fixtures, and legal text before the old adapter is built or invoked. It retains the historical ignored addon hash as evidence rather than requiring unavailable historical bytes. The historical `migration-corpus.ts --validate-only` gate remains strict and unchanged.

## Output and verification

For each target, the workflow creates `old-rust-parity-capture-<target>` and `old-rust-parity-capture-<target>.tar.gz`. The archive contains the original request bytes plus raw old-adapter result, events, stderr, and process-status files at `old/raw/<row-id>/`. `capture-metadata.json` is the binding record: it contains structured Rust and Cargo identities, target, release profile, empty feature list, source `Cargo.lock` SHA-256, canonically ordered native dependency entries and their digest, frozen corpus names, digests, and all 18 ordered row IDs, workflow repository/ref/SHA/run identity, accepted engine and provenance revisions, and separate historical and fresh addon SHA-256 values. The canonical v1 consumer schema is `docs/planning/capture-metadata-v1.schema.json`; `tests/fixtures/capture-metadata-v1.json` is a non-evidentiary shape fixture. Loose evidence files remain archival copies rather than the sole source of critical fields.

The archive root contains `capture-metadata.json`, `bundle-manifest.json`, and `SHA256SUMS`. `SHA256SUMS` hashes every file in the capture directory except itself. The workflow then hashes the fixed target archive, uploads that archive and its digest with the target-specific artifact name, and invokes GitHub build provenance attestation on that exact archive. Attestation is the CI-only gate. Local use can validate or assemble evidence but cannot issue GitHub provenance.

For local offline validation of the frozen corpus, run:

```sh
# Strict historical validation. This needs the historical ignored addon bytes.
pnpm exec tsx --tsconfig tsconfig.node.json scripts/rust-parity/migration-corpus.ts --validate-only

# Fresh target-specific capture validation. This validates all available immutable inputs
# and records the missing historical addon hash as provenance rather than rebuilding it.
pnpm exec tsx --tsconfig tsconfig.node.json scripts/rust-parity/capture-old-parity.ts --validate-fresh-inputs \
  --corpus-dir docs/artifacts/polygon-nesting-extraction-baseline
```
