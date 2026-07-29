//! Imported-piece source geometry: DXF line/arc segments, the preserved
//! ellipse curve parameters flattening needs, and the `ImportedPiece`
//! carrier itself.
//!
//! TS source: `src/shared/domain/dxf.ts` (segment/curve/piece shapes) and
//! `src/shared/domain/geometry.ts:29-34` (`Rect`, needed by
//! `ImportedPiece.realBounds`). Every class here is a real, validating
//! `Schema.Class`/`Schema.Struct` in TS; per this module's governing rule
//! (validation stays TS-side, migration prompt §4.1), the Rust port carries
//! only the trusted, already-decoded shape and re-checks none of the TS
//! schema's refinements (finiteness, non-emptiness, the ellipse
//! non-zero-major-axis cross-field check at `dxf.ts:42-50`, etc).

use serde::{Deserialize, Serialize};

use super::ids::{PieceId, SourceFileId};

/// TS: `dxf.ts:22` `entityHandle: Schema.optional(Schema.Union([Schema.String, Schema.Number]))`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum DxfEntityHandle {
    Text(String),
    Number(f64),
}

/// TS: `dxf.ts:14-23` `class ImportWarning`. Generic warning produced during
/// import.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportWarning {
    /// TS: `dxf.ts:16` — stable warning category used by UI and tests.
    pub code: String,
    /// TS: `dxf.ts:18` — human-readable warning text safe to show in the UI.
    pub message: String,
    /// TS: `dxf.ts:20` `Schema.optional(Schema.String)` — original DXF entity
    /// type that produced the warning, when known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entity_type: Option<String>,
    /// TS: `dxf.ts:22` — original DXF entity handle, when the parser
    /// provided one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entity_handle: Option<DxfEntityHandle>,
}

/// TS: `dxf.ts:33` `kind: Schema.Literal('ellipse')` — a single-valued
/// discriminant literal, not a union tag (unlike [`DxfGeometrySegment`]'s
/// `kind`, `DxfEllipseSource` is never one member of a larger tagged union
/// in the ported subset — it is only ever embedded via
/// `DxfLineSegment.sourceCurve`). Modeled as a one-variant enum rather than a
/// bare `String` field so the type system, not just convention, guarantees
/// the only value ever round-tripped through this field is `"ellipse"`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum DxfEllipseSourceKind {
    #[serde(rename = "ellipse")]
    Ellipse,
}

/// TS: `dxf.ts:32-51` `DxfEllipseSourceFields`/`DxfEllipseSource`. Preserved
/// DXF ellipse parameters attached to preview segments. The major-axis
/// values are a vector from the ellipse center (`dxf.ts:27-28`), while
/// `startAngle`/`endAngle` are DXF parameters in radians (`dxf.ts:28-29`).
/// `sourceId` identifies one original entity so the collision flattener can
/// sample a repeated preview approximation once (`dxf.ts:29-30`). The TS
/// schema's cross-field check (`majorAxisX !== 0 || majorAxisY !== 0`,
/// `dxf.ts:42-50`) is enforced only at the TS decode boundary; this trusted
/// carrier does not re-check it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DxfEllipseSource {
    pub kind: DxfEllipseSourceKind,
    pub source_id: String,
    pub cx: f64,
    pub cy: f64,
    pub major_axis_x: f64,
    pub major_axis_y: f64,
    pub axis_ratio: f64,
    pub start_angle: f64,
    pub end_angle: f64,
}

/// TS: `dxf.ts:58-73` `DxfLineSegment`. Preview line or chord carrying
/// optional source-level curve parameters. The `kind: 'line'` literal tag is
/// not a field here — it is reconstructed by [`DxfGeometrySegment`]'s
/// internally-tagged union representation.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DxfLineSegment {
    /// TS: `dxf.ts:62` — segment start X in piece-local millimeters.
    pub x1: f64,
    /// TS: `dxf.ts:64` — segment start Y in piece-local millimeters.
    pub y1: f64,
    /// TS: `dxf.ts:66` — segment end X in piece-local millimeters.
    pub x2: f64,
    /// TS: `dxf.ts:68` — segment end Y in piece-local millimeters.
    pub y2: f64,
    /// TS: `dxf.ts:69` `Schema.optional(FiniteDxfNumber)` — original
    /// LWPOLYLINE/POLYLINE bulge for the segment, when non-zero.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bulge: Option<f64>,
    /// TS: `dxf.ts:71` `Schema.optional(DxfEllipseSource)` — original
    /// ellipse parameters when this line is only a preview approximation.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_curve: Option<DxfEllipseSource>,
}

