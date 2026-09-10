import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { inspect } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ingestKeyPath } from './config.js'
import {
  INGEST_KEY_MODE,
  IngestKey,
  ingestKeyMode,
  ingestKeyPresent,
  readIngestKey,
  REDACTED_KEY,
  writeIngestKey,
} from './key.js'

const FIXTURE_KEY = 'rzk_TESTFIXTUREVALUE0123456789'
const POSIX = process.platform !== 'win32'

let sessionDir: string

beforeEach(async () => {
  sessionDir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-shipper-key-'))
})

afterEach(async () => {
  await rm(sessionDir, { recursive: true, force: true })
})

describe('ADR-0034 clause 2 — one credential, one shape, one place', () => {
  it('round-trips the value, and only through headerValue()', async () => {
    await writeIngestKey(sessionDir, FIXTURE_KEY)
    const key = await readIngestKey(sessionDir)
    expect(key).not.toBeNull()
    expect((key as IngestKey).headerValue()).toBe(FIXTURE_KEY)
    // The file is the value and one newline, and nothing else.
    expect(await readFile(ingestKeyPath(sessionDir), 'utf8')).toBe(`${FIXTURE_KEY}\n`)
  })

  it.skipIf(!POSIX)('stores it at exactly 0600 — the mode pinned beside its writer', async () => {
    await writeIngestKey(sessionDir, FIXTURE_KEY)
    expect((await stat(ingestKeyPath(sessionDir))).mode & 0o777).toBe(0o600)
    expect(INGEST_KEY_MODE).toBe(0o600)
    expect(await ingestKeyMode(sessionDir)).toBe(0o600)
  })

  it.skipIf(POSIX)('on win32 the bits are not meaningful, so presence is what is asserted', async () => {
    await writeIngestKey(sessionDir, FIXTURE_KEY)
    expect(await ingestKeyPresent(sessionDir)).toBe(true)
    expect(await ingestKeyMode(sessionDir)).toBeNull()
    expect(await readFile(ingestKeyPath(sessionDir), 'utf8')).toBe(`${FIXTURE_KEY}\n`)
  })

  it.skipIf(!POSIX)('repetition: a second and third write do not inherit a laxer mode from what was there', async () => {
    await writeIngestKey(sessionDir, FIXTURE_KEY)
    await writeIngestKey(sessionDir, `${FIXTURE_KEY}22`)
    await writeIngestKey(sessionDir, `${FIXTURE_KEY}333`)

    expect((await stat(ingestKeyPath(sessionDir))).mode & 0o777).toBe(0o600)
    expect(((await readIngestKey(sessionDir)) as IngestKey).headerValue()).toBe(`${FIXTURE_KEY}333`)
  })

  it('refuses a value that is not an ingest key, by name', async () => {
    await expect(writeIngestKey(sessionDir, 'sk-not-ours-0123456789abcdef')).rejects.toThrow(/rzk_/)
    await expect(writeIngestKey(sessionDir, 'rzk_short')).rejects.toThrow(/too short/)
    await expect(writeIngestKey(sessionDir, 'rzk_has space in it 0123456789')).rejects.toThrow(/whitespace/)
    expect(await ingestKeyPresent(sessionDir)).toBe(false)
  })

  it('renders as the redaction through every path a value normally escapes by', () => {
    const key = new IngestKey(FIXTURE_KEY)

    expect(String(key)).toBe(REDACTED_KEY)
    expect(`${key}`).toBe(REDACTED_KEY)
    expect(JSON.stringify({ key })).toBe(`{"key":"${REDACTED_KEY}"}`)
    expect(inspect(key)).toBe(REDACTED_KEY)
    expect(inspect({ nested: key })).toContain(REDACTED_KEY)

    for (const rendered of [String(key), `${key}`, JSON.stringify({ key }), inspect(key), inspect({ nested: key })]) {
      expect(rendered).not.toContain(FIXTURE_KEY)
    }
  })

  it('redacts the value out of text this process did not author, metacharacters and all', () => {
    const weird = new IngestKey('rzk_a.b*c+d(0123456789abcdef')
    expect(weird.redact('server said: rzk_a.b*c+d(0123456789abcdef is revoked')).toBe(
      `server said: ${REDACTED_KEY} is revoked`,
    )
    // Every occurrence, not the first.
    const key = new IngestKey(FIXTURE_KEY)
    expect(key.redact(`${FIXTURE_KEY} and again ${FIXTURE_KEY}`)).toBe(`${REDACTED_KEY} and again ${REDACTED_KEY}`)
    expect(key.redact('nothing to do here')).toBe('nothing to do here')
  })

  it('reads an absent file as null rather than throwing — "no credential" is a state with a remedy', async () => {
    expect(await readIngestKey(sessionDir)).toBeNull()
    expect(await ingestKeyPresent(sessionDir)).toBe(false)
    expect(await ingestKeyMode(sessionDir)).toBeNull()
  })

  it('a present-but-unusable file throws and names the path — it must not read as absent', async () => {
    await writeIngestKey(sessionDir, FIXTURE_KEY)
    await writeFile(ingestKeyPath(sessionDir), 'not-a-key\n')
    await expect(readIngestKey(sessionDir)).rejects.toThrow(ingestKeyPath(sessionDir))
  })
})
