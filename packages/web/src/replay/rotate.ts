/**
 * THE WEB APP'S ONE MUTATING CALL (prd16 ruling 2).
 *
 * Everything else this dashboard does is a read: `GET /api/stream`,
 * `/api/sessions`, `/api/meta`, `/api/transcript`, `/api/lanes`. This module
 * is the single exception, and it exists so that exception is *enumerable* —
 * `mutating-calls-law.test.ts` asserts the whole app's mutating surface is
 * exactly this file, exactly this route, exactly this verb, and that no other
 * source file anywhere in `packages/web/src` so much as names another one.
 * The drawer's read-only law (ruling 17, `drawer/readonly.test.ts`) is
 * untouched and stays green: nothing in the drawer changes.
 *
 * What it asks for is not a command run against the watched repo — the
 * observer's read-only law over that is absolute and unaffected. It asks the
 * instrument to end its own recording and begin another, which it already had
 * the authority to do; prd16 ruling 2 only made *when* an operator's decision.
 */

export const ROTATE_URL = '/api/rotate'

/** What `POST /api/rotate` answers with — the two sides of the boundary. */
export interface RotationSummary {
  closed: { sessionId: string; eventCount: number }
  opened: { sessionId: string }
}

/**
 * The narrowest shape this module needs of `fetch`: one url, one init naming
 * the verb. Deliberately not `typeof fetch` — a test injecting this cannot
 * accidentally be handed a body, headers or credentials to smuggle, because
 * the type has nowhere to put them.
 */
export type RotateFetchLike = (
  input: string,
  init: { method: 'POST' },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parseRotation(answer: unknown): RotationSummary | null {
  if (!isRecord(answer) || !isRecord(answer.closed) || !isRecord(answer.opened)) return null
  const { sessionId: closedId, eventCount } = answer.closed
  const { sessionId: openedId } = answer.opened
  if (typeof closedId !== 'string' || closedId.length === 0) return null
  if (typeof openedId !== 'string' || openedId.length === 0) return null
  if (typeof eventCount !== 'number' || !Number.isFinite(eventCount)) return null
  return { closed: { sessionId: closedId, eventCount }, opened: { sessionId: openedId } }
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
 * Ends the running session and starts a fresh one. Throws with a sentence the
 * button can show — never a bare status code, and never a half-believed
 * answer: a response this doesn't recognise is a failure, not a rotation.
 */
export async function requestRotation(fetchImpl?: RotateFetchLike): Promise<RotationSummary> {
  const impl = fetchImpl ?? (globalThis.fetch as unknown as RotateFetchLike | undefined)
  if (impl === undefined) throw new Error('this browser has no fetch — cannot end the session from here')

  let response: Awaited<ReturnType<RotateFetchLike>>
  try {
    response = await impl(ROTATE_URL, { method: 'POST' })
  } catch (err) {
    throw new Error(`could not reach the instrument: ${err instanceof Error ? err.message : String(err)}`)
  }

  if (!response.ok) throw new Error(`could not end the session — ${await refusalDetail(response)}`)

  let answer: unknown
  try {
    answer = await response.json()
  } catch {
    throw new Error('the instrument answered something other than a rotation')
  }

  const rotation = parseRotation(answer)
  if (rotation === null) throw new Error('the instrument answered something other than a rotation')
  return rotation
}
