/*
Copyright: Angus Johnson 2010-2025
License: https://www.boost.org/LICENSE_1_0.txt
Complete license text: ../../LICENSES/clipper2-ts-BSL-1.0.txt
*/

//! Vendor-translated port of `clipper2-ts@2.0.1-18`'s `src/Engine.ts` boolean-clip
//! engine, plus the small `src/Clipper.ts` wrapper surface this task is assigned
//! (`booleanOp`, `booleanOpWithPolyTree`, `polyTreeToPaths64`) — per ruling R10
//! (`docs/planning/rust-irregular-backend/stage0-rulings.md`) and this task's
//! assignment: "public booleanOp/booleanOpWithPolyTree/polyTreeToPaths64 wrappers;
//! app usage: ClipType Union/Difference/Intersection/Xor, FillRule EvenOdd/NonZero,
//! PolyTree64 output".
//!
//! # Scope
//!
//! Only the code reachable from `booleanOp`/`booleanOpWithPolyTree`/`polyTreeToPaths64`
//! (`Clipper.ts:81-101,714-719`) is ported:
//!
//! - `ClipperBase` + `Clipper64` (merged into one [`Clipper64`] struct here — TS splits
//!   them so `ClipperD` can share `ClipperBase`, but `ClipperD`/`PolyPathD`/`PolyTreeD`
//!   are out of scope per the assignment, so there is no second subclass and nothing to
//!   gain from keeping the split).
//! - `PolyPathBase`/`PolyPath64`/`PolyTree64`, needed for `booleanOpWithPolyTree` +
//!   `polyTreeToPaths64`.
//! - `Vertex`/`LocalMinima`/`Active`/`OutPt`/`OutRec`/`HorzSegment`/`HorzJoin` and the
//!   full scanline sweep algorithm (`executeInternal` and everything it calls).
//!
//! NOT ported (unreachable from the three assigned entry points, or explicitly out of
//! scope per the task assignment): `ClipperD`, `PolyPathD`/`PolyTreeD`,
//! `ReuseableDataContainer64`/`addReuseableData` (booleanOp never uses reusable vertex
//! data), `RectClip64`/`RectClipLines64`, `Minkowski`, `Triangulation`. The `ClipperD`-only
//! floating-point variant of the engine and every `PathsD`/`RectD` overload in
//! `Clipper.ts` are likewise not ported.
//!
//! # Open paths are unreachable — and real, not stubbed, `is_open`/`has_open_paths`
//!
//! `booleanOp`/`booleanOpWithPolyTree` (`Clipper.ts:84-100`) always call
//! `c.addPaths(paths, PathType.Subject/Clip)` with TS's default `isOpen = false`
//! (`Engine.ts:857` `addPaths(paths, polytype, isOpen: boolean = false)`). This port's
//! [`Clipper64::add_paths`] mirrors that: it never accepts an `is_open` argument, so
//! `has_open_paths` is `false` for every reachable call and stays `false` for the whole
//! job (nothing else sets it). Rather than manually identifying and stripping every
//! `if (isOpen(ae))`/`if (openPathsEnabled)` guard throughout the sweep (error-prone),
//! this port keeps `has_open_paths`/`open_paths_enabled` as real fields and
//! [`Clipper64::is_open`]/[`Clipper64::is_open_end`] as real (trivial) functions that
//! correctly evaluate to `false` given those fields — so every surrounding guarded
//! branch is ported verbatim and provably never taken, exactly reproducing closed-path
//! behavior without any manual dead-branch surgery. Only a handful of functions that
//! are *exclusively* reachable from open-path branches (and would need the sizeable,
//! never-exercised general `doHorizontal`, `Engine.ts:1067-1196`, to reach them) are
//! replaced with an honest `unreachable!()` naming the exact TS lines — see
//! [`Clipper64::do_horizontal`], [`Clipper64::start_open_path`],
//! [`Clipper64::set_wind_count_for_open_path_edge`], [`Clipper64::is_contributing_open`],
//! and the open-path branch inside [`Clipper64::intersect_edges`]. Each of those is
//! provably dead for every input this port's public API can construct.
//!
//! # Arena/index design (replacing JS's mutable object graph)
//!
//! `Vertex`/`Active`/`OutPt`/`OutRec` form a mutable, often-circular, reference-based
//! graph in TS (next/prev/owner/outrec pointers). Safe Rust cannot express that graph
//! with `&mut` references without `unsafe` or `Rc<RefCell<_>>` (which would still need
//! runtime-checked borrows on every field access, i.e. hidden panics, and would be far
//! slower than the JS original — contrary to this migration's stated performance goal).
//! Instead every node type gets its own append-only arena (`Vec<T>`) owned directly by
//! [`Clipper64`], and every "pointer" becomes a plain `usize` index into the relevant
//! arena (`Option<usize>` where the pointer could be `null`). JS object identity becomes
//! Rust arena-index equality; `null` becomes `None`. JS never actually frees these
//! objects (`// delete ae;` is commented out in `Engine.ts:885`, relying on GC), so an
//! append-only arena that never reclaims slots is a faithful match, not a shortcut.
//!
//! `HorzSegment`/`HorzJoin` are the one place TS holds true object references to values
//! that get reordered (`horzSegList.sort(...)`, `Engine.ts:1303`): reordering a `Vec<T>`
//! by value in Rust would invalidate any `usize` index into it taken before the sort, so
//! those two are pure local value types (never referenced by index — see
//! [`OutPtNode::horz`]'s doc comment for how the one exception, `OutPt.horz`, is
//! handled).
//!
//! # `ScanlineHeap`/`scanlineSet`/`scanlineArr` dual-mode structure — simplified
//!
//! `Engine.ts:35-88,536-542,787-841` implements two interchangeable data structures for
//! "the set of pending scanline Y values, poppable in descending order without
//! duplicates": a small-`N` linear-scan array (`scanlineArr`) that upgrades to a
//! binary max-heap (`ScanlineHeap`) + hash set (`scanlineSet`) once it grows past a
//! threshold. This is a pure Big-O optimization: **both modes always insert-dedup by
//! exact value equality and always pop the current maximum**, so the *sequence* of Y
//! values [`Clipper64::pop_scanline`] returns — the only thing `executeInternal`
//! observes — is identical regardless of which internal structure produced it. This
//! port always uses the heap+set mode (see [`ScanlineY`]), which is both simpler to
//! port correctly and matches this migration's "reduced execution time" mandate more
//! directly than replicating an array-vs-heap size heuristic that has zero effect on
//! output. One correctness-relevant JS semantic is preserved deliberately: JS `Set`
//! dedups with SameValueZero (`-0` and `+0` compare equal), unlike Rust's bit-pattern
//! hashing, so [`Clipper64::insert_scanline`]/[`Clipper64::pop_scanline`] normalize `-0.0`
//! to `+0.0` before using it as a hash-set key (matching TS's `scanlineSet.has(y)`).
//!
//! # `z` coordinates
//!
//! No caller of the three assigned entry points ever installs a `zCallback`, so
//! [`Clipper64::set_z`] (`Engine.ts:575-608`) is a no-op on every reachable path (its
//! very first line is `if (!zCallback) return;`). It is still ported faithfully (rather
//! than special-cased away) because ~15 call sites reference it uniformly; that
//! uniformity is preserved by keeping a real implementation. Every TS object literal
//! that omits `z` (e.g. `{ x: horz.curX, y }`) is translated with `z: 0.0`, matching
//! `core::Point64`'s "no separate presence bit" design (see `core.rs`'s module doc) —
//! `pt.z ?? 0` at every JSON-encoding boundary makes "absent" and "present as `0`"
//! indistinguishable in the differential vectors, so this collapse is observationally
//! exact.

use std::collections::{BinaryHeap, HashSet};

use super::core::{
    self, cross_product_sign, dot_product_sign, f64_to_bigint, get_bounds,
    get_closest_pt_on_segment, get_line_intersect_pt, is_collinear, is_safe_integer, math_round,
    max_coord_for_safe_area_product, path2_contains_path1, rect64_utils, round_to_even,
    segs_intersect, ClipType, FillRule, PathType, Point64, PointInPolygonResult, Rect64,
    ZCallback64,
};
use num_bigint::BigInt;

pub type Path64 = core::Path64;
pub type Paths64 = core::Paths64;

// ---------------------------------------------------------------------------
// VertexFlags (Engine.ts:26-32)
// ---------------------------------------------------------------------------

/// TS: Engine.ts:26-32 `enum VertexFlags`. Modeled as a plain bitmask (not a Rust `enum`,
/// since values are combined with `|`/`&` exactly like the JS bitwise-flag enum) so every
/// `flags & X`/`flags |= X` call site translates mechanically.
pub mod vertex_flags {
    pub const NONE: u8 = 0;
    pub const OPEN_START: u8 = 1;
    pub const OPEN_END: u8 = 2;
    pub const LOCAL_MAX: u8 = 4;
    pub const LOCAL_MIN: u8 = 8;
}

// ---------------------------------------------------------------------------
// Scanline max-heap (see module doc: "ScanlineHeap/scanlineSet/scanlineArr
// dual-mode structure — simplified"). Engine.ts:35-88,536-542,787-841.
// ---------------------------------------------------------------------------

/// Total-ordered `f64` newtype so [`BinaryHeap`] (which requires `Ord`) can serve as the
/// scanline max-heap. Coordinates reaching this engine are always finite (validated
/// upstream of the boolean-clip boundary), so `total_cmp` — a genuine total order over
/// all `f64` bit patterns, agreeing with `<`/`>` for all non-NaN finite values — is exact
/// here; see the module doc for why heap-vs-array internal structure is unobservable.
#[derive(Debug, Clone, Copy, PartialEq)]
struct ScanlineY(f64);

impl Eq for ScanlineY {}
impl PartialOrd for ScanlineY {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for ScanlineY {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.0.total_cmp(&other.0)
    }
}

/// JS `Set` (SameValueZero) treats `-0` and `+0` as the same key; Rust bit-pattern
/// hashing does not. Normalizing before hashing reproduces `scanlineSet.has(y)`/`.add(y)`
/// exactly (see module doc).
fn scanline_key(y: f64) -> u64 {
    (if y == 0.0 { 0.0_f64 } else { y }).to_bits()
}

// ---------------------------------------------------------------------------
// Vertex (Engine.ts:90-101) — arena node. See module doc for the arena/index design.
// ---------------------------------------------------------------------------

/// TS: Engine.ts:90-101 `class Vertex`. `next`/`prev` are `Vertex | null` in TS but form
/// a circular doubly-linked list per path once `addPathsToVertexList` finishes wiring a
/// path (`prevV!.next = v0; v0!.prev = prevV;`, Engine.ts:290-291) — the head vertex's
/// `prev` is never actually left `null` for a valid (non-degenerate, non-open) path, but
/// `prev` starts `null` transiently during construction, so both stay `Option<usize>`
/// for fidelity.
#[derive(Debug, Clone, Copy)]
struct VertexNode {
    pt: Point64,
    next: Option<usize>,
    prev: Option<usize>,
    flags: u8,
}

// ---------------------------------------------------------------------------
// LocalMinima (Engine.ts:103-123) — value node in `minima_list`. See module doc:
// `minima_list` is sorted exactly once per `execute()` (in `reset`), before any
// `Active.local_min` index is taken, so a plain post-sort array index is a faithful
// stand-in for JS's `LocalMinima` object-identity references.
// ---------------------------------------------------------------------------

/// TS: Engine.ts:103-117 `class LocalMinima`. `equals` (Engine.ts:114-116) compares
/// `vertex` identity; ported as plain index equality on the `vertex` field (see struct
/// doc above for why `usize` indices are stable enough here to substitute for identity).
#[derive(Debug, Clone, Copy)]
struct LocalMinimaNode {
    vertex: usize,
    polytype: PathType,
    is_open: bool,
}

// ---------------------------------------------------------------------------
// IntersectNode (Engine.ts:125-139) — pure value type, `Vec` order is meaningful
// (sorted/swapped in place) but never referenced by external index.
// ---------------------------------------------------------------------------

/// TS: Engine.ts:128-139 `interface IntersectNode` + `createIntersectNode`.
#[derive(Debug, Clone, Copy)]
struct IntersectNode {
    pt: Point64,
    edge1: usize,
    edge2: usize,
}

/// TS: Engine.ts:206-211 `compareIntersectNodes`. Sorted with `.sort()` (stable, ES2019+)
/// in `processIntersectList` — `Vec::sort_by` is stable, matching. Takes the active-edge
/// arena directly (rather than the `curX` values baked into `IntersectNode` at
/// construction time, as TS's `edge1`/`edge2` object references implicitly provide) since
/// `edge1`/`edge2` are stored here as arena indices.
fn compare_intersect_nodes(
    a: &IntersectNode,
    b: &IntersectNode,
    actives: &[ActiveNode],
) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    if a.pt.y != b.pt.y {
        return if a.pt.y > b.pt.y {
            Ordering::Less
        } else {
            Ordering::Greater
        };
    }
    if a.pt.x != b.pt.x {
        return if a.pt.x < b.pt.x {
            Ordering::Less
        } else {
            Ordering::Greater
        };
    }
    let a_e1 = actives[a.edge1].cur_x;
    let b_e1 = actives[b.edge1].cur_x;
    if a_e1 != b_e1 {
        return if a_e1 < b_e1 {
            Ordering::Less
        } else {
            Ordering::Greater
        };
    }
    let a_e2 = actives[a.edge2].cur_x;
    let b_e2 = actives[b.edge2].cur_x;
    if a_e2 < b_e2 {
        Ordering::Less
    } else if a_e2 > b_e2 {
        Ordering::Greater
    } else {
        Ordering::Equal
    }
}

// ---------------------------------------------------------------------------
// OutPt (Engine.ts:141-156) — arena node.
// ---------------------------------------------------------------------------

/// TS: Engine.ts:142-156 `class OutPt`. `next`/`prev` are typed `OutPt | null` /
/// `OutPt` respectively, but the constructor always sets both to `this` (self-circular),
/// and no call site in the ported subset ever sets either to `null` (every read uses a
/// non-null assertion `op.next!`) — so both are modeled as plain non-optional `usize`.
#[derive(Debug, Clone, Copy)]
struct OutPtNode {
    pt: Point64,
    next: usize,
    prev: usize,
    outrec: usize,
    /// TS: `public horz: HorzSegment | null;` (Engine.ts:147), only ever compared to
    /// `null` or assigned a `HorzSegment` reference (`Engine.ts:1363,1366`) — its content
    /// is never read back (verified: `grep -n '\.horz\b' Engine.ts` finds only those two
    /// sites plus the `= null` initializer). Collapsed to a presence flag: `false` ==
    /// `null`, `true` == "assigned some `HorzSegment` once". This flag is intentionally
    /// process-lifetime-sticky (never reset to `false`) exactly like the TS field, which
    /// is also never reset — see [`Clipper64::update_horz_segment`]'s doc comment for why
    /// that stickiness is a real, preserved quirk (R3), not an oversight.
    horz: bool,
}

// ---------------------------------------------------------------------------
// JoinWith (Engine.ts:158) / OutRec (Engine.ts:161-174) — arena node.
// ---------------------------------------------------------------------------

/// TS: Engine.ts:158 `enum JoinWith { None, Left, Right }`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum JoinWith {
    None,
    Left,
    Right,
}

/// TS: Engine.ts:162-174 `class OutRec`. `idx` always equals this node's own arena
/// index (assigned once in `new_out_rec`, mirroring `newOutRec`'s
/// `result.idx = this.outrecList.length;`) — kept as an explicit field (rather than
/// relying on callers to know their own index) because several TS call sites compare
/// `outrec.idx` values directly (e.g. `checkJoinLeft`'s `ae.outrec!.idx === prev.outrec!.idx`).
#[derive(Debug, Clone)]
struct OutRecNode {
    idx: usize,
    owner: Option<usize>,
    front_edge: Option<usize>,
    back_edge: Option<usize>,
    pts: Option<usize>,
    /// TS: `polypath: PolyPathBase | null`. Index into [`PolyTree64::nodes`].
    polypath: Option<usize>,
    bounds: Rect64,
    path: Path64,
    is_open: bool,
    /// TS: `splits: number[] | null` — `OutRec.idx` values (`Engine.ts:3198`
    /// `this.outrecList[splits[i]]` confirms `splits` holds arena indices directly).
    splits: Option<Vec<usize>>,
    recursive_split: Option<usize>,
}

impl OutRecNode {
    fn new(idx: usize) -> Self {
        OutRecNode {
            idx,
            owner: None,
            front_edge: None,
            back_edge: None,
            pts: None,
            polypath: None,
            bounds: Rect64 {
                left: 0.0,
                top: 0.0,
                right: 0.0,
                bottom: 0.0,
            },
            path: Vec::new(),
            is_open: false,
            splits: None,
            recursive_split: None,
        }
    }
}

// ---------------------------------------------------------------------------
// HorzSegment (Engine.ts:176-186) / HorzJoin (Engine.ts:188-196) — pure value
// types local to one scanbeam's horizontal-segment processing. See module doc.
// ---------------------------------------------------------------------------

/// TS: Engine.ts:176-186 `class HorzSegment`.
#[derive(Debug, Clone, Copy)]
struct HorzSegment {
    left_op: usize,
    right_op: Option<usize>,
    left_to_right: bool,
}

/// TS: Engine.ts:188-196 `class HorzJoin`. Both fields are always non-null at
/// construction (`constructor(ltor: OutPt, rtol: OutPt)`) and never reassigned.
#[derive(Debug, Clone, Copy)]
struct HorzJoin {
    op1: usize,
    op2: usize,
}

/// TS: Engine.ts:198-204 `compareHorzSegments`. Returns a raw numeric difference in TS
/// (consumed by `Array.sort`'s sign convention); translated to `Ordering` via explicit
/// sign comparison of the same difference to preserve identical float behavior
/// (including for huge-magnitude coordinates where the literal subtraction could lose
/// precision or saturate to infinity — the *sign* is still exactly what `.sort()` used).
fn compare_horz_segments(
    hs1: &HorzSegment,
    hs2: &HorzSegment,
    out_pts: &[OutPtNode],
) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    if hs1.right_op.is_none() {
        return if hs2.right_op.is_none() {
            Ordering::Equal
        } else {
            Ordering::Greater
        };
    }
    if hs2.right_op.is_none() {
        return Ordering::Less;
    }
    let diff = out_pts[hs1.left_op].pt.x - out_pts[hs2.left_op].pt.x;
    if diff > 0.0 {
        Ordering::Greater
    } else if diff < 0.0 {
        Ordering::Less
    } else {
        Ordering::Equal
    }
}

/// TS: `ClipperBase.resetHorzDirection`'s inline return-object shape (Engine.ts:1928).
struct HorzDirection {
    is_left_to_right: bool,
    left_x: f64,
    right_x: f64,
}

// ---------------------------------------------------------------------------
// Active (Engine.ts:218-245) — arena node.
// ---------------------------------------------------------------------------

/// TS: Engine.ts:218-245 `class Active`.
#[derive(Debug, Clone, Copy)]
struct ActiveNode {
    bot: Point64,
    top: Point64,
    cur_x: f64,
    dx: f64,
    wind_dx: i32,
    wind_count: i32,
    wind_count2: i32,
    outrec: Option<usize>,
    prev_in_ael: Option<usize>,
    next_in_ael: Option<usize>,
    prev_in_sel: Option<usize>,
    next_in_sel: Option<usize>,
    jump: Option<usize>,
    vertex_top: Option<usize>,
    local_min: Option<usize>,
    is_left_bound: bool,
    join_with: JoinWith,
}

impl ActiveNode {
    fn new_zeroed() -> Self {
        let zero = Point64 {
            x: 0.0,
            y: 0.0,
            z: 0.0,
        };
        ActiveNode {
            bot: zero,
            top: zero,
            cur_x: 0.0,
            dx: 0.0,
            wind_dx: 0,
            wind_count: 0,
            wind_count2: 0,
            outrec: None,
            prev_in_ael: None,
            next_in_ael: None,
            prev_in_sel: None,
            next_in_sel: None,
            jump: None,
            vertex_top: None,
            local_min: None,
            is_left_bound: false,
            join_with: JoinWith::None,
        }
    }
}

// ---------------------------------------------------------------------------
// PolyPathBase / PolyPath64 / PolyTree64 (Engine.ts:364-469,515) — arena tree.
// ---------------------------------------------------------------------------

/// TS: Engine.ts:364-469 `PolyPathBase`/`PolyPath64` merged into one arena node (no
/// `PolyPathD` in this port's scope — see module doc). `polygon: None` marks the tree
/// root (`PolyPath64.polygon: Path64 | null`, `null` only for the polytree root itself).
#[derive(Debug, Clone)]
struct PolyPathNode {
    parent: Option<usize>,
    children: Vec<usize>,
    polygon: Option<Path64>,
}

/// TS: Engine.ts:515 `class PolyTree64 extends PolyPath64 {}` — the root of a
/// `PolyPathBase` tree. Node `0` is always the root (`polygon: None`, `parent: None`).
#[derive(Debug, Clone)]
pub struct PolyTree64 {
    nodes: Vec<PolyPathNode>,
}

