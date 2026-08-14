import { reduceAll, type RhizomorphEvent } from '@rhizomorph/core'

/**
 * WHAT THE RETARGET COST (prd20 ruling 5, spike Q4, #391) — said in the answer,
 * before the cost arrives.
 *
 * The telemetry instance id IS the session id (`api/otel.ts`: "the instance id
 * is the *session* id (`recorder.sessionId`)"), and ruling 5 rotates the
 * session, so a retarget changes it. This is not avoidable and the spike did
 * not claim it was: it is identical under supervised respawn, for the same
 * reason. What IS available is saying so, in the reply to the act that caused
 * it, rather than leaving the operator to infer it from a `telemetry.refused`
 * event a minute later.
 *
 * Every lane launched before the boundary carries
 * `OTEL_RESOURCE_ATTRIBUTES=…,instance=<old session id>`, attached at launch
 * and never retroactively. Each of its exports is now refused WHOLE — 403,
 * never partial, because a body mixing our id with a foreign one is refused
 * entire by design (prd2's no-silent-merge). And the noise is roughly one
 * event per throttle window rather than one per lane: `createRefusalThrottle`
 * keys by *declared* instance, and every stale lane declares the same old id,
 * so an eight-lane swarm is one key and `REFUSAL_THROTTLE_MS` is 60 s. A
 * standing fault, and a quiet one — which is precisely why it has to be said
 * out loud here.
 *
 * What is lost is dollars, traces and active time, not the lane. OTLP is the
 * only source of `llm.cost` and `trace.span`; git and the sessionlog
 * transcript organ keep working untouched, so a retargeted instrument drops a
 * rung for every pre-existing lane rather than going dark. The operator needs
 * both halves of that, or the answer reads as a bigger loss than it is.
 */
export interface RetargetTelemetryCost {
  /** The instance id every pre-boundary lane still declares — the closed session's. */
  previousInstance: string
  /** The instance id this server now answers as — the opened session's. */
  instance: string
  /**
   * Every lane this recording knew at the boundary. Deliberately the superset:
   * a lane that has not exported yet was still launched against the old
   * instance and will still be refused, so naming only lanes observed
   * exporting would under-report exactly the ones nobody has noticed yet.
   */
  lanes: string[]
  /** The re-issue, per lane, ready to paste. Empty when no lane was known. */
  reissue: string[]
  /** The same command with the lane left open, for a lane this recording never saw. */
  reissueTemplate: string
  /** Facts that stop arriving for a pre-boundary lane until it is re-issued. */
  lost: string[]
  /** Facts that do not — so the answer is not read as a bigger loss than it is. */
  stillWorking: string[]
  note: string
}

/**
 * Every lane a fold knows: those a collector has seen (`agents`) and those
 * telemetry has attributed (`telemetry.lanes`).
 *
 * **Read from the CLOSING session's events**, which is an ordering the caller
 * has to get right and nothing here can enforce: after the boundary the
 * recorder's buffer is the NEW session's and holds one `session.started` and
 * nothing else. Called one line later, this returns `[]` — a well-formed,
 * confident report of zero cost for a cost the route has just imposed.
 */
export function lanesAtBoundary(events: readonly RhizomorphEvent[]): string[] {
  const state = reduceAll(events)
  return [...new Set([...Object.keys(state.agents), ...Object.keys(state.telemetry.lanes)])].sort()
}

export interface DescribeTelemetryCostOptions {
  lanes: readonly string[]
  previousInstance: string
  instance: string
  /**
   * This server's port, for a paste-ready re-issue. `0` means "the OS picked"
   * — a real, documented `--port` value — and is treated the same as absent,
   * so the answer names `<port>` rather than printing a command that cannot
   * work. The same posture `/api/concierge/launch` already takes.
   */
  port?: number
}

export function describeTelemetryCost(options: DescribeTelemetryCostOptions): RetargetTelemetryCost {
  const port = options.port === undefined || options.port === 0 ? null : options.port
  const portFlag = port === null ? ' --port <port>' : ` --port ${port}`
  const lanes = [...options.lanes]
  const plural = lanes.length === 1 ? '' : 's'

  return {
    previousInstance: options.previousInstance,
    instance: options.instance,
    lanes,
    reissue: lanes.map((lane) => `rhizomorph env ${lane}${portFlag}`),
    reissueTemplate: `rhizomorph env <lane>${portFlag}`,
    lost: ['llm.cost', 'llm.usage (OTLP)', 'trace.span', 'active time'],
    stillWorking: ['git', 'tmux', 'workmux', 'sessionlog transcripts'],
    note:
      lanes.length === 0
        ? `this instrument is now instance ${options.instance}; any lane still exporting as ` +
          `${options.previousInstance} will be refused whole until its env is re-issued`
        : `${lanes.length} lane${plural} still export${lanes.length === 1 ? 's' : ''} as instance ${options.previousInstance} and ` +
          `${lanes.length === 1 ? 'is' : 'are'} now refused whole — re-issue the env above. Costs, traces and ` +
          'active time stop for them until you do; git, tmux, workmux and their transcripts are unaffected. ' +
          'The refusal is throttled by declared instance, so the log shows about one telemetry.refused per ' +
          'minute for the whole set, not one per lane',
  }
}
