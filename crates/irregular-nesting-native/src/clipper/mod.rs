//! TS counterpart: src/workers/irregular/clipper2OffsetAdapter.ts and src/workers/irregular/clipper2OffsetPolicy.ts (Clipper2 canonical integer Boolean geometry and offset behavior).
//!
//! This module vendors a mechanical Rust translation of the used subset of
//! `clipper2-ts@2.0.1-18` per ruling R10
//! (`docs/planning/rust-irregular-backend/stage0-rulings.md`): `core` ports
//! `node_modules/clipper2-ts/src/Core.ts`, `engine` ports the boolean-clip
//! subset of `node_modules/clipper2-ts/src/Engine.ts` (`Clipper64`/`PolyTree64`)
//! plus the small `Clipper.ts` wrapper surface used by this crate
//! (`booleanOp`/`booleanOpWithPolyTree`/`polyTreeToPaths64` — see `engine`'s
//! module doc for the exact scope), and `offset` ports
//! `node_modules/clipper2-ts/src/Offset.ts`, calling into `engine` for the
//! final self-intersection cleanup union (`Offset.ts:192-203`).

pub mod core;
pub mod engine;
pub mod offset;
