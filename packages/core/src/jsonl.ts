import { type RhizomorphEvent, parseEvent } from './events/index.js'

/**
 * The session log is JSONL: one event per line, appended forever, read back
 * for replay. Reading is the dangerous direction — a half-written last line is
 * normal when tailing a live session — so nothing here ever throws. A bad line
 * comes back as an error value the caller can log and step over.
 */

export type JsonlErrorKind = 'empty' | 'json' | 'schema'

export interface JsonlError {
  ok: false
  kind: JsonlErrorKind
  error: string
  /** The offending line, verbatim, so it can be shown or re-parsed later. */
  line: string
  /** 1-based, when the caller knew it. */
  lineNumber: number | null
}

export type JsonlResult = { ok: true; event: RhizomorphEvent } | JsonlError

/** One event → one line, with no trailing newline. */
export function eventToLine(event: RhizomorphEvent): string {
  return JSON.stringify(event)
}

/** Many events → a JSONL document, newline-terminated so appends line up. */
export function eventsToJsonl(events: readonly RhizomorphEvent[]): string {
  if (events.length === 0) return ''
  return `${events.map(eventToLine).join('\n')}\n`
}

/** One line → a validated event, or an error value. Never throws. */
export function lineToEvent(line: string, lineNumber: number | null = null): JsonlResult {
  if (line.trim().length === 0) {
    return { ok: false, kind: 'empty', error: 'blank line', line, lineNumber }
  }

  let value: unknown
  try {
    value = JSON.parse(line)
  } catch (cause) {
    return {
      ok: false,
      kind: 'json',
      error: cause instanceof Error ? cause.message : 'invalid JSON',
      line,
      lineNumber,
    }
  }

  const parsed = parseEvent(value)
  if (!parsed.ok) {
    return { ok: false, kind: 'schema', error: parsed.error, line, lineNumber }
  }
  return { ok: true, event: parsed.event }
}

export interface JsonlDocument {
  events: RhizomorphEvent[]
  /** Anything unreadable, with its line number — surfaced, never silent. */
  errors: JsonlError[]
}

/**
 * Parse a whole log. Blank lines are skipped rather than reported: a trailing
 * newline is the normal shape of an appended file, not a fault.
 */
export function parseJsonl(text: string): JsonlDocument {
  const events: RhizomorphEvent[] = []
  const errors: JsonlError[] = []

  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    if (line.trim().length === 0) continue
    const result = lineToEvent(line, i + 1)
    if (result.ok) events.push(result.event)
    else errors.push(result)
  }

  return { events, errors }
}
