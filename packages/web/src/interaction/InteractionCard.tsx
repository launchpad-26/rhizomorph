import { useState, type ReactElement } from 'react'
import { Disclosure } from '../disclosure/index.js'
import { formatDuration, formatTokens, formatUsd } from '../lib/format.js'
import { kindEdgeClass, kindInkClass } from '../theme/kind.js'
import type { InteractionCardModel, InteractionCost } from './model.js'

/**
 * THE INTERACTION CARD (prd-31 ruling 6 and S1 · #556) — one prompt→response
 * cycle, legible at a skim, complete on demand.
 *
 * ```
 * ┌─ 19:04:12 · 3m12s wall · 47s work ─────────────┐
 * │ "I'll add the plan/run split first, then wire  │
 * │  the route."                                   │
 * │ sonnet · 9 tools · 2 files · 41.2k · $0.31 est │
 * │ ▸ full text   ▸ why the gap   ▸ 1 subagent     │
 * └────────────────────────────────────────────────┘
 * ```
 *
 * **The time shape leads**, because the gap between wall and work is the most
 * interesting fact the instrument holds and nothing else exposes it.
 *
 * **The words are the agent's, marked as a quotation.** This component renders
 * `model.quote` and never composes prose of its own; a bad sentence is the
 * agent's fault, and the reader can see it is a quote. An interaction with no
 * assistant text has NO quote line — absent, never an empty one.
 *
 * **It draws no kind of its own.** The tag colours come from `theme/kind.ts`
 * (#553), the one module that says what a kind looks like, and every
 * explanation goes through #554's disclosure card. This directory declares no
 * kind→class map and no card chrome — `one-card-law.test.ts` and
 * `kind.test.ts` both fail by diff if it starts.
 *
 * **A disclosure region, not a dialog** (S1's interactions): `▸ full text`
 * expands in place, `▸ why the gap` opens the disclosure card explaining the
 * wall/work difference, subagents expand nested — all keyboard-reachable, all
 * wearing the one focus token.
 */
export interface InteractionCardProps {
  model: InteractionCardModel
  /** Wall-clock, for the card's own timestamp. Injected so replay is identical to live. */
  timeZone?: string
}

/** `19:04:12` — the same 24-hour, seconds-resolution clock the trace uses. */
function clock(ts: number, timeZone?: string): string {
  return new Date(ts).toLocaleTimeString('en-GB', { hour12: false, timeZone })
}

