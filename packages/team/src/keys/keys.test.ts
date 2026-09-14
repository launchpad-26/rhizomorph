import { inspect } from 'node:util'
import { describe, expect, it } from 'vitest'
import { FakeTeamStorage } from '../storage/fake.js'
import { hashIngestKey, isIngestKeyHash } from './hash.js'
import { REDACTED_MINTED_KEY, mintIngestKey } from './mint.js'
import { seedProjectIngestKey } from './seed.js'
import { INGEST_KEY_PREFIX, INGEST_KEY_RANDOM_BYTES, MIN_INGEST_KEY_BODY, isWellFormedIngestKey } from './shape.js'
import {
  type IngestKeyVerdict,
  ingestKeyRefusal,
  resolveIngestKeyCheck,
  statusForIngestKeyRefusal,
  verdictFor,
} from './verify.js'

/**
 * THE MACHINE PLANE (prd-51 ruling 8), unit by unit.
 *
 * *"`rzk_` ingest keys: 32 random bytes, stored only as SHA-256, shown once at
 * mint, scoped to one project, revoked by a row flag checked once per batch."*
 *
 * The route-level claims — once per batch over a socket, revoke between two
 * batches — live in `../api/api.test.ts` and `../ingest/handle.test.ts`, because
 * they are claims about a request. What is here is the parts.
 */

const NOW = 1785739192632

function minted(projectId = 'acme-widgets') {
  return mintIngestKey({ projectId, nowMs: NOW })
}

describe('the shape, mirroring packages/server/src/shipper/key.ts', () => {
  it('accepts a value of exactly the shape this package mints', () => {
    const key = minted()
    expect(isWellFormedIngestKey(key.takePlaintext())).toBe(true)
  })

  it.each([
    ['no prefix at all — the form init.sh once shipped', 'a'.repeat(64)],
    ['the wrong prefix', `rz_${'a'.repeat(64)}`],
    ['a body shorter than the minimum', `${INGEST_KEY_PREFIX}${'a'.repeat(MIN_INGEST_KEY_BODY - 1)}`],
    ['embedded whitespace', `${INGEST_KEY_PREFIX}${'a'.repeat(32)} ${'b'.repeat(32)}`],
    ['surrounding whitespace', `  ${INGEST_KEY_PREFIX}${'a'.repeat(64)}  `],
    ['a shell variable that expanded to nothing', ''],
    ['the prefix alone', INGEST_KEY_PREFIX],
  ])('refuses %s', (_name, value) => {
    expect(isWellFormedIngestKey(value)).toBe(false)
  })

  it('the boundary is the boundary — one character either side of the minimum', () => {
    expect(isWellFormedIngestKey(`${INGEST_KEY_PREFIX}${'a'.repeat(MIN_INGEST_KEY_BODY)}`)).toBe(true)
    expect(isWellFormedIngestKey(`${INGEST_KEY_PREFIX}${'a'.repeat(MIN_INGEST_KEY_BODY - 1)}`)).toBe(false)
  })
})

