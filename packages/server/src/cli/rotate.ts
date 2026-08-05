import { otlpEndpoint } from './telemetry-env.js'

/**
 * `rhizomorph rotate`'s client half (prd16 ruling 2).
 *
 * Rotation is asked of the RUNNING instrument rather than performed on its
 * files, for the same reason #187 put a pid+heartbeat lock beside every
 * session log: the process holding a session is the only one that may write
 * it. A second process closing the log out from under it would append a
 * `session.closed` the live writer knows nothing about and then race it on the
 * next line — exactly the two-writers-one-log hazard the lock exists to end.
 * So this module is a thin, honest HTTP client, and `recorder/rotate.ts` (in
 * the server) is where rotation actually happens.
 */

/** Mirrors `POST /api/rotate`'s body — see `api/rotate.ts`. */
export interface RotationSummary {
  closed: { sessionId: string; filePath: string; eventCount: number }
  opened: { sessionId: string; filePath: string }
}

export function rotateUrl(port: number): string {
  return `${otlpEndpoint(port)}/api/rotate`
}

export interface RequestRotationOptions {
  /** Injectable `fetch`, so a unit test needs no socket. Defaults to the global. */
  fetch?: typeof globalThis.fetch
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readSide(value: unknown): { sessionId: string; filePath: string } | null {
  if (!isRecord(value)) return null
  const { sessionId, filePath } = value
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null
  if (typeof filePath !== 'string' || filePath.length === 0) return null
  return { sessionId, filePath }
}

function parseRotation(body: unknown): RotationSummary | null {
  if (!isRecord(body)) return null
  const closed = readSide(body.closed)
  const opened = readSide(body.opened)
  if (closed === null || opened === null) return null
  const eventCount = isRecord(body.closed) ? body.closed.eventCount : undefined
  if (typeof eventCount !== 'number' || !Number.isFinite(eventCount)) return null
  return { closed: { ...closed, eventCount }, opened }
}

/**
 * Asks the Rhizomorph on `port` to close its session and open a fresh one.
 * Throws with a message that names what to do instead — never a stack trace —
 * when nothing is listening, when the server refuses (a `rhizomorph replay`
 * server has no live recording to rotate), or when the answer isn't the shape
 * this command understands.
 */
export async function requestRotation(
  port: number,
  options: RequestRotationOptions = {},
): Promise<RotationSummary> {
  const fetchImpl = options.fetch ?? globalThis.fetch
  const url = rotateUrl(port)

  let response: Response
  try {
    response = await fetchImpl(url, { method: 'POST' })
  } catch (err) {
    throw new Error(unreachable(port, err instanceof Error ? err.message : String(err)))
  }

  if (!response.ok) {
    const detail = await refusalDetail(response)
    throw new Error(`rotation refused by the Rhizomorph on port ${port}: ${detail}`)
  }

  let body: unknown
  try {
    body = await response.json()
  } catch (err) {
    throw new Error(
      unreachable(port, `${url} did not answer JSON: ${err instanceof Error ? err.message : String(err)}`),
    )
  }

  const rotation = parseRotation(body)
  if (rotation === null) {
    throw new Error(unreachable(port, `${url} answered something other than a rotation — is an Rhizomorph really listening there?`))
  }
  return rotation
}

/** The server's own `{ error }` when it has one, else the bare status. */
async function refusalDetail(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json()
    const error = isRecord(body) ? body.error : undefined
    if (typeof error === 'string' && error.length > 0) return error
  } catch {
    // fall through to the status line
  }
  return `HTTP ${response.status}`
}

function unreachable(port: number, detail: string): string {
  return `cannot rotate the session on port ${port}: ${detail}
A session is closed by the instrument that owns its log, so the server must be running (\`npm start -- --port ${port}\`) — or use the dashboard's "end session · start fresh" button.`
}

/** What the command prints on success: what ended, how big it was, and what is being recorded now. */
export function renderRotation(rotation: RotationSummary): string {
  const events = rotation.closed.eventCount.toLocaleString()
  return (
    `closed session ${rotation.closed.sessionId} — ${events} events, flushed to ${rotation.closed.filePath}\n` +
    `opened session ${rotation.opened.sessionId} — recording to ${rotation.opened.filePath}`
  )
}
