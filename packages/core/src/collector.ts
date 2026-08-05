import { type EventType, type RhizomorphEvent, type PayloadOf, createEvent } from './events/index.js'

/**
 * The contract between the poll loop (server) and every collector, so neither
 * side has to touch the other's files.
 *
 * A collector is `poll(prevSnapshot) → { nextSnapshot, events[] }`: pure logic
 * over the *output text* of shell commands, with the shelling-out itself
 * pushed behind {@link Exec}. That is what lets collector tests run against
 * captured fixtures with no git, tmux or workmux present.
 */

export interface ExecOptions {
  cwd?: string
  timeoutMs?: number
  env?: Record<string, string>
  /** Stdin to write, for the rare command that wants it. */
  input?: string
}

export interface ExecResult {
  stdout: string
  stderr: string
  /** Exit code, or null if the process was killed by a signal. */
  code: number | null
  /** True for a non-zero exit, a signal, a timeout, or a missing binary. */
  failed: boolean
  /** Set when the binary itself could not be run (ENOENT and friends). */
  errorMessage?: string
}

/**
 * Thin shell wrapper. Argv form, never a shell string — no quoting bugs, and
 * nothing in this app ever needs a shell.
 */
export type Exec = (
  command: string,
  args: readonly string[],
  options?: ExecOptions,
) => Promise<ExecResult>

/** Per-emit overrides. Everything here has a sane default from the tick. */
export interface EmitOptions {
  /**
   * When the fact *actually happened*, epoch millis from the source itself — a
   * session log line's own `timestamp`, a commit's author date. Defaults to the
   * tick clock, which is only honest for facts observed as they happen.
   *
   * A collector replaying history must pass this: stamped with the poll clock,
   * week-old spend lands inside the live rate window and `$/hr` spikes on boot.
   * A value that isn't a non-negative number throws at the envelope boundary,
   * the same way a bad payload does — a broken date parser should be loud.
   */
  ts?: number
}

/** What a collector gets handed on every tick. */
export interface CollectorContext {
  /** Absolute path of the repo being watched. */
  repoPath: string
  /** Epoch millis for this tick. Injectable so tests are deterministic. */
  now: number
  exec: Exec
  /** Session-unique id generator. */
  nextId: () => string
  /**
   * Builds a validated event stamped with a fresh id and, unless `options.ts`
   * names the source's own time, `now`. Collectors should use this rather than
   * hand-rolling envelopes.
   */
  emit: <T extends EventType>(
    type: T,
    payload: PayloadOf<T>,
    options?: EmitOptions,
  ) => RhizomorphEvent
}

export interface PollResult<Snapshot> {
  nextSnapshot: Snapshot
  events: RhizomorphEvent[]
}

/**
 * Generic over its own snapshot type: the loop stores the snapshot opaquely
 * and hands it straight back next tick.
 */
export interface Collector<Snapshot = unknown> {
  /** Stable name, used in `collector.error` / `collector.disabled` payloads. */
  name: string
  /** Snapshot handed to the very first poll. */
  initialSnapshot(): Snapshot
  poll(
    prevSnapshot: Snapshot,
    context: CollectorContext,
  ): Promise<PollResult<Snapshot>> | PollResult<Snapshot>
  /**
   * prd15 ruling 4/5's honesty manifest: which of the six lane signals this
   * collector can actually speak to, and at what confidence. Additive and
   * optional — see {@link UNKNOWN_CAPABILITIES} for what a collector that
   * declares nothing gets instead of a flattering silent default.
   */
  capabilities?: AdapterCapabilities
}

// ── prd15 ruling 4/5 — the honesty layer (`AdapterCapabilities` + the rung) ──

/**
 * The six signals `doctor` and the (future) web gap voice ask of every
 * lane. Named exactly as prd15's direction lists them — `telemetry` is raw
 * usage (tokens); `cost` is dollars, split out because a collector routinely
 * has one without the other (sessionlog: tokens yes, dollars no).
 */
export type Signal = 'identity' | 'liveness' | 'activity' | 'attention' | 'telemetry' | 'cost'

export const SIGNALS: readonly Signal[] = ['identity', 'liveness', 'activity', 'attention', 'telemetry', 'cost']

export type CapabilityLevel = 'provided' | 'partial' | 'absent'