impl Default for PolyTree64 {
    fn default() -> Self {
        Self::new()
    }
}

impl PolyTree64 {
    pub const ROOT: usize = 0;

    pub fn new() -> Self {
        PolyTree64 {
            nodes: vec![PolyPathNode {
                parent: None,
                children: Vec::new(),
                polygon: None,
            }],
        }
    }

    /// TS: `PolyPathBase.clear` (Engine.ts:401-403), called on the polytree root at the
    /// start of `buildTree` (Engine.ts:2909).
    pub fn clear(&mut self) {
        self.nodes.truncate(1);
        self.nodes[Self::ROOT].children.clear();
    }

    /// TS: `PolyPathBase.count` getter (Engine.ts:395-397).
    pub fn count(&self, id: usize) -> usize {
        self.nodes[id].children.len()
    }

    /// TS: `PolyPath64.child(index)` (Engine.ts:455-460). Panics like TS's
    /// `throw new Error("Index out of range")` for an out-of-range index (never reached
    /// by any ported caller, which always iterates `0..count`).
    pub fn child(&self, id: usize, index: usize) -> usize {
        self.nodes[id].children[index]
    }

    /// TS: `PolyPath64.poly` getter (Engine.ts:444-446).
    pub fn poly(&self, id: usize) -> Option<&Path64> {
        self.nodes[id].polygon.as_ref()
    }

    /// TS: `PolyPathBase.isHole` / `getLevel` (Engine.ts:372-393).
    #[allow(dead_code)] // Not read by booleanOp/booleanOpWithPolyTree/polyTreeToPaths64 today; ported for fidelity.
    pub fn is_hole(&self, id: usize) -> bool {
        let mut level = 0u32;
        let mut pp = self.nodes[id].parent;
        while let Some(p) = pp {
            level += 1;
            pp = self.nodes[p].parent;
        }
        level != 0 && level.is_multiple_of(2)
    }

    /// TS: `PolyPath64.addChild` (Engine.ts:448-453).
    fn add_child(&mut self, parent: usize, path: Path64) -> usize {
        let child_id = self.nodes.len();
        self.nodes.push(PolyPathNode {
            parent: Some(parent),
            children: Vec::new(),
            polygon: Some(path),
        });
        self.nodes[parent].children.push(child_id);
        child_id
    }
}

// ---------------------------------------------------------------------------
// Clipper64 (merges TS's `ClipperBase`, Engine.ts:523-3220, and `Clipper64`,
// Engine.ts:3222-3293 — see module doc for why the split collapses here).
// ---------------------------------------------------------------------------

/// TS: Engine.ts:523-3293 `ClipperBase` + `Clipper64`. See the module doc for the
/// arena/index design, open-path scope cut, scanline simplification, and `z`-callback
/// handling that this port applies throughout.
pub struct Clipper64 {
    vertices: Vec<VertexNode>,
    minima_list: Vec<LocalMinimaNode>,
    active_pool: Vec<ActiveNode>,
    out_pts: Vec<OutPtNode>,
    outrec_list: Vec<OutRecNode>,
    intersect_list: Vec<IntersectNode>,
    horz_seg_list: Vec<HorzSegment>,
    horz_join_list: Vec<HorzJoin>,

    cliptype: ClipType,
    fillrule: FillRule,
    actives: Option<usize>,
    sel: Option<usize>,

    scanline_heap: BinaryHeap<ScanlineY>,
    scanline_set: HashSet<u64>,

    current_loc_min: usize,
    current_bot_y: f64,
    /// TS: `private curXValidAtTop: boolean` (Engine.ts:550).
    cur_x_valid_at_top: bool,
    is_sorted_minima_list: bool,
    has_open_paths: bool,
    /// TS: `protected static openPathsEnabled: boolean` (Engine.ts:526) — a JS *static*
    /// field shared process-wide across every `ClipperBase` instance. This port never
    /// runs two overlapping `execute()` calls concurrently or re-entrantly (each
    /// `booleanOp`/`booleanOpWithPolyTree` call constructs one fresh `Clipper64` and runs
    /// it to completion before returning), so a per-instance field is behaviorally
    /// identical to the shared static for every reachable call pattern.
    open_paths_enabled: bool,
    using_polytree: bool,
    succeeded: bool,

    pub preserve_collinear: bool,
    pub reverse_solution: bool,
    /// TS: `Clipper64.zCallback?: ZCallback64` (Engine.ts:3223), read through
    /// `getZCallback()`/cached as `zCallbackInternal` (Engine.ts:558,913). The separate
    /// cache field is dropped here (pure micro-optimization against JS virtual-call
    /// overhead that doesn't apply in Rust) — see module doc, "`z` coordinates".
    pub z_callback: Option<ZCallback64>,
}

impl Default for Clipper64 {
    fn default() -> Self {
        Self::new()
    }
}

impl Clipper64 {
    /// TS: `ClipperBase` constructor (Engine.ts:563) + field initializers
    /// (Engine.ts:528-561).
    pub fn new() -> Self {
        Clipper64 {
            vertices: Vec::new(),
            minima_list: Vec::new(),
            active_pool: Vec::new(),
            out_pts: Vec::new(),
            outrec_list: Vec::new(),
            intersect_list: Vec::new(),
            horz_seg_list: Vec::new(),
            horz_join_list: Vec::new(),
            cliptype: ClipType::NoClip,
            fillrule: FillRule::EvenOdd,
            actives: None,
            sel: None,
            scanline_heap: BinaryHeap::new(),
            scanline_set: HashSet::new(),
            current_loc_min: 0,
            current_bot_y: 0.0,
            cur_x_valid_at_top: false,
            is_sorted_minima_list: false,
            has_open_paths: false,
            open_paths_enabled: true,
            using_polytree: false,
            succeeded: false,
            preserve_collinear: true,
            reverse_solution: false,
            z_callback: None,
        }
    }

    // -----------------------------------------------------------------------
    // Small static-ish helpers (Engine.ts:571-741).
    // -----------------------------------------------------------------------

    /// TS: `ClipperBase.xyEqual` (Engine.ts:571-573).
    fn xy_equal(pt1: Point64, pt2: Point64) -> bool {
        pt1.x == pt2.x && pt1.y == pt2.y
    }

    /// TS: `ClipperBase.setZ` (Engine.ts:575-608). See module doc, "`z` coordinates":
    /// a no-op on every path reachable from `booleanOp`/`booleanOpWithPolyTree`.
    fn set_z(&self, ae1: usize, ae2: usize, intersect_pt: &mut Point64) {
        let Some(z_callback) = &self.z_callback else {
            return;
        };
        let a1 = self.active_pool[ae1];
        let a2 = self.active_pool[ae2];
        if self.poly_type_of(&a1) == PathType::Subject {
            if Self::xy_equal(*intersect_pt, a1.bot) {
                intersect_pt.z = a1.bot.z_or_zero();
            } else if Self::xy_equal(*intersect_pt, a1.top) {
                intersect_pt.z = a1.top.z_or_zero();
            } else if Self::xy_equal(*intersect_pt, a2.bot) {
                intersect_pt.z = a2.bot.z_or_zero();
            } else if Self::xy_equal(*intersect_pt, a2.top) {
                intersect_pt.z = a2.top.z_or_zero();
            } else {
                intersect_pt.z = 0.0;
            }
            z_callback(a1.bot, a1.top, a2.bot, a2.top, intersect_pt);
        } else {
            if Self::xy_equal(*intersect_pt, a2.bot) {
                intersect_pt.z = a2.bot.z_or_zero();
            } else if Self::xy_equal(*intersect_pt, a2.top) {
                intersect_pt.z = a2.top.z_or_zero();
            } else if Self::xy_equal(*intersect_pt, a1.bot) {
                intersect_pt.z = a1.bot.z_or_zero();
            } else if Self::xy_equal(*intersect_pt, a1.top) {
                intersect_pt.z = a1.top.z_or_zero();
            } else {
                intersect_pt.z = 0.0;
            }
            z_callback(a2.bot, a2.top, a1.bot, a1.top, intersect_pt);
        }
    }

    /// TS: `ClipperBase.isOdd` (Engine.ts:611-613). Only called from
    /// `setWindCountForOpenPathEdge` (Engine.ts:1996-1997), which is entirely
    /// open-path-only and unreachable in this port — see module doc and
    /// [`Self::set_wind_count_for_open_path_edge`]. Ported for fidelity.
    #[allow(dead_code)]
    fn is_odd(val: i32) -> bool {
        (val & 1) != 0
    }

    /// TS: `ClipperBase.isHotEdge` (Engine.ts:615-617).
    fn is_hot_edge(ae: &ActiveNode) -> bool {
        ae.outrec.is_some()
    }

    /// TS: `ClipperBase.isOpen` (Engine.ts:619-621). Real (not stubbed) — see module doc.
    fn is_open(&self, ae: &ActiveNode) -> bool {
        self.open_paths_enabled
            && self.minima_list[ae
                .local_min
                .expect("Active.localMin always set once inserted into the AEL")]
            .is_open
    }

    /// TS: `ClipperBase.isOpenEndVertex` (Engine.ts:629-631).
    fn is_open_end_vertex(v: &VertexNode) -> bool {
        (v.flags & (vertex_flags::OPEN_START | vertex_flags::OPEN_END)) != vertex_flags::NONE
    }

    /// TS: `ClipperBase.isOpenEnd` (Engine.ts:623-627).
    fn is_open_end(&self, ae: &ActiveNode) -> bool {
        self.open_paths_enabled
            && self.minima_list[ae.local_min.expect("localMin set")].is_open
            && Self::is_open_end_vertex(&self.vertices[ae.vertex_top.expect("vertexTop set")])
    }

    /// TS: `ClipperBase.getPrevHotEdge` (Engine.ts:633-646).
    fn get_prev_hot_edge(&self, ae: usize) -> Option<usize> {
        let mut prev = self.active_pool[ae].prev_in_ael;
        if !self.open_paths_enabled {
            while let Some(p) = prev {
                if Self::is_hot_edge(&self.active_pool[p]) {
                    break;
                }
                prev = self.active_pool[p].prev_in_ael;
            }
            return prev;
        }
        while let Some(p) = prev {
            let node = &self.active_pool[p];
            let is_open_p = self.is_open(node);
            if !is_open_p && Self::is_hot_edge(node) {
                break;
            }
            prev = node.prev_in_ael;
        }
        prev
    }

    /// TS: `ClipperBase.isFront` (Engine.ts:648-650).
    fn is_front(&self, ae: usize) -> bool {
        let outrec = self.active_pool[ae]
            .outrec
            .expect("isFront requires a hot edge");
        self.outrec_list[outrec].front_edge == Some(ae)
    }

    /// TS: `ClipperBase.getDx` (Engine.ts:658-664).
    fn get_dx(pt1: Point64, pt2: Point64) -> f64 {
        let dy = pt2.y - pt1.y;
        if dy != 0.0 {
            (pt2.x - pt1.x) / dy
        } else if pt2.x > pt1.x {
            f64::NEG_INFINITY
        } else {
            f64::INFINITY
        }
    }

    /// TS: `ClipperBase.topX` (Engine.ts:666-672).
    fn top_x(ae: &ActiveNode, current_y: f64) -> f64 {
        if current_y == ae.top.y || ae.top.x == ae.bot.x {
            return ae.top.x;
        }
        if current_y == ae.bot.y {
            return ae.bot.x;
        }
        round_to_even(ae.bot.x + ae.dx * (current_y - ae.bot.y))
    }

    /// TS: `ClipperBase.isHorizontal` (Engine.ts:674-678).
    fn is_horizontal(ae: &ActiveNode) -> bool {
        ae.dx == f64::NEG_INFINITY || ae.dx == f64::INFINITY
    }

    /// TS: `ClipperBase.isHeadingRightHorz` (Engine.ts:680-682).
    fn is_heading_right_horz(ae: &ActiveNode) -> bool {
        ae.dx == f64::NEG_INFINITY
    }

    /// TS: `ClipperBase.isHeadingLeftHorz` (Engine.ts:684-686).
    fn is_heading_left_horz(ae: &ActiveNode) -> bool {
        ae.dx == f64::INFINITY
    }

    /// TS: `ClipperBase.getPolyType` (Engine.ts:688-690). Needs `&self` (unlike TS's
    /// version, which reads through the JS object reference `ae.localMin!.polytype`
    /// directly) because `Active.local_min` is an arena index here.
    fn poly_type_of(&self, ae: &ActiveNode) -> PathType {
        self.minima_list[ae.local_min.expect("localMin set")].polytype
    }

    /// TS: `ClipperBase.isSamePolyType` (Engine.ts:692-694). TS's one reachable call
    /// site in the ported subset (`intersectEdges`, Engine.ts:2530) is translated as
    /// a direct `ae1_polytype != ae2_polytype` comparison on already-fetched owned
    /// `PathType` values instead (see [`Self::intersect_edges`]) — those values are
    /// fetched once up front (via [`Self::poly_type_of_owned`]) and reused across
    /// several branches, so re-deriving them through this `&ActiveNode`-borrowing
    /// helper would require re-borrowing `self.active_pool` mid-function. Kept for
    /// fidelity (its only reachable TS call site is `doHorizontal`'s open-path branch
    /// otherwise, Engine.ts:1126, which is unreachable here — see module doc).
    #[allow(dead_code)]
    fn is_same_poly_type(&self, ae1: &ActiveNode, ae2: &ActiveNode) -> bool {
        self.poly_type_of(ae1) == self.poly_type_of(ae2)
    }

    /// TS: `ClipperBase.setDx` (Engine.ts:696-698).
    fn set_dx(ae: &mut ActiveNode) {
        ae.dx = Self::get_dx(ae.bot, ae.top);
    }

    /// TS: `ClipperBase.nextVertex` (Engine.ts:700-702). Takes an `Active` id (not a
    /// `&ActiveNode`, unlike most other tiny static-ish helpers here) since the two
    /// vertex-chain-walking helpers below have several `usize`-returning call sites
    /// nested inside loops that also need `&mut self` access to the same `active_pool`
    /// slot immediately after — passing the id keeps every call site a simple,
    /// borrow-check-friendly `self.next_vertex(ae)`.
    fn next_vertex(&self, ae: usize) -> usize {
        let node = self.active_pool[ae];
        let vt = node.vertex_top.expect("vertexTop set");
        if node.wind_dx > 0 {
            self.vertices[vt].next.expect("next set")
        } else {
            self.vertices[vt].prev.expect("prev set")
        }
    }

    /// TS: `ClipperBase.prevPrevVertex` (Engine.ts:704-706). See [`Self::next_vertex`]'s
    /// doc comment for why this takes an id.
    fn prev_prev_vertex(&self, ae: usize) -> usize {
        let node = self.active_pool[ae];
        let vt = node.vertex_top.expect("vertexTop set");
        if node.wind_dx > 0 {
            let p = self.vertices[vt].prev.expect("prev set");
            self.vertices[p].prev.expect("prev.prev set")
        } else {
            let n = self.vertices[vt].next.expect("next set");
            self.vertices[n].next.expect("next.next set")
        }
    }

    /// TS: `ClipperBase.isMaximaVertex` (Engine.ts:708-710).
    fn is_maxima_vertex(v: &VertexNode) -> bool {
        (v.flags & vertex_flags::LOCAL_MAX) != vertex_flags::NONE
    }

    /// TS: `ClipperBase.isMaximaEdge` (Engine.ts:712-714).
    fn is_maxima_edge(&self, ae: &ActiveNode) -> bool {
        let vt = ae.vertex_top.expect("vertexTop set");
        Self::is_maxima_vertex(&self.vertices[vt])
    }

    /// TS: `ClipperBase.getMaximaPair` (Engine.ts:716-723).
    fn get_maxima_pair(&self, ae: usize) -> Option<usize> {
        let mut ae2 = self.active_pool[ae].next_in_ael;
        while let Some(a2) = ae2 {
            if self.active_pool[a2].vertex_top == self.active_pool[ae].vertex_top {
                return Some(a2);
            }
            ae2 = self.active_pool[a2].next_in_ael;
        }
        None
    }

    /// TS: `ClipperBase.boundingBoxesOverlap` (Engine.ts:726-741).
    fn bounding_boxes_overlap(p1: Point64, p2: Point64, p3: Point64, p4: Point64) -> bool {
        let min1x = if p1.x < p2.x { p1.x } else { p2.x };
        let max2x = if p3.x > p4.x { p3.x } else { p4.x };
        if max2x < min1x {
            return false;
        }
        let max1x = if p1.x > p2.x { p1.x } else { p2.x };
        let min2x = if p3.x < p4.x { p3.x } else { p4.x };
        if max1x < min2x {
            return false;
        }
        let min1y = if p1.y < p2.y { p1.y } else { p2.y };
        let max2y = if p3.y > p4.y { p3.y } else { p4.y };
        if max2y < min1y {
            return false;
        }
        let max1y = if p1.y > p2.y { p1.y } else { p2.y };
        let min2y = if p3.y < p4.y { p3.y } else { p4.y };
        max1y >= min2y
    }

    // -----------------------------------------------------------------------
    // clear / reset / scanline management (Engine.ts:743-850).
    // -----------------------------------------------------------------------

    /// TS: `ClipperBase.clearSolutionOnly` (Engine.ts:743-752).
    fn clear_solution_only(&mut self) {
        while let Some(a) = self.actives {
            self.delete_from_ael(a);
        }
        self.scanline_heap.clear();
        self.scanline_set.clear();
        self.dispose_intersect_nodes();
        self.outrec_list.clear();
        self.horz_seg_list.clear();
        self.horz_join_list.clear();
    }

    /// TS: `ClipperBase.clear` (Engine.ts:754-761). Not called by this port's public API
    /// (each `booleanOp` call constructs a fresh `Clipper64`, matching TS's own usage at
    /// `Clipper.ts:84,95`) — ported for fidelity/future reuse.
    #[allow(dead_code)]
    fn clear(&mut self) {
        self.clear_solution_only();
        self.minima_list.clear();
        self.vertices.clear();
        self.current_loc_min = 0;
        self.is_sorted_minima_list = false;
        self.has_open_paths = false;
    }

    /// TS: `ClipperBase.reset` (Engine.ts:763-785).
    fn reset(&mut self) {
        if !self.is_sorted_minima_list {
            // TS: `this.minimaList.sort((a, b) => b.vertex.pt.y - a.vertex.pt.y);` —
            // stable (ES2019+ `Array.sort`), descending by vertex Y. `partial_cmp` is a
            // faithful stand-in for the sign of the float subtraction here (see
            // `compare_horz_segments`'s doc for the same reasoning); coordinates are
            // always finite.
            let vertices = &self.vertices;
            self.minima_list.sort_by(|a, b| {
                let ay = vertices[a.vertex].pt.y;
                let by = vertices[b.vertex].pt.y;
                by.partial_cmp(&ay).unwrap_or(std::cmp::Ordering::Equal)
            });
            self.is_sorted_minima_list = true;
        }

        self.scanline_heap.clear();
        self.scanline_set.clear();
        for i in (0..self.minima_list.len()).rev() {
            let y = self.vertices[self.minima_list[i].vertex].pt.y;
            self.insert_scanline(y);
        }

        self.current_bot_y = 0.0;
        self.current_loc_min = 0;
        self.actives = None;
        self.sel = None;
        self.cur_x_valid_at_top = false;
        self.succeeded = true;
    }

    /// TS: `ClipperBase.insertScanline` (Engine.ts:800-815). See module doc for why the
    /// dual array/heap mode collapses to heap-only here.
    fn insert_scanline(&mut self, y: f64) {
        if self.scanline_set.insert(scanline_key(y)) {
            self.scanline_heap.push(ScanlineY(y));
        }
    }

    /// TS: `ClipperBase.popScanline` (Engine.ts:819-841).
    fn pop_scanline(&mut self) -> Option<f64> {
        let ScanlineY(y) = self.scanline_heap.pop()?;
        self.scanline_set.remove(&scanline_key(y));
        Some(y)
    }

    /// TS: `ClipperBase.hasLocMinAtY` (Engine.ts:843-846).
    fn has_loc_min_at_y(&self, y: f64) -> bool {
        self.current_loc_min < self.minima_list.len()
            && self.vertices[self.minima_list[self.current_loc_min].vertex]
                .pt
                .y
                == y
    }

    /// TS: `ClipperBase.popLocalMinima` (Engine.ts:848-850).
    fn pop_local_minima(&mut self) -> usize {
        let idx = self.current_loc_min;
        self.current_loc_min += 1;
        idx
    }

    // -----------------------------------------------------------------------
    // addPath / addPaths (Engine.ts:852-873, Engine.ts:3229-3251). Only the
    // closed-path (`is_open = false`) surface is exposed — see module doc.
    // -----------------------------------------------------------------------

    /// TS: `ClipperBase.addPaths` (Engine.ts:857-861) + `Clipper64.addPaths`
    /// (Engine.ts:3237-3239), specialized to `isOpen = false` (see module doc). Public
    /// per the assignment's "public booleanOp/booleanOpWithPolyTree/polyTreeToPaths64
    /// wrappers" surface — `booleanOp`/`booleanOpWithPolyTree` call this directly
    /// (`Clipper.ts:85,87,96,98`).
    pub fn add_paths(&mut self, paths: &Paths64, polytype: PathType) {
        self.is_sorted_minima_list = false;
        Self::add_paths_to_vertex_list(
            paths,
            polytype,
            false,
            &mut self.minima_list,
            &mut self.vertices,
        );
    }

