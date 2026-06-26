/**
 * Exhaustiveness helper for discriminated unions. Throws a `never`-typed
 * assertion if a new variant is added without updating its consumers.
 */
export function assertNever(value: never, label?: string): never {
  throw new Error(
    `${label ?? 'assertNever'}: unhandled discriminant value ${JSON.stringify(value)}`
  )
}
