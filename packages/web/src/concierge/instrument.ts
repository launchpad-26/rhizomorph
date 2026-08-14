/**
 * THE APP'S FOURTH MUTATING CALL (prd-20 rulings 3 and 6; ADR-0019, ADR-0020).
 *
 * `replay/rotate.ts`, `recordings/label.ts` and `lab/launch/launch.ts` are the
 * first three; `replay/mutating-calls-law.test.ts` enumerates the app's whole
 * mutating surface and this module is the fourth entry in it — deliberately in
 * the enumeration, never an exception to it. What it asks for is the fourth
 * hand's own act: start the conductor watching this repo, instrumented — on the
 * SAME conversation the operator already has (`mode: 'resume'`), on the most
 * recent one (`'continue'`), or fresh (`'launch'`).
 *
 * **The two extra modes are #266's widening, and they widen the REQUEST, not
 * the grant.** `POST /api/concierge/launch` has answered all three since #264;
 * this module only ever sent `'resume'` because `InstrumentButton.tsx` was its
 * only caller, and a button on a row about an uninstrumented session has
 * exactly one thing to ask for. The wizard's conductor step is the caller that
 * does not: a stranger who has just chosen a repo has no conversation to
 * resume. Nothing about what the hand may DO changes here — same file, same
 * route, the same single row in the mutating law's file→route enumeration — and
 * the harness travels as a parameter now for the same reason, because the route
 * has taken one since it was written and pinning `'claude'` into this file's
 * own body was a fact about its one caller rather than about the hand.
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
 * 2. **It is triggered only by an explicit operator act, and every caller arms
 *    before it acts.** A relaunch spawns a real process that spends real
 *    money, so prd-14 ruling 4's one-confirmation bar applies to it the way it
 *    does to a lab launch. There are TWO callers since #266, and this sentence
 *    is written as an enumeration rather than a count because the count is what
 *    went stale: `InstrumentButton.tsx` (a resume of one named session) and
 *    `../connect/wizard.tsx`'s conductor step (a fresh launch or a continue).
 *    Each holds its own two-step bar — a first click that shows what is about
 *    to happen and what it costs and spends nothing, a second that spends —
 *    and neither has a second dialog behind that. This paragraph read "one
 *    caller" for a while after the wizard landed unarmed, which is worth
 *    recording: the prose was the only thing claiming the bar, and prose does
 *    not hold. `explicit-invocation-law.test.ts` is what holds it, STRUCTURALLY
 *    — the exact caller SET rather than a count, each caller's act pinned to
 *    the `onClick` of a button that only exists in a confirming state, and no
 *    timer or effect anywhere in this directory that could fire it without a
 *    human.
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

/**
 * The three things a launch can mean, spelled exactly as
 * `server/src/concierge/launch.ts`'s own `LaunchMode` spells them.
 *
 * `resume` is the one this module was born for (#518) and the only one that
 * names a session; `launch` starts a conductor fresh, and `continue` relaunches
 * on the most recent conversation, whichever that is. The wizard's conductor
 * step (#266) is what needed the other two: an operator who has just chosen a
 * repo has no session id to resume, and offering them only the one verb this
 * module already had would have meant "you can relaunch a conversation you are
 * already having" on the page whose whole subject is the machine that has none.
 */
export type InstrumentMode = 'launch' | 'continue' | 'resume'

/**
 * What the operator is asking for — which harness, which of the three verbs,
 * and (for `resume` alone) a session id the log already recorded. **Never a
 * path**: prd-20 ruling 6 / ADR-0020 make the migration's source DERIVED from
 * the event log's own attribution rather than supplied, so there is deliberately
 * nowhere here for a caller to name a location on disk.
 *
 * `harness` and `mode` are optional, and default to `'claude'` and `'resume'` —
 * which is the request this module has always sent. That is not politeness
 * toward existing callers: it keeps `InstrumentButton.tsx`'s meaning stated in
 * one place (it asks for a resume of a named session and nothing else) and it
 * keeps every widening of this request visible at the call site that wanted it.
 */
