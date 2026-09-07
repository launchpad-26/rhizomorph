/**
 * THE APP'S SIXTH MUTATING CALL (prd53 ruling 3 — measuring is a write).
 *
 * `lab/launch/launch.ts` is the third; this module is the one and only place
 * a measurement reaches the server from, and `replay/mutating-calls-law.test.ts`
 * enumerates it as such. Measuring LOOKS like a read — "what did arm 2's runs
 * score?" — and is not one: the server runs the arm's gate command in its
 * worktree (real CPU, real minutes, a real `npm test`) and records the
 * verdict on the event log as a `fork.measured`. That is a write twice over,
 * so it wears the same shape of permission as the launch it measures: an
 * explicit operator act, one confirmation, the capability token (#234), and
 * this module as the sole caller.
 *
 * What comes back is a typed outcome per run with its provenance — which
 * command judged it, who ran it, when. `not-run` is a legal outcome and is
 * voiced as exactly that; nothing here ever invents a number for a run
 * nobody measured.
 */

import { CAPABILITY_TOKEN_HEADER, readCapabilityToken } from '../recordings/capability.js'
import { missingTokenMessage, staleTokenMessage } from '../recordings/capability-guidance.js'

export const MEASURE_URL = '/api/lab/measure'

export interface MeasureRequest {
  forkId: string
  /** The gate command run in every run's worktree. The server's default (`npm test`) when absent. */
  verifyCommand?: string
}

export interface MeasuredRun {
  arm: number
  run: number
  laneHandle: string
  verified: 'pass' | 'fail' | 'not-run'
  verifiedDetail: string | null
  commits: number | null
}

export interface MeasureOutcome {
  forkId: string
  verifyCommand: string
  measured: MeasuredRun[]
}

/** The narrowest shape this module needs of `fetch` — see `lab/launch/launch.ts` for why it is not `typeof fetch`. */
export type MeasureFetchLike = (
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

function isMeasuredRun(value: unknown): value is MeasuredRun {
  return (
    isRecord(value) &&
    typeof value.arm === 'number' &&
    typeof value.run === 'number' &&
    typeof value.laneHandle === 'string' &&
    (value.verified === 'pass' || value.verified === 'fail' || value.verified === 'not-run') &&
    (typeof value.verifiedDetail === 'string' || value.verifiedDetail === null) &&
    (typeof value.commits === 'number' || value.commits === null)
  )
}

function parseOutcome(answer: unknown): MeasureOutcome | null {
  if (!isRecord(answer)) return null
  const { forkId, verifyCommand, measured } = answer
  if (typeof forkId !== 'string' || typeof verifyCommand !== 'string') return null
  if (!Array.isArray(measured) || !measured.every(isMeasuredRun)) return null
  return { forkId, verifyCommand, measured }
}

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
 * Measures one experiment: runs the gate in every run's worktree and records
 * a verdict per run. Throws with a sentence the console can show — never a
 * bare status code, and never a half-believed answer.
 */
export async function requestMeasure(request: MeasureRequest, fetchImpl?: MeasureFetchLike): Promise<MeasureOutcome> {
  const impl = fetchImpl ?? (globalThis.fetch as unknown as MeasureFetchLike | undefined)
  if (impl === undefined) throw new Error('this browser has no fetch — cannot measure from here')

  const capabilityToken = readCapabilityToken()
  if (capabilityToken === null) {
    throw new Error(missingTokenMessage('measure'))
  }

  let response: Awaited<ReturnType<MeasureFetchLike>>
  try {
    response = await impl(MEASURE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [CAPABILITY_TOKEN_HEADER]: capabilityToken },
      body: JSON.stringify(request),
    })
  } catch (err) {
    throw new Error(`could not reach the instrument: ${err instanceof Error ? err.message : String(err)}`)
  }

  if (response.status === 401) {
    throw new Error(staleTokenMessage('measure', await refusalDetail(response)))
  }

  if (!response.ok) throw new Error(`could not measure — ${await refusalDetail(response)}`)

  let answer: unknown
  try {
    answer = await response.json()
  } catch {
    throw new Error('the instrument answered something other than a measurement')
  }

  const outcome = parseOutcome(answer)
  if (outcome === null) throw new Error('the instrument answered something other than a measurement')
  return outcome
}
