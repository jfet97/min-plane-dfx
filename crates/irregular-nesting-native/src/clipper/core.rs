/*
Copyright: Angus Johnson 2010-2025
License: https://www.boost.org/LICENSE_1_0.txt
Complete license text: ../../LICENSES/clipper2-ts-BSL-1.0.txt
*/

//! Vendor-translated port of `clipper2-ts@2.0.1-18`'s `src/Core.ts` - core
//! structures and functions for the Clipper library — per ruling R10
//! (`docs/planning/rust-irregular-backend/stage0-rulings.md`).
//!
//! This is a mechanical, line-by-line translation. Every public item below
//! names the exact TS source line range it was translated from. Oddities
//! (fast-path/slow-path duplication, the asymmetric guard shapes, the exact
//! floating-point operation order) are reproduced verbatim per the migration
//! prompt §2 ("the existing TypeScript behavior is the specification").
//!
//! JS `Number` is IEEE-754 binary64, same representation as Rust `f64`, so
//! `Point64`/`Rect64` coordinates are modeled as `f64` (not integers) to match
//! TS's `number` type exactly, including the ability to (transiently) hold
//! non-integer or out-of-safe-range values before validation rejects them.
//!
//! `BigInt` fallback paths use `num_bigint::BigInt`. JS `BigInt(x)` / `Number(bigint)`
//! conversions are reproduced via [`f64_to_bigint`] / [`bigint_to_number`] (see
//! their docs for the correctness argument).
//!
//! JS `Math.round`/`Math.min`/`Math.max` differ from their Rust namesakes
//! (see [`math_round`], [`math_min`], [`math_max`] — TODO(js_number): these
//! are local ECMAScript-faithful helpers per the migration prompt §8.1; no
//! shared `js_number` module helper exists for them yet, as this module lives
//! outside this task's assigned `src/clipper/` directory).

use num_bigint::BigInt;
use std::sync::LazyLock;

// ---------------------------------------------------------------------------
// JS Number constants and safe-integer / BigInt conversion helpers
// ---------------------------------------------------------------------------

/// TS: `Number.MAX_SAFE_INTEGER` (Core.ts:97 `const maxSafeInteger = Number.MAX_SAFE_INTEGER;`).
pub const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// TS: `Number.MIN_SAFE_INTEGER`, used by `icGetBounds`/`getLowestPathInfo`-style seeds.
pub const MIN_SAFE_INTEGER: f64 = -9_007_199_254_740_991.0;

/// TS: `Number.isSafeInteger(x)` (ECMA-262): finite, no fractional part, and
/// within `±Number.MAX_SAFE_INTEGER`.
pub fn is_safe_integer(x: f64) -> bool {
    x.is_finite() && x.fract() == 0.0 && x.abs() <= MAX_SAFE_INTEGER
}

/// TS: `Number.isInteger(x)` (ECMA-262): finite with no fractional part
/// (unlike `isSafeInteger`, no magnitude bound).
pub fn is_integer(x: f64) -> bool {
    x.is_finite() && x.fract() == 0.0
}

/// Mirrors JS `BigInt(x)` for an integer-valued finite `x`. Every Core.ts call
/// site guards with `Number.isSafeInteger`/`Number.isInteger` before calling
/// `BigInt(...)`, so this is only ever invoked on exact-integer doubles. Any
/// finite `f64` with zero fractional part is *itself* an exact integer value
/// (binary64 integers never lose precision relative to their own stored
/// value), so formatting with zero decimal places and parsing that decimal
/// string as a `BigInt` reproduces the exact mathematical integer JS's
/// `BigInt(x)` would construct.
pub fn f64_to_bigint(x: f64) -> BigInt {
    debug_assert!(
        x.is_finite() && x.fract() == 0.0,
        "f64_to_bigint requires an integer-valued finite f64, got {x}"
    );
    let s = format!("{x:.0}");
    s.parse::<BigInt>()
        .unwrap_or_else(|e| panic!("f64_to_bigint: {x} formatted as {s:?} failed to parse: {e}"))
}

/// Mirrors JS `Number(bigintValue)`: a correctly-rounded (round-to-nearest,
/// ties-to-even) conversion of the exact arbitrary-precision integer to the
/// nearest representable `f64`, per ECMA-262's `BigInt::toNumber`. Rust's
/// `str::parse::<f64>()` is likewise a correctly-rounded decimal-to-binary64
/// conversion, so round-tripping through the exact decimal string of the
/// `BigInt` reproduces JS's conversion bit-for-bit.
pub fn bigint_to_number(b: &BigInt) -> f64 {
    b.to_string()
        .parse::<f64>()
        .unwrap_or_else(|e| panic!("bigint_to_number: {b} failed to parse as f64: {e}"))
}

// ---------------------------------------------------------------------------
// Local ECMAScript-faithful Math.* helpers (TODO(js_number): see module doc)
// ---------------------------------------------------------------------------

/// Every finite `f64` with `|x| >= 2^52` is already an exact integer (its ULP
/// is `>= 1` from this magnitude up), so ECMAScript's `Math.round` (per
/// ECMA-262 21.3.2.28: "the Number value closest to n that is integral") must
/// return it unchanged. Below this threshold, `x + 0.5` cannot lose the
/// information `floor(x + 0.5)` needs.
const MATH_ROUND_ALREADY_INTEGRAL_THRESHOLD: f64 = 4_503_599_627_370_496.0; // 2^52

/// TS `Math.round` semantics: rounds half toward `+Infinity`. This is
/// *different* from Rust's `f64::round()`, which rounds half away from zero
/// (e.g. `Math.round(-0.5) === -0` in JS, but `(-0.5_f64).round() == -1.0` in
/// Rust). Used pervasively by Core.ts/Offset.ts for the "checked cast to
/// int64" pattern.
///
/// Naively computing `(x + 0.5).floor()` for every `x` (a common but
/// incorrect translation) silently misrounds large-magnitude integral inputs:
/// e.g. for `x = 9007199254740991.0` (`Number.MAX_SAFE_INTEGER`, already an
/// exact integer), `x + 0.5` itself loses precision and rounds (ties-to-even)
/// to `9007199254740992.0` *before* `floor` ever runs, so the naive formula
/// returns `9007199254740992.0` where real `Math.round` returns
/// `9007199254740991.0` unchanged. Caught by the `roundToEven` differential
/// vector `dump-clipper-core.ts` generates from `InternalClipper.roundToEven`
/// at exactly this boundary value.
pub fn math_round(x: f64) -> f64 {
    if x.is_nan() {
        return f64::NAN;
    }
    if x == 0.0 || x.is_infinite() {
        return x;
    }
    if x.abs() >= MATH_ROUND_ALREADY_INTEGRAL_THRESHOLD {
        return x;
    }
    let r = (x + 0.5).floor();
    if x < 0.0 && r == 0.0 {
        -0.0
    } else {
        r
    }
}

/// TS `Math.min` semantics: propagates `NaN` (unlike Rust's `f64::min`, which
/// ignores a `NaN` operand) and treats `-0 < +0` for the two-zeros case.
pub fn math_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        return f64::NAN;
    }
    if a == 0.0 && b == 0.0 {
        return if a.is_sign_negative() || b.is_sign_negative() {
            -0.0
        } else {
            0.0
        };
    }
    if a < b {
        a
    } else {
        b
    }
}

/// TS `Math.max` semantics: propagates `NaN` and treats `+0 > -0` for the
/// two-zeros case.
pub fn math_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        return f64::NAN;
    }
    if a == 0.0 && b == 0.0 {
        return if a.is_sign_negative() && b.is_sign_negative() {
            -0.0
        } else {
            0.0
        };
    }
    if a > b {
        a
    } else {
        b
    }
}

