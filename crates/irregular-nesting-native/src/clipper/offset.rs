/*
Copyright: Angus Johnson 2010-2025
License: https://www.boost.org/LICENSE_1_0.txt
Complete license text: ../../LICENSES/clipper2-ts-BSL-1.0.txt
*/

//! Vendor-translated port of `clipper2-ts@2.0.1-18`'s `src/Offset.ts` - path
//! offset (inflate/shrink) — per ruling R10
//! (`docs/planning/rust-irregular-backend/stage0-rulings.md`).
//!
//! This is a mechanical, line-by-line translation of the whole file. The
//! production app (per `docs/planning/rust-irregular-backend/characterization/collision-prep.md`)
//! only ever exercises `JoinType::Miter` + `EndType::Polygon`, but every
//! join/end type is translated faithfully since the migration prompt §8.3
//! requires reproducing `clipper2-ts`'s operations "exactly", not just the
//! reachable subset.
//!
//! The final self-intersection cleanup (`executeInternal`'s `Clipper64`
//! union, Offset.ts:192-203) is wired to the real boolean-clip engine
//! (`super::engine`, a port of `Engine.ts`) from [`ClipperOffset::execute`]/
//! [`ClipperOffset::execute_tree`] — see those methods' doc comments.

use super::core::{
    self, cross_product_d, dot_product_d, is_almost_zero, math_round, point64_utils, Path64, PathD,
    Paths64, Point64, PointD,
};
use super::engine;

/// TS: Offset.ts:17-22 `enum JoinType`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(i32)]
pub enum JoinType {
    Miter = 0,
    Square = 1,
    Bevel = 2,
    Round = 3,
}

/// TS: Offset.ts:24-30 `enum EndType`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(i32)]
pub enum EndType {
    Polygon = 0,
    Joined = 1,
    Butt = 2,
    Square = 3,
    Round = 4,
}

/// Typed replacement for anything Offset.ts reaches by throwing (transitively,
/// through `Point64Utils.fromPointD`'s `ensureSafeInteger` guard).
#[derive(Debug, Clone, PartialEq)]
pub enum ClipperError {
    /// A `core::CoreError` propagated from a Core.ts guard function reached
    /// transitively (e.g. `Point64Utils.fromPointD` inside `doSquare`).
    Core(core::CoreError),
}

impl From<core::CoreError> for ClipperError {
    fn from(e: core::CoreError) -> Self {
        ClipperError::Core(e)
    }
}

/// TS: Offset.ts:32-61 `class Group`.
#[derive(Debug, Clone)]
pub struct Group {
    pub in_paths: Paths64,
    pub join_type: JoinType,
    pub end_type: EndType,
    pub paths_reversed: bool,
    /// `-1` sentinel matches TS's `lowestPathIdx: number` initialized to `-1`.
    pub lowest_path_idx: i64,
}

impl Group {
    /// TS: Offset.ts:39-60 `Group` constructor.
    pub fn new(paths: &Paths64, join_type: JoinType, end_type: EndType) -> Self {
        let is_joined = end_type == EndType::Polygon || end_type == EndType::Joined;
        let mut in_paths: Paths64 = Vec::with_capacity(paths.len());
        for path in paths {
            in_paths.push(ClipperOffset::strip_duplicates(path, is_joined));
        }

        let (lowest_path_idx, paths_reversed) = if end_type == EndType::Polygon {
            let info = ClipperOffset::get_lowest_path_info(&in_paths);
            let paths_reversed = info.idx >= 0 && info.is_neg_area;
            (info.idx, paths_reversed)
        } else {
            (-1, false)
        };

        Group {
            in_paths,
            join_type,
            end_type,
            paths_reversed,
            lowest_path_idx,
        }
    }
}

/// TS: Offset.ts:242-262 `getLowestPathInfo`'s `{ idx: number; isNegArea: boolean }` return shape.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LowestPathInfo {
    pub idx: i64,
    pub is_neg_area: bool,
}

/// Delta-callback signature. TS: Offset.ts:102
/// `((path: Path64, pathNorms: PathD, currPt: number, prevPt: number) => number) | null`.
pub type DeltaCallback = Box<dyn Fn(&Path64, &PathD, usize, usize) -> f64>;

/// Z-callback signature. TS: Offset.ts:100
/// `(bot1, top1, bot2, top2, intersectPt) => void`; `intersectPt` is mutated
/// in place by the JS callback.
pub type ZCallback = Box<dyn Fn(Point64, Point64, Point64, Point64, &mut Point64)>;

/// TS: `ClipperOffset.ZCB` (Offset.ts:122-134), the private arrow-function field
/// `executeInternal` installs on the internal `Clipper64` as `c.zCallback` (Offset.ts:196)
/// — always installed, regardless of whether the caller ever set `this.zCallback`. Pure
/// core extracted to a free function (taking the raw user callback explicitly instead of
/// reading `self.zCallback`) so [`ClipperOffset::execute`] can move an owned
/// `Option<ZCallback>` into a `'static` closure handed to the engine without borrowing
/// `self` — see that method's doc comment.
fn zcb_apply(
    bot1: Point64,
    top1: Point64,
    bot2: Point64,
    top2: Point64,
    intersect_pt: &mut Point64,
    z_callback: Option<&ZCallback>,
) {
    if bot1.z_or_zero() != 0.0 && (bot1.z == bot2.z || bot1.z == top2.z) {
        intersect_pt.z = bot1.z;
    } else if bot2.z_or_zero() != 0.0 && bot2.z == top1.z {
        intersect_pt.z = bot2.z;
    } else if top1.z_or_zero() != 0.0 && top1.z == top2.z {
        intersect_pt.z = top1.z;
    } else if let Some(cb) = z_callback {
        cb(bot1, top1, bot2, top2, intersect_pt);
    }
}

