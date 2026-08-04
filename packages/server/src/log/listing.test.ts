import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createEventFactory, eventsToJsonl } from '@rhizomorph/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeSessionLabel } from './label.js'
import { buildSessionListing, listSessionListings } from './listing.js'
import { sessionFileName } from './paths.js'

describe('buildSessionListing', () => {
  it('auto-titles a session with no label', () => {
    const f = createEventFactory({ startTs: Date.parse('2026-08-04T10:00:00Z') })
    f.sessionStarted()
    f.worktreeDiscovered({ path: '/repo', branch: 'main', isMain: true })

    const listing = buildSessionListing(
      { id: '1000', fileName: 'session-1000.jsonl', startedAt: Date.parse('2026-08-04T10:00:00Z'), sizeBytes: 10 },
      f.all(),
      null,
    )

    expect(listing.label).toBeNull()
    expect(listing.title).toBe('2026-08-04 · no activity recorded')
  })

  it('a label wins over the auto-title', () => {
    const f = createEventFactory({ startTs: Date.parse('2026-08-04T10:00:00Z') })
    f.sessionStarted()

    const listing = buildSessionListing(
      { id: '1000', fileName: 'session-1000.jsonl', startedAt: Date.parse('2026-08-04T10:00:00Z'), sizeBytes: 10 },
      f.all(),
      'the scene lands',
    )

    expect(listing.label).toBe('the scene lands')
    expect(listing.title).toBe('the scene lands')
  })

  it('computes duration from the earliest to the latest event', () => {
    const f = createEventFactory({ startTs: 1000, stepMs: 500 })
    f.sessionStarted()
    f.worktreeDiscovered({ path: '/repo', branch: 'main', isMain: true })
    f.worktreeDiscovered({ path: '/repo-wt/a', branch: 'a', isMain: false })

    const listing = buildSessionListing(
      { id: '1000', fileName: 'session-1000.jsonl', startedAt: 1000, sizeBytes: 10 },
      f.all(),
      null,
    )
    expect(listing.durationMs).toBe(1000)
  })

  it('reports zero duration for a session with no events', () => {
    const listing = buildSessionListing(
      { id: '1000', fileName: 'session-1000.jsonl', startedAt: 1000, sizeBytes: 0 },
      [],
      null,
    )
    expect(listing.durationMs).toBe(0)
  })
})

describe('listSessionListings', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-listing-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('lists every session on disk, each with its own title', async () => {
    await mkdir(dir, { recursive: true })

    const f1 = createEventFactory({ startTs: 1000 })
    f1.sessionStarted({ sessionId: '1000' })
    await writeFile(path.join(dir, sessionFileName(1000)), eventsToJsonl(f1.all()), 'utf8')

    const f2 = createEventFactory({ startTs: 2000 })
    f2.sessionStarted({ sessionId: '2000' })
    f2.worktreeDiscovered({ path: '/repo', branch: 'main', isMain: true })
    f2.worktreeDiscovered({ path: '/repo-wt/144-thing', branch: '144-thing', isMain: false })
    await writeFile(path.join(dir, sessionFileName(2000)), eventsToJsonl(f2.all()), 'utf8')

    const listings = await listSessionListings(dir)
    expect(listings.map((l) => l.id)).toEqual(['1000', '2000'])
    expect(listings[0]?.title).toBe('1970-01-01 · no activity recorded')
    expect(listings[1]?.title).toBe('1970-01-01 · 1 lane · 0 landed · #144')
  })

  it('picks up a label sidecar for the session it belongs to', async () => {
    await mkdir(dir, { recursive: true })
    const f = createEventFactory({ startTs: 1000 })
    f.sessionStarted({ sessionId: '1000' })
    await writeFile(path.join(dir, sessionFileName(1000)), eventsToJsonl(f.all()), 'utf8')
    await writeSessionLabel(dir, '1000', 'operator label', 5000)

    const [listing] = await listSessionListings(dir)
    expect(listing?.label).toBe('operator label')
    expect(listing?.title).toBe('operator label')
  })

  it('reads the live session from the supplied events instead of disk', async () => {
    await mkdir(dir, { recursive: true })
    // Deliberately write nothing (or something stale) to disk for the live session —
    // the in-memory events are what must win.
    await writeFile(path.join(dir, sessionFileName(3000)), '', 'utf8')

    const liveEvents = createEventFactory({ startTs: 3000 })
    liveEvents.sessionStarted({ sessionId: '3000' })
    liveEvents.worktreeDiscovered({ path: '/repo', branch: 'main', isMain: true })
    liveEvents.worktreeDiscovered({ path: '/repo-wt/9-thing', branch: '9-thing', isMain: false })

    const [listing] = await listSessionListings(dir, {
      liveSessionId: '3000',
      liveEvents: liveEvents.all(),
    })
    expect(listing?.lanes).toBe(1)
    expect(listing?.title).toContain('#9')
  })

  it('returns an empty list for a repo with no recordings yet', async () => {
    expect(await listSessionListings(dir)).toEqual([])
  })
})
