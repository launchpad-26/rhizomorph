/**
 * THE APP'S FIFTH MUTATING CALL (prd-20 ruling 1 / ADR-0019's second power).
 *
 * `replay/rotate.ts`, `recordings/label.ts`, `lab/launch/launch.ts` and
 * `./instrument.ts` are the first four; `replay/mutating-calls-law.test.ts`
 * enumerates the app's whole mutating surface and this module is the fifth
 * entry in it — deliberately in the enumeration, never an exception to it.
 * What it asks for is the OTHER half of the fourth hand's grant: clone a
 * repository the operator typed the URL of, so the wizard's first step has an
 * answer for the machine that does not have the repo yet.
 *
 * **Why a fifth mutating call is allowed to exist at all**, argued here in its
 * own diff rather than inherited from the four that came before, at the
 * identical three-reason bar the law states:
 *
 * 1. **It writes only OUTSIDE the watched repo, and only what is fenced.** The
 *    write is a `git clone` into the concierge's OWN namespace — ADR-0019's
 *    second power, fenced by `server/src/concierge/paths.ts`'s
 *    `assertCloneTarget` against `defaultClonesRoot()`, and refused outright
 *    when the destination would land inside the repo this instrument is
 *    currently watching. Nothing in the body below is a path: the request
 *    carries a URL and nothing else, and the DESTINATION IS DERIVED server-side
 *    from that URL (`deriveCloneName`), which is what keeps a caller from
 *    naming where the bytes land.
 * 2. **It is triggered only by an explicit operator act.** `connect/wizard.tsx`
 *    is the one caller and it is wired to a form's own submit button;
 *    `explicit-invocation-law.test.ts` proves that STRUCTURALLY — one call
 *    site, app-wide, pinned to one handler, and no timer or effect that could
 *    reach it without a human. A clone is not behind a second confirmation the
 *    way a relaunch is, and that difference is deliberate rather than an
 *    oversight: prd-14 ruling 4's one-confirmation bar is about an act that
 *    SPENDS MONEY by starting an agent. This one downloads a repository into a
 *    directory this instrument owns; the operator typed the URL, which is
 *    itself the deliberate act, and the cost of an unwanted clone is disk, not
 *    tokens.
 * 3. **It never mutates the event log's past.** A clone appends nothing to the
 *    log at all. It puts bytes on disk under the concierge's own root and
 *    reports where they went; no recorded event is revised, and none is
 *    invented.
 *
 * **The token, as the four siblings carry it.** The route is gated
 * (`server/src/api/security.ts`), so this call reads the per-process token off
 * the served page through `../recordings/capability.js` — the one module in
 * the app that ever touches the meta tag — and refuses BEFORE the wire when
 * there is none, so an operator reads what is missing instead of a 401 naming
 * a header they cannot supply.
 *
 * **Why this reads the whole body rather than streaming it.** The route
 * hijacks its reply and writes newline-delimited JSON as `git` talks
 * (`api/concierge.ts`), which is a real progress channel. This client reads it
 * with one `text()` and parses the lines afterwards, so the caller learns the
 * outcome when the clone ENDS rather than as it runs. That is a deliberate
 * trade, not an oversight: the narrow injected-fetch shape every mutating
 * module in this app is held to ({@link CloneFetchLike}, and see its own doc)
 * exists so a test cannot hand one of these calls a way to smuggle a
 * credential, and a `ReadableStream` reader in that type would be a second
 * surface with no law over it. The progress lines are not discarded — every
 * one of them rides back on the outcome, so an operator reading a failure sees
 * `git`'s own account of it — they simply arrive together at the end.
 *
 * **A clone that failed is a VALUE, not a throw.** The route answers 200 and
 * then says in the stream whether `git` succeeded, exactly as
 * `./instrument.ts`'s spawn result rides in its own 200 body: by the time the
 * failure is known, a destination directory may already exist on disk, and
 * that is a fact the operator has to be told rather than a stack trace to
 * paint red. Only the refusals that happen BEFORE any byte is written — a
 * malformed URL, the fence, a destination that already exists, a missing or
 * stale token, an unreachable server — are thrown.
 */

import { missingTokenMessage, staleTokenMessage } from '../recordings/capability-guidance.js'
import { CAPABILITY_TOKEN_HEADER, readCapabilityToken } from '../recordings/capability.js'

export const CLONE_URL = '/api/concierge/clone'

/**
 * What the operator is asking to clone — a URL they typed, and nothing else.
 * There is deliberately no destination field: `server/src/concierge/clone.ts`
 * derives the directory name from the URL and fences it, so there is nowhere
 * in this request for a caller to name a place on disk.
 */
export interface CloneRequest {
  url: string
}

/**
 * What became of the clone. Two answers, both of which the wizard shows as
 * themselves:
 *
 * - `cloned` — `git` finished and the repository is at `path`, which is the
 *   server's own answer, never a path this client composed.
 * - `clone-failed` — `git` ran and did not finish. `message` is the route's own
 *   terminal sentence.
 *
 * `progress` carries `git`'s own output lines in both arms, in order. On a
 * failure that is the whole of the evidence an operator has; on a success it is
 * what proves the clone actually did work rather than answering instantly off
 * something already on disk.
 */
