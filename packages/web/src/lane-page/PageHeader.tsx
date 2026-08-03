import {
  RANK_GLOW_CLASS,
  Sigil,
  SIGIL_ROW_SIZE,
  SIGIL_WORD,
  stateTextClass,
  type Lane,
} from '../fleet/index.js'
import { PARKED_TEXT_CLASS, stateSigilKind, stateTitle } from '../panels/fleet/format.js'

/**
 * THE LANE PAGE'S HEADER (prd9 B1b) — handle, role, state glyph and branch,
 * read straight off the derived fleet the fleet table reads (#135's own
 * ruling: "from the same derived objects the fleet table reads — one object,
 * never re-derive"). The glyph logic is the fleet table's own cell code
 * (`panels/fleet/format.js`'s `stateSigilKind`/`stateTitle`), imported rather
 * than repeated, for the same reason the drawer's `Vitals` imports it: a page
 * that computed its own state glyph could disagree with the row an operator
 * clicked to get here.
 */
export interface PageHeaderProps {
  lane: Lane
  /** Esc and the "← balcony" link both call this — there is one way back. */
  onClose: () => void
}

export function PageHeader({ lane, onClose }: PageHeaderProps) {
  const sigilKind = stateSigilKind(lane)
  const stateClass = lane.parked ? PARKED_TEXT_CLASS : stateTextClass(lane.rank, lane.activity)

  return (
    <header
      data-testid="lane-page-header"
      className="flex shrink-0 items-center gap-4 border-b border-ice-850 bg-ice-950 px-4 py-3"
    >
      <button
        type="button"
        data-testid="lane-page-back"
        onClick={onClose}
        className="shrink-0 rounded border border-ice-800 px-2 py-1 text-[10px] uppercase tracking-wider text-ice-400 transition-[color,border-color] duration-150 ease-out hover:border-ice-600 hover:text-ice-100"
      >
        ← balcony
      </button>

      <h1 className="min-w-0 truncate font-mono text-sm text-ice-100">
        {lane.label}
        {lane.issue === null ? null : (
          <span className="ml-1 text-[11px] text-ice-500">#{lane.issue}</span>
        )}
      </h1>

      <span
        className={`inline-flex shrink-0 items-center gap-1 ${stateClass}`}
        title={stateTitle(lane)}
      >
        {lane.parked ? null : (
          <Sigil
            kind={sigilKind}
            size={SIGIL_ROW_SIZE}
            className={lane.rank === 'calm' ? '' : RANK_GLOW_CLASS[lane.rank]}
          />
        )}
        <span className="figures text-[11px] uppercase tracking-wide">
          {lane.parked ? 'PARKED' : SIGIL_WORD[sigilKind]}
        </span>
      </span>

      <span
        data-testid="lane-page-role"
        className="shrink-0 text-[11px] uppercase tracking-wider text-ice-500"
        title="declared role"
      >
        {lane.role}
      </span>

      <span
        data-testid="lane-page-branch"
        className="min-w-0 truncate font-mono text-[11px] text-ice-400"
        title={lane.branch ?? 'no branch — git never saw a worktree for this lane'}
      >
        {lane.branch ?? '—'}
      </span>
    </header>
  )
}
