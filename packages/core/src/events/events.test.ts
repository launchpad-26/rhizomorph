import { describe, expect, it } from 'vitest'
import {
  EVENT_SOURCE_BY_TYPE,
  EVENT_TYPES,
  createEvent,
  createIdFactory,
  eventSourceSchema,
  isEventOfType,
  isObservatoryEvent,
  observatoryEventSchema,
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
    for (const type of EVENT_TYPES) {
      expect([...eventSourceSchema.options]).toContain(sourceOf(type))
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
    expect(observatoryEventSchema.safeParse({
      id: '',
      ts: 1,
      source: 'system',
      type: 'collector.error',
      payload: { collector: 'git', message: 'boom' },
    }).success).toBe(false)

    expect(observatoryEventSchema.safeParse({
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
      expect(isObservatoryEvent(event)).toBe(true)
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
    createEvent('collector.error', { collector: 'git', message: 'boom' }, { id: id(), ts: 2 }),
    createEvent('collector.disabled', { collector: 'workmux', reason: 'not installed' }, {
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
    createEvent('tool.activity', { lane: 'feat', tool: 'Bash' }, { id: id(), ts: 15 }),
    createEvent('telemetry.refused', {
      instance: 'other-observatory',
      expectedInstance: '1785458425389',
      count: 3,
    }, { id: id(), ts: 16 }),
  ]
}
