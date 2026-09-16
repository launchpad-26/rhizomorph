import { missingTokenMessage, staleTokenMessage } from '../recordings/capability-guidance.js'
import { CAPABILITY_TOKEN_HEADER, readCapabilityToken } from '../recordings/capability.js'

/**
 * THE APP'S TENTH MUTATING CALL (prd-57 ruling 4; ADR-0053, amending ADR-0019).
 *
 * `replay/mutating-calls-law.test.ts` enumerates the app's whole mutating
 * surface and this module is the tenth entry in it — deliberately in the
 * enumeration, never an exception to it. What it asks for is the fourth hand's
 * third power: enlist or unenlist a harness's user-level configuration, so the
 * instrument can see agents it did not launch.
 *
 * ## Why a tenth mutating call is allowed to exist, argued in its own diff
 *
 * The law's three-reason bar, met here rather than inherited from the nine
 * before it:
 *
 * 1. **It writes only OUTSIDE the watched repo, and only what is fenced.** One
 *    file, `~/.claude/settings.json`, in the operator's own home — never inside
 *    any repository, which `concierge/enlist.ts`'s `assertUserLevelTarget`
 *    refuses through `isInside` rather than trusting the adapter not to ask.
 *    ADR-0019 clause 4 is "never inside the watched repo", and a write there
 *    would show up as a dirty file this instrument then reports on. Exactly the
 *    declared keys move — `env` gains what the telemetry recipe already
 *    produces, `hooks` gains one entry per lifecycle event — and the original is
 *    copied beside itself first.
 * 2. **It is triggered only by an explicit operator act, and the act is a TWO
 *    STEP.** prd-14 ruling 4's confirmation bar, and here it is stronger than
 *    a convention: {@link requestEnlistDiff} writes nothing and returns the
 *    exact diff with a `sourceDigest`, and {@link applyEnlistment} cannot be
 *    called without that digest because there is nowhere else to obtain one.
 *    **The SERVER holds the invariant** — a caller that forgot to confirm gets a
 *    409, not an unreviewed write to somebody's home directory. That is the
 *    difference between a bar this module implements and a bar it merely asks
 *    its callers to keep.
 * 3. **It never mutates the event log's past.** It touches no event, no
 *    recording and no session; what it changes is a configuration file that
 *    decides what FUTURE sessions report. Nothing recorded is rewritten and
 *    nothing is back-filled.
 *
 * ## And it is reversible, which none of the other nine are
 *
 * The unique thing about this power, and the reason ADR-0053 could grant it:
 * `intent: 'unenlist'` puts the file back. The adapter removes exactly the keys
 * it declared — derived from the recipe rather than a hand-written list, so a
 * variable added later cannot be stranded — and leaves no empty container
 * behind. A lab launch cannot be un-launched and a clone cannot be un-cloned;
 * this can be undone from the same surface that did it.
 */

const ENLIST_URL = '/api/concierge/enlist'

/**
 * Only what this module sends, and narrowed to the literal verb.
 *
 * The narrow spelling is the law's own idiom and earns its place twice: this
 * type will not typecheck against a call carrying any other verb, and
 * `mutating-calls-law.test.ts` counts every declaration of one against the
 * quoted ones — so a widened type here reads to that law as a verb it cannot
 * account for, which is precisely what it would be.
 *
 * Worth recording, because it is funny and it cost a run: the first version of
 * this comment explained the rule using the literal token, and the law counts
 * occurrences in PROSE too. A comment about a text-scanning law is inside that
 * law's own corpus.
 */
export type EnlistFetchLike = (
  input: string,
  init: {
    method: 'POST'
    headers: { 'Content-Type': 'application/json'; 'x-rhizomorph-capability': string }
    body: string
  },
) => Promise<{ status: number; ok: boolean; json: () => Promise<unknown>; text: () => Promise<string> }>

export type EnlistIntent = 'enlist' | 'unenlist'

/** One key the enlistment would change, as the route describes it. */
export interface EnlistChange {
  readonly keyPath: readonly string[]
  readonly before: string | null
  readonly after: string | null
}

/** Something already in the file this hand will not overwrite, and what it offers instead. */
export interface EnlistRefusal {
  readonly keyPath: readonly string[]
  readonly existing: string
  readonly reason: string
  readonly offer: string
}

export interface EnlistTarget {
  readonly path: string
  readonly display: string
}

/**
 * The first step's answer. Three arms, and a caller renders all three — a
 * surface that only knew `ready` would show nothing at all on the two outcomes
 * an operator is most likely to meet: already done, or refused.
 */
