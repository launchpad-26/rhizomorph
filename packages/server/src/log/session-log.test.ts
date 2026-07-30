import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createEvent } from '@observatory/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { listSessions, readSessionEvents, SessionLogWriter, sessionFilePath } from './session-log.js'

describe('SessionLogWriter + readSessionEvents', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'observatory-log-test-'))
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

describe('listSessions', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'observatory-log-test-'))
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
