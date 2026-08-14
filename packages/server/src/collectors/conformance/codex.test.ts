import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createEvent, findUnbackedProvidedSignals, type RhizomorphEvent, type SignalObservations } from '@rhizomorph/core'
import { describe, expect, it } from 'vitest'
import { CODEX_CAPABILITIES } from '../codex/index.js'
import { parseMetricsExport, parseTracesExport, validateLogsExport, type OtelEmitter } from '../otel/index.js'
import { observeEventSignals } from './signal-evidence.js'
import { runConformanceSuite } from './suite.js'
import type { ConformanceOrgan } from './types.js'

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'codex', 'fixtures')

async function fixtureNames(): Promise<string[]> {
  return (await readdir(fixturesDir)).filter((name) => name.endsWith('.jsonl') || name.endsWith('.json')).sort()
}

function makeEmitter(events: RhizomorphEvent[]): OtelEmitter {
  let counter = 0
  return {
    emit: (type, payload, source) => {
      const emitted = createEvent(type, payload, { id: `id-${(counter += 1)}`, ts: 1_000, source })
      events.push(emitted)
      return emitted
    },
  }
}

type OtlpFixtureKind = 'traces' | 'metrics' | 'logs'

/**
 * `codex-cli-0.146.0-otlp-traces-root-spans-parentspanid-empty.json` is
 * deliberately excluded from normal routing — feeding it through
 * `parseTracesExport` is the point of `it('crashes...')` below, not something
 * `observeCodex()`'s per-fixture loop should ever do (it would crash the
 * whole suite's evidence gathering, not just prove the one thing it's for).
 */
const CRASH_FIXTURE = 'codex-cli-0.146.0-otlp-traces-root-spans-parentspanid-empty.json'

/**
 * codex has no `Collector` and no receiver route of its own (CAPTURE.md,
 * `../codex/index.ts`'s header) — its OTLP fixtures land on the *same* shared
 * receiver parsers claude's do, so this is the only real code there is to run
 * them through. The `.jsonl` rollout fixtures are real, captured evidence
 * (CAPTURE.md's Findings 3–5); nothing in the live event pipeline reads them
 * yet (that needs a rollout-tailing collector, out of this issue's fence —
 * `capabilities.ts` says so for every signal resting on them), so `routeFor`
 * still answers `null` for them here. But ruling 3's evidence bar does not
 * require a live pipeline — it requires an assertion against the real
 * capture — and the raw-shape tests below give each of the three `.jsonl`
 * fixtures exactly that, cheaply, with no collector needed.
 */
function routeFor(name: string): OtlpFixtureKind | null {
  if (name === CRASH_FIXTURE) return null
  if (name.includes('otlp-traces')) return 'traces'
  if (name.includes('otlp-metrics')) return 'metrics'
  if (name.includes('otlp-logs')) return 'logs'
  return null
}

async function observeCodex(): Promise<SignalObservations> {
  const events: RhizomorphEvent[] = []
  const emitter = makeEmitter(events)

  for (const name of await fixtureNames()) {
    const kind = routeFor(name)
    if (kind === null) continue
    const body: unknown = JSON.parse(await readFile(path.join(fixturesDir, name), 'utf8'))
    if (kind === 'traces') parseTracesExport(body, emitter)
    else if (kind === 'metrics') parseMetricsExport(body, emitter)
    else validateLogsExport(body)
  }

  return observeEventSignals(events)
}

async function readRolloutLines(name: string): Promise<Array<{ type: string; payload: Record<string, unknown> }>> {
  const text = await readFile(path.join(fixturesDir, name), 'utf8')
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line))
}

const codexOrgan: ConformanceOrgan = {
  name: 'codex',
  capabilities: CODEX_CAPABILITIES,
  observe: observeCodex,
  fixtureNames,
}

runConformanceSuite(codexOrgan)

