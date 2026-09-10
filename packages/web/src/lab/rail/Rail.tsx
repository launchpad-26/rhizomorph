import type { KeyboardEvent } from 'react'
import { AXIS_EMPTY_COPY, compareByPosition } from '../axis/index.js'
import type { FailedArm } from '../compare/types.js'
import { EMPTY_COPY as NO_EXPERIMENTS_COPY } from '../metrics/Metrics.js'
import type { LabCheckpoint, LabExperiment } from '../types.js'
import { checkpointRowFacts, experimentRowFacts } from './rows.js'

/**
 * THE RAIL (prd-55 ruling 8) — the workspace's left region: one row per
 * checkpoint and one row per experiment, and nothing else. It replaces Stage
 * 1's checkpoint TABLE: five columns of one moment, repeated down the page and
 * then repeated again inside the launch panel's step 1, is three listings of
 * the same fact. Now the checkpoint is listed once, here; the launch reads the
 * rail's selection (`initialCheckpointId`), and the stage draws whatever the
 * rail has selected.
 *
 * Every region carries its OWN loading, error and empty state (S1′: never
 * conflated) and every one of them is a fixture in `fixtures.ts` before it is
 * a branch here (ruling 9). The two empty sentences stay different: a
 * successful read of zero rows says "there are no … yet"; a failed read says
 * the lab cannot SEE them. The rail's failed-read line is short on purpose —
 * the stage carries the failure's own detail, so the reason is stated once
 * where there is room for it, and the rail says only that the listing it would
 * have drawn is not knowledge it has.
 *
 * Keyboard: ↑/↓ move within a list, Enter selects (the rows are buttons, so
 * that is the button's own behaviour and nothing here re-implements it).
 * No native `title=` anywhere: what a row says, it says.
 */
export type RailLoad<T> = { status: 'loading' } | { status: 'ready'; items: readonly T[] } | { status: 'error'; message: string }

export interface RailProps {
  checkpoints: RailLoad<LabCheckpoint>
  experiments: RailLoad<LabExperiment>
  /** The seated checkpoint's id — the playhead's own selection, shown here as the pressed row. */
  seated: string | null
  onSeat: (checkpointId: string) => void
  /** The experiment the stage is reading, or null when none is. */
  selectedFork: string | null
  onSelectExperiment: (forkId: string) => void
  /** Arms a launch asked for that never dispatched, by forkId — what makes a row say *2 of 3 arms* (ruling 7). */
  failedByFork?: Readonly<Record<string, readonly FailedArm[]>>
  /** The page's own sentence for a successful read of no checkpoints; it defaults to the axis's, and `LabPage.test.tsx` executes that they agree. */
  noCheckpointsCopy?: string
}

/** ↑/↓ move focus inside one list; nothing else is intercepted, so Tab still leaves the rail. */
function onListKeyDown(event: KeyboardEvent<HTMLElement>): void {
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
  const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')]
  if (rows.length === 0) return
  event.preventDefault()
  const at = rows.indexOf(document.activeElement as HTMLButtonElement)
  const step = event.key === 'ArrowDown' ? 1 : rows.length - 1
  rows[(Math.max(0, at) + step) % rows.length]?.focus()
}

const ROW = 'focus-ring flex w-full flex-col gap-1 border-(--line-hair) border-l-2 px-2 py-2 text-left'
const ROW_SELECTED = 'border-l-(--ink-primary) bg-(--surface-raised) text-(--ink-primary)'
const ROW_PLAIN = 'border-l-transparent text-(--ink-body)'

