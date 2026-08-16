import { useState, type ReactElement } from 'react'
import { Disclosure } from '../disclosure/index.js'
import { InteractionCard, type InteractionCost } from '../interaction/index.js'
import { formatTokens, formatUsd } from '../lib/format.js'
import { kindEdgeClass, kindInkClass } from '../theme/kind.js'
import type { SpineSession } from './spine.js'

/**
 * THE PHASE SPINE (prd-31 S2, region 2 · #556) — a lane's derived phases across
 * its whole life, each recording expanding into its interactions.
 *
 * One row per recording, oldest first, so a lane that spanned three nights
 * reads as one life with three visible seams rather than as three unrelated
 * pages. The row for the recording currently loaded expands into
 * {@link InteractionCard}s; the others carry the index's facts and say where
 * their spans are, because a row that silently showed nothing would be
 * indistinguishable from a session in which nothing happened.
 *
 * **Every phase word wears its inference.** The word and the disclosure that
 * justifies it are one element — there is no arrangement of this markup that
 * renders "landing" without the evidence one keystroke away (ruling 7).
 */
export interface RunSpineProps {
  sessions: readonly SpineSession[]
  /** For a card's own clock. Injected so replay and live render identically. */
  timeZone?: string
}

export function RunSpine({ sessions, timeZone }: RunSpineProps): ReactElement {
  return (
    <section data-testid="run-spine" className="flex min-h-0 flex-col gap-2 overflow-auto">
      <h2 className="figures text-inst uppercase tracking-[0.2em] text-(--ink-dim)">
        the spine — {sessions.length === 1 ? '1 recording' : `${sessions.length} recordings`}
      </h2>
      {sessions.map((session) => (
        <SpineRow key={session.sessionId} session={session} timeZone={timeZone} />
      ))}
    </section>
  )
}

function SpineRow({ session, timeZone }: { session: SpineSession; timeZone?: string }): ReactElement {
  // The loaded recording opens by default — it is the one the reader came for.
  // Every other row is skim-first, expand-on-demand (D8).
  const [open, setOpen] = useState(session.loaded)

  return (
    <article
      data-testid="run-spine-session"
      data-session={session.sessionId}
      data-loaded={session.loaded}
      data-recording-present={session.gap === null}
      className={`rounded border border-(--surface-line) bg-(--surface-panel) px-2 py-1.5 ${kindEdgeClass('run')}`}
    >
      <header className="flex flex-wrap items-baseline gap-x-2">
        <span data-testid="run-spine-session-id" className="figures text-inst text-(--ink-primary)">
          {session.label ?? new Date(session.startedAt).toISOString().slice(0, 10)}
        </span>
        <span className="figures text-inst-dense text-(--ink-dim)">session {session.sessionId}</span>
        <span
          data-testid="run-spine-phase"
          data-phase={session.phase.phase}
          className={`figures text-inst-dense uppercase tracking-wider ${kindInkClass('run')}`}
        >
          <Disclosure
            disclosure={session.phase.disclosure}
            triggerLabel={`${session.phase.phase}, inferred`}
          >
            {session.phase.phase} · inferred
          </Disclosure>
        </span>
      </header>

      {session.gap === null ? (
        <dl className="mt-1 flex flex-wrap items-baseline gap-x-3 figures text-inst text-(--ink-body)">
          <Figure label="interactions" value={String(session.interactionCount)} testId="run-spine-interactions" />
          <Figure label="tools" value={String(session.toolCallCount)} testId="run-spine-tools" />
          <Figure label="files" value={String(session.files.length)} testId="run-spine-files" />
          <Figure label="output" value={formatTokens(session.outputTokens)} testId="run-spine-output" />
          <SpendFigure cost={session.cost} />
        </dl>
      ) : (
        // S2's *partial* state, in its own words. The row stays — dropping it
        // would make a partial reading look complete.
        <p data-testid="run-spine-gap" role="status" className="mt-1 text-read-body text-(--ink-dim)">
          {session.gap}
        </p>
      )}

      {session.gap === null && session.cards.length > 0 ? (
        <>
          <button
            type="button"
            data-testid="run-spine-toggle"
            aria-expanded={open}
            onClick={() => setOpen((shown) => !shown)}
            className="focus-ring mt-1 text-inst-dense uppercase tracking-wider text-(--ink-dim) hover:text-(--ink-primary)"
          >
            ▸ {session.cards.length} interaction{session.cards.length === 1 ? '' : 's'}
          </button>
          {open ? (
            <ul data-testid="run-spine-cards" className="mt-1 space-y-1.5">
              {session.cards.map((card) => (
                <li key={`${card.traceId}:${card.spanId}`}>
                  <InteractionCard model={card} timeZone={timeZone} />
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}

      {session.gap === null && session.cards.length === 0 && !session.loaded ? (
        <p data-testid="run-spine-elsewhere" className="mt-1 text-read-body text-(--ink-dim)">
          this recording’s spans are not the one loaded — open session {session.sessionId} in replay to
          read its interactions; the figures above are the index’s own
        </p>
      ) : null}
    </article>
  )
}

function Figure({ label, value, testId }: { label: string; value: string; testId: string }): ReactElement {
  return (
    <div data-testid={testId} className="flex items-baseline gap-1">
      <dt className="text-(--ink-dim)">{label}</dt>
      <dd className="text-(--ink-body)">{value}</dd>
    </div>
  )
}

/** Dollars with provenance, or the honest gap — the same three arms the card uses. */
function SpendFigure({ cost }: { cost: InteractionCost }): ReactElement {
  if (cost.kind === 'gap') {
    return (
      <div data-testid="run-spine-cost" data-cost-provenance="gap" className="flex items-baseline gap-1">
        <dt className="text-(--ink-dim)">$</dt>
        <dd className="text-(--ink-dim)">
          <Disclosure disclosure={cost.disclosure} triggerLabel="cost unavailable">
            <span>no cost feed</span>
          </Disclosure>
        </dd>
      </div>
    )
  }
  return (
    <div data-testid="run-spine-cost" data-cost-provenance={cost.kind} className="flex items-baseline gap-1">
      <dt className="text-(--ink-dim)">$</dt>
      <dd className="text-(--ink-body)">
        {formatUsd(cost.usd)}
        {cost.kind === 'estimated' ? <span className="ml-1 text-(--ink-dim)">est.</span> : null}
      </dd>
    </div>
  )
}
