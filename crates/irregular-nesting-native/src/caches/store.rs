//! The one physical backing store shared by cache namespaces 1.1–1.3
//! (`pairwise-nfp-relative-v3`, `transform-collision-v1`, `sheet-ifp-v1`) —
//! ported from `src/workers/irregular/core/geometryCacheStore.ts` (key
//! shape + `serializeGeometryCacheKey`) and
//! `src/workers/irregular/geometryCacheStoreLive.ts` (`makeGeometryCacheStore`,
//! the `Map`-backed implementation).
//!
//! # Key type reuse
//!
//! TS declares two independently-declared, structurally identical key
//! shapes (`core/geometryCacheStore.ts`'s plain `GeometryCacheKey` interface
//! and `domain.ts`'s `IrregularGeometryCacheKey` class) that flow into each
//! other's call sites for free under structural typing.
//! `crate::domain::IrregularGeometryCacheKey`'s own doc comment
//! already resolves this for the Rust port ("the unify branch... any later
//! cache-store module must reuse it directly rather than declaring a second,
//! structurally-identical type") — this module follows that instruction and
//! re-exports it locally as [`GeometryCacheKey`] rather than declaring a new
//! struct.
//!
//! # Storage representation
//!
//! `docs/planning/rust-irregular-backend/cache-concurrency-design.md` §1
//! confirms this store's backing structure is never iterated in production
//! (`Map.get`/`.set`/`.delete` only — no `for...of`/`.keys()`/`.values()`
//! observed reaching output), so a plain `HashMap` keyed by the exact
//! `serializeGeometryCacheKey` byte string is sufficient — no
//! insertion-ordered `Vec` shadow structure is needed here (contrast with
//! TS `Map` types elsewhere in this crate whose iteration order *is*
//! observable, which would require a `Vec`+`HashMap` combination per this
//! crate's stage-2 scope note).
//!
//! # Type-erased values
//!
//! TS's `Map<string, unknown>` stores heterogeneous values across
//! namespaces (`get<A>`/`set<A>` are call-site-trusted casts with **no**
//! runtime shape check — `geometry-caches.md` §3 confirms namespaces 1.1/1.3
//! store plain objects while 1.2 stores a materialized domain-class
//! instance). `Box<dyn Any>` plus `downcast_ref` is this crate's equivalent:
//! like the TS `as A | undefined` cast, a namespace/type mismatch is a
//! caller bug this store does not detect at runtime; unlike TS, an actual
//! type mismatch here fails the `downcast_ref` cleanly (returns `None`,
//! reported as an ordinary cache miss) rather than returning a
//! value-shaped-wrong `A`, which is a strictly safer failure mode than TS's
//! silent structural mismatch, not a divergence load-bearing for parity
//! (a namespace's stored type is always consistent by construction — the
//! key's `namespace` string is 1:1 with a single Rust type at every call
//! site in this crate).

use std::any::Any;
use std::collections::HashMap;

use crate::domain::IrregularGeometryCacheKey;

use super::telemetry::CacheTelemetrySnapshot;

/// TS: `core/geometryCacheStore.ts:1-4` `interface GeometryCacheKey`. See
/// this module's top-level doc for why this is a type alias onto the
/// already-unified [`crate::domain::IrregularGeometryCacheKey`]
/// rather than a second declaration.
pub type GeometryCacheKey = IrregularGeometryCacheKey;

