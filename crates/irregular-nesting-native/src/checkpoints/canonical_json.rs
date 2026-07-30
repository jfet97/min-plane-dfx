//! The four independently-declared "canonical JSON"-family encoders used
//! across the checkpoint-encoding cluster (ruling R5: kept as four distinct
//! functions, never unified into one generic encoder — see
//! `docs/planning/rust-irregular-backend/stage0-rulings.md` R5 and
//! `docs/planning/rust-irregular-backend/characterization/checkpoint-encoding.md`
//! §8, which is this module's primary governing source).
//!
//! Three of the four are genuine recursive-JSON-shaped hash-preimage
//! builders (Encoders A/B/C below); the fourth (`canonicalRecord`/
//! `canonicalNumber`/`canonicalEntryListKey`, Encoder D) is a structurally
//! different length-prefixed token record format, not JSON at all — it is
//! grouped in this module only because ruling R5/the implementation prompt
//! group it with the other three as "the canonical-JSON-family" and because
//! its own `canonicalNumber` shares the same ECMAScript number-rendering
//! concern as the other three's `JSON.stringify` number branch.
//!
//! None of these four functions ever serializes a checkpoint to bytes for
//! wire use (checkpoint-encoding.md §8.0 — no checkpoint of any kind is ever
//! written to disk or crosses a process boundary in production); they exist
//! solely as deterministic hash-preimage / cache-key builders. Byte-exact
//! reproduction still matters because the resulting strings feed SHA-256
//! hashes and cache-key equality checks that are part of the validated,
//! chronology-affecting contract.
//!
//! Encoder D's primitives (`canonical_token`/`canonical_number`/
//! `canonical_record`/`canonical_entry_list_key`) are `pub` specifically so
//! the `search` module (owner of the rest of `irregularBeamState.ts` per
//! `src/search/mod.rs`'s module doc) can import them rather than
//! re-implementing this exact family a second time.

use num_bigint::BigInt;
use std::cmp::Ordering;
use std::fmt::Write as _;

use crate::js_number::{cmp_js_code_units, number_to_js_string};

/// A JS value as consumed by the three JSON-shaped canonical encoders below.
///
/// Modeled per the migration prompt's instruction (§9) and this crate's
/// stage-0 ruling R5/R6/R7: object fields preserve **insertion order** in a
/// `Vec`, never a `HashMap` (object key order is semantically load-bearing
/// input to every encoder's own sort step, and an unordered map would erase
/// the very thing the differential vectors need to exercise — unsorted-key
/// input). `BigInt` uses `num_bigint::BigInt` per R6.
///
/// Extends the four "plain JSON" variants the implementation brief names
/// (`Null`, `Bool`, `Num`, `BigInt`, `Str`, `Arr`, `Obj`) with two more that
/// are required to faithfully exercise the exact TS behaviors ruling R5
/// requires differential-testing (checkpoint-encoding.md §7, §8.2):
/// - `Undefined` — JS `undefined`, distinct from `Null`. Needed to exercise
///   the real `.filter(([, fieldValue]) => fieldValue !== undefined)` /
///   `Array.prototype.join` undefined-omission behavior documented in §7 as
///   a genuine, observable quirk (an object field holding `Undefined` is
///   dropped from the encoded object; an array element holding `Undefined`
///   renders as an empty join segment, e.g. `canonicalJson([1, undefined, 3])
///   === "[1,,3]"`, confirmed by direct execution against Node v24 for this
///   module's own differential-vector generation) — without this variant
///   there would be no way to construct that input at all.
/// - `Map(Vec<(JsValue, JsValue)>)` — a JS `Map`, needed to exercise Encoder
///   B's explicit `instanceof Map` branch (§8.2), which is textually unique
///   to that encoder. Modeled as an ordered pair list (not `HashMap`) because
///   `Map` preserves insertion order in JS and because the encoder itself
///   re-sorts the entries by `String(key).localeCompare(...)` — the
///   pre-sort order must be under test control to prove the sort actually
///   runs.
#[derive(Debug, Clone, PartialEq)]
pub enum JsValue {
    Undefined,
    Null,
    Bool(bool),
    Num(f64),
    BigInt(BigInt),
    Str(String),
    Arr(Vec<JsValue>),
    Obj(Vec<(String, JsValue)>),
    Map(Vec<(JsValue, JsValue)>),
}

// ---------------------------------------------------------------------------
// Shared low-level JSON primitives (native `JSON.stringify` behavior for
// strings/numbers/booleans/null — every one of the three JSON-shaped
// encoders below delegates to these for its non-container branch).
// ---------------------------------------------------------------------------

/// `JSON.stringify(value)` for a `string` — the ECMA-262 `QuoteJSONString`
/// algorithm: escapes `"`, `\`, and every control character `U+0000..=U+001F`
/// (using the six named short escapes `\b \f \n \r \t` plus `\"`/`\\` where
/// applicable, and `\u00xx` lowercase-hex for every other control character),
/// and passes every other code point — including all non-ASCII text —
/// through **unescaped**. Confirmed against Node v24 directly (this module's
/// own dump script also exercises this via the real `canonicalJson`
/// functions, not just this helper in isolation).
///
/// Hand-rolled rather than delegated to `serde_json::to_string` so this
/// module's string-escaping contract is pinned to the exact ECMA-262
/// algorithm by construction, independent of `serde_json`'s own (currently
/// matching, but not contractually guaranteed by this crate's dependency
/// bound) default string-escaping choices.
fn json_string_literal(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
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
    out
}

