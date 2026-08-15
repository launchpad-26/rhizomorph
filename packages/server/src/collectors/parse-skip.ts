/** One line a parser could not make sense of, kept verbatim plus a short reason — never silently dropped. */
export interface ParseSkip {
  line: string
  reason: string
}

const VOICE_LIMIT = 4

/** A single skip's rendered line/value is capped to this many characters — a
 * malformed row's own content (e.g. a title field) is attacker/bug-controlled
 * length, not ours to trust. */
export const MAX_VOICE_LENGTH = 200

/** Truncates `value` to `MAX_VOICE_LENGTH`, noting how much was cut — never
 * silently, so a truncated detail still says it's incomplete. */
export function truncateForVoice(value: string): string {
  if (value.length <= MAX_VOICE_LENGTH) return value
  return `${value.slice(0, MAX_VOICE_LENGTH)}… (+${value.length - MAX_VOICE_LENGTH} more chars)`
}

/** Renders a skip list as one collector.error detail string, capped so a bad batch can't produce an unbounded message. */
export function voiceSkips(skipped: readonly ParseSkip[]): string {
  const shown = skipped
    .slice(0, VOICE_LIMIT)
    .map((s) => `${s.reason}: ${truncateForVoice(s.line)}`)
    .join('; ')
  const remaining = skipped.length - VOICE_LIMIT
  return remaining > 0 ? `${shown} (+${remaining} more)` : shown
}
