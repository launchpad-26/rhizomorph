import { useMemo, type CSSProperties, type ReactElement } from 'react'
import type { RhizomorphEvent } from '@rhizomorph/core'
import { bandsFor, type Band, type BandState, type LaneBands } from './bands.js'
import { coalesce } from './coalesce.js'
import { rowPlan, type MoreRow, type RowDescriptor } from './rowPlan.js'
import { hoverThresholdMs, timeScale, type TimeScale } from './scale.js'
import { layoutBands, type LaidBand } from './layout.js'
import { labelFits } from './label.js'
import { formatDuration, formatRange } from './duration.js'

/**
 * THE TIDE'S BODY (prd13 wave 2, issue #168) — the swim-lane the replay bar
 * grows around in wave 3. Every fact this component draws comes from #167's
 * three pure functions ({@link bandsFor}, {@link coalesce}, {@link rowPlan});
 * this file's own job is exactly one thing neither of them does — turning a
 * timestamp into a pixel (`scale.ts`) — plus the DOM around it. Nothing here
 * walks the event log for a fact those three do not already compute.
 *
 * **Collapsed vs expanded (ruling 4) is a row-count decision, not a second
 * rendering path.** Collapsed mode calls `rowPlan(lanes, 0)`: with more than
 * one lane that always yields exactly one {@link MoreRow} — "one merged
 * density band" falls out of `rowPlan`'s own "+N" law rather than a new one
 * invented here. Expanded mode calls it with a real budget, so most lanes get
 * their own row and only the true remainder folds into that same `MoreRow`.
 * One row renderer ({@link MoreRowView}) serves both.
 *
 * **Why the `MoreRow` renders as one flat bar and not a mini timeline**:
 * `rowPlan`'s `MoreRow` carries a count and a lane list, never band data —
 * that is `rowPlan`'s own contract, not an omission. Inventing a per-instant
 * "what is this fold of lanes doing right now" reading (picking a winning
 * state, or unioning coverage across lanes) is a fact none of #167's
 * selectors computes, and manufacturing one here is exactly what "compute
 * nothing yourself" forbids. The bar spans the folded lanes' own observed
 * window (`min(firstSeenTs)` … `max(lastSeenTs)`, plain arithmetic over facts
 * `rowPlan` already handed back) and says only what is true: this many lanes,
 * over this span, in less room than they need.
 *
 * **Row height is mode-dependent, not a new law (issue #186 defect 4)** —
 * ruling 2's "two modes" finishing the thought: `TideDock` passes a taller
 * `rowHeight` in replay (the dock is the primary control there, so it earns
 * more room) and leaves it at the original {@link ROW_HEIGHT_PX} in live
 * (the compact strip it has always been). This file has no opinion about
 * *which* height is "tall" — it only ever draws whatever height it is given.
 *
 * **Why there is no `parked` fill yet**, despite the direction naming it:
 * `bands.ts` is explicit that parked is "an operator declaration … read from
 * the manifest and never from the log … No event attests it, so no band
 * can" — it is a fact about a `Lane`, not about a `LaneBands`, and #167
 * exposes no selector that joins the two. Wiring a `parked` prop in now would
 * mean guessing at a shape wave 3's real docking (against the fleet's actual
 * `Lane[]`) might not match. The three ladder hues `bandsFor` can actually
 * attest — `working`, `waiting`, `done` — plus the honest gap hatch are what
 * this wave draws; parked is wave 3's to thread through once the dock exists.
 */

export const ROW_HEIGHT_PX = 14
export const DEFAULT_TOP_N = 8

export type TideMode = 'collapsed' | 'expanded'

export interface TideProps {
  /** The raw log. `bandsFor` is the only thing in this file allowed to fold it. */
  events: readonly RhizomorphEvent[]
  /** The mapped window — session-to-now in live (ruling 2), a fixed range in replay. */
  start: number
  end: number
  /** The bar's pixel width. Every band's pixels come from `timeScale(start, end, width)`. */
  width: number
  mode: TideMode
  /** Lane rows before the remainder folds (ignored — forced to 0 — in collapsed mode). */
  topN?: number
  /** Mode-dependent room (issue #186 defect 4) — replay breathes, live stays the compact strip it always was. Defaults to the original `ROW_HEIGHT_PX`. */
  rowHeight?: number
}

