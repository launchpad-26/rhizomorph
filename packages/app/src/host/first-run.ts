import type { DemoSource } from './demo-mode.js'

/**
 * FIRST RUN (#565; prd-34 rulings 5 and 7, **S1**).
 *
 * > *First launch opens the demonstration fleet, loudly labelled, with one
 * > standing invitation to watch a real repo.*
 *
 * The reason is arithmetic about the empty case, and it is worth restating
 * because it is the whole design: a correctly-installed, correctly-configured
 * app watching a quiet repo renders an empty organism, an empty roster and a
 * zero ledger. A stranger who does everything right sees nothing and concludes
 * the software is broken. So the first thing they see is the instrument
 * working — on real event data through the real reducer and the real renderer,
 * honestly framed.
 *
 * ## The wizard is not here, and that is ruling 7
 *
 * "The wizard is a path through connect and settings and owns no controls."
 * The wizard exists already: `packages/web/src/connect/wizard.tsx`, prd-20's,
 * with its own repo picker, its own conductor step and its own verification
 * rows read off the same fold. **The shell's entire contribution to first run
 * is a plan**: which fixture to show, and when to offer the way to `/connect`.
 * It renders no step, no field and no button of its own — `app-menu.ts` can
 * only *navigate*, and `app-menu.test.ts` holds every destination against the
 * SPA's own router.
 *
 * That is also why this file has no fetch in it. The fetch-driven part of first
 * run is the wizard's, and it is driven with injected fetches in
 * `packages/web/src/connect/wizard.test.tsx` — unchanged and unforked by this
 * package. What is driven here is the part the shell actually owns.
 */

/** What the shell remembers between launches. Deliberately three facts, not a wizard's cursor. */
export interface RunState {
  /** True once the demonstration fleet has been shown at least once. */
  seenDemo: boolean
  /** True once a person has gone to configure rather than watch the demo — S1's *demo declined*. */
  declined: boolean
  /** The repo the shell was last configured to watch, or null. */
  watchedRepo: string | null
}

export const NEW_RUN_STATE: RunState = { seenDemo: false, declined: false, watchedRepo: null }

/** S1's five states, named the way S1 names them. */
export type FirstRunStage = 'first-launch' | 'never-configured' | 'configured' | 'declined'

export interface FirstRunPlan {
  stage: FirstRunStage
  /** The fixture to open on, or null to leave the live log driving. */
  showDemo: DemoSource | null
  /** Whether the standing invitation is offered. */
  invite: boolean
  /** Why, in one line — this ends up in the invitation's own label and in the log. */
  why: string
}

/**
 * The plan for this launch.
 *
 * **The invitation is standing, not a step**: it is offered in every state
 * except the configured one, because a person who skipped it on launch one must
 * be able to take it on launch nine without hunting. And it is *one*
 * invitation — S1 says one — so there is exactly one place in the shell that
 * offers it, `app-menu.ts`'s `watch-my-repo`.
 *
 * The demo is shown on a first launch and on a launch that has still never been
 * configured (S1's "same path, resumable at the step reached"), and **not** to
 * someone who declined it, and **not** to someone already watching a repo. The
 * last one is the important asymmetry: a configured instrument opening on a
 * simulation would be the instrument lying about the fleet it is watching.
 */
export function firstRunPlan(state: RunState, hasRepo: boolean): FirstRunPlan {
  if (hasRepo) {
    return {
      stage: 'configured',
      showDemo: null,
      invite: false,
      why: 'this instrument is watching a repo, so it opens on that repo',
    }
  }

  if (state.declined) {
    return {
      stage: 'declined',
      showDemo: null,
      invite: true,
      why: 'you went straight to configuring it — the demonstration fleet is still in the menu',
    }
  }

  if (!state.seenDemo) {
    return {
      stage: 'first-launch',
      showDemo: 'fleet20',
      invite: true,
      why: 'first launch: this is the demonstration fleet, simulated and labelled — watch your own repo when you are ready',
    }
  }

  return {
    stage: 'never-configured',
    showDemo: 'fleet20',
    invite: true,
    why: 'no repo is configured yet, so this is the demonstration fleet again — the invitation stands',
  }
}

/** The demonstration fleet has been shown. */
export function withDemoSeen(state: RunState): RunState {
  return { ...state, seenDemo: true }
}

/**
 * A person took the invitation, or went straight to configuring. Both mark the
 * demo declined — S1's *demo declined* is "a person who goes straight to
 * configuration skips the demo without argument", and taking the invitation is
 * exactly that act.
 */
export function withInvitationTaken(state: RunState): RunState {
  return { ...state, declined: true }
}

/** A repo is being watched. The wizard's own outcome, observed rather than driven. */
export function withRepo(state: RunState, repoPath: string | null): RunState {
  return { ...state, watchedRepo: repoPath }
}

/** Merges what was on disk onto a new run's defaults, keeping only values of the right shape. */
export function readRunState(stored: unknown): RunState {
  if (typeof stored !== 'object' || stored === null) return { ...NEW_RUN_STATE }
  const record = stored as Record<string, unknown>
  return {
    seenDemo: typeof record.seenDemo === 'boolean' ? record.seenDemo : NEW_RUN_STATE.seenDemo,
    declined: typeof record.declined === 'boolean' ? record.declined : NEW_RUN_STATE.declined,
    watchedRepo: typeof record.watchedRepo === 'string' ? record.watchedRepo : NEW_RUN_STATE.watchedRepo,
  }
}
