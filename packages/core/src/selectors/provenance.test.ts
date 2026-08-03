import { beforeEach, describe, expect, it } from 'vitest'
import { createEventFactory } from '../fixtures.js'
import { reduceAll } from '../reduce.js'
import { initialSessionState } from '../state.js'
import { selectFileProvenance, selectLaneTouches } from './provenance.js'

let f = createEventFactory()
beforeEach(() => {
  f = createEventFactory()
})

describe('selectLaneTouches', () => {
  it('is empty for a lane the log has never mentioned', () => {
    expect(selectLaneTouches(initialSessionState(), 'nobody')).toEqual([])
  })

  it('counts tool activity and commits on the lane\'s own branch, dearest touch first', () => {
    const state = reduceAll([
      f.toolActivity(
        { lane: 'feature', tool: 'Read', branch: 'feature', filePath: 'src/a.ts', toolUseId: 'toolu_1' },
        { ts: 100 },
      ),
      f.toolActivity(
        { lane: 'feature', tool: 'Edit', branch: 'feature', filePath: 'src/a.ts', toolUseId: 'toolu_2' },
        { ts: 200 },
      ),
      f.toolActivity(
        { lane: 'feature', tool: 'Edit', branch: 'feature', filePath: 'src/b.ts', toolUseId: 'toolu_3' },
        { ts: 150 },
      ),
      f.commitLanded(
        {
          sha: 'c1',
          branch: 'feature',
          files: [{ path: 'src/a.ts', status: 'modified' }, { path: 'src/c.ts', status: 'added' }],
        },
        { ts: 300 },
      ),
    ])

    const touches = selectLaneTouches(state, 'feature')
    expect(touches.map((t) => t.path)).toEqual(['src/a.ts', 'src/c.ts', 'src/b.ts'])

    const a = touches.find((t) => t.path === 'src/a.ts')!
    expect(a.toolCallCount).toBe(2)
    expect(a.commitCount).toBe(1)
    expect(a.lastTouchedAt).toBe(300)

    const c = touches.find((t) => t.path === 'src/c.ts')!
    expect(c.toolCallCount).toBe(0)
    expect(c.commitCount).toBe(1)

    const b = touches.find((t) => t.path === 'src/b.ts')!
    expect(b.toolCallCount).toBe(1)
    expect(b.commitCount).toBe(0)
  })

  it('never books another lane\'s tool activity or another branch\'s commits', () => {
    const state = reduceAll([
      f.toolActivity({ lane: 'other', tool: 'Edit', branch: 'other', filePath: 'src/x.ts' }, { ts: 100 }),
      f.commitLanded({ sha: 'c1', branch: 'other', files: [{ path: 'src/y.ts', status: 'added' }] }, { ts: 100 }),
    ])
    expect(selectLaneTouches(state, 'feature')).toEqual([])
  })

  it('still reports tool activity for a lane with no attributed branch yet', () => {
    const state = reduceAll([
      f.toolActivity({ lane: 'feature', tool: 'Bash', branch: undefined, filePath: null }, { ts: 100 }),
      f.toolActivity({ lane: 'feature', tool: 'Edit', branch: undefined, filePath: 'src/a.ts' }, { ts: 200 }),
    ])
    const touches = selectLaneTouches(state, 'feature')
    expect(touches).toEqual([{ path: 'src/a.ts', toolCallCount: 1, commitCount: 0, lastTouchedAt: 200 }])
  })
})

