import { ComparisonArtifactError, type ComparisonArtifact, parseComparisonArtifact } from '../lab/compare/artifact.js'
import type { FetchLike } from '../replay/api.js'
import { capabilityRead } from './capabilityRead.js'

export type { FetchLike }

/**
 * THE RECORDINGS LIBRARY'S OTHER KIND (prd-14 ruling 5, #214). Parses
 * `GET /api/lab/comparisons` and `GET /api/lab/comparisons/:id`
 * (`packages/server/src/comparisons/store.ts` via `packages/server/src/api/lab.ts`)
 * into this library's own listing — a comparison is a saved artifact, not a
 * session recording, and this module is what makes that distinction visible
 * on the wire rather than only in the type name.
 *
 * The two refusal paths this repo names most often as the same defect shape
 * (a surface that renders one and swallows the other): a LIST row for an
 * unreadable artifact answers `{ available: false, reason }` per row, and a
 * single READ answers it for the whole artifact. Both are the SAME shape
 * here — `ComparisonRowListing` and `ComparisonReadResult` both carry
 * `available` and `reason` identically — so a caller that renders one
 * correctly has no separate shape to get wrong for the other.
 *
 * The single read re-runs the artifact through this package's OWN parser
 * (`lab/compare/artifact.ts`, private everywhere but the write-admission
 * check ADR-0042 gives the server) rather than trusting the server's
 * `available: true` at face value — the wire is never trusted merely because
 * the server already validated it once. A version this parser refuses comes
 * back as `available: false` with the parser's own sentence, which is what
 * this issue's third Definition-of-done bullet puts on screen BY NAME: never
 * an empty state, never a console error.
 */
export interface ComparisonRowListing {
  id: string
  sizeBytes: number
  available: boolean
  savedAt?: string
  arms?: number
  reason?: string
}

export type ComparisonReadResult =
  | { id: string; available: true; artifact: ComparisonArtifact }
  | { id: string; available: false; reason: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isComparisonRowListing(value: unknown): value is ComparisonRowListing {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.sizeBytes !== 'number') return false
  if (value.available === true) {
    return typeof value.savedAt === 'string' && typeof value.arms === 'number'
  }
  if (value.available === false) {
    return typeof value.reason === 'string'
  }
  return false
}

/** Every saved comparison this repo has, exactly as `listComparisons` ordered them — available ones by `savedAt`, then unreadable ones by id. */
export async function fetchComparisons(fetchImpl: FetchLike = capabilityRead): Promise<ComparisonRowListing[]> {
  const response = await fetchImpl('/api/lab/comparisons')
  if (!response.ok) throw new Error(`/api/lab/comparisons responded ${response.status}`)
  const data: unknown = await response.json()
  // A missing or malformed `comparisons` array is refused with the SAME
  // sentence a malformed row is (below), not silently read as `[]` — this
  // repo's own most common defect shape is a broken response rendering
  // identically to an honest empty state, and this route's own ROW axis
  // already refuses rather than drops. Review round 2 (finding 2): the two
  // policies must agree, and fail-closed is the one that agrees with the
  // rest of this module and with the issue's own "never an empty state"
  // theme — a genuinely empty library is `{ comparisons: [] }`, a real,
  // well-shaped answer, and stays indistinguishable from nothing only when
  // the server actually says so.
  if (!isRecord(data) || !Array.isArray(data.comparisons)) {
    throw new Error('/api/lab/comparisons returned a shape this library does not recognise')
  }
  if (!data.comparisons.every(isComparisonRowListing)) {
    throw new Error('/api/lab/comparisons returned a shape this library does not recognise')
  }
  return data.comparisons
}

/**
 * One saved comparison, by id. Throws only for a gate refusal or a malformed
 * response — a version this reader refuses resolves to `available: false`,
 * never a throw, so the caller renders it the same way a list row's own
 * refusal is rendered.
 */
export async function fetchComparison(id: string, fetchImpl: FetchLike = capabilityRead): Promise<ComparisonReadResult> {
  const response = await fetchImpl(`/api/lab/comparisons/${encodeURIComponent(id)}`)
  if (!response.ok) throw new Error(`/api/lab/comparisons/${id} responded ${response.status}`)
  const data: unknown = await response.json()
  if (!isRecord(data) || typeof data.id !== 'string') {
    throw new Error('/api/lab/comparisons/:id returned a shape this library does not recognise')
  }
  if (data.available === false) {
    if (typeof data.reason !== 'string') {
      throw new Error('/api/lab/comparisons/:id returned a shape this library does not recognise')
    }
    return { id: data.id, available: false, reason: data.reason }
  }
  if (data.available !== true) {
    throw new Error('/api/lab/comparisons/:id returned a shape this library does not recognise')
  }
  try {
    const artifact = parseComparisonArtifact(JSON.stringify(data.artifact))
    return { id: data.id, available: true, artifact }
  } catch (err) {
    if (err instanceof ComparisonArtifactError) return { id: data.id, available: false, reason: err.message }
    throw err
  }
}
