import { describe, expect, it } from 'vitest'
import {
  type AnyCollector,
  type Collector,
  type CollectorContext,
  createCollectorContext,
} from './collector.js'
import { createIdFactory } from './events/index.js'
import { createStubExec } from './fixtures.js'
import { reduceAll } from './reduce.js'

/**
 * An end-to-end rehearsal of the contract the three collector issues build
 * against: pure logic over command output, snapshot in, events out.
 */
interface BranchSnapshot {
  heads: Record<string, string>
}

const exampleCollector: Collector<BranchSnapshot> = {
  name: 'example',
  initialSnapshot: () => ({ heads: {} }),
  async poll(prev, ctx) {
    const result = await ctx.exec('git', ['for-each-ref', '--format=%(refname:short) %(objectname)'], {
      cwd: ctx.repoPath,
    })
    if (result.failed) {
      return {
        nextSnapshot: prev,
        events: [ctx.emit('collector.error', { collector: 'example', message: result.stderr })],
      }
    }

    const heads: Record<string, string> = {}
    for (const line of result.stdout.split('\n')) {
      const [branch, head] = line.trim().split(' ')
      if (branch === undefined || head === undefined) continue
      heads[branch] = head
    }

    const events = Object.entries(heads)
      .filter(([branch, head]) => prev.heads[branch] !== head)
      .map(([branch, head]) =>
        ctx.emit('branch.updated', { branch, head, previousHead: prev.heads[branch] ?? null }),
      )

    return { nextSnapshot: { heads }, events }
  },
}

function contextWith(exec: ReturnType<typeof createStubExec>, now: number): CollectorContext {
  return createCollectorContext({
    repoPath: '/repo/rhizomorph',
    now,
    exec,
    nextId: createIdFactory('ex'),
  })
}

describe('the Collector contract', () => {
  it('turns command output into events and a snapshot to poll against', async () => {
    const exec = createStubExec([
      { match: 'for-each-ref', result: { stdout: 'main abc123\nfeature def456\n' } },
    ])
    const ctx = contextWith(exec, 1000)

    const first = await exampleCollector.poll(exampleCollector.initialSnapshot(), ctx)
    expect(first.events.map((event) => event.payload)).toEqual([
      { branch: 'main', head: 'abc123', previousHead: null },
      { branch: 'feature', head: 'def456', previousHead: null },
    ])
    expect(first.events[0]).toMatchObject({ id: 'ex-000001', ts: 1000, source: 'git' })
    expect(first.nextSnapshot).toEqual({ heads: { main: 'abc123', feature: 'def456' } })
    expect(exec.calls[0]).toMatchObject({
      command: 'git',
      options: { cwd: '/repo/rhizomorph' },
    })
  })

  it('emits only diffs on the next poll — no tick spam', async () => {
    const exec = createStubExec([
      { match: 'for-each-ref', result: { stdout: 'main abc123\nfeature def456\n' } },
    ])
    const snapshot = { heads: { main: 'abc123', feature: 'old000' } }
    const { events, nextSnapshot } = await exampleCollector.poll(snapshot, contextWith(exec, 2000))

    expect(events).toHaveLength(1)
    expect(events[0]?.payload).toEqual({
      branch: 'feature',
      head: 'def456',
      previousHead: 'old000',
    })
    expect(nextSnapshot.heads['main']).toBe('abc123')
  })

  it('reports a failing command instead of throwing, and keeps its snapshot', async () => {
    const exec = createStubExec([
      { match: 'for-each-ref', result: { code: 128, stderr: 'not a git repository' } },
    ])
    const snapshot = { heads: { main: 'abc123' } }
    const { events, nextSnapshot } = await exampleCollector.poll(snapshot, contextWith(exec, 3000))

    expect(events[0]).toMatchObject({
      type: 'collector.error',
      payload: { collector: 'example', message: 'not a git repository' },
    })
    expect(nextSnapshot).toBe(snapshot)
  })

  it('treats an unstubbed command the way a missing binary behaves', async () => {
    const exec = createStubExec()
    const result = await exec('workmux', ['status'])
    expect(result).toMatchObject({ code: 127, failed: true })
    expect(result.errorMessage).toContain('workmux status')
  })

  it('produces events the reducer accepts, end to end', async () => {
    const exec = createStubExec([{ match: 'for-each-ref', result: { stdout: 'main abc123\n' } }])
    const { events } = await exampleCollector.poll({ heads: {} }, contextWith(exec, 4000))
    expect(reduceAll(events).branches['main']).toMatchObject({ head: 'abc123' })
  })

  it('holds collectors of differing snapshot types in one registry', () => {
    const registry: AnyCollector[] = [exampleCollector]
    expect(registry[0]?.name).toBe('example')
  })
})

