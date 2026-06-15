import type { NodeTerminalApi } from '../shared/types'

declare global {
  interface Window {
    nodeTerminal: NodeTerminalApi
  }
}

export {}
