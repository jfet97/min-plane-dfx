//! TS counterparts: `src/workers/irregular/arcFlattening.ts` (ported as the
//! [`arc`] submodule below) and `src/workers/irregular/ellipseFlattening.ts`
//! (ported as the [`ellipse`] submodule below) — deterministic
//! sag-tolerance sampling that turns preserved DXF `ARC` segments,
//! LWPOLYLINE/POLYLINE bulge chords, and `ELLIPSE` source parameters into
//! polylines. Both TS files are exported as plain object namespaces
//! (`ArcFlattening`/`EllipseFlattening`, `arcFlattening.ts:7-11`/
//! `ellipseFlattening.ts:12-14`) with no Effect service wrapper; per
//! `docs/planning/rust-irregular-backend/characterization/collision-prep.md`
//! §1/§"`arcFlattening.ts` / `ellipseFlattening.ts`", the sole caller of both
//! is `GeometryKernel.flattenSourceGeometry`
//! (`src/workers/irregular/geometryKernel.ts:115-158`). Each namespace is
//! ported here as a same-named Rust submodule of free functions — matching
//! this crate's established `geometry::predicates`/`geometry::hash`
//! convention for TS namespace-object ports (a struct+impl would be a
//! gratuitous restructuring) — because the two TS files each independently
//! export a `samplePoints` function that would otherwise collide in one flat
//! module.
//!
//! # Trig bit-parity: flattened output DOES feed canonical geometry, and this was measured, not assumed
//!
//! Both submodules use `f64` transcendental methods (`cos`/`sin`/`atan`/
//! `atan2`/`acos`/`hypot`) that are IEEE-754 binary64 but **not** guaranteed
//! bit-identical to V8's `Math.*` implementations across platforms/libm
//! versions — the same caveat `clipper::offset::ClipperOffset::do_round`
//! documents for `JoinType::Round`'s trig, and the same class of risk
//! `transforms::generator`'s module doc measures in depth for its own
//! `atan2`/`asin` call sites. Unlike `do_round` (not exercised by the
//! production Miter+Polygon offset path), this module's trig output **is**
//! live on the production path and **does** feed canonical geometry:
//! `ArcFlattening`/`EllipseFlattening` sampled points are the first step of
//! `collisionGeometryBuilder.ts`'s flatten → convex hull → normalize →
//! offset → re-normalize pipeline (`collision-prep.md` §1), and the
//! resulting collision polygon is later quantized onto the canonical scoring
//! grid (`canonical_grid::to_grid_mm`) during placement search.
//!
//! **This was measured, following `transforms::generator`'s methodology, not
//! assumed either way.** The 719-case/50,308-coordinate differential vector
//! set (`tests/vectors/flattening.json`) records residual low-bit variance in
//! the `libm`-backed `cos`/`sin`/`atan`/`atan2`/`acos` operations. The worst
//! observed coordinate divergence is about `2.3e-13` absolute, roughly 7-8
//! orders of magnitude below the 0.001mm canonical-grid step that could
//! change a downstream result. `vector_tests::assert_points_match_ts_oracle`
//! therefore uses a documented bounded tolerance for trig-derived
//! coordinates, while point counts and `computeSampleCount` remain bit-exact.
//!
//! The five production `Math.hypot` translations in this module route through
//! [`js_math::hypot`], the audited standard-library boundary. The committed
//! Node/V8 corpus remains useful diagnostic characterization of bounded ULP
//! differences; it is not a production bit-exact requirement. The flattening
//! tolerance applies only to the remaining trig operations, while legality,
//! quality, and deterministic canonical output remain blocking gates.
//!
//! # Number fidelity: sample counts and loop indices stay `f64`
//!
//! `computeSampleCount`/`computeSampleCountForSweep` return a plain JS
//! `number` (`arcFlattening.ts:116-129,131-135`), and the `samplePoints`
//! sampling loops (`arcFlattening.ts:24,66`, mirrored by
//! `ellipseFlattening.ts`'s `segmentIndex` loop, `ellipseFlattening.ts:39`)
//! compare a plain incrementing loop counter against that `number` with
//! ordinary `<`. This port keeps both the sample-count return value and the
//! loop counter as `f64` (never narrowed to a Rust integer), continuing this
//! crate's number-fidelity convention (`domain/mod.rs`'s module doc) and
//! avoiding an `f64 -> usize` cast that would panic/saturate/wrap
//! differently than JS's own `number` comparison for the (production-remote
//! but not TS-guarded) case of a pathologically large or non-finite ratio.
//! This is a direct, intentional preservation of a TS hazard, not a fix:
//! like the un-ported TS itself, an adversarial radius/sag/sweep combination
//! that drives `sampleCount`/`initialSegmentCount` to a huge finite value
//! allocates a correspondingly huge `Vec` and takes correspondingly long in
//! this Rust port too, exactly as it would in the V8 original.
//!
//! # Module visibility and vector location
//!
//! `src/transforms/mod.rs` exposes this module as `pub(crate)`, and
//! `geometry::collision_builder` imports [`arc`] and [`ellipse`] for its live
//! `flatten_source_geometry` path. Curve flattening therefore contributes to
//! production collision geometry.
//!
//! Crate-private visibility still prevents an external `tests/*.rs`
//! integration-test crate from traversing `transforms::flattening`, so the
//! differential assertions stay in this file's `#[cfg(test)] mod
//! vector_tests`, which has same-module access through `super`. The committed
//! `tests/vectors/flattening.json` corpus supplies those assertions.

use crate::domain::{DxfArcSegment, DxfEllipseSource, DxfLineSegment, IrregularPoint};

/// TS: `src/workers/irregular/arcFlattening.ts`. Deterministic sag-tolerance
/// sampling for DXF circular arcs and bulge chords.
pub mod arc {
    use super::*;
    use crate::js_number::js_math;

