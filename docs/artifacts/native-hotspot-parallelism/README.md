# Native hotspot parallelism evidence

This directory preserves portable summaries for the retained strict-decoder candidate-scoring parallelism experiment. The complete raw evidence remains in the immutable local provenance directory documented below because the per-sample diagnostics and timing output are too large for source control.

## Experiment identity

- Base commit: `4d40bc6c36672973b75efdf5ad076dd070204189`
- Branch: `feat/native-hotspot-parallelism`
- Captured dirty patch SHA-256: `c4da664e12e892d06ab3b71c4d2631f2776da2845b5fff4c636c5c74972a0c86`
- Release addon SHA-256: `ae86de5ee217893f0bcb7fb176ef1f260ce13a4d3ba3364e97b5b322cca4dc15`
- Host: Apple M4 Max, 16 logical CPUs, 64 GiB RAM, macOS arm64
- Runtime: Node v24.16.0, pnpm 11.8.0, rustc 1.95.0
- Full immutable evidence: `/private/tmp/min-plane-provenance/native-hotspot-parallelism-20260801-final-candidate/`

## Files

- `c1-summary.json`: two independent real packaged N-API Mixed-61 batches with one discarded warm-up and five measured samples at 1, 2, 4, and 8 threads
- `p5-aggregate-summary.json`: diagnostic local C5, C6, and C7 aggregate matrix summary
- `manifest.json`: source, environment, command, hash, and artifact references
- `SHA256SUMS`: hashes for the portable files

Every C1 sample placed all 61 pieces, reproduced the pinned collision and fitted-canonical identities, and reported the requested native thread count. This evidence is diagnostic and non-authoritative because it was collected on local macOS rather than the preregistered controlled Linux host.
