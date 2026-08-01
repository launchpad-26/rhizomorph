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
  CONDUCTOR_LANE,
  TOOL_RESULT_MAX_CHARS,
  candidateTranscriptPaths,
  findConductorAttribution,
  findLaneAttribution,
  parseTranscript,
  parseTranscriptEntry,
  readTranscript,
  registerTranscriptRoute,
  type TranscriptEntry,
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

/** Where an `--extra-sessions` conductor's own log lives, in the attribution. */
const CONDUCTOR_DIR = '/tmp/observatory-fixture/conductor'

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

/** An assistant turn whose content is the given raw blocks, verbatim. */
function blocksLine(content: unknown[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'assistant',
    sessionId: SESSION_ID,
    message: { role: 'assistant', model: 'claude-opus-5', content },
    ...extra,
  })
}

/** What a line's text blocks say, joined — the shorthand most assertions want. */
function proseOf(entry: TranscriptEntry | null): string {
  return (entry?.blocks ?? [])
    .map((block) => (block.kind === 'text' ? block.text : null))
    .filter((text): text is string => text !== null)
    .join('\n')
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

describe('findConductorAttribution (prd6 ruling 5)', () => {
  it('finds the conductor by its declared role, whatever handle it was given', () => {
    // `--extra-sessions <dir>:orchestrator` — the handle is the operator's, the
    // role is the collector's. Matching on the name would find nothing here.
    const f = createEventFactory()
    const events = [
      f.llmUsage({ lane: LANE, branch: LANE, sessionId: SESSION_ID, worktreePath: WORKTREE }),
      f.llmUsage({
        lane: 'orchestrator',
        role: 'conductor',
        sessionId: 'sess-conductor',
        worktreePath: CONDUCTOR_DIR,
      }),
    ]

    expect(findConductorAttribution(events)).toEqual({
      sessionId: 'sess-conductor',
      worktreePath: CONDUCTOR_DIR,
    })
  })

  it('takes the newest conductor attribution, not the first', () => {
    const f = createEventFactory()
    const events = [
      f.llmUsage({ lane: 'conductor', role: 'conductor', sessionId: 'sess-old', worktreePath: CONDUCTOR_DIR }),
      f.llmCost({ lane: 'conductor', role: 'conductor', sessionId: 'sess-new', worktreePath: CONDUCTOR_DIR }),
    ]

    expect(findConductorAttribution(events)?.sessionId).toBe('sess-new')
  })

  it('is null when every row is a worker — a lane named conductor proves nothing', () => {
    const f = createEventFactory()
    const events = [
      f.llmUsage({ lane: 'conductor', role: 'worker', sessionId: 'sess-x', worktreePath: WORKTREE }),
    ]

    expect(findConductorAttribution(events)).toBeNull()
  })

  it('ignores conductor telemetry that carries no session id', () => {
    const f = createEventFactory()
    const events = [
      f.llmCost({ lane: 'conductor', role: 'conductor', sessionId: null, worktreePath: null }, { source: 'otel' }),
    ]

    expect(findConductorAttribution(events)).toBeNull()
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

describe('parseTranscriptEntry — role mapping', () => {
  it('reads a user turn as the user speaking', () => {
    expect(parseTranscriptEntry(userLine('read the docs'))).toEqual({
      role: 'user',
      blocks: [{ kind: 'text', text: 'read the docs' }],
    })
  })

  it('reads an assistant turn as the assistant speaking', () => {
    expect(parseTranscriptEntry(assistantLine('on it'))).toEqual({
      role: 'assistant',
      blocks: [{ kind: 'text', text: 'on it' }],
    })
  })

  it('gives a sidechain turn the subagent role — whose voice it is, in the data', () => {
    const entry = parseTranscriptEntry(assistantLine('sub work', { isSidechain: true }))

    expect(entry?.role).toBe('subagent')
    expect(proseOf(entry)).toBe('sub work')
  })

  it('a sidechain user turn is the subagent too — the whole side thread is quieter', () => {
    const raw = JSON.stringify({
      type: 'user',
      isSidechain: true,
      message: { role: 'user', content: 'go and look' },
    })

    expect(parseTranscriptEntry(raw)?.role).toBe('subagent')
  })

  it('carries the log\'s own timestamp when the line has one, and omits it when it does not', () => {
    const stamped = parseTranscriptEntry(assistantLine('later', { timestamp: '2026-08-01T12:00:00.000Z' }))

    expect(stamped?.ts).toBe('2026-08-01T12:00:00.000Z')
    expect(parseTranscriptEntry(assistantLine('now'))).not.toHaveProperty('ts')
  })

  it('skips lines that are not a turn at all', () => {
    expect(parseTranscriptEntry(JSON.stringify({ type: 'summary', summary: 'x' }))).toBeNull()
    expect(parseTranscriptEntry('   ')).toBeNull()
  })

  it('keeps an unparsable line visible, in the parser\'s own voice', () => {
    expect(parseTranscriptEntry('{ not json')).toEqual({
      role: 'system',
      blocks: [{ kind: 'text', text: '⟨unreadable line⟩' }],
    })
  })
})

describe('parseTranscriptEntry — blocks', () => {
  it('reads a tool call as its name and the one input field worth showing', () => {
    const entry = parseTranscriptEntry(
      blocksLine([{ type: 'tool_use', name: 'Bash', input: { command: 'npm test\n--watch' } }]),
    )

    expect(entry?.blocks).toEqual([{ kind: 'tool_use', name: 'Bash', hint: 'npm test' }])
  })

  it('hints with the file path when there is no command', () => {
    const entry = parseTranscriptEntry(
      blocksLine([{ type: 'tool_use', name: 'Read', input: { file_path: '/repo/README.md' } }]),
    )

    expect(entry?.blocks).toEqual([{ kind: 'tool_use', name: 'Read', hint: '/repo/README.md' }])
  })

  it('leaves the hint empty rather than inventing one, and still names the tool', () => {
    const entry = parseTranscriptEntry(blocksLine([{ type: 'tool_use', name: 'TodoWrite', input: { todos: [] } }]))

    expect(entry?.blocks).toEqual([{ kind: 'tool_use', name: 'TodoWrite', hint: '' }])
  })

  it('keeps prose and the tool calls between it in the order they were said', () => {
    const entry = parseTranscriptEntry(
      blocksLine([
        { type: 'text', text: 'reading it now' },
        { type: 'tool_use', name: 'Read', input: { file_path: 'a.ts' } },
      ]),
    )

    expect(entry?.blocks.map((block) => block.kind)).toEqual(['text', 'tool_use'])
  })

  it('reads a tool result, whole, when it is short', () => {
    const entry = parseTranscriptEntry(
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', content: '3 files changed' }] },
      }),
    )

    expect(entry?.blocks).toEqual([{ kind: 'tool_result', text: '3 files changed', dropped: 0 }])
  })

  it('flattens a tool result that arrived as content blocks', () => {
    const entry = parseTranscriptEntry(
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              content: [
                { type: 'text', text: 'line one' },
                { type: 'text', text: 'line two' },
              ],
            },
          ],
        },
      }),
    )

    expect(entry?.blocks).toEqual([{ kind: 'tool_result', text: 'line one\nline two', dropped: 0 }])
  })

  it('truncates a long tool result and says how much it cut — never a silent trim', () => {
    const long = 'x'.repeat(TOOL_RESULT_MAX_CHARS + 250)
    const entry = parseTranscriptEntry(
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', content: long }] },
      }),
    )

    expect(entry?.blocks).toEqual([
      { kind: 'tool_result', text: 'x'.repeat(TOOL_RESULT_MAX_CHARS), dropped: 250 },
    ])
  })

  it('never emits a thinking block', () => {
    const entry = parseTranscriptEntry(
      blocksLine([
        { type: 'thinking', thinking: 'private reasoning' },
        { type: 'text', text: 'the answer' },
      ]),
    )

    expect(entry?.blocks).toEqual([{ kind: 'text', text: 'the answer' }])
    expect(JSON.stringify(entry)).not.toContain('private reasoning')
  })

  it('is not a turn at all when thinking was the only thing in it', () => {
    expect(parseTranscriptEntry(blocksLine([{ type: 'thinking', thinking: 'quiet' }]))).toBeNull()
  })
})