/// TS: Offset.ts:63-737 `class ClipperOffset`.
pub struct ClipperOffset {
    group_list: Vec<Group>,
    path_out: Path64,
    normals: PathD,
    solution: Paths64,
    /// TS: `solutionTree: PolyTree64 | null` (Offset.ts:82). Tracks which
    /// `execute*` overload the caller used ([`ClipperOffset::execute`] vs.
    /// [`ClipperOffset::execute_tree`]); the real `engine::PolyTree64` output
    /// itself is built (and immediately flattened back to `Paths64` via
    /// `engine::poly_tree_to_paths64`) inside [`ClipperOffset::execute_tree`]
    /// — see that method's doc comment for why this crate's `execute_tree`
    /// still returns `Paths64` rather than exposing the raw tree.
    solution_tree_requested: bool,

    group_delta: f64,
    delta: f64,
    mit_lim_sqr: f64,
    steps_per_rad: f64,
    step_sin: f64,
    step_cos: f64,
    join_type: JoinType,
    end_type: EndType,

    pub arc_tolerance: f64,
    pub merge_groups: bool,
    pub miter_limit: f64,
    pub preserve_collinear: bool,
    pub reverse_solution: bool,
    pub z_callback: Option<ZCallback>,
    pub delta_callback: Option<DeltaCallback>,
}

/// TS: Offset.ts:64 `private static readonly Tolerance = 1.0E-12;`.
const TOLERANCE: f64 = 1.0e-12;

/// TS: Offset.ts:78 `private static readonly arc_const = 0.002; // <-- 1/500`.
const ARC_CONST: f64 = 0.002;

impl Default for ClipperOffset {
    fn default() -> Self {
        Self::new(2.0, 0.0, false, false)
    }
}

impl ClipperOffset {
    /// TS: Offset.ts:104-115 constructor.
    pub fn new(
        miter_limit: f64,
        arc_tolerance: f64,
        preserve_collinear: bool,
        reverse_solution: bool,
    ) -> Self {
        ClipperOffset {
            group_list: Vec::new(),
            path_out: Vec::new(),
            normals: Vec::new(),
            solution: Vec::new(),
            solution_tree_requested: false,
            group_delta: 0.0,
            delta: 0.0,
            mit_lim_sqr: 0.0,
            steps_per_rad: 0.0,
            step_sin: 0.0,
            step_cos: 0.0,
            join_type: JoinType::Bevel,
            end_type: EndType::Polygon,
            arc_tolerance,
            merge_groups: true,
            miter_limit,
            preserve_collinear,
            reverse_solution,
            z_callback: None,
            delta_callback: None,
        }
    }

    /// TS: Offset.ts:117-119 `clear`.
    pub fn clear(&mut self) {
        self.group_list.clear();
    }

    /// TS: Offset.ts:122-134 `ZCB` (internal Z callback wrapping default Z
    /// handling before calling the user callback). Delegates to
    /// [`zcb_apply`], which takes the raw user callback explicitly rather
    /// than borrowing `self` — see [`ClipperOffset::execute`], which installs
    /// [`zcb_apply`] on the engine's `'static`-bound `ZCallback64` and so
    /// cannot borrow `self` for the duration of the callback.
    pub fn zcb(
        &self,
        bot1: Point64,
        top1: Point64,
        bot2: Point64,
        top2: Point64,
        intersect_pt: &mut Point64,
    ) {
        zcb_apply(
            bot1,
            top1,
            bot2,
            top2,
            intersect_pt,
            self.z_callback.as_ref(),
        );
    }

    /// TS: Offset.ts:136-140 `addPath`.
    pub fn add_path(&mut self, path: &Path64, join_type: JoinType, end_type: EndType) {
        if path.is_empty() {
            return;
        }
        self.add_paths(std::slice::from_ref(path), join_type, end_type);
    }

    /// TS: Offset.ts:142-145 `addPaths`.
    pub fn add_paths(&mut self, paths: &[Path64], join_type: JoinType, end_type: EndType) {
        if paths.is_empty() {
            return;
        }
        self.group_list
            .push(Group::new(&paths.to_vec(), join_type, end_type));
    }

    /// TS: Offset.ts:147-153 `calcSolutionCapacity`.
    pub fn calc_solution_capacity(&self) -> usize {
        let mut result = 0usize;
        for g in &self.group_list {
            result += if g.end_type == EndType::Joined {
                g.in_paths.len() * 2
            } else {
                g.in_paths.len()
            };
        }
        result
    }

    /// TS: Offset.ts:155-164 `checkPathsReversed`.
    pub fn check_paths_reversed(&self) -> bool {
        let mut result = false;
        for g in &self.group_list {
            if g.end_type == EndType::Polygon {
                result = g.paths_reversed;
                break;
            }
        }
        result
    }

    /// TS: Offset.ts:166-186 (the pre-cleanup portion of `executeInternal`,
    /// i.e. everything up to but not including the `Clipper64` union). This
    /// is the primary directly-testable surface of this module: it exercises
    /// the entire per-group offset geometry pipeline (`doGroupOffset` and
    /// everything it calls — `buildNormals`, `offsetPolygon`/`offsetOpenPath`/
    /// `offsetOpenJoined`, `offsetPoint`, `doMiter`/`doSquare`/`doBevel`/`doRound`)
    /// without requiring the boolean-clip engine.
    pub fn execute_pre_cleanup(&mut self, delta: f64) -> Result<Paths64, ClipperError> {
        self.solution = Vec::new();
        if self.group_list.is_empty() {
            return Ok(self.solution.clone());
        }

        // make sure the offset delta is significant
        if delta.abs() < 0.5 {
            for group in &self.group_list {
                for path in &group.in_paths {
                    self.solution.push(path.clone());
                }
            }
            return Ok(self.solution.clone());
        }

        self.delta = delta;
        self.mit_lim_sqr = if self.miter_limit <= 1.0 {
            2.0
        } else {
            2.0 / Self::sqr(self.miter_limit)
        };

        let group_count = self.group_list.len();
        for i in 0..group_count {
            let group = self.group_list[i].clone();
            self.do_group_offset(&group)?;
        }

        Ok(self.solution.clone())
    }

