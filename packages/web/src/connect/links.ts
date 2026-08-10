import type { AgentRole, Connection, RefusalState, SourceFlow, UninstrumentedSession } from '@rhizomorph/core'
import type { ConnectionStatus } from '../hooks/useEventStream.js'
import { doctorCheck, type CollectorFacts, type DoctorFact, type MetaFacts } from './meta.js'

/**
 * THE HANDSHAKE CHECKLIST'S ROWS (prd19 ruling 3, wave 3, #258).
 *
 * One row per link in the chain, each rendering **exactly one of three
 * states**: VERIFIED (a fact and its timestamp), BROKEN (a reason and the
 * exact command), UNPROVEN (honestly nothing yet). This module is the whole
 * derivation and nothing else — pure, synchronous, no fetch, no React — so
 * the rulings it encodes are testable as arithmetic over a fold rather than
 * as pixels.
 *
 * **"Connected" means data flowed, never "preconditions passed."** That is
 * ruling 3's own sentence and it decides every branch below: a row goes
 * VERIFIED because {@link SourceFlow} counts folded records, not because a
 * binary is on PATH or an env var is set somewhere. Preconditions appear
 * here only as {@link ChainLink.notes} — context for a row that has not
 * proven itself, never a substitute for the proof.
 *
 * **Where the facts come from, and why the fold is the live one.** The flow
 * facts are `selectConnection` over the SSE fold the whole app already reads,
 * so a row flips to VERIFIED the moment the event that proves it arrives —
 * no refresh, no refetch, which is prd19's own success criterion ("watch a
 * row flip to VERIFIED live"). `/api/meta` and `GET /api/doctor` fill in what
 * the fold cannot know: the rung and the per-collector `reason`/`remedy`
 * (meta), and the filesystem facts — the slug dir, version drift, the lane
 * manifest (doctor). Where meta's own `connection` snapshot and the fold
 * disagree, {@link mergeFlow} takes whichever PROVED MORE: both are witnesses
 * of the same append-only truth, and a page whose job is proof must not lose
 * a proof because one witness was polled a second earlier.
 *
 * The three states are also the hue law's own three (`theme/theme.css`):
 * verified wears the green family, broken wears the one red the instrument
 * has, and unproven wears the ice ramp — **waiting is not an alarm**, so a
 * row that has nothing to say must never borrow amber's "a human is needed"
 * or red's "this is dead".
 */

export type LinkState = 'verified' | 'broken' | 'unproven'

export interface ChainLink {
  id: string
  /** The link itself, as ruling 3 names it: `browser ↔ server`, `repo ↔ git`, … */
  label: string
  /** What this row would prove — shown always, so an UNPROVEN row still says what it is waiting for. */
  question: string
  state: LinkState
  /** VERIFIED only: the fact that proves it. */
  fact: string | null
  /** VERIFIED only: when it was proved, epoch millis, or `null` when the proof carries no timestamp. */
  ts: number | null
  /** BROKEN only: why. */
  reason: string | null
  /** BROKEN only: the exact copy-paste command, port already interpolated. `null` when the honest remedy is prose, not a command. */
  command: string | null
  /** BROKEN only, beside a command: the same-process SCAR warning, verbatim. */
  warning: string | null
  /** Context — preconditions, doctor findings, standing faults. Never load-bearing for {@link state}. */
  notes: string[]
}

/**
 * THE SCAR, VERBATIM (ruling 7, and the `.workmux.yaml` incident of
 * 2026-08-04). A pane-env prefix silently never reached the agent: the env
 * block was exported in one process and `claude` was exec'd by another, so
 * every precondition read as satisfied and nothing ever arrived. Copied word
 * for word beside every env command this page shows, because paraphrasing a
 * scar is how it comes back.
 */
export const SAME_PROCESS_WARNING = 'the env block must be exported in the process that execs the agent'

