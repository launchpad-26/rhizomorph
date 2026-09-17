import {
  type ApiVersionVerdict,
  CONNECTION_SOURCES,
  type ConnectionSource,
  compareApiVersion,
  RUNGS,
  type Rung,
  SIGNALS,
  type Signal,
} from '@rhizomorph/core'
import { capabilityRead } from '../recordings/capabilityRead.js'

/**
 * THE GETS THE CONNECT PAGE READS, PARSED DEFENSIVELY (prd19 ruling 5,
 * wave 3, #258; a third joined them in prd-20 w7, #520).
 *
 * `/api/meta` (#255) carries the enrichment rung, every collector's declared
 * capabilities with their `reason`/`remedy`, the `selectConnection` facts, the
 * session id and the boot facts. `GET /api/doctor` (#253) carries the
 * filesystem facts state cannot know — the slug dir, version drift, the lane
 * manifest. `GET /api/session-preview/:sessionId` (#516) carries one session's
 * first words, read per enumerated session rather than on the poll — see
 * {@link fetchSessionPreview}.
 *
 * **Everything here follows `parseBootFacts`' precedent (`app/StatusBar.tsx`):
 * a missing or wrong-typed field reads "unavailable", never half-trusted.**
 * That is not defensiveness for its own sake — this page's entire job is to
 * say what is proven and what is not, so a page that quietly rendered `0`
 * for an absent count, or `"live"` for an absent status, would be committing
 * the exact `sourceStatus(undefined) → 'live'` sin ruling 4 exists to remove,
 * one layer down. Every parse below therefore either returns the fact it
 * actually read or `null`, and {@link UNAVAILABLE} is the one word the UI
 * shows in its place.
 *
 * The shapes are re-declared here rather than imported from the server: the
 * web package cannot import `@rhizomorph/server`, and a shared type would be
 * a compile-time claim about a runtime payload anyway — an older server, a
 * proxy, or a body that never arrived all reach this file as `unknown`, which
 * is exactly what these functions take.
 */

/** The one word for a fact this page could not read. Never `0`, never `"none"`. */
export const UNAVAILABLE = 'unavailable'

export const META_URL = '/api/meta'
export const DOCTOR_URL = '/api/doctor'
export const REPOS_URL = '/api/concierge/repos'

