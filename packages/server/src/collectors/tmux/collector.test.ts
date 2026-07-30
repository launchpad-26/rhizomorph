import type { CollectorContext, Exec, ExecResult } from '@observatory/core'
import { createEvent } from '@observatory/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { hashPaneContent } from './capture.js'
import { tmuxCollector } from './collector.js'

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
})
