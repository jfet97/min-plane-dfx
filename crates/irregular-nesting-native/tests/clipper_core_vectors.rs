//! Differential-vector parity test for `crates/irregular-nesting-native/src/clipper/`
//! (the vendor-translated `clipper2-ts@2.0.1-18` `Core.ts` + `Offset.ts` port,
//! per ruling R10 in `docs/planning/rust-irregular-backend/stage0-rulings.md`).
//!
//! Loads `tests/vectors/clipper-core.json` (generated from the REAL
//! `clipper2-ts` npm package by `scripts/rust-parity/dump-clipper-core.ts`)
//! and asserts the Rust port reproduces every recorded output exactly:
//! bit-exact `f64` (via `to_bits()`, distinguishing `-0.0`/`+0.0` and any
//! recorded `NaN`), exact `BigInt`, byte-exact strings, and exact
//! integer/boolean/enum results.
//!
//! `tests/vectors/clipper-offset-pending.json` (full `ClipperOffset.execute`
//! outputs that require the boolean-clip engine's union cleanup) is loaded by
//! a separate test file, `tests/clipper_offset_vectors.rs`, now that
//! `crates/irregular-nesting-native/src/clipper/engine.rs` exists and
//! `offset::ClipperOffset::execute` calls into it — not loaded here to keep
//! this file's scope to the engine-independent Core.ts/Offset.ts surface.

use std::fs;

use irregular_nesting_native::clipper::core::{
    self, check_cast_int64, cross_product, cross_product_sign, dot_product, dot_product_sign,
    get_bounds, get_closest_pt_on_segment, get_line_intersect_pt, is_almost_zero, is_collinear,
    multiply_uint64, path2_contains_path1, point64_utils, point_in_polygon, products_are_equal,
    rect64_utils, round_to_even, segs_intersect, tri_sign, Point64, PointD, Rect64,
};
use irregular_nesting_native::clipper::offset::{ClipperOffset, EndType, JoinType};
use num_bigint::BigInt;
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

