//! Plain `JSON.stringify` byte-measurement infrastructure private to the
//! Short Side cluster.
//!
//! Every trace type in this cluster
//! (`IntrinsicShortSideObserverTrace`, `IntrinsicShortSidePairFoldTrace`,
//! `IntrinsicShortSideContactStripTrace`, and their nested payloads) is a
//! plain object literal whose `serializedTraceBytes` field is computed by a
//! **two-pass, literal `JSON.stringify`** self-measurement (TS:
//! `withMeasuredIntrinsicShortSideObserverTrace`,
//! `withMeasuredIntrinsicShortSidePairFoldTrace`; see
//! `docs/planning/rust-irregular-backend/characterization/short-side.md` §8.1
//! for the exact two-pass, not-fixpoint-iterated contract this module must
//! preserve).
//!
//! # Why this is not a duplicate of `checkpoints::canonical_json`
//!
//! `checkpoints::canonical_json`'s three JSON-shaped encoders
//! (`intrinsic_capacity_canonical_json`, `intrinsic_strict_canonical_json`,
//! `intrinsic_periodic_canonical_json`) each **re-sort** object keys and/or
//! `Map` entries as part of building a canonical hash preimage -- that is
//! their entire purpose. Literal `JSON.stringify` byte-length measurement
//! must instead preserve **insertion order** exactly as each trace object
//! literal declares its fields (`short-side.md` §8.3), never sort anything.
//! Reusing those encoders here would silently change every measured byte
//! count. This module is therefore a separate, small, insertion-order-only
//! JSON value plus byte-length measurer, scoped to this cluster.
//!
//! The low-level string-escape (`json_string_literal`) and number-format
//! (`json_number_literal`) primitives below are a small, intentional local
//! reproduction of the same ECMA-262 `QuoteJSONString`/number-branch
//! algorithm `checkpoints::canonical_json`'s own (private, not `pub`, so not
//! importable from here without editing that module) `json_string_literal`
//! implements -- the same "small local duplication of a byte-exact adapter"
//! pattern already established elsewhere in this crate (see
//! `search::strict_decoder`'s and `capacity::search`'s independently
//! duplicated `transform_collision_geometry` wrapper, both documented as
//! intentional, not a GREEN-module violation).

use crate::js_number::number_to_js_string;

/// A JS value as consumed by this cluster's three trace-object literals.
///
/// `Obj` fields preserve **insertion order** in a `Vec` (never sorted) --
/// see this module's top doc. `Undefined` is JS `undefined`, distinct from
/// `Null`: an object field holding `Undefined` is dropped from the encoded
/// object entirely (`JSON.stringify` omits `undefined`-valued object
/// properties), while an array element holding `Undefined` renders as the
/// literal `null` token (`JSON.stringify([1, undefined, 3]) ===
/// "[1,null,3]"`, confirmed against Node v24) -- this cluster's traces never
/// actually place `Undefined` inside an array (every `comparisonTuple`/etc.
/// array is built with an explicit `?? sentinel` fallback, `short-side.md`
/// §6.2/§6.3), but this type still reproduces the real rule rather than
/// asserting it can't happen.
#[derive(Clone, Debug, PartialEq)]
pub enum ShortSideJsonValue {
    Undefined,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<ShortSideJsonValue>),
    Obj(Vec<(&'static str, ShortSideJsonValue)>),
}

impl ShortSideJsonValue {
    /// Convenience constructor for the common `Str(value.into())` case.
    pub fn str(value: impl Into<String>) -> ShortSideJsonValue {
        ShortSideJsonValue::Str(value.into())
    }

    /// `Option<&str>` -> `Str(..)` or `Undefined` (TS: `value ?? undefined`
    /// field pattern used throughout this cluster's `| undefined` trace
    /// fields).
    pub fn opt_str(value: Option<&str>) -> ShortSideJsonValue {
        match value {
            Some(value) => ShortSideJsonValue::Str(value.to_string()),
            None => ShortSideJsonValue::Undefined,
        }
    }

    /// `Option<f64>` -> `Num(..)` or `Undefined`.
    pub fn opt_num(value: Option<f64>) -> ShortSideJsonValue {
        match value {
            Some(value) => ShortSideJsonValue::Num(value),
            None => ShortSideJsonValue::Undefined,
        }
    }
}

/// `JSON.stringify(value)` string-literal quoting -- the ECMA-262
/// `QuoteJSONString` algorithm. See this module's top doc for why this is a
/// small, intentional local copy of `checkpoints::canonical_json`'s private
/// function of the same behavior.
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

/// `JSON.stringify(value)` for a `number` -- non-finite values collapse to
/// the bare token `null` (`JSON.stringify(NaN) === "null"`); every finite
/// value renders via [`number_to_js_string`], the same `Number::toString`
/// algorithm `JSON.stringify`'s number branch uses.
fn json_number_literal(value: f64) -> String {
    if value.is_finite() {
        number_to_js_string(value)
    } else {
        "null".to_string()
    }
}

/// Appends `JSON.stringify(value)` to `out`. Returns `false` iff `value` is
/// `Undefined` at this exact call site (the one case `JSON.stringify` itself
/// returns `undefined`, i.e. "no token emitted here") -- the two callers
/// below (object-field and array-element encoding) each apply the correct
/// `JSON.stringify` rule for that case (omit the field / substitute `null`).
fn write_json(out: &mut String, value: &ShortSideJsonValue) -> bool {
    match value {
        ShortSideJsonValue::Undefined => false,
        ShortSideJsonValue::Bool(b) => {
            out.push_str(if *b { "true" } else { "false" });
            true
        }
        ShortSideJsonValue::Num(n) => {
            out.push_str(&json_number_literal(*n));
            true
        }
        ShortSideJsonValue::Str(s) => {
            out.push_str(&json_string_literal(s));
            true
        }
        ShortSideJsonValue::Arr(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                // TS: `JSON.stringify` renders an `undefined`-valued array
                // element as the literal `null` token, never an empty slot
                // (that "empty join segment" behavior belongs only to this
                // cluster's own custom `canonicalJson`/`join(',')` family in
                // `checkpoints::canonical_json`, not native `JSON.stringify`).
                if !write_json(out, item) {
                    out.push_str("null");
                }
            }
            out.push(']');
            true
        }
        ShortSideJsonValue::Obj(fields) => {
            out.push('{');
            let mut wrote_any = false;
            for (key, field_value) in fields {
                if matches!(field_value, ShortSideJsonValue::Undefined) {
                    continue;
                }
                if wrote_any {
                    out.push(',');
                }
                out.push_str(&json_string_literal(key));
                out.push(':');
                let wrote = write_json(out, field_value);
                debug_assert!(wrote, "non-Undefined field must always write a token");
                wrote_any = true;
            }
            out.push('}');
            true
        }
    }
}

