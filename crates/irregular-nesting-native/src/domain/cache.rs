//! Stable geometry-cache identity.
//!
//! TS source: `src/shared/irregular/domain.ts:883-898`.

use serde::{Deserialize, Serialize};

/// TS: `domain.ts:890-898` `class IrregularGeometryCacheKey`. Stable
/// namespace and ordered parts used to identify cached geometry.
///
/// `characterization/effect-boundary.md` §14 item 3 documents that
/// `IrregularGeometryCacheKey` (this class) and `GeometryCacheKey` (a
/// separate `core/geometryCacheStore.ts` plain interface,
/// `{namespace: string, parts: readonly string[]}`) are two independently
/// declared, structurally identical shapes that TypeScript's structural
/// typing lets flow into each other's call sites for free, with zero
/// conversion code. A Rust port "must either unify these into one type or
/// write an explicit `From`/`Into` conversion". This module takes the unify
/// branch: `IrregularGeometryCacheKey` is the single Rust type for this
/// shape, and any later cache-store module must reuse it directly rather
/// than declaring a second, structurally-identical type.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct IrregularGeometryCacheKey {
    pub namespace: String,
    pub parts: Vec<String>,
}

impl IrregularGeometryCacheKey {
    pub fn new(namespace: impl Into<String>, parts: Vec<String>) -> Self {
        Self {
            namespace: namespace.into(),
            parts,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn geometry_cache_key_round_trips_through_json() {
        let key = IrregularGeometryCacheKey::new(
            "convex-hull",
            vec!["piece-1".to_string(), "0.25".to_string()],
        );
        let json = serde_json::to_string(&key).expect("cache key serializes");
        assert_eq!(
            json,
            r#"{"namespace":"convex-hull","parts":["piece-1","0.25"]}"#
        );
        let decoded: IrregularGeometryCacheKey =
            serde_json::from_str(&json).expect("cache key deserializes");
        assert_eq!(decoded, key);
    }

    #[test]
    fn geometry_cache_key_is_usable_as_a_hash_map_key() {
        let mut cache: HashMap<IrregularGeometryCacheKey, u32> = HashMap::new();
        cache.insert(
            IrregularGeometryCacheKey::new("ns", vec!["a".to_string()]),
            1,
        );
        assert_eq!(
            cache.get(&IrregularGeometryCacheKey::new("ns", vec!["a".to_string()])),
            Some(&1)
        );
    }
}
