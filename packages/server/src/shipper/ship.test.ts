import { appendFile, mkdtemp, rm, truncate, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createEvent, eventToLine } from '@rhizomorph/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TEAM_CONFIG_VERSION, writeTeamConfig } from './config.js'
import { readCursor } from './cursor.js'
import { writeIngestKey } from './key.js'
import type { FetchLike } from './post.js'
import { MAX_BATCH_ENTRIES, shipOnce, type ShipPassResult } from './ship.js'

const FIXTURE_KEY = 'rzk_SHIPFIXTUREVALUE0123456789'
const URL_BASE = 'https://team.example'

let sessionDir: string

interface Sent {
  actorInstance: string
  ns: number[]
  lines: string[]
}

/** A `fetch` that answers 202 and records every batch it was handed. */
function acceptingFetch(): { fetch: FetchLike; sent: Sent[] } {
  const sent: Sent[] = []
  const fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      actorInstance: string
      batch: { n: number; line: string }[]
    }
    sent.push({
      actorInstance: body.actorInstance,
      ns: body.batch.map((entry) => entry.n),
      lines: body.batch.map((entry) => entry.line),
    })
    return new Response(JSON.stringify({ accepted: body.batch.length, journalSeq: sent.length }), { status: 202 })
  }) as FetchLike
  return { fetch, sent }
}

function refusingFetch(status: number): FetchLike {
  return (async () => new Response('no', { status })) as FetchLike
}

let nextEventId = 0
function line(ts = 1785900000000): string {
  nextEventId += 1
  return eventToLine(
    createEvent(
      'pane.activity',
      { paneId: `%${nextEventId}`, contentHash: `h${nextEventId}`, previousHash: null },
      { id: `e${nextEventId}`, ts },
    ),
  )
}

function sessionFile(id: string): string {
  return path.join(sessionDir, `session-${id}.jsonl`)
}

async function seedSession(id: string, lines: readonly string[]): Promise<void> {
  await writeFile(sessionFile(id), lines.length === 0 ? '' : `${lines.join('\n')}\n`)
}

async function enable(): Promise<void> {
  await writeIngestKey(sessionDir, FIXTURE_KEY)
  await writeTeamConfig(sessionDir, {
    version: TEAM_CONFIG_VERSION,
    url: URL_BASE,
    project: 'acme-widgets',
    enabledAt: 1,
  })
}

function actorOf(result: ShipPassResult, id: string) {
  if (!result.enabled) throw new Error('the pass reported the shipper as off')
  const actor = result.actors.find((candidate) => candidate.actorInstance === id)
  if (actor === undefined) throw new Error(`no actor ${id} in the pass result`)
  return actor
}

beforeEach(async () => {
  sessionDir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-shipper-ship-'))
  nextEventId = 0
})

afterEach(async () => {
  await rm(sessionDir, { recursive: true, force: true })
})