// ---------------------------------------------------------------------------
// Point64 / PointD / Path64 / PathD / Paths64 / PathsD / Rect64 / RectD
// ---------------------------------------------------------------------------

/// TS: Core.ts:10-14 `interface Point64 { x: number; y: number; z?: number; }`.
///
/// `z` is modeled as a required `f64` defaulting to `0.0` rather than
/// `Option<f64>`: every read site in Core.ts/Offset.ts uses the `pt.z || 0`
/// pattern (see [`Point64::z_or_zero`]), which is indistinguishable at the
/// value level between "absent" and "present but falsy (`0`/`-0`)". No call
/// site in the ported subset observes key-presence (e.g. via
/// `Object.keys`/`JSON.stringify`), so this collapse is semantics-preserving
/// for everything reachable from Core.ts/Offset.ts.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Point64 {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

impl Point64 {
    pub fn new(x: f64, y: f64, z: f64) -> Self {
        Point64 { x, y, z }
    }

    /// TS: the `pt.z || 0` pattern used throughout Offset.ts. JS `||` treats
    /// both `0` and `-0` (and `undefined`) as falsy, so this collapses `-0`
    /// to `+0` as well as substituting `0` for an absent value.
    pub fn z_or_zero(&self) -> f64 {
        if self.z == 0.0 {
            0.0
        } else {
            self.z
        }
    }
}

/// TS: Core.ts:16-20 `interface PointD { x: number; y: number; z?: number; }`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PointD {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

impl PointD {
    pub fn new(x: f64, y: f64, z: f64) -> Self {
        PointD { x, y, z }
    }

    /// See [`Point64::z_or_zero`].
    pub fn z_or_zero(&self) -> f64 {
        if self.z == 0.0 {
            0.0
        } else {
            self.z
        }
    }
}

/// TS: Core.ts:22 `export type Path64 = Point64[];`.
pub type Path64 = Vec<Point64>;
/// TS: Core.ts:23 `export type PathD = PointD[];`.
pub type PathD = Vec<PointD>;
/// TS: Core.ts:24 `export type Paths64 = Path64[];`.
pub type Paths64 = Vec<Path64>;
/// TS: Core.ts:25 `export type PathsD = PathD[];`.
pub type PathsD = Vec<PathD>;

/// TS: Core.ts:27-32 `interface Rect64 { left, top, right, bottom: number; }`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect64 {
    pub left: f64,
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
}

/// TS: Core.ts:34-39 `interface RectD { left, top, right, bottom: number; }`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RectD {
    pub left: f64,
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
}

/// TS: Core.ts:42-48 `enum ClipType`. Note: "all clipping operations except
/// Difference are commutative" (Core.ts:41).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(i32)]
pub enum ClipType {
    NoClip = 0,
    Intersection = 1,
    Union = 2,
    Difference = 3,
    Xor = 4,
}

/// TS: Core.ts:50-53 `enum PathType`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(i32)]
pub enum PathType {
    Subject = 0,
    Clip = 1,
}

/// TS: Core.ts:58-63 `enum FillRule` (EvenOdd/Alternate and NonZero/Winding
/// are "by far the most widely used", Core.ts:55-57).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(i32)]
pub enum FillRule {
    EvenOdd = 0,
    NonZero = 1,
    Positive = 2,
    Negative = 3,
}

/// TS: Core.ts:66-70 `enum PointInPolygonResult`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(i32)]
pub enum PointInPolygonResult {
    IsOn = 0,
    IsInside = 1,
    IsOutside = 2,
}

/// TS: Core.ts:74-80 `type ZCallback64 = (bot1, top1, bot2, top2, intersectPt) => void`.
/// `intersectPt` is mutated in place by the JS callback (its `.z` field is
/// set); modeled here as an `&mut Point64` out-parameter. Owned by the
/// boolean-clip engine (`engine::Clipper64::z_callback`) and, via
/// `offset::ClipperOffset::execute`'s installed `ZCB` wrapper
/// (`offset::ClipperOffset::zcb`), by the offset module's self-intersection
/// cleanup call into the engine (Offset.ts:192-203) — not invoked by anything
/// in this module.
pub type ZCallback64 = Box<dyn Fn(Point64, Point64, Point64, Point64, &mut Point64)>;

/// TS: Core.ts:82-88 `type ZCallbackD = ...`. See [`ZCallback64`].
pub type ZCallbackD = Box<dyn Fn(PointD, PointD, PointD, PointD, &mut PointD)>;

// ---------------------------------------------------------------------------
// Typed errors for the guard functions that `throw` in TS
// ---------------------------------------------------------------------------

/// Typed replacement for the `RangeError`/`Error` values Core.ts's guard
/// functions `throw`. Every variant names its TS throw site.
#[derive(Debug, Clone, PartialEq)]
pub enum CoreError {
    /// TS: Core.ts:166 `throw new RangeError("Scale must be a finite number")`
    /// (`maxSafeCoordinateForScale`).
    NonFiniteScale,
    /// TS: Core.ts:175 `` throw new RangeError(`Scaled coordinate exceeds Number.MAX_SAFE_INTEGER in ${context}`) ``
    /// (`checkSafeScaleValue`).
    ScaledCoordinateOverflow { context: String },
    /// TS: Core.ts:181 `` throw new RangeError(`Coordinate exceeds Number.MAX_SAFE_INTEGER in ${context}`) ``
    /// (`ensureSafeInteger`).
    CoordinateOverflow { context: String },
    /// TS: Core.ts:231 `throw new Error("Error: Precision is out of range.")`
    /// (`checkPrecision`).
    PrecisionOutOfRange,
}

// ---------------------------------------------------------------------------
// Private module-level constants (Core.ts:96-160)
// ---------------------------------------------------------------------------

/// TS: Core.ts:98 `const maxDeltaForSafeProduct = Math.floor(Math.sqrt(maxSafeInteger));`.
static MAX_DELTA_FOR_SAFE_PRODUCT: LazyLock<f64> =
    LazyLock::new(|| MAX_SAFE_INTEGER.sqrt().floor());

fn max_delta_for_safe_product() -> f64 {
    *MAX_DELTA_FOR_SAFE_PRODUCT
}

/// TS: Core.ts:153 `const IC_MaxInt64 = BigInt("9223372036854775807");`.
static IC_MAX_INT64: LazyLock<BigInt> = LazyLock::new(|| {
    "9223372036854775807"
        .parse::<BigInt>()
        .expect("literal i64::MAX parses")
});

/// TS: Core.ts:154 `const IC_MaxCoord = Number(IC_MaxInt64 / B4);`.
static IC_MAX_COORD: LazyLock<f64> = LazyLock::new(|| {
    let four = BigInt::from(4);
    let divided = &*IC_MAX_INT64 / &four;
    bigint_to_number(&divided)
});

/// TS: Core.ts:155 `const IC_Invalid64 = Number(IC_MaxInt64);`.
static IC_INVALID64: LazyLock<f64> = LazyLock::new(|| bigint_to_number(&IC_MAX_INT64));

/// TS: `InternalClipper.MaxCoord`/`InternalClipper.max_coord` (Core.ts:652-653).
pub fn max_coord() -> f64 {
    *IC_MAX_COORD
}

/// TS: `InternalClipper.min_coord` (Core.ts:654): `-IC_MaxCoord`.
pub fn min_coord() -> f64 {
    -*IC_MAX_COORD
}

/// TS: `InternalClipper.Invalid64` (Core.ts:655).
pub fn invalid64() -> f64 {
    *IC_INVALID64
}

/// TS: Core.ts:156 `const IC_floatingPointTolerance = 1E-12;`.
pub const IC_FLOATING_POINT_TOLERANCE: f64 = 1e-12;

