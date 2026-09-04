import { describe, expect, it } from 'vitest'
import { createEvent, rhizomorphEventSchema } from './index.js'
import {
  operatorAckPayloadSchema,
  operatorNotePayloadSchema,
  operatorVerdictPayloadSchema,
} from './operator.js'

const SESSION = 'sess-a'
const ACK = { sessionId: SESSION, offset: 12, subject: 'summons:feature:awaiting-reply' }
const VERDICT = { sessionId: SESSION, offset: 13, subject: '219', verdict: 'approved' }
const NOTE = { sessionId: SESSION, offset: 14, subject: '219', text: 'Looks correct; landing.' }

/**
 * THE COORDINATE IS THE POINT — prd17 ruling 1's "seeing what", and the part
 * review found broken before it shipped (operator ruling, 2026-09-04).
 *
 * An act that cannot say WHERE in the record it was decided is not the thing
 * the ruling asked for, so both halves of the coordinate are pinned here: the
 * session must be present, and the position must be a whole line index. The
 * first draft carried the position alone, defined as a fold count, which
 * located nothing — `reduce()` restarts that count at a session boundary and
 * it counts folded events rather than written lines, so the same act read
 * differently in a later era.
 */
describe('the operator coordinate: sessionId + a whole line index', () => {
  it('rejects an act with no sessionId — a line index alone locates nothing', () => {
    const { sessionId: _dropped, ...withoutSession } = ACK
    expect(operatorAckPayloadSchema.safeParse(withoutSession).success).toBe(false)
  })

  it('rejects an empty sessionId', () => {
    expect(operatorAckPayloadSchema.safeParse({ ...ACK, sessionId: '' }).success).toBe(false)
  })

  it('rejects a fractional offset — a line index is a whole number of lines', () => {
    expect(operatorAckPayloadSchema.safeParse({ ...ACK, offset: 12.5 }).success).toBe(false)
  })

  it('rejects a negative offset', () => {
    expect(operatorAckPayloadSchema.safeParse({ ...ACK, offset: -1 }).success).toBe(false)
  })

  it('accepts offset 0 — the first line of a record is a real place to have decided', () => {
    expect(operatorAckPayloadSchema.safeParse({ ...ACK, offset: 0 }).success).toBe(true)
  })

  it('holds for every operator family, not just the ack', () => {
    for (const [schema, valid] of [
      [operatorVerdictPayloadSchema, VERDICT],
      [operatorNotePayloadSchema, NOTE],
    ] as const) {
      expect(schema.safeParse(valid).success).toBe(true)
      expect(schema.safeParse({ ...valid, offset: 1.5 }).success).toBe(false)
      const { sessionId: _dropped, ...withoutSession } = valid
      expect(schema.safeParse(withoutSession).success).toBe(false)
    }
  })
})

describe('operator.ack', () => {
  it('parses a valid payload', () => {
    expect(operatorAckPayloadSchema.safeParse(ACK).success).toBe(true)
  })

  it('round-trips through createEvent with source "operator"', () => {
    const event = createEvent('operator.ack', ACK, { id: 'evt-1', ts: 1000 })
    expect(event.source).toBe('operator')
    expect(rhizomorphEventSchema.safeParse(event).success).toBe(true)
  })

  it('rejects a missing offset — a decision event must carry what it saw', () => {
    const { offset: _offset, ...withoutOffset } = ACK
    expect(operatorAckPayloadSchema.safeParse(withoutOffset).success).toBe(false)
  })

  it('rejects a negative offset', () => {
    expect(operatorAckPayloadSchema.safeParse({ ...ACK, offset: -1 }).success).toBe(false)
  })
})

describe('operator.verdict', () => {
  it('parses a valid payload', () => {
    expect(operatorVerdictPayloadSchema.safeParse(VERDICT).success).toBe(true)
  })

  it('round-trips through createEvent with source "operator"', () => {
    const event = createEvent('operator.verdict', VERDICT, { id: 'evt-2', ts: 1000 })
    expect(event.source).toBe('operator')
    expect(rhizomorphEventSchema.safeParse(event).success).toBe(true)
  })

  it('rejects a missing offset, same as every operator family', () => {
    const { offset: _offset, ...withoutOffset } = VERDICT
    expect(operatorVerdictPayloadSchema.safeParse(withoutOffset).success).toBe(false)
  })
})

describe('operator.note', () => {
  it('parses a valid payload', () => {
    expect(operatorNotePayloadSchema.safeParse(NOTE).success).toBe(true)
  })

  it('round-trips through createEvent with source "operator"', () => {
    const event = createEvent('operator.note', NOTE, { id: 'evt-3', ts: 1000 })
    expect(event.source).toBe('operator')
    expect(rhizomorphEventSchema.safeParse(event).success).toBe(true)
  })

  it('rejects a missing offset, same as every operator family', () => {
    const { offset: _offset, ...withoutOffset } = NOTE
    expect(operatorNotePayloadSchema.safeParse(withoutOffset).success).toBe(false)
  })

  it('rejects an empty note', () => {
    expect(operatorNotePayloadSchema.safeParse({ ...NOTE, text: '' }).success).toBe(false)
  })
})

/**
 * The issue's Definition of done, stated verbatim: "Every operator family
 * carries the log offset it was decided against." Checked structurally
 * across all three, rather than trusting three separate hand-written schemas
 * to agree by accident.
 */
describe('every operator family carries the offset it was decided against', () => {
  it('offset is present in all three payload shapes', () => {
    for (const schema of [operatorAckPayloadSchema, operatorVerdictPayloadSchema, operatorNotePayloadSchema]) {
      expect(Object.keys(schema.shape)).toContain('offset')
    }
  })
})