describe('parseTranscript', () => {
  it('is the window\'s turns, oldest first', () => {
    expect(parseTranscript([userLine('a'), assistantLine('b')])).toEqual([
      { role: 'user', blocks: [{ kind: 'text', text: 'a' }] },
      { role: 'assistant', blocks: [{ kind: 'text', text: 'b' }] },
    ])
  })

  it('is empty when no line said anything', () => {
    expect(parseTranscript([JSON.stringify({ type: 'summary' })])).toEqual([])
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
    expect(result.entries).toEqual([
      { role: 'user', blocks: [{ kind: 'text', text: 'go' }] },
      { role: 'assistant', blocks: [{ kind: 'text', text: 'going' }] },
    ])
    expect(result.eof).toBe(true)
    expect(result.nextOffset).toBe(result.size)
    expect(result.restarted).toBe(false)
  })

  it('pages: each chunk resumes exactly where the last one stopped, and the pages reassemble', async () => {
    const lines = [userLine('one'), assistantLine('two'), userLine('three'), assistantLine('four')]
    await writeLog(lines)

    let offset = 0
    const pages: TranscriptEntry[][] = []
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
      pages.push(page.entries)
      offset = page.nextOffset
      if (page.eof) break
    }

    expect(pages.length).toBeGreaterThan(1)
    // Every page carried at least one turn, and concatenating them is the same
    // conversation as reading the whole log at once — paging that neither drops
    // a turn nor repeats one.
    expect(pages.every((page) => page.length > 0)).toBe(true)
    expect(pages.flat()).toEqual(parseTranscript(lines))
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
    expect(second.entries).toEqual([])
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
    expect(second.entries).toEqual([{ role: 'assistant', blocks: [{ kind: 'text', text: 'second' }] }])
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
    expect(result.entries).toEqual([{ role: 'user', blocks: [{ kind: 'text', text: 'done' }] }])
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
    expect(result.entries).toEqual([{ role: 'user', blocks: [{ kind: 'text', text: 'fresh' }] }])
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
    expect(result.entries).toEqual([{ role: 'assistant', blocks: [{ kind: 'text', text: 'conducting' }] }])
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

  /**
   * THE CONDUCTOR'S OWN SESSION (prd6 ruling 5), under the `main` identifier.
   * Same route, same reader, same chunking — only the attribution differs.
   */
  describe('the conductor, as `main`', () => {
    it("reads the conductor's own session from its role attribution", async () => {
      const dir = path.join(projectsRoot, 'conductor-session-dir')
      await mkdir(dir, { recursive: true })
      await writeFile(path.join(dir, 'sess-conductor.jsonl'), `${assistantLine('dispatching #107')}\n`)

      const f = createEventFactory()
      const result = await readTranscript({
        events: [
          ...laneEvents(),
          f.llmUsage({
            lane: 'orchestrator',
            role: 'conductor',
            sessionId: 'sess-conductor',
            worktreePath: dir,
          }),
        ],
        lane: CONDUCTOR_LANE,
        offset: 0,
        claudeProjectsRoot: projectsRoot,
      })

      expect(result.available).toBe(true)
      if (!result.available) return
      expect(result.lane).toBe('main')
      expect(result.sessionId).toBe('sess-conductor')
      expect(result.entries).toEqual([
        { role: 'assistant', blocks: [{ kind: 'text', text: 'dispatching #107' }] },
      ])
    })

    it('falls back to the session booked against main itself when no role said conductor', async () => {
      // An orchestrator driving the main checkout with no `--extra-sessions`:
      // its spend is booked to the root-mass's own branch, and that session is
      // the one the root-mass's drawer should read. Still a recorded fact, not
      // a guess — the log named the branch.
      const dir = path.join(projectsRoot, PROJECT_SLUG)
      await mkdir(dir, { recursive: true })
      await writeFile(path.join(dir, `${SESSION_ID}.jsonl`), `${assistantLine('on main')}\n`)

      const f = createEventFactory()
      const result = await readTranscript({
        events: [f.llmUsage({ lane: 'main', branch: 'main', sessionId: SESSION_ID, worktreePath: WORKTREE })],
        lane: CONDUCTOR_LANE,
        offset: 0,
        claudeProjectsRoot: projectsRoot,
      })

      expect(result.available).toBe(true)
      if (!result.available) return
      expect(result.entries).toEqual([{ role: 'assistant', blocks: [{ kind: 'text', text: 'on main' }] }])
    })

    it('says the conductor is not instrumented, with the command, rather than going blank', async () => {
      const result = await readTranscript({
        events: laneEvents(),
        lane: CONDUCTOR_LANE,
        offset: 0,
        claudeProjectsRoot: projectsRoot,
      })

      expect(result.available).toBe(false)
      if (result.available) return
      expect(result.reason).toContain('CONDUCTOR NOT INSTRUMENTED')
      expect(result.reason).toContain('role: conductor')
      expect(result.reason).toContain('observatory --extra-sessions <dir>:conductor')
      // Never the worker voice: "no such lane main" would send the operator
      // looking for a worktree that was never the point.
      expect(result.reason).not.toContain('NO SUCH LANE')
    })

    it('says something else again when the conductor is instrumented but nameless', async () => {
      const f = createEventFactory()
      const result = await readTranscript({
        events: [
          f.llmCost(
            { lane: 'conductor', role: 'conductor', sessionId: null, worktreePath: null },
            { source: 'otel' },
          ),
        ],
        lane: CONDUCTOR_LANE,
        offset: 0,
        claudeProjectsRoot: projectsRoot,
      })

      expect(result.available).toBe(false)
      if (result.available) return
      expect(result.reason).toContain('NO SESSION LOG for the conductor')
      expect(result.reason).toContain('no session id')
      expect(result.reason).toContain('observatory doctor')
    })

    it('names the conductor, not a lane, when its log is simply not on disk', async () => {
      const f = createEventFactory()
      const result = await readTranscript({
        events: [
          f.llmUsage({
            lane: 'conductor',
            role: 'conductor',
            sessionId: 'sess-conductor',
            worktreePath: CONDUCTOR_DIR,
          }),
        ],
        lane: CONDUCTOR_LANE,
        offset: 0,
        claudeProjectsRoot: projectsRoot,
      })

      expect(result.available).toBe(false)
      if (result.available) return
      expect(result.reason).toContain('NO SESSION LOG for the conductor')
      expect(result.reason).toContain('sess-conductor')
      expect(result.reason).toContain(CONDUCTOR_DIR)
    })
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
    expect(body.entries).toEqual([
      { role: 'user', blocks: [{ kind: 'text', text: 'hello' }] },
      { role: 'assistant', blocks: [{ kind: 'text', text: 'hi' }] },
    ])
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

    expect(proseOf(first.json().entries[0])).toBe('hello')
    expect(second.json().entries).toEqual([
      { role: 'assistant', blocks: [{ kind: 'text', text: 'hi' }] },
    ])
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

  it('serves the conductor on the same route, under `main` — no route of its own', async () => {
    const dir = path.join(projectsRoot, 'conductor-route-dir')
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'sess-conductor.jsonl'), `${userLine('dispatch wave 1')}\n`)

    const f = createEventFactory()
    const app = await makeApp([
      ...laneEvents(),
      f.llmUsage({ lane: 'conductor', role: 'conductor', sessionId: 'sess-conductor', worktreePath: dir }),
    ])

    const response = await app.inject({ method: 'GET', url: '/api/transcript/main' })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.available).toBe(true)
    expect(body.sessionId).toBe('sess-conductor')
    expect(body.entries).toEqual([{ role: 'user', blocks: [{ kind: 'text', text: 'dispatch wave 1' }] }])
  })

  it('404s with the gap voice, not blankness, when the conductor is uninstrumented', async () => {
    const response = await (await makeApp()).inject({ method: 'GET', url: '/api/transcript/main' })

    expect(response.statusCode).toBe(404)
    expect(response.json().reason).toContain('CONDUCTOR NOT INSTRUMENTED')
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