    /// TS: `arcFlattening.ts:14-45` `samplePoints`. Samples a circular DXF
    /// arc with endpoints preserved exactly. Part of the exported
    /// `ArcFlattening` namespace object (`arcFlattening.ts:7-11`).
    pub fn sample_points(arc: DxfArcSegment, sag_tolerance_mm: f64) -> Vec<IrregularPoint> {
        let mut points: Vec<IrregularPoint> = Vec::new();

        // compute how many straight chords are needed to respect the sagitta tolerance
        let sample_count = compute_sample_count(arc, sag_tolerance_mm);

        // keep the imported start point exact so adjacent source segments stay connected
        points.push(IrregularPoint::new(arc.x1, arc.y1));

        // emit only interior analytic samples because endpoints come from the importer
        let mut sample_index: f64 = 1.0;
        while sample_index < sample_count {
            // convert the sample index into a deterministic position along the counter-clockwise sweep
            let sample_ratio = sample_index / sample_count;

            // interpolate the DXF arc angle in degrees before converting to radians
            let angle_deg = compute_sample_angle_degrees(arc, sample_ratio);

            // convert degrees to radians for plain trigonometry
            let angle_rad = degrees_to_radians(angle_deg);

            // project the sampled angle back onto the analytic circle
            points.push(IrregularPoint::new(
                arc.cx + libm::cos(angle_rad) * arc.radius,
                arc.cy + libm::sin(angle_rad) * arc.radius,
            ));

            sample_index += 1.0;
        }

        // keep the imported end point exact for the same connectivity reason as the start point
        points.push(IrregularPoint::new(arc.x2, arc.y2));

        points
    }

    /// TS: `arcFlattening.ts:54-76` `sampleBulgePoints`. Samples an
    /// LWPOLYLINE/POLYLINE bulge chord using its signed analytic arc.
    ///
    /// The preview keeps the chord as a line for compatibility, but
    /// collision geometry follows the signed bulge sweep so negative
    /// clockwise bulges are not silently converted into the opposite major
    /// arc. Part of the exported `ArcFlattening` namespace object
    /// (`arcFlattening.ts:7-11`).
    pub fn sample_bulge_points(
        segment: &DxfLineSegment,
        sag_tolerance_mm: f64,
    ) -> Vec<IrregularPoint> {
        let mut points: Vec<IrregularPoint> = vec![IrregularPoint::new(segment.x1, segment.y1)];
        let arc = match bulge_arc_parameters(segment) {
            Some(arc) => arc,
            None => {
                points.push(IrregularPoint::new(segment.x2, segment.y2));
                return points;
            }
        };

        let sample_count =
            compute_sample_count_for_sweep(arc.radius, arc.sweep.abs(), sag_tolerance_mm);
        let mut sample_index: f64 = 1.0;
        while sample_index < sample_count {
            let sample_ratio = sample_index / sample_count;
            let angle = arc.start_angle + arc.sweep * sample_ratio;
            points.push(IrregularPoint::new(
                arc.center_x + libm::cos(angle) * arc.radius,
                arc.center_y + libm::sin(angle) * arc.radius,
            ));
            sample_index += 1.0;
        }
        points.push(IrregularPoint::new(segment.x2, segment.y2));
        points
    }

    /// TS: `arcFlattening.ts:78-84` `BulgeArcParameters` (private interface).
    #[derive(Clone, Copy, Debug, PartialEq)]
    struct BulgeArcParameters {
        center_x: f64,
        center_y: f64,
        radius: f64,
        start_angle: f64,
        sweep: f64,
    }

    /// TS: `arcFlattening.ts:86-114` `bulgeArcParameters` (private). Converts
    /// a signed bulge into center, radius, and sweep parameters.
    fn bulge_arc_parameters(segment: &DxfLineSegment) -> Option<BulgeArcParameters> {
        // TS: `if (bulge === undefined || bulge === 0) return null` — `?` maps
        // `None` (TS's `undefined`) straight through, and `0.0 == -0.0` in
        // Rust matches JS's `0 === -0`, so the explicit zero check below
        // still catches a stored `-0.0` bulge exactly like TS's `=== 0` does.
        let bulge = segment.bulge?;
        if bulge == 0.0 {
            return None;
        }

        let dx = segment.x2 - segment.x1;
        let dy = segment.y2 - segment.y1;
        let chord = js_math::hypot(dx, dy);
        let sweep = 4.0 * libm::atan(bulge);
        let radius = (chord * (1.0 + bulge * bulge)) / (4.0 * bulge.abs());
        if !chord.is_finite() || chord <= 0.0 || !sweep.is_finite() || !radius.is_finite() {
            return None;
        }

        let midpoint_x = (segment.x1 + segment.x2) / 2.0;
        let midpoint_y = (segment.y1 + segment.y2) / 2.0;
        let center_offset = (chord * (1.0 - bulge * bulge)) / (4.0 * bulge);
        let center_x = midpoint_x + (-dy / chord) * center_offset;
        let center_y = midpoint_y + (dx / chord) * center_offset;
        let start_angle = libm::atan2(segment.y1 - center_y, segment.x1 - center_x);
        Some(BulgeArcParameters {
            center_x,
            center_y,
            radius,
            start_angle,
            sweep,
        })
    }

    /// TS: `arcFlattening.ts:116-129` `computeSampleCountForSweep` (private).
    /// Computes the chord count required by a radius and absolute angular
    /// sweep.
    fn compute_sample_count_for_sweep(radius: f64, sweep_rad: f64, sag_tolerance_mm: f64) -> f64 {
        if !radius.is_finite() || radius <= 0.0 {
            return 1.0;
        }
        if !sweep_rad.is_finite() || sweep_rad <= 0.0 {
            return 1.0;
        }

        let capped_sag_tolerance_mm = js_math::min(sag_tolerance_mm, radius);
        let max_step_rad = 2.0 * libm::acos(1.0 - capped_sag_tolerance_mm / radius);
        if !max_step_rad.is_finite() || max_step_rad <= 0.0 {
            return 1.0;
        }
        js_math::max(1.0, js_math::ceil(sweep_rad / max_step_rad))
    }