/// `JSON.stringify(value)` for a `number` — non-finite values (`NaN`,
/// `+Infinity`, `-Infinity`) collapse to the bare token `null` (confirmed
/// against Node v24: `JSON.stringify(NaN) === "null"`,
/// `checkpoint-encoding.md` §7); every finite value (including `-0`, which
/// renders as `"0"`, not `"-0"`) uses ECMAScript `Number::toString` via
/// [`number_to_js_string`].
///
/// `pub(crate)` (not just `fn`) specifically so any other module that hand-
/// builds a `JSON.stringify`-equivalent string for a plain `f64` field --
/// rather than routing through one of this module's four full encoders --
/// can reuse this exact number-rendering rule instead of re-deriving it.
/// Confirmed reused by `validation::spatial_index::PlacedCollisionSpatialIndex::continuation_identity`
/// (`cellSizeMm`) and `search::beam_state::IrregularBeamState::contact_signature_continuation_identity`
/// (the signature-count field), both of which build a raw `JSON.stringify`
/// preimage by hand for the same reason this module's encoders exist: a
/// checkpoint/dedup-identity hash preimage that must reproduce TS's
/// `Number::toString` rendering exactly, not Rust's default `f64`
/// `Serialize` (which renders whole-valued floats like `64.0` with a
/// trailing `.0` that JS never emits).
pub(crate) fn json_number_token(value: f64) -> String {
    if value.is_nan() || value.is_infinite() {
        "null".to_string()
    } else {
        number_to_js_string(value)
    }
}

/// `String(value)` (the JS `ToString` abstract operation), used only for the
/// `String(key)` coercion inside Encoder B's `Map`-entry sort
/// (`intrinsicStrictDecoder.ts:1264-1266`,
/// `[...value.entries()].toSorted(([first], [second]) =>
/// String(first).localeCompare(String(second)))`) — **not** the same as
/// `JSON.stringify` (e.g. `String(undefined) === "undefined"`, a plain bare
/// word, versus `JSON.stringify(undefined) === undefined`, the actual JS
/// `undefined` value).
///
/// No production checkpoint field is `Map`-typed (checkpoint-encoding.md
/// §8.2), so no production `Map` key is ever anything but a `string` in
/// practice; the non-primitive arms below (`Arr`/`Obj`/`Map`) exist only for
/// this function's own general-purpose completeness (mirroring
/// `intrinsicStrictCanonicalJson`'s own general-purpose reach beyond this
/// cluster) and are a best-effort, documented approximation, not a full
/// `ToPrimitive`/`ToString` implementation:
/// - `Arr` mirrors `Array.prototype.join(',')`'s own recursive `String()`
///   coercion, where `null`/`undefined` elements contribute an empty segment
///   (confirmed against Node v24).
/// - `Obj`/`Map` fall back to the fixed default `Object.prototype.toString`-
///   free `toString()` results every plain object/`Map` produces regardless
///   of contents (`"[object Object]"`, `"[object Map]"`).
fn js_to_string(value: &JsValue) -> String {
    match value {
        JsValue::Undefined => "undefined".to_string(),
        JsValue::Null => "null".to_string(),
        JsValue::Bool(true) => "true".to_string(),
        JsValue::Bool(false) => "false".to_string(),
        JsValue::Num(n) => number_to_js_string(*n),
        JsValue::BigInt(b) => b.to_string(),
        JsValue::Str(s) => s.clone(),
        JsValue::Arr(items) => items
            .iter()
            .map(|item| match item {
                JsValue::Undefined | JsValue::Null => String::new(),
                other => js_to_string(other),
            })
            .collect::<Vec<_>>()
            .join(","),
        JsValue::Obj(_) => "[object Object]".to_string(),
        JsValue::Map(_) => "[object Map]".to_string(),
    }
}

/// Joins already-encoded array-element strings the way
/// `value.map(canonicalJson).join(',')` does when an element's own
/// `canonicalJson(...)` call returned the literal JS `undefined` value
/// (possible only when that element is itself `JsValue::Undefined`, per
/// each encoder's non-container branch below): `Array.prototype.join`
/// coerces `null`/`undefined` elements to an **empty string**, not the
/// literal text `"undefined"` — confirmed against Node v24:
/// `canonicalJson([1, undefined, 3]) === "[1,,3]"`. `element` is `None` for
/// exactly that case and `Some(rendered)` otherwise.
fn join_array_elements(elements: Vec<Option<String>>) -> String {
    elements
        .into_iter()
        .map(|element| element.unwrap_or_default())
        .collect::<Vec<_>>()
        .join(",")
}

// ---------------------------------------------------------------------------
// Encoder A — `canonicalJson`, `intrinsicCapacitySearch.ts:1626-1635`
// (ordinal/code-unit key sort via `compareStrings`, `:2233-2237`).
// ---------------------------------------------------------------------------

