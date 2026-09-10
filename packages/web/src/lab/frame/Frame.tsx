import { type KeyboardEvent, type ReactNode, useEffect, useState } from 'react'
import { capabilityRead } from '../../recordings/capabilityRead.js'
import type { FetchLike } from '../../replay/api.js'
import { AXIS_INSET, markerX, percentLabel, sessionFraction } from '../axis/index.js'
import { canvasHeightFor, LaneCanvas } from '../canvas/index.js'
import type { FailedArm } from '../compare/types.js'
import { experimentSpend } from '../metrics/spend.js'
import type { LabCheckpoint, LabExperiment } from '../types.js'

/**
 * THE OBSERVABILITY FRAME (prd53 ruling 8, S1, #325): ONE switch over five
 * ways of looking at the seated moment — telemetry, cost, scene, divergence,
 * footprint — every position resolving where it is through the same axis
 * function the track uses (`same-x-law.test.tsx`). Its scene position is the
 * charter's coexist-by-surface record (§8), not a reversal of prd-14 ruling 1:
 * a different surface, a different picture, both lawful.
 *
 * Where a position has no lab route to read yet, it SAYS SO — a stated gap
 * (ruling 7, ruling 10), never a series drawn from nothing. Keys 1–5 select
 * the position.
 *
 * **Telemetry (1) and footprint (5) closed their gaps in prd-55 ruling 6
 * (#402).** Both read the lab's own routes — `GET /api/lab/telemetry` and
 * `GET /api/lab/footprint` (`server/src/api/lab-series.ts`) — never the
 * fleet's panels or routes, keyed to the seated checkpoint's own lane (and,
 * for telemetry, its `sessionCutByte`): the frame fetches both the moment a
 * checkpoint is seated, whichever position is showing, the same way the
 * fleet's own panels read ahead of being looked at. Three states each, empty
 * and refused drawn before live (ruling 9): loading, a stated refusal (an
 * unseen lane, a byte past the session's length, or a transport failure), an
 * honest empty reading (a known lane with nothing recorded or touched yet),
 * and the live figure with its basis.
 *
 * **The divergence position (4) exposes a slot for the workspace's Trace
 * control.** `traceControl` below is an opaque `ReactNode` — the frame does
 * not import anything from `lab/trace/`, so the no-live-fleet law's import
 * graph over `lab/` stays exactly as narrow as it is today. The workspace
 * lane (wave 4a, `LabPage.tsx`) renders the real `<TraceDiff .../>` (or
 * nothing) and passes the result in; this position slots it in below the
 * divergence summary, live or gapped, whenever it is non-null. Wiring which
 * arm's Trace that is is the workspace's own job.
 */
export type FramePosition = 1 | 2 | 3 | 4 | 5

export const POSITIONS: ReadonlyArray<{ position: FramePosition; label: string }> = [
  { position: 1, label: 'telemetry' },
  { position: 2, label: 'cost' },
  { position: 3, label: 'scene' },
  { position: 4, label: 'divergence' },
  { position: 5, label: 'footprint' },
]

export interface DivergenceSummary {
  armLabel: string
  rows: number
  diverged: number
  added: number
  absent: number
}

// ── telemetry (position 1) and footprint (position 5): the lab's own routes,
// read the same way `lab/trace`'s TraceDiff reads `/api/lab/transcript` —
// a plain URL builder, a `capabilityRead`-backed reader that never throws,
// and a `status` union the panel below renders every branch of. ──────────

/** `GET /api/lab/telemetry` (prd-55 ruling 6, #402). */
export function labTelemetryUrl(lane: string, atByte: number): string {
  return `/api/lab/telemetry?lane=${encodeURIComponent(lane)}&atByte=${atByte}`
}

