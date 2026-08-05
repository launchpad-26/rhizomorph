import { describe, expect, it } from 'vitest'
import { fx } from '../fixtures.js'
import { eventToLine } from '../jsonl.js'
import {
  isKnownEventType,
  parseEvent,
  parseEventLenient,
  readEventLineLenient,
  voiceUnknownEvents,
  type UnknownEventLine,
} from './index.js'

/**
 * THE LENIENT PARSE — prd17 ruling 3, item 1.
 *
 * The finding this file pins: the event union is an exact-match discriminated
 * union, so a line from a newer era simply *failed*, and every caller stepped
 * over the failure. A recording could lose events with nobody able to say how
 * many. The law: counted, preserved byte-for-byte, and voiced.
 */

/** A line the way a NEWER era's instrument would have written it — prd17 ruling 1's own families. */
const FUTURE_LINE =
  '{"id":"evt-000042","ts":1785930000000,"source":"system","type":"summons.raised","payload":{"lane":"a","kind":"awaiting-reply","raisedAt":1785930000000}}'

function unknownFrom(line: string, lineNumber: number | null = null): UnknownEventLine {
  const parsed = readEventLineLenient(line, lineNumber)
  if (parsed.kind !== 'unknown') throw new Error(`expected an unknown, got ${parsed.kind}`)
  return parsed.unknown
}

describe('parseEventLenient — the strict verdict, unchanged', () => {
  it('folds a known event exactly as parseEvent does', () => {
    const event = fx.sessionStarted()
    const lenient = parseEventLenient(JSON.parse(eventToLine(event)))
    expect(lenient.kind).toBe('event')
    if (lenient.kind !== 'event') throw new Error('expected an event')
    expect(lenient.event).toEqual(event)
  })

  it('agrees with parseEvent on every event the fixture session produces — no new acceptance', () => {
    for (const event of [fx.sessionStarted(), fx.commitLanded(), fx.traceSpan(), fx.judgeFinding()]) {
      const value: unknown = JSON.parse(eventToLine(event))
      expect(parseEvent(value).ok).toBe(true)
      expect(parseEventLenient(value).kind).toBe('event')
    }
  })
})

describe('parseEventLenient — an unrecognized type is counted, never dropped', () => {
  it('reads a newer era\'s event family as an honest unknown', () => {
    const unknown = unknownFrom(FUTURE_LINE, 7)
    expect(unknown.reason).toBe('unknown-type')
    expect(unknown.type).toBe('summons.raised')
    expect(unknown.ts).toBe(1785930000000)
    expect(unknown.lineNumber).toBe(7)
  })

  it('preserves the line BYTE FOR BYTE — not a re-serialization', () => {
    expect(unknownFrom(FUTURE_LINE).line).toBe(FUTURE_LINE)
  })

  it('preserves the exact bytes even when they are not the bytes we would have written', () => {
    // Spaces after the colons, keys out of our own order: a stranger's emitter,
    // or an older version of ours. `JSON.stringify` would normalise both away,
    // and then the record's hash chain would no longer cover what we kept.
    const oddly = '{"type": "gate.verdict", "ts": 5, "id": "x", "source": "gate", "payload": {"held": true}}'
    expect(unknownFrom(oddly).line).toBe(oddly)
  })

  it('reads an unknown SOURCE without objecting — a newer era may have grown a collector', () => {
    const unknown = unknownFrom(
      '{"id":"e1","ts":9,"source":"beacon","type":"gate.verdict","payload":{}}',
    )
    expect(unknown.reason).toBe('unknown-type')
    expect(unknown.type).toBe('gate.verdict')
  })

  it('reads a KNOWN type whose payload a later era widened as unknown-shape, not corruption', () => {
    const unknown = unknownFrom(
      '{"id":"e1","ts":9,"source":"workmux","type":"agent.status","payload":{"handle":"a","status":"deliberating"}}',
    )
    expect(unknown.reason).toBe('unknown-shape')
    expect(unknown.type).toBe('agent.status')
    expect(isKnownEventType(unknown.type)).toBe(true)
    // The union's own objection is kept, for a human reading a verifier's output.
    expect(unknown.detail.length).toBeGreaterThan(0)
  })
})

