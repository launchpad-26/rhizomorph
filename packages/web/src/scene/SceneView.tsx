import type { ObservatoryEvent } from '@observatory/core'
import { Canvas } from '@react-three/fiber'
import { useEffect, useMemo, useState } from 'react'
import { Constellation } from './Constellation.js'
import { CONVERGENCE_MS, layoutScene } from './layout.js'
import { PALETTE, STATUS_COLOR } from './palette.js'
import {
  allStations,
  buildSceneModel,
  stationLiveness,
  type Liveness,
  type SceneStation,
} from './sceneModel.js'

/**
 * The DOM half of the scene: capability guard, WebGL canvas, and the HTML
 * overlay that carries every readable label. Text stays in the DOM rather
 * than in three.js so it is crisp, themeable, selectable and — via the
 * station list — keyboard-focusable.
 */

export interface SceneViewProps {
  events: readonly ObservatoryEvent[]
  /** True when `events` is the built-in fixture log, not live data. */
  demo?: boolean
  /** Test seam: force the WebGL path on or off instead of detecting it. */
  webgl?: boolean
}

export function SceneView({ events, demo = false, webgl }: SceneViewProps) {
  const model = useMemo(() => buildSceneModel(events), [events])
  const [converging, setConverging] = useState(false)
  const now = useSceneClock(converging)
  const layout = useMemo(() => layoutScene(model, now), [model, now])
  const supported = useMemo(() => webgl ?? detectWebgl(), [webgl])

  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const stations = allStations(model)
  const activeId = hoveredId ?? focusedId
  const active = stations.find((station) => station.id === activeId) ?? null

  // Slow clock normally; fast only while a removed worktree is converging
  // into main, which is the one moment the scene needs animation frames from
  // React rather than from `useFrame`.
  useEffect(() => {
    const newest = model.stations.reduce(
      (latest, station) => Math.max(latest, station.removedAt ?? 0),
      0,
    )
    const remaining = newest === 0 ? 0 : newest + CONVERGENCE_MS - Date.now()
    if (remaining <= 0) return
    setConverging(true)
    const id = setTimeout(() => setConverging(false), remaining)
    return () => clearTimeout(id)
  }, [model])

  return (
    <div className="relative h-full w-full overflow-hidden bg-void">
      {supported ? (
        <Canvas
          camera={{ position: [9, 3.6, 9], fov: 45 }}
          dpr={[1, 1.75]}
          gl={{ antialias: true, powerPreference: 'high-performance' }}
        >
          <Constellation
            model={model}
            layout={layout}
            now={now}
            hoveredId={hoveredId}
            focusedId={focusedId}
            onHover={setHoveredId}
          />
        </Canvas>
      ) : (
        <NoWebglBackdrop />
      )}

      <div className="pointer-events-none absolute inset-0 flex flex-col justify-between p-3 font-mono text-[10px]">
        <div className="flex items-start justify-between gap-3">
          <StationList
            stations={stations}
            now={now}
            activeId={activeId}
            onHover={setHoveredId}
            onFocus={setFocusedId}
          />
          <Header
            repoName={model.repoName}
            worktreeCount={model.worktreeCount}
            commitCount={model.commitCount}
            demo={demo}
            supported={supported}
          />
        </div>
        <div className="flex items-end justify-between gap-3">
          {active ? <Readout station={active} now={now} /> : <div />}
          <Legend />
        </div>
      </div>
    </div>
  )
}

function Header({
  repoName,
  worktreeCount,
  commitCount,
  demo,
  supported,
}: {
  repoName: string | null
  worktreeCount: number
  commitCount: number
  demo: boolean
  supported: boolean
}) {
  return (
    <div className="pointer-events-none text-right uppercase tracking-widest text-slate-500">
      <div className="text-neon-cyan text-glow-cyan">{repoName ?? 'constellation'}</div>
      <div>
        {worktreeCount} worktrees · {commitCount} commits
      </div>
      {demo && <div className="text-neon-amber">demo data — awaiting stream</div>}
      {!supported && <div className="text-neon-magenta">no webgl — text mode</div>}
    </div>
  )
}

