import type { SpanDecision, SpanKind } from '@rhizomorph/core'

/**
 * THE ROW KIND TAG — one word, fixed width, lightness only.
 *
 * `drawer/Activity.tsx` already answers "how does this dashboard mark a row's
 * kind" for the git/file/commit ledger (`KIND_WORD`/`KIND_CLASS`): a short
 * word in a narrow column, differentiated from its neighbours by ice lightness
 * alone, never by a ladder hue — "a kind is not a status" is that file's own
 * reasoning, and it applies here without a single change, since a span's kind
 * is exactly the same sort of fact (what a row IS, not how alarmed anyone
 * should be about it). Reusing that convention rather than drawing seven new
 * SVG marks is the "no new icon language" the brief asks for: one register,
 * not two.
 */
export const KIND_WORD: Record<SpanKind, string> = {
  interaction: 'run',
  llm_request: 'llm',
  tool: 'tool',
  tool_blocked: 'blocked',
  tool_execution: 'exec',
  hook: 'hook',
  other: 'other',
}

/** Accessible name for a row that has no other visible label (a bare kind tag). */
export const KIND_LABEL: Record<SpanKind, string> = {
  interaction: 'interaction',
  llm_request: 'model request',
  tool: 'tool call',
  tool_blocked: 'blocked on a human',
  tool_execution: 'tool execution',
  hook: 'hook span',
  other: 'unclassified span',
}

/** Lightness only — see the module note. Never a ladder class (law 9a). */
export const KIND_CLASS: Record<SpanKind, string> = {
  interaction: 'text-ice-300',
  llm_request: 'text-ice-200',
  tool: 'text-ice-400',
  tool_blocked: 'text-ice-400',
  tool_execution: 'text-ice-300',
  hook: 'text-ice-400',
  other: 'text-ice-400',
}

export interface KindTagProps {
  kind: SpanKind
}

export function KindTag({ kind }: KindTagProps) {
  return (
    <span
      data-testid="trace-kind"
      data-kind={kind}
      className={`w-14 shrink-0 text-[10px] uppercase tracking-wider ${KIND_CLASS[kind]}`}
    >
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
 * so it is told apart by lightness alone (the same law `KIND_CLASS` follows).
 */
export const DECISION_WORD: Record<SpanDecision, string> = {
  accept: 'accepted',
  reject: 'rejected',
  unknown: 'unknown',
}

const DECISION_CLASS: Record<SpanDecision, string> = {
  accept: 'text-ice-300',
  reject: 'text-ice-200',
  unknown: 'text-ice-400',
}

export interface DecisionBadgeProps {
  decision: SpanDecision
  /** The wait itself, already formatted — "waited", never "waiting" (ruling 6). */
  waitedFor: string
}

export function DecisionBadge({ decision, waitedFor }: DecisionBadgeProps) {
  return (
    <span data-testid="trace-decision" data-decision={decision} className="text-[10px] text-ice-400">
      waited {waitedFor} ·{' '}
      <span className={`uppercase tracking-wide ${DECISION_CLASS[decision]}`}>
        {DECISION_WORD[decision]}
      </span>
    </span>
  )
}
