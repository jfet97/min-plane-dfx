# Project Persistence

The app uses an Effect SQLite workspace in Electron `userData` for imported DXF copies and temporary project metadata.

A project also has a portable user-selected JSON snapshot saved through the native save dialog and opened through the native open dialog.

## Workspace

On startup, main creates or opens:

```text
app.getPath('userData')/temporary-project/workspace.sqlite
app.getPath('userData')/temporary-project/sources/
```

DXF imports are copied into `sources/` before parsing. SQLite stores original
path, copied path, imported document JSON, and temporary project metadata.
Preset source shapes are stored in the same import table as document JSON with
`preset://` paths.

CSV imports are stored in a separate `imported_csv` table. The table keeps the
original source path, file name, parsed `ProjectCsvImport` JSON, and import
timestamp; CSV bytes are copied through the same workspace source area before
parsing so interrupted imports can be cleaned from staging. Row-to-shape links
and per-CSV run defaults live inside the stored `ProjectCsvImport`, so editing
a row link or CSV run configuration updates that table directly.

The `projects` row for `temporary` also stores `settings_json`, a
schema-decoded `WorkspaceProjectSettings` payload containing sheet settings,
padding, nesting options, cut-list quantities, saved run records, and an
optional monotonic revision. CSV imports are not duplicated in
`settings_json`; only `selectedCsvId` and `csvRunRecords` are stored there.

The temporary workspace survives renderer hot reload and app close/reopen. On
startup, staging files from interrupted imports are cleaned, imports are
rehydrated, and then workspace settings are applied to the renderer stores. On
project save, the workspace row is promoted with the saved JSON path.

## Saved State

A project should include:

- source file references;
- imported piece metadata;
- imported DXF document summaries when available;
- cut-list quantities for each source shape;
- sheet settings;
- nesting options;
- latest worker result when available;
- latest NDJSON history reference when available.
- saved run records with their result, run sheet, piece count, and NDJSON history
  reference when available.
- CSV imports with their embedded row links and per-CSV run configuration;
- CSV run records with their subruns, prepared CSV pieces, and remaining
  unplaced piece ids.

Preset shapes are persisted in the temporary workspace as imported document
summaries with `preset://` paths. They do not need copied source files, but they
must survive renderer reload and hydrate through the same renderer actions as
DXF imports so the cut list, preview, request export, and worker request all see
one source-shape model.

Unsaved project settings also live in the temporary workspace: sheet size/label,
padding, nesting options, and cut-list quantities. Renderer reload should not
reset those values to defaults. The renderer writes those settings directly from
the same composable actions that mutate sheet fields, cutting settings, strategy
settings, and quantities; delayed debounce timers or broad reactive watchers are
not acceptable for values that must survive `Ctrl+R`. Autosave uses an
acknowledged IPC call and a renderer-side last-write queue, matching the
persisted-source-shape path closely enough that edits wait for main to finish
the SQLite write. Since multiple IPC writes can overlap across reload timing,
main stores the revision next to the JSON payload and ignores stale writes.

Completed regular runs are saved as project run records in the same temporary
settings payload. A run record keeps the result, the first sheet used for that
run, and the NDJSON replay reference, so it can be restored after renderer
reload even if the user later changes source shapes, quantities, or sheet
settings. Regular run results may contain multiple manual subruns; each subrun
keeps its own sheet snapshot in `runSummary.subRuns`. Result rendering uses the
selected subrun sheet when one is selected, falling back to the run sheet.
Deleting a run record only removes that archive entry; it does not delete
imported source shapes or mutate the current project setup.

Manual subruns that belong to the same regular run append their worker-emitted
history frames to the same durable NDJSON replay file. The first run truncates
or creates the file; follow-up subrun requests carry an explicit
`strategyRunId`, reuse the parent `jobId`, and append. The final `NestingResult`
also carries the worker `historySummary`, so the renderer can recover the
replay reference even if the separate `history_complete` event is delivered
after the result IPC response.

CSV run records are separate from regular project run records. A CSV record is
keyed by `csvImportId`, keeps every completed subrun in order, and retains the
full prepared-piece catalog so export can map each placement back to the source
CSV row metadata. In-progress CSV sessions with leftovers are stored in
workspace settings as `csvRunRecords`; completed CSV records are saved in the
portable project JSON.

## Open Behavior

Opening a project must hydrate renderer stores. It must not merely validate the file.

Opening a project resets transient worker state to idle. It must not invent, resume, or imply a running worker job.

Opening a project also repopulates the temporary `imported_csv` table from the
saved `csvImports` array, then hydrates the renderer CSV store from the decoded
project document. Saved CSV run records are visible for export or review, while
records with remaining pieces can be rehydrated as active sessions for manual
follow-up subruns.

## History References

History frames may live in a worker-written NDJSON file referenced by
`ProjectHistoryRef`.

Worker history files belong under Electron `userData/dfx-min-project/history`,
not under `out/` or any build output directory. Build artifacts are disposable;
saved run records must only point at durable workspace files.

Replay loading validates NDJSON frames in main and returns the parsed plain JSON
objects through IPC. Main must not return decoded `Schema.Class` instances from
the `nesting:load-replay` invoke handler.

If that file is missing or unreadable on open, keep the loaded result visible,
drop the stale replay reference from the run record, and keep the issue out of
preparation warnings. Missing history is not a reason to reject a valid project
snapshot.

## Validation

Loaded JSON must pass a strict project schema before it reaches renderer state.

Do not use `Schema.Unknown` for project fields that the renderer reads as domain data.
