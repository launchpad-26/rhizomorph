import type { PaneState, SessionState } from '../state.js'
import { compareStrings } from './touches.js'

/**
 * The flatline detector. A pane's last sign of life is a recorded fact; how
 * long counts as dead is a parameter, so the UI can tune it without a new
 * event type — and replay gets the same answer from the same log.
 */

/** Five minutes of silence is a dead agent, until someone says otherwise. */
export const DEFAULT_FLATLINE_MS = 5 * 60_000

export type LivenessStatus = 'active' | 'idle' | 'flatline' | 'closed' | 'unknown'

export interface LivenessOptions {
  /** Epoch millis to measure against — injected, never read from the clock. */
  now: number
  /** Silence beyond this is a flatline. */
  flatlineMs?: number
  /** Optional earlier warning threshold; defaults to the flatline threshold. */
  idleMs?: number
}

export interface PaneLiveness {
  paneId: string
  windowName: string
  worktreePath: string | null
  status: LivenessStatus
  /** Milliseconds since the last sign of life, clamped at zero. */
  idleMs: number
  lastActivityTs: number
  present: boolean
}

export interface WorktreeLiveness {
  worktreePath: string
  status: LivenessStatus
  /** Null when no live pane was ever mapped to this worktree. */
  idleMs: number | null
  lastActivityTs: number | null
  paneCount: number
  livePaneCount: number
}

export function paneLiveness(pane: PaneState, options: LivenessOptions): PaneLiveness {
  const flatlineMs = options.flatlineMs ?? DEFAULT_FLATLINE_MS
  const idleThreshold = options.idleMs ?? flatlineMs
  const idleMs = Math.max(0, options.now - pane.lastActivityTs)

  const status: LivenessStatus = !pane.present
    ? 'closed'
    : idleMs >= flatlineMs
      ? 'flatline'
      : idleMs >= idleThreshold
        ? 'idle'
        : 'active'

  return {
    paneId: pane.paneId,
    windowName: pane.windowName,
    worktreePath: pane.worktreePath,
    status,
    idleMs,
    lastActivityTs: pane.lastActivityTs,
    present: pane.present,
  }
}

/** Every known pane, quietest first — the ones worth worrying about on top. */
export function selectPaneLiveness(
  state: SessionState,
  options: LivenessOptions,
): PaneLiveness[] {
  return Object.values(state.panes)
    .map((pane) => paneLiveness(pane, options))
    .sort((a, b) => b.idleMs - a.idleMs || compareStrings(a.paneId, b.paneId))
}

export function selectPaneLivenessIndex(
  state: SessionState,
  options: LivenessOptions,
): Record<string, PaneLiveness> {
  const index: Record<string, PaneLiveness> = {}
  for (const pane of selectPaneLiveness(state, options)) index[pane.paneId] = pane
  return index
}

/** Panes that have gone quiet past the threshold — what the UI dims. */
export function selectFlatlinedPanes(
  state: SessionState,
  options: LivenessOptions,
): PaneLiveness[] {
  return selectPaneLiveness(state, options).filter((pane) => pane.status === 'flatline')
}

/**
 * Worktree-level liveness: the liveliest open pane mapped to it wins, since a
 * worktree with one busy pane and one idle pane is busy.
 */
export function selectWorktreeLiveness(
  state: SessionState,
  options: LivenessOptions,
): Record<string, WorktreeLiveness> {
  const result: Record<string, WorktreeLiveness> = {}

  for (const worktree of Object.values(state.worktrees)) {
    result[worktree.path] = {
      worktreePath: worktree.path,
      status: 'unknown',
      idleMs: null,
      lastActivityTs: null,
      paneCount: 0,
      livePaneCount: 0,
    }
  }

  for (const pane of Object.values(state.panes)) {
    const path = pane.worktreePath
    if (path === null) continue
    const entry = result[path] ?? {
      worktreePath: path,
      status: 'unknown' as LivenessStatus,
      idleMs: null,
      lastActivityTs: null,
      paneCount: 0,
      livePaneCount: 0,
    }
    entry.paneCount += 1
    if (!pane.present) {
      result[path] = entry
      continue
    }
    entry.livePaneCount += 1
    if (entry.lastActivityTs === null || pane.lastActivityTs > entry.lastActivityTs) {
      const live = paneLiveness(pane, options)
      entry.lastActivityTs = live.lastActivityTs
      entry.idleMs = live.idleMs
      entry.status = live.status
    }
    result[path] = entry
  }

  // A worktree whose only panes have closed reads as closed, not unknown.
  for (const entry of Object.values(result)) {
    if (entry.livePaneCount === 0 && entry.paneCount > 0) entry.status = 'closed'
  }

  return result
}
