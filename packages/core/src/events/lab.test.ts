import { describe, expect, it } from 'vitest'
import { createEvent, parseEvent, rhizomorphEventSchema } from './index.js'
import { forkCheckpointPayloadSchema, forkDispatchedPayloadSchema, forkMeasuredPayloadSchema } from './lab.js'

const DIGEST = 'a'.repeat(64)

function validPayload() {
  return {
    lane: '148-lab-checkpoint',
    checkpointId: 'ckpt-1',
    eventIndex: 12,
    sessionFile: '/home/x/.claude/projects/-repo-wt-148/session.jsonl',
    sessionCutByte: 11_840,
    sessionDigest: DIGEST,
    snapshotRef: 'refs/rhizomorph/checkpoints/ckpt-1',
    snapshotSha: 'abc123',
    headSha: 'def456',
    capturedBy: 'operator' as const,
  }
}

describe('fork.checkpoint', () => {
  it('accepts a valid payload', () => {
    expect(forkCheckpointPayloadSchema.safeParse(validPayload()).success).toBe(true)
  })

  it('stamps source "lab" — the second hand, not a collector', () => {
    const event = createEvent('fork.checkpoint', validPayload(), { id: 'evt-1', ts: 1 })
    expect(event.source).toBe('lab')
    expect(rhizomorphEventSchema.safeParse(event).success).toBe(true)
  })

  it('rejects a capturedBy outside dispatch|gate|operator', () => {
    const bad = { ...validPayload(), capturedBy: 'human' }
    expect(forkCheckpointPayloadSchema.safeParse(bad).success).toBe(false)
  })

  it('rejects a snapshotRef outside refs/rhizomorph/checkpoints/ — the write fence, enforced at the schema', () => {
    const bad = { ...validPayload(), snapshotRef: 'refs/heads/main' }
    expect(forkCheckpointPayloadSchema.safeParse(bad).success).toBe(false)
  })

  it('rejects a sessionDigest that is not a sha256 hex digest', () => {
    const bad = { ...validPayload(), sessionDigest: 'not-a-digest' }
    expect(forkCheckpointPayloadSchema.safeParse(bad).success).toBe(false)
  })

  it('rejects a negative eventIndex or sessionCutByte', () => {
    expect(forkCheckpointPayloadSchema.safeParse({ ...validPayload(), eventIndex: -1 }).success).toBe(false)
    expect(forkCheckpointPayloadSchema.safeParse({ ...validPayload(), sessionCutByte: -1 }).success).toBe(false)
  })

  it('rejects a source other than "lab" for this type', () => {
    const result = parseEvent({
      id: 'evt-1',
      ts: 1,
      source: 'system',
      type: 'fork.checkpoint',
      payload: validPayload(),
    })
    expect(result.ok).toBe(false)
  })

  it('round-trips through parseEvent', () => {
    const event = createEvent('fork.checkpoint', validPayload(), { id: 'evt-1', ts: 1 })
    const result = parseEvent(event)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.event).toEqual(event)
  })
})

function validDispatch() {
  return {
    forkId: 'fork-1',
    parentLane: '148-lab-checkpoint',
    checkpointId: 'ckpt-1',
    arm: 1,
    treatment: { model: 'opus', promptDigest: DIGEST },
    laneHandle: 'fork-1-arm-1',
    worktreePath: '/home/x/.local/share/rhizomorph/lab/worktrees/fork-1/arm-1',
  }
}

