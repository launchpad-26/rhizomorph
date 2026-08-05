import { spawnSync } from 'node:child_process'
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createEvent } from '@rhizomorph/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
// The writing half lives behind the recorder seam (prd16 ruling 6); these
// reader/boundary tests still need a writer to lay down the fixtures they read.
import { dropTrailingPartialLine, SessionLogWriter } from '../recorder/index.js'
import {
  decideSessionBoot,
  findResumableSession,
  formatBootDuration,
  isClosedLog,
  listSessions,
  readResumedCount,
  readSessionEvents,
  recordResume,
  RESUME_WINDOW_MS,
  sessionFilePath,
} from './session-log.js'
import { LOCK_STALE_MS, writeSessionLock } from './session-lock.js'

/** A pid guaranteed dead by the time the assertion runs: a real process, spawned and reaped synchronously. */
function deadPid(): number {
  const result = spawnSync(process.execPath, ['-e', ''])
  const pid = result.pid
  if (!pid) throw new Error('expected the probe process to have been given a pid')
  return pid
}

/** A distinguishable, schema-valid event — `ts` is what the resume window reads. */
function errorEvent(id: string, ts: number, message = 'boom') {
  return createEvent('collector.error', { collector: 'git', message }, { id, ts })
}

describe('SessionLogWriter + readSessionEvents', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-log-test-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('appends events as JSONL and reads them back in order', async () => {
    const filePath = path.join(dir, 'session-1.jsonl')
    const writer = new SessionLogWriter(filePath)

    const events = [
      createEvent('session.started', {
        sessionId: '1',
        repoPath: '/repo',
        repoName: 'repo',
      }, { id: 'evt-1', ts: 1 }),
      createEvent('collector.error', { collector: 'git', message: 'boom' }, { id: 'evt-2', ts: 2 }),
    ]

    for (const event of events) await writer.append(event)

    const readBack = await readSessionEvents(filePath)
    expect(readBack).toEqual(events)
  })

  it('creates the parent directory lazily on first append', async () => {
    const filePath = path.join(dir, 'nested', 'session-2.jsonl')
    const writer = new SessionLogWriter(filePath)
    const event = createEvent('collector.disabled', { collector: 'tmux', reason: 'no tmux' }, {
      id: 'evt-1',
      ts: 1,
    })

    await writer.append(event)

    expect(await readSessionEvents(filePath)).toEqual([event])
  })

  it('returns an empty array for a session file that does not exist', async () => {
    expect(await readSessionEvents(path.join(dir, 'missing.jsonl'))).toEqual([])
  })

  it('skips malformed or invalid lines instead of throwing', async () => {
    const filePath = path.join(dir, 'session-3.jsonl')
    const writer = new SessionLogWriter(filePath)
    const good = createEvent('collector.error', { collector: 'git', message: 'ok' }, {
      id: 'evt-1',
      ts: 1,
    })
    await writer.append(good)
    const { appendFile } = await import('node:fs/promises')
    await appendFile(filePath, 'not json at all\n', 'utf8')
    await appendFile(filePath, `${JSON.stringify({ id: 'x', ts: 1 })}\n`, 'utf8')

    expect(await readSessionEvents(filePath)).toEqual([good])
  })
})

describe('dropTrailingPartialLine', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-log-test-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('drops a half-written final line and keeps every whole line before it', async () => {
    const filePath = path.join(dir, 'session-1.jsonl')
    const kept = errorEvent('evt-1', 1)
    await writeFile(filePath, `${JSON.stringify(kept)}\n${JSON.stringify(errorEvent('evt-2', 2)).slice(0, 20)}`)

    expect(await dropTrailingPartialLine(filePath)).toBe(true)
    expect(await readFile(filePath, 'utf8')).toBe(`${JSON.stringify(kept)}\n`)
    expect(await readSessionEvents(filePath)).toEqual([kept])
  })

  it('leaves a file that already ends in a newline alone', async () => {
    const filePath = path.join(dir, 'session-2.jsonl')
    const whole = `${JSON.stringify(errorEvent('evt-1', 1))}\n`
    await writeFile(filePath, whole)

    expect(await dropTrailingPartialLine(filePath)).toBe(false)
    expect(await readFile(filePath, 'utf8')).toBe(whole)
  })

  it('empties a file whose only line is half-written', async () => {
    const filePath = path.join(dir, 'session-3.jsonl')
    await writeFile(filePath, '{"id":"evt-1","ts"')

    expect(await dropTrailingPartialLine(filePath)).toBe(true)
    expect(await readFile(filePath, 'utf8')).toBe('')
  })

  it('reports nothing to repair for a file that does not exist', async () => {
    expect(await dropTrailingPartialLine(path.join(dir, 'missing.jsonl'))).toBe(false)
  })
})

