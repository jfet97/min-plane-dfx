//! TS counterpart: src/workers/irregular/clipper2OffsetAdapter.ts and src/workers/irregular/clipper2OffsetPolicy.ts (Clipper2 canonical integer Boolean geometry and offset behavior).
//!
//! This module vendors a mechanical Rust translation of the used subset of
//! `clipper2-ts@2.0.1-18` per ruling R10
//! (`docs/planning/rust-irregular-backend/stage0-rulings.md`): `core` ports
//! `node_modules/clipper2-ts/src/Core.ts`, `offset` ports
//! `node_modules/clipper2-ts/src/Offset.ts`. The boolean-clip engine
//! (`Engine.ts`, `Clipper64`/`PolyTree64`) is out of this scope; `offset`
//! leaves a clearly-marked `engine_union_stub` for the final self-intersection
//! cleanup step (see that function's doc comment).

pub mod core;
pub mod offset;
