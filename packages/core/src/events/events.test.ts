import { describe, expect, it } from 'vitest'
import {
  EVENT_SOURCE_BY_TYPE,
  EVENT_TYPES,
  createEvent,
  createIdFactory,
  eventSourceSchema,
  isEventOfType,
  isRhizomorphEvent,
  rhizomorphEventSchema,
  parseEvent,
  sourceOf,
} from './index.js'

describe('event envelope', () => {
  it('stamps source from type', () => {
    const event = createEvent(
      'worktree.discovered',
      { path: '/repo', branch: 'main', head: 'abc123', isMain: true },
      { id: 'evt-1', ts: 1000 },
    )
    expect(event).toEqual({
      id: 'evt-1',
      ts: 1000,
      source: 'git',
      type: 'worktree.discovered',
      payload: { path: '/repo', branch: 'main', head: 'abc123', isMain: true },
    })
  })

  it('covers every v0 type from the architecture doc', () => {
    // arrayContaining, not toEqual: prd1 adds telemetry types additively, and
    // the v0 twelve must survive that intact.
    expect([...EVENT_TYPES].sort()).toEqual(
      expect.arrayContaining(
        [
          'agent.status',
          'branch.updated',
          'collector.disabled',
          'collector.error',
          'commit.landed',
          'pane.activity',
          'pane.closed',
          'pane.discovered',
          'session.started',
          'worktree.dirty',
          'worktree.discovered',
          'worktree.removed',
        ].sort(),
      ),
    )
  })

  it('maps each type to exactly one declared source', () => {
    // prd12 ruling 1: 'lab' is the laboratory's own source — a second,
    // explicitly-invoked actor deliberately kept out of `eventSourceSchema`
    // (that enum means "which collector saw it"; the lab is not a
    // collector — see events/lab.ts). Declared here instead, so this stays
    // an exhaustive, closed check rather than one that got quietly loosened.
    // prd11 ruling 6b: 'judge' is out of `eventSourceSchema` too, but for a
    // narrower reason — it IS a collector, just declared outside this
    // issue's fence (see events/judge.ts).
    const knownSources: readonly string[] = [...eventSourceSchema.options, 'lab', 'judge']
    for (const type of EVENT_TYPES) {
      expect(knownSources).toContain(sourceOf(type))
      expect(EVENT_SOURCE_BY_TYPE[type]).toBe(sourceOf(type))
    }
  })

  it('throws when a collector builds an invalid payload', () => {
    expect(() =>
      createEvent(
        'commit.landed',
        // @ts-expect-error — a missing branch is exactly what validation is for
        { sha: 'abc', message: 'x', author: { name: 'a' }, files: [] },
        { id: 'evt-1', ts: 1 },
      ),
    ).toThrow()
  })

  it('rejects an empty id and a negative timestamp', () => {
    expect(rhizomorphEventSchema.safeParse({
      id: '',
      ts: 1,
      source: 'system',
      type: 'collector.error',
      payload: { collector: 'git', message: 'boom' },
    }).success).toBe(false)

    expect(rhizomorphEventSchema.safeParse({
      id: 'evt-1',
      ts: -1,
      source: 'system',
      type: 'collector.error',
      payload: { collector: 'git', message: 'boom' },
    }).success).toBe(false)
  })

  it('rejects a source that disagrees with its type', () => {
    const result = parseEvent({
      id: 'evt-1',
      ts: 1,
      source: 'tmux',
      type: 'commit.landed',
      payload: { sha: 'a', branch: 'main', message: 'm', author: { name: 'n' }, files: [] },
    })
    expect(result.ok).toBe(false)
  })

  it('reports readable issues instead of throwing', () => {
    const result = parseEvent({ id: 'evt-1', ts: 1, source: 'git', type: 'nope', payload: {} })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error).toContain('type')
    expect(result.issues.length).toBeGreaterThan(0)
  })

  it('parses a valid event of every type', () => {
    for (const event of oneOfEach()) {
      const result = parseEvent(event)
      expect(result.ok, `${event.type} should parse`).toBe(true)
      expect(isRhizomorphEvent(event)).toBe(true)
    }
    expect(oneOfEach().map((e) => e.type).sort()).toEqual([...EVENT_TYPES].sort())
  })

  it('narrows with isEventOfType', () => {
    const event = createEvent(
      'pane.activity',
      { paneId: '%1', contentHash: 'h1' },
      { id: 'evt-1', ts: 5 },
    )
    if (isEventOfType(event, 'pane.activity')) {
      expect(event.payload.contentHash).toBe('h1')
    } else {
      throw new Error('should have narrowed')
    }
    expect(isEventOfType(event, 'commit.landed')).toBe(false)
  })
})

