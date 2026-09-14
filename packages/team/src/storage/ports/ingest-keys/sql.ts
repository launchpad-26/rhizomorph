import { toEpochMs, toTimestamptz } from '../../coerce.js'
import type { SqlLike } from '../../driver.js'
import type { IngestKeyRow, IngestKeysPort } from './port.js'

/**
 * RULING 8'S ROWS — AND NOTHING BINDS A PLAINTEXT.
 *
 * The three statements below bind a hash, a project, two timestamps and
 * nothing else. There is no plaintext to bind: {@link IngestKeyRow} has no
 * such field, `keys/mint.ts` yields the value once and forgets it, and
 * `migrations/0005_ingest_keys.sql` declares no column that could hold one.
 * `keys/storage.test.ts` asserts it from the wire's side, over the statements
 * this actually sends and the bytes it actually binds.
 */
export function createIngestKeysSql(sql: SqlLike): IngestKeysPort {
  return {
    async insertIngestKey(row: IngestKeyRow): Promise<void> {
      // DO NOTHING, not DO UPDATE: a re-seed of a stored hash must not resurrect
      // a revoked key. See `keys/seed.ts`, which relies on exactly that.
      await sql`
        INSERT INTO ingest_keys (key_hash, project_id, created_at, revoked_at)
        VALUES (
          ${row.keyHash},
          ${row.projectId},
          ${toTimestamptz(row.createdAtMs)}::timestamptz,
          ${row.revokedAtMs === null ? null : toTimestamptz(row.revokedAtMs)}::timestamptz
        )
        ON CONFLICT (key_hash) DO NOTHING
      `
    },

    async findIngestKey(keyHash: string): Promise<IngestKeyRow | null> {
      const rows = await sql<Record<string, unknown>[]>`
        SELECT key_hash, project_id, created_at, revoked_at
        FROM ingest_keys
        WHERE key_hash = ${keyHash}
      `
      const row = rows[0]
      if (row === undefined) return null
      return {
        keyHash: String(row.key_hash),
        projectId: String(row.project_id),
        createdAtMs: toEpochMs(row.created_at),
        revokedAtMs: row.revoked_at === null || row.revoked_at === undefined ? null : toEpochMs(row.revoked_at),
      }
    },

    /**
     * One statement for both shapes, never two branches assembling different
     * text. `exceptKeyHash` is bound as a nullable parameter and the predicate
     * reads `(<param> IS NULL OR key_hash <> <param>)`, so the spared-key case
     * and the spare-nothing case are the same query plan and the same review.
     *
     * `revoked_at IS NULL` is what keeps this idempotent: a key already revoked
     * keeps the timestamp it was revoked at and is not counted again.
     */
    async revokeIngestKeys(request: {
      projectId: string
      exceptKeyHash?: string | undefined
      atMs: number
    }): Promise<number> {
      const spared = request.exceptKeyHash ?? null
      const result = await sql`
        UPDATE ingest_keys SET revoked_at = ${toTimestamptz(request.atMs)}::timestamptz
        WHERE project_id = ${request.projectId}
          AND revoked_at IS NULL
          AND (${spared}::text IS NULL OR key_hash <> ${spared})
      `
      return result.count
    },
  }
}
