/**
 * Ruling 5 (prd5) — a needs-you summons's INSISTENCE ages within its rung.
 * The ladder rung is still the only severity axis (a `Fleet` never promotes an
 * item across rungs because it got old); age only modulates how insistently
 * the *same* rung reads. Pinned here as constants, rather than inlined at each
 * call site, so the chip (`AttentionStripView`) and the tab title
 * (`useTabSignal`) can't drift onto two different ideas of "old".
 *
 * - `< AGE_QUIET_MAX_MS`: QUIET — a summons that "just happened" reads at the
 *   amber family's muted end, the same ink a benign wait already wears.
 * - `AGE_QUIET_MAX_MS`–`AGE_INK_MAX_MS`: INK — full needs-you brightness, no
 *   motion. The resting state a summons spends most of its life in.
 * - `>= AGE_INK_MAX_MS`: PULSE — old enough that calm authority adds a slow
 *   pulse on top of the full ink, and the age figure itself is emphasized.
 */
export const AGE_QUIET_MAX_MS = 2 * 60_000
export const AGE_INK_MAX_MS = 10 * 60_000

export type AgeBand = 'quiet' | 'ink' | 'pulse'

/** A `null` `forMs` (the log can't say how long) reads as the resting INK band — never escalated, never muted. */
export function ageBand(forMs: number | null): AgeBand {
  if (forMs === null) return 'ink'
  if (forMs < AGE_QUIET_MAX_MS) return 'quiet'
  if (forMs < AGE_INK_MAX_MS) return 'ink'
  return 'pulse'
}