describe('one pass of the hand — the happy path and the resume', () => {
  it('ships a cold session as one batch and advances the cursor to its last line', async () => {
    await enable()
    const lines = [line(), line(), line()]
    await seedSession('1785900000000', lines)
    const { fetch, sent } = acceptingFetch()

    const result = await shipOnce({ sessionDir, fetch, now: () => 99 })

    expect(sent).toHaveLength(1)
    expect(sent[0]?.actorInstance).toBe('1785900000000')
    expect(sent[0]?.ns).toEqual([1, 2, 3])
    expect(sent[0]?.lines).toEqual(lines)

    const stored = (await readCursor(sessionDir)).cursor.actors['1785900000000']
    expect(stored?.n).toBe(3)
    expect(stored?.offset).toBe(Buffer.byteLength(`${lines.join('\n')}\n`))
    expect(stored?.lastAckAt).toBe(99)
    expect(actorOf(result, '1785900000000').shipped).toBe(3)
  })

  it('resumes from the cursor and sends only what is new — no re-send', async () => {
    await enable()
    await seedSession('1785900000000', [line(), line(), line()])
    const { fetch, sent } = acceptingFetch()
    await shipOnce({ sessionDir, fetch })

    const more = [line(), line()]
    await appendFile(sessionFile('1785900000000'), `${more.join('\n')}\n`)
    await shipOnce({ sessionDir, fetch })

    expect(sent).toHaveLength(2)
    expect(sent[1]?.ns).toEqual([4, 5])
    expect(sent[1]?.lines).toEqual(more)
  })

  it('repetition, the crash case: two further passes off the on-disk cursor send nothing, with no duplicate and no gap in n', async () => {
    await enable()
    await seedSession('1785900000000', [line(), line(), line()])
    const { fetch, sent } = acceptingFetch()

    // Pass 1, then two more with no in-memory state carried over: `shipOnce`
    // holds none, so each of these re-reads the cursor off disk exactly as a
    // restarted process would.
    await shipOnce({ sessionDir, fetch })
    await shipOnce({ sessionDir, fetch })
    await shipOnce({ sessionDir, fetch })

    expect(sent).toHaveLength(1)
    const everyN = sent.flatMap((batch) => batch.ns)
    expect(everyN).toEqual([1, 2, 3])
    expect(new Set(everyN).size).toBe(everyN.length)
    expect(Math.max(...everyN)).toBe(everyN.length)
  })

  it('counts bytes, not UTF-16 units — a 4-byte emoji leaves the cursor on the file\'s real byte length', async () => {
    await enable()
    const emoji = eventToLine(
      createEvent('pane.activity', { paneId: '%🚀', contentHash: 'h🚀', previousHash: null }, { id: 'e1', ts: 1785900000000 }),
    )
    const lines = [emoji, line()]
    await seedSession('1785900000000', lines)
    const body = `${lines.join('\n')}\n`
    const { fetch, sent } = acceptingFetch()

    await shipOnce({ sessionDir, fetch })

    expect(sent[0]?.ns).toEqual([1, 2])
    const stored = (await readCursor(sessionDir)).cursor.actors['1785900000000']
    expect(stored?.offset).toBe(Buffer.byteLength(body, 'utf8'))
    // The wrong implementation — indexing the decoded string — would land here.
    expect(stored?.offset).not.toBe(body.length)
  })

  it('leaves a half-written last line alone, and ships it exactly once when its newline arrives', async () => {
    await enable()
    const complete = [line(), line()]
    const partial = line()
    await writeFile(sessionFile('1785900000000'), `${complete.join('\n')}\n${partial}`)
    const { fetch, sent } = acceptingFetch()

    await shipOnce({ sessionDir, fetch })
    expect(sent[0]?.ns).toEqual([1, 2])
    const afterFirst = (await readCursor(sessionDir)).cursor.actors['1785900000000']
    expect(afterFirst?.offset).toBe(Buffer.byteLength(`${complete.join('\n')}\n`))

    const tail = line()
    await appendFile(sessionFile('1785900000000'), `\n${tail}\n`)
    await shipOnce({ sessionDir, fetch })

    expect(sent[1]?.ns).toEqual([3, 4])
    expect(sent[1]?.lines).toEqual([partial, tail])
    // Once, not twice.
    expect(sent.flatMap((batch) => batch.ns)).toEqual([1, 2, 3, 4])
  })
})

describe('ruling A — an unfoldable line is skipped, recorded, and the cursor still advances', () => {
  it('ships the good lines, records both bad ones by n and kind, and does not re-record them next pass', async () => {
    await enable()
    const good1 = line()
    const good2 = line()
    const unknownType = JSON.stringify({ id: 'x1', ts: 1785900000000, source: 'tmux', type: 'from.the.future', payload: {} })
    await seedSession('1785900000000', [good1, '{not json', unknownType, good2])
    const { fetch, sent } = acceptingFetch()

    const first = await shipOnce({ sessionDir, fetch })

    expect(sent[0]?.ns).toEqual([1, 4])
    expect(sent[0]?.lines).toEqual([good1, good2])
    const stored = (await readCursor(sessionDir)).cursor.actors['1785900000000']
    expect(stored?.n).toBe(4)
    expect(stored?.skippedCount).toBe(2)
    expect(stored?.skipped.map((skip) => [skip.n, skip.kind])).toEqual([
      [2, 'malformed'],
      [3, 'unknown'],
    ])
    expect(stored?.skipped[1]?.reason).toContain('from.the.future')
    expect(actorOf(first, '1785900000000').skipped).toBe(2)

    await shipOnce({ sessionDir, fetch })
    const again = (await readCursor(sessionDir)).cursor.actors['1785900000000']
    expect(again?.skippedCount).toBe(2)
    expect(again?.skipped).toHaveLength(2)
    expect(sent).toHaveLength(1)
  })

  it('advances past a span that is ALL skips, so the hand cannot wedge on one bad line', async () => {
    await enable()
    await seedSession('1785900000000', ['{not json', '   '])
    const { fetch, sent } = acceptingFetch()

    await shipOnce({ sessionDir, fetch })

    expect(sent).toEqual([])
    const stored = (await readCursor(sessionDir)).cursor.actors['1785900000000']
    expect(stored?.n).toBe(2)
    expect(stored?.skippedCount).toBe(2)
  })
})

