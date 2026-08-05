import { voiceUnknownEvents, type UnknownEventLine } from '../events/index.js'
import { recordGenesisSeed } from './build.js'
import { sha256Hex } from './hash.js'
import { bodyTsRange, readRecordBody } from './read.js'
import type { SessionRecord } from './schema.js'

export type VerifyFailureReason = 'chain-broken' | 'manifest-mismatch' | 'malformed-line'

export interface VerifyFailure {
  ok: false
  reason: VerifyFailureReason
  /** 1-based position in `body` the failure names, or `null` for a manifest-wide mismatch. */
  lineNumber: number | null
  detail: string
}

export interface VerifySuccess {
  ok: true
  /**
   * Lines this era counted but could not fold, byte-for-byte — prd17 ruling 3,
   * item 1. Empty for a record entirely from this era.
   *
   * A verified record with unknowns is **intact, not suspect**: the chain covers
   * `line` as opaque text, so an event family this reader has never heard of
   * hashes exactly as cleanly as one it folds. Refusing it — which is what this
   * function used to do, via `malformed-line` — threw away a whole federated
   * recording because one line came from a later version of the same
   * instrument, and told the operator nothing about what was lost.
   */
  unknown: UnknownEventLine[]
  /**
   * {@link voiceUnknownEvents} over `unknown`, or `null` when there is nothing
   * to say. Carried on the result rather than left to each caller so the CLI,
   * the dashboard and a stranger's reader all voice the same sentence.
   */
  unknownVoice: string | null
}

export type VerifyResult = VerifySuccess | VerifyFailure

/**
 * Recomputes the hash chain from the manifest's own identity fields and the
 * body's lines, and checks it closes to `manifest.chainDigest` — then checks
 * the manifest's own claims (`eventCount`, `startTs`/`endTs`) against what the
 * body actually holds, since those aren't covered by the chain itself. Flips
 * a single byte anywhere in a line, or in `repoSlug`/`actor.instance` /
 * `schemaVersion`, and this names exactly where the chain broke.
 *
 * **Unknown lines are counted, not refused (prd17 ruling 3, item 1).** A line
 * whose `type` this era has never heard of, or whose payload a later era
 * widened, is preserved in `unknown` and voiced in `unknownVoice`; verification
 * still succeeds, because integrity and comprehension are different questions
 * and the chain answers only the first. What still fails is a line that is not
 * an event at all — no envelope, no usable timestamp (`malformed-line`): the
 * chain vouching for that means the emitter wrote garbage, and dressing it up
 * as "a newer era" would be a lie.
 *
 * The timestamp pass counts unknowns too (see {@link bodyTsRange}), so an
 * honest manifest over a body containing them never reads as tampered.
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

  const read = readRecordBody(body)
  if (read.malformed !== null) {
    return {
      ok: false,
      reason: 'malformed-line',
      lineNumber: read.malformed.lineNumber,
      detail: `line ${read.malformed.lineNumber} is not an event at all: ${read.malformed.detail}`,
    }
  }

  if (manifest.eventCount !== body.length) {
    return {
      ok: false,
      reason: 'manifest-mismatch',
      lineNumber: null,
      detail: `manifest declares eventCount ${manifest.eventCount}, body holds ${body.length} lines`,
    }
  }

  const range = bodyTsRange(read)
  if (range !== null && (manifest.startTs !== range.minTs || manifest.endTs !== range.maxTs)) {
    return {
      ok: false,
      reason: 'manifest-mismatch',
      lineNumber: null,
      detail: `manifest time range ${manifest.startTs}-${manifest.endTs} does not match the body's ${range.minTs}-${range.maxTs}`,
    }
  }

  return { ok: true, unknown: read.unknown, unknownVoice: voiceUnknownEvents(read.unknown) }
}
