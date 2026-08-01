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
import { formatTokens } from '../lib/format.js'
import {
  dollarsHoverTitle,
  formatDollarsOrGap,
  formatOverheadOrGap,
  isDollarsGap,
  isOverheadGap,
  outputHoverTitle,
  overheadHoverTitle,
} from '../panels/burn/format.js'
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

/**
 * MAIN'S VITALS (prd6 ruling 5) — the root-mass, opened out.
 *
 * The same grid, the same cells, the same gap idiom as the lane's, because it
 * is the same drawer and an operator should not have to re-learn it for the
 * node in the middle. What changes is which facts fill it: main has no
 * pathology, no fence and no age — it has a branch, a count of what has landed
 * home, and the session's burn.
 *
 * **Every figure is imported, none is computed.** `root.landings` and
 * `root.commitsHome` are the derived fleet's own counts; the two burn cells are
 * the burn strip's own formatters, gaps included. A drawer that added up the
 * session's dollars itself is a drawer that can disagree with the strip four
 * inches to its left, and the point of the one derived fleet object is that
 * nothing on this page can.
 */
export interface MainVitalsProps {
  fleet: Fleet
}

export function MainVitals({ fleet }: MainVitalsProps) {
  const { root, burn } = fleet
  const dollarsGap = isDollarsGap(burn)
  const overheadGap = isOverheadGap(burn)

  return (
    <div data-testid="drawer-main-vitals" className="border-b border-ice-850 px-4 py-3">
      <p data-testid="drawer-main-evidence" className="font-mono text-[11px] leading-snug text-ice-400">
        {mainEvidence(fleet)}
      </p>

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11px] sm:grid-cols-3">
        <Vital
          label="branch"
          value={root.mainBranch ?? '—'}
          title={root.mainBranch ?? 'no main branch — git never named one for this repo'}
          muted={root.mainBranch === null}
        />
        <Vital
          label="landings"
          value={String(root.landings)}
          title="worktrees that have gone away this session — lanes that landed and folded"
          muted={root.landings === 0}
        />
        <Vital
          label="commits home"
          value={String(root.commitsHome)}
          title={
            root.mainBranch === null
              ? 'no main branch — nothing to count commits against'
              : `commits observed landing on ${root.mainBranch}`
          }
          muted={root.commitsHome === 0}
        />
        <Vital
          label="output"
          value={formatTokens(burn.outputTokens)}
          title={outputHoverTitle(burn.tokens)}
        />
        {/*
          Dollars and overhead keep the table's gap idiom — an em dash with the
          reason on it — rather than the burn strip's full sentence, which is
          written for a strip four columns wide and would fill this cell with a
          truncation. The sentence is still the *same* sentence, straight from
          the same formatter, so the two surfaces cannot drift apart.
        */}
        <Vital
          label="$"
          value={dollarsGap ? '—' : formatDollarsOrGap(burn)}
          title={dollarsGap ? formatDollarsOrGap(burn) : dollarsHoverTitle(burn)}
          muted={dollarsGap}
        />
        <Vital
          label="overhead"
          value={overheadGap ? '—' : formatOverheadOrGap(burn)}
          title={overheadGap ? formatOverheadOrGap(burn) : overheadHoverTitle(burn)}
          muted={overheadGap}
        />
      </dl>
    </div>
  )
}

/**
 * Main's evidence line, in the voice a lane's gets: what the root-mass has been
 * doing, from facts the fold recorded. The conductor's own output leads it
 * because that is what lights the mass in the scene — and when nobody
 * instrumented the conductor it says *that*, rather than reporting zero tokens
 * as if the orchestrator had been idle.
 */
function mainEvidence(fleet: Fleet): string {
  const { root, burn, lanes } = fleet
  const living = lanes.filter((lane) => lane.present).length
  const fleetSide = `${living} lane${living === 1 ? '' : 's'} out, ${root.landings} landed`

  return burn.conductorInstrumented
    ? `${formatTokens(root.conductorOutputTokens)} out from the conductor — ${fleetSide}`
    : `conductor not instrumented — its burn is unknown, not zero — ${fleetSide}`
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
