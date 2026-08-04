import { describe, expect, it } from 'vitest'
import { createEvent, parseEvent, rhizomorphEventSchema } from './index.js'
import { forkCheckpointPayloadSchema, forkDispatchedPayloadSchema } from './lab.js'

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
})
