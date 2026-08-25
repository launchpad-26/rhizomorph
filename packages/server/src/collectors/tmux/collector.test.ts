import type { CollectorContext, Exec, ExecResult } from '@rhizomorph/core'
import { createEvent } from '@rhizomorph/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { hashPaneContent } from './capture.js'
import { tmuxCollector } from './collector.js'
import { COLLECTOR_FANOUT_LIMIT } from '../../server/concurrency.js'

interface PaneFixture {
  paneId: string
  sessionName: string
  windowIndex: number
  windowName: string
  currentPath: string
  currentCommand: string
  title: string
}

function listPanesLine(p: PaneFixture): string {
  return [p.paneId, p.sessionName, String(p.windowIndex), p.windowName, p.currentPath, p.currentCommand, p.title].join(
    '\t',
  )
}

const success = (stdout: string): ExecResult => ({ stdout, stderr: '', code: 0, failed: false })
const missingBinary = (): ExecResult => ({
  stdout: '',
  stderr: '',
  code: null,
  failed: true,
  errorMessage: 'spawn tmux ENOENT',
})
const notARepo = (): ExecResult => ({
  stdout: '',
  stderr: 'fatal: not a git repository',
  code: 128,
  failed: true,
})

/** Routes the argv form used by the collector; records every call for assertions. */
class FakeShell {
  listPanesOutput = ''
  captureByPane = new Map<string, ExecResult>()
  worktreeByPath = new Map<string, string>()
  gitCalls: string[] = []
  captureCalls: string[] = []

  exec: Exec = async (command, args) => {
    if (command === 'tmux' && args[0] === 'list-panes') {
      return success(this.listPanesOutput)
    }
    if (command === 'tmux' && args[0] === 'capture-pane') {
      const paneId = args.at(-1) ?? ''
      this.captureCalls.push(paneId)
      return this.captureByPane.get(paneId) ?? success('')
    }
    if (command === 'git') {
      const path = args[1] ?? ''
      this.gitCalls.push(path)
      const worktree = this.worktreeByPath.get(path)
      return worktree ? success(`${worktree}\n`) : notARepo()
    }
    throw new Error(`unexpected exec: ${command} ${args.join(' ')}`)
  }
}

function makeContext(exec: Exec, now = 1_000): CollectorContext {
  let counter = 0
  return {
    repoPath: '/repo',
    now,
    exec,
    nextId: () => `id-${(counter += 1)}`,
    emit: (type, payload) => createEvent(type, payload, { id: `id-${(counter += 1)}`, ts: now }),
  }
}

