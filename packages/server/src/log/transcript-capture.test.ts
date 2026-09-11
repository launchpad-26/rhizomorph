import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createEventFactory } from '@rhizomorph/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { transcriptCaptureDir, transcriptCaptureFileName } from './paths.js'
import {
  captureSessionTranscripts,
  readTranscriptCaptureManifest,
  redactTranscript,
  transcriptCaptureManifestPath,
  writeTranscriptCaptureManifest,
} from './transcript-capture.js'

const LANE = '84-chat-drawer'
const WORKTREE = '/tmp/rhizomorph-fixture/84-chat-drawer'
const PROJECT_SLUG = '-tmp-rhizomorph-fixture-84-chat-drawer'
const SESSION_ID = 'sess-84'
const RECORDING_SESSION_ID = '1700000000000'

function laneEvents() {
  const f = createEventFactory()
  return [
    f.llmUsage({ lane: LANE, branch: LANE, sessionId: SESSION_ID, worktreePath: WORKTREE }),
    f.toolActivity({ lane: LANE, branch: LANE, sessionId: SESSION_ID, worktreePath: WORKTREE, tool: 'Read' }),
  ]
}

describe('redactTranscript (#177\'s discipline, applied to a real capture)', () => {
  it('carries no identity, no host paths, into a redacted capture — the law', () => {
    const line = JSON.stringify({
      type: 'assistant',
      sessionId: SESSION_ID,
      cwd: '/home/operator/worktrees-challenge',
      organizationId: 'org_abc123def',
      userEmail: 'operator@example.com',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'reach me at operator@example.com or see /Users/operator/notes.md' }],
      },
    })

    const redacted = redactTranscript(`${line}\n`)

    expect(redacted).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/)
    expect(redacted).not.toMatch(/\/(home|Users)\//)
    expect(redacted).not.toContain('org_abc123def')
    // The parser's own fields survive untouched — a redacted capture still replays.
    const parsed = JSON.parse(redacted.trimEnd())
    expect(parsed.type).toBe('assistant')
    expect(parsed.sessionId).toBe(SESSION_ID)
  })

  it('preserves line count and blank lines exactly — byte offsets a captured file is read by must still line up', () => {
    const raw = `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } })}\n\n{ not json\n`

    expect(redactTranscript(raw).split('\n')).toHaveLength(raw.split('\n').length)
  })

  it('scrubs an email or home path even inside a line that fails to parse as JSON', () => {
    const raw = 'not json but mentions operator@example.com and /home/operator/secret\n'

    const redacted = redactTranscript(raw)
    expect(redacted).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/)
    expect(redacted).not.toMatch(/\/(home|Users)\//)
  })

  it('never carries a literal NUL byte through', () => {
    const raw = `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'ok' } })}\n`
    expect(redactTranscript(raw).includes('\0')).toBe(false)
  })
})