/**
 * How long a session may show transcript activity with no telemetry before
 * this page is willing to call it BROKEN.
 *
 * `selectConnection`'s own doc hands this decision here by name: it "cannot
 * distinguish 'never instrumented' from 'instrumented, awaiting its first
 * batched export'", and says the elapsed-time judgment is the UI's call
 * (#258). Sixty seconds is a deliberate over-estimate of the longest first
 * batch an instrumented agent can owe us — `rhizomorph env` sets the metrics
 * interval to 5s, logs to 2s and traces to 1s (`cli/telemetry-env.ts`), so a
 * correctly wired lane proves itself an order of magnitude inside this
 * window. Under it, the row reads UNPROVEN, in the ice register: an export
 * that may still be in flight is waiting, and waiting is not an alarm.
 */
export const FIRST_EXPORT_GRACE_MS = 60_000

/** What the page knows about its own SSE connection — the browser↔server link's evidence. */
export interface StreamFacts {
  status: ConnectionStatus
  /** `state.session.eventCount` — every event the fold ever absorbed, eviction included. */
  eventCount: number
  /** `StreamContext`'s provenance string, so a fixture can never pass as live data (ruling 6). */
  provenance: string
  /**
   * True only when the fold driving this page is the LIVE log — `mode ===
   * 'live'` and no fixture key pressed. Both other cases fabricate an open
   * connection (`StreamContext` hands replay and every fixture `status:
   * 'open'` outright), so reading `status` as proof under either of them
   * would be ruling 6's forbidden costume: a fixture passing as live data.
   */
  live: boolean
}

export interface ConnectInputs {
  /** `selectConnection(state.session)` over the live SSE fold. */
  flow: Connection
  /** `state.session.refusals` — the folded `telemetry.refused` slice (ruling 2). */
  refusals: RefusalState
  stream: StreamFacts
  meta: MetaFacts | null
  doctor: DoctorFact[] | null
  /** The port this browser is actually talking to, interpolated into every command. */
  port: string
  /** The page's clock, for {@link FIRST_EXPORT_GRACE_MS}. */
  now: number
}

/** `location.port` is empty on the default port for the scheme — the honest fallback, never a guess. */
export function portFrom(location: { port: string; protocol: string }): string {
  if (location.port !== '') return location.port
  return location.protocol === 'https:' ? '443' : '80'
}

/**
 * The command ruling 7 names, with the live port interpolated and the lane
 * filled in whenever the fold actually knows one. `<lane>` stays a literal
 * placeholder when it does not: a page that guessed a handle would hand the
 * operator a command that generates an env block for a lane that does not
 * exist, which is worse than the placeholder they have to fill in themselves.
 */
export function envCommand(lane: string | null, role: AgentRole | null, port: string): string {
  const roleArg = role === null || role === 'unattributed' ? '' : ` --role ${role}`
  return `rhizomorph env ${lane ?? '<lane>'}${roleArg} --port ${port}`
}

/** How that block has to be applied — the other half of the SCAR: exported, in the agent's own shell, before `claude` starts. */
export function envApplyNote(command: string): string {
  return `apply it in the shell that will exec the agent — \`eval "$(${command})"\` — then start \`claude\` from that same shell`
}

function verified(base: Omit<ChainLink, 'state' | 'fact' | 'ts' | 'reason' | 'command' | 'warning' | 'notes'>, fact: string, ts: number | null, notes: string[] = []): ChainLink {
  return { ...base, state: 'verified', fact, ts, reason: null, command: null, warning: null, notes }
}

function broken(
  base: Omit<ChainLink, 'state' | 'fact' | 'ts' | 'reason' | 'command' | 'warning' | 'notes'>,
  reason: string,
  options: { command?: string; warning?: string; notes?: string[] } = {},
): ChainLink {
  return {
    ...base,
    state: 'broken',
    fact: null,
    ts: null,
    reason,
    command: options.command ?? null,
    warning: options.warning ?? null,
    notes: options.notes ?? [],
  }
}

