/**
 * THE APP'S SIXTH MUTATING CALL (prd-20 ruling 5, #216).
 *
 * `replay/rotate.ts`, `recordings/label.ts`, `lab/launch/launch.ts`,
 * `./instrument.ts` and `./clone.ts` are the first five;
 * `replay/mutating-calls-law.test.ts` enumerates the app's whole mutating
 * surface and this module is the sixth entry in it — deliberately in the
 * enumeration, never an exception to it. What it asks for is the OTHER half
 * of prd-20 ruling 5's own grant: switch which repo this instrument watches,
 * so a stranger who chose the wrong repo in the wizard's first step is not
 * left with a sentence saying the switch "is not built".
 *
 * **Why a sixth mutating call is allowed to exist at all**, argued here in
 * its own diff rather than inherited from the five that came before, at the
 * identical three-reason bar the law states:
 *
 * 1. **It writes only OUTSIDE either watched repo's working tree, and only
 *    what is fenced.** The route closes the current recording as
 *    `retargeted` and opens a new one under the adopted repo's own slug (the
 *    hand's own `performRetarget`) — a session boundary in this instrument's
 *    own data root, never a byte in either repo's working tree. The path this
 *    module sends is not a general grant to write anywhere:
 *    `server/src/server/retarget-validation.ts` refuses the request before
 *    anything closes unless the path exists, is a real git work tree, and has
 *    no live writer of its own already.
 * 2. **It is triggered only by an explicit operator act.** `connect/
 *    wizard.tsx`'s conductor step is the one caller, and it arms before it
 *    acts: a first click only shows what the switch costs and spends
 *    nothing, a second click is the one that reaches this module
 *    (`concierge/explicit-invocation-law.test.ts` proves that structurally —
 *    one call site, app-wide, pinned to one handler, and no timer or effect
 *    that could reach it without a human).
 * 3. **It never mutates the event log's past.** The closed session's log is
 *    sealed exactly as a rotation's is — nothing already recorded is
 *    revised — and the new session starts clean under the new repo. What it
 *    costs is stated rather than hidden: every lane launched before the
 *    boundary keeps declaring the old instance id and is refused whole until
 *    its env is re-issued, and the answer names each one rather than making
 *    the operator infer it from a `telemetry.refused` event a minute later.
 *
 * **The token, as the five siblings carry it.** The route is gated
 * (`server/src/api/security.ts`), so this call reads the per-process token
 * off the served page through `../recordings/capability.js` — the one module
 * in the app that ever touches the meta tag — and refuses BEFORE the wire
 * when there is none, so an operator reads what is missing instead of a 401
 * naming a header they cannot supply.
 *
 * **A refusal is a VALUE, not a throw.** The route answers 409 for
 * `already-watching`, for each of `validateRetargetTarget`'s three reasons,
 * and for a boundary already in flight — and, with no `code` at all, for a
 * replay server that never had a live recording to retarget. None of those
 * mean the request failed to arrive: the server said no, said why, and
 * nothing changed. A code this build has never heard of reads the same way
 * as none at all — `null` — so a future refusal this client cannot yet name
 * still shows the server's own sentence rather than throwing over an
 * unrecognised word.
 */

import { missingTokenMessage, staleTokenMessage } from '../recordings/capability-guidance.js'
import { CAPABILITY_TOKEN_HEADER, readCapabilityToken } from '../recordings/capability.js'

export const RETARGET_URL = '/api/retarget'

/** The repo to adopt — the path the operator picked in the wizard. */
export interface RetargetRequest {
  path: string
}

/** Mirrors `server/src/api/refusals.ts`'s `RetargetRefusalCode`, spelled the same. */
export type RetargetRefusalCode = 'not-found' | 'not-a-repo' | 'writer-alive' | 'already-watching' | 'retarget-in-flight'

const RETARGET_REFUSAL_CODES: readonly RetargetRefusalCode[] = [
  'not-found',
  'not-a-repo',
  'writer-alive',
  'already-watching',
  'retarget-in-flight',
]