export type EnlistDiff =
  | {
      readonly kind: 'ready'
      readonly target: EnlistTarget
      readonly changes: readonly EnlistChange[]
      readonly refusals: readonly EnlistRefusal[]
      /** The file as it would be written, for a surface that wants to show it. */
      readonly next: string
      /** The token the second step requires. Obtainable nowhere else. */
      readonly sourceDigest: string
    }
  | { readonly kind: 'already-settled'; readonly target: EnlistTarget; readonly why: string }
  | { readonly kind: 'refused'; readonly target: EnlistTarget; readonly why: string; readonly remedy: string }

export interface EnlistApplied {
  readonly target: EnlistTarget
  /** `null` when the file did not exist — there was nothing to back up. */
  readonly backupPath: string | null
  readonly changedKeys: readonly string[]
}

async function refusalDetail(response: { json: () => Promise<unknown>; text: () => Promise<string> }): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown }
    if (typeof body.error === 'string' && body.error.length > 0) return body.error
  } catch {
    // Fall through: a non-JSON body is still worth showing.
  }
  try {
    return await response.text()
  } catch {
    return 'no detail'
  }
}

async function post(
  body: Record<string, unknown>,
  act: string,
  fetchImpl?: EnlistFetchLike,
): Promise<{ status: number; ok: boolean; json: () => Promise<unknown>; text: () => Promise<string> }> {
  const impl = fetchImpl ?? (globalThis.fetch as unknown as EnlistFetchLike | undefined)
  if (impl === undefined) throw new Error('this browser has no fetch — cannot enlist a harness from here')

  // Refused here rather than sent bare, so the operator reads what is missing
  // instead of a 401 naming a header they cannot supply. ADR-0012's known
  // dev-mode gap made honest, not closed.
  const capabilityToken = readCapabilityToken()
  if (capabilityToken === null) throw new Error(missingTokenMessage(act))

  let response: Awaited<ReturnType<EnlistFetchLike>>
  try {
    response = await impl(ENLIST_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [CAPABILITY_TOKEN_HEADER]: capabilityToken },
      body: JSON.stringify(body),
    })
  } catch (err) {
    throw new Error(`could not reach the instrument: ${err instanceof Error ? err.message : String(err)}`)
  }

  // A 401 means the token WAS sent and rejected, which in practice means the
  // tab outlived the server process that minted it — see `replay/rotate.ts`.
  if (response.status === 401) throw new Error(staleTokenMessage(act, await refusalDetail(response)))
  return response
}

/**
 * STEP ONE. Reads the harness's configuration and returns what enlisting would
 * do. **Writes nothing**, and there is no argument that would make it write.
 */
export async function requestEnlistDiff(
  harness: string,
  intent: EnlistIntent = 'enlist',
  fetchImpl?: EnlistFetchLike,
): Promise<EnlistDiff> {
  const act = intent === 'enlist' ? 'see what enlisting would change' : 'see what unenlisting would change'
  const response = await post({ harness, intent, apply: false }, act, fetchImpl)

  if (!response.ok) {
    // A refusal the route could state is a VALUE here rather than a throw: a
    // harness with no captured config file is an answer an operator should see
    // rendered beside the others, not an exception a caller has to catch to
    // find out that codex simply cannot be enlisted.
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>
    if (typeof body.kind === 'string' && body.kind === 'refused') {
      return {
        kind: 'refused',
        target: body.target as EnlistTarget,
        why: String(body.why ?? body.error ?? 'refused'),
        remedy: String(body.remedy ?? ''),
      }
    }
    throw new Error(`could not read the enlistment diff: ${await refusalDetail(response)}`)
  }

  return (await response.json()) as EnlistDiff
}

/**
 * STEP TWO. Writes, and only against a diff the caller has actually seen.
 *
 * `sourceDigest` is not a convenience parameter — it is the whole bar. The
 * route refuses `apply: true` without it, and refuses it again if the file has
 * moved since the diff was taken, so a write this hand cannot tie to a diff
 * somebody read is a write that does not happen.
 */
export async function applyEnlistment(
  harness: string,
  intent: EnlistIntent,
  sourceDigest: string,
  fetchImpl?: EnlistFetchLike,
): Promise<EnlistApplied> {
  const act = intent === 'enlist' ? 'enlist this harness' : 'unenlist this harness'
  const response = await post({ harness, intent, apply: true, sourceDigest }, act, fetchImpl)

  if (!response.ok) {
    throw new Error(`the enlistment was not applied: ${await refusalDetail(response)}`)
  }
  return (await response.json()) as EnlistApplied
}
