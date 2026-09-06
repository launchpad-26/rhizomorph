import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createEvent,
  findUnbackedProvidedSignals,
  type CollectorContext,
  type Exec,
  type SignalObservations,
} from '@rhizomorph/core'
import { describe, expect, it } from 'vitest'
import { createSessionlogCollector, SESSIONLOG_CAPABILITIES, worktreePathToProjectSlug } from '../sessionlog/index.js'
import { observeEventSignals } from './signal-evidence.js'
import { runConformanceSuite } from './suite.js'
import type { ConformanceOrgan, VersionPinningExemption } from './types.js'

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'sessionlog', 'fixtures')

async function fixtureNames(): Promise<string[]> {
  return (await readdir(fixturesDir)).filter((name) => name.endsWith('.jsonl')).sort()
}

/**
 * These three predate `fixtures/CAPTURE.md`'s turn-shape capture discipline —
 * they back `collector.test.ts` alone and were never claimed as pinned by
 * anything this repo has written. Named here rather than silently passed:
 * the issue's own framing ("sessionlog's fixtures are version-pinned") is
 * true of the seven `claude-code-2.1.222-*` captures, not of these. Renaming
 * them is outside this issue's fence (`sessionlog/fixtures/` is not in it).
 */
const SESSIONLOG_VERSION_PINNING_EXEMPTIONS: VersionPinningExemption[] = [
  'conductor-root.jsonl',
  'worker-2-core.jsonl',
  'worker-4-tmux-collector.jsonl',
].map((name) => ({ name, reason: "predates CAPTURE.md's turn-shape capture discipline; not in this issue's fence to rename" }))

function worktreeListOutput(paths: readonly string[]): string {
  return paths.map((worktreePath) => `worktree ${worktreePath}\nHEAD abc123\nbranch refs/heads/main\n`).join('\n')
}

function makeContext(exec: Exec, now = 1_000): CollectorContext {
  let counter = 0
  return {
    repoPath: '/repo',
    now,
    exec,
    nextId: () => `id-${(counter += 1)}`,
    emit: (type, payload, options) =>
      createEvent(type, payload, { id: `id-${(counter += 1)}`, ts: options?.ts === undefined ? now : Math.floor(options.ts) }),
  }
}

/**
 * Drives the real collector over every real fixture at once, in one worker
 * worktree — the same recipe `collector.test.ts` already proves works:
 * listing `/repo` first is what makes the second path a genuine *linked*
 * worktree (`role: 'worker'`) rather than the main-tree `unattributed`
 * special case. `backfill: true` so a fixture already on disk at first
 * sight is read, not skipped to EOF.
 */
async function observeSessionlog(): Promise<SignalObservations> {
  const root = await mkdtemp(path.join(tmpdir(), 'sessionlog-conformance-'))
  try {
    const worktreePath = '/fake/worktrees/conformance'
    const projectDir = path.join(root, worktreePathToProjectSlug(worktreePath))
    await mkdir(projectDir, { recursive: true })

    for (const name of await fixtureNames()) {
      await writeFile(path.join(projectDir, name), await readFile(path.join(fixturesDir, name), 'utf8'), 'utf8')
    }

    const collector = createSessionlogCollector({ claudeProjectsRoot: root, backfill: true })
    const gitExec: Exec = async () => ({
      stdout: worktreeListOutput(['/repo', worktreePath]),
      stderr: '',
      code: 0,
      failed: false,
    })

    const result = await collector.poll(collector.initialSnapshot(), makeContext(gitExec))
    const observed = observeEventSignals(result.events)
    const lanes = Object.values(result.nextSnapshot.lanes ?? {})
    const waiting = lanes.filter((lane) => lane.state === 'waiting').length

    // liveness/attention are not read off events (see signal-evidence.ts's doc
    // comment) — this organ's real evidence for both lives in the poll's own
    // snapshot; its `agent.status` publication (#281, ADR-0037) is
    // edge-triggered, so an event count would under-report a standing reading.
    // Attention is NOT liveness's evidence re-badged (#319 review, finding 4):
    // the needs-you read is a lane the state machine resolved to `waiting`,
    // so a future upgrade of the declaration to `provided` must be earned by
    // a fixture that demonstrates it, not auto-passed on any lane existing.
    return {
      ...observed,
      liveness: {
        emitted: lanes.length > 0,
        detail:
          lanes.length > 0
            ? `the transcript-tail state machine derived a liveness reading for ${lanes.length} lane(s)`
            : 'no lane produced a liveness reading — every fixture parsed to a lane-less transcript',
      },
      attention: {
        emitted: waiting > 0,
        detail:
          waiting > 0
            ? `the turn-shape state machine resolved ${waiting} lane(s) to "waiting" — the needs-you read, inferred not declared`
            : 'no fixture drove a lane to "waiting"; nothing here demonstrates an attention read',
      },
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const sessionlogOrgan: ConformanceOrgan = {
  name: 'sessionlog',
  capabilities: SESSIONLOG_CAPABILITIES,
  observe: observeSessionlog,
  fixtureNames,
  versionPinningExemptions: SESSIONLOG_VERSION_PINNING_EXEMPTIONS,
}

runConformanceSuite(sessionlogOrgan)

describe('conformance suite: sessionlog — the check bites (mutation, executed)', () => {
  it('flips cost to "provided", a signal these fixtures never carry a dollar for, and the check goes red', async () => {
    const observed = await observeSessionlog()

    const rigged = { ...SESSIONLOG_CAPABILITIES, cost: { level: 'provided' as const } }
    expect(findUnbackedProvidedSignals(rigged, observed)).toEqual([
      'cost: declared provided, but no llm.cost event was observed',
    ])

    // Put it back — `rigged` is a fresh object; `SESSIONLOG_CAPABILITIES`
    // itself, the real declaration this collector ships, was never mutated.
    expect(findUnbackedProvidedSignals(SESSIONLOG_CAPABILITIES, observed)).toEqual([])
  })
})