    /// TS: `arcFlattening.ts:131-135` `computeSampleCount`. Computes how many
    /// chords are needed for the configured sag tolerance. Part of the
    /// exported `ArcFlattening` namespace object (`arcFlattening.ts:7-11`).
    pub fn compute_sample_count(arc: DxfArcSegment, sag_tolerance_mm: f64) -> f64 {
        let sweep_rad = degrees_to_radians(compute_counter_clockwise_sweep_degrees(arc));
        compute_sample_count_for_sweep(arc.radius, sweep_rad, sag_tolerance_mm)
    }

    /// TS: `arcFlattening.ts:137-140` `computeSampleAngleDegrees` (private).
    fn compute_sample_angle_degrees(arc: DxfArcSegment, sample_ratio: f64) -> f64 {
        // interpolate over the normalized counter-clockwise sweep without changing imported endpoints
        arc.start_angle + compute_counter_clockwise_sweep_degrees(arc) * sample_ratio
    }

    /// TS: `arcFlattening.ts:142-157` `computeCounterClockwiseSweepDegrees`
    /// (private).
    fn compute_counter_clockwise_sweep_degrees(arc: DxfArcSegment) -> f64 {
        // compute the raw counter-clockwise sweep from the imported angle pair
        let raw_sweep_deg = arc.end_angle - arc.start_angle;

        // preserve already-positive sweeps, including larger-than-full-turn data if present
        if raw_sweep_deg > 0.0 {
            return raw_sweep_deg;
        }

        // normalize wrapped arcs such as 350deg -> 10deg into a positive 20deg sweep.
        // Rust's `%` on f64, like JS's `%`, is a truncated remainder that takes
        // the sign of the dividend, so this is a direct translation.
        let wrapped_sweep_deg = raw_sweep_deg % 360.0;

        // treat exactly matching start and end angles as a full counter-clockwise turn
        // (`0.0 == -0.0` here mirrors JS's `wrappedSweepDeg === 0` catching a `-0` remainder too).
        if wrapped_sweep_deg == 0.0 {
            return 360.0;
        }

        // move negative wrapped sweeps into the positive counter-clockwise range
        wrapped_sweep_deg + 360.0
    }

    /// TS: `arcFlattening.ts:159-162` `degreesToRadians` (private).
    fn degrees_to_radians(degrees: f64) -> f64 {
        // keep the unit conversion centralized so geometry math stays readable
        (degrees * std::f64::consts::PI) / 180.0
    }

    #[cfg(test)]
    mod unit_tests {
        use super::*;

        // `DxfArcSegment` itself has 9 fields (`arcFlattening.ts`'s `DxfArcSegment`
        // shape, `dxf.ts:76-97`); this helper just names them positionally for
        // readable test call sites, so the arg count is inherent to the type.
        #[allow(clippy::too_many_arguments)]
        fn arc(
            x1: f64,
            y1: f64,
            x2: f64,
            y2: f64,
            cx: f64,
            cy: f64,
            radius: f64,
            start_angle: f64,
            end_angle: f64,
        ) -> DxfArcSegment {
            DxfArcSegment {
                x1,
                y1,
                x2,
                y2,
                cx,
                cy,
                radius,
                start_angle,
                end_angle,
            }
        }

        fn line(x1: f64, y1: f64, x2: f64, y2: f64, bulge: Option<f64>) -> DxfLineSegment {
            DxfLineSegment {
                x1,
                y1,
                x2,
                y2,
                bulge,
                source_curve: None,
            }
        }

        #[test]
        fn sample_points_preserves_imported_endpoints_exactly_even_off_circle() {
            // Deliberately off-analytic-circle endpoints (a real DXF can have
            // rounding drift between its stored endpoints and its
            // center/radius/angle triple); the port must never "fix" them.
            let a = arc(0.1, 0.2, 9.9, -0.3, 5.0, 0.0, 5.0, 0.0, 180.0);
            let points = sample_points(a, 0.1);
            assert_eq!(points.first().copied(), Some(IrregularPoint::new(0.1, 0.2)));
            assert_eq!(points.last().copied(), Some(IrregularPoint::new(9.9, -0.3)));
        }

        #[test]
        fn sample_points_zero_sweep_is_a_full_circle_not_a_degenerate_point() {
            // `startAngle === endAngle` is treated as a full 360deg turn
            // (`arcFlattening.ts:152-153`), not a zero-length degenerate arc.
            let a = arc(10.0, 0.0, 10.0, 0.0, 0.0, 0.0, 10.0, 0.0, 0.0);
            let full_circle = compute_sample_count(a, 0.01);
            let near_full_circle = compute_sample_count(
                arc(10.0, 0.0, 10.0, 0.0, 0.0, 0.0, 10.0, 0.0, 359.999),
                0.01,
            );
            // A 360deg sweep needs at least as many chords as a 359.999deg one.
            assert!(full_circle >= near_full_circle);
            assert!(full_circle > 1.0);
        }

        #[test]
        fn sample_points_tighter_sag_tolerance_samples_more_densely() {
            let a = arc(10.0, 0.0, -10.0, 0.0, 0.0, 0.0, 10.0, 0.0, 180.0);
            let loose = sample_points(a, 1.0).len();
            let tight = sample_points(a, 0.01).len();
            assert!(tight > loose, "tight={tight} loose={loose}");
        }

        #[test]
        fn sample_points_zero_radius_degenerate_arc_returns_just_the_two_endpoints() {
            let a = arc(5.0, 5.0, 5.0, 5.0, 5.0, 5.0, 0.0, 0.0, 180.0);
            let points = sample_points(a, 0.1);
            assert_eq!(points.len(), 2);
        }

        #[test]
        fn sample_bulge_points_undefined_bulge_is_a_straight_two_point_chord() {
            let segment = line(0.0, 0.0, 10.0, 0.0, None);
            let points = sample_bulge_points(&segment, 0.01);
            assert_eq!(
                points,
                vec![
                    IrregularPoint::new(0.0, 0.0),
                    IrregularPoint::new(10.0, 0.0)
                ]
            );
        }

