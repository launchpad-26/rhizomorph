/**
 * THE SHAPE OF AN INGEST KEY (prd-51 ruling 8).
 *
 * Ruling 8's machine plane: *"`rzk_` ingest keys: 32 random bytes, stored only
 * as SHA-256, shown once at mint, scoped to one project"*. This module is the
 * shape half of that sentence, and nothing else.
 *
 * **It mirrors `packages/server/src/shipper/key.ts` rather than inventing a
 * second shape.** That module is the only consumer of a key in this tree and it
 * REFUSES any value that does not carry the prefix or that is too short; a
 * server that accepted a different shape would mint values no shipper in this
 * tree could be configured with, which is the defect the review of #454 found in
 * `packages/team/deploy/init.sh` and fixed there. The two packages cannot import
 * each other — `packages/team/package.json` declares `@rhizomorph/core` and
 * `postgres` and nothing else — so the constants are duplicated, and the
 * duplication is held together by the artefact BOTH sides read:
 *
 * - `packages/server/src/shipper/key-mint-law.test.ts` holds `deploy/init.sh`'s
 *   minting expression to `key.ts`'s constants, from the server package.
 * - `packages/team/deploy/init.test.ts` runs that same script and holds the
 *   value it actually mints to {@link isWellFormedIngestKey} and to
 *   `hashIngestKey`, from this one.
 *
 * Neither package points at the other's constant; both point at the script. A
 * change to the minted shape therefore reddens on both sides rather than on
 * neither, and `.swarm/coupling.txt` records the seam.
 */

/** The one grant. `packages/server/src/shipper/key.ts` exports the same literal. */
export const INGEST_KEY_PREFIX = 'rzk_'

/**
 * Short enough to admit any plausible minting scheme, long enough that a typo or
 * a shell variable that expanded to nothing is refused. Mirrors
 * `MIN_INGEST_KEY_BODY` in `packages/server/src/shipper/key.ts`.
 */
export const MIN_INGEST_KEY_BODY = 16

/** Ruling 8, verbatim: *"32 random bytes"*. Hex-encoded, so 64 characters after the prefix. */
export const INGEST_KEY_RANDOM_BYTES = 32

/**
 * Whether a presented value could be a key at all.
 *
 * `packages/server/src/shipper/key.ts`'s `IngestKey` constructor states the same
 * three refusals as three throws — no prefix, too short, contains whitespace.
 * Restated here as a predicate because the server side must answer *"what kind
 * of refusal is this"* rather than *"is this fatal"*.
 *
 * A value that fails this is refused on shape alone and is never hashed and
 * never looked up: a string that cannot be a key is not worth a database read.
 */
export function isWellFormedIngestKey(value: string): boolean {
  if (value !== value.trim()) return false
  if (!value.startsWith(INGEST_KEY_PREFIX)) return false
  if (value.length - INGEST_KEY_PREFIX.length < MIN_INGEST_KEY_BODY) return false
  return !/\s/.test(value)
}
