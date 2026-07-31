//! Search state, canonical keys, and scoring. TS counterparts:
//! `src/workers/algorithm/irregular/irregularBeamState.ts`,
//! `irregularPlacementScorer.ts`, `irregularLayoutScorer.ts`,
//! `irregularScoreGrid.ts`, and `src/workers/algorithm/sortPiecesForNesting.ts`.

pub mod beam_state;
pub mod gap_regions;
pub mod layout_scorer;
pub mod placement_scorer;
pub mod score_grid;
pub mod sort_pieces;
pub mod strict_decoder;
pub mod strict_family;