/**
 * A discriminated union rather than three plain optional fields: `provided`
 * needs nothing else, but `partial`/`absent` are *compiler-required* to carry
 * a `reason` — the law "a one-line reason for anything not provided" restated
 * as a type rather than a convention a collector author could skip.
 */
export type CapabilityDetail =
  | { level: 'provided' }
  | { level: 'partial' | 'absent'; reason: string; remedy?: string }

export type AdapterCapabilities = Record<Signal, CapabilityDetail>

function unknownDetail(): CapabilityDetail {
  return {
    level: 'absent',
    reason: 'this collector declares no AdapterCapabilities',
    remedy: 'wire AdapterCapabilities onto the collector (prd15 wave 2a)',
  }
}

/**
 * The honest default for a collector that declares nothing: all six signals
 * `absent`, never a flattering guess. Every field built fresh (not one shared
 * object repeated six times) so nothing downstream can accidentally mutate
 * one signal's detail and affect the others.
 */
export const UNKNOWN_CAPABILITIES: AdapterCapabilities = {
  identity: unknownDetail(),
  liveness: unknownDetail(),
  activity: unknownDetail(),
  attention: unknownDetail(),
  telemetry: unknownDetail(),
  cost: unknownDetail(),
}

/** A collector's declared capabilities, or the honest all-`absent` default when it declares none. */
export function capabilitiesOf(collector: Pick<Collector, 'capabilities'>): AdapterCapabilities {
  return collector.capabilities ?? UNKNOWN_CAPABILITIES
}

/**
 * All six signals `absent` with the same one-line reason (and optional
 * remedy) — what a collector's capabilities become the moment it is disabled
 * or its binary is missing. The law: "a disabled collector's signals read
 * `absent` with a reason, never silently `provided`" — this is the one place
 * that override happens, so it can't be forgotten at a call site.
 */
export function absentCapabilities(reason: string, remedy?: string): AdapterCapabilities {
  const detail: CapabilityDetail = { level: 'absent', reason, remedy }
  return {
    identity: detail,
    liveness: detail,
    activity: detail,
    attention: detail,
    telemetry: detail,
    cost: detail,
  }
}

/**
 * The one call site that decides whether a collector's *declared*
 * capabilities apply right now, or whether it is currently disabled/missing
 * and must read as an honest, reason-carrying absence instead — the law: "a
 * disabled collector's signals read `absent` with a reason, never silently
 * `provided`," applied wherever a caller (`/api/meta`, `doctor`) knows a
 * collector's live status.
 */
export function honestCapabilities(input: {
  capabilities: AdapterCapabilities
  active: boolean
  /** Required when `active` is false — becomes every absent signal's reason. */
  inactiveReason?: string
}): AdapterCapabilities {
  return input.active ? input.capabilities : absentCapabilities(input.inactiveReason ?? 'collector is disabled')
}

const LEVEL_RANK: Record<CapabilityLevel, number> = { absent: 0, partial: 1, provided: 2 }

/**
 * Merges several collectors' capabilities into the one honest picture a lane
 * actually has right now: per signal, the *best* level any contributing
 * collector reaches (a second witness only ever adds confidence, never takes
 * it away — restating the adapters spike's "two witnesses" framing for
 * capabilities rather than liveness readings). Ties keep whichever detail was
 * seen first, so the result is deterministic for a given input order.
 */
export function mergeCapabilities(all: readonly AdapterCapabilities[]): AdapterCapabilities {
  if (all.length === 0) return UNKNOWN_CAPABILITIES

  const merged = {} as Record<Signal, CapabilityDetail>
  for (const signal of SIGNALS) {
    let best = all[0]![signal]
    for (const capabilities of all.slice(1)) {
      const candidate = capabilities[signal]
      if (LEVEL_RANK[candidate.level] > LEVEL_RANK[best.level]) best = candidate
    }
    merged[signal] = best
  }
  return merged as AdapterCapabilities
}

/**
 * prd15 ruling 5's enrichment ladder, named not ranked — but a lane still
 * sits at exactly one rung at a time, which is what `doctor` and `/api/meta`
 * report. `L2` (beacon) and `L3` (PTY wrapper) aren't reachable by any
 * collector in this repo yet (prd15 waves 3 and 7); `deriveRung` still maps
 * them totally so the law — "every capability combination maps to exactly
 * one rung" — holds before those collectors exist, not just after.
 */
