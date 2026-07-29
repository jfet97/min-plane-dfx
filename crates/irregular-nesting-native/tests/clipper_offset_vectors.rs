//! Differential-vector parity test for
//! `crates/irregular-nesting-native/src/clipper/offset.rs`'s full
//! `ClipperOffset::execute` (== `Clipper.inflatePaths`) surface, per ruling R10 in
//! `docs/planning/rust-irregular-backend/stage0-rulings.md`.
//!
//! Loads `tests/vectors/clipper-offset-pending.json` (generated from the REAL
//! `clipper2-ts` npm package by `scripts/rust-parity/dump-clipper-core.ts`,
//! before the boolean-clip engine existed — see that file's `meta.description`).
//! These vectors require the `Clipper64` boolean-clip engine's
//! self-intersection union cleanup (`executeInternal`, Offset.ts:192-203),
//! which `offset::ClipperOffset::execute` now wires to the real
//! `crates/irregular-nesting-native/src/clipper/engine.rs` port (see that
//! method's doc comment); this test activates the previously-pending vectors
//! now that the engine exists, asserting byte-exact vertex sequences
//! (including ring order and starting vertex) for every recorded case.

use std::fs;

use irregular_nesting_native::clipper::core::Point64;
use irregular_nesting_native::clipper::offset::{ClipperOffset, EndType, JoinType};
use serde_json::Value;

fn load(path_suffix: &str) -> Value {
    let path = format!(
        "{}/tests/vectors/{}",
        env!("CARGO_MANIFEST_DIR"),
        path_suffix
    );
    let raw =
        fs::read_to_string(&path).unwrap_or_else(|err| panic!("failed to read {path}: {err}"));
    serde_json::from_str(&raw).unwrap_or_else(|err| panic!("failed to parse {path}: {err}"))
}

// ---------------------------------------------------------------------------
// Decoders mirroring `scripts/rust-parity/dump-clipper-core.ts`'s encoders.
// ---------------------------------------------------------------------------

fn decode_f64(value: &Value) -> f64 {
    match value {
        Value::Number(number) => number
            .as_f64()
            .unwrap_or_else(|| panic!("JSON number {number} is not representable as f64")),
        Value::String(tag) => match tag.as_str() {
            "0" => 0.0,
            "-0" => -0.0,
            "NaN" => f64::NAN,
            "Infinity" => f64::INFINITY,
            "-Infinity" => f64::NEG_INFINITY,
            other => other
                .parse::<f64>()
                .unwrap_or_else(|_| panic!("unrecognized encoded f64 tag: {other}")),
        },
        other => panic!("expected a JSON number or tagged string for an f64 field, got {other:?}"),
    }
}

fn assert_f64_bit_exact(actual: f64, expected: f64, context: &str) {
    if actual.is_nan() && expected.is_nan() {
        return;
    }
    assert_eq!(
        actual.to_bits(),
        expected.to_bits(),
        "{context}: expected {expected:?} (bits {:016x}), got {actual:?} (bits {:016x})",
        expected.to_bits(),
        actual.to_bits(),
    );
}

fn decode_point(value: &Value) -> Point64 {
    Point64::new(
        decode_f64(&value["x"]),
        decode_f64(&value["y"]),
        decode_f64(&value["z"]),
    )
}

fn assert_point_eq(actual: Point64, expected: Point64, context: &str) {
    assert_f64_bit_exact(actual.x, expected.x, &format!("{context}.x"));
    assert_f64_bit_exact(actual.y, expected.y, &format!("{context}.y"));
    assert_f64_bit_exact(actual.z, expected.z, &format!("{context}.z"));
}

fn decode_path(value: &Value) -> Vec<Point64> {
    value
        .as_array()
        .unwrap_or_else(|| panic!("expected array, got {value:?}"))
        .iter()
        .map(decode_point)
        .collect()
}

fn decode_paths(value: &Value) -> Vec<Vec<Point64>> {
    value
        .as_array()
        .unwrap_or_else(|| panic!("expected array, got {value:?}"))
        .iter()
        .map(decode_path)
        .collect()
}

fn assert_paths_eq(actual: &[Vec<Point64>], expected: &[Vec<Point64>], context: &str) {
    assert_eq!(
        actual.len(),
        expected.len(),
        "{context}: ring count mismatch (actual={actual:?}, expected={expected:?})"
    );
    for (i, (a_path, e_path)) in actual.iter().zip(expected.iter()).enumerate() {
        assert_eq!(
            a_path.len(),
            e_path.len(),
            "{context}[{i}]: vertex count mismatch"
        );
        for (j, (a_pt, e_pt)) in a_path.iter().zip(e_path.iter()).enumerate() {
            assert_point_eq(*a_pt, *e_pt, &format!("{context}[{i}][{j}]"));
        }
    }
}

fn join_type_from_name(name: &str) -> JoinType {
    match name {
        "Miter" => JoinType::Miter,
        "Square" => JoinType::Square,
        "Bevel" => JoinType::Bevel,
        "Round" => JoinType::Round,
        other => panic!("unknown JoinType: {other}"),
    }
}

fn end_type_from_name(name: &str) -> EndType {
    match name {
        "Polygon" => EndType::Polygon,
        "Joined" => EndType::Joined,
        "Butt" => EndType::Butt,
        "Square" => EndType::Square,
        "Round" => EndType::Round,
        other => panic!("unknown EndType: {other}"),
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[test]
fn vector_file_header_records_generating_commit_and_expected_vector_count() {
    let doc = load("clipper-offset-pending.json");
    assert_eq!(doc["meta"]["area"], "clipper-offset-pending");
    assert!(
        doc["meta"]["generatingCommit"]
            .as_str()
            .unwrap_or_default()
            .len()
            >= 7
    );
    let vectors = doc["vectors"].as_array().unwrap();
    assert_eq!(
        vectors.len(),
        33,
        "expected exactly the 33 pinned pending ClipperOffset::execute vectors, got {}",
        vectors.len()
    );
}

#[test]
fn execute_matches_oracle_vertex_for_vertex_for_every_pending_vector() {
    let doc = load("clipper-offset-pending.json");
    let vectors = doc["vectors"].as_array().unwrap();
    for v in vectors {
        let name = v["name"].as_str().unwrap_or("?");
        let paths = decode_paths(&v["paths"]);
        let join_type = join_type_from_name(v["joinType"].as_str().unwrap());
        let end_type = end_type_from_name(v["endType"].as_str().unwrap());
        let miter_limit = decode_f64(&v["miterLimit"]);
        let delta = decode_f64(&v["delta"]);
        let expected = decode_paths(&v["expected"]);

        let mut co = ClipperOffset::new(miter_limit, 0.0, false, false);
        co.add_paths(&paths, join_type, end_type);
        let actual = co
            .execute(delta)
            .unwrap_or_else(|err| panic!("{name} (delta={delta}): execute failed: {err:?}"));
        assert_paths_eq(&actual, &expected, &format!("{name} (delta={delta})"));
    }
}
