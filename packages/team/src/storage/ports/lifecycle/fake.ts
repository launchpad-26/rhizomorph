import type { LifecyclePort } from './port.js'

export interface LifecycleFake extends LifecyclePort {
  readonly closed: boolean
}

export function createLifecycleFake(calls: string[]): LifecycleFake {
  let closed = false
  return {
    get closed(): boolean {
      return closed
    },
    async close(): Promise<void> {
      calls.push('close')
      closed = true
    },
  }
}
