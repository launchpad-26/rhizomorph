import { Nav } from '../app/Nav.js'
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
/**
 * **The third arm is the durability case (prd-31 ruling 5, #556).** A lane
 * whose worktree is gone *and* whose events are in an earlier recording is not
 * in `buildFleet`'s output at all — there is no `Lane` to hand this header,
 * because the fold in front of the page never saw it. It still has an identity,
 * and it is exactly the identity a reader deep-linked to: a handle, an issue
 * number and a branch, out of the lane index. Fabricating a `Lane` to reuse the
 * first arm would mean inventing a rank, an activity and a state sigil for a
 * lane that has no live state to glyph — the same refusal `buildFleet` already
 * makes for the conductor.
 */
export type PageHeaderSubject =
  | { kind: 'lane'; lane: Lane }
  | { kind: 'conductor' }
  | { kind: 'run'; handle: string; issue: string | null; branch: string | null; outcome: string }

export interface PageHeaderProps {
  subject: PageHeaderSubject
  /** Esc and the "← balcony" link both call this — there is one way back. */
  onClose: () => void
}

export function PageHeader({ subject, onClose }: PageHeaderProps) {
  return (
    <>
      <Nav />
      <header
        data-testid="lane-page-header"
        className="flex shrink-0 items-center gap-4 border-b border-(--line-hair) bg-(--surface-panel) px-4 py-3"
      >
        <button
          type="button"
          data-testid="lane-page-back"
          onClick={onClose}
          className="shrink-0 rounded-none border border-(--line-strong) px-2 py-1 text-inst-dense uppercase tracking-wider text-(--ink-dim) transition-[color,border-color] duration-(--duration-touch) ease-out hover:border-(--ink-dim) hover:text-(--ink-primary)"
        >
          ← balcony
        </button>

        {subject.kind === 'conductor' ? (
          <ConductorIdentity />
        ) : subject.kind === 'run' ? (
          <RunIdentity handle={subject.handle} issue={subject.issue} outcome={subject.outcome} />
        ) : (
          <LaneIdentity lane={subject.lane} />
        )}

        <span
          data-testid="lane-page-role"
          className="shrink-0 text-inst uppercase tracking-wider text-(--ink-dim)"
          title="declared role"
        >
          {subject.kind === 'conductor' ? 'conductor' : subject.kind === 'run' ? 'worker' : subject.lane.role}
        </span>

        <span
          data-testid="lane-page-branch"
          className="min-w-0 truncate font-mono text-inst text-(--ink-dim)"
          title={
            subject.kind === 'conductor'
              ? 'no branch — the conductor runs the fleet, not a worktree of its own'
              : subject.kind === 'run'
                ? (subject.branch ?? 'no branch — no recording of this lane names one')
                : (subject.lane.branch ?? 'no branch — git never saw a worktree for this lane')
          }
        >
          {subject.kind === 'conductor'
            ? '—'
            : subject.kind === 'run'
              ? (subject.branch ?? '—')
              : (subject.lane.branch ?? '—')}
        </span>
      </header>
    </>
  )
}

function LaneIdentity({ lane }: { lane: Lane }) {
  const sigilKind = stateSigilKind(lane)
  const stateClass = lane.parked ? PARKED_TEXT_CLASS : stateTextClass(lane.rank, lane.activity)

  return (
    <>
      <h1 className="min-w-0 truncate font-mono text-read-body text-(--ink-primary)">
        {lane.label}
        {lane.issue === null ? null : (
          <span className="ml-1 text-inst text-(--ink-dim)">#{lane.issue}</span>
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
        <span className="figures text-inst uppercase tracking-wide">
          {lane.parked ? 'PARKED' : SIGIL_WORD[sigilKind]}
        </span>
      </span>
    </>
  )
}

/**
 * A lane read out of the index rather than out of the fold. No sigil, for the
 * conductor's own reason: it carries no live state, so drawing a state glyph
 * would be reporting a rank nothing measured. The outcome word carries the
 * reading instead, and `RunOutcomeRegion` below it carries the evidence.
 */
function RunIdentity({ handle, issue, outcome }: { handle: string; issue: string | null; outcome: string }) {
  return (
    <h1 className="min-w-0 truncate font-mono text-read-body text-(--ink-primary)">
      {handle}
      {issue === null ? null : <span className="ml-1 text-inst text-(--ink-dim)">#{issue}</span>}
      <span data-testid="lane-page-run-outcome" className="ml-2 text-inst uppercase tracking-wider text-(--ink-dim)">
        {outcome}
      </span>
    </h1>
  )
}

/**
 * The conductor has no rank, activity or pathology to glyph honestly (it
 * carries none of the fields a state sigil reads — see `LaneIdentity`), so
 * its identity here is its name, not a fabricated state mark.
 */
function ConductorIdentity() {
  return (
    <h1 className="min-w-0 truncate font-mono text-read-body text-(--ink-primary)">
      Main <span className="ml-1 text-inst italic text-(--ink-dim)">— the conductor</span>
    </h1>
  )
}
