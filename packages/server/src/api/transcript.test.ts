import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createEventFactory, type ObservatoryEvent } from '@observatory/core'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sessionFilePath } from '../log/session-log.js'
import { buildApp } from '../server/build-app.js'
import { SessionRecorder } from '../server/recorder.js'
import {
  candidateTranscriptPaths,
  findLaneAttribution,
  readTranscript,
  registerTranscriptRoute,
  renderTranscript,
  renderTranscriptLine,
} from './transcript.js'

/**
 * The lane the whole file talks about, and the worktree the collector would
 * have attributed it to. `worktreePathToProjectSlug` turns the path into the
 * project-dir name Claude Code uses, and these tests write a fixture log there
 * — the same resolution the sessionlog collector performs, exercised rather
 * than restated.
 */
const LANE = '84-chat-drawer'
const WORKTREE = '/tmp/observatory-fixture/84-chat-drawer'
const PROJECT_SLUG = '-tmp-observatory-fixture-84-chat-drawer'
const SESSION_ID = 'sess-84'

function assistantLine(text: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'assistant',
    sessionId: SESSION_ID,
    message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text }] },
    ...extra,
  })
}

function userLine(text: string): string {
  return JSON.stringify({
    type: 'user',
    sessionId: SESSION_ID,
    message: { role: 'user', content: text },
  })
}

/** Events shaped exactly as the sessionlog collector emits them for this lane. */
function laneEvents(): ObservatoryEvent[] {
  const f = createEventFactory()
  return [
    f.llmUsage({ lane: LANE, branch: LANE, sessionId: SESSION_ID, worktreePath: WORKTREE }),
    f.toolActivity({ lane: LANE, branch: LANE, sessionId: SESSION_ID, worktreePath: WORKTREE, tool: 'Read' }),
  ]
}

describe('findLaneAttribution', () => {
  it('takes the newest attribution the log carries for the lane', () => {
    const f = createEventFactory()
    const events = [
      f.llmUsage({ lane: LANE, sessionId: 'sess-old', worktreePath: WORKTREE }),
      f.llmUsage({ lane: 'other', sessionId: 'sess-other', worktreePath: '/elsewhere' }),
      f.toolActivity({ lane: LANE, sessionId: 'sess-new', worktreePath: WORKTREE }),
    ]

    expect(findLaneAttribution(events, LANE)).toEqual({
      sessionId: 'sess-new',
      worktreePath: WORKTREE,
    })
  })

  it('matches on branch too, since a lane id is its branch when one is known', () => {
    const f = createEventFactory()
    const events = [f.llmUsage({ lane: 'handle-84', branch: LANE, sessionId: SESSION_ID, worktreePath: WORKTREE })]

    expect(findLaneAttribution(events, LANE)?.sessionId).toBe(SESSION_ID)
  })

  it('ignores telemetry that carries no session id — the file cannot be located from it', () => {
    const f = createEventFactory()
    const events = [f.llmCost({ lane: LANE, sessionId: null, worktreePath: null }, { source: 'otel' })]

    expect(findLaneAttribution(events, LANE)).toBeNull()
  })

  it('is null for a lane nothing ever named', () => {
    expect(findLaneAttribution(laneEvents(), 'no-such-lane')).toBeNull()
  })
})

describe('candidateTranscriptPaths', () => {
  it('offers the slug-inferred project dir first, then the dir-first extra-sessions location', () => {
    expect(
      candidateTranscriptPaths({ sessionId: SESSION_ID, worktreePath: WORKTREE }, '/root/projects'),
    ).toEqual([
      path.join('/root/projects', PROJECT_SLUG, `${SESSION_ID}.jsonl`),
      path.join(WORKTREE, `${SESSION_ID}.jsonl`),
    ])
  })

  it('offers nothing when no worktree path was recorded', () => {
    expect(candidateTranscriptPaths({ sessionId: SESSION_ID, worktreePath: null }, '/root')).toEqual([])
  })
})

