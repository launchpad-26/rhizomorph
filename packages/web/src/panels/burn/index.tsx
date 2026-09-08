import type { ReactNode } from 'react'
import { useFleet } from '../../fleet/index.js'
import { formatTokens } from '../../lib/format.js'
import { Disclosure, type DisclosureContent } from '../../disclosure/index.js'
import {
  COST_FEED_COMMAND,
  NO_COST_FEED_LEAD,
  burnRateHoverDisclosure,
  dollarsGapDisclosure,
  dollarsHoverDisclosure,
  errorCount,
  errorsHoverDisclosure,
  formatBurnRate,
  formatDollarsOrGap,
  formatOverheadOrGap,
  isDollarsGap,
  isOverheadGap,
  outputHoverDisclosure,
  overheadHoverDisclosure,
} from './format.js'

/**
 * THE BURN STRIP (ruling 13) — five numbers, docked beside the attention strip:
 * output tokens (the headline, output-led per prd2), dollars (only when the cost
 * feed is authoritative), burn rate (out-tok/min, $/hr once dollars are
 * authoritative), overhead ratio (conductor OUTPUT ÷ worker OUTPUT), and —
 * #159, closing the dashboard-IA spike's golden-signal gap — one error count
 * (lanes blocked, lanes parked, lanes off-fence, summed). The spend ticker
 * panel dissolved into this and the ledger.
 *
 * The errors figure styles from the existing ladder tokens rather than a new
 * one (law 9a): calm ice at zero, `text-broken` once it isn't, because a
 * count of live problems is exactly what that hue already means everywhere
 * else in the instrument. Zero renders as a plain `0` — a calm zero, per
 * ruling 14's law restated for a number: never omitted, and never dressed up
 * as reassurance copy.
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
 * > "$(rhizomorph env <lane>)"  0 out-tok/min RATE  CONDUCTOR NOT
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
  const gapCount = (dollarsGap ? 1 : 0) + (overheadGap ? 1 : 0)

  return (
    <div className="flex flex-col gap-3" data-panel="burn">
      <div className="panel-card grid grid-cols-5 divide-x divide-(--line-hair)">
        <Cell label="Burn">
          <Figure testId="burn-output-tokens" unit="out" disclosure={outputHoverDisclosure(burn.tokens)}>
            {formatTokens(burn.outputTokens)}
          </Figure>
        </Cell>

        {/*
          The dollars cell. When the feed is missing the cell *moves* to the gap
          card below — the test id marks the cell wherever it is speaking, and
          what it says there is the whole sentence rather than a truncated
          version of it.
        */}
        <Cell label="Dollars">
          {dollarsGap ? (
            <Missing disclosure={dollarsGapDisclosure()} short="no cost feed" />
          ) : (
            <Figure testId="burn-dollars" disclosure={dollarsHoverDisclosure(burn)}>
              {formatDollarsOrGap(burn)}
            </Figure>
          )}
        </Cell>

        <Cell label="Rate">
          <Figure testId="burn-rate" disclosure={burnRateHoverDisclosure(burn)}>
            {formatBurnRate(burn)}
          </Figure>
        </Cell>

        <Cell label="Overhead">
          {overheadGap ? (
            <Missing disclosure={overheadHoverDisclosure(burn)} short="not instrumented" />
          ) : (
            <Figure testId="burn-overhead" unit="overhead" disclosure={overheadHoverDisclosure(burn)}>
              {formatOverheadOrGap(burn)}
            </Figure>
          )}
        </Cell>

        <Cell label="Errors">
          <Figure
            testId="burn-errors"
            unit="err"
            disclosure={errorsHoverDisclosure(burn)}
            alarm={errorCount(burn) > 0}
          >
            {errorCount(burn)}
          </Figure>
        </Cell>
      </div>

      {dollarsGap || overheadGap ? (
        <div className="panel-card flex flex-col gap-1.5 px-4 py-2.5 text-inst">
          <span className="heading shrink-0 text-needs-you">
            <span className="figures">{gapCount}</span> Gap{gapCount === 1 ? '' : 's'}
          </span>
          {dollarsGap ? (
            <GapVoice>
              <span data-testid="burn-dollars">
                {NO_COST_FEED_LEAD}
                <code className="code-chip select-all font-mono text-notice">{COST_FEED_COMMAND}</code>
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

/** One metric's own bordered cell: a dim label above, the reading below. */
function Cell({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <div className="flex flex-col gap-1.5 px-4 py-3">
      <span className="heading shrink-0 text-(--ink-dim)">{label}</span>
      {children}
    </div>
  )
}

interface FigureProps {
  testId: string
  disclosure: DisclosureContent
  /** The dim label after the number. A `$` figure is its own unit and takes none. */
  unit?: string
  /**
   * #159 — the errors figure's own ink once its count is non-zero: `text-broken`,
   * the one ladder hue law 9a permits for "something is dead/erroring", already
   * used everywhere else in the instrument for exactly this claim.
   */
  alarm?: boolean
  children: ReactNode
}

/**
 * One reading. Mono with tabular numerals (law 11), bold at the ramp's own
 * reading-body size (S1's guard against a new pixel literal stays intact —
 * the weight, not a bigger size, is what marks a filled cell now that each
 * cell's own label above it carries the hierarchy size used to). The unit
 * beside it sits at the legibility floor (`--ink-dim`, prd9) rather than the
 * figure's own brightness, and outside the test-id, so what a hover reports
 * and what a test reads is the figure.
 */
function Figure({ testId, disclosure, unit, alarm, children }: FigureProps) {
  const tone = alarm === true ? 'text-read-body font-bold text-broken' : 'text-read-body font-bold text-(--ink-primary)'
  return (
    <span className="flex shrink-0 items-baseline gap-1.5">
      {/*
        The disclosure sits on the *figure*, not on the group around it: ruling
        11's "full precision on hover" is a promise about the number, and a
        card on a wrapper would also open over the unit label beside it. That
        was true of the `title=` this replaces and it is true of the card —
        what changed (#220) is that the keyboard now reaches it.
      */}
      <span className={`figures ${tone}`} data-testid={testId}>
        <Disclosure disclosure={disclosure} triggerLabel={disclosure.label}>
          {children}
        </Disclosure>
      </span>
      {unit === undefined ? null : <Unit>{unit}</Unit>}
    </span>
  )
}

/**
 * A reading that does not exist, holding its column.
 *
 * An em dash rather than a blank, and rather than closing the gap up: the row is
 * the same five cells whether or not today's fleet can fill them, so an
 * operator who knows where the dollars sit keeps knowing. Never `$0.00`, and
 * never nothing at all — `short` names which kind of absence this is, in the
 * cell itself, and the gap card below gives the whole sentence.
 */
function Missing({ short, disclosure }: { short: string; disclosure: DisclosureContent }) {
  return (
    <span className="flex shrink-0 items-baseline gap-1.5">
      <Disclosure disclosure={disclosure} triggerLabel={short}>
        <span className="figures text-read-body font-bold text-(--ink-dim)" aria-hidden>
          —
        </span>
        <span className="text-read-floor text-(--ink-dim)">{short}</span>
      </Disclosure>
    </span>
  )
}

function Unit({ children }: { children: ReactNode }) {
  return (
    <span className="text-inst-dense font-normal uppercase tracking-wide text-(--ink-dim)">{children}</span>
  )
}

/**
 * One gap voice: what is missing, why, and the command (law 12), set as the
 * subordinate register it is. The card above already counts them, so a line
 * here is just the sentence — no repeated `GAP` prefix.
 */
function GapVoice({ children }: { children: ReactNode }) {
  return (
    <p className="flex min-w-0 items-baseline gap-2 text-read-floor leading-snug text-(--ink-dim)">
      {children}
    </p>
  )
}
