# CFG-144 Feasibility Prototype Plan

Status: implemented feasibility prototype
Scope: add CSV import/export for ABAS/CAMQUIX interchange, temporary DB storage for CSVs, and a manual run/subrun model. One project can hold 0+ CSVs and 0+ shared source shapes; each CSV gets its own run/subrun configuration and dedicated UI section. Manual subruns are also available for ordinary non-CSV runs that finish with unplaced pieces. Zip archive support is explicitly deferred to a later iteration; this prototype handles single `.csv` import/export.

---

## 1. Goal

Make `min-plane-dfx` consume the same CSV-style text files ABAS currently sends to CAMQUIX, and emit the same CSV-style text files CAMQUIX currently sends back to ABAS. Keep the existing DXF-only import path working. Add a run/subrun concept so that when all pieces do not fit on one editable mother plate, the tool can prepare additional mother plates (subruns) for the leftovers; each subrun is configured and started manually by the user, one after another.

Default mother plate: 1500 mm x 1500 mm, editable before every subrun.
Optimization objective for the feasibility prototype: pack pieces onto the smallest possible number of mother plates of the configured fixed size, using a greedy sequential pass. This is a practical heuristic, not a global area-minimization guarantee, and the plate size is editable per subrun so the user can tune the trade-off between plate count and saw/laser constraints.

---

## 2. CSV file format

We adopt the exact ABAS/CAMQUIX format shown in CFG-144. For the feasibility prototype input and output are single `.csv` files. Zip archive support is deferred to a later iteration.

### Input (ABAS -> optimizer)

The user imports one CSV file at a time. For the feasibility prototype the file selector accepts a single `.csv` file; zip archive support is deferred. The main process parses that CSV independently and stores it as one `ProjectCsvImport`.

A project can contain multiple imported CSVs, but each is added individually. Every CSV in the project shares the same global pool of source shapes (imported DXF files and preset shapes).

Each imported CSV:

- Is encoded in **Windows-1252 / CP1252** (the encoding used by the production samples), not UTF-8.
- Uses **semicolon-separated** lines with Windows-style CRLF line endings.
- Has one `JOB` header line, one `BAR` material/thickness line, and one `CUT` line per required shape instance type.

Exact real sample parsed as semicolon-separated fields:

```text
JOB;20260630;;ACRYL 5MM GEGOSSEN SATIN;;;20260630
BAR;8669;;;5
CUT;1000;;;;;3282597_2;Customer A;;;3
```

Field mapping (1-indexed) derived from the samples:

`JOB` line:
- Field 1: type `JOB`.
- Field 2: job date, e.g. `20260630`.
- Field 3: empty.
- Field 4: material description, e.g. `ACRYL 5MM GEGOSSEN SATIN`.
- Field 5: empty.
- Field 6: empty.
- Field 7: job date repeated, e.g. `20260630`.

`BAR` line:
- Field 1: type `BAR`.
- Field 2: ABAS material code, e.g. `8669`.
- Fields 3-4: empty.
- Field 5: thickness in mm, e.g. `5`.

`CUT` line:
- Field 1: type `CUT`.
- Field 2: ignored placeholder (`1000` in the samples).
- Fields 3-6: ignored empty placeholders.
- Field 7: raw `reference` string (packslip no. & position), e.g. `3282597_2`.
- Field 8: `customerName`.
- Fields 9-10: ignored empty placeholders.
- Field 11 (last): `amount`, a positive integer quantity for this reference.

The parser keeps the raw `reference` as a single string, trims whitespace, rejects any field that contains a literal semicolon or line break, and limits customer name/reference lengths to a reasonable maximum. Because files are read as Windows-1252, umlauts and other Western European characters survive unchanged into the internal UTF-8 representation.

### Output (optimizer -> ABAS/LASER)

The export produces a single `.csv` file for the currently selected CSV import. The file name is derived from the input `JOB` date and material description:

```
<YYYYMMDD>_<material description sanitized>.csv
```

Spaces in the material description become underscores, and characters that are illegal in file names are removed. Examples from the real samples: `20260630_ACRYL_5MM_GEGOSSEN_SATIN.csv`, `20260623_ACRYL_5MM_GEGOSSEN_WEISS.csv`.

