import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { inspect } from 'node:util'
import { createEvent, eventToLine } from '@rhizomorph/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ingestKeyPath, TEAM_CONFIG_VERSION, writeTeamConfig } from './config.js'
import { IngestKey, REDACTED_KEY, writeIngestKey } from './key.js'
import { runShipperLoop } from './loop.js'
import type { FetchLike } from './post.js'

/**
 * THE DoD'S "A KEY VALUE CANNOT REACH A LOG LINE", AS BEHAVIOUR RATHER THAN AS
 * A GREP.
 *
 * `hand-law.test.ts`'s clause 2 already sweeps this directory's source text for
 * a log call with a key-ish argument. That catches the mistake an author makes
 * on purpose. This file catches the one nobody wrote: a team server that echoes
 * the ingest key back in its own error body, and a `fetch` that rejects with
 * the key in its message. Neither is this process's doing, and laundering
 * either into a log line, a thrown error or a file would be.
 *
 * The run is REPEATED — three full passes across four server behaviours — and
 * the assertion is the strong form: across everything captured, the key
 * appears in **exactly one** place on the whole machine, `shipper/ingest.key`,
 * which is the file whose entire purpose is to hold it.
 */

const FIXTURE_KEY = 'rzk_LAWFIXTUREVALUE0123456789'
const PASSES = 3

let dataRoot: string
let sessionDir: string

interface Capture {
  logged: string[]
  streamed: string[]
  thrown: string[]
}

/** Every behaviour a team server can answer with, including the two that try to make this hand leak. */
const SERVER_BEHAVIOURS: Array<{ what: string; fetch: FetchLike }> = [
  {
    what: '202 with the acknowledgement',
    fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { batch: unknown[] }
      return new Response(JSON.stringify({ accepted: body.batch.length, journalSeq: 1 }), { status: 202 })
    }) as FetchLike,
  },
  {
    what: '401 refused',
    fetch: (async () => new Response('unauthorized', { status: 401 })) as FetchLike,
  },
  {
    what: '500 echoing the key straight back in its own body',
    fetch: (async () =>
      new Response(`internal error while validating ${FIXTURE_KEY} against project acme-widgets`, {
        status: 500,
      })) as FetchLike,
  },
  {
    what: 'a fetch that rejects with the key in its message',
    fetch: (async () => {
      throw new Error(`socket hang up while sending x-rz-ingest-key: ${FIXTURE_KEY}`)
    }) as FetchLike,
  },
]

async function everyFileUnder(root: string): Promise<Array<{ file: string; body: string }>> {
  const out: Array<{ file: string; body: string }> = []
  const visit = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir)) {
      const full = path.join(dir, entry)
      if ((await stat(full)).isDirectory()) await visit(full)
      else out.push({ file: full, body: await readFile(full, 'utf8') })
    }
  }
  await visit(root)
  return out
}

async function runAgainst(fetch: FetchLike): Promise<Capture> {
  const capture: Capture = { logged: [], streamed: [], thrown: [] }
  const record = (chunk: unknown): boolean => {
    capture.streamed.push(String(chunk))
    return true
  }
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(record as never)
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(record as never)

  try {
    for (let pass = 0; pass < PASSES; pass += 1) {
      try {
        await runShipperLoop({
          sessionDir,
          once: true,
          fetch,
          log: {
            pass: (result) => capture.logged.push(JSON.stringify(result), inspect(result)),
            error: (message) => capture.logged.push(message),
          },
        })
      } catch (err) {
        capture.thrown.push(String((err as Error)?.message), String((err as Error)?.stack))
      }
    }
  } finally {
    stdout.mockRestore()
    stderr.mockRestore()
  }

  return capture
}

beforeEach(async () => {
  dataRoot = await mkdtemp(path.join(tmpdir(), 'rhizomorph-shipper-law-'))
  sessionDir = path.join(dataRoot, 'a-repo-00000000')
  await writeFile(path.join(dataRoot, '.keep'), '')
  await mkdir(sessionDir, { recursive: true })

  await writeIngestKey(sessionDir, FIXTURE_KEY)
  await writeTeamConfig(sessionDir, {
    version: TEAM_CONFIG_VERSION,
    url: 'https://team.example',
    project: 'acme-widgets',
    enabledAt: 1,
  })
  await writeFile(
    path.join(sessionDir, 'session-1785900000000.jsonl'),
    [
      eventToLine(createEvent('pane.activity', { paneId: '%1', contentHash: 'h1', previousHash: null }, { id: 'e1', ts: 1785900000000 })),
      '{not json',
      eventToLine(createEvent('pane.activity', { paneId: '%2', contentHash: 'h2', previousHash: null }, { id: 'e2', ts: 1785900000001 })),
      '',
    ].join('\n'),
  )
})

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true })
})

describe('a key value cannot reach a log line, an error, or any file but its own', () => {
  it.each(SERVER_BEHAVIOURS)('holds across three passes against $what', async ({ fetch }) => {
    const capture = await runAgainst(fetch)

    for (const [where, texts] of Object.entries(capture)) {
      for (const text of texts as string[]) {
        expect(text, `the key reached ${where}: ${text}`).not.toContain(FIXTURE_KEY)
      }
    }

    const files = await everyFileUnder(dataRoot)
    const holders = files.filter((entry) => entry.body.includes(FIXTURE_KEY)).map((entry) => entry.file)
    expect(holders).toEqual([ingestKeyPath(sessionDir)])
    // And that one file is nothing but the value and a newline.
    expect(await readFile(ingestKeyPath(sessionDir), 'utf8')).toBe(`${FIXTURE_KEY}\n`)
  })

  it('the two hostile behaviours really do put the key in front of the hand — otherwise the case above proves nothing', async () => {
    const echoed = await (SERVER_BEHAVIOURS[2] as { fetch: FetchLike }).fetch('https://team.example', {})
    expect(await echoed.text()).toContain(FIXTURE_KEY)

    await expect((SERVER_BEHAVIOURS[3] as { fetch: FetchLike }).fetch('https://team.example', {})).rejects.toThrow(
      FIXTURE_KEY,
    )
  })

  it('and the redaction is what stands in for it — not silence, which would hide the failure', async () => {
    const capture = await runAgainst((SERVER_BEHAVIOURS[2] as { fetch: FetchLike }).fetch)
    expect(capture.logged.join('\n')).toContain(REDACTED_KEY)
  })

  it('every rendering of the key object is the redaction, so a template or a stringify cannot spill it', () => {
    const key = new IngestKey(FIXTURE_KEY)
    expect(String(key)).toBe(REDACTED_KEY)
    expect(JSON.stringify({ key })).toBe(`{"key":"${REDACTED_KEY}"}`)
    expect(inspect(key)).toBe(REDACTED_KEY)
  })
})