describe('captureSessionTranscripts', () => {
  let sessionDir: string
  let claudeProjectsRoot: string

  beforeEach(async () => {
    sessionDir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-capture-session-'))
    claudeProjectsRoot = await mkdtemp(path.join(tmpdir(), 'rhizomorph-capture-projects-'))
  })

  afterEach(async () => {
    await Promise.all([
      rm(sessionDir, { recursive: true, force: true }),
      rm(claudeProjectsRoot, { recursive: true, force: true }),
    ])
  })

  async function writeLiveTranscript(lines: string[]): Promise<void> {
    const dir = path.join(claudeProjectsRoot, PROJECT_SLUG)
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, `${SESSION_ID}.jsonl`), lines.map((line) => `${line}\n`).join(''))
  }

  it('copies the lane transcript into the session\'s own artefact directory, redacted, and reports its size', async () => {
    const line = JSON.stringify({
      type: 'user',
      cwd: '/home/operator/worktrees-challenge',
      message: { role: 'user', content: 'hello there' },
    })
    await writeLiveTranscript([line])

    const manifest = await captureSessionTranscripts({
      events: laneEvents(),
      sessionDir,
      sessionId: RECORDING_SESSION_ID,
      claudeProjectsRoot,
      now: 5000,
    })

    expect(manifest).not.toBeNull()
    if (manifest === null) return
    expect(manifest.complete).toBe(true)
    expect(manifest.lanes).toEqual([
      { lane: LANE, claudeSessionId: SESSION_ID, captured: true, bytes: manifest.totalBytes },
    ])
    expect(manifest.totalBytes).toBeGreaterThan(0)

    const capturedPath = path.join(transcriptCaptureDir(sessionDir, RECORDING_SESSION_ID), transcriptCaptureFileName(SESSION_ID))
    const capturedRaw = await readFile(capturedPath, 'utf8')
    expect(capturedRaw).not.toMatch(/\/(home|Users)\//)
    expect(Buffer.byteLength(capturedRaw, 'utf8')).toBe(manifest.totalBytes)

    // The manifest sidecar round-trips through its reader.
    expect(await readTranscriptCaptureManifest(sessionDir, RECORDING_SESSION_ID)).toEqual(manifest)
  })

  it('records a precise gap, and keeps `complete: false`, for a lane whose transcript could not be found', async () => {
    // No live transcript ever written for this lane.
    const manifest = await captureSessionTranscripts({
      events: laneEvents(),
      sessionDir,
      sessionId: RECORDING_SESSION_ID,
      claudeProjectsRoot,
      now: 5000,
    })

    expect(manifest).not.toBeNull()
    if (manifest === null) return
    expect(manifest.complete).toBe(false)
    expect(manifest.totalBytes).toBe(0)
    expect(manifest.lanes).toHaveLength(1)
    expect(manifest.lanes[0]).toMatchObject({ lane: LANE, captured: false })
    expect(manifest.lanes[0]?.reason).toContain('TRANSCRIPT NOT CAPTURED')
  })

  it('#208: captures a lane that landed mid-session even though a later cost row for the same session carries no worktree path', async () => {
    await writeLiveTranscript([JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } })])

    const f = createEventFactory()
    const events = [
      ...laneEvents(),
      // The lane lands mid-session; its worktree is pruned. OTel cost
      // telemetry for the same Claude Code session keeps arriving anyway,
      // worktree-blind by construction — this must not turn a landed lane's
      // capture into a false gap (#208).
      f.llmCost({ lane: LANE, branch: LANE, sessionId: SESSION_ID, worktreePath: null }, { source: 'otel' }),
    ]

    const manifest = await captureSessionTranscripts({
      events,
      sessionDir,
      sessionId: RECORDING_SESSION_ID,
      claudeProjectsRoot,
      now: 5000,
    })

    expect(manifest).not.toBeNull()
    if (manifest === null) return
    expect(manifest.complete).toBe(true)
    expect(manifest.lanes).toEqual([
      { lane: LANE, claudeSessionId: SESSION_ID, captured: true, bytes: manifest.totalBytes },
    ])
  })

  it('is a mix, honestly, when one lane captures and another cannot', async () => {
    await writeLiveTranscript([JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } })])

    const f = createEventFactory()
    const events = [
      ...laneEvents(),
      f.llmUsage({ lane: 'other-lane', branch: 'other-lane', sessionId: 'sess-vanished', worktreePath: '/wt/other' }),
    ]

    const manifest = await captureSessionTranscripts({
      events,
      sessionDir,
      sessionId: RECORDING_SESSION_ID,
      claudeProjectsRoot,
      now: 5000,
    })

    expect(manifest).not.toBeNull()
    if (manifest === null) return
    expect(manifest.complete).toBe(false)
    expect(manifest.lanes.find((entry) => entry.lane === LANE)?.captured).toBe(true)
    expect(manifest.lanes.find((entry) => entry.lane === 'other-lane')?.captured).toBe(false)
  })

  it('writes nothing at all when the session never attributed a single lane', async () => {
    const f = createEventFactory()
    const manifest = await captureSessionTranscripts({
      events: [f.sessionStarted({})],
      sessionDir,
      sessionId: RECORDING_SESSION_ID,
      claudeProjectsRoot,
      now: 5000,
    })

    expect(manifest).toBeNull()
    expect(await readTranscriptCaptureManifest(sessionDir, RECORDING_SESSION_ID)).toBeNull()
  })
})

