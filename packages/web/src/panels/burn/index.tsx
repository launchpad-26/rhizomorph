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
 * Reads the one derived fleet object's `burn` for everything, including the
 * overhead gate — every number here is already computed once, upstream, so
 * this file only formats and never re-derives.
 */
export default function BurnStrip() {
  const { burn } = useFleet()

  const dollarsGap = isDollarsGap(burn)
  const overheadGap = isOverheadGap(burn)

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
        title={overheadGap ? undefined : overheadHoverTitle(burn)}
      >
        {formatOverheadOrGap(burn)}
        {overheadGap ? null : (
          <span className="ml-1 text-[10px] font-normal uppercase tracking-wide text-ice-500">
            overhead
          </span>
        )}
      </span>
    </div>
  )
}
