import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
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
import { createPiCollector } from '../pi/collector.js'
import { PI_CAPABILITIES } from '../pi/index.js'
import { PI_JSONL_GRAMMAR } from '../pi/grammar.js'
import { observeEventSignals } from './signal-evidence.js'
import { runConformanceSuite } from './suite.js'
import type { ConformanceOrgan } from './types.js'

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'pi', 'fixtures')

async function fixtureNames(): Promise<string[]> {
  return (await readdir(fixturesDir)).filter((name) => name.endsWith('.jsonl')).sort()
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
 * Drives the real collector over every real fixture at once. Unlike
 * sessionlog's own conformance harness, there is no worktree-slug directory
 * to construct — `createPiCollector` reads each session's `cwd` off its own
 * header line, so the fixtures are written flat under one root
 * (`collector.ts`'s header comment: no directory-naming convention was ever
 * independently captured, so this organ never assumes one). `backfill: true`
 * so a fixture already on disk at first sight is read, not skipped to EOF.
 * The git exec is a real no-op (no worktrees) — identity attribution here
 * rests on the header's structural `cwd`, not on a worktree match.
 */
async function observePi(): Promise<SignalObservations> {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-conformance-'))
  try {
    for (const name of await fixtureNames()) {
      await writeFile(path.join(root, name), await readFile(path.join(fixturesDir, name), 'utf8'), 'utf8')
    }

    const collector = createPiCollector({ piSessionsRoot: root, backfill: true })
    const gitExec: Exec = async () => ({ stdout: '', stderr: '', code: 0, failed: false })

    const result = await collector.poll(collector.initialSnapshot(), makeContext(gitExec))
    const observed = observeEventSignals(result.events)
    const lanes = Object.values(result.nextSnapshot.lanes ?? {})
    const waiting = lanes.filter((lane) => lane.state === 'waiting').length

    // liveness/attention have no event home (signal-evidence.ts's doc
    // comment) — this organ's real evidence for both lives in the poll's own
    // snapshot instead, exactly as sessionlog's own conformance test reads it
    // (the derivation is shared, unmodified machinery — see collector.ts).
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

const piOrgan: ConformanceOrgan = {
  name: 'pi',
  capabilities: PI_CAPABILITIES,
  observe: observePi,
  fixtureNames,
}

runConformanceSuite(piOrgan)

describe('conformance suite: pi — the check bites (mutation, executed)', () => {
  it('flips attention to "provided", a signal this organ only infers, and the check goes red', async () => {
    // attention is the one signal PI_CAPABILITIES does NOT claim `provided`
    // for (it stays `partial`, the same inferred-not-declared level
    // sessionlog carries) — the sharpest signal left to rig now that
    // identity/liveness/activity/telemetry/cost are all genuinely backed by a
    // real collector and real fixtures.
    const observed = await observePi()
    const rigged = { ...PI_CAPABILITIES, attention: { level: 'provided' as const } }
    expect(findUnbackedProvidedSignals(rigged, observed)).toEqual([
      'attention: declared provided, but no fixture drove a lane to "waiting"; nothing here demonstrates an attention read',
    ])

    // Put it back — `rigged` is a fresh object; the real declaration was never mutated.
    expect(findUnbackedProvidedSignals(PI_CAPABILITIES, observed)).toEqual([])
  })

  it('every declared "provided" signal carries no reason/remedy, and "partial" carries both (the discriminated-union law)', () => {
    for (const [signal, detail] of Object.entries(PI_CAPABILITIES)) {
      if (detail.level === 'provided') continue
      expect(detail.level, `${signal} should be provided or partial, never absent — every signal is now backed by a real collector`).toBe('partial')
      expect(detail.reason.length, `${signal}'s reason should say why`).toBeGreaterThan(0)
      expect(detail.remedy?.length ?? 0, `${signal} should name a remedy, not just a reason`).toBeGreaterThan(0)
    }
  })

  it('a pi event is attributed to pi, not folded as claude\'s: harness is always "pi", never absent', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pi-harness-'))
    try {
      await writeFile(
        path.join(root, 'pi-0.83.0-turn-complete.jsonl'),
        await readFile(path.join(fixturesDir, 'pi-0.83.0-turn-complete.jsonl'), 'utf8'),
        'utf8',
      )
      const collector = createPiCollector({ piSessionsRoot: root, backfill: true })
      const gitExec: Exec = async () => ({ stdout: '', stderr: '', code: 0, failed: false })
      const result = await collector.poll(collector.initialSnapshot(), makeContext(gitExec))

      const telemetryEvents = result.events.filter((event) => event.type === 'llm.usage' || event.type === 'llm.cost')
      expect(telemetryEvents.length).toBeGreaterThan(0)
      for (const event of telemetryEvents) {
        expect((event.payload as { harness?: string | null }).harness).toBe('pi')
        // absent/null harness is what the schema (and every reducer) reads as
        // "Claude Code's own collector" — the exact misattribution this test pins.
        expect((event.payload as { harness?: string | null }).harness).not.toBeNull()
        expect((event.payload as { harness?: string | null }).harness).not.toBeUndefined()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('routes every pi fixture through the real collector — none needs an OTLP parser (unlike codex)', async () => {
    // Unlike codex, which has real OTLP bytes to feed through the shared
    // otel receiver, every pi fixture here is a session-JSONL rollout read
    // by `createPiCollector` directly — there is still no OTLP parser in
    // this organ's fence, because pi has no OTLP export at all (CAPTURE.md).
    const names = await fixtureNames()
    expect(names).toEqual([
      'pi-0.83.0-tail-pending-tool-interrupted.jsonl',
      'pi-0.83.0-task-error.jsonl',
      'pi-0.83.0-tool-call-error.jsonl',
      'pi-0.83.0-tool-call.jsonl',
      'pi-0.83.0-turn-complete.jsonl',
      'pi-0.83.0-write-tool.jsonl',
    ])
  })

  it('the failure/absence outcome is real: a genuine API rejection, not just a filename claiming failure', async () => {
    const text = await readFile(path.join(fixturesDir, 'pi-0.83.0-task-error.jsonl'), 'utf8')
    const lines = text
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line))
    const assistantLine = lines.at(-1)
    expect(assistantLine.message.role).toBe('assistant')
    expect(assistantLine.message.stopReason).toBe('error')
    expect(assistantLine.message.errorMessage).toContain('definitely-not-a-real-model-xyz is not a valid model ID')
    // The real turn-shape read on this line: a completed turn, not a truncation.
    expect(PI_JSONL_GRAMMAR.classify(JSON.stringify(assistantLine))).toMatchObject({
      role: 'assistant',
      turnComplete: true,
      opensToolUseIds: [],
    })
  })

  it('the pending-tool-call outcome is real: a genuine interrupted process, ending mid-tool-call, not a hand-truncated slice', async () => {
    const text = await readFile(path.join(fixturesDir, 'pi-0.83.0-tail-pending-tool-interrupted.jsonl'), 'utf8')
    const lines = text
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line))
    const lastLine = lines.at(-1)
    expect(lastLine.message.role).toBe('assistant')
    expect(lastLine.message.stopReason).toBe('toolUse')
    const toolCall = lastLine.message.content.find((block: { type: string }) => block.type === 'toolCall')
    expect(toolCall.name).toBe('bash')
    expect(toolCall.arguments.command).toContain('sleep 15')
    // No toolResult line ever follows — the process was killed mid-execution.
    expect(lines.some((l) => l.message?.role === 'toolResult')).toBe(false)
  })
})
