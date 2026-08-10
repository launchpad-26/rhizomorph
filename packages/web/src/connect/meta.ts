import { CONNECTION_SOURCES, RUNGS, SIGNALS, type ConnectionSource, type Rung, type Signal } from '@rhizomorph/core'

/**
 * THE TWO GETS THE CONNECT PAGE READS, PARSED DEFENSIVELY (prd19 ruling 5,
 * wave 3, #258).
 *
 * `/api/meta` (#255) carries the enrichment rung, every collector's declared
 * capabilities with their `reason`/`remedy`, the `selectConnection` facts, the
 * session id and the boot facts. `GET /api/doctor` (#253) carries the
 * filesystem facts state cannot know — the slug dir, version drift, the lane
 * manifest.
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
}

export type DoctorStatus = 'ok' | 'warn' | 'fail'

export interface DoctorFact {
  id: string
  status: DoctorStatus
  message: string
  /** `DoctorCheck.assumed` — the route sets it when a finding rests on an assumed input rather than a measured one. */
  assumed: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** A finite number, or `null`. `NaN`/`Infinity` are not facts about a clock or a count. */
function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
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
  return { firstEventTs: num(value.firstEventTs), lastEventTs: num(value.lastEventTs), count }
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
      firstEventTs: num(entry.firstEventTs),
      lastEventTs: num(entry.lastEventTs),
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
  }
}

/**
 * `GET /api/doctor` answers with the bare `DoctorCheck[]` array. A check
 * missing an id, a status this page doesn't know, or a message is dropped —
 * a half-read check would render as a fact with no finding in it.
 */
export function parseDoctor(body: unknown): DoctorFact[] | null {
  if (!Array.isArray(body)) return null
  const checks: DoctorFact[] = []
  for (const entry of body) {
    if (!isRecord(entry)) continue
    const id = str(entry.id)
    const message = str(entry.message)
    const status = entry.status
    if (id === null || message === null || typeof status !== 'string') continue
    if (!DOCTOR_STATUSES.includes(status as DoctorStatus)) continue
    checks.push({ id, status: status as DoctorStatus, message, assumed: entry.assumed === true })
  }
  return checks
}

/** The named check, or `null` — the caller renders {@link UNAVAILABLE} rather than inventing a status. */
export function doctorCheck(checks: readonly DoctorFact[] | null, id: string): DoctorFact | null {
  return checks?.find((check) => check.id === id) ?? null
}

function defaultFetch(): FetchLike | null {
  return typeof globalThis.fetch === 'function' ? ((input: string) => globalThis.fetch(input)) as FetchLike : null
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

export function fetchDoctor(fetchImpl?: FetchLike): Promise<DoctorFact[] | null> {
  return readJson(DOCTOR_URL, parseDoctor, fetchImpl)
}
