# Process Boundaries

## Renderer

The renderer renders UI and holds transient interaction state through Vue composables.

It may:

- call `window.appApi`;
- hydrate stores from a validated `ProjectDocument`;
- render imported source geometry, worker results, warnings, and history frames;
- expose disabled controls for future features.

It must not:

- use Node filesystem APIs;
- spawn workers;
- cast IPC payloads directly into domain types;
- mutate another composable's internal state from outside its public actions.

## Preload

Preload exposes the typed `AppApi` through `contextBridge`.

It unwraps `IpcResult` envelopes and keeps raw channel names out of Vue components. It should remain small and boundary-focused.

## Main

Main owns:

- Electron dialogs;
- filesystem access;
- DXF file import;
- project save/open;
- export requests/results/history;
- worker supervision;
- IPC result translation.

IPC handlers are the Promise boundary for main-process services. Validate renderer payloads before service work and return stable `IpcResult` envelopes.

DXF geometry may contain fractional coordinates. Main normalizes imported
objects into integer-millimeter containing rectangles before they become project
or worker data: `realBounds`, `paddedBounds`, sheet dimensions, placements, and
free rectangles are integer grid values. The original DXF geometry remains
fractional inside that container and is translated for preview/export.

Renderer cutting settings store padding as total integer clearance. Request
preparation expands each side by `ceil(padding / 2)`, so odd padding values
round outward and the worker still receives integer-millimeter rectangles only.

## Worker

The worker receives schema-decoded `RunNestingPayload` values through `NestingWorkerRpcs`, runs the computation workflow, writes optional NDJSON history, and streams typed `WorkerResponse` messages.

The worker must not perform unit conversion or float-to-grid normalization.
Its rectangle inputs are already non-negative integer millimeters, with positive
integer width and height.

The worker transport is Effect-owned through `NodeWorker`, `NodeWorkerRunner`, and Effect RPC. The app-owned payload protocol is `RunNestingPayload -> Stream<WorkerResponse>`.

History persistence is authoritative: frames are appended to NDJSON before optional live streaming. Live `history_frame` delivery is best-effort; persistence failures still fail the job.
