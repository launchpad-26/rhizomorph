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
 * every arm's own model and brief — so it carries a body, the one header a
 * JSON body needs the server to parse it, and nothing else.
 */

export const LAUNCH_URL = '/api/lab/launch'

export interface LaunchArmInput {
  model?: string
  brief?: string
}

export interface LaunchRequest {
  lane: string
  checkpointId: string
  arms: LaunchArmInput[]
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
}

/**
 * The narrowest shape this module needs of `fetch`: one url, one init naming
 * the verb, the one header the JSON body requires, and the body itself.
 * Deliberately not `typeof fetch` — a test injecting this cannot accidentally
 * be handed a way to smuggle credentials, because the type has nowhere to
 * put them.
 */
export type LaunchFetchLike = (
  input: string,
  init: { method: 'POST'; headers: { 'Content-Type': 'application/json' }; body: string },
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

function parseOutcome(answer: unknown): LaunchOutcome | null {
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

  let response: Awaited<ReturnType<LaunchFetchLike>>
  try {
    response = await impl(LAUNCH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    })
  } catch (err) {
    throw new Error(`could not reach the instrument: ${err instanceof Error ? err.message : String(err)}`)
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
  return outcome
}