    /// TS: Offset.ts:206-223 `execute` (the `Paths64` overload). Runs the pre-cleanup
    /// pipeline, then (for a significant delta) hands off to the boolean-clip engine
    /// for the final self-intersection cleanup union (`executeInternal`,
    /// Offset.ts:192-203): builds an `engine::Clipper64`, wires
    /// `preserveCollinear`/`reverseSolution` and the `ZCB` Z-callback wrapper
    /// ([`zcb_apply`], see [`Self::zcb`]'s doc comment for why it's a free function
    /// here) exactly as TS's `executeInternal` does (`c.zCallback = this.ZCB` is
    /// unconditional — Offset.ts:196 — even when no user callback was ever set), adds
    /// the pre-cleanup solution as the sole subject, and runs `ClipType.Union` with
    /// the paths-reversed-derived `FillRule` (`Positive`/`Negative`). Like TS
    /// (`ClipperOffset.execute`'s `void` return, and every production caller —
    /// `Clipper.inflatePaths`, Clipper.ts:131-137 — which discards
    /// `Clipper64.execute`'s `boolean` return), this ignores whether the internal
    /// union "succeeded".
    pub fn execute(&mut self, delta: f64) -> Result<Paths64, ClipperError> {
        self.solution_tree_requested = false;
        let pre = self.execute_pre_cleanup(delta)?;
        if self.group_list.is_empty() || delta.abs() < 0.5 {
            return Ok(pre);
        }
        let paths_reversed = self.check_paths_reversed();
        let fill_rule = if paths_reversed {
            core::FillRule::Negative
        } else {
            core::FillRule::Positive
        };

        let mut c = engine::Clipper64::new();
        c.preserve_collinear = self.preserve_collinear;
        c.reverse_solution = self.reverse_solution != paths_reversed;
        let user_z_callback = self.z_callback.take();
        let engine_z_callback: core::ZCallback64 =
            Box::new(move |bot1, top1, bot2, top2, intersect_pt| {
                zcb_apply(
                    bot1,
                    top1,
                    bot2,
                    top2,
                    intersect_pt,
                    user_z_callback.as_ref(),
                );
            });
        c.z_callback = Some(engine_z_callback);
        c.add_paths(&pre, core::PathType::Subject);

        let mut solution = Paths64::new();
        c.execute_paths(core::ClipType::Union, fill_rule, &mut solution, None);
        Ok(solution)
    }

    /// TS: Offset.ts:206-223 `execute` (the `PolyTree64` overload). Runs the same
    /// boolean-clip-engine cleanup as [`Self::execute`] but requests `PolyTree64`
    /// output from the engine (`engine::Clipper64::execute_poly_tree`, mirroring
    /// `usingPolytree = true`). No caller in this crate needs the raw tree structure
    /// — the production app's only offset entry point (`inflatePaths`,
    /// Clipper.ts:131-137) always uses the `Paths64` overload — so the tree is
    /// flattened back to `Paths64` via `engine::poly_tree_to_paths64` (mirroring
    /// `Clipper.ts:714-720 polyTreeToPaths64`) before returning, rather than exposing
    /// `engine::PolyTree64` through this method's signature.
    pub fn execute_tree(&mut self, delta: f64) -> Result<Paths64, ClipperError> {
        self.solution_tree_requested = true;
        let pre = self.execute_pre_cleanup(delta)?;
        if self.group_list.is_empty() || delta.abs() < 0.5 {
            return Ok(pre);
        }
        let paths_reversed = self.check_paths_reversed();
        let fill_rule = if paths_reversed {
            core::FillRule::Negative
        } else {
            core::FillRule::Positive
        };

        let mut c = engine::Clipper64::new();
        c.preserve_collinear = self.preserve_collinear;
        c.reverse_solution = self.reverse_solution != paths_reversed;
        let user_z_callback = self.z_callback.take();
        let engine_z_callback: core::ZCallback64 =
            Box::new(move |bot1, top1, bot2, top2, intersect_pt| {
                zcb_apply(
                    bot1,
                    top1,
                    bot2,
                    top2,
                    intersect_pt,
                    user_z_callback.as_ref(),
                );
            });
        c.z_callback = Some(engine_z_callback);
        c.add_paths(&pre, core::PathType::Subject);

        let mut tree = engine::PolyTree64::new();
        c.execute_poly_tree(core::ClipType::Union, fill_rule, &mut tree, None);
        Ok(engine::poly_tree_to_paths64(&tree))
    }

    /// TS: Offset.ts:225-228 `executeWithCallback`.
    pub fn execute_with_callback(
        &mut self,
        delta_callback: DeltaCallback,
    ) -> Result<Paths64, ClipperError> {
        self.delta_callback = Some(delta_callback);
        self.execute(1.0)
    }

    /// TS: Offset.ts:230-240 `getUnitNormal` (public static).
    pub fn get_unit_normal(pt1: Point64, pt2: Point64) -> PointD {
        let dx = pt2.x - pt1.x;
        let dy = pt2.y - pt1.y;
        if dx == 0.0 && dy == 0.0 {
            return PointD {
                x: 0.0,
                y: 0.0,
                z: 0.0,
            };
        }
        let f = 1.0 / (dx * dx + dy * dy).sqrt();
        PointD {
            x: dy * f,
            y: -dx * f,
            z: 0.0,
        }
    }

