import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createEventFactory, type RhizomorphEvent } from '@rhizomorph/core'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sessionFilePath } from '../log/session-log.js'
import { buildApp } from '../server/build-app.js'
import { SessionRecorder } from '../server/recorder.js'
import { candidateTranscriptPaths } from '../log/transcript-attribution.js'
import { readBoundedLines } from './transcript.js'
import {
  PREVIEW_MAX_CHARS,
  isValidSessionIdParam,
  previewSession,
  registerSessionPreviewRoute,
} from './session-preview.js'

/**
 * The two places this route can ever touch a filesystem — `candidateTranscriptPaths`
 * (which locates the file, through `isPathContained`'s `realpath`) and
 * `readBoundedLines` (which opens and reads it). Wrapped, not replaced: every
 * test below that expects a real read still gets one, but the malformed-id
 * tests can assert neither was ever called.
 */
vi.mock('../log/transcript-attribution.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../log/transcript-attribution.js')>()
  return { ...actual, candidateTranscriptPaths: vi.fn(actual.candidateTranscriptPaths) }
})

vi.mock('./transcript.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./transcript.js')>()
  return { ...actual, readBoundedLines: vi.fn(actual.readBoundedLines) }
})

const LANE = '84-chat-drawer'
const WORKTREE = '/tmp/rhizomorph-fixture/84-chat-drawer'
const PROJECT_SLUG = '-tmp-rhizomorph-fixture-84-chat-drawer'
const SESSION_ID = 'sess-84'

function userLine(text: string): string {
  return JSON.stringify({ type: 'user', sessionId: SESSION_ID, message: { role: 'user', content: text } })
}

function assistantLine(text: string): string {
  return JSON.stringify({
    type: 'assistant',
    sessionId: SESSION_ID,
    message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text }] },
  })
}

