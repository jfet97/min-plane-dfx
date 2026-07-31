//! Differential-vector parity test for
//! `crates/irregular-nesting-native/src/clipper/engine.rs` (the vendor-translated
//! `clipper2-ts@2.0.1-18` boolean-clip engine port — `Engine.ts`'s
//! `Clipper64`/`PolyTree64`, plus the `Clipper.ts` wrapper surface
//! `booleanOp`/`booleanOpWithPolyTree`/`polyTreeToPaths64` — per ruling R10 in
//! `docs/planning/rust-irregular-backend/stage0-rulings.md`).
//!
//! Loads `tests/vectors/clipper-engine.json` (generated from the REAL
//! `clipper2-ts` npm package by `scripts/rust-parity/dump-clipper-engine.ts`)
//! and asserts the Rust port reproduces every recorded output exactly:
//! vertex-for-vertex equal `Paths64` (including ring order and starting
//! vertex, bit-exact `f64` coordinates via `to_bits()`), and an exactly
//! matching `PolyTree64` structure (polygon per node, child count and order,
//! recursively) for both `booleanOp` and `booleanOpWithPolyTree`, plus an
//! exactly matching `polyTreeToPaths64` flattening of that same tree.

use std::fs;

use irregular_nesting_native::clipper::core::{ClipType, FillRule, Point64};
use irregular_nesting_native::clipper::engine::{
    self, boolean_op, boolean_op_with_poly_tree, poly_tree_to_paths64, PolyTree64,
};
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
// Decoders mirroring `scripts/rust-parity/dump-clipper-engine.ts`'s encoders.
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

fn assert_path_eq(actual: &[Point64], expected: &[Point64], context: &str) {
    assert_eq!(
        actual.len(),
        expected.len(),
        "{context}: vertex count mismatch (actual={actual:?}, expected={expected:?})"
    );
    for (j, (a_pt, e_pt)) in actual.iter().zip(expected.iter()).enumerate() {
        assert_point_eq(*a_pt, *e_pt, &format!("{context}[{j}]"));
    }
}

fn assert_paths_eq(actual: &[Vec<Point64>], expected: &[Vec<Point64>], context: &str) {
    assert_eq!(
        actual.len(),
        expected.len(),
        "{context}: ring count mismatch (actual={actual:?}, expected={expected:?})"
    );
    for (i, (a_path, e_path)) in actual.iter().zip(expected.iter()).enumerate() {
        assert_path_eq(a_path, e_path, &format!("{context}[{i}]"));
    }
}

fn clip_type_from_name(name: &str) -> ClipType {
    match name {
        "NoClip" => ClipType::NoClip,
        "Intersection" => ClipType::Intersection,
        "Union" => ClipType::Union,
        "Difference" => ClipType::Difference,
        "Xor" => ClipType::Xor,
        other => panic!("unknown ClipType: {other}"),
    }
}

fn fill_rule_from_name(name: &str) -> FillRule {
    match name {
        "EvenOdd" => FillRule::EvenOdd,
        "NonZero" => FillRule::NonZero,
        "Positive" => FillRule::Positive,
        "Negative" => FillRule::Negative,
        other => panic!("unknown FillRule: {other}"),
    }
}