/// TS: Core.ts:157 `const IC_defaultMinimumEdgeLength = 0.1;`.
pub const IC_DEFAULT_MINIMUM_EDGE_LENGTH: f64 = 0.1;

/// TS: Core.ts:158 `const IC_maxCoordForSafeAreaProduct = Math.floor(maxDeltaForSafeProduct / 2);`.
static IC_MAX_COORD_FOR_SAFE_AREA_PRODUCT: LazyLock<f64> =
    LazyLock::new(|| (max_delta_for_safe_product() / 2.0).floor());

/// TS: `InternalClipper.maxCoordForSafeAreaProduct` (Core.ts:658). Used internally by
/// `icArea`'s fast-path threshold, but also (like [`max_coord_for_safe_cross_sq`])
/// exported for `Engine.ts`'s `areaOutPt`/`areaTriangle` (out of Core.ts/Offset.ts's own
/// scope) — kept `pub` for that caller, per the same rationale documented on
/// [`max_coord_for_safe_cross_sq`].
pub fn max_coord_for_safe_area_product() -> f64 {
    *IC_MAX_COORD_FOR_SAFE_AREA_PRODUCT
}

/// TS: Core.ts:160 `const IC_maxCoordForSafeCrossSq = Math.floor(Math.sqrt(Math.sqrt(maxSafeInteger / 4)));`.
/// Exported via `InternalClipper.maxCoordForSafeCrossSq`; unused within
/// Core.ts/Offset.ts itself but consumed by `Engine.ts:2333` (boolean-clip
/// engine, out of this module's scope — kept public for that future caller).
static IC_MAX_COORD_FOR_SAFE_CROSS_SQ: LazyLock<f64> =
    LazyLock::new(|| (MAX_SAFE_INTEGER / 4.0).sqrt().sqrt().floor());

/// TS: `InternalClipper.maxCoordForSafeCrossSq` (Core.ts:659).
pub fn max_coord_for_safe_cross_sq() -> f64 {
    *IC_MAX_COORD_FOR_SAFE_CROSS_SQ
}

// ---------------------------------------------------------------------------
// Private module-level functions (Core.ts:162-646), exposed as `pub` here
// since Rust has no module-private/exported-object split matching TS's
// "InternalClipper" bundling — everything below is reachable either directly
// or via the `internal_clipper` re-export table at the bottom of this file.
// ---------------------------------------------------------------------------

/// TS: Core.ts:164-171 `maxSafeCoordinateForScale`.
pub fn max_safe_coordinate_for_scale(scale: f64) -> Result<f64, CoreError> {
    if !scale.is_finite() {
        return Err(CoreError::NonFiniteScale);
    }
    let abs_scale = scale.abs();
    if abs_scale == 0.0 {
        return Ok(f64::INFINITY);
    }
    Ok(MAX_SAFE_INTEGER / abs_scale)
}

/// TS: Core.ts:173-177 `checkSafeScaleValue`.
pub fn check_safe_scale_value(value: f64, max_abs: f64, context: &str) -> Result<(), CoreError> {
    if !value.is_finite() || value.abs() > max_abs {
        return Err(CoreError::ScaledCoordinateOverflow {
            context: context.to_string(),
        });
    }
    Ok(())
}

/// TS: Core.ts:179-183 `ensureSafeInteger`. Despite the name, this only
/// checks finiteness and magnitude (`|value| <= Number.MAX_SAFE_INTEGER`),
/// NOT that `value` is actually an integer — a non-integer like `1.5` passes.
/// Reproduced verbatim (faithful-oddity port, migration prompt §2).
pub fn ensure_safe_integer(value: f64, context: &str) -> Result<(), CoreError> {
    if !value.is_finite() || value.abs() > MAX_SAFE_INTEGER {
        return Err(CoreError::CoordinateOverflow {
            context: context.to_string(),
        });
    }
    Ok(())
}

/// TS: Core.ts:100-104 `isSafeProduct` (private helper).
fn is_safe_product(a: f64, b: f64) -> bool {
    if !is_safe_integer(a) || !is_safe_integer(b) {
        return false;
    }
    if a == 0.0 || b == 0.0 {
        return true;
    }
    a.abs() <= MAX_SAFE_INTEGER / b.abs()
}

/// TS: Core.ts:106-108 `isSafeSum` (private helper).
fn is_safe_sum(a: f64, b: f64) -> bool {
    a.abs() + b.abs() <= MAX_SAFE_INTEGER
}

/// TS: Core.ts:110-125 `safeMultiplyDifference` (private helper).
fn safe_multiply_difference(a: f64, b: f64, c: f64, d: f64) -> f64 {
    if is_safe_product(a, b) && is_safe_product(c, d) {
        let prod1 = a * b;
        let prod2 = c * d;
        if is_safe_sum(prod1, prod2) {
            return prod1 - prod2;
        }
    }

    if is_safe_integer(a) && is_safe_integer(b) && is_safe_integer(c) && is_safe_integer(d) {
        let result = f64_to_bigint(a) * f64_to_bigint(b) - f64_to_bigint(c) * f64_to_bigint(d);
        return bigint_to_number(&result);
    }

    (a * b) - (c * d)
}

/// TS: Core.ts:127-142 `safeMultiplySum` (private helper).
fn safe_multiply_sum(a: f64, b: f64, c: f64, d: f64) -> f64 {
    if is_safe_product(a, b) && is_safe_product(c, d) {
        let prod1 = a * b;
        let prod2 = c * d;
        if is_safe_sum(prod1, prod2) {
            return prod1 + prod2;
        }
    }

    if is_safe_integer(a) && is_safe_integer(b) && is_safe_integer(c) && is_safe_integer(d) {
        let result = f64_to_bigint(a) * f64_to_bigint(b) + f64_to_bigint(c) * f64_to_bigint(d);
        return bigint_to_number(&result);
    }

    (a * b) + (c * d)
}

/// TS: Core.ts:185-198 `crossProduct`.
pub fn cross_product(pt1: Point64, pt2: Point64, pt3: Point64) -> f64 {
    let a = pt2.x - pt1.x;
    let b = pt3.y - pt2.y;
    let c = pt2.y - pt1.y;
    let d = pt3.x - pt2.x;

    let bound = max_delta_for_safe_product();
    if a.abs() < bound && b.abs() < bound && c.abs() < bound && d.abs() < bound {
        return (a * b) - (c * d);
    }

    safe_multiply_difference(a, b, c, d)
}

/// TS: Core.ts:200-227 `crossProductSign`.
pub fn cross_product_sign(pt1: Point64, pt2: Point64, pt3: Point64) -> i32 {
    let a = pt2.x - pt1.x;
    let b = pt3.y - pt2.y;
    let c = pt2.y - pt1.y;
    let d = pt3.x - pt2.x;

    let bound = max_delta_for_safe_product();
    if a.abs() < bound && b.abs() < bound && c.abs() < bound && d.abs() < bound {
        let prod1 = a * b;
        let prod2 = c * d;
        return if prod1 > prod2 {
            1
        } else if prod1 < prod2 {
            -1
        } else {
            0
        };
    }

    if !is_safe_integer(a) || !is_safe_integer(b) || !is_safe_integer(c) || !is_safe_integer(d) {
        let prod1 = a * b;
        let prod2 = c * d;
        return if prod1 > prod2 {
            1
        } else if prod1 < prod2 {
            -1
        } else {
            0
        };
    }

    let big_prod1 = f64_to_bigint(a) * f64_to_bigint(b);
    let big_prod2 = f64_to_bigint(c) * f64_to_bigint(d);

    if big_prod1 == big_prod2 {
        0
    } else if big_prod1 > big_prod2 {
        1
    } else {
        -1
    }
}

