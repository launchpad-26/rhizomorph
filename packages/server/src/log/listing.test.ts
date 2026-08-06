import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createEventFactory, eventsToJsonl, type RhizomorphEvent } from '@rhizomorph/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeSessionLabel } from './label.js'
import { buildSessionListing, listSessionListings, type SessionListingLog } from './listing.js'
import { sessionFileName } from './paths.js'
import { LARGE_SESSION_BYTES } from './session-log.js'
import { captureSessionTranscripts } from './transcript-capture.js'

/** A log with every line clean — no unreadable lines, one line per event. */
function cleanLog(events: readonly RhizomorphEvent[]): SessionListingLog {
  return { events, lineCount: events.length, unreadableLineCount: 0 }
}

describe('buildSessionListing', () => {
  it('auto-titles a session with no label', () => {
    const f = createEventFactory({ startTs: Date.parse('2026-08-04T10:00:00Z') })
    f.sessionStarted()
    f.worktreeDiscovered({ path: '/repo', branch: 'main', isMain: true })

    const listing = buildSessionListing(
      { id: '1000', fileName: 'session-1000.jsonl', startedAt: Date.parse('2026-08-04T10:00:00Z'), sizeBytes: 10 },
      cleanLog(f.all()),
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
      cleanLog(f.all()),
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
      cleanLog(f.all()),
      null,
    )
    expect(listing.durationMs).toBe(1000)
  })

  it('reports zero duration for a session with no events', () => {
    const listing = buildSessionListing(
      { id: '1000', fileName: 'session-1000.jsonl', startedAt: 1000, sizeBytes: 0 },
      cleanLog([]),
      null,
    )
    expect(listing.durationMs).toBe(0)
  })

  it('reports the log its own size: lines and bytes, never a silent drop of what it counted', () => {
    const f = createEventFactory({ startTs: 1000 })
    f.sessionStarted()
    f.worktreeDiscovered({ path: '/repo', branch: 'main', isMain: true })

    const listing = buildSessionListing(
      { id: '1000', fileName: 'session-1000.jsonl', startedAt: 1000, sizeBytes: 10 },
      { events: f.all(), lineCount: 2, unreadableLineCount: 0 },
      null,
    )
    expect(listing.lineCount).toBe(2)
    expect(listing.unreadableLineCount).toBe(0)
    expect(listing.unreadableLinesVoice).toBeNull()
  })

  it('voices unreadable lines instead of dropping them silently', () => {
    const listing = buildSessionListing(
      { id: '1000', fileName: 'session-1000.jsonl', startedAt: 1000, sizeBytes: 10 },
      { events: [], lineCount: 3, unreadableLineCount: 3 },
      null,
    )
    expect(listing.unreadableLineCount).toBe(3)
    expect(listing.unreadableLinesVoice).toBe('could not read 3 lines')
  })

  it('voices a single unreadable line in the singular', () => {
    const listing = buildSessionListing(
      { id: '1000', fileName: 'session-1000.jsonl', startedAt: 1000, sizeBytes: 10 },
      { events: [], lineCount: 1, unreadableLineCount: 1 },
      null,
    )
    expect(listing.unreadableLinesVoice).toBe('could not read 1 line')
  })

  it('says nothing about size under the large-session threshold', () => {
    const listing = buildSessionListing(
      { id: '1000', fileName: 'session-1000.jsonl', startedAt: 1000, sizeBytes: LARGE_SESSION_BYTES - 1 },
      cleanLog([]),
      null,
    )
    expect(listing.largeSessionNotice).toBeNull()
  })

  it('voices a large recording by its size in MB, never a hard cap or auto-rotation', () => {
    const listing = buildSessionListing(
      { id: '1000', fileName: 'session-1000.jsonl', startedAt: 1000, sizeBytes: 8 * 1024 * 1024 },
      cleanLog([]),
      null,
    )
    expect(listing.largeSessionNotice).toBe('this recording is large (8 MB); replay may take a moment')
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

  it('counts lines and voices unreadable ones instead of silently shrinking the session', async () => {
    await mkdir(dir, { recursive: true })
    const f = createEventFactory({ startTs: 1000 })
    f.sessionStarted({ sessionId: '1000' })
    f.worktreeDiscovered({ path: '/repo', branch: 'main', isMain: true })
    const goodLines = eventsToJsonl(f.all()).trimEnd()
    // A line from an era this build has never heard of — intact envelope, unknown type.
    const unknownLine = JSON.stringify({ id: 'evt-future', ts: 1500, source: 'future', type: 'future.event', payload: {} })
    await writeFile(path.join(dir, sessionFileName(1000)), `${goodLines}\n${unknownLine}\n`, 'utf8')

    const [listing] = await listSessionListings(dir)
    expect(listing?.lineCount).toBe(3)
    expect(listing?.unreadableLineCount).toBe(1)
    expect(listing?.unreadableLinesVoice).toBe('could not read 1 line')
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
    // The live buffer only ever holds events that already passed validation — nothing to count as unreadable.
    expect(listing?.lineCount).toBe(liveEvents.all().length)
    expect(listing?.unreadableLineCount).toBe(0)
  })

  it('returns an empty list for a repo with no recordings yet', async () => {
    expect(await listSessionListings(dir)).toEqual([])
  })

  it('is null when a session never captured any transcripts — never a bare "0 bytes"', async () => {
    await mkdir(dir, { recursive: true })
    const f = createEventFactory({ startTs: 1000 })
    f.sessionStarted({ sessionId: '1000' })
    await writeFile(path.join(dir, sessionFileName(1000)), eventsToJsonl(f.all()), 'utf8')

    const [listing] = await listSessionListings(dir)
    expect(listing?.transcriptCapture).toBeNull()
  })

  it('surfaces a closed session\'s capture manifest — size and an honest gap voice, not silence', async () => {
    await mkdir(dir, { recursive: true })
    const f = createEventFactory({ startTs: 1000 })
    f.sessionStarted({ sessionId: '1000' })
    f.llmUsage({ lane: 'a-lane', branch: 'a-lane', sessionId: 'claude-sess', worktreePath: '/wt/a-lane' })
    const events = f.all()
    await writeFile(path.join(dir, sessionFileName(1000)), eventsToJsonl(events), 'utf8')

    // No live transcript was ever on disk for this lane by the time it was captured.
    await captureSessionTranscripts({
      events,
      sessionDir: dir,
      sessionId: '1000',
      claudeProjectsRoot: await mkdtemp(path.join(tmpdir(), 'rhizomorph-listing-claude-')),
      now: 5000,
    })

    const [listing] = await listSessionListings(dir)
    expect(listing?.transcriptCapture?.complete).toBe(false)
    expect(listing?.transcriptCapture?.lanes[0]?.reason).toContain('TRANSCRIPT NOT CAPTURED')
  })
})
