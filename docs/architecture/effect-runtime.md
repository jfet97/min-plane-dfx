# Effect Runtime

The main process owns a single app runtime in `src/main/runtime/effectRuntime.ts`.

```ts
Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)
```

Use `@effect/platform-node` for Node services. Do not keep local FileSystem or Path shims unless there is a narrow documented package bug and no practical alternative.

## Service Shape

Main services should move toward Effect-returning APIs:

```ts
Effect.Effect<Success, TypedError, FileSystem.FileSystem | Path.Path>
```

IPC handlers are the normal place to call `appRuntime.runPromise` and translate typed errors to `IpcResult`.

## Worker Runtime

The worker may use its own small runtime with `NodeFileSystem.layer` and `NodePath.layer` for local filesystem operations such as NDJSON history files.

Do not import the main runtime into the worker. Worker lifecycle is separate from Electron main lifecycle.

## Worker Protocol

The current worker protocol is app-owned:

```text
WorkerRequest -> WorkerResponse
```

`WorkerSupervisor` uses `node:worker_threads` directly and validates each custom response variant before forwarding history or resolving a result.

Effect also ships `effect/unstable/workers` plus `@effect/platform-node/NodeWorker` and `NodeWorkerRunner`. That is a separate protocol with Effect-owned framing and close messages. Migrating to it is valid future work, but it is not a drop-in replacement for the current `WorkerRequest` / `WorkerResponse` stream.

Do not mix both protocols in one worker.

## Error Model

Prefer tagged/domain errors inside services. Convert to renderer-safe `AppErrorCode` only at IPC boundaries.

Schema validation failures are boundary failures, not generic `unknown_error`.