/**
 * What the route's own reply carries — the closed session, the opened one,
 * both repos' facts, and what the switch cost (`server/src/server/
 * retarget-cost.ts`'s `RetargetTelemetryCost`, restated here field for field
 * rather than imported, because `packages/web` cannot import
 * `@rhizomorph/server`).
 */
export interface RetargetTelemetryCost {
  previousInstance: string
  instance: string
  lanes: string[]
  reissue: string[]
  reissueTemplate: string
  lost: string[]
  stillWorking: string[]
  note: string
}

export interface RetargetSwitched {
  kind: 'switched'
  from: { repoPath: string; repoName: string }
  to: { repoPath: string; repoName: string }
  closed: { sessionId: string; synced: boolean; syncError: string | null }
  opened: { sessionId: string }
  telemetry: RetargetTelemetryCost
}

/**
 * A 409 is a VALUE, not a throw: the server said no, said why, and nothing
 * changed. `code` is `null` when the server sent none (a replay server) or
 * one this module does not know.
 */
export interface RetargetRefused {
  kind: 'refused'
  code: RetargetRefusalCode | null
  message: string
}

export type RetargetOutcome = RetargetSwitched | RetargetRefused

/**
 * The narrowest shape this module needs of `fetch`: one url, one init naming
 * the verb, the two headers a gated mutation with a JSON payload needs — the
 * `Content-Type` the server parses it by, and the per-process capability
 * token — and the payload itself. Deliberately not `typeof fetch`, for the
 * reason its five siblings give: a test injecting this cannot accidentally
 * be handed a way to smuggle a credential, because the type has nowhere to
 * put one beyond these two named headers.
 */