/// Port of `canonicalJson` (`src/workers/algorithm/irregular/intrinsicCapacitySearch.ts:1626-1635`),
/// used to build `intrinsicCapacityCheckpointIntegrityHash`'s and
/// `intrinsicCapacityRequestFingerprint`'s SHA-256 hash preimages. Object
/// keys are sorted using `compareStrings` (`intrinsicCapacitySearch.ts:2233-2237`),
/// which is plain JS `<`/`>` — UTF-16 code-unit ordinal order, reproduced
/// here via [`cmp_js_code_units`] per ruling R8.
///
/// Returns `None` only when `value` is `JsValue::Undefined` itself — this
/// mirrors `JSON.stringify(undefined)` returning the actual JS `undefined`
/// value (not a string); every container branch (`Arr`/`Obj`) always
/// returns `Some`, since `JSON.stringify`'s undefined-quirk can only
/// surface through recursion into an array element or a filtered-out object
/// field, both handled explicitly below (see [`join_array_elements`]).
///
/// # Panics
///
/// Panics if `value` (at any recursion depth) contains `JsValue::Map`. The
/// real TS `canonicalJson` has no `instanceof Map` branch at all; a raw
/// `Map` falls into the generic "object" branch, where
/// `Object.entries(mapInstance)` silently returns `[]` (`Map` has no
/// own-enumerable string-keyed properties), so the TS function would
/// silently encode any `Map` as `"{}"` regardless of contents. No field
/// reaching this encoder in `intrinsicCapacitySearch.ts` is `Map`-typed
/// today (checkpoint-encoding.md §8.1), and per that same section's explicit
/// guidance, a Rust port "must not silently accept a `HashMap`/`BTreeMap`
/// input either; it should be typed to reject at compile time... or
/// explicitly panic" — this function chooses the panic, a deliberate,
/// documented deviation from the literal (but never-exercised) TS silent-`{}`
/// behavior.
pub fn intrinsic_capacity_canonical_json(value: &JsValue) -> Option<String> {
    match value {
        JsValue::Undefined => None,
        JsValue::BigInt(value) => Some(json_string_literal(&value.to_string())),
        JsValue::Null => Some("null".to_string()),
        JsValue::Bool(true) => Some("true".to_string()),
        JsValue::Bool(false) => Some("false".to_string()),
        JsValue::Num(n) => Some(json_number_token(*n)),
        JsValue::Str(s) => Some(json_string_literal(s)),
        JsValue::Map(_) => panic!(
            "intrinsic_capacity_canonical_json: JsValue::Map has no encoding contract in \
             intrinsicCapacitySearch.ts's canonicalJson (would silently encode as \"{{}}\" in \
             TS); see checkpoint-encoding.md §8.1"
        ),
        JsValue::Arr(items) => {
            let elements = items
                .iter()
                .map(intrinsic_capacity_canonical_json)
                .collect();
            Some(format!("[{}]", join_array_elements(elements)))
        }
        JsValue::Obj(fields) => {
            let mut filtered: Vec<&(String, JsValue)> = fields
                .iter()
                .filter(|(_, field_value)| !matches!(field_value, JsValue::Undefined))
                .collect();
            // `Array.prototype.toSorted` is stable; `slice::sort_by` is stable too.
            filtered.sort_by(|(first_key, _), (second_key, _)| {
                cmp_js_code_units(first_key, second_key)
            });
            let joined = filtered
                .iter()
                .map(|(key, field_value)| {
                    let encoded_value = intrinsic_capacity_canonical_json(field_value)
                        .expect("filtered-out fields never reach here as JsValue::Undefined");
                    format!("{}:{}", json_string_literal(key), encoded_value)
                })
                .collect::<Vec<_>>()
                .join(",");
            Some(format!("{{{}}}", joined))
        }
    }
}

// ---------------------------------------------------------------------------
// Encoder B — `intrinsicStrictCanonicalJson`,
// `intrinsicStrictDecoder.ts:1257-1277` (localeCompare key sort, explicit
// `Map` handling).
// ---------------------------------------------------------------------------