export type Rung = 'L0' | 'L1' | 'L2' | 'L3' | 'L4'

export const RUNGS: readonly Rung[] = ['L0', 'L1', 'L2', 'L3', 'L4']

/**
 * Pure and total: never throws, always one of {@link RUNGS}, for any
 * combination of the six signals — including ones no real collector produces
 * today. Read top-down, highest bar first:
 *
 * - **L4** (tmux/workmux): `attention` is `provided` — today the only
 *   mechanism that *declares* attention rather than inferring it. (When the
 *   L2 beacon collector lands it will also declare attention; distinguishing
 *   the two rungs is that collector's own follow-up, not a regression here —
 *   see the doc comment above.)
 * - **L3** (PTY wrapper): `attention` is `partial` (heuristic, not declared)
 *   and `telemetry` is `absent` — a byte stream sees prompts and output but
 *   no tokens at all, unlike the transcript organ.
 * - **L1** (env/OTLP): `cost` is anything but `absent` — dollars exist only
 *   once OTLP (or a pricing-table estimate) is wired in.
 * - **L0**: the floor. Git alone, or git plus the transcript organ, both
 *   land here — L0 is "zero-cooperation," not "zero signal."
 */
export function deriveRung(capabilities: AdapterCapabilities): Rung {
  const level = (signal: Signal): CapabilityLevel => capabilities[signal].level

  if (level('attention') === 'provided') return 'L4'
  if (level('attention') === 'partial' && level('telemetry') === 'absent') return 'L3'
  if (level('cost') !== 'absent') return 'L1'
  return 'L0'
}

/** One step up the ladder, or `null` at the top — the total order `doctor` climbs through, never a claim about which rung is "better." */
export function nextRung(rung: Rung): Rung | null {
  switch (rung) {
    case 'L0':
      return 'L1'
    case 'L1':
      return 'L2'
    case 'L2':
      return 'L3'
    case 'L3':
      return 'L4'
    case 'L4':
      return null
    default: {
      const _never: never = rung
      throw new Error(`unreachable rung: ${String(_never)}`)
    }
  }
}

export interface RungInfo {
  /** Ruling 5's own name for this rung. */
  label: string
  /** What climbing past this rung requires — the generic version; a specific remedy (from a signal's own `CapabilityDetail`) is more exact where one is available. */
  climb: string
}

/** `_never`-exhaustive by construction (see {@link nextRung}) — a sixth rung fails to compile here before it fails at runtime. */
export function rungInfo(rung: Rung): RungInfo {
  switch (rung) {
    case 'L0':
      return { label: 'L0 — zero-cooperation (git + transcript organ)', climb: 'env vars at launch (`rhizomorph env <lane>`) bring OTLP dollars/traces' }
    case 'L1':
      return { label: 'L1 — env/OTLP', climb: 'a hook beacon declares attention instead of inferring it from transcript shape' }
    case 'L2':
      return { label: 'L2 — beacon (declared attention)', climb: 'a PTY wrapper (`rhizomorph run`) adds a live output stream' }
    case 'L3':
      return { label: 'L3 — PTY wrapper', climb: 'tmux/workmux adds pane previews and one-keystroke ATTACH' }
    case 'L4':
      return { label: 'L4 — tmux/workmux', climb: 'top rung — nothing further to climb' }
    default: {
      const _never: never = rung
      throw new Error(`unreachable rung: ${String(_never)}`)
    }
  }
}

export interface CollectorContextInit {
  repoPath: string
  now: number
  exec: Exec
  nextId: () => string
}

/**
 * Builds the per-tick context. One implementation of `emit` for every
 * collector, so nobody hand-rolls an envelope or skips validation.
 */
export function createCollectorContext(init: CollectorContextInit): CollectorContext {
  return {
    repoPath: init.repoPath,
    now: init.now,
    exec: init.exec,
    nextId: init.nextId,
    emit: (type, payload, options) =>
      createEvent(type, payload, {
        id: init.nextId(),
        // Floored, because a source time computed from a date string can carry
        // a fraction; anything that isn't a real epoch-ms throws in createEvent.
        ts: options?.ts === undefined ? init.now : Math.floor(options.ts),
      }),
  }
}

/**
 * Erased form, for a registry holding collectors with differing snapshot
 * types. `any` rather than `unknown` so an implementation with a concrete
 * snapshot is assignable to it.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyCollector = Collector<any>
