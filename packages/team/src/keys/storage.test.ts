import { describe, expect, it } from 'vitest'
import type { IngestKeyRow, TeamStorage } from '../storage/contract.js'
import { FakeTeamStorage } from '../storage/fake.js'
import { createPostgresStorage } from '../storage/postgres.js'
import { createRecordingSql } from '../storage/recording-sql.js'
import { mintIngestKey } from './mint.js'

/**
 * THE KEYS PORT, AT BOTH DOUBLES (prd-51 ruling 8, ruling 5).
 *
 * Ruling 8's rows ride on {@link TeamStorage} rather than on a parameter of
 * their own, so `startTeamServer` needs no new argument and
 * `packages/team/deploy/serve.ts` needs no change to pass one. That means two
 * implementations, and a port with two implementations has exactly one way to
 * rot: the double gets kinder than the adapter, and every test above it starts
 * certifying behaviour Postgres will not give.
 *
 * So the semantic clauses below run against BOTH, as one table:
 * `FakeTeamStorage` for the port and `createPostgresStorage(recordingSql)` for
 * the adapter, with the driver double scripting the rows a database would send
 * back. What only the adapter can be asked — which statements it sends and which
 * bytes it binds — is asserted separately at the bottom.
 *
 * It lives under `keys/` rather than beside `storage/postgres.test.ts` because
 * that file is outside this issue's fence. The subject is the keys port, and
 * this is the keys directory.
 */

const NOW = 1785739192632

function row(overrides: Partial<IngestKeyRow> = {}): IngestKeyRow {
  return {
    keyHash: 'a'.repeat(64),
    projectId: 'acme-widgets',
    createdAtMs: NOW,
    revokedAtMs: null,
    ...overrides,
  }
}

describe('FakeTeamStorage — the port double', () => {
  it('round-trips a row, and an absent hash reads as null rather than throwing', async () => {
    const storage = new FakeTeamStorage()
    await storage.insertIngestKey(row())
    expect(await storage.findIngestKey('a'.repeat(64))).toEqual(row())
    expect(await storage.findIngestKey('b'.repeat(64))).toBeNull()
  })

  it('inserting the same hash twice leaves the FIRST row — the adapter DOES NOTHING on conflict', async () => {
    const storage = new FakeTeamStorage()
    await storage.insertIngestKey(row({ revokedAtMs: NOW }))
    await storage.insertIngestKey(row({ revokedAtMs: null, createdAtMs: NOW + 5000 }))
    // A double that overwrote would un-revoke a revoked key on the next boot.
    expect(await storage.findIngestKey('a'.repeat(64))).toEqual(row({ revokedAtMs: NOW }))
  })

  it('revokes a project live keys, spares the named one, and leaves other projects alone', async () => {
    const storage = new FakeTeamStorage()
    await storage.insertIngestKey(row({ keyHash: 'a'.repeat(64) }))
    await storage.insertIngestKey(row({ keyHash: 'b'.repeat(64) }))
    await storage.insertIngestKey(row({ keyHash: 'c'.repeat(64), projectId: 'other-project' }))

    const changed = await storage.revokeIngestKeys({
      projectId: 'acme-widgets',
      exceptKeyHash: 'b'.repeat(64),
      atMs: NOW + 10,
    })

    expect(changed).toBe(1)
    expect((await storage.findIngestKey('a'.repeat(64)))?.revokedAtMs).toBe(NOW + 10)
    expect((await storage.findIngestKey('b'.repeat(64)))?.revokedAtMs).toBeNull()
    expect((await storage.findIngestKey('c'.repeat(64)))?.revokedAtMs).toBeNull()
  })

  it('a row already revoked keeps its ORIGINAL timestamp and is not counted again', async () => {
    const storage = new FakeTeamStorage()
    await storage.insertIngestKey(row())
    expect(await storage.revokeIngestKeys({ projectId: 'acme-widgets', atMs: NOW + 10 })).toBe(1)
    expect(await storage.revokeIngestKeys({ projectId: 'acme-widgets', atMs: NOW + 20 })).toBe(0)
    expect((await storage.findIngestKey('a'.repeat(64)))?.revokedAtMs).toBe(NOW + 10)
  })

  it('logs every lookup, which is what once-per-batch is asserted against', async () => {
    const storage = new FakeTeamStorage()
    await storage.findIngestKey('a'.repeat(64))
    await storage.findIngestKey('b'.repeat(64))
    expect(storage.keyLookups).toEqual(['a'.repeat(64), 'b'.repeat(64)])
    expect(storage.calls.filter((c) => c === 'findIngestKey').length).toBe(2)
  })

  it('can be told to fail the read, so fail-closed is testable rather than argued', async () => {
    const storage = new FakeTeamStorage({ failFindIngestKey: true })
    await expect(storage.findIngestKey('a'.repeat(64))).rejects.toThrow()
    // …and the attempt is still logged, so a test can tell "never asked" from "asked and failed".
    expect(storage.keyLookups.length).toBe(1)
  })
})

