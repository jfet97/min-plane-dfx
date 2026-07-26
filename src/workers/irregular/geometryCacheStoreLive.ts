import type {
  GeometryCacheKey,
  GeometryCacheStore
} from './core/geometryCacheStore.js'
import { serializeGeometryCacheKey } from './core/geometryCacheStore.js'
import * as NfpIfpTelemetry from './nfpIfpTelemetry.js'

/** Creates the one synchronous backing store owned by a worker geometry-cache service. */
export function makeGeometryCacheStore(): GeometryCacheStore {
  const cache = new Map<string, unknown>()
  NfpIfpTelemetry.recordCacheInstance()
  return {
    get: <A>(key: GeometryCacheKey) => {
      const entry = cache.get(serializeGeometryCacheKey(key)) as A | undefined
      NfpIfpTelemetry.recordCacheGet(key.namespace, entry !== undefined)
      return entry
    },
    set: <A>(key: GeometryCacheKey, value: A) => {
      cache.set(serializeGeometryCacheKey(key), value)
      NfpIfpTelemetry.recordCacheSet(key.namespace)
    },
    remove: (key: GeometryCacheKey) => {
      cache.delete(serializeGeometryCacheKey(key))
      NfpIfpTelemetry.recordCacheRemove(key.namespace)
    },
    clear: () => {
      cache.clear()
    }
  }
}