describe('readTranscriptCaptureManifest', () => {
  it('reads null for a session that was never captured', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-capture-manifest-'))
    try {
      expect(await readTranscriptCaptureManifest(dir, 'no-such-session')).toBeNull()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

// ── the lane list is the session's, not the window's (#133) ─────────────────

/**
 * prd-44 ruling 4 (#37) capped the recorder's in-memory window, and
 * `rotate.ts` handed that window to the capture. So on a session past the cap,
 * a lane whose attributing events had been evicted was simply absent from the
 * manifest — not reported unreadable, not counted, gone. And gone permanently:
 * the capture is what the lane index reads once the log itself has been pruned
 * (#38), so the loss outlives the recording.
 *
 * Every assertion here is a lane list, a flag or a byte count — never a wall
 * clock. No law here is named `*.bench.test.ts` and none carries a
 * `@gate-timing` marker.
 */
describe('captureSessionTranscripts — the lane list comes from the recording', () => {
  const OLD_LANE = '519-migrate'
  const OLD_WORKTREE = '/tmp/rhizomorph-fixture/519-migrate'
  const OLD_PROJECT_SLUG = '-tmp-rhizomorph-fixture-519-migrate'
  const OLD_SESSION_ID = 'sess-519'

  let sessionDir: string
  let claudeProjectsRoot: string

  beforeEach(async () => {
    sessionDir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-capture-recording-'))
    claudeProjectsRoot = await mkdtemp(path.join(tmpdir(), 'rhizomorph-capture-projects-'))
  })

  afterEach(async () => {
    await Promise.all([
      rm(sessionDir, { recursive: true, force: true }),
      rm(claudeProjectsRoot, { recursive: true, force: true }),
    ])
  })

  async function writeTranscript(slug: string, claudeSessionId: string, text = '{"type":"user"}'): Promise<void> {
    const dir = path.join(claudeProjectsRoot, slug)
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, `${claudeSessionId}.jsonl`), `${text}\n`)
  }

  /** The lane whose attributing events have fallen out of the recorder's window. */
  function evictedLaneEvents() {
    const f = createEventFactory({ idPrefix: 'old' })
    return [
      f.llmUsage({ lane: OLD_LANE, branch: OLD_LANE, sessionId: OLD_SESSION_ID, worktreePath: OLD_WORKTREE }),
    ]
  }

  function capture(options: {
    events: ReturnType<typeof laneEvents>
    recordedEvents?: ReturnType<typeof laneEvents>
  }) {
    return captureSessionTranscripts({
      events: options.events,
      ...(options.recordedEvents !== undefined ? { recordedEvents: options.recordedEvents } : {}),
      sessionDir,
      sessionId: RECORDING_SESSION_ID,
      claudeProjectsRoot,
      now: 1_700_000_000_500,
    })
  }

  it('captures a lane whose attributing events the window has already evicted', async () => {
    await writeTranscript(PROJECT_SLUG, SESSION_ID)
    await writeTranscript(OLD_PROJECT_SLUG, OLD_SESSION_ID)
    const recent = laneEvents()
    const whole = [...evictedLaneEvents(), ...recent]

    // The window holds only the recent lane; the recording holds both. THE law:
    // on the code before #133 this manifest names one lane, because the window
    // is all it ever looked at.
    const manifest = await capture({ events: recent, recordedEvents: whole })

    expect(manifest?.lanes.map((entry) => entry.lane).sort()).toEqual([LANE, OLD_LANE].sort())
    expect(manifest?.lanes.every((entry) => entry.captured)).toBe(true)
    expect(manifest?.attributedFrom).toBe('recording')
    expect(manifest?.complete).toBe(true)
  })

  it('still reports an evicted lane it could not capture, rather than dropping it back out of the list', async () => {
    // The recent lane's transcript exists; the evicted lane's does not. The
    // wider list must not quietly shrink back to the lanes that happened to
    // work — a lane that cannot be captured is a recorded gap (ADR-0011's
    // posture), and that is the whole reason the list is widened at all.
    await writeTranscript(PROJECT_SLUG, SESSION_ID)
    const recent = laneEvents()

    const manifest = await capture({ events: recent, recordedEvents: [...evictedLaneEvents(), ...recent] })

    const evicted = manifest?.lanes.find((entry) => entry.lane === OLD_LANE)
    expect(evicted?.captured).toBe(false)
    expect(evicted?.bytes).toBe(0)
    expect(evicted?.reason).toContain('TRANSCRIPT NOT CAPTURED')
    expect(manifest?.complete).toBe(false)
    expect(manifest?.attributedFrom).toBe('recording')
  })

  it('is purely additive — a lane already in the window keeps the attribution it had', async () => {
    // The recording carries an OLDER claude session id for the same lane; the
    // window carries the newer one. `findAttribution` walks backwards, so the
    // newest wins and the wider list can only ADD lanes, never re-point one at
    // a stale transcript. Only the newer id's file exists, so a regression
    // here reads as an uncaptured lane rather than as a subtle wrong path.
    await writeTranscript(PROJECT_SLUG, SESSION_ID)
    const f = createEventFactory({ idPrefix: 'stale' })
    const stale = [f.llmUsage({ lane: LANE, branch: LANE, sessionId: 'sess-84-older', worktreePath: WORKTREE })]
    const recent = laneEvents()

    const manifest = await capture({ events: recent, recordedEvents: [...stale, ...recent] })

    expect(manifest?.lanes).toHaveLength(1)
    expect(manifest?.lanes[0]?.claudeSessionId).toBe(SESSION_ID)
    expect(manifest?.lanes[0]?.captured).toBe(true)
  })

  it('falls back to the window when the log could not be read, and refuses to call that complete', async () => {
    await writeTranscript(PROJECT_SLUG, SESSION_ID)
    const recent = laneEvents()

    // `readSessionEvents` reports an unreadable log as `[]`, so an empty array
    // is "the caller asked for the recording and did not get it".
    const manifest = await capture({ events: recent, recordedEvents: [] })

    // The recent lanes are still captured — a failed read must not cost the
    // capture entirely.
    expect(manifest?.lanes.map((entry) => entry.lane)).toEqual([LANE])
    expect(manifest?.lanes[0]?.captured).toBe(true)
    expect(manifest?.attributedFrom).toBe('window')
    // But `complete` is false even though every lane FOUND made it in: the
    // list itself may be short, and nothing at this layer can know that it is.
    expect(manifest?.complete).toBe(false)
  })

  it('reads exactly as it did before #133 for a caller that supplies no recording', async () => {
    await writeTranscript(PROJECT_SLUG, SESSION_ID)

    const manifest = await capture({ events: laneEvents() })

    // A caller that never asked is vouching for its own events (`listing.ts`'s
    // tests, and any future caller holding a whole log) — so `complete` is
    // computed exactly as it always was, and only `attributedFrom` says that
    // the list's provenance is the caller's word rather than a recording.
    expect(manifest?.lanes.map((entry) => entry.lane)).toEqual([LANE])
    expect(manifest?.complete).toBe(true)
    expect(manifest?.attributedFrom).toBe('window')
  })

  it('writes nothing at all when the recording named no lane either', async () => {
    const f = createEventFactory({ idPrefix: 'bare' })
    const unattributed = [f.worktreeDiscovered({ path: '/repo', branch: 'main', isMain: true })]

    const manifest = await capture({ events: [], recordedEvents: unattributed as never })

    // Unchanged: no lanes means no `transcripts/` directory for a session that
    // was never instrumented, rather than an empty manifest claiming a capture.
    expect(manifest).toBeNull()
    expect(await readTranscriptCaptureManifest(sessionDir, RECORDING_SESSION_ID)).toBeNull()
  })
})

// ── the 'tombstone' widening stays additive (prd-51 ruling 11, #432) ────────

/**
 * `attributedFrom` gained a third value, `'tombstone'`, so `log/archive.ts` can
 * say plainly that a manifest's lane list was reconstructed from the log at
 * prune time rather than copied from any transcript. The widening is only
 * honest while the CAPTURE path never writes it: a real capture that started
 * claiming `'tombstone'` would be a manifest saying no transcript was ever
 * taken while sitting beside the transcripts it took. These two hold that.
 */
describe('attributedFrom: the tombstone value is declared here and written only by log/archive.ts (#432)', () => {
  let sessionDir: string
  let claudeProjectsRoot: string

  beforeEach(async () => {
    sessionDir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-capture-tombstone-'))
    claudeProjectsRoot = await mkdtemp(path.join(tmpdir(), 'rhizomorph-capture-tombstone-projects-'))
  })

  afterEach(async () => {
    await Promise.all([
      rm(sessionDir, { recursive: true, force: true }),
      rm(claudeProjectsRoot, { recursive: true, force: true }),
    ])
  })

  it('T26: every branch of captureSessionTranscripts still writes "recording" or "window" — never "tombstone"', async () => {
    const dir = path.join(claudeProjectsRoot, PROJECT_SLUG)
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, `${SESSION_ID}.jsonl`), '{"type":"user"}\n')

    const capture = async (options: { recordedEvents?: ReturnType<typeof laneEvents> }, sessionId: string) =>
      captureSessionTranscripts({
        events: laneEvents(),
        ...(options.recordedEvents === undefined ? {} : { recordedEvents: options.recordedEvents }),
        sessionDir,
        sessionId,
        claudeProjectsRoot,
        now: 5000,
      })

    // All three doors into the write site: attributed from the recording,
    // attributed from the window because the read gave nothing back, and
    // attributed from the window because the caller never offered a recording.
    const values = [
      (await capture({ recordedEvents: laneEvents() }, '1700000000001'))?.attributedFrom,
      (await capture({ recordedEvents: [] }, '1700000000002'))?.attributedFrom,
      (await capture({}, '1700000000003'))?.attributedFrom,
    ]

    expect(values).toEqual(['recording', 'window', 'window'])
    expect(values).not.toContain('tombstone')
  })

  it('T27: a tombstone manifest round-trips, at exactly the path transcriptCaptureManifestPath names', async () => {
    const sessionId = '1700000000004'
    const written = {
      sessionId,
      capturedAt: 4242,
      complete: false,
      totalBytes: 0,
      lanes: [
        {
          lane: 'scratch-407',
          claudeSessionId: 'claude-407',
          captured: false,
          bytes: 0,
          reason: 'TOMBSTONE for "scratch-407" — no transcript capture ever ran for this session',
        },
      ],
      attributedFrom: 'tombstone' as const,
    }

    await writeTranscriptCaptureManifest(sessionDir, written)

    const manifestPath = transcriptCaptureManifestPath(sessionDir, sessionId)
    expect(manifestPath).toBe(path.join(transcriptCaptureDir(sessionDir, sessionId), 'manifest.json'))
    expect(JSON.parse(await readFile(manifestPath, 'utf8'))).toEqual(written)
    expect(await readTranscriptCaptureManifest(sessionDir, sessionId)).toEqual(written)
  })
})
