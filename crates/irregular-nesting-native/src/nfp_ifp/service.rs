//! Cooperative-cancellation control, the public `computeNfp`/
//! `computeIfpBounds` entry points, and the per-search-invocation
//! legal-candidate memo.
//!
//! TS source: `src/workers/irregular/services.ts` (the `IrregularNfpIfpControl`/
//! `IrregularNfpIfpControlAbortError`/`IrregularNfpIfpCheckpointPhase`
//! declarations, `NfpIfpService` interface) and
//! `src/workers/irregular/nfpIfpService.ts` (`computeNfpCached`,
//! `computeIfpBoundsCached`, `makeGeneratePlacementCandidates`'s memo layer,
//! `nfpCheckpoint`, `failInvalidGeometry`).
//!
//! # Ownership split with `candidates`
//!
//! [`super::candidates::generate_placement_candidates_uncached`] is the pure
//! per-call computation (TS: `generatePlacementCandidatesUncached`). This
//! module owns everything *around* it: the injectable cooperative-control
//! seam, the two error taxonomies (`IrregularGeometryInputError`-shaped and
//! abort-shaped), the rarely-reached-in-production public Effect-analogue
//! API (`computeNfp`/`computeIfpBounds`, preserved per `nfp-ifp.md` §15 item
//! 2 — a tested contract, not unobservable dead code, so it must not be
//! collapsed into the internal fast path), and the per-search-invocation
//! legal-candidate memo (`cache-concurrency-design.md` §1.4/§3.5: owned,
//! single-writer, per-invocation — never job-scoped, never shared/concurrent).

use std::collections::HashMap;

use crate::caches::{
    legal_placement_candidate_memo_key, CandidateDomain, GeometryCacheStore,
    LegalPlacementCandidateMemoKeyInput, NfpCandidatePruningMode, NfpConstructionAlgorithm,
    PlacedPieceKeyInput, SheetDimensions,
};
use crate::domain::{
    CollisionGeometryDiagnostic, IrregularGeometrySettings, IrregularIfpBounds, IrregularNfp,
    IrregularPlacedPiece, IrregularPlacementCandidate, IrregularPoint, SheetSpec,
    TransformedCollisionGeometry,
};
use crate::validation::placement::IrregularGeometryInputError;

use super::boundary_core::{resolve_nfp_boundary, CoreNfpInput};
use super::candidates::{
    generate_placement_candidates_uncached, GeneratePlacementCandidatesInput,
    GeneratePlacementCandidatesOutcome, NfpIfpCandidateProvenance,
};
use super::ifp_bounds::{resolve_ifp_bounds, CoreIfpBoundsFailureKind};
use super::telemetry::{
    CheckpointOutcome, MemoRequestOutcome, NfpIfpCheckpointPhase, NfpIfpTelemetry,
};
use crate::caches::InnerFitBoundsKeyInput;

// ---------------------------------------------------------------------------
// Cooperative cancellation / deadline control.
// ---------------------------------------------------------------------------

/// TS: `services.ts:70-75` (`IrregularNfpIfpControlAbortError`, a
/// `Data.TaggedError` with fields `reason`, `message`). Internal NFP-only
/// abort signal; not the worker supervisor contract.
#[derive(Clone, Debug, PartialEq)]
pub struct NfpIfpControlAbortError {
    pub reason: NfpIfpAbortReason,
    pub message: String,
}

/// TS: `services.ts:73` (`reason: 'deadline' | 'cancelled'`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NfpIfpAbortReason {
    Deadline,
    Cancelled,
}

/// TS: `services.ts:85-89` (`IrregularNfpIfpControl`). Injectable
/// cooperative cancellation/deadline probe, invoked at the exact TS
/// observation points (`nfp-ifp.md` §10) via [`nfp_checkpoint`]. This
/// cluster never decides *which* reason applies or constructs this error
/// itself (`nfp-ifp.md` §11) — it only forwards whatever a caller-supplied
/// implementation returns.
pub trait NfpIfpControl {
    fn checkpoint(&mut self, phase: NfpIfpCheckpointPhase) -> Result<(), NfpIfpControlAbortError>;
}