    /// TS: `ClipperEngine.addPathsToVertexList` (Engine.ts:258-342). `isOpen` is kept as
    /// a real parameter (always `false` from this port's only caller) rather than
    /// special-cased away — see module doc.
    fn add_paths_to_vertex_list(
        paths: &Paths64,
        polytype: PathType,
        is_open: bool,
        minima_list: &mut Vec<LocalMinimaNode>,
        vertices: &mut Vec<VertexNode>,
    ) {
        for path in paths {
            let mut v0: Option<usize> = None;
            let mut prev_v: Option<usize> = None;
            let mut prev_pt: Option<Point64> = None;

            for &pt in path {
                if v0.is_none() {
                    let id = vertices.len();
                    vertices.push(VertexNode {
                        pt,
                        next: None,
                        prev: None,
                        flags: vertex_flags::NONE,
                    });
                    v0 = Some(id);
                    prev_v = Some(id);
                    prev_pt = Some(pt);
                } else if !(prev_pt.expect("set once v0 is set").x == pt.x
                    && prev_pt.expect("set").y == pt.y)
                {
                    let id = vertices.len();
                    vertices.push(VertexNode {
                        pt,
                        next: None,
                        prev: prev_v,
                        flags: vertex_flags::NONE,
                    });
                    vertices[prev_v.expect("set")].next = Some(id);
                    prev_v = Some(id);
                    prev_pt = Some(pt);
                }
            }

            let Some(mut prev_v_id) = prev_v else {
                continue;
            };
            let v0_id = v0.expect("prev_v set implies v0 set");
            if vertices[prev_v_id].prev.is_none() {
                continue;
            }
            if !is_open
                && vertices[prev_v_id].pt.x == vertices[v0_id].pt.x
                && vertices[prev_v_id].pt.y == vertices[v0_id].pt.y
            {
                prev_v_id = vertices[prev_v_id].prev.expect("checked above");
            }
            vertices[prev_v_id].next = Some(v0_id);
            vertices[v0_id].prev = Some(prev_v_id);
            if !is_open && vertices[prev_v_id].next == Some(prev_v_id) {
                continue;
            }

            // OK, we have a valid path
            let mut going_up: bool;
            if is_open {
                let mut curr_v = vertices[v0_id].next.expect("wired above");
                while curr_v != v0_id && vertices[curr_v].pt.y == vertices[v0_id].pt.y {
                    curr_v = vertices[curr_v].next.expect("closed ring");
                }
                going_up = vertices[curr_v].pt.y <= vertices[v0_id].pt.y;
                if going_up {
                    vertices[v0_id].flags = vertex_flags::OPEN_START;
                    Self::add_loc_min(v0_id, polytype, true, minima_list, vertices);
                } else {
                    vertices[v0_id].flags = vertex_flags::OPEN_START | vertex_flags::LOCAL_MAX;
                }
            } else {
                let mut pv = vertices[v0_id].prev.expect("wired above");
                while pv != v0_id && vertices[pv].pt.y == vertices[v0_id].pt.y {
                    pv = vertices[pv].prev.expect("closed ring");
                }
                if pv == v0_id {
                    continue; // only open paths can be completely flat
                }
                going_up = vertices[pv].pt.y > vertices[v0_id].pt.y;
            }

            let going_up0 = going_up;
            let mut prev_v_walk = v0_id;
            let mut curr_v = vertices[v0_id].next.expect("wired above");
            while curr_v != v0_id {
                if vertices[curr_v].pt.y > vertices[prev_v_walk].pt.y && going_up {
                    vertices[prev_v_walk].flags |= vertex_flags::LOCAL_MAX;
                    going_up = false;
                } else if vertices[curr_v].pt.y < vertices[prev_v_walk].pt.y && !going_up {
                    going_up = true;
                    Self::add_loc_min(prev_v_walk, polytype, is_open, minima_list, vertices);
                }
                prev_v_walk = curr_v;
                curr_v = vertices[curr_v].next.expect("closed ring");
            }

            if is_open {
                vertices[prev_v_walk].flags |= vertex_flags::OPEN_END;
                if going_up {
                    vertices[prev_v_walk].flags |= vertex_flags::LOCAL_MAX;
                } else {
                    Self::add_loc_min(prev_v_walk, polytype, is_open, minima_list, vertices);
                }
            } else if going_up != going_up0 {
                if going_up0 {
                    Self::add_loc_min(prev_v_walk, polytype, false, minima_list, vertices);
                } else {
                    vertices[prev_v_walk].flags |= vertex_flags::LOCAL_MAX;
                }
            }
        }
    }

    /// TS: `ClipperEngine.addLocMin` (Engine.ts:249-256).
    fn add_loc_min(
        vert: usize,
        polytype: PathType,
        is_open: bool,
        minima_list: &mut Vec<LocalMinimaNode>,
        vertices: &mut [VertexNode],
    ) {
        if (vertices[vert].flags & vertex_flags::LOCAL_MIN) != vertex_flags::NONE {
            return;
        }
        vertices[vert].flags |= vertex_flags::LOCAL_MIN;
        minima_list.push(LocalMinimaNode {
            vertex: vert,
            polytype,
            is_open,
        });
    }

    /// TS: `ClipperBase.deleteFromAEL` (Engine.ts:875-886).
    fn delete_from_ael(&mut self, ae: usize) {
        let prev = self.active_pool[ae].prev_in_ael;
        let next = self.active_pool[ae].next_in_ael;
        if prev.is_none() && next.is_none() && self.actives != Some(ae) {
            return; // already deleted
        }
        if let Some(p) = prev {
            self.active_pool[p].next_in_ael = next;
        } else {
            self.actives = next;
        }
        if let Some(n) = next {
            self.active_pool[n].prev_in_ael = prev;
        }
        // TS: `// delete ae;` (Engine.ts:885) — commented out, relying on GC; this port's
        // arena never reclaims slots either (see module doc).
    }

    /// TS: `ClipperBase.getBounds` (Engine.ts:888-908). Not called by
    /// `booleanOp`/`booleanOpWithPolyTree`/`polyTreeToPaths64` themselves, but ported for
    /// completeness/fidelity (public surface on `ClipperBase`).
    #[allow(dead_code)]
    pub fn get_bounds(&self) -> Rect64 {
        let mut bounds = Rect64 {
            left: core::MAX_SAFE_INTEGER,
            top: core::MAX_SAFE_INTEGER,
            right: core::MIN_SAFE_INTEGER,
            bottom: core::MIN_SAFE_INTEGER,
        };
        for head in self.head_vertex_ids() {
            let mut v = head;
            loop {
                let node = self.vertices[v];
                if node.pt.x < bounds.left {
                    bounds.left = node.pt.x;
                }
                if node.pt.x > bounds.right {
                    bounds.right = node.pt.x;
                }
                if node.pt.y < bounds.top {
                    bounds.top = node.pt.y;
                }
                if node.pt.y > bounds.bottom {
                    bounds.bottom = node.pt.y;
                }
                v = node.next.expect("closed ring");
                if v == head {
                    break;
                }
            }
        }
        if rect64_utils::is_empty(bounds) {
            Rect64 {
                left: 0.0,
                top: 0.0,
                right: 0.0,
                bottom: 0.0,
            }
        } else {
            bounds
        }
    }

    /// TS: `for (const t of this.vertexList)` (Engine.ts:896) iterates only the head
    /// vertex of each path (`addPathsToVertexList` pushes exactly one `Vertex` per path
    /// into `vertexList`, Engine.ts:275-277 `vertexList.push(v0)` — the rest of each
    /// path's vertices are reachable only via the `next`/`prev` chain, never pushed
    /// directly). This port's arena instead stores *every* vertex node in one flat
    /// `Vec`, so it cannot distinguish "head" vertices positionally; `get_bounds` walks
    /// the whole arena once via a same-shaped reconstruction. Since `get_bounds` is not
    /// on the critical path for the three assigned entry points, correctness (not
    /// micro-optimality) is what matters here — this helper is intentionally simple.
    fn head_vertex_ids(&self) -> Vec<usize> {
        // A vertex is a "head" (i.e. was the `v0` of some `addPaths` call) precisely if
        // no earlier vertex ever set it as `.next` during construction — equivalently,
        // walking predecessors from any vertex and stopping at the first index we've
        // already visited reconstructs each ring exactly once. Simpler and always
        // correct: every vertex belongs to exactly one circular ring, so collect one
        // representative per ring by a visited-set sweep.
        let mut seen = vec![false; self.vertices.len()];
        let mut heads = Vec::new();
        for start in 0..self.vertices.len() {
            if seen[start] {
                continue;
            }
            heads.push(start);
            let mut v = start;
            loop {
                seen[v] = true;
                let Some(next) = self.vertices[v].next else {
                    break;
                };
                if next == start {
                    break;
                }
                v = next;
            }
        }
        heads
    }

    /// Pushes a fresh, zeroed `Active` node into the arena and returns its id — the
    /// Rust-side equivalent of TS's `new Active()` (Engine.ts:950,966, etc.).
    fn new_active(&mut self) -> usize {
        let id = self.active_pool.len();
        self.active_pool.push(ActiveNode::new_zeroed());
        id
    }

    /// TS: `ClipperBase.executeInternal` (Engine.ts:910-938).
    fn execute_internal(&mut self, ct: ClipType, fill_rule: FillRule) {
        if ct == ClipType::NoClip {
            return;
        }
        self.open_paths_enabled = self.has_open_paths;
        self.fillrule = fill_rule;
        self.cliptype = ct;
        self.reset();

        let Some(mut y) = self.pop_scanline() else {
            return;
        };

        while self.succeeded {
            self.insert_local_minima_into_ael(y);
            while let Some(ae) = self.pop_horz() {
                self.do_horizontal(ae);
            }
            if !self.horz_seg_list.is_empty() {
                self.convert_horz_segs_to_joins();
                self.horz_seg_list.clear();
            }
            self.current_bot_y = y;
            let Some(next_y) = self.pop_scanline() else {
                break;
            };
            y = next_y;
            self.do_intersections(y);
            self.do_top_of_scanbeam(y);
            while let Some(ae) = self.pop_horz() {
                self.do_horizontal(ae);
            }
        }
        if self.succeeded {
            self.process_horz_joins();
        }
    }

    /// TS: `ClipperBase.insertLocalMinimaIntoAEL` (Engine.ts:940-1053).
    fn insert_local_minima_into_ael(&mut self, bot_y: f64) {
        while self.has_loc_min_at_y(bot_y) {
            let local_minima_id = self.pop_local_minima();
            let lm_vertex = self.minima_list[local_minima_id].vertex;
            let lm_flags = self.vertices[lm_vertex].flags;
            let lm_pt = self.vertices[lm_vertex].pt;

            let mut left_bound: Option<usize> =
                if (lm_flags & vertex_flags::OPEN_START) != vertex_flags::NONE {
                    None
                } else {
                    let id = self.new_active();
                    let prev_v = self.vertices[lm_vertex]
                        .prev
                        .expect("closed-path local minima always has a prev vertex");
                    let a = &mut self.active_pool[id];
                    a.bot = lm_pt;
                    a.cur_x = lm_pt.x;
                    a.wind_dx = -1;
                    a.vertex_top = Some(prev_v);
                    a.top = self.vertices[prev_v].pt;
                    a.outrec = None;
                    a.local_min = Some(local_minima_id);
                    Self::set_dx(&mut self.active_pool[id]);
                    Some(id)
                };

            let mut right_bound: Option<usize> =
                if (lm_flags & vertex_flags::OPEN_END) != vertex_flags::NONE {
                    None
                } else {
                    let id = self.new_active();
                    let next_v = self.vertices[lm_vertex]
                        .next
                        .expect("closed-path local minima always has a next vertex");
                    let a = &mut self.active_pool[id];
                    a.bot = lm_pt;
                    a.cur_x = lm_pt.x;
                    a.wind_dx = 1;
                    a.vertex_top = Some(next_v);
                    a.top = self.vertices[next_v].pt;
                    a.outrec = None;
                    a.local_min = Some(local_minima_id);
                    Self::set_dx(&mut self.active_pool[id]);
                    Some(id)
                };

            if let (Some(lb), Some(rb)) = (left_bound, right_bound) {
                if Self::is_horizontal(&self.active_pool[lb]) {
                    if Self::is_heading_right_horz(&self.active_pool[lb]) {
                        std::mem::swap(&mut left_bound, &mut right_bound);
                    }
                } else if Self::is_horizontal(&self.active_pool[rb]) {
                    if Self::is_heading_left_horz(&self.active_pool[rb]) {
                        std::mem::swap(&mut left_bound, &mut right_bound);
                    }
                } else if self.active_pool[lb].dx < self.active_pool[rb].dx {
                    std::mem::swap(&mut left_bound, &mut right_bound);
                }
            } else if left_bound.is_none() {
                left_bound = right_bound;
                right_bound = None;
            }

            let left_bound = left_bound.expect(
                "left_bound is always Some here, mirroring TS's `leftBound!` non-null assertions",
            );

            self.active_pool[left_bound].is_left_bound = true;
            self.insert_left_edge(left_bound);

            let contributing = if !self.open_paths_enabled {
                self.set_wind_count_for_closed_path_edge(left_bound);
                self.is_contributing_closed(left_bound)
            } else if self.is_open(&self.active_pool[left_bound]) {
                self.set_wind_count_for_open_path_edge(left_bound);
                self.is_contributing_open(left_bound)
            } else {
                self.set_wind_count_for_closed_path_edge(left_bound);
                self.is_contributing_closed(left_bound)
            };

            if let Some(right_bound) = right_bound {
                self.active_pool[right_bound].wind_count = self.active_pool[left_bound].wind_count;
                self.active_pool[right_bound].wind_count2 =
                    self.active_pool[left_bound].wind_count2;
                self.insert_right_edge(left_bound, right_bound);

                if contributing {
                    let left_bot = self.active_pool[left_bound].bot;
                    self.add_local_min_poly(left_bound, right_bound, left_bot, true);
                    if !Self::is_horizontal(&self.active_pool[left_bound]) {
                        let left_bot = self.active_pool[left_bound].bot;
                        self.check_join_left(left_bound, left_bot, false);
                    }
                }

                while let Some(next) = self.active_pool[right_bound].next_in_ael {
                    if !self.is_valid_ael_order(next, right_bound) {
                        break;
                    }
                    let rb_bot = self.active_pool[right_bound].bot;
                    self.intersect_edges(right_bound, next, rb_bot);
                    self.swap_positions_in_ael(right_bound, next);
                }

                if Self::is_horizontal(&self.active_pool[right_bound]) {
                    self.push_horz(right_bound);
                } else {
                    let rb_bot = self.active_pool[right_bound].bot;
                    self.check_join_right(right_bound, rb_bot, false);
                    let rb_top_y = self.active_pool[right_bound].top.y;
                    self.insert_scanline(rb_top_y);
                }
            } else if contributing && self.open_paths_enabled {
                let left_bot = self.active_pool[left_bound].bot;
                self.start_open_path(left_bound, left_bot);
            }

            if Self::is_horizontal(&self.active_pool[left_bound]) {
                self.push_horz(left_bound);
            } else {
                let left_top_y = self.active_pool[left_bound].top.y;
                self.insert_scanline(left_top_y);
            }
        }
    }

    /// TS: `ClipperBase.pushHorz` (Engine.ts:1055-1058).
    fn push_horz(&mut self, ae: usize) {
        self.active_pool[ae].next_in_sel = self.sel;
        self.sel = Some(ae);
    }

    /// TS: `ClipperBase.popHorz` (Engine.ts:1060-1065).
    fn pop_horz(&mut self) -> Option<usize> {
        let ae = self.sel?;
        self.sel = self.active_pool[ae].next_in_sel;
        Some(ae)
    }

    /// TS: `ClipperBase.doHorizontal` (Engine.ts:1067-1071's dispatch only — see module
    /// doc, "Open paths are unreachable"). The general open-path-aware body
    /// (Engine.ts:1072-1196) is never reached from this port's public API and is not
    /// ported; [`Self::do_horizontal_closed`] (Engine.ts:1198-1290) is what always runs.
    fn do_horizontal(&mut self, horz: usize) {
        if !self.open_paths_enabled {
            self.do_horizontal_closed(horz);
            return;
        }
        unreachable!(
            "open-path doHorizontal (Engine.ts:1067-1196) not ported: this port's add_paths \
             never sets is_open, so open_paths_enabled is always false"
        );
    }

    /// TS: `ClipperBase.doHorizontalClosed` (Engine.ts:1198-1290).
    fn do_horizontal_closed(&mut self, horz: usize) {
        let y = self.active_pool[horz].bot.y;
        let vertex_max = self.get_curr_y_maxima_vertex(horz);

        let dir = self.reset_horz_direction(horz, vertex_max);
        let is_left_to_right = dir.is_left_to_right;
        let mut left_x2 = dir.left_x;
        let mut right_x2 = dir.right_x;

        if Self::is_hot_edge(&self.active_pool[horz]) {
            let cur_x = self.active_pool[horz].cur_x;
            let op = self.add_out_pt(
                horz,
                Point64 {
                    x: cur_x,
                    y,
                    z: 0.0,
                },
            );
            self.add_to_horz_seg_list(op);
        }

        loop {
            let mut ae = if is_left_to_right {
                self.active_pool[horz].next_in_ael
            } else {
                self.active_pool[horz].prev_in_ael
            };

            while let Some(a) = ae {
                if self.active_pool[a].vertex_top == vertex_max {
                    if Self::is_hot_edge(&self.active_pool[horz]) && self.is_joined(a) {
                        let a_top = self.active_pool[a].top;
                        self.split(a, a_top);
                    }

                    if Self::is_hot_edge(&self.active_pool[horz]) {
                        while self.active_pool[horz].vertex_top != vertex_max {
                            let horz_top = self.active_pool[horz].top;
                            self.add_out_pt(horz, horz_top);
                            self.update_edge_into_ael(horz);
                        }
                        let horz_top = self.active_pool[horz].top;
                        if is_left_to_right {
                            self.add_local_max_poly(horz, a, horz_top);
                        } else {
                            self.add_local_max_poly(a, horz, horz_top);
                        }
                    }
                    self.delete_from_ael(a);
                    self.delete_from_ael(horz);
                    return;
                }

                if vertex_max != self.active_pool[horz].vertex_top {
                    let a_cur_x = self.active_pool[a].cur_x;
                    if (is_left_to_right && a_cur_x > right_x2)
                        || (!is_left_to_right && a_cur_x < left_x2)
                    {
                        break;
                    }

                    if a_cur_x == self.active_pool[horz].top.x
                        && !Self::is_horizontal(&self.active_pool[a])
                    {
                        let next_vertex_id = self.next_vertex(horz);
                        let next_pt = self.vertices[next_vertex_id].pt;
                        let tx = Self::top_x(&self.active_pool[a], next_pt.y);
                        if (is_left_to_right && tx >= next_pt.x)
                            || (!is_left_to_right && tx <= next_pt.x)
                        {
                            break;
                        }
                    }
                }

                let a_cur_x = self.active_pool[a].cur_x;
                let pt = Point64 {
                    x: a_cur_x,
                    y,
                    z: 0.0,
                };

                if is_left_to_right {
                    self.intersect_edges(horz, a, pt);
                    self.swap_positions_in_ael(horz, a);
                    self.check_join_left(a, pt, false);
                    self.active_pool[horz].cur_x = self.active_pool[a].cur_x;
                    ae = self.active_pool[horz].next_in_ael;
                } else {
                    self.intersect_edges(a, horz, pt);
                    self.swap_positions_in_ael(a, horz);
                    self.check_join_right(a, pt, false);
                    self.active_pool[horz].cur_x = self.active_pool[a].cur_x;
                    ae = self.active_pool[horz].prev_in_ael;
                }

                if Self::is_hot_edge(&self.active_pool[horz]) {
                    let last_op = self.get_last_op(horz);
                    self.add_to_horz_seg_list(last_op);
                }
            }

            let next_vertex_id = self.next_vertex(horz);
            if self.vertices[next_vertex_id].pt.y != self.active_pool[horz].top.y {
                break;
            }

            if Self::is_hot_edge(&self.active_pool[horz]) {
                let horz_top = self.active_pool[horz].top;
                self.add_out_pt(horz, horz_top);
            }

            self.update_edge_into_ael(horz);

            let reset_result = self.reset_horz_direction(horz, vertex_max);
            left_x2 = reset_result.left_x;
            right_x2 = reset_result.right_x;
        }

        if Self::is_hot_edge(&self.active_pool[horz]) {
            let horz_top = self.active_pool[horz].top;
            let op = self.add_out_pt(horz, horz_top);
            self.add_to_horz_seg_list(op);
        }

        self.update_edge_into_ael(horz);
    }

