# Irregular Sheet-Invariance Fixtures

`mixed61-request.json` is the exact persisted 61-piece request from job
`780d4ec5-b64e-4f48-a8d8-0bfd30877549`. Its original sheet is `2000 x 2700 mm`,
with `10 mm` padding, reorder window `4`, beam width `8`, local fanout `4`,
repair disabled, transform cap `8`, edge-contact policy, and GA disabled.
The fixture explicitly enables the intrinsic shared archive used by the
compact-quality production profile. Its pieces, source geometry, sheet, padding,
and all pre-existing optimizer evidence remain unchanged.

The sheet-invariance corpus replays the same prepared pieces and optimizer
settings on `1000 x 1700 mm` and `2000 x 2700 mm` sheets. Both sheets admit the
approved compact collision envelope. Geometry comparison ignores copy order,
polygon winding, ring origin, bottom-left translation, and rigid quarter-turns.
It does not ignore reflection or relative placement changes.

Run the diagnostic corpus with:

```sh
pnpm corpus:sheet-invariance
```

Add `--strict` when sheet-invariant production ranking is expected and any
geometry mismatch should fail the command. SVG artifacts and `report.json` are
written to `/private/tmp/irregular-sheet-invariance` by default.

A one-sheet production gate must opt in explicitly with `--allow-single-sheet`
and pin hash, area, canonical-cavity, and runtime constraints. The CLI rejects a
strict one-sheet invocation when any of the four is missing.
`pnpm gate:mixed61-compact` pins
the accepted Mixed canonical hash, maximum envelope area, zero canonical cavities,
and a cold runtime ceiling. Its report uses `geometryEquivalent: null` instead of
mislabeling one run as evidence of invariance.
