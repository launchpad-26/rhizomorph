import { describe, expect, it, vi } from 'vitest'
import { serverSpawnRequest } from './spawn-contract.js'
import { ServerSupervisor, type ChildLike, type ServerStatus } from './supervisor.js'

const REQUEST = serverSpawnRequest({
  execPath: '/app/rhizomorph',
  serverEntry: '/app/packages/server/bin/rhizomorph.mjs',
  repoPath: '/repo',
  env: {},
})

/** A child process with hand-cranked streams: `emit` writes, `exit` ends it. */
function fakeChild() {
  const listeners = {
    stdout: [] as ((chunk: string) => void)[],
    stderr: [] as ((chunk: string) => void)[],
    exit: [] as ((code: number | null, signal: string | null) => void)[],
    error: [] as ((error: Error) => void)[],
  }
  const kills: (string | undefined)[] = []
  const stream = (bucket: 'stdout' | 'stderr') => ({
    on(_event: 'data', listener: (chunk: Buffer | string) => void) {
      listeners[bucket].push(listener as (chunk: string) => void)
      return this
    },
  })
  const child: ChildLike = {
    pid: 4242,
    stdout: stream('stdout'),
    stderr: stream('stderr'),
    on(event: 'exit' | 'error', listener: never) {
      if (event === 'exit') listeners.exit.push(listener)
      else listeners.error.push(listener)
      return child
    },
    kill(signal) {
      kills.push(signal)
      return true
    },
  }
  return {
    child,
    kills,
    say: (bucket: 'stdout' | 'stderr', chunk: string) => {
      for (const listener of listeners[bucket]) listener(chunk)
    },
    exit: (code: number | null, signal: string | null = null) => {
      for (const listener of listeners.exit) listener(code, signal)
    },
    error: (error: Error) => {
      for (const listener of listeners.error) listener(error)
    },
  }
}

describe('the happy path', () => {
  it('resolves running the moment the server prints its listening URL', async () => {
    const fake = fakeChild()
    const seen: ServerStatus[] = []
    const supervisor = new ServerSupervisor({ spawn: () => fake.child, onStatus: (s) => seen.push(s) })

    const started = supervisor.start(REQUEST)
    fake.say('stdout', 'starting session 1 (no previous session recorded)\n')
    fake.say('stdout', 'rhizomorph running at http://127.0.0.1:38211\n')

    await expect(started).resolves.toMatchObject({ phase: 'running', url: 'http://127.0.0.1:38211' })
    expect(seen.map((s) => s.phase)).toEqual(['running'])
  })

  it('reads the line off stderr too — the bin\'s own note goes there', async () => {
    const fake = fakeChild()
    const supervisor = new ServerSupervisor({ spawn: () => fake.child })
    const started = supervisor.start(REQUEST)
    fake.say('stderr', 'rhizomorph running at http://127.0.0.1:5000\n')
    await expect(started).resolves.toMatchObject({ phase: 'running', url: 'http://127.0.0.1:5000' })
  })

  it('waits for the line to finish rather than reading a truncated port', async () => {
    const fake = fakeChild()
    const supervisor = new ServerSupervisor({ spawn: () => fake.child })
    const started = supervisor.start(REQUEST)

    // The chunk boundary lands mid-number. A reader that scanned the partial
    // buffer would answer `http://127.0.0.1:38` — a URL that parses, and a port
    // nothing is listening on.
    fake.say('stdout', 'rhizomorph running at http://127.0.0.1:38')
    expect(supervisor.current().phase).toBe('starting')
    fake.say('stdout', '211\n')

    await expect(started).resolves.toMatchObject({ url: 'http://127.0.0.1:38211' })
  })
})

