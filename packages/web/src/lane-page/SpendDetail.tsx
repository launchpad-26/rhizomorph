import { selectSpendForLane, type LaneSpend, type SessionState } from '@rhizomorph/core'
import type { Fleet, Gap, Lane } from '../fleet/index.js'
import { formatTokenBreakdown, formatTokens, formatUsd } from '../lib/format.js'
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

/** The telemetry lane string the conductor's own usage/cost events carry (`fleet/fixtures.ts`'s `conductorBurn`). */
const CONDUCTOR_TELEMETRY_LANE = 'conductor'

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
 *
 * **The conductor (#138) is not a `Lane`** (see `PageHeader`'s own note), so
 * its subject carries no `Lane` at all — its cells come straight off
 * `selectSpendForLane(state, 'conductor')`'s own `LaneSpend`, the telemetry
 * lane the ledger already knows the conductor's usage/cost events by
 * (`fleet/fixtures.ts`'s `conductorBurn`). `null` — the log never mentioned
 * that telemetry lane at all — reads as the same gap-honest `—` a zero-cost-
 * event lane gets, never an invented zero.
 */
export type SpendDetailSubject = { kind: 'lane'; lane: Lane } | { kind: 'conductor' }

export interface SpendDetailProps {
  subject: SpendDetailSubject
  fleet: Fleet
  state: SessionState
}

export function SpendDetail({ subject, fleet, state }: SpendDetailProps) {
  const spend =
    subject.kind === 'conductor'
      ? selectSpendForLane(state, CONDUCTOR_TELEMETRY_LANE)
      : subject.lane.handles.length === 1
        ? selectSpendForLane(state, subject.lane.handles[0]!)
        : null
  const threads = spend?.threads ?? []
  const cells =
    subject.kind === 'conductor'
      ? conductorSpendCells(spend, fleet.gaps)
      : laneSpendCells(subject.lane, fleet.gaps)

  return (
    <section
      data-testid="lane-page-spend"
      className="flex min-h-0 flex-col rounded-lg border border-ice-850 bg-ice-950 p-3"
    >
      <h3 className="text-[10px] font-semibold uppercase tracking-[0.2em] text-ice-400">Spend</h3>

      <dl className="mt-2 grid grid-cols-3 gap-2 text-[11px]">
        <Cell label="output" value={cells.outputText} title={cells.outputTitle} />
        <Cell
          label="$"
          value={cells.costText}
          title={cells.costTitle}
          muted={cells.costMuted}
          suffix={cells.costSuffix}
        />
        <Cell label="req" value={cells.reqText} title={cells.reqTitle} muted={cells.reqMuted} />
      </dl>

      {threads.length === 0 ? (
        <p className="mt-2 text-[10px] leading-snug text-ice-400">
          {subject.kind === 'conductor'
            ? 'no thread breakdown reported for the conductor'
            : subject.lane.handles.length > 1
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

interface SpendCells {
  outputText: string
  outputTitle: string
  costText: string
  costTitle: string
  costMuted: boolean
  costSuffix: string | undefined
  reqText: string
  reqTitle: string
  reqMuted: boolean
}

function laneSpendCells(lane: Lane, gaps: readonly Gap[]): SpendCells {
  return {
    outputText: outputCellText(lane),
    outputTitle: outputCellTitle(lane),
    costText: costCellText(lane),
    costTitle: costCellTitle(lane, gaps),
    costMuted: lane.costEventCount === 0,
    costSuffix: lane.costIsAuthoritative === false ? 'est.' : undefined,
    reqText: String(lane.requestCount),
    reqTitle: 'model requests counted for this lane',
    reqMuted: lane.requestCount === 0,
  }
}

/**
 * The conductor's cells, straight off its own `LaneSpend` rather than the
 * fleet table's `Lane`-shaped cell code (`panels/fleet/format.js`'s
 * functions all take a `Lane`, which the conductor is not). The same
 * gap-honest rules apply by hand: no cost event ever seen reads `—`, and
 * `null` — the telemetry lane never mentioned at all — reads the same way.
 */
function conductorSpendCells(spend: LaneSpend | null, gaps: readonly Gap[]): SpendCells {
  const costEventCount = spend?.costEventCount ?? 0
  return {
    outputText: spend === null ? '—' : formatTokens(spend.tokens.output),
    outputTitle: spend === null ? 'no telemetry from the conductor yet' : formatTokenBreakdown(spend.tokens),
    costText: costEventCount === 0 ? '—' : formatUsd(spend!.costUsd),
    costTitle:
      costEventCount === 0
        ? (gaps.find((gap) => gap.id === 'no-cost-feed')?.line ?? 'no cost telemetry for the conductor')
        : spend!.costIsAuthoritative === false
          ? `estimated — not authoritative (${formatTokenBreakdown(spend!.tokens)})`
          : 'authoritative dollar cost (OTel)',
    costMuted: costEventCount === 0,
    costSuffix: spend?.costIsAuthoritative === false ? 'est.' : undefined,
    reqText: String(spend?.requestCount ?? 0),
    reqTitle: 'model requests counted for the conductor',
    reqMuted: (spend?.requestCount ?? 0) === 0,
  }
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
