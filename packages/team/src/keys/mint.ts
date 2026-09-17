import { randomBytes } from 'node:crypto'
import type { IngestKeyRow } from '../storage/contract.js'
import { hashIngestKey } from './hash.js'
import { INGEST_KEY_PREFIX, INGEST_KEY_RANDOM_BYTES } from './shape.js'

/**
 * MINTING, AND "SHOWN ONCE" MADE MECHANICAL (prd-51 ruling 8).
 *
 * Ruling 8 says a key is *"shown once at mint"*. A comment saying so is a
 * comment; this module makes it a property of the return type. {@link
 * MintedIngestKey.takePlaintext} yields the value and forgets it, and a second
 * call throws rather than quietly handing the secret out twice.
 *
 * **Everything that renders the object renders the redaction.** `toString`,
 * `toJSON` and Node's custom-inspect hook all yield `rzk_[redacted]`, so a
 * template literal, a `JSON.stringify` of an options bag and a `console.log` of
 * the whole thing each produce the same harmless string. That is
 * `packages/server/src/shipper/key.ts`'s `IngestKey` discipline, applied on the
 * server's side of the wire — the side that MINTS rather than the side that
 * presents.
 *
 * **The row carries no plaintext at all**, not even a redacted one: it is the
 * value the storage port stores, and a field that does not exist cannot reach a
 * column. `migrations/schema-law.test.ts` case 31 holds the same claim from the
 * schema's side.
 *
 * The viewer that a member mints from is `../view/mint/mint.ts`, reached at
 * `POST /v1/rhizomorph/keys` — ruling 8's *"a member mints a key in the
 * viewer"*, shipped by #560. That surface and `deploy/init.sh`'s first key are
 * this module's two callers.
 *
 * This sentence used to say that viewer *"is wave 7's"* and defer with it. The
 * wave number had been invalidated by the 2026-09-09 renumbering and the
 * deferral by the commit that carries this edit, so both halves were false at
 * once — ruling 12 forbids shipping either.
 */

/** What `randomBytes(n).toString('hex')` does, as a seam a test can drive deterministically. */
export type RandomHex = (bytes: number) => string

/** Node's custom-inspect hook. Declared on the interface so `console.log` cannot out-render `toString`. */
const INSPECT_CUSTOM: unique symbol = Symbol.for('nodejs.util.inspect.custom')

export interface MintedIngestKey {
  /** The row to store. Carries the hash, the project and the clock — and no plaintext field at all. */
  readonly row: IngestKeyRow
  /**
   * The plaintext, yielded EXACTLY ONCE (ruling 8's *"shown once at mint"*).
   *
   * A second call throws. That is not defensiveness: the whole difference
   * between a secret shown once and a secret stored is whether a second reader
   * can get it, and a method that answers twice is a store with extra steps.
   */
  takePlaintext(): string
  toJSON(): string
  toString(): string
  readonly [INSPECT_CUSTOM]: () => string
}

/** What every rendering of a minted key yields. Never a truncation — a prefix of a secret is still a piece of one. */
export const REDACTED_MINTED_KEY = `${INGEST_KEY_PREFIX}[redacted]`

export function mintIngestKey(request: {
  projectId: string
  nowMs: number
  /** Defaults to `node:crypto`. Injected only by tests, the way `faults.ts` injects timing. */
  randomHex?: RandomHex | undefined
}): MintedIngestKey {
  const random = request.randomHex ?? ((bytes: number) => randomBytes(bytes).toString('hex'))
  const plaintext = `${INGEST_KEY_PREFIX}${random(INGEST_KEY_RANDOM_BYTES)}`

  const row: IngestKeyRow = {
    keyHash: hashIngestKey(plaintext),
    projectId: request.projectId,
    createdAtMs: request.nowMs,
    revokedAtMs: null,
  }

  let held: string | null = plaintext

  return {
    row,
    takePlaintext(): string {
      if (held === null) {
        throw new Error(
          'this ingest key has already been shown once and is not held any more (prd-51 ruling 8) — mint a new one',
        )
      }
      const value = held
      held = null
      return value
    },
    toJSON: () => REDACTED_MINTED_KEY,
    toString: () => REDACTED_MINTED_KEY,
    [INSPECT_CUSTOM]: () => REDACTED_MINTED_KEY,
  }
}