/// Recursively asserts one `PolyTree64` node (identified by `node_id` in `tree`)
/// matches the JSON-encoded `EncodedPolyTreeNode` at `expected`: same polygon
/// presence/vertices (vertex-for-vertex, including ring order and starting
/// vertex) and same child count and order (recursively).
fn assert_poly_tree_node_eq(tree: &PolyTree64, node_id: usize, expected: &Value, context: &str) {
    let actual_poly = tree.poly(node_id);
    let expected_poly = &expected["polygon"];
    match (actual_poly, expected_poly) {
        (None, Value::Null) => {}
        (Some(actual), Value::Array(_)) => {
            let expected_path = decode_path(expected_poly);
            assert_path_eq(actual, &expected_path, &format!("{context}.polygon"));
        }
        (actual, expected) => panic!(
            "{context}.polygon: presence mismatch (actual present={}, expected={expected:?})",
            actual.is_some()
        ),
    }

    let expected_children = expected["children"]
        .as_array()
        .unwrap_or_else(|| panic!("{context}.children: expected array, got {expected:?}"));
    assert_eq!(
        tree.count(node_id),
        expected_children.len(),
        "{context}: child count mismatch"
    );
    for (i, expected_child) in expected_children.iter().enumerate() {
        let child_id = tree.child(node_id, i);
        assert_poly_tree_node_eq(
            tree,
            child_id,
            expected_child,
            &format!("{context}.children[{i}]"),
        );
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[test]
fn vector_file_header_records_generating_commit_and_meaningful_coverage() {
    let doc = load("clipper-engine.json");
    assert_eq!(doc["meta"]["area"], "clipper-engine");
    assert!(
        doc["meta"]["generatingCommit"]
            .as_str()
            .unwrap_or_default()
            .len()
            >= 7
    );
    let vectors = doc["vectors"].as_array().unwrap();
    assert!(
        vectors.len() >= 300,
        "expected at least 300 clipper-engine vectors per the assigned coverage matrix, got {}",
        vectors.len()
    );
}

#[test]
fn boolean_op_matches_oracle_vertex_for_vertex() {
    let doc = load("clipper-engine.json");
    for v in doc["vectors"].as_array().unwrap() {
        let name = v["name"].as_str().unwrap_or("?");
        let clip_type = clip_type_from_name(v["clipType"].as_str().unwrap());
        let fill_rule = fill_rule_from_name(v["fillRule"].as_str().unwrap());
        let subject = decode_paths(&v["subject"]);
        let clip = match &v["clip"] {
            Value::Null => None,
            other => Some(decode_paths(other)),
        };
        let expected = decode_paths(&v["booleanOpExpected"]);

        let actual = boolean_op(clip_type, Some(&subject), clip.as_ref(), fill_rule);
        assert_paths_eq(
            &actual,
            &expected,
            &format!("{name} ({:?}/{:?}) booleanOp", clip_type, fill_rule),
        );
    }
}

#[test]
fn boolean_op_with_poly_tree_matches_oracle_structure() {
    let doc = load("clipper-engine.json");
    for v in doc["vectors"].as_array().unwrap() {
        let name = v["name"].as_str().unwrap_or("?");
        let clip_type = clip_type_from_name(v["clipType"].as_str().unwrap());
        let fill_rule = fill_rule_from_name(v["fillRule"].as_str().unwrap());
        let subject = decode_paths(&v["subject"]);
        let clip = match &v["clip"] {
            Value::Null => None,
            other => Some(decode_paths(other)),
        };

        let mut tree = PolyTree64::new();
        boolean_op_with_poly_tree(
            clip_type,
            Some(&subject),
            clip.as_ref(),
            &mut tree,
            fill_rule,
        );
        assert_poly_tree_node_eq(
            &tree,
            PolyTree64::ROOT,
            &v["polyTreeExpected"],
            &format!("{name} ({:?}/{:?}) polyTree", clip_type, fill_rule),
        );

        let flattened = poly_tree_to_paths64(&tree);
        let expected_flattened = decode_paths(&v["polyTreeToPathsExpected"]);
        assert_paths_eq(
            &flattened,
            &expected_flattened,
            &format!("{name} ({:?}/{:?}) polyTreeToPaths64", clip_type, fill_rule),
        );
    }
}

#[test]
fn engine_module_path64_alias_matches_core() {
    // Sanity check that `engine::Path64`/`engine::Paths64` are the same types as
    // `core::Path64`/`core::Paths64` (see `engine.rs`'s module doc), so the decoders
    // above (which build plain `Vec<Point64>`/`Vec<Vec<Point64>>`) are valid inputs
    // to `boolean_op`/`boolean_op_with_poly_tree` without any conversion.
    let subject: engine::Paths64 = vec![vec![
        Point64::new(0.0, 0.0, 0.0),
        Point64::new(10.0, 0.0, 0.0),
        Point64::new(10.0, 10.0, 0.0),
        Point64::new(0.0, 10.0, 0.0),
    ]];
    let result = boolean_op(ClipType::Union, Some(&subject), None, FillRule::NonZero);
    assert_eq!(result.len(), 1);
}
