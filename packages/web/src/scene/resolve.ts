import type { ObservatoryEvent } from '@observatory/core'
import type { Fleet } from '../fleet/index.js'

/**
 * Which thread an event travels on.
 *
 * The pulse layer needs one answer to "whose lane is this?", and it has to be
 * the same answer the derived model gave, or a commit would light a thread that
 * the fleet table says belongs to somebody else. So this resolves against
 * {@link Fleet.lanes} — branch, worktree path, telemetry handle, in that order,
 * matching the model's own precedence (spend is keyed by branch, prd1, because a
 * branch outlives its worktree).
 *
 * `null` means **the root-mass**, not "unknown": a commit on main is already
 * home, so it has no journey to make and flares the mass directly. Anything the
 * fleet has never heard of also lands here rather than being invented a thread —
 * the scene declines to draw a lane the model does not have.
 *
 * The list of resolvable types is "every event the scene animates on", which as
 * of prd5 ruling 3 includes `agent.status`: a lane declaring itself `done` is
 * what cuts its cord (`retire.ts`), so it needs the same one answer to "whose
 * lane is this?" that a commit does.
 */

export interface LaneIndex {
  byBranch: Map<string, string>
  byWorktree: Map<string, string>
  byHandle: Map<string, string>
  mainBranch: string | null
  mainWorktree: string | null
}

export function laneIndex(fleet: Fleet): LaneIndex {
  const byBranch = new Map<string, string>()
  const byWorktree = new Map<string, string>()
  const byHandle = new Map<string, string>()

  for (const lane of fleet.lanes) {
    if (lane.branch !== null) byBranch.set(lane.branch, lane.id)
    if (lane.worktreePath !== null) byWorktree.set(lane.worktreePath, lane.id)
    for (const handle of lane.handles) byHandle.set(handle, lane.id)
  }

  return {
    byBranch,
    byWorktree,
    byHandle,
    mainBranch: fleet.root.mainBranch,
    mainWorktree: fleet.root.worktreePath,
  }
}

export function resolveLane(index: LaneIndex, event: ObservatoryEvent): string | null {
  switch (event.type) {
    case 'commit.landed':
      return lookup(index, event.payload.branch, event.payload.worktreePath ?? null, null)
    case 'branch.updated':
      return lookup(index, event.payload.branch, event.payload.worktreePath ?? null, null)
    case 'worktree.discovered':
    case 'worktree.dirty':
      return lookup(index, event.payload.branch ?? null, event.payload.path, null)
    case 'worktree.removed':
      return lookup(index, null, event.payload.path, null)
    // workmux naming a lane's own state. It carries all three identities, and the
    // handle is the one it is *sure* of — the branch and worktree are optional in
    // the schema, because workmux knows what it launched before git has seen it.
    case 'agent.status':
      return lookup(
        index,
        event.payload.branch ?? null,
        event.payload.worktreePath ?? null,
        event.payload.handle,
      )
    case 'llm.usage':
    case 'llm.cost':
    case 'tool.activity':
      return lookup(
        index,
        event.payload.branch ?? null,
        event.payload.worktreePath ?? null,
        event.payload.lane,
      )
    default:
      return null
  }
}

function lookup(
  index: LaneIndex,
  branch: string | null,
  worktreePath: string | null,
  handle: string | null,
): string | null {
  // Main is the mass itself, whatever else the payload says about it.
  if (branch !== null && branch === index.mainBranch) return null
  if (branch === null && worktreePath !== null && worktreePath === index.mainWorktree) return null

  if (branch !== null) {
    const byBranch = index.byBranch.get(branch)
    if (byBranch !== undefined) return byBranch
  }
  if (worktreePath !== null) {
    const byWorktree = index.byWorktree.get(worktreePath)
    if (byWorktree !== undefined) return byWorktree
  }
  if (handle !== null) {
    const byHandle = index.byHandle.get(handle)
    if (byHandle !== undefined) return byHandle
  }
  return null
}