/// TS: Core.ts:229-233 `checkPrecision`.
pub fn check_precision(precision: f64) -> Result<(), CoreError> {
    // Deliberately NOT `!(-8.0..=8.0).contains(&precision)`: `RangeInclusive::contains`
    // treats a NaN `precision` as out-of-range (since `NaN <= x` is always false), which
    // would error, whereas TS's literal `precision < -8 || precision > 8` is false for
    // NaN (both comparisons are false), so TS accepts a NaN precision. Preserved verbatim.
    #[allow(clippy::manual_range_contains)]
    if precision < -8.0 || precision > 8.0 {
        return Err(CoreError::PrecisionOutOfRange);
    }
    Ok(())
}

/// TS: Core.ts:235-237 `isAlmostZero`.
pub fn is_almost_zero(value: f64) -> bool {
    value.abs() <= IC_FLOATING_POINT_TOLERANCE
}

/// TS: Core.ts:239-241 `triSign`.
pub fn tri_sign(x: f64) -> i32 {
    if x < 0.0 {
        -1
    } else if x > 0.0 {
        1
    } else {
        0
    }
}

/// TS: Core.ts:243-246 `interface UInt128Struct { lo64: bigint; hi64: bigint; }`.
#[derive(Debug, Clone, PartialEq)]
pub struct UInt128Struct {
    pub lo64: BigInt,
    pub hi64: BigInt,
}

/// TS: Core.ts:248-258 `multiplyUInt64`.
pub fn multiply_uint64(a: f64, b: f64) -> UInt128Struct {
    let a_big = f64_to_bigint(a);
    let b_big = f64_to_bigint(b);
    let res = a_big * b_big;

    let mask = (BigInt::from(1) << 64) - BigInt::from(1); // TS: `UINT64_MASK = BigInt("0xFFFFFFFFFFFFFFFF")`
    let lo64 = &res & &mask;
    let hi64 = &res >> 64u32;

    UInt128Struct { lo64, hi64 }
}

/// TS: Core.ts:260-289 `productsAreEqual` ("returns true if (and only if) `a * b == c * d`").
pub fn products_are_equal(a: f64, b: f64, c: f64, d: f64) -> bool {
    let abs_a = a.abs();
    let abs_b = b.abs();
    let abs_c = c.abs();
    let abs_d = d.abs();

    let bound = max_delta_for_safe_product();
    if abs_a < bound && abs_b < bound && abs_c < bound && abs_d < bound {
        return a * b == c * d;
    }

    let sign = |v: f64| -> i32 {
        if v < 0.0 {
            -1
        } else if v > 0.0 {
            1
        } else {
            0
        }
    };
    let sign_ab = sign(a) * sign(b);
    let sign_cd = sign(c) * sign(d);

    if sign_ab != sign_cd {
        return false;
    }
    if sign_ab == 0 {
        return true;
    }
    if !is_safe_integer(abs_a)
        || !is_safe_integer(abs_b)
        || !is_safe_integer(abs_c)
        || !is_safe_integer(abs_d)
    {
        return a * b == c * d;
    }

    let big_a = f64_to_bigint(abs_a);
    let big_b = f64_to_bigint(abs_b);
    let big_c = f64_to_bigint(abs_c);
    let big_d = f64_to_bigint(abs_d);

    (big_a * big_b) == (big_c * big_d)
}

/// TS: Core.ts:291-299 `isCollinear`.
pub fn is_collinear(pt1: Point64, shared_pt: Point64, pt2: Point64) -> bool {
    let a = shared_pt.x - pt1.x;
    let b = pt2.y - shared_pt.y;
    let c = shared_pt.y - pt1.y;
    let d = pt2.x - shared_pt.x;
    products_are_equal(a, b, c, d)
}

/// TS: Core.ts:301-314 `dotProduct`.
pub fn dot_product(pt1: Point64, pt2: Point64, pt3: Point64) -> f64 {
    let a = pt2.x - pt1.x;
    let b = pt3.x - pt2.x;
    let c = pt2.y - pt1.y;
    let d = pt3.y - pt2.y;

    let bound = max_delta_for_safe_product();
    if a.abs() < bound && b.abs() < bound && c.abs() < bound && d.abs() < bound {
        return (a * b) + (c * d);
    }

    safe_multiply_sum(a, b, c, d)
}

/// TS: Core.ts:316-337 `dotProductSign`.
pub fn dot_product_sign(pt1: Point64, pt2: Point64, pt3: Point64) -> i32 {
    let a = pt2.x - pt1.x;
    let b = pt3.x - pt2.x;
    let c = pt2.y - pt1.y;
    let d = pt3.y - pt2.y;

    let bound = max_delta_for_safe_product();
    if a.abs() < bound && b.abs() < bound && c.abs() < bound && d.abs() < bound {
        let sum = (a * b) + (c * d);
        return if sum > 0.0 {
            1
        } else if sum < 0.0 {
            -1
        } else {
            0
        };
    }

    if !is_safe_integer(a) || !is_safe_integer(b) || !is_safe_integer(c) || !is_safe_integer(d) {
        let sum = (a * b) + (c * d);
        return if sum > 0.0 {
            1
        } else if sum < 0.0 {
            -1
        } else {
            0
        };
    }

    let big_sum = f64_to_bigint(a) * f64_to_bigint(b) + f64_to_bigint(c) * f64_to_bigint(d);
    let zero = BigInt::from(0);
    if big_sum == zero {
        0
    } else if big_sum > zero {
        1
    } else {
        -1
    }
}

/// TS: Core.ts:339-386 `icArea` (`InternalClipper.area`). Shoelace formula;
/// see <https://en.wikipedia.org/wiki/Shoelace_formula>.
pub fn area(path: &[Point64]) -> f64 {
    let cnt = path.len();
    if cnt < 3 {
        return 0.0;
    }

    // Fast path when coords are small enough that (y1+y2)*(x1-x2) won't overflow.
    let mut all_small = true;
    for pt in path {
        if pt.x.abs() >= max_coord_for_safe_area_product()
            || pt.y.abs() >= max_coord_for_safe_area_product()
        {
            all_small = false;
            break;
        }
    }

    let mut prev_pt = path[cnt - 1];

    if all_small {
        let mut total = 0.0_f64;
        for &pt in path {
            total += (prev_pt.y + pt.y) * (prev_pt.x - pt.x);
            prev_pt = pt;
        }
        return total * 0.5;
    }

    // Safe path - use BigInt for accumulation.
    let mut total_big = BigInt::from(0);
    for &pt in path {
        let sum = prev_pt.y + pt.y;
        let diff = prev_pt.x - pt.x;
        if is_safe_integer(sum) && is_safe_integer(diff) {
            total_big += f64_to_bigint(sum) * f64_to_bigint(diff);
        } else if is_safe_integer(prev_pt.y)
            && is_safe_integer(pt.y)
            && is_safe_integer(prev_pt.x)
            && is_safe_integer(pt.x)
        {
            let sum_big = f64_to_bigint(prev_pt.y) + f64_to_bigint(pt.y);
            let diff_big = f64_to_bigint(prev_pt.x) - f64_to_bigint(pt.x);
            total_big += sum_big * diff_big;
        } else {
            // Coordinates not safe integers - fall back to float.
            total_big += f64_to_bigint(math_round(sum * diff));
        }
        prev_pt = pt;
    }
    bigint_to_number(&total_big) * 0.5
}

/// TS: Core.ts:388-390 `crossProductD`.
pub fn cross_product_d(vec1: PointD, vec2: PointD) -> f64 {
    (vec1.y * vec2.x) - (vec2.y * vec1.x)
}

/// TS: Core.ts:392-394 `dotProductD`.
pub fn dot_product_d(vec1: PointD, vec2: PointD) -> f64 {
    (vec1.x * vec2.x) + (vec1.y * vec2.y)
}

