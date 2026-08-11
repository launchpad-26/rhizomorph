/** One line a parser could not make sense of, kept verbatim plus a short reason — never silently dropped. */
export interface ParseSkip {
  line: string
  reason: string
}

const VOICE_LIMIT = 4

/** Renders a skip list as one collector.error detail string, capped so a bad batch can't produce an unbounded message. */
export function voiceSkips(skipped: readonly ParseSkip[]): string {
  const shown = skipped
    .slice(0, VOICE_LIMIT)
    .map((s) => `${s.reason}: ${s.line}`)
    .join('; ')
  const remaining = skipped.length - VOICE_LIMIT
  return remaining > 0 ? `${shown} (+${remaining} more)` : shown
}