describe('renderTranscriptLine', () => {
  it('renders a user turn', () => {
    expect(renderTranscriptLine(userLine('read the docs'))).toBe('▌ user\nread the docs')
  })

  it('renders an assistant turn', () => {
    expect(renderTranscriptLine(assistantLine('on it'))).toBe('▌ assistant\non it')
  })

  it('marks a subagent turn so a reader can tell whose voice it is', () => {
    expect(renderTranscriptLine(assistantLine('sub work', { isSidechain: true }))).toBe(
      '▌ assistant · subagent\nsub work',
    )
  })

  it('renders a tool call with the one input field worth showing', () => {
    const raw = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        model: 'claude-opus-5',
        content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test\n--watch' } }],
      },
    })

    expect(renderTranscriptLine(raw)).toBe('▌ assistant\n⟨tool: Bash⟩ npm test')
  })

  it('never renders thinking blocks', () => {
    const raw = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'private reasoning' },
          { type: 'text', text: 'the answer' },
        ],
      },
    })

    expect(renderTranscriptLine(raw)).toBe('▌ assistant\nthe answer')
    expect(renderTranscriptLine(raw)).not.toContain('private reasoning')
  })

  it('skips lines that are not a turn at all', () => {
    expect(renderTranscriptLine(JSON.stringify({ type: 'summary', summary: 'x' }))).toBeNull()
    expect(renderTranscriptLine('   ')).toBeNull()
  })

  it('shows an unparsable line rather than quietly dropping it', () => {
    expect(renderTranscriptLine('{ not json')).toBe('⟨unreadable line⟩')
  })
})

describe('renderTranscript', () => {
  it('joins blocks with a blank line and ends with a newline', () => {
    expect(renderTranscript([userLine('a'), assistantLine('b')])).toBe('▌ user\na\n\n▌ assistant\nb\n\n')
  })

  it('is empty — not whitespace — when no line said anything', () => {
    expect(renderTranscript([JSON.stringify({ type: 'summary' })])).toBe('')
  })
})