function StationList({
  stations,
  now,
  activeId,
  onHover,
  onFocus,
}: {
  stations: SceneStation[]
  now: number
  activeId: string | null
  onHover: (id: string | null) => void
  onFocus: (id: string | null) => void
}) {
  if (stations.length === 0) {
    return (
      <div className="uppercase tracking-widest text-slate-600">no worktrees discovered yet</div>
    )
  }

  return (
    <ul
      className="pointer-events-auto max-h-full w-44 overflow-y-auto"
      aria-label="Constellation stations"
    >
      {stations.map((station) => {
        const liveness = stationLiveness(station, now)
        return (
          <li key={station.id}>
            <button
              type="button"
              onMouseEnter={() => onHover(station.id)}
              onMouseLeave={() => onHover(null)}
              onFocus={() => onFocus(station.id)}
              onBlur={() => onFocus(null)}
              className={`flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left ${
                station.id === activeId ? 'bg-void-line text-neon-cyan' : 'text-slate-400'
              } hover:text-neon-cyan focus:outline-none focus-visible:ring-1 focus-visible:ring-neon-cyan`}
            >
              <LivenessDot liveness={liveness} status={station.agentStatus} />
              <span className="truncate">{station.label}</span>
              <span className="ml-auto tabular-nums text-slate-600">
                {station.commits.length}
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

function Readout({ station, now }: { station: SceneStation; now: number }) {
  const liveness = stationLiveness(station, now)
  const latest = station.commits[station.commits.length - 1]
  return (
    <div className="pointer-events-none max-w-[22rem] rounded border border-void-line bg-void-raised/90 px-2 py-1.5 text-slate-300 backdrop-blur">
      <div className="flex items-center gap-1.5 text-neon-cyan">
        <LivenessDot liveness={liveness} status={station.agentStatus} />
        <span className="truncate font-semibold">{station.label}</span>
        {station.isMain && <span className="text-slate-500">· main</span>}
      </div>
      <div className="text-slate-500">
        {station.commits.length} commits
        {station.aheadOfMain !== null && ` · ${station.aheadOfMain} ahead`}
        {station.dirtyFiles > 0 && ` · ${station.dirtyFiles} dirty`}
        {' · '}
        {liveness}
        {station.agentStatus && ` · ${station.agentStatus}`}
        {station.removedAt !== null && ' · removed'}
      </div>
      {latest && <div className="truncate text-slate-400">{latest.message}</div>}
    </div>
  )
}

const LEGEND: { color: string; label: string }[] = [
  { color: PALETTE.cyan, label: 'working' },
  { color: PALETTE.amber, label: 'waiting / pulse' },
  { color: PALETTE.magenta, label: 'done' },
  { color: PALETTE.dim, label: 'flatline' },
]

function Legend() {
  return (
    <div className="pointer-events-none flex gap-2 uppercase tracking-widest text-slate-600">
      {LEGEND.map((entry) => (
        <span key={entry.label} className="flex items-center gap-1">
          <span
            className="inline-block h-1.5 w-1.5 rounded-full"
            style={{ backgroundColor: entry.color }}
          />
          {entry.label}
        </span>
      ))}
    </div>
  )
}

function LivenessDot({
  liveness,
  status,
}: {
  liveness: Liveness
  status: SceneStation['agentStatus']
}) {
  const color = status ? STATUS_COLOR[status] : PALETTE.cyan
  const opacity = liveness === 'live' ? 1 : liveness === 'idle' ? 0.5 : 0.2
  return (
    <span
      aria-hidden
      className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
      style={{ backgroundColor: color, opacity }}
    />
  )
}

/** Degradation, not failure: the labels survive without a GPU. */
function NoWebglBackdrop() {
  return (
    <div
      className="h-full w-full"
      style={{
        background: `radial-gradient(circle at 50% 45%, ${PALETTE.line} 0%, ${PALETTE.void} 65%)`,
      }}
    />
  )
}

/**
 * r3f needs both a GL context and `ResizeObserver` to measure the canvas.
 * The `ResizeObserver` check comes first so jsdom never touches `getContext`.
 */
export function detectWebgl(): boolean {
  if (typeof window === 'undefined' || typeof ResizeObserver === 'undefined') return false
  try {
    const canvas = document.createElement('canvas')
    return Boolean(canvas.getContext('webgl2') ?? canvas.getContext('webgl'))
  } catch {
    return false
  }
}

/** Liveness is a function of elapsed time, so the view needs its own clock. */
function useSceneClock(fast: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), fast ? 200 : 5_000)
    return () => clearInterval(id)
  }, [fast])
  return now
}
