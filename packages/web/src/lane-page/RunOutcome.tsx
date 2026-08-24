import type { ReactElement } from 'react'
import { Disclosure } from '../disclosure/index.js'
import { kindEdgeClass, kindInkClass } from '../theme/kind.js'
import type { LaneIndexCommit, LaneIndexEntry } from './laneIndex.js'

/**
 * IDENTITY AND OUTCOME, WITH ITS EVIDENCE (prd-31 S2, region 1 · #556).
 *
 * The region that answers *how did this end, and how do you know?* — and the
 * second half of that question is the whole point. S2 names "an outcome claimed
 * without its evidence" as one of three things that would make this surface
 * wrong, so the outcome word and the commits that justify it are one component:
 * there is no arrangement of this markup that shows LANDED with nothing behind
 * it, because the commits are what the word is computed from.
 *
 * **The worktree's state is a fact from the log, not from the disk.** `workmux
 * merge` deletes a worktree the moment work lands, so "the worktree is gone" is
 * exactly the state a reader most often arrives in — it is reported here as the
 * ordinary end of a lane's life, with the recordings that hold the rest of it
 * named, rather than as an emptiness the page apologises for.
 *
 * **A partial reading says so.** When the index could not read one of the
 * recordings this lane spans, its own sentence renders here (`partialVoice`) —
 * law 12 at life-story altitude: the missing session is named, never quietly
 * dropped from the count.
 */

/** What the log can honestly say about how a lane ended. */
export type RunOutcome = 'landed' | 'folded' | 'working' | 'unknown'

export interface RunOutcomeProps {
  handle: string
  entry: LaneIndexEntry | null
  /** The index's own sentence when it could not answer at all; rendered rather than reworded. */
  indexGap: string | null
  /** The reader's own position in time — every elapsed figure is measured against it. */
  now: number
}

/**
 * The outcome, from evidence alone.
 *
 * - **landed** — commits exist AND the worktree has been removed: the work
 *   reached the branch and the lane folded.
 * - **folded** — the worktree is gone with no commit in any recording. That is
 *   deliberately not called "landed": a lane can be torn down without landing
 *   anything, and a page that reported both as one word would be making the
 *   claim S2 forbids.
 * - **working** — a worktree is still there.
 * - **unknown** — no recording carries either fact.
 */
export function outcomeOf(entry: LaneIndexEntry | null): RunOutcome {
  if (entry === null) return 'unknown'
  const commits = entry.sessions.reduce((total, slice) => total + slice.commits.length, 0)
  if (entry.worktreeRemoved) return commits > 0 ? 'landed' : 'folded'
  if (entry.worktreePath !== null) return 'working'
  return 'unknown'
}

const OUTCOME_WORD: Record<RunOutcome, string> = {
  landed: 'LANDED',
  folded: 'FOLDED — no commit recorded',
  working: 'WORKING',
  unknown: 'UNKNOWN',
}

function commitsOf(entry: LaneIndexEntry | null): LaneIndexCommit[] {
  if (entry === null) return []
  return entry.sessions
    .flatMap((slice) => slice.commits)
    .sort((a, b) => b.landedAt - a.landedAt)
}

export function RunOutcomeRegion({ handle, entry, indexGap, now }: RunOutcomeProps): ReactElement {
  const outcome = outcomeOf(entry)
  const commits = commitsOf(entry)
  const sessions = entry?.sessions ?? []
  const lastSeenAt = entry?.lastSeenAt ?? null

  return (
    <section
      data-testid="run-outcome"
      data-outcome={outcome}
      className="rounded-none border border-(--surface-line) bg-(--surface-panel) px-3 py-2"
    >
      <header className="flex flex-wrap items-baseline gap-x-3">
        <h2 className="figures text-inst uppercase tracking-[0.2em] text-(--ink-dim)">outcome</h2>
        <span
          data-testid="run-outcome-word"
          className={`figures text-read-floor uppercase tracking-wider ${kindInkClass(outcome === 'landed' ? 'commit' : 'run')}`}
        >
          <Disclosure
            disclosure={{
              label: `${OUTCOME_WORD[outcome]} — ${handle}`,
              why: {
                reason:
                  outcome === 'landed'
                    ? 'commits landed on this lane’s branch and its worktree has since been removed'
                    : outcome === 'folded'
                      ? 'the worktree was removed and no recording holds a commit for this lane'
                      : outcome === 'working'
                        ? 'a worktree for this lane is still recorded as present'
                        : 'no recording carries either a worktree or a commit for this lane',
                evidence: {
                  fact: `${commits.length} commit(s) across ${sessions.length} recording(s), last activity`,
                  elapsedMs: Math.max(0, now - (lastSeenAt ?? now)),
                },
              },
              remedy: {
                kind: 'none',
                because:
                  'this is a reading of the log, not a state anything can be done to — the evidence below is the whole of it',
              },
            }}
            triggerLabel={`outcome ${OUTCOME_WORD[outcome]}`}
          >
            {OUTCOME_WORD[outcome]}
          </Disclosure>
        </span>
        {entry?.issue === null || entry === null ? null : (
          <span data-testid="run-outcome-issue" className="figures text-inst text-(--ink-dim)">
            #{entry.issue}
          </span>
        )}
        <span data-testid="run-outcome-branch" className="figures text-inst text-(--ink-body)">
          {entry?.branch ?? '—'}
        </span>
      </header>

      {/*
        The durability clause, made visible. A gone worktree is the ordinary end
        of a lane's life here, so it is stated as a fact with its path — never as
        an error, and never as the reason a region renders empty.
      */}
      {entry !== null && entry.worktreeRemoved ? (
        <p data-testid="run-worktree-gone" className="mt-1 text-read-body text-(--ink-body)">
          WORKTREE GONE — {entry.worktreePath ?? 'its path was never recorded'} was removed; everything
          below is read from {sessions.length === 1 ? 'the recording' : `the ${sessions.length} recordings`} and
          the captured transcripts, not from a working tree.
        </p>
      ) : null}

      {entry?.partialVoice === null || entry === null ? null : (
        <p data-testid="run-partial" role="status" className="mt-1 text-read-body text-(--ink-dim)">
          {entry.partialVoice}
        </p>
      )}

      {indexGap === null ? null : (
        <p data-testid="run-index-gap" role="status" className="mt-1 text-read-body text-(--ink-dim)">
          {indexGap}
        </p>
      )}

      {commits.length === 0 ? (
        <p data-testid="run-outcome-no-evidence" className="mt-1 text-read-body text-(--ink-dim)">
          no commit in any recording names this lane’s branch — the outcome above rests on the
          worktree’s own record and nothing more
        </p>
      ) : (
        <ul data-testid="run-outcome-evidence" className="mt-1 space-y-0.5">
          {commits.map((commit) => (
            <li
              key={commit.sha}
              data-testid="run-outcome-commit"
              className={`figures text-inst text-(--ink-body) ${kindEdgeClass('commit')}`}
            >
              {commit.sha.slice(0, 7)} · {commit.message.split('\n')[0]} · {commit.fileCount} file
              {commit.fileCount === 1 ? '' : 's'}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
