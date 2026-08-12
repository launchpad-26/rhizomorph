import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createEvent, createIdFactory, type CollectorContext, type Exec, type ExecResult, type EventType, type PayloadOf } from '@rhizomorph/core'
import { describe, expect, it } from 'vitest'
import { createWorkmuxCollector, WORKMUX_CAPABILITIES } from './collector.js'

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

function fixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf8')
}

function ok(stdout: string): ExecResult {
  return { stdout, stderr: '', code: 0, failed: false }
}

function missingBinary(): ExecResult {
  return {
    stdout: '',
    stderr: '',
    code: null,
    failed: true,
    errorMessage: 'spawn workmux ENOENT',
  }
}

/** Routes `workmux status` / `workmux list` to canned results, in call order per command. */
function fakeExec(responses: { status: ExecResult[]; list?: ExecResult[] }): Exec {
  const status = [...responses.status]
  const list = [...(responses.list ?? [])]
  return async (command, args) => {
    expect(command).toBe('workmux')
    const subcommand = args[0]
    if (subcommand === 'status') return status.shift() ?? ok('No active agents\n')
    if (subcommand === 'list') return list.shift() ?? ok('BRANCH  AGE  AGENT  MUX  UNMERGED  PATH\n')
    throw new Error(`unexpected workmux subcommand: ${String(subcommand)}`)
  }
}

function makeContext(exec: Exec, now = 1000): CollectorContext {
  const nextId = createIdFactory('evt')
  return {
    repoPath: '/repo',
    now,
    exec,
    nextId,
    emit: <T extends EventType>(type: T, payload: PayloadOf<T>) =>
      createEvent(type, payload, { id: nextId(), ts: now }),
  }
}