/**
 * prd16 ruling 2 adds the recorder's third hand; prd17 ruling 1 names the
 * event it appends. The union-level facts that hand depends on, stated here
 * rather than in the server package that emits it: the close is a `system`
 * event about the log it terminates, and `reason` is closed — a reason nothing
 * can produce never enters a recording in the first place.
 */
describe('session.closed', () => {
  it('is a system event carrying the CLOSED session, its reason and its size', () => {
    const closed = createEvent(
      'session.closed',
      { sessionId: '1000', reason: 'rotated', eventCount: 42 },
      { id: 'session-closed-1000', ts: 2000 },
    )
    expect(closed).toEqual({
      id: 'session-closed-1000',
      ts: 2000,
      source: 'system',
      type: 'session.closed',
      payload: { sessionId: '1000', reason: 'rotated', eventCount: 42 },
    })
    expect(sourceOf('session.closed')).toBe('system')
  })

  it('refuses a reason the recorder cannot produce, and an event count of zero', () => {
    expect(
      parseEvent({
        id: 'e',
        ts: 1,
        source: 'system',
        type: 'session.closed',
        payload: { sessionId: '1000', reason: 'crashed' },
      }).ok,
    ).toBe(false)
    // A closed log holds at least the close event itself.
    expect(
      parseEvent({
        id: 'e',
        ts: 1,
        source: 'system',
        type: 'session.closed',
        payload: { sessionId: '1000', reason: 'rotated', eventCount: 0 },
      }).ok,
    ).toBe(false)
  })

  it('parses without an event count — an emitter that does not count still closes honestly', () => {
    expect(
      parseEvent({
        id: 'e',
        ts: 1,
        source: 'system',
        type: 'session.closed',
        payload: { sessionId: '1000', reason: 'rotated' },
      }).ok,
    ).toBe(true)
  })

  /**
   * prd20 ruling 5 (#384): switching the watched repo ends the session too,
   * and must never be recorded as a rotation — a rotation's successor is the
   * next log in the same directory, a retarget's is under another slug
   * entirely. Operator-decided 2026-08-10, at Q2 of the retarget spike.
   */
  it('accepts "retargeted" — prd20 ruling 5\'s second way for a session to end', () => {
    expect(
      parseEvent({
        id: 'e',
        ts: 1,
        source: 'system',
        type: 'session.closed',
        payload: { sessionId: '1000', reason: 'retargeted', eventCount: 42 },
      }).ok,
    ).toBe(true)
  })

  it('stayed ADDITIVE: every reason recorded before the widening still parses, and the enum is still closed', () => {
    // The reason this enum widens rather than changes (prd17 ruling 1). A log
    // written the day before #384 must read identically the day after it.
    expect(
      parseEvent({
        id: 'e',
        ts: 1,
        source: 'system',
        type: 'session.closed',
        payload: { sessionId: '1000', reason: 'rotated', eventCount: 42 },
      }).ok,
    ).toBe(true)
    // Widening is not opening: a reason nothing can produce still never
    // enters a recording.
    for (const reason of ['retarget', 'retargetted', 'RETARGETED', 'crashed', '']) {
      expect(
        parseEvent({
          id: 'e',
          ts: 1,
          source: 'system',
          type: 'session.closed',
          payload: { sessionId: '1000', reason },
        }).ok,
        `"${reason}" must not parse as a close reason`,
      ).toBe(false)
    }
  })
})

/**
 * THE RUN POINTER (#384) — one operator intent, two logs, and until now no
 * way to tell they were related. A rotation's successor is the next log in
 * the same directory; prd20 ruling 5's retarget puts it under a different
 * repo slug in a different directory, so the seam has to be written down or
 * it is lost. Nothing emits these yet (#385's `retargetSession` does); the
 * shape lands first, additively, so the vocabulary is one dateable change.
 */
