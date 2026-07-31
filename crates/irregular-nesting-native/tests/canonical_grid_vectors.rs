//! Differential vector test for `crates/irregular-nesting-native/src/canonical_grid`.
//!
//! Loads `tests/vectors/canonical-grid.json` (generated from the real
//! production TypeScript functions by
//! `scripts/rust-parity/dump-canonical-grid.ts`, per
//! `docs/planning/rust-irregular-backend/stage0-rulings.md` R14) and asserts
//! the Rust port reproduces every recorded output exactly: bit-exact `f64`
//! (compared via `to_bits()`, so `-0.0`/`+0.0` and any two differently
//! payloaded `NaN`s are distinguished exactly as the oracle recorded them),
//! exact `BigInt`, and exact integer/boolean results.

use std::fs;

use irregular_nesting_native::canonical_grid::{
    canonical_grid_absolute_doubled_area, canonical_grid_clockwise, canonical_grid_compare_bigints,
    canonical_grid_compare_ratios, canonical_grid_convex_hull, canonical_grid_counter_clockwise,
    canonical_grid_cross, canonical_grid_cross_sign, canonical_grid_point_on_segment,
    canonical_grid_signed_doubled_area, doubled_grid_area_to_mm2, from_grid, to_grid_mm,
    CanonicalGridPoint,
};
use num_bigint::BigInt;
use serde_json::Value;

fn load_vectors() -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/vectors/canonical-grid.json"
    );
    let raw = fs::read_to_string(path).unwrap_or_else(|err| panic!("failed to read {path}: {err}"));
    serde_json::from_str(&raw).unwrap_or_else(|err| panic!("failed to parse {path}: {err}"))
}

// ---------------------------------------------------------------------------
// Decoders mirroring `scripts/rust-parity/dump-canonical-grid.ts`'s encoders.
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

fn decode_optional_f64(value: &Value) -> Option<f64> {
    if value.is_null() {
        None
    } else {
        Some(decode_f64(value))
    }
}

fn decode_point(value: &Value) -> CanonicalGridPoint {
    CanonicalGridPoint::new(decode_f64(&value["x"]), decode_f64(&value["y"]))
}

fn decode_path(value: &Value) -> Vec<CanonicalGridPoint> {
    value
        .as_array()
        .unwrap_or_else(|| panic!("expected a JSON array of points, got {value:?}"))
        .iter()
        .map(decode_point)
        .collect()
}

fn decode_optional_path(value: &Value) -> Option<Vec<CanonicalGridPoint>> {
    if value.is_null() {
        None
    } else {
        Some(decode_path(value))
    }
}

fn decode_bigint(value: &Value) -> BigInt {
    let text = value
        .as_str()
        .unwrap_or_else(|| panic!("expected a quoted base-10 BigInt string, got {value:?}"));
    text.parse::<BigInt>()
        .unwrap_or_else(|err| panic!("invalid BigInt string {text:?}: {err}"))
}

fn decode_optional_bigint(value: &Value) -> Option<BigInt> {
    if value.is_null() {
        None
    } else {
        Some(decode_bigint(value))
    }
}

fn decode_optional_i32(value: &Value) -> Option<i32> {
    if value.is_null() {
        None
    } else {
        Some(
            value
                .as_i64()
                .unwrap_or_else(|| panic!("expected an integer, got {value:?}")) as i32,
        )
    }
}

// ---------------------------------------------------------------------------
// Bit-exact assertion helpers.
// ---------------------------------------------------------------------------

fn assert_f64_bits_eq(actual: f64, expected: f64, context: &str) {
    assert_eq!(
        actual.to_bits(),
        expected.to_bits(),
        "{context}: expected {expected:?} (bits {:#018x}), got {actual:?} (bits {:#018x})",
        expected.to_bits(),
        actual.to_bits()
    );
}

fn assert_optional_f64_bits_eq(actual: Option<f64>, expected: Option<f64>, context: &str) {
    match (actual, expected) {
        (Some(actual_value), Some(expected_value)) => {
            assert_f64_bits_eq(actual_value, expected_value, context);
        }
        (None, None) => {}
        _ => panic!("{context}: expected {expected:?}, got {actual:?}"),
    }
}

fn assert_path_bits_eq(
    actual: &[CanonicalGridPoint],
    expected: &[CanonicalGridPoint],
    context: &str,
) {
    assert_eq!(
        actual.len(),
        expected.len(),
        "{context}: path length mismatch (expected {}, got {})",
        expected.len(),
        actual.len()
    );
    for (index, (actual_point, expected_point)) in actual.iter().zip(expected.iter()).enumerate() {
        assert_f64_bits_eq(
            actual_point.x,
            expected_point.x,
            &format!("{context} point[{index}].x"),
        );
        assert_f64_bits_eq(
            actual_point.y,
            expected_point.y,
            &format!("{context} point[{index}].y"),
        );
    }
}