/// `JSON.stringify(value)`, the top-level entry point. Top-level `Undefined`
/// (which native `JSON.stringify` renders as the JS value `undefined`, not a
/// string) never occurs at this cluster's call sites (every trace is always
/// an `Obj`), so this function always returns a real string.
pub fn stringify(value: &ShortSideJsonValue) -> String {
    let mut out = String::new();
    write_json(&mut out, value);
    out
}

/// `Buffer.byteLength(JSON.stringify(value), 'utf8')` -- the exact
/// self-measurement primitive [`super::observer::with_measured_trace`] and
/// this cluster's pair-fold/contact-strip trace measurers call twice
/// (two-pass, not fixpoint-iterated; see this module's top doc).
pub fn byte_length(value: &ShortSideJsonValue) -> usize {
    stringify(value).len()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn object_omits_undefined_valued_fields() {
        let value = ShortSideJsonValue::Obj(vec![
            ("a", ShortSideJsonValue::Num(1.0)),
            ("b", ShortSideJsonValue::Undefined),
            ("c", ShortSideJsonValue::str("x")),
        ]);
        assert_eq!(stringify(&value), r#"{"a":1,"c":"x"}"#);
    }

    #[test]
    fn array_renders_undefined_element_as_null() {
        let value = ShortSideJsonValue::Arr(vec![
            ShortSideJsonValue::Num(1.0),
            ShortSideJsonValue::Undefined,
            ShortSideJsonValue::Num(3.0),
        ]);
        assert_eq!(stringify(&value), "[1,null,3]");
    }

    #[test]
    fn non_finite_numbers_render_as_null() {
        assert_eq!(stringify(&ShortSideJsonValue::Num(f64::NAN)), "null");
        assert_eq!(stringify(&ShortSideJsonValue::Num(f64::INFINITY)), "null");
        assert_eq!(
            stringify(&ShortSideJsonValue::Num(f64::NEG_INFINITY)),
            "null"
        );
    }

    #[test]
    fn strings_escape_control_characters_and_quotes() {
        assert_eq!(
            stringify(&ShortSideJsonValue::str("a\"b\\c\nd")),
            r#""a\"b\\c\nd""#
        );
    }

    #[test]
    fn byte_length_counts_utf8_bytes_not_chars() {
        // "café" is 4 chars, 5 UTF-8 bytes; JSON-quoted adds 2 bytes.
        let value = ShortSideJsonValue::str("café");
        assert_eq!(byte_length(&value), 7);
    }

    #[test]
    fn opt_helpers_map_none_to_undefined() {
        assert_eq!(
            ShortSideJsonValue::opt_str(None),
            ShortSideJsonValue::Undefined
        );
        assert_eq!(
            ShortSideJsonValue::opt_num(None),
            ShortSideJsonValue::Undefined
        );
        assert_eq!(
            ShortSideJsonValue::opt_str(Some("x")),
            ShortSideJsonValue::str("x")
        );
        assert_eq!(
            ShortSideJsonValue::opt_num(Some(2.0)),
            ShortSideJsonValue::Num(2.0)
        );
    }
}
