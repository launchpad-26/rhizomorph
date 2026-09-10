import { readdirSync, readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createEvent, eventToLine } from '@rhizomorph/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TEAM_CONFIG_VERSION, writeTeamConfig } from './config.js'
import { writeIngestKey } from './key.js'
import type { FetchLike } from './post.js'
import { shipOnce } from './ship.js'

/**
 * THE `ts` INVARIANT (prd-51's 2026-09-08 amendment).
 *
 * The shipper sends the `ts` it read and never computes one. Dedup on the team
 * server is per-partition and the partition is derived from `ts`, so a
 * recomputed timestamp would silently duplicate every row at a month boundary
 * — no error, no refusal, no 4xx, just two of everything on the far side.
 *
 * Two halves, because either alone is a half-guard: a behavioural assertion
 * that the shipped `ts` is byte-equal to the source line's, and a source-text
 * sweep proving this directory has no site where a clock could get in.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_KEY = 'rzk_TSFIXTUREVALUE00123456789'

let sessionDir: string

/** The `"ts":<digits>` substring of a JSON line, exactly as its bytes read. */
function tsSubstring(line: string): string {
  const match = /"ts":\s*[-0-9.eE+]+/.exec(line)
  if (match === null) throw new Error(`no ts in: ${line}`)
  return match[0]
}

function capturingFetch(): { fetch: FetchLike; lines: string[] } {
  const lines: string[] = []
  const fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { batch: { line: string }[] }
    for (const entry of body.batch) lines.push(entry.line)
    return new Response(JSON.stringify({ accepted: body.batch.length, journalSeq: 1 }), { status: 202 })
  }) as FetchLike
  return { fetch, lines }
}

async function shipLines(sourceLines: readonly string[]): Promise<string[]> {
  await writeIngestKey(sessionDir, FIXTURE_KEY)
  await writeTeamConfig(sessionDir, {
    version: TEAM_CONFIG_VERSION,
    url: 'https://team.example',
    project: 'acme-widgets',
    enabledAt: 1,
  })
  await writeFile(path.join(sessionDir, 'session-1785900000000.jsonl'), `${sourceLines.join('\n')}\n`)
  const { fetch, lines } = capturingFetch()
  await shipOnce({ sessionDir, fetch })
  return lines
}

beforeEach(async () => {
  sessionDir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-shipper-ts-'))
})

afterEach(async () => {
  await rm(sessionDir, { recursive: true, force: true })
})

describe("the shipped ts is the line's own ts, byte for byte", () => {
  it('carries the source ts through unchanged', async () => {
    const source = eventToLine(
      createEvent('pane.activity', { paneId: '%1', contentHash: 'h1', previousHash: null }, { id: 'e1', ts: 1785900000000 }),
    )
    const [shipped] = await shipLines([source])

    expect(shipped).toBeDefined()
    expect(tsSubstring(shipped as string)).toBe(tsSubstring(source))
    expect(JSON.parse(shipped as string).ts).toBe(1785900000000)
  })

  it('carries it across a month boundary and just inside one — the two cases a recomputed ts would partition differently', async () => {
    // 2026-08-31T23:59:59.999Z and 2026-09-01T00:00:00.000Z.
    const lastOfAugust = Date.UTC(2026, 7, 31, 23, 59, 59, 999)
    const firstOfSeptember = Date.UTC(2026, 8, 1, 0, 0, 0, 0)
    const sources = [
      eventToLine(
        createEvent('pane.activity', { paneId: '%1', contentHash: 'h1', previousHash: null }, { id: 'e1', ts: lastOfAugust }),
      ),
      eventToLine(
        createEvent('pane.activity', { paneId: '%2', contentHash: 'h2', previousHash: null }, { id: 'e2', ts: firstOfSeptember }),
      ),
    ]

    const shipped = await shipLines(sources)

    expect(shipped).toHaveLength(2)
    expect(shipped.map(tsSubstring)).toEqual(sources.map(tsSubstring))
    expect(JSON.parse(shipped[0] as string).ts).toBe(lastOfAugust)
    expect(JSON.parse(shipped[1] as string).ts).toBe(firstOfSeptember)
  })
})

describe('there is no site in this directory where a clock could get in', () => {
  const nonTestSources = readdirSync(HERE)
    .filter((entry) => entry.endsWith('.ts') && !entry.endsWith('.test.ts'))
    .sort()

  it('sweeps a real, non-empty set of sources — a sweep over nothing reports the same green as a sweep over something', () => {
    expect(nonTestSources.length).toBeGreaterThan(5)
    expect(nonTestSources).toContain('ship.ts')
    expect(nonTestSources).toContain('post.ts')
  })

  it('finds Date.now( only in cursor.ts, where lastAckAt lives and nothing crosses the wire', () => {
    const holders = nonTestSources.filter((entry) =>
      stripComments(readFileSync(path.join(HERE, entry), 'utf8')).includes('Date.now('),
    )
    expect(holders).toEqual(['cursor.ts'])
  })

  it('finds no new Date( at all — the shipper has no reason to construct one', () => {
    const holders = nonTestSources.filter((entry) =>
      /\bnew\s+Date\s*\(/.test(stripComments(readFileSync(path.join(HERE, entry), 'utf8'))),
    )
    expect(holders).toEqual([])
  })

  it('bites: the sweep it runs finds a planted clock in the same shape', () => {
    expect(stripComments('const t = Date.now()').includes('Date.now(')).toBe(true)
    expect(/\bnew\s+Date\s*\(/.test(stripComments('const d = new Date(ts)'))).toBe(true)
    // And a doc comment naming either is not a site.
    expect(stripComments('/** never Date.now() here */\nconst x = 1').includes('Date.now(')).toBe(false)
    expect(/\bnew\s+Date\s*\(/.test(stripComments('// no new Date( allowed\nconst x = 1'))).toBe(false)
  })
})

/** Comments removed — this file's siblings name both forbidden constructs in their own doc comments, on purpose. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}