/// Port of `intrinsicStrictCanonicalJson`
/// (`src/workers/algorithm/irregular/intrinsicStrictDecoder.ts:1257-1277`),
/// used to build `intrinsicStrictDirectCheckpointIntegrityHash`'s and
/// `intrinsicStrictDirectRequestFingerprint`'s SHA-256 hash preimages, and
/// (in the caller file's own scope, outside this cluster) candidate-
/// provenance memoization keys.
///
/// Textually near-identical to [`intrinsic_capacity_canonical_json`] except:
/// - object keys are sorted using `firstKey.localeCompare(secondKey)`
///   (locale-aware, not ordinal — see [`locale_compare_keys`] and ruling R8);
/// - an explicit `value instanceof Map` branch sorts entries by
///   `String(key).localeCompare(String(otherKey))` (via [`js_to_string`] +
///   [`locale_compare_keys`]) and recurses into the sorted `[key, value]`
///   pair array.
///
/// See [`intrinsic_capacity_canonical_json`]'s doc for the shared
/// `Undefined`-return-value and array-join-of-`undefined`-elements
/// semantics, which are identical here.
pub fn intrinsic_strict_canonical_json(value: &JsValue) -> Option<String> {
    match value {
        JsValue::Undefined => None,
        JsValue::BigInt(value) => Some(json_string_literal(&value.to_string())),
        JsValue::Null => Some("null".to_string()),
        JsValue::Bool(true) => Some("true".to_string()),
        JsValue::Bool(false) => Some("false".to_string()),
        JsValue::Num(n) => Some(json_number_token(*n)),
        JsValue::Str(s) => Some(json_string_literal(s)),
        JsValue::Arr(items) => {
            let elements = items.iter().map(intrinsic_strict_canonical_json).collect();
            Some(format!("[{}]", join_array_elements(elements)))
        }
        JsValue::Map(entries) => {
            let mut sorted: Vec<&(JsValue, JsValue)> = entries.iter().collect();
            sorted.sort_by(|(first_key, _), (second_key, _)| {
                locale_compare_keys(&js_to_string(first_key), &js_to_string(second_key))
            });
            let as_pairs = JsValue::Arr(
                sorted
                    .into_iter()
                    .map(|(key, entry_value)| JsValue::Arr(vec![key.clone(), entry_value.clone()]))
                    .collect(),
            );
            intrinsic_strict_canonical_json(&as_pairs)
        }
        JsValue::Obj(fields) => {
            let mut filtered: Vec<&(String, JsValue)> = fields
                .iter()
                .filter(|(_, field_value)| !matches!(field_value, JsValue::Undefined))
                .collect();
            filtered.sort_by(|(first_key, _), (second_key, _)| {
                locale_compare_keys(first_key, second_key)
            });
            let joined = filtered
                .iter()
                .map(|(key, field_value)| {
                    let encoded_value = intrinsic_strict_canonical_json(field_value)
                        .expect("filtered-out fields never reach here as JsValue::Undefined");
                    format!("{}:{}", json_string_literal(key), encoded_value)
                })
                .collect::<Vec<_>>()
                .join(",");
            Some(format!("{{{}}}", joined))
        }
    }
}

// ---------------------------------------------------------------------------
// Encoder C — `canonicalJson`, `intrinsicPeriodicFamilyPortfolio.ts:1285-1293`
// (not a checkpoint encoder — a source-audit replay-envelope digest builder;
// included per ruling R5 as the fourth cross-encoder comparison point).
// ---------------------------------------------------------------------------

/// Port of `canonicalJson`
/// (`src/workers/algorithm/irregular/intrinsicPeriodicFamilyPortfolio.ts:1285-1293`).
/// Same shape as [`intrinsic_capacity_canonical_json`] except: `localeCompare`
/// key sort (like Encoder B, unlike Encoder A) via [`locale_compare_keys`],
/// and **no `bigint` branch at all**.
///
/// # Panics
///
/// Panics if `value` (at any recursion depth) contains `JsValue::BigInt`.
/// The real TS function has no `typeof value === 'bigint'` branch; a bigint
/// falls through to `typeof value !== 'object'` (true — `typeof someBigint
/// === 'bigint'`) and reaches `JSON.stringify(value)`, which **throws**
/// `TypeError: Do not know how to serialize a BigInt` (confirmed by direct
/// `node -e` execution, checkpoint-encoding.md §7). This is a genuine,
/// uncaught synchronous JS exception at the point this function is called
/// (not a typed `Effect` failure — this is a plain, non-`Effect` helper) —
/// the Rust port's equivalent is a panic, mirroring this crate's treatment
/// of `makeIntrinsicStrictDirectCheckpoint`'s own genuine
/// `throw`-as-defect case (checkpoint-encoding.md §11, ported as a
/// `panic!`-class invariant violation, never a recoverable `Result::Err`).
///
/// Also panics on `JsValue::Map`, for the same reason and with the same
/// "silently encodes as `{}` in TS, panic instead in this port" rationale
/// documented on [`intrinsic_capacity_canonical_json`] (this file's own
/// `canonicalJson` also lacks an `instanceof Map` branch).
pub fn intrinsic_periodic_canonical_json(value: &JsValue) -> Option<String> {
    match value {
        JsValue::Undefined => None,
        JsValue::BigInt(_) => panic!(
            "intrinsic_periodic_canonical_json: BigInt is not serializable by \
             intrinsicPeriodicFamilyPortfolio.ts's canonicalJson (real TS throws \
             `TypeError: Do not know how to serialize a BigInt`); see \
             checkpoint-encoding.md §7"
        ),
        JsValue::Null => Some("null".to_string()),
        JsValue::Bool(true) => Some("true".to_string()),
        JsValue::Bool(false) => Some("false".to_string()),
        JsValue::Num(n) => Some(json_number_token(*n)),
        JsValue::Str(s) => Some(json_string_literal(s)),
        JsValue::Map(_) => panic!(
            "intrinsic_periodic_canonical_json: JsValue::Map has no encoding contract in \
             intrinsicPeriodicFamilyPortfolio.ts's canonicalJson (would silently encode as \
             \"{{}}\" in TS); see checkpoint-encoding.md §8.1/§8.3"
        ),
        JsValue::Arr(items) => {
            let elements = items
                .iter()
                .map(intrinsic_periodic_canonical_json)
                .collect();
            Some(format!("[{}]", join_array_elements(elements)))
        }
        JsValue::Obj(fields) => {
            let mut filtered: Vec<&(String, JsValue)> = fields
                .iter()
                .filter(|(_, field_value)| !matches!(field_value, JsValue::Undefined))
                .collect();
            filtered.sort_by(|(first_key, _), (second_key, _)| {
                locale_compare_keys(first_key, second_key)
            });
            let joined = filtered
                .iter()
                .map(|(key, field_value)| {
                    let encoded_value = intrinsic_periodic_canonical_json(field_value)
                        .expect("filtered-out fields never reach here as JsValue::Undefined");
                    format!("{}:{}", json_string_literal(key), encoded_value)
                })
                .collect::<Vec<_>>()
                .join(",");
            Some(format!("{{{}}}", joined))
        }
    }
}

