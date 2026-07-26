export interface GeometryCacheKey {
  readonly namespace: string
  readonly parts: ReadonlyArray<string>
}

export interface GeometryCacheStore {
  readonly get: <A>(key: GeometryCacheKey) => A | undefined
  readonly set: <A>(key: GeometryCacheKey, value: A) => void
  readonly remove: (key: GeometryCacheKey) => void
  readonly clear: () => void
}

export function serializeGeometryCacheKey(key: GeometryCacheKey): string {
  return JSON.stringify([key.namespace, key.parts])
}