describe('conformance suite: codex — the check bites (mutation, executed)', () => {
  it('flips telemetry to "provided", a signal these fixtures never back with an llm.usage event, and the check goes red', async () => {
    const observed = await observeCodex()

    const rigged = { ...CODEX_CAPABILITIES, telemetry: { level: 'provided' as const } }
    expect(findUnbackedProvidedSignals(rigged, observed)).toEqual(['telemetry: declared provided, but no llm.usage event was observed'])

    // Put it back — `rigged` is a fresh object; `CODEX_CAPABILITIES` itself,
    // the real declaration this organ ships, was never mutated.
    expect(findUnbackedProvidedSignals(CODEX_CAPABILITIES, observed)).toEqual([])
  })

  it('routes every codex fixture by name — the OTLP ones to their real parser, the rollout ones and the crash fixture to none (#460-style check)', async () => {
    const routed = Object.fromEntries((await fixtureNames()).map((name) => [name, routeFor(name)]))
    expect(routed).toEqual({
      'codex-cli-0.146.0-otlp-logs-task-error.json': 'logs',
      'codex-cli-0.146.0-otlp-logs-turn.json': 'logs',
      'codex-cli-0.146.0-otlp-metrics-turn.json': 'metrics',
      'codex-cli-0.146.0-otlp-traces-turn.json': 'traces',
      'codex-cli-0.146.0-otlp-traces-root-spans-parentspanid-empty.json': null,
      'codex-cli-0.146.0-rollout-task-error.jsonl': null,
      'codex-cli-0.146.0-rollout-tool-call.jsonl': null,
      'codex-cli-0.146.0-rollout-turn-complete.jsonl': null,
    })
  })

  it('the failure/absence outcome is real: validateLogsExport accepts the body, and the error it carries is the actual API rejection, not just a filename claiming failure', async () => {
    const body: unknown = JSON.parse(await readFile(path.join(fixturesDir, 'codex-cli-0.146.0-otlp-logs-task-error.json'), 'utf8'))
    expect(validateLogsExport(body)).toEqual({ malformed: false })

    const records = (body as { resourceLogs: Array<{ scopeLogs: Array<{ logRecords: Array<{ attributes: Array<{ key: string; value: Record<string, string> }> }> }> }> })
      .resourceLogs.flatMap((rl) => rl.scopeLogs.flatMap((sl) => sl.logRecords))
    const attrsByKey = (rec: (typeof records)[number]) => Object.fromEntries(rec.attributes.map((a) => [a.key, Object.values(a.value)[0]]))
    const errorRecord = records.map(attrsByKey).find((attrs) => 'error.message' in attrs)

    expect(errorRecord).toBeDefined()
    expect(errorRecord?.['error.message']).toContain("model is not supported when using Codex with a ChatGPT account")
    expect(errorRecord?.['event.name']).toBe('codex.sse_event')
  })

  it('a real codex root span (parentSpanId: "") crashes the unmodified trace parser — #510, reported not fixed here', async () => {
    const body: unknown = JSON.parse(await readFile(path.join(fixturesDir, CRASH_FIXTURE), 'utf8'))
    const events: RhizomorphEvent[] = []
    const emitter = makeEmitter(events)

    // #510: `buildSpanEvent`'s `span.parentSpanId ?? null` does not treat an
    // empty string as absent, and the core schema's `parentSpanId` is
    // `nonEmptyString.nullable()` — so `createEvent` throws, uncaught, and
    // one bad span crashes the whole request's parse rather than degrading
    // gracefully the way a missing traceId/spanId/name already does. This
    // fixture pins that fact so it can't silently stop being true once #510
    // is fixed (this test would then need to assert the opposite).
    expect(() => parseTracesExport(body, emitter)).toThrow(/parentSpanId/)
  })

  it('rollout raw shapes are asserted directly — no collector needed to prove what the capture actually contains', async () => {
    const turnComplete = await readRolloutLines('codex-cli-0.146.0-rollout-turn-complete.jsonl')
    const turnCompleteLast = turnComplete.at(-1)
    expect(turnCompleteLast?.type).toBe('event_msg')
    expect(turnCompleteLast?.payload).toMatchObject({ type: 'task_complete', last_agent_message: 'ok' })
    expect(turnCompleteLast?.payload.error).toBeUndefined()

    const toolCall = await readRolloutLines('codex-cli-0.146.0-rollout-tool-call.jsonl')
    const toolCallTypes = toolCall.map((line) => (line.type === 'response_item' ? (line.payload.type as string) : null)).filter(Boolean)
    expect(toolCallTypes).toContain('custom_tool_call')
    expect(toolCallTypes).toContain('custom_tool_call_output')
    expect(toolCallTypes.indexOf('custom_tool_call')).toBeLessThan(toolCallTypes.indexOf('custom_tool_call_output'))
    expect(toolCall.at(-1)?.payload).toMatchObject({ type: 'task_complete', last_agent_message: 'done' })

    const taskError = await readRolloutLines('codex-cli-0.146.0-rollout-task-error.jsonl')
    const taskErrorLast = taskError.at(-1)
    expect(taskErrorLast?.type).toBe('event_msg')
    expect(taskErrorLast?.payload).toMatchObject({ type: 'task_complete', last_agent_message: null })
    expect((taskErrorLast?.payload.error as { message?: string } | undefined)?.message).toContain('definitely-not-a-real-model-xyz')
  })
})
