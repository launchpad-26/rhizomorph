import { useCallback, useEffect, useState } from 'react'
import { Nav } from '../app/Nav.js'
import { navigate } from '../app/router.js'
import { experimentHasOutcome, toBranchingArms } from './adapters.js'
import { type FetchLike, fetchLabCheckpoints, fetchLabExperiments } from './api.js'
import { compareByPosition, SessionAxis } from './axis/index.js'
import { layoutBranching, type Point } from './branching/index.js'
import { ExperimentComparison, type FailedArm } from './compare/index.js'
import { type DivergenceSummary, Frame, type FramePosition } from './frame/index.js'
import { LaunchPanel } from './launch/LaunchPanel.js'
import type { LaunchFetchLike, LaunchOutcome } from './launch/launch.js'
import { Metrics } from './metrics/index.js'
import { TraceDiff } from './trace/index.js'
import { computeExperimentDimensions, isCleanlyControlled, type LabCheckpoint, type LabExperiment } from './types.js'

/**
 * THE LAB WORKSPACE (prd53 S1, #325) — `/lab`. The instrument's second hand
 * (prd12 ruling 1): forked realities only, never live fleet state
 * (`no-live-fleet-law.test.ts`). Four surfaces share one axis:
 *
 * - the SESSION AXIS (`axis/`) — the session as one scale, checkpoints as
 *   chapter markers placed by byte, the playhead seated on one of them, and
 *   *fork from here* on the seated marker and nowhere else;
 * - the FRAME (`frame/`) — ruling 8's five-position switch, resolving the
 *   seated moment through the same axis function the track uses;
 * - LAUNCH (`launch/`) — the one confirmation, reading the seated marker;
 * - EXPERIMENTS — each with its branching layout (prd14 ruling 1's grammar,
 *   until wave 4's canvas), its COMPARE (`compare/`, per run, per measure),
 *   and, for the run the operator opens, its TRACE (`trace/`);
 * - METRICS (`metrics/`) — every number with its basis, on one shared scale.
 *
 * Two DIFFERENT empty sentences, never conflated: a successful read of zero
 * rows says "there are no … yet"; a failed read says "the lab cannot see" its
 * own data, with the failure's own detail. A partial launch (ruling 7) is a
 * launch-time fact — the record holds no intent event — so this page learns
 * it from the launch panel and threads it to the axis, Compare and Metrics.
 */
export interface LabPageProps {
  /** Test-only escape hatch for every read this page (and the surfaces it mounts) makes. */
  fetchImpl?: FetchLike
  /** Test-only escape hatch for the one write the launch panel makes. */
  launchFetchImpl?: LaunchFetchLike
  /** Test-only: launches this page should already know about — how the partial state is rendered deterministically. */
  seedLaunchOutcomes?: readonly LaunchOutcome[]
}

type LoadState<T> = { status: 'loading' } | { status: 'ready'; items: T[] } | { status: 'error'; message: string }

function goBalcony(): void {
  navigate('/')
}

function useLabLoad<T>(load: () => Promise<T[]>): LoadState<T> {
  const [state, setState] = useState<LoadState<T>>({ status: 'loading' })
  useEffect(() => {
    let live = true
    setState({ status: 'loading' })
    load()
      .then((items) => {
        if (live) setState({ status: 'ready', items })
      })
      .catch((err) => {
        if (live) setState({ status: 'error', message: err instanceof Error ? err.message : String(err) })
      })
    return () => {
      live = false
    }
  }, [load])
  return state
}