    /// TS: Offset.ts:242-262 `getLowestPathInfo` (public static).
    pub fn get_lowest_path_info(paths: &Paths64) -> LowestPathInfo {
        let mut idx: i64 = -1;
        let mut is_neg_area = false;
        let mut bot_x = core::MAX_SAFE_INTEGER;
        let mut bot_y = core::MIN_SAFE_INTEGER;

        for (i, path) in paths.iter().enumerate() {
            let mut a = f64::MAX;
            for &pt in path {
                if (pt.y < bot_y) || (pt.y == bot_y && pt.x >= bot_x) {
                    continue;
                }
                if a == f64::MAX {
                    a = ClipperOffset::area(path);
                    if a == 0.0 {
                        break;
                    }
                    is_neg_area = a < 0.0;
                }
                idx = i as i64;
                bot_x = pt.x;
                bot_y = pt.y;
            }
        }

        LowestPathInfo { idx, is_neg_area }
    }

    /// TS: Offset.ts:264-266 `translatePoint` (private static).
    fn translate_point(pt: PointD, dx: f64, dy: f64) -> PointD {
        PointD {
            x: pt.x + dx,
            y: pt.y + dy,
            z: pt.z,
        }
    }

    /// TS: Offset.ts:268-270 `reflectPoint` (private static).
    fn reflect_point(pt: PointD, pivot: PointD) -> PointD {
        PointD {
            x: pivot.x + (pivot.x - pt.x),
            y: pivot.y + (pivot.y - pt.y),
            z: pt.z,
        }
    }

    /// TS: Offset.ts:272-274 `almostZero` (private static). Note: a
    /// *different* epsilon (`0.001`) than `InternalClipper.isAlmostZero`'s
    /// `1e-12` — reproduced verbatim, not unified.
    fn almost_zero(value: f64, epsilon: f64) -> bool {
        value.abs() < epsilon
    }

    /// TS: Offset.ts:276-278 `hypotenuse` (private static).
    fn hypotenuse(x: f64, y: f64) -> f64 {
        (x * x + y * y).sqrt()
    }

    /// TS: Offset.ts:280-285 `normalizeVector` (private static).
    fn normalize_vector(vec: PointD) -> PointD {
        let h = Self::hypotenuse(vec.x, vec.y);
        if Self::almost_zero(h, 0.001) {
            return PointD {
                x: 0.0,
                y: 0.0,
                z: 0.0,
            };
        }
        let inverse_hypot = 1.0 / h;
        PointD {
            x: vec.x * inverse_hypot,
            y: vec.y * inverse_hypot,
            z: 0.0,
        }
    }

    /// TS: Offset.ts:287-289 `getAvgUnitVector` (private static).
    fn get_avg_unit_vector(vec1: PointD, vec2: PointD) -> PointD {
        Self::normalize_vector(PointD {
            x: vec1.x + vec2.x,
            y: vec1.y + vec2.y,
            z: 0.0,
        })
    }

    /// TS: Offset.ts:291-312 `intersectPoint` (private static).
    fn intersect_point(pt1a: PointD, pt1b: PointD, pt2a: PointD, pt2b: PointD) -> PointD {
        if is_almost_zero(pt1a.x - pt1b.x) {
            // vertical
            if is_almost_zero(pt2a.x - pt2b.x) {
                return PointD {
                    x: 0.0,
                    y: 0.0,
                    z: 0.0,
                };
            }
            let m2 = (pt2b.y - pt2a.y) / (pt2b.x - pt2a.x);
            let b2 = pt2a.y - m2 * pt2a.x;
            return PointD {
                x: pt1a.x,
                y: m2 * pt1a.x + b2,
                z: 0.0,
            };
        }

        if is_almost_zero(pt2a.x - pt2b.x) {
            // vertical
            let m1 = (pt1b.y - pt1a.y) / (pt1b.x - pt1a.x);
            let b1 = pt1a.y - m1 * pt1a.x;
            PointD {
                x: pt2a.x,
                y: m1 * pt2a.x + b1,
                z: 0.0,
            }
        } else {
            let m1 = (pt1b.y - pt1a.y) / (pt1b.x - pt1a.x);
            let b1 = pt1a.y - m1 * pt1a.x;
            let m2 = (pt2b.y - pt2a.y) / (pt2b.x - pt2a.x);
            let b2 = pt2a.y - m2 * pt2a.x;
            if is_almost_zero(m1 - m2) {
                return PointD {
                    x: 0.0,
                    y: 0.0,
                    z: 0.0,
                };
            }
            let x = (b2 - b1) / (m1 - m2);
            PointD {
                x,
                y: m1 * x + b1,
                z: 0.0,
            }
        }
    }

    /// TS: Offset.ts:314-320 `getPerpendic` (private instance method).
    fn get_perpendic(&self, pt: Point64, norm: PointD) -> Point64 {
        Point64 {
            x: math_round(pt.x + norm.x * self.group_delta),
            y: math_round(pt.y + norm.y * self.group_delta),
            z: pt.z_or_zero(),
        }
    }

    /// TS: Offset.ts:322-328 `getPerpendicD` (private instance method).
    fn get_perpendic_d(&self, pt: Point64, norm: PointD) -> PointD {
        PointD {
            x: pt.x + norm.x * self.group_delta,
            y: pt.y + norm.y * self.group_delta,
            z: pt.z_or_zero(),
        }
    }

    /// TS: Offset.ts:330-359 `doBevel`.
    fn do_bevel(&mut self, path: &Path64, j: usize, k: usize) {
        let pjz = path[j].z_or_zero();
        let (pt1, pt2);
        if j == k {
            let abs_delta = self.group_delta.abs();
            pt1 = Point64 {
                x: math_round(path[j].x - abs_delta * self.normals[j].x),
                y: math_round(path[j].y - abs_delta * self.normals[j].y),
                z: pjz,
            };
            pt2 = Point64 {
                x: math_round(path[j].x + abs_delta * self.normals[j].x),
                y: math_round(path[j].y + abs_delta * self.normals[j].y),
                z: pjz,
            };
        } else {
            pt1 = Point64 {
                x: math_round(path[j].x + self.group_delta * self.normals[k].x),
                y: math_round(path[j].y + self.group_delta * self.normals[k].y),
                z: pjz,
            };
            pt2 = Point64 {
                x: math_round(path[j].x + self.group_delta * self.normals[j].x),
                y: math_round(path[j].y + self.group_delta * self.normals[j].y),
                z: pjz,
            };
        }
        self.path_out.push(pt1);
        self.path_out.push(pt2);
    }