describe('selectFileProvenance', () => {
  it('returns an empty, gap-free chain for a path nothing ever touched', () => {
    const chain = selectFileProvenance(initialSessionState(), { path: 'src/nobody.ts' })
    expect(chain).toEqual({ path: 'src/nobody.ts', lane: null, toolCalls: [], commits: [], gap: null })
  })

  it('joins tool calls to a trace span by toolUseId, and lists commits that landed the file', () => {
    const state = reduceAll([
      f.toolActivity(
        { lane: 'feature', tool: 'Edit', branch: 'feature', filePath: 'src/a.ts', toolUseId: 'toolu_1' },
        { ts: 100 },
      ),
      f.traceSpan(
        {
          lane: 'feature',
          traceId: 'trace-1',
          spanId: 'span-1',
          kind: 'tool',
          name: 'claude_code.tool',
          toolName: 'Edit',
          toolUseId: 'toolu_1',
          startTs: 90,
          endTs: 110,
        },
        { ts: 111 },
      ),
      f.commitLanded(
        {
          sha: 'c1',
          branch: 'feature',
          message: 'feat: a',
          files: [{ path: 'src/a.ts', status: 'modified' }],
        },
        { ts: 200 },
      ),
    ])

    const chain = selectFileProvenance(state, { path: 'src/a.ts' })
    expect(chain.gap).toBeNull()
    expect(chain.toolCalls).toHaveLength(1)
    expect(chain.toolCalls[0]).toMatchObject({ tool: 'Edit', lane: 'feature', toolUseId: 'toolu_1' })
    expect(chain.toolCalls[0]!.span).toEqual({
      traceId: 'trace-1',
      spanId: 'span-1',
      kind: 'tool',
      startTs: 90,
      endTs: 110,
    })
    expect(chain.commits).toHaveLength(1)
    expect(chain.commits[0]).toMatchObject({ sha: 'c1', message: 'feat: a', branches: ['feature'] })
  })

  it('leaves span null when toolUseId carries no matching span, or is itself null (e.g. Bash)', () => {
    const state = reduceAll([
      f.toolActivity(
        { lane: 'feature', tool: 'Edit', filePath: 'src/a.ts', toolUseId: 'toolu_unmatched' },
        { ts: 100 },
      ),
      f.toolActivity({ lane: 'feature', tool: 'Bash', filePath: null, toolUseId: null }, { ts: 200 }),
    ])
    const chain = selectFileProvenance(state, { path: 'src/a.ts' })
    expect(chain.toolCalls).toHaveLength(1)
    expect(chain.toolCalls[0]!.span).toBeNull()
  })

  it('orders both lists chronologically, oldest first — a chain reads cause before effect', () => {
    const state = reduceAll([
      f.toolActivity({ lane: 'feature', tool: 'Write', filePath: 'src/a.ts' }, { ts: 300 }),
      f.toolActivity({ lane: 'feature', tool: 'Edit', filePath: 'src/a.ts' }, { ts: 100 }),
      f.toolActivity({ lane: 'feature', tool: 'Read', filePath: 'src/a.ts' }, { ts: 200 }),
      f.commitLanded({ sha: 'c2', branch: 'feature', files: [{ path: 'src/a.ts', status: 'modified' }] }, { ts: 500 }),
      f.commitLanded({ sha: 'c1', branch: 'feature', files: [{ path: 'src/a.ts', status: 'modified' }] }, { ts: 400 }),
    ])
    const chain = selectFileProvenance(state, { path: 'src/a.ts' })
    expect(chain.toolCalls.map((call) => call.tool)).toEqual(['Edit', 'Read', 'Write'])
    expect(chain.commits.map((commit) => commit.sha)).toEqual(['c1', 'c2'])
  })

  it('restricts tool calls to the given lane but never restricts commits by branch', () => {
    const state = reduceAll([
      f.toolActivity({ lane: 'feature-a', tool: 'Edit', filePath: 'src/a.ts' }, { ts: 100 }),
      f.toolActivity({ lane: 'feature-b', tool: 'Edit', filePath: 'src/a.ts' }, { ts: 150 }),
      // Landed on a branch neither lane above claims — still part of the file's history.
      f.commitLanded({ sha: 'c1', branch: 'main', files: [{ path: 'src/a.ts', status: 'modified' }] }, { ts: 200 }),
    ])
    const chain = selectFileProvenance(state, { path: 'src/a.ts', lane: 'feature-a' })
    expect(chain.toolCalls).toHaveLength(1)
    expect(chain.toolCalls[0]!.lane).toBe('feature-a')
    expect(chain.commits.map((c) => c.sha)).toEqual(['c1'])
  })

  it('flags the honest gap when a commit proves the file landed but no tool call joins to it', () => {
    const state = reduceAll([
      // pre-#145 history: filePath was never captured for this call.
      f.toolActivity({ lane: 'feature', tool: 'Edit', filePath: null }, { ts: 50 }),
      f.commitLanded({ sha: 'c1', branch: 'feature', files: [{ path: 'src/a.ts', status: 'modified' }] }, { ts: 100 }),
    ])
    const chain = selectFileProvenance(state, { path: 'src/a.ts' })
    expect(chain.toolCalls).toEqual([])
    expect(chain.commits).toHaveLength(1)
    expect(chain.gap).toEqual({ reason: 'no-tool-detail', detailAvailableFromTs: null })
  })

  it('dates the gap from the earliest filePath the whole log has seen, when one exists', () => {
    const state = reduceAll([
      f.toolActivity({ lane: 'feature', tool: 'Edit', filePath: null }, { ts: 50 }),
      f.commitLanded({ sha: 'c1', branch: 'feature', files: [{ path: 'src/a.ts', status: 'modified' }] }, { ts: 100 }),
      // A different file's tool call, post-#145 — proves when detail capture began.
      f.toolActivity({ lane: 'feature', tool: 'Edit', filePath: 'src/b.ts', toolUseId: 'toolu_9' }, { ts: 900 }),
    ])
    const chain = selectFileProvenance(state, { path: 'src/a.ts' })
    expect(chain.gap).toEqual({ reason: 'no-tool-detail', detailAvailableFromTs: 900 })
  })

  it('does not flag a gap when there is simply nothing to show at all', () => {
    const state = reduceAll([f.toolActivity({ lane: 'feature', tool: 'Bash', filePath: null }, { ts: 50 })])
    expect(selectFileProvenance(state, { path: 'src/never-landed.ts' }).gap).toBeNull()
  })
})
