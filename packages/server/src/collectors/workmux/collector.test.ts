import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createEvent, createIdFactory, type CollectorContext, type Exec, type ExecResult, type EventType, type PayloadOf } from '@rhizomorph/core'
import { describe, expect, it } from 'vitest'
import { createWorkmuxCollector, WORKMUX_CAPABILITIES } from './collector.js'
import { MAX_VOICE_LENGTH } from '../parse-skip.js'

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
 *
 * An optional `git` queue answers `resolveWorktreePath`'s
 * `git -C <path> rev-parse --show-toplevel` (#463). It is separate from the
 * `workmux` queues and throws when exhausted — a test whose scenario should
 * never call git (or should call it only once, per the memoisation ruling)
 * fails loudly on an unexpected/extra call instead of silently degrading.
 */
function fakeExec(responses: { status: ExecResult[]; list?: ExecResult[]; git?: ExecResult[] }): Exec {
  const status = [...responses.status]
  const list = [...(responses.list ?? [])]
  const git = [...(responses.git ?? [])]
  return async (command, args) => {
    if (command === 'git') {
      const next = git.shift()
      if (!next) throw new Error('unexpected git call — fakeExec git queue exhausted')
      return next
    }
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
      worktreePath: '/Users/dev/rhizomorph__worktrees/2-core',
      elapsedSeconds: 12 * 60,
      detail: '⠐ Implement core event schema and reducer',
    })

    const workmuxSelf = result.events.find(
      (event) => event.type === 'agent.status' && event.payload.handle === '5-workmux-collector',
    )
    // No more `(here)` sentinel under --json — the join resolves the self row
    // to its own absolute workdir, same as every other row.
    expect(workmuxSelf?.payload).toMatchObject({ worktreePath: '/Users/dev/rhizomorph' })

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
    expect(result.events[0]?.payload).toMatchObject({ branch: '2-core', worktreePath: null })
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
    expect(result.events[0]?.payload).toMatchObject({ branch: '2-core', worktreePath: null })
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

  it('resolves branch from the status row directly, not a matching list row, even when they disagree (#455)', async () => {
    const collector = createWorkmuxCollector()
    // Real workmux never disagrees like this — the point is to prove `branch`
    // comes from `status.branch` alone. A collector that silently preferred
    // `list.branch` whenever the path join hits would resolve
    // 'stale-list-branch' here instead of the status row's own value.
    const statusJson = JSON.stringify([
      { worktree: 'feat-foo', branch: 'feat-foo', status: 'working', elapsed_secs: 60, title: null, workdir: '/Users/dev/proj__worktrees/feat-foo' },
    ])
    const listJson = JSON.stringify([
      { handle: 'feat-foo', branch: 'stale-list-branch', path: '/Users/dev/proj__worktrees/feat-foo', is_main: false },
    ])
    const context = makeContext(fakeExec({ status: [ok(statusJson)], list: [ok(listJson)] }))

    const result = await collector.poll(collector.initialSnapshot(), context)

    expect(result.events[0]?.payload).toMatchObject({
      branch: 'feat-foo',
      worktreePath: '/Users/dev/proj__worktrees/feat-foo',
    })
  })

  it('resolves branch from status.branch when workdir sits in a subdirectory of the matching list path, not the path join (#455)', async () => {
    const collector = createWorkmuxCollector()
    // Shaped like real 0.1.233 `--json` output: normalised absolute paths,
    // real field names. `workdir` is the pane's live cwd — a pane that `cd`s
    // into a subdirectory of its worktree (probed in #383's re-verify:
    // `<worktree>/packages/server`) makes the exact-path join against
    // `list.path` miss, even though `status.branch` on the same row is fine.
    const statusJson = JSON.stringify([
      {
        worktree: '455-branch-from-status',
        branch: '455-branch-from-status',
        status: 'working',
        elapsed_secs: 60,
        title: null,
        workdir: '/Users/operator/Projects/rhizomorph__worktrees/455-branch-from-status/packages/server',
      },
    ])
    const listJson = JSON.stringify([
      {
        handle: '455-branch-from-status',
        branch: '455-branch-from-status',
        path: '/Users/operator/Projects/rhizomorph__worktrees/455-branch-from-status',
        is_main: false,
      },
    ])
    const context = makeContext(
      fakeExec({
        status: [ok(statusJson)],
        list: [ok(listJson)],
        // #463: this exact scenario (a healthy `list` join missing on a
        // subdirectory workdir) now resolves `worktreePath` via git instead
        // of soft-nulling — see the dedicated #463 tests below for the
        // resolution/memoisation behaviour itself; this test's own job stays
        // proving `branch` comes from `status.branch`, independent of it.
        git: [ok('/Users/operator/Projects/rhizomorph__worktrees/455-branch-from-status\n')],
      }),
    )

    const result = await collector.poll(collector.initialSnapshot(), context)

    expect(result.events).toHaveLength(1)
    expect(result.events[0]?.payload).toMatchObject({
      handle: '455-branch-from-status',
      branch: '455-branch-from-status',
      worktreePath: '/Users/operator/Projects/rhizomorph__worktrees/455-branch-from-status',
    })
  })

  it('resolves worktreePath via git on a first-sight subdirectory pane, not a soft null (#463)', async () => {
    const collector = createWorkmuxCollector()
    const statusJson = JSON.stringify([
      {
        worktree: '463-first-sight',
        branch: '463-first-sight',
        status: 'working',
        elapsed_secs: 60,
        title: null,
        workdir: '/Users/operator/Projects/rhizomorph__worktrees/463-first-sight/packages/server',
      },
    ])
    const listJson = JSON.stringify([
      {
        handle: '463-first-sight',
        branch: '463-first-sight',
        path: '/Users/operator/Projects/rhizomorph__worktrees/463-first-sight',
        is_main: false,
      },
    ])
    const context = makeContext(
      fakeExec({
        status: [ok(statusJson)],
        list: [ok(listJson)],
        git: [ok('/Users/operator/Projects/rhizomorph__worktrees/463-first-sight\n')],
      }),
    )

    // No prior snapshot value — this is the pane's very first poll, so there
    // is nothing to carry forward and the join miss can only be closed by
    // asking git directly.
    const result = await collector.poll(collector.initialSnapshot(), context)

    expect(result.events).toHaveLength(1)
    expect(result.events[0]?.payload).toMatchObject({
      handle: '463-first-sight',
      branch: '463-first-sight',
      worktreePath: '/Users/operator/Projects/rhizomorph__worktrees/463-first-sight',
    })
  })

  it('memoises the git resolution across polls for the same subdirectory workdir (#463)', async () => {
    const collector = createWorkmuxCollector()
    const workdir = '/Users/operator/Projects/rhizomorph__worktrees/463-memo/packages/server'
    const worktreePath = '/Users/operator/Projects/rhizomorph__worktrees/463-memo'
    const statusJson = JSON.stringify([
      { worktree: '463-memo', branch: '463-memo', status: 'working', elapsed_secs: 60, title: null, workdir },
    ])
    const listJson = JSON.stringify([{ handle: '463-memo', branch: '463-memo', path: worktreePath, is_main: false }])
    const context = makeContext(
      fakeExec({
        status: [ok(statusJson), ok(statusJson)],
        list: [ok(listJson), ok(listJson)],
        // Exactly one git response queued — a second call throws (see
        // fakeExec's doc comment), which is what makes this test prove
        // memoisation rather than just asserting the happy path twice.
        git: [ok(`${worktreePath}\n`)],
      }),
    )

    const first = await collector.poll(collector.initialSnapshot(), context)
    expect(first.events[0]?.payload).toMatchObject({ worktreePath })

    const second = await collector.poll(first.nextSnapshot, context)
    // Nothing changed since the first poll, so no new event — but reaching
    // here at all (without fakeExec's git queue throwing) is the point: the
    // second poll must reuse the cached resolution, not call git again.
    expect(second.events).toHaveLength(0)
  })

  it('a failed git resolve calls git exactly once and resolves to null, not a cached failure (#505)', async () => {
    const collector = createWorkmuxCollector()
    const workdir = '/Users/operator/Projects/rhizomorph__worktrees/505-flaky/packages/server'
    const worktreePath = '/Users/operator/Projects/rhizomorph__worktrees/505-flaky'
    const statusJson = JSON.stringify([
      { worktree: '505-flaky', branch: '505-flaky', status: 'working', elapsed_secs: 60, title: null, workdir },
    ])
    const listJson = JSON.stringify([{ handle: '505-flaky', branch: '505-flaky', path: worktreePath, is_main: false }])
    const context = makeContext(
      fakeExec({
        status: [ok(statusJson)],
        list: [ok(listJson)],
        // Exactly one failing response — proves the resolve was attempted
        // and failed, rather than the git queue simply being empty.
        git: [{ stdout: '', stderr: 'fatal: not a git repository', code: 128, failed: true }],
      }),
    )

    const result = await collector.poll(collector.initialSnapshot(), context)

    expect(result.events[0]?.payload).toMatchObject({ worktreePath: null })
  })

  it('retries a failed git resolve on every later poll, and recovers once git succeeds (#505)', async () => {
    const collector = createWorkmuxCollector()
    const workdir = '/Users/operator/Projects/rhizomorph__worktrees/505-recover/packages/server'
    const worktreePath = '/Users/operator/Projects/rhizomorph__worktrees/505-recover'
    const statusJson = JSON.stringify([
      { worktree: '505-recover', branch: '505-recover', status: 'working', elapsed_secs: 60, title: null, workdir },
    ])
    const listJson = JSON.stringify([{ handle: '505-recover', branch: '505-recover', path: worktreePath, is_main: false }])
    const context = makeContext(
      fakeExec({
        status: [ok(statusJson), ok(statusJson)],
        list: [ok(listJson), ok(listJson)],
        // First git call fails (transient); the second, on the retry, succeeds.
        // A permanently-cached `null` would never reach the second entry.
        git: [{ stdout: '', stderr: 'fatal: not a git repository', code: 128, failed: true }, ok(`${worktreePath}\n`)],
      }),
    )

    const first = await collector.poll(collector.initialSnapshot(), context)
    expect(first.events[0]?.payload).toMatchObject({ worktreePath: null })

    const second = await collector.poll(first.nextSnapshot, context)
    // A null → real-path change is itself a "changed" transition, so a fresh
    // agent.status fires with the recovered worktreePath.
    expect(second.events[0]?.payload).toMatchObject({ worktreePath })
  })

  it('resolves branch/worktreePath to null, not a crash, when no list row matches the handle', async () => {
    const collector = createWorkmuxCollector()
    const statusJson = JSON.stringify([
      { worktree: 'ghost-lane', branch: 'ghost-lane', status: 'working', elapsed_secs: 60, title: null, workdir: '/repo/../ghost-lane' },
    ])
    const context = makeContext(fakeExec({ status: [ok(statusJson)], list: [ok('[]')] }))

    const result = await collector.poll(collector.initialSnapshot(), context)

    expect(result.events[0]?.payload).toMatchObject({ branch: 'ghost-lane', worktreePath: null })
  })

  it('two worktrees sharing a basename under different parents both keep their own branch/worktreePath (#383)', async () => {
    const collector = createWorkmuxCollector()
    // workmux's own `list --json` can hand back duplicate `handle`s for two
    // worktrees that share a basename under different parents (confirmed
    // against 0.1.233 — that field is derived from the basename and workmux
    // does not dedupe it). This collector never reads `list.handle` at all;
    // it joins purely on the absolute `path`/`workdir` to resolve
    // `worktreePath`, so a basename collision on the `list` side cannot bleed
    // into the resolved agents. `branch` comes from each row's own
    // `status.branch` (#455) — the list rows' `branch` values are
    // deliberately different (`a-bar`/`b-bar`) to prove that.
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
    expect(byHandle['bar-a']).toMatchObject({ branch: 'bar-a', worktreePath: '/parent-a/bar' })
    expect(byHandle['bar-b']).toMatchObject({ branch: 'bar-b', worktreePath: '/parent-b/bar' })
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
      { worktree: '2-core', branch: '2-core', status: 'working', elapsed_secs: 720, title: 'Implement core event schema and reducer', workdir: '/Users/dev/rhizomorph__worktrees/2-core' },
      { worktree: '3-git-collector', branch: '3-git-collector', status: 'zombie', elapsed_secs: 60, title: 'stuck', workdir: '/Users/dev/rhizomorph__worktrees/3-git-collector' },
      { worktree: '4-tmux-collector', branch: '4-tmux-collector', status: 'done', elapsed_secs: 540, title: 'tmux collector complete', workdir: '/Users/dev/rhizomorph__worktrees/4-tmux-collector' },
      { worktree: '5-workmux-collector', branch: '5-workmux-collector', status: 'working', elapsed_secs: 300, title: 'Implement workmux collector with status parsing', workdir: '/Users/dev/rhizomorph' },
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

  // --- #456: a malformed status/list row quarantines, mirroring ruling 4 ---

  it('quarantines a structurally malformed status row instead of disabling the whole poll (#456)', async () => {
    const collector = createWorkmuxCollector()
    const statusJson = JSON.stringify([
      {
        worktree: 'feat-good',
        branch: 'feat-good',
        status: 'working',
        elapsed_secs: 60,
        title: null,
        workdir: '/Users/dev/proj__worktrees/feat-good',
      },
      // No `worktree`, no `workdir` — cannot even be identified by handle.
      { branch: 'feat-bad', status: 'working', elapsed_secs: 60, title: null },
    ])
    const listJson = JSON.stringify([{ path: '/Users/dev/proj__worktrees/feat-good' }])
    const context = makeContext(fakeExec({ status: [ok(statusJson)], list: [ok(listJson)] }))

    const result = await collector.poll(collector.initialSnapshot(), context)

    const statusEvents = result.events.filter((event) => event.type === 'agent.status')
    expect(statusEvents).toHaveLength(1)
    expect(statusEvents[0]?.payload).toMatchObject({ handle: 'feat-good', branch: 'feat-good' })
    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: 'collector.error',
        payload: expect.objectContaining({
          collector: 'workmux',
          message: 'skipped 1 malformed status row',
          detail: expect.stringContaining('missing required worktree/status/workdir'),
        }),
      }),
    )
    // The whole poll must not disable — only the one bad row quarantines.
    expect(result.nextSnapshot.disabled).toBe(false)
  })

  it('a malformed status row with a recoverable handle carries its prior agent forward, not a removal (#456)', async () => {
    const collector = createWorkmuxCollector()
    const good = JSON.stringify([
      {
        worktree: 'flaky',
        branch: 'flaky',
        status: 'working',
        elapsed_secs: 60,
        title: null,
        workdir: '/Users/dev/proj__worktrees/flaky',
      },
    ])
    // Same handle recoverable (`worktree` present), but `workdir` missing
    // this poll — a genuinely malformed row, not just an unrecognised status
    // value, so it exercises parseStatusJson's own carry-forward path.
    const malformed = JSON.stringify([{ worktree: 'flaky', branch: 'flaky', status: 'working' }])
    const context = makeContext(fakeExec({ status: [ok(good), ok(malformed)], list: [ok('[]'), ok('[]')] }))

    const first = await collector.poll(collector.initialSnapshot(), context)
    const second = await collector.poll(first.nextSnapshot, context)

    expect(second.events.some((event) => event.type === 'agent.removed')).toBe(false)
    expect(second.nextSnapshot.agents.flaky).toEqual(first.nextSnapshot.agents.flaky)
  })

  it('quarantines a malformed list row and voices it, rather than dropping it silently (#456)', async () => {
    const collector = createWorkmuxCollector()
    const statusJson = JSON.stringify([
      {
        worktree: 'feat-x',
        branch: 'feat-x',
        status: 'working',
        elapsed_secs: 60,
        title: null,
        workdir: '/Users/dev/proj__worktrees/feat-x',
      },
    ])
    const listJson = JSON.stringify([{ is_main: false }]) // no `path`
    const context = makeContext(fakeExec({ status: [ok(statusJson)], list: [ok(listJson)] }))

    const result = await collector.poll(collector.initialSnapshot(), context)

    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: 'collector.error',
        payload: expect.objectContaining({
          collector: 'workmux',
          message: 'skipped 1 malformed list row',
          detail: expect.stringContaining('missing required path string field'),
        }),
      }),
    )
    expect(result.events.find((event) => event.type === 'agent.status')?.payload).toMatchObject({
      handle: 'feat-x',
      worktreePath: null,
    })
  })

  // --- #456 follow-up: a handle-less skip cannot attribute an `agent.removed` ---

  it('a handle-less skip does not announce a removal, and the lane re-appears with no flap (#456)', async () => {
    const collector = createWorkmuxCollector()
    const goodPoll = JSON.stringify([
      {
        worktree: 'feat-good',
        branch: 'feat-good',
        status: 'working',
        elapsed_secs: 60,
        title: null,
        workdir: '/Users/dev/proj__worktrees/feat-good',
      },
      {
        worktree: 'feat-other',
        branch: 'feat-other',
        status: 'working',
        elapsed_secs: 60,
        title: null,
        workdir: '/Users/dev/proj__worktrees/feat-other',
      },
    ])
    // Poll 2: `feat-good`'s row loses its `worktree` field entirely — cannot
    // be attributed to any handle — while `feat-other` stays healthy.
    const malformedPoll = JSON.stringify([
      { branch: 'feat-good', status: 'working', elapsed_secs: 60, title: null, workdir: '/Users/dev/proj__worktrees/feat-good' },
      {
        worktree: 'feat-other',
        branch: 'feat-other',
        status: 'working',
        elapsed_secs: 60,
        title: null,
        workdir: '/Users/dev/proj__worktrees/feat-other',
      },
    ])
    const context = makeContext(
      fakeExec({
        status: [ok(goodPoll), ok(malformedPoll), ok(goodPoll)],
        list: [ok('[]'), ok('[]'), ok('[]')],
      }),
    )

    const first = await collector.poll(collector.initialSnapshot(), context)
    expect(Object.keys(first.nextSnapshot.agents).sort()).toEqual(['feat-good', 'feat-other'])

    const second = await collector.poll(first.nextSnapshot, context)
    expect(second.events).toEqual([expect.objectContaining({ type: 'collector.error' })])
    expect(second.events.some((event) => event.type === 'agent.removed')).toBe(false)
    expect(second.nextSnapshot.agents['feat-good']).toEqual(first.nextSnapshot.agents['feat-good'])

    const third = await collector.poll(second.nextSnapshot, context)
    // The lane never left the roster, so its re-appearance is not news.
    expect(third.events).toEqual([])
  })

  it('every status row losing `worktree` in one poll carries the whole roster forward, not a wipe (#456)', async () => {
    const collector = createWorkmuxCollector()
    const goodPoll = JSON.stringify([
      {
        worktree: 'feat-a',
        branch: 'feat-a',
        status: 'working',
        elapsed_secs: 60,
        title: null,
        workdir: '/Users/dev/proj__worktrees/feat-a',
      },
      {
        worktree: 'feat-b',
        branch: 'feat-b',
        status: 'working',
        elapsed_secs: 60,
        title: null,
        workdir: '/Users/dev/proj__worktrees/feat-b',
      },
    ])
    // A format change (workmux renaming the field, per ruling 4) drops
    // `worktree` from every row in the same poll.
    const massMalformedPoll = JSON.stringify([
      { branch: 'feat-a', status: 'working', elapsed_secs: 60, title: null, workdir: '/Users/dev/proj__worktrees/feat-a' },
      { branch: 'feat-b', status: 'working', elapsed_secs: 60, title: null, workdir: '/Users/dev/proj__worktrees/feat-b' },
    ])
    const context = makeContext(
      fakeExec({ status: [ok(goodPoll), ok(massMalformedPoll)], list: [ok('[]'), ok('[]')] }),
    )

    const first = await collector.poll(collector.initialSnapshot(), context)
    const second = await collector.poll(first.nextSnapshot, context)

    expect(second.events).toEqual([
      expect.objectContaining({
        type: 'collector.error',
        payload: expect.objectContaining({ message: 'skipped 2 malformed status rows' }),
      }),
    ])
    expect(second.events.some((event) => event.type === 'agent.removed')).toBe(false)
    expect(second.nextSnapshot.agents).toEqual(first.nextSnapshot.agents)
  })

  // --- #506: per-incident latching — a persistently-malformed row voices once, not every poll ---

  it('a malformed status row voices once, stays silent while it recurs, and re-voices after recovering and recurring (#506)', async () => {
    const collector = createWorkmuxCollector()
    const malformed = JSON.stringify([{ worktree: 'flaky-row', branch: 'flaky-row', status: 'working' }]) // no `workdir`
    const recovered = JSON.stringify([
      { worktree: 'flaky-row', branch: 'flaky-row', status: 'working', elapsed_secs: 60, title: null, workdir: '/repo/../flaky-row' },
    ])
    const context = makeContext(
      fakeExec({
        status: [ok(malformed), ok(malformed), ok(recovered), ok(malformed)],
        list: [ok('[]'), ok('[]'), ok('[]'), ok('[]')],
      }),
    )

    const first = await collector.poll(collector.initialSnapshot(), context)
    expect(first.events.filter((e) => e.type === 'collector.error')).toHaveLength(1)

    const second = await collector.poll(first.nextSnapshot, context)
    expect(second.events.filter((e) => e.type === 'collector.error')).toHaveLength(0)

    // The row parses fine this poll — the latch clears silently.
    const third = await collector.poll(second.nextSnapshot, context)
    expect(third.events.filter((e) => e.type === 'collector.error')).toHaveLength(0)

    // Identical malformed row recurs — a genuinely new incident, must voice again.
    const fourth = await collector.poll(third.nextSnapshot, context)
    expect(fourth.events.filter((e) => e.type === 'collector.error')).toHaveLength(1)
  })

  it('a malformed list row voices once, stays silent while it recurs, and re-voices after recovering and recurring (#506)', async () => {
    const collector = createWorkmuxCollector()
    const statusJson = JSON.stringify([
      { worktree: 'feat-x', branch: 'feat-x', status: 'working', elapsed_secs: 60, title: null, workdir: '/repo/../feat-x' },
    ])
    const malformedList = JSON.stringify([{ is_main: false }]) // no `path`
    const goodList = JSON.stringify([{ path: '/repo/../feat-x' }])
    const context = makeContext(
      fakeExec({
        status: [ok(statusJson), ok(statusJson), ok(statusJson), ok(statusJson)],
        list: [ok(malformedList), ok(malformedList), ok(goodList), ok(malformedList)],
      }),
    )

    const first = await collector.poll(collector.initialSnapshot(), context)
    expect(first.events.filter((e) => e.type === 'collector.error')).toHaveLength(1)

    const second = await collector.poll(first.nextSnapshot, context)
    expect(second.events.filter((e) => e.type === 'collector.error')).toHaveLength(0)

    const third = await collector.poll(second.nextSnapshot, context)
    expect(third.events.filter((e) => e.type === 'collector.error')).toHaveLength(0)

    const fourth = await collector.poll(third.nextSnapshot, context)
    expect(fourth.events.filter((e) => e.type === 'collector.error')).toHaveLength(1)
  })

  it('an unrecognised agent.status value voices once, stays silent while it recurs, and re-voices after recovering and recurring (#506)', async () => {
    const collector = createWorkmuxCollector()
    const bad = JSON.stringify([
      { worktree: 'stuck-row', branch: 'stuck-row', status: 'zombie', elapsed_secs: 60, title: 'stuck', workdir: '/repo/../stuck-row' },
    ])
    const good = JSON.stringify([
      { worktree: 'stuck-row', branch: 'stuck-row', status: 'working', elapsed_secs: 60, title: 'stuck', workdir: '/repo/../stuck-row' },
    ])
    const context = makeContext(
      fakeExec({
        status: [ok(bad), ok(bad), ok(good), ok(bad)],
        list: [ok('[]'), ok('[]'), ok('[]'), ok('[]')],
      }),
    )

    const first = await collector.poll(collector.initialSnapshot(), context)
    expect(first.events.filter((e) => e.type === 'collector.error')).toHaveLength(1)

    const second = await collector.poll(first.nextSnapshot, context)
    expect(second.events.filter((e) => e.type === 'collector.error')).toHaveLength(0)

    // The status value parses fine this poll — the latch clears silently.
    const third = await collector.poll(second.nextSnapshot, context)
    expect(third.events.filter((e) => e.type === 'collector.error')).toHaveLength(0)

    // The identical unrecognised value recurs — must voice again.
    const fourth = await collector.poll(third.nextSnapshot, context)
    expect(fourth.events.filter((e) => e.type === 'collector.error')).toHaveLength(1)
  })

  it('truncates an oversized unrecognised agent.status value in the voiced message, not just the list-skip sites (#506)', async () => {
    const collector = createWorkmuxCollector()
    const hugeStatus = 'z'.repeat(MAX_VOICE_LENGTH + 5000)
    const bad = JSON.stringify([
      { worktree: 'stuck-row', branch: 'stuck-row', status: hugeStatus, elapsed_secs: 60, title: 'stuck', workdir: '/repo/../stuck-row' },
    ])
    const context = makeContext(
      fakeExec({
        status: [ok(bad)],
        list: [ok('[]')],
      }),
    )

    const result = await collector.poll(collector.initialSnapshot(), context)

    expect(result.events).toHaveLength(1)
    const message = (result.events[0]?.payload as { message: string }).message
    expect(message).toContain(`(+5000 more chars)`)
    expect(message.length).toBeLessThan(hugeStatus.length)
  })

  it("a second, distinct malformed status row still voices even though the first row's latch alone would not have (the sibling case, #506)", async () => {
    const collector = createWorkmuxCollector()
    // Poll 1: only handle `a` is malformed.
    const onlyA = JSON.stringify([{ worktree: 'a', branch: 'a', status: 'working' }]) // no `workdir`
    // Poll 2: `a` is still malformed (unchanged — alone this would stay
    // silent), but `b` is now malformed too, for the first time. A single
    // global boolean latch would miss this; a per-key `Record` must not.
    const aAndB = JSON.stringify([
      { worktree: 'a', branch: 'a', status: 'working' },
      { worktree: 'b', branch: 'b', status: 'working' },
    ])
    const context = makeContext(
      fakeExec({
        status: [ok(onlyA), ok(aAndB)],
        list: [ok('[]'), ok('[]')],
      }),
    )

    const first = await collector.poll(collector.initialSnapshot(), context)
    expect(first.events.filter((e) => e.type === 'collector.error')).toHaveLength(1)

    const second = await collector.poll(first.nextSnapshot, context)
    expect(second.events.filter((e) => e.type === 'collector.error')).toHaveLength(1)
  })
})