/// TS: Core.ts:396-401 `roundToEven` (banker's rounding, matches C#
/// `MidpointRounding.ToEven`).
pub fn round_to_even(value: f64) -> f64 {
    let r = math_round(value);
    if value == r - 0.5 && (r as i64) % 2 != 0 {
        r - 1.0
    } else {
        r
    }
}

/// TS: Core.ts:403-406 `checkCastInt64`.
pub fn check_cast_int64(val: f64) -> f64 {
    if val >= *IC_MAX_COORD || val <= -*IC_MAX_COORD {
        return *IC_INVALID64;
    }
    math_round(val)
}

/// TS: Core.ts:412-447 `getLineIntersectPt`. Returns the intersection point
/// if non-parallel, or `None`. The point is constrained to `ln1a..ln1b`;
/// it may fall outside `ln2a..ln2b` even unconstrained.
pub fn get_line_intersect_pt(
    ln1a: Point64,
    ln1b: Point64,
    ln2a: Point64,
    ln2b: Point64,
) -> Option<Point64> {
    let dy1 = ln1b.y - ln1a.y;
    let dx1 = ln1b.x - ln1a.x;
    let dy2 = ln2b.y - ln2a.y;
    let dx2 = ln2b.x - ln2a.x;
    let det = safe_multiply_difference(dy1, dx2, dy2, dx1);

    if det == 0.0 {
        return None;
    }

    let t = safe_multiply_difference(ln1a.x - ln2a.x, dy2, ln1a.y - ln2a.y, dx2) / det;

    if t <= 0.0 {
        Some(Point64 {
            x: ln1a.x,
            y: ln1a.y,
            z: ln1a.z_or_zero(),
        })
    } else if t >= 1.0 {
        Some(Point64 {
            x: ln1b.x,
            y: ln1b.y,
            z: ln1b.z_or_zero(),
        })
    } else {
        // avoid rounding here, matching TS's comment; Math.trunc matches
        // Rust's `f64::trunc` (truncate toward zero) exactly.
        Some(Point64 {
            x: (ln1a.x + t * dx1).trunc(),
            y: (ln1a.y + t * dy1).trunc(),
            z: 0.0,
        })
    }
}

/// Result of [`get_line_intersect_pt_d`], mirroring TS's
/// `{ success: boolean; ip: PointD }` return shape (Core.ts:452).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LineIntersectResultD {
    pub success: bool,
    pub ip: PointD,
}

/// TS: Core.ts:449-479 `getLineIntersectPtD`.
pub fn get_line_intersect_pt_d(
    ln1a: PointD,
    ln1b: PointD,
    ln2a: PointD,
    ln2b: PointD,
) -> LineIntersectResultD {
    let dy1 = ln1b.y - ln1a.y;
    let dx1 = ln1b.x - ln1a.x;
    let dy2 = ln2b.y - ln2a.y;
    let dx2 = ln2b.x - ln2a.x;
    let det = dy1 * dx2 - dy2 * dx1;

    if det == 0.0 {
        return LineIntersectResultD {
            success: false,
            ip: PointD {
                x: 0.0,
                y: 0.0,
                z: 0.0,
            },
        };
    }

    let t = ((ln1a.x - ln2a.x) * dy2 - (ln1a.y - ln2a.y) * dx2) / det;

    let ip = if t <= 0.0 {
        PointD {
            x: ln1a.x,
            y: ln1a.y,
            z: 0.0,
        }
    } else if t >= 1.0 {
        PointD {
            x: ln1b.x,
            y: ln1b.y,
            z: 0.0,
        }
    } else {
        PointD {
            x: ln1a.x + t * dx1,
            y: ln1a.y + t * dy1,
            z: 0.0,
        }
    };

    LineIntersectResultD { success: true, ip }
}

/// TS: Core.ts:481-506 `segsIntersect`.
pub fn segs_intersect(
    seg1a: Point64,
    seg1b: Point64,
    seg2a: Point64,
    seg2b: Point64,
    inclusive: bool,
) -> bool {
    if !inclusive {
        let s1 = cross_product_sign(seg1a, seg2a, seg2b);
        let s2 = cross_product_sign(seg1b, seg2a, seg2b);
        let s3 = cross_product_sign(seg2a, seg1a, seg1b);
        let s4 = cross_product_sign(seg2b, seg1a, seg1b);
        return (s1 != 0 && s2 != 0 && s1 != s2) && (s3 != 0 && s4 != 0 && s3 != s4);
    }

    let res1 = cross_product_sign(seg1a, seg2a, seg2b);
    let res2 = cross_product_sign(seg1b, seg2a, seg2b);
    if res1 != 0 && res1 == res2 {
        return false;
    }
    let res3 = cross_product_sign(seg2a, seg1a, seg1b);
    let res4 = cross_product_sign(seg2b, seg1a, seg1b);
    if res3 != 0 && res3 == res4 {
        return false;
    }
    // ensure NOT collinear
    res1 != 0 || res2 != 0 || res3 != 0 || res4 != 0
}

/// TS: Core.ts:508-527 `icGetBounds` (`InternalClipper.getBounds`).
pub fn get_bounds(path: &[Point64]) -> Rect64 {
    if path.is_empty() {
        return Rect64 {
            left: 0.0,
            top: 0.0,
            right: 0.0,
            bottom: 0.0,
        };
    }

    let mut result = Rect64 {
        left: MAX_SAFE_INTEGER,
        top: MAX_SAFE_INTEGER,
        right: MIN_SAFE_INTEGER,
        bottom: MIN_SAFE_INTEGER,
    };

    for pt in path {
        if pt.x < result.left {
            result.left = pt.x;
        }
        if pt.x > result.right {
            result.right = pt.x;
        }
        if pt.y < result.top {
            result.top = pt.y;
        }
        if pt.y > result.bottom {
            result.bottom = pt.y;
        }
    }

    if result.left == MAX_SAFE_INTEGER {
        Rect64 {
            left: 0.0,
            top: 0.0,
            right: 0.0,
            bottom: 0.0,
        }
    } else {
        result
    }
}

/// TS: Core.ts:529-544 `getClosestPtOnSegment`.
pub fn get_closest_pt_on_segment(off_pt: Point64, seg1: Point64, seg2: Point64) -> Point64 {
    if seg1.x == seg2.x && seg1.y == seg2.y {
        return Point64 {
            x: seg1.x,
            y: seg1.y,
            z: 0.0,
        };
    }

    let dx = seg2.x - seg1.x;
    let dy = seg2.y - seg1.y;
    let q = safe_multiply_sum(off_pt.x - seg1.x, dx, off_pt.y - seg1.y, dy)
        / safe_multiply_sum(dx, dx, dy, dy);
    // `q.clamp(0.0, 1.0)` is behavior-identical to TS's `q < 0 ? 0 : (q > 1 ? 1 : q)`
    // for every `q` including NaN (both leave NaN unchanged; verified against Rust's
    // stdlib `clamp` semantics, which use the same `<`/`>` comparisons as TS).
    let q_clamped = q.clamp(0.0, 1.0);

    Point64 {
        x: math_round(seg1.x + q_clamped * dx),
        y: math_round(seg1.y + q_clamped * dy),
        z: 0.0,
    }
}