function unproven(base: Omit<ChainLink, 'state' | 'fact' | 'ts' | 'reason' | 'command' | 'warning' | 'notes'>, notes: string[] = []): ChainLink {
  return { ...base, state: 'unproven', fact: null, ts: null, reason: null, command: null, warning: null, notes }
}

/** `1 record` / `4 records` — the count is evidence of flow and a magnitude, never an event tally (`selectConnection`'s own first limit). */
function records(count: number): string {
  return `${count} folded record${count === 1 ? '' : 's'}`
}

/**
 * Two witnesses of one append-only truth: the live fold, and `/api/meta`'s
 * own `selectConnection` snapshot. Proof is monotone — a record neither
 * witness can un-see — so the merge takes the larger count and the wider
 * window rather than preferring one source. (`selectConnection`'s second
 * limit means git/tmux/workmux flow CAN regress as entity state is
 * overwritten; this merge does not compensate for that and must not be read
 * as doing so — it reconciles two readings of the same instant, not two
 * instants.)
 */
export function mergeFlow(folded: SourceFlow, served: { firstEventTs: number | null; lastEventTs: number | null; count: number } | undefined): SourceFlow {
  if (served === undefined) return folded
  return {
    source: folded.source,
    count: Math.max(folded.count, served.count),
    firstEventTs: minTs(folded.firstEventTs, served.firstEventTs),
    lastEventTs: maxTs(folded.lastEventTs, served.lastEventTs),
  }
}

function minTs(a: number | null, b: number | null): number | null {
  if (a === null) return b
  if (b === null) return a
  return Math.min(a, b)
}

function maxTs(a: number | null, b: number | null): number | null {
  if (a === null) return b
  if (b === null) return a
  return Math.max(a, b)
}

/**
 * A collector whose signals came back `absent` with a reason — prd15 ruling
 * 5's "a disabled collector's signals read `absent` with a reason, never
 * silently `provided`". `identity` is the signal read because every collector
 * in the ladder declares it, and `honestCapabilities` overrides all six at
 * once when the fold says the collector is disabled, so any one of them
 * carries the same reason.
 */
function disabledReason(meta: MetaFacts | null, name: string): { reason: string; remedy: string | null } | null {
  const collector: CollectorFacts | undefined = meta?.collectors.find((entry) => entry.name === name)
  const identity = collector?.signals.find((signal) => signal.signal === 'identity')
  if (identity === undefined || identity.level !== 'absent' || identity.reason === null) return null
  return { reason: identity.reason, remedy: identity.remedy }
}

/** A doctor finding, in its own words, tagged with the check it came from — or nothing at all when the route never answered. */
function doctorNote(doctor: DoctorFact[] | null, id: string): string[] {
  const check = doctorCheck(doctor, id)
  if (check === null) return []
  return [`doctor · ${id}: ${check.message}${check.assumed ? ' (assumed, not measured)' : ''}`]
}

const STREAM_REASON: Record<ConnectionStatus, string> = {
  connecting: 'the event stream has not opened yet',
  open: 'the event stream is open',
  error: 'the event stream errored — nothing is arriving over it',
  closed: 'the event stream is closed — nothing is arriving over it',
}

/**
 * **browser ↔ server.** The one link this page can prove by existing: the SSE
 * connection is open, so this browser reached this server. It is deliberately
 * NOT gated on events having arrived — an open stream over a repo where
 * nothing has happened yet is a working link with nothing to carry, and
 * conflating the two would make the first row lie about which link is
 * actually dead.
 */