function sessionEvents(sessionId: string = SESSION_ID): RhizomorphEvent[] {
  const f = createEventFactory()
  return [f.llmUsage({ lane: LANE, branch: LANE, sessionId, worktreePath: WORKTREE })]
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('isValidSessionIdParam', () => {
  it('accepts an ordinary bare id', () => {
    expect(isValidSessionIdParam(SESSION_ID)).toBe(true)
    expect(isValidSessionIdParam('550e8400-e29b-41d4-a716-446655440000')).toBe(true)
  })

  it('refuses the empty string — isSafeSessionId alone admits it (path.basename(\'\') === \'\')', () => {
    expect(isValidSessionIdParam('')).toBe(false)
  })

  it("refuses '.' and '..' — isSafeSessionId alone admits both (path.basename returns them unchanged)", () => {
    expect(isValidSessionIdParam('.')).toBe(false)
    expect(isValidSessionIdParam('..')).toBe(false)
  })

  it('refuses an absolute path', () => {
    expect(isValidSessionIdParam('/etc/passwd')).toBe(false)
  })

  it('refuses a relative traversal', () => {
    expect(isValidSessionIdParam('../../../../etc/passwd')).toBe(false)
  })

  it('refuses an embedded NUL byte', () => {
    expect(isValidSessionIdParam('sess-84\0.evil')).toBe(false)
  })
})

describe('previewSession', () => {
  let projectsRoot: string

  beforeEach(async () => {
    projectsRoot = await mkdtemp(path.join(tmpdir(), 'rhizomorph-session-preview-'))
  })

  afterEach(async () => {
    await rm(projectsRoot, { recursive: true, force: true })
  })

  async function writeSessionFile(lines: string[]): Promise<void> {
    const dir = path.join(projectsRoot, PROJECT_SLUG)
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, `${SESSION_ID}.jsonl`), lines.map((line) => `${line}\n`).join(''))
  }

  it('is honestly unknown, 404-shaped, for a session id nothing ever attributed', async () => {
    const result = await previewSession({
      events: sessionEvents(),
      sessionId: 'no-such-session',
      claudeProjectsRoot: projectsRoot,
    })

    expect(result.available).toBe(false)
    if (result.available) return
    expect(result.unknownSessionId).toBe(true)
    expect(result.reason).toContain('NO SUCH SESSION')
  })

  it('is honestly absent, 200-shaped, for a known session whose file is not on disk', async () => {
    const result = await previewSession({
      events: sessionEvents(),
      sessionId: SESSION_ID,
      claudeProjectsRoot: projectsRoot,
    })

    expect(result.available).toBe(false)
    if (result.available) return
    expect(result.unknownSessionId).toBe(false)
    expect(result.reason).toContain('NO TRANSCRIPT')
  })

  it('reports place from the attribution, and the first user message when the head holds one', async () => {
    await writeSessionFile([userLine('hello'), assistantLine('hi')])

    const result = await previewSession({
      events: sessionEvents(),
      sessionId: SESSION_ID,
      claudeProjectsRoot: projectsRoot,
    })

    expect(result.available).toBe(true)
    if (!result.available) return
    expect(result.place).toEqual({ worktreePath: WORKTREE, branch: LANE })
    expect(result.firstUserMessage).toEqual({ text: 'hello', dropped: 0 })
  })

  it('carries the entry\'s own timestamp when the line has one', async () => {
    await writeSessionFile([
      JSON.stringify({
        type: 'user',
        sessionId: SESSION_ID,
        timestamp: '2026-08-01T12:00:00.000Z',
        message: { role: 'user', content: 'stamped' },
      }),
    ])

    const result = await previewSession({
      events: sessionEvents(),
      sessionId: SESSION_ID,
      claudeProjectsRoot: projectsRoot,
    })

    expect(result.available).toBe(true)
    if (!result.available) return
    expect(result.firstUserMessage).toEqual({ text: 'stamped', dropped: 0, ts: '2026-08-01T12:00:00.000Z' })
  })

  it('caps the preview at PREVIEW_MAX_CHARS and says how much was dropped', async () => {
    const long = 'x'.repeat(PREVIEW_MAX_CHARS + 50)
    await writeSessionFile([userLine(long)])

    const result = await previewSession({
      events: sessionEvents(),
      sessionId: SESSION_ID,
      claudeProjectsRoot: projectsRoot,
    })

    expect(result.available).toBe(true)
    if (!result.available) return
    expect(result.firstUserMessage).toEqual({ text: long.slice(0, PREVIEW_MAX_CHARS), dropped: 50 })
  })

  it('is null, not unreadable, when the head chunk holds no user text at all', async () => {
    await writeSessionFile([assistantLine('just me, the assistant')])

    const result = await previewSession({
      events: sessionEvents(),
      sessionId: SESSION_ID,
      claudeProjectsRoot: projectsRoot,
    })

    expect(result.available).toBe(true)
    if (!result.available) return
    expect(result.firstUserMessage).toBeNull()
  })

  it('the read really is bounded to the head — a user turn past the chunk boundary is not seen', async () => {
    const padding = assistantLine('p'.repeat(200))
    const target = userLine('the actual first user message')
    await writeSessionFile([padding, target])
    const paddingBytes = Buffer.byteLength(`${padding}\n`, 'utf8')

    const tooSmall = await previewSession({
      events: sessionEvents(),
      sessionId: SESSION_ID,
      claudeProjectsRoot: projectsRoot,
      chunkBytes: paddingBytes,
    })
    expect(tooSmall.available).toBe(true)
    if (!tooSmall.available) return
    expect(tooSmall.firstUserMessage).toBeNull()

    const bigEnough = await previewSession({
      events: sessionEvents(),
      sessionId: SESSION_ID,
      claudeProjectsRoot: projectsRoot,
      chunkBytes: paddingBytes + 1024,
    })
    expect(bigEnough.available).toBe(true)
    if (!bigEnough.available) return
    expect(bigEnough.firstUserMessage?.text).toBe('the actual first user message')
  })
})