describe('SessionLogWriter resuming an existing file', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-log-test-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('drops the crash-truncated final line before its first append, so the new event survives', async () => {
    const filePath = path.join(dir, 'session-1.jsonl')
    const kept = errorEvent('evt-1', 1)
    await writeFile(filePath, `${JSON.stringify(kept)}\n{"id":"evt-2","ts":2,"ty`)

    const writer = new SessionLogWriter(filePath, { resuming: true })
    const appended = errorEvent('evt-3', 3, 'after the crash')
    await writer.append(appended)

    expect(await readSessionEvents(filePath)).toEqual([kept, appended])
  })

  it('repairs once, not before every append', async () => {
    const filePath = path.join(dir, 'session-2.jsonl')
    await writeFile(filePath, '{"half":')

    const writer = new SessionLogWriter(filePath, { resuming: true })
    const first = errorEvent('evt-1', 1)
    const second = errorEvent('evt-2', 2)
    await writer.append(first)
    await writer.append(second)

    expect(await readSessionEvents(filePath)).toEqual([first, second])
  })
})

describe('findResumableSession', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-log-test-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('returns null when there is no session directory at all', async () => {
    expect(await findResumableSession(path.join(dir, 'nope'), 1000)).toBeNull()
  })

  it('returns null when the directory holds no session file', async () => {
    await writeFile(path.join(dir, 'README.md'), 'not a session', 'utf8')
    expect(await findResumableSession(dir, 1000)).toBeNull()
  })

  it('returns the newest session, with its events, when it is inside the window', async () => {
    const older = errorEvent('evt-1', 1000)
    const newest = errorEvent('evt-2', 5000)
    await new SessionLogWriter(sessionFilePath(dir, '1000')).append(older)
    const newer = new SessionLogWriter(sessionFilePath(dir, '4000'))
    await newer.append(newest)

    const resumable = await findResumableSession(dir, 6000)
    expect(resumable?.sessionId).toBe('4000')
    expect(resumable?.filePath).toBe(sessionFilePath(dir, '4000'))
    expect(resumable?.events).toEqual([newest])
  })

  it('resumes at exactly the window boundary and refuses one millisecond past it', async () => {
    const lastEventTs = 1_000_000
    await new SessionLogWriter(sessionFilePath(dir, '900000')).append(errorEvent('evt-1', lastEventTs))

    expect(await findResumableSession(dir, lastEventTs + RESUME_WINDOW_MS)).not.toBeNull()
    expect(await findResumableSession(dir, lastEventTs + RESUME_WINDOW_MS + 1)).toBeNull()
  })

  it('judges recency by the newest event, not the last line — source timestamps are not sorted', async () => {
    const filePath = sessionFilePath(dir, '1000')
    const writer = new SessionLogWriter(filePath)
    await writer.append(errorEvent('evt-1', 10_000_000)) // recorded now
    await writer.append(errorEvent('evt-2', 1000)) // a week-old log line, tailed after it

    expect(await findResumableSession(dir, 10_000_000 + 1000)).not.toBeNull()
  })

  it('returns null for a newest session file with nothing readable in it', async () => {
    await writeFile(sessionFilePath(dir, '1000'), '', 'utf8')
    expect(await findResumableSession(dir, 1000)).toBeNull()
  })

  it('survives a crash-truncated final line: the whole lines before it are the resume point', async () => {
    const filePath = sessionFilePath(dir, '1000')
    const kept = errorEvent('evt-1', 1000)
    await new SessionLogWriter(filePath).append(kept)
    await appendFile(filePath, '{"id":"evt-2","ts":2000,"ty', 'utf8')

    const resumable = await findResumableSession(dir, 2000)
    expect(resumable?.sessionId).toBe('1000')
    expect(resumable?.events).toEqual([kept])
  })

  it('honours an explicit window, so the boundary is one constant and not a hidden rule', async () => {
    await new SessionLogWriter(sessionFilePath(dir, '1000')).append(errorEvent('evt-1', 1000))

    expect(await findResumableSession(dir, 3000, 1000)).toBeNull()
    expect(await findResumableSession(dir, 3000, 5000)).not.toBeNull()
  })
})

