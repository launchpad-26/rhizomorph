import type { TeamStorage } from '../storage/contract.js'
import { isIngestKeyHash } from './hash.js'

/**
 * THE DEPLOYMENT'S ONE KEY, SEEDED FROM ITS HASH (prd-51 ruling 8, ruling 13).
 *
 * `deploy/init.sh` mints the first project's key, prints it once and writes only
 * its SHA-256 into `.env`. This is what the boot that follows does with that
 * value: store the hash, then **revoke every other live key the project held**.
 *
 * That second half is the whole reason the runbook's rotation procedure is now
 * revocation rather than housekeeping. Before this, rotating meant generating a
 * new secret and telling nobody the old one — a shipper still configured with it
 * kept working, because nothing checked. Now the boot that learns the new hash
 * is the act that retires the old one, and a shipper holding it is refused from
 * its next batch with *"revoked key"*.
 *
 * **Idempotent, in both halves.** A second boot with the same hash inserts
 * nothing (the port dedups on the hash) and revokes nothing (the one live key is
 * the spared one). Only a boot that carries a DIFFERENT hash retires anything.
 *
 * **It refuses rather than guesses.** An absent or malformed hash, or an empty
 * project, is a refusal with a sentence the operator can act on — never a silent
 * skip, and never a seed under a made-up project id, which would create a live
 * key scoped to a project nobody ships to.
 *
 * No `process.env` here: this takes plain values, and `deploy/serve.ts` is where
 * the environment is read, beside the other three variables it already reads.
 */

export type SeedIngestKeyResult =
  | {
      ok: true
      /** `false` when this hash was already stored — a re-boot, not a rotation. */
      inserted: boolean
      /** How many OTHER live keys this project held and no longer does. */
      revoked: number
    }
  | { ok: false; error: string }

export const ENV_PROJECT = 'RZ_TEAM_PROJECT'
export const ENV_INGEST_KEY_SHA256 = 'RZ_TEAM_INGEST_KEY_SHA256'

export async function seedProjectIngestKey(
  storage: Pick<TeamStorage, 'insertIngestKey' | 'findIngestKey' | 'revokeIngestKeys'>,
  request: { projectId: string; keyHash: string; nowMs: number },
): Promise<SeedIngestKeyResult> {
  const projectId = request.projectId.trim()
  const keyHash = request.keyHash.trim().toLowerCase()

  if (projectId === '') {
    return {
      ok: false,
      error:
        `no ${ENV_PROJECT} in the environment, so there is no project to scope an ingest key to. ` +
        `Remedy: re-run packages/team/deploy/init.sh, or set ${ENV_PROJECT} and ${ENV_INGEST_KEY_SHA256} ` +
        'from the .env it wrote.',
    }
  }

  if (!isIngestKeyHash(keyHash)) {
    return {
      ok: false,
      error:
        `${ENV_INGEST_KEY_SHA256} is not a sha-256 digest (64 lowercase hex characters), so this server ` +
        `has no key to seed for project ${JSON.stringify(projectId)}. Remedy: re-run ` +
        'packages/team/deploy/init.sh, which mints a key, prints it once and writes only its digest.',
    }
  }

  // A hash this server already holds for a DIFFERENT project is refused rather
  // than re-scoped. The insert dedups on the hash, so re-scoping is not even
  // what would happen — the key would silently stay pointed at the other
  // project while the log said this one had been seeded.
  const existing = await storage.findIngestKey(keyHash)
  if (existing !== null && existing.projectId !== projectId) {
    return {
      ok: false,
      error:
        `that ingest key digest is already held for project ${JSON.stringify(existing.projectId)}, so it ` +
        `cannot also be seeded for ${JSON.stringify(projectId)}. A key is scoped to exactly one project ` +
        '(prd-51 ruling 8). Remedy: re-run packages/team/deploy/init.sh to mint a key for this project.',
    }
  }

  // Insert BEFORE the revoke, so there is no instant at which the project holds
  // no live key at all. A re-seed of a hash that is already stored is a no-op —
  // including when that stored row is revoked, which is deliberate: revocation
  // is not undone by restoring an old `.env`.
  await storage.insertIngestKey({ projectId, keyHash, createdAtMs: request.nowMs, revokedAtMs: null })
  const revoked = await storage.revokeIngestKeys({ projectId, exceptKeyHash: keyHash, atMs: request.nowMs })

  return { ok: true, inserted: existing === null, revoked }
}