fn decode_point_d(value: &Value) -> PointD {
    PointD::new(
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

fn assert_point_d_eq(actual: PointD, expected: PointD, context: &str) {
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
        "{context}: path count mismatch"
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

fn decode_rect(value: &Value) -> Rect64 {
    Rect64 {
        left: decode_f64(&value["left"]),
        top: decode_f64(&value["top"]),
        right: decode_f64(&value["right"]),
        bottom: decode_f64(&value["bottom"]),
    }
}

fn assert_rect_eq(actual: Rect64, expected: Rect64, context: &str) {
    assert_f64_bit_exact(actual.left, expected.left, &format!("{context}.left"));
    assert_f64_bit_exact(actual.top, expected.top, &format!("{context}.top"));
    assert_f64_bit_exact(actual.right, expected.right, &format!("{context}.right"));
    assert_f64_bit_exact(actual.bottom, expected.bottom, &format!("{context}.bottom"));
}

fn decode_bigint(value: &Value) -> BigInt {
    let text = value
        .as_str()
        .unwrap_or_else(|| panic!("expected quoted base-10 BigInt string, got {value:?}"));
    text.parse::<BigInt>()
        .unwrap_or_else(|err| panic!("invalid BigInt string {text:?}: {err}"))
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
fn vectors_file_has_meta_and_expected_generating_commit_field() {
    let doc = load("clipper-core.json");
    assert_eq!(doc["meta"]["area"], "clipper-core");
    assert!(
        doc["meta"]["generatingCommit"]
            .as_str()
            .unwrap_or_default()
            .len()
            >= 7
    );
}

#[test]
fn area_matches_oracle() {
    let doc = load("clipper-core.json");
    for v in doc["area"].as_array().unwrap() {
        let path = decode_path(&v["path"]);
        let expected = decode_f64(&v["expected"]);
        assert_f64_bit_exact(
            core::area(&path),
            expected,
            v["name"].as_str().unwrap_or("?"),
        );
    }
}

#[test]
fn is_positive_matches_oracle() {
    let doc = load("clipper-core.json");
    for v in doc["isPositive"].as_array().unwrap() {
        let path = decode_path(&v["path"]);
        let expected = v["expected"].as_bool().unwrap();
        assert_eq!(
            core::is_positive(&path),
            expected,
            "{}",
            v["name"].as_str().unwrap_or("?")
        );
    }
}

#[test]
fn cross_product_family_matches_oracle() {
    let doc = load("clipper-core.json");
    for v in doc["crossProduct"].as_array().unwrap() {
        let (p1, p2, p3) = (
            decode_point(&v["pt1"]),
            decode_point(&v["pt2"]),
            decode_point(&v["pt3"]),
        );
        assert_f64_bit_exact(
            cross_product(p1, p2, p3),
            decode_f64(&v["expected"]),
            "crossProduct",
        );
    }
    for v in doc["crossProductSign"].as_array().unwrap() {
        let (p1, p2, p3) = (
            decode_point(&v["pt1"]),
            decode_point(&v["pt2"]),
            decode_point(&v["pt3"]),
        );
        let expected = v["expected"].as_i64().unwrap() as i32;
        assert_eq!(cross_product_sign(p1, p2, p3), expected, "crossProductSign");
    }
    for v in doc["dotProduct"].as_array().unwrap() {
        let (p1, p2, p3) = (
            decode_point(&v["pt1"]),
            decode_point(&v["pt2"]),
            decode_point(&v["pt3"]),
        );
        assert_f64_bit_exact(
            dot_product(p1, p2, p3),
            decode_f64(&v["expected"]),
            "dotProduct",
        );
    }
    for v in doc["dotProductSign"].as_array().unwrap() {
        let (p1, p2, p3) = (
            decode_point(&v["pt1"]),
            decode_point(&v["pt2"]),
            decode_point(&v["pt3"]),
        );
        let expected = v["expected"].as_i64().unwrap() as i32;
        assert_eq!(dot_product_sign(p1, p2, p3), expected, "dotProductSign");
    }
    for v in doc["isCollinear"].as_array().unwrap() {
        let (p1, shared, p2) = (
            decode_point(&v["pt1"]),
            decode_point(&v["sharedPt"]),
            decode_point(&v["pt2b"]),
        );
        let expected = v["expected"].as_bool().unwrap();
        assert_eq!(is_collinear(p1, shared, p2), expected, "isCollinear");
    }
}

#[test]
fn products_are_equal_matches_oracle() {
    let doc = load("clipper-core.json");
    for v in doc["productsAreEqual"].as_array().unwrap() {
        let (a, b, c, d) = (
            decode_f64(&v["a"]),
            decode_f64(&v["b"]),
            decode_f64(&v["c"]),
            decode_f64(&v["d"]),
        );
        let expected = v["expected"].as_bool().unwrap();
        assert_eq!(
            products_are_equal(a, b, c, d),
            expected,
            "productsAreEqual({a},{b},{c},{d})"
        );
    }
}

#[test]
fn round_to_even_check_cast_tri_sign_almost_zero_match_oracle() {
    let doc = load("clipper-core.json");
    for v in doc["roundToEven"].as_array().unwrap() {
        let input = decode_f64(&v["input"]);
        assert_f64_bit_exact(
            round_to_even(input),
            decode_f64(&v["expected"]),
            "roundToEven",
        );
    }
    for v in doc["checkCastInt64"].as_array().unwrap() {
        let input = decode_f64(&v["input"]);
        assert_f64_bit_exact(
            check_cast_int64(input),
            decode_f64(&v["expected"]),
            "checkCastInt64",
        );
    }
    for v in doc["triSign"].as_array().unwrap() {
        let input = decode_f64(&v["input"]);
        let expected = v["expected"].as_i64().unwrap() as i32;
        assert_eq!(tri_sign(input), expected, "triSign({input})");
    }
    for v in doc["isAlmostZero"].as_array().unwrap() {
        let input = decode_f64(&v["input"]);
        let expected = v["expected"].as_bool().unwrap();
        assert_eq!(is_almost_zero(input), expected, "isAlmostZero({input})");
    }
}

#[test]
fn get_bounds_matches_oracle() {
    let doc = load("clipper-core.json");
    for v in doc["getBounds"].as_array().unwrap() {
        let path = decode_path(&v["path"]);
        let expected = decode_rect(&v["expected"]);
        assert_rect_eq(
            get_bounds(&path),
            expected,
            v["name"].as_str().unwrap_or("?"),
        );
    }
}

#[test]
fn rect64_utils_match_oracle() {
    let doc = load("clipper-core.json");
    for v in doc["rectScalar"].as_array().unwrap() {
        let rect = decode_rect(&v["rect"]);
        let name = v["name"].as_str().unwrap_or("?");
        assert_f64_bit_exact(
            rect64_utils::width(rect),
            decode_f64(&v["width"]),
            &format!("{name}.width"),
        );
        assert_f64_bit_exact(
            rect64_utils::height(rect),
            decode_f64(&v["height"]),
            &format!("{name}.height"),
        );
        assert_eq!(
            rect64_utils::is_empty(rect),
            v["isEmpty"].as_bool().unwrap(),
            "{name}.isEmpty"
        );
        assert_eq!(
            rect64_utils::is_valid(rect),
            v["isValid"].as_bool().unwrap(),
            "{name}.isValid"
        );
        assert_point_eq(
            rect64_utils::mid_point(rect),
            decode_point(&v["midPoint"]),
            &format!("{name}.midPoint"),
        );
        let expected_path = decode_path(&v["asPath"]);
        let actual_path = rect64_utils::as_path(rect);
        assert_eq!(
            actual_path.len(),
            expected_path.len(),
            "{name}.asPath length"
        );
        for (i, (a, e)) in actual_path.iter().zip(expected_path.iter()).enumerate() {
            assert_point_eq(*a, *e, &format!("{name}.asPath[{i}]"));
        }
    }
    for v in doc["rectContains"].as_array().unwrap() {
        let rect = decode_rect(&v["rect"]);
        let pt = decode_point(&v["pt"]);
        assert_eq!(
            rect64_utils::contains(rect, pt),
            v["expected"].as_bool().unwrap(),
            "{}",
            v["name"].as_str().unwrap_or("?")
        );
    }
    for v in doc["rectContainsRect"].as_array().unwrap() {
        let rect = decode_rect(&v["rect"]);
        let rec = decode_rect(&v["rec"]);
        assert_eq!(
            rect64_utils::contains_rect(rect, rec),
            v["expected"].as_bool().unwrap(),
            "{}",
            v["name"].as_str().unwrap_or("?")
        );
    }
    for v in doc["rectIntersects"].as_array().unwrap() {
        let rect = decode_rect(&v["rect"]);
        let rec = decode_rect(&v["rec"]);
        assert_eq!(
            rect64_utils::intersects(rect, rec),
            v["expected"].as_bool().unwrap(),
            "{}",
            v["name"].as_str().unwrap_or("?")
        );
    }
}

#[test]
fn point64_utils_match_oracle() {
    let doc = load("clipper-core.json");
    for v in doc["point64Create"].as_array().unwrap() {
        let (x, y) = (decode_f64(&v["x"]), decode_f64(&v["y"]));
        let expected = decode_point(&v["expected"]);
        assert_point_eq(point64_utils::create(x, y, 0.0), expected, "point64Create");
    }
    for v in doc["point64Scale"].as_array().unwrap() {
        let pt = decode_point(&v["pt"]);
        let scale = decode_f64(&v["scale"]);
        let expected = decode_point(&v["expected"]);
        assert_point_eq(point64_utils::scale(pt, scale), expected, "point64Scale");
    }
    for v in doc["point64Add"].as_array().unwrap() {
        let (a, b) = (decode_point(&v["a"]), decode_point(&v["b"]));
        let expected = decode_point(&v["expected"]);
        assert_point_eq(point64_utils::add(a, b), expected, "point64Add");
    }
    for v in doc["point64Subtract"].as_array().unwrap() {
        let (a, b) = (decode_point(&v["a"]), decode_point(&v["b"]));
        let expected = decode_point(&v["expected"]);
        assert_point_eq(point64_utils::subtract(a, b), expected, "point64Subtract");
    }
    for v in doc["point64Equals"].as_array().unwrap() {
        let (a, b) = (decode_point(&v["a"]), decode_point(&v["b"]));
        let expected = v["expected"].as_bool().unwrap();
        assert_eq!(point64_utils::equals(a, b), expected, "point64Equals");
    }
    for v in doc["point64ToString"].as_array().unwrap() {
        let pt = decode_point(&v["pt"]);
        let expected = v["expected"].as_str().unwrap();
        assert_eq!(point64_utils::to_string(pt), expected, "point64ToString");
    }
}

#[test]
fn get_closest_pt_on_segment_matches_oracle() {
    let doc = load("clipper-core.json");
    for v in doc["getClosestPtOnSegment"].as_array().unwrap() {
        let off = decode_point(&v["off"]);
        let seg1 = decode_point(&v["seg1"]);
        let seg2 = decode_point(&v["seg2"]);
        let expected = decode_point(&v["expected"]);
        assert_point_eq(
            get_closest_pt_on_segment(off, seg1, seg2),
            expected,
            "getClosestPtOnSegment",
        );
    }
}

#[test]
fn point_in_polygon_and_path2_contains_path1_match_oracle() {
    let doc = load("clipper-core.json");
    for v in doc["pointInPolygon"].as_array().unwrap() {
        let poly = decode_path(&v["poly"]);
        let pt = decode_point(&v["pt"]);
        let expected = v["expected"].as_i64().unwrap() as i32;
        let actual = point_in_polygon(pt, &poly) as i32;
        assert_eq!(actual, expected, "pointInPolygon");
    }
    for v in doc["path2ContainsPath1"].as_array().unwrap() {
        let path1 = decode_path(&v["path1"]);
        let path2 = decode_path(&v["path2"]);
        let expected = v["expected"].as_bool().unwrap();
        assert_eq!(
            path2_contains_path1(&path1, &path2),
            expected,
            "path2ContainsPath1"
        );
    }
}

#[test]
fn segs_intersect_and_get_line_intersect_pt_match_oracle() {
    let doc = load("clipper-core.json");
    for v in doc["segsIntersect"].as_array().unwrap() {
        let (a, b, c, d) = (
            decode_point(&v["seg1a"]),
            decode_point(&v["seg1b"]),
            decode_point(&v["seg2a"]),
            decode_point(&v["seg2b"]),
        );
        let inclusive = v["inclusive"].as_bool().unwrap();
        let expected = v["expected"].as_bool().unwrap();
        assert_eq!(
            segs_intersect(a, b, c, d, inclusive),
            expected,
            "segsIntersect"
        );
    }
    for v in doc["getLineIntersectPt"].as_array().unwrap() {
        let (a, b, c, d) = (
            decode_point(&v["ln1a"]),
            decode_point(&v["ln1b"]),
            decode_point(&v["ln2a"]),
            decode_point(&v["ln2b"]),
        );
        let actual = get_line_intersect_pt(a, b, c, d);
        if v["expected"].is_null() {
            assert!(
                actual.is_none(),
                "getLineIntersectPt expected None, got {actual:?}"
            );
        } else {
            let expected = decode_point(&v["expected"]);
            let actual = actual.unwrap_or_else(|| {
                panic!("getLineIntersectPt expected Some({expected:?}), got None")
            });
            assert_point_eq(actual, expected, "getLineIntersectPt");
        }
    }
}

#[test]
fn multiply_uint64_matches_oracle() {
    let doc = load("clipper-core.json");
    for v in doc["multiplyUInt64"].as_array().unwrap() {
        let a = decode_f64(&v["a"]);
        let b = decode_f64(&v["b"]);
        let expected_lo = decode_bigint(&v["expectedLo"]);
        let expected_hi = decode_bigint(&v["expectedHi"]);
        let result = multiply_uint64(a, b);
        assert_eq!(result.lo64, expected_lo, "multiplyUInt64({a},{b}).lo64");
        assert_eq!(result.hi64, expected_hi, "multiplyUInt64({a},{b}).hi64");
    }
}

#[test]
fn offset_get_unit_normal_matches_oracle() {
    let doc = load("clipper-core.json");
    for v in doc["offsetGetUnitNormal"].as_array().unwrap() {
        let (p1, p2) = (decode_point(&v["pt1"]), decode_point(&v["pt2"]));
        let expected = decode_point_d(&v["expected"]);
        assert_point_d_eq(
            ClipperOffset::get_unit_normal(p1, p2),
            expected,
            "offsetGetUnitNormal",
        );
    }
}

#[test]
fn offset_get_lowest_path_info_matches_oracle() {
    let doc = load("clipper-core.json");
    for v in doc["offsetGetLowestPathInfo"].as_array().unwrap() {
        let paths = decode_paths(&v["paths"]);
        let info = ClipperOffset::get_lowest_path_info(&paths);
        let expected_idx = v["expectedIdx"].as_i64().unwrap();
        let expected_is_neg = v["expectedIsNegArea"].as_bool().unwrap();
        let name = v["name"].as_str().unwrap_or("?");
        assert_eq!(info.idx, expected_idx, "{name}.idx");
        assert_eq!(info.is_neg_area, expected_is_neg, "{name}.isNegArea");
    }
}

#[test]
fn offset_strip_duplicates_matches_oracle() {
    let doc = load("clipper-core.json");
    for v in doc["offsetStripDuplicates"].as_array().unwrap() {
        let path = decode_path(&v["path"]);
        let is_closed = v["isClosed"].as_bool().unwrap();
        let expected = decode_path(&v["expected"]);
        let actual = ClipperOffset::strip_duplicates(&path, is_closed);
        assert_eq!(actual.len(), expected.len(), "offsetStripDuplicates length");
        for (i, (a, e)) in actual.iter().zip(expected.iter()).enumerate() {
            assert_point_eq(*a, *e, &format!("offsetStripDuplicates[{i}]"));
        }
    }
}

#[test]
fn offset_area_and_sqr_match_oracle() {
    let doc = load("clipper-core.json");
    for v in doc["offsetArea"].as_array().unwrap() {
        let path = decode_path(&v["path"]);
        assert_f64_bit_exact(
            ClipperOffset::area(&path),
            decode_f64(&v["expected"]),
            v["name"].as_str().unwrap_or("?"),
        );
    }
    for v in doc["offsetSqr"].as_array().unwrap() {
        let input = decode_f64(&v["input"]);
        assert_f64_bit_exact(
            ClipperOffset::sqr(input),
            decode_f64(&v["expected"]),
            "offsetSqr",
        );
    }
}

#[test]
fn offset_ellipse_matches_oracle() {
    let doc = load("clipper-core.json");
    for v in doc["offsetEllipse"].as_array().unwrap() {
        let center = decode_point(&v["center"]);
        let radius_x = decode_f64(&v["radiusX"]);
        let radius_y = decode_f64(&v["radiusY"]);
        let steps = v["steps"].as_i64().unwrap();
        let expected = decode_path(&v["expected"]);
        let actual = ClipperOffset::ellipse(center, radius_x, radius_y, steps);
        assert_eq!(actual.len(), expected.len(), "offsetEllipse length");
        for (i, (a, e)) in actual.iter().zip(expected.iter()).enumerate() {
            assert_point_eq(*a, *e, &format!("offsetEllipse[{i}]"));
        }
    }
}

#[test]
fn offset_pre_cleanup_pipeline_matches_oracle() {
    let doc = load("clipper-core.json");
    let vectors = doc["offsetPreCleanup"].as_array().unwrap();
    assert!(
        vectors.len() >= 40,
        "expected substantial offsetPreCleanup coverage, got {}",
        vectors.len()
    );
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
        let actual = co.execute_pre_cleanup(delta).unwrap_or_else(|err| {
            panic!("{name} (delta={delta}): execute_pre_cleanup failed: {err:?}")
        });
        assert_paths_eq(&actual, &expected, &format!("{name} (delta={delta})"));
    }
}