export function InteractionCard({ model, timeZone }: InteractionCardProps): ReactElement {
  const [showFull, setShowFull] = useState(false)
  const [showSubagents, setShowSubagents] = useState(false)

  return (
    <article
      data-testid="interaction-card"
      data-lane={model.lane}
      data-span={model.spanId}
      data-in-flight={model.inFlight}
      className="rounded border border-(--surface-line) bg-(--surface-panel) px-2 py-1.5"
    >
      <header className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <time data-testid="interaction-clock" className="figures text-inst text-(--ink-dim)">
          {clock(model.startTs, timeZone)}
        </time>
        {model.inFlight ? (
          // No total for an interaction that has not ended: a number that will
          // change is worse than a word that says it is still moving (S1).
          <span data-testid="interaction-in-flight" className="figures text-inst text-(--ink-dim)">
            in flight — the interaction has not ended, so no total is shown
          </span>
        ) : (
          <>
            <span data-testid="interaction-wall" className="figures text-inst text-(--ink-primary)">
              {formatDuration(model.wallMs)} wall
            </span>
            <span data-testid="interaction-work" className="figures text-inst text-(--ink-body)">
              {formatDuration(model.workMs)} work
            </span>
          </>
        )}
        <span
          data-testid="interaction-phase"
          className={`figures text-inst-dense uppercase tracking-wider ${kindInkClass('run')}`}
        >
          <Disclosure disclosure={model.phase.disclosure} triggerLabel={`${model.phase.phase}, inferred`}>
            {model.phase.phase} · inferred
          </Disclosure>
        </span>
      </header>

      {model.quote === null ? null : (
        <blockquote
          data-testid="interaction-quote"
          className={`mt-1 text-read-body text-(--ink-primary) ${kindEdgeClass('model')}`}
        >
          “{showFull ? model.quote.full : model.quote.headline}”
        </blockquote>
      )}

      <dl data-testid="interaction-facts" className="mt-1 flex flex-wrap items-baseline gap-x-2 figures text-inst text-(--ink-body)">
        {model.facts.model === null ? null : (
          <Fact label="model" value={model.facts.model} testId="interaction-fact-model" />
        )}
        <Fact
          label="tools"
          value={String(model.facts.toolCount)}
          testId="interaction-fact-tools"
        />
        <Fact
          label="files"
          value={String(model.facts.files.length)}
          testId="interaction-fact-files"
        />
        <Fact
          label="output"
          value={formatTokens(model.facts.tokens.output)}
          testId="interaction-fact-tokens"
        />
        <CostFact cost={model.facts.cost} />
      </dl>

      <footer className="mt-1 flex flex-wrap items-center gap-x-3 text-inst-dense uppercase tracking-wider text-(--ink-dim)">
        {model.quote?.hasMore === true ? (
          <button
            type="button"
            data-testid="interaction-full-text"
            aria-expanded={showFull}
            onClick={() => setShowFull((open) => !open)}
            className="focus-ring hover:text-(--ink-primary)"
          >
            ▸ full text
          </button>
        ) : null}

        <Disclosure disclosure={model.gapDisclosure} triggerLabel="why the gap">
          <span data-testid="interaction-why-gap">▸ why the gap</span>
        </Disclosure>

        {model.subagents.length === 0 ? null : (
          <button
            type="button"
            data-testid="interaction-subagents-toggle"
            aria-expanded={showSubagents}
            onClick={() => setShowSubagents((open) => !open)}
            className="focus-ring hover:text-(--ink-primary)"
          >
            ▸ {model.subagents.length} subagent{model.subagents.length === 1 ? '' : 's'}
          </button>
        )}
      </footer>

      {showSubagents && model.subagents.length > 0 ? (
        <ul data-testid="interaction-subagents" className="mt-1 space-y-0.5">
          {model.subagents.map((subagent) => (
            <li
              key={subagent.agentId}
              data-testid="interaction-subagent"
              className={`figures text-inst text-(--ink-body) ${kindEdgeClass('run')}`}
            >
              {subagent.subagentType ?? 'subagent'} · {formatDuration(subagent.durationMs)} ·{' '}
              {formatTokens(subagent.tokens.output)} out
            </li>
          ))}
        </ul>
      ) : null}

      {model.refusals.length === 0 ? null : (
        <ul data-testid="interaction-refusals" className="mt-1 space-y-0.5">
          {model.refusals.map((refusal) => (
            <li
              key={refusal.spanId}
              data-testid="interaction-refusal"
              data-decision={refusal.decision}
              className={`figures text-inst ${kindInkClass('blocked')} ${kindEdgeClass('blocked')}`}
            >
              {refusal.toolName ?? 'tool'} · {refusal.decision} · waited {formatDuration(refusal.waitMs)}
            </li>
          ))}
        </ul>
      )}
    </article>
  )
}

function Fact({ label, value, testId }: { label: string; value: string; testId: string }): ReactElement {
  return (
    <div data-testid={testId} className="flex items-baseline gap-1">
      <dt className="text-(--ink-dim)">{label}</dt>
      <dd className="text-(--ink-body)">{value}</dd>
    </div>
  )
}

/**
 * Dollars with their provenance, or the honest gap through the one card.
 *
 * `est.` rides beside the figure rather than in a tooltip: an estimate a reader
 * has to hover to discover is an estimate that reads as authoritative at a
 * glance, which is the exact failure S1 names ("an estimated dollar without its
 * flag").
 */
function CostFact({ cost }: { cost: InteractionCost }): ReactElement {
  if (cost.kind === 'gap') {
    return (
      <div data-testid="interaction-fact-cost" data-cost-provenance="gap" className="flex items-baseline gap-1">
        <dt className="text-(--ink-dim)">$</dt>
        <dd className="text-(--ink-dim)">
          <Disclosure disclosure={cost.disclosure} triggerLabel="cost unavailable">
            <span data-testid="interaction-cost-gap">no cost feed</span>
          </Disclosure>
        </dd>
      </div>
    )
  }

  return (
    <div
      data-testid="interaction-fact-cost"
      data-cost-provenance={cost.kind}
      className="flex items-baseline gap-1"
      title={cost.kind === 'estimated' ? `estimated from ${cost.sources.join(', ') || 'a vendored price table'}` : 'the agent CLI’s own figure'}
    >
      <dt className="text-(--ink-dim)">$</dt>
      <dd className="text-(--ink-body)">
        {formatUsd(cost.usd)}
        {cost.kind === 'estimated' ? <span className="ml-1 text-(--ink-dim)">est.</span> : null}
      </dd>
    </div>
  )
}