function CheckpointsSection({ checkpoints }: { checkpoints: LoadState<LabCheckpoint> }) {
  if (checkpoints.status === 'loading') return <p className="text-(--ink-dim)">loading checkpoints…</p>
  if (checkpoints.status === 'error') {
    return (
      <p role="status" data-testid="lab-checkpoints-error" className="text-broken">
        the lab cannot see its checkpoints — {checkpoints.message}
      </p>
    )
  }
  if (checkpoints.items.length === 0) {
    return (
      <p data-testid="lab-checkpoints-empty" className="text-(--ink-dim)">
        there are no checkpoints yet — capture one with `rhizomorph lab checkpoint &lt;lane&gt;`
      </p>
    )
  }
  return (
    <table data-testid="lab-checkpoints-table" className="w-full border-collapse text-left text-read-body">
      <thead>
        <tr className="border-(--line-strong) border-b text-(--ink-dim)">
          <th className="p-2 font-normal">lane</th>
          <th className="p-2 font-normal">checkpoint</th>
          <th className="p-2 font-normal">captured</th>
          <th className="p-2 font-normal">by</th>
          <th className="p-2 font-normal">byte</th>
        </tr>
      </thead>
      <tbody>
        {[...checkpoints.items].sort(compareByPosition).map((checkpoint) => (
          <tr key={checkpoint.eventId} data-testid={`lab-checkpoint-row-${checkpoint.checkpointId}`} className="border-(--line-hair) border-b align-top">
            <td className="p-2">{checkpoint.lane}</td>
            <td className="figures p-2">{checkpoint.checkpointId}</td>
            <td className="figures p-2">{new Date(checkpoint.capturedAt).toLocaleString()}</td>
            <td className="p-2">{checkpoint.capturedBy}</td>
            <td className="figures p-2 text-(--ink-dim)">
              {checkpoint.sessionCutByte}
              {checkpoint.sessionByteLength === null ? ' · session file moved' : ` of ${checkpoint.sessionByteLength}`}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function experimentDimensionsText(experiment: LabExperiment): string {
  const dimensions = computeExperimentDimensions(experiment)
  if (!dimensions.modelVaries && !dimensions.promptVaries) return 'no arm varies from the others'
  if (isCleanlyControlled(dimensions)) return dimensions.modelVaries ? 'arms differ in model only' : 'arms differ in brief only'
  return 'arms differ in model and brief — a difference cannot be attributed to either'
}

function pathD(points: readonly Point[]): string {
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ')
}

function cssRgba(source: { readonly rgb: readonly [number, number, number]; readonly alpha: number }): string {
  const [r, g, b] = source.rgb
  return `rgba(${r}, ${g}, ${b}, ${source.alpha})`
}

/** prd14 ruling 1's layout grammar — the branching diagram, until wave 4's canvas draws the organisms. */
function BranchingDiagram({ experiment }: { experiment: LabExperiment }) {
  const width = 480
  const height = Math.max(120, 36 * experiment.arms.length + 40)
  const layout = layoutBranching({ width, height, arms: toBranchingArms(experiment) })
  return (
    <svg data-testid={`lab-branching-${experiment.forkId}`} viewBox={`0 0 ${layout.width} ${layout.height}`} role="img" aria-label={`branching layout for experiment ${experiment.forkId}`} className="h-auto w-full">
      <path d={pathD(layout.trunk.path)} stroke={cssRgba(layout.trunk.ink)} strokeWidth={2} fill="none" />
      <circle cx={layout.fork.at.x} cy={layout.fork.at.y} r={layout.fork.radius} fill={cssRgba(layout.fork.ink)} data-testid={`lab-branching-fork-${experiment.forkId}`} />
      {layout.arms.map((arm) => (
        <path
          key={arm.id}
          data-testid={`lab-arm-path-${experiment.forkId}-${arm.id}`}
          data-arm-state={arm.state}
          d={pathD(arm.path)}
          stroke={cssRgba(arm.ink)}
          strokeWidth={2}
          strokeDasharray={`${arm.dash[0]} ${arm.dash[1]}`}
          fill="none"
        />
      ))}
    </svg>
  )
}

interface ExperimentPanelProps {
  experiment: LabExperiment
  failedArms: readonly FailedArm[]
  fetchImpl?: FetchLike
  onDivergence: (summary: DivergenceSummary | null) => void
}

function ExperimentPanel({ experiment, failedArms, fetchImpl, onDivergence }: ExperimentPanelProps) {
  const [openRun, setOpenRun] = useState<string | null>(null)
  const hasOutcome = experimentHasOutcome(experiment)
  const runs = experiment.arms.flatMap((arm) => arm.runs.map((run) => ({ arm: arm.arm, run })))
  const open = runs.find((entry) => entry.run.laneHandle === openRun) ?? null

  return (
    <div id={`lab-experiment-${experiment.forkId}`} data-testid={`lab-experiment-${experiment.forkId}`} className="flex flex-col gap-3 border border-(--line-hair) p-3">
      <div className="flex flex-wrap items-baseline gap-2 text-read-body">
        <span className="figures text-(--ink-primary)">{experiment.forkId}</span>
        <span className="text-(--ink-dim)">
          — {experiment.arms.length} arm(s) of lane &quot;{experiment.parentLane}&quot; at checkpoint {experiment.checkpointId}
        </span>
      </div>
      <p data-testid={`lab-experiment-dimensions-${experiment.forkId}`} className="text-(--ink-dim)">
        {experimentDimensionsText(experiment)}
      </p>

      <BranchingDiagram experiment={experiment} />

      <ol className="flex flex-col gap-1 text-(--ink-body)">
        {experiment.arms.map((arm) => (
          <li key={arm.arm} data-testid={`lab-branching-arm-${experiment.forkId}-${arm.arm}`}>
            <span className="figures text-(--ink-dim)">{arm.arm}</span> {arm.treatment.model ?? 'default'} —{' '}
            {arm.treatment.promptDigest === null ? 'no-brief' : arm.treatment.promptDigest.slice(0, 8)} · {arm.runs.length} run{arm.runs.length === 1 ? '' : 's'}
          </li>
        ))}
      </ol>

      {hasOutcome ? null : (
        <p data-testid={`lab-experiment-no-comparison-${experiment.forkId}`} className="text-(--ink-dim)">
          no run has a measured outcome yet — the comparison below shows every run as it stands, and invents nothing
        </p>
      )}
      <ExperimentComparison experiment={experiment} failedArms={failedArms} />

      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-baseline gap-1">
          <span className="heading text-(--ink-dim)">trace</span>
          {runs.map(({ arm, run }) => (
            <button
              key={run.laneHandle}
              type="button"
              data-testid={`lab-trace-open-${run.laneHandle}`}
              aria-pressed={openRun === run.laneHandle}
              onClick={() => {
                const next = openRun === run.laneHandle ? null : run.laneHandle
                setOpenRun(next)
                if (next === null) onDivergence(null)
              }}
              className={`focus-ring border px-1.5 py-0.5 ${openRun === run.laneHandle ? 'border-(--ink-primary) text-(--ink-primary)' : 'border-(--line-strong) text-(--ink-dim)'}`}
            >
              arm {arm} · run {run.run}
            </button>
          ))}
        </div>
        {open === null ? null : (
          <TraceDiff
            parentLane={experiment.parentLane}
            laneHandle={open.run.laneHandle}
            armLabel={`arm ${open.arm} · run ${open.run.run}`}
            failed={null}
            {...(fetchImpl === undefined ? {} : { fetchImpl })}
            onDiff={(summary) => onDivergence({ armLabel: `arm ${open.arm} · run ${open.run.run}`, ...summary })}
          />
        )}
      </div>
    </div>
  )
}

function ExperimentsSection({ experiments, failedByFork, fetchImpl, onDivergence }: { experiments: LoadState<LabExperiment>; failedByFork: Readonly<Record<string, readonly FailedArm[]>>; fetchImpl?: FetchLike; onDivergence: (summary: DivergenceSummary | null) => void }) {
  if (experiments.status === 'loading') return <p className="text-(--ink-dim)">loading experiments…</p>
  if (experiments.status === 'error') {
    return (
      <p role="status" data-testid="lab-experiments-error" className="text-broken">
        the lab cannot see its experiments — {experiments.message}
      </p>
    )
  }
  if (experiments.items.length === 0) {
    return (
      <p data-testid="lab-experiments-empty" className="text-(--ink-dim)">
        there are no experiments yet — fork a checkpoint with `rhizomorph lab fork &lt;lane&gt;`
      </p>
    )
  }
  return (
    <div className="flex flex-col gap-4">
      {experiments.items.map((experiment) => (
        <ExperimentPanel
          key={experiment.forkId}
          experiment={experiment}
          failedArms={failedByFork[experiment.forkId] ?? []}
          {...(fetchImpl === undefined ? {} : { fetchImpl })}
          onDivergence={onDivergence}
        />
      ))}
    </div>
  )
}

/** The partial-launch facts, by fork and by checkpoint, from the launches this page has seen (ruling 7). */
function partialFacts(outcomes: readonly LaunchOutcome[]): { byFork: Record<string, FailedArm[]>; byCheckpoint: Record<string, number> } {
  const byFork: Record<string, FailedArm[]> = {}
  const byCheckpoint: Record<string, number> = {}
  for (const outcome of outcomes) {
    if (outcome.failed === null) continue
    // Every dispatched arm carries the experiment's forkId (prd53 ruling 1); a
    // launch whose FIRST arm failed has no arm and no experiment to attach to.
    const forkId = outcome.arms[0]?.forkId ?? ''
    if (forkId.length > 0) byFork[forkId] = [...(byFork[forkId] ?? []), { arm: outcome.failed.arm, error: outcome.failed.error }]
    byCheckpoint[outcome.checkpointId] = (byCheckpoint[outcome.checkpointId] ?? 0) + 1
  }
  return { byFork, byCheckpoint }
}

export function LabPage({ fetchImpl, launchFetchImpl, seedLaunchOutcomes = [] }: LabPageProps = {}) {
  const loadCheckpoints = useCallback(() => fetchLabCheckpoints(fetchImpl), [fetchImpl])
  const loadExperiments = useCallback(() => fetchLabExperiments(fetchImpl), [fetchImpl])
  const checkpoints = useLabLoad(loadCheckpoints)
  const experiments = useLabLoad(loadExperiments)

  const [seated, setSeated] = useState<string | null>(null)
  const [position, setPosition] = useState<FramePosition>(2)
  const [divergence, setDivergence] = useState<DivergenceSummary | null>(null)
  const [launches, setLaunches] = useState<readonly LaunchOutcome[]>(seedLaunchOutcomes)

  const checkpointItems = checkpoints.status === 'ready' ? checkpoints.items : []
  const seatedCheckpoint = checkpointItems.find((checkpoint) => checkpoint.checkpointId === seated) ?? null
  const experimentItems = experiments.status === 'ready' ? experiments.items : []
  const partial = partialFacts(launches)

  function scrollToExperiment(forkId: string) {
    document.getElementById(`lab-experiment-${forkId}`)?.scrollIntoView?.({ block: 'start' })
  }

  return (
    <div data-testid="lab-page" className="flex h-screen flex-col bg-(--surface-floor) font-sans text-(--ink-body)">
      <Nav />
      <header className="flex shrink-0 items-center gap-4 border-(--line-hair) border-b bg-(--surface-panel) px-4 py-3">
        <button type="button" data-testid="lab-back" onClick={goBalcony} className="focus-ring heading shrink-0 border border-(--line-strong) px-2 py-1 text-(--ink-dim)">
          ← balcony
        </button>
        <h1 className="text-(--ink-primary) text-sm">Lab</h1>
        <span className="text-(--ink-dim) text-read-body normal-case tracking-normal">
          forked realities only — checkpoints you captured, and experiments forked from them. Never live fleet state.
        </span>
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-4">
        <section className="mb-6" aria-labelledby="lab-axis-heading">
          <h2 id="lab-axis-heading" className="heading mb-2 text-(--ink-dim)">
            The session
          </h2>
          {checkpoints.status === 'error' ? (
            <p role="status" data-testid="lab-axis-error" className="text-broken">
              the lab cannot see its checkpoints — {checkpoints.message}
            </p>
          ) : (
            <SessionAxis
              checkpoints={checkpointItems}
              seated={seated}
              onSeat={setSeated}
              failedArmsByCheckpoint={partial.byCheckpoint}
              onForkFromHere={(checkpoint) => {
                setSeated(checkpoint.checkpointId)
                document.getElementById('lab-launch')?.scrollIntoView?.({ block: 'start' })
              }}
            />
          )}
        </section>

        <section className="mb-6">
          <Frame position={position} onPosition={setPosition} seated={seatedCheckpoint} experiments={experimentItems} divergence={divergence} />
        </section>

        <section className="mb-6">
          <h2 className="heading mb-2 text-(--ink-dim)">Checkpoints</h2>
          <CheckpointsSection checkpoints={checkpoints} />
        </section>

        <section id="lab-launch" className="mb-6">
          <h2 className="heading mb-2 text-(--ink-dim)">Launch</h2>
          <LaunchPanel
            {...(fetchImpl === undefined ? {} : { fetchImpl })}
            {...(launchFetchImpl === undefined ? {} : { launchFetchImpl })}
            initialCheckpointId={seated}
            onLaunched={(outcome) => setLaunches((current) => [...current, outcome])}
          />
        </section>

        <section className="mb-6">
          <h2 className="heading mb-2 text-(--ink-dim)">Experiments</h2>
          <ExperimentsSection experiments={experiments} failedByFork={partial.byFork} {...(fetchImpl === undefined ? {} : { fetchImpl })} onDivergence={setDivergence} />
        </section>

        <section>
          <h2 className="heading mb-2 text-(--ink-dim)">Metrics</h2>
          {experiments.status === 'error' ? (
            <p role="status" data-testid="lab-metrics-error" className="text-broken">
              the lab cannot see its experiments — {experiments.message}
            </p>
          ) : (
            <Metrics experiments={experimentItems} failedArmsByFork={partial.byFork} onOpenCompare={scrollToExperiment} {...(fetchImpl === undefined ? {} : { fetchImpl })} />
          )}
        </section>
      </div>
    </div>
  )
}