function browserServer(input: ConnectInputs): ChainLink {
  const base = {
    id: 'browser-server',
    label: 'browser ↔ server',
    question: 'is this page actually talking to a running Rhizomorph?',
  }
  const notes = [`source: ${input.stream.provenance}`, ...doctorNote(input.doctor, 'node')]

  if (!input.stream.live) {
    // Ruling 6, at this page's most load-bearing row: a fixture and a replay
    // both fabricate `status: 'open'` (`StreamContext`), so reading it as
    // proof would be exactly the lie this page exists to remove.
    return unproven(base, [...notes, 'a recorded session or a synthetic fleet is driving this fold — nothing here proves this browser is talking to a live instrument'])
  }

  if (input.stream.status === 'open') {
    const instance = input.meta?.sessionId ?? null
    const served = instance === null ? '/api/meta has not named an instance' : `/api/meta names instance ${instance}`
    const events = `${input.stream.eventCount} event${input.stream.eventCount === 1 ? '' : 's'} folded`
    return verified(base, `${STREAM_REASON.open} — ${events}, ${served}`, null, notes)
  }

  if (input.stream.status === 'connecting') return unproven(base, notes)

  return broken(base, STREAM_REASON[input.stream.status], {
    command: `npm start -- ${input.meta?.repoPath ?? '<repo>'} --port ${input.port}`,
    notes,
  })
}

/** **repo ↔ git.** Worktrees, branches and commits reaching the fold — the L0 floor every other link is measured against. */
function repoGit(input: ConnectInputs): ChainLink {
  const base = { id: 'repo-git', label: 'repo ↔ git', question: 'is the git collector reaching this repo?' }
  const flow = mergeFlow(input.flow.git, input.meta?.connection?.sources.git)
  const notes = doctorNote(input.doctor, 'lane-manifest')

  if (flow.count > 0) {
    return verified(base, `${records(flow.count)} from git — worktrees, branches, commits`, flow.lastEventTs, notes)
  }
  const disabled = disabledReason(input.meta, 'git')
  if (disabled !== null) {
    return broken(base, disabled.reason, { notes: disabled.remedy === null ? notes : [`remedy: ${disabled.remedy}`, ...notes] })
  }
  return unproven(base, notes)
}

/** **agents ↔ tmux/workmux.** One row for the two machine collectors: either proves the link, and the row names which did. */
function agentsPanes(input: ConnectInputs): ChainLink {
  const base = {
    id: 'agents-tmux',
    label: 'agents ↔ tmux/workmux',
    question: 'is anything reporting live agent panes and handles?',
  }
  const tmux = mergeFlow(input.flow.tmux, input.meta?.connection?.sources.tmux)
  const workmux = mergeFlow(input.flow.workmux, input.meta?.connection?.sources.workmux)
  const notes = [...doctorNote(input.doctor, 'tmux'), ...doctorNote(input.doctor, 'workmux')]

  if (tmux.count > 0 || workmux.count > 0) {
    const proved = [tmux.count > 0 ? `tmux ${records(tmux.count)}` : null, workmux.count > 0 ? `workmux ${records(workmux.count)}` : null]
      .filter((part): part is string => part !== null)
      .join(' · ')
    return verified(base, proved, maxTs(tmux.lastEventTs, workmux.lastEventTs), notes)
  }

  const tmuxDisabled = disabledReason(input.meta, 'tmux')
  const workmuxDisabled = disabledReason(input.meta, 'workmux')
  // BROKEN only when BOTH are disabled with a reason: either one alone still
  // leaves a live mechanism that simply has not reported yet, which is
  // UNPROVEN, not dead.
  if (tmuxDisabled !== null && workmuxDisabled !== null) {
    return broken(base, `tmux: ${tmuxDisabled.reason} · workmux: ${workmuxDisabled.reason}`, { notes })
  }
  return unproven(base, notes)
}

/**
 * **transcripts ↔ slug, the plumbing half.** Does the session-log directory
 * this repo's slug resolves to exist at all — a filesystem fact the fold
 * cannot know, which is why ruling 5 added `GET /api/doctor` for it. Split
 * from the flow row below on purpose (ruling 3, and this issue's direction):
 * a dir that exists and a transcript that arrived are two different claims,
 * and one standing in for the other is how "connected" starts meaning
 * "preconditions passed".
 */