    /// TS: `ClipperBase.convertHorzSegsToJoins` (Engine.ts:1292-1339).
    fn convert_horz_segs_to_joins(&mut self) {
        let mut k = 0usize;
        for i in 0..self.horz_seg_list.len() {
            let hs = self.horz_seg_list[i];
            let (keep, updated) = self.update_horz_segment(hs);
            if keep {
                self.horz_seg_list[k] = updated;
                k += 1;
            }
        }
        if k < 2 {
            return;
        }
        self.horz_seg_list.truncate(k);

        let out_pts = &self.out_pts;
        self.horz_seg_list
            .sort_by(|a, b| compare_horz_segments(a, b, out_pts));

        for i in 0..k - 1 {
            let hs1 = self.horz_seg_list[i];
            for j in (i + 1)..k {
                let hs2 = self.horz_seg_list[j];
                let hs2_left_x = self.out_pts[hs2.left_op].pt.x;
                let hs1_right_x = self.out_pts
                    [hs1.right_op.expect("compacted entries have rightOp")]
                .pt
                .x;
                let hs1_left_x = self.out_pts[hs1.left_op].pt.x;
                let hs2_right_x = self.out_pts
                    [hs2.right_op.expect("compacted entries have rightOp")]
                .pt
                .x;
                if hs2_left_x >= hs1_right_x
                    || hs2.left_to_right == hs1.left_to_right
                    || hs2_right_x <= hs1_left_x
                {
                    continue;
                }
                let curr_y = self.out_pts[hs1.left_op].pt.y;
                let mut hs1_left = hs1.left_op;
                let mut hs2_left = hs2.left_op;
                if hs1.left_to_right {
                    loop {
                        let next = self.out_pts[hs1_left].next;
                        if self.out_pts[next].pt.y == curr_y
                            && self.out_pts[next].pt.x <= self.out_pts[hs2_left].pt.x
                        {
                            hs1_left = next;
                        } else {
                            break;
                        }
                    }
                    loop {
                        let prev = self.out_pts[hs2_left].prev;
                        if self.out_pts[prev].pt.y == curr_y
                            && self.out_pts[prev].pt.x <= self.out_pts[hs1_left].pt.x
                        {
                            hs2_left = prev;
                        } else {
                            break;
                        }
                    }
                    let op1 = self.duplicate_op(hs1_left, true);
                    let op2 = self.duplicate_op(hs2_left, false);
                    self.horz_join_list.push(HorzJoin { op1, op2 });
                } else {
                    loop {
                        let prev = self.out_pts[hs1_left].prev;
                        if self.out_pts[prev].pt.y == curr_y
                            && self.out_pts[prev].pt.x <= self.out_pts[hs2_left].pt.x
                        {
                            hs1_left = prev;
                        } else {
                            break;
                        }
                    }
                    loop {
                        let next = self.out_pts[hs2_left].next;
                        if self.out_pts[next].pt.y == curr_y
                            && self.out_pts[next].pt.x <= self.out_pts[hs1_left].pt.x
                        {
                            hs2_left = next;
                        } else {
                            break;
                        }
                    }
                    let op1 = self.duplicate_op(hs2_left, true);
                    let op2 = self.duplicate_op(hs1_left, false);
                    self.horz_join_list.push(HorzJoin { op1, op2 });
                }
            }
        }
    }

    /// TS: `ClipperBase.updateHorzSegment` (Engine.ts:1341-1371). Mutates `hs` in place
    /// in TS (object reference); this port takes `hs` by value and returns
    /// `(success, mutated hs)` for the caller to write back
    /// (see [`Self::convert_horz_segs_to_joins`]), since `horz_seg_list` entries are
    /// plain values (see module doc).
    fn update_horz_segment(&mut self, mut hs: HorzSegment) -> (bool, HorzSegment) {
        let op = hs.left_op;
        let outrec = self
            .get_real_out_rec(Some(self.out_pts[op].outrec))
            .expect("hot outrec always resolves");
        let outrec_has_edges = self.outrec_list[outrec].front_edge.is_some();
        let curr_y = self.out_pts[op].pt.y;
        let mut op_p = op;
        let mut op_n = op;

        if outrec_has_edges {
            let op_a = self.outrec_list[outrec].pts.expect("hot outrec has pts");
            let op_z = self.out_pts[op_a].next;
            while op_p != op_z && self.out_pts[self.out_pts[op_p].prev].pt.y == curr_y {
                op_p = self.out_pts[op_p].prev;
            }
            while op_n != op_a && self.out_pts[self.out_pts[op_n].next].pt.y == curr_y {
                op_n = self.out_pts[op_n].next;
            }
        } else {
            while self.out_pts[op_p].prev != op_n
                && self.out_pts[self.out_pts[op_p].prev].pt.y == curr_y
            {
                op_p = self.out_pts[op_p].prev;
            }
            while self.out_pts[op_n].next != op_p
                && self.out_pts[self.out_pts[op_n].next].pt.y == curr_y
            {
                op_n = self.out_pts[op_n].next;
            }
        }

        let ok = Self::set_horz_seg_heading_forward(&mut hs, op_p, op_n, &self.out_pts);
        let result = ok && !self.out_pts[hs.left_op].horz;

        if result {
            // TS: `hs.leftOp!.horz = hs;` — see [`OutPtNode::horz`]'s doc comment: this
            // field is intentionally never reset back to `false`, matching TS's field
            // never being reset back to `null` — a deliberate, preserved quirk (R3):
            // once an `OutPt` has ever headed a successfully-oriented horizontal
            // segment (in *any* scanbeam of this execution), it can never head another
            // one, even in a later scanbeam.
            self.out_pts[hs.left_op].horz = true;
        } else {
            hs.right_op = None; // (for sorting)
        }
        (result, hs)
    }

    /// TS: `ClipperBase.setHorzSegHeadingForward` (Engine.ts:1373-1385).
    fn set_horz_seg_heading_forward(
        hs: &mut HorzSegment,
        op_p: usize,
        op_n: usize,
        out_pts: &[OutPtNode],
    ) -> bool {
        if out_pts[op_p].pt.x == out_pts[op_n].pt.x {
            return false;
        }
        if out_pts[op_p].pt.x < out_pts[op_n].pt.x {
            hs.left_op = op_p;
            hs.right_op = Some(op_n);
            hs.left_to_right = true;
        } else {
            hs.left_op = op_n;
            hs.right_op = Some(op_p);
            hs.left_to_right = false;
        }
        true
    }

    /// TS: `ClipperBase.duplicateOp` (Engine.ts:1387-1401).
    fn duplicate_op(&mut self, op: usize, insert_after: bool) -> usize {
        let pt = self.out_pts[op].pt;
        let outrec = self.out_pts[op].outrec;
        let result = self.out_pts.len();
        self.out_pts.push(OutPtNode {
            pt,
            next: result,
            prev: result,
            outrec,
            horz: false,
        });
        if insert_after {
            let next = self.out_pts[op].next;
            self.out_pts[result].next = next;
            self.out_pts[next].prev = result;
            self.out_pts[result].prev = op;
            self.out_pts[op].next = result;
        } else {
            let prev = self.out_pts[op].prev;
            self.out_pts[result].prev = prev;
            self.out_pts[prev].next = result;
            self.out_pts[result].next = op;
            self.out_pts[op].prev = result;
        }
        result
    }

    /// TS: `ClipperBase.getRealOutRec` (Engine.ts:1403-1408).
    fn get_real_out_rec(&self, out_rec: Option<usize>) -> Option<usize> {
        let mut out_rec = out_rec;
        while let Some(id) = out_rec {
            if self.outrec_list[id].pts.is_some() {
                break;
            }
            out_rec = self.outrec_list[id].owner;
        }
        out_rec
    }

    /// TS: `ClipperBase.insertLeftEdge` (Engine.ts:1952-1974).
    fn insert_left_edge(&mut self, ae: usize) {
        match self.actives {
            None => {
                self.active_pool[ae].prev_in_ael = None;
                self.active_pool[ae].next_in_ael = None;
                self.actives = Some(ae);
            }
            Some(actives) if !self.is_valid_ael_order(actives, ae) => {
                self.active_pool[ae].prev_in_ael = None;
                self.active_pool[ae].next_in_ael = Some(actives);
                self.active_pool[actives].prev_in_ael = Some(ae);
                self.actives = Some(ae);
            }
            Some(actives) => {
                let mut ae2 = actives;
                while let Some(next) = self.active_pool[ae2].next_in_ael {
                    if self.is_valid_ael_order(next, ae) {
                        ae2 = next;
                    } else {
                        break;
                    }
                }
                if self.active_pool[ae2].join_with == JoinWith::Right {
                    ae2 = self.active_pool[ae2]
                        .next_in_ael
                        .expect("Right-joined edge always has a nextInAEL");
                }
                self.active_pool[ae].next_in_ael = self.active_pool[ae2].next_in_ael;
                if let Some(next) = self.active_pool[ae2].next_in_ael {
                    self.active_pool[next].prev_in_ael = Some(ae);
                }
                self.active_pool[ae].prev_in_ael = Some(ae2);
                self.active_pool[ae2].next_in_ael = Some(ae);
            }
        }
    }

    /// TS: `ClipperBase.insertRightEdge` (Engine.ts:1976-1981).
    fn insert_right_edge(&mut self, ae1: usize, ae2: usize) {
        self.active_pool[ae2].next_in_ael = self.active_pool[ae1].next_in_ael;
        if let Some(next) = self.active_pool[ae1].next_in_ael {
            self.active_pool[next].prev_in_ael = Some(ae2);
        }
        self.active_pool[ae2].prev_in_ael = Some(ae1);
        self.active_pool[ae1].next_in_ael = Some(ae2);
    }

    /// TS: `ClipperBase.doIntersections` (Engine.ts:1410-1415).
    fn do_intersections(&mut self, y: f64) {
        if self.build_intersect_list(y) {
            self.process_intersect_list();
            self.dispose_intersect_nodes();
        }
    }

    /// TS: `ClipperBase.doTopOfScanbeam` (Engine.ts:1417-1446).
    fn do_top_of_scanbeam(&mut self, y: f64) {
        let cur_x_valid = self.cur_x_valid_at_top;
        self.cur_x_valid_at_top = false;
        self.sel = None;
        let mut ae = self.actives;
        while let Some(a) = ae {
            if self.active_pool[a].top.y == y {
                self.active_pool[a].cur_x = self.active_pool[a].top.x;
                if self.is_maxima_edge(&self.active_pool[a]) {
                    ae = self.do_maxima(a);
                    continue;
                } else {
                    if Self::is_hot_edge(&self.active_pool[a]) {
                        let top = self.active_pool[a].top;
                        self.add_out_pt(a, top);
                    }
                    self.update_edge_into_ael(a);
                    if Self::is_horizontal(&self.active_pool[a]) {
                        self.push_horz(a);
                    }
                }
            } else if !cur_x_valid {
                self.active_pool[a].cur_x = Self::top_x(&self.active_pool[a], y);
            }
            ae = self.active_pool[a].next_in_ael;
        }
    }

    /// TS: `ClipperBase.processHorzJoins` (Engine.ts:1448-1500).
    fn process_horz_joins(&mut self) {
        let joins = std::mem::take(&mut self.horz_join_list);
        for j in joins {
            let or1 = self
                .get_real_out_rec(Some(self.out_pts[j.op1].outrec))
                .expect("op1's outrec chain always resolves to a real outrec");
            let or2 = self
                .get_real_out_rec(Some(self.out_pts[j.op2].outrec))
                .expect("op2's outrec chain always resolves to a real outrec");

            let op1b = self.out_pts[j.op1].next;
            let op2b = self.out_pts[j.op2].prev;
            self.out_pts[j.op1].next = j.op2;
            self.out_pts[j.op2].prev = j.op1;
            self.out_pts[op1b].prev = op2b;
            self.out_pts[op2b].next = op1b;

            if or1 == or2 {
                let or2_new = self.new_out_rec();
                self.outrec_list[or2_new].pts = Some(op1b);
                self.fix_out_rec_pts(or2_new);

                let or1_pts = self.outrec_list[or1].pts.expect("or1 has pts");
                if self.out_pts[or1_pts].outrec == or2_new {
                    self.outrec_list[or1].pts = Some(j.op1);
                    self.out_pts[j.op1].outrec = or1;
                }

                if self.using_polytree {
                    let or1_pts = self.outrec_list[or1].pts.expect("or1 has pts");
                    let or2_new_pts = self.outrec_list[or2_new].pts.expect("or2New has pts");
                    if self.path1_inside_path2(or1_pts, or2_new_pts) {
                        let tmp = self.outrec_list[or2_new].pts;
                        self.outrec_list[or2_new].pts = self.outrec_list[or1].pts;
                        self.outrec_list[or1].pts = tmp;
                        self.fix_out_rec_pts(or1);
                        self.fix_out_rec_pts(or2_new);
                        self.outrec_list[or2_new].owner = Some(or1);
                    } else {
                        let or2_new_pts = self.outrec_list[or2_new].pts.expect("or2New has pts");
                        let or1_pts = self.outrec_list[or1].pts.expect("or1 has pts");
                        if self.path1_inside_path2(or2_new_pts, or1_pts) {
                            self.outrec_list[or2_new].owner = Some(or1);
                        } else {
                            self.outrec_list[or2_new].owner = self.outrec_list[or1].owner;
                        }
                    }

                    if self.outrec_list[or1].splits.is_none() {
                        self.outrec_list[or1].splits = Some(Vec::new());
                    }
                    let or2_new_idx = self.outrec_list[or2_new].idx;
                    self.outrec_list[or1]
                        .splits
                        .as_mut()
                        .expect("just ensured Some")
                        .push(or2_new_idx);
                } else {
                    self.outrec_list[or2_new].owner = Some(or1);
                }
            } else {
                self.outrec_list[or2].pts = None;
                if self.using_polytree {
                    self.set_owner(or2, or1);
                    self.move_splits(or2, or1);
                } else {
                    self.outrec_list[or2].owner = Some(or1);
                }
            }
        }
    }

    /// TS: `ClipperBase.fixOutRecPts` (Engine.ts:1502-1508).
    fn fix_out_rec_pts(&mut self, outrec: usize) {
        let start = self.outrec_list[outrec]
            .pts
            .expect("fixOutRecPts requires pts");
        let mut op = start;
        loop {
            self.out_pts[op].outrec = outrec;
            op = self.out_pts[op].next;
            if op == start {
                break;
            }
        }
    }