describe('GET /api/session-preview/:sessionId', () => {
  let projectsRoot: string
  let sessionDir: string

  beforeEach(async () => {
    projectsRoot = await mkdtemp(path.join(tmpdir(), 'rhizomorph-session-preview-route-'))
    sessionDir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-session-preview-session-'))
  })

  afterEach(async () => {
    await Promise.all([
      rm(projectsRoot, { recursive: true, force: true }),
      rm(sessionDir, { recursive: true, force: true }),
    ])
  })

  function makeApp(events: readonly RhizomorphEvent[] = sessionEvents()) {
    const recorder = new SessionRecorder('1000', sessionFilePath(sessionDir, '1000'), { resumeFrom: events })
    const app = Fastify()
    registerSessionPreviewRoute(app, { repoPath: '/repo', repoName: 'repo', sessionDir, recorder }, {
      claudeProjectsRoot: projectsRoot,
    })
    return app
  }

  async function writeSessionFile(lines: string[]): Promise<void> {
    const dir = path.join(projectsRoot, PROJECT_SLUG)
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, `${SESSION_ID}.jsonl`), lines.map((line) => `${line}\n`).join(''))
  }

  describe('malformed ids — 400, and zero fs access', () => {
    const cases: Array<[string, string]> = [
      ['an absolute path', '/etc/passwd'],
      ['an embedded NUL byte', 'sess-84\0.evil'],
    ]

    for (const [label, bad] of cases) {
      it(`400s on ${label}, never calling candidateTranscriptPaths or readBoundedLines`, async () => {
        const app = makeApp()

        const response = await app.inject({
          method: 'GET',
          url: `/api/session-preview/${encodeURIComponent(bad)}`,
        })

        expect(response.statusCode).toBe(400)
        expect(vi.mocked(candidateTranscriptPaths)).not.toHaveBeenCalled()
        expect(vi.mocked(readBoundedLines)).not.toHaveBeenCalled()
      })
    }

    it('400s on the empty case too — the router does pass an empty :sessionId segment through', async () => {
      const app = makeApp()

      const response = await app.inject({ method: 'GET', url: '/api/session-preview/' })

      expect(response.statusCode).toBe(400)
      expect(vi.mocked(candidateTranscriptPaths)).not.toHaveBeenCalled()
      expect(vi.mocked(readBoundedLines)).not.toHaveBeenCalled()
    })

    it(
      "a bare '..' never reaches this route's handler at all — the HTTP layer's own path " +
        'normalization collapses `/api/session-preview/..` to `/api/` before routing, which is ' +
        "an even stronger refusal than this route's own 400 (isValidSessionIdParam's '..' clause " +
        'is proven directly, above, since no URL can ever deliver a literal `..` segment here)',
      async () => {
        const app = makeApp()

        const response = await app.inject({ method: 'GET', url: '/api/session-preview/..' })

        expect(response.statusCode).toBe(404)
        expect(vi.mocked(candidateTranscriptPaths)).not.toHaveBeenCalled()
        expect(vi.mocked(readBoundedLines)).not.toHaveBeenCalled()
      },
    )
  })

  it('404s with the honest reason for a genuinely unknown session id', async () => {
    const response = await makeApp().inject({ method: 'GET', url: '/api/session-preview/no-such-session' })

    expect(response.statusCode).toBe(404)
    const body = response.json()
    expect(body.available).toBe(false)
    expect(body.reason).toContain('NO SUCH SESSION')
  })

  it('200s, available:false, for a known session whose transcript is not on disk', async () => {
    const response = await makeApp().inject({ method: 'GET', url: `/api/session-preview/${SESSION_ID}` })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.available).toBe(false)
    expect(body.reason).toContain('NO TRANSCRIPT')
  })

  it('200s with the place and first user message for a session whose transcript is on disk', async () => {
    await writeSessionFile([userLine('hello there'), assistantLine('hi')])

    const response = await makeApp().inject({ method: 'GET', url: `/api/session-preview/${SESSION_ID}` })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body).toEqual({
      available: true,
      sessionId: SESSION_ID,
      place: { worktreePath: WORKTREE, branch: LANE },
      firstUserMessage: { text: 'hello there', dropped: 0 },
    })
  })

  it('accepts no verb but GET — the read-only posture, stated in routing', async () => {
    await writeSessionFile([userLine('hello')])
    const app = makeApp()

    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const response = await app.inject({ method, url: `/api/session-preview/${SESSION_ID}` })
      expect(response.statusCode).toBe(404)
    }
  })

  it('is registered on the real app, untokened like /api/doctor, and still refuses a POST', async () => {
    const recorder = new SessionRecorder('1000', sessionFilePath(sessionDir, '1000'), { resumeFrom: [] })
    const app = buildApp({ repoPath: '/repo', repoName: 'repo', sessionDir, recorder })

    const get = await app.inject({ method: 'GET', url: '/api/session-preview/nobody' })
    expect(get.statusCode).toBe(404)
    expect(get.json().available).toBe(false)

    const post = await app.inject({ method: 'POST', url: '/api/session-preview/nobody' })
    expect(post.statusCode).toBe(404)
  })
})
