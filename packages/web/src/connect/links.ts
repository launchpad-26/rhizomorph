import { AGENT_ROLES, type AgentRole, type Connection, type RefusalState, type SourceFlow, type UninstrumentedSession } from '@rhizomorph/core'
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
  /**
   * VERIFIED only, and **never null on a VERIFIED row** — ruling 3's own
   * sentence is "a fact AND its timestamp", and a stale VERIFIED with nothing
   * to date it is exactly the failure this page exists to remove.
   */
  ts: number | null
  /**
   * What {@link ts} dates. `'event'` is the proving record's own timestamp;
   * `'render'` is this render, and is the honest answer where the proof IS
   * the present moment — an open stream, a fresh doctor probe — rather than a
   * stored fact. Never a fabricated event time for a live proof.
   */
  tsKind: 'event' | 'render' | null
  /** BROKEN only: why. */
  reason: string | null
  /** BROKEN only, and **never null on a BROKEN row**: the exact copy-paste command, port already interpolated. */
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

/**
 * Relaunching the instrument itself, against this repo and this port — the
 * command behind every row whose fault was decided at boot.
 *
 * A collector is enabled or disabled when the server starts (and retired
 * mid-run by its own error policy); nothing this page or its operator can do
 * from a browser re-enables one. So once the cause the row NAMES is fixed —
 * the missing binary installed, the path pointed at a real worktree — this is
 * the exact command that re-runs that decision. It is a real remedy rather
 * than an invented one precisely because the row always carries the
 * collector's own reason beside it: the reason says what to fix, this says
 * how to make the instrument look again.
 */
export function restartCommand(repoPath: string | null, port: string, extra: readonly string[] = []): string {
  return ['npm start --', repoPath ?? '<repo>', '--port', port, ...extra].join(' ')
}

type LinkBase = Omit<ChainLink, 'state' | 'fact' | 'ts' | 'tsKind' | 'reason' | 'command' | 'warning' | 'notes'>

/** When a row was proved, and by what kind of proof — see {@link ChainLink.tsKind}. */
export interface Proof {
  ts: number
  tsKind: 'event' | 'render'
}

/**
 * A proving record's own timestamp when it has one, and otherwise this
 * render, labelled as such. Some proofs genuinely carry no event time — a
 * folded record whose every stamp was null, a doctor probe, an open socket —
 * and ruling 3 still wants them dated. "As of now" is the true statement in
 * those cases; inventing an event timestamp would not be.
 */
function provenAt(eventTs: number | null, now: number): Proof {
  return eventTs === null ? { ts: now, tsKind: 'render' } : { ts: eventTs, tsKind: 'event' }
}

/** Dated by this render alone: the proof is the present moment, not a stored fact. */
function provenNow(now: number): Proof {
  return { ts: now, tsKind: 'render' }
}

function verified(base: LinkBase, fact: string, proof: Proof, notes: string[] = []): ChainLink {
  return { ...base, state: 'verified', fact, ts: proof.ts, tsKind: proof.tsKind, reason: null, command: null, warning: null, notes }
}

/**
 * `command` is REQUIRED, not optional — ruling 3's "a reason and the exact
 * command" restated as a type rather than as a convention a future row could
 * skip. A row that cannot name a command is not a BROKEN row this module
 * knows how to build, and that is the conversation a diff should have.
 */
function broken(
  base: LinkBase,
  reason: string,
  options: { command: string; warning?: string; notes?: string[] },
): ChainLink {
  return {
    ...base,
    state: 'broken',
    fact: null,
    ts: null,
    tsKind: null,
    reason,
    command: options.command,
    warning: options.warning ?? null,
    notes: options.notes ?? [],
  }
}

function unproven(base: LinkBase, notes: string[] = []): ChainLink {
  return { ...base, state: 'unproven', fact: null, ts: null, tsKind: null, reason: null, command: null, warning: null, notes }
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
    // The proof here is the socket being open *now*, not any event on it —
    // so the honest date is this render, never the last event's timestamp.
    return verified(base, `${STREAM_REASON.open} — ${events}, ${served}`, provenNow(input.now), notes)
  }

  if (input.stream.status === 'connecting') return unproven(base, notes)

  return broken(base, STREAM_REASON[input.stream.status], {
    command: restartCommand(input.meta?.repoPath ?? null, input.port),
    notes,
  })
}