describe('readTranscript', () => {
  let projectsRoot: string

  beforeEach(async () => {
    projectsRoot = await mkdtemp(path.join(tmpdir(), 'observatory-transcript-'))
  })

  afterEach(async () => {
    await rm(projectsRoot, { recursive: true, force: true })
  })

  async function writeLog(lines: string[]): Promise<string> {
    const dir = path.join(projectsRoot, PROJECT_SLUG)
    await mkdir(dir, { recursive: true })
    const file = path.join(dir, `${SESSION_ID}.jsonl`)
    await writeFile(file, lines.map((line) => `${line}\n`).join(''))
    return file
  }

  it('reads the whole log when it fits in one chunk', async () => {
    await writeLog([userLine('go'), assistantLine('going')])

    const result = await readTranscript({
      events: laneEvents(),
      lane: LANE,
      offset: 0,
      claudeProjectsRoot: projectsRoot,
    })

    expect(result.available).toBe(true)
    if (!result.available) return
    expect(result.sessionId).toBe(SESSION_ID)
    expect(result.text).toBe('▌ user\ngo\n\n▌ assistant\ngoing\n\n')
    expect(result.eof).toBe(true)
    expect(result.nextOffset).toBe(result.size)
    expect(result.restarted).toBe(false)
  })

  it('pages: each chunk resumes exactly where the last one stopped, and the pages reassemble', async () => {
    const lines = [userLine('one'), assistantLine('two'), userLine('three'), assistantLine('four')]
    await writeLog(lines)

    let offset = 0
    const pages: string[] = []
    // Small enough that no chunk can hold two lines — paging is forced, not incidental.
    for (let guard = 0; guard < 10; guard += 1) {
      const page = await readTranscript({
        events: laneEvents(),
        lane: LANE,
        offset,
        claudeProjectsRoot: projectsRoot,
        chunkBytes: 80,
      })
      expect(page.available).toBe(true)
      if (!page.available) return
      expect(page.offset).toBe(offset)
      pages.push(page.text)
      offset = page.nextOffset
      if (page.eof) break
    }

    expect(pages.length).toBeGreaterThan(1)
    expect(pages.join('')).toBe(renderTranscript(lines))
  })

  it('returns nothing new, and the same offset, when the log has not grown', async () => {
    await writeLog([userLine('go')])
    const first = await readTranscript({
      events: laneEvents(),
      lane: LANE,
      offset: 0,
      claudeProjectsRoot: projectsRoot,
    })
    expect(first.available).toBe(true)
    if (!first.available) return

    const second = await readTranscript({
      events: laneEvents(),
      lane: LANE,
      offset: first.nextOffset,
      claudeProjectsRoot: projectsRoot,
    })

    expect(second.available).toBe(true)
    if (!second.available) return
    expect(second.text).toBe('')
    expect(second.nextOffset).toBe(first.nextOffset)
    expect(second.eof).toBe(true)
  })

  it('picks up only what was appended since the last offset — the live tail', async () => {
    const file = await writeLog([userLine('first')])
    const first = await readTranscript({
      events: laneEvents(),
      lane: LANE,
      offset: 0,
      claudeProjectsRoot: projectsRoot,
    })
    expect(first.available).toBe(true)
    if (!first.available) return

    await writeFile(file, `${userLine('first')}\n${assistantLine('second')}\n`)
    const second = await readTranscript({
      events: laneEvents(),
      lane: LANE,
      offset: first.nextOffset,
      claudeProjectsRoot: projectsRoot,
    })

    expect(second.available).toBe(true)
    if (!second.available) return
    expect(second.text).toBe('▌ assistant\nsecond\n\n')
  })

  it('leaves a half-written trailing line unread until it is complete', async () => {
    const dir = path.join(projectsRoot, PROJECT_SLUG)
    await mkdir(dir, { recursive: true })
    const file = path.join(dir, `${SESSION_ID}.jsonl`)
    await writeFile(file, `${userLine('done')}\n${'{"type":"assistant","mess'}`)

    const result = await readTranscript({
      events: laneEvents(),
      lane: LANE,
      offset: 0,
      claudeProjectsRoot: projectsRoot,
    })

    expect(result.available).toBe(true)
    if (!result.available) return
    expect(result.text).toBe('▌ user\ndone\n\n')
    expect(result.nextOffset).toBeLessThan(result.size)
    expect(result.eof).toBe(false)
  })

  it('restarts from zero, loudly, when the log is shorter than the offset', async () => {
    await writeLog([userLine('fresh')])

    const result = await readTranscript({
      events: laneEvents(),
      lane: LANE,
      offset: 999_999,
      claudeProjectsRoot: projectsRoot,
    })

    expect(result.available).toBe(true)
    if (!result.available) return
    expect(result.restarted).toBe(true)
    expect(result.offset).toBe(0)
    expect(result.text).toBe('▌ user\nfresh\n\n')
  })

  it('reads an extra-sessions log that lives in the declared directory itself', async () => {
    const dir = path.join(projectsRoot, 'declared-conductor-dir')
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, `${SESSION_ID}.jsonl`), `${assistantLine('conducting')}\n`)

    const f = createEventFactory()
    const result = await readTranscript({
      events: [f.llmUsage({ lane: 'conductor', sessionId: SESSION_ID, worktreePath: dir })],
      lane: 'conductor',
      offset: 0,
      claudeProjectsRoot: projectsRoot,
    })

    expect(result.available).toBe(true)
    if (!result.available) return
    expect(result.text).toBe('▌ assistant\nconducting\n\n')
  })

  it('is honestly absent, with the reason, for a lane the log never named', async () => {
    const result = await readTranscript({
      events: laneEvents(),
      lane: 'ghost-lane',
      offset: 0,
      claudeProjectsRoot: projectsRoot,
    })

    expect(result.available).toBe(false)
    if (result.available) return
    expect(result.reason).toContain('NO SUCH LANE')
    expect(result.reason).toContain('ghost-lane')
  })

  it('is honestly absent when the lane is known but nothing attributed a session to it', async () => {
    const f = createEventFactory()
    const events = [f.llmCost({ lane: LANE, sessionId: null, worktreePath: null }, { source: 'otel' })]

    const result = await readTranscript({
      events,
      lane: LANE,
      offset: 0,
      claudeProjectsRoot: projectsRoot,
    })

    expect(result.available).toBe(false)
    if (result.available) return
    expect(result.reason).toContain('NO SESSION LOG')
    expect(result.reason).toContain('no session id')
  })

  it('is honestly absent, naming the paths it tried, when the file is not on disk', async () => {
    const result = await readTranscript({
      events: laneEvents(),
      lane: LANE,
      offset: 0,
      claudeProjectsRoot: projectsRoot,
    })

    expect(result.available).toBe(false)
    if (result.available) return
    expect(result.reason).toContain('NO SESSION LOG')
    expect(result.reason).toContain(PROJECT_SLUG)
  })
})

