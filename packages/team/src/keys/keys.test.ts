import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
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

/**
 * EVERY SEED-TIME REMEDY NAMES A COMMAND THAT ACTS ON A DEPLOYMENT THAT CAN REACH IT (#598).
 *
 * All three refusals above used to say *"re-run packages/team/deploy/init.sh"*. That script
 * returns early when `.env` exists, and reaching any of these refusals PROVES it exists: the boot
 * got here only by connecting on the `RZ_TEAM_DATABASE_URL` that file supplies, and the two values
 * the refusals complain about are read out of it. The operator ran it, it printed *"already
 * initialised"*, minted nothing, and the next boot failed identically — a wrong pointer to a real
 * command, which this repo has recorded as worse than no pointer because running it reports
 * success.
 *
 * **What this law is NOT.** It is not *"every remedy string names a command that does something on
 * the deployment that can reach it"*, which the issue asked to be decided and which is not
 * decidable by a test: that quantifies over `docker compose exec …`, `ALTER SYSTEM`, `chown` and
 * whatever the next remedy invents, against a deployment state this suite does not have. A law
 * that cannot decide its own predicate gets weakened until it passes. This is the decidable subset,
 * and it is exactly the defect class — the same choice #591 made in `deploy/init.test.ts`, where
 * the law is *"no shipped instruction deletes `.env`"* rather than *"every instruction is safe"*.
 *
 * **Two clauses.** The behavioural one drives every refusal `seedProjectIngestKey` can actually
 * return, and is what the mutation reddens. The static one sweeps every non-test `.ts` under
 * `packages/team/src/`, scoped by what a file **is** rather than by what it is called, so a remedy
 * in a file that does not exist yet is covered too. `bootstrap.ts`'s two remedies (`ALTER SYSTEM
 * SET synchronous_commit = 'on'`) pass it unchanged and are swept by it.
 *
 * **The cost, stated.** The sweep reads source TEXT, so the command has to be written whole in one
 * literal. A correct `'… ./init.sh '` + `'--rotate-ingest-key …'` split across a `+` would be
 * convicted. That is a false positive and never a hidden defect, and the BITES test below pins it.
 */

const TEAM_SRC_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/**
 * `init.sh` named as anything other than the one mode that acts on an `.env` that already exists.
 *
 * The lookahead is the whole law: `./init.sh --rotate-ingest-key` is the reachable-and-effective
 * command here, and a bare `init.sh` — in any spelling, `re-run packages/team/deploy/init.sh`
 * included — is the no-op.
 */
export function namesBareInitSh(text: string): boolean {
  return /init\.sh(?!\s+--rotate-ingest-key)/.test(text)
}

/**
 * `//` and block comments removed, so prose EXPLAINING the no-op is not convicted for mentioning
 * it — `seed.ts`'s own docblock has to be able to say what the old remedy was.
 *
 * A deliberate second copy of `storage/no-sql-outside-storage-law.test.ts`'s function rather than
 * an import: that module exports it, but importing a test module re-registers its suites inside
 * this file's run. The `[^:\\]` guard keeps a `postgres://…` inside a string literal from reading
 * as a comment.
 *
 * **IT HAS A HIDDEN-DEFECT DIRECTION, AND IT IS NOT GUARDED BY THE `export` CHECK BELOW** — found
 * in verification of #598, EXECUTED. It strips `/*…*\/` TEXTUALLY, so a string literal containing
 * `/*` opens a comment that swallows real code as far as the next `*\/`:
 *
 *     export const GLOB = 'match /*.sql here'
 *     export const INJECTED = 'Remedy: re-run packages/team/deploy/init.sh to fix this.'
 *     export const TAIL = 'end *\/ of it'
 *
 * planted in `bootstrap.ts` left the suite 46/46 green with a genuine bare-`init.sh` remedy in the
 * tree. The build report claimed the vacuity guard covered that; it did not, and this paragraph
 * replaces the claim. EXECUTED against that same injection: the `export` check passes (`GLOB`
 * survives, ahead of the swallow) and so does a `Remedy:`-survival check (`bootstrap.ts` keeps its
 * own two, ahead of it too). Both proposed hardenings SAMPLE the failure; neither closes it.
 *
 * {@link stripCommentLines} closes it instead — see there. Measured exposure across all 60 files
 * on the day this landed was ZERO (no string literal carries `/*`, no non-`://` `//` sits inside
 * one), so this is hardening rather than a live hole.
 */
