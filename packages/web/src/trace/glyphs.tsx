import type { SpanDecision, SpanKind } from '@rhizomorph/core'
import { KIND_APPEARANCE, kindTagClass, type WorkKind } from '../theme/kind.js'

/**
 * THE ROW KIND TAG — one word, fixed width, lightness plus a capped tint.
 *
 * What a kind looks like is no longer decided here. `theme/kind.ts` owns the
 * one table (prd-31 ruling 1) and states the law — **a kind is not a status** —
 * because this file, `drawer/Activity.tsx` and `drawer/Conversation.tsx` each
 * used to encode that sentence separately and had already drifted apart on
 * `tool`. What stays here is the *translation*: which of the app's kinds a
 * `SpanKind` is. That is trace vocabulary, and it belongs to the trace.
 *
 * Reusing the ledger's tag convention rather than drawing seven new SVG marks
 * is still the "no new icon language" the brief asks for: one register, not
 * two — and now literally one function.
 */
const SPAN_KIND: Record<SpanKind, WorkKind> = {
  interaction: 'run',
  llm_request: 'model',
  tool: 'tool',
  tool_blocked: 'blocked',
  tool_execution: 'exec',
  hook: 'hook',
  other: 'other',
}

/**
 * The tag word, per span kind. Kept exported and kept this exact shape — #439
 * reads this furniture, so the module beneath it is additive and nothing here
 * is renamed or re-signatured. Derived, so it cannot drift from the table.
 */
export const KIND_WORD: Record<SpanKind, string> = mapSpanKinds((look) => look.word)

/** Accessible name for a row that has no other visible label (a bare kind tag). */
export const KIND_LABEL: Record<SpanKind, string> = mapSpanKinds((look) => look.label)

/** Lightness — one ice step. Never a ladder class (law 9a); the tint rides `KindTag`'s edge. */
export const KIND_CLASS: Record<SpanKind, string> = mapSpanKinds((look) => look.ink)

function mapSpanKinds(pick: (look: (typeof KIND_APPEARANCE)[WorkKind]) => string): Record<SpanKind, string> {
  const out = {} as Record<SpanKind, string>
  for (const [span, kind] of Object.entries(SPAN_KIND) as [SpanKind, WorkKind][]) {
    out[span] = pick(KIND_APPEARANCE[kind])
  }
  return out
}

export interface KindTagProps {
  kind: SpanKind
}

export function KindTag({ kind }: KindTagProps) {
  return (
    <span data-testid="trace-kind" data-kind={kind} className={kindTagClass(SPAN_KIND[kind])}>
      {KIND_WORD[kind]}
    </span>
  )
}

/**
 * prd9 ruling 6: a `tool_blocked` span is retrospective-exact — it reports how
 * long a lane SAT waiting and what got decided, never that anyone is waiting
 * now. `unknown` is not an absence here (it is what a pre-allowed tool really
 * reports, capture-confirmed) so it renders as its own word, exactly like
 * `accept`/`reject` rather than as a dash or a blank. None of the three
 * borrows a ladder hue: a decision already made is a fact, not a live alarm,
 * so it is told apart by lightness alone (the same law `theme/kind.ts` states,
 * minus the tint — a decision is an outcome, not a kind of work, so it has no
 * category to be the material of).
 */
export const DECISION_WORD: Record<SpanDecision, string> = {
  accept: 'accepted',
  reject: 'rejected',
  unknown: 'unknown',
}

const DECISION_CLASS: Record<SpanDecision, string> = {
  accept: 'text-(--ink-body)',
  reject: 'text-(--ink-body)',
  unknown: 'text-(--ink-dim)',
}

export interface DecisionBadgeProps {
  decision: SpanDecision
  /** The wait itself, already formatted — "waited", never "waiting" (ruling 6). */
  waitedFor: string
}

export function DecisionBadge({ decision, waitedFor }: DecisionBadgeProps) {
  return (
    <span data-testid="trace-decision" data-decision={decision} className="text-inst-dense text-(--ink-dim)">
      waited {waitedFor} ·{' '}
      <span className={`uppercase tracking-wide ${DECISION_CLASS[decision]}`}>
        {DECISION_WORD[decision]}
      </span>
    </span>
  )
}
