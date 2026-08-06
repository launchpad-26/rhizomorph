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
  const { lane, arms, available } = answer
  if (typeof lane !== 'string' || typeof arms !== 'number' || typeof available !== 'boolean') return null

  if (!available) {
    const { reason } = answer
    if (typeof reason !== 'string' || reason.length === 0) return null
    return { lane, arms, available, reason }
  }

  const { windowMs, costUsdPerHour, estimatedTotalUsd } = answer
  if (typeof windowMs !== 'number' || typeof costUsdPerHour !== 'number' || typeof estimatedTotalUsd !== 'number') {
    return null
  }
  return { lane, arms, available, windowMs, costUsdPerHour, estimatedTotalUsd }
}

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
export async function fetchLabEstimate(lane: string, arms: number, fetchImpl: FetchLike = fetch): Promise<LabEstimate> {
  const url = `/api/lab/estimate?lane=${encodeURIComponent(lane)}&arms=${encodeURIComponent(String(arms))}`

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