    /// TS: Offset.ts:361-402 `doSquare`.
    fn do_square(&mut self, path: &Path64, j: usize, k: usize) -> Result<(), ClipperError> {
        let vec = if j == k {
            PointD {
                x: self.normals[j].y,
                y: -self.normals[j].x,
                z: 0.0,
            }
        } else {
            Self::get_avg_unit_vector(
                PointD {
                    x: -self.normals[k].y,
                    y: self.normals[k].x,
                    z: 0.0,
                },
                PointD {
                    x: self.normals[j].y,
                    y: -self.normals[j].x,
                    z: 0.0,
                },
            )
        };

        let abs_delta = self.group_delta.abs();

        // now offset the original vertex delta units along unit vector
        let ptq0 = PointD {
            x: path[j].x,
            y: path[j].y,
            z: path[j].z_or_zero(),
        };
        let ptq = Self::translate_point(ptq0, abs_delta * vec.x, abs_delta * vec.y);

        // get perpendicular vertices
        let pt1 = Self::translate_point(ptq, self.group_delta * vec.y, self.group_delta * -vec.x);
        let pt2 = Self::translate_point(ptq, self.group_delta * -vec.y, self.group_delta * vec.x);
        // get 2 vertices along one edge offset
        let pt3 = self.get_perpendic_d(path[k], self.normals[k]);

        if j == k {
            let pt4 = PointD {
                x: pt3.x + vec.x * self.group_delta,
                y: pt3.y + vec.y * self.group_delta,
                z: 0.0,
            };
            let mut pt = Self::intersect_point(pt1, pt2, pt3, pt4);
            pt.z = ptq.z;
            // get the second intersect point through reflection
            self.path_out
                .push(point64_utils::from_point_d(Self::reflect_point(pt, ptq))?);
            self.path_out.push(point64_utils::from_point_d(pt)?);
        } else {
            let pt4 = self.get_perpendic_d(path[j], self.normals[k]);
            let mut pt = Self::intersect_point(pt1, pt2, pt3, pt4);
            pt.z = ptq.z;
            self.path_out.push(point64_utils::from_point_d(pt)?);
            // get the second intersect point through reflection
            self.path_out
                .push(point64_utils::from_point_d(Self::reflect_point(pt, ptq))?);
        }
        Ok(())
    }

    /// TS: Offset.ts:404-411 `doMiter`.
    fn do_miter(&mut self, path: &Path64, j: usize, k: usize, cos_a: f64) {
        let q = self.group_delta / (cos_a + 1.0);
        self.path_out.push(Point64 {
            x: math_round(path[j].x + (self.normals[k].x + self.normals[j].x) * q),
            y: math_round(path[j].y + (self.normals[k].y + self.normals[j].y) * q),
            z: path[j].z_or_zero(),
        });
    }

    /// TS: Offset.ts:413-450 `doRound`. Trigonometric functions (`sin`/`cos`/
    /// `acos`) use Rust's `f64` libm bindings; TODO(js_number): not verified
    /// bit-identical to V8's `Math.sin`/`Math.cos`/`Math.acos` across
    /// platforms — flagged since `JoinType::Round` is not exercised by the
    /// production Miter+Polygon path (see module doc).
    fn do_round(&mut self, path: &Path64, j: usize, k: usize, angle: f64) {
        if self.delta_callback.is_some() {
            // when deltaCallback is assigned, groupDelta won't be constant,
            // so we'll need to do the following calculations for *every* vertex.
            let abs_delta = self.group_delta.abs();
            let arc_tol = if self.arc_tolerance > 0.01 {
                self.arc_tolerance
            } else {
                abs_delta * ARC_CONST
            };
            let steps_per_360 = std::f64::consts::PI / (1.0 - arc_tol / abs_delta).acos();
            self.step_sin = ((2.0 * std::f64::consts::PI) / steps_per_360).sin();
            self.step_cos = ((2.0 * std::f64::consts::PI) / steps_per_360).cos();
            if self.group_delta < 0.0 {
                self.step_sin = -self.step_sin;
            }
            self.steps_per_rad = steps_per_360 / (2.0 * std::f64::consts::PI);
        }

        let pt = path[j];
        let ptz = pt.z_or_zero();
        let mut offset_vec = PointD {
            x: self.normals[k].x * self.group_delta,
            y: self.normals[k].y * self.group_delta,
            z: 0.0,
        };
        if j == k {
            offset_vec.x = -offset_vec.x;
            offset_vec.y = -offset_vec.y;
        }

        self.path_out.push(Point64 {
            x: math_round(pt.x + offset_vec.x),
            y: math_round(pt.y + offset_vec.y),
            z: ptz,
        });

        let steps = (self.steps_per_rad * angle.abs()).ceil() as i64;
        for _ in 1..steps {
            // ie 1 less than steps
            offset_vec = PointD {
                x: offset_vec.x * self.step_cos - self.step_sin * offset_vec.y,
                y: offset_vec.x * self.step_sin + offset_vec.y * self.step_cos,
                z: 0.0,
            };
            self.path_out.push(Point64 {
                x: math_round(pt.x + offset_vec.x),
                y: math_round(pt.y + offset_vec.y),
                z: ptz,
            });
        }
        let perp = self.get_perpendic(path[j], self.normals[j]);
        self.path_out.push(perp);
    }