describe('failure degrades loudly and keeps working (D43)', () => {
  it('reports a server that exits before it ever listens, with its output', async () => {
    const fake = fakeChild()
    const supervisor = new ServerSupervisor({ spawn: () => fake.child })
    const started = supervisor.start(REQUEST)

    fake.say('stderr', 'port 4321 is already in use — pass a different one with --port <n>\n')
    fake.exit(1)

    const status = await started
    expect(status.phase).toBe('failed')
    expect(status.url).toBeNull()
    expect(status.detail).toContain('exited with code 1')
    expect(status.outputTail).toContain('port 4321 is already in use — pass a different one with --port <n>')
  })

  it('never rejects — a dead server is a status, not an unhandled rejection', async () => {
    const supervisor = new ServerSupervisor({
      spawn: () => {
        throw new Error('ENOENT: no such file or directory')
      },
    })
    const status = await supervisor.start(REQUEST)
    expect(status.phase).toBe('failed')
    expect(status.detail).toContain('ENOENT')
  })

  it('reports a spawn error event as a failure too', async () => {
    const fake = fakeChild()
    const supervisor = new ServerSupervisor({ spawn: () => fake.child })
    const started = supervisor.start(REQUEST)
    fake.error(new Error('EACCES'))
    await expect(started).resolves.toMatchObject({ phase: 'failed' })
  })

  it('gives up after the start timeout and says how long it waited', async () => {
    const fake = fakeChild()
    const supervisor = new ServerSupervisor({ spawn: () => fake.child, startTimeoutMs: 5_000 })
    vi.useFakeTimers()
    try {
      const started = supervisor.start(REQUEST)
      vi.advanceTimersByTime(5_000)
      const status = await started
      expect(status.phase).toBe('failed')
      expect(status.detail).toBe('the server did not report a listening URL within 5s')
    } finally {
      vi.useRealTimers()
    }
  })

  it('notices a server that dies AFTER it was serving — the window stays, the fact changes', async () => {
    const fake = fakeChild()
    const seen: ServerStatus[] = []
    const supervisor = new ServerSupervisor({ spawn: () => fake.child, onStatus: (s) => seen.push(s) })
    const started = supervisor.start(REQUEST)
    fake.say('stdout', 'rhizomorph running at http://127.0.0.1:4321\n')
    await started

    fake.exit(null, 'SIGSEGV')
    expect(seen.map((s) => s.phase)).toEqual(['running', 'failed'])
    expect(supervisor.current().detail).toContain('SIGSEGV')
  })

  it('keeps the output tail bounded so a chatty server cannot grow the main process without bound', async () => {
    const fake = fakeChild()
    const supervisor = new ServerSupervisor({ spawn: () => fake.child, tailLines: 3 })
    supervisor.start(REQUEST)
    for (let i = 0; i < 50; i += 1) fake.say('stdout', `line ${i}\n`)
    fake.exit(1)
    expect(supervisor.current().outputTail).toEqual(['line 47', 'line 48', 'line 49'])
  })
})

describe('shutting down cleanly', () => {
  it('asks with SIGTERM — the signal the server\'s bin handles and releases its lock on', async () => {
    const fake = fakeChild()
    const supervisor = new ServerSupervisor({ spawn: () => fake.child, stopGraceMs: 50 })
    const started = supervisor.start(REQUEST)
    fake.say('stdout', 'rhizomorph running at http://127.0.0.1:4321\n')
    await started

    const stopping = supervisor.stop()
    expect(fake.kills).toEqual(['SIGTERM'])
    fake.exit(0)
    await stopping
    expect(fake.kills).toEqual(['SIGTERM'])
    expect(supervisor.current().phase).toBe('stopped')
  })

  it('escalates to SIGKILL only after the grace period a server ignored', async () => {
    const fake = fakeChild()
    const supervisor = new ServerSupervisor({ spawn: () => fake.child, stopGraceMs: 10 })
    const started = supervisor.start(REQUEST)
    fake.say('stdout', 'rhizomorph running at http://127.0.0.1:4321\n')
    await started

    await supervisor.stop()
    expect(fake.kills).toEqual(['SIGTERM', 'SIGKILL'])
  })

  it('does not report an asked-for exit as a failure', async () => {
    const fake = fakeChild()
    const seen: ServerStatus[] = []
    const supervisor = new ServerSupervisor({ spawn: () => fake.child, stopGraceMs: 10, onStatus: (s) => seen.push(s) })
    const started = supervisor.start(REQUEST)
    fake.say('stdout', 'rhizomorph running at http://127.0.0.1:4321\n')
    await started

    const stopping = supervisor.stop()
    fake.exit(0)
    await stopping
    expect(seen.map((s) => s.phase)).toEqual(['running', 'stopped'])
  })
})
