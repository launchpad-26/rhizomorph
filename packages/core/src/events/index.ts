import { z } from 'zod'
import { nonEmptyString, timestampSchema, type EventSource } from './common.js'
import { gitEventSchemas } from './git.js'
import { judgeEventSchemas } from './judge.js'
import { labEventSchemas } from './lab.js'
import { systemEventSchemas } from './system.js'
import { telemetryEventSchemas } from './telemetry.js'
import { tmuxEventSchemas } from './tmux.js'
import { traceEventSchemas } from './trace.js'
import { workmuxEventSchemas } from './workmux.js'

export * from './common.js'
export * from './git.js'
export * from './judge.js'
export * from './lab.js'
export * from './system.js'
export * from './telemetry.js'
export * from './tmux.js'
export * from './trace.js'
export * from './upcast.js'
export * from './workmux.js'

/** The one event union every consumer reads. Discriminates on `type`. */
export const rhizomorphEventSchema = z.discriminatedUnion('type', [
  ...gitEventSchemas,
  ...tmuxEventSchemas,
  ...workmuxEventSchemas,
  ...systemEventSchemas,
  ...telemetryEventSchemas,
  ...traceEventSchemas,
  ...labEventSchemas,
  ...judgeEventSchemas,
])

export type RhizomorphEvent = z.infer<typeof rhizomorphEventSchema>

export type EventType = RhizomorphEvent['type']

/** The concrete event for one type, e.g. `EventOf<'commit.landed'>`. */
export type EventOf<T extends EventType> = Extract<RhizomorphEvent, { type: T }>

/** The payload for one type, e.g. `PayloadOf<'commit.landed'>`. */
export type PayloadOf<T extends EventType> = EventOf<T>['payload']

/**
 * Which source owns which type. Lets `createEvent` take a type alone and fill
 * the envelope's `source` in — one place to be wrong instead of every collector.
 *
 * For the prd1 telemetry types this is the *primary* source, the one whose
 * strength the prd names: depth for usage and tool activity, authority for
 * dollars. The other collector passes `source` explicitly to `createEvent`;
 * {@link SourceOf} keeps that choice type-checked per event type.
 */
export const EVENT_SOURCE_BY_TYPE = {
  'worktree.discovered': 'git',
  'worktree.removed': 'git',
  'branch.updated': 'git',
  'branch.removed': 'git',
  'commit.landed': 'git',
  'worktree.dirty': 'git',
  'pane.discovered': 'tmux',
  'pane.closed': 'tmux',
  'pane.activity': 'tmux',
  'agent.status': 'workmux',
  'session.started': 'system',
  // prd16 ruling 2 / prd17 ruling 1: the recorder's own hand closing a log.
  // `system`, like the start it terminates — no collector ever emits it.
  'session.closed': 'system',
  'collector.error': 'system',
  'collector.disabled': 'system',
  'collector.degraded': 'system',
  'collector.recovered': 'system',
  'llm.usage': 'sessionlog',
  'llm.cost': 'otel',
  'tool.activity': 'sessionlog',
  // Only the OTLP receiver can refuse a post, so `otel` is not just primary here.
  'telemetry.refused': 'otel',
  // prd9: spans come off our own `/v1/traces` receiver and nowhere else.
  'trace.span': 'otel',
  // #141: the active-time counter only ever arrives on our own metrics POST.
  'agent.activeTime': 'otel',
  // prd12 ruling 1: the lab's own hand — a distinct, explicitly-invoked
  // actor, not a seventh collector. `'lab'` is deliberately absent from
  // `EventSource`/`eventSourceSchema` (see events/lab.ts); the satisfies
  // clause below is widened by exactly that one literal to say so.
  'fork.checkpoint': 'lab',
  // prd12 ruling 3, phase 2: the same second hand, at dispatch. Its existence
  // is what marks an arm's lane synthetic — see events/lab.ts.
  'fork.dispatched': 'lab',
  // prd11 ruling 6b, phase 1: the semantic judge's structural organ — a real
  // polled collector, unlike `lab`, but `'judge'` is still absent from
  // `eventSourceSchema` because this issue's fence (#152) doesn't reach
  // `events/common.ts`. See the doc comment on `judgeFindingEventSchema`
  // (events/judge.ts) for the full story.
  'judge.finding': 'judge',
} as const satisfies Record<EventType, EventSource | 'lab' | 'judge'>

export const EVENT_TYPES = Object.keys(EVENT_SOURCE_BY_TYPE) as EventType[]

const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set<string>(EVENT_TYPES)

/** Whether this era's union knows `type` at all. The one question {@link parseEventLenient} asks before deciding an unrecognized line is an era gap rather than corruption. */
export function isKnownEventType(type: string): type is EventType {
  return KNOWN_EVENT_TYPES.has(type)
}