describe('ruling B — a ledger that shrank below its cursor is refused, never re-read from 0', () => {
  it('names the shrink, ships nothing for that actor, leaves its cursor alone, and still ships its sibling', async () => {
    await enable()
    await seedSession('1785900000000', [line(), line(), line()])
    const { fetch, sent } = acceptingFetch()
    await shipOnce({ sessionDir, fetch })
    const before = (await readCursor(sessionDir)).cursor.actors['1785900000000']

    await truncate(sessionFile('1785900000000'), 5)
    const sibling = [line()]
    await seedSession('1785900000001', sibling)

    const result = await shipOnce({ sessionDir, fetch })

    const shrunk = actorOf(result, '1785900000000')
    expect(shrunk.reason).toBe('shrank')
    expect(shrunk.detail).toContain('replaced or truncated')
    expect(shrunk.advanced).toBe(false)
    expect((await readCursor(sessionDir)).cursor.actors['1785900000000']).toEqual(before)

    expect(sent).toHaveLength(2)
    expect(sent[1]?.actorInstance).toBe('1785900000001')
    expect(sent[1]?.ns).toEqual([1])
    expect(result.enabled && result.ok).toBe(false)
  })
})

describe('nothing advances on a refusal, and every actor gets its own n', () => {
  it('a 500 leaves the cursor untouched and the next pass re-sends the identical batch', async () => {
    await enable()
    const lines = [line(), line()]
    await seedSession('1785900000000', lines)
    const result = await shipOnce({ sessionDir, fetch: refusingFetch(500) })
    expect(actorOf(result, '1785900000000').reason).toBe('unreachable')
    expect((await readCursor(sessionDir)).cursor.actors['1785900000000']).toBeUndefined()

    const { fetch, sent } = acceptingFetch()
    await shipOnce({ sessionDir, fetch })
    expect(sent[0]?.ns).toEqual([1, 2])
    expect(sent[0]?.lines).toEqual(lines)
  })

  it('two sessions are two POSTs, each with its own actorInstance and its own n starting at 1', async () => {
    await enable()
    await seedSession('1785900000000', [line(), line()])
    await seedSession('1785900000002', [line()])
    const { fetch, sent } = acceptingFetch()

    await shipOnce({ sessionDir, fetch })

    expect(sent.map((batch) => [batch.actorInstance, batch.ns])).toEqual([
      ['1785900000000', [1, 2]],
      ['1785900000002', [1]],
    ])
  })
})

describe('the batch cap, the off states, and the descriptor', () => {
  it('caps a pass at MAX_BATCH_ENTRIES and takes the surplus on the next tick', async () => {
    await enable()
    const total = MAX_BATCH_ENTRIES + 200
    await seedSession('1785900000000', Array.from({ length: total }, () => line()))
    const { fetch, sent } = acceptingFetch()

    await shipOnce({ sessionDir, fetch })
    expect(sent[0]?.ns).toHaveLength(MAX_BATCH_ENTRIES)
    expect(sent[0]?.ns[MAX_BATCH_ENTRIES - 1]).toBe(MAX_BATCH_ENTRIES)
    expect((await readCursor(sessionDir)).cursor.actors['1785900000000']?.n).toBe(MAX_BATCH_ENTRIES)

    await shipOnce({ sessionDir, fetch })
    expect(sent[1]?.ns).toHaveLength(200)
    expect(sent[1]?.ns[0]).toBe(MAX_BATCH_ENTRIES + 1)
    expect(sent[1]?.ns[199]).toBe(total)
  })

  it('with no enable record it is off — nothing is read, nothing is sent, and it says exactly that', async () => {
    await writeIngestKey(sessionDir, FIXTURE_KEY)
    await seedSession('1785900000000', [line()])
    const { fetch, sent } = acceptingFetch()

    expect(await shipOnce({ sessionDir, fetch })).toEqual({ enabled: false })
    expect(sent).toEqual([])
  })

  it('enabled with no credential sends nothing and names the enable command as the remedy', async () => {
    await writeTeamConfig(sessionDir, {
      version: TEAM_CONFIG_VERSION,
      url: URL_BASE,
      project: 'acme-widgets',
      enabledAt: 1,
    })
    await seedSession('1785900000000', [line()])
    const { fetch, sent } = acceptingFetch()

    const result = await shipOnce({ sessionDir, fetch })
    expect(result.enabled && result.reason).toBe('no-credential')
    expect(result.enabled && result.detail).toContain('rhizomorph connect team')
    expect(sent).toEqual([])
  })

  it('holds no descriptor across a tick — the session file can be unlinked the moment a pass returns', async () => {
    await enable()
    await seedSession('1785900000000', [line()])
    const { fetch } = acceptingFetch()

    await shipOnce({ sessionDir, fetch })
    // On win32 an open descriptor makes this throw EBUSY; on POSIX it is free.
    // Either way it is the assertion that proves the read closed before the post.
    await expect(unlink(sessionFile('1785900000000'))).resolves.toBeUndefined()
  })
})
