import { ManagedRuntime, Layer, type FileSystem, type Path } from 'effect'
import { NodeFileSystem, NodePath } from '@effect/platform-node'

/**
 * Main-process Effect runtime.
 *
 * Services stay effectful until the IPC boundary, where handlers use
 * `appRuntime.runPromise` to translate typed failures into renderer-safe
 * envelopes. The layer uses the official Node platform implementations for
 * filesystem and path services.
 */
export const AppLiveLayer: Layer.Layer<FileSystem.FileSystem | Path.Path> = Layer.mergeAll(
  NodeFileSystem.layer,
  NodePath.layer
)

export const appRuntime = ManagedRuntime.make(AppLiveLayer)