/// TS: Core.ts:546-613 `icPointInPolygon` (`InternalClipper.pointInPolygon`).
pub fn point_in_polygon(pt: Point64, polygon: &[Point64]) -> PointInPolygonResult {
    let len = polygon.len();
    let mut start: usize = 0;
    if len < 3 {
        return PointInPolygonResult::IsOutside;
    }

    while start < len && polygon[start].y == pt.y {
        start += 1;
    }
    if start == len {
        return PointInPolygonResult::IsOutside;
    }

    let mut is_above = polygon[start].y < pt.y;
    let starting_above = is_above;
    let mut val: i32 = 0;
    let mut i = start + 1;
    let mut end = len;

    loop {
        if i == end {
            if end == 0 || start == 0 {
                break;
            }
            end = start;
            i = 0;
        }

        if is_above {
            while i < end && polygon[i].y < pt.y {
                i += 1;
            }
        } else {
            while i < end && polygon[i].y > pt.y {
                i += 1;
            }
        }

        if i == end {
            continue;
        }

        let curr = polygon[i];
        let prev = if i > 0 {
            polygon[i - 1]
        } else {
            polygon[len - 1]
        };

        if curr.y == pt.y {
            if curr.x == pt.x || (curr.y == prev.y && ((pt.x < prev.x) != (pt.x < curr.x))) {
                return PointInPolygonResult::IsOn;
            }
            i += 1;
            if i == start {
                break;
            }
            continue;
        }

        if pt.x < curr.x && pt.x < prev.x {
            // only interested in edges crossing on the left
        } else if pt.x > prev.x && pt.x > curr.x {
            val = 1 - val;
        } else {
            let cps = cross_product_sign(prev, curr, pt);
            if cps == 0 {
                return PointInPolygonResult::IsOn;
            }
            if (cps < 0) == is_above {
                val = 1 - val;
            }
        }
        is_above = !is_above;
        i += 1;
    }

    if is_above == starting_above {
        return if val == 0 {
            PointInPolygonResult::IsOutside
        } else {
            PointInPolygonResult::IsInside
        };
    }

    if i == len {
        i = 0;
    }
    let cps = if i == 0 {
        cross_product_sign(polygon[len - 1], polygon[0], pt)
    } else {
        cross_product_sign(polygon[i - 1], polygon[i], pt)
    };
    if cps == 0 {
        return PointInPolygonResult::IsOn;
    }
    if (cps < 0) == is_above {
        val = 1 - val;
    }

    if val == 0 {
        PointInPolygonResult::IsOutside
    } else {
        PointInPolygonResult::IsInside
    }
}

/// TS: Core.ts:615-646 `path2ContainsPath1`.
pub fn path2_contains_path1(path1: &[Point64], path2: &[Point64]) -> bool {
    // we need to make some accommodation for rounding errors so we won't
    // jump if the first vertex is found outside
    let mut pip = PointInPolygonResult::IsOn;
    for &pt in path1 {
        match point_in_polygon(pt, path2) {
            PointInPolygonResult::IsOutside => {
                if pip == PointInPolygonResult::IsOutside {
                    return false;
                }
                pip = PointInPolygonResult::IsOutside;
            }
            PointInPolygonResult::IsInside => {
                if pip == PointInPolygonResult::IsInside {
                    return true;
                }
                pip = PointInPolygonResult::IsInside;
            }
            PointInPolygonResult::IsOn => {}
        }
    }
    // since path1's location is still equivocal, check its midpoint
    let mp = get_bounds(path1);
    let (mid_x, mid_y) = if is_safe_integer(mp.left)
        && is_safe_integer(mp.right)
        && mp.left.abs() + mp.right.abs() > MAX_SAFE_INTEGER
    {
        let mx = bigint_to_number(
            &((f64_to_bigint(mp.left) + f64_to_bigint(mp.right)) / BigInt::from(2)),
        );
        let my = bigint_to_number(
            &((f64_to_bigint(mp.top) + f64_to_bigint(mp.bottom)) / BigInt::from(2)),
        );
        (mx, my)
    } else {
        (
            math_round((mp.left + mp.right) / 2.0),
            math_round((mp.top + mp.bottom) / 2.0),
        )
    };
    let mid_pt = Point64 {
        x: mid_x,
        y: mid_y,
        z: 0.0,
    };
    point_in_polygon(mid_pt, path2) != PointInPolygonResult::IsOutside
}

/// TS: Core.ts:300-301 `Clipper.isPositive` (`area(poly) >= 0`), placed here
/// rather than a separate `Clipper.ts` port since it's a trivial one-line
/// wrapper over `InternalClipper.area` that the differential vector matrix
/// (R14) needs alongside `area`/`getBounds`.
pub fn is_positive(poly: &[Point64]) -> bool {
    area(poly) >= 0.0
}

// ---------------------------------------------------------------------------
// Point64Utils (Core.ts:695-745)
// ---------------------------------------------------------------------------

pub mod point64_utils {
    use super::*;

    /// TS: Core.ts:696-698 `Point64Utils.create`.
    pub fn create(x: f64, y: f64, z: f64) -> Point64 {
        Point64 {
            x: math_round(x),
            y: math_round(y),
            z,
        }
    }

    /// TS: Core.ts:700-704 `Point64Utils.fromPointD`.
    pub fn from_point_d(pt: PointD) -> Result<Point64, CoreError> {
        ensure_safe_integer(pt.x, "Point64Utils.fromPointD")?;
        ensure_safe_integer(pt.y, "Point64Utils.fromPointD")?;
        Ok(Point64 {
            x: math_round(pt.x),
            y: math_round(pt.y),
            z: pt.z_or_zero(),
        })
    }

    /// TS: Core.ts:706-712 `Point64Utils.scale`.
    pub fn scale(pt: Point64, scale: f64) -> Point64 {
        Point64 {
            x: math_round(pt.x * scale),
            y: math_round(pt.y * scale),
            z: pt.z_or_zero(),
        }
    }

    /// TS: Core.ts:714-716 `Point64Utils.equals`.
    pub fn equals(a: Point64, b: Point64) -> bool {
        a.x == b.x && a.y == b.y
    }

    /// TS: Core.ts:718-733 `Point64Utils.add`.
    pub fn add(a: Point64, b: Point64) -> Point64 {
        if is_safe_integer(a.x)
            && is_safe_integer(b.x)
            && is_safe_integer(a.y)
            && is_safe_integer(b.y)
        {
            let sum_x = a.x + b.x;
            let sum_y = a.y + b.y;
            if is_safe_integer(sum_x) && is_safe_integer(sum_y) {
                return Point64 {
                    x: sum_x,
                    y: sum_y,
                    z: 0.0,
                };
            }
            return Point64 {
                x: bigint_to_number(&(f64_to_bigint(a.x) + f64_to_bigint(b.x))),
                y: bigint_to_number(&(f64_to_bigint(a.y) + f64_to_bigint(b.y))),
                z: 0.0,
            };
        }
        Point64 {
            x: a.x + b.x,
            y: a.y + b.y,
            z: 0.0,
        }
    }

    /// TS: Core.ts:735-737 `Point64Utils.subtract`.
    pub fn subtract(a: Point64, b: Point64) -> Point64 {
        Point64 {
            x: a.x - b.x,
            y: a.y - b.y,
            z: 0.0,
        }
    }

    /// TS: Core.ts:739-744 `Point64Utils.toString`.
    pub fn to_string(pt: Point64) -> String {
        let mut xb = ryu_js::Buffer::new();
        let mut yb = ryu_js::Buffer::new();
        if pt.z != 0.0 {
            let mut zb = ryu_js::Buffer::new();
            format!(
                "{},{},{} ",
                xb.format(pt.x),
                yb.format(pt.y),
                zb.format(pt.z)
            )
        } else {
            format!("{},{} ", xb.format(pt.x), yb.format(pt.y))
        }
    }
}

// ---------------------------------------------------------------------------
// PointDUtils (Core.ts:748-777)
// ---------------------------------------------------------------------------

pub mod point_d_utils {
    use super::*;

    /// TS: Core.ts:749-751 `PointDUtils.create`.
    pub fn create(x: f64, y: f64, z: f64) -> PointD {
        PointD { x, y, z }
    }