/// TS: `dxf.ts:76-97` `DxfArcSegment`. Preview circular arc with source
/// angles retained in degrees. The `kind: 'arc'` literal tag is not a field
/// here for the same reason as [`DxfLineSegment`].
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DxfArcSegment {
    /// TS: `dxf.ts:79` — arc start X in piece-local millimeters.
    pub x1: f64,
    /// TS: `dxf.ts:81` — arc start Y in piece-local millimeters.
    pub y1: f64,
    /// TS: `dxf.ts:83` — arc end X in piece-local millimeters.
    pub x2: f64,
    /// TS: `dxf.ts:85` — arc end Y in piece-local millimeters.
    pub y2: f64,
    /// TS: `dxf.ts:87` — arc center X in piece-local millimeters.
    pub cx: f64,
    /// TS: `dxf.ts:89` — arc center Y in piece-local millimeters.
    pub cy: f64,
    /// TS: `dxf.ts:91` `PositiveFiniteDxfNumber` — arc radius in
    /// millimeters.
    pub radius: f64,
    /// TS: `dxf.ts:93` — arc start angle in degrees.
    pub start_angle: f64,
    /// TS: `dxf.ts:95` — arc end angle in degrees.
    pub end_angle: f64,
}

/// TS: `dxf.ts:100-101` `DxfGeometrySegment = Schema.Union([DxfLineSegment, DxfArcSegment])`,
/// discriminated by each member's own `kind` literal (`'line'`/`'arc'`,
/// `dxf.ts:59,77`). Preview segment union consumed by the renderer and
/// source-fidelity collision code.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum DxfGeometrySegment {
    Line(DxfLineSegment),
    Arc(DxfArcSegment),
}

/// TS: `dxf.ts:103-113` `DxfGeometryEntityType`. Supported source geometry
/// type, or grouped/preset shape marker.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum DxfGeometryEntityType {
    #[serde(rename = "LINE")]
    Line,
    #[serde(rename = "LWPOLYLINE")]
    Lwpolyline,
    #[serde(rename = "POLYLINE")]
    Polyline,
    #[serde(rename = "CIRCLE")]
    Circle,
    #[serde(rename = "ARC")]
    Arc,
    #[serde(rename = "ELLIPSE")]
    Ellipse,
    #[serde(rename = "DXF_SHAPE")]
    DxfShape,
    #[serde(rename = "PRESET_SHAPE")]
    PresetShape,
}

/// TS: `dxf.ts:115-130` `class DxfGeometrySummary`. Compact, parser-agnostic
/// summary of imported DXF geometry. The renderer uses `segments` for a
/// deterministic preview approximation; the irregular worker also consumes
/// source parameters carried by those segments so collision sampling can use
/// its configured sag tolerance instead of the preview resolution
/// (`dxf.ts:118-121`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DxfGeometrySummary {
    pub entity_type: DxfGeometryEntityType,
    /// TS: `dxf.ts:127` — whether the imported summary should be treated as
    /// a closed outline.
    pub closed: bool,
    /// TS: `dxf.ts:129` — tagged line/arc segments in piece-local millimeter
    /// coordinates.
    pub segments: Vec<DxfGeometrySegment>,
}

