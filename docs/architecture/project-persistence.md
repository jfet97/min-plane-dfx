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

The `projects` row for `temporary` also stores `settings_json`, a
schema-decoded `WorkspaceProjectSettings` payload containing sheet settings,
padding, nesting options, and cut-list quantities.

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

Preset shapes are persisted in the temporary workspace as imported document
summaries with `preset://` paths. They do not need copied source files, but they
must survive renderer reload and hydrate through the same renderer actions as
DXF imports so the cut list, preview, request export, and worker request all see
one source-shape model.

Unsaved project settings also live in the temporary workspace: sheet size/label,
padding, nesting options, and cut-list quantities. Renderer reload should not
reset those values to defaults. The renderer writes those settings immediately
through a serialized save queue whenever the user edits them; delayed debounce
timers are not acceptable for values that must survive `Ctrl+R`.

## Open Behavior

Opening a project must hydrate renderer stores. It must not merely validate the file.

Opening a project resets transient worker state to idle. It must not invent, resume, or imply a running worker job.

## History References

History frames may live in a worker-written NDJSON file referenced by `ProjectHistoryRef`.

If that file is missing or unreadable on open, keep the loaded result visible and show a compact recoverable warning. Missing history is not a reason to reject a valid project snapshot.

## Validation

Loaded JSON must pass a strict project schema before it reaches renderer state.

Do not use `Schema.Unknown` for project fields that the renderer reads as domain data.