/// TS: `core/geometryCacheStore.ts:13-15` (`serializeGeometryCacheKey`).
///
/// `JSON.stringify([key.namespace, key.parts])` — the entire serialization
/// contract for this cluster's cache keys: a 2-element JSON array
/// `[namespace_string, [part_string, ...]]`. This is the literal `Map<string,
/// unknown>` key TS uses; `geometry-caches.md` §8 pins concrete golden byte
/// strings for three namespaces (reproduced verbatim by this module's own
/// tests below) that any reimplementation must match exactly.
///
/// Hand-rolled string escaping (not `serde_json::to_string`) for the same
/// reason `checkpoints::canonical_json`'s private `json_string_literal`
/// helper is hand-rolled rather than delegated: this pins the exact ECMA-262
/// `QuoteJSONString` algorithm independent of `serde_json`'s own escaping
/// choices, which are not a contractually-guaranteed match. `parts` is
/// always a flat array of strings for this cluster (never nested further),
/// so unlike the four checkpoint encoders this needs no recursive `JsValue`
/// shape — a direct two-level array encode is sufficient.
///
/// **Lone-surrogate hazard (documented, not fixed):** `geometry-caches.md`
/// §8 notes `JSON.stringify` passes lone/unpaired UTF-16 surrogates through
/// **unescaped**, producing technically-invalid-but-V8-consistent JSON text.
/// A Rust `&str`/`String` cannot represent an unpaired surrogate at all (it
/// would not be valid UTF-8), so this hazard cannot even arise on the Rust
/// side of the N-API boundary — any string reaching this function already
/// went through a valid-UTF-8 conversion when it crossed from JS into Rust.
/// This is a structural non-issue for this port, not a gap silently left
/// unhandled.
pub fn serialize_geometry_cache_key(key: &GeometryCacheKey) -> String {
    let mut out = String::with_capacity(32 + key.namespace.len());
    out.push('[');
    push_json_string(&mut out, &key.namespace);
    out.push_str(",[");
    for (index, part) in key.parts.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        push_json_string(&mut out, part);
    }
    out.push_str("]]");
    out
}

/// `JSON.stringify(value)` for a single string, returned as an owned
/// `String` rather than appended to a caller-owned buffer. This is the one
/// seam `legal_candidate_memo` (a different cache-key shape that builds its
/// own flat `JSON.stringify([...])` array rather than addressing this
/// module's `GeometryCacheKey`/`serialize_geometry_cache_key` contract)
/// reuses instead of reimplementing ECMA-262 `QuoteJSONString` a third time
/// in this crate (`checkpoints::canonical_json` has the first copy, private
/// to that module; [`push_json_string`] below is this module's copy).
pub(crate) fn json_string_for_array_element(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    push_json_string(&mut out, value);
    out
}

