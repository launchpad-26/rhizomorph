import { type KeyboardEvent, useCallback, useEffect, useState } from 'react'
import { Nav } from '../app/Nav.js'
import { navigate } from '../app/router.js'
import { experimentHasOutcome, toBranchingArms } from './adapters.js'
import { type FetchLike, fetchLabCheckpoints, fetchLabExperiments } from './api.js'
import { SessionAxis } from './axis/index.js'
import { layoutBranching, type Point } from './branching/index.js'
import { ExperimentComparison, type FailedArm } from './compare/index.js'
import { type DivergenceSummary, Frame, type FramePosition } from './frame/index.js'
import { LaunchPanel } from './launch/LaunchPanel.js'
import type { LaunchFetchLike, LaunchOutcome } from './launch/launch.js'
import type { MeasureFetchLike } from './measure.js'
import { MeasureControl } from './measure-control/MeasureControl.js'
import { Metrics } from './metrics/index.js'
import { Rail } from './rail/index.js'
import { TraceDiff } from './trace/index.js'
import { computeExperimentDimensions, isCleanlyControlled, type LabCheckpoint, type LabExperiment, type LabRun } from './types.js'

/**
 * THE LAB WORKSPACE — `/lab`. The instrument's second hand (prd12 ruling 1):
 * forked realities only, never live fleet state (`no-live-fleet-law.test.ts`).
 *
 * Since prd-55 ruling 8 the workspace is ONE WORKING SCREEN rather than a
 * column of sections, and the rearrangement is the point rather than a tidy-up.
 * Stage 1 stacked six surfaces down one scroll: the axis, the frame, a
 * checkpoint table, the launch panel (whose step 1 listed those same
 * checkpoints again), every experiment's panel, and Metrics over all of them.
 * The moment an operator had two experiments, the thing they were reading and
 * the thing they were reading it against were never on screen together, and
 * the axis they were both positioned on had scrolled away above both.
 *
 * TWO REGIONS now:
 *
 * - the RAIL (`rail/`) — one row per checkpoint and one per experiment, the
 *   whole record at a glance, and the only place either is listed. Selecting a
 *   row seats the playhead or opens an experiment on the stage; the launch's
 *   step 1 reuses that selection rather than repeating the table.
 * - the STAGE — its top PINNED: the SESSION AXIS (`axis/`, prd53 ruling 4's
 *   one function) and the FRAME (`frame/`, ruling 8's five-position switch)
 *   stay put while the reading below them scrolls. Below them the selected
 *   experiment's COMPARE (`compare/`), TRACE (`trace/`) and METRICS
 *   (`metrics/`) are TABS, not a stack — one reading at a time, each about the
 *   same experiment, so switching between them costs a keystroke instead of a
 *   scroll.
 *
 * Every region keeps its own loading, error and empty state, never conflated
 * (S1′, inherited from Stage 1): a successful read of zero rows says "there
 * are no … yet"; a failed read says the lab cannot SEE its own data, with the
 * failure's own detail. A partial launch (ruling 7) is a launch-time fact —
 * the record holds no intent event — so this page learns it from the launch
 * panel and threads it to the rail, the axis, Compare and Metrics alike.
 */
export interface LabPageProps {
  /** Test-only escape hatch for every read this page (and the surfaces it mounts) makes. */
  fetchImpl?: FetchLike
  /** Test-only escape hatch for the one write the launch panel makes. */
  launchFetchImpl?: LaunchFetchLike
  /** Test-only escape hatch for the one write every experiment's measure control makes. */
  measureFetchImpl?: MeasureFetchLike
  /** Test-only: launches this page should already know about — how the partial state is rendered deterministically. */
  seedLaunchOutcomes?: readonly LaunchOutcome[]
}

type LoadState<T> = { status: 'loading' } | { status: 'ready'; items: T[] } | { status: 'error'; message: string }

/**
 * The page's own sentence for a successful read of no checkpoints. It is the
 * axis's sentence too (`AXIS_EMPTY_COPY`) — the same words in the region that
 * lists checkpoints and the region that places them — and
 * `LabPage.test.tsx` executes that the two agree rather than trusting them to.
 */
export const NO_CHECKPOINTS_COPY = 'there are no checkpoints yet — capture one with `rhizomorph lab checkpoint <lane>`'

/** The stage's three readings of one experiment (ruling 8) — a tablist, never a stack. */
const TABS = ['Compare', 'Trace', 'Metrics'] as const
type Tab = (typeof TABS)[number]