// ---------------------------------------------------------------------------
// `localeCompare`-equivalent key comparator, shared by Encoders B and C.
// ---------------------------------------------------------------------------

/// Primary collation weight for each ASCII printable byte `0x20..=0x7e`,
/// indexed by `byte - 0x20`. Case-pair letters (`'a'`/`'A'`, `'b'`/`'B'`, …)
/// share a weight; every other printable character has a weight unique to
/// it. Empirically derived (not hand-guessed) from Node v24's actual
/// `Array.prototype.sort((a, b) => a.localeCompare(b))` order over every
/// printable ASCII character, then validated by generating and comparing
/// 200,000 random ASCII strings (drawn from this same alphabet, lengths
/// 1-8) through both real `String.prototype.localeCompare` (Node v24,
/// default/root locale) and the two-level algorithm in
/// [`locale_compare_keys`] below, with **zero** mismatches — see this
/// crate's differential vector generator
/// (`scripts/rust-parity/dump-canonical-json.ts`) and
/// `tests/vectors/canonical-json.json` for the committed, pinned proof.
const LOCALE_PRIMARY_WEIGHT: [u16; 95] = [
    0, 6, 10, 22, 32, 23, 21, 9, 11, 12, 18, 26, 3, 2, 8, 19, 33, 34, 35, 36, 37, 38, 39, 40, 41,
    42, 5, 4, 27, 28, 29, 7, 17, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58,
    59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 13, 20, 14, 25, 1, 24, 43, 44, 45, 46, 47, 48, 49, 50,
    51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 15, 30, 16, 31,
];

const LOCALE_TABLE_MIN: u32 = 0x20;
const LOCALE_TABLE_MAX: u32 = 0x7e;

/// Primary collation weight for one `char`. Characters outside the
/// empirically-validated printable-ASCII table (control characters, `DEL`,
/// and any non-ASCII code point) get a weight derived from their code point,
/// offset above every table weight so they never spuriously tie with a
/// table character — this is a deterministic fallback, **not** a proven
/// match for Node's ICU collation outside the printable-ASCII range (see
/// [`locale_compare_keys`]'s `debug_assert`).
fn locale_primary_weight(ch: char) -> u32 {
    let code_point = ch as u32;
    if (LOCALE_TABLE_MIN..=LOCALE_TABLE_MAX).contains(&code_point) {
        LOCALE_PRIMARY_WEIGHT[(code_point - LOCALE_TABLE_MIN) as usize] as u32
    } else {
        0x110000 + code_point
    }
}

/// A `localeCompare`-equivalent comparator for the object-key sort inside
/// Encoders B and C (`firstKey.localeCompare(secondKey)`,
/// `intrinsicStrictDecoder.ts:1271`, `intrinsicPeriodicFamilyPortfolio.ts:1291`)
/// and, via [`js_to_string`], Encoder B's `Map`-entry sort.
///
/// Node's `String.prototype.localeCompare` (no explicit locale/options
/// argument, the only call shape used at every site in this cluster) uses
/// full ICU default-locale collation, which this crate does not vendor.
/// Per ruling R8 ("a Rust port using pure ordinal `str::cmp`... would only
/// be safe if it independently proves every possible key string sorts
/// identically under both orderings — do not assume this") and
/// `checkpoint-encoding.md` §6/§15's explicit instruction to "implement the
/// actual `localeCompare`-equivalent collation... or prove empirically...
/// and pin that proof with a test," this function implements a two-level
/// algorithm empirically validated (zero mismatches over 200,000 random
/// trials, see [`LOCALE_PRIMARY_WEIGHT`]'s doc) against real Node v24
/// `localeCompare` output for the entire printable-ASCII alphabet:
///
/// 1. **Primary pass**: compare `a` and `b` character-by-character by
///    [`locale_primary_weight`] (case-insensitive for letters); the first
///    differing weight decides. If every compared position ties and the
///    strings differ in length, the shorter string sorts first (matching
///    `"a".localeCompare("aa") < 0`).
/// 2. **Tertiary pass** (only reached when the primary pass ties
///    completely, including length): compare `a` and `b` character-by-
///    character again; at the first position where the characters differ,
///    lowercase sorts before uppercase (matching
///    `"a".localeCompare("A") < 0`, `"ab".localeCompare("aB") < 0`).
///
/// This is the concrete example ruling R8/`checkpoint-encoding.md` §6 flags
/// as the divergence from ordinal comparison: `"a".localeCompare("B") < 0`
/// (`'a'` sorts before `'B'`) while plain `'a' < 'B'` is `false` (ordinal
/// `'B'` (`0x42`) sorts before `'a'` (`0x61`)) — see
/// `tests/canonical_json_vectors.rs` for the differential vectors proving
/// both this function and [`cmp_js_code_units`] reproduce their respective
/// real TS orderings, including on inputs where they diverge.
///
/// Real checkpoint object keys are always hand-written ASCII field names
/// (`checkpoint-encoding.md` §6 confirms this for every field-name set
/// actually reached by Encoders B/C); the `debug_assert` below flags (in
/// debug/test builds only) any non-ASCII key reaching this comparator, since
/// this function's ordering is only proven equivalent to Node's collation
/// for the printable-ASCII range documented above — a release build falls
/// back to the deterministic (but unproven) [`locale_primary_weight`]
/// out-of-table branch rather than panicking, since production correctness
/// for real (all-ASCII) field-name keys is unaffected either way.
pub fn locale_compare_keys(first: &str, second: &str) -> Ordering {
    debug_assert!(
        first.is_ascii() && second.is_ascii(),
        "locale_compare_keys received a non-ASCII key ({first:?}, {second:?}); this \
         comparator's ordering is only empirically proven equivalent to Node's \
         localeCompare for the printable-ASCII range — see this function's doc comment"
    );

    let mut first_chars = first.chars();
    let mut second_chars = second.chars();
    loop {
        match (first_chars.next(), second_chars.next()) {
            (Some(first_char), Some(second_char)) => {
                let first_weight = locale_primary_weight(first_char);
                let second_weight = locale_primary_weight(second_char);
                if first_weight != second_weight {
                    return first_weight.cmp(&second_weight);
                }
            }
            (Some(_), None) => return Ordering::Greater,
            (None, Some(_)) => return Ordering::Less,
            (None, None) => break,
        }
    }

    // Primary pass tied on every position and on length: fall back to a
    // case-only tie-break pass (lowercase before uppercase), first
    // differing position decides.
    for (first_char, second_char) in first.chars().zip(second.chars()) {
        if first_char == second_char {
            continue;
        }
        let first_is_upper = first_char.is_ascii_uppercase();
        let second_is_upper = second_char.is_ascii_uppercase();
        if first_is_upper != second_is_upper {
            return if first_is_upper {
                Ordering::Greater
            } else {
                Ordering::Less
            };
        }
    }
    Ordering::Equal
}

