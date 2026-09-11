/**
 * THE APP'S SEVENTH MUTATING CALL (prd-14 ruling 5, #214). `POST
 * /api/lab/comparisons` (`packages/server/src/api/lab.ts`) has existed since
 * #213 with no web caller at all — this module is the first one, wired from
 * the comparison surface itself so a finished comparison can be saved as a
 * reopenable artifact without a fixture.
 *
 * Constitutional for the same three reasons the six before it are: it writes
 * only the recording-adjacent sidecar `saveComparison` already lands beside
 * the session logs (ADR-0041), never the watched repo's working tree; it is
 * gated exactly as `/api/lab/launch` and `/api/lab/measure` are, behind the
 * same capability token, because a save is a real write to durable state; and
 * it is reached only from an EXPLICIT OPERATOR ACT — the save control this
 * issue adds to `ExperimentComparison`, never a background poll or a timer.
 * Its payload is the whole `ComparisonInput` the surface is currently
 * showing — nothing the server does not already accept from
 * `parseComparisonInput` (ADR-0042).
 */

import { missingTokenMessage, staleTokenMessage } from '../../recordings/capability-guidance.js'
import { CAPABILITY_TOKEN_HEADER, readCapabilityToken } from '../../recordings/capability.js'
import type { ComparisonInput } from './types.js'

export const SAVE_COMPARISON_URL = '/api/lab/comparisons'

export interface SavedComparison {
  id: string
  savedAt: string
}

/** The narrowest shape this module needs of `fetch` — see `lab/measure.ts` for why it is not `typeof fetch`. */
export type SaveComparisonFetchLike = (
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

function parseOutcome(answer: unknown): SavedComparison | null {
  if (!isRecord(answer)) return null
  const { id, savedAt } = answer
  if (typeof id !== 'string' || id.length === 0) return null
  if (typeof savedAt !== 'string' || savedAt.length === 0) return null
  return { id, savedAt }
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
 * Saves a finished comparison as a reopenable artifact. Throws with a
 * sentence the save control can show — never a bare status code, and never a
 * half-believed answer: a response this doesn't recognise is a failure, not
 * a save.
 */
export async function saveComparison(
  input: ComparisonInput,
  fetchImpl?: SaveComparisonFetchLike,
): Promise<SavedComparison> {
  const impl = fetchImpl ?? (globalThis.fetch as unknown as SaveComparisonFetchLike | undefined)
  if (impl === undefined) throw new Error('this browser has no fetch — cannot save this comparison from here')

  const capabilityToken = readCapabilityToken()
  if (capabilityToken === null) {
    throw new Error(missingTokenMessage('save this comparison'))
  }

  let response: Awaited<ReturnType<SaveComparisonFetchLike>>
  try {
    response = await impl(SAVE_COMPARISON_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [CAPABILITY_TOKEN_HEADER]: capabilityToken },
      body: JSON.stringify({ input }),
    })
  } catch (err) {
    throw new Error(`could not reach the instrument: ${err instanceof Error ? err.message : String(err)}`)
  }

  if (response.status === 401) {
    throw new Error(staleTokenMessage('save this comparison', await refusalDetail(response)))
  }

  if (!response.ok) throw new Error(`could not save this comparison — ${await refusalDetail(response)}`)

  let answer: unknown
  try {
    answer = await response.json()
  } catch {
    throw new Error('the instrument answered something other than a saved comparison')
  }

  const outcome = parseOutcome(answer)
  if (outcome === null) throw new Error('the instrument answered something other than a saved comparison')
  return outcome
}
