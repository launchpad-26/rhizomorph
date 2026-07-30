import { useEffect, useMemo, useState } from 'react'
import {
  AGENT_ROLES,
  reduceAll,
  selectLaneSpend,
  selectRoleSpend,
  selectSessionSpend,
  selectSpendRate,
  type AgentRole,
} from '@observatory/core'
import { useStream } from '../../app/StreamContext.js'
import {
  formatCostOrGap,
  formatCostOverhead,
  formatTokens,
  formatUsd,
  formatUsdPerHour,
  selectCostOverhead,
} from './format.js'

export interface SpendPanelProps {
  /** Test-only override so render tests don't depend on the wall clock. */
  now?: number
}

const ROLE_LABEL: Record<AgentRole, string> = {
  worker: 'Worker',
  conductor: 'Conductor',
  auxiliary: 'Auxiliary',
}

const ROLE_DOT_CLASS: Record<AgentRole, string> = {
  worker: 'bg-neon-cyan',
  conductor: 'bg-neon-magenta',
  auxiliary: 'bg-neon-amber',
}

/** Re-ticks the clock so the rolling-window rate keeps moving with no new events. */
function useNow(override?: number): number {
  const [now, setNow] = useState(() => override ?? Date.now())

  useEffect(() => {
    if (override !== undefined) return
    const id = setInterval(() => setNow(Date.now()), 5000)
    return () => clearInterval(id)
  }, [override])

  return override ?? now
}

/**
 * prd1's headline instrument: live tokens/dollars, the $/hour burn rate, the
 * worker/conductor/auxiliary split with the overhead ratio front and centre,
 * and per-lane mini-bars. Falls back to tokens-only when no `llm.cost` event
 * has ever arrived — dollars are never invented from tokens here.
 */
export default function SpendPanel({ now: nowOverride }: SpendPanelProps = {}) {
  const { state, status } = useStream()
  const now = useNow(nowOverride)
  const session = useMemo(() => reduceAll(state.events), [state.events])
  const totals = useMemo(() => selectSessionSpend(session), [session])
  const rate = useMemo(() => selectSpendRate(session, { now }), [session, now])
  const roleSplit = useMemo(() => selectRoleSpend(session), [session])
  const costOverhead = useMemo(
    () => selectCostOverhead(roleSplit.worker, roleSplit.conductor),
    [roleSplit],
  )
  const lanes = useMemo(() => selectLaneSpend(session), [session])

  const hasData = totals.requestCount > 0 || totals.costEventCount > 0 || totals.toolCallCount > 0
  /** No `llm.cost` event has ever arrived — show tokens, invent no dollars. */
  const tokensOnly = totals.costIsAuthoritative === null
  /** Same signal ConnectionBadge/StatusBar read, plus proof at least one event has folded. */
  const connected = status === 'open' && state.events.length > 0
  const maxLaneTokens = Math.max(1, ...lanes.map((lane) => lane.tokens.total))

  return (
    <section className="flex h-full flex-col rounded-lg border border-void-line bg-void-raised p-4">
      <h2 className="text-xs font-semibold uppercase tracking-widest text-neon-cyan">
        Spend ticker
      </h2>

      {!hasData && !connected ? (
        <p className="mt-2 text-sm text-slate-500">Waiting for the stream…</p>
      ) : !hasData ? (
        <p className="mt-2 text-sm text-slate-300" role="status">
          No spend recorded yet this session.
        </p>
      ) : (
        <div className="mt-2 flex min-h-0 flex-1 flex-col gap-3 overflow-auto">
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <span className="font-mono text-2xl text-slate-100" data-testid="spend-total-tokens">
              {formatTokens(totals.tokens.total)}
              <span className="ml-1 text-xs font-normal text-slate-500">tokens</span>
            </span>
            {tokensOnly ? null : (
              <>
                <span className="font-mono text-2xl text-neon-cyan" data-testid="spend-total-cost">
                  {formatUsd(totals.costUsd)}
                  {totals.costIsAuthoritative ? null : (
                    <span className="ml-1 text-xs font-normal text-slate-500">incl. estimate</span>
                  )}
                </span>
                <span className="font-mono text-sm text-slate-400" data-testid="spend-rate">
                  {formatUsdPerHour(rate.costUsdPerHour)}
                </span>
              </>
            )}
          </div>

          <p className="text-[11px] text-slate-500" data-testid="spend-honesty">
            {tokensOnly
              ? 'Tokens only — no cost events yet. Dollars are notional on subscription plans anyway.'
              : 'Dollars are notional on subscription plans — the real signal here is efficiency and rate-limit budget.'}
          </p>

          <div>
            <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-slate-500">
              <span>Role split</span>
              <span data-testid="spend-overhead-ratio" className="text-neon-magenta">
                {formatCostOverhead(costOverhead)}
              </span>
            </div>
            <ul className="mt-1 grid grid-cols-3 gap-2">
              {AGENT_ROLES.map((role) => {
                const spend = roleSplit[role]
                return (
                  <li
                    key={role}
                    data-testid={`spend-role-${role}`}
                    className="rounded border border-void-line px-2 py-1"
                  >
                    <div className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-slate-400">
                      <span className={`h-1.5 w-1.5 rounded-full ${ROLE_DOT_CLASS[role]}`} />
                      {ROLE_LABEL[role]}
                    </div>
                    <div className="font-mono text-sm text-slate-200">
                      {formatTokens(spend.tokens.total)}
                    </div>
                    {tokensOnly ? null : (
                      <div className="font-mono text-xs text-slate-500">
                        {formatCostOrGap(spend)}
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          </div>

          <ul className="min-h-0 flex-1 space-y-1 overflow-auto">
            {lanes.map((lane) => (
              <li key={lane.lane} data-testid="spend-lane" className="text-xs">
                <div className="flex items-center justify-between text-slate-300">
                  <span className="truncate font-mono">{lane.lane}</span>
                  <span className="shrink-0 pl-2 font-mono text-slate-500">
                    {formatTokens(lane.tokens.total)}
                    {tokensOnly ? '' : ` · ${formatCostOrGap(lane)}`}
                  </span>
                </div>
                <div className="mt-0.5 h-1 rounded bg-void-line">
                  <div
                    className="h-1 rounded bg-neon-cyan/60"
                    style={{ width: `${(lane.tokens.total / maxLaneTokens) * 100}%` }}
                  />
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