// ---------------------------------------------------------------------------
// Encoder D — `canonicalRecord`/`canonicalToken`/`canonicalNumber`/
// `canonicalEntryListKey`, `irregularBeamState.ts:829-864`. A length-
// prefixed token record format, not JSON.
// ---------------------------------------------------------------------------

/// Port of `canonicalToken`
/// (`src/workers/algorithm/irregular/irregularBeamState.ts:840-842`):
/// `` `${value.length}:${value}` `` — a netstring-style length-prefixed
/// token. `value.length` in JS is a **UTF-16 code-unit count**, not a byte
/// count and not a Unicode-scalar-value count; reproduced here via
/// `str::encode_utf16().count()` per ruling R8's "compare/measure by u16
/// code units, not bytes, when non-ASCII is possible" instruction (the same
/// count JS's own `.length` would report for any string containing
/// supplementary-plane characters, which take two UTF-16 code units each
/// but only one `char` in Rust).
pub fn canonical_token(value: &str) -> String {
    let mut buf = String::with_capacity(value.len() + 12);
    write_canonical_token(&mut buf, value);
    buf
}

/// R21-class allocation-reduction (`docs/planning/rust-irregular-backend/`
/// migration prompt §21's optimization discipline): writes exactly
/// [`canonical_token`]'s output into an existing, possibly-reused `buf`
/// instead of allocating and returning a fresh owned `String` per call.
/// [`canonical_token`] itself now delegates here, so the two can never
/// silently drift apart.
///
/// # Semantic invariant
///
/// Byte-for-byte identical to `buf.push_str(&canonical_token(value))` for
/// every input, including non-ASCII strings — this is not an approximation.
///
/// # ASCII fast path
///
/// `value.encode_utf16().count()` (the UTF-16 code-unit count `canonical_token`'s
/// own doc requires) is mathematically identical to `value.len()` (the UTF-8
/// *byte* count) whenever `value` is pure ASCII: every ASCII scalar value
/// encodes to exactly one UTF-8 byte and exactly one UTF-16 code unit, so the
/// two counts coincide term-for-term. `str::is_ascii` is a single forward
/// byte scan with no per-`char` UTF-8 decode / UTF-16 re-encode step, so this
/// branch is strictly cheaper than the general path for ASCII input (every
/// value this crate's hot canonical-key-building call sites in
/// `search::beam_state` ever pass — see that module's own callers of this
/// function) and produces the exact same result as the always-correct
/// `encode_utf16().count()` fallback, which remains in place for the
/// general (non-ASCII, e.g. a user-supplied piece name elsewhere in the
/// crate) case.
pub(crate) fn write_canonical_token(buf: &mut String, value: &str) {
    let units = if value.is_ascii() {
        value.len()
    } else {
        value.encode_utf16().count()
    };
    write!(buf, "{units}:").expect("writing to a String never fails");
    buf.push_str(value);
}