/** **repo ↔ git.** Worktrees, branches and commits reaching the fold — the L0 floor every other link is measured against. */
function repoGit(input: ConnectInputs): ChainLink {
  const base = { id: 'repo-git', label: 'repo ↔ git', question: 'is the git collector reaching this repo?' }
  const flow = mergeFlow(input.flow.git, input.meta?.connection?.sources.git)
  const notes = doctorNote(input.doctor, 'lane-manifest')

  if (flow.count > 0) {
    return verified(base, `${records(flow.count)} from git — worktrees, branches, commits`, provenAt(flow.lastEventTs, input.now), notes)
  }
  const disabled = disabledReason(input.meta, 'git')
  if (disabled !== null) {
    return broken(base, disabled.reason, {
      command: restartCommand(input.meta?.repoPath ?? null, input.port),
      notes: disabled.remedy === null ? notes : [`remedy: ${disabled.remedy}`, ...notes],
    })
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
    return verified(base, proved, provenAt(maxTs(tmux.lastEventTs, workmux.lastEventTs), input.now), notes)
  }

  const tmuxDisabled = disabledReason(input.meta, 'tmux')
  const workmuxDisabled = disabledReason(input.meta, 'workmux')
  // BROKEN only when BOTH are disabled with a reason: either one alone still
  // leaves a live mechanism that simply has not reported yet, which is
  // UNPROVEN, not dead.
  if (tmuxDisabled !== null && workmuxDisabled !== null) {
    return broken(base, `tmux: ${tmuxDisabled.reason} · workmux: ${workmuxDisabled.reason}`, {
      // Each reason names its own tool; installing it is that tool's own
      // business and has no portable command. What this page can name
      // exactly is the one thing that makes the instrument look again once
      // it is there.
      command: restartCommand(input.meta?.repoPath ?? null, input.port),
      notes,
    })
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
  // A probe, not a stored fact: doctor answered about the filesystem as it is
  // now (the route re-probes every `PROBE_CACHE_TTL_MS`), so "as of this
  // render" is the only date this row can honestly carry.
  if (check.status === 'ok') return verified(base, check.message, provenNow(input.now), doctorNote(input.doctor, 'session-boundary'))

  // Doctor's own message carries both halves of the remedy — run `claude`
  // here once, or point elsewhere with `--extra-sessions`. The second is the
  // one that is a command, and the conductor-on-a-foreign-filesystem case
  // (`args.ts`: a mounted `/mnt/c/…/.claude/projects/<slug>`) is exactly the
  // one this row goes BROKEN for.
  return broken(base, check.message, {
    command: restartCommand(input.meta?.repoPath ?? null, input.port, ['--extra-sessions <session-log-dir>']),
    notes: doctorNote(input.doctor, 'session-boundary'),
  })
}

/** **transcripts ↔ slug, the flow half.** A first `sessionlog`-origin record — the dir resolving proves nothing about anything arriving from it. */
function transcriptFlow(input: ConnectInputs): ChainLink {
  const base = {
    id: 'transcripts-flow',
    label: 'transcripts ↔ slug (flow)',
    question: 'has a single transcript event actually arrived?',
  }
  const flow = mergeFlow(input.flow.sessionlog, input.meta?.connection?.sources.sessionlog)
  if (flow.count > 0) {
    return verified(base, `${records(flow.count)} from the transcript collector`, provenAt(flow.lastEventTs, input.now))
  }

  const disabled = disabledReason(input.meta, 'sessionlog')
  if (disabled !== null) {
    return broken(base, disabled.reason, {
      command: restartCommand(input.meta?.repoPath ?? null, input.port),
      notes: disabled.remedy === null ? [] : [`remedy: ${disabled.remedy}`],
    })
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
 * **A REFUSAL OUTRANKS FLOW, and that is the ruling, not a preference.** A
 * refusal is never counted as flow (`selectConnection`'s load-bearing
 * exclusion), and the fleet where both are true — two agents, one wired to
 * this instance and one to a stale one — used to read VERIFIED here with the
 * standing fault demoted to a note. That put "0 broken" on the tally for
 * exactly the fleet prd19 was written about: the operator reads the money
 * layer as healthy while one lane's dollars do not exist. The PRD's binding
 * sentence — a folded `telemetry.refused` renders this row BROKEN — wins
 * whether or not somebody else is exporting fine, and the flow that IS
 * arriving is carried as a note so neither fact erases the other. (Ruled on
 * PR #334's review; prd-19 stands as written.)
 */
function otelLink(input: ConnectInputs): ChainLink {
  const base = {
    id: 'otel',
    label: 'dollars/traces ↔ OTel',
    question: 'is any agent exporting telemetry to this instance?',
  }
  const flow = mergeFlow(input.flow.otel, input.meta?.connection?.sources.otel)
  const refusal = latestRefusal(input)

  if (refusal !== null) {
    const who = refusal.declared === null ? 'declared no instance at all' : `declared instance ${refusal.declared}`
    const plural = refusal.count === 1 ? '' : 's'
    const command = envCommand(null, null, input.port)
    const flowing =
      flow.count > 0
        ? [`${records(flow.count)} DID arrive from OTel — some agent is wired correctly; the refused one is not, and its dollars and traces do not exist`]
        : []
    return broken(
      base,
      `${refusal.count} telemetry export${plural} refused: this Rhizomorph is instance ${refusal.expected ?? 'unavailable'}, and the export ${who} — one repo, one Rhizomorph, so nothing from it was recorded`,
      { command, warning: SAME_PROCESS_WARNING, notes: [...flowing, envApplyNote(command), ...doctorNote(input.doctor, 'telemetry')] },
    )
  }

  if (flow.count > 0) {
    return verified(base, `${records(flow.count)} from OTel — usage, dollars, spans`, provenAt(flow.lastEventTs, input.now))
  }

  return unproven(base, [...doctorNote(input.doctor, 'telemetry'), ...doctorNote(input.doctor, 'cli-version-drift')])
}

/**
 * The standing fault, read from **one** witness — never half from each.
 *
 * The fold and `/api/meta`'s summary both report the most recent refusal, and
 * whichever holds more of them holds the fault (the fold wins a tie: it is
 * the live one). What this must not do is take the count from one and the
 * instance names from the other: a folded refusal that declared NO instance
 * would then be described using meta's offender's id, and ruling 3 says the
 * remedy comes "from its own payload". So the witness is chosen once, and
 * every field below comes from it. (Reviewer's finding on PR #334: the `??`
 * chain this replaces fell through on a legitimately-null `instance`.)
 */
function latestRefusal(input: ConnectInputs): { count: number; declared: string | null; expected: string | null } | null {
  const folded = input.refusals.records
  const latest = folded[folded.length - 1]
  const served = input.meta?.connection?.refusals ?? null
  const servedCount = served?.count ?? 0

  if (latest !== undefined && folded.length >= servedCount) {
    return { count: folded.length, declared: latest.instance, expected: latest.expectedInstance }
  }
  if (served !== null && servedCount > 0) {
    return { count: servedCount, declared: served.instance, expected: served.expectedInstance }
  }
  return null
}

/**
 * One witness's account of a session with transcript activity and no
 * telemetry — the fold's own `UninstrumentedSession`, or the same fact as
 * `/api/meta` served it, in one shape so the row cannot treat them
 * differently.
 */
export interface UninstrumentedWitness {
  sessionId: string
  lanes: string[]
  roles: AgentRole[]
  /**
   * `null` only when the witness carried no usable first sighting — a
   * session that can be named but never aged. See {@link mergeUninstrumented}
   * for why that case is not granted the grace window.
   */
  firstEventTs: number | null
}

/** A served role string is only a role if it is one of the four the schema has — anything else is dropped rather than passed to `--role`. */
function knownRoles(roles: readonly string[]): AgentRole[] {
  return roles.filter((role): role is AgentRole => (AGENT_ROLES as readonly string[]).includes(role))
}

/**
 * TWO WITNESSES TO THE SAME ABSENCE, unioned by session id.
 *
 * `/api/meta` runs the same `selectConnection` over the same log this page's
 * SSE fold does, so its `uninstrumentedSessions` is a second reading of one
 * truth — and for the first seconds of every page load, and for as long as an
 * SSE error keeps the fold empty, it is the ONLY reading. Consuming only the
 * fold meant the row could read VERIFIED ("every session with transcript
 * activity has also exported telemetry") off a merged sessionlog count that
 * came from meta while ignoring the uninstrumented list meta served in the
 * same body — the row contradicting its own source. Reviewer's finding on
 * PR #334; ruled to merge rather than to gate the VERIFIED path down to the
 * fold's own count, since that would go quiet exactly when SSE lags.
 *
 * The fold wins on a session both witnesses name: it is the live one, and its
 * `roles`/`lanes` are typed rather than parsed. A session only meta named is
 * appended whole.
 */
export function mergeUninstrumented(
  folded: readonly UninstrumentedSession[],
  served: readonly { sessionId: string; lanes: string[]; roles: string[]; firstEventTs: number | null }[] | undefined,
): UninstrumentedWitness[] {
  const witnesses: UninstrumentedWitness[] = folded.map((session) => ({
    sessionId: session.sessionId,
    lanes: [...session.lanes],
    roles: [...session.roles],
    firstEventTs: session.firstEventTs,
  }))
  const seen = new Set(witnesses.map((witness) => witness.sessionId))

  for (const session of served ?? []) {
    if (seen.has(session.sessionId)) continue
    seen.add(session.sessionId)
    witnesses.push({
      sessionId: session.sessionId,
      lanes: [...session.lanes],
      roles: knownRoles(session.roles),
      firstEventTs: session.firstEventTs,
    })
  }
  return witnesses
}

/**
 * Ripe for BROKEN: the grace window has passed, **or the witness carried no
 * date to measure it against**. The window is an exemption granted to a
 * session that might still be exporting its first batch, and an exemption
 * this page cannot measure is one it must not grant — the alternative is a
 * malformed timestamp buying a permanently silent row on the one page whose
 * subject is what has been proven.
 */
function pastGrace(witness: UninstrumentedWitness, now: number): boolean {
  return witness.firstEventTs === null || now - witness.firstEventTs >= FIRST_EXPORT_GRACE_MS
}

/** The lane whose env block would fix this session, and the role to generate it for. */
function relaunchTarget(session: UninstrumentedWitness): { lane: string | null; role: AgentRole | null } {
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
 *
 * Both witnesses count ({@link mergeUninstrumented}): a session `/api/meta`
 * named is the same broken link as one the fold named, and reading only the
 * fold let this row claim the opposite of what meta had just served.
 */
function uninstrumentedConductor(input: ConnectInputs): ChainLink {
  const base = {
    id: 'uninstrumented-conductor',
    label: 'the uninstrumented conductor',
    question: 'is every agent with transcript activity also exporting telemetry?',
  }
  const witnesses = mergeUninstrumented(input.flow.uninstrumentedSessions, input.meta?.connection?.uninstrumentedSessions)
  const ripe = witnesses.filter((witness) => pastGrace(witness, input.now))

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

  if (witnesses.length > 0) {
    return unproven(base, [
      `${witnesses.length} session${witnesses.length === 1 ? '' : 's'} with transcript activity and no telemetry yet — inside the ${Math.round(FIRST_EXPORT_GRACE_MS / 1000)}s window an instrumented agent's first export is allowed to take`,
    ])
  }

  const sessionlog = mergeFlow(input.flow.sessionlog, input.meta?.connection?.sources.sessionlog)
  if (sessionlog.count > 0) {
    const otel = mergeFlow(input.flow.otel, input.meta?.connection?.sources.otel)
    return verified(base, 'every session with transcript activity has also exported telemetry', provenAt(otel.lastEventTs, input.now))
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