export function Rail({ checkpoints, experiments, seated, onSeat, selectedFork, onSelectExperiment, failedByFork = {}, noCheckpointsCopy = AXIS_EMPTY_COPY }: RailProps) {
  return (
    <aside
      data-testid="lab-rail"
      aria-label="the lab's record"
      className="flex min-h-0 flex-col gap-5 overflow-auto border-(--line-hair) border-r bg-(--surface-panel) p-3 text-read-body text-(--ink-body)"
    >
      <section aria-labelledby="lab-rail-checkpoints-heading" className="flex flex-col gap-1">
        <h2 id="lab-rail-checkpoints-heading" className="heading px-2 text-(--ink-dim)">
          Checkpoints
        </h2>
        {checkpoints.status === 'loading' ? (
          <p data-testid="lab-rail-checkpoints-loading" className="px-2 text-(--ink-dim)">
            reading the lab&apos;s checkpoints…
          </p>
        ) : checkpoints.status === 'error' ? (
          <p role="status" data-testid="lab-checkpoints-error" className="px-2 text-broken">
            the lab cannot see its checkpoints — {checkpoints.message}
          </p>
        ) : checkpoints.items.length === 0 ? (
          <p data-testid="lab-checkpoints-empty" className="px-2 text-(--ink-dim)">
            {noCheckpointsCopy}
          </p>
        ) : (
          <ul aria-label="checkpoints" onKeyDown={onListKeyDown} className="flex flex-col">
            {[...checkpoints.items].sort(compareByPosition).map((checkpoint) => {
              const facts = checkpointRowFacts(checkpoint)
              const isSeated = facts.checkpointId === seated
              return (
                <li key={checkpoint.eventId}>
                  <button
                    type="button"
                    data-checkpoint-row=""
                    data-testid={`lab-checkpoint-row-${facts.checkpointId}`}
                    aria-pressed={isSeated}
                    onClick={() => onSeat(facts.checkpointId)}
                    className={`${ROW} ${isSeated ? ROW_SELECTED : ROW_PLAIN}`}
                  >
                    <span className="figures truncate">
                      {facts.checkpointId} · {facts.lane}
                    </span>
                    <span className="figures text-(--ink-dim)">
                      {facts.position} · {facts.capturedBy}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <section aria-labelledby="lab-rail-experiments-heading" className="flex flex-col gap-1">
        <h2 id="lab-rail-experiments-heading" className="heading px-2 text-(--ink-dim)">
          Experiments
        </h2>
        {experiments.status === 'loading' ? (
          <p data-testid="lab-rail-experiments-loading" className="px-2 text-(--ink-dim)">
            reading the lab&apos;s experiments…
          </p>
        ) : experiments.status === 'error' ? (
          <p role="status" data-testid="lab-rail-experiments-error" className="px-2 text-broken">
            the lab cannot see its experiments — the stage carries the reason
          </p>
        ) : experiments.items.length === 0 ? (
          <p data-testid="lab-experiments-empty" className="px-2 text-(--ink-dim)">
            {NO_EXPERIMENTS_COPY}
          </p>
        ) : (
          <ul aria-label="experiments" onKeyDown={onListKeyDown} className="flex flex-col">
            {experiments.items.map((experiment) => {
              const facts = experimentRowFacts(experiment, failedByFork[experiment.forkId] ?? [])
              const isSelected = facts.forkId === selectedFork
              return (
                <li key={experiment.forkId}>
                  <button
                    type="button"
                    data-experiment-row=""
                    data-testid={`lab-experiment-row-${facts.forkId}`}
                    aria-pressed={isSelected}
                    onClick={() => onSelectExperiment(facts.forkId)}
                    className={`${ROW} ${isSelected ? ROW_SELECTED : ROW_PLAIN}`}
                  >
                    <span className="figures truncate">{facts.forkId}</span>
                    <span className="figures text-(--ink-dim)">{facts.shape}</span>
                    <span className="figures text-(--ink-dim)">{facts.verdicts}</span>
                    {facts.partial === null ? null : (
                      <span data-testid={`lab-rail-partial-${facts.forkId}`} className="figures text-broken">
                        {facts.partial}
                      </span>
                    )}
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <footer className="mt-auto border-(--line-hair) border-t px-2 pt-2 text-(--ink-dim)">
        <p>a checkpoint seats the playhead; an experiment opens on the stage.</p>
        <p>↑ / ↓ move · Enter selects</p>
      </footer>
    </aside>
  )
}
