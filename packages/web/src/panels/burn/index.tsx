import { useMemo } from 'react'
import { selectRoleSpend } from '@observatory/core'
import { useStream } from '../../app/StreamContext.js'
import { useFleet } from '../../fleet/index.js'
import { formatTokens } from '../../lib/format.js'
import {
  burnRateHoverTitle,
  dollarsHoverTitle,
  formatBurnRate,
  formatDollarsOrGap,
  formatOverheadOrGap,
  isDollarsGap,
  isOverheadGap,
  outputHoverTitle,
  overheadHoverTitle,
} from './format.js'

/**
 * THE BURN STRIP (ruling 13) — four numbers, no chrome, docked beside the
 * attention strip: output tokens (the headline, output-led per prd2), dollars
 * (only when the cost feed is authoritative), burn rate (out-tok/min, $/hr
 * once dollars are authoritative), overhead ratio (conductor OUTPUT ÷ worker
 * OUTPUT). The spend ticker panel dissolved into this and the ledger.
 *
 * Reads the one derived fleet object's `burn` for everything except the
 * overhead gate — every other number here is already computed once,
 * upstream, so this file only formats and never re-derives.
 */
export default function BurnStrip() {
  const { burn } = useFleet()
  const { state } = useStream()

  /**
   * `fleet.burn.conductorInstrumented` (`packages/web/src/fleet/buildFleet.ts`)
   * comes from a role split deliberately filtered to the token-origin
   * allowlist — the right call for the ratio's own tokens, so a request both
   * collectors saw isn't double-counted — but that filter collaterally drops
   * every cost event too, and the only collector that ever emits `llm.cost`
   * is otel, never sessionlog. That makes the field read "not instrumented"
   * for every conductor that is, in fact, correctly wired. Re-deriving the
   * same check unfiltered, straight off core's own selector, is what keeps
   * the overhead ratio from going dark on every real setup.
   */
  const conductorInstrumented = useMemo(
    () => selectRoleSpend(state.session).conductor.costEventCount > 0,
    [state.session],
  )
  const overhead = { conductorInstrumented, overheadRatio: burn.overheadRatio }

  const dollarsGap = isDollarsGap(burn)
  const overheadGap = isOverheadGap(overhead)

  return (
    <div
      className="flex h-9 items-center gap-4 border-t border-ice-850 bg-ice-950 px-4 text-xs"
      data-panel="burn"
    >
      <span className="shrink-0 font-medium uppercase tracking-[0.2em] text-ice-600">Burn</span>

      <span
        className="figures shrink-0 text-sm text-ice-100"
        data-testid="burn-output-tokens"
        title={outputHoverTitle(burn.tokens)}
      >
        {formatTokens(burn.outputTokens)}
        <span className="ml-1 text-[10px] font-normal uppercase tracking-wide text-ice-500">
          out
        </span>
      </span>

      <span
        className={
          dollarsGap
            ? 'min-w-0 truncate text-ice-400'
            : 'figures shrink-0 text-sm text-ice-200'
        }
        data-testid="burn-dollars"
        title={dollarsGap ? undefined : dollarsHoverTitle(burn)}
      >
        {formatDollarsOrGap(burn)}
      </span>

      <span
        className="figures shrink-0 text-ice-300"
        data-testid="burn-rate"
        title={burnRateHoverTitle(burn)}
      >
        {formatBurnRate(burn)}
        <span className="ml-1 text-[10px] font-normal uppercase tracking-wide text-ice-500">
          rate
        </span>
      </span>

      <span
        className={
          overheadGap
            ? 'min-w-0 truncate text-ice-400'
            : 'figures shrink-0 text-ice-300'
        }
        data-testid="burn-overhead"
        title={overheadGap ? undefined : overheadHoverTitle(overhead)}
      >
        {formatOverheadOrGap(overhead)}
        {overheadGap ? null : (
          <span className="ml-1 text-[10px] font-normal uppercase tracking-wide text-ice-500">
            overhead
          </span>
        )}
      </span>
    </div>
  )
}