describe('createWorkmuxCollector', () => {
  it('emits agent.status for every agent on first poll', async () => {
    const collector = createWorkmuxCollector()
    const context = makeContext(
      fakeExec({
        status: [ok(fixture('status-working.txt'))],
        list: [ok(fixture('list-working.txt'))],
      }),
    )

    const result = await collector.poll(collector.initialSnapshot(), context)

    expect(result.events).toHaveLength(6)
    const firstEvent = result.events[0]
    expect(firstEvent?.type).toBe('agent.status')
    expect(firstEvent?.payload).toEqual({
      handle: '2-core',
      status: 'working',
      branch: '2-core',
      worktreePath: '../2-core',
      elapsedSeconds: 12 * 60,
      detail: '⠐ Implement core event schema and reducer',
    })

    const workmuxSelf = result.events.find(
      (event) => event.type === 'agent.status' && event.payload.handle === '5-workmux-collector',
    )
    expect(workmuxSelf?.payload).toMatchObject({ worktreePath: '(here)' })

    // prd15's capability law: a collector claiming a signal `provided` must
    // have a path that actually emits it — this poll just proved `agent.status`
    // is exactly that path for `attention`.
    expect(WORKMUX_CAPABILITIES.attention).toEqual({ level: 'provided' })
    expect(result.events.every((event) => event.type === 'agent.status')).toBe(true)
  })

  it('does not re-emit when nothing changed, but does on a real status change', async () => {
    const collector = createWorkmuxCollector()
    const exec = fakeExec({
      status: [fixture('status-mixed.txt'), fixture('status-mixed.txt')].map(ok),
      list: [ok('BRANCH  AGE  AGENT  MUX  UNMERGED  PATH\n')],
    })
    const context = makeContext(exec)

    const first = await collector.poll(collector.initialSnapshot(), context)
    expect(first.events).toHaveLength(4)

    const second = await collector.poll(first.nextSnapshot, context)
    expect(second.events).toHaveLength(0)
  })

  it('emits collector.disabled once when the binary is missing, and stops shelling out', async () => {
    const collector = createWorkmuxCollector()
    let execCalls = 0
    const exec: Exec = async () => {
      execCalls += 1
      return missingBinary()
    }
    const context = makeContext(exec)

    const first = await collector.poll(collector.initialSnapshot(), context)
    expect(first.events).toEqual([
      expect.objectContaining({
        type: 'collector.disabled',
        payload: { collector: 'workmux', reason: 'spawn workmux ENOENT' },
      }),
    ])
    expect(execCalls).toBe(1)

    const second = await collector.poll(first.nextSnapshot, context)
    expect(second.events).toEqual([])
    expect(execCalls).toBe(1)
  })

  it('never crashes on an unrecognised status value, and reports it loudly', async () => {
    const collector = createWorkmuxCollector()
    const weirdStatus = 'WORKTREE             STATUS   ELAPSED  TITLE\nfeat-x               zombie   1m       stuck\n'
    const context = makeContext(
      fakeExec({
        status: [ok(weirdStatus)],
        list: [ok('BRANCH  AGE  AGENT  MUX  UNMERGED  PATH\n')],
      }),
    )

    const result = await collector.poll(collector.initialSnapshot(), context)

    expect(result.events).toHaveLength(1)
    expect(result.events[0]).toMatchObject({
      type: 'collector.error',
      payload: { collector: 'workmux' },
    })
    expect(result.nextSnapshot.agents).toEqual({})
  })

  it('degrades gracefully when list fails but status succeeds', async () => {
    const collector = createWorkmuxCollector()
    const context = makeContext(
      fakeExec({
        status: [ok(fixture('status-mixed.txt'))],
        list: [{ stdout: '', stderr: 'boom', code: 1, failed: true }],
      }),
    )

    const result = await collector.poll(collector.initialSnapshot(), context)

    expect(result.events).toHaveLength(4)
    expect(result.events[0]?.payload).toMatchObject({ branch: null, worktreePath: null })
  })

  it('joins on the worktree directory name, not the branch, so a slashed branch still resolves', async () => {
    const collector = createWorkmuxCollector()
    const statusText =
      'WORKTREE             STATUS   ELAPSED  TITLE\nfeat-foo             working  1m       fixing bug\n'
    const listText =
      'BRANCH    AGE  AGENT   MUX  UNMERGED  PATH\nfeat/foo  1m   claude  1    0         ../feat-foo\n'
    const context = makeContext(fakeExec({ status: [ok(statusText)], list: [ok(listText)] }))

    const result = await collector.poll(collector.initialSnapshot(), context)

    expect(result.events).toHaveLength(1)
    expect(result.events[0]?.payload).toMatchObject({
      handle: 'feat-foo',
      branch: 'feat/foo',
      worktreePath: '../feat-foo',
    })
  })

  it('resolves branch/worktreePath to null, not a crash, when no list row matches the handle', async () => {
    const collector = createWorkmuxCollector()
    const statusText = 'WORKTREE             STATUS   ELAPSED  TITLE\nghost-lane           working  1m       -\n'
    const context = makeContext(
      fakeExec({ status: [ok(statusText)], list: [ok('BRANCH  AGE  AGENT  MUX  UNMERGED  PATH\n')] }),
    )

    const result = await collector.poll(collector.initialSnapshot(), context)

    expect(result.events[0]?.payload).toMatchObject({ branch: null, worktreePath: null })
  })

  // --- ruling 3 (prd-22, #306): gone vs unchanged, in both directions -------

  it('direction 1 — a non-ENOENT status failure carries the roster forward instead of emptying it', async () => {
    const collector = createWorkmuxCollector()
    const exec = fakeExec({
      status: [
        ok(fixture('status-mixed.txt')),
        { stdout: '', stderr: 'workmux: session index corrupted', code: 1, failed: true },
      ],
      list: [ok('BRANCH  AGE  AGENT  MUX  UNMERGED  PATH\n')],
    })
    const context = makeContext(exec)

    const first = await collector.poll(collector.initialSnapshot(), context)
    expect(first.events).toHaveLength(4)

    const second = await collector.poll(first.nextSnapshot, context)
    expect(second.events).toEqual([
      expect.objectContaining({
        type: 'collector.disabled',
        payload: expect.objectContaining({
          collector: 'workmux',
          reason: expect.stringContaining('session index corrupted'),
        }),
      }),
    ])
    expect(second.nextSnapshot.agents).toEqual(first.nextSnapshot.agents)
    expect(second.nextSnapshot.disabled).toBe(true)
    expect(second.events.some((event) => event.type === 'agent.removed')).toBe(false)
  })

  it('direction 1 — repeated non-ENOENT failures keep carrying the same roster, never announcing a removal', async () => {
    const collector = createWorkmuxCollector()
    const failure = { stdout: '', stderr: 'workmux: session index corrupted', code: 1, failed: true }
    const exec = fakeExec({
      status: [ok(fixture('status-mixed.txt')), failure, failure],
      list: [ok('BRANCH  AGE  AGENT  MUX  UNMERGED  PATH\n')],
    })
    const context = makeContext(exec)

    const first = await collector.poll(collector.initialSnapshot(), context)
    // `withResilience` resets `disabled: false` on every attempt in production
    // (resilience.ts) — simulated here the same way the missing-binary test
    // above does not need to, since that path never sets `disabled` back.
    const second = await collector.poll({ ...first.nextSnapshot, disabled: false }, context)
    const third = await collector.poll({ ...second.nextSnapshot, disabled: false }, context)

    expect(second.nextSnapshot.agents).toEqual(first.nextSnapshot.agents)
    expect(third.nextSnapshot.agents).toEqual(first.nextSnapshot.agents)
    expect([...second.events, ...third.events].every((event) => event.type === 'collector.disabled')).toBe(true)
  })

  it('direction 2 — a handle that drops out of a successful poll is announced gone, once', async () => {
    const collector = createWorkmuxCollector()
    const exec = fakeExec({
      status: [ok(fixture('status-mixed.txt')), ok(fixture('status-mixed-no-git.txt'))],
      list: [ok(fixture('list-working.txt')), ok(fixture('list-working.txt'))],
    })
    const context = makeContext(exec)

    const first = await collector.poll(collector.initialSnapshot(), context)
    expect(Object.keys(first.nextSnapshot.agents)).toHaveLength(4)

    const second = await collector.poll(first.nextSnapshot, context)
    expect(second.events).toEqual([
      expect.objectContaining({ type: 'agent.removed', payload: { handle: '3-git-collector' } }),
    ])
    expect(Object.keys(second.nextSnapshot.agents).sort()).toEqual(
      ['2-core', '4-tmux-collector', '5-workmux-collector'].sort(),
    )
  })

  it('direction 2 — an already-gone handle is not re-announced on a later poll', async () => {
    const collector = createWorkmuxCollector()
    const exec = fakeExec({
      status: [
        ok(fixture('status-mixed.txt')),
        ok(fixture('status-mixed-no-git.txt')),
        ok(fixture('status-mixed-no-git.txt')),
      ],
      list: [ok(fixture('list-working.txt')), ok(fixture('list-working.txt')), ok(fixture('list-working.txt'))],
    })
    const context = makeContext(exec)

    const first = await collector.poll(collector.initialSnapshot(), context)
    const second = await collector.poll(first.nextSnapshot, context)
    expect(second.events).toHaveLength(1)

    const third = await collector.poll(second.nextSnapshot, context)
    expect(third.events).toEqual([])
  })

  it('a quarantined malformed row is not read as proof its handle is gone', async () => {
    const collector = createWorkmuxCollector()
    const zombieStatus =
      'WORKTREE             STATUS   ELAPSED  TITLE\n' +
      '2-core               working  12m      ⠂ Implement core event schema and reducer\n' +
      '3-git-collector      zombie   1m       stuck\n' +
      '4-tmux-collector     done     9m       ✓ tmux collector complete\n' +
      '5-workmux-collector  working  5m       ⠐ Implement workmux collector with status parsing\n'
    const exec = fakeExec({
      status: [ok(fixture('status-mixed.txt')), ok(zombieStatus)],
      list: [ok(fixture('list-working.txt')), ok(fixture('list-working.txt'))],
    })
    const context = makeContext(exec)

    const first = await collector.poll(collector.initialSnapshot(), context)
    const second = await collector.poll(first.nextSnapshot, context)

    expect(second.events).toHaveLength(1)
    expect(second.events[0]).toMatchObject({ type: 'collector.error', payload: { collector: 'workmux' } })
    expect(second.events.some((event) => event.type === 'agent.removed')).toBe(false)
    expect(second.nextSnapshot.agents['3-git-collector']).toEqual(first.nextSnapshot.agents['3-git-collector'])
  })
})