    /// TS: `ClipperBase.path1InsidePath2` (Engine.ts:1510-1532).
    fn path1_inside_path2(&self, op1: usize, op2: usize) -> bool {
        let mut pip = PointInPolygonResult::IsOn;
        let mut op = op1;
        loop {
            match self.point_in_op_polygon(self.out_pts[op].pt, op2) {
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
            op = self.out_pts[op].next;
            if op == op1 {
                break;
            }
        }
        // (#973) result is unclear, so try again using cleaned paths
        path2_contains_path1(&self.get_clean_path(op1), &self.get_clean_path(op2))
    }

    /// TS: `ClipperBase.pointInOpPolygon` (Engine.ts:1534-1594).
    fn point_in_op_polygon(&self, pt: Point64, op_in: usize) -> PointInPolygonResult {
        if self.out_pts[op_in].next == op_in || self.out_pts[op_in].prev == self.out_pts[op_in].next
        {
            return PointInPolygonResult::IsOutside;
        }

        let mut op = op_in;
        let op2_start = op;
        loop {
            if self.out_pts[op].pt.y != pt.y {
                break;
            }
            op = self.out_pts[op].next;
            if op == op2_start {
                break;
            }
        }
        if self.out_pts[op].pt.y == pt.y {
            return PointInPolygonResult::IsOutside;
        }

        let mut is_above = self.out_pts[op].pt.y < pt.y;
        let starting_above = is_above;
        let mut val: i32 = 0;

        let mut op2 = self.out_pts[op].next;
        while op2 != op {
            if is_above {
                while op2 != op && self.out_pts[op2].pt.y < pt.y {
                    op2 = self.out_pts[op2].next;
                }
            } else {
                while op2 != op && self.out_pts[op2].pt.y > pt.y {
                    op2 = self.out_pts[op2].next;
                }
            }
            if op2 == op {
                break;
            }

            if self.out_pts[op2].pt.y == pt.y {
                let op2_prev = self.out_pts[op2].prev;
                if self.out_pts[op2].pt.x == pt.x
                    || (self.out_pts[op2].pt.y == self.out_pts[op2_prev].pt.y
                        && (pt.x < self.out_pts[op2_prev].pt.x) != (pt.x < self.out_pts[op2].pt.x))
                {
                    return PointInPolygonResult::IsOn;
                }
                op2 = self.out_pts[op2].next;
                if op2 == op {
                    break;
                }
                continue;
            }

            let op2_prev = self.out_pts[op2].prev;
            if self.out_pts[op2].pt.x <= pt.x || self.out_pts[op2_prev].pt.x <= pt.x {
                if self.out_pts[op2_prev].pt.x < pt.x && self.out_pts[op2].pt.x < pt.x {
                    val = 1 - val;
                } else {
                    let d = cross_product_sign(self.out_pts[op2_prev].pt, self.out_pts[op2].pt, pt);
                    if d == 0 {
                        return PointInPolygonResult::IsOn;
                    }
                    if (d < 0) == is_above {
                        val = 1 - val;
                    }
                }
            }
            is_above = !is_above;
            op2 = self.out_pts[op2].next;
        }

        if is_above == starting_above {
            return if val == 0 {
                PointInPolygonResult::IsOutside
            } else {
                PointInPolygonResult::IsInside
            };
        }
        {
            let op2_prev = self.out_pts[op2].prev;
            let d = cross_product_sign(self.out_pts[op2_prev].pt, self.out_pts[op2].pt, pt);
            if d == 0 {
                return PointInPolygonResult::IsOn;
            }
            if (d < 0) == is_above {
                val = 1 - val;
            }
        }

        if val == 0 {
            PointInPolygonResult::IsOutside
        } else {
            PointInPolygonResult::IsInside
        }
    }

    /// TS: `ClipperBase.getCleanPath` (Engine.ts:1596-1614).
    fn get_clean_path(&self, op: usize) -> Path64 {
        let mut result = Path64::new();
        let mut op2 = op;
        loop {
            let next = self.out_pts[op2].next;
            if next == op {
                break;
            }
            let prev = self.out_pts[op2].prev;
            let collinear_spike = (self.out_pts[op2].pt.x == self.out_pts[next].pt.x
                && self.out_pts[op2].pt.x == self.out_pts[prev].pt.x)
                || (self.out_pts[op2].pt.y == self.out_pts[next].pt.y
                    && self.out_pts[op2].pt.y == self.out_pts[prev].pt.y);
            if !collinear_spike {
                break;
            }
            op2 = next;
        }
        result.push(self.out_pts[op2].pt);
        let mut prev_op = op2;
        op2 = self.out_pts[op2].next;
        while op2 != op {
            let next = self.out_pts[op2].next;
            if (self.out_pts[op2].pt.x != self.out_pts[next].pt.x
                || self.out_pts[op2].pt.x != self.out_pts[prev_op].pt.x)
                && (self.out_pts[op2].pt.y != self.out_pts[next].pt.y
                    || self.out_pts[op2].pt.y != self.out_pts[prev_op].pt.y)
            {
                result.push(self.out_pts[op2].pt);
                prev_op = op2;
            }
            op2 = self.out_pts[op2].next;
        }
        result
    }

    /// TS: `ClipperBase.moveSplits` (Engine.ts:1616-1625).
    fn move_splits(&mut self, from_or: usize, to_or: usize) {
        let Some(from_splits) = self.outrec_list[from_or].splits.take() else {
            return;
        };
        let to_idx = self.outrec_list[to_or].idx;
        let to_splits = self.outrec_list[to_or].splits.get_or_insert_with(Vec::new);
        for i in from_splits {
            if i != to_idx {
                to_splits.push(i);
            }
        }
    }

    /// TS: `ClipperBase.buildIntersectList` (Engine.ts:1627-1689). The merge-sort loop
    /// relies on the same invariant TS trusts via non-null assertions (`left!`,
    /// `right!`): within the bounds established by `lEnd`/`rEnd`, `left`/`right` are
    /// never actually `None` while their respective loop conditions hold — ported with
    /// `.expect()` at exactly those points rather than silently guarding against an
    /// input shape the original algorithm doesn't handle either.
    fn build_intersect_list(&mut self, top_y: f64) -> bool {
        if let Some(a) = self.actives {
            if self.active_pool[a].next_in_ael.is_none() {
                return false;
            }
        }

        if !self.adjust_curr_x_and_copy_to_sel(top_y) {
            self.cur_x_valid_at_top = true;
            return false;
        }

        let mut left = self.sel;

        while left.is_some_and(|l| self.active_pool[l].jump.is_some()) {
            let mut prev_base: Option<usize> = None;
            while left.is_some_and(|l| self.active_pool[l].jump.is_some()) {
                let mut curr_base = left.expect("checked by while condition");
                let mut right = self.active_pool[curr_base].jump;
                let mut l_end = right;
                let r_end = right.and_then(|r| self.active_pool[r].jump);
                self.active_pool[curr_base].jump = r_end;

                while left != l_end && right != r_end {
                    let l =
                        left.expect("left != lEnd holds only while left stays Some (TS `left!`)");
                    let r = right
                        .expect("right != rEnd holds only while right stays Some (TS `right!`)");
                    if self.active_pool[r].cur_x < self.active_pool[l].cur_x {
                        let mut tmp = self.active_pool[r]
                            .prev_in_sel
                            .expect("prevInSEL set (TS `right!.prevInSEL!`)");
                        loop {
                            self.add_new_intersect_node(tmp, r, top_y);
                            if Some(tmp) == left {
                                break;
                            }
                            tmp = self.active_pool[tmp]
                                .prev_in_sel
                                .expect("prevInSEL set (TS `tmp.prevInSEL!`)");
                        }

                        let tmp2 = r;
                        right = self.extract_from_sel(tmp2);
                        l_end = right;
                        if let Some(l2) = left {
                            self.insert1_before2_in_sel(tmp2, l2);
                        }
                        if left != Some(curr_base) {
                            continue;
                        }
                        curr_base = tmp2;
                        self.active_pool[curr_base].jump = r_end;
                        if let Some(pb) = prev_base {
                            self.active_pool[pb].jump = Some(curr_base);
                        } else {
                            self.sel = Some(curr_base);
                        }
                    } else {
                        left = self.active_pool[l].next_in_sel;
                    }
                }

                prev_base = Some(curr_base);
                left = r_end;
            }
            left = self.sel;
        }

        !self.intersect_list.is_empty()
    }

    /// TS: `ClipperBase.processIntersectList` (Engine.ts:1691-1719).
    fn process_intersect_list(&mut self) {
        {
            let actives = &self.active_pool;
            self.intersect_list
                .sort_by(|a, b| compare_intersect_nodes(a, b, actives));
        }

        let mut i = 0usize;
        while i < self.intersect_list.len() {
            if !self.edges_adjacent_in_ael(self.intersect_list[i]) {
                let mut j = i + 1;
                while !self.edges_adjacent_in_ael(self.intersect_list[j]) {
                    j += 1;
                }
                self.intersect_list.swap(i, j);
            }

            let node = self.intersect_list[i];
            self.intersect_edges(node.edge1, node.edge2, node.pt);
            self.swap_positions_in_ael(node.edge1, node.edge2);

            self.active_pool[node.edge1].cur_x = node.pt.x;
            self.active_pool[node.edge2].cur_x = node.pt.x;
            self.check_join_left(node.edge2, node.pt, true);
            self.check_join_right(node.edge1, node.pt, true);

            i += 1;
        }
    }

    /// TS: `ClipperBase.edgesAdjacentInAEL` (Engine.ts:1721-1723).
    fn edges_adjacent_in_ael(&self, inode: IntersectNode) -> bool {
        self.active_pool[inode.edge1].next_in_ael == Some(inode.edge2)
            || self.active_pool[inode.edge1].prev_in_ael == Some(inode.edge2)
    }

    /// TS: `ClipperBase.adjustCurrXAndCopyToSEL` (Engine.ts:1725-1746).
    fn adjust_curr_x_and_copy_to_sel(&mut self, top_y: f64) -> bool {
        let mut ae = self.actives;
        self.sel = ae;
        let mut prev_x = f64::NEG_INFINITY;
        let mut inverted = false;
        while let Some(a) = ae {
            let prev_in_ael = self.active_pool[a].prev_in_ael;
            let next_in_ael = self.active_pool[a].next_in_ael;
            self.active_pool[a].prev_in_sel = prev_in_ael;
            self.active_pool[a].next_in_sel = next_in_ael;
            self.active_pool[a].jump = next_in_ael;
            let x = Self::top_x(&self.active_pool[a], top_y);
            self.active_pool[a].cur_x = x;
            if x < prev_x {
                inverted = true;
            }
            prev_x = x;
            ae = next_in_ael;
        }
        inverted
    }

    /// TS: `ClipperBase.doMaxima` (Engine.ts:1748-1798).
    fn do_maxima(&mut self, ae: usize) -> Option<usize> {
        let prev_e = self.active_pool[ae].prev_in_ael;
        let mut next_e = self.active_pool[ae].next_in_ael;

        if self.is_open_end(&self.active_pool[ae]) {
            if Self::is_hot_edge(&self.active_pool[ae]) {
                let top = self.active_pool[ae].top;
                self.add_out_pt(ae, top);
            }
            if Self::is_horizontal(&self.active_pool[ae]) {
                return next_e;
            }
            if Self::is_hot_edge(&self.active_pool[ae]) {
                if self.is_front(ae) {
                    let outrec = self.active_pool[ae].outrec.expect("hot edge has outrec");
                    self.outrec_list[outrec].front_edge = None;
                } else {
                    let outrec = self.active_pool[ae].outrec.expect("hot edge has outrec");
                    self.outrec_list[outrec].back_edge = None;
                }
                self.active_pool[ae].outrec = None;
            }
            self.delete_from_ael(ae);
            return next_e;
        }

        let Some(max_pair) = self.get_maxima_pair(ae) else {
            return next_e; // eMaxPair is horizontal
        };

        if self.is_joined(ae) {
            let top = self.active_pool[ae].top;
            self.split(ae, top);
        }
        if self.is_joined(max_pair) {
            let top = self.active_pool[max_pair].top;
            self.split(max_pair, top);
        }

        // only non-horizontal maxima here. process any edges between maxima pair ...
        while next_e != Some(max_pair) {
            let ne = next_e.expect("nextE reaches maxPair before ever becoming null (TS `nextE!`)");
            let ae_top = self.active_pool[ae].top;
            self.intersect_edges(ae, ne, ae_top);
            self.swap_positions_in_ael(ae, ne);
            next_e = self.active_pool[ae].next_in_ael;
        }

        if self.is_open(&self.active_pool[ae]) {
            if Self::is_hot_edge(&self.active_pool[ae]) {
                let ae_top = self.active_pool[ae].top;
                self.add_local_max_poly(ae, max_pair, ae_top);
            }
            self.delete_from_ael(max_pair);
            self.delete_from_ael(ae);
            return match prev_e {
                Some(p) => self.active_pool[p].next_in_ael,
                None => self.actives,
            };
        }

        // here ae.nextInAel == ENext == EMaxPair ...
        if Self::is_hot_edge(&self.active_pool[ae]) {
            let ae_top = self.active_pool[ae].top;
            self.add_local_max_poly(ae, max_pair, ae_top);
        }

        self.delete_from_ael(ae);
        self.delete_from_ael(max_pair);
        match prev_e {
            Some(p) => self.active_pool[p].next_in_ael,
            None => self.actives,
        }
    }

    /// TS: `ClipperBase.updateEdgeIntoAEL` (Engine.ts:1800-1823).
    fn update_edge_into_ael(&mut self, ae: usize) {
        let top = self.active_pool[ae].top;
        self.active_pool[ae].bot = top;
        let vt = self.next_vertex(ae);
        self.active_pool[ae].vertex_top = Some(vt);
        self.active_pool[ae].top = self.vertices[vt].pt;
        self.active_pool[ae].cur_x = self.active_pool[ae].bot.x;
        Self::set_dx(&mut self.active_pool[ae]);

        if self.is_joined(ae) {
            let bot = self.active_pool[ae].bot;
            self.split(ae, bot);
        }

        if Self::is_horizontal(&self.active_pool[ae]) {
            // TS: `if (!openPathsEnabled) { trimHorz(...) /* closed-path fast path */ }
            // else if (!isOpen(ae)) { trimHorz(...) }` (Engine.ts:1810-1816) — the two
            // branches call `trimHorz` identically on purpose (TS's own comment: "Closed-
            // path-only fast path", avoiding the `isOpen(ae)` call in the always-false
            // `open_paths_enabled` case); reproduced verbatim per the migration prompt's
            // "reproduce even unusual/inefficient TS structure" rule rather than merging
            // the branches.
            #[allow(clippy::if_same_then_else)]
            if !self.open_paths_enabled {
                let pc = self.preserve_collinear;
                self.trim_horz(ae, pc);
            } else if !self.is_open(&self.active_pool[ae]) {
                let pc = self.preserve_collinear;
                self.trim_horz(ae, pc);
            }
            return;
        }
        let top_y = self.active_pool[ae].top.y;
        self.insert_scanline(top_y);

        let bot = self.active_pool[ae].bot;
        self.check_join_left(ae, bot, false);
        self.check_join_right(ae, bot, true); // (#500)
    }

    /// TS: `ClipperBase.trimHorz` (Engine.ts:1825-1844).
    fn trim_horz(&mut self, horz_edge: usize, preserve_collinear: bool) {
        let mut was_trimmed = false;
        let mut pt = self.vertices[self.next_vertex(horz_edge)].pt;

        while pt.y == self.active_pool[horz_edge].top.y {
            // always trim 180 deg. spikes (in closed paths) but otherwise break if
            // preserveCollinear = true
            if preserve_collinear
                && (pt.x < self.active_pool[horz_edge].top.x)
                    != (self.active_pool[horz_edge].bot.x < self.active_pool[horz_edge].top.x)
            {
                break;
            }

            let nv = self.next_vertex(horz_edge);
            self.active_pool[horz_edge].vertex_top = Some(nv);
            self.active_pool[horz_edge].top = pt;
            was_trimmed = true;
            if Self::is_maxima_vertex(&self.vertices[nv]) {
                break;
            }
            pt = self.vertices[self.next_vertex(horz_edge)].pt;
        }
        if was_trimmed {
            Self::set_dx(&mut self.active_pool[horz_edge]); // +/-infinity
        }
    }

    /// TS: `ClipperBase.addToHorzSegList` (Engine.ts:1846-1849).
    fn add_to_horz_seg_list(&mut self, op: usize) {
        if self.outrec_list[self.out_pts[op].outrec].is_open {
            return;
        }
        self.horz_seg_list.push(HorzSegment {
            left_op: op,
            right_op: None,
            left_to_right: true,
        });
    }

    /// TS: `ClipperBase.addNewIntersectNode` (Engine.ts:1851-1882).
    fn add_new_intersect_node(&mut self, ae1: usize, ae2: usize, top_y: f64) {
        let a1 = self.active_pool[ae1];
        let a2 = self.active_pool[ae2];
        let mut ip = match get_line_intersect_pt(a1.bot, a1.top, a2.bot, a2.top) {
            Some(p) => p,
            None => Point64 {
                x: a1.cur_x,
                y: top_y,
                z: 0.0,
            }, // parallel edges
        };

        if ip.y > self.current_bot_y || ip.y < top_y {
            let abs_dx1 = a1.dx.abs();
            let abs_dx2 = a2.dx.abs();

            if abs_dx1 > 100.0 && abs_dx2 > 100.0 {
                ip = if abs_dx1 > abs_dx2 {
                    get_closest_pt_on_segment(ip, a1.bot, a1.top)
                } else {
                    get_closest_pt_on_segment(ip, a2.bot, a2.top)
                };
            } else if abs_dx1 > 100.0 {
                ip = get_closest_pt_on_segment(ip, a1.bot, a1.top);
            } else if abs_dx2 > 100.0 {
                ip = get_closest_pt_on_segment(ip, a2.bot, a2.top);
            } else {
                if ip.y < top_y {
                    ip.y = top_y;
                } else {
                    ip.y = self.current_bot_y;
                }
                ip.x = if abs_dx1 < abs_dx2 {
                    Self::top_x(&a1, ip.y)
                } else {
                    Self::top_x(&a2, ip.y)
                };
            }
        }

        self.intersect_list.push(IntersectNode {
            pt: ip,
            edge1: ae1,
            edge2: ae2,
        });
    }

    /// TS: `ClipperBase.extractFromSEL` (Engine.ts:1884-1891).
    fn extract_from_sel(&mut self, ae: usize) -> Option<usize> {
        let res = self.active_pool[ae].next_in_sel;
        if let Some(r) = res {
            self.active_pool[r].prev_in_sel = self.active_pool[ae].prev_in_sel;
        }
        let prev = self.active_pool[ae]
            .prev_in_sel
            .expect("prevInSEL set (extractFromSEL precondition, TS `ae.prevInSEL!`)");
        self.active_pool[prev].next_in_sel = res;
        res
    }

    /// TS: `ClipperBase.insert1Before2InSEL` (Engine.ts:1893-1900).
    fn insert1_before2_in_sel(&mut self, ae1: usize, ae2: usize) {
        self.active_pool[ae1].prev_in_sel = self.active_pool[ae2].prev_in_sel;
        if let Some(p) = self.active_pool[ae1].prev_in_sel {
            self.active_pool[p].next_in_sel = Some(ae1);
        }
        self.active_pool[ae1].next_in_sel = Some(ae2);
        self.active_pool[ae2].prev_in_sel = Some(ae1);
    }

    /// TS: `ClipperBase.getCurrYMaximaVertex` (Engine.ts:1917-1926). (Its open-path
    /// sibling `getCurrYMaximaVertexOpen`, Engine.ts:1902-1915, is only reachable from
    /// the unported general `doHorizontal` — see module doc — and is not ported.)
    fn get_curr_y_maxima_vertex(&self, ae: usize) -> Option<usize> {
        let node = self.active_pool[ae];
        let mut result = node.vertex_top.expect("vertexTop set");
        if node.wind_dx > 0 {
            while self.vertices[self.vertices[result].next.expect("next set")]
                .pt
                .y
                == self.vertices[result].pt.y
            {
                result = self.vertices[result].next.expect("next set");
            }
        } else {
            while self.vertices[self.vertices[result].prev.expect("prev set")]
                .pt
                .y
                == self.vertices[result].pt.y
            {
                result = self.vertices[result].prev.expect("prev set");
            }
        }
        if !Self::is_maxima_vertex(&self.vertices[result]) {
            None
        } else {
            Some(result)
        }
    }

    /// TS: `ClipperBase.resetHorzDirection` (Engine.ts:1928-1944).
    fn reset_horz_direction(&self, horz: usize, vertex_max: Option<usize>) -> HorzDirection {
        let h = self.active_pool[horz];
        if h.bot.x == h.top.x {
            let left_x = h.cur_x;
            let right_x = h.cur_x;
            let mut ae = h.next_in_ael;
            while let Some(a) = ae {
                if self.active_pool[a].vertex_top == vertex_max {
                    break;
                }
                ae = self.active_pool[a].next_in_ael;
            }
            return HorzDirection {
                is_left_to_right: ae.is_some(),
                left_x,
                right_x,
            };
        }

        if h.cur_x < h.top.x {
            HorzDirection {
                is_left_to_right: true,
                left_x: h.cur_x,
                right_x: h.top.x,
            }
        } else {
            HorzDirection {
                is_left_to_right: false,
                left_x: h.top.x,
                right_x: h.cur_x,
            }
        }
    }

    /// TS: `ClipperBase.getLastOp` (Engine.ts:1946-1950).
    fn get_last_op(&self, hot_edge: usize) -> usize {
        let outrec = self.active_pool[hot_edge]
            .outrec
            .expect("hot edge has outrec");
        let pts = self.outrec_list[outrec].pts.expect("hot outrec has pts");
        if self.outrec_list[outrec].front_edge == Some(hot_edge) {
            pts
        } else {
            self.out_pts[pts].next
        }
    }

    /// TS: `ClipperBase.setWindCountForOpenPathEdge` (Engine.ts:1983-2008). Only called
    /// from the dead `ClipperBase.isOpen(leftBound)` branch of
    /// [`Self::insert_local_minima_into_ael`] — see module doc.
    fn set_wind_count_for_open_path_edge(&mut self, _ae: usize) {
        unreachable!(
            "setWindCountForOpenPathEdge (Engine.ts:1983-2008) not reachable: \
             open_paths_enabled is always false in this port"
        );
    }

    /// TS: `ClipperBase.setWindCountForClosedPathEdge` (Engine.ts:2010-2134).
    fn set_wind_count_for_closed_path_edge(&mut self, ae: usize) {
        let mut ae2 = self.active_pool[ae].prev_in_ael;
        let pt = self.poly_type_of(&self.active_pool[ae]);
        let ae_wind_dx = self.active_pool[ae].wind_dx;

        if !self.open_paths_enabled {
            while let Some(a2) = ae2 {
                if self.poly_type_of(&self.active_pool[a2]) == pt {
                    break;
                }
                ae2 = self.active_pool[a2].prev_in_ael;
            }

            match ae2 {
                None => {
                    self.active_pool[ae].wind_count = ae_wind_dx;
                    ae2 = self.actives;
                }
                Some(a2) if self.fillrule == FillRule::EvenOdd => {
                    self.active_pool[ae].wind_count = ae_wind_dx;
                    self.active_pool[ae].wind_count2 = self.active_pool[a2].wind_count2;
                    ae2 = self.active_pool[a2].next_in_ael;
                }
                Some(a2) => {
                    let a2_wc = self.active_pool[a2].wind_count;
                    let a2_wdx = self.active_pool[a2].wind_dx;
                    if a2_wc * a2_wdx < 0 {
                        if a2_wc.abs() > 1 {
                            self.active_pool[ae].wind_count = if a2_wdx * ae_wind_dx < 0 {
                                a2_wc
                            } else {
                                a2_wc + ae_wind_dx
                            };
                        } else {
                            self.active_pool[ae].wind_count = ae_wind_dx;
                        }
                    } else if a2_wdx * ae_wind_dx < 0 {
                        self.active_pool[ae].wind_count = a2_wc;
                    } else {
                        self.active_pool[ae].wind_count = a2_wc + ae_wind_dx;
                    }

                    self.active_pool[ae].wind_count2 = self.active_pool[a2].wind_count2;
                    ae2 = self.active_pool[a2].next_in_ael;
                }
            }

            if self.fillrule == FillRule::EvenOdd {
                while ae2 != Some(ae) {
                    let a2 = ae2.expect("ae2 reaches ae before ever becoming null (TS `ae2!`)");
                    if self.poly_type_of(&self.active_pool[a2]) != pt {
                        self.active_pool[ae].wind_count2 = if self.active_pool[ae].wind_count2 == 0
                        {
                            1
                        } else {
                            0
                        };
                    }
                    ae2 = self.active_pool[a2].next_in_ael;
                }
            } else {
                while ae2 != Some(ae) {
                    let a2 = ae2.expect("ae2 reaches ae before ever becoming null (TS `ae2!`)");
                    if self.poly_type_of(&self.active_pool[a2]) != pt {
                        self.active_pool[ae].wind_count2 += self.active_pool[a2].wind_dx;
                    }
                    ae2 = self.active_pool[a2].next_in_ael;
                }
            }
            return;
        }

        while ae2.is_some_and(|a2| {
            self.poly_type_of(&self.active_pool[a2]) != pt || self.is_open(&self.active_pool[a2])
        }) {
            ae2 = self.active_pool[ae2.expect("checked by while condition")].prev_in_ael;
        }

        match ae2 {
            None => {
                self.active_pool[ae].wind_count = ae_wind_dx;
                ae2 = self.actives;
            }
            Some(a2) if self.fillrule == FillRule::EvenOdd => {
                self.active_pool[ae].wind_count = ae_wind_dx;
                self.active_pool[ae].wind_count2 = self.active_pool[a2].wind_count2;
                ae2 = self.active_pool[a2].next_in_ael;
            }
            Some(a2) => {
                let a2_wc = self.active_pool[a2].wind_count;
                let a2_wdx = self.active_pool[a2].wind_dx;
                if a2_wc * a2_wdx < 0 {
                    if a2_wc.abs() > 1 {
                        self.active_pool[ae].wind_count = if a2_wdx * ae_wind_dx < 0 {
                            a2_wc
                        } else {
                            a2_wc + ae_wind_dx
                        };
                    } else {
                        self.active_pool[ae].wind_count = if self.is_open(&self.active_pool[ae]) {
                            1
                        } else {
                            ae_wind_dx
                        };
                    }
                } else if a2_wdx * ae_wind_dx < 0 {
                    self.active_pool[ae].wind_count = a2_wc;
                } else {
                    self.active_pool[ae].wind_count = a2_wc + ae_wind_dx;
                }

                self.active_pool[ae].wind_count2 = self.active_pool[a2].wind_count2;
                ae2 = self.active_pool[a2].next_in_ael;
            }
        }

        if self.fillrule == FillRule::EvenOdd {
            while ae2 != Some(ae) {
                let a2 = ae2.expect("ae2 reaches ae before ever becoming null (TS `ae2!`)");
                if self.poly_type_of(&self.active_pool[a2]) != pt
                    && !self.is_open(&self.active_pool[a2])
                {
                    self.active_pool[ae].wind_count2 = if self.active_pool[ae].wind_count2 == 0 {
                        1
                    } else {
                        0
                    };
                }
                ae2 = self.active_pool[a2].next_in_ael;
            }
        } else {
            while ae2 != Some(ae) {
                let a2 = ae2.expect("ae2 reaches ae before ever becoming null (TS `ae2!`)");
                if self.poly_type_of(&self.active_pool[a2]) != pt
                    && !self.is_open(&self.active_pool[a2])
                {
                    self.active_pool[ae].wind_count2 += self.active_pool[a2].wind_dx;
                }
                ae2 = self.active_pool[a2].next_in_ael;
            }
        }
    }

    /// TS: `ClipperBase.isContributingOpen` (Engine.ts:2136-2158). Only called from the
    /// dead `ClipperBase.isOpen(leftBound)` branch — see module doc.
    fn is_contributing_open(&self, _ae: usize) -> bool {
        unreachable!(
            "isContributingOpen (Engine.ts:2136-2158) not reachable: open_paths_enabled is \
             always false in this port"
        );
    }

    /// TS: `ClipperBase.isContributingClosed` (Engine.ts:2160-2197).
    fn is_contributing_closed(&self, ae: usize) -> bool {
        let wind_count = self.active_pool[ae].wind_count;
        match self.fillrule {
            FillRule::Positive => {
                if wind_count != 1 {
                    return false;
                }
            }
            FillRule::Negative => {
                if wind_count != -1 {
                    return false;
                }
            }
            FillRule::NonZero => {
                if wind_count.abs() != 1 {
                    return false;
                }
            }
            FillRule::EvenOdd => {}
        }

        let wind_count2 = self.active_pool[ae].wind_count2;
        match self.cliptype {
            ClipType::Intersection => match self.fillrule {
                FillRule::Positive => wind_count2 > 0,
                FillRule::Negative => wind_count2 < 0,
                _ => wind_count2 != 0,
            },
            ClipType::Union => match self.fillrule {
                FillRule::Positive => wind_count2 <= 0,
                FillRule::Negative => wind_count2 >= 0,
                _ => wind_count2 == 0,
            },
            ClipType::Difference => {
                let result = match self.fillrule {
                    FillRule::Positive => wind_count2 <= 0,
                    FillRule::Negative => wind_count2 >= 0,
                    _ => wind_count2 == 0,
                };
                if self.poly_type_of(&self.active_pool[ae]) == PathType::Subject {
                    result
                } else {
                    !result
                }
            }
            ClipType::Xor => true, // XOr is always contributing unless open
            ClipType::NoClip => false,
        }
    }

    /// TS: `ClipperBase.addLocalMinPoly` (Engine.ts:2199-2242).
    fn add_local_min_poly(&mut self, ae1: usize, ae2: usize, pt: Point64, is_new: bool) -> usize {
        let outrec = self.new_out_rec();
        self.active_pool[ae1].outrec = Some(outrec);
        self.active_pool[ae2].outrec = Some(outrec);

        if self.is_open(&self.active_pool[ae1]) {
            self.outrec_list[outrec].owner = None;
            self.outrec_list[outrec].is_open = true;
            if self.active_pool[ae1].wind_dx > 0 {
                self.set_sides(outrec, ae1, ae2);
            } else {
                self.set_sides(outrec, ae2, ae1);
            }
        } else {
            self.outrec_list[outrec].is_open = false;
            // e.windDx is the winding direction of the **input** paths and unrelated to
            // the winding direction of output polygons. Output orientation is
            // determined by e.outrec.frontE which is the ascending edge (see
            // AddLocalMinPoly).
            let prev_hot_edge = self.get_prev_hot_edge(ae1);
            if let Some(prev_hot_edge) = prev_hot_edge {
                let prev_hot_outrec = self.active_pool[prev_hot_edge]
                    .outrec
                    .expect("prevHotEdge is hot, i.e. has an outrec");
                if self.using_polytree {
                    self.set_owner(outrec, prev_hot_outrec);
                }
                self.outrec_list[outrec].owner = Some(prev_hot_outrec);
                if self.outrec_is_ascending(prev_hot_edge) == is_new {
                    self.set_sides(outrec, ae2, ae1);
                } else {
                    self.set_sides(outrec, ae1, ae2);
                }
            } else {
                self.outrec_list[outrec].owner = None;
                if is_new {
                    self.set_sides(outrec, ae1, ae2);
                } else {
                    self.set_sides(outrec, ae2, ae1);
                }
            }
        }

        let op = self.new_out_pt(pt, outrec);
        self.outrec_list[outrec].pts = Some(op);
        op
    }

    /// TS: `ClipperBase.outrecIsAscending` (Engine.ts:2244-2246).
    fn outrec_is_ascending(&self, hot_edge: usize) -> bool {
        let outrec = self.active_pool[hot_edge]
            .outrec
            .expect("hot edge has outrec");
        self.outrec_list[outrec].front_edge == Some(hot_edge)
    }

    /// TS: `ClipperBase.newOutRec` (Engine.ts:2248-2253).
    fn new_out_rec(&mut self) -> usize {
        let idx = self.outrec_list.len();
        self.outrec_list.push(OutRecNode::new(idx));
        idx
    }

    /// Pushes a fresh `OutPt` into the arena and returns its id — the Rust-side
    /// equivalent of TS's `new OutPt(pt, outrec)` (self-circular `next`/`prev`, see
    /// [`OutPtNode`]'s doc comment).
    fn new_out_pt(&mut self, pt: Point64, outrec: usize) -> usize {
        let id = self.out_pts.len();
        self.out_pts.push(OutPtNode {
            pt,
            next: id,
            prev: id,
            outrec,
            horz: false,
        });
        id
    }

    /// TS: `ClipperBase.startOpenPath` (Engine.ts:2255-2270). Only reachable from dead
    /// open-path branches — see module doc.
    fn start_open_path(&mut self, _ae: usize, _pt: Point64) -> usize {
        unreachable!(
            "startOpenPath (Engine.ts:2255-2270) not reachable: open_paths_enabled is \
             always false in this port"
        );
    }

    /// TS: `ClipperBase.checkJoinLeft` (Engine.ts:2272-2296).
    fn check_join_left(&mut self, ae: usize, pt: Point64, check_curr_x: bool) {
        let Some(prev) = self.active_pool[ae].prev_in_ael else {
            return;
        };
        if !check_curr_x && self.active_pool[ae].cur_x != self.active_pool[prev].cur_x {
            return;
        }
        if !Self::is_hot_edge(&self.active_pool[ae])
            || !Self::is_hot_edge(&self.active_pool[prev])
            || Self::is_horizontal(&self.active_pool[ae])
            || Self::is_horizontal(&self.active_pool[prev])
            || self.is_open(&self.active_pool[ae])
            || self.is_open(&self.active_pool[prev])
        {
            return;
        }
        let ae_top = self.active_pool[ae].top;
        let prev_top = self.active_pool[prev].top;
        let ae_bot = self.active_pool[ae].bot;
        let prev_bot = self.active_pool[prev].bot;
        if (pt.y < ae_top.y + 2.0 || pt.y < prev_top.y + 2.0) // avoid trivial joins
            && (ae_bot.y > pt.y || prev_bot.y > pt.y)
        // (#490)
        {
            return;
        }

        if check_curr_x
            && self.perpendic_dist_from_line_sqrd_greater_than_quarter(pt, prev_bot, prev_top)
        {
            return;
        }
        if !is_collinear(ae_top, pt, prev_top) {
            return;
        }

        let ae_outrec = self.active_pool[ae].outrec.expect("hot edge has outrec");
        let prev_outrec = self.active_pool[prev].outrec.expect("hot edge has outrec");
        if self.outrec_list[ae_outrec].idx == self.outrec_list[prev_outrec].idx {
            self.add_local_max_poly(prev, ae, pt);
        } else if self.outrec_list[ae_outrec].idx < self.outrec_list[prev_outrec].idx {
            self.join_outrec_paths(ae, prev);
        } else {
            self.join_outrec_paths(prev, ae);
        }
        self.active_pool[prev].join_with = JoinWith::Right;
        self.active_pool[ae].join_with = JoinWith::Left;
    }

    /// TS: `ClipperBase.checkJoinRight` (Engine.ts:2298-2322).
    fn check_join_right(&mut self, ae: usize, pt: Point64, check_curr_x: bool) {
        let Some(next) = self.active_pool[ae].next_in_ael else {
            return;
        };
        if !check_curr_x && self.active_pool[ae].cur_x != self.active_pool[next].cur_x {
            return;
        }
        if !Self::is_hot_edge(&self.active_pool[ae])
            || !Self::is_hot_edge(&self.active_pool[next])
            || Self::is_horizontal(&self.active_pool[ae])
            || Self::is_horizontal(&self.active_pool[next])
            || self.is_open(&self.active_pool[ae])
            || self.is_open(&self.active_pool[next])
        {
            return;
        }
        let ae_top = self.active_pool[ae].top;
        let next_top = self.active_pool[next].top;
        let ae_bot = self.active_pool[ae].bot;
        let next_bot = self.active_pool[next].bot;
        if (pt.y < ae_top.y + 2.0 || pt.y < next_top.y + 2.0) // avoid trivial joins
            && (ae_bot.y > pt.y || next_bot.y > pt.y)
        // (#490)
        {
            return;
        }

        if check_curr_x
            && self.perpendic_dist_from_line_sqrd_greater_than_quarter(pt, next_bot, next_top)
        {
            return;
        }
        if !is_collinear(ae_top, pt, next_top) {
            return;
        }

        let ae_outrec = self.active_pool[ae].outrec.expect("hot edge has outrec");
        let next_outrec = self.active_pool[next].outrec.expect("hot edge has outrec");
        if self.outrec_list[ae_outrec].idx == self.outrec_list[next_outrec].idx {
            self.add_local_max_poly(ae, next, pt);
        } else if self.outrec_list[ae_outrec].idx < self.outrec_list[next_outrec].idx {
            self.join_outrec_paths(ae, next);
        } else {
            self.join_outrec_paths(next, ae);
        }
        self.active_pool[ae].join_with = JoinWith::Right;
        self.active_pool[next].join_with = JoinWith::Left;
    }

    /// TS: `ClipperBase.perpendicDistFromLineSqrdGreaterThanQuarter` (Engine.ts:2324-2350).
    fn perpendic_dist_from_line_sqrd_greater_than_quarter(
        &self,
        pt: Point64,
        line1: Point64,
        line2: Point64,
    ) -> bool {
        let a = pt.x - line1.x;
        let b = pt.y - line1.y;
        let c = line2.x - line1.x;
        let d = line2.y - line1.y;
        if c == 0.0 && d == 0.0 {
            return false;
        }
        // Fast path: keep within safe integer range
        let max_coord = core::max_coord_for_safe_cross_sq();
        if a.abs() < max_coord && b.abs() < max_coord && c.abs() < max_coord && d.abs() < max_coord
        {
            let cross = (a * d) - (c * b);
            return (cross * cross) / ((c * c) + (d * d)) > 0.25;
        }
        // Large coordinates: use BigInt for precision
        if is_safe_integer(a) && is_safe_integer(b) && is_safe_integer(c) && is_safe_integer(d) {
            let cross = core::f64_to_bigint(a) * core::f64_to_bigint(d)
                - core::f64_to_bigint(c) * core::f64_to_bigint(b);
            let cross_sq = &cross * &cross;
            let denom = core::f64_to_bigint(c) * core::f64_to_bigint(c)
                + core::f64_to_bigint(d) * core::f64_to_bigint(d);
            return BigInt::from(4) * cross_sq > denom;
        }
        // Fallback for non-integer coords
        let cross = (a * d) - (c * b);
        (cross * cross) / ((c * c) + (d * d)) > 0.25
    }

    /// Applies [`Self::set_z`] to an already-materialized `OutPt`'s point in place —
    /// factors out the "copy out `.pt`, call `setZ`, write `.pt` back" dance that TS
    /// expresses as a single in-place mutation (`this.setZ(ae1, ae2, resultOp.pt)`)
    /// roughly fifteen times across [`Self::intersect_edges`]. See module doc, "`z`
    /// coordinates" — always a no-op on paths reachable from `booleanOp`/
    /// `booleanOpWithPolyTree`.
    fn set_z_on_out_pt(&mut self, ae1: usize, ae2: usize, op: usize) {
        let mut pt = self.out_pts[op].pt;
        self.set_z(ae1, ae2, &mut pt);
        self.out_pts[op].pt = pt;
    }

    /// TS: `ClipperBase.intersectEdges` (Engine.ts:2353-2560).
    fn intersect_edges(&mut self, ae1: usize, ae2: usize, pt: Point64) {
        // MANAGE OPEN PATH INTERSECTIONS SEPARATELY (Engine.ts:2356-2416) — never
        // reached: this port's `add_paths` never sets `is_open`, so `has_open_paths` is
        // always `false` and this branch's guard short-circuits before the body could
        // even run — see module doc.
        if self.has_open_paths
            && (self.is_open(&self.active_pool[ae1]) || self.is_open(&self.active_pool[ae2]))
        {
            unreachable!(
                "open-path intersectEdges branch (Engine.ts:2356-2416) not ported: \
                 has_open_paths is always false in this port"
            );
        }

        // MANAGING CLOSED PATHS FROM HERE ON
        if self.is_joined(ae1) {
            self.split(ae1, pt);
        }
        if self.is_joined(ae2) {
            self.split(ae2, pt);
        }

        // UPDATE WINDING COUNTS...
        let ae1_polytype = self.poly_type_of_owned(ae1);
        let ae2_polytype = self.poly_type_of_owned(ae2);

        if ae1_polytype == ae2_polytype {
            if self.fillrule == FillRule::EvenOdd {
                let old_e1_wc = self.active_pool[ae1].wind_count;
                self.active_pool[ae1].wind_count = self.active_pool[ae2].wind_count;
                self.active_pool[ae2].wind_count = old_e1_wc;
            } else {
                let ae2_wind_dx = self.active_pool[ae2].wind_dx;
                if self.active_pool[ae1].wind_count + ae2_wind_dx == 0 {
                    self.active_pool[ae1].wind_count = -self.active_pool[ae1].wind_count;
                } else {
                    self.active_pool[ae1].wind_count += ae2_wind_dx;
                }
                let ae1_wind_dx = self.active_pool[ae1].wind_dx;
                if self.active_pool[ae2].wind_count - ae1_wind_dx == 0 {
                    self.active_pool[ae2].wind_count = -self.active_pool[ae2].wind_count;
                } else {
                    self.active_pool[ae2].wind_count -= ae1_wind_dx;
                }
            }
        } else {
            if self.fillrule != FillRule::EvenOdd {
                let ae2_wind_dx = self.active_pool[ae2].wind_dx;
                self.active_pool[ae1].wind_count2 += ae2_wind_dx;
            } else {
                self.active_pool[ae1].wind_count2 = if self.active_pool[ae1].wind_count2 == 0 {
                    1
                } else {
                    0
                };
            }
            if self.fillrule != FillRule::EvenOdd {
                let ae1_wind_dx = self.active_pool[ae1].wind_dx;
                self.active_pool[ae2].wind_count2 -= ae1_wind_dx;
            } else {
                self.active_pool[ae2].wind_count2 = if self.active_pool[ae2].wind_count2 == 0 {
                    1
                } else {
                    0
                };
            }
        }

        let (old_e1_wind_count, old_e2_wind_count) = match self.fillrule {
            FillRule::Positive => (
                self.active_pool[ae1].wind_count,
                self.active_pool[ae2].wind_count,
            ),
            FillRule::Negative => (
                -self.active_pool[ae1].wind_count,
                -self.active_pool[ae2].wind_count,
            ),
            _ => (
                self.active_pool[ae1].wind_count.abs(),
                self.active_pool[ae2].wind_count.abs(),
            ),
        };

        let e1_wind_count_is_0_or_1 = old_e1_wind_count == 0 || old_e1_wind_count == 1;
        let e2_wind_count_is_0_or_1 = old_e2_wind_count == 0 || old_e2_wind_count == 1;

        if (!Self::is_hot_edge(&self.active_pool[ae1]) && !e1_wind_count_is_0_or_1)
            || (!Self::is_hot_edge(&self.active_pool[ae2]) && !e2_wind_count_is_0_or_1)
        {
            return;
        }

        // NOW PROCESS THE INTERSECTION ...

        // if both edges are 'hot' ...
        if Self::is_hot_edge(&self.active_pool[ae1]) && Self::is_hot_edge(&self.active_pool[ae2]) {
            if (old_e1_wind_count != 0 && old_e1_wind_count != 1)
                || (old_e2_wind_count != 0 && old_e2_wind_count != 1)
                || (ae1_polytype != ae2_polytype && self.cliptype != ClipType::Xor)
            {
                if let Some(result_op) = self.add_local_max_poly(ae1, ae2, pt) {
                    self.set_z_on_out_pt(ae1, ae2, result_op);
                }
            } else if self.is_front(ae1)
                || self.active_pool[ae1].outrec == self.active_pool[ae2].outrec
            {
                // this 'else if' condition isn't strictly needed but it's sensible to
                // split polygons that only touch at a common vertex (not at common
                // edges).
                if let Some(result_op) = self.add_local_max_poly(ae1, ae2, pt) {
                    self.set_z_on_out_pt(ae1, ae2, result_op);
                }
                let op2 = self.add_local_min_poly(ae1, ae2, pt, false);
                self.set_z_on_out_pt(ae1, ae2, op2);
            } else {
                // can't treat as maxima & minima
                let result_op = self.add_out_pt(ae1, pt);
                self.set_z_on_out_pt(ae1, ae2, result_op);
                let op2 = self.add_out_pt(ae2, pt);
                self.set_z_on_out_pt(ae1, ae2, op2);
                self.swap_outrecs(ae1, ae2);
            }
        }
        // if one or other edge is 'hot' ...
        else if Self::is_hot_edge(&self.active_pool[ae1]) {
            let result_op = self.add_out_pt(ae1, pt);
            self.set_z_on_out_pt(ae1, ae2, result_op);
            self.swap_outrecs(ae1, ae2);
        } else if Self::is_hot_edge(&self.active_pool[ae2]) {
            let result_op = self.add_out_pt(ae2, pt);
            self.set_z_on_out_pt(ae1, ae2, result_op);
            self.swap_outrecs(ae1, ae2);
        }
        // neither edge is 'hot'
        else {
            let (e1_wc2, e2_wc2) = match self.fillrule {
                FillRule::Positive => (
                    self.active_pool[ae1].wind_count2,
                    self.active_pool[ae2].wind_count2,
                ),
                FillRule::Negative => (
                    -self.active_pool[ae1].wind_count2,
                    -self.active_pool[ae2].wind_count2,
                ),
                _ => (
                    self.active_pool[ae1].wind_count2.abs(),
                    self.active_pool[ae2].wind_count2.abs(),
                ),
            };

            if ae1_polytype != ae2_polytype {
                let result_op = self.add_local_min_poly(ae1, ae2, pt, false);
                self.set_z_on_out_pt(ae1, ae2, result_op);
            } else if old_e1_wind_count == 1 && old_e2_wind_count == 1 {
                let mut result_op: Option<usize> = None;
                match self.cliptype {
                    ClipType::Union => {
                        if e1_wc2 > 0 && e2_wc2 > 0 {
                            return;
                        }
                        result_op = Some(self.add_local_min_poly(ae1, ae2, pt, false));
                    }
                    ClipType::Difference => {
                        if (ae1_polytype == PathType::Clip && e1_wc2 > 0 && e2_wc2 > 0)
                            || (ae1_polytype == PathType::Subject && e1_wc2 <= 0 && e2_wc2 <= 0)
                        {
                            result_op = Some(self.add_local_min_poly(ae1, ae2, pt, false));
                        }
                    }
                    ClipType::Xor => {
                        result_op = Some(self.add_local_min_poly(ae1, ae2, pt, false));
                    }
                    _ => {
                        // ClipType.Intersection (TS `default`); `NoClip` is unreachable
                        // here since `executeInternal` returns immediately for it.
                        if e1_wc2 <= 0 || e2_wc2 <= 0 {
                            return;
                        }
                        result_op = Some(self.add_local_min_poly(ae1, ae2, pt, false));
                    }
                }
                if let Some(result_op) = result_op {
                    self.set_z_on_out_pt(ae1, ae2, result_op);
                }
            }
        }
    }

    /// Owned (non-borrowing) variant of [`Self::poly_type_of`], for call sites (like
    /// [`Self::intersect_edges`]) that need the value across later `&mut self` calls.
    fn poly_type_of_owned(&self, ae: usize) -> PathType {
        self.poly_type_of(&self.active_pool[ae])
    }

    /// TS: `ClipperBase.swapPositionsInAEL` (Engine.ts:2562-2573).
    fn swap_positions_in_ael(&mut self, ae1: usize, ae2: usize) {
        // precondition: ae1 must be immediately to the left of ae2
        let next = self.active_pool[ae2].next_in_ael;
        if let Some(n) = next {
            self.active_pool[n].prev_in_ael = Some(ae1);
        }
        let prev = self.active_pool[ae1].prev_in_ael;
        if let Some(p) = prev {
            self.active_pool[p].next_in_ael = Some(ae2);
        }
        self.active_pool[ae2].prev_in_ael = prev;
        self.active_pool[ae2].next_in_ael = Some(ae1);
        self.active_pool[ae1].prev_in_ael = Some(ae2);
        self.active_pool[ae1].next_in_ael = next;
        if self.active_pool[ae2].prev_in_ael.is_none() {
            self.actives = Some(ae2);
        }
    }

    /// TS: `ClipperBase.isValidAelOrder` (Engine.ts:2575-2613).
    fn is_valid_ael_order(&self, resident: usize, newcomer: usize) -> bool {
        let r = self.active_pool[resident];
        let n = self.active_pool[newcomer];
        if n.cur_x != r.cur_x {
            return n.cur_x > r.cur_x;
        }

        // get the turning direction a1.top, a2.bot, a2.top
        let d = cross_product_sign(r.top, n.bot, n.top);
        if d != 0 {
            return d < 0;
        }

        // edges must be collinear to get here

        // for starting open paths, place them according to the direction they're
        // about to turn
        if !self.is_maxima_edge(&r) && r.top.y > n.top.y {
            let nv = self.next_vertex(resident);
            return cross_product_sign(n.bot, r.top, self.vertices[nv].pt) <= 0;
        }

        if !self.is_maxima_edge(&n) && n.top.y > r.top.y {
            let nv = self.next_vertex(newcomer);
            return cross_product_sign(n.bot, n.top, self.vertices[nv].pt) >= 0;
        }

        let y = n.bot.y;
        let newcomer_is_left = n.is_left_bound;

        let resident_local_min_vertex = self.minima_list[r.local_min.expect("localMin set")].vertex;
        if r.bot.y != y || self.vertices[resident_local_min_vertex].pt.y != y {
            return n.is_left_bound;
        }
        // resident must also have just been inserted
        if r.is_left_bound != newcomer_is_left {
            return newcomer_is_left;
        }
        let r_ppv = self.prev_prev_vertex(resident);
        if is_collinear(self.vertices[r_ppv].pt, r.bot, r.top) {
            return true;
        }
        // compare turning direction of the alternate bound
        let n_ppv = self.prev_prev_vertex(newcomer);
        (cross_product_sign(self.vertices[r_ppv].pt, n.bot, self.vertices[n_ppv].pt) > 0)
            == newcomer_is_left
    }

    /// TS: `ClipperBase.isJoined` (Engine.ts:2615-2617).
    fn is_joined(&self, e: usize) -> bool {
        self.active_pool[e].join_with != JoinWith::None
    }

    /// TS: `ClipperBase.split` (Engine.ts:2619-2629).
    fn split(&mut self, e: usize, curr_pt: Point64) {
        if self.active_pool[e].join_with == JoinWith::Right {
            self.active_pool[e].join_with = JoinWith::None;
            let next = self.active_pool[e]
                .next_in_ael
                .expect("Right-joined edge always has a nextInAEL");
            self.active_pool[next].join_with = JoinWith::None;
            self.add_local_min_poly(e, next, curr_pt, true);
        } else {
            self.active_pool[e].join_with = JoinWith::None;
            let prev = self.active_pool[e]
                .prev_in_ael
                .expect("Left-joined edge always has a prevInAEL");
            self.active_pool[prev].join_with = JoinWith::None;
            self.add_local_min_poly(prev, e, curr_pt, true);
        }
    }

    /// TS: `ClipperBase.setSides` (Engine.ts:2631-2634).
    fn set_sides(&mut self, outrec: usize, start_edge: usize, end_edge: usize) {
        self.outrec_list[outrec].front_edge = Some(start_edge);
        self.outrec_list[outrec].back_edge = Some(end_edge);
    }

    // NB: `ClipperBase.findEdgeWithMatchingLocMin` (Engine.ts:2636-2650) is only called
    // from the open-path branch of `intersectEdges` (Engine.ts:2399), which this port
    // never reaches (see module doc) — not ported.

    /// TS: `ClipperBase.addOutPt` (Engine.ts:2652-2673).
    fn add_out_pt(&mut self, ae: usize, pt: Point64) -> usize {
        // Outrec.OutPts: a circular doubly-linked-list of OutPt where ...
        // opFront[.Prev]* ~~~> opBack & opBack == opFront.Next
        let outrec = self.active_pool[ae].outrec.expect("hot edge has outrec");
        let to_front = self.is_front(ae);
        let op_front = self.outrec_list[outrec].pts.expect("hot outrec has pts");
        let op_back = self.out_pts[op_front].next;

        if to_front && pt.x == self.out_pts[op_front].pt.x && pt.y == self.out_pts[op_front].pt.y {
            return op_front;
        } else if !to_front
            && pt.x == self.out_pts[op_back].pt.x
            && pt.y == self.out_pts[op_back].pt.y
        {
            return op_back;
        }

        let new_op = self.new_out_pt(pt, outrec);
        self.out_pts[op_back].prev = new_op;
        self.out_pts[new_op].prev = op_front;
        self.out_pts[new_op].next = op_back;
        self.out_pts[op_front].next = new_op;
        if to_front {
            self.outrec_list[outrec].pts = Some(new_op);
        }
        new_op
    }

    /// TS: `ClipperBase.addLocalMaxPoly` (Engine.ts:2675-2720).
    fn add_local_max_poly(&mut self, ae1: usize, ae2: usize, pt: Point64) -> Option<usize> {
        if self.is_joined(ae1) {
            self.split(ae1, pt);
        }
        if self.is_joined(ae2) {
            self.split(ae2, pt);
        }

        if self.is_front(ae1) == self.is_front(ae2) {
            if self.is_open_end(&self.active_pool[ae1]) {
                let outrec = self.active_pool[ae1].outrec.expect("hot edge has outrec");
                self.swap_front_back_sides(outrec);
            } else if self.is_open_end(&self.active_pool[ae2]) {
                let outrec = self.active_pool[ae2].outrec.expect("hot edge has outrec");
                self.swap_front_back_sides(outrec);
            } else {
                self.succeeded = false;
                return None;
            }
        }

        let result = self.add_out_pt(ae1, pt);
        if self.active_pool[ae1].outrec == self.active_pool[ae2].outrec {
            let outrec = self.active_pool[ae1].outrec.expect("hot edge has outrec");
            self.outrec_list[outrec].pts = Some(result);

            if self.using_polytree {
                let e = self.get_prev_hot_edge(ae1);
                match e {
                    None => self.outrec_list[outrec].owner = None,
                    Some(e) => {
                        let e_outrec = self.active_pool[e].outrec.expect("hot edge has outrec");
                        self.set_owner(outrec, e_outrec);
                    }
                }
                // nb: outRec.owner here is likely NOT the real owner but this will be
                // fixed in DeepCheckOwner()
            }
            self.uncouple_out_rec(ae1);
        }
        // and to preserve the winding orientation of outrec ...
        else if self.is_open(&self.active_pool[ae1]) {
            if self.active_pool[ae1].wind_dx < 0 {
                self.join_outrec_paths(ae1, ae2);
            } else {
                self.join_outrec_paths(ae2, ae1);
            }
        } else {
            let ae1_outrec = self.active_pool[ae1].outrec.expect("hot edge has outrec");
            let ae2_outrec = self.active_pool[ae2].outrec.expect("hot edge has outrec");
            if self.outrec_list[ae1_outrec].idx < self.outrec_list[ae2_outrec].idx {
                self.join_outrec_paths(ae1, ae2);
            } else {
                self.join_outrec_paths(ae2, ae1);
            }
        }
        Some(result)
    }

    /// TS: `ClipperBase.swapFrontBackSides` (Engine.ts:2722-2729).
    fn swap_front_back_sides(&mut self, outrec: usize) {
        // while this proc. is needed for open paths it's almost never needed for
        // closed paths
        let outrec_entry = &mut self.outrec_list[outrec];
        std::mem::swap(&mut outrec_entry.front_edge, &mut outrec_entry.back_edge);
        let pts = self.outrec_list[outrec]
            .pts
            .expect("swapFrontBackSides requires pts");
        self.outrec_list[outrec].pts = Some(self.out_pts[pts].next);
    }

    /// TS: `ClipperBase.setOwner` (Engine.ts:2731-2746).
    fn set_owner(&mut self, outrec: usize, new_owner: usize) {
        // precondition1: new_owner is never null (its `usize` type here already
        // enforces that)
        while let Some(owner) = self.outrec_list[new_owner].owner {
            if self.outrec_list[owner].pts.is_some() {
                break;
            }
            self.outrec_list[new_owner].owner = self.outrec_list[owner].owner;
        }

        // make sure that outrec isn't an owner of newOwner
        let mut tmp = Some(new_owner);
        while let Some(t) = tmp {
            if t == outrec {
                break;
            }
            tmp = self.outrec_list[t].owner;
        }
        if tmp.is_some() {
            self.outrec_list[new_owner].owner = self.outrec_list[outrec].owner;
        }
        self.outrec_list[outrec].owner = Some(new_owner);
    }

    /// TS: `ClipperBase.uncoupleOutRec` (Engine.ts:2748-2755).
    fn uncouple_out_rec(&mut self, ae: usize) {
        let Some(outrec) = self.active_pool[ae].outrec else {
            return;
        };
        let front = self.outrec_list[outrec]
            .front_edge
            .expect("uncoupleOutRec requires frontEdge");
        let back = self.outrec_list[outrec]
            .back_edge
            .expect("uncoupleOutRec requires backEdge");
        self.active_pool[front].outrec = None;
        self.active_pool[back].outrec = None;
        self.outrec_list[outrec].front_edge = None;
        self.outrec_list[outrec].back_edge = None;
    }

    /// TS: `ClipperBase.joinOutrecPaths` (Engine.ts:2757-2801).
    fn join_outrec_paths(&mut self, ae1: usize, ae2: usize) {
        // join ae2 outrec path onto ae1 outrec path and then delete ae2 outrec path
        // pointers. (NB Only very rarely do the joining ends share the same coords.)
        let ae1_outrec = self.active_pool[ae1].outrec.expect("hot edge has outrec");
        let ae2_outrec = self.active_pool[ae2].outrec.expect("hot edge has outrec");
        let p1_start = self.outrec_list[ae1_outrec]
            .pts
            .expect("hot outrec has pts");
        let p2_start = self.outrec_list[ae2_outrec]
            .pts
            .expect("hot outrec has pts");
        let p1_end = self.out_pts[p1_start].next;
        let p2_end = self.out_pts[p2_start].next;
        if self.is_front(ae1) {
            self.out_pts[p2_end].prev = p1_start;
            self.out_pts[p1_start].next = p2_end;
            self.out_pts[p2_start].next = p1_end;
            self.out_pts[p1_end].prev = p2_start;
            self.outrec_list[ae1_outrec].pts = Some(p2_start);
            // nb: if IsOpen(e1) then e1 & e2 must be a 'maximaPair'
            self.outrec_list[ae1_outrec].front_edge = self.outrec_list[ae2_outrec].front_edge;
            if let Some(fe) = self.outrec_list[ae1_outrec].front_edge {
                self.active_pool[fe].outrec = Some(ae1_outrec);
            }
        } else {
            self.out_pts[p1_end].prev = p2_start;
            self.out_pts[p2_start].next = p1_end;
            self.out_pts[p1_start].next = p2_end;
            self.out_pts[p2_end].prev = p1_start;

            self.outrec_list[ae1_outrec].back_edge = self.outrec_list[ae2_outrec].back_edge;
            if let Some(be) = self.outrec_list[ae1_outrec].back_edge {
                self.active_pool[be].outrec = Some(ae1_outrec);
            }
        }

        // after joining, the ae2.OutRec must contains no vertices ...
        self.outrec_list[ae2_outrec].front_edge = None;
        self.outrec_list[ae2_outrec].back_edge = None;
        self.outrec_list[ae2_outrec].pts = None;
        self.set_owner(ae2_outrec, ae1_outrec);

        if self.is_open_end(&self.active_pool[ae1]) {
            self.outrec_list[ae2_outrec].pts = self.outrec_list[ae1_outrec].pts;
            self.outrec_list[ae1_outrec].pts = None;
        }

        // and ae1 and ae2 are maxima and are about to be dropped from the Actives list.
        self.active_pool[ae1].outrec = None;
        self.active_pool[ae2].outrec = None;
    }

    /// TS: `ClipperBase.swapOutrecs` (Engine.ts:2803-2831).
    fn swap_outrecs(&mut self, ae1: usize, ae2: usize) {
        let or1 = self.active_pool[ae1].outrec; // at least one edge has
        let or2 = self.active_pool[ae2].outrec; // an assigned outrec
        if or1 == or2 {
            let or1 = or1.expect("swapOutrecs precondition: at least one edge has an outrec");
            let outrec = &mut self.outrec_list[or1];
            std::mem::swap(&mut outrec.front_edge, &mut outrec.back_edge);
            return;
        }

        if let Some(or1) = or1 {
            if self.outrec_list[or1].front_edge == Some(ae1) {
                self.outrec_list[or1].front_edge = Some(ae2);
            } else {
                self.outrec_list[or1].back_edge = Some(ae2);
            }
        }

        if let Some(or2) = or2 {
            if self.outrec_list[or2].front_edge == Some(ae2) {
                self.outrec_list[or2].front_edge = Some(ae1);
            } else {
                self.outrec_list[or2].back_edge = Some(ae1);
            }
        }

        self.active_pool[ae1].outrec = or2;
        self.active_pool[ae2].outrec = or1;
    }

    /// TS: `ClipperBase.disposeIntersectNodes` (Engine.ts:2833-2835).
    fn dispose_intersect_nodes(&mut self) {
        self.intersect_list.clear();
    }

    /// TS: `ClipperBase.ptsReallyClose` (Engine.ts:2837-2839).
    fn pts_really_close(pt1: Point64, pt2: Point64) -> bool {
        (pt1.x - pt2.x).abs() < 2.0 && (pt1.y - pt2.y).abs() < 2.0
    }

    /// TS: `ClipperBase.isVerySmallTriangle` (Engine.ts:2841-2846).
    fn is_very_small_triangle(&self, op: usize) -> bool {
        let next = self.out_pts[op].next;
        let prev = self.out_pts[op].prev;
        self.out_pts[next].next == prev
            && (Self::pts_really_close(self.out_pts[prev].pt, self.out_pts[next].pt)
                || Self::pts_really_close(self.out_pts[op].pt, self.out_pts[next].pt)
                || Self::pts_really_close(self.out_pts[op].pt, self.out_pts[prev].pt))
    }

    /// TS: `ClipperBase.buildPath` (Engine.ts:2848-2878).
    fn build_path(
        &self,
        op: Option<usize>,
        reverse: bool,
        is_open: bool,
        path: &mut Path64,
    ) -> bool {
        let Some(op) = op else {
            return false;
        };
        if self.out_pts[op].next == op
            || (!is_open && self.out_pts[op].next == self.out_pts[op].prev)
        {
            return false;
        }
        path.clear();

        let mut last_pt;
        let mut op2;
        let op_final;

        if reverse {
            last_pt = self.out_pts[op].pt;
            op2 = self.out_pts[op].prev;
            op_final = op;
        } else {
            let advanced = self.out_pts[op].next;
            last_pt = self.out_pts[advanced].pt;
            op2 = self.out_pts[advanced].next;
            op_final = advanced;
        }
        path.push(last_pt);

        while op2 != op_final {
            if !(self.out_pts[op2].pt.x == last_pt.x && self.out_pts[op2].pt.y == last_pt.y) {
                last_pt = self.out_pts[op2].pt;
                path.push(last_pt);
            }
            if reverse {
                op2 = self.out_pts[op2].prev;
            } else {
                op2 = self.out_pts[op2].next;
            }
        }

        path.len() != 3 || is_open || !self.is_very_small_triangle(op2)
    }

    /// TS: `ClipperBase.buildPaths` (Engine.ts:2880-2906).
    fn build_paths(&mut self, solution_closed: &mut Paths64, solution_open: &mut Paths64) -> bool {
        solution_closed.clear();
        solution_open.clear();

        // outrecList.length is not static here because cleanCollinear can indirectly
        // add additional OutRec
        let mut i = 0;
        while i < self.outrec_list.len() {
            let outrec = i;
            i += 1;
            if self.outrec_list[outrec].pts.is_none() {
                continue;
            }

            let mut path = Path64::new();
            if self.outrec_list[outrec].is_open {
                let pts = self.outrec_list[outrec].pts;
                if self.build_path(pts, self.reverse_solution, true, &mut path) {
                    solution_open.push(path);
                }
            } else {
                self.clean_collinear(Some(outrec));
                // closed paths should always return a Positive orientation except when
                // ReverseSolution == true
                let pts = self.outrec_list[outrec].pts;
                if self.build_path(pts, self.reverse_solution, false, &mut path) {
                    solution_closed.push(path);
                }
            }
        }
        true
    }

    /// TS: `ClipperBase.buildTree` (Engine.ts:2908-2932). `tree` corresponds to TS's
    /// `polytree: PolyPathBase` parameter, threaded separately from `self` since
    /// `PolyTree64` is caller-owned output, not part of the arena `self` owns (see
    /// [`Self::recursive_check_owners`]'s doc comment for why it needs the same
    /// threading).
    fn build_tree(&mut self, tree: &mut PolyTree64, solution_open: &mut Paths64) {
        tree.clear();
        solution_open.clear();

        // outrecList.length is not static here because checkBounds below can
        // indirectly add additional OutRec (via fixOutRecPts & cleanCollinear)
        let mut i = 0;
        while i < self.outrec_list.len() {
            let outrec = i;
            i += 1;
            if self.outrec_list[outrec].pts.is_none() {
                continue;
            }

            if self.outrec_list[outrec].is_open {
                let mut open_path = Path64::new();
                let pts = self.outrec_list[outrec].pts;
                if self.build_path(pts, self.reverse_solution, true, &mut open_path) {
                    solution_open.push(open_path);
                }
                continue;
            }

            if self.check_bounds(outrec) {
                self.recursive_check_owners(outrec, PolyTree64::ROOT, tree);
            }
        }
    }

    /// TS: `ClipperBase.checkBounds` (Engine.ts:2934-2944).
    fn check_bounds(&mut self, outrec: usize) -> bool {
        if self.outrec_list[outrec].pts.is_none() {
            return false;
        }
        if !rect64_utils::is_empty(self.outrec_list[outrec].bounds) {
            return true;
        }
        self.clean_collinear(Some(outrec));
        let pts = self.outrec_list[outrec].pts;
        if pts.is_none() {
            return false;
        }
        // `outrec.path` is mutated in place by TS's `buildPath(outrec.pts, ..., outrec.path)`
        // (an out-parameter). Temporarily taking ownership of the field lets
        // `build_path` borrow `&self` (for `out_pts` traversal) without aliasing the
        // very field it's writing into — see [`Self::check_bounds`]'s callers for the
        // analogous pattern.
        let mut path = std::mem::take(&mut self.outrec_list[outrec].path);
        let ok = self.build_path(pts, self.reverse_solution, false, &mut path);
        self.outrec_list[outrec].path = path;
        if !ok {
            return false;
        }
        self.outrec_list[outrec].bounds = get_bounds(&self.outrec_list[outrec].path);
        true
    }

    /// TS: `ClipperBase.recursiveCheckOwners` (Engine.ts:2946-2970). `polypath`/`tree`:
    /// see [`Self::build_tree`]'s doc comment — `polypath` is always
    /// [`PolyTree64::ROOT`] in every reachable call (TS threads the same root through
    /// every recursive call too; kept as an explicit parameter for 1:1 fidelity with
    /// the TS signature rather than hardcoding the constant).
    fn recursive_check_owners(&mut self, outrec: usize, polypath: usize, tree: &mut PolyTree64) {
        // pre-condition: outrec will have valid bounds
        // post-condition: if a valid path, outrec will have a polypath
        if self.outrec_list[outrec].polypath.is_some()
            || rect64_utils::is_empty(self.outrec_list[outrec].bounds)
        {
            return;
        }

        while let Some(owner) = self.outrec_list[outrec].owner {
            if self.outrec_list[owner].splits.is_some() && self.check_split_owner(outrec, owner) {
                break;
            }
            let owner_has_pts = self.outrec_list[owner].pts.is_some();
            if owner_has_pts
                && self.check_bounds(owner)
                // Fast reject: a container must contain the child's bounds.
                && rect64_utils::contains_rect(
                    self.outrec_list[owner].bounds,
                    self.outrec_list[outrec].bounds,
                )
                && self.path1_inside_path2(
                    self.outrec_list[outrec]
                        .pts
                        .expect("bounds non-empty implies pts (checkBounds precondition)"),
                    self.outrec_list[owner].pts.expect("just verified owner_has_pts"),
                )
            {
                break;
            }
            self.outrec_list[outrec].owner = self.outrec_list[owner].owner;
        }

        if let Some(owner) = self.outrec_list[outrec].owner {
            if self.outrec_list[owner].polypath.is_none() {
                self.recursive_check_owners(owner, polypath, tree);
            }
            let owner_polypath = self.outrec_list[owner]
                .polypath
                .expect("just ensured owner.polypath is set (directly or via recursion)");
            let path = self.outrec_list[outrec].path.clone();
            self.outrec_list[outrec].polypath = Some(tree.add_child(owner_polypath, path));
        } else {
            let path = self.outrec_list[outrec].path.clone();
            self.outrec_list[outrec].polypath = Some(tree.add_child(polypath, path));
        }
    }

    /// TS: `ClipperBase.cleanCollinear` (Engine.ts:2972-3010).
    fn clean_collinear(&mut self, outrec: Option<usize>) {
        let Some(outrec) = self.get_real_out_rec(outrec) else {
            return;
        };
        if self.outrec_list[outrec].is_open {
            return;
        }

        if !self.is_valid_closed_path(self.outrec_list[outrec].pts) {
            self.outrec_list[outrec].pts = None;
            return;
        }

        let mut start_op = self.outrec_list[outrec]
            .pts
            .expect("just validated non-null");
        let mut op2: Option<usize> = Some(start_op);

        loop {
            // NB if preserveCollinear == true, then only remove 180 deg. spikes
            let remove = if let Some(o2) = op2 {
                let prev = self.out_pts[o2].prev;
                let next = self.out_pts[o2].next;
                is_collinear(
                    self.out_pts[prev].pt,
                    self.out_pts[o2].pt,
                    self.out_pts[next].pt,
                ) && ((self.out_pts[o2].pt.x == self.out_pts[prev].pt.x
                    && self.out_pts[o2].pt.y == self.out_pts[prev].pt.y)
                    || (self.out_pts[o2].pt.x == self.out_pts[next].pt.x
                        && self.out_pts[o2].pt.y == self.out_pts[next].pt.y)
                    || !self.preserve_collinear
                    || dot_product_sign(
                        self.out_pts[prev].pt,
                        self.out_pts[o2].pt,
                        self.out_pts[next].pt,
                    ) < 0)
            } else {
                false
            };

            if remove {
                let o2 = op2.expect("remove is only ever true when op2 is Some");
                if Some(o2) == self.outrec_list[outrec].pts {
                    self.outrec_list[outrec].pts = Some(self.out_pts[o2].prev);
                }
                op2 = self.dispose_out_pt(o2);
                if !self.is_valid_closed_path(op2) {
                    self.outrec_list[outrec].pts = None;
                    return;
                }
                start_op = op2.expect("is_valid_closed_path(op2) implies op2 is Some");
                continue;
            }
            let Some(o2) = op2 else {
                break;
            };
            let next_o2 = self.out_pts[o2].next;
            op2 = Some(next_o2);
            if next_o2 == start_op {
                break;
            }
        }

        self.fix_self_intersects(outrec);
    }

    /// TS: `ClipperBase.isValidClosedPath` (Engine.ts:3012-3015).
    fn is_valid_closed_path(&self, op: Option<usize>) -> bool {
        let Some(op) = op else {
            return false;
        };
        self.out_pts[op].next != op
            && (self.out_pts[op].next != self.out_pts[op].prev || !self.is_very_small_triangle(op))
    }

    /// TS: `ClipperBase.disposeOutPt` (Engine.ts:3017-3022).
    fn dispose_out_pt(&mut self, op: usize) -> Option<usize> {
        let next = self.out_pts[op].next;
        let prev = self.out_pts[op].prev;
        let result = if next == op { None } else { Some(next) };
        self.out_pts[prev].next = next;
        self.out_pts[next].prev = prev;
        result
    }

    /// TS: `ClipperBase.fixSelfIntersects` (Engine.ts:3024-3047). TS's `op2.next &&
    /// op2.next.next` guard is always true here (this port's `OutPt.next`/`.prev` are
    /// never actually absent within a valid ring — see [`OutPtNode`]'s doc comment) and
    /// is not translated.
    fn fix_self_intersects(&mut self, outrec: usize) {
        let mut op2 = self.outrec_list[outrec]
            .pts
            .expect("fixSelfIntersects requires pts");
        {
            let next0 = self.out_pts[op2].next;
            if self.out_pts[op2].prev == self.out_pts[next0].next {
                return; // because triangles can't self-intersect
            }
        }

        loop {
            let next = self.out_pts[op2].next;
            let next_next = self.out_pts[next].next;
            let prev = self.out_pts[op2].prev;
            if Self::bounding_boxes_overlap(
                self.out_pts[prev].pt,
                self.out_pts[op2].pt,
                self.out_pts[next].pt,
                self.out_pts[next_next].pt,
            ) && segs_intersect(
                self.out_pts[prev].pt,
                self.out_pts[op2].pt,
                self.out_pts[next].pt,
                self.out_pts[next_next].pt,
                false,
            ) {
                let outrec_pts = self.outrec_list[outrec].pts;
                if Some(op2) == outrec_pts || Some(next) == outrec_pts {
                    let pts = outrec_pts.expect("outrec.pts is Some here (op2/next matched it)");
                    self.outrec_list[outrec].pts = Some(self.out_pts[pts].prev);
                }
                self.do_split_op(outrec, op2);
                let Some(new_pts) = self.outrec_list[outrec].pts else {
                    return;
                };
                op2 = new_pts;
                let n = self.out_pts[op2].next;
                let nn = self.out_pts[n].next;
                if self.out_pts[op2].prev == nn {
                    break;
                }
                continue;
            }

            op2 = self.out_pts[op2].next;
            if Some(op2) == self.outrec_list[outrec].pts {
                break;
            }
        }
    }

    /// TS: `ClipperBase.doSplitOp` (Engine.ts:3049-3115).
    fn do_split_op(&mut self, outrec: usize, split_op: usize) {
        // splitOp.prev <=> splitOp && splitOp.next <=> splitOp.next.next are
        // intersecting
        let prev_op = self.out_pts[split_op].prev;
        let split_next = self.out_pts[split_op].next;
        let next_next_op = self.out_pts[split_next].next;
        self.outrec_list[outrec].pts = Some(prev_op);

        // doSplitOp is only reached when segments are known to intersect, so the
        // result is never null here.
        let mut ip = get_line_intersect_pt(
            self.out_pts[prev_op].pt,
            self.out_pts[split_op].pt,
            self.out_pts[split_next].pt,
            self.out_pts[next_next_op].pt,
        )
        .expect("doSplitOp is only reached for known-intersecting segments (TS `!`)");

        if let Some(z_callback) = self.z_callback.as_ref() {
            let bot1 = self.out_pts[prev_op].pt;
            let top1 = self.out_pts[split_op].pt;
            let bot2 = self.out_pts[split_next].pt;
            let top2 = self.out_pts[next_next_op].pt;
            z_callback(bot1, top1, bot2, top2, &mut ip);
        }

        let double_area1 = Self::area_out_pt(prev_op, &self.out_pts);
        let zero = BigInt::from(0);
        let abs_double_area1 = if double_area1 < zero {
            -double_area1.clone()
        } else {
            double_area1.clone()
        };

        if abs_double_area1 < BigInt::from(4) {
            // area < 2
            self.outrec_list[outrec].pts = None;
            return;
        }

        let double_area2 =
            Self::area_triangle(ip, self.out_pts[split_op].pt, self.out_pts[split_next].pt);
        let abs_double_area2 = if double_area2 < BigInt::from(0) {
            -double_area2.clone()
        } else {
            double_area2.clone()
        };

        // de-link splitOp and splitOp.next from the path while inserting the
        // intersection point
        if (ip.x == self.out_pts[prev_op].pt.x && ip.y == self.out_pts[prev_op].pt.y)
            || (ip.x == self.out_pts[next_next_op].pt.x && ip.y == self.out_pts[next_next_op].pt.y)
        {
            self.out_pts[next_next_op].prev = prev_op;
            self.out_pts[prev_op].next = next_next_op;
        } else {
            let new_op2 = self.new_out_pt(ip, outrec);
            self.out_pts[new_op2].prev = prev_op;
            self.out_pts[new_op2].next = next_next_op;
            self.out_pts[next_next_op].prev = new_op2;
            self.out_pts[prev_op].next = new_op2;
        }

        if abs_double_area2 <= BigInt::from(2) // area <= 1
            || (abs_double_area2 <= abs_double_area1
                && ((double_area2 > zero) != (double_area1 > zero)))
        {
            return;
        }

        let new_out_rec = self.new_out_rec();
        self.outrec_list[new_out_rec].owner = self.outrec_list[outrec].owner;
        self.out_pts[split_op].outrec = new_out_rec;
        self.out_pts[split_next].outrec = new_out_rec;

        // TS: `const newOp = new OutPt(ip, newOutRec); newOp.prev = splitOp.next!;
        // newOp.next = splitOp;` (Engine.ts:3099-3101) — constructed self-circular by
        // `new OutPt`, then immediately overwritten; pushed directly with the final
        // `next`/`prev` values rather than round-tripping through `new_out_pt`.
        let new_op = self.out_pts.len();
        self.out_pts.push(OutPtNode {
            pt: ip,
            next: split_op,
            prev: split_next,
            outrec: new_out_rec,
            horz: false,
        });
        self.outrec_list[new_out_rec].pts = Some(new_op);
        self.out_pts[split_op].prev = new_op;
        self.out_pts[split_next].next = new_op;

        if !self.using_polytree {
            return;
        }

        if self.path1_inside_path2(prev_op, new_op) {
            let outrec_idx = self.outrec_list[outrec].idx;
            if self.outrec_list[new_out_rec].splits.is_none() {
                self.outrec_list[new_out_rec].splits = Some(Vec::new());
            }
            self.outrec_list[new_out_rec]
                .splits
                .as_mut()
                .expect("just ensured Some")
                .push(outrec_idx);
        } else {
            let new_out_rec_idx = self.outrec_list[new_out_rec].idx;
            if self.outrec_list[outrec].splits.is_none() {
                self.outrec_list[outrec].splits = Some(Vec::new());
            }
            self.outrec_list[outrec]
                .splits
                .as_mut()
                .expect("just ensured Some")
                .push(new_out_rec_idx);
        }
    }

    /// TS: `ClipperBase.areaOutPt` (Engine.ts:3117-3155), `private static`. Takes the
    /// `out_pts` arena directly (rather than `&self`) since its only caller,
    /// [`Self::do_split_op`], needs to call it while `self.out_pts` is otherwise free to
    /// borrow immutably alongside other `&self.outrec_list` field access.
    fn area_out_pt(op: usize, out_pts: &[OutPtNode]) -> BigInt {
        let max_coord = max_coord_for_safe_area_product();
        let mut area = 0.0_f64;
        let mut all_small = true;
        let mut op2 = op;
        loop {
            let prev = out_pts[op2].prev;
            let pt = out_pts[op2].pt;
            let prev_pt = out_pts[prev].pt;
            if prev_pt.x.abs() >= max_coord
                || prev_pt.y.abs() >= max_coord
                || pt.x.abs() >= max_coord
                || pt.y.abs() >= max_coord
            {
                all_small = false;
                break;
            }
            area += (prev_pt.y + pt.y) * (prev_pt.x - pt.x);
            op2 = out_pts[op2].next;
            if op2 == op {
                break;
            }
        }

        if all_small {
            return f64_to_bigint(math_round(area));
        }

        let mut area_big = BigInt::from(0);
        op2 = op;
        loop {
            let prev = out_pts[op2].prev;
            let prev_pt = out_pts[prev].pt;
            let cur_pt = out_pts[op2].pt;
            if is_safe_integer(prev_pt.y)
                && is_safe_integer(cur_pt.y)
                && is_safe_integer(prev_pt.x)
                && is_safe_integer(cur_pt.x)
            {
                let sum_big = f64_to_bigint(prev_pt.y) + f64_to_bigint(cur_pt.y);
                let diff_big = f64_to_bigint(prev_pt.x) - f64_to_bigint(cur_pt.x);
                area_big += sum_big * diff_big;
            } else {
                let sum = prev_pt.y + cur_pt.y;
                let diff = prev_pt.x - cur_pt.x;
                area_big += f64_to_bigint(math_round(sum * diff));
            }
            op2 = out_pts[op2].next;
            if op2 == op {
                break;
            }
        }
        area_big
    }

    /// TS: `ClipperBase.areaTriangle` (Engine.ts:3157-3181). TS declares this as a
    /// (non-static) instance method but its body never reads `this` — ported as a
    /// plain associated function, matching this file's existing convention for other
    /// TS instance methods with no actual `this` dependency (e.g. [`Self::is_front`]'s
    /// sibling static helpers above).
    fn area_triangle(pt1: Point64, pt2: Point64, pt3: Point64) -> BigInt {
        let max_coord = max_coord_for_safe_area_product();
        if pt1.x.abs() < max_coord
            && pt1.y.abs() < max_coord
            && pt2.x.abs() < max_coord
            && pt2.y.abs() < max_coord
            && pt3.x.abs() < max_coord
            && pt3.y.abs() < max_coord
        {
            let area = (pt3.y + pt1.y) * (pt3.x - pt1.x)
                + (pt1.y + pt2.y) * (pt1.x - pt2.x)
                + (pt2.y + pt3.y) * (pt2.x - pt3.x);
            return f64_to_bigint(math_round(area));
        }

        if is_safe_integer(pt1.x)
            && is_safe_integer(pt1.y)
            && is_safe_integer(pt2.x)
            && is_safe_integer(pt2.y)
            && is_safe_integer(pt3.x)
            && is_safe_integer(pt3.y)
        {
            let term1 = (f64_to_bigint(pt3.y) + f64_to_bigint(pt1.y))
                * (f64_to_bigint(pt3.x) - f64_to_bigint(pt1.x));
            let term2 = (f64_to_bigint(pt1.y) + f64_to_bigint(pt2.y))
                * (f64_to_bigint(pt1.x) - f64_to_bigint(pt2.x));
            let term3 = (f64_to_bigint(pt2.y) + f64_to_bigint(pt3.y))
                * (f64_to_bigint(pt2.x) - f64_to_bigint(pt3.x));
            return term1 + term2 + term3;
        }

        let area = (pt3.y + pt1.y) * (pt3.x - pt1.x)
            + (pt1.y + pt2.y) * (pt1.x - pt2.x)
            + (pt2.y + pt3.y) * (pt2.x - pt3.x);
        f64_to_bigint(math_round(area))
    }

    /// TS: `ClipperBase.isValidOwner` (Engine.ts:3183-3188).
    fn is_valid_owner(&self, out_rec: Option<usize>, mut test_owner: Option<usize>) -> bool {
        while let Some(t) = test_owner {
            if Some(t) == out_rec {
                break;
            }
            test_owner = self.outrec_list[t].owner;
        }
        test_owner.is_none()
    }

    /// TS: `ClipperBase.checkSplitOwner` (Engine.ts:3195-3219). TS's `splits: number[]`
    /// parameter is a direct reference to one specific `OutRec.splits` array/`Vec`;
    /// this port instead threads the *owning* `OutRec`'s id (`splits_owner`) and
    /// re-reads `self.outrec_list[splits_owner].splits` fresh on every loop
    /// iteration/recursive call, which observes the exact same live growth the TS
    /// comment calls out ("splits' is modified inside this loop (#1029)") since
    /// `splits_owner`'s `.splits` field is never reassigned to a *different* `Vec`
    /// while this recursion is live (only ever grown via `.push`, or left `None`
    /// until first grown) — see [`Self::process_horz_joins`]/[`Self::move_splits`],
    /// the only two sites that ever assign `.splits`, neither reachable from
    /// `buildTree`'s call graph (both run once, earlier, at the end of the scanbeam
    /// sweep).
    fn check_split_owner(&mut self, outrec: usize, splits_owner: usize) -> bool {
        let mut i = 0usize;
        loop {
            let len = match &self.outrec_list[splits_owner].splits {
                Some(s) => s.len(),
                None => return false,
            };
            if i >= len {
                return false;
            }
            let mut split = self.outrec_list[splits_owner]
                .splits
                .as_ref()
                .expect("checked Some above")[i];

            if self.outrec_list[split].pts.is_none()
                && self.outrec_list[split].splits.is_some()
                && self.check_split_owner(outrec, split)
            {
                return true; // #942
            }

            let Some(real_split) = self.get_real_out_rec(Some(split)) else {
                i += 1;
                continue;
            };
            split = real_split;
            if split == outrec || self.outrec_list[split].recursive_split == Some(outrec) {
                i += 1;
                continue;
            }
            self.outrec_list[split].recursive_split = Some(outrec); // #599

            if self.outrec_list[split].splits.is_some() && self.check_split_owner(outrec, split) {
                return true;
            }

            if !self.check_bounds(split)
                || !rect64_utils::contains_rect(
                    self.outrec_list[split].bounds,
                    self.outrec_list[outrec].bounds,
                )
                || !self.path1_inside_path2(
                    self.outrec_list[outrec]
                        .pts
                        .expect("checkSplitOwner requires outrec.pts (TS `!`)"),
                    self.outrec_list[split]
                        .pts
                        .expect("checkBounds(split) true implies split.pts (TS `!`)"),
                )
            {
                i += 1;
                continue;
            }

            if !self.is_valid_owner(Some(outrec), Some(split)) {
                // split is owned by outrec (#957)
                self.outrec_list[split].owner = self.outrec_list[outrec].owner;
            }

            self.outrec_list[outrec].owner = Some(split); // found in split
            return true;
        }
    }

    // -----------------------------------------------------------------------
    // Clipper64 public execute surface (Engine.ts:3222-3293 `class Clipper64`).
    // -----------------------------------------------------------------------

    /// TS: `Clipper64.execute` (Engine.ts:3253-3272), `Paths64` overload. Corresponds
    /// to the `Array.isArray(solutionOrTree)` branch of the merged TS overload
    /// (Engine.ts:3255-3272). This port splits TS's one dynamically-typed `execute`
    /// into two plainly-named methods ([`Self::execute_paths`]/[`Self::execute_poly_tree`])
    /// since Rust has no runtime `Array.isArray` dispatch — callers already know which
    /// output shape they want (`booleanOp` vs. `booleanOpWithPolyTree`,
    /// `Clipper.ts:81-101`), so this is a mechanical un-overload, not a behavior change.
    /// TS's `try { ... } catch { this.succeeded = false; }` has no translation here:
    /// every exception TS could throw from `executeInternal`/`buildPaths` in the
    /// reachable (closed-paths-only) subset is unreachable dead code in this port (see
    /// module doc), so nothing throws on any input this API can construct; wrapping in
    /// `catch_unwind` here would silently paper over a genuine port bug instead of
    /// surfacing it.
    pub fn execute_paths(
        &mut self,
        clip_type: ClipType,
        fill_rule: FillRule,
        solution_closed: &mut Paths64,
        solution_open: Option<&mut Paths64>,
    ) -> bool {
        solution_closed.clear();
        let mut local_open = Paths64::new();
        self.execute_internal(clip_type, fill_rule);
        self.build_paths(solution_closed, &mut local_open);
        if let Some(open) = solution_open {
            *open = local_open;
        }
        self.clear_solution_only();
        self.succeeded
    }

    /// TS: `Clipper64.execute` (Engine.ts:3253-3272), `PolyTree64` overload — see
    /// [`Self::execute_paths`]'s doc comment for why TS's one overloaded method
    /// becomes two here.
    pub fn execute_poly_tree(
        &mut self,
        clip_type: ClipType,
        fill_rule: FillRule,
        polytree: &mut PolyTree64,
        open_paths: Option<&mut Paths64>,
    ) -> bool {
        polytree.clear();
        let mut local_open = Paths64::new();
        self.using_polytree = true;
        self.execute_internal(clip_type, fill_rule);
        self.build_tree(polytree, &mut local_open);
        if let Some(open) = open_paths {
            *open = local_open;
        }
        self.clear_solution_only();
        self.succeeded
    }
}

// ---------------------------------------------------------------------------
// Clipper.ts public wrapper surface assigned to this port (Clipper.ts:81-101,
// 705-720): `booleanOp`, `booleanOpWithPolyTree`, `polyTreeToPaths64`.
// ---------------------------------------------------------------------------

/// TS: `booleanOp` (Clipper.ts:81-91).
pub fn boolean_op(
    clip_type: ClipType,
    subject: Option<&Paths64>,
    clip: Option<&Paths64>,
    fill_rule: FillRule,
) -> Paths64 {
    let mut solution = Paths64::new();
    let Some(subject) = subject else {
        return solution;
    };
    let mut c = Clipper64::new();
    c.add_paths(subject, PathType::Subject);
    if let Some(clip) = clip {
        c.add_paths(clip, PathType::Clip);
    }
    c.execute_paths(clip_type, fill_rule, &mut solution, None);
    solution
}

/// TS: `booleanOpWithPolyTree` (Clipper.ts:93-101).
pub fn boolean_op_with_poly_tree(
    clip_type: ClipType,
    subject: Option<&Paths64>,
    clip: Option<&Paths64>,
    polytree: &mut PolyTree64,
    fill_rule: FillRule,
) {
    let Some(subject) = subject else {
        return;
    };
    let mut c = Clipper64::new();
    c.add_paths(subject, PathType::Subject);
    if let Some(clip) = clip {
        c.add_paths(clip, PathType::Clip);
    }
    c.execute_poly_tree(clip_type, fill_rule, polytree, None);
}

/// TS: `addPolyNodeToPaths` (Clipper.ts:705-712), the private helper `polyTreeToPaths64`
/// (Clipper.ts:714-720) recurses through.
fn add_poly_node_to_paths(tree: &PolyTree64, node: usize, paths: &mut Paths64) {
    if let Some(poly) = tree.poly(node) {
        if !poly.is_empty() {
            paths.push(poly.clone());
        }
    }
    for i in 0..tree.count(node) {
        add_poly_node_to_paths(tree, tree.child(node, i), paths);
    }
}

/// TS: `polyTreeToPaths64` (Clipper.ts:714-720).
pub fn poly_tree_to_paths64(poly_tree: &PolyTree64) -> Paths64 {
    let mut result = Paths64::new();
    for i in 0..poly_tree.count(PolyTree64::ROOT) {
        add_poly_node_to_paths(poly_tree, poly_tree.child(PolyTree64::ROOT, i), &mut result);
    }
    result
}
