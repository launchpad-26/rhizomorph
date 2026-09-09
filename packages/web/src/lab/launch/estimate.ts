import { capabilityRead } from '../../recordings/capabilityRead.js'
import type { FetchLike } from '../../replay/api.js'

/**
 * `GET /api/lab/estimate` (prd14 ruling 4 — an estimate never appears without
 * its basis). A read, like every other route this package calls except
 * `./launch.ts`'s one write — so this file never spells out a request verb
 * or builds a request init object, and `mutating-calls-law.test.ts`'s sweep
 * never has reason to look at it.
 */

export interface LabEstimate {
  lane: string
  arms: number
  /**
   * Runs of each arm and the spending lanes the server counted — arms × runs
   * (prd53 ruling 1; prd-55 ruling 7). Both present on every answer the server
   * gives today; absent from an older server's, and the panel then states the
   * arm count alone rather than multiplying anything itself.
   */
  runs?: number
  lanes?: number
  /** False means "the rate cannot be established" — never a fabricated or bare-zero number. */
  available: boolean
  windowMs?: number
  costUsdPerHour?: number
  estimatedTotalUsd?: number
  /** Set only when `available` is false — why no number is shown. */
  reason?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parseEstimate(answer: unknown): LabEstimate | null {
  if (!isRecord(answer)) return null
  const { lane, arms, available, runs, lanes } = answer
  if (typeof lane !== 'string' || typeof arms !== 'number' || typeof available !== 'boolean') return null
  // The lanes counted travel with the answer when the server states them, and
  // only then — never computed here from arms × runs, which would be this
  // panel deriving a figure the server did not state.
  const counted = {
    ...(typeof runs === 'number' ? { runs } : {}),
    ...(typeof lanes === 'number' ? { lanes } : {}),
  }

  if (!available) {
    const { reason } = answer
    if (typeof reason !== 'string' || reason.length === 0) return null
    return { lane, arms, ...counted, available, reason }
  }

  const { windowMs, costUsdPerHour, estimatedTotalUsd } = answer
  if (typeof windowMs !== 'number' || typeof costUsdPerHour !== 'number' || typeof estimatedTotalUsd !== 'number') {
    return null
  }
  return { lane, arms, ...counted, available, windowMs, costUsdPerHour, estimatedTotalUsd }
}

/**
 * What the estimate is asked for: the arm count alone (one run per arm, the
 * server's own default, stated by the server), or arms × runs when the operator
 * set runs per arm — `runs` then travels as its own query param, and the server
 * scales by the lanes it counts (prd-55 ruling 7).
 */
export type EstimateCount = number | { arms: number; runs: number }

/** The server's own `{ error }` when it sent one — a refusal explains itself. */
async function refusalDetail(response: { json: () => Promise<unknown> }): Promise<string | null> {
  try {
    const answer: unknown = await response.json()
    const error = isRecord(answer) ? answer.error : undefined
    return typeof error === 'string' && error.length > 0 ? error : null
  } catch {
    return null
  }
}

/**
 * Derived from the forked lane's OWN recent rate (prd14 ruling 4). Throws
 * with a sentence the launch dialog can show — never a bare status code, and
 * never a half-believed answer: a response this doesn't recognise is a
 * failure to estimate, not a `$0.00`.
 */
export async function fetchLabEstimate(
  lane: string,
  count: EstimateCount,
  fetchImpl: FetchLike = capabilityRead,
): Promise<LabEstimate> {
  const arms = typeof count === 'number' ? count : count.arms
  const runsParam = typeof count === 'number' ? '' : `&runs=${encodeURIComponent(String(count.runs))}`
  const url = `/api/lab/estimate?lane=${encodeURIComponent(lane)}&arms=${encodeURIComponent(String(arms))}${runsParam}`

  let response: Response
  try {
    response = await fetchImpl(url)
  } catch (err) {
    throw new Error(`could not reach the instrument: ${err instanceof Error ? err.message : String(err)}`)
  }

  if (!response.ok) {
    const detail = await refusalDetail(response)
    throw new Error(`could not estimate spend — ${detail ?? `the server answered ${response.status}`}`)
  }

  let answer: unknown
  try {
    answer = await response.json()
  } catch {
    throw new Error('the instrument answered something other than an estimate')
  }

  const estimate = parseEstimate(answer)
  if (estimate === null) throw new Error('the instrument answered something other than an estimate')
  return estimate
}
