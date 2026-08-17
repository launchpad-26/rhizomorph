/**
 * UPDATES THAT NEVER INTERRUPT (#564; prd-34 ruling 3 and **S3**, D44).
 *
 * "An app that runs unattended must not restart under a running fleet." S3's
 * whole specification is a set of refusals, so this module is a gate rather
 * than a driver: it says what may happen, and `main/updates.ts` does the small
 * remainder.
 *
 * ## The one hard law
 *
 * **No update path may relaunch. Ever.** Not "not while the fleet is live" —
 * the gate does not have to know whether the fleet is live to answer, because
 * an automatic relaunch is refused on a quiet fleet too. That is a strictly
 * stronger promise than the acceptance asked for ("a test asserts no update
 * path can trigger a relaunch while the fleet is live"), and it is stronger in
 * the direction that matters: "is the fleet live" is a judgement call with an
 * edge case, and an updater that had to make it correctly would eventually
 * make it wrong at 3am. A person may restart whenever they like; the app may
 * not restart itself, and there is no argument by which it could.
 *
 * ## The states, and where each one is allowed to be visible
 *
 * S3 lists them and says how loud each may be: *up to date* · *downloading*
 * (silent) · *ready, will apply on restart* (a quiet, dismissible note, never
 * a modal) · *failed* (silent retry, surfaced only in settings) · *unsigned
 * build* (the note says so, once).
 *
 * `unavailable` is a sixth, and it is this repo's own honest-gap rule rather
 * than a state S3 forgot: **ruling 9 deferred signing, and there is no update
 * feed today.** An updater that reported "up to date" with no feed configured
 * would be claiming a check it never made — the same species of lie as a green
 * suite over a run that checked nothing. So the absence has a name, it says
 * what would make it available, and `main/updates.ts` reports it rather than
 * silently doing nothing.
 */

export type UpdatePhase = 'unavailable' | 'idle' | 'checking' | 'downloading' | 'ready' | 'failed'

export interface UpdateState {
  phase: UpdatePhase
  /** The version waiting to be applied, when there is one. */
  version: string | null
  /** Why, for `failed` and `unavailable`. Null otherwise. */
  detail: string | null
  /** True while builds ship unsigned (ruling 9). Carried so the note can say so, once. */
  unsigned: boolean
}

export const UNAVAILABLE_REASON =
  'no update feed is configured — builds ship unsigned while signing is deferred (prd-34 ruling 9), so there is nothing to check against yet'

export function unavailableUpdates(): UpdateState {
  return { phase: 'unavailable', version: null, detail: UNAVAILABLE_REASON, unsigned: true }
}

/** Who is asking to relaunch. The distinction the law turns on. */
export type Requester = 'update-path' | 'person'

export interface RelaunchDecision {
  allowed: boolean
  /** Said in full, because this is the sentence that ends up in a log or a tooltip when someone asks why nothing happened. */
  why: string
}

export interface RelaunchQuestion {
  state: UpdateState
  requester: Requester
  /** True while the instrument is watching something — a running server with lanes in it. */
  fleetLive: boolean
}

export function relaunchDecision(question: RelaunchQuestion): RelaunchDecision {
  if (question.requester === 'update-path') {
    return {
      allowed: false,
      why: 'an update never restarts the app — it is downloaded quietly and applied the next time you restart it yourself',
    }
  }

  if (question.state.phase !== 'ready') {
    return {
      allowed: false,
      why: `there is no downloaded update to apply (${question.state.phase})`,
    }
  }

  return {
    allowed: true,
    why: question.fleetLive
      ? 'you asked for it: the fleet is live, so the server is stopped cleanly first and the session resumes on the next boot'
      : 'you asked for it, and nothing is being watched right now',
  }
}

/** Whether a download may start. Quiet, and only when a person left it on. */
export function mayDownload(state: UpdateState, downloadAutomatically: boolean): boolean {
  if (state.phase === 'unavailable') return false
  return downloadAutomatically
}

/**
 * The one line the tray shows. Never a modal — S3's "what would make it wrong"
 * names one explicitly, and the only surface a shell has that cannot be
 * dismissed is a dialog, so there is no dialog anywhere in this package.
 */
export function updateNote(state: UpdateState): string {
  switch (state.phase) {
    case 'ready':
      return `update ${state.version ?? ''} ready — it applies when you restart`.replace('  ', ' ')
    case 'downloading':
      return 'downloading an update…'
    case 'checking':
      return 'checking for updates…'
    case 'failed':
      return `update check failed — ${state.detail ?? 'no reason given'}`
    case 'unavailable':
      return `updates unavailable — ${state.detail ?? UNAVAILABLE_REASON}`
    case 'idle':
      return 'up to date'
  }
}