describe('listSessions', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-log-test-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('returns an empty list when the directory does not exist', async () => {
    expect(await listSessions(path.join(dir, 'nope'))).toEqual([])
  })

  it('lists session files sorted oldest first, ignoring unrelated files', async () => {
    await new SessionLogWriter(sessionFilePath(dir, '200')).append(
      createEvent('collector.error', { collector: 'git', message: 'x' }, { id: 'evt-1', ts: 1 }),
    )
    await new SessionLogWriter(sessionFilePath(dir, '100')).append(
      createEvent('collector.error', { collector: 'git', message: 'x' }, { id: 'evt-1', ts: 1 }),
    )
    const { writeFile } = await import('node:fs/promises')
    await writeFile(path.join(dir, 'README.md'), 'not a session', 'utf8')

    const sessions = await listSessions(dir)
    expect(sessions.map((s) => s.id)).toEqual(['100', '200'])
    expect(sessions[0]?.fileName).toBe('session-100.jsonl')
  })
})

describe('decideSessionBoot', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-log-test-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('states "first-run", as data, when nothing has ever been recorded', async () => {
    const decision = await decideSessionBoot(dir, 1000)
    expect(decision).toEqual({
      reason: 'first-run',
      resumed: null,
      windowMs: RESUME_WINDOW_MS,
      previousAgeMs: null,
      eventCountAtBoot: 0,
      resumedCount: 0,
      liveWriter: null,
    })
  })

  it('states "resumed", as data, with the resumed session, its age, event count and resumedCount so far', async () => {
    await new SessionLogWriter(sessionFilePath(dir, '1000')).append(errorEvent('evt-1', 1000))
    await recordResume(dir, '1000')

    const decision = await decideSessionBoot(dir, 6000)
    expect(decision.reason).toBe('resumed')
    expect(decision.resumed?.sessionId).toBe('1000')
    expect(decision.previousAgeMs).toBe(5000)
    expect(decision.eventCountAtBoot).toBe(1)
    expect(decision.resumedCount).toBe(1)
    expect(decision.windowMs).toBe(RESUME_WINDOW_MS)
  })

  it('states "stale", as data, with the previous session\'s age when it is outside the window', async () => {
    await new SessionLogWriter(sessionFilePath(dir, '1000')).append(errorEvent('evt-1', 1000))

    const decision = await decideSessionBoot(dir, 1000 + RESUME_WINDOW_MS + 1)
    expect(decision.reason).toBe('stale')
    expect(decision.resumed).toBeNull()
    expect(decision.previousAgeMs).toBe(RESUME_WINDOW_MS + 1)
    expect(decision.eventCountAtBoot).toBe(0)
    expect(decision.resumedCount).toBe(0)
  })

  /**
   * prd16 ruling 1's order of authority — the operator's explicit act, then the
   * flags, then the window — and ruling 2's act. A log the operator closed is
   * finished: no window, no lock and no heuristic may reopen it.
   */
  describe('a closed log is never resumed', () => {
    async function writeClosedSession(sessionId: string, ts: number): Promise<void> {
      const writer = new SessionLogWriter(sessionFilePath(dir, sessionId))
      await writer.append(errorEvent('evt-1', ts))
      await writer.append(
        createEvent(
          'session.closed',
          { sessionId, reason: 'rotated', eventCount: 2 },
          { id: `session-closed-${sessionId}`, ts },
        ),
      )
    }

    it('states "closed", as data, even for a session seconds old', async () => {
      await writeClosedSession('1000', 1000)

      const decision = await decideSessionBoot(dir, 1100)
      expect(decision).toEqual({
        reason: 'closed',
        resumed: null,
        windowMs: RESUME_WINDOW_MS,
        // The age is still reported: the boundary explains itself, and "100ms
        // old and closed" is exactly what makes this reason different to stale.
        previousAgeMs: 100,
        eventCountAtBoot: 0,
        resumedCount: 0,
        liveWriter: null,
      })
    })

    it('outranks a live lock — a closed log with a heartbeating writer beside it is still closed', async () => {
      await writeClosedSession('1000', 1000)
      await writeSessionLock(dir, '1000', process.pid, 1000)

      const decision = await decideSessionBoot(dir, 1100)
      expect(decision.reason).toBe('closed')
      expect(decision.liveWriter).toBeNull()
    })

    it('yields to --fresh, which asks the same question and is answered first', async () => {
      await writeClosedSession('1000', 1000)

      const decision = await decideSessionBoot(dir, 1100, { fresh: true })
      expect(decision.reason).toBe('fresh-flag')
    })

    it('does not affect an OLDER closed session once a newer open one exists', async () => {
      await writeClosedSession('1000', 1000)
      await new SessionLogWriter(sessionFilePath(dir, '2000')).append(errorEvent('evt-9', 2000))

      const decision = await decideSessionBoot(dir, 2100)
      expect(decision.reason).toBe('resumed')
      expect(decision.resumed?.sessionId).toBe('2000')
    })

    it('isClosedLog reads the fact off the events, and says no for an open log', async () => {
      expect(isClosedLog([errorEvent('evt-1', 1)])).toBe(false)
      expect(isClosedLog([])).toBe(false)
      expect(
        isClosedLog([
          errorEvent('evt-1', 1),
          createEvent('session.closed', { sessionId: '1', reason: 'rotated' }, { id: 'c', ts: 2 }),
        ]),
      ).toBe(true)
    })
  })

  it('states "stale" with a null age when the newest session file has nothing readable in it', async () => {
    await writeFile(sessionFilePath(dir, '1000'), '', 'utf8')

    const decision = await decideSessionBoot(dir, 1000)
    expect(decision.reason).toBe('stale')
    expect(decision.previousAgeMs).toBeNull()
  })

  it('states "fresh-flag" when fresh is requested, even over a session well inside the window', async () => {
    await new SessionLogWriter(sessionFilePath(dir, '1000')).append(errorEvent('evt-1', 1000))

    const decision = await decideSessionBoot(dir, 1100, { fresh: true })
    expect(decision).toEqual({
      reason: 'fresh-flag',
      resumed: null,
      windowMs: RESUME_WINDOW_MS,
      previousAgeMs: null,
      eventCountAtBoot: 0,
      resumedCount: 0,
      liveWriter: null,
    })
  })

  it('honours an explicit windowMs, the same boundary findResumableSession already respects', async () => {
    await new SessionLogWriter(sessionFilePath(dir, '1000')).append(errorEvent('evt-1', 1000))

    expect((await decideSessionBoot(dir, 3000, { windowMs: 1000 })).reason).toBe('stale')
    expect((await decideSessionBoot(dir, 3000, { windowMs: 5000 })).reason).toBe('resumed')
  })

  it('law: --resume-window 0 behaves exactly like --fresh, even for a session whose newest event lands on nowMs', async () => {
    await new SessionLogWriter(sessionFilePath(dir, '1000')).append(errorEvent('evt-1', 5000))

    const zeroWindow = await decideSessionBoot(dir, 5000, { windowMs: 0 })
    const explicitFresh = await decideSessionBoot(dir, 5000, { fresh: true })
    expect(zeroWindow.reason).toBe(explicitFresh.reason)
    expect(zeroWindow.resumed).toBe(explicitFresh.resumed)
    expect(zeroWindow.reason).toBe('fresh-flag')
    expect(zeroWindow.resumed).toBeNull()
  })

  it('never writes: repeated calls read the same state back without incrementing resumedCount', async () => {
    await new SessionLogWriter(sessionFilePath(dir, '1000')).append(errorEvent('evt-1', 1000))
    await recordResume(dir, '1000')

    await decideSessionBoot(dir, 6000)
    await decideSessionBoot(dir, 6000)
    const decision = await decideSessionBoot(dir, 6000)

    expect(decision.resumedCount).toBe(1)
  })

  describe('the agnosticism spike\'s liveness guard (headline verdict 4, §3 adjacent case)', () => {
    it('law: states "writer-alive" instead of resuming a session whose lock names a live pid — two boots never share a session id', async () => {
      await new SessionLogWriter(sessionFilePath(dir, '1000')).append(errorEvent('evt-1', 1000))
      await writeSessionLock(dir, '1000', process.pid, 1000)

      const decision = await decideSessionBoot(dir, 6000)

      expect(decision).toEqual({
        reason: 'writer-alive',
        resumed: null,
        windowMs: RESUME_WINDOW_MS,
        previousAgeMs: 5000,
        eventCountAtBoot: 0,
        resumedCount: 0,
        liveWriter: { sessionId: '1000', pid: process.pid },
      })
    })

    it('law: a crash never strands a session — a lock naming a dead pid resumes exactly as if there were no lock', async () => {
      await new SessionLogWriter(sessionFilePath(dir, '1000')).append(errorEvent('evt-1', 1000))
      await writeSessionLock(dir, '1000', deadPid(), 1000)

      const decision = await decideSessionBoot(dir, 6000)

      expect(decision.reason).toBe('resumed')
      expect(decision.resumed?.sessionId).toBe('1000')
      expect(decision.liveWriter).toBeNull()
    })

    it('a lock whose heartbeat is older than LOCK_STALE_MS resumes even for a technically-live pid — the pid-reuse backstop', async () => {
      await new SessionLogWriter(sessionFilePath(dir, '1000')).append(errorEvent('evt-1', 1000))
      await writeSessionLock(dir, '1000', process.pid, 1000)

      const decision = await decideSessionBoot(dir, 1000 + LOCK_STALE_MS + 1)

      expect(decision.reason).toBe('resumed')
      expect(decision.liveWriter).toBeNull()
    })

    it('a session with no lock at all resumes exactly as before this guard existed', async () => {
      await new SessionLogWriter(sessionFilePath(dir, '1000')).append(errorEvent('evt-1', 1000))

      const decision = await decideSessionBoot(dir, 6000)

      expect(decision.reason).toBe('resumed')
      expect(decision.liveWriter).toBeNull()
    })

    it('a corrupt lock file is treated the same as no lock — resumes, never throws', async () => {
      await new SessionLogWriter(sessionFilePath(dir, '1000')).append(errorEvent('evt-1', 1000))
      await writeFile(path.join(dir, 'session-1000.lock.json'), 'not json', 'utf8')

      const decision = await decideSessionBoot(dir, 6000)

      expect(decision.reason).toBe('resumed')
    })

    it('--fresh silences the guard even over a live-locked session — the operator\'s explicit override wins', async () => {
      await new SessionLogWriter(sessionFilePath(dir, '1000')).append(errorEvent('evt-1', 1000))
      await writeSessionLock(dir, '1000', process.pid, 1000)

      const decision = await decideSessionBoot(dir, 6000, { fresh: true })

      expect(decision.reason).toBe('fresh-flag')
    })
  })
})

