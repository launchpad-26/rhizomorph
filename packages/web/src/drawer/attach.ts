import type { ObservatoryEvent } from '@observatory/core'
import { MAIN_SELECTION, type Lane, type RootMass } from '../fleet/index.js'

/**
 * THE ATTACH COMMAND (ruling 17) — the one thing in the Observatory that hands
 * an operator a way to *talk* to an agent, and it does it by putting text on
 * the clipboard.
 *
 * The read-only constitution is not a policy this module follows; it is the
 * reason this module exists in the form it does. There is no exec seam here, no
 * websocket, no endpoint. `attachPlan` is a pure function from the event log to
 * a **string**, and the only thing the button does with that string is copy it.
 * Interaction happens in YOUR terminal, under your own hands, with your own
 * keys — which is the entire distinction between an instrument and a remote
 * control.
 *
 * Two identities, in preference order:
 *
 * 1. **tmux, when the log knows it.** The tmux collector records a pane's
 *    session and window at discovery, so a lane with a live pane can be
 *    attached to precisely: `tmux attach -t <session> \; select-window -t
 *    <window>`. Precise beats convenient — this lands you in the right window,
 *    not merely the right session.
 * 2. **workmux, otherwise.** No pane on record means either tmux isn't being
 *    collected or the window hasn't been opened; `workmux open <handle>` is the
 *    command that resolves both, and it is the tool that made the lane in the
 *    first place.
 *
 * And a third state that is not a fallback: a lane whose worktree is *gone* has
 * nothing to attach to, and saying so is better than handing over a command
 * that will fail in the operator's terminal (law 12).
 */

export interface TmuxIdentity {
  sessionName: string
  /** Window index when the collector reported one, else the window name. */
  window: string
  paneId: string
}

interface PlanBase {
  /** One quiet line under the button saying where the command came from. */
  note: string
}

export interface TmuxPlan extends PlanBase {
  kind: 'tmux'
  command: string
  identity: TmuxIdentity
}

export interface WorkmuxPlan extends PlanBase {
  kind: 'workmux'
  command: string
  handle: string
}

export interface NoPlan extends PlanBase {
  kind: 'none'
  command: null
}

export type AttachPlan = TmuxPlan | WorkmuxPlan | NoPlan

/** The only part of a lane the plan needs — so a test can build one by hand. */
export type AttachLane = Pick<Lane, 'id' | 'branch' | 'worktreePath' | 'handles' | 'present'>

/**
 * POSIX shell quoting, so a session or branch with a space in it produces a
 * command that still works when pasted. Bare words stay bare: an operator has
 * to be able to read what they are about to run.
 */
export function shellQuote(value: string): string {
  if (value.length > 0 && /^[A-Za-z0-9_.:@%+=/,-]+$/.test(value)) return value
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function payloadOf(event: ObservatoryEvent): Record<string, unknown> {
  return event.payload as Record<string, unknown>
}

/**
 * The newest still-open pane the log maps to this lane, or null. A pane that
 * was later closed is not an identity: handing over `select-window -t 3` for a
 * window that no longer exists is worse than admitting we don't know.
 */
export function findTmuxIdentity(
  events: readonly ObservatoryEvent[],
  lane: AttachLane,
): TmuxIdentity | null {
  const closed = new Set<string>()
  for (const event of events) {
    if (event.type !== 'pane.closed') continue
    const paneId = payloadOf(event).paneId
    if (typeof paneId === 'string') closed.add(paneId)
  }

  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (!event || event.type !== 'pane.discovered') continue

    const payload = payloadOf(event)
    const paneId = payload.paneId
    if (typeof paneId !== 'string' || closed.has(paneId)) continue

    const belongs =
      (lane.worktreePath !== null &&
        (payload.worktreePath === lane.worktreePath || payload.currentPath === lane.worktreePath)) ||
      (typeof payload.windowName === 'string' &&
        payload.windowName.length > 0 &&
        (payload.windowName === lane.id ||
          payload.windowName === lane.branch ||
          lane.handles.includes(payload.windowName)))
    if (!belongs) continue

    const sessionName = payload.sessionName
    if (typeof sessionName !== 'string' || sessionName.length === 0) continue

    const window =
      typeof payload.windowIndex === 'number'
        ? String(payload.windowIndex)
        : typeof payload.windowName === 'string' && payload.windowName.length > 0
          ? payload.windowName
          : null
    if (window === null) continue

    return { sessionName, window, paneId }
  }

  return null
}

/** The workmux handle for a lane: what `workmux open` calls its worktree. */
export function workmuxHandle(lane: AttachLane): string {
  return lane.handles[0] ?? lane.branch ?? lane.id
}

/** The only part of the root-mass a conductor plan needs. */
export type AttachRoot = Pick<RootMass, 'mainBranch' | 'worktreePath'>

/**
 * THE CONDUCTOR'S OWN PANE (prd6 ruling 5).
 *
 * The same tmux lookup a lane gets, pointed at the root-mass: a pane sitting in
 * the main worktree, or a window named for the main branch or called
 * `conductor` — the handle the sessionlog collector gives an
 * `--extra-sessions` dir by default. It copies a string, like everything else
 * in this file.
 *
 * **No workmux fallback, and that is the point.** `workmux open <handle>` makes
 * a worktree; main is the one place in the repo that is not a workmux lane, so
 * offering it here would hand the operator a command that creates a branch they
 * did not ask for. When there is no pane on record, this says so with the
 * command that would put one there (law 12) — which is a better answer than a
 * plausible one that does the wrong thing.
 */
export function conductorAttachPlan(
  events: readonly ObservatoryEvent[],
  root: AttachRoot,
): AttachPlan {
  const identity = findTmuxIdentity(events, {
    id: MAIN_SELECTION,
    branch: root.mainBranch,
    worktreePath: root.worktreePath,
    handles: ['conductor'],
    present: true,
  })

  if (identity !== null) {
    return {
      kind: 'tmux',
      identity,
      note: `tmux pane ${identity.paneId} — session ${identity.sessionName}, window ${identity.window}`,
      command:
        `tmux attach -t ${shellQuote(identity.sessionName)}` +
        ` \\; select-window -t ${shellQuote(identity.window)}`,
    }
  }

  return {
    kind: 'none',
    command: null,
    note:
      'NO PANE ON RECORD for the conductor — nothing the tmux collector saw sits in ' +
      `${root.worktreePath ?? 'the main worktree'} or answers to “conductor”, so there is no ` +
      'address to attach to — run: `observatory doctor`',
  }
}

export function attachPlan(events: readonly ObservatoryEvent[], lane: AttachLane): AttachPlan {
  if (!lane.present) {
    return {
      kind: 'none',
      command: null,
      note: 'NO WORKTREE — this lane has landed and folded, so there is nothing left to attach to.',
    }
  }

  const identity = findTmuxIdentity(events, lane)
  if (identity !== null) {
    return {
      kind: 'tmux',
      identity,
      note: `tmux pane ${identity.paneId} — session ${identity.sessionName}, window ${identity.window}`,
      command:
        `tmux attach -t ${shellQuote(identity.sessionName)}` +
        ` \\; select-window -t ${shellQuote(identity.window)}`,
    }
  }

  const handle = workmuxHandle(lane)
  return {
    kind: 'workmux',
    handle,
    command: `workmux open ${shellQuote(handle)}`,
    note: 'no tmux pane on record for this lane — workmux will open (or switch to) its window',
  }
}