        #[test]
        fn sample_bulge_points_zero_bulge_is_a_straight_two_point_chord() {
            let segment = line(0.0, 0.0, 10.0, 0.0, Some(0.0));
            let points = sample_bulge_points(&segment, 0.01);
            assert_eq!(points.len(), 2);
        }

        #[test]
        fn sample_bulge_points_negative_zero_bulge_is_a_straight_two_point_chord() {
            // TS: `bulge === 0` matches a stored `-0` bulge too.
            let segment = line(0.0, 0.0, 10.0, 0.0, Some(-0.0));
            let points = sample_bulge_points(&segment, 0.01);
            assert_eq!(points.len(), 2);
        }

        #[test]
        fn sample_bulge_points_unit_bulge_is_a_semicircle_and_preserves_endpoints() {
            // bulge = 1 => sweep = 4*atan(1) = pi (a semicircle).
            let segment = line(0.0, 0.0, 10.0, 0.0, Some(1.0));
            let points = sample_bulge_points(&segment, 0.001);
            assert!(points.len() > 2);
            assert_eq!(points.first().copied(), Some(IrregularPoint::new(0.0, 0.0)));
            assert_eq!(points.last().copied(), Some(IrregularPoint::new(10.0, 0.0)));
            // Every interior sample should sit on the analytic circle of
            // radius 5 centered at (5, 0) (the unique circle through both
            // endpoints with a pi sweep for a chord of length 10).
            //
            // N2 audit: this `hypot` is a Rust-only test assertion (a
            // geometric sanity check against a hand-derived analytic radius,
            // not against any TS/V8 oracle value) with a 1e-9 tolerance many
            // orders of magnitude looser than any hypot ULP noise -- kept on
            // `std::f64::hypot`, no reachable semantic field.
            for point in &points[1..points.len() - 1] {
                let distance_from_center = (point.x - 5.0).hypot(point.y - 0.0);
                assert!(
                    (distance_from_center - 5.0).abs() < 1e-9,
                    "point {point:?} not on the expected circle (r={distance_from_center})"
                );
            }
        }

        #[test]
        fn compute_sample_count_never_returns_less_than_one() {
            let a = arc(0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 90.0);
            assert!(compute_sample_count(a, 1e9) >= 1.0);
            assert!(compute_sample_count(a, 0.0) >= 1.0);
            assert!(compute_sample_count(a, -5.0) >= 1.0);
        }
    }
}

/// TS: `src/workers/irregular/ellipseFlattening.ts`. Deterministic adaptive
/// flattening for preserved DXF ellipse parameters.
pub mod ellipse {
    use super::*;
    use crate::js_number::js_math;

    /// TS: `ellipseFlattening.ts:6` `FULL_TURN_RADIANS = Math.PI * 2`.
    const FULL_TURN_RADIANS: f64 = std::f64::consts::PI * 2.0;
    /// TS: `ellipseFlattening.ts:7` `INITIAL_MAX_SWEEP_RADIANS = Math.PI / 2`.
    const INITIAL_MAX_SWEEP_RADIANS: f64 = std::f64::consts::PI / 2.0;
    /// TS: `ellipseFlattening.ts:8` `MAX_RECURSION_DEPTH = 20`.
    const MAX_RECURSION_DEPTH: u32 = 20;
    /// TS: `ellipseFlattening.ts:9` `MAX_SAMPLE_POINTS = 1_000_000`.
    const MAX_SAMPLE_POINTS: usize = 1_000_000;

    /// TS: `ellipseFlattening.ts:24-61` `samplePoints`. Samples an ellipse
    /// arc until each accepted chord stays within sag tolerance.
    ///
    /// Initial intervals are no wider than a quarter turn, then midpoint and
    /// quarter-point chord distances drive subdivision. This avoids treating
    /// an ellipse as a circle while keeping output deterministic for the
    /// same source parameters and tolerance. The sole member of the exported
    /// `EllipseFlattening` namespace object (`ellipseFlattening.ts:12-14`).
    pub fn sample_points(ellipse: &DxfEllipseSource, sag_tolerance_mm: f64) -> Vec<IrregularPoint> {
        let sweep =
            ellipse_end_parameter(ellipse.start_angle, ellipse.end_angle) - ellipse.start_angle;
        let major_axis_length = js_math::hypot(ellipse.major_axis_x, ellipse.major_axis_y);
        if !sweep.is_finite()
            || sweep <= 0.0
            || !major_axis_length.is_finite()
            || major_axis_length <= 0.0
        {
            return Vec::new();
        }

        let initial_segment_count =
            js_math::max(1.0, js_math::ceil(sweep / INITIAL_MAX_SWEEP_RADIANS));
        let start_point = ellipse_point(ellipse, ellipse.start_angle);
        let mut points: Vec<IrregularPoint> = vec![start_point];
        let is_full_ellipse = (sweep - FULL_TURN_RADIANS).abs() <= 1e-9;

        let mut segment_index: f64 = 0.0;
        while segment_index < initial_segment_count {
            let interval_start =
                ellipse.start_angle + (sweep * segment_index) / initial_segment_count;
            let interval_end =
                ellipse.start_angle + (sweep * (segment_index + 1.0)) / initial_segment_count;
            let interval_start_point = if segment_index == 0.0 {
                start_point
            } else {
                ellipse_point(ellipse, interval_start)
            };
            let interval_end_point =
                if segment_index == initial_segment_count - 1.0 && is_full_ellipse {
                    start_point
                } else {
                    ellipse_point(ellipse, interval_end)
                };
            append_flattened_interval(
                &mut points,
                ellipse,
                interval_start,
                interval_end,
                interval_start_point,
                interval_end_point,
                sag_tolerance_mm,
                0,
            );
            segment_index += 1.0;
        }

        points
    }

