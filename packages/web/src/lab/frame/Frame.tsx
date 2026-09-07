import type { KeyboardEvent } from 'react'
import { AXIS_INSET, markerX, percentLabel, sessionFraction } from '../axis/index.js'
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

export interface FrameProps {
  position: FramePosition
  onPosition: (position: FramePosition) => void
  seated: LabCheckpoint | null
  experiments: readonly LabExperiment[]
  /** What Trace last read for the selected arm, or null when no arm's trace is open. */
  divergence?: DivergenceSummary | null
  width?: number
}

export function Frame({ position, onPosition, seated, experiments, divergence = null, width = 1000 }: FrameProps) {
  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (/^[1-5]$/.test(event.key)) {
      event.preventDefault()
      onPosition(Number(event.key) as FramePosition)
    }
  }

  const x = seated === null ? null : markerX(seated, width)
  const pct = seated === null ? null : percentLabel(sessionFraction(seated.sessionCutByte, seated.sessionByteLength))
  const here = experiments.filter((experiment) => seated !== null && experiment.checkpointId === seated.checkpointId)

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
          <Gap label="telemetry" basis="the lane's OTEL readings are already in the fold; no lab route carries them yet">
            this position states its gap rather than drawing a series from nothing — a lab route for the lane's telemetry at a byte is unfiled work (prd-53 Open questions)
          </Gap>
        ) : position === 2 ? (
          <CostPanel experiments={here} />
        ) : position === 3 ? (
          <Gap label="scene" basis="ruling 5 — n organisms, one per run, drawn from real multi-run experiments">
            the lane canvas is wave 4 (#329). This position holds its place, and the charter's coexist-by-surface record says why it may: a different surface, a different picture, both lawful.
          </Gap>
        ) : position === 4 ? (
          divergence === null ? (
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
          )
        ) : (
          <Gap label="footprint" basis="selectFilesTouchedByBranch ∩ selectCollisionMap — both core selectors, neither on a lab route yet">
            this position states its gap rather than drawing a footprint from nothing
          </Gap>
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
