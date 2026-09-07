import { useModeClock } from '../app/ModeContext.js'
import { Nav } from '../app/Nav.js'
import { Disclosure, type DisclosureContent } from '../disclosure/index.js'
import {
  RANK_GLOW_CLASS,
  Sigil,
  SIGIL_ROW_SIZE,
  SIGIL_WORD,
  stateTextClass,
  type Lane,
} from '../fleet/index.js'
import { PARKED_TEXT_CLASS, stateSigilKind, stateDisclosure } from '../panels/fleet/format.js'

/**
 * THE LANE PAGE'S HEADER (prd9 B1b) — handle, role, state glyph and branch,
 * read straight off the derived fleet the fleet table reads (#135's own
 * ruling: "from the same derived objects the fleet table reads — one object,
 * never re-derive"). The glyph logic is the fleet table's own cell code
 * (`panels/fleet/format.js`'s `stateSigilKind`/`stateDisclosure`), imported rather
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
          aria-label="declared role"
        >
          {subject.kind === 'conductor' ? 'conductor' : subject.kind === 'run' ? 'worker' : subject.lane.role}
        </span>

        <span
          data-testid="lane-page-branch"
          className="min-w-0 truncate font-mono text-inst text-(--ink-dim)"
        >
          <Disclosure disclosure={headerBranchDisclosure(subject)} triggerLabel="branch">
            {subject.kind === 'conductor'
              ? '—'
              : subject.kind === 'run'
                ? (subject.branch ?? '—')
                : (subject.lane.branch ?? '—')}
          </Disclosure>
        </span>
      </header>
    </>
  )
}

function LaneIdentity({ lane }: { lane: Lane }) {
  // The fold's own reading position, not `Date.now()` — the same clock the
  // ledger reads, so an elapsed time on this page means the same thing in
  // replay as it does live (`disclosure/vocabulary.ts`'s clock rule).
  const now = useModeClock()
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

      <span className={`inline-flex shrink-0 items-center gap-1 ${stateClass}`}>
        <Disclosure disclosure={stateDisclosure(lane, now)} triggerLabel={`${lane.label}, state`}>
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
        </Disclosure>
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

/**
 * The header's BRANCH mark (#220). Three subjects, three honest absences —
 * the conductor has no worktree by design, a run is read out of a recording
 * that may not name one, and a lane's branch is whatever git last saw.
 *
 * `elapsedMs: 0` because each of these is re-read from the fold on every tick
 * rather than dated to an observation (`selectors/condition.ts`'s own rule).
 */
function headerBranchDisclosure(subject: PageHeaderSubject): DisclosureContent {
  if (subject.kind === 'conductor') {
    return {
      label: 'branch',
      why: {
        reason: 'the conductor runs the fleet, not a worktree of its own',
        evidence: { fact: 'no branch is expected here, and none is shown', elapsedMs: 0 },
      },
      remedy: { kind: 'none', because: 'this is the conductor working as designed, not a gap' },
    }
  }
  const branch = subject.kind === 'run' ? subject.branch : subject.lane.branch
  if (branch === null) {
    return {
      label: 'branch',
      why: {
        reason:
          subject.kind === 'run'
            ? 'no recording of this lane names a branch'
            : 'git never saw a worktree for this lane',
        evidence: { fact: 'nothing is shown rather than a guess', elapsedMs: 0 },
      },
      remedy: { kind: 'none', because: 'a lane with no worktree has no branch to name' },
    }
  }
  return {
    label: 'branch',
    why: {
      reason: 'the branch this lane is working on',
      evidence: { fact: `git reported ${branch}`, elapsedMs: 0 },
    },
    remedy: { kind: 'none', because: 'a branch name is a reading, not a condition' },
  }
}