export function Tide({
  events,
  start,
  end,
  width,
  mode,
  topN = DEFAULT_TOP_N,
  rowHeight = ROW_HEIGHT_PX,
}: TideProps): ReactElement {
  const scale = useMemo(() => timeScale(start, end, width), [start, end, width])
  const laneBands = useMemo(() => bandsFor(events), [events])
  const minSpanMs = useMemo(() => hoverThresholdMs(scale), [scale])

  const byLane = useMemo(() => {
    const map = new Map<string, LaneBands>()
    for (const lb of laneBands) map.set(lb.lane, lb)
    return map
  }, [laneBands])

  const rows = useMemo(
    () =>
      rowPlan(
        laneBands.map((lb) => ({ lane: lb.lane, firstSeenTs: lb.firstSeenTs })),
        mode === 'collapsed' ? 0 : topN,
      ),
    [laneBands, mode, topN],
  )

  return (
    <div data-testid="tide" data-mode={mode} role="img" aria-label="lane activity timeline" style={{ width }}>
      {rows.map((row) => (
        <RowView key={rowKey(row)} row={row} byLane={byLane} scale={scale} minSpanMs={minSpanMs} rowHeight={rowHeight} />
      ))}
    </div>
  )
}

function rowKey(row: RowDescriptor): string {
  return row.kind === 'lane' ? row.lane : 'more'
}

function RowView({
  row,
  byLane,
  scale,
  minSpanMs,
  rowHeight,
}: {
  row: RowDescriptor
  byLane: ReadonlyMap<string, LaneBands>
  scale: TimeScale
  minSpanMs: number
  rowHeight: number
}): ReactElement {
  if (row.kind === 'more') return <MoreRowView row={row} byLane={byLane} scale={scale} rowHeight={rowHeight} />

  const lane = byLane.get(row.lane)
  const bands = lane === undefined ? [] : coalesce(lane.bands, minSpanMs)

  return (
    <div
      data-testid="tide-row"
      data-row-kind="lane"
      data-lane={row.lane}
      aria-label={`${row.lane} activity`}
      className="relative"
      style={{ height: rowHeight, width: scale.width }}
    >
      {layoutBands(bands, scale).map((entry, index) => (
        <BandView key={index} entry={entry} lane={row.lane} scale={scale} rowHeight={rowHeight} />
      ))}
    </div>
  )
}

const STATE_WORD: Record<BandState, string> = {
  working: 'WORKING',
  waiting: 'WAITING',
  done: 'DONE',
}

/** The four ladder hues #167 can actually attest, drawn from the existing activity-state tokens (prd4 law 9a/9b) — no new hex values. */
const STATE_FILL_CLASS: Record<BandState, string> = {
  working: 'bg-working',
  waiting: 'bg-waiting-benign',
  done: 'bg-done',
}

/**
 * `text-shadow` halo rather than a dim ink class: the label must stay legible
 * over any of the three fills above, and the legibility floor (prd9 / #136)
 * forbids reaching for a `text-ice-*` step dimmer than `ice-400` to do it —
 * the halo keeps the label bright (`text-ice-050`, well above the floor)
 * while still reading over a light fill.
 */
const LABEL_HALO_STYLE: CSSProperties = {
  textShadow: '0 0 3px var(--color-ice-1000), 0 1px 2px var(--color-ice-1000)',
}

function BandView({
  entry,
  lane,
  scale,
  rowHeight,
}: {
  entry: LaidBand
  lane: string
  scale: TimeScale
  rowHeight: number
}): ReactElement {
  const { band, x, width } = entry
  const title = bandTitle(band, lane)

  if (band.kind === 'gap') {
    return (
      <div
        data-testid="tide-band"
        data-band-kind="gap"
        className="tide-band-gap absolute top-0"
        style={{ left: x, width, height: rowHeight, ...GAP_HATCH_STYLE }}
        title={title}
      />
    )
  }

  const word = STATE_WORD[band.state]
  const showLabel = labelFits(width, word)

  return (
    <div
      data-testid="tide-band"
      data-band-kind="state"
      data-state={band.state}
      className={`absolute top-0 flex items-center overflow-hidden ${STATE_FILL_CLASS[band.state]}`}
      style={{ left: x, width, height: rowHeight }}
      title={title}
    >
      {showLabel ? (
        <span className="px-1 text-[9px] font-medium uppercase tracking-wide text-ice-050" style={LABEL_HALO_STYLE}>
          {word}
        </span>
      ) : null}
    </div>
  )
}

