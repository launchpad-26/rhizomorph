/**
 * THE APP'S THIRD MUTATING CALL (prd14 ruling 2/4).
 *
 * `replay/rotate.ts` and `recordings/label.ts` are the first two;
 * `replay/mutating-calls-law.test.ts` enumerates the app's whole mutating
 * surface, and this module is the third entry in it, deliberately, not an
 * exception to it. Launching an experiment is constitutional for a different
 * reason than the other two (it writes real git objects and spends real
 * money — prd12 rulings 1 and 3), but the SAME shape of permission applies:
 * an EXPLICIT OPERATOR ACT, never a background poll, gates it, and this
 * module is the one and only place that act reaches the server from.
 *
 * Unlike rotation, a launch has plenty to say — which lane, which checkpoint,
 * every arm's own model and brief — so it carries a payload, the one header a
 * JSON payload needs the server to parse it, and — since #234 — the
 * per-process capability token the route now requires.
 *
 * **Why the token (#234).** This route forks a worktree and dispatches a live
 * agent that spends real money, and until #234 the only thing standing in
 * front of it was the app-wide Origin/Host guard, which deliberately admits a
 * request carrying no `Origin` at all — every non-browser caller, a bare
 * `curl` included. The token (`server/src/api/security.ts`) closes that half.
 * This module reads it off the served page through
 * `../../recordings/capability.js`, the one module in the app that ever
 * touches the meta tag — the same read `recordings/label.ts` has done since
 * #249 and `replay/rotate.ts` now does too.
 */

import { missingTokenMessage, staleTokenMessage } from '../../recordings/capability-guidance.js'
import { CAPABILITY_TOKEN_HEADER, readCapabilityToken } from '../../recordings/capability.js'

export const LAUNCH_URL = '/api/lab/launch'

export interface LaunchArmInput {
  model?: string
  brief?: string
}

export interface LaunchRequest {
  lane: string
  checkpointId: string
  arms: LaunchArmInput[]
  /**
   * Runs of every arm (prd53 ruling 1) and the operator's declared ceiling in
   * spending lanes (prd53 ruling 6). Both travel ONLY when set — the panel
   * leaves the key out when the field is blank, so the server's own defaults
   * (one run; the ceiling of 8) rule and nothing here restates them (prd-55
   * ruling 7). The server validates both and records the override on every
   * fork.dispatched it produces.
   */
  runs?: number
  ceilingOverride?: number
}

export interface LaunchedArm {
  arm: number
  model: string | null
  briefProvided: boolean
  forkId: string
  laneHandle: string
  worktreePath: string
  launched: boolean
}

export interface LaunchOutcome {
  parentLane: string
  checkpointId: string
  arms: LaunchedArm[]
  failed: { arm: number; error: string } | null
  /**
   * How many arms the launch ASKED for (prd-55 ruling 7). The server stops at
   * the first failed arm and never echoes this, so it is stamped here from the
   * request — the one place that knows it. The partial-launch line reads
   * "k of N requested arms dispatched" from it; it used to invent N as
   * dispatched + 1, which understated every launch that stopped before its
   * last arm (the wave-3 review's finding).
   */
  requestedArms: number
}

/** What the route answers — {@link LaunchOutcome} without the count only the request knows. */
type LaunchAnswer = Omit<LaunchOutcome, 'requestedArms'>

/**
 * The narrowest shape this module needs of `fetch`: one url, one init naming
 * the verb, the two headers a gated mutation with a JSON payload needs — the
 * `Content-Type` the server parses it by, and (since #234) the per-process
 * capability token — and the payload itself. Deliberately not `typeof fetch`
 * — a test injecting this cannot accidentally be handed a way to smuggle a
 * credential, because the type has nowhere to put one beyond these two named
 * headers.
 */