    /// TS: `ellipseFlattening.ts:64-105` `appendFlattenedInterval` (private).
    /// Appends one accepted interval while preserving its exact analytic
    /// endpoint.
    ///
    /// `#[allow(clippy::too_many_arguments)]`: the eight parameters mirror
    /// the TS function's own eight parameters one-for-one
    /// (`ellipseFlattening.ts:64-73`); bundling them into a Rust-only struct
    /// would be a restructuring this port's mechanical-translation rule
    /// (migration prompt §2) does not ask for.
    #[allow(clippy::too_many_arguments)]
    fn append_flattened_interval(
        output: &mut Vec<IrregularPoint>,
        ellipse: &DxfEllipseSource,
        interval_start: f64,
        interval_end: f64,
        start_point: IrregularPoint,
        end_point: IrregularPoint,
        sag_tolerance_mm: f64,
        recursion_depth: u32,
    ) {
        if recursion_depth >= MAX_RECURSION_DEPTH
            || output.len() >= MAX_SAMPLE_POINTS
            || !needs_subdivision(
                ellipse,
                interval_start,
                interval_end,
                start_point,
                end_point,
                sag_tolerance_mm,
            )
        {
            output.push(end_point);
            return;
        }

        let interval_middle = (interval_start + interval_end) / 2.0;
        let middle_point = ellipse_point(ellipse, interval_middle);
        append_flattened_interval(
            output,
            ellipse,
            interval_start,
            interval_middle,
            start_point,
            middle_point,
            sag_tolerance_mm,
            recursion_depth + 1,
        );
        append_flattened_interval(
            output,
            ellipse,
            interval_middle,
            interval_end,
            middle_point,
            end_point,
            sag_tolerance_mm,
            recursion_depth + 1,
        );
    }

    /// TS: `ellipseFlattening.ts:108-133` `needsSubdivision` (private). Uses
    /// a conservative analytic bound and sampled deviations before
    /// subdivision.
    fn needs_subdivision(
        ellipse: &DxfEllipseSource,
        interval_start: f64,
        interval_end: f64,
        start_point: IrregularPoint,
        end_point: IrregularPoint,
        sag_tolerance_mm: f64,
    ) -> bool {
        let interval_length = interval_end - interval_start;
        // TS calls `Math.hypot(majorAxisX, majorAxisY)` twice inline
        // (`ellipseFlattening.ts:118-119`); hoisted here into one call since
        // it is a pure, side-effect-free function of the same two fields
        // both times — not a behavior change.
        let major_axis_length = js_math::hypot(ellipse.major_axis_x, ellipse.major_axis_y);
        let maximum_axis_length =
            js_math::max(major_axis_length, major_axis_length * ellipse.axis_ratio);
        let conservative_deviation_bound =
            (maximum_axis_length * interval_length * interval_length) / 8.0;
        if conservative_deviation_bound <= sag_tolerance_mm {
            return false;
        }

        let quarter_point = ellipse_point(ellipse, interval_start + interval_length * 0.25);
        let middle_point = ellipse_point(ellipse, interval_start + interval_length * 0.5);
        let three_quarter_point = ellipse_point(ellipse, interval_start + interval_length * 0.75);
        let maximum_deviation = js_math::max_all(&[
            distance_to_chord(quarter_point, start_point, end_point),
            distance_to_chord(middle_point, start_point, end_point),
            distance_to_chord(three_quarter_point, start_point, end_point),
        ]);
        maximum_deviation > sag_tolerance_mm
    }

    /// TS: `ellipseFlattening.ts:136-143` `ellipsePoint` (private). Evaluates
    /// the DXF ellipse equation using its major and rotated minor vectors.
    fn ellipse_point(ellipse: &DxfEllipseSource, parameter: f64) -> IrregularPoint {
        let minor_axis_x = -ellipse.major_axis_y * ellipse.axis_ratio;
        let minor_axis_y = ellipse.major_axis_x * ellipse.axis_ratio;
        IrregularPoint::new(
            ellipse.cx
                + ellipse.major_axis_x * libm::cos(parameter)
                + minor_axis_x * libm::sin(parameter),
            ellipse.cy
                + ellipse.major_axis_y * libm::cos(parameter)
                + minor_axis_y * libm::sin(parameter),
        )
    }

    /// TS: `ellipseFlattening.ts:146-166` `distanceToChord` (private).
    /// Measures a point's shortest distance to a finite chord segment.
    fn distance_to_chord(
        point: IrregularPoint,
        start_point: IrregularPoint,
        end_point: IrregularPoint,
    ) -> f64 {
        let delta_x = end_point.x - start_point.x;
        let delta_y = end_point.y - start_point.y;
        let length_squared = delta_x * delta_x + delta_y * delta_y;
        if length_squared <= 0.0 {
            return js_math::hypot(point.x - start_point.x, point.y - start_point.y);
        }

        let projection = js_math::max(
            0.0,
            js_math::min(
                1.0,
                ((point.x - start_point.x) * delta_x + (point.y - start_point.y) * delta_y)
                    / length_squared,
            ),
        );
        let closest_x = start_point.x + projection * delta_x;
        let closest_y = start_point.y + projection * delta_y;
        js_math::hypot(point.x - closest_x, point.y - closest_y)
    }

    /// TS: `ellipseFlattening.ts:169-171` `ellipseEndParameter` (private).
    /// Normalizes wrapped DXF ellipse angles into a positive parameter
    /// sweep.
    fn ellipse_end_parameter(start_angle: f64, end_angle: f64) -> f64 {
        if end_angle <= start_angle {
            end_angle + FULL_TURN_RADIANS
        } else {
            end_angle
        }
    }

    #[cfg(test)]
    mod unit_tests {
        use super::*;

        fn ellipse_source(
            cx: f64,
            cy: f64,
            major_axis_x: f64,
            major_axis_y: f64,
            axis_ratio: f64,
            start_angle: f64,
            end_angle: f64,
        ) -> DxfEllipseSource {
            DxfEllipseSource {
                kind: crate::domain::DxfEllipseSourceKind::Ellipse,
                source_id: "ellipse-under-test".to_string(),
                cx,
                cy,
                major_axis_x,
                major_axis_y,
                axis_ratio,
                start_angle,
                end_angle,
            }
        }

