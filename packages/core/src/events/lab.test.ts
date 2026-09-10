import { describe, expect, it } from 'vitest'
import { createEvent, parseEvent, rhizomorphEventSchema } from './index.js'
import {
  forkCheckpointPayloadSchema,
  forkDispatchedPayloadSchema,
  forkMeasuredPayloadSchema,
  rdOverridePayloadSchema,
  rdPatternSchema,
  rdPatternsPayloadSchema,
  rdProposalContentSchema,
  rdProposalPayloadSchema,
  rdRefusedPayloadSchema,
  rdResultSchema,
} from './lab.js'

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

// --- prd55 wave 5 — the R&D hand's four events -------------------------------

const PROVENANCE = {
  model: 'claude-opus-5',
  total_cost_usd: 0.42,
  duration_ms: 9_400,
  promptDigest: DIGEST,
  corpusDigest: 'e'.repeat(64),
  claudeVersion: '2.1.0',
  corpus: 'local' as const,
}

function livePattern(overrides: Partial<Parameters<typeof rdPatternSchema.safeParse>[0]> = {}) {
  return { patternId: 'pattern-1', shape: 'flaky timing assertion', sourceItems: ['retro-1', 'retro-2'], count: 2, heldBack: false, ...overrides }
}

describe('rdPatternSchema (prd55 ruling 3)', () => {
  it('accepts a live pattern and a held-back one', () => {
    expect(rdPatternSchema.safeParse(livePattern()).success).toBe(true)
    expect(rdPatternSchema.safeParse({ ...livePattern(), sourceItems: ['retro-1'], count: 1, heldBack: true }).success).toBe(true)
  })

  /**
   * THE MUTATION, EXECUTED: `.refine((pattern) => pattern.heldBack ===
   * isHeldBack(pattern.count), …)` replaced with `.refine(() => true, …)` in
   * `events/lab.ts`, then `npx vitest run src/events/lab.test.ts` — exactly
   * this one test went red (48 of 49 stayed green). Restored immediately
   * after.
   */
  it('refuses heldBack disagreeing with count — the schema enforces isHeldBack itself', () => {
    expect(rdPatternSchema.safeParse({ ...livePattern(), count: 1, heldBack: false }).success).toBe(false)
    expect(rdPatternSchema.safeParse({ ...livePattern(), count: 5, heldBack: true }).success).toBe(false)
  })

  it('refuses an empty sourceItems array — a pattern names what it groups', () => {
    expect(rdPatternSchema.safeParse({ ...livePattern(), sourceItems: [] }).success).toBe(false)
  })
})

function oneDimensionArms() {
  return [
    { model: 'opus', briefDigest: null, checkpointId: null, gateCommand: null },
    { model: 'sonnet', briefDigest: null, checkpointId: null, gateCommand: null },
  ]
}

function twoDimensionArms() {
  return [
    { model: 'opus', briefDigest: 'a'.repeat(64), checkpointId: null, gateCommand: null },
    { model: 'sonnet', briefDigest: 'b'.repeat(64), checkpointId: null, gateCommand: null },
  ]
}

function validProposalContent() {
  return {
    proposalId: 'proposal-1',
    patternId: 'pattern-1',
    varies: 'model' as const,
    arms: oneDimensionArms(),
    checkpointPick: { chosenCheckpointId: 'ckpt-1', rejected: [{ checkpointId: 'ckpt-0', reason: 'predates the fix' }] },
  }
}