/// TS: `src/shared/domain/geometry.ts:29-34` `class Rect`. Integer
/// millimeter bounds (`x`/`y`/`width`/`height` are each
/// `NonNegativeIntegerMillimeters`/`PositiveIntegerMillimeters` —
/// `Schema.Int`-constrained JS numbers, mirrored here as `f64` per this
/// module's number-fidelity convention, see `transform.rs`'s doc comment on
/// `IrregularTransformCandidate::index`).
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// TS: `dxf.ts:132-150` `class ImportedPiece`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedPiece {
    /// TS: `dxf.ts:134` `PieceId.withDefault` — stable app-owned piece id;
    /// generated when missing from loaded data (that generation happens
    /// TS-side, see `ids.rs`'s module doc; by the time a payload reaches this
    /// crate, `id` is always already concrete).
    pub id: PieceId,
    /// TS: `dxf.ts:136` — source document id this piece was imported from.
    pub source_file_id: SourceFileId,
    /// TS: `dxf.ts:141` `Schema.optional(Schema.String)` — CAD drawing layer
    /// name shared by the grouped DXF entities, when available. This is DXF
    /// metadata, not an Effect `Layer`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_layer: Option<String>,
    /// TS: `dxf.ts:143` — display label, usually derived from the source
    /// file name.
    pub label: String,
    /// TS: `dxf.ts:145` — integer millimeter bounds of the real imported
    /// geometry before padding.
    pub real_bounds: Rect,
    /// TS: `dxf.ts:147` — parser-agnostic source geometry used for preview
    /// and irregular nesting input.
    pub geometry: DxfGeometrySummary,
    /// TS: `dxf.ts:149` — piece-local import warnings that apply to this
    /// imported piece.
    pub warnings: Vec<ImportWarning>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dxf_geometry_segment_tags_by_kind() {
        let line = DxfGeometrySegment::Line(DxfLineSegment {
            x1: 0.0,
            y1: 0.0,
            x2: 10.0,
            y2: 0.0,
            bulge: None,
            source_curve: None,
        });
        let json = serde_json::to_string(&line).expect("line segment serializes");
        assert!(json.starts_with(r#"{"kind":"line","#), "got {json}");
        let decoded: DxfGeometrySegment = serde_json::from_str(&json).expect("line deserializes");
        assert_eq!(decoded, line);

        let arc = DxfGeometrySegment::Arc(DxfArcSegment {
            x1: 0.0,
            y1: 0.0,
            x2: 10.0,
            y2: 0.0,
            cx: 5.0,
            cy: 0.0,
            radius: 5.0,
            start_angle: 0.0,
            end_angle: 180.0,
        });
        let json = serde_json::to_string(&arc).expect("arc segment serializes");
        assert!(json.starts_with(r#"{"kind":"arc","#), "got {json}");
        let decoded: DxfGeometrySegment = serde_json::from_str(&json).expect("arc deserializes");
        assert_eq!(decoded, arc);
    }

    #[test]
    fn dxf_line_segment_carries_an_ellipse_source_curve() {
        let line = DxfLineSegment {
            x1: 0.0,
            y1: 0.0,
            x2: 1.0,
            y2: 1.0,
            bulge: Some(0.5),
            source_curve: Some(DxfEllipseSource {
                kind: DxfEllipseSourceKind::Ellipse,
                source_id: "ellipse-1".to_string(),
                cx: 0.0,
                cy: 0.0,
                major_axis_x: 10.0,
                major_axis_y: 0.0,
                axis_ratio: 0.5,
                start_angle: 0.0,
                end_angle: std::f64::consts::PI,
            }),
        };
        let json = serde_json::to_string(&line).expect("line segment serializes");
        let decoded: DxfLineSegment = serde_json::from_str(&json).expect("line deserializes");
        assert_eq!(decoded, line);
        assert!(json.contains(r#""kind":"ellipse""#));
    }

    #[test]
    fn import_warning_omits_absent_optional_fields_from_json() {
        let warning = ImportWarning {
            code: "unsupported-entity".to_string(),
            message: "skipped".to_string(),
            entity_type: None,
            entity_handle: None,
        };
        let json = serde_json::to_string(&warning).expect("warning serializes");
        assert_eq!(json, r#"{"code":"unsupported-entity","message":"skipped"}"#);
    }

    #[test]
    fn import_warning_entity_handle_accepts_string_or_number() {
        let text_handle = ImportWarning {
            code: "c".to_string(),
            message: "m".to_string(),
            entity_type: Some("LINE".to_string()),
            entity_handle: Some(DxfEntityHandle::Text("A1".to_string())),
        };
        let json = serde_json::to_string(&text_handle).unwrap();
        let decoded: ImportWarning = serde_json::from_str(&json).unwrap();
        assert_eq!(decoded, text_handle);

        let numeric_handle = ImportWarning {
            code: "c".to_string(),
            message: "m".to_string(),
            entity_type: None,
            entity_handle: Some(DxfEntityHandle::Number(42.0)),
        };
        let json = serde_json::to_string(&numeric_handle).unwrap();
        let decoded: ImportWarning = serde_json::from_str(&json).unwrap();
        assert_eq!(decoded, numeric_handle);
    }
}