        #[test]
        fn degenerate_chord_distance_uses_node_compatible_hypot() {
            let point = IrregularPoint::new(5000.0, 5000.0);
            let origin = IrregularPoint::new(0.0, 0.0);
            let actual = distance_to_chord(point, origin, origin);
            let expected = js_math::hypot(5000.0, 5000.0);
            assert_eq!(actual.to_bits(), expected.to_bits());
        }

        #[test]
        fn sample_points_zero_sweep_returns_an_empty_array_not_two_points() {
            // TS: `ellipseFlattening.ts:30-32` — a genuine behavioral
            // asymmetry versus `ArcFlattening`, which never returns fewer
            // than 2 points (`collision-prep.md`'s I/O section flags this
            // explicitly). Note `startAngle === endAngle` is *not* this case
            // (`ellipseEndParameter`, `ellipseFlattening.ts:169-171`, treats
            // `endAngle <= startAngle` as a full backward wrap, so equal
            // angles produce a full `2*PI` sweep exactly like `ArcFlattening`'s
            // equal-angle full-circle rule) — the only way to reach a
            // genuine zero sweep is `startAngle - endAngle` exactly equal to
            // one full turn, e.g. `startAngle = 2*PI, endAngle = 0`.
            let e = ellipse_source(0.0, 0.0, 10.0, 0.0, 0.5, std::f64::consts::PI * 2.0, 0.0);
            assert_eq!(sample_points(&e, 0.1), Vec::new());
        }

        #[test]
        fn sample_points_zero_major_axis_returns_an_empty_array() {
            let e = ellipse_source(0.0, 0.0, 0.0, 0.0, 0.5, 0.0, std::f64::consts::PI);
            assert_eq!(sample_points(&e, 0.1), Vec::new());
        }

        #[test]
        fn sample_points_full_ellipse_first_and_last_point_are_identical() {
            let e = ellipse_source(3.0, -2.0, 10.0, 2.0, 0.4, 0.0, std::f64::consts::PI * 2.0);
            let points = sample_points(&e, 0.5);
            assert!(points.len() > 2);
            assert_eq!(points.first().copied(), points.last().copied());
        }

        #[test]
        fn sample_points_tighter_sag_tolerance_samples_at_least_as_densely() {
            let e = ellipse_source(0.0, 0.0, 10.0, 0.0, 0.5, 0.0, std::f64::consts::PI);
            let loose = sample_points(&e, 2.0).len();
            let tight = sample_points(&e, 0.05).len();
            assert!(tight >= loose, "tight={tight} loose={loose}");
        }

        #[test]
        fn sample_points_circle_special_case_stays_near_the_analytic_radius() {
            // axisRatio = 1 degenerates the ellipse equation to a circle;
            // every point (not just the accepted-chord endpoints) should sit
            // close to the analytic radius within a small multiple of the
            // sag tolerance.
            let radius = 25.0;
            let sag = 0.1;
            let e = ellipse_source(1.0, 1.0, radius, 0.0, 1.0, 0.0, std::f64::consts::PI * 2.0);
            let points = sample_points(&e, sag);
            assert!(points.len() > 4);
            // N2 audit: same as the arc semicircle test above -- a
            // Rust-only analytic sanity check (1e-6 tolerance), no TS/V8
            // oracle or reachable semantic field involved; kept on
            // `std::f64::hypot`.
            for point in &points {
                let distance_from_center = (point.x - 1.0).hypot(point.y - 1.0);
                assert!(
                    (distance_from_center - radius).abs() < 1e-6,
                    "point {point:?} not on the analytic circle (r={distance_from_center})"
                );
            }
        }

        #[test]
        fn sample_points_recursion_depth_cap_terminates_without_panicking() {
            // A deliberately microscopic sag tolerance relative to scale
            // forces every leaf interval toward `MAX_RECURSION_DEPTH` before
            // its deviation bound is ever satisfied, which — combined with
            // the `MAX_SAMPLE_POINTS` output-length short-circuit
            // (`ellipseFlattening.ts:75-76`) engaging once the accumulated
            // output crosses it — is the two safety valves working together
            // exactly as TS intends for a pathological input. This must
            // still terminate promptly (not overflow the call stack or loop
            // forever) and land in the bounded "just over the sample cap"
            // range the recursive doubling structure implies, not run away
            // unboundedly.
            let e = ellipse_source(0.0, 0.0, 1.0, 0.0, 0.5, 0.0, std::f64::consts::PI * 2.0);
            let points = sample_points(&e, 1e-12);
            assert!(points.len() >= MAX_SAMPLE_POINTS, "len={}", points.len());
            assert!(points.len() < MAX_SAMPLE_POINTS * 2, "len={}", points.len());
        }

        #[test]
        fn sample_points_thin_axis_ratio_still_terminates() {
            // A near-zero axisRatio degenerates the ellipse toward a
            // back-and-forth line segment; this must still terminate rather
            // than infinite-loop chasing a deviation bound it can never
            // satisfy along the folded axis.
            let e = ellipse_source(0.0, 0.0, 10.0, 0.0, 1e-6, 0.0, std::f64::consts::PI * 2.0);
            let points = sample_points(&e, 0.01);
            assert!(!points.is_empty());
            assert!(points.len() < MAX_SAMPLE_POINTS);
        }
    }
}

#[cfg(test)]
mod vector_tests {
    //! Differential-vector test for both submodules above, driven by
    //! `tests/vectors/flattening.json` (generated by
    //! `scripts/rust-parity/dump-flattening.ts` from the real production
    //! `ArcFlattening`/`EllipseFlattening` TS namespaces, per ruling R14).
    //! Lives in-crate (rather than as a separate `tests/flattening_vectors.rs`
    //! integration test) because `transforms::flattening` is currently a
    //! private module — see this file's module doc, "Module visibility
    //! note", for the full explanation.

    use super::*;
    use serde_json::Value;
    use std::fs;