describe('fork.dispatched', () => {
  it('accepts a valid payload', () => {
    expect(forkDispatchedPayloadSchema.safeParse(validDispatch()).success).toBe(true)
  })

  it('accepts a control arm — neither model nor prompt varied', () => {
    const control = { ...validDispatch(), treatment: { model: null, promptDigest: null } }
    expect(forkDispatchedPayloadSchema.safeParse(control).success).toBe(true)
  })

  it('stamps source "lab" — the same second hand as the checkpoint, not a collector', () => {
    const event = createEvent('fork.dispatched', validDispatch(), { id: 'evt-1', ts: 1 })
    expect(event.source).toBe('lab')
    expect(rhizomorphEventSchema.safeParse(event).success).toBe(true)
  })

  it('refuses an arm that claims its own parent lane — the mark-synthetic clause, enforced at the schema', () => {
    const bad = { ...validDispatch(), laneHandle: '148-lab-checkpoint' }
    expect(forkDispatchedPayloadSchema.safeParse(bad).success).toBe(false)
  })

  it('rejects arm 0 and a negative arm — arms are 1-based', () => {
    expect(forkDispatchedPayloadSchema.safeParse({ ...validDispatch(), arm: 0 }).success).toBe(false)
    expect(forkDispatchedPayloadSchema.safeParse({ ...validDispatch(), arm: -1 }).success).toBe(false)
  })

  it('accepts a run number and rejects run 0, a negative run and a fractional run — runs are 1-based like arms (prd53 ruling 1)', () => {
    expect(forkDispatchedPayloadSchema.safeParse({ ...validDispatch(), run: 2 }).success).toBe(true)
    expect(forkDispatchedPayloadSchema.safeParse({ ...validDispatch(), run: 0 }).success).toBe(false)
    expect(forkDispatchedPayloadSchema.safeParse({ ...validDispatch(), run: -1 }).success).toBe(false)
    expect(forkDispatchedPayloadSchema.safeParse({ ...validDispatch(), run: 1.5 }).success).toBe(false)
  })

  it('still accepts a record with no run at all — every fork.dispatched written before prd53 parses unchanged, and carries no invented run', () => {
    const parsed = forkDispatchedPayloadSchema.safeParse(validDispatch())
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.run).toBeUndefined()
  })

  it('rejects a promptDigest that is not a sha256 hex digest', () => {
    const bad = { ...validDispatch(), treatment: { model: 'opus', promptDigest: 'nope' } }
    expect(forkDispatchedPayloadSchema.safeParse(bad).success).toBe(false)
  })

  it('rejects a missing treatment — an arm with no declared treatment is not a treatment arm', () => {
    const { treatment: _omitted, ...bad } = validDispatch()
    expect(forkDispatchedPayloadSchema.safeParse(bad).success).toBe(false)
  })

  it('rejects a source other than "lab" for this type', () => {
    const result = parseEvent({
      id: 'evt-1',
      ts: 1,
      source: 'workmux',
      type: 'fork.dispatched',
      payload: validDispatch(),
    })
    expect(result.ok).toBe(false)
  })

  it('round-trips through parseEvent', () => {
    const event = createEvent('fork.dispatched', validDispatch(), { id: 'evt-1', ts: 1 })
    const result = parseEvent(event)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.event).toEqual(event)
  })

  it('accepts a declared ceiling override, refuses a zero or fractional one, and carries none when absent (prd53 ruling 6)', () => {
    expect(forkDispatchedPayloadSchema.safeParse({ ...validDispatch(), ceilingOverride: 12 }).success).toBe(true)
    expect(forkDispatchedPayloadSchema.safeParse({ ...validDispatch(), ceilingOverride: 0 }).success).toBe(false)
    expect(forkDispatchedPayloadSchema.safeParse({ ...validDispatch(), ceilingOverride: 2.5 }).success).toBe(false)
    const parsed = forkDispatchedPayloadSchema.safeParse(validDispatch())
    if (parsed.success) expect(parsed.data.ceilingOverride).toBeUndefined()
  })
})

function validMeasured() {
  return {
    forkId: 'fork-1',
    laneHandle: 'fork-1-arm-1',
    arm: 1,
    run: 1,
    verified: 'pass' as const,
    verifiedDetail: null,
    verifyCommand: 'npm test',
    commits: 2,
    source: 'measure-route' as const,
  }
}

describe('fork.measured (prd53 ruling 3 — measuring is a write)', () => {
  it('accepts a passing, a failing and a not-run outcome — not-run is legal, nothing is invented in its place', () => {
    expect(forkMeasuredPayloadSchema.safeParse(validMeasured()).success).toBe(true)
    expect(forkMeasuredPayloadSchema.safeParse({ ...validMeasured(), verified: 'fail', verifiedDetail: '1 test failed' }).success).toBe(true)
    expect(forkMeasuredPayloadSchema.safeParse({ ...validMeasured(), verified: 'not-run', verifiedDetail: 'npm: not found', commits: null }).success).toBe(true)
  })

  it('refuses an outcome outside pass|fail|not-run, and a source outside the two hands that may measure', () => {
    expect(forkMeasuredPayloadSchema.safeParse({ ...validMeasured(), verified: 'maybe' }).success).toBe(false)
    expect(forkMeasuredPayloadSchema.safeParse({ ...validMeasured(), source: 'a-collector' }).success).toBe(false)
  })

  it('refuses an outcome with no verify command — a verdict means nothing without the gate that gave it', () => {
    expect(forkMeasuredPayloadSchema.safeParse({ ...validMeasured(), verifyCommand: '' }).success).toBe(false)
  })

  it('stamps source "lab", rejects any other source, and round-trips through parseEvent', () => {
    const event = createEvent('fork.measured', validMeasured(), { id: 'evt-m', ts: 5 })
    expect(event.source).toBe('lab')
    expect(rhizomorphEventSchema.safeParse(event).success).toBe(true)
    expect(parseEvent({ ...event, source: 'workmux' }).ok).toBe(false)
    const result = parseEvent(event)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.event).toEqual(event)
  })
})
