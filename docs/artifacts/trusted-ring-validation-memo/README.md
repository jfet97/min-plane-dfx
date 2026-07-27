# Trusted Ring Validation Memo

Retained summaries from the original identity-memo experiment. They motivated
the hardened fingerprint implementation, but they are not a complete portable
reproduction bundle: the underlying SVGs, raw matrix reports, component
benchmark records, commands, and runtime manifest were not retained.

## `mixed-61-paired/`

Three alternating strict `mixed-61 2000x2700` gate runs per ref, `main` first,
on one sandboxed Linux machine. All six reported the pinned canonical hash
`ef2b783ae12491d2a80a12ef94d1bb2801c13cbd43aeb6e2c1cc00d86828fd3b` and passed
every strict quality gate. These committed gate summaries support the hashes,
quality flags, and elapsed times below. The reported field-by-field and
byte-identical SVG comparisons cannot be independently reconstructed from this
directory because the underlying SVGs and raw reports are absent.

Median elapsed time fell from `50325ms` to `44032ms`, a `12.50%` reduction. The
two sets do not overlap: the slowest branch run beat the fastest `main` run.

## `nine-baselines-identity.json`

The synthesized summary reports that the strict nine-baseline matrix ran all 18
Compact and Short Side layouts on both refs. It records the reported SHA-256,
pass flag, and elapsed time for every layout. The underlying SVGs and raw
reports are absent, so the digest and full-report comparisons are historical
claims rather than independently verifiable portable evidence.

Comparing the full reports left zero differences beyond elapsed times, peak RSS
deltas, `sourceCommit`, and the serialized-trace byte length that varies with
the digit width of the timings it embeds.

The matrix does not include the usual Chromium PNG renders. That step shells out
to Electron, which needs an X server this sandbox does not provide; it fails
identically on `main`. The 18 layout gates themselves completed and passed
before that step.

## `cache-telemetry.json`

One reported `--capture-cache-telemetry` gate run. It motivated the change:
`266977` pairwise NFP cache lookups with `262166` present, a `98.2%` hit rate,
against only `4811` stores. The file lacks source-ref and command provenance,
and no paired telemetry is retained, so it does not independently establish
that both refs had identical cache behaviour.

This README was added after generation and is intentionally outside the
generated checksum manifest.
