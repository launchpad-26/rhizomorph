import { UNATTRIBUTED_LANE, type RhizomorphEvent, type SignalObservations } from '@rhizomorph/core'

const ACTIVITY_EVENT_TYPES: ReadonlySet<string> = new Set(['tool.activity', 'trace.span', 'agent.activeTime'])
const TELEMETRY_EVENT_TYPES: ReadonlySet<string> = new Set(['llm.usage'])
const COST_EVENT_TYPES: ReadonlySet<string> = new Set(['llm.cost'])

/** Any real event whose `lane` attribution field named a real lane, not the shared "nobody said" bucket. */
function hasAttributedLane(events: readonly RhizomorphEvent[]): boolean {
  return events.some((event) => {
    const lane = (event.payload as { lane?: unknown }).lane
    return typeof lane === 'string' && lane.length > 0 && lane !== UNATTRIBUTED_LANE
  })
}

/**
 * The four signals every organ's emitted `RhizomorphEvent`s can prove on
 * their own, read generically off the shared attribution fields
 * (`packages/core/src/events/telemetry.ts`) instead of one hand-rolled check
 * per organ — the same `lane`/event-type shape sessionlog and otel both
 * already produce.
 *
 * `liveness` and `attention` have no event home yet: `lane-state.ts`'s BLOCKED
 * note explains why sessionlog's transcript-tail state machine cannot publish
 * `agent.status` today, and OTel's spans are retrospective-only by
 * construction. Both come back `emitted: false` here — an organ that derives
 * either signal another way (sessionlog's per-poll snapshot, in particular)
 * overrides those two entries itself after calling this.
 */
export function observeEventSignals(events: readonly RhizomorphEvent[]): SignalObservations {
  const identity = hasAttributedLane(events)
  const activity = events.some((event) => ACTIVITY_EVENT_TYPES.has(event.type))
  const telemetry = events.some((event) => TELEMETRY_EVENT_TYPES.has(event.type))
  const cost = events.some((event) => COST_EVENT_TYPES.has(event.type))

  return {
    identity: {
      emitted: identity,
      detail: identity
        ? 'a real event carried a lane other than UNATTRIBUTED_LANE'
        : 'no real event carried a lane other than UNATTRIBUTED_LANE',
    },
    liveness: {
      emitted: false,
      detail: 'no event type carries a liveness read; an organ deriving it another way must override this entry',
    },
    activity: {
      emitted: activity,
      detail: activity
        ? 'a tool.activity, trace.span or agent.activeTime event was observed'
        : 'no tool.activity, trace.span or agent.activeTime event was observed',
    },
    attention: {
      emitted: false,
      detail: 'no event type carries an attention read; an organ deriving it another way must override this entry',
    },
    telemetry: {
      emitted: telemetry,
      detail: telemetry ? 'an llm.usage event was observed' : 'no llm.usage event was observed',
    },
    cost: {
      emitted: cost,
      detail: cost ? 'an llm.cost event was observed' : 'no llm.cost event was observed',
    },
  }
}
