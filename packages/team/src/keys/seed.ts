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
 * **AND THE SENTENCE NAMES THE MODE THAT ACTS ON AN `.env` THAT ALREADY EXISTS
 * (#598).** All three refusals below used to say *"re-run
 * packages/team/deploy/init.sh"*. A bare run of that script returns early when
 * `.env` exists — and reaching any of these refusals PROVES it exists, because
 * the boot got this far only by connecting on the `RZ_TEAM_DATABASE_URL` that
 * file supplies, and the two values they complain about are read out of it. So
 * the operator ran the named command, it printed *"already initialised"*, minted
 * nothing, and the next boot failed identically. A wrong pointer to a real
 * command is worse than no pointer: running it reports success.
 *
 * The mode that does act on an existing file is `./init.sh
 * --rotate-ingest-key`, which #591 added after the procedure it replaced —
 * delete `.env`, re-run first boot — took the live deployment down. Rotation
 * rewrites one line and reads the project OUT of the file, which is why the
 * empty-project remedy sets `RZ_TEAM_PROJECT` FIRST: rotation refuses an `.env`
 * that names no project, so the other order would be a second no-op pointer.
 * `deploy/doctor.ts` prints the same sequence for the same three states, so the
 * boot refusal and the doctor line no longer disagree (prd-51 rulings 12, 13).
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
        `Remedy: set ${ENV_PROJECT} in packages/team/deploy/.env to this deployment's project id, then ` +
        'cd packages/team/deploy && ./init.sh --rotate-ingest-key to mint a key scoped to it, then ' +
        'docker compose up -d — NOT docker compose restart, which does not re-read .env.',
    }
  }

  if (!isIngestKeyHash(keyHash)) {
    return {
      ok: false,
      error:
        `${ENV_INGEST_KEY_SHA256} is not a sha-256 digest (64 lowercase hex characters), so this server ` +
        `has no key to seed for project ${JSON.stringify(projectId)}. Remedy: cd packages/team/deploy && ` +
        './init.sh --rotate-ingest-key, which mints a key, prints it once and rewrites only the ' +
        `${ENV_INGEST_KEY_SHA256} line of the .env this deployment already has, then docker compose up -d — ` +
        'NOT docker compose restart, which does not re-read .env.',
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
        '(prd-51 ruling 8). Remedy: cd packages/team/deploy && ./init.sh --rotate-ingest-key to mint a key ' +
        'for this project, then docker compose up -d — NOT docker compose restart, which does not re-read .env.',
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
