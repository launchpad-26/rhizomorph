import { z } from 'zod'
import type { EventSource } from './common.js'
import { gitEventSchemas } from './git.js'
import { systemEventSchemas } from './system.js'
import { telemetryEventSchemas } from './telemetry.js'
import { tmuxEventSchemas } from './tmux.js'
import { workmuxEventSchemas } from './workmux.js'

export * from './common.js'
export * from './git.js'
export * from './system.js'
export * from './telemetry.js'
export * from './tmux.js'
export * from './workmux.js'

/** The one event union every consumer reads. Discriminates on `type`. */
export const observatoryEventSchema = z.discriminatedUnion('type', [
  ...gitEventSchemas,
  ...tmuxEventSchemas,
  ...workmuxEventSchemas,
  ...systemEventSchemas,
  ...telemetryEventSchemas,
])

export type ObservatoryEvent = z.infer<typeof observatoryEventSchema>

export type EventType = ObservatoryEvent['type']

/** The concrete event for one type, e.g. `EventOf<'commit.landed'>`. */
export type EventOf<T extends EventType> = Extract<ObservatoryEvent, { type: T }>

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
  'commit.landed': 'git',
  'worktree.dirty': 'git',
  'pane.discovered': 'tmux',
  'pane.closed': 'tmux',
  'pane.activity': 'tmux',
  'agent.status': 'workmux',
  'session.started': 'system',
  'collector.error': 'system',
  'collector.disabled': 'system',
  'llm.usage': 'sessionlog',
  'llm.cost': 'otel',
  'tool.activity': 'sessionlog',
  // Only the OTLP receiver can refuse a post, so `otel` is not just primary here.
  'telemetry.refused': 'otel',
} as const satisfies Record<EventType, EventSource>

export const EVENT_TYPES = Object.keys(EVENT_SOURCE_BY_TYPE) as EventType[]

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
  return observatoryEventSchema.parse(candidate) as EventOf<T>
}

export type EventParseResult =
  | { ok: true; event: ObservatoryEvent }
  | { ok: false; error: string; issues: z.core.$ZodIssue[] }

/** Validate an unknown value as an event. Never throws. */
export function parseEvent(value: unknown): EventParseResult {
  const result = observatoryEventSchema.safeParse(value)
  if (result.success) return { ok: true, event: result.data }
  return {
    ok: false,
    error: formatIssues(result.error.issues),
    issues: result.error.issues,
  }
}

export function isObservatoryEvent(value: unknown): value is ObservatoryEvent {
  return observatoryEventSchema.safeParse(value).success
}

/** Narrowing helper so consumers can filter a stream without casting. */
export function isEventOfType<T extends EventType>(
  event: ObservatoryEvent,
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
