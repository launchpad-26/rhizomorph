/**
 * AN SSE PARSER FOR A PROCESS WITH NO BROWSER (#564, S2's "the derived fleet,
 * via the same stream the window uses").
 *
 * The tray badge has to read the fleet, and ruling 8 is emphatic about *which*
 * fleet: "the badge and the notifications never disagree with the instrument —
 * both read the same derived fleet". The window reads `/api/stream` through the
 * browser's `EventSource`; the main process has no `EventSource` (it is a DOM
 * API, and Node's own is not present here — checked, not assumed), so the
 * twenty lines the browser would have provided are here.
 *
 * This is a parser for a wire format, not a second opinion about anything. What
 * it produces goes into `@rhizomorph/core`'s own `parseEvent` and `reduce`, the
 * exact functions `useEventStream.ts` and `streamState.ts` call — see
 * `stream-fold.ts`.
 *
 * The subset of the spec that matters here, and why the rest is absent: the
 * server writes `id:`, `event:` and one `data:` line per event
 * (`api/stream.ts`'s `writeEvent`), separated by a blank line. Multi-line
 * `data:` is supported anyway because the spec's own joining rule is one line
 * of code and a future event with an embedded newline would otherwise arrive
 * silently truncated. Comment lines (`:`) are ignored, which is how a heartbeat
 * is spelled. `retry:` is ignored: reconnection cadence is the feed's own
 * decision, not the server's, and pretending otherwise would put a reconnect
 * storm one server-side typo away.
 */

export interface SseFrame {
  /** The `id:` field, or null. The server sends the event's own id — the SSE resume contract. */
  id: string | null
  /** The `event:` field, defaulting to `message` exactly as the spec says. */
  type: string
  /** The `data:` lines, joined with newlines. */
  data: string
}

/**
 * Incremental: `push` a chunk of any size, get back the frames that completed
 * in it. A chunk boundary in the middle of a frame — or in the middle of a
 * line — is the normal case on a busy stream, not an edge case.
 */
export class SseParser {
  private buffer = ''

  push(chunk: string): SseFrame[] {
    this.buffer += chunk
    const frames: SseFrame[] = []

    for (;;) {
      const boundary = findBoundary(this.buffer)
      if (boundary === null) break
      const raw = this.buffer.slice(0, boundary.at)
      this.buffer = this.buffer.slice(boundary.at + boundary.length)
      const frame = parseFrame(raw)
      if (frame !== null) frames.push(frame)
    }

    return frames
  }
}

/** The end of a frame: a blank line, in either line ending. */
function findBoundary(buffer: string): { at: number; length: number } | null {
  const lf = buffer.indexOf('\n\n')
  const crlf = buffer.indexOf('\r\n\r\n')
  if (lf === -1 && crlf === -1) return null
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return { at: crlf, length: 4 }
  return { at: lf, length: 2 }
}

function parseFrame(raw: string): SseFrame | null {
  let id: string | null = null
  let type: string | null = null
  const data: string[] = []

  for (const line of raw.split(/\r?\n/)) {
    if (line === '' || line.startsWith(':')) continue
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    // "If value starts with a space, remove it" — the spec's own rule, and the
    // reason `data: {"a":1}` does not arrive with a leading space in the JSON.
    const rawValue = colon === -1 ? '' : line.slice(colon + 1)
    const value = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue

    if (field === 'id') id = value
    else if (field === 'event') type = value
    else if (field === 'data') data.push(value)
  }

  // A frame with no data is a keep-alive, not an event.
  if (data.length === 0) return null
  return { id, type: type ?? 'message', data: data.join('\n') }
}