Each output CSV has exactly these line types in this order:

```text
MATERIAL;<material code>;
PLATTENMASS;<length>;<width>
AUFTRAG;<packslip no.>;<packslip position>;<customer name>;<amount>
```

- `MATERIAL`: exactly one line per output file. The first field is the type, the second is the ABAS material code, the third is currently empty to match the real CAMQUIX samples.
- `PLATTENMASS`: one line per subrun (mother plate), using the configured dimensions for that subrun. Subruns are emitted in index order.
- `AUFTRAG`: after each `PLATTENMASS` line, emit one line per distinct `(reference, customerName)` placed on that subrun. The quantity is the number of piece instances of that reference placed on that subrun, aggregated into a single row. This matches the real output, where an input row with `amount = 3` results in one `AUFTRAG` line with amount `3`, not three separate lines.

The export step splits the raw `reference` string into `<packslip no.>` and `<packslip position>` using the **last underscore (`_`)** as the delimiter. If no underscore is present, the whole reference becomes `<packslip no.>` and `<packslip position>` is empty. The emitted line has exactly five semicolon-separated fields.

Customer names and references are sanitized on export: semicolons and line breaks are stripped, and values are trimmed. The output file is written with Windows-1252 / CP1252 encoding and CRLF line endings.

---

## 3. Mapping CSV rows to DXF shapes

A CSV run references external DXF files by the raw reference string in field 7 of each `CUT` row. The user will import:

1. One CSV file at a time (single `.csv` import for the first prototype).
2. The DXF files for the distinct shapes needed by the project, either by importing them separately or by selecting from preset source shapes. Shapes live in a shared project library and can be linked to rows of any imported CSV.

The raw `reference` string is kept for display and for export back to ABAS. Matching a CSV row to an actual source shape is manual in the UI: each `CsvCutRow` has a `linkedPieceId` that points to a shared `ImportedPiece`. The `CsvImportPanel.vue` provides a dropdown per row that lets the user pick the matching DXF or preset source shape. The raw reference itself is not matched automatically against file names in this prototype.

---

## 4. Domain model additions

### `src/shared/domain/project.ts`

Add a `ProjectCsvImport` class to represent an imported CSV parsed into a schema-decoded record:

- `id`: generated UUID.
- `sourcePath`: original file path of the imported CSV.
- `fileName`: base name of the CSV file.
- `materialCode`: string.
- `materialDescription`: string.
- `thicknessMm`: integer millimeters.
- `jobDate`: optional string (`YYYYMMDD`).
- `rows`: array of `CsvCutRow`.
- `runConfiguration`: `ProjectRunConfiguration` embedded directly in this CSV import.

Add `CsvCutRow`:

- `id`: generated UUID.
- `reference`: raw string from field 7 of the `CUT` line.
- `customerName`: string.
- `amount`: positive integer.
- `linkedPieceId`: optional `PieceId`, filled when a matching source shape is available.

Add `ProjectRunConfiguration` to capture the default settings for a CSV run:

- `runId`: string (defaults to the parent CSV id).
- `label`: string.
- `defaultSheet`: `SheetSpec` (starting value for subrun 0 and the default for later subruns).
- `padding`: integer.
- `options`: `NestingOptions`.
- `materialFilter`: optional string (for grouping by material).

Each CSV owns exactly one `ProjectRunConfiguration`, stored inside `ProjectCsvImport`. The top-level `ProjectDocument` does not keep a separate `runConfigurations` array; this is the single source of truth for per-CSV defaults.

Add `CsvRunRecord` to capture a completed or in-progress run session for one CSV:

- `csvImportId`: string.
- `runId`: string.
- `label`: string.
- `subRuns`: `NestingSubRun[]`.
- `unplacedPieceIds`: `PieceId[]` (remaining after the last started subrun).
- `preparedPieces: PreparedPiece[]` (the full piece list used by the session, including `sourcePieceId` and `cutRowRef`).
- `createdAt`: string.
- `updatedAt`: string.

Update `ProjectDocument` to carry:

- `csvImports: ProjectCsvImport[]`.
- `csvRunRecords: CsvRunRecord[]` (per-CSV run sessions, including completed subruns).