/** `GET /api/lab/footprint` (prd-55 ruling 6, #402). */
export function labFootprintUrl(lane: string): string {
  return `/api/lab/footprint?lane=${encodeURIComponent(lane)}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

export type LabTelemetryReading =
  | { status: 'ready'; lane: string; atByte: number; asOf: number | null; readingCount: number }
  | { status: 'unavailable'; reason: string }
  | { status: 'error'; message: string }

/** One read of `/api/lab/telemetry`, never stored (`trace/no-persistence-law.test.ts`'s rule, restated for this panel). */
export async function readLabTelemetry(lane: string, atByte: number, fetchImpl: FetchLike = capabilityRead): Promise<LabTelemetryReading> {
  try {
    const response = await fetchImpl(labTelemetryUrl(lane, atByte))
    const body: unknown = await response.json().catch(() => null)
    if (!isRecord(body)) {
      return { status: 'error', message: response.ok ? 'the telemetry route answered something other than a reading' : `the telemetry route answered ${response.status}` }
    }
    if (body.available === false) {
      return { status: 'unavailable', reason: typeof body.reason === 'string' ? body.reason : 'no telemetry is available' }
    }
    if (!response.ok) {
      return { status: 'error', message: `the telemetry route answered ${response.status}` }
    }
    const usage = Array.isArray(body.usage) ? body.usage.length : 0
    const costs = Array.isArray(body.costs) ? body.costs.length : 0
    const tools = Array.isArray(body.tools) ? body.tools.length : 0
    const activeTime = Array.isArray(body.activeTime) ? body.activeTime.length : 0
    return {
      status: 'ready',
      lane,
      atByte,
      asOf: typeof body.asOf === 'number' ? body.asOf : null,
      readingCount: usage + costs + tools + activeTime,
    }
  } catch (err) {
    return { status: 'error', message: err instanceof Error ? err.message : String(err) }
  }
}

export type LabFootprintReading =
  | { status: 'ready'; lane: string; files: string[] }
  | { status: 'unavailable'; reason: string }
  | { status: 'error'; message: string }

/** One read of `/api/lab/footprint`, never stored. */
export async function readLabFootprint(lane: string, fetchImpl: FetchLike = capabilityRead): Promise<LabFootprintReading> {
  try {
    const response = await fetchImpl(labFootprintUrl(lane))
    const body: unknown = await response.json().catch(() => null)
    if (!isRecord(body)) {
      return { status: 'error', message: response.ok ? 'the footprint route answered something other than a reading' : `the footprint route answered ${response.status}` }
    }
    if (body.available === false) {
      return { status: 'unavailable', reason: typeof body.reason === 'string' ? body.reason : 'no footprint is available' }
    }
    if (!response.ok) {
      return { status: 'error', message: `the footprint route answered ${response.status}` }
    }
    return { status: 'ready', lane, files: asStringArray(body.files) }
  } catch (err) {
    return { status: 'error', message: err instanceof Error ? err.message : String(err) }
  }
}

export interface FrameProps {
  position: FramePosition
  onPosition: (position: FramePosition) => void
  seated: LabCheckpoint | null
  experiments: readonly LabExperiment[]
  /** What Trace last read for the selected arm, or null when no arm's trace is open. */
  divergence?: DivergenceSummary | null
  /**
   * The workspace's Trace control for the divergence position (prd-55 ruling
   * 8, wave 4a) — an opaque slot, never imported by this file: `LabPage.tsx`
   * renders the real `<TraceDiff .../>` (or nothing, while no arm's trace is
   * open) and hands the result here. Rendered below the divergence summary
   * whenever non-null; the frame does not read or interpret it.
   */
  traceControl?: ReactNode
  /** Arms a launch asked for that never dispatched, by forkId — drawn as stubs on the canvas (ruling 7). */
  failedArmsByFork?: Readonly<Record<string, readonly FailedArm[]>>
  width?: number
  /** Test-only escape hatch for telemetry's and footprint's own reads (prd-55 ruling 6, #402) — mirrors `TraceDiffProps.fetchImpl`. */
  fetchImpl?: FetchLike
}

type SeriesState<T> = { status: 'loading' } | ({ status: 'ready' } & T) | { status: 'unavailable'; reason: string } | { status: 'error'; message: string }

export function Frame({
  position,
  onPosition,
  seated,
  experiments,
  divergence = null,
  traceControl = null,
  failedArmsByFork = {},
  width = 1000,
  fetchImpl,
}: FrameProps) {
  const impl = fetchImpl ?? capabilityRead
  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (/^[1-5]$/.test(event.key)) {
      event.preventDefault()
      onPosition(Number(event.key) as FramePosition)
    }
  }

  const x = seated === null ? null : markerX(seated, width)
  const pct = seated === null ? null : percentLabel(sessionFraction(seated.sessionCutByte, seated.sessionByteLength))
  const here = experiments.filter((experiment) => seated !== null && experiment.checkpointId === seated.checkpointId)

  const [telemetry, setTelemetry] = useState<SeriesState<{ asOf: number | null; readingCount: number }>>({ status: 'loading' })
  const [footprint, setFootprint] = useState<SeriesState<{ files: string[] }>>({ status: 'loading' })

  // Fetched the moment a checkpoint is seated — whichever position is
  // showing — the same way the fleet's own panels read ahead of being looked
  // at, never only when the operator switches to 1 or 5.
  useEffect(() => {
    if (seated === null) return
    let live = true
    setTelemetry({ status: 'loading' })
    void readLabTelemetry(seated.lane, seated.sessionCutByte, impl).then((reading) => {
      if (!live) return
      setTelemetry(reading.status === 'ready' ? { status: 'ready', asOf: reading.asOf, readingCount: reading.readingCount } : reading)
    })
    return () => {
      live = false
    }
  }, [seated?.lane, seated?.sessionCutByte, impl])

  useEffect(() => {
    if (seated === null) return
    let live = true
    setFootprint({ status: 'loading' })
    void readLabFootprint(seated.lane, impl).then((reading) => {
      if (!live) return
      setFootprint(reading.status === 'ready' ? { status: 'ready', files: reading.files } : reading)
    })
    return () => {
      live = false
    }
  }, [seated?.lane, impl])

  return (
    <section data-testid="frame" data-position={position} tabIndex={0} onKeyDown={onKeyDown} className="focus-ring flex flex-col gap-2 outline-none text-read-body text-(--ink-body)">
      <div role="radiogroup" aria-label="frame position" className="flex flex-wrap items-baseline gap-1">
        <span className="heading mr-1 text-(--ink-dim)">frame</span>
        {POSITIONS.map((option) => (
          <button
            key={option.position}
            type="button"
            role="radio"
            aria-checked={option.position === position}
            data-testid={`frame-position-${option.position}`}
            onClick={() => onPosition(option.position)}
            className={`focus-ring border px-1.5 py-0.5 ${option.position === position ? 'border-(--ink-primary) bg-(--surface-raised) text-(--ink-primary)' : 'border-(--line-strong) text-(--ink-dim)'}`}
          >
            <span className="figures text-(--ink-dim)">{option.position}</span> {option.label}
          </button>
        ))}
      </div>

      {/* the position, resolved through the axis — the same x the track drew */}
      <svg viewBox={`0 0 ${width} 24`} className="block h-auto w-full" data-testid="frame-axis">
        <line x1={AXIS_INSET} y1={12} x2={width - AXIS_INSET} y2={12} stroke="var(--line-hair)" strokeWidth={1} />
        {x === null ? null : (
          <g data-testid="frame-playhead" data-x={String(x)}>
            <line x1={x} y1={2} x2={x} y2={22} stroke="var(--color-calm, var(--ink-primary))" strokeWidth={1.5} />
            <text x={x + 6} y={10} fill="var(--color-calm, var(--ink-primary))" fontSize={10} fontFamily="var(--font-mono)">
              {pct}
            </text>
          </g>
        )}
      </svg>

      <div data-testid={`frame-panel-${position}`} className="border border-(--line-hair) p-3">
        {seated === null ? (
          <p className="text-(--ink-dim)">seat the playhead on a checkpoint to look at that moment</p>
        ) : position === 1 ? (
          <TelemetryPanel lane={seated.lane} state={telemetry} />
        ) : position === 2 ? (
          <CostPanel experiments={here} />
        ) : position === 3 ? (
          here.length === 0 ? (
            <p data-testid="frame-scene-empty" className="text-(--ink-dim)">
              no experiment was forked from this checkpoint — there is no organism to draw
            </p>
          ) : (
            <div data-testid="frame-scene" className="flex flex-col gap-2">
              {here.map((experiment) => {
                // THE HEIGHT IS THE PICTURE'S OWN (prd-55 ruling 11): a row per
                // dispatch record plus a row per stub, within the canvas's own
                // bounds. Stage 1's `24 + 18 × runs` was the SVG's guess at a
                // stroke's headroom; a ribbon fanned into a mass needs the
                // band the drawing itself sizes, so the drawing is asked.
                const failed = failedArmsByFork[experiment.forkId] ?? []
                const runs = experiment.arms.reduce((count, arm) => count + arm.runs.length, 0)
                return (
                  <div key={experiment.forkId} className="flex flex-col gap-1">
                    <LaneCanvas experiment={experiment} checkpoint={seated} failedArms={failed} width={width} height={canvasHeightFor(runs, failed.length)} />
                    <span data-basis="scene" className="text-(--ink-dim)">
                      {experiment.forkId} — one ribbon per dispatch record (ruling 5), painted with the scene's own brushes (ruling 11); a different surface from the scene, and lawful beside it (charter §8)
                    </span>
                  </div>
                )
              })}
            </div>
          )
        ) : position === 4 ? (
          <div className="flex flex-col gap-2">
            {divergence === null ? (
              <Gap label="divergence" basis="Trace's own step-by-step classification, accumulated">
                open an arm's trace below to read its divergence here
              </Gap>
            ) : (
              <p data-testid="frame-divergence" className="flex flex-wrap items-baseline gap-2">
                <span data-figure="divergence" className="figures text-(--ink-primary)">
                  {divergence.diverged} of {divergence.rows} steps diverged
                </span>
                <span data-basis="divergence" className="text-(--ink-dim)">
                  {divergence.armLabel} against its parent, step by step (Trace) · {divergence.added} added · {divergence.absent} absent
                </span>
              </p>
            )}
            {traceControl === null ? null : (
              <div data-testid="frame-trace-control" className="border-(--line-hair) border-t pt-2">
                {traceControl}
              </div>
            )}
          </div>
        ) : (
          <FootprintPanel lane={seated.lane} state={footprint} />
        )}
      </div>
    </section>
  )
}

function Gap({ label, basis, children }: { label: string; basis: string; children: string }) {
  return (
    <p data-testid={`frame-gap-${label}`} className="flex flex-col gap-1">
      <span className="text-(--ink-body)">{children}</span>
      <span data-basis={label} className="text-(--ink-dim)">
        source: {basis}
      </span>
    </p>
  )
}

function CostPanel({ experiments }: { experiments: readonly LabExperiment[] }) {
  if (experiments.length === 0) {
    return <p className="text-(--ink-dim)">no experiment was forked from this checkpoint — nothing has spent from here</p>
  }
  return (
    <ol className="flex flex-col gap-1">
      {experiments.map((experiment) => {
        const spend = experimentSpend(experiment)
        return (
          <li key={experiment.forkId} data-testid={`frame-cost-${experiment.forkId}`} className="flex flex-wrap items-baseline gap-2">
            <span className="figures text-(--ink-dim)">{experiment.forkId}</span>
            {spend.bookedUsd === null ? (
              <span className="text-(--ink-dim)">nothing booked yet</span>
            ) : (
              <span data-figure="cost" className="figures text-(--ink-primary)">
                ${spend.bookedUsd.toFixed(2)}
              </span>
            )}
            <span data-basis="cost" className="text-(--ink-dim)">
              {spend.basis}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

/**
 * Position 1 (prd-55 ruling 6, #402): the lane's own OTel readings, sliced at
 * the seated checkpoint's byte. Ruling 9's order — loading, then a stated
 * refusal, then an honest empty reading, before the live figure — is the
 * literal order of the branches below, not an incidental one.
 */
function TelemetryPanel({ lane, state }: { lane: string; state: SeriesState<{ asOf: number | null; readingCount: number }> }) {
  if (state.status === 'loading') {
    return (
      <p data-testid="frame-telemetry-loading" className="text-(--ink-dim)">
        reading {lane}&apos;s OTel telemetry…
      </p>
    )
  }
  if (state.status === 'unavailable' || state.status === 'error') {
    return (
      <Gap label="telemetry" basis="the lab's own telemetry route, GET /api/lab/telemetry">
        {state.status === 'unavailable' ? state.reason : state.message}
      </Gap>
    )
  }
  if (state.readingCount === 0) {
    return (
      <p data-testid="frame-telemetry-empty" className="flex flex-col gap-1">
        <span className="text-(--ink-body)">no OTel readings recorded for {lane} by this point in the session</span>
        <span data-basis="telemetry" className="text-(--ink-dim)">
          source: GET /api/lab/telemetry, asOf {state.asOf === null ? 'the session\'s start' : new Date(state.asOf).toISOString()}
        </span>
      </p>
    )
  }
  return (
    <p data-testid="frame-telemetry" className="flex flex-wrap items-baseline gap-2">
      <span data-figure="telemetry" className="figures text-(--ink-primary)">
        {state.readingCount} OTel reading{state.readingCount === 1 ? '' : 's'}
      </span>
      <span data-basis="telemetry" className="text-(--ink-dim)">
        {lane}, from the fold's usage/cost/tool/active-time slices · as of {state.asOf === null ? 'the session\'s start' : new Date(state.asOf).toISOString()}
      </span>
    </p>
  )
}

/**
 * Position 5 (prd-55 ruling 6, #402): `selectFilesTouchedByBranch ∩
 * selectCollisionMap` for the seated lane, read through
 * `GET /api/lab/footprint`. Same ordering discipline as {@link TelemetryPanel}.
 */
function FootprintPanel({ lane, state }: { lane: string; state: SeriesState<{ files: string[] }> }) {
  if (state.status === 'loading') {
    return (
      <p data-testid="frame-footprint-loading" className="text-(--ink-dim)">
        reading {lane}&apos;s footprint…
      </p>
    )
  }
  if (state.status === 'unavailable' || state.status === 'error') {
    return (
      <Gap label="footprint" basis="selectFilesTouchedByBranch ∩ selectCollisionMap, over the lab's own footprint route">
        {state.status === 'unavailable' ? state.reason : state.message}
      </Gap>
    )
  }
  if (state.files.length === 0) {
    return (
      <p data-testid="frame-footprint-empty" className="flex flex-col gap-1">
        <span className="text-(--ink-body)">{lane} has not touched a file the fold has seen yet</span>
        <span data-basis="footprint" className="text-(--ink-dim)">
          source: selectFilesTouchedByBranch ∩ selectCollisionMap, GET /api/lab/footprint
        </span>
      </p>
    )
  }
  return (
    <div data-testid="frame-footprint" className="flex flex-col gap-1">
      <span data-figure="footprint" className="figures text-(--ink-primary)">
        {state.files.length} file{state.files.length === 1 ? '' : 's'} touched
      </span>
      <ul className="figures flex flex-col gap-0.5 text-(--ink-body)">
        {state.files.map((file) => (
          <li key={file}>{file}</li>
        ))}
      </ul>
      <span data-basis="footprint" className="text-(--ink-dim)">
        {lane} — selectFilesTouchedByBranch ∩ selectCollisionMap, GET /api/lab/footprint
      </span>
    </div>
  )
}