describe('createCollectorContext', () => {
  it('stamps every event with the tick time and a fresh id', () => {
    const ctx = contextWith(createStubExec(), 7000)
    const a = ctx.emit('pane.closed', { paneId: '%1' })
    const b = ctx.emit('pane.closed', { paneId: '%2' })
    expect([a.ts, b.ts]).toEqual([7000, 7000])
    expect(a.id).not.toBe(b.id)
  })

  it('validates at the boundary — a bad payload never reaches the log', () => {
    const ctx = contextWith(createStubExec(), 7000)
    // @ts-expect-error — paneId is required
    expect(() => ctx.emit('pane.closed', {})).toThrow()
  })

  /**
   * The seam wave A stands on: a collector reading a week-old log line has to
   * be able to say when the fact happened, or that spend lands inside the live
   * rate window and `$/hr` spikes on boot.
   */
  it('keeps a source timestamp when one is given, and the tick time when it is not', () => {
    const ctx = contextWith(createStubExec(), 1_700_000_000_000)
    const weekOld = 1_699_400_000_000

    const replayed = ctx.emit('pane.closed', { paneId: '%1' }, { ts: weekOld })
    const live = ctx.emit('pane.closed', { paneId: '%2' })

    expect(replayed.ts).toBe(weekOld)
    expect(live.ts).toBe(1_700_000_000_000)
  })

  it('treats an explicit ts of 0 as a real time, not a missing one', () => {
    const ctx = contextWith(createStubExec(), 7000)
    expect(ctx.emit('pane.closed', { paneId: '%1' }, { ts: 0 }).ts).toBe(0)
  })

  it('floors a fractional source time rather than failing the envelope', () => {
    const ctx = contextWith(createStubExec(), 7000)
    expect(ctx.emit('pane.closed', { paneId: '%1' }, { ts: 1234.75 }).ts).toBe(1234)
  })

  it('refuses a source time that is not a real epoch — a broken date parser is loud', () => {
    const ctx = contextWith(createStubExec(), 7000)
    expect(() => ctx.emit('pane.closed', { paneId: '%1' }, { ts: Number.NaN })).toThrow()
    expect(() => ctx.emit('pane.closed', { paneId: '%1' }, { ts: -1 })).toThrow()
  })
})

describe('createStubExec', () => {
  it('matches on the whole command line and records every call', async () => {
    const exec = createStubExec([
      { match: 'tmux list-panes', result: { stdout: '%1 zsh\n' } },
      { match: (command) => command === 'workmux', result: { stdout: 'nothing\n' } },
    ])
    expect((await exec('tmux', ['list-panes', '-a'])).stdout).toBe('%1 zsh\n')
    expect((await exec('workmux', ['status'])).stdout).toBe('nothing\n')
    expect(exec.calls.map((call) => call.command)).toEqual(['tmux', 'workmux'])
  })

  it('defaults a route to a clean, silent exit', async () => {
    const exec = createStubExec([{ match: 'git' }])
    expect(await exec('git', ['status'])).toEqual({
      stdout: '',
      stderr: '',
      code: 0,
      failed: false,
    })
  })
})
