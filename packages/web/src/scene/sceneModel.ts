import type { AgentStatus, ObservatoryEvent } from '@observatory/core'

/**
 * The scene's read of the event log.
 *
 * This is a fold over the *same* `ObservatoryEvent` stream every other
 * consumer reads — no bespoke data path, no private endpoint. When `core`
 * lands its session reducer + selectors (architecture.md), this module
 * becomes a thin adapter over them: delete the fold, keep the shapes.
 */

/** Silent for longer than this and a station stops reading as "live". */
export const IDLE_AFTER_MS = 45_000
/** Silent for longer than this and a station is flatlined — visibly dim. */
export const FLATLINE_AFTER_MS = 3 * 60_000
/** Per-station commit history kept in memory. A long session stays bounded. */
export const MAX_COMMITS_PER_STATION = 300

export interface SceneCommit {
  sha: string
  ts: number
  message: string
  author: string
  /** Number of files touched — the bead's size cue. */
  files: number
  insertions: number
  deletions: number
}

export type Liveness = 'live' | 'idle' | 'flatline' | 'unknown'

export interface SceneStation {
  /** Worktree path when there is one, else `branch:<name>`. Stable identity. */
  id: string
  label: string
  path: string | null
  branch: string | null
  isMain: boolean
  commits: SceneCommit[]
  aheadOfMain: number | null
  dirtyFiles: number
  paneIds: string[]
  agentStatus: AgentStatus | null
  /** Newest fact of any kind about this station — the liveness clock. */
  lastActivityTs: number | null
  discoveredAt: number
  /** Set when the worktree goes away; drives the convergence animation. */
  removedAt: number | null
}

export interface SceneModel {
  repoName: string | null
  mainBranch: string | null
  /** The main worktree — the central star. Null until it is discovered. */
  trunk: SceneStation | null
  /** Everything orbiting the trunk, in discovery order. */
  stations: SceneStation[]
  commitCount: number
  lastEventTs: number
  eventCount: number
}

export const EMPTY_SCENE_MODEL: SceneModel = {
  repoName: null,
  mainBranch: null,
  trunk: null,
  stations: [],
  commitCount: 0,
  lastEventTs: 0,
  eventCount: 0,
}

interface Draft extends SceneStation {
  order: number
}