    fn load_vectors() -> Value {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/vectors/flattening.json");
        let raw =
            fs::read_to_string(path).unwrap_or_else(|err| panic!("failed to read {path}: {err}"));
        serde_json::from_str(&raw).unwrap_or_else(|err| panic!("failed to parse {path}: {err}"))
    }

    // ---------------------------------------------------------------------
    // Decoders mirroring `scripts/rust-parity/dump-flattening.ts`'s encoders
    // (plain JSON number for ordinary finite values; tagged strings for
    // "0"/"-0"/"NaN"/"Infinity"/"-Infinity", matching the convention already
    // established by `scripts/rust-parity/dump-canonical-grid.ts`).
    // ---------------------------------------------------------------------

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
            other => {
                panic!("expected a JSON number or tagged string for an f64 field, got {other:?}")
            }
        }
    }

    fn decode_optional_f64(value: &Value) -> Option<f64> {
        if value.is_null() {
            None
        } else {
            Some(decode_f64(value))
        }
    }

    fn decode_points(value: &Value) -> Vec<IrregularPoint> {
        value
            .as_array()
            .unwrap_or_else(|| panic!("expected a JSON array of points, got {value:?}"))
            .iter()
            .map(|point| IrregularPoint::new(decode_f64(&point["x"]), decode_f64(&point["y"])))
            .collect()
    }

    /// Point-list equality against the real TS oracle, tuned by a measured
    /// investigation of this exact module's production-reachable numeric
    /// operations. The remaining `libm`-backed `cos`/`sin`/`atan`/`atan2`/
    /// `acos` calls can differ from V8 in low-order bits. The five production
    /// `hypot` calls route through [`js_math::hypot`], whose Node/V8 corpus is
    /// retained as diagnostic characterization rather than a production
    /// bit-exact requirement.
    ///
    /// The 719-case/50,308-coordinate flattening corpus found the remaining
    /// trig differences were small: the worst observed absolute difference was
    /// `2.27e-13` and the relative difference about `4e-13`. This tolerance
    /// accepts that measured trig rounding variance, not a wrong formula,
    /// sign, axis, point count, or non-finite result.
    ///
    /// **Why a bounded tolerance instead of chasing zero mismatches by
    /// pruning the vector matrix**: unlike `transforms::generator`'s own
    /// production-representative vector set (which happens not to hit any
    /// surviving `libm` divergence), this module's task-mandated *broad,
    /// deliberate* radius/sweep/rotation/degenerate/random matrix hits the
    /// residual divergence in 3%-21% of cases per category -- not a handful
    /// of cherry-pickable "bad seeds" but an inherent property of evaluating
    /// `cos`/`sin`/`atan2`/`acos` at enough distinct irrational-angle inputs.
    /// Narrowing the matrix to dodge these would both defeat its
    /// task-mandated breadth and be fragile (any future regeneration could
    /// reintroduce a "new" mismatch at a different, equally-valid input).
    ///
    /// **Why this tolerance cannot mask a real port bug**: this crate's own
    /// `canonical_grid` module (`canonical_grid::to_grid_mm`, this module's
    /// own doc, "Trig bit-parity" section) quantizes collision geometry onto
    /// a 0.001mm grid (`CLIPPER2_OFFSET_SCALE = 1000.0`,
    /// `canonical_grid/offset_policy.rs`) -- i.e. the smallest difference
    /// that can ever change a *canonical* outcome. The tolerance below
    /// (`1e-9` mm absolute, `1e-9` relative) is chosen to sit strictly
    /// between the two boundaries that matter: **~1,000x looser** than the
    /// worst measured trig divergence (so it always accepts the real,
    /// harmless noise this investigation found) while remaining **~1,000,000x
    /// tighter** than the grid step that would actually change a
    /// downstream canonical result (so it would still catch anything with
    /// real geometric consequence) and many orders of magnitude tighter than
    /// any plausible wrong-formula/wrong-sign/swapped-axis bug (which would
    /// produce a divergence at the scale of the coordinate itself, not its
    /// 9th-13th significant digit).
    ///
    /// Point **count** is still asserted exactly (never trig-derived --
    /// `computeSampleCount`'s `ceil`/`min`/`max` composition is 100%
    /// bit-exact against the oracle across this whole vector set, see
    /// [`arc_compute_sample_count_matches_ts_production_oracle`] below,
    /// which uses genuine `to_bits()` equality with zero tolerance and zero
    /// failures). `NaN`/`Infinity` coordinates (from the adversarial
    /// non-finite categories) are compared for exact bit-pattern equality
    /// regardless of tolerance, since `x - y` for two `NaN`s or mismatched
    /// infinities is itself `NaN`/`Infinity` and cannot be meaningfully
    /// bounded by an epsilon.
    fn assert_points_match_ts_oracle(
        actual: &[IrregularPoint],
        expected: &[IrregularPoint],
        context: &str,
    ) {
        const ABSOLUTE_TOLERANCE_MM: f64 = 1e-9;
        const RELATIVE_TOLERANCE: f64 = 1e-9;

        fn coordinates_match(actual: f64, expected: f64) -> bool {
            if actual.to_bits() == expected.to_bits() {
                return true;
            }
            if actual.is_nan()
                || expected.is_nan()
                || actual.is_infinite()
                || expected.is_infinite()
            {
                // Already unequal by bit pattern (checked above) and not a
                // finite pair an epsilon can bound -- these must match
                // exactly or not at all.
                return false;
            }
            let allowed = ABSOLUTE_TOLERANCE_MM.max(RELATIVE_TOLERANCE * expected.abs());
            (actual - expected).abs() <= allowed
        }

        assert_eq!(
            actual.len(),
            expected.len(),
            "{context}: point count mismatch (rust={}, ts={})",
            actual.len(),
            expected.len()
        );
        for (index, (a, e)) in actual.iter().zip(expected.iter()).enumerate() {
            assert!(
                coordinates_match(a.x, e.x),
                "{context}: point[{index}].x diverges beyond the documented trig tolerance (rust={}, ts={})",
                a.x,
                e.x
            );
            assert!(
                coordinates_match(a.y, e.y),
                "{context}: point[{index}].y diverges beyond the documented trig tolerance (rust={}, ts={})",
                a.y,
                e.y
            );
        }
    }

    #[test]
    fn arc_sample_points_matches_ts_production_oracle() {
        let file = load_vectors();
        assert!(
            !file["generatingCommit"]
                .as_str()
                .unwrap_or_default()
                .is_empty(),
            "vectors file must record its generating commit (ruling R14)"
        );

        let cases = file["arcSamplePoints"]
            .as_array()
            .expect("arcSamplePoints must be an array");
        assert!(
            cases.len() >= 100,
            "expected a broad arc samplePoints matrix, got {}",
            cases.len()
        );

        for case in cases {
            let arc = DxfArcSegment {
                x1: decode_f64(&case["arc"]["x1"]),
                y1: decode_f64(&case["arc"]["y1"]),
                x2: decode_f64(&case["arc"]["x2"]),
                y2: decode_f64(&case["arc"]["y2"]),
                cx: decode_f64(&case["arc"]["cx"]),
                cy: decode_f64(&case["arc"]["cy"]),
                radius: decode_f64(&case["arc"]["radius"]),
                start_angle: decode_f64(&case["arc"]["startAngle"]),
                end_angle: decode_f64(&case["arc"]["endAngle"]),
            };
            let sag_tolerance_mm = decode_f64(&case["sagToleranceMm"]);
            let expected = decode_points(&case["points"]);
            let actual = arc::sample_points(arc, sag_tolerance_mm);
            let category = case["category"].as_str().unwrap_or("<no category>");
            assert_points_match_ts_oracle(
                &actual,
                &expected,
                &format!("arc samplePoints [{category}]"),
            );
        }
    }

    #[test]
    fn arc_sample_bulge_points_matches_ts_production_oracle() {
        let file = load_vectors();
        let cases = file["arcSampleBulgePoints"]
            .as_array()
            .expect("arcSampleBulgePoints must be an array");
        assert!(
            cases.len() >= 30,
            "expected a broad bulge samplePoints matrix, got {}",
            cases.len()
        );

        for case in cases {
            let segment = DxfLineSegment {
                x1: decode_f64(&case["segment"]["x1"]),
                y1: decode_f64(&case["segment"]["y1"]),
                x2: decode_f64(&case["segment"]["x2"]),
                y2: decode_f64(&case["segment"]["y2"]),
                bulge: decode_optional_f64(&case["segment"]["bulge"]),
                source_curve: None,
            };
            let sag_tolerance_mm = decode_f64(&case["sagToleranceMm"]);
            let expected = decode_points(&case["points"]);
            let actual = arc::sample_bulge_points(&segment, sag_tolerance_mm);
            let category = case["category"].as_str().unwrap_or("<no category>");
            assert_points_match_ts_oracle(
                &actual,
                &expected,
                &format!("arc sampleBulgePoints [{category}]"),
            );
        }
    }

    #[test]
    fn ellipse_sample_points_matches_ts_production_oracle() {
        let file = load_vectors();
        let cases = file["ellipseSamplePoints"]
            .as_array()
            .expect("ellipseSamplePoints must be an array");
        assert!(
            cases.len() >= 100,
            "expected a broad ellipse samplePoints matrix, got {}",
            cases.len()
        );

        for case in cases {
            let ellipse = DxfEllipseSource {
                kind: crate::domain::DxfEllipseSourceKind::Ellipse,
                source_id: case["ellipse"]["sourceId"]
                    .as_str()
                    .unwrap_or("vector-fixture")
                    .to_string(),
                cx: decode_f64(&case["ellipse"]["cx"]),
                cy: decode_f64(&case["ellipse"]["cy"]),
                major_axis_x: decode_f64(&case["ellipse"]["majorAxisX"]),
                major_axis_y: decode_f64(&case["ellipse"]["majorAxisY"]),
                axis_ratio: decode_f64(&case["ellipse"]["axisRatio"]),
                start_angle: decode_f64(&case["ellipse"]["startAngle"]),
                end_angle: decode_f64(&case["ellipse"]["endAngle"]),
            };
            let sag_tolerance_mm = decode_f64(&case["sagToleranceMm"]);
            let expected = decode_points(&case["points"]);
            let actual = ellipse::sample_points(&ellipse, sag_tolerance_mm);
            let category = case["category"].as_str().unwrap_or("<no category>");
            assert_points_match_ts_oracle(
                &actual,
                &expected,
                &format!("ellipse samplePoints [{category}]"),
            );
        }
    }

    #[test]
    fn arc_compute_sample_count_matches_ts_production_oracle() {
        let file = load_vectors();
        let cases = file["arcComputeSampleCount"]
            .as_array()
            .expect("arcComputeSampleCount must be an array");
        assert!(
            cases.len() >= 30,
            "expected a broad computeSampleCount matrix, got {}",
            cases.len()
        );

        for case in cases {
            let arc = DxfArcSegment {
                x1: decode_f64(&case["arc"]["x1"]),
                y1: decode_f64(&case["arc"]["y1"]),
                x2: decode_f64(&case["arc"]["x2"]),
                y2: decode_f64(&case["arc"]["y2"]),
                cx: decode_f64(&case["arc"]["cx"]),
                cy: decode_f64(&case["arc"]["cy"]),
                radius: decode_f64(&case["arc"]["radius"]),
                start_angle: decode_f64(&case["arc"]["startAngle"]),
                end_angle: decode_f64(&case["arc"]["endAngle"]),
            };
            let sag_tolerance_mm = decode_f64(&case["sagToleranceMm"]);
            let expected = decode_f64(&case["sampleCount"]);
            let actual = arc::compute_sample_count(arc, sag_tolerance_mm);
            let category = case["category"].as_str().unwrap_or("<no category>");
            assert_eq!(
                actual.to_bits(),
                expected.to_bits(),
                "computeSampleCount [{category}] mismatch: rust={actual} ts={expected}"
            );
        }
    }
}