/// Writes `canonicalToken(format!("{prefix}{index}"))` (a decimal-suffixed
/// label token, e.g. `"point-3"`/`"entry-12"`) directly into `buf` without
/// materializing the label string first. `prefix` must be ASCII (every call
/// site in this crate passes a fixed ASCII literal — `"point-"`,
/// `"entry-"` — `debug_assert`ed, not merely assumed) so this UTF-16-length
/// shortcut (`prefix.len() + decimal digit count of index`, both byte
/// counts) is provably identical to `write_canonical_token(buf,
/// &format!("{prefix}{index}"))`'s own ASCII fast path.
pub(crate) fn write_indexed_canonical_token(buf: &mut String, prefix: &str, index: usize) {
    debug_assert!(
        prefix.is_ascii(),
        "write_indexed_canonical_token requires an ASCII prefix (got {prefix:?})"
    );
    let units = prefix.len() + decimal_digit_count(index);
    write!(buf, "{units}:{prefix}{index}").expect("writing to a String never fails");
}

/// The decimal digit count of `value` (`1` for `0` itself, matching
/// `usize`'s `Display` rendering having exactly one digit for zero).
fn decimal_digit_count(mut value: usize) -> usize {
    if value == 0 {
        return 1;
    }
    let mut digits = 0;
    while value > 0 {
        digits += 1;
        value /= 10;
    }
    digits
}

/// Port of `canonicalNumber`
/// (`src/workers/algorithm/irregular/irregularBeamState.ts:844-850`).
///
/// Distinct from both [`json_number_token`] (which maps every non-finite
/// value to the bare token `null`, `JSON.stringify`'s convention) and plain
/// [`number_to_js_string`] (which renders `+Infinity` as `"Infinity"`, no
/// leading sign): this function's own non-finite/`-0` branches run *first*
/// and take priority, rendering `NaN → "NaN"`, `-0 → "0"`,
/// `+Infinity → "+Infinity"` (note the leading `+`, unique to this
/// function among the four encoders in this module),
/// `-Infinity → "-Infinity"`; every other (finite, non-negative-zero) value
/// falls through to the same ECMAScript `Number::toString` rendering
/// ([`number_to_js_string`]) as the JSON encoders' finite-number branch.
pub fn canonical_number(value: f64) -> String {
    if value.is_nan() {
        "NaN".to_string()
    } else if value == 0.0 && value.is_sign_negative() {
        // `Object.is(value, -0)` — never plain `value === -0`, which is
        // `true` for both signs of zero under IEEE 754 equality.
        "0".to_string()
    } else if value == f64::INFINITY {
        "+Infinity".to_string()
    } else if value == f64::NEG_INFINITY {
        "-Infinity".to_string()
    } else {
        number_to_js_string(value)
    }
}

/// Port of `canonicalRecord`
/// (`src/workers/algorithm/irregular/irregularBeamState.ts:829-838`):
/// concatenates (no separator — each field's own two [`canonical_token`]
/// calls already carry an explicit length prefix, so no external delimiter
/// is needed for the format to be self-delimiting) `canonicalToken(name) +
/// canonicalToken(value)` for every two-element `[name, value]` row.
///
/// Reproduces the TS function's own defensive-but-otherwise-unreachable
/// `field[0]`/`field[1]` `undefined` guard verbatim (ruling R3 "faithful
/// port of reachable-but-odd code"): a row with fewer than two elements
/// contributes an **empty string** to the output rather than panicking or
/// being skipped from the join with a comma — the real TS
/// `.map(...).join('')` idiom already means "no separator," so an empty
/// contribution here is textually indistinguishable from "no row at all."
/// Every real caller (`canonicalCollisionPolygonKey`, `canonicalRingKey`,
/// `canonicalEntryListKey` below) only ever constructs genuine two-element
/// rows; this guard is currently unreachable from production call sites,
/// exactly like the TS original.
///
/// Rewritten (2026-07-30, migration prompt §21 optimization discipline) to
/// write directly into one accumulating buffer via [`write_canonical_token`]
/// instead of `map`-ping each row to its own freshly `format!`-allocated
/// `String` and `collect`ing + `join`ing them: byte-for-byte identical
/// output for every input (each row still contributes exactly
/// `canonicalToken(name) + canonicalToken(value)`, or nothing for a
/// malformed row, in the same left-to-right order), at roughly a third of
/// the allocation count for an `N`-row call (one `buf` growth instead of `N`
/// per-row `String`s plus the `Vec`/`join` collector).
pub fn canonical_record(fields: &[Vec<String>]) -> String {
    let mut buf = String::new();
    for field in fields {
        if let (Some(name), Some(value)) = (field.first(), field.get(1)) {
            write_canonical_token(&mut buf, name);
            write_canonical_token(&mut buf, value);
        }
    }
    buf
}