`WorkspaceProjectSettings` does not duplicate `csvImports`; it carries only `selectedCsvId` and `csvRunRecords` (for temporary run state before a project is saved).

### `src/shared/domain/nesting.ts`

Add a `NestingSubRun` class:

- `subRunId`: string.
- `parentRunId`: string.
- `index`: number.
- `sheet`: `SheetSpec` (the actual plate used for this subrun, may differ from the run default).
- `padding`: integer (the padding used for this subrun).
- `options`: `NestingOptions` (snapshot of the options used for this subrun).
- `placements`: `Placement[]`.
- `unplacedPieceIds`: `PieceId[]`.
- `pieceIds`: `PieceId[]` (the pieces assigned to this subrun).
- `requestPieceIds`: `PieceId[]` (the piece ids passed into this subrun's worker request, used to identify leftovers for the next subrun).

Add `NestingRunSummary` to hold the result of a run with subruns:

- `runId`: string.
- `subRuns`: `NestingSubRun[]`.
- `totalPlaced`: number.
- `totalUnplaced`: number.
- `totalSheetAreaMm2`: number.
- `usedAreaMm2`: number.

Update `NestingRequest` to include one new optional field:

- `strategyRunId: string`: optional override for the strategy run identifier. When omitted, the worker falls back to the default `run-1-maxrects-beam-search`. For CSV subruns the renderer supplies a per-subrun id (`<csvRunId>-subrun-<index>`).

Update `NestingResult` to include three new optional fields:

- `runSummary: NestingRunSummary`: populated by the new subrun wrapper. When all pieces fit on one plate the summary still contains one subrun. Existing legacy results without the field decode normally.
- `preparedPieces: PreparedPiece[]`: the exact pieces sent to the worker, so the CSV export service can map each `Placement.pieceId` back to its CSV metadata. Optional for backward compatibility; absent on legacy results.
- `csvImportId: string`: optional, identifies which CSV import this result belongs to. Legacy results and non-CSV runs omit it.

Keep the existing `placements`/`unplacedPieceIds` fields for backward compatibility: when a run has subruns, `placements` becomes the union of all subrun placements and `unplacedPieceIds` becomes the union of all subrun unplaced pieces.

For a manual multi-subrun session, the renderer builds a separate worker request for each subrun. The worker returns one `NestingResult` per subrun containing a single-entry `runSummary`. The renderer accumulates these into the `CsvRunRecord` for the active CSV, producing a final aggregated `NestingResult` when the session ends or the user exports.

Because these fields are optional, version-1 project files with saved `lastResult` or `runRecords` continue to decode. The strict schemas must use `Schema.optional` for each new optional field.

### `src/shared/preparePieces.ts`

`PreparedPiece` already carries `sourcePieceId`. Extend it to also carry an optional `cutRowRef` field holding the CSV row metadata:

- `reference`: raw CSV reference string.
- `customerName`: string.
- `csvRowId`: string.

This is the only path that lets the CSV export reconstruct `AUFTRAG` rows from `Placement` objects.

Prepared piece ids for CSV rows use the canonical form `copy-<index>-of-<sourcePieceId>-for-<csvRowId>` (see section 5.3). Because `sourcePieceId` is already stored as a separate field, the canvas does not need to reverse-engineer it from the composite id; it reads `sourcePieceId` directly from the matching entry in `result.preparedPieces`.

To propagate `cutRowRef`, make these pipeline changes:

- Introduce `prepareCsvPieces(csvRows, sourcePiecesById, sheet, padding, jobId)` in a new `src/shared/prepareCsvPieces.ts`. It expands each `CsvCutRow` into `amount` copies with `sourcePieceId` set and `cutRowRef` populated, using the source piece's geometry and the CSV row metadata.
- Keep `preparePieces` for DXF/preset imports, but allow it to receive an optional `cutRowRef` override when a single source shape is prepared on behalf of a CSV row.
- Update `clonePreparedPieces` in `src/renderer/App.vue` to copy `cutRowRef` when present.
- Update `NestingRequestStrict` in `src/shared/schemas/nestingSchemas.ts` so the strict request schema tolerates the optional `cutRowRef` field on each piece.

---

## 5. Run / SubRun algorithm

### High-level flow

The renderer owns a `CsvRunSession` per active CSV. The worker remains stateless: each subrun is a separate `computeNesting` request.

1. User selects one imported CSV in the project. The CSV panel shows the rows and their linked source shapes.
2. The CSV panel displays the **main run configuration** for that CSV: default mother plate size (default 1500x1500), padding, and nesting options. The user can edit these before running.
3. User clicks **Run**. The renderer creates a fresh `CsvRunSession` for the selected CSV and builds subrun 0:
   - pieces = all copies derived from this CSV's rows;
   - sheet = CSV `runConfiguration.defaultSheet`;
   - padding = CSV `runConfiguration.padding`;
   - options = CSV `runConfiguration.options`;
   - `strategyRunId = <csvRunId>-subrun-0`.
4. The worker runs `computeNesting` once and returns a `NestingResult` with a single-entry `runSummary`.
5. The renderer appends the returned `NestingSubRun` to the session. If its `unplacedPieceIds` is empty, the session is complete.
6. If pieces remain unplaced, the UI shows the result and offers a **Next subrun** action in the CSV panel. Selecting it opens a **subrun configuration card** preloaded with the remaining pieces, the CSV's `defaultSheet`, and the CSV's default padding.
7. The user may edit the sheet size and padding for this specific subrun in the card.
8. The user clicks **Start subrun**. The renderer sends a new worker request for the leftover pieces with the subrun-specific sheet/padding/options and `strategyRunId = <csvRunId>-subrun-<index>`.
9. Steps 6-8 repeat until all pieces are placed, the user decides to stop, or a subrun returns zero placements (which indicates a piece that cannot fit on the configured sheet; surface as a warning).
10. Each successful pass becomes a `NestingSubRun` with its own sheet, padding, options snapshot, and placements. The renderer aggregates all started subruns into the `CsvRunRecord` for this CSV. When the session ends, the renderer builds a final `NestingResult` with `runSummary` listing every subrun, `placements`/`unplacedPieceIds` as unions, and `csvImportId` set.

Only one CSV's run is active in the main canvas at a time. Switching between imported CSVs in the CSV panel switches which run configuration, which `CsvRunSession`, and which result are displayed.

### Why this is acceptable for the feasibility study

Each subrun nests the remaining pieces onto a fixed mother plate chosen by the user. A greedy sequential pass is straightforward, deterministic, and good enough to validate whether the tool can replace CAMQUIX for the Hausfux workflow. It is not a globally optimal packer. The manual step gives the planner control over each plate size, which matches the real workflow where plate dimensions are tuned per job.

### Cut-list expansion

Before a run, the renderer expands each CSV `CUT` row with `amount > 0` into that many prepared pieces, each labeled with packslip/customer metadata. Copy ids use the canonical form defined in section 4.3. Each copy carries the `sourcePieceId` and `cutRowRef` metadata from its CSV row.

### Worker changes

The worker does not own the multi-subrun loop. The renderer does. Each subrun is a normal call to `computeNesting`.

To support this, `computeNesting` must accept an optional `strategyRunId` override instead of hardcoding `run-1-maxrects-beam-search`. Add an optional `strategyRunId` field to `NestingRequest` (and to `NestingRequestStrict`) so the renderer can pass it per subrun. This identifier is emitted on every `NestingHistoryFrame` and on the single `NestingStrategyResult` produced by the call. `framesByRun` in the renderer is keyed by `strategyRunId`, so distinct subrun IDs keep their histories separate.

For every subrun request the renderer sends:

- a distinct `strategyRunId` (`<csvRunId>-subrun-<index>`) inside `NestingRequest`;
- the subset of `preparedPieces` that still need placement;
- the sheet/padding/options chosen for that subrun.

The worker returns one `NestingResult` per subrun. The renderer keeps the returned `NestingStrategyResult`, `runSummary` (single subrun), `placements`, and `unplacedPieceIds`, then appends the subrun data to the `CsvRunSession`. At session end the renderer produces the aggregated `NestingResult` used by the canvas, runs panel, and export.

When the user runs without subruns (all pieces fit on the first plate), the aggregated result still contains `runSummary` with a single subrun and a single entry in `strategyResults`. The history shape is otherwise identical to today.

---

## 6. Workspace persistence for CSVs

### SQLite schema

Add a new table `imported_csv` in `WorkspaceProjectService`:

```sql
CREATE TABLE IF NOT EXISTS imported_csv (
  id TEXT PRIMARY KEY,
  source_path TEXT NOT NULL UNIQUE,
  file_name TEXT NOT NULL,
  document_json TEXT NOT NULL,
  imported_at TEXT NOT NULL
)
```

The JSON payload is a schema-encoded `ProjectCsvImport`.

Add methods to `WorkspaceProjectService`:

- `importCsvFiles(paths)`: copy CSVs into workspace sources, parse each with Windows-1252 encoding, store JSON, return decoded documents.
- `listImportedCsvs()`.
- `updateImportedCsv(document)`: replace the stored JSON for one CSV import so row-to-piece links and per-CSV run configuration can be persisted in the temporary workspace.
- `removeImportedCsv(id)`.
- `clearImportedCsvs()`.

Keep the same transaction and cleanup patterns used for DXF imports.

### Temporary vs saved project

- Before a project is saved, imported CSV documents live in the SQLite `imported_csv` table. For CSV-specific state, `WorkspaceProjectSettings` adds only `selectedCsvId` and `csvRunRecords`; it must not duplicate `csvImports`. It still carries the existing non-CSV workspace state (sheet, padding, options, selected pieces, etc.).
- After `project:save`, the JSON snapshot includes `csvImports` (with embedded `runConfiguration`) and `csvRunRecords` directly, same as `importedDocuments` today.
- On `project:open`, the workspace table is repopulated from the saved `csvImports` JSON, and `useCsvImportStore.hydrateFromProject` restores the CSV rows and links them to the rehydrated source shapes.
- Whenever `linkRowToPiece` or `updateRunConfiguration` changes a CSV, call `WorkspaceProjectService.updateImportedCsv` so the change is written to the SQLite table before reload.

---

## 7. IPC and protocol additions

### `src/shared/protocol/ipc.ts`

Add to `AppApi`:

- `selectCsvFiles(): Promise<string[]>`: returns the selected `.csv` file paths.
- `importCsvFiles(paths): Promise<ProjectCsvImport[]>`.
- `removeImportedCsv(id): Promise<void>`.
- `clearImportedCsvs(): Promise<void>`.
- `exportCsvResult(csvImport: ProjectCsvImport, csvRunRecord: CsvRunRecord, outPath: string): Promise<string>`: writes the output `.csv` for the given CSV import and its completed run record to `outPath` and returns the written path.

### `src/main/ipc/handlers.ts`

Add handlers for the new channels. Reuse the existing workspace service and error-translation helpers.

### `src/preload/index.ts`

Expose the new methods through the typed API, with the same envelope pattern.

---

## 8. Renderer stores and UI

### New composable: `useCsvImportStore.ts`

Owns:

- `csvImports: ProjectCsvImport[]` (loaded from the workspace `imported_csv` table; never duplicated inside workspace settings).
- `selectedCsvId: string | null` (the CSV currently shown in the main workspace; persisted via `WorkspaceProjectSettings`).
- `activeSessions: Map<csvImportId, CsvRunSession>` (in-progress or completed run sessions, keyed by CSV id; persisted via `csvRunRecords`).
- Methods: `appendCsvImports`, `replaceCsvImports`, `hydrateFromProject`, `linkRowToPiece`, `updateRunConfiguration`, `selectCsv`, `startSubrun`, `appendSubrunResult`, `finalizeSession`, `clear`.

`linkRowToPiece(csvImportId, rowId, pieceId)` mutates the matching `CsvCutRow.linkedPieceId` directly. The CSV row is part of `ProjectCsvImport`, so the link is persisted through `WorkspaceProjectService.updateImportedCsv`.

`updateRunConfiguration(csvImportId, partial)` updates the CSV's embedded `runConfiguration` and persists the CSV document.

`startSubrun(csvImportId, subrunIndex, pieces, sheet, padding, options)` builds a worker request for one subrun.

`appendSubrunResult(csvImportId, result)` adds a returned `NestingSubRun` to the active session.

`finalizeSession(csvImportId)` produces the aggregated `NestingResult` and `CsvRunRecord` for the CSV, then clears the transient session.

### `useAppStore.ts` changes

- `selectedPieces` continues to hold manually entered quantities and DXF/preset source pieces.
- CSV rows are not mixed into `selectedPieces`; they are expanded into prepared pieces by the CSV run session when a CSV is run.
- Add `csvLinkedPieceCount` computed that counts rows with a linked source shape across all CSVs.
- Add helpers to compute remaining pieces for a new subrun from the previous subrun's `unplacedPieceIds`.

### Shared source shape library

Source shapes (imported DXF files and preset shapes) are global to the project. A new or existing panel lists all available shapes so the user can see the shared pool. When a CSV row needs a shape, it picks from this shared pool via the row dropdown in the CSV panel.

### New component: `CsvImportPanel.vue`

- Lists imported CSV files as collapsible sections; only one CSV is "active" at a time.
- For the active CSV, shows a header with material code, description, thickness, and job date.
- Below the header shows the **main run configuration** for this CSV: sheet size, padding, nesting options. These settings apply to subrun 0 and are copied as defaults for later subruns.
- Shows the list of CUT rows. Each row shows quantity, customer, packslip/position, and a dropdown to pick a shape from the shared project library.
- Provides buttons to import another CSV, remove the selected CSV, and clear all CSVs.
- Provides the **Run** button for the active CSV.
- When a run finishes with leftovers, shows a **Next subrun** button and a **Subrun configuration card** where the user can edit the sheet/padding for the next subrun before starting it.
- Allows switching between CSVs so the user can configure and run each material independently.

### `SheetSettingsPanel.vue` changes

- When a CSV is selected, the panel edits that CSV's `runConfiguration.defaultSheet`. The label reads "mother plate 1500x1500" and the default is 1500 x 1500 mm.
- When a subrun configuration card is open, a second instance of `SheetSettingsPanel` (or an inline variant) edits the sheet for that specific subrun without changing the CSV's main default.
- Add a read-only note when a CSV is loaded that says material and thickness come from the CSV.

### `App.vue` changes

- Add toolbar button: **Import CSV** (single `.csv` file, not a zip).
- Add toolbar button: **Export CSV Result** (enabled when the active CSV has a finalized `CsvRunRecord`).
- `buildRequest` is split: DXF/preset runs continue to use the existing global request builder; CSV runs build one subrun request at a time from the active `CsvRunSession`.
- `saveProject` / `openProject` must include `csvImports` and `csvRunRecords`.
- Persist which CSV is `selectedCsvId` in workspace/project state so reopening restores the same view.
- After a subrun finishes with leftovers, show a **Next subrun** button in the active CSV panel.

### `StrategyRunsPanel.vue` changes

- For runs with subruns, show a collapsible list of subruns.
- Each subrun shows its plate size, placed count, unplaced count, and used area.
- For the last subrun that still has unplaced pieces, show a **Start next subrun** action.
- Selecting a subrun renders its own placements and history frames.

### `DxfPreviewCanvas.vue` changes

- In result mode, when a subrun is selected, render that subrun's sheet outline and placements.
- Fall back to the full run union when no subrun is selected.

---

## 9. Export service

Add `exportCsvResultToFile(outPath, csvImport, csvRunRecord)` in `src/main/services/ExportService.ts`:

- Reads `csvRunRecord.subRuns`.
- Produces one output CSV file named `<jobDate>_<material description sanitized>.csv`, where spaces become underscores and illegal characters are removed.
- Emits one `MATERIAL` line using the material code from `csvImport`.
- Emits subruns in index order. For each subrun:
  - emit one `PLATTENMASS` line using `subrun.sheet`;
  - then emit one `AUFTRAG` line per distinct `(reference, customerName)` placed on that subrun, aggregating the amount from `subrun.placements`.
- Looks up `cutRowRef` metadata from `csvRunRecord.preparedPieces` by `Placement.pieceId`.
- The packslip/position split uses the last underscore in `reference`; if no underscore is present, position is empty.
- If `csvRunRecord.unplacedPieceIds` is non-empty, log a preparation warning in the renderer and skip those pieces in the exported file.
- Sanitizes customer names and references on export by stripping semicolons and line breaks.
- Writes the output CSV with Windows-1252 / CP1252 encoding and CRLF line endings, then returns the written file path.

The `AppApi.exportCsvResult` signature must match the service: `exportCsvResult(csvImport: ProjectCsvImport, csvRunRecord: CsvRunRecord, outPath: string): Promise<string>`.

---

## 10. Project file schema version

Bump `ProjectDocument.version` from 1 to 2 and add a migration path:

- `ProjectDocumentStrict` accepts version 2 with the new optional fields.
- Loading a version 1 file keeps `csvImports`, `csvRunRecords`, and the new optional `NestingResult` fields empty/absent and proceeds normally.
- Because `NestingResult.runSummary`, `NestingResult.preparedPieces`, and `NestingResult.csvImportId` are optional, existing `lastResult` and `runRecords` from version-1 files decode without migration.
- Saving always writes version 2.
- Update `tests/unit/projectFileService.test.ts` with a version-2 fixture and a round-trip test for a legacy version-1 file.

---

## 11. Implementation order

1. Domain model changes in `src/shared/domain/project.ts` (add `ProjectCsvImport`, `CsvRunRecord`, embed `ProjectRunConfiguration`, drop top-level `runConfigurations`), `src/shared/domain/nesting.ts` (add `NestingSubRun` fields and `csvImportId` on `NestingResult`), and `src/shared/preparePieces.ts` (add `sourcePieceId` and `cutRowRef`).
2. CSV parser service in `src/main/services/CsvImportService.ts` with Windows-1252 decoding, plus unit tests using the real sample files.
3. Workspace SQLite table and persistence methods for single `.csv` imports.
4. IPC handlers, preload API, and `AppApi` contract tests.
5. Renderer CSV store with `CsvRunSession` and `CsvImportPanel.vue`.
6. Cut-list expansion for CSV rows in `useCsvImportStore` / `CsvRunSession`.
7. `computeNesting` `strategyRunId` override; no worker wrapper for the multi-subrun loop.
8. Worker protocol updates to carry `runSummary`, `preparedPieces`, and optional `csvImportId` on `NestingResult`.
9. Export service CSV writer with single-file output and Windows-1252 encoding.
10. Project schema version bump, migration, and tests.
11. UI integration: toolbar, sheet defaults, runs panel, canvas, subrun config card.
12. Update `docs/architecture/project-persistence.md` and `docs/architecture/process-boundaries.md` to document CSV handling.

### Deferred to a later iteration

- Zip archive import/export (`Input.zip` / `Output.zip`).
- Running multiple CSVs in one combined job.
- Global optimization across subruns or stock-cutting heuristics.

---

## 12. Verification

- `pnpm typecheck` clean.
- `pnpm lint:fix` clean.
- Unit tests for CSV parsing (including Windows-1252 samples), workspace round-trip, and project schema version 2.
- Manual end-to-end: import one of the example `.csv` files plus the three DXF files, set 1500x1500 in the CSV's main run configuration, run subrun 0, manually start a second subrun for leftovers, export a `.csv` that matches the ABAS/CAMQUIX shape.

---

## 13. Risks and open questions

- The packslip/position string may contain characters that make a bad file name. CSV parsing must be tolerant and use the raw string as the matching key.
- If one DXF file should map to many CSV rows, a future `shapeCode` matching mode will be needed. It is explicitly out of scope for this feasibility prototype.
- Multiple materials in one session are handled by importing each material as a separate CSV and selecting the active CSV before running. The project can hold many CSVs, but the run session, configuration, and result view are per-CSV.
- The worker supervisor serializes one worker job at a time. Subruns run sequentially inside one renderer-owned CSV run session, each as a separate worker job. This keeps the implementation simple but may be slower for many plates.
- Windows-1252 is assumed for the ABAS/CAMQUIX interface. If later samples use UTF-8 or another code page, the encoding must become configurable per import.
- Because each subrun is a separate worker request, history frames and strategy results must be keyed by `strategyRunId` that includes the subrun index. The renderer must not overwrite the previous subrun's history when a new subrun starts.