describe('readResumedCount + recordResume', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-log-test-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('reads 0 for a session that has never been resumed', async () => {
    expect(await readResumedCount(dir, '1000')).toBe(0)
  })

  it('increments across separate calls the way separate boots would make them', async () => {
    expect(await recordResume(dir, '1000')).toBe(1)
    expect(await recordResume(dir, '1000')).toBe(2)
    expect(await recordResume(dir, '1000')).toBe(3)
    expect(await readResumedCount(dir, '1000')).toBe(3)
  })

  it('keys the counter by session id — a different session starts at 0', async () => {
    await recordResume(dir, '1000')
    await recordResume(dir, '1000')

    expect(await readResumedCount(dir, '2000')).toBe(0)
  })

  it('falls back to 0 for a corrupt counter file instead of throwing', async () => {
    await writeFile(path.join(dir, 'session-1000.resumes.json'), 'not json', 'utf8')

    expect(await readResumedCount(dir, '1000')).toBe(0)
  })

  it('does not create the session-*.jsonl file, or corrupt listSessions', async () => {
    await new SessionLogWriter(sessionFilePath(dir, '1000')).append(errorEvent('evt-1', 1000))
    await recordResume(dir, '1000')

    const sessions = await listSessions(dir)
    expect(sessions.map((s) => s.id)).toEqual(['1000'])
  })
})

describe('formatBootDuration', () => {
  it('renders hours and minutes together, padded to two digits', () => {
    expect(formatBootDuration(2 * 3_600_000 + 4 * 60_000)).toBe('2h04m')
    expect(formatBootDuration(9 * 3_600_000 + 13 * 60_000)).toBe('9h13m')
  })

  it('drops a zeroed minutes component off a round number of hours', () => {
    expect(formatBootDuration(RESUME_WINDOW_MS)).toBe('4h')
  })

  it('renders minutes and seconds together, padded to two digits', () => {
    expect(formatBootDuration(45 * 60_000 + 30_000)).toBe('45m30s')
  })

  it('drops a zeroed seconds component off a round number of minutes', () => {
    expect(formatBootDuration(45 * 60_000)).toBe('45m')
  })

  it('renders sub-minute durations as seconds', () => {
    expect(formatBootDuration(12_000)).toBe('12s')
    expect(formatBootDuration(0)).toBe('0s')
  })
})