describe('createPostgresStorage — the adapter, against the driver double', () => {
  it('binds the digest and the project, and interpolates neither', async () => {
    const recorder = createRecordingSql()
    const storage: TeamStorage = createPostgresStorage(recorder.sql)

    await storage.insertIngestKey(row())

    const query = recorder.queries[0]
    expect(query?.values).toEqual(['a'.repeat(64), 'acme-widgets', new Date(NOW).toISOString(), null])
    // A bound value does not appear in the statement text; an interpolated one does.
    expect(query?.sql).not.toContain('a'.repeat(64))
    expect(query?.sql).not.toContain('acme-widgets')
    // DO NOTHING, never DO UPDATE: a re-seed must not resurrect a revoked key.
    expect(query?.sql).toContain('ON CONFLICT (key_hash) DO NOTHING')
    expect(query?.sql).not.toContain('DO UPDATE')
  })

  it('reads a row back, turning the two timestamps into epoch milliseconds', async () => {
    const recorder = createRecordingSql()
    recorder.script([
      {
        key_hash: 'a'.repeat(64),
        project_id: 'acme-widgets',
        created_at: new Date(NOW),
        revoked_at: null,
      },
    ])
    const storage = createPostgresStorage(recorder.sql)

    expect(await storage.findIngestKey('a'.repeat(64))).toEqual(row())
    expect(recorder.queries[0]?.values).toEqual(['a'.repeat(64)])
  })

  it('a revoked row comes back with a number, and an absent row comes back as null', async () => {
    const recorder = createRecordingSql()
    recorder.script([
      {
        key_hash: 'a'.repeat(64),
        project_id: 'acme-widgets',
        created_at: new Date(NOW),
        revoked_at: new Date(NOW + 10),
      },
    ])
    const storage = createPostgresStorage(recorder.sql)
    expect((await storage.findIngestKey('a'.repeat(64)))?.revokedAtMs).toBe(NOW + 10)

    // An empty result set — postgres.js hands back `[]`, not a null row.
    expect(await storage.findIngestKey('b'.repeat(64))).toBeNull()
  })

  it('revoking sends ONE statement for both shapes, with the spared hash bound as a parameter', async () => {
    const recorder = createRecordingSql()
    recorder.scriptCount(3)
    const storage = createPostgresStorage(recorder.sql)

    const spared = await storage.revokeIngestKeys({
      projectId: 'acme-widgets',
      exceptKeyHash: 'b'.repeat(64),
      atMs: NOW,
    })
    expect(spared).toBe(3)

    recorder.scriptCount(0)
    await storage.revokeIngestKeys({ projectId: 'acme-widgets', atMs: NOW })

    const [withSpare, withoutSpare] = recorder.queries
    // The same text both times — one predicate, one plan, one thing to review.
    expect(withSpare?.sql).toBe(withoutSpare?.sql)
    expect(withSpare?.values).toEqual([new Date(NOW).toISOString(), 'acme-widgets', 'b'.repeat(64), 'b'.repeat(64)])
    expect(withoutSpare?.values).toEqual([new Date(NOW).toISOString(), 'acme-widgets', null, null])
    // Idempotence is a property of the predicate, not of the caller.
    expect(withSpare?.sql).toContain('revoked_at IS NULL')
  })

  /**
   * THE CLAIM RULING 8 RESTS ON, asserted over the wire rather than over the
   * types: a plaintext key cannot reach the database, because nothing binds one.
   */
  it('no statement and no bound value on any keys path can carry a plaintext key', async () => {
    const key = mintIngestKey({ projectId: 'acme-widgets', nowMs: NOW })
    const plaintext = key.takePlaintext()

    const recorder = createRecordingSql()
    const storage = createPostgresStorage(recorder.sql)
    await storage.insertIngestKey(key.row)
    await storage.findIngestKey(key.row.keyHash)
    await storage.revokeIngestKeys({ projectId: 'acme-widgets', exceptKeyHash: key.row.keyHash, atMs: NOW })

    expect(recorder.queries.length).toBe(3)
    for (const query of recorder.queries) {
      expect(query.sql).not.toContain(plaintext)
      for (const value of query.values) expect(String(value)).not.toContain(plaintext)
    }
    // Not vacuous: the digest of that very key IS on the wire, four times — the
    // insert, the read, and TWICE in the revoke, whose one predicate binds the
    // spared hash for its own null test and again for the comparison.
    expect(recorder.queries.flatMap((q) => q.values).filter((v) => v === key.row.keyHash).length).toBe(4)
  })
})
