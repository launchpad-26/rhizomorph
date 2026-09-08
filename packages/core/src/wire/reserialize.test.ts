import { describe, expect, it } from 'vitest'
import { eraCorpusEntry } from '../eras/corpus.js'
import { EVENT_TYPES, type RhizomorphEvent } from '../events/index.js'
import { fx } from '../fixtures.js'
import { eventToLine, parseJsonl } from '../jsonl.js'
import { buildRecord, recordGenesisSeed } from '../record/build.js'
import { sha256Hex } from '../record/hash.js'
import { RECORD_SCHEMA_VERSION } from '../record/schema.js'
import { reserializeLine } from './reserialize.js'
import { splitLines } from './split.js'

/** Test-only: `split.ts` may not assume this global, a test may. See `split.test.ts`. */
const enc = new TextEncoder()

const ACTOR = { instance: 'session-wire-1', handle: 'operator', declared: true }
const REPO_SLUG = 'rhizomorph-wire01'

/**
 * A pre-#292 `pane.activity` line: a real, current-schema event carrying a
 * payload key this build no longer declares. The `preview` value is fabricated
 * — no real terminal text, no real path — the way
 * `record/reserialization-law.test.ts` writes its own, and for the same reason
 * `no-personal-paths-law.test.ts` exists.
 */
const PLANTED_PREVIEW = 'sk-live-FABRICATED-WIRE-PREVIEW-77b2'
const LEGACY_PANE_ACTIVITY_LINE = JSON.stringify({
  id: 'evt-legacy-1',
  ts: 1700000000000,
  source: 'tmux',
  type: 'pane.activity',
  payload: {
    paneId: '%3',
    contentHash: 'h9',
    lines: 42,
    preview: PLANTED_PREVIEW,
    footer: 'esc to interrupt',
  },
})

describe('reserializeLine — the veil, stated as an equality', () => {
  it('drops a payload key the current schema no longer declares', () => {
    const result = reserializeLine(LEGACY_PANE_ACTIVITY_LINE)

    expect(result.kind).toBe('line')
    if (result.kind !== 'line') throw new Error('unreachable')
    expect(result.line).not.toContain('preview')
    expect(result.line).not.toContain(PLANTED_PREVIEW)
    expect(result.line).not.toContain('footer')
    // The strip is not a drop: the signal the fleet reads survives.
    expect(result.line).toContain('"contentHash":"h9"')
    expect(result.line).toContain('"lines":42')
    expect(JSON.stringify(result)).not.toContain(PLANTED_PREVIEW)
  })

  it('the input really carries what the output does not — the test can fail', () => {
    // Bypassing re-serialization is exactly what retains the key. This is the
    // assertion that goes red the day `reserializeLine` returns its input.
    expect(LEGACY_PANE_ACTIVITY_LINE).toContain('preview')
    expect(LEGACY_PANE_ACTIVITY_LINE).toContain(PLANTED_PREVIEW)

    const result = reserializeLine(LEGACY_PANE_ACTIVITY_LINE)
    if (result.kind !== 'line') throw new Error('unreachable')
    expect(result.line).not.toBe(LEGACY_PANE_ACTIVITY_LINE)
  })
})

describe('reserializeLine — digest identity over a real ledger', () => {
  const era1 = eraCorpusEntry('era-1')
  const bytes = enc.encode(era1.recordingText)

  it('the wire carries exactly the lines the record would, and the chain closes the same', () => {
    const { events, errors } = parseJsonl(era1.recordingText)
    expect(errors).toEqual([])
    const record = buildRecord(events, { repoSlug: REPO_SLUG, actor: ACTOR })

    const wireLines: string[] = []
    for (const ledgerLine of splitLines(bytes).lines) {
      const result = reserializeLine(ledgerLine.line)
      // Safe rather than optimistic: `eras/eras.test.ts` already holds era 1 to
      // an empty `fold.unknown`, so a line of it becoming unfoldable reddens
      // there first.
      expect(result.kind, `line ${ledgerLine.n} should fold`).toBe('line')
      if (result.kind !== 'line') continue
      wireLines.push(result.line)
    }

    expect(wireLines).toEqual(record.body.map((link) => link.line))

    // Recomputed from the wire's own lines rather than by calling `buildRecord`
    // again — otherwise this compares the serializer against itself.
    let prev = sha256Hex(
      recordGenesisSeed({ repoSlug: REPO_SLUG, actor: ACTOR, schemaVersion: RECORD_SCHEMA_VERSION }),
    )
    for (const line of wireLines) prev = sha256Hex(prev + line)
    expect(prev).toBe(record.manifest.chainDigest)
  })
})

/**
 * One valid event per type, from the zero-argument fixture sugars. `fixtures.ts`'s
 * `defaults` is `satisfies { [T in EventType]: PayloadOf<T> }`, so every sugar
 * returns a valid event of its type; the completeness assertion below is the
 * same guard `events.test.ts`'s `oneOfEach` carries.
 */