export function stripTsComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => {
      const at = line.search(/(^|[^:\\])\/\//)
      if (at === -1) return line
      return line.slice(0, line.indexOf('//', at))
    })
    .join('\n')
}

/**
 * THE SECOND READER, WHOSE DECISIONS NEVER DEPEND ON WHAT IS INSIDE A LITERAL.
 *
 * A line is dropped when the line ITSELF is comment-shaped, so no string's contents can open
 * anything that runs past the end of that line — which is exactly the direction
 * {@link stripTsComments} is blind in. The sweep convicts when EITHER reader sees a bare
 * `init.sh`, so hiding a remedy now takes a construction both readers miss, and the swallow is
 * not one: the line it swallows is ordinary code and this reader keeps it.
 *
 * **IT HAS A SILENT DIRECTION OF ITS OWN, AND IT IS NOT SAFE ALONE** — found in the delta re-read
 * of this hardening, EXECUTED. This reader judges a line by its shape, and a line INSIDE a
 * multi-line template literal has no shape of its own:
 *
 *     export const HELP = `
 *       * Remedy: re-run packages/team/deploy/init.sh
 *     `
 *
 * trims to `* …`, so this reader drops a genuine bare-`init.sh` remedy as though it were a docblock
 * line. {@link stripTsComments} keeps it and convicts, which is the load reader A carries and the
 * reason {@link namesBareInitShInSource} is a union rather than a replacement. An earlier version
 * of this paragraph called B's blind spot "loud rather than silent", which was false as written and
 * would have told a later reader that keeping B alone is safe.
 *
 * Its two LOUD directions, both false positives and both accepted by this law's docblock: a
 * TRAILING `// …` comment naming a bare `init.sh` survives here, and so does a block comment
 * OPENED MID-LINE by real code (`export const A = 1 /* … init.sh`), because neither line is
 * comment-SHAPED. Either would convict a file carrying no such remedy. EXECUTED, all 60 files in
 * the package are clean under this reader today, because every `init.sh` mention in a comment sits
 * on a docblock line.
 */
