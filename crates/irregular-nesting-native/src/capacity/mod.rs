//! Capacity tower. TS counterparts: src/workers/algorithm/irregular/intrinsicCapacity*.ts

pub mod endpoint;
pub mod material;
pub mod mode;
pub mod prefixes;
pub mod preflight;
pub mod search;
pub mod telemetry;

/// Wire-boundary-only decimal-string encoding for the `BigInt`-valued trace
/// fields this tower's traces carry (`placedDoubledMaterialAreaGrid2` and
/// friends) -- JSON has no integer type wide enough to carry a `BigInt`
/// losslessly, so every such field crosses `boundary::result`'s wire as a
/// plain decimal-digit string; the TS-side adapter
/// (`nativeIrregularBackend.ts`) reconstructs it as `BigInt(<string>)`,
/// exactly reproducing the in-memory TS trace value. Shared by every
/// `#[derive(Serialize)]` struct across this tower (`preflight`/`endpoint`/
/// `search`/`mode`) that carries a real `num_bigint::BigInt` field, so the
/// encoding stays identical everywhere rather than being reinvented per
/// call site.
pub(crate) fn serialize_bigint_decimal_string<S>(
    value: &num_bigint::BigInt,
    serializer: S,
) -> Result<S::Ok, S::Error>
where
    S: serde::Serializer,
{
    serializer.serialize_str(&value.to_string())
}
