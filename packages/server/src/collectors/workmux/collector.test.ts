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

/**
 * Routes `workmux status --json` / `workmux list --json` to canned results, in
 * call order per command. The full argv is asserted, not just the subcommand:
 * every canned response here is JSON, so a collector that stopped passing
 * `--json` would still be fed JSON by this fake and every test in the file
 * would stay green — while against a real workmux it would receive the table
 * form, fail to parse it, and disable itself on every poll (#383).
 */
function fakeExec(responses: { status: ExecResult[]; list?: ExecResult[] }): Exec {
  const status = [...responses.status]
  const list = [...(responses.list ?? [])]
  return async (command, args) => {
    expect(command).toBe('workmux')
    const subcommand = args[0]
    if (subcommand === 'status') {
      expect(args).toEqual(['status', '--json'])
      return status.shift() ?? ok('[]')
    }
    if (subcommand === 'list') {
      expect(args).toEqual(['list', '--json'])
      return list.shift() ?? ok('[]')
    }
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
        status: [ok(fixture('status-working.json'))],
        list: [ok(fixture('list-working.json'))],
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
      worktreePath: '/repo/../2-core',
      elapsedSeconds: 12 * 60,
      detail: '⠐ Implement core event schema and reducer',
    })

    const workmuxSelf = result.events.find(
      (event) => event.type === 'agent.status' && event.payload.handle === '5-workmux-collector',
    )
    // No more `(here)` sentinel under --json — the join resolves the self row
    // to its own absolute workdir, same as every other row.
    expect(workmuxSelf?.payload).toMatchObject({ worktreePath: '/repo' })

    // prd15's capability law: a collector claiming a signal `provided` must
    // have a path that actually emits it — this poll just proved `agent.status`
    // is exactly that path for `attention`.
    expect(WORKMUX_CAPABILITIES.attention).toEqual({ level: 'provided' })
    expect(result.events.every((event) => event.type === 'agent.status')).toBe(true)
  })

  it('does not re-emit when nothing changed, but does on a real status change', async () => {
    const collector = createWorkmuxCollector()
    const exec = fakeExec({
      status: [fixture('status-mixed.json'), fixture('status-mixed.json')].map(ok),
      list: [ok('[]')],
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
    const weirdStatus = JSON.stringify([
      { worktree: 'feat-x', branch: 'feat-x', status: 'zombie', elapsed_secs: 60, title: 'stuck', workdir: '/repo/../feat-x' },
    ])
    const context = makeContext(
      fakeExec({
        status: [ok(weirdStatus)],
        list: [ok('[]')],
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
        status: [ok(fixture('status-mixed.json'))],
        list: [{ stdout: '', stderr: 'boom', code: 1, failed: true }],
      }),
    )

    const result = await collector.poll(collector.initialSnapshot(), context)

    expect(result.events).toHaveLength(4)
    expect(result.events[0]?.payload).toMatchObject({ branch: null, worktreePath: null })
  })

  it('degrades gracefully when list --json returns unparseable output', async () => {
    const collector = createWorkmuxCollector()
    const context = makeContext(
      fakeExec({
        status: [ok(fixture('status-mixed.json'))],
        list: [ok('BRANCH  AGE  AGENT  MUX  UNMERGED  PATH\n')],
      }),
    )

    const result = await collector.poll(collector.initialSnapshot(), context)

    expect(result.events).toHaveLength(4)
    expect(result.events[0]?.payload).toMatchObject({ branch: null, worktreePath: null })
  })

  it('rides the disabled ladder, not a table-parse fallback, when status --json is unparseable (e.g. an older workmux)', async () => {
    const collector = createWorkmuxCollector()
    const context = makeContext(
      fakeExec({
        status: [ok('WORKTREE             STATUS   ELAPSED  TITLE\nfeat-foo             working  1m       fixing bug\n')],
        list: [ok('[]')],
      }),
    )

    const result = await collector.poll(collector.initialSnapshot(), context)

    expect(result.events).toEqual([
      expect.objectContaining({
        type: 'collector.disabled',
        payload: expect.objectContaining({ collector: 'workmux' }),
      }),
    ])
    expect(result.nextSnapshot.disabled).toBe(true)
  })

  it('joins on absolute path, not the branch, so a slashed branch still resolves', async () => {
    const collector = createWorkmuxCollector()
    const statusJson = JSON.stringify([
      { worktree: 'feat-foo', branch: 'feat/foo', status: 'working', elapsed_secs: 60, title: 'fixing bug', workdir: '/repo/../feat-foo' },
    ])
    const listJson = JSON.stringify([{ handle: 'feat-foo', branch: 'feat/foo', path: '/repo/../feat-foo', is_main: false }])
    const context = makeContext(fakeExec({ status: [ok(statusJson)], list: [ok(listJson)] }))

    const result = await collector.poll(collector.initialSnapshot(), context)

    expect(result.events).toHaveLength(1)
    expect(result.events[0]?.payload).toMatchObject({
      handle: 'feat-foo',
      branch: 'feat/foo',
      worktreePath: '/repo/../feat-foo',
    })
  })

  it('resolves branch/worktreePath to null, not a crash, when no list row matches the handle', async () => {
    const collector = createWorkmuxCollector()
    const statusJson = JSON.stringify([
      { worktree: 'ghost-lane', branch: 'ghost-lane', status: 'working', elapsed_secs: 60, title: null, workdir: '/repo/../ghost-lane' },
    ])
    const context = makeContext(fakeExec({ status: [ok(statusJson)], list: [ok('[]')] }))

    const result = await collector.poll(collector.initialSnapshot(), context)

    expect(result.events[0]?.payload).toMatchObject({ branch: null, worktreePath: null })
  })

  it('two worktrees sharing a basename under different parents both keep their own branch/worktreePath (#383)', async () => {
    const collector = createWorkmuxCollector()
    // workmux's own `list --json` can hand back duplicate `handle`s for two
    // worktrees that share a basename under different parents (confirmed
    // against 0.1.233 — that field is derived from the basename and workmux
    // does not dedupe it). This collector never reads `list.handle` at all;
    // it joins purely on the absolute `path`/`workdir`, so a basename
    // collision on the `list` side cannot bleed into the resolved agents.
    const statusJson = JSON.stringify([
      { worktree: 'bar-a', branch: 'bar-a', status: 'working', elapsed_secs: 60, title: null, workdir: '/parent-a/bar' },
      { worktree: 'bar-b', branch: 'bar-b', status: 'working', elapsed_secs: 90, title: null, workdir: '/parent-b/bar' },
    ])
    const listJson = JSON.stringify([
      { handle: 'bar', branch: 'a-bar', path: '/parent-a/bar', is_main: false },
      { handle: 'bar', branch: 'b-bar', path: '/parent-b/bar', is_main: false },
    ])
    const context = makeContext(fakeExec({ status: [ok(statusJson)], list: [ok(listJson)] }))

    const result = await collector.poll(collector.initialSnapshot(), context)

    expect(result.events).toHaveLength(2)
    const statusEvents = result.events.filter((event) => event.type === 'agent.status')
    const byHandle = Object.fromEntries(statusEvents.map((event) => [event.payload.handle, event.payload]))
    expect(byHandle['bar-a']).toMatchObject({ branch: 'a-bar', worktreePath: '/parent-a/bar' })
    expect(byHandle['bar-b']).toMatchObject({ branch: 'b-bar', worktreePath: '/parent-b/bar' })
  })

  it('resolves the main worktree row, which the old basename join broke (#383)', async () => {
    const collector = createWorkmuxCollector()
    // Reproduces the live failure the #383 verifier found on 0.1.233: the
    // table form's `status` row for the main worktree is suffixed ` (main)`,
    // which never matches `basename(list.path)`. `--json`'s `worktree` field
    // is clean and both sides carry the same absolute path, so this now joins.
    const statusJson = JSON.stringify([
      { worktree: 'myproj', branch: 'main', status: 'working', elapsed_secs: 60, title: null, workdir: '/Users/dev/myproj' },
    ])
    const listJson = JSON.stringify([{ handle: 'myproj', branch: 'main', path: '/Users/dev/myproj', is_main: true }])
    const context = makeContext(fakeExec({ status: [ok(statusJson)], list: [ok(listJson)] }))

    const result = await collector.poll(collector.initialSnapshot(), context)

    expect(result.events).toHaveLength(1)
    expect(result.events[0]?.payload).toMatchObject({
      handle: 'myproj',
      branch: 'main',
      worktreePath: '/Users/dev/myproj',
    })
  })

  // --- ruling 3 (prd-22, #306): gone vs unchanged, in both directions -------

  it('direction 1 — a non-ENOENT status failure carries the roster forward instead of emptying it', async () => {
    const collector = createWorkmuxCollector()
    const exec = fakeExec({
      status: [
        ok(fixture('status-mixed.json')),
        { stdout: '', stderr: 'workmux: session index corrupted', code: 1, failed: true },
      ],
      list: [ok('[]')],
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
      status: [ok(fixture('status-mixed.json')), failure, failure],
      list: [ok('[]')],
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
      status: [ok(fixture('status-mixed.json')), ok(fixture('status-mixed-no-git.json'))],
      list: [ok(fixture('list-working.json')), ok(fixture('list-working.json'))],
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
        ok(fixture('status-mixed.json')),
        ok(fixture('status-mixed-no-git.json')),
        ok(fixture('status-mixed-no-git.json')),
      ],
      list: [ok(fixture('list-working.json')), ok(fixture('list-working.json')), ok(fixture('list-working.json'))],
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
    const zombieStatus = JSON.stringify([
      { worktree: '2-core', branch: '2-core', status: 'working', elapsed_secs: 720, title: 'Implement core event schema and reducer', workdir: '/repo/../2-core' },
      { worktree: '3-git-collector', branch: '3-git-collector', status: 'zombie', elapsed_secs: 60, title: 'stuck', workdir: '/repo/../3-git-collector' },
      { worktree: '4-tmux-collector', branch: '4-tmux-collector', status: 'done', elapsed_secs: 540, title: 'tmux collector complete', workdir: '/repo/../4-tmux-collector' },
      { worktree: '5-workmux-collector', branch: '5-workmux-collector', status: 'working', elapsed_secs: 300, title: 'Implement workmux collector with status parsing', workdir: '/repo' },
    ])
    const exec = fakeExec({
      status: [ok(fixture('status-mixed.json')), ok(zombieStatus)],
      list: [ok(fixture('list-working.json')), ok(fixture('list-working.json'))],
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
