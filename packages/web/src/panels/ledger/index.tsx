import { Fragment, useMemo, useState, type MouseEvent } from 'react'
import { selectSpendByBranch } from '@rhizomorph/core'
import { useModeClock } from '../../app/ModeContext.js'
import { requestPanelFocus } from '../../app/panelPrefs.js'
import { laneUrl, navigate } from '../../app/router.js'
import { useStream } from '../../app/StreamContext.js'
import { useFleet, useSelection } from '../../fleet/index.js'
import { formatTokens } from '../../lib/format.js'
import { Sparkline } from '../../spark/index.js'
import { exemplarForBranch, heaviestLlmRequestSpanByLane } from './exemplar.js'
import {
  costCellText,
  costCellTitle,
  formatElapsed,
  formatRelativeTime,
  threadLabel,
  tokensCellTitle,
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
  const rows = useMemo(() => selectSpendByBranch(session), [session])
  const threadsByBranch = useMemo(
    () => new Map(rows.map((row) => [row.branch, selectThreadRowsForBranch(session, row)])),
    [session, rows],
  )
  const fleet = useFleet()
  const { select } = useSelection()
  // #159 — the TOKENS sparkline and the exemplar jump: one pass each over
  // `state.traces`/`state.telemetry.usage`, read once for the whole table
  // rather than per row (the same shape `buildFleet.ts` already takes over
  // the identical arrays).
  const usageByBranch = useMemo(() => usageEventsByBranch(session.telemetry.usage), [session])
  const exemplarsByLane = useMemo(() => heaviestLlmRequestSpanByLane(session), [session])

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
    <section className="flex h-full flex-col rounded-lg border border-ice-850 bg-ice-950 p-4">
      <h2 className="text-xs font-semibold uppercase tracking-[0.2em] text-ice-400">Ledger</h2>

      {rows.length === 0 && !connected ? (
        <p className="mt-2 text-sm text-ice-400">Waiting for the stream…</p>
      ) : rows.length === 0 ? (
        <p className="mt-2 text-sm text-ice-300" role="status">
          No branch spend recorded yet this session.
        </p>
      ) : (
        <div className="mt-2 flex min-h-0 flex-1 flex-col gap-2 overflow-auto [scrollbar-gutter:stable]">
          <p className="text-[11px] text-ice-400" data-testid="ledger-honesty">
            Dollars are notional on subscription plans — the real signal here is efficiency and
            rate-limit budget. Estimated dollars are flagged "est."; nothing here is invented.
          </p>
          <table className="w-full border-collapse text-left text-sm">
            <thead>
              <tr className="text-[10px] uppercase tracking-wider text-ice-400">
                <th className="pb-1 pr-2 font-medium">Branch</th>
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
                      className="border-t border-ice-850/60"
                    >
                      <td className="py-1.5 pr-2 font-mono text-ice-200">
                        {expandable ? (
                          <button
                            type="button"
                            onClick={() => toggleBranch(row.branch)}
                            aria-expanded={expanded}
                            aria-label={`${expanded ? 'Collapse' : 'Expand'} threads for ${row.branch}`}
                            data-testid="ledger-thread-toggle"
                            className="mr-1 inline-flex w-3 text-ice-400 hover:text-ice-200"
                          >
                            {expanded ? '▾' : '▸'}
                          </button>
                        ) : null}
                        {row.branch}
                        {row.issue === null ? null : (
                          <span className="ml-1 text-[10px] text-ice-400">#{row.issue}</span>
                        )}
                        <OpenLaneLink handle={laneId} label={row.branch} />
                      </td>
                      <td className="py-1.5 pr-2">
                        <span
                          role="status"
                          aria-label={row.landed ? 'landed' : 'live'}
                          title={
                            row.landed
                              ? 'worktree removed — this feature is finished'
                              : 'worktree still present'
                          }
                          className={`inline-flex items-center gap-1 text-[10px] uppercase tracking-wide ${
                            row.landed ? 'text-done' : 'text-working'
                          }`}
                        >
                          <span
                            className={`h-2 w-2 rounded-full ${
                              row.landed ? 'bg-done' : 'bg-working'
                            }`}
                          />
                          {row.landed ? 'Landed' : 'Live'}
                        </span>
                      </td>
                      <td
                        className="figures py-1.5 pr-2 text-ice-200"
                        data-testid="ledger-cost"
                        title={costCellTitle(row)}
                      >
                        {costCellText(row)}
                        {row.costIsAuthoritative === false ? (
                          <span className="ml-1 text-[10px] font-normal text-ice-400">est.</span>
                        ) : null}
                      </td>
                      <td
                        className="figures py-1.5 pr-2 text-ice-400"
                        data-testid="ledger-tokens"
                        title={tokensCellTitle(row)}
                      >
                        <span className="inline-flex items-center gap-1.5">
                          <Sparkline values={spark} className="shrink-0 text-ice-400" />
                          {formatTokens(row.tokens.output)}
                          <span className="text-[10px] text-ice-400">out</span>
                          {exemplar === null ? null : (
                            <ExemplarJumpButton laneId={laneId} exemplar={exemplar} select={select} />
                          )}
                        </span>
                      </td>
                      <td className="py-1.5 pr-2 text-ice-400">
                        {row.models.length === 0 ? '—' : row.models.join(', ')}
                      </td>
                      <td className="figures py-1.5 pr-2 text-ice-400">
                        {formatRelativeTime(row.firstTs, now)}
                      </td>
                      <td className="figures py-1.5 pr-2 text-ice-400">
                        {formatRelativeTime(row.lastTs, now)}
                      </td>
                      <td className="figures py-1.5 text-ice-400">{formatElapsed(row.elapsedMs)}</td>
                    </tr>
                    {expanded
                      ? threads.map((thread) => (
                          <tr
                            key={`${row.branch}::${thread.thread ?? 'unknown'}`}
                            data-testid="ledger-subrow"
                            className="border-t border-ice-850/30 text-xs"
                          >
                            <td className="py-1.5 pr-2 pl-6 font-mono text-ice-300">
                              {threadLabel(thread.thread)}
                            </td>
                            <td className="py-1.5 pr-2 text-ice-400">—</td>
                            <td
                              className="figures py-1.5 pr-2 text-ice-300"
                              data-testid="ledger-subrow-cost"
                              title={costCellTitle(thread)}
                            >
                              {costCellText(thread)}
                              {thread.costIsAuthoritative === false ? (
                                <span className="ml-1 text-[10px] font-normal text-ice-400">
                                  est.
                                </span>
                              ) : null}
                            </td>
                            <td
                              className="figures py-1.5 pr-2 text-ice-400"
                              data-testid="ledger-subrow-tokens"
                              title={tokensCellTitle(thread)}
                            >
                              {formatTokens(thread.tokens.output)}
                              <span className="ml-1 text-[10px] text-ice-400">out</span>
                            </td>
                            <td className="py-1.5 pr-2 text-ice-400">
                              {thread.models.length === 0 ? '—' : thread.models.join(', ')}
                            </td>
                            <td className="py-1.5 pr-2 text-ice-400">—</td>
                            <td className="py-1.5 pr-2 text-ice-400">—</td>
                            <td className="py-1.5 text-ice-400">—</td>
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
      className="ml-1 rounded text-ice-400 hover:text-ice-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-ice-600"
    >
      ↗
    </a>
  )
}

/**
 * THE EXEMPLAR JUMP (issue #159, Grafana's exemplars) — opens this branch's
 * lane at the drawer's own TRACE section, over the two mechanisms that
 * already do exactly that for every other surface: the shared selection
 * (`useSelection().select`, which is what opens the drawer at all) and
 * `requestPanelFocus('trace')` (the same call the drawer's own `Focus ↗`
 * button makes, `drawer/Trace.tsx`). No new API, no new state — the trace
 * section then shows this lane's own spans, the heaviest `llm_request` among
 * them included, using its own existing rendering.
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
    <button
      type="button"
      data-testid="ledger-exemplar-jump"
      title={`jump to trace — heaviest llm_request, ${formatTokens(exemplar.tokens)} tok`}
      onClick={() => {
        select(laneId)
        requestPanelFocus('trace')
      }}
      className="rounded border border-ice-850 px-1 text-[10px] text-ice-400 hover:border-ice-600 hover:text-ice-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-ice-600"
    >
      ⇥ trace
    </button>
  )
}
