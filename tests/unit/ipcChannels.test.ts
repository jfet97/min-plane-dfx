import { describe, expect, it } from 'vitest'
import { IPC_CHANNELS } from '@main/ipc/handlers.js'

const requiredRendererChannels = [
  'dxf:list-imports',
  'dxf:select-files',
  'dxf:import-files',
  'dxf:remove-import',
  'dxf:clear-imports',
  'nesting:delete-run-histories'
] satisfies ReadonlyArray<string>

describe('IPC channel allowlist', () => {
  it('includes renderer DXF workspace channels handled by main', () => {
    expect(IPC_CHANNELS).toEqual(expect.arrayContaining(requiredRendererChannels))
  })
})