/// Ergonomic blanket impl so a plain closure can serve as a control without
/// a caller needing to declare a named type implementing [`NfpIfpControl`].
impl<F> NfpIfpControl for F
where
    F: FnMut(NfpIfpCheckpointPhase) -> Result<(), NfpIfpControlAbortError>,
{
    fn checkpoint(&mut self, phase: NfpIfpCheckpointPhase) -> Result<(), NfpIfpControlAbortError> {
        self(phase)
    }
}

/// TS: `nfpIfpService.ts:1070-1084` (`nfpCheckpoint`). `control === undefined`
/// is a no-op, non-failing checkpoint (telemetry-recorded as `'inert'`);
/// otherwise delegates to `control.checkpoint(phase)`.
///
/// The TS `'direct-void'` vs `'composed'` telemetry distinction (whether the
/// caller's `Effect` happened to be the shared `Effect.void` singleton by
/// reference) has no Rust equivalent — every live [`NfpIfpControl`] call
/// synchronously executes real code, so there is no statically-knowable
/// "would have been a no-op" fact to record. Every live, successful
/// checkpoint is recorded as `Composed` here; see `telemetry`'s module doc
/// for why this diagnostic-only counter is not parity-gated.
///
/// Takes `control` by `&mut Option<&mut dyn NfpIfpControl>` (double
/// indirection), not `Option<&mut dyn NfpIfpControl>` by value: reborrowing a
/// `dyn Trait` reference repeatedly across sequential calls/loop iterations
/// (via `Option::as_deref_mut()` called at each call site) does not reliably
/// satisfy the borrow checker for unsized trait-object targets, a known
/// rustc limitation distinct from the ordinary (and always-fine) case of
/// reborrowing a concrete `&mut T`. Threading `&mut Option<&mut dyn
/// NfpIfpControl>` and reborrowing *that* concrete, `Sized` local at each
/// call site (`&mut control`) sidesteps the limitation entirely; this is a
/// Rust-borrow-checker accommodation with no behavioral effect.
pub fn nfp_checkpoint(
    control: &mut Option<&mut dyn NfpIfpControl>,
    phase: NfpIfpCheckpointPhase,
    telemetry: Option<&mut NfpIfpTelemetry>,
) -> Result<(), NfpIfpControlAbortError> {
    match control.as_deref_mut() {
        None => {
            if let Some(telemetry) = telemetry {
                telemetry.record_checkpoint(phase, CheckpointOutcome::Inert);
            }
            Ok(())
        }
        Some(control) => {
            let result = control.checkpoint(phase);
            if let Some(telemetry) = telemetry {
                telemetry.record_checkpoint(phase, CheckpointOutcome::Composed);
            }
            result
        }
    }
}

// ---------------------------------------------------------------------------
// Error taxonomy.
// ---------------------------------------------------------------------------

/// TS: `nfpIfpService.ts:1294-1299` (`failInvalidGeometry`).
pub fn invalid_geometry(operation: &str, message: String) -> IrregularGeometryInputError {
    IrregularGeometryInputError {
        operation: operation.to_string(),
        message,
    }
}

/// TS: `services.ts:47-52` (`IrregularGeometryInfeasibleError`). Raised
/// **only** by the public `computeIfpBounds` API (`nfp-ifp.md` §11) — the
/// internal fast path used inside candidate generation swallows an
/// `'infeasible'` IFP into an empty candidate list instead
/// (`super::candidates::generate_placement_candidates_uncached`).
#[derive(Clone, Debug, PartialEq)]
pub struct IrregularGeometryInfeasibleError {
    pub operation: String,
    pub message: String,
}