export interface InstrumentRequest {
  /** A harness id the server's registry knows. Defaults to `claude`, the one harness proven end to end. */
  harness?: string
  /** Defaults to `resume` — see {@link InstrumentMode}. */
  mode?: InstrumentMode
  /** Required exactly when {@link mode} is `resume`, and refused on the other two. */
  sessionId?: string
}

/**
 * The mismatch this module refuses BEFORE the wire, rather than letting the
 * route answer 400 for it: `parseConciergeLaunchRequestBody` requires a
 * `sessionId` on `resume` and forbids one on the other two modes, and a caller
 * that gets that wrong has a bug in the page, not a machine that said no. A
 * thrown sentence naming the mismatch is what a developer can act on; a 400
 * naming a body field is what an operator would have had to read instead.
 */
function assertModeAndSessionAgree(mode: InstrumentMode, sessionId: string | undefined): void {
  if (mode === 'resume') {
    if (sessionId === undefined || sessionId.length === 0) {
      throw new Error('cannot resume without a session id — mode "resume" names one exact prior conversation')
    }
    return
  }
  if (sessionId !== undefined) {
    throw new Error(`a session id means mode "resume" — it has no meaning for mode "${mode}"`)
  }
}

/**
 * What became of the transcript on the way in (prd-20 ruling 6). Three facts,
 * and the UI shows whichever one is true: the copy ran (`migrated`), the file
 * was already in the harness state directory and create-only means it was left
 * exactly as it was (`already-present`), or the conversation already lives in
 * the watched repo's own slug directory and no copy was called for
 * (`not-needed`).
 */
export type MigrationKind = 'migrated' | 'already-present' | 'not-needed' | 'copy-failed'

/**
 * THE SHAPE THE ROUTE ACTUALLY SENDS (#543). `concierge/migrate.ts` answers an
 * OBJECT — `{kind, at}` for the three that placed a file, `{kind, message}` for
 * the copy that failed — and this module read it as a bare word until a live
 * browser pass caught every success being refused as unreadable. The union is
 * mirrored from the server's own `MigrationOutcome`, and `copy-failed` is here
 * because it rides a 200 body: the launch went ahead, and the operator is owed
 * the reason the copy did not.
 */
export interface MigrationFact {
  readonly kind: MigrationKind
  /** Where the transcript ended up — absent on `copy-failed`. */
  readonly at: string | null
  /** Why the copy failed — present only on `copy-failed`. */
  readonly message: string | null
}

/**
 * The fourth answer, and it is a `null` on the wire rather than a word: **there
 * was nothing to migrate.** Only `mode: 'resume'` ever copies a transcript, so
 * `launch` and `continue` come back with `migration: null` — an explicit key
 * with an explicit value, which `api/concierge.ts` is deliberate about ("a fact
 * worth a value rather than a key a caller has to remember to check for").
 *
 * The distinction this module holds is therefore `null` versus ABSENT, and it
 * is load-bearing: `null` is the route saying "no copy was called for", while a
 * missing key is a body this module cannot read, and reading the second as the
 * first would let any malformed answer through as a launch.
 */
export type MigrationOutcome = MigrationFact | null

/**
 * Whether the OS actually made the process AND it was still there a moment
 * later — and, when it was, WHERE it went. prd-20 ruling 3 is explicit that a
 * spawn's success is not a claim that telemetry is flowing — the operator
 * watches the connection facts flip — so this says only what it knows.
 *
 * `via` is not decoration, and #532 is the bill for treating it as though it
 * were: "there is a pid" and "there is a window you can attach to and type
 * into" are different facts about an interactive harness, and the UI can only
 * tell an operator where to go if this carries the difference.
 *
 * - `launched: true, via: 'tmux'` — a real window, named by `window`
 *   (`<session>:<index>`, what `tmux attach -t` takes). The one outcome where
 *   there is a surface to type into.
 * - `launched: true, via: 'detached'` — alive when the settle window closed,
 *   and with nothing attached to it.
 * - `launched: false` — no process was ever made, or #532's "it exited
 *   immediately"; the server's own sentence says which, and see
 *   {@link parseStarted} for why the two are one value here.
 */
