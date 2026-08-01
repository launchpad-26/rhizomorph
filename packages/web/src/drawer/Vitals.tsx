import {
  RANK_GLOW_CLASS,
  RANK_TEXT_CLASS,
  SIGIL_ROW_SIZE,
  SIGIL_WORD,
  Sigil,
  evidenceLine,
  formatSpan,
  type Fleet,
  type Lane,
} from '../fleet/index.js'
import {
  ageCellText,
  ageCellTitle,
  costCellText,
  costCellTitle,
  fenceCell,
  outputCellText,
  outputCellTitle,
  stateSigilKind,
  worstPathology,
} from '../panels/fleet/format.js'

/**
 * THE VITALS HEADER (ruling 17) — the lane's row from the fleet table, opened
 * out.
 *
 * The cell logic is **imported from the fleet table**, not re-written here.
 * That is the point: a drawer that computed its own `$` cell is a drawer that
 * can disagree with the row the operator just clicked, and "the table said one
 * thing and the drawer said another" is the exact failure the one derived fleet
 * object exists to prevent. The gap-honest rules (law 12) therefore hold here
 * for free — a lane with no cost feed reads `—` with the gap line on it, in the
 * drawer for the same reason and by the same code as in the table.
 *
 * The state glyph is the scene's own mark at row scale (graft g1), and alarm
 * marks never fade (graft g2) because the hue comes from the rank and the rank
 * is not something this component decides.
 */

export interface VitalsProps {
  lane: Lane
  fleet: Fleet
}

export function Vitals({ lane, fleet }: VitalsProps) {
  const sigilKind = stateSigilKind(lane)
  const worst = worstPathology(lane)
  const fence = fenceCell(lane, fleet)

  return (
    <div data-testid="drawer-vitals" className="border-b border-ice-850 px-4 py-3">
      <div className={`flex items-center gap-2 ${RANK_TEXT_CLASS[lane.rank]}`}>
        <Sigil
          kind={sigilKind}
          size={SIGIL_ROW_SIZE}
          className={lane.rank === 'calm' ? '' : RANK_GLOW_CLASS[lane.rank]}
        />
        <span className="figures text-xs uppercase tracking-[0.18em]">{SIGIL_WORD[sigilKind]}</span>
        {lane.pathologies.length > 1 ? (
          <span className="figures text-[10px] text-ice-500">+{lane.pathologies.length - 1} more</span>
        ) : null}
      </div>

      {/*
        The evidence string, never a bare label (graft g4). A calm lane still
        gets a line: "nothing wrong" is a claim, and a claim needs its evidence
        as much as an accusation does (ruling 14).
      */}
      <p data-testid="drawer-evidence" className="mt-1 font-mono text-[11px] leading-snug text-ice-400">
        {worst === null ? calmEvidence(lane) : evidenceLine(worst)}
      </p>

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11px] sm:grid-cols-3">
        <Vital label="output" value={outputCellText(lane)} title={outputCellTitle(lane)} />
        <Vital
          label="$"
          value={costCellText(lane)}
          title={costCellTitle(lane, fleet.gaps)}
          muted={lane.costEventCount === 0}
        />
        <Vital label="age" value={ageCellText(lane)} title={ageCellTitle(lane)} muted={lane.ageMs === null} />
        <Vital
          label="branch"
          value={lane.branch ?? '—'}
          title={lane.branch ?? 'no branch — git never saw a worktree for this lane'}
          muted={lane.branch === null}
        />
        <Vital
          label="fence"
          value={fence.text}
          title={fence.title}
          muted={fence.kind === 'no-manifest' || fence.kind === 'unfenced'}
          alarm={fence.kind === 'breach'}
        />
        <Vital
          label="worktree"
          value={lane.worktreePath === null ? '—' : lane.present ? 'present' : 'folded'}
          title={lane.worktreePath ?? 'no worktree path recorded for this lane'}
          muted={!lane.present}
        />
      </dl>
    </div>
  )
}

/** What a calm lane's evidence line says, in the same voice a pathology's does. */
function calmEvidence(lane: Lane): string {
  const age = lane.workAgeMs === null ? 'no work signal yet' : `last work ${formatSpan(lane.workAgeMs)} ago`
  return `${lane.activity} — ${lane.requestCount} req, ${lane.toolCallCount} tool calls, ${age}`
}

interface VitalProps {
  label: string
  value: string
  title: string
  muted?: boolean
  alarm?: boolean
}

function Vital({ label, value, title, muted = false, alarm = false }: VitalProps) {
  return (
    <div className="min-w-0" title={title}>
      <dt className="text-[10px] uppercase tracking-wider text-ice-500">{label}</dt>
      <dd
        className={`figures truncate ${alarm ? 'text-needs-you' : muted ? 'text-ice-600' : 'text-ice-200'}`}
      >
        {value}
      </dd>
    </div>
  )
}
