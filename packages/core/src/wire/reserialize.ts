import { readEventLineLenient, type RhizomorphEvent, type UnknownEventReason } from '../events/index.js'
import { eventToLine } from '../jsonl.js'

/**
 * THE VEIL, AS AN EQUALITY (prd-51 ruling 6, ADR-0033).
 *
 * What crosses the wire is exactly the line `buildRecord` would serialize for
 * that event — re-serialized through the current event schema, never copied
 * out of the ledger's bytes. That is one sentence and it is the whole module.
 *
 * It is written down because the first spike shipped the raw bytes instead,
 * and put `pane.activity.payload.preview` — real terminal text the current
 * schema no longer declares — on 30,627 wire events beside 0 record lines
 * (`docs/research/2026-08-28-shared-record-s2-shipper.md`, §veil). The
 * record's schema allowlist protects the record; it does not protect the wire
 * unless the wire re-serializes too. `record/build.ts` and
 * `record/reserialization-law.test.ts` are the same idea one layer in, and
 * this module deliberately calls the same `eventToLine` they do — that shared
 * call is what makes the server's re-export close to the identical
 * `chainDigest`.
 */

/**
 * The three-way verdict on one ledger line.
 *
 * - `line` — the line to ship, plus the event it came from.
 * - `unknown` — an intact envelope this era cannot fold.
 * - `malformed` — not an event line at all.
 *
 * **Neither non-`line` arm carries any input bytes, and that is structural
 * rather than conventional.** A caller cannot ship what it was never handed.
 * prd17 ruling 3 preserves an unknown line byte-for-byte in a *record*; ruling
 * 6 says what crosses the *wire* is exactly the lines `buildRecord` would
 * serialize, and `buildRecord` takes parsed events only — so an unfoldable
 * line is not one of them. The verdict says enough to log, count and
 * investigate (`type`, `ts`, `reason`, `detail`, or `error`) and nothing that
 * could be mistaken for a shippable line.
 *
 * **Open for wave 2, deliberately not solved here.** A line this build cannot
 * fold therefore cannot cross, which leaves a hole in ruling 3's "no gaps in
 * `n`". This issue owns the verdict type; the shipper issue owns the policy —
 * skip and record, refuse to advance the cursor, or something else. Do not
 * invent a wire shape for it here.
 */
export type ReserializedLine =
  | { kind: 'line'; line: string; event: RhizomorphEvent }
  | { kind: 'unknown'; type: string; ts: number; reason: UnknownEventReason; detail: string }
  | { kind: 'malformed'; error: string }

/**
 * One ledger line → the line the wire may carry, or an honest refusal.
 *
 * Glue over machinery that already exists: `readEventLineLenient` gives the
 * three-way verdict and `eventToLine` gives the record's own serialization.
 * There is deliberately no second parser here — a second one is a second
 * allowlist, and two allowlists is how a dropped field finds its way back.
 */
export function reserializeLine(line: string): ReserializedLine {
  const parsed = readEventLineLenient(line)

  if (parsed.kind === 'event') {
    return { kind: 'line', line: eventToLine(parsed.event), event: parsed.event }
  }

  if (parsed.kind === 'unknown') {
    // `parsed.unknown.line` is deliberately dropped: see the type's doc above.
    return {
      kind: 'unknown',
      type: parsed.unknown.type,
      ts: parsed.unknown.ts,
      reason: parsed.unknown.reason,
      detail: parsed.unknown.detail,
    }
  }

  // `parsed.line` is deliberately dropped, for the same reason.
  return { kind: 'malformed', error: parsed.error }
}
