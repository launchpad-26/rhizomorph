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
 *
 * **The conductor (#138) is not a `Lane`** — `buildFleet` deliberately never
 * claims its spend into one (`fleet/selection.tsx`'s own note on why MAIN is
 * a pseudo-lane, never a fabricated `Lane`). So this header takes a `subject`
 * union rather than a bare `Lane`: the conductor branch names what it is —
 * "Main", "the conductor", the role text — and says "no branch" honestly
 * rather than reaching for the repo's own main branch, which is not a branch
 * the conductor itself runs on.
 */
export type PageHeaderSubject = { kind: 'lane'; lane: Lane } | { kind: 'conductor' }

export interface PageHeaderProps {
  subject: PageHeaderSubject
  /** Esc and the "← balcony" link both call this — there is one way back. */
  onClose: () => void
}

export function PageHeader({ subject, onClose }: PageHeaderProps) {
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

      {subject.kind === 'conductor' ? <ConductorIdentity /> : <LaneIdentity lane={subject.lane} />}

      <span
        data-testid="lane-page-role"
        className="shrink-0 text-[11px] uppercase tracking-wider text-ice-400"
        title="declared role"
      >
        {subject.kind === 'conductor' ? 'conductor' : subject.lane.role}
      </span>

      <span
        data-testid="lane-page-branch"
        className="min-w-0 truncate font-mono text-[11px] text-ice-400"
        title={
          subject.kind === 'conductor'
            ? 'no branch — the conductor runs the fleet, not a worktree of its own'
            : (subject.lane.branch ?? 'no branch — git never saw a worktree for this lane')
        }
      >
        {subject.kind === 'conductor' ? '—' : (subject.lane.branch ?? '—')}
      </span>
    </header>
  )
}

function LaneIdentity({ lane }: { lane: Lane }) {
  const sigilKind = stateSigilKind(lane)
  const stateClass = lane.parked ? PARKED_TEXT_CLASS : stateTextClass(lane.rank, lane.activity)

  return (
    <>
      <h1 className="min-w-0 truncate font-mono text-sm text-ice-100">
        {lane.label}
        {lane.issue === null ? null : (
          <span className="ml-1 text-[11px] text-ice-400">#{lane.issue}</span>
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
    </>
  )
}

/**
 * The conductor has no rank, activity or pathology to glyph honestly (it
 * carries none of the fields a state sigil reads — see `LaneIdentity`), so
 * its identity here is its name, not a fabricated state mark.
 */
function ConductorIdentity() {
  return (
    <h1 className="min-w-0 truncate font-mono text-sm text-ice-100">
      Main <span className="ml-1 text-[11px] italic text-ice-400">— the conductor</span>
    </h1>
  )
}