export type SpawnResult =
  | { launched: true; via: 'tmux'; pid: number; window: string }
  | { launched: true; via: 'detached'; pid: number }
  | { launched: false; message: string }

/**
 * **WHETHER TELEMETRY ACTUALLY ARRIVES FROM THIS HARNESS, in the adapter's own
 * words** — `HarnessEnvRecipe.telemetry`, which the route has sent on every
 * answer since #264 and this module used to drop on the floor at the
 * destructure.
 *
 * That drop was not cosmetic. codex's adapter declares telemetry ABSENT with
 * two named blockers, and a page that cannot see the field has no way to know
 * it: the launch was framed as instrumenting for every harness, which for codex
 * is a promise the registry itself refuses to make. The honest shape is the
 * one core already has (`CapabilityDetail`) — `provided` needs nothing else,
 * and anything less is compiler-required to carry its reason.
 *
 * `remedy` is `null` rather than absent when the adapter gave none, for the
 * same reason {@link MigrationOutcome} distinguishes `null` from a missing key:
 * a UI reading an absent field as "no remedy" and an unreadable one as the same
 * thing cannot tell "there is nothing to do" from "this answer was not
 * understood".
 */
export type TelemetryFact =
  | { level: 'provided' }
  | { level: 'partial' | 'absent'; reason: string; remedy: string | null }

/**
 * The launch happened, as far as this module can honestly say — and for
 * `mode: 'resume'`, on the same conversation under the same id, with a fork
 * left behind.
 */
export interface InstrumentStarted {
  kind: 'instrumented'
  /**
   * The SAME id the caller named, never a new one — the resume appends in place
   * (ADR-0020, Q3/Q4). `null` on `launch` and `continue`, which name no id: a
   * fresh conductor's session id is minted by the harness and reaches this
   * instrument through the event log, never through this response.
   */
  sessionId: string | null
  migration: MigrationOutcome
  spawn: SpawnResult
  /**
   * What the launched harness's own adapter says about telemetry arriving here
   * — or `null` when this answer did not state it, which is a different fact
   * from "absent" and is never rendered as one. See {@link TelemetryFact}.
   */
  telemetry: TelemetryFact | null
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
  if (!isRecord(value)) return false
  const { kind, at, message } = value
  if (kind !== 'migrated' && kind !== 'already-present' && kind !== 'not-needed' && kind !== 'copy-failed') {
    return false
  }
  // Each kind carries its own half of the story, and neither is optional in the
  // shape the route sends: a placed file names WHERE, a failed copy names WHY.
  if (kind === 'copy-failed') return typeof message === 'string' && message.length > 0
  return typeof at === 'string' && at.length > 0
}

/**
 * `null` passes; an ABSENT key does not. See {@link MigrationOutcome} — reading
 * a missing field as "nothing to migrate" would turn every unreadable body into
 * a believable launch, which is the one thing this parser exists to refuse.
 */
function isMigrationOutcome(value: unknown, present: boolean): value is MigrationOutcome {
  return value === null ? present : isMigrationFact(value)
}

/**
 * The adapter's telemetry claim, `null` for an answer that did not make one,
 * and `undefined` for one this module could not read.
 *
 * Three values rather than two, and the third is the point. An ABSENT key is
 * `null`: an answer from a server older than this field, and the honest thing
 * to render is that nothing was said. A key that is PRESENT and malformed is
 * `undefined`, which refuses the whole body — the same posture
 * {@link parseStarted} takes everywhere else, because a half-read capability
 * claim is exactly the kind of thing that would come out as a reassuring
 * default. What must never happen is the two collapsing into "provided".
 */
