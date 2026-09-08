import { selectSpendForLane, type LaneSpend, type SessionState } from '@rhizomorph/core'
import type { Fleet, Gap, Lane } from '../fleet/index.js'
import { formatTokenBreakdown, formatTokens, formatUsd } from '../lib/format.js'
import { Disclosure, type DisclosureContent } from '../disclosure/index.js'
import {
  costCellText,
  costCellDisclosure,
  outputCellText,
  outputCellDisclosure,
  threadShort,
} from '../panels/fleet/format.js'
import {
  costCellText as threadCostText,
  costCellDisclosure as threadCostDisclosure,
  tokensCellDisclosure as threadTokensDisclosure,
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
      className="flex min-h-0 flex-col rounded-none border border-(--line-hair) bg-(--surface-panel) p-3"
    >
      <h3 className="text-inst-dense font-semibold uppercase tracking-[0.2em] text-(--ink-dim)">Spend</h3>

      <dl className="mt-2 grid grid-cols-3 gap-2 text-inst">
        <Cell label="output" value={cells.outputText} disclosure={cells.outputDisclosure} />
        <Cell
          label="$"
          value={cells.costText}
          disclosure={cells.costDisclosure}
          muted={cells.costMuted}
          suffix={cells.costSuffix}
        />
        <Cell label="req" value={cells.reqText} disclosure={cells.reqDisclosure} muted={cells.reqMuted} />
      </dl>

      {threads.length === 0 ? (
        <p className="mt-2 text-inst-dense leading-snug text-(--ink-dim)">
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
              className="flex items-baseline justify-between gap-2 border-t border-(--line-hair)/60 pt-1 font-mono text-inst-dense text-(--ink-dim) first:border-t-0"
            >
              <span className="uppercase text-(--ink-dim)">{threadShort(thread.thread)}</span>
              <span>
                <Disclosure
                  disclosure={threadTokensDisclosure(thread)}
                  triggerLabel={`${threadShort(thread.thread)}, tokens`}
                >
                  {formatTokens(thread.tokens.output)} out
                </Disclosure>
              </span>
              <span>
                <Disclosure
                  disclosure={threadCostDisclosure(thread)}
                  triggerLabel={`${threadShort(thread.thread)}, cost`}
                >
                  {threadCostText(thread)}
                  {thread.costIsAuthoritative === false ? (
                    <span className="ml-1 text-(--ink-dim)">est.</span>
                  ) : null}
                </Disclosure>
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
  outputDisclosure: DisclosureContent
  costText: string
  costDisclosure: DisclosureContent
  costMuted: boolean
  costSuffix: string | undefined
  reqText: string
  reqDisclosure: DisclosureContent
  reqMuted: boolean
}

/** The REQ cell's disclosure — a plain count, and the honest absence when it is zero. */
function requestsDisclosure(count: number, subject: string): DisclosureContent {
  return {
    label: 'req',
    why: {
      reason: count === 0 ? `no model request has been counted for ${subject} yet` : `model requests counted for ${subject}`,
      evidence: { fact: `${count} llm.usage event${count === 1 ? '' : 's'} folded`, elapsedMs: 0 },
    },
    remedy: { kind: 'none', because: 'a request count is a reading, not a condition' },
  }
}

function laneSpendCells(lane: Lane, gaps: readonly Gap[]): SpendCells {
  return {
    outputText: outputCellText(lane),
    outputDisclosure: outputCellDisclosure(lane),
    costText: costCellText(lane),
    costDisclosure: costCellDisclosure(lane, gaps),
    costMuted: lane.costEventCount === 0,
    costSuffix: lane.costIsAuthoritative === false ? 'est.' : undefined,
    reqText: String(lane.requestCount),
    reqDisclosure: requestsDisclosure(lane.requestCount, 'this lane'),
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
    outputDisclosure:
      spend === null
        ? {
            label: 'output',
            why: {
              reason: 'no telemetry from the conductor yet',
              evidence: { fact: 'the telemetry lane the conductor would report on has said nothing', elapsedMs: 0 },
            },
            remedy: {
              kind: 'action',
              action: "instrument the conductor — its burn is unknown, not zero",
            },
          }
        : {
            label: 'output',
            why: {
              reason: 'output tokens the conductor has produced',
              evidence: { fact: formatTokenBreakdown(spend.tokens), elapsedMs: 0 },
            },
            remedy: { kind: 'none', because: 'a token count is a reading, not a condition' },
          },
    costText: costEventCount === 0 ? '—' : formatUsd(spend!.costUsd),
    costDisclosure:
      costEventCount === 0
        ? {
            label: '$',
            why: {
              reason: gaps.find((gap) => gap.id === 'no-cost-feed')?.line ?? 'no cost telemetry for the conductor',
              evidence: { fact: 'no cost event has been folded for the conductor', elapsedMs: 0 },
            },
            remedy: {
              kind: 'action',
              action: "turn on the agent CLI's own cost telemetry for the conductor",
            },
          }
        : spend!.costIsAuthoritative === false
          ? {
              label: '$',
              why: {
                reason: 'estimated — not the agent CLI\'s own figure',
                evidence: { fact: `priced from ${formatTokenBreakdown(spend!.tokens)}`, elapsedMs: 0 },
              },
              remedy: { kind: 'none', because: 'an estimate is the best figure the conductor has reported' },
            }
          : {
              label: '$',
              why: {
                reason: 'authoritative dollar cost',
                evidence: { fact: 'the agent CLI reported this figure itself (OTel)', elapsedMs: 0 },
              },
              remedy: { kind: 'none', because: 'the figure comes from the CLI itself' },
            },
    costMuted: costEventCount === 0,
    costSuffix: spend?.costIsAuthoritative === false ? 'est.' : undefined,
    reqText: String(spend?.requestCount ?? 0),
    reqDisclosure: requestsDisclosure(spend?.requestCount ?? 0, 'the conductor'),
    reqMuted: (spend?.requestCount ?? 0) === 0,
  }
}

interface CellProps {
  label: string
  value: string
  disclosure: DisclosureContent
  muted?: boolean
  suffix?: string
}

/**
 * One spend cell — and, since #220, one disclosure, on the `<dd>` for the same
 * markup reason the drawer's `Vital` puts it there: a `<dl>`'s `<div>` may hold
 * only `<dt>` and `<dd>`.
 */
function Cell({ label, value, disclosure, muted = false, suffix }: CellProps) {
  return (
    <div className="min-w-0">
      <dt className="text-inst-dense uppercase tracking-wider text-(--ink-dim)">{label}</dt>
      <dd className={`figures truncate ${muted ? 'text-(--ink-dim)' : 'text-(--ink-primary)'}`}>
        <Disclosure disclosure={disclosure} triggerLabel={`${label}, ${value}`}>
        {value}
        {suffix === undefined ? null : (
          <span className="ml-1 text-inst-dense font-normal text-(--ink-dim)">{suffix}</span>
        )}
        </Disclosure>
      </dd>
    </div>
  )
}
