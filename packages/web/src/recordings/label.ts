/**
 * THE APP'S SECOND MUTATING CALL (prd16 ruling 4).
 *
 * `replay/rotate.ts` was the first, and `replay/mutating-calls-law.test.ts`
 * enumerates the whole app's mutating surface; this module is the second
 * entry in that enumeration, deliberately, not an exception to it. Renaming a
 * recording is constitutional for the same reason rotation is: it writes only
 * the label SIDECAR (`log/label.ts`, beside a session's log, never inside
 * it), lands only in rhizomorph's OWN DATA DIRECTORY, and only happens on an
 * EXPLICIT OPERATOR ACT — a save the operator themself triggered, never a
 * background poll.
 *
 * Unlike rotation, a rename genuinely has something to say: which session,
 * and what to call it. So this call carries a body (and the one header a
 * JSON body needs the server to parse it) — the law's per-file checks account
 * for that difference explicitly rather than reusing rotate's "no body at
 * all" rule for a call that structurally cannot follow it.
 */

export const LABEL_URL = '/api/label'

export interface LabelOutcome {
  sessionId: string
  label: string
}

/**
 * The narrowest shape this module needs of `fetch`: one url, one init naming
 * the verb, the one header the JSON body requires, and the body itself.
 * Deliberately not `typeof fetch` — a test injecting this cannot accidentally
 * be handed a way to smuggle credentials, because the type has nowhere to
 * put them.
 */
export type LabelFetchLike = (
  input: string,
  init: { method: 'POST'; headers: { 'Content-Type': 'application/json' }; body: string },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parseOutcome(answer: unknown): LabelOutcome | null {
  if (!isRecord(answer)) return null
  const { sessionId, label } = answer
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null
  if (typeof label !== 'string' || label.length === 0) return null
  return { sessionId, label }
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
 * Saves an operator label for one recorded session. Throws with a sentence
 * the rename control can show — never a bare status code, and never a
 * half-believed answer: a response this doesn't recognise is a failure, not
 * a save.
 */
export async function requestLabel(
  sessionId: string,
  label: string,
  fetchImpl?: LabelFetchLike,
): Promise<LabelOutcome> {
  const impl = fetchImpl ?? (globalThis.fetch as unknown as LabelFetchLike | undefined)
  if (impl === undefined) throw new Error('this browser has no fetch — cannot save the label from here')

  let response: Awaited<ReturnType<LabelFetchLike>>
  try {
    response = await impl(LABEL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, label }),
    })
  } catch (err) {
    throw new Error(`could not reach the instrument: ${err instanceof Error ? err.message : String(err)}`)
  }

  if (!response.ok) throw new Error(`could not save the label — ${await refusalDetail(response)}`)

  let answer: unknown
  try {
    answer = await response.json()
  } catch {
    throw new Error('the instrument answered something other than a saved label')
  }

  const outcome = parseOutcome(answer)
  if (outcome === null) throw new Error('the instrument answered something other than a saved label')
  return outcome
}