function transcriptSlug(input: ConnectInputs): ChainLink {
  const base = {
    id: 'transcripts-slug',
    label: 'transcripts ↔ slug (dir)',
    question: 'does the session-log directory this repo resolves to exist?',
  }
  const check = doctorCheck(input.doctor, 'session-logs')
  if (check === null) {
    return unproven(base, ['`GET /api/doctor` has not answered — the slug directory is unavailable from here'])
  }
  if (check.status === 'ok') return verified(base, check.message, null, doctorNote(input.doctor, 'session-boundary'))
  return broken(base, check.message, { notes: doctorNote(input.doctor, 'session-boundary') })
}

/** **transcripts ↔ slug, the flow half.** A first `sessionlog`-origin record — the dir resolving proves nothing about anything arriving from it. */
function transcriptFlow(input: ConnectInputs): ChainLink {
  const base = {
    id: 'transcripts-flow',
    label: 'transcripts ↔ slug (flow)',
    question: 'has a single transcript event actually arrived?',
  }
  const flow = mergeFlow(input.flow.sessionlog, input.meta?.connection?.sources.sessionlog)
  if (flow.count > 0) return verified(base, `${records(flow.count)} from the transcript collector`, flow.lastEventTs)

  const disabled = disabledReason(input.meta, 'sessionlog')
  if (disabled !== null) {
    return broken(base, disabled.reason, { notes: disabled.remedy === null ? [] : [`remedy: ${disabled.remedy}`] })
  }
  return unproven(base)
}

/**
 * **dollars/traces ↔ OTel**, and the row prd19 was written for.
 *
 * A folded `telemetry.refused` with nothing otel-origin behind it is BROKEN,
 * never UNPROVEN, and the remedy comes out of the refusal's OWN payload: the
 * instance the export declared, and the instance it should have carried.
 * That is ruling 3's sentence and this issue's first stated law — and it is
 * the one case where "nothing arrived" is provably not "nothing has happened
 * yet": something arrived, was identified as someone else's, and was thrown
 * away.
 *
 * A refusal is never counted as flow (`selectConnection`'s load-bearing
 * exclusion), so a fleet that is refused AND flowing — two agents, one wired
 * to this instance and one to a stale one — reads VERIFIED with the standing
 * fault carried as a note rather than either fact erasing the other.
 */
function otelLink(input: ConnectInputs): ChainLink {
  const base = {
    id: 'otel',
    label: 'dollars/traces ↔ OTel',
    question: 'is any agent exporting telemetry to this instance?',
  }
  const flow = mergeFlow(input.flow.otel, input.meta?.connection?.sources.otel)
  const folded = input.refusals.records
  const latest = folded[folded.length - 1]
  const served = input.meta?.connection?.refusals ?? null
  // Whichever witness holds more refusals holds the fault; the fold is
  // preferred at equal counts because it is the live one.
  const refusedCount = Math.max(folded.length, served?.count ?? 0)
  const declared = latest?.instance ?? served?.instance ?? null
  const expected = latest?.expectedInstance ?? served?.expectedInstance ?? null

  if (flow.count > 0) {
    const notes = refusedCount > 0 ? [`${refusedCount} export${refusedCount === 1 ? '' : 's'} were still refused — another exporter is pointed at the wrong instance`] : []
    return verified(base, `${records(flow.count)} from OTel — usage, dollars, spans`, flow.lastEventTs, notes)
  }

  if (refusedCount > 0) {
    const who = declared === null ? 'declared no instance at all' : `declared instance ${declared}`
    const command = envCommand(null, null, input.port)
    return broken(
      base,
      `${refusedCount} telemetry export${refusedCount === 1 ? '' : 's'} refused: this Rhizomorph is instance ${expected ?? 'unavailable'}, and the export ${who} — one repo, one Rhizomorph, so nothing from it was recorded`,
      { command, warning: SAME_PROCESS_WARNING, notes: [envApplyNote(command), ...doctorNote(input.doctor, 'telemetry')] },
    )
  }

  return unproven(base, [...doctorNote(input.doctor, 'telemetry'), ...doctorNote(input.doctor, 'cli-version-drift')])
}