export type LaunchFetchLike = (
  input: string,
  init: {
    method: 'POST'
    headers: { 'Content-Type': 'application/json'; 'x-rhizomorph-capability': string }
    body: string
  },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isLaunchedArm(value: unknown): value is LaunchedArm {
  return (
    isRecord(value) &&
    typeof value.arm === 'number' &&
    (typeof value.model === 'string' || value.model === null) &&
    typeof value.briefProvided === 'boolean' &&
    typeof value.forkId === 'string' &&
    typeof value.laneHandle === 'string' &&
    typeof value.worktreePath === 'string' &&
    typeof value.launched === 'boolean'
  )
}

function parseOutcome(answer: unknown): LaunchAnswer | null {
  if (!isRecord(answer)) return null
  const { parentLane, checkpointId, arms, failed } = answer
  if (typeof parentLane !== 'string' || typeof checkpointId !== 'string') return null
  if (!Array.isArray(arms) || !arms.every(isLaunchedArm)) return null

  if (failed === null) return { parentLane, checkpointId, arms, failed: null }
  if (!isRecord(failed) || typeof failed.arm !== 'number' || typeof failed.error !== 'string') return null
  return { parentLane, checkpointId, arms, failed: { arm: failed.arm, error: failed.error } }
}

/** The server's own `{ error }` when it sent one — a refusal explains itself. */
async function refusalDetail(response: { status: number; json: () => Promise<unknown> }): Promise<string> {
  try {
    const answer: unknown = await response.json()
    const error = isRecord(answer) ? answer.error : undefined
    if (typeof error === 'string' && error.length > 0) return error
  } catch {
    // fall through to the status
  }
  return `the server answered ${response.status}`
}

/**
 * Launches one experiment — the ONE confirmation prd14 ruling 4 asks for.
 * Throws with a sentence the launch dialog can show — never a bare status
 * code, and never a half-believed answer: a response this doesn't recognise
 * is a failure to report, not a launch that didn't happen. A `failed` arm on
 * the returned outcome is not thrown: the arms before it already dispatched
 * and already spent real money, and that is reported, never discarded.
 */
export async function requestLaunch(request: LaunchRequest, fetchImpl?: LaunchFetchLike): Promise<LaunchOutcome> {
  const impl = fetchImpl ?? (globalThis.fetch as unknown as LaunchFetchLike | undefined)
  if (impl === undefined) throw new Error('this browser has no fetch — cannot launch from here')

  // Refused here rather than dispatched bare, so the operator reads what is
  // missing instead of a 401 naming a header they cannot supply. ADR-0012's
  // known dev-mode gap made honest, not closed: under `npm run dev:web` vite
  // serves index.html itself, so the server's injection never runs.
  const capabilityToken = readCapabilityToken()
  if (capabilityToken === null) {
    throw new Error(missingTokenMessage('launch'))
  }

  let response: Awaited<ReturnType<LaunchFetchLike>>
  try {
    response = await impl(LAUNCH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [CAPABILITY_TOKEN_HEADER]: capabilityToken },
      body: JSON.stringify(request),
    })
  } catch (err) {
    throw new Error(`could not reach the instrument: ${err instanceof Error ? err.message : String(err)}`)
  }

  // See `replay/rotate.ts` for the full reasoning: a 401 here means the token
  // was sent and rejected, which in practice means the tab outlived the server
  // process that minted it. It matters more here than there — by this point
  // the operator has configured every arm and read a spend estimate, so a
  // refusal that doesn't say "reload" costs them all of it twice.
  if (response.status === 401) {
    throw new Error(staleTokenMessage('launch', await refusalDetail(response)))
  }

  if (!response.ok) throw new Error(`could not launch — ${await refusalDetail(response)}`)

  let answer: unknown
  try {
    answer = await response.json()
  } catch {
    throw new Error('the instrument answered something other than a launch result')
  }

  const outcome = parseOutcome(answer)
  if (outcome === null) throw new Error('the instrument answered something other than a launch result')
  // The request's own count, not a figure rebuilt from what came back.
  return { ...outcome, requestedArms: request.arms.length }
}
