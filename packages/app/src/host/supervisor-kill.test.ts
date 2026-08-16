import { describe, expect, it } from 'vitest'
import { serverSpawnRequest } from './spawn-contract.js'
import { ServerSupervisor, type ChildLike } from './supervisor.js'

const REQUEST = serverSpawnRequest({
  execPath: '/app/rhizomorph',
  serverEntry: '/app/packages/server/bin/rhizomorph.mjs',
  repoPath: '/repo',
  env: {},
})

function killRecorder() {
  const kills: (string | undefined)[] = []
  const child: ChildLike = {
    stdout: { on: () => child },
    stderr: { on: () => child },
    on: () => child,
    kill: (signal) => {
      kills.push(signal)
      return true
    },
  }
  return { child, kills }
}

/**
 * The synchronous backstop, for `process.on('exit')` — the one shutdown hook
 * that cannot await. Measured under WSLg: a `SIGTERM` to Electron runs no
 * main-process JS at all, so the graceful path is not always reachable and this
 * is what stands between that and an orphaned server.
 */
describe('killNow', () => {
  it('sends SIGTERM to the child, synchronously', () => {
    const { child, kills } = killRecorder()
    const supervisor = new ServerSupervisor({ spawn: () => child })
    void supervisor.start(REQUEST)

    supervisor.killNow()

    expect(kills).toEqual(['SIGTERM'])
  })

  it('does nothing when there is no child — an exit handler must never throw', () => {
    const supervisor = new ServerSupervisor({ spawn: () => killRecorder().child })
    expect(() => supervisor.killNow()).not.toThrow()
  })

  it('does nothing after a graceful stop has already taken the child', async () => {
    const { child, kills } = killRecorder()
    const supervisor = new ServerSupervisor({ spawn: () => child, stopGraceMs: 1 })
    void supervisor.start(REQUEST)

    await supervisor.stop()
    const afterStop = [...kills]
    supervisor.killNow()

    // `stop()` clears the child, so the exit handler cannot signal a pid that
    // may since have been reused by the operating system.
    expect(kills).toEqual(afterStop)
  })
})