function oneOfEachEventType(): RhizomorphEvent[] {
  fx.reset()
  return [
    fx.sessionStarted(),
    fx.sessionClosed(),
    fx.beaconReceived(),
    fx.collectorError(),
    fx.collectorDisabled(),
    fx.collectorDegraded(),
    fx.collectorRecovered(),
    fx.worktreeDiscovered(),
    fx.worktreeRemoved(),
    fx.worktreeDirty(),
    fx.worktreeDirtyStatusFailed(),
    fx.worktreeDirtyStatusRecovered(),
    fx.branchUpdated(),
    fx.branchRemoved(),
    fx.commitLanded(),
    fx.paneDiscovered(),
    fx.paneClosed(),
    fx.paneActivity(),
    fx.agentStatus(),
    fx.agentRemoved(),
    fx.llmUsage(),
    fx.llmCost(),
    fx.toolActivity(),
    // `telemetry.refused` has a `defaults` entry in `fixtures.ts` but no sugar
    // method on `EventFactory`, so it goes through `make` with that payload
    // written out. Found by the completeness assertion below, which is exactly
    // what it is for — a hand-written roster silently missing a type is the
    // failure mode it exists to catch.
    fx.make('telemetry.refused', {
      instance: 'other-rhizomorph',
      expectedInstance: 'fixture-instance',
      count: 1,
    }),
    fx.agentActiveTime(),
    fx.traceSpan(),
    fx.forkCheckpoint(),
    fx.forkDispatched(),
    fx.forkMeasured(),
    fx.judgeFinding(),
    fx.summonsRaised(),
    fx.summonsCleared(),
    fx.gateVerdict(),
    fx.dispatchBrief(),
    fx.fenceDeclared(),
    fx.operatorAck(),
    fx.operatorVerdict(),
    fx.operatorNote(),
  ]
}

describe('reserializeLine — the falsifier', () => {
  it('covers every type in the current union', () => {
    expect(oneOfEachEventType().map((e) => e.type).sort()).toEqual([...EVENT_TYPES].sort())
  })

  /**
   * THE FALSIFIER (#257's Definition of done).
   *
   * If any event type in the current union cannot round-trip through
   * `reserializeLine` byte-identically to `buildRecord`'s line, the veil clause
   * and the digest identity are in tension and prd-51 ruling 3 needs an
   * AMENDMENT, not a workaround. Verdict as built: every type round-trips.
   */
  it('round-trips every event type byte-identically to buildRecord’s line', () => {
    const failures: string[] = []
    for (const event of oneOfEachEventType()) {
      const expected = eventToLine(event)
      const result = reserializeLine(expected)
      if (result.kind !== 'line') {
        failures.push(`${event.type}: ${result.kind}`)
        continue
      }
      if (result.line !== expected) failures.push(`${event.type}: ${result.line} !== ${expected}`)
    }
    expect(failures).toEqual([])
  })
})

describe('reserializeLine — an unfoldable line carries no bytes', () => {
  const MARKER = 'PLANTED-MARKER-1f9c'

  it('an unheard-of type is unknown, and its verdict holds none of the line', () => {
    const line = JSON.stringify({
      id: 'evt-future-1',
      ts: 1700000000001,
      source: 'orbital',
      type: 'satellite.acquired',
      payload: { note: MARKER },
    })
    const result = reserializeLine(line)

    expect(result.kind).toBe('unknown')
    if (result.kind !== 'unknown') throw new Error('unreachable')
    expect(result.type).toBe('satellite.acquired')
    expect(result.ts).toBe(1700000000001)
    expect(result.reason).toBe('unknown-type')
    expect(JSON.stringify(result)).not.toContain(MARKER)
    expect(JSON.stringify(result)).not.toContain(line)
  })

  it('a known type with a bad payload is unknown-shape, and still carries no bytes', () => {
    const line = JSON.stringify({
      id: 'evt-bad-1',
      ts: 1700000000002,
      source: 'tmux',
      type: 'pane.activity',
      payload: { paneId: 7, contentHash: 'h1', preview: MARKER },
    })
    const result = reserializeLine(line)

    expect(result.kind).toBe('unknown')
    if (result.kind !== 'unknown') throw new Error('unreachable')
    expect(result.type).toBe('pane.activity')
    expect(result.reason).toBe('unknown-shape')
    expect(result.detail.length).toBeGreaterThan(0)
    expect(JSON.stringify(result)).not.toContain(MARKER)
    expect(JSON.stringify(result)).not.toContain(line)
  })

  it('a blank line and a non-JSON line are malformed, and hold no line field', () => {
    for (const line of ['', 'not json']) {
      const result = reserializeLine(line)
      expect(result.kind).toBe('malformed')
      if (result.kind !== 'malformed') continue
      // Structural, not incidental: there is no field a caller could ship.
      expect(Object.keys(result).sort()).toEqual(['error', 'kind'])
    }
  })

  /**
   * Valid JSON that is not an event envelope — the malformed arm reached
   * through the schema rather than through `JSON.parse`, which is where a
   * planted value could actually survive into the verdict.
   *
   * The non-JSON case above is deliberately marker-free: `JSON.parse`'s own
   * `SyntaxError` quotes a fragment of what it was given, so `error` there is a
   * parser diagnostic that may echo input text. That is inherited from
   * `readEventLineLenient` and is out of this module's hands; what this module
   * guarantees is the structural property asserted above — no field holding the
   * line, so nothing a caller could mistake for shippable bytes.
   */
  it('a JSON value that is not an event is malformed, and its verdict holds no planted value', () => {
    const line = JSON.stringify({ hello: MARKER })
    const result = reserializeLine(line)

    expect(result.kind).toBe('malformed')
    if (result.kind !== 'malformed') throw new Error('unreachable')
    expect(JSON.stringify(result)).not.toContain(MARKER)
    expect(JSON.stringify(result)).not.toContain(line)
    expect(Object.keys(result).sort()).toEqual(['error', 'kind'])
  })
})

describe('reserializeLine — repetition', () => {
  it('is a pure function of its line', () => {
    const first = reserializeLine(LEGACY_PANE_ACTIVITY_LINE)
    const second = reserializeLine(LEGACY_PANE_ACTIVITY_LINE)
    const third = reserializeLine(LEGACY_PANE_ACTIVITY_LINE)

    expect(second).toEqual(first)
    expect(third).toEqual(first)
    if (first.kind !== 'line' || third.kind !== 'line') throw new Error('unreachable')
    expect(third.line).toBe(first.line)
  })
})