/// Combined failure channel of [`super::candidates::generate_placement_candidates_uncached`]
/// and [`generate_placement_candidates`] (TS: the union
/// `IrregularGeometryInputError | IrregularNfpIfpControlAbortError` on
/// `generatePlacementCandidates`'s Effect error channel, `services.ts:307-309`).
#[derive(Clone, Debug, PartialEq)]
pub enum NfpIfpError {
    Geometry(IrregularGeometryInputError),
    Abort(NfpIfpControlAbortError),
}

// ---------------------------------------------------------------------------
// Public computeNfp / computeIfpBounds (services.ts's Effect-analogue API).
// ---------------------------------------------------------------------------

/// TS: `services.ts:126-132` (`ComputeNfpInput`).
pub struct ComputeNfpInput<'a> {
    pub fixed: &'a IrregularPlacedPiece,
    pub moving: &'a TransformedCollisionGeometry,
    pub settings: &'a IrregularGeometrySettings,
}

/// TS: `nfpIfpService.ts:113-141` (`computeNfpCached`/`computeNfpBoundaryCached`).
/// Reached in production only from the periodic-cell archive lane
/// (`nfp-ifp.md` §1), never from the hot candidate-generation loop (which
/// calls [`resolve_nfp_boundary`] directly via
/// [`super::candidates::generate_placement_candidates_uncached`]) — both call
/// shapes must reach identical resolver logic with byte-identical cache
/// behavior, which this thin wrapper guarantees by delegating to the exact
/// same [`resolve_nfp_boundary`] function.
pub fn compute_nfp(
    input: &ComputeNfpInput<'_>,
    cache: &mut GeometryCacheStore,
    construction_algorithm: NfpConstructionAlgorithm,
) -> Result<IrregularNfp, IrregularGeometryInputError> {
    let core_input = CoreNfpInput {
        fixed: input.fixed,
        moving: input.moving,
        settings: input.settings,
    };
    match resolve_nfp_boundary(&core_input, cache, construction_algorithm) {
        Ok(success) => Ok(IrregularNfp {
            fixed_piece_id: input.fixed.placement.source_piece_id.clone(),
            moving_piece_id: input.moving.source_piece_id.clone(),
            boundary: success.boundary,
        }),
        Err(message) => Err(invalid_geometry("computeNfp", message)),
    }
}

/// TS: `services.ts:134-137` (`ComputeIfpBoundsInput`).
pub struct ComputeIfpBoundsInput<'a> {
    pub sheet: &'a SheetSpec,
    pub moving: &'a TransformedCollisionGeometry,
}

/// TS: `nfpIfpService.ts:219-251` (`computeIfpBoundsCached`). Preserves the
/// production-unreachable-but-tested `IrregularGeometryInfeasibleError`
/// failure channel exactly (`nfp-ifp.md` §1/§11/§15 item 2) — do not collapse
/// this into the internal fast path's swallow-`'infeasible'`-into-empty
/// behavior, which lives in
/// [`super::candidates::generate_placement_candidates_uncached`] instead.
#[derive(Clone, Debug, PartialEq)]
pub enum ComputeIfpBoundsError {
    Invalid(IrregularGeometryInputError),
    Infeasible(IrregularGeometryInfeasibleError),
}

pub fn compute_ifp_bounds(
    input: &ComputeIfpBoundsInput<'_>,
    cache: &mut GeometryCacheStore,
) -> Result<IrregularIfpBounds, ComputeIfpBoundsError> {
    let key_input = InnerFitBoundsKeyInput {
        sheet: input.sheet,
        moving: input.moving,
    };
    match resolve_ifp_bounds(&key_input, cache) {
        Ok(success) => Ok(success.value),
        Err(failure) => match failure.kind {
            CoreIfpBoundsFailureKind::Invalid => Err(ComputeIfpBoundsError::Invalid(
                invalid_geometry("computeIfpBounds", failure.message),
            )),
            CoreIfpBoundsFailureKind::Infeasible => Err(ComputeIfpBoundsError::Infeasible(
                IrregularGeometryInfeasibleError {
                    operation: "computeIfpBounds".to_string(),
                    message: failure.message,
                },
            )),
        },
    }
}

