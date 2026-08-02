import type { ReactNode } from 'react'
import { useFleet } from '../../fleet/index.js'
import { formatTokens } from '../../lib/format.js'
import {
  CONDUCTOR_NOT_INSTRUMENTED_GAP,
  COST_FEED_COMMAND,
  NO_COST_FEED_LEAD,
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
 * THE BURN STRIP (ruling 13) — four numbers, docked beside the attention strip:
 * output tokens (the headline, output-led per prd2), dollars (only when the cost
 * feed is authoritative), burn rate (out-tok/min, $/hr once dollars are
 * authoritative), overhead ratio (conductor OUTPUT ÷ worker OUTPUT). The spend
 * ticker panel dissolved into this and the ledger.
 *
 * Reads the one derived fleet object's `burn` for everything, including the
 * overhead gate — every number here is already computed once, upstream, so this
 * file only formats and never re-derives.
 *
 * **TWO REGISTERS, NOT ONE** (#117). What this looked like before was one flex
 * row of same-weight grey text, into which the gap voices were laid end to end
 * with the figures:
 *
 * > `BURN  2.3M OUT  NO COST FEED (OTel) — dollars unavailable — run: eval
 * > "$(observatory env <lane>)"  0 out-tok/min RATE  CONDUCTOR NOT
 * > INSTRUMENTED — overhead ratio unknowable`
 *
 * Three unrelated facts and two apology sentences, run together at one weight,
 * with the sentences taking three quarters of the bar. The honesty was right —
 * law 12 stays, and not one word of either sentence has been cut — but the
 * typography had abandoned it: a caveat set at the same size as the number it
 * qualifies does not read as a caveat, it reads as noise, and the figure it was
 * protecting is lost in it.
 *
 * So the strip has a hierarchy now, and it is only three decisions:
 *
 * - **the figures are the strip.** One row of them, mono and tabular, at the
 *   brightest ink on the bar, separated by hairlines rather than by whitespace
 *   so the row has a structure instead of a rhythm. Their units are dim, small
 *   and set apart, because a unit is a label and not a reading.
 * - **a missing figure keeps its seat.** An em dash where the number would be,
 *   so the row does not silently lose a column and the eye learns where each
 *   figure lives whether or not it exists today. That is also what makes the
 *   absence itself visible at a glance, which no amount of prose does.
 * - **the gap voices are a second line**, smaller and dimmer, under a hairline.
 *   Subordinate, and *present* — a disclosure would have been the compact
 *   option and would have hidden what law 12 exists to say. Each one still says
 *   WHAT is missing, WHY, and the command.
 *
 * The command is a `<code>` with `select-all` on it, so one click takes the
 * exact string and none of the sentence around it.
 */
export default function BurnStrip() {
  const { burn } = useFleet()

  const dollarsGap = isDollarsGap(burn)
  const overheadGap = isOverheadGap(burn)

  return (
    <div className="border-t border-ice-850 bg-ice-950" data-panel="burn">
      <div className="flex h-9 items-center gap-3 px-4 text-xs">
        <span className="shrink-0 text-[10px] font-medium uppercase tracking-[0.2em] text-ice-600">
          Burn
        </span>

        <Figure
          testId="burn-output-tokens"
          unit="out"
          title={outputHoverTitle(burn.tokens)}
          lead
        >
          {formatTokens(burn.outputTokens)}
        </Figure>

        <Rule />

        {/*
          The dollars cell. When the feed is missing the cell *moves* to the gap
          line below — the test id marks the cell wherever it is speaking, and
          what it says there is the whole sentence rather than a truncated
          version of it.
        */}
        {dollarsGap ? (
          <Missing unit="usd" title="no authoritative cost feed — see the gap below" />
        ) : (
          <Figure testId="burn-dollars" title={dollarsHoverTitle(burn)}>
            {formatDollarsOrGap(burn)}
          </Figure>
        )}

        <Rule />

        <Figure testId="burn-rate" unit="rate" title={burnRateHoverTitle(burn)}>
          {formatBurnRate(burn)}
        </Figure>

        <Rule />

        {overheadGap ? (
          <Missing unit="overhead" title="the conductor is not instrumented — see the gap below" />
        ) : (
          <Figure testId="burn-overhead" unit="overhead" title={overheadHoverTitle(burn)}>
            {formatOverheadOrGap(burn)}
          </Figure>
        )}
      </div>

      {dollarsGap || overheadGap ? (
        <div className="flex flex-col gap-0.5 border-t border-ice-900 px-4 pb-1.5 pt-1">
          {dollarsGap ? (
            <GapVoice>
              <span data-testid="burn-dollars">
                {NO_COST_FEED_LEAD}
                <code className="select-all font-mono text-ice-300">{COST_FEED_COMMAND}</code>
              </span>
            </GapVoice>
          ) : null}
          {overheadGap ? (
            <GapVoice>
              <span data-testid="burn-overhead">{formatOverheadOrGap(burn)}</span>
            </GapVoice>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

interface FigureProps {
  testId: string
  title: string
  /** The dim label after the number. A `$` figure is its own unit and takes none. */
  unit?: string
  /** The headline. One per strip: the output figure prd2 says leads. */
  lead?: boolean
  children: ReactNode
}

/**
 * One reading. Mono with tabular numerals (law 11) and the brightest ink on the
 * bar; the unit beside it is deliberately two steps down the ramp and outside
 * the test-id, so what a hover reports and what a test reads is the figure.
 */
function Figure({ testId, title, unit, lead, children }: FigureProps) {
  return (
    <span className="flex shrink-0 items-baseline gap-1">
      {/*
        The hover sits on the *figure*, not on the group around it: ruling 11's
        "full precision on hover" is a promise about the number, and a title on
        a wrapper would also fire over the unit label beside it.
      */}
      <span
        className={`figures ${lead === true ? 'text-sm text-ice-050' : 'text-[13px] text-ice-100'}`}
        data-testid={testId}
        title={title}
      >
        {children}
      </span>
      {unit === undefined ? null : <Unit>{unit}</Unit>}
    </span>
  )
}

/**
 * A reading that does not exist, holding its column.
 *
 * An em dash rather than a blank, and rather than closing the gap up: the row is
 * the same four columns whether or not today's fleet can fill them, so an
 * operator who knows where the dollars sit keeps knowing. Never `$0.00`, and
 * never nothing at all — the sentence underneath says which of the two this is.
 */
function Missing({ unit, title }: { unit: string; title: string }) {
  return (
    <span className="flex shrink-0 items-baseline gap-1" title={title}>
      <span className="figures text-[13px] text-ice-600" aria-hidden>
        —
      </span>
      <Unit>{unit}</Unit>
    </span>
  )
}

function Unit({ children }: { children: ReactNode }) {
  return (
    <span className="text-[10px] font-normal uppercase tracking-wide text-ice-600">{children}</span>
  )
}

/** A hairline between two readings. Structure, not decoration — see the header. */
function Rule() {
  return <span aria-hidden className="h-3.5 w-px shrink-0 bg-ice-850" />
}

/**
 * One gap voice: what is missing, why, and the command (law 12), set as the
 * subordinate register it is. `GAP` in front of it so the line is identifiable
 * as a class of statement rather than as a stray sentence.
 */
function GapVoice({ children }: { children: ReactNode }) {
  return (
    <p className="flex min-w-0 items-baseline gap-2 text-[10px] leading-snug text-ice-500">
      <span className="shrink-0 text-[9px] uppercase tracking-[0.18em] text-ice-700">Gap</span>
      {children}
    </p>
  )
}