    /// TS: Offset.ts:452-461 `buildNormals`.
    fn build_normals(&mut self, path: &Path64) {
        let cnt = path.len();
        self.normals.clear();
        if cnt == 0 {
            return;
        }

        for i in 0..cnt - 1 {
            self.normals
                .push(Self::get_unit_normal(path[i], path[i + 1]));
        }
        self.normals
            .push(Self::get_unit_normal(path[cnt - 1], path[0]));
    }

    /// TS: Offset.ts:463-518 `offsetPoint`.
    fn offset_point(
        &mut self,
        group: &Group,
        path: &Path64,
        j: usize,
        k: usize,
    ) -> Result<(), ClipperError> {
        if point64_utils::equals(path[j], path[k]) {
            return Ok(());
        }

        // Let A = change in angle where edges join
        // A == 0: ie no change in angle (flat join)
        // A == PI: edges 'spike'
        // sin(A) < 0: right turning
        // cos(A) < 0: change in angle is more than 90 degree
        let cos_a = dot_product_d(self.normals[j], self.normals[k]);
        // `.clamp(-1.0, 1.0)` is behavior-identical to TS's
        // `sinA > 1 ? 1 : (sinA < -1 ? -1 : sinA)` including for NaN (both leave
        // NaN unchanged; verified against Rust's stdlib `clamp` semantics).
        let sin_a = cross_product_d(self.normals[j], self.normals[k]).clamp(-1.0, 1.0);

        if let Some(cb) = &self.delta_callback {
            self.group_delta = cb(path, &self.normals, j, k);
            if group.paths_reversed {
                self.group_delta = -self.group_delta;
            }
        }
        if self.group_delta.abs() < TOLERANCE {
            self.path_out.push(path[j]);
            return Ok(());
        }

        if cos_a > -0.999 && (sin_a * self.group_delta < 0.0) {
            // test for concavity first (#593)
            // is concave: insert 3 points that produce negative regions,
            // removed later by the finishing union operation.
            let p1 = self.get_perpendic(path[j], self.normals[k]);
            self.path_out.push(p1);
            self.path_out.push(path[j]); // (#405, #873, #916)
            let p2 = self.get_perpendic(path[j], self.normals[j]);
            self.path_out.push(p2);
        } else if cos_a > 0.999 && self.join_type != JoinType::Round {
            // almost straight - less than 2.5 degree (#424, #482, #526 & #724)
            self.do_miter(path, j, k, cos_a);
        } else {
            match self.join_type {
                // miter unless the angle is sufficiently acute to exceed ML
                JoinType::Miter => {
                    if cos_a > self.mit_lim_sqr - 1.0 {
                        self.do_miter(path, j, k, cos_a);
                    } else {
                        self.do_square(path, j, k)?;
                    }
                }
                JoinType::Round => {
                    self.do_round(path, j, k, sin_a.atan2(cos_a));
                }
                JoinType::Bevel => {
                    self.do_bevel(path, j, k);
                }
                JoinType::Square => {
                    self.do_square(path, j, k)?;
                }
            }
        }
        Ok(())
    }

    /// TS: Offset.ts:520-530 `offsetPolygon`.
    fn offset_polygon(&mut self, group: &Group, path: &Path64) -> Result<(), ClipperError> {
        self.path_out = Vec::new();
        let cnt = path.len();
        let mut prev = cnt - 1;
        for i in 0..cnt {
            self.offset_point(group, path, i, prev)?;
            prev = i;
        }
        self.solution.push(std::mem::take(&mut self.path_out));
        Ok(())
    }

    /// TS: Offset.ts:532-537 `offsetOpenJoined`.
    fn offset_open_joined(&mut self, group: &Group, path: &Path64) -> Result<(), ClipperError> {
        self.offset_polygon(group, path)?;
        let mut reverse_path = path.clone();
        reverse_path.reverse();
        self.build_normals(&reverse_path);
        self.offset_polygon(group, &reverse_path)
    }

    /// TS: Offset.ts:539-605 `offsetOpenPath`.
    fn offset_open_path(&mut self, group: &Group, path: &Path64) -> Result<(), ClipperError> {
        self.path_out = Vec::new();
        let high_i = path.len() - 1;

        if let Some(cb) = &self.delta_callback {
            self.group_delta = cb(path, &self.normals, 0, 0);
        }

        // do the line start cap
        if self.group_delta.abs() < TOLERANCE {
            self.path_out.push(path[0]);
        } else {
            match self.end_type {
                EndType::Butt => self.do_bevel(path, 0, 0),
                EndType::Round => self.do_round(path, 0, 0, std::f64::consts::PI),
                _ => self.do_square(path, 0, 0)?,
            }
        }

        // offset the left side going forward
        let mut k = 0usize;
        for i in 1..high_i {
            self.offset_point(group, path, i, k)?;
            k = i;
        }

        // reverse normals ...
        for i in (1..=high_i).rev() {
            self.normals[i] = PointD {
                x: -self.normals[i - 1].x,
                y: -self.normals[i - 1].y,
                z: 0.0,
            };
        }
        self.normals[0] = self.normals[high_i];

        if let Some(cb) = &self.delta_callback {
            self.group_delta = cb(path, &self.normals, high_i, high_i);
        }

        // do the line end cap
        if self.group_delta.abs() < TOLERANCE {
            self.path_out.push(path[high_i]);
        } else {
            match self.end_type {
                EndType::Butt => self.do_bevel(path, high_i, high_i),
                EndType::Round => self.do_round(path, high_i, high_i, std::f64::consts::PI),
                _ => self.do_square(path, high_i, high_i)?,
            }
        }

        // offset the left side going back
        let mut i = high_i as i64 - 1;
        let mut k2 = high_i;
        while i > 0 {
            self.offset_point(group, path, i as usize, k2)?;
            k2 = i as usize;
            i -= 1;
        }

        self.solution.push(std::mem::take(&mut self.path_out));
        Ok(())
    }