/**
 * The honest hatch (prd13 ruling 8) — a pattern, not a fill, so it survives
 * greyscale and cannot be mistaken for a state even at a glance. Composed
 * from existing ice tokens via `var()` rather than a new hex, same as every
 * `glow-*` utility in `theme.css` already does.
 */
const GAP_HATCH_STYLE: CSSProperties = {
  backgroundColor: 'var(--color-ice-900)',
  backgroundImage:
    'repeating-linear-gradient(135deg, var(--color-ice-600) 0px, var(--color-ice-600) 2px, transparent 2px, transparent 7px)',
}

function bandTitle(band: Band, lane: string): string {
  const range = formatRange(band.startTs, band.endTs)
  const state = band.kind === 'gap' ? 'NO DATA' : STATE_WORD[band.state]
  return `${range} · ${lane} · ${state} · Duration ${formatDuration(band.durationMs)}`
}

/**
 * The chip's own gutter width (issue #189 defect 2: "must not overprint the
 * band's fills"). Pinned to the row's leading edge regardless of where the
 * coalesced band itself lands, so the count is never the text an operator
 * has to go find sitting inside — and never on top of — a colour fill.
 */
const MORE_CHIP_WIDTH_PX = 28

function MoreRowView({
  row,
  byLane,
  scale,
  rowHeight,
}: {
  row: MoreRow
  byLane: ReadonlyMap<string, LaneBands>
  scale: TimeScale
  rowHeight: number
}): ReactElement {
  const bounds = moreRowBounds(row, byLane, scale)
  const x = scale.xOf(bounds.firstSeenTs)
  const width = Math.max(0, scale.xOf(bounds.lastSeenTs) - x)
  const label = `+${row.count}`
  const showLabel = labelFits(scale.width, label)
  const title = `${formatRange(bounds.firstSeenTs, bounds.lastSeenTs)} · ${row.count} lanes · Duration ${formatDuration(bounds.lastSeenTs - bounds.firstSeenTs)}`

  return (
    <div
      data-testid="tide-row"
      data-row-kind="more"
      aria-label={`${row.count} more lanes`}
      className="relative"
      style={{ height: rowHeight, width: scale.width }}
      title={title}
    >
      <div
        data-testid="tide-band"
        data-band-kind="more"
        className="tide-band-more absolute top-0 overflow-hidden bg-ice-600"
        style={{ left: x, width, height: rowHeight }}
      />
      {showLabel ? (
        <span
          data-testid="tide-more-chip"
          className="figures pointer-events-none absolute left-0 top-0 flex items-center bg-ice-950 px-1 text-[9px] font-medium tracking-wide text-ice-050"
          style={{ height: rowHeight, minWidth: MORE_CHIP_WIDTH_PX }}
        >
          {label}
        </span>
      ) : null}
    </div>
  )
}

function moreRowBounds(
  row: MoreRow,
  byLane: ReadonlyMap<string, LaneBands>,
  scale: TimeScale,
): { firstSeenTs: number; lastSeenTs: number } {
  let firstSeenTs: number | null = null
  let lastSeenTs: number | null = null
  for (const lane of row.lanes) {
    const lb = byLane.get(lane)
    if (lb === undefined) continue
    firstSeenTs = firstSeenTs === null ? lb.firstSeenTs : Math.min(firstSeenTs, lb.firstSeenTs)
    lastSeenTs = lastSeenTs === null ? lb.lastSeenTs : Math.max(lastSeenTs, lb.lastSeenTs)
  }
  return { firstSeenTs: firstSeenTs ?? scale.start, lastSeenTs: lastSeenTs ?? scale.end }
}