describe('tmuxCollector', () => {
  let shell: FakeShell

  beforeEach(() => {
    shell = new FakeShell()
  })

  it('disables itself once when tmux is not installed, then no-ops forever', async () => {
    shell.exec = async () => missingBinary()
    const context = makeContext(shell.exec)

    const first = await tmuxCollector.poll(tmuxCollector.initialSnapshot(), context)
    expect(first.nextSnapshot.disabled).toBe(true)
    expect(first.events).toHaveLength(1)
    expect(first.events[0]).toMatchObject({
      source: 'system',
      type: 'collector.disabled',
      payload: { collector: 'tmux', reason: 'spawn tmux ENOENT' },
    })

    let execCalls = 0
    const countingExec: Exec = async () => {
      execCalls += 1
      return missingBinary()
    }
    const second = await tmuxCollector.poll(first.nextSnapshot, makeContext(countingExec))
    expect(second.events).toEqual([])
    expect(second.nextSnapshot).toBe(first.nextSnapshot)
    expect(execCalls).toBe(0)
  })

  it('disables itself when no tmux server is running (non-zero exit, no ENOENT)', async () => {
    shell.exec = async () => ({ stdout: '', stderr: 'no server running on /tmp/tmux-1000/default', code: 1, failed: true })
    const context = makeContext(shell.exec)

    const result = await tmuxCollector.poll(tmuxCollector.initialSnapshot(), context)
    expect(result.nextSnapshot.disabled).toBe(true)
    expect(result.events[0]?.payload).toMatchObject({
      collector: 'tmux',
      reason: 'no server running on /tmp/tmux-1000/default',
    })
  })

  it('discovers panes, maps them to worktrees, and emits initial activity', async () => {
    const paneA: PaneFixture = {
      paneId: '%1',
      sessionName: 'obs',
      windowIndex: 0,
      windowName: 'wm-a',
      currentPath: '/worktrees/a',
      currentCommand: 'claude',
      title: 'working',
    }
    const paneB: PaneFixture = {
      paneId: '%2',
      sessionName: 'obs',
      windowIndex: 1,
      windowName: 'wm-b',
      currentPath: '/worktrees/b',
      currentCommand: 'bash',
      title: '',
    }
    shell.listPanesOutput = [listPanesLine(paneA), listPanesLine(paneB)].join('\n')
    shell.worktreeByPath.set('/worktrees/a', '/worktrees/a')
    shell.worktreeByPath.set('/worktrees/b', '/worktrees/b')
    shell.captureByPane.set('%1', success('hello'))
    shell.captureByPane.set('%2', success('world'))

    const result = await tmuxCollector.poll(tmuxCollector.initialSnapshot(), makeContext(shell.exec))

    expect(result.nextSnapshot.disabled).toBe(false)
    expect(Object.keys(result.nextSnapshot.panes)).toEqual(['%1', '%2'])

    const discovered = result.events.filter((e) => e.type === 'pane.discovered')
    expect(discovered).toHaveLength(2)
    expect(discovered[0]?.payload).toMatchObject({
      paneId: '%1',
      sessionName: 'obs',
      windowName: 'wm-a',
      currentPath: '/worktrees/a',
      currentCommand: 'claude',
      title: 'working',
      worktreePath: '/worktrees/a',
    })
    expect(discovered[1]?.payload).toMatchObject({
      paneId: '%2',
      worktreePath: '/worktrees/b',
    })
    expect((discovered[1]?.payload as { title?: string }).title).toBeUndefined()

    const activity = result.events.filter((e) => e.type === 'pane.activity')
    expect(activity).toHaveLength(2)
    expect(activity[0]?.payload).toMatchObject({
      paneId: '%1',
      contentHash: hashPaneContent('hello'),
      previousHash: null,
    })

    // prd15's capability law: `activity: provided` needs a real path that
    // emits it — this poll's `pane.activity` events just proved it. tmux
    // never emits `agent.status`, so `attention` stays `partial` (a footer
    // heuristic), never `provided`.
    expect(tmuxCollector.capabilities?.activity).toEqual({ level: 'provided' })
    expect(tmuxCollector.capabilities?.attention.level).toBe('partial')
    expect(result.events.some((e) => e.type === 'agent.status')).toBe(false)
  })

  it('emits pane.activity only for panes whose content hash changed', async () => {
    const line = (p: PaneFixture) => listPanesLine(p)
    const paneA: PaneFixture = {
      paneId: '%1',
      sessionName: 'obs',
      windowIndex: 0,
      windowName: 'wm-a',
      currentPath: '/worktrees/a',
      currentCommand: 'claude',
      title: '',
    }
    const paneB: PaneFixture = { ...paneA, paneId: '%2', currentPath: '/worktrees/b' }
    shell.listPanesOutput = [line(paneA), line(paneB)].join('\n')
    shell.worktreeByPath.set('/worktrees/a', '/worktrees/a')
    shell.worktreeByPath.set('/worktrees/b', '/worktrees/b')
    shell.captureByPane.set('%1', success('v1'))
    shell.captureByPane.set('%2', success('unchanged'))

    const first = await tmuxCollector.poll(tmuxCollector.initialSnapshot(), makeContext(shell.exec))

    shell.captureByPane.set('%1', success('v2'))
    const second = await tmuxCollector.poll(first.nextSnapshot, makeContext(shell.exec))

    const activity = second.events.filter((e) => e.type === 'pane.activity')
    expect(activity).toHaveLength(1)
    expect(activity[0]?.payload).toMatchObject({
      paneId: '%1',
      contentHash: hashPaneContent('v2'),
      previousHash: hashPaneContent('v1'),
    })
    expect(second.events.some((e) => e.type === 'pane.closed')).toBe(false)
  })

  it('emits pane.closed when a pane disappears from list-panes', async () => {
    const paneA: PaneFixture = {
      paneId: '%1',
      sessionName: 'obs',
      windowIndex: 0,
      windowName: 'wm-a',
      currentPath: '/worktrees/a',
      currentCommand: 'claude',
      title: '',
    }
    shell.listPanesOutput = listPanesLine(paneA)
    shell.worktreeByPath.set('/worktrees/a', '/worktrees/a')
    shell.captureByPane.set('%1', success('hello'))

    const first = await tmuxCollector.poll(tmuxCollector.initialSnapshot(), makeContext(shell.exec))
    expect(Object.keys(first.nextSnapshot.panes)).toEqual(['%1'])

    shell.listPanesOutput = ''
    const second = await tmuxCollector.poll(first.nextSnapshot, makeContext(shell.exec))

    expect(second.events).toHaveLength(1)
    expect(second.events[0]).toMatchObject({ type: 'pane.closed', payload: { paneId: '%1' } })
    expect(second.nextSnapshot.panes).toEqual({})
  })

  it('does NOT report a known pane closed when its own line is merely skipped this tick, and recovers it when the line parses again', async () => {
    const paneA: PaneFixture = {
      paneId: '%1',
      sessionName: 'obs',
      windowIndex: 0,
      windowName: 'wm-a',
      currentPath: '/worktrees/a',
      currentCommand: 'claude',
      title: 'A',
    }
    const paneB: PaneFixture = {
      paneId: '%2',
      sessionName: 'obs',
      windowIndex: 1,
      windowName: 'wm-b',
      currentPath: '/worktrees/b',
      currentCommand: 'claude',
      title: 'B',
    }
    shell.listPanesOutput = [listPanesLine(paneA), listPanesLine(paneB)].join('\n')
    shell.worktreeByPath.set('/worktrees/a', '/worktrees/a')
    shell.worktreeByPath.set('/worktrees/b', '/worktrees/b')
    shell.captureByPane.set('%1', success('hello'))
    shell.captureByPane.set('%2', success('world'))

    const first = await tmuxCollector.poll(tmuxCollector.initialSnapshot(), makeContext(shell.exec))
    expect(Object.keys(first.nextSnapshot.panes).sort()).toEqual(['%1', '%2'])

    // %2 gains a tab in its title, so its line splits into 8 fields and is
    // skipped — but %2 is still running. Its id (`%2`) survives as the line's
    // first field, so it must be carried forward, not declared closed.
    const paneBWithTab = '%2\tobs\t1\twm-b\t/worktrees/b\tclaude\tB\twith a tab'
    shell.listPanesOutput = [listPanesLine(paneA), paneBWithTab].join('\n')
    const second = await tmuxCollector.poll(first.nextSnapshot, makeContext(shell.exec))

    expect(second.events.some((e) => e.type === 'pane.closed')).toBe(false)
    expect(second.events.some((e) => e.type === 'collector.error')).toBe(true)
    expect(Object.keys(second.nextSnapshot.panes).sort()).toEqual(['%1', '%2'])
    // Carried forward unchanged — same snapshot the last good tick produced.
    expect(second.nextSnapshot.panes['%2']).toEqual(first.nextSnapshot.panes['%2'])

    // The tab clears: %2 parses again. It was never closed, so it is not
    // re-discovered, and with an unchanged hash there is no spurious activity.
    shell.listPanesOutput = [listPanesLine(paneA), listPanesLine(paneB)].join('\n')
    const third = await tmuxCollector.poll(second.nextSnapshot, makeContext(shell.exec))
    expect(third.events.some((e) => e.type === 'pane.discovered')).toBe(false)
    expect(third.events.some((e) => e.type === 'pane.closed')).toBe(false)
  })

  it('still reports a genuine closure on a tick that also skipped an unrelated line', async () => {
    const paneA: PaneFixture = {
      paneId: '%1',
      sessionName: 'obs',
      windowIndex: 0,
      windowName: 'wm-a',
      currentPath: '/worktrees/a',
      currentCommand: 'claude',
      title: 'A',
    }
    const paneB: PaneFixture = {
      paneId: '%2',
      sessionName: 'obs',
      windowIndex: 1,
      windowName: 'wm-b',
      currentPath: '/worktrees/b',
      currentCommand: 'claude',
      title: 'B',
    }
    shell.listPanesOutput = [listPanesLine(paneA), listPanesLine(paneB)].join('\n')
    shell.worktreeByPath.set('/worktrees/a', '/worktrees/a')
    shell.worktreeByPath.set('/worktrees/b', '/worktrees/b')
    shell.captureByPane.set('%1', success('hello'))
    shell.captureByPane.set('%2', success('world'))

    const first = await tmuxCollector.poll(tmuxCollector.initialSnapshot(), makeContext(shell.exec))
    expect(Object.keys(first.nextSnapshot.panes).sort()).toEqual(['%1', '%2'])

    // %1 genuinely disappears; a brand-new pane %3's line is skipped (a tab).
    // The skip is fully attributed (its id `%3` survives), so %1's absence is
    // a real closure and must still be reported — the fix is precise, not a
    // blanket "any skip suppresses all closures".
    const newPaneWithTab = '%3\tobs\t2\twm-c\t/worktrees/c\tclaude\tC\ttab here'
    shell.listPanesOutput = [listPanesLine(paneB), newPaneWithTab].join('\n')
    const second = await tmuxCollector.poll(first.nextSnapshot, makeContext(shell.exec))

    const closed = second.events.filter((e) => e.type === 'pane.closed')
    expect(closed).toHaveLength(1)
    expect(closed[0]).toMatchObject({ payload: { paneId: '%1' } })
    expect('%1' in second.nextSnapshot.panes).toBe(false)
  })

  it('holds every closure on a tick whose skip is too garbled to name its pane', async () => {
    const paneA: PaneFixture = {
      paneId: '%1',
      sessionName: 'obs',
      windowIndex: 0,
      windowName: 'wm-a',
      currentPath: '/worktrees/a',
      currentCommand: 'claude',
      title: 'A',
    }
    shell.listPanesOutput = listPanesLine(paneA)
    shell.worktreeByPath.set('/worktrees/a', '/worktrees/a')
    shell.captureByPane.set('%1', success('hello'))

    const first = await tmuxCollector.poll(tmuxCollector.initialSnapshot(), makeContext(shell.exec))
    expect(Object.keys(first.nextSnapshot.panes)).toEqual(['%1'])

    // A 7-field line with an empty pane id: skipped, and its own id is gone,
    // so we cannot know it was not %1's line arriving mangled. We must not
    // declare %1 closed on the strength of that; carry it forward instead.
    const idlessLine = '\tobs\t0\twm-a\t/worktrees/a\tclaude\tA'
    shell.listPanesOutput = idlessLine
    const second = await tmuxCollector.poll(first.nextSnapshot, makeContext(shell.exec))

    expect(second.events.some((e) => e.type === 'pane.closed')).toBe(false)
    expect(second.events.some((e) => e.type === 'collector.error')).toBe(true)
    expect(Object.keys(second.nextSnapshot.panes)).toEqual(['%1'])
  })

  it('caches worktree resolution per path and only shells out to git once per path', async () => {
    const paneA: PaneFixture = {
      paneId: '%1',
      sessionName: 'obs',
      windowIndex: 0,
      windowName: 'wm-a',
      currentPath: '/worktrees/a',
      currentCommand: 'claude',
      title: '',
    }
    shell.listPanesOutput = listPanesLine(paneA)
    shell.worktreeByPath.set('/worktrees/a', '/worktrees/a')
    shell.captureByPane.set('%1', success('hello'))

    await tmuxCollector.poll(tmuxCollector.initialSnapshot(), makeContext(shell.exec))
    expect(shell.gitCalls).toEqual(['/worktrees/a'])

    const snapshotAfterFirst = (await tmuxCollector.poll(tmuxCollector.initialSnapshot(), makeContext(shell.exec)))
      .nextSnapshot
    await tmuxCollector.poll(snapshotAfterFirst, makeContext(shell.exec))
    expect(shell.gitCalls).toEqual(['/worktrees/a', '/worktrees/a'])
  })

  it("a line list-panes can't parse is skipped and voiced, not thrown — other panes still process, and the collector stays enabled", async () => {
    const paneA: PaneFixture = {
      paneId: '%1',
      sessionName: 'obs',
      windowIndex: 0,
      windowName: 'wm-a',
      currentPath: '/worktrees/a',
      currentCommand: 'claude',
      title: '',
    }
    const paneB: PaneFixture = {
      paneId: '%2',
      sessionName: 'obs',
      windowIndex: 1,
      windowName: 'wm-b',
      currentPath: '/worktrees/b',
      currentCommand: 'claude',
      title: '',
    }
    // A tab embedded in pane_current_path splits into 8 fields instead of 7.
    const badLine = '%3\tobs\t2\twin-c\t/tmp/weird\tpath\tbash\ttitle'
    shell.listPanesOutput = [listPanesLine(paneA), badLine, listPanesLine(paneB)].join('\n')
    shell.worktreeByPath.set('/worktrees/a', '/worktrees/a')
    shell.worktreeByPath.set('/worktrees/b', '/worktrees/b')
    shell.captureByPane.set('%1', success('hello'))
    shell.captureByPane.set('%2', success('world'))

    const first = await tmuxCollector.poll(tmuxCollector.initialSnapshot(), makeContext(shell.exec))

    expect(first.nextSnapshot.disabled).toBe(false)
    const firstError = first.events.find((e) => e.type === 'collector.error')
    expect(firstError).toMatchObject({
      source: 'system',
      type: 'collector.error',
      payload: expect.objectContaining({
        collector: 'tmux',
        message: 'skipped 1 unparseable list-panes line',
      }),
    })
    expect(first.events.filter((e) => e.type === 'pane.discovered')).toHaveLength(2)
    expect(first.events.some((e) => e.type === 'collector.disabled')).toBe(false)

    // The identical bad line recurs on polls 2 and 3 — per-incident latching
    // (#506) means it voices only once, not on every poll it persists (the
    // pre-#506 shape this test used to assert, restated at greater strength
    // per AGENTS.md rather than weakened).
    const second = await tmuxCollector.poll(first.nextSnapshot, makeContext(shell.exec))
    expect(second.events.filter((e) => e.type === 'collector.error')).toHaveLength(0)
    expect(second.events.some((e) => e.type === 'collector.disabled' || e.type === 'collector.degraded')).toBe(false)
    expect(second.events.some((e) => e.type === 'pane.discovered')).toBe(false)

    const third = await tmuxCollector.poll(second.nextSnapshot, makeContext(shell.exec))
    expect(third.events.filter((e) => e.type === 'collector.error')).toHaveLength(0)
    expect(third.events.some((e) => e.type === 'collector.disabled' || e.type === 'collector.degraded')).toBe(false)
    expect(third.events.some((e) => e.type === 'pane.discovered')).toBe(false)
  })

  it('a list-panes skip re-arms silently on recovery, so a later recurrence voices again (#506)', async () => {
    const paneA: PaneFixture = {
      paneId: '%1',
      sessionName: 'obs',
      windowIndex: 0,
      windowName: 'wm-a',
      currentPath: '/worktrees/a',
      currentCommand: 'claude',
      title: '',
    }
    shell.worktreeByPath.set('/worktrees/a', '/worktrees/a')
    shell.captureByPane.set('%1', success('hello'))
    const badLine = '%3\tobs\t2\twin-c\t/tmp/weird\tpath\tbash\ttitle'
    const goodLine = '%3\tobs\t2\twin-c\t/tmp/weird\tbash\ttitle'

    shell.listPanesOutput = [listPanesLine(paneA), badLine].join('\n')
    const first = await tmuxCollector.poll(tmuxCollector.initialSnapshot(), makeContext(shell.exec))
    expect(first.events.filter((e) => e.type === 'collector.error')).toHaveLength(1)

    // The bad line parses fine this poll — latch clears silently, no error.
    shell.listPanesOutput = [listPanesLine(paneA), goodLine].join('\n')
    const second = await tmuxCollector.poll(first.nextSnapshot, makeContext(shell.exec))
    expect(second.events.filter((e) => e.type === 'collector.error')).toHaveLength(0)

    // The identical bad line recurs — a genuinely new incident, must voice again.
    shell.listPanesOutput = [listPanesLine(paneA), badLine].join('\n')
    const third = await tmuxCollector.poll(second.nextSnapshot, makeContext(shell.exec))
    expect(third.events.filter((e) => e.type === 'collector.error')).toHaveLength(1)
  })

  it('maps a pane outside any git worktree to a null worktreePath', async () => {
    const paneA: PaneFixture = {
      paneId: '%1',
      sessionName: 'obs',
      windowIndex: 0,
      windowName: 'bash',
      currentPath: '/tmp/scratch',
      currentCommand: 'bash',
      title: '',
    }
    shell.listPanesOutput = listPanesLine(paneA)
    shell.captureByPane.set('%1', success('hello'))
    // No entry in shell.worktreeByPath ⇒ `git rev-parse` reports "not a git repository".

    const result = await tmuxCollector.poll(tmuxCollector.initialSnapshot(), makeContext(shell.exec))
    const discovered = result.events.find((e) => e.type === 'pane.discovered')
    expect(discovered?.payload).toMatchObject({ worktreePath: null })
  })

  it('a failed worktree resolve calls git exactly once and resolves to null, not a cached failure (#505)', async () => {
    const paneA: PaneFixture = {
      paneId: '%1',
      sessionName: 'obs',
      windowIndex: 0,
      windowName: 'wm-a',
      currentPath: '/worktrees/flaky',
      currentCommand: 'claude',
      title: '',
    }
    shell.listPanesOutput = listPanesLine(paneA)
    shell.captureByPane.set('%1', success('hello'))
    // No entry in shell.worktreeByPath ⇒ `git rev-parse` fails.

    const result = await tmuxCollector.poll(tmuxCollector.initialSnapshot(), makeContext(shell.exec))

    expect(result.nextSnapshot.panes['%1']?.worktreePath).toBeNull()
    expect(shell.gitCalls).toEqual(['/worktrees/flaky'])
  })

  it('retries a failed worktree resolve on every later poll, and recovers once git succeeds (#505)', async () => {
    const paneA: PaneFixture = {
      paneId: '%1',
      sessionName: 'obs',
      windowIndex: 0,
      windowName: 'wm-a',
      currentPath: '/worktrees/flaky',
      currentCommand: 'claude',
      title: '',
    }
    shell.listPanesOutput = listPanesLine(paneA)
    shell.captureByPane.set('%1', success('hello'))
    // No entry in shell.worktreeByPath ⇒ first poll's `git rev-parse` fails.

    const first = await tmuxCollector.poll(tmuxCollector.initialSnapshot(), makeContext(shell.exec))
    expect(first.nextSnapshot.panes['%1']?.worktreePath).toBeNull()
    expect(shell.gitCalls).toEqual(['/worktrees/flaky'])

    // The transient condition clears between polls (e.g. the worktree was
    // recreated) — a permanently-cached `null` would never see this.
    shell.worktreeByPath.set('/worktrees/flaky', '/worktrees/flaky')
    const second = await tmuxCollector.poll(first.nextSnapshot, makeContext(shell.exec))

    expect(second.nextSnapshot.panes['%1']?.worktreePath).toBe('/worktrees/flaky')
    // Two calls total for the same path proves the failure was retried, not
    // served from a stale cache.
    expect(shell.gitCalls).toEqual(['/worktrees/flaky', '/worktrees/flaky'])
  })

  it('carries the previous content hash forward when capture-pane fails, and emits no activity event (regression, prd44 w2)', async () => {
    const paneA: PaneFixture = {
      paneId: '%1',
      sessionName: 'obs',
      windowIndex: 0,
      windowName: 'wm-a',
      currentPath: '/worktrees/a',
      currentCommand: 'claude',
      title: '',
    }
    shell.listPanesOutput = listPanesLine(paneA)
    shell.worktreeByPath.set('/worktrees/a', '/worktrees/a')
    shell.captureByPane.set('%1', success('hello'))

    const first = await tmuxCollector.poll(tmuxCollector.initialSnapshot(), makeContext(shell.exec))
    const firstHash = first.nextSnapshot.panes['%1']?.contentHash
    expect(firstHash).toBe(hashPaneContent('hello'))

    shell.captureByPane.set('%1', { stdout: '', stderr: 'lost pane', code: 1, failed: true })
    const second = await tmuxCollector.poll(first.nextSnapshot, makeContext(shell.exec))

    expect(second.nextSnapshot.panes['%1']?.contentHash).toBe(firstHash)
    expect(second.events.some((e) => e.type === 'pane.activity')).toBe(false)
    expect(second.events.some((e) => e.type === 'pane.closed')).toBe(false)
  })

  it('resolves a worktree path shared by several panes in the same poll exactly once, not once per pane (prd44 w2)', async () => {
    const shared = (paneId: string, windowIndex: number): PaneFixture => ({
      paneId,
      sessionName: 'obs',
      windowIndex,
      windowName: `wm-${paneId}`,
      currentPath: '/worktrees/shared',
      currentCommand: 'claude',
      title: '',
    })
    const panes = [shared('%1', 0), shared('%2', 1), shared('%3', 2)]
    shell.listPanesOutput = panes.map(listPanesLine).join('\n')
    shell.worktreeByPath.set('/worktrees/shared', '/worktrees/shared')
    for (const p of panes) shell.captureByPane.set(p.paneId, success(`content-${p.paneId}`))

    const result = await tmuxCollector.poll(tmuxCollector.initialSnapshot(), makeContext(shell.exec))

    // Concurrency must not turn one lookup into N: three panes, one path,
    // exactly one `git rev-parse` call.
    expect(shell.gitCalls).toEqual(['/worktrees/shared'])
    expect(result.nextSnapshot.panes['%1']?.worktreePath).toBe('/worktrees/shared')
    expect(result.nextSnapshot.panes['%2']?.worktreePath).toBe('/worktrees/shared')
    expect(result.nextSnapshot.panes['%3']?.worktreePath).toBe('/worktrees/shared')
  })

  it('keeps list-panes order in nextPanes and its events even when captures settle out of order (prd44 w2)', async () => {
    const paneA: PaneFixture = {
      paneId: '%1',
      sessionName: 'obs',
      windowIndex: 0,
      windowName: 'wm-a',
      currentPath: '/worktrees/a',
      currentCommand: 'claude',
      title: '',
    }
    const paneB: PaneFixture = { ...paneA, paneId: '%2', currentPath: '/worktrees/b' }
    shell.listPanesOutput = [listPanesLine(paneA), listPanesLine(paneB)].join('\n')
    shell.worktreeByPath.set('/worktrees/a', '/worktrees/a')
    shell.worktreeByPath.set('/worktrees/b', '/worktrees/b')

    const captureFinishOrder: string[] = []
    // %1 (listed first) yields a few extra microtask turns before resolving,
    // so %2 (listed second) settles first — proving the collector's output
    // order is `list-panes` order, not completion order.
    const outOfOrderExec: Exec = async (command, args) => {
      if (command === 'tmux' && args[0] === 'capture-pane') {
        const paneId = args.at(-1) ?? ''
        if (paneId === '%1') {
          await Promise.resolve()
          await Promise.resolve()
          await Promise.resolve()
        }
        captureFinishOrder.push(paneId)
        return success(paneId === '%1' ? 'hello' : 'world')
      }
      return shell.exec(command, args)
    }

    const result = await tmuxCollector.poll(tmuxCollector.initialSnapshot(), makeContext(outOfOrderExec))

    expect(captureFinishOrder).toEqual(['%2', '%1'])
    expect(Object.keys(result.nextSnapshot.panes)).toEqual(['%1', '%2'])
    const discoveredIds = result.events
      .filter((e) => e.type === 'pane.discovered')
      .map((e) => (e.payload as { paneId: string }).paneId)
    expect(discoveredIds).toEqual(['%1', '%2'])
    const activityIds = result.events
      .filter((e) => e.type === 'pane.activity')
      .map((e) => (e.payload as { paneId: string }).paneId)
    expect(activityIds).toEqual(['%1', '%2'])
  })

  it('runs capture-pane at most COLLECTOR_FANOUT_LIMIT panes concurrently (prd44 w2)', async () => {
    const PANE_COUNT = COLLECTOR_FANOUT_LIMIT * 2 + 2
    const panes = Array.from({ length: PANE_COUNT }, (_, i) => {
      const paneId = `%${i + 1}`
      return {
        paneId,
        sessionName: 'obs',
        windowIndex: i,
        windowName: `wm-${i}`,
        currentPath: `/worktrees/${i}`,
        currentCommand: 'claude',
        title: '',
      } satisfies PaneFixture
    })
    shell.listPanesOutput = panes.map(listPanesLine).join('\n')
    for (const p of panes) shell.worktreeByPath.set(p.currentPath, p.currentPath)

    let inFlight = 0
    let maxInFlight = 0
    const gatedExec: Exec = async (command, args) => {
      if (command === 'tmux' && args[0] === 'capture-pane') {
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        // Yield twice so every worker that can start this round actually
        // does, before any of them finish — otherwise a single-microtask
        // resolve could let the pool drain faster than it fills and the
        // ceiling would never be observed.
        await Promise.resolve()
        await Promise.resolve()
        const result = await shell.exec(command, args)
        inFlight -= 1
        return result
      }
      return shell.exec(command, args)
    }

    const result = await tmuxCollector.poll(tmuxCollector.initialSnapshot(), makeContext(gatedExec))

    expect(Object.keys(result.nextSnapshot.panes)).toHaveLength(PANE_COUNT)
    expect(maxInFlight).toBe(COLLECTOR_FANOUT_LIMIT)
  })
})
