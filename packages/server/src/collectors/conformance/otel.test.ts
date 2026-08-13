import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createEvent, findUnbackedProvidedSignals, type RhizomorphEvent, type SignalObservations } from '@rhizomorph/core'
import { describe, expect, it } from 'vitest'
import {
  OTEL_CAPABILITIES,
  parseMetricsExport,
  parseTracesExport,
  validateLogsExport,
  type OtelEmitter,
} from '../otel/index.js'
import { observeEventSignals } from './signal-evidence.js'
import { runConformanceSuite } from './suite.js'
import type { ConformanceOrgan, VersionPinningExemption } from './types.js'

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'otel', 'fixtures')

async function fixtureNames(): Promise<string[]> {
  return (await readdir(fixturesDir)).filter((name) => name.endsWith('.json')).sort()
}

/**
 * prd-26 ruling 3 wants pinning "as claude's fixtures are"; these eight
 * predate it — issue #319's own note: "half of otel's are not (logs-basic.json,
 * metrics-token-and-cost.json, and six more carry no version)". Not this
 * issue's fence to rename (`otel/fixtures/` is not in it) — reported here
 * rather than quietly left unchecked.
 */
const OTEL_VERSION_PINNING_EXEMPTIONS: VersionPinningExemption[] = [
  'logs-basic.json',
  'logs-malformed.json',
  'metrics-all-tiers.json',
  'metrics-bad-datapoint.json',
  'metrics-conductor.json',
  'metrics-malformed.json',
  'metrics-token-and-cost.json',
  'metrics-unknown-only.json',
].map((name) => ({ name, reason: "predates prd-26 ruling 3's pinning discipline; not in this issue's fence to rename" }))

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

async function readFixtureJson(name: string): Promise<unknown> {
  return JSON.parse(await readFile(path.join(fixturesDir, name), 'utf8'))
}

type FixtureKind = 'traces' | 'metrics' | 'logs'

/** The filename convention the fixtures were captured under, made total (#460): `null` is a fixture no parser would read. */
function routeFor(name: string): FixtureKind | null {
  if (name.includes('traces')) return 'traces'
  if (name.includes('metrics')) return 'metrics'
  if (name.includes('logs')) return 'logs'
  return null
}

/**
 * Runs every real fixture through the real receiver parsers, routed by the
 * same filename convention the fixtures were captured under: metrics through
 * `parseMetricsExport`, traces through `parseTracesExport`. `logs-*.json`
 * fixtures are parsed too, through `validateLogsExport` — but that function
 * produces no events by design (its own doc comment: "turning log records
 * into events is the sessionlog collector's job, not this receiver's"), so a
 * logs fixture contributes no signal evidence here, correctly. A fixture
 * matching no route throws rather than being skipped — a silently-unread
 * fixture would thin the evidence this suite's green rests on (#319 review,
 * finding 6).
 */
async function observeOtel(): Promise<SignalObservations> {
  const events: RhizomorphEvent[] = []
  const emitter = makeEmitter(events)

  for (const name of await fixtureNames()) {
    const body = await readFixtureJson(name)
    const kind = routeFor(name)
    if (kind === null) throw new Error(`fixture "${name}" matches no parser route — it would contribute no evidence, silently`)
    if (kind === 'traces') parseTracesExport(body, emitter)
    else if (kind === 'metrics') parseMetricsExport(body, emitter)
    else validateLogsExport(body)
  }

  return observeEventSignals(events)
}

const otelOrgan: ConformanceOrgan = {
  name: 'otel',
  capabilities: OTEL_CAPABILITIES,
  observe: observeOtel,
  fixtureNames,
  versionPinningExemptions: OTEL_VERSION_PINNING_EXEMPTIONS,
}

runConformanceSuite(otelOrgan)

describe('conformance suite: otel — the check bites (mutation, executed)', () => {
  it('flips liveness to "provided", a signal no OTLP export carries, and the check goes red', async () => {
    const observed = await observeOtel()

    const rigged = { ...OTEL_CAPABILITIES, liveness: { level: 'provided' as const } }
    expect(findUnbackedProvidedSignals(rigged, observed)).toEqual([
      'liveness: declared provided, but no event type carries a liveness read; an organ deriving it another way must override this entry',
    ])

    // Put it back — `rigged` is a fresh object; `OTEL_CAPABILITIES` itself,
    // the real declaration this receiver ships, was never mutated.
    expect(findUnbackedProvidedSignals(OTEL_CAPABILITIES, observed)).toEqual([])
  })

  it('routes every otel fixture to its own parser — the right one by name, never merely some parser (#460)', async () => {
    // Non-null alone is not enough: rerouting traces → 'logs' left every otel
    // test green (second-eyes review, executed), because logs produce no
    // events and metrics alone still supplied the suite's evidence. Each
    // fixture's kind is asserted explicitly, so a new fixture must both route
    // and route CORRECTLY before it can contribute — or fail to.
    const routed = Object.fromEntries((await fixtureNames()).map((name) => [name, routeFor(name)]))
    expect(routed).toEqual({
      'claude-code-2.1.220-traces-interaction-root.json': 'traces',
      'claude-code-2.1.220-traces-llm-request.json': 'traces',
      'claude-code-2.1.220-traces-subagent.json': 'traces',
      'claude-code-2.1.220-traces-tool-pair-a.json': 'traces',
      'claude-code-2.1.220-traces-tool-pair-b.json': 'traces',
      'logs-basic.json': 'logs',
      'logs-malformed.json': 'logs',
      'metrics-all-tiers.json': 'metrics',
      'metrics-bad-datapoint.json': 'metrics',
      'metrics-conductor.json': 'metrics',
      'metrics-malformed.json': 'metrics',
      'metrics-token-and-cost.json': 'metrics',
      'metrics-unknown-only.json': 'metrics',
    })
  })

  it('the green above is the fixtures\' doing, not the check\'s leniency: the same declaration against no evidence names both provided signals', async () => {
    // The liveness flip composes with a constant (`signal-evidence.ts`
    // hardcodes liveness `emitted: false`), so on its own it proves nothing
    // about the parser path (review of #319, finding 2). `activity` and
    // `telemetry` are the two signals the real parsers back — strip the
    // evidence and the real declaration must go red on exactly those two.
    expect(findUnbackedProvidedSignals(OTEL_CAPABILITIES, observeEventSignals([]))).toEqual([
      'activity: declared provided, but no tool.activity, trace.span or agent.activeTime event was observed',
      'telemetry: declared provided, but no llm.usage event was observed',
    ])
  })
})
