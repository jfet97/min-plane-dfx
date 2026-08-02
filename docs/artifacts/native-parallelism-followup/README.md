# Native parallelism follow-up evidence (2026-08-02)

Portable summaries for the retained optimization pass on
`feat/native-parallelism-optimization` (base `main` @ `6a40af5`): the
PAR-PERIOD-01 periodic crop seam, the PAR-NFP-02 per-point legality seam,
`JobPool::run_scoped`, the capacity successor identity cache, and the
no-pool containment plus requested/actual thread diagnostics hardening.

## Experiment identity

- Base commit: `6a40af5`; baseline reference commit: `cb2135a`
  (performance neutral versus main); final candidate commit: `7fd9691`
- Baseline addon SHA-256:
  `43ac1d69212f18bf1c60062c2413c5d045ed4535b60ffbdb3f72b2eb19440764`
- Final candidate addon SHA-256:
  `6f0b4685403d7de1cd37a88798ff83f146465c9e6102ba152f8815d80fee72c1`
- Host: t3vm (NixOS, Linux 6.18.38 x86_64, Intel Core Ultra 7 270K Plus,
  16 hardware threads, 125 GiB), matching every field of
  `docker/p5-controlled-host.contract.json`; Docker not installed, so the
  authoritative wrapper cannot run and this evidence is diagnostic with
  strong host provenance, never `--controlled-linux`.
- Runtime: Node v24.18.0, pnpm 11.11.0, rustc 1.97.1
- Full immutable raw evidence (samples, logs, seam contracts, verification
  workflow journals, instrumented profile):
  `/var/lib/t3/src/macs/min-plane-provenance/native-parallelism-20260801/`
  on that host (kept outside the repository per evidence policy).

## Files

- `c1-summary.json`: C1 Mixed-61 2000x2700 compact through the production
  N-API path; baseline and candidate, two independent batches each,
  1 discarded warmup + 5 measured samples per thread cell (1/2/4/8/15/auto),
  per-sample hash and requested-versus-actual thread validation, peak RSS.
- `aggregate-summary.json`: C5/C6/C7 per-cell medians for baseline and
  candidate (baseline 3 samples per cell; candidate C5 3 samples, C6 and C7
  1 warmup + 1 sample after a host interruption, regression-guard
  precision).
- `manifest.json`: source, environment, command, and artifact references.
- `SHA256SUMS`: hashes for the portable files.

Headline: C1 automatic-default median 25.0 s to 18.1-18.3 s (-27%), with
byte-exact semantics on every measured sample; C5 rust-default -28.6%.