    /// TS: Core.ts:753-755 `PointDUtils.fromPoint64`.
    pub fn from_point64(pt: Point64) -> PointD {
        PointD {
            x: pt.x,
            y: pt.y,
            z: pt.z_or_zero(),
        }
    }

    /// TS: Core.ts:757-759 `PointDUtils.scale`.
    pub fn scale(pt: PointD, scale: f64) -> PointD {
        PointD {
            x: pt.x * scale,
            y: pt.y * scale,
            z: pt.z_or_zero(),
        }
    }

    /// TS: Core.ts:761-764 `PointDUtils.equals`.
    pub fn equals(a: PointD, b: PointD) -> bool {
        is_almost_zero(a.x - b.x) && is_almost_zero(a.y - b.y)
    }

    /// TS: Core.ts:766-769 `PointDUtils.negate` (in-place in TS; returns the
    /// negated point here since Rust favors explicit mutation via `&mut`).
    pub fn negate(pt: &mut PointD) {
        pt.x = -pt.x;
        pt.y = -pt.y;
    }

    /// TS: Core.ts:771-776 `PointDUtils.toString`.
    pub fn to_string(pt: PointD, precision: usize) -> String {
        if pt.z != 0.0 {
            format!("{:.*},{:.*},{}", precision, pt.x, precision, pt.y, pt.z)
        } else {
            format!("{:.*},{:.*}", precision, pt.x, precision, pt.y)
        }
    }
}

// ---------------------------------------------------------------------------
// Rect64Utils (Core.ts:780-846)
// ---------------------------------------------------------------------------

pub mod rect64_utils {
    use super::*;

    /// TS: Core.ts:781-783 `Rect64Utils.create`.
    pub fn create(l: f64, t: f64, r: f64, b: f64) -> Rect64 {
        Rect64 {
            left: l,
            top: t,
            right: r,
            bottom: b,
        }
    }

    /// TS: Core.ts:785-792 `Rect64Utils.createInvalid`.
    pub fn create_invalid() -> Rect64 {
        Rect64 {
            left: MAX_SAFE_INTEGER,
            top: MAX_SAFE_INTEGER,
            right: MIN_SAFE_INTEGER,
            bottom: MIN_SAFE_INTEGER,
        }
    }

    /// TS: Core.ts:794-796 `Rect64Utils.width`.
    pub fn width(rect: Rect64) -> f64 {
        rect.right - rect.left
    }

    /// TS: Core.ts:798-800 `Rect64Utils.height`.
    pub fn height(rect: Rect64) -> f64 {
        rect.bottom - rect.top
    }

    /// TS: Core.ts:802-804 `Rect64Utils.isEmpty`.
    pub fn is_empty(rect: Rect64) -> bool {
        rect.bottom <= rect.top || rect.right <= rect.left
    }

    /// TS: Core.ts:806-808 `Rect64Utils.isValid`.
    pub fn is_valid(rect: Rect64) -> bool {
        rect.left < MAX_SAFE_INTEGER
    }

    /// TS: Core.ts:810-821 `Rect64Utils.midPoint`.
    pub fn mid_point(rect: Rect64) -> Point64 {
        if is_safe_integer(rect.left)
            && is_safe_integer(rect.right)
            && rect.left.abs() + rect.right.abs() > MAX_SAFE_INTEGER
        {
            let mid_x = bigint_to_number(
                &((f64_to_bigint(rect.left) + f64_to_bigint(rect.right)) / BigInt::from(2)),
            );
            let mid_y = bigint_to_number(
                &((f64_to_bigint(rect.top) + f64_to_bigint(rect.bottom)) / BigInt::from(2)),
            );
            return Point64 {
                x: mid_x,
                y: mid_y,
                z: 0.0,
            };
        }
        Point64 {
            x: math_round((rect.left + rect.right) / 2.0),
            y: math_round((rect.top + rect.bottom) / 2.0),
            z: 0.0,
        }
    }

    /// TS: Core.ts:823-826 `Rect64Utils.contains` (point).
    pub fn contains(rect: Rect64, pt: Point64) -> bool {
        pt.x > rect.left && pt.x < rect.right && pt.y > rect.top && pt.y < rect.bottom
    }

    /// TS: Core.ts:828-831 `Rect64Utils.containsRect`.
    pub fn contains_rect(rect: Rect64, rec: Rect64) -> bool {
        rec.left >= rect.left
            && rec.right <= rect.right
            && rec.top >= rect.top
            && rec.bottom <= rect.bottom
    }

    /// TS: Core.ts:833-836 `Rect64Utils.intersects`.
    pub fn intersects(rect: Rect64, rec: Rect64) -> bool {
        (math_max(rect.left, rec.left) <= math_min(rect.right, rec.right))
            && (math_max(rect.top, rec.top) <= math_min(rect.bottom, rec.bottom))
    }

    /// TS: Core.ts:838-845 `Rect64Utils.asPath`.
    pub fn as_path(rect: Rect64) -> Path64 {
        vec![
            Point64 {
                x: rect.left,
                y: rect.top,
                z: 0.0,
            },
            Point64 {
                x: rect.right,
                y: rect.top,
                z: 0.0,
            },
            Point64 {
                x: rect.right,
                y: rect.bottom,
                z: 0.0,
            },
            Point64 {
                x: rect.left,
                y: rect.bottom,
                z: 0.0,
            },
        ]
    }
}

// ---------------------------------------------------------------------------
// RectDUtils (Core.ts:849-905)
// ---------------------------------------------------------------------------

pub mod rect_d_utils {
    use super::*;

    /// TS: Core.ts:850-852 `RectDUtils.create`.
    pub fn create(l: f64, t: f64, r: f64, b: f64) -> RectD {
        RectD {
            left: l,
            top: t,
            right: r,
            bottom: b,
        }
    }

    /// TS: Core.ts:854-861 `RectDUtils.createInvalid`.
    pub fn create_invalid() -> RectD {
        RectD {
            left: f64::MAX,
            top: f64::MAX,
            right: -f64::MAX,
            bottom: -f64::MAX,
        }
    }

    /// TS: Core.ts:863-865 `RectDUtils.width`.
    pub fn width(rect: RectD) -> f64 {
        rect.right - rect.left
    }

    /// TS: Core.ts:867-869 `RectDUtils.height`.
    pub fn height(rect: RectD) -> f64 {
        rect.bottom - rect.top
    }

    /// TS: Core.ts:871-873 `RectDUtils.isEmpty`.
    pub fn is_empty(rect: RectD) -> bool {
        rect.bottom <= rect.top || rect.right <= rect.left
    }

    /// TS: Core.ts:875-880 `RectDUtils.midPoint`.
    pub fn mid_point(rect: RectD) -> PointD {
        PointD {
            x: (rect.left + rect.right) / 2.0,
            y: (rect.top + rect.bottom) / 2.0,
            z: 0.0,
        }
    }

    /// TS: Core.ts:882-885 `RectDUtils.contains` (point).
    pub fn contains(rect: RectD, pt: PointD) -> bool {
        pt.x > rect.left && pt.x < rect.right && pt.y > rect.top && pt.y < rect.bottom
    }

    /// TS: Core.ts:887-890 `RectDUtils.containsRect`.
    pub fn contains_rect(rect: RectD, rec: RectD) -> bool {
        rec.left >= rect.left
            && rec.right <= rect.right
            && rec.top >= rect.top
            && rec.bottom <= rect.bottom
    }

    /// TS: Core.ts:892-895 `RectDUtils.intersects`. Note the strict `<`
    /// (unlike `Rect64Utils.intersects`'s `<=`) — reproduced verbatim.
    pub fn intersects(rect: RectD, rec: RectD) -> bool {
        (math_max(rect.left, rec.left) < math_min(rect.right, rec.right))
            && (math_max(rect.top, rec.top) < math_min(rect.bottom, rec.bottom))
    }