export type CloneOutcome =
  | { kind: 'cloned'; path: string; progress: readonly string[] }
  | { kind: 'clone-failed'; message: string; progress: readonly string[] }

/**
 * The narrowest shape this module needs of `fetch`: one url, one init naming
 * the verb, the two headers a gated mutation with a JSON payload needs — the
 * `Content-Type` the server parses it by, and the per-process capability token
 * — and the payload itself. Deliberately not `typeof fetch`, for the reason its
 * four siblings give: a test injecting this cannot accidentally be handed a way
 * to smuggle a credential, because the type has nowhere to put one beyond these
 * two named headers.
 *
 * It is the one member of that family with a `text()` as well as a `json()`,
 * and only because this route's success body is newline-delimited JSON rather
 * than one document: `json()` reads the refusals (which are ordinary single
 * JSON objects, exactly as the siblings' are), `text()` reads the stream.
 */
export type CloneFetchLike = (
  input: string,
  init: {
    method: 'POST'
    headers: { 'Content-Type': 'application/json'; 'x-rhizomorph-capability': string }
    body: string
  },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> }>

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
 * The stream, as this module can read it: whichever terminal event ended it,
 * carrying every progress line `git` produced — or `null` when nothing
 * terminal arrived at all.
 *
 * A line this module cannot parse is SKIPPED rather than failing the read. The
 * body is a stream from a long-running process, and the two ways it goes wrong
 * — a truncated last line because the socket died mid-write, and a future
 * server emitting an event type this build has never heard of — both leave the
 * lines around them perfectly true. Refusing the whole answer over one of them
 * would throw away `git`'s account of a clone that may well have finished.
 */
export function readCloneStream(body: string): CloneOutcome | null {
  const progress: string[] = []
  let terminal: CloneOutcome | null = null

  for (const line of body.split('\n')) {
    if (line.trim().length === 0) continue
    let event: unknown
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (!isRecord(event)) continue

    if (event.type === 'progress' && typeof event.line === 'string') {
      progress.push(event.line)
      continue
    }
    // The first terminal event wins, and later ones are ignored rather than
    // overwriting it: a stream that says "done" and then "error" has already
    // told the operator the repository arrived, and the honest reading of a
    // second answer is that this client does not understand the first.
    if (terminal !== null) continue
    if (event.type === 'done' && typeof event.path === 'string' && event.path.length > 0) {
      terminal = { kind: 'cloned', path: event.path, progress }
    } else if (event.type === 'error' && typeof event.message === 'string' && event.message.length > 0) {
      terminal = { kind: 'clone-failed', message: event.message, progress }
    }
  }

  // `progress` is the same array object both arms above captured, so lines that
  // arrived after the terminal event are carried too — nothing `git` said is
  // dropped on the floor for having been said late.
  return terminal
}

/**
 * Asks the fourth hand to clone `request.url` into the concierge's own
 * namespace — the ONE act `connect/wizard.tsx`'s repo step performs.
 *
 * Resolves when the clone has ENDED, with what became of it. Throws with a
 * sentence the wizard can show for every refusal that happened before a byte
 * was written — never a bare status code, and never a half-believed answer.
 */
export async function requestClone(request: CloneRequest, fetchImpl?: CloneFetchLike): Promise<CloneOutcome> {
  const impl = fetchImpl ?? (globalThis.fetch as unknown as CloneFetchLike | undefined)
  if (impl === undefined) throw new Error('this browser has no fetch — cannot clone a repository from here')

  // Refused here rather than sent bare, so the operator reads what is missing
  // instead of a 401 naming a header they cannot supply. ADR-0012's known
  // dev-mode gap made honest, not closed: under `npm run dev:web` vite serves
  // index.html itself, so the server's injection never runs.
  const { url } = request
  const capabilityToken = readCapabilityToken()
  if (capabilityToken === null) {
    throw new Error(missingTokenMessage('clone a repository'))
  }

  let response: Awaited<ReturnType<CloneFetchLike>>
  try {
    response = await impl(CLONE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [CAPABILITY_TOKEN_HEADER]: capabilityToken },
      body: JSON.stringify({ url }),
    })
  } catch (err) {
    throw new Error(`could not reach the instrument: ${err instanceof Error ? err.message : String(err)}`)
  }

  // See `replay/rotate.ts` for the full reasoning: a 401 means the token WAS
  // sent and rejected, which in practice means the tab outlived the server
  // process that minted it, and the fix is a reload.
  if (response.status === 401) {
    throw new Error(staleTokenMessage('clone a repository', await refusalDetail(response)))
  }

  // Everything else non-2xx is a refusal decided BEFORE the stream opened — a
  // malformed URL (400), the namespace fence (403), a destination that already
  // exists or a replay server (409). Nothing was written, so there is no
  // outcome to carry: the sentence is the whole answer.
  if (!response.ok) throw new Error(`could not clone that repository — ${await refusalDetail(response)}`)

  let body: string
  try {
    body = await response.text()
  } catch (err) {
    throw new Error(
      `the clone started, and this page lost the connection while it ran: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  const terminal = readCloneStream(body)
  if (terminal === null) {
    throw new Error(
      'the clone stream ended without saying whether the repository arrived — it may be on disk, partly or ' +
        'completely, so check the clones directory before asking for it again',
    )
  }
  return terminal
}
