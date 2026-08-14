/**
 * THE APP'S FOURTH MUTATING CALL (prd-20 rulings 3 and 6; ADR-0019, ADR-0020).
 *
 * `replay/rotate.ts`, `recordings/label.ts` and `lab/launch/launch.ts` are the
 * first three; `replay/mutating-calls-law.test.ts` enumerates the app's whole
 * mutating surface and this module is the fourth entry in it — deliberately in
 * the enumeration, never an exception to it. What it asks for is the fourth
 * hand's own act: relaunch the conductor watching this repo, instrumented, on
 * the SAME conversation the operator already has (`mode: 'resume'`).
 *
 * **Why a fourth mutating call is allowed to exist at all**, argued here in
 * its own diff rather than inherited from the three that came before, at the
 * identical three-reason bar the law states:
 *
 * 1. **It writes only OUTSIDE the watched repo, and only what is fenced.** Two
 *    writes ride on this one request and both are named grants, not a general
 *    permission: a DETACHED PROCESS SPAWN in the watched repo's directory
 *    (ADR-0019's first power — a process, never a file in the working tree),
 *    and a CREATE-ONLY TRANSCRIPT COPY into the harness state directory,
 *    `~/.claude/projects/<watched-repo-slug>/` (prd-20 ruling 6 / ADR-0020's
 *    amendment: never overwrites, never deletes, never edits a line, never
 *    writes anywhere else under `~/.claude`, and the source is DERIVED from
 *    the event log's own attribution rather than named by a caller — which is
 *    why nothing in the body below is a path). The watched repo's working tree
 *    is untouched by both, so the observer's read-only law over it is exactly
 *    as absolute as it was.
 * 2. **It is triggered only by an explicit operator act, behind exactly one
 *    confirmation.** A relaunch spawns a real process that spends real money,
 *    so prd-14 ruling 4's one-confirmation bar applies to it the way it does
 *    to a lab launch. `InstrumentButton.tsx` is the one caller and arms before
 *    it acts; `explicit-invocation-law.test.ts` proves that STRUCTURALLY —
 *    one call site, pinned to one `onClick`, and no timer or effect anywhere
 *    in this directory that could fire it without a human.
 * 3. **It never mutates the event log's past.** The relaunched process is
 *    instrumented from its first turn and appends from there, under the same
 *    preserved sessionId (ADR-0020's Q3/Q4). Nothing here rewrites a recorded
 *    event, and nothing back-fills one: every token the origin process already
 *    spent stays outside this instrument's record permanently, which is a cost
 *    the UI states rather than a gap this module quietly closes.
 *
 * **The token, as the three siblings carry it.** The route is gated
 * (`server/src/api/security.ts`), so this call reads the per-process token off
 * the served page through `../recordings/capability.js` — the one module in
 * the app that ever touches the meta tag — and refuses BEFORE the wire when
 * there is none, so an operator reads what is missing instead of a 401 naming
 * a header they cannot supply.
 *
 * **One refusal is a value, not an exception.** A transcript this instrument
 * cannot reach is not a failure of the request: it is the ordinary case where
 * the conversation lives somewhere the migration's derivation cannot see, and
 * the operator's next move is to run the harness themselves. So it comes back
 * as a typed `'no-transcript-reachable'` outcome the UI can point at a
 * copyable command with, rather than a thrown sentence a `catch` renders red.
 */

import { missingTokenMessage, staleTokenMessage } from '../recordings/capability-guidance.js'
import { CAPABILITY_TOKEN_HEADER, readCapabilityToken } from '../recordings/capability.js'

export const INSTRUMENT_URL = '/api/concierge/launch'

/** What the operator is asking to resume — a session id the log already recorded, never a path. */
export interface InstrumentRequest {
  sessionId: string
}

/**
 * What became of the transcript on the way in (prd-20 ruling 6). Three facts,
 * and the UI shows whichever one is true: the copy ran (`migrated`), the file
 * was already in the harness state directory and create-only means it was left
 * exactly as it was (`already-present`), or the conversation already lives in
 * the watched repo's own slug directory and no copy was called for
 * (`not-needed`).
 */
export type MigrationFact = 'migrated' | 'already-present' | 'not-needed'

/**
 * Whether the OS actually made the process AND it was still there a moment
 * later. prd-20 ruling 3 is explicit that a spawn's success is not a claim
 * that telemetry is flowing — the operator watches the connection facts flip —
 * so this says only what it knows.
 *
 * `launched: false` covers both "no process was ever made" and #532's
 * "it exited immediately"; the server's own sentence says which, and see
 * {@link parseStarted} for why the two are one value here.
 */
export type SpawnResult = { launched: true; pid: number } | { launched: false; message: string }

/** The relaunch happened: same conversation, same id, and a fork left behind. */
export interface InstrumentStarted {
  kind: 'instrumented'
  /** The SAME id, never a new one — the resume appends in place (ADR-0020, Q3/Q4). */
  sessionId: string
  migration: MigrationFact
  spawn: SpawnResult
}

/**
 * The instrument cannot see a transcript for this session, so there is nothing
 * to resume from and nothing was spawned. A value rather than a throw: this is
 * the cue for the UI to hand the operator the command to run themselves.
 */
export interface NoTranscriptReachable {
  kind: 'no-transcript-reachable'
  /** The instrument's own account of what it looked for and did not find. */
  reason: string
}