describe('rdProposalContentSchema (prd55 ruling 3 — a proposal varies exactly one thing)', () => {
  it('accepts a clean, single-dimension proposal with 2 or 3 arms', () => {
    expect(rdProposalContentSchema.safeParse(validProposalContent()).success).toBe(true)
    expect(rdProposalContentSchema.safeParse({ ...validProposalContent(), arms: [...oneDimensionArms(), { model: 'haiku', briefDigest: null, checkpointId: null, gateCommand: null }] }).success).toBe(true)
  })

  /**
   * THE MUTATION, EXECUTED: `rdProposalContentSchema`'s `.refine(
   * hasAtMostOneVaryingDimension, …)` call dropped in `events/lab.ts` (the
   * schema fell back to the bare `rdProposalShape`), then `npx vitest run
   * src/events/lab.test.ts` — this test and "refuses when any proposal
   * inside it is dirty" (the `rdResultSchema` suite below, which embeds this
   * schema) both went red; 47 of 49 stayed green. Restored immediately after.
   */
  it('refuses arms that differ in more than one dimension — the schema refuses a two-dimension proposal (mutation: dropping the .refine call lets this through)', () => {
    expect(rdProposalContentSchema.safeParse({ ...validProposalContent(), arms: twoDimensionArms() }).success).toBe(false)
  })

  it('refuses fewer than 2 arms and more than 3', () => {
    expect(rdProposalContentSchema.safeParse({ ...validProposalContent(), arms: [oneDimensionArms()[0]] }).success).toBe(false)
    expect(rdProposalContentSchema.safeParse({ ...validProposalContent(), arms: [...oneDimensionArms(), ...oneDimensionArms()] }).success).toBe(false)
  })

  it('refuses a varies dimension outside the closed vocabulary', () => {
    expect(rdProposalContentSchema.safeParse({ ...validProposalContent(), varies: 'brief-check' }).success).toBe(false)
  })
})

describe('rdResultSchema — the fixed shape of one R&D call, patterns and proposals together', () => {
  it('accepts a result with both, and an empty one', () => {
    expect(rdResultSchema.safeParse({ patterns: [livePattern()], proposals: [validProposalContent()] }).success).toBe(true)
    expect(rdResultSchema.safeParse({ patterns: [], proposals: [] }).success).toBe(true)
  })

  it('refuses when any proposal inside it is dirty', () => {
    expect(rdResultSchema.safeParse({ patterns: [livePattern()], proposals: [{ ...validProposalContent(), arms: twoDimensionArms() }] }).success).toBe(false)
  })
})

function validRdPatterns() {
  return { lane: 'feature', patterns: [livePattern()], provenance: PROVENANCE }
}

describe('rd.patterns', () => {
  it('accepts a valid payload and stamps source "lab"', () => {
    expect(rdPatternsPayloadSchema.safeParse(validRdPatterns()).success).toBe(true)
    const event = createEvent('rd.patterns', validRdPatterns(), { id: 'evt-1', ts: 1 })
    expect(event.source).toBe('lab')
    expect(rhizomorphEventSchema.safeParse(event).success).toBe(true)
  })

  it('refuses a missing provenance field — an rd.* event with no provenance is refused', () => {
    const { model: _omitted, ...badProvenance } = PROVENANCE
    expect(rdPatternsPayloadSchema.safeParse({ ...validRdPatterns(), provenance: badProvenance }).success).toBe(false)
  })

  it('rejects a source other than "lab" for this type', () => {
    expect(parseEvent({ id: 'e', ts: 1, source: 'system', type: 'rd.patterns', payload: validRdPatterns() }).ok).toBe(false)
  })

  it('round-trips through parseEvent, lossless', () => {
    const event = createEvent('rd.patterns', validRdPatterns(), { id: 'evt-1', ts: 1 })
    const result = parseEvent(event)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.event).toEqual(event)
  })
})

function validRdProposal() {
  return { lane: 'feature', ...validProposalContent(), provenance: PROVENANCE }
}

