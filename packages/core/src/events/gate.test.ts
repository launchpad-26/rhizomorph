import { describe, expect, it } from 'vitest'
import { createEvent, rhizomorphEventSchema } from './index.js'
import {
  dispatchBriefPayloadSchema,
  fenceDeclaredPayloadSchema,
  gateVerdictPayloadSchema,
} from './gate.js'

const DIGEST = 'a'.repeat(64)

const VERDICT = { handle: 'feature', held: false, reason: 'clean', digest: DIGEST }
const BRIEF = { handle: 'feature', issue: 219, digest: DIGEST }
const FENCE = { handle: 'feature', paths: ['packages/core/src/events/gate.ts'] }

describe('gate.verdict', () => {
  it('parses a valid payload', () => {
    expect(gateVerdictPayloadSchema.safeParse(VERDICT).success).toBe(true)
  })

  it('round-trips through createEvent with source "gate"', () => {
    const event = createEvent('gate.verdict', VERDICT, { id: 'evt-1', ts: 1000 })
    expect(event.source).toBe('gate')
    expect(rhizomorphEventSchema.safeParse(event).success).toBe(true)
  })

  it('rejects a digest that is not a sha256 hex string', () => {
    expect(gateVerdictPayloadSchema.safeParse({ ...VERDICT, digest: 'not-hex' }).success).toBe(false)
  })

  it('rejects a held that is not a boolean', () => {
    expect(gateVerdictPayloadSchema.safeParse({ ...VERDICT, held: 'yes' }).success).toBe(false)
  })

  it('carries the digest, never the gate output itself — sidecar-for-content', () => {
    expect(Object.keys(gateVerdictPayloadSchema.shape).sort()).toEqual(
      ['digest', 'handle', 'held', 'reason', 'loadBatches'].sort(),
    )
  })
})

describe('dispatch.brief', () => {
  it('parses a valid payload', () => {
    expect(dispatchBriefPayloadSchema.safeParse(BRIEF).success).toBe(true)
  })

  it('parses without an issue — a brief not closing one still dispatches honestly', () => {
    const { issue: _issue, ...withoutIssue } = BRIEF
    expect(dispatchBriefPayloadSchema.safeParse(withoutIssue).success).toBe(true)
  })

  it('round-trips through createEvent with source "gate"', () => {
    const event = createEvent('dispatch.brief', BRIEF, { id: 'evt-2', ts: 1000 })
    expect(event.source).toBe('gate')
    expect(rhizomorphEventSchema.safeParse(event).success).toBe(true)
  })

  it('carries the digest, never the brief text itself — sidecar-for-content', () => {
    expect(Object.keys(dispatchBriefPayloadSchema.shape).sort()).toEqual(
      ['digest', 'handle', 'issue', 'model'].sort(),
    )
  })
})

describe('fence.declared', () => {
  it('parses a valid payload', () => {
    expect(fenceDeclaredPayloadSchema.safeParse(FENCE).success).toBe(true)
  })

  it('round-trips through createEvent with source "gate"', () => {
    const event = createEvent('fence.declared', FENCE, { id: 'evt-3', ts: 1000 })
    expect(event.source).toBe('gate')
    expect(rhizomorphEventSchema.safeParse(event).success).toBe(true)
  })

  it('rejects an empty path list — a fence that declares nothing is not a fence', () => {
    expect(fenceDeclaredPayloadSchema.safeParse({ ...FENCE, paths: [] }).success).toBe(false)
  })

  /**
   * Unlike the verdict and the brief above, the fence carries its actual
   * content (the paths), not a digest — the issue's own "Why" names this
   * directly: a trespass can never be re-derived from a fingerprint.
   */
  it('carries the declared paths themselves, not a digest', () => {
    expect(Object.keys(fenceDeclaredPayloadSchema.shape).sort()).toEqual(['handle', 'paths'].sort())
    const parsed = fenceDeclaredPayloadSchema.parse(FENCE)
    expect(parsed.paths).toEqual(FENCE.paths)
  })
})