export type InstrumentOutcome = InstrumentStarted | NoTranscriptReachable

/**
 * The narrowest shape this module needs of `fetch`: one url, one init naming
 * the verb, the two headers a gated mutation with a JSON payload needs — the
 * `Content-Type` the server parses it by, and the per-process capability token
 * — and the payload itself. Deliberately not `typeof fetch`, for the reason
 * its three siblings give: a test injecting this cannot accidentally be handed
 * a way to smuggle a credential, because the type has nowhere to put one
 * beyond these two named headers.
 */
export type InstrumentFetchLike = (
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

function isMigrationFact(value: unknown): value is MigrationFact {
  return value === 'migrated' || value === 'already-present' || value === 'not-needed'
}

/**
 * The instrument's answer, or null when it is not one this module recognises.
 *
 * Reads only what the operator is shown: the migration fact, and whether the
 * process was made. A shape it cannot read is a failure to report, never a
 * relaunch half-believed — the same refusal `parseRotation` and `parseOutcome`
 * make, and for the same reason: an operator told a conversation resumed, when
 * it did not, goes looking for a process nothing started.
 */
function parseStarted(answer: unknown, sessionId: string): InstrumentStarted | null {
  if (!isRecord(answer)) return null
  const { migration, kind, pid, message } = answer
  if (!isMigrationFact(migration)) return null

  if (kind === 'launched') {
    if (typeof pid !== 'number' || !Number.isFinite(pid)) return null
    return { kind: 'instrumented', sessionId, migration, spawn: { launched: true, pid } }
  }
  // Two ways the process is not there, and both are reported rather than
  // discarded: the migration copy may already have run.
  //
  // `'error'` — the spawn itself failed, no process was ever made. It rides in
  // the 200 body rather than the status line (`api/concierge.ts` makes that
  // split deliberately).
  //
  // `'died'` — #532, and the one this module must not read as an unknown
  // shape. The process WAS made and was gone again a moment later, which for a
  // TTY-less detached `claude` is what always happened; the server used to
  // call that `launched`. Read as `launched: false` carrying the server's own
  // account, because for the operator "it exited immediately" and "it never
  // started" have the same next move — run the command themselves — and a
  // relaunch half-believed is the one answer this parser exists to refuse.
  if (kind === 'error' || kind === 'died') {
    if (typeof message !== 'string' || message.length === 0) return null
    return { kind: 'instrumented', sessionId, migration, spawn: { launched: false, message } }
  }
  return null
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
 * Asks the fourth hand to relaunch this repo's conductor, instrumented, on the
 * conversation `sessionId` names — the ONE act `InstrumentButton.tsx`'s single
 * confirmation gates.
 *
 * Returns a `'no-transcript-reachable'` outcome when the instrument cannot see
 * a transcript to resume from: nothing was spawned, nothing was copied, and
 * the caller's job is to show the operator what to run themselves. Throws with
 * a sentence the button can show for everything else — never a bare status
 * code, and never a half-believed answer.
 */
export async function requestInstrument(
  request: InstrumentRequest,
  fetchImpl?: InstrumentFetchLike,
): Promise<InstrumentOutcome> {
  const impl = fetchImpl ?? (globalThis.fetch as unknown as InstrumentFetchLike | undefined)
  if (impl === undefined) throw new Error('this browser has no fetch — cannot instrument this session from here')

  // Refused here rather than sent bare, so the operator reads what is missing
  // instead of a 401 naming a header they cannot supply. ADR-0012's known
  // dev-mode gap made honest, not closed: under `npm run dev:web` vite serves
  // index.html itself, so the server's injection never runs.
  const { sessionId } = request
  const capabilityToken = readCapabilityToken()
  if (capabilityToken === null) {
    throw new Error(missingTokenMessage('instrument this session'))
  }

  let response: Awaited<ReturnType<InstrumentFetchLike>>
  try {
    response = await impl(INSTRUMENT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [CAPABILITY_TOKEN_HEADER]: capabilityToken },
      body: JSON.stringify({ harness: 'claude', mode: 'resume', sessionId }),
    })
  } catch (err) {
    throw new Error(`could not reach the instrument: ${err instanceof Error ? err.message : String(err)}`)
  }

  // See `replay/rotate.ts` for the full reasoning: a 401 means the token WAS
  // sent and rejected, which in practice means the tab outlived the server
  // process that minted it, and the fix is a reload.
  if (response.status === 401) {
    throw new Error(staleTokenMessage('instrument this session', await refusalDetail(response)))
  }

  // The one refusal that is a VALUE. The instrument looked for this session's
  // transcript where its own attribution says it should be and found nothing
  // it may read — an ordinary outcome for a conversation that happened
  // somewhere this instrument was never told about. Nothing spawned, nothing
  // copied, and the operator's next move is a command, not a retry.
  if (response.status === 404) {
    return { kind: 'no-transcript-reachable', reason: await refusalDetail(response) }
  }

  if (!response.ok) throw new Error(`could not instrument this session — ${await refusalDetail(response)}`)

  let answer: unknown
  try {
    answer = await response.json()
  } catch {
    throw new Error('the instrument answered something other than a relaunch result')
  }

  const started = parseStarted(answer, sessionId)
  if (started === null) throw new Error('the instrument answered something other than a relaunch result')
  return started
}
