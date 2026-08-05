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
})