export function stripCommentLines(source: string): string {
  return source
    .split('\n')
    .filter((line) => {
      const trimmed = line.trimStart()
      return !(trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*'))
    })
    .join('\n')
}

/**
 * THE SWEEP'S WHOLE PREDICATE, IN ONE PLACE SO A TEST CAN HOLD IT.
 *
 * Both readers, and a conviction from either. It exists as a function rather than inline in the
 * sweep because the union is the part a later edit could quietly undo: with a clean tree, dropping
 * back to EITHER reader passes the sweep, and nothing would say so. Two tests below assert this
 * predicate — one construction each reader is blind to — so **both** drop-backs redden. The first
 * version of this file pinned only one of the two, which is the sibling-case shape this law was
 * written to catch, committed inside the law.
 *
 * `A || B` is monotone, so the union can only ever ADD convictions: whatever stays hidden under it
 * was already hidden under A alone. Adding a reader cannot move the blind spot, only shrink it.
 */
export function namesBareInitShInSource(source: string): boolean {
  return namesBareInitSh(stripTsComments(source)) || namesBareInitSh(stripCommentLines(source))
}

/** Every non-test `.ts` under `packages/team/src/`, as package-relative paths with its text. */
function teamSources(): { file: string; text: string }[] {
  return readdirSync(TEAM_SRC_DIR, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .sort()
    .map((f) => ({ file: f, text: readFileSync(path.join(TEAM_SRC_DIR, f), 'utf8') }))
}

/**
 * The three remedies exactly as they shipped before #598, for the BITES test.
 *
 * **Hand-copied, and no law binds it to history — so read it as documentation, not as a guard.**
 * Checked against `git show origin/main:packages/team/src/keys/seed.ts` in verification and
 * faithful, but if a line here were wrong the BITES test would pass anyway: any bare `init.sh`
 * convicts, whatever the rest of the sentence says. It is decorative in the failure direction, and
 * nobody should later mistake it for the thing that pins what shipped.
 */
const SHIPPED_BEFORE_598 = [
  'Remedy: re-run packages/team/deploy/init.sh, or set RZ_TEAM_PROJECT and RZ_TEAM_INGEST_KEY_SHA256 from the .env it wrote.',
  'Remedy: re-run packages/team/deploy/init.sh, which mints a key, prints it once and writes only its digest.',
  'Remedy: re-run packages/team/deploy/init.sh to mint a key for this project.',
]

/**
 * OWED, AND DELIBERATELY NOT BUILT HERE: nothing asserts that these three strings and
 * `deploy/doctor.ts`'s three for the same states keep agreeing. They agree today, by hand and on
 * purpose. A keep-in-sync law would couple this file to `doctor.ts`, which belongs to another lane
 * while #592 is open, and a cross-fence coupling written from inside a fence is the thing this
 * repo's bundling rules exist to prevent. The property is real and unguarded and will drift; the
 * law is worth writing once that fence closes.
 */
describe('every seed-time remedy names a command that acts on the deployment that can reach it', () => {
  /** The three refusals, driven through the function rather than read out of the source. */
  async function refusals(): Promise<{ noProject: string; badHash: string; otherProject: string }> {
    const storage = new FakeTeamStorage()
    const held = minted('other-project')
    await seedProjectIngestKey(storage, { projectId: 'other-project', keyHash: held.row.keyHash, nowMs: NOW })

    const noProject = await seedProjectIngestKey(storage, { projectId: '  ', keyHash: held.row.keyHash, nowMs: NOW })
    const badHash = await seedProjectIngestKey(storage, { projectId: 'acme-widgets', keyHash: 'nope', nowMs: NOW })
    const otherProject = await seedProjectIngestKey(storage, {
      projectId: 'acme-widgets',
      keyHash: held.row.keyHash,
      nowMs: NOW,
    })

    for (const result of [noProject, badHash, otherProject]) expect(result.ok).toBe(false)
    return {
      noProject: noProject.ok ? '' : noProject.error,
      badHash: badHash.ok ? '' : badHash.error,
      otherProject: otherProject.ok ? '' : otherProject.error,
    }
  }

  it('all three name ./init.sh --rotate-ingest-key, and none names a bare init.sh', async () => {
    const { noProject, badHash, otherProject } = await refusals()

    for (const error of [noProject, badHash, otherProject]) {
      expect(error).toContain('Remedy: ')
      expect(error).toContain('./init.sh --rotate-ingest-key')
      // The rotation is only read by a boot that re-reads `.env`, which `restart` does not do.
      expect(error).toContain('docker compose up -d')
      expect(namesBareInitSh(error)).toBe(false)
    }
  })

  it('the empty-project remedy sets the variable BEFORE the rotation, because rotation refuses without it', async () => {
    const { noProject } = await refusals()

    // `init.sh`'s own refusal is "set RZ_TEAM_PROJECT in $ENV_FILE, then rotate" — the other order
    // would be a second no-op pointer inside the fix for the first.
    expect(noProject).toContain('set RZ_TEAM_PROJECT in packages/team/deploy/.env')
    expect(noProject.indexOf('set RZ_TEAM_PROJECT in packages/team/deploy/.env')).toBeLessThan(
      noProject.indexOf('./init.sh --rotate-ingest-key'),
    )
  })

  it('a refusal still writes nothing — the remedy is the only thing that changed', async () => {
    const storage = new FakeTeamStorage()

    const noProject = await seedProjectIngestKey(storage, { projectId: ' ', keyHash: minted().row.keyHash, nowMs: NOW })
    const badHash = await seedProjectIngestKey(storage, { projectId: 'acme-widgets', keyHash: 'nope', nowMs: NOW })

    expect(noProject.ok).toBe(false)
    expect(badHash.ok).toBe(false)
    expect(storage.ingestKeys.size).toBe(0)
  })

  it('THE LAW BITES — the three remedies as they actually shipped fail it', async () => {
    for (const shipped of SHIPPED_BEFORE_598) expect(namesBareInitSh(shipped)).toBe(true)

    const { noProject, badHash, otherProject } = await refusals()
    for (const error of [noProject, badHash, otherProject]) expect(namesBareInitSh(error)).toBe(false)

    // …and the detector is not simply "mentions init.sh" or "mentions the flag anywhere".
    expect(namesBareInitSh('cd packages/team/deploy && ./init.sh --rotate-ingest-key')).toBe(false)
    expect(namesBareInitSh('./init.sh --rotate')).toBe(true)
    expect(namesBareInitSh('re-run packages/team/deploy/init.sh to mint a key')).toBe(true)
    expect(namesBareInitSh('--rotate-ingest-key is what init.sh needs')).toBe(true)
    expect(namesBareInitSh('docker compose up -d')).toBe(false)
  })

  it('no runtime text under packages/team/src names init.sh without the rotation mode', () => {
    const sources = teamSources()

    // VACUITY, FIRST. A sweep that stopped finding its files, or a stripper that ate the strings it
    // sweeps, would otherwise pass loudest at the moment it checks nothing.
    expect(sources.map((s) => s.file)).toContain(path.join('keys', 'seed.ts'))
    expect(sources.map((s) => s.file)).toContain('bootstrap.ts')
    for (const { file, text } of sources) {
      expect(stripTsComments(text), `${file} stripped to nothing`).toContain('export')
    }
    const seed = stripTsComments(sources.find((s) => s.file === path.join('keys', 'seed.ts'))?.text ?? '')
    expect(seed).toContain('Remedy: ')
    expect(seed).toContain('./init.sh --rotate-ingest-key')

    const offending = sources.filter(({ text }) => namesBareInitShInSource(text)).map(({ file }) => file)
    expect(offending).toEqual([])
  })

  it('the stripper removes the prose and keeps the strings', () => {
    expect(stripTsComments('/** re-run deploy/init.sh */\nexport const a = 1')).not.toContain('init.sh')
    expect(stripTsComments('const a = 1 // re-run deploy/init.sh')).not.toContain('init.sh')
    // A URL inside a literal is not a comment, and a remedy on the same line survives with it.
    expect(stripTsComments("const dsn = 'postgres://host/db' // note")).toContain('postgres://host/db')
    expect(stripTsComments("const r = './init.sh --rotate-ingest-key'")).toContain('./init.sh --rotate-ingest-key')
  })

  it('THE SWALLOW — a /* inside a literal hides a remedy from one reader and not from the other', () => {
    // The verifier's injection, verbatim in shape: a literal opens a comment that runs to the next
    // `*/` two lines down, taking a real bare-init.sh remedy with it.
    const swallowed = [
      "export const GLOB = 'match /*.sql here'",
      "export const INJECTED = 'Remedy: re-run packages/team/deploy/init.sh to fix this.'",
      "export const TAIL = 'end */ of it'",
    ].join('\n')

    // Named rather than asserted away: this reader genuinely cannot see it…
    expect(namesBareInitSh(stripTsComments(swallowed))).toBe(false)
    // …and neither of the two guards proposed for it can, which is why neither was taken.
    expect(stripTsComments(swallowed)).toContain('export')
    // …while the line-shape reader keeps the line and convicts.
    expect(namesBareInitSh(stripCommentLines(swallowed))).toBe(true)
    // …and the predicate the sweep actually runs is the union, so THIS drop-back reddens here
    // rather than passing quietly against a clean tree.
    expect(namesBareInitShInSource(swallowed)).toBe(true)
    expect(namesBareInitShInSource('/** re-run deploy/init.sh */\nexport const a = 1')).toBe(false)
  })

  it('THE MIRROR — a remedy inside a template literal hides from the OTHER reader, and the union pins that too', () => {
    // The sibling of the test above, and it was missing from it: the first version pinned the
    // drop-back to reader A and left the drop-back to reader B green, which is the very shape this
    // law exists to name. A line inside a multi-line template has no shape of its own, so the
    // line-shape reader drops a real remedy as though it were a docblock line.
    const templated = 'export const HELP = `\n  * Remedy: re-run packages/team/deploy/init.sh\n`'

    expect(namesBareInitSh(stripCommentLines(templated))).toBe(false)
    expect(namesBareInitSh(stripTsComments(templated))).toBe(true)
    expect(namesBareInitShInSource(templated)).toBe(true)
  })

  it('the second reader drops comment-shaped lines and keeps code', () => {
    expect(stripCommentLines('/** re-run deploy/init.sh */\nexport const a = 1')).not.toContain('init.sh')
    expect(stripCommentLines(' * re-run deploy/init.sh\n */\nexport const a = 1')).not.toContain('init.sh')
    expect(stripCommentLines('// re-run deploy/init.sh\nexport const a = 1')).not.toContain('init.sh')
    expect(stripCommentLines("const r = './init.sh --rotate-ingest-key'")).toContain('./init.sh --rotate-ingest-key')
  })
})
