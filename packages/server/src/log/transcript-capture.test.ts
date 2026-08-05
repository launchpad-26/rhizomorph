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
      userEmail: 'lachlan@example.com',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'reach me at lachlan@example.com or see /Users/operator/notes.md' }],
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
    const raw = 'not json but mentions lachlan@example.com and /home/operator/secret\n'

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