function goBalcony(): void {
  navigate('/')
}

/**
 * One read, and the way to ask for it again. The read runs when `load` changes
 * and whenever `reload()` is called — a launch that reported (prd-55 ruling 7:
 * the new experiment reaches Compare and Metrics without a page reload) and a
 * measurement that returned (its verdicts are on the record now) both ask.
 * A re-read keeps the rows on screen until the new ones arrive: a panel
 * mid-sentence — a measurement just reported, a trace open — is not torn down
 * for a read that will put it straight back. A first read, or one after an
 * error, still says loading.
 */
function useLabLoad<T>(load: () => Promise<T[]>): [LoadState<T>, () => void] {
  const [state, setState] = useState<LoadState<T>>({ status: 'loading' })
  const [generation, setGeneration] = useState(0)
  useEffect(() => {
    let live = true
    setState((current) => (current.status === 'ready' ? current : { status: 'loading' }))
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
  }, [load, generation])
  const reload = useCallback(() => setGeneration((current) => current + 1), [])
  return [state, reload]
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

/**
 * prd14 ruling 1's layout grammar, shrunk to a HEADER GLYPH (prd-55 ruling 8):
 * a strand per run beside the experiment's name, not a panel of its own. The
 * drawing of the experiment is the lane canvas at the frame's scene position,
 * which gets the stage's full width; this is the mark that says which
 * experiment the stage is reading. The glyph bounds its own height
 * (`branching/geometry.ts`), so the size asked for here is a request.
 */
function BranchingGlyph({ experiment }: { experiment: LabExperiment }) {
  const layout = layoutBranching({ width: 200, height: 44, arms: toBranchingArms(experiment) })
  return (
    <svg
      data-testid={`lab-branching-${experiment.forkId}`}
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      role="img"
      aria-label={`branching glyph for experiment ${experiment.forkId}`}
      className="h-8 w-auto shrink-0"
    >
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

interface OpenableRun {
  arm: number
  run: LabRun
}

function runsOf(experiment: LabExperiment | null): OpenableRun[] {
  if (experiment === null) return []
  return experiment.arms.flatMap((arm) => arm.runs.map((run) => ({ arm: arm.arm, run })))
}

/**
 * THE TRACE CONTROL — which run's trace is open. It is rendered twice on
 * purpose (ruling 8: "the Trace control is inside the frame's divergence
 * position as well as the tab"): once in the Trace tab, and once beneath the
 * frame when the frame is showing divergence, so an operator reading the
 * divergence figure can open the trace that produced it without leaving the
 * position they are standing in. Both instances drive the ONE `openRun` state,
 * so they cannot disagree about which run is open.
 */
function TraceControl({
  experiment,
  openRun,
  onOpen,
  idPrefix,
}: {
  experiment: LabExperiment
  openRun: string | null
  onOpen: (laneHandle: string | null) => void
  idPrefix: string
}) {
  return (
    <div data-testid={`${idPrefix}-trace-control`} className="flex flex-wrap items-baseline gap-1">
      <span className="heading text-(--ink-dim)">trace</span>
      {runsOf(experiment).map(({ arm, run }) => (
        <button
          key={run.laneHandle}
          type="button"
          data-testid={`${idPrefix}-trace-open-${run.laneHandle}`}
          aria-pressed={openRun === run.laneHandle}
          onClick={() => onOpen(openRun === run.laneHandle ? null : run.laneHandle)}
          className={`focus-ring border px-1.5 py-0.5 ${openRun === run.laneHandle ? 'border-(--ink-primary) bg-(--surface-raised) text-(--ink-primary)' : 'border-(--line-strong) text-(--ink-dim)'}`}
        >
          arm {arm} · run {run.run}
        </button>
      ))}
    </div>
  )
}

/** The tab strip: roving tabindex, ←/→ and Home/End, as a tablist is. */
function TabStrip({ tab, onTab }: { tab: Tab; onTab: (tab: Tab) => void }) {
  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    const at = TABS.indexOf(tab)
    const next =
      event.key === 'ArrowRight'
        ? TABS[(at + 1) % TABS.length]
        : event.key === 'ArrowLeft'
          ? TABS[(at - 1 + TABS.length) % TABS.length]
          : event.key === 'Home'
            ? TABS[0]
            : event.key === 'End'
              ? TABS[TABS.length - 1]
              : undefined
    if (next === undefined) return
    event.preventDefault()
    onTab(next)
    document.getElementById(`lab-tab-${next}`)?.focus()
  }
  return (
    <div role="tablist" aria-label="the selected experiment's reading" onKeyDown={onKeyDown} className="flex gap-1 border-(--line-hair) border-b">
      {TABS.map((name) => (
        <button
          key={name}
          type="button"
          id={`lab-tab-${name}`}
          role="tab"
          aria-selected={name === tab}
          aria-controls={`lab-tabpanel-${name}`}
          tabIndex={name === tab ? 0 : -1}
          data-testid={`lab-tab-${name}`}
          onClick={() => onTab(name)}
          className={`focus-ring border-b-2 px-4 py-2 ${name === tab ? 'border-b-(--ink-primary) bg-(--surface-raised) text-(--ink-primary)' : 'border-b-transparent text-(--ink-dim)'}`}
        >
          {name}
        </button>
      ))}
    </div>
  )
}

/**
 * One tabpanel. All three stay MOUNTED and the inactive ones are `hidden`,
 * which is what makes S3′'s "divergence populates without opening the Trace
 * tab" true: opening a run from the frame's own control mounts nothing new, so
 * Trace reads and reports its divergence to the frame while Compare is the
 * reading on screen. It is also why a measurement that lands under one tab is
 * still there under the others.
 */
function TabPanel({ name, tab, children }: { name: Tab; tab: Tab; children: React.ReactNode }) {
  return (
    <div
      role="tabpanel"
      id={`lab-tabpanel-${name}`}
      aria-labelledby={`lab-tab-${name}`}
      data-testid={`lab-tabpanel-${name}`}
      hidden={name !== tab}
      tabIndex={0}
      className="focus-ring pt-4 outline-none"
    >
      {children}
    </div>
  )
}

/**
 * The partial-launch facts, by fork and by checkpoint, from the launches this
 * page has seen (ruling 7). Dispatch stops at the first failed arm, so the
 * failed arm is not the whole gap: every arm numbered after it, up to
 * `requestedArms` (the count the request itself asked for — prd-55 ruling 7,
 * never rebuilt from what came back), was NEVER ATTEMPTED. Both kinds are
 * present in the comparison and excluded from every spread the same way
 * (`compare/ComparisonSurface.tsx` renders whatever this list holds,
 * unchanged); only the words beside a never-attempted arm say it never ran at
 * all, rather than naming a failure it never had.
 */
function partialFacts(outcomes: readonly LaunchOutcome[]): { byFork: Record<string, FailedArm[]>; byCheckpoint: Record<string, number> } {
  const byFork: Record<string, FailedArm[]> = {}
  const byCheckpoint: Record<string, number> = {}
  for (const outcome of outcomes) {
    if (outcome.failed === null) continue
    // Every dispatched arm carries the experiment's forkId (prd53 ruling 1); a
    // launch whose FIRST arm failed has no arm and no experiment to attach to.
    const forkId = outcome.arms[0]?.forkId ?? ''
    if (forkId.length > 0) {
      const gap: FailedArm[] = [{ arm: outcome.failed.arm, error: outcome.failed.error }]
      for (let arm = outcome.failed.arm + 1; arm <= outcome.requestedArms; arm += 1) {
        gap.push({ arm, error: `never attempted — dispatch stopped at arm ${outcome.failed.arm}` })
      }
      byFork[forkId] = [...(byFork[forkId] ?? []), ...gap]
    }
    byCheckpoint[outcome.checkpointId] = (byCheckpoint[outcome.checkpointId] ?? 0) + 1
  }
  return { byFork, byCheckpoint }
}

export function LabPage({ fetchImpl, launchFetchImpl, measureFetchImpl, seedLaunchOutcomes = [] }: LabPageProps = {}) {
  const loadCheckpoints = useCallback(() => fetchLabCheckpoints(fetchImpl), [fetchImpl])
  const loadExperiments = useCallback(() => fetchLabExperiments(fetchImpl), [fetchImpl])
  const [checkpoints] = useLabLoad(loadCheckpoints)
  const [experiments, reloadExperiments] = useLabLoad(loadExperiments)

  const [seated, setSeated] = useState<string | null>(null)
  const [position, setPosition] = useState<FramePosition>(2)
  const [divergence, setDivergence] = useState<DivergenceSummary | null>(null)
  const [launches, setLaunches] = useState<readonly LaunchOutcome[]>(seedLaunchOutcomes)
  const [selectedFork, setSelectedFork] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('Compare')
  const [openRun, setOpenRun] = useState<string | null>(null)

  const checkpointItems: LabCheckpoint[] = checkpoints.status === 'ready' ? checkpoints.items : []
  const seatedCheckpoint = checkpointItems.find((checkpoint) => checkpoint.checkpointId === seated) ?? null
  const experimentItems: LabExperiment[] = experiments.status === 'ready' ? experiments.items : []
  const partial = partialFacts(launches)

  // DERIVED, not stored: the stage reads the selected experiment, and falls
  // back to the first one there is. A selection that no longer exists — the
  // record was re-read and its experiment is gone — resolves to the first
  // rather than to a blank stage nobody asked for.
  const selected = experimentItems.find((experiment) => experiment.forkId === selectedFork) ?? experimentItems[0] ?? null
  const open = runsOf(selected).find((entry) => entry.run.laneHandle === openRun) ?? null

  function openExperiment(forkId: string): void {
    setSelectedFork(forkId)
    // A trace belongs to the run that opened it; carrying it across to another
    // experiment would hand the frame a divergence figure for a run the stage
    // is no longer reading.
    setOpenRun(null)
    setDivergence(null)
  }

  function seatFromRail(checkpointId: string): void {
    setSeated(checkpointId)
    const forked = experimentItems.find((experiment) => experiment.checkpointId === checkpointId)
    if (forked !== undefined) openExperiment(forked.forkId)
  }

  function openTrace(laneHandle: string | null): void {
    setOpenRun(laneHandle)
    if (laneHandle === null) setDivergence(null)
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

      <div data-testid="lab-workspace" className="grid min-h-0 flex-1 grid-cols-[16rem_minmax(0,1fr)]">
        <Rail
          checkpoints={checkpoints}
          experiments={experiments}
          seated={seated}
          onSeat={seatFromRail}
          selectedFork={selected === null ? null : selected.forkId}
          onSelectExperiment={openExperiment}
          failedByFork={partial.byFork}
          noCheckpointsCopy={NO_CHECKPOINTS_COPY}
        />

        <main data-testid="lab-stage" className="min-h-0 overflow-auto">
          {/* THE TOP NEVER SCROLLS AWAY (ruling 8): the axis every surface
              positions on, and the frame's five ways of looking at the seated
              moment, stay put while the reading below them moves. */}
          <div data-testid="lab-stage-pinned" className="sticky top-0 z-10 flex flex-col gap-3 border-(--line-hair) border-b bg-(--surface-floor) px-4 pt-3 pb-2">
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

            <Frame position={position} onPosition={setPosition} seated={seatedCheckpoint} experiments={experimentItems} divergence={divergence} failedArmsByFork={partial.byFork} />

            {/* THE FRAME'S OWN TRACE CONTROL (ruling 8). SEAM: `frame/` is
                wave 4b's fence this wave, and the Frame it exposes today takes
                no control of its own, so the control is mounted directly
                beneath the frame at the divergence position rather than inside
                it. When `frame/Frame.tsx` grows a `traceControl` prop, pass
                this node to it and delete this block — the state it drives is
                already the one the tab drives. */}
            {position === 4 && selected !== null ? (
              <TraceControl experiment={selected} openRun={openRun} onOpen={openTrace} idPrefix="lab-frame" />
            ) : null}
          </div>

          <div className="flex flex-col gap-6 px-4 pt-4 pb-8">
            {experiments.status === 'error' ? (
              <p role="status" data-testid="lab-experiments-error" className="text-broken">
                the lab cannot see its experiments — {experiments.message}
              </p>
            ) : experiments.status === 'loading' ? (
              <p data-testid="lab-experiments-loading" className="text-(--ink-dim)">
                loading experiments…
              </p>
            ) : selected === null ? (
              <p data-testid="lab-stage-no-experiment" className="text-(--ink-dim)">
                no experiment is open — the rail lists what there is, and fork from here starts a new one
              </p>
            ) : (
              <section
                id={`lab-experiment-${selected.forkId}`}
                data-testid={`lab-experiment-${selected.forkId}`}
                aria-label={`experiment ${selected.forkId}`}
                className="flex flex-col gap-3"
              >
                {/* ONE RAISED SURFACE, for the experiment the stage is reading. */}
                <header className="flex flex-wrap items-center gap-3 border border-(--line-hair) bg-(--surface-raised) p-3">
                  <BranchingGlyph experiment={selected} />
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className="figures text-(--ink-primary)">{selected.forkId}</span>
                    <span className="text-(--ink-dim)">
                      {selected.arms.length} arm(s) of lane &quot;{selected.parentLane}&quot; at checkpoint {selected.checkpointId}
                    </span>
                    <span data-testid={`lab-experiment-dimensions-${selected.forkId}`} className="text-(--ink-dim)">
                      {experimentDimensionsText(selected)}
                    </span>
                  </div>
                  <div className="ml-auto">
                    {/* Every experiment on the stage carries a measure control
                        (prd-55 ruling 7): success re-reads the workspace's
                        experiments, so a fresh verdict reaches Compare and
                        Metrics without anyone reloading the page. */}
                    <MeasureControl experiment={selected} {...(measureFetchImpl === undefined ? {} : { measureFetchImpl })} onMeasured={reloadExperiments} />
                  </div>
                </header>

                <ol className="flex flex-col gap-1 text-(--ink-body)">
                  {selected.arms.map((arm) => (
                    <li key={arm.arm} data-testid={`lab-branching-arm-${selected.forkId}-${arm.arm}`}>
                      <span className="figures text-(--ink-dim)">{arm.arm}</span> {arm.treatment.model ?? 'default'} —{' '}
                      {arm.treatment.promptDigest === null ? 'no-brief' : arm.treatment.promptDigest.slice(0, 8)} · {arm.runs.length} run
                      {arm.runs.length === 1 ? '' : 's'}
                    </li>
                  ))}
                </ol>

                <TabStrip tab={tab} onTab={setTab} />

                <TabPanel name="Compare" tab={tab}>
                  {experimentHasOutcome(selected) ? null : (
                    <p data-testid={`lab-experiment-no-comparison-${selected.forkId}`} className="mb-2 text-(--ink-dim)">
                      no run has a measured outcome yet — the comparison below shows every run as it stands, and invents nothing
                    </p>
                  )}
                  <ExperimentComparison experiment={selected} failedArms={partial.byFork[selected.forkId] ?? []} />
                </TabPanel>

                <TabPanel name="Trace" tab={tab}>
                  <div className="flex flex-col gap-2">
                    <TraceControl experiment={selected} openRun={openRun} onOpen={openTrace} idPrefix="lab" />
                    {open === null ? (
                      <p data-testid="lab-trace-none-open" className="text-(--ink-dim)">
                        open a run above to read its trace against the parent it forked from
                      </p>
                    ) : (
                      <TraceDiff
                        parentLane={selected.parentLane}
                        laneHandle={open.run.laneHandle}
                        armLabel={`arm ${open.arm} · run ${open.run.run}`}
                        failed={null}
                        {...(fetchImpl === undefined ? {} : { fetchImpl })}
                        onDiff={(summary) => setDivergence({ armLabel: `arm ${open.arm} · run ${open.run.run}`, ...summary })}
                      />
                    )}
                  </div>
                </TabPanel>

                <TabPanel name="Metrics" tab={tab}>
                  <Metrics
                    experiments={[selected]}
                    failedArmsByFork={partial.byFork}
                    onOpenCompare={(forkId) => {
                      openExperiment(forkId)
                      setTab('Compare')
                    }}
                    {...(fetchImpl === undefined ? {} : { fetchImpl })}
                  />
                </TabPanel>
              </section>
            )}

            <section id="lab-launch" aria-labelledby="lab-launch-heading" className="flex flex-col gap-2 border-(--line-hair) border-t pt-4">
              <h2 id="lab-launch-heading" className="heading text-(--ink-dim)">
                Launch
              </h2>
              <LaunchPanel
                {...(fetchImpl === undefined ? {} : { fetchImpl })}
                {...(launchFetchImpl === undefined ? {} : { launchFetchImpl })}
                initialCheckpointId={seated}
                onLaunched={(outcome) => {
                  setLaunches((current) => [...current, outcome])
                  // The record holds the new experiment now; read it back, so it
                  // reaches Compare and Metrics without anyone reloading the page
                  // (prd-55 ruling 7). The partial fact above is kept beside it —
                  // the record holds no intent event, only the launch knew.
                  reloadExperiments()
                }}
              />
            </section>
          </div>
        </main>
      </div>
    </div>
  )
}
