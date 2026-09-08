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
import { Disclosure, type DisclosureContent } from '../disclosure/index.js'
import {
  dollarsGapDisclosure,
  dollarsHoverDisclosure,
  formatDollarsOrGap,
  formatOverheadOrGap,
  isDollarsGap,
  isOverheadGap,
  outputHoverDisclosure,
  overheadHoverDisclosure,
} from '../panels/burn/format.js'
import {
  ageCellDisclosure,
  ageCellText,
  costCellDisclosure,
  costCellText,
  fenceCell,
  laneBranchDisclosure,
  laneIdentityDisclosure,
  outputCellDisclosure,
  outputCellText,
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
    <div data-testid="drawer-vitals" className="border-b border-(--line-hair) px-4 py-3">
      <div className={`flex items-center gap-2 ${RANK_TEXT_CLASS[lane.rank]}`}>
        <Sigil
          kind={sigilKind}
          size={SIGIL_ROW_SIZE}
          className={lane.rank === 'calm' ? '' : RANK_GLOW_CLASS[lane.rank]}
        />
        <span className="figures text-inst uppercase tracking-[0.18em]">{SIGIL_WORD[sigilKind]}</span>
        {lane.pathologies.length > 1 ? (
          <span className="figures text-inst-dense text-(--ink-dim)">+{lane.pathologies.length - 1} more</span>
        ) : null}
      </div>

      {/*
        The evidence string, never a bare label (graft g4). A calm lane still
        gets a line: "nothing wrong" is a claim, and a claim needs its evidence
        as much as an accusation does (ruling 14).
      */}
      <p data-testid="drawer-evidence" className="mt-1 font-mono text-inst leading-snug text-(--ink-dim)">
        {worst === null ? calmEvidence(lane) : evidenceLine(worst)}
      </p>

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-inst sm:grid-cols-3">
        <Vital label="output" value={outputCellText(lane)} disclosure={outputCellDisclosure(lane)} />
        <Vital
          label="$"
          value={costCellText(lane)}
          disclosure={costCellDisclosure(lane, fleet.gaps)}
          muted={lane.costEventCount === 0}
        />
        <Vital label="age" value={ageCellText(lane)} disclosure={ageCellDisclosure(lane)} muted={lane.ageMs === null} />
        <Vital
          label="branch"
          value={lane.branch ?? '—'}
          disclosure={laneBranchDisclosure(lane)}
          muted={lane.branch === null}
        />
        <Vital
          label="fence"
          value={fence.text}
          disclosure={fence.disclosure}
          muted={fence.kind === 'no-manifest' || fence.kind === 'unfenced'}
          alarm={fence.kind === 'breach'}
        />
        <Vital
          label="worktree"
          value={lane.worktreePath === null ? '—' : lane.present ? 'present' : 'folded'}
          disclosure={laneIdentityDisclosure(lane)}
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
    <div data-testid="drawer-main-vitals" className="border-b border-(--line-hair) px-4 py-3">
      <p data-testid="drawer-main-evidence" className="font-mono text-inst leading-snug text-(--ink-dim)">
        {mainEvidence(fleet)}
      </p>

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-inst sm:grid-cols-3">
        <Vital
          label="branch"
          value={root.mainBranch ?? '—'}
          disclosure={mainBranchDisclosure(root)}
          muted={root.mainBranch === null}
        />
        <Vital
          label="landings"
          value={String(root.landings)}
          disclosure={landingsDisclosure(root)}
          muted={root.landings === 0}
        />
        <Vital
          label="commits home"
          value={String(root.commitsHome)}
          disclosure={commitsHomeDisclosure(root)}
          muted={root.commitsHome === 0}
        />
        <Vital
          label="output"
          value={formatTokens(burn.outputTokens)}
          disclosure={outputHoverDisclosure(burn.tokens)}
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
          disclosure={dollarsGap ? dollarsGapDisclosure() : dollarsHoverDisclosure(burn)}
          muted={dollarsGap}
        />
        <Vital
          label="overhead"
          value={overheadGap ? '—' : formatOverheadOrGap(burn)}
          disclosure={overheadHoverDisclosure(burn)}
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

/**
 * MAIN's three vitals (#220). Local to this file because they are facts about
 * the root mass rather than about a lane, and nothing outside the drawer shows
 * them; `elapsedMs: 0` throughout, in core's own register for a fact re-read on
 * every fold (`selectors/condition.ts`) — these are counts the fleet recomputes
 * each tick, not observations with a "since".
 */
function mainBranchDisclosure(root: Fleet['root']): DisclosureContent {
  if (root.mainBranch === null) {
    return {
      label: 'branch',
      why: {
        reason: 'git never named a main branch for this repo',
        evidence: { fact: 'no default branch could be read from the watched repo', elapsedMs: 0 },
      },
      remedy: { kind: 'none', because: 'without a main branch there is nothing to count landings against — the cells below say so too' },
    }
  }
  return {
    label: 'branch',
    why: {
      reason: 'the branch lanes land onto',
      evidence: { fact: `git reported ${root.mainBranch}`, elapsedMs: 0 },
    },
    remedy: { kind: 'none', because: 'a branch name is a reading, not a condition' },
  }
}

function landingsDisclosure(root: Fleet['root']): DisclosureContent {
  return {
    label: 'landings',
    why: {
      reason: 'lanes that landed and folded this session',
      evidence: { fact: `${root.landings} worktree${root.landings === 1 ? ' has' : 's have'} gone away since the session opened`, elapsedMs: 0 },
    },
    remedy: { kind: 'none', because: 'a landing is finished work — the count is here to be read, not acted on' },
  }
}

function commitsHomeDisclosure(root: Fleet['root']): DisclosureContent {
  if (root.mainBranch === null) {
    return {
      label: 'commits home',
      why: {
        reason: 'no main branch — nothing to count commits against',
        evidence: { fact: 'git named no default branch for the watched repo', elapsedMs: 0 },
      },
      remedy: { kind: 'none', because: 'the count resolves itself as soon as the repo has a branch to land on' },
    }
  }
  return {
    label: 'commits home',
    why: {
      reason: 'work that has reached the branch everything lands on',
      evidence: { fact: `${root.commitsHome} commit${root.commitsHome === 1 ? '' : 's'} observed landing on ${root.mainBranch}`, elapsedMs: 0 },
    },
    remedy: { kind: 'none', because: 'a landed commit is finished work' },
  }
}

interface VitalProps {
  label: string
  value: string
  disclosure: DisclosureContent
  muted?: boolean
  alarm?: boolean
}

/**
 * One cell of the vitals grid — and, since #220, one disclosure.
 *
 * The card is on the `<dd>` rather than on the wrapping `<div>`: a definition
 * list's `<div>` may hold only `<dt>` and `<dd>`, so a trigger up there would
 * be invalid markup, and the mark a reader is asking about is the *value*
 * anyway, not the label naming it. The value keeps `truncate` — the card is
 * what the clipped text now opens into, which is the whole reason the native
 * `title=` was here.
 */
function Vital({ label, value, disclosure, muted = false, alarm = false }: VitalProps) {
  return (
    <div className="min-w-0">
      <dt className="text-inst-dense uppercase tracking-wider text-(--ink-dim)">{label}</dt>
      <dd
        className={`figures truncate ${alarm ? 'text-needs-you' : muted ? 'text-(--ink-dim)' : 'text-(--ink-body)'}`}
      >
        <Disclosure disclosure={disclosure} triggerLabel={`${label}, ${value}`}>
          {value}
        </Disclosure>
      </dd>
    </div>
  )
}