    /// TS: Offset.ts:607-684 `doGroupOffset`.
    fn do_group_offset(&mut self, group: &Group) -> Result<(), ClipperError> {
        if group.end_type == EndType::Polygon {
            // a straight path (2 points) can now also be 'polygon' offset
            // where the ends will be treated as (180 deg.) joins
            if group.lowest_path_idx < 0 {
                self.delta = self.delta.abs();
            }
            self.group_delta = if group.paths_reversed {
                -self.delta
            } else {
                self.delta
            };
        } else {
            self.group_delta = self.delta.abs();
        }

        let abs_delta = self.group_delta.abs();

        self.join_type = group.join_type;
        self.end_type = group.end_type;

        if group.join_type == JoinType::Round || group.end_type == EndType::Round {
            let arc_tol = if self.arc_tolerance > 0.01 {
                self.arc_tolerance
            } else {
                abs_delta * ARC_CONST
            };
            let steps_per_360 = std::f64::consts::PI / (1.0 - arc_tol / abs_delta).acos();
            self.step_sin = ((2.0 * std::f64::consts::PI) / steps_per_360).sin();
            self.step_cos = ((2.0 * std::f64::consts::PI) / steps_per_360).cos();
            if self.group_delta < 0.0 {
                self.step_sin = -self.step_sin;
            }
            self.steps_per_rad = steps_per_360 / (2.0 * std::f64::consts::PI);
        }

        for path_in in group.in_paths.clone() {
            self.path_out = Vec::new();
            let cnt = path_in.len();

            if cnt == 1 {
                // single point
                let pt = path_in[0];

                if let Some(cb) = &self.delta_callback {
                    self.group_delta = cb(&path_in, &self.normals, 0, 0);
                    if group.paths_reversed {
                        self.group_delta = -self.group_delta;
                    }
                }

                // single vertex so build a circle or square ...
                let ptz = pt.z_or_zero();
                if group.end_type == EndType::Round {
                    let steps = (self.steps_per_rad * 2.0 * std::f64::consts::PI).ceil() as i64;
                    self.path_out =
                        Self::ellipse(pt, self.group_delta.abs(), self.group_delta.abs(), steps);
                    if ptz != 0.0 {
                        for p in &mut self.path_out {
                            p.z = ptz;
                        }
                    }
                } else {
                    let d = self.group_delta.abs().ceil();
                    let r = core::Rect64 {
                        left: pt.x - d,
                        top: pt.y - d,
                        right: pt.x + d,
                        bottom: pt.y + d,
                    };
                    self.path_out = vec![
                        Point64 {
                            x: r.left,
                            y: r.top,
                            z: ptz,
                        },
                        Point64 {
                            x: r.right,
                            y: r.top,
                            z: ptz,
                        },
                        Point64 {
                            x: r.right,
                            y: r.bottom,
                            z: ptz,
                        },
                        Point64 {
                            x: r.left,
                            y: r.bottom,
                            z: ptz,
                        },
                    ];
                }
                self.solution.push(std::mem::take(&mut self.path_out));
                continue; // end of offsetting a single point
            }

            if cnt == 2 && group.end_type == EndType::Joined {
                self.end_type = if group.join_type == JoinType::Round {
                    EndType::Round
                } else {
                    EndType::Square
                };
            }

            self.build_normals(&path_in);
            match self.end_type {
                EndType::Polygon => self.offset_polygon(group, &path_in)?,
                EndType::Joined => self.offset_open_joined(group, &path_in)?,
                _ => self.offset_open_path(group, &path_in)?,
            }
        }
        Ok(())
    }

    /// TS: Offset.ts:686-703 `stripDuplicates` (public static).
    pub fn strip_duplicates(path: &Path64, is_closed_path: bool) -> Path64 {
        let cnt = path.len();
        let mut result: Path64 = Vec::new();
        if cnt == 0 {
            return result;
        }

        let mut last_pt = path[0];
        result.push(last_pt);
        for &pt in &path[1..] {
            if !point64_utils::equals(last_pt, pt) {
                last_pt = pt;
                result.push(last_pt);
            }
        }
        if is_closed_path && !result.is_empty() && point64_utils::equals(last_pt, result[0]) {
            result.pop();
        }
        result
    }

    /// TS: Offset.ts:705-707 `area` (public static).
    pub fn area(path: &Path64) -> f64 {
        core::area(path)
    }

    /// TS: Offset.ts:709-711 `sqr` (public static).
    pub fn sqr(val: f64) -> f64 {
        val * val
    }

