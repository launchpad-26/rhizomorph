import { selectSpendForLane, type SessionState } from '@rhizomorph/core'
import type { Fleet, Lane } from '../fleet/index.js'
import { formatTokens } from '../lib/format.js'
import {
  costCellText,
  costCellTitle,
  outputCellText,
  outputCellTitle,
  threadShort,
} from '../panels/fleet/format.js'
import {
  costCellText as threadCostText,
  costCellTitle as threadCostTitle,
  tokensCellTitle as threadTokensTitle,
} from '../panels/ledger/format.js'

/**
 * THE SPEND DETAIL (prd9 B1b) — the lane's own money, at the same honesty the
 * fleet table and the ledger already hold each other to.
 *
 * The top line is the derived fleet's own `Lane` fields read through the
 * fleet table's own cell code (`panels/fleet/format.js`) — output-led
 * tokens, dollars flagged `est.` whenever `costIsAuthoritative` is false,
 * and the gap-honest `—` when no cost feed ever reached this lane (law 12).
 * Nothing here sums a token or prices a dollar itself.
 *
 * Thread sub-rows are the one thing the `Lane` object does not carry with
 * enough detail (its `filaments` have no cost, only tokens), so they come
 * straight from `selectSpendForLane` — a `LaneSpend` selector, per the same
 * ledger sub-row rule `panels/ledger/threads.ts` applies to a branch row:
 * they render only when exactly one telemetry handle claims this lane, since
 * a lane fed by more than one handle has no single thread breakdown that is
 * provably *the lane's own* (merging them would be an invented number).
 */
export interface SpendDetailProps {
  lane: Lane
  fleet: Fleet
  state: SessionState
}

export function SpendDetail({ lane, fleet, state }: SpendDetailProps) {
  const spend = lane.handles.length === 1 ? selectSpendForLane(state, lane.handles[0]!) : null
  const threads = spend?.threads ?? []

  return (
    <section
      data-testid="lane-page-spend"
      className="flex min-h-0 flex-col rounded-lg border border-ice-850 bg-ice-950 p-3"
    >
      <h3 className="text-[10px] font-semibold uppercase tracking-[0.2em] text-ice-400">Spend</h3>

      <dl className="mt-2 grid grid-cols-3 gap-2 text-[11px]">
        <Cell label="output" value={outputCellText(lane)} title={outputCellTitle(lane)} />
        <Cell
          label="$"
          value={costCellText(lane)}
          title={costCellTitle(lane, fleet.gaps)}
          muted={lane.costEventCount === 0}
          suffix={lane.costIsAuthoritative === false ? 'est.' : undefined}
        />
        <Cell
          label="req"
          value={String(lane.requestCount)}
          title="model requests counted for this lane"
          muted={lane.requestCount === 0}
        />
      </dl>

      {threads.length === 0 ? (
        <p className="mt-2 text-[10px] leading-snug text-ice-400">
          {lane.handles.length > 1
            ? 'thread breakdown unavailable — this lane spans more than one telemetry handle'
            : 'no thread breakdown reported for this lane'}
        </p>
      ) : (
        <ol data-testid="lane-page-spend-threads" className="mt-2 space-y-1 overflow-auto [scrollbar-gutter:stable]">
          {threads.map((thread) => (
            <li
              key={thread.thread ?? 'unknown'}
              data-testid="lane-page-spend-thread"
              className="flex items-baseline justify-between gap-2 border-t border-ice-850/60 pt-1 font-mono text-[10px] text-ice-400 first:border-t-0"
            >
              <span className="uppercase text-ice-400">{threadShort(thread.thread)}</span>
              <span title={threadTokensTitle(thread)}>{formatTokens(thread.tokens.output)} out</span>
              <span title={threadCostTitle(thread)}>
                {threadCostText(thread)}
                {thread.costIsAuthoritative === false ? (
                  <span className="ml-1 text-ice-400">est.</span>
                ) : null}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

interface CellProps {
  label: string
  value: string
  title: string
  muted?: boolean
  suffix?: string
}

function Cell({ label, value, title, muted = false, suffix }: CellProps) {
  return (
    <div className="min-w-0" title={title}>
      <dt className="text-[10px] uppercase tracking-wider text-ice-400">{label}</dt>
      <dd className={`figures truncate ${muted ? 'text-ice-400' : 'text-ice-200'}`}>
        {value}
        {suffix === undefined ? null : (
          <span className="ml-1 text-[10px] font-normal text-ice-400">{suffix}</span>
        )}
      </dd>
    </div>
  )
}