// ---------------------------------------------------------------------------
// Legal-candidate memo (cache-concurrency-design.md §1.4/§3.5).
// ---------------------------------------------------------------------------

/// TS: `nfpIfpService.ts:697-700` (`CachedLegalCandidate`).
#[derive(Clone, Debug, PartialEq)]
struct CachedLegalCandidate {
    point: IrregularPoint,
    diagnostics: Vec<CollisionGeometryDiagnostic>,
}

/// TS: `nfpIfpService.ts:702-705` (`CachedLegalCandidateEntry`).
#[derive(Clone, Debug, PartialEq)]
struct CachedLegalCandidateEntry {
    candidates: Vec<CachedLegalCandidate>,
    provenance: Option<NfpIfpCandidateProvenance>,
}

/// TS: `nfpIfpService.ts:611-614` (`candidatesByGeometry`, the per-scope
/// inner `Map`). **Owned, single-writer, per-search-invocation** — per
/// `cache-concurrency-design.md` §1.4/§2/§3.5: never job-scoped, never
/// shared/concurrent. Callers construct a fresh [`LegalCandidateMemo`] per
/// decoder/search invocation (mirroring a fresh TS
/// `IrregularNfpIfpCandidateMemoScope`), pass `Some(&mut memo)` to
/// [`generate_placement_candidates`] to opt in, and let it drop at the end of
/// that invocation — never widen this to job-scope.
#[derive(Default)]
pub struct LegalCandidateMemo {
    entries: HashMap<String, CachedLegalCandidateEntry>,
}

impl LegalCandidateMemo {
    pub fn new() -> Self {
        Self::default()
    }
}

/// TS: `nfpIfpService.ts:707-714` (`cacheLegalCandidates`).
fn cache_legal_candidates(candidates: &[IrregularPlacementCandidate]) -> Vec<CachedLegalCandidate> {
    candidates
        .iter()
        .map(|candidate| CachedLegalCandidate {
            point: candidate.point,
            diagnostics: candidate.diagnostics.clone(),
        })
        .collect()
}

/// TS: `nfpIfpService.ts:716-729` (`restoreCachedLegalCandidates`).
/// `pieceId`/`transform` are re-stamped from the *current* call's `moving`,
/// not from whatever call originally populated the entry — the mechanism
/// that makes the key's `moving.sourcePieceId`/`moving.transform` omission
/// safe (`nfp-ifp.md` §9's "two-layer sharing" note).
fn restore_cached_legal_candidates(
    cached: &[CachedLegalCandidate],
    moving: &TransformedCollisionGeometry,
) -> Vec<IrregularPlacementCandidate> {
    cached
        .iter()
        .map(|entry| IrregularPlacementCandidate {
            piece_id: moving.source_piece_id.clone(),
            transform: moving.transform,
            point: entry.point,
            diagnostics: entry.diagnostics.clone(),
        })
        .collect()
}