    /// TS: Offset.ts:713-736 `ellipse` (public static).
    pub fn ellipse(center: Point64, radius_x: f64, radius_y_in: f64, steps_in: i64) -> Path64 {
        if radius_x <= 0.0 {
            return Vec::new();
        }
        let radius_y = if radius_y_in <= 0.0 {
            radius_x
        } else {
            radius_y_in
        };
        let steps: i64 = if steps_in <= 2 {
            (std::f64::consts::PI * ((radius_x + radius_y) / 2.0).sqrt()).ceil() as i64
        } else {
            steps_in
        };

        let si = (2.0 * std::f64::consts::PI / steps as f64).sin();
        let co = (2.0 * std::f64::consts::PI / steps as f64).cos();
        let mut dx = co;
        let mut dy = si;
        let mut result: Path64 = vec![Point64 {
            x: math_round(center.x + radius_x),
            y: center.y,
            z: 0.0,
        }];

        for _ in 1..steps {
            result.push(Point64 {
                x: math_round(center.x + radius_x * dx),
                y: math_round(center.y + radius_y * dy),
                z: 0.0,
            });
            let x = dx * co - dy * si;
            dy = dy * co + dx * si;
            dx = x;
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(x: f64, y: f64) -> Point64 {
        Point64::new(x, y, 0.0)
    }

    fn ccw_square(side: f64) -> Path64 {
        vec![p(0.0, 0.0), p(side, 0.0), p(side, side), p(0.0, side)]
    }

    #[test]
    fn get_unit_normal_is_perpendicular_unit_length() {
        let n = ClipperOffset::get_unit_normal(p(0.0, 0.0), p(10.0, 0.0));
        assert!((n.x - 0.0).abs() < 1e-12);
        assert!((n.y - (-1.0)).abs() < 1e-12);
    }

    #[test]
    fn get_unit_normal_degenerate_edge_is_zero() {
        let n = ClipperOffset::get_unit_normal(p(5.0, 5.0), p(5.0, 5.0));
        assert_eq!(
            n,
            PointD {
                x: 0.0,
                y: 0.0,
                z: 0.0
            }
        );
    }

    #[test]
    fn strip_duplicates_collapses_adjacent_and_closing_dupes() {
        let path = vec![
            p(0.0, 0.0),
            p(0.0, 0.0),
            p(1.0, 0.0),
            p(1.0, 1.0),
            p(0.0, 0.0),
        ];
        let stripped_open = ClipperOffset::strip_duplicates(&path, false);
        assert_eq!(
            stripped_open,
            vec![p(0.0, 0.0), p(1.0, 0.0), p(1.0, 1.0), p(0.0, 0.0)]
        );
        let stripped_closed = ClipperOffset::strip_duplicates(&path, true);
        assert_eq!(stripped_closed, vec![p(0.0, 0.0), p(1.0, 0.0), p(1.0, 1.0)]);
    }

    #[test]
    fn get_lowest_path_info_picks_bottom_then_rightmost() {
        let square = ccw_square(10.0);
        let info = ClipperOffset::get_lowest_path_info(&vec![square]);
        assert_eq!(info.idx, 0);
        assert!(!info.is_neg_area); // CCW square has positive area
    }

    #[test]
    fn group_construction_flags_reversed_negative_area_lowest_path() {
        let cw_square = vec![p(0.0, 0.0), p(0.0, 10.0), p(10.0, 10.0), p(10.0, 0.0)];
        let g = Group::new(&vec![cw_square], JoinType::Miter, EndType::Polygon);
        assert!(g.paths_reversed);
        assert_eq!(g.lowest_path_idx, 0);
    }

    #[test]
    fn execute_pre_cleanup_small_delta_passes_through_unchanged() {
        let mut co = ClipperOffset::new(2.0, 0.0, false, false);
        let square = ccw_square(10.0);
        co.add_path(&square, JoinType::Miter, EndType::Polygon);
        let solution = co.execute_pre_cleanup(0.25).unwrap();
        assert_eq!(solution, vec![square]);
    }

    #[test]
    fn execute_pre_cleanup_empty_group_list_is_empty() {
        let mut co = ClipperOffset::new(2.0, 0.0, false, false);
        let solution = co.execute_pre_cleanup(5.0).unwrap();
        assert!(solution.is_empty());
    }

    #[test]
    fn execute_pre_cleanup_miter_polygon_produces_one_offset_ring_per_input() {
        let mut co = ClipperOffset::new(2.0, 0.0, false, false);
        let square = ccw_square(100.0);
        co.add_path(&square, JoinType::Miter, EndType::Polygon);
        let solution = co.execute_pre_cleanup(10.0).unwrap();
        assert_eq!(solution.len(), 1);
        // A convex square offset outward by a miter join should itself be
        // convex with the same vertex count (no concave/spike insertions).
        assert_eq!(solution[0].len(), square.len());
        // Every offset vertex should land outside the original square, i.e.
        // at (-10,-10), (110,-10), (110,110), (-10,110) for delta=10.
        let expected = vec![
            p(-10.0, -10.0),
            p(110.0, -10.0),
            p(110.0, 110.0),
            p(-10.0, 110.0),
        ];
        assert_eq!(solution[0], expected);
    }

    #[test]
    fn execute_significant_delta_runs_through_engine_union_cleanup() {
        // Regression pin for the wiring between `ClipperOffset::execute` and the real
        // boolean-clip engine (Offset.ts:192-203): a convex, non-self-intersecting
        // miter offset should survive the `ClipType.Union` cleanup unchanged as a set
        // of vertices — same ring as `execute_pre_cleanup_miter_polygon_produces_one_offset_ring_per_input`
        // asserts pre-cleanup, just re-started/re-ordered by the engine's own scanline
        // reconstruction (see crates/irregular-nesting-native/tests/clipper_offset_vectors.rs
        // for the byte-exact TS-oracle differential coverage of this path).
        let mut co = ClipperOffset::new(2.0, 0.0, false, false);
        let square = ccw_square(100.0);
        co.add_path(&square, JoinType::Miter, EndType::Polygon);
        let solution = co.execute(10.0).unwrap();
        assert_eq!(solution.len(), 1);
        assert_eq!(
            solution[0],
            vec![
                p(110.0, 110.0),
                p(-10.0, 110.0),
                p(-10.0, -10.0),
                p(110.0, -10.0),
            ]
        );
    }

    #[test]
    fn execute_small_delta_succeeds_without_engine() {
        let mut co = ClipperOffset::new(2.0, 0.0, false, false);
        let square = ccw_square(100.0);
        co.add_path(&square, JoinType::Miter, EndType::Polygon);
        let solution = co.execute(0.1).unwrap();
        assert_eq!(solution, vec![square]);
    }

    #[test]
    fn ellipse_zero_radius_is_empty() {
        assert!(ClipperOffset::ellipse(p(0.0, 0.0), 0.0, 0.0, 0).is_empty());
    }

    #[test]
    fn ellipse_produces_requested_step_count() {
        let path = ClipperOffset::ellipse(p(0.0, 0.0), 100.0, 100.0, 8);
        assert_eq!(path.len(), 8);
    }

    #[test]
    fn sqr_matches_multiplication() {
        assert_eq!(ClipperOffset::sqr(3.0), 9.0);
        assert_eq!(ClipperOffset::sqr(-2.5), 6.25);
    }
}