fn assert_optional_path_bits_eq(
    actual: Option<Vec<CanonicalGridPoint>>,
    expected: Option<Vec<CanonicalGridPoint>>,
    context: &str,
) {
    match (actual, expected) {
        (Some(actual_path), Some(expected_path)) => {
            assert_path_bits_eq(&actual_path, &expected_path, context);
        }
        (None, None) => {}
        (actual, expected) => panic!("{context}: expected {expected:?}, got {actual:?}"),
    }
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

#[test]
fn cross_and_cross_sign_match_oracle() {
    let document = load_vectors();
    let vectors = document["crossVectors"]
        .as_array()
        .expect("crossVectors array");
    assert!(
        vectors.len() >= 300,
        "expected a broad cross/crossSign vector matrix"
    );
    for (index, vector) in vectors.iter().enumerate() {
        let origin = decode_point(&vector["origin"]);
        let first = decode_point(&vector["first"]);
        let second = decode_point(&vector["second"]);
        let expected_cross_sign = decode_optional_i32(&vector["crossSign"]);
        let expected_cross = decode_optional_bigint(&vector["cross"]);

        let actual_cross_sign = canonical_grid_cross_sign(origin, first, second);
        assert_eq!(
            actual_cross_sign, expected_cross_sign,
            "crossVectors[{index}] crossSign mismatch for origin={origin:?} first={first:?} second={second:?}"
        );

        let actual_cross = canonical_grid_cross(origin, first, second);
        assert_eq!(
            actual_cross, expected_cross,
            "crossVectors[{index}] cross mismatch for origin={origin:?} first={first:?} second={second:?}"
        );
    }
}

#[test]
fn compare_bigints_matches_oracle() {
    let document = load_vectors();
    let vectors = document["compareBigIntsVectors"]
        .as_array()
        .expect("compareBigIntsVectors array");
    assert!(
        vectors.len() >= 100,
        "expected a broad compareBigInts vector matrix"
    );
    for (index, vector) in vectors.iter().enumerate() {
        let first = decode_bigint(&vector["first"]);
        let second = decode_bigint(&vector["second"]);
        let expected = vector["expected"].as_i64().expect("expected is an integer") as i32;
        let actual = canonical_grid_compare_bigints(&first, &second);
        assert_eq!(
            actual, expected,
            "compareBigIntsVectors[{index}] mismatch for first={first} second={second}"
        );
    }
}

#[test]
fn compare_ratios_matches_oracle() {
    let document = load_vectors();
    let vectors = document["compareRatiosVectors"]
        .as_array()
        .expect("compareRatiosVectors array");
    assert!(
        vectors.len() >= 200,
        "expected a broad compareCanonicalGridRatios vector matrix"
    );
    for (index, vector) in vectors.iter().enumerate() {
        let first_numerator = decode_bigint(&vector["firstNumerator"]);
        let first_denominator = decode_bigint(&vector["firstDenominator"]);
        let second_numerator = decode_bigint(&vector["secondNumerator"]);
        let second_denominator = decode_bigint(&vector["secondDenominator"]);
        let expected = decode_optional_i32(&vector["expected"]);

        let actual = canonical_grid_compare_ratios(
            &first_numerator,
            &first_denominator,
            &second_numerator,
            &second_denominator,
        );
        assert_eq!(
            actual, expected,
            "compareRatiosVectors[{index}] mismatch for {first_numerator}/{first_denominator} vs {second_numerator}/{second_denominator}"
        );
    }
}

#[test]
fn area_and_winding_functions_match_oracle() {
    let document = load_vectors();
    let vectors = document["areaVectors"]
        .as_array()
        .expect("areaVectors array");
    assert!(
        vectors.len() >= 100,
        "expected a broad area/winding vector matrix"
    );
    for (index, vector) in vectors.iter().enumerate() {
        let path = decode_path(&vector["path"]);
        let expected_signed = decode_optional_bigint(&vector["signed"]);
        let expected_absolute = decode_optional_bigint(&vector["absolute"]);
        let expected_ccw = decode_optional_path(&vector["counterClockwise"]);
        let expected_cw = decode_optional_path(&vector["clockwise"]);

        let actual_signed = canonical_grid_signed_doubled_area(&path);
        assert_eq!(
            actual_signed,
            expected_signed,
            "areaVectors[{index}] signed mismatch (path len {})",
            path.len()
        );

        let actual_absolute = canonical_grid_absolute_doubled_area(&path);
        assert_eq!(
            actual_absolute,
            expected_absolute,
            "areaVectors[{index}] absolute mismatch (path len {})",
            path.len()
        );

        let actual_ccw = canonical_grid_counter_clockwise(&path);
        assert_optional_path_bits_eq(
            actual_ccw,
            expected_ccw,
            &format!("areaVectors[{index}] counterClockwise"),
        );

        let actual_cw = canonical_grid_clockwise(&path);
        assert_optional_path_bits_eq(
            actual_cw,
            expected_cw,
            &format!("areaVectors[{index}] clockwise"),
        );
    }
}

#[test]
fn convex_hull_matches_oracle() {
    let document = load_vectors();
    let vectors = document["convexHullVectors"]
        .as_array()
        .expect("convexHullVectors array");
    assert!(
        vectors.len() >= 80,
        "expected a broad convex-hull vector matrix"
    );
    for (index, vector) in vectors.iter().enumerate() {
        let points = decode_path(&vector["points"]);
        let expected_hull = decode_optional_path(&vector["hull"]);
        let actual_hull = canonical_grid_convex_hull(&points);
        assert_optional_path_bits_eq(
            actual_hull,
            expected_hull,
            &format!(
                "convexHullVectors[{index}] hull (input len {})",
                points.len()
            ),
        );
    }
}

#[test]
fn point_on_segment_matches_oracle() {
    let document = load_vectors();
    let vectors = document["pointOnSegmentVectors"]
        .as_array()
        .expect("pointOnSegmentVectors array");
    assert!(
        vectors.len() >= 100,
        "expected a broad canonicalGridPointOnSegment vector matrix (R3 faithful port)"
    );
    for (index, vector) in vectors.iter().enumerate() {
        let point = decode_point(&vector["point"]);
        let start = decode_point(&vector["start"]);
        let end = decode_point(&vector["end"]);
        let expected = vector["expected"].as_bool().expect("expected is a boolean");
        let actual = canonical_grid_point_on_segment(point, start, end);
        assert_eq!(
            actual, expected,
            "pointOnSegmentVectors[{index}] mismatch for point={point:?} start={start:?} end={end:?}"
        );
    }
}

#[test]
fn doubled_grid_area_to_mm2_matches_oracle() {
    let document = load_vectors();
    let vectors = document["doubledAreaToMm2Vectors"]
        .as_array()
        .expect("doubledAreaToMm2Vectors array");
    assert!(
        vectors.len() >= 80,
        "expected a broad doubledGridAreaToMm2 vector matrix"
    );
    let mut saw_some = false;
    let mut saw_none = false;
    for (index, vector) in vectors.iter().enumerate() {
        let doubled_area = decode_bigint(&vector["doubledAreaGrid2"]);
        let expected = decode_optional_f64(&vector["expected"]);
        if expected.is_some() {
            saw_some = true;
        } else {
            saw_none = true;
        }
        let actual = doubled_grid_area_to_mm2(&doubled_area);
        assert_optional_f64_bits_eq(
            actual,
            expected,
            &format!("doubledAreaToMm2Vectors[{index}] for doubledAreaGrid2={doubled_area}"),
        );
    }
    assert!(
        saw_some,
        "vector matrix never exercised the Some (finite) branch"
    );
    assert!(
        saw_none,
        "vector matrix never exercised the None (overflow) branch"
    );
}

#[test]
fn to_grid_mm_and_from_grid_match_oracle() {
    let document = load_vectors();
    let vectors = document["toGridMmVectors"]
        .as_array()
        .expect("toGridMmVectors array");
    assert!(
        vectors.len() >= 150,
        "expected a broad toGridMm vector matrix"
    );
    for (index, vector) in vectors.iter().enumerate() {
        let value_mm = decode_f64(&vector["valueMm"]);
        let expected = decode_optional_f64(&vector["expected"]);
        let actual = to_grid_mm(value_mm);
        assert_optional_f64_bits_eq(
            actual,
            expected,
            &format!("toGridMmVectors[{index}] for valueMm={value_mm:?}"),
        );
    }

    let special_vectors = document["toGridMmSpecialVectors"]
        .as_array()
        .expect("toGridMmSpecialVectors array");
    assert_eq!(
        special_vectors.len(),
        3,
        "expected NaN/+Infinity/-Infinity coverage for toGridMm"
    );
    for vector in special_vectors {
        let tag = vector["tag"].as_str().expect("tag is a string");
        let expected = decode_optional_f64(&vector["expected"]);
        let input = match tag {
            "nan" => f64::NAN,
            "positiveInfinity" => f64::INFINITY,
            "negativeInfinity" => f64::NEG_INFINITY,
            other => panic!("unrecognized toGridMmSpecialVectors tag: {other}"),
        };
        let actual = to_grid_mm(input);
        assert_optional_f64_bits_eq(actual, expected, &format!("toGridMmSpecialVectors[{tag}]"));
    }

    let from_grid_vectors = document["fromGridVectors"]
        .as_array()
        .expect("fromGridVectors array");
    assert!(
        from_grid_vectors.len() >= 40,
        "expected a broad fromGrid vector matrix"
    );
    for (index, vector) in from_grid_vectors.iter().enumerate() {
        let value = decode_f64(&vector["value"]);
        let expected = decode_f64(&vector["expected"]);
        let actual = from_grid(value);
        assert_f64_bits_eq(
            actual,
            expected,
            &format!("fromGridVectors[{index}] for value={value:?}"),
        );
    }
}

#[test]
fn vector_file_header_records_generating_commit() {
    let document = load_vectors();
    let header = &document["header"];
    assert!(
        header["generatingCommit"]
            .as_str()
            .is_some_and(|commit| commit.len() == 40),
        "vector file header must record a 40-character generating commit hash"
    );
    let total = document["header"]["totalVectorCount"]
        .as_u64()
        .expect("totalVectorCount is present");
    assert!(
        total >= 800,
        "expected at least 800 total vectors per the differential-vector coverage bar, got {total}"
    );
}
