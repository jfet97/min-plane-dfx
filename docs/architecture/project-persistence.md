# Project Persistence

There is no database in the first version.

A project is a single user-selected JSON snapshot saved through the native save dialog and opened through the native open dialog.

## Saved State

A project should include:

- source file references;
- imported piece metadata;
- imported DXF document summaries when available;
- sheet settings;
- nesting options;
- latest worker result when available;
- latest NDJSON history reference when available.

## Open Behavior

Opening a project must hydrate renderer stores. It must not merely validate the file.

Opening a project resets transient worker state to idle. It must not invent, resume, or imply a running worker job.

## History References

History frames may live in a worker-written NDJSON file referenced by `ProjectHistoryRef`.

If that file is missing or unreadable on open, keep the loaded result visible and show a compact recoverable warning. Missing history is not a reason to reject a valid project snapshot.

## Validation

Loaded JSON must pass a strict project schema before it reaches renderer state.

Do not use `Schema.Unknown` for project fields that the renderer reads as domain data.