/** The narrow slice of `fetch` these reads need — the same seam `StatusBar`'s `MetaFetchLike` uses. */
export type FetchLike = (input: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>

/** One signal's declared honesty, with the `reason`/`remedy` prd15 ruling 5 requires of anything not `provided`. */
export interface SignalFact {
  signal: Signal
  level: 'provided' | 'partial' | 'absent'
  reason: string | null
  remedy: string | null
}

/** One collector's capability manifest as `/api/meta` served it. */
export interface CollectorFacts {
  name: string
  signals: SignalFact[]
}

/** `SourceFlow` as it survives the wire: three facts, each independently defensible. */
export interface FlowFacts {
  firstEventTs: number | null
  lastEventTs: number | null
  count: number
}

export interface UninstrumentedFacts {
  sessionId: string
  lanes: string[]
  roles: string[]
  firstEventTs: number | null
  lastEventTs: number | null
  /** `UninstrumentedSession.worktreePath` — nullable on the wire the same way every other unproven fact here is. */
  worktreePath: string | null
  /** `UninstrumentedSession.branch` — same rule as {@link worktreePath}. */
  branch: string | null
}

/** `/api/meta`'s `connection.refusals` — the standing-fault summary (#255's `RefusalsSummary`). */
export interface RefusalFacts {
  count: number
  instance: string | null
  expectedInstance: string | null
}

export interface ConnectionFacts {
  sources: Partial<Record<ConnectionSource, FlowFacts>>
  uninstrumentedSessions: UninstrumentedFacts[]
  refusals: RefusalFacts | null
}

/** The boot facts #181 added and this page restates — the same three fields `parseBootFacts` reads. */
export interface BootFacts {
  resumedCount: number
  resumeWindowMs: number
  lastBootReason: string
}

export interface MetaFacts {
  sessionId: string | null
  repoPath: string | null
  repoName: string | null
  rung: Rung | null
  collectors: CollectorFacts[]
  connection: ConnectionFacts | null
  boot: BootFacts | null
  /**
   * prd-58 ruling 8: what this view should do about the version it was handed.
   *
   * A fact like every other field here, not a thrown error — `/connect` exists
   * to state what it found, and "the server speaks a different dialect" is a
   * finding about the instrument exactly as an absent collector is.
   */
  apiVersion: ApiVersionVerdict
}

export type DoctorStatus = 'ok' | 'warn' | 'fail'

export interface DoctorFact {
  id: string
  status: DoctorStatus
  message: string
  /** `DoctorCheck.assumed` — the route sets it when a finding rests on an assumed input rather than a measured one. */
  assumed: boolean
  /** `DoctorCheck.lastAckAt` (prd-51 ruling 12) — epoch ms of the shipper's most recently acknowledged batch, or `null` when the wire carried none (absent, non-numeric, or outside {@link isRenderableTs}'s range). */
  lastAckAt: number | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * The widest instant a `Date` can be, per ECMA-262 (`±8.64e15` ms — ±275,760
 * years). **One millisecond past it, `toISOString()` throws a `RangeError`**,
 * and the throw would land mid-render inside `LinkRow`'s `<time>` — on a
 * route with no `ErrorBoundary` above it (`App.tsx`'s switch), so `/connect`
 * would blank. On the page a stranger opens precisely when their setup is
 * already misbehaving, that is the worst failure this file can have.
 */
const MAX_TIME_VALUE = 8.64e15

/**
 * A timestamp this page can both reason about and RENDER: a non-negative
 * number no `Date` will refuse. The guard is here, at the parse boundary,
 * rather than in the formatter — `replay/format.ts`'s `formatWallClock` is
 * shared with replay's chrome and is not this issue's to change, so nothing
 * invalid may reach it.
 */
export function isRenderableTs(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= MAX_TIME_VALUE
}

/**
 * A timestamp field, or `null` — `NaN`, `Infinity`, a negative, and the
 * finite-but-unrenderable `1e300` all read as "this page has no timestamp
 * for that", which is a state every consumer already handles.
 *
 * Worth stating why the served number cannot simply be trusted. This body is
 * plain JSON — no schema ran on it at all, so any number at all can arrive.
 * And even the validated path has a gap: the event envelope's own
 * `timestampSchema` (`z.number().int().nonnegative()`) tops out at
 * `Number.MAX_SAFE_INTEGER`, ~9.007e15, while a `Date` refuses anything past
 * ±8.64e15 — so a `ts` between the two passes validation, folds, and is
 * served back out of `/api/meta` intact.
 */
function ts(value: unknown): number | null {
  return typeof value === 'number' && isRenderableTs(value) ? value : null
}

/**
 * A tally: a non-negative INTEGER. Fractions are rejected rather than shown —
 * "0.5 folded records" is not a fact any log can hold, and rendering one as
 * VERIFIED would let a malformed body buy the strongest word this page has.
 */
function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

const LEVELS = ['provided', 'partial', 'absent'] as const
const DOCTOR_STATUSES: readonly DoctorStatus[] = ['ok', 'warn', 'fail']

function parseSignal(signal: Signal, value: unknown): SignalFact | null {
  if (!isRecord(value)) return null
  const level = value.level
  if (typeof level !== 'string' || !(LEVELS as readonly string[]).includes(level)) return null
  return {
    signal,
    level: level as SignalFact['level'],
    reason: str(value.reason),
    remedy: str(value.remedy),
  }
}

/**
 * `capabilities` is a `Record<collectorName, AdapterCapabilities>` keyed by
 * whatever collectors the serving build registered — deliberately read by
 * iterating the body's own keys rather than a list pinned here, so a server
 * that grew a sixth collector still reports it instead of having it silently
 * dropped by a stale allowlist. The SIX SIGNALS are pinned (they are a core
 * type, and a name outside them is not a signal this page knows how to
 * render), and a collector whose entry parses to no signal at all is dropped
 * rather than rendered as an empty, flattering row.
 */
function parseCollectors(value: unknown): CollectorFacts[] {
  if (!isRecord(value)) return []
  const collectors: CollectorFacts[] = []
  for (const [name, capabilities] of Object.entries(value)) {
    if (!isRecord(capabilities)) continue
    const signals: SignalFact[] = []
    for (const signal of SIGNALS) {
      const fact = parseSignal(signal, capabilities[signal])
      if (fact !== null) signals.push(fact)
    }
    if (signals.length > 0) collectors.push({ name, signals })
  }
  return collectors
}

/**
 * A flow needs its `count` to be a real number to mean anything at all; the
 * two timestamps are independently nullable because `null` is exactly what
 * `SourceFlow` uses for "nothing has ever arrived" (and is therefore a fact,
 * not a parse failure).
 */
function parseFlow(value: unknown): FlowFacts | null {
  if (!isRecord(value)) return null
  const count = num(value.count)
  if (count === null) return null
  return { firstEventTs: ts(value.firstEventTs), lastEventTs: ts(value.lastEventTs), count }
}

function parseUninstrumented(value: unknown): UninstrumentedFacts[] {
  if (!Array.isArray(value)) return []
  const sessions: UninstrumentedFacts[] = []
  for (const entry of value) {
    if (!isRecord(entry)) continue
    const sessionId = str(entry.sessionId)
    if (sessionId === null) continue
    sessions.push({
      sessionId,
      lanes: strings(entry.lanes),
      roles: strings(entry.roles),
      firstEventTs: ts(entry.firstEventTs),
      lastEventTs: ts(entry.lastEventTs),
      worktreePath: str(entry.worktreePath),
      branch: str(entry.branch),
    })
  }
  return sessions
}

function parseRefusals(value: unknown): RefusalFacts | null {
  if (!isRecord(value)) return null
  const count = num(value.count)
  if (count === null) return null
  return { count, instance: str(value.instance), expectedInstance: str(value.expectedInstance) }
}

function parseConnection(value: unknown): ConnectionFacts | null {
  if (!isRecord(value)) return null
  const sources: Partial<Record<ConnectionSource, FlowFacts>> = {}
  for (const source of CONNECTION_SOURCES) {
    const flow = parseFlow(value[source])
    if (flow !== null) sources[source] = flow
  }
  return {
    sources,
    uninstrumentedSessions: parseUninstrumented(value.uninstrumentedSessions),
    refusals: parseRefusals(value.refusals),
  }
}

/**
 * Boot facts are all-or-nothing on purpose, exactly as `parseBootFacts` reads
 * them: the three fields are one sentence ("resumed N times, against an M
 * window, because X"), and half of that sentence is not a shorter truth. The
 * reason string is NOT validated against a pinned list here — this page
 * restates it, it does not branch on it, so a reason a newer server invented
 * reads as itself rather than as `unavailable`.
 */
function parseBoot(body: Record<string, unknown>): BootFacts | null {
  const resumedCount = num(body.resumedCount)
  const resumeWindowMs = num(body.resumeWindowMs)
  const lastBootReason = str(body.lastBootReason)
  if (resumedCount === null || resumeWindowMs === null || lastBootReason === null) return null
  return { resumedCount, resumeWindowMs, lastBootReason }
}

/**
 * `/api/meta`'s body, field by field. Only a body that is not an object at
 * all reads as `null` — anything else answers with whatever it actually
 * proved, so a server that predates prd19's additive fields still gives this
 * page its rung and session id instead of nothing.
 */
export function parseMeta(body: unknown): MetaFacts | null {
  if (!isRecord(body)) return null
  const rung = body.rung
  return {
    sessionId: str(body.sessionId),
    repoPath: str(body.repoPath),
    repoName: str(body.repoName),
    rung: typeof rung === 'string' && (RUNGS as readonly string[]).includes(rung) ? (rung as Rung) : null,
    collectors: parseCollectors(body.capabilities),
    connection: parseConnection(body.connection),
    boot: parseBoot(body),
    // A server that predates ruling 8 sends no version, which reads `unknown`
    // and changes nothing — the same leniency every other field here already
    // has, and the reason this page still works against an older instrument.
    apiVersion: compareApiVersion(body.apiVersion),
  }
}

/**
 * What a read of `GET /api/doctor` can actually come to (#381, paying the
 * debt #346 recorded). Three facts, three shapes, because a consumer that
 * gets one value for two facts has nowhere to put the difference:
 *
 * - **`absent`** — nothing usable arrived. A dead route, a rejected request,
 *   a non-2xx, a body that was not JSON, a body that was not the array shape
 *   ({@link readJson} and {@link parseDoctor} both land here). The reader's
 *   next move is the route.
 * - **`unreadable`** — the route ANSWERED: a non-empty report arrived, and
 *   not one entry of it survived this page's parse. The route is doing its
 *   job; this build cannot read what it says. The reader's next move is the
 *   payload — a page and server built from different versions, usually.
 * - **`checks`** — the answer, as parsed. `[]` stays the honest reading of a
 *   route that ran and found nothing to say (#346: an all-malformed body must
 *   never collapse onto it, and now cannot — it is `unreadable`).
 */
export type DoctorReading =
  | { kind: 'absent' }
  | { kind: 'unreadable' }
  | { kind: 'checks'; checks: DoctorFact[] }

/**
 * `GET /api/doctor` answers with the bare `DoctorCheck[]` array. A check
 * missing an id, a status this page doesn't know, or a message is dropped —
 * a half-read check would render as a fact with no finding in it.
 *
 * A body only PARTLY unreadable still answers with its survivors, following
 * {@link parseCollectors}: the checks that parsed are real findings, and
 * withholding them because a sibling entry was malformed would lose more truth
 * than it protects. Only a non-empty body with NO survivors is `unreadable` —
 * that is #346's fact ("a body this page could not read"), now carried as its
 * own shape instead of folded onto the transport failures (#381).
 */
export function parseDoctor(body: unknown): DoctorReading {
  if (!Array.isArray(body)) return { kind: 'absent' }
  const checks: DoctorFact[] = []
  for (const entry of body) {
    if (!isRecord(entry)) continue
    const id = str(entry.id)
    const message = str(entry.message)
    const status = entry.status
    if (id === null || message === null || typeof status !== 'string') continue
    if (!DOCTOR_STATUSES.includes(status as DoctorStatus)) continue
    checks.push({ id, status: status as DoctorStatus, message, assumed: entry.assumed === true, lastAckAt: ts(entry.lastAckAt) })
  }
  if (checks.length === 0 && body.length > 0) return { kind: 'unreadable' }
  return { kind: 'checks', checks }
}

/** The named check, or `null` — the caller renders {@link UNAVAILABLE} rather than inventing a status. A reading with no checks in it has no named check. */
export function doctorCheck(reading: DoctorReading, id: string): DoctorFact | null {
  return reading.kind === 'checks' ? (reading.checks.find((check) => check.id === id) ?? null) : null
}

/**
 * `/api/session-preview/:sessionId` and `/api/concierge/repos` are
 * `gated-read`s (prd-29 ruling 7, #58), and `/api/meta` and `/api/doctor`
 * joined them in wave 2a (ruling 7, #59). All four share this one default, so
 * every read in this file goes through the shared `capabilityRead` rather
 * than growing a second token path — an injected `fetchImpl` (tests)
 * bypasses it.
 */
function defaultFetch(): FetchLike | null {
  return typeof globalThis.fetch === 'function' ? (capabilityRead as FetchLike) : null
}

/**
 * One GET, parsed. Every failure mode — no `fetch` at all, a rejected
 * request, a non-2xx, a body that isn't JSON, a body that doesn't parse —
 * lands on the same `null`, because they are the same fact to a reader: this
 * page could not read that route just now. The *distinction* the page does
 * make is null-vs-fact, never a fabricated middle.
 */
async function readJson<T>(url: string, parse: (body: unknown) => T | null, fetchImpl?: FetchLike): Promise<T | null> {
  const impl = fetchImpl ?? defaultFetch()
  if (impl === null) return null
  try {
    const response = await impl(url)
    if (!response.ok) return null
    return parse(await response.json())
  } catch {
    return null
  }
}

export function fetchMeta(fetchImpl?: FetchLike): Promise<MetaFacts | null> {
  return readJson(META_URL, parseMeta, fetchImpl)
}

/**
 * A SESSION'S FIRST WORDS (#516's route, read by #520's enumeration).
 *
 * A list of session ids is not something an operator can choose between — the
 * ids are opaque, and the one question they are actually asking is "which of
 * these is the conversation I am in?". The first user message answers it in a
 * glance, which is the whole reason `GET /api/session-preview/:sessionId`
 * exists.
 *
 * Deliberately NOT part of the page's polling pair. It is read once per
 * enumerated session when there is an enumeration to read for, so a page with
 * nothing broken makes no preview request at all.
 */
export interface SessionPreview {
  sessionId: string
  /**
   * The first user turn in the head of the transcript, capped by the route.
   * `null` covers both nothings the route can answer with — a head chunk
   * holding no user turn, and no transcript to read at all — because the
   * consumer's move is the same in each: say there is no preview, and never
   * block on it.
   */
  text: string | null
  /** Characters the route cut from the full first message. `0` when it all fit. */
  dropped: number
  /** The route's own account when it has nothing to show — WHAT is missing → WHY → what to do. */
  reason: string | null
}

/**
 * The preview body, or `null` for anything this page cannot read as one —
 * `readJson`'s own rule, one route further on. The distinction that IS kept is
 * the route's two answers: a preview it read, and a named absence it can
 * explain. A body with no `sessionId` is neither, and reads as nothing.
 */
export function parseSessionPreview(body: unknown): SessionPreview | null {
  if (!isRecord(body)) return null
  const sessionId = str(body.sessionId)
  if (sessionId === null) return null

  const first = body.firstUserMessage
  if (body.available === true && isRecord(first)) {
    const text = str(first.text)
    // `available: true` with no readable first message is an honest 200 (the
    // head chunk held no user turn yet) — it falls through to the same
    // no-preview answer as an unavailable one, carrying whatever reason came
    // with it rather than inventing text.
    if (text !== null) return { sessionId, text, dropped: num(first.dropped) ?? 0, reason: null }
  }
  return { sessionId, text: null, dropped: 0, reason: str(body.reason) }
}

/**
 * The in-directory GET. **`encodeURIComponent` is not decoration**: the id is
 * interpolated into a path, and the route refuses a traversal-shaped id with a
 * 400 (`isValidSessionIdParam`) — which lands here as the same `null` every
 * other unreadable answer does, so a malformed id degrades to "no preview"
 * rather than to a broken page.
 */
export function fetchSessionPreview(sessionId: string, fetchImpl?: FetchLike): Promise<SessionPreview | null> {
  return readJson(`/api/session-preview/${encodeURIComponent(sessionId)}`, parseSessionPreview, fetchImpl)
}

/** {@link readJson}'s transport-level `null` is the same fact as a non-array body: nothing usable arrived. */
export async function fetchDoctor(fetchImpl?: FetchLike): Promise<DoctorReading> {
  return (await readJson(DOCTOR_URL, parseDoctor, fetchImpl)) ?? { kind: 'absent' }
}

/**
 * THE REPOS THIS MACHINE ALREADY HAS (prd-20 ruling 5, wave 4, #266) —
 * `GET /api/concierge/repos`, the read-only half of the fourth hand and a
 * fourth GET of doctor's own class: no body, no token, no write.
 *
 * The route answers with two INDEPENDENT, UNMERGED sources, and its own doc is
 * explicit that merging them is the picker's call rather than the route's:
 * `known` reverses every slug under `~/.claude/projects` (the repos the
 * operator's own Claude already knows), and `scanned` is a shallow, bounded
 * walk of conventional roots. This parse is where that call gets made, and it
 * makes it in one direction only — see {@link parseRepos}.
 */
export interface RepoCandidate {
  path: string
  /**
   * How this instrument came to know about it. `claude-history` is the
   * stronger fact — a conversation actually happened there — so it wins a tie,
   * and the reader is shown which it was rather than a merged list that hides
   * the difference.
   */
  origin: 'claude-history' | 'scan'
}

/** A slug under `~/.claude/projects` the server could not walk back to a real path — reported, never dropped. */
export interface UnresolvedRepo {
  slug: string
  reason: string
}

/**
 * What a read of the repos route can come to — the same three-way shape
 * {@link DoctorReading} makes, for the same reason: "nothing arrived", "the
 * route answered that it does not apply here" and "here is the list" send a
 * reader to three different places.
 *
 * `unavailable` is not an error. It is what a REPLAY server answers, on
 * purpose: discovery would still work there and the route declines to run it
 * anyway (`api/concierge.ts` argues why), so the reason is a sentence to show,
 * never a failure to retry.
 */
export type ReposReading =
  | {
      kind: 'repos'
      repos: RepoCandidate[]
      /** Slugs the server could not resolve. Shown, because a missing repo an operator expected is a fact about this list. */
      unresolved: UnresolvedRepo[]
      /** The scan hit its visit budget — the list is honest and incomplete, and saying so is the whole point of the flag. */
      truncated: boolean
      /** Directories the scan reached and could not read. Distinct from `truncated`; see the route's own type. */
      unreadable: string[]
      /** Present when the `~/.claude/projects` half specifically could not be enumerated, with the server's own reason. */
      historyUnavailable: string | null
      /**
       * Resolved paths Claude has history in that are inside NO git repo — a
       * home directory, a probe dir. Counted and shown as their own line, never
       * offered in the picker as "repos" and never silently dropped: the
       * measured picker held three of these beside five real repos.
       */
      nonRepos: string[]
      /** How many repos the {@link REPO_SELECT_CAP} cut from `repos`. Zero means the list is whole. */
      overflow: number
    }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'absent' }

/**
 * The most repos the picker will list. A `<select>` with hundreds of options
 * is not a picker, it is a haystack — and the clone box below it reaches any
 * repo the cap cut, which the wizard says whenever `overflow > 0`. History
 * entries sort before scan entries already, so the cut falls on the weakest
 * evidence first.
 */
export const REPO_SELECT_CAP = 40

/**
 * Whether an unresolved slug is worktree-shaped — one lane of a swarm run,
 * minted per-worktree by `collectors/sessionlog/worktree-slug.ts`'s forward
 * transform (`<repo>__worktrees/<lane>` encodes with a `--worktrees-` infix).
 * One swarm run mints hundreds of these and they die with their directories,
 * so the wizard folds them into a single counted line instead of a sentence
 * each — the measured page rendered 289 of them. Grouping is RENDER-ONLY: the
 * reading still carries every entry, so nothing is dropped from the fact.
 */
export function isWorktreeLaneSlug(slug: string): boolean {
  return /--worktrees-/.test(slug)
}

function parseKnown(value: unknown): {
  repos: RepoCandidate[]
  unresolved: UnresolvedRepo[]
  nonRepos: string[]
  unavailable: string | null
} {
  if (!isRecord(value)) return { repos: [], unresolved: [], nonRepos: [], unavailable: null }
  if (value.available !== true) {
    return { repos: [], unresolved: [], nonRepos: [], unavailable: str(value.reason) }
  }
  const repos: RepoCandidate[] = []
  const unresolved: UnresolvedRepo[] = []
  const nonRepos: string[] = []
  const seenRoots = new Set<string>()
  if (Array.isArray(value.projects)) {
    for (const entry of value.projects) {
      if (!isRecord(entry)) continue
      const target = str(entry.path)
      if (entry.resolved === true && target !== null) {
        // The server's classification, three-valued on purpose:
        //  - a string `repoRoot` is the repo this cwd belongs to (often itself;
        //    sometimes an ancestor — a session run in `<repo>/packages/web`
        //    folds to the repo, which also dedups a repo against its subdirs);
        //  - `null` means Claude has history here and it is inside no repo at
        //    all — a fact the wizard states, not a picker entry;
        //  - absent means an older server that never classified: exactly
        //    yesterday's behaviour, so an old server keeps working.
        if (!('repoRoot' in entry)) {
          repos.push({ path: target, origin: 'claude-history' })
          continue
        }
        const root = str(entry.repoRoot)
        if (root === null) {
          nonRepos.push(target)
          continue
        }
        if (!seenRoots.has(root)) {
          seenRoots.add(root)
          repos.push({ path: root, origin: 'claude-history' })
        }
        continue
      }
      const slug = str(entry.slug)
      // An unresolved entry with no slug and no reason says nothing at all —
      // there is no fact in it to show, so it is dropped rather than rendered
      // as an empty row implying something was found.
      if (slug !== null) {
        unresolved.push({ slug, reason: str(entry.reason) ?? 'the server gave no reason' })
      }
    }
  }
  return { repos, unresolved, nonRepos, unavailable: null }
}

function parseScanned(value: unknown): { repos: RepoCandidate[]; truncated: boolean; unreadable: string[] } {
  if (!isRecord(value)) return { repos: [], truncated: false, unreadable: [] }
  const repos: RepoCandidate[] = []
  if (Array.isArray(value.repos)) {
    for (const entry of value.repos) {
      if (!isRecord(entry)) continue
      const target = str(entry.path)
      if (target !== null) repos.push({ path: target, origin: 'scan' })
    }
  }
  return { repos, truncated: value.truncated === true, unreadable: strings(value.unreadable) }
}

/**
 * The repos body, parsed, with the route's two lists merged BY PATH — the one
 * decision the route deliberately left to its caller.
 *
 * The merge is deduplication and nothing more: a repo Claude already knows can
 * also sit under a common root and would otherwise appear twice in a picker,
 * which reads as two different repos with the same name. Where the two sources
 * name the same path, `claude-history` wins, because "a conversation happened
 * here" is a stronger and more useful fact about a repo than "a directory walk
 * found a `.git` in it" — and neither the count nor the ORDER of the underlying
 * lists is otherwise disturbed: history first, then whatever the scan turned up
 * that history did not already name.
 *
 * `truncated`, `unreadable` and an unenumerable history are all carried rather
 * than swallowed. A picker that showed a short list with no note is a picker
 * that says "these are your repos" when it means "these are some of them".
 */
export function parseRepos(body: unknown): ReposReading | null {
  if (!isRecord(body)) return null
  if (body.available !== true) {
    const reason = str(body.reason)
    return reason === null ? null : { kind: 'unavailable', reason }
  }

  const known = parseKnown(body.known)
  const scanned = parseScanned(body.scanned)

  const seen = new Set(known.repos.map((repo) => repo.path))
  const merged = [...known.repos, ...scanned.repos.filter((repo) => !seen.has(repo.path))]
  // The cap falls after the merge so history-first ordering decides what
  // survives it, and the cut is COUNTED — the wizard says "N more" rather
  // than showing a short list that claims to be the whole truth.
  const repos = merged.slice(0, REPO_SELECT_CAP)

  return {
    kind: 'repos',
    repos,
    unresolved: known.unresolved,
    truncated: scanned.truncated,
    unreadable: scanned.unreadable,
    historyUnavailable: known.unavailable,
    nonRepos: known.nonRepos,
    overflow: merged.length - repos.length,
  }
}

/** {@link readJson}'s transport-level `null` is the same fact as an unreadable body: nothing usable arrived. */
export async function fetchRepos(fetchImpl?: FetchLike): Promise<ReposReading> {
  return (await readJson(REPOS_URL, parseRepos, fetchImpl)) ?? { kind: 'absent' }
}
