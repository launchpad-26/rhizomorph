import { createEventFactory } from '@rhizomorph/core'
import { describe, expect, it } from 'vitest'
import { autoTitle, computeSessionMeta } from './title.js'

describe('computeSessionMeta', () => {
  it('reports zero lanes for a session with only main discovered', () => {
    const f = createEventFactory({ startTs: 1000 })
    f.sessionStarted()
    f.worktreeDiscovered({ path: '/repo', branch: 'main', isMain: true })

    const meta = computeSessionMeta(f.all())
    expect(meta.lanes).toBe(0)
    expect(meta.landed).toBe(0)
    expect(meta.issues).toEqual([])
  })

  it('counts a lane that is still open as not landed', () => {
    const f = createEventFactory({ startTs: 1000 })
    f.sessionStarted()
    f.worktreeDiscovered({ path: '/repo', branch: 'main', isMain: true })
    f.worktreeDiscovered({ path: '/repo-wt/144-thing', branch: '144-thing', isMain: false })

    const meta = computeSessionMeta(f.all())
    expect(meta.lanes).toBe(1)
    expect(meta.landed).toBe(0)
    expect(meta.issues).toEqual(['144'])
  })

  it('counts a lane whose worktree was removed as landed', () => {
    const f = createEventFactory({ startTs: 1000 })
    f.sessionStarted()
    f.worktreeDiscovered({ path: '/repo', branch: 'main', isMain: true })
    f.worktreeDiscovered({ path: '/repo-wt/144-thing', branch: '144-thing', isMain: false })
    f.worktreeRemoved({ path: '/repo-wt/144-thing' })

    const meta = computeSessionMeta(f.all())
    expect(meta.lanes).toBe(1)
    expect(meta.landed).toBe(1)
    expect(meta.issues).toEqual(['144'])
  })

  it('dedupes and sorts issue numbers ascending regardless of lane order', () => {
    const f = createEventFactory({ startTs: 1000 })
    f.sessionStarted()
    f.worktreeDiscovered({ path: '/repo', branch: 'main', isMain: true })
    f.worktreeDiscovered({ path: '/repo-wt/152-b', branch: '152-b', isMain: false })
    f.worktreeDiscovered({ path: '/repo-wt/144-a', branch: '144-a', isMain: false })
    f.worktreeDiscovered({ path: '/repo-wt/144-a-again', branch: '144-a', isMain: false })

    const meta = computeSessionMeta(f.all())
    expect(meta.issues).toEqual(['144', '152'])
  })

  it('omits an issue number for a lane branch with no fenced-issue prefix', () => {
    const f = createEventFactory({ startTs: 1000 })
    f.sessionStarted()
    f.worktreeDiscovered({ path: '/repo', branch: 'main', isMain: true })
    f.worktreeDiscovered({ path: '/repo-wt/spike', branch: 'spike', isMain: false })

    const meta = computeSessionMeta(f.all())
    expect(meta.lanes).toBe(1)
    expect(meta.issues).toEqual([])
  })
})

describe('autoTitle', () => {
  it('reads "no activity recorded" for a session with no lanes', () => {
    expect(autoTitle(Date.parse('2026-08-04T10:00:00Z'), { lanes: 0, landed: 0, issues: [], outputTokens: 0, costUsd: 0, costIsAuthoritative: null }))
      .toBe('2026-08-04 · no activity recorded')
  })

  it('names lanes, landings and issue numbers', () => {
    const title = autoTitle(Date.parse('2026-08-04T10:00:00Z'), {
      lanes: 6,
      landed: 5,
      issues: ['144', '148', '152'],
      outputTokens: 0,
      costUsd: 0,
      costIsAuthoritative: null,
    })
    expect(title).toBe('2026-08-04 · 6 lanes · 5 landed · #144 #148 #152')
  })

  it('folds issue numbers beyond the display cap into a named overflow, never silently dropping them', () => {
    const title = autoTitle(Date.parse('2026-08-04T10:00:00Z'), {
      lanes: 8,
      landed: 8,
      issues: ['100', '101', '102', '103', '104'],
      outputTokens: 0,
      costUsd: 0,
      costIsAuthoritative: null,
    })
    expect(title).toBe('2026-08-04 · 8 lanes · 8 landed · #100 #101 #102 +2')
  })

  it('says "1 lane" not "1 lanes"', () => {
    const title = autoTitle(Date.parse('2026-08-04T10:00:00Z'), {
      lanes: 1,
      landed: 0,
      issues: [],
      outputTokens: 0,
      costUsd: 0,
      costIsAuthoritative: null,
    })
    expect(title).toBe('2026-08-04 · 1 lane · 0 landed')
  })

  it('is a pure function of startedAt and meta, never a guess from anything else', () => {
    const meta = { lanes: 2, landed: 1, issues: ['9'], outputTokens: 0, costUsd: 0, costIsAuthoritative: null }
    expect(autoTitle(Date.parse('2026-08-04T00:00:00Z'), meta)).toBe(
      autoTitle(Date.parse('2026-08-04T23:59:59Z'), meta),
    )
  })
})
