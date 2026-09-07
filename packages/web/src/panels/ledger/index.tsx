import { Fragment, useMemo, useState, type MouseEvent } from 'react'
import { selectSpendByBranch } from '@rhizomorph/core'
import { useModeClock } from '../../app/ModeContext.js'
import { laneUrl, navigate } from '../../app/router.js'
import { useStream } from '../../app/StreamContext.js'
import { Disclosure } from '../../disclosure/index.js'
import { useFleet, useSelection } from '../../fleet/index.js'
import { formatTokens } from '../../lib/format.js'
import { Sparkline } from '../../spark/index.js'
import { exemplarForBranch, heaviestLlmRequestSpanByLane } from './exemplar.js'
import {
  costCellText,
  costCellDisclosure,
  exemplarJumpDisclosure,
  landedDisclosure,
  formatElapsed,
  formatRelativeTime,
  threadLabel,
  tokensCellDisclosure,
} from './format.js'
import { branchOutputSpark, usageEventsByBranch } from './sparkline.js'
import { selectThreadRowsForBranch } from './threads.js'

export interface LedgerPanelProps {
  /** Test-only override so render tests don't depend on the wall clock. */
  now?: number
}

/**
 * prd1's "what did that feature cost me" table: one row per branch this
 * session has ever seen spend against, live and landed lanes together, dearest
 * first. This is the row that survives `workmux merge` deleting the worktree —
 * everywhere else in the UI that spend goes with it, this panel still has it,
 * because it is keyed on the branch rather than the worktree path.
 *
 * FIRST SEEN / LAST SEEN / ELAPSED read the mode's clock (#155), not the wall
 * clock directly: a replayed branch's "last seen" must age against the scrub
 * position, or a session recorded hours ago reads as hours-stale the instant
 * replay opens it, however recently — by scrub time — that branch last spoke.
 */
