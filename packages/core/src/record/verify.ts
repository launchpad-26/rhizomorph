import { lineToEvent } from '../jsonl.js'
import { recordGenesisSeed } from './build.js'
import { sha256Hex } from './hash.js'
import type { SessionRecord } from './schema.js'

export type VerifyFailureReason = 'chain-broken' | 'manifest-mismatch' | 'malformed-line'

export interface VerifyFailure {
  ok: false
  reason: VerifyFailureReason
  /** 1-based position in `body` the failure names, or `null` for a manifest-wide mismatch. */
  lineNumber: number | null
  detail: string
}

export type VerifyResult = { ok: true } | VerifyFailure

/**
 * Recomputes the hash chain from the manifest's own identity fields and the
 * body's lines, and checks it closes to `manifest.chainDigest` — then checks
 * the manifest's own claims (`eventCount`, `startTs`/`endTs`) against what the
 * body actually holds, since those aren't covered by the chain itself. Flips
 * a single byte anywhere in a line, or in `repoSlug`/`actor.instance` /
 * `schemaVersion`, and this names exactly where the chain broke.
 */
export function verifyRecord(record: SessionRecord): VerifyResult {
  const { manifest, body } = record
  const seed = recordGenesisSeed({
    repoSlug: manifest.repoSlug,
    actor: manifest.actor,
    schemaVersion: manifest.schemaVersion,
  })
  let expectedPrev = sha256Hex(seed)

  for (let i = 0; i < body.length; i += 1) {
    const link = body[i]!
    if (link.prevHash !== expectedPrev) {
      return {
        ok: false,
        reason: 'chain-broken',
        lineNumber: i + 1,
        detail: `line ${i + 1}: expected prevHash ${expectedPrev}, found ${link.prevHash}`,
      }
    }
    const expectedHash = sha256Hex(link.prevHash + link.line)
    if (link.hash !== expectedHash) {
      return {
        ok: false,
        reason: 'chain-broken',
        lineNumber: i + 1,
        detail: `line ${i + 1}: content does not match its own hash — the chain is broken here`,
      }
    }
    expectedPrev = link.hash
  }

  if (expectedPrev !== manifest.chainDigest) {
    return {
      ok: false,
      reason: 'chain-broken',
      lineNumber: body.length > 0 ? body.length : null,
      detail: `chain closes to ${expectedPrev}, manifest declares chainDigest ${manifest.chainDigest}`,
    }
  }

  let minTs: number | null = null
  let maxTs: number | null = null
  for (let i = 0; i < body.length; i += 1) {
    const parsed = lineToEvent(body[i]!.line, i + 1)
    if (!parsed.ok) {
      return {
        ok: false,
        reason: 'malformed-line',
        lineNumber: i + 1,
        detail: `line ${i + 1} is not a valid event: ${parsed.error}`,
      }
    }
    minTs = minTs === null ? parsed.event.ts : Math.min(minTs, parsed.event.ts)
    maxTs = maxTs === null ? parsed.event.ts : Math.max(maxTs, parsed.event.ts)
  }

  if (manifest.eventCount !== body.length) {
    return {
      ok: false,
      reason: 'manifest-mismatch',
      lineNumber: null,
      detail: `manifest declares eventCount ${manifest.eventCount}, body holds ${body.length} lines`,
    }
  }

  if (body.length > 0 && (manifest.startTs !== minTs || manifest.endTs !== maxTs)) {
    return {
      ok: false,
      reason: 'manifest-mismatch',
      lineNumber: null,
      detail: `manifest time range ${manifest.startTs}-${manifest.endTs} does not match the body's ${minTs}-${maxTs}`,
    }
  }

  return { ok: true }
}