describe('rd.proposal', () => {
  it('accepts a valid payload and stamps source "lab"', () => {
    expect(rdProposalPayloadSchema.safeParse(validRdProposal()).success).toBe(true)
    const event = createEvent('rd.proposal', validRdProposal(), { id: 'evt-1', ts: 1 })
    expect(event.source).toBe('lab')
    expect(rhizomorphEventSchema.safeParse(event).success).toBe(true)
  })

  /**
   * THE MUTATION, EXECUTED: `rdProposalPayloadSchema`'s own `.refine(
   * hasAtMostOneVaryingDimension, …)` call dropped (while
   * `rdProposalContentSchema`'s stayed in place), then `npx vitest run
   * src/events/lab.test.ts` — exactly this one test went red (48 of 49
   * stayed green), proving the payload's check is a second gate rather than
   * inherited from the content schema alone. Restored immediately after.
   */
  it('refuses a two-dimension proposal at the payload level too — a second, independent gate', () => {
    expect(rdProposalPayloadSchema.safeParse({ ...validRdProposal(), arms: twoDimensionArms() }).success).toBe(false)
  })

  it('refuses a missing provenance field', () => {
    const { duration_ms: _omitted, ...badProvenance } = PROVENANCE
    expect(rdProposalPayloadSchema.safeParse({ ...validRdProposal(), provenance: badProvenance }).success).toBe(false)
  })

  it('round-trips through parseEvent, lossless', () => {
    const event = createEvent('rd.proposal', validRdProposal(), { id: 'evt-1', ts: 1 })
    const result = parseEvent(event)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.event).toEqual(event)
  })
})

function validRdRefused() {
  return {
    lane: 'feature',
    patternId: 'pattern-2',
    reason: 'this pattern is held back — a single occurrence is not yet a pattern, and testing a shape that may not recur spends real money',
    rawResultDigest: DIGEST,
    provenance: PROVENANCE,
  }
}

describe('rd.refused (prd55 ruling 9 — a refusal carries the reason and the raw result\'s digest, never a patched proposal)', () => {
  it('accepts a valid payload and stamps source "lab"', () => {
    expect(rdRefusedPayloadSchema.safeParse(validRdRefused()).success).toBe(true)
    const event = createEvent('rd.refused', validRdRefused(), { id: 'evt-1', ts: 1 })
    expect(event.source).toBe('lab')
    expect(rhizomorphEventSchema.safeParse(event).success).toBe(true)
  })

  it('refuses a rawResultDigest that is not a sha256 hex digest', () => {
    expect(rdRefusedPayloadSchema.safeParse({ ...validRdRefused(), rawResultDigest: 'not-a-digest' }).success).toBe(false)
  })

  it('refuses a missing provenance field', () => {
    const { corpus: _omitted, ...badProvenance } = PROVENANCE
    expect(rdRefusedPayloadSchema.safeParse({ ...validRdRefused(), provenance: badProvenance }).success).toBe(false)
  })

  it('round-trips through parseEvent, lossless', () => {
    const event = createEvent('rd.refused', validRdRefused(), { id: 'evt-1', ts: 1 })
    const result = parseEvent(event)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.event).toEqual(event)
  })
})

function validRdOverride() {
  return {
    lane: 'feature',
    proposalId: 'proposal-1',
    agentCheckpointId: 'ckpt-1',
    operatorCheckpointId: 'ckpt-2',
    provenance: PROVENANCE,
  }
}

describe('rd.override (prd55 ruling 4 — an override is never re-attributed to the agent)', () => {
  it('accepts a valid payload and stamps source "lab"', () => {
    expect(rdOverridePayloadSchema.safeParse(validRdOverride()).success).toBe(true)
    const event = createEvent('rd.override', validRdOverride(), { id: 'evt-1', ts: 1 })
    expect(event.source).toBe('lab')
    expect(rhizomorphEventSchema.safeParse(event).success).toBe(true)
  })

  it('names both checkpoints even when they could be confused — the record, not an inference', () => {
    const event = createEvent('rd.override', validRdOverride(), { id: 'evt-1', ts: 1 })
    expect(event.payload.agentCheckpointId).toBe('ckpt-1')
    expect(event.payload.operatorCheckpointId).toBe('ckpt-2')
  })

  it('refuses a missing provenance field', () => {
    const { claudeVersion: _omitted, ...badProvenance } = PROVENANCE
    expect(rdOverridePayloadSchema.safeParse({ ...validRdOverride(), provenance: badProvenance }).success).toBe(false)
  })

  it('round-trips through parseEvent, lossless', () => {
    const event = createEvent('rd.override', validRdOverride(), { id: 'evt-1', ts: 1 })
    const result = parseEvent(event)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.event).toEqual(event)
  })
})