describe('the predecessor/successor pointer', () => {
  it('lets a closed log name the slug dir its run continued in', () => {
    const parsed = parseEvent({
      id: 'session-closed-1000',
      ts: 2000,
      source: 'system',
      type: 'session.closed',
      payload: {
        sessionId: '1000',
        reason: 'retargeted',
        eventCount: 42,
        successor: { repoSlug: 'other-repo-9f8e7d6c' },
      },
    })
    expect(parsed.ok).toBe(true)
    // Asserted on the parsed payload, never on `ok` alone: an unknown key is
    // STRIPPED rather than refused, so a schema that had never heard of
    // `successor` would parse this event happily and drop the seam on the
    // floor — the exact silence this pointer exists to end.
    expect(parsed.ok && parsed.event.payload).toMatchObject({
      successor: { repoSlug: 'other-repo-9f8e7d6c' },
    })
  })

  it('lets the new log name both halves of where it came from — the close half cannot', () => {
    // The asymmetry is the ordering law's (`recorder/rotate.ts`): close, THEN
    // open. The successor's id is minted off the clock after the close has
    // already landed, so `session.closed` can only ever name the directory,
    // while `session.started` knows the id on the other side exactly.
    const parsed = parseEvent({
      id: 'session-started-2001',
      ts: 2001,
      source: 'system',
      type: 'session.started',
      payload: {
        sessionId: '2001',
        repoPath: '/repo/other',
        repoName: 'other',
        predecessor: { repoSlug: 'rhizomorph-abc12345', sessionId: '1000' },
      },
    })
    expect(parsed.ok).toBe(true)
    expect(parsed.ok && parsed.event.payload).toMatchObject({
      predecessor: { repoSlug: 'rhizomorph-abc12345', sessionId: '1000' },
    })
  })

  it('is absent, not empty, on a session that has no seam — no pointer is not a null pointer', () => {
    // An ordinary boot has no predecessor and an ordinary rotation has no
    // cross-directory successor. Saying so with a field would be inventing a
    // seam that never existed, so both stay off the payload entirely.
    const started = parseEvent({
      id: 'e',
      ts: 1,
      source: 'system',
      type: 'session.started',
      payload: { sessionId: '1000', repoPath: '/repo', repoName: 'repo' },
    })
    expect(started.ok).toBe(true)
    expect(started.ok && 'predecessor' in started.event.payload).toBe(false)

    const closed = parseEvent({
      id: 'e2',
      ts: 2,
      source: 'system',
      type: 'session.closed',
      payload: { sessionId: '1000', reason: 'rotated' },
    })
    expect(closed.ok).toBe(true)
    expect(closed.ok && 'successor' in closed.event.payload).toBe(false)
  })

  it('refuses a pointer that names nothing — a blank slug is worse than no pointer at all', () => {
    for (const successor of [{ repoSlug: '' }, { sessionId: '2001' }, {}, 'other-repo']) {
      expect(
        parseEvent({
          id: 'e',
          ts: 1,
          source: 'system',
          type: 'session.closed',
          payload: { sessionId: '1000', reason: 'retargeted', successor },
        }).ok,
        `${JSON.stringify(successor)} must not parse as a successor`,
      ).toBe(false)
    }
  })
})

/**
 * #472: `telemetry.refused`'s throttle coalesces repeated faults into one
 * event carrying a count instead of flooding the log; `collector.error`
 * needed the same field to do it for malformed-body faults. The round-trip
 * assertion below is also the regression guard the issue's own review named
 * as the mutation that matters most — remove `count` from the schema again
 * and this goes red because the field silently strips instead of surviving.
 */
describe('collector.error', () => {
  it('carries a count when the emitter coalesces repeated occurrences of the same fault', () => {
    const event = createEvent(
      'collector.error',
      { collector: 'otel', message: 'malformed OTLP request body', count: 47 },
      { id: 'e', ts: 1 },
    )
    expect(event).toEqual({
      id: 'e',
      ts: 1,
      source: 'system',
      type: 'collector.error',
      payload: { collector: 'otel', message: 'malformed OTLP request body', count: 47 },
    })
  })

  it('parses without a count — an emitter that never coalesces still records honestly', () => {
    expect(
      parseEvent({
        id: 'e',
        ts: 1,
        source: 'system',
        type: 'collector.error',
        payload: { collector: 'git', message: 'boom' },
      }).ok,
    ).toBe(true)
  })

  it('refuses a non-positive count — a coalesced event always stands for at least one occurrence', () => {
    expect(
      parseEvent({
        id: 'e',
        ts: 1,
        source: 'system',
        type: 'collector.error',
        payload: { collector: 'otel', message: 'm', count: 0 },
      }).ok,
    ).toBe(false)
  })
})