/** The lane whose env block would fix this session, and the role to generate it for. */
function relaunchTarget(session: UninstrumentedSession): { lane: string | null; role: AgentRole | null } {
  return {
    lane: session.lanes[0] ?? null,
    role: session.roles.includes('conductor') ? 'conductor' : (session.roles[0] ?? null),
  }
}

/**
 * **THE UNINSTRUMENTED CONDUCTOR** — the PRD's own evidence case (operator
 * report, Gabe, 2026-08-07: rhizomorph ran fine and the Claude instance
 * driving it was never instrumented, and nothing on any surface said so). A
 * first-class BROKEN row with the relaunch command beside it, exactly as
 * ruling 3 requires, rather than an inference a reader has to make by
 * noticing that two other rows disagree.
 *
 * The grace window ({@link FIRST_EXPORT_GRACE_MS}) is the one judgment
 * `selectConnection` explicitly left to this layer: a session whose
 * transcript activity started moments ago may be an instrumented agent whose
 * first batch is still in flight, and calling that dead would be an alarm
 * about waiting.
 */
function uninstrumentedConductor(input: ConnectInputs): ChainLink {
  const base = {
    id: 'uninstrumented-conductor',
    label: 'the uninstrumented conductor',
    question: 'is every agent with transcript activity also exporting telemetry?',
  }
  const folded = input.flow.uninstrumentedSessions
  const ripe = folded.filter((session) => input.now - session.firstEventTs >= FIRST_EXPORT_GRACE_MS)

  if (ripe.length > 0) {
    const worst = ripe.find((session) => session.roles.includes('conductor')) ?? ripe[0]!
    const { lane, role } = relaunchTarget(worst)
    const command = envCommand(lane, role, input.port)
    const where = lane === null ? '' : role === null ? ` (lane ${lane})` : ` (lane ${lane}, ${role})`
    const named = `session ${worst.sessionId}${where}`
    const others = ripe.length === 1 ? '' : ` — and ${ripe.length - 1} more session${ripe.length === 2 ? '' : 's'} like it`
    return broken(
      base,
      `${named} has transcript activity and has exported no telemetry at all${others}: this agent was launched without the env block, so its dollars and traces do not exist`,
      { command, warning: SAME_PROCESS_WARNING, notes: [envApplyNote(command), 'the agent has to be relaunched — an env block exported after `claude` started never reaches it'] },
    )
  }

  if (folded.length > 0) {
    return unproven(base, [
      `${folded.length} session${folded.length === 1 ? '' : 's'} with transcript activity and no telemetry yet — inside the ${Math.round(FIRST_EXPORT_GRACE_MS / 1000)}s window an instrumented agent's first export is allowed to take`,
    ])
  }

  const sessionlog = mergeFlow(input.flow.sessionlog, input.meta?.connection?.sources.sessionlog)
  if (sessionlog.count > 0) {
    return verified(base, 'every session with transcript activity has also exported telemetry', input.flow.otel.lastEventTs)
  }
  return unproven(base, ['no transcript activity has arrived yet, so there is no session to check'])
}

/**
 * The chain, in the order ruling 3 lists it: browser↔server · repo↔git ·
 * agents↔tmux/workmux · transcripts↔slug (plumbing, then flow) ·
 * dollars/traces↔OTel — and last, the named case the whole PRD is evidence
 * for.
 */
export function buildLinks(input: ConnectInputs): ChainLink[] {
  return [
    browserServer(input),
    repoGit(input),
    agentsPanes(input),
    transcriptSlug(input),
    transcriptFlow(input),
    otelLink(input),
    uninstrumentedConductor(input),
  ]
}

/** How many rows are in each state — the page's one-line summary, and never a score. */
export function tally(links: readonly ChainLink[]): Record<LinkState, number> {
  const counts: Record<LinkState, number> = { verified: 0, broken: 0, unproven: 0 }
  for (const link of links) counts[link.state] += 1
  return counts
}
