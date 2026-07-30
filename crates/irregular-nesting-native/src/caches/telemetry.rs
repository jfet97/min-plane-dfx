//! Non-semantic diagnostic sidecar for the geometry-cache cluster (prompt
//! §13.7, §17). Never read by control flow inside this crate. Never part of
//! the job result DTO (`architecture.md` §4.5); returned only through the
//! diagnostic channel that section establishes as structurally separate from
//! `boundary::run_job`'s result.
//!
//! Struct shapes below are copied verbatim (field-for-field) from
//! `docs/planning/rust-irregular-backend/cache-concurrency-design.md` §6,
//! the required design artifact for this crate's cache cluster. This module
//! is **Stage 2 scope only**: every counter is a plain `u64` (no
//! `AtomicU64`), since this crate is still single-threaded (no Rayon
//! dependency yet, per that document's own "matching TS's own documented...
//! zero-overhead-when-disabled design" note and the Stage 3/4 note attached
//! to the `AtomicU64` mention in §6 — "where cross-thread, per Stage 4").
//! Fields whose only purpose is to observe concurrency (`duplicate_computations`,
//! `single_flight_waits`, `shard_lock_wait_nanos`,
//! `shard_lock_contended_acquisitions`, `front_cache_hits`) are always `0` in
//! this stage, exactly as the design doc's own field docs anticipate ("always
//! 0 under strict single-flight with no policy bug" / "architecture 3 only").
//!
//! TS counterpart this struct's fields are cross-referenced against:
//! `src/workers/irregular/nfpIfpTelemetry.ts` (`NfpIfpCacheNamespaceCounters`/
//! `NfpIfpTelemetrySnapshot`). The Rust shape is intentionally **richer**
//! than the TS one (design doc §6: "Rust separates 'present' into `hits` +
//! `stale_detections` deliberately... because TS's `getPresent` conflates
//! them") — this is not a byte-parity target, it is a new diagnostic
//! contract for this port, so no differential-vector test pins these counts
//! against a TS oracle; see `store.rs` for how each field is populated from
//! this cluster's own exact access-sequence contract instead.

use std::collections::BTreeMap;

use serde::Serialize;

/// One namespace's counters. `namespace` is a stable string identifier
/// matching the TS namespace constants verbatim (e.g. "pairwise-nfp-relative-v3")
/// so evidence can be cross-referenced against the TS baseline by name.
///
/// `Serialize` (added for `boundary::diagnostics`'s opt-in
/// `getLastJobDiagnostics` sidecar, `architecture.md` §4.5): purely a
/// diagnostic-channel convenience, not a parity/canonical encoding -- see
/// this module's top doc, "not a byte-parity target."
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheNamespaceTelemetry {
    /// Every `get` call, hit or miss (TS: `getCalls`).
    pub lookups: u64,
    /// Lookups that resolved to a valid, immediately-usable published value
    /// without waiting on an in-flight computation (a strict subset of TS's
    /// `getPresent`, which also counts stale hits about to be evicted; Rust
    /// separates "present" into `hits` + `stale_detections` deliberately —
    /// see field docs below — because TS's `getPresent` conflates them).
    pub hits: u64,
    /// Lookups that found no entry and no in-flight computation (must start
    /// a fresh computation).
    pub misses: u64,
    /// Successful publications (TS: `setCalls`).
    pub stores: u64,
    /// Lookups whose cached value failed re-validation (TS: `getPresent`
    /// entries that are stale, i.e. `isValidCached*` returned false).
    pub stale_detections: u64,
    /// Evictions performed as a direct result of a stale detection (TS:
    /// `removeCalls`; equals `stale_detections` in a correct implementation,
    /// tracked separately to catch a design bug if they ever diverge).
    pub stale_removals: u64,
    /// A computation ran to completion for a key that was already published
    /// or already being computed by another thread by the time this
    /// computation finished (architecture 3/duplicate-computation policies
    /// only; always 0 under strict single-flight with no policy bug).
    pub duplicate_computations: u64,
    /// Times a thread blocked waiting for another thread's in-flight
    /// single-flight computation of the same key (architecture 3 only).
    pub single_flight_waits: u64,
    /// Approximate cumulative time spent by all threads waiting on a shard
    /// lock for this namespace, in nanoseconds. Coarse-grained and
    /// low-overhead by construction (prompt §13.7: "low-overhead integer
    /// telemetry, disabled or sampling-free by default if necessary").
    pub shard_lock_wait_nanos: u64,
    /// Count of shard-lock acquisitions that were contended (had to wait at
    /// all), independent of the wait-time sum above.
    pub shard_lock_contended_acquisitions: u64,
    /// Front-cache hits, if a thread-local front cache is in use for this
    /// namespace (§3.2's optional Stage 4 refinement); 0 if not applicable.
    pub front_cache_hits: u64,
    /// Hits served by the shared backing store (as opposed to a front
    /// cache); equals `hits` when no front cache is in use.
    pub backing_cache_hits: u64,
    /// Entries evicted for a reason other than staleness (size-based
    /// eviction, §5); always 0 unless a future stage adds size-based
    /// eviction as an explicit new capability.
    pub evictions: u64,
    /// Current entry count for this namespace at the moment of snapshot.
    pub entries: u64,
    /// Approximate current bytes for this namespace at the moment of
    /// snapshot (§5's per-entry byte estimate, summed). Always `0` in Stage
    /// 2 — no byte-size estimator exists yet; deferred to whichever stage
    /// implements §5's memory-tracking policy.
    pub approx_bytes: u64,
    /// Peak approximate bytes for this namespace observed at any point
    /// during the job (§5), never decreasing within one job's lifetime.
    /// Always `0` in Stage 2 alongside `approx_bytes`.
    pub peak_bytes: u64,
    /// Cumulative wall time spent inside this namespace's pure compute
    /// function (e.g. `computeRelativeNfpBoundary`'s Rust equivalent),
    /// across every computation (single-flight winners and, under a
    /// duplicate-computation policy, every duplicate), in nanoseconds.
    /// Always `0` in Stage 2 — no caller in this module clocks its own
    /// compute step yet; a future stage may add timing at the resolver call
    /// site without changing this struct's shape.
    pub computation_time_nanos: u64,
}