/** Which sources one type may carry, e.g. `'sessionlog' | 'otel'` for usage. */
export type SourceOf<T extends EventType> = EventOf<T>['source']

export function sourceOf<T extends EventType>(type: T): (typeof EVENT_SOURCE_BY_TYPE)[T] {
  return EVENT_SOURCE_BY_TYPE[type]
}

export interface EventEnvelopeInit<T extends EventType = EventType> {
  id: string
  ts: number
  /**
   * Which collector saw it. Optional: for every v0 type there is exactly one
   * possible source, so it is filled in from the type. The prd1 telemetry types
   * have two, and the non-primary collector names itself here.
   */
  source?: SourceOf<T>
}

/**
 * Builds a validated event. Throws on an invalid payload — that is the point:
 * a collector producing garbage should fail at the boundary, not downstream.
 */
export function createEvent<T extends EventType>(
  type: T,
  payload: PayloadOf<T>,
  init: EventEnvelopeInit<T>,
): EventOf<T> {
  const candidate = {
    id: init.id,
    ts: init.ts,
    source: init.source ?? EVENT_SOURCE_BY_TYPE[type],
    type,
    payload,
  }
  return rhizomorphEventSchema.parse(candidate) as EventOf<T>
}

export type EventParseResult =
  | { ok: true; event: RhizomorphEvent }
  | { ok: false; error: string; issues: z.core.$ZodIssue[] }

/** Validate an unknown value as an event. Never throws. */
export function parseEvent(value: unknown): EventParseResult {
  const result = rhizomorphEventSchema.safeParse(value)
  if (result.success) return { ok: true, event: result.data }
  return {
    ok: false,
    error: formatIssues(result.error.issues),
    issues: result.error.issues,
  }
}

export function isRhizomorphEvent(value: unknown): value is RhizomorphEvent {
  return rhizomorphEventSchema.safeParse(value).success
}

// --- the lenient boundary (prd17 ruling 3, item 1) ---------------------------

/**
 * The envelope, and nothing but the envelope. `payload` is deliberately not
 * inspected: this schema's whole job is to tell a line that IS an event — from
 * some era, ours or a later one — from a line that is not an event at all.
 *
 * `source` is a plain non-empty string rather than {@link eventSourceSchema},
 * because a newer era may well have grown a collector this one has never heard
 * of, and refusing that line would be the same silent loss under a different
 * name. `ts` must be a real timestamp: it is what lets an unknown still be
 * placed in time, and it is what the record's own `startTs`/`endTs` checks
 * cover — an unknown with no usable `ts` cannot be honestly counted, so it is
 * malformed instead.
 */
const eventEnvelopeProbeSchema = z.object({
  id: nonEmptyString,
  ts: timestampSchema,
  source: nonEmptyString,
  type: nonEmptyString,
})

/**
 * Why this era could not understand a line.
 *
 * - `unknown-type` — the envelope is intact and its `type` is one this era's
 *   union has never heard of. The newer-era case ruling 1 names.
 * - `unknown-shape` — the envelope is intact, the `type` IS known, and the
 *   payload (or `source`) did not validate. Read as an era gap rather than
 *   corruption because a later era widening a payload looks exactly like this
 *   from here, and guessing "corrupt" would drop a real event. The reason is
 *   kept distinct so a reader that wants to treat the two differently can.
 */
export type UnknownEventReason = 'unknown-type' | 'unknown-shape'

/**
 * One event line this era counted but could not fold — preserved byte for byte
 * (prd17 ruling 3, item 1: never silently dropped).
 *
 * `line` is the *exact* text that arrived, not a re-serialization: that is what
 * makes a record containing unknowns still hash-chain clean, and what lets a
 * later era fold what this one only counted.
 */
export interface UnknownEventLine {
  /** The line verbatim. Byte-for-byte what was read; never re-serialized. */
  line: string
  /** The `type` it claimed. Known but unfoldable when `reason` is `unknown-shape`. */
  type: string
  /** Its envelope timestamp — always present, since a line without one is malformed, not unknown. */
  ts: number
  reason: UnknownEventReason
  /** What the union objected to, for a human reading a verifier's output. */
  detail: string
  /** 1-based position in its source, when the caller knew it. */
  lineNumber: number | null
}

/**
 * The lenient parse of one already-JSON-decoded value.
 *
 * `event` is the strict verdict, unchanged — a value this era folds. `unknown`
 * is the honest gap. `malformed` is reserved for what is not an event at all
 * (no envelope, no usable timestamp): calling that "a newer era" would be a
 * lie, and the loud failure is the right answer.
 */
export type LenientEventParse =
  | { kind: 'event'; event: RhizomorphEvent }
  | { kind: 'unknown'; unknown: UnknownEventLine }
  | { kind: 'malformed'; error: string; line: string; lineNumber: number | null }

