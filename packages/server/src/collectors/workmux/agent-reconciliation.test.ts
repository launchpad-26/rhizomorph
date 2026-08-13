import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createEvent,
  createIdFactory,
  reduceAll,
  type CollectorContext,
  type EventType,
  type Exec,
  type ExecResult,
  type PayloadOf,
} from '@rhizomorph/core'
import { describe, expect, it } from 'vitest'
import { withAgentReconciliation } from '../resume-reconcile.js'
import { createWorkmuxCollector } from './collector.js'

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

function fixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf8')
}

function ok(stdout: string): ExecResult {
  return { stdout, stderr: '', code: 0, failed: false }
}

/**
 * Routes `workmux status --json` / `workmux list --json` to canned results, in
 * call order per command. The full argv is asserted for the same reason as in
 * `collector.test.ts`: the canned responses are JSON either way, so dropping
 * `--json` from the collector's shell-out would leave this file green while
 * breaking it against a real workmux (#383).
 */
function fakeExec(responses: { status: ExecResult[]; list?: ExecResult[] }): Exec {
  const status = [...responses.status]
  const list = [...(responses.list ?? [])]
  return async (_command, args) => {
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

/**
 * The live session's actual ghost shape (#418), one entity over from #139's
 * branch precedent: a seventh handle, '8-since-departed', whose
 * `agent.status` fact predates this boot and whose departure happened while
 * the process was down (or under a pre-#306 build, before `agent.removed`
 * existed). The persisted workmux snapshot never held it past that poll, so
 * there is nothing left for the live collector to diff against — only the
 * fold still remembers it as present. `status-working.json`/`list-working.json`
 * never mention this handle at all.
 */
function ghostLog() {
  const nextId = createIdFactory('evt')
  return [
    createEvent(
      'agent.status',
      {
        handle: '8-since-departed',
        status: 'working',
        branch: '8-since-departed',
        worktreePath: '../8-since-departed',
        elapsedSeconds: 60,
      },
      { id: nextId(), ts: 100 },
    ),
  ]
}

function presentHandles(folded: ReturnType<typeof reduceAll>): Set<string> {
  return new Set(
    Object.entries(folded.agents)
      .filter(([, agent]) => agent.present)
      .map(([handle]) => handle),
  )
}

function realityExec(): Exec {
  return fakeExec({
    status: [ok(fixture('status-working.json'))],
    list: [ok(fixture('list-working.json'))],
  })
}

describe('withAgentReconciliation(createWorkmuxCollector()) — the #418 ghost, reconstructed', () => {
  it('a fresh boot reconciles the ghost to quiet: one agent.removed, fold drops present', async () => {
    const priorEvents = ghostLog()
    const folded = reduceAll(priorEvents)

    // Sanity: the fold really does still believe the ghost is present before reconciliation.
    expect(folded.agents['8-since-departed']?.present).toBe(true)

    const reconciled = withAgentReconciliation(createWorkmuxCollector(), presentHandles(folded))
    const result = await reconciled.poll(reconciled.initialSnapshot(), makeContext(realityExec(), 1000))

    const removed = result.events.filter((event) => event.type === 'agent.removed')
    expect(removed).toHaveLength(1)
    expect(removed[0]?.payload).toEqual({ handle: '8-since-departed' })

    // The six fixture handles still get their first-seen agent.status facts —
    // reconciliation is additive, not a replacement for the live diff.
    expect(result.events.filter((event) => event.type === 'agent.status')).toHaveLength(6)

    const quiet = reduceAll(result.events, folded)
    expect(quiet.agents['8-since-departed']?.present).toBe(false)
  })

  it('is idempotent: the next boot, whose fold no longer holds the ghost present, emits nothing new for it', async () => {
    const priorEvents = ghostLog()
    const firstFolded = reduceAll(priorEvents)
    const firstBoot = withAgentReconciliation(createWorkmuxCollector(), presentHandles(firstFolded))
    const firstResult = await firstBoot.poll(firstBoot.initialSnapshot(), makeContext(realityExec(), 1000))

    // The log a second boot would resume from now carries the reconciling event.
    const secondFolded = reduceAll([...priorEvents, ...firstResult.events])
    expect(secondFolded.agents['8-since-departed']?.present).toBe(false)

    const secondBoot = withAgentReconciliation(createWorkmuxCollector(), presentHandles(secondFolded))
    const secondResult = await secondBoot.poll(firstResult.nextSnapshot, makeContext(realityExec(), 2000))

    expect(secondResult.events.some((event) => event.type === 'agent.removed')).toBe(false)
  })

  it('a plain replay of the ghost log, without reconciliation, still shows the departure as present', () => {
    // No withAgentReconciliation involved at all — reconciliation is a
    // live-boot act, never a replay rewrite.
    const replayed = reduceAll(ghostLog())

    expect(replayed.agents['8-since-departed']?.present).toBe(true)
  })
})
