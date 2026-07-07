# Schema Models

Named domain and protocol models use `Schema.Class`.

Use classes for:

- exported domain models;
- protocol and RPC boundary payloads;
- persisted project models;
- worker result, history, warning, and trace models.

Small nested shapes that do not need a name may stay as inline `Schema.Struct` fields. Strict validation schemas under `src/shared/schemas/` may also use inline structs when they are only narrowing an already named domain model for file or IPC validation.

## Construction

Prefer constructors or semantic factories over large open object literals:

```ts
new PreparedPiece({ ... })
NestingStrategyResult.fromAlgorithm(...)
NestingResult.fromAlgorithm(...)
```

Factories should encode defaults and invariants such as status derivation, generated history frame shape, and response tags. Call sites should not repeatedly spell those defaults out by hand.

## Boundaries

Boundary schemas still decode untrusted data before use. Decoding may produce class instances, but renderer and persistence code must continue to treat data as immutable domain values and update state through composable actions.

## Internal DTOs

Plain interfaces are acceptable for internal algorithm or service DTOs that do
not cross IPC, worker RPC, or persisted project boundaries. Shared irregular v2
DTOs under `src/shared/irregular/` are schema-backed classes because they are
app-level payloads intended for worker diagnostics, request/debug surfaces, and
future history/progress envelopes. Worker service contracts may still use
interfaces for operation inputs and Effect service shapes.