describe('createIdFactory', () => {
  it('produces padded, ordered, unique ids', () => {
    const next = createIdFactory()
    expect(next()).toBe('evt-000001')
    expect(next()).toBe('evt-000002')
    const other = createIdFactory('git', 10)
    expect(other()).toBe('git-000011')
  })
})

/** One valid event per type — also the guard that the union stays complete. */
function oneOfEach() {
  let n = 0
  const id = () => `evt-${(n += 1)}`
  return [
    createEvent('session.started', {
      sessionId: 's1',
      repoPath: '/repo',
      repoName: 'repo',
      mainBranch: 'main',
    }, { id: id(), ts: 1 }),
    // prd16 ruling 2 / prd17 ruling 1: the rotated-away log's final line.
    createEvent('session.closed', { sessionId: 's1', reason: 'rotated', eventCount: 7 }, {
      id: id(),
      ts: 2,
    }),
    createEvent('collector.error', { collector: 'git', message: 'boom' }, { id: id(), ts: 2 }),
    createEvent('collector.disabled', { collector: 'workmux', reason: 'not installed' }, {
      id: id(),
      ts: 3,
    }),
    createEvent(
      'collector.degraded',
      { collector: 'tmux', reason: 'tmux exited with code 1', consecutiveFailures: 1 },
      { id: id(), ts: 3 },
    ),
    createEvent('collector.recovered', { collector: 'tmux', consecutiveFailures: 2 }, {
      id: id(),
      ts: 3,
    }),
    createEvent('worktree.discovered', {
      path: '/repo',
      branch: 'main',
      head: 'a1',
      isMain: true,
    }, { id: id(), ts: 4 }),
    createEvent('worktree.removed', { path: '/repo/wt' }, { id: id(), ts: 5 }),
    createEvent('branch.updated', { branch: 'feat', head: 'b2', aheadOfMain: 3 }, {
      id: id(),
      ts: 6,
    }),
    createEvent('branch.removed', { branch: 'feat' }, { id: id(), ts: 6 }),
    createEvent('commit.landed', {
      sha: 'c3',
      branch: 'feat',
      message: 'feat: thing',
      author: { name: 'Lachlan', email: 'l@example.com' },
      files: [{ path: 'src/a.ts', status: 'modified', insertions: 2, deletions: 1 }],
      insertions: 2,
      deletions: 1,
    }, { id: id(), ts: 7 }),
    createEvent('worktree.dirty', {
      path: '/repo/wt',
      branch: 'feat',
      files: [{ path: 'src/a.ts', status: 'modified' }],
    }, { id: id(), ts: 8 }),
    createEvent('worktree.dirtyStatusFailed', {
      worktreePath: '/repo/wt',
      consecutiveFailures: 4,
      message: 'error: could not read index',
    }, { id: id(), ts: 8 }),
    createEvent('worktree.dirtyStatusRecovered', { worktreePath: '/repo/wt' }, { id: id(), ts: 8 }),
    createEvent('pane.discovered', {
      paneId: '%1',
      windowName: 'feat',
      currentPath: '/repo/wt',
      currentCommand: 'node',
      worktreePath: '/repo/wt',
    }, { id: id(), ts: 9 }),
    createEvent('pane.closed', { paneId: '%1' }, { id: id(), ts: 10 }),
    createEvent('pane.activity', { paneId: '%1', contentHash: 'h1', previousHash: 'h0' }, {
      id: id(),
      ts: 11,
    }),
    createEvent('agent.status', { handle: 'feat', status: 'working' }, { id: id(), ts: 12 }),
    createEvent('agent.removed', { handle: 'feat' }, { id: id(), ts: 12 }),
    createEvent('llm.usage', {
      lane: 'feat',
      role: 'worker',
      model: 'claude-opus-5',
      tokens: { input: 2, output: 1700, cacheRead: 99_700, cacheCreation: 1900 },
      requestId: 'req_1',
      durationMs: 9400,
      sessionId: 'sess-1',
    }, { id: id(), ts: 13 }),
    createEvent('llm.cost', {
      lane: 'feat',
      role: 'conductor',
      model: 'claude-sonnet-5',
      costUsd: 0.0588372,
      authoritative: true,
    }, { id: id(), ts: 14, source: 'otel' }),
    createEvent('tool.activity', { lane: 'feat', tool: 'Edit', filePath: 'src/a.ts', toolUseId: 'toolu_1' }, {
      id: id(),
      ts: 15,
    }),
    createEvent('telemetry.refused', {
      instance: 'other-rhizomorph',
      expectedInstance: '1785458425389',
      count: 3,
    }, { id: id(), ts: 16 }),
    // prd9's trace keystone. The allowlist and the laws are stated in
    // `trace.test.ts`; here it is just another member of the census.
    createEvent('trace.span', {
      lane: 'feat',
      role: 'worker',
      traceId: 'trace-1',
      spanId: 'span-1',
      parentSpanId: null,
      name: 'claude_code.interaction',
      kind: 'interaction',
      startTs: 17,
      endTs: 18,
      status: 'ok',
      sessionId: 'sess-1',
    }, { id: id(), ts: 19 }),
    // #141: OTel's ignored active-time counter, finally wired.
    createEvent('agent.activeTime', {
      lane: 'feat',
      role: 'worker',
      activeSeconds: 542,
      sessionId: 'sess-1',
    }, { id: id(), ts: 20 }),
    // prd12 ruling 2: the laboratory's keystone event, source 'lab'.
    createEvent('fork.checkpoint', {
      lane: 'feat',
      checkpointId: 'ckpt-1',
      eventIndex: 20,
      sessionFile: '/home/x/.claude/projects/-repo-wt-feat/session.jsonl',
      sessionCutByte: 4096,
      sessionDigest: 'a'.repeat(64),
      snapshotRef: 'refs/rhizomorph/checkpoints/ckpt-1',
      snapshotSha: 'snap1',
      headSha: 'head1',
      capturedBy: 'operator',
    }, { id: id(), ts: 21 }),
    // prd12 ruling 3, phase 2: one arm handed to workmux, source 'lab'.
    createEvent('fork.dispatched', {
      forkId: 'fork-1',
      parentLane: 'feat',
      checkpointId: 'ckpt-1',
      arm: 1,
      treatment: { model: 'opus', promptDigest: 'b'.repeat(64) },
      laneHandle: 'fork-1-arm-1',
      worktreePath: '/data/rhizomorph/lab/worktrees/fork-1/arm-1',
    }, { id: id(), ts: 21 }),
    // prd11 ruling 6b, phase 1: the judge organ's own keystone, source 'judge'.
    createEvent('judge.finding', {
      kind: 'symbol-overlap',
      lanes: ['2-core', '3-git'],
      evidence: { symbols: ['formatDuration'] },
      severity: 'log',
      detectedAt: 22,
    }, { id: id(), ts: 22 }),
    // prd17 ruling 1: the summons pair, source 'gate'.
    createEvent('summons.raised', { lane: 'feat', kind: 'awaiting-reply', raisedAt: 23 }, {
      id: id(),
      ts: 23,
    }),
    createEvent('summons.cleared', { lane: 'feat', kind: 'awaiting-reply', clearedAt: 24 }, {
      id: id(),
      ts: 24,
    }),
    // prd17 ruling 1: the instrument's own judgements, source 'gate'.
    createEvent('gate.verdict', {
      handle: 'feat',
      held: false,
      reason: 'clean',
      digest: 'a'.repeat(64),
    }, { id: id(), ts: 25 }),
    createEvent('dispatch.brief', { handle: 'feat', issue: 219, digest: 'b'.repeat(64) }, {
      id: id(),
      ts: 26,
    }),
    createEvent('fence.declared', { handle: 'feat', paths: ['packages/core/src/events/gate.ts'] }, {
      id: id(),
      ts: 27,
    }),
    // prd17 ruling 1: the operator's own hand, source 'operator'.
    createEvent('operator.ack', { sessionId: 'sess-a', offset: 27, subject: 'feat' }, {
      id: id(),
      ts: 28,
    }),
    createEvent('operator.verdict', { sessionId: 'sess-a', offset: 28, subject: '219', verdict: 'approved' }, {
      id: id(),
      ts: 29,
    }),
    createEvent('operator.note', { sessionId: 'sess-a', offset: 29, subject: '219', text: 'landing' }, {
      id: id(),
      ts: 30,
    }),
  ]
}