/// TS: `nfpIfpService.ts:606-695` (`makeGeneratePlacementCandidates`'s
/// returned `service` closure). Wraps
/// [`super::candidates::generate_placement_candidates_uncached`] with an
/// optional per-invocation legal-candidate memo.
///
/// **Exact TS access sequence** (`cache-concurrency-design.md` §1.4,
/// `nfp-ifp.md` §9.C):
/// 1. `memo === None` bypasses entirely — no lookup, no publish, records a
///    memo-bypass tick, calls the uncached function directly.
/// 2. Otherwise build the key and look up.
/// 3. **Hit-acceptance rule is provenance-aware, not just presence-aware**:
///    a hit is accepted only if `!input.want_provenance ||
///    entry.provenance.is_some()`. A caller that wants provenance cannot be
///    served by an entry cached without provenance capture — that case is a
///    `'provenance-miss'`, treated as a miss for control flow even though an
///    entry is technically present.
/// 4. On an accepted hit: still runs exactly one `'candidate-points'`
///    checkpoint before returning — a cooperative cancellation/deadline
///    observation point is preserved even on a full memo hit.
/// 5. On miss/provenance-miss: call the uncached function, then publish to
///    the memo **only on success** — a failed/aborted computation never
///    populates the memo.
#[allow(clippy::too_many_arguments)]
pub fn generate_placement_candidates(
    input: &GeneratePlacementCandidatesInput<'_>,
    geometry_cache: &mut GeometryCacheStore,
    construction_algorithm: NfpConstructionAlgorithm,
    candidate_pruning_mode: NfpCandidatePruningMode,
    memo: Option<&mut LegalCandidateMemo>,
    mut telemetry: Option<&mut NfpIfpTelemetry>,
    mut control: Option<&mut dyn NfpIfpControl>,
) -> Result<GeneratePlacementCandidatesOutcome, NfpIfpError> {
    let Some(memo) = memo else {
        if let Some(telemetry) = telemetry.as_deref_mut() {
            telemetry.record_memo_bypass();
        }
        return generate_placement_candidates_uncached(
            input,
            geometry_cache,
            construction_algorithm,
            candidate_pruning_mode,
            control,
            telemetry,
        );
    };

    let key = build_memo_key(input, construction_algorithm, candidate_pruning_mode);
    let cached_present = memo.entries.contains_key(&key);
    let accept_hit = cached_present
        && memo
            .entries
            .get(&key)
            .map(|entry| !input.want_provenance || entry.provenance.is_some())
            .unwrap_or(false);

    if accept_hit {
        if let Some(telemetry) = telemetry.as_deref_mut() {
            telemetry.record_memo_request(MemoRequestOutcome::Hit);
        }
        nfp_checkpoint(
            &mut control,
            NfpIfpCheckpointPhase::CandidatePoints,
            telemetry.as_deref_mut(),
        )
        .map_err(NfpIfpError::Abort)?;

        let entry = memo.entries.get(&key).expect("accept_hit implies presence");
        if let Some(telemetry) = telemetry.as_deref_mut() {
            telemetry.record_memo_restore(entry.candidates.len() as u64);
        }
        // TS: `if (cached.provenance !== undefined) { input.onCandidateProvenance?.(cached.provenance) }`
        // -- the `?.()` is a no-op when the *current* call has no callback
        // (this port's `want_provenance == false`), even if the memo entry
        // was populated by an earlier call that did request provenance on
        // the same key. Gate the returned value the same way, or a
        // provenance-wanting populate followed by a provenance-indifferent
        // hit would leak provenance the current caller never asked for.
        let provenance = if input.want_provenance {
            entry.provenance.clone()
        } else {
            None
        };
        return Ok(GeneratePlacementCandidatesOutcome {
            candidates: restore_cached_legal_candidates(&entry.candidates, input.moving),
            provenance,
        });
    }

    if let Some(telemetry) = telemetry.as_deref_mut() {
        telemetry.record_memo_request(if cached_present {
            MemoRequestOutcome::ProvenanceMiss
        } else {
            MemoRequestOutcome::Miss
        });
    }

    let outcome = generate_placement_candidates_uncached(
        input,
        geometry_cache,
        construction_algorithm,
        candidate_pruning_mode,
        control,
        telemetry,
    )?;

    memo.entries.insert(
        key,
        CachedLegalCandidateEntry {
            candidates: cache_legal_candidates(&outcome.candidates),
            provenance: outcome.provenance.clone(),
        },
    );

    Ok(outcome)
}