    /// TS: Core.ts:897-904 `RectDUtils.asPath`.
    pub fn as_path(rect: RectD) -> PathD {
        vec![
            PointD {
                x: rect.left,
                y: rect.top,
                z: 0.0,
            },
            PointD {
                x: rect.right,
                y: rect.top,
                z: 0.0,
            },
            PointD {
                x: rect.right,
                y: rect.bottom,
                z: 0.0,
            },
            PointD {
                x: rect.left,
                y: rect.bottom,
                z: 0.0,
            },
        ]
    }
}

// ---------------------------------------------------------------------------
// PathUtils / PathsUtils (Core.ts:908-959)
// ---------------------------------------------------------------------------

pub mod path_utils {
    use super::*;

    /// TS: Core.ts:909-915 `PathUtils.toString64`.
    pub fn to_string64(path: &[Point64]) -> String {
        let mut result = String::new();
        for &pt in path {
            result.push_str(&point64_utils::to_string(pt));
        }
        result.push('\n');
        result
    }

    /// TS: Core.ts:917-924 `PathUtils.toStringD`.
    pub fn to_string_d(path: &[PointD], precision: usize) -> String {
        let mut result = String::new();
        for &pt in path {
            result.push_str(&point_d_utils::to_string(pt, precision));
            result.push_str(", ");
        }
        if !result.is_empty() {
            result.truncate(result.len() - 2);
        }
        result
    }

    /// TS: Core.ts:926-928 `PathUtils.reverse64`.
    pub fn reverse64(path: &[Point64]) -> Path64 {
        let mut out = path.to_vec();
        out.reverse();
        out
    }

    /// TS: Core.ts:930-932 `PathUtils.reverseD`.
    pub fn reverse_d(path: &[PointD]) -> PathD {
        let mut out = path.to_vec();
        out.reverse();
        out
    }
}

pub mod paths_utils {
    use super::*;

    /// TS: Core.ts:936-941 `PathsUtils.toString64`.
    pub fn to_string64(paths: &[Path64]) -> String {
        let mut result = String::new();
        for path in paths {
            result.push_str(&path_utils::to_string64(path));
        }
        result
    }

    /// TS: Core.ts:943-949 `PathsUtils.toStringD`.
    pub fn to_string_d(paths: &[PathD], precision: usize) -> String {
        let mut result = String::new();
        for path in paths {
            result.push_str(&path_utils::to_string_d(path, precision));
            result.push('\n');
        }
        result
    }

    /// TS: Core.ts:952-954 `PathsUtils.reverse64`.
    pub fn reverse64(paths: &[Path64]) -> Paths64 {
        paths.iter().map(|p| path_utils::reverse64(p)).collect()
    }

    /// TS: Core.ts:956-958 `PathsUtils.reverseD`.
    pub fn reverse_d(paths: &[PathD]) -> PathsD {
        paths.iter().map(|p| path_utils::reverse_d(p)).collect()
    }
}

// ---------------------------------------------------------------------------
// InvalidRect64 / InvalidRectD (Core.ts:962-963)
// ---------------------------------------------------------------------------

/// TS: Core.ts:962 `export const InvalidRect64 = Object.freeze(Rect64Utils.createInvalid());`.
pub fn invalid_rect64() -> Rect64 {
    rect64_utils::create_invalid()
}

/// TS: Core.ts:963 `export const InvalidRectD = Object.freeze(RectDUtils.createInvalid());`.
pub fn invalid_rect_d() -> RectD {
    rect_d_utils::create_invalid()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(x: f64, y: f64) -> Point64 {
        Point64::new(x, y, 0.0)
    }

    #[test]
    fn area_matches_shoelace_for_unit_square() {
        let square = vec![p(0.0, 0.0), p(10.0, 0.0), p(10.0, 10.0), p(0.0, 10.0)];
        assert_eq!(area(&square), 100.0);
        assert!(is_positive(&square));
    }

    #[test]
    fn area_of_reversed_square_is_negative() {
        let square = vec![p(0.0, 0.0), p(0.0, 10.0), p(10.0, 10.0), p(10.0, 0.0)];
        assert_eq!(area(&square), -100.0);
        assert!(!is_positive(&square));
    }

    #[test]
    fn area_below_three_points_is_zero() {
        assert_eq!(area(&[]), 0.0);
        assert_eq!(area(&[p(0.0, 0.0)]), 0.0);
        assert_eq!(area(&[p(0.0, 0.0), p(1.0, 1.0)]), 0.0);
    }

    #[test]
    fn math_round_matches_js_half_up_semantics() {
        assert_eq!(math_round(0.5), 1.0);
        assert_eq!(math_round(-0.5).to_bits(), (-0.0f64).to_bits());
        assert_eq!(math_round(-1.5), -1.0);
        assert_eq!(math_round(2.5), 3.0);
        assert_eq!(math_round(-2.5), -2.0);
    }

    #[test]
    fn round_to_even_matches_bankers_rounding() {
        assert_eq!(round_to_even(0.5), 0.0);
        assert_eq!(round_to_even(1.5), 2.0);
        assert_eq!(round_to_even(2.5), 2.0);
        assert_eq!(round_to_even(-0.5), 0.0);
    }

    #[test]
    fn cross_product_sign_matches_orientation() {
        let a = p(0.0, 0.0);
        let b = p(10.0, 0.0);
        let c = p(10.0, 10.0);
        assert_eq!(cross_product_sign(a, b, c), 1);
        assert_eq!(cross_product_sign(c, b, a), -1);
        assert_eq!(cross_product_sign(a, b, p(20.0, 0.0)), 0);
    }

    #[test]
    fn get_bounds_of_empty_path_is_zero_rect() {
        let r = get_bounds(&[]);
        assert_eq!(
            r,
            Rect64 {
                left: 0.0,
                top: 0.0,
                right: 0.0,
                bottom: 0.0
            }
        );
    }

    #[test]
    fn point64_utils_scale_and_create_round_trip() {
        let pt = point64_utils::create(1.4, 1.6, 0.0);
        assert_eq!(pt, p(1.0, 2.0));
        let scaled = point64_utils::scale(p(3.0, 5.0), 1000.0);
        assert_eq!(scaled, p(3000.0, 5000.0));
    }

    #[test]
    fn ensure_safe_integer_rejects_overflow_but_not_fractional_values() {
        // TS: Core.ts:179-183 `ensureSafeInteger` — despite its name, it only
        // checks finiteness and magnitude, NOT integer-ness. `1.5` is
        // accepted. Reproduced faithfully (see the function's doc comment).
        assert!(ensure_safe_integer(1.5, "ctx").is_ok());
        assert!(ensure_safe_integer(MAX_SAFE_INTEGER + 2.0, "ctx").is_err());
        assert!(ensure_safe_integer(f64::NAN, "ctx").is_err());
        assert!(ensure_safe_integer(f64::INFINITY, "ctx").is_err());
        assert!(ensure_safe_integer(42.0, "ctx").is_ok());
    }

    #[test]
    fn multiply_uint64_matches_expected_split() {
        let r = multiply_uint64(4294967296.0, 2.0); // 2^32 * 2 = 2^33
        assert_eq!(r.lo64, BigInt::from(0u64) + (BigInt::from(1u64) << 33));
        assert_eq!(r.hi64, BigInt::from(0));
    }

    #[test]
    fn path2_contains_path1_detects_nested_square() {
        let outer = vec![p(0.0, 0.0), p(100.0, 0.0), p(100.0, 100.0), p(0.0, 100.0)];
        let inner = vec![p(10.0, 10.0), p(20.0, 10.0), p(20.0, 20.0), p(10.0, 20.0)];
        assert!(path2_contains_path1(&inner, &outer));
        assert!(!path2_contains_path1(&outer, &inner));
    }
}