describe('GET /api/transcript/:lane', () => {
  let projectsRoot: string
  let sessionDir: string

  beforeEach(async () => {
    projectsRoot = await mkdtemp(path.join(tmpdir(), 'observatory-transcript-route-'))
    sessionDir = await mkdtemp(path.join(tmpdir(), 'observatory-transcript-session-'))
  })

  afterEach(async () => {
    await Promise.all([
      rm(projectsRoot, { recursive: true, force: true }),
      rm(sessionDir, { recursive: true, force: true }),
    ])
  })

  async function makeApp(events: readonly ObservatoryEvent[] = laneEvents()) {
    const recorder = new SessionRecorder('1000', sessionFilePath(sessionDir, '1000'), {
      resumeFrom: events,
    })
    const app = Fastify()
    registerTranscriptRoute(app, { repoPath: '/repo', repoName: 'repo', sessionDir, recorder }, {
      claudeProjectsRoot: projectsRoot,
    })
    return app
  }

  async function writeLog(lines: string[]): Promise<void> {
    const dir = path.join(projectsRoot, PROJECT_SLUG)
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, `${SESSION_ID}.jsonl`), lines.map((line) => `${line}\n`).join(''))
  }

  it('serves the lane transcript from offset 0', async () => {
    await writeLog([userLine('hello'), assistantLine('hi')])

    const response = await (await makeApp()).inject({ method: 'GET', url: `/api/transcript/${LANE}` })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.available).toBe(true)
    expect(body.text).toBe('▌ user\nhello\n\n▌ assistant\nhi\n\n')
    expect(body.nextOffset).toBe(body.size)
  })

  it('honours ?offset= and returns only what follows it', async () => {
    await writeLog([userLine('hello'), assistantLine('hi')])
    const app = await makeApp()

    const first = await app.inject({ method: 'GET', url: `/api/transcript/${LANE}?offset=0` })
    const firstLineBytes = `${userLine('hello')}\n`.length

    const second = await app.inject({
      method: 'GET',
      url: `/api/transcript/${LANE}?offset=${firstLineBytes}`,
    })

    expect(first.json().text).toContain('hello')
    expect(second.json().text).toBe('▌ assistant\nhi\n\n')
    expect(second.json().offset).toBe(firstLineBytes)
  })

  it('404s with the honest reason when the lane has no known session log', async () => {
    const response = await (await makeApp()).inject({ method: 'GET', url: '/api/transcript/ghost' })

    expect(response.statusCode).toBe(404)
    expect(response.json()).toMatchObject({ available: false, lane: 'ghost' })
    expect(response.json().reason).toContain('NO SUCH LANE')
  })

  it('400s on an offset that is not a non-negative integer', async () => {
    const app = await makeApp()

    for (const bad of ['-1', 'abc', '1.5']) {
      const response = await app.inject({ method: 'GET', url: `/api/transcript/${LANE}?offset=${bad}` })
      expect(response.statusCode).toBe(400)
    }
  })

  it('accepts no verb but GET — the read-only constitution, stated in routing', async () => {
    await writeLog([userLine('hello')])
    const app = await makeApp()

    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const response = await app.inject({ method, url: `/api/transcript/${LANE}` })
      expect(response.statusCode).toBe(404)
    }
  })

  it('is registered on the real app, and the real app still refuses a POST to it', async () => {
    const recorder = new SessionRecorder('1000', sessionFilePath(sessionDir, '1000'), { resumeFrom: [] })
    const app = buildApp({ repoPath: '/repo', repoName: 'repo', sessionDir, recorder })

    const get = await app.inject({ method: 'GET', url: '/api/transcript/nobody' })
    expect(get.statusCode).toBe(404)
    expect(get.json().available).toBe(false)

    const post = await app.inject({ method: 'POST', url: '/api/transcript/nobody' })
    expect(post.statusCode).toBe(404)
  })
})
