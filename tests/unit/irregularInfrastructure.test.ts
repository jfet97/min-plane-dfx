import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { CollisionGeometryBuilder } from '../../src/workers/irregular/collisionGeometryBuilder.js'
import { IrregularNestingInfrastructureLive } from '../../src/workers/irregular/infrastructure.js'

describe('IrregularNestingInfrastructureLive', () => {
  it('supplies default geometry settings to the collision geometry builder', async () => {
    const result = await Effect.runPromise(
      CollisionGeometryBuilder.use(() => Effect.succeed('configured')).pipe(
        Effect.provide(IrregularNestingInfrastructureLive)
      )
    )

    expect(result).toBe('configured')
  })
})
