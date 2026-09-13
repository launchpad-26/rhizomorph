import { createHash } from 'node:crypto'

/**
 * THE ONLY FORM OF A KEY THIS SERVER EVER STORES (prd-51 ruling 8).
 *
 * Ruling 8: *"32 random bytes, stored only as SHA-256, shown once at mint"*. The
 * plaintext exists in exactly two places for exactly two moments — the value
 * `mint.ts` yields once, and the header a shipper presents — and in neither case
 * does it reach a column, a log line or a refusal string.
 *
 * `node:crypto`, not a dependency. SHA-256 and `randomBytes` are both in the
 * platform, and `packages/team/package.json` declares two dependencies.
 *
 * ## The agreement that is not visible from here
 *
 * `packages/team/deploy/init.sh` computes the same digest in shell
 * (`printf '%s' "$key" | openssl dgst -sha256`) and writes it into `.env`, and
 * the server seeds that value at boot. The two must agree byte for byte or the
 * deployment's own key is refused as unknown, with nothing anywhere saying why.
 * The failure is a single trailing newline — `echo` instead of `printf` — and it
 * is invisible to every test that hashes with only one of the two tools. So the
 * agreement is asserted END TO END in `packages/team/deploy/init.test.ts`, which
 * runs the real script and hashes the real printed key with this function.
 */

/**
 * sha-256 hex of a key's plaintext, lowercase, 64 characters.
 *
 * The value is trimmed first, for the same reason `IngestKey`'s constructor
 * trims: a key that arrived through a pipe or a header may carry surrounding
 * whitespace, and hashing the whitespace would make the same key hash two ways.
 */
export function hashIngestKey(value: string): string {
  return createHash('sha256').update(value.trim(), 'utf8').digest('hex')
}

/** Whether a string is the shape {@link hashIngestKey} produces. The gate on anything seeded from outside. */
export function isIngestKeyHash(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value)
}