/** Folds the event log into everything the constellation needs to draw. */
export function buildSceneModel(events: readonly ObservatoryEvent[]): SceneModel {
  const stations = new Map<string, Draft>()
  const stationIdByBranch = new Map<string, string>()
  const stationIdByPane = new Map<string, string>()

  let repoName: string | null = null
  let mainBranch: string | null = null
  let lastEventTs = 0
  let order = 0

  function ensure(id: string, ts: number): Draft {
    const existing = stations.get(id)
    if (existing) return existing
    const created: Draft = {
      id,
      label: labelFor(id),
      path: id.startsWith('branch:') ? null : id,
      branch: id.startsWith('branch:') ? id.slice('branch:'.length) : null,
      isMain: false,
      commits: [],
      aheadOfMain: null,
      dirtyFiles: 0,
      paneIds: [],
      agentStatus: null,
      lastActivityTs: null,
      discoveredAt: ts,
      removedAt: null,
      order: order++,
    }
    stations.set(id, created)
    return created
  }

  /** Resolve the station a fact belongs to, creating a branch-only one if needed. */
  function resolve(hints: {
    worktreePath?: string | null
    branch?: string | null
    paneId?: string
    ts: number
  }): Draft | null {
    const { worktreePath, branch, paneId, ts } = hints
    if (worktreePath) return ensure(worktreePath, ts)
    if (paneId) {
      const viaPane = stationIdByPane.get(paneId)
      if (viaPane) return stations.get(viaPane) ?? null
    }
    if (branch) {
      const viaBranch = stationIdByBranch.get(branch)
      if (viaBranch) return stations.get(viaBranch) ?? null
      return ensure(`branch:${branch}`, ts)
    }
    return null
  }

  function touch(station: Draft, ts: number): void {
    station.lastActivityTs = Math.max(station.lastActivityTs ?? 0, ts)
  }

  for (const event of events) {
    lastEventTs = Math.max(lastEventTs, event.ts)

    switch (event.type) {
      case 'session.started': {
        repoName = event.payload.repoName
        mainBranch = event.payload.mainBranch ?? mainBranch
        break
      }
      case 'worktree.discovered': {
        const station = ensure(event.payload.path, event.ts)
        station.branch = event.payload.branch
        station.isMain = event.payload.isMain
        station.removedAt = null
        station.label = event.payload.branch ?? labelFor(event.payload.path)
        if (event.payload.branch) stationIdByBranch.set(event.payload.branch, station.id)
        if (event.payload.isMain && mainBranch === null) mainBranch = event.payload.branch
        touch(station, event.ts)
        break
      }
      case 'worktree.removed': {
        const station = stations.get(event.payload.path)
        if (station) station.removedAt = event.ts
        break
      }
      case 'branch.updated': {
        const station = resolve({
          worktreePath: event.payload.worktreePath,
          branch: event.payload.branch,
          ts: event.ts,
        })
        if (!station) break
        station.branch ??= event.payload.branch
        stationIdByBranch.set(event.payload.branch, station.id)
        if (event.payload.aheadOfMain !== undefined && event.payload.aheadOfMain !== null) {
          station.aheadOfMain = event.payload.aheadOfMain
        }
        touch(station, event.ts)
        break
      }
      case 'commit.landed': {
        const station = resolve({
          worktreePath: event.payload.worktreePath,
          branch: event.payload.branch,
          ts: event.ts,
        })
        if (!station) break
        if (!station.commits.some((commit) => commit.sha === event.payload.sha)) {
          station.commits.push({
            sha: event.payload.sha,
            ts: event.payload.authoredAt ?? event.ts,
            message: firstLine(event.payload.message),
            author: event.payload.author.name,
            files: event.payload.files.length,
            insertions: event.payload.insertions ?? 0,
            deletions: event.payload.deletions ?? 0,
          })
          if (station.commits.length > MAX_COMMITS_PER_STATION) {
            station.commits.splice(0, station.commits.length - MAX_COMMITS_PER_STATION)
          }
        }
        touch(station, event.ts)
        break
      }
      case 'worktree.dirty': {
        const station = resolve({
          worktreePath: event.payload.path,
          branch: event.payload.branch,
          ts: event.ts,
        })
        if (!station) break
        // Snapshot semantics: each event replaces the previous set.
        station.dirtyFiles = event.payload.files.length
        touch(station, event.ts)
        break
      }
      case 'pane.discovered': {
        const station = resolve({ worktreePath: event.payload.worktreePath, ts: event.ts })
        if (!station) break
        stationIdByPane.set(event.payload.paneId, station.id)
        if (!station.paneIds.includes(event.payload.paneId)) {
          station.paneIds.push(event.payload.paneId)
        }
        touch(station, event.ts)
        break
      }
      case 'pane.closed': {
        const stationId = stationIdByPane.get(event.payload.paneId)
        stationIdByPane.delete(event.payload.paneId)
        const station = stationId === undefined ? undefined : stations.get(stationId)
        if (station) {
          station.paneIds = station.paneIds.filter((id) => id !== event.payload.paneId)
        }
        break
      }
      case 'pane.activity': {
        const station = resolve({ paneId: event.payload.paneId, ts: event.ts })
        // Pane activity is the heartbeat — it only ever moves the clock.
        if (station) touch(station, event.ts)
        break
      }
      case 'agent.status': {
        const station = resolve({
          worktreePath: event.payload.worktreePath,
          branch: event.payload.branch,
          ts: event.ts,
        })
        if (!station) break
        station.agentStatus = event.payload.status
        touch(station, event.ts)
        break
      }
      default:
        // collector.error / collector.disabled say nothing about a station.
        break
    }
  }

  const ordered = [...stations.values()].sort((a, b) => a.order - b.order)
  const trunk = ordered.find((station) => station.isMain) ?? null
  const orbiting = ordered.filter((station) => station !== trunk)

  return {
    repoName,
    mainBranch,
    trunk: trunk === null ? null : strip(trunk),
    stations: orbiting.map(strip),
    commitCount: ordered.reduce((total, station) => total + station.commits.length, 0),
    lastEventTs,
    eventCount: events.length,
  }
}

/** How alive a station looks, from its newest fact of any kind. */
export function stationLiveness(station: SceneStation, now: number): Liveness {
  if (station.lastActivityTs === null) return 'unknown'
  const age = now - station.lastActivityTs
  if (age <= IDLE_AFTER_MS) return 'live'
  if (age <= FLATLINE_AFTER_MS) return 'idle'
  return 'flatline'
}

/** Emissive multiplier per liveness — flatline is dim, not invisible. */
export function livenessGlow(liveness: Liveness): number {
  switch (liveness) {
    case 'live':
      return 1
    case 'idle':
      return 0.45
    case 'flatline':
      return 0.12
    case 'unknown':
      return 0.25
  }
}

/** Newest commit across the whole swarm, or null when nothing has landed. */
export function latestCommitTs(model: SceneModel): number | null {
  let latest: number | null = null
  for (const station of allStations(model)) {
    for (const commit of station.commits) {
      if (latest === null || commit.ts > latest) latest = commit.ts
    }
  }
  return latest
}

/** Trunk first, then orbiting stations. */
export function allStations(model: SceneModel): SceneStation[] {
  return model.trunk === null ? model.stations : [model.trunk, ...model.stations]
}

function strip({ order: _order, ...station }: Draft): SceneStation {
  return station
}

function labelFor(id: string): string {
  const path = id.startsWith('branch:') ? id.slice('branch:'.length) : id
  const parts = path.split('/').filter(Boolean)
  return parts.length === 0 ? path : (parts[parts.length - 1] as string)
}

function firstLine(message: string): string {
  const [line] = message.split('\n')
  return line ?? message
}