export default function LedgerPanel({ now: nowOverride }: LedgerPanelProps = {}) {
  const { state, status } = useStream()
  const modeClock = useModeClock()
  const now = nowOverride ?? modeClock
  // #171 — `state.session` IS this fold, kept incrementally by the shell
  // (`streamState.ts`); every other panel reads it directly rather than
  // re-reducing `state.events` from zero.
  const session = state.session
  // #158 — each memo keys on the slices its selector actually reads, not on
  // `session`, whose reference `core`'s `reduce` replaces on every event
  // (`withEnvelope`). A `trace.span` no longer re-runs the spend scan, and a
  // `tool.activity` — the plurality event type in a real session, per
  // `perf.test.ts`'s census — no longer re-buckets the sparklines, because
  // `withTelemetry` leaves `telemetry.usage`'s identity alone.
  const rows = useMemo(
    () => selectSpendByBranch(session),
    [session.telemetry, session.branches, session.worktrees],
  )
  const threadsByBranch = useMemo(
    () => new Map(rows.map((row) => [row.branch, selectThreadRowsForBranch(session, row)])),
    [rows, session.telemetry, session.branches, session.worktrees],
  )
  const fleet = useFleet()
  const { select } = useSelection()
  // #159 — the TOKENS sparkline and the exemplar jump: one pass each over
  // `state.traces`/`state.telemetry.usage`, read once for the whole table
  // rather than per row (the same shape `buildFleet.ts` already takes over
  // the identical arrays).
  const usageByBranch = useMemo(
    () => usageEventsByBranch(session.telemetry.usage),
    [session.telemetry.usage],
  )
  const exemplarsByLane = useMemo(() => heaviestLlmRequestSpanByLane(session), [session.traces])

  /** Branches with their sub-rows open — keyed by branch, so one lane's toggle never affects another's. */
  const [expandedBranches, setExpandedBranches] = useState<ReadonlySet<string>>(() => new Set())
  const toggleBranch = (branch: string): void => {
    setExpandedBranches((current) => {
      const next = new Set(current)
      if (next.has(branch)) next.delete(branch)
      else next.add(branch)
      return next
    })
  }

  /** Same signal ConnectionBadge/StatusBar read, plus proof at least one event has folded. */
  const connected = status === 'open' && state.events.length > 0

  return (
    // No frame and no heading of its own since #552 — the dock draws the border
    // and its tab strip names this surface (as SPEND, which is what prd-32 S3
    // calls it and what the reader is actually asking). Everything else about
    // the panel is untouched.
    <section data-panel="ledger" className="flex h-full min-h-0 flex-col">

      {rows.length === 0 && !connected ? (
        <p className="mt-2 text-read-body text-(--ink-dim)">Waiting for the stream…</p>
      ) : rows.length === 0 ? (
        <p className="mt-2 text-read-body text-(--ink-body)" role="status">
          No branch spend recorded yet this session.
        </p>
      ) : (
        <div className="mt-2 flex flex-col gap-2">
          <p className="text-read-floor text-(--ink-dim)" data-testid="ledger-honesty">
            Dollars are notional on subscription plans — the real signal here is efficiency and
            rate-limit budget. Estimated dollars are flagged "est."; nothing here is invented.
          </p>
          <table className="w-full border-collapse text-left text-read-body">
            <thead>
              <tr className="text-inst-dense uppercase tracking-wider text-(--ink-dim)">
                <th className="pb-1 pr-2 pl-2 font-medium">Branch</th>
                <th className="pb-1 pr-2 font-medium">Status</th>
                <th className="pb-1 pr-2 font-medium">Cost</th>
                <th className="pb-1 pr-2 font-medium">Tokens</th>
                <th className="pb-1 pr-2 font-medium">Models</th>
                <th className="pb-1 pr-2 font-medium">First seen</th>
                <th className="pb-1 pr-2 font-medium">Last seen</th>
                <th className="pb-1 font-medium">Elapsed</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const threads = threadsByBranch.get(row.branch) ?? []
                const expandable = threads.length > 0
                const expanded = expandable && expandedBranches.has(row.branch)
                // #159 — the branch's own lane identity for navigation/selection
                // (the fleet table's own `Lane.id`, falling back to the branch
                // name itself for a branch the derived fleet has no live lane
                // for — `/lane/:handle` reads that gracefully as NO LANE rather
                // than needing a guard here).
                const laneId = fleet.lanes.find((lane) => lane.branch === row.branch)?.id ?? row.branch
                const spark = branchOutputSpark(usageByBranch.get(row.branch) ?? [], now, row.firstTs)
                const exemplar = exemplarForBranch(exemplarsByLane, row.branch, row.lanes)
                return (
                  <Fragment key={row.branch}>
                    <tr
                      data-testid="ledger-row"
                      className={`border-t border-(--line-hair)/60 ${row.landed ? 'row-tint-done' : 'row-tint-working'}`}
                    >
                      <td
                        className={`py-1.5 pr-2 pl-2 font-mono text-(--ink-primary) ${row.landed ? 'cell-rule-done' : 'cell-rule-working'}`}
                      >
                        {expandable ? (
                          <button
                            type="button"
                            onClick={() => toggleBranch(row.branch)}
                            aria-expanded={expanded}
                            aria-label={`${expanded ? 'Collapse' : 'Expand'} threads for ${row.branch}`}
                            data-testid="ledger-thread-toggle"
                            className="mr-1 inline-flex w-3 text-(--ink-dim) hover:text-(--ink-primary)"
                          >
                            {expanded ? '▾' : '▸'}
                          </button>
                        ) : null}
                        {row.branch}
                        {row.issue === null ? null : (
                          <span className="ml-1 text-inst-dense text-(--ink-dim)">#{row.issue}</span>
                        )}
                        <OpenLaneLink handle={laneId} label={row.branch} />
                      </td>
                      <td className="py-1.5 pr-2">
                        <span
                          role="status"
                          aria-label={row.landed ? 'landed' : 'live'}
                          className={`inline-flex items-center gap-1 text-inst-dense uppercase tracking-wide ${
                            row.landed ? 'text-done' : 'text-working'
                          }`}
                        >
                          <Disclosure
                            disclosure={landedDisclosure(row.landed)}
                            triggerLabel={`${row.branch}, ${row.landed ? 'landed' : 'live'}`}
                          >
                            <span
                              className={`h-2 w-2 rounded-full ${
                                row.landed ? 'bg-done' : 'bg-working'
                              }`}
                            />
                            {row.landed ? 'Landed' : 'Live'}
                          </Disclosure>
                        </span>
                      </td>
                      <td
                        className="figures py-1.5 pr-2 text-(--ink-primary)"
                        data-testid="ledger-cost"
                      >
                        <Disclosure disclosure={costCellDisclosure(row)} triggerLabel={`${row.branch}, cost`}>
                          {costCellText(row)}
                          {row.costIsAuthoritative === false ? (
                            <span className="ml-1 text-inst-dense font-normal text-(--ink-dim)">est.</span>
                          ) : null}
                        </Disclosure>
                      </td>
                      <td
                        className="figures py-1.5 pr-2 text-(--ink-dim)"
                        data-testid="ledger-tokens"
                      >
                        <span className="inline-flex items-center gap-1.5">
                          {/*
                            The card wraps the figure and NOT the cell: the
                            exemplar jump is a button, and a trigger around the
                            whole cell would nest one inside the other — the
                            defect ADR-0040 exists to prevent. It has its own
                            disclosure, in the inline mode, a few lines down.
                          */}
                          <Disclosure disclosure={tokensCellDisclosure(row)} triggerLabel={`${row.branch}, tokens`}>
                            <Sparkline values={spark} className="shrink-0 text-(--ink-dim)" />
                            {formatTokens(row.tokens.output)}
                            <span className="text-inst-dense text-(--ink-dim)">out</span>
                          </Disclosure>
                          {exemplar === null ? null : (
                            <ExemplarJumpButton laneId={laneId} exemplar={exemplar} select={select} />
                          )}
                        </span>
                      </td>
                      <td className="py-1.5 pr-2 text-(--ink-dim)">
                        {row.models.length === 0 ? '—' : row.models.join(', ')}
                      </td>
                      <td className="figures py-1.5 pr-2 text-(--ink-dim)">
                        {formatRelativeTime(row.firstTs, now)}
                      </td>
                      <td className="figures py-1.5 pr-2 text-(--ink-dim)">
                        {formatRelativeTime(row.lastTs, now)}
                      </td>
                      <td className="figures py-1.5 text-(--ink-dim)">{formatElapsed(row.elapsedMs)}</td>
                    </tr>
                    {expanded
                      ? threads.map((thread) => (
                          <tr
                            key={`${row.branch}::${thread.thread ?? 'unknown'}`}
                            data-testid="ledger-subrow"
                            className="border-t border-(--line-hair)/30 text-inst"
                          >
                            <td className="py-1.5 pr-2 pl-6 font-mono text-(--ink-body)">
                              {threadLabel(thread.thread)}
                            </td>
                            <td className="py-1.5 pr-2 text-(--ink-dim)">—</td>
                            <td
                              className="figures py-1.5 pr-2 text-(--ink-body)"
                              data-testid="ledger-subrow-cost"
                            >
                              <Disclosure
                                disclosure={costCellDisclosure(thread)}
                                triggerLabel={`${threadLabel(thread.thread)}, cost`}
                              >
                                {costCellText(thread)}
                                {thread.costIsAuthoritative === false ? (
                                  <span className="ml-1 text-inst-dense font-normal text-(--ink-dim)">
                                    est.
                                  </span>
                                ) : null}
                              </Disclosure>
                            </td>
                            <td
                              className="figures py-1.5 pr-2 text-(--ink-dim)"
                              data-testid="ledger-subrow-tokens"
                            >
                              <Disclosure
                                disclosure={tokensCellDisclosure(thread)}
                                triggerLabel={`${threadLabel(thread.thread)}, tokens`}
                              >
                                {formatTokens(thread.tokens.output)}
                                <span className="ml-1 text-inst-dense text-(--ink-dim)">out</span>
                              </Disclosure>
                            </td>
                            <td className="py-1.5 pr-2 text-(--ink-dim)">
                              {thread.models.length === 0 ? '—' : thread.models.join(', ')}
                            </td>
                            <td className="py-1.5 pr-2 text-(--ink-dim)">—</td>
                            <td className="py-1.5 pr-2 text-(--ink-dim)">—</td>
                            <td className="py-1.5 text-(--ink-dim)">—</td>
                          </tr>
                        ))
                      : null}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

/**
 * THE ROW DRILL-DOWN (issue #159, Grafana's data-link pattern) — a branch row
 * has no click-to-select today (only its thread-expand toggle), so there is
 * nothing here to hijack; this is still the same modifier-aware, real-`<a
 * href>` convention the drawer's own `OpenPageLink` and the fleet table's
 * `OpenLaneLink` both use, so ctrl/cmd/shift/middle click keep opening a new
 * tab and a plain click swaps the SPA in place.
 */
function OpenLaneLink({ handle, label }: { handle: string; label: string }) {
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented || event.button !== 0) return
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    navigate(laneUrl(handle))
  }

  return (
    <a
      href={laneUrl(handle)}
      onClick={onClick}
      data-testid="ledger-row-open"
      aria-label={`Open ${label}'s page`}
      className="focus-ring ml-1 rounded-none text-(--ink-dim) hover:text-(--ink-primary)"
    >
      ↗
    </a>
  )
}

/**
 * THE EXEMPLAR JUMP (issue #159, Grafana's exemplars) — opens this branch's
 * lane where its trace is actually read.
 *
 * Until #562 that was `select(laneId)` plus `requestPanelFocus('trace')`, which
 * opened the drawer's TRACE tab and, from there, a focus panel with no address.
 * prd-36 ruling 2 cut both, so this jump follows the trace to the surface that
 * kept it: `/lane/:handle`, the run view, whose trace column renders the same
 * spans — the heaviest `llm_request` among them included — and, unlike the
 * panel this replaces, can be linked to in a review. The selection is still
 * written first, so the fleet behind the navigation agrees about which lane the
 * operator went to look at.
 */
function ExemplarJumpButton({
  laneId,
  exemplar,
  select,
}: {
  laneId: string
  exemplar: { tokens: number }
  select: (laneId: string) => void
}) {
  return (
    <Disclosure disclosure={exemplarJumpDisclosure(exemplar)} trigger="inline">
      <button
        type="button"
        data-testid="ledger-exemplar-jump"
        aria-label="open this lane's run view at its heaviest model request"
        onClick={() => {
          select(laneId)
          navigate(laneUrl(laneId))
        }}
        className="focus-ring rounded-none border border-(--line-hair) px-1 text-inst-dense text-(--ink-dim) hover:border-(--ink-dim) hover:text-(--ink-primary)"
      >
        ⇥ trace
      </button>
    </Disclosure>
  )
}
