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

## Trusted internal search artifacts

Some irregular v2 types are neither app-level payloads nor boundary models: the
search produces them from already-decoded input, consumes them itself, and
discards them. `TransformedCollisionGeometry`, `IrregularPlacedPiece`, and
`IrregularPlacementCandidate` are the current members, and they are plain
classes.

They must stay plain. `Schema.Class` construction revalidates the entire nested
value on every instantiation, including nested values that are already validated
instances passed by reference. Constructing one `IrregularPlacedPiece` around a
reused geometry cost `37-250 us` depending on ring size, growing linearly with
vertex count, against `5 ns` for the equivalent plain object. The search
instantiates these per placement and per quarter turn, so the whole nested ring
was being rewalked continuously. Converting these three types cut the Mixed-61
`2000 x 2700` production case from `94.4 s` to `61.4 s` with every canonical
hash, count, and work ledger unchanged.

A type belongs in this category only when its class is never used as an encoded
schema or trusted as boundary validation. Verify that before adding one. The
same structural shape may cross a boundary only through a separate schema that
owns decoding there.

When an untrusted boundary genuinely needs to carry such an artifact — replay
NDJSON and imported provenance envelopes do — declare a separate boundary
schema next to the class, such as `IrregularPlacedPieceSchema`. The class stays
plain for the search; the schema keeps validation where untrusted bytes arrive.
`tests/unit/irregularSchemaContracts.test.ts` asserts the two stay in step.
