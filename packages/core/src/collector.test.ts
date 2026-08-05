import { describe, expect, it } from 'vitest'
import {
  absentCapabilities,
  capabilitiesOf,
  deriveRung,
  honestCapabilities,
  mergeCapabilities,
  nextRung,
  rungInfo,
  RUNGS,
  SIGNALS,
  UNKNOWN_CAPABILITIES,
  type AdapterCapabilities,
  type AnyCollector,
  type CapabilityLevel,
  type Collector,
  type CollectorContext,
  type Rung,
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

// ── prd15 ruling 4/5 — AdapterCapabilities and the enrichment rung ──────────

function provided(): AdapterCapabilities {
  const detail = { level: 'provided' as const }
  return { identity: detail, liveness: detail, activity: detail, attention: detail, telemetry: detail, cost: detail }
}

function allAt(level: CapabilityLevel): AdapterCapabilities {
  const detail =
    level === 'provided' ? { level } : { level, reason: `stub ${level} signal for a test` }
  return { identity: detail, liveness: detail, activity: detail, attention: detail, telemetry: detail, cost: detail }
}

describe('capabilitiesOf', () => {
  it('returns a collector\'s own declaration when it has one', () => {
    const withCaps: Pick<Collector, 'capabilities'> = { capabilities: provided() }
    expect(capabilitiesOf(withCaps)).toBe(withCaps.capabilities)
  })

  it('gives the honest all-absent default to a collector that declares nothing — never a flattering guess', () => {
    const bare: Pick<Collector, 'capabilities'> = {}
    const result = capabilitiesOf(bare)
    expect(result).toBe(UNKNOWN_CAPABILITIES)
    for (const signal of SIGNALS) {
      expect(result[signal].level).toBe('absent')
      expect((result[signal] as { reason: string }).reason).toBeTruthy()
    }
  })
})

describe('absentCapabilities', () => {
  it('turns every signal absent with the same reason and remedy — the disabled-collector override', () => {
    const result = absentCapabilities('tmux binary not found', 'install tmux')
    for (const signal of SIGNALS) {
      expect(result[signal]).toEqual({ level: 'absent', reason: 'tmux binary not found', remedy: 'install tmux' })
    }
  })

  it('never claims provided for a disabled collector, whatever its normal capabilities said', () => {
    const disabled = absentCapabilities('workmux binary not found')
    for (const signal of SIGNALS) {
      expect(disabled[signal].level).not.toBe('provided')
    }
  })
})

describe('honestCapabilities', () => {
  it('passes the declared capabilities through unchanged when active', () => {
    const declared = provided()
    expect(honestCapabilities({ capabilities: declared, active: true })).toBe(declared)
  })

  it('overrides to all-absent-with-reason when inactive, never the declared shape', () => {
    const declared = provided()
    const result = honestCapabilities({ capabilities: declared, active: false, inactiveReason: 'tmux not found on PATH' })
    for (const signal of SIGNALS) {
      expect(result[signal]).toEqual({ level: 'absent', reason: 'tmux not found on PATH' })
    }
  })

  it('falls back to a generic reason when inactive with none given', () => {
    const result = honestCapabilities({ capabilities: provided(), active: false })
    expect(result.identity).toMatchObject({ level: 'absent' })
    expect((result.identity as { reason: string }).reason).toBeTruthy()
  })
})

describe('mergeCapabilities', () => {
  it('is the honest default when nothing is merged', () => {
    expect(mergeCapabilities([])).toBe(UNKNOWN_CAPABILITIES)
  })

  it('takes the best level per signal — a second witness only ever adds confidence', () => {
    const weak = allAt('absent')
    const strong: AdapterCapabilities = { ...allAt('absent'), attention: { level: 'provided' } }
    const merged = mergeCapabilities([weak, strong])
    expect(merged.attention.level).toBe('provided')
    expect(merged.identity.level).toBe('absent')
  })

  it('never lets a disabled collector\'s absence pull a signal another collector still provides', () => {
    const healthy = provided()
    const disabled = absentCapabilities('binary missing')
    const merged = mergeCapabilities([healthy, disabled])
    for (const signal of SIGNALS) expect(merged[signal].level).toBe('provided')
  })
})

describe('deriveRung — pure and total', () => {
  it('every one of the 3^6 signal-level combinations maps to exactly one rung, no throw', () => {
    const levels: CapabilityLevel[] = ['absent', 'partial', 'provided']
    let count = 0
    // Exhaustive over the whole space: 6 signals × 3 levels = 729 combinations.
    for (let code = 0; code < 3 ** SIGNALS.length; code += 1) {
      let remainder = code
      const capabilities = {} as AdapterCapabilities
      for (const signal of SIGNALS) {
        const level = levels[remainder % 3]!
        remainder = Math.floor(remainder / 3)
        capabilities[signal] = level === 'provided' ? { level } : { level, reason: 'exhaustive test fixture' }
      }
      const rung = deriveRung(capabilities)
      expect(RUNGS).toContain(rung)
      count += 1
    }
    expect(count).toBe(729)
  })

  it('bare git alone (no signal above absent) sits at L0', () => {
    expect(deriveRung(allAt('absent'))).toBe('L0')
  })

  it('the sessionlog shape (structural identity/liveness/activity/telemetry, inferred attention, no dollars) sits at L0', () => {
    const capabilities: AdapterCapabilities = {
      identity: { level: 'provided' },
      liveness: { level: 'provided' },
      activity: { level: 'provided' },
      attention: { level: 'partial', reason: 'inferred from transcript shape' },
      telemetry: { level: 'provided' },
      cost: { level: 'absent', reason: 'no dollars without OTLP' },
    }
    expect(deriveRung(capabilities)).toBe('L0')
  })

  it('cost becoming anything but absent (env/OTLP) climbs to L1', () => {
    const capabilities: AdapterCapabilities = {
      ...allAt('absent'),
      telemetry: { level: 'provided' },
      cost: { level: 'partial', reason: 'estimated, not authoritative' },
    }
    expect(deriveRung(capabilities)).toBe('L1')
  })

  it('a heuristic-attention, telemetry-free shape (the PTY-wrapper signature) sits at L3', () => {
    const capabilities: AdapterCapabilities = {
      ...allAt('absent'),
      activity: { level: 'provided' },
      attention: { level: 'partial', reason: 'prompt-pattern heuristic, live' },
    }
    expect(deriveRung(capabilities)).toBe('L3')
  })

  it('declared attention (tmux/workmux) climbs to L4 regardless of the other five signals', () => {
    const capabilities: AdapterCapabilities = { ...allAt('absent'), attention: { level: 'provided' } }
    expect(deriveRung(capabilities)).toBe('L4')
  })
})

describe('nextRung and rungInfo — the `_never`-exhaustive ladder order', () => {
  it('climbs L0 through L4 and stops at the top', () => {
    expect(nextRung('L0')).toBe('L1')
    expect(nextRung('L1')).toBe('L2')
    expect(nextRung('L2')).toBe('L3')
    expect(nextRung('L3')).toBe('L4')
    expect(nextRung('L4')).toBeNull()
  })

  it('names and gives a climb line for every rung, with no gaps', () => {
    for (const rung of RUNGS) {
      const info = rungInfo(rung)
      expect(info.label).toContain(rung)
      expect(info.climb.length).toBeGreaterThan(0)
    }
  })

  it('rejects an unknown rung at the `_never` guard rather than returning something made up', () => {
    expect(() => nextRung('L5' as Rung)).toThrow()
    expect(() => rungInfo('L5' as Rung)).toThrow()
  })
})
