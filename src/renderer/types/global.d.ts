import type { AppApi } from '@shared/protocol/ipc.js'

declare global {
  var appApi: AppApi | undefined
}

export {}
