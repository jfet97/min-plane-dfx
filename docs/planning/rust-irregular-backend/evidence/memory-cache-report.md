# Rust Irregular Backend: Memory and Cache Telemetry Report

**Date:** 2026-07-31
**Scope:** PR 27 remediation Sections 9 and 10
**Branch:** `rust-irregular-backend`
**Base commit:** `be32e7cb4c9d61161eef3780f1909712fd94bf86`

## 1. Production policy

The Rust irregular backend owns two finite, job-local caches:

| Cache | Default cap | Eviction policy | Mutation authority |
| --- | ---: | --- | --- |
| Geometry cache | 56 MiB | deterministic charged LRU | coordinator thread only |
| Free-material cache | 8 MiB | charged insertion-order FIFO | coordinator thread only |

Geometry values are type-erased in the store, so each publication supplies an explicit conservative retained-value charge. The store adds its own retained key, namespace, recency, entry-metadata, and container-overhead charges. The free-material cache charges retained snapshot vectors, strings, keys, metadata, and container overhead.

All arithmetic is checked or saturating. An entry whose charge exceeds the cap is rejected without evicting unrelated entries or failing the job. Replacement and eviction decisions are planned deterministically before publication. When eviction leaves excess retained container capacity, the implementation compacts and shrinks that storage before continuing.

Rayon workers receive only pure geometry inputs and produce values in stable slots. Cache probes, LRU touches, eviction, and publication remain serial. The NFP prepass uses a borrowed validity probe on hot entries and moves cold computed polygons into the cache without cloning them.

## 2. Cleanup and diagnostics

After normal job completion, both caches are explicitly cleared and shrunk before their diagnostics snapshots are published. Post-cleanup telemetry therefore reports:

- `currentBytes = 0`;
- `entries = 0`;
- per-namespace current entries and bytes equal to zero.

Peak usage and cumulative counters remain available for diagnosis. If execution unwinds through a panic, normal Rust ownership drops both job-local caches.

Cache telemetry is a diagnostics sidecar. It is not included in semantic result projection, accepted hashes, histories, traces, ledgers, or checkpoints.

## 3. Full Mixed-61 default-versus-unlimited profile

The comparison used the complete `tests/fixtures/irregularSheetInvariance/mixed61-request.json` request at `2000 x 2700`, Compact profile, one Rust thread, and the release test binary under `/usr/bin/time -l`. The result envelope was normalized only by removing timing fields before SHA-256 calculation.

| Measurement | Default caps | Effectively unlimited | Result |
| --- | ---: | ---: | --- |
| Normalized envelope SHA-256 | `8735c0702f3bdac5168186519f1f839785a756b50eeaf5edb01e7855b5eae429` | same | exact |
| Elapsed time | 30,740.98 ms | 30,702.28 ms | 0.13% difference |
| Geometry hits | 276,454 | 276,454 | exact |
| Geometry cloning hits | 276,454 | 276,454 | exact |
| Geometry misses | 5,299 | 5,299 | exact |
| Geometry charged peak | 10,889,512 B | 10,889,512 B | exact |
| Geometry evictions | 0 | 0 | exact |
| Geometry oversized rejections | 0 | 0 | exact |
| Free-material charged peak | 51,089 B | 51,089 B | exact |
| Free-material evictions | 0 | 0 | exact |
| Free-material oversized rejections | 0 | 0 | exact |
| Maximum RSS | 379,584,512 B | 379,535,360 B | 49,152 B difference |

The default geometry cap is about 5.39 times the observed full-fixture charged peak. The default free-material cap is about 164 times its observed peak. The default and unlimited runs produced identical semantic bytes and identical cache-reuse counters, while runtime and RSS were effectively unchanged. The measured evidence therefore supports retaining the provisional 56 MiB and 8 MiB defaults.

The ignored release tests in `boundary/run_job.rs` reproduce each profile independently and print the normalized hash, elapsed time, resolved threads, and both telemetry snapshots. They are ignored because a full Mixed-61 run is intentionally too expensive for the ordinary unit-test gate.

## 4. Cap and determinism matrix

The automatic cap-equivalence regression runs the same request under:

- default caps;
- effectively unlimited caps;
- tight nonzero caps that force eviction;
- zero caps that force oversized rejection;
- one and two Rayon threads.

It compares timing-normalized envelope bytes. Tight and zero caps alter only cache reuse: semantic output remains byte-exact. Separate cache regressions pin deterministic LRU and FIFO behavior, replacement accounting, stale removal, oversized-entry rejection, cleanup, retained namespace charging, free-material inline-storage charging, and post-eviction container compaction.

## 5. Conclusion

- Cache memory has explicit finite production caps.
- Full Mixed-61 remains byte-exact under default and unlimited caps.
- Default caps preserve the same 276,454 geometry hits and 5,299 misses as unlimited execution.
- Default runtime differs from unlimited by 0.13% in the recorded paired profile.
- Default caps do not evict or reject entries on full Mixed-61.
- Tight and zero-cap tests prove that eviction and rejection cannot change semantic results.
- Normal completion releases retained cache storage before diagnostics publication.