export interface LenientParseOptions {
  /**
   * The line's exact source text, for byte-for-byte preservation. Defaults to
   * `JSON.stringify(value)` — honest for a caller that only ever had a decoded
   * value (the web reads events off a JSON API, where the log's own bytes are
   * already gone), but a caller holding the real line MUST pass it.
   */
  line?: string
  lineNumber?: number | null
}

/**
 * Validate an unknown value as an event, leniently: an unrecognized line is
 * COUNTED and PRESERVED rather than dropped (prd17 ruling 3, item 1).
 *
 * This is the boundary the finding was about. {@link parseEvent} is an
 * exact-match union, so a line from a newer era failed it and every caller
 * stepped over the failure — which made the reducer's own forward-compat arm
 * (`applyEvent`'s `default`) unreachable, and made "N events we did not
 * understand" unsayable. The strict verdict here is *identical* to
 * {@link parseEvent}'s, by construction: this function calls it. What it adds
 * is the honest third answer between "folded" and "corrupt".
 */
export function parseEventLenient(
  value: unknown,
  options: LenientParseOptions = {},
): LenientEventParse {
  const strict = parseEvent(value)
  if (strict.ok) return { kind: 'event', event: strict.event }

  const lineNumber = options.lineNumber ?? null
  const envelope = eventEnvelopeProbeSchema.safeParse(value)
  if (!envelope.success) {
    return {
      kind: 'malformed',
      error: strict.error,
      line: options.line ?? safeStringify(value),
      lineNumber,
    }
  }

  return {
    kind: 'unknown',
    unknown: {
      line: options.line ?? safeStringify(value),
      type: envelope.data.type,
      ts: envelope.data.ts,
      reason: isKnownEventType(envelope.data.type) ? 'unknown-shape' : 'unknown-type',
      detail: strict.error,
      lineNumber,
    },
  }
}

/**
 * One raw log/record line → the lenient verdict. The lenient counterpart of
 * `jsonl.ts`'s `lineToEvent`, kept here because this is the parse boundary and
 * because it must hand back the line's own bytes: a caller that had the line
 * and got back only a decoded value could no longer preserve it verbatim.
 *
 * A blank line is not an era gap — it is the ordinary shape of an appended
 * file's tail — so it comes back `malformed` for the caller to skip, exactly
 * as `parseJsonl` already skips it.
 */
export function readEventLineLenient(
  line: string,
  lineNumber: number | null = null,
): LenientEventParse {
  if (line.trim().length === 0) {
    return { kind: 'malformed', error: 'blank line', line, lineNumber }
  }
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch (cause) {
    return {
      kind: 'malformed',
      error: cause instanceof Error ? cause.message : 'invalid JSON',
      line,
      lineNumber,
    }
  }
  return parseEventLenient(value, { line, lineNumber })
}

/** How many distinct types to name before falling back to a count. Four fits a banner line. */
const VOICED_TYPE_LIMIT = 4

/**
 * THE HONEST GAP, in words — prd17 ruling 3, item 1's own sentence, written in
 * exactly one place so the session listing, the replay banner and the record
 * verifier cannot drift into three different stories about the same recording.
 *
 * Returns `null` for a recording this era understood completely: an empty
 * string would render as a blank line where a surface expected silence, and
 * "0 events were not understood" is noise, not honesty.
 *
 * Deterministic: the named types are sorted, so the same unknowns always voice
 * the same sentence regardless of the order they were read in.
 */
export function voiceUnknownEvents(unknown: readonly UnknownEventLine[]): string | null {
  if (unknown.length === 0) return null
  const count = unknown.length
  const subject = count === 1 ? '1 event' : `${count} events`
  const verb = count === 1 ? 'was' : 'were'
  const sentence = `${subject} from a newer era ${verb} preserved but not understood`

  const types = [...new Set(unknown.map((entry) => entry.type))].sort()
  const named = types.slice(0, VOICED_TYPE_LIMIT).join(', ')
  const rest = types.length - VOICED_TYPE_LIMIT
  return rest > 0 ? `${sentence} (${named}, +${rest} more)` : `${sentence} (${named})`
}

/** `JSON.stringify` that cannot throw on a cyclic or unserializable value — a preserved line is never worth a crash. */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/** Narrowing helper so consumers can filter a stream without casting. */
export function isEventOfType<T extends EventType>(
  event: RhizomorphEvent,
  type: T,
): event is EventOf<T> {
  return event.type === type
}

function formatIssues(issues: readonly z.core.$ZodIssue[]): string {
  return issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)'
      return `${path}: ${issue.message}`
    })
    .join('; ')
}

/**
 * Sequential, human-readable event ids. Unique within a session, which is all
 * the log needs, and stable enough to diff two recordings by eye.
 */
export function createIdFactory(prefix = 'evt', start = 0): () => string {
  let n = start
  return () => {
    n += 1
    return `${prefix}-${String(n).padStart(6, '0')}`
  }
}