describe('parseEventLenient — what is NOT an era gap', () => {
  it('a line that is not JSON is malformed, not "from a newer era"', () => {
    const parsed = readEventLineLenient('{not json')
    expect(parsed.kind).toBe('malformed')
  })

  it('a JSON value with no envelope is malformed — calling it a newer era would be a lie', () => {
    for (const line of ['42', '"a string"', 'null', '{}', '{"type":"x.y"}', '[]']) {
      expect(readEventLineLenient(line).kind).toBe('malformed')
    }
  })

  it('a line with no usable timestamp is malformed — an unknown must still be placeable in time', () => {
    expect(
      readEventLineLenient('{"id":"e1","ts":-5,"source":"system","type":"x.y","payload":{}}').kind,
    ).toBe('malformed')
    expect(
      readEventLineLenient('{"id":"e1","ts":"soon","source":"system","type":"x.y","payload":{}}')
        .kind,
    ).toBe('malformed')
  })

  it('a blank line is malformed, not an era gap — it is the ordinary shape of an appended tail', () => {
    expect(readEventLineLenient('').kind).toBe('malformed')
    expect(readEventLineLenient('   ').kind).toBe('malformed')
  })

  it('keeps a malformed line\'s own bytes too, so a caller can still show it', () => {
    const parsed = readEventLineLenient('{not json', 3)
    if (parsed.kind !== 'malformed') throw new Error('expected malformed')
    expect(parsed.line).toBe('{not json')
    expect(parsed.lineNumber).toBe(3)
  })
})

describe('parseEventLenient — a value without its own line text', () => {
  it('falls back to JSON.stringify for a caller that only ever had a decoded value', () => {
    // The web reads events off a JSON API, where the log's bytes are long gone.
    const parsed = parseEventLenient({
      id: 'e1',
      ts: 9,
      source: 'system',
      type: 'operator.ack',
      payload: {},
    })
    if (parsed.kind !== 'unknown') throw new Error('expected an unknown')
    expect(JSON.parse(parsed.unknown.line)).toEqual({
      id: 'e1',
      ts: 9,
      source: 'system',
      type: 'operator.ack',
      payload: {},
    })
  })

  it('survives a value JSON.stringify cannot render, rather than throwing', () => {
    const cyclic: Record<string, unknown> = { id: 'e1', ts: 9, source: 'system', type: 'x.y' }
    cyclic.self = cyclic
    const parsed = parseEventLenient(cyclic)
    if (parsed.kind !== 'unknown') throw new Error('expected an unknown')
    expect(typeof parsed.unknown.line).toBe('string')
  })
})

describe('voiceUnknownEvents — the honest gap, in one sentence', () => {
  it('says nothing about a recording this era understood completely', () => {
    expect(voiceUnknownEvents([])).toBeNull()
  })

  it('speaks the ruling\'s own sentence, in the singular', () => {
    expect(voiceUnknownEvents([unknownFrom(FUTURE_LINE)])).toBe(
      '1 event from a newer era was preserved but not understood (summons.raised)',
    )
  })

  it('speaks it in the plural, naming the types', () => {
    const voice = voiceUnknownEvents([
      unknownFrom(FUTURE_LINE),
      unknownFrom('{"id":"e2","ts":6,"source":"system","type":"operator.ack","payload":{}}'),
      unknownFrom('{"id":"e3","ts":7,"source":"system","type":"operator.ack","payload":{}}'),
    ])
    expect(voice).toBe(
      '3 events from a newer era were preserved but not understood (operator.ack, summons.raised)',
    )
  })

  it('is deterministic — the same unknowns in any read order voice the same sentence', () => {
    const a = unknownFrom(FUTURE_LINE)
    const b = unknownFrom('{"id":"e2","ts":6,"source":"system","type":"operator.ack","payload":{}}')
    expect(voiceUnknownEvents([a, b])).toBe(voiceUnknownEvents([b, a]))
  })

  it('caps the named types rather than running off the end of a banner', () => {
    const unknowns = ['a.one', 'b.two', 'c.three', 'd.four', 'e.five', 'f.six'].map((type, at) =>
      unknownFrom(`{"id":"e${at}","ts":${at + 1},"source":"system","type":"${type}","payload":{}}`),
    )
    expect(voiceUnknownEvents(unknowns)).toBe(
      '6 events from a newer era were preserved but not understood (a.one, b.two, c.three, d.four, +2 more)',
    )
  })
})
