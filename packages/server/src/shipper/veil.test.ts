import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createEvent, eventToLine, parseEvent } from '@rhizomorph/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TEAM_CONFIG_VERSION, writeTeamConfig } from './config.js'
import { writeIngestKey } from './key.js'
import type { FetchLike } from './post.js'
import { shipOnce } from './ship.js'

/**
 * ADR-0034 CLAUSE 4 — "it sends only what a record carries" (ADR-0033).
 *
 * The law file declared this clause DEFERRED to prd-51 wave 2 because "the
 * re-serializer this would test does not exist yet". It exists now
 * (`packages/core/src/wire/reserialize.ts`, merged with the keystone), so the
 * clause is assertable and this file asserts it end to end rather than at the
 * re-serializer's own boundary — the question is not whether `reserializeLine`
 * drops a removed field, which its own tests cover, but whether the SHIPPER
 * routes every line through it.
 *
 * The planted field is the real one: `pane.activity.payload.preview` carried
 * actual terminal text, was dropped from the schema by #292, and the first
 * shipper spike put it on 30,627 wire events by shipping the ledger's raw
 * bytes (`docs/research/2026-08-28-shared-record-s2-shipper.md`, §veil).
 */

const FIXTURE_KEY = 'rzk_VEILFIXTUREVALUE0123456789'
const SECRET_PREVIEW = 'THE-OPERATORS-ACTUAL-TERMINAL-TEXT'

let sessionDir: string

function capturingFetch(): { fetch: FetchLike; bodies: string[] } {
  const bodies: string[] = []
  const fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const raw = String(init?.body)
    bodies.push(raw)
    const parsed = JSON.parse(raw) as { batch: unknown[] }
    return new Response(JSON.stringify({ accepted: parsed.batch.length, journalSeq: 1 }), { status: 202 })
  }) as FetchLike
  return { fetch, bodies }
}

beforeEach(async () => {
  sessionDir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-shipper-veil-'))
  await writeIngestKey(sessionDir, FIXTURE_KEY)
  await writeTeamConfig(sessionDir, {
    version: TEAM_CONFIG_VERSION,
    url: 'https://team.example',
    project: 'acme-widgets',
    enabledAt: 1,
  })
})

afterEach(async () => {
  await rm(sessionDir, { recursive: true, force: true })
})

describe('a field the schema no longer declares cannot cross the wire', () => {
  it('plants pane.activity.payload.preview in the ledger and watches it fail to cross', async () => {
    const declared = createEvent(
      'pane.activity',
      { paneId: '%1', contentHash: 'h1', previousHash: null },
      { id: 'e1', ts: 1785900000000 },
    )
    // The ledger's own bytes, carrying a field this era does not declare.
    const onDisk = JSON.stringify({
      ...declared,
      payload: { ...declared.payload, preview: SECRET_PREVIEW },
    })
    expect(onDisk).toContain(SECRET_PREVIEW)

    await writeFile(path.join(sessionDir, 'session-1785900000000.jsonl'), `${onDisk}\n`)
    const { fetch, bodies } = capturingFetch()

    await shipOnce({ sessionDir, fetch })

    expect(bodies).toHaveLength(1)
    const body = bodies[0] as string
    expect(body).not.toContain(SECRET_PREVIEW)
    expect(body).not.toContain('preview')

    // And what DID cross is exactly the line `buildRecord` would serialize.
    const reparsed = parseEvent(JSON.parse(onDisk))
    expect(reparsed.ok).toBe(true)
    const expected = eventToLine((reparsed as { ok: true; event: Parameters<typeof eventToLine>[0] }).event)
    const shipped = (JSON.parse(body) as { batch: { line: string }[] }).batch[0]?.line
    expect(shipped).toBe(expected)
    expect(shipped).not.toBe(onDisk)
  })

  it('bites: the ledger line this test plants really does carry the field, so a passthrough shipper would fail it', () => {
    const declared = createEvent(
      'pane.activity',
      { paneId: '%1', contentHash: 'h1', previousHash: null },
      { id: 'e1', ts: 1785900000000 },
    )
    const onDisk = JSON.stringify({ ...declared, payload: { ...declared.payload, preview: SECRET_PREVIEW } })
    // A shipper that posted the raw bytes would put this string on the wire.
    expect(onDisk).toContain('"preview"')
    expect(onDisk).toContain(SECRET_PREVIEW)
  })
})