export type RetargetFetchLike = (
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
 * The 409 body, read as the value it is: the server's own sentence, and a
 * code when it sent one this build recognises. A code it sent that this
 * build has never heard of reads the same as none at all — the honest
 * posture for a client older than the server it is talking to.
 */
async function parseRefusal(response: { status: number; json: () => Promise<unknown> }): Promise<RetargetRefused> {
  let answer: unknown
  try {
    answer = await response.json()
  } catch {
    return { kind: 'refused', code: null, message: `the server answered ${response.status}` }
  }
  const record = isRecord(answer) ? answer : {}
  const error = typeof record.error === 'string' && record.error.length > 0 ? record.error : `the server answered ${response.status}`
  const code =
    typeof record.code === 'string' && (RETARGET_REFUSAL_CODES as readonly string[]).includes(record.code)
      ? (record.code as RetargetRefusalCode)
      : null
  return { kind: 'refused', code, message: error }
}

function readRepoFacts(value: unknown): { repoPath: string; repoName: string } | null {
  if (!isRecord(value)) return null
  const { repoPath, repoName } = value
  if (typeof repoPath !== 'string' || repoPath.length === 0) return null
  if (typeof repoName !== 'string' || repoName.length === 0) return null
  return { repoPath, repoName }
}

function readClosed(value: unknown): RetargetSwitched['closed'] | null {
  if (!isRecord(value)) return null
  const { sessionId, synced, syncError } = value
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null
  if (typeof synced !== 'boolean') return null
  if (syncError !== undefined && typeof syncError !== 'string') return null
  return { sessionId, synced, syncError: typeof syncError === 'string' ? syncError : null }
}

function readOpened(value: unknown): RetargetSwitched['opened'] | null {
  if (!isRecord(value)) return null
  const { sessionId } = value
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null
  return { sessionId }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

function readTelemetry(value: unknown): RetargetTelemetryCost | null {
  if (!isRecord(value)) return null
  const { previousInstance, instance, lanes, reissue, reissueTemplate, lost, stillWorking, note } = value
  if (typeof previousInstance !== 'string' || previousInstance.length === 0) return null
  if (typeof instance !== 'string' || instance.length === 0) return null
  if (typeof reissueTemplate !== 'string') return null
  if (typeof note !== 'string' || note.length === 0) return null
  if (!isStringArray(lanes) || !isStringArray(reissue) || !isStringArray(lost) || !isStringArray(stillWorking)) {
    return null
  }
  return { previousInstance, instance, lanes, reissue, reissueTemplate, lost, stillWorking, note }
}

/**
 * The route's own account of a switch that happened — read strictly, and
 * only the fields the wizard actually shows. `closed.filePath`,
 * `closed.eventCount`, `closed.closedAt`, `opened.filePath`,
 * `opened.startedAt`, and every repo's `repoSlug`/`sessionDir` ride on the
 * wire too, and none of them is carried here: a shape this module cannot
 * fully read is a failure to report, never a switch half-believed.
 */
function parseSwitched(answer: unknown): RetargetSwitched | null {
  if (!isRecord(answer)) return null
  const from = readRepoFacts(answer.from)
  const to = readRepoFacts(answer.to)
  const closed = readClosed(answer.closed)
  const opened = readOpened(answer.opened)
  const telemetry = readTelemetry(answer.telemetry)
  if (from === null || to === null || closed === null || opened === null || telemetry === null) return null
  return { kind: 'switched', from, to, closed, opened, telemetry }
}

/**
 * Asks the sixth hand to switch this instrument to `request.path` — the ONE
 * act `connect/wizard.tsx`'s conductor step performs, behind its own
 * arming click.
 *
 * Resolves when the switch has happened, with what the route did — or with a
 * refusal, which is a value rather than an exception. Throws with a sentence
 * the wizard can show for everything that happened before the wire: no
 * fetch, an empty path, a missing or stale token, an unreachable server, or
 * an answer this build cannot read.
 */
export async function requestRetarget(request: RetargetRequest, fetchImpl?: RetargetFetchLike): Promise<RetargetOutcome> {
  const impl = fetchImpl ?? (globalThis.fetch as unknown as RetargetFetchLike | undefined)
  if (impl === undefined) throw new Error('this browser has no fetch — cannot switch the watched repo from here')

  const path = request.path.trim()
  if (path.length === 0) {
    throw new Error('cannot switch to an empty path — the wizard has no repo chosen')
  }

  // Refused here rather than sent bare, so the operator reads what is missing
  // instead of a 401 naming a header they cannot supply. ADR-0012's known
  // dev-mode gap made honest, not closed: under `npm run dev:web` vite serves
  // index.html itself, so the server's injection never runs.
  const capabilityToken = readCapabilityToken()
  if (capabilityToken === null) {
    throw new Error(missingTokenMessage('switch the watched repo'))
  }

  let response: Awaited<ReturnType<RetargetFetchLike>>
  try {
    response = await impl(RETARGET_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [CAPABILITY_TOKEN_HEADER]: capabilityToken },
      body: JSON.stringify({ path }),
    })
  } catch (err) {
    throw new Error(`could not reach the instrument: ${err instanceof Error ? err.message : String(err)}`)
  }

  // See `replay/rotate.ts` for the full reasoning: a 401 means the token WAS
  // sent and rejected, which in practice means the tab outlived the server
  // process that minted it, and the fix is a reload.
  if (response.status === 401) {
    throw new Error(staleTokenMessage('switch the watched repo', await refusalDetail(response)))
  }

  // The route's own refusals — already-watching, the three validation
  // reasons, a boundary already in flight, or a replay server with none at
  // all — all answer 409, and every one of them is a value: the server said
  // no, said why, and nothing changed.
  if (response.status === 409) {
    return parseRefusal(response)
  }

  if (!response.ok) throw new Error(`could not switch the watched repo — ${await refusalDetail(response)}`)

  let answer: unknown
  try {
    answer = await response.json()
  } catch {
    throw new Error('the instrument answered something other than a retarget result')
  }

  const switched = parseSwitched(answer)
  if (switched === null) throw new Error('the instrument answered something other than a retarget result')
  return switched
}