function readTelemetry(value: unknown, present: boolean): TelemetryFact | null | undefined {
  if (!present) return null
  if (!isRecord(value)) return undefined
  const { level, reason, remedy } = value
  if (level === 'provided') return { level: 'provided' }
  if (level !== 'partial' && level !== 'absent') return undefined
  // `reason` is compiler-required on these two levels in core's own
  // `CapabilityDetail`, so an answer without one is not this shape.
  if (typeof reason !== 'string' || reason.length === 0) return undefined
  if (remedy !== undefined && typeof remedy !== 'string') return undefined
  return { level, reason, remedy: typeof remedy === 'string' && remedy.length > 0 ? remedy : null }
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
function parseStarted(answer: unknown, sessionId: string | null): InstrumentStarted | null {
  if (!isRecord(answer)) return null
  // `window` is read off the record rather than destructured: a local binding
  // of that name shadows the global one for the whole function, in a module
  // that runs in a browser.
  const { migration, kind, pid, message, via } = answer
  const tmuxWindow = answer.window
  if (!isMigrationOutcome(migration, 'migration' in answer)) return null
  const migrationFact: MigrationOutcome =
    migration === null
      ? null
      : {
          kind: migration.kind,
          at: typeof migration.at === 'string' && migration.at.length > 0 ? migration.at : null,
          message: typeof migration.message === 'string' && migration.message.length > 0 ? migration.message : null,
        }
  // The field this destructure used to leave behind (ledger #4). It rides on
  // every outcome, launched and dead alike: what the harness's own adapter says
  // about telemetry arriving here is true of the request, not of its result.
  const telemetry = readTelemetry(answer.telemetry, 'telemetry' in answer)
  if (telemetry === undefined) return null

  if (kind === 'launched') {
    if (typeof pid !== 'number' || !Number.isFinite(pid)) return null
    // WHERE it went, and only where the server actually said so (#532). A
    // `via: 'tmux'` with no window to name is not read as a tmux launch:
    // "attach to the window" with no window in the sentence is worse than
    // saying only that a process exists, so it falls through to `detached` —
    // which is the weaker of the two claims, never the stronger.
    if (via === 'tmux' && typeof tmuxWindow === 'string' && tmuxWindow.length > 0) {
      return {
        kind: 'instrumented',
        sessionId,
        migration: migrationFact,
        telemetry,
        spawn: { launched: true, via: 'tmux', pid, window: tmuxWindow },
      }
    }
    return { kind: 'instrumented', sessionId, migration: migrationFact, telemetry, spawn: { launched: true, via: 'detached', pid } }
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
    return { kind: 'instrumented', sessionId, migration: migrationFact, telemetry, spawn: { launched: false, message } }
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
 * Asks the fourth hand to start this repo's conductor, instrumented — fresh
 * (`launch`), on the most recent conversation (`continue`), or on the exact one
 * `sessionId` names (`resume`, the default). The ONE act
 * `InstrumentButton.tsx`'s single confirmation gates, and the same act the
 * wizard's conductor step performs behind its own.
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

  const harness = request.harness ?? 'claude'
  const mode = request.mode ?? 'resume'
  const { sessionId } = request
  assertModeAndSessionAgree(mode, sessionId)

  // Refused here rather than sent bare, so the operator reads what is missing
  // instead of a 401 naming a header they cannot supply. ADR-0012's known
  // dev-mode gap made honest, not closed: under `npm run dev:web` vite serves
  // index.html itself, so the server's injection never runs.
  const capabilityToken = readCapabilityToken()
  if (capabilityToken === null) {
    throw new Error(missingTokenMessage('instrument this session'))
  }

  let response: Awaited<ReturnType<InstrumentFetchLike>>
  try {
    response = await impl(INSTRUMENT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [CAPABILITY_TOKEN_HEADER]: capabilityToken },
      // The key is OMITTED on the two modes that have no session, never sent as
      // `undefined` and never as an empty string: the route refuses a
      // `sessionId` present on anything but `resume`, and `JSON.stringify`
      // drops an undefined value rather than sending `null` — a difference this
      // spells out explicitly rather than relying on.
      body: mode === 'resume' ? JSON.stringify({ harness, mode, sessionId }) : JSON.stringify({ harness, mode }),
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

  const started = parseStarted(answer, sessionId ?? null)
  if (started === null) throw new Error('the instrument answered something other than a relaunch result')
  return started
}