describe('the digest', () => {
  it('is 64 lowercase hex, stable, and different for different keys', () => {
    const digest = hashIngestKey('rzk_abc')
    expect(digest).toMatch(/^[0-9a-f]{64}$/)
    expect(hashIngestKey('rzk_abc')).toBe(digest)
    expect(hashIngestKey('rzk_abd')).not.toBe(digest)
    expect(isIngestKeyHash(digest)).toBe(true)
  })

  /**
   * The digest of a known string, pinned. Not decoration: it is what makes
   * "agrees with `openssl dgst -sha256`" a checkable claim rather than a
   * property of whatever `node:crypto` happens to do — and
   * `../../deploy/init.test.ts` executes the other half against the real script.
   */
  it('is SHA-256 and not something else that also produces 64 hex characters', () => {
    expect(hashIngestKey('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  it('trims, so a key that arrived through a pipe hashes the same as one that did not', () => {
    expect(hashIngestKey('  rzk_abc\n')).toBe(hashIngestKey('rzk_abc'))
  })

  it.each([['too short', 'ab'], ['uppercase', 'A'.repeat(64)], ['not hex', 'z'.repeat(64)], ['empty', '']])(
    'isIngestKeyHash refuses %s',
    (_name, value) => {
      expect(isIngestKeyHash(value)).toBe(false)
    },
  )
})

describe('minting — 32 random bytes, and the plaintext shown exactly once', () => {
  it('mints the prefix plus 32 random bytes in hex, and stores only the digest', () => {
    const key = minted()
    expect(key.row.projectId).toBe('acme-widgets')
    expect(key.row.createdAtMs).toBe(NOW)
    expect(key.row.revokedAtMs).toBeNull()

    const plaintext = key.takePlaintext()
    expect(plaintext).toMatch(new RegExp(`^${INGEST_KEY_PREFIX}[0-9a-f]{${INGEST_KEY_RANDOM_BYTES * 2}}$`))
    expect(key.row.keyHash).toBe(hashIngestKey(plaintext))
    // The row has no field that could carry it, so serializing the whole row cannot leak it.
    expect(JSON.stringify(key.row)).not.toContain(plaintext)
    expect(Object.keys(key.row).sort()).toEqual(['createdAtMs', 'keyHash', 'projectId', 'revokedAtMs'])
  })

  it('asks for exactly 32 bytes, from the seam', () => {
    const asked: number[] = []
    mintIngestKey({
      projectId: 'p',
      nowMs: NOW,
      randomHex: (bytes) => {
        asked.push(bytes)
        return 'a'.repeat(bytes * 2)
      },
    })
    expect(asked).toEqual([INGEST_KEY_RANDOM_BYTES])
  })

  it('SHOWN ONCE: a second takePlaintext throws rather than handing the secret out again', () => {
    const key = minted()
    expect(key.takePlaintext()).toMatch(/^rzk_/)
    expect(() => key.takePlaintext()).toThrowError(/already been shown once/)
    expect(() => key.takePlaintext()).toThrowError(/already been shown once/)
  })

  it('every rendering of the minted object is the redaction, not the value', () => {
    const key = minted()
    const renderings = [String(key), JSON.stringify(key), inspect(key), `${key}`]
    // Taken AFTER the renderings, so the value exists to be compared against.
    const plaintext = key.takePlaintext()
    for (const rendering of renderings) {
      expect(rendering).toContain('redacted')
      expect(rendering).not.toContain(plaintext)
    }
    expect(String(key)).toBe(REDACTED_MINTED_KEY)
    // Never a truncation: a prefix of a secret is still a piece of one.
    expect(REDACTED_MINTED_KEY).not.toContain(plaintext.slice(INGEST_KEY_PREFIX.length, INGEST_KEY_PREFIX.length + 4))
  })

  it('two mints are two different keys', () => {
    expect(minted().row.keyHash).not.toBe(minted().row.keyHash)
  })
})

describe('the verdict, and the four refusals', () => {
  it('null is unknown, a revoked row is revoked, and a live row carries its project', () => {
    expect(verdictFor(null)).toEqual({ ok: false, reason: 'unknown' })
    expect(verdictFor({ keyHash: 'h', projectId: 'p', createdAtMs: NOW, revokedAtMs: NOW })).toEqual({
      ok: false,
      reason: 'revoked',
    })
    expect(verdictFor({ keyHash: 'h', projectId: 'p', createdAtMs: NOW, revokedAtMs: null })).toEqual({
      ok: true,
      projectId: 'p',
    })
  })

  it('401 is "not a key we know", 403 is "a key, but not for this"', () => {
    expect(statusForIngestKeyRefusal('malformed')).toBe(401)
    expect(statusForIngestKeyRefusal('unknown')).toBe(401)
    expect(statusForIngestKeyRefusal('revoked')).toBe(403)
    expect(statusForIngestKeyRefusal('wrong-project')).toBe(403)
  })

  it('every refusal names the prefix and its own reason, and no refusal names a key', () => {
    const key = minted()
    const plaintext = key.takePlaintext()
    for (const reason of ['malformed', 'unknown', 'revoked', 'wrong-project'] as const) {
      const text = ingestKeyRefusal(reason, 'acme-widgets')
      expect(text).toContain(INGEST_KEY_PREFIX)
      expect(text).not.toContain(plaintext)
      expect(text).not.toContain(key.row.keyHash)
    }
  })
})

describe('resolveIngestKeyCheck — ONE row read, or none at all', () => {
  async function storageWith(rows: { keyHash: string; projectId: string; revokedAtMs: number | null }[]) {
    const storage = new FakeTeamStorage()
    for (const row of rows) await storage.insertIngestKey({ ...row, createdAtMs: NOW })
    storage.keyLookups.length = 0
    return storage
  }

  it('reads the row exactly once for a well-formed key, and the thunk is pure over it', async () => {
    const key = minted()
    const plaintext = key.takePlaintext()
    const storage = await storageWith([{ keyHash: key.row.keyHash, projectId: 'acme-widgets', revokedAtMs: null }])

    const check = await resolveIngestKeyCheck(storage, plaintext)
    expect(storage.keyLookups).toEqual([hashIngestKey(plaintext)])

    // Calling the thunk cannot reach storage again — which is what stops "once
    // per batch" degrading into "once per event" by accident.
    const verdicts: IngestKeyVerdict[] = [check(), check(), check()]
    expect(verdicts).toEqual([
      { ok: true, projectId: 'acme-widgets' },
      { ok: true, projectId: 'acme-widgets' },
      { ok: true, projectId: 'acme-widgets' },
    ])
    expect(storage.keyLookups.length).toBe(1)
  })

  it('a key the server does not hold is unknown, after exactly one read', async () => {
    const storage = await storageWith([])
    const check = await resolveIngestKeyCheck(storage, minted().takePlaintext())
    expect(check()).toEqual({ ok: false, reason: 'unknown' })
    expect(storage.keyLookups.length).toBe(1)
  })

  it('a revoked row is revoked, and a key for another project still resolves ok — scope is not its job', async () => {
    const key = minted()
    const other = minted('other-project')
    const plaintext = key.takePlaintext()
    const otherPlaintext = other.takePlaintext()
    const storage = await storageWith([
      { keyHash: key.row.keyHash, projectId: 'acme-widgets', revokedAtMs: NOW },
      { keyHash: other.row.keyHash, projectId: 'other-project', revokedAtMs: null },
    ])

    expect((await resolveIngestKeyCheck(storage, plaintext))()).toEqual({ ok: false, reason: 'revoked' })
    expect((await resolveIngestKeyCheck(storage, otherPlaintext))()).toEqual({
      ok: true,
      projectId: 'other-project',
    })
  })

  it.each([
    ['a value that is not a key', 'not-a-real-key-at-all'],
    ['a bare hex string', 'a'.repeat(64)],
    ['a key with whitespace in it', `${INGEST_KEY_PREFIX}${'a'.repeat(32)} ${'b'.repeat(32)}`],
  ])('%s is malformed and buys NO database read', async (_name, presented) => {
    const storage = await storageWith([])
    const check = await resolveIngestKeyCheck(storage, presented)
    expect(check()).toEqual({ ok: false, reason: 'malformed' })
    expect(storage.keyLookups).toEqual([])
  })

  it.each([
    ['an absent header', undefined],
    ['an empty header', ''],
    ['a whitespace-only header', '   '],
  ])('%s refuses without reading, in the safe direction', async (_name, presented) => {
    const storage = await storageWith([])
    const check = await resolveIngestKeyCheck(storage, presented)
    expect(check().ok).toBe(false)
    expect(storage.keyLookups).toEqual([])
  })

  it('a surrounding-whitespace key is trimmed and then found — a header is not a promise of tidiness', async () => {
    const key = minted()
    const plaintext = key.takePlaintext()
    const storage = await storageWith([{ keyHash: key.row.keyHash, projectId: 'acme-widgets', revokedAtMs: null }])
    expect((await resolveIngestKeyCheck(storage, `  ${plaintext}  `))()).toEqual({
      ok: true,
      projectId: 'acme-widgets',
    })
  })
})

describe('seeding the deployment key — and why rotation is now revocation', () => {
  it('seeds an empty store, and a second identical seed changes nothing', async () => {
    const storage = new FakeTeamStorage()
    const key = minted()

    const first = await seedProjectIngestKey(storage, {
      projectId: 'acme-widgets',
      keyHash: key.row.keyHash,
      nowMs: NOW,
    })
    expect(first).toEqual({ ok: true, inserted: true, revoked: 0 })

    const second = await seedProjectIngestKey(storage, {
      projectId: 'acme-widgets',
      keyHash: key.row.keyHash,
      nowMs: NOW + 1000,
    })
    expect(second).toEqual({ ok: true, inserted: false, revoked: 0 })
    expect(storage.ingestKeys.get(key.row.keyHash)?.revokedAtMs).toBeNull()
    expect(storage.ingestKeys.get(key.row.keyHash)?.createdAtMs).toBe(NOW)
  })

  it('ROTATION: a new hash for the same project revokes the old key and spares the new one', async () => {
    const storage = new FakeTeamStorage()
    const old = minted()
    const fresh = minted()

    await seedProjectIngestKey(storage, { projectId: 'acme-widgets', keyHash: old.row.keyHash, nowMs: NOW })
    const rotated = await seedProjectIngestKey(storage, {
      projectId: 'acme-widgets',
      keyHash: fresh.row.keyHash,
      nowMs: NOW + 1000,
    })

    expect(rotated).toEqual({ ok: true, inserted: true, revoked: 1 })
    expect(storage.ingestKeys.get(old.row.keyHash)?.revokedAtMs).toBe(NOW + 1000)
    expect(storage.ingestKeys.get(fresh.row.keyHash)?.revokedAtMs).toBeNull()
  })

  it('THE SIBLING: another project keeps its key — revocation is scoped, like the key is', async () => {
    const storage = new FakeTeamStorage()
    const ours = minted()
    const theirs = minted('other-project')
    const fresh = minted()

    await seedProjectIngestKey(storage, { projectId: 'acme-widgets', keyHash: ours.row.keyHash, nowMs: NOW })
    await seedProjectIngestKey(storage, { projectId: 'other-project', keyHash: theirs.row.keyHash, nowMs: NOW })
    await seedProjectIngestKey(storage, {
      projectId: 'acme-widgets',
      keyHash: fresh.row.keyHash,
      nowMs: NOW + 1000,
    })

    expect(storage.ingestKeys.get(theirs.row.keyHash)?.revokedAtMs).toBeNull()
    expect(storage.ingestKeys.get(ours.row.keyHash)?.revokedAtMs).toBe(NOW + 1000)
  })

  it('a revoked key is NOT resurrected by restoring an old .env', async () => {
    const storage = new FakeTeamStorage()
    const old = minted()
    const fresh = minted()

    await seedProjectIngestKey(storage, { projectId: 'acme-widgets', keyHash: old.row.keyHash, nowMs: NOW })
    await seedProjectIngestKey(storage, { projectId: 'acme-widgets', keyHash: fresh.row.keyHash, nowMs: NOW + 1 })
    // …and now the operator puts the old .env back.
    const restored = await seedProjectIngestKey(storage, {
      projectId: 'acme-widgets',
      keyHash: old.row.keyHash,
      nowMs: NOW + 2,
    })

    expect(restored.ok).toBe(true)
    expect(storage.ingestKeys.get(old.row.keyHash)?.revokedAtMs).toBe(NOW + 1)
  })

  it('refuses an empty project and a hash that is not one, by name', async () => {
    const storage = new FakeTeamStorage()
    const key = minted()

    const noProject = await seedProjectIngestKey(storage, { projectId: '  ', keyHash: key.row.keyHash, nowMs: NOW })
    expect(noProject.ok).toBe(false)
    expect(noProject.ok ? '' : noProject.error).toContain('RZ_TEAM_PROJECT')

    const badHash = await seedProjectIngestKey(storage, { projectId: 'p', keyHash: 'nope', nowMs: NOW })
    expect(badHash.ok).toBe(false)
    expect(badHash.ok ? '' : badHash.error).toContain('RZ_TEAM_INGEST_KEY_SHA256')

    // Neither refusal wrote anything, which is what "refuses" has to mean.
    expect(storage.ingestKeys.size).toBe(0)
  })

  it('refuses to re-scope a digest another project already holds', async () => {
    const storage = new FakeTeamStorage()
    const key = minted('other-project')
    await seedProjectIngestKey(storage, { projectId: 'other-project', keyHash: key.row.keyHash, nowMs: NOW })

    const collision = await seedProjectIngestKey(storage, {
      projectId: 'acme-widgets',
      keyHash: key.row.keyHash,
      nowMs: NOW + 1,
    })
    expect(collision.ok).toBe(false)
    expect(collision.ok ? '' : collision.error).toContain('other-project')
    expect(storage.ingestKeys.get(key.row.keyHash)?.projectId).toBe('other-project')
  })
})