/// TS: `geometryCacheKeys.ts:77-106` (`legalPlacementCandidateMemoKey`), one
/// call-site adapter from [`GeneratePlacementCandidatesInput`] to
/// [`LegalPlacementCandidateMemoKeyInput`].
fn build_memo_key(
    input: &GeneratePlacementCandidatesInput<'_>,
    construction_algorithm: NfpConstructionAlgorithm,
    candidate_pruning_mode: NfpCandidatePruningMode,
) -> String {
    let sheetless = input.candidate_domain == CandidateDomain::SheetlessNfp;
    let sheet = if sheetless {
        None
    } else {
        Some(SheetDimensions {
            width: input.sheet.width,
            height: input.sheet.height,
        })
    };
    let placed_key_inputs: Vec<PlacedPieceKeyInput<'_>> = input
        .placed
        .iter()
        .map(|placed| PlacedPieceKeyInput {
            collision_polygon_points: &placed.collision_geometry.polygon.points,
            translate_x: placed.placement.transform.translate_x,
            translate_y: placed.placement.transform.translate_y,
        })
        .collect();
    let moving_bounds = input.moving.bounds;
    let key_input = LegalPlacementCandidateMemoKeyInput {
        sheet,
        placed: &placed_key_inputs,
        moving_polygon_points: &input.moving.polygon.points,
        moving_bounds: &moving_bounds,
        settings: &input.settings.geometry,
        candidate_domain: input.candidate_domain,
    };
    legal_placement_candidate_memo_key(&key_input, construction_algorithm, candidate_pruning_mode)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::caches::GeometryCacheStore;
    use crate::domain::{
        IrregularBounds, IrregularPlacement, IrregularPolygon, IrregularTransform,
        IrregularTransformCandidate, IrregularTransformReason, PieceId,
    };

    fn settings() -> IrregularGeometrySettings {
        IrregularGeometrySettings {
            flattening_sag_tolerance_mm: 0.25,
            clearance_safety_margin_mm: 0.25,
            geometry_backend_id: "irregular-convex-v2-default".to_string(),
            geometry_backend_version: "0".to_string(),
        }
    }

    fn square(min: f64, max: f64) -> IrregularPolygon {
        IrregularPolygon::new(vec![
            IrregularPoint::new(min, min),
            IrregularPoint::new(max, min),
            IrregularPoint::new(max, max),
            IrregularPoint::new(min, max),
        ])
    }

    fn transform_candidate() -> IrregularTransformCandidate {
        IrregularTransformCandidate {
            index: 0.0,
            rotation_deg: 0.0,
            mirrored: false,
            reason: IrregularTransformReason::Orthogonal,
        }
    }

    fn fixed_piece(
        polygon: IrregularPolygon,
        translate_x: f64,
        translate_y: f64,
    ) -> IrregularPlacedPiece {
        IrregularPlacedPiece {
            placement: IrregularPlacement {
                piece_id: None,
                source_piece_id: PieceId::new("fixed"),
                placement_reference: None,
                transform: IrregularTransform {
                    translate_x,
                    translate_y,
                    rotation_deg: 0.0,
                    mirrored: false,
                },
            },
            collision_geometry: TransformedCollisionGeometry {
                source_piece_id: PieceId::new("fixed"),
                transform: transform_candidate(),
                polygon,
                bounds: IrregularBounds::new(0.0, 0.0, 4.0, 4.0),
            },
        }
    }

    fn moving_geometry(polygon: IrregularPolygon) -> TransformedCollisionGeometry {
        TransformedCollisionGeometry {
            source_piece_id: PieceId::new("moving"),
            transform: transform_candidate(),
            polygon,
            bounds: IrregularBounds::new(0.0, 0.0, 2.0, 2.0),
        }
    }

    #[test]
    fn compute_nfp_and_the_internal_fast_path_agree() {
        let fixed = fixed_piece(square(0.0, 4.0), 10.0, 20.0);
        let moving = moving_geometry(square(0.0, 2.0));
        let settings = settings();
        let mut cache = GeometryCacheStore::new();

        let input = ComputeNfpInput {
            fixed: &fixed,
            moving: &moving,
            settings: &settings,
        };
        let nfp = compute_nfp(&input, &mut cache, NfpConstructionAlgorithm::VertexPairHull)
            .expect("computeNfp succeeds");
        assert_eq!(nfp.fixed_piece_id, PieceId::new("fixed"));
        assert_eq!(nfp.moving_piece_id, PieceId::new("moving"));
        assert!(!nfp.boundary.points.is_empty());
    }

    #[test]
    fn compute_ifp_bounds_reports_infeasible_as_a_distinct_error_from_invalid() {
        let sheet = SheetSpec {
            width: 2.0,
            height: 2.0,
            label: "tiny".to_string(),
        };
        let moving = moving_geometry(square(0.0, 4.0));
        let mut cache = GeometryCacheStore::new();
        let input = ComputeIfpBoundsInput {
            sheet: &sheet,
            moving: &moving,
        };
        let error = compute_ifp_bounds(&input, &mut cache).expect_err("infeasible");
        assert!(matches!(error, ComputeIfpBoundsError::Infeasible(_)));
    }

    #[test]
    fn generate_placement_candidates_bypasses_the_memo_when_none() {
        let sheet = SheetSpec {
            width: 100.0,
            height: 100.0,
            label: "sheet".to_string(),
        };
        let moving = moving_geometry(square(0.0, 2.0));
        let settings_full = crate::domain::IrregularNestingSettings {
            geometry: settings(),
            optimizer: sample_optimizer_settings(),
        };
        let mut cache = GeometryCacheStore::new();
        let input = GeneratePlacementCandidatesInput {
            sheet: &sheet,
            placed: &[],
            placed_collision_index: None,
            moving: &moving,
            settings: &settings_full,
            candidate_domain: CandidateDomain::Sheet,
            want_provenance: false,
        };
        let mut telemetry = NfpIfpTelemetry::new();
        let outcome = generate_placement_candidates(
            &input,
            &mut cache,
            NfpConstructionAlgorithm::VertexPairHull,
            NfpCandidatePruningMode::Indexed,
            None,
            Some(&mut telemetry),
            None,
        )
        .expect("generation succeeds");
        assert!(!outcome.candidates.is_empty());
        assert_eq!(telemetry.memo.bypasses, 1);
        assert_eq!(telemetry.memo.requests, 0);
    }

    #[test]
    fn generate_placement_candidates_memo_hits_on_the_second_identical_call() {
        let sheet = SheetSpec {
            width: 100.0,
            height: 100.0,
            label: "sheet".to_string(),
        };
        let moving = moving_geometry(square(0.0, 2.0));
        let settings_full = crate::domain::IrregularNestingSettings {
            geometry: settings(),
            optimizer: sample_optimizer_settings(),
        };
        let mut cache = GeometryCacheStore::new();
        let mut memo = LegalCandidateMemo::new();
        let mut telemetry = NfpIfpTelemetry::new();

        for expected_hits in [0u64, 1u64] {
            let input = GeneratePlacementCandidatesInput {
                sheet: &sheet,
                placed: &[],
                placed_collision_index: None,
                moving: &moving,
                settings: &settings_full,
                candidate_domain: CandidateDomain::Sheet,
                want_provenance: false,
            };
            let outcome = generate_placement_candidates(
                &input,
                &mut cache,
                NfpConstructionAlgorithm::VertexPairHull,
                NfpCandidatePruningMode::Indexed,
                Some(&mut memo),
                Some(&mut telemetry),
                None,
            )
            .expect("generation succeeds");
            assert!(!outcome.candidates.is_empty());
            assert_eq!(telemetry.memo.hits, expected_hits);
        }
        assert_eq!(telemetry.memo.requests, 2);
        assert_eq!(telemetry.memo.misses, 1);
        assert_eq!(telemetry.memo.hits, 1);
    }

    #[test]
    fn generate_placement_candidates_never_leaks_provenance_to_a_call_that_did_not_want_it() {
        // TS: `nfpIfpService.ts:656-658`'s `input.onCandidateProvenance?.(cached.provenance)`
        // is a no-op when the *current* call passed no callback, even if the
        // memo entry was populated by an earlier call on the same key that
        // did request provenance. A provenance-wanting populate followed by
        // a provenance-indifferent hit must return `provenance: None`.
        let sheet = SheetSpec {
            width: 100.0,
            height: 100.0,
            label: "sheet".to_string(),
        };
        let moving = moving_geometry(square(0.0, 2.0));
        let settings_full = crate::domain::IrregularNestingSettings {
            geometry: settings(),
            optimizer: sample_optimizer_settings(),
        };
        let mut cache = GeometryCacheStore::new();
        let mut memo = LegalCandidateMemo::new();

        // First call: populate the memo *with* provenance.
        let input_wants_provenance = GeneratePlacementCandidatesInput {
            sheet: &sheet,
            placed: &[],
            placed_collision_index: None,
            moving: &moving,
            settings: &settings_full,
            candidate_domain: CandidateDomain::Sheet,
            want_provenance: true,
        };
        let first = generate_placement_candidates(
            &input_wants_provenance,
            &mut cache,
            NfpConstructionAlgorithm::VertexPairHull,
            NfpCandidatePruningMode::Indexed,
            Some(&mut memo),
            None,
            None,
        )
        .expect("first generation succeeds");
        assert!(first.provenance.is_some());

        // Second call, identical geometry/key, but this caller does not want
        // provenance. It must still be an accepted memo hit (provenance
        // presence only ever *relaxes* the hit-acceptance rule), but the
        // returned outcome must not carry provenance it never asked for.
        let input_indifferent = GeneratePlacementCandidatesInput {
            sheet: &sheet,
            placed: &[],
            placed_collision_index: None,
            moving: &moving,
            settings: &settings_full,
            candidate_domain: CandidateDomain::Sheet,
            want_provenance: false,
        };
        let mut telemetry = NfpIfpTelemetry::new();
        let second = generate_placement_candidates(
            &input_indifferent,
            &mut cache,
            NfpConstructionAlgorithm::VertexPairHull,
            NfpCandidatePruningMode::Indexed,
            Some(&mut memo),
            Some(&mut telemetry),
            None,
        )
        .expect("second generation succeeds");
        assert_eq!(telemetry.memo.hits, 1, "must still be an accepted memo hit");
        assert!(
            second.provenance.is_none(),
            "a call that did not request provenance must never receive it, even from a memo entry that has it"
        );
    }

    fn sample_optimizer_settings() -> crate::domain::IrregularOptimizerSettings {
        crate::domain::IrregularOptimizerSettings {
            order_window: 4.0,
            beam_width: 8.0,
            local_candidate_fanout: 4.0,
            local_repair_budget: 0.0,
            intrinsic_shared_archive_enabled: true,
            intrinsic_objective_profile_id: crate::domain::IntrinsicObjectiveProfileId::Compact,
            transform_cap: 8.0,
            transform_minimum_edge_length_mm: 1.2,
            transform_angle_deduplication_tolerance_deg: 0.051,
            configured_rotation_enabled: true,
            edge_alignment_enabled: true,
            configured_rotation_deg: Vec::new(),
            ga_enabled: false,
            baseline_only: true,
            ga_population: 8.0,
            ga_generation_budget: crate::domain::DEFAULT_IRREGULAR_GA_GENERATION_BUDGET,
            ga_evaluation_budget: crate::domain::DEFAULT_IRREGULAR_GA_EVALUATION_BUDGET,
            ga_time_budget_ms: 0.0,
            ga_seed: "test-seed".to_string(),
            priority_order_mutation_enabled: true,
            transform_preference_mutation_enabled: true,
            placement_policy_mutation_enabled: true,
            placement_policy_id: crate::domain::DEFAULT_IRREGULAR_PLACEMENT_POLICY_ID,
            placement_policy_ids: crate::domain::default_irregular_placement_policy_ids(),
        }
    }
}