/// Port of `canonicalEntryListKey`
/// (`src/workers/algorithm/irregular/irregularBeamState.ts:859-864`).
/// `entryKeys.length` is a plain JS array element count (not a UTF-16
/// code-unit count — contrast [`canonical_token`]'s own `value.length`),
/// rendered through [`canonical_number`] like every other numeric field in
/// this record format.
///
/// Rewritten (2026-07-30, migration prompt §21 optimization discipline) to
/// write directly into one pre-reserved buffer instead of building a
/// `Vec<Vec<String>>` of owned rows (which, for the `entry-{index}` rows,
/// previously `clone()`d every element of `entry_keys` — often long strings,
/// since each is itself a full [`canonical_record`]-shaped polygon key) and
/// handing it to [`canonical_record`]. Byte-for-byte identical output: the
/// same five-and-`N` fields (`version`, `entry-count`, then one
/// `entry-{index}` row per `entry_keys` element), in the same order, each
/// still exactly `canonicalToken(name) + canonicalToken(value)`.
pub fn canonical_entry_list_key(entry_keys: &[String]) -> String {
    let mut buf = String::with_capacity(
        96 + entry_keys
            .iter()
            .map(|entry_key| entry_key.len() + 24)
            .sum::<usize>(),
    );
    write_canonical_token(&mut buf, "version");
    write_canonical_token(&mut buf, "irregular-occupied-geometry-v2");
    write_canonical_token(&mut buf, "entry-count");
    let entry_count = canonical_number(entry_keys.len() as f64);
    write_canonical_token(&mut buf, &entry_count);
    for (index, entry_key) in entry_keys.iter().enumerate() {
        write_indexed_canonical_token(&mut buf, "entry-", index);
        write_canonical_token(&mut buf, entry_key);
    }
    buf
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capacity_encoder_sorts_keys_ordinally_and_quotes_bigint() {
        let value = JsValue::Obj(vec![
            ("b".to_string(), JsValue::Num(1.0)),
            ("a".to_string(), JsValue::BigInt(BigInt::from(5))),
        ]);
        assert_eq!(
            intrinsic_capacity_canonical_json(&value).unwrap(),
            r#"{"a":"5","b":1}"#
        );
    }

    #[test]
    fn capacity_encoder_omits_undefined_fields() {
        let value = JsValue::Obj(vec![
            ("a".to_string(), JsValue::Undefined),
            ("b".to_string(), JsValue::Num(2.0)),
        ]);
        assert_eq!(
            intrinsic_capacity_canonical_json(&value).unwrap(),
            r#"{"b":2}"#
        );
    }

    #[test]
    fn capacity_encoder_array_join_of_undefined_matches_js_quirk() {
        let value = JsValue::Arr(vec![
            JsValue::Num(1.0),
            JsValue::Undefined,
            JsValue::Num(3.0),
        ]);
        assert_eq!(intrinsic_capacity_canonical_json(&value).unwrap(), "[1,,3]");
    }

    #[test]
    fn strict_encoder_uses_locale_compare_for_keys() {
        // Ordinal: 'B' (0x42) < 'a' (0x61). Locale: 'a' < 'B'.
        let value = JsValue::Obj(vec![
            ("B".to_string(), JsValue::Num(1.0)),
            ("a".to_string(), JsValue::Num(2.0)),
        ]);
        assert_eq!(
            intrinsic_strict_canonical_json(&value).unwrap(),
            r#"{"a":2,"B":1}"#
        );
        assert_eq!(
            intrinsic_capacity_canonical_json(&value).unwrap(),
            r#"{"B":1,"a":2}"#
        );
    }

    #[test]
    fn strict_encoder_sorts_map_entries_by_locale_compared_string_key() {
        let value = JsValue::Map(vec![
            (JsValue::Str("B".to_string()), JsValue::Num(1.0)),
            (JsValue::Str("a".to_string()), JsValue::Num(2.0)),
        ]);
        assert_eq!(
            intrinsic_strict_canonical_json(&value).unwrap(),
            r#"[["a",2],["B",1]]"#
        );
    }

    #[test]
    fn periodic_encoder_has_no_bigint_branch() {
        let result = std::panic::catch_unwind(|| {
            intrinsic_periodic_canonical_json(&JsValue::BigInt(BigInt::from(1)))
        });
        assert!(result.is_err());
    }

    #[test]
    fn number_tokens_diverge_between_json_and_canonical_number() {
        assert_eq!(json_number_token(f64::NAN), "null");
        assert_eq!(json_number_token(f64::INFINITY), "null");
        assert_eq!(json_number_token(-0.0), "0");
        assert_eq!(canonical_number(f64::NAN), "NaN");
        assert_eq!(canonical_number(f64::INFINITY), "+Infinity");
        assert_eq!(canonical_number(f64::NEG_INFINITY), "-Infinity");
        assert_eq!(canonical_number(-0.0), "0");
    }

    #[test]
    fn canonical_token_counts_utf16_code_units_not_bytes() {
        // U+1F600 is one Rust `char` but two UTF-16 code units and four UTF-8 bytes.
        assert_eq!(canonical_token("\u{1f600}"), "2:\u{1f600}");
    }

    #[test]
    fn canonical_entry_list_key_matches_expected_record_shape() {
        let key = canonical_entry_list_key(&["k0".to_string(), "k1".to_string()]);
        let expected = format!(
            "{}{}{}{}{}{}{}{}",
            canonical_token("version"),
            canonical_token("irregular-occupied-geometry-v2"),
            canonical_token("entry-count"),
            canonical_token("2"),
            canonical_token("entry-0"),
            canonical_token("k0"),
            canonical_token("entry-1"),
            canonical_token("k1"),
        );
        assert_eq!(key, expected);
    }

    #[test]
    fn canonical_record_reproduces_undefined_row_guard() {
        let fields = vec![vec!["only-name".to_string()]];
        assert_eq!(canonical_record(&fields), "");
    }

    #[test]
    fn locale_compare_keys_matches_documented_divergence_example() {
        assert_eq!(locale_compare_keys("a", "B"), Ordering::Less);
        assert_eq!(cmp_js_code_units("a", "B"), Ordering::Greater);
    }
}