/// One job's complete cache telemetry snapshot. Namespace keys are stable
/// strings matching the TS namespace constants; `BTreeMap` (not `HashMap`)
/// is used only so a printed/serialized snapshot has deterministic key
/// order for human review — this ordering is diagnostic convenience, not a
/// parity requirement (contrast with prompt §9's ordering rules, which
/// govern canonical/semantic output, not this sidecar).
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheTelemetrySnapshot {
    pub namespaces: BTreeMap<String, CacheNamespaceTelemetry>,
    /// Number of distinct `GeometryCacheStore`-equivalent instances
    /// constructed during this process's lifetime that this snapshot
    /// aggregates over. In production this is always 1 per job (design doc
    /// §2); a value other than 1 in a differential/stress-test harness is
    /// itself a testable invariant, mirroring TS's `cacheInstances` counter
    /// (`nfpIfpTelemetry.ts`, asserted `=== 1` per job by
    /// `irregularGeometryCache.test.ts:199,276`).
    pub cache_instances: u64,
}

impl CacheTelemetrySnapshot {
    /// Returns a mutable handle to `namespace`'s counters, creating a
    /// zeroed entry on first access — mirrors
    /// `nfpIfpTelemetry.ts`'s `namespaceCounters` helper
    /// (`get-or-create`, never a hard `KeyError`).
    pub fn namespace_mut(&mut self, namespace: &str) -> &mut CacheNamespaceTelemetry {
        self.namespaces.entry(namespace.to_string()).or_default()
    }

    /// Read-only accessor for `namespace`'s counters, or a shared zeroed
    /// value if the namespace has never been touched (never creates an
    /// entry, unlike [`Self::namespace_mut`]).
    pub fn namespace(&self, namespace: &str) -> CacheNamespaceTelemetry {
        self.namespaces.get(namespace).cloned().unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn namespace_mut_creates_a_zeroed_entry_on_first_access() {
        let mut snapshot = CacheTelemetrySnapshot::default();
        assert!(snapshot.namespaces.is_empty());
        let counters = snapshot.namespace_mut("transform-collision-v1");
        assert_eq!(*counters, CacheNamespaceTelemetry::default());
        assert_eq!(snapshot.namespaces.len(), 1);
    }

    #[test]
    fn namespace_read_accessor_does_not_create_an_entry() {
        let snapshot = CacheTelemetrySnapshot::default();
        assert_eq!(
            snapshot.namespace("sheet-ifp-v1"),
            CacheNamespaceTelemetry::default()
        );
        assert!(snapshot.namespaces.is_empty());
    }

    #[test]
    fn namespaces_are_reported_in_sorted_key_order() {
        let mut snapshot = CacheTelemetrySnapshot::default();
        snapshot.namespace_mut("sheet-ifp-v1").lookups = 1;
        snapshot.namespace_mut("pairwise-nfp-relative-v3").lookups = 2;
        snapshot.namespace_mut("transform-collision-v1").lookups = 3;
        let keys: Vec<&String> = snapshot.namespaces.keys().collect();
        assert_eq!(
            keys,
            vec![
                "pairwise-nfp-relative-v3",
                "sheet-ifp-v1",
                "transform-collision-v1"
            ]
        );
    }
}