/// `JSON.stringify(value)` for one `string` — ECMA-262 `QuoteJSONString`:
/// escapes `"`, `\`, and every control character `U+0000..=U+001F` (using
/// the six named short escapes `\b \f \n \r \t` plus `\"`/`\\` where
/// applicable, and lowercase `\u00xx` for every other control character),
/// and passes every other code point — including all non-ASCII text —
/// through unescaped. Mirrors `checkpoints::canonical_json`'s private
/// `json_string_literal` algorithm (that helper is not `pub`, so this
/// module carries its own copy rather than reaching into another task's
/// file — see this file's top-level doc).
fn push_json_string(out: &mut String, value: &str) {
    out.push('"');
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

/// TS: `geometryCacheStoreLive.ts:6-30` (`GeometryCacheStore`,
/// `makeGeometryCacheStore`).
///
/// One job-local backing store for cache namespaces 1.1–1.3. Per
/// `cache-concurrency-design.md` §2 ("Rust design"): constructed once per
/// job (this crate's future `boundary::run_job`), owned (not `Arc`-shared in
/// Stage 2 — single-threaded), dropped when the job's stack frame returns.
/// No explicit `.clear()` call belongs in that lifecycle either — production
/// TS never calls `GeometryCache.clear()` (§2 "Cleanup on completion"); this
/// struct still exposes [`Self::clear`] because the TS interface declares it
/// and a differential/stress-test harness may want it, matching TS's own
/// unused-in-production-but-present method.
pub struct GeometryCacheStore {
    entries: HashMap<String, Box<dyn Any>>,
    telemetry: CacheTelemetrySnapshot,
}

impl Default for GeometryCacheStore {
    fn default() -> Self {
        Self::new()
    }
}

impl GeometryCacheStore {
    /// TS: `makeGeometryCacheStore()` (`geometryCacheStoreLive.ts:9-11`).
    /// Constructs a brand-new backing map and records one cache-instance
    /// telemetry tick (`NfpIfpTelemetry.recordCacheInstance()`).
    pub fn new() -> Self {
        let mut telemetry = CacheTelemetrySnapshot::default();
        telemetry.cache_instances += 1;
        Self {
            entries: HashMap::new(),
            telemetry,
        }
    }

    /// TS: `get: <A>(key) => ...` (`geometryCacheStoreLive.ts:13-17`).
    ///
    /// Always records one lookup for `key.namespace` (TS: `getCalls`,
    /// unconditional). When the entry is absent, also records one miss
    /// directly (absence is knowable from the store alone, unlike
    /// hit-vs-stale, which needs a namespace-specific validity check this
    /// store has no knowledge of — see `record_hit`/`record_stale_detection`
    /// below, which callers with that knowledge invoke explicitly).
    pub fn get<A: Clone + 'static>(&mut self, key: &GeometryCacheKey) -> Option<A> {
        let serialized = serialize_geometry_cache_key(key);
        let found = self
            .entries
            .get(&serialized)
            .and_then(|boxed| boxed.downcast_ref::<A>())
            .cloned();
        let counters = self.telemetry.namespace_mut(&key.namespace);
        counters.lookups += 1;
        if found.is_none() {
            counters.misses += 1;
        }
        found
    }

    /// TS: `set: <A>(key, value) => ...` (`geometryCacheStoreLive.ts:18-21`).
    /// Records one store (TS: `setCalls`) and increments the namespace's
    /// live entry count when this key was not already present.
    pub fn set<A: 'static>(&mut self, key: &GeometryCacheKey, value: A) {
        let serialized = serialize_geometry_cache_key(key);
        let is_new = !self.entries.contains_key(&serialized);
        self.entries.insert(serialized, Box::new(value));
        let counters = self.telemetry.namespace_mut(&key.namespace);
        counters.stores += 1;
        if is_new {
            counters.entries += 1;
        }
    }

    /// TS: `remove: (key) => ...` (`geometryCacheStoreLive.ts:22-25`).
    ///
    /// Per every namespace's exact access sequence (design doc §1.1–§1.3),
    /// `remove` is only ever called immediately after a stale-cache
    /// detection, strictly before recompute — this store therefore records
    /// the removal directly as a stale removal (TS: `removeCalls`; design
    /// doc §6: "equals `stale_detections` in a correct implementation").
    pub fn remove(&mut self, key: &GeometryCacheKey) {
        let serialized = serialize_geometry_cache_key(key);
        let existed = self.entries.remove(&serialized).is_some();
        let counters = self.telemetry.namespace_mut(&key.namespace);
        counters.stale_removals += 1;
        if existed {
            counters.entries = counters.entries.saturating_sub(1);
        }
    }

    /// TS: `clear: () => cache.clear()` (`geometryCacheStoreLive.ts:26-28`).
    /// Not called anywhere in production TS (see this struct's doc comment);
    /// present only for interface parity. Does not touch telemetry, mirroring
    /// TS (`clear` has no `NfpIfpTelemetry` call).
    pub fn clear(&mut self) {
        self.entries.clear();
        for counters in self.telemetry.namespaces.values_mut() {
            counters.entries = 0;
        }
    }

    /// Records a lookup resolving to a valid, immediately-usable cached
    /// value — the "hit" half of TS's conflated `getPresent`, split out per
    /// `cache-concurrency-design.md` §6 (see `telemetry.rs`'s module doc).
    /// Callers invoke this only after running the namespace-specific
    /// `isValidCached*` check this store has no visibility into.
    pub fn record_hit(&mut self, namespace: &str) {
        let counters = self.telemetry.namespace_mut(namespace);
        counters.hits += 1;
        counters.backing_cache_hits += 1;
    }

    /// Records a lookup whose cached value failed namespace-specific
    /// re-validation — the "stale" half of TS's conflated `getPresent`. Per
    /// every namespace's exact access sequence, a stale detection is always
    /// immediately followed by a paired `remove` call, so this method takes
    /// no compensating action itself (see [`Self::remove`]).
    pub fn record_stale_detection(&mut self, namespace: &str) {
        self.telemetry.namespace_mut(namespace).stale_detections += 1;
    }

    /// Read-only telemetry snapshot for this store, aggregated across every
    /// action performed on it so far this job.
    pub fn telemetry(&self) -> &CacheTelemetrySnapshot {
        &self.telemetry
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(namespace: &str, parts: &[&str]) -> GeometryCacheKey {
        GeometryCacheKey::new(
            namespace,
            parts.iter().map(|part| part.to_string()).collect(),
        )
    }

    // -----------------------------------------------------------------
    // serialize_geometry_cache_key: golden byte strings pinned by
    // geometry-caches.md §8 / tests/unit/nfpBoundaryCore.test.ts:38-53 /
    // tests/unit/pureIfpTransformContract.test.ts:184-189.
    // -----------------------------------------------------------------

    #[test]
    fn serialize_matches_the_pairwise_nfp_golden_bytes() {
        let cache_key = key(
            "pairwise-nfp-relative-v3",
            &[
                "fixed-polygon=0,0;0,4;4,4;4,0",
                "moving-polygon=0,0;0,2;2,2;2,0",
                "fixed-transform=index=0,rotation=0,mirrored=0,reason=configured",
                "moving-transform=index=0,rotation=0,mirrored=0,reason=configured",
                "flattening-sag=0.05",
                "clearance-margin=0.05",
                "backend=clipper2-ts",
                "backend-version=2.0.1-18",
                "offset-policy=clipper2-offset-v3-sharp-miter-scale-1000",
                "nfp-algorithm=convex-fixed-plus-negated-moving-relative-v3",
                "nfp-construction=vertex-pair-hull",
            ],
        );
        assert_eq!(
            serialize_geometry_cache_key(&cache_key),
            r#"["pairwise-nfp-relative-v3",["fixed-polygon=0,0;0,4;4,4;4,0","moving-polygon=0,0;0,2;2,2;2,0","fixed-transform=index=0,rotation=0,mirrored=0,reason=configured","moving-transform=index=0,rotation=0,mirrored=0,reason=configured","flattening-sag=0.05","clearance-margin=0.05","backend=clipper2-ts","backend-version=2.0.1-18","offset-policy=clipper2-offset-v3-sharp-miter-scale-1000","nfp-algorithm=convex-fixed-plus-negated-moving-relative-v3","nfp-construction=vertex-pair-hull"]]"#
        );
    }

    #[test]
    fn serialize_matches_the_transform_collision_golden_bytes() {
        let cache_key = key(
            "transform-collision-v1",
            &[
                "source=key-piece;source-bounds=0,0,4,3;placement-reference=0,0;hull=0,0;4,0;4,3;0,3;collision=0,0;4,0;4,3;0,3",
                "index=7,rotation=90,mirrored=1,reason=configured",
                "flattening-sag=0.25",
                "clearance-margin=0.25",
                "backend=irregular-convex-v2-default",
                "backend-version=0",
                "offset-policy=clipper2-offset-v3-sharp-miter-scale-1000",
                "placement-reference=local-lower-left",
                "transform-operation=mirror-y-then-ccw-rotate",
            ],
        );
        assert_eq!(
            serialize_geometry_cache_key(&cache_key),
            r#"["transform-collision-v1",["source=key-piece;source-bounds=0,0,4,3;placement-reference=0,0;hull=0,0;4,0;4,3;0,3;collision=0,0;4,0;4,3;0,3","index=7,rotation=90,mirrored=1,reason=configured","flattening-sag=0.25","clearance-margin=0.25","backend=irregular-convex-v2-default","backend-version=0","offset-policy=clipper2-offset-v3-sharp-miter-scale-1000","placement-reference=local-lower-left","transform-operation=mirror-y-then-ccw-rotate"]]"#
        );
    }

    #[test]
    fn serialize_matches_the_sheet_ifp_golden_bytes() {
        let cache_key = key(
            "sheet-ifp-v1",
            &[
                "sheet=20,15,key sheet",
                "moving-piece=key-piece",
                "moving-transform=index=7,rotation=90,mirrored=1,reason=configured",
                "moving-polygon=0,0;4,0;4,3;0,3",
                "ifp-operation=rectangular-sheet-vertex-bounds",
            ],
        );
        assert_eq!(
            serialize_geometry_cache_key(&cache_key),
            r#"["sheet-ifp-v1",["sheet=20,15,key sheet","moving-piece=key-piece","moving-transform=index=7,rotation=90,mirrored=1,reason=configured","moving-polygon=0,0;4,0;4,3;0,3","ifp-operation=rectangular-sheet-vertex-bounds"]]"#
        );
    }

    #[test]
    fn serialize_escapes_quotes_backslashes_and_control_characters() {
        let cache_key = key("ns", &["has \"quotes\" and \\backslash\\ and \t tab"]);
        assert_eq!(
            serialize_geometry_cache_key(&cache_key),
            r#"["ns",["has \"quotes\" and \\backslash\\ and \t tab"]]"#
        );
    }

    #[test]
    fn serialize_passes_non_ascii_text_through_unescaped() {
        let cache_key = key("ns", &["pièce-日本語"]);
        assert_eq!(
            serialize_geometry_cache_key(&cache_key),
            "[\"ns\",[\"pièce-日本語\"]]"
        );
    }

    // -----------------------------------------------------------------
    // GeometryCacheStore behavior + telemetry wiring.
    // -----------------------------------------------------------------

    #[test]
    fn new_records_exactly_one_cache_instance() {
        let store = GeometryCacheStore::new();
        assert_eq!(store.telemetry().cache_instances, 1);
    }

    #[test]
    fn get_on_an_empty_store_is_a_miss_and_records_lookup_and_miss() {
        let mut store = GeometryCacheStore::new();
        let cache_key = key("transform-collision-v1", &["a"]);
        let result: Option<u32> = store.get(&cache_key);
        assert_eq!(result, None);
        let counters = store.telemetry().namespace("transform-collision-v1");
        assert_eq!(counters.lookups, 1);
        assert_eq!(counters.misses, 1);
        assert_eq!(counters.hits, 0);
    }

    #[test]
    fn set_then_get_round_trips_the_value_and_records_a_store_and_new_entry() {
        let mut store = GeometryCacheStore::new();
        let cache_key = key("sheet-ifp-v1", &["a"]);
        store.set(&cache_key, 42u32);
        let counters = store.telemetry().namespace("sheet-ifp-v1");
        assert_eq!(counters.stores, 1);
        assert_eq!(counters.entries, 1);

        let result: Option<u32> = store.get(&cache_key);
        assert_eq!(result, Some(42));
        // A present entry does not by itself record a hit or a miss -- the
        // store cannot determine validity; see record_hit's doc comment.
        let counters = store.telemetry().namespace("sheet-ifp-v1");
        assert_eq!(counters.lookups, 1);
        assert_eq!(counters.misses, 0);
        assert_eq!(counters.hits, 0);
    }

    #[test]
    fn record_hit_increments_hits_and_backing_cache_hits() {
        let mut store = GeometryCacheStore::new();
        store.record_hit("pairwise-nfp-relative-v3");
        let counters = store.telemetry().namespace("pairwise-nfp-relative-v3");
        assert_eq!(counters.hits, 1);
        assert_eq!(counters.backing_cache_hits, 1);
    }

    #[test]
    fn remove_records_a_stale_removal_and_decrements_entries() {
        let mut store = GeometryCacheStore::new();
        let cache_key = key("transform-collision-v1", &["a"]);
        store.set(&cache_key, 7u32);
        store.record_stale_detection("transform-collision-v1");
        store.remove(&cache_key);

        let counters = store.telemetry().namespace("transform-collision-v1");
        assert_eq!(counters.stale_detections, 1);
        assert_eq!(counters.stale_removals, 1);
        assert_eq!(counters.entries, 0);

        let result: Option<u32> = store.get(&cache_key);
        assert_eq!(result, None);
    }

    #[test]
    fn downcast_mismatch_is_reported_as_a_miss_not_a_panic() {
        let mut store = GeometryCacheStore::new();
        let cache_key = key("ns", &["a"]);
        store.set(&cache_key, 1u32);
        let result: Option<String> = store.get(&cache_key);
        assert_eq!(result, None);
    }

    #[test]
    fn clear_empties_the_store_and_zeroes_entry_counts_but_not_other_counters() {
        let mut store = GeometryCacheStore::new();
        let cache_key = key("ns", &["a"]);
        store.set(&cache_key, 1u32);
        store.clear();
        let result: Option<u32> = store.get(&cache_key);
        assert_eq!(result, None);
        let counters = store.telemetry().namespace("ns");
        assert_eq!(counters.entries, 0);
        // clear() does not touch setCalls/getCalls-equivalent counters,
        // matching TS's clear() having no NfpIfpTelemetry call at all.
        assert_eq!(counters.stores, 1);
    }
}
