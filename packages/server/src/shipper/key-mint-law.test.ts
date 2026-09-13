import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { INGEST_KEY_PREFIX, IngestKey, MIN_INGEST_KEY_BODY } from './key.js'

/**
 * THE MINTER AND THE VALIDATOR AGREE (review of #454).
 *
 * `packages/team/deploy/init.sh` mints the ingest key an operator is told to
 * save; `packages/server/src/shipper/key.ts` is the only thing in this tree
 * that consumes one, and it REFUSES any value without {@link
 * INGEST_KEY_PREFIX}. Those two lines live in different packages, one of them
 * is shell, and nothing connected them — so `init.sh` shipped minting a bare
 * `openssl rand -hex 32`, and `rhizomorph connect team` would have answered
 * *"that is not an ingest key"* to the value the runbook says to keep.
 *
 * The server not verifying key VALUES yet (`docs/team-server-runbook.md`, "What
 * is not wired up yet") is why nobody hit it: the shape is checked long before
 * the value would be, on the shipper's side, by the one command that stores it.
 *
 * This law reads the script's own text and this module's own constants — it
 * retypes neither — and the bite test below proves it fails on the form that
 * actually shipped.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const INIT_SH = path.join(HERE, '..', '..', '..', 'team', 'deploy', 'init.sh')

/** The right-hand side of `init.sh`'s `ingest_key=` assignment, quotes stripped. */
export function mintedKeyExpression(script: string): string {
  const match = /^ingest_key="([^"]*)"$/m.exec(script)
  if (match === null) {
    throw new Error('packages/team/deploy/init.sh has no `ingest_key="..."` line for this law to read')
  }
  return match[1] as string
}

/**
 * The literal head of a minting expression — everything before the first shell
 * substitution. `rzk_$(openssl rand -hex 32)` yields `rzk_`; a bare
 * `$(openssl rand -hex 32)` yields `''`, which is the failure this law exists
 * for.
 */
export function literalPrefixOf(expression: string): string {
  const substitution = expression.search(/\$[({]/)
  return substitution === -1 ? expression : expression.slice(0, substitution)
}

/** How many characters `openssl rand -hex N` contributes — two per byte. */
export function hexBodyLength(expression: string): number | null {
  const match = /openssl\s+rand\s+-hex\s+(\d+)/.exec(expression)
  return match === null ? null : Number(match[1]) * 2
}

describe('init.sh mints a key key.ts will accept', () => {
  const expression = mintedKeyExpression(readFileSync(INIT_SH, 'utf8'))

  it('the minted value begins with the prefix this module requires', () => {
    // Both sides come from the artefacts themselves: the prefix from key.ts's
    // own export, the head from the script's own assignment.
    expect(literalPrefixOf(expression)).toBe(INGEST_KEY_PREFIX)
  })

  it('the body is long enough that IngestKey will not call it a truncation', () => {
    const body = hexBodyLength(expression)
    expect(body).not.toBeNull()
    expect(body as number).toBeGreaterThanOrEqual(MIN_INGEST_KEY_BODY)
  })

  it('END TO END: a value of exactly the shape init.sh mints is accepted', () => {
    // Not a hand-written fixture — assembled from the script's own prefix and
    // its own declared body width, so a change to either side reaches here.
    const minted = literalPrefixOf(expression) + 'a'.repeat(hexBodyLength(expression) as number)
    expect(() => new IngestKey(minted)).not.toThrow()
    expect(new IngestKey(minted).headerValue()).toBe(minted)
  })

  it('THE LAW BITES — the form that actually shipped is refused by both halves', () => {
    const shipped = '$(openssl rand -hex 32)'
    expect(literalPrefixOf(shipped)).not.toBe(INGEST_KEY_PREFIX)
    expect(() => new IngestKey('a'.repeat(64))).toThrowError(/begins "rzk_"/)
  })
})
