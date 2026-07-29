//! The coordinator's event-emission seam: state-snapshot/portfolio-progress
//! notification, and the "selected layout reveal" snapshot sequence.
//!
//! TS source: `computeIrregularNesting.ts`'s `emitStateSnapshot`/
//! `emitPortfolioProgress` callback fields (`:118,120`), `emitSharedArchiveProgress`
//! (`:1443-1458`), and `selectedLayoutRevealSnapshots` (`:1659-1692`). See
//! `worker-coordination.md` §5/§9/§10 for the exact emission-order contract
//! this module exists to preserve: "one progress/history event per logical
//! step, delivered in emission order" -- modeled here as a plain Rust trait
//! (an event sink) rather than an Effect callback, per this crate's
//! established job-owned-state convention.

use std::collections::HashMap;
use std::sync::Arc;

use crate::domain::{IrregularPlacedPiece, IrregularPreparedPiece, PieceId};
use crate::search::beam_state::{IrregularBeamState, IrregularBeamStateInput};

use super::{
    IrregularPortfolioPhase, IrregularPortfolioProgress, IrregularStateSnapshot,
    IrregularStateSnapshotSource,
};
use crate::domain::IrregularLayoutScoreSummary;

/// TS: `ComputeIrregularNestingOptions.emitStateSnapshot`/`emitPortfolioProgress`
/// (`computeIrregularNesting.ts:118,120`), collapsed into one sink trait
/// (this crate's established "model the callback boundary as a trait"
/// pattern). Both methods default to a no-op so a caller that only cares
/// about one of the two events does not have to implement the other --
/// mirroring the TS side's independent `options?.field?.(...)` optional
/// chaining at every call site.
pub trait IrregularComputeEventSink {
    /// TS: `input.options?.emitStateSnapshot?.(snapshot, beamWidth)`
    /// (`:1205`).
    fn emit_state_snapshot(&mut self, _snapshot: &IrregularStateSnapshot, _beam_width: f64) {}

    /// TS: `input.options?.emitPortfolioProgress?.(progress)`
    /// (`emitSharedArchiveProgress`, `:1450-1456`). Returns nothing (the TS
    /// `Effect.Effect<void>` return is a fire-and-forget notification from
    /// this cluster's perspective; any failure handling belongs to the
    /// sink's own implementation).
    fn emit_portfolio_progress(&mut self, _progress: &IrregularPortfolioProgress) {}
}

/// A sink that observes nothing -- TS's `options === undefined` /
/// `options?.field === undefined` shape (`computeIrregularNesting.ts:349-352`:
/// "If none of the three apply, `options` itself is `undefined`"). The
/// default (empty) trait method bodies already make this correct without an
/// explicit impl, but a named unit type gives call sites (and tests) an
/// explicit, self-documenting "no observer" value instead of routing through
/// `Option<&mut dyn IrregularComputeEventSink>` everywhere.
#[derive(Default)]
pub struct NullEventSink;

impl IrregularComputeEventSink for NullEventSink {}

/// TS: `computeIrregularNesting.ts:1443-1458` `emitSharedArchiveProgress`.
/// `elapsed_ms` is clamped non-negative at both this call site and (TS)
/// every internal call site (`Math.max(0, elapsedMs)` composed with the
/// caller's own `Math.max(0, performance.now() - startedAt)`) -- clamping
/// again here is cheap, harmless, and matches the TS double-clamp exactly.
///
/// `sink` is a plain `&mut dyn IrregularComputeEventSink` (never
/// `Option<&mut dyn ...>`) so callers thread [`NullEventSink`] for "no
/// observer" (TS's `options === undefined`/`options?.emitPortfolioProgress
/// === undefined`) instead of an `Option`-wrapped trait object -- repeatedly
/// reborrowing a bare `Option<&mut dyn Trait>` across several sequential
/// call sites in the same function is a known rustc limitation (see
/// `result::coordinator`'s own top doc), whereas a plain `&mut dyn Trait`
/// parameter is implicitly, safely reborrowed by the compiler at every call
/// site.
pub fn emit_shared_archive_progress(
    sink: &mut dyn IrregularComputeEventSink,
    phase: IrregularPortfolioPhase,
    best_score: Option<IrregularLayoutScoreSummary>,
    elapsed_ms: f64,
) {
    let progress = IrregularPortfolioProgress {
        phase,
        best_score,
        elapsed_ms: elapsed_ms.max(0.0),
        decode_role: None,
    };
    sink.emit_portfolio_progress(&progress);
}

/// TS: `computeIrregularNesting.ts:1658-1692` `selectedLayoutRevealSnapshots`.
/// Builds a truthful scrub sequence from prefixes of the selected exact
/// layout: step `0` has nothing placed and every eventually-placed prepared
/// piece still "remaining"; the final step has everything placed and nothing
/// remaining. `unplaced_piece_ids` is carried through unchanged at every
/// step (TS: the same `unplacedPieceIds` parameter value on every
/// synthesized snapshot, not derived per-step).
pub fn selected_layout_reveal_snapshots(
    prepared_pieces: &[Arc<IrregularPreparedPiece>],
    placed_collision_geometries: &[Arc<IrregularPlacedPiece>],
    unplaced_piece_ids: &[PieceId],
) -> Vec<IrregularStateSnapshot> {
    let prepared_by_id: HashMap<PieceId, Arc<IrregularPreparedPiece>> = prepared_pieces
        .iter()
        .map(|piece| {
            let id = piece
                .piece_id
                .clone()
                .unwrap_or_else(|| piece.source.id.clone());
            (id, Arc::clone(piece))
        })
        .collect();

    (0..=placed_collision_geometries.len())
        .map(|step_index| {
            let placed: Vec<Arc<IrregularPlacedPiece>> =
                placed_collision_geometries[..step_index].to_vec();
            let remaining_prepared_pieces: Vec<Arc<IrregularPreparedPiece>> =
                placed_collision_geometries[step_index..]
                    .iter()
                    .filter_map(|placed| {
                        let id = placed
                            .placement
                            .piece_id
                            .clone()
                            .unwrap_or_else(|| placed.placement.source_piece_id.clone());
                        prepared_by_id.get(&id).cloned()
                    })
                    .collect();
            let placement_order: Vec<PieceId> = placed
                .iter()
                .map(|placed| {
                    placed
                        .placement
                        .piece_id
                        .clone()
                        .unwrap_or_else(|| placed.placement.source_piece_id.clone())
                })
                .collect();

            let state = IrregularBeamState::from_input(IrregularBeamStateInput {
                remaining_prepared_pieces,
                placed_collision_geometries: placed,
                unplaced_piece_ids: Some(unplaced_piece_ids.to_vec()),
                unplaced_source_piece_ids: None,
                placement_order,
                parent: None,
                placed_collision_index: None,
            });

            IrregularStateSnapshot {
                step_index: step_index as f64,
                beam_rank: 0.0,
                candidate_count: 1.0,
                source: Some(IrregularStateSnapshotSource::SharedArchive),
                state,
            }
        })
        .collect()
}
