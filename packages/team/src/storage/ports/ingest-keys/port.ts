/** THE INGEST KEYS PORT — ruling 8's machine plane, at rest. */

/**
 * One row of ruling 8's `ingest_keys` table — the machine plane, at rest.
 *
 * Ruling 8: *"`rzk_` ingest keys: 32 random bytes, stored only as SHA-256, shown
 * once at mint, scoped to one project, revoked by a row flag checked **once per
 * batch**"*. Every clause of that sentence is a field here except the first,
 * which is `keys/mint.ts`'s, and the one that is deliberately ABSENT.
 *
 * **THERE IS NO PLAINTEXT FIELD, AND THERE MUST NEVER BE ONE.** A field that
 * does not exist cannot reach a column, a log line or a refusal string, and the
 * mint function hands the plaintext out exactly once and forgets it.
 * `migrations/schema-law.test.ts` case 31 holds the same claim from the schema's
 * side, where the mutation that plants a second column goes red.
 */
export interface IngestKeyRow {
  /** sha-256 hex of the key's plaintext, lowercase. The primary key. Never the key. */
  readonly keyHash: string
  /** The one project this key may ship for. A key valid for A is refused for B. */
  readonly projectId: string
  /** Epoch milliseconds. The adapter converts, as it does for `EventRow.tsMs`. */
  readonly createdAtMs: number
  /** When it was revoked, or `null` while it is live. Ruling 8's row flag. */
  readonly revokedAtMs: number | null
}

export interface IngestKeysPort {
  /**
   * Stores one minted key's HASH (ruling 8). Idempotent on `keyHash`: seeding
   * the same key twice inserts nothing and leaves the stored row — and its
   * `revokedAtMs` — exactly as it was.
   *
   * The argument is an {@link IngestKeyRow}, which has no plaintext field, so
   * there is no shape of this call that could store one.
   */
  insertIngestKey(row: IngestKeyRow): Promise<void>

  /**
   * THE ONCE-PER-BATCH READ (ruling 8). The row for one key hash, or `null`.
   *
   * *"revoked by a row flag checked **once per batch** — which bounds revocation
   * lag to one batch interval"*. That bound is a property of the CALLER, and it
   * is the claim, so it is the test: `api/main.ts` calls this exactly once per
   * ingest request, before the pure handler runs, and never memoises the result
   * between requests. Once per event would be waste; cached across batches would
   * unbound the lag.
   */
  findIngestKey(keyHash: string): Promise<IngestKeyRow | null>

  /**
   * Revokes every live key for one project, optionally sparing one. Returns how
   * many rows changed.
   *
   * `exceptKeyHash` is what makes the deployment's key rotation an actual
   * revocation rather than housekeeping: `deploy/init.sh` mints a new key and
   * the boot that follows seeds it and revokes everything else the project held.
   *
   * Idempotent, and deliberately so in one specific way: a row that is already
   * revoked keeps its ORIGINAL `revokedAtMs` and is not counted. When a key was
   * revoked is a fact about that key, not about the last boot that noticed.
   */
  revokeIngestKeys(request: {
    projectId: string
    exceptKeyHash?: string | undefined
    atMs: number
  }): Promise<number>
}
